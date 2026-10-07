//! Window-close guard: while the UI reports unsaved buffers, closing the window or quitting is held back and the UI
//! is asked (`app:close-requested`) to offer Save all / Don't save / Cancel. The UI arms the guard only while it has
//! something to lose, so a closed window never depends on JS when nothing is at stake.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

/// How long the UI may leave a close request unanswered before the next one goes through (a hung page must not make
/// the app unquittable).
const ANSWER_WITHIN: Duration = Duration::from_secs(3);

pub const EVENT: &str = "app:close-requested";
/// Emitted just before [`EVENT`] when an SSH tunnel of a database connection is still up.
pub const TUNNEL_EVENT: &str = "mongo:close-tunnel-up";

#[derive(Clone, Copy, Default, PartialEq, Debug)]
enum Phase {
    #[default]
    Idle,
    /// The UI was told at this moment and has not answered yet.
    Asked(Instant),
    /// The UI's dialog is open.
    Dialog,
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    Allow,
    /// Hold the close back; `ask` says whether the UI still has to be told.
    Block { ask: bool },
}

#[derive(Default)]
pub struct CloseGuard {
    armed: AtomicBool,
    phase: Mutex<Phase>,
}

impl CloseGuard {
    pub fn set_armed(&self, armed: bool) {
        self.armed.store(armed, Ordering::SeqCst);
        if !armed {
            *self.phase.lock().expect("phase lock") = Phase::Idle;
        }
    }

    /// The UI's dialog opened (`true`) or was dismissed (`false`).
    pub fn set_dialog(&self, open: bool) {
        *self.phase.lock().expect("phase lock") = if open { Phase::Dialog } else { Phase::Idle };
    }

    pub fn on_close_request(&self, now: Instant) -> Verdict {
        self.on_close_request_with(now, false)
    }

    /// `hold`: something outside the UI's own unsaved buffers is at stake (an SSH tunnel is up), so the request is held
    /// back and the UI asked even while the guard is disarmed.
    pub fn on_close_request_with(&self, now: Instant, hold: bool) -> Verdict {
        if !hold && !self.armed.load(Ordering::SeqCst) {
            return Verdict::Allow;
        }
        let mut phase = self.phase.lock().expect("phase lock");
        match *phase {
            Phase::Idle => {
                *phase = Phase::Asked(now);
                Verdict::Block { ask: true }
            }
            Phase::Asked(at) if now.duration_since(at) > ANSWER_WITHIN => {
                *phase = Phase::Idle;
                Verdict::Allow
            }
            Phase::Asked(_) | Phase::Dialog => Verdict::Block { ask: false },
        }
    }
}

#[tauri::command]
pub fn close_guard_arm(state: State<'_, CloseGuard>, armed: bool) {
    state.set_armed(armed);
}

#[tauri::command]
pub fn close_guard_dialog(state: State<'_, CloseGuard>, open: bool) {
    state.set_dialog(open);
}

/// The UI's answer "leave": disarm and exit (the app has a single window).
#[tauri::command]
pub fn close_guard_exit(app: AppHandle, state: State<'_, CloseGuard>) {
    state.set_armed(false);
    app.exit(0);
}

/// Called for a close of the main window or a Quit; returns true when it was held back.
pub fn intercept(app: &AppHandle) -> bool {
    let Some(guard) = app.try_state::<CloseGuard>() else { return false };
    #[cfg(feature = "mongo-studio")]
    let tunnel_up = crate::modules::mongo::tunnel_up(app);
    #[cfg(not(feature = "mongo-studio"))]
    let tunnel_up = false;
    match guard.on_close_request_with(Instant::now(), tunnel_up) {
        Verdict::Allow => false,
        Verdict::Block { ask } => {
            if ask {
                if tunnel_up {
                    // tells the UI why the dialog is shown (it may add a line); the generic request below does the asking
                    let _ = app.emit(TUNNEL_EVENT, ());
                }
                if let Err(err) = app.emit(EVENT, ()) {
                    eprintln!("emit {EVENT} failed: {err}");
                }
            }
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_held_back_while_disarmed() {
        assert_eq!(CloseGuard::default().on_close_request(Instant::now()), Verdict::Allow);
    }

    #[test]
    fn an_armed_guard_blocks_and_asks_once() {
        let g = CloseGuard::default();
        g.set_armed(true);
        let t0 = Instant::now();
        assert_eq!(g.on_close_request(t0), Verdict::Block { ask: true });
        g.set_dialog(true);
        // The dialog is up: another click on the close button, however late, is held back without a second event.
        assert_eq!(g.on_close_request(t0 + Duration::from_secs(60)), Verdict::Block { ask: false });
        g.set_dialog(false);
        assert_eq!(g.on_close_request(t0 + Duration::from_secs(61)), Verdict::Block { ask: true });
    }

    #[test]
    fn an_unanswered_request_does_not_make_the_app_unquittable() {
        let g = CloseGuard::default();
        g.set_armed(true);
        let t0 = Instant::now();
        assert_eq!(g.on_close_request(t0), Verdict::Block { ask: true });
        assert_eq!(g.on_close_request(t0 + Duration::from_secs(1)), Verdict::Block { ask: false });
        assert_eq!(g.on_close_request(t0 + ANSWER_WITHIN + Duration::from_secs(1)), Verdict::Allow);
    }

    #[test]
    fn a_live_tunnel_holds_the_close_back_even_while_disarmed() {
        let g = CloseGuard::default();
        let t0 = Instant::now();
        assert_eq!(g.on_close_request_with(t0, false), Verdict::Allow);
        assert_eq!(g.on_close_request_with(t0, true), Verdict::Block { ask: true });
        assert_eq!(g.on_close_request_with(t0 + Duration::from_secs(1), true), Verdict::Block { ask: false });
        assert_eq!(g.on_close_request_with(t0 + ANSWER_WITHIN + Duration::from_secs(1), true), Verdict::Allow);
    }

    #[test]
    fn disarming_clears_the_pending_request() {
        let g = CloseGuard::default();
        g.set_armed(true);
        assert_eq!(g.on_close_request(Instant::now()), Verdict::Block { ask: true });
        g.set_armed(false);
        assert_eq!(g.on_close_request(Instant::now()), Verdict::Allow);
        g.set_armed(true);
        assert_eq!(g.on_close_request(Instant::now()), Verdict::Block { ask: true });
    }
}
