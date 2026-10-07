//! Connection-string parser and renderer (T2). Pure, no driver, never logs. [`parse_connection_string`] turns a pasted
//! `mongodb://` or `mongodb+srv://` string into a [`ConnSpec`] plus the secrets it carried; [`render`] builds the string
//! the driver parses (or its masked preview). The driver's `ClientOptions::parse` stays the single parser of the final
//! string; this module only decides what the *form* shows.
//!
//! Rules worth knowing (spec 5.4):
//! * Errors carry a code (`uri.*`) and never any part of the input, so a pasted password cannot leak through them.
//! * A secret (password, key passphrase) is never part of a note or of the masked rendering; the key passphrase is never
//!   rendered at all.
//! * Atlas placeholders (`<password>`, `<db_password>`, `<username>`) mean "not typed yet", never a real credential.
//! * Unknown, unsupported or ignored options are reported, not silently dropped. Harmless read-only options are
//!   collapsed into one `info.*` note so a normal Atlas paste shows no warning wall.
//! * An unescaped `@` in the password is accepted (the last `@` ends the userinfo) with a note; an unescaped `/` or `?`
//!   there cannot be told apart from the end of the host list and is refused with `uri.host`.

use intely_settings::Secret;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

use crate::api::Note;
use crate::connspec::*;
use crate::error::{code, Result, StudioError};

/// Largest accepted input; anything longer is refused before any work is done.
pub const MAX_INPUT_BYTES: usize = 16 * 1024;

/// The secrets a pasted string carried. They go to the draft vault, never to the webview.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ParsedSecrets {
    pub password: Option<Secret>,
    pub key_password: Option<Secret>,
}

#[derive(Debug, PartialEq)]
pub struct Parsed {
    pub spec: ConnSpec,
    pub secrets: ParsedSecrets,
    /// `tlsAllowInvalidCertificates=true` or `tlsInsecure=true` was in the string. This is a safety setting, not part of
    /// the spec: the caller shows the relaxed-checks confirmation instead of applying it silently.
    pub tls_relax: bool,
    pub notes: Vec<Note>,
    pub unsupported: Vec<Note>,
}

/// What `render` may put into the string. The key passphrase is never in a URI.
#[derive(Debug, Default)]
pub struct RenderSecrets {
    pub password: Option<Secret>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mask {
    /// `user:***@`
    Masked,
    /// The assembled string for the driver; connect time only.
    Full,
}

fn err(reason: &'static str) -> StudioError {
    StudioError::new(code::INVALID, reason)
}

fn note(code: &str, option: Option<&str>) -> Note {
    Note { code: code.into(), option: option.map(str::to_string) }
}

/// Option names are echoed in notes; keep only harmless ones.
fn opt_name(k: &str) -> String {
    if !k.is_empty() && k.len() <= 64 && k.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')) {
        k.to_string()
    } else {
        "?".to_string()
    }
}

fn hex(c: u8) -> Option<u8> {
    (c as char).to_digit(16).map(|d| d as u8)
}

/// Percent-decoding. A `%` not followed by two hex digits stays literal (second value true). Invalid UTF-8 and NUL are
/// refused.
fn decode(s: &str) -> Result<(String, bool)> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut literal = false;
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if let (Some(h), Some(l)) = (b.get(i + 1).copied().and_then(hex), b.get(i + 2).copied().and_then(hex)) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
            literal = true;
        }
        out.push(b[i]);
        i += 1;
    }
    if out.contains(&0) {
        return Err(err("uri.control"));
    }
    String::from_utf8(out).map(|s| (s, literal)).map_err(|_| err("uri.encoding"))
}

fn strip_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    s.get(..prefix.len()).filter(|h| h.eq_ignore_ascii_case(prefix)).map(|_| &s[prefix.len()..])
}

fn parse_bool(v: &str) -> Option<bool> {
    if v.eq_ignore_ascii_case("true") {
        Some(true)
    } else if v.eq_ignore_ascii_case("false") {
        Some(false)
    } else {
        None
    }
}

