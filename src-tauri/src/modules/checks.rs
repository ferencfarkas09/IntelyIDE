//! Tauri glue of the Wave 3 X2 extras on top of `intely_checks`: pre-commit checks (#18), env and secret awareness
//! (#19), branch hygiene (#20) and the worktree manager (#21). Reads are plain commands; every mutation (delete a
//! branch, create or remove an IDE worktree) goes through the jail inside the crate and needs the name typed in
//! `confirm`. Checks start processes, so they use the run module's "Allow processes" rule. The webview sends repo ids,
//! check ids and repo-relative paths, never a command line.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use intely_checks::discover;
use intely_checks::envnames;
use intely_checks::hygiene::{self, DEFAULT_STALE_DAYS};
use intely_checks::runner::{CheckRunner, CheckSink};
use intely_checks::secrets::scan_paths;
use intely_checks::types::{CheckInfo, CheckRun, CheckStatus, EnvReport, Hygiene, LogChunk, SecretScan, WorktreeRow};
use intely_checks::worktrees::{CreateRequest, WorktreeStore};
use intely_core::jail::Jail;
use intely_core::{code, BusyItem, BusyKind, Engine, EngineError, SwitchWarning};
use intely_runner::types::ProcessAccess;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agents::blocking;
use crate::commands::EngineSlot;
use crate::modules::runner::RunState;
use crate::modules::switchhook::{self, BoxFuture, SwitchHook};

type Res<T> = Result<T, EngineError>;

pub struct ChecksState {
    runner: Arc<CheckRunner>,
    worktrees: Arc<WorktreeStore>,
}

impl ChecksState {
    /// The `SwitchHook` of the pre-commit checks.
    pub fn hook(&self) -> Arc<dyn SwitchHook> {
        Arc::new(ChecksHook { runner: self.runner.clone() })
    }
}

/// `Some(hook)` once `setup` ran.
pub fn hook(app: &AppHandle) -> Option<Arc<dyn SwitchHook>> {
    app.try_state::<ChecksState>().map(|s| s.hook())
}

struct ChecksHook {
    runner: Arc<CheckRunner>,
}

/// How long `stop` waits for the checks to leave before it names the subsystem as stuck (the budget is 1 s).
const STOP_WAIT: Duration = Duration::from_millis(850);

fn running(runner: &CheckRunner) -> Vec<CheckRun> {
    runner.list().into_iter().filter(|r| r.status == CheckStatus::Running).collect()
}

impl SwitchHook for ChecksHook {
    fn name(&self) -> &'static str {
        "checks"
    }

    fn busy(&self) -> Vec<BusyItem> {
        let labels: Vec<String> = running(&self.runner).into_iter().map(|r| r.id).collect();
        if labels.is_empty() {
            return Vec::new();
        }
        vec![BusyItem { kind: BusyKind::Check, count: labels.len() as u32, labels }]
    }

    fn stop(&self) -> BoxFuture<'_, Vec<SwitchWarning>> {
        let runner = self.runner.clone();
        Box::pin(async move {
            let left = switchhook::blocking(move || {
                // A check that was only just started has no process group to signal yet (the runner records it a moment
                // after the spawn): ask again until it is gone or the time is up.
                let step = STOP_WAIT / 3;
                !(0..3).any(|_| {
                    runner.shutdown();
                    switchhook::wait_until(step, Duration::from_millis(30), || running(&runner).is_empty())
                })
            })
            .await;
            if left == Some(false) {
                Vec::new()
            } else {
                vec![switchhook::stuck("checks")]
            }
        })
    }
}

/// `checks:state` carries a full `CheckRun`, `checks:log` a batch of masked and redacted lines.
struct TauriSink(AppHandle);

impl CheckSink for TauriSink {
    fn state(&self, run: CheckRun) {
        let _ = self.0.emit("checks:state", run);
    }
    fn log(&self, chunk: LogChunk) {
        let _ = self.0.emit("checks:log", chunk);
    }
}

/// Called once from `setup` (wave3 X2 state marker).
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = std::env::var_os("INTELY_DATA_DIR")
        .map(PathBuf::from)
        .or_else(intely_agent_core::events::log::JsonlEventLog::default_base_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    let runner = CheckRunner::new(Jail::global(), Arc::new(TauriSink(app.handle().clone())));
    app.manage(ChecksState { runner, worktrees: Arc::new(WorktreeStore::new(&data_dir)) });
    Ok(())
}

