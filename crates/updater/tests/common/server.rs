//! Loopback HTTP/1.1 server for the `net` and `engine` tests ((design notes: updater-spec) 10.1).
//!
//! Hand-rolled on `std::net` and plain threads (no async runtime of its own, so it works beside
//! any `#[tokio::test]`). Routes are registered per test; every request is recorded with its
//! headers so a test can assert the exact header set and that no cookie, referer or
//! authorisation is ever sent. One response per connection (`Connection: close`).
//!
//! Behaviours: `status(code)`, `redirect(code, location)`, `truncate_after(n)`,
//! `claim_length(n)` (a lying Content-Length), `stall_after(n)`, `slow(bytes_per_s)`,
//! `huge_header()`, `body(bytes)`, `zeros(n)` (a streamed body of `n` zero bytes without
//! allocating it), `chunked()`, `close_delimited()`, `never_respond()`.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// One recorded request.
#[derive(Clone, Debug)]
pub struct Req {
    pub method: String,
    /// Request target as sent, query included.
    pub target: String,
    /// Header names lowercased, in the order received.
    pub headers: Vec<(String, String)>,
}

impl Req {
    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or("")
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers.iter().find(|(k, _)| *k == name).map(|(_, v)| v.as_str())
    }

    pub fn header_names(&self) -> Vec<String> {
        let mut v: Vec<String> = self.headers.iter().map(|(k, _)| k.clone()).collect();
        v.sort();
        v
    }
}

#[derive(Clone, Debug)]
pub enum Body {
    Bytes(Vec<u8>),
    /// `n` zero bytes, written in 64 KiB pieces (never held in memory).
    Zeros(u64),
}

impl Body {
    fn len(&self) -> u64 {
        match self {
            Body::Bytes(b) => b.len() as u64,
            Body::Zeros(n) => *n,
        }
    }
}

#[derive(Clone, Debug)]
pub enum Length {
    /// Content-Length = the real body length.
    Exact,
    /// Content-Length = this number, whatever is really sent.
    Claim(u64),
    Chunked,
    /// No length at all; the body ends when the connection closes.
    CloseDelimited,
}

#[derive(Clone, Debug)]
pub enum Mode {
    Normal,
    /// Send only the first `n` body bytes, then close the connection.
    CloseAfter(u64),
    /// Send `n` body bytes, then go silent without closing.
    StallAfter(u64),
    /// Send the body at this many bytes per second.
    Slow(u64),
    /// Read the request, then never answer.
    NeverRespond,
}

#[derive(Clone, Debug)]
pub struct Route {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Body,
    pub length: Length,
    pub mode: Mode,
}

impl Route {
    pub fn status(code: u16) -> Route {
        Route { status: code, headers: Vec::new(), body: Body::Bytes(Vec::new()), length: Length::Exact, mode: Mode::Normal }
    }

    pub fn body(bytes: impl Into<Vec<u8>>) -> Route {
        Route { body: Body::Bytes(bytes.into()), ..Route::status(200) }
    }

    pub fn zeros(n: u64) -> Route {
        Route { body: Body::Zeros(n), ..Route::status(200) }
    }

    pub fn redirect(code: u16, location: &str) -> Route {
        Route::status(code).header("Location", location)
    }

    pub fn header(mut self, k: &str, v: &str) -> Route {
        self.headers.push((k.to_string(), v.to_string()));
        self
    }

    pub fn truncate_after(mut self, n: u64) -> Route {
        self.mode = Mode::CloseAfter(n);
        self
    }

    pub fn claim_length(mut self, n: u64) -> Route {
        self.length = Length::Claim(n);
        self
    }

    pub fn stall_after(mut self, n: u64) -> Route {
        self.mode = Mode::StallAfter(n);
        self
    }

    pub fn slow(mut self, bytes_per_s: u64) -> Route {
        self.mode = Mode::Slow(bytes_per_s);
        self
    }

    pub fn chunked(mut self) -> Route {
        self.length = Length::Chunked;
        self
    }

    pub fn close_delimited(mut self) -> Route {
        self.length = Length::CloseDelimited;
        self
    }

    pub fn never_respond(mut self) -> Route {
        self.mode = Mode::NeverRespond;
        self
    }

    /// A single 70 KiB header (the header block is above the 64 KiB cap of the client).
    pub fn huge_header(self) -> Route {
        self.header("X-Pad", &"a".repeat(70 * 1024))
    }
}

struct Shared {
    routes: Mutex<HashMap<String, Route>>,
    requests: Mutex<Vec<Req>>,
    stop: AtomicBool,
}

pub struct Server {
    pub addr: SocketAddr,
    shared: Arc<Shared>,
}

