//! The host side of delegation ((design notes: roles-orchestration-spec) 4.2, 4.3, 8.2) against a fake sidecar that records every
//! `session/start` and asks the real policy about parallel calls: the Auto session start, the kill switches and the minimum CLI,
//! the shared delegation counter, the actor-judged calls, the canary, resume.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use intely_agent_core::api::AgentStartRequest;
use intely_agent_core::delegates::{DelegateDef, DelegateScope, DelegateSet, ExcludeReason, ExcludedDelegate};
use intely_agent_core::providers::{Effort, PermissionMode};
use intely_agent_host::roles::{auto_role, version_at_least, DELEGATION_CANARY_MARK, MIN_CLI_FOR_DELEGATION};
use intely_agent_host::{AgentDefaults, AgentHost, HostConfig, RepoRef};
use intely_agent_core::delegates::DelegateSpec;
use serde_json::{json, Value};

fn fake() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/common/fake-sidecar-delegation.mjs")
}

fn def(name: &str, permission: PermissionMode, tools: &[&str]) -> DelegateDef {
    DelegateDef {
        spec: DelegateSpec {
            name: name.into(),
            description: format!("The {name} role"),
            prompt: format!("PREAMBLE\n\nYou are {name}."),
            model: if permission == PermissionMode::ReadOnly { "claude-haiku-4-5-20251001".into() } else { "claude-sonnet-5-5".into() },
            effort: (permission != PermissionMode::ReadOnly).then_some(Effort::Medium),
            permission,
            tools: tools.iter().map(|t| t.to_string()).collect(),
            disallowed_tools: vec!["RemoteTrigger".into(), "Agent".into(), "Task".into()],
            max_turns: Some(25),
            scope: DelegateScope::Global,
            color: None,
        },
        source: format!("/roles/{name}.md"),
        capped: false,
    }
}

struct Rig {
    cfg: HostConfig,
    roles: Arc<Mutex<Vec<DelegateDef>>>,
    defaults: Arc<Mutex<AgentDefaults>>,
    version: Arc<Mutex<Option<String>>>,
}

fn rig(data: &Path) -> Rig {
    let roles = Arc::new(Mutex::new(vec![def("researcher", PermissionMode::ReadOnly, &["Read", "Grep", "Glob"]), def("dev", PermissionMode::Edit, &[])]));
    let defaults = Arc::new(Mutex::new(AgentDefaults { model: "claude-haiku-4-5-20251001".into(), effort: None, delegation_cap: 3, ..AgentDefaults::default() }));
    let version = Arc::new(Mutex::new(None));
    let mut cfg = config(data, fake());
    cfg.providers = vec!["claude".into(), "mock".into()];
    cfg.claude_bin = Some(PathBuf::from("/bin/echo"));
    let r = roles.clone();
    cfg.delegate_resolver = Some(Arc::new(move |_repos| DelegateSet {
        included: r.lock().unwrap().clone(),
        excluded: vec![ExcludedDelegate { name: "hidden-one".into(), reason: ExcludeReason::Hidden }],
    }));
    let d = defaults.clone();
    cfg.agent_defaults = Some(Arc::new(move || d.lock().unwrap().clone()));
    let v = version.clone();
    cfg.cli_version = Some(Arc::new(move |p| if p == "claude" { v.lock().unwrap().clone() } else { None }));
    Rig { cfg, roles, defaults, version }
}

fn wait_file(path: &Path, secs: u64) -> Value {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(v) = serde_json::from_str(&text) {
                return v;
            }
        }
        assert!(Instant::now() < deadline, "the fake sidecar wrote nothing to {}", path.display());
        std::thread::sleep(Duration::from_millis(40));
    }
}

fn agent_intent(role: Option<&str>, subagent: &str) -> Value {
    let mut i = json!({"class":"other","tool":"Agent","paths":[],"subagentType":subagent,"subagentFlags":{"hasModel":false,"background":false,"subagentType":subagent},"summary":"Agent"});
    if let Some(r) = role {
        i["actor"] = json!({"agentId": "sub-1", "role": r});
    }
    i
}

fn job(out: &Path, asks: Vec<Value>, events: Vec<Value>) -> String {
    json!({"out": out, "asks": asks, "events": events}).to_string()
}

fn start(host: &AgentHost, role: &str, repo: &RepoRef, prompt: String) -> intely_agent_core::api::AgentSummary {
    host.start(AgentStartRequest { role: role.into(), repo_ids: vec![repo.id.clone()], prompt, mode: None, mcp_servers: None }, std::slice::from_ref(repo)).expect("start")
}

