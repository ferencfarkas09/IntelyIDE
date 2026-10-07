//! Push, outgoing computation, pull and fetch against real git and file-transport remotes (RESULTS.md P1-P7).

mod common;

use std::time::Duration;

use common::*;
use intely_core::git::{outgoing, push};
use intely_core::{
    ChangeKind, FailureKind, ForceWithLease, OpKind, PullMode, PushFlag, PushTarget, StepStatus, TagsMode,
};

fn branch_off(fx: &Fixture, branch: &str, files: &[(&str, &str)]) {
    fx.git(&["checkout", "-q", "-b", branch]);
    for (path, body) in files {
        fx.write(path, body);
        fx.commit_all(&format!("add {path}"));
    }
}

#[tokio::test]
async fn p1_new_branch_under_a_different_remote_name_then_fast_forward_then_up_to_date() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let mut fx = sb.repo_with_remote("p1");
    branch_off(&fx, "feature/x", &[("one.txt", "1\n"), ("two.txt", "2\n")]);
    fx.map_push_target("feature/x", "origin", "release-x");

    // before the first push there is no tracking ref: outgoing comes from `rev-list --not --remotes`
    let info = push::plan(&h.plain(), &fx.cfg, &[], false).await.unwrap();
    assert_eq!((info.local.as_str(), info.remote.as_str(), info.remote_branch.as_str()), ("feature/x", "origin", "release-x"));
    assert!(info.new_remote_branch && info.can_push && info.checked_by_default);
    assert_eq!(info.commits.len(), 2);
    assert_eq!(info.commits[0].subject, "add two.txt");
    assert_eq!(info.commits[0].author, NAME);

    let o = h.push(&fx, "release-x").await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    let r = &o.push_results.as_ref().unwrap()[0];
    assert_eq!((r.flag.clone(), r.from.as_str(), r.to.as_str()), (PushFlag::NewRef, "refs/heads/feature/x", "refs/heads/release-x"));
    assert_eq!(fx.remote_ref("release-x"), Some(fx.head()));
    assert_eq!(fx.remote_ref("feature/x"), None);
    let (code, _, _) = fx.git_try(&["rev-parse", "-q", "--verify", "refs/remotes/origin/release-x"]);
    assert_eq!(code, 0, "git did not create the tracking ref for the remote name");
    assert_ne!(fx.git_try(&["rev-parse", "-q", "--verify", "refs/remotes/origin/feature/x"]).0, 0);

    let info = push::plan(&h.plain(), &fx.cfg, &[], false).await.unwrap();
    assert!(!info.new_remote_branch && info.commits.is_empty() && !info.checked_by_default);

    fx.write("three.txt", "3\n");
    fx.commit_all("add three");
    let info = push::plan(&h.plain(), &fx.cfg, &[], false).await.unwrap();
    assert_eq!(info.commits.len(), 1);
    let o = h.push(&fx, "release-x").await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(o.push_results.as_ref().unwrap()[0].flag, PushFlag::FastForward);

    let o = h.push(&fx, "release-x").await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(o.push_results.as_ref().unwrap()[0].flag, PushFlag::UpToDate);
}

#[tokio::test]
async fn p1_a_new_branch_on_commits_the_remote_already_has_is_new_without_outgoing_commits() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let mut fx = sb.repo_with_remote("p1b");
    fx.git(&["checkout", "-q", "-b", "topic"]);
    fx.map_push_target("topic", "origin", "topic-remote");

    let info = push::plan(&h.plain(), &fx.cfg, &[], false).await.unwrap();

    assert!(info.new_remote_branch);
    assert!(info.commits.is_empty() && !info.checked_by_default);
}

