//! The AI half of the gateway against the throwaway loopback fixture, with a scripted model (no real model call): AI off
//! means nothing is prepared, the payload preview is the request the model receives, a draft is never run by the
//! backend, unsafe replies are rejected and a model that cannot be reached is a provider error. Without
//! `INTELY_MONGO_TEST_URI` the server-backed tests skip with a message.
#![cfg(feature = "mongo")]

use std::sync::{Arc, Mutex};

use intely_mongo::ai::ports::{ModelError, ModelPort, ModelReply, Usage};
use intely_mongo::ai::prompt::GenRequest;
use intely_mongo::api::{AiAsk, AiEditor, AiMode, Environment, ProfileInput, RunRequest};
use intely_mongo::error::code;
use intely_mongo::jail::NetworkPolicy;
use intely_mongo::profile::ProfileStore;
use intely_mongo::studio::{Studio, TierNames};
use intely_mongo::types::ReadCommand;
use intely_settings::{MemorySecretStore, SettingsStore};
use serde_json::{json, Value};

const DB: &str = "intely_test_happy";
const NAMES: fn() -> TierNames = || ["scripted".into(), "scripted".into(), "scripted".into()];

struct Scripted {
    replies: Mutex<Vec<Result<Value, String>>>,
    seen: Mutex<Vec<GenRequest>>,
}

