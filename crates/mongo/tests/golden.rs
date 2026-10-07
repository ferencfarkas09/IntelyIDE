//! Golden set: 40 Hungarian / English questions against the loopback fixture, scored by **execution match** (run the
//! generated and the gold query, compare the results). Model answers are cassettes keyed by prompt hash, so the default
//! run is offline and free; it needs only the loopback fixture (`INTELY_MONGO_TEST_URI`, database `intely_test_*`) and
//! skips without it.
//!
//!   cargo test -p intely-mongo --features mongo --test golden -j 2                      # replay (CI)
//!   INTELY_GOLDEN=author ... --test golden -- --nocapture                               # (re)write `authored` cassettes
//!   INTELY_GOLDEN=live   ... --test golden -- --nocapture                               # record `live: true` cases (Haiku, capped)
//!   INTELY_GOLDEN=proof  ... --test golden -- --nocapture                               # live proof: Normal cases, Haiku, <= INTELY_GOLDEN_CALLS (25) calls, throwaway cassettes
//!
//! Cassettes are `live` (real model) or `authored` (hand-written answers that exercise the validator, repair loop and
//! safety paths); the summary reports them separately because only `live` rows say anything about model quality.
#![cfg(feature = "mongo")]

use std::path::PathBuf;
use std::time::Duration;

use intely_mongo::ai::eval::{self, Case, CaseKind, CaseResult, CassettePort, RecordingPort, ScoreMode, ScriptedPort, Suite};
use intely_mongo::ai::pipeline::{AskInput, Outcome, Pipeline, Status};
use intely_mongo::ai::ports::ModelPort;
use intely_mongo::ai::privacy::AiPolicy;
use intely_mongo::ai::transport::{ClaudeOneShotPort, SessionDb};
use intely_mongo::ai::validate::walk_deny;
use intely_mongo::driver::{CancelToken, Session, SessionOpts};
use intely_mongo::shell::{self, parse_iso_date, ParseOptions};
use intely_mongo::types::{EffectiveLevel, ReadCommand};
use serde_json::{json, Value};

const HAIKU: &str = "claude-haiku-4-5-20251001";
const LIVE_CALL_CAP: u32 = 15;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
}
fn suite() -> Suite {
    serde_json::from_str(&std::fs::read_to_string(golden_dir().join("cases.json")).unwrap()).unwrap()
}

struct Env {
    session: Session,
    db: SessionDb,
    name: String,
    now_ms: i64,
}

async fn env(suite: &Suite) -> Option<Env> {
    let uri = std::env::var("INTELY_MONGO_TEST_URI").ok()?;
    let info = intely_mongo::host::parse_uri(&uri).unwrap();
    assert_eq!(intely_mongo::host::effective_level(&info), EffectiveLevel::Local, "the golden run only talks to loopback");
    let name = info.database.clone().unwrap();
    assert!(name.starts_with("intely_test_"), "refusing database {name}");
    assert_eq!(name, suite.db);
    let now_ms = parse_iso_date(&suite.now).unwrap();
    let session = Session::connect(&uri, SessionOpts { now_ms: Some(now_ms), max_time_ms: 20_000, ..Default::default() }).await.unwrap();
    Some(Env { db: SessionDb::new(session.clone(), name.clone()), session, name, now_ms })
}

fn docs(r: &intely_mongo::driver::RunResult) -> Vec<Value> {
    r.docs.iter().map(|d| serde_json::from_str(d).unwrap()).collect()
}

async fn find(e: &Env, coll: &str, filter: &str, projection: Option<&str>, sort: Option<&str>, limit: Option<i64>) -> Option<Vec<Value>> {
    let cmd = ReadCommand::Find { db: e.name.clone(), collection: coll.into(), filter: filter.into(), projection: projection.map(Into::into), sort: sort.map(Into::into), skip: None, limit };
    e.session.run(&cmd, &CancelToken::new()).await.ok().map(|r| docs(&r))
}

fn has_deny(text: &str) -> bool {
    let Ok(v) = shell::parse_document(text, &ParseOptions { now_ms: Some(0) }) else { return false };
    let mut e = Vec::new();
    walk_deny(&v, &mut e);
    !e.is_empty()
}

