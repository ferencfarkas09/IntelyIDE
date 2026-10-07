//! Loopback servers. Every `spawn_*` returns a [`Fake`] that aborts its accept loop when dropped.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bson::{doc, Document};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;

pub struct Fake {
    pub port: u16,
    /// Connections accepted so far.
    pub accepted: Arc<AtomicUsize>,
    task: Option<JoinHandle<()>>,
}

impl Fake {
    pub fn addr(&self) -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], self.port))
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        if let Some(t) = self.task.take() {
            t.abort();
        }
    }
}

async fn bind() -> (TcpListener, u16) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    (l, port)
}

fn serve<F, Fut>(l: TcpListener, port: u16, handler: F) -> Fake
where
    F: Fn(TcpStream) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let accepted = Arc::new(AtomicUsize::new(0));
    let n = accepted.clone();
    let handler = Arc::new(handler);
    let task = tokio::spawn(async move {
        while let Ok((s, _)) = l.accept().await {
            n.fetch_add(1, Ordering::SeqCst);
            let h = handler.clone();
            tokio::spawn(async move { h(s).await });
        }
    });
    Fake { port, accepted, task: Some(task) }
}

/// A TLS server like `mongod --tlsMode requireTLS`: a client that does not start with a TLS record gets a fatal alert and
/// is closed, a handshake failure ends the connection, and a good handshake gets the mini mongod below.
pub async fn spawn_tls(cfg: Arc<ServerConfig>) -> Fake {
    spawn_tls_reacting(cfg, PlainClient::Alert).await
}

/// What a TLS-only server does with a client that does not speak TLS. The TLS stack and the platform decide: a macOS
/// mongod was seen to just close ("unexpected end of file" in the client), OpenSSL builds may send a fatal alert record
/// first (`protocol_version` or `record_overflow`) and then close.
#[derive(Clone, Copy, Debug)]
pub enum PlainClient {
    /// A handshake_failure-like alert record (`15 03 03 00 02 02 46`), then close.
    Alert,
    /// A protocol_version alert in a TLS 1.0 record (`15 03 01 00 02 02 46`), then close.
    ProtocolVersionAlert,
    /// Nothing at all: the socket is closed after the client's first bytes were read.
    Close,
}

pub async fn spawn_tls_reacting(cfg: Arc<ServerConfig>, plain: PlainClient) -> Fake {
    let (l, port) = bind().await;
    let acceptor = TlsAcceptor::from(cfg);
    serve(l, port, move |s| {
        let acceptor = acceptor.clone();
        async move {
            let mut first = [0u8; 1];
            if s.peek(&mut first).await.ok() != Some(1) || first[0] != 0x16 {
                non_tls_client(s, plain).await;
                return;
            }
            if let Ok(t) = acceptor.accept(s).await {
                mini_mongod(t).await;
            }
        }
    })
}

/// What the TLS server does with a client that does not speak TLS: OpenSSL answers a failed handshake with a fatal
/// alert record and closes. Modelled, not observed against a real `mongod` (T14b replaces this with a real corpus).
async fn non_tls_client(mut s: TcpStream, plain: PlainClient) {
    let mut buf = [0u8; 4096];
    let _ = tokio::time::timeout(Duration::from_millis(200), s.read(&mut buf)).await;
    match plain {
        PlainClient::Alert => {
            let _ = s.write_all(&[0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x46]).await;
        }
        PlainClient::ProtocolVersionAlert => {
            let _ = s.write_all(&[0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x46]).await;
        }
        PlainClient::Close => {}
    }
    let _ = s.shutdown().await;
}

/// A server without TLS that speaks the wire protocol (a plain `mongod`). A TLS client gets wire-protocol-shaped bytes in
/// answer to its ClientHello: not a TLS record, so rustls reports a corrupt message.
pub async fn spawn_plain() -> Fake {
    let (l, port) = bind().await;
    serve(l, port, |mut s| async move {
        let mut first = [0u8; 1];
        if s.peek(&mut first).await.ok() == Some(1) && first[0] == 0x16 {
            // a TLS ClientHello is not a wire message: answer with bytes that are not a TLS record either
            let mut buf = [0u8; 4096];
            let _ = tokio::time::timeout(Duration::from_millis(200), s.read(&mut buf)).await;
            let _ = s.write_all(&[0x4d, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]).await;
            let _ = s.shutdown().await;
            return;
        }
        mini_mongod(s).await
    })
}

