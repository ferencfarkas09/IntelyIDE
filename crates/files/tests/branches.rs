mod common;

use common::*;
use intely_core::jail::Jail;
use intely_files::SwitchStatus;

fn protected() -> Vec<String> {
    ["main", "master", "production", "release/*"].map(String::from).into()
}

#[tokio::test]
async fn list_reports_branches_upstream_and_ahead_behind() {
    let sb = Sandbox::new();
    let repo = sb.repo_with_remote("r1");
    repo.git(&["branch", "feature"]);
    repo.write("a.txt", "a\n");
    repo.commit_all("ahead");
    let (files, _) = files();

    let list = files.branch_list(&repo.root()).await.unwrap();
    assert_eq!(list.local, ["feature", "main"]);
    assert_eq!(list.remote, ["origin/main"]);
    assert_eq!((list.current.as_deref(), list.upstream.as_deref(), list.ahead, list.behind), (Some("main"), Some("origin/main"), 1, 0));

    repo.git(&["checkout", "-q", "--detach"]);
    assert_eq!(files.branch_list(&repo.root()).await.unwrap().current, None);
}

#[tokio::test]
async fn create_switch_and_delete_follow_the_rules() {
    let sb = Sandbox::new();
    let repo = sb.repo_with_remote("r1");
    let (files, _) = files();
    let root = repo.root();

    files.branch_create(&root, "feature/x", None).await.unwrap();
    assert_eq!(files.branch_create(&root, "feature/x", None).await.unwrap_err().code, "branchExists");
    for bad in ["-x", "a b", "a..b", ""] {
        assert!(files.branch_create(&root, bad, None).await.is_err(), "{bad:?}");
    }
    // Created from the remote branch: tracking is recorded.
    files.branch_create(&root, "tracking", Some("origin/main")).await.unwrap();
    assert_eq!(repo.git(&["config", "branch.tracking.remote"]), "origin");
    assert_eq!(repo.git(&["config", "branch.tracking.merge"]), "refs/heads/main");
    assert_eq!(repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "main", "create does not switch");

    files.branch_switch(&root, "feature/x").await.unwrap();
    assert_eq!(repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "feature/x");
    files.branch_switch(&root, "feature/x").await.unwrap();

    // Dirty tracked files block a switch; untracked ones do not.
    repo.write("README.md", "changed\n");
    let err = files.branch_switch(&root, "main").await.unwrap_err();
    assert_eq!(err.code, "dirtyTree");
    assert!(err.detail.unwrap().contains("README.md"));
    repo.write("untracked.txt", "u\n");
    repo.git(&["checkout", "-q", "--", "README.md"]);
    files.branch_switch(&root, "main").await.unwrap();
    assert_eq!(files.branch_switch(&root, "nope").await.unwrap_err().code, "noSuchBranch");

    // Remote-only branch becomes a tracking branch.
    repo.git(&["push", "-q", "origin", "feature/x:refs/heads/remote-only"]);
    repo.git(&["fetch", "-q", "origin"]);
    files.branch_switch(&root, "remote-only").await.unwrap();
    assert_eq!(repo.git(&["rev-parse", "--abbrev-ref", "remote-only@{u}"]), "origin/remote-only");
    files.branch_switch(&root, "main").await.unwrap();

    // Delete: protected never, checked out never, unmerged needs force, merged goes.
    assert_eq!(files.branch_delete(&root, "main", true, &protected()).await.unwrap_err().code, "protectedBranch");
    files.branch_switch(&root, "feature/x").await.unwrap();
    assert!(files.branch_delete(&root, "feature/x", true, &protected()).await.is_err());
    files.branch_switch(&root, "main").await.unwrap();
    files.branch_delete(&root, "feature/x", false, &protected()).await.unwrap();
    assert!(!repo.git(&["branch", "--list", "feature/x"]).contains("feature/x"));
    assert_eq!(files.branch_delete(&root, "feature/x", false, &protected()).await.unwrap_err().code, "noSuchBranch");

    files.branch_switch(&root, "tracking").await.unwrap();
    repo.write("t.txt", "t\n");
    repo.commit_all("unmerged work");
    files.branch_switch(&root, "main").await.unwrap();
    let err = files.branch_delete(&root, "tracking", false, &protected()).await.unwrap_err();
    assert_eq!(err.code, "notMerged");
    files.branch_delete(&root, "tracking", true, &protected()).await.unwrap();
    assert!(!repo.git(&["config", "--list"]).contains("branch.tracking."));

    // The repo's own live branch patterns protect too.
    files.branch_create(&root, "live-1", None).await.unwrap();
    let live = [protected(), vec!["live-*".to_owned()]].concat();
    assert_eq!(files.branch_delete(&root, "live-1", true, &live).await.unwrap_err().code, "protectedBranch");
}

