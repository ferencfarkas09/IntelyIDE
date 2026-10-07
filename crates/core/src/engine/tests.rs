use std::sync::atomic::AtomicUsize;
use std::time::Instant;

use super::*;
use crate::exec::fixture::Fixture;
use crate::repo_actor::blank_snapshot;
use crate::{Change, ChangeKind, EnvStatus, MessageMode, TagsMode, WorkspaceSettings};

#[derive(Default)]
struct Sink {
    events: Mutex<Vec<OpEvent>>,
    results: Mutex<Vec<OpResult>>,
    snapshots: Mutex<Vec<RepoSnapshot>>,
}

impl EventSink for Sink {
    fn snapshot(&self, s: RepoSnapshot) {
        self.snapshots.lock().unwrap().push(s);
    }
    fn op_event(&self, e: OpEvent) {
        self.events.lock().unwrap().push(e);
    }
    fn op_result(&self, r: OpResult) {
        self.results.lock().unwrap().push(r);
    }
    fn env(&self, _: EnvStatus) {}
}

impl Sink {
    async fn result(&self, run_id: &str) -> OpResult {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(r) = self.results.lock().unwrap().iter().find(|r| r.run_id == run_id) {
                return r.clone();
            }
            assert!(Instant::now() < deadline, "no op:result for {run_id}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

type OutcomeFn = Arc<dyn Fn(OpKind, GitCtx, RepoConfig) -> BoxFuture<'static, RepoOutcome> + Send + Sync>;

/// Every operation goes through one closure, which also sees the kind of the call.
struct FakeOps {
    run: OutcomeFn,
    changes: Vec<Change>,
}

impl Ops for FakeOps {
    fn snapshot<'a>(&'a self, _: &'a GitCtx, repo: &'a RepoConfig) -> BoxFuture<'a, Result<RepoSnapshot, EngineError>> {
        Box::pin(async move {
            let mut s = blank_snapshot(&repo.id);
            s.changes = self.changes.clone();
            Ok(s)
        })
    }
    fn commit<'a>(&'a self, ctx: &'a GitCtx, repo: &'a RepoConfig, _: &'a RepoCommit, _: bool) -> BoxFuture<'a, RepoOutcome> {
        (self.run)(OpKind::Commit, ctx.clone(), repo.clone())
    }
    fn push<'a>(&'a self, ctx: &'a GitCtx, repo: &'a RepoConfig, _: &'a PushTarget, _: bool) -> BoxFuture<'a, RepoOutcome> {
        (self.run)(OpKind::Push, ctx.clone(), repo.clone())
    }
    fn pull<'a>(&'a self, ctx: &'a GitCtx, repo: &'a RepoConfig, _: PullMode) -> BoxFuture<'a, RepoOutcome> {
        (self.run)(OpKind::Pull, ctx.clone(), repo.clone())
    }
    fn fetch<'a>(&'a self, ctx: &'a GitCtx, repo: &'a RepoConfig) -> BoxFuture<'a, RepoOutcome> {
        (self.run)(OpKind::Fetch, ctx.clone(), repo.clone())
    }
}

fn done(repo: &RepoConfig) -> RepoOutcome {
    outcome(&repo.id, StepStatus::Done, None)
}

fn fixture_with(n: usize, run: OutcomeFn, changes: Vec<Change>) -> (Engine, Arc<Sink>, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let repos = (0..n)
        .map(|i| RepoConfig {
            id: format!("r{i}"),
            path: tmp.path().join(format!("r{i}")).to_string_lossy().into_owned(),
            name: format!("repo {i}"),
            color: "#4caf7d".into(),
            badge: "XX".into(),
            order: i as u32,
            push_targets: Default::default(),
        })
        .collect();
    let ws = Workspace {
        version: 1,
        repos,
        protected_branches: vec!["main".into()],
        live_branches: Default::default(),
        settings: WorkspaceSettings { message_mode: MessageMode::Shared, untracked_checked: false },
    };
    let file = tmp.path().join("workspace.json");
    workspace::persist(&file, &ws).unwrap();
    let sink = Arc::new(Sink::default());
    let engine = Engine::build(file, sink.clone(), Arc::new(FakeOps { run, changes }), false).unwrap();
    (engine, sink, tmp)
}

fn fixture(n: usize, run: OutcomeFn) -> (Engine, Arc<Sink>, tempfile::TempDir) {
    fixture_with(n, run, Vec::new())
}