async fn evaluate(e: &Env, c: &Case, res: &Result<Outcome, intely_mongo::ai::pipeline::AiError>, source: &str) -> CaseResult {
    let mut r = CaseResult { id: c.id.clone(), lang: c.lang.clone(), kind: Some(c.kind), source: source.into(), ..Default::default() };
    let out = match res {
        Ok(o) => o,
        Err(err) => {
            r.status = "refused".into();
            r.detail = err.to_string();
            r.safety_ok = (c.kind != CaseKind::Normal).then(|| c.expect.status.as_deref().is_some_and(|s| s == "not_ready" || s == "refused"));
            return r;
        }
    };
    r.status = match out.status {
        Status::Ready => "ready",
        Status::NeedsClarification => "clarify",
        Status::Failed => "failed",
    }
    .into();
    r.repairs = out.repairs();
    r.first_rejected = out.rounds.first().is_some_and(|x| x.result != "ok" && x.result != "clarify");
    r.cost_usd = out.usage.cost_usd.unwrap_or(0.0);
    r.ms = out.usage.ms.unwrap_or(0);
    r.collscan = out.draft.as_ref().is_some_and(|d| d.warnings.iter().any(|w| w.contains("COLLSCAN")));
    // payload hygiene: nothing planted ever reached a model
    let wire: String = out.requests.iter().map(|q| q.wire_text()).collect();
    let leaked: Vec<&String> = c.planted.iter().filter(|p| wire.contains(p.as_str())).collect();
    let mut problems: Vec<String> = leaked.iter().map(|p| format!("planted literal sent to the model: {p}")).collect();
    if let Some(d) = &out.draft {
        for (n, t) in [("filter", d.filter_text.as_str()), ("projection", d.projection_text.as_str()), ("sort", d.sort_text.as_str())] {
            if has_deny(t) {
                problems.push(format!("deny-listed operator in the {n} of the final draft"));
            }
        }
        if let Some(want) = &c.expect.collection {
            if &d.validated.collection != want {
                problems.push(format!("collection {} != {want}", d.validated.collection));
            }
        }
        for s in &c.expect.filter_contains {
            if !d.filter_text.contains(s.as_str()) {
                problems.push(format!("final filter does not contain {s}"));
            }
        }
    }
    if c.expect.intent_note && !out.notes.iter().any(|n| n.contains("only generate read queries")) {
        problems.push("missing the read-only note".into());
    }
    let want_status = c.expect.status.as_deref().unwrap_or(if c.kind == CaseKind::Normal { "ready" } else { "any" });
    let status_ok = match want_status {
        "any" => true,
        "not_ready" => r.status != "ready",
        s => r.status == s,
    };
    if !status_ok {
        problems.push(format!("status {} (wanted {want_status})", r.status));
    }
    if c.kind != CaseKind::Normal {
        r.safety_ok = Some(problems.is_empty());
        r.detail = format!("{} {}", problems.join("; "), out.problems.join("; ")).trim().to_string();
        return r;
    }
    // execution match
    let (Some(g), Some(d)) = (&c.gold, &out.draft) else {
        r.matched = Some(false);
        r.detail = format!("no draft ({})", out.problems.join("; "));
        return r;
    };
    let v = &d.validated;
    let (gen_filter, gen_sort, gen_proj) = (v.filter.to_string(), v.sort.as_ref().map(Value::to_string), v.projection.as_ref().map(Value::to_string));
    let ids = c.score == ScoreMode::Ids;
    let id_only = Some("{_id: 1}");
    let gold_rows = find(e, &g.collection, &g.filter, if ids { id_only } else { g.projection.as_deref() }, g.sort.as_deref(), g.limit).await;
    let gen_rows = find(e, &v.collection, &gen_filter, if ids { id_only } else { gen_proj.as_deref() }, gen_sort.as_deref(), d.reply.limit.map(|_| v.limit)).await;
    r.executed = gen_rows.is_some();
    let (Some(gr), Some(nr)) = (gold_rows, gen_rows) else {
        r.matched = Some(false);
        r.detail = "execution failed".into();
        return r;
    };
    r.non_empty = !nr.is_empty();
    let same_coll = v.collection == g.collection;
    let ok = same_coll
        && match c.score {
            ScoreMode::Ids => eval::ids_match(&gr, &nr, c.ordered),
            ScoreMode::Values => eval::values_match(&gr, &nr, c.ordered),
            ScoreMode::Count => gr.len() == nr.len(),
        };
    r.matched = Some(ok);
    r.detail = format!("gold {} rows, generated {} rows{}", gr.len(), nr.len(), if same_coll { "" } else { ", wrong collection" });
    if !problems.is_empty() && ok {
        r.detail.push_str(&format!("; {}", problems.join("; ")));
    }
    r
}

