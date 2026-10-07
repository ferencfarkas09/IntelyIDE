//! Workspaces: startup, the registry commands and the enforcement of "the webview never makes Rust accept an
//! unvalidated path" ((design notes: workspaces-spec) 4.9, invariant I1). The switch itself lives in `workspaces_switch.rs`.
//!
//! Everything that needs an `AppHandle` is a thin `#[tauri::command]`; the logic is plain functions over
//! [`WorkspacesState`] and the engine, tested with a tempdir registry and fake tokens.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use intely_core::jail::{Jail, Mode};
use intely_core::registry::{self, Env, Location, NewRepo, NewWorkspace, Registry, RepoKind, ValidatedRepo};
use intely_core::{
    code, CrashLoopNotice, CreateResult, Engine, EngineError, EventSink, OpenError, OpenErrorReason, ProtectionSource, RegistryView, Workspace,
    WorkspaceEntry, WorkspaceOrigin, WorkspaceProbe,
};
use intely_pathpick::types::codes as pick_codes;
use intely_pathpick::{PathKind, PathTokens, Policy, Purpose, Validated, Validator};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::switchhook::{ActiveWorkspace, SwitchGate, SwitchHook};
use crate::agents::blocking;
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

const BOOT_FILE: &str = ".boot";
/// Two launches that never reached `workspaces_ready` make the third start on Welcome.
const CRASH_LOOP_AT: u32 = 2;
const PROBE_TOTAL: Duration = Duration::from_secs(3);

// ---- state -------------------------------------------------------------------------------------------------------------

pub struct WorkspacesState {
    pub(crate) registry: Arc<Registry>,
    pub(crate) tokens: Arc<PathTokens>,
    pub(crate) validator: Validator,
    pub(crate) gate: Arc<SwitchGate>,
    /// Registered by the switch orchestrator once every module exists.
    pub(crate) hooks: Mutex<Vec<Arc<dyn SwitchHook>>>,
    /// The id of the workspace the engine has open, `None` while detached.
    pub(crate) active: Arc<Mutex<Option<String>>>,
    launch: Mutex<Launch>,
}

#[derive(Default)]
struct Launch {
    crash_loop: Option<CrashLoopNotice>,
    /// The registry's active workspace could not be opened at launch (its file failed validation).
    open_failure: Option<String>,
    /// Every folder of this workspace is gone: the page asked for a detached engine with the entry kept (`keepActive`).
    all_missing: Option<String>,
}

/// `Arc<dyn ActiveWorkspace>` for the modules that stamp their data by workspace.
struct ActiveId(Arc<Mutex<Option<String>>>);

impl ActiveWorkspace for ActiveId {
    fn active_id(&self) -> Option<String> {
        self.0.lock().expect("active id").clone()
    }
}

/// The registry as the engine's [`ProtectionSource`]: the union over every workspace that holds the repository (I7).
struct RegistryProtection(Arc<Registry>);

impl ProtectionSource for RegistryProtection {
    fn protection(&self, repo_path: &Path) -> intely_core::Protection {
        self.0.effective_protection(repo_path)
    }
}

impl WorkspacesState {
    pub fn new(registry: Arc<Registry>, tokens: Arc<PathTokens>, validator: Validator, gate: Arc<SwitchGate>) -> Self {
        Self { registry, tokens, validator, gate, hooks: Mutex::default(), active: Arc::default(), launch: Mutex::default() }
    }

    pub fn set_active(&self, id: Option<String>) {
        *self.active.lock().expect("active id") = id;
    }

    pub fn active_id(&self) -> Option<String> {
        self.active.lock().expect("active id").clone()
    }

    /// Registers the modules a switch must stop (in any order; the teardown order is fixed by `switchhook::ordered`).
    pub fn register_hooks(&self, hooks: impl IntoIterator<Item = Arc<dyn SwitchHook>>) {
        self.hooks.lock().expect("hooks").extend(hooks);
    }

    /// The registry view plus what only the running app knows: the engine's epoch, the crash-loop notice and an
    /// active workspace that failed to open.
    pub fn decorate(&self, mut view: RegistryView, epoch: Option<u64>) -> RegistryView {
        view.epoch = epoch;
        let launch = self.launch.lock().expect("launch");
        view.crash_loop = launch.crash_loop.clone();
        view.just_migrated = self.registry.take_just_migrated();
        if view.open_error.is_none() {
            if let Some(id) = launch.all_missing.as_ref().filter(|id| view.active_id.as_ref() == Some(*id)) {
                view.open_error = Some(OpenError { id: id.clone(), reason: OpenErrorReason::AllMissing });
            }
        }
        if view.open_error.is_none() {
            if let Some(id) = launch.open_failure.as_ref().filter(|id| view.active_id.as_ref() == Some(*id)) {
                view.open_error = Some(OpenError { id: id.clone(), reason: OpenErrorReason::FileDamaged });
            }
        }
        view
    }

    /// The user opened the workspace anyway, or switched away: the crash-loop notice and the failure are history.
    pub fn clear_launch_notices(&self) {
        let mut l = self.launch.lock().expect("launch");
        l.crash_loop = None;
        l.open_failure = None;
        l.all_missing = None;
    }

    /// The engine was detached on purpose while the registry keeps this workspace as the active one (every folder missing).
    pub fn note_all_missing(&self, id: Option<String>) {
        self.launch.lock().expect("launch").all_missing = id;
    }
}

/// `INTELY_DATA_DIR` or the default state directory: where run logs, terminals' sweep files and the agent policy's
/// protected state directory live. The registry directory must be the same one (T10).
pub fn agent_data_dir() -> PathBuf {
    agent_data_dir_from(|k| std::env::var(k).ok())
}

/// [`agent_data_dir`] over an explicit environment (the T10 test compares it with `Location::from_env`).
pub fn agent_data_dir_from(var: impl Fn(&str) -> Option<String>) -> PathBuf {
    match var("INTELY_DATA_DIR").filter(|v| !v.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => var("HOME").map_or_else(|| PathBuf::from("."), |h| PathBuf::from(h).join("Library/Application Support/IntelySwitchIDE")),
    }
}

// ---- the crash-loop guard ------------------------------------------------------------------------------------------------

#[derive(Debug, Default, Serialize, Deserialize)]
struct BootMarker {
    id: String,
    launches: u32,
}

/// What a launch does with the registry's active workspace.
#[derive(Debug, PartialEq, Eq)]
pub struct LaunchDecision {
    /// The workspace to open now.
    pub open: Option<String>,
    /// The workspace that is *not* opened because the last launches never finished (or `INTELY_NO_AUTOOPEN=1`).
    pub crash_loop: Option<String>,
}

/// Counts this launch against the active workspace. Two earlier launches that never reached `workspaces_ready` (the
/// marker is still there) or `no_autoopen` start detached instead; the marker stays until a page calls `ready`.
pub fn decide_launch(dir: &Path, active_id: Option<&str>, no_autoopen: bool) -> LaunchDecision {
    let file = dir.join(BOOT_FILE);
    let Some(id) = active_id else {
        let _ = std::fs::remove_file(&file);
        return LaunchDecision { open: None, crash_loop: None };
    };
    let previous = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<BootMarker>(&b).ok()).filter(|m| m.id == id).map_or(0, |m| m.launches);
    if no_autoopen || previous >= CRASH_LOOP_AT {
        return LaunchDecision { open: None, crash_loop: Some(id.to_owned()) };
    }
    let marker = BootMarker { id: id.to_owned(), launches: previous + 1 };
    if let Ok(json) = serde_json::to_vec(&marker) {
        let _ = registry::fsutil::write_atomic(&file, &json, 0o600, None);
    }
    LaunchDecision { open: Some(id.to_owned()), crash_loop: None }
}

