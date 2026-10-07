//! Tauri glue of the `roles` module (track E): the `roles_*` and `runs_*` commands on top of `intely_roles`.
//! Commands are listed in `generate_handler!` under the "track E commands" marker in `lib.rs`. The supervisor wraps the
//! one `AgentHost` that `agents.rs` creates (one sidecar, one gate), so it is built there through `prepare` and `attach`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use intely_agent_host::{AgentHost, HostConfig, HostSink, RepoRef, RoleResolver};
use intely_core::EngineError;
use intely_roles::store::claude_caps;
use intely_roles::types::{
    AdoptOptions, DeletePreview, DeleteReport, HistoryEntry, ModelCaps, RolePermission, HistoryQuery, Role, RoleDraft, RoleDrift, RoleGroup, RoleProviderCaps, RolesStatus, RewindSnapshotInfo, RunRecord, RunsStartRequest, UsageSummary,
};
use intely_roles::{FileOverlay, Observer, RoleStore, Supervisor, SupervisorConfig};
use tauri::{Manager, State};

use crate::agents::{blocking, repos};
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

/// Called once from `setup` (track E state marker). The module's state is created together with the agent host in
/// `agents.rs`, which needs the resolver and the observer before the host exists.
pub fn setup(_app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

/// `~/.claude/agents`, or `$CLAUDE_CONFIG_DIR/agents`.
fn global_agents_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| Path::new(&h).join(".claude")))
        .unwrap_or_else(|| PathBuf::from(".claude"))
        .join("agents")
}

pub struct RolesSlot {
    store: Arc<RoleStore>,
    sup: Supervisor,
}

impl RolesSlot {
    pub fn supervisor(&self) -> &Supervisor {
        &self.sup
    }
}

/// Installs the role resolver in the host config and wraps the sink, before the host is built.
pub fn prepare(cfg: &mut HostConfig, sink: Arc<dyn HostSink>) -> (Arc<Observer>, Arc<RoleStore>) {
    // The overlay lives next to the run data until the settings store (track F) has a `roles` namespace.
    // Backups of a role file go next to the overlay (`role-backups/`), never into `~/.claude`.
    let builtins = intely_agent_host::roles::builtin(cfg);
    let store = Arc::new(RoleStore::new(global_agents_dir(), Box::new(FileOverlay(cfg.data_dir.join("roles-overlay.json")))).with_builtin_defs(builtins));
    let resolver_store = store.clone();
    let resolver: RoleResolver = Arc::new(move |name, repos| {
        // resume and reload by name: a hidden role must keep its history working (a NEW run is refused in the supervisor)
        let role = resolver_store.resolve_any(name, repos.first().map(|r| r.id.as_str()), repos)?;
        Some(RoleStore::role_def(&role))
    });
    cfg.role_resolver = Some(resolver);
    (Observer::new(sink), store)
}

/// Builds the supervisor on the freshly created host and registers the module state.
pub fn attach(app: &tauri::AppHandle, host: &AgentHost, cfg: &HostConfig, observer: &Observer, store: Arc<RoleStore>) {
    let sup = Supervisor::new(host.clone(), store.clone(), SupervisorConfig { data_dir: cfg.data_dir.clone(), git: cfg.git.clone() }, Some(observer));
    app.manage(RolesSlot { store, sup });
}

async fn repo_list(engine: &EngineSlot) -> Res<Vec<RepoRef>> {
    repos(engine).await
}

// ---- roles ----

#[tauri::command]
pub async fn roles_list(engine: State<'_, EngineSlot>, slot: State<'_, RolesSlot>) -> Res<Vec<Role>> {
    let repos = repo_list(&engine).await?;
    let store = slot.store.clone();
    blocking(move || Ok(store.list(&repos))).await
}

#[tauri::command]
pub async fn roles_save(engine: State<'_, EngineSlot>, slot: State<'_, RolesSlot>, role: RoleDraft) -> Res<Role> {
    let repos = repo_list(&engine).await?;
    let store = slot.store.clone();
    blocking(move || Ok(store.save(role, &repos)?)).await
}

#[tauri::command]
pub async fn roles_drift(engine: State<'_, EngineSlot>, slot: State<'_, RolesSlot>) -> Res<Vec<RoleDrift>> {
    let repos = repo_list(&engine).await?;
    let store = slot.store.clone();
    blocking(move || Ok(store.drift(&repos))).await
}

/// `keep` is `global` or `repo`. Overwrites a role file: refused (`confirmWrite`) unless `confirm_write` is true.
#[tauri::command]
pub async fn roles_resolve_drift(engine: State<'_, EngineSlot>, slot: State<'_, RolesSlot>, role_id: String, keep: String, confirm_write: Option<bool>) -> Res<()> {
    let repos = repo_list(&engine).await?;
    let store = slot.store.clone();
    blocking(move || Ok(store.resolve_drift(&role_id, keep == "global", confirm_write.unwrap_or(false), &repos)?)).await
}

