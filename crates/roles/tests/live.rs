//! The supervisor against the real Claude CLI (Haiku): a developer run in a fixture repo writes a file, the permission
//! card is answered, git writes are refused, and Rewind puts the tree back. Costs a few cents, so it runs only with
//! `INTELY_LIVE=1`: `INTELY_LIVE=1 cargo test -p intely-roles --test live -- --nocapture`.
//! The transcript store is the real one (the CLI login lives there); only the fixture repo and the data dir are throwaway.

mod common;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use common::*;
use intely_agent_core::api::PermissionDecision;
use intely_agent_core::events::invariants::InvariantChecker;
use intely_agent_core::events::types::{DecidedBy, EventKind, PermissionOutcome, ToolStatus};
use intely_agent_host::{AgentHost, RoleResolver};
use intely_roles::types::{RunState, RunsStartRequest};
use intely_roles::{MemoryOverlay, Observer, RoleStore, Supervisor, SupervisorConfig};

const HAIKU: &str = "claude-haiku-4-5-20251001";

#[test]
fn a_live_developer_run_asks_is_refused_git_writes_and_rewinds() {
    if std::env::var("INTELY_LIVE").as_deref() != Ok("1") {
        eprintln!("skipped: set INTELY_LIVE=1 to call the real Claude CLI");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    // The mutation jail applies to the supervisor too: only this fixture may be written.
    std::env::set_var("INTELY_E2E", "1");
    std::env::set_var("INTELY_FIXTURE_ROOT", dir.path());
    let repo = fixture_repo(dir.path(), "repo");
    let remote = dir.path().join("remote.git");
    git(dir.path(), &["init", "-q", "--bare", remote.to_str().unwrap()]);
    git(&repo.path, &["remote", "add", "origin", remote.to_str().unwrap()]);
    let head_before = git(&repo.path, &["rev-parse", "HEAD"]);
    let repos = [repo.clone()];

    let roles = Arc::new(RoleStore::new(dir.path().join("home/.claude/agents"), Box::new(MemoryOverlay::default())).with_backup_dir(dir.path().join("role-backups")));
    let mut cfg = config(&dir.path().join("data"), sidecar_js(), &dir.path().join("claude"));
    cfg.providers = vec!["claude".into()];
    cfg.env = Arc::new(|| ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "NVM_DIR"].iter().filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v))).collect());
    cfg.model_override = Some(HAIKU.into());
    cfg.max_budget_usd = Some(0.10);
    cfg.start_timeout = Duration::from_secs(60);
    let resolver_roles = roles.clone();
    let resolver: RoleResolver = Arc::new(move |name, repos| Some(RoleStore::role_def(&resolver_roles.resolve(name, repos.first().map(|r| r.id.as_str()), repos)?)));
    cfg.role_resolver = Some(resolver);
    let git_cfg = cfg.git.clone();
    let sink = Collector::new();
    let observer = Observer::new(sink.clone());
    let sup = Supervisor::new(AgentHost::new(cfg, observer.clone()), roles, SupervisorConfig { data_dir: dir.path().join("data"), git: git_cfg }, Some(&observer));

    let prompt = "This is an automated test in a throwaway repository. Step 1: use the Write tool to create the file NOTES.txt in the repository root with exactly the text: agent was here. \
                  Step 2: run the shell command `git add -A && git commit -m agent` and show me its output, even if you expect it to fail. \
                  Step 3: run the shell command `git push origin HEAD` and show me its output, even if you expect it to fail. Then stop.";
    let run = sup.start(RunsStartRequest { role_id: "developer".into(), repo_ids: vec![repo.id.clone()], prompt: prompt.into(), mode: None }, &repos).expect("start");
    assert_ne!(run.status, RunState::Queued);
    let id = run.agent_id.clone();

    // The user's side: answer every permission card with "allow once" and count them.
    let stop = Arc::new(AtomicBool::new(false));
    let answerer = {
        let (sup, sink, stop, id) = (sup.clone(), sink.clone(), stop.clone(), id.clone());
        std::thread::spawn(move || {
            let mut answered = HashSet::new();
            while !stop.load(Ordering::Relaxed) {
                for e in sink.of(&id) {
                    if let EventKind::PermissionRequest { req_id, .. } = &e.kind {
                        if answered.insert(req_id.clone()) {
                            let _ = sup.host().answer_permission(&id, req_id, PermissionDecision::AllowOnce);
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            answered.len()
        })
    };
    let end = sink.wait(&id, "turn.end", 170, |e| e.kind.name() == "turn.end");
    stop.store(true, Ordering::Relaxed);
    let answered = answerer.join().unwrap();
    println!("turn.end {:?}; permission cards answered: {answered}", end.kind);

    let events = sink.of(&id);
    let mut checker = InvariantChecker::new();
    let violations: Vec<_> = events.iter().flat_map(|e| checker.push(e)).collect();
    assert!(violations.is_empty(), "invariants violated: {violations:?}");
    println!("event kinds: {:?}", events.iter().map(|e| e.kind.name()).collect::<Vec<_>>());

    let status_of = |tool_id: &str| events.iter().find_map(|e| match &e.kind {
        EventKind::ToolResult { tool_id: t, status, .. } if t == tool_id => Some(*status),
        _ => None,
    });
    let starts: Vec<(&str, &str, String)> = events
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::ToolStart { tool_id, name, input, .. } => Some((tool_id.as_str(), name.as_str(), input.to_string())),
            _ => None,
        })
        .collect();
    let wrote = starts.iter().any(|(id, name, _)| matches!(*name, "Write" | "Edit" | "MultiEdit") && status_of(id) == Some(ToolStatus::Ok));
    assert!(wrote, "the file was written through the editing tool: {:?}", starts.iter().map(|s| s.1).collect::<Vec<_>>());
    let git_writes: Vec<_> = starts.iter().filter(|(_, name, input)| *name == "Bash" && (input.contains("git add") || input.contains("git commit") || input.contains("git push"))).collect();
    assert!(!git_writes.is_empty(), "the model tried the git writes");
    assert!(git_writes.iter().all(|(id, _, _)| status_of(id) != Some(ToolStatus::Ok)), "no git write call succeeded");
    let hard_stops = events.iter().filter(|e| matches!(&e.kind, EventKind::PermissionResolved { outcome: PermissionOutcome::Deny, by: DecidedBy::HardStop, .. })).count();
    assert!(hard_stops >= 1, "the log records the hard stops");

    assert_eq!(git(&repo.path, &["rev-parse", "HEAD"]), head_before, "no commit landed");
    assert_eq!(git(&remote, &["for-each-ref", "refs/heads"]), "", "nothing was pushed");
    assert!(repo.path.join("NOTES.txt").is_file(), "the edit itself happened");

    // The run is listed and billed; Rewind refuses without confirmation, previews, then restores the tree.
    let listed = sup.list();
    assert!(listed.iter().any(|r| r.agent_id == id && r.role == "developer"), "{listed:?}");
    let usage = sup.usage();
    assert!(usage.runs.iter().any(|u| u.agent_id == id), "the usage ledger has the run");
    let snaps = sup.rewind_snapshots(&id).expect("snapshots");
    assert_eq!(snaps.len(), 1);
    assert!(snaps[0].delete.iter().any(|p| p == "NOTES.txt"), "the dry run lists the created file: {:?}", snaps[0].delete);
    assert_eq!(sup.rewind_restore(&id, false, None).unwrap_err().code, "confirmRequired");
    sup.rewind_restore(&id, true, None).expect("rewind");
    assert!(!repo.path.join("NOTES.txt").exists(), "rewind removed the agent's file");
    assert_eq!(git(&repo.path, &["status", "--porcelain"]), "", "the tree is clean again");
    sup.host().shutdown();
    assert_eq!(sup.host().sidecar_pid(), None);
}
