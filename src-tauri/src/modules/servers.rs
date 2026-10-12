//! Tauri glue of Settings > Servers: the list in the settings, the probe and the setup over `ssh`, the repositories on a server.
//! `intely_servers` does the work over the system `ssh` (keys and agent from the person's own `~/.ssh/config`, no password prompt, an
//! unknown host key is an error with a hint); the runs themselves start in the agent host (`modules::agents` hands it the registry).
//!
//! Events: `servers:status {id, status}` when a probe or a setup ended, `servers:setup {id, step, state, message}` while a setup runs.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use intely_agent_core::api::RunStatus;
use intely_agent_host::{local_origin, ServerRegistry, ServersSupplier};
use intely_core::EngineError;
use intely_servers::{candidates_for, clone_repo_at, default_path, find_repos, probe, repo_states_at, resolve_repo_path, setup, slug_from_name, validate_git_url, FoundRepo, RepoSpec, RepoState, ServerCfg, ServerStatus, SetupEvent, SetupOptions, Ssh, Wanted};
use intely_settings::SettingsStore;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::settings::SettingsState;
use crate::agents::{blocking, repos, AgentSlot};
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

/// The settings namespace; only these commands write it (`settings::RESERVED_NS`).
const NS: &str = "servers";

pub struct ServersState {
    store: Option<Arc<SettingsStore>>,
    registry: Arc<ServerRegistry>,
    /// Ids whose setup is running (one at a time per server).
    setups: Mutex<HashSet<String>>,
    /// Serialises read-modify-write of the list.
    list_lock: Mutex<()>,
}

impl ServersState {
    /// The registry the agent host starts runs with.
    pub fn registry(&self) -> Arc<ServerRegistry> {
        self.registry.clone()
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn err(code: &str, message: impl Into<String>) -> EngineError {
    EngineError::new(code, message)
}

/// The servers of the settings; an entry that no longer validates is left out.
fn read_list(store: &SettingsStore) -> Vec<ServerCfg> {
    let Ok(obj) = store.get(NS) else { return Vec::new() };
    let mut seen = HashSet::new();
    obj.get("list")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| serde_json::from_value::<ServerCfg>(v.clone()).ok()).filter(|c| c.validate().is_ok() && seen.insert(c.id.clone())).collect())
        .unwrap_or_default()
}

fn write_list(store: &SettingsStore, list: &[ServerCfg]) -> Res<()> {
    let mut patch = serde_json::Map::new();
    patch.insert("list".into(), serde_json::to_value(list).map_err(|e| err("internal", e.to_string()))?);
    store.set(NS, patch).map(|_| ()).map_err(|e| err("settings", e.to_string()))
}

/// The folder of the shared `ssh` connections: a private one of this user (short, because a unix socket path is limited to about a hundred
/// bytes), or none, and then every call of `ssh` opens its own connection.
fn control_dir() -> PathBuf {
    intely_servers::private_control_dir(&intely_servers::default_control_dirs()).unwrap_or_default()
}

/// Called once from `setup`, after the settings and before the agent host asks for the registry.
pub fn setup_state(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let store = app.try_state::<SettingsState>().and_then(|s| s.parts()).map(|(s, _)| s);
    let supplier: ServersSupplier = match store.clone() {
        Some(store) => Arc::new(move || read_list(&store)),
        None => Arc::new(Vec::new),
    };
    let dir = control_dir();
    let registry = Arc::new(ServerRegistry::new(supplier, Ssh::from_env(dir), env!("CARGO_PKG_VERSION")));
    app.manage(ServersState { store, registry, setups: Mutex::new(HashSet::new()), list_lock: Mutex::new(()) });
    Ok(())
}

