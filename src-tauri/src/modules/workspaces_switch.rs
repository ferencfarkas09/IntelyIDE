//! The workspace switch ((design notes: workspaces-spec) 3.9, 4.8, 4.10; task C5b): `workspaces_switch`, `workspaces_busy` and
//! `workspaces_kill_survivor` over the pure teardown runner of `switchhook.rs`.
//!
//! The order of one switch: take the engine's switch ticket (a second switch is refused), set the gate (nothing new may
//! spawn), judge what is busy (nothing has been stopped so far, so every refusal changes nothing), then stop the
//! modules in their fixed order under their budgets, swap the engine, record the new active workspace and announce it.
//! From the first teardown step on the page must reload whatever happens: an error after that point carries a code the
//! UI does not treat as "nothing changed".

use std::path::PathBuf;
use std::sync::Arc;

use intely_core::types::code;
use intely_core::{workspace, BusyReport, Engine, EngineError, Survivor, SwitchResult, SwitchWarning};
use tauri::{AppHandle, Emitter, State};

use super::switchhook::{self, Clock, RealClock, SwitchHook};
use super::workspaces::WorkspacesState;
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

/// The code of a failure after teardown started (the stopped modules cannot be un-stopped): the page reloads.
pub const SWITCH_FAILED: &str = "switchFailed";

/// What the orchestrator announces; the app emits events, the tests record them.
pub trait SwitchEvents: Send + Sync {
    fn switching(&self, from_id: Option<&str>, to_id: Option<&str>, epoch: u64);
    fn changed(&self, active_id: Option<&str>, epoch: u64);
}

struct TauriEvents(AppHandle);

impl SwitchEvents for TauriEvents {
    fn switching(&self, from_id: Option<&str>, to_id: Option<&str>, epoch: u64) {
        let _ = self.0.emit("workspace:switching", serde_json::json!({ "fromId": from_id, "toId": to_id, "epoch": epoch }));
    }

    fn changed(&self, active_id: Option<&str>, epoch: u64) {
        let _ = self.0.emit("workspace:changed", serde_json::json!({ "activeId": active_id, "epoch": epoch }));
    }
}

#[derive(Debug, Clone)]
pub struct SwitchRequest {
    /// The workspace to open; `None` closes the open one.
    pub id: Option<String>,
    /// Stop the confirmable blockers (agents, servers, ...) instead of answering `workspaceBusy`.
    pub force: bool,
    /// Detach the engine but leave `activeId` in the registry (all folders of the active workspace are missing).
    pub keep_active: bool,
}

/// What is busy right now: the engine's git runs and held guards (blocking) and whatever the modules report.
pub fn busy_report_of(engine: &Engine, hooks: &[Arc<dyn SwitchHook>]) -> BusyReport {
    let engine_items = switchhook::engine_busy_items(&engine.busy());
    switchhook::classify_busy(engine_items.into_iter().chain(hooks.iter().flat_map(|h| h.busy())))
}

fn busy_error(report: &BusyReport) -> EngineError {
    // The UI parses the report out of `detail` (JSON); the message stays a plain sentence for logs.
    EngineError::new(code::WORKSPACE_BUSY, "something is still running").with_detail(serde_json::to_string(report).unwrap_or_default())
}

/// A failure after teardown: not one of the codes the UI reads as "nothing changed".
fn failed_after_teardown(cause: &EngineError) -> EngineError {
    EngineError::new(SWITCH_FAILED, cause.message.clone()).with_detail(cause.code.clone())
}

