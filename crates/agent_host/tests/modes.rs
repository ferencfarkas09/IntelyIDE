//! Permission modes in the host ((design notes: permission-modes-spec) 8.2, rows H-1 .. H-7, H-10, H-11) against the fake sidecar of
//! `tests/common/fake-sidecar-modes.mjs`: it takes a slot like the real one, records what the host sends it and answers as the test
//! tells it to, so a refused or lost `session/permission` can be injected. No CLI, no model call, no Tauri.
//!
//! Rows that need `session_allow_for` (the policy builder's derivation of "allow always in this session") skip with a loud message while
//! it is still the fail-closed stub; `INTELY_REQUIRE_POLICY=1` turns that skip into a failure (the integration run sets it).

mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use intely_agent_core::api::{AgentStartRequest, AgentSummary, PermissionDecision};
use intely_agent_core::delegates::{DelegateDef, DelegateScope, DelegateSet, DelegateSpec};
use intely_agent_core::events::types::{EventKind, ModeChangeReason};
use intely_agent_core::mcp::{McpError, McpPolicy, McpResolved, McpSelection, McpServerRules, McpToolRule, McpWire};
use intely_agent_core::policy::decide::{decide, session_allow_for, Decision, SavedAllow};
use intely_agent_core::policy::intent::{PolicyRequest, ToolIntent};
use intely_agent_core::providers::PermissionMode::{self, Ask, Automatic, Bypass, Edit, ReadOnly};
use intely_agent_host::roles::{RoleDef, RoleFile};
use intely_agent_host::{AcpMock, AgentHost, AnswerExtra, HostConfig, RepoRef, SetModeOpts, StartOptions};
use intely_core::EngineError;
use serde_json::{json, Value};

const RULES_CHANGED: &str = "The rules changed while this was waiting (mode or MCP policy).";

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

fn repo_at(base: &Path, name: &str) -> RepoRef {
    let path = base.join(name);
    std::fs::create_dir_all(&path).unwrap();
    git(&path, &["init", "-q", "-b", "main"]);
    std::fs::write(path.join("a.txt"), "one\n").unwrap();
    git(&path, &["add", "a.txt"]);
    git(&path, &["commit", "-q", "-m", "init"]);
    RepoRef { id: name.into(), path: path.canonicalize().unwrap() }
}

struct Rig {
    dir: tempfile::TempDir,
    repo: RepoRef,
    host: AgentHost,
    sink: Arc<Collector>,
}

impl Rig {
    fn new() -> Self {
        Self::with(|_| {})
    }

    fn with(tweak: impl FnOnce(&mut HostConfig)) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repo = fixture_repo(dir.path());
        let mut cfg = config(&dir.path().join("data"), fake());
        cfg.providers = vec!["claude".into(), "mock".into()];
        cfg.claude_bin = Some(PathBuf::from("/bin/echo"));
        tweak(&mut cfg);
        let (host, sink) = host_with(cfg);
        Self { dir, repo, host, sink }
    }

    fn repos(&self) -> Vec<RepoRef> {
        vec![self.repo.clone()]
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn control(&self, v: Value) {
        std::fs::write(self.path("fake-control.json"), v.to_string()).unwrap();
    }

    /// Everything the fake logged, in order.
    fn log(&self) -> Vec<Value> {
        std::fs::read_to_string(self.path("fake-log.jsonl")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
    }

    fn bodies(&self, ty: &str) -> Vec<Value> {
        self.log().into_iter().filter(|l| l["type"] == ty).map(|l| l["body"].clone()).collect()
    }

    fn answers(&self, req: &str) -> Vec<Value> {
        self.bodies("permission/answer").into_iter().filter(|b| b["reqId"] == req).collect()
    }

    fn mode_messages(&self) -> Vec<String> {
        self.bodies("session/permission").iter().map(|b| b["mode"].as_str().unwrap_or("").to_string()).collect()
    }

    fn start_with(&self, role: &str, mode: Option<PermissionMode>, opts: StartOptions) -> Result<AgentSummary, EngineError> {
        let def = self.host.find_role(role, &self.repos()).expect("role");
        self.host.start_role_with(&def, AgentStartRequest { role: role.into(), repo_ids: vec![self.repo.id.clone()], prompt: "go".into(), mode, mcp_servers: None }, &self.repos(), opts)
    }

    /// A run in `mode` (Bypass confirmed: the dialog's yes).
    fn start(&self, role: &str, mode: Option<PermissionMode>) -> AgentSummary {
        self.start_with(role, mode, StartOptions { bypass_confirmed: true, ..Default::default() }).expect("start")
    }

    fn switch(&self, id: &str, mode: PermissionMode) -> Result<AgentSummary, EngineError> {
        self.host.set_mode(id, mode, SetModeOpts { confirm_bypass: mode == Bypass })
    }

    /// The sidecar is told to emit these events (one events/batch).
    fn emit(&self, id: &str, events: Vec<Value>) {
        self.host.send(id, &json!({ "events": events }).to_string()).expect("send");
    }

    /// A permission card of the fake agent, waited for until the host has folded it.
    fn card(&self, id: &str, req: &str, intent: Value, options: &[&str]) {
        self.emit(id, vec![json!({"kind": "permission.request", "reqId": req, "toolId": format!("tool-{req}"), "intent": intent, "options": options})]);
        self.sink.wait(id, "the card", 10, |e| matches!(&e.kind, EventKind::PermissionRequest { req_id, .. } if req_id == req));
    }

    fn resolved(&self, id: &str, req: &str) {
        self.sink.wait(id, "permission.resolved", 15, |e| matches!(&e.kind, EventKind::PermissionResolved { req_id, .. } if req_id == req));
    }

    fn disk_meta(&self, id: &str) -> Value {
        serde_json::from_slice(&std::fs::read(self.path("data/runs").join(format!("{id}.meta.json"))).expect("meta.json")).unwrap()
    }

    fn lease_writer(&self, id: &str) -> Option<bool> {
        self.host.leases().into_iter().find(|l| l.agent_id == id).map(|l| l.writer)
    }

    fn kill_sidecar(&self) {
        let pid = self.host.sidecar_pid().expect("sidecar");
        // SAFETY: SIGKILL to the sidecar this test spawned.
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        wait_until(10, "the sidecar to be gone", || self.host.sidecar_pid().is_none());
    }

    fn infos(&self, id: &str) -> Vec<(PermissionMode, Option<ModeChangeReason>, u64)> {
        self.sink
            .of(id)
            .iter()
            .filter_map(|e| match &e.kind {
                EventKind::SessionInfo { effective: Some(c), .. } => c.permission.map(|p| (p, c.reason, e.seq)),
                _ => None,
            })
            .collect()
    }
}

fn exec(cmd: &str) -> Value {
    json!({"class": "exec", "tool": "Bash", "rawCommand": cmd, "summary": cmd})
}

fn write_intent(path: &str) -> Value {
    json!({"class": "write", "tool": "Edit", "paths": [path], "summary": "edit"})
}

fn exit_plan() -> Value {
    json!({"class": "other", "tool": "ExitPlanMode", "summary": "ExitPlanMode: leave plan mode"})
}

fn code<T: std::fmt::Debug>(r: Result<T, EngineError>) -> String {
    r.expect_err("must be refused").code
}

fn intent_of(v: &Value) -> ToolIntent {
    serde_json::from_value(v.clone()).unwrap()
}

/// What the policy says about `intent` in the run's current context.
fn verdict(rig: &Rig, id: &str, intent: &Value) -> Decision {
    let ctx = rig.host.context(id).unwrap();
    decide(&ctx, &PolicyRequest { agent_id: id.into(), tool_id: "t".into(), provider: "claude".into(), intent: intent_of(intent) }).decision
}

/// `true` when the policy builder's derivation gives a session allow for `intent` in the run's context; otherwise the row skips (or fails
/// under `INTELY_REQUIRE_POLICY=1`).
fn derivable(rig: &Rig, id: &str, intent: &Value) -> bool {
    let ctx = rig.host.context(id).unwrap();
    if session_allow_for(&ctx, &intent_of(intent)).is_some() {
        return true;
    }
    assert!(std::env::var("INTELY_REQUIRE_POLICY").is_err(), "session_allow_for returned None for {intent}: the policy builder's derivation is missing");
    eprintln!("SKIPPED (session_allow_for is still the stub): {intent}");
    false
}

// ---------------------------------------------------------------------------------------------------------------- H-1

#[test]
fn h1_every_ordered_pair_of_modes_switches_live_and_leaves_rust_and_the_sidecar_in_step() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(ReadOnly)).agent_id;
    let summary = r.host.list().into_iter().find(|s| s.agent_id == id).unwrap();
    assert_eq!(summary.switchable_modes, PermissionMode::ALL.to_vec(), "the mock provider can switch to every mode");
    let mut current = ReadOnly;
    let mut pairs = 0;
    for from in PermissionMode::ALL {
        for to in PermissionMode::ALL {
            if from == to {
                continue;
            }
            if current != from {
                r.switch(&id, from).expect("hop");
            }
            let told = r.mode_messages().len();
            let s = r.switch(&id, to).unwrap_or_else(|e| panic!("{from:?} -> {to:?}: {e:?}"));
            current = to;
            pairs += 1;
            assert_eq!((s.permission, s.requested.permission), (to, to), "{from:?} -> {to:?}");
            let ctx = r.host.context(&id).unwrap();
            assert_eq!((ctx.mode, ctx.strict_jail), (to, to != Bypass), "{from:?} -> {to:?}: Rust is the authority and only Bypass drops the folder boundary");
            assert_eq!(r.disk_meta(&id)["permission"], serde_json::to_value(to).unwrap(), "{from:?} -> {to:?}: meta.json follows");
            assert_eq!(r.lease_writer(&id), Some(to.is_writer()), "{from:?} -> {to:?}: the writer lease follows the mode");
            let told_now = r.mode_messages();
            assert_eq!(told_now.len(), told + 1, "{from:?} -> {to:?}: the sidecar was told exactly once");
            assert_eq!(told_now.last().unwrap(), &serde_json::to_value(to).unwrap().as_str().unwrap().to_string());
            wait_until(10, "the effective mode to follow", || r.host.list().iter().any(|a| a.agent_id == id && a.effective.as_ref().is_some_and(|e| e.permission == to)));
        }
    }
    assert_eq!(pairs, 20, "all 20 ordered pairs");
    assert!(r.infos(&id).iter().any(|(p, reason, _)| *p == Bypass && *reason == Some(ModeChangeReason::User)), "the sidecar's session.info carries the reason");

    // idempotent: the same mode again says nothing to anybody
    let (messages, events) = (r.mode_messages().len(), r.sink.of(&id).len());
    let s = r.switch(&id, current).unwrap();
    assert_eq!(s.permission, current);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!((r.mode_messages().len(), r.sink.of(&id).len()), (messages, events), "no message and no event for an unchanged mode");
    r.host.shutdown();
}

