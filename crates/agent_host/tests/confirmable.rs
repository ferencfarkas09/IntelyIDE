//! Confirmable (tier 2) stops in the host: who may answer a card, what an answer grants, where the always-list lives and what undoes it.
//! Against the fake sidecar of `tests/common/fake-sidecar-modes.mjs`: no CLI, no model call, no Tauri.

#![cfg(unix)]
mod common;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use intely_agent_core::api::{AgentStartRequest, AgentSummary, PermissionDecision};
use intely_agent_core::events::types::{EventKind, PermissionOutcome, StopGrantScope};
use intely_agent_core::policy::confirm::{ConfirmKind, ALL_OF_KIND};
use intely_agent_core::policy::decide::{decide, Decision};
use intely_agent_core::policy::intent::{PolicyRequest, ToolIntent};
use intely_agent_core::providers::PermissionMode::{self, Ask, Automatic, Bypass, Edit};
use intely_agent_host::stop_allow::{StopAllow, MAX_ENTRIES};
use intely_agent_host::{AgentHost, AnswerExtra, RepoRef, StartOptions};
use serde_json::{json, Value};

fn fake() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/common/fake-sidecar-modes.mjs")
}

fn wait_until(secs: u64, what: &str, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while !f() {
        assert!(Instant::now() < deadline, "timeout waiting for {what}");
        std::thread::sleep(Duration::from_millis(25));
    }
}

struct Rig {
    dir: tempfile::TempDir,
    repo: RepoRef,
    host: AgentHost,
    sink: Arc<Collector>,
    store: Arc<StopAllow>,
}

