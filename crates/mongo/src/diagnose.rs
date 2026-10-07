//! Failure diagnosis (T3): turns driver errors and ssh/own error text into a [`Diagnosis`] of codes and parameters (the UI
//! renders the prose from `mongoDiag`). Rules are deterministic and ordered: an explicit own code first, relay refusals,
//! then the error kind, then substring families; the first match wins. Classification says "likely", never "certainly".
//! Pure: no I/O, no network. `detail` is scrubbed English raw text (no URI credentials, user names, key or file paths).

use crate::api::{Diagnosis, ErrorClass, StepId, StepState, TestStep};
use crate::connspec::TlsMode;

/// What the classifier may mention and what it needs to choose between causes.
#[derive(Debug, Clone, Default)]
pub struct Ctx {
    pub hosts: Vec<String>,
    pub is_atlas: bool,
    pub srv: bool,
    pub tls_mode: TlsMode,
    pub has_ca: bool,
    pub has_client_cert: bool,
    /// `none`, `ssh` or `socks5`.
    pub tunnel: &'static str,
    pub relaxed: bool,
    /// Destinations the tunnel relay refused (yield `tunnel.notAllowed`).
    pub refused_hosts: Vec<String>,
    /// Strings that must not appear in `detail` (user names, key or file paths the caller knows about). Entries shorter
    /// than 3 characters are ignored: they would garble the text.
    pub scrub: Vec<String>,
}

/// The error kind of the source, when known (kind first, text second).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hint {
    None,
    Dns,
    InvalidTls,
    Auth,
    /// A server command error with its numeric code.
    Command(i32),
    Selection,
    Io(std::io::ErrorKind),
    /// The SOCKS5 proxy layer of the driver.
    Proxy,
}

/// Every code of Appendix B2 plus `other`.
pub const ALL_CODES: &[&str] = &[
    "config.invalid", "config.fileMissing", "config.pemInvalid", "config.unsupportedOption", "config.needsSecret",
    "config.plainRemote", "config.tlsRelaxRefused",
    "tunnel.noSsh", "tunnel.auth", "tunnel.hostKeyUnknown", "tunnel.hostKeyChanged", "tunnel.hostKeyUnscannable",
    "tunnel.dns", "tunnel.network", "tunnel.forwardingDisabled", "tunnel.targetRefused", "tunnel.notAllowed",
    "tunnel.keyFile", "tunnel.keyPerms", "tunnel.passphrase", "tunnel.interactive", "tunnel.ipv6", "tunnel.dropped",
    "dns.notFound", "dns.srv", "dns.txt",
    "net.refused", "net.timeout", "net.unreachable", "net.reset",
    "tls.unknownIssuer", "tls.hostname", "tls.expired", "tls.clientCertRequired", "tls.serverNotTls",
    "tls.serverRequiresTls", "tls.pem",
    "auth.failed", "auth.mechanism", "auth.source", "auth.x509Subject",
    "authz.listDatabases", "authz.collection", "authz.command",
    "select.noServer", "select.replicaSetName", "select.direct", "select.memberUnreachable",
    "timeout.total",
    "other",
];

pub fn class_of(code: &str) -> ErrorClass {
    match code.split('.').next().unwrap_or("") {
        "config" => ErrorClass::Config,
        "tunnel" => ErrorClass::Tunnel,
        "dns" => ErrorClass::Dns,
        "net" => ErrorClass::Network,
        "tls" => ErrorClass::Tls,
        "auth" => ErrorClass::Auth,
        "authz" => ErrorClass::Authz,
        "select" => ErrorClass::Selection,
        "timeout" => ErrorClass::Timeout,
        _ => ErrorClass::Other,
    }
}

/// Network, Timeout, Selection and Dns failures and a dropped tunnel are worth a retry.
pub fn retryable(code: &str) -> bool {
    matches!(class_of(code), ErrorClass::Network | ErrorClass::Timeout | ErrorClass::Selection | ErrorClass::Dns) || code == "tunnel.dropped"
}

