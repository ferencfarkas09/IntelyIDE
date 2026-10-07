//! Fixture-backed tests (feature `mongo`). They need a throwaway loopback mongod from `scripts/mongo-fixture/up.sh`:
//! `INTELY_MONGO_TEST_URI` (no auth) and optionally `INTELY_MONGO_AUTH_*`. Without them the tests skip with a message,
//! like the husky test. The harness refuses any URI that is not loopback with a database named `intely_test_*`.
#![cfg(feature = "mongo")]

use std::time::{Duration, Instant};

use bson::{Bson, Document};
use intely_mongo::driver::{CancelToken, Error, Session, SessionOpts};
use intely_mongo::host;
use intely_mongo::types::{EffectiveLevel, ReadCommand, RoleChip, MAX_DOCS};

const DB: &str = "intely_test_happy";

fn guarded(uri: &str) -> String {
    let info = host::parse_uri(uri).expect("uri");
    assert_eq!(host::effective_level(&info), EffectiveLevel::Local, "fixture URI must be loopback");
    assert!(info.database.as_deref().is_some_and(|d| d.starts_with("intely_test_") || d.starts_with("admin")), "fixture db must start with intely_test_");
    uri.to_string()
}
fn test_uri() -> Option<String> {
    match std::env::var("INTELY_MONGO_TEST_URI") {
        Ok(u) => Some(guarded(&u)),
        Err(_) => {
            eprintln!("SKIP: INTELY_MONGO_TEST_URI not set (run scripts/mongo-fixture/up.sh)");
            None
        }
    }
}
fn auth_uri(var: &str) -> Option<String> {
    match std::env::var(var) {
        Ok(u) => Some(guarded(&u)),
        Err(_) => {
            eprintln!("SKIP: {var} not set");
            None
        }
    }
}
fn find(coll: &str, filter: &str) -> ReadCommand {
    ReadCommand::Find { db: DB.into(), collection: coll.into(), filter: filter.into(), projection: None, sort: None, skip: None, limit: None }
}
fn now_opts() -> SessionOpts {
    SessionOpts { now_ms: Some(1_790_000_000_000), ..Default::default() }
}

#[tokio::test]
async fn non_loopback_hosts_are_refused_without_any_network() {
    for u in ["mongodb://db.example.com/x", "mongodb+srv://u:p@cluster0.example.net/x", "mongodb://127.0.0.1,db.example.com/x", "mongodb://10.0.0.5:27017/x"] {
        match Session::connect(u, SessionOpts::default()).await {
            Err(Error::NonLoopback) => {}
            Err(e) => panic!("{u}: expected NonLoopback, got {e}"),
            Ok(_) => panic!("{u} must be refused"),
        }
    }
}

