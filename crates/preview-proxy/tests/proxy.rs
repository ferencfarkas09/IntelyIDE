//! End to end through real loopback sockets against a scripted fake dev server. No real repo, no real server.

use intely_preview_proxy::{Proxy, ProxyConfig, ProxyError, INSPECTOR_PATH};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::time::timeout;

const HTML: &str = "<!doctype html><html><head><title>t</title></head><body><div id=root></div></body></html>";

struct Fake {
    addr: SocketAddr,
    hits: Arc<AtomicUsize>,
    release_second_event: Arc<Notify>,
}

async fn read_head(s: &mut TcpStream) -> (String, Vec<u8>) {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf.split_off(p + 4);
            return (String::from_utf8_lossy(&buf).into_owned(), rest);
        }
        let n = s.read(&mut tmp).await.unwrap();
        if n == 0 {
            return (String::from_utf8_lossy(&buf).into_owned(), Vec::new());
        }
        buf.extend_from_slice(&tmp[..n]);
    }
}

async fn fake_upstream() -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(Notify::new());
    let (h2, r2) = (hits.clone(), release.clone());
    tokio::spawn(async move {
        loop {
            let (mut s, _) = listener.accept().await.unwrap();
            let (hits, release) = (h2.clone(), r2.clone());
            tokio::spawn(async move {
                let (head, rest) = read_head(&mut s).await;
                if head.is_empty() {
                    return;
                }
                hits.fetch_add(1, Ordering::SeqCst);
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let lower = head.to_ascii_lowercase();
                let ok = |ct: &str, extra: &str, body: &[u8]| {
                    let mut v = format!("HTTP/1.1 200 OK\r\nContent-Type: {ct}\r\nContent-Length: {}\r\n{extra}\r\n", body.len()).into_bytes();
                    v.extend_from_slice(body);
                    v
                };
                match path.as_str() {
                    "/" => s.write_all(&ok("text/html; charset=utf-8", "X-Frame-Options: DENY\r\nContent-Security-Policy: frame-ancestors 'none'\r\n", HTML.as_bytes())).await.unwrap(),
                    "/chunked" => {
                        let (a, b) = HTML.split_at(30);
                        let msg = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{a}\r\n{:x}\r\n{b}\r\n0\r\n\r\n", a.len(), b.len());
                        s.write_all(msg.as_bytes()).await.unwrap();
                    }
                    "/gz" => s.write_all(&ok("text/html", "Content-Encoding: gzip\r\n", &[0x1f, 0x8b, 8, 0, 1, 2, 3])).await.unwrap(),
                    "/events" => {
                        s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\r\ndata: one\n\n").await.unwrap();
                        release.notified().await;
                        s.write_all(b"data: two\n\n").await.unwrap();
                    }
                    "/ws" => {
                        assert!(lower.contains("upgrade: websocket"), "{head}");
                        s.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n").await.unwrap();
                        let mut b = [0u8; 256];
                        loop {
                            let n = s.read(&mut b).await.unwrap_or(0);
                            if n == 0 {
                                break;
                            }
                            let up: Vec<u8> = b[..n].iter().map(|c| c.to_ascii_uppercase()).collect();
                            s.write_all(&up).await.unwrap();
                        }
                    }
                    "/redirect-out" => s.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://evil.example/login\r\nContent-Length: 0\r\n\r\n").await.unwrap(),
                    "/redirect-in" => {
                        let port = lower.split("host: 127.0.0.1:").nth(1).and_then(|r| r.split("\r\n").next()).unwrap_or("0").to_string();
                        s.write_all(format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/next?x=1\r\nContent-Length: 0\r\n\r\n").as_bytes()).await.unwrap();
                    }
                    "/big" => {
                        let body: Vec<u8> = (0..1_048_576u32).map(|i| (i % 251) as u8).collect();
                        s.write_all(&ok("application/octet-stream", "", &body)).await.unwrap();
                    }
                    "/echo-headers" => s.write_all(&ok("text/plain", "", head.as_bytes())).await.unwrap(),
                    "/post" => {
                        let want: usize = lower.split("content-length: ").nth(1).and_then(|r| r.split("\r\n").next()).and_then(|n| n.parse().ok()).unwrap_or(0);
                        let mut body = rest;
                        while body.len() < want {
                            let mut b = [0u8; 1024];
                            let n = s.read(&mut b).await.unwrap();
                            body.extend_from_slice(&b[..n]);
                        }
                        s.write_all(&ok("text/plain", "", &body)).await.unwrap();
                    }
                    _ => s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nno").await.unwrap(),
                }
                let _ = s.shutdown().await;
            });
        }
    });
    Fake { addr, hits, release_second_event: release }
}