/// Build a diagnosis for a code the pipeline itself raised (config checks, tunnel states). `detail` is scrubbed.
pub fn from_code(code: &str, params: Vec<(String, String)>, detail: &str, ctx: &Ctx) -> Diagnosis {
    let code = if ALL_CODES.contains(&code) { code } else { "other" };
    Diagnosis { class: class_of(code), code: code.into(), params, detail: scrub_detail(detail, ctx), retryable: retryable(code) }
}

pub fn classify_text(text: &str, ctx: &Ctx) -> Diagnosis {
    classify_hint(Hint::None, text, ctx)
}

#[cfg(feature = "mongo")]
pub fn classify(err: &mongodb::error::Error, ctx: &Ctx) -> Diagnosis {
    use mongodb::error::ErrorKind as K;
    let hint = match &*err.kind {
        K::DnsResolve { .. } => Hint::Dns,
        K::InvalidTlsConfig { .. } => Hint::InvalidTls,
        K::Authentication { .. } => Hint::Auth,
        K::Command(c) => Hint::Command(c.code),
        K::ServerSelection { .. } => Hint::Selection,
        K::Io(e) => Hint::Io(e.kind()),
        K::ProxyConnect { .. } => Hint::Proxy,
        _ => Hint::None,
    };
    classify_hint(hint, &err.to_string(), ctx)
}

pub fn classify_hint(hint: Hint, text: &str, ctx: &Ctx) -> Diagnosis {
    let (code, mut params) = decide(hint, text, ctx);
    atlas_hints(code, ctx, &mut params);
    Diagnosis { class: class_of(code), code: code.into(), params, detail: scrub_detail(text, ctx), retryable: retryable(code) }
}

type Decision = (&'static str, Vec<(String, String)>);

fn p(k: &str, v: &str) -> (String, String) {
    (k.to_string(), v.to_string())
}

fn first_host(ctx: &Ctx) -> Vec<(String, String)> {
    ctx.hosts.first().map(|h| vec![p("host", h)]).unwrap_or_default()
}

/// Whether TLS is effectively on: explicit, or the driver default for SRV and Atlas hosts.
fn tls_effective(ctx: &Ctx) -> bool {
    match ctx.tls_mode {
        TlsMode::On => true,
        TlsMode::Off => false,
        TlsMode::Auto => ctx.srv || ctx.is_atlas,
    }
}

fn any(m: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| m.contains(n))
}

/// How a closed-by-peer socket reads on each platform (macOS 54, Linux 104 and 32, Windows 10053/10054/10058) and in the
/// driver's own wording. Which of them a TLS server produces for a client without the certificate it demands depends on the
/// TLS stack and the timing (a macOS mongod reset it, an OpenSSL build alerts first and resets or breaks the pipe when the
/// client's first request arrives after it closed), so they are one family.
const RESET_TEXTS: &[&str] = &[
    "connection reset", "reset by peer", "broken pipe", "connection aborted", "forcibly closed", "os error 54", "os error 104", "os error 32", "os error 10054", "os error 10053", "os error 10058",
];

/// What an OpenSSL (or BoringSSL / LibreSSL) server's alert for a missing client certificate looks like in the text of a
/// rustls client, or of a client built on OpenSSL: TLS 1.3 sends alert 116, TLS 1.2 sends handshake_failure or bad_certificate.
const CLIENT_CERT_ALERTS: &[&str] = &[
    "certificaterequired", "certificate required", "certificate_required", "alert certificate required", "tlsv13 alert certificate", "peer did not return a certificate", "peer sent no certificates", "no client certificate",
    "badcertificate", "bad certificate", "alert bad certificate", "handshake failure", "handshakefailure", "alert handshake failure",
];

