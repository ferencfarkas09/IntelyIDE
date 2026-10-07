//! Tauri glue of the `files` module (track C): commands and state on top of `intely_files`. Commands listed in
//! `generate_handler!` under the "track C commands" marker in `lib.rs`; state is created in `setup`.
//!
//! Commands are named `<ns>_<method>` (`files_*`, `search_*`, `branches_*`); events are `files:changed` and
//! `search:results`. Repo ids resolve through the engine's workspace, so a path can only ever land in a registered repo.

use std::path::PathBuf;
use std::sync::Arc;

use intely_core::env::EnvResolver;
use intely_core::exec::{pinned_git_path, GitCtx};
use intely_core::{EngineError, RepoId, Workspace};
use intely_files::{
    BranchList, DirEntry, Encoding, FileChanged, FileKind, FileRead, Files, FilesSink, NullEngineSink, RepoRoot, RollbackResult,
    SearchBatch, SearchOptions, SearchStarted, StashEntry, SwitchOutcome, WriteResult,
};
use tauri::{AppHandle, Emitter, Manager, State};

use super::switchhook::{self, BoxFuture, SwitchHook};
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

/// The `SwitchHook` of the file module: file watches, the quick-open index and searches belong to the open workspace.
struct FilesHook(Arc<Files>);

impl SwitchHook for FilesHook {
    fn name(&self) -> &'static str {
        "files"
    }

    /// Watches and caches are not worth asking the user about.
    fn busy(&self) -> Vec<intely_core::BusyItem> {
        Vec::new()
    }

    fn stop(&self) -> BoxFuture<'_, Vec<intely_core::SwitchWarning>> {
        Box::pin(async move {
            self.0.reset();
            Vec::new()
        })
    }
}

/// `Some(hook)` once `setup` ran.
pub fn hook(app: &AppHandle) -> Option<Arc<dyn SwitchHook>> {
    app.try_state::<FilesState>().map(|s| Arc::new(FilesHook(s.files.clone())) as Arc<dyn SwitchHook>)
}

pub struct FilesState {
    files: Arc<Files>,
    /// Where `branches_rollback` keeps the patch and the moved files.
    backup_root: PathBuf,
    /// Where `files_trash_entry` moves entries (the user's Trash).
    trash_dir: PathBuf,
    /// E2E only: "Reveal in Finder" appends the path here instead of opening a Finder window on the desktop.
    reveal_log: Option<PathBuf>,
}

struct TauriFilesSink(AppHandle);

impl FilesSink for TauriFilesSink {
    fn file_changed(&self, e: FileChanged) {
        if let Err(err) = self.0.emit("files:changed", e) {
            eprintln!("emit files:changed failed: {err}");
        }
    }

    fn search_batch(&self, b: SearchBatch) {
        if let Err(err) = self.0.emit("search:results", b) {
            eprintln!("emit search:results failed: {err}");
        }
    }
}

/// Called once from `setup` (track C state marker): create and `app.manage(..)` the module state here.
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let git = pinned_git_path();
    let env = Arc::new(EnvResolver::new(&git.to_string_lossy()));
    let ctx = GitCtx::new(git, env, Arc::new(NullEngineSink));
    let files = Arc::new(Files::new(ctx, Arc::new(TauriFilesSink(app.handle().clone()))));
    // INTELY_DATA_DIR (tests, the e2e harness) keeps the rollback backups out of the real app data dir; under INTELY_E2E=1 it
    // also stands in for the Trash and for Finder, so a test never fills the user's Trash or opens windows on the desktop.
    let data_dir = std::env::var_os("INTELY_DATA_DIR").map(PathBuf::from);
    let e2e = std::env::var("INTELY_E2E").is_ok_and(|v| v == "1");
    let backup_root = match &data_dir {
        Some(d) => d.join("rollback"),
        None => app.path().app_data_dir()?.join("rollback"),
    };
    let trash_dir = match (&data_dir, e2e) {
        (Some(d), true) => d.join("Trash"),
        _ => app.path().home_dir()?.join(".Trash"),
    };
    let reveal_log = data_dir.filter(|_| e2e).map(|d| d.join("reveal.log"));
    app.manage(FilesState { files, backup_root, trash_dir, reveal_log });
    Ok(())
}

