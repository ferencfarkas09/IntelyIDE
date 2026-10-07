//! Loopback reverse proxy for the embedded preview ((design notes: preview-plan) A3, rungs 2 and 3).
//!
//! * binds `127.0.0.1` on a random port; one proxy per dev server; forwards only to a loopback upstream whose port the
//!   caller listed (`allowed_ports`, a consistency check: the Tauri command lists just the one port the user typed, which
//!   passed the loopback URL gate; only the E2E jail narrows it to servers the Run panel started);
//! * checks `Host` (DNS-rebinding guard) and `Origin` (loopback only) on every request;
//! * injects `<script src="/__intely/inspect.js">` into `text/html` responses; the script itself is served by the proxy;
//! * passes SSE (`/__webpack_hmr`) and WebSocket traffic through untouched, streaming;
//! * strips frame-blocking headers, relays redirects only when they stay on the upstream;
//! * logs nothing: no headers, no bodies, no cookies.
//!
//! One request per connection (`Connection: close` both ways): simple and robust on loopback.

mod http;
pub mod harness;
pub mod jail;

use http::*;
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinHandle;
use tokio::time::timeout;

pub use http::{INSPECTOR_PATH, SCRIPT_TAG};

/// The page-side inspector (also unit-tested from node, `ui/src/modules/preview-inspect`).
pub const INSPECTOR_JS: &str = include_str!("../assets/inspector.js");

const REQ_HEAD_TIMEOUT: Duration = Duration::from_secs(15);
/// A cold webpack compile can hold the first response for a long time.
const RESP_HEAD_TIMEOUT: Duration = Duration::from_secs(180);
const BODY_READ_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONNECTIONS: usize = 128;

#[derive(Debug)]
pub enum ProxyError {
    UpstreamNotLoopback,
    PortNotAllowed(u16),
    Bind(io::Error),
}

impl std::fmt::Display for ProxyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProxyError::UpstreamNotLoopback => write!(f, "the preview proxy only forwards to loopback"),
            ProxyError::PortNotAllowed(p) => write!(f, "port {p} is not a dev server the IDE started or attached"),
            ProxyError::Bind(e) => write!(f, "cannot bind the preview proxy: {e}"),
        }
    }
}

impl std::error::Error for ProxyError {}

#[derive(Debug, Clone)]
pub struct ProxyConfig {
    /// The dev server (loopback address and port).
    pub upstream: SocketAddr,
    /// Ports the proxy may forward to; `upstream.port()` must be listed. The caller decides what is allowed (the Tauri
    /// command passes the single, URL-gated port; in the E2E jail it first checks the port belongs to a Run-panel server).
    pub allowed_ports: Vec<u16>,
    /// Inject the inspector into HTML (the Preview setting "proxy on/off" still keeps the other protections).
    pub inject: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    pub requests: u64,
    pub injected: u64,
    pub blocked: u64,
    pub upgrades: u64,
}

#[derive(Default)]
struct Counters {
    requests: AtomicU64,
    injected: AtomicU64,
    blocked: AtomicU64,
    upgrades: AtomicU64,
}

struct Ctx {
    upstream: SocketAddr,
    upstream_host: String,
    port: u16,
    inject: bool,
    counters: Counters,
}

pub struct Proxy {
    port: u16,
    ctx: Arc<Ctx>,
    shutdown: watch::Sender<bool>,
    accept: JoinHandle<()>,
}

impl Proxy {
    /// Must be called inside a tokio runtime.
    pub async fn start(cfg: ProxyConfig) -> Result<Proxy, ProxyError> {
        if !cfg.upstream.ip().is_loopback() {
            return Err(ProxyError::UpstreamNotLoopback);
        }
        if !cfg.allowed_ports.contains(&cfg.upstream.port()) {
            return Err(ProxyError::PortNotAllowed(cfg.upstream.port()));
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(ProxyError::Bind)?;
        let port = listener.local_addr().map_err(ProxyError::Bind)?.port();
        let upstream_host = if cfg.upstream.is_ipv6() { "[::1]".to_string() } else { "127.0.0.1".to_string() };
        let ctx = Arc::new(Ctx { upstream: cfg.upstream, upstream_host, port, inject: cfg.inject, counters: Counters::default() });
        let (shutdown, rx) = watch::channel(false);
        let accept = tokio::spawn(accept_loop(listener, ctx.clone(), rx));
        Ok(Proxy { port, ctx, shutdown, accept })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// What the preview frame loads.
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port)
    }

