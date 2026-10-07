//! Connection-string classification without a driver: which host(s) a URI points at and the resulting effective level.
//! Also credential redaction for logs and errors.

use crate::connspec::{ConnSpec, Scheme, Tunnel};
use crate::types::EffectiveLevel;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostInfo {
    pub srv: bool,
    pub hosts: Vec<String>,
    pub has_credentials: bool,
    pub database: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UriError(pub String);
impl std::fmt::Display for UriError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for UriError {}

pub fn parse_uri(uri: &str) -> Result<HostInfo, UriError> {
    let uri = uri.trim();
    let (srv, rest) = if let Some(r) = uri.strip_prefix("mongodb+srv://") {
        (true, r)
    } else if let Some(r) = uri.strip_prefix("mongodb://") {
        (false, r)
    } else {
        return Err(UriError("not a mongodb:// or mongodb+srv:// URI".into()));
    };
    let (authority_path, _query) = rest.split_once('?').unwrap_or((rest, ""));
    let (authority, path) = match authority_path.find('/') {
        Some(k) => (&authority_path[..k], &authority_path[k + 1..]),
        None => (authority_path, ""),
    };
    let (creds, hostlist) = match authority.rfind('@') {
        Some(k) => (Some(&authority[..k]), &authority[k + 1..]),
        None => (None, authority),
    };
    let mut hosts = Vec::new();
    for h in hostlist.split(',').filter(|h| !h.is_empty()) {
        let host = if let Some(rest) = h.strip_prefix('[') {
            rest.split(']').next().unwrap_or("").to_string()
        } else {
            h.rsplit_once(':').map_or(h, |(a, _)| a).to_string()
        };
        if host.is_empty() {
            return Err(UriError("empty host".into()));
        }
        hosts.push(host.to_ascii_lowercase());
    }
    if hosts.is_empty() {
        return Err(UriError("no host in URI".into()));
    }
    Ok(HostInfo { srv, hosts, has_credentials: creds.is_some(), database: (!path.is_empty()).then(|| path.to_string()) })
}

pub fn is_loopback_host(h: &str) -> bool {
    matches!(h, "localhost" | "127.0.0.1" | "::1") || h.strip_prefix("127.").is_some_and(|r| r.split('.').count() == 3 && r.split('.').all(|p| p.parse::<u8>().is_ok()))
}

/// `max(tag, host rule)`: the host rule alone decides Local vs Production-level here (the tag only raises it).
pub fn effective_level(info: &HostInfo) -> EffectiveLevel {
    if !info.srv && info.hosts.iter().all(|h| is_loopback_host(h)) {
        EffectiveLevel::Local
    } else {
        EffectiveLevel::ProductionLevel
    }
}

/// `mongodb(+srv)://user:pass@host` to `mongodb(+srv)://***@host`; also scrubs any such URI inside a longer message.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(k) = rest.find("mongodb") {
        out.push_str(&rest[..k]);
        let tail = &rest[k..];
        let scheme_len = if tail.starts_with("mongodb+srv://") {
            14
        } else if tail.starts_with("mongodb://") {
            10
        } else {
            out.push_str("mongodb");
            rest = &tail[7..];
            continue;
        };
        out.push_str(&tail[..scheme_len]);
        let after = &tail[scheme_len..];
        let end = after.find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | ')')).unwrap_or(after.len());
        let authority_end = after[..end].find('/').unwrap_or(end);
        match after[..authority_end].rfind('@') {
            Some(at) => {
                out.push_str("***@");
                out.push_str(&after[at + 1..end]);
            }
            None => out.push_str(&after[..end]),
        }
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// The first host that is not loopback (for a `+srv` URI the first host): the name a user types to lower the effective level.
pub fn first_remote_host(info: &HostInfo) -> Option<&str> {
    if info.srv {
        return info.hosts.first().map(String::as_str);
    }
    info.hosts.iter().map(String::as_str).find(|h| !is_loopback_host(h))
}