#[tokio::test]
async fn switch_all_reports_every_repo() {
    let sb = Sandbox::new();
    let (a, b, c) = (sb.repo("a"), sb.repo("b"), sb.repo("c"));
    a.git(&["branch", "dev"]);
    b.git(&["branch", "dev"]);
    b.write("README.md", "dirty\n");
    let (files, _) = files();

    let out = files.branch_switch_all(&[a.root(), b.root(), c.root()], "dev").await;
    let by = |id: &str| out.iter().find(|o| o.repo_id == id).unwrap();
    assert_eq!(by("a").status, SwitchStatus::Switched);
    assert_eq!((by("b").status, by("b").code.as_deref()), (SwitchStatus::Failed, Some("dirtyTree")));
    assert_eq!(by("c").status, SwitchStatus::Skipped);
    assert_eq!(a.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "dev");
    assert_eq!(b.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert_eq!(files.branch_switch_all(&[a.root()], "dev").await[0].status, SwitchStatus::Skipped);
}

#[tokio::test]
async fn stashing_a_staged_rename_takes_both_halves() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    repo.write("old.txt", "o\n");
    repo.write("keep.txt", "k\n");
    repo.commit_all("init");
    let (files, _) = files();
    let root = repo.root();

    repo.git(&["mv", "old.txt", "new.txt"]);
    repo.write("keep.txt", "k2\n");
    files.stash_push(&root, &["new.txt".into(), "old.txt".into()], Some("rename")).await.unwrap();
    assert_eq!(repo.git(&["status", "--porcelain=v1"]), "M keep.txt", "only the unticked file stays modified");
    assert_eq!((repo.exists("old.txt"), repo.exists("new.txt")), (true, false), "the tree is as before the rename");
    files.stash_pop(&root, 0).await.unwrap();
    assert_eq!((repo.exists("old.txt"), repo.exists("new.txt")), (false, true), "the pop brings the rename back");
}

#[tokio::test]
async fn stash_push_list_apply_pop_and_drop() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    repo.write("a.txt", "a\n");
    repo.write("b.txt", "b\n");
    repo.commit_all("ab");
    let (files, _) = files();
    let root = repo.root();

    assert_eq!(files.stash_push(&root, &[], None).await.unwrap_err().code, "nothingToDo");
    assert!(files.stash_list(&root).await.unwrap().is_empty());

    repo.write("a.txt", "a2\n");
    repo.write("b.txt", "b2\n");
    repo.write("new.txt", "n\n");
    repo.write(".env", "S=1\n");
    assert_eq!(files.stash_push(&root, &[".env".into()], None).await.unwrap_err().code, "guardBlocked");
    assert!(files.stash_push(&root, &["../x".into()], None).await.is_err());
    files.stash_push(&root, &["a.txt".into(), "new.txt".into()], Some("park a")).await.unwrap();
    assert_eq!((repo.read("a.txt"), repo.read("b.txt"), repo.exists("new.txt")), ("a\n".into(), "b2\n".into(), false));

    repo.git(&["checkout", "-q", "--", "b.txt"]);
    files.stash_push(&root, &[], Some("park all")).await.unwrap_err();
    repo.write("b.txt", "b3\n");
    files.stash_push(&root, &[], None).await.unwrap();

    let list = files.stash_list(&root).await.unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!((list[0].index, list[0].branch.as_deref()), (0, Some("main")));
    assert!(list[1].message.contains("park a") && list[1].created_ms > 1.6e12);

    files.stash_apply(&root, 1).await.unwrap();
    assert_eq!((repo.read("a.txt"), repo.exists("new.txt")), ("a2\n".into(), true));
    assert_eq!(files.stash_list(&root).await.unwrap().len(), 2);
    repo.git(&["reset", "-q", "--hard"]);
    repo.git(&["clean", "-fdq"]);
    files.stash_pop(&root, 1).await.unwrap();
    assert_eq!(files.stash_list(&root).await.unwrap().len(), 1);
    files.stash_drop(&root, 0).await.unwrap();
    assert!(files.stash_list(&root).await.unwrap().is_empty());
    assert!(files.stash_drop(&root, 0).await.is_err());
}

