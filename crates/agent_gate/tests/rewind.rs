//! Rewind snapshots on fixture repos only: the user's index is never touched, restore round-trips tree and index.

#![cfg(unix)]
mod common;

use common::{real_git, Repo};
use intely_agent_gate::rewind::{Rewind, RewindError};

#[cfg(unix)]
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

/// Every path of the snapshot tree with the blob git would hash its file to now, next to the paths the snapshot must hold:
/// an oracle that does not use the snapshot code (the quick snapshot trusts git's stat cache; this checks it was right to).
fn assert_snapshot_matches_disk(repo: &Repo, tree: &str, want: &[&str]) {
    let listing = repo.git(&["ls-tree", "-r", tree]);
    let mut held: Vec<String> = Vec::new();
    for line in listing.lines() {
        let (meta, path) = line.split_once('\t').unwrap();
        let mut parts = meta.split(' ');
        let (mode, _kind, oid) = (parts.next().unwrap(), parts.next().unwrap(), parts.next().unwrap());
        let on_disk = if mode == "120000" {
            std::fs::read_link(repo.path.join(path)).unwrap().to_string_lossy().into_owned() // git stores a link's target
        } else {
            std::fs::read_to_string(repo.path.join(path)).unwrap()
        };
        let blob = repo.git(&["cat-file", "blob", oid]);
        assert_eq!(blob.trim_end(), on_disk.trim_end(), "{path} in the snapshot is not what is on disk");
        held.push(path.to_string());
    }
    held.sort();
    let mut want: Vec<String> = want.iter().map(|s| s.to_string()).collect();
    want.sort();
    assert_eq!(held, want);
}

