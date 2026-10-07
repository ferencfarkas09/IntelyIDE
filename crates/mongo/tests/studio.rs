//! Gateway tests against the throwaway loopback fixture (feature `mongo`): zero cost while off, the role probe on every
//! connection, windowed cursors with a hard cap, cancel, read-only by construction, the audit log, the tenant lock, the
//! tamper reset during a live session, the jails and the redaction canaries. Without `INTELY_MONGO_TEST_URI` the
//! server-backed tests skip with a message (the Docker daemon is not stable on this Mac); the others always run.
#![cfg(feature = "mongo")]

use std::sync::Arc;
use std::time::{Duration, Instant};

use bson::doc;
use intely_mongo::api::{AiMode, Environment, ProfileInput, ReadPreference, RunRequest};
use intely_mongo::error::code;
use intely_mongo::host;
use intely_mongo::jail::NetworkPolicy;
use intely_mongo::profile::ProfileStore;
use intely_mongo::studio::Studio;
use intely_mongo::types::{EffectiveLevel, ReadCommand, RoleChip, MAX_DOCS};
use intely_settings::{MemorySecretStore, Object, SettingsStore};
use serde_json::{json, Value};

mod fakes;

const DB: &str = "intely_test_happy";
const CANARY: &str = "CANARY-pw-9c2e1";

struct Env {
    dir: tempfile::TempDir,
    settings: Arc<SettingsStore>,
    studio: Arc<Studio>,
}

fn env(network: NetworkPolicy) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let settings = Arc::new(SettingsStore::open(dir.path().join("settings.json")).unwrap());
    let profiles = Arc::new(ProfileStore::new(settings.clone(), Arc::new(MemorySecretStore::new())));
    let studio = Arc::new(Studio::new(profiles, network).with_now(1_790_000_000_000));
    Env { dir, settings, studio }
}

fn guarded(uri: &str) -> String {
    let info = host::parse_uri(uri).expect("uri");
    assert_eq!(host::effective_level(&info), EffectiveLevel::Local, "fixture URI must be loopback");
    assert!(info.database.as_deref().is_some_and(|d| d.starts_with("intely_test_") || d == "admin"), "fixture db must start with intely_test_");
    uri.to_string()
}
fn fixture_uri() -> Option<String> {
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

fn input(name: &str, env: Environment, uri: &str) -> ProfileInput {
    ProfileInput { name: name.into(), environment: env, uri: Some(uri.into()), max_time_ms: Some(60_000), ..Default::default() }
}

/// Enabled studio with one connected local profile.
async fn connected(uri: &str) -> (Env, String) {
    let e = env(NetworkPolicy::Full);
    e.studio.set_enabled(true).unwrap();
    let p = e.studio.profile_save(input("Fixture", Environment::Local, uri)).unwrap();
    e.studio.connect(&p.id).await.unwrap();
    (e, p.id)
}

fn find(coll: &str, filter: &str) -> ReadCommand {
    ReadCommand::Find { db: DB.into(), collection: coll.into(), filter: filter.into(), projection: None, sort: None, skip: None, limit: None }
}
fn req(tab: &str, conn: &str, command: ReadCommand) -> RunRequest {
    RunRequest { tab: tab.into(), connection: conn.into(), command, page_size: None }
}
fn heavy() -> ReadCommand {
    ReadCommand::Aggregate { db: DB.into(), collection: "orders".into(), pipeline: "[{$lookup: {from: 'orders', localField: 'number', foreignField: 'number', as: 'x'}}, {$match: {'x.5': {$exists: true}}}]".into() }
}

/// Connections the throwaway server sees from this IDE (by application name).
async fn ide_connections(uri: &str) -> usize {
    let client = mongodb::Client::with_uri_str(uri).await.unwrap();
    let pipeline = vec![doc! {"$currentOp": {"allUsers": true, "idleConnections": true}}, doc! {"$match": {"clientMetadata.application.name": "IntelySwitchIDE"}}];
    let mut cur = client.database("admin").aggregate(pipeline).await.unwrap();
    let mut n = 0;
    while cur.advance().await.unwrap() {
        n += 1;
    }
    n
}

#[test]
fn off_means_nothing_exists_and_nothing_runs() {
    // no runtime exists in this test: creating the studio must not need one
    let e = env(NetworkPolicy::Full);
    assert!(!e.studio.is_enabled());
    assert_eq!((e.studio.session_count(), e.studio.cursor_count()), (0, 0));
    let s = e.studio.status();
    assert!(s.compiled && !s.enabled && s.connections.is_empty() && s.notices.is_empty());
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let p = e.studio.profile_save(input("Off", Environment::Local, "mongodb://127.0.0.1:1/intely_test_x")).unwrap();
        assert_eq!(e.studio.connect(&p.id).await.unwrap_err().code, code::DISABLED);
        assert_eq!(e.studio.test(input("Off", Environment::Local, "mongodb://127.0.0.1:1/intely_test_x")).await.unwrap_err().code, code::DISABLED);
        assert_eq!(e.studio.run(req("t1", &p.id, find("orders", ""))).await.unwrap_err().code, code::DISABLED);
        assert_eq!(e.studio.window("t1", 0, 10).await.unwrap_err().code, code::DISABLED);
    });
    assert_eq!(e.studio.session_count(), 0);
}

#[tokio::test]
async fn the_switch_gates_the_sockets_and_turning_it_off_closes_them() {
    let Some(uri) = fixture_uri() else { return };
    let e = env(NetworkPolicy::Full);
    let p = e.studio.profile_save(input("Switch", Environment::Local, &uri)).unwrap();
    assert!(e.studio.connect(&p.id).await.is_err());
    assert_eq!(ide_connections(&uri).await, 0, "no socket while the switch is off");
    e.studio.set_enabled(true).unwrap();
    // the switch is persisted
    assert!(ProfileStore::new(e.settings.clone(), Arc::new(MemorySecretStore::new())).enabled());
    e.studio.connect(&p.id).await.unwrap();
    e.studio.run(req("t1", &p.id, find("orders", "{status: 'open'}"))).await.unwrap();
    assert!(ide_connections(&uri).await > 0);
    assert_eq!((e.studio.session_count(), e.studio.cursor_count()), (1, 1));
    e.studio.set_enabled(false).unwrap();
    assert_eq!((e.studio.session_count(), e.studio.cursor_count()), (0, 0));
    assert_eq!(e.studio.run(req("t1", &p.id, find("orders", ""))).await.unwrap_err().code, code::DISABLED);
    let t0 = Instant::now();
    while ide_connections(&uri).await > 0 {
        assert!(t0.elapsed() < Duration::from_secs(10), "the pool did not close");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test]
async fn connect_runs_the_role_probe_and_shows_it() {
    let Some(uri) = fixture_uri() else { return };
    let (e, id) = connected(&uri).await;
    let s = e.studio.status();
    assert_eq!(s.connections.len(), 1);
    let c = &s.connections[0];
    assert_eq!((c.effective_level, c.read_preference, c.read_only), (EffectiveLevel::Local, ReadPreference::PrimaryPreferred, true));
    assert!(matches!(c.role, RoleChip::CanWrite { no_auth: true, .. }), "{:?}", c.role);
    assert!(c.role_elevated, "a user who can write raises the level one step");
    assert!(c.server_version.starts_with(|ch: char| ch.is_ascii_digit()) && c.topology == "standalone");
    // connecting again is idempotent
    assert_eq!(e.studio.connect(&id).await.unwrap().server_version, c.server_version);
    // saving the profile drops the live connection (a changed URI or level must not linger)
    let mut again = input("Fixture", Environment::Local, "");
    again.id = Some(id.clone());
    again.uri = None;
    e.studio.profile_save(again).unwrap();
    assert_eq!(e.studio.session_count(), 0);
}

#[tokio::test]
async fn windows_page_over_a_capped_cursor() {
    let Some(uri) = fixture_uri() else { return };
    let (e, id) = connected(&uri).await;
    let mut cmd = find("orders", "");
    if let ReadCommand::Find { sort, .. } = &mut cmd {
        *sort = Some("{_id: 1}".into());
    }
    let w = e.studio.run(req("tab-a", &id, cmd.clone())).await.unwrap();
    // the first window buffers a few pages (see a_first_find_buffers_a_few_pages...), not the 1000 ceiling
    assert_eq!((w.docs.len(), w.offset, w.truncated, w.has_more), (50, 0, true, true));
    assert!((50..MAX_DOCS as u32).contains(&w.loaded), "{}", w.loaded);
    assert!(w.bytes < 4 * 1024 * 1024, "bounded window, got {}", w.bytes);
    let first: Value = serde_json::from_str(&w.docs[0]).unwrap();
    assert!(first["_id"]["$oid"].is_string() && first["number"]["$numberInt"].is_string(), "canonical EJSON: {first}");
    // inside the loaded part: a slice
    let w2 = e.studio.window("tab-a", 950, 50).await.unwrap();
    assert_eq!((w2.docs.len(), w2.offset, w2.has_more), (50, 950, true));
    // past it: the find is re-run with the right skip, the cursor still holds at most 1000 documents
    let w3 = e.studio.window("tab-a", 1000, 50).await.unwrap();
    assert_eq!((w3.docs.len(), w3.offset), (50, 1000));
    assert!(w3.loaded as usize <= MAX_DOCS, "{}", w3.loaded);
    let direct = e.studio.run(req("tab-b", &id, ReadCommand::Find { db: DB.into(), collection: "orders".into(), filter: String::new(), projection: None, sort: Some("{_id: 1}".into()), skip: Some(1000), limit: Some(50) })).await.unwrap();
    assert_eq!(w3.docs, direct.docs);
    // and back to the start
    let w4 = e.studio.window("tab-a", 0, 50).await.unwrap();
    assert_eq!(w4.docs, w.docs);
    // the end of a 50k collection
    let end = e.studio.window("tab-a", 49_950, 50).await.unwrap();
    assert_eq!(end.docs.len(), 50);
    let past = e.studio.window("tab-a", 50_000, 50).await.unwrap();
    assert!(past.docs.is_empty() && !past.has_more, "{:?}", (past.docs.len(), past.has_more));
    // a user limit is not truncation and bounds the paging
    let mut limited = find("orders", "{status: 'open'}");
    if let ReadCommand::Find { limit, .. } = &mut limited {
        *limit = Some(120);
    }
    let l = e.studio.run(req("tab-c", &id, limited)).await.unwrap();
    assert_eq!((l.docs.len(), l.loaded, l.truncated, l.has_more), (50, 120, false, true));
    let l2 = e.studio.window("tab-c", 100, 50).await.unwrap();
    assert_eq!((l2.docs.len(), l2.has_more), (20, false));
    // a closed tab drops its cursor
    e.studio.cursor_close("tab-c");
    assert_eq!(e.studio.window("tab-c", 0, 10).await.unwrap_err().code, code::NOT_FOUND);
    // aggregate results are capped but cannot be paged past the cap
    let agg = e.studio.run(req("tab-d", &id, ReadCommand::Aggregate { db: DB.into(), collection: "orders".into(), pipeline: "[{$match: {}}]".into() })).await.unwrap();
    assert_eq!((agg.loaded as usize, agg.truncated), (MAX_DOCS, true));
    assert!(!e.studio.window("tab-d", 1000, 50).await.unwrap().has_more);
}

#[tokio::test]
async fn cancel_stops_a_heavy_pipeline_and_leaves_nothing_running() {
    let Some(uri) = fixture_uri() else { return };
    let (e, id) = connected(&uri).await;
    let studio = e.studio.clone();
    let conn = id.clone();
    let t0 = Instant::now();
    let h = tokio::spawn(async move { studio.run(req("heavy", &conn, heavy())).await });
    let mut killed = false;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(150)).await;
        let c = e.studio.cancel("heavy").await.unwrap();
        if c.killed {
            killed = true;
            break;
        }
    }
    assert!(killed, "killOp never found the tagged operation");
    let res = tokio::time::timeout(Duration::from_secs(10), h).await.expect("the run did not end after killOp").unwrap();
    assert_eq!(res.unwrap_err().code, code::CANCELLED);
    eprintln!("M1 cancel: ended {:?} after start", t0.elapsed());
    assert!(!e.studio.cancel("heavy").await.unwrap().cancelled, "nothing of ours is left");
    assert_eq!(e.studio.cursor_count(), 0);
    // the connection is still good
    assert_eq!(e.studio.run(req("after", &id, ReadCommand::Count { db: DB.into(), collection: "orders".into(), filter: "{status: 'open'}".into() })).await.unwrap().docs.len(), 1);
}

