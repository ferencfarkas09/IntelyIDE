//! Rewind snapshots on fixture repos only: the user's index is never touched, restore round-trips tree and index.

mod common;

use common::{real_git, Repo};
use intely_agent_gate::rewind::{Rewind, RewindError};

fn rewind() -> Rewind {
    common::isolate_env();
    Rewind::new(real_git())
}

/// A repo with tracked, staged, modified, untracked, ignored and guarded files.
fn busy_repo() -> Repo {
    let repo = Repo::new();
    repo.write(".gitignore", "*.log\n");
    repo.write("a.txt", "a v1\n");
    repo.write("src/b.txt", "b v1\n");
    repo.write("src/c.txt", "c v1\n");
    repo.commit_all("init");
    repo.write("a.txt", "a v2 unstaged\n");
    repo.write("src/b.txt", "b v2 staged\n");
    repo.git(&["add", "src/b.txt"]);
    repo.write("src/c.txt", "c v2 staged\n");
    repo.git(&["add", "src/c.txt"]);
    repo.write("src/c.txt", "c v3 on top of staged\n");
    repo.write("new.txt", "brand new\n");
    repo.write("ignored.log", "log v1\n");
    repo.write(".env", "SECRET=1\n");
    repo.write("dump_2026/users.json", "{}");
    repo.write("big.bin", vec![7u8; 6 * 1024 * 1024]);
    repo.write("notes/todo.md", "todo\n");
    repo
}

fn staged_view(repo: &Repo) -> (String, String, String) {
    (repo.git(&["ls-files", "-s"]), repo.git(&["diff", "--cached"]), repo.git(&["diff"]))
}

#[test]
fn snapshot_does_not_touch_the_index_or_the_working_tree() {
    let repo = busy_repo();
    repo.git(&["status", "--porcelain"]); // lets git refresh the index once, before the "before" reading
    let before_s = repo.git(&["ls-files", "-s"]);
    let before_status = repo.git(&["status", "--porcelain", "--ignored"]);
    let index_bytes = repo.index_bytes();

    let snap = rewind().snapshot(&repo.path, "run-1").unwrap();

    assert_eq!(repo.index_bytes(), index_bytes, "index file is byte-identical");
    assert_eq!(repo.git(&["ls-files", "-s"]), before_s);
    assert_eq!(repo.git(&["status", "--porcelain", "--ignored"]), before_status);
    assert_eq!(repo.read("a.txt"), "a v2 unstaged\n");
    assert_eq!(snap.ref_name, "refs/intely/snapshots/run-1");
    assert_eq!(repo.git(&["rev-parse", &snap.ref_name]), snap.commit);
    assert_eq!(snap.branch.as_deref(), Some("main"));
    assert_eq!(snap.head.as_deref(), Some(repo.git(&["rev-parse", "HEAD"]).as_str()));
    // no leftover temp indexes in the git dir
    let leftovers: Vec<_> = std::fs::read_dir(repo.path.join(".git")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("intely-")).collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn the_snapshot_holds_tracked_and_guard_clean_untracked_files_and_lists_the_rest() {
    let repo = busy_repo();
    let snap = rewind().snapshot(&repo.path, "run-2").unwrap();
    let files = repo.git(&["ls-tree", "-r", "--name-only", &snap.tree]);
    let files: Vec<&str> = files.lines().collect();
    for want in [".gitignore", "a.txt", "src/b.txt", "src/c.txt", "new.txt", "notes/todo.md"] {
        assert!(files.contains(&want), "{want} missing from {files:?}");
    }
    for unwanted in [".env", "dump_2026/users.json", "big.bin", "ignored.log"] {
        assert!(!files.contains(&unwanted), "{unwanted} must not be in the snapshot");
    }
    assert_eq!(snap.files, 6);
    let mut skipped: Vec<(&str, &str)> = snap.skipped.iter().map(|s| (s.path.as_str(), s.reason)).collect();
    skipped.sort();
    assert_eq!(skipped, [(".env", "secret"), ("big.bin", "tooLarge"), ("dump_2026/users.json", "neverAdd")]);
    // working-tree content, not the index version
    assert_eq!(repo.git(&["show", &format!("{}:a.txt", snap.tree)]), "a v2 unstaged");
    assert_eq!(repo.git(&["show", &format!("{}:src/c.txt", snap.tree)]), "c v3 on top of staged");
    // the index is captured separately
    assert_eq!(repo.git(&["show", &format!("{}:src/c.txt", snap.index_tree)]), "c v2 staged");
    assert!(!repo.git(&["ls-tree", "-r", "--name-only", &snap.index_tree]).contains("new.txt"));
}

#[test]
fn the_commit_has_an_explicit_message_a_fixed_identity_and_no_trailers() {
    let repo = busy_repo();
    let snap = rewind().snapshot(&repo.path, "run-3").unwrap();
    let raw = repo.git(&["cat-file", "commit", &snap.ref_name]);
    assert!(raw.contains("author IntelySwitchIDE <snapshot@intely.invalid>"), "{raw}");
    assert!(raw.contains("intely snapshot run-3"));
    for banned in ["Co-authored", "Co-Authored", "Signed-off", "anthropic", "Claude", "gpgsig"] {
        assert!(!raw.contains(banned), "{banned} in {raw}");
    }
    // the ref lives outside refs/heads and refs/tags, so normal branch/tag views stay clean
    assert!(!repo.git(&["branch", "-a"]).contains("intely"));
    assert!(repo.git(&["tag"]).is_empty());
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), snap.head.unwrap());
}

