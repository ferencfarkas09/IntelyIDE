//! The `agent_*` commands: thin wrappers around `intely_agent_host::AgentHost` (providers-plan 5.2, 5.10).
//! Every command is blocking work (spawning, git, pipes), so it runs on the blocking pool, never on the UI thread.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use intely_agent_core::api::{AgentAttachment, AgentStartRequest, AgentSummary, AutoInfo, PermissionDecision, QuestionAnswer, RoleInfo};
use intely_agent_core::providers::{supported_modes, Effort, PermissionMode};
use intely_settings::types::ProviderState;
use intely_agent_core::events::types::{AgentEvent, McpServerStatus};
use intely_agent_host::{AcpMock, AgentDefaults, AgentHost, AnswerExtra, HostConfig, HostSink, PolicyFault, RepoRef, SetModeOpts};
use intely_core::{BusyItem, BusyKind, EngineError, SwitchWarning};
use intely_roles::types::RunState;
use intely_roles::Supervisor;
use tauri::{AppHandle, Emitter, Listener, Manager, State};

use crate::commands::EngineSlot;
use crate::modules::roles::RolesSlot;
use crate::modules::switchhook::{self, BoxFuture, SwitchHook};

type Res<T> = Result<T, EngineError>;

/// Forwards committed events to the webview in batches (`agent:events`).
struct TauriHostSink {
    app: AppHandle,
}

impl HostSink for TauriHostSink {
    fn events(&self, events: Vec<AgentEvent>) {
        // wave3 Rm1: committed events also go to the Remote hub, but only while Remote is on
        crate::modules::remote::tap(&self.app, &events);
        if let Err(e) = self.app.emit("agent:events", events) {
            eprintln!("emit agent:events failed: {e}");
        }
    }
}

pub struct AgentSlot {
    host: AgentHost,
    data_dir: PathBuf,
    git: PathBuf,
    /// Kill switch `INTELY_NO_UNATTENDED=1` (permission-modes spec 5.10), as the host config holds it.
    no_unattended: bool,
}

fn env_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| v == "1")
}

/// Where the bundled sidecar lives: an explicit override, the app's resources, or (dev builds) the repo checkout.
fn sidecar_js() -> PathBuf {
    if let Some(p) = std::env::var_os("INTELY_SIDECAR") {
        return PathBuf::from(p);
    }
    let bundled = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|d| d.join("../Resources/sidecar/index.js")));
    match bundled {
        Some(p) if p.is_file() => p,
        _ => PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../sidecar/dist/index.js")),
    }
}

/// Variables from the process that every agent environment starts from; the login shell overlays them.
fn process_basics() -> HashMap<String, String> {
    std::env::vars().filter(|(k, _)| matches!(k.as_str(), "PATH" | "HOME" | "USER" | "LANG" | "NVM_DIR") || k.starts_with("LC_")).collect()
}

