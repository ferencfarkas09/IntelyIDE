//! Tauri glue of the React Native / Expo device loop on top of `intely_devices`. Metro and the native app builds are NOT
//! started here: they are `package.json` scripts and go through the Run panel's `run_start` (ports, memory, masking, the
//! confirmation for builds). What this module starts are short device calls (`xcrun simctl`, `adb`, `emulator`) and the
//! two log streams, all behind the same "Allow processes" jail check, and one loopback `GET /reload`.
//! Nothing here is reachable from an agent; every command is a button.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use intely_core::{code, Engine, EngineError};
use intely_devices::types::{DeviceList, LogChunk, ProjectInfo};
use intely_devices::{Devices, LogHub, LogTarget, Tools};
use intely_runner::types::ServerStatus;
use tauri::{Manager, State};

use super::runner::RunState;
use crate::agents::{blocking, repos};
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

pub struct DevicesState {
    devices: Arc<Devices>,
    hub: Arc<LogHub>,
}

/// Called once from `setup`, after the runner state exists (the "Allow processes" switch lives there).
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let run = app.state::<RunState>().0.clone();
    let allow: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || run.allow_processes());
    app.manage(DevicesState { devices: Arc::new(Devices::new(intely_core::jail::Jail::global(), allow)), hub: Arc::new(LogHub::new()) });
    Ok(())
}

/// App exit: no log stream outlives the IDE.
pub fn shutdown(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<DevicesState>() {
        state.hub.stop_all();
    }
}

async fn repo_path(engine: &EngineSlot, repo_id: &str) -> Res<PathBuf> {
    repos(engine).await?.into_iter().find(|r| r.id == repo_id).map(|r| r.path).ok_or_else(|| EngineError::new(code::REPO_MISSING, format!("unknown repository {repo_id}")))
}

fn login_env(engine: &EngineSlot, state: &DevicesState) -> HashMap<String, String> {
    state.devices.child_env(&engine.get().map(Engine::login_env).unwrap_or_default())
}

/// The tools come from the login `PATH` and the user's own SDK folders, never from a path a repository names.
fn tools_for(env: &HashMap<String, String>) -> Tools {
    let sdk = intely_devices::detect::android_sdk(intely_core::sys::home_dir().as_deref());
    Tools::find(env, sdk.as_deref())
}

/// The status card: `None` when the repository is not a React Native or Expo app. Only reads files.
#[tauri::command]
pub async fn devices_detect(engine: State<'_, EngineSlot>, repo_id: String) -> Res<Option<ProjectInfo>> {
    let path = repo_path(&engine, &repo_id).await?;
    blocking(move || Ok(intely_devices::detect(&path))).await
}

/// iOS simulators, Android emulators (AVDs) and connected Android devices, and which tools are missing.
#[tauri::command]
pub async fn devices_list(engine: State<'_, EngineSlot>, state: State<'_, DevicesState>, repo_id: String) -> Res<DeviceList> {
    let path = repo_path(&engine, &repo_id).await?;
    let env = login_env(&engine, &state);
    let devices = state.devices.clone();
    blocking(move || {
        let tools = tools_for(&env);
        devices.list(&path, &tools, &env)
    })
    .await
}

/// Boots an iOS simulator (`kind` "ios", `id` the UDID) or an Android emulator (`kind` "android", `id` the AVD name).
#[tauri::command]
pub async fn devices_boot(engine: State<'_, EngineSlot>, state: State<'_, DevicesState>, repo_id: String, kind: String, id: String) -> Res<()> {
    let path = repo_path(&engine, &repo_id).await?;
    let env = login_env(&engine, &state);
    let devices = state.devices.clone();
    blocking(move || {
        let tools = tools_for(&env);
        match kind.as_str() {
            "ios" => devices.boot_simulator(&path, &tools, &env, &id),
            "android" => devices.boot_avd(&path, &tools, &env, &id),
            _ => Err(EngineError::new("invalidDevice", "unknown device kind")),
        }
    })
    .await
}

