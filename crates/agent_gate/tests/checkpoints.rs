//! Checkpoints and the config-file vault on fixture repos only: the user's index, branches and stash are never touched, restore
//! round-trips one step, later edits are never overwritten silently, hostile working trees are handled.

#![cfg(unix)]
mod common;

use common::{real_git, Repo};
use intely_agent_gate::rewind::vault::{ConfigVault, PROTECTED_NAMES};
use intely_agent_gate::rewind::{Rewind, RewindError, CHECKPOINT_PREFIX, MAX_CHECKPOINTS};

fn rewind() -> Rewind {
    common::isolate_env();
    Rewind::new(real_git())
}

fn started(run: &str) -> Repo {
    let repo = Repo::new();
    repo.write(".gitignore", "*.log\n.env.local\nnode_modules/\n");
    repo.write("app.tsx", "v1\n");
    repo.write("styles.css", "a {}\n");
    repo.commit_all("init");
    rewind().snapshot(&repo.path, run).unwrap();
    repo
}

fn untouched(repo: &Repo) -> (String, Vec<u8>, String, String) {
    (repo.git(&["ls-files", "-s"]), repo.index_bytes(), repo.git(&["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/stash", "refs/tags"]), repo.git(&["rev-parse", "HEAD"]))
}

#[test]
fn a_checkpoint_per_step_and_no_duplicate_when_nothing_changed() {
    let repo = started("r1");
    let r = rewind();
    assert!(r.checkpoint(&repo.path, "r1", "turn", None, false).unwrap().is_none(), "same tree as the snapshot");
    repo.write("app.tsx", "v2\n");
    repo.write("new.ts", "n\n");
    let first = r.checkpoint(&repo.path, "r1", "end", None, false).unwrap().expect("changed");
    assert_eq!(first.seq, 1);
    assert_eq!(first.ref_name, format!("{CHECKPOINT_PREFIX}r1/0001"));
    assert_eq!(first.changed, 2);
    assert!(r.checkpoint(&repo.path, "r1", "turn", None, false).unwrap().is_none());
    let save = r.checkpoint(&repo.path, "r1", "save", Some("  before\tthe\nlogin   change "), true).unwrap().expect("a save point is always written");
    assert_eq!(save.label.as_deref(), Some("before the login change"));
    let list = r.checkpoints(&repo.path, "r1").unwrap();
    assert_eq!(list.iter().map(|c| (c.seq, c.kind.as_str(), c.changed)).collect::<Vec<_>>(), [(0, "start", 0), (1, "end", 2), (2, "save", 0)]);
}

#[test]
fn checkpoints_never_touch_the_index_branches_stash_or_head() {
    let repo = started("r2");
    repo.write("staged.txt", "s\n");
    repo.git(&["add", "staged.txt"]);
    repo.write("app.tsx", "unstaged\n");
    repo.git(&["stash", "push", "-q", "--keep-index", "-m", "mine"]);
    repo.write("app.tsx", "edited again\n");
    repo.git(&["status", "--porcelain"]);
    let before = untouched(&repo);
    let r = rewind();
    let cp = r.checkpoint(&repo.path, "r2", "end", None, false).unwrap().unwrap();
    assert_eq!(untouched(&repo), before);
    repo.write("app.tsx", "agent\n");
    r.checkpoint(&repo.path, "r2", "end", None, false).unwrap().unwrap();
    r.restore_checkpoint(&repo.path, "r2", cp.seq, true, true).unwrap();
    assert_eq!(repo.read("app.tsx"), "edited again\n");
    assert_eq!(untouched(&repo), before, "a restore leaves the index, refs and HEAD alone");
}

#[test]
fn undo_one_step_with_a_dry_run_and_explicit_confirmation() {
    let repo = started("r3");
    let r = rewind();
    repo.write("app.tsx", "turn 1\n");
    let one = r.checkpoint(&repo.path, "r3", "end", None, false).unwrap().unwrap();
    repo.write("app.tsx", "turn 2\n");
    repo.write("added.ts", "a\n");
    std::fs::remove_file(repo.path.join("styles.css")).unwrap();
    r.checkpoint(&repo.path, "r3", "end", None, false).unwrap().unwrap();

    let plan = r.plan_checkpoint_restore(&repo.path, "r3", one.seq).unwrap();
    assert_eq!((plan.overwrite.clone(), plan.recreate.clone(), plan.delete.clone()), (vec!["app.tsx".to_string()], vec!["styles.css".to_string()], vec!["added.ts".to_string()]));
    assert!(plan.conflicts.is_empty());
    assert!(matches!(r.restore_checkpoint(&repo.path, "r3", one.seq, false, false), Err(RewindError::ConfirmationRequired)));
    assert_eq!(repo.read("app.tsx"), "turn 2\n", "nothing happened without confirmation");
    let done = r.restore_checkpoint(&repo.path, "r3", one.seq, true, false).unwrap();
    assert_eq!((done.overwritten.len(), done.recreated.len(), done.deleted.len()), (1, 1, 1));
    assert_eq!(repo.read("app.tsx"), "turn 1\n");
    assert!(repo.exists("styles.css") && !repo.exists("added.ts"));
    assert!(matches!(r.plan_checkpoint_restore(&repo.path, "r3", 99), Err(RewindError::UnknownCheckpoint(_, 99))));
}