impl AgentSlot {
    /// Cheap and lazy: no process is started before the first run. `login_env` is read when a run starts.
    pub fn new(app: &AppHandle, login_env: impl Fn() -> HashMap<String, String> + Send + Sync + 'static) -> Self {
        let data_dir = std::env::var_os("INTELY_DATA_DIR")
            .map(PathBuf::from)
            .or_else(intely_agent_core::events::log::JsonlEventLog::default_base_dir)
            .unwrap_or_else(|| PathBuf::from("."));
        let env = Arc::new(move || {
            let mut vars = process_basics();
            vars.extend(login_env());
            vars
        });
        let mut cfg = HostConfig::new(data_dir.clone(), sidecar_js(), env);
        if env_flag("INTELY_MOCK_PROVIDER") {
            cfg.providers.push("mock".into());
        }
        cfg.model_override = std::env::var("INTELY_AGENT_MODEL").ok().filter(|m| !m.is_empty());
        cfg.max_budget_usd = std::env::var("INTELY_AGENT_MAX_BUDGET_USD").ok().and_then(|v| v.parse().ok());
        cfg.claude_bin = std::env::var_os("INTELY_CLAUDE_BIN").map(PathBuf::from);
        cfg.no_unattended = env_flag("INTELY_NO_UNATTENDED");
        if let Some(speed) = std::env::var("INTELY_MOCK_SPEED").ok().and_then(|v| v.parse().ok()) {
            cfg.mock_speed = speed;
        }
        // Fault injection exists for the e2e harness only: it needs the harness flag as well.
        if env_flag("INTELY_E2E") {
            // Scripted fake ACP agent for the provider `gemini` (scenario z): the sidecar runs the Gemini profile against it.
            if let Some(dir) = std::env::var_os("INTELY_E2E_ACP_FAKES").map(PathBuf::from) {
                cfg.providers.push("gemini".into());
                cfg.acp_mock = Some(AcpMock { provider: "gemini".into(), agent_js: dir.join("fake-acp-agent.mjs"), scripts_dir: dir.join("acp-scripts") });
            }
            cfg.policy_fault = match std::env::var("INTELY_E2E_POLICY_FAULT").as_deref() {
                Ok("drop") => Some(PolicyFault::Drop),
                Ok("close") => Some(PolicyFault::ClosePipe),
                _ => None,
            };
        }
        // wave4 providers: what a non-Claude provider may start comes from the settings (global switch, per-provider switch,
        // confirmed command line) every time a session opens; without settings nothing but Claude starts.
        if let Some(registry) = app.try_state::<crate::modules::settings::SettingsState>().and_then(|s| s.registry()) {
            cfg.launch = Some(crate::modules::providers::launch_supplier(registry.clone()));
            cfg.cli_version = Some(crate::modules::providers::version_supplier(registry));
        }
        // MCP (mcp-management spec 5.2 item 1): the run's selected servers are resolved into config and per-tool rules by the MCP module; a
        // build or a test without it leaves the suppliers `None`, and a start that selects servers then fails with `mcpUnavailable`.
        if let Some(mcp) = app.try_state::<crate::modules::mcp::McpState>() {
            cfg.mcp_supplier = Some(mcp.supplier());
            cfg.mcp_rules = Some(mcp.rules_supplier());
            cfg.mcp_scrub = Some(mcp.scrub_supplier());
        }
        let git = cfg.git.clone();
        // track E: file roles and the run supervisor sit on this one host (one sidecar, one gate)
        let (observer, roles) = crate::modules::roles::prepare(&mut cfg, Arc::new(TauriHostSink { app: app.clone() }));
        // Auto ((design notes: roles-orchestration-spec) 4.2): the delegates are built from the CURRENT role files of the run's repositories every
        // time a session opens, and the lead's model, effort, cap, budget and kill switches are read from the `agents` settings.
        cfg.delegate_resolver = Some(roles.delegate_resolver());
        if let Some((store, _secrets)) = app.try_state::<crate::modules::settings::SettingsState>().and_then(|s| s.parts()) {
            // the user's own ~/.claude/CLAUDE.md rides on every Claude session unless `agents.includeUserMemory` is switched off (read at each start)
            let memory_store = store.clone();
            cfg.user_memory = Some(Arc::new(move || intely_settings::agents::include_user_memory_in(&memory_store.get("agents").unwrap_or_default())));
            cfg.agent_defaults = Some(defaults_supplier(store));
        }
        // MCP servers a run selects: resolved (secrets included) only when a session opens; absent in a build without the module
        if let Some(mcp) = app.try_state::<crate::modules::mcp::McpState>() {
            cfg.mcp_supplier = Some(mcp.supplier());
            cfg.mcp_rules = Some(mcp.rules_supplier());
            cfg.mcp_scrub = Some(mcp.scrub_supplier());
        }
        let host = AgentHost::new(cfg.clone(), observer.clone());
        // MCP policy changed in Settings: the live runs get the tighter rules at once (tighten only; looser rules apply from the next start)
        let tighten = host.clone();
        app.listen("settings:changed", move |event| {
            let changed_mcp = serde_json::from_str::<serde_json::Value>(event.payload()).ok().is_some_and(|v| v["ns"] == "mcp");
            if changed_mcp {
                let host = tighten.clone();
                std::thread::spawn(move || {
                    host.tighten_mcp();
                });
            }
        });
        crate::modules::roles::attach(app, &host, &cfg, &observer, roles);
        Self { host, data_dir, git, no_unattended: cfg.no_unattended }
    }