async fn workspace(engine: &State<'_, EngineSlot>) -> Res<Workspace> {
    engine.get()?.workspace_get().await
}

fn root_of(ws: &Workspace, repo_id: &str) -> Res<RepoRoot> {
    ws.repos
        .iter()
        .find(|r| r.id == repo_id)
        .map(|r| RepoRoot { id: r.id.clone(), path: PathBuf::from(&r.path) })
        .ok_or_else(|| EngineError::new(intely_core::code::NOT_A_REPO, format!("unknown repository {repo_id}")))
}

async fn root(engine: &State<'_, EngineSlot>, repo_id: &str) -> Res<RepoRoot> {
    root_of(&workspace(engine).await?, repo_id)
}

fn roots(ws: &Workspace, only: Option<&[RepoId]>) -> Vec<RepoRoot> {
    ws.repos
        .iter()
        .filter(|r| only.map_or(true, |ids| ids.contains(&r.id)))
        .map(|r| RepoRoot { id: r.id.clone(), path: PathBuf::from(&r.path) })
        .collect()
}

/// The workspace's protected patterns plus the repo's own live branches (the same set a push is confirmed against).
fn protected_patterns(ws: &Workspace, repo_id: &str) -> Vec<String> {
    let mut patterns = ws.protected_branches.clone();
    patterns.extend(ws.live_branches.get(repo_id).into_iter().flatten().cloned());
    patterns
}

/// A mutating branch, stash or rollback operation: refused while a switch is under way, and a running one makes the
/// switch refuse (the guard lives as long as the returned value).
fn guard(app: &AppHandle, engine: &State<'_, EngineSlot>, kind: &'static str) -> Res<intely_core::MutationGuard> {
    switchhook::begin_mutation(app, engine.get()?, kind)
}

/// The engine's own snapshot is refreshed right away; its watcher would get there a moment later.
async fn refresh(engine: &State<'_, EngineSlot>, repo_id: &str) {
    if let Ok(engine) = engine.get() {
        let _ = engine.snapshot_refresh(Some(repo_id)).await;
    }
}

#[tauri::command]
pub async fn files_list_dir(state: State<'_, FilesState>, engine: State<'_, EngineSlot>, repo_id: RepoId, rel_path: String) -> Res<Vec<DirEntry>> {
    state.files.list_dir(&root(&engine, &repo_id).await?, &rel_path).await
}

