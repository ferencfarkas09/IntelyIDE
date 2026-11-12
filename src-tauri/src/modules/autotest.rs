//! Tauri glue of "Auto-test after a run" on top of `intely_runner::autotest`. `autotest_pick` only reads the manifests;
//! `autotest_start` picks again here (the webview never names a script) and starts it through the Run panel's manager,
//! so the same jail, masking, process-group kill and `run:state` / `run:log` events apply. `CI=1` makes Vitest and Jest
//! run once instead of watching; `confirmed` stays false, so a script that needs a confirmation is refused.
//! The process starts with an empty environment plus `autotest::unattended_env` (no `SSH_AUTH_SOCK`, no tokens), and
//! only when the fingerprint the person trusted still matches what the repository runs now.

use std::collections::HashMap;
use std::path::PathBuf;

use intely_core::{code, Engine, EngineError};
use intely_runner::autotest::{pick, unattended_env, TestPick};
use intely_runner::types::ServerInfo;
use intely_runner::StartOpts;
use tauri::{AppHandle, State};

use super::runner::RunState;
use super::switchhook;
use crate::agents::{blocking, repos};
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

async fn repo_path(engine: &EngineSlot, repo_id: &str) -> Res<PathBuf> {
    repos(engine).await?.into_iter().find(|r| r.id == repo_id).map(|r| r.path).ok_or_else(|| EngineError::new(code::REPO_MISSING, format!("unknown repo {repo_id}")))
}

/// The unit-test command of one repository, or `null` when nothing safe qualifies.
#[tauri::command]
pub async fn autotest_pick(engine: State<'_, EngineSlot>, repo_id: String) -> Res<Option<TestPick>> {
    let path = repo_path(&engine, &repo_id).await?;
    blocking(move || Ok(pick(&path))).await
}

/// Starts the repository's unit tests (picked again here) as a Run panel process. Refused with `noTests` when the
/// repository has none, with `changed` when what it runs is no longer what the person trusted (`fingerprint` of the
/// pick they saw), and with the manager's codes (`readOnly`, `alreadyRunning`, ...) otherwise.
#[tauri::command]
pub async fn autotest_start(app: AppHandle, engine: State<'_, EngineSlot>, state: State<'_, RunState>, repo_id: String, fingerprint: String) -> Res<ServerInfo> {
    switchhook::gate_check(&app)?;
    let path = repo_path(&engine, &repo_id).await?;
    let p = path.clone();
    let chosen = blocking(move || Ok(pick(&p))).await?.ok_or_else(|| EngineError::new("noTests", format!("no unit-test command found in {repo_id}")))?;
    if chosen.fingerprint != fingerprint {
        return Err(EngineError::new("changed", format!("the test command of {repo_id} changed since it was trusted: {}", chosen.runner)));
    }
    let login: HashMap<String, String> = engine.get().map(Engine::login_env).unwrap_or_default();
    let mut env = unattended_env(&login);
    env.insert("CI".to_owned(), "1".to_owned());
    let info = state.0.start(&repo_id, &path, &chosen.script, StartOpts { confirmed: false, allow_second_heavy: false, env, clean_env: true })?;
    // like `run_start`: the Run panel knows where the process was started (a survivor of a workspace switch names its folder)
    state.1.cwds.lock().expect("cwds").insert(info.id.clone(), path);
    Ok(info)
}
