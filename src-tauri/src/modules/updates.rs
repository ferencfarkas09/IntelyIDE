//! Update NOTIFICATION (not installation): the app asks GitHub once a day whether a newer release exists and tells the UI,
//! which opens the release page. The user installs the new DMG over the old app. There is no download, no signature step and
//! nothing here touches `crates/updater`; verified in-app updates are planned separately.
//!
//! Commands: `update_status`, `update_check(reason)`, `update_set_enabled`, `update_dismiss`; event `update:status` (the
//! [`UpdateNotice`]) whenever the notice changes. Settings live in the `updates` namespace: `auto` (default true),
//! `lastCheckedAt`, `dismissedVersion`, `disclosedAt`.
//!
//! Network policy: one HTTPS GET to the releases list of `ferencfarkas09/IntelyIDE` on `api.github.com`, no credentials, no
//! header except `Accept` and the `User-Agent`, 5 s connect / 15 s total, 1 MiB body cap, redirects only to the same host.
//! The E2E jail never touches the network. The read-only launch mode allows this read-only GET. The scheduler waits 90 s after
//! start, then checks every 24 h (plus a fixed per-process jitter) while `auto` is on, the one-time disclosure has been seen
//! and the window is focused; after an error it retries in 1 h. Off means no timer: the task waits to be woken. Debug builds
//! start no scheduler (a manual check still works). The endpoint can be overridden only in test and debug builds.

use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use intely_core::jail::{Jail, Mode};
use intely_core::EngineError;
use intely_settings::{Object, SettingsStore};
use intely_updater::notice::{self, Latest};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Notify;

use super::settings::SettingsState;

type Res<T> = Result<T, EngineError>;

const NS: &str = "updates";
const EVENT: &str = "update:status";
const START_DELAY: Duration = Duration::from_secs(90);
const JITTER_SECS: u64 = 30 * 60;

