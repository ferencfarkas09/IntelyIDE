//! Tauri glue of the `graph` module (track D): one command per `ipc.graph` method on top of `intely_graph`. Commands are
//! listed in `generate_handler!` under the "track D commands" marker in `lib.rs`; the state is created in `setup`.
//! Commands that change a repo ask the engine to refresh its snapshot afterwards.

use intely_core::{Engine, EngineError, RepoId};
use intely_graph::types::*;
use intely_graph::{Env, Graph};
use tauri::{AppHandle, Manager, State};

use super::switchhook;
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

pub struct GraphState(Graph);

/// Called once from `setup` (track D state marker). Bundles are kept in the IDE's state directory
/// (`workspace::state_dir()`, which follows `INTELY_WORKSPACES`).
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(GraphState(Graph::new(Some(intely_core::workspace::state_dir()))));
    Ok(())
}

/// The git context plus the open workspace with the live patterns of every workspace that holds the same repositories (I7).
async fn env_of(engine: &Engine) -> Res<Env> {
    Ok(Env::new(engine.git_ctx(), engine.effective_workspace().await?))
}

async fn refresh(engine: &Engine, repo_ids: &[RepoId]) {
    for id in repo_ids {
        let _ = engine.snapshot_refresh(Some(id)).await;
    }
}

#[tauri::command]
pub async fn graph_log_page(
    slot: State<'_, EngineSlot>,
    graph: State<'_, GraphState>,
    repo_ids: Vec<RepoId>,
    cursor: Option<String>,
    filters: Option<LogFilters>,
    limit: Option<u32>,
) -> Res<LogPage> {
    let engine = slot.get()?;
    graph.0.log_page(&env_of(engine).await?, &repo_ids, cursor.as_deref(), &filters.unwrap_or_default(), limit).await
}

#[tauri::command]
pub async fn graph_commit_detail(slot: State<'_, EngineSlot>, graph: State<'_, GraphState>, repo_id: RepoId, oid: String) -> Res<CommitDetail> {
    graph.0.commit_detail(&env_of(slot.get()?).await?, &repo_id, &oid).await
}

#[tauri::command]
pub async fn graph_blame(
    slot: State<'_, EngineSlot>,
    graph: State<'_, GraphState>,
    repo_id: RepoId,
    path: String,
    rev: Option<String>,
) -> Res<Vec<BlameLine>> {
    graph.0.blame(&env_of(slot.get()?).await?, &repo_id, &path, rev.as_deref()).await
}

#[tauri::command]
pub async fn graph_blame_caret(
    slot: State<'_, EngineSlot>,
    graph: State<'_, GraphState>,
    repo_id: RepoId,
    path: String,
    line: u32,
    rev: Option<String>,
) -> Res<BlameCaret> {
    graph.0.blame_caret(&env_of(slot.get()?).await?, &repo_id, &path, line, rev.as_deref()).await
}

#[tauri::command]
pub async fn graph_file_history(slot: State<'_, EngineSlot>, graph: State<'_, GraphState>, repo_id: RepoId, path: String) -> Res<Vec<GraphRow>> {
    graph.0.file_history(&env_of(slot.get()?).await?, &repo_id, &path).await
}

#[tauri::command]
pub async fn graph_rebase_plan(slot: State<'_, EngineSlot>, graph: State<'_, GraphState>, repo_id: RepoId, onto: String) -> Res<RebasePlan> {
    graph.0.rebase_plan(&env_of(slot.get()?).await?, &repo_id, &onto).await
}

#[tauri::command]
pub async fn graph_rebase_run(
    app: AppHandle,
    slot: State<'_, EngineSlot>,
    graph: State<'_, GraphState>,
    plan: RebasePlan,
    confirm_live: Option<String>,
) -> Res<OpOutcome> {
    let engine = slot.get()?;
    let _guard = switchhook::begin_mutation(&app, engine, "rebase")?;
    let result = graph.0.rebase_run(&env_of(engine).await?, &plan, confirm_live.as_deref()).await;
    refresh(engine, std::slice::from_ref(&plan.repo_id)).await;
    result
}

#[tauri::command]
pub async fn graph_rebase_abort(app: AppHandle, slot: State<'_, EngineSlot>, graph: State<'_, GraphState>, repo_id: RepoId) -> Res<OpOutcome> {
    let engine = slot.get()?;
    let _guard = switchhook::begin_mutation(&app, engine, "rebase")?;
    let result = graph.0.rebase_abort(&env_of(engine).await?, &repo_id).await;
    refresh(engine, &[repo_id]).await;
    result
}

#[tauri::command]
pub async fn graph_rebase_continue(app: AppHandle, slot: State<'_, EngineSlot>, graph: State<'_, GraphState>, repo_id: RepoId) -> Res<OpOutcome> {
    let engine = slot.get()?;
    let _guard = switchhook::begin_mutation(&app, engine, "rebase")?;
    let result = graph.0.rebase_continue(&env_of(engine).await?, &repo_id).await;
    refresh(engine, &[repo_id]).await;
    result
}

