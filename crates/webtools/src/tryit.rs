//! "Try it": one HTTP/1.1 request to a dev server on THIS computer. The target is never a host name: the address is 127.0.0.1
//! or ::1 (only a family the caller proved, see [`Allowed`]) and the port must be one the caller passes in. The caller takes them from
//! `lsof`, for the process tree of a dev server that the Scripts panel started, never from what a process prints. The request line takes a path only, a response is never followed anywhere (a redirect is shown, not
//! taken), and size and time are capped. Plain `TcpStream`, no TLS, no proxy, no extra dependency.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::{clean, fail, WebError};

pub const MAX_BODY_OUT: usize = 64 * 1024;
pub const MAX_HEAD_IN: usize = 16 * 1024;
pub const MAX_BODY_IN: usize = 256 * 1024;
pub const MAX_PATH: usize = 2048;
const MAX_HEADERS: usize = 20;
const TOTAL: Duration = Duration::from_secs(8);
const CONNECT: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TryRequest {
    pub port: u16,
    pub method: String,
    /// `/path?query`, origin form only.
    pub path: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TryResponse {
    pub status: u16,
    pub reason: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub body_truncated: bool,
    /// The body is not text; `body` is empty.
    pub binary: bool,
    pub bytes: u64,
    pub millis: u64,
    /// `127.0.0.1` or `::1`.
    pub host: String,
    /// The `Location` of a redirect. It is shown, never followed.
    pub redirect: Option<String>,
}

const METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const FORBIDDEN: &[&str] = &["host", "content-length", "connection", "transfer-encoding", "upgrade", "expect", "te", "trailer", "proxy-authorization", "proxy-connection"];

/// A port that may be tried, and the loopback address families a listing proved for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Allowed {
    pub port: u16,
    pub v4: bool,
    pub v6: bool,
}

/// The only addresses a request can go to.
pub fn target_addrs(port: u16) -> [SocketAddr; 2] {
    [SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port), SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port)]
}

fn token(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

/// Everything the request is checked against before a socket is opened.
pub fn validate(req: &TryRequest, allowed: &[Allowed]) -> Result<(), WebError> {
    if req.port == 0 || !allowed.iter().any(|a| a.port == req.port && (a.v4 || a.v6)) {
        return fail("notAllowed", "Try it only reaches a dev server that was started from the Scripts panel, on its own port");
    }
    if !METHODS.contains(&req.method.as_str()) {
        return fail("badMethod", "the method must be GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS");
    }
    let p = req.path.as_str();
    let bad_char = p.bytes().any(|b| b <= 0x20 || b == 0x7f || b == b'\\' || b >= 0x80);
    if !p.starts_with('/') || p.starts_with("//") || p.len() > MAX_PATH || bad_char {
        return fail("badPath", "the path must start with one slash and hold no spaces, line breaks or backslashes; write a path like /api/users, not a full address");
    }
    if req.headers.len() > MAX_HEADERS {
        return fail("badHeader", format!("at most {MAX_HEADERS} headers"));
    }
    for (k, v) in &req.headers {
        if !token(k) || FORBIDDEN.contains(&k.to_ascii_lowercase().as_str()) {
            return fail("badHeader", format!("the header {} cannot be set", clean(k, 40)));
        }
        if v.len() > 2048 || v.bytes().any(|b| b < 0x20 && b != b'\t' || b == 0x7f) {
            return fail("badHeader", format!("the value of {k} holds a line break or control character"));
        }
    }
    if req.body.as_ref().is_some_and(|b| b.len() > MAX_BODY_OUT) {
        return fail("tooLarge", format!("the body is larger than {} bytes", MAX_BODY_OUT));
    }
    Ok(())
}

fn connect(port: u16, families: (bool, bool), deadline: Instant) -> Result<(TcpStream, &'static str), WebError> {
    let mut last = None;
    for ((addr, host), wanted) in target_addrs(port).into_iter().zip(["127.0.0.1", "::1"]).zip([families.0, families.1]) {
        if !wanted {
            continue;
        }
        let left = deadline.saturating_duration_since(Instant::now()).min(CONNECT);
        if left.is_zero() {
            break;
        }
        match TcpStream::connect_timeout(&addr, left) {
            Ok(s) => return Ok((s, host)),
            Err(e) => last = Some(e),
        }
    }
    fail("connect", format!("nothing answers on port {port} ({})", last.map_or_else(|| "timed out".to_string(), |e| e.kind().to_string())))
}

struct Limited<'a> {
    s: &'a mut TcpStream,
    deadline: Instant,
}