    pub fn shutdown(&self) {
        self.host.shutdown();
    }

    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }

    /// The one run surface, for the Remote hub (wave3 Rm1); cheap clone of the shared handle.
    pub(crate) fn host(&self) -> &AgentHost {
        &self.host
    }
}

// ---- Auto: settings and availability -----------------------------------------------------------------------------------

/// The `agents` settings namespace as the host's [`AgentDefaults`] (flat keys: `defaultModel`, `defaultEffort`, `delegationCap`,
/// `maxBudgetUsd`, `autoEnabled`, `delegationEnabled`; the Settings > Roles block writes the two switches as nested `auto.enabled` and
/// `delegation.enabled`, which win over the flat keys). Read at every start; anything invalid falls back to the defaults.
fn defaults_from(ns: &serde_json::Map<String, serde_json::Value>) -> AgentDefaults {
    use serde_json::Value;
    let fallback = AgentDefaults::default();
    let model = ns.get("defaultModel").and_then(Value::as_str).map(intely_roles::store::resolve_model).filter(|m| !m.is_empty()).unwrap_or(fallback.model.clone());
    let effort = match ns.get("defaultEffort").and_then(Value::as_str) {
        Some(e) => Effort::parse(e).filter(|e| *e != Effort::Max).or(fallback.effort),
        None => fallback.effort,
    }
    .filter(|_| intely_roles::store::effort_available("claude", &model));
    AgentDefaults {
        model,
        effort,
        delegation_cap: ns.get("delegationCap").and_then(Value::as_u64).map_or(fallback.delegation_cap, |n| n.min(u64::from(u32::MAX)) as u32),
        max_budget_usd: ns.get("maxBudgetUsd").and_then(Value::as_f64),
        auto_enabled: switch(ns, "auto", "autoEnabled"),
        delegation_enabled: switch(ns, "delegation", "delegationEnabled"),
    }
    .sanitized()
}

/// A kill switch: the nested `<group>.enabled` (what the UI writes) first, then the flat key; on unless explicitly false.
fn switch(ns: &serde_json::Map<String, serde_json::Value>, group: &str, flat: &str) -> bool {
    ns.get(group).and_then(|g| g.get("enabled")).and_then(serde_json::Value::as_bool).or_else(|| ns.get(flat).and_then(serde_json::Value::as_bool)).unwrap_or(true)
}

fn defaults_supplier(store: Arc<intely_settings::SettingsStore>) -> intely_agent_host::DefaultsSupplier {
    Arc::new(move || defaults_from(&store.get("agents").unwrap_or_default()))
}

/// Why Auto cannot start because of Claude itself (a code the UI words), from what the provider registry knows. A provider that was
/// never detected is not blamed: the start reports a missing CLI on its own.
fn claude_unavailable(state: &ProviderState) -> Option<&'static str> {
    match state {
        ProviderState::Off => Some("claudeDisabled"),
        ProviderState::NotInstalled => Some("notInstalled"),
        ProviderState::NeedsLogin | ProviderState::NeedsKey => Some("notLoggedIn"),
        _ => None,
    }
}

/// `agents_auto_info`: what an Auto run on these repositories would do (lead, delegates, exclusions, queue reason, budget, worst-case
/// turns). Async because the provider state and the role files are read off the UI thread. A CLI older than the minimum does not make
/// Auto unavailable: the lead then works alone and `delegationOff` says why.
#[tauri::command]
pub async fn agents_auto_info(app: AppHandle, engine: State<'_, EngineSlot>, roles: State<'_, RolesSlot>, repo_ids: Vec<String>, mode: Option<PermissionMode>) -> Res<AutoInfo> {
    // `mode` only steers the queued-behind preview (does the run write, so does it wait for the repository's writer?)
    let repos = repos(&engine).await?;
    let sup = roles.supervisor().clone();
    let claude = app.try_state::<crate::modules::settings::SettingsState>().and_then(|s| s.registry()).and_then(|r| r.list().ok()).and_then(|l| l.into_iter().find(|p| p.id == "claude"));
    blocking(move || {
        let mut info = sup.auto_info(&repo_ids, &repos, mode);
        if let Some(why) = claude.as_ref().and_then(|p| claude_unavailable(&p.state)) {
            info.available = false;
            info.reason = Some(why.to_string());
        }
        Ok(info)
    })
    .await
}