    pub fn stats(&self) -> Stats {
        let c = &self.ctx.counters;
        Stats { requests: c.requests.load(Ordering::Relaxed), injected: c.injected.load(Ordering::Relaxed), blocked: c.blocked.load(Ordering::Relaxed), upgrades: c.upgrades.load(Ordering::Relaxed) }
    }

    /// Closes the listener and every open connection.
    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
        self.accept.abort();
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn accept_loop(listener: TcpListener, ctx: Arc<Ctx>, mut shutdown: watch::Receiver<bool>) {
    let limit = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        tokio::select! {
            _ = shutdown.changed() => return,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let Ok(permit) = limit.clone().try_acquire_owned() else { continue };
                let _ = stream.set_nodelay(true);
                let ctx = ctx.clone();
                let mut sd = shutdown.clone();
                tokio::spawn(async move {
                    tokio::select! {
                        _ = serve(stream, &ctx) => {}
                        _ = sd.changed() => {}
                    }
                    drop(permit);
                });
            }
        }
    }
}

/// Reads until a whole head is buffered; returns its length (`None` on a clean EOF before any byte).
async fn read_head(r: &mut OwnedReadHalf, buf: &mut Vec<u8>) -> io::Result<Option<usize>> {
    let mut tmp = [0u8; 8192];
    loop {
        if let Some(end) = head_end(buf) {
            if end > MAX_HEAD {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "head too large"));
            }
            return Ok(Some(end));
        }
        if buf.len() > MAX_HEAD {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "head too large"));
        }
        let n = r.read(&mut tmp).await?;
        if n == 0 {
            return if buf.is_empty() { Ok(None) } else { Err(io::ErrorKind::UnexpectedEof.into()) };
        }
        buf.extend_from_slice(&tmp[..n]);
    }
}

async fn refuse(cw: &mut OwnedWriteHalf, ctx: &Ctx, status: u16, reason: &str, text: &str) -> io::Result<()> {
    ctx.counters.blocked.fetch_add(1, Ordering::Relaxed);
    cw.write_all(&simple_response(status, reason, "text/plain; charset=utf-8", text.as_bytes())).await?;
    cw.shutdown().await
}

async fn serve(client: TcpStream, ctx: &Ctx) -> io::Result<()> {
    let (mut cr, mut cw) = client.into_split();
    let mut buf = Vec::new();
    let end = match timeout(REQ_HEAD_TIMEOUT, read_head(&mut cr, &mut buf)).await {
        Ok(Ok(Some(n))) => n,
        Ok(Ok(None)) => return Ok(()),
        _ => return refuse(&mut cw, ctx, 400, "Bad Request", "bad request").await,
    };
    let Some(req) = parse_request(&buf[..end]) else { return refuse(&mut cw, ctx, 400, "Bad Request", "bad request").await };
    ctx.counters.requests.fetch_add(1, Ordering::Relaxed);

    if !host_allowed(header_str(&req.headers, "host"), ctx.port) {
        return refuse(&mut cw, ctx, 421, "Misdirected Request", "this proxy only answers to its own loopback address").await;
    }
    if header(&req.headers, "origin").is_some_and(|o| !origin_allowed(&String::from_utf8_lossy(o))) {
        return refuse(&mut cw, ctx, 403, "Forbidden", "origin not allowed").await;
    }

    let path = req.target.split(['?', '#']).next().unwrap_or("");
    if path == INSPECTOR_PATH {
        let body: &[u8] = if req.method == "HEAD" { b"" } else { INSPECTOR_JS.as_bytes() };
        let out = simple_response(200, "OK", "text/javascript; charset=utf-8", body);
        cw.write_all(&out).await?;
        return cw.shutdown().await;
    }

    let up = match timeout(CONNECT_TIMEOUT, TcpStream::connect(ctx.upstream)).await {
        Ok(Ok(s)) => s,
        _ => return refuse(&mut cw, ctx, 502, "Bad Gateway", "the dev server is not reachable").await,
    };
    let _ = up.set_nodelay(true);
    let (mut ur, mut uw) = up.into_split();

    let upgrade = is_upgrade(&req.headers);
    let headers = upstream_request_headers(&req.headers, ctx.port, &ctx.upstream_host, ctx.upstream.port());
    uw.write_all(&serialize_request(&req.method, &req.target, &headers)).await?;
    uw.write_all(&buf[end..]).await?;
    // The rest of the request (body, or a websocket's frames). The write half stays alive in the join handle: an early
    // EOF from the client must not half-close the upstream before it has answered.
    let mut pump = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut cr, &mut uw).await;
        uw
    });

    let mut ubuf = Vec::new();
    let hend = match timeout(RESP_HEAD_TIMEOUT, read_head(&mut ur, &mut ubuf)).await {
        Ok(Ok(Some(n))) => n,
        _ => return refuse(&mut cw, ctx, 502, "Bad Gateway", "bad response from the dev server").await,
    };
    let Some(resp) = parse_response(&ubuf[..hend]) else { return refuse(&mut cw, ctx, 502, "Bad Gateway", "bad response from the dev server").await };

    if upgrade && resp.status == 101 {
        ctx.counters.upgrades.fetch_add(1, Ordering::Relaxed);
        cw.write_all(&ubuf).await?; // head and any early frame bytes, verbatim
        tokio::select! {
            _ = tokio::io::copy(&mut ur, &mut cw) => {}
            _ = &mut pump => {}
        }
        let _ = cw.shutdown().await;
        pump.abort();
        return Ok(());
    }

    let result = relay(&mut ur, &mut cw, ctx, &req, &resp, &ubuf[hend..]).await;
    pump.abort();
    let _ = cw.shutdown().await;
    result
}

