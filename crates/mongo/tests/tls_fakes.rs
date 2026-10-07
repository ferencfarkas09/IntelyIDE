//! T14a: Docker-free TLS and network scenarios. Each scenario runs the real driver (`connect_spec` options, `rustls`)
//! against an in-process fake on loopback and checks that `diagnose::classify` names the cause. Nothing here needs
//! Docker, a `mongod`, a real DNS server or the internet. See `tests/fakes/` for the servers.
#![cfg(feature = "mongo")]

mod fakes;

use std::path::{Path, PathBuf};
use std::time::Duration;

use bson::doc;
use intely_mongo::connspec::{ConnSpec, HostPort, ProxySpec, TlsMode, Tunnel};
use intely_mongo::diagnose::{self, classify, classify_text, Ctx};
use intely_mongo::driver::{build_spec_options, Session, SessionOpts, SpecConnect};
use mongodb::Client;

use fakes::certs::{server_config, Names, Pki};
use fakes::servers::{self, Fake};
use fakes::socks::spawn_socks5;

/// Diagnosis codes proven by a fake in this file, with the scenario that proves them.
const COVERED: &[(&str, &str)] = &[
    ("tls.unknownIssuer", "server certificate from a CA the client does not trust"),
    ("tls.hostname", "certificate issued for another name (direct and over the SOCKS5 fake)"),
    ("tls.expired", "expired server certificate"),
    ("tls.clientCertRequired", "server demands a client certificate"),
    ("tls.serverNotTls", "TLS requested, server speaks plain"),
    ("net.refused", "closed port"),
    ("net.reset", "listener answers with a TCP reset"),
    ("select.noServer", "silent listener: nothing ever answers, server selection times out"),
    ("tls.serverRequiresTls", "plain client, TLS-only server (closes after a TLS alert, after another alert record, or without a byte)"),
];

/// Scenarios written and run, but red until a shared request lands; ignored, never counted as proven. (Empty: the
/// `unexpected end of file` text of a TLS-only server is known to `diagnose.rs` since the live matrix run.)
const KNOWN_GAPS: &[&str] = &[];

/// Codes that need a real server (or a real sshd/DNS) and therefore have no fake here. Never counted as PASS.
const REAL_SERVER_ONLY: &[&str] = &[
    "auth.failed", "auth.mechanism", "auth.source", "auth.x509Subject",
    "authz.listDatabases", "authz.collection", "authz.command",
    "select.replicaSetName", "select.direct", "select.memberUnreachable",
];

fn spec(host: &str, port: u16, tls: TlsMode, ca: Option<&Path>) -> ConnSpec {
    let mut s = ConnSpec::default();
    s.hosts = vec![HostPort { host: host.into(), port: Some(port) }];
    s.tls.mode = tls;
    s.tls.ca_file = ca.map(|p| p.to_string_lossy().into_owned());
    s.timeouts.connect_ms = Some(1_500);
    s.timeouts.server_selection_ms = Some(1_500);
    s
}

fn ctx(s: &ConnSpec) -> Ctx {
    Ctx {
        hosts: s.hosts.iter().map(|h| h.host.clone()).collect(),
        tls_mode: s.tls.mode,
        has_ca: s.tls.ca_file.is_some(),
        has_client_cert: s.tls.client_cert_file.is_some(),
        tunnel: if matches!(s.tunnel, Tunnel::Socks5(_)) { "socks5" } else { "none" },
        ..Ctx::default()
    }
}

fn opts() -> SessionOpts {
    SessionOpts { allow_remote: true, ..SessionOpts::default() }
}

fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, text).unwrap();
    p
}

/// The raw driver error of a `ping` through the options `connect_spec` builds, or `Ok`.
async fn ping(spec: &ConnSpec, relax: bool) -> Result<(), mongodb::error::Error> {
    let mut input = SpecConnect::new(spec);
    input.tls_relax = relax;
    let (co, _, _) = build_spec_options(&input, &opts()).await.expect("options build");
    let client = Client::with_options(co).unwrap();
    let r = tokio::time::timeout(Duration::from_secs(20), client.database("admin").run_command(doc! { "ping": 1 })).await.expect("ping finished").map(|_| ());
    client.shutdown().await;
    r
}

/// Expects the failure `code` through both routes: the raw driver error (`classify`) and the scrubbed text a `Session`
/// returns (`classify_text`, which is what the studio sees).
async fn expect_code(spec: &ConnSpec, relax: bool, mut c: Ctx, code: &str) {
    assert!(COVERED.iter().any(|(k, _)| *k == code) || KNOWN_GAPS.contains(&code), "{code} is not listed in COVERED or KNOWN_GAPS");
    c.relaxed = relax;
    let err = ping(spec, relax).await.expect_err("the scenario must fail");
    let d = classify(&err, &c);
    assert_eq!(d.code, code, "raw driver error classified wrongly; detail: {}", d.detail);
    let mut input = SpecConnect::new(spec);
    input.tls_relax = relax;
    let s = Session::connect_spec(input, opts()).await.expect("lazy connect");
    let e = s.probe().await.expect_err("probe must fail");
    let t = classify_text(&e.to_string(), &c);
    assert_eq!(t.code, code, "session text classified wrongly: {e}");
    s.close();
}

