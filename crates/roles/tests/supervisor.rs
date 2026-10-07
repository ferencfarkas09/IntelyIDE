//! The supervisor against the real sidecar bundle and the mock provider: no model call, throwaway repos and a
//! throwaway transcript store (`CLAUDE_CONFIG_DIR`), never `~/.claude` and never a real repository.

mod common;

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use intely_agent_core::api::PermissionDecision;
use intely_agent_core::events::types::EventKind;
use intely_agent_host::{AgentHost, RepoRef, RoleResolver};
use intely_roles::types::{AdoptOptions, HistoryQuery, HistoryScope, HistorySource, RunRecord, RunState, RunsStartRequest};
use intely_roles::{MemoryOverlay, Observer, RoleStore, Supervisor, SupervisorConfig};

struct Rig {
    dir: tempfile::TempDir,
    sup: Supervisor,
    sink: Arc<Collector>,
    claude: std::path::PathBuf,
    roles: Arc<RoleStore>,
}

fn rig() -> Rig {
    rig_with(|_| {})
}

fn rig_with(tweak: impl FnOnce(&mut intely_agent_host::HostConfig)) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let claude = dir.path().join("claude");
    let global = dir.path().join("home/.claude/agents");
    let roles = Arc::new(RoleStore::new(global, Box::new(MemoryOverlay::default())).with_backup_dir(dir.path().join("role-backups")));
    let mut cfg = config(&dir.path().join("data"), sidecar_js(), &claude);
    let resolver_roles = roles.clone();
    let resolver: RoleResolver = Arc::new(move |name, repos| {
        let role = resolver_roles.resolve_any(name, repos.first().map(|r| r.id.as_str()), repos)?;
        Some(RoleStore::role_def(&role))
    });
    cfg.role_resolver = Some(resolver);
    cfg.delegate_resolver = Some(roles.delegate_resolver());
    tweak(&mut cfg);
    let git = cfg.git.clone();
    let sink = Collector::new();
    let observer = Observer::new(sink.clone());
    let host = AgentHost::new(cfg, observer.clone());
    let sup = Supervisor::new(host, roles.clone(), SupervisorConfig { data_dir: dir.path().join("data"), git }, Some(&observer));
    Rig { dir, sup, sink, claude, roles }
}

fn start(sup: &Supervisor, role: &str, repo: &RepoRef, repos: &[RepoRef]) -> RunRecord {
    sup.start(RunsStartRequest { role_id: role.into(), repo_ids: vec![repo.id.clone()], prompt: "go".into(), mode: None }, repos).expect("start")
}

fn wait_until(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while !f() {
        assert!(Instant::now() < deadline, "timeout waiting for {what}");
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn deny_pending(r: &Rig, agent: &str) {
    let req = r.sink.wait(agent, "permission.request", 20, |e| matches!(e.kind, EventKind::PermissionRequest { .. }));
    let EventKind::PermissionRequest { req_id, .. } = req.kind else { unreachable!() };
    r.sup.host().answer_permission(agent, &req_id, PermissionDecision::Deny).expect("answer");
}

fn record<'a>(list: &'a [RunRecord], id: &str) -> Option<&'a RunRecord> {
    list.iter().find(|r| r.agent_id == id)
}