// ---- the workspace switch ((design notes: workspaces-spec) 4.10 row 2) ---------------------------------------------------------

/// What a run is doing, as far as a switch cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Waiting for a slot, or working.
    Active,
    /// Waiting for the human (a permission or a question).
    NeedsYou,
}

/// The few things the switch needs from the run supervisor; a fake stands in for it in the tests.
pub trait RunControl: Send + Sync + 'static {
    /// Runs that are queued, working or waiting for the human.
    fn runs(&self) -> Vec<(String, Phase)>;
    /// Interrupts (a running run) or removes (a queued one) the run.
    fn stop(&self, id: &str);
}

struct SupervisorControl(Supervisor);

impl RunControl for SupervisorControl {
    fn runs(&self) -> Vec<(String, Phase)> {
        self.0
            .list()
            .into_iter()
            .filter_map(|r| match r.status {
                RunState::Queued | RunState::Running => Some((r.agent_id, Phase::Active)),
                RunState::NeedsYou => Some((r.agent_id, Phase::NeedsYou)),
                RunState::Done | RunState::Error => None,
            })
            .collect()
    }

    fn stop(&self, id: &str) {
        let _ = self.0.stop(id);
    }
}

/// How long `stop` waits for the turns to end (the budget is 4 s).
const STOP_WAIT: Duration = Duration::from_millis(3500);

/// The `SwitchHook` of the agent runs: interrupts every live run, queued ones are dropped. Their Rewind snapshots stay,
/// the sidecar host stays, a permission ask of an interrupted run is answered by the interruption.
pub struct AgentsHook<C: RunControl> {
    control: Arc<C>,
}

impl<C: RunControl> AgentsHook<C> {
    pub fn new(control: C) -> Self {
        Self { control: Arc::new(control) }
    }
}

/// `Some(hook)` once the roles module is up.
pub fn hook(app: &AppHandle) -> Option<Arc<dyn SwitchHook>> {
    let roles = app.try_state::<RolesSlot>()?;
    Some(Arc::new(AgentsHook::new(SupervisorControl(roles.supervisor().clone()))))
}

/// Interrupts every live run and waits (at most `wait`) for them to end; returns the ids still alive.
pub fn stop_runs(control: &dyn RunControl, wait: Duration) -> Vec<String> {
    for (id, _) in control.runs() {
        control.stop(&id);
    }
    switchhook::wait_until(wait, Duration::from_millis(40), || control.runs().is_empty());
    control.runs().into_iter().map(|(id, _)| id).collect()
}

impl<C: RunControl> SwitchHook for AgentsHook<C> {
    fn name(&self) -> &'static str {
        "agents"
    }

    /// Two confirmable items, as the dialog words them separately: runs that work and runs that wait for the human.
    fn busy(&self) -> Vec<BusyItem> {
        let runs = self.control.runs();
        let ids = |phase: Phase| runs.iter().filter(|(_, p)| *p == phase).map(|(id, _)| id.clone()).collect::<Vec<_>>();
        [ids(Phase::Active), ids(Phase::NeedsYou)]
            .into_iter()
            .filter(|labels| !labels.is_empty())
            .map(|labels| BusyItem { kind: BusyKind::Agent, count: labels.len() as u32, labels })
            .collect()
    }

    fn stop(&self) -> BoxFuture<'_, Vec<SwitchWarning>> {
        let control = self.control.clone();
        Box::pin(async move {
            match switchhook::blocking(move || stop_runs(&*control, STOP_WAIT)).await {
                Some(left) if left.is_empty() => Vec::new(),
                _ => vec![switchhook::stuck("agents")],
            }
        })
    }
}

