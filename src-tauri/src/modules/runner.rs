//! Tauri glue of the `run` module (track P, Scripts/Run panel): commands and state on top of `intely_runner`. Commands
//! listed in `generate_handler!` under the "track P commands" marker in `lib.rs`; state is created in `setup`.
//!
//! Starting a process is a human action: these commands exist for the panel's buttons and nothing in the agent
//! host calls them. The webview never sends a command line, only a repo id and a script id; the backend re-reads
//! `package.json` on every start.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use intely_core::jail::Jail;
use intely_core::{code, BusyItem, BusyKind, Engine, EngineError, Survivor, SurvivorKind, SwitchWarning};
use intely_runner::types::{Catalog, LogChunk, ProcessAccess, ServerInfo, ServerStatus, StartRequest};
use intely_runner::{catalog, RunManager, RunSink, StartOpts};
use tauri::{AppHandle, Emitter, Manager, State};

use super::switchhook::{self, BoxFuture, SwitchHook};
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

/// `.0` is the manager (the other modules read `allow_processes()` and the live servers from it), `.1` what the
/// workspace switch needs to know about it.
pub struct RunState(pub(crate) Arc<RunManager>, pub(crate) Arc<RunExtra>);

/// Where each server was started and which processes survived the last switch.
pub struct RunExtra {
    cwds: Mutex<HashMap<String, PathBuf>>,
    survivors: Mutex<Vec<(Survivor, Vec<u16>)>>,
    /// Records a surviving process group in the next-start sweep registry (`run-gate.json`); a no-op without one.
    record: Arc<dyn Fn(i32) + Send + Sync>,
}

impl RunExtra {
    pub fn new(record: Arc<dyn Fn(i32) + Send + Sync>) -> Arc<Self> {
        Arc::new(Self { cwds: Mutex::default(), survivors: Mutex::default(), record })
    }
}

/// How long `stop` waits for the servers to leave before it reports them as survivors (the budget is 4 s).
const STOP_WAIT: Duration = Duration::from_millis(3500);

fn is_live(s: &ServerInfo) -> bool {
    matches!(s.status, ServerStatus::Starting | ServerStatus::Running | ServerStatus::Stopping)
}

impl RunState {
    pub fn new(mgr: RunManager, record: Arc<dyn Fn(i32) + Send + Sync>) -> Self {
        Self(Arc::new(mgr), RunExtra::new(record))
    }

    /// The `SwitchHook` of the Run panel's dev servers.
    pub fn hook(&self) -> Arc<dyn SwitchHook> {
        Arc::new(RunHook { mgr: self.0.clone(), extra: self.1.clone() })
    }
}

/// `Some(hook)` once `setup` ran.
pub fn hook(app: &AppHandle) -> Option<Arc<dyn SwitchHook>> {
    app.try_state::<RunState>().map(|s| s.hook())
}

struct RunHook {
    mgr: Arc<RunManager>,
    extra: Arc<RunExtra>,
}

/// Stops every dev server and waits (at most `wait`) for them to leave. Whatever ignored the group kill is returned,
/// remembered for the Kill button and recorded for the next-start sweep.
fn stop_servers(mgr: &RunManager, extra: &RunExtra, wait: Duration) -> Vec<Survivor> {
    mgr.stop_all();
    switchhook::wait_until(wait, Duration::from_millis(40), || !mgr.list().iter().any(is_live));
    let cwds = extra.cwds.lock().expect("cwds").clone();
    let left: Vec<(Survivor, Vec<u16>)> = mgr
        .list()
        .into_iter()
        .filter(is_live)
        .filter_map(|s| {
            let pid = s.pid?;
            let cwd = cwds.get(&s.id).map_or_else(|| s.repo_id.clone(), |p| p.to_string_lossy().into_owned());
            Some((Survivor { pid: pid as u32, port: s.ports.first().copied(), cwd, kind: SurvivorKind::DevServer }, s.ports.clone()))
        })
        .collect();
    for (s, _) in &left {
        (extra.record)(s.pid as i32);
    }
    *extra.survivors.lock().expect("survivors") = left.clone();
    left.into_iter().map(|(s, _)| s).collect()
}