fn decide(hint: Hint, text: &str, ctx: &Ctx) -> Decision {
    let m = text.to_ascii_lowercase();
    let no = |c: &'static str| -> Decision { (c, Vec::new()) };

    // 0. An explicit own code ("config.fileMissing: ...") from the pipeline or the tunnel layer.
    if let Some(code) = ALL_CODES.iter().find(|c| text.starts_with(**c) && text[c.len()..].chars().next().map_or(true, |ch| !ch.is_ascii_alphanumeric() && ch != '.')) {
        return (code, Vec::new());
    }

    // 1. The relay refused a destination: that is the cause, whatever the driver says about it.
    if !ctx.refused_hosts.is_empty() && !matches!(hint, Hint::Auth | Hint::Command(_) | Hint::InvalidTls | Hint::Dns) {
        return ("tunnel.notAllowed", ctx.refused_hosts.iter().map(|h| p("host", h)).collect());
    }

    // 2. The whole attempt ran out of budget.
    if any(&m, &["total budget", "overall budget", "overall timeout", "test budget exceeded"]) {
        return no("timeout.total");
    }

    // 3. The ssh layer (stderr of the master or of a `-W` stream).
    if matches!(hint, Hint::None | Hint::Io(_) | Hint::Proxy | Hint::Selection) {
        if let Some(d) = ssh_rules(&m, ctx) {
            return d;
        }
    }

    // 4. The error kind.
    match hint {
        Hint::Dns => {
            let code = if m.contains("txt") {
                "dns.txt"
            } else if m.contains("srv") || ctx.srv && !any(&m, &["no such host", "nodename"]) {
                "dns.srv"
            } else {
                "dns.notFound"
            };
            return (code, first_host(ctx));
        }
        Hint::InvalidTls => {
            if any(&m, &["no such file", "not found", "os error 2", "cannot find"]) {
                return no("config.fileMissing");
            }
            return no("tls.pem");
        }
        Hint::Auth => return (auth_code(&m), Vec::new()),
        Hint::Command(code) => match code {
            18 | 11 | 8000 => return (auth_code(&m), Vec::new()),
            334 => return no("auth.mechanism"),
            13 => return (authz_code(&m), Vec::new()),
            _ => {}
        },
        Hint::Io(k) => {
            use std::io::ErrorKind as E;
            match k {
                E::ConnectionRefused => return (net_refused(), first_host(ctx)),
                E::TimedOut => return ("net.timeout", first_host(ctx)),
                E::NetworkUnreachable | E::HostUnreachable => return ("net.unreachable", first_host(ctx)),
                _ => {}
            }
        }
        Hint::Proxy => {
            if any(&m, &["auth", "credentials", "username", "password"]) {
                return no("tunnel.auth");
            }
            if any(&m, &["refused", "unreachable", "timed out", "timeout", "failed to connect"]) && !any(&m, &["host unreachable", "not allowed", "ruleset"]) {
                return no("tunnel.network");
            }
            return no("tunnel.targetRefused");
        }
        Hint::Selection | Hint::None => {}
    }

    // 5. Atlas drops handshakes from addresses outside the access list: the usual look is an alert, EOF or reset.
    let eofish = any(&m, &["unexpected eof", "early eof", "unexpected end of file", "connection closed", "closed connection", "handshake failure", "handshakefailure", "internalerror", "received fatal alert"]) || any(&m, RESET_TEXTS);
    if ctx.is_atlas && eofish && !any(&m, &["certificaterequired", "notvalidforname", "unknownissuer", "expired"]) {
        return no("net.reset");
    }

    // 6. Authentication and authorisation text, when the kind was not known.
    if any(&m, &["authentication failed", "auth failed", "bad auth", "(18)", "code 18", "code: 18", "scram failure"]) {
        return (auth_code(&m), Vec::new());
    }
    if any(&m, &["not authorized", "unauthorized", "(13)", "code 13", "code: 13"]) {
        return (authz_code(&m), Vec::new());
    }

    // 7. Replica-set topology problems that show up inside a server selection text.
    if let Some(unreachable) = unreachable_members(text, ctx) {
        return ("select.memberUnreachable", unreachable.into_iter().map(|h| p("host", &h)).collect());
    }
    if m.contains("set name") && any(&m, &["match", "expected", "differs", "mismatch"]) {
        return no("select.replicaSetName");
    }

    // 8. TLS and transport families (per-server cause text).
    if any(&m, &["unknownissuer", "unknown issuer", "unable to get local issuer", "self-signed", "self signed", "unknown ca", "unknownca"]) {
        return ("tls.unknownIssuer", first_host(ctx));
    }
    if any(&m, &["notvalidforname", "not valid for name", "hostname mismatch", "subject alternative"]) {
        return ("tls.hostname", first_host(ctx));
    }
    if any(&m, &["certificate expired", "certexpired", "notvalidyet", "not yet valid"]) || (m.contains("expired") && m.contains("cert")) {
        return no("tls.expired");
    }
    if any(&m, CLIENT_CERT_ALERTS) {
        // A handshake failure without a client certificate usually means the server wanted one.
        if ctx.has_client_cert && any(&m, &["handshake failure", "handshakefailure"]) {
            return ("tls.unknownIssuer", first_host(ctx));
        }
        return no("tls.clientCertRequired");
    }
    if any(&m, &["invalidmessage", "invalid message", "corrupt message", "received corrupt", "invalidcontenttype", "invalid content type", "does not look like a tls", "not a tls"]) {
        return no(if tls_effective(ctx) { "tls.serverNotTls" } else { "tls.serverRequiresTls" });
    }
    // A TLS-only server answers a plain client by closing the socket: the driver reports "unexpected end of file" (std wording,
    // seen against a real mongod 8.0 with requireTLS), rustls "tls handshake eof".
    // (Behind a tunnel a closed stream says nothing about TLS: the stream between the app and the relay ended.)
    let direct = !matches!(ctx.tunnel, "ssh" | "socks5");
    if direct && tls_effective(ctx) && ctx.tls_mode == TlsMode::On && !ctx.has_client_cert && !ctx.is_atlas && any(&m, RESET_TEXTS) {
        // TLS 1.3: the handshake looks finished to the client and the server then drops it for want of a client certificate
        // (seen against a real mongod 8.0 on macOS with requireTLS and a CA that demands one: "Connection reset by peer (os
        // error 54)"). Explicit TLS, no certificate configured, not Atlas, no tunnel: the likeliest cause.
        return no("tls.clientCertRequired");
    }
    if direct && tls_effective(ctx) && ctx.tls_mode == TlsMode::On && !ctx.has_client_cert && !ctx.is_atlas && m.contains("close_notify") {
        // Same situation as the reset above, other wording (it depends on timing): rustls only reports a missing close_notify once
        // the handshake went through, which a server that does not speak TLS never allows ("tls handshake eof" is its look).
        return no("tls.clientCertRequired");
    }
    if any(&m, &["unexpected eof", "early eof", "connection closed", "closed connection", "peer closed"]) || (direct && any(&m, &["unexpected end of file", "handshake eof"])) {
        return no(if tls_effective(ctx) { "tls.serverNotTls" } else { "tls.serverRequiresTls" });
    }
    if any(&m, &["pem", "private key", "pkcs"]) && any(&m, &["invalid", "failed", "cannot", "could not", "no "]) {
        return no("tls.pem");
    }
    if any(&m, &["connection refused", "os error 61", "os error 111", "connectionrefused"]) {
        return (net_refused(), first_host(ctx));
    }
    if any(&m, &["network is unreachable", "no route to host", "host is unreachable", "os error 51", "os error 65", "os error 101", "os error 113"]) {
        return ("net.unreachable", first_host(ctx));
    }
    if any(&m, RESET_TEXTS) {
        return ("net.reset", first_host(ctx));
    }
    if any(&m, &["failed to lookup", "lookup address", "nodename nor servname", "name or service not known", "no such host", "temporary failure in name resolution", "dns error", "failed to resolve"]) {
        return ("dns.notFound", first_host(ctx));
    }
    if any(&m, &["timed out", "timeout", "deadline has elapsed", "os error 60", "os error 110"]) && !m.contains("no available servers") && !m.contains("server selection") {
        return ("net.timeout", first_host(ctx));
    }
    if any(&m, &["directconnection", "direct connection"]) {
        return no("select.direct");
    }
    if any(&m, &["no available servers", "server selection timeout", "server selection", "no suitable server"]) {
        return ("select.noServer", first_host(ctx));
    }
    if any(&m, &["unsupported", "not supported"]) && any(&m, &["gssapi", "aws", "oidc", "mongodb-aws", "mongodb-oidc"]) {
        return no("config.unsupportedOption");
    }

    ("other", Vec::new())
}