#[test]
fn a_second_writer_on_the_same_repo_waits_in_a_queue_and_starts_when_the_first_is_done() {
    let r = rig();
    let repo = fixture_repo(r.dir.path(), "repo");
    let repos = [repo.clone()];
    let first = start(&r.sup, "mock-tool-permission", &repo, &repos);
    assert_ne!(first.status, RunState::Queued);
    r.sink.wait(&first.agent_id, "permission.request", 20, |e| matches!(e.kind, EventKind::PermissionRequest { .. }));

    let second = start(&r.sup, "mock-tool-permission", &repo, &repos);
    assert_eq!(second.status, RunState::Queued);
    assert!(second.agent_id.starts_with("q-") && second.note.as_deref().unwrap().contains(&first.agent_id), "{second:?}");
    assert!(record(&r.sup.list(), &second.agent_id).is_some(), "queued runs are listed");

    // a reader on the same repo is not blocked by the writer
    let reader = start(&r.sup, "mock-plain-reply", &repo, &repos);
    assert_ne!(reader.status, RunState::Queued);

    // a queued run can be removed
    let third = start(&r.sup, "mock-tool-permission", &repo, &repos);
    assert_eq!(third.status, RunState::Queued);
    r.sup.stop(&third.agent_id).unwrap();
    assert!(record(&r.sup.list(), &third.agent_id).is_none());

    deny_pending(&r, &first.agent_id);
    r.sink.wait_turn_end(&first.agent_id);
    let mut started = None;
    wait_until("the queued writer to start", 30, || {
        let list = r.sup.list();
        started = list.iter().find(|x| x.role == "mock-tool-permission" && x.agent_id != first.agent_id && !x.agent_id.starts_with("q-")).cloned();
        started.is_some() && record(&list, &second.agent_id).is_none()
    });
    let started = started.unwrap();
    assert_ne!(started.status, RunState::Queued);
    deny_pending(&r, &started.agent_id);
    r.sup.host().shutdown();
}

#[test]
fn at_most_two_writers_run_at_once_across_repos() {
    let r = rig();
    let repos: Vec<RepoRef> = ["a", "b", "c"].iter().map(|n| fixture_repo(r.dir.path(), n)).collect();
    let a = start(&r.sup, "mock-tool-permission", &repos[0], &repos);
    let b = start(&r.sup, "mock-tool-permission", &repos[1], &repos);
    assert!(a.status != RunState::Queued && b.status != RunState::Queued);
    r.sink.wait(&b.agent_id, "permission.request", 20, |e| matches!(e.kind, EventKind::PermissionRequest { .. }));
    let c = start(&r.sup, "mock-tool-permission", &repos[2], &repos);
    assert_eq!(c.status, RunState::Queued);
    assert!(c.note.as_deref().unwrap().contains("writers"), "{c:?}");
    deny_pending(&r, &a.agent_id);
    deny_pending(&r, &b.agent_id);
    let started = {
        let mut found = None;
        wait_until("the third writer", 30, || {
            found = r.sup.list().into_iter().find(|x| x.repo_ids == ["c"] && !x.agent_id.starts_with("q-"));
            found.is_some()
        });
        found.unwrap()
    };
    deny_pending(&r, &started.agent_id);
    r.sup.host().shutdown();
}

#[test]
fn a_role_outside_its_repo_scope_is_refused_and_file_roles_run_with_their_overlay() {
    let r = rig();
    let repo = fixture_repo(r.dir.path(), "repo");
    let other = fixture_repo(r.dir.path(), "other");
    let repos = [repo.clone(), other.clone()];
    let store = &r.roles;
    let mut role = store.preset_happy_tiering(&repos, true).unwrap().into_iter().find(|x| x.name == "researcher").unwrap();
    role.provider = "mock".into();
    role.repo_scope = vec!["repo".into()];
    store.save(intely_roles::types::RoleDraft::from(&role).confirmed(), &repos).unwrap();
    let denied = r.sup.start(RunsStartRequest { role_id: "researcher".into(), repo_ids: vec!["other".into()], prompt: "x".into(), mode: None }, &repos).unwrap_err();
    assert_eq!(denied.code, "outOfScope");
    let unknown = r.sup.start(RunsStartRequest { role_id: "nobody".into(), repo_ids: vec!["repo".into()], prompt: "x".into(), mode: None }, &repos).unwrap_err();
    assert_eq!(unknown.code, "unknownRole");
    r.sup.host().shutdown();
}

