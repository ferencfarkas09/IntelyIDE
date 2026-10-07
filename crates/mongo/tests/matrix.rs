//! T14b: the Docker fixture matrix (spec section 10). The containers come from `scripts/mongo-fixture/matrix.sh up`; every
//! test here skips with a printed, counted reason (`MATRIX-SKIP`) when `INTELY_MONGO_MATRIX` or the `INTELY_MONGO_FX_*`
//! variables are missing or Docker is unusable. **A skipped test is not a PASS**: `matrix_header` prints the counts.
//!
//! Run: `eval "$(scripts/mongo-fixture/matrix.sh up)"` (`INTELY_MATRIX_BACKEND=local` for the Docker-free backend) then
//! `INTELY_MONGO_MATRIX=1 nice -n 10 cargo test -p intely-mongo --features mongo --test matrix -j 2 -- --test-threads=1`.
//! With `INTELY_MONGO_COLLECT=<file>` every asserted failure is also appended as a real corpus entry
//! (`scripts/mongo-fixture/collect-errors.sh` turns that into `golden/diagnose.real.json`).
//!
//! Verified against real `mongod` 8.0.32 processes and a user-level sshd (`scripts/mongo-fixture/local.sh`, no Docker): see
//! `(design notes: mongo-live-report)`. The Docker backend (`matrix.sh up`) produces the same variables but has not been run on this machine.
#![cfg(feature = "mongo")]

mod fixtures;

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use bson::doc;
use intely_mongo::api::HostKeyStatus;
use intely_mongo::connspec::{AuthMechanism, ConnSpec, HostPort, SshSpec, TlsMode, Tunnel, TunnelAuth};
use intely_mongo::diagnose::{self, classify, classify_text, Ctx};
use intely_mongo::driver::{build_spec_options, CancelToken, ProxyEndpoint, Session, SessionOpts, SpecConnect};
use intely_mongo::jail::{Jail, NetworkPolicy};
use intely_mongo::tunnel::ssh::{self, EnvInputs, SshCtx, SystemRunner};
use intely_mongo::tunnel::{knownhosts, AllowList, TunnelEnv, TunnelSecrets};
use intely_mongo::types::ReadCommand;
use intely_settings::Secret;
use mongodb::Client;
use serde_json::json;

use fixtures::{record, require, Fx};

const DB: &str = "shop";

// ---- helpers -------------------------------------------------------------------------------------------------------

fn spec(port: u16) -> ConnSpec {
    let mut s = ConnSpec::default();
    s.hosts = vec![HostPort { host: "127.0.0.1".into(), port: Some(port) }];
    s.database = Some(DB.into());
    s.timeouts.connect_ms = Some(2_000);
    s.timeouts.server_selection_ms = Some(2_500);
    s
}

fn user(s: &mut ConnSpec, name: &str, source: &str) {
    s.auth.username = Some(name.into());
    s.auth.source = Some(source.into());
}

fn tls(s: &mut ConnSpec, ca: Option<&Path>, client: Option<&Path>) {
    s.tls.mode = TlsMode::On;
    s.tls.ca_file = ca.map(|p| p.to_string_lossy().into_owned());
    s.tls.client_cert_file = client.map(|p| p.to_string_lossy().into_owned());
}

fn ctx(s: &ConnSpec, relaxed: bool) -> Ctx {
    Ctx {
        hosts: s.hosts.iter().map(|h| h.host.clone()).collect(),
        tls_mode: s.tls.mode,
        has_ca: s.tls.ca_file.is_some(),
        has_client_cert: s.tls.client_cert_file.is_some(),
        tunnel: match s.tunnel {
            Tunnel::Ssh(_) => "ssh",
            Tunnel::Socks5(_) => "socks5",
            Tunnel::None => "none",
        },
        relaxed,
        ..Ctx::default()
    }
}

fn ctx_json(s: &ConnSpec, relaxed: bool) -> serde_json::Value {
    json!({
        "hosts": s.hosts.iter().map(|h| h.host.clone()).collect::<Vec<_>>(),
        "tlsMode": match s.tls.mode { TlsMode::On => "on", TlsMode::Off => "off", TlsMode::Auto => "auto" },
        "hasCa": s.tls.ca_file.is_some(),
        "hasClientCert": s.tls.client_cert_file.is_some(),
        "tunnel": ctx(s, relaxed).tunnel,
        "relaxed": relaxed,
    })
}

/// The corpus `hint` string of a driver error (the same mapping `diagnose::classify` applies); kinds the corpus format has
/// no spelling for are recorded as `none`, which classifies by text.
fn hint_name(err: &mongodb::error::Error) -> &'static str {
    use mongodb::error::ErrorKind as K;
    use std::io::ErrorKind as E;
    match &*err.kind {
        K::DnsResolve { .. } => "dns",
        K::InvalidTlsConfig { .. } => "invalidTls",
        K::Authentication { .. } => "auth",
        K::ServerSelection { .. } => "selection",
        K::ProxyConnect { .. } => "proxy",
        K::Io(e) => match e.kind() {
            E::ConnectionRefused => "io:refused",
            E::TimedOut => "io:timedout",
            E::NetworkUnreachable => "io:unreachable",
            _ => "none",
        },
        K::Command(c) => Box::leak(format!("command:{}", c.code).into_boxed_str()),
        _ => "none",
    }
}

#[derive(Default)]
struct Creds {
    password: Option<Secret>,
    key_password: Option<Secret>,
    relax: bool,
}

fn input<'a>(s: &'a ConnSpec, c: &'a Creds) -> SpecConnect<'a> {
    let mut i = SpecConnect::new(s);
    i.password = c.password.as_ref();
    i.key_password = c.key_password.as_ref();
    i.tls_relax = c.relax;
    i
}

