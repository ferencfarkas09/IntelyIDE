//! A run on a server: the real host, the real sidecar bundle and the mock provider, reached through a fake `ssh` that runs the
//! command on this machine under another HOME (the "server"). The permission broker judges the server's files through the sidecar's
//! `fs/query`, the git guard is uploaded, nothing of this Mac's login shell is sent, and a server that cannot answer denies.

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::*;
use intely_agent_core::api::{AgentStartRequest, PermissionDecision, RunStatus};
use intely_agent_core::events::types::EventKind;
use intely_agent_host::{AgentHost, RepoRef, ServerRegistry, StartOptions};
use intely_servers::probe::{BundleStatus, ClaudeStatus, GitStatus, NodeStatus, SdkStatus};
use intely_servers::{ServerCfg, ServerStatus, Ssh};

const VERSION: &str = "9.9.9";

fn script(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// The "server": a home directory with the sidecar bundle, a Claude stand-in, a repo, and an `ssh` that runs commands in it.
struct Server {
    home: PathBuf,
    /// Every line the host sent to the sidecar there.
    wire_log: PathBuf,
    registry: Arc<ServerRegistry>,
}

fn real_git() -> String {
    ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"].iter().find(|p| Path::new(p).is_file()).expect("a git").to_string()
}

fn node_path() -> String {
    let out = std::process::Command::new("sh").args(["-c", "command -v node"]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// `filter`: a shell fragment the lines to the sidecar go through (`cat` = unchanged).
fn server(root: &Path, max_agents: u32, filter: &str) -> Server {
    let home = root.join("serverhome");
    let bin = home.join("bin");
    let res = home.join(format!(".intely/{VERSION}/resources/sidecar"));
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&res).unwrap();
    std::fs::create_dir_all(home.join(".intely/claude/bin")).unwrap();
    std::fs::copy(sidecar_js(), res.join("index.js")).unwrap();
    std::fs::write(res.join("package.json"), r#"{"type":"module"}"#).unwrap();
    script(&home.join(".intely/claude/bin/claude"), "#!/bin/sh\necho claude\n");
    // the node of the server records what the host sends it
    let wire_log = root.join("wire.log");
    script(&bin.join("node"), &format!("#!/bin/sh\ntee -a '{log}' | {filter} | '{node}' \"$@\"\n", log = wire_log.display(), node = node_path()));
    let ssh = root.join("fake-ssh");
    script(
        &ssh,
        &format!(
            "#!/bin/sh\n# ssh [options] -- destination command...\nwhile [ $# -gt 0 ]; do case \"$1\" in --) shift; break ;; -o|-p|-i|-J|-F|-l) shift 2 ;; -*) shift ;; *) break ;; esac; done\nshift\nHOME='{home}' PATH='{bin}':\"$PATH\" exec sh -c \"$*\"\n",
            home = home.display(),
            bin = bin.display()
        ),
    );
    let cfg = ServerCfg { id: "srv".into(), name: "Test server".into(), destination: "dev@fake".into(), port: None, root: "~/work".into(), max_agents, enabled: true };
    let registry = Arc::new(ServerRegistry::new(Arc::new(move || vec![cfg.clone()]), Ssh::from_bin(Some(ssh.into_os_string()), root.join("ctl")), VERSION));
    registry.set_status(
        "srv",
        ServerStatus {
            reachable: true,
            os: Some("Linux".into()),
            arch: Some("x86_64".into()),
            home: Some(home.display().to_string()),
            node: NodeStatus { version: Some("v24.13.0".into()), path: Some(bin.join("node").display().to_string()), ok: true },
            claude: ClaudeStatus { path: Some(home.join(".intely/claude/bin/claude").display().to_string()), version: None, logged_in: Some(true) },
            git: GitStatus { path: Some(real_git()), version: None },
            bundle: BundleStatus { version: Some(VERSION.into()), ok: true },
            sdk: SdkStatus { ok: true, version: None, detail: None },
            ready: true,
            checked_at: "2026-10-10T00:00:00Z".into(),
            error: None,
        },
    );
    Server { home, wire_log, registry }
}

/// The repo of the run on this Mac, and its copy on the server (`~/work/<name>`).
fn repos(root: &Path, srv: &Server, on_server: bool) -> RepoRef {
    let local = fixture_repo(root);
    if on_server {
        let dest = srv.home.join("work").join(local.path.file_name().unwrap());
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        let out = std::process::Command::new("git").args(["clone", "-q"]).arg(&local.path).arg(&dest).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }
    local
}

fn host(data: &Path, srv: &Server) -> (AgentHost, Arc<Collector>) {
    let mut cfg = config(data, sidecar_js());
    cfg.servers = Some(srv.registry.clone());
    host_with(cfg)
}

fn start_on(host: &AgentHost, repo: &RepoRef, role: &str, location: Option<&str>) -> Result<intely_agent_core::api::AgentSummary, intely_core::EngineError> {
    let def = host.find_role(role, std::slice::from_ref(repo)).expect("role");
    host.start_role_with(
        &def,
        AgentStartRequest { role: role.into(), repo_ids: vec![repo.id.clone()], prompt: "go".into(), mode: None, mcp_servers: None },
        std::slice::from_ref(repo),
        StartOptions { location: location.map(str::to_string), ..Default::default() },
    )
}

fn wire(srv: &Server) -> Vec<serde_json::Value> {
    std::fs::read_to_string(&srv.wire_log).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

#[test]
fn a_run_on_a_server_works_in_the_servers_folders_with_its_own_git_guard() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let srv = server(&root, 2, "cat");
    let repo = repos(&root, &srv, true);
    let (host, sink) = host(&root.join("data"), &srv);
    let run = start_on(&host, &repo, "mock-plain-reply", Some("srv")).expect("start");
    assert_eq!(run.location.as_deref(), Some("srv"));
    let end = sink.wait_turn_end(&run.agent_id);
    assert_eq!(stop_reason(&end), "EndTurn");

    // the session was opened on the server: its folders, its Claude, its git guard, and none of this Mac's environment
    let start = wire(&srv).into_iter().find(|m| m["type"] == "session/start").expect("session/start reached the sidecar there");
    let body = &start["body"];
    let remote_repo = srv.home.join("work").join(repo.path.file_name().unwrap());
    assert_eq!(body["cwd"], remote_repo.display().to_string(), "{body}");
    assert!(body["addDirs"].as_array().is_none_or(Vec::is_empty), "no attachment folder of this Mac: {body}");
    // (the scripted mock provider has no Claude CLI; a Claude run gets the one found on the server, see `claude_bin` in host.rs)
    assert!(body["env"].get("claudeBin").is_none_or(serde_json::Value::is_null), "{body}");
    assert!(body["env"].get("vars").is_none(), "the login environment of this Mac stays here: {body}");
    let shim = body["env"]["shimDir"].as_str().unwrap();
    assert_eq!(shim, srv.home.join(".intely/shims").join(&run.agent_id).display().to_string());
    let guard = std::fs::read_to_string(Path::new(shim).join("git")).expect("the git guard was uploaded");
    assert!(guard.contains(&format!("REAL_GIT='{}'", real_git())) && guard.contains("refusals.log"), "{guard}");
    assert!(body.get("planDir").is_none());

    // no snapshot of the local repo, no slot of this Mac's gate
    let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("data/runs").join(format!("{}.meta.json", run.agent_id))).unwrap()).unwrap();
    assert_eq!(meta["location"], "srv");
    assert!(meta["snapshots"].as_array().unwrap().is_empty());
    assert_eq!(meta["remote"]["home"], srv.home.display().to_string());
    assert_eq!(meta["remote"]["dirs"][0], remote_repo.display().to_string());
    let listed = host.list();
    assert_eq!(listed[0].location.as_deref(), Some("srv"));
    assert_eq!(listed[0].status, RunStatus::Done);
    host.shutdown();
}

#[test]
fn the_broker_judges_the_servers_paths_through_the_sidecar() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let srv = server(&root, 2, "cat");
    let repo = repos(&root, &srv, true);
    let (host, sink) = host(&root.join("data"), &srv);
    // the scripted agent runs `touch twice` in the server's folder: in Edit mode the broker asks, and it asked after looking
    let run = start_on(&host, &repo, "mock-bash-twice", Some("srv")).expect("start");
    let card = sink.wait_kind(&run.agent_id, "permission.request");
    assert!(matches!(card.kind, EventKind::PermissionRequest { .. }));
    let queries: Vec<serde_json::Value> = wire(&srv).into_iter().filter(|m| m["type"] == "fs/query").collect();
    assert!(!queries.is_empty(), "the policy looked at the server's files through fs/query");
    let paths: Vec<String> = queries.iter().flat_map(|q| q["body"]["ops"].as_array().cloned().unwrap_or_default()).filter_map(|o| o["path"].as_str().map(str::to_string)).collect();
    assert!(paths.iter().all(|p| p.starts_with('/')), "{paths:?}");
    assert!(paths.iter().any(|p| p.starts_with(&srv.home.display().to_string())), "the folders of the server were looked at: {paths:?}");
    host.shutdown();
}

