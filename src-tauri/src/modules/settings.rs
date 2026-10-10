//! Tauri glue of the `settings` module (track F): commands and state on top of `intely_settings`. Commands listed in
//! `generate_handler!` under the "track F commands" marker in `lib.rs`; state is created in `setup`.
//!
//! Secret values go in through `secrets_set` and never come back out: there is no command that returns one.

use std::sync::Arc;

use intely_core::EngineError;
use intely_settings::providers::ProviderRegistry;
use intely_settings::secrets::{redact, Secret, SecretStore};
use intely_settings::types::{DoctorFinding, ProviderInfo, ProviderTest};
use intely_settings::{store, MemorySecretStore, Object, SettingsError, SettingsStore};
use tauri::{Emitter, Manager, State};

use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

struct Core {
    store: Arc<SettingsStore>,
    providers: Arc<ProviderRegistry>,
}

/// The settings store and provider registry, or the reason they could not start (a corrupt or newer settings.json is
/// reported by every command and never overwritten). Secrets do not depend on the file.
pub struct SettingsState {
    core: Result<Core, EngineError>,
    secrets: Arc<dyn SecretStore>,
}

impl SettingsState {
    /// The settings and secret stores for a sibling module (the Happy hub); `None` when settings.json could not be read.
    pub(crate) fn parts(&self) -> Option<(Arc<SettingsStore>, Arc<dyn SecretStore>)> {
        self.core.as_ref().ok().map(|c| (Arc::clone(&c.store), Arc::clone(&self.secrets)))
    }

    /// The provider registry (switches, detection, confirmed command lines) for the host's launch table; `None` when settings.json could not be read.
    pub(crate) fn registry(&self) -> Option<Arc<ProviderRegistry>> {
        self.core.as_ref().ok().map(|c| Arc::clone(&c.providers))
    }

    /// Why the settings could not start (a corrupt or newer settings.json), for modules that sit on top of them.
    pub(crate) fn unavailable(&self) -> Option<EngineError> {
        self.core.as_ref().err().cloned()
    }

    fn core(&self) -> Res<&Core> {
        self.core.as_ref().map_err(Clone::clone)
    }
}

/// Namespaces and secret-key prefixes that only their own module's commands may write ((design notes: mcp-management-spec) 3.4): the generic
/// `settings_set`, `secrets_set` and `secrets_remove` would otherwise let the webview skip `mcp_save`'s validation, the secret rules and the
/// confirmation dialog, and write the Keychain proof of a server. `settings_get`, `secrets_has` and the status commands stay open.
/// Every future generic write path (a reset, an import of settings or secrets) checks these lists too. `sentry` is on them so the
/// webview cannot point the saved Sentry token at another address (`sentry_set_config` forgets the token when the address changes), and
/// `servers` so that a server is saved only through `servers_save` (validated destination and folders, a unique id).
pub(crate) const RESERVED_NS: [&str; 3] = ["mcp", "sentry", "servers"];
pub(crate) const RESERVED_SECRET_PREFIXES: [&str; 2] = ["mcp.", "sentry."];

pub(crate) fn check_writable_ns(ns: &str) -> Res<()> {
    if RESERVED_NS.contains(&ns) {
        return Err(EngineError::new("reservedNamespace", format!("the `{ns}` settings are changed through their own commands")));
    }
    Ok(())
}

pub(crate) fn check_writable_secret_key(key: &str) -> Res<()> {
    if RESERVED_SECRET_PREFIXES.iter().any(|p| key.starts_with(p)) {
        return Err(EngineError::new("reservedNamespace", "that secret is managed by its own commands"));
    }
    Ok(())
}

fn to_engine(e: SettingsError) -> EngineError {
    let err = EngineError::new(e.code, redact(&e.message));
    match e.detail {
        Some(d) => err.with_detail(redact(&d)),
        None => err,
    }
}

/// The real Keychain only for a normal run. Tests, the E2E harness and the read-only smoke never touch it (a dev build
/// can pop a Keychain permission dialog), and `INTELY_SECRETS=memory` forces the in-memory store by hand.
fn keychain_allowed(var: impl Fn(&str) -> bool) -> bool {
    !["INTELY_E2E", "INTELY_E2E_SCRIPT", "INTELY_READONLY", "INTELY_SECRETS"].iter().any(|v| var(v))
}

fn secret_store() -> Arc<dyn SecretStore> {
    #[cfg(target_os = "macos")]
    if keychain_allowed(|v| std::env::var_os(v).is_some_and(|x| !x.is_empty())) {
        // A denied Keychain, an ad-hoc-signed dev build the OS distrusts or an unanswered dialog falls back to memory with a
        // message (`secrets_status`), it never fails the call or hangs the settings screen.
        return Arc::new(intely_settings::FallbackSecretStore::new(Arc::new(intely_settings::KeychainSecretStore)));
    }
    Arc::new(MemorySecretStore::new())
}