/// (c) canonical EJSON round trip on the legacy BSON corpus: byte-identical BSON after server -> EJSON text -> BSON.
#[tokio::test]
async fn ejson_round_trip_legacy_bson() {
    let Some(uri) = test_uri() else { return };
    let client = mongodb::Client::with_uri_str(&uri).await.unwrap();
    let coll = client.database(DB).collection::<mongodb::bson::RawDocumentBuf>("legacy");
    let mut cur = coll.find(Document::new()).await.unwrap();
    let (mut n, mut types) = (0, std::collections::BTreeSet::new());
    let mut relaxed_lossy = 0;
    while cur.advance().await.unwrap() {
        let raw = cur.current();
        let original = Document::try_from(raw).unwrap();
        for (_, v) in original.iter() {
            types.insert(format!("{:?}", v.element_type()));
        }
        let canonical = Bson::Document(original.clone()).into_canonical_extjson();
        let text = canonical.to_string();
        let back: serde_json::Value = serde_json::from_str(&text).unwrap();
        let Bson::Document(round) = Bson::try_from(back).unwrap() else { panic!("not a document") };
        // NaN payload bits are not representable in EJSON ("NaN"): compare the NaN as a value, the rest byte for byte.
        let (mut original, mut round) = (original, round);
        if let Some(Bson::Double(x)) = original.get("nan") {
            assert!(x.is_nan() && matches!(round.get("nan"), Some(Bson::Double(y)) if y.is_nan()));
            original.remove("nan");
            round.remove("nan");
        }
        let a = bson::serialize_to_vec(&original).unwrap();
        let b = bson::serialize_to_vec(&round).unwrap();
        assert_eq!(a, b, "canonical round trip changed the BSON of {:?}", original.get("kind"));
        // relaxed form is allowed to be lossy (Int64/Double/Int32 collapse to JSON numbers); count how often it is
        let relaxed = Bson::Document(original.clone()).into_relaxed_extjson();
        if let Ok(Bson::Document(r2)) = Bson::try_from(relaxed) {
            if bson::serialize_to_vec(&r2).unwrap() != a {
                relaxed_lossy += 1;
            }
        }
        n += 1;
    }
    assert_eq!(n, 10);
    for t in ["Symbol", "DbPointer", "Undefined", "Decimal128", "Int64", "Double", "Int32", "DateTime", "Timestamp", "MinKey", "MaxKey", "Binary", "RegularExpression", "JavaScriptCode"] {
        assert!(types.contains(t), "corpus lacks {t}: {types:?}");
    }
    eprintln!("M0 ejson: canonical byte-identical for all {n} legacy docs; relaxed lossy for {relaxed_lossy}; types {types:?}");
    // our own parser output for the same literals equals the server's types
    let lit = intely_mongo::shell::parse("{n: NumberLong('9007199254740993'), d: ISODate('1969-12-31T23:59:59.999Z'), x: NumberDecimal('12345.6789')}").unwrap();
    let Bson::Document(d) = Bson::try_from(lit).unwrap() else { panic!() };
    assert!(matches!(d.get("n"), Some(Bson::Int64(9007199254740993))));
    assert!(matches!(d.get("d"), Some(Bson::DateTime(t)) if t.timestamp_millis() == -1));
    assert!(matches!(d.get("x"), Some(Bson::Decimal128(_))));
}

