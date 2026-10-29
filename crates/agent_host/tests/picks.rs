//! The New run picker: the model, effort and ultracode of one run over its role's, recorded with the run and kept by a resume and a
//! restart of the IDE. Ultracode opens the `Workflow` tool for that run only (the policy context says so), never for Auto or another
//! provider, and the hard stops still hold for a workflow's helper agents.

mod common;

use common::*;
use intely_agent_core::api::AgentStartRequest;
use intely_agent_core::events::types::DecidedBy;
use intely_agent_core::policy::decide::{decide, Decision};
use intely_agent_core::policy::intent::{Actor, PolicyRequest, ToolIntent};
use intely_agent_core::providers::{Effort, PermissionMode};
use intely_agent_host::roles::{self, RoleDef, CLAUDE_DISALLOWED, WORKFLOW_TOOL};
use intely_agent_host::{RepoRef, RunPicks};
use serde_json::json;

fn req(role: &str, repo: &RepoRef) -> AgentStartRequest {
    AgentStartRequest { role: role.into(), repo_ids: vec![repo.id.clone()], prompt: "go".into(), ..Default::default() }
}

fn workflow(actor: Option<&str>) -> PolicyRequest {
    let mut intent = ToolIntent::from_claude_tool("Workflow", &json!({"script": "export const meta = { name: 'x' }\nawait agent('fix')"}));
    intent.actor = actor.map(|a| Actor { agent_id: a.into(), role: "workflow-agent".into() });
    PolicyRequest { agent_id: "a".into(), tool_id: "t".into(), provider: "claude".into(), intent }
}

fn helper_bash(cmd: &str) -> PolicyRequest {
    let mut intent = ToolIntent::from_claude_tool("Bash", &json!({ "command": cmd }));
    intent.actor = Some(Actor { agent_id: "wf-1".into(), role: "workflow-agent".into() });
    PolicyRequest { agent_id: "a".into(), tool_id: "t".into(), provider: "claude".into(), intent }
}

#[test]
fn the_picks_are_recorded_shown_and_kept_by_a_restart_and_a_resume() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let cfg = config(&dir.path().join("data"), sidecar_js());
    let (host, sink) = host_with(cfg.clone());
    let picked = AgentStartRequest { model: Some(" claude-next-9 ".into()), effort: Some(Effort::Max), ultracode: Some(true), mode: Some(PermissionMode::Automatic), ..req("mock-plain-reply", &repo) };
    let s = host.start(picked, std::slice::from_ref(&repo)).expect("start");
    assert_eq!(s.model, "claude-next-9", "an id this build does not know passes through (trimmed)");
    assert_eq!((s.requested.effort, s.requested.ultracode), (Some(Effort::Max), Some(true)));
    sink.wait_turn_end(&s.agent_id);
    let meta = host.metas().into_iter().find(|m| m.agent_id == s.agent_id).unwrap();
    assert_eq!(meta.picks, RunPicks { model: Some("claude-next-9".into()), effort: Some(Effort::Max), ultracode: true });
    let ctx = host.context(&s.agent_id).unwrap();
    assert!(ctx.ultracode);
    assert_eq!(decide(&ctx, &workflow(None)).decision, Decision::Allow, "the lead may start a workflow");
    host.shutdown();

    // a restart of the IDE: the run is read back from its meta file with the same picks, and a follow-up resumes it with them
    let (host, sink) = host_with(cfg);
    let listed = host.list().into_iter().find(|r| r.agent_id == s.agent_id).expect("listed after the restart");
    assert_eq!((listed.model.as_str(), listed.requested.ultracode), ("claude-next-9", Some(true)));
    assert!(host.context(&s.agent_id).unwrap().ultracode, "the restored policy context keeps ultracode");
    let last = sink.of(&s.agent_id).last().map_or(0, |e| e.seq);
    host.send(&s.agent_id, "again").expect("resume");
    sink.wait(&s.agent_id, "the resumed turn", 20, |e| e.seq > last && e.kind.name() == "turn.end");
    let after = host.list().into_iter().find(|r| r.agent_id == s.agent_id).unwrap();
    assert_eq!((after.model.as_str(), after.requested.effort, after.requested.ultracode), ("claude-next-9", Some(Effort::Max), Some(true)));
    host.shutdown();
}

#[test]
fn an_untouched_picker_changes_nothing_and_workflow_stays_refused() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let (host, sink) = host_with(config(&dir.path().join("data"), sidecar_js()));
    let s = host.start(AgentStartRequest { mode: Some(PermissionMode::Automatic), ..req("mock-plain-reply", &repo) }, std::slice::from_ref(&repo)).expect("start");
    assert_eq!((s.model.as_str(), s.requested.ultracode), ("mock-1", None));
    sink.wait_turn_end(&s.agent_id);
    assert_eq!(host.metas()[0].picks, RunPicks::default());
    let meta_file = std::fs::read_to_string(dir.path().join("data/runs").join(format!("{}.meta.json", s.agent_id))).unwrap();
    assert!(!meta_file.contains("picks"), "a run without picks is stored exactly as before");
    let ctx = host.context(&s.agent_id).unwrap();
    assert!(!ctx.ultracode);
    let d = decide(&ctx, &workflow(None));
    assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("other.state-change")));
    host.shutdown();
}