fn opts() -> SessionOpts {
    SessionOpts { allow_remote: true, ..SessionOpts::default() }
}

/// A raw driver `ping` through the options `connect_spec` builds.
async fn ping(s: &ConnSpec, c: &Creds) -> Result<(), mongodb::error::Error> {
    let (co, _, _) = build_spec_options(&input(s, c), &opts()).await.expect("options build");
    let client = Client::with_options(co).unwrap();
    let r = tokio::time::timeout(Duration::from_secs(30), client.database("admin").run_command(doc! { "ping": 1 })).await.expect("ping finished").map(|_| ());
    client.shutdown().await;
    r
}

/// The scenario must fail with `code`, through the raw driver error and through the scrubbed text a `Session` returns.
async fn expect_code(fx: &Fx, name: &str, s: &ConnSpec, c: &Creds, code: &str) {
    let err = ping(s, c).await.expect_err(&format!("{}: {name} must fail", fx.test));
    let cx = ctx(s, c.relax);
    let d = classify(&err, &cx);
    assert_eq!(d.code, code, "{name}: raw driver error classified wrongly; detail: {}", d.detail);
    record(name, hint_name(&err), &err.to_string(), ctx_json(s, c.relax), code);
    let sess = Session::connect_spec(input(s, c), opts()).await.expect("lazy connect");
    let e = sess.probe().await.expect_err("probe must fail");
    assert_eq!(classify_text(&e.to_string(), &cx).code, code, "{name}: session text classified wrongly: {e}");
    sess.close();
}

async fn connect_ok(s: &ConnSpec, c: &Creds) -> Session {
    ping(s, c).await.expect("ping must succeed");
    let sess = Session::connect_spec(input(s, c), opts()).await.expect("connect");
    sess.probe().await.expect("probe must succeed");
    sess
}

async fn run(sess: &Session, cmd: ReadCommand) -> intely_mongo::driver::RunResult {
    sess.run(&cmd, &CancelToken::new()).await.expect("read command")
}

fn find(coll: &str, limit: i64) -> ReadCommand {
    ReadCommand::Find { db: DB.into(), collection: coll.into(), filter: String::new(), projection: None, sort: None, skip: None, limit: Some(limit) }
}

/// The Docker backend runs `mongo:7`; the local backend publishes the exact version it started in `MONGOD_VERSION`.
fn assert_server_version(got: &str) {
    match fixtures::var("MONGOD_VERSION") {
        Some(want) => assert_eq!(got, want, "the fixture server version"),
        None => assert!(got.starts_with('7'), "mongo:7 expected, got {got}"),
    }
}

fn secret(fx: &Fx, name: &str) -> Secret {
    Secret::new(fx.var(name))
}

// ---- always-run tests ----------------------------------------------------------------------------------------------

#[test]
fn matrix_header_reports_what_will_not_run() {
    eprintln!("matrix enabled: {}", fixtures::matrix_enabled());
    if !fixtures::matrix_enabled() {
        eprintln!("MATRIX-SKIP all: INTELY_MONGO_MATRIX is not set; every fixture test below reports its own skip (not a PASS)");
    }
}

#[test]
fn skips_are_counted_never_passed() {
    let before = fixtures::skipped();
    let r: Option<()> = fixtures::skip("self-test", "reason");
    assert!(r.is_none());
    // the counter is process-global: another test thread may skip in between, so only a lower bound is stable
    assert!(fixtures::skipped() > before);
    // the codes this matrix can only prove with a real server (kept in sync with the tests below)
    for code in REAL_SERVER_CODES {
        assert!(diagnose::ALL_CODES.contains(code), "{code} is not a catalogue code");
    }
}

/// Codes whose only real evidence is a run of this matrix (T14a has no fake for them).
const REAL_SERVER_CODES: &[&str] = &[
    "auth.failed", "auth.x509Subject", "authz.collection", "select.replicaSetName", "tls.clientCertRequired", "tls.hostname",
    "tls.unknownIssuer", "tls.serverNotTls", "tls.serverRequiresTls", "tunnel.forwardingDisabled", "tunnel.hostKeyUnknown",
];

#[test]
fn record_writes_one_json_line_per_failure_only_when_asked() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("collect.jsonl");
    // no variable: nothing written (the variable is process-wide, so set it only around the call)
    let previous = std::env::var_os("INTELY_MONGO_COLLECT");
    std::env::remove_var("INTELY_MONGO_COLLECT");
    record("a", "none", "text", json!({}), "other");
    assert!(!file.exists());
    // other tests of this binary may be collecting into the caller's file: put the caller's value back afterwards
    std::env::set_var("INTELY_MONGO_COLLECT", &file);
    record("b", "io:refused", "Connection refused", json!({"hosts": ["127.0.0.1"]}), "net.refused");
    match previous {
        Some(v) => std::env::set_var("INTELY_MONGO_COLLECT", v),
        None => std::env::remove_var("INTELY_MONGO_COLLECT"),
    }
    let text = std::fs::read_to_string(&file).unwrap();
    let v: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    assert_eq!((v["name"].as_str(), v["source"].as_str(), v["code"].as_str()), (Some("b"), Some("real"), Some("net.refused")));
    assert_eq!(text.lines().count(), 1);
}

// ---- standalone ----------------------------------------------------------------------------------------------------

#[tokio::test]
async fn standalone_reads_the_generic_seed() {
    let Some(fx) = require("standalone_reads_the_generic_seed", &["STANDALONE_PORT"]) else { return };
    let s = spec(fx.port("STANDALONE_PORT"));
    let sess = connect_ok(&s, &Creds::default()).await;
    let p = sess.probe().await.unwrap();
    assert_server_version(&p.server_version);
    let cols = run(&sess, ReadCommand::ListCollections { db: DB.into() }).await;
    for name in ["products", "orders", "customers"] {
        assert!(cols.docs.iter().any(|d| d.contains(name)), "collection {name} missing: {:?}", cols.docs);
    }
    assert_eq!(run(&sess, find("products", 50)).await.docs.len(), 10);
    sess.close();
}

