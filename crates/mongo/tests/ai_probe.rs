//! M0 (h)/(i): NL -> find probe. `emit_prompts` builds schema digests from the fixture and writes the prompts;
//! `scripts/mongo-fixture/claude-oneshot.mjs` records Haiku replies as cassettes; `replay_cassettes` validates them with
//! the Rust validator, runs them on the fixture and scores them against gold queries. All `#[ignore]`: run explicitly.
#![cfg(feature = "mongo")]

use std::path::PathBuf;

use intely_mongo::ai::{self, GenReply};
use intely_mongo::digest::{self, CompactOpts};
use intely_mongo::driver::{CancelToken, Session, SessionOpts};
use intely_mongo::shell::parse_iso_date;
use intely_mongo::types::ReadCommand;
use serde_json::{json, Value};

const DB: &str = "intely_test_happy";
const COLLS: [&str; 4] = ["orders", "customers", "restaurants", "products"];

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn prompts_json() -> Value {
    serde_json::from_str(&std::fs::read_to_string(root().join("scripts/mongo-fixture/probe-prompts.json")).unwrap()).unwrap()
}
fn out_dir() -> PathBuf {
    std::env::var("INTELY_M0_DIR").map(PathBuf::from).unwrap_or_else(|_| root().join(".scratch"))
}
async fn session(now_ms: i64) -> Option<Session> {
    let uri = std::env::var("INTELY_MONGO_TEST_URI").ok()?;
    let info = intely_mongo::host::parse_uri(&uri).unwrap();
    assert!(info.database.as_deref().is_some_and(|d| d.starts_with("intely_test_")));
    Some(Session::connect(&uri, SessionOpts { now_ms: Some(now_ms), max_time_ms: 20_000, ..Default::default() }).await.unwrap())
}
fn find_cmd(coll: &str, filter: &str, projection: Option<&str>, sort: Option<&str>, limit: Option<i64>) -> ReadCommand {
    ReadCommand::Find { db: DB.into(), collection: coll.into(), filter: filter.into(), projection: projection.map(Into::into), sort: sort.map(Into::into), skip: None, limit }
}
fn docs(r: &intely_mongo::driver::RunResult) -> Vec<Value> {
    r.docs.iter().map(|d| serde_json::from_str(d).unwrap()).collect()
}

async fn digests(s: &Session) -> Vec<digest::Digest> {
    let t = CancelToken::new();
    let all: Vec<String> = docs(&s.run(&ReadCommand::ListCollections { db: DB.into() }, &t).await.unwrap()).iter().map(|d| d["name"].as_str().unwrap().to_string()).collect();
    let mut out = Vec::new();
    for c in COLLS {
        assert!(all.iter().any(|x| x == c));
        let mut sample = docs(&s.run(&ReadCommand::Aggregate { db: DB.into(), collection: c.into(), pipeline: "[{$sample: {size: 200}}]".into() }, &t).await.unwrap());
        sample.extend(docs(&s.run(&find_cmd(c, "", None, Some("{_id: -1}"), Some(100)), &t).await.unwrap()));
        let est: u64 = docs(&s.run(&ReadCommand::Count { db: DB.into(), collection: c.into(), filter: "".into() }, &t).await.unwrap())[0]["count"].as_u64().unwrap();
        let ix: Vec<String> = docs(&s.run(&ReadCommand::ListIndexes { db: DB.into(), collection: c.into() }, &t).await.unwrap()).iter().map(|i| digest::plain(&i["key"]).to_string()).collect();
        out.push(digest::build(c, &sample, Some(est), ix));
    }
    out
}

#[tokio::test]
#[ignore]
async fn emit_prompts() {
    let p = prompts_json();
    let now = p["now"].as_str().unwrap();
    let Some(s) = session(parse_iso_date(now).unwrap()).await else { return eprintln!("SKIP: no INTELY_MONGO_TEST_URI") };
    let ds = digests(&s).await;
    let names: Vec<String> = ["orders", "customers", "restaurants", "products", "users", "legacy"].iter().map(|s| s.to_string()).collect();
    let mut items = Vec::new();
    for (mode, enums) in [("p1", false), ("p1enum", true)] {
        let text: String = ds.iter().map(|d| d.compact(&names, &CompactOpts { include_enum_values: enums, ..CompactOpts::default() })).collect::<Vec<_>>().join("\n");
        eprintln!("digest chars ({mode}): {}", text.len());
        if mode == "p1" {
            std::fs::write(out_dir().join("m0-digest-p1.txt"), &text).unwrap();
        }
        for it in p["items"].as_array().unwrap() {
            let (q, _kept) = ai::mask_question(it["question"].as_str().unwrap());
            items.push(json!({"id": it["id"], "mode": mode, "user": ai::build_user_prompt(&q, &text, now)}));
        }
    }
    let doc = json!({"system": ai::SYSTEM_PROMPT, "schema": ai::reply_schema(), "items": items});
    std::fs::write(out_dir().join("m0-prompts.json"), serde_json::to_string_pretty(&doc).unwrap()).unwrap();
}