#[test]
fn h1_a_run_without_a_live_session_records_the_switch_with_one_event_and_the_next_session_reads_it() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(Ask)).agent_id;
    r.kill_sidecar();
    let told = r.mode_messages().len();
    let s = r.switch(&id, Edit).expect("a stopped run can still change its mode");
    assert_eq!(s.permission, Edit);
    assert_eq!(r.mode_messages().len(), told, "nobody to tell");
    assert!(r.infos(&id).iter().any(|(p, reason, _)| *p == Edit && (*reason == Some(ModeChangeReason::User))), "one session.info records it: {:?}", r.infos(&id));
    assert_eq!(r.disk_meta(&id)["permission"], "edit");
    r.host.send(&id, "again").expect("resume");
    let starts = r.bodies("session/start");
    assert_eq!(starts.last().unwrap()["role"]["permission"], "edit", "the next session starts in the switched mode");
    assert_eq!(starts.last().unwrap()["writer"], true);
    r.host.shutdown();
}

// ---------------------------------------------------------------------------------------------------------------- H-2

#[test]
fn h2_a_switch_that_cannot_happen_is_refused_with_a_code_and_changes_nothing() {
    let r = Rig::new();
    assert_eq!(code(r.switch("a-nope", Edit)), "unknownAgent");
    let id = r.start("mock-plain-reply", Some(Ask)).agent_id;

    // Bypass needs the dialog's yes, and nothing moved when it is missing
    assert_eq!(code(r.host.set_mode(&id, Bypass, SetModeOpts::default())), "bypassNotConfirmed");
    assert_eq!(r.host.context(&id).unwrap().mode, Ask);
    assert_eq!(r.disk_meta(&id)["permission"], "ask");
    assert!(r.mode_messages().is_empty());

    // a second run on the same repository holds the writer lease: this one cannot become a writer, and stays exactly as it was
    let writer = r.start("mock-tool-permission", Some(Edit)).agent_id;
    assert_eq!(r.lease_writer(&writer), Some(true));
    let e = r.switch(&id, Edit).expect_err("the repository is being written");
    assert_eq!(e.code, "writeLease", "{}", e.message);
    assert_eq!((r.host.context(&id).unwrap().mode, r.lease_writer(&id)), (Ask, Some(false)));
    assert_eq!(r.disk_meta(&id)["permission"], "ask");
    assert!(r.mode_messages().is_empty(), "the sidecar was never asked");
    r.host.shutdown();
}

#[test]
fn h2_the_writer_cap_and_the_kill_switch_and_an_unsupported_provider_refuse_too() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b, c) = (repo_at(dir.path(), "repo"), repo_at(dir.path(), "repo2"), repo_at(dir.path(), "repo3"));
    let mut cfg = config(&dir.path().join("data"), fake());
    cfg.providers = vec!["mock".into()];
    let (host, _sink) = host_with(cfg);
    let repos = vec![a.clone(), b.clone(), c.clone()];
    let start = |repo: &RepoRef, role: &str, mode| {
        let def = host.find_role(role, &repos).unwrap();
        host.start_role_with(&def, AgentStartRequest { role: role.into(), repo_ids: vec![repo.id.clone()], prompt: "go".into(), mode: Some(mode), mcp_servers: None }, &repos, StartOptions::default()).expect("start")
    };
    start(&a, "mock-tool-permission", Edit);
    start(&b, "mock-tool-permission", Edit);
    let reader = start(&c, "mock-plain-reply", ReadOnly).agent_id;
    let e = host.set_mode(&reader, Edit, SetModeOpts::default()).expect_err("two writers is the cap");
    assert_eq!(e.code, "noSlot", "{}", e.message);
    assert_eq!(host.list().iter().find(|s| s.agent_id == reader).unwrap().permission, ReadOnly);
    host.shutdown();

    // the kill switch: Automatic and Bypass are refused for a start and for a switch, Bypass's missing confirmation notwithstanding
    let r = Rig::with(|cfg| cfg.no_unattended = true);
    let e = r.start_with("mock-plain-reply", Some(Automatic), StartOptions::default()).expect_err("kill switch");
    assert_eq!(e.code, "modeDisabled", "{}", e.message);
    assert_eq!(code(r.start_with("mock-plain-reply", Some(Bypass), StartOptions { bypass_confirmed: true, ..Default::default() })), "modeDisabled");
    assert!(r.host.list().is_empty(), "a refused start leaves no run behind");
    let id = r.start("mock-plain-reply", Some(Ask)).agent_id;
    assert_eq!(code(r.switch(&id, Automatic)), "modeDisabled");
    assert_eq!(code(r.host.set_mode(&id, Bypass, SetModeOpts::default())), "modeDisabled", "the kill switch is judged before the confirmation");
    assert_eq!(r.switch(&id, Edit).map(|s| s.permission).unwrap(), Edit, "the attended modes still work");
    r.host.shutdown();

    // a provider without a live switch (the scripted ACP agent) cannot be switched, and cannot start in an unattended mode
    let fakes = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sidecar/tests/fakes");
    let r = Rig::with(|cfg| {
        cfg.providers.push("gemini".into());
        cfg.acp_mock = Some(AcpMock { provider: "gemini".into(), agent_js: fakes.join("fake-acp-agent.mjs"), scripts_dir: fakes.join("acp-scripts") });
    });
    assert_eq!(code(r.start_with("mock-acp-plain-reply", Some(Automatic), StartOptions::default())), "modeNotSupported");
    let id = r.start("mock-acp-plain-reply", None).agent_id;
    let s = r.host.list().into_iter().find(|s| s.agent_id == id).unwrap();
    assert!(s.switchable_modes.is_empty(), "the chip is static");
    assert_eq!(code(r.switch(&id, Edit)), "modeNotSupported");
    r.host.shutdown();
}

