//! T4b: the SOCKS5 relay and its allow-list. No real sshd, no network beyond loopback: an in-process spawner (tokio
//! duplex pipes) stands in for `ssh -W`, and a few tests run tiny `/bin/sh` scripts as the "ssh" binary to prove the real
//! spawner's plumbing (argv, stderr sanitising, kill on drop, no child under the read-only jail).
#![cfg(all(feature = "mongo", unix))]

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use intely_mongo::connspec::{AllowedHost, HostPort, SshSpec};
use intely_mongo::jail::NetworkPolicy;
use intely_mongo::tunnel::relay::{
    classify_w_failure, srv_parent_domain, stream_cap, validate_allow_host, AllowRules, CloseReason, Relay, RelayConfig, Spawned, Spawner, SshSpawner,
    StreamOutcome, TokenBucket,
};
use intely_mongo::tunnel::socks::{self, ct_eq, Dest, SocksError};
use intely_mongo::tunnel::{AllowList, Socks5Endpoint};

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------

type SpawnFn = Box<dyn Fn(usize, &str, u16) -> io::Result<Spawned> + Send + Sync>;

struct Fake {
    f: SpawnFn,
    calls: Mutex<Vec<(String, u16)>>,
}

impl Fake {
    fn new(f: impl Fn(usize, &str, u16) -> io::Result<Spawned> + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { f: Box::new(f), calls: Mutex::new(Vec::new()) })
    }
    fn echo() -> Arc<Self> {
        Self::new(|_, _, _| Ok(echo_stream()))
    }
    fn calls(&self) -> Vec<(String, u16)> {
        self.calls.lock().unwrap().clone()
    }
}

impl Spawner for Fake {
    fn spawn(&self, host: &str, port: u16) -> io::Result<Spawned> {
        let n = {
            let mut c = self.calls.lock().unwrap();
            c.push((host.to_string(), port));
            c.len() - 1
        };
        (self.f)(n, host, port)
    }
}

fn ok_outcome() -> StreamOutcome {
    StreamOutcome { success: true, stderr_tail: Vec::new() }
}

/// A stream that echoes every byte back.
fn echo_stream() -> Spawned {
    let (a, b) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        let (mut r, mut w) = tokio::io::split(b);
        let _ = tokio::io::copy(&mut r, &mut w).await;
    });
    Spawned { io: Box::new(a), finished: Box::pin(async { ok_outcome() }) }
}

/// A stream whose far end is already closed and whose child "failed" with the given stderr lines.
fn failing_stream(lines: &[&str]) -> Spawned {
    let (a, b) = tokio::io::duplex(1024);
    drop(b);
    let tail: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
    Spawned { io: Box::new(a), finished: Box::pin(async move { StreamOutcome { success: false, stderr_tail: tail } }) }
}

fn hp(host: &str, port: u16) -> HostPort {
    HostPort { host: host.into(), port: Some(port) }
}

fn rules(entries: &[(&str, u16)]) -> AllowRules {
    let seeds: Vec<HostPort> = entries.iter().map(|(h, p)| hp(h, *p)).collect();
    AllowRules::standard(&seeds, &[]).unwrap()
}

fn cfg() -> RelayConfig {
    RelayConfig::new(rules(&[("db1.example.com", 27017)]))
}

async fn start(cfg: RelayConfig, sp: &Arc<Fake>) -> Relay {
    Relay::start(cfg, sp.clone()).await.unwrap()
}

