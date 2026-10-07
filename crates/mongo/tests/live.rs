//! Live proof (feature `mongo`): the parts of the Studio that fakes cannot prove, against the REAL mongod processes of
//! `scripts/mongo-fixture/local.sh up` (loopback only, throwaway data, random credentials). Every test skips with a printed,
//! greppable `LIVE-SKIP` line when its variables are missing; a skip is not a pass.
//!
//!   eval "$(scripts/mongo-fixture/local.sh env)" && nice -n 10 cargo test -p intely-mongo --features mongo --test live -j 2 -- --test-threads=1 --nocapture
//!
//! Covers: windowed cursors and cancel on a few hundred thousand documents, the explain gate and cost warnings on real plans,
//! every write command shape (closed enum on our side, authorisation on the server's), and connection strings and `ConnSpec`
//! round trips through the real driver's option handling.
#![cfg(feature = "mongo")]

use std::sync::Arc;
use std::time::{Duration, Instant};

use bson::{doc, Document};
use intely_mongo::api::{Environment, ProfileInput, RunRequest};
use intely_mongo::connspec::TlsMode;
use intely_mongo::connstring::{self, Mask, RenderSecrets};
use intely_mongo::driver::{CancelToken, Session, SessionOpts, SpecConnect};
use intely_mongo::error::code;
use intely_mongo::api::PlanView;
use intely_mongo::host;
use intely_mongo::jail::NetworkPolicy;
use intely_mongo::profile::ProfileStore;
use intely_mongo::studio::Studio;
use intely_mongo::types::{EffectiveLevel, ReadCommand, RoleChip, MAX_DOCS};
use intely_settings::{MemorySecretStore, Secret, SettingsStore};
use serde_json::{json, Value};

const BIG: &str = "intely_test_big";
const HAPPY: &str = "intely_test_happy";