fn state_store(state: &ServersState) -> Res<&Arc<SettingsStore>> {
    state.store.as_ref().ok_or_else(|| err("unavailable", "Settings are unavailable, so servers cannot be managed"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    cfg: ServerCfg,
    status: Option<ServerStatus>,
    /// Runs on this server that work or wait for you now.
    running: u32,
}

fn running_on(agents: &AgentSlot, id: &str) -> u32 {
    agents.host().list().iter().filter(|s| s.location.as_deref() == Some(id) && matches!(s.status, RunStatus::Running | RunStatus::NeedsYou)).count() as u32
}

#[tauri::command]
pub async fn servers_list(state: State<'_, ServersState>, agents: State<'_, AgentSlot>) -> Res<Vec<ServerView>> {
    Ok(state.registry.list().into_iter().map(|cfg| ServerView { status: state.registry.cached(&cfg.id), running: running_on(&agents, &cfg.id), cfg }).collect())
}

/// What the form sends: the id is empty for a new server.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    #[serde(default)]
    id: Option<String>,
    name: String,
    destination: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default = "default_root")]
    root: String,
    #[serde(default = "default_max")]
    max_agents: u32,
    #[serde(default = "yes")]
    enabled: bool,
}

fn default_root() -> String {
    "~/work".into()
}
fn default_max() -> u32 {
    4
}
fn yes() -> bool {
    true
}

#[tauri::command]
pub async fn servers_save(state: State<'_, ServersState>, agents: State<'_, AgentSlot>, cfg: SaveRequest) -> Res<ServerCfg> {
    let store = state_store(&state)?.clone();
    // Another destination or port is another machine: the connection to the old one is closed first, and runs that are still open there
    // keep it, so the change waits until they are stopped. An entry that would be refused anyway is refused before anything is closed.
    // (Before the list lock: closing a connection can take seconds. The host also binds each connection to the address it was started
    // for, so a run that starts in between cannot end up on the old machine under the new address.)
    if let Some(id) = cfg.id.as_deref().filter(|i| !i.is_empty()) {
        let kept = read_list(&store).into_iter().find(|s| s.id == id).map(|s| s.repo_paths).unwrap_or_default();
        let wanted = ServerCfg { id: id.to_string(), name: cfg.name.trim().to_string(), destination: cfg.destination.trim().to_string(), port: cfg.port, root: cfg.root.trim().to_string(), max_agents: cfg.max_agents, enabled: cfg.enabled, repo_paths: kept };
        wanted.validate().map_err(|e| err("invalidServer", e.to_string()))?;
        let moved = read_list(&store).into_iter().find(|s| s.id == id).is_some_and(|old| old.destination != wanted.destination || old.port != wanted.port);
        if moved {
            let (host, id) = (agents.host().clone(), id.to_string());
            blocking(move || host.release_server(&id)).await?;
        }
    }
    let _guard = lock(&state.list_lock);
    let mut list = read_list(&store);
    let existing = cfg.id.as_deref().filter(|i| !i.is_empty()).map(str::to_string);
    let id = match &existing {
        Some(id) => {
            if !list.iter().any(|s| &s.id == id) {
                return Err(err("unknownServer", "this server is not in the list any more"));
            }
            id.clone()
        }
        None => {
            // a new server: the id is the name as a slug, made unique
            let base = slug_from_name(&cfg.name);
            let mut id = base.clone();
            let mut n = 2;
            while list.iter().any(|s| s.id == id) {
                let suffix = format!("-{n}");
                id = format!("{}{suffix}", base.chars().take(32 - suffix.len()).collect::<String>());
                n += 1;
            }
            id
        }
    };
    // (the folders mapped for repositories are edited in Settings > Servers > Repositories, not by this form)
    let kept = list.iter().find(|s| s.id == id).map(|s| s.repo_paths.clone()).unwrap_or_default();
    let entry = ServerCfg { id: id.clone(), name: cfg.name.trim().to_string(), destination: cfg.destination.trim().to_string(), port: cfg.port, root: cfg.root.trim().to_string(), max_agents: cfg.max_agents, enabled: cfg.enabled, repo_paths: kept };
    entry.validate().map_err(|e| err("invalidServer", e.to_string()))?;
    if let Some(slot) = list.iter_mut().find(|s| s.id == id) {
        // another destination is another machine: what was learned about the old one does not apply
        if slot.destination != entry.destination || slot.port != entry.port {
            state.registry.forget(&id);
        }
        *slot = entry.clone();
    } else {
        list.push(entry.clone());
    }
    write_list(&store, &list)?;
    Ok(entry)
}