async fn expect_ok(spec: &ConnSpec, relax: bool) {
    ping(spec, relax).await.expect("ping must succeed");
    let mut input = SpecConnect::new(spec);
    input.tls_relax = relax;
    let s = Session::connect_spec(input, opts()).await.unwrap();
    let probe = s.probe().await.expect("probe must succeed");
    assert_eq!(probe.server_version, "7.0.0");
    s.close();
}

struct World {
    dir: tempfile::TempDir,
    pki: Pki,
}

fn world() -> World {
    World { dir: tempfile::tempdir().unwrap(), pki: Pki::new("T14a test CA") }
}

impl World {
    fn ca(&self) -> PathBuf {
        write(self.dir.path(), "ca.pem", &self.pki.ca_pem)
    }
    async fn tls(&self, names: Names) -> Fake {
        servers::spawn_tls(server_config(&self.pki.server(names), None)).await
    }
}

// ---- control: the happy path really works ------------------------------------------------------------------------

#[tokio::test]
async fn trusted_chain_with_matching_name_connects() {
    let w = world();
    let f = w.tls(Names::Loopback).await;
    expect_ok(&spec("127.0.0.1", f.port, TlsMode::On, Some(&w.ca())), false).await;
}

#[tokio::test]
async fn plain_server_connects_with_tls_off() {
    let f = servers::spawn_plain().await;
    expect_ok(&spec("127.0.0.1", f.port, TlsMode::Off, None), false).await;
}

// ---- TLS scenarios ------------------------------------------------------------------------------------------------

#[tokio::test]
async fn unknown_issuer() {
    let w = world();
    let f = w.tls(Names::Loopback).await;
    let s = spec("127.0.0.1", f.port, TlsMode::On, None);
    expect_code(&s, false, ctx(&s), "tls.unknownIssuer").await;
}

#[tokio::test]
async fn wrong_hostname() {
    let w = world();
    let f = w.tls(Names::Dns("other.example.test")).await;
    let s = spec("127.0.0.1", f.port, TlsMode::On, Some(&w.ca()));
    expect_code(&s, false, ctx(&s), "tls.hostname").await;
}

#[tokio::test]
async fn expired_certificate() {
    let w = world();
    let f = servers::spawn_tls(server_config(&w.pki.expired_server(Names::Loopback), None)).await;
    let s = spec("127.0.0.1", f.port, TlsMode::On, Some(&w.ca()));
    expect_code(&s, false, ctx(&s), "tls.expired").await;
}

#[tokio::test]
async fn client_certificate_required() {
    let w = world();
    let f = servers::spawn_tls(server_config(&w.pki.server(Names::Loopback), Some(&w.pki))).await;
    let s = spec("127.0.0.1", f.port, TlsMode::On, Some(&w.ca()));
    expect_code(&s, false, ctx(&s), "tls.clientCertRequired").await;
}

#[tokio::test]
async fn client_certificate_presented_connects() {
    let w = world();
    let f = servers::spawn_tls(server_config(&w.pki.server(Names::Loopback), Some(&w.pki))).await;
    let mut s = spec("127.0.0.1", f.port, TlsMode::On, Some(&w.ca()));
    s.tls.client_cert_file = Some(write(w.dir.path(), "client.pem", &w.pki.client().combined_pem).to_string_lossy().into_owned());
    expect_ok(&s, false).await;
}

#[tokio::test]
async fn server_is_not_tls() {
    let f = servers::spawn_plain().await;
    let s = spec("127.0.0.1", f.port, TlsMode::On, None);
    expect_code(&s, false, ctx(&s), "tls.serverNotTls").await;
}

/// A TLS-only server answers a plain client in one of three ways, depending on its TLS stack: a macOS mongod closes (the
/// driver says `unexpected end of file`); an OpenSSL build may send a fatal alert record first (the driver reads its
/// 7 bytes as the start of a wire header and then hits the end of the stream). All three are the same diagnosis.
#[tokio::test]
async fn server_requires_tls() {
    use servers::PlainClient::{Alert, Close, ProtocolVersionAlert};
    let w = world();
    for how in [Alert, ProtocolVersionAlert, Close] {
        let f = servers::spawn_tls_reacting(server_config(&w.pki.server(Names::Loopback), None), how).await;
        let s = spec("127.0.0.1", f.port, TlsMode::Off, None);
        expect_code(&s, false, ctx(&s), "tls.serverRequiresTls").await;
    }
}

// ---- transport scenarios ------------------------------------------------------------------------------------------

#[tokio::test]
async fn closed_port_is_refused() {
    let port = servers::closed_port().await;
    let s = spec("127.0.0.1", port, TlsMode::Off, None);
    expect_code(&s, false, ctx(&s), "net.refused").await;
}

#[tokio::test]
async fn reset_connection() {
    let f = servers::spawn_reset().await;
    let s = spec("127.0.0.1", f.port, TlsMode::Off, None);
    expect_code(&s, false, ctx(&s), "net.reset").await;
}

