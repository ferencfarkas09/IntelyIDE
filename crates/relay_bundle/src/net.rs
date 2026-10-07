//! Network rules against a hostile relay (spec 4.12.5) for the plain GETs of `check_relay`: strict URL parsing, the jail, one DNS
//! resolution whose answers must all be public, no redirects, a body cap and time limits. The production [`Http`] is
//! [`ReqwestHttp`]; tests inject a fake `Http` or a fake [`Resolver`].

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use intely_core::jail::{Jail, Mode};
use url::{Host, Url};

use crate::audit::{Http, HttpFuture, HttpRequest, HttpResponse};
use crate::error::{BundleError, Result};

pub const BODY_CAP: usize = 2 * 1024 * 1024;
pub const HEADER_CAP: usize = 64 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// A validated relay origin. `origin()` is rebuilt from the parsed parts; nothing else is ever connected to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    pub secure: bool,
    /// Lowercase host without brackets.
    pub host: String,
    pub port: Option<u16>,
    pub loopback: bool,
}

impl Origin {
    pub fn origin(&self) -> String {
        let scheme = if self.secure { "https" } else { "http" };
        let host = if self.host.contains(':') { format!("[{}]", self.host) } else { self.host.clone() };
        match self.port {
            Some(p) => format!("{scheme}://{host}:{p}"),
            None => format!("{scheme}://{host}"),
        }
    }

    pub fn effective_port(&self) -> u16 {
        self.port.unwrap_or(if self.secure { 443 } else { 80 })
    }

    /// Lowercase `host[:non-default-port]`, the form `remote.trust.allowedHosts` stores.
    pub fn host_key(&self) -> String {
        let host = if self.host.contains(':') { format!("[{}]", self.host) } else { self.host.clone() };
        match self.port {
            Some(p) => format!("{host}:{p}"),
            None => host,
        }
    }
}

fn bad(code: &'static str) -> BundleError {
    BundleError::Net(code)
}

