//! The host against the real Claude CLI (Haiku), no window: edit through the editing tool, git writes refused, Rewind,
//! and the RSS of the sidecar and of the whole agent tree. Costs a few cents, so it runs only with `INTELY_LIVE=1`:
//! `INTELY_LIVE=1 cargo test -p intely-agent-host --test live -- --nocapture`.

mod common;

use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use common::*;
use intely_agent_core::api::{AgentStartRequest, PermissionDecision};
use intely_agent_core::events::invariants::InvariantChecker;
use intely_agent_core::events::types::{DecidedBy, EventKind, PermissionOutcome, ToolStatus};

const HAIKU: &str = "claude-haiku-4-5-20251001";

fn live_env() -> HashMap<String, String> {
    ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "NVM_DIR"].iter().filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v))).collect()
}

/// RSS in MB of `root` and of everything below it, from one `ps` listing.
fn tree_rss_mb(root: u32) -> (u64, usize) {
    let out = Command::new("ps").args(["-axo", "pid=,ppid=,rss="]).output().expect("ps");
    let rows: Vec<(u32, u32, u64)> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace().map(|x| x.parse::<u64>().ok());
            Some((it.next()??.try_into().ok()?, it.next()??.try_into().ok()?, it.next()??))
        })
        .collect();
    let mut tree: HashSet<u32> = HashSet::from([root]);
    loop {
        let before = tree.len();
        for (pid, ppid, _) in &rows {
            if tree.contains(ppid) {
                tree.insert(*pid);
            }
        }
        if tree.len() == before {
            break;
        }
    }
    let kb: u64 = rows.iter().filter(|(pid, _, _)| tree.contains(pid)).map(|r| r.2).sum();
    (kb / 1024, tree.len())
}

fn rss_mb(pid: u32) -> u64 {
    let out = Command::new("ps").args(["-o", "rss=", "-p", &pid.to_string()]).output().expect("ps");
    String::from_utf8_lossy(&out.stdout).trim().parse::<u64>().map_or(0, |kb| kb / 1024)
}

#[test]
fn a_live_claude_run_edits_is_refused_git_writes_and_rewinds() {
    if std::env::var("INTELY_LIVE").as_deref() != Ok("1") {
        eprintln!("skipped: set INTELY_LIVE=1 to call the real Claude CLI");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let remote = dir.path().join("remote.git");
    git(dir.path(), &["init", "-q", "--bare", remote.to_str().unwrap()]);
    git(&repo.path, &["remote", "add", "origin", remote.to_str().unwrap()]);
    let head_before = git(&repo.path, &["rev-parse", "HEAD"]);

    let mut cfg = config(&dir.path().join("data"), sidecar_js());
    cfg.providers = vec!["claude".into()];
    cfg.env = Arc::new(live_env);
    cfg.model_override = Some(HAIKU.into());
    cfg.max_budget_usd = Some(0.10);
    cfg.start_timeout = Duration::from_secs(60);
    let (host, sink) = host_with(cfg);

    let prompt = "This is an automated test in a throwaway repository. Step 1: use the Write tool to create the file NOTES.txt in the repository root with exactly the text: agent was here. \
                  Step 2: run the shell command `git add -A && git commit -m agent` and show me its output, even if you expect it to fail. \
                  Step 3: run the shell command `git push origin HEAD` and show me its output, even if you expect it to fail. Then stop.";
    let id = host.start(AgentStartRequest { role: "developer".into(), repo_ids: vec![repo.id.clone()], prompt: prompt.into(), mode: None, mcp_servers: None }, std::slice::from_ref(&repo)).expect("start").agent_id;

    // The user's side: allow every permission card (the hard stops never reach one), and sample the RSS while it runs.
    let stop = Arc::new(AtomicBool::new(false));
    let sampler = {
        let (host, sink, stop, id) = (host.clone(), sink.clone(), stop.clone(), id.clone());
        std::thread::spawn(move || {
            let mut answered = HashSet::new();
            let (mut sidecar_peak, mut tree_peak, mut procs) = (0, 0, 0);
            while !stop.load(Ordering::Relaxed) {
                for e in sink.of(&id) {
                    if let EventKind::PermissionRequest { req_id, .. } = &e.kind {
                        if answered.insert(req_id.clone()) {
                            let _ = host.answer_permission(&id, req_id, PermissionDecision::AllowOnce);
                        }
                    }
                }
                if let Some(pid) = host.sidecar_pid() {
                    let (tree, n) = tree_rss_mb(pid);
                    sidecar_peak = sidecar_peak.max(rss_mb(pid));
                    if tree > tree_peak {
                        (tree_peak, procs) = (tree, n);
                    }
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            (sidecar_peak, tree_peak, procs)
        })
    };
    let end = sink.wait(&id, "turn.end", 170, |e| e.kind.name() == "turn.end");
    stop.store(true, Ordering::Relaxed);
    let (sidecar_peak, tree_peak, procs) = sampler.join().unwrap();
    println!("RSS_MB sidecar_peak={sidecar_peak} tree_peak={tree_peak} processes={procs}");
    println!("turn.end {:?}", end.kind);

    let events = sink.of(&id);
    let mut checker = InvariantChecker::new();
    let violations: Vec<_> = events.iter().flat_map(|e| checker.push(e)).collect();
    assert!(violations.is_empty(), "invariants violated: {violations:?}");

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

    // Nothing landed in git, local or remote.
    assert_eq!(git(&repo.path, &["rev-parse", "HEAD"]), head_before, "no commit landed");
    assert_eq!(git(&remote, &["for-each-ref", "refs/heads"]), "", "nothing was pushed");
    assert!(repo.path.join("NOTES.txt").is_file(), "the edit itself happened");
    assert!(!git(&repo.path, &["rev-parse", "--verify", &format!("refs/intely/snapshots/{id}")]).is_empty(), "the Rewind snapshot ref exists");

    host.rewind(&id).expect("rewind");
    assert!(!repo.path.join("NOTES.txt").exists(), "rewind removed the agent's file");
    assert_eq!(git(&repo.path, &["status", "--porcelain"]), "", "the tree is clean again");
    host.shutdown();
    assert_eq!(host.sidecar_pid(), None);
}

/// The Test run of the Roles editor against the real Claude CLI: one read-only session in an empty scratch folder, no prompt, so no
/// model call and no cost. Prints what Claude reports at session start (the negotiated capabilities, if it reports any).
#[test]
fn a_live_claude_test_run_opens_a_session_without_a_prompt_and_leaves_nothing() {
    if std::env::var("INTELY_LIVE").as_deref() != Ok("1") {
        eprintln!("skipped: set INTELY_LIVE=1 to open the real Claude CLI (no model call is made)");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(&dir.path().join("data"), sidecar_js());
    cfg.providers = vec!["claude".into()];
    cfg.env = Arc::new(live_env);
    cfg.start_timeout = Duration::from_secs(60);
    let (host, sink) = host_with(cfg);
    let report = host.probe("claude", Some(HAIKU)).expect("probe");
    eprintln!("probe report: {}", serde_json::to_string(&report).unwrap());
    assert!(report.ok, "{report:?}");
    assert!(host.list().is_empty() && sink.all().is_empty(), "nothing stored or published");
    assert!(!dir.path().join("data/probe").read_dir().map(|mut d| d.next().is_some()).unwrap_or(false), "the scratch folder is gone");
    host.shutdown();
}
