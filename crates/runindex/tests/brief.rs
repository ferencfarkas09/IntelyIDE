mod common;

use std::fs;
use std::path::Path;
use std::process::Command;

use common::*;
use intely_agent_core::events::types::*;
use intely_core::jail::Jail;
use intely_runindex::brief::{build, facts_text, DiffSource, FileChange, GitDiff};
use serde_json::json;

struct Fake(Result<Vec<FileChange>, String>);

impl DiffSource for Fake {
    fn changes(&self, _: &Path, _: &str) -> Result<Vec<FileChange>, String> {
        self.0.clone()
    }
}

fn change(path: &str, kind: &str, a: u32, d: u32) -> FileChange {
    FileChange { path: path.into(), change: kind.into(), additions: a, deletions: d }
}

fn meta_with_snapshots(repos: &[(&str, &str)]) -> serde_json::Value {
    json!({ "role": "developer", "model": "claude-haiku-4-5-20251001", "startedAt": 1,
        "repos": repos.iter().map(|(id, p)| json!({ "id": id, "path": p })).collect::<Vec<_>>(),
        "snapshots": repos.iter().map(|(id, p)| json!({ "repoId": id, "path": p, "refName": "refs/intely/snapshots/r", "skipped": 0 })).collect::<Vec<_>>() })
}

#[test]
fn a_finished_run_reports_changes_cost_and_nothing_failed() {
    let dir = tempfile::tempdir().unwrap();
    let runs = dir.path();
    finished("r1", "Fix the fee").write(runs, Some(meta_with_snapshots(&[("backend", "/x/backend")])));
    let git = Fake(Ok(vec![change("src/a.js", "modified", 3, 1), change("src/b.js", "created", 10, 0)]));
    let brief = build(runs, &["r1".into(), "missing".into()], &git, 99);
    assert_eq!(brief.runs.len(), 1, "a run without a log is skipped");
    let r = &brief.runs[0];
    assert_eq!((r.status.as_str(), r.cost_usd, r.tokens), ("done", Some(0.0123), 4_900));
    assert_eq!((r.repos[0].file_count, r.repos[0].additions, r.repos[0].deletions), (2, 13, 1));
    assert!(r.failures.is_empty() && r.needs_you.is_empty());
    assert_eq!((brief.totals.runs, brief.totals.files, brief.totals.additions, brief.totals.cost_usd), (1, 2, 13, Some(0.0123)));
}

#[test]
fn failures_are_collected_from_tools_errors_and_the_stop_reason() {
    let dir = tempfile::tempdir().unwrap();
    let mut l = Log::new("bad");
    l.prompt("Run the tests")
        .tool("t1", "Bash", ToolKind::Exec, json!({ "command": "npm test" }), ToolStatus::Error, Some(&format!("1 failed\nGITHUB_TOKEN={TOKEN}")))
        .push(EventKind::Error { class: ErrorClass::Provider, message: "provider hiccup".into(), retryable: true })
        .end(StopReason::MaxTurns);
    l.write(dir.path(), Some(meta("developer", &["backend"], 1)));
    let brief = build(dir.path(), &["bad".into()], &Fake(Err("x".into())), 1);
    let r = &brief.runs[0];
    assert_eq!(r.status, "failed");
    assert_eq!(r.failure_count, 3);
    assert_eq!(r.failures[0].text, "Bash: 1 failed");
    assert_eq!(r.failures[2].text, "maxturns");
    assert_eq!(brief.totals.failed, 1);
    assert_eq!(r.cost_usd, None, "no usage event, no number");
    assert_eq!(brief.totals.cost_usd, None);
    assert!(!serde_json::to_string(&brief).unwrap().contains("ghp_"));
}

#[test]
fn unanswered_needs_you_items_are_listed_and_answered_ones_are_not() {
    let dir = tempfile::tempdir().unwrap();
    let mut l = Log::new("wait");
    l.prompt("Clean up")
        .push(EventKind::ToolStart { tool_id: "t1".into(), name: "Bash".into(), tool_kind: ToolKind::Exec, input: json!({}), parent_tool_id: None })
        .permission("p1", "t1", "rm -rf build")
        .push(EventKind::PermissionResolved { req_id: "p1".into(), outcome: PermissionOutcome::Allow, by: DecidedBy::User })
        .push(EventKind::ToolStart { tool_id: "t2".into(), name: "Bash".into(), tool_kind: ToolKind::Exec, input: json!({}), parent_tool_id: None })
        .permission("p2", "t2", "git push origin main")
        .push(EventKind::QuestionRequest { req_id: "q1".into(), tool_id: None, prompt: "Which branch should I use?".into(), options: vec![] });
    l.write(dir.path(), Some(meta("developer", &["backend"], 1)));
    let brief = build(dir.path(), &["wait".into()], &Fake(Ok(vec![])), 1);
    let needs = &brief.runs[0].needs_you;
    assert_eq!(needs.len(), 2);
    assert_eq!((needs[0].kind.as_str(), needs[0].text.as_str()), ("permission", "Bash: git push origin main"));
    assert_eq!((needs[1].kind.as_str(), needs[1].text.as_str()), ("question", "Which branch should I use?"));
    assert_eq!(brief.runs[0].status, "running");
    assert_eq!(brief.totals.needs_you, 2);

    // The agent moving on after the question means it was answered.
    l.reply("Using main.").end(StopReason::EndTurn);
    l.write(dir.path(), Some(meta("developer", &["backend"], 1)));
    let brief = build(dir.path(), &["wait".into()], &Fake(Ok(vec![])), 1);
    assert_eq!(brief.runs[0].needs_you.len(), 1, "only the open permission remains");
}