#[tokio::test]
async fn plain_client_against_a_closed_port_is_refused() {
    let Some(fx) = require("plain_client_against_a_closed_port_is_refused", &["STANDALONE_PORT"]) else { return };
    // a port that was just free: bind and drop
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    expect_code(&fx, "real net.refused (closed loopback port)", &spec(port), &Creds::default(), "net.refused").await;
}

// ---- auth ----------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn auth_read_user_signs_in_and_reads() {
    let Some(fx) = require("auth_read_user_signs_in_and_reads", &["AUTH_PORT", "AUTH_RO_PW"]) else { return };
    let mut s = spec(fx.port("AUTH_PORT"));
    user(&mut s, "ro", "admin");
    let c = Creds { password: Some(secret(&fx, "AUTH_RO_PW")), ..Creds::default() };
    let sess = connect_ok(&s, &c).await;
    assert!(!run(&sess, find("orders", 5)).await.docs.is_empty());
    sess.close();
}

#[tokio::test]
async fn auth_wrong_password_is_auth_failed() {
    let Some(fx) = require("auth_wrong_password_is_auth_failed", &["AUTH_PORT"]) else { return };
    let mut s = spec(fx.port("AUTH_PORT"));
    user(&mut s, "ro", "admin");
    let c = Creds { password: Some(Secret::new("definitely-not-the-password")), ..Creds::default() };
    expect_code(&fx, "real auth.failed (wrong password)", &s, &c, "auth.failed").await;
}

#[tokio::test]
async fn auth_restricted_user_is_refused_outside_its_grant() {
    let Some(fx) = require("auth_restricted_user_is_refused_outside_its_grant", &["AUTH_PORT", "AUTH_RESTRICTED_PW"]) else { return };
    let mut s = spec(fx.port("AUTH_PORT"));
    user(&mut s, "restricted", "admin");
    let c = Creds { password: Some(secret(&fx, "AUTH_RESTRICTED_PW")), ..Creds::default() };
    let sess = connect_ok(&s, &c).await;
    assert!(!run(&sess, find("orders", 3)).await.docs.is_empty(), "the granted collection must be readable");
    let err = sess.run(&find("products", 3), &CancelToken::new()).await.expect_err("outside the grant");
    let text = err.to_string();
    let d = classify_text(&text, &ctx(&s, false));
    assert_eq!(d.code, "authz.collection", "detail: {}", d.detail);
    record("real authz.collection (find outside the grant)", "none", &text, ctx_json(&s, false), "authz.collection");
    sess.close();
}

#[tokio::test]
async fn auth_any_read_user_lists_databases() {
    let Some(fx) = require("auth_any_read_user_lists_databases", &["AUTH_PORT", "AUTH_ANYREAD_PW"]) else { return };
    let mut s = spec(fx.port("AUTH_PORT"));
    user(&mut s, "anyread", "admin");
    let c = Creds { password: Some(secret(&fx, "AUTH_ANYREAD_PW")), ..Creds::default() };
    let sess = connect_ok(&s, &c).await;
    assert!(run(&sess, ReadCommand::ListDatabases).await.docs.iter().any(|d| d.contains(DB)));
    sess.close();
}

// ---- replica set ---------------------------------------------------------------------------------------------------

#[tokio::test]
async fn replica_set_discovery_direct_and_wrong_name() {
    let Some(fx) = require("replica_set_discovery_direct_and_wrong_name", &["RS_PORT", "RS_NAME"]) else { return };
    let mut s = spec(fx.port("RS_PORT"));
    s.topology.replica_set = Some(fx.var("RS_NAME"));
    let sess = connect_ok(&s, &Creds::default()).await;
    assert!(!run(&sess, find("products", 1)).await.docs.is_empty());
    sess.close();
    let mut direct = spec(fx.port("RS_PORT"));
    direct.topology.direct_connection = Some(true);
    connect_ok(&direct, &Creds::default()).await.close();
    let mut wrong = spec(fx.port("RS_PORT"));
    wrong.topology.replica_set = Some("not-rs0".into());
    expect_code(&fx, "real select.replicaSetName (name differs)", &wrong, &Creds::default(), "select.replicaSetName").await;
}

/// The three seeds of the real `rs0` and the name, as a spec that runs topology discovery.
fn rs_spec(fx: &Fx) -> (ConnSpec, Vec<String>) {
    let ports: Vec<u16> = fx.var("RS_PORTS").split(',').map(|p| p.parse().unwrap()).collect();
    assert!(ports.len() >= 3, "the fixture is a three-member set: {ports:?}");
    let mut s = spec(ports[0]);
    s.hosts = ports.iter().map(|p| HostPort { host: "127.0.0.1".into(), port: Some(*p) }).collect();
    s.topology.replica_set = Some(fx.var("RS_NAME"));
    let mut members: Vec<String> = ports.iter().map(|p| format!("127.0.0.1:{p}")).collect();
    members.sort();
    (s, members)
}

fn jailed() -> SessionOpts {
    SessionOpts { allow_remote: true, preflight_members: true, ..SessionOpts::default() }
}