fn net_refused() -> &'static str {
    "net.refused"
}

fn auth_code(m: &str) -> &'static str {
    if any(m, &["x509", "x.509"]) || (m.contains("subject") && m.contains("$external")) {
        "auth.x509Subject"
    } else if any(m, &["mechanism", "mechanismunavailable", "unsupported authentication", "unknown sasl", "no mechanism"]) {
        "auth.mechanism"
    } else if any(m, &["authsource", "auth source", "authentication database"]) {
        "auth.source"
    } else {
        "auth.failed"
    }
}

fn authz_code(m: &str) -> &'static str {
    if m.contains("listdatabases") {
        "authz.listDatabases"
    } else if any(m, &["execute command { find", "execute command { aggregate", "execute command { count", "execute command { distinct", "execute command { listcollections", "execute command { listindexes", "execute command { collstats", "to find on", "to aggregate on", "to execute command { find", "to execute command { aggregate"]) {
        "authz.collection"
    } else {
        "authz.command"
    }
}

/// ssh stderr and tunnel-layer wording. Only active when an ssh tunnel is configured or the text names ssh.
fn ssh_rules(m: &str, ctx: &Ctx) -> Option<Decision> {
    let sshish = ctx.tunnel == "ssh" || m.contains("ssh") || m.contains("openssh");
    if !sshish {
        return None;
    }
    let no = |c: &'static str| -> Option<Decision> { Some((c, Vec::new())) };
    if any(m, &["remote host identification has changed", "host key has changed", "host key for", "offending"]) && any(m, &["changed", "offending"]) {
        return no("tunnel.hostKeyChanged");
    }
    if any(m, &["could not be scanned", "unscannable", "proxyjump", "proxycommand"]) {
        return no("tunnel.hostKeyUnscannable");
    }
    if m.contains("host key verification failed") || m.contains("no matching host key") || m.contains("host key unknown") {
        return no("tunnel.hostKeyUnknown");
    }
    if any(m, &["ssh binary not found", "no usable ssh", "ssh: command not found", "openssh is older", "openssh older", "ssh not found", "ssh is not installed"]) {
        return no("tunnel.noSsh");
    }
    if any(m, &["unprotected private key file", "bad permissions", "permissions are too open"]) {
        return no("tunnel.keyPerms");
    }
    if any(m, &["incorrect passphrase", "bad passphrase", "wrong passphrase", "error in libcrypto", "passphrase supplied"]) {
        return no("tunnel.passphrase");
    }
    if any(m, &["no such identity", "identity file", "key file not found", "could not open key"]) && any(m, &["no such", "not accessible", "not found", "could not"]) {
        return no("tunnel.keyFile");
    }
    if any(m, &["keyboard-interactive", "verification code", "two-factor", "2fa", "one-time password"]) && !m.contains("permission denied (publickey)") {
        return no("tunnel.interactive");
    }
    if any(m, &["permission denied", "too many authentication failures", "no more authentication methods"]) {
        return no("tunnel.auth");
    }
    if m.contains("ipv6") {
        return no("tunnel.ipv6");
    }
    if any(m, &["administratively prohibited", "forwarding is disabled", "tcp forwarding", "port forwarding is disabled", "allowtcpforwarding"]) {
        return no("tunnel.forwardingDisabled");
    }
    if any(m, &["open failed: connect failed", "channel open failed", "connect failed: connection refused", "connect_to", "stdio forwarding failed"]) {
        return no("tunnel.targetRefused");
    }
    if any(m, &["could not resolve hostname", "name or service not known", "nodename nor servname"]) && m.contains("ssh") {
        return no("tunnel.dns");
    }
    if any(m, &["master", "control socket", "mux_client", "control connection"]) && any(m, &["exited", "ended", "died", "gone", "terminated", "closed", "no such file", "connection refused"]) {
        return no("tunnel.dropped");
    }
    if m.contains("connect to host") || (m.contains("ssh:") && any(m, &["connection refused", "timed out", "no route", "unreachable", "connection closed", "connection reset"])) {
        return no("tunnel.network");
    }
    None
}