/// Writes the global role files: refused (`confirmWrite`) unless `confirm_write` is true.
#[tauri::command]
pub async fn roles_preset_happy_tiering(engine: State<'_, EngineSlot>, slot: State<'_, RolesSlot>, confirm_write: Option<bool>) -> Res<Vec<Role>> {
    let repos = repo_list(&engine).await?;
    let store = slot.store.clone();
    blocking(move || Ok(store.preset_happy_tiering(&repos, confirm_write.unwrap_or(false))?)).await
}

/// One group per role name: the Roles table reads this instead of `roles_list` + `roles_drift`.
#[tauri::command]
pub async fn roles_groups(engine: State<'_, EngineSlot>, slot: State<'_, RolesSlot>) -> Res<Vec<RoleGroup>> {
    let repos = repo_list(&engine).await?;
    let store = slot.store.clone();
    blocking(move || Ok(store.groups(&repos))).await
}

/// Migration list (overlay permissions that differ from what the files derive), corrupt-overlay state, skipped
/// symlinked agents directories and the global directory's symlink target.
#[tauri::command]
pub async fn roles_status(engine: State<'_, EngineSlot>, slot: State<'_, RolesSlot>) -> Res<RolesStatus> {
    let repos = repo_list(&engine).await?;
    let store = slot.store.clone();
    blocking(move || Ok(store.status(&repos))).await
}

/// "Use automatic": removes the overlay permission of these role ids (nothing else of the entries changes).
#[tauri::command]
pub async fn roles_use_automatic(slot: State<'_, RolesSlot>, role_ids: Vec<String>) -> Res<()> {
    let store = slot.store.clone();
    blocking(move || Ok(store.use_automatic(&role_ids)?)).await
}

/// Repairs a corrupt `roles-overlay.json` (a `.bak` copy of the bytes is kept).
#[tauri::command]
pub async fn roles_reset_overlay(slot: State<'_, RolesSlot>) -> Res<()> {
    let store = slot.store.clone();
    blocking(move || Ok(store.reset_overlay()?)).await
}

/// Hides or shows a role group. Overlay only: role files are never touched.
#[tauri::command]
pub async fn roles_set_hidden(engine: State<'_, EngineSlot>, slot: State<'_, RolesSlot>, name: String, hidden: bool) -> Res<RoleGroup> {
    let repos = repo_list(&engine).await?;
    let store = slot.store.clone();
    blocking(move || Ok(store.set_hidden(&name, hidden, &repos)?)).await
}

/// `pin` is `global`, `repo:<id>` or null. Overlay only.
#[tauri::command]
pub async fn roles_set_pin(engine: State<'_, EngineSlot>, slot: State<'_, RolesSlot>, name: String, pin: Option<String>) -> Res<RoleGroup> {
    let repos = repo_list(&engine).await?;
    let store = slot.store.clone();
    blocking(move || Ok(store.set_pin(&name, pin.as_deref(), &repos)?)).await
}

/// Approves (or withdraws the approval of) the content hash of a repository copy. Overlay only.
#[tauri::command]
pub async fn roles_set_trust(engine: State<'_, EngineSlot>, slot: State<'_, RolesSlot>, name: String, hash: String, trusted: bool) -> Res<RoleGroup> {
    let repos = repo_list(&engine).await?;
    let store = slot.store.clone();
    blocking(move || Ok(store.set_trust(&name, &hash, trusted, &repos)?)).await
}

/// What the delete dialog shows: paths, the canonical target of a symlinked global directory, the backup directory.
#[tauri::command]
pub async fn roles_delete_preview(engine: State<'_, EngineSlot>, slot: State<'_, RolesSlot>, role_ids: Vec<String>) -> Res<DeletePreview> {
    let repos = repo_list(&engine).await?;
    let store = slot.store.clone();
    blocking(move || Ok(store.delete_preview(&role_ids, &repos)?)).await
}

/// Deletes role files (all copies of ONE role) after a verified backup of each. `typed` must be the exact role name;
/// `typed_link` the canonical target when `~/.claude/agents` is a symlink. Errors carry codes (`confirmDelete`,
/// `confirmLink`, `builtinNoFile`, `outsideAgentsDir`, `noBackupDir`, `readOnly`, `testJail`, `unknownRole`,
/// `overlayCorrupt`, `io`).
#[tauri::command]
pub async fn roles_delete(engine: State<'_, EngineSlot>, slot: State<'_, RolesSlot>, role_ids: Vec<String>, typed: String, typed_link: Option<String>) -> Res<DeleteReport> {
    let repos = repo_list(&engine).await?;
    let store = slot.store.clone();
    blocking(move || Ok(store.delete(&role_ids, &typed, typed_link.as_deref(), &repos)?)).await
}