/// A freshly booted page: the launch worked.
pub fn mark_ready(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(BOOT_FILE));
}

// ---- startup -----------------------------------------------------------------------------------------------------------

fn no_autoopen() -> bool {
    std::env::var("INTELY_NO_AUTOOPEN").is_ok_and(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "" | "0" | "false"))
}

/// Opens the registry, decides what to open at launch, builds the engine and manages [`WorkspacesState`] (also in the
/// spike modes, where the engine stays disabled, so no command can panic on a missing state). Never fails: a registry
/// problem starts the app detached with the problem as data.
///
/// The picker's token table and validator are shared with `PickerState`, which `setup` creates first.
pub fn setup(app: &tauri::App, sink: Arc<dyn EventSink>, with_engine: bool) -> EngineSlot {
    let jail = Jail::global();
    let env = Env { night_queue: Some(agent_data_dir().join("night-queue.json")), ..Env::real() };
    let opened = Registry::open(Location::resolve(), jail.clone(), env);
    let registry = Arc::new(opened.registry);
    let (tokens, validator) = match app.try_state::<super::picker::PickerState>() {
        Some(p) => (p.tokens(), p.picker().validator.clone()),
        None => (Arc::new(PathTokens::new()), Validator::new(Policy::real(jail.clone()))),
    };
    let state = WorkspacesState::new(registry, tokens, validator, SwitchGate::real());
    let mut slot = EngineSlot(Err(EngineError::new(code::UNIMPLEMENTED, "the engine is disabled in the spike modes")));
    if with_engine {
        let (engine, active) = build_engine(&state, opened.active, sink, jail);
        state.set_active(active);
        slot = EngineSlot(Ok(engine));
    }
    app.manage(state.gate.clone());
    let active_handle: Arc<dyn ActiveWorkspace> = Arc::new(ActiveId(state.active.clone()));
    app.manage(active_handle);
    app.manage(Arc::new(state));
    slot
}

/// The launch decision and the engine for it. Returns the engine and the id of the workspace it opened.
fn build_engine(state: &WorkspacesState, active: Option<registry::ActiveWorkspace>, sink: Arc<dyn EventSink>, jail: Arc<Jail>) -> (Engine, Option<String>) {
    let registry = &state.registry;
    let protection: Arc<dyn ProtectionSource> = Arc::new(RegistryProtection(registry.clone()));
    let backup_dir = (!registry.is_pinned()).then(|| registry.backup_dir());
    let mut open = active;
    if !registry.is_pinned() {
        let id = open.as_ref().map(|a| a.id.clone());
        let decision = decide_launch(&registry.location().dir, id.as_deref(), no_autoopen());
        if let Some(blocked) = decision.crash_loop {
            let name = registry.view().workspaces.into_iter().find(|w| w.id == blocked).map_or_else(|| blocked.clone(), |w| w.name);
            state.launch.lock().expect("launch").crash_loop = Some(CrashLoopNotice { id: blocked, name });
            open = None;
        }
    }
    tauri::async_runtime::block_on(async move {
        if let Some(a) = open {
            match Engine::new_for(Some(a.path.clone()), backup_dir.clone(), sink.clone(), jail.clone(), protection.clone()) {
                Ok(engine) => return (engine, Some(a.id)),
                Err(_) => state.launch.lock().expect("launch").open_failure = Some(a.id),
            }
        }
        (Engine::new_detached_with_jail(sink, jail), None)
    })
}

// ---- enforcement helpers -------------------------------------------------------------------------------------------------

/// A late call from the page of a retired generation must not run against the new one: identity-derived repo ids are
/// valid in both. Absent (pinned mode, Remote) is accepted.
pub fn check_epoch(engine: &Engine, epoch: Option<u64>) -> Res<()> {
    match epoch {
        Some(e) if e != engine.epoch() => Err(EngineError::new(code::STALE_EPOCH, "this page belongs to an earlier workspace and is reloading")),
        _ => Ok(()),
    }
}

/// `workspace_save` accepts only (id, path) pairs the open workspace already has, and never two entries for one folder.
/// Removals, reorders, renames, colours, push targets and patterns pass; a new or changed path goes through the picker
/// (`workspaces_add_repos`, `workspaces_relocate_repo`).
pub fn check_save_allowed(registry: &Registry, current: &Workspace, next: &Workspace) -> Res<()> {
    for repo in &next.repos {
        if !current.repos.iter().any(|c| c.id == repo.id && c.path == repo.path) {
            return Err(EngineError::new(code::PATH_NOT_VALIDATED, "a folder can only be added through the folder picker").with_detail(repo.id.clone()));
        }
    }
    let mut seen = BTreeSet::new();
    for repo in &next.repos {
        let identity = registry.prober().identity(Path::new(&repo.path), Duration::from_secs(1)).unwrap_or_else(|| format!("p:{}", registry::repo_path_key(&repo.path)));
        if !seen.insert(identity) {
            return Err(EngineError::new(code::ALREADY_IN_WORKSPACE, "two entries point at the same folder").with_detail(repo.id.clone()));
        }
    }
    Ok(())
}

// ---- redeeming tokens -----------------------------------------------------------------------------------------------------

/// One repository to register; the token comes from the folder picker.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRedeem {
    pub token: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub badge: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub trust: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    pub repos: Vec<RepoRedeem>,
    #[serde(default)]
    pub origin: Option<WorkspaceOrigin>,
}

struct Redeemed {
    repo: NewRepo,
    /// Config keys that can run programs, and the hash of what the user accepted.
    risks: Vec<String>,
    trust_hash: String,
    validated: Validated,
}

const REPO_PURPOSES: [Purpose; 2] = [Purpose::WorkspaceRoot, Purpose::WorkspaceRepo];

fn trust_hash(v: &Validated) -> String {
    if v.risk_digest.is_empty() {
        registry::risk_hash(&v.config_risks)
    } else {
        v.risk_digest.clone()
    }
}

/// `<repo>/.git` (the common git directory a linked worktree reports) to the main working tree.
fn main_worktree(common_dir: &str) -> Option<String> {
    let p = Path::new(common_dir);
    (p.file_name()? == ".git").then(|| p.parent().map(|d| d.to_string_lossy().into_owned())).flatten()
}