/// `Address: host:port` entries of a server-selection topology: members that are not seed hosts and that carry an error
/// while every seed host is without one. Returns the advertised names the computer cannot reach.
fn unreachable_members(text: &str, ctx: &Ctx) -> Option<Vec<String>> {
    if ctx.hosts.is_empty() || !text.contains("Address: ") {
        return None;
    }
    let seed = |a: &str| -> bool {
        let host = a.rsplit_once(':').map_or(a, |(h, _)| h);
        ctx.hosts.iter().any(|h| h.eq_ignore_ascii_case(a) || h.eq_ignore_ascii_case(host) || h.rsplit_once(':').map_or(false, |(hh, _)| hh.eq_ignore_ascii_case(host)))
    };
    let mut seed_error = false;
    let mut bad = Vec::new();
    for chunk in text.split("Address: ").skip(1) {
        let addr: String = chunk.chars().take_while(|c| !c.is_whitespace() && *c != ',' && *c != '}').collect();
        // The part up to the closing brace of this server entry.
        let entry = chunk.split('}').next().unwrap_or("");
        let has_err = entry.contains("Error:");
        if seed(&addr) {
            seed_error |= has_err;
        } else if has_err && !bad.contains(&addr) {
            bad.push(addr);
        }
    }
    if seed_error || bad.is_empty() {
        None
    } else {
        Some(bad)
    }
}