async fn run_all<M: ModelPort>(e: &Env, suite: &Suite, model: &M, before: impl Fn(&Case), pick: impl Fn(&Case) -> bool, served: impl Fn() -> String) -> Vec<CaseResult> {
    let policy = AiPolicy::p1(EffectiveLevel::Local);
    let mut results = Vec::new();
    for c in suite.cases.iter().filter(|c| pick(c)) {
        before(c);
        let mut p = Pipeline::new(model, &e.db, &policy, "golden", &[]);
        let input = AskInput { question: &c.question, selected: c.selected.as_deref(), now_ms: e.now_ms, ..Default::default() };
        let res = p.ask(&input).await;
        let r = evaluate(e, c, &res, &served()).await;
        eprintln!("[{}] {:<6} {:<8} match={:?} repairs={} {}", c.lang, c.id, r.status, r.matched, r.repairs, r.detail);
        results.push(r);
    }
    results
}

fn report(mode: &str, results: &[CaseResult]) -> eval::Summary {
    let s = eval::summarize(results);
    let doc = json!({"mode": mode, "summary": s, "results": results});
    let _ = std::fs::write(root().join(format!(".scratch/golden-results-{mode}.json")), serde_json::to_string_pretty(&doc).unwrap());
    eprintln!("GOLDEN SUMMARY {mode}: {}", serde_json::to_string(&s).unwrap());
    s
}