#[tokio::test]
async fn targets_resolve_through_override_push_upstream_and_origin() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let mut fx = sb.repo_with_remote("targets");
    let resolve = |fx: &Fixture| {
        let ctx = h.plain();
        let cfg = fx.cfg.clone();
        async move { outgoing::resolve_target(&ctx, &cfg).await }
    };

    let t = resolve(&fx).await.unwrap(); // main tracks origin/main
    assert_eq!((t.remote.as_str(), t.remote_branch.as_str()), ("origin", "main"));

    fx.git(&["checkout", "-q", "-b", "topic"]); // no upstream, no mapping
    let t = resolve(&fx).await.unwrap();
    assert_eq!((t.local.as_str(), t.remote.as_str(), t.remote_branch.as_str()), ("topic", "origin", "topic"));

    fx.git(&["push", "-q", "origin", "main:other"]);
    fx.git(&["branch", "-q", "--set-upstream-to=origin/other", "topic"]); // upstream with another name
    let t = resolve(&fx).await.unwrap();
    assert_eq!((t.remote.as_str(), t.remote_branch.as_str()), ("origin", "other"));

    fx.map_push_target("topic", "origin", "mapped"); // the IDE override wins
    let t = resolve(&fx).await.unwrap();
    assert_eq!(t.remote_branch, "mapped");

    fx.git(&["checkout", "-q", "--detach"]);
    assert_eq!(resolve(&fx).await.unwrap_err().code, "git");
}

#[tokio::test]
async fn plans_for_detached_unborn_and_remoteless_repos_cannot_push() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("blocked");
    fx.git(&["checkout", "-q", "--detach"]);
    let info = push::plan(&h.plain(), &fx.cfg, &[], false).await.unwrap();
    assert!(!info.can_push && info.blocked_reason.as_deref().unwrap().contains("detached"));

    let unborn = sb.repo("unborn");
    let info = push::plan(&h.plain(), &unborn.cfg, &[], false).await.unwrap();
    assert!(!info.can_push && info.blocked_reason.as_deref().unwrap().contains("no commits"));

    let lonely = sb.repo("lonely");
    lonely.write("a", "a\n");
    lonely.commit_all("base");
    let info = push::plan(&h.plain(), &lonely.cfg, &[], false).await.unwrap();
    assert!(!info.can_push && info.blocked_reason.as_deref().unwrap().contains("not configured"));
}

#[tokio::test]
async fn protected_branches_match_globs_and_the_remote_head_branch() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let mut fx = sb.repo_with_remote("protected");
    let plan = |fx: &Fixture, patterns: &[&str]| {
        let ctx = h.plain();
        let cfg = fx.cfg.clone();
        let patterns: Vec<String> = patterns.iter().map(|p| (*p).to_owned()).collect();
        async move { push::plan(&ctx, &cfg, &patterns, false).await.unwrap().protected }
    };
    assert!(plan(&fx, &["main"]).await);
    assert!(!plan(&fx, &["release/*"]).await);

    fx.map_push_target("main", "origin", "release/1.2");
    assert!(plan(&fx, &["release/*"]).await);

    fx.map_push_target("main", "origin", "dev");
    assert!(!plan(&fx, &[]).await);
    fx.git(&["remote", "set-head", "origin", "main"]);
    fx.map_push_target("main", "origin", "main");
    assert!(plan(&fx, &[]).await, "the remote HEAD branch is protected too");
}

#[tokio::test]
async fn p2_a_remote_that_moved_rejects_the_push_as_non_fast_forward() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("p2");
    let colleague = sb.clone_of(&fx, "colleague");
    colleague.write("theirs.txt", "theirs\n");
    colleague.commit_all("their work");
    colleague.git(&["push", "-q", "origin", "main"]);
    let theirs = fx.remote_ref("main");
    fx.write("mine.txt", "mine\n");
    fx.commit_all("my work");

    let o = h.push(&fx, "main").await;

    assert_eq!(o.status, StepStatus::Failed, "{o:?}");
    assert_eq!(failure_kind(&o), FailureKind::NonFastForward);
    let r = &o.push_results.as_ref().unwrap()[0];
    assert_eq!((r.flag.clone(), r.reason.as_deref()), (PushFlag::Rejected, Some("fetch first")));
    assert_eq!(fx.remote_ref("main"), theirs);

    fx.git(&["fetch", "-q"]); // now git knows the remote work and says why differently
    let o = h.push(&fx, "main").await;
    assert_eq!(failure_kind(&o), FailureKind::NonFastForward);
    assert_eq!(o.push_results.as_ref().unwrap()[0].reason.as_deref(), Some("non-fast-forward"));
    assert_eq!(fx.remote_ref("main"), theirs);
}

