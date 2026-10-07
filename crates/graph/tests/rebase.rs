mod common;

use common::{Repo, Sandbox};
use intely_graph::types::{InProgressOp, OpStatus, RebaseAction, RebasePlan};
use intely_graph::Graph;

/// main: base; work: one commit per name, each in its own file (no conflicts between them).
fn work_branch(sb: &Sandbox, names: &[&str]) -> Repo {
    let r = sb.repo("api");
    r.commit("base", &[("base.txt", "base\n")]);
    r.git(&["checkout", "-q", "-b", "work"]);
    for n in names {
        r.commit(n, &[(&format!("{n}.txt"), &format!("{n}\n"))]);
    }
    r
}

fn step<'a>(plan: &'a mut RebasePlan, subject: &str) -> &'a mut intely_graph::types::RebaseStep {
    plan.steps.iter_mut().find(|s| s.subject == subject).unwrap_or_else(|| panic!("no step {subject}"))
}

fn body(r: &Repo, rev: &str) -> String {
    r.git(&["log", "-1", "--format=%B", rev])
}

#[tokio::test]
async fn pick_reorder_drop_reword_squash_and_fixup_rewrite_the_history() {
    let sb = Sandbox::new();
    let r = work_branch(&sb, &["one", "two", "three", "fix two", "drop me", "six", "seven"]);
    let env = sb.env(&[&r]);
    let g = Graph::new(None);
    let mut plan = g.rebase_plan(&env, "api", "main").await.expect("plan");
    assert_eq!(plan.steps.len(), 7);
    assert!(plan.steps.iter().all(|s| s.action == RebaseAction::Pick));

    // move "fix two" up behind "two" and fold it in; reword "three"; squash "seven" into "six"; drop "drop me"
    let fix = plan.steps.remove(3);
    plan.steps.insert(2, fix);
    step(&mut plan, "fix two").action = RebaseAction::Fixup;
    let three = step(&mut plan, "three");
    three.action = RebaseAction::Reword;
    three.message = Some("feat: three, reworded\n\nwith a body".into());
    step(&mut plan, "drop me").action = RebaseAction::Drop;
    let seven = step(&mut plan, "seven");
    seven.action = RebaseAction::Squash;
    seven.message = Some("feat: six and seven".into());

    let out = g.rebase_run(&env, &plan, None).await.expect("rebase");
    assert_eq!(out.status, OpStatus::Done, "{out:?}");
    assert_eq!(r.subjects(), vec!["feat: six and seven", "feat: three, reworded", "two", "one", "base"]);
    assert_eq!(body(&r, "HEAD~1"), "feat: three, reworded\n\nwith a body");
    // nothing was added to any message
    for rev in ["HEAD", "HEAD~1", "HEAD~2", "HEAD~3"] {
        let b = body(&r, rev);
        assert!(!b.contains("Co-authored") && !b.contains("Signed-off") && !b.contains("cherry picked"), "{b}");
    }
    // fixup and squash contents survived
    // base + one, two, "fix two" (folded in), three, six, seven; "drop me" is gone
    assert_eq!(r.git(&["ls-tree", "--name-only", "HEAD"]).lines().count(), 7);
    assert!(!r.path.join("drop me.txt").exists());
    assert_eq!(g.op_state(&env, "api").await.expect("state").kind, InProgressOp::None);
}

#[tokio::test]
async fn reword_chains_with_squash_and_fixup_use_the_prepared_message() {
    let sb = Sandbox::new();
    let r = work_branch(&sb, &["a", "a2", "b", "b2"]);
    let env = sb.env(&[&r]);
    let g = Graph::new(None);
    let mut plan = g.rebase_plan(&env, "api", "main").await.expect("plan");
    let a = step(&mut plan, "a");
    a.action = RebaseAction::Reword;
    a.message = Some("A new".into());
    step(&mut plan, "a2").action = RebaseAction::Squash;
    let b = step(&mut plan, "b");
    b.action = RebaseAction::Reword;
    b.message = Some("B new".into());
    step(&mut plan, "b2").action = RebaseAction::Fixup;
    let out = g.rebase_run(&env, &plan, None).await.expect("rebase");
    assert_eq!(out.status, OpStatus::Done, "{out:?}");
    assert_eq!(r.subjects(), vec!["B new", "A new", "base"], "squash after reword keeps one commit with the prepared message");
}

