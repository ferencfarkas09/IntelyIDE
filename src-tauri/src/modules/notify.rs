//! Desktop notifications for agent runs: a banner when a run needs you, finished or failed, and the number of runs that wait for
//! you on the Dock icon. The UI owns the facts (it sees every run) and calls `notify_show` / `notify_badge`; this file applies
//! the gate of `intely_hud::notify` (kind switches, a throttle per run, a burst cap, never while the window is focused) and
//! delivers the banner. It does not depend on the menu-bar item.
//!
//! Delivery on macOS: the AppleScript `display notification`, run inside this process when the app is a bundle, so that the
//! banner carries the app's name and icon and a click brings the app forward. (`osascript` would send the banner as the Script
//! Editor, whose click opens the Script Editor.) A development build is no bundle; there the `osascript` fallback is used.
//! Under `INTELY_E2E=1` banners are appended to `$INTELY_DATA_DIR/notifications.log` instead, so a test never pops one.
//!
//! Banner texts are built by the UI from the run's title and a fixed sentence: no command text, no file content.

use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use intely_hud::notify::applescript_with;
use intely_hud::{Kind, NotifyGate, NotifyPrefs, Verdict};
use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

pub struct NotifyState {
    prefs: Mutex<NotifyPrefs>,
    gate: Mutex<NotifyGate>,
    started: Instant,
    /// The Dock badge is the sum of what Happy and the runs ask for.
    happy: AtomicU32,
    runs: AtomicU32,
    shown: Mutex<Option<i64>>,
}

pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(NotifyState {
        prefs: Mutex::new(NotifyPrefs::default()),
        gate: Mutex::new(NotifyGate::default()),
        started: Instant::now(),
        happy: AtomicU32::new(0),
        runs: AtomicU32::new(0),
        shown: Mutex::new(None),
    });
    Ok(())
}

/// The number for the Dock icon: `None` (no badge) at zero.
fn badge_of(happy: u32, runs: u32) -> Option<i64> {
    let total = i64::from(happy) + i64::from(runs);
    (total > 0).then_some(total)
}

fn refresh_badge(app: &AppHandle, st: &NotifyState) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let next = badge_of(st.happy.load(Ordering::SeqCst), st.runs.load(Ordering::SeqCst));
    {
        let Ok(mut shown) = st.shown.lock() else { return };
        if *shown == next {
            return;
        }
        *shown = next;
    }
    // a no-op without a main window (E2E jail); never panics
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_badge_count(next);
    }
}

/// Happy reports its unread count here (it used to set the badge itself).
pub fn set_happy_badge(app: &AppHandle, count: Option<i64>) {
    if let Some(st) = app.try_state::<NotifyState>() {
        st.happy.store(count.unwrap_or(0).clamp(0, i64::from(u32::MAX)) as u32, Ordering::SeqCst);
        refresh_badge(app, &st);
    }
}

#[tauri::command]
pub fn notify_configure(state: State<'_, NotifyState>, prefs: NotifyPrefs) {
    if let Ok(mut p) = state.prefs.lock() {
        *p = prefs;
    }
}

/// How many runs wait for the person (permission, question or plan); 0 clears that part of the badge.
#[tauri::command]
pub fn notify_badge(app: AppHandle, state: State<'_, NotifyState>, runs: u32) {
    let enabled = state.prefs.lock().map(|p| p.enabled).unwrap_or(true);
    state.runs.store(if enabled { runs } else { 0 }, Ordering::SeqCst);
    refresh_badge(&app, &state);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowRequest {
    pub kind: Kind,
    pub title: String,
    pub body: String,
    /// The run it is about (the throttle is per kind and run) and its title under the heading.
    pub run_id: Option<String>,
    pub subtitle: Option<String>,
}

/// Shows a banner when the kind switch, the throttle, the burst cap and the focus rule allow it.
#[tauri::command]
pub fn notify_show(app: AppHandle, state: State<'_, NotifyState>, req: ShowRequest) -> Verdict {
    let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
    let prefs = state.prefs.lock().map(|p| *p).unwrap_or_default();
    let now = state.started.elapsed().as_millis() as u64;
    let run = req.run_id.as_deref().unwrap_or("");
    let verdict = state.gate.lock().map(|mut g| g.check_run(req.kind, run, &prefs, focused, now)).unwrap_or(Verdict::Disabled);
    if verdict == Verdict::Show {
        deliver(&app, &req.title, req.subtitle.as_deref(), &req.body, prefs.sound);
    }
    verdict
}

fn deliver(app: &AppHandle, title: &str, subtitle: Option<&str>, body: &str, sound: bool) {
    if std::env::var("INTELY_E2E").is_ok_and(|v| v == "1") {
        if let Some(dir) = std::env::var_os("INTELY_DATA_DIR") {
            let line = format!("{}\t{}\n", title.replace('\n', " "), body.replace('\n', " "));
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(std::path::Path::new(&dir).join("notifications.log")) {
                let _ = f.write_all(line.as_bytes());
            }
        }
        return;
    }
    let script = applescript_with(title, subtitle, body, sound);
    if !deliver_native(app, &script) {
        via_osascript(script);
    }
}

/// Runs the banner inside this process when the app is a bundle; false when it could not (then `osascript` is the fallback).
#[cfg(target_os = "macos")]
fn deliver_native(app: &AppHandle, script: &str) -> bool {
    if !in_bundle() {
        return false;
    }
    // AppleScript wants the main thread; if it cannot run the script (it reports an error), the fallback still shows the banner
    let (script, fallback) = (script.to_string(), script.to_string());
    app.run_on_main_thread(move || {
        if !run_in_process(&script) {
            via_osascript(fallback);
        }
    })
    .is_ok()
}

#[cfg(not(target_os = "macos"))]
fn deliver_native(_app: &AppHandle, _script: &str) -> bool {
    false
}

/// `…/IntelyIDE.app/Contents/MacOS/<exe>`: the process has a bundle identifier, so a banner is the app's own.
#[cfg(target_os = "macos")]
fn in_bundle() -> bool {
    std::env::current_exe().ok().is_some_and(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
}

/// Runs the AppleScript inside this process (`NSAppleScript`); true when it ran without an error.
#[cfg(target_os = "macos")]
fn run_in_process(script: &str) -> bool {
    use objc2::AnyThread;
    use objc2_foundation::{NSAppleScript, NSString};
    let source = NSString::from_str(script);
    // SAFETY: `initWithSource` and `executeAndReturnError` are plain Foundation calls on an object this function owns; the error
    // out-parameter is the `Option<Retained<NSDictionary>>` the binding documents.
    unsafe {
        let Some(compiled) = NSAppleScript::initWithSource(NSAppleScript::alloc(), &source) else { return false };
        let mut error = None;
        let _ = compiled.executeAndReturnError(Some(&mut error));
        error.is_none()
    }
}

fn via_osascript(script: String) {
    std::thread::spawn(move || {
        let _ = std::process::Command::new("/usr/bin/osascript").arg("-e").arg(script).output();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_badge_is_the_sum_and_vanishes_at_zero() {
        assert_eq!(badge_of(0, 0), None);
        assert_eq!(badge_of(2, 0), Some(2));
        assert_eq!(badge_of(0, 3), Some(3));
        assert_eq!(badge_of(2, 3), Some(5));
        assert_eq!(badge_of(u32::MAX, u32::MAX), Some(i64::from(u32::MAX) * 2));
    }
}
