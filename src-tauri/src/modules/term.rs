//! Tauri glue of the `term` module (track C): commands and state on top of `intely_term`. Commands listed in
//! `generate_handler!` under the "track C commands" marker in `lib.rs`; state is created in `setup`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use intely_core::jail::Jail;
use intely_core::{code, BusyItem, BusyKind, Engine, EngineError, Survivor, SurvivorKind, SwitchWarning};
use intely_term::types::{TermEvent, TermOpenOptions, TermOpened};
use intely_term::{SpawnSpec, TermManager};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use super::switchhook::{self, BoxFuture, SwitchHook};
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

/// `.0` is the shell manager, `.1` what the workspace switch needs to know about the shells.
pub struct TermState(Arc<TermManager>, Arc<TermExtra>);

struct TermMeta {
    pid: i32,
    cwd: String,
}

/// Process group and start directory of every open terminal, and the shells that survived the last switch.
pub struct TermExtra {
    open: Mutex<HashMap<String, TermMeta>>,
    survivors: Mutex<Vec<Survivor>>,
    /// Records a surviving process group in the next-start sweep registry (`term-gate.json`); a no-op without one.
    record: Arc<dyn Fn(i32) + Send + Sync>,
}

/// How long `stop` waits for the shells to leave before it reports them as survivors (the budget is 1 s).
const STOP_WAIT: Duration = Duration::from_millis(850);

impl TermState {
    pub fn new(mgr: TermManager, record: Arc<dyn Fn(i32) + Send + Sync>) -> Self {
        Self(Arc::new(mgr), Arc::new(TermExtra { open: Mutex::default(), survivors: Mutex::default(), record }))
    }

    /// The `SwitchHook` of the terminals.
    pub fn hook(&self) -> Arc<dyn SwitchHook> {
        Arc::new(TermHook { mgr: self.0.clone(), extra: self.1.clone() })
    }
}

/// `Some(hook)` once `setup` ran.
pub fn hook(app: &AppHandle) -> Option<Arc<dyn SwitchHook>> {
    app.try_state::<TermState>().map(|s| s.hook())
}

struct TermHook {
    mgr: Arc<TermManager>,
    extra: Arc<TermExtra>,
}

/// Closes every terminal and waits (at most `wait`) for the shells and their jobs to leave.
fn close_all(mgr: &TermManager, extra: &TermExtra, wait: Duration) -> Vec<Survivor> {
    let ids = mgr.open_ids();
    let metas: Vec<TermMeta> = {
        let mut open = extra.open.lock().expect("terminals");
        ids.iter().filter_map(|id| open.remove(id)).collect()
    };
    for id in &ids {
        mgr.close(id);
    }
    switchhook::wait_until(wait, Duration::from_millis(30), || metas.iter().all(|m| !switchhook::group_alive(m.pid)));
    let left: Vec<Survivor> = metas
        .into_iter()
        .filter(|m| switchhook::group_alive(m.pid))
        .map(|m| Survivor { pid: m.pid as u32, port: None, cwd: m.cwd, kind: SurvivorKind::Terminal })
        .collect();
    for s in &left {
        (extra.record)(s.pid as i32);
    }
    *extra.survivors.lock().expect("survivors") = left.clone();
    left
}

impl SwitchHook for TermHook {
    fn name(&self) -> &'static str {
        "term"
    }

    fn busy(&self) -> Vec<BusyItem> {
        let labels: Vec<String> = {
            let open = self.extra.open.lock().expect("terminals");
            self.mgr.open_ids().iter().map(|id| open.get(id).map_or_else(String::new, |m| m.cwd.clone())).collect()
        };
        if labels.is_empty() {
            return Vec::new();
        }
        vec![BusyItem { kind: BusyKind::Terminal, count: labels.len() as u32, labels }]
    }

    fn stop(&self) -> BoxFuture<'_, Vec<SwitchWarning>> {
        let (mgr, extra) = (self.mgr.clone(), self.extra.clone());
        Box::pin(async move {
            match switchhook::blocking(move || close_all(&mgr, &extra, STOP_WAIT)).await {
                Some(left) if left.is_empty() => Vec::new(),
                _ => vec![switchhook::stuck("term")],
            }
        })
    }

    fn survivors(&self) -> Vec<Survivor> {
        self.extra.survivors.lock().expect("survivors").clone()
    }

    fn kill_survivor(&self, pid: u32) -> bool {
        let mut list = self.extra.survivors.lock().expect("survivors");
        let known = list.iter().any(|s| s.pid == pid);
        if known {
            switchhook::kill_group(pid as i32);
            list.retain(|s| s.pid != pid);
        }
        known
    }
}