#[tauri::command]
pub async fn servers_remove(state: State<'_, ServersState>, agents: State<'_, AgentSlot>, id: String) -> Res<()> {
    let store = state_store(&state)?.clone();
    // (a run that works or waits for you holds the server; finished runs give up their sessions, and the connection is closed with the entry)
    let (host, rid) = (agents.host().clone(), id.clone());
    blocking(move || host.release_server(&rid)).await?;
    let _guard = lock(&state.list_lock);
    let mut list = read_list(&store);
    list.retain(|s| s.id != id);
    write_list(&store, &list)?;
    state.registry.forget(&id);
    Ok(())
}

fn emit_status(app: &AppHandle, id: &str, status: &ServerStatus) {
    let _ = app.emit("servers:status", serde_json::json!({ "id": id, "status": status }));
}

#[tauri::command]
pub async fn servers_probe(app: AppHandle, state: State<'_, ServersState>, id: String) -> Res<ServerStatus> {
    let registry = state.registry();
    let cfg = registry.cfg(&id).ok_or_else(|| err("unknownServer", "this server is not in the list any more"))?;
    blocking(move || {
        let status = probe(registry.ssh(), &cfg, registry.app_version());
        registry.set_status(&id, status.clone());
        emit_status(&app, &id, &status);
        Ok(status)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupRequest {
    install_node: bool,
    install_bundle: bool,
    install_sdk: bool,
    install_claude: bool,
}

/// The files the server needs, laid out as in the app bundle (`sidecar/{index.js,sdk-install.js,package.json}`, `sdk-pin/`): the
/// bundle's own `Resources` folder, or for a development build a copy staged from the checkout.
fn stage_resources(data_dir: &Path, server_id: &str) -> std::io::Result<(PathBuf, bool)> {
    if let Some(res) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|d| d.join("../Resources"))) {
        if res.join("sidecar/index.js").is_file() && res.join("sdk-pin/tree.sha256").is_file() {
            return Ok((res, false));
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    // (one folder per server: two setups at once must not clear each other's files)
    let stage = data_dir.join("servers-stage").join(format!("{}-{server_id}", std::process::id()));
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(stage.join("sidecar"))?;
    std::fs::create_dir_all(stage.join("sdk-pin"))?;
    for (from, to) in [("sidecar/dist/index.js", "sidecar/index.js"), ("sidecar/dist/sdk-install.js", "sidecar/sdk-install.js"), ("src-tauri/resources/sidecar-package.json", "sidecar/package.json")] {
        std::fs::copy(root.join(from), stage.join(to))?;
    }
    for f in ["package.json", "package-lock.json", "tree.sha256", "hash-tree.mjs"] {
        std::fs::copy(root.join("sidecar/sdk-pin").join(f), stage.join("sdk-pin").join(f))?;
    }
    Ok((stage, true))
}

#[tauri::command]
pub async fn servers_setup(app: AppHandle, state: State<'_, ServersState>, agents: State<'_, AgentSlot>, id: String, options: SetupRequest) -> Res<()> {
    let registry = state.registry();
    let cfg = registry.cfg(&id).ok_or_else(|| err("unknownServer", "this server is not in the list any more"))?;
    if !lock(&state.setups).insert(id.clone()) {
        return Err(err("setupBusy", "a setup of this server is already running"));
    }
    let data_dir = agents.data_dir().to_path_buf();
    let app2 = app.clone();
    let id2 = id.clone();
    let result = blocking(move || {
        let emit = |e: SetupEvent| {
            let _ = app2.emit("servers:setup", serde_json::json!({ "id": id2, "step": e.step, "state": e.state, "message": e.message }));
        };
        let staged = stage_resources(&data_dir, &id2).map_err(|e| err("stage", format!("cannot prepare the files to upload: {e}")));
        let (dir, temp) = match staged {
            Ok(v) => v,
            Err(e) => {
                emit(SetupEvent { step: intely_servers::SetupStep::Bundle, state: intely_servers::StepState::Failed, message: e.message.clone() });
                return Ok(());
            }
        };
        let opts = SetupOptions { resources_dir: dir.clone(), app_version: registry.app_version().to_string(), install_node: options.install_node, install_bundle: options.install_bundle, install_sdk: options.install_sdk, install_claude: options.install_claude };
        let status = match setup(registry.ssh(), &cfg, &opts, &emit) {
            Ok(status) => status,
            // the failed step was reported as an event; what is known of the server now is a fresh look
            Err(_) => probe(registry.ssh(), &cfg, registry.app_version()),
        };
        if temp {
            let _ = std::fs::remove_dir_all(&dir);
        }
        registry.set_status(&id2, status.clone());
        emit_status(&app2, &id2, &status);
        Ok(())
    })
    .await;
    lock(&state.setups).remove(&id);
    result
}

/// The names of the workspace repos that were asked for.
/// A repository of the workspace as the server pages need it: its folder name and origin (without credentials, `None` when it has none).
struct LocalRepo {
    id: String,
    folder: String,
    origin: Option<String>,
}

async fn local_repos(app: &AppHandle, repo_ids: &[String]) -> Res<Vec<LocalRepo>> {
    let engine = app.state::<EngineSlot>();
    let all = repos(&engine).await?;
    let git = intely_core::exec::pinned_git_path();
    let picked: Vec<(String, PathBuf)> = repo_ids
        .iter()
        .map(|id| {
            let repo = all.iter().find(|r| &r.id == id).ok_or_else(|| err("unknownRepo", format!("unknown repository {id}")))?;
            Ok((id.clone(), repo.path.clone()))
        })
        .collect::<Res<_>>()?;
    blocking(move || {
        picked
            .into_iter()
            .map(|(id, path)| {
                let folder = path.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or_else(|| err("unknownRepo", "that repository has no folder name"))?;
                Ok(LocalRepo { id, origin: local_origin(&git, &path), folder })
            })
            .collect()
    })
    .await
}

/// One workspace repository on a server: where it is looked for, how that was decided, and what is there.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRow {
    repo_id: String,
    /// The key the folder is saved under (`servers.list[].repoPaths`).
    key: String,
    /// `<root>/<folder name>`; `None` when the folder name cannot be used there.
    default_path: Option<String>,
    #[serde(flatten)]
    state: RepoState,
}

#[tauri::command]
pub async fn servers_repos(app: AppHandle, state: State<'_, ServersState>, id: String, repo_ids: Vec<String>) -> Res<Vec<RepoRow>> {
    let registry = state.registry();
    let cfg = registry.cfg(&id).ok_or_else(|| err("unknownServer", "this server is not in the list any more"))?;
    let locals = local_repos(&app, &repo_ids).await?;
    blocking(move || {
        // a repository whose name cannot be used and has no mapping is shown as missing, with the reason in its path
        let mut rows: Vec<(String, String, Option<String>, Option<RepoSpec>)> = Vec::new();
        for l in &locals {
            let resolved = resolve_repo_path(&cfg, l.origin.as_deref(), &l.folder);
            let key = intely_servers::repo_key(l.origin.as_deref(), &l.folder);
            let spec = resolved.map(|r| RepoSpec { name: l.folder.clone(), path: r.path, mapped: r.mapped });
            rows.push((l.id.clone(), key, default_path(&cfg.root, &l.folder), spec));
        }
        let specs: Vec<RepoSpec> = rows.iter().filter_map(|r| r.3.clone()).collect();
        let mut states = repo_states_at(registry.ssh(), &cfg, &specs).map_err(|e| err("ssh", e.to_string()))?.into_iter();
        Ok(rows
            .into_iter()
            .zip(&locals)
            .map(|((repo_id, key, default_path, spec), l)| {
                let state = match spec {
                    Some(_) => states.next().unwrap_or_default(),
                    None => RepoState { name: l.folder.clone(), path: String::new(), ..RepoState::default() },
                };
                RepoRow { repo_id, key, default_path, state }
            })
            .collect())
    })
    .await
}

/// The candidates for one repository on the server (a search result; nothing is saved).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundRow {
    repo_id: String,
    key: String,
    candidates: Vec<FoundRepo>,
}

/// Looks for the repositories on the server (one bounded read-only command) and matches them to the workspace repositories by origin.
#[tauri::command]
pub async fn servers_find_repos(app: AppHandle, state: State<'_, ServersState>, id: String, repo_ids: Vec<String>) -> Res<Vec<FoundRow>> {
    let registry = state.registry();
    let cfg = registry.cfg(&id).ok_or_else(|| err("unknownServer", "this server is not in the list any more"))?;
    let locals = local_repos(&app, &repo_ids).await?;
    blocking(move || {
        let found = find_repos(registry.ssh(), &cfg).map_err(|e| err("ssh", e.to_string()))?;
        Ok(locals
            .into_iter()
            .map(|l| {
                let candidates = candidates_for(&Wanted { id: l.id.clone(), folder: l.folder.clone(), origin: l.origin.clone() }, &found);
                FoundRow { key: intely_servers::repo_key(l.origin.as_deref(), &l.folder), repo_id: l.id, candidates }
            })
            .collect())
    })
    .await
}

/// Saves (`path`) or removes (`None`) the folder of one repository on a server, after the person confirmed it.
#[tauri::command]
pub async fn servers_set_repo_path(state: State<'_, ServersState>, id: String, key: String, path: Option<String>) -> Res<ServerCfg> {
    let store = state_store(&state)?.clone();
    let _guard = lock(&state.list_lock);
    let mut list = read_list(&store);
    let slot = list.iter_mut().find(|s| s.id == id).ok_or_else(|| err("unknownServer", "this server is not in the list any more"))?;
    let mut next = slot.clone();
    match path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => {
            // (checked first: the clean-up below only removes `.`, `//` and a trailing `/`)
            intely_servers::cfg::validate_repo_path(p).map_err(|e| err("invalidServer", e.to_string()))?;
            next.repo_paths.insert(key, intely_servers::canonical_path(p));
        }
        _ => {
            next.repo_paths.remove(&key);
        }
    }
    next.validate().map_err(|e| err("invalidServer", e.to_string()))?;
    *slot = next.clone();
    write_list(&store, &list)?;
    Ok(next)
}

