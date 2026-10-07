//! Tauri glue of the resource HUD (wave3 X3, ideas #27): the app's process-tree snapshot, per-process kill, the sidecar
//! restart and Eco mode. The logic is `intely_hud`; this file owns only the clock thread and the events.
//!
//! Zero cost when off: `setup` only creates an empty state. Nothing runs until the UI calls `hud_configure` with Eco on
//! and `hud_focus` reports a blur; the snapshot is taken on demand (one `ps`), never on a timer of ours.
//! Events: `hud:eco {active}`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use intely_core::EngineError;
use intely_hud::{kill_in_snapshot, scan, Eco, EcoChange, KillError, Snapshot};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agents::AgentSlot;

type Res<T> = Result<T, EngineError>;

/// Idle sessions younger than this stay open when Eco starts (a run that just finished is usually followed up).
const SUSPEND_AFTER_IDLE_MS: u64 = 60_000;

pub struct HudState {
    eco: Mutex<Eco>,
    /// Bumped on every focus change or reconfiguration; a sleeping clock thread whose number is stale does nothing.
    generation: AtomicU64,
    active: AtomicBool,
    started: Instant,
}

impl HudState {
    fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(Arc::new(HudState { eco: Mutex::new(Eco::new(false, 5 * 60_000)), generation: AtomicU64::new(0), active: AtomicBool::new(false), started: Instant::now() }));
    Ok(())
}

fn err(code: &str, msg: impl std::fmt::Display) -> EngineError {
    EngineError::new(code, msg.to_string())
}

fn apply(app: &AppHandle, state: &HudState, change: Option<EcoChange>) {
    let Some(change) = change else { return };
    let active = change == EcoChange::Enter;
    state.active.store(active, Ordering::SeqCst);
    if active {
        if let Some(agents) = app.try_state::<AgentSlot>() {
            agents.host().suspend_idle(SUSPEND_AFTER_IDLE_MS);
        }
    }
    if let Err(e) = app.emit("hud:eco", serde_json::json!({ "active": active })) {
        eprintln!("emit hud:eco failed: {e}");
    }
}

/// Arms one sleeping thread for the moment Eco could start; none while focused, already in Eco or switched off.
fn arm(app: &AppHandle, state: &Arc<HudState>) {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let wait = state.eco.lock().ok().and_then(|e| e.next_check_in(state.now()));
    let Some(wait) = wait else { return };
    let (app, state) = (app.clone(), state.clone());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(wait.saturating_add(50)));
        if state.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let change = state.eco.lock().ok().and_then(|mut e| e.tick(state.now()));
        apply(&app, &state, change);
    });
}

#[tauri::command]
pub async fn hud_snapshot(agents: State<'_, AgentSlot>) -> Res<Snapshot> {
    let sidecar = agents.host().sidecar_pid();
    tauri::async_runtime::spawn_blocking(move || scan(sidecar)).await.map_err(|e| err("internal", e))
}

/// SIGTERM to one process of the app's own tree. Anything else (an unknown pid, the app) is refused.
#[tauri::command]
pub async fn hud_kill(agents: State<'_, AgentSlot>, pid: u32) -> Res<()> {
    let sidecar = agents.host().sidecar_pid();
    tauri::async_runtime::spawn_blocking(move || {
        kill_in_snapshot(&scan(sidecar), pid).map_err(|e| match e {
            KillError::NotOurs => err("notOurs", format!("process {pid} is not part of the app")),
            KillError::Protected => err("protected", "the app itself cannot be stopped from here"),
            KillError::Signal(n) => err("signal", format!("could not signal process {pid} (errno {n})")),
        })
    })
    .await
    .map_err(|e| err("internal", e))?
}

/// Stops the sidecar; the host closes its runs honestly and starts a fresh one with the next run.
#[tauri::command]
pub async fn hud_restart_sidecar(agents: State<'_, AgentSlot>) -> Res<bool> {
    let Some(pid) = agents.host().sidecar_pid() else { return Ok(false) };
    tauri::async_runtime::spawn_blocking(move || kill_in_snapshot(&scan(Some(pid)), pid).map(|_| true).map_err(|e| err("signal", format!("{e:?}"))))
        .await
        .map_err(|e| err("internal", e))?
}

#[tauri::command]
pub fn hud_configure(app: AppHandle, state: State<'_, Arc<HudState>>, enabled: bool, after_minutes: u32) -> bool {
    let now = state.now();
    let change = state.eco.lock().ok().and_then(|mut e| e.configure(enabled, u64::from(after_minutes) * 60_000, now));
    apply(&app, &state, change);
    arm(&app, &state);
    state.active.load(Ordering::SeqCst)
}

/// The UI reports window focus; Rust keeps the clock so a webview that is throttled in the background cannot delay Eco.
#[tauri::command]
pub fn hud_focus(app: AppHandle, state: State<'_, Arc<HudState>>, focused: bool) -> bool {
    let now = state.now();
    let change = state.eco.lock().ok().and_then(|mut e| e.focus(focused, now));
    apply(&app, &state, change);
    arm(&app, &state);
    state.active.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn hud_eco_active(state: State<'_, Arc<HudState>>) -> bool {
    state.active.load(Ordering::SeqCst)
}
