mod common;

use std::fs;

use common::*;
use intely_agent_core::events::types::*;
use intely_runindex::{extract, Index, Query};
use serde_json::json;

fn q(text: &str) -> Query {
    Query { text: text.into(), ..Query::default() }
}

fn corpus(dir: &std::path::Path) -> Index {
    let runs = dir.join("runs");
    finished("run-a", "Fix the delivery fee rounding bug in checkout").write(&runs, Some(meta("developer", &["backend"], 1_000)));
    let mut b = Log::new("run-b");
    b.prompt("Review the admin login form for accessibility problems")
        .tool("t1", "Grep", ToolKind::Search, json!({ "path": "src/pages/Login.jsx" }), ToolStatus::Ok, Some("hit"))
        .reply("The login form lacks labels on two inputs.")
        .end(StopReason::EndTurn);
    b.write(&runs, Some(meta("reviewer", &["admin"], 5_000)));
    let mut c = Log::new("run-c");
    c.prompt("Migrate the mobile app to the new auth flow").tool("t1", "Bash", ToolKind::Exec, json!({ "command": "npm test" }), ToolStatus::Error, Some("1 failed")).end(StopReason::Error);
    c.write(&runs, Some(meta("developer", &["shop-mobile"], 9_000)));
    let mut idx = Index::new();
    idx.refresh(&runs);
    idx
}

#[test]
fn extraction_folds_status_files_tools_and_cost() {
    let log = finished("r", "Do the thing");
    let doc = extract("r", &log.events, None);
    assert_eq!(doc.status, "done");
    assert_eq!(doc.files, vec!["src/orders/total.js"]);
    assert_eq!(doc.tools, vec!["Read", "Edit"]);
    assert_eq!(doc.cost_usd, Some(0.0123));
    assert_eq!(doc.title, "Do the thing");

    let mut no_usage = Log::new("n");
    no_usage.prompt("x").reply("y");
    let doc = extract("n", &no_usage.events, None);
    assert_eq!(doc.status, "running");
    assert_eq!(doc.cost_usd, None, "a missing usage is never a zero");
}

#[test]
fn statuses_failed_and_cancelled() {
    let mut a = Log::new("a");
    a.prompt("x").end(StopReason::Cancelled);
    assert_eq!(extract("a", &a.events, None).status, "cancelled");
    let mut b = Log::new("b");
    b.prompt("x").end(StopReason::MaxTurns);
    assert_eq!(extract("b", &b.events, None).status, "failed");
    let mut c = Log::new("c");
    c.prompt("x").push(EventKind::Error { class: ErrorClass::Provider, message: "boom".into(), retryable: false });
    assert_eq!(extract("c", &c.events, None).status, "failed");
}

#[test]
fn terms_prefixes_and_phrases() {
    let dir = tempfile::tempdir().unwrap();
    let idx = corpus(dir.path());
    assert_eq!(idx.len(), 3);
    let ids = |text: &str| idx.search(&q(text)).hits.iter().map(|h| h.run_id.clone()).collect::<Vec<_>>();
    assert_eq!(ids("delivery fee"), vec!["run-a"]);
    assert_eq!(ids("deliv"), vec!["run-a"], "a prefix matches");
    assert_eq!(ids("login labels"), vec!["run-b"], "words from the prompt and the reply of one run");
    assert_eq!(ids("login nothing"), Vec::<String>::new(), "all words must match");
    assert_eq!(ids("\"fee rounding\""), vec!["run-a"]);
    assert_eq!(ids("\"rounding fee\""), Vec::<String>::new(), "a phrase keeps its word order");
    assert_eq!(ids("Login.jsx"), vec!["run-b"], "file paths are searchable");
    assert_eq!(ids("grep"), vec!["run-b"], "tool names are searchable");
    assert_eq!(ids("reviewer"), vec!["run-b"], "the role is searchable");
    assert_eq!(ids("").len(), 3, "no text lists everything, newest first");
    assert_eq!(ids("")[0], "run-c");
}

#[test]
fn filters_by_repo_role_status_model_and_date() {
    let dir = tempfile::tempdir().unwrap();
    let idx = corpus(dir.path());
    let run = |f: &dyn Fn(&mut Query)| {
        let mut query = Query::default();
        f(&mut query);
        idx.search(&query).hits.iter().map(|h| h.run_id.clone()).collect::<Vec<_>>()
    };
    assert_eq!(run(&|q| q.repo = Some("admin".into())), vec!["run-b"]);
    let mut devs = run(&|q| q.role = Some("Developer".into()));
    devs.sort();
    assert_eq!(devs, vec!["run-a", "run-c"]);
    assert_eq!(run(&|q| q.status = Some("failed".into())), vec!["run-c"]);
    assert_eq!(run(&|q| q.model = Some("haiku".into())).len(), 3);
    assert_eq!(run(&|q| q.model = Some("opus".into())).len(), 0);
    assert_eq!(run(&|q| (q.from_ms, q.to_ms) = (Some(2_000), Some(6_000))), vec!["run-b"]);
    let mut combined = q("auth");
    combined.role = Some("developer".into());
    combined.status = Some("failed".into());
    assert_eq!(idx.search(&combined).hits.len(), 1);
}