impl SwitchHook for RunHook {
    fn name(&self) -> &'static str {
        "runner"
    }

    fn busy(&self) -> Vec<BusyItem> {
        let labels: Vec<String> = self.mgr.list().into_iter().filter(|s| matches!(s.status, ServerStatus::Starting | ServerStatus::Running)).map(|s| s.id).collect();
        if labels.is_empty() {
            return Vec::new();
        }
        vec![BusyItem { kind: BusyKind::DevServer, count: labels.len() as u32, labels }]
    }

    fn stop(&self) -> BoxFuture<'_, Vec<SwitchWarning>> {
        let (mgr, extra) = (self.mgr.clone(), self.extra.clone());
        Box::pin(async move {
            match switchhook::blocking(move || stop_servers(&mgr, &extra, STOP_WAIT)).await {
                Some(left) if left.is_empty() => Vec::new(),
                _ => vec![switchhook::stuck("runner")],
            }
        })
    }

    fn survivors(&self) -> Vec<Survivor> {
        self.extra.survivors.lock().expect("survivors").iter().map(|(s, _)| s.clone()).collect()
    }

    fn kill_survivor(&self, pid: u32) -> bool {
        let mut list = self.extra.survivors.lock().expect("survivors");
        let known = list.iter().any(|(s, _)| s.pid == pid);
        if known {
            switchhook::kill_group(pid as i32);
            list.retain(|(s, _)| s.pid != pid);
        }
        known
    }
}

/// Loopback ports of processes that survived the last switch: the preview refuses to front them.
pub fn survivor_ports(app: &AppHandle) -> Vec<u16> {
    let Some(state) = app.try_state::<RunState>() else { return Vec::new() };
    let live: Vec<i32> = state.0.list().into_iter().filter(is_live).filter_map(|s| s.pid).collect();
    let mut list = state.1.survivors.lock().expect("survivors");
    // A survivor that has gone since is no survivor any more.
    list.retain(|(s, _)| live.contains(&(s.pid as i32)));
    list.iter().flat_map(|(_, ports)| ports.clone()).collect()
}

/// `run:state` carries a full `ServerInfo`, `run:log` a batch of masked lines.
struct TauriRunSink(AppHandle);

impl RunSink for TauriRunSink {
    fn state(&self, server: ServerInfo) {
        let _ = self.0.emit("run:state", server);
    }
    fn log(&self, chunk: LogChunk) {
        let _ = self.0.emit("run:log", chunk);
    }
}

/// Called once from `setup` (track P state marker).
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = std::env::var_os("INTELY_DATA_DIR")
        .map(PathBuf::from)
        .or_else(intely_agent_core::events::log::JsonlEventLog::default_base_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    let orphans = RunManager::orphan_registry(&data_dir.join("run-gate.json"));
    let record: Arc<dyn Fn(i32) + Send + Sync> = match orphans.clone() {
        Some(o) => Arc::new(move |pgid| {
            let _ = o.record(pgid, "switch-survivor", "workspace-switch");
        }),
        None => Arc::new(|_| {}),
    };
    app.manage(RunState::new(RunManager::new(Jail::global(), orphans, Arc::new(TauriRunSink(app.handle().clone()))), record));
    Ok(())
}

/// App exit: no dev server outlives the IDE.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<RunState>() {
        state.0.shutdown();
    }
}

/// Listening loopback ports of the live servers (the preview proxy's E2E allow-list).
pub fn live_ports(app: &AppHandle) -> Vec<u16> {
    let Some(state) = app.try_state::<RunState>() else { return Vec::new() };
    state.0.list().into_iter().filter(|s| matches!(s.status, intely_runner::types::ServerStatus::Starting | intely_runner::types::ServerStatus::Running)).flat_map(|s| s.ports).collect()
}

async fn repo_path(slot: &EngineSlot, repo_id: &str) -> Res<PathBuf> {
    let ws = slot.get()?.workspace_get().await?;
    ws.repos.iter().find(|r| r.id == repo_id).map(|r| PathBuf::from(&r.path)).ok_or_else(|| EngineError::new(code::REPO_MISSING, format!("unknown repo {repo_id}")))
}

fn blocking_failed<E>(_: E) -> EngineError {
    EngineError::new(code::IO, "the run task failed")
}

#[tauri::command]
pub async fn run_scripts(slot: State<'_, EngineSlot>, repo_id: String) -> Res<Catalog> {
    let path = repo_path(&slot, &repo_id).await?;
    tauri::async_runtime::spawn_blocking(move || catalog::catalog(&repo_id, &path)).await.map_err(blocking_failed)?
}

/// The "Show command" button: the script body, masked, inline env values replaced.
#[tauri::command]
pub async fn run_script_command(slot: State<'_, EngineSlot>, repo_id: String, script: String) -> Res<String> {
    let path = repo_path(&slot, &repo_id).await?;
    tauri::async_runtime::spawn_blocking(move || catalog::display_command(&path, &script)).await.map_err(blocking_failed)?
}