#[test]
fn restore_round_trips_tree_and_index() {
    let repo = busy_repo();
    repo.git(&["status", "--porcelain"]);
    let before = staged_view(&repo);
    let snap = rewind().snapshot(&repo.path, "run-4").unwrap();

    // what an agent run might do
    repo.write("a.txt", "agent rewrote a\n");
    std::fs::remove_file(repo.path.join("src/b.txt")).unwrap();
    repo.write("created.txt", "by the agent\n");
    repo.write("newdir/deep/x.txt", "x\n");
    repo.write("src/c.txt", "agent c\n");
    repo.git(&["add", "created.txt"]);
    repo.git(&["reset", "-q", "src/c.txt"]);
    repo.write("ignored.log", "log v2 by the agent\n");
    repo.write(".env.local", "LATE=1\n");

    let plan = rewind().plan_restore(&repo.path, "run-4").unwrap();
    assert_eq!(plan.overwrite, ["a.txt", "src/c.txt"]);
    assert_eq!(plan.recreate, ["src/b.txt"]);
    assert_eq!(plan.delete, ["created.txt", "newdir/deep/x.txt"], "only files created after the snapshot, not ignored, not guarded");
    assert!(plan.index_differs && !plan.head_changed);
    let protected: Vec<&str> = plan.protected.iter().map(|s| s.path.as_str()).collect();
    for p in [".env", ".env.local", "dump_2026/users.json", "big.bin"] {
        assert!(protected.contains(&p), "{p} in {protected:?}");
    }
    // a dry run changes nothing
    assert_eq!(repo.read("a.txt"), "agent rewrote a\n");
    assert!(repo.exists("created.txt"));

    assert!(matches!(rewind().restore(&repo.path, "run-4", false), Err(RewindError::ConfirmationRequired)));
    assert_eq!(repo.read("a.txt"), "agent rewrote a\n", "no confirmation, no change");

    let report = rewind().restore(&repo.path, "run-4", true).unwrap();
    assert_eq!((report.overwritten, report.recreated, report.deleted, report.index_restored), (2, 1, 2, true));

    assert_eq!(repo.read("a.txt"), "a v2 unstaged\n");
    assert_eq!(repo.read("src/b.txt"), "b v2 staged\n");
    assert_eq!(repo.read("src/c.txt"), "c v3 on top of staged\n");
    assert!(!repo.exists("created.txt") && !repo.exists("newdir"), "created files and their now-empty directories are gone");
    assert_eq!(repo.read("ignored.log"), "log v2 by the agent\n", "ignored files are never touched");
    assert_eq!(repo.read(".env"), "SECRET=1\n");
    assert_eq!(repo.read(".env.local"), "LATE=1\n", "guarded files are never deleted");
    assert!(repo.exists("big.bin") && repo.exists("dump_2026/users.json"));
    assert_eq!(staged_view(&repo), before, "index entries, staged diff and unstaged diff are what they were");
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), snap.head.unwrap());

    // a second plan is empty
    assert!(rewind().plan_restore(&repo.path, "run-4").unwrap().is_empty());
}

