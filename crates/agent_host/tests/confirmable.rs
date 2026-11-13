//! Confirmable (tier 2) stops in the host: who may answer a card, what an answer grants and what undoes it.
//! Against the fake sidecar of `tests/common/fake-sidecar-modes.mjs`: no CLI, no model call, no Tauri.

#![cfg(unix)]
mod common;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use intely_agent_core::api::{AgentStartRequest, AgentSummary, PermissionDecision};
use intely_agent_core::events::types::{EventKind, PermissionOutcome};
use intely_agent_core::policy::confirm::{ConfirmKind, ALL_OF_KIND};
use intely_agent_core::policy::decide::{decide, Decision};
use intely_agent_core::policy::intent::{PolicyRequest, ToolIntent};
use intely_agent_core::providers::PermissionMode::{self, Ask, Automatic, Bypass, Edit};
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
        cfg.ui_attached = ui.then(|| Arc::new(|| true) as _);
        let (host, sink) = host_with(cfg);
        Self { dir, repo, host, sink }
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
            "options": ["allow_once", "allow_run", "deny"], "confirm": confirm});
        self.host.send(id, &json!({ "events": [ev] }).to_string()).expect("send");
        self.sink.wait(id, "the card", 10, |e| matches!(&e.kind, EventKind::PermissionRequest { req_id, .. } if req_id == req));
    }

    fn env_card(&self, id: &str, req: &str) {
        let env = self.repo.path.join(".env").to_string_lossy().into_owned();
        let intent = json!({"class": "read", "tool": "Read", "paths": [env], "summary": "Read .env"});
        self.card(id, req, intent, json!({"kind": "secretFile", "rule": "read.never-read", "scope": env, "repo": self.repo.path.to_string_lossy()}));
    }

    /// A click in the IDE's main window on this computer.
    fn click(&self, id: &str, req: &str, d: PermissionDecision) -> Result<(), intely_core::EngineError> {
        self.host.answer_permission_on_computer(id, req, d, false)
    }

    /// The same, after the second confirmation of a run-wide yes for secret files.
    fn click_broad(&self, id: &str, req: &str, d: PermissionDecision) -> Result<(), intely_core::EngineError> {
        self.host.answer_permission_on_computer(id, req, d, true)
    }

    fn kill_sidecar(&self) {
        let pid = self.host.sidecar_pid().expect("sidecar");
        // SAFETY: SIGKILL to the sidecar this test spawned.
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        wait_until(10, "the sidecar to be gone", || self.host.sidecar_pid().is_none());
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
        r.click(&id, "p1", PermissionDecision::AllowOnce).expect("allow once");
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
    r.click_broad(&id, "p1", PermissionDecision::AllowRun).expect("allow for the run");
    assert_eq!(r.answers("p1")[0]["grant"], "run");
    let ctx = r.host.context(&id).unwrap();
    assert!(ctx.stop_grants.iter().any(|g| g.kind == ConfirmKind::SecretFile && g.scope == ALL_OF_KIND && g.tool_id.is_none()));
    assert_ne!(r.judged(&id, "t-x"), Decision::Deny);
    // a new run starts without it
    let other = r.start(Automatic).agent_id;
    assert_eq!(r.judged(&other, "t-y"), Decision::Deny, "the grant belonged to the first run");
    r.host.shutdown();
}

#[test]
fn only_an_answer_that_says_it_is_a_click_on_the_computer_can_lift_a_stop() {
    let r = Rig::new(true);
    let id = r.start(Automatic).agent_id;
    r.env_card(&id, "p1");
    // the plain entry point (a phone, a plugin, any other caller) has no such flag: it cannot allow, whatever it asks for
    for d in [PermissionDecision::AllowOnce, PermissionDecision::AllowRun] {
        assert_eq!(code(r.host.answer_permission(&id, "p1", d)), "answerOnComputer");
        assert_eq!(code(r.host.answer_permission_with(&id, "p1", d, AnswerExtra { confirm_broad: true, ..Default::default() })), "answerOnComputer");
    }
    assert!(r.answers("p1").is_empty());
    assert_eq!(r.judged(&id, "tool-p1"), Decision::Deny);
    assert!(AnswerExtra::default().on_computer == false, "no flag, no grant");
    r.host.answer_permission(&id, "p1", PermissionDecision::Deny).expect("anyone may refuse it");
    assert_eq!(r.answers("p1")[0]["outcome"], "deny");
    r.host.shutdown();
}

