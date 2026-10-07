//! HTTP/1.1 head parsing and the pure rewrite rules of the proxy (no sockets here, so everything is unit-tested).

/// Path under which the proxy itself serves the inspector script (never forwarded upstream).
pub const INSPECTOR_PATH: &str = "/__intely/inspect.js";
/// The tag injected into HTML. Same-origin `src`, so a page CSP of `script-src 'self'` still allows it.
pub const SCRIPT_TAG: &str = "<script src=\"/__intely/inspect.js\" data-intely=\"1\"></script>";
pub const MAX_HEAD: usize = 64 * 1024;
pub const MAX_HTML: usize = 16 * 1024 * 1024;

pub type Headers = Vec<(String, Vec<u8>)>;

pub struct ReqHead {
    pub method: String,
    pub target: String,
    pub headers: Headers,
}

pub struct RespHead {
    pub status: u16,
    pub reason: String,
    pub headers: Headers,
}

pub fn header<'a>(h: &'a Headers, name: &str) -> Option<&'a [u8]> {
    h.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_slice())
}

pub fn header_str<'a>(h: &'a Headers, name: &str) -> Option<&'a str> {
    header(h, name).and_then(|v| std::str::from_utf8(v).ok()).map(str::trim)
}

fn token_list_has(value: Option<&str>, token: &str) -> bool {
    value.is_some_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case(token)))
}

pub fn is_upgrade(h: &Headers) -> bool {
    token_list_has(header_str(h, "connection"), "upgrade") && header(h, "upgrade").is_some()
}

/// Index just past the `\r\n\r\n` that ends a head, if `buf` holds a whole head.
pub fn head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

fn collect(headers: &[httparse::Header<'_>]) -> Headers {
    headers.iter().map(|h| (h.name.to_string(), h.value.to_vec())).collect()
}

pub fn parse_request(buf: &[u8]) -> Option<ReqHead> {
    let mut storage = [httparse::EMPTY_HEADER; 128];
    let mut req = httparse::Request::new(&mut storage);
    match req.parse(buf).ok()? {
        httparse::Status::Complete(_) => Some(ReqHead { method: req.method?.to_string(), target: req.path?.to_string(), headers: collect(req.headers) }),
        httparse::Status::Partial => None,
    }
}

pub fn parse_response(buf: &[u8]) -> Option<RespHead> {
    let mut storage = [httparse::EMPTY_HEADER; 128];
    let mut resp = httparse::Response::new(&mut storage);
    match resp.parse(buf).ok()? {
        httparse::Status::Complete(_) => Some(RespHead { status: resp.code?, reason: resp.reason.unwrap_or("").to_string(), headers: collect(resp.headers) }),
        httparse::Status::Partial => None,
    }
}

pub fn serialize_status(status: u16, reason: &str, headers: &Headers) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status} {reason}\r\n").into_bytes();
    for (k, v) in headers {
        out.extend_from_slice(k.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(v);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"\r\n");
    out
}

pub fn serialize_request(method: &str, target: &str, headers: &Headers) -> Vec<u8> {
    let mut out = format!("{method} {target} HTTP/1.1\r\n").into_bytes();
    for (k, v) in headers {
        out.extend_from_slice(k.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(v);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"\r\n");
    out
}

/// A complete small response (errors, the inspector script).
pub fn simple_response(status: u16, reason: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
    let headers: Headers = vec![
        ("Content-Type".into(), content_type.as_bytes().to_vec()),
        ("Content-Length".into(), body.len().to_string().into_bytes()),
        ("Cache-Control".into(), b"no-store".to_vec()),
        ("Connection".into(), b"close".to_vec()),
        ("X-Content-Type-Options".into(), b"nosniff".to_vec()),
    ];
    let mut out = serialize_status(status, reason, &headers);
    out.extend_from_slice(body);
    out
}

// ---------------------------------------------------------------------------------------------------------------------
// Host / origin rules

/// `Host` must name this proxy on loopback: stops DNS rebinding (a rebound name carries its own `Host`).
pub fn host_allowed(host: Option<&str>, proxy_port: u16) -> bool {
    let Some(h) = host else { return false };
    let h = h.trim().to_ascii_lowercase();
    h == format!("127.0.0.1:{proxy_port}") || h == format!("localhost:{proxy_port}") || h == format!("[::1]:{proxy_port}")
}

/// `scheme://host[:port]` -> (lowercase host without brackets, port).
fn split_origin(origin: &str) -> Option<(String, Option<u16>)> {
    let rest = origin.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.contains('@') {
        return None;
    }
    let (host, port) = if let Some(r) = authority.strip_prefix('[') {
        let (h, tail) = r.split_once(']')?;
        (h.to_string(), tail.strip_prefix(':').and_then(|p| p.parse().ok()))
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse().ok()),
            None => (authority.to_string(), None),
        }
    };
    Some((host.to_ascii_lowercase(), port))
}