/// One switch. See the module comment for the order; `clock` is the teardown clock (fake in tests).
pub async fn run_switch(
    state: &WorkspacesState,
    engine: &Engine,
    clock: &dyn Clock,
    hooks: &[Arc<dyn SwitchHook>],
    req: SwitchRequest,
    events: &dyn SwitchEvents,
) -> Res<SwitchResult> {
    if state.registry.is_pinned() {
        return Err(EngineError::new(code::PINNED, "the workspace is fixed by INTELY_WORKSPACE"));
    }
    // A second switch is refused here, before it could touch the gate of the first one.
    let ticket = engine.begin_switch()?;
    let gate_guard = state.gate.set();

    // Everything that can fail without side effects: the target, then the busy judgement (3.9 step 3).
    let target: Option<(String, PathBuf)> = match &req.id {
        None => None,
        Some(id) => {
            let known = state.registry.view().workspaces.iter().any(|w| &w.id == id);
            if !known {
                return Err(EngineError::new(code::WORKSPACE_NOT_FOUND, "no such workspace").with_detail(id.clone()));
            }
            let path = state.registry.workspace_path(id)?;
            workspace::load_existing(&path)?;
            Some((id.clone(), path))
        }
    };
    let report = busy_report_of(engine, hooks);
    if !report.blocking.is_empty() || (!report.confirmable.is_empty() && !req.force) {
        return Err(busy_error(&report));
    }

    // The point of no return: the gate stays set until the new page says it is ready (or 15 s pass).
    let from = state.active_id();
    let epoch_next = engine.epoch() + 1;
    events.switching(from.as_deref(), req.id.as_deref(), epoch_next);
    gate_guard.hold();

    let teardown = switchhook::run_teardown(&switchhook::ordered(hooks), clock).await;
    let mut warnings: Vec<SwitchWarning> = teardown.warnings;

    let backup_dir = (!state.registry.is_pinned()).then(|| state.registry.backup_dir());
    let swapped = engine.switch_with(&ticket, target.as_ref().map(|(_, p)| p.clone()), backup_dir).await;
    let epoch = match swapped {
        Ok(epoch) => epoch,
        Err(cause) => {
            // Modules are stopped; the safest state is no workspace at all, and a page that reloads against it.
            let _ = engine.switch_with(&ticket, None, None).await;
            state.set_active(None);
            let registry = state.registry.clone();
            let _ = switchhook::blocking(move || registry.set_active(None)).await;
            return Err(failed_after_teardown(&cause));
        }
    };

    let new_active = target.as_ref().map(|(id, _)| id.clone());
    state.set_active(new_active.clone());
    state.clear_launch_notices();
    if req.keep_active && new_active.is_none() {
        state.note_all_missing(state.registry.view().active_id);
    }
    if !req.keep_active {
        let (registry, id) = (state.registry.clone(), new_active.clone());
        let recorded = switchhook::blocking(move || registry.set_active(id.as_deref())).await;
        if !matches!(recorded, Some(Ok(()))) {
            // The switch stands; the next launch may reopen the previous workspace.
            warnings.push(SwitchWarning { code: "registryWriteFailed".into(), subsystem: "registry".into() });
        }
    }
    events.changed(new_active.as_deref(), epoch);
    let active_id = if req.keep_active { state.registry.view().active_id } else { new_active };
    Ok(SwitchResult { active_id, epoch, warnings, survivors: switchhook::collect_survivors(hooks) })
}

/// Ends one of the survivors of the last switch (never an arbitrary pid).
pub fn kill_survivor(hooks: &[Arc<dyn SwitchHook>], pid: u32) -> Res<()> {
    if hooks.iter().any(|h| h.kill_survivor(pid)) {
        Ok(())
    } else {
        Err(EngineError::new(code::INVALID_SELECTION, "that process is not a leftover of the last switch").with_detail(pid.to_string()))
    }
}

/// Everything that still runs from the last switch.
pub fn survivors_of(hooks: &[Arc<dyn SwitchHook>]) -> Vec<Survivor> {
    switchhook::collect_survivors(hooks)
}

fn hooks_of(state: &WorkspacesState) -> Vec<Arc<dyn SwitchHook>> {
    state.hooks.lock().expect("hooks").clone()
}

/// The hooks of every module that owns processes, watchers or caches of a workspace, registered once at startup.
pub fn register_module_hooks(app: &AppHandle, state: &WorkspacesState) {
    let mut hooks: Vec<Arc<dyn SwitchHook>> = Vec::new();
    hooks.extend(crate::agents::hook(app));
    hooks.extend(super::runner::hook(app));
    hooks.extend(super::checks::hook(app));
    hooks.extend(super::term::hook(app));
    hooks.extend(super::preview::hook(app));
    hooks.extend(super::files::hook(app));
    hooks.push(super::contract::hook());
    #[cfg(feature = "mongo-studio")]
    hooks.extend(super::mongo::hook(app));
    hooks.extend(super::remote::hook(app));
    state.register_hooks(hooks);
}