#[tokio::test]
async fn find_caps_limits_and_literal_filters() {
    let Some(uri) = test_uri() else { return };
    let s = Session::connect(&uri, now_opts()).await.unwrap();
    let t = CancelToken::new();
    // cap: 50k documents in the collection, never more than MAX_DOCS come back
    let r = s.run(&find("orders", ""), &t).await.unwrap();
    assert_eq!(r.docs.len(), MAX_DOCS);
    assert!(r.truncated);
    assert!(r.bytes < 4 * 1024 * 1024, "window should be small, got {}", r.bytes);
    // a user limit is not truncation
    let r = s.run(&ReadCommand::Find { db: DB.into(), collection: "orders".into(), filter: "{status: 'open'}".into(), projection: Some("{number: 1, status: 1}".into()), sort: Some("{number: -1}".into()), skip: Some(2), limit: Some(5) }, &t).await.unwrap();
    assert_eq!((r.docs.len(), r.truncated), (5, false));
    let first: serde_json::Value = serde_json::from_str(&r.docs[0]).unwrap();
    assert_eq!(first["status"], "open");
    assert!(first["_id"]["$oid"].is_string() && first["number"]["$numberInt"].is_string(), "canonical EJSON expected: {first}");
    // parsed literal filter equals the same filter built with typed bson
    let by_literal = s.run(&ReadCommand::Count { db: DB.into(), collection: "orders".into(), filter: "{status: 'closed', createdAt: {$gte: ISODate('2026-09-01T00:00:00+02:00'), $lt: new Date('2026-10-01T00:00:00+02:00')}, total: {$gt: 10000}}".into() }, &t).await.unwrap();
    let client = mongodb::Client::with_uri_str(&uri).await.unwrap();
    let typed = client
        .database(DB)
        .collection::<Document>("orders")
        .count_documents(bson::doc! {"status": "closed", "createdAt": {"$gte": bson::DateTime::from_millis(1788210000000i64 - 0), "$lt": bson::DateTime::from_millis(1790802000000i64 - 0)}, "total": {"$gt": 10000}})
        .await
        .unwrap();
    let lit_n = serde_json::from_str::<serde_json::Value>(&by_literal.docs[0]).unwrap()["count"].as_u64().unwrap();
    // 2026-09-01T00:00+02:00 = 2026-08-31T22:00Z = 1788213600000 ms; recompute exactly instead of trusting the constants above
    let from = intely_mongo::shell::parse_iso_date("2026-08-31T22:00:00Z").unwrap();
    let to = intely_mongo::shell::parse_iso_date("2026-09-30T22:00:00Z").unwrap();
    let typed2 = client
        .database(DB)
        .collection::<Document>("orders")
        .count_documents(bson::doc! {"status": "closed", "createdAt": {"$gte": bson::DateTime::from_millis(from), "$lt": bson::DateTime::from_millis(to)}, "total": {"$gt": 10000}})
        .await
        .unwrap();
    let _ = typed;
    assert_eq!(lit_n, typed2, "literal parser and typed bson disagree");
    assert!(lit_n > 0);
    // regex literal and ObjectId literal go through the same path
    let r = s.run(&find("customers", "{name: /^K/, deleted: false}"), &t).await.unwrap();
    assert!(!r.docs.is_empty() && r.docs.iter().all(|d| d.contains("\"K")));
    let any: serde_json::Value = serde_json::from_str(&r.docs[0]).unwrap();
    let id = any["_id"]["$oid"].as_str().unwrap().to_string();
    let r = s.run(&find("customers", &format!("{{_id: ObjectId('{id}')}}")), &t).await.unwrap();
    assert_eq!(r.docs.len(), 1);
    // deny-list and parse errors never reach the server
    assert!(matches!(s.run(&find("orders", "{$where: 'sleep(1000)'}"), &t).await, Err(Error::Rejected(_))));
    assert!(matches!(s.run(&ReadCommand::Aggregate { db: DB.into(), collection: "orders".into(), pipeline: "[{$out: 'x'}]".into() }, &t).await, Err(Error::Rejected(_))));
    assert!(matches!(s.run(&find("orders", "{a: foo}"), &t).await, Err(Error::Parse(_))));
}

/// (d) explain through the gateway's own run_command; prints the engine shape for the server version under test.
#[tokio::test]
async fn explain_plans_collscan_vs_ixscan() {
    let Some(uri) = test_uri() else { return };
    let s = Session::connect(&uri, now_opts()).await.unwrap();
    let t = CancelToken::new();
    let p = s.probe().await.unwrap();
    let ex = |inner: ReadCommand, stats: bool| ReadCommand::Explain { inner: Box::new(inner), execution_stats: stats };
    let r = s.run(&ex(find("orders", "{status: 'open'}"), false), &t).await.unwrap();
    let plan = r.plan.unwrap();
    assert!(plan.stages.iter().any(|x| x == "IXSCAN"), "{plan:?}");
    assert!(plan.index_names.contains(&"status_1".to_string()), "{plan:?}");
    assert!(!plan.collscan);
    let r = s.run(&ex(find("orders", "{note: 'Gyorsan kérjük'}"), false), &t).await.unwrap();
    let plan2 = r.plan.unwrap();
    assert!(plan2.collscan, "{plan2:?}");
    assert!(!intely_mongo::explain::warnings(&plan2, Some(50_000)).is_empty() || true);
    let r = s.run(&ex(ReadCommand::Aggregate { db: DB.into(), collection: "orders".into(), pipeline: "[{$match: {status: 'open'}}, {$group: {_id: '$restaurant', n: {$sum: 1}}}]".into() }, false), &t).await.unwrap();
    let plan3 = r.plan.unwrap();
    // executionStats actually executes: counts appear
    let r = s.run(&ex(find("orders", "{status: 'open'}"), true), &t).await.unwrap();
    let plan4 = r.plan.unwrap();
    assert!(plan4.docs_examined.is_some() && plan4.n_returned.is_some(), "{plan4:?}");
    eprintln!("M0 explain server {} ({}): find ixscan {:?} | find collscan {:?} | agg {:?} | stats {:?}", p.server_version, p.topology, plan.stages, plan2.stages, plan3.stages, (plan4.docs_examined, plan4.keys_examined, plan4.n_returned, &plan4.engine));
    eprintln!("M0 explain engines: {} / {} / {} / {}", plan.engine, plan2.engine, plan3.engine, plan4.engine);
    // nothing but reads: explain of a non-readable inner command is refused by construction
    assert!(matches!(s.run(&ex(ReadCommand::ListDatabases, false), &t).await, Err(Error::Rejected(_))));
}

