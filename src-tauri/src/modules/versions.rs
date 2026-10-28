//! Tauri glue of the Versions panel on top of `intely_versions`. `versions_scan` and `versions_plan` only read.
//! `versions_apply` writes the version lines of one repository after the jail said yes; nothing here commits, tags
//! or pushes, so the changes show up in the Changes tab like any other edit.

use intely_core::jail::Jail;
use intely_core::EngineError;
use intely_versions::{apply, plan, scan, Change, FilePlan, Scan};
use serde::Serialize;
use tauri::State;

use crate::agents::{blocking, repos};
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoVersions {
    repo_id: String,
    #[serde(flatten)]
    scan: Scan,
}

async fn repo_path(engine: &EngineSlot, repo_id: &str) -> Res<std::path::PathBuf> {
    repos(engine).await?.into_iter().find(|r| r.id == repo_id).map(|r| r.path).ok_or_else(|| EngineError::new("notFound", format!("unknown repository {repo_id}")))
}

/// The version fields of every repository of the workspace.
#[tauri::command]
pub async fn versions_scan(engine: State<'_, EngineSlot>) -> Res<Vec<RepoVersions>> {
    let all = repos(&engine).await?;
    blocking(move || Ok(all.into_iter().map(|r| RepoVersions { scan: scan(&r.path), repo_id: r.id }).collect())).await
}

/// The diff the changes would make; nothing is written.
#[tauri::command]
pub async fn versions_plan(engine: State<'_, EngineSlot>, repo_id: String, changes: Vec<Change>) -> Res<Vec<FilePlan>> {
    let root = repo_path(&engine, &repo_id).await?;
    blocking(move || plan(&root, &changes).map_err(|e| EngineError::new(e.code, e.message))).await
}

/// Writes the changes of one repository (all or nothing) and returns the files written.
#[tauri::command]
pub async fn versions_apply(engine: State<'_, EngineSlot>, repo_id: String, changes: Vec<Change>) -> Res<Vec<String>> {
    let root = repo_path(&engine, &repo_id).await?;
    Jail::global().check_op("versions_apply", &root)?;
    blocking(move || apply(&root, &changes).map_err(|e| EngineError::new(e.code, e.message))).await
}