/// The automatic check runs only when switched on, after the disclosure was seen, in release builds and in the foreground.
pub fn auto_allowed(auto: bool, disclosed: bool, focused: bool, debug_build: bool) -> bool {
    auto && disclosed && focused && !debug_build
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn default_endpoint() -> String {
    #[cfg(any(test, debug_assertions))]
    if let Ok(url) = std::env::var("INTELY_UPDATE_TEST_ENDPOINT") {
        if !url.is_empty() {
            return url;
        }
    }
    notice::ENDPOINT.to_owned()
}

// ---------------------------------------------------------------------------------------------------------------------
// The notice

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateState {
    Idle,
    Checking,
    UpToDate,
    Available,
    Error,
    Disabled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNotice {
    pub enabled: bool,
    pub current_version: String,
    pub state: UpdateState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<Latest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dismissed_version: Option<String>,
    /// When the one-time disclosure was shown (the UI shows it while this is missing).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disclosed_at: Option<u64>,
}

#[derive(Default)]
struct Runtime {
    state: Option<UpdateState>,
    latest: Option<Latest>,
    error: Option<String>,
    error_at: Option<u64>,
}

// ---------------------------------------------------------------------------------------------------------------------
// State

type Emit = Box<dyn Fn(&UpdateNotice) + Send + Sync>;

pub struct Updates {
    settings: Option<Arc<SettingsStore>>,
    current: String,
    mode: Mode,
    endpoint: String,
    jitter: u64,
    focused: AtomicBool,
    wake: Notify,
    runtime: Mutex<Runtime>,
    emit: Emit,
}

impl Updates {
    fn new(settings: Option<Arc<SettingsStore>>, current: String, mode: Mode, endpoint: String, emit: Emit) -> Arc<Self> {
        let jitter = u64::from(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0)) % JITTER_SECS;
        Arc::new(Self { settings, current, mode, endpoint, jitter, focused: AtomicBool::new(true), wake: Notify::new(), runtime: Mutex::new(Runtime::default()), emit })
    }

    fn rt(&self) -> MutexGuard<'_, Runtime> {
        self.runtime.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn ns(&self) -> Object {
        self.settings.as_ref().and_then(|s| s.get(NS).ok()).unwrap_or_default()
    }

    fn put(&self, patch: Value) -> Res<()> {
        let Some(store) = &self.settings else { return Err(EngineError::new("unavailable", "settings are unavailable")) };
        let Value::Object(map) = patch else { return Ok(()) };
        store.set(NS, map).map(|_| ()).map_err(|e| EngineError::new("unavailable", format!("settings: {}", e.message)))
    }

    fn auto(&self) -> bool {
        self.ns().get("auto").and_then(Value::as_bool).unwrap_or(true)
    }

    fn disclosed(&self) -> bool {
        self.ns().get("disclosedAt").and_then(Value::as_u64).is_some()
    }

    fn auto_ok(&self) -> bool {
        auto_allowed(self.auto(), self.disclosed(), self.focused.load(AtomicOrdering::Relaxed), cfg!(debug_assertions))
    }

    fn notice(&self) -> UpdateNotice {
        let ns = self.ns();
        let enabled = ns.get("auto").and_then(Value::as_bool).unwrap_or(true);
        let rt = self.rt();
        let (state, error) = if self.mode == Mode::E2e {
            (UpdateState::Disabled, Some("testJail".to_owned()))
        } else {
            match rt.state {
                Some(s) => (s, rt.error.clone()),
                None if !enabled => (UpdateState::Disabled, None),
                None => (UpdateState::Idle, None),
            }
        };
        UpdateNotice {
            enabled,
            current_version: self.current.clone(),
            state,
            latest: if state == UpdateState::Available { rt.latest.clone() } else { None },
            last_checked_at: ns.get("lastCheckedAt").and_then(Value::as_u64),
            error,
            dismissed_version: ns.get("dismissedVersion").and_then(Value::as_str).map(str::to_owned),
            disclosed_at: ns.get("disclosedAt").and_then(Value::as_u64),
        }
    }

    fn publish(&self) -> UpdateNotice {
        let n = self.notice();
        (self.emit)(&n);
        n
    }

    /// One check. `auto` is refused unless [`auto_allowed`]; the E2E jail never reaches the network.
    pub async fn check(&self, auto: bool) -> UpdateNotice {
        if self.mode == Mode::E2e || (auto && !self.auto_ok()) {
            return self.notice();
        }
        {
            let mut rt = self.rt();
            if rt.state == Some(UpdateState::Checking) {
                drop(rt);
                return self.notice();
            }
            rt.state = Some(UpdateState::Checking);
        }
        self.publish();
        let outcome = notice::check(&self.endpoint, &self.current).await;
        let now = now_secs();
        let ok = outcome.is_ok();
        {
            let mut rt = self.rt();
            match outcome {
                Ok(latest) => {
                    rt.state = Some(if latest.is_some() { UpdateState::Available } else { UpdateState::UpToDate });
                    rt.latest = latest;
                    rt.error = None;
                    rt.error_at = None;
                }
                Err(code) => {
                    rt.state = Some(UpdateState::Error);
                    rt.latest = None;
                    rt.error = Some(code.to_owned());
                    rt.error_at = Some(now);
                }
            }
        }
        if ok {
            let _ = self.put(json!({ "lastCheckedAt": now }));
        }
        self.publish()
    }

    fn set_enabled(&self, enabled: bool) -> Res<UpdateNotice> {
        self.put(json!({ "auto": enabled }))?;
        self.wake.notify_one();
        Ok(self.publish())
    }

    fn dismiss(&self, version: &str) -> Res<UpdateNotice> {
        if version.len() > 64 || notice::parse_version(version).is_none() {
            return Err(EngineError::new("badVersion", "that is not a version number"));
        }
        self.put(json!({ "dismissedVersion": version }))?;
        Ok(self.publish())
    }

    /// The single scheduler task. Without work it waits to be woken (settings change, focus): no timer runs while it is off.
    async fn run_scheduler(self: Arc<Self>) {
        tokio::time::sleep(START_DELAY).await;
        loop {
            if !self.auto_ok() {
                self.wake.notified().await;
                continue;
            }
            let last = self.ns().get("lastCheckedAt").and_then(Value::as_u64);
            let error_at = self.rt().error_at;
            let wait = notice::next_wait(now_secs(), last, error_at, self.jitter);
            if !wait.is_zero() {
                tokio::select! {
                    () = tokio::time::sleep(wait) => {}
                    () = self.wake.notified() => continue,
                }
            }
            if self.auto_ok() {
                self.check(true).await;
            }
        }
    }
}

pub struct UpdatesState(Arc<Updates>);

pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let settings = app.try_state::<SettingsState>().and_then(|s| s.parts()).map(|(store, _)| store);
    let handle = app.handle().clone();
    let updates = Updates::new(
        settings.clone(),
        app.package_info().version.to_string(),
        Jail::global().mode(),
        default_endpoint(),
        Box::new(move |n| {
            if let Err(e) = handle.emit(EVENT, n) {
                eprintln!("emit {EVENT} failed: {e}");
            }
        }),
    );
    // A change of the `updates` settings (the disclosure was seen, the switch was flipped) wakes an idle scheduler.
    if let Some(store) = settings {
        let weak = Arc::downgrade(&updates);
        store.subscribe(move |c| {
            if c.ns == NS {
                if let Some(u) = weak.upgrade() {
                    u.wake.notify_one();
                }
            }
        });
    }
    if !cfg!(debug_assertions) && updates.mode != Mode::E2e {
        tauri::async_runtime::spawn(Arc::clone(&updates).run_scheduler());
    }
    app.manage(UpdatesState(updates));
    Ok(())
}