impl Rig {
    /// `ui`: a window is open on this computer.
    fn new(ui: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repo = fixture_repo(dir.path());
        std::fs::write(repo.path.join(".env"), "SECRET=1\n").unwrap();
        let data = dir.path().join("data");
        let mut cfg = config(&data, fake());
        cfg.providers = vec!["claude".into(), "mock".into()];
        cfg.claude_bin = Some(PathBuf::from("/bin/echo"));
        let store = Arc::new(StopAllow::open(&data));
        cfg.stop_allow = Some(store.clone());
        cfg.ui_attached = ui.then(|| Arc::new(|| true) as _);
        let (host, sink) = host_with(cfg);
        Self { dir, repo, host, sink, store }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn start(&self, mode: PermissionMode) -> AgentSummary {
        let repos = vec![self.repo.clone()];
        let def = self.host.find_role("mock-plain-reply", &repos).expect("role");
        self.host
            .start_role_with(&def, AgentStartRequest { role: "mock-plain-reply".into(), repo_ids: vec![self.repo.id.clone()], prompt: "go".into(), mode: Some(mode), mcp_servers: None, ..Default::default() }, &repos, StartOptions { bypass_confirmed: true, ..Default::default() })
            .expect("start")
    }

    fn answers(&self, req: &str) -> Vec<Value> {
        std::fs::read_to_string(self.path("fake-log.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|l| l["type"] == "permission/answer" && l["body"]["reqId"] == req)
            .map(|l| l["body"].clone())
            .collect()
    }

    /// A card of a confirmable stop, as the gate emits it: the intent of the tool call and the offer.
    fn card(&self, id: &str, req: &str, intent: Value, confirm: Value) {
        let ev = json!({"kind": "permission.request", "reqId": req, "toolId": format!("tool-{req}"), "intent": intent,
            "options": ["allow_once", "allow_run", "allow_always", "deny"], "confirm": confirm});
        self.host.send(id, &json!({ "events": [ev] }).to_string()).expect("send");
        self.sink.wait(id, "the card", 10, |e| matches!(&e.kind, EventKind::PermissionRequest { req_id, .. } if req_id == req));
    }

    fn env_card(&self, id: &str, req: &str) {
        let env = self.repo.path.join(".env").to_string_lossy().into_owned();
        let intent = json!({"class": "read", "tool": "Read", "paths": [env], "summary": "Read .env"});
        self.card(id, req, intent, json!({"kind": "secretFile", "rule": "read.never-read", "scope": env, "repo": self.repo.path.to_string_lossy()}));
    }

    fn env(&self) -> String {
        self.repo.path.join(".env").to_string_lossy().into_owned()
    }

    fn judged(&self, id: &str, tool_id: &str) -> Decision {
        let ctx = self.host.context(id).unwrap();
        let mut i = ToolIntent::from_claude_tool("Read", &json!({"file_path": self.env()}));
        i.summary = "Read .env".into();
        decide(&ctx, &PolicyRequest { agent_id: id.into(), tool_id: tool_id.into(), provider: "claude".into(), intent: i }).decision
    }
}

fn code<T: std::fmt::Debug>(r: Result<T, intely_core::EngineError>) -> String {
    r.expect_err("refused").code
}

#[test]
fn once_names_the_tool_call_and_the_sidecar_is_told_how_far_the_yes_reaches() {
    for mode in [Ask, Edit, Automatic, Bypass] {
        let r = Rig::new(true);
        let id = r.start(mode).agent_id;
        assert_eq!(r.judged(&id, "tool-p1"), Decision::Deny, "{mode:?}");
        r.env_card(&id, "p1");
        r.host.answer_permission(&id, "p1", PermissionDecision::AllowOnce).expect("allow once");
        let a = &r.answers("p1")[0];
        assert_eq!((a["outcome"].as_str(), a["grant"].as_str()), (Some("allow"), Some("once")), "{mode:?}");
        // the grant lifts the stop for that tool call only
        assert_ne!(r.judged(&id, "tool-p1"), Decision::Deny, "{mode:?}");
        assert_eq!(r.judged(&id, "tool-other"), Decision::Deny, "{mode:?}");
        r.host.shutdown();
    }
}

#[test]
fn for_this_run_covers_every_secret_of_the_kind_and_ends_with_the_run() {
    let r = Rig::new(true);
    let id = r.start(Automatic).agent_id;
    r.env_card(&id, "p1");
    r.host.answer_permission(&id, "p1", PermissionDecision::AllowRun).expect("allow for the run");
    assert_eq!(r.answers("p1")[0]["grant"], "run");
    let ctx = r.host.context(&id).unwrap();
    assert!(ctx.stop_grants.iter().any(|g| g.kind == ConfirmKind::SecretFile && g.scope == ALL_OF_KIND && g.tool_id.is_none()));
    assert_ne!(r.judged(&id, "t-x"), Decision::Deny);
    assert!(r.store.list().is_empty(), "nothing is stored for a run grant");
    // a new run starts without it
    let other = r.start(Automatic).agent_id;
    assert_eq!(r.judged(&other, "t-y"), Decision::Deny, "the grant belonged to the first run");
    r.host.shutdown();
}

#[test]
fn always_needs_the_second_confirmation_for_a_secret_then_is_stored_per_repo_outside_it_and_survives_a_restart() {
    let r = Rig::new(true);
    let id = r.start(Automatic).agent_id;
    r.env_card(&id, "p1");
    assert_eq!(code(r.host.answer_permission(&id, "p1", PermissionDecision::AllowAlways)), "confirmationRequired");
    assert!(r.store.list().is_empty() && r.answers("p1").is_empty(), "nothing happened");
    r.host.answer_permission_with(&id, "p1", PermissionDecision::AllowAlways, AnswerExtra { confirm_always: true, ..Default::default() }).expect("always, confirmed");
    assert_eq!(r.answers("p1")[0]["grant"], "always");
    let entries = r.store.list();
    assert_eq!(entries.len(), 1);
    assert_eq!((entries[0].kind, entries[0].scope.as_str(), entries[0].repo.as_str()), (ConfirmKind::SecretFile, r.env().as_str(), r.repo.path.to_string_lossy().as_ref()));
    // never inside the repository: the file is in the IDE's own data directory
    assert!(r.path("data/stop-allow.json").exists());
    let in_repo: Vec<_> = walk(&r.repo.path).into_iter().filter(|p| p.to_string_lossy().contains("stop-allow")).collect();
    assert!(in_repo.is_empty(), "{in_repo:?}");
    r.host.shutdown();
    // restart: a new host reads the list, and a new run of that repository starts with the entry
    let reopened = StopAllow::open(&r.path("data"));
    assert_eq!(reopened.list(), entries);
    let mut cfg = config(&r.path("data"), fake());
    cfg.providers = vec!["claude".into(), "mock".into()];
    cfg.claude_bin = Some(PathBuf::from("/bin/echo"));
    cfg.stop_allow = Some(Arc::new(reopened));
    let (host2, _sink2) = host_with(cfg);
    let repos = vec![r.repo.clone()];
    let def = host2.find_role("mock-plain-reply", &repos).expect("role");
    let again = host2.start_role_with(&def, AgentStartRequest { role: "mock-plain-reply".into(), repo_ids: vec![r.repo.id.clone()], prompt: "go".into(), mode: Some(Automatic), mcp_servers: None, ..Default::default() }, &repos, StartOptions::default()).unwrap();
    let ctx = host2.context(&again.agent_id).unwrap();
    assert!(ctx.stop_grants.iter().any(|g| g.scope == r.env() && g.tool_id.is_none()), "{:?}", ctx.stop_grants);
    host2.shutdown();
}

fn walk(p: &std::path::Path) -> Vec<PathBuf> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                if path.file_name().is_some_and(|n| n == ".git") {
                    continue;
                }
                out.extend(walk(&path));
            } else {
                out.push(path);
            }
        }
    }
    out
}