#[tokio::test]
async fn p2_a_pre_receive_decline_is_a_remote_declined_failure_with_the_remote_text() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("p2b");
    fx.remote_hook("pre-receive", "echo 'declined by test policy' >&2\nexit 1");
    let before = fx.remote_ref("main");
    fx.write("a.txt", "a\n");
    fx.commit_all("work");

    let o = h.push(&fx, "main").await;

    assert_eq!(failure_kind(&o), FailureKind::RemoteDeclined, "{o:?}");
    assert!(failure_output(&o).contains("declined by test policy"), "{}", failure_output(&o));
    assert_eq!(fx.remote_ref("main"), before);
}

fn lease(fx: &Fixture, seen: &str, remote_branch: &str) -> PushTarget {
    PushTarget { force_with_lease: Some(ForceWithLease { seen_oid: seen.to_owned() }), ..target(fx, remote_branch, TagsMode::None) }
}

#[tokio::test]
async fn p3_force_with_lease_protects_unseen_work_and_the_explicit_oid_overrides_what_was_fetched() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("p3");
    let a = fx.head();
    fx.git(&["commit", "-q", "--amend", "-m", "rewritten"]);
    let b = fx.head();

    // a plain push of rewritten history is refused, the lease with the seen oid goes through
    let o = h.push(&fx, "main").await;
    assert_eq!(failure_kind(&o), FailureKind::NonFastForward);
    let o = h.push_with(&fx, lease(&fx, &a, "main"), false).await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(o.push_results.as_ref().unwrap()[0].flag, PushFlag::Forced);
    assert_eq!(fx.remote_ref("main"), Some(b.clone()));
    assert!(h.lines(fx.id()).iter().any(|l| l.contains("discards remote work")), "no warning for an unseen lease commit");

    // a colleague pushes meanwhile: the stale lease must not overwrite their work
    let colleague = sb.clone_of(&fx, "colleague");
    colleague.write("theirs.txt", "t\n");
    colleague.commit_all("their work");
    colleague.git(&["push", "-q", "origin", "main"]);
    let theirs = colleague.head();
    fx.git(&["commit", "-q", "--amend", "-m", "rewritten again"]);
    let b2 = fx.head();
    let o = h.push_with(&fx, lease(&fx, &b, "main"), false).await;
    assert_eq!(failure_kind(&o), FailureKind::NonFastForward, "{o:?}");
    assert_eq!(o.push_results.as_ref().unwrap()[0].reason.as_deref(), Some("stale info"));
    assert_eq!(fx.remote_ref("main"), Some(theirs.clone()));

    // fetched but not integrated: the explicit oid is what the user confirmed, --force-if-includes is not added
    fx.git(&["fetch", "-q"]);
    let o = h.push_with(&fx, lease(&fx, &theirs, "main"), false).await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.remote_ref("main"), Some(b2));
}

#[tokio::test]
async fn an_empty_lease_means_the_tracking_ref_and_still_protects_unseen_work() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("lease-empty");
    let a = fx.head();
    fx.git(&["commit", "-q", "--amend", "-m", "rewritten"]);
    let b = fx.head();

    let o = h.push_with(&fx, lease(&fx, "", "main"), false).await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.remote_ref("main"), Some(b.clone()));
    assert_ne!(a, b);

    // a colleague pushes meanwhile and nobody fetched: the tracking ref is stale, so the lease refuses
    let colleague = sb.clone_of(&fx, "colleague");
    colleague.write("theirs.txt", "t\n");
    colleague.commit_all("their work");
    colleague.git(&["push", "-q", "origin", "main"]);
    let theirs = colleague.head();
    fx.git(&["commit", "-q", "--amend", "-m", "rewritten again"]);
    let o = h.push_with(&fx, lease(&fx, "", "main"), false).await;
    assert_eq!(failure_kind(&o), FailureKind::NonFastForward, "{o:?}");
    assert_eq!(fx.remote_ref("main"), Some(theirs.clone()));

    // fetched but never integrated (a refresh or the push plan between confirm and push): still refused
    fx.git(&["fetch", "-q"]);
    let o = h.push_with(&fx, lease(&fx, "", "main"), false).await;
    assert_eq!(failure_kind(&o), FailureKind::NonFastForward, "{o:?}");
    assert_eq!(fx.remote_ref("main"), Some(theirs));

    // an unknown remote branch has nothing to lease against
    let o = h.push_with(&fx, lease(&fx, "", "never-pushed"), false).await;
    assert_eq!(o.status, StepStatus::Failed, "{o:?}");
}