/// Redeems tokens into registrable repositories. The trust rule is checked on the peeked token first, so a missing
/// tick does not use the token up; `redeem` then re-validates (`riskChanged`, `pathNotValidated` on a swapped folder).
fn redeem_repos(state: &WorkspacesState, repos: &[RepoRedeem]) -> Res<Vec<Redeemed>> {
    let mut out = Vec::with_capacity(repos.len());
    for r in repos {
        if let Some((peeked, _)) = state.tokens.peek(&r.token) {
            if !peeked.config_risks.is_empty() && r.trust != Some(true) {
                return Err(EngineError::new(code::TRUST_REQUIRED, "tick \"I trust this repository\" first").with_detail(peeked.path.to_string_lossy().into_owned()));
            }
        }
        let got = state.tokens.redeem(&r.token, &REPO_PURPOSES, &state.validator)?;
        let v = got.validated;
        let kind = match v.kind {
            PathKind::Repo => RepoKind::Repo,
            PathKind::Worktree => RepoKind::Worktree,
            PathKind::Submodule => RepoKind::Submodule,
            PathKind::Bare => return Err(EngineError::new(pick_codes::BARE_REPO, "a bare repository has no working tree")),
            PathKind::NotGit => return Err(EngineError::new(pick_codes::NOT_GIT, "not a Git repository")),
            _ => return Err(EngineError::new(pick_codes::PATH_NOT_VALIDATED, "choose the repository folder itself").with_detail(v.path.to_string_lossy().into_owned())),
        };
        // a token that carried risks must still have the tick (the peek misses an entry that has just expired)
        if !v.config_risks.is_empty() && r.trust != Some(true) {
            return Err(EngineError::new(code::TRUST_REQUIRED, "tick \"I trust this repository\" first").with_detail(v.path.to_string_lossy().into_owned()));
        }
        let repo = ValidatedRepo {
            canonical_path: v.path.to_string_lossy().into_owned(),
            suggested_name: v.name.clone(),
            identity: v.identity.clone(),
            kind,
            main: v.main.as_deref().and_then(main_worktree),
        };
        out.push(Redeemed {
            repo: NewRepo { repo, name: r.name.clone(), badge: r.badge.clone(), color: r.color.clone() },
            risks: v.config_risks.clone(),
            trust_hash: trust_hash(&v),
            validated: v,
        });
    }
    Ok(out)
}

/// Remembers what the user accepted for every risky repository (a later open can notice a changed set).
fn remember_trust(state: &WorkspacesState, redeemed: &[Redeemed]) {
    for r in redeemed.iter().filter(|r| !r.risks.is_empty()) {
        let _ = state.registry.trust_accept(&r.repo.repo.canonical_path, &r.trust_hash);
    }
}

fn unique_name(base: &str, taken: &[String]) -> String {
    let key = |n: &str| registry::model::name_key(n);
    let taken: BTreeSet<String> = taken.iter().map(|n| key(n)).collect();
    let base = registry::model::normalize_name(base).unwrap_or_else(|_| "Workspace".to_owned());
    if !taken.contains(&key(&base)) {
        return base;
    }
    (2..).map(|n| format!("{base} ({n})")).find(|c| !taken.contains(&key(c))).expect("an unused name exists")
}

// ---- the registry commands, as plain functions -------------------------------------------------------------------------------

/// `workspaces_create`: tokens in, a workspace out. A workspace that already holds exactly these folders is returned
/// (`reused`) instead of a duplicate.
pub fn create_workspace(state: &WorkspacesState, req: CreateRequest) -> Res<CreateResult> {
    let redeemed = redeem_repos(state, &req.repos)?;
    if !redeemed.is_empty() {
        let ids: Vec<String> = redeemed.iter().map(|r| r.repo.repo.identity.clone()).collect();
        if let Some(entry) = state.registry.find_by_identity(&ids) {
            return Ok(CreateResult { entry, reused: true });
        }
    }
    let name = if req.name.trim().is_empty() {
        let taken: Vec<String> = state.registry.view().workspaces.into_iter().map(|w| w.name).collect();
        unique_name(redeemed.first().map_or("Workspace", |r| r.repo.repo.suggested_name.as_str()), &taken)
    } else {
        req.name
    };
    let origin = req.origin.unwrap_or(match redeemed.len() {
        1 => WorkspaceOrigin::OpenedFolder,
        _ => WorkspaceOrigin::Created,
    });
    let entry = state.registry.create(NewWorkspace { name, color: req.color, repos: redeemed.iter().map(|r| r.repo.clone()).collect(), origin })?;
    remember_trust(state, &redeemed);
    Ok(CreateResult { entry, reused: false })
}

/// `workspaces_add_repos`: registers repositories in the open workspace through the engine's save path.
pub async fn add_repos(state: &Arc<WorkspacesState>, engine: &Engine, epoch: Option<u64>, repos: Vec<RepoRedeem>) -> Res<Workspace> {
    check_epoch(engine, epoch)?;
    if engine.is_detached() {
        return Err(EngineError::new(code::NO_WORKSPACE, "no workspace is open"));
    }
    let current = engine.workspace_get().await?;
    let st = state.clone();
    let (redeemed, (mut next, configs)) = blocking(move || {
        let redeemed = redeem_repos(&st, &repos)?;
        let new: Vec<NewRepo> = redeemed.iter().map(|r| r.repo.clone()).collect();
        let configs = st.registry.build_repo_configs(&current, &new)?;
        Ok((redeemed, (current, configs)))
    })
    .await?;
    next.repos.extend(configs);
    let saved = engine.workspace_save(next).await?;
    remember_trust(state, &redeemed);
    Ok(saved)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelocateRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub repo_id: String,
    pub token: String,
    #[serde(default)]
    pub trust: Option<bool>,
    #[serde(default)]
    pub confirm_different: Option<bool>,
}

/// Hosts of the remotes a folder is configured with (credentials are already stripped by the validator).
fn remote_hosts(v: &Validated) -> BTreeSet<String> {
    v.remotes.iter().map(|r| r.host.to_lowercase()).collect()
}

/// Whether the replacement folder looks like another repository than the old one: both have remotes and they share no
/// host, or the old folder cannot be read at all. Push marks and targets would otherwise move to another repository.
pub fn looks_different(state: &WorkspacesState, old_path: &Path, new: &Validated) -> bool {
    let Ok(old) = state.validator.validate_path(old_path, &Purpose::WorkspaceRepo) else { return true };
    let (a, b) = (remote_hosts(&old), remote_hosts(new));
    !a.is_empty() && !b.is_empty() && a.is_disjoint(&b)
}

/// `workspaces_relocate_repo`: a vanished folder is replaced by a picked one, the repo keeps its id.
pub async fn relocate_repo(state: &Arc<WorkspacesState>, engine: &Engine, epoch: Option<u64>, req: RelocateRequest) -> Res<()> {
    check_epoch(engine, epoch)?;
    let active = state.active_id();
    let target = req.workspace_id.clone().filter(|id| Some(id) != active.as_ref());
    let current = match &target {
        None => {
            if engine.is_detached() {
                return Err(EngineError::new(code::NO_WORKSPACE, "no workspace is open"));
            }
            engine.workspace_get().await?
        }
        Some(id) => state.registry.load_workspace(id)?,
    };
    let old = current.repos.iter().find(|r| r.id == req.repo_id).ok_or_else(|| EngineError::new(code::REPO_MISSING, format!("unknown repo {}", req.repo_id)))?.clone();
    let st = state.clone();
    let (token, trust, old_path) = (req.token.clone(), req.trust, PathBuf::from(&old.path));
    let (redeemed, different) = blocking(move || {
        let r = redeem_repos(&st, &[RepoRedeem { token, name: None, badge: None, color: None, trust }])?.remove(0);
        let different = looks_different(&st, &old_path, &r.validated);
        Ok((r, different))
    })
    .await?;
    if different && req.confirm_different != Some(true) {
        return Err(EngineError::new(code::CONFIRM_REQUIRED, "this folder looks like a different repository")
            .with_detail(format!("{} -> {}", old.path, redeemed.repo.repo.canonical_path)));
    }
    let new_path = redeemed.repo.repo.canonical_path.clone();
    let mut next = current.clone();
    if let Some(r) = next.repos.iter_mut().find(|r| r.id == req.repo_id) {
        r.path = new_path.clone();
    }
    // the new folder must not already be another entry of this workspace
    let st = state.clone();
    let probe = next.clone();
    blocking(move || check_save_allowed_dups(&st.registry, &probe)).await?;
    match target {
        None => {
            engine.workspace_save(next).await?;
        }
        Some(id) => {
            let st = state.clone();
            let (repo_id, path) = (req.repo_id.clone(), new_path);
            blocking(move || {
                st.registry
                    .update_workspace(&id, |ws| {
                        if let Some(r) = ws.repos.iter_mut().find(|r| r.id == repo_id) {
                            r.path = path;
                        }
                        Ok(())
                    })
                    .map(drop)
            })
            .await?;
        }
    }
    remember_trust(state, &[redeemed]);
    Ok(())
}