#[tokio::test]
async fn silent_listener_times_out_in_server_selection() {
    let f = servers::spawn_silent().await;
    let s = spec("127.0.0.1", f.port, TlsMode::Off, None);
    expect_code(&s, false, ctx(&s), "select.noServer").await;
    assert!(f.accepted.load(std::sync::atomic::Ordering::SeqCst) >= 1, "the driver did reach the listener");
}

// ---- the rustls facts: Skip all certificate checks vs tlsAllowInvalidHostnames -----------------------------------

#[tokio::test]
async fn skip_all_certificate_checks_connects_to_the_wrong_hostname_server() {
    let w = world();
    let f = w.tls(Names::Dns("other.example.test")).await;
    // no CA file at all: unknown issuer AND wrong name; only `tlsAllowInvalidCertificates` gets through
    let s = spec("127.0.0.1", f.port, TlsMode::On, None);
    assert!(ping(&s, false).await.is_err());
    expect_ok(&s, true).await;
}

#[tokio::test]
async fn tls_allow_invalid_hostnames_is_a_no_op_under_rustls() {
    let w = world();
    let f = w.tls(Names::Dns("other.example.test")).await;
    let ca = w.ca();
    let uri = format!("mongodb://127.0.0.1:{}/?tls=true&tlsCAFile={}&tlsAllowInvalidHostnames=true&serverSelectionTimeoutMS=1500&connectTimeoutMS=1500", f.port, ca.display());
    // With this build (rustls only) the driver does not even accept the option, so it can never switch the name check off.
    let e = mongodb::options::ClientOptions::parse(uri.as_str()).await.expect_err("the option is not available");
    assert!(e.to_string().to_ascii_lowercase().contains("tlsallowinvalidhostnames"), "{e}");
    // The same server with the option left out: the name is checked and refused.
    let s = spec("127.0.0.1", f.port, TlsMode::On, Some(&ca));
    expect_code(&s, false, ctx(&s), "tls.hostname").await;
}

// ---- SOCKS5 fake in front of the TLS server -----------------------------------------------------------------------

fn proxied(host: &str, socks: u16, ca: &Path) -> ConnSpec {
    let mut s = spec(host, 27017, TlsMode::On, Some(ca));
    s.tunnel = Tunnel::Socks5(ProxySpec { host: "127.0.0.1".into(), port: socks, username: None, save_password: false });
    s
}

#[tokio::test]
async fn hostname_verification_stays_on_over_socks5() {
    let w = world();
    // the certificate is for db.good.test
    let tls = w.tls(Names::Dns("db.good.test")).await;
    let proxy = spawn_socks5(tls.port).await;
    let ca = w.ca();

    expect_ok(&proxied("db.good.test", proxy.port, &ca), false).await;
    {
        let seen = proxy.requests.lock().unwrap();
        assert!(!seen.is_empty());
        assert!(seen.iter().all(|(atyp, host, _)| *atyp == 3 && host == "db.good.test"), "the driver must hand the NAME to the proxy: {seen:?}");
    }

    // the same server under another name: the proxy happily connects, the certificate check must still refuse
    let bad = proxied("db.evil.test", proxy.port, &ca);
    expect_code(&bad, false, ctx(&bad), "tls.hostname").await;
    assert!(proxy.requests.lock().unwrap().iter().any(|(_, h, _)| h == "db.evil.test"));
}

// ---- bookkeeping: what is proven, what is not --------------------------------------------------------------------

#[test]
fn every_code_is_covered_or_declared_real_server_only_or_owned_elsewhere() {
    for (c, _) in COVERED {
        assert!(diagnose::ALL_CODES.contains(c), "{c} is not a diagnosis code");
        assert!(!REAL_SERVER_ONLY.contains(c), "{c} cannot be both fake-covered and real-server-only");
    }
    for c in REAL_SERVER_ONLY {
        assert!(diagnose::ALL_CODES.contains(c), "{c} is not a diagnosis code");
    }
    // Codes proven elsewhere: config.* (pipeline, T6c), tunnel.* (T4a-T4c, fake ssh), dns.* (needs a resolver),
    // net.timeout/net.unreachable (needs a routing black hole), timeout.total (pipeline budget), tls.pem.
    let elsewhere = |c: &str| matches!(c.split('.').next(), Some("config" | "tunnel" | "dns")) || ["net.timeout", "net.unreachable", "timeout.total", "tls.pem", "other"].contains(&c);
    let open: Vec<&&str> = diagnose::ALL_CODES.iter().filter(|c| !COVERED.iter().any(|(k, _)| k == *c) && !REAL_SERVER_ONLY.contains(c) && !KNOWN_GAPS.contains(c) && !elsewhere(c)).collect();
    assert!(open.is_empty(), "codes with no declared proof: {open:?}");
    eprintln!("T14a fakes: {} codes proven by fakes, {} known gaps (ignored tests), {} real-server-only", COVERED.len(), KNOWN_GAPS.len(), REAL_SERVER_ONLY.len());
}