#[tokio::test]
async fn p4_a_failing_pre_push_hook_rejects_and_no_verify_skips_it() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("p4");
    fx.write("a.txt", "a\n");
    fx.commit_all("work");
    let stdin_log = fx.path.join("pre-push.stdin");
    fx.hook("pre-push", &format!("cat > {}\necho 'pre-push says no' >&2\nexit 1", stdin_log.display()));
    let before = fx.remote_ref("main");

    let o = h.push(&fx, "main").await;

    assert_eq!(failure_kind(&o), FailureKind::HookRejected, "{o:?}");
    assert!(failure_output(&o).contains("pre-push says no"));
    assert_eq!(fx.remote_ref("main"), before);
    assert!(std::fs::read_to_string(&stdin_log).unwrap().contains("refs/heads/main"));
    assert!(h.lines(fx.id()).contains(&"pre-push says no".to_owned()), "hook output was not streamed");

    let o = h.push_with(&fx, target(&fx, "main", TagsMode::None), true).await;
    assert_eq!(o.status, StepStatus::Done, "--no-verify must skip the hook: {o:?}");
    assert_eq!(fx.remote_ref("main"), Some(fx.head()));
}

#[tokio::test]
async fn p5_tag_modes_and_progress_events() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("p5");
    fx.git(&["checkout", "-q", "-b", "side"]);
    fx.write("side.txt", "s\n");
    fx.commit_all("side work");
    fx.git(&["tag", "-a", "unrelated", "-m", "not reachable from main"]);
    fx.git(&["checkout", "-q", "main"]);
    fx.write("a.txt", &numbered(200));
    fx.commit_all("work");
    fx.git(&["tag", "-a", "v1", "-m", "release"]);
    fx.git(&["tag", "lw"]);

    let o = h.push_with(&fx, target(&fx, "main", TagsMode::Follow), false).await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.remote_git(&["tag", "-l"]).trim(), "v1", "--follow-tags pushes only the reachable annotated tag");
    let results = o.push_results.unwrap();
    assert!(results.iter().any(|r| r.flag == PushFlag::NewRef && r.to == "refs/tags/v1"), "{results:?}");

    let o = h.push_with(&fx, target(&fx, "main", TagsMode::All), false).await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    let mut tags: Vec<String> = fx.remote_git(&["tag", "-l"]).lines().map(str::to_owned).collect();
    tags.sort();
    assert_eq!(tags, ["lw", "unrelated", "v1"]);

    let events = h.events(fx.id());
    assert!(events.iter().any(|e| e.percent.is_some()), "no progress percent was streamed");
    assert!(events.iter().all(|e| e.kind == OpKind::Push));
    assert!(h.lines(fx.id()).iter().any(|l| l.starts_with("Writing objects: 100%")), "{:?}", h.lines(fx.id()));
    assert_eq!(events.last().map(|e| e.status.clone()), Some(StepStatus::Done));
}

#[tokio::test]
async fn p6_refetch_updates_only_the_targeted_tracking_ref() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("p6");
    let colleague = sb.clone_of(&fx, "colleague");
    colleague.git(&["push", "-q", "origin", "main:other"]);
    fx.git(&["fetch", "-q"]);
    let other_before = fx.git(&["rev-parse", "refs/remotes/origin/other"]);
    colleague.write("m.txt", "m\n");
    colleague.commit_all("main moved");
    colleague.git(&["push", "-q", "origin", "main"]);
    colleague.git(&["push", "-q", "origin", "HEAD:other"]);
    fx.write("local.txt", "l\n");
    fx.commit_all("local");
    let stale = fx.git(&["rev-parse", "refs/remotes/origin/main"]);

    let info = push::plan(&h.plain(), &fx.cfg, &[], false).await.unwrap();
    assert!(info.stale_as_of_ms.is_some(), "an unverified plan must say it may be stale");
    assert_eq!(fx.git(&["rev-parse", "refs/remotes/origin/main"]), stale);

    let info = push::plan(&h.plain(), &fx.cfg, &[], true).await.unwrap();
    assert_eq!(info.stale_as_of_ms, None);
    assert_eq!(info.commits.len(), 1);
    assert_eq!(fx.git(&["rev-parse", "refs/remotes/origin/main"]).trim(), fx.remote_ref("main").unwrap());
    assert_eq!(fx.git(&["rev-parse", "refs/remotes/origin/other"]), other_before, "only the target ref may move");
}