#[test]
fn edits_made_after_the_newest_checkpoint_are_listed_and_kept() {
    let repo = started("r4");
    let r = rewind();
    repo.write("app.tsx", "agent turn 1\n");
    repo.write("styles.css", "agent css\n");
    r.checkpoint(&repo.path, "r4", "end", None, false).unwrap().unwrap();
    // the person edits a file the agent also changed, and creates one
    repo.write("styles.css", "my own fix\n");
    repo.write("mine.txt", "mine\n");
    let plan = r.plan_checkpoint_restore(&repo.path, "r4", 0).unwrap();
    assert_eq!(plan.conflicts, ["mine.txt", "styles.css"]);
    let done = r.restore_checkpoint(&repo.path, "r4", 0, true, false).unwrap();
    assert_eq!(done.kept, ["mine.txt", "styles.css"]);
    assert_eq!(repo.read("styles.css"), "my own fix\n", "never overwritten silently");
    assert!(repo.exists("mine.txt"));
    assert_eq!(repo.read("app.tsx"), "v1\n", "the agent's change is undone");
    // only with the explicit choice
    r.restore_checkpoint(&repo.path, "r4", 0, true, true).unwrap();
    assert_eq!(repo.read("styles.css"), "a {}\n");
    assert!(!repo.exists("mine.txt"));
}

#[test]
fn compare_two_checkpoints_and_now_read_only() {
    let repo = started("r5");
    let r = rewind();
    repo.write("app.tsx", "v1\nv2\nv3\n");
    r.checkpoint(&repo.path, "r5", "end", None, false).unwrap().unwrap();
    repo.write("bin.dat", [0u8, 1, 2, 0, 255]);
    let before = untouched(&repo);
    let files = r.compare_checkpoints(&repo.path, "r5", 0, Some(1)).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!((files[0].path.as_str(), files[0].change.as_str(), files[0].additions, files[0].deletions), ("app.tsx", "modified", 2, 0));
    let now = r.compare_checkpoints(&repo.path, "r5", 1, None).unwrap();
    assert_eq!(now.iter().map(|f| (f.path.as_str(), f.change.as_str(), f.binary)).collect::<Vec<_>>(), [("bin.dat", "created", true)]);
    let patch = r.checkpoint_patch(&repo.path, "r5", 0, Some(1), "app.tsx").unwrap();
    assert!(patch.contains("+v2") && patch.contains("+v3"), "{patch}");
    assert_eq!(r.checkpoint_patch(&repo.path, "r5", 0, Some(1), "../etc/passwd").unwrap(), "", "only a path that differs");
    assert_eq!(untouched(&repo), before);
}

#[test]
fn the_number_of_checkpoints_is_capped_save_points_go_last() {
    let repo = started("r6");
    let r = rewind();
    r.checkpoint(&repo.path, "r6", "save", Some("keep me"), true).unwrap().unwrap();
    for i in 0..MAX_CHECKPOINTS + 3 {
        repo.write("app.tsx", format!("v{i}\n"));
        r.checkpoint(&repo.path, "r6", "end", None, false).unwrap().unwrap();
    }
    let list = r.checkpoints(&repo.path, "r6").unwrap();
    assert_eq!(list.len(), MAX_CHECKPOINTS + 1, "the snapshot plus the cap");
    assert!(list.iter().any(|c| c.label.as_deref() == Some("keep me")), "the save point survives the plain ones");
    assert_eq!(list.last().unwrap().seq as usize, MAX_CHECKPOINTS + 4);
}

#[test]
fn older_runs_are_pruned_per_repository() {
    let repo = started("old-1");
    let r = rewind();
    for run in ["old-1", "old-2", "old-3"] {
        repo.write("app.tsx", format!("{run}\n"));
        r.checkpoint(&repo.path, run, "end", None, false).unwrap().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
    }
    let pruned = r.prune_checkpoint_runs(&repo.path, "old-3", 2).unwrap();
    assert_eq!(pruned, ["old-1"]);
    assert_eq!(r.checkpoint_runs(&repo.path).unwrap(), ["old-3", "old-2"]);
    assert_eq!(r.delete_checkpoints(&repo.path, "old-2").unwrap(), 1);
}