#[test]
fn the_chat_ui_start_resolves_file_roles_and_the_dialog_lists_them() {
    use intely_agent_core::api::AgentStartRequest;
    let r = rig();
    let repo = fixture_repo(r.dir.path(), "repo");
    let other = fixture_repo(r.dir.path(), "other");
    let repos = [repo.clone(), other.clone()];
    let mut role = r.roles.preset_happy_tiering(&repos, true).unwrap().into_iter().find(|x| x.name == "researcher").unwrap();
    role.provider = "mock".into();
    role.repo_scope = vec!["repo".into()];
    r.roles.save(intely_roles::types::RoleDraft::from(&role).confirmed(), &repos).unwrap();

    let infos = r.sup.role_infos(&repos);
    assert!(infos.iter().any(|i| i.name == "mock-plain-reply"), "built-ins stay: {infos:?}");
    assert_eq!(infos.iter().filter(|i| i.name == "researcher").count(), 1, "a file role replaces, never duplicates");
    assert!(infos.iter().any(|i| i.name == "developer" && i.provider == "claude"), "the preset roles are listed: {infos:?}");

    let denied = r.sup.start_now(AgentStartRequest { role: "researcher".into(), repo_ids: vec!["other".into()], prompt: "x".into(), mode: None, mcp_servers: None }, &repos).unwrap_err();
    assert_eq!(denied.code, "outOfScope");
    let run = r.sup.start_now(AgentStartRequest { role: "researcher".into(), repo_ids: vec!["repo".into()], prompt: "x".into(), mode: None, mcp_servers: None }, &repos).expect("start");
    r.sink.wait_turn_end(&run.agent_id);
    assert!(r.sup.list().iter().any(|x| x.agent_id == run.agent_id), "the run shows in the supervisor's list");
    r.sup.host().shutdown();
}

#[test]
fn usage_is_kept_per_run_and_a_follow_up_message_does_not_count_twice() {
    let r = rig();
    let repo = fixture_repo(r.dir.path(), "repo");
    let repos = [repo.clone()];
    let run = start(&r.sup, "mock-plain-reply", &repo, &repos);
    r.sink.wait_turn_end(&run.agent_id);
    wait_until("the usage to be booked", 10, || r.sup.usage().runs.iter().any(|u| u.agent_id == run.agent_id));
    let first = r.sup.usage();
    let t = &first.runs[0].totals;
    assert_eq!((t.input_tokens, t.output_tokens), (12.0, 14.0));
    // the second turn replays the scripted usage: cumulative stays 12, a per-turn sum would be 24
    r.sup.host().send(&run.agent_id, "again").unwrap();
    wait_until("the second turn", 20, || r.sink.of(&run.agent_id).iter().filter(|e| e.kind.name() == "turn.end").count() >= 2);
    assert_eq!(r.sup.usage().total.input_tokens, 12.0);
    r.sup.host().shutdown();
    let reopened = intely_roles::ledger::Ledger::open(r.dir.path().join("data/usage-ledger.json"));
    assert_eq!(reopened.total_of(&run.agent_id).unwrap().input_tokens, 12.0, "the ledger is on disk");
}

fn transcript(claude: &Path, cwd: &Path, id: &str, prompt: &str) {
    let dir = claude.join("projects").join(cwd.to_string_lossy().replace(|c: char| !c.is_ascii_alphanumeric(), "-"));
    std::fs::create_dir_all(&dir).unwrap();
    let line = |t: &str, uuid: &str, parent: Option<&str>, content: serde_json::Value, ts: &str| {
        serde_json::json!({"type": t, "uuid": uuid, "parentUuid": parent, "sessionId": id, "timestamp": ts, "cwd": cwd, "version": "2.0.0", "isSidechain": false, "userType": "external", "message": {"role": t, "content": content}}).to_string()
    };
    let text = [
        line("user", "u1", None, serde_json::json!(prompt), "2026-10-03T08:00:00.000Z"),
        line("assistant", "a1", Some("u1"), serde_json::json!([{"type": "text", "text": "Done."}]), "2026-10-03T08:00:05.000Z"),
    ]
    .join("\n");
    std::fs::write(dir.join(format!("{id}.jsonl")), text + "\n").unwrap();
}