/// Two entries of one workspace must not point at the same folder (by identity, so symlinks and case variants count).
fn check_save_allowed_dups(registry: &Registry, ws: &Workspace) -> Res<()> {
    let mut seen = BTreeSet::new();
    for r in &ws.repos {
        let id = registry.prober().identity(Path::new(&r.path), Duration::from_secs(1)).unwrap_or_else(|| format!("p:{}", registry::repo_path_key(&r.path)));
        if !seen.insert(id) {
            return Err(EngineError::new(code::ALREADY_IN_WORKSPACE, "that folder is already in the workspace"));
        }
    }
    Ok(())
}

/// The folder of a registered repo, from the registry only (never a path from the webview).
pub fn repo_path_in_registry(state: &WorkspacesState, workspace_id: &str, repo_id: &str) -> Res<PathBuf> {
    let ws = state.registry.load_workspace(workspace_id)?;
    ws.repos.iter().find(|r| r.id == repo_id).map(|r| PathBuf::from(&r.path)).ok_or_else(|| EngineError::new(code::REPO_MISSING, format!("unknown repo {repo_id}")))
}

/// Repo ids whose accepted risk set differs from what the repository's config says now (`ws.trustChanged`).
pub fn changed_trust(state: &WorkspacesState, ws: &Workspace) -> Vec<String> {
    ws.repos
        .iter()
        .filter(|r| {
            let Ok(v) = state.validator.validate_path(Path::new(&r.path), &Purpose::WorkspaceRepo) else { return false };
            !v.config_risks.is_empty() && state.registry.trust_state(&r.path, &trust_hash(&v)) == registry::TrustState::Changed
        })
        .map(|r| r.id.clone())
        .collect()
}

// ---- Tauri commands ------------------------------------------------------------------------------------------------------------

fn notify_changed(app: &AppHandle, state: &WorkspacesState) {
    let rev = state.registry.view().rev;
    let _ = app.emit("workspaces:changed", serde_json::json!({ "rev": rev }));
}

#[tauri::command]
pub async fn workspaces_list(slot: State<'_, EngineSlot>, state: State<'_, Arc<WorkspacesState>>) -> Res<RegistryView> {
    let st = state.inner().clone();
    let epoch = slot.get().ok().map(Engine::epoch);
    blocking(move || Ok(st.decorate(st.registry.view(), epoch))).await
}

#[tauri::command]
pub async fn workspaces_probe(state: State<'_, Arc<WorkspacesState>>, ids: Option<Vec<String>>) -> Res<Vec<WorkspaceProbe>> {
    let st = state.inner().clone();
    blocking(move || Ok(st.registry.probe(ids.as_deref(), PROBE_TOTAL))).await
}

#[tauri::command]
pub async fn workspaces_create(app: AppHandle, state: State<'_, Arc<WorkspacesState>>, req: CreateRequest) -> Res<CreateResult> {
    let st = state.inner().clone();
    let out = blocking({
        let st = st.clone();
        move || create_workspace(&st, req)
    })
    .await?;
    notify_changed(&app, &st);
    Ok(out)
}

#[tauri::command]
pub async fn workspaces_rename(app: AppHandle, state: State<'_, Arc<WorkspacesState>>, id: String, name: String) -> Res<WorkspaceEntry> {
    let st = state.inner().clone();
    let out = blocking({
        let st = st.clone();
        move || st.registry.rename(&id, &name)
    })
    .await?;
    notify_changed(&app, &st);
    Ok(out)
}

#[tauri::command]
pub async fn workspaces_recolor(app: AppHandle, state: State<'_, Arc<WorkspacesState>>, id: String, color: String) -> Res<WorkspaceEntry> {
    let st = state.inner().clone();
    let out = blocking({
        let st = st.clone();
        move || st.registry.recolor(&id, &color)
    })
    .await?;
    notify_changed(&app, &st);
    Ok(out)
}

#[tauri::command]
pub async fn workspaces_duplicate(app: AppHandle, state: State<'_, Arc<WorkspacesState>>, id: String, name: Option<String>) -> Res<WorkspaceEntry> {
    let st = state.inner().clone();
    let out = blocking({
        let st = st.clone();
        move || st.registry.duplicate(&id, name.as_deref())
    })
    .await?;
    notify_changed(&app, &st);
    Ok(out)
}

#[tauri::command]
pub async fn workspaces_remove(app: AppHandle, state: State<'_, Arc<WorkspacesState>>, id: String, confirm: bool) -> Res<()> {
    let st = state.inner().clone();
    // the registry refuses the id it records as active; the engine's own open workspace is checked here as well
    if st.active_id().as_deref() == Some(id.as_str()) {
        return Err(EngineError::new(code::WORKSPACE_ACTIVE, "close the workspace before removing it"));
    }
    blocking({
        let st = st.clone();
        move || st.registry.remove(&id, confirm)
    })
    .await?;
    notify_changed(&app, &st);
    Ok(())
}

#[tauri::command]
pub async fn workspaces_reorder(app: AppHandle, state: State<'_, Arc<WorkspacesState>>, ids: Vec<String>) -> Res<()> {
    let st = state.inner().clone();
    blocking({
        let st = st.clone();
        move || st.registry.reorder(&ids)
    })
    .await?;
    notify_changed(&app, &st);
    Ok(())
}

/// A freshly booted page: clears the crash-loop marker and the switching gate. A page of an earlier generation
/// (`staleEpoch`) changes neither.
#[tauri::command]
pub async fn workspaces_ready(slot: State<'_, EngineSlot>, state: State<'_, Arc<WorkspacesState>>, epoch: Option<u64>) -> Res<()> {
    if let Ok(engine) = slot.get() {
        check_epoch(engine, epoch)?;
    }
    state.gate.clear();
    if !state.registry.is_pinned() {
        mark_ready(&state.registry.location().dir);
    }
    Ok(())
}