#[tokio::test]
async fn replica_set_preflight_lets_the_real_three_member_set_through_and_the_probe_lists_its_members() {
    let Some(fx) = require("replica_set_preflight_lets_the_real_three_member_set_through_and_the_probe_lists_its_members", &["RS_PORTS", "RS_NAME"]) else { return };
    let (s, want) = rs_spec(&fx);
    // three loopback seeds and the name: discovery is on, the pre-flight asks every seed first and finds only loopback members
    let sess = Session::connect_spec(input(&s, &Creds::default()), jailed()).await.expect("the pre-flight passes the real set");
    let probe = sess.probe().await.expect("probe");
    assert_eq!(probe.topology, "replicaSet");
    let mut got = probe.members.clone();
    got.sort();
    assert_eq!(got, want, "Probe.members is hello.hosts");
    assert!(!probe.remote_members);
    assert!(!run(&sess, find("products", 1)).await.docs.is_empty());
    sess.close();
    // one seed with discovery switched on by hand: the pre-flight runs on that seed and sees the same three members
    let mut one = spec(s.hosts[0].port.unwrap());
    one.topology.replica_set = s.topology.replica_set.clone();
    one.topology.direct_connection = Some(false);
    let sess = Session::connect_spec(input(&one, &Creds::default()), jailed()).await.expect("a single seed with directConnection=false");
    let mut got = sess.probe().await.expect("probe").members;
    got.sort();
    assert_eq!(got, want);
    sess.close();
    // a seed that is a secondary is asked too; a wrong replica-set name is the driver's business, not the pre-flight's
    let mut wrong = s.clone();
    wrong.topology.replica_set = Some("not-rs0".into());
    let sess = Session::connect_spec(input(&wrong, &Creds::default()), jailed()).await.expect("the pre-flight ignores the set name");
    let e = sess.probe().await.expect_err("the real client still refuses the mismatch");
    let code = classify_text(&e.to_string(), &ctx(&wrong, false)).code;
    assert!(code == "select.replicaSetName" || code == "select.noServer", "{code}: {e}");
    sess.close();
}

#[tokio::test]
async fn the_test_pipeline_fills_the_members_of_a_real_replica_set_under_the_e2e_jail() {
    let Some(fx) = require("the_test_pipeline_fills_the_members_of_a_real_replica_set_under_the_e2e_jail", &["RS_PORTS", "RS_NAME"]) else { return };
    let (s, want) = rs_spec(&fx);
    let dir = tempfile::tempdir().unwrap();
    let settings = Arc::new(intely_settings::SettingsStore::open(dir.path().join("settings.json")).unwrap());
    let studio = intely_mongo::studio::Studio::new(Arc::new(intely_mongo::profile::ProfileStore::new(settings, Arc::new(intely_settings::MemorySecretStore::new()))), NetworkPolicy::LoopbackOnly);
    studio.set_enabled(true).unwrap();
    let input = intely_mongo::api::ProfileInput { name: "rs0".into(), environment: intely_mongo::api::Environment::Local, spec: Some(s), ..Default::default() };
    let r = studio.test_with(input, "t-rs0").await.expect("report");
    assert!(r.ok, "{r:?}");
    let mut got = r.members.clone();
    got.sort();
    assert_eq!(got, want, "TestReport.members carries hello.hosts (the \"Allow these N hosts\" dialog reads it)");
}

#[tokio::test]
async fn auth_a_restricted_user_lists_only_the_databases_it_may_read() {
    let Some(fx) = require("auth_a_restricted_user_lists_only_the_databases_it_may_read", &["AUTH_PORT", "AUTH_RESTRICTED_PW"]) else { return };
    let mut s = spec(fx.port("AUTH_PORT"));
    user(&mut s, "restricted", "admin");
    let c = Creds { password: Some(secret(&fx, "AUTH_RESTRICTED_PW")), ..Creds::default() };
    // the server alone (raw driver): `authorizedDatabases: true` lists the databases this user may read, and only those. Since 4.0.5
    // a server answers the same way when the option is left out, but older ones and some hosted roles refuse the plain listing, so
    // the Studio asks for it explicitly.
    let (co, _, _) = build_spec_options(&input(&s, &c), &opts()).await.expect("options");
    let raw = Client::with_options(co).unwrap();
    let allowed = raw.database("admin").run_command(doc! { "listDatabases": 1, "nameOnly": true, "authorizedDatabases": true }).await.expect("authorizedDatabases: true is allowed for a restricted user");
    let listed: Vec<String> = allowed.get_array("databases").unwrap().iter().filter_map(|d| d.as_document().and_then(|d| d.get_str("name").ok()).map(str::to_string)).collect();
    assert!(listed.iter().any(|n| n == DB), "{listed:?}");
    assert!(!listed.iter().any(|n| n == "admin" || n == "local"), "only the authorized databases: {listed:?}");
    raw.shutdown().await;
    // ...and the Studio's own listing asks for the authorized ones, so it works for this user and shows only what it may read
    let sess = connect_ok(&s, &c).await;
    let names = run(&sess, ReadCommand::ListDatabases).await.docs;
    assert!(names.iter().any(|d| d.contains(DB)), "{names:?}");
    assert!(!names.iter().any(|d| d.contains("\"admin\"") || d.contains("\"local\"")), "only authorized databases: {names:?}");
    sess.close();
}

// ---- TLS -----------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn tls_ca_file_connects_and_missing_ca_is_unknown_issuer() {
    let Some(fx) = require("tls_ca_file_connects_and_missing_ca_is_unknown_issuer", &["TLS_PORT", "TLS_DIR"]) else { return };
    let mut ok = spec(fx.port("TLS_PORT"));
    tls(&mut ok, Some(&fx.tls_file("ca.pem")), None);
    connect_ok(&ok, &Creds::default()).await.close();
    let mut no_ca = spec(fx.port("TLS_PORT"));
    tls(&mut no_ca, None, None);
    expect_code(&fx, "real tls.unknownIssuer (private CA not given)", &no_ca, &Creds::default(), "tls.unknownIssuer").await;
}