fn commit_req(run_id: &str, repos: &[&str]) -> CommitRequest {
    CommitRequest {
        run_id: run_id.into(),
        repos: repos
            .iter()
            .map(|id| RepoCommit {
                repo_id: (*id).into(),
                files: vec![FileSelection::Whole { path: "src/a.ts".into(), orig_path: None }],
                message: "m".into(),
                amend: false,
            })
            .collect(),
        no_verify: false,
    }
}

fn sleeping(delay: Duration) -> OutcomeFn {
    Arc::new(move |_, _, repo| {
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            done(&repo)
        })
    })
}

#[tokio::test]
async fn commit_runs_repos_in_parallel_and_reports_in_request_order() {
    let (engine, sink, _tmp) = fixture(4, sleeping(Duration::from_millis(300)));
    let t = Instant::now();
    let started = engine.commit_start(commit_req("run-1", &["r2", "r0", "r3", "r1"])).await.unwrap();
    assert_eq!(started.run_id, "run-1");
    let result = sink.result("run-1").await;
    assert!(t.elapsed() < Duration::from_millis(900), "took {:?}", t.elapsed());
    assert_eq!(result.kind, OpKind::Commit);
    assert_eq!(result.repos.iter().map(|r| r.repo_id.as_str()).collect::<Vec<_>>(), ["r2", "r0", "r3", "r1"]);
    assert!(result.repos.iter().all(|r| r.status == StepStatus::Done));

    let events = sink.events.lock().unwrap();
    assert_eq!(events.iter().filter(|e| e.status == StepStatus::Queued).count(), 4);
    assert!(events.iter().all(|e| e.run_id == "run-1" && e.kind == OpKind::Commit));
    assert_eq!(events.last().unwrap().status, StepStatus::Done);
}