#[test]
fn h2_a_second_switch_while_one_is_in_flight_is_refused_with_mode_busy() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(ReadOnly)).agent_id;
    r.control(json!({"permissionReply": "drop"}));
    let host = r.host.clone();
    let first = {
        let id = id.clone();
        std::thread::spawn(move || host.set_mode(&id, Edit, SetModeOpts::default()))
    };
    wait_until(10, "the first switch to reach the sidecar", || !r.bodies("session/permission").is_empty());
    assert_eq!(code(r.switch(&id, Ask)), "modeBusy");
    // the sidecar never answers: loosening is rolled back after the 5 s timeout, so the run is exactly where it was
    let e = first.join().unwrap().expect_err("the sidecar never took it");
    assert_eq!(e.code, "modeNotApplied", "{}", e.message);
    assert_eq!((r.host.context(&id).unwrap().mode, r.disk_meta(&id)["permission"].clone()), (ReadOnly, json!("readOnly")));
    r.control(json!({}));
    assert_eq!(r.switch(&id, Ask).unwrap().permission, Ask, "the busy flag was cleared on every exit path");
    r.host.shutdown();
}

// ---------------------------------------------------------------------------------------------------------------- H-3

#[test]
fn h3_a_tightening_the_sidecar_refuses_keeps_rust_at_the_stricter_mode() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(Edit)).agent_id;
    assert_eq!(r.lease_writer(&id), Some(true));
    r.control(json!({"permissionReply": "error"}));
    let e = r.switch(&id, ReadOnly).expect_err("the agent refused");
    assert_eq!(e.code, "modeNotApplied");
    assert!(e.message.contains("already enforces readOnly"), "{}", e.message);
    let ctx = r.host.context(&id).unwrap();
    assert_eq!((ctx.mode, ctx.strict_jail), (ReadOnly, true), "Rust enforces the stricter mode: the safe side");
    assert_eq!(r.disk_meta(&id)["permission"], "readOnly");
    assert_eq!(r.lease_writer(&id), Some(false), "and gave the writer lease back");
    assert_eq!(r.host.list()[0].permission, ReadOnly);
    r.host.shutdown();
}

#[test]
fn h3_a_loosening_the_sidecar_refuses_rolls_rust_meta_and_the_lease_back_and_tells_it_the_old_mode_again() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(Ask)).agent_id;
    r.control(json!({"permissionReply": "error"}));
    let e = r.switch(&id, Edit).expect_err("the agent refused");
    assert_eq!(e.code, "modeNotApplied");
    assert!(e.message.contains("stays in ask"), "{}", e.message);
    let ctx = r.host.context(&id).unwrap();
    assert_eq!((ctx.mode, ctx.strict_jail), (Ask, true));
    assert_eq!(r.disk_meta(&id)["permission"], "ask", "meta.json was rolled back too");
    assert_eq!(r.lease_writer(&id), Some(false), "the lease flag went back");
    assert_eq!(r.mode_messages(), ["edit", "ask"], "the sidecar's own view matches Rust again");
    assert_eq!(r.host.list()[0].permission, Ask);
    // and into Bypass the folder boundary only drops once the sidecar took it
    let e = r.switch(&id, Bypass).expect_err("refused");
    assert_eq!(e.code, "modeNotApplied");
    assert!(r.host.context(&id).unwrap().strict_jail, "the boundary is back");
    r.host.shutdown();
}

#[test]
fn h3_a_tightening_withdraws_the_cards_that_became_denials_exactly_once_and_leaves_the_others() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(Ask)).agent_id;
    let outside = r.repo.path.join("a.txt").display().to_string();
    r.card(&id, "rm", exec("rm -rf x"), &["allow_once", "deny"]);
    r.card(&id, "wr", write_intent(&outside), &["allow_once", "deny"]);
    r.switch(&id, ReadOnly).expect("switch to Plan");
    for req in ["rm", "wr"] {
        r.resolved(&id, req);
        let answers = r.answers(req);
        assert_eq!(answers.len(), 1, "{req}: answered exactly once");
        assert_eq!((answers[0]["outcome"].as_str(), answers[0]["message"].as_str()), (Some("deny"), Some(RULES_CHANGED)), "{req}");
    }
    assert!(matches!(r.host.answer_permission(&id, "rm", PermissionDecision::AllowOnce).expect_err("withdrawn").code.as_str(), "unknownRequest" | "alreadyAnswered"));

    // a script card opened in Edit is a denial in Plan; one that is still an ask after a tightening to Ask stays, untouched
    r.switch(&id, Edit).unwrap();
    r.card(&id, "script", exec("npm test"), &["allow_once", "deny"]);
    r.switch(&id, Ask).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(r.answers("script").is_empty(), "an ask that is still an ask stays pending");
    r.switch(&id, ReadOnly).unwrap();
    r.resolved(&id, "script");
    assert_eq!(r.answers("script").len(), 1);
    assert_eq!(r.answers("script")[0]["message"], RULES_CHANGED);

    // loosening is not a tightening: a card for a read waits as it was
    r.switch(&id, Ask).unwrap();
    r.card(&id, "status", exec("git status"), &["allow_once", "deny"]);
    r.switch(&id, Edit).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(r.answers("status").is_empty());
    r.host.shutdown();
}

#[test]
fn h3_a_withdrawal_the_sidecar_never_takes_leaves_the_card_pending_and_a_click_is_refused_by_the_redecision() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(Ask)).agent_id;
    r.card(&id, "rm", exec("rm -rf x"), &["allow_once", "deny"]);
    r.control(json!({"answerReply": "drop"}));
    r.switch(&id, ReadOnly).expect("the switch itself worked"); // the withdrawal waits out its 5 s
    assert_eq!(r.answers("rm").len(), 1, "one attempt, no double answer");
    r.control(json!({}));
    // the card is still pending, and a click that raced the tightening must not become an allow: the host judges it again
    let e = r.host.answer_permission(&id, "rm", PermissionDecision::AllowOnce).expect_err("refused");
    assert_eq!(e.code, "modeChanged", "{}", e.message);
    r.resolved(&id, "rm");
    let answers = r.answers("rm");
    assert_eq!(answers.len(), 2);
    assert_eq!((answers[1]["outcome"].as_str(), answers[1]["message"].as_str()), (Some("deny"), Some(RULES_CHANGED)));
    assert!(answers.iter().all(|a| a["outcome"] != "allow"), "nothing was allowed");
    r.host.shutdown();
}

// ---------------------------------------------------------------------------------------------------------------- H-4

fn delegate(name: &str, permission: PermissionMode, capped: bool) -> DelegateDef {
    DelegateDef {
        spec: DelegateSpec {
            name: name.into(),
            description: format!("The {name} role"),
            prompt: format!("PREAMBLE\n\nYou are {name}."),
            model: "claude-sonnet-5-5".into(),
            effort: None,
            permission,
            tools: Vec::new(),
            disallowed_tools: vec!["RemoteTrigger".into(), "Agent".into(), "Task".into()],
            max_turns: Some(25),
            scope: DelegateScope::Global,
            color: None,
        },
        source: format!("/roles/{name}.md"),
        capped,
    }
}

fn delegating_rig(set: Arc<Mutex<Vec<DelegateDef>>>) -> Rig {
    Rig::with(|cfg| {
        cfg.delegate_resolver = Some(Arc::new(move |_| DelegateSet { included: set.lock().unwrap().clone(), excluded: Vec::new() }));
    })
}

#[test]
fn h4_allow_run_needs_the_offered_option_and_a_derivation_the_host_makes_itself() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(Ask)).agent_id;
    r.card(&id, "once", exec("git status"), &["allow_once", "deny"]);
    assert_eq!(code(r.host.answer_permission(&id, "once", PermissionDecision::AllowRun)), "optionNotOffered", "the card did not offer it");
    assert_eq!(code(r.host.answer_permission(&id, "once", PermissionDecision::AllowAlways)), "optionNotOffered", "role + repository rules stay unavailable");
    // the host never trusts the event's own offer: a script is something nothing derives an allow for
    r.card(&id, "forged", exec("node script.js"), &["allow_once", "allow_run", "deny"]);
    assert_eq!(code(r.host.answer_permission(&id, "forged", PermissionDecision::AllowRun)), "optionNotOffered");
    let ctx = r.host.context(&id).unwrap();
    assert!(ctx.saved.is_empty() && ctx.saved_by_role.is_empty(), "nothing was pushed");
    assert!(r.answers("forged").is_empty(), "and nothing reached the sidecar: the card is still answerable");
    r.host.answer_permission(&id, "forged", PermissionDecision::Deny).expect("still pending");
    r.host.shutdown();
}