#[tokio::test]
async fn rollback_backs_up_before_discarding() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    repo.write("mod.txt", "orig\n");
    repo.write("del.txt", "del\n");
    repo.write("keep.txt", "keep\n");
    repo.commit_all("base");
    repo.write("mod.txt", "edited\n");
    std::fs::remove_file(repo.path.join("del.txt")).unwrap();
    repo.write("staged-new.txt", "s\n");
    repo.git(&["add", "staged-new.txt"]);
    repo.write("dir/untracked.txt", "u\n");
    repo.write("keep.txt", "kept edit\n");
    let (files, _) = files();
    let backups = sb.root.join("backups");

    let paths: Vec<String> = ["mod.txt", "del.txt", "staged-new.txt", "dir"].map(String::from).into();
    let result = files.rollback(&repo.root(), &paths, &backups).await.unwrap();

    assert_eq!((repo.read("mod.txt"), repo.read("del.txt"), repo.read("keep.txt")), ("orig\n".into(), "del\n".into(), "kept edit\n".into()));
    assert!(!repo.exists("staged-new.txt") && !repo.exists("dir"));
    let backup = std::path::PathBuf::from(&result.backup_path);
    assert!(backup.starts_with(&backups));
    assert_eq!(std::fs::read_to_string(backup.join("untracked/dir/untracked.txt")).unwrap(), "u\n");
    assert_eq!(std::fs::read_to_string(backup.join("untracked/staged-new.txt")).unwrap(), "s\n");
    let patch = std::fs::read_to_string(backup.join("rollback.patch")).unwrap();
    assert!(patch.contains("+edited") && patch.contains("-del"));
    assert!(repo.git(&["status", "--porcelain"]).lines().all(|l| l.contains("keep.txt")));

    // The patch brings the tracked edits back.
    repo.git(&["apply", backup.join("rollback.patch").to_str().unwrap()]);
    assert_eq!(repo.read("mod.txt"), "edited\n");

    assert_eq!(files.rollback(&repo.root(), &["README.md".into()], &backups).await.unwrap_err().code, "nothingToDo");
    assert!(files.rollback(&repo.root(), &["../x".into()], &backups).await.is_err());
}

#[tokio::test]
async fn rollback_of_a_name_with_glob_characters_touches_only_that_file() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    for f in ["[id].tsx", "i.tsx", "d.tsx"] {
        repo.write(f, "base\n");
    }
    repo.commit_all("base");
    for f in ["[id].tsx", "i.tsx", "d.tsx"] {
        repo.write(f, "edited\n");
    }
    let (files, _) = files();
    files.rollback(&repo.root(), &["[id].tsx".into()], &sb.root.join("backups")).await.unwrap();
    assert_eq!((repo.read("[id].tsx"), repo.read("i.tsx"), repo.read("d.tsx")), ("base\n".into(), "edited\n".into(), "edited\n".into()));
}

#[tokio::test]
async fn mutations_are_refused_by_the_jail_and_leave_the_repo_alone() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    repo.git(&["branch", "other"]);
    repo.write("README.md", "dirty\n");
    let elsewhere = tempfile::Builder::new().prefix("intely-c1-fixture-").tempdir().unwrap();
    let backups = sb.root.join("backups");
    let root = repo.root();

    for (jail, code) in [(Jail::read_only(), "readOnly"), (Jail::e2e(elsewhere.path()), "testJail")] {
        let (files, _) = files_with(jail);
        assert_eq!(files.branch_create(&root, "nb", None).await.unwrap_err().code, code);
        assert_eq!(files.branch_switch(&root, "other").await.unwrap_err().code, code);
        assert_eq!(files.branch_delete(&root, "other", true, &[]).await.unwrap_err().code, code);
        assert_eq!(files.stash_push(&root, &[], None).await.unwrap_err().code, code);
        assert_eq!(files.stash_drop(&root, 0).await.unwrap_err().code, code);
        assert_eq!(files.rollback(&root, &["README.md".into()], &backups).await.unwrap_err().code, code);
    }
    assert_eq!(repo.read("README.md"), "dirty\n");
    assert!(!backups.exists());
    assert!(repo.git(&["branch", "--list"]).contains("other") && !repo.git(&["branch", "--list"]).contains("nb"));

    // Reads still work in the read-only mode.
    let (ro, _) = files_with(Jail::read_only());
    assert_eq!(ro.branch_list(&root).await.unwrap().local, ["main", "other"]);
    assert!(ro.stash_list(&root).await.unwrap().is_empty());
}