#[tokio::test]
async fn p6_a_branch_missing_on_the_remote_and_an_unreachable_remote_are_both_plain_plan_results() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let mut fx = sb.repo_with_remote("p6b");
    fx.write("local.txt", "l\n");
    fx.commit_all("local");
    fx.map_push_target("main", "origin", "nope");

    let info = push::plan(&h.plain(), &fx.cfg, &[], true).await.unwrap();
    assert!(info.new_remote_branch && info.stale_as_of_ms.is_none(), "ls-remote rc 2 means absent, not failed");
    assert_eq!(info.commits.len(), 1);

    fx.git(&["remote", "set-url", "origin", sb.root().join("remotes/missing.git").to_str().unwrap()]);
    let info = push::plan(&h.plain(), &fx.cfg, &[], true).await.unwrap();
    assert!(info.can_push && info.stale_as_of_ms.is_some());
}

#[tokio::test]
async fn planning_never_rewrites_the_index() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("ro");
    fx.write("README", "touched\n");
    let index = fx.index_bytes();

    push::plan(&h.plain(), &fx.cfg, &[], true).await.unwrap();

    assert_eq!(fx.index_bytes(), index);
}

#[tokio::test]
async fn commit_files_lists_renames_deletions_and_first_parent_changes_of_merges() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("files");
    fx.write("old.txt", &numbered(20));
    fx.write("gone.txt", "x\n");
    fx.write("keep.txt", "k\n");
    fx.commit_all("base");
    fx.git(&["mv", "old.txt", "new.txt"]);
    fx.remove("gone.txt");
    fx.write("keep.txt", "k2\n");
    fx.write("added.txt", "a\n");
    let oid = fx.commit_all("mixed");

    let mut files = push::commit_files(&h.plain(), &fx.cfg, &oid).await.unwrap();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let got: Vec<(&str, Option<&str>, ChangeKind)> =
        files.iter().map(|f| (f.path.as_str(), f.orig_path.as_deref(), f.kind.clone())).collect();
    assert_eq!(
        got,
        [
            ("added.txt", None, ChangeKind::Added),
            ("gone.txt", None, ChangeKind::Deleted),
            ("keep.txt", None, ChangeKind::Modified),
            ("new.txt", Some("old.txt"), ChangeKind::Renamed),
        ]
    );

    fx.git(&["checkout", "-q", "-b", "feature"]);
    fx.write("feature.txt", "f\n");
    fx.commit_all("feature");
    fx.git(&["checkout", "-q", "main"]);
    fx.write("main-only.txt", "m\n");
    fx.commit_all("main");
    fx.git(&["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);
    let merged = push::commit_files(&h.plain(), &fx.cfg, &fx.head()).await.unwrap();
    assert_eq!(merged.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["feature.txt"]);

    assert!(push::commit_files(&h.plain(), &fx.cfg, "--output=/tmp/x").await.is_err());
}

fn advance_remote(sb: &Sandbox, fx: &Fixture, file: &str) -> Fixture {
    let colleague = sb.clone_of(fx, "colleague");
    colleague.write(file, "from colleague\n");
    colleague.commit_all(&format!("add {file}"));
    colleague.git(&["push", "-q", "origin", "main"]);
    colleague
}

#[tokio::test]
async fn pull_fast_forwards_and_refuses_diverged_branches_in_ff_only_mode() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("pull-ff");
    advance_remote(&sb, &fx, "theirs.txt");

    let o = h.pull(&fx, PullMode::FfOnly).await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.remote_ref("main"), Some(fx.head()));
    assert!(fx.exists("theirs.txt"));

    fx.write("mine.txt", "m\n");
    let mine = fx.commit_all("mine");
    advance_remote(&sb, &fx, "more.txt");
    let o = h.pull(&fx, PullMode::FfOnly).await;
    assert_eq!(failure_kind(&o), FailureKind::NonFastForward, "{o:?}");
    assert_eq!(fx.head(), mine);
}