#[test]
fn for_this_run_on_a_secret_needs_the_second_confirmation_once_and_a_cli_prompt_do_not() {
    let r = Rig::new(true);
    let id = r.start(Automatic).agent_id;
    r.env_card(&id, "p1");
    assert_eq!(code(r.click(&id, "p1", PermissionDecision::AllowRun)), "confirmationRequired");
    assert!(r.answers("p1").is_empty() && r.host.context(&id).unwrap().stop_grants.is_empty(), "nothing happened");
    // once is exact and needs no second step
    r.click(&id, "p1", PermissionDecision::AllowOnce).expect("once");
    assert_eq!(r.answers("p1")[0]["grant"], "once");
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
    r.click_broad(&id, "p1", PermissionDecision::AllowRun).expect("a yes to something the rules allow");
    assert!(r.host.context(&id).unwrap().stop_grants.is_empty(), "a forged card grants nothing");
    r.card(&id, "p1b", json!({"class": "read", "tool": "Read", "paths": [r.repo.path.join("a.txt").to_string_lossy()], "summary": "Read a.txt"}), json!({"kind": "secretFile", "rule": "read.never-read", "scope": "/etc/passwd", "repo": "/etc"}));
    // a card whose scope names another file than the rules offer: refused, nothing is granted (the thing the person saw must be the thing granted)
    let env = r.env();
    let intent = json!({"class": "read", "tool": "Read", "paths": [env], "summary": "Read .env"});
    r.card(&id, "p2", intent, json!({"kind": "secretFile", "rule": "read.never-read", "scope": "/home/x/.ssh/id_rsa", "repo": "/home/x"}));
    assert_eq!(code(r.click(&id, "p2", PermissionDecision::AllowOnce)), "rulesMoved");
    assert!(r.host.context(&id).unwrap().stop_grants.is_empty());
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
    // the run log records the answer: a refusal by the person, no grant
    let resolved = r.sink.wait(&id, "the resolution", 10, |e| matches!(&e.kind, EventKind::PermissionResolved { req_id, .. } if req_id == "p1"));
    match resolved.kind {
        EventKind::PermissionResolved { outcome, by, grant, .. } => assert_eq!((outcome, by, grant), (PermissionOutcome::Deny, intely_agent_core::events::types::DecidedBy::User, None)),
        other => panic!("{other:?}"),
    }
    r.host.shutdown();
}

#[test]
fn the_ide_data_directory_is_a_tier_one_place_for_the_agent() {
    use intely_agent_core::policy::decide::PolicyContext;
    let r = Rig::new(true);
    let id = r.start(Automatic).agent_id;
    let ctx: PolicyContext = r.host.context(&id).unwrap();
    assert_eq!(ctx.state_dir.as_deref(), Some(r.path("data").as_path()));
    let file = r.path("data/settings.json").to_string_lossy().into_owned();
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
    r.click_broad(&id, "p1", PermissionDecision::AllowRun).unwrap();
    r.click(&id, "p2", PermissionDecision::AllowOnce).expect("nothing left to grant, the click is still a yes");
    assert_eq!(r.answers("p2")[0]["outcome"], "allow");
    r.host.shutdown();
}

#[test]
fn a_card_for_one_file_never_grants_another_that_took_its_place() {
    let r = Rig::new(true);
    let id = r.start(Automatic).agent_id;
    std::fs::write(r.repo.path.join("prod.pem"), "KEY").unwrap();
    r.env_card(&id, "p1");
    r.env_card(&id, "p2");
    // the person looked at `.env`; before the click it became a link to another secret of the project
    std::fs::remove_file(r.repo.path.join(".env")).unwrap();
    std::os::unix::fs::symlink(r.repo.path.join("prod.pem"), r.repo.path.join(".env")).unwrap();
    for (req, d) in [("p1", PermissionDecision::AllowOnce), ("p2", PermissionDecision::AllowRun)] {
        assert_eq!(code(r.click_broad(&id, req, d)), "rulesMoved", "{req}");
    }
    assert!(r.host.context(&id).unwrap().stop_grants.is_empty());
    r.host.shutdown();
}

