//! Multi-repo scenarios: parallel commit and push, partial failure with retry, cost on a big repo, and real
//! husky 9 + lint-staged (skipped with a clear message when npm is offline).

mod common;

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::*;
use intely_core::git::push;
use intely_core::{FailureKind, PullMode, StepStatus};

/// The remote branch each of the four roles pushes to.
const REMOTE_BRANCHES: [&str; 4] = ["sandbox", "admin-remote-branch", "main", "main"];

fn touch_app(fx: &Fixture, text: &str) {
    fx.write("src/app.txt", &format!("line 1\nline 2\nline 3\n{text}\n"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn four_repos_commit_in_parallel_despite_slow_hooks() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let repos = sb.four();
    for fx in &repos {
        fx.hook("pre-commit", "sleep 3");
        touch_app(fx, "parallel");
    }
    let started = Instant::now();

    let (a, b, c, d) = tokio::join!(
        h.commit(&repos[0], vec![whole("src/app.txt")], "parallel backend"),
        h.commit(&repos[1], vec![whole("src/app.txt")], "parallel admin"),
        h.commit(&repos[2], vec![whole("src/app.txt")], "parallel services"),
        h.commit(&repos[3], vec![whole("src/app.txt")], "parallel pos"),
    );

    let wall = started.elapsed();
    for (o, fx) in [a, b, c, d].iter().zip(&repos) {
        assert_eq!(o.status, StepStatus::Done, "{}: {o:?}", fx.id());
    }
    assert!(wall >= Duration::from_secs(3) && wall < Duration::from_secs(9), "4 x 3 s hooks took {wall:?}, serial would be 12 s");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn four_repos_are_committed_and_pushed_in_parallel_with_the_fixture_identity() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let repos = sb.four();
    for fx in &repos {
        touch_app(fx, "shipped");
    }
    let files = || vec![whole("src/app.txt")];

    let (a, b, c, d) = tokio::join!(
        h.commit(&repos[0], files(), "ship backend"),
        h.commit(&repos[1], files(), "ship admin"),
        h.commit(&repos[2], files(), "ship services"),
        h.commit(&repos[3], files(), "ship pos"),
    );
    for o in [&a, &b, &c, &d] {
        assert_eq!(o.status, StepStatus::Done, "{o:?}");
    }
    let (a, b, c, d) = tokio::join!(
        h.push(&repos[0], REMOTE_BRANCHES[0]),
        h.push(&repos[1], REMOTE_BRANCHES[1]),
        h.push(&repos[2], REMOTE_BRANCHES[2]),
        h.push(&repos[3], REMOTE_BRANCHES[3]),
    );
    for o in [&a, &b, &c, &d] {
        assert_eq!(o.status, StepStatus::Done, "{o:?}");
    }

    for (fx, branch) in repos.iter().zip(REMOTE_BRANCHES) {
        assert_eq!(fx.remote_ref(branch), Some(fx.head()), "{}", fx.id());
        fx.assert_clean_commit("HEAD");
        assert_eq!(fx.status(), "", "{}", fx.id());
    }
    // the admin repo pushed `feature-light-design` to a differently named remote branch
    assert_eq!(repos[1].remote_ref("feature-light-design"), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_failing_hook_does_not_stop_the_others_and_only_the_failed_repo_is_retried() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let repos = sb.four();
    repos[2].hook("pre-commit", "echo 'services lint failed' >&2\nexit 1");
    for fx in &repos {
        touch_app(fx, "round one");
    }
    let files = || vec![whole("src/app.txt")];

    let (a, b, c, d) = tokio::join!(
        h.commit(&repos[0], files(), "round one backend"),
        h.commit(&repos[1], files(), "round one admin"),
        h.commit(&repos[2], files(), "round one services"),
        h.commit(&repos[3], files(), "round one pos"),
    );

    assert_eq!([&a, &b, &d].map(|o| o.status.clone()), [StepStatus::Done, StepStatus::Done, StepStatus::Done]);
    assert_eq!(c.status, StepStatus::Failed);
    assert_eq!(failure_kind(&c), FailureKind::HookRejected);
    assert!(failure_output(&c).contains("services lint failed"));
    let heads: Vec<String> = repos.iter().map(Fixture::head).collect();
    let services_remote = repos[2].remote_ref("main");
    let counts: Vec<String> = repos.iter().map(|r| r.git(&["rev-list", "--count", "HEAD"])).collect();

    // push only what was committed
    let (pa, pb, pd) = tokio::join!(
        h.push(&repos[0], REMOTE_BRANCHES[0]),
        h.push(&repos[1], REMOTE_BRANCHES[1]),
        h.push(&repos[3], REMOTE_BRANCHES[3]),
    );
    for o in [&pa, &pb, &pd] {
        assert_eq!(o.status, StepStatus::Done, "{o:?}");
    }
    assert_eq!(repos[2].remote_ref("main"), services_remote, "the failed repo must not be pushed");
    assert_eq!(repos[2].head(), heads[2], "the failed commit left no trace");

    // retry the failed repo only (without hooks, as the results sheet offers it after confirmation)
    let retry = h.commit_with(&repos[2], files(), "round one services", false, true).await;
    assert_eq!(retry.status, StepStatus::Done, "{retry:?}");
    let po = h.push(&repos[2], REMOTE_BRANCHES[2]).await;
    assert_eq!(po.status, StepStatus::Done, "{po:?}");

    for i in [0, 1, 3] {
        assert_eq!(repos[i].head(), heads[i], "{} was touched by the retry", repos[i].id());
        assert_eq!(repos[i].git(&["rev-list", "--count", "HEAD"]), counts[i]);
    }
    assert_eq!(repos[2].remote_ref("main"), Some(repos[2].head()));
    for fx in &repos {
        fx.assert_clean_commit("HEAD");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rejected_push_in_one_repo_leaves_the_others_pushed_and_pull_then_push_recovers() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let repos = sb.four();
    let colleague = sb.clone_of(&repos[3], "colleague");
    colleague.write("theirs.txt", "t\n");
    colleague.commit_all("their work");
    colleague.git(&["push", "-q", "origin", "main"]);
    for fx in &repos {
        touch_app(fx, "mine");
        fx.commit_all("mine");
    }

    let (a, b, c, d) = tokio::join!(
        h.push(&repos[0], REMOTE_BRANCHES[0]),
        h.push(&repos[1], REMOTE_BRANCHES[1]),
        h.push(&repos[2], REMOTE_BRANCHES[2]),
        h.push(&repos[3], REMOTE_BRANCHES[3]),
    );

    assert_eq!([&a, &b, &c].map(|o| o.status.clone()), [StepStatus::Done, StepStatus::Done, StepStatus::Done]);
    assert_eq!(failure_kind(&d), FailureKind::NonFastForward, "{d:?}");

    let pulled = h.pull(&repos[3], PullMode::Merge).await;
    assert_eq!(pulled.status, StepStatus::Done, "{pulled:?}");
    let pushed = h.push(&repos[3], "main").await;
    assert_eq!(pushed.status, StepStatus::Done, "{pushed:?}");
    assert_eq!(repos[3].remote_ref("main"), Some(repos[3].head()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_mid_push_after_commit_and_push_leaves_the_local_commit() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo_with_remote("commit-and-push");
    fx.write("a.txt", "a\n");
    let o = h.commit(&fx, vec![whole("a.txt")], "committed first").await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    let committed = fx.head();
    let marker = fx.path.join("pre-push.started");
    fx.hook("pre-push", &format!("touch {}\nsleep 60", marker.display()));
    let (ctx, cancel) = h.run(intely_core::OpKind::Push);
    let canceller = tokio::spawn({
        let marker = marker.clone();
        async move {
            while !marker.exists() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            cancel.cancel();
        }
    });

    let o = push::run_push(&ctx, &fx.cfg, &target(&fx, "main", intely_core::TagsMode::None), false).await;
    canceller.await.unwrap();

    assert_eq!(o.status, StepStatus::Cancelled, "{o:?}");
    assert_eq!(fx.head(), committed);
    assert_ne!(fx.remote_ref("main"), Some(committed));
    let info = push::plan(&h.plain(), &fx.cfg, &[], false).await.unwrap();
    assert_eq!(info.commits.len(), 1, "Committed locally, not pushed");
    assert!(fx.temp_indexes().is_empty());
}

#[tokio::test]
#[ignore = "builds a 20 000 file repo (about 30 s); run with --ignored"]
async fn x2_a_commit_in_a_20000_file_repo_stays_fast() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("big");
    for dir in 0..200 {
        for file in 0..100 {
            fx.write(&format!("d{dir:03}/f{file:03}.txt"), &format!("{dir} {file}\n"));
        }
    }
    fx.commit_all("20 000 files");
    fx.write("d007/f007.txt", "changed\n");
    fx.write("d008/f008.txt", "changed\n");
    fx.stage(&["d008/f008.txt"]);

    let started = Instant::now();
    let o = h.commit(&fx, vec![whole("d007/f007.txt")], "one file").await;
    let took = started.elapsed();

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]).trim(), "d008/f008.txt");
    assert!(took < Duration::from_millis(2500), "commit took {took:?} (spike: 190-260 ms with the seeded temp index)");
}

// ---- real husky 9 + lint-staged -------------------------------------------------------------------------------

fn run_with_deadline(fx: &Fixture, program: &str, args: &[&str], limit: Duration) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(&fx.path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{program}: {e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                let out = child.wait_with_output().map_err(|e| e.to_string())?;
                return if status.success() {
                    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
                } else {
                    Err(String::from_utf8_lossy(&out.stderr).into_owned())
                };
            }
            None if start.elapsed() > limit => {
                let _ = child.kill();
                return Err(format!("{program} timed out"));
            }
            None => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

const FORMAT_JS: &str = "const fs = require('fs');\nfor (const f of process.argv.slice(2)) {\n  const t = fs.readFileSync(f, 'utf8').replace(/[ \\t]+$/gm, '').replace(/foo/g, 'FOO');\n  fs.writeFileSync(f, t);\n}\n";

/// A repo with husky 9 (`core.hooksPath=.husky/_`) and lint-staged installed from the real registry.
fn husky_repo(sb: &Sandbox) -> Result<Fixture, String> {
    let fx = sb.repo("husky");
    fx.write(".gitignore", "node_modules\npackage-lock.json\n");
    fx.write("package.json", "{\"name\":\"fx\",\"version\":\"1.0.0\",\"private\":true,\"lint-staged\":{\"*.txt\":\"node format.js\"}}\n");
    fx.write("format.js", FORMAT_JS);
    fx.write("a.txt", "base a\n");
    fx.write("b.txt", "base b\n");
    fx.write("c.txt", &numbered(30));
    fx.commit_all("base");
    let install = ["install", "-D", "husky@9", "lint-staged", "--no-audit", "--no-fund", "--fetch-retries=0", "--fetch-timeout=20000", "--loglevel=error"];
    run_with_deadline(&fx, "npm", &install, Duration::from_secs(240))?;
    run_with_deadline(&fx, "npx", &["--no-install", "husky"], Duration::from_secs(60))?;
    fx.write(".husky/pre-commit", "npx --no-install lint-staged\n");
    Ok(fx)
}

macro_rules! husky_or_skip {
    ($sb:expr) => {
        match husky_repo(&$sb) {
            Ok(fx) => fx,
            Err(why) => {
                eprintln!("SKIPPED c9 (husky + lint-staged need npm online): {}", why.lines().next().unwrap_or(""));
                return;
            }
        }
    };
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn c9_husky_and_lint_staged_see_only_the_checked_file_and_their_rewrites_land_in_the_commit() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = husky_or_skip!(sb);
    assert_eq!(fx.git(&["config", "core.hooksPath"]).trim(), ".husky/_");
    fx.write("a.txt", "foo bar   \n");
    fx.write("b.txt", "foo staged   \n");
    fx.stage(&["b.txt"]);
    let b_line = fx.index_line("b.txt");
    let index_before_tmp = fx.temp_indexes();
    assert!(index_before_tmp.is_empty());

    let o = h.commit(&fx, vec![whole("a.txt")], "format a").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}\n{:?}", h.lines(fx.id()));
    assert_eq!(o.hook_modified_files, ["a.txt"]);
    assert_eq!(fx.show("HEAD:a.txt"), b"FOO bar\n");
    assert_eq!(fx.read_string("a.txt"), "FOO bar\n", "the worktree file is rewritten too");
    assert_eq!(fx.index_line("b.txt"), b_line, "the unchecked staged file must stay staged as it was");
    assert_eq!(fx.read_string("b.txt"), "foo staged   \n", "lint-staged must not touch unchecked files");
    assert_eq!(fx.git(&["stash", "list"]), "");
    assert!(fx.temp_indexes().is_empty());
    fx.assert_clean_commit("HEAD");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn c9_lint_staged_restores_the_unselected_hunks_after_a_partial_commit() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = husky_or_skip!(sb);
    let edited = edit_lines(&numbered(30), &[(2, "hunk one"), (15, "foo   "), (28, "hunk three")]);
    fx.write("c.txt", &edited);

    let o = h.commit(&fx, vec![partial("c.txt", &[(1, None)])], "middle hunk").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}\n{:?}", h.lines(fx.id()));
    assert_eq!(fx.show("HEAD:c.txt"), edit_lines(&numbered(30), &[(15, "FOO")]).into_bytes());
    let rest = hunk_lines(&fx, "c.txt");
    assert_eq!(rest.len(), 2, "unselected hunks must come back verbatim: {rest:?}");
    assert!(rest[0].contains(&"+hunk one".to_owned()) && rest[1].contains(&"+hunk three".to_owned()));
    assert_eq!(fx.git(&["stash", "list"]), "");
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "");
    assert!(fx.temp_indexes().is_empty());
}
