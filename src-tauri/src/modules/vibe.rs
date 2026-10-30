//! Tauri glue of the vibe coder toolkit: the secret masker for text that goes into an agent prompt ("Fix with agent"),
//! the Setup doctor's tool probes and the "What this run will be told" plan of the Project notes panel. All three only
//! read: nothing is written, started in a repository or sent anywhere.

use std::path::PathBuf;

use intely_core::EngineError;
use intely_files::claude_notes::{self, NotesPlan};
use intely_gitx::setup::{self, SetupCheck, SetupOpts};
use tauri::{AppHandle, Manager, State};

use crate::agents::{blocking, repos};
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

/// Text with every secret shape masked: the Run panel's masker, then the secret scanner's redaction (the same pair the
/// run index uses). The webview calls it before an error log becomes part of a prompt.
#[tauri::command]
pub async fn vibe_mask_text(text: String) -> Res<String> {
    // a large text takes a moment: never on the main thread
    blocking(move || Ok(intely_runindex::doc::scrub(&text))).await
}

fn login_env(engine: &EngineSlot) -> std::collections::HashMap<String, String> {
    engine.get().ok().map(|e| e.login_env()).unwrap_or_else(|| std::env::vars().collect())
}

/// The setup probes on the login-shell PATH (each with a deadline).
#[tauri::command]
pub async fn vibe_setup_checks(engine: State<'_, EngineSlot>) -> Res<Vec<SetupCheck>> {
    let env = login_env(&engine);
    let opts = SetupOpts { login_path: env.get("PATH").cloned().or_else(|| std::env::var("PATH").ok()).unwrap_or_default(), env };
    blocking(move || Ok(setup::run(&opts))).await
}

/// The CLAUDE.md files a Claude run on these repositories (in this order) would be told, with the user's global file
/// when `agents.includeUserMemory` is on. Mirrors the sidecar (see `intely_files::claude_notes`).
#[tauri::command]
pub async fn vibe_project_notes(app: AppHandle, engine: State<'_, EngineSlot>, repo_ids: Vec<String>) -> Res<NotesPlan> {
    let all = repos(&engine).await?;
    let dirs: Vec<PathBuf> = repo_ids.iter().filter_map(|id| all.iter().find(|r| &r.id == id).map(|r| r.path.clone())).collect();
    let include_user = app
        .try_state::<crate::modules::settings::SettingsState>()
        .and_then(|s| s.parts())
        .map(|(store, _)| intely_settings::agents::include_user_memory_in(&store.get("agents").unwrap_or_default()))
        .unwrap_or(true);
    let env = login_env(&engine);
    let home = env.get("HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(PathBuf::from));
    let user_dir = include_user.then(|| claude_notes::claude_config_dir(env.get("CLAUDE_CONFIG_DIR").map(String::as_str), home.as_deref())).flatten();
    blocking(move || Ok(claude_notes::plan(&dirs, user_dir.as_deref()))).await
}