#[tauri::command]
pub async fn graph_op_state(slot: State<'_, EngineSlot>, graph: State<'_, GraphState>, repo_id: RepoId) -> Res<OpOutcome> {
    graph.0.op_state(&env_of(slot.get()?).await?, &repo_id).await
}

#[tauri::command]
pub async fn graph_cherry_pick(
    app: AppHandle,
    slot: State<'_, EngineSlot>,
    graph: State<'_, GraphState>,
    repo_id: RepoId,
    oids: Vec<String>,
    confirm_live: Option<String>,
) -> Res<OpOutcome> {
    let engine = slot.get()?;
    let _guard = switchhook::begin_mutation(&app, engine, "cherryPick")?;
    let result = graph.0.cherry_pick(&env_of(engine).await?, &repo_id, &oids, confirm_live.as_deref()).await;
    refresh(engine, &[repo_id]).await;
    result
}

#[tauri::command]
pub async fn graph_cherry_pick_abort(app: AppHandle, slot: State<'_, EngineSlot>, graph: State<'_, GraphState>, repo_id: RepoId) -> Res<OpOutcome> {
    let engine = slot.get()?;
    let _guard = switchhook::begin_mutation(&app, engine, "cherryPick")?;
    let result = graph.0.cherry_pick_abort(&env_of(engine).await?, &repo_id).await;
    refresh(engine, &[repo_id]).await;
    result
}

#[tauri::command]
pub async fn graph_cherry_pick_continue(app: AppHandle, slot: State<'_, EngineSlot>, graph: State<'_, GraphState>, repo_id: RepoId) -> Res<OpOutcome> {
    let engine = slot.get()?;
    let _guard = switchhook::begin_mutation(&app, engine, "cherryPick")?;
    let result = graph.0.cherry_pick_continue(&env_of(engine).await?, &repo_id).await;
    refresh(engine, &[repo_id]).await;
    result
}

#[tauri::command]
pub async fn graph_branch_matrix(slot: State<'_, EngineSlot>, graph: State<'_, GraphState>, repo_ids: Option<Vec<RepoId>>) -> Res<BranchMatrix> {
    graph.0.branch_matrix(&env_of(slot.get()?).await?, &repo_ids.unwrap_or_default()).await
}

#[tauri::command]
pub async fn graph_same_branch_create(
    app: AppHandle,
    slot: State<'_, EngineSlot>,
    graph: State<'_, GraphState>,
    repo_ids: Vec<RepoId>,
    name: String,
    start: Option<String>,
) -> Res<SameBranchResult> {
    let engine = slot.get()?;
    let _guard = switchhook::begin_mutation(&app, engine, "branch")?;
    let result = graph.0.same_branch_create(&env_of(engine).await?, &repo_ids, &name, start.as_deref()).await;
    refresh(engine, &repo_ids).await;
    result
}

#[tauri::command]
pub async fn graph_same_branch_switch(
    app: AppHandle,
    slot: State<'_, EngineSlot>,
    graph: State<'_, GraphState>,
    repo_ids: Vec<RepoId>,
    name: String,
) -> Res<SameBranchResult> {
    let engine = slot.get()?;
    let _guard = switchhook::begin_mutation(&app, engine, "branch")?;
    let result = graph.0.same_branch_switch(&env_of(engine).await?, &repo_ids, &name).await;
    refresh(engine, &repo_ids).await;
    result
}

#[tauri::command]
pub async fn graph_bundles(
    slot: State<'_, EngineSlot>,
    graph: State<'_, GraphState>,
    repo_ids: Option<Vec<RepoId>>,
    window_ms: Option<i64>,
) -> Res<Vec<Bundle>> {
    graph.0.bundles(&env_of(slot.get()?).await?, &repo_ids.unwrap_or_default(), window_ms).await
}

#[tauri::command]
pub async fn graph_bundle_record(
    slot: State<'_, EngineSlot>,
    graph: State<'_, GraphState>,
    links: Vec<BundleLink>,
    name: Option<String>,
) -> Res<Bundle> {
    graph.0.bundle_record(&env_of(slot.get()?).await?, &links, name.as_deref()).await
}

#[tauri::command]
pub fn graph_bundle_remove(graph: State<'_, GraphState>, id: String) -> Res<()> {
    graph.0.bundle_remove(&id)
}

#[tauri::command]
pub fn graph_validate_message(graph: State<'_, GraphState>, message: String, style: MessageStyle) -> MessageCheck {
    graph.0.validate_message(&message, &style)
}

#[tauri::command]
pub fn graph_message_template(graph: State<'_, GraphState>, style: MessageStyle, subject: Option<String>) -> String {
    graph.0.message_template(&style, subject.as_deref())
}

#[tauri::command]
pub async fn graph_draft_message(
    slot: State<'_, EngineSlot>,
    graph: State<'_, GraphState>,
    repo_id: RepoId,
    selection: Vec<SelectedPath>,
) -> Res<MessageDraft> {
    graph.0.draft_message(&env_of(slot.get()?).await?, &repo_id, &selection).await
}