fn keys(v: &Value) -> Vec<String> {
    let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    k.sort();
    k
}

#[test]
fn a_claude_single_role_session_start_is_unchanged_and_carries_no_delegates() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let out = dir.path().join("out.json");
    let r = rig(&dir.path().join("data"));
    let (host, _sink) = host_with(r.cfg);
    start(&host, "developer", &repo, job(&out, vec![], vec![]));
    let body = &wait_file(&out, 20)["starts"][0];
    assert_eq!(keys(body), ["addDirs", "agentId", "auth", "cwd", "env", "nextSeq", "planDir", "provider", "repoId", "role", "sessionId", "writer"], "the classic body has no delegates key");
    assert!(body["planDir"].as_str().is_some_and(|p| p.ends_with(&format!("plans/{}", body["agentId"].as_str().unwrap()))), "a Claude run is told where its plan notes live: {body}");
    assert_eq!(keys(&body["role"]), ["disallowedTools", "effort", "maxTurns", "model", "name", "permission", "systemPrompt", "tools"]);
    assert_eq!(body["role"]["name"], "developer");
    assert!(!body["role"]["disallowedTools"].as_array().unwrap().iter().any(|t| t == "Agent"), "a classic role keeps the Agent tool as before");
    host.shutdown();
}

#[test]
fn the_user_memory_switch_reaches_the_session_start_only_when_it_is_off() {
    for (supplier, expected) in [(None, None), (Some(true), None), (Some(false), Some(false))] {
        let dir = tempfile::tempdir().unwrap();
        let repo = fixture_repo(dir.path());
        let out = dir.path().join("out.json");
        let mut r = rig(&dir.path().join("data"));
        r.cfg.user_memory = supplier.map(|on| Arc::new(move || on) as intely_agent_host::UserMemorySupplier);
        let (host, _sink) = host_with(r.cfg);
        start(&host, "developer", &repo, job(&out, vec![], vec![]));
        let body = &wait_file(&out, 20)["starts"][0];
        assert_eq!(body.get("includeUserMemory").and_then(Value::as_bool), expected, "supplier {supplier:?}: {body}");
        host.shutdown();
    }
}

#[test]
fn the_auto_session_carries_the_delegates_the_lead_model_from_the_settings_and_the_writer_lease() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let out = dir.path().join("out.json");
    let r = rig(&dir.path().join("data"));
    let (host, _sink) = host_with(r.cfg);
    let summary = start(&host, "auto", &repo, job(&out, vec![], vec![]));
    let body = &wait_file(&out, 20)["starts"][0];
    assert_eq!(body["role"]["name"], "auto");
    assert_eq!(body["role"]["model"], "claude-haiku-4-5-20251001", "model from the supplier");
    assert!(body["role"].get("effort").is_none(), "the supplier says no effort (Haiku)");
    assert_eq!(body["role"]["permission"], "edit");
    assert_eq!(body["writer"], true, "an Auto run takes the write lease like the developer role");
    let delegates = body["delegates"].as_array().expect("delegates");
    assert_eq!(delegates.iter().map(|d| d["name"].as_str().unwrap()).collect::<Vec<_>>(), ["researcher", "dev"]);
    assert_eq!(delegates[0]["tools"], json!(["Read", "Grep", "Glob"]));
    assert_eq!(delegates[0]["permission"], "readOnly");
    let prompt = body["role"]["systemPrompt"].as_str().unwrap();
    assert!(prompt.contains("at most 3 agents") && prompt.contains("run_in_background set to false"), "{prompt}");
    let deny = body["role"]["disallowedTools"].as_array().unwrap();
    assert!(!deny.iter().any(|t| t == "Agent" || t == "Task"), "the lead keeps the Agent tool when it has roles");
    assert_eq!(body["role"]["maxTurns"], 400);
    assert_eq!(summary.role, "auto");
    host.shutdown();
}

