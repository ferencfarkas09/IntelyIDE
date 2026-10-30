//! Tauri glue of the Mobile health panel on top of `intely_mobilehealth`. Both commands only read: no process is started, nothing
//! is written, and the repository's files are opened without following links (see the crate).

use intely_mobilehealth::{detect, scan, Report};
use intely_core::EngineError;
use serde::Serialize;
use tauri::State;

use crate::agents::{blocking, repos};
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoHealth {
    repo_id: String,
    #[serde(flatten)]
    report: Report,
}

/// The ids of the repositories that hold an iOS or Android project. Cheap: it only looks at folder names.
#[tauri::command]
pub async fn mobilehealth_detect(engine: State<'_, EngineSlot>) -> Res<Vec<String>> {
    let all = repos(&engine).await?;
    blocking(move || Ok(all.into_iter().filter(|r| detect(&r.path)).map(|r| r.id).collect())).await
}

/// The health report of one repository, or nothing when it holds no mobile project. One repository per call, on the blocking pool,
/// so a very large or hostile repository cannot hold up the others; the scan also stops by itself after a few seconds and says so.
#[tauri::command]
pub async fn mobilehealth_scan_repo(engine: State<'_, EngineSlot>, repo_id: String) -> Res<Option<RepoHealth>> {
    let root = repos(&engine).await?.into_iter().find(|r| r.id == repo_id).map(|r| r.path).ok_or_else(|| EngineError::new("notFound", format!("unknown repository {repo_id}")))?;
    blocking(move || {
        let report = scan(&root);
        Ok(report.detected.then_some(RepoHealth { repo_id, report }))
    })
    .await
}