/// T19: a terminal may start only inside a repository of the open workspace, below the home directory or (in a test
/// jail) inside the fixture root. The path is canonicalised first, so `..` and symlinks cannot walk out.
pub fn constrain_cwd(cwd: &Path, repo_roots: &[PathBuf], home: Option<&Path>, jail: &Jail) -> Res<PathBuf> {
    let refuse = |why: &str| EngineError::new(code::PATH_NOT_VALIDATED, format!("a terminal cannot start in {}: {why}", cwd.display()));
    let canonical = std::fs::canonicalize(cwd).map_err(|e| refuse(&e.to_string()))?;
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let inside_repo = repo_roots.iter().any(|r| canonical.starts_with(canon(r)));
    let inside_home = home.is_some_and(|h| canonical.starts_with(canon(h)) && canon(h) != Path::new("/"));
    let inside_fixture = jail.fixture_root().is_some_and(|_| jail.in_fixture(&canonical));
    if inside_repo || inside_home || inside_fixture {
        Ok(canonical)
    } else {
        Err(refuse("it is outside the workspace and the home folder"))
    }
}

/// Called once from `setup` (track C state marker): create and `app.manage(..)` the module state here.
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = std::env::var_os("INTELY_DATA_DIR")
        .map(PathBuf::from)
        .or_else(intely_agent_core::events::log::JsonlEventLog::default_base_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    let orphans = TermManager::orphan_registry(&data_dir.join("term-gate.json"));
    let record: Arc<dyn Fn(i32) + Send + Sync> = match orphans.clone() {
        Some(o) => Arc::new(move |pgid| {
            let _ = o.record(pgid, "switch-survivor", "workspace-switch");
        }),
        None => Arc::new(|_| {}),
    };
    app.manage(TermState::new(TermManager::new(Jail::global(), orphans), record));
    Ok(())
}

/// App exit: no shell outlives the IDE.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<TermState>() {
        state.0.shutdown();
    }
}

/// The directory a terminal starts in: an explicit one (which must be inside a repo of the workspace, the home folder
/// or the test fixture root), else the repo root, else the home directory.
async fn start_dir(slot: &EngineSlot, opts: &TermOpenOptions) -> Res<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if let Some(cwd) = opts.cwd.as_deref().filter(|c| !c.is_empty()) {
        let roots: Vec<PathBuf> = match slot.get() {
            Ok(engine) => engine.workspace_get().await?.repos.iter().map(|r| PathBuf::from(&r.path)).collect(),
            Err(_) => Vec::new(),
        };
        return constrain_cwd(Path::new(cwd), &roots, home.as_deref(), &Jail::global());
    }
    if let Some(repo_id) = &opts.repo_id {
        let ws = slot.get()?.workspace_get().await?;
        let repo = ws.repos.iter().find(|r| &r.id == repo_id);
        return repo.map(|r| PathBuf::from(&r.path)).ok_or_else(|| EngineError::new(code::REPO_MISSING, format!("unknown repo {repo_id}")));
    }
    home.ok_or_else(|| EngineError::new(code::IO, "no start directory for the terminal"))
}

#[tauri::command]
pub async fn term_open(
    app: AppHandle,
    slot: State<'_, EngineSlot>,
    state: State<'_, TermState>,
    opts: TermOpenOptions,
    on_event: Channel<TermEvent>,
) -> Res<TermOpened> {
    switchhook::gate_check(&app)?;
    let cwd = start_dir(&slot, &opts).await?;
    let env: HashMap<String, String> = slot.get().map(Engine::login_env).unwrap_or_default();
    let spec = SpawnSpec { cwd, cols: opts.cols, rows: opts.rows, env, shell: None };
    let opened = state.0.open(spec, Box::new(move |e| drop(on_event.send(e))))?;
    state.1.open.lock().expect("terminals").insert(opened.term_id.clone(), TermMeta { pid: opened.pid, cwd: opened.cwd.to_string_lossy().into_owned() });
    Ok(TermOpened { term_id: opened.term_id, cwd: opened.cwd.to_string_lossy().into_owned(), shell: opened.shell })
}

#[tauri::command]
pub async fn term_write(state: State<'_, TermState>, term_id: String, data: String) -> Res<()> {
    state.0.write(&term_id, &data)
}

#[tauri::command]
pub async fn term_resize(state: State<'_, TermState>, term_id: String, cols: u16, rows: u16) -> Res<()> {
    state.0.resize(&term_id, cols, rows)
}

