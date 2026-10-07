//! Network rules of spec 4.12.5 for the production `Http` (`ReqwestHttp`): redirects, size and time caps, resolver answers and the
//! jail, against throwaway loopback servers made with std sockets. No test connects to anything but 127.0.0.1.

mod common;

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use intely_core::jail::Jail;
use intely_relay_bundle::net::{is_forbidden_address, parse_origin, split_url, Resolver, ReqwestHttp};
use intely_relay_bundle::{BundleError, Http, HttpRequest};

fn req(url: &str) -> HttpRequest {
    HttpRequest { url: url.into(), headers: vec![("accept".into(), "application/json".into())] }
}

/// A one-purpose HTTP server on 127.0.0.1: answers each connection with `respond(request_head)` and counts connections.
struct Server {
    port: u16,
    hits: Arc<AtomicUsize>,
    heads: Arc<std::sync::Mutex<Vec<String>>>,
}

fn server(respond: impl Fn(&str, &mut TcpStream) + Send + Sync + 'static) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(AtomicUsize::new(0));
    let heads = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (h2, heads2) = (hits.clone(), heads.clone());
    let respond = Arc::new(respond);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { break };
            h2.fetch_add(1, Ordering::SeqCst);
            let (respond, heads) = (respond.clone(), heads2.clone());
            thread::spawn(move || {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match s.read(&mut chunk) {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&buf).into_owned();
                heads.lock().unwrap().push(head.clone());
                respond(&head, &mut s);
            });
        }
    });
    Server { port, hits, heads }
}

fn text_response(status: &str, extra: &str, body: &[u8]) -> Vec<u8> {
    let mut r = format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n{extra}\r\n", body.len()).into_bytes();
    r.extend_from_slice(body);
    r
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
}