fn is_placeholder(v: &str, names: &[&str]) -> bool {
    let v = v.trim().to_ascii_lowercase();
    names.iter().any(|n| v == format!("<{n}>"))
}

fn absolute_path(p: &str) -> bool {
    let b = p.as_bytes();
    p.starts_with('/') || p.starts_with("\\\\") || (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/'))
}

fn parse_host_port(raw: &str) -> Result<HostPort> {
    let (host, port) = if let Some(rest) = raw.strip_prefix('[') {
        let end = rest.find(']').ok_or_else(|| err("uri.host"))?;
        let host = format!("[{}]", &rest[..end]);
        let tail = &rest[end + 1..];
        match tail.strip_prefix(':') {
            _ if tail.is_empty() => (host, None),
            Some(p) => (host, Some(p)),
            None => return Err(err("uri.host")),
        }
    } else {
        if raw.get(..3).is_some_and(|h| h.eq_ignore_ascii_case("%2f")) || raw.starts_with('/') {
            return Err(err("uri.unixSocket"));
        }
        match raw.split_once(':') {
            Some((h, p)) => (h.to_string(), Some(p)),
            None => (raw.to_string(), None),
        }
    };
    if !valid_host(&host) {
        return Err(err("uri.host"));
    }
    let port = match port {
        None => None,
        Some(p) => {
            if p.is_empty() || p.len() > 5 || !p.bytes().all(|c| c.is_ascii_digit()) {
                return Err(err("uri.port"));
            }
            match p.parse::<u32>() {
                Ok(n) if (1..=65535).contains(&n) => Some(n as u16),
                _ => return Err(err("uri.port")),
            }
        }
    };
    Ok(HostPort { host, port })
}

/// Numeric extra options: (min, max).
fn extra_range(key: &str) -> Option<(i64, i64)> {
    Some(match key {
        "maxPoolSize" => (1, 8),
        "minPoolSize" => (0, 4),
        "maxIdleTimeMS" => (1000, 3_600_000),
        "heartbeatFrequencyMS" => (500, 60_000),
        "localThresholdMS" => (0, 1000),
        "srvMaxHosts" => (0, 16),
        _ => return None,
    })
}

/// Options that only mean something for reads and that this build ignores; shown as one collapsed info note.
const INFO_IGNORED: &[&str] = &["retrywrites", "retryreads", "w", "wtimeoutms", "journal"];
/// Ignored options worth a visible (warning) note of their own.
const WARN_IGNORED: &[&str] = &["readpreferencetags", "uuidrepresentation", "tlsdisableocspendpointcheck", "tlsdisablecertificaterevocationcheck", "zlibcompressionlevel", "sockettimeoutms", "waitqueuetimeoutms"];

pub fn parse_connection_string(input: &str) -> Result<Parsed> {
    let s = input.trim();
    if s.is_empty() {
        return Err(err("uri.empty"));
    }
    if s.len() > MAX_INPUT_BYTES {
        return Err(err("uri.tooLong"));
    }
    if s.chars().any(char::is_control) {
        return Err(err("uri.control"));
    }
    let (scheme, rest) = if let Some(r) = strip_ci(s, "mongodb+srv://") {
        (Scheme::Srv, r)
    } else if let Some(r) = strip_ci(s, "mongodb://") {
        (Scheme::Standard, r)
    } else {
        return Err(err("uri.scheme"));
    };

    let mut notes: Vec<Note> = Vec::new();
    let mut unsupported: Vec<Note> = Vec::new();

    let auth_end = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(auth_end);

    // userinfo
    let (userinfo, hostlist) = match authority.rfind('@') {
        Some(i) => (Some(&authority[..i]), &authority[i + 1..]),
        None => (None, authority),
    };
    let mut username: Option<String> = None;
    let mut password: Option<Secret> = None;
    if let Some(ui) = userinfo {
        if ui.contains('@') {
            notes.push(note("uri.userinfoAt", None));
        }
        let (u_raw, p_raw) = match ui.split_once(':') {
            Some((u, p)) => (u, Some(p)),
            None => (ui, None),
        };
        let (u, u_lit) = decode(u_raw)?;
        if is_placeholder(&u, &["username", "db_username", "user"]) {
            notes.push(note("uri.usernamePlaceholder", None));
        } else if !u.is_empty() {
            username = Some(u);
        }
        let mut literal = u_lit;
        if let Some(p_raw) = p_raw {
            let (p, p_lit) = decode(p_raw)?;
            literal |= p_lit;
            if is_placeholder(&p, &["password", "db_password", "dbpassword"]) {
                notes.push(note("uri.passwordPlaceholder", None));
            } else if !p.is_empty() {
                password = Some(Secret::new(p));
            }
        }
        if literal {
            notes.push(note("uri.percentLiteral", None));
        }
    }

    // hosts
    if hostlist.is_empty() {
        return Err(err("uri.host"));
    }
    let mut hosts: Vec<HostPort> = hostlist.split(',').map(parse_host_port).collect::<Result<_>>()?;
    if scheme == Scheme::Srv {
        if hosts.len() != 1 {
            return Err(err("uri.srvOneHost"));
        }
        if hosts[0].port.take().is_some() {
            notes.push(note("uri.srvPortDropped", None));
        }
    }

    // path and query
    let (path, query) = match tail.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (tail, None),
    };
    let database = match path.strip_prefix('/') {
        Some(d) if !d.is_empty() => {
            let (d, _) = decode(d)?;
            Some(d).filter(|d| !d.is_empty())
        }
        _ => None,
    };

    // options: case-insensitive, last wins
    let mut opts: Vec<(String, String, String)> = Vec::new(); // (lower key, display key, value)
    if let Some(q) = query {
        for pair in q.split('&').filter(|p| !p.is_empty()) {
            let (k_raw, v_raw) = pair.split_once('=').unwrap_or((pair, ""));
            let (k, _) = decode(k_raw)?;
            let (v, _) = decode(v_raw)?;
            let lower = k.to_ascii_lowercase();
            if !pair.contains('=') {
                notes.push(note("uri.optionNoValue", Some(&opt_name(&k))));
                continue;
            }
            match opts.iter_mut().find(|o| o.0 == lower) {
                Some(slot) => {
                    slot.2 = v;
                    notes.push(note("uri.duplicate", Some(&opt_name(&k))));
                }
                None => opts.push((lower, k, v)),
            }
        }
    }

    let mut spec = ConnSpec { scheme, hosts, database, ..Default::default() };
    let mut key_password: Option<Secret> = None;
    let mut tls_relax = false;
    let mut tls_param: Option<bool> = None;
    let mut ssl_param: Option<bool> = None;
    let mut mechanism: Option<AuthMechanism> = None;
    let mut info_ignored: Vec<String> = Vec::new();

    for (lower, shown, v) in &opts {
        if v.is_empty() {
            continue; // `appName=`, `replicaSet=`: nothing to apply
        }
        let name = opt_name(shown);
        let invalid = |notes: &mut Vec<Note>| notes.push(note("uri.invalidValue", Some(&name)));
        match lower.as_str() {
            "replicaset" => spec.topology.replica_set = Some(v.clone()),
            "directconnection" => match parse_bool(v) {
                Some(b) => spec.topology.direct_connection = Some(b),
                None => invalid(&mut notes),
            },
            "authsource" => spec.auth.source = Some(v.clone()),
            "authmechanism" => {
                let m = if v.eq_ignore_ascii_case("SCRAM-SHA-1") {
                    Some(AuthMechanism::ScramSha1)
                } else if v.eq_ignore_ascii_case("SCRAM-SHA-256") {
                    Some(AuthMechanism::ScramSha256)
                } else if v.eq_ignore_ascii_case("MONGODB-X509") {
                    Some(AuthMechanism::X509)
                } else if v.eq_ignore_ascii_case("PLAIN") {
                    Some(AuthMechanism::Plain)
                } else {
                    None
                };
                match m {
                    Some(m) => mechanism = Some(m),
                    None => unsupported.push(note("unsupported.authMechanism", Some(&opt_name(v)))),
                }
            }
            "tls" => match parse_bool(v) {
                Some(b) => tls_param = Some(b),
                None => invalid(&mut notes),
            },
            "ssl" => match parse_bool(v) {
                Some(b) => ssl_param = Some(b),
                None => invalid(&mut notes),
            },
            "tlscafile" | "tlscertificatekeyfile" => {
                if v.starts_with('~') {
                    notes.push(note("uri.pathTilde", Some(&name)));
                } else if !absolute_path(v) {
                    notes.push(note("uri.pathRelative", Some(&name)));
                }
                if lower == "tlscafile" {
                    spec.tls.ca_file = Some(v.clone());
                } else {
                    spec.tls.client_cert_file = Some(v.clone());
                }
            }
            "tlscertificatekeyfilepassword" => key_password = Some(Secret::new(v.clone())),
            "tlsallowinvalidcertificates" => match parse_bool(v) {
                Some(true) => {
                    tls_relax = true;
                    notes.push(note("uri.tlsRelax", Some(&name)));
                }
                Some(false) => {}
                None => invalid(&mut notes),
            },
            "tlsinsecure" => match parse_bool(v) {
                Some(true) => {
                    tls_relax = true;
                    notes.push(note("uri.tlsInsecure", Some(&name)));
                }
                Some(false) => {}
                None => invalid(&mut notes),
            },
            "tlsallowinvalidhostnames" => {
                if parse_bool(v) == Some(true) {
                    notes.push(note("unsupportedInBuild", Some(&name)));
                }
            }
            "readpreference" => {
                let m = [
                    ("primary", ReadPrefMode::Primary),
                    ("primarypreferred", ReadPrefMode::PrimaryPreferred),
                    ("secondary", ReadPrefMode::Secondary),
                    ("secondarypreferred", ReadPrefMode::SecondaryPreferred),
                    ("nearest", ReadPrefMode::Nearest),
                ]
                .into_iter()
                .find(|(n, _)| v.eq_ignore_ascii_case(n))
                .map(|(_, m)| m);
                match m {
                    Some(m) => spec.topology.read_preference = m,
                    None => invalid(&mut notes),
                }
            }
            "maxstalenessseconds" => match v.parse::<i64>() {
                Ok(-1) => {}
                Ok(n) if (0..=u32::MAX as i64).contains(&n) => spec.topology.max_staleness_s = Some(n as u32),
                _ => invalid(&mut notes),
            },
            "compressors" => {
                for c in v.split(',').map(str::trim).filter(|c| !c.is_empty()) {
                    let known = [Compressor::Zstd, Compressor::Zlib, Compressor::Snappy].into_iter().find(|k| k.as_str().eq_ignore_ascii_case(c));
                    match known {
                        Some(k) if !spec.compressors.contains(&k) => spec.compressors.push(k),
                        Some(_) => {}
                        None => unsupported.push(note("unsupported.compressor", Some(&opt_name(c)))),
                    }
                }
            }
            "appname" => spec.app_name = Some(v.clone()),
            "connecttimeoutms" | "serverselectiontimeoutms" => match v.parse::<u32>() {
                Ok(n) if lower == "connecttimeoutms" => spec.timeouts.connect_ms = Some(n),
                Ok(n) => spec.timeouts.server_selection_ms = Some(n),
                Err(_) => invalid(&mut notes),
            },
            "proxyhost" | "proxyport" | "proxyusername" | "proxypassword" => unsupported.push(note("unsupported.proxy", Some(&name))),
            "authmechanismproperties" | "gssapiservicename" => unsupported.push(note("unsupported.authMechanismProperties", Some(&name))),
            "autoencryptionopts" => unsupported.push(note("unsupported.autoEncryption", Some(&name))),
            k if INFO_IGNORED.contains(&k) => info_ignored.push(name),
            k if WARN_IGNORED.contains(&k) => notes.push(note("uri.ignoredOption", Some(&name))),
            _ => match canonical_extra_key(lower) {
                Some(key) => {
                    if scheme == Scheme::Standard && matches!(key, "srvMaxHosts" | "srvServiceName") {
                        notes.push(note("uri.srvOnly", Some(key)));
                        continue;
                    }
                    let value = if let Some((lo, hi)) = extra_range(key) {
                        match v.parse::<i64>() {
                            Ok(n) => {
                                let c = n.clamp(lo, hi);
                                if c != n {
                                    notes.push(note("uri.clamped", Some(key)));
                                }
                                Some(c.to_string())
                            }
                            Err(_) => None,
                        }
                    } else {
                        match key {
                            "readConcernLevel" => ["local", "majority", "available"].into_iter().find(|l| v.eq_ignore_ascii_case(l)).map(str::to_string),
                            "srvServiceName" => valid_host(v).then(|| v.clone()),
                            "loadBalanced" => match parse_bool(v) {
                                Some(true) => Some("true".to_string()),
                                Some(false) => {
                                    continue;
                                }
                                None => None,
                            },
                            _ => None,
                        }
                    };
                    match value {
                        Some(value) => spec.extra.push(ExtraOption { key: key.to_string(), value }),
                        None => notes.push(note("uri.invalidValue", Some(key))),
                    }
                }
                None => unsupported.push(note("unsupported.option", Some(&name))),
            },
        }
    }

    if let (Some(t), Some(s)) = (tls_param, ssl_param) {
        if t != s {
            notes.push(note("uri.tlsConflict", None));
        }
    }
    spec.tls.mode = match tls_param.or(ssl_param) {
        Some(true) => TlsMode::On,
        Some(false) => TlsMode::Off,
        None => TlsMode::Auto,
    };
    spec.auth.username = username;
    spec.auth.mechanism = match mechanism {
        Some(m) => m,
        None if spec.auth.username.is_some() => AuthMechanism::Default,
        None => AuthMechanism::None,
    };
    if !info_ignored.is_empty() {
        notes.push(note("info.ignoredReadOnly", Some(&info_ignored.join(","))));
    }

    Ok(Parsed { spec, secrets: ParsedSecrets { password, key_password }, tls_relax, notes, unsupported })
}