async fn eventually(what: &str, f: impl Fn() -> bool) {
    let t = Instant::now();
    while !f() {
        assert!(t.elapsed() < Duration::from_secs(20), "timed out waiting for: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn raw(relay: &Relay) -> TcpStream {
    TcpStream::connect(("127.0.0.1", relay.port())).await.unwrap()
}

/// Greeting offering "no auth" and "password", then the RFC 1929 request; returns the status bytes.
async fn auth_with(s: &mut TcpStream, user: &str, pass: &str) -> [u8; 2] {
    s.write_all(&[5, 2, 0, 2]).await.unwrap();
    let mut m = [0u8; 2];
    s.read_exact(&mut m).await.unwrap();
    assert_eq!(m, [5, 2], "the relay must pick username/password");
    let mut p = vec![1, user.len() as u8];
    p.extend(user.bytes());
    p.push(pass.len() as u8);
    p.extend(pass.bytes());
    s.write_all(&p).await.unwrap();
    let mut st = [0u8; 2];
    s.read_exact(&mut st).await.unwrap();
    st
}

fn req_name(host: &str, port: u16) -> Vec<u8> {
    let mut v = vec![5, 1, 0, 3, host.len() as u8];
    v.extend(host.bytes());
    v.extend(port.to_be_bytes());
    v
}

async fn read_reply(s: &mut TcpStream) -> u8 {
    let mut r = [0u8; 10];
    s.read_exact(&mut r).await.unwrap();
    assert_eq!(r[0], 5);
    r[1]
}

/// The whole client side with the right credentials: returns the open socket and the reply code.
async fn open_with(e: &Socks5Endpoint, port: u16, host: &str, dport: u16) -> (TcpStream, u8) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    assert_eq!(auth_with(&mut s, &e.user, &e.pass).await, [1, 0]);
    s.write_all(&req_name(host, dport)).await.unwrap();
    let code = read_reply(&mut s).await;
    (s, code)
}

async fn open(relay: &Relay, host: &str, port: u16) -> (TcpStream, u8) {
    open_with(&relay.endpoint(), relay.port(), host, port).await
}

async fn expect_closed(s: &mut TcpStream) {
    let mut b = [0u8; 64];
    loop {
        match tokio::time::timeout(Duration::from_secs(20), s.read(&mut b)).await {
            Ok(Ok(0)) | Ok(Err(_)) => return,
            Ok(Ok(_)) => continue,
            Err(_) => panic!("the relay did not close the socket"),
        }
    }
}

/// True only when something on that port accepts THIS relay's credentials (another test's relay may have reused the
/// freed port; it has different random credentials, so it does not count).
async fn still_serving(e: &Socks5Endpoint) -> bool {
    let attempt = async {
        let mut s = TcpStream::connect(("127.0.0.1", e.port)).await.ok()?;
        s.write_all(&[5, 1, 2]).await.ok()?;
        let mut m = [0u8; 2];
        s.read_exact(&mut m).await.ok()?;
        let mut p = vec![1, e.user.len() as u8];
        p.extend(e.user.bytes());
        p.push(e.pass.len() as u8);
        p.extend(e.pass.bytes());
        s.write_all(&p).await.ok()?;
        let mut st = [0u8; 2];
        s.read_exact(&mut st).await.ok()?;
        Some(st == [1, 0])
    };
    matches!(tokio::time::timeout(Duration::from_secs(2), attempt).await, Ok(Some(true)))
}

async fn roundtrip(s: &mut TcpStream, data: &[u8]) {
    s.write_all(data).await.unwrap();
    let mut back = vec![0u8; data.len()];
    tokio::time::timeout(Duration::from_secs(20), s.read_exact(&mut back)).await.expect("echo timed out").unwrap();
    assert_eq!(back, data);
}

// ---------------------------------------------------------------------------------------------------------------------
// Protocol (socks.rs)
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn ct_eq_is_equality() {
    assert!(ct_eq(b"", b""));
    assert!(ct_eq(b"abc", b"abc"));
    assert!(!ct_eq(b"abc", b"abd"));
    assert!(!ct_eq(b"abc", b"abcd"));
    assert!(!ct_eq(b"abcd", b"abc"));
    assert!(!ct_eq(b"", b"a"));
}

#[tokio::test]
async fn parse_greeting_auth_and_request_frames() {
    // greeting
    let mut g: &[u8] = &[5, 2, 0, 2];
    assert_eq!(socks::read_greeting(&mut g).await.unwrap(), vec![0, 2]);
    assert_eq!(socks::choose_method(&[0, 2]), Some(2));
    assert_eq!(socks::choose_method(&[0]), None, "no-auth is never selected");
    let mut g: &[u8] = &[5, 0];
    assert!(matches!(socks::read_greeting(&mut g).await, Err(SocksError::NoAcceptableMethod)));
    let mut g: &[u8] = &[4, 1, 2];
    assert!(matches!(socks::read_greeting(&mut g).await, Err(SocksError::Version(4))));

    // RFC 1929
    let mut a: &[u8] = &[1, 2, b'u', b's', 3, b'p', b'w', b'd'];
    assert_eq!(socks::read_password_auth(&mut a).await.unwrap(), (b"us".to_vec(), b"pwd".to_vec()));
    let mut a: &[u8] = &[2, 1, b'u', 1, b'p'];
    assert!(matches!(socks::read_password_auth(&mut a).await, Err(SocksError::Auth)));
    let mut a: &[u8] = &[1, 0, 1, b'p'];
    assert!(matches!(socks::read_password_auth(&mut a).await, Err(SocksError::Auth)));
    let mut big = vec![1u8, 65];
    big.extend(vec![b'x'; 65]);
    big.extend([1, b'p']);
    let mut a: &[u8] = &big;
    assert!(matches!(socks::read_password_auth(&mut a).await, Err(SocksError::Oversize)));

    // requests
    let mut r: &[u8] = &[5, 1, 0, 3, 3, b'a', b'.', b'b', 0x69, 0x87];
    let req = socks::read_request(&mut r).await.unwrap();
    assert_eq!(req.dest, Dest::Name("a.b".into()));
    assert_eq!(req.port, 27015);
    let mut r: &[u8] = &[5, 1, 0, 1, 10, 0, 0, 5, 0x6a, 0x69];
    let req = socks::read_request(&mut r).await.unwrap();
    assert_eq!(req.dest, Dest::Ipv4("10.0.0.5".parse().unwrap()));
    let mut v6 = vec![5u8, 1, 0, 4];
    v6.extend([0u8; 16]);
    v6.extend([0x69, 0x87]);
    let mut r: &[u8] = &v6;
    assert_eq!(socks::read_request(&mut r).await.unwrap().dest, Dest::Ipv6);
    let mut r: &[u8] = &[5, 2, 0, 1, 1, 1, 1, 1, 0, 80];
    assert!(matches!(socks::read_request(&mut r).await, Err(SocksError::Command(2))));
    let mut r: &[u8] = &[5, 3, 0, 1, 1, 1, 1, 1, 0, 80];
    assert!(matches!(socks::read_request(&mut r).await, Err(SocksError::Command(3))));
    let mut r: &[u8] = &[5, 1, 1, 1, 1, 1, 1, 1, 0, 80];
    assert!(matches!(socks::read_request(&mut r).await, Err(SocksError::Malformed)), "reserved byte must be zero");
    let mut r: &[u8] = &[5, 1, 0, 9, 1];
    assert!(matches!(socks::read_request(&mut r).await, Err(SocksError::AddressType(9))));
    let mut r: &[u8] = &[5, 1, 0, 3, 0];
    assert!(matches!(socks::read_request(&mut r).await, Err(SocksError::Malformed)));
    let mut r: &[u8] = &[5, 1, 0, 3, 254];
    assert!(matches!(socks::read_request(&mut r).await, Err(SocksError::Oversize)));
    let mut r: &[u8] = &[5, 1, 0, 3, 2, 0xff, 0xfe, 0, 80];
    assert!(matches!(socks::read_request(&mut r).await, Err(SocksError::Malformed)), "non-text names are refused");
    let mut r: &[u8] = &[5, 1, 0, 3, 5, b'a'];
    assert!(matches!(socks::read_request(&mut r).await, Err(SocksError::Io(_))), "a truncated frame is an I/O error");
}

// ---------------------------------------------------------------------------------------------------------------------
// The relay: authentication, methods, round trip
// ---------------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn auth_success_and_bytes_round_trip() {
    let sp = Fake::echo();
    let relay = start(cfg(), &sp).await;
    let (mut s, code) = open(&relay, "db1.example.com", 27017).await;
    assert_eq!(code, 0);
    roundtrip(&mut s, b"hello over the relay").await;
    let big = big_copy(200_000);
    let (mut rd, mut wr) = s.into_split();
    let to_send = big.clone();
    let writer = tokio::spawn(async move {
        wr.write_all(&to_send).await.unwrap();
        wr
    });
    let mut back = vec![0u8; big.len()];
    tokio::time::timeout(Duration::from_secs(10), rd.read_exact(&mut back)).await.expect("large echo timed out").unwrap();
    assert_eq!(back, big);
    let _wr = writer.await.unwrap();
    assert_eq!(sp.calls(), vec![("db1.example.com".to_string(), 27017)]);
    let st = relay.stats();
    assert_eq!((st.spawned, st.refused, st.auth_failed), (1, 0, 0));
    relay.shutdown().await;
}

