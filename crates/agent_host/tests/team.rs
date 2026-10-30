//! Team mode (New run, more than one agent): Agent 1 leads, the others work for it. Against the fake sidecar of
//! `tests/common/fake-sidecar-modes.mjs`, which logs every `session/start` body. No CLI, no model call, no Tauri.
//!
//! What must hold: only a worker loses `AskUserQuestion` (policy list and SDK list), the team instructions ride in the system prompt, a
//! worker never gets more than its mode gives, a bad team shape or a lead that is not a run is refused, and the team survives on disk.

#![cfg(unix)]
mod common;

use std::path::PathBuf;

use common::*;
use intely_agent_core::api::{AgentStartRequest, AgentSummary};
use intely_agent_core::providers::PermissionMode;
use intely_agent_host::roles::{apply_team, team_deny, team_prompt};
use intely_agent_host::{AgentHost, HostConfig, RepoRef, StartOptions, TeamRun};
use intely_core::EngineError;
use serde_json::Value;

struct Rig {
    dir: tempfile::TempDir,
    repo: RepoRef,
    host: AgentHost,
}

impl Rig {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repo = fixture_repo(dir.path());
        let mut cfg: HostConfig = config(&dir.path().join("data"), PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/common/fake-sidecar-modes.mjs"));
        cfg.providers = vec!["claude".into(), "mock".into()];
        cfg.claude_bin = Some(PathBuf::from("/bin/echo"));
        let (host, _sink) = host_with(cfg);
        Self { dir, repo, host }
    }

    fn start(&self, team: Option<TeamRun>) -> Result<AgentSummary, EngineError> {
        let repos = vec![self.repo.clone()];
        let def = self.host.find_role("developer", &repos).expect("role");
        let req = AgentStartRequest { role: "developer".into(), repo_ids: vec![self.repo.id.clone()], prompt: "go".into(), mode: Some(PermissionMode::Edit), mcp_servers: None, ..Default::default() };
        self.host.start_role_with(&def, req, &repos, StartOptions { team, ..Default::default() })
    }

    /// The `session/start` bodies the fake logged, in order.
    fn starts(&self) -> Vec<Value> {
        let log = std::fs::read_to_string(self.dir.path().join("fake-log.jsonl")).unwrap_or_default();
        log.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|l| l["type"] == "session/start").map(|l| l["body"].clone()).collect()
    }
}

fn lead() -> TeamRun {
    TeamRun { index: 1, of: 3, lead_id: None }
}

fn worker(lead_id: &str, index: u32) -> TeamRun {
    TeamRun { index, of: 3, lead_id: Some(lead_id.into()) }
}