#[test]
fn history_merges_ide_runs_with_sessions_started_elsewhere_and_searches_and_tags_them() {
    let r = rig();
    let repo = fixture_repo(r.dir.path(), "repo");
    let repos = [repo.clone()];
    let sid = "22222222-2222-4222-8222-222222222222";
    transcript(&r.claude, &repo.path, sid, "Rename the helper everywhere");
    let run = start(&r.sup, "mock-plain-reply", &repo, &repos);
    r.sink.wait_turn_end(&run.agent_id);

    let all = r.sup.history(&HistoryQuery { search: None, tag: None, scope: None, limit: None }, &repos);
    assert_eq!(all.len(), 2, "{all:?}");
    let external = all.iter().find(|e| e.source == HistorySource::External).unwrap();
    assert_eq!((external.id.as_str(), external.repo_ids.clone()), (format!("session:{sid}").as_str(), vec!["repo".to_string()]));
    assert_eq!(external.first_prompt.as_deref(), Some("Rename the helper everywhere"));
    assert!(all.iter().any(|e| e.source == HistorySource::Ide && e.id == run.agent_id));

    let q = |search: &str| HistoryQuery { search: Some(search.into()), tag: None, scope: Some(HistoryScope::Repos), limit: None };
    assert_eq!(r.sup.history(&q("helper"), &repos).len(), 1, "matches the transcript's first prompt");
    assert_eq!(r.sup.history(&q("go"), &repos).iter().map(|e| e.id.clone()).collect::<Vec<_>>(), [run.agent_id.clone()], "matches what the user said to an IDE run");
    assert!(r.sup.history(&q("zebra"), &repos).is_empty());

    r.sup.tag(&format!("session:{sid}"), Some("review")).unwrap();
    r.sup.tag(&run.agent_id, Some("mine")).unwrap();
    let by_tag = |t: &str| r.sup.history(&HistoryQuery { search: None, tag: Some(t.into()), scope: None, limit: None }, &repos);
    assert_eq!(by_tag("review").len(), 1);
    assert_eq!(by_tag("MINE")[0].id, run.agent_id);
    r.sup.tag(&run.agent_id, None).unwrap();
    assert!(by_tag("mine").is_empty());
    r.sup.host().shutdown();
}

#[test]
fn an_outside_session_can_be_forked_and_resumed_into_runs_of_their_own() {
    let r = rig();
    let repo = fixture_repo(r.dir.path(), "repo");
    let repos = [repo.clone()];
    let sid = "33333333-3333-4333-8333-333333333333";
    transcript(&r.claude, &repo.path, sid, "Fix the login");
    let opts = AdoptOptions { role_id: Some("mock-plain-reply".into()), repo_ids: None, up_to_message_id: None };

    let fork = r.sup.fork(&format!("session:{sid}"), &opts, &repos).expect("fork");
    assert_eq!(fork.forked_from.as_deref(), Some(format!("session:{sid}").as_str()));
    assert!(fork.session_id.as_deref().is_some_and(|s| s != sid), "a new session, the original is untouched: {fork:?}");
    assert!(fork.title.ends_with("(fork)"), "{fork:?}");
    assert_eq!(fork.repo_ids, ["repo"]);
    // the fork is a real transcript next to the original
    let history = r.sup.history(&HistoryQuery { search: None, tag: None, scope: None, limit: None }, &repos);
    assert_eq!(history.iter().filter(|e| e.cwd.is_some()).count(), 2, "{history:?}");

    let resumed = r.sup.resume(&format!("session:{sid}"), &opts, &repos).expect("resume");
    assert_eq!(resumed.session_id.as_deref(), Some(sid));
    assert_ne!(resumed.agent_id, fork.agent_id);
    r.sup.host().send(&resumed.agent_id, "continue").expect("the adopted session takes a message");
    r.sink.wait_turn_end(&resumed.agent_id);

    // unknown ids are refused
    let err = r.sup.resume("session:00000000-0000-4000-8000-000000000000", &opts, &repos).unwrap_err();
    assert_eq!(err.code, "unknownSession");
    let err = r.sup.fork("nope", &opts, &repos).unwrap_err();
    assert_eq!(err.code, "unknownAgent");
    r.sup.host().shutdown();
}

