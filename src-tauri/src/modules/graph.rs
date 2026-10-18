//! Tauri glue of the `graph` module (track D): one command per `ipc.graph` method on top of `intely_graph`. Commands are
//! listed in `generate_handler!` under the "track D commands" marker in `lib.rs`; the state is created in `setup`.
//! Commands that change a repo ask the engine to refresh its snapshot afterwards.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use intely_core::jail::{Jail, Mode};
use intely_core::{Engine, EngineError, RepoId};
use intely_graph::types::*;
use intely_graph::{DraftModel, Env, Graph};
use tauri::{AppHandle, Manager, State};

use super::switchhook;
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

pub struct GraphState(Graph);

/// Called once from `setup` (track D state marker). Bundles are kept in the IDE's state directory
/// (`workspace::state_dir()`, which follows `INTELY_WORKSPACES`).
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let graph = Graph::new(Some(intely_core::workspace::state_dir()));
    graph.set_draft_model(Some(Arc::new(ClaudeDraft)));
    app.manage(GraphState(graph));
    Ok(())
}

/// The model behind "Generate" in the commit panel: the user's own Claude Code in print mode, no tools, from an empty folder (the prompt
/// holds the cut diff of the ticked files, never the contents of key, env or lock files). `INTELY_COMMIT_MODEL` names another model.
/// Read-only mode or a missing `claude` make the draft fall back to the one composed locally.
struct ClaudeDraft;

const COMMIT_MODEL: &str = "sonnet";
const COMMIT_TIMEOUT: Duration = Duration::from_secs(120);

impl DraftModel for ClaudeDraft {
    fn complete<'a>(&'a self, prompt: String) -> Pin<Box<dyn Future<Output = Result<String, EngineError>> + Send + 'a>> {
        Box::pin(async move {
            if Jail::global().mode() == Mode::ReadOnly {
                return Err(EngineError::new(intely_core::jail::READ_ONLY, "read-only mode (INTELY_READONLY)"));
            }
            let model = std::env::var("INTELY_COMMIT_MODEL").ok().filter(|m| !m.trim().is_empty()).unwrap_or_else(|| COMMIT_MODEL.to_owned());
            crate::agents::blocking(move || super::l10n::run_claude_with(&model, &prompt, COMMIT_TIMEOUT)).await
        })
    }
}

/// The newest commits of the branch a repository has checked out (Team's commit list), read-only; `None` when the engine or the
/// log is not available.
pub(crate) async fn recent_commits(app: &AppHandle, repo_id: &str, limit: u32) -> Option<Vec<GraphRow>> {
    let slot = app.try_state::<EngineSlot>()?;
    let graph = app.try_state::<GraphState>()?;
    let env = env_of(slot.get().ok()?).await.ok()?;
    let filters = LogFilters { branch: Some("HEAD".into()), ..Default::default() };
    graph.0.log_page(&env, &[repo_id.to_string()], None, &filters, Some(limit)).await.ok().map(|page| page.rows)
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

/// One message for the ticked changes of several repositories (the shared message of a coordinated commit).
#[tauri::command]
pub async fn graph_draft_message_many(slot: State<'_, EngineSlot>, graph: State<'_, GraphState>, selections: Vec<RepoSelection>) -> Res<MessageDraft> {
    graph.0.draft_message_many(&env_of(slot.get()?).await?, &selections).await
}