pub(crate) async fn repos(engine: &EngineSlot) -> Res<Vec<RepoRef>> {
    let ws = engine.get()?.workspace_get().await?;
    Ok(ws.repos.into_iter().map(|r| RepoRef { id: r.id, path: PathBuf::from(r.path) }).collect())
}

pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| EngineError::new("internal", format!("agent task failed: {e}")))?
}

#[tauri::command]
pub async fn agent_roles(engine: State<'_, EngineSlot>, roles: State<'_, RolesSlot>) -> Res<Vec<RoleInfo>> {
    let repos = repos(&engine).await?;
    let sup = roles.supervisor().clone();
    blocking(move || Ok(sup.role_infos(&repos))).await
}

/// `agent_start`'s request: the generated [`AgentStartRequest`] plus the provider the New run picker chose (absent = the role's own).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartWire {
    #[serde(flatten)]
    req: AgentStartRequest,
    #[serde(default)]
    provider: Option<String>,
}

#[tauri::command]
pub async fn agent_start(
    app: AppHandle,
    engine: State<'_, EngineSlot>,
    roles: State<'_, RolesSlot>,
    req: AgentStartWire,
    run_without_safety_net: Option<bool>,
    confirm_bypass: Option<bool>,
) -> Res<AgentSummary> {
    switchhook::gate_check(&app)?;
    let repos = repos(&engine).await?;
    let sup = roles.supervisor().clone();
    let opts = intely_agent_host::StartOptions { run_without_safety_net: run_without_safety_net.unwrap_or(false), provider: req.provider, bypass_confirmed: confirm_bypass.unwrap_or(false), ..Default::default() };
    let req = req.req;
    blocking(move || sup.start_now_with(req, &repos, opts)).await
}

/// One recorded enforcement result for Settings > Providers, Roles and New run (`ProviderEnforcement` in `ui/src/ipc/providers.ts`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEnforcement {
    provider: String,
    role_mode: &'static str,
    chip: intely_agent_core::policy::enforcement::EnforcementChip,
}

#[tauri::command]
pub async fn providers_enforcement(agents: State<'_, AgentSlot>) -> Res<Vec<ProviderEnforcement>> {
    let host = agents.host.clone();
    blocking(move || Ok(host.enforcement().into_iter().map(|(provider, read_only, chip)| ProviderEnforcement { provider, role_mode: if read_only { "readOnly" } else { "write" }, chip }).collect())).await
}

/// The ACP provider that runs against the fake agent in this process (e2e only); Roles offers it a model so the picker lists it.
pub fn acp_mock_provider(agents: &AgentSlot) -> Option<String> {
    agents.host.acp_mock_provider()
}

/// The prompt plus the `@file` mentions as absolute paths (the agent reads them like any other file).
fn with_attachments(text: String, attachments: &[AgentAttachment], repos: &[RepoRef]) -> Res<String> {
    if attachments.is_empty() {
        return Ok(text);
    }
    let mut lines = Vec::new();
    for a in attachments {
        let repo = repos.iter().find(|r| r.id == a.repo_id).ok_or_else(|| EngineError::new("unknownRepo", format!("unknown repository {}", a.repo_id)))?;
        if a.path.split('/').any(|c| c == "..") || a.path.starts_with('/') || a.path.chars().any(char::is_control) {
            return Err(EngineError::new("invalidPath", format!("{} is not a path inside the repository", a.path)));
        }
        lines.push(format!("- {}", repo.path.join(&a.path).display()));
    }
    Ok(format!("{text}\n\nFiles the user referenced:\n{}", lines.join("\n")))
}