#[tokio::test]
async fn an_unchanged_plan_does_nothing_and_a_bad_plan_is_refused() {
    let sb = Sandbox::new();
    let r = work_branch(&sb, &["one", "two"]);
    let env = sb.env(&[&r]);
    let g = Graph::new(None);
    let before = r.head();
    let plan = g.rebase_plan(&env, "api", "main").await.expect("plan");
    assert_eq!(g.rebase_run(&env, &plan, None).await.expect("noop").status, OpStatus::Done);
    assert_eq!(r.head(), before);

    let mut bad = plan.clone();
    bad.steps[0].action = RebaseAction::Squash;
    assert_eq!(g.rebase_run(&env, &bad, None).await.unwrap_err().code, "invalidArgument");
    let mut bad = plan.clone();
    bad.steps[0].action = RebaseAction::Reword;
    assert_eq!(g.rebase_run(&env, &bad, None).await.unwrap_err().code, "invalidArgument");
    let mut bad = plan.clone();
    bad.steps[1].oid = "f".repeat(40);
    assert_eq!(g.rebase_run(&env, &bad, None).await.unwrap_err().code, "invalidArgument");
    let mut bad = plan.clone();
    bad.steps.push(bad.steps[0].clone());
    assert_eq!(g.rebase_run(&env, &bad, None).await.unwrap_err().code, "invalidArgument");
    assert_eq!(r.head(), before);
}

#[tokio::test]
async fn a_dirty_tree_and_protected_branches_stop_the_rebase_before_git_runs() {
    let sb = Sandbox::new();
    let r = work_branch(&sb, &["one", "two"]);
    let env = sb.env(&[&r]);
    let g = Graph::new(None);
    let mut plan = g.rebase_plan(&env, "api", "main").await.expect("plan");
    plan.steps.swap(0, 1);
    let before = r.head();

    r.write("one.txt", "edited\n");
    assert_eq!(g.rebase_run(&env, &plan, None).await.unwrap_err().code, "dirtyTree");
    r.git(&["checkout", "--", "one.txt"]);

    // on a protected branch ("main") the exact name must be typed
    r.git(&["checkout", "-q", "main"]);
    r.git(&["checkout", "-q", "-B", "release/1", "work"]);
    let mut plan = g.rebase_plan(&env, "api", "main").await.expect("plan");
    plan.steps.swap(0, 1);
    assert_eq!(g.rebase_run(&env, &plan, None).await.unwrap_err().code, "liveBranchConfirm");
    assert_eq!(g.rebase_run(&env, &plan, Some("release/")).await.unwrap_err().code, "liveBranchConfirm");
    assert_eq!(r.head(), before);
    let out = g.rebase_run(&env, &plan, Some("release/1")).await.expect("confirmed");
    assert_eq!(out.status, OpStatus::Done);
    assert_eq!(r.subjects(), vec!["one", "two", "base"]);

    // a per-repo live pattern protects an ordinary branch too
    r.git(&["checkout", "-q", "-B", "hotfix", "main"]);
    let mut env = env;
    env.ws.live_branches.insert("api".into(), vec!["hotfix".into()]);
    r.commit("h1", &[("h1.txt", "1")]);
    r.commit("h2", &[("h2.txt", "2")]);
    let mut plan = g.rebase_plan(&env, "api", "main").await.expect("plan");
    plan.steps.swap(0, 1);
    assert_eq!(g.rebase_run(&env, &plan, None).await.unwrap_err().code, "liveBranchConfirm");
}

