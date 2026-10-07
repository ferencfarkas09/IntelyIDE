//! Tauri glue of the `happy` module (track F): commands and state on top of `intely_happy`. Commands listed in
//! `generate_handler!` under the "track F commands" marker in `lib.rs`; state is created in `setup`.
//!
//! The token never reaches the webview: it is saved through `happy_save_token` (validated first, stored in the secret
//! store) and read back only inside `intely_happy`. Join links never leave Rust: `happy_meet_join` opens them itself.

use std::sync::{Arc, Mutex};

use intely_core::EngineError;
use intely_happy::types::{ConfigPatch, ConnectionTest, HappyStatus, MeetView, ProviderState, TaskSearch, TimeTotals, TimerView, TodayView, Trackable};
use intely_happy::{ApiError, Hub, Opener, Sink};
use tauri::{AppHandle, Emitter, Manager, State};

use super::settings::SettingsState;

type Res<T> = Result<T, EngineError>;

/// What the Dock badge is made of: the Team chat unread (messages plus threads with new replies) and the inbox unread, each
/// counted only while its provider runs (switched on and `ready`/`degraded`).
#[derive(Default)]
struct BadgeInputs {
    chat: u32,
    inbox: u32,
    chat_up: bool,
    inbox_up: bool,
    shown: Option<i64>,
}

/// The number for the Dock icon, `None` (no badge) at zero.
fn badge_total(chat: Option<u32>, inbox: Option<u32>) -> Option<i64> {
    let total = i64::from(chat.unwrap_or(0)) + i64::from(inbox.unwrap_or(0));
    (total > 0).then_some(total)
}

fn provider_up(status: &HappyStatus, id: &str, enabled: bool) -> bool {
    status.config.master && enabled && status.providers.iter().any(|p| p.id == id && matches!(p.state, ProviderState::Ready | ProviderState::Degraded))
}

struct TauriSink(AppHandle, Mutex<BadgeInputs>);

impl TauriSink {
    fn new(app: AppHandle) -> Self {
        Self(app, Mutex::new(BadgeInputs::default()))
    }

    /// Updates the Dock badge when the number changed. macOS only; a no-op without a main window (E2E jail), never panics.
    fn refresh_badge(&self, change: impl FnOnce(&mut BadgeInputs)) {
        if !cfg!(target_os = "macos") {
            return;
        }
        let next = {
            let Ok(mut b) = self.1.lock() else { return };
            change(&mut b);
            let next = badge_total(b.chat_up.then_some(b.chat), b.inbox_up.then_some(b.inbox));
            if next == b.shown {
                return;
            }
            b.shown = next;
            next
        };
        if let Some(window) = self.0.get_webview_window("main") {
            let _ = window.set_badge_count(next);
        }
    }
}

impl Sink for TauriSink {
    fn state(&self, status: &HappyStatus) {
        let _ = self.0.emit("happy:state", status);
        let (chat_up, inbox_up) = (provider_up(status, "chat", status.config.chat.enabled), provider_up(status, "notifications", status.config.notifications.enabled));
        self.refresh_badge(|b| (b.chat_up, b.inbox_up) = (chat_up, inbox_up));
    }

    fn timer(&self, view: &TimerView) {
        let _ = self.0.emit("happy:timer", view);
    }

    fn meetings(&self, view: &MeetView) {
        let _ = self.0.emit("happy:meetings", view);
    }

    fn chat(&self, event: &intely_happy::types::ChatEvent) {
        let _ = self.0.emit("happy:chat", event);
        if let intely_happy::types::ChatEvent::Summary { summary } = event {
            self.refresh_badge(|b| b.chat = summary.unread_total + summary.thread_unread);
        }
    }

    fn notifications(&self, view: &intely_happy::notifications::NotificationsView) {
        let _ = self.0.emit("happy:notifications", view);
        self.refresh_badge(|b| b.inbox = view.unread);
    }

    fn tasks(&self, view: &intely_happy::tasks::TasksView) {
        let _ = self.0.emit("happy:tasks", view);
    }
}

struct Browser;

impl Opener for Browser {
    fn open(&self, url: &str) -> Result<(), String> {
        intely_happy::external::open_in_browser(url)
    }
}

/// The hub, or why it could not start (an unreadable settings.json); every command then reports that reason.
pub struct HappyState {
    hub: Result<Hub, EngineError>,
}

impl HappyState {
    pub(super) fn hub(&self) -> Res<&Hub> {
        self.hub.as_ref().map_err(Clone::clone)
    }
}

fn to_engine(e: ApiError) -> EngineError {
    EngineError::new(&e.code, e.message)
}

/// Called once from `setup` (track F state marker). Creating the hub builds no client, spawns nothing and reads no
/// Keychain item; `start` only waits and applies when the master switch and a provider are on.
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let parts = app.try_state::<SettingsState>().and_then(|s| s.parts());
    let hub = match parts {
        Some((settings, secrets)) => {
            let hub = Hub::new(settings, secrets, Arc::new(TauriSink::new(app.handle().clone())), Arc::new(Browser));
            let starter = hub.clone();
            tauri::async_runtime::spawn(async move { starter.start().await });
            Ok(hub)
        }
        None => Err(EngineError::new("unavailable", "Settings are unavailable, so the integrations cannot start")),
    };
    app.manage(HappyState { hub });
    Ok(())
}