/// App exit: no check outlives the IDE.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<ChecksState>() {
        state.runner.shutdown();
    }
}

struct RepoCtx {
    path: PathBuf,
    patterns: Vec<String>,
}

async fn repo_ctx(slot: &EngineSlot, repo_id: &str) -> Res<RepoCtx> {
    // the live patterns every workspace holding this repository knows (I7)
    let ws = slot.get()?.effective_workspace().await?;
    let path = ws.repos.iter().find(|r| r.id == repo_id).map(|r| PathBuf::from(&r.path)).ok_or_else(|| EngineError::new(code::REPO_MISSING, format!("unknown repo {repo_id}")))?;
    let mut patterns = ws.protected_branches.clone();
    patterns.extend(ws.live_branches.get(repo_id).into_iter().flatten().cloned());
    Ok(RepoCtx { path, patterns })
}

// ---- checks ----------------------------------------------------------------------------------------------------

/// What the jail says about starting a check in this repo right now (the Settings > Safety switch included).
#[tauri::command]
pub async fn checks_access(slot: State<'_, EngineSlot>, checks: State<'_, ChecksState>, run: State<'_, RunState>, repo_id: Option<String>) -> Res<ProcessAccess> {
    let path = match repo_id {
        Some(id) => Some(repo_ctx(&slot, &id).await?.path),
        None => None,
    };
    Ok(checks.runner.access(run.0.allow_processes(), path.as_deref()))
}

#[tauri::command]
pub async fn checks_discover(slot: State<'_, EngineSlot>, repo_id: String, changed: Vec<String>) -> Res<Vec<CheckInfo>> {
    let ctx = repo_ctx(&slot, &repo_id).await?;
    blocking(move || Ok(discover::discover(&repo_id, &ctx.path, &changed).into_iter().map(|p| p.info).collect())).await
}

#[tauri::command]
pub async fn checks_start(app: AppHandle, slot: State<'_, EngineSlot>, checks: State<'_, ChecksState>, run: State<'_, RunState>, repo_id: String, check_id: String, changed: Vec<String>) -> Res<CheckRun> {
    switchhook::gate_check(&app)?;
    let ctx = repo_ctx(&slot, &repo_id).await?;
    let env: HashMap<String, String> = slot.get().map(Engine::login_env).unwrap_or_default();
    let allowed = run.0.allow_processes();
    let runner = checks.runner.clone();
    blocking(move || {
        let planned = discover::find(&repo_id, &ctx.path, &check_id, &changed).ok_or_else(|| EngineError::new("unknownCheck", format!("{check_id} is not offered for this repo")))?;
        runner.start(&repo_id, &ctx.path, &planned, allowed, env)
    })
    .await
}

#[tauri::command]
pub async fn checks_stop(checks: State<'_, ChecksState>, run_id: String) -> Res<()> {
    checks.runner.stop(&run_id)
}

#[tauri::command]
pub async fn checks_list(checks: State<'_, ChecksState>) -> Res<Vec<CheckRun>> {
    Ok(checks.runner.list())
}

#[tauri::command]
pub async fn checks_logs(checks: State<'_, ChecksState>, run_id: String, from_seq: u32) -> Res<LogChunk> {
    checks.runner.logs(&run_id, from_seq)
}

#[tauri::command]
pub async fn checks_dismiss(checks: State<'_, ChecksState>, run_id: String) -> Res<()> {
    checks.runner.dismiss(&run_id);
    Ok(())
}

// ---- env and secret awareness ----------------------------------------------------------------------------------

/// The secret-shape scan of what committing `paths` would add. Findings carry redacted previews only.
#[tauri::command]
pub async fn secrets_scan(slot: State<'_, EngineSlot>, repo_id: String, paths: Vec<String>) -> Res<SecretScan> {
    let ctx = repo_ctx(&slot, &repo_id).await?;
    blocking(move || scan_paths(&Jail::global(), &repo_id, &ctx.path, &paths)).await
}

/// Variable NAMES per repo and across repos. Values and real `.env` files are never read.
#[tauri::command]
pub async fn env_report(slot: State<'_, EngineSlot>) -> Res<EnvReport> {
    let ws = slot.get()?.workspace_get().await?;
    let repos: Vec<(String, PathBuf)> = ws.repos.iter().map(|r| (r.id.clone(), PathBuf::from(&r.path))).collect();
    blocking(move || Ok(envnames::analyze(&repos))).await
}