pub fn is_loopback_host(host: &str) -> bool {
    host == "localhost" || host == "127.0.0.1" || host == "::1"
}

/// An `Origin` the proxy accepts: loopback only (never `null`, never a remote site).
pub fn origin_allowed(origin: &str) -> bool {
    split_origin(origin).is_some_and(|(h, _)| is_loopback_host(&h))
}

fn is_proxy_origin(origin: &str, proxy_port: u16) -> bool {
    split_origin(origin).is_some_and(|(h, p)| is_loopback_host(&h) && p == Some(proxy_port))
}

/// Request headers for the upstream: the dev server sees itself (Host/Origin/Referer rewritten), identity encoding,
/// `Connection: close` (unless upgrading). Hop-by-hop headers are dropped.
pub fn upstream_request_headers(h: &Headers, proxy_port: u16, upstream_host: &str, upstream_port: u16) -> Headers {
    let upgrade = is_upgrade(h);
    let upstream_origin = format!("http://{upstream_host}:{upstream_port}");
    let mut out: Headers = Vec::with_capacity(h.len() + 2);
    out.push(("Host".into(), format!("{upstream_host}:{upstream_port}").into_bytes()));
    for (k, v) in h {
        let lk = k.to_ascii_lowercase();
        match lk.as_str() {
            "host" | "accept-encoding" | "keep-alive" | "proxy-connection" | "proxy-authorization" => continue,
            "connection" => continue,
            "origin" => {
                let s = String::from_utf8_lossy(v);
                let val = if is_proxy_origin(&s, proxy_port) { upstream_origin.clone() } else { s.into_owned() };
                out.push((k.clone(), val.into_bytes()));
            }
            "referer" => {
                let s = String::from_utf8_lossy(v).into_owned();
                let own = [format!("http://127.0.0.1:{proxy_port}"), format!("http://localhost:{proxy_port}"), format!("http://[::1]:{proxy_port}")];
                let val = own.iter().find_map(|o| s.strip_prefix(o.as_str()).map(|rest| format!("{upstream_origin}{rest}"))).unwrap_or(s);
                out.push((k.clone(), val.into_bytes()));
            }
            _ => out.push((k.clone(), v.clone())),
        }
    }
    if !upgrade {
        out.push(("Accept-Encoding".into(), b"identity".to_vec()));
    }
    out.push(("Connection".into(), if upgrade { b"Upgrade".to_vec() } else { b"close".to_vec() }));
    out
}

pub enum Location {
    Keep,
    Rewrite(String),
    /// Points off the upstream: the proxy refuses to relay it.
    Block,
}

/// Redirect targets: relative stays, the upstream's own origin becomes the proxy's, anything else is blocked.
pub fn rewrite_location(loc: &str, upstream_port: u16, proxy_port: u16) -> Location {
    let l = loc.trim();
    if l.starts_with('/') && !l.starts_with("//") {
        return Location::Keep;
    }
    if !l.contains("://") && !l.starts_with("//") {
        return Location::Keep; // relative reference
    }
    let full = if let Some(rest) = l.strip_prefix("//") { format!("http://{rest}") } else { l.to_string() };
    let Some((host, port)) = split_origin(&full) else { return Location::Block };
    if !full.starts_with("http://") || !is_loopback_host(&host) || port != Some(upstream_port) {
        return Location::Block;
    }
    let rest = &full["http://".len()..];
    let path = rest.find(['/', '?', '#']).map(|i| &rest[i..]).unwrap_or("");
    Location::Rewrite(format!("http://127.0.0.1:{proxy_port}{path}"))
}

