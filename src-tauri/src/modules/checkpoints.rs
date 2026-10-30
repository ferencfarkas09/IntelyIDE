//! Tauri glue of run checkpoints (docs/checkpoints.md): the `checkpoints_*` commands on top of the agent host's checkpoint API
//! (`crates/agent_host/src/host/checkpoints.rs`). Every restore needs `confirm: true` from the typed confirmation of the dialog.

use intely_agent_host::{CheckpointFileDiff, CheckpointSettings, ConfigCopy, RepoCheckpointPlan, RepoCheckpointRestore, RunCheckpoint};
use intely_core::EngineError;
use tauri::State;

use crate::agents::blocking;
use crate::modules::roles::RolesSlot;

type Res<T> = Result<T, EngineError>;

#[tauri::command]
pub async fn checkpoints_list(slot: State<'_, RolesSlot>, run_id: String) -> Res<Vec<RunCheckpoint>> {
    let sup = slot.supervisor().clone();
    blocking(move || sup.host().checkpoints(&run_id)).await
}

#[tauri::command]
pub async fn checkpoints_save(slot: State<'_, RolesSlot>, run_id: String, label: String) -> Res<u32> {
    let sup = slot.supervisor().clone();
    blocking(move || sup.host().save_point(&run_id, &label)).await
}

#[tauri::command]
pub async fn checkpoints_plan(slot: State<'_, RolesSlot>, run_id: String, seq: u32) -> Res<Vec<RepoCheckpointPlan>> {
    let sup = slot.supervisor().clone();
    blocking(move || sup.host().checkpoint_plan(&run_id, seq)).await
}

/// Refuses (`confirmRequired`) unless `confirm` is true; files edited after the newest checkpoint are kept unless `overwrite_conflicts`.
#[tauri::command]
pub async fn checkpoints_restore(slot: State<'_, RolesSlot>, run_id: String, seq: u32, confirm: bool, overwrite_conflicts: bool) -> Res<Vec<RepoCheckpointRestore>> {
    let sup = slot.supervisor().clone();
    blocking(move || sup.host().checkpoint_restore(&run_id, seq, confirm, overwrite_conflicts)).await
}

#[tauri::command]
pub async fn checkpoints_compare(slot: State<'_, RolesSlot>, run_id: String, repo_id: String, from: u32, to: Option<u32>) -> Res<Vec<CheckpointFileDiff>> {
    let sup = slot.supervisor().clone();
    blocking(move || sup.host().checkpoint_compare(&run_id, &repo_id, from, to)).await
}

#[tauri::command]
pub async fn checkpoints_patch(slot: State<'_, RolesSlot>, run_id: String, repo_id: String, from: u32, to: Option<u32>, path: String) -> Res<String> {
    let sup = slot.supervisor().clone();
    blocking(move || sup.host().checkpoint_patch(&run_id, &repo_id, from, to, &path)).await
}

#[tauri::command]
pub async fn checkpoints_settings(slot: State<'_, RolesSlot>) -> Res<CheckpointSettings> {
    let sup = slot.supervisor().clone();
    blocking(move || Ok(sup.host().checkpoint_settings())).await
}

#[tauri::command]
pub async fn checkpoints_set_protect_config(slot: State<'_, RolesSlot>, on: bool) -> Res<CheckpointSettings> {
    let sup = slot.supervisor().clone();
    blocking(move || sup.host().set_protect_config(on)).await
}

#[tauri::command]
pub async fn checkpoints_config(slot: State<'_, RolesSlot>, run_id: String, seq: u32) -> Res<Vec<ConfigCopy>> {
    let sup = slot.supervisor().clone();
    blocking(move || sup.host().checkpoint_config(&run_id, seq)).await
}

/// Writes config-file copies back; refuses (`confirmRequired`) unless `consent` is true.
#[tauri::command]
pub async fn checkpoints_restore_config(slot: State<'_, RolesSlot>, run_id: String, seq: u32, repo_id: String, paths: Vec<String>, consent: bool) -> Res<Vec<String>> {
    let sup = slot.supervisor().clone();
    blocking(move || sup.host().restore_checkpoint_config(&run_id, seq, &repo_id, &paths, consent)).await
}