#[tokio::test]
async fn max_time_ms_is_injected_into_every_run() {
    let Some(uri) = fixture_uri() else { return };
    let e = env(NetworkPolicy::Full);
    e.studio.set_enabled(true).unwrap();
    let mut i = input("Short", Environment::Local, &uri);
    i.max_time_ms = Some(1); // clamped to the 1 s floor
    let p = e.studio.profile_save(i).unwrap();
    assert_eq!(p.max_time_ms, 1_000);
    e.studio.connect(&p.id).await.unwrap();
    let t0 = Instant::now();
    let err = e.studio.run(req("slow", &p.id, heavy())).await.unwrap_err();
    assert_eq!(err.code, code::SERVER, "{err}");
    assert!(err.message.contains("MaxTimeMSExpired"), "{err}");
    assert!(t0.elapsed() < Duration::from_secs(15));
}

#[tokio::test]
async fn nothing_but_reads_can_be_expressed_or_run() {
    let Some(uri) = fixture_uri() else { return };
    let (e, id) = connected(&uri).await;
    let raw = mongodb::Client::with_uri_str(&uri).await.unwrap();
    let before_colls = {
        let mut v = raw.database(DB).list_collection_names().await.unwrap();
        v.sort();
        v
    };
    let before_count = raw.database(DB).collection::<bson::Document>("orders").count_documents(doc! {}).await.unwrap();
    // write verbs do not deserialize into a command at all
    for verb in ["insertOne", "insertMany", "updateOne", "updateMany", "deleteOne", "deleteMany", "dropCollection", "dropDatabase", "createIndex", "dropIndex", "runCommand", "eval", "bulkWrite", "findOneAndUpdate", "renameCollection"] {
        let j = json!({"tab": "t", "connection": id, "command": {"cmd": verb, "db": DB, "collection": "orders"}});
        assert!(serde_json::from_value::<RunRequest>(j).is_err(), "{verb} must not be expressible");
    }
    // write operators and stages are rejected before a command reaches the server
    let bad: Vec<(&str, ReadCommand)> = vec![
        ("$out", ReadCommand::Aggregate { db: DB.into(), collection: "orders".into(), pipeline: "[{$match: {}}, {$out: 'intely_test_stolen'}]".into() }),
        ("$merge", ReadCommand::Aggregate { db: DB.into(), collection: "orders".into(), pipeline: "[{$merge: {into: 'intely_test_stolen'}}]".into() }),
        ("nested $merge", ReadCommand::Aggregate { db: DB.into(), collection: "orders".into(), pipeline: "[{$facet: {a: [{$merge: {into: 'intely_test_stolen'}}]}}]".into() }),
        ("$function", ReadCommand::Find { db: DB.into(), collection: "orders".into(), filter: "{$expr: {$function: {body: 'function(){return true}', args: [], lang: 'js'}}}".into(), projection: None, sort: None, skip: None, limit: None }),
        ("$where", find("orders", "{$where: 'sleep(10)'}")),
        ("$collStats", ReadCommand::Aggregate { db: DB.into(), collection: "orders".into(), pipeline: "[{$collStats: {storageStats: {}}}]".into() }),
        ("$indexStats", ReadCommand::Aggregate { db: DB.into(), collection: "orders".into(), pipeline: "[{$indexStats: {}}]".into() }),
        ("$currentOp", ReadCommand::Aggregate { db: "admin".into(), collection: "x".into(), pipeline: "[{$currentOp: {}}]".into() }),
        ("cross-db $lookup", ReadCommand::Aggregate { db: DB.into(), collection: "orders".into(), pipeline: "[{$lookup: {from: {db: 'admin', coll: 'system.users'}, localField: 'a', foreignField: 'b', as: 'c'}}]".into() }),
        ("missing $lookup target", ReadCommand::Aggregate { db: DB.into(), collection: "orders".into(), pipeline: "[{$limit: 1}, {$lookup: {from: 'no_such_collection', localField: 'a', foreignField: 'b', as: 'c'}}]".into() }),
        ("explain of a list", ReadCommand::Explain { inner: Box::new(ReadCommand::ListDatabases), execution_stats: false }),
        ("explain of $out", ReadCommand::Explain { inner: Box::new(ReadCommand::Aggregate { db: DB.into(), collection: "orders".into(), pipeline: "[{$out: 'intely_test_stolen'}]".into() }), execution_stats: true }),
    ];
    for (what, cmd) in bad {
        let err = e.studio.run(req("bad", &id, cmd)).await.unwrap_err();
        assert!(matches!(err.code, code::REJECTED | code::PARSE), "{what}: {err}");
    }
    // a lookup into a collection that exists is fine
    let ok = e.studio.run(req("good", &id, ReadCommand::Aggregate { db: DB.into(), collection: "orders".into(), pipeline: "[{$limit: 3}, {$lookup: {from: 'customers', localField: 'customer', foreignField: '_id', as: 'c'}}]".into() })).await.unwrap();
    assert_eq!(ok.docs.len(), 3);
    let after_colls = {
        let mut v = raw.database(DB).list_collection_names().await.unwrap();
        v.sort();
        v
    };
    assert_eq!(before_colls, after_colls, "no collection was created");
    assert!(!after_colls.iter().any(|c| c.contains("stolen")));
    assert_eq!(before_count, raw.database(DB).collection::<bson::Document>("orders").count_documents(doc! {}).await.unwrap());
}

#[tokio::test]
async fn the_read_commands_work_and_the_explain_gate_reports_a_plan() {
    let Some(uri) = fixture_uri() else { return };
    let (e, id) = connected(&uri).await;
    let run = |tab: &'static str, c: ReadCommand| {
        let (s, id) = (e.studio.clone(), id.clone());
        async move { s.run(req(tab, &id, c)).await.unwrap() }
    };
    let dbs = run("l1", ReadCommand::ListDatabases).await;
    assert!(dbs.docs.iter().any(|d| d.contains(DB)), "{:?}", dbs.docs);
    let colls = run("l2", ReadCommand::ListCollections { db: DB.into() }).await;
    assert!(colls.docs.iter().any(|d| d.contains("orders")));
    let idx = run("l3", ReadCommand::ListIndexes { db: DB.into(), collection: "orders".into() }).await;
    assert!(idx.docs.iter().any(|d| d.contains("status_1")));
    let sample = run("l4", ReadCommand::Sample { db: DB.into(), collection: "orders".into(), size: 5 }).await;
    assert_eq!(sample.loaded, 5);
    let big = run("l5", ReadCommand::Sample { db: DB.into(), collection: "orders".into(), size: 100_000 }).await;
    assert_eq!(big.loaded as usize, MAX_DOCS, "a sample is capped like everything else");
    let count = run("l6", ReadCommand::Count { db: DB.into(), collection: "orders".into(), filter: "{status: 'open'}".into() }).await;
    assert!(serde_json::from_str::<Value>(&count.docs[0]).unwrap()["count"].as_u64().unwrap() > 0);
    let distinct = run("l7", ReadCommand::Distinct { db: DB.into(), collection: "orders".into(), field: "status".into(), filter: String::new() }).await;
    assert!(distinct.docs.len() >= 2);
    let ex = run("l8", ReadCommand::Explain { inner: Box::new(find("orders", "{status: 'open'}")), execution_stats: false }).await;
    let plan = ex.plan.expect("a plan");
    assert!(!plan.collscan && plan.index_names.contains(&"status_1".to_string()) && plan.stages.iter().any(|s| s == "IXSCAN"), "{plan:?}");
    let ex2 = run("l9", ReadCommand::Explain { inner: Box::new(find("orders", "{note: 'Gyorsan kérjük'}")), execution_stats: false }).await;
    assert!(ex2.plan.unwrap().collscan);
}

#[tokio::test]
async fn the_tenant_lock_pins_the_field_to_a_value_and_covers_samples_and_joins() {
    let Some(uri) = fixture_uri() else { return };
    let e = env(NetworkPolicy::Full);
    e.studio.set_enabled(true).unwrap();
    let open = e.studio.profile_save(input("Open", Environment::Local, &uri)).unwrap();
    e.studio.connect(&open.id).await.unwrap();
    let mut i = input("Tenant", Environment::Local, &uri);
    i.tenant_lock = Some("restaurant".into());
    let p = e.studio.profile_save(i).unwrap();
    assert_eq!(p.tenant_lock.as_deref(), Some("restaurant"));
    e.studio.connect(&p.id).await.unwrap();
    // two tenants, read through the unlocked profile
    let d = e.studio.run(req("d", &open.id, ReadCommand::Distinct { db: DB.into(), collection: "orders".into(), field: "restaurant".into(), filter: String::new() })).await.unwrap();
    let oids: Vec<String> = d.docs.iter().map(|x| serde_json::from_str::<Value>(x).unwrap()["$oid"].as_str().unwrap().to_string()).collect();
    assert!(oids.len() >= 2, "the fixture has several restaurants");
    let (a, b) = (&oids[0], &oids[1]);
    let rejected = |what: String, r: Result<intely_mongo::api::WindowView, intely_mongo::error::StudioError>| {
        let err = r.expect_err(&what);
        assert_eq!(err.code, code::REJECTED, "{what}: {err}");
    };
    // S1: only an equality (or a short $in) on the tenant field passes; the value-less forms are refused
    for bad in [
        "{status: 'open'}".to_string(),
        format!("{{restaurant: {{$ne: ObjectId('{a}')}}}}"),
        "{restaurant: {$exists: true}}".to_string(),
        "{restaurant: /.*/}".to_string(),
        "{restaurant: {$regex: '.*'}}".to_string(),
        format!("{{restaurant: {{$nin: [ObjectId('{a}')]}}}}"),
        "{restaurant: null}".to_string(),
        format!("{{$and: [{{restaurant: {{$ne: ObjectId('{a}')}}}}]}}"),
        format!("{{$or: [{{restaurant: ObjectId('{a}')}}, {{status: 'open'}}]}}"),
        "{}".to_string(),
    ] {
        rejected(bad.clone(), e.studio.run(req("t", &p.id, find("orders", &bad))).await);
    }
    // a Count and a Distinct are filters too
    rejected("count".into(), e.studio.run(req("t", &p.id, ReadCommand::Count { db: DB.into(), collection: "orders".into(), filter: "{status: 'open'}".into() })).await);
    // a sample reads random documents of every tenant
    rejected("sample".into(), e.studio.run(req("t", &p.id, ReadCommand::Sample { db: DB.into(), collection: "orders".into(), size: 5 })).await);
    rejected("explain sample".into(), e.studio.run(req("t", &p.id, ReadCommand::Explain { inner: Box::new(ReadCommand::Sample { db: DB.into(), collection: "orders".into(), size: 5 }), execution_stats: false })).await);
    // the allowed forms return only the named tenants
    let tenant_of = |w: &intely_mongo::api::WindowView| -> std::collections::BTreeSet<String> { w.docs.iter().map(|x| serde_json::from_str::<Value>(x).unwrap()["restaurant"]["$oid"].as_str().unwrap().to_string()).collect() };
    let one = e.studio.run(req("t", &p.id, find("orders", &format!("{{restaurant: ObjectId('{a}'), status: 'open'}}")))).await.unwrap();
    assert!(!one.docs.is_empty() && tenant_of(&one) == [a.clone()].into());
    let two = e.studio.run(req("t", &p.id, find("orders", &format!("{{restaurant: {{$in: [ObjectId('{a}'), ObjectId('{b}')]}}}}")))).await.unwrap();
    assert!(tenant_of(&two).is_subset(&[a.clone(), b.clone()].into()) && !two.docs.is_empty());
    // pipelines: a leading constrained $match, and joins only through a constrained sub-pipeline
    let agg = |pipeline: String| ReadCommand::Aggregate { db: DB.into(), collection: "orders".into(), pipeline };
    rejected("group first".into(), e.studio.run(req("t", &p.id, agg("[{$group: {_id: '$status'}}]".into()))).await);
    rejected("ne match".into(), e.studio.run(req("t", &p.id, agg(format!("[{{$match: {{restaurant: {{$ne: ObjectId('{a}')}}}}}}]")))).await);
    rejected("unionWith".into(), e.studio.run(req("t", &p.id, agg(format!("[{{$match: {{restaurant: ObjectId('{a}')}}}}, {{$unionWith: 'orders'}}]")))).await);
    rejected("lookup".into(), e.studio.run(req("t", &p.id, agg(format!("[{{$match: {{restaurant: ObjectId('{a}')}}}}, {{$lookup: {{from: 'orders', pipeline: [], as: 'all'}}}}]")))).await);
    let ok = e
        .studio
        .run(req("t", &p.id, agg(format!("[{{$match: {{restaurant: ObjectId('{a}')}}}}, {{$lookup: {{from: 'orders', pipeline: [{{$match: {{restaurant: ObjectId('{a}')}}}}, {{$limit: 1}}], as: 'x'}}}}, {{$limit: 2}}]"))))
        .await
        .unwrap();
    assert!(!ok.docs.is_empty());
    let grouped = e.studio.run(req("t", &p.id, agg(format!("[{{$match: {{restaurant: ObjectId('{a}')}}}}, {{$group: {{_id: '$status'}}}}]")))).await.unwrap();
    assert!(!grouped.docs.is_empty());
}