fn atlas_hints(code: &str, ctx: &Ctx, params: &mut Vec<(String, String)>) {
    if !ctx.is_atlas {
        return;
    }
    let add: &[&str] = match code {
        "net.timeout" | "net.refused" | "net.reset" | "net.unreachable" => &["atlas.networkAccess"],
        "select.noServer" => &["atlas.networkAccess", "atlas.paused"],
        "auth.failed" | "auth.source" => &["atlas.databaseUser", "atlas.authSource"],
        "dns.srv" | "dns.txt" | "dns.notFound" => &["atlas.clusterName"],
        "authz.listDatabases" => &["atlas.databaseUser"],
        _ => &[],
    };
    for a in add {
        params.push(p("hint", a));
    }
}

// ---- steps -------------------------------------------------------------------------------------------------------

const ORDER: [StepId; 7] = [StepId::Config, StepId::Tunnel, StepId::Dns, StepId::Connect, StepId::Tls, StepId::Auth, StepId::Permissions];

/// The step a code is shown on and the state it gets (`Warn` for a role that merely cannot list databases).
pub fn step_for(code: &str) -> (StepId, StepState) {
    match code.split('.').next().unwrap_or("") {
        "config" => (StepId::Config, StepState::Failed),
        "tunnel" => (StepId::Tunnel, StepState::Failed),
        "dns" => (StepId::Dns, StepState::Failed),
        "net" | "select" | "timeout" => (StepId::Connect, StepState::Failed),
        "tls" => (StepId::Tls, StepState::Failed),
        "auth" => (StepId::Auth, StepState::Failed),
        "authz" if code == "authz.listDatabases" => (StepId::Permissions, StepState::Warn),
        "authz" => (StepId::Permissions, StepState::Failed),
        _ => (StepId::Connect, StepState::Failed),
    }
}