async fn start(fake: &Fake) -> Proxy {
    Proxy::start(ProxyConfig { upstream: fake.addr, allowed_ports: vec![fake.addr.port()], inject: true }).await.unwrap()
}

struct Reply {
    status: u16,
    head: String,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().skip(1).find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_string()))
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

async fn send(port: u16, method: &str, path: &str, extra: &str, body: &[u8], host: Option<&str>) -> Reply {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let host_line = match host {
        Some(h) => format!("Host: {h}\r\n"),
        None => format!("Host: 127.0.0.1:{port}\r\n"),
    };
    let len = if body.is_empty() { String::new() } else { format!("Content-Length: {}\r\n", body.len()) };
    s.write_all(format!("{method} {path} HTTP/1.1\r\n{host_line}Accept-Encoding: gzip\r\n{len}{extra}\r\n").as_bytes()).await.unwrap();
    s.write_all(body).await.unwrap();
    let mut raw = Vec::new();
    timeout(Duration::from_secs(10), s.read_to_end(&mut raw)).await.expect("response timed out").unwrap();
    let p = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("no head") + 4;
    let head = String::from_utf8_lossy(&raw[..p]).into_owned();
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    Reply { status, head, body: raw[p..].to_vec() }
}

#[tokio::test]
async fn html_gets_the_inspector_and_loses_frame_blocking_headers() {
    let fake = fake_upstream().await;
    let proxy = start(&fake).await;
    let r = send(proxy.port(), "GET", "/", "", b"", None).await;
    assert_eq!(r.status, 200);
    let text = r.text();
    assert!(text.contains(&format!("<head><script src=\"{INSPECTOR_PATH}\" data-intely=\"1\"></script><title>")), "{text}");
    assert_eq!(r.header("content-length").unwrap().parse::<usize>().unwrap(), r.body.len());
    assert!(r.header("x-frame-options").is_none());
    assert!(r.header("content-security-policy").is_none(), "frame-ancestors was the only directive");
    assert_eq!(r.header("connection").as_deref(), Some("close"));
    assert_eq!(proxy.stats().injected, 1);
}

#[tokio::test]
async fn chunked_html_is_decoded_and_injected() {
    let fake = fake_upstream().await;
    let proxy = start(&fake).await;
    let r = send(proxy.port(), "GET", "/chunked", "", b"", None).await;
    assert_eq!(r.status, 200);
    assert!(r.text().contains("data-intely"));
    assert!(r.text().ends_with("</html>"));
    assert!(r.header("transfer-encoding").is_none());
}

#[tokio::test]
async fn compressed_html_is_passed_through_untouched() {
    let fake = fake_upstream().await;
    let proxy = start(&fake).await;
    let r = send(proxy.port(), "GET", "/gz", "", b"", None).await;
    assert_eq!(r.body, vec![0x1f, 0x8b, 8, 0, 1, 2, 3]);
    assert_eq!(r.header("content-encoding").as_deref(), Some("gzip"));
    assert_eq!(proxy.stats().injected, 0);
}