/// The window focus from `RunEvent::WindowEvent` (lib.rs): the automatic check runs only in the foreground.
pub fn set_focus(app: &AppHandle, focused: bool) {
    if let Some(state) = app.try_state::<UpdatesState>() {
        state.0.focused.store(focused, AtomicOrdering::Relaxed);
        if focused {
            state.0.wake.notify_one();
        }
    }
}

#[tauri::command]
pub async fn update_status(state: State<'_, UpdatesState>) -> Res<UpdateNotice> {
    Ok(state.0.notice())
}

/// `reason` is `"auto"` or `"manual"`; an automatic request is refused (the notice comes back unchanged) unless the switch is on,
/// the disclosure was seen, the window is focused and this is a release build.
#[tauri::command]
pub async fn update_check(state: State<'_, UpdatesState>, reason: String) -> Res<UpdateNotice> {
    let auto = match reason.as_str() {
        "auto" => true,
        "manual" => false,
        _ => return Err(EngineError::new("badReason", "reason must be auto or manual")),
    };
    let updates = Arc::clone(&state.0);
    Ok(updates.check(auto).await)
}

#[tauri::command]
pub async fn update_set_enabled(state: State<'_, UpdatesState>, enabled: bool) -> Res<UpdateNotice> {
    state.0.set_enabled(enabled)
}