#[tauri::command]
pub async fn term_close(state: State<'_, TermState>, term_id: String) -> Res<()> {
    state.1.open.lock().expect("terminals").remove(&term_id);
    state.0.close(&term_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use intely_term::SpawnSpec;

    use super::*;

    fn state(record: Arc<dyn Fn(i32) + Send + Sync>) -> TermState {
        TermState::new(TermManager::new(Arc::new(Jail::off()), None), record)
    }

    fn open(state: &TermState, cwd: &Path) -> intely_term::Opened {
        let spec = SpawnSpec { cwd: cwd.to_path_buf(), cols: 80, rows: 24, env: HashMap::new(), shell: Some(PathBuf::from("/bin/sh")) };
        let opened = state.0.open(spec, Box::new(|_| {})).unwrap();
        state.1.open.lock().unwrap().insert(opened.term_id.clone(), TermMeta { pid: opened.pid, cwd: opened.cwd.to_string_lossy().into_owned() });
        opened
    }

    fn quiet() -> Arc<dyn Fn(i32) + Send + Sync> {
        Arc::new(|_| {})
    }

    #[test]
    fn stop_closes_every_shell_twice_is_harmless_and_new_terminals_open_afterwards() {
        let dir = tempfile::tempdir().unwrap();
        let st = state(quiet());
        let hook = st.hook();
        assert_eq!(hook.name(), "term");
        assert!(hook.busy().is_empty());
        let (a, b) = (open(&st, dir.path()), open(&st, dir.path()));
        let busy = hook.busy();
        assert_eq!((busy[0].kind.clone(), busy[0].count), (BusyKind::Terminal, 2));
        assert!(switchhook::group_alive(a.pid) && switchhook::group_alive(b.pid));

        let t = Instant::now();
        let warnings = tauri::async_runtime::block_on(hook.stop());
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
        assert!(hook.busy().is_empty() && st.0.open_ids().is_empty());
        assert!(!switchhook::group_alive(a.pid) && !switchhook::group_alive(b.pid));
        assert!(tauri::async_runtime::block_on(hook.stop()).is_empty(), "stop twice");

        let c = open(&st, dir.path());
        assert_eq!(hook.busy()[0].count, 1);
        st.0.close(&c.term_id);
    }

    #[test]
    fn a_shell_that_ignores_the_hangup_is_a_survivor() {
        let dir = tempfile::tempdir().unwrap();
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let r = recorded.clone();
        let st = state(Arc::new(move |pgid| r.lock().unwrap().push(pgid)));
        let t = open(&st, dir.path());
        // a background job in its own group (an interactive shell would make one) that ignores HUP and TERM
        let marker = dir.path().join("job.pid");
        st.0.write(&t.term_id, &format!("(trap '' HUP TERM; echo $$ > {}; exec sleep 60) &\n", marker.display())).unwrap();
        switchhook::wait_until(Duration::from_secs(10), Duration::from_millis(50), || marker.exists());
        // the manager also kills with SIGKILL after its own grace; we only look at what is still there right after
        let left = close_all(&st.0, &st.1, Duration::from_millis(100));
        for s in &left {
            assert_eq!((s.kind.clone(), s.cwd.clone()), (SurvivorKind::Terminal, dir.path().canonicalize().unwrap().to_string_lossy().into_owned()));
        }
        // whatever the timing: the survivors list and the registry agree, and kill_survivor only accepts listed pids
        assert_eq!(st.hook().survivors().len(), left.len());
        assert_eq!(recorded.lock().unwrap().len(), left.len());
        assert!(!st.hook().kill_survivor(u32::MAX));
        for s in left {
            assert!(st.hook().kill_survivor(s.pid));
            switchhook::wait_until(Duration::from_secs(5), Duration::from_millis(50), || !switchhook::group_alive(s.pid as i32));
        }
        assert!(st.hook().survivors().is_empty());
    }

    #[test]
    fn a_terminal_may_only_start_inside_the_workspace_the_home_folder_or_the_fixture() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let (repo, home, elsewhere) = (root.join("repo"), root.join("home"), root.join("elsewhere"));
        for d in [&repo, &home, &elsewhere, &repo.join("sub")] {
            std::fs::create_dir_all(d).unwrap();
        }
        let jail = Jail::off();
        let roots = vec![repo.clone()];
        assert_eq!(constrain_cwd(&repo.join("sub"), &roots, Some(&home), &jail).unwrap(), repo.join("sub"));
        assert!(constrain_cwd(&home, &roots, Some(&home), &jail).is_ok());
        for bad in [Path::new("/"), Path::new("/etc"), Path::new("/private/etc"), &elsewhere, &repo.join(".."), Path::new("/nonexistent-dir")] {
            let e = constrain_cwd(bad, &roots, Some(&home), &jail).unwrap_err();
            assert_eq!(e.code, code::PATH_NOT_VALIDATED, "{bad:?}");
        }
        // a symlink inside the repo that points out is judged by where it leads
        std::os::unix::fs::symlink(&elsewhere, repo.join("escape")).unwrap();
        assert!(constrain_cwd(&repo.join("escape"), &roots, Some(&home), &jail).is_err());
        // a HOME of "/" would allow everything: refused
        assert!(constrain_cwd(Path::new("/etc"), &roots, Some(Path::new("/")), &jail).is_err());
        // the test jail's fixture root counts
        let e2e = Jail::e2e(&elsewhere);
        assert!(constrain_cwd(&elsewhere, &[], None, &e2e).is_ok());
        assert!(constrain_cwd(&home, &[], None, &e2e).is_err());
    }

    #[test]
    fn the_gate_refuses_a_terminal_while_a_switch_is_under_way() {
        use super::super::switchhook::{check_optional, testing::FakeClock, SwitchGate};
        let clock = FakeClock::new();
        let gate = SwitchGate::new(Arc::new(clock));
        assert!(check_optional(Some(&gate)).is_ok() && check_optional(None).is_ok());
        gate.set().hold();
        assert_eq!(check_optional(Some(&gate)).unwrap_err().code, code::WORKSPACE_SWITCHING);
    }
}