/// Every byte except the RFC 3986 unreserved set is percent-encoded.
const ENC: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

fn enc(s: &str) -> String {
    utf8_percent_encode(s, ENC).to_string()
}

/// [`render_ext`] without the relaxed-certificates flag (the usual preview).
pub fn render(spec: &ConnSpec, secrets: &RenderSecrets, mask: Mask) -> Result<String> {
    render_ext(spec, secrets, mask, false)
}

/// Builds the string for `spec`. Every value is percent-encoded, so no field can inject another option. `tls_relax`
/// adds `tlsAllowInvalidCertificates=true` (never `tlsInsecure`, never the hostname relax, which rustls ignores). The
/// key passphrase and SOCKS5 password are not URI material and never appear here. Hosts that fail the host rule are
/// refused; everything else (file existence, field problems) is `ConnSpec::validate`'s business.
pub fn render_ext(spec: &ConnSpec, secrets: &RenderSecrets, mask: Mask, tls_relax: bool) -> Result<String> {
    if spec.hosts.is_empty() || spec.hosts.iter().any(|h| !valid_host(&h.host)) {
        return Err(err("uri.host"));
    }
    let srv = spec.scheme == Scheme::Srv;
    let mut out = String::from(if srv { "mongodb+srv://" } else { "mongodb://" });

    let user = spec.auth.username.as_deref().filter(|u| !u.is_empty());
    if let (Some(u), true) = (user, spec.auth.mechanism != AuthMechanism::None) {
        out.push_str(&enc(u));
        if spec.auth.mechanism.uses_password() {
            match mask {
                Mask::Masked if secrets.password.is_some() || spec.auth.save_password => out.push_str(":***"),
                Mask::Full => {
                    if let Some(p) = &secrets.password {
                        out.push(':');
                        out.push_str(&enc(p.expose()));
                    }
                }
                Mask::Masked => {}
            }
        }
        out.push('@');
    }

    let hosts: Vec<String> = spec
        .hosts
        .iter()
        .map(|h| match (h.port, srv) {
            (Some(p), false) => format!("{}:{p}", h.host),
            _ => h.host.clone(),
        })
        .collect();
    out.push_str(&hosts.join(","));

    let mut q: Vec<(&str, String)> = Vec::new();
    let mut put = |k: &'static str, v: String| q.push((k, v));
    match spec.auth.mechanism {
        AuthMechanism::ScramSha1 => put("authMechanism", "SCRAM-SHA-1".into()),
        AuthMechanism::ScramSha256 => put("authMechanism", "SCRAM-SHA-256".into()),
        AuthMechanism::X509 => put("authMechanism", "MONGODB-X509".into()),
        AuthMechanism::Plain => put("authMechanism", "PLAIN".into()),
        AuthMechanism::None | AuthMechanism::Default => {}
    }
    if let Some(s) = spec.auth.source.as_deref().filter(|s| !s.is_empty()) {
        put("authSource", s.into());
    }
    if let Some(r) = spec.topology.replica_set.as_deref().filter(|r| !r.is_empty()) {
        put("replicaSet", r.into());
    }
    if let Some(d) = spec.topology.direct_connection {
        put("directConnection", d.to_string());
    }
    match spec.tls.mode {
        TlsMode::On => put("tls", "true".into()),
        TlsMode::Off => put("tls", "false".into()),
        TlsMode::Auto => {}
    }
    if let Some(p) = spec.tls.ca_file.as_deref().filter(|p| !p.is_empty()) {
        put("tlsCAFile", p.into());
    }
    if let Some(p) = spec.tls.client_cert_file.as_deref().filter(|p| !p.is_empty()) {
        put("tlsCertificateKeyFile", p.into());
    }
    if tls_relax {
        put("tlsAllowInvalidCertificates", "true".into());
    }
    let rp = spec.topology.read_preference;
    match rp {
        ReadPrefMode::Auto => {}
        ReadPrefMode::Primary => put("readPreference", "primary".into()),
        ReadPrefMode::PrimaryPreferred => put("readPreference", "primaryPreferred".into()),
        ReadPrefMode::Secondary => put("readPreference", "secondary".into()),
        ReadPrefMode::SecondaryPreferred => put("readPreference", "secondaryPreferred".into()),
        ReadPrefMode::Nearest => put("readPreference", "nearest".into()),
    }
    if let (Some(s), false) = (spec.topology.max_staleness_s, matches!(rp, ReadPrefMode::Auto | ReadPrefMode::Primary)) {
        put("maxStalenessSeconds", s.to_string());
    }
    let mut seen: Vec<Compressor> = Vec::new();
    for c in &spec.compressors {
        if !seen.contains(c) {
            seen.push(*c);
        }
    }
    if !seen.is_empty() {
        put("compressors", seen.iter().map(|c| c.as_str()).collect::<Vec<_>>().join(","));
    }
    if let Some(ms) = spec.timeouts.connect_ms {
        put("connectTimeoutMS", ms.to_string());
    }
    if let Some(ms) = spec.timeouts.server_selection_ms {
        put("serverSelectionTimeoutMS", ms.to_string());
    }
    if let Some(a) = spec.app_name.as_deref().filter(|a| !a.is_empty()) {
        put("appName", a.into());
    }
    for e in &spec.extra {
        // Only allow-listed options reach the driver, in their canonical spelling.
        if let Some(k) = canonical_extra_key(&e.key) {
            put(k, e.value.clone());
        }
    }

    let db = spec.database.as_deref().filter(|d| !d.is_empty());
    if db.is_some() || !q.is_empty() {
        out.push('/');
    }
    if let Some(d) = db {
        out.push_str(&enc(d));
    }
    if !q.is_empty() {
        out.push('?');
        out.push_str(&q.iter().map(|(k, v)| format!("{k}={}", enc(v))).collect::<Vec<_>>().join("&"));
    }
    Ok(out)
}