/// The step list shown for a failed test: steps before the failed one are `Ok` (or `Skipped` when this configuration does
/// not run them: no tunnel, or name resolution and TCP done remotely behind a tunnel), the failed one is `Failed` (or
/// `Warn`), every later step is `Skipped`. No step after the failed one is ever `Ok`.
pub fn steps_for(diag: &Diagnosis, ctx: &Ctx) -> Vec<TestStep> {
    let (failed, state) = step_for(&diag.code);
    let at = ORDER.iter().position(|s| *s == failed).unwrap_or(0);
    ORDER
        .iter()
        .enumerate()
        .map(|(i, id)| {
            let state = if i == at {
                state
            } else if i > at {
                StepState::Skipped
            } else {
                let skipped = match id {
                    StepId::Tunnel => ctx.tunnel == "none" || ctx.tunnel.is_empty(),
                    StepId::Dns => ctx.tunnel != "none" && !ctx.tunnel.is_empty() && !ctx.srv,
                    StepId::Connect => ctx.tunnel != "none" && !ctx.tunnel.is_empty(),
                    _ => false,
                };
                if skipped { StepState::Skipped } else { StepState::Ok }
            };
            TestStep { id: *id, state, ms: 0, note: None }
        })
        .collect()
}

// ---- scrubbing ---------------------------------------------------------------------------------------------------

const DETAIL_CAP: usize = 4096;

/// Raw error text for "Technical details": URI credentials, known user names and paths, absolute paths, `user@` prefixes,
/// control and bidi characters removed; capped.
pub fn scrub_detail(text: &str, ctx: &Ctx) -> String {
    let mut s = crate::host::redact(text);
    for needle in ctx.scrub.iter().filter(|n| n.chars().count() >= 3) {
        s = s.replace(needle.as_str(), "***");
    }
    let s: String = s.chars().filter(|c| !is_hostile_char(*c)).collect();
    let mut out = String::with_capacity(s.len());
    let mut token = String::new();
    let flush = |token: &mut String, out: &mut String| {
        if token.is_empty() {
            return;
        }
        out.push_str(&scrub_token(token));
        token.clear();
    };
    for c in s.chars() {
        if c.is_whitespace() || matches!(c, '"' | '\'' | '(' | ')' | ',' | ';' | '<' | '>' | '[' | ']' | '=' | '{' | '}' | '`') {
            flush(&mut token, &mut out);
            out.push(c);
        } else {
            token.push(c);
        }
    }
    flush(&mut token, &mut out);
    if out.len() > DETAIL_CAP {
        let mut cut = DETAIL_CAP;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push('…');
    }
    out
}

fn is_hostile_char(c: char) -> bool {
    (c.is_control() && c != '\n' && c != '\t')
        || matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}' | '\u{061C}' | '\u{FEFF}')
}

fn scrub_token(token: &str) -> String {
    let trail = token.len() - token.trim_end_matches(|c| matches!(c, ':' | '.' | '!' | '?')).len();
    let (body, tail) = token.split_at(token.len() - trail);
    let windows = body.len() > 2 && body.as_bytes()[1] == b':' && body.as_bytes()[0].is_ascii_alphabetic() && matches!(body.as_bytes()[2], b'\\' | b'/');
    if body.starts_with('/') && body.len() > 1 && !body.starts_with("//") || body.starts_with("~/") || body.starts_with("~\\") || windows {
        return format!("<path>{tail}");
    }
    if let Some((user, host)) = body.split_once('@') {
        if !user.is_empty() && !host.is_empty() && user != "***" && !body.contains("://") && !host.contains('@') {
            return format!("<user>@{host}{tail}");
        }
    }
    token.to_string()
}
