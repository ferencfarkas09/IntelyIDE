//! A run whose folder is the home directory: the run-wide choice is never offered or taken. Its own test binary, because it sets `HOME`.
//! Against the fake sidecar of `tests/common/fake-sidecar-modes.mjs`: no CLI, no model call, no Tauri.

#![cfg(unix)]
#![allow(unused_imports, dead_code)]
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
fn a_run_whose_folder_is_the_home_directory_takes_only_a_once_answer() {
    let r = Rig::new(true);
    // the run's folder IS the home directory (set before any run starts; this binary has no other test)
    std::env::set_var("HOME", &r.repo.path);
    let id = r.start(Automatic).agent_id;
    let env = r.env();
    let intent = json!({"class": "read", "tool": "Read", "paths": [env], "summary": "Read .env"});
    // a card as an older gate would send it (offering the run-wide choice): the host judges again and refuses it
    r.card(&id, "p1", intent, json!({"kind": "secretFile", "rule": "read.never-read", "scope": env, "repo": r.repo.path.to_string_lossy()}));
    assert_eq!(code(r.click_broad(&id, "p1", PermissionDecision::AllowRun)), "runWideNotAllowed");
    assert!(r.host.context(&id).unwrap().stop_grants.is_empty());
    r.click(&id, "p1", PermissionDecision::AllowOnce).expect("once is still offered");
    assert_eq!(r.answers("p1")[0]["grant"], "once");
    r.host.shutdown();
}
