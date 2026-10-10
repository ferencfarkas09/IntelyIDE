//! Menu-bar status item (wave3 X3, ideas #23). The UI owns the facts (agents, Needs-you, timer) and pushes them with
//! `tray_update`; this file draws the item. Desktop notifications of runs live in `notify.rs`.
//!
//! Optional and lazy: no icon exists until `tray_configure { enabled: true }`; switching it off removes the icon.
//! Events: `tray:action {id}` for menu entries the UI handles (`new-run`, `needs-you`, `stop-all`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use intely_core::EngineError;
use intely_hud::{menu_items, title_text, MenuItem as Item, TrayStatus};
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
}

pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(TrayState { enabled: AtomicBool::new(false), status: Mutex::new(TrayStatus::default()) });
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
}

#[tauri::command]
pub fn tray_configure(app: AppHandle, state: State<'_, TrayState>, config: TrayConfig) -> Res<bool> {
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