fn big_copy(n: u32) -> Vec<u8> {
    (0..n).map(|i| (i % 251) as u8).collect()
}

#[tokio::test]
async fn auth_failure_wrong_user_or_password_and_no_spawn() {
    let sp = Fake::echo();
    let relay = start(cfg(), &sp).await;
    let e = relay.endpoint();
    for (u, p) in [(e.user.as_str(), "wrong"), ("wrong", e.pass.as_str()), ("x", "y")] {
        let mut s = raw(&relay).await;
        assert_eq!(auth_with(&mut s, u, p).await, [1, 1]);
        expect_closed(&mut s).await;
    }
    assert_eq!(relay.stats().auth_failed, 3);
    assert!(sp.calls().is_empty());
    relay.shutdown().await;
}

#[tokio::test]
async fn wrong_method_version_and_oversize_credentials_close_the_socket() {
    let sp = Fake::echo();
    let relay = start(cfg(), &sp).await;

    // only "no authentication" offered: 0xFF and close
    let mut s = raw(&relay).await;
    s.write_all(&[5, 1, 0]).await.unwrap();
    let mut m = [0u8; 2];
    s.read_exact(&mut m).await.unwrap();
    assert_eq!(m, [5, 0xFF]);
    expect_closed(&mut s).await;

    // SOCKS4
    let mut s = raw(&relay).await;
    s.write_all(&[4, 1, 2]).await.unwrap();
    expect_closed(&mut s).await;

    // a 200-byte user name is refused without reading it
    let mut s = raw(&relay).await;
    s.write_all(&[5, 1, 2]).await.unwrap();
    let mut m = [0u8; 2];
    s.read_exact(&mut m).await.unwrap();
    s.write_all(&[1, 200]).await.unwrap();
    expect_closed(&mut s).await;

    // a domain length byte of 254 is an oversize frame: general failure, then close
    let mut s = raw(&relay).await;
    let e = relay.endpoint();
    assert_eq!(auth_with(&mut s, &e.user, &e.pass).await, [1, 0]);
    s.write_all(&[5, 1, 0, 3, 254]).await.unwrap();
    assert_eq!(read_reply(&mut s).await, 1);
    expect_closed(&mut s).await;

    // BIND is not supported
    let mut s = raw(&relay).await;
    assert_eq!(auth_with(&mut s, &e.user, &e.pass).await, [1, 0]);
    s.write_all(&[5, 2, 0, 1, 127, 0, 0, 1, 0, 80]).await.unwrap();
    assert_eq!(read_reply(&mut s).await, 7);

    assert!(sp.calls().is_empty());
    relay.shutdown().await;
}