impl Limited<'_> {
    fn read(&mut self, buf: &mut [u8]) -> Result<usize, WebError> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return fail("timeout", "the server did not finish answering in time");
        }
        self.s.set_read_timeout(Some(left)).ok();
        match self.s.read(buf) {
            Ok(n) => Ok(n),
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => fail("timeout", "the server did not answer in time"),
            Err(e) if matches!(e.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::UnexpectedEof) => Ok(0),
            Err(e) => fail("io", e.to_string()),
        }
    }
}

pub fn send(req: &TryRequest, allowed: &[Allowed]) -> Result<TryResponse, WebError> {
    send_within(req, allowed, TOTAL)
}

pub(crate) fn send_within(req: &TryRequest, allowed: &[Allowed], total: Duration) -> Result<TryResponse, WebError> {
    validate(req, allowed)?;
    let families = allowed.iter().filter(|a| a.port == req.port).fold((false, false), |f, a| (f.0 || a.v4, f.1 || a.v6));
    let started = Instant::now();
    let deadline = started + total;
    let (mut stream, host) = connect(req.port, families, deadline)?;
    stream.set_nodelay(true).ok();
    stream.set_write_timeout(Some(Duration::from_secs(3))).ok();
    let body = req.body.as_deref().unwrap_or("");
    let mut head = format!("{} {} HTTP/1.1\r\nHost: localhost:{}\r\nUser-Agent: IntelyIDE-TryIt\r\nAccept: */*\r\nConnection: close\r\n", req.method, req.path, req.port);
    for (k, v) in &req.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    if !body.is_empty() || matches!(req.method.as_str(), "POST" | "PUT" | "PATCH") {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).and_then(|()| stream.write_all(body.as_bytes())).map_err(|e| WebError { code: "io", message: e.to_string() })?;

    let mut r = Limited { s: &mut stream, deadline };
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let split = loop {
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break p;
        }
        if buf.len() > MAX_HEAD_IN {
            return fail("badResponse", "the response head is too large");
        }
        let n = r.read(&mut chunk)?;
        if n == 0 {
            return fail("badResponse", "the server closed the connection without an answer");
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head_text = String::from_utf8_lossy(&buf[..split]).into_owned();
    let mut lines = head_text.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let mut sl = status_line.splitn(3, ' ');
    let (version, code, reason) = (sl.next().unwrap_or(""), sl.next().unwrap_or(""), sl.next().unwrap_or(""));
    let status: u16 = code.parse().ok().filter(|c| (100..600).contains(c) && version.starts_with("HTTP/1.")).ok_or(WebError { code: "badResponse", message: "the server did not answer with HTTP".into() })?;
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (clean(k.trim(), 80), clean(v.trim(), 400))).take(60).collect();
    let header = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str());
    let chunked = header("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    let length: Option<usize> = header("content-length").and_then(|v| v.parse().ok());
    let no_body = req.method == "HEAD" || status == 204 || status == 304 || (100..200).contains(&status);

    let mut raw: Vec<u8> = buf[split + 4..].to_vec();
    let mut total_bytes: u64 = raw.len() as u64;
    let mut truncated = false;
    let mut body_out: Vec<u8> = Vec::new();
    if !no_body {
        if chunked {
            // decode as the bytes arrive; stop at the last chunk or at the cap
            let mut state = Chunked::default();
            loop {
                if state.feed(&mut raw, &mut body_out) {
                    break;
                }
                if body_out.len() > MAX_BODY_IN {
                    truncated = true;
                    break;
                }
                let n = r.read(&mut chunk)?;
                if n == 0 {
                    break;
                }
                total_bytes += n as u64;
                raw.extend_from_slice(&chunk[..n]);
            }
        } else {
            body_out = std::mem::take(&mut raw);
            loop {
                if length.is_some_and(|l| body_out.len() >= l) {
                    break;
                }
                if body_out.len() > MAX_BODY_IN {
                    truncated = true;
                    break;
                }
                let n = r.read(&mut chunk)?;
                if n == 0 {
                    break;
                }
                total_bytes += n as u64;
                body_out.extend_from_slice(&chunk[..n]);
            }
            if let Some(l) = length {
                body_out.truncate(l);
            }
        }
    }
    if body_out.len() > MAX_BODY_IN {
        body_out.truncate(MAX_BODY_IN);
        truncated = true;
    }
    let (body_text, binary) = decode_body(body_out, truncated);
    let redirect = if (300..400).contains(&status) { header("location").map(|l| clean(l, 300)) } else { None };
    Ok(TryResponse {
        status,
        reason: clean(reason, 60),
        headers,
        body: body_text,
        body_truncated: truncated,
        binary,
        bytes: total_bytes,
        millis: started.elapsed().as_millis() as u64,
        host: host.to_string(),
        redirect,
    })
}

