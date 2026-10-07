//! The safety layers of docs/safety.md against real git and file-transport remotes: the test jail (readOnly / testJail),
//! the exec-level guard, the hardened environment and the live-branch confirmation. Every repo is a throwaway fixture.

mod common;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, Once, OnceLock};
use std::time::{Duration, Instant};

use common::*;
use intely_core::exec::{run_git, RunOpts};
use intely_core::jail::{Jail, AGENT_GIT, LIVE_BRANCH_CONFIRM, READ_ONLY, TEST_JAIL};
use intely_core::{
    workspace, CommitRequest, Engine, EnvStatus, EventSink, FileSelection, OpEvent, OpResult, PullMode, PushRequest, RepoCommit,
    RepoSnapshot, StepStatus, TagsMode,
};

static PRIVATE_HOME: OnceLock<PathBuf> = OnceLock::new();

/// Runs when the test process exits (statics are never dropped, so a `TempDir` would be left behind in `$TMPDIR`).
extern "C" fn remove_private_home() {
    if let Some(dir) = PRIVATE_HOME.get() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// The engine resolves the login-shell environment into `$HOME/Library/...`; keep that away from the real home.
/// The directory is removed at process exit.
fn private_home() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let dir = tempfile::Builder::new().prefix("intely-jail-home-").tempdir().unwrap().keep();
        std::env::set_var("HOME", &dir);
        let _ = PRIVATE_HOME.set(dir);
        // SAFETY: registers a plain `extern "C"` function with no captured state.
        unsafe { libc::atexit(remove_private_home) };
    });
}

#[derive(Default)]
struct ResultSink {
    results: Mutex<Vec<OpResult>>,
}

impl EventSink for ResultSink {
    fn snapshot(&self, _: RepoSnapshot) {}
    fn op_event(&self, _: OpEvent) {}
    fn op_result(&self, r: OpResult) {
        self.results.lock().unwrap().push(r);
    }
    fn env(&self, _: EnvStatus) {}
}

async fn engine_for(sb: &Sandbox, fx: &[&Fixture], jail: Jail, protected: &[&str]) -> (Engine, Arc<ResultSink>) {
    private_home();
    let ws = workspace_of(fx.iter().enumerate().map(|(i, f)| intely_core::RepoConfig { order: i as u32, ..f.cfg.clone() }).collect(), protected);
    let file = sb.root().join("workspace.json");
    workspace::persist(&file, &ws).unwrap();
    let sink = Arc::new(ResultSink::default());
    (Engine::new_with_jail(file, sink.clone(), Arc::new(jail)).unwrap(), sink)
}

fn push_req(id: &str, branch: &str, confirm: Option<&str>, no_verify: bool) -> PushRequest {
    PushRequest {
        run_id: "r".into(),
        targets: vec![intely_core::PushTarget {
            repo_id: id.into(),
            remote: "origin".into(),
            remote_branch: branch.into(),
            tags: TagsMode::None,
            force_with_lease: None,
            confirm_live: confirm.map(str::to_owned),
        }],
        no_verify,
    }
}

fn commit_req(id: &str) -> CommitRequest {
    CommitRequest {
        run_id: "c".into(),
        repos: vec![RepoCommit {
            repo_id: id.into(),
            message: "x".into(),
            amend: false,
            files: vec![FileSelection::Whole { path: "new.txt".into(), orig_path: None }],
        }],
        no_verify: false,
    }
}

