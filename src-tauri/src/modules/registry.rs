//! Tauri glue of the registry on top of `intely_registry`: whether the person agreed to be registered, the registration itself,
//! what is stored (`registry_me`), the newsletter choice and deleting everything. Nothing is requested before the person agreed on
//! the first-start screen. The key the registry hands out stays in the Keychain; it never reaches the webview.
//!
//! Network policy: HTTPS to the registry host only (`intely_registry::REGISTRY_URL`), the five requests listed in
//! `crates/registry/src/client.rs`, no redirects, 5 s connect / 15 s total, 64 KiB body cap. After the person agreed, one small
//! request goes out at most once an hour when the app starts, 45 s after the start. Debug builds and the E2E jail send nothing on
//! their own. What is sent is listed in `docs/privacy.md`.

use std::sync::Arc;
use std::time::Duration;

use intely_core::jail::{Jail, Mode};
use intely_core::EngineError;
use intely_registry::{Problem, RegisterInput, Registry, Status};
use serde_json::Value;
use tauri::{Manager, State};

use super::settings::SettingsState;

type Res<T> = Result<T, EngineError>;

const PING_DELAY: Duration = Duration::from_secs(45);

/// The service, or why it could not start (no settings store); every command then reports that reason.
pub struct RegistryState {
    svc: Result<Arc<Registry>, EngineError>,
}

impl RegistryState {
    fn svc(&self) -> Res<Arc<Registry>> {
        self.svc.clone()
    }
}

/// Called once from `setup`. Creating the service reads no Keychain item and opens no connection.
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let svc = match app.try_state::<SettingsState>().and_then(|s| s.parts()) {
        Some((settings, secrets)) => Ok(Arc::new(Registry::new(settings, secrets, &app.package_info().version.to_string()))),
        None => Err(EngineError::new("unavailable", "Settings are unavailable, so the registration cannot start")),
    };
    if let Ok(registry) = &svc {
        if ping_allowed(cfg!(debug_assertions), Jail::global().mode() == Mode::E2e) {
            let registry = registry.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(PING_DELAY).await;
                // an answer is not needed: a registry that cannot be reached is tried again at the next start
                let _ = registry.ping().await;
            });
        }
    }
    app.manage(RegistryState { svc });
    Ok(())
}

/// The start-up ping runs in release builds outside the test jail only.
pub fn ping_allowed(debug_build: bool, e2e: bool) -> bool {
    !debug_build && !e2e
}

fn engine(p: Problem) -> EngineError {
    EngineError { code: p.code, message: p.message, detail: p.retry_after_s.map(|s| format!("retryAfterSeconds={s}")) }
}

fn network() -> Res<()> {
    match Jail::global().mode() {
        Mode::E2e => Err(EngineError::new("testJail", "the test jail does not reach the network")),
        _ => Ok(()),
    }
}

#[tauri::command]
pub async fn registry_status(state: State<'_, RegistryState>) -> Res<Status> {
    Ok(shown(state.svc()?.status(), Jail::global().mode() == Mode::E2e))
}

/// The test jail is never asked to register (the first-start screen would stand in front of every scenario).
fn shown(mut status: Status, e2e: bool) -> Status {
    if e2e {
        status.needs_consent = false;
    }
    status
}

#[tauri::command]
pub async fn registry_register(state: State<'_, RegistryState>, input: RegisterInput) -> Res<Status> {
    network()?;
    state.svc()?.register(input).await.map_err(engine)
}

#[tauri::command]
pub async fn registry_decline(state: State<'_, RegistryState>) -> Res<Status> {
    state.svc()?.decline().map_err(engine)
}

/// Everything the registry stores about this computer and its person.
#[tauri::command]
pub async fn registry_me(state: State<'_, RegistryState>) -> Res<Value> {
    network()?;
    state.svc()?.me().await.map_err(engine)
}

#[tauri::command]
pub async fn registry_newsletter(state: State<'_, RegistryState>, on: bool) -> Res<Status> {
    network()?;
    state.svc()?.set_newsletter(on).await.map_err(engine)
}

/// Deletes this computer at the registry (and the person with it when it was their last one) and forgets the key here.
#[tauri::command]
pub async fn registry_forget(state: State<'_, RegistryState>) -> Res<Status> {
    network()?;
    state.svc()?.forget().await.map_err(engine)
}

/// The notice changed: "continue" registers again with the saved details, "stop" deletes everything.
#[tauri::command]
pub async fn registry_reconsent(state: State<'_, RegistryState>, accept: bool, locale: String, tz: String) -> Res<Status> {
    network()?;
    state.svc()?.reconsent(accept, &locale, &tz).await.map_err(engine)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_problem_keeps_its_code_and_says_when_to_retry() {
        let e = engine(Problem { code: "rateLimited".into(), message: "slow down".into(), retry_after_s: Some(17) });
        assert_eq!((e.code.as_str(), e.detail.as_deref()), ("rateLimited", Some("retryAfterSeconds=17")));
        assert_eq!(engine(Problem::new("offline", "x")).detail, None);
    }

    #[test]
    fn the_test_jail_is_never_asked_to_register() {
        let status = Status {
            state: intely_registry::State::Unasked,
            name: None,
            email: None,
            newsletter: None,
            notice: "2026-10-28".into(),
            consented_notice: None,
            needs_consent: true,
            url: "https://api.example.invalid".into(),
        };
        assert!(shown(status.clone(), false).needs_consent);
        assert!(!shown(status, true).needs_consent);
    }

    #[test]
    fn only_release_builds_outside_the_test_jail_ping_by_themselves() {
        assert!(ping_allowed(false, false));
        assert!(!ping_allowed(true, false));
        assert!(!ping_allowed(false, true));
        assert!(!ping_allowed(true, true));
    }
}
