//! Tauri glue of MCP server management ((design notes: mcp-management-spec) 3): the twelve `mcp_*` commands on top of `intely_mcp`, and the supplier the
//! agent host consumes. Commands listed in `generate_handler!` under the "MCP commands" marker in `lib.rs`; state is created in `setup`, right after
//! the settings module and before the agent host (`AgentSlot::new` asks for the suppliers).
//!
//! No command returns a secret. Error text goes through the exact-value scrubber (the secrets of the call) and `redact` before it leaves Rust.
//! The webview cannot write the `mcp` settings namespace or an `mcp.` secret key (`settings.rs`): only these commands can.

use std::collections::BTreeMap;
use std::sync::Arc;

use intely_agent_core::mcp::{McpError, McpRulesSupplier, McpScrubSupplier, McpSupplier};
use intely_core::jail::Jail;
use intely_core::EngineError;
use intely_mcp::types::*;
use intely_mcp::{McpErr, McpStore, Scrubber, StoreConfig};
use intely_pathpick::Purpose;
use tauri::{AppHandle, Manager, State};

use crate::commands::EngineSlot;
use crate::modules::picker::PickerState;
use crate::modules::settings::SettingsState;

type Res<T> = Result<T, EngineError>;

/// The MCP store, or the reason it could not start (a corrupt or newer settings.json): then every command and the supplier return that error.
pub struct McpState {
    store: Result<Arc<McpStore>, EngineError>,
}

impl McpState {
    fn store(&self) -> Res<Arc<McpStore>> {
        self.store.clone()
    }

    /// The supplier `HostConfig.mcp_supplier` carries: a run's selection in, the SDK config (secrets resolved here) and the broker rules out.
    pub fn supplier(&self) -> McpSupplier {
        match &self.store {
            Ok(store) => intely_mcp::supplier(Arc::clone(store)),
            Err(e) => {
                let err = McpError { code: e.code.clone(), message: e.message.clone() };
                Arc::new(move |_| Err(err.clone()))
            }
        }
    }

    /// What Settings say now about the servers of live runs (the tighten-only update); nothing when the store is unavailable.
    pub fn rules_supplier(&self) -> McpRulesSupplier {
        match &self.store {
            Ok(store) => intely_mcp::rules_supplier(Arc::clone(store)),
            Err(_) => Arc::new(|_| Vec::new()),
        }
    }

    /// The secret values of a run's servers, to scrub a transcript the CLI wrote.
    pub fn scrub_supplier(&self) -> McpScrubSupplier {
        match &self.store {
            Ok(store) => intely_mcp::scrub_supplier(Arc::clone(store)),
            Err(e) => {
                let err = McpError { code: e.code.clone(), message: e.message.clone() };
                Arc::new(move |_| Err(err.clone()))
            }
        }
    }
}

/// The scrubbed login environment: the process basics overlaid with the login shell's variables, cut to the allow-list every agent child
/// gets. Nothing else of the IDE process (`INTELY_*`, `ANTHROPIC_*`, an SSH agent) reaches an MCP server or a Test child.
fn base_env(app: &AppHandle) -> BTreeMap<String, String> {
    let mut vars: std::collections::HashMap<String, String> =
        std::env::vars().filter(|(k, _)| matches!(k.as_str(), "PATH" | "HOME" | "USER" | "LANG" | "NVM_DIR") || k.starts_with("LC_")).collect();
    if let Some(engine) = app.try_state::<EngineSlot>().and_then(|s| s.get().ok().map(|e| e.login_env())) {
        vars.extend(engine);
    }
    intely_agent_host::scrub_env(&vars)
}