#[test]
fn an_empty_set_a_kill_switch_a_tripped_canary_or_an_old_cli_leave_the_lead_alone() {
    let cases: Vec<(&str, Box<dyn Fn(&Rig)>)> = vec![
        ("no roles", Box::new(|r: &Rig| r.roles.lock().unwrap().clear())),
        ("delegation switched off", Box::new(|r: &Rig| r.defaults.lock().unwrap().delegation_enabled = false)),
        ("a CLI older than the minimum", Box::new(|r: &Rig| *r.version.lock().unwrap() = Some("2.1.100".into()))),
    ];
    for (name, tweak) in cases {
        let dir = tempfile::tempdir().unwrap();
        let repo = fixture_repo(dir.path());
        let out = dir.path().join("out.json");
        let r = rig(&dir.path().join("data"));
        tweak(&r);
        let (host, _sink) = host_with(r.cfg);
        start(&host, "auto", &repo, job(&out, vec![], vec![]));
        let body = &wait_file(&out, 20)["starts"][0];
        assert!(body.get("delegates").is_none(), "{name}: delegates must be omitted");
        let deny: Vec<&str> = body["role"]["disallowedTools"].as_array().unwrap().iter().map(|t| t.as_str().unwrap()).collect();
        assert!(deny.contains(&"Agent") && deny.contains(&"Task"), "{name}: Agent/Task go into disallowedTools, got {deny:?}");
        host.shutdown();
    }
}

#[test]
fn a_cli_at_or_above_the_minimum_and_an_unknown_version_keep_the_delegates() {
    for version in [Some(MIN_CLI_FOR_DELEGATION.to_string()), Some("2.1.287".into()), Some("2.2.0".into()), None] {
        let dir = tempfile::tempdir().unwrap();
        let repo = fixture_repo(dir.path());
        let out = dir.path().join("out.json");
        let r = rig(&dir.path().join("data"));
        *r.version.lock().unwrap() = version.clone();
        let (host, _sink) = host_with(r.cfg);
        start(&host, "auto", &repo, job(&out, vec![], vec![]));
        assert!(wait_file(&out, 20)["starts"][0]["delegates"].is_array(), "{version:?}");
        host.shutdown();
    }
    assert!(version_at_least("2.1.284", "2.1.284") && version_at_least("2.1.290", "2.1.284") && version_at_least("2.10.0", "2.9.9"));
    assert!(!version_at_least("2.1.283", "2.1.284") && !version_at_least("1.9.9", "2.1.284"));
    assert!(version_at_least("2.1.284 (Claude Code)", "2.1.284"));
}

#[test]
fn the_auto_kill_switch_refuses_an_auto_start() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let r = rig(&dir.path().join("data"));
    r.defaults.lock().unwrap().auto_enabled = false;
    let (host, _sink) = host_with(r.cfg);
    let e = host.start(AgentStartRequest { role: "auto".into(), repo_ids: vec![repo.id.clone()], prompt: "x".into(), mode: None, mcp_servers: None }, std::slice::from_ref(&repo)).expect_err("refused");
    assert_eq!(e.code, "autoDisabled");
    let info = host.auto_info(std::slice::from_ref(&repo), None);
    assert!(!info.available && info.reason.as_deref() == Some("autoDisabled"));
}

#[test]
fn parallel_agent_calls_never_exceed_the_cap_and_a_delegate_is_judged_by_its_own_role() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let out = dir.path().join("out.json");
    let r = rig(&dir.path().join("data"));
    let (host, _sink) = host_with(r.cfg);
    let repo_file = repo.path.join("a.txt").to_string_lossy().into_owned();
    let agent = |n: usize| json!({"toolId": format!("agent-{n}"), "intent": agent_intent(None, "researcher")});
    let mut asks: Vec<Value> = (0..8).map(agent).collect();
    asks.push(json!({"toolId":"nested","intent": agent_intent(Some("dev"), "researcher")}));
    asks.push(json!({"toolId":"ro-edit","intent":{"class":"write","tool":"Edit","paths":[repo_file.clone()],"summary":"e","actor":{"agentId":"s1","role":"researcher"}}}));
    asks.push(json!({"toolId":"dev-edit","intent":{"class":"write","tool":"Edit","paths":[repo_file.clone()],"summary":"e","actor":{"agentId":"s2","role":"dev"}}}));
    asks.push(json!({"toolId":"dev-commit","intent":{"class":"exec","tool":"Bash","rawCommand":"git commit -m x","summary":"c","actor":{"agentId":"s2","role":"dev"}}}));
    asks.push(json!({"toolId":"ghost","intent":{"class":"read","tool":"Read","paths":[repo_file.clone()],"summary":"r","actor":{"agentId":"?","role":"?"}}}));
    asks.push(json!({"toolId":"general","intent": agent_intent(None, "general-purpose")}));
    start(&host, "auto", &repo, job(&out, asks, vec![]));
    let replies = &wait_file(&out, 30)["replies"];
    let allowed = (0..8).filter(|n| replies[format!("agent-{n}")]["decision"] == "allow").count();
    assert_eq!(allowed, 3, "the cap of 3 holds under 8 parallel calls: {replies}");
    for n in 0..8 {
        let r = &replies[format!("agent-{n}")];
        assert!(r["decision"] == "allow" || r["rule"] == "delegate.cap", "{r}");
    }
    let rule = |k: &str| (replies[k]["decision"].as_str().unwrap().to_string(), replies[k]["by"].as_str().unwrap().to_string(), replies[k]["rule"].as_str().unwrap().to_string());
    assert_eq!(rule("nested"), ("deny".into(), "roleDeny".into(), "delegate.nested".into()));
    assert_eq!(rule("ro-edit"), ("deny".into(), "roleDeny".into(), "role.tool-not-allowed".into()));
    assert_eq!(rule("dev-edit"), ("allow".into(), "default".into(), "write.inside".into()));
    assert_eq!(rule("dev-commit"), ("deny".into(), "hardStop".into(), "git.commit".into()));
    assert_eq!(rule("ghost"), ("deny".into(), "roleDeny".into(), "delegate.unknown-actor".into()));
    assert_eq!(rule("general"), ("deny".into(), "roleDeny".into(), "delegate.unknown-type".into()));
    host.shutdown();
}