#[test]
fn an_always_entry_does_not_apply_to_another_repository() {
    let r = Rig::new(true);
    // an entry that belongs to some other repository
    r.store.add("/somewhere/else", ConfirmKind::SecretFile, &r.env(), "read.never-read", 1).unwrap();
    let id = r.start(Automatic).agent_id;
    assert!(r.host.context(&id).unwrap().stop_grants.is_empty());
    assert_eq!(r.judged(&id, "t"), Decision::Deny);
    r.host.shutdown();
}

#[test]
fn a_revoke_removes_the_entry_from_the_file_and_from_the_open_runs_at_once() {
    let r = Rig::new(true);
    let id = r.start(Automatic).agent_id;
    r.env_card(&id, "p1");
    r.host.answer_permission_with(&id, "p1", PermissionDecision::AllowAlways, AnswerExtra { confirm_always: true, ..Default::default() }).unwrap();
    assert_ne!(r.judged(&id, "t"), Decision::Deny);
    let entry = r.store.list().remove(0);
    assert!(r.host.stop_allow_revoke(&entry.id).unwrap());
    assert_eq!(r.judged(&id, "t"), Decision::Deny, "the open run lost it too");
    assert!(StopAllow::open(&r.path("data")).list().is_empty());
    assert!(!r.host.stop_allow_revoke(&entry.id).unwrap(), "a second revoke finds nothing");
    r.host.shutdown();
}

#[test]
fn the_list_holds_a_hundred_entries_and_the_hundred_and_first_is_refused() {
    let r = Rig::new(true);
    for i in 0..MAX_ENTRIES {
        r.store.add("/other", ConfirmKind::SecretFile, &format!("/other/{i}.key"), "read.never-read", i as u64).unwrap();
    }
    let id = r.start(Automatic).agent_id;
    r.env_card(&id, "p1");
    assert_eq!(code(r.host.answer_permission_with(&id, "p1", PermissionDecision::AllowAlways, AnswerExtra { confirm_always: true, ..Default::default() })), "allowListFull");
    assert!(r.answers("p1").is_empty(), "the card stays pending");
    // the person can still answer it another way
    r.host.answer_permission(&id, "p1", PermissionDecision::AllowOnce).expect("once still works");
    r.host.shutdown();
}

#[test]
fn a_phone_cannot_lift_a_stop_it_may_refuse_it() {
    let r = Rig::new(true);
    let id = r.start(Automatic).agent_id;
    r.env_card(&id, "p1");
    for d in [PermissionDecision::AllowOnce, PermissionDecision::AllowRun, PermissionDecision::AllowAlways] {
        assert_eq!(code(r.host.answer_permission_remote(&id, "p1", d)), "answerOnComputer");
    }
    assert!(r.answers("p1").is_empty());
    assert_eq!(r.judged(&id, "tool-p1"), Decision::Deny);
    r.host.answer_permission_remote(&id, "p1", PermissionDecision::Deny).expect("the phone may refuse it");
    assert_eq!(r.answers("p1")[0]["outcome"], "deny");
    r.host.shutdown();
}

#[test]
fn with_no_window_open_the_card_is_refused_at_once_with_the_reason() {
    let r = Rig::new(false);
    let id = r.start(Automatic).agent_id;
    r.env_card(&id, "p1");
    wait_until(10, "the automatic refusal", || !r.answers("p1").is_empty());
    let a = &r.answers("p1")[0];
    assert_eq!(a["outcome"], "deny");
    assert!(a["message"].as_str().unwrap().contains("No window"), "{a}");
    r.host.shutdown();
}