/// The URL a local repository was cloned from, without credentials in it; the server clones it with its own.
fn origin_of(git: &Path, repo: &Path) -> Res<String> {
    let out = intely_core::exec::hardened_git(git).arg("-C").arg(repo).args(["remote", "get-url", "origin"]).env("GIT_TERMINAL_PROMPT", "0").output().map_err(|e| err("git", e.to_string()))?;
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || url.is_empty() {
        return Err(err("noOrigin", "that repository has no remote called origin to clone from"));
    }
    // the credentials in front of the host are dropped
    let url = match url.strip_prefix("https://").and_then(|rest| rest.split_once('@').filter(|(auth, _)| !auth.contains('/'))) {
        Some((_, rest)) => format!("https://{rest}"),
        None => url,
    };
    validate_git_url(&url).map_err(|m| err("badOrigin", format!("the origin of that repository cannot be cloned on a server: {m}")))?;
    Ok(url)
}

#[tauri::command]
pub async fn servers_clone(app: AppHandle, state: State<'_, ServersState>, id: String, repo_id: String) -> Res<()> {
    let registry = state.registry();
    let cfg = registry.cfg(&id).ok_or_else(|| err("unknownServer", "this server is not in the list any more"))?;
    let local = local_repos(&app, std::slice::from_ref(&repo_id)).await?.into_iter().next().ok_or_else(|| err("unknownRepo", "unknown repository"))?;
    let path = engine_repo_path(&app, &repo_id).await?;
    // (into the folder mapped for it, otherwise `<root>/<folder name>`)
    let dest = resolve_repo_path(&cfg, local.origin.as_deref(), &local.folder).ok_or_else(|| err("remoteRepoName", "that folder name cannot be used on a server; set a folder for it first"))?.path;
    blocking(move || {
        let url = origin_of(&intely_core::exec::pinned_git_path(), &path)?;
        clone_repo_at(registry.ssh(), &cfg, &local.folder, &dest, &url).map_err(|e| err("clone", e.to_string()))
    })
    .await
}