#[tokio::test]
async fn the_jail_refuses_a_rebase_outside_the_fixture_root() {
    let sb = Sandbox::new();
    let r = work_branch(&sb, &["one", "two"]);
    let other = tempfile::tempdir().expect("other root");
    let g = Graph::new(None);
    let env = sb.env_in(&other.path().canonicalize().expect("canon"), &[&r]);
    let mut plan = g.rebase_plan(&env, "api", "main").await.expect("planning only reads");
    plan.steps.swap(0, 1);
    let before = r.head();
    assert_eq!(g.rebase_run(&env, &plan, None).await.unwrap_err().code, "testJail");
    assert_eq!(g.cherry_pick(&env, "api", &[before.clone()], None).await.unwrap_err().code, "testJail");
    assert_eq!(r.head(), before);
    assert_eq!(g.same_branch_create(&env, &["api".to_owned()], "x", None).await.expect("preflight").repos[0].error.as_ref().map(|e| e.code.as_str()), Some("testJail"));
}

/// main: base(f=base); work: c1(f=one), c2(f=two) -> swapping them conflicts on f.txt
fn conflicting(sb: &Sandbox) -> Repo {
    let r = sb.repo("api");
    r.commit("base", &[("f.txt", "base\n")]);
    r.git(&["checkout", "-q", "-b", "work"]);
    r.commit("c1", &[("f.txt", "one\n")]);
    r.commit("c2", &[("f.txt", "two\n")]);
    r
}

#[tokio::test]
async fn a_conflict_is_reported_and_abort_restores_the_branch() {
    let sb = Sandbox::new();
    let r = conflicting(&sb);
    let env = sb.env(&[&r]);
    let g = Graph::new(None);
    let before = r.head();
    let mut plan = g.rebase_plan(&env, "api", "main").await.expect("plan");
    plan.steps.swap(0, 1);
    let out = g.rebase_run(&env, &plan, None).await.expect("stops, does not fail");
    assert_eq!((out.kind.clone(), out.status.clone()), (InProgressOp::Rebase, OpStatus::Conflict), "{out:?}");
    assert_eq!(out.conflict_files, vec!["f.txt"]);
    assert_eq!((out.step, out.total), (1, 2));
    assert_eq!(g.op_state(&env, "api").await.expect("state").status, OpStatus::Conflict);
    assert_eq!(g.rebase_run(&env, &plan, None).await.unwrap_err().code, "opInProgress");
    assert_eq!(g.rebase_continue(&env, "api").await.unwrap_err().code, "conflictsRemain");

    let aborted = g.rebase_abort(&env, "api").await.expect("abort");
    assert_eq!(aborted.status, OpStatus::Idle);
    assert_eq!(r.head(), before);
    assert_eq!(g.rebase_abort(&env, "api").await.unwrap_err().code, "nothingInProgress");
}

#[tokio::test]
async fn continuing_after_resolving_finishes_and_keeps_later_rewords() {
    let sb = Sandbox::new();
    let r = conflicting(&sb);
    r.commit("c3", &[("g.txt", "g\n")]);
    let env = sb.env(&[&r]);
    let g = Graph::new(None);
    let mut plan = g.rebase_plan(&env, "api", "main").await.expect("plan");
    plan.steps.swap(0, 1); // c2, c1, c3
    let c3 = step(&mut plan, "c3");
    c3.action = RebaseAction::Reword;
    c3.message = Some("c3 reworded".into());
    let out = g.rebase_run(&env, &plan, None).await.expect("stops");
    assert_eq!(out.status, OpStatus::Conflict, "{out:?}");

    // c2 and then c1 conflict on f.txt (the order was swapped); c3 is clean
    let mut done = out;
    for round in 0..3 {
        if done.status != OpStatus::Conflict {
            break;
        }
        r.write("f.txt", &format!("resolved {round}\n"));
        r.git(&["add", "f.txt"]);
        done = g.rebase_continue(&env, "api").await.expect("continue");
    }
    assert_eq!(done.status, OpStatus::Done, "{done:?}");
    assert_eq!(r.subjects(), vec!["c3 reworded", "c1", "c2", "base"]);
    assert_eq!(std::fs::read_to_string(r.path.join("f.txt")).expect("read"), "resolved 1\n");
}