#[test]
fn h4_allow_run_derives_the_allow_pushes_it_into_the_lead_list_and_never_persists_it() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(Ask)).agent_id;
    let status = exec("git status");
    if !derivable(&r, &id, &status) {
        return;
    }
    r.card(&id, "s1", status.clone(), &["allow_once", "allow_run", "deny"]);
    r.host.answer_permission(&id, "s1", PermissionDecision::AllowRun).expect("allow for the session");
    r.resolved(&id, "s1");
    let answer = &r.answers("s1")[0];
    assert_eq!((answer["outcome"].as_str(), answer["mode"].is_null()), (Some("allow"), true), "allow_run reaches the sidecar as a plain allow");
    let ctx = r.host.context(&id).unwrap();
    assert!(ctx.saved.iter().any(|a| matches!(a, SavedAllow::ExecPrefix { argv } if argv == &["git", "status"])), "{:?}", ctx.saved);
    // a second card of the same kind that was already waiting when the first was answered "always": its click is an allow, nothing is stored twice
    r.card(&id, "s2", exec("git status"), &["allow_once", "allow_run", "deny"]);
    r.host.answer_permission(&id, "s2", PermissionDecision::AllowRun).expect("already allowed by the saved rule");
    assert_eq!(r.host.context(&id).unwrap().saved.len(), ctx.saved.len());
    assert_eq!(r.answers("s2")[0]["outcome"], "allow");
    // it is in memory only: neither meta.json nor the summary carries it
    let meta = serde_json::to_string(&r.host.metas()[0]).unwrap();
    assert!(!meta.contains("saved") && !serde_json::to_string(&r.disk_meta(&id)).unwrap().contains("saved"), "{meta}");
    // a later call is judged by it
    assert_eq!(verdict(&r, &id, &status), Decision::Allow, "exec.saved");

    // it dies with the session: the idle reaper counts as the end of one
    assert!(r.host.suspend_idle(0) >= 1);
    wait_until(10, "the session to end", || r.host.leases().is_empty());
    assert!(r.host.context(&id).unwrap().saved.is_empty(), "closed with the session");
    r.host.send(&id, "again").expect("resume");
    assert!(r.host.context(&id).unwrap().saved.is_empty(), "a resumed session starts without its allows");
    // and a dead sidecar ends it too
    r.card(&id, "s3", exec("git status"), &["allow_once", "allow_run", "deny"]);
    r.host.answer_permission(&id, "s3", PermissionDecision::AllowRun).expect("a fresh session asks again");
    assert!(!r.host.context(&id).unwrap().saved.is_empty());
    r.kill_sidecar();
    assert!(r.host.context(&id).unwrap().saved.is_empty());
    r.host.shutdown();
}

#[test]
fn h4_a_delegates_allow_never_applies_to_another_role_or_to_the_lead() {
    let set = Arc::new(Mutex::new(vec![delegate("dev", Edit, false), delegate("other", Edit, false)]));
    let r = delegating_rig(set);
    let id = r.start("auto", Some(Ask)).agent_id;
    let mut intent = exec("git status");
    intent["actor"] = json!({"agentId": "sub-1", "role": "dev"});
    if !derivable(&r, &id, &intent) {
        return;
    }
    r.card(&id, "d1", intent.clone(), &["allow_once", "allow_run", "deny"]);
    r.host.answer_permission(&id, "d1", PermissionDecision::AllowRun).unwrap();
    let ctx = r.host.context(&id).unwrap();
    assert!(ctx.saved.is_empty(), "the lead got nothing");
    assert_eq!(ctx.saved_by_role.keys().collect::<Vec<_>>(), ["dev"], "{:?}", ctx.saved_by_role);
    assert_eq!(verdict(&r, &id, &intent), Decision::Allow);
    let mut other = intent.clone();
    other["actor"] = json!({"agentId": "sub-2", "role": "other"});
    assert_eq!(verdict(&r, &id, &other), Decision::Ask, "another role is still asked");
    assert_eq!(verdict(&r, &id, &exec("git status")), Decision::Ask, "and so is the lead");
    r.host.shutdown();
}

#[test]
fn h4_a_write_allow_takes_the_writer_lease_or_fails_and_a_sidecar_that_loses_the_answer_is_rolled_back() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(Ask)).agent_id;
    let file = r.repo.path.join("a.txt").display().to_string();
    let edit = write_intent(&file);
    if !derivable(&r, &id, &edit) {
        return;
    }
    assert_eq!(r.lease_writer(&id), Some(false), "an Ask run holds no writer lease");
    // another run writes to this repository: the allow cannot be given, and the card stays pending, nothing pushed
    let other = r.start("mock-tool-permission", Some(Edit)).agent_id;
    r.card(&id, "w1", edit.clone(), &["allow_once", "allow_run", "deny"]);
    let e = r.host.answer_permission(&id, "w1", PermissionDecision::AllowRun).expect_err("the repository is being written");
    assert_eq!(e.code, "writeLease", "{}", e.message);
    assert!(r.host.context(&id).unwrap().saved.is_empty() && r.answers("w1").is_empty());
    // the writer finished its turn... and left: the lease is free
    r.host.interrupt(&other).ok();
    r.kill_sidecar();
    r.host.send(&id, "go on").expect("resume");
    // the sidecar never takes the answer: the host puts everything back
    r.card(&id, "w2", edit.clone(), &["allow_once", "allow_run", "deny"]);
    r.control(json!({"answerReply": "drop"}));
    let e = r.host.answer_permission(&id, "w2", PermissionDecision::AllowRun).expect_err("lost");
    assert_eq!(e.code, "sidecarUnavailable");
    assert!(r.host.context(&id).unwrap().saved.is_empty(), "the pushed allow was removed again");
    assert_eq!(r.lease_writer(&id), Some(false), "and the lease flag restored");
    r.control(json!({}));
    r.host.answer_permission(&id, "w2", PermissionDecision::AllowRun).expect("the card is answerable again");
    assert!(r.host.context(&id).unwrap().saved.contains(&SavedAllow::WriteInside));
    assert_eq!(r.lease_writer(&id), Some(true), "a write allow needs the writer lease");
    r.host.shutdown();
}

// ---------------------------------------------------------------------------------------------------------------- H-5

fn plan_card(r: &Rig, id: &str, req: &str) {
    r.card(id, req, exit_plan(), &["allow_once", "deny"]);
}

#[test]
fn h5_approving_a_plan_switches_the_run_to_the_chosen_mode_in_one_step() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(ReadOnly)).agent_id;
    plan_card(&r, &id, "p1");
    r.host.answer_permission_with(&id, "p1", PermissionDecision::AllowOnce, AnswerExtra { mode: Some(Edit), feedback: None }).expect("approve");
    let ctx = r.host.context(&id).unwrap();
    assert_eq!((ctx.mode, ctx.strict_jail), (Edit, true));
    assert_eq!(r.disk_meta(&id)["permission"], "edit");
    assert_eq!(r.lease_writer(&id), Some(true), "Edit is a writer mode");
    let answer = &r.answers("p1")[0];
    assert_eq!((answer["outcome"].as_str(), answer["mode"].as_str()), (Some("allow"), Some("edit")));
    r.resolved(&id, "p1");
    assert!(r.infos(&id).iter().any(|(p, reason, _)| *p == Edit && *reason == Some(ModeChangeReason::PlanApproved)));
    assert!(matches!(r.host.answer_permission(&id, "p1", PermissionDecision::AllowOnce).expect_err("answered").code.as_str(), "unknownRequest" | "alreadyAnswered"));
    assert_eq!(r.switch(&id, Ask).unwrap().permission, Ask, "the busy flag was released");
    r.host.shutdown();
}

#[test]
fn h5_bypass_and_plan_are_never_a_continuation_and_the_card_stays_pending() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(ReadOnly)).agent_id;
    plan_card(&r, &id, "p1");
    for wrong in [Bypass, ReadOnly] {
        let e = r.host.answer_permission_with(&id, "p1", PermissionDecision::AllowOnce, AnswerExtra { mode: Some(wrong), feedback: None }).expect_err("refused");
        assert_eq!(e.code, "invalidMode", "{wrong:?}: {}", e.message);
    }
    assert_eq!((r.host.context(&id).unwrap().mode, r.answers("p1").len()), (ReadOnly, 0), "nothing changed and nothing was sent");
    // the phone sends no mode: the run continues in Ask
    r.host.answer_permission(&id, "p1", PermissionDecision::AllowOnce).expect("approve without a mode");
    assert_eq!(r.host.context(&id).unwrap().mode, Ask);
    assert_eq!(r.answers("p1")[0]["mode"], "ask");
    r.host.shutdown();
}