#[test]
fn the_canary_switches_delegation_off_for_every_later_start() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let out = dir.path().join("out.json");
    let out2 = dir.path().join("out2.json");
    let r = rig(&dir.path().join("data"));
    let (host, sink) = host_with(r.cfg);
    let a = start(&host, "auto", &repo, job(&out, vec![], vec![json!({"kind":"error","class":"policy","message":format!("{DELEGATION_CANARY_MARK}: a sub-agent call carried no agent_id"),"retryable":false}), json!({"kind":"turn.end","stopReason":"error"})]));
    wait_file(&out, 20);
    sink.wait_turn_end(&a.agent_id);
    assert!(host.delegation_tripped());
    let info = host.auto_info(std::slice::from_ref(&repo), None);
    assert_eq!(info.delegation_off.as_deref(), Some("canaryTripped"));
    assert!(info.delegates.is_empty());
    // a second repo is not needed: the finished run releases the write lease
    start(&host, "auto", &repo, job(&out2, vec![], vec![]));
    let v = wait_file(&out2, 20);
    let body = v["starts"].as_array().unwrap().last().unwrap();
    assert!(body.get("delegates").is_none());
    assert!(body["role"]["disallowedTools"].as_array().unwrap().iter().any(|t| t == "Agent"));
    host.shutdown();
}

#[test]
fn resume_rebuilds_the_delegate_set_from_the_current_files_and_keeps_the_count() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let out = dir.path().join("out.json");
    let r = rig(&dir.path().join("data"));
    let roles = r.roles.clone();
    let (host, sink) = host_with(r.cfg);
    let agent = |n: usize| json!({"toolId": format!("agent-{n}"), "intent": agent_intent(None, "researcher")});
    let a = start(&host, "auto", &repo, job(&out, (0..2).map(agent).collect(), vec![json!({"kind":"turn.end","stopReason":"endTurn"})]));
    wait_file(&out, 20);
    sink.wait_turn_end(&a.agent_id);
    // the sidecar dies; the files change; the next message resumes the run
    let pid = host.sidecar_pid().expect("sidecar");
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    let deadline = Instant::now() + Duration::from_secs(10);
    while host.sidecar_pid().is_some() {
        assert!(Instant::now() < deadline, "the sidecar should be gone");
        std::thread::sleep(Duration::from_millis(50));
    }
    *roles.lock().unwrap() = vec![def("reviewer", PermissionMode::ReadOnly, &["Read"])];
    std::fs::remove_file(&out).unwrap();
    host.send(&a.agent_id, &job(&out, (2..4).map(|n| json!({"toolId": format!("agent-{n}"), "intent": agent_intent(None, "reviewer")})).collect(), vec![])).expect("resume");
    let v = wait_file(&out, 30);
    let second = v["starts"].as_array().unwrap().last().unwrap();
    assert_eq!(second["resume"]["nativeId"].as_str().is_some(), true, "{second}");
    assert_eq!(second["delegates"].as_array().unwrap().iter().map(|d| d["name"].as_str().unwrap()).collect::<Vec<_>>(), ["reviewer"], "the set is rebuilt from the current files");
    // two calls were counted before the resume (cap 3), so exactly one more fits
    let allowed = (2..4).filter(|n| v["replies"][format!("agent-{n}")]["decision"] == "allow").count();
    assert_eq!(allowed, 1, "{}", v["replies"]);
    host.shutdown();
}