#[tauri::command]
pub async fn run_start(app: AppHandle, slot: State<'_, EngineSlot>, state: State<'_, RunState>, req: StartRequest) -> Res<ServerInfo> {
    switchhook::gate_check(&app)?;
    let path = repo_path(&slot, &req.repo_id).await?;
    let env: HashMap<String, String> = slot.get().map(Engine::login_env).unwrap_or_default();
    let info = state.0.start(&req.repo_id, &path, &req.script, StartOpts { confirmed: req.confirmed, allow_second_heavy: req.allow_second_heavy, env })?;
    state.1.cwds.lock().expect("cwds").insert(info.id.clone(), path);
    Ok(info)
}

#[tauri::command]
pub async fn run_stop(state: State<'_, RunState>, server_id: String) -> Res<()> {
    state.0.stop(&server_id)
}

#[tauri::command]
pub async fn run_restart(app: AppHandle, slot: State<'_, EngineSlot>, server_id: String) -> Res<ServerInfo> {
    switchhook::gate_check(&app)?;
    let env: HashMap<String, String> = slot.get().map(Engine::login_env).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RunState>();
        state.0.restart(&server_id, env)
    })
    .await
    .map_err(blocking_failed)?
}

#[tauri::command]
pub async fn run_stop_all(state: State<'_, RunState>) -> Res<()> {
    state.0.stop_all();
    Ok(())
}

#[tauri::command]
pub async fn run_list(state: State<'_, RunState>) -> Res<Vec<ServerInfo>> {
    Ok(state.0.list())
}

#[tauri::command]
pub async fn run_logs(state: State<'_, RunState>, server_id: String, from_seq: u32) -> Res<LogChunk> {
    state.0.logs(&server_id, from_seq)
}

#[tauri::command]
pub async fn run_clear_log(state: State<'_, RunState>, server_id: String) -> Res<()> {
    state.0.clear_log(&server_id)
}

#[tauri::command]
pub async fn run_dismiss(state: State<'_, RunState>, server_id: String) -> Res<()> {
    state.0.dismiss(&server_id);
    Ok(())
}

/// Opens the server's detected `http://localhost:<port>` in the system browser. The URL is built from the detected port,
/// never taken from the webview.
#[tauri::command]
pub async fn run_open(state: State<'_, RunState>, server_id: String) -> Res<()> {
    let url = state.0.url(&server_id).filter(|u| u.starts_with("http://localhost:")).ok_or_else(|| EngineError::new(code::IO, "the server has no detected port"))?;
    std::process::Command::new("open").arg(url).spawn().map(|_| ()).map_err(|e| EngineError::new(code::IO, format!("could not open the browser: {e}")))
}

/// What the jail says about starting a process; with a repo id the E2E fixture-root rule is applied to that repo.
#[tauri::command]
pub async fn run_access(slot: State<'_, EngineSlot>, state: State<'_, RunState>, repo_id: Option<String>) -> Res<ProcessAccess> {
    let path = match repo_id {
        Some(id) => Some(repo_path(&slot, &id).await?),
        None => None,
    };
    Ok(state.0.access(path.as_deref()))
}