/// Shuts down an iOS simulator (`kind` "ios", the UDID) or an Android emulator (`kind` "android", the adb serial).
#[tauri::command]
pub async fn devices_shutdown(engine: State<'_, EngineSlot>, state: State<'_, DevicesState>, repo_id: String, kind: String, id: String) -> Res<()> {
    let path = repo_path(&engine, &repo_id).await?;
    let env = login_env(&engine, &state);
    let devices = state.devices.clone();
    blocking(move || {
        let tools = tools_for(&env);
        match kind.as_str() {
            "ios" => devices.shutdown_simulator(&path, &tools, &env, &id),
            "android" => devices.shutdown_android(&path, &tools, &env, &id),
            _ => Err(EngineError::new("invalidDevice", "unknown device kind")),
        }
    })
    .await
}

/// Starts the log stream of `platform` ("ios" or "android"); `device` is a simulator UDID or an adb serial, or absent for
/// the booted simulator / the only Android device. The iOS predicate names the app's process (from the Xcode project).
#[tauri::command]
pub async fn devices_log_start(engine: State<'_, EngineSlot>, state: State<'_, DevicesState>, repo_id: String, platform: String, device: Option<String>) -> Res<()> {
    let path = repo_path(&engine, &repo_id).await?;
    let env = login_env(&engine, &state);
    let (devices, hub) = (state.devices.clone(), state.hub.clone());
    blocking(move || {
        let tools = tools_for(&env);
        let target = match platform.as_str() {
            "ios" => LogTarget::Ios { udid: device, process: intely_devices::detect(&path).and_then(|p| p.ios_process) },
            "android" => LogTarget::Android { serial: device },
            _ => return Err(EngineError::new("invalidDevice", "unknown platform")),
        };
        hub.start(&devices, &path, &tools, &env, &target)
    })
    .await
}

#[tauri::command]
pub async fn devices_log_stop(state: State<'_, DevicesState>, platform: String) -> Res<()> {
    state.hub.stop(&platform);
    Ok(())
}

#[tauri::command]
pub async fn devices_log_clear(state: State<'_, DevicesState>, platform: String) -> Res<()> {
    state.hub.clear(&platform);
    Ok(())
}

/// Masked lines of the stream with `seq >= from_seq`.
#[tauri::command]
pub async fn devices_logs(state: State<'_, DevicesState>, platform: String, from_seq: u32) -> Res<LogChunk> {
    Ok(state.hub.chunk(&platform, from_seq))
}

/// Asks the running Metro server (a dev server the Run panel started) to reload the app. The port is neither what the webview
/// says nor what the script printed: it is a port `lsof` found listening in the server's process tree AND one Metro is
/// configured for (8081, 19000, the `--port` of the start script, `RCT_METRO_PORT`). A script that prints some other port
/// cannot aim the one request at it.
#[tauri::command]
pub async fn devices_reload(engine: State<'_, EngineSlot>, run: State<'_, RunState>, server_id: String) -> Res<()> {
    let unknown = || EngineError::new("unknownServer", "that dev server is not running");
    let info = run.0.list().into_iter().find(|s| s.id == server_id).ok_or_else(unknown)?;
    if !matches!(info.status, ServerStatus::Running | ServerStatus::Starting) {
        return Err(unknown());
    }
    let root = repo_path(&engine, &info.repo_id).await?;
    let env_port = engine.get().map(Engine::login_env).ok().and_then(|e| e.get("RCT_METRO_PORT").cloned());
    let script = info.script.strip_prefix("npm:").unwrap_or(&info.script).to_owned();
    let confirmed = run.0.confirmed_ports(&server_id);
    blocking(move || {
        let allowed = intely_devices::detect::metro_ports(&root, &script, env_port.as_deref());
        let port = confirmed.into_iter().find(|p| allowed.contains(p)).ok_or_else(|| EngineError::new("noPort", "Metro is not confirmed to listen on its port yet"))?;
        intely_devices::net::reload(port)
    })
    .await
}