/// Drops `frame-ancestors` from a CSP value; None when nothing else is left.
pub fn strip_frame_ancestors(csp: &str) -> Option<String> {
    let kept: Vec<&str> = csp.split(';').map(str::trim).filter(|d| !d.is_empty() && !d.to_ascii_lowercase().starts_with("frame-ancestors")).collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join("; "))
    }
}

/// Response headers for the client. `body_len` replaces framing headers when the body was rewritten; `location` is the
/// rewritten redirect target (the original is kept when None).
pub fn client_response_headers(h: &Headers, body_len: Option<usize>, location: Option<String>) -> Headers {
    let mut out: Headers = Vec::with_capacity(h.len() + 1);
    for (k, v) in h {
        let lk = k.to_ascii_lowercase();
        match lk.as_str() {
            "x-frame-options" | "connection" | "keep-alive" | "proxy-connection" => continue,
            "content-length" | "transfer-encoding" | "content-encoding" | "etag" | "content-md5" if body_len.is_some() => continue,
            "location" => out.push((k.clone(), location.clone().map(String::into_bytes).unwrap_or_else(|| v.clone()))),
            "content-security-policy" | "content-security-policy-report-only" => {
                if let Some(rest) = strip_frame_ancestors(&String::from_utf8_lossy(v)) {
                    out.push((k.clone(), rest.into_bytes()));
                }
            }
            _ => out.push((k.clone(), v.clone())),
        }
    }
    if let Some(n) = body_len {
        out.push(("Content-Length".into(), n.to_string().into_bytes()));
    }
    out.push(("Connection".into(), b"close".to_vec()));
    out
}

// ---------------------------------------------------------------------------------------------------------------------
// Body handling

pub enum Dechunk {
    Complete(Vec<u8>),
    Incomplete,
    Invalid,
}

/// Decodes a `Transfer-Encoding: chunked` body (extensions ignored, trailers skipped).
pub fn dechunk(buf: &[u8]) -> Dechunk {
    let mut out = Vec::new();
    let mut i = 0;
    loop {
        let Some(rel) = buf[i..].windows(2).position(|w| w == b"\r\n") else { return Dechunk::Incomplete };
        let line = &buf[i..i + rel];
        let size_txt = std::str::from_utf8(line).ok().and_then(|s| s.split(';').next()).map(str::trim);
        let Some(size) = size_txt.and_then(|s| usize::from_str_radix(s, 16).ok()) else { return Dechunk::Invalid };
        i += rel + 2;
        if size == 0 {
            // trailers until an empty line
            loop {
                let Some(rel) = buf[i..].windows(2).position(|w| w == b"\r\n") else { return Dechunk::Incomplete };
                i += rel + 2;
                if rel == 0 {
                    return Dechunk::Complete(out);
                }
            }
        }
        if buf.len() < i + size + 2 {
            return Dechunk::Incomplete;
        }
        out.extend_from_slice(&buf[i..i + size]);
        i += size;
        if &buf[i..i + 2] != b"\r\n" {
            return Dechunk::Invalid;
        }
        i += 2;
    }
}

fn find_ci(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()].eq_ignore_ascii_case(needle))
}

/// Offset just past the first real `<head ...>` tag (not `<header>`).
fn after_head_open(html: &[u8]) -> Option<usize> {
    let mut from = 0;
    while let Some(i) = find_ci(html, b"<head", from) {
        if html.get(i + 5).is_some_and(|c| *c == b'>' || c.is_ascii_whitespace()) {
            return html[i..].iter().position(|&c| c == b'>').map(|p| i + p + 1);
        }
        from = i + 5;
    }
    None
}