#[test]
fn a_snapshot_holds_what_is_on_disk_whatever_git_thinks_of_its_stat_cache() {
    let repo = Repo::new();
    repo.write("same_size.txt", "AAAA\n");
    repo.write("grown.txt", "short\n");
    repo.write("gone.txt", "bye\n");
    repo.write("quiet.txt", "quiet v1\n");
    repo.write("sparse.txt", "sparse\n");
    repo.write("exec.sh", "#!/bin/sh\n");
    repo.write("link_me.txt", "target\n");
    repo.write("kept/a.txt", "a\n");
    repo.write("staged_only.txt", "staged v1\n");
    repo.commit_all("init");
    repo.git(&["status", "--porcelain"]); // the index now holds fresh stat data, as in a session that has run git status

    // the cases in which a stat cache can mislead:
    repo.write("same_size.txt", "BBBB\n"); // same length, newer content
    repo.write("grown.txt", "much longer than before\n");
    std::fs::remove_file(repo.path.join("gone.txt")).unwrap();
    repo.git(&["update-index", "--assume-unchanged", "quiet.txt"]);
    repo.write("quiet.txt", "quiet v2 behind assume-unchanged\n"); // git itself will not look at this file
    repo.git(&["update-index", "--skip-worktree", "sparse.txt"]);
    repo.write("untracked_new.txt", "new\n");
    repo.write("added_later.txt", "intent\n");
    repo.git(&["add", "-N", "added_later.txt"]);
    repo.write("staged_only.txt", "staged v2\n");
    repo.git(&["add", "staged_only.txt"]);
    repo.write("staged_only.txt", "staged v3 on disk\n");
    std::fs::remove_file(repo.path.join("link_me.txt")).unwrap();
    std::os::unix::fs::symlink("exec.sh", repo.path.join("link_me.txt")).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(repo.path.join("exec.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let snap = rewind().snapshot(&repo.path, "stat-1").unwrap();
    assert_snapshot_matches_disk(&repo, &snap.tree, &["same_size.txt", "grown.txt", "quiet.txt", "exec.sh", "link_me.txt", "kept/a.txt", "staged_only.txt", "untracked_new.txt", "added_later.txt"]);
    let modes = repo.git(&["ls-tree", &snap.tree, "exec.sh", "link_me.txt"]);
    assert!(modes.contains("100755") && modes.contains("120000"), "{modes}");
    assert_eq!(repo.git(&["show", &format!("{}:quiet.txt", snap.tree)]), "quiet v2 behind assume-unchanged");
    assert_eq!(repo.git(&["show", &format!("{}:staged_only.txt", snap.index_tree)]), "staged v2", "the index tree is the index, not the disk");

    // a restore plan reads the same quick tree: the untouched tree has nothing to restore
    assert!(rewind().plan_restore(&repo.path, "stat-1").unwrap().is_empty());
}

#[test]
fn a_snapshot_is_right_when_the_index_is_stale_or_missing() {
    let repo = Repo::new();
    repo.write("a.txt", "one\n");
    repo.write("b.txt", "two\n");
    repo.commit_all("init");
    // touch every file so that no stat entry matches, then change one of them in a way the size does not show
    repo.write("a.txt", "one\n");
    repo.write("b.txt", "TWO\n");
    let snap = rewind().snapshot(&repo.path, "stale").unwrap();
    assert_snapshot_matches_disk(&repo, &snap.tree, &["a.txt", "b.txt"]);

    std::fs::remove_file(repo.path.join(".git/index")).unwrap();
    let snap = rewind().snapshot(&repo.path, "no-index").unwrap();
    assert_snapshot_matches_disk(&repo, &snap.tree, &["a.txt", "b.txt"]);
    assert!(!repo.path.join(".git").read_dir().unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("intely-")), "no temporary index is left");
}

/// Two snapshots of the same run id at the same moment: git refuses the second `update-ref`, so exactly one of them exists and the ref holds
/// the tree of the one that won (a plain overwrite would let the last writer win and hand a restore the wrong tree).
#[test]
fn two_snapshots_of_one_run_taken_at_the_same_time_leave_one_ref_with_the_tree_of_the_winner() {
    let repo = busy_repo();
    for round in 0..15 {
        let id = format!("race-{round}");
        let gate = std::sync::Barrier::new(2);
        let answers: Vec<_> = std::thread::scope(|scope| {
            let jobs: Vec<_> = (0..2).map(|_| scope.spawn(|| (gate.wait(), rewind().snapshot(&repo.path, &id)).1)).collect();
            jobs.into_iter().map(|j| j.join().unwrap()).collect()
        });
        let won: Vec<_> = answers.iter().filter_map(|a| a.as_ref().ok()).collect();
        assert_eq!(won.len(), 1, "round {round}: exactly one snapshot may exist, got {answers:?}");
        assert_eq!(repo.git(&["rev-parse", &won[0].ref_name]), won[0].commit, "round {round}: the ref holds the winner's commit");
        assert!(answers.iter().any(|a| a.is_err()), "round {round}: the other one is refused");
    }
}

/// Linked worktrees of one repository share `refs/intely/snapshots`: a run that covers the main folder and a worktree gets one snapshot
/// of one of them and a refusal for the other, never two snapshots that fight over one ref.
#[test]
fn a_linked_worktree_shares_the_snapshot_ref_so_the_second_snapshot_of_a_run_is_refused() {
    let repo = Repo::new();
    repo.write("a.txt", "main\n");
    repo.commit_all("init");
    let wt = repo.root().join("wt");
    repo.git(&["worktree", "add", "-q", "-b", "other", wt.to_str().unwrap()]);
    std::fs::write(wt.join("only-in-wt.txt"), "wt\n").unwrap();
    repo.write("only-in-main.txt", "main\n");

    let first = rewind().snapshot(&repo.path, "shared").unwrap();
    assert!(matches!(rewind().snapshot(&wt, "shared"), Err(RewindError::Exists(_))));
    assert_eq!(repo.git(&["rev-parse", &first.ref_name]), first.commit, "the ref still holds the first snapshot");
    let files = repo.git(&["ls-tree", "-r", "--name-only", &first.tree]);
    assert!(files.contains("only-in-main.txt") && !files.contains("only-in-wt.txt"), "{files}");

    // and at the same moment, from both folders
    let gate = std::sync::Barrier::new(2);
    let answers: Vec<_> = std::thread::scope(|scope| {
        let jobs: Vec<_> = [repo.path.clone(), wt.clone()].into_iter().map(|dir| { let gate = &gate; scope.spawn(move || (gate.wait(), rewind().snapshot(&dir, "both")).1) }).collect();
        jobs.into_iter().map(|j| j.join().unwrap()).collect()
    });
    assert_eq!(answers.iter().filter(|a| a.is_ok()).count(), 1, "{answers:?}");
}