#[tokio::test]
async fn ipv6_is_refused_and_counted() {
    let sp = Fake::echo();
    let relay = start(cfg(), &sp).await;
    let e = relay.endpoint();
    let mut s = raw(&relay).await;
    assert_eq!(auth_with(&mut s, &e.user, &e.pass).await, [1, 0]);
    let mut v = vec![5u8, 1, 0, 4];
    v.extend([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    v.extend(27017u16.to_be_bytes());
    s.write_all(&v).await.unwrap();
    assert_eq!(read_reply(&mut s).await, 8);
    assert_eq!(relay.stats().ipv6_refused, 1);
    assert!(sp.calls().is_empty());

    // an IPv6 literal smuggled in as a domain name never reaches the spawner either
    let (mut s, code) = open(&relay, "::1", 27017).await;
    assert_eq!(code, 2);
    expect_closed(&mut s).await;
    assert!(sp.calls().is_empty());
    relay.shutdown().await;
}

// ---------------------------------------------------------------------------------------------------------------------
// Allow-list
// ---------------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn allow_list_denies_and_records_the_refusal() {
    let sp = Fake::echo();
    let relay = start(cfg(), &sp).await;
    let (mut s, code) = open(&relay, "evil.example.net", 27017).await;
    assert_eq!(code, 2);
    expect_closed(&mut s).await;
    // case-insensitive host, deduplicated record
    let (_s, code) = open(&relay, "EVIL.example.net", 27017).await;
    assert_eq!(code, 2);
    assert_eq!(relay.refused(), vec![hp("evil.example.net", 27017)]);
    assert!(sp.calls().is_empty(), "a refused destination never spawns a child");
    // the allowed one still works, any case
    let (mut ok, code) = open(&relay, "DB1.Example.COM", 27017).await;
    assert_eq!(code, 0);
    roundtrip(&mut ok, b"x").await;
    assert_eq!(sp.calls(), vec![("db1.example.com".to_string(), 27017)], "the spawner gets the normalised host");
    relay.shutdown().await;
}

#[tokio::test]
async fn right_host_wrong_port_is_refused() {
    let sp = Fake::echo();
    let relay = start(cfg(), &sp).await;
    let (_s, code) = open(&relay, "db1.example.com", 27018).await;
    assert_eq!(code, 2);
    assert_eq!(relay.refused(), vec![hp("db1.example.com", 27018)]);
    let (_s2, code) = open(&relay, "db1.example.com", 27017).await;
    assert_eq!(code, 0);
    relay.shutdown().await;
}

#[tokio::test]
async fn hostile_destination_text_is_refused_and_not_recorded() {
    let sp = Fake::echo();
    let relay = start(cfg(), &sp).await;
    for bad in ["-oProxyCommand=x", "a b", "a;b", "db1.example.com\n", "$(id)", "*.example.com"] {
        let (_s, code) = open(&relay, bad, 27017).await;
        assert_eq!(code, 2, "{bad:?}");
    }
    assert!(relay.refused().is_empty(), "hostile text is never kept");
    assert!(sp.calls().is_empty());
    relay.shutdown().await;
}

#[tokio::test]
async fn srv_shard_hosts_under_the_parent_domain_are_allowed_on_any_port() {
    let sp = Fake::echo();
    let allow = AllowRules::srv("cluster0.ab12c.mongodb.net", &[]).unwrap();
    let relay = start(RelayConfig::new(allow), &sp).await;
    for (h, p) in [("cluster0-shard-00-00.ab12c.mongodb.net", 27017), ("cluster0-shard-00-02.ab12c.mongodb.net", 27099), ("a.b.ab12c.mongodb.net", 1)] {
        let (_s, code) = open(&relay, h, p).await;
        assert_eq!(code, 0, "{h}");
    }
    for h in ["ab12c.mongodb.net", "xab12c.mongodb.net", "cluster0.zz99z.mongodb.net", "ab12c.mongodb.net.evil.com", "mongodb.net"] {
        let (_s, code) = open(&relay, h, 27017).await;
        assert_eq!(code, 2, "{h}");
    }
    relay.shutdown().await;
}

#[test]
fn srv_parent_domain_needs_three_labels() {
    assert_eq!(srv_parent_domain("c0.ab12c.mongodb.net").unwrap(), "ab12c.mongodb.net");
    assert_eq!(srv_parent_domain("C0.AB12C.mongodb.net.").unwrap(), "ab12c.mongodb.net");
    assert!(srv_parent_domain("mongodb.net").is_err());
    assert!(srv_parent_domain("localhost").is_err());
    assert!(srv_parent_domain("a..b.c").is_err());
    assert!(srv_parent_domain("-a.b.c").is_err());
}

#[tokio::test]
async fn replica_set_member_outside_the_seeds_is_refused_until_allowed() {
    let sp = Fake::echo();
    let relay = start(cfg(), &sp).await;
    let (_s, code) = open(&relay, "db2.internal.example.com", 27017).await;
    assert_eq!(code, 2);
    assert_eq!(relay.refused(), vec![hp("db2.internal.example.com", 27017)]);
    relay.allow_more(&[AllowedHost { host: "DB2.internal.example.com".into(), port: 27017 }]).unwrap();
    let (mut s, code) = open(&relay, "db2.internal.example.com", 27017).await;
    assert_eq!(code, 0);
    roundtrip(&mut s, b"member").await;
    // the metadata endpoint can never be allowed
    assert!(relay.allow_more(&[AllowedHost { host: "169.254.169.254".into(), port: 80 }]).is_err());
    let (_s, code) = open(&relay, "169.254.169.254", 80).await;
    assert_eq!(code, 2);
    relay.shutdown().await;
}

#[test]
fn allow_rules_construction() {
    // seed without a port means 27017
    let r = AllowRules::standard(&[HostPort { host: "A.example.com".into(), port: None }], &[AllowedHost { host: "b.example.com".into(), port: 1 }]).unwrap();
    assert!(r.permits("a.example.com", 27017) && r.permits("a.example.com.", 27017) && r.permits("b.example.com", 1));
    assert!(!r.permits("a.example.com", 1) && !r.permits("b.example.com", 27017) && !r.permits("c.example.com", 27017));
    // IPv6 seeds and bad names are refused at construction
    assert!(AllowRules::standard(&[HostPort { host: "[::1]".into(), port: Some(1) }], &[]).is_err());
    assert!(AllowRules::standard(&[HostPort { host: "-x".into(), port: Some(1) }], &[]).is_err());
    assert!(AllowRules::standard(&[], &[AllowedHost { host: "169.254.1.1".into(), port: 1 }]).is_err());
    assert!(AllowRules::standard(&[], &[]).unwrap().is_empty());
    // the lean AllowList: port = exact, no port = SRV parent domain
    let list = AllowList { entries: vec![hp("db.example.com", 1), HostPort { host: "c0.ab12c.mongodb.net".into(), port: None }] };
    let r = AllowRules::from_allow_list(&list).unwrap();
    assert!(r.permits("db.example.com", 1) && r.permits("s1.ab12c.mongodb.net", 27017) && !r.permits("db.example.com", 2));
}

#[test]
fn allow_this_host_validator_rejects_link_local_metadata_and_ambiguous_numbers() {
    for bad in [
        "169.254.169.254",
        "169.254.0.1",
        "169.254.255.255",
        "metadata.google.internal",
        "Metadata.Google.Internal.",
        "metadata",
        "instance-data",
        "2852039166",       // decimal form of 169.254.169.254
        "0xa9fea9fe",       // hex form
        "0251.0376.0251.0376", // octal form
        "169.254.43518",    // short form
        "fe80::1",
        "[fe80::1]",
        "[::1]",
        "::ffff:169.254.169.254",
        "-oProxyCommand=x",
        "a b",
        "",
        "db\n.example.com",
    ] {
        assert!(validate_allow_host(bad, 27017).is_err(), "{bad:?} must be rejected");
    }
    assert!(validate_allow_host("db.example.com", 0).is_err());
    for good in ["db1.example.com", "10.0.0.5", "192.168.1.20", "169.253.1.1", "169.255.0.1", "localhost", "node_1.corp-net"] {
        assert!(validate_allow_host(good, 27017).is_ok(), "{good:?} must be accepted");
    }
    assert_eq!(validate_allow_host("DB1.Example.com.", 1).unwrap(), AllowedHost { host: "db1.example.com".into(), port: 1 });
}

// ---------------------------------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn slow_handshake_is_cut_off() {
    let sp = Fake::echo();
    let mut c = cfg();
    c.handshake_timeout = Duration::from_millis(250);
    let relay = start(c, &sp).await;
    let t = Instant::now();
    let mut s = raw(&relay).await;
    expect_closed(&mut s).await;
    assert!(t.elapsed() >= Duration::from_millis(200), "closed too early: {:?}", t.elapsed());

    // half a request after a valid login is cut off as well
    let e = relay.endpoint();
    let mut s = raw(&relay).await;
    assert_eq!(auth_with(&mut s, &e.user, &e.pass).await, [1, 0]);
    s.write_all(&[5, 1, 0, 3, 10, b'a']).await.unwrap();
    expect_closed(&mut s).await;
    relay.shutdown().await;
}