#[test]
fn h5_a_writer_mode_that_cannot_get_the_lease_leaves_the_plan_card_pending_and_the_run_in_plan() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(ReadOnly)).agent_id;
    r.start("mock-tool-permission", Some(Edit)); // holds the repository's writer lease
    plan_card(&r, &id, "p1");
    let e = r.host.answer_permission_with(&id, "p1", PermissionDecision::AllowOnce, AnswerExtra { mode: Some(Automatic), feedback: None }).expect_err("lease");
    assert_eq!(e.code, "writeLease", "{}", e.message);
    assert_eq!((r.host.context(&id).unwrap().mode, r.disk_meta(&id)["permission"].clone(), r.answers("p1").len()), (ReadOnly, json!("readOnly"), 0));
    // Ask is no writer mode: the same card can still be approved
    r.host.answer_permission_with(&id, "p1", PermissionDecision::AllowOnce, AnswerExtra { mode: Some(Ask), feedback: None }).expect("approve in Ask");
    assert_eq!(r.host.context(&id).unwrap().mode, Ask);
    r.host.shutdown();
}

#[test]
fn h5_when_the_user_switched_away_meanwhile_the_current_mode_is_kept() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(ReadOnly)).agent_id;
    plan_card(&r, &id, "p1");
    r.switch(&id, Edit).unwrap();
    r.host.answer_permission_with(&id, "p1", PermissionDecision::AllowOnce, AnswerExtra { mode: Some(Automatic), feedback: None }).expect("the click stands");
    assert_eq!(r.host.context(&id).unwrap().mode, Edit, "the user's later choice wins");
    assert_eq!(r.answers("p1")[0]["mode"], "edit");
    r.host.shutdown();
}

#[test]
fn h5_rejecting_a_plan_forwards_the_feedback_and_leaves_plan_mode() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(ReadOnly)).agent_id;
    plan_card(&r, &id, "p1");
    let long = "x".repeat(5000);
    r.host.answer_permission_with(&id, "p1", PermissionDecision::Deny, AnswerExtra { mode: None, feedback: Some(format!("  {long}  ")) }).expect("reject");
    let answer = &r.answers("p1")[0];
    assert_eq!((answer["outcome"].as_str(), answer["mode"].is_null()), (Some("deny"), true));
    assert_eq!(answer["message"].as_str().unwrap().chars().count(), 4000, "trimmed and cut at 4000 characters");
    assert_eq!((r.host.context(&id).unwrap().mode, r.disk_meta(&id)["permission"].clone()), (ReadOnly, json!("readOnly")));
    r.host.shutdown();
}

#[test]
fn h5_a_mode_or_feedback_on_the_wrong_kind_of_answer_is_invalid() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(ReadOnly)).agent_id;
    plan_card(&r, &id, "p1");
    r.switch(&id, Ask).unwrap();
    r.card(&id, "x1", exec("npm test"), &["allow_once", "deny"]);
    let bad = |req: &str, decision, mode, feedback: Option<&str>| code(r.host.answer_permission_with(&id, req, decision, AnswerExtra { mode, feedback: feedback.map(str::to_string) }));
    assert_eq!(bad("x1", PermissionDecision::AllowOnce, Some(Edit), None), "invalidAnswer", "a mode on a request that is no plan approval");
    assert_eq!(bad("p1", PermissionDecision::Deny, Some(Edit), None), "invalidAnswer", "a mode on a rejection");
    assert_eq!(bad("p1", PermissionDecision::AllowOnce, None, Some("change it")), "invalidAnswer", "feedback on an approval");
    assert!(r.answers("p1").is_empty() && r.answers("x1").is_empty());
    r.host.shutdown();
}

#[test]
fn h5_a_click_is_judged_again_a_refused_one_sends_the_deny_and_a_loosening_lets_it_stand() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(Ask)).agent_id;
    // a read card, then the user LOOSENS the mode: the click stands (the user answered with the card in front of them)
    r.card(&id, "status", exec("git status"), &["allow_once", "deny"]);
    r.switch(&id, Edit).unwrap();
    r.host.answer_permission(&id, "status", PermissionDecision::AllowOnce).expect("stands");
    assert_eq!(r.answers("status")[0]["outcome"], "allow");
    // a card for a command, then the mode tightens with the withdrawal unable to reach the sidecar
    r.switch(&id, Ask).unwrap();
    r.card(&id, "rm", exec("rm -rf x"), &["allow_once", "deny"]);
    r.control(json!({"answerReply": "drop"}));
    r.switch(&id, ReadOnly).unwrap();
    r.control(json!({}));
    let e = r.host.answer_permission(&id, "rm", PermissionDecision::AllowOnce).expect_err("raced the tightening");
    assert_eq!(e.code, "modeChanged");
    assert!(r.answers("rm").iter().all(|a| a["outcome"] == "deny"), "{:?}", r.answers("rm"));
    r.host.shutdown();
}

#[test]
fn h5_an_allow_run_click_is_judged_again_before_anything_is_pushed() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(Ask)).agent_id;
    let touch = exec("touch notes.txt");
    if !derivable(&r, &id, &touch) {
        return;
    }
    r.card(&id, "t1", touch, &["allow_once", "allow_run", "deny"]);
    r.control(json!({"answerReply": "drop"}));
    r.switch(&id, ReadOnly).unwrap(); // Plan does not run touch; the withdrawal is lost
    r.control(json!({}));
    let e = r.host.answer_permission(&id, "t1", PermissionDecision::AllowRun).expect_err("refused");
    assert_eq!(e.code, "modeChanged");
    assert!(r.host.context(&id).unwrap().saved.is_empty(), "a refused click pushes nothing");
    r.host.shutdown();
}

// ---------------------------------------------------------------------------------------------------------------- H-6

fn file_role(base: &RoleDef, permission: PermissionMode, hash: &str) -> RoleDef {
    let mut role = base.clone();
    role.name = "file-role".into();
    role.permission = permission;
    role.file = Some(RoleFile { untrusted: false, ceiling: false, content_hash: hash.into() });
    role
}

/// A rig whose role resolver answers `file-role` with whatever the test last put in the returned slot.
fn file_rig() -> (Rig, Arc<Mutex<Option<RoleDef>>>) {
    let slot: Arc<Mutex<Option<RoleDef>>> = Arc::new(Mutex::new(None));
    let s = slot.clone();
    let r = Rig::with(move |cfg| {
        let base = intely_agent_host::roles::builtin(cfg).into_iter().find(|r| r.name == "mock-plain-reply").unwrap();
        *s.lock().unwrap() = Some(file_role(&base, Edit, "h1"));
        let s2 = s.clone();
        cfg.role_resolver = Some(Arc::new(move |name, _| if name == "file-role" { s2.lock().unwrap().clone() } else { None }));
    });
    (r, slot)
}

/// What the role file resolves to from now on.
fn set_file_role(slot: &Arc<Mutex<Option<RoleDef>>>, role: RoleDef) {
    *slot.lock().unwrap() = Some(role);
}

fn resume_and_last_start(r: &Rig, id: &str) -> Value {
    r.kill_sidecar();
    r.host.send(id, "again").expect("resume");
    r.bodies("session/start").last().unwrap().clone()
}

#[test]
fn h6_bypass_resumes_as_automatic_with_a_resume_downgrade_event_before_the_new_sessions_first_one() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(Bypass)).agent_id;
    assert_eq!(r.host.context(&id).unwrap().strict_jail, false);
    let before = r.sink.of(&id).last().unwrap().seq;
    let start = resume_and_last_start(&r, &id);
    assert_eq!(start["role"]["permission"], "automatic");
    let summary = r.host.list().into_iter().find(|s| s.agent_id == id).unwrap();
    assert_eq!(summary.permission, Automatic);
    let ctx = r.host.context(&id).unwrap();
    assert_eq!((ctx.mode, ctx.strict_jail), (Automatic, true), "the boundary is back");
    assert_eq!(r.disk_meta(&id)["permission"], "automatic");
    let events = r.sink.of(&id);
    assert!(events.windows(2).all(|w| w[1].seq == w[0].seq + 1), "seq stays gap-free: {:?}", events.iter().map(|e| e.seq).collect::<Vec<_>>());
    let (_, reason, info_seq) = r.infos(&id).into_iter().find(|(p, reason, _)| *p == Automatic && *reason == Some(ModeChangeReason::ResumeDowngrade)).expect("the downgrade is on the record");
    let started_again = events.iter().find(|e| e.seq > before && matches!(e.kind, EventKind::SessionStarted { .. })).map(|e| e.seq).expect("the new session started");
    assert!(info_seq < started_again, "the event precedes the new session's first one");
    assert_eq!(reason, Some(ModeChangeReason::ResumeDowngrade));
    r.host.shutdown();
}