#[tokio::test]
async fn the_inspector_script_is_served_by_the_proxy_not_the_upstream() {
    let fake = fake_upstream().await;
    let proxy = start(&fake).await;
    let r = send(proxy.port(), "GET", INSPECTOR_PATH, "", b"", None).await;
    assert_eq!(r.status, 200);
    assert!(r.header("content-type").unwrap().starts_with("text/javascript"));
    assert!(r.text().contains("inspect/1"));
    assert_eq!(fake.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn upstream_sees_itself_and_identity_encoding() {
    let fake = fake_upstream().await;
    let proxy = start(&fake).await;
    let port = proxy.port();
    let r = send(port, "GET", "/echo-headers", &format!("Origin: http://127.0.0.1:{port}\r\nReferer: http://127.0.0.1:{port}/a\r\nCookie: s=1\r\n"), b"", None).await;
    let up = fake.addr.port();
    let t = r.text().to_ascii_lowercase();
    assert!(t.contains(&format!("host: 127.0.0.1:{up}")), "{t}");
    assert!(t.contains("accept-encoding: identity"), "{t}");
    assert!(t.contains(&format!("origin: http://127.0.0.1:{up}")), "{t}");
    assert!(t.contains(&format!("referer: http://127.0.0.1:{up}/a")), "{t}");
    assert!(t.contains("cookie: s=1"));
    assert!(t.contains("connection: close"));
}

#[tokio::test]
async fn binary_bodies_and_request_bodies_pass_through_exactly() {
    let fake = fake_upstream().await;
    let proxy = start(&fake).await;
    let big = send(proxy.port(), "GET", "/big", "", b"", None).await;
    let expect: Vec<u8> = (0..1_048_576u32).map(|i| (i % 251) as u8).collect();
    assert_eq!(big.body, expect);
    let post = send(proxy.port(), "POST", "/post", "", b"hello=world&x=1", None).await;
    assert_eq!(post.text(), "hello=world&x=1");
    let head = send(proxy.port(), "HEAD", "/big", "", b"", None).await;
    assert!(head.body.is_empty());
    let missing = send(proxy.port(), "GET", "/nope", "", b"", None).await;
    assert_eq!((missing.status, missing.text().as_str()), (404, "no"));
}

#[tokio::test]
async fn server_sent_events_stream_without_buffering() {
    let fake = fake_upstream().await;
    let proxy = start(&fake).await;
    let mut s = TcpStream::connect(("127.0.0.1", proxy.port())).await.unwrap();
    s.write_all(format!("GET /events HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept: text/event-stream\r\n\r\n", proxy.port()).as_bytes()).await.unwrap();
    let mut got = Vec::new();
    let mut tmp = [0u8; 1024];
    // the first event must arrive while the upstream is still holding the second back
    while !String::from_utf8_lossy(&got).contains("data: one") {
        let n = timeout(Duration::from_secs(5), s.read(&mut tmp)).await.expect("first event was buffered").unwrap();
        assert!(n > 0, "closed early");
        got.extend_from_slice(&tmp[..n]);
    }
    assert!(String::from_utf8_lossy(&got).to_ascii_lowercase().contains("text/event-stream"));
    assert!(!String::from_utf8_lossy(&got).contains("data: two"));
    fake.release_second_event.notify_one();
    while !String::from_utf8_lossy(&got).contains("data: two") {
        let n = timeout(Duration::from_secs(5), s.read(&mut tmp)).await.expect("second event lost").unwrap();
        assert!(n > 0);
        got.extend_from_slice(&tmp[..n]);
    }
}

#[tokio::test]
async fn websocket_upgrades_tunnel_both_ways() {
    let fake = fake_upstream().await;
    let proxy = start(&fake).await;
    let mut s = TcpStream::connect(("127.0.0.1", proxy.port())).await.unwrap();
    let port = proxy.port();
    s.write_all(format!("GET /ws HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\nOrigin: http://localhost:{port}\r\n\r\n").as_bytes()).await.unwrap();
    let (head, _) = timeout(Duration::from_secs(5), read_head(&mut s)).await.unwrap();
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    assert!(head.to_ascii_lowercase().contains("upgrade: websocket"));
    s.write_all(b"ping frame").await.unwrap();
    let mut b = [0u8; 64];
    let n = timeout(Duration::from_secs(5), s.read(&mut b)).await.unwrap().unwrap();
    assert_eq!(&b[..n], b"PING FRAME");
    s.write_all(b"again").await.unwrap();
    let n = timeout(Duration::from_secs(5), s.read(&mut b)).await.unwrap().unwrap();
    assert_eq!(&b[..n], b"AGAIN");
    assert_eq!(proxy.stats().upgrades, 1);
}

#[tokio::test]
async fn redirects_off_the_upstream_are_blocked_and_own_ones_rewritten() {
    let fake = fake_upstream().await;
    let proxy = start(&fake).await;
    let out = send(proxy.port(), "GET", "/redirect-out", "", b"", None).await;
    assert_eq!(out.status, 403);
    assert!(out.header("location").is_none());
    let inn = send(proxy.port(), "GET", "/redirect-in", "", b"", None).await;
    assert_eq!(inn.status, 302);
    assert_eq!(inn.header("location"), Some(format!("http://127.0.0.1:{}/next?x=1", proxy.port())));
}

#[tokio::test]
async fn a_rebound_host_name_never_reaches_the_dev_server() {
    let fake = fake_upstream().await;
    let proxy = start(&fake).await;
    for host in ["evil.example", &format!("evil.example:{}", proxy.port()), &format!("127.0.0.1.evil.example:{}", proxy.port()), "127.0.0.1:1"] {
        let r = send(proxy.port(), "GET", "/", "", b"", Some(host)).await;
        assert_eq!(r.status, 421, "{host}");
    }
    let no_host = send(proxy.port(), "GET", "/", "", b"", Some("")).await;
    assert_eq!(no_host.status, 421);
    assert_eq!(fake.hits.load(Ordering::SeqCst), 0);
    assert!(proxy.stats().blocked >= 5);
}

#[tokio::test]
async fn a_foreign_origin_is_refused_before_forwarding() {
    let fake = fake_upstream().await;
    let proxy = start(&fake).await;
    for origin in ["https://evil.example", "null", "http://localhost.evil.example"] {
        let r = send(proxy.port(), "GET", "/", &format!("Origin: {origin}\r\n"), b"", None).await;
        assert_eq!(r.status, 403, "{origin}");
    }
    assert_eq!(fake.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn garbage_and_oversized_heads_get_a_400_and_no_upstream_call() {
    let fake = fake_upstream().await;
    let proxy = start(&fake).await;
    let mut s = TcpStream::connect(("127.0.0.1", proxy.port())).await.unwrap();
    s.write_all(b"\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03 not http at all\r\n\r\n").await.unwrap();
    let mut raw = Vec::new();
    timeout(Duration::from_secs(5), s.read_to_end(&mut raw)).await.unwrap().unwrap();
    assert!(String::from_utf8_lossy(&raw).starts_with("HTTP/1.1 400"));
    let mut s = TcpStream::connect(("127.0.0.1", proxy.port())).await.unwrap();
    let junk = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-Pad: {}\r\n\r\n", proxy.port(), "a".repeat(70_000));
    let _ = s.write_all(junk.as_bytes()).await;
    let mut raw = Vec::new();
    let _ = timeout(Duration::from_secs(5), s.read_to_end(&mut raw)).await;
    assert!(String::from_utf8_lossy(&raw).starts_with("HTTP/1.1 400") || raw.is_empty(), "{:?}", String::from_utf8_lossy(&raw[..raw.len().min(200)]));
    assert_eq!(fake.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn only_loopback_servers_the_ide_knows_about_can_be_proxied() {
    let remote: SocketAddr = "93.184.216.34:80".parse().unwrap();
    let e = Proxy::start(ProxyConfig { upstream: remote, allowed_ports: vec![80], inject: true }).await.err().unwrap();
    assert!(matches!(e, ProxyError::UpstreamNotLoopback));
    let lan: SocketAddr = "192.168.1.20:8082".parse().unwrap();
    assert!(matches!(Proxy::start(ProxyConfig { upstream: lan, allowed_ports: vec![8082], inject: true }).await.err().unwrap(), ProxyError::UpstreamNotLoopback));
    let local: SocketAddr = "127.0.0.1:8082".parse().unwrap();
    assert!(matches!(Proxy::start(ProxyConfig { upstream: local, allowed_ports: vec![], inject: true }).await.err().unwrap(), ProxyError::PortNotAllowed(8082)));
    assert!(matches!(Proxy::start(ProxyConfig { upstream: local, allowed_ports: vec![9000], inject: true }).await.err().unwrap(), ProxyError::PortNotAllowed(8082)));
}

#[tokio::test]
async fn a_dead_upstream_is_a_502_and_stop_closes_everything() {
    let dead = {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap()
    };
    let proxy = Proxy::start(ProxyConfig { upstream: dead, allowed_ports: vec![dead.port()], inject: true }).await.unwrap();
    let r = send(proxy.port(), "GET", "/", "", b"", None).await;
    assert_eq!(r.status, 502);
    let port = proxy.port();
    proxy.stop();
    drop(proxy);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err(), "listener must be gone after stop");
}

#[tokio::test]
async fn injection_can_be_switched_off() {
    let fake = fake_upstream().await;
    let proxy = Proxy::start(ProxyConfig { upstream: fake.addr, allowed_ports: vec![fake.addr.port()], inject: false }).await.unwrap();
    let r = send(proxy.port(), "GET", "/", "", b"", None).await;
    assert_eq!(r.text(), HTML);
    assert!(r.header("x-frame-options").is_none(), "frame blocking is still stripped");
}
