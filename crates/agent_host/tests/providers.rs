//! Wave4 providers wiring through the REAL sidecar bundle: the `--providers` list and every `session/start` of a non-Claude provider
//! come from the confirmed launch table, a changed table restarts an idle sidecar and never a busy one, the write gate honours the
//! per-provider override, the chip is one computation for Settings and runs, and a Test run leaves no trace. Fake ACP agent and fake
//! Codex app-server only: protocol evidence, not vendor evidence.

mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use common::*;
use intely_agent_core::api::AgentStartRequest;
use intely_agent_core::events::types::EventKind;
use intely_agent_core::policy::enforcement::Tier;
use intely_agent_core::providers::PermissionMode;
use intely_agent_host::config::find_on_path;
use intely_agent_host::{roles, AcpMock, AgentHost, HostConfig, ProviderLaunch, RepoRef, StartOptions};

type Table = Arc<Mutex<Vec<ProviderLaunch>>>;

fn fakes() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sidecar/tests/fakes")
}

fn node() -> String {
    let env: HashMap<String, String> = std::env::vars().collect();
    find_on_path("node", &env).expect("node on PATH").to_string_lossy().into_owned()
}

fn acp_entry(id: &str, script: &str, weak_writer: bool) -> ProviderLaunch {
    ProviderLaunch { id: id.into(), adapter: id.into(), command: node(), args: vec![fakes().join("fake-acp-agent.mjs").to_string_lossy().into_owned(), fakes().join("acp-scripts").join(format!("{script}.jsonl")).to_string_lossy().into_owned()], allow_weak_writer: weak_writer }
}

fn config_with(data: &std::path::Path) -> (HostConfig, Table) {
    let table: Table = Arc::default();
    let mut cfg = config(data, sidecar_js());
    let t = table.clone();
    cfg.launch = Some(Arc::new(move || t.lock().unwrap().clone()));
    (cfg, table)
}

fn role(cfg: &HostConfig, permission: PermissionMode) -> roles::RoleDef {
    let mut r = roles::builtin(cfg).into_iter().find(|r| r.name == "mock-plain-reply").unwrap();
    r.permission = permission;
    r.mock_scenario = None;
    r
}

fn start(host: &AgentHost, role: &roles::RoleDef, repo: &RepoRef, provider: &str) -> Result<intely_agent_core::api::AgentSummary, intely_core::EngineError> {
    let req = AgentStartRequest { role: role.name.clone(), repo_ids: vec![repo.id.clone()], prompt: "go".into(), mode: None, mcp_servers: None };
    host.start_role_with(role, req, std::slice::from_ref(repo), StartOptions { provider: Some(provider.into()), ..Default::default() })
}

fn said(events: &[intely_agent_core::events::types::AgentEvent]) -> String {
    events.iter().filter_map(|e| if let EventKind::TextDone { text, .. } = &e.kind { Some(text.as_str()) } else { None }).collect::<Vec<_>>().join("\n")
}

#[test]
fn an_unconfirmed_provider_never_starts_and_a_confirmed_one_restarts_an_idle_sidecar_with_the_new_list() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let (cfg, table) = config_with(&dir.path().join("data"));
    let (host, sink) = host_with(cfg.clone());
    let ro = role(&cfg, PermissionMode::ReadOnly);

    let refused = start(&host, &ro, &repo, "opencode").expect_err("nothing confirmed");
    assert_eq!(refused.code, "providerNotEnabled", "{}", refused.message);
    assert!(refused.message.contains("Experimental providers"));
    assert!(host.list().is_empty(), "a refused start leaves no run behind");
    let first_pid = host.sidecar_pid().expect("the refused start still needed the sidecar for the list");

    // the user confirms opencode: the next start takes the new list, which needs a new sidecar (nothing is running)
    table.lock().unwrap().push(acp_entry("opencode", "plain-reply", false));
    let run = start(&host, &ro, &repo, "opencode").expect("confirmed, read-only");
    assert_eq!(run.provider, "opencode");
    sink.wait_turn_end(&run.agent_id);
    assert!(said(&sink.of(&run.agent_id)).contains("Hello from the ACP fake."));
    let second_pid = host.sidecar_pid().unwrap();
    assert_ne!(first_pid, second_pid, "an idle sidecar is restarted with the new --providers list");
    host.shutdown();
}

#[test]
fn a_busy_sidecar_is_never_restarted_for_a_changed_list() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let (cfg, table) = config_with(&dir.path().join("data"));
    table.lock().unwrap().push(acp_entry("qwen", "ignores-cancel", false));
    let (host, sink) = host_with(cfg.clone());
    let ro = role(&cfg, PermissionMode::ReadOnly);
    let busy = start(&host, &ro, &repo, "qwen").expect("qwen runs");
    sink.wait_kind(&busy.agent_id, "text.delta");
    let pid = host.sidecar_pid().unwrap();

    table.lock().unwrap().push(acp_entry("goose", "plain-reply", false));
    let refused = start(&host, &ro, &repo, "goose").expect_err("the sidecar has a live run");
    assert_eq!(refused.code, "providerRestart", "{}", refused.message);
    assert_eq!(host.sidecar_pid(), Some(pid), "the live run's sidecar was left alone");
    host.shutdown();
}