async fn engine_repo_path(app: &AppHandle, repo_id: &str) -> Res<PathBuf> {
    let engine = app.state::<EngineSlot>();
    let all = repos(&engine).await?;
    all.iter().find(|r| r.id == repo_id).map(|r| r.path.clone()).ok_or_else(|| err("unknownRepo", format!("unknown repository {repo_id}")))
}

/// A jail (INTELY_READONLY / INTELY_E2E) allows no connection to a server: the view and the transfer are refused before any ssh starts.
fn network_allowed() -> Res<()> {
    let jail = intely_core::jail::Jail::global();
    match jail.mode() {
        intely_core::jail::Mode::Off => Ok(()),
        intely_core::jail::Mode::ReadOnly => Err(err(intely_core::jail::READ_ONLY, "read-only mode (INTELY_READONLY): no connection to a server is made")),
        intely_core::jail::Mode::E2e => Err(err(intely_core::jail::TEST_JAIL, "test jail (INTELY_E2E): no connection to a server is made")),
    }
}

/// Where one workspace repository is on one server: the server's entry, the folder as the settings resolve it, and the local copy.
struct Target {
    cfg: ServerCfg,
    path: String,
    local: intely_servers::transfer::LocalRepo,
}

async fn target(app: &AppHandle, state: &ServersState, id: &str, repo_id: &str) -> Res<Target> {
    let cfg = state.registry.cfg(id).ok_or_else(|| err("unknownServer", "this server is not in the list any more"))?;
    let l = local_repos(app, std::slice::from_ref(&repo_id.to_string())).await?.into_iter().next().ok_or_else(|| err("unknownRepo", "unknown repository"))?;
    let path = resolve_repo_path(&cfg, l.origin.as_deref(), &l.folder).ok_or_else(|| err("remoteRepoName", "that folder name cannot be used on a server; set a folder for it first"))?.path;
    let local_path = engine_repo_path(app, repo_id).await?;
    Ok(Target { cfg, path, local: intely_servers::transfer::LocalRepo { path: local_path, origin: l.origin } })
}