fn denied(body: &Value) -> Vec<String> {
    body["role"]["disallowedTools"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default()
}

#[test]
fn only_a_worker_loses_ask_user_question() {
    let mut deny = vec!["Bash".to_string()];
    team_deny(&lead(), &mut deny);
    assert_eq!(deny, ["Bash"]);
    team_deny(&worker("a1", 2), &mut deny);
    team_deny(&worker("a1", 2), &mut deny);
    assert_eq!(deny, ["Bash", "AskUserQuestion"], "added once, nothing else touched");
}

#[test]
fn the_instructions_name_the_roles_and_keep_the_role_prompt() {
    let lead_note = team_prompt(&lead());
    assert!(lead_note.contains("Agent 1 of 3") && lead_note.contains("only run that may ask the user") && lead_note.contains("peer_send") && lead_note.contains("ONE combined summary"));
    let w = team_prompt(&worker("run-42", 2));
    assert!(w.contains("Agent 2 of 3") && w.contains("run-42") && w.contains("AskUserQuestion is not available") && w.contains("peer_send") && w.contains("grant nothing"));
    let mut role = intely_agent_core::sidecar::ResolvedRole {
        name: "developer".into(),
        model: "m".into(),
        effort: None,
        permission: PermissionMode::Edit,
        system_prompt: Some("Role text.".into()),
        tools: Vec::new(),
        disallowed_tools: vec!["RemoteTrigger".into()],
        max_turns: None,
        max_budget_usd: None,
        ultracode: None,
    };
    apply_team(&mut role, &worker("run-42", 2));
    assert!(role.system_prompt.as_deref().unwrap().starts_with("Role text.\n\nTEAM MODE."));
    assert_eq!(role.disallowed_tools, ["RemoteTrigger", "AskUserQuestion"]);
    role.system_prompt = None;
    apply_team(&mut role, &lead());
    assert!(role.system_prompt.as_deref().unwrap().starts_with("TEAM MODE."));
    assert_eq!(role.disallowed_tools, ["RemoteTrigger", "AskUserQuestion"], "a lead keeps what it had and gets nothing more taken");
}

#[test]
fn the_team_shape_is_checked() {
    assert!(lead().is_valid() && worker("a", 3).is_valid());
    assert!(!TeamRun { index: 1, of: 1, lead_id: None }.is_valid());
    assert!(!TeamRun { index: 2, of: 3, lead_id: None }.is_valid(), "a lead is Agent 1");
    assert!(!worker("a", 1).is_valid(), "Agent 1 has no lead");
    assert!(!worker("a", 4).is_valid(), "past the end");
}

#[test]
fn a_lead_then_workers_start_with_the_right_prompts_and_tools() {
    let rig = Rig::new();
    let l = rig.start(Some(lead())).expect("lead");
    let w = rig.start(Some(worker(&l.agent_id, 2))).expect("worker");
    let solo = rig.start(None).expect("solo");
    let starts = rig.starts();
    assert_eq!(starts.len(), 3);
    let of = |id: &str| starts.iter().find(|b| b["agentId"] == id).unwrap().clone();
    let (lb, wb, sb) = (of(&l.agent_id), of(&w.agent_id), of(&solo.agent_id));
    assert!(!denied(&lb).contains(&"AskUserQuestion".to_string()), "the lead may ask the user");
    assert!(lb["role"]["systemPrompt"].as_str().unwrap().contains("Agent 1 of 3"));
    assert!(denied(&wb).contains(&"AskUserQuestion".to_string()));
    assert!(wb["role"]["systemPrompt"].as_str().unwrap().contains(&l.agent_id));
    // an independent run is exactly what it was: no note, nothing denied
    assert!(!denied(&sb).contains(&"AskUserQuestion".to_string()));
    assert!(!sb["role"]["systemPrompt"].as_str().unwrap_or_default().contains("TEAM MODE"));
    // the mode (the only authority on rights) is the same for all three
    assert!([&lb, &wb, &sb].iter().all(|b| b["role"]["permission"] == "edit"));
}

#[test]
fn a_bad_team_or_an_unknown_lead_is_refused_before_anything_starts() {
    let rig = Rig::new();
    assert_eq!(rig.start(Some(TeamRun { index: 2, of: 3, lead_id: None })).unwrap_err().code, "invalidTeam");
    assert_eq!(rig.start(Some(worker("no-such-run", 2))).unwrap_err().code, "unknownLead");
    assert!(rig.starts().is_empty(), "no session was opened");
}

#[test]
fn the_team_is_kept_in_the_meta_file() {
    let rig = Rig::new();
    let l = rig.start(Some(lead())).expect("lead");
    let w = rig.start(Some(worker(&l.agent_id, 2))).expect("worker");
    let solo = rig.start(None).expect("solo");
    let meta = |id: &str| -> Value { serde_json::from_slice(&std::fs::read(rig.dir.path().join("data/runs").join(format!("{id}.meta.json"))).unwrap()).unwrap() };
    assert_eq!(meta(&w.agent_id)["team"], serde_json::json!({"index": 2, "of": 3, "leadId": l.agent_id}));
    assert_eq!(meta(&l.agent_id)["team"], serde_json::json!({"index": 1, "of": 3}));
    assert!(meta(&solo.agent_id).get("team").is_none(), "an independent run writes the same file as before");
}