#[tokio::test]
async fn ninth_unauthenticated_socket_is_refused_and_slots_are_released() {
    let sp = Fake::echo();
    let relay = start(cfg(), &sp).await;
    let mut idle = Vec::new();
    for _ in 0..8 {
        idle.push(raw(&relay).await);
    }
    eventually("8 accepted", || relay.stats().accepted == 8).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut ninth = raw(&relay).await;
    expect_closed(&mut ninth).await;
    assert_eq!(relay.stats().unauthenticated_rejected, 1);

    // a socket that already holds a slot can still log in and work while the cap is full
    let e = relay.endpoint();
    let mut first = idle.remove(0);
    assert_eq!(auth_with(&mut first, &e.user, &e.pass).await, [1, 0]);
    first.write_all(&req_name("db1.example.com", 27017)).await.unwrap();
    assert_eq!(read_reply(&mut first).await, 0);
    roundtrip(&mut first, b"ok").await;

    // authenticated sockets no longer count: a new one is accepted into the freed slot
    let mut again = raw(&relay).await;
    assert_eq!(auth_with(&mut again, &e.user, &e.pass).await, [1, 0]);
    assert_eq!(relay.stats().unauthenticated_rejected, 1);
    drop(idle);
    relay.shutdown().await;
}

#[test]
fn stream_cap_formula() {
    // 5-member set at the default pool size: 5 x (4 + 2) + 8 = 38, floor 64
    assert_eq!(stream_cap(5, 4), 64);
    assert_eq!(stream_cap(1, 4), 64);
    assert_eq!(stream_cap(0, 4), 64);
    // pool size is clamped to 4 under a tunnel
    assert_eq!(stream_cap(10, 100), stream_cap(10, 4));
    assert_eq!(stream_cap(10, 4), 68);
    assert_eq!(stream_cap(20, 4), 128);
    assert_eq!(stream_cap(20, 0), 68);
}