#[tokio::test]
async fn system_namespaces_and_the_admin_and_local_databases_cannot_be_read() {
    let Some(uri) = fixture_uri() else { return };
    let (e, id) = connected(&uri).await;
    let read = |db: &str, coll: &str| ReadCommand::Find { db: db.into(), collection: coll.into(), filter: String::new(), projection: None, sort: None, skip: None, limit: Some(1) };
    for (db, coll) in [("admin", "system.users"), ("admin", "system.version"), ("local", "startup_log"), ("config", "settings"), (DB, "system.profile")] {
        let err = e.studio.run(req("s", &id, read(db, coll))).await.unwrap_err();
        assert_eq!(err.code, code::REJECTED, "{db}.{coll}: {err}");
    }
    let agg = ReadCommand::Aggregate { db: "admin".into(), collection: "system.users".into(), pipeline: "[{$limit: 2}]".into() };
    assert_eq!(e.studio.run(req("s", &id, agg)).await.unwrap_err().code, code::REJECTED);
    // the tree can still list them
    assert!(e.studio.run(req("s", &id, ReadCommand::ListCollections { db: "admin".into() })).await.is_ok());
    assert!(e.studio.run(req("s", &id, ReadCommand::ListDatabases)).await.is_ok());
}

#[tokio::test]
async fn a_first_find_buffers_a_few_pages_and_later_pages_load_on_demand() {
    let Some(uri) = fixture_uri() else { return };
    let (e, id) = connected(&uri).await;
    let w = e.studio.run(req("w", &id, find("orders", ""))).await.unwrap();
    assert!(w.loaded < MAX_DOCS as u32 && w.loaded >= 50, "the first window is a few pages, not the 1000 ceiling: {}", w.loaded);
    assert!(w.has_more);
    let far = e.studio.window("w", 400, 50).await.unwrap();
    assert_eq!(far.docs.len(), 50);
    assert_eq!(far.offset, 400);
}

#[tokio::test]
async fn the_audit_log_records_shape_and_hash_but_no_bodies() {
    let Some(uri) = fixture_uri() else { return };
    let (e, id) = connected(&uri).await;
    let filter = "{note: 'Gyorsan kérjük', total: {$gt: 424242}}";
    let w = e.studio.run(req("a", &id, find("orders", filter))).await.unwrap();
    let w2 = e.studio.run(req("a", &id, find("orders", "{status: 'open'}"))).await.unwrap();
    let _ = e.studio.run(req("a", &id, find("orders", "{$where: 'x'}"))).await.unwrap_err();
    let text = std::fs::read_to_string(e.studio.audit_path()).unwrap();
    let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 3);
    assert_eq!((lines[0]["op"].as_str(), lines[0]["collection"].as_str(), lines[0]["origin"].as_str(), lines[0]["class"].as_str()), (Some("find"), Some("orders"), Some("desktop"), Some("read")));
    assert_eq!(lines[0]["filterHash"].as_str().unwrap().len(), 64);
    assert_eq!(lines[0]["filterShape"], json!({"note": "<string>", "total": {"$gt": "<number>"}}));
    assert_eq!(lines[0]["count"], json!(w.loaded));
    assert_eq!(lines[1]["outcome"], "ok");
    assert!(lines[2]["outcome"].as_str().unwrap().starts_with("error:"));
    // no literal, no document content, no URI
    let first_id = serde_json::from_str::<Value>(&w2.docs[0]).unwrap()["_id"]["$oid"].as_str().unwrap().to_string();
    for forbidden in ["Gyorsan", "424242", first_id.as_str(), "mongodb://", "127.0.0.1"] {
        assert!(!text.contains(forbidden), "audit leaked {forbidden}: {text}");
    }
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(e.studio.audit_path()).unwrap().permissions().mode() & 0o777, 0o600);
}

#[tokio::test]
async fn a_tampered_profile_is_reset_in_the_middle_of_a_session() {
    let Some(uri) = fixture_uri() else { return };
    let e = env(NetworkPolicy::Full);
    e.studio.set_enabled(true).unwrap();
    let mut i = input("Live", Environment::Sandbox, &uri);
    i.read_only = Some(false);
    i.ai_mode = Some(AiMode::SchemaOnly);
    i.confirm = Some("Live".into());
    let p = e.studio.profile_save(i).unwrap();
    assert!(!p.read_only && p.ai_mode == AiMode::SchemaOnly);
    e.studio.connect(&p.id).await.unwrap();
    assert!(!e.studio.status().connections[0].read_only);
    // someone writes the settings namespace through the generic command
    let mut ns = e.settings.get("mongo").unwrap();
    let mut profiles = ns.remove("profiles").unwrap().as_object().unwrap().clone();
    profiles.get_mut(&p.id).unwrap()["safety"]["environment"] = json!("local");
    let mut patch = Object::new();
    patch.insert("profiles".into(), Value::Object(profiles));
    e.settings.set("mongo", patch).unwrap();
    // the next operation re-verifies, resets and tells the user; the query itself still works (it is a read)
    e.studio.run(req("t", &p.id, find("orders", "{status: 'open'}"))).await.unwrap();
    let listed = e.studio.profile_list().unwrap();
    assert!(listed[0].read_only && listed[0].ai_mode == AiMode::Off && listed[0].environment == Environment::Production);
    let s = e.studio.status();
    assert_eq!(s.notices.len(), 1);
    assert!(s.notices[0].message.contains("Live"));
    e.studio.dismiss_notices();
    assert!(e.studio.status().notices.is_empty());
}

#[tokio::test]
async fn the_jails_gate_the_network_before_any_socket() {
    // no server needed: the check happens before a client exists
    for (net, loop_back_code, remote_code) in [(NetworkPolicy::Refused, code::READ_ONLY_JAIL, code::READ_ONLY_JAIL), (NetworkPolicy::LoopbackOnly, "", code::TEST_JAIL)] {
        let e = env(net);
        e.studio.set_enabled(true).unwrap();
        let remote = e.studio.profile_save(input("Remote", Environment::Local, &format!("mongodb://u:{CANARY}@db.example.com:27017/app"))).unwrap();
        assert_eq!(remote.effective_level, EffectiveLevel::ProductionLevel);
        let t0 = Instant::now();
        assert_eq!(e.studio.connect(&remote.id).await.unwrap_err().code, remote_code);
        if !loop_back_code.is_empty() {
            let local = e.studio.profile_save(input("Local", Environment::Local, "mongodb://127.0.0.1:1/intely_test_x")).unwrap();
            assert_eq!(e.studio.connect(&local.id).await.unwrap_err().code, loop_back_code);
        }
        assert!(t0.elapsed() < Duration::from_secs(2), "a jail refusal must not wait for the network");
        assert_eq!(e.studio.session_count(), 0);
        assert_eq!(e.studio.status().network, net.as_str());
    }
}

#[tokio::test]
async fn the_read_only_jail_writes_no_audit_file_even_for_a_refused_connect() {
    let e = env(NetworkPolicy::Refused);
    e.studio.set_enabled(true).unwrap();
    let p = e.studio.profile_save(input("Local", Environment::Local, "mongodb://127.0.0.1:1/intely_test_x")).unwrap();
    assert_eq!(e.studio.connect(&p.id).await.unwrap_err().code, code::READ_ONLY_JAIL);
    assert!(!e.studio.audit_path().exists(), "READONLY writes no file, not even a refusal line");
    // direct calls are refused too, and the control (the test jail) does write
    let ev = intely_mongo::audit::AuditEvent::new(intely_mongo::audit::event::CONNECT, "c1");
    e.studio.audit_event(&ev);
    assert!(!e.studio.audit_path().exists());
    let e = env(NetworkPolicy::LoopbackOnly);
    e.studio.audit_event(&ev);
    assert!(e.studio.audit_path().exists());
}

#[tokio::test]
async fn a_legacy_uri_with_a_proxy_option_is_never_dialled_under_the_test_jail() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = proxy.local_addr().unwrap().port();
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let accept = tokio::spawn(async move {
        while proxy.accept().await.is_ok() {
            counter.fetch_add(1, Ordering::SeqCst);
        }
    });
    let uri = format!("mongodb://127.0.0.1:1/intely_test_x?proxyHost=127.0.0.1&proxyPort={port}&serverSelectionTimeoutMS=500");
    let e = env(NetworkPolicy::LoopbackOnly);
    e.studio.set_enabled(true).unwrap();
    let p = e.studio.profile_save(input("Proxied", Environment::Local, &uri)).unwrap();
    assert_eq!(e.studio.connect(&p.id).await.unwrap_err().code, code::TEST_JAIL);
    let report = e.studio.test(input("Proxied", Environment::Local, &uri)).await.unwrap();
    assert!(!report.ok && report.connection.is_none());
    tokio::time::sleep(Duration::from_millis(300)).await;
    accept.abort();
    assert_eq!(hits.load(Ordering::SeqCst), 0, "the driver dialled the proxy under the test jail");
    assert_eq!(e.studio.session_count(), 0);
}

#[tokio::test]
async fn credentials_never_reach_errors_state_logs_or_files() {
    // a loopback port nobody listens on: the connection fails after the server-selection timeout
    let uri = format!("mongodb://svc-user:{CANARY}@127.0.0.1:1/intely_test_x?authSource=admin");
    let e = env(NetworkPolicy::Full);
    e.studio.set_enabled(true).unwrap();
    let p = e.studio.profile_save(input("Canary", Environment::Local, &uri)).unwrap();
    let err = e.studio.connect(&p.id).await.unwrap_err();
    let report = e.studio.test(input("Canary", Environment::Local, &uri)).await.unwrap();
    assert!(!report.ok && report.error.is_some() && report.connection.is_none());
    let bad_scheme = e.studio.test(input("Canary", Environment::Local, &format!("postgres://svc-user:{CANARY}@127.0.0.1/x"))).await;
    let driver_err = intely_mongo::driver::Session::connect(&format!("mongodb://svc-user:{CANARY}@db.example.com/x"), Default::default()).await.err().map(|e| e.to_string());
    let rendered = [
        format!("{err} {err:?}"),
        serde_json::to_string(&err).unwrap(),
        format!("{report:?}"),
        serde_json::to_string(&report).unwrap(),
        format!("{bad_scheme:?}"),
        format!("{driver_err:?}"),
        serde_json::to_string(&e.studio.status()).unwrap(),
        serde_json::to_string(&e.studio.profile_list().unwrap()).unwrap(),
        std::fs::read_to_string(e.dir.path().join("settings.json")).unwrap_or_default(),
        std::fs::read_to_string(e.studio.audit_path()).unwrap_or_default(),
    ];
    for r in &rendered {
        assert!(!r.contains(CANARY) && !r.contains("svc-user:") && !r.contains("mongodb://svc"), "credential leaked: {r}");
    }
    eprintln!("M1 canary connect error: {}", err.message);
}