#[tokio::test]
#[ignore]
async fn replay_cassettes() {
    let p = prompts_json();
    let now_ms = parse_iso_date(p["now"].as_str().unwrap()).unwrap();
    let Some(s) = session(now_ms).await else { return eprintln!("SKIP: no INTELY_MONGO_TEST_URI") };
    let ds = digests(&s).await;
    let known: Vec<String> = ["orders", "customers", "restaurants", "products", "users", "legacy"].iter().map(|s| s.to_string()).collect();
    let t = CancelToken::new();
    let mut summary = Vec::new();
    for mode in ["p1", "p1enum"] {
        let mut rows = Vec::new();
        for it in p["items"].as_array().unwrap() {
            let id = it["id"].as_str().unwrap();
            let file = out_dir().join("m0-cassettes").join(mode).join(format!("{id}.json"));
            let Ok(txt) = std::fs::read_to_string(&file) else { continue };
            let cas: Value = serde_json::from_str(&txt).unwrap();
            let mut row = json!({"id": id, "mode": mode, "lang": it["lang"], "ms": cas["ms"], "costUsd": cas["costUsd"], "turns": cas["turns"], "tools": cas["init"]["tools"].as_array().map(Vec::len)});
            let reply: Result<GenReply, _> = serde_json::from_value(cas["structured"].clone());
            let Ok(reply) = reply else {
                row["outcome"] = json!("no-structured-output");
                rows.push(row);
                continue;
            };
            row["reply"] = json!({"collection": reply.collection, "filter": reply.filter, "sort": reply.sort, "limit": reply.limit, "assumptions": reply.assumptions, "needsClarification": reply.needs_clarification});
            let dg = ds.iter().find(|d| d.collection == reply.collection);
            let v = match ai::validate_find(&reply, &known, dg, now_ms) {
                Ok(v) => v,
                Err(errs) => {
                    row["outcome"] = json!("validator-rejected");
                    row["errors"] = json!(errs);
                    rows.push(row);
                    continue;
                }
            };
            row["warnings"] = json!(v.warnings);
            let gold = &it["gold"];
            let gcoll = gold["collection"].as_str().unwrap();
            let gfilter = gold["filter"].as_str().unwrap();
            let gen_filter = v.filter.to_string();
            let sort = v.sort.as_ref().map(|x| x.to_string());
            // explain gate on the generated query
            let ex = s.run(&ReadCommand::Explain { inner: Box::new(find_cmd(&v.collection, &gen_filter, None, sort.as_deref(), Some(v.limit))), execution_stats: false }, &t).await;
            row["collscan"] = json!(ex.ok().and_then(|r| r.plan).map(|p| p.collscan));
            let (matched, detail) = if v.collection != gcoll {
                (false, format!("collection {} != {}", v.collection, gcoll))
            } else if gold.get("limit").is_some() {
                let g = docs(&s.run(&find_cmd(gcoll, gfilter, Some("{_id: 1}"), gold["sort"].as_str(), gold["limit"].as_i64()), &t).await.unwrap());
                let m = docs(&s.run(&find_cmd(&v.collection, &gen_filter, Some("{_id: 1}"), sort.as_deref(), Some(v.limit)), &t).await.unwrap());
                (g == m, format!("ordered ids: gold {} vs generated {}", g.len(), m.len()))
            } else {
                let cnt = |c: &str, f: &str| {
                    let s = s.clone();
                    let t = t.clone();
                    let (c, f) = (c.to_string(), f.to_string());
                    async move { docs(&s.run(&ReadCommand::Count { db: DB.into(), collection: c, filter: f }, &t).await.unwrap())[0]["count"].as_u64().unwrap() }
                };
                let (gc, mc) = (cnt(gcoll, gfilter).await, cnt(&v.collection, &gen_filter).await);
                let mut ok = gc == mc;
                if ok && gc <= 1000 {
                    let g = docs(&s.run(&find_cmd(gcoll, gfilter, Some("{_id: 1}"), None, None), &t).await.unwrap());
                    let m = docs(&s.run(&find_cmd(&v.collection, &gen_filter, Some("{_id: 1}"), None, None), &t).await.unwrap());
                    let key = |x: &Vec<Value>| { let mut k: Vec<String> = x.iter().map(|d| d["_id"].to_string()).collect(); k.sort(); k };
                    ok = key(&g) == key(&m);
                }
                row["goldCount"] = json!(gc);
                row["genCount"] = json!(mc);
                (ok, format!("count gold {gc} vs generated {mc}"))
            };
            row["outcome"] = json!(if matched { "match" } else { "mismatch" });
            row["detail"] = json!(detail);
            rows.push(row);
        }
        let n = rows.len();
        let m = rows.iter().filter(|r| r["outcome"] == "match").count();
        let rej = rows.iter().filter(|r| r["outcome"] == "validator-rejected").count();
        let cost: f64 = rows.iter().filter_map(|r| r["costUsd"].as_f64()).sum();
        let ms: Vec<u64> = rows.iter().filter_map(|r| r["ms"].as_u64()).collect();
        let median = {
            let mut x = ms.clone();
            x.sort();
            x.get(x.len() / 2).copied()
        };
        summary.push(json!({"mode": mode, "rows": n, "match": m, "validatorRejected": rej, "costUsd": cost, "msMedian": median}));
        std::fs::write(out_dir().join(format!("m0-results-{mode}.json")), serde_json::to_string_pretty(&rows).unwrap()).unwrap();
        for r in &rows {
            eprintln!("[{mode}] {} {} {} | {}", r["id"], r["outcome"], r["detail"].as_str().unwrap_or(""), r["reply"]["filter"].as_str().unwrap_or(""));
        }
    }
    eprintln!("M0 PROBE SUMMARY {}", serde_json::to_string(&summary).unwrap());
}
