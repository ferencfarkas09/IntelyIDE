//! An ACP provider (`gemini`) through the real sidecar bundle, the policy broker and the event log, against the scripted
//! fake ACP agent (sidecar/tests/fakes). No CLI, no model call, no Tauri. Protocol evidence only: a fake proves our handling,
//! not the vendor's behaviour, so the provider stays `weak` and only the scripted roles may write.

mod common;

use std::path::{Path, PathBuf};

use common::*;
use intely_agent_core::api::{AgentStartRequest, PermissionDecision};
use intely_agent_core::events::types::EventKind;
use intely_agent_core::providers::PermissionMode;
use intely_agent_host::{roles, AcpMock, AgentHost, HostConfig, RepoRef, StartOptions};

fn fakes() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sidecar/tests/fakes")
}

fn acp_config(data: &Path) -> HostConfig {
    let mut cfg = config(data, sidecar_js());
    cfg.providers.push("gemini".into());
    cfg.acp_mock = Some(AcpMock { provider: "gemini".into(), agent_js: fakes().join("fake-acp-agent.mjs"), scripts_dir: fakes().join("acp-scripts") });
    cfg
}

fn start(host: &AgentHost, role: &str, repo: &RepoRef) -> Result<intely_agent_core::api::AgentSummary, intely_core::EngineError> {
    host.start(AgentStartRequest { role: role.into(), repo_ids: vec![repo.id.clone()], prompt: "go".into(), mode: None, mcp_servers: None }, std::slice::from_ref(repo))
}

fn texts(events: &[intely_agent_core::events::types::AgentEvent]) -> String {
    events.iter().filter_map(|e| if let EventKind::TextDone { text, .. } = &e.kind { Some(text.as_str()) } else { None }).collect::<Vec<_>>().join("\n")
}

#[test]
fn a_permission_request_of_the_acp_agent_reaches_the_user_and_the_answer_goes_back() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let (host, sink) = host_with(acp_config(&dir.path().join("data")));
    let summary = start(&host, "mock-acp-asks-command", &repo).expect("start");
    assert_eq!(summary.provider, "gemini");
    assert_eq!(format!("{:?}", summary.enforcement), "Weak", "no suite was recorded for the fake");
    let req = sink.wait_kind(&summary.agent_id, "permission.request");
    let EventKind::PermissionRequest { req_id, .. } = &req.kind else { unreachable!() };
    host.answer_permission(&summary.agent_id, req_id, PermissionDecision::AllowOnce).expect("answer");
    sink.wait_turn_end(&summary.agent_id);
    let events = sink.of(&summary.agent_id);
    assert!(texts(&events).contains("answer=selected:"), "the agent was told the outcome: {}", texts(&events));
    assert!(has_kind(&events, "session.started") && has_kind(&events, "permission.resolved"));
    host.shutdown();
}

#[test]
fn a_terminal_git_push_of_the_acp_agent_is_refused_and_the_remote_stays_empty() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let remote = dir.path().join("remote.git");
    git(dir.path(), &["init", "-q", "--bare", remote.to_str().unwrap()]);
    git(&repo.path, &["remote", "add", "origin", remote.to_str().unwrap()]);
    let (host, sink) = host_with(acp_config(&dir.path().join("data")));
    let id = start(&host, "mock-acp-terminal-git-push", &repo).expect("start").agent_id;
    sink.wait_turn_end(&id);
    let events = sink.of(&id);
    let said = texts(&events);
    assert!(said.contains("blocked by policy") && said.contains("git push is human-only"), "the hard stop is what refused it: {said}");
    assert_eq!(git(&remote, &["for-each-ref"]), "", "nothing reached the remote");
    host.shutdown();
}

#[test]
fn a_write_role_is_refused_on_a_provider_below_the_write_tier_but_a_read_only_role_runs() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let cfg = acp_config(&dir.path().join("data"));
    let (host, sink) = host_with(cfg.clone());
    let mut edit = roles::builtin(&cfg).into_iter().find(|r| r.name == "mock-plain-reply").unwrap();
    edit.permission = PermissionMode::Edit;
    edit.mock_scenario = None;
    let req = || AgentStartRequest { role: edit.name.clone(), repo_ids: vec![repo.id.clone()], prompt: "go".into(), mode: None, mcp_servers: None };
    let refused = host.start_role_with(&edit, req(), std::slice::from_ref(&repo), StartOptions { provider: Some("gemini".into()), ..Default::default() }).expect_err("a write role on a weak provider");
    assert_eq!(refused.code, "providerReadOnly", "{}", refused.message);
    assert!(host.list().is_empty(), "a refused start leaves no run behind");

    edit.permission = PermissionMode::ReadOnly;
    let run = host.start_role_with(&edit, req(), std::slice::from_ref(&repo), StartOptions { provider: Some("gemini".into()), ..Default::default() }).expect("a read-only role goes");
    assert_eq!(run.provider, "gemini");
    sink.wait_turn_end(&run.agent_id);
    assert!(texts(&sink.of(&run.agent_id)).contains("Hello from the ACP fake."));
    host.shutdown();
}