#[tokio::test]
async fn mutations_inside_one_repo_never_overlap_across_runs() {
    let running = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let (r, p) = (running.clone(), peak.clone());
    let run: OutcomeFn = Arc::new(move |_, _, repo| {
        let (r, p) = (r.clone(), p.clone());
        Box::pin(async move {
            p.fetch_max(r.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(80)).await;
            r.fetch_sub(1, Ordering::SeqCst);
            done(&repo)
        })
    });
    let (engine, sink, _tmp) = fixture(1, run);
    for i in 0..3 {
        engine.commit_start(commit_req(&format!("run-{i}"), &["r0"])).await.unwrap();
    }
    for i in 0..3 {
        sink.result(&format!("run-{i}")).await;
    }
    assert_eq!(peak.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn guarded_files_reject_the_whole_request() {
    let calls = Arc::new(AtomicUsize::new(0));
    let c = calls.clone();
    let run: OutcomeFn = Arc::new(move |_, _, repo| {
        c.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { done(&repo) })
    });
    let (engine, sink, _tmp) = fixture(2, run);
    let mut req = commit_req("run-g", &["r0", "r1"]);
    req.repos[1].files = vec![
        FileSelection::Whole { path: "apps/.env.production".into(), orig_path: None },
        FileSelection::Partial { path: "dump_2026/x.json".into(), hunks: vec![] },
        FileSelection::Whole { path: "newdir/".into(), orig_path: None },
        FileSelection::Whole { path: ".env.example".into(), orig_path: None },
    ];
    let err = engine.commit_start(req).await.unwrap_err();
    assert_eq!(err.code, code::GUARD_BLOCKED);
    let detail = err.detail.unwrap();
    assert_eq!(detail.lines().count(), 3, "{detail}");
    assert!(detail.contains("r1: apps/.env.production"));
    assert_eq!(calls.load(Ordering::SeqCst), 0, "nothing may run when any file is blocked");
    assert!(sink.results.lock().unwrap().is_empty());
    // The run id was never taken.
    engine.commit_start(commit_req("run-g", &["r0"])).await.unwrap();
    sink.result("run-g").await;
}

#[tokio::test]
async fn too_large_files_known_from_the_snapshot_are_blocked() {
    let big = Change {
        path: "big.bin".into(),
        orig_path: None,
        kind: ChangeKind::Untracked,
        index_status: " ".into(),
        worktree_status: "?".into(),
        staged: false,
        partially_staged: false,
        guard: GuardState::TooLarge,
        binary: None,
        size_bytes: Some(9_000_000),
        dir: None,
    };
    let (engine, _sink, _tmp) = fixture_with(1, sleeping(Duration::ZERO), vec![big]);
    engine.snapshot_get("r0").await.unwrap();
    let mut req = commit_req("run-big", &["r0"]);
    req.repos[0].files = vec![FileSelection::Whole { path: "big.bin".into(), orig_path: None }];
    let err = engine.commit_start(req).await.unwrap_err();
    assert_eq!(err.code, code::GUARD_BLOCKED);
    assert!(err.detail.unwrap().contains("file is too large"));
}

#[tokio::test]
async fn request_validation() {
    let (engine, _sink, _tmp) = fixture(1, sleeping(Duration::ZERO));
    assert_eq!(engine.commit_start(commit_req("a", &["nope"])).await.unwrap_err().code, code::REPO_MISSING);
    assert_eq!(engine.commit_start(commit_req("a", &[])).await.unwrap_err().code, code::INVALID_SELECTION);
    assert_eq!(engine.commit_start(commit_req("a", &["r0", "r0"])).await.unwrap_err().code, code::INVALID_SELECTION);
    assert_eq!(engine.commit_start(commit_req("", &["r0"])).await.unwrap_err().code, code::INVALID_SELECTION);
    assert_eq!(engine.snapshot_get("nope").await.unwrap_err().code, code::REPO_MISSING);
    assert_eq!(engine.snapshot_refresh(Some("nope")).await.unwrap_err().code, code::REPO_MISSING);
    for bad in ["../x", "/etc/passwd", "a/../../b"] {
        assert_eq!(engine.list_untracked("r0", bad, 10).await.unwrap_err().code, code::INVALID_SELECTION, "{bad}");
        assert_eq!(
            engine.file_hunks("r0", bad, DiffSource::WorktreeVsHead).await.unwrap_err().code,
            code::INVALID_SELECTION
        );
    }
    assert_eq!(engine.push_commit_files("r0", "--output=x").await.unwrap_err().code, code::INVALID_SELECTION);
    let bad_oid = DiffSource::Commit { oid: "zz".into() };
    assert_eq!(engine.file_contents("r0", "a", None, bad_oid, false).await.unwrap_err().code, code::INVALID_SELECTION);

    let push = |remote: &str, branch: &str| PushRequest {
        run_id: "p".into(),
        targets: vec![PushTarget {
            repo_id: "r0".into(),
            remote: remote.into(),
            remote_branch: branch.into(),
            tags: TagsMode::None,
            force_with_lease: None,
            confirm_live: None,
        }],
        no_verify: false,
    };
    assert_eq!(engine.push_start(push("--upload-pack=x", "main")).await.unwrap_err().code, code::INVALID_SELECTION);
    assert_eq!(engine.push_start(push("origin", "a b")).await.unwrap_err().code, code::INVALID_SELECTION);
    assert_eq!(engine.set_push_target("r0", "main", "origin", "-x").await.unwrap_err().code, code::INVALID_SELECTION);
    assert_eq!(engine.set_push_target("nope", "main", "origin", "x").await.unwrap_err().code, code::REPO_MISSING);
}

#[tokio::test]
async fn cancel_reaches_running_and_queued_jobs_and_unknown_ids_are_fine() {
    let started = Arc::new(Mutex::new(Vec::<String>::new()));
    let s = started.clone();
    let run: OutcomeFn = Arc::new(move |_, ctx, repo| {
        let s = s.clone();
        Box::pin(async move {
            let run = ctx.run.expect("runs carry their id");
            s.lock().unwrap().push(run.run_id.clone());
            while !run.cancel.is_cancelled() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            outcome(&repo.id, StepStatus::Cancelled, None)
        })
    });
    let (engine, sink, _tmp) = fixture(1, run);
    engine.commit_start(commit_req("first", &["r0"])).await.unwrap();
    engine.commit_start(commit_req("second", &["r0"])).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    engine.commit_cancel("second").await.unwrap();
    engine.commit_cancel("no-such-run").await.unwrap();
    engine.commit_cancel("first").await.unwrap();
    let (first, second) = (sink.result("first").await, sink.result("second").await);
    assert_eq!(first.repos[0].status, StepStatus::Cancelled);
    assert_eq!(second.repos[0].status, StepStatus::Cancelled);
    assert_eq!(*started.lock().unwrap(), vec!["first"], "the queued run was cancelled before it started");
    assert!(engine.cur().runs.lock().unwrap().is_empty(), "finished runs leave the registry");
}

#[tokio::test]
async fn a_panicking_operation_still_produces_a_result() {
    let run: OutcomeFn = Arc::new(|_, _, repo| {
        Box::pin(async move {
            if repo.id == "r1" {
                todo!("not implemented yet");
            }
            done(&repo)
        })
    });
    let (engine, sink, _tmp) = fixture(2, run);
    engine.commit_start(commit_req("boom", &["r0", "r1"])).await.unwrap();
    let result = sink.result("boom").await;
    assert_eq!(result.repos[0].status, StepStatus::Done);
    assert_eq!(result.repos[1].status, StepStatus::Failed);
    assert_eq!(result.repos[1].failure.as_ref().unwrap().kind, FailureKind::Unknown);
    // The repo is usable afterwards: the write lane was released by the unwinding task.
    let fetch = engine.fetch("r1").await.unwrap();
    sink.result(&fetch.run_id).await;
    engine.commit_start(commit_req("after", &["r1"])).await.unwrap();
    sink.result("after").await;
}

#[tokio::test]
async fn pull_and_fetch_get_their_own_run_ids_and_kinds() {
    let (engine, sink, _tmp) = fixture(1, sleeping(Duration::from_millis(10)));
    let pull = engine.pull("r0", PullMode::FfOnly).await.unwrap();
    let fetch = engine.fetch("r0").await.unwrap();
    assert_ne!(pull.run_id, fetch.run_id);
    assert_eq!(sink.result(&pull.run_id).await.kind, OpKind::Pull);
    assert_eq!(sink.result(&fetch.run_id).await.kind, OpKind::Fetch);
}

#[tokio::test]
async fn shutdown_kills_child_process_groups_and_waits_for_the_runs() {
    let pids = Arc::new(Mutex::new(Vec::<i32>::new()));
    let p = pids.clone();
    // Behaves like exec: own process group, killed as a group once the run's token fires.
    let run: OutcomeFn = Arc::new(move |_, ctx, repo| {
        let p = p.clone();
        Box::pin(async move {
            let cancel = ctx.run.unwrap().cancel;
            let mut child = tokio::process::Command::new("sleep").arg("60").process_group(0).spawn().unwrap();
            let id = child.id().unwrap() as i32;
            p.lock().unwrap().push(id);
            while !cancel.is_cancelled() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            unsafe { libc::killpg(id, libc::SIGKILL) };
            child.wait().await.unwrap();
            outcome(&repo.id, StepStatus::Cancelled, None)
        })
    });
    let (engine, sink, _tmp) = fixture(2, run);
    engine.commit_start(commit_req("long", &["r0", "r1"])).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let ids = pids.lock().unwrap().clone();
    assert_eq!(ids.len(), 2, "both repos spawned a child");
    assert!(ids.iter().all(|&id| unsafe { libc::kill(id, 0) } == 0), "the children run before shutdown");

    engine.shutdown().await;
    assert!(sink.results.lock().unwrap().iter().any(|r| r.run_id == "long"), "shutdown waits for the result");
    assert!(ids.iter().all(|&id| unsafe { libc::kill(id, 0) } == -1), "no child survives shutdown");
    assert_eq!(engine.commit_start(commit_req("late", &["r0"])).await.unwrap_err().code, code::CANCELLED);
    assert!(engine.cur().ctx.run.as_ref().unwrap().cancel.is_cancelled(), "status reads are cancelled too");
}

#[tokio::test]
async fn workspace_edits_start_and_stop_actors_and_persist_push_targets() {
    let (engine, sink, tmp) = fixture(2, sleeping(Duration::ZERO));
    assert_eq!(engine.engine_status().await.unwrap().repo_ids, ["r0", "r1"]);

    let updated = engine.set_push_target("r1", "feature/x", "origin", "other").await.unwrap();
    assert_eq!(
        updated.repos[1].push_targets["feature/x"],
        PushTargetMapping { remote: "origin".into(), branch: "other".into() }
    );
    assert_eq!(engine.cur().actor("r1").unwrap().config().push_targets.len(), 1);
    let on_disk = std::fs::read_to_string(tmp.path().join("workspace.json")).unwrap();
    assert!(on_disk.contains("\"pushTargets\"") && on_disk.contains("\"other\""), "{on_disk}");

    // Replace r0 by a new repo; saving validates the paths as work trees.
    let fresh = tmp.path().join("fresh");
    std::fs::create_dir_all(fresh.join(".git")).unwrap();
    std::fs::write(fresh.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    let mut ws = engine.workspace_get().await.unwrap();
    ws.repos[0].id = "fresh".into();
    ws.repos[0].path = fresh.to_string_lossy().into_owned();
    assert_eq!(engine.workspace_save(ws.clone()).await.unwrap_err().code, code::REPO_MISSING, "r1 has no work tree");
    ws.repos.truncate(1);
    engine.workspace_save(ws).await.unwrap();
    assert_eq!(engine.engine_status().await.unwrap().repo_ids, ["fresh"]);
    assert_eq!(engine.snapshot_get("r1").await.unwrap_err().code, code::REPO_MISSING);
    assert_eq!(engine.snapshot_get("fresh").await.unwrap().revision, 1);
    assert!(sink.snapshots.lock().unwrap().iter().any(|s| s.repo_id == "fresh"));
}

#[tokio::test]
async fn snapshot_refresh_emits_only_changes() {
    let (engine, sink, _tmp) = fixture(2, sleeping(Duration::ZERO));
    engine.snapshot_refresh(None).await.unwrap();
    engine.snapshot_refresh(None).await.unwrap();
    for id in ["r0", "r1"] {
        engine.cur().actor(id).unwrap().refresh_wait().await;
    }
    assert_eq!(sink.snapshots.lock().unwrap().len(), 2, "one first snapshot per repo, then no change");
}

#[test]
fn ref_name_validation() {
    for ok in ["main", "feature/x", "release/1.2", "origin", "SHOP-260", "árvíz"] {
        assert!(valid_ref_part(ok), "{ok}");
    }
    for bad in ["", "-x", "--force", "/a", "a/", "a..b", "a b", "a:b", "a~1", "a^", "a?", "a*", "a[", "x.lock", "a.", "a\\b", "a\nb"] {
        assert!(!valid_ref_part(bad), "{bad:?}");
    }
}

/// Real `status` and `exec` (no commit/push/pull yet): commit runs a git alias that sleeps.
/// `mark` makes the sleep duration unique per test so parallel tests can tell their processes apart.
struct SlowGitOps {
    mark: &'static str,
}

impl Ops for SlowGitOps {
    fn snapshot<'a>(&'a self, ctx: &'a GitCtx, repo: &'a RepoConfig) -> BoxFuture<'a, Result<RepoSnapshot, EngineError>> {
        GitOps.snapshot(ctx, repo)
    }
    fn commit<'a>(&'a self, ctx: &'a GitCtx, repo: &'a RepoConfig, _: &'a RepoCommit, _: bool) -> BoxFuture<'a, RepoOutcome> {
        Box::pin(async move {
            let alias = format!("alias.slow=!sleep {}", self.mark);
            let args = ["-c", alias.as_str(), "slow"];
            let _ = run_git(ctx, Path::new(&repo.path), &args, &RunOpts::default()).await;
            let status = if ctx.is_cancelled() { StepStatus::Cancelled } else { StepStatus::Done };
            outcome(&repo.id, status, None)
        })
    }
    fn push<'a>(&'a self, _: &'a GitCtx, _: &'a RepoConfig, _: &'a PushTarget, _: bool) -> BoxFuture<'a, RepoOutcome> {
        unimplemented!()
    }
    fn pull<'a>(&'a self, _: &'a GitCtx, _: &'a RepoConfig, _: PullMode) -> BoxFuture<'a, RepoOutcome> {
        unimplemented!()
    }
    fn fetch<'a>(&'a self, _: &'a GitCtx, _: &'a RepoConfig) -> BoxFuture<'a, RepoOutcome> {
        unimplemented!()
    }
}