/// The host as shown in the connection manager: enough to recognise it, not enough to paste somewhere. Loopback hosts
/// are shown as they are; other names keep the first three characters of the first label and everything after it,
/// IPv4 addresses keep the first two octets.
pub fn display_host(info: &HostInfo) -> String {
    let mask = |h: &str| -> String {
        if is_loopback_host(h) {
            return h.to_string();
        }
        let octets: Vec<&str> = h.split('.').collect();
        if octets.len() == 4 && octets.iter().all(|o| o.parse::<u8>().is_ok()) {
            return format!("{}.{}.*.*", octets[0], octets[1]);
        }
        match h.split_once('.') {
            Some((first, rest)) => format!("{}***.{rest}", first.chars().take(3).collect::<String>()),
            None => format!("{}***", h.chars().take(3).collect::<String>()),
        }
    };
    let first = info.hosts.first().map_or_else(String::new, |h| mask(h));
    match info.hosts.len() {
        0 | 1 => first,
        n => format!("{first} (+{})", n - 1),
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && s.is_char_boundary(i + 1) && s.is_char_boundary(i + 3) {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Literal credential fragments of a URI (user and password, raw and percent-decoded, three characters or longer).
/// Used to scrub error text that echoes them outside of a full `mongodb://` URI.
pub fn credential_fragments(uri: &str) -> Vec<String> {
    let rest = uri.trim().strip_prefix("mongodb+srv://").or_else(|| uri.trim().strip_prefix("mongodb://")).unwrap_or("");
    let authority = rest.split(['/', '?']).next().unwrap_or("");
    let Some(at) = authority.rfind('@') else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    for part in authority[..at].splitn(2, ':') {
        for v in [part.to_string(), percent_decode(part)] {
            if v.chars().count() >= 3 && !out.contains(&v) {
                out.push(v);
            }
        }
    }
    out
}

/// [`redact`] plus a literal scrub of the given credential fragments.
pub fn scrub(text: &str, fragments: &[String]) -> String {
    let mut out = redact(text);
    for f in fragments {
        out = out.replace(f.as_str(), "***");
    }
    out
}

// ---- spec-driven connections (T6a) -----------------------------------------------------------------------------

fn bare_host(h: &str) -> String {
    h.strip_prefix('[').and_then(|r| r.strip_suffix(']')).unwrap_or(h).to_ascii_lowercase()
}

/// The effective level of a structured connection: `max(tag, host rule)`. Any tunnel (SSH or SOCKS5) makes the host
/// rule Production-level whatever the host names say, and only the typed `level_override` for the typed host (the
/// bastion or proxy of a tunnel, else the first remote database host) lowers it.
pub fn spec_level(spec: &ConnSpec, tag_production: bool, level_override: Option<&str>) -> EffectiveLevel {
    let rule = spec.host_level();
    let lowered = rule == EffectiveLevel::ProductionLevel
        && matches!((level_override, spec.remote_host()), (Some(typed), Some(r)) if typed.trim().eq_ignore_ascii_case(&r));
    if tag_production || (rule == EffectiveLevel::ProductionLevel && !lowered) {
        EffectiveLevel::ProductionLevel
    } else {
        EffectiveLevel::Local
    }
}

/// Which `hello` members belong to the connection the user described.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SeedRule {
    /// Seed hosts, lower-case, IPv6 brackets removed.
    pub hosts: Vec<String>,
    /// For `mongodb+srv`: the parent domain; every host below it belongs to the cluster.
    pub srv_parent: Option<String>,
    /// Behind a tunnel or proxy a loopback member is not "this computer": only the seeds themselves are inside.
    pub tunnelled: bool,
}

impl SeedRule {
    pub fn from_spec(spec: &ConnSpec) -> Self {
        let hosts: Vec<String> = spec.hosts.iter().map(|h| bare_host(&h.host)).collect();
        let srv_parent = (spec.scheme == Scheme::Srv).then(|| hosts.first().and_then(|h| h.split_once('.').map(|(_, p)| p.to_string()))).flatten();
        Self { hosts, srv_parent, tunnelled: !matches!(spec.tunnel, Tunnel::None) }
    }

    /// For a connection string the driver already parsed (legacy profiles): the seeds are what it will connect to.
    pub fn from_hosts(hosts: Vec<String>) -> Self {
        Self { hosts: hosts.into_iter().map(|h| bare_host(&h)).collect(), srv_parent: None, tunnelled: false }
    }

    fn inside(&self, member_host: &str) -> bool {
        if self.hosts.iter().any(|h| h == member_host) {
            return true;
        }
        if self.srv_parent.as_deref().is_some_and(|p| member_host.ends_with(&format!(".{p}"))) {
            return true;
        }
        // the old rule: seeds on this computer may name other loopback members
        !self.tunnelled && self.hosts.iter().all(|h| is_loopback_host(h)) && is_loopback_host(member_host)
    }

    /// True when a member (`host:port`, `[v6]:port` or a bare host) is outside the seeds: the connection fronts more
    /// than the user typed, so the member rule re-raises the level even when the host override is set.
    pub fn outside(&self, members: &[String]) -> bool {
        !self.outsiders(members).is_empty()
    }

    /// The members (as given) that are outside the seeds.
    pub fn outsiders(&self, members: &[String]) -> Vec<String> {
        members
            .iter()
            .filter(|m| {
                let h = m.strip_prefix('[').and_then(|r| r.split(']').next()).unwrap_or_else(|| m.rsplit_once(':').map_or(m.as_str(), |(a, _)| a));
                !self.inside(&h.to_ascii_lowercase())
            })
            .cloned()
            .collect()
    }
}

/// What the new parser's policy finds in a stored connection string of a legacy profile.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LegacyPolicy {
    /// `tlsAllowInvalid*`, `tlsInsecure` (true) or any `proxy*` option: the relaxed chip shows and D10 applies.
    pub relaxed: bool,
    /// Offending option names (never values), in order of appearance.
    pub options: Vec<String>,
}

/// Scans the query string of a legacy URI. Pure; never reads the userinfo.
pub fn legacy_policy(uri: &str) -> LegacyPolicy {
    let mut out = LegacyPolicy::default();
    let Some((_, query)) = uri.split_once('?') else { return out };
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let key = percent_decode(k).to_ascii_lowercase();
        let truthy = percent_decode(v).eq_ignore_ascii_case("true");
        let hit = match key.as_str() {
            "tlsallowinvalidcertificates" | "tlsallowinvalidhostnames" | "tlsinsecure" | "sslallowinvalidcertificates" | "sslallowinvalidhostnames" => truthy,
            k => k.starts_with("proxy"),
        };
        if hit {
            out.relaxed = true;
            out.options.push(key);
        }
    }
    out
}