/// Runs `f` on a thread and waits for it; a host that deadlocks fails the test instead of hanging it.
fn within<R: Send + 'static>(secs: u64, what: &str, f: impl FnOnce() -> R + Send + 'static) -> R {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(std::time::Duration::from_secs(secs)).unwrap_or_else(|_| panic!("{what} did not return within {secs} s: the host is stuck"))
}

#[test]
fn answering_a_card_of_a_run_on_a_server_does_not_freeze_the_host() {
    // Allowing a card judges the click again with the current rules, and for a run on a server that look goes down the sidecar of the
    // server. It was made while the host held its state lock, and the look needed that lock: the first click on any card of a run on a
    // server froze every call of the host.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let srv = server(&root, 2, "cat");
    let repo = repos(&root, &srv, true);
    let (host, sink) = host(&root.join("data"), &srv);
    let host = Arc::new(host);
    let run = start_on(&host, &repo, "mock-bash-twice", Some("srv")).expect("start");
    let card = sink.wait_kind(&run.agent_id, "permission.request");
    let EventKind::PermissionRequest { req_id, .. } = &card.kind else { unreachable!() };
    let (h, id, req) = (host.clone(), run.agent_id.clone(), req_id.clone());
    within(30, "answering the card", move || h.answer_permission(&id, &req, PermissionDecision::AllowOnce)).expect("the answer is taken");
    let resolved = sink.wait_kind(&run.agent_id, "permission.resolved");
    assert!(matches!(resolved.kind, EventKind::PermissionResolved { .. }));
    // the host answers other calls while a run on a server works
    let h = host.clone();
    let listed = within(10, "list", move || h.list());
    assert_eq!(listed[0].location.as_deref(), Some("srv"));
    host.shutdown();
}