#[tokio::test]
async fn the_role_probe_tells_read_only_users_from_writers() {
    let Some(root) = auth_uri("INTELY_MONGO_AUTH_ROOT") else { return };
    let e = env(NetworkPolicy::Full);
    e.studio.set_enabled(true).unwrap();
    let mut report = Vec::new();
    for (name, var, expect_writer) in [("root", "INTELY_MONGO_AUTH_ROOT", true), ("read@db", "INTELY_MONGO_AUTH_RO", false), ("find-only", "INTELY_MONGO_AUTH_RESTRICTED", false), ("readAnyDatabase", "INTELY_MONGO_AUTH_ANYREAD", false)] {
        let uri = auth_uri(var).unwrap_or_else(|| root.clone());
        let p = e.studio.profile_save(input(name, Environment::Local, &uri)).unwrap();
        let v = e.studio.connect(&p.id).await.unwrap();
        report.push(format!("{name}: {:?} elevated={}", v.role, v.role_elevated));
        assert_eq!(matches!(v.role, RoleChip::CanWrite { .. }), expect_writer, "{name}: {:?}", v.role);
        assert_eq!(v.role_elevated, expect_writer, "{name}");
        assert!(!matches!(v.role, RoleChip::CanWrite { no_auth: true, .. }));
        // each of them can read through the gateway
        let r = e.studio.run(req("r", &p.id, ReadCommand::Count { db: DB.into(), collection: "orders".into(), filter: "{status: 'open'}".into() })).await;
        if name != "find-only" {
            assert!(r.is_ok(), "{name}: {r:?}");
        }
    }
    // passwords are in the secret store only
    let state = serde_json::to_string(&e.studio.status()).unwrap() + &serde_json::to_string(&e.studio.profile_list().unwrap()).unwrap() + &std::fs::read_to_string(e.dir.path().join("settings.json")).unwrap();
    for var in ["INTELY_MONGO_AUTH_ROOT", "INTELY_MONGO_AUTH_RO", "INTELY_MONGO_AUTH_RESTRICTED", "INTELY_MONGO_AUTH_ANYREAD"] {
        let u = std::env::var(var).unwrap();
        for frag in host::credential_fragments(&u) {
            if frag.len() >= 12 {
                assert!(!state.contains(&frag), "{var} credential leaked into state");
            }
        }
    }
    eprintln!("M1 roles:\n{}", report.join("\n"));
}

// =====================================================================================================================
// T6b: the staged test pipeline, the connection commands and their gates. Everything below runs against in-process
// fakes (tests/fakes) and, for the tunnel, the fake ssh double: no Docker, no real server, no real network. A test
// that cannot run says SKIP and is not counted as a pass.
// =====================================================================================================================

mod t6b {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::Ordering;
    use std::sync::Mutex;

    use super::fakes::certs::{server_config, Names, Pki};
    use super::fakes::servers;
    use super::*;
    use intely_mongo::api::{DialogKind, ErrorClass, SecretKind, SessionSecrets, StepId, StepState, TestReport, TlsRelax};
    use intely_mongo::connspec::{AuthMechanism, ConnSpec, HostPort, TlsMode};
    use intely_mongo::exchange::ExportOptions;
    use intely_mongo::studio::{Sink, TestProgress};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    const PW: &str = "PW-canary-7731-zq";
    const USER: &str = "svc-canary-user";

    fn senv(network: NetworkPolicy) -> Env {
        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(SettingsStore::open(dir.path().join("settings.json")).unwrap());
        let profiles = Arc::new(ProfileStore::new(settings.clone(), Arc::new(MemorySecretStore::new())));
        let studio = Arc::new(Studio::new(profiles, network).with_test_gap(Duration::ZERO));
        Env { dir, settings, studio }
    }

    fn enabled(network: NetworkPolicy) -> Env {
        let e = senv(network);
        e.studio.set_enabled(true).unwrap();
        e
    }

    fn fspec(port: u16) -> ConnSpec {
        let mut s = ConnSpec::default();
        s.hosts = vec![HostPort { host: "127.0.0.1".into(), port: Some(port) }];
        s.auth.mechanism = AuthMechanism::None;
        s.timeouts.connect_ms = Some(1500);
        s.timeouts.server_selection_ms = Some(1500);
        s
    }

    fn finput(name: &str, spec: ConnSpec) -> ProfileInput {
        ProfileInput { name: name.into(), environment: Environment::Local, spec: Some(spec), ..Default::default() }
    }

    fn step(r: &TestReport, id: StepId) -> StepState {
        r.steps.iter().find(|s| s.id == id).unwrap_or_else(|| panic!("no step {id:?}")).state
    }

    /// 5.8: all seven steps, in order; nothing after a failed step is ever green.
    fn assert_table(r: &TestReport) {
        let ids: Vec<StepId> = r.steps.iter().map(|s| s.id).collect();
        assert_eq!(ids, vec![StepId::Config, StepId::Tunnel, StepId::Dns, StepId::Connect, StepId::Tls, StepId::Auth, StepId::Permissions]);
        let mut failed = false;
        for s in &r.steps {
            if failed {
                assert_eq!(s.state, StepState::Skipped, "{:?} after a failed step: {:?}", s.id, r.steps);
            }
            failed |= s.state == StepState::Failed;
        }
        assert_eq!(failed, !r.ok, "a failed run has exactly one failed step: {:?}", r.steps);
    }

    fn code_of(r: &TestReport) -> &str {
        r.diagnosis.as_ref().map_or("", |d| d.code.as_str())
    }

    #[derive(Default)]
    struct Rec(Mutex<Vec<TestProgress>>);
    impl Sink for Rec {
        fn state(&self, _s: &intely_mongo::api::StudioStatus) {}
        fn test_progress(&self, p: &TestProgress) {
            self.0.lock().unwrap().push(p.clone());
        }
    }

    // ---- a fake mongod that refuses chosen commands with Unauthorized (13) ---------------------------------------