/// The read-only view of a repository's working copy on a server (one bounded `git status` over the shared connection).
#[tauri::command]
pub async fn servers_changes(app: AppHandle, state: State<'_, ServersState>, id: String, repo_id: String) -> Res<intely_servers::ServerChanges> {
    network_allowed()?;
    let t = target(&app, &state, &id, &repo_id).await?;
    let registry = state.registry();
    blocking(move || intely_servers::server_changes(registry.ssh(), &t.cfg, &t.path).map_err(|e| err("ssh", e.to_string()))).await
}

/// Both sides of one changed file on a server, for the diff viewer (nothing is written anywhere).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn servers_file(app: AppHandle, state: State<'_, ServersState>, id: String, repo_id: String, file: String, orig_path: Option<String>, untracked: bool, reveal: bool) -> Res<intely_core::FileContents> {
    network_allowed()?;
    let t = target(&app, &state, &id, &repo_id).await?;
    let registry = state.registry();
    blocking(move || intely_servers::server_file(registry.ssh(), &t.cfg, &t.path, &file, orig_path.as_deref(), untracked, reveal).map_err(|e| err("ssh", e.to_string()))).await
}

/// A run of this server that works or waits for you in this repository now.
fn server_busy(host: &intely_agent_host::AgentHost, id: &str, repo_id: &str) -> bool {
    host.list().iter().any(|s| s.location.as_deref() == Some(id) && matches!(s.status, RunStatus::Running | RunStatus::NeedsYou) && s.repo_ids.iter().any(|r| r == repo_id))
}