#[test]
fn rewind_restores_only_with_an_explicit_confirmation() {
    let r = rig();
    let repo = fixture_repo(r.dir.path(), "repo");
    let repos = [repo.clone()];
    let run = start(&r.sup, "mock-plain-reply", &repo, &repos);
    r.sink.wait_turn_end(&run.agent_id);
    std::fs::write(repo.path.join("a.txt"), "changed by the agent\n").unwrap();
    std::fs::write(repo.path.join("new.txt"), "created by the agent\n").unwrap();

    let snaps = r.sup.rewind_snapshots(&run.agent_id).unwrap();
    assert_eq!(snaps.len(), 1);
    assert_eq!((snaps[0].repo_id.as_str(), snaps[0].overwrite.clone(), snaps[0].delete.clone()), ("repo", vec!["a.txt".to_string()], vec!["new.txt".to_string()]));

    assert_eq!(r.sup.rewind_restore(&run.agent_id, false, None).unwrap_err().code, "confirmRequired");
    assert_eq!(std::fs::read_to_string(repo.path.join("a.txt")).unwrap(), "changed by the agent\n", "nothing happened without the confirmation");
    r.sup.rewind_restore(&run.agent_id, true, None).unwrap();
    assert_eq!(std::fs::read_to_string(repo.path.join("a.txt")).unwrap(), "one\n");
    assert!(!repo.path.join("new.txt").exists());
    assert_eq!(r.sup.rewind_restore("nope", true, None).unwrap_err().code, "unknownAgent");
    r.sup.host().shutdown();
}

// ---- Auto / delegation ((design notes: roles-orchestration-spec) 4.2, 8.2) ----

fn names(set: &[intely_agent_core::delegates::DelegateInfo]) -> Vec<String> {
    set.iter().map(|d| d.name.clone()).collect()
}

#[test]
fn a_hidden_role_is_refused_for_a_new_run_but_still_resolves_for_the_host() {
    // the host resolver answers hidden roles (resume and reload by name keep working), so the supervisor must not fall through to it
    let r = rig();
    let repo = fixture_repo(r.dir.path(), "repo");
    let repos = [repo.clone()];
    let global = r.dir.path().join("home/.claude/agents");
    std::fs::create_dir_all(&global).unwrap();
    std::fs::write(global.join("secret-one.md"), "---\nname: secret-one\ndescription: Hidden\ntools: Read\n---\nHidden.\n").unwrap();
    r.roles.set_hidden("secret-one", true, &repos).unwrap();
    let refused = r.sup.start(RunsStartRequest { role_id: "secret-one".into(), repo_ids: vec!["repo".into()], prompt: "x".into(), mode: None }, &repos).unwrap_err();
    assert_eq!(refused.code, "unknownRole", "{refused:?}");
    assert!(r.sup.host().find_role("secret-one", &repos).is_some(), "the host still resolves it by name (resume, reload)");
    r.sup.host().shutdown();
}

#[test]
fn the_picker_list_omits_hidden_roles_untrusted_repo_roles_and_auto() {
    let r = rig();
    let repo = fixture_repo(r.dir.path(), "repo");
    let repos = [repo.clone()];
    // a global file role, a hidden one, and a repository-only role nobody approved
    let global = r.dir.path().join("home/.claude/agents");
    std::fs::create_dir_all(&global).unwrap();
    std::fs::write(global.join("planner.md"), "---\nname: planner\ndescription: Plans\ntools: Read, Grep\n---\nPlan.\n").unwrap();
    std::fs::write(global.join("secret-one.md"), "---\nname: secret-one\ndescription: Hidden\ntools: Read\n---\nHidden.\n").unwrap();
    let agents = repo.path.join(".claude/agents");
    std::fs::create_dir_all(&agents).unwrap();
    std::fs::write(agents.join("sneaky.md"), "---\nname: sneaky\ndescription: From the repo\n---\nDo things.\n").unwrap();
    std::fs::write(global.join("auto.md"), "---\nname: auto\ndescription: A file called auto\ntools: Read\n---\nx\n").unwrap();
    r.roles.set_hidden("secret-one", true, &repos).unwrap();
    let infos = r.sup.role_infos(&repos);
    let has = |n: &str| infos.iter().any(|i| i.name == n);
    assert!(has("planner") && has("mock-plain-reply"), "{:?}", infos.iter().map(|i| &i.name).collect::<Vec<_>>());
    assert!(!has("secret-one"), "a hidden file role is not offered");
    assert!(!has("sneaky"), "an untrusted repository role is not offered");
    assert!(!has("auto"), "auto is not a role to pick");
    // approving the repository file by its content hash makes it a role again
    let group = r.roles.groups(&repos).into_iter().find(|g| g.name == "sneaky").unwrap();
    let hash = group.copies[0].content_hash.clone();
    r.roles.set_trust("sneaky", &hash, true, &repos).unwrap();
    assert!(r.sup.role_infos(&repos).iter().any(|i| i.name == "sneaky"));
    r.sup.host().shutdown();
}