/// The login-shell PATH once resolved (the process PATH plus fallbacks before that): CLIs are found like a terminal would.
fn login_path(engine: &EngineSlot) -> String {
    let path = engine.get().ok().and_then(|e| e.login_env().get("PATH").cloned()).or_else(|| std::env::var("PATH").ok()).unwrap_or_default();
    // e2e harness only: a directory with stub CLIs (scenario z puts a `gemini` stub there) searched before the real PATH
    match (std::env::var("INTELY_E2E").is_ok_and(|v| v == "1"), std::env::var("INTELY_E2E_EXTRA_PATH")) {
        (true, Ok(extra)) if !extra.is_empty() => format!("{extra}:{path}"),
        _ => path,
    }
}

/// Called once from `setup` (track F state marker): create and `app.manage(..)` the module state here.
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let secrets = secret_store();
    let core = SettingsStore::open(store::resolve_path()).map_err(to_engine).map(|store| {
        let store = Arc::new(store);
        let providers = Arc::new(ProviderRegistry::new(Arc::clone(&store), Arc::clone(&secrets)));
        let handle = app.handle().clone();
        store.subscribe(move |change| {
            let _ = handle.emit("settings:changed", serde_json::json!({ "ns": change.ns, "value": change.value }));
        });
        let handle = app.handle().clone();
        providers.subscribe(move |change| {
            let _ = handle.emit("providers:state", change);
        });
        Core { store, providers }
    });
    if let Err(e) = &core {
        eprintln!("settings unavailable: {e}");
    }
    app.manage(SettingsState { core, secrets });
    Ok(())
}

#[tauri::command]
pub async fn settings_get(state: State<'_, SettingsState>, ns: String) -> Res<Object> {
    state.core()?.store.get(&ns).map_err(to_engine)
}

#[tauri::command]
pub async fn settings_set(state: State<'_, SettingsState>, ns: String, patch: Object) -> Res<Object> {
    check_writable_ns(&ns)?;
    state.core()?.store.set(&ns, patch).map_err(to_engine)
}

/// What the backend enforces, read-only: the jail mode and the commit guard's built-in lists (Settings > Safety).
#[tauri::command]
pub async fn settings_safety_status() -> serde_json::Value {
    use intely_core::guard;
    use intely_core::jail::{Jail, Mode};
    let jail = Jail::global();
    serde_json::json!({
        "jail": match jail.mode() { Mode::Off => "off", Mode::ReadOnly => "readOnly", Mode::E2e => "e2e" },
        "fixtureRoot": jail.fixture_root().map(|p| p.to_string_lossy().into_owned()),
        "neverAdd": guard::NEVER_ADD,
        "secretPatterns": guard::SECRET,
        "maxUntrackedBytes": guard::MAX_UNTRACKED_BYTES,
    })
}

/// Where a secret entered now is stored, and why the Keychain was given up on (shown next to the secret fields).
#[tauri::command]
pub async fn secrets_status(state: State<'_, SettingsState>) -> Res<serde_json::Value> {
    let h = state.secrets.health();
    Ok(serde_json::json!({ "backend": h.backend, "degraded": h.degraded, "message": h.message.map(|m| redact(&m)) }))
}

/// The user fixed the Keychain access: try it again (the next secret call asks the Keychain).
#[tauri::command]
pub async fn secrets_retry_keychain(state: State<'_, SettingsState>) -> Res<()> {
    state.secrets.retry();
    Ok(())
}

#[tauri::command]
pub async fn secrets_has(state: State<'_, SettingsState>, key: String) -> Res<bool> {
    let secrets = Arc::clone(&state.secrets);
    run_blocking(move || secrets.has(&key)).await
}

#[tauri::command]
pub async fn secrets_set(state: State<'_, SettingsState>, key: String, value: String) -> Res<()> {
    check_writable_secret_key(&key)?;
    let secrets = Arc::clone(&state.secrets);
    let changed = key.clone();
    run_blocking(move || secrets.set(&key, Secret::new(value))).await?;
    if let Ok(core) = state.core() {
        core.providers.key_changed(&changed, true);
    }
    Ok(())
}

#[tauri::command]
pub async fn secrets_remove(state: State<'_, SettingsState>, key: String) -> Res<()> {
    check_writable_secret_key(&key)?;
    let secrets = Arc::clone(&state.secrets);
    let changed = key.clone();
    run_blocking(move || secrets.remove(&key)).await?;
    if let Ok(core) = state.core() {
        core.providers.key_changed(&changed, false);
    }
    Ok(())
}