#[tokio::test]
async fn pull_merge_and_rebase_integrate_a_diverged_remote() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("pull-merge");
    fx.write("mine.txt", "m\n");
    let mine = fx.commit_all("mine");
    advance_remote(&sb, &fx, "theirs.txt");

    let o = h.pull(&fx, PullMode::Merge).await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.git(&["rev-list", "--parents", "-n", "1", "HEAD"]).split_whitespace().count(), 3);
    assert!(fx.exists("theirs.txt") && fx.exists("mine.txt"));
    fx.assert_clean_commit("HEAD");

    fx.git(&["reset", "-q", "--hard", &mine]);
    let o = h.pull(&fx, PullMode::Rebase).await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.git(&["rev-list", "--parents", "-n", "1", "HEAD"]).split_whitespace().count(), 2);
    assert_eq!(fx.git(&["log", "-1", "--format=%s"]).trim(), "mine");
    assert!(fx.exists("theirs.txt"));
    assert_eq!(fx.git(&["log", "-1", "--format=%cN"]).trim(), NAME);
}

#[tokio::test]
async fn pull_is_refused_in_the_middle_of_a_merge_and_reports_blocking_local_changes() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("pull-refuse");
    std::fs::write(fx.git_dir().join("MERGE_HEAD"), format!("{}\n", fx.head())).unwrap();
    let o = h.pull(&fx, PullMode::FfOnly).await;
    assert_eq!(failure_kind(&o), FailureKind::Conflict);
    assert!(o.failure.unwrap().message.contains("merge"));
    std::fs::remove_file(fx.git_dir().join("MERGE_HEAD")).unwrap();

    advance_remote(&sb, &fx, "README");
    fx.write("README", "local edit\n");
    let o = h.pull(&fx, PullMode::FfOnly).await;
    assert_eq!(failure_kind(&o), FailureKind::Conflict, "{o:?}");
    assert_eq!(fx.read_string("README"), "local edit\n");
}

#[tokio::test]
async fn pull_and_fetch_report_an_unreachable_remote_as_a_network_failure() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("pull-net");
    fx.git(&["remote", "set-url", "origin", sb.root().join("remotes/missing.git").to_str().unwrap()]);

    assert_eq!(failure_kind(&h.pull(&fx, PullMode::FfOnly).await), FailureKind::Network);
    assert_eq!(failure_kind(&h.fetch(&fx).await), FailureKind::Network);
}