#[test]
fn repos_without_a_snapshot_or_with_unreadable_git_say_why() {
    let dir = tempfile::tempdir().unwrap();
    finished("r1", "x").write(dir.path(), Some(json!({ "role": "developer", "repos": [{ "id": "backend", "path": "/x" }, { "id": "admin", "path": "/y" }], "startedAt": 1,
        "snapshots": [{ "repoId": "backend", "path": "/x", "refName": "refs/intely/snapshots/r1", "skipped": 0 }] })));
    let brief = build(dir.path(), &["r1".into()], &Fake(Err("no git".into())), 1);
    let notes: Vec<_> = brief.runs[0].repos.iter().map(|r| (r.repo_id.as_str(), r.note.as_deref())).collect();
    assert_eq!(notes, vec![("backend", Some("gitUnavailable")), ("admin", Some("noSnapshot"))]);
}

#[test]
fn facts_for_the_summary_hold_no_prompt_bodies_or_replies() {
    let dir = tempfile::tempdir().unwrap();
    finished("r1", "Fix the fee\nconfidential business details").write(dir.path(), Some(meta_with_snapshots(&[("backend", "/x")])));
    let brief = build(dir.path(), &["r1".into()], &Fake(Ok(vec![change("src/a.js", "modified", 1, 1)])), 1);
    let text = facts_text(&brief);
    assert!(text.contains("src/a.js") && text.contains("+1 -1"));
    assert!(text.contains("Fix the fee"), "the title (first prompt line) is a fact");
    assert!(!text.contains("confidential") && !text.contains("delivery fee"), "{text}");
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn git_diff_against_a_snapshot_ref_in_a_throwaway_repo() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    fs::write(repo.join("src/keep.js"), "a\nb\nc\n").unwrap();
    fs::write(repo.join("src/gone.js"), "x\ny\n").unwrap();
    fs::write(repo.join("src/edit.js"), "1\n2\n3\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    // untracked files the snapshot captures: one stays as it was, one is changed by the run
    fs::write(repo.join("src/untouched.txt"), "u1\nu2\n").unwrap();
    fs::write(repo.join("src/scratch.txt"), "s1\ns2\n").unwrap();
    // the snapshot, built like Rewind does: the whole working tree in a temporary index
    let idx = tmp.path().join("snap-index");
    let run = |args: &[&str]| {
        let o = Command::new("git").arg("-C").arg(&repo).args(args).env("GIT_INDEX_FILE", &idx).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_SYSTEM", "/dev/null").env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t").output().unwrap();
        assert!(o.status.success(), "{args:?}");
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    };
    run(&["add", "-A"]);
    let tree = run(&["write-tree"]);
    let commit = run(&["commit-tree", &tree, "-p", "HEAD", "-m", "snap"]);
    git(&repo, &["update-ref", "refs/intely/snapshots/r1", &commit]);
    fs::write(repo.join("src/scratch.txt"), "s1\ns2\ns3\n").unwrap();
    // what a run does afterwards
    fs::write(repo.join("src/edit.js"), "1\n2\n3\n4\n5\n").unwrap();
    fs::remove_file(repo.join("src/gone.js")).unwrap();
    fs::write(repo.join("src/new.js"), "n1\nn2\nn3\n").unwrap();
    let src = GitDiff { jail: Jail::global() };
    let changes = src.changes(&repo, "refs/intely/snapshots/r1").unwrap();
    let by = |p: &str| changes.iter().find(|c| c.path == p).unwrap_or_else(|| panic!("{p} missing in {changes:?}"));
    assert_eq!((by("src/edit.js").change.as_str(), by("src/edit.js").additions, by("src/edit.js").deletions), ("modified", 2, 0));
    assert_eq!((by("src/gone.js").change.as_str(), by("src/gone.js").deletions), ("deleted", 2));
    assert_eq!((by("src/new.js").change.as_str(), by("src/new.js").additions), ("created", 3));
    assert!(changes.iter().all(|c| c.path != "src/keep.js"));
    assert!(changes.iter().all(|c| c.path != "src/untouched.txt"), "an untracked file that did not change is not a change: {changes:?}");
    assert_eq!((by("src/scratch.txt").change.as_str(), by("src/scratch.txt").additions, by("src/scratch.txt").deletions), ("modified", 1, 0));
    assert!(src.changes(&tmp.path().join("nope"), "refs/intely/snapshots/r1").is_err());
}