/// The per-connection scrub registry: every literal that must never reach an error, an event or a log, raw and
/// percent-encoded, longest first (so a longer value is replaced before a part of it). Built once per connection from
/// the spec (user names, key and certificate paths, the bastion and proxy user) and the secrets typed or stored.
pub fn spec_fragments(spec: &ConnSpec, secrets: &[&str]) -> Vec<String> {
    let mut raw: Vec<String> = Vec::new();
    raw.extend(spec.auth.username.clone());
    raw.extend(spec.tls.ca_file.clone());
    raw.extend(spec.tls.client_cert_file.clone());
    match &spec.tunnel {
        Tunnel::None => {}
        Tunnel::Ssh(s) => {
            raw.push(s.user.clone());
            raw.extend(s.key_file.clone());
        }
        Tunnel::Socks5(p) => raw.extend(p.username.clone()),
    }
    raw.extend(secrets.iter().map(|s| s.to_string()));
    let mut out: Vec<String> = Vec::new();
    for r in raw {
        let encoded: String = r.bytes().map(|b| if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
        for v in [r, encoded] {
            if v.chars().count() >= 3 && !out.contains(&v) {
                out.push(v);
            }
        }
    }
    out.sort_by_key(|f| std::cmp::Reverse(f.len()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connspec::{HostPort, ProxySpec, SshSpec, Tunnel};

    fn spec(hosts: &[&str]) -> ConnSpec {
        ConnSpec { hosts: hosts.iter().map(|h| HostPort { host: (*h).into(), port: Some(27017) }).collect(), ..Default::default() }
    }
    fn ssh() -> Tunnel {
        Tunnel::Ssh(SshSpec { host: "bastion.example.com".into(), user: "ops".into(), ..Default::default() })
    }
    fn socks() -> Tunnel {
        Tunnel::Socks5(ProxySpec { host: "127.0.0.1".into(), port: 1080, ..Default::default() })
    }

    #[test]
    fn any_tunnel_is_production_level_even_for_loopback_names() {
        use EffectiveLevel::*;
        assert_eq!(spec_level(&spec(&["127.0.0.1"]), false, None), Local);
        for t in [ssh(), socks()] {
            let mut s = spec(&["127.0.0.1"]);
            s.tunnel = t;
            assert_eq!(spec_level(&s, false, None), ProductionLevel);
            // a typed host that is not the tunnel endpoint does not lower it
            assert_eq!(spec_level(&s, false, Some("db.example.com")), ProductionLevel);
        }
        // the endpoint is the host to type: here the SOCKS5 proxy on this computer
        let mut s = spec(&["10.1.2.3"]);
        s.tunnel = socks();
        assert_eq!(spec_level(&s, false, Some("127.0.0.1")), Local);
        assert_eq!(spec_level(&s, false, Some("10.1.2.3")), ProductionLevel);
    }

    #[test]
    fn only_the_typed_endpoint_host_lowers_the_level_and_the_tag_still_raises() {
        use EffectiveLevel::*;
        let mut s = spec(&["10.1.2.3"]);
        s.tunnel = ssh();
        assert_eq!(spec_level(&s, false, Some("BASTION.example.com")), Local);
        assert_eq!(spec_level(&s, false, Some("10.1.2.3")), ProductionLevel);
        assert_eq!(spec_level(&s, true, Some("bastion.example.com")), ProductionLevel);
        let direct = spec(&["db.example.com"]);
        assert_eq!(spec_level(&direct, false, None), ProductionLevel);
        assert_eq!(spec_level(&direct, false, Some("db.example.com")), Local);
        assert_eq!(spec_level(&direct, false, Some("other.example.com")), ProductionLevel);
        let mut srv = spec(&["cluster0.abc.mongodb.net"]);
        srv.scheme = Scheme::Srv;
        assert_eq!(spec_level(&srv, false, None), ProductionLevel);
        assert_eq!(spec_level(&srv, false, Some("cluster0.abc.mongodb.net")), Local);
    }

    fn members(m: &[&str]) -> Vec<String> {
        m.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_member_rule_judges_members_against_the_seeds() {
        // the old loopback rule survives
        let local = SeedRule::from_spec(&spec(&["127.0.0.1"]));
        assert!(!local.outside(&members(&["127.0.0.1:27017", "localhost:27018"])));
        assert!(local.outside(&members(&["127.0.0.1:27017", "172.17.0.4:27017"])));
        // a typed (overridden) remote seed: its own members are inside, a stranger is not
        let remote = SeedRule::from_spec(&spec(&["db1.example.com", "DB2.example.com"]));
        assert!(!remote.outside(&members(&["db1.example.com:27017", "db2.example.com:27017"])));
        assert!(remote.outside(&members(&["db1.example.com:27017", "db3.example.com:27017"])));
        assert!(remote.outside(&members(&["127.0.0.1:27017"])), "a loopback member of a remote seed is a surprise");
        // through a tunnel a loopback member is only inside when it is a seed
        let mut t = spec(&["127.0.0.1"]);
        t.tunnel = ssh();
        let rule = SeedRule::from_spec(&t);
        assert!(!rule.outside(&members(&["127.0.0.1:27017"])));
        assert!(rule.outside(&members(&["localhost:27017"])));
        assert!(rule.outside(&members(&["mongo-b.internal:27017"])));
        // srv: shard hosts under the parent domain
        let mut s = spec(&["cluster0.abc.mongodb.net"]);
        s.scheme = Scheme::Srv;
        let rule = SeedRule::from_spec(&s);
        assert_eq!(rule.srv_parent.as_deref(), Some("abc.mongodb.net"));
        assert!(!rule.outside(&members(&["cluster0-shard-00-00.abc.mongodb.net:27017"])));
        assert!(rule.outside(&members(&["evil.example.com:27017"])));
        assert!(rule.outside(&members(&["xabc.mongodb.net:27017"])), "suffix must match on a label boundary");
        // ipv6 literal
        assert!(SeedRule::from_spec(&spec(&["[::1]"])).outside(&members(&["[fd00::1]:27017"])));
        assert!(!SeedRule::from_spec(&spec(&["[::1]"])).outside(&members(&["[::1]:27017"])));
    }

    #[test]
    fn the_legacy_policy_flags_relaxed_tls_and_proxy_options_without_values() {
        let p = legacy_policy("mongodb://u:p@db.example.com/x?retryWrites=true&TlsAllowInvalidCertificates=TRUE");
        assert!(p.relaxed);
        assert_eq!(p.options, vec!["tlsallowinvalidcertificates"]);
        assert!(legacy_policy("mongodb://h/?tlsInsecure=true").relaxed);
        assert!(legacy_policy("mongodb://h/?tlsAllowInvalidHostnames=true").relaxed);
        assert!(legacy_policy("mongodb://h/?proxyHost=10.0.0.1&proxyPort=1080").relaxed);
        let p = legacy_policy("mongodb://h/?proxyUsername=bob&proxyPassword=hunter2hunter2");
        assert_eq!(p.options, vec!["proxyusername", "proxypassword"]);
        assert!(!format!("{p:?}").contains("hunter2"));
        for ok in ["mongodb://h/", "mongodb://h/x?tlsInsecure=false", "mongodb://h/?tls=true&replicaSet=rs0", "mongodb://h/?tlsAllowInvalidCertificates=false"] {
            assert!(!legacy_policy(ok).relaxed, "{ok}");
        }
        // userinfo that looks like an option is not scanned
        assert!(!legacy_policy("mongodb://tlsInsecure=true:x@h/x").relaxed);
    }

    #[test]
    fn the_scrub_registry_covers_names_paths_and_secrets_raw_and_encoded() {
        let mut s = spec(&["db.example.com"]);
        s.auth.username = Some("svc user".into());
        s.tls.ca_file = Some("/Users/ann/certs/ca.pem".into());
        s.tunnel = Tunnel::Ssh(SshSpec { host: "b.example.com".into(), user: "opsuser".into(), key_file: Some("/Users/ann/.ssh/id_ed25519".into()), ..Default::default() });
        let f = spec_fragments(&s, &["p@ss:w0rd/x", "ab"]);
        let msg = "auth failed for svc user (svc%20user) with p@ss:w0rd/x p%40ss%3Aw0rd%2Fx; read /Users/ann/certs/ca.pem; key /Users/ann/.ssh/id_ed25519; ssh opsuser@b.example.com; ab";
        let out = scrub(msg, &f);
        for leak in ["svc user", "svc%20user", "p@ss", "w0rd", "/Users/ann", "id_ed25519", "opsuser"] {
            assert!(!out.contains(leak), "{leak} leaked: {out}");
        }
        assert!(out.contains("b.example.com"), "hosts stay visible");
        assert!(out.ends_with("ab"), "values under three characters are not scrubbed");
        // longest first: a key path inside a longer message is replaced whole
        assert!(f.windows(2).all(|w| w[0].len() >= w[1].len()));
    }
}