#[test]
fn h6_ask_and_automatic_resume_unchanged_whatever_the_roles_own_permission_is() {
    for mode in [Ask, Automatic, Edit, ReadOnly] {
        let r = Rig::new();
        let id = r.start("mock-tool-permission", Some(mode)).agent_id; // a built-in whose own permission is edit
        let start = resume_and_last_start(&r, &id);
        assert_eq!(start["role"]["permission"], serde_json::to_value(mode).unwrap(), "{mode:?}");
        assert!(!r.infos(&id).iter().any(|(_, reason, _)| matches!(reason, Some(ModeChangeReason::ResumeDowngrade | ModeChangeReason::RoleChanged))), "{mode:?}: nothing was narrowed");
        r.host.shutdown();
    }
    // a researcher (read-only role) started in Automatic by an explicit choice stays Automatic
    let r = Rig::new();
    let id = r.start("researcher", Some(Automatic)).agent_id;
    assert_eq!(resume_and_last_start(&r, &id)["role"]["permission"], "automatic");
    r.host.shutdown();
}

#[test]
fn h6_a_run_without_a_recorded_role_permission_keeps_todays_clamp() {
    let (r, _slot) = file_rig();
    let def = file_role(&r.host.find_role("mock-plain-reply", &r.repos()).unwrap(), Edit, "h1");
    let id = r.host.start_role(&def, AgentStartRequest { role: "file-role".into(), repo_ids: vec![r.repo.id.clone()], prompt: "go".into(), mode: Some(Edit), mcp_servers: None }, &r.repos()).unwrap().agent_id;
    // a meta.json written before the modes spec has no `rolePermission`
    let path = r.path("data/runs").join(format!("{id}.meta.json"));
    let mut meta: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    meta.as_object_mut().unwrap().remove("rolePermission");
    meta.as_object_mut().unwrap().remove("roleHash");
    std::fs::write(&path, serde_json::to_vec(&meta).unwrap()).unwrap();
    r.host.shutdown();
    let mut cfg = config(&r.path("data"), fake());
    cfg.providers = vec!["claude".into(), "mock".into()];
    let base = r.host.find_role("mock-plain-reply", &r.repos()).unwrap();
    // the role is read-only now: stricter than what the run recorded
    cfg.role_resolver = Some(Arc::new(move |name, _| (name == "file-role").then(|| file_role(&base, ReadOnly, "h1"))));
    let (host, _sink) = host_with(cfg);
    assert_eq!(host.list()[0].permission, Edit, "listed as recorded");
    host.send(&id, "again").expect("resume");
    let starts: Vec<Value> = std::fs::read_to_string(r.path("fake-log.jsonl")).unwrap().lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|l| l["type"] == "session/start").map(|l| l["body"].clone()).collect();
    assert_eq!(starts.last().unwrap()["role"]["permission"], "readOnly", "stricter(recorded, role)");
    host.shutdown();
}

#[test]
fn h6_a_role_file_that_changed_under_a_run_or_a_role_demoted_since_the_start_narrows_it_with_a_role_changed_event() {
    let cases: Vec<(&str, Box<dyn Fn(&RoleDef) -> RoleDef>)> = vec![
        ("an untrusted file", Box::new(|b| RoleDef { file: Some(RoleFile { untrusted: true, ceiling: false, content_hash: "h1".into() }), ..file_role(b, Ask, "h1") })),
        ("a ceiling-capped file", Box::new(|b| RoleDef { file: Some(RoleFile { untrusted: false, ceiling: true, content_hash: "h1".into() }), ..file_role(b, Ask, "h1") })),
        ("a file whose hash changed", Box::new(|b| file_role(b, Ask, "h2"))),
        ("a role demoted since the start", Box::new(|b| RoleDef { file: None, ..file_role(b, Ask, "h1") })),
    ];
    for (what, make) in cases {
        let (r, slot) = file_rig();
        let base = r.host.find_role("mock-plain-reply", &r.repos()).unwrap();
        let def = file_role(&base, Edit, "h1");
        let id = r.host.start_role(&def, AgentStartRequest { role: "file-role".into(), repo_ids: vec![r.repo.id.clone()], prompt: "go".into(), mode: Some(Automatic), mcp_servers: None }, &r.repos()).unwrap().agent_id;
        let meta = r.host.metas().into_iter().find(|m| m.agent_id == id).unwrap();
        assert_eq!((meta.role_hash.as_deref(), meta.role_permission), (Some("h1"), Some(Edit)), "{what}");
        set_file_role(&slot, make(&base));
        let start = resume_and_last_start(&r, &id);
        assert_eq!(start["role"]["permission"], "ask", "{what}: narrowed to stricter(automatic, the role's permission)");
        assert!(r.infos(&id).iter().any(|(p, reason, _)| *p == Ask && *reason == Some(ModeChangeReason::RoleChanged)), "{what}: {:?}", r.infos(&id));
        r.host.shutdown();
    }
    // a trusted file with the same hash does not narrow, and neither does a role that is merely different in its own permission
    let (r, slot) = file_rig();
    let base = r.host.find_role("mock-plain-reply", &r.repos()).unwrap();
    let def = file_role(&base, Edit, "h1");
    let id = r.host.start_role(&def, AgentStartRequest { role: "file-role".into(), repo_ids: vec![r.repo.id.clone()], prompt: "go".into(), mode: Some(Automatic), mcp_servers: None }, &r.repos()).unwrap().agent_id;
    set_file_role(&slot, file_role(&base, Edit, "h1"));
    assert_eq!(resume_and_last_start(&r, &id)["role"]["permission"], "automatic");
    r.host.shutdown();
}

#[test]
fn h6_the_kill_switch_resumes_an_unattended_run_in_ask_and_a_listed_bypass_run_still_shows_bypass() {
    let r = Rig::new();
    let id = r.start("mock-plain-reply", Some(Bypass)).agent_id;
    let auto_id = r.start("mock-tool-permission", Some(Automatic)).agent_id;
    r.host.shutdown();
    let mut cfg = config(&r.path("data"), fake());
    cfg.providers = vec!["claude".into(), "mock".into()];
    cfg.no_unattended = true;
    let (host, _sink) = host_with(cfg);
    let listed = host.list();
    assert_eq!(listed.iter().find(|s| s.agent_id == id).unwrap().permission, Bypass, "history shows what was recorded");
    host.send(&auto_id, "again").expect("resume");
    let start = std::fs::read_to_string(r.path("fake-log.jsonl")).unwrap().lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|l| l["type"] == "session/start").last().unwrap()["body"].clone();
    assert_eq!(start["role"]["permission"], "ask", "the kill switch turns an unattended resume into Ask");
    assert_eq!(host.list().iter().find(|s| s.agent_id == auto_id).unwrap().permission, Ask);
    host.shutdown();
}

#[test]
fn h6_a_capped_delegate_is_rebuilt_from_the_current_resolution_when_the_run_resumes() {
    let set = Arc::new(Mutex::new(vec![delegate("repo-role", Edit, false), delegate("plain", Edit, false)]));
    let r = delegating_rig(set.clone());
    let id = r.start("auto", Some(Automatic)).agent_id;
    let capped = |r: &Rig| -> BTreeMap<String, bool> { r.host.context(&id).unwrap().delegates.unwrap().into_iter().map(|(n, rule)| (n, rule.capped)).collect() };
    assert_eq!(capped(&r), BTreeMap::from([("plain".to_string(), false), ("repo-role".to_string(), false)]));
    // the overlay that uncapped the repository role is removed while the run is stopped
    *set.lock().unwrap() = vec![delegate("repo-role", Edit, true), delegate("plain", Edit, false)];
    resume_and_last_start(&r, &id);
    assert_eq!(capped(&r), BTreeMap::from([("plain".to_string(), false), ("repo-role".to_string(), true)]), "held read-only in the resumed unattended run");
    r.host.shutdown();
}

// ---------------------------------------------------------------------------------------------------------------- H-7

#[test]
fn h7_the_requests_mode_wins_over_the_role_an_absent_one_keeps_it_and_the_writer_flag_follows_the_run() {
    let r = Rig::new();
    let researcher = r.start("researcher", Some(Automatic));
    assert_eq!((researcher.permission, researcher.requested.permission), (Automatic, Automatic));
    let start = &r.bodies("session/start")[0];
    assert_eq!((start["role"]["permission"].as_str(), start["writer"].as_bool()), (Some("automatic"), Some(true)), "a read-only role started in automatic runs automatic and writes");
    r.host.interrupt(&researcher.agent_id).ok();
    r.kill_sidecar();

    let r2 = Rig::new();
    let kept = r2.start("researcher", None);
    assert_eq!(kept.permission, ReadOnly, "no mode: the role's own permission, exactly as before");
    assert_eq!(r2.bodies("session/start")[0]["writer"], false);
    r2.host.shutdown();

    for (mode, writer) in [(ReadOnly, false), (Ask, false), (Edit, true), (Automatic, true), (Bypass, true)] {
        let r = Rig::new();
        let id = r.start("mock-plain-reply", Some(mode)).agent_id;
        assert_eq!(r.bodies("session/start")[0]["writer"], writer, "{mode:?}");
        assert_eq!(r.lease_writer(&id), Some(writer), "{mode:?}");
        let ctx = r.host.context(&id).unwrap();
        assert_eq!((ctx.mode, ctx.strict_jail), (mode, mode != Bypass), "{mode:?}: context_for drops the boundary only for Bypass");
        r.host.shutdown();
    }
}