#[tauri::command]
pub async fn workspaces_busy(slot: State<'_, EngineSlot>, state: State<'_, Arc<WorkspacesState>>) -> Res<BusyReport> {
    Ok(busy_report_of(slot.get()?, &hooks_of(&state)))
}

#[tauri::command]
pub async fn workspaces_switch(
    app: AppHandle,
    slot: State<'_, EngineSlot>,
    state: State<'_, Arc<WorkspacesState>>,
    id: Option<String>,
    force: bool,
    keep_active: Option<bool>,
) -> Res<SwitchResult> {
    let hooks = hooks_of(&state);
    let req = SwitchRequest { id, force, keep_active: keep_active.unwrap_or(false) };
    run_switch(&state, slot.get()?, &RealClock, &hooks, req, &TauriEvents(app)).await
}

#[tauri::command]
pub async fn workspaces_kill_survivor(state: State<'_, Arc<WorkspacesState>>, pid: u32) -> Res<()> {
    let hooks = hooks_of(&state);
    switchhook::blocking(move || kill_survivor(&hooks, pid)).await.unwrap_or_else(|| Err(EngineError::new(code::IO, "the kill failed")))
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use intely_core::jail::Jail;
    use intely_core::registry::{Env, Location, NewRepo, NewWorkspace, Registry, RepoKind, ValidatedRepo};
    use intely_core::{BusyItem, BusyKind, EventSink, SurvivorKind, WorkspaceOrigin};
    use intely_pathpick::{PathTokens, Policy, Validator};

    use super::super::switchhook::{BoxFuture, SwitchGate};
    use super::*;

    struct NoSink;
    impl EventSink for NoSink {
        fn snapshot(&self, _: intely_core::RepoSnapshot) {}
        fn op_event(&self, _: intely_core::OpEvent) {}
        fn op_result(&self, _: intely_core::OpResult) {}
        fn env(&self, _: intely_core::EnvStatus) {}
    }

    #[derive(Default)]
    struct Recorder {
        log: Mutex<Vec<String>>,
    }

    impl SwitchEvents for Recorder {
        fn switching(&self, from: Option<&str>, to: Option<&str>, epoch: u64) {
            self.log.lock().unwrap().push(format!("switching {from:?} {to:?} {epoch}"));
        }
        fn changed(&self, active: Option<&str>, epoch: u64) {
            self.log.lock().unwrap().push(format!("changed {active:?} {epoch}"));
        }
    }

    /// A scripted module: records its `stop` into the shared log, and can misbehave on request.
    struct Hook {
        name: &'static str,
        log: Arc<Mutex<Vec<String>>>,
        busy: Mutex<Vec<BusyItem>>,
        survivors: Mutex<Vec<Survivor>>,
        gate: Option<Arc<SwitchGate>>,
        hang: bool,
        on_stop: Option<Box<dyn Fn() + Send + Sync>>,
    }

    impl Hook {
        fn new(name: &'static str, log: &Arc<Mutex<Vec<String>>>) -> Self {
            Self { name, log: log.clone(), busy: Mutex::default(), survivors: Mutex::default(), gate: None, hang: false, on_stop: None }
        }
    }

    impl SwitchHook for Hook {
        fn name(&self) -> &'static str {
            self.name
        }
        fn busy(&self) -> Vec<BusyItem> {
            self.busy.lock().unwrap().clone()
        }
        fn stop(&self) -> BoxFuture<'_, Vec<SwitchWarning>> {
            Box::pin(async move {
                let gate = self.gate.as_ref().map(|g| g.is_set());
                self.log.lock().unwrap().push(format!("stop {} gate={gate:?}", self.name));
                if let Some(f) = &self.on_stop {
                    f();
                }
                if self.hang {
                    std::future::pending::<()>().await;
                }
                self.busy.lock().unwrap().clear();
                Vec::new()
            })
        }
        fn survivors(&self) -> Vec<Survivor> {
            self.survivors.lock().unwrap().clone()
        }
        fn kill_survivor(&self, pid: u32) -> bool {
            let mut s = self.survivors.lock().unwrap();
            let known = s.iter().any(|x| x.pid == pid);
            s.retain(|x| x.pid != pid);
            known
        }
    }

    struct Fx {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        state: Arc<WorkspacesState>,
        engine: Engine,
        a: String,
        b: String,
    }

    fn git_repo(root: &Path, name: &str) -> ValidatedRepo {
        use std::os::unix::fs::MetadataExt;
        let p = root.join("repos").join(name);
        std::fs::create_dir_all(&p).unwrap();
        let out = std::process::Command::new(intely_core::exec::pinned_git_path())
            .args(["init", "-q", "-b", "main"])
            .arg(&p)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .unwrap();
        assert!(out.status.success());
        let m = std::fs::metadata(&p).unwrap();
        ValidatedRepo { canonical_path: p.canonicalize().unwrap().to_string_lossy().into_owned(), suggested_name: name.into(), identity: format!("{}:{}", m.dev(), m.ino()), kind: RepoKind::Repo, main: None }
    }

    fn fx() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let dir = root.join("state");
        let loc = Location { registry: dir.join("workspaces.json"), pinned: None, dir: dir.clone(), env_ignored: false };
        let opened = Registry::open(loc, Arc::new(Jail::off()), Env::real());
        let registry = Arc::new(opened.registry);
        let mk = |name: &str, repos: &[&str]| {
            let repos = repos.iter().map(|r| NewRepo::plain(git_repo(&root, r))).collect();
            registry.create(NewWorkspace { name: name.into(), color: None, repos, origin: WorkspaceOrigin::Created }).unwrap().id
        };
        let a = mk("Alpha", &["a1", "a2"]);
        let b = mk("Beta", &["b1"]);
        registry.set_active(Some(&a)).unwrap();
        let validator = Validator::new(Policy::new(Arc::new(Jail::off()), root.join("home"), dir));
        let state = Arc::new(WorkspacesState::new(registry.clone(), Arc::new(PathTokens::new()), validator, SwitchGate::new(Arc::new(super::super::switchhook::testing::FakeClock::new()))));
        state.set_active(Some(a.clone()));
        let path = registry.workspace_path(&a).unwrap();
        let engine = tauri::async_runtime::block_on(async { Engine::new_for(Some(path), Some(registry.backup_dir()), Arc::new(NoSink), Arc::new(Jail::off()), Arc::new(Allow)).unwrap() });
        Fx { _tmp: tmp, root, state, engine, a, b }
    }

    struct Allow;
    impl intely_core::ProtectionSource for Allow {
        fn protection(&self, _: &Path) -> intely_core::Protection {
            intely_core::Protection { protected: vec![], live: vec![] }
        }
    }

    fn log() -> Arc<Mutex<Vec<String>>> {
        Arc::new(Mutex::new(Vec::new()))
    }

    fn run(f: &Fx, hooks: &[Arc<dyn SwitchHook>], id: Option<&str>, force: bool, keep_active: bool, rec: &Recorder) -> Res<SwitchResult> {
        tauri::async_runtime::block_on(run_switch(&f.state, &f.engine, &RealClock, hooks, SwitchRequest { id: id.map(str::to_owned), force, keep_active }, rec))
    }

    fn repo_ids(f: &Fx) -> Vec<String> {
        tauri::async_runtime::block_on(f.engine.workspace_get()).unwrap().repos.into_iter().map(|r| r.name).collect()
    }

    fn item(kind: BusyKind, n: u32) -> BusyItem {
        BusyItem { kind, count: n, labels: (0..n).map(|i| format!("x{i}")).collect() }
    }

    #[test]
    fn a_switch_stops_the_modules_in_order_swaps_the_engine_records_the_workspace_and_keeps_the_gate_until_ready() {
        let f = fx();
        let l = log();
        let mk = |n: &'static str| {
            let mut h = Hook::new(n, &l);
            h.gate = Some(f.state.gate.clone());
            Arc::new(h) as Arc<dyn SwitchHook>
        };
        // registered in the wrong order on purpose
        let hooks = vec![mk("files"), mk("term"), mk("agents"), mk("runner")];
        let rec = Recorder::default();
        assert_eq!(repo_ids(&f), vec!["a1", "a2"]);
        let r = run(&f, &hooks, Some(&f.b), false, false, &rec).expect("switch");

        assert_eq!(*l.lock().unwrap(), vec!["stop agents gate=Some(true)", "stop runner gate=Some(true)", "stop term gate=Some(true)", "stop files gate=Some(true)"], "teardown order, with the gate already set");
        assert_eq!((r.active_id.as_deref(), r.epoch), (Some(f.b.as_str()), 2));
        assert!(r.warnings.is_empty() && r.survivors.is_empty());
        assert_eq!(repo_ids(&f), vec!["b1"], "the engine runs the new workspace");
        assert_eq!(f.state.active_id().as_deref(), Some(f.b.as_str()));
        let view = f.state.registry.view();
        assert_eq!(view.active_id.as_deref(), Some(f.b.as_str()));
        assert!(view.workspaces.iter().find(|w| w.id == f.b).unwrap().last_opened_at.is_some());
        assert_eq!(*rec.log.lock().unwrap(), vec![format!("switching Some({:?}) Some({:?}) 2", f.a, f.b), format!("changed Some({:?}) 2", f.b)]);
        // spawning is refused until the new page is ready
        assert_eq!(switchhook::check_optional(Some(&f.state.gate)).unwrap_err().code, code::WORKSPACE_SWITCHING);
        super::super::workspaces::mark_ready(&f.root);
        f.state.gate.clear();
        assert!(switchhook::check_optional(Some(&f.state.gate)).is_ok());
        // and back again, then close
        let back = run(&f, &hooks, Some(&f.a), false, false, &rec).unwrap();
        assert_eq!(back.epoch, 3);
        let closed = run(&f, &hooks, None, false, false, &rec).unwrap();
        assert_eq!((closed.active_id, closed.epoch), (None, 4));
        assert!(f.engine.is_detached());
        assert_eq!(f.state.registry.view().active_id, None);
    }

    #[test]
    fn busy_is_split_into_blocking_and_confirmable_and_refuses_without_stopping_anything() {
        let f = fx();
        let l = log();
        let mut agents = Hook::new("agents", &l);
        agents.busy = Mutex::new(vec![item(BusyKind::Agent, 2)]);
        let mut runner = Hook::new("runner", &l);
        runner.busy = Mutex::new(vec![item(BusyKind::DevServer, 1)]);
        let hooks: Vec<Arc<dyn SwitchHook>> = vec![Arc::new(agents), Arc::new(runner)];
        let guard = f.engine.mutation_guard("rebase").unwrap();

        let report = busy_report_of(&f.engine, &hooks);
        assert_eq!(report.blocking.iter().map(|i| i.kind.clone()).collect::<Vec<_>>(), vec![BusyKind::GitOp]);
        assert_eq!(report.confirmable.iter().map(|i| i.kind.clone()).collect::<Vec<_>>(), vec![BusyKind::Agent, BusyKind::DevServer]);

        let rec = Recorder::default();
        // a held git operation blocks even a forced switch, and the detail is the report as JSON
        let e = run(&f, &hooks, Some(&f.b), true, false, &rec).unwrap_err();
        assert_eq!(e.code, code::WORKSPACE_BUSY);
        let parsed: BusyReport = serde_json::from_str(&e.detail.unwrap()).unwrap();
        assert_eq!(parsed, report);
        assert!(l.lock().unwrap().is_empty(), "nothing was stopped");
        assert!(rec.log.lock().unwrap().is_empty(), "nothing was announced");
        assert_eq!(repo_ids(&f), vec!["a1", "a2"]);
        assert!(!f.state.gate.is_set(), "a refused switch does not leave the app locked");
        assert!(f.engine.begin_switch().is_ok(), "nor does it keep the engine's ticket");

        drop(guard);
        // only confirmable items: refused without force, allowed with it
        let e = run(&f, &hooks, Some(&f.b), false, false, &rec).unwrap_err();
        assert_eq!(e.code, code::WORKSPACE_BUSY);
        assert!(l.lock().unwrap().is_empty());
        run(&f, &hooks, Some(&f.b), true, false, &rec).expect("force stops the confirmable ones");
        assert_eq!(l.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_module_past_its_budget_becomes_a_warning_and_the_switch_still_completes() {
        let f = fx();
        let l = log();
        let mut stuck = Hook::new("checks", &l);
        stuck.hang = true;
        let after = Hook::new("term", &l);
        let hooks: Vec<Arc<dyn SwitchHook>> = vec![Arc::new(stuck), Arc::new(after)];
        let t = Instant::now();
        let r = run(&f, &hooks, Some(&f.b), true, false, &Recorder::default()).unwrap();
        assert!(t.elapsed() < Duration::from_secs(30), "the 1 s budget cut the hung module, not the machine load: {:?}", t.elapsed());
        assert_eq!(r.warnings, vec![SwitchWarning { code: "checksStuck".into(), subsystem: "checks".into() }]);
        assert_eq!(l.lock().unwrap().len(), 2, "the next module still ran");
        assert_eq!(repo_ids(&f), vec!["b1"]);
    }

    #[test]
    fn a_failure_after_teardown_started_leaves_the_engine_detached_and_is_not_a_nothing_changed_error() {
        let f = fx();
        let l = log();
        let mut saboteur = Hook::new("agents", &l);
        // the target file is fine at the preflight and broken by the time the engine reads it
        let target = f.state.registry.workspace_path(&f.b).unwrap();
        saboteur.on_stop = Some(Box::new(move || std::fs::write(&target, "{ broken").unwrap()));
        let hooks: Vec<Arc<dyn SwitchHook>> = vec![Arc::new(saboteur)];
        let rec = Recorder::default();
        let e = run(&f, &hooks, Some(&f.b), true, false, &rec).unwrap_err();
        assert_eq!(e.code, SWITCH_FAILED, "{e:?}");
        assert_eq!(e.detail.as_deref(), Some("invalidWorkspace"));
        assert!(!["workspaceBusy", "workspaceNotFound", "invalidWorkspace", "workspaceFileMissing", "workspaceSwitching", "pinned", "registryBusy", "noWorkspace", "staleEpoch"].contains(&e.code.as_str()), "the page must reload");
        assert!(f.engine.is_detached(), "the engine is left with no workspace");
        assert_eq!(f.state.active_id(), None);
        assert_eq!(f.state.registry.view().active_id, None, "the next boot shows Welcome, the old workspace one click away");
        assert!(f.state.gate.is_set(), "the gate stays up until the reloaded page is ready");
        assert_eq!(l.lock().unwrap().len(), 1);
        // the old workspace can be opened again
        f.state.gate.clear();
        run(&f, &[], Some(&f.a), true, false, &rec).expect("one click away");
        assert_eq!(repo_ids(&f), vec!["a1", "a2"]);
    }

    #[test]
    fn a_bad_target_is_refused_before_anything_is_stopped() {
        let f = fx();
        let l = log();
        let hooks: Vec<Arc<dyn SwitchHook>> = vec![Arc::new(Hook::new("agents", &l))];
        let rec = Recorder::default();
        assert_eq!(run(&f, &hooks, Some("nope"), true, false, &rec).unwrap_err().code, code::WORKSPACE_NOT_FOUND);
        std::fs::write(f.state.registry.workspace_path(&f.b).unwrap(), "{ broken").unwrap();
        assert_eq!(run(&f, &hooks, Some(&f.b), true, false, &rec).unwrap_err().code, "invalidWorkspace");
        std::fs::remove_file(f.state.registry.workspace_path(&f.b).unwrap()).unwrap();
        assert_eq!(run(&f, &hooks, Some(&f.b), true, false, &rec).unwrap_err().code, code::WORKSPACE_FILE_MISSING);
        assert!(l.lock().unwrap().is_empty() && rec.log.lock().unwrap().is_empty());
        assert_eq!(repo_ids(&f), vec!["a1", "a2"]);
        assert!(!f.state.gate.is_set());
    }

    #[test]
    fn a_second_switch_is_refused_and_does_not_touch_the_first_ones_gate() {
        let f = fx();
        let ticket = f.engine.begin_switch().unwrap();
        f.state.gate.set().hold();
        let e = run(&f, &[], Some(&f.b), true, false, &Recorder::default()).unwrap_err();
        assert_eq!(e.code, code::WORKSPACE_SWITCHING);
        assert!(f.state.gate.is_set(), "the running switch keeps its gate");
        drop(ticket);
    }

    #[test]
    fn keep_active_detaches_the_engine_but_leaves_the_registry_alone() {
        let f = fx();
        let r = run(&f, &[], None, true, true, &Recorder::default()).unwrap();
        assert!(f.engine.is_detached());
        assert_eq!(r.active_id.as_deref(), Some(f.a.as_str()), "the registry still says Alpha");
        assert_eq!(f.state.registry.view().active_id.as_deref(), Some(f.a.as_str()));
        assert_eq!(f.state.active_id(), None, "but the engine has nothing open");
        let view = f.state.decorate(f.state.registry.view(), None);
        let err = view.open_error.expect("the next list reports why nothing is open");
        assert_eq!((err.id.as_str(), err.reason), (f.a.as_str(), intely_core::OpenErrorReason::AllMissing));
        // opening any workspace afterwards ends the notice
        run(&f, &[], Some(&f.b), true, false, &Recorder::default()).unwrap();
        assert!(f.state.decorate(f.state.registry.view(), None).open_error.is_none());
    }

    #[test]
    fn a_registry_that_cannot_be_written_is_a_warning_not_a_failure() {
        let f = fx();
        let l = log();
        let mut saboteur = Hook::new("agents", &l);
        let registry_file = f.state.registry.location().registry.clone();
        saboteur.on_stop = Some(Box::new(move || std::fs::write(&registry_file, "garbage").unwrap()));
        let hooks: Vec<Arc<dyn SwitchHook>> = vec![Arc::new(saboteur)];
        let r = run(&f, &hooks, Some(&f.b), true, false, &Recorder::default()).unwrap();
        assert!(r.warnings.iter().any(|w| w.code == "registryWriteFailed"), "{:?}", r.warnings);
        assert_eq!(repo_ids(&f), vec!["b1"], "the switch stands");
    }

    #[test]
    fn survivors_are_reported_and_only_listed_pids_can_be_killed() {
        let f = fx();
        let l = log();
        let mut runner = Hook::new("runner", &l);
        runner.survivors = Mutex::new(vec![Survivor { pid: 4242, port: Some(3000), cwd: "/x".into(), kind: SurvivorKind::DevServer }]);
        let hooks: Vec<Arc<dyn SwitchHook>> = vec![Arc::new(runner)];
        let r = run(&f, &hooks, Some(&f.b), true, false, &Recorder::default()).unwrap();
        assert_eq!(r.survivors.len(), 1);
        assert_eq!(kill_survivor(&hooks, 1).unwrap_err().code, code::INVALID_SELECTION);
        assert_eq!(kill_survivor(&hooks, 0).unwrap_err().code, code::INVALID_SELECTION);
        kill_survivor(&hooks, 4242).unwrap();
        assert!(survivors_of(&hooks).is_empty());
        assert!(kill_survivor(&hooks, 4242).is_err(), "only once");
    }

    #[test]
    fn a_pinned_registry_refuses_every_switch() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let file = root.join("workspace.json");
        std::fs::write(&file, serde_json::to_vec(&workspace::empty()).unwrap()).unwrap();
        let loc = Location { registry: root.join("workspaces.json"), pinned: Some(file.clone()), dir: root.clone(), env_ignored: false };
        let opened = Registry::open(loc, Arc::new(Jail::off()), Env::real());
        let registry = Arc::new(opened.registry);
        let validator = Validator::new(Policy::new(Arc::new(Jail::off()), root.join("home"), root.clone()));
        let state = WorkspacesState::new(registry, Arc::new(PathTokens::new()), validator, SwitchGate::real());
        let engine = tauri::async_runtime::block_on(async { Engine::new_for(Some(file), None, Arc::new(NoSink), Arc::new(Jail::off()), Arc::new(Allow)).unwrap() });
        let rec = Recorder::default();
        let e = tauri::async_runtime::block_on(run_switch(&state, &engine, &RealClock, &[], SwitchRequest { id: None, force: true, keep_active: false }, &rec)).unwrap_err();
        assert_eq!(e.code, code::PINNED);
        assert!(!engine.is_detached());
    }
}