#[test]
fn a_forged_card_grants_nothing_the_host_derives_the_thing_itself() {
    let r = Rig::new(true);
    let id = r.start(Automatic).agent_id;
    // a card that claims a secret for an intent that touches none
    let intent = json!({"class": "read", "tool": "Read", "paths": [r.repo.path.join("a.txt").to_string_lossy()], "summary": "Read a.txt"});
    r.card(&id, "p1", intent, json!({"kind": "secretFile", "rule": "read.never-read", "scope": "/etc/passwd", "repo": "/etc"}));
    // (the rules allow that read anyway: the click is a plain yes and nothing is granted)
    r.host.answer_permission(&id, "p1", PermissionDecision::AllowRun).expect("a yes to something the rules allow");
    assert!(r.host.context(&id).unwrap().stop_grants.is_empty(), "a forged card grants nothing");
    r.card(&id, "p1b", json!({"class": "read", "tool": "Read", "paths": [r.repo.path.join("a.txt").to_string_lossy()], "summary": "Read a.txt"}), json!({"kind": "secretFile", "rule": "read.never-read", "scope": "/etc/passwd", "repo": "/etc"}));
    assert_eq!(code(r.host.answer_permission_with(&id, "p1b", PermissionDecision::AllowAlways, AnswerExtra { confirm_always: true, ..Default::default() })), "rulesMoved", "always is never taken from the card");
    assert!(r.store.list().is_empty());
    // a card whose scope names another file: the grant is for what the rules say, not what the card says
    let env = r.env();
    let intent = json!({"class": "read", "tool": "Read", "paths": [env], "summary": "Read .env"});
    r.card(&id, "p2", intent, json!({"kind": "secretFile", "rule": "read.never-read", "scope": "/home/x/.ssh/id_rsa", "repo": "/home/x"}));
    r.host.answer_permission(&id, "p2", PermissionDecision::AllowOnce).expect("once");
    let grants = r.host.context(&id).unwrap().stop_grants;
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0].scope, r.env());
    r.host.shutdown();
}

#[test]
fn a_deny_with_a_note_reaches_the_agent_and_the_log_shows_who_decided() {
    let r = Rig::new(true);
    let id = r.start(Automatic).agent_id;
    r.env_card(&id, "p1");
    r.host.answer_permission_with(&id, "p1", PermissionDecision::Deny, AnswerExtra { feedback: Some("use the example file".into()), ..Default::default() }).expect("deny");
    let a = &r.answers("p1")[0];
    assert_eq!((a["outcome"].as_str(), a["message"].as_str()), (Some("deny"), Some("use the example file")));
    assert!(r.host.context(&id).unwrap().stop_grants.is_empty());
    let _ = (PermissionOutcome::Deny, StopGrantScope::Once);
    r.host.shutdown();
}

#[test]
fn the_always_list_file_is_a_tier_one_path_for_the_agent() {
    use intely_agent_core::policy::decide::PolicyContext;
    let r = Rig::new(true);
    let id = r.start(Automatic).agent_id;
    let ctx: PolicyContext = r.host.context(&id).unwrap();
    assert_eq!(ctx.state_dir.as_deref(), Some(r.path("data").as_path()));
    let file = r.path("data/stop-allow.json").to_string_lossy().into_owned();
    for (tool, input) in [
        ("Write", json!({"file_path": file, "content": "{}"})),
        ("Edit", json!({"file_path": file, "old_string": "a", "new_string": "b"})),
        ("Read", json!({"file_path": file})),
        ("Bash", json!({"command": format!("echo '{{}}' > {file}")})),
        ("Bash", json!({"command": format!("cp /dev/null {file}")})),
        ("Bash", json!({"command": format!("cat {file}")})),
    ] {
        let d = decide(&ctx, &PolicyRequest { agent_id: id.clone(), tool_id: "t".into(), provider: "claude".into(), intent: ToolIntent::from_claude_tool(tool, &input) });
        assert_eq!(d.decision, Decision::Deny, "{tool}: {d:?}");
        assert!(d.confirm.is_none(), "{tool} must carry no offer: {d:?}");
    }
    r.host.shutdown();
}

#[test]
fn a_second_card_for_the_same_stop_is_a_plain_yes_once_the_first_was_allowed_for_the_run() {
    let r = Rig::new(true);
    let id = r.start(Automatic).agent_id;
    r.env_card(&id, "p1");
    r.env_card(&id, "p2");
    r.host.answer_permission(&id, "p1", PermissionDecision::AllowRun).unwrap();
    r.host.answer_permission(&id, "p2", PermissionDecision::AllowOnce).expect("nothing left to grant, the click is still a yes");
    assert_eq!(r.answers("p2")[0]["outcome"], "allow");
    // ...but "always" is never derived from a card: it needs the host's own verdict
    r.env_card(&id, "p3");
    assert_eq!(code(r.host.answer_permission_with(&id, "p3", PermissionDecision::AllowAlways, AnswerExtra { confirm_always: true, ..Default::default() })), "rulesMoved");
    r.host.shutdown();
}
