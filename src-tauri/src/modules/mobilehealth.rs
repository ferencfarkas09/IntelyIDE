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

/// The health report of every repository of the workspace that holds a mobile project.
#[tauri::command]
pub async fn mobilehealth_scan(engine: State<'_, EngineSlot>) -> Res<Vec<RepoHealth>> {
    let all = repos(&engine).await?;
    blocking(move || {
        Ok(all
            .into_iter()
            .filter_map(|r| {
                let report = scan(&r.path);
                report.detected.then_some(RepoHealth { repo_id: r.id, report })
            })
            .collect())
    })
    .await
}