#[test]
fn for_this_run_on_a_cli_prompt_is_the_exact_reason_only() {
    let r = Rig::new(true);
    let id = r.start(Automatic).agent_id;
    let reason = "Contains brace with quote character (expansion obfuscation)";
    let intent = json!({"class": "exec", "tool": "Bash", "rawCommand": "echo {'a':1}", "summary": "echo"});
    r.card(&id, "c1", intent, json!({"kind": "cliPrompt", "rule": "cli.prompt-denied", "scope": reason, "repo": r.repo.path.to_string_lossy()}));
    r.click(&id, "c1", PermissionDecision::AllowRun).expect("run");
    let g = r.host.context(&id).unwrap().stop_grants;
    assert_eq!(g.len(), 1);
    assert_eq!((g[0].kind, g[0].scope.as_str(), g[0].tool_id.is_none()), (ConfirmKind::CliPrompt, reason, true), "not a wildcard");
    r.host.shutdown();
}

#[test]
fn a_shell_card_is_never_honoured_the_host_derives_no_offer_for_a_command() {
    // a card (forged, or from an older gate) that asks to lift a stop of a shell command: the rules offer nothing for it, so nothing is granted
    let r = Rig::new(true);
    let id = r.start(Automatic).agent_id;
    let env = r.env();
    let intent = json!({"class": "exec", "tool": "Bash", "rawCommand": "cat .env", "summary": "cat .env"});
    r.card(&id, "s1", intent, json!({"kind": "secretFile", "rule": "read.never-read", "scope": env, "repo": r.repo.path.to_string_lossy()}));
    for d in [PermissionDecision::AllowOnce, PermissionDecision::AllowRun] {
        assert_eq!(code(r.click_broad(&id, "s1", d)), "rulesMoved");
    }
    assert!(r.host.context(&id).unwrap().stop_grants.is_empty());
    r.host.shutdown();
}

#[test]
fn a_run_wide_grant_ends_with_the_session_and_a_resumed_run_asks_again() {
    let r = Rig::new(true);
    let id = r.start(Automatic).agent_id;
    r.env_card(&id, "p1");
    r.click_broad(&id, "p1", PermissionDecision::AllowRun).expect("for the run");
    assert_ne!(r.judged(&id, "t-x"), Decision::Deny);
    // the idle reaper ends the session: the grant goes with it
    assert!(r.host.suspend_idle(0) >= 1);
    wait_until(10, "the session to end", || r.host.leases().is_empty());
    assert!(r.host.context(&id).unwrap().stop_grants.is_empty(), "closed with the session");
    r.host.send(&id, "again").expect("resume");
    assert!(r.host.context(&id).unwrap().stop_grants.is_empty(), "a resumed run starts without its grants");
    assert_eq!(r.judged(&id, "t-y"), Decision::Deny, "and is refused again");
    // a once grant goes the same way, and so does a dead sidecar
    r.env_card(&id, "p2");
    r.click_broad(&id, "p2", PermissionDecision::AllowRun).expect("a fresh session asks again");
    assert!(!r.host.context(&id).unwrap().stop_grants.is_empty());
    r.kill_sidecar();
    assert!(r.host.context(&id).unwrap().stop_grants.is_empty());
    r.host.shutdown();
}

#[test]
fn stop_ends_a_run_wide_grant_and_a_plain_follow_up_message_keeps_it() {
    let r = Rig::new(true);
    let id = r.start(Automatic).agent_id;
    r.env_card(&id, "p1");
    r.click_broad(&id, "p1", PermissionDecision::AllowRun).expect("for the run");
    assert_ne!(r.judged(&id, "t-x"), Decision::Deny);
    // an ordinary follow-up message in the same live session keeps it
    r.host.send(&id, "and another thing").expect("follow-up");
    assert!(!r.host.context(&id).unwrap().stop_grants.is_empty(), "a follow-up keeps the grant");
    assert_ne!(r.judged(&id, "t-y"), Decision::Deny);
    // Stop empties it, and the next Read asks again
    r.host.interrupt(&id).expect("stop");
    assert!(r.host.context(&id).unwrap().stop_grants.is_empty(), "Stop ends the grant");
    assert_eq!(r.judged(&id, "t-z"), Decision::Deny);
    r.host.shutdown();
}
