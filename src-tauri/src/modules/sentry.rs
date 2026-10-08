//! Tauri glue of the Sentry integration on top of `intely_sentry`: the saved address and organization, the token (it never
//! reaches the webview: it goes in through `sentry_save_token` and stays in the Keychain), and the issue calls.
//! The test jails never reach the network, and the two calls that change something at Sentry (assign, set status) are refused in
//! read-only mode like a git push is.

use std::sync::Arc;

use intely_core::jail::{Jail, Mode};
use intely_core::EngineError;
use intely_sentry::{ApiProblem, Connection, Issue, IssueDetail, IssuePage, IssueQuery, Project, Sentry, Status};
use tauri::{Manager, State};

use super::settings::SettingsState;

type Res<T> = Result<T, EngineError>;

/// The service, or why it could not start (no settings store); every command then reports that reason.
pub struct SentryState {
    svc: Result<Arc<Sentry>, EngineError>,
}

impl SentryState {
    fn svc(&self) -> Res<Arc<Sentry>> {
        self.svc.clone()
    }
}

/// Called once from `setup`. Creating the service reads no Keychain item and opens no connection.
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let svc = match app.try_state::<SettingsState>().and_then(|s| s.parts()) {
        Some((settings, secrets)) => Ok(Arc::new(Sentry::new(settings, secrets))),
        None => Err(EngineError::new("unavailable", "Settings are unavailable, so the Sentry integration cannot start")),
    };
    app.manage(SentryState { svc });
    Ok(())
}

fn engine(p: ApiProblem) -> EngineError {
    EngineError { code: p.code, message: p.message, detail: p.retry_after_s.map(|s| format!("retryAfterSeconds={s}")) }
}

/// The test jail has no network; the read-only jail may look but not change anything at Sentry.
fn network(jail: &Jail, mutating: bool) -> Res<()> {
    match jail.mode() {
        Mode::E2e => Err(EngineError::new("testJail", "the test jail does not reach the network")),
        Mode::ReadOnly if mutating => Err(EngineError::new("readOnly", "The IDE is read-only, so nothing is changed at Sentry")),
        _ => Ok(()),
    }
}

#[tauri::command]
pub async fn sentry_status(state: State<'_, SentryState>) -> Res<Status> {
    Ok(state.svc()?.status())
}

#[tauri::command]
pub async fn sentry_set_config(state: State<'_, SentryState>, base_url: Option<String>, org: Option<String>) -> Res<Status> {
    state.svc()?.set_config(base_url, org).map_err(engine)
}

#[tauri::command]
pub async fn sentry_save_token(state: State<'_, SentryState>, token: String) -> Res<Connection> {
    network(&Jail::global(), false)?;
    Ok(state.svc()?.save_token(&token).await)
}

#[tauri::command]
pub async fn sentry_clear_token(state: State<'_, SentryState>) -> Res<Status> {
    Ok(state.svc()?.clear_token().await)
}

#[tauri::command]
pub async fn sentry_test(state: State<'_, SentryState>) -> Res<Connection> {
    network(&Jail::global(), false)?;
    Ok(state.svc()?.test().await)
}

#[tauri::command]
pub async fn sentry_projects(state: State<'_, SentryState>) -> Res<Vec<Project>> {
    network(&Jail::global(), false)?;
    state.svc()?.projects().await.map_err(engine)
}

#[tauri::command]
pub async fn sentry_issues(state: State<'_, SentryState>, query: IssueQuery) -> Res<IssuePage> {
    network(&Jail::global(), false)?;
    state.svc()?.issues(query).await.map_err(engine)
}

#[tauri::command]
pub async fn sentry_issue(state: State<'_, SentryState>, id: String) -> Res<IssueDetail> {
    network(&Jail::global(), false)?;
    state.svc()?.issue(&id).await.map_err(engine)
}

/// Assigns the issue to the person the token belongs to (the first step of "Fix with agent").
#[tauri::command]
pub async fn sentry_assign_me(state: State<'_, SentryState>, id: String) -> Res<Issue> {
    network(&Jail::global(), true)?;
    state.svc()?.assign_me(&id).await.map_err(engine)
}

/// `resolved`, `unresolved` or `ignored`.
#[tauri::command]
pub async fn sentry_set_status(state: State<'_, SentryState>, id: String, status: String) -> Res<Issue> {
    network(&Jail::global(), true)?;
    state.svc()?.set_status(&id, &status).await.map_err(engine)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_problem_keeps_its_code_and_says_when_to_retry() {
        let e = engine(ApiProblem { code: "rateLimited".into(), message: "slow down".into(), retry_after_s: Some(17) });
        assert_eq!((e.code.as_str(), e.detail.as_deref()), ("rateLimited", Some("retryAfterSeconds=17")));
        assert_eq!(engine(ApiProblem::new("notFound", "x")).detail, None);
    }

    #[test]
    fn the_test_jail_has_no_network_and_the_read_only_jail_changes_nothing_at_sentry() {
        let off = Jail::off();
        assert!(network(&off, false).is_ok() && network(&off, true).is_ok());
        let ro = Jail::read_only();
        assert!(network(&ro, false).is_ok());
        assert_eq!(network(&ro, true).unwrap_err().code, "readOnly");
        let e2e = Jail::e2e(std::env::temp_dir());
        assert_eq!(network(&e2e, false).unwrap_err().code, "testJail");
    }
}
