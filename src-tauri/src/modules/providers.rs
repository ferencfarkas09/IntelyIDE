//! Tauri glue of the experimental providers (Wave4 providers): the global switch, the one-time command-line confirmation,
//! the per-provider "allow weak writer" override, negotiated capabilities and the Test run, on top of `intely_settings`
//! (switches, confirmed lines, hash) and `intely_agent_host` (what actually starts). Commands are listed in
//! `generate_handler!` under the "wave4 providers commands" marker in `lib.rs`.
//!
//! Nothing here runs at startup. The host reads the launch table (`launch_supplier`) whenever a session opens, so a provider
//! that is off, unconfirmed or whose line changed never starts, and the sidecar `--providers` list follows the settings.

use std::sync::Arc;

use intely_agent_core::providers::ProviderCaps;
use intely_agent_host::{ProbeReport, ProviderLaunch};
use intely_core::EngineError;
use intely_settings::providers::ProviderRegistry;
use intely_settings::secrets::redact;
use intely_settings::types::ProviderInfo;
use intely_settings::SettingsError;
use tauri::State;

use crate::agents::{blocking, AgentSlot};
use crate::modules::settings::SettingsState;

type Res<T> = Result<T, EngineError>;

fn to_engine(e: SettingsError) -> EngineError {
    EngineError::new(e.code, redact(&e.message))
}

/// What the host may start now, from the registry's settings (global switch, per-provider switch, confirmed intact line).
pub fn launch_supplier(registry: Arc<ProviderRegistry>) -> intely_agent_host::LaunchSupplier {
    Arc::new(move || {
        registry
            .launch_table()
            .unwrap_or_default()
            .into_iter()
            .map(|e| ProviderLaunch { id: e.id, adapter: e.adapter, command: e.command, args: e.args, allow_weak_writer: e.allow_weak_writer })
            .collect()
    })
}

/// The CLI version the last detection read, for the enforcement staleness check.
pub fn version_supplier(registry: Arc<ProviderRegistry>) -> intely_agent_host::VersionSupplier {
    Arc::new(move |provider| registry.detected_version(provider))
}

fn registry(state: &SettingsState) -> Res<Arc<ProviderRegistry>> {
    state.registry().ok_or_else(|| EngineError::new("settingsUnavailable", "settings.json could not be read"))
}

#[tauri::command]
pub async fn providers_experimental_get(state: State<'_, SettingsState>) -> Res<bool> {
    registry(&state)?.experimental().map_err(to_engine)
}

#[tauri::command]
pub async fn providers_experimental_set(state: State<'_, SettingsState>, on: bool) -> Res<bool> {
    registry(&state)?.set_experimental(on).map_err(to_engine)
}

/// The user confirmed this exact command line (shown in full in the dialog). The program must be an absolute path.
#[tauri::command]
pub async fn providers_confirm_launch(state: State<'_, SettingsState>, id: String, command: String, args: Vec<String>) -> Res<ProviderInfo> {
    registry(&state)?.confirm_launch(&id, &command, args).map_err(to_engine)
}

#[tauri::command]
pub async fn providers_revoke_launch(state: State<'_, SettingsState>, id: String) -> Res<ProviderInfo> {
    registry(&state)?.revoke_launch(&id).map_err(to_engine)
}

/// Settings > Safety. Turning it on needs the provider id typed (`typed`); the check is here, not only in the dialog.
#[tauri::command]
pub async fn providers_set_weak_writer(state: State<'_, SettingsState>, id: String, allow: bool, typed: Option<String>) -> Res<ProviderInfo> {
    registry(&state)?.set_allow_weak_writer(&id, allow, typed.as_deref().unwrap_or("")).map_err(to_engine)
}

/// What a session of this provider reported at start in this process; an error (`notNegotiated`) means none did yet and the
/// caller shows the documented defaults, labelled as such.
#[tauri::command]
pub async fn providers_caps(agents: State<'_, AgentSlot>, id: String) -> Res<ProviderCaps> {
    agents.host().negotiated_caps(&id).ok_or_else(|| EngineError::new("notNegotiated", format!("no session of {id} has reported capabilities yet")))
}

/// The Test run: opens one read-only session in an empty scratch directory, reads what the adapter reports, closes it. No prompt
/// is sent (no model call), nothing is stored and nothing can be edited.
#[tauri::command]
pub async fn providers_test_run(agents: State<'_, AgentSlot>, id: String, model: Option<String>) -> Res<ProbeReport> {
    let host = agents.host().clone();
    blocking(move || host.probe(&id, model.as_deref())).await
}