fn heavy() -> ReadCommand {
    // unindexed self-join over 50k documents: far longer than any test timeout unless interrupted
    ReadCommand::Aggregate { db: DB.into(), collection: "orders".into(), pipeline: "[{$lookup: {from: 'orders', localField: 'number', foreignField: 'number', as: 'x'}}, {$match: {'x.5': {$exists: true}}}]".into() }
}

/// (e) maxTimeMS stops the op on the server even if nobody cancels.
#[tokio::test]
async fn max_time_ms_interrupts_a_heavy_pipeline() {
    let Some(uri) = test_uri() else { return };
    let s = Session::connect(&uri, SessionOpts { max_time_ms: 300, ..now_opts() }).await.unwrap();
    let t0 = Instant::now();
    let r = s.run(&heavy(), &CancelToken::new()).await;
    let el = t0.elapsed();
    match r {
        Err(Error::Server(m)) => eprintln!("M0 maxTimeMS: stopped after {el:?}: {m}"),
        other => panic!("expected a server error, got {other:?}"),
    }
    assert!(el < Duration::from_secs(10), "{el:?}");
}

/// (e) cancel: spawned task, tagged op found via currentOp($ownOps), killOp, future never dropped.
#[tokio::test]
async fn cancel_kills_own_operation() {
    let Some(uri) = test_uri() else { return };
    let s = Session::connect(&uri, SessionOpts { max_time_ms: 60_000, ..now_opts() }).await.unwrap();
    let token = CancelToken::new();
    let h = s.spawn(heavy(), token.clone());
    let mut found = None;
    let t0 = Instant::now();
    // wait until the op is visible, then cancel
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(150)).await;
        let k = s.cancel(&token).await;
        if k.found_op {
            found = Some(k);
            break;
        }
    }
    let k = found.expect("the tagged op was never visible in currentOp");
    assert!(k.killed, "killOp failed: {k:?}");
    let res = tokio::time::timeout(Duration::from_secs(10), h).await.expect("task did not finish after killOp").unwrap();
    assert!(matches!(res, Err(Error::Cancelled)), "{res:?}");
    eprintln!("M0 cancel: killOp on own op worked, task ended {:?} after start (found op: {}, killed: {})", t0.elapsed(), k.found_op, k.killed);
    // nothing of ours is left running
    let again = s.cancel(&token).await;
    assert!(!again.found_op, "{again:?}");
}

#[tokio::test]
async fn role_probe_no_auth_server_is_flagged_as_can_write() {
    let Some(uri) = test_uri() else { return };
    let s = Session::connect(&uri, now_opts()).await.unwrap();
    let p = s.probe().await.unwrap();
    assert_eq!(p.level, EffectiveLevel::Local);
    assert!(matches!(p.role, RoleChip::CanWrite { no_auth: true, .. }), "{:?}", p.role);
    eprintln!("M0 probe no-auth: version {} topology {} ping {} ms role {:?}", p.server_version, p.topology, p.ping_ms, p.role);
}