#[tokio::test]
async fn tls_certificate_for_another_name_fails_until_certificates_are_skipped() {
    let Some(fx) = require("tls_certificate_for_another_name_fails_until_certificates_are_skipped", &["TLS_WRONG_PORT", "TLS_DIR"]) else { return };
    let mut s = spec(fx.port("TLS_WRONG_PORT"));
    tls(&mut s, Some(&fx.tls_file("ca.pem")), None);
    expect_code(&fx, "real tls.hostname (certificate for other.example)", &s, &Creds::default(), "tls.hostname").await;
    // only "skip all certificate checks" connects: the rustls build has no hostname-only relax
    connect_ok(&s, &Creds { relax: true, ..Creds::default() }).await.close();
}

#[tokio::test]
async fn tls_mode_mismatches_are_named() {
    let Some(fx) = require("tls_mode_mismatches_are_named", &["TLS_PORT", "STANDALONE_PORT"]) else { return };
    let mut off = spec(fx.port("TLS_PORT"));
    off.tls.mode = TlsMode::Off;
    expect_code(&fx, "real tls.serverRequiresTls (plain client, TLS server)", &off, &Creds::default(), "tls.serverRequiresTls").await;
    let mut on = spec(fx.port("STANDALONE_PORT"));
    tls(&mut on, None, None);
    expect_code(&fx, "real tls.serverNotTls (TLS client, plain server)", &on, &Creds::default(), "tls.serverNotTls").await;
}

// ---- x509 ----------------------------------------------------------------------------------------------------------

fn x509_spec(fx: &Fx, client: &str) -> ConnSpec {
    let mut s = spec(fx.port("X509_PORT"));
    s.auth.mechanism = AuthMechanism::X509;
    s.auth.source = Some("$external".into());
    tls(&mut s, Some(&fx.tls_file("ca.pem")), Some(&fx.tls_file(client)));
    s
}

#[tokio::test]
async fn x509_client_certificate_signs_in_plain_and_encrypted() {
    let Some(fx) = require("x509_client_certificate_signs_in_plain_and_encrypted", &["X509_PORT", "TLS_DIR", "TLS_KEY_PASS"]) else { return };
    let sess = connect_ok(&x509_spec(&fx, "client.pem"), &Creds::default()).await;
    assert!(!run(&sess, find("products", 1)).await.docs.is_empty());
    sess.close();
    // encrypted PKCS#8 key: needs the `cert-key-password` feature and the passphrase from the Keychain
    let enc = Creds { key_password: Some(secret(&fx, "TLS_KEY_PASS")), ..Creds::default() };
    connect_ok(&x509_spec(&fx, "client-enc.pem"), &enc).await.close();
}

#[tokio::test]
async fn x509_missing_certificate_and_unknown_subject() {
    let Some(fx) = require("x509_missing_certificate_and_unknown_subject", &["X509_PORT", "TLS_DIR"]) else { return };
    let mut none = spec(fx.port("X509_PORT"));
    tls(&mut none, Some(&fx.tls_file("ca.pem")), None);
    expect_code(&fx, "real tls.clientCertRequired (server demands a certificate)", &none, &Creds::default(), "tls.clientCertRequired").await;
    expect_code(&fx, "real auth.x509Subject (certificate subject is no user)", &x509_spec(&fx, "client-other.pem"), &Creds::default(), "auth.x509Subject").await;
}

// ---- compression ---------------------------------------------------------------------------------------------------

#[tokio::test]
async fn compression_each_compiled_compressor_connects() {
    let Some(fx) = require("compression_each_compiled_compressor_connects", &["COMPRESS_PORT"]) else { return };
    for c in intely_mongo::connspec::COMPILED_COMPRESSORS {
        let mut s = spec(fx.port("COMPRESS_PORT"));
        s.compressors = vec![*c];
        let sess = connect_ok(&s, &Creds::default()).await;
        sess.close();
        eprintln!("compression {} connected", c.as_str());
    }
}

// ---- ssh bastion ---------------------------------------------------------------------------------------------------

struct SshWorld {
    root: tempfile::TempDir,
    /// Tunnel directories that existed before the test (other processes of this user may own some).
    before: std::collections::HashSet<String>,
}

/// Tunnel directories below the temp directory. The tunnel directory name plus ssh's own socket suffix only fits the macOS socket
/// path limit when the base is the temp directory itself (a nested test root would be moved to /tmp or fail), so the tests use it.
fn tunnel_dirs() -> std::collections::HashSet<String> {
    std::fs::read_dir(std::env::temp_dir()).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with(intely_mongo::tunnel::dir::PREFIX)).collect()).unwrap_or_default()
}

impl SshWorld {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("home")).unwrap();
        std::fs::create_dir_all(root.path().join("state")).unwrap();
        Self { root, before: tunnel_dirs() }
    }
    fn env(&self) -> TunnelEnv {
        let jail = Jail::new(NetworkPolicy::LoopbackOnly, &std::env::temp_dir(), Some(self.root.path()));
        let mut e = TunnelEnv::new(jail, self.root.path().join("state"));
        e.temp_dir = std::env::temp_dir();
        e.home = self.root.path().join("home");
        e.local_user = "tester".into();
        e.auth_sock = None;
        e.ssh_override = None;
        e.poll = Duration::from_millis(100);
        e
    }
    fn leftovers(&self) -> Vec<String> {
        tunnel_dirs().difference(&self.before).cloned().collect()
    }
}

fn ssh_spec(fx: &Fx, user: &str, auth: TunnelAuth) -> SshSpec {
    ssh_spec_on(fx, "SSH_PORT", user, auth)
}