/// Called once from `setup` (MCP state marker), after `modules::settings::setup`.
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let settings = app.state::<SettingsState>();
    let store = match settings.parts() {
        Some((store, secrets)) => {
            let handle = app.handle().clone();
            let auth_handle = app.handle().clone();
            let mut cfg = StoreConfig::new(Jail::global());
            cfg.env = Arc::new(move || base_env(&handle));
            cfg.auth_mode = Arc::new(move || {
                // the Claude provider's auth mode; without a registry (a corrupt settings file) nothing is known, which is the subscription default
                auth_handle
                    .try_state::<SettingsState>()
                    .and_then(|s| s.registry())
                    .and_then(|r| r.list().ok())
                    .and_then(|l| l.into_iter().find(|p| p.id == "claude").map(|p| p.auth_mode))
                    .unwrap_or_else(|| "subscription".to_owned())
            });
            cfg.client_version = app.package_info().version.to_string();
            if let Some(dir) = std::env::var_os("INTELY_DATA_DIR").filter(|d| !d.is_empty()) {
                cfg.state_dirs.push(dir.into());
            }
            Ok(Arc::new(McpStore::new(store, secrets, cfg)))
        }
        None => Err(settings.unavailable().unwrap_or_else(|| EngineError::new("invalidSettings", "settings.json could not be read"))),
    };
    if let Err(e) = &store {
        eprintln!("mcp unavailable: {e}");
    }
    app.manage(McpState { store });
    Ok(())
}

/// Error text of a call: the exact-value scrubber for the secrets of THIS call, then `redact`.
fn to_engine(e: McpErr, scrub: &Scrubber) -> EngineError {
    let err = EngineError::new(&e.code, scrub.clean(&e.message));
    match e.detail {
        Some(d) => err.with_detail(scrub.clean(&d)),
        None => err,
    }
}

/// Keychain, file and process work never runs on the async executor's threads.
async fn blocking<T: Send + 'static>(state: &McpState, scrub: Scrubber, f: impl FnOnce(Arc<McpStore>) -> Result<T, McpErr> + Send + 'static) -> Res<T> {
    let store = state.store()?;
    let guard = scrub.clone();
    tauri::async_runtime::spawn_blocking(move || f(store))
        .await
        .map_err(|e| EngineError::new("io", format!("task failed: {e}")))?
        .map_err(|e| to_engine(e, &guard))
}

fn no_scrub() -> Scrubber {
    Scrubber::default()
}

#[tauri::command]
pub async fn mcp_list(state: State<'_, McpState>, workspace_id: Option<String>) -> Res<McpList> {
    blocking(&state, no_scrub(), move |s| s.list(workspace_id.as_deref())).await
}

#[tauri::command]
pub async fn mcp_save(state: State<'_, McpState>, input: McpSaveInput) -> Res<McpServerView> {
    // the secret values of this call must not come back in an error message
    let scrub = Scrubber::new(input.env.iter().chain(input.headers.iter()).flatten().filter_map(|v| v.secret_value.as_deref()));
    blocking(&state, scrub, move |s| s.save(input)).await
}

#[tauri::command]
pub async fn mcp_remove(state: State<'_, McpState>, id: String) -> Res<()> {
    blocking(&state, no_scrub(), move |s| s.remove(&id)).await
}

#[tauri::command]
pub async fn mcp_set_enabled(state: State<'_, McpState>, id: String, enabled: bool) -> Res<McpServerView> {
    blocking(&state, no_scrub(), move |s| s.set_enabled(&id, enabled)).await
}

#[tauri::command]
pub async fn mcp_confirm(state: State<'_, McpState>, id: String, confirm_hash: String) -> Res<McpServerView> {
    blocking(&state, no_scrub(), move |s| s.confirm(&id, &confirm_hash)).await
}

#[tauri::command]
pub async fn mcp_workspace_set(mcp: State<'_, McpState>, workspace_id: String, server_id: String, state: McpWorkspaceState) -> Res<McpList> {
    blocking(&mcp, no_scrub(), move |s| s.workspace_set(&workspace_id, &server_id, state)).await
}

#[tauri::command]
pub async fn mcp_set_policy(state: State<'_, McpState>, id: String, patch: McpPolicyPatch) -> Res<McpServerView> {
    blocking(&state, no_scrub(), move |s| s.set_policy(&id, patch)).await
}