#[test]
fn a_repository_without_commits_or_on_a_detached_head() {
    let repo = Repo::new();
    repo.write("x.txt", "x\n");
    let r = rewind();
    let cp = r.checkpoint(&repo.path, "unborn", "end", None, false).unwrap().unwrap();
    repo.write("x.txt", "changed\n");
    r.checkpoint(&repo.path, "unborn", "end", None, false).unwrap().unwrap();
    r.restore_checkpoint(&repo.path, "unborn", cp.seq, true, false).unwrap();
    assert_eq!(repo.read("x.txt"), "x\n");

    let repo = started("detached");
    repo.git(&["checkout", "-q", "--detach"]);
    repo.write("app.tsx", "detached\n");
    let cp = r.checkpoint(&repo.path, "detached", "end", None, false).unwrap().unwrap();
    assert!(!r.plan_checkpoint_restore(&repo.path, "detached", cp.seq).unwrap().head_changed);
    repo.git(&["commit", "-q", "--allow-empty", "-m", "moved"]);
    assert!(r.plan_checkpoint_restore(&repo.path, "detached", cp.seq).unwrap().head_changed);
}

#[test]
fn symlinks_are_stored_as_links_and_never_followed_on_restore() {
    let repo = started("links");
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "outside\n").unwrap();
    std::os::unix::fs::symlink(outside.path(), repo.path.join("out")).unwrap();
    std::os::unix::fs::symlink("app.tsx", repo.path.join("alias.tsx")).unwrap();
    let r = rewind();
    let cp = r.checkpoint(&repo.path, "links", "end", None, false).unwrap().unwrap();
    let tree = repo.git(&["ls-tree", "-r", &cp.tree]);
    assert!(tree.contains("120000") && !tree.contains("secret.txt"), "links are stored as links, their targets are not read: {tree}");
    // the agent replaces a directory by a link to somewhere else and writes behind it
    std::fs::create_dir_all(repo.path.join("src")).unwrap();
    repo.write("src/a.ts", "a\n");
    let with_src = r.checkpoint(&repo.path, "links", "end", None, false).unwrap().unwrap();
    std::fs::remove_dir_all(repo.path.join("src")).unwrap();
    std::os::unix::fs::symlink(outside.path(), repo.path.join("src")).unwrap();
    r.checkpoint(&repo.path, "links", "end", None, false).unwrap().unwrap();
    r.restore_checkpoint(&repo.path, "links", with_src.seq, true, true).unwrap();
    assert_eq!(std::fs::read_to_string(outside.path().join("secret.txt")).unwrap(), "outside\n");
    assert!(!outside.path().join("a.ts").exists(), "nothing was written through the link");
    assert_eq!(repo.read("src/a.ts"), "a\n");
}

#[test]
fn huge_untracked_files_are_skipped_and_submodules_are_left_alone() {
    let repo = started("big");
    repo.write("huge.bin", vec![1u8; 8 * 1024 * 1024]);
    let sub = Repo::new();
    sub.write("s.txt", "s\n");
    sub.commit_all("sub");
    std::fs::rename(&sub.path, repo.path.join("vendor")).unwrap();
    let r = rewind();
    let stage = r.stage_checkpoint(&repo.path, "big").unwrap();
    let skipped: Vec<_> = stage.skipped().iter().map(|s| (s.path.as_str(), s.reason)).collect();
    assert!(skipped.contains(&("huge.bin", "tooLarge")), "{skipped:?}");
    assert!(skipped.iter().any(|(p, r)| p.starts_with("vendor") && *r == "nestedRepo"), "{skipped:?}");
    let cp = r.checkpoint(&repo.path, "big", "end", None, false).unwrap();
    assert!(cp.is_none(), "nothing the checkpoint holds changed");
    r.restore_checkpoint(&repo.path, "big", 0, true, true).unwrap();
    assert!(repo.exists("huge.bin") && repo.exists("vendor/s.txt"), "guard-skipped files and nested repos are never deleted");
}

#[test]
fn a_file_that_changes_or_vanishes_during_the_checkpoint_does_not_break_it() {
    let repo = started("busy");
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let writer = {
        let (path, stop) = (repo.path.clone(), stop.clone());
        std::thread::spawn(move || {
            let mut i = 0u32;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                let _ = std::fs::write(path.join("churn.txt"), format!("{i}\n"));
                if i % 3 == 0 {
                    let _ = std::fs::remove_file(path.join("churn.txt"));
                }
                i += 1;
            }
        })
    };
    let r = rewind();
    for _ in 0..10 {
        // either a checkpoint or a clean error; never a panic, never a half-written ref
        match r.checkpoint(&repo.path, "busy", "end", None, false) {
            Ok(_) | Err(RewindError::Git { .. }) | Err(RewindError::Io(_)) => {}
            Err(e) => panic!("unexpected error {e}"),
        }
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    writer.join().unwrap();
    for c in r.checkpoints(&repo.path, "busy").unwrap() {
        assert!(!repo.git(&["ls-tree", &c.tree]).is_empty());
    }
}