/// The local backend cannot make a second ssh user without root: the "forwarding off" bastion is a second sshd on `SSH_NOFWD_PORT`.
fn ssh_spec_on(fx: &Fx, port_var: &str, user: &str, auth: TunnelAuth) -> SshSpec {
    let mut s = SshSpec { host: "127.0.0.1".into(), port: Some(fx.port(port_var)), user: user.into(), auth, ..Default::default() };
    if auth == TunnelAuth::KeyFile {
        s.key_file = Some(fx.var("SSH_KEY"));
    }
    s
}

fn db_host(fx: &Fx, var: &str) -> HostPort {
    let v = fx.var(var);
    let (h, p) = v.rsplit_once(':').expect("host:port");
    HostPort { host: h.into(), port: p.parse().ok() }
}

/// Trusts the bastion through the same code the UI uses (scan, compare with the published fingerprint, append to the
/// app-owned file only).
fn trust(w: &SshWorld, fx: &Fx, spec: &SshSpec, env: &TunnelEnv) {
    let bin = ssh::SshBinary::locate(NetworkPolicy::LoopbackOnly, None, &ssh::facts_of).expect("system ssh");
    let base = ssh::base_env(&EnvInputs { home: env.home.to_string_lossy().into_owned(), user: env.local_user.clone(), auth_sock: None });
    let ctx = SshCtx { runner: &SystemRunner, bin: &bin, jail: &env.jail, env: &base };
    let app = env.app_known_hosts();
    let report = knownhosts::inspect_host_key(&ctx, spec, &app, None).expect("inspect");
    assert_eq!(report.status, HostKeyStatus::Unknown, "a fresh app-owned file knows nobody");
    let seen = report.keys.iter().map(|k| k.fingerprint.clone()).collect::<Vec<_>>();
    assert!(seen.contains(&fx.var("SSH_HOSTKEY_FP")), "scanned {seen:?}, published {}", fx.var("SSH_HOSTKEY_FP"));
    let files = knownhosts::known_files(&app, None, ssh::config_off(spec, NetworkPolicy::LoopbackOnly));
    knownhosts::trust_host_key(&ctx, &report.resolved.hostname, report.resolved.port, &fx.var("SSH_HOSTKEY_FP"), &app, &files).expect("trust");
    let _ = w;
}

fn meta(p: &Path) -> Option<(u64, std::time::SystemTime)> {
    std::fs::metadata(p).ok().map(|m| (m.len(), m.modified().unwrap()))
}

/// Opens the tunnel and a session over the relay to a database host as the bastion sees it.
fn through_tunnel(ssh: SshSpec, target: HostPort, tls_ca: Option<&Path>) -> ConnSpec {
    let mut s = ConnSpec::default();
    s.hosts = vec![target];
    s.database = Some(DB.into());
    s.timeouts.connect_ms = Some(5_000);
    s.timeouts.server_selection_ms = Some(6_000);
    if let Some(ca) = tls_ca {
        tls(&mut s, Some(ca), None);
    }
    s.tunnel = Tunnel::Ssh(ssh);
    s
}