fn is_loopback_literal(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// Parses a relay base (`https://host`, `wss://host`, `http://127.0.0.1:8787`, `ws://localhost:8787`, optionally with one `/`).
/// Plain `http`/`ws` is accepted for the literals `localhost`, `127.0.0.1` and `::1` only. Everything the URL parser would
/// normalise into something else (`127.1`, `0x7f.1`, `2130706433`, backslashes, percent escapes) is refused, because the user
/// must connect to what they typed.
pub fn parse_origin(raw: &str) -> Result<Origin> {
    if raw.is_empty() || raw.len() > 300 || !raw.bytes().all(|b| b.is_ascii_graphic()) || raw.contains(['\\', '%', '?', '#', '@']) {
        return Err(bad("badUrl"));
    }
    let (scheme, rest) = raw.split_once("://").ok_or_else(|| bad("badUrl"))?;
    let secure = match scheme.to_ascii_lowercase().as_str() {
        "https" | "wss" => true,
        "http" | "ws" => false,
        _ => return Err(bad("badUrl")),
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if !(path.is_empty() || path == "/") {
        return Err(bad("badUrl"));
    }
    // The text the user typed for the host, before any normalisation.
    let (typed_host, typed_port) = if let Some(inner) = authority.strip_prefix('[') {
        let (h, after) = inner.split_once(']').ok_or_else(|| bad("badUrl"))?;
        (format!("[{h}]"), after.strip_prefix(':').map(str::to_owned).or_else(|| after.is_empty().then(String::new)).ok_or_else(|| bad("badUrl"))?)
    } else {
        match authority.split_once(':') {
            Some((h, p)) => (h.to_owned(), p.to_owned()),
            None => (authority.to_owned(), String::new()),
        }
    };
    if typed_host.is_empty() || (authority.contains(':') && typed_port.is_empty() && !authority.ends_with(']')) {
        return Err(bad("badUrl"));
    }
    if !typed_port.is_empty() && (typed_port.len() > 5 || !typed_port.bytes().all(|b| b.is_ascii_digit()) || typed_port.parse::<u16>().ok().filter(|p| *p >= 1).is_none()) {
        return Err(bad("badUrl"));
    }
    let url = Url::parse(&format!("{}://{}", if secure { "https" } else { "http" }, authority)).map_err(|_| bad("badUrl"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad("badUrl"));
    }
    let typed_lower = typed_host.to_ascii_lowercase();
    let (host, loopback) = match url.host().ok_or_else(|| bad("badUrl"))? {
        Host::Domain(d) => {
            if d != typed_lower || !valid_domain(d) {
                return Err(bad("badUrl"));
            }
            (d.to_owned(), d == "localhost")
        }
        Host::Ipv4(ip) => {
            // Only the canonical dotted quad of 127.0.0.1 itself.
            if typed_lower != ip.to_string() || !ip.is_loopback() || ip != Ipv4Addr::LOCALHOST {
                return Err(bad("badUrl"));
            }
            (ip.to_string(), true)
        }
        Host::Ipv6(ip) => {
            if ip != Ipv6Addr::LOCALHOST || typed_lower != "[::1]" {
                return Err(bad("badUrl"));
            }
            ("::1".to_owned(), true)
        }
    };
    if !secure && !is_loopback_literal(&host) {
        return Err(bad("badUrl"));
    }
    let port = if typed_port.is_empty() { None } else { url.port() };
    Ok(Origin { secure, host, port, loopback })
}

/// A DNS name: 2 or more labels (except `localhost`), each 1..63 of `a-z0-9-` without a leading or trailing dash, 253 in total, no
/// trailing dot, a TLD that is not all digits, and not `*.localhost`.
fn valid_domain(d: &str) -> bool {
    if d == "localhost" {
        return true;
    }
    if d.is_empty() || d.len() > 253 || d.ends_with('.') || d.ends_with(".localhost") {
        return false;
    }
    let labels: Vec<&str> = d.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
        && !labels[labels.len() - 1].bytes().all(|b| b.is_ascii_digit())
}

/// Applies the jail to a parsed origin: read-only mode allows no network at all, the E2E jail allows loopback only.
pub fn check_jail(jail: &Jail, origin: &Origin) -> Result<()> {
    match jail.mode() {
        Mode::ReadOnly => Err(BundleError::Jail("readOnly".into())),
        Mode::E2e if !origin.loopback => Err(BundleError::Jail("testJail".into())),
        _ => Ok(()),
    }
}

/// True for addresses a public relay can never legitimately resolve to: loopback, private, link-local, CGNAT, unspecified,
/// multicast, broadcast, documentation, benchmarking, unique-local and IPv4-mapped forms of any of those.
pub fn is_forbidden_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => forbidden_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return forbidden_v4(v4);
            }
            let s = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (s[0] & 0xffc0) == 0xfe80 // link local fe80::/10
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || (s[0] == 0x0064 && s[1] == 0xff9b) // NAT64: can reach private v4 space
                || s[..6] == [0; 6] // deprecated IPv4-compatible ::a.b.c.d
                || s[0] == 0x2002 // 6to4: embeds an arbitrary v4 address
                || (s[0] == 0x2001 && s[1] == 0) // Teredo
                || (s[0] & 0xffc0) == 0xfec0 // deprecated site-local fec0::/10
        }
    }
}

fn forbidden_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || (o[0] == 100 && (o[1] & 0xc0) == 64) // CGNAT 100.64.0.0/10
        || (o[0] == 198 && (o[1] & 0xfe) == 18) // benchmarking 198.18.0.0/15
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // IETF protocol assignments 192.0.0.0/24
        || (o[0] == 192 && o[1] == 88 && o[2] == 99) // deprecated 6to4 relay anycast
        || o[0] == 0
        || o[0] >= 240
}