/// Spawns (stdio, killed afterwards) or connects (http), reads `tools/list` and persists what it learned. At most one Test per server.
#[tauri::command]
pub async fn mcp_test(state: State<'_, McpState>, id: String, timeout_ms: Option<u64>) -> Res<McpTestReport> {
    let store = state.store()?;
    let name = store.list(None).ok().and_then(|l| l.servers.into_iter().find(|s| s.id == id).map(|s| s.name)).unwrap_or_default();
    let report = store.test(&id, timeout_ms).await.map_err(|e| to_engine(e, &no_scrub()))?;
    // one line per Test: never a command line, a URL, an environment name, a header, a response body or a tool description
    match &report.error {
        None => eprintln!("mcp: test {name} ok in {} ms, {} tools", report.ms as u64, report.tool_count),
        Some(e) => eprintln!("mcp: test {name} failed({}) in {} ms", e.code, report.ms as u64),
    }
    Ok(report)
}

/// Redeems the single-use picker token of the purpose `file:mcpImport` (the path is re-validated, a swapped file is refused), then reads ONLY
/// the top-level `mcpServers` key of that file.
#[tauri::command]
pub async fn mcp_import_preview(state: State<'_, McpState>, picker: State<'_, PickerState>, token: String) -> Res<McpImportPreview> {
    let tokens = picker.tokens();
    let validator = picker.picker().validator.clone();
    let store = state.store()?;
    tauri::async_runtime::spawn_blocking(move || -> Res<McpImportPreview> {
        let redeemed = tokens.redeem(&token, &[Purpose::File("mcpImport".into())], &validator)?;
        store.import_preview(&redeemed.validated.path).map_err(|e| to_engine(e, &no_scrub()))
    })
    .await
    .map_err(|e| EngineError::new("io", format!("task failed: {e}")))?
}

#[tauri::command]
pub async fn mcp_import_apply(state: State<'_, McpState>, import_id: String, picks: Vec<McpImportPick>) -> Res<McpImportResult> {
    blocking(&state, no_scrub(), move |s| s.import_apply(&import_id, &picks)).await
}

#[tauri::command]
pub async fn mcp_secrets_present(state: State<'_, McpState>, ids: Option<Vec<String>>) -> Res<Vec<McpSecretPresence>> {
    blocking(&state, no_scrub(), move |s| s.secrets_present(ids.as_deref())).await
}

#[tauri::command]
pub async fn mcp_run_servers(state: State<'_, McpState>, workspace_id: Option<String>, provider: String) -> Res<Vec<McpRunServer>> {
    blocking(&state, no_scrub(), move |s| s.run_servers(workspace_id.as_deref(), &provider)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_lose_the_secrets_of_the_call_and_credentials() {
        let scrub = Scrubber::new(["CANARY-MCP-7f3a-env"]);
        let e = to_engine(McpErr::new("mcpBadVar", "bad CANARY-MCP-7f3a-env here").with_detail("Bearer abc.def.ghi"), &scrub);
        assert_eq!(e.code, "mcpBadVar");
        assert!(!e.message.contains("CANARY") && !e.detail.unwrap().contains("abc.def"));
    }

    #[test]
    fn an_unavailable_store_answers_every_supplier_with_its_error() {
        let state = McpState { store: Err(EngineError::new("invalidSettings", "settings.json is not valid")) };
        let sel = intely_agent_core::mcp::McpSelection { ids: vec!["m1".into()], strict: true, run_dirs: vec![] };
        assert_eq!((state.supplier())(&sel).err().unwrap().code, "invalidSettings");
        assert!((state.rules_supplier())(&[("m1".into(), "x".into())]).is_empty());
        assert_eq!((state.scrub_supplier())(&["m1".to_owned()]).err().unwrap().code, "invalidSettings");
        assert_eq!(state.store().err().unwrap().code, "invalidSettings");
    }
}