#[tauri::command]
pub async fn agent_send(engine: State<'_, EngineSlot>, agents: State<'_, AgentSlot>, store: State<'_, crate::modules::attachments::AttachmentsState>, agent_id: String, text: String, attachments: Option<Vec<AgentAttachment>>, files: Option<FileSelection>) -> Res<()> {
    let attachments = attachments.unwrap_or_default();
    let repos = if attachments.is_empty() { Vec::new() } else { repos(&engine).await? };
    let text = with_attachments(text, &attachments, &repos)?;
    // Attached files (drag-drop, paste, picker): resolved from the store, an unconfirmed guarded file stops the send.
    let files = match files {
        Some(sel) if !sel.ids.is_empty() => store
            .store
            .resolve_for_send(&sel.draft_id, &sel.ids)
            .map_err(|e| EngineError::new(e.code, e.message))?
            .into_iter()
            .map(|r| serde_json::to_value(r).unwrap_or_default())
            .collect(),
        _ => Vec::new(),
    };
    let host = agents.host.clone();
    blocking(move || host.send_with(&agent_id, &text, files)).await
}

/// The attachments of a composer draft that go with a message (`attachment_*` commands hold the files).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSelection {
    pub draft_id: String,
    pub ids: Vec<String>,
}

#[tauri::command]
pub async fn agent_interrupt(agents: State<'_, AgentSlot>, agent_id: String) -> Res<()> {
    let host = agents.host.clone();
    blocking(move || host.interrupt(&agent_id)).await
}

#[tauri::command]
pub async fn agent_answer_permission(
    agents: State<'_, AgentSlot>,
    agent_id: String,
    request_id: String,
    decision: PermissionDecision,
    mode: Option<PermissionMode>,
    feedback: Option<String>,
) -> Res<()> {
    let host = agents.host.clone();
    blocking(move || host.answer_permission_with(&agent_id, &request_id, decision, AnswerExtra { mode, feedback })).await
}

/// Switches the permission mode of a run live (permission-modes spec 4.9, 5.1). `confirm_bypass` is the user's yes to the Bypass dialog.
#[tauri::command]
pub async fn agent_set_permission(agents: State<'_, AgentSlot>, agent_id: String, mode: PermissionMode, confirm_bypass: Option<bool>) -> Res<AgentSummary> {
    let host = agents.host.clone();
    blocking(move || host.set_mode(&agent_id, mode, SetModeOpts { confirm_bypass: confirm_bypass.unwrap_or(false) })).await
}

/// The live MCP servers of a run (connected, failed, needs-auth, ...) with their tools: what the claude CLI of the session reports.
#[tauri::command]
pub async fn agent_mcp_status(agents: State<'_, AgentSlot>, agent_id: String) -> Res<Vec<McpServerStatus>> {
    let host = agents.host.clone();
    blocking(move || host.mcp_status(&agent_id, None, None)).await
}

/// Adds a note to the running turn: for the sub-agent started by `parent_tool_id` (the id of the lead's `Agent` call), or the lead when
/// absent. Delivered with that agent's next tool call; the `note` events report queued, delivered or dropped. Returns the note id.
#[tauri::command]
pub async fn agent_note(agents: State<'_, AgentSlot>, agent_id: String, parent_tool_id: Option<String>, text: String) -> Res<String> {
    let host = agents.host.clone();
    blocking(move || host.note(&agent_id, parent_tool_id, &text)).await
}

/// How much of the plan's 5 hour session and 7 day week is used, from the signed-in Claude account (the answer of `usage/limits`, with an
/// `error` field when it cannot be read). Starts the sidecar and the claude CLI for a moment; no model call.
#[tauri::command]
pub async fn agent_usage_limits(agents: State<'_, AgentSlot>) -> Res<serde_json::Value> {
    let host = agents.host.clone();
    blocking(move || host.usage_limits()).await
}

/// Asks the session to reconnect one of its MCP servers, then returns the fresh status.
#[tauri::command]
pub async fn agent_mcp_reconnect(agents: State<'_, AgentSlot>, agent_id: String, server: String) -> Res<Vec<McpServerStatus>> {
    let host = agents.host.clone();
    blocking(move || host.mcp_status(&agent_id, Some(server), None)).await
}

/// The modes a NEW run of this provider may start in: `supported_modes(provider)` minus what the kill switch disables.
#[tauri::command]
pub async fn agent_modes(agents: State<'_, AgentSlot>, provider: String) -> Res<Vec<PermissionMode>> {
    let no_unattended = agents.no_unattended;
    Ok(supported_modes(&provider).iter().copied().filter(|m| !(no_unattended && m.is_unattended())).collect())
}