fn skip(test: &str, why: &str) {
    eprintln!("LIVE-SKIP {test}: {why}");
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn guarded(uri: &str) -> String {
    let info = host::parse_uri(uri).expect("uri");
    assert_eq!(host::effective_level(&info), EffectiveLevel::Local, "fixture URI must be loopback");
    uri.to_string()
}

struct Env {
    dir: tempfile::TempDir,
    studio: Arc<Studio>,
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let settings = Arc::new(SettingsStore::open(dir.path().join("settings.json")).unwrap());
    let profiles = Arc::new(ProfileStore::new(settings, Arc::new(MemorySecretStore::new())));
    let studio = Arc::new(Studio::new(profiles, NetworkPolicy::Full).with_now(1_790_000_000_000));
    studio.set_enabled(true).unwrap();
    Env { dir, studio }
}

fn input(name: &str, uri: &str, max_time_ms: u32) -> ProfileInput {
    ProfileInput { name: name.into(), environment: Environment::Local, uri: Some(uri.into()), max_time_ms: Some(max_time_ms as _), ..Default::default() }
}

async fn connected(name: &str, uri: &str, max_time_ms: u32) -> (Env, String) {
    let e = env();
    let p = e.studio.profile_save(input(name, uri, max_time_ms)).unwrap();
    e.studio.connect(&p.id).await.unwrap();
    (e, p.id)
}

fn req(tab: &str, conn: &str, command: ReadCommand) -> RunRequest {
    RunRequest { tab: tab.into(), connection: conn.into(), command, page_size: None }
}

fn find(db: &str, coll: &str, filter: &str, sort: Option<&str>, limit: Option<i64>) -> ReadCommand {
    ReadCommand::Find { db: db.into(), collection: coll.into(), filter: filter.into(), projection: None, sort: sort.map(Into::into), skip: None, limit }
}

fn big_uri(test: &str) -> Option<String> {
    match var("INTELY_MONGO_BIG_URI") {
        Some(u) => Some(guarded(&u)),
        None => {
            skip(test, "INTELY_MONGO_BIG_URI is not set (scripts/mongo-fixture/local.sh up, INTELY_MLOCAL_BIG != 0)");
            None
        }
    }
}

/// The real number of documents in `intely_test_big.events`, asked through a raw driver (not through the code under test).
async fn big_count(uri: &str) -> u64 {
    let c = mongodb::Client::with_uri_str(uri).await.unwrap();
    c.database(BIG).collection::<Document>("events").count_documents(doc! {}).await.unwrap()
}

fn n_of(doc_text: &str) -> i64 {
    let v: Value = serde_json::from_str(doc_text).unwrap();
    v["n"]["$numberInt"].as_str().map(|s| s.parse().unwrap()).or_else(|| v["n"]["$numberLong"].as_str().map(|s| s.parse().unwrap())).unwrap_or_else(|| panic!("no n in {doc_text}"))
}

// ---- windowed cursors on a few hundred thousand documents ---------------------------------------------------------------

#[tokio::test]
async fn windows_over_a_few_hundred_thousand_documents_are_exact_and_the_cursor_stays_small() {
    let Some(uri) = big_uri("windows_over_a_few_hundred_thousand_documents") else { return };
    let total = big_count(&uri).await;
    assert!(total >= 100_000, "the big collection is meant to hold a few hundred thousand documents, got {total}");
    let (e, id) = connected("Big", &uri, 60_000).await;

    // the empty-filter count is the cheap estimate and must match the real number
    let c = e.studio.run(req("c", &id, ReadCommand::Count { db: BIG.into(), collection: "events".into(), filter: String::new() })).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&c.docs[0]).unwrap()["count"].as_u64(), Some(total));

    let t0 = Instant::now();
    let first = e.studio.run(req("t", &id, find(BIG, "events", "", Some("{n: 1}"), None))).await.unwrap();
    // the first window buffers a few pages, not the 1000 ceiling
    assert_eq!((first.docs.len(), first.offset, first.truncated, first.has_more), (50, 0, true, true));
    assert!((50..=MAX_DOCS as u32).contains(&first.loaded), "{}", first.loaded);
    eprintln!("LIVE windows: first window of {total} documents in {:?}, {} bytes", t0.elapsed(), first.bytes);
    assert!(first.docs.iter().enumerate().all(|(i, d)| n_of(d) == i as i64));

    // offsets inside the buffer are slices; every offset beyond it re-runs the find with the right skip, the cursor never grows
    let mut samples = Vec::new();
    let total32 = total as u32;
    for off in [950u32, 1_000, 1_001, 50_000, 123_457, total32 - 50] {
        let t = Instant::now();
        let w = e.studio.window("t", off, 50).await.unwrap();
        assert_eq!(w.docs.len(), 50, "offset {off}");
        assert_eq!(w.offset, off);
        assert!(w.loaded as usize <= MAX_DOCS, "the cursor holds at most {MAX_DOCS}, got {}", w.loaded);
        for (i, d) in w.docs.iter().enumerate() {
            assert_eq!(n_of(d), i64::from(off) + i as i64, "offset {off}, row {i}");
        }
        assert!(w.bytes < 4 * 1024 * 1024, "bounded window, got {}", w.bytes);
        samples.push(format!("{off}: {:?}", t.elapsed()));
    }
    eprintln!("LIVE windows: offsets {}", samples.join(", "));
    // the end and past it
    let end = e.studio.window("t", total32 - 10, 50).await.unwrap();
    assert_eq!((end.docs.len(), end.has_more), (10, false));
    assert!(e.studio.window("t", total32, 50).await.unwrap().docs.is_empty());
    assert_eq!(e.studio.cursor_count(), 2, "one cursor per tab: the count tab and the find tab");

    // an unsorted find over everything is cut at the cap and says so
    let cut = e.studio.run(req("u", &id, find(BIG, "events", "", None, None))).await.unwrap();
    assert!(cut.truncated && cut.has_more && cut.loaded as usize <= MAX_DOCS, "{:?}", (cut.loaded, cut.truncated, cut.has_more));

    // aggregation over all documents: the server does the work, we get the 8 groups
    let g = e.studio.run(req("g", &id, ReadCommand::Aggregate { db: BIG.into(), collection: "events".into(), pipeline: "[{$group: {_id: '$kind', n: {$sum: 1}}}, {$sort: {_id: 1}}]".into() })).await.unwrap();
    assert_eq!(g.docs.len(), 8);
    let sum: i64 = g.docs.iter().map(|d| serde_json::from_str::<Value>(d).unwrap()["n"]["$numberInt"].as_str().unwrap().parse::<i64>().unwrap()).sum();
    assert_eq!(sum as u64, total);
    let d = e.studio.run(req("d", &id, ReadCommand::Distinct { db: BIG.into(), collection: "events".into(), field: "kind".into(), filter: String::new() })).await.unwrap();
    assert_eq!(d.docs.len(), 8);
}