#[test]
fn restore_of_an_untouched_tree_is_a_no_op() {
    let repo = busy_repo();
    repo.git(&["status", "--porcelain"]);
    rewind().snapshot(&repo.path, "run-5").unwrap();
    let index = repo.index_bytes();
    let plan = rewind().plan_restore(&repo.path, "run-5").unwrap();
    assert!(plan.is_empty(), "{plan:?}");
    let report = rewind().restore(&repo.path, "run-5", true).unwrap();
    assert_eq!((report.overwritten, report.recreated, report.deleted, report.index_restored), (0, 0, 0, false));
    assert_eq!(repo.index_bytes(), index);
}

#[test]
fn snapshots_work_in_a_repo_without_commits() {
    let repo = Repo::new();
    repo.write("x.txt", "x\n");
    repo.git(&["add", "x.txt"]);
    repo.write("y.txt", "y\n");
    let snap = rewind().snapshot(&repo.path, "unborn").unwrap();
    assert_eq!(snap.head, None);
    repo.write("x.txt", "x changed\n");
    repo.write("z.txt", "z\n");
    std::fs::remove_file(repo.path.join("y.txt")).unwrap();
    rewind().restore(&repo.path, "unborn", true).unwrap();
    assert_eq!((repo.read("x.txt").as_str(), repo.read("y.txt").as_str()), ("x\n", "y\n"));
    assert!(!repo.exists("z.txt"));
    assert_eq!(repo.git(&["ls-files", "-s"]).lines().count(), 1);
}

#[test]
fn restore_refuses_while_a_merge_rebase_or_cherry_pick_is_in_progress() {
    let repo = Repo::new();
    repo.write("f.txt", "base\n");
    repo.commit_all("base");
    repo.git(&["checkout", "-q", "-b", "other"]);
    repo.write("g.txt", "other\n");
    repo.commit_all("other");
    repo.git(&["checkout", "-q", "main"]);
    rewind().snapshot(&repo.path, "pre-merge").unwrap();
    repo.git(&["merge", "--no-commit", "--no-ff", "other"]);
    let err = rewind().restore(&repo.path, "pre-merge", true).unwrap_err();
    assert!(matches!(err, RewindError::InProgress("a merge")), "{err}");
    assert!(matches!(rewind().plan_restore(&repo.path, "pre-merge"), Err(RewindError::InProgress(_))));
    repo.git(&["merge", "--abort"]);

    for (marker, what) in [(".git/rebase-merge", "a rebase"), (".git/rebase-apply", "a rebase or am")] {
        std::fs::create_dir_all(repo.path.join(marker)).unwrap();
        let err = rewind().restore(&repo.path, "pre-merge", true).unwrap_err();
        assert!(matches!(err, RewindError::InProgress(w) if w == what), "{err}");
        std::fs::remove_dir(repo.path.join(marker)).unwrap();
    }
    for (marker, what) in [(".git/CHERRY_PICK_HEAD", "a cherry-pick"), (".git/REVERT_HEAD", "a revert")] {
        std::fs::write(repo.path.join(marker), repo.git(&["rev-parse", "HEAD"])).unwrap();
        let err = rewind().restore(&repo.path, "pre-merge", true).unwrap_err();
        assert!(matches!(err, RewindError::InProgress(w) if w == what), "{err}");
        std::fs::remove_file(repo.path.join(marker)).unwrap();
    }
    rewind().restore(&repo.path, "pre-merge", true).expect("fine once nothing is in progress");
}