#[test]
fn the_size_guard_refuses_a_checkpoint_of_too_many_untracked_bytes() {
    let repo = started("sum");
    // many files just under the guard's per-file limit
    for i in 0..60 {
        repo.write(&format!("gen/f{i}.txt"), vec![b'x'; 4_900_000]);
    }
    let err = rewind().checkpoint(&repo.path, "sum", "end", None, false).unwrap_err();
    assert!(matches!(err, RewindError::TooLarge(_)), "{err}");
}

#[test]
fn ignored_config_files_are_copied_outside_the_repo_privately_and_restored_only_with_consent() {
    use std::os::unix::fs::PermissionsExt;
    let repo = started("cfg");
    repo.write(".env.local", "API_KEY=one\n");
    repo.write(".env", "SECRET=1\n"); // untracked, not ignored: the guard keeps it out of checkpoints
    repo.write("packages/web/.env.local", "WEB=1\n");
    repo.write("node_modules/x/.env", "never\n");
    repo.write("notes.env", "not a protected name\n");
    let state = tempfile::tempdir().unwrap();
    let vault = ConfigVault::new(state.path().join("vault"));
    let r = rewind();
    let saved = vault.save(&r, &repo.path, "cfg", 1).unwrap();
    let names: Vec<_> = saved.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(names, [".env", ".env.local", "packages/web/.env.local"]);
    assert!(PROTECTED_NAMES.contains(&".env.local"));
    // the copies are outside the repository, 0700 / 0600
    let mut stack = vec![state.path().join("vault")];
    while let Some(d) = stack.pop() {
        assert_eq!(std::fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700, "{d:?}");
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            if e.file_type().unwrap().is_dir() {
                stack.push(e.path());
            } else {
                assert_eq!(e.metadata().unwrap().permissions().mode() & 0o777, 0o600, "{:?}", e.path());
            }
        }
    }
    assert_eq!(repo.git(&["status", "--porcelain", "--ignored"]).lines().filter(|l| l.contains("intely")).count(), 0);

    repo.write(".env.local", "API_KEY=changed\n");
    std::fs::remove_file(repo.path.join(".env")).unwrap();
    let listed = vault.list(&r, &repo.path, "cfg", 1).unwrap();
    assert_eq!(listed.iter().map(|f| (f.path.as_str(), f.state.as_str())).collect::<Vec<_>>(), [(".env", "missing"), (".env.local", "differs"), ("packages/web/.env.local", "same")]);
    assert!(matches!(vault.restore(&r, &repo.path, "cfg", 1, &[".env.local".into()], false), Err(RewindError::ConfirmationRequired)));
    assert_eq!(repo.read(".env.local"), "API_KEY=changed\n");
    for bad in ["../outside", "/etc/passwd", "app.tsx", "node_modules/x/.env"] {
        assert!(vault.restore(&r, &repo.path, "cfg", 1, &[bad.into()], true).is_err(), "{bad}");
    }
    let done = vault.restore(&r, &repo.path, "cfg", 1, &[".env.local".into(), ".env".into()], true).unwrap();
    assert_eq!(done.len(), 2);
    assert_eq!((repo.read(".env.local").as_str(), repo.read(".env").as_str()), ("API_KEY=one\n", "SECRET=1\n"));
    vault.delete_run("cfg").unwrap();
    assert!(vault.list(&r, &repo.path, "cfg", 1).unwrap().is_empty());
}

#[test]
fn the_vault_never_reads_or_writes_through_links() {
    let repo = started("cfglink");
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("target"), "outside secret\n").unwrap();
    std::os::unix::fs::symlink(outside.path().join("target"), repo.path.join(".env.local")).unwrap();
    std::fs::create_dir_all(repo.path.join("web")).unwrap();
    repo.write("web/.env.local", "W=1\n");
    let state = tempfile::tempdir().unwrap();
    let vault = ConfigVault::new(state.path());
    let r = rewind();
    let saved = vault.save(&r, &repo.path, "cfglink", 1).unwrap();
    assert_eq!(saved.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), ["web/.env.local"], "a linked file is not copied");
    // the folder becomes a link to somewhere else: restoring would write outside the repository
    std::fs::remove_dir_all(repo.path.join("web")).unwrap();
    std::os::unix::fs::symlink(outside.path(), repo.path.join("web")).unwrap();
    assert!(vault.restore(&r, &repo.path, "cfglink", 1, &["web/.env.local".into()], true).is_err());
    assert!(!outside.path().join(".env.local").exists());
    assert_eq!(std::fs::read_to_string(outside.path().join("target")).unwrap(), "outside secret\n");
}