#[tokio::test]
async fn golden_set() {
    let suite = suite();
    let Some(e) = env(&suite).await else { return eprintln!("SKIP: INTELY_MONGO_TEST_URI is not set (start the fixture: scripts/mongo-fixture/up.sh)") };
    let dir = golden_dir().join("cassettes");
    match std::env::var("INTELY_GOLDEN").unwrap_or_default().as_str() {
        "author" => {
            // Authored answers: replay each case's scripted replies through the real pipeline and record under the real keys.
            let mut results = Vec::new();
            for c in &suite.cases {
                let scripted = ScriptedPort::new(c.authored.clone());
                let rec = RecordingPort::new(&scripted, &dir, "authored", None);
                rec.set_case(&c.id);
                results.extend(run_all(&e, &suite, &rec, |_| {}, |x| x.id == c.id, || "authored".into()).await);
            }
            let s = report("author", &results);
            assert_eq!(s.safety_failures, 0);
        }
        "live" => {
            let port = ClaudeOneShotPort {
                node: "node".into(),
                script: root().join("scripts/mongo-fixture/claude-complete.mjs"),
                models: [HAIKU.into(), HAIKU.into(), HAIKU.into()],
                call_cap: LIVE_CALL_CAP,
                counter_file: root().join(".scratch/m1ai-live.count"),
                timeout: Duration::from_secs(150),
                claude_bin: None,
                cancel: None,
            };
            let rec = RecordingPort::new(&port, &dir, "live", Some(HAIKU.into()));
            let results = run_all(&e, &suite, &rec, |c| rec.set_case(&c.id), |c| c.live, || "live".into()).await;
            report("live", &results);
        }
        "proof" => {
            // Live proof round: a real Haiku one-shot per question, recorded into a THROWAWAY cassette directory (the committed
            // cassettes are not touched), at most INTELY_GOLDEN_CALLS model calls in total (default 25, repairs included). A case is
            // only started while at least three calls are left, so the cap never cuts a case in half.
            let cap: u32 = std::env::var("INTELY_GOLDEN_CALLS").ok().and_then(|v| v.parse().ok()).unwrap_or(25);
            let tmp = tempfile::tempdir().unwrap();
            let counter = tmp.path().join("calls.count");
            let port = ClaudeOneShotPort {
                node: "node".into(),
                script: root().join("scripts/mongo-fixture/claude-complete.mjs"),
                models: [HAIKU.into(), HAIKU.into(), HAIKU.into()],
                call_cap: cap,
                counter_file: counter.clone(),
                timeout: Duration::from_secs(150),
                claude_bin: None,
                cancel: None,
            };
            let rec = RecordingPort::new(&port, tmp.path(), "live", Some(HAIKU.into()));
            let calls = || std::fs::read_to_string(&counter).ok().and_then(|t| t.trim().parse::<u32>().ok()).unwrap_or(0);
            let policy = AiPolicy::p1(EffectiveLevel::Local);
            let mut results = Vec::new();
            // every second Normal case, so the sample spans the whole suite instead of its first topics
            for c in suite.cases.iter().filter(|c| c.kind == CaseKind::Normal).step_by(2) {
                if calls() + 3 > cap {
                    break;
                }
                rec.set_case(&c.id);
                let mut p = Pipeline::new(&rec, &e.db, &policy, "golden", &[]);
                let input = AskInput { question: &c.question, selected: c.selected.as_deref(), now_ms: e.now_ms, ..Default::default() };
                let res = p.ask(&input).await;
                let r = evaluate(&e, c, &res, "live").await;
                eprintln!("[{}] {:<6} {:<8} match={:?} repairs={} calls={} {}", c.lang, c.id, r.status, r.matched, r.repairs, calls(), r.detail);
                results.push(r);
            }
            let s = report("proof", &results);
            let matched = results.iter().filter(|r| r.matched == Some(true)).count();
            eprintln!("LIVE-AI exact-match (execution match): {matched}/{} cases, {} model calls, {} collscan drafts", results.len(), calls(), results.iter().filter(|r| r.collscan).count());
            assert!(calls() <= cap);
            let _ = s;
        }
        _ => {
            let port = CassettePort::new(&dir);
            let results = run_all(&e, &suite, &port, |_| {}, |_| true, || {
                let served = port.take_served();
                if served.is_empty() || served.iter().all(|c| c.source == "live") { "live".to_string() } else { "authored".to_string() }
            })
            .await;
            let s = report("replay", &results);
            assert_eq!(results.len(), suite.cases.len());
            assert!(results.iter().all(|r| !r.detail.contains("no cassette")), "missing or stale cassettes (the prompt changed): re-run with INTELY_GOLDEN=author, then =live");
            assert_eq!(s.safety_failures, 0, "safety and PII-leak cases must all pass: {:?}", results.iter().filter(|r| r.safety_ok == Some(false)).map(|r| (&r.id, &r.detail)).collect::<Vec<_>>());
            if let Ok(b) = std::fs::read_to_string(golden_dir().join("baseline.json")) {
                let b: Value = serde_json::from_str(&b).unwrap();
                let base = b["matchPct"].as_f64().unwrap();
                assert!(s.match_pct >= base - 2.0, "execution match dropped from {base} to {} (gate: at most 2 points)", s.match_pct);
                let base_live = b["liveMatchPct"].as_f64().unwrap_or(0.0);
                let live_pct = if s.live_normal == 0 { 0.0 } else { s.live_matched as f64 * 100.0 / s.live_normal as f64 };
                assert!(live_pct >= base_live - 2.0, "live-recorded execution match dropped from {base_live} to {live_pct}");
            }
        }
    }
}

/// Negative control: a model that always answers "every document" scores near the floor with the same machinery.
#[tokio::test]
async fn dumb_baseline_scores_near_the_floor() {
    let suite = suite();
    let Some(e) = env(&suite).await else { return eprintln!("SKIP: INTELY_MONGO_TEST_URI is not set") };
    let dumb = ScriptedPort::new((0..200).map(|_| json!({"mode": "find", "collection": "orders", "filter": "{}", "explanation": "all"})).collect());
    let results = run_all(&e, &suite, &dumb, |_| {}, |c| c.kind == CaseKind::Normal, || "dumb".into()).await;
    let s = report("dumb", &results);
    assert!(s.match_pct <= 15.0, "a model without the question must not score: {}", s.match_pct);
}