#[tokio::test]
async fn stream_cap_is_enforced_and_slots_come_back() {
    let sp = Fake::echo();
    let mut c = cfg();
    c.max_streams = 3;
    let relay = start(c, &sp).await;
    let mut held = Vec::new();
    for _ in 0..3 {
        let (mut s, code) = open(&relay, "db1.example.com", 27017).await;
        assert_eq!(code, 0);
        roundtrip(&mut s, b"a").await;
        held.push(s);
    }
    assert_eq!(relay.active_streams(), 3);
    let (mut over, code) = open(&relay, "db1.example.com", 27017).await;
    assert_eq!(code, 1, "the stream over the cap is refused");
    expect_closed(&mut over).await;
    assert_eq!(relay.stats().stream_cap_hits, 1);
    assert_eq!(sp.calls().len(), 3);

    drop(held.pop());
    eventually("a slot is released", || relay.active_streams() == 2).await;
    let (_s, code) = open(&relay, "db1.example.com", 27017).await;
    assert_eq!(code, 0);
    relay.shutdown().await;
}

#[test]
fn token_bucket_burst_and_refill_with_a_synthetic_clock() {
    let t0 = Instant::now();
    let mut b = TokenBucket::new(40, 20, t0);
    for i in 0..40 {
        assert!(b.try_take(t0), "burst token {i}");
    }
    assert!(!b.try_take(t0), "burst exhausted");
    assert!(!b.try_take(t0 + Duration::from_millis(49)), "20 per second means one token per 50 ms");
    assert!(b.try_take(t0 + Duration::from_millis(50)));
    assert!(!b.try_take(t0 + Duration::from_millis(60)));
    // one second refills 20 tokens, never beyond the burst
    let t1 = t0 + Duration::from_secs(3);
    let n = (0..100).filter(|_| b.try_take(t1)).count();
    assert_eq!(n, 40);
    // a clock that goes backwards neither panics nor mints tokens
    assert!(!b.try_take(t0));
}

#[tokio::test]
async fn token_bucket_limits_spawned_children_in_the_relay() {
    let sp = Fake::echo();
    let mut c = cfg();
    c.bucket_burst = 2;
    c.bucket_per_sec = 0;
    let relay = start(c, &sp).await;
    let (_a, ca) = open(&relay, "db1.example.com", 27017).await;
    let (_b, cb) = open(&relay, "db1.example.com", 27017).await;
    let (mut c3, cc) = open(&relay, "db1.example.com", 27017).await;
    assert_eq!((ca, cb, cc), (0, 0, 1));
    expect_closed(&mut c3).await;
    assert_eq!(relay.stats().rate_limited, 1);
    assert_eq!(sp.calls().len(), 2);
    relay.shutdown().await;
}

// ---------------------------------------------------------------------------------------------------------------------
// Failed children
// ---------------------------------------------------------------------------------------------------------------------

const PROHIBITED: &str = "channel 0: open failed: administratively prohibited: open failed";

#[tokio::test]
async fn the_relay_closes_after_twenty_consecutive_failed_children() {
    let sp = Fake::new(|_, _, _| Ok(failing_stream(&["stdio forwarding failed", PROHIBITED])));
    let relay = start(cfg(), &sp).await;
    let mut closed = relay.subscribe_closed();
    for i in 1..=20u32 {
        let (mut s, code) = open(&relay, "db1.example.com", 27017).await;
        assert_eq!(code, 0, "the reply precedes the child's outcome");
        expect_closed(&mut s).await;
        drop(s);
        eventually("failure counted", || relay.consecutive_failures() >= i).await;
    }
    eventually("closed", || relay.closed() == Some(CloseReason::TooManyFailures)).await;
    closed.changed().await.unwrap();
    assert_eq!(*closed.borrow(), Some(CloseReason::TooManyFailures));
    let f = relay.last_failure().unwrap();
    assert_eq!(f.target, hp("db1.example.com", 27017));
    assert_eq!(f.code, Some("tunnel.forwardingDisabled"));
    assert!(f.lines.iter().any(|l| l.contains("administratively prohibited")));
    // the listener is gone
    assert!(!still_serving(&relay.endpoint()).await);
    relay.shutdown().await;
}