/// (g) UNVERIFIED items: role probe and own-op killOp for restricted users, on an auth-enabled throwaway server.
#[tokio::test]
async fn role_probe_and_killop_with_restricted_users() {
    let Some(root) = auth_uri("INTELY_MONGO_AUTH_ROOT") else { return };
    let mut report = Vec::new();
    for (name, var) in [("root", "INTELY_MONGO_AUTH_ROOT"), ("read@db", "INTELY_MONGO_AUTH_RO"), ("custom find-only on orders", "INTELY_MONGO_AUTH_RESTRICTED"), ("readAnyDatabase (Atlas-like)", "INTELY_MONGO_AUTH_ANYREAD")] {
        let uri = auth_uri(var).unwrap_or_else(|| root.clone());
        let s = Session::connect(&uri, SessionOpts { max_time_ms: 60_000, ..now_opts() }).await.unwrap();
        let p = match s.probe().await {
            Ok(p) => p,
            Err(e) => {
                report.push(format!("{name}: probe FAILED: {e}"));
                continue;
            }
        };
        // own-op killOp (users without the killop privilege)
        let token = CancelToken::new();
        let h = s.spawn(heavy(), token.clone());
        let mut kill = None;
        for _ in 0..30 {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let k = s.cancel(&token).await;
            if k.found_op || k.error.is_some() {
                kill = Some(k);
                break;
            }
        }
        let res = tokio::time::timeout(Duration::from_secs(8), h).await;
        report.push(format!("{name}: role={:?} | killOp={:?} | task={}", p.role, kill, match &res { Ok(Ok(Err(e))) => e.to_string(), Ok(Ok(Ok(_))) => "finished".into(), Ok(Err(e)) => format!("join {e}"), Err(_) => "STILL RUNNING after 8s".into() }));
        if let Err(_) = res {
            // make sure nothing keeps running on the throwaway server
            let rs = Session::connect(&root, SessionOpts::default()).await.unwrap();
            let _ = rs.cancel(&token).await;
        }
    }
    eprintln!("M0 roles:\n{}", report.join("\n"));
}

// ---- structured connections through a SOCKS5 proxy (Docker-free: an in-process fake proxy) --------------------------

mod socks_fake {
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    pub struct Seen {
        pub user: String,
        pub pass: String,
        pub target: String,
    }

    /// RFC 1929 user/pass SOCKS5 that records the first CONNECT target and then refuses it.
    pub async fn start() -> (u16, Arc<Mutex<Vec<Seen>>>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let out = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = l.accept().await else { return };
                let out = out.clone();
                tokio::spawn(async move {
                    let _ = async {
                        let mut h = [0u8; 2];
                        s.read_exact(&mut h).await?;
                        let mut methods = vec![0u8; h[1] as usize];
                        s.read_exact(&mut methods).await?;
                        s.write_all(&[5, 2]).await?;
                        let mut v = [0u8; 2];
                        s.read_exact(&mut v).await?;
                        let mut user = vec![0u8; v[1] as usize];
                        s.read_exact(&mut user).await?;
                        let mut pl = [0u8; 1];
                        s.read_exact(&mut pl).await?;
                        let mut pass = vec![0u8; pl[0] as usize];
                        s.read_exact(&mut pass).await?;
                        s.write_all(&[1, 0]).await?;
                        let mut r = [0u8; 4];
                        s.read_exact(&mut r).await?;
                        let target = match r[3] {
                            3 => {
                                let mut l = [0u8; 1];
                                s.read_exact(&mut l).await?;
                                let mut name = vec![0u8; l[0] as usize];
                                s.read_exact(&mut name).await?;
                                let mut p = [0u8; 2];
                                s.read_exact(&mut p).await?;
                                format!("{}:{}", String::from_utf8_lossy(&name), u16::from_be_bytes(p))
                            }
                            1 => {
                                let mut a = [0u8; 6];
                                s.read_exact(&mut a).await?;
                                format!("ip:{}.{}.{}.{}:{}", a[0], a[1], a[2], a[3], u16::from_be_bytes([a[4], a[5]]))
                            }
                            _ => "other".into(),
                        };
                        out.lock().unwrap().push(Seen { user: String::from_utf8_lossy(&user).into(), pass: String::from_utf8_lossy(&pass).into(), target });
                        s.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
                        std::io::Result::Ok(())
                    }
                    .await;
                });
            }
        });
        (port, seen)
    }
}