// ---- branch hygiene --------------------------------------------------------------------------------------------

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

#[tauri::command]
pub async fn hygiene_report(slot: State<'_, EngineSlot>, repo_id: String, stale_days: Option<u32>) -> Res<Hygiene> {
    let ctx = repo_ctx(&slot, &repo_id).await?;
    blocking(move || hygiene::report(&Jail::global(), &repo_id, &ctx.path, &ctx.patterns, stale_days.unwrap_or(DEFAULT_STALE_DAYS).clamp(1, 3650), now())).await
}

#[tauri::command]
pub async fn hygiene_delete_branch(slot: State<'_, EngineSlot>, repo_id: String, name: String, confirm: String) -> Res<String> {
    let ctx = repo_ctx(&slot, &repo_id).await?;
    blocking(move || hygiene::delete_branch(&Jail::global(), &ctx.path, &name, &ctx.patterns, &confirm)).await
}

// ---- worktrees -------------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn worktrees_list(slot: State<'_, EngineSlot>, checks: State<'_, ChecksState>, repo_id: String) -> Res<Vec<WorktreeRow>> {
    let ctx = repo_ctx(&slot, &repo_id).await?;
    let store = checks.worktrees.clone();
    blocking(move || store.list(&Jail::global(), &repo_id, &ctx.path)).await
}

#[tauri::command]
pub async fn worktrees_create(slot: State<'_, EngineSlot>, checks: State<'_, ChecksState>, repo_id: String, name: String, base: Option<String>, run_id: Option<String>, confirm: String) -> Res<WorktreeRow> {
    let ctx = repo_ctx(&slot, &repo_id).await?;
    let store = checks.worktrees.clone();
    blocking(move || store.create(&Jail::global(), &repo_id, &ctx.path, &CreateRequest { name, base, run_id, confirm })).await
}

#[tauri::command]
pub async fn worktrees_remove(slot: State<'_, EngineSlot>, checks: State<'_, ChecksState>, repo_id: String, path: String, confirm: String) -> Res<String> {
    let ctx = repo_ctx(&slot, &repo_id).await?;
    let store = checks.worktrees.clone();
    // The path is only a lookup key into the IDE's own record; it is never used unless that record matches.
    blocking(move || store.remove(&Jail::global(), &repo_id, &ctx.path, &path, &confirm)).await
}

#[cfg(test)]
mod tests {
    use intely_checks::discover::Planned;
    use intely_checks::types::CheckInfo;

    use super::*;

    struct Quiet;
    impl CheckSink for Quiet {
        fn state(&self, _: CheckRun) {}
        fn log(&self, _: LogChunk) {}
    }

    fn sh(script: &str) -> Planned {
        Planned {
            info: CheckInfo { id: "t".into(), label: "T".into(), kind: "lint".into(), runner: "sh".into(), file_count: 0, disabled: None, note: None },
            commands: vec![vec!["sh".into(), "-c".into(), script.into()]],
        }
    }

    #[test]
    fn stop_ends_a_running_check_twice_is_harmless_and_the_runner_is_reusable() {
        let dir = tempfile::tempdir().unwrap();
        let state = ChecksState { runner: CheckRunner::new(Arc::new(Jail::off()), Arc::new(Quiet)), worktrees: Arc::new(WorktreeStore::new(dir.path())) };
        let hook = state.hook();
        assert_eq!(hook.name(), "checks");
        assert!(hook.busy().is_empty());
        state.runner.start("fx", dir.path(), &sh("sleep 30"), false, HashMap::new()).unwrap();
        let busy = hook.busy();
        assert_eq!((busy[0].kind.clone(), busy[0].count, busy[0].labels.clone()), (BusyKind::Check, 1, vec!["fx:t".to_owned()]));

        let warnings = tauri::async_runtime::block_on(hook.stop());
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(hook.busy().is_empty());
        assert_eq!(state.runner.list()[0].status, CheckStatus::Stopped);
        assert!(tauri::async_runtime::block_on(hook.stop()).is_empty(), "stop twice");

        // reusable: the same check starts again and is stopped again
        state.runner.start("fx", dir.path(), &sh("sleep 30"), false, HashMap::new()).unwrap();
        assert_eq!(hook.busy()[0].count, 1);
        assert!(tauri::async_runtime::block_on(hook.stop()).is_empty());
    }
}