#[test]
fn a_conflicted_index_cannot_be_snapshotted_or_restored() {
    let repo = Repo::new();
    repo.write("f.txt", "base\n");
    repo.commit_all("base");
    repo.git(&["checkout", "-q", "-b", "other"]);
    repo.write("f.txt", "other\n");
    repo.commit_all("other");
    repo.git(&["checkout", "-q", "main"]);
    repo.write("f.txt", "main\n");
    repo.commit_all("main");
    let snap_before = rewind().snapshot(&repo.path, "clean").unwrap();
    let _ = snap_before;
    let merge = std::process::Command::new(real_git()).arg("-C").arg(&repo.path).args(["merge", "other"]).output().unwrap();
    assert!(!merge.status.success(), "the fixture must conflict");
    assert!(matches!(rewind().snapshot(&repo.path, "conflicted"), Err(RewindError::Unmerged)));
    assert!(rewind().plan_restore(&repo.path, "clean").is_err());
}

#[test]
fn head_movement_is_reported_not_undone() {
    let repo = busy_repo();
    let snap = rewind().snapshot(&repo.path, "run-6").unwrap();
    repo.git(&["commit", "-q", "-m", "someone committed", "--allow-empty"]);
    let plan = rewind().plan_restore(&repo.path, "run-6").unwrap();
    assert!(plan.head_changed);
    let moved = repo.git(&["rev-parse", "HEAD"]);
    rewind().restore(&repo.path, "run-6", true).unwrap();
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), moved, "restore never moves HEAD");
    assert_ne!(moved, snap.head.unwrap());
}

#[test]
fn listing_deleting_and_run_id_validation() {
    let repo = busy_repo();
    let r = rewind();
    r.snapshot(&repo.path, "one").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1100));
    repo.write("later.txt", "l\n");
    r.snapshot(&repo.path, "two").unwrap();
    let list = r.list(&repo.path).unwrap();
    assert_eq!(list.iter().map(|s| s.run_id.as_str()).collect::<Vec<_>>(), ["two", "one"], "newest first");
    assert_eq!(list[1].skipped.len(), 3);
    assert_eq!(list[1].branch.as_deref(), Some("main"));
    assert_eq!(list[0].files, list[1].files + 1);

    assert!(matches!(r.snapshot(&repo.path, "one"), Err(RewindError::Exists(_))));
    for bad in ["", "../x", "a b", "a..b", ".hidden", "x.lock", "a/b", &"x".repeat(65), "-rf"] {
        assert!(matches!(r.snapshot(&repo.path, bad), Err(RewindError::InvalidRunId(_))), "{bad:?}");
    }
    r.delete(&repo.path, "one").unwrap();
    assert!(matches!(r.delete(&repo.path, "one"), Err(RewindError::Unknown(_))));
    assert!(matches!(r.plan_restore(&repo.path, "one"), Err(RewindError::Unknown(_))));
    assert_eq!(r.list(&repo.path).unwrap().len(), 1);
}

#[test]
fn not_a_repo_and_subdirectories() {
    let dir = tempfile::tempdir().unwrap();
    assert!(matches!(rewind().snapshot(dir.path(), "x"), Err(RewindError::NotARepo(_))));
    let repo = busy_repo();
    // a subdirectory resolves to the repo root
    let snap = rewind().snapshot(&repo.path.join("src"), "from-sub").unwrap();
    assert!(snap.files >= 6);
}
