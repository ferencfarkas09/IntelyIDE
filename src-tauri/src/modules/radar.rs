//! Needs-You radar: a small always-on-top window (label `radar`) with the runs waiting on the person, opened from the menu-bar
//! entry "Needs you (n)" and the palette. It loads the same UI bundle with `?widget=radar`, which mounts only the radar (the agent
//! store and the answer cards); answers go through the same agent commands as the in-app inbox.
//!
//! The window never counts as the app's focus: the Focused handler in lib.rs looks at `main` only, so Eco mode and the focus-gated
//! polls neither start nor stop because of the radar. It closes with the main window.
//! Events: `radar:open-run {agentId}` to the main window ("Open" in the radar).

use intely_core::EngineError;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

type Res<T> = Result<T, EngineError>;

pub const LABEL: &str = "radar";
const MAIN: &str = "main";

/// Shows the radar, creating it the first time.
pub fn show(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?widget=radar".into()))
        .title("Needs you")
        .inner_size(380.0, 560.0)
        .min_inner_size(300.0, 260.0)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true)
        .build()?;
    Ok(())
}

/// Closes the radar if it is open.
pub fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }
}

/// The app menu's Close Window: closes the radar instead of the main window while the radar has the focus.
pub fn close_if_focused(app: &AppHandle) -> bool {
    let focused = app.get_webview_window(LABEL).and_then(|w| w.is_focused().ok()).unwrap_or(false);
    if focused {
        close(app);
    }
    focused
}

/// A run id as the agent host makes them: short and plain. Anything else is refused before it reaches the main window.
fn valid_agent_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':' || c == '.')
}

// async: creating a window from a synchronous command can deadlock on Windows (WebView2).
#[tauri::command]
pub async fn radar_open(app: AppHandle) -> Res<()> {
    show(&app).map_err(|e| EngineError::new("radar", e.to_string()))
}

#[tauri::command]
pub fn radar_close(app: AppHandle) {
    close(&app);
}

/// "Open" in the radar: the main window comes forward and its page selects the run.
#[tauri::command]
pub fn radar_open_run(app: AppHandle, agent_id: String) -> Res<()> {
    if !valid_agent_id(&agent_id) {
        return Err(EngineError::new("invalidArgument", "not a run id"));
    }
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    app.emit_to(MAIN, "radar:open-run", json!({ "agentId": agent_id })).map_err(|e| EngineError::new("radar", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::valid_agent_id;

    #[test]
    fn only_plain_run_ids_reach_the_main_window() {
        assert!(valid_agent_id("a_1b2c-3d"));
        assert!(valid_agent_id("run:42.1"));
        assert!(!valid_agent_id(""));
        assert!(!valid_agent_id("x\"}); alert(1)"));
        assert!(!valid_agent_id(&"a".repeat(129)));
    }
}