fn real_engine(fixtures: &[&Fixture], ops: Arc<dyn Ops>) -> (Engine, Arc<Sink>, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let repos = fixtures
        .iter()
        .enumerate()
        .map(|(i, f)| RepoConfig { id: format!("r{i}"), name: format!("repo {i}"), order: i as u32, ..crate::exec::fixture::repo_config(&f.root) })
        .collect();
    let ws = Workspace {
        version: 1,
        repos,
        protected_branches: vec!["main".into()],
        live_branches: Default::default(),
        settings: WorkspaceSettings { message_mode: MessageMode::Shared, untracked_checked: false },
    };
    let file = tmp.path().join("workspace.json");
    workspace::persist(&file, &ws).unwrap();
    let sink = Arc::new(Sink::default());
    (Engine::build(file, sink.clone(), ops, true).unwrap(), sink, tmp)
}

fn snapshots_of(sink: &Sink, repo_id: &str) -> Vec<RepoSnapshot> {
    sink.snapshots.lock().unwrap().iter().filter(|s| s.repo_id == repo_id).cloned().collect()
}

async fn wait_for_snapshot(sink: &Sink, repo_id: &str, what: &str, pred: impl Fn(&RepoSnapshot) -> bool) -> RepoSnapshot {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if let Some(s) = snapshots_of(sink, repo_id).into_iter().rev().find(|s| pred(s)) {
            return s;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn watcher_driven_snapshots_on_a_real_repo() {
    let fx = Fixture::new();
    fx.write("tracked.txt", "one\n");
    fx.commit_all("add tracked");
    let (engine, sink, _tmp) = real_engine(&[&fx], Arc::new(GitOps));

    let first = engine.snapshot_get("r0").await.unwrap();
    assert_eq!((first.revision, first.head.branch.as_deref(), first.changes.len()), (1, Some("main"), 0));
    tokio::time::sleep(Duration::from_millis(900)).await; // FSEvents replays the fixture setup; it changes nothing

    fx.write("tracked.txt", "two\n");
    let changed = wait_for_snapshot(&sink, "r0", "the modified file", |s| s.changes.iter().any(|c| c.path == "tracked.txt")).await;
    assert_eq!(changed.revision, 2);

    // A storm of new files is a handful of refreshes, not one per file.
    let before = snapshots_of(&sink, "r0").len();
    for i in 0..2000 {
        fx.write(&format!("gen/f{i}.ts"), "x");
    }
    fx.write("apps/.env.production", "SECRET=1");
    wait_for_snapshot(&sink, "r0", "the untracked dirs", |s| s.changes.iter().any(|c| c.path == "gen/")).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let storm = snapshots_of(&sink, "r0");
    assert!(storm.len() - before <= 5, "{} snapshots for 2001 files", storm.len() - before);
    assert!(storm.windows(2).all(|w| w[1].revision == w[0].revision + 1), "revisions are gapless and monotonic");

    // node_modules is not watched, but status stays authoritative once a refresh is requested.
    let seen = snapshots_of(&sink, "r0").len();
    fx.write("node_modules/pkg/index.js", "x");
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(snapshots_of(&sink, "r0").len(), seen, "node_modules events must not refresh");
    engine.snapshot_refresh(None).await.unwrap();
    wait_for_snapshot(&sink, "r0", "node_modules after an explicit refresh", |s| s.changes.iter().any(|c| c.path == "node_modules/")).await;

    engine.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_long_git_process_in_one_repo_does_not_delay_status_of_another() {
    let (a, b) = (Fixture::new(), Fixture::new());
    let (engine, sink, _tmp) = real_engine(&[&a, &b], Arc::new(SlowGitOps { mark: "31.77" }));
    engine.snapshot_get("r0").await.unwrap();
    engine.snapshot_get("r1").await.unwrap();

    engine.commit_start(commit_req("slow", &["r0"])).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    b.write("new.txt", "x");
    let t = Instant::now();
    engine.snapshot_refresh(Some("r1")).await.unwrap();
    wait_for_snapshot(&sink, "r1", "status of the other repo", |s| s.changes.iter().any(|c| c.path == "new.txt")).await;
    assert!(t.elapsed() < Duration::from_secs(2), "status took {:?} while a commit was running", t.elapsed());

    engine.commit_cancel("slow").await.unwrap();
    let result = sink.result("slow").await;
    assert_eq!(result.repos[0].status, StepStatus::Cancelled);
    assert!(!sleeper_running("31.77"), "cancel left the git alias process behind");
    engine.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_leaves_no_git_process_behind() {
    let fx = Fixture::new();
    let (engine, sink, _tmp) = real_engine(&[&fx], Arc::new(SlowGitOps { mark: "31.78" }));
    engine.commit_start(commit_req("slow", &["r0"])).await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !sleeper_running("31.78") {
        assert!(Instant::now() < deadline, "the slow git process never started");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    engine.shutdown().await;
    assert!(!sleeper_running("31.78"), "a child of the run survived shutdown");
    assert_eq!(sink.result("slow").await.repos[0].status, StepStatus::Cancelled);
}

fn sleeper_running(mark: &str) -> bool {
    std::process::Command::new("pgrep").args(["-f", &format!("sleep {mark}")]).output().unwrap().status.success()
}

// ---- generations ((design notes: workspaces-spec) 4.8) ------------------------------------------------------------------------

#[derive(Default)]
struct CountingSink {
    snapshots: AtomicUsize,
    op_events: AtomicUsize,
    results: AtomicUsize,
    envs: AtomicUsize,
}

impl EventSink for CountingSink {
    fn snapshot(&self, _: RepoSnapshot) {
        self.snapshots.fetch_add(1, Ordering::SeqCst);
    }
    fn op_event(&self, _: OpEvent) {
        self.op_events.fetch_add(1, Ordering::SeqCst);
    }
    fn op_result(&self, _: OpResult) {
        self.results.fetch_add(1, Ordering::SeqCst);
    }
    fn env(&self, _: EnvStatus) {
        self.envs.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn a_late_event_of_a_retired_generation_is_dropped_and_the_env_event_passes() {
    let real = Arc::new(CountingSink::default());
    let live = Arc::new(AtomicU64::new(1));
    let old = GenSink { epoch: 1, live: live.clone(), real: real.clone() };
    let status = || crate::EnvStatus {
        state: crate::EnvState::Ready,
        git_path: "git".into(),
        node_path: None,
        source: crate::EnvSource::Fallback,
        message: None,
    };
    let event = || OpEvent { run_id: "r".into(), repo_id: "x".into(), kind: OpKind::Fetch, status: StepStatus::Queued, line: None, percent: None };
    let result = || OpResult { run_id: "r".into(), kind: OpKind::Fetch, repos: vec![], finished_at_ms: 0 };

    old.snapshot(blank_snapshot("x"));
    old.op_event(event());
    old.op_result(result());
    assert_eq!((real.snapshots.load(Ordering::SeqCst), real.op_events.load(Ordering::SeqCst), real.results.load(Ordering::SeqCst)), (1, 1, 1), "the live generation is heard");

    live.store(2, Ordering::SeqCst); // a switch happened
    old.snapshot(blank_snapshot("x"));
    old.op_event(event());
    old.op_result(result());
    old.env(status());
    assert_eq!((real.snapshots.load(Ordering::SeqCst), real.op_events.load(Ordering::SeqCst), real.results.load(Ordering::SeqCst)), (1, 1, 1), "a retired generation is silent");
    assert_eq!(real.envs.load(Ordering::SeqCst), 1, "the login environment belongs to the engine");
    let new = GenSink { epoch: 2, live, real: real.clone() };
    new.snapshot(blank_snapshot("x"));
    assert_eq!(real.snapshots.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_the_engine_stops_its_actors_and_watchers() {
    let f = Fixture::new();
    let (engine, sink, _tmp) = real_engine(&[&f], Arc::new(GitOps));
    wait_for_snapshot(&sink, "r0", "first snapshot", |_| true).await;
    let inner = engine.cur();
    drop(engine);
    // the actor loop and its file watcher belong to the generation: with the last reference gone they stop
    drop(inner);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let seen = snapshots_of(&sink, "r0").len();
    std::fs::write(f.root.join("after-drop.txt"), "x").unwrap();
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(snapshots_of(&sink, "r0").len(), seen, "nothing watches the repo after the generation is gone");
}

#[tokio::test]
async fn a_retired_generation_refuses_runs_and_edits_with_workspace_switching() {
    let (engine, _sink, _tmp) = fixture(1, Arc::new(|_, _, repo| Box::pin(async move { done(&repo) })));
    let old = engine.cur();
    let target = engine.workspace_path().unwrap();
    engine.switch_workspace(Some(target), None).await.unwrap();
    // a task that still holds the old generation (it was inside a command when the switch happened)
    let err = old.begin_run("late".into(), OpKind::Fetch).err().unwrap();
    assert_eq!(err.code, code::WORKSPACE_SWITCHING);
    assert_eq!(old.check_editable().unwrap_err().code, code::WORKSPACE_SWITCHING);
    assert_eq!(old.take_guard("x").err().unwrap().code, code::WORKSPACE_SWITCHING);
    assert!(engine.cur().begin_run("fresh".into(), OpKind::Fetch).is_ok(), "the new generation takes runs");
}