impl Scripted {
    fn new(replies: Vec<Result<Value, String>>) -> Self {
        Self { replies: Mutex::new(replies), seen: Mutex::new(vec![]) }
    }
    fn calls(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
}

impl ModelPort for Scripted {
    async fn complete(&self, req: &GenRequest) -> Result<ModelReply, ModelError> {
        self.seen.lock().unwrap().push(req.clone());
        let mut r = self.replies.lock().unwrap();
        let next = if r.len() > 1 { r.remove(0) } else { r.first().cloned().unwrap_or_else(|| Err("script exhausted".into())) };
        next.map(|reply| ModelReply { reply, usage: Usage::default() }).map_err(ModelError)
    }
}

fn find_reply(filter: &str) -> Value {
    json!({"mode": "find", "collection": "orders", "filter": filter, "projection": null, "sort": "{\"createdAt\": -1}", "skip": null, "limit": 10, "assumptions": [], "explanation": "latest orders", "confidence": "high", "needsClarification": null})
}

fn fixture_uri() -> Option<String> {
    let u = std::env::var("INTELY_MONGO_TEST_URI").ok();
    if u.is_none() {
        eprintln!("SKIP: INTELY_MONGO_TEST_URI not set (run scripts/mongo-fixture/up.sh)");
    }
    u.filter(|u| u.contains("127.0.0.1") && u.contains("/intely_test_"))
}

struct Env {
    _dir: tempfile::TempDir,
    studio: Arc<Studio>,
}

/// Enabled studio, one connected loopback profile; `ai` decides the profile's AI mode, `tenant` its tenant lock.
async fn connected(uri: &str, ai: bool, tenant: Option<&str>) -> (Env, String) {
    let dir = tempfile::tempdir().unwrap();
    let settings = Arc::new(SettingsStore::open(dir.path().join("settings.json")).unwrap());
    let profiles = Arc::new(ProfileStore::new(settings, Arc::new(MemorySecretStore::new())));
    let studio = Arc::new(Studio::new(profiles, NetworkPolicy::Full).with_now(1_790_000_000_000));
    studio.set_enabled(true).unwrap();
    let input = ProfileInput {
        name: "Fixture".into(),
        environment: Environment::Local,
        uri: Some(uri.into()),
        ai_mode: ai.then_some(AiMode::SchemaOnly),
        tenant_lock: tenant.map(str::to_string),
        confirm: Some("Fixture".into()),
        max_time_ms: Some(60_000),
        ..Default::default()
    };
    let p = studio.profile_save(input).unwrap();
    studio.connect(&p.id).await.unwrap();
    (Env { _dir: dir, studio }, p.id)
}

fn ask(conn: &str, question: &str) -> AiAsk {
    AiAsk { tab: "mgaitest".into(), connection: conn.into(), db: DB.into(), collection: "orders".into(), question: question.into(), ..Default::default() }
}

#[tokio::test]
async fn ai_is_off_by_default_and_prepares_nothing() {
    let Some(uri) = fixture_uri() else { return };
    let (e, id) = connected(&uri, false, None).await;
    let model = Scripted::new(vec![Ok(find_reply("{}"))]);
    assert_eq!(e.studio.ai_payload(&ask(&id, "latest orders")).await.unwrap_err().code, code::AI_OFF);
    assert_eq!(e.studio.ai_generate(&model, &NAMES(), &ask(&id, "latest orders")).await.unwrap_err().code, code::AI_OFF);
    assert_eq!(model.calls(), 0, "P0 never reaches the model");
    // switching the studio off also removes the ability to ask
    e.studio.set_enabled(false).unwrap();
    assert_eq!(e.studio.ai_payload(&ask(&id, "latest orders")).await.unwrap_err().code, code::DISABLED);
}

#[tokio::test]
async fn the_preview_is_the_request_the_model_receives_and_a_draft_is_not_run() {
    let Some(uri) = fixture_uri() else { return };
    let (e, id) = connected(&uri, true, None).await;
    let q = "a legutóbbi 10 rendelés";
    let payload = e.studio.ai_payload(&ask(&id, q)).await.unwrap();
    assert_eq!(payload.mode, "schemaOnly");
    assert_eq!(payload.bytes as usize, payload.text.len());
    assert!(!payload.text.contains("mongodb://"), "no URI in the payload");

    let model = Scripted::new(vec![Ok(find_reply("{\"status\": \"paid\"}"))]);
    let r = e.studio.ai_generate(&model, &NAMES(), &ask(&id, q)).await.unwrap();
    assert_eq!(r.status, "ready", "{:?}", r.problems);
    assert_eq!(r.repairs, 0);
    assert_eq!(model.seen.lock().unwrap()[0].wire_text(), payload.text, "what the dialog shows is what is sent");
    let d = r.draft.expect("draft");
    assert_eq!(d.limit, Some(10));
    assert!(d.filter.contains("paid") && d.sort.contains("createdAt"));
    assert!(d.plan.is_some());
    assert_eq!(e.studio.cursor_count(), 0, "generating a draft opens no result cursor: nothing ran");

    // the user's own click: the draft goes through the ordinary read-only run
    let cmd = ReadCommand::Find { db: DB.into(), collection: "orders".into(), filter: d.filter.clone(), projection: None, sort: Some(d.sort.clone()), skip: None, limit: d.limit.map(i64::from) };
    let w = e.studio.run(RunRequest { tab: "mgaitest".into(), connection: id.clone(), command: cmd, page_size: None }).await.unwrap();
    assert_eq!(w.docs.len(), 10);
}

#[tokio::test]
async fn unsafe_replies_are_rejected_and_the_loop_is_bounded() {
    let Some(uri) = fixture_uri() else { return };
    let (e, id) = connected(&uri, true, None).await;
    let model = Scripted::new(vec![Ok(find_reply("{\"$where\": \"sleep(1000)\"}"))]);
    let r = e.studio.ai_generate(&model, &NAMES(), &ask(&id, "delete all cancelled orders")).await.unwrap();
    assert_eq!(r.status, "failed");
    assert!(r.draft.is_none());
    assert!(model.calls() <= 3, "at most the first call and two repairs, got {}", model.calls());
    let mut other = find_reply("{}");
    other["collection"] = json!("system.users");
    let model = Scripted::new(vec![Ok(other)]);
    let r = e.studio.ai_generate(&model, &NAMES(), &ask(&id, "show me the users")).await.unwrap();
    assert_eq!(r.status, "failed", "an unknown collection never becomes a draft");
}

#[tokio::test]
async fn an_unreachable_model_is_a_provider_error() {
    let Some(uri) = fixture_uri() else { return };
    let (e, id) = connected(&uri, true, None).await;
    let model = Scripted::new(vec![Err("no claude".into())]);
    let err = e.studio.ai_generate(&model, &NAMES(), &ask(&id, "latest orders")).await.unwrap_err();
    assert_eq!(err.code, code::NO_PROVIDER);
}

#[tokio::test]
async fn the_tenant_lock_applies_to_a_draft() {
    let Some(uri) = fixture_uri() else { return };
    let (e, id) = connected(&uri, true, Some("restaurant")).await;
    let model = Scripted::new(vec![Ok(find_reply("{\"status\": \"paid\"}"))]);
    let r = e.studio.ai_generate(&model, &NAMES(), &ask(&id, "paid orders")).await.unwrap();
    assert_eq!(r.status, "failed", "a draft that does not constrain the tenant field is rejected: {:?}", r.problems);
}

#[tokio::test]
async fn explain_is_local_and_rejects_what_cannot_run() {
    let Some(uri) = fixture_uri() else { return };
    let (e, id) = connected(&uri, true, None).await;
    let mut a = ask(&id, "paid orders");
    a.editor = Some(AiEditor { filter: "{status: 'paid'}".into(), projection: String::new(), sort: "{createdAt: -1}".into(), limit: Some(10), returned: None });
    a.plan = Some(vec!["IXSCAN status_1".into()]);
    let x = e.studio.ai_explain(&a).await.unwrap();
    assert!(x.text.contains("paid") && x.text.contains("IXSCAN"), "{}", x.text);
    a.editor = Some(AiEditor { filter: "{$where: 'x'}".into(), ..Default::default() });
    assert_eq!(e.studio.ai_explain(&a).await.unwrap_err().code, code::REJECTED);
}