#[tokio::test]
async fn ssh_key_and_password_tunnels_reach_plain_and_tls_databases_and_leave_nothing() {
    let Some(fx) = require("ssh_key_and_password_tunnels", &["SSH_PORT", "SSH_USER", "SSH_KEY", "SSH_HOSTKEY_FP", "SSH_DB_HOST", "SSH_TLS_HOST", "TLS_DIR"]) else { return };
    let real_known = std::env::var("HOME").ok().map(|h| Path::new(&h).join(".ssh/known_hosts"));
    let before = real_known.as_deref().and_then(meta);
    let w = SshWorld::new();
    let env = w.env();
    let key_spec = ssh_spec(&fx, &fx.var("SSH_USER"), TunnelAuth::KeyFile);

    // 1. first contact: the host key is unknown, the tunnel refuses and the diagnosis names it
    let allow = AllowList { entries: vec![db_host(&fx, "SSH_DB_HOST"), db_host(&fx, "SSH_TLS_HOST")] };
    let err = intely_mongo::tunnel::Tunnel::open(&env, &key_spec, &TunnelSecrets::default(), allow.clone(), Arc::new(AtomicBool::new(false))).await.expect_err("unknown host key");
    assert_eq!(classify_text(&err.message, &Ctx { tunnel: "ssh", ..Ctx::default() }).code, "tunnel.hostKeyUnknown", "{err}");
    record("real tunnel.hostKeyUnknown (first contact)", "none", &err.message, json!({"tunnel": "ssh"}), "tunnel.hostKeyUnknown");
    assert!(w.leftovers().is_empty());

    // 2. trust through the UI code path, then key auth
    trust(&w, &fx, &key_spec, &env);
    for (label, target, ca) in [("plain", db_host(&fx, "SSH_DB_HOST"), None), ("tls", db_host(&fx, "SSH_TLS_HOST"), Some(fx.tls_file("ca.pem")))] {
        let tunnel = intely_mongo::tunnel::Tunnel::open(&env, &key_spec, &TunnelSecrets::default(), allow.clone(), Arc::new(AtomicBool::new(false))).await.unwrap_or_else(|e| panic!("{label}: {e}"));
        let ep = tunnel.proxy();
        let s = through_tunnel(key_spec.clone(), target, ca.as_deref());
        let mut input = SpecConnect::new(&s);
        input.relay = Some(ProxyEndpoint { host: "127.0.0.1".into(), port: ep.port, auth: Some((ep.user.clone(), Secret::new(ep.pass.clone()))) });
        let sess = Session::connect_spec(input, opts()).await.unwrap_or_else(|e| panic!("{label}: {e}"));
        let p = sess.probe().await.unwrap_or_else(|e| panic!("{label}: {e}"));
        assert_server_version(&p.server_version);
        // a tunnel always counts as Production-level, even to a database the bastion knows by a private name
        assert_ne!(p.level, intely_mongo::types::EffectiveLevel::Local, "{label}");
        assert!(!run(&sess, find("products", 1)).await.docs.is_empty());
        sess.close();
        tunnel.close().await;
        assert!(w.leftovers().is_empty(), "{label}: tunnel directory left behind: {:?}", w.leftovers());
    }

    // 3. a destination outside the allow-list is refused by the relay
    let narrow = AllowList { entries: vec![db_host(&fx, "SSH_DB_HOST")] };
    let tunnel = intely_mongo::tunnel::Tunnel::open(&env, &key_spec, &TunnelSecrets::default(), narrow, Arc::new(AtomicBool::new(false))).await.unwrap();
    let ep = tunnel.proxy();
    let s = through_tunnel(key_spec.clone(), db_host(&fx, "SSH_TLS_HOST"), Some(&fx.tls_file("ca.pem")));
    let mut input = SpecConnect::new(&s);
    input.relay = Some(ProxyEndpoint { host: "127.0.0.1".into(), port: ep.port, auth: Some((ep.user.clone(), Secret::new(ep.pass.clone()))) });
    let sess = Session::connect_spec(input, opts()).await.unwrap();
    assert!(sess.probe().await.is_err());
    assert!(!tunnel.refused().is_empty(), "the relay must record the refused destination");
    sess.close();
    tunnel.close().await;

    // 4. password auth (the askpass flow). The local backend's sshd runs without root and has no password to check: `local.sh` starts
    // a second SSH server (ssh-password-server.mjs, the node `ssh2` module, same host key) on `SSH_PW_PORT` when that module is found.
    // It is not OpenSSH's sshd; the Docker backend's sshd answers on `SSH_PORT` with `SSH_PASSWORD` and needs no `SSH_PW_PORT`.
    if fixtures::var("SSH_PASSWORD").is_none() {
        fixtures::skip::<()>("ssh_key_and_password_tunnels (password part)", "no INTELY_MONGO_FX_SSH_PASSWORD: no sshd with a password (the local backend needs the ssh2 node module, see local.sh 7b)");
    } else {
        let port_var = if fixtures::var("SSH_PW_PORT").is_some() { "SSH_PW_PORT" } else { "SSH_PORT" };
        let pw_spec = ssh_spec_on(&fx, port_var, &fx.var("SSH_USER"), TunnelAuth::Password);
        if port_var == "SSH_PW_PORT" {
            // its own port is a new host for known_hosts: trust it the way the UI does, with the same published fingerprint
            trust(&w, &fx, &pw_spec, &env);
        }
        let secrets = TunnelSecrets { ssh_secret: Some(secret(&fx, "SSH_PASSWORD")), ..Default::default() };
        let tunnel = intely_mongo::tunnel::Tunnel::open(&env, &pw_spec, &secrets, allow.clone(), Arc::new(AtomicBool::new(false))).await.expect("password tunnel");
        // the password tunnel really forwards: a database session through it reads
        let ep = tunnel.proxy();
        let s = through_tunnel(pw_spec.clone(), db_host(&fx, "SSH_DB_HOST"), None);
        let mut input = SpecConnect::new(&s);
        input.relay = Some(ProxyEndpoint { host: "127.0.0.1".into(), port: ep.port, auth: Some((ep.user.clone(), Secret::new(ep.pass.clone()))) });
        let sess = Session::connect_spec(input, opts()).await.expect("password tunnel session");
        sess.probe().await.expect("probe through the password tunnel");
        assert!(!run(&sess, find("products", 1)).await.docs.is_empty());
        sess.close();
        tunnel.close().await;
        let bad = TunnelSecrets { ssh_secret: Some(Secret::new("wrong-password")), ..Default::default() };
        let err = intely_mongo::tunnel::Tunnel::open(&env, &pw_spec, &bad, allow, Arc::new(AtomicBool::new(false))).await.expect_err("wrong password");
        let d = classify_text(&err.message, &Ctx { tunnel: "ssh", ..Ctx::default() });
        assert_eq!(d.code, "tunnel.auth", "{err}");
        record("real tunnel.auth (wrong ssh password)", "none", &err.message, json!({"tunnel": "ssh"}), "tunnel.auth");
        assert!(w.leftovers().is_empty());
    }

    // the real known_hosts of this user was never touched, and neither was an app-owned file outside the temp root
    assert_eq!(real_known.as_deref().and_then(meta), before, "the real ~/.ssh/known_hosts changed");
    assert!(env.app_known_hosts().starts_with(w.root.path()));
}