#[tauri::command]
pub async fn agent_answer_question(agents: State<'_, AgentSlot>, agent_id: String, request_id: String, answer: QuestionAnswer) -> Res<()> {
    let host = agents.host.clone();
    blocking(move || host.answer_question(&agent_id, &request_id, answer)).await
}

#[tauri::command]
pub async fn agent_list(agents: State<'_, AgentSlot>) -> Res<Vec<AgentSummary>> {
    let host = agents.host.clone();
    blocking(move || Ok(host.list())).await
}

#[tauri::command]
pub async fn agent_history(agents: State<'_, AgentSlot>, agent_id: String, after_seq: Option<u64>) -> Res<Vec<AgentEvent>> {
    let host = agents.host.clone();
    blocking(move || host.history(&agent_id, after_seq)).await
}

#[tauri::command]
pub async fn agent_rewind(agents: State<'_, AgentSlot>, agent_id: String) -> Res<()> {
    let host = agents.host.clone();
    blocking(move || host.rewind(&agent_id)).await
}

#[tauri::command]
pub async fn agent_repo_files(engine: State<'_, EngineSlot>, agents: State<'_, AgentSlot>, repo_id: String, query: String, limit: u32) -> Res<Vec<String>> {
    let repos = repos(&engine).await?;
    let repo = repos.into_iter().find(|r| r.id == repo_id).ok_or_else(|| EngineError::new("unknownRepo", format!("unknown repository {repo_id}")))?;
    let git = agents.git.clone();
    blocking(move || Ok(intely_agent_host::repo_files(&git, &repo.path, &query, limit as usize))).await
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// A scripted supervisor: `stop` ends a run unless it is listed in `stubborn`.
    #[derive(Default)]
    struct Fake {
        runs: Mutex<Vec<(String, Phase)>>,
        stubborn: Vec<String>,
        stops: Mutex<Vec<String>>,
    }

    impl RunControl for Fake {
        fn runs(&self) -> Vec<(String, Phase)> {
            self.runs.lock().unwrap().clone()
        }
        fn stop(&self, id: &str) {
            self.stops.lock().unwrap().push(id.to_owned());
            if !self.stubborn.iter().any(|s| s == id) {
                self.runs.lock().unwrap().retain(|(r, _)| r != id);
            }
        }
    }

    fn fake(runs: &[(&str, Phase)], stubborn: &[&str]) -> AgentsHook<Fake> {
        AgentsHook::new(Fake {
            runs: Mutex::new(runs.iter().map(|(i, p)| ((*i).to_owned(), *p)).collect()),
            stubborn: stubborn.iter().map(|s| (*s).to_owned()).collect(),
            stops: Mutex::default(),
        })
    }

    #[test]
    fn busy_counts_working_and_waiting_runs_separately() {
        let hook = fake(&[("a1", Phase::Active), ("q-1", Phase::Active), ("a2", Phase::NeedsYou)], &[]);
        assert_eq!(hook.name(), "agents");
        let busy = hook.busy();
        assert_eq!(busy.len(), 2);
        assert_eq!((busy[0].kind.clone(), busy[0].count, busy[0].labels.clone()), (BusyKind::Agent, 2, vec!["a1".to_owned(), "q-1".to_owned()]));
        assert_eq!((busy[1].kind.clone(), busy[1].count, busy[1].labels.clone()), (BusyKind::Agent, 1, vec!["a2".to_owned()]));
        assert!(fake(&[], &[]).busy().is_empty());
        assert_eq!(fake(&[("only", Phase::NeedsYou)], &[]).busy().len(), 1);
    }

    #[test]
    fn stop_interrupts_every_run_twice_is_harmless_and_new_runs_can_follow() {
        let hook = fake(&[("a1", Phase::Active), ("a2", Phase::NeedsYou)], &[]);
        let warnings = tauri::async_runtime::block_on(hook.stop());
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(*hook.control.stops.lock().unwrap(), vec!["a1", "a2"]);
        assert!(hook.busy().is_empty());
        assert!(tauri::async_runtime::block_on(hook.stop()).is_empty(), "stop twice");
        assert_eq!(hook.control.stops.lock().unwrap().len(), 2, "nothing was interrupted the second time");
        // the module is usable afterwards: a run started in the next workspace is seen and stopped again
        hook.control.runs.lock().unwrap().push(("a3".into(), Phase::Active));
        assert_eq!(hook.busy()[0].count, 1);
        assert!(tauri::async_runtime::block_on(hook.stop()).is_empty());
    }

    #[test]
    fn a_run_that_does_not_end_in_time_is_reported_and_the_rest_still_stops() {
        let control = Fake {
            runs: Mutex::new(vec![("a1".into(), Phase::Active), ("slow".into(), Phase::Active)]),
            stubborn: vec!["slow".into()],
            stops: Mutex::default(),
        };
        let left = stop_runs(&control, Duration::from_millis(150));
        assert_eq!(left, vec!["slow"]);
        assert_eq!(control.runs().len(), 1);
    }

    fn ns(v: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        v.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn the_auto_defaults_come_from_the_agents_settings_and_invalid_values_fall_back() {
        let d = AgentDefaults::default();
        assert_eq!(defaults_from(&ns(serde_json::json!({}))), d, "an empty namespace is the built-in defaults");
        let custom = defaults_from(&ns(serde_json::json!({"defaultModel": "opus", "defaultEffort": "high", "delegationCap": 7, "maxBudgetUsd": 4.5, "autoEnabled": false, "delegationEnabled": false})));
        assert_eq!((custom.effort, custom.delegation_cap, custom.max_budget_usd, custom.auto_enabled, custom.delegation_enabled), (Some(Effort::High), 7, Some(4.5), false, false));
        assert!(custom.model.contains("opus"), "{}", custom.model);
        // Haiku has no effort control; max is refused; the cap is clamped; garbage is ignored
        let haiku = defaults_from(&ns(serde_json::json!({"defaultModel": "haiku", "defaultEffort": "high"})));
        assert_eq!(haiku.effort, None);
        assert_eq!(defaults_from(&ns(serde_json::json!({"defaultEffort": "max"}))).effort, Some(Effort::Medium));
        let nested = defaults_from(&ns(serde_json::json!({"auto": {"enabled": false}, "delegation": {"enabled": false}, "autoEnabled": true})));
        assert!(!nested.auto_enabled && !nested.delegation_enabled, "the nested switches the UI writes win over the flat keys");
        assert_eq!(defaults_from(&ns(serde_json::json!({"delegationCap": 500}))).delegation_cap, 40);
        assert_eq!(defaults_from(&ns(serde_json::json!({"delegationCap": 0}))).delegation_cap, 1);
        let junk = defaults_from(&ns(serde_json::json!({"defaultModel": 3, "defaultEffort": "turbo", "delegationCap": "x", "maxBudgetUsd": -2, "autoEnabled": "no"})));
        assert_eq!(junk, d);
    }

    #[test]
    fn claude_blocks_auto_only_when_it_is_off_missing_or_logged_out() {
        assert_eq!(claude_unavailable(&ProviderState::Off), Some("claudeDisabled"));
        assert_eq!(claude_unavailable(&ProviderState::NotInstalled), Some("notInstalled"));
        assert_eq!(claude_unavailable(&ProviderState::NeedsLogin), Some("notLoggedIn"));
        for ok in [ProviderState::Ready, ProviderState::Probing, ProviderState::Throttled] {
            assert_eq!(claude_unavailable(&ok), None);
        }
    }

    #[test]
    fn the_gate_refuses_a_new_agent_while_a_switch_is_under_way() {
        use crate::modules::switchhook::{check_optional, testing::FakeClock, SwitchGate};
        let gate = SwitchGate::new(Arc::new(FakeClock::new()));
        assert!(check_optional(Some(&gate)).is_ok());
        gate.set().hold();
        assert_eq!(check_optional(Some(&gate)).unwrap_err().code, intely_core::code::WORKSPACE_SWITCHING);
    }
}