#[test]
fn snippets_highlight_the_match() {
    let dir = tempfile::tempdir().unwrap();
    let idx = corpus(dir.path());
    let hit = &idx.search(&q("rounding")).hits[0];
    let prompt = hit.snippets.iter().find(|s| s.field == "prompt").expect("a prompt snippet");
    let chars: Vec<char> = prompt.text.chars().collect();
    let [a, b] = prompt.marks[0];
    assert_eq!(chars[a as usize..b as usize].iter().collect::<String>().to_lowercase(), "rounding");
    assert!(hit.snippets.iter().any(|s| s.field == "reply"), "the reply matches too: {:?}", hit.snippets);
    // A long text is windowed around the match, with ellipses, and the marks stay inside it.
    let mut long = Log::new("long");
    long.prompt(&format!("{} needle {}", "lorem ".repeat(60), "ipsum ".repeat(60)));
    let doc = extract("long", &long.events, None);
    let mut idx = Index::new();
    idx.insert_doc(doc);
    let s = &idx.search(&q("needle")).hits[0].snippets[0];
    assert!(s.text.starts_with('…') && s.text.ends_with('…'));
    assert!(s.text.chars().count() < 200);
    let chars: Vec<char> = s.text.chars().collect();
    assert_eq!(chars[s.marks[0][0] as usize..s.marks[0][1] as usize].iter().collect::<String>(), "needle");
}

#[test]
fn secrets_stay_redacted_in_the_index_snippets_and_the_saved_file() {
    let dir = tempfile::tempdir().unwrap();
    let runs = dir.path().join("runs");
    let mut l = Log::new("leaky");
    l.prompt(&format!("deploy with token {TOKEN} please"))
        .tool("t1", "Bash", ToolKind::Exec, json!({ "command": "env" }), ToolStatus::Ok, Some(&format!("GITHUB_TOKEN={TOKEN}")))
        .reply(&format!("I used {TOKEN} to deploy."));
    l.write(&runs, None);
    let mut idx = Index::new();
    idx.refresh(&runs);
    assert!(idx.search(&q(TOKEN)).hits.is_empty(), "the token itself is not findable");
    assert!(idx.search(&q("abcdefghijklmnopqrstuvwxyz0123456789")).hits.is_empty());
    let hit = &idx.search(&q("deploy")).hits[0];
    for s in &hit.snippets {
        assert!(!s.text.contains("ghp_"), "snippet leaks: {}", s.text);
    }
    let stored = &idx.doc("leaky").unwrap().prompts[0];
    assert!(stored.contains("***") || stored.contains("[redacted"), "a marker stands where the token was: {stored}");
    let state = dir.path().join("runindex.json");
    idx.save(&state).unwrap();
    assert!(!fs::read_to_string(&state).unwrap().contains("ghp_"), "the saved index holds no secret");
}

#[test]
fn refresh_is_incremental_and_the_index_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let runs = dir.path().join("runs");
    let mut idx = corpus(dir.path());
    let again = idx.refresh(&runs);
    assert_eq!((again.added, again.updated, again.removed, again.unchanged), (0, 0, 0, 3));

    // A run grows: only that one is read again.
    let mut grown = finished("run-a", "Fix the delivery fee rounding bug in checkout");
    grown.prompt("Now also handle the coupon code");
    grown.write(&runs, Some(meta("developer", &["backend"], 1_000)));
    let s = idx.refresh(&runs);
    assert_eq!((s.added, s.updated, s.removed, s.unchanged), (0, 1, 0, 2));
    assert_eq!(idx.search(&q("coupon")).hits.len(), 1);

    // Persist, reload, and the search still answers; a deleted log drops out.
    let state = dir.path().join("state/runindex.json");
    idx.save(&state).unwrap();
    let mut loaded = Index::load(&state);
    assert_eq!(loaded.len(), 3);
    assert_eq!(loaded.search(&q("coupon")).hits.len(), 1);
    let s = loaded.refresh(&runs);
    assert_eq!(s.unchanged, 3, "a loaded index does not re-read unchanged logs");
    fs::remove_file(runs.join("run-b.jsonl")).unwrap();
    assert_eq!(loaded.refresh(&runs).removed, 1);
    assert!(loaded.search(&q("login")).hits.is_empty());
}

#[test]
fn a_torn_or_foreign_log_line_is_skipped_and_a_bad_state_file_gives_an_empty_index() {
    let dir = tempfile::tempdir().unwrap();
    let runs = dir.path().join("runs");
    let log = finished("ok", "Hello world task");
    let mut text = log.jsonl();
    text.insert_str(0, "not json at all\n{\"foo\":1}\n");
    text.push_str("{\"agentId\":\"ok\",\"seq\":99,\"ts\":1,\"prov");
    fs::create_dir_all(&runs).unwrap();
    fs::write(runs.join("ok.jsonl"), text).unwrap();
    let mut idx = Index::new();
    idx.refresh(&runs);
    assert_eq!(idx.search(&q("hello")).hits.len(), 1);
    let bad = dir.path().join("bad.json");
    fs::write(&bad, "{ nope").unwrap();
    assert!(Index::load(&bad).is_empty());
    assert!(Index::load(&dir.path().join("missing.json")).is_empty());
}

#[test]
fn facets_count_repos_roles_models_and_statuses() {
    let dir = tempfile::tempdir().unwrap();
    let f = corpus(dir.path()).facets();
    assert_eq!(f.roles.iter().find(|c| c.value == "developer").unwrap().count, 2);
    assert!(f.repos.iter().any(|c| c.value == "admin"));
    assert!(f.statuses.iter().any(|c| c.value == "failed" && c.count == 1));
}
