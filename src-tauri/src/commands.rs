//! One Tauri command per engine command (contract section 4); each delegates to the managed `Engine`.

use intely_core::{
    ChangedFile, CommitRequest, DiffSource, DoctorReport, Engine, EngineError, EngineStatus, FileContents, Hunk,
    OutgoingInfo, PullMode, PushRequest, RepoId, RepoSnapshot, RunStarted, UntrackedList, Workspace,
};
use tauri::State;

use crate::modules::workspaces::check_epoch;

type Res<T> = Result<T, EngineError>;

/// The engine, or the reason it could not start (a corrupt workspace file, the spike modes); commands report that error.
pub struct EngineSlot(pub Result<Engine, EngineError>);

impl EngineSlot {
    pub fn get(&self) -> Res<&Engine> {
        self.0.as_ref().map_err(Clone::clone)
    }
}

#[tauri::command]
pub async fn workspace_get(slot: State<'_, EngineSlot>) -> Res<Workspace> {
    slot.get()?.workspace_get().await
}

// `workspace_save` lives in `modules/workspaces.rs`: it only accepts (id, path) pairs the open workspace already has.

#[tauri::command]
pub async fn engine_status(slot: State<'_, EngineSlot>) -> Res<EngineStatus> {
    slot.get()?.engine_status().await
}

#[tauri::command]
pub async fn snapshot_get(slot: State<'_, EngineSlot>, repo_id: RepoId) -> Res<RepoSnapshot> {
    slot.get()?.snapshot_get(&repo_id).await
}

#[tauri::command]
pub async fn snapshot_refresh(slot: State<'_, EngineSlot>, repo_id: Option<RepoId>) -> Res<()> {
    slot.get()?.snapshot_refresh(repo_id.as_deref()).await
}

#[tauri::command]
pub async fn list_untracked(slot: State<'_, EngineSlot>, repo_id: RepoId, dir: String, limit: u32) -> Res<UntrackedList> {
    slot.get()?.list_untracked(&repo_id, &dir, limit).await
}

#[tauri::command]
pub async fn file_contents(
    slot: State<'_, EngineSlot>,
    repo_id: RepoId,
    path: String,
    orig_path: Option<String>,
    source: DiffSource,
    reveal: Option<bool>,
) -> Res<FileContents> {
    slot.get()?.file_contents(&repo_id, &path, orig_path.as_deref(), source, reveal.unwrap_or(false)).await
}

#[tauri::command]
pub async fn file_hunks(slot: State<'_, EngineSlot>, repo_id: RepoId, path: String, source: DiffSource) -> Res<Vec<Hunk>> {
    slot.get()?.file_hunks(&repo_id, &path, source).await
}

#[tauri::command]
pub async fn commit_message_last(slot: State<'_, EngineSlot>, repo_id: RepoId) -> Res<String> {
    slot.get()?.commit_message_last(&repo_id).await
}

#[tauri::command]
pub async fn commit_start(slot: State<'_, EngineSlot>, req: CommitRequest, epoch: Option<u64>) -> Res<RunStarted> {
    check_epoch(slot.get()?, epoch)?;
    slot.get()?.commit_start(req).await
}

#[tauri::command]
pub async fn commit_cancel(slot: State<'_, EngineSlot>, run_id: String) -> Res<()> {
    slot.get()?.commit_cancel(&run_id).await
}

#[tauri::command]
pub async fn push_plan(slot: State<'_, EngineSlot>, repo_ids: Vec<RepoId>, refetch: bool) -> Res<Vec<OutgoingInfo>> {
    slot.get()?.push_plan(&repo_ids, refetch).await
}

#[tauri::command]
pub async fn push_commit_files(slot: State<'_, EngineSlot>, repo_id: RepoId, oid: String) -> Res<Vec<ChangedFile>> {
    slot.get()?.push_commit_files(&repo_id, &oid).await
}

#[tauri::command]
pub async fn push_start(slot: State<'_, EngineSlot>, req: PushRequest, epoch: Option<u64>) -> Res<RunStarted> {
    check_epoch(slot.get()?, epoch)?;
    slot.get()?.push_start(req).await
}

#[tauri::command]
pub async fn push_cancel(slot: State<'_, EngineSlot>, run_id: String) -> Res<()> {
    slot.get()?.push_cancel(&run_id).await
}

#[tauri::command]
pub async fn pull(slot: State<'_, EngineSlot>, repo_id: RepoId, mode: PullMode, epoch: Option<u64>) -> Res<RunStarted> {
    check_epoch(slot.get()?, epoch)?;
    slot.get()?.pull(&repo_id, mode).await
}

#[tauri::command]
pub async fn fetch(slot: State<'_, EngineSlot>, repo_id: RepoId, epoch: Option<u64>) -> Res<RunStarted> {
    check_epoch(slot.get()?, epoch)?;
    slot.get()?.fetch(&repo_id).await
}

#[tauri::command]
pub async fn set_push_target(
    slot: State<'_, EngineSlot>,
    repo_id: RepoId,
    local_branch: String,
    remote: String,
    branch: String,
    epoch: Option<u64>,
) -> Res<Workspace> {
    check_epoch(slot.get()?, epoch)?;
    slot.get()?.set_push_target(&repo_id, &local_branch, &remote, &branch).await
}

/// One flag per repo-relative path: does the file run code when the human commits, pushes, installs, lints, tests or
/// builds? The Commit panel warns about those; the list lives in the agent policy (`policy::paths`).
#[tauri::command]
pub fn exec_surface_check(paths: Vec<String>) -> Vec<bool> {
    intely_agent_core::policy::paths::exec_surface_flags(&paths)
}

#[tauri::command]
pub async fn doctor(slot: State<'_, EngineSlot>) -> Res<DoctorReport> {
    slot.get()?.doctor().await
}