#[test]
fn a_single_role_resume_keeps_the_recorded_permission_as_a_ceiling() {
    use intely_agent_host::roles::RoleDef;
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let out = dir.path().join("out.json");
    let r = rig(&dir.path().join("data"));
    let read_only = Arc::new(Mutex::new(true));
    let flag = read_only.clone();
    let base = r.cfg.clone();
    let cfg_for_def = r.cfg.clone();
    let mut cfg = r.cfg;
    // a role file that first derives read-only and later edit (the permission derivation changed under the run)
    cfg.role_resolver = Some(Arc::new(move |name, _| {
        (name == "reviewer-file").then(|| {
            let mut role: RoleDef = intely_agent_host::roles::builtin(&base).into_iter().find(|r| r.name == "reviewer").unwrap();
            role.name = "reviewer-file".into();
            role.permission = if *flag.lock().unwrap() { PermissionMode::ReadOnly } else { PermissionMode::Edit };
            role
        })
    }));
    let (host, sink) = host_with(cfg);
    let mut def: RoleDef = intely_agent_host::roles::builtin(&cfg_for_def).into_iter().find(|r| r.name == "reviewer").unwrap();
    def.name = "reviewer-file".into();
    def.permission = PermissionMode::ReadOnly;
    let a = host.start_role(&def, AgentStartRequest { role: "reviewer-file".into(), repo_ids: vec![repo.id.clone()], prompt: job(&out, vec![], vec![json!({"kind":"turn.end","stopReason":"endTurn"})]), mode: None, mcp_servers: None }, std::slice::from_ref(&repo)).expect("start");
    wait_file(&out, 20);
    sink.wait_turn_end(&a.agent_id);
    *read_only.lock().unwrap() = false;
    let pid = host.sidecar_pid().unwrap();
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    while host.sidecar_pid().is_some() {
        std::thread::sleep(Duration::from_millis(50));
    }
    std::fs::remove_file(&out).unwrap();
    host.send(&a.agent_id, &job(&out, vec![], vec![])).expect("resume");
    let v = wait_file(&out, 30);
    let second = v["starts"].as_array().unwrap().last().unwrap();
    assert_eq!(second["role"]["permission"], "readOnly", "the recorded read-only is the ceiling");
    assert_eq!(second["writer"], false);
    host.shutdown();
}

#[test]
fn auto_info_lists_the_delegates_the_exclusions_the_budget_and_the_worst_case() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let r = rig(&dir.path().join("data"));
    r.defaults.lock().unwrap().max_budget_usd = Some(7.5);
    let (host, _sink) = host_with(r.cfg);
    let info = host.auto_info(std::slice::from_ref(&repo), None);
    assert!(info.available && info.reason.is_none());
    assert_eq!(info.delegates.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["researcher", "dev"]);
    assert_eq!(info.excluded.len(), 1);
    assert_eq!(info.excluded[0].reason, ExcludeReason::Hidden);
    assert_eq!((info.model.as_str(), info.effort, info.permission), ("claude-haiku-4-5-20251001", None, PermissionMode::Edit));
    assert_eq!(info.max_budget_usd, Some(7.5));
    assert_eq!(info.delegation_cap, 3);
    assert_eq!(info.worst_case_turns, 400 + 3 * 150);
    assert!(info.delegation_off.is_none());
    assert_eq!(auto_role(&HostConfig::new(dir.path().to_path_buf(), PathBuf::new(), Arc::new(Default::default))).name, "auto");
}

#[test]
fn the_scripted_mock_lead_gets_the_real_delegate_set_and_exists_only_with_the_mock_provider() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let out = dir.path().join("out.json");
    let r = rig(&dir.path().join("data"));
    let mut without = r.cfg.clone();
    without.providers = vec!["claude".into()];
    assert!(intely_agent_host::roles::builtin(&without).iter().all(|d| d.name != "mock-auto"));
    let (host, _sink) = host_with(r.cfg);
    start(&host, "mock-auto", &repo, job(&out, vec![], vec![]));
    let body = &wait_file(&out, 20)["starts"][0];
    assert_eq!(body["provider"], "mock");
    assert_eq!(body["mock"]["scenario"], "delegate-roles");
    assert_eq!(body["delegates"].as_array().unwrap().len(), 2);
    host.shutdown();
}