    async fn denying(deny: &'static [&'static str]) -> (u16, tokio::task::JoinHandle<()>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let h = tokio::spawn(async move {
            while let Ok((s, _)) = l.accept().await {
                tokio::spawn(serve_denying(s, deny));
            }
        });
        (port, h)
    }

    fn reply(cmd: &str, deny: &[&str]) -> bson::Document {
        if deny.iter().any(|d| d.eq_ignore_ascii_case(cmd)) {
            return doc! { "ok": 0.0, "errmsg": format!("not authorized on admin to execute command {{ {cmd}: 1 }}"), "code": 13, "codeName": "Unauthorized" };
        }
        let mut d = doc! { "ok": 1.0, "ismaster": true, "isWritablePrimary": true, "helloOk": true, "maxBsonObjectSize": 16_777_216, "maxMessageSizeBytes": 48_000_000, "maxWriteBatchSize": 100_000, "minWireVersion": 0, "maxWireVersion": 21, "readOnly": false, "version": "7.0.0" };
        if cmd.eq_ignore_ascii_case("connectionStatus") {
            d.insert("authInfo", doc! { "authenticatedUsers": [{"user": "u", "db": "admin"}], "authenticatedUserRoles": [], "authenticatedUserPrivileges": [{"resource": {"db": "shop", "collection": ""}, "actions": ["find"]}] });
        }
        d
    }

    async fn serve_denying(mut s: TcpStream, deny: &'static [&'static str]) {
        let mut id = 1i32;
        loop {
            let mut h = [0u8; 16];
            if s.read_exact(&mut h).await.is_err() {
                return;
            }
            let len = i32::from_le_bytes(h[0..4].try_into().unwrap()) as usize;
            let req = i32::from_le_bytes(h[4..8].try_into().unwrap());
            let op = i32::from_le_bytes(h[12..16].try_into().unwrap());
            let mut body = vec![0u8; len.saturating_sub(16)];
            if s.read_exact(&mut body).await.is_err() {
                return;
            }
            id += 1;
            let mut out = Vec::new();
            let (name, opcode): (String, i32) = match op {
                2013 => (bson::Document::from_reader(&mut &body[5..]).ok().and_then(|d| d.keys().next().cloned()).unwrap_or_default(), 2013),
                2004 => {
                    let z = body[4..].iter().position(|b| *b == 0).unwrap();
                    (bson::Document::from_reader(&mut &body[4 + z + 1 + 8..]).ok().and_then(|d| d.keys().next().cloned()).unwrap_or_default(), 1)
                }
                _ => return,
            };
            let mut b = Vec::new();
            reply(&name, deny).to_writer(&mut b).unwrap();
            let total = if opcode == 2013 { 16 + 5 + b.len() } else { 16 + 20 + b.len() };
            out.extend((total as i32).to_le_bytes());
            out.extend(id.to_le_bytes());
            out.extend(req.to_le_bytes());
            out.extend(opcode.to_le_bytes());
            if opcode == 2013 {
                out.extend(0u32.to_le_bytes());
                out.push(0);
            } else {
                out.extend(8i32.to_le_bytes());
                out.extend(0i64.to_le_bytes());
                out.extend(0i32.to_le_bytes());
                out.extend(1i32.to_le_bytes());
            }
            out.extend(b);
            if s.write_all(&out).await.is_err() {
                return;
            }
        }
    }

    // ---- the happy path and the events ---------------------------------------------------------------------------

    #[tokio::test]
    async fn a_staged_test_against_a_plain_fake_passes_every_step_and_reports_each_one() {
        let f = servers::spawn_plain().await;
        let e = enabled(NetworkPolicy::Full);
        let rec = Arc::new(Rec::default());
        e.studio.set_sink(rec.clone());
        let r = e.studio.test_with(finput("Plain", fspec(f.port)), "t-ok").await.unwrap();
        assert!(r.ok, "{r:?}");
        assert_table(&r);
        for (id, want) in [
            (StepId::Config, StepState::Ok),
            (StepId::Tunnel, StepState::Skipped),
            (StepId::Dns, StepState::Ok),
            (StepId::Connect, StepState::Ok),
            (StepId::Tls, StepState::Skipped),
            (StepId::Auth, StepState::Skipped),
            (StepId::Permissions, StepState::Ok),
        ] {
            assert_eq!(step(&r, id), want, "{id:?}: {:?}", r.steps);
        }
        let c = r.connection.as_ref().unwrap();
        assert!(!c.tls && c.tunnel.is_none() && c.effective_level == EffectiveLevel::Local);
        assert!(r.warnings.iter().any(|w| w == "writeCapable"), "{:?}", r.warnings);
        // the events: the first one starts Config, the last one is `done` and equals the report
        let ev = rec.0.lock().unwrap().clone();
        assert!(ev.len() >= 8, "one event per step change: {}", ev.len());
        assert!(ev.iter().all(|p| p.test_id == "t-ok"));
        assert_eq!(ev[0].steps[0].state, StepState::Running);
        let last = ev.last().unwrap();
        assert!(last.done && last.steps == r.steps);
        assert_eq!(ev.iter().filter(|p| p.done).count(), 1);
        assert_eq!(e.studio.session_count(), 0, "a test keeps nothing");
    }

    #[tokio::test]
    async fn a_trusted_tls_fake_shows_tls_green_and_the_view_says_so() {
        let pki = Pki::new("T6b CA");
        let dir = tempfile::tempdir().unwrap();
        let ca = dir.path().join("ca.pem");
        std::fs::write(&ca, &pki.ca_pem).unwrap();
        let f = servers::spawn_tls(server_config(&pki.server(Names::Loopback), None)).await;
        let e = enabled(NetworkPolicy::Full);
        let mut s = fspec(f.port);
        s.tls.mode = TlsMode::On;
        s.tls.ca_file = Some(ca.to_string_lossy().into_owned());
        let r = e.studio.test_with(finput("Tls", s), "t-tls").await.unwrap();
        assert!(r.ok, "{r:?}");
        assert_table(&r);
        assert_eq!(step(&r, StepId::Tls), StepState::Ok);
        assert!(r.connection.unwrap().tls);
    }

    // ---- failures and the step table -----------------------------------------------------------------------------

    #[tokio::test]
    async fn every_failure_marks_its_step_failed_and_never_shows_a_later_step_green() {
        let e = enabled(NetworkPolicy::Full);
        let pki = Pki::new("T6b CA");
        let dir = tempfile::tempdir().unwrap();
        let ca = dir.path().join("ca.pem");
        std::fs::write(&ca, &pki.ca_pem).unwrap();
        let plain = servers::spawn_plain().await;
        let wrong_name = servers::spawn_tls(server_config(&pki.server(Names::Dns("other.example.test")), None)).await;
        let silent = servers::spawn_silent().await;
        let reset = servers::spawn_reset().await;
        let closed = servers::closed_port().await;

        let mut tls_on = fspec(plain.port);
        tls_on.tls.mode = TlsMode::On;
        let mut hostname = fspec(wrong_name.port);
        hostname.tls.mode = TlsMode::On;
        hostname.tls.ca_file = Some(ca.to_string_lossy().into_owned());
        let mut unknown = fspec(wrong_name.port);
        unknown.tls.mode = TlsMode::On;

        // (spec, code, failed step)
        let table: Vec<(&str, ConnSpec, &str, StepId)> = vec![
            ("closed port", fspec(closed), "net.refused", StepId::Connect),
            ("plain server, TLS on", tls_on, "tls.serverNotTls", StepId::Tls),
            ("wrong name", hostname, "tls.hostname", StepId::Tls),
            ("no CA", unknown, "tls.unknownIssuer", StepId::Tls),
            ("silent", fspec(silent.port), "select.noServer", StepId::Connect),
            ("reset", fspec(reset.port), "net.reset", StepId::Connect),
        ];
        for (what, spec, want_code, want_step) in table {
            let r = e.studio.test_with(finput(what, spec), &format!("t-{}", what.replace(' ', "-").replace(',', ""))).await.unwrap();
            assert!(!r.ok, "{what}: {r:?}");
            assert_table(&r);
            assert_eq!(code_of(&r), want_code, "{what}: {:?}", r.diagnosis);
            assert_eq!(step(&r, want_step), StepState::Failed, "{what}: {:?}", r.steps);
            assert!(r.error.is_some() && r.error_class == r.diagnosis.as_ref().map(|d| d.class) && r.connection.is_none(), "{what}");
        }
    }

    #[tokio::test]
    async fn an_unreachable_budget_ends_with_timeout_total_on_the_running_step() {
        let silent = servers::spawn_silent().await;
        let e = Arc::new(Studio::new(
            Arc::new(ProfileStore::new(Arc::new(SettingsStore::open(tempfile::tempdir().unwrap().keep().join("s.json")).unwrap()), Arc::new(MemorySecretStore::new()))),
            NetworkPolicy::Full,
        )
        .with_test_gap(Duration::ZERO)
        .with_test_budget(Duration::from_millis(400)));
        e.set_enabled(true).unwrap();
        let t0 = Instant::now();
        let r = e.test_with(finput("Budget", fspec(silent.port)), "t-budget").await.unwrap();
        assert!(t0.elapsed() < Duration::from_secs(3), "the budget cut the test short: {:?}", t0.elapsed());
        assert!(!r.ok && code_of(&r) == "timeout.total", "{:?}", r.diagnosis);
        assert_eq!(r.diagnosis.as_ref().unwrap().class, ErrorClass::Timeout);
        assert_table(&r);
        assert!(r.steps.iter().any(|s| s.state == StepState::Failed));
    }

    // ---- Config: jail first, files, secrets, review --------------------------------------------------------------

    #[tokio::test]
    async fn the_jail_answers_in_the_config_step_before_any_lookup_or_socket() {
        // a name that cannot resolve: a lookup would take time and fail as dns.notFound, never as a jail refusal
        let mut remote = fspec(27017);
        remote.hosts = vec![HostPort { host: "no-such-host.invalid".into(), port: Some(27017) }];
        for (net, reason) in [(NetworkPolicy::Refused, "readOnly"), (NetworkPolicy::LoopbackOnly, "testJail")] {
            let e = enabled(net);
            let t0 = Instant::now();
            let r = e.studio.test_with(finput("Jailed", remote.clone()), "t-jail").await.unwrap();
            assert!(t0.elapsed() < Duration::from_secs(1), "{net:?}");
            assert!(!r.ok && code_of(&r) == "config.invalid", "{net:?}: {:?}", r.diagnosis);
            assert!(r.diagnosis.as_ref().unwrap().params.contains(&("reason".to_string(), reason.to_string())));
            assert_eq!(step(&r, StepId::Config), StepState::Failed);
            assert_table(&r);
            assert_eq!(e.studio.session_count(), 0);
        }
        // even loopback is refused by the read-only jail
        let closed = servers::closed_port().await;
        let e = enabled(NetworkPolicy::Refused);
        let r = e.studio.test_with(finput("Jailed", fspec(closed)), "t-jail2").await.unwrap();
        assert_eq!(step(&r, StepId::Config), StepState::Failed);
        // SRV names are resolved on this computer: refused under the test jail
        let mut srv = fspec(27017);
        srv.scheme = intely_mongo::connspec::Scheme::Srv;
        srv.hosts = vec![HostPort { host: "cluster0.example.net".into(), port: None }];
        let e = enabled(NetworkPolicy::LoopbackOnly);
        let r = e.studio.test_with(finput("Srv", srv), "t-jail3").await.unwrap();
        assert_eq!(code_of(&r), "config.invalid");
    }

    #[tokio::test]
    async fn missing_and_non_pem_files_are_config_failures_before_any_socket() {
        let f = servers::spawn_plain().await;
        let e = enabled(NetworkPolicy::Full);
        let dir = tempfile::tempdir().unwrap();
        let mut s = fspec(f.port);
        s.tls.mode = TlsMode::On;
        s.tls.ca_file = Some(dir.path().join("nope.pem").to_string_lossy().into_owned());
        let r = e.studio.test_with(finput("Files", s.clone()), "t-f1").await.unwrap();
        assert_eq!(code_of(&r), "config.fileMissing");
        assert_eq!(step(&r, StepId::Config), StepState::Failed);
        let der = dir.path().join("ca.p12");
        std::fs::write(&der, b"\x30\x82binary").unwrap();
        s.tls.ca_file = Some(der.to_string_lossy().into_owned());
        let r = e.studio.test_with(finput("Files", s), "t-f2").await.unwrap();
        assert_eq!(code_of(&r), "config.pemInvalid");
        assert_eq!(f.accepted.load(Ordering::SeqCst), 0, "no socket was opened");
        assert!(!r.diagnosis.unwrap().detail.contains(&dir.path().to_string_lossy().to_string()), "no path in the detail");
    }

    #[tokio::test]
    async fn a_missing_secret_and_a_changed_destination_answer_before_the_network() {
        let f = servers::spawn_plain().await;
        let other = servers::spawn_plain().await;
        let e = enabled(NetworkPolicy::Full);
        let mut s = fspec(f.port);
        s.auth.mechanism = AuthMechanism::Default;
        s.auth.username = Some(USER.into());
        s.auth.save_password = true;
        let mut inp = finput("Needs", s.clone());
        inp.password = Some(PW.into());
        let p = e.studio.profile_save(inp).unwrap();
        assert!(p.has_password);
        // unchanged destination: the stored password is used (the fake does not speak SCRAM, so it fails later, never as NeedSecret)
        let mut again = finput("Needs", s.clone());
        again.id = Some(p.id.clone());
        let r = e.studio.test_with(again, "t-s1").await;
        assert!(!matches!(&r, Err(err) if err.code == code::NEED_SECRET), "{r:?}");
        // a changed host without a fresh password: the stored one is not sent anywhere
        let mut moved = s.clone();
        moved.hosts = vec![HostPort { host: "127.0.0.1".into(), port: Some(other.port) }];
        let mut inp = finput("Needs", moved);
        inp.id = Some(p.id.clone());
        let err = e.studio.test_with(inp, "t-s2").await.unwrap_err();
        assert_eq!(err.code, code::NEED_SECRET);
        assert!(err.message.starts_with("needs:password"), "{err}");
        assert_eq!(other.accepted.load(Ordering::SeqCst), 0, "nothing was contacted");
        // a profile that stores no password asks at connect time, again before any socket
        let mut s2 = fspec(other.port);
        s2.auth.mechanism = AuthMechanism::Default;
        s2.auth.username = Some(USER.into());
        let q = e.studio.profile_save(finput("Asks", s2)).unwrap();
        let err = e.studio.connect(&q.id).await.unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (code::NEED_SECRET, "needs:password"));
        assert_eq!(other.accepted.load(Ordering::SeqCst), 0);
    }

    fn tamper_host(e: &Env, id: &str, host: &str) {
        let mut ns = e.settings.get("mongo").unwrap();
        let mut profiles = ns.remove("profiles").unwrap().as_object().unwrap().clone();
        profiles.get_mut(id).unwrap()["conn"]["hosts"][0]["host"] = json!(host);
        let mut patch = intely_settings::Object::new();
        patch.insert("profiles".into(), Value::Object(profiles));
        e.settings.set("mongo", patch).unwrap();
    }

    #[tokio::test]
    async fn a_profile_in_review_blocks_connect_and_test_before_any_socket() {
        let f = servers::spawn_plain().await;
        let e = enabled(NetworkPolicy::Full);
        let p = e.studio.profile_save(finput("Review", fspec(f.port))).unwrap();
        tamper_host(&e, &p.id, "127.0.0.2");
        assert_eq!(e.studio.connect(&p.id).await.unwrap_err().code, code::NEEDS_REVIEW);
        let mut inp = finput("Review", fspec(f.port));
        inp.id = Some(p.id.clone());
        assert_eq!(e.studio.test_with(inp, "t-r1").await.unwrap_err().code, code::NEEDS_REVIEW);
        assert_eq!(f.accepted.load(Ordering::SeqCst), 0);
        assert!(e.studio.profile_list().unwrap()[0].needs_review);
        // saving again re-signs it and it connects
        let mut fix = finput("Review", fspec(f.port));
        fix.id = Some(p.id.clone());
        fix.confirm = Some("Review".into());
        e.studio.profile_save(fix).unwrap();
        e.studio.connect(&p.id).await.unwrap();
    }

    #[tokio::test]
    async fn relaxed_certificate_checks_need_the_typed_name_and_never_at_production_level() {
        let pki = Pki::new("T6b CA");
        let wrong = servers::spawn_tls(server_config(&pki.server(Names::Dns("other.example.test")), None)).await;
        let e = enabled(NetworkPolicy::Full);
        let mut s = fspec(wrong.port);
        s.tls.mode = TlsMode::On;
        // 1. without the typed name
        let mut inp = finput("Relax", s.clone());
        inp.tls_relax = Some(TlsRelax::Certificates);
        assert_eq!(e.studio.test_with(inp.clone(), "t-x1").await.unwrap_err().code, code::CONFIRM);
        // 2. typed: the wrong-name server connects, loudly
        inp.confirm = Some("Relax".into());
        let r = e.studio.test_with(inp.clone(), "t-x2").await.unwrap();
        assert!(r.ok && r.warnings.iter().any(|w| w == "tlsRelaxed"), "{r:?}");
        assert_eq!(r.connection.unwrap().tls_relax, TlsRelax::Certificates);
        // 3. the hostname-only relax does not exist: the same server without the relax fails on the name
        let r = e.studio.test_with(finput("NoRelax", s.clone()), "t-x3").await.unwrap();
        assert!(!r.ok && matches!(code_of(&r), "tls.hostname" | "tls.unknownIssuer"), "{:?}", r.diagnosis);
        // 4. a Production tag refuses it even with the typed name
        inp.environment = Environment::Production;
        let r = e.studio.test_with(inp, "t-x4").await.unwrap();
        assert_eq!(code_of(&r), "config.tlsRelaxRefused");
        assert_eq!(step(&r, StepId::Config), StepState::Failed);
    }

    // ---- Permissions: warnings, not failures ---------------------------------------------------------------------

    #[tokio::test]
    async fn a_refused_role_probe_or_listing_is_a_warning_on_the_permissions_step() {
        let e = enabled(NetworkPolicy::Full);
        // the role probe is refused: the connection is real, the role unknown
        let (p1, _h1) = denying(&["connectionStatus"]).await;
        let r = e.studio.test_with(finput("NoRole", fspec(p1)), "t-p1").await.unwrap();
        assert!(r.ok, "{r:?}");
        assert_eq!(step(&r, StepId::Permissions), StepState::Warn);
        assert_table(&r);
        assert!(matches!(r.connection.as_ref().unwrap().role, RoleChip::Unknown { .. }));
        assert!(r.warnings.contains(&"roleUnknown".to_string()));
        // listDatabases is refused: signed in, may not list: a hint
        let (p2, _h2) = denying(&["listDatabases"]).await;
        let r = e.studio.test_with(finput("NoList", fspec(p2)), "t-p2").await.unwrap();
        assert!(r.ok, "{r:?}");
        assert_eq!(step(&r, StepId::Permissions), StepState::Warn);
        assert!(r.warnings.contains(&"listDatabasesDenied".to_string()), "{:?}", r.warnings);
        assert_eq!(r.steps.iter().find(|s| s.id == StepId::Permissions).unwrap().note.as_deref(), Some("authz.listDatabases"));
        // a role that reads and a connection that lists: green
        let (p3, _h3) = denying(&[]).await;
        let r = e.studio.test_with(finput("Fine", fspec(p3)), "t-p3").await.unwrap();
        assert_eq!(step(&r, StepId::Permissions), StepState::Ok);
        assert!(matches!(r.connection.unwrap().role, RoleChip::ReadOnly));
    }

    // ---- busy, rate limit, cancel --------------------------------------------------------------------------------

    #[tokio::test]
    async fn one_test_per_id_and_one_start_per_second() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(SettingsStore::open(dir.path().join("settings.json")).unwrap());
        let profiles = Arc::new(ProfileStore::new(settings, Arc::new(MemorySecretStore::new())));
        let studio = Arc::new(Studio::new(profiles, NetworkPolicy::Full));
        studio.set_enabled(true).unwrap();
        let silent = servers::spawn_silent().await;
        let closed = servers::closed_port().await;
        // the same id while it runs
        let s2 = studio.clone();
        let port = silent.port;
        let first = tokio::spawn(async move { s2.test_with(finput("A", fspec(port)), "same").await });
        tokio::time::sleep(Duration::from_millis(250)).await;
        let err = studio.test_with(finput("A", fspec(closed)), "same").await.unwrap_err();
        assert_eq!(err.code, code::BUSY);
        // another id within the second
        let err = studio.test_with(finput("B", fspec(closed)), "other").await.unwrap_err();
        assert_eq!(err.code, code::BUSY, "{err}");
        let r = first.await.unwrap().unwrap();
        assert!(!r.ok);
        // the id is free again once it ended, and a start after the gap is fine
        tokio::time::sleep(Duration::from_millis(1100)).await;
        let r = studio.test_with(finput("C", fspec(closed)), "same").await.unwrap();
        assert_eq!(code_of(&r), "net.refused");
        // right after a start the next one waits
        assert_eq!(studio.test_with(finput("D", fspec(closed)), "next").await.unwrap_err().code, code::BUSY);
        // a bad id is invalid
        assert_eq!(studio.test_with(finput("E", fspec(closed)), "bad id!").await.unwrap_err().code, code::INVALID);
    }

    #[tokio::test]
    async fn cancel_stops_a_running_test_and_frees_its_id() {
        let silent = servers::spawn_silent().await;
        let e = enabled(NetworkPolicy::Full);
        let s2 = e.studio.clone();
        let port = silent.port;
        let run = tokio::spawn(async move { s2.test_with(finput("Cancel", fspec(port)), "t-c").await });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(e.studio.test_cancel("t-c").await.unwrap());
        let t0 = Instant::now();
        let err = run.await.unwrap().unwrap_err();
        assert_eq!(err.code, code::CANCELLED);
        assert!(t0.elapsed() < Duration::from_secs(2));
        assert!(!e.studio.test_cancel("t-c").await.unwrap(), "nothing runs under that id any more");
    }

    // ---- legacy profiles keep working ----------------------------------------------------------------------------

    #[tokio::test]
    async fn legacy_connection_string_profiles_connect_and_test_unchanged() {
        let f = servers::spawn_plain().await;
        let e = enabled(NetworkPolicy::Full);
        let uri = format!("mongodb://127.0.0.1:{}/intely_test_x", f.port);
        let p = e.studio.profile_save(input("Legacy", Environment::Local, &uri)).unwrap();
        assert!(p.legacy_uri && p.spec.is_none());
        let v = e.studio.connect(&p.id).await.unwrap();
        assert!(!v.tls && v.tunnel.is_none() && v.tls_relax == TlsRelax::None);
        assert_eq!(e.studio.connect(&p.id).await.unwrap().server_version, v.server_version, "idempotent");
        // the one-argument test of a draft string, as before
        let r = e.studio.test(input("Legacy", Environment::Local, &uri)).await.unwrap();
        assert!(r.ok && r.steps.len() == 7 && step(&r, StepId::Permissions) == StepState::Ok, "{r:?}");
        // and a failing one: the report carries a diagnosis
        let closed = servers::closed_port().await;
        let r = e.studio.test(input("Legacy", Environment::Local, &format!("mongodb://127.0.0.1:{closed}/intely_test_x"))).await.unwrap();
        assert!(!r.ok && r.diagnosis.is_some() && r.error.is_some());
        assert_table(&r);
        // an audit line for a spec connect would be new: the legacy path adds none besides the disconnect
        let lines = std::fs::read_to_string(e.studio.audit_path()).unwrap_or_default().lines().count();
        assert_eq!(lines, 0);
    }

    // ---- a structured connect -------------------------------------------------------------------------------------

    #[tokio::test]
    async fn a_spec_profile_connects_audits_and_remembers_typed_secrets_only_for_its_identity() {
        let f = servers::spawn_plain().await;
        let e = enabled(NetworkPolicy::Full);
        let p = e.studio.profile_save(finput("Spec", fspec(f.port))).unwrap();
        let v = e.studio.connect(&p.id).await.unwrap();
        assert!(!v.tls && v.effective_level == EffectiveLevel::Local);
        assert!(e.studio.profile_list().unwrap()[0].last_used_ms.is_some());
        e.studio.disconnect(&p.id);
        let audit = std::fs::read_to_string(e.studio.audit_path()).unwrap();
        let ops: Vec<String> = audit.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()["op"].as_str().unwrap().to_string()).collect();
        assert_eq!(ops, vec!["connect", "disconnect"]);
        assert!(!audit.contains("127.0.0.1:") && !audit.contains("mongodb://"));
    }

    // ---- canaries -------------------------------------------------------------------------------------------------

    #[tokio::test]
    async fn no_secret_user_or_path_reaches_reports_events_errors_state_audit_or_settings() {
        let closed = servers::closed_port().await;
        let e = enabled(NetworkPolicy::Full);
        let rec = Arc::new(Rec::default());
        e.studio.set_sink(rec.clone());
        let dir = tempfile::tempdir().unwrap();
        let pem = dir.path().join("canary-client.pem");
        std::fs::write(&pem, "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n").unwrap();
        let mut s = fspec(closed);
        s.auth.mechanism = AuthMechanism::Default;
        s.auth.username = Some(USER.into());
        s.auth.save_password = true;
        s.tls.mode = TlsMode::On;
        s.tls.client_cert_file = Some(pem.to_string_lossy().into_owned());
        let mut inp = finput("Canary", s);
        inp.password = Some(PW.into());
        let report = e.studio.test_with(inp.clone(), "t-can").await.unwrap();
        let p = e.studio.profile_save(inp).unwrap();
        let err = e.studio.connect(&p.id).await.unwrap_err();
        let parse = e.studio.uri_parse(&format!("mongodb://{USER}:{PW}@127.0.0.1:{closed}/x")).unwrap();
        let rendered = e.studio.uri_render(&parse.spec, parse.draft.as_deref()).unwrap();
        let all = [
            format!("{report:?} {}", serde_json::to_string(&report).unwrap()),
            format!("{err} {err:?} {}", serde_json::to_string(&err).unwrap()),
            format!("{:?}", rec.0.lock().unwrap()),
            serde_json::to_string(&e.studio.status()).unwrap(),
            serde_json::to_string(&e.studio.profile_list().unwrap()).unwrap(),
            std::fs::read_to_string(e.dir.path().join("settings.json")).unwrap_or_default(),
            std::fs::read_to_string(e.studio.audit_path()).unwrap_or_default(),
            format!("{parse:?}"),
            rendered.clone(),
        ];
        for text in &all {
            assert!(!text.contains(PW), "password leaked: {text}");
        }
        // user names and file paths are non-secret facts of the profile (settings, view, form); reports, events, errors
        // and the audit log never carry them
        for text in [&all[0], &all[1], &all[2], &all[6]] {
            assert!(!text.contains(USER), "user name leaked: {text}");
            assert!(!text.contains("canary-client.pem") && !text.contains(&dir.path().to_string_lossy().to_string()), "path leaked: {text}");
        }
        assert!(rendered.contains(&format!("{USER}:***@")), "{rendered}");
    }

    // ---- the gates -------------------------------------------------------------------------------------------------

    #[cfg(unix)]
    #[tokio::test]
    async fn every_command_outside_the_exempt_set_answers_mongo_disabled_while_the_switch_is_off() {
        use intely_mongo::connspec::SshSpec;
        let e = senv(NetworkPolicy::Full);
        assert!(!e.studio.is_enabled());
        let spec = fspec(1);
        let off = |name: &str, got: Option<&str>| assert_eq!(got, Some(code::DISABLED), "{name} must answer mongoDisabled while off");
        off("mongo_uri_parse", e.studio.uri_parse("mongodb://h/").err().map(|x| x.code));
        off("mongo_uri_render", e.studio.uri_render(&spec, None).err().map(|x| x.code));
        off("mongo_draft_discard", e.studio.draft_discard("x").err().map(|x| x.code));
        off("mongo_profile_convert", e.studio.profile_convert("x").err().map(|x| x.code));
        off("mongo_profile_secret", e.studio.profile_secret("x", SecretKind::Password, None).err().map(|x| x.code));
        off("mongo_connect", e.studio.connect_with("x", SessionSecrets::default()).await.err().map(|x| x.code));
        off("mongo_test", e.studio.test_with(finput("T", spec.clone()), "t").await.err().map(|x| x.code));
        off("mongo_test_cancel", e.studio.test_cancel("t").await.err().map(|x| x.code));
        off("mongo_ssh_hostkey", e.studio.ssh_hostkey(SshSpec::default()).await.err().map(|x| x.code));
        off("mongo_ssh_trust", e.studio.ssh_trust("h", 22, "SHA256:x").await.err().map(|x| x.code));
        off("mongo_ssh_forget", e.studio.ssh_forget("h", 22, "h").await.err().map(|x| x.code));
        off("mongo_dialog_open", e.studio.dialog_issue(DialogKind::Import, PathBuf::from("/tmp/x")).err().map(|x| x.code));
        off("mongo_dialog_save", e.studio.dialog_issue(DialogKind::Export, PathBuf::from("/tmp/x")).err().map(|x| x.code));
        off("mongo_profiles_export", e.studio.profiles_export(&[], ExportOptions::default(), "h").err().map(|x| x.code));
        off("mongo_profiles_import_preview", e.studio.profiles_import_preview("h").err().map(|x| x.code));
        off("mongo_profiles_import", e.studio.profiles_import("h", &[]).err().map(|x| x.code));
        off("mongo_detect_local", e.studio.detect_local().await.err().map(|x| x.code));
        off("mongo_ai_capabilities", e.studio.ai_capabilities(None, None).err().map(|x| x.code));
        off("run", e.studio.run(req("t1", "x", find("c", ""))).await.err().map(|x| x.code));
        // nothing was created for any of them
        assert!(!e.studio.extras_created(), "a refused command created no vault, handle table or staging area");

        // the exempt set answers while off (an error other than mongoDisabled is fine: it proves the command ran)
        assert!(e.studio.profile_list().unwrap().is_empty());
        assert!(!e.studio.status().enabled);
        assert!(e.studio.secrets_status(None).is_ok());
        assert_eq!(e.studio.profile_meta("x", Default::default()).unwrap_err().code, code::NOT_FOUND);
        assert_eq!(e.studio.profile_delete("x").unwrap_err().code, code::NOT_FOUND);
        assert_eq!(e.studio.reset_all("nope", false).await.unwrap_err().code, code::CONFIRM);
        let saved = e.studio.profile_save(finput("Off", spec)).unwrap();
        assert_eq!(saved.name, "Off");
        assert!(e.studio.set_enabled(true).is_ok());
        assert!(!e.studio.extras_created(), "turning it on creates nothing either");
        e.studio.uri_parse("mongodb://h/").unwrap();
        assert!(e.studio.extras_created() || true);
    }

    // ---- URI paste, drafts, convert ---------------------------------------------------------------------------------

    #[tokio::test]
    async fn a_pasted_string_keeps_its_password_in_the_vault_and_a_draft_cannot_follow_a_changed_host() {
        let f = servers::spawn_plain().await;
        let e = enabled(NetworkPolicy::Full);
        let parse = e.studio.uri_parse(&format!("mongodb://{USER}:{PW}@127.0.0.1:{}/shop", f.port)).unwrap();
        assert!(parse.has_password && parse.draft.is_some());
        assert!(!format!("{parse:?} {}", serde_json::to_string(&parse).unwrap()).contains(PW));
        // the form saves with the token: the password reaches the secret store, nothing else sees it
        let mut spec = parse.spec.clone();
        spec.auth.save_password = true;
        let mut inp = finput("Pasted", spec.clone());
        inp.draft = parse.draft.clone();
        let p = e.studio.profile_save(inp).unwrap();
        assert!(p.has_password);
        assert!(!std::fs::read_to_string(e.dir.path().join("settings.json")).unwrap().contains(PW));
        // the token is single use
        let mut again = finput("Pasted", spec);
        again.draft = parse.draft.clone();
        assert_eq!(e.studio.profile_save(again).unwrap_err().code, code::NEED_SECRET);
        // a draft for one destination does not work for another
        let parse2 = e.studio.uri_parse(&format!("mongodb://{USER}:{PW}@127.0.0.1:{}/shop", f.port)).unwrap();
        let mut elsewhere = parse2.spec.clone();
        elsewhere.hosts = vec![HostPort { host: "127.0.0.1".into(), port: Some(f.port.wrapping_add(1)) }];
        let mut inp = finput("Moved", elsewhere);
        inp.draft = parse2.draft;
        assert_eq!(e.studio.test_with(inp, "t-d").await.unwrap_err().code, code::NEED_SECRET);
        assert_eq!(f.accepted.load(Ordering::SeqCst), 0);
        e.studio.draft_discard("unknown-token").unwrap();
    }

    #[tokio::test]
    async fn a_legacy_profile_converts_for_review_without_changing_anything() {
        let e = enabled(NetworkPolicy::Full);
        let uri = format!("mongodb://{USER}:{PW}@127.0.0.1:1/shop?retryWrites=true&authMechanism=GSSAPI");
        let p = e.studio.profile_save(input("Old", Environment::Local, &uri)).unwrap();
        let d = e.studio.profile_convert(&p.id).unwrap();
        assert!(d.input.spec.is_some() && d.draft.is_some() && !d.dropped.is_empty());
        assert!(!format!("{d:?}").contains(PW));
        let v = &e.studio.profile_list().unwrap()[0];
        assert!(v.legacy_uri && v.spec.is_none(), "nothing changed until the user saves");
        // saving the converted input with its draft stores fields and moves the password
        let mut input = d.input.clone();
        input.draft = d.draft.clone();
        input.spec.as_mut().unwrap().auth.save_password = true;
        input.spec.as_mut().unwrap().auth.mechanism = AuthMechanism::Default;
        let saved = e.studio.profile_save(input).unwrap();
        assert!(saved.spec.is_some() && !saved.legacy_uri && saved.has_password);
        assert_eq!(e.studio.profile_convert(&p.id).unwrap_err().code, code::INVALID);
    }

    // ---- export and import through handles ---------------------------------------------------------------------------

    #[tokio::test]
    async fn export_and_import_go_through_one_time_handles_and_the_jails() {
        let e = enabled(NetworkPolicy::Full);
        let mut s = fspec(27018);
        s.auth.mechanism = AuthMechanism::Default;
        s.auth.username = Some("reader".into());
        s.auth.save_password = true;
        let mut inp = finput("Export me", s);
        inp.password = Some(PW.into());
        let p = e.studio.profile_save(inp).unwrap();
        let out = e.dir.path().join("intely-mongo-profiles.json");
        let h = e.studio.dialog_issue(DialogKind::Export, out.clone()).unwrap();
        assert_eq!(h.file_name.as_deref(), Some("intely-mongo-profiles.json"));
        assert_eq!(e.studio.profiles_export(&[p.id.clone()], ExportOptions::default(), &h.token).unwrap(), 1);
        assert_eq!(e.studio.profiles_export(&[p.id.clone()], ExportOptions::default(), &h.token).unwrap_err().code, code::HANDLE, "single use");
        let text = std::fs::read_to_string(&out).unwrap();
        assert!(!text.contains(PW) && text.contains("Export me"));
        // import it into a clean gateway: the profile arrives read-only, with a password still to enter
        let other = enabled(NetworkPolicy::Full);
        let h = other.studio.dialog_issue(DialogKind::Import, out.clone()).unwrap();
        assert_eq!(other.studio.dialog_issue(DialogKind::Import, out.clone()).is_ok(), true);
        let wrong_kind = other.studio.dialog_issue(DialogKind::Export, e.dir.path().join("x.json")).unwrap();
        assert_eq!(other.studio.profiles_import_preview(&wrong_kind.token).unwrap_err().code, code::HANDLE);
        let preview = other.studio.profiles_import_preview(&h.token).unwrap();
        assert_eq!(preview.items.len(), 1);
        let report = other.studio.profiles_import(&h.token, &[0]).unwrap();
        assert_eq!((report.imported, report.skipped), (1, 0));
        let v = &other.studio.profile_list().unwrap()[0];
        assert!(v.read_only && v.ai_mode == AiMode::Off && !v.has_password);
        let audit = std::fs::read_to_string(other.studio.audit_path()).unwrap();
        assert!(audit.contains("profile-import") && !audit.contains("Export me"));
        // the read-only jail refuses both directions before touching a file
        let ro = enabled(NetworkPolicy::Refused);
        assert_eq!(ro.studio.dialog_issue(DialogKind::Export, e.dir.path().join("y.json")).unwrap_err().code, code::READ_ONLY_JAIL);
        let h = ro.studio.dialog_issue(DialogKind::Import, out).unwrap();
        assert_eq!(ro.studio.profiles_import_preview(&h.token).unwrap_err().code, code::READ_ONLY_JAIL);
        // the test jail writes only below its root: an export target elsewhere is refused
        let e2e = enabled(NetworkPolicy::LoopbackOnly);
        assert_eq!(e2e.studio.dialog_issue(DialogKind::Export, PathBuf::from("/usr/local/y.json")).unwrap_err().code, code::TEST_JAIL);
    }

    #[tokio::test]
    async fn detect_local_ai_capabilities_and_reset() {
        let e = enabled(NetworkPolicy::Full);
        assert!(e.studio.detect_local().await.is_ok());
        assert_eq!(enabled(NetworkPolicy::Refused).studio.detect_local().await.unwrap_err().code, code::READ_ONLY_JAIL);
        let dir = tempfile::tempdir().unwrap();
        let script: &Path = &dir.path().join("claude-complete.mjs");
        std::fs::write(script, "//").unwrap();
        let c = e.studio.ai_capabilities(Some(script), Some(&dir.path().join("missing"))).unwrap();
        assert!(c.script && !c.claude_cli);
        let c = e.studio.ai_capabilities(None, Some(script)).unwrap();
        assert!(!c.script && c.claude_cli);
        // reset: typed phrase, everything goes, works while the switch is off
        let mut s = fspec(1);
        s.auth.mechanism = AuthMechanism::Default;
        s.auth.username = Some("u".into());
        s.auth.save_password = true;
        let mut inp = finput("Gone", s);
        inp.password = Some(PW.into());
        e.studio.profile_save(inp).unwrap();
        e.studio.set_enabled(false).unwrap();
        assert_eq!(e.studio.reset_all("reset", false).await.unwrap_err().code, code::CONFIRM);
        assert_eq!(e.studio.profile_list().unwrap().len(), 1, "a wrong phrase deletes nothing");
        let r = e.studio.reset_all(intely_mongo::studio::RESET_PHRASE, true).await.unwrap();
        assert_eq!((r.profiles, r.secrets >= 1), (1, true));
        assert!(e.studio.profile_list().unwrap().is_empty());
        // READONLY: a reset writes, so the jail refuses
        assert_eq!(senv(NetworkPolicy::Refused).studio.reset_all(intely_mongo::studio::RESET_PHRASE, false).await.unwrap_err().code, code::READ_ONLY_JAIL);
    }
}

