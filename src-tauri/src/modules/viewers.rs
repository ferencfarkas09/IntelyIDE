//! Tauri glue of the viewers (wave3 X3, ideas #25/#26): ranged byte reads for large logs, JSON, images and PDFs. The rules
//! (repo-relative path, no `.git`, no symlink escape, guarded files refused) live in `intely_hud::viewer`.

use std::path::PathBuf;

use intely_core::EngineError;
use intely_hud::viewer::{self, Range, Stat, ViewerError};
use tauri::State;

use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

fn to_engine(e: ViewerError) -> EngineError {
    EngineError::new(e.code, e.message)
}

async fn root(engine: &State<'_, EngineSlot>, repo_id: &str) -> Res<PathBuf> {
    let ws = engine.get()?.workspace_get().await?;
    ws.repos
        .iter()
        .find(|r| r.id == repo_id)
        .map(|r| PathBuf::from(&r.path))
        .ok_or_else(|| EngineError::new(intely_core::code::NOT_A_REPO, format!("unknown repository {repo_id}")))
}

#[tauri::command]
pub async fn viewers_stat(engine: State<'_, EngineSlot>, repo_id: String, rel_path: String) -> Res<Stat> {
    let root = root(&engine, &repo_id).await?;
    tauri::async_runtime::spawn_blocking(move || viewer::stat(&root, &rel_path).map_err(to_engine))
        .await
        .map_err(|e| EngineError::new("internal", e.to_string()))?
}

#[tauri::command]
pub async fn viewers_read_range(engine: State<'_, EngineSlot>, repo_id: String, rel_path: String, offset: f64, len: f64) -> Res<Range> {
    let root = root(&engine, &repo_id).await?;
    tauri::async_runtime::spawn_blocking(move || viewer::read_range(&root, &rel_path, offset.max(0.0) as u64, len.max(0.0) as u64).map_err(to_engine))
        .await
        .map_err(|e| EngineError::new("internal", e.to_string()))?
}

/// Opens the file in the system's default app (a PDF in Preview). The path is the canonical, guard-checked one, so it always
/// starts with `/` and cannot be read as an option. Refused under the E2E jail so a test never opens a desktop app.
#[tauri::command]
pub async fn viewers_open_external(engine: State<'_, EngineSlot>, repo_id: String, rel_path: String) -> Res<()> {
    if std::env::var("INTELY_E2E").is_ok_and(|v| v == "1") {
        return Err(EngineError::new("testJail", "opening external apps is disabled in the E2E jail"));
    }
    let root = root(&engine, &repo_id).await?;
    let full = viewer::resolve(&root, &rel_path).map_err(to_engine)?;
    std::process::Command::new("/usr/bin/open").arg(full).spawn().map(drop).map_err(|e| EngineError::new("io", e.to_string()))
}