#[test]
fn a_server_that_cannot_answer_for_its_files_denies_instead_of_guessing() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    // the node there never sees a file-system question: the broker cannot look, so it must not allow (and must not ask either)
    let srv = server(&root, 2, "grep --line-buffered -v '\"type\":\"fs/query\"'");
    let repo = repos(&root, &srv, true);
    let (host, sink) = host(&root.join("data"), &srv);
    let run = start_on(&host, &repo, "mock-bash-twice", Some("srv")).expect("start");
    let resolved = sink.wait(&run.agent_id, "a denial", 40, |e| matches!(&e.kind, EventKind::PermissionResolved { .. }));
    match resolved.kind {
        EventKind::PermissionResolved { outcome, by, .. } => {
            assert_eq!(format!("{outcome:?}"), "Deny");
            assert_eq!(format!("{by:?}"), "FailClosed");
        }
        other => panic!("{other:?}"),
    }
    host.shutdown();
}

fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new(real_git()).arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn another_repository_under_the_same_folder_name_is_not_worked_on() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let srv = server(&root, 2, "cat");
    let repo = repos(&root, &srv, true);
    let theirs = srv.home.join("work").join(repo.path.file_name().unwrap());
    git(&repo.path, &["remote", "add", "origin", "https://example.com/org/app.git"]);
    // the folder there is a copy of somebody else's project
    git(&theirs, &["remote", "set-url", "origin", "https://example.com/other/app.git"]);
    let (host, sink) = host(&root.join("data"), &srv);
    let e = start_on(&host, &repo, "mock-plain-reply", Some("srv")).unwrap_err();
    assert_eq!(e.code, "repoOriginMismatch", "{e:?}");
    assert!(e.message.contains("other/app") && e.message.contains("org/app"), "{}", e.message);
    // the same repository, spelled the ssh way and with credentials on this Mac's side, is the same repository
    git(&theirs, &["remote", "set-url", "origin", "git@example.com:org/app.git"]);
    git(&repo.path, &["remote", "set-url", "origin", "https://user:token@example.com/org/app"]);
    let run = start_on(&host, &repo, "mock-plain-reply", Some("srv")).expect("the same repository");
    sink.wait_turn_end(&run.agent_id);
    host.shutdown();
}