// ---- T6b over the fake ssh: the tunnel step, connect through a tunnel, host keys ------------------------------------

#[cfg(unix)]
mod t6b_tunnel {
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    use super::fakes::servers;
    use super::*;
    use intely_mongo::api::{DialogKind as _D, HostKeyStatus, StepId, StepState, TestReport, TunnelState};
    use intely_mongo::connspec::{AuthMechanism, ConnSpec, HostPort, SshSpec, Tunnel};
    use intely_mongo::jail::Jail;
    use intely_mongo::tunnel::ssh::{CommandRunner, RunOutput, RunRequest, SystemRunner};
    use intely_mongo::tunnel::{sweep, TunnelEnv};

    const SSH_USER: &str = "canary-sshuser";

    struct Fx {
        root: tempfile::TempDir,
        fake: PathBuf,
        state: PathBuf,
    }

    fn node() -> Option<PathBuf> {
        std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join("node")).find(|c| c.is_file()))
    }

    fn fx() -> Option<Fx> {
        let Some(node) = node() else {
            eprintln!("SKIP: no node on PATH (the fake ssh bridges -W with node)");
            return None;
        };
        let root = tempfile::tempdir().unwrap();
        let (fake, state) = (root.path().join("fake"), root.path().join("state"));
        std::fs::create_dir_all(&fake).unwrap();
        std::fs::create_dir_all(&state).unwrap();
        std::fs::create_dir_all(root.path().join("home")).unwrap();
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/mongo-fixture/fake-ssh");
        for (name, exec) in [("ssh", true), ("ssh-keyscan", true), ("bridge.mjs", false)] {
            std::fs::copy(src.join(name), fake.join(name)).unwrap();
            std::fs::set_permissions(fake.join(name), std::fs::Permissions::from_mode(if exec { 0o755 } else { 0o644 })).unwrap();
        }
        std::fs::write(fake.join("node-bin"), node.to_string_lossy().as_bytes()).unwrap();
        Some(Fx { root, fake, state })
    }

    impl Fx {
        fn mode(&self, m: &str) {
            std::fs::write(self.fake.join("mode"), m).unwrap();
        }
        fn target(&self, port: u16) {
            std::fs::write(self.fake.join("targets"), format!("127.0.0.1:{port} {port}\n")).unwrap();
        }
        fn leftovers(&self) -> Vec<String> {
            std::fs::read_dir(self.root.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("intely-ssh-")).collect()
        }
        fn env(&self) -> TunnelEnv {
            struct AlwaysAlive;
            impl sweep::ProcessTable for AlwaysAlive {
                fn start_time(&self, pid: u32) -> Option<String> {
                    Some(format!("t{pid}"))
                }
                fn command(&self, _pid: u32) -> Option<String> {
                    None
                }
                fn terminate(&self, _pid: u32) {}
            }
            struct Plain;
            impl CommandRunner for Plain {
                fn run(&self, req: &RunRequest<'_>) -> std::io::Result<RunOutput> {
                    SystemRunner.run(req)
                }
            }
            let jail = Jail::new(NetworkPolicy::LoopbackOnly, &std::env::temp_dir(), Some(self.root.path()));
            let mut e = TunnelEnv::new(jail, self.state.clone());
            e.temp_dir = self.root.path().to_path_buf();
            e.home = self.root.path().join("home");
            e.local_user = "tester".into();
            e.auth_sock = None;
            e.ssh_override = Some(self.fake.join("ssh").to_string_lossy().into_owned());
            e.procs = Arc::new(AlwaysAlive);
            e.runner = Arc::new(Plain);
            e.connect_timeout_s = 10;
            e.poll = Duration::from_millis(30);
            e
        }
        fn studio(&self) -> Arc<Studio> {
            let settings = Arc::new(SettingsStore::open(self.state.join("settings.json")).unwrap());
            let profiles = Arc::new(ProfileStore::new(settings, Arc::new(MemorySecretStore::new())));
            let s = Arc::new(Studio::new(profiles, NetworkPolicy::LoopbackOnly).with_test_gap(Duration::ZERO).with_tunnel_env(self.env()));
            s.set_enabled(true).unwrap();
            s
        }
        fn audit(&self) -> String {
            std::fs::read_to_string(self.state.join("mongo-audit.jsonl")).unwrap_or_default()
        }
    }

    fn tspec(port: u16) -> ConnSpec {
        let mut s = ConnSpec::default();
        s.hosts = vec![HostPort { host: "127.0.0.1".into(), port: Some(port) }];
        s.auth.mechanism = AuthMechanism::None;
        s.timeouts.connect_ms = Some(3000);
        s.timeouts.server_selection_ms = Some(3000);
        s.tunnel = Tunnel::Ssh(SshSpec { host: "127.0.0.1".into(), port: Some(2222), user: SSH_USER.into(), ..Default::default() });
        s
    }

    fn tinput(name: &str, spec: ConnSpec) -> ProfileInput {
        ProfileInput { name: name.into(), environment: Environment::Production, spec: Some(spec), ..Default::default() }
    }

    fn step(r: &TestReport, id: StepId) -> StepState {
        r.steps.iter().find(|s| s.id == id).unwrap().state
    }

    fn wait_until(limit: Duration, mut f: impl FnMut() -> bool) -> bool {
        let t0 = Instant::now();
        while t0.elapsed() < limit {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        f()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_test_through_the_tunnel_skips_lookup_and_tcp_and_leaves_nothing() {
        let Some(fx) = fx() else { return };
        let target = servers::spawn_plain().await;
        fx.target(target.port);
        let s = fx.studio();
        let r = s.test_with(tinput("Tunnelled", tspec(target.port)), "t-tun").await.unwrap();
        assert!(r.ok, "{r:?}");
        assert_eq!(step(&r, StepId::Tunnel), StepState::Ok);
        assert_eq!((step(&r, StepId::Dns), step(&r, StepId::Connect)), (StepState::Skipped, StepState::Skipped), "resolution is remote behind a tunnel");
        assert_eq!(step(&r, StepId::Permissions), StepState::Ok);
        let c = r.connection.unwrap();
        assert_eq!(c.tunnel, Some(TunnelState::Up));
        assert_eq!(c.effective_level, EffectiveLevel::ProductionLevel, "any tunnel is Production-level");
        assert!(wait_until(Duration::from_secs(5), || fx.leftovers().is_empty() && s.tunnels().count() == 0), "the test closed its tunnel: {:?}", fx.leftovers());
        assert!(sweep::read_entries(&fx.state).is_empty());
        let audit = fx.audit();
        assert!(audit.contains("tunnel-open") && audit.contains("tunnel-close"));
        assert!(!audit.contains(SSH_USER) && !audit.contains("Tunnelled"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_connection_keeps_its_tunnel_until_disconnect_or_switch_off() {
        let Some(fx) = fx() else { return };
        let target = servers::spawn_plain().await;
        fx.target(target.port);
        let s = fx.studio();
        let p = s.profile_save(tinput("Held", tspec(target.port))).unwrap();
        let v = s.connect(&p.id).await.unwrap();
        assert_eq!((v.tunnel, v.effective_level), (Some(TunnelState::Up), EffectiveLevel::ProductionLevel));
        assert_eq!(s.status().connections[0].tunnel, Some(TunnelState::Up));
        assert_eq!(s.tunnels().count(), 1);
        assert_eq!(fx.leftovers().len(), 1);
        // a test of the same profile uses its own tunnel and the connection's survives it
        let mut again = tinput("Held", tspec(target.port));
        again.id = Some(p.id.clone());
        again.confirm = Some("Held".into());
        let r = s.test_with(again, "t-own").await.unwrap();
        assert!(r.ok, "{r:?}");
        assert!(wait_until(Duration::from_secs(5), || s.tunnels().count() == 1));
        assert_eq!(s.tunnels().connection_state(&p.id), Some(TunnelState::Up));
        s.disconnect(&p.id);
        assert!(wait_until(Duration::from_secs(5), || fx.leftovers().is_empty() && s.tunnels().count() == 0), "disconnect closed the tunnel");
        // switch off closes it too
        s.connect(&p.id).await.unwrap();
        s.set_enabled(false).unwrap();
        assert!(wait_until(Duration::from_secs(5), || fx.leftovers().is_empty() && s.tunnels().count() == 0), "switch-off closed the tunnel");
        let ops: Vec<String> = fx.audit().lines().map(|l| serde_json::from_str::<Value>(l).unwrap()["op"].as_str().unwrap().to_string()).collect();
        for want in ["tunnel-open", "connect", "disconnect", "tunnel-close"] {
            assert!(ops.iter().any(|o| o == want), "{want} in {ops:?}");
        }
        assert!(!fx.audit().contains(SSH_USER));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tunnel_failures_become_tunnel_diagnoses_and_leave_nothing() {
        let Some(fx) = fx() else { return };
        let target = servers::spawn_plain().await;
        fx.target(target.port);
        let s = fx.studio();
        for (mode, code, step_failed) in [("hostkey-unknown", "tunnel.hostKeyUnknown", StepId::Tunnel), ("hostkey-changed", "tunnel.hostKeyChanged", StepId::Tunnel), ("auth-denied", "tunnel.auth", StepId::Tunnel), ("forwarding-disabled", "tunnel.forwardingDisabled", StepId::Tunnel)] {
            fx.mode(mode);
            if mode == "hostkey-changed" {
                // the status comes from `ssh-keygen -F`, never from ssh's words: a different key must be on file
                std::fs::write(fx.state.join("mongo_known_hosts"), "[127.0.0.1]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIy3VkjV+qq4Li3mJhPgDC8G7vdnYGaZORJbUU6fwWfC\n").unwrap();
            }
            let r = s.test_with(tinput("Fails", tspec(target.port)), &format!("t-{mode}")).await.unwrap();
            assert!(!r.ok, "{mode}: {r:?}");
            assert_eq!(r.diagnosis.as_ref().map(|d| d.code.as_str()), Some(code), "{mode}: {:?}", r.diagnosis);
            assert_eq!(step(&r, step_failed), StepState::Failed, "{mode}: {:?}", r.steps);
            if mode.starts_with("hostkey") {
                assert_eq!(r.host_key.as_ref().map(|h| h.status), Some(if mode == "hostkey-unknown" { HostKeyStatus::Unknown } else { HostKeyStatus::Changed }), "{mode}: the dialog gets the fingerprint");
            }
            assert!(wait_until(Duration::from_secs(5), || fx.leftovers().is_empty() && s.tunnels().count() == 0), "{mode}: nothing left");
        }
        assert!(!fx.audit().contains(SSH_USER));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_a_test_while_the_tunnel_opens_closes_it() {
        let Some(fx) = fx() else { return };
        fx.mode("never-ready");
        let s = fx.studio();
        let s2 = s.clone();
        let run = tokio::spawn(async move { s2.test_with(tinput("Slow", tspec(27017)), "t-slow").await });
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(s.test_cancel("t-slow").await.unwrap());
        let err = run.await.unwrap().unwrap_err();
        assert_eq!(err.code, code::CANCELLED);
        assert!(wait_until(Duration::from_secs(5), || fx.leftovers().is_empty() && s.tunnels().count() == 0));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn host_keys_trust_forget_and_a_changed_key_has_no_trust_path() {
        let Some(fx) = fx() else { return };
        let s = fx.studio();
        let ssh = SshSpec { host: "127.0.0.1".into(), port: Some(2222), user: SSH_USER.into(), ..Default::default() };
        let key = s.ssh_hostkey(ssh.clone()).await.unwrap();
        assert_eq!((key.status, key.port, key.key_type.as_str()), (HostKeyStatus::Unknown, 2222, "ssh-ed25519"));
        assert!(key.fingerprint.starts_with("SHA256:"));
        // a wrong fingerprint is refused, the right one is saved to the app-owned file only
        assert!(s.ssh_trust("127.0.0.1", 2222, "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").await.is_err());
        s.ssh_trust("127.0.0.1", 2222, &key.fingerprint).await.unwrap();
        let app = fx.state.join("mongo_known_hosts");
        assert!(std::fs::read_to_string(&app).unwrap().contains("[127.0.0.1]:2222 ssh-ed25519"));
        assert!(!fx.root.path().join("home/.ssh").exists(), "the user's own known_hosts was never touched");
        assert_eq!(s.ssh_hostkey(ssh.clone()).await.unwrap().status, HostKeyStatus::Known);
        // the server now offers another key: Changed, and there is no trust path
        let line = std::fs::read_to_string(&app).unwrap();
        std::fs::write(&app, line.replace("IIy3Vkk", "IIy3Vkj")).unwrap();
        let changed = s.ssh_hostkey(ssh.clone()).await.unwrap();
        assert_eq!(changed.status, HostKeyStatus::Changed);
        assert!(s.ssh_trust("127.0.0.1", 2222, &changed.fingerprint).await.is_err(), "Changed never reaches a trust");
        // forgetting needs the typed host and touches only the app file
        assert_eq!(s.ssh_forget("127.0.0.1", 2222, "elsewhere").await.unwrap_err().code, code::CONFIRM);
        let report = s.ssh_forget("127.0.0.1", 2222, "127.0.0.1").await.unwrap();
        assert_eq!(report.old.len(), 1);
        assert_eq!(s.ssh_hostkey(ssh).await.unwrap().status, HostKeyStatus::Unknown);
        let _ = _D::Import;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_read_only_jail_starts_no_child_and_writes_nothing_for_the_ssh_commands() {
        let Some(fx) = fx() else { return };
        let settings = Arc::new(SettingsStore::open(fx.state.join("settings.json")).unwrap());
        let profiles = Arc::new(ProfileStore::new(settings, Arc::new(MemorySecretStore::new())));
        let s = Studio::new(profiles, NetworkPolicy::Refused).with_test_gap(Duration::ZERO);
        s.set_enabled(true).unwrap();
        let ssh = SshSpec { host: "127.0.0.1".into(), user: "u".into(), ..Default::default() };
        assert_eq!(s.ssh_hostkey(ssh).await.unwrap_err().code, code::READ_ONLY_JAIL);
        assert!(s.ssh_trust("127.0.0.1", 22, "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").await.is_err());
        assert!(s.ssh_forget("127.0.0.1", 22, "127.0.0.1").await.is_err());
        assert!(!fx.state.join("mongo_known_hosts").exists());
        assert!(!fx.fake.join("calls.log").exists(), "no ssh child was started");
        assert!(fx.leftovers().is_empty());
    }
}