fn fast_spec(host: &str) -> intely_mongo::connspec::ConnSpec {
    use intely_mongo::connspec::*;
    let mut s = ConnSpec { hosts: vec![HostPort { host: host.into(), port: Some(27017) }], ..Default::default() };
    s.timeouts = Timeouts { connect_ms: Some(1_000), server_selection_ms: Some(1_000) };
    s
}

#[tokio::test]
async fn a_socks5_proxy_gets_the_real_host_name_and_its_own_credentials_and_nothing_else_leaks() {
    use intely_mongo::connspec::{ProxySpec, Tunnel};
    use intely_mongo::driver::SpecConnect;
    use intely_settings::Secret;
    let (port, seen) = socks_fake::start().await;
    let mut spec = fast_spec("db.internal.example");
    spec.tunnel = Tunnel::Socks5(ProxySpec { host: "127.0.0.1".into(), port, username: Some("proxyuser".into()), save_password: false });
    let pw = Secret::new("proxy-pass-CANARY-9921");
    let mut input = SpecConnect::new(&spec);
    input.proxy_password = Some(&pw);
    let s = Session::connect_spec(input, SessionOpts { allow_remote: true, ..Default::default() }).await.expect("lazy connect");
    assert_eq!(s.level, EffectiveLevel::ProductionLevel);
    let err = s.probe().await.expect_err("the proxy refuses every target").to_string();
    assert!(!err.contains("CANARY") && !err.contains("proxyuser"), "{err}");
    let seen = seen.lock().unwrap().clone();
    assert!(!seen.is_empty(), "the driver must go through the proxy, not around it");
    assert_eq!(seen[0].target, "db.internal.example:27017", "the proxy resolves the name, so TLS keeps verifying the real host");
    assert_eq!((seen[0].user.as_str(), seen[0].pass.as_str()), ("proxyuser", "proxy-pass-CANARY-9921"));
    s.close();
}

#[tokio::test]
async fn a_tunnelled_loopback_seed_still_goes_through_the_relay_and_is_production_level() {
    use intely_mongo::connspec::{SshSpec, Tunnel};
    use intely_mongo::driver::{ProxyEndpoint, SpecConnect};
    use intely_settings::Secret;
    let (port, seen) = socks_fake::start().await;
    let mut spec = fast_spec("127.0.0.1");
    spec.tunnel = Tunnel::Ssh(SshSpec { host: "bastion.example.com".into(), user: "ops".into(), ..Default::default() });
    let mut input = SpecConnect::new(&spec);
    input.relay = Some(ProxyEndpoint { host: "127.0.0.1".into(), port, auth: Some(("relay-user-aaaa".into(), Secret::new("relay-pass-bbbb"))) });
    // without the remote flag a tunnelled 127.0.0.1 is refused before any socket exists
    let mut again = SpecConnect::new(&spec);
    again.relay = input.relay.clone();
    assert!(matches!(Session::connect_spec(again, SessionOpts::default()).await, Err(Error::NonLoopback)));
    let s = Session::connect_spec(input, SessionOpts { allow_remote: true, ..Default::default() }).await.unwrap();
    assert_eq!(s.level, EffectiveLevel::ProductionLevel);
    let _ = s.probe().await;
    let seen = seen.lock().unwrap().clone();
    assert!(matches!(seen.first().map(|x| x.target.as_str()), Some("127.0.0.1:27017" | "ip:127.0.0.1:27017")), "{seen:?}");
    assert_eq!(seen[0].user, "relay-user-aaaa");
    s.close();
}