/// Skips one version: the chip stays hidden until a newer release appears.
#[tauri::command]
pub async fn update_dismiss(state: State<'_, UpdatesState>, version: String) -> Res<UpdateNotice> {
    state.0.dismiss(&version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn rel(tag: &str) -> Value {
        json!({
            "tag_name": tag, "draft": false, "prerelease": true,
            "html_url": format!("https://github.com/ferencfarkas09/IntelyIDE/releases/tag/{tag}"),
            "published_at": "2026-10-06T10:00:00Z", "body": "Notes",
            "assets": [{ "name": "IntelyIDE_0.1.1.dmg", "size": 12345 }]
        })
    }

    #[test]
    fn auto_needs_switch_disclosure_focus_and_a_release_build() {
        assert!(auto_allowed(true, true, true, false));
        assert!(!auto_allowed(false, true, true, false));
        assert!(!auto_allowed(true, false, true, false));
        assert!(!auto_allowed(true, true, false, false));
        assert!(!auto_allowed(true, true, true, true));
    }

    // -- loopback stub ---------------------------------------------------------------------------------------------

    /// Serves `responses` in order, one per connection, and returns the URL and the request heads it saw.
    fn stub(responses: Vec<Vec<u8>>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/repos/ferencfarkas09/IntelyIDE/releases?per_page=10", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        std::thread::spawn(move || {
            for resp in responses {
                let Ok((mut s, _)) = listener.accept() else { return };
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                log.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).into_owned());
                let _ = s.write_all(&resp);
            }
        });
        (url, seen)
    }

    fn http(status: &str, body: &[u8]) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
        out.extend_from_slice(body);
        out
    }

    fn make(endpoint: String, dir: &tempfile::TempDir, current: &str, mode: Mode) -> (Arc<Updates>, Arc<Mutex<Vec<UpdateNotice>>>) {
        let store = Arc::new(SettingsStore::open(dir.path().join("settings.json")).unwrap());
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        (Updates::new(Some(store), current.to_owned(), mode, endpoint, Box::new(move |n| sink.lock().unwrap().push(n.clone()))), events)
    }

    fn block<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn a_manual_check_against_the_stub_reports_available_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let body = serde_json::to_vec(&vec![rel("v0.1.0"), rel("v0.1.1")]).unwrap();
        let (url, seen) = stub(vec![http("200 OK", &body)]);
        let (u, events) = make(url, &dir, "0.1.0", Mode::Off);
        let n = block(u.check(false));
        assert_eq!(n.state, UpdateState::Available);
        assert_eq!(n.latest.as_ref().unwrap().version, "0.1.1");
        assert!(n.last_checked_at.is_some());
        let states: Vec<UpdateState> = events.lock().unwrap().iter().map(|e| e.state).collect();
        assert_eq!(states, vec![UpdateState::Checking, UpdateState::Available]);
        assert_eq!(seen.lock().unwrap().len(), 1);
        // dismissing records the version
        let n = u.dismiss("0.1.1").unwrap();
        assert_eq!(n.dismissed_version.as_deref(), Some("0.1.1"));
        assert!(u.dismiss("latest").is_err());
        // the JSON the UI gets is camelCase
        let json = serde_json::to_value(&n).unwrap();
        assert_eq!(json["state"], "available");
        assert_eq!(json["currentVersion"], "0.1.0");
        assert_eq!(json["latest"]["publishedAt"], "2026-10-06T10:00:00Z");
        assert_eq!(json["latest"]["dmgBytes"], 12345);
    }

    #[test]
    fn the_e2e_jail_never_touches_the_network() {
        let dir = tempfile::tempdir().unwrap();
        // nothing listens here: any request would end in a `network` error
        let (u, events) = make("http://127.0.0.1:9/releases".to_owned(), &dir, "0.1.0", Mode::E2e);
        let n = block(u.check(false));
        assert_eq!((n.state, n.error.as_deref()), (UpdateState::Disabled, Some("testJail")));
        assert!(events.lock().unwrap().is_empty());
        assert_eq!(block(u.check(true)).error.as_deref(), Some("testJail"));
    }

    #[test]
    fn an_automatic_check_is_refused_without_the_disclosure_and_in_debug_builds() {
        let dir = tempfile::tempdir().unwrap();
        // nothing listens: a request would end in `network`; a refusal leaves the state idle
        let (u, events) = make("http://127.0.0.1:9/releases".to_owned(), &dir, "0.1.0", Mode::Off);
        assert_eq!(block(u.check(true)).state, UpdateState::Idle);
        u.put(json!({ "disclosedAt": 1 })).unwrap();
        // tests are debug builds: still refused
        assert_eq!(block(u.check(true)).state, UpdateState::Idle);
        assert!(events.lock().unwrap().is_empty());
        let n = u.set_enabled(false).unwrap();
        assert!(!n.enabled);
        assert_eq!(n.state, UpdateState::Disabled);
        assert_eq!(n.disclosed_at, Some(1));
    }
}