/// The session switch of Settings > Safety ("Allow processes"). In memory only, off at every launch.
#[tauri::command]
pub async fn run_allow_processes(state: State<'_, RunState>, allowed: bool) -> Res<ProcessAccess> {
    state.0.set_allow_processes(allowed);
    Ok(state.0.access(None))
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    struct NullSink;
    impl RunSink for NullSink {
        fn state(&self, _: ServerInfo) {}
        fn log(&self, _: LogChunk) {}
    }

    const SERVER_JS: &str = "require('http').createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1');";
    /// Ignores SIGTERM, and so does the child it starts: only SIGKILL ends it.
    const STUBBORN_JS: &str = r#"
process.on('SIGTERM', () => {});
const { spawn } = require('child_process');
spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
console.log('stubborn up');
setInterval(() => {}, 1000);
"#;

    fn fixture(grace: Duration) -> (tempfile::TempDir, RunState, Arc<Mutex<Vec<i32>>>) {
        let repo = tempfile::tempdir().unwrap();
        std::fs::write(repo.path().join("package.json"), r#"{"name":"fx","version":"1.0.0","scripts":{"dev":"node server.js","stubborn":"node stubborn.js"}}"#).unwrap();
        std::fs::write(repo.path().join("server.js"), SERVER_JS).unwrap();
        std::fs::write(repo.path().join("stubborn.js"), STUBBORN_JS).unwrap();
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let r = recorded.clone();
        let record: Arc<dyn Fn(i32) + Send + Sync> = Arc::new(move |pgid| r.lock().unwrap().push(pgid));
        let mgr = RunManager::with_grace(Arc::new(Jail::off()), None, Arc::new(NullSink), grace);
        (repo, RunState::new(mgr, record), recorded)
    }

    fn start(repo: &std::path::Path, state: &RunState, script: &str) -> ServerInfo {
        let info = state.0.start("fx", repo, script, StartOpts { confirmed: true, allow_second_heavy: true, env: HashMap::new() }).unwrap();
        state.1.cwds.lock().unwrap().insert(info.id.clone(), repo.to_path_buf());
        info
    }

    fn wait_for(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
        assert!(switchhook::wait_until(Duration::from_secs(secs), Duration::from_millis(50), &mut f), "timed out waiting for {what}");
    }

    /// The stubborn server has installed its SIGTERM handler once it printed this line.
    fn wait_until_stubborn(state: &RunState, id: &str) {
        wait_for("the stubborn server to print its banner", 60, || state.0.logs(id, 0).is_ok_and(|c| c.lines.iter().any(|l| l.contains("stubborn up"))));
        std::thread::sleep(Duration::from_millis(300));
    }

    #[test]
    fn stop_ends_the_servers_twice_is_harmless_and_the_module_is_reusable() {
        let (repo, state, recorded) = fixture(Duration::from_secs(3));
        let hook = state.hook();
        assert_eq!(hook.name(), "runner");
        assert!(hook.busy().is_empty());
        let info = start(repo.path(), &state, "npm:dev");
        wait_for("the server to be live", 20, || !hook.busy().is_empty());
        let busy = hook.busy();
        assert_eq!((busy[0].kind.clone(), busy[0].count, busy[0].labels.clone()), (BusyKind::DevServer, 1, vec![info.id.clone()]));

        let t = Instant::now();
        let warnings = tauri::async_runtime::block_on(hook.stop());
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
        assert!(!state.0.list().iter().any(is_live));
        assert!(hook.busy().is_empty() && hook.survivors().is_empty());
        assert!(recorded.lock().unwrap().is_empty());
        let pid = info.pid.unwrap();
        assert!(!switchhook::group_alive(pid), "the process group is gone");

        // twice is harmless
        assert!(tauri::async_runtime::block_on(hook.stop()).is_empty());
        // and the module can start the same server again
        let again = start(repo.path(), &state, "npm:dev");
        wait_for("the restarted server", 20, || matches!(state.0.list().iter().find(|s| s.id == again.id).map(|s| s.status.clone()), Some(ServerStatus::Starting | ServerStatus::Running)));
        assert!(tauri::async_runtime::block_on(hook.stop()).is_empty());
    }

    #[test]
    fn a_server_that_ignores_the_group_kill_is_a_survivor_until_it_is_killed() {
        // a grace period far beyond the test: nothing escalates to SIGKILL on its own
        let (repo, state, recorded) = fixture(Duration::from_secs(60));
        let info = start(repo.path(), &state, "npm:stubborn");
        let pid = info.pid.unwrap();
        wait_until_stubborn(&state, &info.id);

        let left = stop_servers(&state.0, &state.1, Duration::from_millis(900));
        assert_eq!(left.len(), 1, "{left:?}");
        assert_eq!((left[0].pid, left[0].kind.clone()), (pid as u32, SurvivorKind::DevServer));
        assert_eq!(left[0].cwd, repo.path().to_string_lossy());
        assert_eq!(*recorded.lock().unwrap(), vec![pid], "recorded for the next-start sweep");
        let hook = state.hook();
        assert_eq!(hook.survivors().len(), 1);
        assert!(switchhook::group_alive(pid), "it really ignored SIGTERM");

        assert!(!hook.kill_survivor(pid as u32 + 7), "only a listed pid can be killed");
        assert!(hook.kill_survivor(pid as u32));
        wait_for("the survivor to die", 10, || !switchhook::group_alive(pid));
        assert!(hook.survivors().is_empty());
        wait_for("the manager to notice", 20, || !state.0.list().iter().any(is_live));
    }

    #[test]
    fn a_missed_budget_is_reported_as_runner_stuck() {
        let (repo, state, _) = fixture(Duration::from_secs(60));
        let info = start(repo.path(), &state, "npm:stubborn");
        let pid = info.pid.unwrap();
        wait_until_stubborn(&state, &info.id);
        // the real hook waits 3.5 s, then names the stuck subsystem
        let warnings = tauri::async_runtime::block_on(state.hook().stop());
        assert_eq!(warnings, vec![switchhook::stuck("runner")]);
        switchhook::kill_group(pid);
    }
}