#[test]
fn a_write_role_needs_the_per_provider_override_on_a_weak_provider() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let (cfg, table) = config_with(&dir.path().join("data"));
    table.lock().unwrap().push(acp_entry("opencode", "plain-reply", false));
    let (host, sink) = host_with(cfg.clone());
    let edit = role(&cfg, PermissionMode::Edit);

    let refused = start(&host, &edit, &repo, "opencode").expect_err("weak provider, no override");
    assert_eq!(refused.code, "providerReadOnly", "{}", refused.message);
    assert!(host.list().is_empty());

    // "allow weak writer" is per provider: another provider with the flag does not open this one
    table.lock().unwrap().push(acp_entry("goose", "plain-reply", true));
    assert_eq!(start(&host, &edit, &repo, "opencode").expect_err("still refused").code, "providerReadOnly");

    table.lock().unwrap()[0].allow_weak_writer = true;
    let run = start(&host, &edit, &repo, "opencode").expect("the override lets the write role open (the sidecar got writeAllowed)");
    assert_eq!(run.permission, PermissionMode::Edit);
    assert_eq!(format!("{:?}", run.enforcement), "Weak", "the chip stays honest: the override does not change the tier");
    sink.wait_turn_end(&run.agent_id);
    host.shutdown();
}

#[test]
fn the_provider_chip_and_the_run_chip_are_the_same_computation_and_follow_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let repo = fixture_repo(dir.path());
    let (mut cfg, table) = config_with(&data);
    table.lock().unwrap().push(acp_entry("opencode", "plain-reply", false));
    let version: Arc<Mutex<Option<String>>> = Arc::default();
    let v = version.clone();
    cfg.cli_version = Some(Arc::new(move |_| v.lock().unwrap().clone()));
    let (host, sink) = host_with(cfg.clone());
    assert!(host.enforcement().is_empty(), "nothing recorded: absent means weak");
    let ro = role(&cfg, PermissionMode::ReadOnly);

    // the harness records S0+S1 for this adapter after the host started: picked up without a restart
    std::fs::write(
        data.join("enforcement.json"),
        r#"{"runs":[{"key":{"adapter":"opencode","authMode":"subscription","roleMode":"readOnly","cliVersion":"1.4.0"},"suites":{"t0":"notRun","s0":"pass","s1":"pass","s2":"notRun","s3":"notRun","s4":"notRun"},"layersProven":[],"at":1}]}"#,
    )
    .unwrap();
    let chips = host.enforcement();
    assert_eq!(chips.len(), 1);
    assert_eq!((chips[0].0.as_str(), chips[0].1, chips[0].2.tier), ("opencode", true, Tier::BestEffort));

    let run = start(&host, &ro, &repo, "opencode").unwrap();
    assert_eq!(run.enforcement, chips[0].2.tier, "the run header reads the same chip as Settings");
    sink.wait_turn_end(&run.agent_id);
    assert_eq!(host.list().iter().find(|s| s.agent_id == run.agent_id).unwrap().enforcement, Tier::BestEffort);
    // the other kind (a write role) was never measured: weak, and the pair is simply absent
    assert!(host.enforcement().iter().all(|(_, read_only, _)| *read_only));

    // the CLI was updated since the record: stale evidence reads Weak everywhere, the run attached for the explanation
    *version.lock().unwrap() = Some("1.5.0".into());
    let stale = host.enforcement();
    assert_eq!(stale[0].2.tier, Tier::Weak);
    assert!(stale[0].2.run.is_some());
    assert_eq!(host.list().iter().find(|s| s.agent_id == run.agent_id).unwrap().enforcement, Tier::Weak);
    host.shutdown();
}

#[test]
fn a_test_run_negotiates_capabilities_without_a_prompt_and_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let (mut cfg, table) = config_with(&data);
    table.lock().unwrap().push(acp_entry("opencode", "plain-reply", false));
    cfg.providers.push("gemini".into());
    cfg.acp_mock = Some(AcpMock { provider: "gemini".into(), agent_js: fakes().join("fake-acp-agent.mjs"), scripts_dir: fakes().join("acp-scripts") });
    let (host, sink) = host_with(cfg);

    let report = host.probe("opencode", None).expect("probe");
    assert!(report.ok, "{report:?}");
    assert!(report.model.is_some());
    assert!(report.negotiated && report.caps.is_some(), "the ACP adapter reports caps after session/new: {report:?}");
    assert_eq!(host.negotiated_caps("opencode").is_some(), true);
    assert!(host.list().is_empty(), "never listed");
    assert!(sink.all().is_empty(), "nothing published, nothing stored");
    assert!(host.metas().is_empty());
    assert!(!data.join("probe").read_dir().map(|mut d| d.next().is_some()).unwrap_or(false), "the scratch directory is gone");
    assert!(host.leases().is_empty(), "the slot was released");

    assert_eq!(host.probe("goose", None).expect_err("not confirmed").code, "providerNotEnabled");
    assert_eq!(host.probe("mock", None).expect_err("scripted").code, "probeUnsupported");
    host.shutdown();
}

#[test]
fn codex_runs_the_confirmed_program_read_only_and_a_write_role_needs_the_override() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let (cfg, table) = config_with(&dir.path().join("data"));
    table.lock().unwrap().push(ProviderLaunch { id: "codex".into(), adapter: "codex".into(), command: fakes().join("fake-codex-appserver.mjs").to_string_lossy().into_owned(), args: vec!["app-server".into()], allow_weak_writer: false });
    let (host, sink) = host_with(cfg.clone());
    let edit = role(&cfg, PermissionMode::Edit);
    assert_eq!(start(&host, &edit, &repo, "codex").expect_err("weak").code, "providerReadOnly");
    let ro = role(&cfg, PermissionMode::ReadOnly);
    let run = start(&host, &ro, &repo, "codex").expect("the fake app-server starts through env.codexBin");
    assert_eq!(run.provider, "codex");
    sink.wait_turn_end(&run.agent_id);
    let events = sink.of(&run.agent_id);
    assert!(has_kind(&events, "session.started") && has_kind(&events, "text.done"), "{:?}", events.iter().map(|e| e.kind.name()).collect::<Vec<_>>());
    host.shutdown();
}
