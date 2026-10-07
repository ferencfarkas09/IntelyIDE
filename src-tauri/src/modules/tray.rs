//! Menu-bar status item and native notifications (wave3 X3, ideas #23). The UI owns the facts (agents, Needs-you, timer)
//! and pushes them with `tray_update`; this file draws the item and applies the notification gate from `intely_hud`.
//!
//! Optional and lazy: no icon exists until `tray_configure { enabled: true }`; switching it off removes the icon.
//! Events: `tray:action {id}` for menu entries the UI handles (`new-run`, `needs-you`, `stop-all`).
//!
//! Notifications use `osascript display notification` (no new dependency, title and body are quoted by
//! `intely_hud::notify`). Under `INTELY_E2E=1` they are appended to `$INTELY_DATA_DIR/notifications.log` instead, so a test
//! never pops a banner on the desktop.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use intely_core::EngineError;
use intely_hud::notify::applescript;
use intely_hud::{menu_items, title_text, Kind, MenuItem as Item, NotifyGate, NotifyPrefs, TrayStatus, Verdict};
use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, Wry};

type Res<T> = Result<T, EngineError>;

const TRAY_ID: &str = "intely-status";
const ID_PREFIX: &str = "tray.";

pub struct TrayState {
    enabled: AtomicBool,
    status: Mutex<TrayStatus>,
    prefs: Mutex<NotifyPrefs>,
    gate: Mutex<NotifyGate>,
    started: Instant,
}

pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(TrayState {
        enabled: AtomicBool::new(false),
        status: Mutex::new(TrayStatus::default()),
        prefs: Mutex::new(NotifyPrefs::default()),
        gate: Mutex::new(NotifyGate::default()),
        started: Instant::now(),
    });
    Ok(())
}

fn build_menu(app: &AppHandle, status: &TrayStatus) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    for item in menu_items(status) {
        match item {
            Item::Info { id, text } => menu.append(&MenuItem::with_id(app, format!("{ID_PREFIX}{id}"), text, false, None::<&str>)?)?,
            Item::Action { id, text, enabled } => menu.append(&MenuItem::with_id(app, format!("{ID_PREFIX}{id}"), text, enabled, None::<&str>)?)?,
            Item::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    Ok(menu)
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    let Some(action) = id.strip_prefix(ID_PREFIX) else { return };
    match action {
        "quit" => {
            if !crate::close_guard::intercept(app) {
                app.exit(0);
            }
        }
        "open" => show_window(app),
        other => {
            show_window(app);
            if let Err(e) = app.emit("tray:action", serde_json::json!({ "id": other })) {
                eprintln!("emit tray:action failed: {e}");
            }
        }
    }
}

fn refresh(app: &AppHandle, state: &TrayState) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let status = state.status.lock().map(|s| s.clone()).unwrap_or_default();
    let title = title_text(&status);
    let _ = tray.set_title(if title.is_empty() { None } else { Some(title) });
    if let Ok(menu) = build_menu(app, &status) {
        let _ = tray.set_menu(Some(menu));
    }
    let _ = tray.set_tooltip(Some(format!("IntelyIDE: {} running, {} need you", status.running, status.needs_you)));
}

fn create(app: &AppHandle, state: &TrayState) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let status = state.status.lock().map(|s| s.clone()).unwrap_or_default();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(include_bytes!("../../icons/tray-template.png"))?)
        .icon_as_template(true)
        .menu(&build_menu(app, &status)?)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .build(app)?;
    refresh(app, state);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayConfig {
    pub enabled: bool,
    #[serde(default)]
    pub notify: NotifyPrefs,
}

#[tauri::command]
pub fn tray_configure(app: AppHandle, state: State<'_, TrayState>, config: TrayConfig) -> Res<bool> {
    if let Ok(mut p) = state.prefs.lock() {
        *p = config.notify;
    }
    state.enabled.store(config.enabled, Ordering::SeqCst);
    if config.enabled {
        create(&app, &state).map_err(|e| EngineError::new("tray", e.to_string()))?;
    } else if let Some(tray) = app.remove_tray_by_id(TRAY_ID) {
        drop(tray);
    }
    Ok(app.tray_by_id(TRAY_ID).is_some())
}

#[tauri::command]
pub fn tray_update(app: AppHandle, state: State<'_, TrayState>, status: TrayStatus) {
    let changed = state.status.lock().map(|mut s| std::mem::replace(&mut *s, status.clone()) != status).unwrap_or(false);
    if changed && state.enabled.load(Ordering::SeqCst) {
        refresh(&app, &state);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyRequest {
    pub kind: Kind,
    pub title: String,
    pub body: String,
}

/// Shows a native notification when the per-kind switch, the throttle and the focus rule allow it.
#[tauri::command]
pub fn tray_notify(app: AppHandle, state: State<'_, TrayState>, req: NotifyRequest) -> Verdict {
    let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
    let prefs = state.prefs.lock().map(|p| *p).unwrap_or_default();
    let now = state.started.elapsed().as_millis() as u64;
    let verdict = state.gate.lock().map(|mut g| g.check(req.kind, &prefs, focused, now)).unwrap_or(Verdict::Disabled);
    if verdict == Verdict::Show {
        deliver(&req.title, &req.body);
    }
    verdict
}

fn deliver(title: &str, body: &str) {
    if std::env::var("INTELY_E2E").is_ok_and(|v| v == "1") {
        if let Some(dir) = std::env::var_os("INTELY_DATA_DIR") {
            let line = format!("{}\t{}\n", title.replace('\n', " "), body.replace('\n', " "));
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(std::path::Path::new(&dir).join("notifications.log")) {
                let _ = f.write_all(line.as_bytes());
            }
        }
        return;
    }
    let script = applescript(title, body);
    std::thread::spawn(move || {
        let _ = std::process::Command::new("/usr/bin/osascript").arg("-e").arg(script).output();
    });
}