#[test]
fn h7_bypass_needs_the_dialogs_yes_an_unsupported_mode_is_refused_and_the_role_facts_are_recorded() {
    let r = Rig::new();
    let e = r.start_with("mock-plain-reply", Some(Bypass), StartOptions::default()).expect_err("unconfirmed");
    assert_eq!(e.code, "bypassNotConfirmed");
    assert!(r.host.list().is_empty());
    let id = r.start("mock-plain-reply", Some(Bypass)).agent_id;
    let meta = r.host.metas().into_iter().find(|m| m.agent_id == id).unwrap();
    assert_eq!((meta.permission, meta.role_permission, meta.role_hash.clone(), meta.mcp.clone()), (Bypass, Some(ReadOnly), None, Vec::new()), "a built-in role has no file hash, but always a recorded permission");
    r.host.shutdown();

    let (r, _slot) = file_rig();
    let base = r.host.find_role("mock-plain-reply", &r.repos()).unwrap();
    let id = r.host.start_role(&file_role(&base, Edit, "abc"), AgentStartRequest { role: "file-role".into(), repo_ids: vec![r.repo.id.clone()], prompt: "go".into(), mode: Some(Ask), mcp_servers: None }, &r.repos()).unwrap().agent_id;
    let meta = r.host.metas().into_iter().find(|m| m.agent_id == id).unwrap();
    assert_eq!((meta.permission, meta.role_permission, meta.role_hash.as_deref()), (Ask, Some(Edit), Some("abc")), "a file role records its hash and its own permission");
    r.host.shutdown();
}

#[test]
fn h7_the_run_mode_is_a_ceiling_only_for_delegates_the_lead_uses_the_choice() {
    let set = Arc::new(Mutex::new(vec![delegate("dev", Edit, false)]));
    let r = delegating_rig(set);
    // the Auto lead's own default is Edit; the request's Plan wins, and the run is a reader
    let id = r.start("auto", Some(ReadOnly)).agent_id;
    assert_eq!(r.bodies("session/start")[0]["role"]["permission"], "readOnly");
    assert_eq!(r.bodies("session/start")[0]["writer"], false);
    assert_eq!(r.host.context(&id).unwrap().mode, ReadOnly);
    // DelegateRule keeps the role's own mode, so a live switch never rebuilds it
    let rules = r.host.context(&id).unwrap().delegates.unwrap();
    assert_eq!(rules["dev"].mode, Edit);
    r.switch(&id, Automatic).unwrap();
    assert_eq!(r.host.context(&id).unwrap().delegates.unwrap()["dev"].mode, Edit);
    r.host.shutdown();
}

// ---------------------------------------------------------------------------------------------------------------- H-10

#[test]
fn h10_a_claude_run_gets_a_private_plan_directory_it_is_removed_with_a_failed_launch_and_old_ones_are_swept() {
    let r = Rig::new();
    let id = r.start("developer", Some(ReadOnly)).agent_id;
    let dir = r.path("data/plans").join(&id);
    assert!(dir.is_dir(), "created for a Claude run");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700, "private");
    let expected = dir.to_string_lossy().into_owned();
    assert_eq!(r.bodies("session/start")[0]["planDir"].as_str(), Some(expected.as_str()));
    assert_eq!(r.host.context(&id).unwrap().plan_dir.as_deref(), Some(dir.as_path()));
    // a mock run has none
    let mock = r.start("mock-plain-reply", Some(Ask)).agent_id;
    assert!(!r.path("data/plans").join(&mock).exists());
    assert!(r.bodies("session/start")[1].get("planDir").is_none());
    // a launch the sidecar refuses leaves nothing behind
    r.control(json!({"startError": "boom"}));
    let e = r.start_with("developer", Some(Ask), StartOptions::default());
    assert!(e.is_err());
    let left: Vec<String> = std::fs::read_dir(r.path("data/plans")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(left, [id.clone()], "only the live run's directory is left: {left:?}");
    r.host.shutdown();

    // startup sweep: a directory untouched for more than 30 days goes, a fresh one stays
    let plans = r.path("data/plans");
    let old = plans.join("a-old");
    std::fs::create_dir_all(&old).unwrap();
    let long_ago = std::time::SystemTime::now() - Duration::from_secs(31 * 24 * 3600);
    std::fs::File::open(&old).unwrap().set_modified(long_ago).unwrap();
    let mut cfg = config(&r.path("data"), fake());
    cfg.providers = vec!["claude".into(), "mock".into()];
    let (host, _sink) = host_with(cfg);
    assert!(!old.exists(), "swept");
    assert!(dir.exists(), "a recent one is kept");
    host.shutdown();
}

// ---------------------------------------------------------------------------------------------------------------- H-11

fn rules(default_policy: McpPolicy, tools: &[(&str, bool)]) -> McpServerRules {
    McpServerRules { default_policy, tools: tools.iter().map(|(n, ro)| (n.to_string(), McpToolRule { policy: None, read_only: *ro, learned: true })).collect(), fresh: true }
}

type Selections = Arc<Mutex<Vec<McpSelection>>>;

fn mcp_rig(outcome: impl Fn(&McpSelection) -> Result<McpResolved, McpError> + Send + Sync + 'static) -> (Rig, Selections) {
    let seen: Selections = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    let r = Rig::with(move |cfg| {
        cfg.mcp_supplier = Some(Arc::new(move |sel| {
            s.lock().unwrap().push(sel.clone());
            outcome(sel)
        }));
    });
    (r, seen)
}

fn resolved_srv() -> McpResolved {
    McpResolved {
        servers: McpWire::new(json!({"srv": {"type": "stdio", "command": "node", "args": ["server.js"], "env": {"TOKEN": "s3cr3t-value"}}})),
        names: vec!["srv".into()],
        ids: BTreeMap::from([("srv".to_string(), "id-1".to_string())]),
        rules: BTreeMap::from([("srv".to_string(), rules(McpPolicy::Ask, &[("read", true), ("write", false)]))]),
        code_paths: vec![PathBuf::from("/opt/srv/server.js")],
        skipped: Vec::new(),
    }
}

fn start_mcp(r: &Rig, role: &str, ids: Option<Vec<&str>>) -> Result<AgentSummary, EngineError> {
    let def = r.host.find_role(role, &r.repos()).unwrap();
    r.host.start_role_with(&def, AgentStartRequest { role: role.into(), repo_ids: vec![r.repo.id.clone()], prompt: "go".into(), mode: Some(Ask), mcp_servers: ids.map(|v| v.into_iter().map(String::from).collect()) }, &r.repos(), StartOptions::default())
}

/// No file under the state directory holds the value.
fn assert_nowhere_in(dir: &Path, needle: &str) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let p = entry.path();
        if p.is_dir() {
            assert_nowhere_in(&p, needle);
        } else if let Ok(text) = std::fs::read_to_string(&p) {
            assert!(!text.contains(needle), "{} holds a secret", p.display());
        }
    }
}

#[test]
fn h11_a_run_without_a_selection_starts_no_server_and_a_selection_reaches_the_session_the_context_and_meta() {
    let (r, seen) = mcp_rig(|_| Ok(resolved_srv()));
    let none = start_mcp(&r, "mock-plain-reply", None).unwrap();
    assert!(seen.lock().unwrap().is_empty(), "None means no MCP at all: the supplier is not even asked");
    assert!(r.bodies("session/start")[0].get("mcp").is_none());
    assert!(none.mcp.is_empty());
    r.host.shutdown();

    let (r, seen) = mcp_rig(|_| Ok(resolved_srv()));
    let s = start_mcp(&r, "mock-plain-reply", Some(vec!["id-1"])).unwrap();
    let sel = seen.lock().unwrap()[0].clone();
    assert_eq!((sel.ids.clone(), sel.strict), (vec!["id-1".to_string()], true), "a new run is strict");
    assert!(sel.run_dirs.contains(&r.repo.path), "{:?}", sel.run_dirs);
    assert_eq!(r.bodies("session/start")[0]["mcp"]["srv"]["env"]["TOKEN"], "s3cr3t-value", "the secret leaves the host only in session/start");
    let ctx = r.host.context(&s.agent_id).unwrap();
    assert_eq!(ctx.mcp_servers, ["srv"]);
    assert_eq!(ctx.mcp_tools["srv"].default_policy, McpPolicy::Ask);
    assert_eq!(ctx.mcp_code_paths, [PathBuf::from("/opt/srv/server.js")]);
    assert_eq!(r.disk_meta(&s.agent_id)["mcp"], json!(["id-1"]), "ids, not names, are persisted");
    assert_eq!((s.mcp.len(), s.mcp[0].name.as_str(), s.mcp[0].exposed, s.mcp[0].has_secret_env), (1, "srv", 1, true), "{:?}", s.mcp);
    assert_nowhere_in(&r.path("data"), "s3cr3t-value");
    r.host.shutdown();
}

