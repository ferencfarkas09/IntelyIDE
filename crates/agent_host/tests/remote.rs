//! A run on a server: the real host, the real sidecar bundle and the mock provider, reached through a fake `ssh` that runs the
//! command on this machine under another HOME (the "server"). The permission broker judges the server's files through the sidecar's
//! `fs/query`, the git guard is uploaded, nothing of this Mac's login shell is sent, and a server that cannot answer denies.

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::*;
use intely_agent_core::api::{AgentStartRequest, RunStatus};
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