#[test]
fn auto_resolves_to_the_lead_and_never_to_a_file_named_auto() {
    use intely_agent_core::api::AgentStartRequest;
    let r = rig();
    let repo = fixture_repo(r.dir.path(), "repo");
    let repos = [repo.clone()];
    let global = r.dir.path().join("home/.claude/agents");
    std::fs::create_dir_all(&global).unwrap();
    std::fs::write(global.join("auto.md"), "---\nname: auto\ndescription: A file called auto\ntools: Read\n---\nx\n").unwrap();
    // no claude in this rig: the start is refused by the provider, but only AFTER role resolution picked the lead (not the file)
    let e = r.sup.start_now(AgentStartRequest { role: "auto".into(), repo_ids: vec!["repo".into()], prompt: "x".into(), mode: None, mcp_servers: None }, &repos).unwrap_err();
    assert_ne!(e.code, "unknownRole", "{e:?}");
    let q = r.sup.start(RunsStartRequest { role_id: "auto".into(), repo_ids: vec!["repo".into()], prompt: "x".into(), mode: None }, &repos);
    assert!(q.is_err() || q.as_ref().is_ok_and(|rec| rec.role == "auto"));
    r.sup.host().shutdown();
}

#[test]
fn a_queued_mock_lead_recomputes_its_delegates_when_it_leaves_the_queue_and_the_card_names_the_blocker() {
    let r = rig();
    let repo = fixture_repo(r.dir.path(), "repo");
    let repos = [repo.clone()];
    r.roles.preset_happy_tiering(&repos, true).unwrap();
    let first = start(&r.sup, "mock-tool-permission", &repo, &repos);
    r.sink.wait(&first.agent_id, "permission.request", 20, |e| matches!(e.kind, EventKind::PermissionRequest { .. }));

    let info = r.sup.auto_info(&["repo".to_string()], &repos, None);
    let queued_behind = info.queued_behind.expect("another run is writing to the repository");
    assert_eq!((queued_behind.kind.as_str(), queued_behind.agent_id.as_str()), ("repoWriter", first.agent_id.as_str()));
    assert!(names(&info.delegates).contains(&"researcher".to_string()), "{:?}", names(&info.delegates));

    let lead = start(&r.sup, "mock-auto", &repo, &repos);
    assert_eq!(lead.status, RunState::Queued, "an Auto-style lead edits, so it waits behind the writer");
    // the files change while it waits
    r.roles.set_hidden("researcher", true, &repos).unwrap();

    deny_pending(&r, &first.agent_id);
    r.sink.wait_turn_end(&first.agent_id);
    let mut started = None;
    wait_until("the queued lead to start", 30, || {
        started = r.sup.list().into_iter().find(|x| x.role == "mock-auto" && !x.agent_id.starts_with("q-"));
        started.is_some()
    });
    let id = started.unwrap().agent_id;
    wait_until("the lead's delegates", 20, || r.sup.host().list().iter().any(|a| a.agent_id == id && !a.delegates.is_empty()));
    let summary = r.sup.host().list().into_iter().find(|a| a.agent_id == id).unwrap();
    let got = names(&summary.delegates);
    assert!(!got.contains(&"researcher".to_string()), "the hidden role is no longer a delegate: {got:?}");
    assert!(got.contains(&"developer".to_string()) || got.len() > 1, "{got:?}");
    r.sink.wait_turn_end(&id);
    r.sup.host().shutdown();
}

fn mode_request(repo: &RepoRef, role: &str, mode: intely_agent_core::providers::PermissionMode) -> RunsStartRequest {
    RunsStartRequest { role_id: role.into(), repo_ids: vec![repo.id.clone()], prompt: "go".into(), mode: Some(mode) }
}