#[tauri::command]
pub async fn roles_capabilities(agents: State<'_, crate::agents::AgentSlot>) -> Res<Vec<RoleProviderCaps>> {
    let mut caps = vec![claude_caps()];
    // e2e only: the ACP provider that runs against the scripted fake agent can take read-only roles (never write roles).
    if let Some(provider) = crate::agents::acp_mock_provider(&agents) {
        caps.push(RoleProviderCaps {
            provider,
            label: "Gemini CLI (ACP, scripted fake)".into(),
            models: vec![ModelCaps { id: "default".into(), label: "Agent default".into(), effort_levels: Vec::new() }],
            permission_modes: vec![RolePermission::ReadOnly],
            tools: Vec::new(),
        });
    }
    // wave4 providers: every experimental provider the user switched on, installed and confirmed. The model is the agent's own default;
    // a write mode is offered only where the user turned on "allow weak writer" for that provider (Settings > Safety), because the
    // computed tier of these adapters stays below the write tier until their own suites ran (the host gate refuses the rest).
    for launch in agents.host().launches() {
        if caps.iter().any(|c| c.provider == launch.id) {
            continue;
        }
        let label = intely_settings::providers::definition(&launch.id).map_or(launch.id.clone(), |d| d.name.to_owned());
        let mut permission_modes = vec![RolePermission::ReadOnly];
        if launch.allow_weak_writer {
            permission_modes.extend([RolePermission::Edit, RolePermission::Ask]);
        }
        caps.push(RoleProviderCaps { provider: launch.id, label, models: vec![ModelCaps { id: "default".into(), label: "Agent default".into(), effort_levels: Vec::new() }], permission_modes, tools: Vec::new() });
    }
    Ok(caps)
}

// ---- runs ----

#[tauri::command]
pub async fn runs_start(engine: State<'_, EngineSlot>, slot: State<'_, RolesSlot>, req: RunsStartRequest) -> Res<RunRecord> {
    let repos = repo_list(&engine).await?;
    let sup = slot.sup.clone();
    blocking(move || sup.start(req, &repos)).await
}

#[tauri::command]
pub async fn runs_list(slot: State<'_, RolesSlot>) -> Res<Vec<RunRecord>> {
    let sup = slot.sup.clone();
    blocking(move || Ok(sup.list())).await
}

#[tauri::command]
pub async fn runs_history(engine: State<'_, EngineSlot>, slot: State<'_, RolesSlot>, query: HistoryQuery) -> Res<Vec<HistoryEntry>> {
    let repos = repo_list(&engine).await?;
    let sup = slot.sup.clone();
    blocking(move || Ok(sup.history(&query, &repos))).await
}

#[tauri::command]
pub async fn runs_resume(engine: State<'_, EngineSlot>, slot: State<'_, RolesSlot>, id: String, opts: Option<AdoptOptions>) -> Res<RunRecord> {
    let repos = repo_list(&engine).await?;
    let sup = slot.sup.clone();
    blocking(move || sup.resume(&id, &opts.unwrap_or_default(), &repos)).await
}

#[tauri::command]
pub async fn runs_fork(engine: State<'_, EngineSlot>, slot: State<'_, RolesSlot>, id: String, opts: Option<AdoptOptions>) -> Res<RunRecord> {
    let repos = repo_list(&engine).await?;
    let sup = slot.sup.clone();
    blocking(move || sup.fork(&id, &opts.unwrap_or_default(), &repos)).await
}

#[tauri::command]
pub async fn runs_stop(slot: State<'_, RolesSlot>, id: String) -> Res<()> {
    let sup = slot.sup.clone();
    blocking(move || sup.stop(&id)).await
}

#[tauri::command]
pub async fn runs_tag(slot: State<'_, RolesSlot>, id: String, tag: Option<String>) -> Res<()> {
    let sup = slot.sup.clone();
    blocking(move || sup.tag(&id, tag.as_deref())).await
}

#[tauri::command]
pub async fn runs_usage(slot: State<'_, RolesSlot>) -> Res<UsageSummary> {
    let sup = slot.sup.clone();
    blocking(move || Ok(sup.usage())).await
}

#[tauri::command]
pub async fn runs_rewind_snapshots(slot: State<'_, RolesSlot>, run_id: String) -> Res<Vec<RewindSnapshotInfo>> {
    let sup = slot.sup.clone();
    blocking(move || sup.rewind_snapshots(&run_id)).await
}

/// Refuses (`confirmRequired`) unless `confirm` is true; `repo_id` limits the restore to one repository.
#[tauri::command]
pub async fn runs_rewind_restore(slot: State<'_, RolesSlot>, run_id: String, confirm: bool, repo_id: Option<String>) -> Res<()> {
    let sup = slot.sup.clone();
    blocking(move || sup.rewind_restore(&run_id, confirm, repo_id.as_deref())).await
}