#[tauri::command]
pub async fn workspaces_add_repos(slot: State<'_, EngineSlot>, state: State<'_, Arc<WorkspacesState>>, repos: Vec<RepoRedeem>, epoch: Option<u64>) -> Res<Workspace> {
    add_repos(state.inner(), slot.get()?, epoch, repos).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn workspaces_relocate_repo(
    slot: State<'_, EngineSlot>,
    state: State<'_, Arc<WorkspacesState>>,
    workspace_id: Option<String>,
    repo_id: String,
    token: String,
    trust: Option<bool>,
    confirm_different: Option<bool>,
    epoch: Option<u64>,
) -> Res<()> {
    relocate_repo(state.inner(), slot.get()?, epoch, RelocateRequest { workspace_id, repo_id, token, trust, confirm_different }).await
}

/// Opens the repo's folder in Finder. The path comes from the registry, never from the webview; a test jail never opens one.
#[tauri::command]
pub async fn workspaces_reveal(state: State<'_, Arc<WorkspacesState>>, workspace_id: String, repo_id: String) -> Res<()> {
    if Jail::global().mode() == Mode::E2e {
        return Err(EngineError::new(intely_core::jail::TEST_JAIL, "test jail (INTELY_E2E): Finder is not opened"));
    }
    let st = state.inner().clone();
    let path = blocking(move || repo_path_in_registry(&st, &workspace_id, &repo_id)).await?;
    blocking(move || {
        std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg("--")
            .arg(&path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map(drop)
            .map_err(|e| EngineError::new(code::IO, format!("cannot reveal {}: {e}", path.display())))
    })
    .await
}

#[tauri::command]
pub async fn workspaces_restore_backup(app: AppHandle, slot: State<'_, EngineSlot>, state: State<'_, Arc<WorkspacesState>>, backup_name: String) -> Res<RegistryView> {
    let st = state.inner().clone();
    let epoch = slot.get().ok().map(Engine::epoch);
    let view = blocking({
        let st = st.clone();
        move || {
            st.registry.restore_backup(&backup_name)?;
            Ok(st.decorate(st.registry.view(), epoch))
        }
    })
    .await?;
    notify_changed(&app, &st);
    Ok(view)
}

#[tauri::command]
pub async fn workspaces_start_fresh(app: AppHandle, slot: State<'_, EngineSlot>, state: State<'_, Arc<WorkspacesState>>) -> Res<RegistryView> {
    let st = state.inner().clone();
    let epoch = slot.get().ok().map(Engine::epoch);
    let view = blocking({
        let st = st.clone();
        move || {
            st.registry.start_fresh()?;
            Ok(st.decorate(st.registry.view(), epoch))
        }
    })
    .await?;
    notify_changed(&app, &st);
    Ok(view)
}

/// The hardened `workspace_save` (I1): only (id, path) pairs the open workspace already has are accepted; a changed
/// path goes through `workspaces_relocate_repo`, a new repository through `workspaces_add_repos`.
#[tauri::command]
pub async fn workspace_save(slot: State<'_, EngineSlot>, state: State<'_, Arc<WorkspacesState>>, ws: Workspace, epoch: Option<u64>) -> Res<Workspace> {
    let engine = slot.get()?;
    check_epoch(engine, epoch)?;
    let current = engine.workspace_get().await?;
    let st = state.inner().clone();
    let next = ws.clone();
    blocking(move || check_save_allowed(&st.registry, &current, &next)).await?;
    engine.workspace_save(ws).await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use intely_core::registry::{Location, TrustState};
    use intely_pathpick::{FakeClock as TokenClock, Picked, Policy};

    use super::*;
    use crate::modules::switchhook::testing::FakeClock;

    fn next_id() -> String {
        static SEQ: AtomicU32 = AtomicU32::new(1);
        format!("w{:05}", SEQ.fetch_add(1, Ordering::SeqCst))
    }

    struct Fx {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        dir: PathBuf,
        home: PathBuf,
        state: Arc<WorkspacesState>,
        clock: Arc<TokenClock>,
    }

    fn fx() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let (dir, home) = (root.join("state"), root.join("home"));
        std::fs::create_dir_all(&home).unwrap();
        let loc = Location { registry: dir.join("workspaces.json"), pinned: None, dir: dir.clone(), env_ignored: false };
        let opened = Registry::open(loc, Arc::new(Jail::off()), Env { new_id: next_id, ..Env::real() });
        let clock = Arc::new(TokenClock::new(1_000));
        let tokens = Arc::new(PathTokens::with_clock(clock.clone()));
        let validator = Validator::new(Policy::new(Arc::new(Jail::off()), home.clone(), dir.clone()));
        let state = Arc::new(WorkspacesState::new(Arc::new(opened.registry), tokens, validator, SwitchGate::new(Arc::new(FakeClock::new()))));
        Fx { _tmp: tmp, root, dir, home, state, clock }
    }

    impl Fx {
        fn repo(&self, name: &str) -> PathBuf {
            let p = self.root.join("repos").join(name);
            std::fs::create_dir_all(p.join(".git")).unwrap();
            std::fs::write(p.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
            std::fs::write(p.join(".git/config"), "[core]\n\trepositoryformatversion = 0\n[remote \"origin\"]\n\turl = https://example.com/org/repo.git\n").unwrap();
            p
        }

        fn risky(&self, name: &str) -> PathBuf {
            let p = self.repo(name);
            std::fs::write(p.join(".git/config"), "[core]\n\tfsmonitor = /tmp/evil-monitor\n").unwrap();
            p
        }

        fn pick(&self, path: &Path) -> Picked {
            self.pick_for(path, &Purpose::WorkspaceRepo)
        }

        fn pick_for(&self, path: &Path, purpose: &Purpose) -> Picked {
            let v = self.state.validator.validate(&path.to_string_lossy(), purpose).expect("valid");
            self.state.tokens.issue(v, purpose)
        }

        fn red(&self, path: &Path) -> RepoRedeem {
            RepoRedeem { token: self.pick(path).token, name: None, badge: None, color: None, trust: None }
        }

        fn create(&self, name: &str, paths: &[&Path]) -> Res<CreateResult> {
            create_workspace(&self.state, CreateRequest { name: name.into(), color: None, repos: paths.iter().map(|p| self.red(p)).collect(), origin: None })
        }
    }

    struct NoSink;
    impl EventSink for NoSink {
        fn snapshot(&self, _: intely_core::RepoSnapshot) {}
        fn op_event(&self, _: intely_core::OpEvent) {}
        fn op_result(&self, _: intely_core::OpResult) {}
        fn env(&self, _: intely_core::EnvStatus) {}
    }

    /// An engine with the registry workspace `id` open.
    fn engine_for(f: &Fx, id: &str) -> Engine {
        let path = f.state.registry.workspace_path(id).unwrap();
        f.state.set_active(Some(id.to_owned()));
        tauri::async_runtime::block_on(async { Engine::new_for(Some(path), None, Arc::new(NoSink), Arc::new(Jail::off()), Arc::new(RegistryProtection(f.state.registry.clone()))).unwrap() })
    }

    // ---- tokens -------------------------------------------------------------------------------------------------------

    #[test]
    fn a_forged_reused_expired_or_wrong_purpose_token_registers_nothing() {
        let f = fx();
        let repo = f.repo("r");
        let forged = RepoRedeem { token: "0123456789abcdef0123456789abcdef".into(), name: None, badge: None, color: None, trust: None };
        let e = create_workspace(&f.state, CreateRequest { name: "x".into(), color: None, repos: vec![forged], origin: None }).unwrap_err();
        assert_eq!(e.code, pick_codes::PATH_NOT_VALIDATED);

        let red = f.red(&repo);
        let req = |r: &RepoRedeem| CreateRequest { name: "ok".into(), color: None, repos: vec![r.clone()], origin: None };
        assert!(create_workspace(&f.state, req(&red)).is_ok());
        assert_eq!(create_workspace(&f.state, req(&red)).unwrap_err().code, pick_codes::TOKEN_USED, "single use");

        let stale = f.red(&repo);
        f.clock.advance(5 * 60 * 1000 + 1);
        assert_eq!(create_workspace(&f.state, req(&stale)).unwrap_err().code, pick_codes::TOKEN_EXPIRED);

        let wrong = RepoRedeem { token: f.pick_for(&repo, &Purpose::ScanRoot).token, name: None, badge: None, color: None, trust: None };
        assert_eq!(create_workspace(&f.state, req(&wrong)).unwrap_err().code, pick_codes::WRONG_PURPOSE);

        let file_token = {
            let file = f.root.join("a-file");
            std::fs::write(&file, "x").unwrap();
            RepoRedeem { token: f.pick_for(&file, &Purpose::File("caFile".into())).token, name: None, badge: None, color: None, trust: None }
        };
        assert_eq!(create_workspace(&f.state, req(&file_token)).unwrap_err().code, pick_codes::WRONG_PURPOSE, "a file handle is not a repository");
        assert_eq!(f.state.registry.view().workspaces.len(), 1, "only the one valid create registered something");
    }

    #[test]
    fn non_repositories_are_refused_even_with_a_valid_token() {
        let f = fx();
        let plain = f.root.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let e = create_workspace(&f.state, CreateRequest { name: "x".into(), color: None, repos: vec![f.red(&plain)], origin: None }).unwrap_err();
        assert_eq!(e.code, pick_codes::NOT_GIT);
        // a subfolder of a repository: the UI must send the root token instead
        let repo = f.repo("r");
        let sub = repo.join("src");
        std::fs::create_dir_all(&sub).unwrap();
        let e = create_workspace(&f.state, CreateRequest { name: "x".into(), color: None, repos: vec![f.red(&sub)], origin: None }).unwrap_err();
        assert_eq!(e.code, pick_codes::PATH_NOT_VALIDATED);
        assert!(f.state.registry.view().workspaces.is_empty());
    }

    #[test]
    fn a_repository_that_can_run_programs_needs_the_trust_tick_and_does_not_use_up_its_token() {
        let f = fx();
        let evil = f.risky("evil");
        let picked = f.pick(&evil);
        assert!(picked.config_risks.contains(&"core.fsmonitor".to_owned()), "{:?}", picked.config_risks);
        let mut red = RepoRedeem { token: picked.token.clone(), name: None, badge: None, color: None, trust: None };
        let req = |r: &RepoRedeem| CreateRequest { name: "evil ws".into(), color: None, repos: vec![r.clone()], origin: None };
        for trust in [None, Some(false)] {
            red.trust = trust;
            let e = create_workspace(&f.state, req(&red)).unwrap_err();
            assert_eq!(e.code, code::TRUST_REQUIRED, "{trust:?}");
        }
        red.trust = Some(true);
        let made = create_workspace(&f.state, req(&red)).expect("the same token still works after the tick");
        assert!(!made.reused);
        // what the user accepted is remembered
        let path = evil.canonicalize().unwrap().to_string_lossy().into_owned();
        let v = f.state.validator.validate(&path, &Purpose::WorkspaceRepo).unwrap();
        assert_eq!(f.state.registry.trust_state(&path, &trust_hash(&v)), TrustState::Trusted);
        // and a later change of the risk set is noticed
        std::fs::write(evil.join(".git/config"), "[core]\n\tfsmonitor = /tmp/evil-monitor\n[filter \"x\"]\n\tclean = rm -rf\n").unwrap();
        let ws = f.state.registry.load_workspace(&made.entry.id).unwrap();
        assert_eq!(changed_trust(&f.state, &ws), vec![ws.repos[0].id.clone()]);
    }

    #[test]
    fn a_config_edit_between_the_card_and_the_confirm_is_risk_changed() {
        let f = fx();
        let repo = f.repo("r");
        let red = f.red(&repo);
        std::fs::write(repo.join(".git/config"), "[core]\n\tsshCommand = ssh -o ProxyCommand=evil\n").unwrap();
        let e = create_workspace(&f.state, CreateRequest { name: "x".into(), color: None, repos: vec![RepoRedeem { trust: Some(true), ..red }], origin: None }).unwrap_err();
        assert_eq!(e.code, code::RISK_CHANGED);
        assert!(f.state.registry.view().workspaces.is_empty());
    }

    #[test]
    fn the_same_folders_are_reused_by_identity_instead_of_duplicated() {
        let f = fx();
        let (a, b) = (f.repo("a"), f.repo("b"));
        let first = f.create("Both", &[&a, &b]).unwrap();
        assert!(!first.reused);
        let again = f.create("Another name", &[&b, &a]).unwrap();
        assert!(again.reused && again.entry.id == first.entry.id, "same folders in any order");
        assert_eq!(f.state.registry.view().workspaces.len(), 1);
        // one of them alone is a new workspace, and it shares the repo id of the first
        let solo = f.create("", &[&a]).unwrap();
        assert!(!solo.reused);
        assert_eq!(solo.entry.name, "a", "named after the folder");
        assert_eq!(solo.entry.origin, WorkspaceOrigin::OpenedFolder);
        let ids = |id: &str| f.state.registry.load_workspace(id).unwrap().repos.into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(ids(&solo.entry.id)[0], ids(&first.entry.id)[0], "identity-derived ids are shared");
        // a second open of the same name gets a numbered name
        let other = f.repo("other");
        std::fs::create_dir_all(f.root.join("elsewhere/a/.git")).unwrap();
        std::fs::write(f.root.join("elsewhere/a/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let _ = other;
        let twin = f.create("", &[&f.root.join("elsewhere/a")]).unwrap();
        assert_eq!(twin.entry.name, "a (2)");
    }

    // ---- workspace_save ---------------------------------------------------------------------------------------------------

    #[test]
    fn workspace_save_refuses_new_paths_swapped_pairs_and_duplicate_identities_but_accepts_removals() {
        let f = fx();
        let (a, b, c) = (f.repo("a"), f.repo("b"), f.repo("c"));
        let made = f.create("W", &[&a, &b]).unwrap();
        let current = f.state.registry.load_workspace(&made.entry.id).unwrap();

        // a path nobody picked
        let mut sneaky = current.clone();
        sneaky.repos[0].path = c.to_string_lossy().into_owned();
        assert_eq!(check_save_allowed(&f.state.registry, &current, &sneaky).unwrap_err().code, code::PATH_NOT_VALIDATED);
        // a whole new repo entry
        let mut extra = current.clone();
        let mut r = current.repos[0].clone();
        r.id = "brand-new".into();
        r.path = c.to_string_lossy().into_owned();
        extra.repos.push(r);
        assert_eq!(check_save_allowed(&f.state.registry, &current, &extra).unwrap_err().code, code::PATH_NOT_VALIDATED);
        // two repos swap their paths: every (id, path) pair is new
        let mut swapped = current.clone();
        let (pa, pb) = (swapped.repos[0].path.clone(), swapped.repos[1].path.clone());
        swapped.repos[0].path = pb;
        swapped.repos[1].path = pa;
        assert_eq!(check_save_allowed(&f.state.registry, &current, &swapped).unwrap_err().code, code::PATH_NOT_VALIDATED);
        // one folder under two ids
        let mut dup = current.clone();
        let mut twin = current.repos[0].clone();
        twin.id = "twin".into();
        dup.repos.push(twin);
        assert!(check_save_allowed(&f.state.registry, &current, &dup).is_err());
        // the same folder reached through a symlink under a known pair is not a known pair either
        // renames, recolours, reorders, push targets and removals pass
        let mut ok = current.clone();
        ok.repos[0].name = "Renamed".into();
        ok.repos[0].color = "#112233".into();
        ok.repos.reverse();
        ok.protected_branches.push("custom/*".into());
        assert!(check_save_allowed(&f.state.registry, &current, &ok).is_ok());
        let mut removed = current.clone();
        removed.repos.remove(0);
        assert!(check_save_allowed(&f.state.registry, &current, &removed).is_ok());
        let mut none = current.clone();
        none.repos.clear();
        assert!(check_save_allowed(&f.state.registry, &current, &none).is_ok());
    }

    #[test]
    fn stale_epochs_are_refused_and_absent_ones_accepted() {
        let f = fx();
        let made = f.create("W", &[&f.repo("a")]).unwrap();
        let engine = engine_for(&f, &made.entry.id);
        let now = engine.epoch();
        assert!(check_epoch(&engine, None).is_ok());
        assert!(check_epoch(&engine, Some(now)).is_ok());
        assert_eq!(check_epoch(&engine, Some(now + 1)).unwrap_err().code, code::STALE_EPOCH);
        assert_eq!(check_epoch(&engine, Some(now - 1)).unwrap_err().code, code::STALE_EPOCH);
        // and after a switch the old epoch is stale
        tauri::async_runtime::block_on(engine.switch_workspace(None, None)).unwrap();
        assert_eq!(check_epoch(&engine, Some(now)).unwrap_err().code, code::STALE_EPOCH);
        let st = f.state.clone();
        let e = tauri::async_runtime::block_on(add_repos(&st, &engine, Some(now), vec![])).unwrap_err();
        assert_eq!(e.code, code::STALE_EPOCH);
    }

    // ---- add repos and relocate ----------------------------------------------------------------------------------------------

    #[test]
    fn add_repos_goes_through_the_picker_token_and_the_engine_and_refuses_a_duplicate_folder() {
        let f = fx();
        let (a, b) = (f.repo("a"), f.repo("b"));
        let made = f.create("W", &[&a]).unwrap();
        let engine = engine_for(&f, &made.entry.id);
        let st = f.state.clone();
        let saved = tauri::async_runtime::block_on(add_repos(&st, &engine, None, vec![f.red(&b)])).unwrap();
        assert_eq!(saved.repos.len(), 2);
        assert_eq!(saved.repos[1].path, b.canonicalize().unwrap().to_string_lossy());
        assert_eq!(saved.repos[1].order, 1);
        assert_eq!(f.state.registry.load_workspace(&made.entry.id).unwrap().repos.len(), 2, "persisted");
        // the same folder again, under a fresh token
        let e = tauri::async_runtime::block_on(add_repos(&st, &engine, None, vec![f.red(&b)])).unwrap_err();
        assert_eq!(e.code, code::ALREADY_IN_WORKSPACE);
        // a trust-requiring folder without the tick
        let evil = f.risky("evil");
        let e = tauri::async_runtime::block_on(add_repos(&st, &engine, None, vec![f.red(&evil)])).unwrap_err();
        assert_eq!(e.code, code::TRUST_REQUIRED);
        assert_eq!(tauri::async_runtime::block_on(engine.workspace_get()).unwrap().repos.len(), 2);
        // detached: nothing to add to
        tauri::async_runtime::block_on(engine.switch_workspace(None, None)).unwrap();
        assert_eq!(tauri::async_runtime::block_on(add_repos(&st, &engine, None, vec![f.red(&f.repo("late"))])).unwrap_err().code, code::NO_WORKSPACE);
    }

    #[test]
    fn relocating_a_vanished_folder_keeps_the_id_and_needs_confirmation_for_a_different_repository() {
        let f = fx();
        let (a, b) = (f.repo("a"), f.repo("b"));
        let made = f.create("W", &[&a, &b]).unwrap();
        let engine = engine_for(&f, &made.entry.id);
        let st = f.state.clone();
        let ids: Vec<String> = f.state.registry.load_workspace(&made.entry.id).unwrap().repos.iter().map(|r| r.id.clone()).collect();

        // the repo is re-cloned elsewhere (same remote) while the old folder is still there: no confirmation needed
        let copy = f.root.join("copy/a");
        std::fs::create_dir_all(copy.join(".git")).unwrap();
        for file in ["HEAD", "config"] {
            std::fs::copy(a.join(".git").join(file), copy.join(".git").join(file)).unwrap();
        }
        let req = |token: String, confirm: Option<bool>| RelocateRequest { workspace_id: None, repo_id: ids[0].clone(), token, trust: None, confirm_different: confirm };
        tauri::async_runtime::block_on(relocate_repo(&st, &engine, None, req(f.pick(&copy).token, None))).expect("same remote host: no confirmation");
        let ws = tauri::async_runtime::block_on(engine.workspace_get()).unwrap();
        assert_eq!((ws.repos[0].id.clone(), ws.repos[0].path.clone()), (ids[0].clone(), copy.canonicalize().unwrap().to_string_lossy().into_owned()));

        // the folder vanished: the old side is unknown, so the move must be confirmed
        let moved = f.root.join("moved/b");
        std::fs::create_dir_all(moved.parent().unwrap()).unwrap();
        std::fs::rename(&b, &moved).unwrap();
        let req_b = |token: String, confirm: Option<bool>| RelocateRequest { workspace_id: None, repo_id: ids[1].clone(), token, trust: None, confirm_different: confirm };
        let e = tauri::async_runtime::block_on(relocate_repo(&st, &engine, None, req_b(f.pick(&moved).token, None))).unwrap_err();
        assert_eq!(e.code, code::CONFIRM_REQUIRED);
        tauri::async_runtime::block_on(relocate_repo(&st, &engine, None, req_b(f.pick(&moved).token, Some(true)))).unwrap();
        let ws = tauri::async_runtime::block_on(engine.workspace_get()).unwrap();
        assert_eq!((ws.repos[1].id.clone(), ws.repos[1].path.clone()), (ids[1].clone(), moved.canonicalize().unwrap().to_string_lossy().into_owned()));

        // a folder with another remote host looks like a different repository
        let stranger = f.repo("stranger");
        std::fs::write(stranger.join(".git/config"), "[remote \"origin\"]\n\turl = https://other-host.test/x/y.git\n").unwrap();
        let e = tauri::async_runtime::block_on(relocate_repo(&st, &engine, None, req(f.pick(&stranger).token, None))).unwrap_err();
        assert_eq!(e.code, code::CONFIRM_REQUIRED);
        assert_eq!(tauri::async_runtime::block_on(engine.workspace_get()).unwrap().repos[0].path, copy.canonicalize().unwrap().to_string_lossy(), "nothing changed");
        tauri::async_runtime::block_on(relocate_repo(&st, &engine, None, req(f.pick(&stranger).token, Some(true)))).unwrap();
        // the replacement may not duplicate another entry (repo 0 now sits in `stranger`)
        let e = tauri::async_runtime::block_on(relocate_repo(&st, &engine, None, RelocateRequest { repo_id: ids[1].clone(), ..req(f.pick(&stranger).token, Some(true)) })).unwrap_err();
        assert_eq!(e.code, code::ALREADY_IN_WORKSPACE);
        // unknown repo
        let e = tauri::async_runtime::block_on(relocate_repo(&st, &engine, None, RelocateRequest { repo_id: "nope".into(), ..req(f.pick(&moved).token, Some(true)) })).unwrap_err();
        assert_eq!(e.code, code::REPO_MISSING);
    }

    #[test]
    fn a_workspace_that_is_not_open_is_relocated_through_the_registry() {
        let f = fx();
        let (a, b) = (f.repo("a"), f.repo("b"));
        let open = f.create("Open", &[&a]).unwrap();
        let other = f.create("Other", &[&b]).unwrap();
        let engine = engine_for(&f, &open.entry.id);
        let st = f.state.clone();
        let rid = f.state.registry.load_workspace(&other.entry.id).unwrap().repos[0].id.clone();
        let moved = f.root.join("moved-b");
        std::fs::rename(&b, &moved).unwrap();
        let req = |confirm| RelocateRequest { workspace_id: Some(other.entry.id.clone()), repo_id: rid.clone(), token: f.pick(&moved).token, trust: None, confirm_different: confirm };
        assert_eq!(tauri::async_runtime::block_on(relocate_repo(&st, &engine, None, req(None))).unwrap_err().code, code::CONFIRM_REQUIRED, "the old folder is gone");
        tauri::async_runtime::block_on(relocate_repo(&st, &engine, None, req(Some(true)))).unwrap();
        let ws = f.state.registry.load_workspace(&other.entry.id).unwrap();
        assert_eq!((ws.repos[0].id.clone(), ws.repos[0].path.clone()), (rid, moved.canonicalize().unwrap().to_string_lossy().into_owned()));
        assert_eq!(tauri::async_runtime::block_on(engine.workspace_get()).unwrap().repos.len(), 1, "the open workspace is untouched");
    }

    #[test]
    fn reveal_uses_only_registry_paths() {
        let f = fx();
        let a = f.repo("a");
        let made = f.create("W", &[&a]).unwrap();
        let rid = f.state.registry.load_workspace(&made.entry.id).unwrap().repos[0].id.clone();
        assert_eq!(repo_path_in_registry(&f.state, &made.entry.id, &rid).unwrap(), a.canonicalize().unwrap());
        assert_eq!(repo_path_in_registry(&f.state, &made.entry.id, "../../etc").unwrap_err().code, code::REPO_MISSING);
        assert_eq!(repo_path_in_registry(&f.state, "../x", &rid).unwrap_err().code, code::WORKSPACE_NOT_FOUND);
    }

    // ---- launch ----------------------------------------------------------------------------------------------------------------

    #[test]
    fn two_launches_that_never_reached_ready_start_on_welcome_and_ready_clears_the_marker() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        assert_eq!(decide_launch(dir, None, false), LaunchDecision { open: None, crash_loop: None });
        assert!(!dir.join(".boot").exists(), "nothing to guard when nothing opens");
        assert_eq!(decide_launch(dir, Some("w1"), false).open.as_deref(), Some("w1"), "first launch");
        assert_eq!(decide_launch(dir, Some("w1"), false).open.as_deref(), Some("w1"), "second launch, the first never finished");
        assert_eq!(decide_launch(dir, Some("w1"), false), LaunchDecision { open: None, crash_loop: Some("w1".into()) }, "third launch: crash loop");
        assert_eq!(decide_launch(dir, Some("w1"), false).crash_loop.as_deref(), Some("w1"), "and it stays so until a page is ready");
        mark_ready(dir);
        assert_eq!(decide_launch(dir, Some("w1"), false).open.as_deref(), Some("w1"));
        // another workspace is not blamed for w1's launches
        assert_eq!(decide_launch(dir, Some("w2"), false).open.as_deref(), Some("w2"));
        assert_eq!(decide_launch(dir, Some("w2"), false).open.as_deref(), Some("w2"));
        mark_ready(dir);
        // INTELY_NO_AUTOOPEN forces the same, without needing a crash
        assert_eq!(decide_launch(dir, Some("w2"), true), LaunchDecision { open: None, crash_loop: Some("w2".into()) });
        // a damaged marker counts as none
        std::fs::write(dir.join(".boot"), "{ nope").unwrap();
        assert_eq!(decide_launch(dir, Some("w2"), false).open.as_deref(), Some("w2"));
        mark_ready(dir);
        assert!(!dir.join(".boot").exists());
    }

    #[test]
    fn a_second_instance_sees_the_other_instance_problem_in_the_decorated_view() {
        let f = fx();
        let second = Registry::open(f.state.registry.location().clone(), Arc::new(Jail::off()), Env::real());
        let view = f.state.decorate(second.registry.view(), Some(7));
        assert_eq!(view.problem.unwrap().kind, intely_core::ProblemKind::OtherInstance);
        assert_eq!(view.epoch, Some(7));
        assert!(second.registry.create(NewWorkspace { name: "x".into(), color: None, repos: vec![], origin: WorkspaceOrigin::Created }).is_err());
    }

    #[test]
    fn the_decorated_view_carries_the_crash_loop_notice_until_it_is_cleared() {
        let f = fx();
        f.state.launch.lock().unwrap().crash_loop = Some(CrashLoopNotice { id: "w1".into(), name: "Happy".into() });
        let v = f.state.decorate(f.state.registry.view(), None);
        assert_eq!(v.crash_loop.unwrap().name, "Happy");
        f.state.clear_launch_notices();
        assert!(f.state.decorate(f.state.registry.view(), None).crash_loop.is_none());
    }

    // ---- T10 and the Remote -------------------------------------------------------------------------------------------------------

    #[test]
    fn the_agent_policy_and_the_registry_resolve_one_state_directory_and_refuse_every_state_file() {
        use intely_agent_core::policy::paths::Jail as PathJail;
        let home = "/Users/someone";
        let default_dir = PathBuf::from(home).join("Library/Application Support/IntelySwitchIDE");
        let vars = |pairs: &'static [(&'static str, &'static str)]| move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned());

        // default
        let v = vars(&[("HOME", "/Users/someone")]);
        assert_eq!(agent_data_dir_from(&v), default_dir);
        assert_eq!(Location::from_env(&v).dir, default_dir);
        // INTELY_DATA_DIR moves both
        let v = vars(&[("HOME", "/Users/someone"), ("INTELY_DATA_DIR", "/tmp/fx/data")]);
        assert_eq!(agent_data_dir_from(&v), PathBuf::from("/tmp/fx/data"));
        assert_eq!(Location::from_env(&v).dir, PathBuf::from("/tmp/fx/data"));
        // a jailed INTELY_WORKSPACES next to the data dir (what the fixtures do) agrees too
        let v = vars(&[("HOME", "/Users/someone"), ("INTELY_DATA_DIR", "/tmp/fx/data"), ("INTELY_WORKSPACES", "/tmp/fx/data/workspaces.json"), ("INTELY_E2E", "1")]);
        assert_eq!(agent_data_dir_from(&v), Location::from_env(&v).dir);

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().canonicalize().unwrap().join("state");
        std::fs::create_dir_all(&dir).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let repo = outside.path().canonicalize().unwrap().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let jail = PathJail::new(&repo, &[], Some(Path::new(home))).with_state_dir(Some(&dir));
        for rel in ["workspaces.json", "workspaces/w1.json", "workspaces/removed/w1-1759540000000.json", "backups/workspaces.1759540000000-r3.json", "trust.json", "live-floor.json", ".boot", ".app.lock", ".workspaces.lock", "night-queue-workspaces.json"] {
            let p = dir.join(rel);
            assert!(jail.never_read_reason(&p).is_some(), "an agent may read {rel}");
            assert!(jail.protected_reason(&p).is_some(), "an agent may write {rel}");
        }
        assert!(jail.never_read_reason(&repo.join("src/main.rs")).is_none(), "the repo itself stays readable");
    }

    #[test]
    fn the_remote_surface_has_no_workspace_or_picker_command() {
        // The phone speaks a closed message set (`ClientMsg`/`RemoteAction`); nothing forwards a Tauri command by name.
        for (name, text) in [
            ("modules/remote.rs", include_str!("remote.rs")),
            ("crates/remote wire", include_str!("../../../crates/remote/src/wire.rs")),
            ("crates/remote policy", include_str!("../../../crates/remote/src/policy.rs")),
            ("crates/remote gateway", include_str!("../../../crates/remote/src/gateway.rs")),
        ] {
            for forbidden in ["workspaces_", "picker_", "workspace:", "picker:", "workspace_save"] {
                assert!(!text.contains(forbidden), "{name} mentions {forbidden}");
            }
        }
    }
}