async fn relay(ur: &mut OwnedReadHalf, cw: &mut OwnedWriteHalf, ctx: &Ctx, req: &ReqHead, resp: &RespHead, early: &[u8]) -> io::Result<()> {
    let status = resp.status;
    let no_body = req.method == "HEAD" || (100..200).contains(&status) || status == 204 || status == 304;

    let mut location = None;
    if (300..400).contains(&status) {
        if let Some(l) = header_str(&resp.headers, "location") {
            match rewrite_location(l, ctx.upstream.port(), ctx.port) {
                Location::Keep => {}
                Location::Rewrite(s) => location = Some(s),
                Location::Block => return refuse(cw, ctx, 403, "Forbidden", "a redirect to a host outside the dev server was blocked").await,
            }
        }
    }

    let content_type = header_str(&resp.headers, "content-type").unwrap_or("").to_ascii_lowercase();
    let encoded = header_str(&resp.headers, "content-encoding").is_some_and(|e| !e.eq_ignore_ascii_case("identity"));
    let chunked = header_str(&resp.headers, "transfer-encoding").is_some_and(|t| t.to_ascii_lowercase().contains("chunked"));
    let length = header_str(&resp.headers, "content-length").and_then(|l| l.parse::<usize>().ok());

    if ctx.inject && !no_body && content_type.starts_with("text/html") && !encoded {
        let mut body = early.to_vec();
        let mut tmp = [0u8; 16 * 1024];
        let html = loop {
            if chunked {
                match dechunk(&body) {
                    Dechunk::Complete(b) => break b,
                    Dechunk::Invalid => return refuse(cw, ctx, 502, "Bad Gateway", "bad response from the dev server").await,
                    Dechunk::Incomplete => {}
                }
            } else if let Some(n) = length {
                if body.len() >= n {
                    body.truncate(n);
                    break body;
                }
            }
            if body.len() > MAX_HTML {
                return refuse(cw, ctx, 502, "Bad Gateway", "page too large to inspect").await;
            }
            let n = match timeout(BODY_READ_TIMEOUT, ur.read(&mut tmp)).await {
                Ok(Ok(n)) => n,
                _ => return refuse(cw, ctx, 502, "Bad Gateway", "bad response from the dev server").await,
            };
            if n == 0 {
                if chunked || length.is_some() {
                    return refuse(cw, ctx, 502, "Bad Gateway", "truncated response from the dev server").await;
                }
                break body; // EOF-delimited
            }
            body.extend_from_slice(&tmp[..n]);
        };
        let out = inject_script(&html, SCRIPT_TAG);
        ctx.counters.injected.fetch_add(1, Ordering::Relaxed);
        let head = serialize_status(status, &resp.reason, &client_response_headers(&resp.headers, Some(out.len()), location));
        cw.write_all(&head).await?;
        return cw.write_all(&out).await;
    }

    let head = serialize_status(status, &resp.reason, &client_response_headers(&resp.headers, None, location));
    cw.write_all(&head).await?;
    if no_body {
        return Ok(());
    }
    match (chunked, length) {
        (false, Some(n)) => {
            let early = &early[..early.len().min(n)];
            cw.write_all(early).await?;
            tokio::io::copy(&mut ur.take((n - early.len()) as u64), cw).await.map(|_| ())
        }
        _ => {
            cw.write_all(early).await?;
            tokio::io::copy(ur, cw).await.map(|_| ())
        }
    }
}
