//! Tauri glue of the Wave 4 GitX extras on top of `intely_gitx`: the PR bridge (#17) and the expanded Doctor (#29).
//! Everything is human-initiated and goes through the jail inside the crate. The PR reads are `gh pr list|view|checks`
//! (read-only); `gitx_pr_create` is the only write and needs the typed repo name and head branch. The webview sends
//! repo ids and plain values, never a command line, and never sees a token.

use std::path::PathBuf;
use std::sync::Arc;

use intely_core::jail::{Jail, Mode, TEST_JAIL};
use intely_core::{code, EngineError, EnvState};
use intely_gitx::doctor::{self, DoctorOpts};
use intely_gitx::gh::{self, Gh};
use intely_gitx::pr::{self, RepoRef};
use intely_gitx::types::{CreatePlan, CreateRequest, CreateResult, DoctorReport, GhStatus, PrDetail, PrList};
use tauri::{AppHandle, State};

use super::switchhook;
use crate::agents::blocking;
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

struct RepoCtx {
    path: PathBuf,
    name: String,
    patterns: Vec<String>,
}

async fn repo_ctx(slot: &EngineSlot, repo_id: &str) -> Res<RepoCtx> {
    // the live patterns every workspace holding this repository knows (I7)
    let ws = slot.get()?.effective_workspace().await?;
    let repo = ws.repos.iter().find(|r| r.id == repo_id).ok_or_else(|| EngineError::new(code::REPO_MISSING, format!("unknown repo {repo_id}")))?;
    let mut patterns = ws.protected_branches.clone();
    patterns.extend(ws.live_branches.get(repo_id).into_iter().flatten().cloned());
    Ok(RepoCtx { path: PathBuf::from(&repo.path), name: repo.name.clone(), patterns })
}

/// The login-shell PATH once resolved (the process PATH plus fallbacks before that), so `gh` is found like in a terminal.
fn login_path(slot: &EngineSlot) -> String {
    let path = slot.get().ok().and_then(|e| e.login_env().get("PATH").cloned()).or_else(|| std::env::var("PATH").ok()).unwrap_or_default();
    // e2e harness only: a directory with a fake `gh`, searched before the real PATH
    match (std::env::var("INTELY_E2E").is_ok_and(|v| v == "1"), std::env::var("INTELY_E2E_EXTRA_PATH")) {
        (true, Ok(extra)) if !extra.is_empty() => format!("{extra}:{path}"),
        _ => path,
    }
}

// ---- PR bridge --------------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn gitx_gh_status(slot: State<'_, EngineSlot>, repo_id: String) -> Res<GhStatus> {
    let (ctx, path) = (repo_ctx(&slot, &repo_id).await?, login_path(&slot));
    blocking(move || Ok(gh::status(Jail::global(), &path, &ctx.path))).await
}

#[tauri::command]
pub async fn gitx_pr_list(slot: State<'_, EngineSlot>, repo_id: String) -> Res<PrList> {
    let (ctx, path) = (repo_ctx(&slot, &repo_id).await?, login_path(&slot));
    blocking(move || {
        let jail = Jail::global();
        pr::list(&Gh::locate(Arc::clone(&jail), &path)?, &jail, &ctx.path)
    })
    .await
}

#[tauri::command]
pub async fn gitx_pr_view(slot: State<'_, EngineSlot>, repo_id: String, number: u64) -> Res<PrDetail> {
    let (ctx, path) = (repo_ctx(&slot, &repo_id).await?, login_path(&slot));
    blocking(move || pr::view(&Gh::locate(Jail::global(), &path)?, &ctx.path, number)).await
}

/// The draft title and body, the exact command and the reason Create is off, if any. Git reads only.
#[tauri::command]
pub async fn gitx_pr_plan(slot: State<'_, EngineSlot>, repo_id: String, base: Option<String>, draft: bool) -> Res<CreatePlan> {
    let ctx = repo_ctx(&slot, &repo_id).await?;
    blocking(move || Ok(pr::plan(&Jail::global(), &RepoRef { path: &ctx.path, name: &ctx.name, live_patterns: &ctx.patterns }, base.as_deref(), draft))).await
}

/// The command the request would run, for the dialog's live preview (edited title and body included).
#[tauri::command]
pub async fn gitx_pr_preview(slot: State<'_, EngineSlot>, repo_id: String, req: CreateRequest) -> Res<String> {
    let ctx = repo_ctx(&slot, &repo_id).await?;
    blocking(move || pr::preview(&Jail::global(), &RepoRef { path: &ctx.path, name: &ctx.name, live_patterns: &ctx.patterns }, &req)).await
}

/// `gh pr create`, a draft unless the request says otherwise. Never pushes; refuses without an upstream, on a live head,
/// under the jail and without the exact typed repo name and head branch.
#[tauri::command]
pub async fn gitx_pr_create(app: AppHandle, slot: State<'_, EngineSlot>, repo_id: String, req: CreateRequest) -> Res<CreateResult> {
    // held until the PR exists: a workspace switch refuses meanwhile (T18)
    let _guard = switchhook::begin_mutation(&app, slot.get()?, "prCreate")?;
    let (ctx, path) = (repo_ctx(&slot, &repo_id).await?, login_path(&slot));
    blocking(move || pr::create(Jail::global(), &path, &RepoRef { path: &ctx.path, name: &ctx.name, live_patterns: &ctx.patterns }, &req)).await
}

/// Opens an https link in the system browser (a PR page, a check run). Anything else is refused; the E2E jail never opens one.
#[tauri::command]
pub async fn gitx_open_url(url: String) -> Res<()> {
    if Jail::global().mode() == Mode::E2e {
        return Err(EngineError::new(TEST_JAIL, "test jail (INTELY_E2E): no link is opened"));
    }
    blocking(move || intely_happy::external::open_in_browser(&url).map_err(|m| EngineError::new("openFailed", m))).await
}

// ---- Doctor -----------------------------------------------------------------------------------------------------

fn data_dir() -> PathBuf {
    std::env::var_os("INTELY_DATA_DIR").map(PathBuf::from).or_else(intely_agent_core::events::log::JsonlEventLog::default_base_dir).unwrap_or_else(|| PathBuf::from("."))
}

/// The expanded report (tools, credentials, PATH, disk, locks, hooks, untracked, leftovers). Report only.
#[tauri::command]
pub async fn gitx_doctor(slot: State<'_, EngineSlot>) -> Res<DoctorReport> {
    let ws = slot.get()?.workspace_get().await?;
    let env_state = match slot.get()?.git_ctx().env.status().state {
        EnvState::Ready => "ready",
        EnvState::Resolving => "resolving",
        EnvState::Failed => "failed",
    };
    let repos = ws.repos.iter().map(|r| (r.id.clone(), PathBuf::from(&r.path))).collect();
    let mut opts = DoctorOpts::new(login_path(&slot), std::env::var("PATH").unwrap_or_default(), env_state.into(), repos, data_dir());
    opts.orphan_markers.push(opts.data_dir.to_string_lossy().into_owned());
    blocking(move || Ok(DoctorReport { checks: doctor::run(&opts), generated_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64) })).await
}

/// The Doctor's one fix: probe the login shell again for the environment the IDE starts tools from. Nothing on disk
/// changes except the IDE's own cached copy of that environment, which the next start rebuilds anyway.
#[tauri::command]
pub async fn gitx_refresh_env(slot: State<'_, EngineSlot>) -> Res<()> {
    let ctx = slot.get()?.git_ctx();
    ctx.env.resolve_fresh().await.map(|_| ())
}