#[test]
fn h11_a_resume_recomputes_the_set_from_the_persisted_ids_and_skips_what_vanished() {
    let flip = Arc::new(Mutex::new(false));
    let f = flip.clone();
    let (r, seen) = mcp_rig(move |_| {
        if *f.lock().unwrap() {
            // the server was removed in Settings since the start: skipped, not an error
            return Ok(McpResolved { servers: McpWire::new(Value::Null), names: Vec::new(), ids: BTreeMap::new(), rules: BTreeMap::new(), code_paths: Vec::new(), skipped: vec![intely_agent_core::mcp::McpSkipped { id: "id-1".into(), name: "srv".into(), reason: "mcpUnknownServer".into() }] });
        }
        Ok(resolved_srv())
    });
    let id = start_mcp(&r, "mock-plain-reply", Some(vec!["id-1"])).unwrap().agent_id;
    resume_and_last_start(&r, &id);
    let sel = seen.lock().unwrap().last().unwrap().clone();
    assert_eq!((sel.ids, sel.strict), (vec!["id-1".to_string()], false), "the persisted list, not the workspace defaults, and not strict");
    assert!(r.host.context(&id).unwrap().mcp_servers == ["srv"]);
    *flip.lock().unwrap() = true;
    let start = resume_and_last_start(&r, &id);
    assert!(start.get("mcp").is_none(), "nothing left to start");
    assert!(r.host.context(&id).unwrap().mcp_servers.is_empty() && r.host.list()[0].mcp.is_empty());
    assert_eq!(r.disk_meta(&id)["mcp"], json!(["id-1"]), "the selection itself is kept");
    r.host.shutdown();
}

#[test]
fn h11_a_supplier_error_fails_the_start_before_any_session_exists_and_carries_no_secret() {
    let (r, _) = mcp_rig(|_| Err(McpError { code: "confirmationRequired".into(), message: "server srv has not been confirmed".into() }));
    let e = start_mcp(&r, "mock-plain-reply", Some(vec!["id-1"])).expect_err("refused");
    assert_eq!((e.code.as_str(), e.message.as_str()), ("confirmationRequired", "server srv has not been confirmed"));
    assert!(r.bodies("session/start").is_empty(), "no session was opened");
    assert!(r.host.list().is_empty(), "no run was left behind");
    r.host.shutdown();

    // no supplier in this build
    let r = Rig::new();
    let e = start_mcp(&r, "mock-plain-reply", Some(vec!["id-1"])).expect_err("no supplier");
    assert_eq!(e.code, "mcpUnavailable");
    assert!(start_mcp(&r, "mock-plain-reply", Some(vec![])).is_ok(), "an empty selection never needs one");
    r.host.shutdown();
}

#[test]
fn h11_tighten_mcp_applies_only_stricter_rules_withdraws_what_became_a_denial_and_advances_the_epoch() {
    let updates: Arc<Mutex<Vec<(String, Option<McpServerRules>)>>> = Arc::new(Mutex::new(Vec::new()));
    let u = updates.clone();
    let r = Rig::with(move |cfg| {
        cfg.mcp_supplier = Some(Arc::new(|_| Ok(resolved_srv())));
        cfg.mcp_rules = Some(Arc::new(move |pairs| {
            u.lock().unwrap().iter().filter(|(id, _)| pairs.iter().any(|(i, _)| i == id)).map(|(id, rules)| intely_agent_core::mcp::McpRuleUpdate { id: id.clone(), rules: rules.clone() }).collect()
        }));
    });
    let id = start_mcp(&r, "mock-plain-reply", Some(vec!["id-1"])).unwrap().agent_id;
    let tool = json!({"class": "mcp", "tool": "mcp__srv__write", "server": "srv", "summary": "srv.write"});
    r.card(&id, "m1", tool.clone(), &["allow_once", "deny"]);
    let told = r.mode_messages().len();

    // a loosening (Allow as the default) changes nothing
    updates.lock().unwrap().push(("id-1".into(), Some(rules(McpPolicy::Allow, &[("read", true), ("write", false)]))));
    assert_eq!(r.host.tighten_mcp(), 0);
    assert_eq!(r.host.context(&id).unwrap().mcp_tools["srv"].default_policy, McpPolicy::Ask);
    assert_eq!(r.mode_messages().len(), told);

    // a Deny applies at once, advances the sidecar's decision epoch with the UNCHANGED mode, and withdraws a card the policy now denies
    updates.lock().unwrap().clear();
    updates.lock().unwrap().push(("id-1".into(), Some(rules(McpPolicy::Deny, &[("read", true), ("write", false)]))));
    assert_eq!(r.host.tighten_mcp(), 1);
    assert_eq!(r.host.context(&id).unwrap().mcp_tools["srv"].default_policy, McpPolicy::Deny);
    wait_until(10, "the epoch message", || r.mode_messages().len() == told + 1);
    assert_eq!(r.mode_messages().last().unwrap(), "ask", "the mode itself is unchanged");
    if verdict(&r, &id, &tool) == Decision::Deny {
        r.resolved(&id, "m1");
        assert_eq!(r.answers("m1")[0]["message"], RULES_CHANGED);
    } else {
        eprintln!("NOTE: decide_mcp does not use the per-tool policy yet (policy builder); the card was left alone");
        assert!(r.answers("m1").is_empty());
    }
    // a server removed in Settings is denied outright
    updates.lock().unwrap().clear();
    updates.lock().unwrap().push(("id-1".into(), None));
    r.host.tighten_mcp();
    let after = r.host.context(&id).unwrap().mcp_tools["srv"].clone();
    assert_eq!((after.default_policy, after.tools.len(), after.fresh), (McpPolicy::Deny, 0, false));
    assert_eq!(r.host.list()[0].mcp[0].exposed, 0, "the exposure follows");
    r.host.shutdown();
}

// ------------------------------------------------------------------------------------------------------ chip and lease

#[test]
fn the_enforcement_chip_of_every_writing_mode_is_the_write_side_of_the_provider_and_plan_keeps_the_read_side() {
    let r = Rig::new();
    std::fs::create_dir_all(r.path("data")).unwrap();
    std::fs::write(
        r.path("data/enforcement.json"),
        r#"{"runs":[
          {"key":{"adapter":"claude-sdk","authMode":"subscription","roleMode":"readOnly","cliVersion":"2.1.284"},"suites":{"t0":"notRun","s0":"pass","s1":"pass","s2":"notRun","s3":"notRun","s4":"notRun"},"layersProven":[],"at":1},
          {"key":{"adapter":"claude-sdk","authMode":"subscription","roleMode":"edit","cliVersion":"2.1.284"},"suites":{"t0":"notRun","s0":"notRun","s1":"notRun","s2":"notRun","s3":"notRun","s4":"notRun"},"layersProven":[],"at":1}]}"#,
    )
    .unwrap();
    let chips = r.host.enforcement();
    let side = |read_only: bool| chips.iter().find(|(p, ro, _)| p == "claude" && *ro == read_only).map(|(_, _, c)| c.tier).expect("both sides recorded");
    let (read_side, write_side) = (side(true), side(false));
    assert_ne!(read_side, write_side, "the fixture records two different tiers");
    let first = r.start("developer", Some(ReadOnly));
    assert_eq!(first.enforcement, read_side, "Plan reads like a read-only role");
    for mode in [Ask, Edit, Automatic, Bypass] {
        let s = r.switch(&first.agent_id, mode).unwrap();
        assert_eq!(s.enforcement, write_side, "{mode:?}: everything that can change files shares the write-side chip");
    }
    assert_eq!(r.switch(&first.agent_id, ReadOnly).unwrap().enforcement, read_side, "and back");
    r.host.shutdown();
}