#[test]
fn two_repositories_with_one_folder_name_do_not_share_a_folder_on_the_server() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let srv = server(&root, 2, "cat");
    let a = repos(&root, &srv, true);
    // a second local repository whose folder has the same name as the first
    let other_parent = root.join("elsewhere");
    std::fs::create_dir_all(&other_parent).unwrap();
    let same_name = other_parent.join(a.path.file_name().unwrap());
    std::fs::create_dir_all(&same_name).unwrap();
    git(&same_name, &["init", "-q"]);
    let b = RepoRef { id: "second".into(), path: same_name };
    let (host, _sink) = host(&root.join("data"), &srv);
    let def = host.find_role("mock-plain-reply", std::slice::from_ref(&a)).expect("role");
    let both = vec![a.clone(), b.clone()];
    let e = host
        .start_role_with(&def, AgentStartRequest { role: def.name.clone(), repo_ids: vec![a.id.clone(), b.id.clone()], prompt: "go".into(), mode: None, mcp_servers: None }, &both, StartOptions { location: Some("srv".into()), ..Default::default() })
        .unwrap_err();
    assert_eq!(e.code, "remoteRepoName", "{e:?}");
    host.shutdown();
}

fn session_closes(srv: &Server) -> Vec<String> {
    wire(srv).into_iter().filter(|m| m["type"] == "session/close").filter_map(|m| m["body"]["agentId"].as_str().map(str::to_string)).collect()
}

fn wait_until(what: &str, secs: u64, mut ok: impl FnMut() -> bool) {
    let end = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    while !ok() {
        assert!(std::time::Instant::now() < end, "timed out waiting for {what}");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[test]
fn a_full_server_makes_room_by_closing_the_session_of_a_finished_run() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let srv = server(&root, 1, "cat");
    let repo = repos(&root, &srv, true);
    let (host, sink) = host(&root.join("data"), &srv);
    let first = start_on(&host, &repo, "mock-plain-reply", Some("srv")).expect("first");
    sink.wait_turn_end(&first.agent_id);
    // the limit is one session, and the first run is finished but still holds its session for follow-ups: it gives the place up
    let second = start_on(&host, &repo, "mock-plain-reply", Some("srv")).expect("the finished run makes room");
    sink.wait_turn_end(&second.agent_id);
    wait_until("the first session to be closed on the server", 10, || session_closes(&srv).contains(&first.agent_id));
    // it is still in the list, finished, and resumes with its next message (which makes room in turn)
    assert!(host.list().iter().any(|s| s.agent_id == first.agent_id && s.status == RunStatus::Done));
    host.resume(&first.agent_id).expect("the first run comes back");
    wait_until("the second session to be closed", 10, || session_closes(&srv).contains(&second.agent_id));
    host.shutdown();
}

#[test]
fn a_server_whose_sessions_all_work_or_wait_refuses_a_start_and_a_resume() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let srv = server(&root, 1, "cat");
    let repo = repos(&root, &srv, true);
    let (host, sink) = host(&root.join("data"), &srv);
    let finished = start_on(&host, &repo, "mock-plain-reply", Some("srv")).expect("first");
    sink.wait_turn_end(&finished.agent_id);
    // a run that waits for the person takes the only place (the finished run gives it up)
    let waiting = start_on(&host, &repo, "mock-bash-twice", Some("srv")).expect("start");
    sink.wait_kind(&waiting.agent_id, "permission.request");
    let e = start_on(&host, &repo, "mock-plain-reply", Some("srv")).unwrap_err();
    assert_eq!(e.code, "serverBusy", "{e:?}");
    assert!(e.message.contains("none of them is finished"), "{}", e.message);
    // the finished run cannot come back while the server is full of runs that work or wait
    let e = host.resume(&finished.agent_id).unwrap_err();
    assert_eq!(e.code, "serverBusy", "{e:?}");
    host.shutdown();
}