#[tokio::test]
async fn one_success_resets_the_failure_streak() {
    let sp = Fake::new(|n, _, _| if n == 19 { Ok(echo_stream()) } else { Ok(failing_stream(&["Connection refused"])) });
    let relay = start(cfg(), &sp).await;
    let mut done = 0u32;
    for i in 0..39usize {
        let (mut s, code) = open(&relay, "db1.example.com", 27017).await;
        assert_eq!(code, 0);
        if i == 19 {
            roundtrip(&mut s, b"good").await;
            drop(s);
            eventually("reset", || relay.consecutive_failures() == 0).await;
            done = 0;
        } else {
            expect_closed(&mut s).await;
            done += 1;
            eventually("counted", || relay.consecutive_failures() >= done).await;
        }
    }
    assert_eq!(relay.consecutive_failures(), 19);
    assert_eq!(relay.closed(), None, "19 in a row after a success must not close the relay");
    assert_eq!(relay.last_failure().unwrap().code, Some("tunnel.targetRefused"));
    relay.shutdown().await;
}

#[tokio::test]
async fn a_spawn_error_is_a_general_failure_and_counts() {
    let sp = Fake::new(|_, _, _| Err(io::Error::other("no ssh")));
    let relay = start(cfg(), &sp).await;
    let (mut s, code) = open(&relay, "db1.example.com", 27017).await;
    assert_eq!(code, 1);
    expect_closed(&mut s).await;
    assert_eq!(relay.consecutive_failures(), 1);
    relay.shutdown().await;
}

#[test]
fn w_failure_classification_is_by_substring_for_two_codes_only() {
    let l = |s: &str| vec![s.to_string()];
    assert_eq!(classify_w_failure(&l("channel 0: open failed: administratively prohibited: open failed")), Some("tunnel.forwardingDisabled"));
    assert_eq!(classify_w_failure(&l("channel 0: open failed: connect failed: Connection refused")), Some("tunnel.targetRefused"));
    assert_eq!(classify_w_failure(&l("channel 0: open failed: connect failed: Name or service not known")), Some("tunnel.targetRefused"));
    assert_eq!(classify_w_failure(&l("Permission denied (publickey).")), None);
    assert_eq!(classify_w_failure(&l("Host key verification failed.")), None);
    assert_eq!(classify_w_failure(&[]), None);
}

// ---------------------------------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn shutdown_drops_streams_and_closes_the_listener() {
    let sp = Fake::echo();
    let relay = start(cfg(), &sp).await;
    let e = relay.endpoint();
    let (mut s, code) = open(&relay, "db1.example.com", 27017).await;
    assert_eq!(code, 0);
    roundtrip(&mut s, b"x").await;
    assert!(still_serving(&e).await);
    relay.shutdown().await;
    expect_closed(&mut s).await;
    assert!(!still_serving(&e).await);
}

#[tokio::test]
async fn dropping_the_relay_without_shutdown_also_stops_it() {
    let sp = Fake::echo();
    let relay = start(cfg(), &sp).await;
    let e = relay.endpoint();
    let (mut s, _) = open(&relay, "db1.example.com", 27017).await;
    drop(relay);
    expect_closed(&mut s).await;
    assert!(!still_serving(&e).await);
}

#[tokio::test]
async fn credentials_are_random_hex_loopback_only_and_never_in_debug() {
    let sp = Fake::echo();
    let a = start(cfg(), &sp).await;
    let b = start(cfg(), &sp).await;
    let (ea, eb) = (a.endpoint(), b.endpoint());
    for e in [&ea, &eb] {
        assert_eq!(e.user.len(), 32);
        assert_eq!(e.pass.len(), 32);
        assert!(e.user.bytes().chain(e.pass.bytes()).all(|c| c.is_ascii_hexdigit()));
        assert_ne!(e.user, e.pass);
        assert_ne!(e.port, 0);
    }
    assert_ne!(ea.user, eb.user);
    assert_ne!(ea.pass, eb.pass);
    assert_ne!(ea.port, eb.port);
    // credentials of one relay do not open the other
    let mut s = raw(&b).await;
    assert_eq!(auth_with(&mut s, &ea.user, &ea.pass).await, [1, 1]);
    let dbg = format!("{a:?}");
    assert!(!dbg.contains(&ea.user) && !dbg.contains(&ea.pass), "{dbg}");
    // bound on the loopback interface only: the wildcard-address connect must not be the listener's address
    assert!(std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], ea.port).into(), Duration::from_secs(1)).is_ok());
    a.shutdown().await;
    b.shutdown().await;
}

// ---------------------------------------------------------------------------------------------------------------------
// The real spawner with /bin/sh scripts standing in for ssh
// ---------------------------------------------------------------------------------------------------------------------

fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let p = dir.join(name);
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
}

fn bastion() -> SshSpec {
    SshSpec { host: "localhost".into(), user: "tester".into(), ..SshSpec::default() }
}