#[tokio::test]
async fn ssh_forwarding_disabled_user_is_named() {
    let Some(fx) = require("ssh_forwarding_disabled_user_is_named", &["SSH_PORT", "SSH_NOFWD_USER", "SSH_KEY", "SSH_HOSTKEY_FP", "SSH_DB_HOST"]) else { return };
    let w = SshWorld::new();
    let env = w.env();
    let spec = ssh_spec_on(&fx, if fixtures::var("SSH_NOFWD_PORT").is_some() { "SSH_NOFWD_PORT" } else { "SSH_PORT" }, &fx.var("SSH_NOFWD_USER"), TunnelAuth::KeyFile);
    trust(&w, &fx, &spec, &env);
    let allow = AllowList { entries: vec![db_host(&fx, "SSH_DB_HOST")] };
    let tunnel = intely_mongo::tunnel::Tunnel::open(&env, &spec, &TunnelSecrets::default(), allow, Arc::new(AtomicBool::new(false))).await.expect("the master itself connects");
    let ep = tunnel.proxy();
    let s = through_tunnel(spec.clone(), db_host(&fx, "SSH_DB_HOST"), None);
    let mut input = SpecConnect::new(&s);
    input.relay = Some(ProxyEndpoint { host: "127.0.0.1".into(), port: ep.port, auth: Some((ep.user.clone(), Secret::new(ep.pass.clone()))) });
    let sess = Session::connect_spec(input, opts()).await.unwrap();
    let e = sess.probe().await.expect_err("forwarding is disabled for this user");
    // the verdict comes from the stderr of a child and of the master, both read by other threads: give them a moment
    let mut code = None;
    for _ in 0..50 {
        code = tunnel.last_failure().and_then(|f| f.code);
        if code.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(code, Some("tunnel.forwardingDisabled"), "probe error: {e}");
    // the wording the master printed (OpenSSH 10, mux): the `-W` client itself only says "Stdio forwarding request failed"
    record("real tunnel.forwardingDisabled (AllowTcpForwarding no)", "none", "channel 2: open failed: administratively prohibited: open failed", json!({"tunnel": "ssh"}), "tunnel.forwardingDisabled");
    sess.close();
    tunnel.close().await;
    assert!(w.leftovers().is_empty());
}

// ---- real failure classes (live proof round: a real mongod, a real sshd, no fakes) -----------------------------------

#[tokio::test]
async fn tls_a_ca_file_that_did_not_sign_the_server_is_unknown_issuer() {
    let Some(fx) = require("tls_a_ca_file_that_did_not_sign_the_server_is_unknown_issuer", &["TLS_PORT", "TLS_DIR"]) else { return };
    let mut s = spec(fx.port("TLS_PORT"));
    tls(&mut s, Some(&fx.tls_file("ca-other.pem")), None);
    expect_code(&fx, "real tls.unknownIssuer (wrong CA file)", &s, &Creds::default(), "tls.unknownIssuer").await;
}

#[tokio::test]
async fn dns_a_name_that_does_not_resolve_is_named_for_plain_and_srv_hosts() {
    let Some(fx) = require("dns_a_name_that_does_not_resolve_is_named_for_plain_and_srv_hosts", &["STANDALONE_PORT"]) else { return };
    let mut plain = ConnSpec::default();
    plain.hosts = vec![HostPort { host: "intely-no-such-host.invalid".into(), port: Some(27017) }];
    plain.timeouts.connect_ms = Some(2_000);
    plain.timeouts.server_selection_ms = Some(2_500);
    expect_code(&fx, "real dns.notFound (plain host does not resolve)", &plain, &Creds::default(), "dns.notFound").await;
    // `mongodb+srv` resolves while the options are built: the DNS failure must not come back as a configuration error
    let mut srv = ConnSpec::default();
    srv.scheme = intely_mongo::connspec::Scheme::Srv;
    srv.hosts = vec![HostPort { host: "intely-no-such-cluster.invalid".into(), port: None }];
    let err = build_spec_options(&input(&srv, &Creds::default()), &opts()).await.expect_err("an SRV name that does not exist");
    let text = err.to_string();
    let d = classify_text(&text, &ctx(&srv, false));
    assert_eq!(d.code, "dns.srv", "{}: {text}", fx.test);
    record("real dns.srv (SRV record does not exist)", "none", &text, ctx_json(&srv, false), "dns.srv");
}

/// A loopback listener that answers whatever it is sent with an HTTP error and closes: "the port is open but it is not MongoDB".
fn http_speaker() -> u16 {
    use std::io::{Read, Write};
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for c in l.incoming().flatten().take(8) {
            let mut c = c;
            let mut buf = [0u8; 512];
            let _ = c.set_read_timeout(Some(Duration::from_millis(500)));
            let _ = c.read(&mut buf);
            let _ = c.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
    });
    port
}

#[tokio::test]
async fn a_port_that_speaks_another_protocol_is_not_reported_as_a_closed_port() {
    let Some(fx) = require("a_port_that_speaks_another_protocol_is_not_reported_as_a_closed_port", &["STANDALONE_PORT"]) else { return };
    let s = spec(http_speaker());
    let err = ping(&s, &Creds::default()).await.expect_err("an HTTP speaker is not a mongod");
    let d = classify(&err, &ctx(&s, false));
    record("real wrong port (the port speaks HTTP)", hint_name(&err), &err.to_string(), ctx_json(&s, false), &d.code);
    // there is no catalogue code for "this is not MongoDB" (a new code needs every locale catalogue): the generic selection
    // verdict carries the driver's own words, which must reach the user
    assert!(!matches!(d.code.as_str(), "net.refused" | "auth.failed" | "dns.notFound"), "{}: wrong class {} for: {}", fx.test, d.code, d.detail);
    assert_eq!(d.code, "select.noServer", "{}: {}", fx.test, d.detail);
    assert!(d.detail.to_ascii_lowercase().contains("wire protocol"), "the detail must name the protocol mismatch: {}", d.detail);
}

#[tokio::test]
async fn auth_a_user_of_the_admin_database_fails_against_the_database_in_the_uri() {
    let Some(fx) = require("auth_a_user_of_the_admin_database_fails_against_the_database_in_the_uri", &["AUTH_PORT", "AUTH_RO_PW"]) else { return };
    // `mongodb://ro:pw@host/shop` without authSource signs in against `shop`, where this user does not exist. A real server
    // answers exactly as for a wrong password (code 18, "Authentication failed."), so the catalogue code is auth.failed, whose
    // fixes name the authentication database; `auth.source` can only come from error text that names it.
    let mut s = spec(fx.port("AUTH_PORT"));
    s.auth.username = Some("ro".into());
    s.auth.source = None;
    let c = Creds { password: Some(secret(&fx, "AUTH_RO_PW")), ..Creds::default() };
    expect_code(&fx, "real auth.failed (user lives in admin, URI database is shop)", &s, &c, "auth.failed").await;
    // the same credentials with the right source work: the password was never the problem
    user(&mut s, "ro", "admin");
    connect_ok(&s, &c).await.close();
}