#[test]
fn ultracode_is_refused_for_auto_and_other_providers_and_a_bad_model_id_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let cfg = config(&dir.path().join("data"), sidecar_js());
    let (host, _sink) = host_with(cfg.clone());
    let repos = std::slice::from_ref(&repo);
    let ultra = |role: &str| AgentStartRequest { ultracode: Some(true), ..req(role, &repo) };
    let auto = roles::auto_role(&cfg);
    assert_eq!(host.start_role(&auto, ultra("auto"), repos).unwrap_err().code, "ultracodeAuto");
    let mut other = host.find_role("mock-plain-reply", repos).unwrap();
    other.provider = "gemini".into();
    assert_eq!(host.start_role(&other, ultra("mock-plain-reply"), repos).unwrap_err().code, "ultracodeProvider");
    for bad in ["--settings=/tmp/x", "claude opus", "claude-\u{0}", &"x".repeat(200)] {
        let r = AgentStartRequest { model: Some(bad.into()), ..req("mock-plain-reply", &repo) };
        assert_eq!(host.start(r, repos).unwrap_err().code, "invalidModel", "{bad:?}");
    }
    assert!(host.list().is_empty(), "a refused start leaves nothing behind");
    host.shutdown();
}

#[test]
fn ultracode_takes_workflow_off_a_claude_role_deny_list_only_for_that_run() {
    let base = RoleDef {
        name: "developer".into(),
        description: "d".into(),
        provider: "claude".into(),
        model: "claude-sonnet-5-5".into(),
        effort: Some(Effort::Medium),
        permission: PermissionMode::Edit,
        system_prompt: None,
        tools: Vec::new(),
        disallowed_tools: CLAUDE_DISALLOWED.iter().map(|t| t.to_string()).collect(),
        max_turns: None,
        mock_scenario: None,
        all_repos: false,
        file: None,
    };
    assert_eq!(base.with_picks(&RunPicks::default()).disallowed_tools, base.disallowed_tools, "no pick: unchanged");
    let picked = base.with_picks(&RunPicks { model: Some("claude-opus-5-5".into()), effort: Some(Effort::Xhigh), ultracode: true });
    assert_eq!((picked.model.as_str(), picked.effort), ("claude-opus-5-5", Some(Effort::Xhigh)));
    assert!(!picked.disallowed_tools.iter().any(|t| t == WORKFLOW_TOOL));
    assert!(picked.disallowed_tools.iter().any(|t| t == "RemoteTrigger") && picked.disallowed_tools.iter().any(|t| t == "SendMessage"), "only Workflow is lifted");
    assert!(picked.tools.is_empty(), "an empty list stays the provider's default set (the sidecar adds Workflow to it)");
    let listed = RoleDef { tools: vec!["Read".into(), "Bash".into()], ..base.clone() }.with_picks(&RunPicks { ultracode: true, ..Default::default() });
    assert_eq!(listed.tools, ["Read", "Bash", WORKFLOW_TOOL]);
    assert!(base.disallowed_tools.iter().any(|t| t == WORKFLOW_TOOL), "the role itself is not changed");
    assert!(roles::valid_model_id("claude-opus-5-5[1m]") && roles::valid_model_id("us.anthropic.claude-x:0") && !roles::valid_model_id("-x"));
}

#[test]
fn a_workflow_helper_agent_cannot_commit_or_push_in_an_ultracode_run_in_bypass() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let (host, sink) = host_with(config(&dir.path().join("data"), sidecar_js()));
    let s = host
        .start_role_with(
            &host.find_role("mock-plain-reply", std::slice::from_ref(&repo)).unwrap(),
            AgentStartRequest { ultracode: Some(true), mode: Some(PermissionMode::Bypass), ..req("mock-plain-reply", &repo) },
            std::slice::from_ref(&repo),
            intely_agent_host::StartOptions { bypass_confirmed: true, ..Default::default() },
        )
        .expect("start");
    sink.wait_turn_end(&s.agent_id);
    let ctx = host.context(&s.agent_id).unwrap();
    assert_eq!((ctx.mode, ctx.ultracode), (PermissionMode::Bypass, true));
    for cmd in ["git commit -am wip", "git push origin HEAD", "git -C . push --force", "git add -A"] {
        let d = decide(&ctx, &helper_bash(cmd));
        assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop), "{cmd}");
    }
    assert_eq!(decide(&ctx, &workflow(Some("wf-1"))).decision, Decision::Deny, "a helper agent cannot start another workflow");
    host.shutdown();
}