#[tokio::test]
async fn fetch_is_targeted_and_follows_the_push_target_mapping() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let mut fx = sb.repo_with_remote("fetch");
    let colleague = advance_remote(&sb, &fx, "theirs.txt");
    colleague.git(&["push", "-q", "origin", "main:unrelated"]);
    let before = fx.git(&["rev-parse", "refs/remotes/origin/main"]);

    let o = h.fetch(&fx).await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_ne!(fx.git(&["rev-parse", "refs/remotes/origin/main"]), before);
    assert_eq!(fx.git(&["rev-parse", "refs/remotes/origin/main"]).trim(), fx.remote_ref("main").unwrap());
    assert_ne!(fx.git_try(&["rev-parse", "-q", "--verify", "refs/remotes/origin/unrelated"]).0, 0, "fetch must stay targeted");

    colleague.git(&["push", "-q", "origin", "main:admin-remote-branch"]);
    fx.git(&["checkout", "-q", "-b", "feature-light-design"]);
    fx.map_push_target("feature-light-design", "origin", "admin-remote-branch");
    let o = h.fetch(&fx).await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(
        fx.git(&["rev-parse", "refs/remotes/origin/admin-remote-branch"]).trim(),
        fx.remote_ref("admin-remote-branch").unwrap()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn p7_cancelling_a_slow_pre_push_hook_kills_the_process_group_and_keeps_the_commit() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("p7");
    fx.write("a.txt", "a\n");
    let local = fx.commit_all("work");
    let (p1, p2) = (fx.path.join("hook.pid"), fx.path.join("sleep.pid"));
    fx.hook("pre-push", &format!("echo $$ > {}\nsleep 60 &\necho $! > {}\nwait", p1.display(), p2.display()));
    let before = fx.remote_ref("main");
    let (ctx, cancel) = h.run(OpKind::Push);
    let canceller = tokio::spawn({
        let p2 = p2.clone();
        async move {
            while !p2.exists() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
            cancel.cancel();
        }
    });

    let o = push::run_push(&ctx, &fx.cfg, &target(&fx, "main", TagsMode::None), false).await;
    canceller.await.unwrap();

    assert_eq!(o.status, StepStatus::Cancelled, "{o:?}");
    assert_eq!(fx.head(), local, "committed work must stay");
    assert_eq!(fx.remote_ref("main"), before);
    for pid in [p1, p2].iter().filter_map(|p| read_pid(p)) {
        assert!(wait_until(Duration::from_secs(4), || !pid_alive(pid)), "process {pid} survived the cancel");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn p7_cancelling_during_a_slow_remote_pre_receive_leaves_the_remote_untouched() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("p7b");
    fx.write("a.txt", "a\n");
    fx.commit_all("work");
    let pid_file = fx.path.join("remote.pid");
    fx.remote_hook("pre-receive", &format!("echo $$ > {}\nsleep 60", pid_file.display()));
    let before = fx.remote_ref("main");
    let (ctx, cancel) = h.run(OpKind::Push);
    let canceller = tokio::spawn({
        let pid_file = pid_file.clone();
        async move {
            while !pid_file.exists() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
            cancel.cancel();
        }
    });

    let o = push::run_push(&ctx, &fx.cfg, &target(&fx, "main", TagsMode::None), false).await;
    canceller.await.unwrap();

    assert_eq!(o.status, StepStatus::Cancelled, "{o:?}");
    assert_eq!(fx.remote_ref("main"), before);
    let pid = read_pid(&pid_file).unwrap();
    assert!(wait_until(Duration::from_secs(4), || !pid_alive(pid)), "remote hook {pid} survived the cancel");
}

#[tokio::test]
async fn invalid_remote_and_branch_names_are_rejected_before_spawning() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("names");
    let bad = PushTarget { remote: "--upload-pack=touch /tmp/pwned".into(), ..target(&fx, "main", TagsMode::None) };
    let o = h.push_with(&fx, bad, false).await;
    assert_eq!(o.status, StepStatus::Failed);
    let bad = PushTarget { force_with_lease: Some(ForceWithLease { seen_oid: "not-an-oid; rm".into() }), ..target(&fx, "main", TagsMode::None) };
    let o = h.push_with(&fx, bad, false).await;
    assert_eq!(o.status, StepStatus::Failed);
}

#[tokio::test]
async fn the_plan_counts_remote_commits_a_force_push_would_drop() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("remote-only");
    let info = push::plan(&h.plain(), &fx.cfg, &[], false).await.unwrap();
    assert_eq!(info.remote_only, Some(0));
    let first_tip = fx.remote_ref("main");
    assert_eq!(info.remote_oid.as_deref(), first_tip.as_deref());

    let colleague = sb.clone_of(&fx, "colleague-ro");
    colleague.write("theirs.txt", "t\n");
    colleague.commit_all("their work");
    colleague.git(&["push", "-q", "origin", "main"]);
    fx.write("mine.txt", "m\n");
    fx.commit_all("my work");

    // tracking ref not refreshed yet: the count is as of the last fetch; a refetching plan sees the colleague's commit
    assert_eq!(push::plan(&h.plain(), &fx.cfg, &[], false).await.unwrap().remote_only, Some(0));
    let refetched = push::plan(&h.plain(), &fx.cfg, &[], true).await.unwrap();
    assert_eq!(refetched.remote_only, Some(1));
    // the oid is the remote tip that count was computed against: the colleague's commit
    assert_eq!(refetched.remote_oid.as_deref(), fx.remote_ref("main").as_deref());
    assert_ne!(refetched.remote_oid.as_deref(), first_tip.as_deref());
}

#[tokio::test]
async fn a_plan_without_a_tracking_ref_has_no_remote_oid() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("no-tracking");
    fx.git(&["checkout", "-q", "-b", "fresh"]);
    fx.write("n.txt", "n\n");
    fx.commit_all("new branch");
    let info = push::plan(&h.plain(), &fx.cfg, &[], false).await.unwrap();
    assert!(info.new_remote_branch, "{info:?}");
    assert_eq!((info.remote_oid, info.remote_only), (None, None));
}