impl Server {
    pub fn start() -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().unwrap();
        let shared = Arc::new(Shared { routes: Mutex::new(HashMap::new()), requests: Mutex::new(Vec::new()), stop: AtomicBool::new(false) });
        let acc = shared.clone();
        thread::spawn(move || {
            for conn in listener.incoming() {
                if acc.stop.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = conn else { continue };
                let sh = acc.clone();
                thread::spawn(move || serve(stream, sh));
            }
        });
        Server { addr, shared }
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    /// `http://127.0.0.1:<port>`, the exact form `Endpoints::loopback` accepts.
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.addr.port())
    }

    pub fn route(&self, path: &str, route: Route) {
        self.shared.routes.lock().unwrap().insert(path.to_string(), route);
    }

    pub fn requests(&self) -> Vec<Req> {
        self.shared.requests.lock().unwrap().clone()
    }

    /// Number of requests whose path (query stripped) equals `path`.
    pub fn count(&self, path: &str) -> usize {
        self.requests().iter().filter(|r| r.path() == path).count()
    }

    pub fn total(&self) -> usize {
        self.shared.requests.lock().unwrap().len()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        // Wake the accept loop.
        let _ = TcpStream::connect(self.addr);
    }
}

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        304 => "Not Modified",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        404 => "Not Found",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

fn read_head(stream: &mut TcpStream) -> Option<Req> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 64 * 1024 {
            return None;
        }
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let mut lines = text.split("\r\n");
    let first = lines.next()?;
    let mut parts = first.split(' ');
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let mut headers = Vec::new();
    for l in lines {
        if l.is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    Some(Req { method, target, headers })
}

/// Block until the peer closes or the server stops (used by the stall behaviours).
fn wait_for_close(stream: &mut TcpStream, shared: &Shared) {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
    let mut b = [0u8; 64];
    while !shared.stop.load(Ordering::SeqCst) {
        match stream.read(&mut b) {
            Ok(0) => return,
            Ok(_) => {}
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(_) => return,
        }
    }
}

fn serve(mut stream: TcpStream, shared: Arc<Shared>) {
    let Some(req) = read_head(&mut stream) else { return };
    let route = shared.routes.lock().unwrap().get(req.path()).cloned();
    shared.requests.lock().unwrap().push(req);
    let route = route.unwrap_or_else(|| Route::status(404));
    if matches!(route.mode, Mode::NeverRespond) {
        wait_for_close(&mut stream, &shared);
        return;
    }

    let total = route.body.len();
    let mut head = format!("HTTP/1.1 {} {}\r\n", route.status, reason(route.status));
    for (k, v) in &route.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    match &route.length {
        Length::Exact => head.push_str(&format!("Content-Length: {total}\r\n")),
        Length::Claim(n) => head.push_str(&format!("Content-Length: {n}\r\n")),
        Length::Chunked => head.push_str("Transfer-Encoding: chunked\r\n"),
        Length::CloseDelimited => {}
    }
    head.push_str("Connection: close\r\n\r\n");
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }

    let limit = match route.mode {
        Mode::CloseAfter(n) | Mode::StallAfter(n) => n.min(total),
        _ => total,
    };
    let slow = if let Mode::Slow(bps) = route.mode { Some(bps.max(1)) } else { None };
    let chunked = matches!(route.length, Length::Chunked);
    let piece_max: usize = if slow.is_some() { 1024 } else { 64 * 1024 };

    let zeros = vec![0u8; 64 * 1024];
    let mut sent: u64 = 0;
    while sent < limit {
        if shared.stop.load(Ordering::SeqCst) {
            return;
        }
        let want = ((limit - sent) as usize).min(piece_max);
        let piece: &[u8] = match &route.body {
            Body::Bytes(b) => &b[sent as usize..sent as usize + want],
            Body::Zeros(_) => &zeros[..want],
        };
        let ok = if chunked {
            stream.write_all(format!("{:x}\r\n", piece.len()).as_bytes()).is_ok()
                && stream.write_all(piece).is_ok()
                && stream.write_all(b"\r\n").is_ok()
        } else {
            stream.write_all(piece).is_ok()
        };
        if !ok {
            return;
        }
        sent += want as u64;
        if let Some(bps) = slow {
            thread::sleep(Duration::from_secs_f64(want as f64 / bps as f64));
        }
    }
    let _ = stream.flush();
    match route.mode {
        Mode::StallAfter(_) => wait_for_close(&mut stream, &shared),
        Mode::CloseAfter(_) => {
            // No terminating chunk, no further bytes: a cut connection.
            let _ = stream.shutdown(Shutdown::Both);
        }
        _ => {
            if chunked {
                let _ = stream.write_all(b"0\r\n\r\n");
            }
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}