#[test]
fn a_finished_session_on_a_server_is_closed_after_a_while() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let srv = server(&root, 4, "cat");
    let repo = repos(&root, &srv, true);
    let mut cfg = config(&root.join("data"), sidecar_js());
    cfg.servers = Some(srv.registry.clone());
    cfg.remote_idle = std::time::Duration::from_millis(400);
    let (host, sink) = host_with(cfg);
    let run = start_on(&host, &repo, "mock-plain-reply", Some("srv")).expect("start");
    sink.wait_turn_end(&run.agent_id);
    wait_until("the idle session to be closed on the server", 20, || session_closes(&srv).contains(&run.agent_id));
    host.shutdown();
}

#[test]
fn a_server_is_released_when_its_runs_are_finished_not_while_one_waits() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let srv = server(&root, 4, "cat");
    let repo = repos(&root, &srv, true);
    let (host, sink) = host(&root.join("data"), &srv);
    let done = start_on(&host, &repo, "mock-plain-reply", Some("srv")).expect("start");
    sink.wait_turn_end(&done.agent_id);
    let waiting = start_on(&host, &repo, "mock-bash-twice", Some("srv")).expect("start");
    sink.wait_kind(&waiting.agent_id, "permission.request");
    let e = host.release_server("srv").unwrap_err();
    assert_eq!(e.code, "serverBusy", "{e:?}");
    assert!(session_closes(&srv).is_empty(), "nothing was closed by a refused release");
    // once the waiting run is stopped, the server can be let go: the sessions are closed and the connection with them
    host.interrupt(&waiting.agent_id).expect("stop");
    wait_until("the stopped run to let go of the server", 30, || host.release_server("srv").is_ok());
    wait_until("both sessions to be closed on the server", 10, || {
        let closed = session_closes(&srv);
        closed.contains(&done.agent_id) && closed.contains(&waiting.agent_id)
    });
    // a new run starts a new connection
    let again = start_on(&host, &repo, "mock-plain-reply", Some("srv")).expect("a new run after the release");
    sink.wait_turn_end(&again.agent_id);
    host.shutdown();
}

#[test]
fn a_start_is_refused_with_a_reason_the_person_can_act_on() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let srv = server(&root, 1, "cat");
    // the repo is not on the server
    let repo = repos(&root, &srv, false);
    let (host, _sink) = host(&root.join("data"), &srv);
    let e = start_on(&host, &repo, "mock-plain-reply", Some("srv")).unwrap_err();
    assert_eq!(e.code, "repoMissingOnServer", "{e:?}");
    assert!(e.message.contains("Settings > Servers"), "{}", e.message);
    // an unknown server, MCP, a provider that is not Claude
    assert_eq!(start_on(&host, &repo, "mock-plain-reply", Some("nope")).unwrap_err().code, "serverNotReady");
    let def = host.find_role("mock-plain-reply", std::slice::from_ref(&repo)).unwrap();
    let with_mcp = host.start_role_with(&def, AgentStartRequest { role: def.name.clone(), repo_ids: vec![repo.id.clone()], prompt: "go".into(), mode: None, mcp_servers: Some(vec!["x".into()]) }, std::slice::from_ref(&repo), StartOptions { location: Some("srv".into()), ..Default::default() });
    assert_eq!(with_mcp.unwrap_err().code, "remoteMcp");
    host.shutdown();
}