/// The window focus from `RunEvent::WindowEvent` (lib.rs): providers poll only while the window is focused.
pub fn set_focus(app: &AppHandle, focused: bool) {
    if let Some(Ok(hub)) = app.try_state::<HappyState>().map(|s| s.hub.clone()) {
        hub.set_focus(focused);
    }
}

#[tauri::command]
pub async fn happy_status(state: State<'_, HappyState>) -> Res<HappyStatus> {
    Ok(state.hub()?.status().await)
}

#[tauri::command]
pub async fn happy_set_config(state: State<'_, HappyState>, patch: ConfigPatch) -> Res<HappyStatus> {
    state.hub()?.set_config(patch).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_save_token(state: State<'_, HappyState>, token: String) -> Res<ConnectionTest> {
    Ok(state.hub()?.save_token(&token).await)
}

#[tauri::command]
pub async fn happy_test_connection(state: State<'_, HappyState>) -> Res<ConnectionTest> {
    Ok(state.hub()?.test_connection().await)
}

#[tauri::command]
pub async fn happy_disconnect(state: State<'_, HappyState>) -> Res<HappyStatus> {
    Ok(state.hub()?.disconnect().await)
}

#[tauri::command]
pub async fn happy_timer_current(state: State<'_, HappyState>) -> Res<TimerView> {
    Ok(state.hub()?.timer_current())
}

#[tauri::command]
pub async fn happy_timer_start(state: State<'_, HappyState>, target: Trackable) -> Res<TimerView> {
    state.hub()?.timer_start(target).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_timer_stop(state: State<'_, HappyState>) -> Res<TimerView> {
    state.hub()?.timer_stop().await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_timer_pause(state: State<'_, HappyState>) -> Res<TimerView> {
    state.hub()?.timer_pause().await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_timer_resume(state: State<'_, HappyState>) -> Res<TimerView> {
    state.hub()?.timer_resume().await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_timer_trackables(state: State<'_, HappyState>) -> Res<Vec<Trackable>> {
    state.hub()?.timer_trackables().await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_timer_entries(state: State<'_, HappyState>, from_ms: i64, to_ms: i64) -> Res<TodayView> {
    state.hub()?.timer_entries(from_ms, to_ms).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_timer_totals(state: State<'_, HappyState>, day_ms: i64, week_ms: i64, month_ms: i64) -> Res<TimeTotals> {
    state.hub()?.timer_totals(day_ms, week_ms, month_ms).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_timer_search(state: State<'_, HappyState>, query: String) -> Res<TaskSearch> {
    state.hub()?.timer_search(&query).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_timer_create_task(state: State<'_, HappyState>, project_id: String, title: String) -> Res<Trackable> {
    state.hub()?.timer_create_task(&project_id, &title).await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_meet_list(state: State<'_, HappyState>) -> Res<MeetView> {
    state.hub()?.meet_list().await.map_err(to_engine)
}

#[tauri::command]
pub async fn happy_meet_current(state: State<'_, HappyState>) -> Res<MeetView> {
    Ok(state.hub()?.meet_current())
}

#[tauri::command]
pub async fn happy_meet_join(state: State<'_, HappyState>, id: String) -> Res<()> {
    state.hub()?.meet_join(&id).await.map_err(to_engine)
}

/// Automated runs (the E2E jail) never open a browser window, like `preview_open_external`.
fn refuse_in_e2e(jail: &intely_core::jail::Jail) -> Res<()> {
    if jail.mode() == intely_core::jail::Mode::E2e {
        return Err(EngineError::new("testJail", "the E2E jail does not open a browser"));
    }
    Ok(())
}

/// Opens an https link in the system browser. Anything else is refused, and the URL is never logged or echoed.
#[tauri::command]
pub async fn open_external(url: String) -> Res<()> {
    refuse_in_e2e(&intely_core::jail::Jail::global())?;
    tauri::async_runtime::spawn_blocking(move || intely_happy::external::open_in_browser(&url))
        .await
        .map_err(|_| EngineError::new("io", "the browser task failed"))?
        .map_err(|message| EngineError::new("openFailed", message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use intely_core::jail::Jail;

    #[test]
    fn dock_badge_sums_running_providers_and_clears_at_zero() {
        assert_eq!(badge_total(Some(3), Some(2)), Some(5));
        assert_eq!(badge_total(Some(4), None), Some(4));
        assert_eq!(badge_total(None, Some(1)), Some(1));
        assert_eq!(badge_total(Some(0), Some(0)), None);
        assert_eq!(badge_total(None, None), None);
    }

    #[test]
    fn open_external_is_refused_in_the_e2e_jail_only() {
        let err = refuse_in_e2e(&Jail::e2e(std::env::temp_dir())).unwrap_err();
        assert_eq!(err.code, "testJail");
        assert!(refuse_in_e2e(&Jail::off()).is_ok());
        assert!(refuse_in_e2e(&Jail::read_only()).is_ok());
    }
}