#[tauri::command]
pub async fn providers_list(state: State<'_, SettingsState>) -> Res<Vec<ProviderInfo>> {
    state.core()?.providers.list().map_err(to_engine)
}

#[tauri::command]
pub async fn providers_detect(state: State<'_, SettingsState>, engine: State<'_, EngineSlot>) -> Res<Vec<ProviderInfo>> {
    let (providers, path) = (Arc::clone(&state.core()?.providers), login_path(&engine));
    run_blocking(move || providers.detect(&path)).await
}

#[tauri::command]
pub async fn providers_test(state: State<'_, SettingsState>, engine: State<'_, EngineSlot>, id: String) -> Res<ProviderTest> {
    let (providers, path) = (Arc::clone(&state.core()?.providers), login_path(&engine));
    run_blocking(move || providers.test(&id, &path)).await
}

#[tauri::command]
pub async fn providers_set_enabled(state: State<'_, SettingsState>, id: String, enabled: bool) -> Res<ProviderInfo> {
    state.core()?.providers.set_enabled(&id, enabled).map_err(to_engine)
}

#[tauri::command]
pub async fn providers_set_auth_mode(state: State<'_, SettingsState>, id: String, mode: String) -> Res<ProviderInfo> {
    state.core()?.providers.set_auth_mode(&id, &mode).map_err(to_engine)
}

/// Doctor additions ((design notes: providers-plan) 4.3): re-detects, then reports CLI state and stray credential variables.
#[tauri::command]
pub async fn providers_doctor(state: State<'_, SettingsState>, engine: State<'_, EngineSlot>) -> Res<Vec<DoctorFinding>> {
    let (providers, path) = (Arc::clone(&state.core()?.providers), login_path(&engine));
    run_blocking(move || {
        providers.detect(&path)?;
        providers.doctor(&|name| std::env::var_os(name).is_some())
    })
    .await
}

/// Detection spawns processes and the Keychain can block; neither belongs on the async executor's threads.
async fn run_blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, SettingsError> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| EngineError::new("io", e.to_string()))?
        .map_err(to_engine)
}

#[cfg(test)]
mod tests {
    use intely_settings::secrets::provider_key;

    use super::*;

    #[test]
    fn the_keychain_is_only_used_when_no_test_or_jail_variable_is_set() {
        assert!(keychain_allowed(|_| false));
        for var in ["INTELY_E2E", "INTELY_E2E_SCRIPT", "INTELY_READONLY", "INTELY_SECRETS"] {
            assert!(!keychain_allowed(|v| v == var), "{var}");
        }
    }

    #[test]
    fn errors_keep_their_code_and_lose_credentials() {
        let e = to_engine(SettingsError::new("keychain", "failed: key=sk-secret-value-123456").with_detail("Bearer abc"));
        assert_eq!(e.code, "keychain");
        assert!(!e.message.contains("secret-value") && !e.detail.unwrap().contains("abc"));
    }

    #[test]
    fn the_safety_status_reports_the_guard_lists_and_a_jail_mode() {
        let status = tauri::async_runtime::block_on(settings_safety_status());
        assert!(["off", "readOnly", "e2e"].contains(&status["jail"].as_str().unwrap()));
        assert!(status["neverAdd"].as_array().is_some_and(|a| !a.is_empty()));
        assert!(status["secretPatterns"].as_array().is_some_and(|a| !a.is_empty()));
        assert!(status["maxUntrackedBytes"].as_u64().unwrap() > 0);
    }

    #[test]
    fn the_mcp_and_sentry_namespaces_and_secret_prefixes_are_not_writable_from_the_webview() {
        for ns in ["mcp", "sentry"] {
            assert_eq!(check_writable_ns(ns).unwrap_err().code, "reservedNamespace", "{ns}");
        }
        for ok in ["editor", "providers", "agents", "mcp2", "mcpx", "sentry2", "sentryx"] {
            assert!(check_writable_ns(ok).is_ok(), "{ok}");
        }
        for key in ["mcp.m3f9a1c0b2d4:confirmed", "mcp.x:env.A", "mcp.m1:hdr.Authorization", "sentry.token", "sentry.other"] {
            assert_eq!(check_writable_secret_key(key).unwrap_err().code, "reservedNamespace", "{key}");
        }
        for ok in [provider_key("openai").as_str(), "happy.token", "mongo.profile:x", "MCP.x", "sentryx.token"] {
            assert!(check_writable_secret_key(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn provider_keys_match_the_registry_naming() {
        assert_eq!(provider_key("claude"), "providers.claude:default");
    }
}