#[tauri::command]
pub async fn files_read_file(
    state: State<'_, FilesState>,
    engine: State<'_, EngineSlot>,
    repo_id: RepoId,
    rel_path: String,
    reveal: Option<bool>,
    encoding: Option<Encoding>,
) -> Res<FileRead> {
    state.files.read_file_as(&root(&engine, &repo_id).await?, &rel_path, reveal.unwrap_or(false), encoding).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn files_write_file(
    state: State<'_, FilesState>,
    engine: State<'_, EngineSlot>,
    repo_id: RepoId,
    rel_path: String,
    text: String,
    expected_mtime_ms: f64,
    reveal: Option<bool>,
    encoding: Option<Encoding>,
) -> Res<WriteResult> {
    let root = root(&engine, &repo_id).await?;
    state.files.write_file(&root, &rel_path, &text, expected_mtime_ms, reveal.unwrap_or(false), encoding).await
}

#[tauri::command]
pub async fn files_create_entry(
    state: State<'_, FilesState>,
    engine: State<'_, EngineSlot>,
    repo_id: RepoId,
    rel_path: String,
    kind: FileKind,
) -> Res<()> {
    state.files.create_entry(&root(&engine, &repo_id).await?, &rel_path, kind).await
}

#[tauri::command]
pub async fn files_rename_entry(state: State<'_, FilesState>, engine: State<'_, EngineSlot>, repo_id: RepoId, from: String, to: String) -> Res<()> {
    state.files.rename_entry(&root(&engine, &repo_id).await?, &from, &to).await
}

#[tauri::command]
pub async fn files_trash_entry(state: State<'_, FilesState>, engine: State<'_, EngineSlot>, repo_id: RepoId, rel_path: String) -> Res<()> {
    state.files.trash_entry(&root(&engine, &repo_id).await?, &rel_path, &state.trash_dir).await
}

/// Shows the entry in Finder.
#[tauri::command]
pub async fn files_reveal_entry(state: State<'_, FilesState>, engine: State<'_, EngineSlot>, repo_id: RepoId, rel_path: String) -> Res<()> {
    let path = state.files.entry_path(&root(&engine, &repo_id).await?, &rel_path)?;
    if let Some(log) = &state.reveal_log {
        use std::io::Write;
        return std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
            .and_then(|mut f| writeln!(f, "{}", path.display()))
            .map_err(|e| EngineError::new(intely_core::code::IO, format!("cannot log the reveal of {}: {e}", path.display())));
    }
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map(drop)
        .map_err(|e| EngineError::new(intely_core::code::IO, format!("cannot reveal {}: {e}", path.display())))
}

#[tauri::command]
pub async fn files_quick_open_index(state: State<'_, FilesState>, engine: State<'_, EngineSlot>, repo_id: RepoId) -> Res<Vec<String>> {
    Ok(state.files.quick_open_index(&root(&engine, &repo_id).await?).await?.as_ref().clone())
}

#[tauri::command]
pub async fn files_watch(state: State<'_, FilesState>, engine: State<'_, EngineSlot>, repo_id: RepoId, rel_path: String) -> Res<()> {
    state.files.watch_file(&root(&engine, &repo_id).await?, &rel_path)
}

#[tauri::command]
pub fn files_unwatch(state: State<'_, FilesState>, repo_id: RepoId, rel_path: String) {
    state.files.unwatch_file(&repo_id, &rel_path);
}

#[tauri::command]
pub async fn search_start(
    state: State<'_, FilesState>,
    engine: State<'_, EngineSlot>,
    query: String,
    opts: Option<SearchOptions>,
) -> Res<SearchStarted> {
    let opts = opts.unwrap_or(SearchOptions { repo_ids: None, regex: false, case_sensitive: false, glob: None });
    let roots = roots(&workspace(&engine).await?, opts.repo_ids.as_deref());
    Ok(SearchStarted { search_id: state.files.search_start(roots, &query, opts).await? })
}

#[tauri::command]
pub fn search_cancel(state: State<'_, FilesState>, search_id: String) {
    state.files.search_cancel(&search_id);
}

#[tauri::command]
pub async fn branches_list(state: State<'_, FilesState>, engine: State<'_, EngineSlot>, repo_id: RepoId) -> Res<BranchList> {
    state.files.branch_list(&root(&engine, &repo_id).await?).await
}

#[tauri::command]
pub async fn branches_create(
    app: AppHandle,
    state: State<'_, FilesState>,
    engine: State<'_, EngineSlot>,
    repo_id: RepoId,
    name: String,
    from: Option<String>,
) -> Res<()> {
    let _guard = guard(&app, &engine, "branch")?;
    let result = state.files.branch_create(&root(&engine, &repo_id).await?, &name, from.as_deref()).await;
    refresh(&engine, &repo_id).await;
    result
}

#[tauri::command]
pub async fn branches_switch(app: AppHandle, state: State<'_, FilesState>, engine: State<'_, EngineSlot>, repo_id: RepoId, name: String) -> Res<()> {
    let _guard = guard(&app, &engine, "branch")?;
    state.files.set_hook_env(engine.get()?.login_env());
    let result = state.files.branch_switch(&root(&engine, &repo_id).await?, &name).await;
    refresh(&engine, &repo_id).await;
    result
}

#[tauri::command]
pub async fn branches_switch_all(app: AppHandle, state: State<'_, FilesState>, engine: State<'_, EngineSlot>, name: String) -> Res<Vec<SwitchOutcome>> {
    let _guard = guard(&app, &engine, "branch")?;
    state.files.set_hook_env(engine.get()?.login_env());
    let outcomes = state.files.branch_switch_all(&roots(&workspace(&engine).await?, None), &name).await;
    if let Ok(engine) = engine.get() {
        let _ = engine.snapshot_refresh(None).await;
    }
    Ok(outcomes)
}

#[tauri::command]
pub async fn branches_delete(
    app: AppHandle,
    state: State<'_, FilesState>,
    engine: State<'_, EngineSlot>,
    repo_id: RepoId,
    name: String,
    force: Option<bool>,
) -> Res<()> {
    let _guard = guard(&app, &engine, "branch")?;
    // the patterns every workspace that holds this repository knows (I7), not just the open one
    let ws = engine.get()?.effective_workspace().await?;
    let result = state.files.branch_delete(&root_of(&ws, &repo_id)?, &name, force.unwrap_or(false), &protected_patterns(&ws, &repo_id)).await;
    refresh(&engine, &repo_id).await;
    result
}

#[tauri::command]
pub async fn branches_stash_list(state: State<'_, FilesState>, engine: State<'_, EngineSlot>, repo_id: RepoId) -> Res<Vec<StashEntry>> {
    state.files.stash_list(&root(&engine, &repo_id).await?).await
}

#[tauri::command]
pub async fn branches_stash_push(
    app: AppHandle,
    state: State<'_, FilesState>,
    engine: State<'_, EngineSlot>,
    repo_id: RepoId,
    paths: Option<Vec<String>>,
    message: Option<String>,
) -> Res<()> {
    let _guard = guard(&app, &engine, "stash")?;
    let result = state.files.stash_push(&root(&engine, &repo_id).await?, &paths.unwrap_or_default(), message.as_deref()).await;
    refresh(&engine, &repo_id).await;
    result
}

#[tauri::command]
pub async fn branches_stash_apply(app: AppHandle, state: State<'_, FilesState>, engine: State<'_, EngineSlot>, repo_id: RepoId, index: u32) -> Res<()> {
    let _guard = guard(&app, &engine, "stash")?;
    let result = state.files.stash_apply(&root(&engine, &repo_id).await?, index).await;
    refresh(&engine, &repo_id).await;
    result
}

#[tauri::command]
pub async fn branches_stash_pop(app: AppHandle, state: State<'_, FilesState>, engine: State<'_, EngineSlot>, repo_id: RepoId, index: u32) -> Res<()> {
    let _guard = guard(&app, &engine, "stash")?;
    let result = state.files.stash_pop(&root(&engine, &repo_id).await?, index).await;
    refresh(&engine, &repo_id).await;
    result
}

#[tauri::command]
pub async fn branches_stash_drop(app: AppHandle, state: State<'_, FilesState>, engine: State<'_, EngineSlot>, repo_id: RepoId, index: u32) -> Res<()> {
    let _guard = guard(&app, &engine, "stash")?;
    state.files.stash_drop(&root(&engine, &repo_id).await?, index).await
}

#[tauri::command]
pub async fn branches_rollback(
    app: AppHandle,
    state: State<'_, FilesState>,
    engine: State<'_, EngineSlot>,
    repo_id: RepoId,
    paths: Vec<String>,
) -> Res<RollbackResult> {
    let _guard = guard(&app, &engine, "rollback")?;
    let result = state.files.rollback(&root(&engine, &repo_id).await?, &paths, &state.backup_root).await;
    refresh(&engine, &repo_id).await;
    result
}

#[cfg(test)]
mod hook_tests {
    use super::*;

    struct Quiet;
    impl FilesSink for Quiet {
        fn file_changed(&self, _: FileChanged) {}
        fn search_batch(&self, _: SearchBatch) {}
    }

    #[test]
    fn the_files_hook_drops_every_watch_and_cache_and_can_be_stopped_twice() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("a.txt"), "a").unwrap();
        let git = pinned_git_path();
        let env = Arc::new(EnvResolver::new(&git.to_string_lossy()));
        let files = Arc::new(Files::new(GitCtx::new(git, env, Arc::new(NullEngineSink)), Arc::new(Quiet)));
        let repo = RepoRoot { id: "r".into(), path: root };
        files.watch_file(&repo, "a.txt").unwrap();
        assert_eq!(files.open_resources().0, 1);

        let hook: Arc<dyn SwitchHook> = Arc::new(FilesHook(files.clone()));
        assert_eq!(hook.name(), "files");
        assert!(hook.busy().is_empty());
        assert!(tauri::async_runtime::block_on(hook.stop()).is_empty());
        assert_eq!(files.open_resources(), (0, 0, 0));
        assert!(tauri::async_runtime::block_on(hook.stop()).is_empty(), "stop twice");
        files.watch_file(&repo, "a.txt").unwrap();
        assert_eq!(files.open_resources().0, 1, "reusable");
    }
}