async fn wait_result(sink: &ResultSink) -> OpResult {
    let t = Instant::now();
    loop {
        if let Some(r) = sink.results.lock().unwrap().last().cloned() {
            return r;
        }
        assert!(t.elapsed() < Duration::from_secs(30), "no op:result");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A fixture with a bare origin and a second, unpushed commit.
fn ahead(sb: &Sandbox, name: &str) -> Fixture {
    let fx = sb.repo_with_remote(name);
    fx.write("new.txt", "n\n");
    fx.commit_all("ahead");
    fx
}

#[tokio::test]
async fn e2e_jail_refuses_every_mutation_outside_the_fixture_root() {
    let inside = Sandbox::new();
    let outside = Sandbox::new(); // a real repo, but not under the jail's root
    let fx = ahead(&outside, "elsewhere");
    let (head, remote) = (fx.head(), fx.remote_ref("main"));
    let (engine, _) = engine_for(&outside, &[&fx], Jail::e2e(inside.root()), &[]).await;

    for err in [
        engine.commit_start(commit_req("elsewhere")).await.unwrap_err(),
        engine.push_start(push_req("elsewhere", "feature", None, false)).await.unwrap_err(),
        engine.pull("elsewhere", PullMode::FfOnly).await.unwrap_err(),
        engine.fetch("elsewhere").await.unwrap_err(),
    ] {
        assert_eq!(err.code, TEST_JAIL, "{err:?}");
    }
    assert_eq!((fx.head(), fx.remote_ref("main")), (head, remote), "a refused command must not change anything");
    engine.shutdown().await;
}

#[test]
fn the_four_real_repo_paths_are_outside_every_fixture_root() {
    // Pure path judgements: nothing is opened for writing, only canonicalised.
    let sb = Sandbox::new();
    let jail = Jail::e2e(sb.root());
    for real in [
        "/Users/example/Projects/shop-backend",
        "/Users/example/Projects/admin",
        "/Users/example/Projects/shop-mobile",
        "/Users/example/Projects/shop-pos",
    ] {
        for op in ["commit_start", "push_start", "pull", "fetch"] {
            assert_eq!(jail.check_op(op, Path::new(real)).unwrap_err().code, TEST_JAIL, "{op} {real}");
        }
        assert_eq!(jail.check_git(Path::new(real), &["commit", "-m", "x"]).unwrap_err().code, TEST_JAIL);
        assert_eq!(Jail::read_only().check_op("commit_start", Path::new(real)).unwrap_err().code, READ_ONLY);
    }
    // the default root (the temp dir) does not contain them either
    let default_root = Jail::from_vars(|k| (k == "INTELY_E2E").then(|| "1".to_owned()));
    assert!(default_root.check_op("push_start", Path::new("/Users/example/Projects/admin")).is_err());
}

#[tokio::test]
async fn a_symlink_into_the_fixture_root_does_not_launder_a_foreign_repo() {
    let inside = Sandbox::new();
    let outside = Sandbox::new();
    let fx = outside.repo("foreign");
    let link = inside.root().join("looks-local");
    std::os::unix::fs::symlink(&fx.path, &link).unwrap();
    let jail = Jail::e2e(inside.root());
    assert_eq!(jail.check_op("commit_start", &link).unwrap_err().code, TEST_JAIL);
}

#[tokio::test]
async fn read_only_mode_refuses_commit_push_pull_and_fetch() {
    let sb = Sandbox::new();
    let fx = ahead(&sb, "ro");
    let (head, remote) = (fx.head(), fx.remote_ref("main"));
    let (engine, _) = engine_for(&sb, &[&fx], Jail::read_only(), &[]).await;
    for err in [
        engine.commit_start(commit_req("ro")).await.unwrap_err(),
        engine.push_start(push_req("ro", "feature", None, false)).await.unwrap_err(),
        engine.pull("ro", PullMode::FfOnly).await.unwrap_err(),
        engine.fetch("ro").await.unwrap_err(),
    ] {
        assert_eq!(err.code, READ_ONLY, "{err:?}");
    }
    assert_eq!((fx.head(), fx.remote_ref("main")), (head, remote));
    engine.shutdown().await;
}

#[tokio::test]
async fn https_and_ssh_remotes_are_refused_in_e2e_mode_before_git_runs() {
    let sb = Sandbox::new();
    for (i, url) in ["https://github.com/example/never-pushed.git", "ssh://git@github.com/example/x.git", "git@github.com:example/x.git"]
        .into_iter()
        .enumerate()
    {
        let fx = ahead(&sb, &format!("net{i}"));
        fx.git(&["remote", "set-url", "origin", url]);
        let (engine, _) = engine_for(&sb, &[&fx], Jail::e2e(sb.root()), &[]).await;
        let t = Instant::now();
        let err = engine.push_start(push_req(fx.id(), "feature", None, false)).await.unwrap_err();
        assert_eq!(err.code, TEST_JAIL, "{url}: {err:?}");
        assert!(t.elapsed() < Duration::from_secs(20), "must fail fast, no network, no prompt");
        assert_eq!(engine.fetch(fx.id()).await.unwrap_err().code, TEST_JAIL, "{url}");
        assert_eq!(engine.pull(fx.id(), PullMode::FfOnly).await.unwrap_err().code, TEST_JAIL, "{url}");
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn an_insteadof_rewrite_to_https_is_caught_by_the_effective_url() {
    let sb = Sandbox::new();
    let fx = ahead(&sb, "rewrite");
    fx.git(&["remote", "set-url", "origin", "mirror:example/x.git"]);
    fx.git(&["config", "url.https://github.com/.insteadOf", "mirror:"]);
    let h = Harness::new();
    let ctx = h.plain().with_jail(Arc::new(Jail::e2e(sb.root())));
    let err = run_git(&ctx, &fx.path, &["push", "origin", "main"], &RunOpts::default()).await.unwrap_err();
    assert_eq!(err.code, TEST_JAIL, "{err:?}");
}

#[tokio::test]
async fn the_exec_layer_refuses_without_the_engine_even_when_a_higher_layer_is_buggy() {
    let sb = Sandbox::new();
    let other = Sandbox::new();
    let foreign = other.repo("foreign");
    let local = ahead(&sb, "local");
    let h = Harness::new();
    let ctx = h.plain().with_jail(Arc::new(Jail::e2e(sb.root())));
    let opts = RunOpts::default();

    // a foreign repo: every subcommand of the mutating list
    for sub in intely_core::jail::MUTATING_COMMANDS {
        let e = run_git(&ctx, &foreign.path, &[sub], &opts).await.unwrap_err();
        assert_eq!(e.code, TEST_JAIL, "{sub}");
    }
    // a literal https URL as the push destination
    let t = Instant::now();
    let e = run_git(&ctx, &local.path, &["push", "https://github.com/example/never.git", "main"], &opts).await.unwrap_err();
    assert_eq!(e.code, TEST_JAIL);
    assert!(t.elapsed() < Duration::from_secs(5));
    // options that redirect git or bring credentials back
    for bad in [&["-C", "/", "status"][..], &["-c", "credential.helper=osxkeychain", "status"], &["--git-dir=/x", "status"]] {
        assert_eq!(run_git(&ctx, &local.path, bad, &opts).await.unwrap_err().code, TEST_JAIL, "{bad:?}");
    }
    // reads and in-fixture writes still work
    assert!(run_git(&ctx, &local.path, &["status", "--porcelain"], &opts).await.unwrap().success());
    let ro = h.plain().with_jail(Arc::new(Jail::read_only()));
    assert!(run_git(&ro, &local.path, &["status", "--porcelain"], &opts).await.unwrap().success());
    assert_eq!(run_git(&ro, &local.path, &["add", "-A"], &opts).await.unwrap_err().code, READ_ONLY);
    assert_eq!(foreign.status(), "");
}

#[tokio::test]
async fn agent_originated_git_passes_only_the_allow_list_while_the_ides_own_buttons_keep_working() {
    let sb = Sandbox::new();
    let local = ahead(&sb, "agent-origin");
    let h = Harness::new();
    let human = h.plain().with_jail(Arc::new(Jail::e2e(sb.root())));
    let agent = human.for_agent();
    let opts = RunOpts::default();
    // reads and an explicit add pass for the agent (the fixture is inside the jail)
    assert!(run_git(&agent, &local.path, &["status", "--porcelain"], &opts).await.unwrap().success());
    assert!(run_git(&agent, &local.path, &["log", "--oneline", "-1"], &opts).await.unwrap().success());
    // everything else is refused before a process exists, including what the deny-list would have let through
    for bad in [
        &["commit", "--allow-empty", "-m", "x"][..],
        &["push", "origin", "main"],
        &["checkout-index", "-a"],
        &["branch", "created-by-agent"],
        &["config", "user.name", "x"],
        &["stash"],
        &["add", "-A"],
        &["-c", "core.hooksPath=/tmp/x", "status"],
        &["hash-object", "-w", "README.md"],
    ] {
        let e = run_git(&agent, &local.path, bad, &opts).await.unwrap_err();
        assert_eq!(e.code, AGENT_GIT, "{bad:?}: {e:?}");
    }
    assert!(!local.git(&["branch", "--list", "created-by-agent"]).contains("created-by-agent"));
    // the same argv from the human side (the IDE's own commit button) is judged by the jail only
    assert!(run_git(&human, &local.path, &["commit", "--allow-empty", "-m", "by the human"], &opts).await.unwrap().success());
}

#[test]
fn the_hardened_environment_alone_stops_a_push_to_https_without_network_or_prompt() {
    // The jail check is bypassed on purpose: raw git with only the jail's environment and `-c` options.
    let sb = Sandbox::new();
    let fx = ahead(&sb, "bypass");
    let jail = Jail::e2e(sb.root());
    for url in ["https://127.0.0.1:9/never.git", "http://127.0.0.1:9/never.git", "ssh://127.0.0.1:9/never.git", "git://127.0.0.1:9/never.git"] {
        let mut cmd = Command::new(intely_core::exec::pinned_git_path());
        cmd.arg("-C").arg(&fx.path).args(jail.config_args()).args(["push", url, "main"]);
        for k in jail.removed_env() {
            cmd.env_remove(k);
        }
        cmd.envs(jail.env().iter().copied()).stdin(Stdio::null());
        let t = Instant::now();
        let out = cmd.output().unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(!out.status.success(), "{url}");
        assert!(stderr.contains("not allowed") || stderr.contains("disabled"), "{url}: {stderr}");
        assert!(t.elapsed() < Duration::from_secs(5), "{url} took {:?}", t.elapsed());
    }
    // credential helpers are gone: `credential fill` finds nothing and does not prompt
    let mut cmd = Command::new(intely_core::exec::pinned_git_path());
    cmd.args(jail.config_args()).args(["credential", "fill"]).envs(jail.env().iter().copied());
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    use std::io::Write;
    child.stdin.take().unwrap().write_all(b"protocol=https\nhost=github.com\n\n").unwrap();
    let out = child.wait_with_output().unwrap();
    // `GIT_ASKPASS=true` answers every prompt with an empty string: no real secret can come out.
    let stdout = String::from_utf8_lossy(&out.stdout);
    let filled = |key: &str| stdout.lines().any(|l| l.strip_prefix(key).is_some_and(|v| !v.is_empty()));
    assert!(!filled("password=") && !filled("username=") && !filled("oauth_refresh_token="), "no credential may be produced: {stdout}");
}

#[tokio::test]
async fn live_branch_push_needs_the_typed_name_and_hooks() {
    let sb = Sandbox::new();
    let fx = ahead(&sb, "live");
    let (engine, sink) = engine_for(&sb, &[&fx], Jail::e2e(sb.root()), &["main", "release/*"]).await;
    let remote_before = fx.remote_ref("main");

    for confirm in [None, Some(""), Some("mai"), Some("Main"), Some("main ")] {
        let e = engine.push_start(push_req("live", "main", confirm, false)).await.unwrap_err();
        assert_eq!(e.code, LIVE_BRANCH_CONFIRM, "{confirm:?}");
        assert!(e.message.contains("main"), "the message names the branch: {}", e.message);
    }
    // a glob pattern is live too
    assert_eq!(engine.push_start(push_req("live", "release/1.0", None, false)).await.unwrap_err().code, LIVE_BRANCH_CONFIRM);
    // --no-verify never goes to a live branch, even with the right name
    let e = engine.push_start(push_req("live", "main", Some("main"), true)).await.unwrap_err();
    assert_eq!(e.code, LIVE_BRANCH_CONFIRM);
    assert_eq!(fx.remote_ref("main"), remote_before, "nothing was pushed");

    // the exact name is accepted, and the push really lands on the fixture bare remote
    engine.push_start(push_req("live", "main", Some("main"), false)).await.expect("confirmed push is started");
    let result = wait_result(&sink).await;
    assert_eq!(result.repos[0].status, StepStatus::Done, "{result:?}");
    assert_eq!(fx.remote_ref("main"), Some(fx.head()));

    // a branch that is not live needs no confirmation
    fx.write("more.txt", "m\n");
    fx.commit_all("more");
    let req = push_req("live", "feature/x", None, true);
    engine.push_start(PushRequest { run_id: "r2".into(), ..req }).await.expect("non-live push without confirmation");
    engine.shutdown().await;
}

#[tokio::test]
async fn per_repo_live_branches_and_the_remote_head_branch_are_live_too() {
    let sb = Sandbox::new();
    let fx = ahead(&sb, "liveb");
    // `origin/HEAD` -> main, no protected patterns at all: the remote HEAD branch is still live
    fx.git(&["remote", "set-head", "origin", "main"]);
    let (engine, _) = engine_for(&sb, &[&fx], Jail::e2e(sb.root()), &[]).await;
    assert_eq!(engine.push_start(push_req("liveb", "main", None, false)).await.unwrap_err().code, LIVE_BRANCH_CONFIRM);
    engine.shutdown().await;

    // liveBranches of the repo, merged with the protected patterns
    let fx2 = ahead(&sb, "liveb2");
    let mut ws = workspace_of(vec![fx2.cfg.clone()], &[]);
    ws.live_branches.insert("liveb2".into(), vec!["staging*".into()]);
    let file = sb.root().join("workspace2.json");
    workspace::persist(&file, &ws).unwrap();
    private_home();
    let engine = Engine::new_with_jail(file, Arc::new(ResultSink::default()), Arc::new(Jail::e2e(sb.root()))).unwrap();
    assert_eq!(engine.push_start(push_req("liveb2", "staging-eu", None, false)).await.unwrap_err().code, LIVE_BRANCH_CONFIRM);
    // and the push plan marks it, so the dialog knows to ask
    let plan = engine.push_plan(&["liveb2".to_owned()], false).await.unwrap();
    assert!(!plan[0].protected, "main is not live in this workspace");
    engine.shutdown().await;
}

#[tokio::test]
async fn off_mode_changes_nothing_for_non_live_branches() {
    let sb = Sandbox::new();
    let fx = ahead(&sb, "off");
    let (engine, sink) = engine_for(&sb, &[&fx], Jail::off(), &["main"]).await;
    engine.push_start(push_req("off", "feature/y", None, false)).await.unwrap();
    let r = wait_result(&sink).await;
    assert_eq!(r.repos[0].status, StepStatus::Done, "{r:?}");
    engine.shutdown().await;
}
