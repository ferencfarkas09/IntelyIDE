//! Engine generations and `switch_workspace` ((design notes: workspaces-spec) 4.8, 9.1): A -> B -> detached -> A, busy
//! refusals, the gate during a switch, late events of a retired generation, protection from another workspace.

mod common;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

use common::*;
use intely_core::jail::{Jail, LIVE_BRANCH_CONFIRM};
use intely_core::{
    code, workspace, CommitRequest, Engine, EnvStatus, EventSink, FileSelection, OpEvent, OpResult, Protection, ProtectionSource, PushRequest,
    PushTarget, RepoCommit, RepoSnapshot, TagsMode,
};

/// The login-shell cache of the engine must not land in the real home.
fn private_home() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let dir = tempfile::Builder::new().prefix("intely-switch-home-").tempdir().unwrap().keep();
        std::env::set_var("HOME", dir);
    });
}

#[derive(Default)]
struct Rec {
    snapshots: Mutex<Vec<RepoSnapshot>>,
    results: Mutex<Vec<OpResult>>,
    events: Mutex<Vec<OpEvent>>,
}

impl EventSink for Rec {
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

impl Rec {
    fn count(&self, repo: &str) -> usize {
        self.snapshots.lock().unwrap().iter().filter(|s| s.repo_id == repo).count()
    }
    fn files_of(&self, repo: &str) -> Vec<String> {
        self.snapshots.lock().unwrap().iter().rev().find(|s| s.repo_id == repo).map(|s| s.changes.iter().map(|c| c.path.clone()).collect()).unwrap_or_default()
    }
}

async fn until(what: &str, mut cond: impl FnMut() -> bool) {
    let t = Instant::now();
    while !cond() {
        assert!(t.elapsed() < Duration::from_secs(20), "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// A workspace file with these repos, in the sandbox.
fn ws_file(sb: &Sandbox, name: &str, repos: &[&Fixture], protected: &[&str]) -> PathBuf {
    let ws = workspace_of(repos.iter().enumerate().map(|(i, f)| intely_core::RepoConfig { order: i as u32, ..f.cfg.clone() }).collect(), protected);
    let file = sb.root().join(format!("{name}.json"));
    workspace::persist(&file, &ws).unwrap();
    file
}

struct NoProtection;
impl ProtectionSource for NoProtection {
    fn protection(&self, _: &Path) -> Protection {
        Protection { protected: vec![], live: vec![] }
    }
}

fn engine_for(path: Option<PathBuf>, backup: Option<PathBuf>, sink: Arc<Rec>, jail: Jail, protection: Arc<dyn ProtectionSource>) -> Arc<Engine> {
    private_home();
    Arc::new(Engine::new_for(path, backup, sink, Arc::new(jail), protection).unwrap())
}

fn commit_req(id: &str, run: &str) -> CommitRequest {
    CommitRequest {
        run_id: run.into(),
        repos: vec![RepoCommit { repo_id: id.into(), message: "x".into(), amend: false, files: vec![FileSelection::Whole { path: "new.txt".into(), orig_path: None }] }],
        no_verify: false,
    }
}

fn push_req(id: &str, branch: &str, confirm: Option<&str>) -> PushRequest {
    PushRequest {
        run_id: "p".into(),
        targets: vec![PushTarget { repo_id: id.into(), remote: "origin".into(), remote_branch: branch.into(), tags: TagsMode::None, force_with_lease: None, confirm_live: confirm.map(str::to_owned) }],
        no_verify: false,
    }
}

fn ahead(sb: &Sandbox, name: &str) -> Fixture {
    let fx = sb.repo_with_remote(name);
    fx.write("new.txt", "n\n");
    fx
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_then_b_then_detached_then_a() {
    let sb = Sandbox::new();
    let (a, b1, b2) = (sb.repo("a"), sb.repo("b1"), sb.repo("b2"));
    let (fa, fb) = (ws_file(&sb, "wsa", &[&a], &[]), ws_file(&sb, "wsb", &[&b1, &b2], &[]));
    let rec = Arc::new(Rec::default());
    let engine = engine_for(Some(fa.clone()), None, rec.clone(), Jail::off(), Arc::new(NoProtection));
    assert_eq!(engine.epoch(), 1);
    assert!(!engine.is_detached());
    assert_eq!(engine.snapshot_get("a").await.unwrap().repo_id, "a");
    let ctx_before = engine.git_ctx();

    // A -> B
    assert_eq!(engine.switch_workspace(Some(fb.clone()), None).await.unwrap(), 2);
    assert_eq!(engine.epoch(), 2);
    assert_eq!(engine.workspace_path(), Some(fb.clone()));
    let ids: Vec<_> = engine.workspace_get().await.unwrap().repos.into_iter().map(|r| r.id).collect();
    assert_eq!(ids, vec!["b1", "b2"]);
    assert_eq!(engine.snapshot_get("a").await.unwrap_err().code, code::REPO_MISSING, "A's repos are gone");
    assert!(engine.snapshot_get("b1").await.is_ok() && engine.snapshot_get("b2").await.is_ok());
    assert_eq!(engine.engine_status().await.unwrap().repo_ids.len(), 2);

    // the old generation's watchers are dead: changes in A produce no event at all
    until("A's events to settle", || true).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let seen = rec.count("a");
    a.write("late.txt", "x");
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(rec.count("a"), seen, "a retired generation stays silent");
    // while B's watcher works
    let seen_b = rec.count("b1");
    b1.write("fresh.txt", "x");
    until("B's watcher", || rec.count("b1") > seen_b && rec.files_of("b1").contains(&"fresh.txt".to_owned())).await;

    // B -> detached
    assert_eq!(engine.switch_workspace(None, None).await.unwrap(), 3);
    assert!(engine.is_detached() && engine.workspace_path().is_none());
    assert!(engine.workspace_get().await.unwrap().repos.is_empty());
    assert!(engine.engine_status().await.unwrap().repo_ids.is_empty());
    let ws = workspace::empty();
    assert_eq!(engine.workspace_save(ws).await.unwrap_err().code, code::NO_WORKSPACE);
    assert_eq!(engine.set_push_target("b1", "x", "origin", "x").await.unwrap_err().code, code::NO_WORKSPACE);
    assert!(engine.commit_start(commit_req("b1", "c")).await.is_err());
    assert_eq!(engine.snapshot_get("b1").await.unwrap_err().code, code::REPO_MISSING);
    engine.doctor().await.expect("doctor works without a workspace");

    // detached -> A
    assert_eq!(engine.switch_workspace(Some(fa.clone()), None).await.unwrap(), 4);
    assert_eq!(engine.snapshot_get("a").await.unwrap().repo_id, "a");
    let seen = rec.count("a");
    a.write("again.txt", "x");
    until("A's watcher after returning", || rec.count("a") > seen).await;

    // the login environment and the process gate belong to the engine, not to a workspace
    let ctx_after = engine.git_ctx();
    assert!(Arc::ptr_eq(&ctx_before.env, &ctx_after.env), "EnvResolver is shared across generations");
    assert!(Arc::ptr_eq(ctx_before.gate.as_ref().unwrap(), ctx_after.gate.as_ref().unwrap()), "ProcessGate is shared across generations");
    engine.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_corrupt_or_missing_target_changes_nothing() {
    let sb = Sandbox::new();
    let (a, b) = (sb.repo("a"), sb.repo("b"));
    let (fa, fb) = (ws_file(&sb, "wsa", &[&a], &[]), ws_file(&sb, "wsb", &[&b], &[]));
    let engine = engine_for(Some(fa.clone()), None, Arc::new(Rec::default()), Jail::off(), Arc::new(NoProtection));
    std::fs::write(&fb, "{ broken").unwrap();
    assert_eq!(engine.switch_workspace(Some(fb.clone()), None).await.unwrap_err().code, workspace::INVALID_WORKSPACE);
    assert_eq!(engine.switch_workspace(Some(sb.root().join("nowhere.json")), None).await.unwrap_err().code, code::WORKSPACE_FILE_MISSING);
    assert_eq!(engine.epoch(), 1);
    assert_eq!(engine.workspace_path(), Some(fa));
    assert!(engine.snapshot_get("a").await.is_ok(), "the open workspace was not touched");
    assert!(engine.begin_switch().is_ok(), "a failed switch released its ticket");
    engine.shutdown().await;
}

fn spawn_sleeper() -> (std::process::Child, i32) {
    let child = Command::new("sleep").arg("60").stdin(Stdio::null()).spawn().unwrap();
    let pid = child.id() as i32;
    (child, pid)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_held_guard_blocks_the_switch_and_leaves_its_process_alone() {
    let sb = Sandbox::new();
    let (a, b) = (sb.repo("a"), sb.repo("b"));
    let (fa, fb) = (ws_file(&sb, "wsa", &[&a], &[]), ws_file(&sb, "wsb", &[&b], &[]));
    let engine = engine_for(Some(fa.clone()), None, Arc::new(Rec::default()), Jail::off(), Arc::new(NoProtection));
    let (mut guarded_process, pid) = spawn_sleeper();
    let guard = engine.mutation_guard("rebase").unwrap();
    assert_eq!(engine.busy().guards, vec!["rebase"]);
    let e = engine.switch_workspace(Some(fb.clone()), None).await.unwrap_err();
    assert_eq!(e.code, code::WORKSPACE_BUSY, "{e:?}");
    assert!(e.detail.unwrap_or_default().contains("rebase"));
    assert!(pid_alive(pid), "the guarded operation's process is untouched");
    assert_eq!(engine.epoch(), 1);
    assert!(engine.snapshot_get("a").await.is_ok());
    // a second guard still works: the refused switch did not leave the engine in switching mode
    let second = engine.mutation_guard("stash").unwrap();
    assert_eq!(engine.busy().guards.len(), 2);
    drop(second);
    drop(guard);
    assert!(engine.busy().is_empty());
    assert_eq!(engine.switch_workspace(Some(fb), None).await.unwrap(), 2);
    guarded_process.kill().unwrap();
    let _ = guarded_process.wait();
    // a guard of the retired generation does not exist any more; a fresh one belongs to the new generation
    assert!(engine.mutation_guard("branch").is_ok());
    engine.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_running_commit_blocks_the_switch_until_it_is_cancelled() {
    let sb = Sandbox::new();
    let a = ahead(&sb, "a");
    let b = sb.repo("b");
    let pidfile = sb.root().join("hook.pid");
    a.hook("pre-commit", &format!("echo $$ > '{}'\nsleep 60", pidfile.display()));
    let (fa, fb) = (ws_file(&sb, "wsa", &[&a], &[]), ws_file(&sb, "wsb", &[&b], &[]));
    let rec = Arc::new(Rec::default());
    let engine = engine_for(Some(fa), None, rec.clone(), Jail::off(), Arc::new(NoProtection));
    engine.commit_start(commit_req("a", "run-1")).await.unwrap();
    until("the hook to start", || read_pid(&pidfile).is_some()).await;
    let hook_pid = read_pid(&pidfile).unwrap();
    assert_eq!(engine.busy().runs.len(), 1);
    assert_eq!(engine.busy().runs[0].0, "run-1");

    let e = engine.switch_workspace(Some(fb.clone()), None).await.unwrap_err();
    assert_eq!(e.code, code::WORKSPACE_BUSY);
    assert!(pid_alive(hook_pid), "the switch never kills git work");
    assert_eq!(engine.epoch(), 1);

    engine.commit_cancel("run-1").await.unwrap();
    until("the cancelled run to finish", || !rec.results.lock().unwrap().is_empty()).await;
    until("the run to leave the registry", || engine.busy().is_empty()).await;
    assert_eq!(engine.switch_workspace(Some(fb), None).await.unwrap(), 2);
    engine.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nothing_can_start_or_be_saved_while_a_switch_is_under_way() {
    let sb = Sandbox::new();
    let a = ahead(&sb, "a");
    let marker = sb.root().join("hook-ran");
    a.hook("pre-commit", &format!("touch '{}'", marker.display()));
    let fa = ws_file(&sb, "wsa", &[&a], &[]);
    let rec = Arc::new(Rec::default());
    let engine = engine_for(Some(fa), Some(sb.root().join("backups")), rec.clone(), Jail::off(), Arc::new(NoProtection));
    let ws = engine.workspace_get().await.unwrap();
    let ticket = engine.begin_switch().unwrap();
    for err in [
        engine.commit_start(commit_req("a", "c1")).await.unwrap_err(),
        engine.push_start(push_req("a", "feature", None)).await.unwrap_err(),
        engine.pull("a", intely_core::PullMode::FfOnly).await.unwrap_err(),
        engine.fetch("a").await.unwrap_err(),
        engine.mutation_guard("rebase").err().unwrap(),
        engine.workspace_save(ws.clone()).await.unwrap_err(),
        engine.set_push_target("a", "x", "origin", "y").await.unwrap_err(),
        engine.begin_switch().err().unwrap(),
        engine.switch_workspace(None, None).await.unwrap_err(),
    ] {
        assert_eq!(err.code, code::WORKSPACE_SWITCHING, "{err:?}");
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!marker.exists(), "nothing was spawned");
    assert!(rec.events.lock().unwrap().is_empty() && rec.results.lock().unwrap().is_empty());
    assert!(engine.busy().is_empty());
    drop(ticket);
    // after the switch flag is gone everything works again
    engine.commit_start(commit_req("a", "c2")).await.unwrap();
    until("the commit", || !rec.results.lock().unwrap().is_empty()).await;
    assert!(marker.exists());
    assert!(engine.workspace_save(ws).await.is_ok());
    engine.shutdown().await;
}

struct Blocking {
    reached: Mutex<mpsc::Sender<()>>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl ProtectionSource for Blocking {
    fn protection(&self, _: &Path) -> Protection {
        let _ = self.reached.lock().unwrap().send(());
        let _ = self.release.lock().unwrap().recv_timeout(Duration::from_secs(20));
        Protection { protected: vec![], live: vec![] }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_swap_between_the_two_reads_of_push_start_completes_on_one_generation_or_fails() {
    let sb = Sandbox::new();
    let a = ahead(&sb, "a");
    let b = sb.repo("b");
    let (fa, fb) = (ws_file(&sb, "wsa", &[&a], &[]), ws_file(&sb, "wsb", &[&b], &[]));
    let (reached_tx, reached_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let source = Arc::new(Blocking { reached: Mutex::new(reached_tx), release: Mutex::new(release_rx) });
    let rec = Arc::new(Rec::default());
    let engine = engine_for(Some(fa), None, rec.clone(), Jail::e2e(sb.root()), source);
    let remote_before = a.remote_ref("feature");
    let pusher = {
        let engine = engine.clone();
        tokio::spawn(async move { engine.push_start(push_req("a", "feature", None)).await })
    };
    // push_start has read A's workspace and A's actor and is now asking for the protection of A's repo
    tokio::task::spawn_blocking(move || reached_rx.recv_timeout(Duration::from_secs(20)).expect("push_start reached the protection source")).await.unwrap();
    assert_eq!(engine.switch_workspace(Some(fb), None).await.unwrap(), 2, "no run exists yet, so the switch goes through");
    release_tx.send(()).unwrap();
    let err = pusher.await.unwrap().unwrap_err();
    assert_eq!(err.code, code::WORKSPACE_SWITCHING, "{err:?}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(a.remote_ref("feature"), remote_before, "nothing was pushed");
    assert!(rec.results.lock().unwrap().is_empty());
    assert!(engine.busy().is_empty());
    engine.shutdown().await;
}

struct FixedLive(&'static str);
impl ProtectionSource for FixedLive {
    fn protection(&self, _: &Path) -> Protection {
        Protection { protected: vec![], live: vec![self.0.to_owned()] }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn protection_from_another_workspace_makes_a_branch_live_here() {
    let sb = Sandbox::new();
    let a = ahead(&sb, "a");
    let fa = ws_file(&sb, "wsa", &[&a], &[]); // no protected patterns, no live marks in this workspace
    let rec = Arc::new(Rec::default());
    let engine = engine_for(Some(fa.clone()), None, rec.clone(), Jail::e2e(sb.root()), Arc::new(FixedLive("feature")));
    let err = engine.push_start(push_req("a", "feature", None)).await.unwrap_err();
    assert_eq!(err.code, LIVE_BRANCH_CONFIRM, "{err:?}");
    let plan = engine.push_plan(&["a".to_owned()], false).await.unwrap();
    assert!(plan[0].protected || plan[0].blocked_reason.is_none(), "the plan is computed with the same patterns: {:?}", plan[0]);
    // a branch the source does not mention is an ordinary push (the control)
    let ok = engine.push_start(push_req("a", "other", None)).await;
    assert!(ok.is_ok(), "{ok:?}");
    until("the push", || !rec.results.lock().unwrap().is_empty()).await;
    engine.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn structural_saves_keep_backups_of_registry_workspace_files() {
    let sb = Sandbox::new();
    let a = sb.repo("a");
    let fa = ws_file(&sb, "w-test", &[&a], &[]);
    let backups = sb.root().join("backups");
    let engine = engine_for(Some(fa), Some(backups.clone()), Arc::new(Rec::default()), Jail::off(), Arc::new(NoProtection));
    let mut ws = engine.workspace_get().await.unwrap();
    ws.protected_branches.push("one".into());
    engine.workspace_save(ws.clone()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(5)).await;
    ws.protected_branches.push("two".into());
    engine.workspace_save(ws).await.unwrap();
    let names: Vec<_> = std::fs::read_dir(&backups).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(names.iter().all(|n| n.starts_with("ws-w-test.") && n.ends_with(".json")));
    engine.shutdown().await;
}