/// Characters a response must not be able to use to disguise text on screen: controls (except line breaks and tabs), line and
/// paragraph separators, zero-width and bidirectional marks and overrides, and the byte order mark.
fn display_unsafe(c: char) -> bool {
    (c.is_control() && !matches!(c, '\n' | '\r' | '\t')) || matches!(c, '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
}

/// The body as text for the screen. A body cut by the size cap in the middle of a character still counts as text; a body with a NUL
/// byte or invalid UTF-8 before its end is binary.
pub(crate) fn decode_body(mut bytes: Vec<u8>, truncated: bool) -> (String, bool) {
    if truncated {
        if let Err(e) = std::str::from_utf8(&bytes) {
            if e.error_len().is_none() {
                bytes.truncate(e.valid_up_to());
            }
        }
    }
    match String::from_utf8(bytes) {
        Ok(t) if !t.contains('\0') => (t.chars().filter(|c| !display_unsafe(*c)).collect(), false),
        _ => (String::new(), true),
    }
}

#[derive(Default)]
struct Chunked {
    remaining: usize,
    in_chunk: bool,
}

impl Chunked {
    /// Consumes what it can of `raw` into `out`; true when the last chunk was seen.
    fn feed(&mut self, raw: &mut Vec<u8>, out: &mut Vec<u8>) -> bool {
        loop {
            if self.in_chunk {
                let take = self.remaining.min(raw.len());
                if out.len() <= MAX_BODY_IN {
                    out.extend_from_slice(&raw[..take]);
                }
                raw.drain(..take);
                self.remaining -= take;
                if self.remaining > 0 {
                    return false;
                }
                // the CRLF after the chunk data
                if raw.len() < 2 {
                    self.in_chunk = true;
                    self.remaining = 0;
                    return false;
                }
                raw.drain(..2);
                self.in_chunk = false;
            }
            let Some(eol) = raw.windows(2).position(|w| w == b"\r\n") else { return raw.len() > 64 };
            let size_text = String::from_utf8_lossy(&raw[..eol]).into_owned();
            let size_text = size_text.split(';').next().unwrap_or("").trim();
            let Ok(size) = usize::from_str_radix(size_text, 16) else { return true };
            raw.drain(..eol + 2);
            if size == 0 {
                return true;
            }
            self.remaining = size;
            self.in_chunk = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn ok(port: u16) -> [Allowed; 1] {
        [Allowed { port, v4: true, v6: false }]
    }

    fn req(port: u16, path: &str) -> TryRequest {
        TryRequest { port, method: "GET".into(), path: path.into(), headers: vec![], body: None }
    }

    /// Serves one connection with `reply` and returns what the client sent.
    fn serve(reply: Vec<u8>) -> (u16, std::thread::JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut got = Vec::new();
            let mut b = [0u8; 4096];
            loop {
                let n = s.read(&mut b).unwrap();
                got.extend_from_slice(&b[..n]);
                if got.windows(4).any(|w| w == b"\r\n\r\n") || n == 0 {
                    break;
                }
            }
            s.write_all(&reply).ok();
            String::from_utf8_lossy(&got).into_owned()
        });
        (port, h)
    }

    #[test]
    fn only_loopback_addresses_are_ever_targets() {
        for a in target_addrs(3000) {
            assert!(a.ip().is_loopback());
        }
    }

    #[test]
    fn a_port_that_is_not_a_known_dev_server_is_refused_before_any_socket_opens() {
        let (port, h) = serve(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec());
        assert_eq!(send(&req(port, "/"), &[]).unwrap_err().code, "notAllowed");
        assert_eq!(send(&req(port, "/"), &ok(port + 1)).unwrap_err().code, "notAllowed");
        assert_eq!(send(&req(0, "/"), &ok(0)).unwrap_err().code, "notAllowed");
        // unblock the listener thread
        let _ = TcpStream::connect(("127.0.0.1", port));
        let _ = h.join();
    }

    #[test]
    fn paths_methods_and_headers_cannot_aim_the_request_elsewhere() {
        let ok = |r: &TryRequest| validate(r, &ok(3000)).is_ok();
        assert!(ok(&req(3000, "/api/users?x=1")));
        for bad in ["http://evil.test/", "//evil.test/x", "api", "/a b", "/a\r\nHost: evil", "/a\\b", "", "/é"] {
            assert!(!ok(&req(3000, bad)), "{bad:?}");
        }
        let mut r = req(3000, "/");
        r.method = "CONNECT".into();
        assert!(!ok(&r));
        for (k, v) in [("Host", "evil.test"), ("Content-Length", "1"), ("Transfer-Encoding", "chunked"), ("X Bad", "1"), ("X-A", "a\r\nB: c")] {
            let mut r = req(3000, "/");
            r.headers = vec![(k.into(), v.into())];
            assert!(!ok(&r), "{k}");
        }
        let mut r = req(3000, "/");
        r.headers = vec![("Authorization".into(), "Bearer abc".into())];
        assert!(ok(&r));
    }

    #[test]
    fn a_normal_response_with_content_length() {
        let (port, h) = serve(b"HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}".to_vec());
        let mut r = req(port, "/items");
        r.method = "POST".into();
        r.body = Some("{\"a\":1}".into());
        r.headers = vec![("Content-Type".into(), "application/json".into())];
        let got = send(&r, &ok(port)).unwrap();
        assert_eq!((got.status, got.reason.as_str(), got.body.as_str(), got.host.as_str()), (201, "Created", "{\"ok\":true}", "127.0.0.1"));
        let sent = h.join().unwrap();
        assert!(sent.starts_with("POST /items HTTP/1.1\r\nHost: localhost:"));
        assert!(sent.contains("Connection: close\r\n") && sent.contains("Content-Length: 7\r\n"));
    }

    #[test]
    fn chunked_bodies_are_decoded() {
        let (port, h) = serve(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\n\r\n".to_vec());
        assert_eq!(send(&req(port, "/"), &ok(port)).unwrap().body, "hello world");
        h.join().unwrap();
    }

    #[test]
    fn a_redirect_is_shown_and_never_followed() {
        let (port, h) = serve(b"HTTP/1.1 302 Found\r\nLocation: http://evil.test/steal\r\nContent-Length: 0\r\n\r\n".to_vec());
        let got = send(&req(port, "/"), &ok(port)).unwrap();
        assert_eq!((got.status, got.redirect.as_deref()), (302, Some("http://evil.test/steal")));
        h.join().unwrap();
    }

    #[test]
    fn a_huge_response_is_cut_and_binary_is_not_shown() {
        let mut big = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        big.extend(vec![b'a'; MAX_BODY_IN * 3]);
        let (port, h) = serve(big);
        let got = send(&req(port, "/"), &ok(port)).unwrap();
        assert!(got.body_truncated && got.body.len() <= MAX_BODY_IN);
        let _ = h.join();
        let (port, h) = serve(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n\xff\xfe\x00".to_vec());
        let got = send(&req(port, "/"), &ok(port)).unwrap();
        assert!(got.binary && got.body.is_empty());
        h.join().unwrap();
    }

    #[test]
    fn a_server_that_never_answers_times_out_and_garbage_is_refused() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let t = std::thread::spawn(move || {
            let (_s, _) = l.accept().unwrap();
            std::thread::sleep(Duration::from_millis(600));
        });
        let err = send_within(&req(port, "/"), &ok(port), Duration::from_millis(250)).unwrap_err();
        assert_eq!(err.code, "timeout");
        t.join().unwrap();
        let (port, h) = serve(b"SSH-2.0-OpenSSH\r\n\r\n".to_vec());
        assert_eq!(send(&req(port, "/"), &ok(port)).unwrap_err().code, "badResponse");
        h.join().unwrap();
    }

    #[test]
    fn nothing_listening_is_a_friendly_error() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        assert_eq!(send(&req(port, "/"), &ok(port)).unwrap_err().code, "connect");
    }

    #[test]
    fn only_the_address_family_that_was_proved_is_connected() {
        // a listener on 127.0.0.1 that was only proved on ::1 must not be reached, and must not even see a connection
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        l.set_nonblocking(true).unwrap();
        let port = l.local_addr().unwrap().port();
        let only_v6 = [Allowed { port, v4: false, v6: true }];
        let err = send_within(&req(port, "/"), &only_v6, Duration::from_millis(500)).unwrap_err();
        assert_eq!(err.code, "connect");
        assert!(l.accept().is_err(), "the IPv4 listener must not have been connected to");
        // a port with no proved family is refused outright
        assert_eq!(send(&req(port, "/"), &[Allowed { port, v4: false, v6: false }]).unwrap_err().code, "notAllowed");
    }

    #[test]
    fn a_body_cut_inside_a_character_is_still_text() {
        let euros = "€".repeat(MAX_BODY_IN);
        let mut bytes = euros.into_bytes();
        bytes.truncate(MAX_BODY_IN); // 262144 is not a multiple of 3: the last character is cut
        let (text, binary) = decode_body(bytes, true);
        assert!(!binary && text.chars().all(|c| c == '€') && !text.is_empty());
        // the same bytes that end in the middle of a character without a cut are binary
        let (text, binary) = decode_body(vec![b'a', 0xe2, 0x82], false);
        assert!(binary && text.is_empty());
        assert!(decode_body(vec![b'a', 0, b'b'], false).1);
    }

    #[test]
    fn a_response_cannot_disguise_text_with_bidi_or_zero_width_characters() {
        let (text, binary) = decode_body("ok\u{202e}gnp.exe\u{2066}x\u{200b}y\u{feff}\u{0007}\nline".as_bytes().to_vec(), false);
        assert!(!binary);
        assert_eq!(text, "okgnp.exexy\nline");
    }

    #[test]
    fn the_source_has_one_loopback_connect_and_no_name_lookup() {
        let src = include_str!("tryit.rs");
        let code = &src[..src.find("#[cfg(test)]").unwrap()];
        assert_eq!(code.matches("connect_timeout(").count(), 1);
        for banned in ["TcpStream::connect(", "to_socket_addrs", "lookup_host", "ToSocketAddrs", "UdpSocket"] {
            assert!(!code.contains(banned), "{banned}");
        }
        for a in target_addrs(1234) {
            assert!(a.ip().is_loopback());
        }
    }
}