// ---- cancel and maxTimeMS on the same data -----------------------------------------------------------------------------

fn heavy_big() -> ReadCommand {
    // every document joined to every document with the same unindexed `bucket`: minutes of work on a few hundred thousand documents
    ReadCommand::Aggregate { db: BIG.into(), collection: "events".into(), pipeline: "[{$lookup: {from: 'events', localField: 'bucket', foreignField: 'bucket', as: 'x'}}, {$match: {'x.5': {$exists: true}}}]".into() }
}

/// Operations of this IDE (tagged by `comment`) that are still running.
async fn own_ops(uri: &str) -> usize {
    let client = mongodb::Client::with_uri_str(uri).await.unwrap();
    let pipeline = vec![doc! {"$currentOp": {"allUsers": true}}, doc! {"$match": {"command.comment": {"$regex": "^intely-op-"}}}];
    let mut cur = client.database("admin").aggregate(pipeline).await.unwrap();
    let mut n = 0;
    while cur.advance().await.unwrap() {
        n += 1;
    }
    n
}

async fn wait_no_own_ops(uri: &str) -> usize {
    let mut left = own_ops(uri).await;
    for _ in 0..20 {
        if left == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        left = own_ops(uri).await;
    }
    left
}

#[tokio::test]
async fn cancel_kills_a_heavy_pipeline_on_a_few_hundred_thousand_documents_and_nothing_keeps_running() {
    let Some(uri) = big_uri("cancel_kills_a_heavy_pipeline") else { return };
    let (e, id) = connected("BigCancel", &uri, 60_000).await;
    let studio = e.studio.clone();
    let conn = id.clone();
    let t0 = Instant::now();
    let h = tokio::spawn(async move { studio.run(req("heavy", &conn, heavy_big())).await });
    let mut killed_after = None;
    for _ in 0..80 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if e.studio.cancel("heavy").await.unwrap().killed {
            killed_after = Some(t0.elapsed());
            break;
        }
    }
    let killed_after = killed_after.expect("killOp never found the tagged operation");
    let res = tokio::time::timeout(Duration::from_secs(15), h).await.expect("the run did not end after killOp").unwrap();
    assert_eq!(res.unwrap_err().code, code::CANCELLED);
    eprintln!("LIVE cancel: operation found and killed {killed_after:?} after start, run ended {:?} after start", t0.elapsed());
    // the server really stopped working: none of our tagged operations is left
    assert_eq!(wait_no_own_ops(&uri).await, 0, "an operation of ours is still running on the server");
    assert_eq!(e.studio.cursor_count(), 0);
    // the connection is still good
    let after = e.studio.run(req("after", &id, ReadCommand::Count { db: BIG.into(), collection: "events".into(), filter: "{kind: 'buy'}".into() })).await.unwrap();
    assert!(serde_json::from_str::<Value>(&after.docs[0]).unwrap()["count"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn max_time_ms_ends_a_heavy_pipeline_on_the_server_within_its_budget() {
    let Some(uri) = big_uri("max_time_ms_ends_a_heavy_pipeline") else { return };
    let (e, id) = connected("BigBudget", &uri, 1_000).await;
    let t0 = Instant::now();
    let err = e.studio.run(req("slow", &id, heavy_big())).await.unwrap_err();
    let took = t0.elapsed();
    eprintln!("LIVE maxTimeMS: ended after {took:?}: {} {}", err.code, err.message.chars().take(80).collect::<String>());
    assert_eq!(err.code, code::SERVER, "{err}");
    assert!(err.message.contains("MaxTimeMSExpired"), "{err}");
    assert!(took < Duration::from_secs(15), "{took:?}");
    assert_eq!(wait_no_own_ops(&uri).await, 0);
}

// ---- the explain gate and the cost warnings on real plans ----------------------------------------------------------------

async fn explain_of(e: &Env, id: &str, tab: &str, inner: ReadCommand) -> PlanView {
    let w = e.studio.run(req(tab, id, ReadCommand::Explain { inner: Box::new(inner), execution_stats: true })).await.unwrap();
    w.plan.unwrap_or_else(|| panic!("no plan for {tab}"))
}

#[tokio::test]
async fn real_plans_drive_the_explain_gate_and_the_cost_warnings() {
    let Some(uri) = big_uri("real_plans_drive_the_explain_gate") else { return };
    let total = big_count(&uri).await;
    let (e, id) = connected("BigExplain", &uri, 60_000).await;

    // no index on `bucket`: a collection scan that examines every document to return a few hundred
    let scan = explain_of(&e, &id, "scan", find(BIG, "events", "{bucket: 5}", None, None)).await;
    assert!(scan.collscan, "{scan:?}");
    assert_eq!(scan.docs_examined, Some(total as i32), "{scan:?}");
    // the warnings the Studio attaches to the plan it shows, with no estimate known
    eprintln!("LIVE explain COLLSCAN: examined {:?} returned {:?}; warnings {:?}", scan.docs_examined, scan.n_returned, scan.warnings);
    assert!(scan.warnings.iter().any(|x| x.starts_with("COLLSCAN")) && scan.warnings.iter().any(|x| x.starts_with("examines")), "{:?}", scan.warnings);

    // the index on `n`: one key, one document, no warning
    let point = explain_of(&e, &id, "point", find(BIG, "events", "{n: 12345}", None, None)).await;
    assert!(!point.collscan && point.stages.iter().any(|s| s == "IXSCAN"), "{point:?}");
    assert_eq!((point.docs_examined, point.keys_examined, point.n_returned), (Some(1), Some(1), Some(1)));
    assert!(point.warnings.is_empty(), "{:?}", point.warnings);

    // the compound index (kind, ts) serves an equality plus a sort: no in-memory SORT stage
    let sorted = explain_of(&e, &id, "sorted", find(BIG, "events", "{kind: 'buy'}", Some("{ts: -1}"), Some(10))).await;
    assert!(sorted.index_names.iter().any(|n| n.starts_with("kind_1")), "{sorted:?}");
    assert!(!sorted.stages.iter().any(|s| s == "SORT"), "{sorted:?}");
    assert_eq!(sorted.n_returned, Some(10));

    // an unindexed sort: the plan shows a SORT stage and examines everything
    let blocking = explain_of(&e, &id, "blocking", find(BIG, "events", "", Some("{score: -1}"), Some(5))).await;
    assert!(blocking.stages.iter().any(|s| s == "SORT") && blocking.collscan, "{blocking:?}");
    eprintln!("LIVE explain unindexed sort: stages {:?} examined {:?}", blocking.stages, blocking.docs_examined);

    // an aggregation: $match on the index first keeps the scan small
    let agg = explain_of(&e, &id, "agg", ReadCommand::Aggregate { db: BIG.into(), collection: "events".into(), pipeline: "[{$match: {n: {$lt: 1000}}}, {$group: {_id: '$kind', c: {$sum: 1}}}]".into() }).await;
    assert!(!agg.collscan && agg.docs_examined.is_some_and(|d| d <= 1000), "{agg:?}");

    // queryPlanner mode (the default) does not execute: no counts, only the shape
    let planner = e.studio.run(req("planner", &id, ReadCommand::Explain { inner: Box::new(find(BIG, "events", "{bucket: 5}", None, None)), execution_stats: false })).await.unwrap().plan.unwrap();
    assert!(planner.collscan && planner.docs_examined.is_none(), "{planner:?}");
}

// ---- every write command shape --------------------------------------------------------------------------------------------

/// The write command documents a hostile or careless caller could try, as the server would receive them.
fn write_commands(db: &str) -> Vec<(&'static str, Document)> {
    vec![
        ("insert", doc! {"insert": "orders", "documents": [{"x": 1}]}),
        ("update", doc! {"update": "orders", "updates": [{"q": {}, "u": {"$set": {"x": 1}}, "multi": true}]}),
        ("delete", doc! {"delete": "orders", "deletes": [{"q": {}, "limit": 0}]}),
        ("findAndModify", doc! {"findAndModify": "orders", "query": {}, "update": {"$set": {"x": 1}}}),
        ("createIndexes", doc! {"createIndexes": "orders", "indexes": [{"key": {"x": 1}, "name": "x_1"}]}),
        ("dropIndexes", doc! {"dropIndexes": "orders", "index": "*"}),
        ("create", doc! {"create": "intely_test_made"}),
        ("drop", doc! {"drop": "orders"}),
        ("collMod", doc! {"collMod": "orders", "validator": {}}),
        ("renameCollection", doc! {"renameCollection": format!("{db}.orders"), "to": format!("{db}.stolen")}),
        ("aggregate $out", doc! {"aggregate": "orders", "pipeline": [{"$out": "intely_test_stolen"}], "cursor": {}}),
        ("aggregate $merge", doc! {"aggregate": "orders", "pipeline": [{"$merge": {"into": "intely_test_stolen"}}], "cursor": {}}),
        ("dropDatabase", doc! {"dropDatabase": 1}),
        ("createUser", doc! {"createUser": "intruder", "pwd": "x-not-a-real-password-x", "roles": ["root"]}),
        ("shutdown", doc! {"shutdown": 1}),
        ("setParameter", doc! {"setParameter": 1, "logLevel": 5}),
        ("killAllSessions", doc! {"killAllSessions": []}),
    ]
}

/// What the write verbs look like as JSON a webview could send (a closed, tagged enum: none of them exists).
const NOT_COMMANDS: &[&str] = &[
    "insert", "insertOne", "insertMany", "update", "updateOne", "updateMany", "replaceOne", "delete", "deleteOne", "deleteMany", "findAndModify", "findOneAndUpdate",
    "findOneAndDelete", "findOneAndReplace", "bulkWrite", "createIndex", "createIndexes", "dropIndex", "dropIndexes", "createCollection", "drop", "dropCollection",
    "dropDatabase", "renameCollection", "collMod", "runCommand", "adminCommand", "eval", "mapReduce", "createUser", "shutdown", "killOp", "setParameter", "currentOp",
    "serverStatus", "hello", "ping", "count ", "Find", "FIND", "find\u{0}", "",
];

#[tokio::test]
async fn every_write_command_shape_is_refused_by_the_closed_enum_and_by_the_server_for_a_read_user() {
    let (Some(root_uri), Some(ro_uri)) = (var("INTELY_MONGO_AUTH_ROOT"), var("INTELY_MONGO_AUTH_RO")) else {
        return skip("every_write_command_shape", "INTELY_MONGO_AUTH_ROOT / INTELY_MONGO_AUTH_RO are not set");
    };
    let (root_uri, ro_uri) = (guarded(&root_uri), guarded(&ro_uri));
    let raw_root = mongodb::Client::with_uri_str(&root_uri).await.unwrap();
    let raw_ro = mongodb::Client::with_uri_str(&ro_uri).await.unwrap();
    async fn count(c: &mongodb::Client) -> u64 {
        c.database(HAPPY).collection::<Document>("orders").count_documents(doc! {}).await.unwrap()
    }
    async fn names(c: &mongodb::Client) -> Vec<String> {
        let mut v = c.database(HAPPY).list_collection_names().await.unwrap();
        v.sort();
        v
    }
    let (n0, c0) = (count(&raw_root).await, names(&raw_root).await);
    let dbs0 = raw_root.list_database_names().await.unwrap();

    // 1. the server alone: a read-only user is refused every write shape with Unauthorized (13)
    let mut refused = Vec::new();
    for (what, cmd) in write_commands(HAPPY) {
        match raw_ro.database(HAPPY).run_command(cmd).await {
            Err(e) => {
                let text = e.to_string();
                assert!(text.contains("Unauthorized") || text.contains("(13)") || text.contains("not authorized"), "{what}: refused, but not by authorisation: {text}");
                refused.push(what);
            }
            Ok(reply) => panic!("{what}: the server ACCEPTED a write from the read-only user: {reply}"),
        }
    }
    eprintln!("LIVE writes: server refused {} write shapes for the read user: {}", refused.len(), refused.join(", "));
    assert_eq!((count(&raw_root).await, names(&raw_root).await, raw_root.list_database_names().await.unwrap()), (n0, c0.clone(), dbs0.clone()));

    // 2. a writer (root) through the Studio: the role probe says so and raises the level, and still nothing but reads can be expressed
    let e = env();
    let p = e.studio.profile_save(input("Root", &root_uri, 15_000)).unwrap();
    let view = e.studio.connect(&p.id).await.unwrap();
    assert!(matches!(view.role, RoleChip::CanWrite { .. }) && view.role_elevated, "{:?}", view.role);
    let ro = e.studio.profile_save(input("Reader", &ro_uri, 15_000)).unwrap();
    let rview = e.studio.connect(&ro.id).await.unwrap();
    assert!(!matches!(rview.role, RoleChip::CanWrite { .. }) && !rview.role_elevated, "{:?}", rview.role);

    for verb in NOT_COMMANDS {
        let j = json!({"tab": "t", "connection": p.id, "command": {"cmd": verb, "db": HAPPY, "collection": "orders"}});
        assert!(serde_json::from_value::<RunRequest>(j).is_err(), "{verb:?} must not deserialize into a command (the enum is closed and case-sensitive)");
    }
    // unknown fields on a real command are refused too (a smuggled write option)
    for extra in [json!({"cmd": "find", "db": HAPPY, "collection": "orders", "writeConcern": {"w": 1}}), json!({"cmd": "find", "db": HAPPY, "collection": "orders", "update": {"$set": {"a": 1}}}), json!({"cmd": "aggregate", "db": HAPPY, "collection": "orders", "pipeline": "[]", "out": "x"})] {
        assert!(serde_json::from_value::<RunRequest>(json!({"tab": "t", "connection": p.id, "command": extra})).is_err());
    }
    // write stages inside the allowed verbs, at any depth, with the root user's rights behind them
    let hostile = [
        "[{$out: 'intely_test_stolen'}]",
        "[{$merge: {into: 'intely_test_stolen'}}]",
        "[{$facet: {a: [{$out: 'intely_test_stolen'}]}}]",
        "[{$unionWith: {coll: 'customers', pipeline: [{$merge: {into: 'intely_test_stolen'}}]}}]",
        "[{$lookup: {from: 'customers', pipeline: [{$out: 'intely_test_stolen'}], as: 'x'}}]",
        "[{$set: {x: {$function: {body: 'function(){return 1}', args: [], lang: 'js'}}}}]",
        "[{$match: {$where: 'sleep(1)'}}]",
        "[{$group: {_id: 1, f: {$accumulator: {init: 'function(){return 0}', accumulate: 'function(a){return a}', accumulateArgs: [], merge: 'function(a,b){return a}', lang: 'js'}}}}]",
        "[{$currentOp: {}}]",
        "[{$listLocalSessions: {}}]",
        "[{$changeStream: {}}]",
    ];
    for pipeline in hostile {
        let err = e.studio.run(req("bad", &p.id, ReadCommand::Aggregate { db: HAPPY.into(), collection: "orders".into(), pipeline: pipeline.into() })).await.unwrap_err();
        assert!(matches!(err.code, code::REJECTED | code::PARSE), "{pipeline}: {err}");
    }
    for filter in ["{$where: 'sleep(1)'}", "{$expr: {$function: {body: 'function(){return true}', args: [], lang: 'js'}}}"] {
        let err = e.studio.run(req("bad", &p.id, find(HAPPY, "orders", filter, None, None))).await.unwrap_err();
        assert!(matches!(err.code, code::REJECTED | code::PARSE), "{filter}: {err}");
    }
    // 3. control experiment: the same root credentials CAN write through a raw driver, so the refusals above came from us
    let scratch = raw_root.database("intely_test_scratch").collection::<Document>("control");
    scratch.insert_one(doc! {"control": true}).await.expect("root can write through a raw driver");
    assert_eq!(scratch.count_documents(doc! {}).await.unwrap(), 1);
    raw_root.database("intely_test_scratch").drop().await.unwrap();
    // nothing of ours changed anything
    assert_eq!((count(&raw_root).await, names(&raw_root).await), (n0, c0));
    let dbs1 = raw_root.list_database_names().await.unwrap();
    assert_eq!(dbs1.iter().filter(|d| d.starts_with("intely_test_")).count(), dbs0.iter().filter(|d| d.starts_with("intely_test_")).count(), "{dbs1:?} vs {dbs0:?}");
    for db in &dbs1 {
        let colls = raw_root.database(db).list_collection_names().await.unwrap_or_default();
        assert!(!colls.iter().any(|c| c.contains("stolen") || c.contains("made")), "{db}: {colls:?}");
    }
}

#[tokio::test]
async fn the_audit_of_a_live_session_has_reads_only() {
    let Some(uri) = var("INTELY_MONGO_TEST_URI") else { return skip("the_audit_of_a_live_session", "INTELY_MONGO_TEST_URI is not set") };
    let (e, id) = connected("Audit", &guarded(&uri), 15_000).await;
    e.studio.run(req("a", &id, find(HAPPY, "orders", "{status: 'open'}", None, Some(5)))).await.unwrap();
    let _ = e.studio.run(req("b", &id, ReadCommand::Aggregate { db: HAPPY.into(), collection: "orders".into(), pipeline: "[{$out: 'x'}]".into() })).await;
    // the audit file lives in the settings directory of this Studio
    let text = std::fs::read_to_string(e.dir.path().join("mongo-audit.jsonl")).unwrap_or_default();
    assert!(text.lines().count() >= 1, "no audit line was written");
    assert!(text.lines().all(|l| l.contains("\"class\":\"read\"") || l.contains("\"class\":\"ai-read\"")), "{text}");
    assert!(!text.contains("mongodb://"));
}

// ---- connection strings and ConnSpec round trips through the real driver ---------------------------------------------------

fn spec_connect<'a>(s: &'a intely_mongo::connspec::ConnSpec, password: Option<&'a Secret>) -> SpecConnect<'a> {
    let mut i = SpecConnect::new(s);
    i.password = password;
    i
}

fn live_opts() -> SessionOpts {
    SessionOpts { allow_remote: true, ..SessionOpts::default() }
}

async fn probed(s: &intely_mongo::connspec::ConnSpec, password: Option<&Secret>) -> Session {
    let sess = Session::connect_spec(spec_connect(s, password), live_opts()).await.expect("connect");
    sess.probe().await.expect("probe");
    sess
}

fn percent(s: &str) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

async fn compression_bytes(port: &str) -> i64 {
    let c = mongodb::Client::with_uri_str(format!("mongodb://127.0.0.1:{port}/admin")).await.unwrap();
    let st = c.database("admin").run_command(doc! {"serverStatus": 1}).await.unwrap();
    let z = st.get_document("network").ok().and_then(|n| n.get_document("compression").ok()).and_then(|c| c.get_document("zlib").ok()).and_then(|z| z.get_document("compressor").ok());
    z.map(|c| c.get_i64("bytesIn").unwrap_or_else(|_| c.get_i32("bytesIn").unwrap_or(0) as i64)).unwrap_or(0)
}

/// parse -> spec -> render -> parse is a fixed point, and the spec the real driver connects with works.
#[tokio::test]
async fn connection_strings_round_trip_and_connect_with_the_options_they_carry() {
    let (Some(port), Some(auth_port), Some(pw)) = (var("INTELY_MONGO_FX_STANDALONE_PORT"), var("INTELY_MONGO_FX_AUTH_PORT"), var("INTELY_MONGO_FX_AUTH_RO_PW")) else {
        return skip("connection_strings_round_trip", "INTELY_MONGO_FX_* variables are missing (local.sh env)");
    };
    let (tls_port, comp_port, rs_ports) = (var("INTELY_MONGO_FX_TLS_PORT").unwrap(), var("INTELY_MONGO_FX_COMPRESS_PORT").unwrap(), var("INTELY_MONGO_FX_RS_PORTS").unwrap());
    let tls_dir = var("INTELY_MONGO_FX_TLS_DIR").unwrap();
    let rs_hosts: String = rs_ports.split(',').map(|p| format!("127.0.0.1:{p}")).collect::<Vec<_>>().join(",");
    let cases: Vec<(&str, String)> = vec![
        ("plain", format!("mongodb://127.0.0.1:{port}/shop")),
        ("options", format!("mongodb://127.0.0.1:{port}/shop?appName=live-proof&readPreference=secondaryPreferred&maxPoolSize=5&connectTimeoutMS=3000&serverSelectionTimeoutMS=4000&retryWrites=false&directConnection=true")),
        ("scram", format!("mongodb://ro:{}@127.0.0.1:{auth_port}/shop?authSource=admin&authMechanism=SCRAM-SHA-256", percent(&pw))),
        ("tls", format!("mongodb://127.0.0.1:{tls_port}/shop?tls=true&tlsCAFile={}", percent(&format!("{tls_dir}/ca.pem")))),
        ("zlib", format!("mongodb://127.0.0.1:{comp_port}/shop?compressors=zlib")),
        ("snappy+zlib", format!("mongodb://127.0.0.1:{comp_port}/shop?compressors=snappy,zlib")),
        ("replica set", format!("mongodb://{rs_hosts}/shop?replicaSet=rs0")),
    ];
    for (label, uri) in cases {
        let parsed = connstring::parse_connection_string(&uri).unwrap_or_else(|e| panic!("{label}: {e}"));
        assert!(parsed.unsupported.is_empty(), "{label}: {:?}", parsed.unsupported);
        let secrets = RenderSecrets { password: parsed.secrets.password.clone() };
        let full = connstring::render(&parsed.spec, &secrets, Mask::Full).unwrap_or_else(|e| panic!("{label}: {e}"));
        let again = connstring::parse_connection_string(&full).unwrap_or_else(|e| panic!("{label}: {e}"));
        assert_eq!(again.spec, parsed.spec, "{label}: parse(render(parse(x))) differs");
        assert_eq!(connstring::render(&again.spec, &RenderSecrets { password: again.secrets.password.clone() }, Mask::Full).unwrap(), full, "{label}: render is not stable");
        let masked = connstring::render(&parsed.spec, &secrets, Mask::Masked).unwrap();
        assert!(!masked.contains(&pw), "{label}: the masked string leaked the password");
        let sess = probed(&parsed.spec, parsed.secrets.password.as_ref()).await;
        let probe = sess.probe().await.unwrap();
        eprintln!("LIVE connstring {label}: ok, server {} topology {}", probe.server_version, probe.topology);
        sess.close();
    }

    // the options really reach the server: appName in the server's own connection metadata, compression in its counters
    let spec = connstring::parse_connection_string(&format!("mongodb://127.0.0.1:{port}/shop?appName=live-proof-app")).unwrap().spec;
    let sess = probed(&spec, None).await;
    let admin = mongodb::Client::with_uri_str(format!("mongodb://127.0.0.1:{port}/admin")).await.unwrap();
    let mut cur = admin.database("admin").aggregate(vec![doc! {"$currentOp": {"allUsers": true, "idleConnections": true}}, doc! {"$match": {"appName": "live-proof-app"}}]).await.unwrap();
    assert!(cur.advance().await.unwrap(), "the server never saw appName=live-proof-app");
    sess.close();

    let before = compression_bytes(&comp_port).await;
    let cspec = connstring::parse_connection_string(&format!("mongodb://127.0.0.1:{comp_port}/shop?compressors=zlib")).unwrap().spec;
    let sess = probed(&cspec, None).await;
    for _ in 0..3 {
        sess.run(&find("shop", "orders", "", None, Some(400)), &CancelToken::new()).await.unwrap();
    }
    sess.close();
    let after = compression_bytes(&comp_port).await;
    eprintln!("LIVE compression: zlib bytesIn {before} -> {after}");
    assert!(after > before, "the server's zlib counters did not move: the compressor was not negotiated");
}

#[tokio::test]
async fn the_tls_mode_options_of_a_string_reach_the_driver() {
    let (Some(tls_port), Some(plain_port), Some(dir)) = (var("INTELY_MONGO_FX_TLS_PORT"), var("INTELY_MONGO_FX_STANDALONE_PORT"), var("INTELY_MONGO_FX_TLS_DIR")) else {
        return skip("the_tls_mode_options", "INTELY_MONGO_FX_* variables are missing");
    };
    // ssl=true is the legacy spelling of tls=true
    let legacy = connstring::parse_connection_string(&format!("mongodb://127.0.0.1:{tls_port}/shop?ssl=true&tlsCAFile={}", percent(&format!("{dir}/ca.pem")))).unwrap();
    assert_eq!(legacy.spec.tls.mode, TlsMode::On);
    probed(&legacy.spec, None).await.close();
    // tls=false against the TLS server fails, tls=true against the plain one fails: the switch is honoured in both directions
    let off = connstring::parse_connection_string(&format!("mongodb://127.0.0.1:{tls_port}/shop?tls=false&serverSelectionTimeoutMS=2000")).unwrap();
    assert_eq!(off.spec.tls.mode, TlsMode::Off);
    let sess = Session::connect_spec(spec_connect(&off.spec, None), live_opts()).await.unwrap();
    assert!(sess.probe().await.is_err());
    sess.close();
    let on = connstring::parse_connection_string(&format!("mongodb://127.0.0.1:{plain_port}/shop?tls=true&serverSelectionTimeoutMS=2000")).unwrap();
    let sess = Session::connect_spec(spec_connect(&on.spec, None), live_opts()).await.unwrap();
    assert!(sess.probe().await.is_err());
    sess.close();
}