fn permission_of(r: &Rig, agent: &str) -> intely_agent_core::providers::PermissionMode {
    r.sup.host().list().into_iter().find(|a| a.agent_id == agent).unwrap().permission
}

#[test]
fn a_queued_or_scripted_start_takes_the_dialogs_modes_but_never_bypass_and_never_automatic_under_the_kill_switch() {
    use intely_agent_core::providers::PermissionMode::{Ask, Automatic, Bypass};
    let r = rig();
    let repo = fixture_repo(r.dir.path(), "repo");
    let repos = [repo.clone()];
    // bypass is refused at enqueue: nobody could confirm it when the run leaves the queue
    let e = r.sup.start(mode_request(&repo, "mock-plain-reply", Bypass), &repos).unwrap_err();
    assert_eq!(e.code, "bypassNotConfirmed", "{}", e.message);
    assert!(r.sup.list().is_empty(), "nothing was queued or started");
    // automatic is accepted and runs as automatic; an explicit ask beats the role's own edit
    let rec = r.sup.start(mode_request(&repo, "mock-plain-reply", Automatic), &repos).expect("automatic");
    assert_eq!(permission_of(&r, &rec.agent_id), Automatic);
    r.sink.wait_turn_end(&rec.agent_id);
    let asked = r.sup.start(mode_request(&repo, "mock-tool-permission", Ask), &repos).expect("ask");
    assert_eq!(permission_of(&r, &asked.agent_id), Ask);
    r.sup.host().shutdown();

    let r = rig_with(|cfg| cfg.no_unattended = true);
    let repo = fixture_repo(r.dir.path(), "repo");
    let repos = [repo.clone()];
    let e = r.sup.start(mode_request(&repo, "mock-plain-reply", Automatic), &repos).unwrap_err();
    assert_eq!(e.code, "modeDisabled", "{}", e.message);
    assert!(r.sup.list().is_empty());
    assert!(r.sup.start(mode_request(&repo, "mock-plain-reply", Ask), &repos).is_ok(), "the attended modes still work");
    r.sup.host().shutdown();
}

#[test]
fn the_run_mode_decides_who_waits_for_the_writer_and_a_dequeued_automatic_run_starts_as_one() {
    use intely_agent_core::providers::PermissionMode::{Ask, Automatic};
    let r = rig();
    let repo = fixture_repo(r.dir.path(), "repo");
    let repos = [repo.clone()];
    let first = start(&r.sup, "mock-tool-permission", &repo, &repos);
    r.sink.wait(&first.agent_id, "permission.request", 20, |e| matches!(e.kind, EventKind::PermissionRequest { .. }));

    // Ask is no writer mode, whatever the role's own permission is
    let preview_ask = r.sup.auto_info(&["repo".to_string()], &repos, Some(Ask));
    assert!(preview_ask.queued_behind.is_none(), "an Ask run would not wait: {:?}", preview_ask.queued_behind);
    let preview_auto = r.sup.auto_info(&["repo".to_string()], &repos, Some(Automatic));
    assert_eq!(preview_auto.queued_behind.map(|q| q.kind), Some("repoWriter".to_string()), "an Automatic run writes, so it waits behind the writer");
    let reader = r.sup.start(mode_request(&repo, "mock-tool-permission", Ask), &repos).unwrap();
    assert_ne!(reader.status, RunState::Queued);

    // a read-only role started in Automatic is a writer: it waits, and leaves the queue as the Automatic run it was asked to be
    let queued = r.sup.start(mode_request(&repo, "mock-plain-reply", Automatic), &repos).unwrap();
    assert_eq!(queued.status, RunState::Queued);
    deny_pending(&r, &first.agent_id);
    r.sink.wait_turn_end(&first.agent_id);
    let mut started = None;
    wait_until("the queued run to start", 30, || {
        started = r.sup.list().into_iter().find(|x| x.role == "mock-plain-reply" && !x.agent_id.starts_with("q-"));
        started.is_some()
    });
    assert_eq!(permission_of(&r, &started.unwrap().agent_id), Automatic);
    r.sup.host().shutdown();
}