/// What the confirmation dialog of a transfer shows: the files, the counts and every reason it cannot happen. Changes nothing.
#[tauri::command]
pub async fn servers_transfer_plan(app: AppHandle, state: State<'_, ServersState>, agents: State<'_, AgentSlot>, id: String, repo_id: String, direction: intely_servers::transfer::Direction) -> Res<intely_servers::transfer::TransferPlan> {
    network_allowed()?;
    let t = target(&app, &state, &id, &repo_id).await?;
    let busy = server_busy(agents.host(), &id, &repo_id);
    let registry = state.registry();
    blocking(move || intely_servers::transfer::plan(direction, registry.ssh(), &t.cfg, &t.path, &t.local, &intely_core::jail::Jail::global(), busy)).await
}

/// "Bring changes here": only ever called by the button, after the person confirmed the plan.
#[tauri::command]
pub async fn servers_transfer_bring(app: AppHandle, state: State<'_, ServersState>, id: String, repo_id: String, on_top: bool, plan_id: String, accept_risky: bool) -> Res<intely_servers::transfer::Applied> {
    network_allowed()?;
    let t = target(&app, &state, &id, &repo_id).await?;
    let registry = state.registry();
    blocking(move || intely_servers::transfer::bring_changes(registry.ssh(), &t.cfg, &t.path, &t.local, &intely_core::jail::Jail::global(), on_top, &plan_id, accept_risky)).await
}

/// "Send my changes there": refused while a run of that server works in the repository.
#[tauri::command]
pub async fn servers_transfer_send(app: AppHandle, state: State<'_, ServersState>, agents: State<'_, AgentSlot>, id: String, repo_id: String, on_top: bool, plan_id: String, accept_risky: bool) -> Res<intely_servers::transfer::Applied> {
    network_allowed()?;
    let t = target(&app, &state, &id, &repo_id).await?;
    let host = agents.host().clone();
    let registry = state.registry();
    // (asked again by the transfer itself right before it sends, with the folder locked against runs that start here)
    blocking(move || intely_servers::transfer::send_changes(registry.ssh(), &t.cfg, &t.path, &t.local, &intely_core::jail::Jail::global(), on_top, &plan_id, accept_risky, &|| server_busy(&host, &id, &repo_id))).await
}

#[tauri::command]
pub async fn servers_ssh_command(state: State<'_, ServersState>, id: String) -> Res<String> {
    let cfg = state.registry.cfg(&id).ok_or_else(|| err("unknownServer", "this server is not in the list any more"))?;
    Ok(match cfg.port {
        Some(p) => format!("ssh -p {p} {}", cfg.destination),
        None => format!("ssh {}", cfg.destination),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_control_path_fits_a_unix_socket() {
        let dir = control_dir();
        // ssh appends `/` and a 40-character hash
        assert!(dir.to_string_lossy().len() + 41 < 104, "{}", dir.display());
    }

    #[cfg(unix)]
    #[test]
    fn the_control_folder_is_private_to_us_or_there_is_none() {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        let dir = control_dir();
        if !dir.as_os_str().is_empty() {
            let m = std::fs::symlink_metadata(&dir).unwrap();
            assert!(m.is_dir() && m.mode() & 0o077 == 0, "{}", dir.display());
        }
    }

    #[test]
    fn a_default_request_gets_the_defaults() {
        let r: SaveRequest = serde_json::from_str(r#"{"name":"Build","destination":"dev@build1"}"#).unwrap();
        assert!(r.id.is_none() && r.root == "~/work" && r.max_agents == 4 && r.enabled && r.port.is_none());
    }
}