/// A replica-set member without TLS on a port picked beforehand (see [`closed_port`]): every reply says `setName` and
/// announces `hosts`, so a set can name itself and, for a test, a member that is not on this computer.
pub async fn spawn_member_on(port: u16, set_name: &str, hosts: Vec<String>) -> Fake {
    let l = TcpListener::bind(("127.0.0.1", port)).await.expect("the port picked for the member is still free");
    let extra = doc! { "setName": set_name, "hosts": hosts, "me": format!("127.0.0.1:{port}"), "secondary": false };
    serve(l, port, move |s| {
        let extra = extra.clone();
        async move { mini_mongod_with(s, extra).await }
    })
}

/// A replica-set member whose answer changes while it runs: `hosts` `None` is a member that accepts and says nothing (a seed that is
/// silent during a pre-flight), `Some(list)` is a member that announces `list` in every reply from then on, also on connections
/// that are already open (the driver's monitor keeps one and asks again every heartbeat).
pub async fn spawn_member_dynamic(port: u16, set_name: &str, hosts: Arc<Mutex<Option<Vec<String>>>>) -> Fake {
    let l = TcpListener::bind(("127.0.0.1", port)).await.expect("the port picked for the member is still free");
    let set_name = set_name.to_string();
    serve(l, port, move |s| {
        let (hosts, set_name) = (hosts.clone(), set_name.clone());
        async move {
            let current = move || -> Option<Document> {
                let list = hosts.lock().unwrap().clone()?;
                Some(doc! { "setName": set_name.clone(), "hosts": list, "me": format!("127.0.0.1:{port}"), "secondary": false })
            };
            if current().is_none() {
                let _keep = s;
                tokio::time::sleep(Duration::from_secs(5)).await;
                return;
            }
            mini_mongod_dyn(s, &current).await
        }
    })
}

/// A listener on this computer's LAN address (the interface a route to 10.x would use), never on loopback: a member name that
/// is outside every loopback rule, and a way to see whether anything dialled it. `None` when the computer has no such address.
pub struct Trap {
    /// `host:port` as a replica set would announce it.
    pub addr: String,
    /// Connections it accepted.
    pub hits: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}

impl Drop for Trap {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn spawn_lan_trap() -> Option<Trap> {
    let probe = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    probe.connect("10.255.255.254:9").ok()?;
    let ip = probe.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        return None;
    }
    let l = TcpListener::bind((ip, 0)).await.ok()?;
    let port = l.local_addr().ok()?.port();
    let hits = Arc::new(AtomicUsize::new(0));
    let n = hits.clone();
    let task = tokio::spawn(async move {
        while let Ok((s, _)) = l.accept().await {
            n.fetch_add(1, Ordering::SeqCst);
            drop(s);
        }
    });
    Some(Trap { addr: format!("{ip}:{port}"), hits, task })
}

/// A port nothing listens on any more: connecting is refused.
pub async fn closed_port() -> u16 {
    let (l, port) = bind().await;
    drop(l);
    port
}

/// Accepts and then says nothing, ever.
pub async fn spawn_silent() -> Fake {
    let (l, port) = bind().await;
    serve(l, port, |s| async move {
        let _keep = s;
        tokio::time::sleep(Duration::from_secs(3600)).await;
    })
}

/// Reads the first bytes, then closes with a TCP RST (linger 0).
pub async fn spawn_reset() -> Fake {
    let (l, port) = bind().await;
    serve(l, port, |mut s| async move {
        let mut b = [0u8; 1];
        let _ = s.read(&mut b).await;
        #[allow(deprecated)]
        let _ = s.set_linger(Some(Duration::from_secs(0)));
        drop(s);
    })
}

// ---- the mini mongod --------------------------------------------------------------------------------------------