fn env_for(dir: &Path) -> Vec<(String, String)> {
    vec![("PATH".into(), "/usr/bin:/bin".into()), ("OUT".into(), dir.join("argv.txt").to_string_lossy().into_owned()), ("PIDF".into(), dir.join("pid.txt").to_string_lossy().into_owned())]
}

fn spawner(prog: PathBuf, dir: &Path, policy: NetworkPolicy) -> Arc<SshSpawner> {
    Arc::new(SshSpawner::new(prog, bastion(), dir.join("c"), policy, env_for(dir)))
}

#[tokio::test]
async fn ssh_spawner_runs_dash_w_over_the_control_socket_and_bridges_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let prog = script(dir.path(), "ssh", "printf '%s\\n' \"$@\" > \"$OUT\"\nexec cat");
    let relay = Relay::start(cfg(), spawner(prog, dir.path(), NetworkPolicy::Full)).await.unwrap();
    let (mut s, code) = open(&relay, "DB1.example.com", 27017).await;
    assert_eq!(code, 0);
    roundtrip(&mut s, b"through a child process").await;
    let argv = std::fs::read_to_string(dir.path().join("argv.txt")).unwrap();
    let a: Vec<&str> = argv.lines().collect();
    assert!(a.windows(2).any(|w| w == ["-S", dir.path().join("c").to_str().unwrap()]), "{a:?}");
    assert!(a.windows(2).any(|w| w == ["-W", "db1.example.com:27017"]), "{a:?}");
    assert!(a.contains(&"ControlMaster=no") && a.contains(&"ProxyCommand=false"), "{a:?}");
    assert_eq!(&a[a.len() - 2..], ["--", "localhost"], "the destination follows `--`");
    drop(s);
    eventually("stream finished", || relay.active_streams() == 0).await;
    eventually("clean exit keeps the streak at zero", || relay.consecutive_failures() == 0).await;
    relay.shutdown().await;
}

#[tokio::test]
async fn ssh_spawner_failed_child_is_classified_and_stderr_is_sanitised() {
    let dir = tempfile::tempdir().unwrap();
    let prog = script(dir.path(), "ssh", "printf '\\033]0;evil\\007\\033[31m%s\\n' 'channel 0: open failed: administratively prohibited: open failed' >&2\nexit 255");
    let relay = Relay::start(cfg(), spawner(prog, dir.path(), NetworkPolicy::Full)).await.unwrap();
    let (mut s, code) = open(&relay, "db1.example.com", 27017).await;
    assert_eq!(code, 0);
    expect_closed(&mut s).await;
    eventually("failure recorded", || relay.last_failure().is_some()).await;
    let f = relay.last_failure().unwrap();
    assert_eq!(f.code, Some("tunnel.forwardingDisabled"));
    assert!(f.lines.iter().all(|l| !l.contains('\u{1b}') && !l.contains('\u{7}')), "{:?}", f.lines);
    assert!(f.lines.iter().any(|l| l.contains("administratively prohibited")));
    assert_eq!(relay.consecutive_failures(), 1);
    relay.shutdown().await;
}

#[tokio::test]
async fn ssh_spawner_rejects_hostile_targets_and_starts_nothing_under_the_read_only_jail() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("ran");
    let prog = script(dir.path(), "ssh", &format!("touch '{}'\nexec cat", marker.display()));

    let sp = spawner(prog.clone(), dir.path(), NetworkPolicy::Full);
    for (h, p) in [("-oProxyCommand=x", 27017u16), ("a b", 27017), ("db.example.com", 0), ("::1", 27017), ("[::1]", 27017), ("a;b", 1)] {
        assert!(sp.spawn(h, p).is_err(), "{h:?}:{p}");
    }
    let refused = spawner(prog, dir.path(), NetworkPolicy::Refused);
    let err = refused.spawn("db1.example.com", 27017).err().expect("Refused must not spawn");
    assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!marker.exists(), "no child process may have run");

    // a relay over the refusing spawner reports failures and never a child; 20 of them close it
    let relay = Relay::start(cfg(), refused).await.unwrap();
    let (_s, code) = open(&relay, "db1.example.com", 27017).await;
    assert_eq!(code, 1);
    assert!(!marker.exists());
    relay.shutdown().await;
}

#[tokio::test]
async fn closing_the_relay_kills_its_ssh_children() {
    let dir = tempfile::tempdir().unwrap();
    let prog = script(dir.path(), "ssh", "echo $$ > \"$PIDF\"\nexec sleep 60");
    let relay = Relay::start(cfg(), spawner(prog, dir.path(), NetworkPolicy::Full)).await.unwrap();
    let (_s, code) = open(&relay, "db1.example.com", 27017).await;
    assert_eq!(code, 0);
    let pidf = dir.path().join("pid.txt");
    eventually("child started", || std::fs::read_to_string(&pidf).map(|t| t.trim().parse::<u32>().is_ok()).unwrap_or(false)).await;
    let pid: u32 = std::fs::read_to_string(&pidf).unwrap().trim().parse().unwrap();
    let alive = |pid: u32| {
        let out = std::process::Command::new("/bin/ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        !s.is_empty() && !s.starts_with('Z')
    };
    assert!(alive(pid));
    relay.shutdown().await;
    eventually("child killed", || !alive(pid)).await;
}