/// DNS seam: tests answer with chosen addresses, production asks the system resolver once.
pub trait Resolver: Send + Sync {
    fn resolve(&self, host: &str, port: u16) -> std::io::Result<Vec<IpAddr>>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve(&self, host: &str, port: u16) -> std::io::Result<Vec<IpAddr>> {
        Ok((host, port).to_socket_addrs()?.map(|a| a.ip()).collect())
    }
}

/// Production [`Http`]: validates the URL, applies the jail, resolves the name once (every answer must be public), connects to the
/// resolved address with the host name as SNI, follows no redirect, and caps time, headers and body. Proxies from the environment
/// are ignored on purpose (a proxy would defeat the address check).
#[derive(Clone)]
pub struct ReqwestHttp {
    jail: Jail,
    resolver: Arc<dyn Resolver>,
}

impl ReqwestHttp {
    pub fn new(jail: Jail) -> Self {
        Self { jail, resolver: Arc::new(SystemResolver) }
    }

    pub fn with_resolver(jail: Jail, resolver: Arc<dyn Resolver>) -> Self {
        Self { jail, resolver }
    }

    async fn fetch(&self, req: HttpRequest) -> Result<HttpResponse> {
        let (origin, path) = split_url(&req.url)?;
        check_jail(&self.jail, &origin)?;
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(Duration::from_secs(5))
            .no_proxy()
            .user_agent("IntelyIDE-relay-check");
        if !origin.loopback {
            let resolver = self.resolver.clone();
            let (host, port) = (origin.host.clone(), origin.effective_port());
            let ips = tokio::task::spawn_blocking(move || resolver.resolve(&host, port))
                .await
                .map_err(|_| bad("network"))?
                .map_err(|_| bad("network"))?;
            if ips.is_empty() {
                return Err(bad("network"));
            }
            if ips.iter().any(|ip| is_forbidden_address(*ip)) {
                return Err(bad("privateAddress"));
            }
            builder = builder.resolve(&origin.host, SocketAddr::new(ips[0], origin.effective_port()));
        }
        let client = builder.build().map_err(|_| bad("network"))?;
        let mut rb = client.get(format!("{}{}", origin.origin(), path));
        for (k, v) in &req.headers {
            rb = rb.header(k.as_str(), v.as_str());
        }
        let mut resp = rb.send().await.map_err(map_reqwest)?;
        let headers: Vec<(String, String)> =
            resp.headers().iter().map(|(k, v)| (k.as_str().to_owned(), String::from_utf8_lossy(v.as_bytes()).into_owned())).collect();
        if headers.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() > HEADER_CAP {
            return Err(bad("tooLarge"));
        }
        let status = resp.status().as_u16();
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(map_reqwest)? {
            if body.len() + chunk.len() > BODY_CAP {
                return Err(bad("tooLarge"));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(HttpResponse { status, headers, body })
    }
}

fn map_reqwest(e: reqwest::Error) -> BundleError {
    if e.is_timeout() {
        bad("timeout")
    } else {
        bad("network")
    }
}

impl Http for ReqwestHttp {
    fn get(&self, req: HttpRequest) -> HttpFuture<'_> {
        Box::pin(self.fetch(req))
    }
}

/// Splits a request URL into its validated origin and an absolute path of `[A-Za-z0-9._/-]` characters (no query, no fragment).
pub fn split_url(url: &str) -> Result<(Origin, String)> {
    let (_, rest) = url.split_once("://").ok_or_else(|| bad("badUrl"))?;
    let (origin_part, path) = match rest.find('/') {
        Some(i) => (&url[..url.len() - rest.len() + i], &rest[i..]),
        None => (url, "/"),
    };
    if !path.starts_with('/') || !path.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-')) || path.contains("..") {
        return Err(bad("badUrl"));
    }
    Ok((parse_origin(origin_part)?, path.to_owned()))
}