fn reply_doc(cmd: &str, extra: &Document) -> Document {
    let mut d = doc! {
        "ok": 1.0,
        "ismaster": true,
        "isWritablePrimary": true,
        "helloOk": true,
        "maxBsonObjectSize": 16_777_216,
        "maxMessageSizeBytes": 48_000_000,
        "maxWriteBatchSize": 100_000,
        "minWireVersion": 0,
        "maxWireVersion": 21,
        "readOnly": false,
        "version": "7.0.0",
    };
    if cmd.eq_ignore_ascii_case("connectionStatus") {
        d.insert("authInfo", doc! { "authenticatedUsers": [], "authenticatedUserRoles": [], "authenticatedUserPrivileges": [] });
    }
    // what a replica-set member adds to every handshake and `hello` (`setName`, `hosts`, ...)
    for (k, v) in extra {
        d.insert(k.clone(), v.clone());
    }
    d
}

fn to_bytes(d: &Document) -> Vec<u8> {
    let mut v = Vec::new();
    d.to_writer(&mut v).unwrap();
    v
}

fn header(len: usize, req: i32, resp_to: i32, op: i32) -> Vec<u8> {
    let mut h = Vec::with_capacity(16);
    h.extend((len as i32).to_le_bytes());
    h.extend(req.to_le_bytes());
    h.extend(resp_to.to_le_bytes());
    h.extend(op.to_le_bytes());
    h
}

/// Answers every command with a primary-ish reply. Handles OP_MSG (2013) and the legacy OP_QUERY handshake (2004).
pub async fn mini_mongod<S: AsyncRead + AsyncWrite + Unpin>(s: S) {
    mini_mongod_with(s, Document::new()).await
}

/// [`mini_mongod`] whose replies also carry the fields of `extra` (a replica-set member's `setName` and `hosts`).
pub async fn mini_mongod_with<S: AsyncRead + AsyncWrite + Unpin>(s: S, extra: Document) {
    mini_mongod_dyn(s, &|| Some(extra.clone())).await
}

/// [`mini_mongod_with`] whose extra fields are asked again for every reply; `None` ends the connection without an answer.
pub async fn mini_mongod_dyn<S: AsyncRead + AsyncWrite + Unpin>(mut s: S, current: &(dyn Fn() -> Option<Document> + Sync)) {
    let mut next_id = 1i32;
    loop {
        let mut h = [0u8; 16];
        if s.read_exact(&mut h).await.is_err() {
            return;
        }
        let len = i32::from_le_bytes(h[0..4].try_into().unwrap()) as usize;
        let req = i32::from_le_bytes(h[4..8].try_into().unwrap());
        let op = i32::from_le_bytes(h[12..16].try_into().unwrap());
        if !(16..=48_000_000).contains(&len) {
            return;
        }
        let mut body = vec![0u8; len - 16];
        if s.read_exact(&mut body).await.is_err() {
            return;
        }
        next_id += 1;
        let Some(extra) = current() else { return };
        let out = match op {
            2013 => {
                // flagBits u32, then sections; kind 0 = one document
                if body.len() < 5 || body[4] != 0 {
                    return;
                }
                let Ok(cmd) = Document::from_reader(&mut &body[5..]) else { return };
                let name = cmd.keys().next().cloned().unwrap_or_default();
                let b = to_bytes(&reply_doc(&name, &extra));
                let mut m = header(16 + 4 + 1 + b.len(), next_id, req, 2013);
                m.extend(0u32.to_le_bytes());
                m.push(0);
                m.extend(b);
                m
            }
            2004 => {
                // flags i32, cstring ns, skip i32, return i32, query doc
                let Some(z) = body[4..].iter().position(|b| *b == 0) else { return };
                let at = 4 + z + 1 + 8;
                let Ok(cmd) = Document::from_reader(&mut &body[at..]) else { return };
                let name = cmd.keys().next().cloned().unwrap_or_default();
                let b = to_bytes(&reply_doc(&name, &extra));
                let mut m = header(16 + 20 + b.len(), next_id, req, 1);
                m.extend(8i32.to_le_bytes()); // AwaitCapable
                m.extend(0i64.to_le_bytes());
                m.extend(0i32.to_le_bytes());
                m.extend(1i32.to_le_bytes());
                m.extend(b);
                m
            }
            _ => return,
        };
        if s.write_all(&out).await.is_err() {
            return;
        }
    }
}