/// Puts `tag` right after the opening `<head ...>` (so it runs first), else before `</head>`, else after the doctype,
/// else at the start. Idempotent: a document that already carries the inspector tag is returned unchanged.
pub fn inject_script(html: &[u8], tag: &str) -> Vec<u8> {
    if find_ci(html, b"data-intely=\"1\"", 0).is_some() {
        return html.to_vec();
    }
    let at = after_head_open(html)
        .or_else(|| find_ci(html, b"</head>", 0))
        .or_else(|| {
            let start = html.iter().position(|c| !c.is_ascii_whitespace()).unwrap_or(0);
            if html[start..].len() >= 9 && html[start..start + 9].eq_ignore_ascii_case(b"<!doctype") {
                html[start..].iter().position(|&c| c == b'>').map(|p| start + p + 1)
            } else {
                None
            }
        })
        .unwrap_or(0);
    let mut out = Vec::with_capacity(html.len() + tag.len());
    out.extend_from_slice(&html[..at]);
    out.extend_from_slice(tag.as_bytes());
    out.extend_from_slice(&html[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_must_name_the_proxy_on_loopback() {
        assert!(host_allowed(Some("127.0.0.1:5000"), 5000));
        assert!(host_allowed(Some("LOCALHOST:5000"), 5000));
        assert!(host_allowed(Some("[::1]:5000"), 5000));
        assert!(!host_allowed(Some("127.0.0.1:5001"), 5000));
        assert!(!host_allowed(Some("evil.example:5000"), 5000));
        assert!(!host_allowed(Some("127.0.0.1.evil.example:5000"), 5000));
        assert!(!host_allowed(Some("127.0.0.1"), 5000));
        assert!(!host_allowed(None, 5000));
    }

    #[test]
    fn origins_are_loopback_only() {
        assert!(origin_allowed("http://127.0.0.1:5000"));
        assert!(origin_allowed("tauri://localhost"));
        assert!(origin_allowed("http://[::1]:1420"));
        assert!(!origin_allowed("null"));
        assert!(!origin_allowed("https://evil.example"));
        assert!(!origin_allowed("http://localhost@evil.example"));
        assert!(!origin_allowed("http://localhost.evil.example"));
    }

    #[test]
    fn redirects_are_relayed_only_when_they_stay_on_the_upstream() {
        assert!(matches!(rewrite_location("/login", 8082, 5000), Location::Keep));
        assert!(matches!(rewrite_location("next?x=1", 8082, 5000), Location::Keep));
        match rewrite_location("http://localhost:8082/a/b?c=1", 8082, 5000) {
            Location::Rewrite(s) => assert_eq!(s, "http://127.0.0.1:5000/a/b?c=1"),
            _ => panic!("expected rewrite"),
        }
        match rewrite_location("http://127.0.0.1:8082", 8082, 5000) {
            Location::Rewrite(s) => assert_eq!(s, "http://127.0.0.1:5000"),
            _ => panic!("expected rewrite"),
        }
        for bad in ["https://accounts.example.com/oauth", "http://10.0.0.5:8082/", "http://127.0.0.1:9999/", "http://localhost:8082@evil.example/", "//evil.example/x", "ftp://127.0.0.1:8082/", "https://localhost:8082/"] {
            assert!(matches!(rewrite_location(bad, 8082, 5000), Location::Block), "{bad}");
        }
    }

    #[test]
    fn request_headers_are_rewritten_for_the_dev_server() {
        let h: Headers = vec![
            ("Host".into(), b"127.0.0.1:5000".to_vec()),
            ("Accept-Encoding".into(), b"gzip, br".to_vec()),
            ("Connection".into(), b"keep-alive".to_vec()),
            ("Origin".into(), b"http://127.0.0.1:5000".to_vec()),
            ("Referer".into(), b"http://127.0.0.1:5000/a?b".to_vec()),
            ("Cookie".into(), b"s=1".to_vec()),
        ];
        let out = upstream_request_headers(&h, 5000, "127.0.0.1", 8082);
        assert_eq!(header_str(&out, "host"), Some("127.0.0.1:8082"));
        assert_eq!(header_str(&out, "accept-encoding"), Some("identity"));
        assert_eq!(header_str(&out, "connection"), Some("close"));
        assert_eq!(header_str(&out, "origin"), Some("http://127.0.0.1:8082"));
        assert_eq!(header_str(&out, "referer"), Some("http://127.0.0.1:8082/a?b"));
        assert_eq!(header_str(&out, "cookie"), Some("s=1"));
    }

    #[test]
    fn websocket_upgrades_keep_their_headers() {
        let h: Headers = vec![
            ("Host".into(), b"localhost:5000".to_vec()),
            ("Connection".into(), b"keep-alive, Upgrade".to_vec()),
            ("Upgrade".into(), b"websocket".to_vec()),
            ("Sec-WebSocket-Key".into(), b"abc".to_vec()),
            ("Sec-WebSocket-Extensions".into(), b"permessage-deflate".to_vec()),
            ("Accept-Encoding".into(), b"gzip".to_vec()),
        ];
        assert!(is_upgrade(&h));
        let out = upstream_request_headers(&h, 5000, "127.0.0.1", 8082);
        assert_eq!(header_str(&out, "connection"), Some("Upgrade"));
        assert_eq!(header_str(&out, "upgrade"), Some("websocket"));
        assert!(header(&out, "accept-encoding").is_none());
        assert_eq!(header_str(&out, "sec-websocket-extensions"), Some("permessage-deflate"));
    }

    #[test]
    fn frame_blocking_headers_are_removed() {
        let h: Headers = vec![
            ("X-Frame-Options".into(), b"DENY".to_vec()),
            ("Content-Security-Policy".into(), b"default-src 'self'; frame-ancestors 'none'".to_vec()),
            ("Content-Security-Policy-Report-Only".into(), b"frame-ancestors 'none'".to_vec()),
            ("Content-Type".into(), b"text/html".to_vec()),
        ];
        let out = client_response_headers(&h, None, None);
        assert!(header(&out, "x-frame-options").is_none());
        assert_eq!(header_str(&out, "content-security-policy"), Some("default-src 'self'"));
        assert!(header(&out, "content-security-policy-report-only").is_none());
        assert_eq!(header_str(&out, "content-type"), Some("text/html"));
    }

    #[test]
    fn dechunk_handles_extensions_trailers_and_partial_input() {
        assert!(matches!(dechunk(b"5\r\nhello\r\n4;x=1\r\n abc\r\n0\r\nT: v\r\n\r\n"), Dechunk::Complete(b) if b == b"hello abc"));
        assert!(matches!(dechunk(b"5\r\nhel"), Dechunk::Incomplete));
        assert!(matches!(dechunk(b"5\r\nhello\r\n0\r\n"), Dechunk::Incomplete));
        assert!(matches!(dechunk(b"zz\r\n"), Dechunk::Invalid));
        assert!(matches!(dechunk(b"2\r\nabXX"), Dechunk::Invalid));
    }

    #[test]
    fn the_script_goes_first_in_head_and_only_once() {
        let html = b"<!doctype html><html><HEAD lang=x><title>t</title></HEAD><body></body></html>";
        let out = String::from_utf8(inject_script(html, SCRIPT_TAG)).unwrap();
        assert!(out.contains(&format!("<HEAD lang=x>{SCRIPT_TAG}<title>")));
        assert_eq!(inject_script(out.as_bytes(), SCRIPT_TAG), out.as_bytes());
        let header_tag = String::from_utf8(inject_script(b"<header>x</header></head>", SCRIPT_TAG)).unwrap();
        assert!(header_tag.starts_with("<header>"), "<header> is not <head>");
        assert!(String::from_utf8(inject_script(b"<!DOCTYPE html><p>x", SCRIPT_TAG)).unwrap().starts_with(&format!("<!DOCTYPE html>{SCRIPT_TAG}")));
        assert!(String::from_utf8(inject_script(b"<p>x", SCRIPT_TAG)).unwrap().starts_with(SCRIPT_TAG));
    }

    #[test]
    fn heads_round_trip() {
        let raw = b"GET /a?b=1 HTTP/1.1\r\nHost: x\r\nCookie: a=b\r\n\r\nBODY";
        let end = head_end(raw).unwrap();
        let r = parse_request(&raw[..end]).unwrap();
        assert_eq!((r.method.as_str(), r.target.as_str()), ("GET", "/a?b=1"));
        let back = serialize_request(&r.method, &r.target, &r.headers);
        assert!(back.starts_with(b"GET /a?b=1 HTTP/1.1\r\nHost: x\r\n"));
        let resp = parse_response(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n").unwrap();
        assert_eq!(resp.status, 101);
    }
}