#[tokio::test]
async fn cherry_pick_copies_commits_without_marking_the_message() {
    let sb = Sandbox::new();
    let r = sb.repo("api");
    r.commit("base", &[("f.txt", "base\n")]);
    r.git(&["checkout", "-q", "-b", "topic"]);
    let a = r.commit("topic a", &[("a.txt", "a\n")]);
    let b = r.commit("topic b", &[("b.txt", "b\n")]);
    r.git(&["checkout", "-q", "-b", "target", "main"]);
    let env = sb.env(&[&r]);
    let g = Graph::new(None);

    let out = g.cherry_pick(&env, "api", &[a.clone(), b.clone()], None).await.expect("pick");
    assert_eq!(out.status, OpStatus::Done, "{out:?}");
    assert_eq!(r.subjects(), vec!["topic b", "topic a", "base"]);
    assert_eq!(body(&r, "HEAD"), "topic b");
    assert_eq!(g.cherry_pick(&env, "api", &["nope".into()], None).await.unwrap_err().code, "invalidArgument");

    // on a protected branch it needs the typed name
    r.git(&["checkout", "-q", "main"]);
    assert_eq!(g.cherry_pick(&env, "api", &[a.clone()], None).await.unwrap_err().code, "liveBranchConfirm");
}

#[tokio::test]
async fn a_cherry_pick_conflict_can_be_aborted_or_continued() {
    let sb = Sandbox::new();
    let r = sb.repo("api");
    r.commit("base", &[("f.txt", "base\n")]);
    r.git(&["checkout", "-q", "-b", "topic"]);
    let t = r.commit("topic change", &[("f.txt", "topic\n")]);
    r.git(&["checkout", "-q", "-b", "target", "main"]);
    r.commit("target change", &[("f.txt", "target\n")]);
    let env = sb.env(&[&r]);
    let g = Graph::new(None);
    let before = r.head();

    let out = g.cherry_pick(&env, "api", &[t.clone()], None).await.expect("stops");
    assert_eq!((out.kind.clone(), out.status.clone()), (InProgressOp::CherryPick, OpStatus::Conflict), "{out:?}");
    assert_eq!(out.conflict_files, vec!["f.txt"]);
    assert_eq!(g.cherry_pick_continue(&env, "api").await.unwrap_err().code, "conflictsRemain");
    assert_eq!(g.cherry_pick_abort(&env, "api").await.expect("abort").status, OpStatus::Idle);
    assert_eq!(r.head(), before);

    g.cherry_pick(&env, "api", &[t], None).await.expect("stops again");
    r.write("f.txt", "both\n");
    r.git(&["add", "f.txt"]);
    let done = g.cherry_pick_continue(&env, "api").await.expect("continue");
    assert_eq!(done.status, OpStatus::Done, "{done:?}");
    assert_eq!(r.subjects()[0], "topic change");
}

#[tokio::test]
async fn merges_in_the_range_are_not_rebased() {
    let sb = Sandbox::new();
    let r = work_branch(&sb, &["one"]);
    r.git(&["checkout", "-q", "-b", "side", "main"]);
    r.commit("side", &[("side.txt", "s")]);
    r.git(&["checkout", "-q", "work"]);
    r.git(&["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    let env = sb.env(&[&r]);
    assert_eq!(Graph::new(None).rebase_plan(&env, "api", "main").await.unwrap_err().code, "unsupportedRange");
}