#[test]
fn a_plain_get_returns_status_headers_and_body() {
    let s = server(|_, w| {
        let _ = w.write_all(&text_response("200 OK", "x-test: yes\r\n", br#"{"ok":true}"#));
    });
    let http = ReqwestHttp::new(Jail::off());
    let r = rt().block_on(http.get(req(&format!("http://127.0.0.1:{}/api/health", s.port)))).unwrap();
    assert_eq!((r.status, r.body.as_slice()), (200, br#"{"ok":true}"#.as_slice()));
    assert!(r.headers.iter().any(|(k, v)| k == "x-test" && v == "yes"));
    let head = s.heads.lock().unwrap()[0].clone();
    assert!(head.starts_with("GET /api/health HTTP/1.1"), "{head}");
    assert!(head.to_ascii_lowercase().contains("accept: application/json"));
    assert!(head.contains("IntelyIDE-relay-check"));
}

#[test]
fn redirects_are_never_followed() {
    let target = server(|_, w| {
        let _ = w.write_all(&text_response("200 OK", "", b"secret"));
    });
    let target_port = target.port;
    let first = server(move |_, w| {
        let _ = w.write_all(&text_response("302 Found", &format!("location: http://127.0.0.1:{target_port}/inside\r\n"), b""));
    });
    let http = ReqwestHttp::new(Jail::off());
    let r = rt().block_on(http.get(req(&format!("http://127.0.0.1:{}/bundle.json", first.port)))).unwrap();
    assert_eq!(r.status, 302, "the redirect is returned as a response, not followed");
    thread::sleep(Duration::from_millis(200));
    assert_eq!(target.hits.load(Ordering::SeqCst), 0, "the redirect target was never contacted");
}

#[test]
fn a_body_over_the_cap_is_refused_with_and_without_content_length() {
    let big = server(|_, w| {
        let body = vec![b'x'; 2 * 1024 * 1024 + 1];
        let _ = w.write_all(&text_response("200 OK", "", &body));
    });
    let http = ReqwestHttp::new(Jail::off());
    let err = rt().block_on(http.get(req(&format!("http://127.0.0.1:{}/x", big.port)))).unwrap_err();
    assert_eq!(err.code(), "tooLarge");

    let streamed = server(|_, w| {
        let _ = w.write_all(b"HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n");
        let block = vec![b'y'; 64 * 1024];
        for _ in 0..80 {
            if w.write_all(&block).is_err() {
                return;
            }
        }
    });
    let err = rt().block_on(http.get(req(&format!("http://127.0.0.1:{}/x", streamed.port)))).unwrap_err();
    assert_eq!(err.code(), "tooLarge");

    let exact = server(|_, w| {
        let _ = w.write_all(&text_response("200 OK", "", &vec![b'z'; 2 * 1024 * 1024]));
    });
    assert_eq!(rt().block_on(http.get(req(&format!("http://127.0.0.1:{}/x", exact.port)))).unwrap().body.len(), 2 * 1024 * 1024);
}

#[test]
fn oversized_or_endless_headers_are_refused() {
    let s = server(|_, w| {
        let _ = w.write_all(format!("HTTP/1.1 200 OK\r\nx-big: {}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n", "a".repeat(70_000)).as_bytes());
    });
    let http = ReqwestHttp::new(Jail::off());
    let err = rt().block_on(http.get(req(&format!("http://127.0.0.1:{}/x", s.port)))).unwrap_err();
    assert!(matches!(err.code(), "tooLarge" | "network"), "{}", err.code());
}

#[test]
fn a_server_that_never_answers_times_out() {
    let s = server(|_, w| {
        thread::sleep(Duration::from_secs(15));
        let _ = w.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
    });
    let http = ReqwestHttp::new(Jail::off());
    let t = Instant::now();
    let err = rt().block_on(http.get(req(&format!("http://127.0.0.1:{}/x", s.port)))).unwrap_err();
    assert_eq!(err.code(), "timeout");
    assert!(t.elapsed() < Duration::from_secs(14), "gave up at the 10 s limit, not later: {:?}", t.elapsed());
}

#[test]
fn a_refused_connection_is_a_network_error() {
    let port = { TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port() };
    let err = rt().block_on(ReqwestHttp::new(Jail::off()).get(req(&format!("http://127.0.0.1:{port}/x")))).unwrap_err();
    assert_eq!(err.code(), "network");
}

#[test]
fn read_only_mode_opens_no_socket() {
    let s = server(|_, w| {
        let _ = w.write_all(&text_response("200 OK", "", b"x"));
    });
    let err = rt().block_on(ReqwestHttp::new(Jail::read_only()).get(req(&format!("http://127.0.0.1:{}/x", s.port)))).unwrap_err();
    assert!(matches!(err, BundleError::Jail(ref c) if c == "readOnly"));
    assert_eq!(err.code(), "readOnly");
    thread::sleep(Duration::from_millis(150));
    assert_eq!(s.hits.load(Ordering::SeqCst), 0);
}

struct CountingResolver {
    answers: Vec<IpAddr>,
    calls: Arc<AtomicUsize>,
}

impl Resolver for CountingResolver {
    fn resolve(&self, _host: &str, _port: u16) -> std::io::Result<Vec<IpAddr>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.answers.clone())
    }
}

#[test]
fn names_that_resolve_to_private_space_are_refused_before_any_connection() {
    let tmp = tempfile::tempdir().unwrap();
    let private: Vec<Vec<IpAddr>> = vec![
        vec![Ipv4Addr::new(10, 0, 0, 5).into()],
        vec![Ipv4Addr::new(127, 0, 0, 1).into()],
        vec![Ipv4Addr::new(192, 168, 1, 1).into()],
        vec![Ipv4Addr::new(169, 254, 169, 254).into()],
        vec![Ipv4Addr::new(100, 64, 0, 1).into()],
        vec![Ipv6Addr::LOCALHOST.into()],
        vec!["::ffff:10.0.0.1".parse().unwrap()],
        vec!["fd00::1".parse().unwrap()],
        // one public answer next to a private one is still refused (DNS rebinding mixes)
        vec![Ipv4Addr::new(8, 8, 8, 8).into(), Ipv4Addr::new(10, 0, 0, 5).into()],
    ];
    for answers in private {
        let calls = Arc::new(AtomicUsize::new(0));
        let http = ReqwestHttp::with_resolver(Jail::off(), Arc::new(CountingResolver { answers: answers.clone(), calls: calls.clone() }));
        let err = rt().block_on(http.get(req("https://relay.example.com/api/status"))).unwrap_err();
        assert_eq!(err.code(), "privateAddress", "{answers:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "resolved exactly once");
    }
    // the E2E jail refuses before it even resolves
    let calls = Arc::new(AtomicUsize::new(0));
    let http = ReqwestHttp::with_resolver(Jail::e2e(tmp.path()), Arc::new(CountingResolver { answers: vec![Ipv4Addr::new(8, 8, 8, 8).into()], calls: calls.clone() }));
    let err = rt().block_on(http.get(req("https://relay.example.com/api/status"))).unwrap_err();
    assert_eq!(err.code(), "testJail");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    // an empty answer is a network error
    let http = ReqwestHttp::with_resolver(Jail::off(), Arc::new(CountingResolver { answers: vec![], calls: Arc::new(AtomicUsize::new(0)) }));
    assert_eq!(rt().block_on(http.get(req("https://relay.example.com/x"))).unwrap_err().code(), "network");
}

#[test]
fn the_forbidden_address_table() {
    let forbidden = [
        "0.0.0.0", "0.1.2.3", "10.1.2.3", "127.0.0.1", "127.9.9.9", "169.254.1.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "100.64.0.1",
        "100.127.255.255", "198.18.0.1", "198.19.255.255", "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255",
        "240.0.0.1", "255.255.255.255", "::", "::1", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1",
        "::ffff:192.168.1.1", "64:ff9b::a00:1", "::127.0.0.1", "::7f00:1", "2002:7f00:1::1", "2001:0:4136:e378::1", "fec0::1",
        "192.0.0.1", "192.88.99.1",
    ];
    for a in forbidden {
        assert!(is_forbidden_address(a.parse().unwrap()), "{a} must be forbidden");
    }
    for a in ["1.1.1.1", "8.8.8.8", "104.16.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.17.0.1", "198.20.0.1", "2606:4700::1111", "::ffff:8.8.8.8"] {
        assert!(!is_forbidden_address(a.parse().unwrap()), "{a} is public");
    }
}

#[test]
fn request_urls_are_validated_again_in_the_http_layer() {
    let http = ReqwestHttp::new(Jail::off());
    for url in [
        "https://relay.example.com/x?y=1", "https://relay.example.com/../x", "https://relay.example.com/a b", "https://user@relay.example.com/x",
        "http://relay.example.com/x", "https://1.2.3.4/x", "https://relay.example.com\\evil/x", "file:///etc/passwd", "https://relay.example.com/%2e%2e/x",
    ] {
        let err = rt().block_on(http.get(req(url))).unwrap_err();
        assert_eq!(err.code(), "badUrl", "{url}");
    }
    let (o, path) = split_url("https://relay.example.com:8443/api/status").unwrap();
    assert_eq!((o.origin().as_str(), path.as_str(), o.host_key().as_str()), ("https://relay.example.com:8443", "/api/status", "relay.example.com:8443"));
    assert_eq!(split_url("https://relay.example.com").unwrap().1, "/");
}

#[test]
fn origin_parsing_table() {
    for (raw, host, secure, loopback) in [
        ("https://Relay.Example.com", "relay.example.com", true, false),
        ("wss://relay.example.com/", "relay.example.com", true, false),
        ("http://127.0.0.1:8787", "127.0.0.1", false, true),
        ("ws://localhost:1", "localhost", false, true),
        ("ws://[::1]:9", "::1", false, true),
        ("https://xn--bcher-kva.example", "xn--bcher-kva.example", true, false),
    ] {
        let o = parse_origin(raw).unwrap_or_else(|e| panic!("{raw}: {e}"));
        assert_eq!((o.host.as_str(), o.secure, o.loopback), (host, secure, loopback), "{raw}");
    }
    for raw in ["http://0177.0.0.1", "http://0x7f.0.0.1", "http://127.000.000.001", "http://2130706433", "http://localhost.", "https://a..b.example", "https://1.example.2"] {
        assert!(parse_origin(raw).is_err(), "{raw}");
    }
}
