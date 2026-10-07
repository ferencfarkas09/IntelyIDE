//! Cancel protocol (providers-plan 5.6): UI Stop -> adapter `interrupt()` -> wait `soft` for the adapter's own
//! `turn.end(cancelled)` -> SIGTERM to the process group -> after `term` SIGKILL. Always: pending permissions
//! resolve `cancelled`, open tools get a synthesized `cancelled` result, exactly one `turn.end` reaches the sink.
//!
//! [`CancelMachine`] is the pure state machine (driven by `tick`), [`run`] the threaded executor around a [`Gate`]
//! lease. A soft cancel keeps the lease (the CLI process stays up for the next turn); an escalation to SIGTERM or
//! SIGKILL ends the process, so the lease is released.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use libc::pid_t;
use serde::Serialize;

use super::lease::Gate;
use super::procinfo;

const POLL: Duration = Duration::from_millis(20);
/// How long to wait for SIGKILL to take effect before reporting the cancel as finished anyway.
const KILL_SETTLE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy)]
pub struct CancelPlan {
    pub soft: Duration,
    pub term: Duration,
}

impl Default for CancelPlan {
    fn default() -> Self {
        Self { soft: Duration::from_secs(5), term: Duration::from_secs(3) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CancelPhase {
    Soft,
    Terminating,
    Killing,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Interrupt,
    Sigterm,
    Sigkill,
    /// Resolve pending permissions and open tools; `synthesize_turn_end` is false when the adapter already ended
    /// the turn (so there is exactly one `turn.end`).
    Finish { synthesize_turn_end: bool },
}

pub struct CancelMachine {
    plan: CancelPlan,
    started: Instant,
    phase: CancelPhase,
    phase_since: Instant,
    turn_end_seen: bool,
}

impl CancelMachine {
    pub fn start(plan: CancelPlan, now: Instant) -> (Self, Vec<Step>) {
        (Self { plan, started: now, phase: CancelPhase::Soft, phase_since: now, turn_end_seen: false }, vec![Step::Interrupt])
    }

    pub fn phase(&self) -> CancelPhase {
        self.phase
    }

    /// The adapter delivered `turn.end`. In the soft window that completes the cancel; later it only records that
    /// the single `turn.end` was already produced.
    pub fn turn_ended(&mut self) -> Vec<Step> {
        let first = !self.turn_end_seen;
        self.turn_end_seen = true;
        if self.phase == CancelPhase::Soft && first {
            self.phase = CancelPhase::Done;
            return vec![Step::Finish { synthesize_turn_end: false }];
        }
        Vec::new()
    }

    /// Advances the timers; `group_alive` says whether any registered process group still has a live member.
    pub fn tick(&mut self, now: Instant, group_alive: bool) -> Vec<Step> {
        let waited = now.saturating_duration_since(self.phase_since);
        match self.phase {
            CancelPhase::Soft if now.saturating_duration_since(self.started) >= self.plan.soft => {
                self.phase = CancelPhase::Terminating;
                self.phase_since = now;
                vec![Step::Sigterm]
            }
            CancelPhase::Terminating if !group_alive => self.finish(),
            CancelPhase::Terminating if waited >= self.plan.term => {
                self.phase = CancelPhase::Killing;
                self.phase_since = now;
                vec![Step::Sigkill]
            }
            CancelPhase::Killing if !group_alive || waited >= KILL_SETTLE => self.finish(),
            _ => Vec::new(),
        }
    }

    fn finish(&mut self) -> Vec<Step> {
        self.phase = CancelPhase::Done;
        let synthesize = !self.turn_end_seen;
        self.turn_end_seen = true;
        vec![Step::Finish { synthesize_turn_end: synthesize }]
    }
}

/// What the adapter side exposes to the cancel executor.
pub trait CancelSink: Send + Sync {
    /// SDK `interrupt()`, ACP `session/cancel`, Codex `turn/interrupt`.
    fn interrupt(&self);
    fn cancel_permissions(&self, ids: &[String]);
    /// Open tools get a synthesized `cancelled` result.
    fn cancel_tools(&self, ids: &[String]);
    /// The synthesized `turn.end(cancelled)`; called at most once per cancel and never after the adapter's own.
    fn turn_end(&self);
}

/// Pending permission requests and open tool calls of one run, plus whether `turn.end` was already delivered.
#[derive(Default)]
pub struct CancelTracker {
    pending_permissions: Mutex<Vec<String>>,
    open_tools: Mutex<Vec<String>>,
    turn_end: AtomicBool,
}

impl CancelTracker {
    pub fn permission_asked(&self, id: &str) {
        lock(&self.pending_permissions).push(id.into());
    }

    pub fn permission_answered(&self, id: &str) {
        lock(&self.pending_permissions).retain(|p| p != id);
    }

    pub fn tool_started(&self, id: &str) {
        lock(&self.open_tools).push(id.into());
    }

    pub fn tool_finished(&self, id: &str) {
        lock(&self.open_tools).retain(|t| t != id);
    }

    /// The adapter produced a `turn.end` (call from the event path).
    pub fn mark_turn_end(&self) {
        self.turn_end.store(true, Ordering::SeqCst);
    }

    pub fn turn_end_seen(&self) -> bool {
        self.turn_end.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelReport {
    /// `soft`, `term` or `kill`: the deepest stage that was needed.
    pub stage: &'static str,
    pub sigterm_after_ms: Option<u64>,
    pub sigkill_after_ms: Option<u64>,
    pub done_after_ms: u64,
    pub turn_end_synthesized: bool,
    pub permissions_cancelled: usize,
    pub tools_cancelled: usize,
    pub lease_released: bool,
}

/// Runs the cancel protocol for one lease on a background thread.
pub fn run(gate: Arc<Gate>, lease_id: String, plan: CancelPlan, sink: Arc<dyn CancelSink>, tracker: Arc<CancelTracker>) -> JoinHandle<CancelReport> {
    std::thread::spawn(move || {
        let t0 = Instant::now();
        let (mut machine, first) = CancelMachine::start(plan, t0);
        let (mut sigterm_at, mut sigkill_at) = (None, None);
        let mut report = CancelReport {
            stage: "soft",
            sigterm_after_ms: None,
            sigkill_after_ms: None,
            done_after_ms: 0,
            turn_end_synthesized: false,
            permissions_cancelled: 0,
            tools_cancelled: 0,
            lease_released: false,
        };
        let mut steps = first;
        loop {
            for step in std::mem::take(&mut steps) {
                match step {
                    Step::Interrupt => sink.interrupt(),
                    Step::Sigterm => {
                        sigterm_at = Some(t0.elapsed());
                        report.stage = "term";
                        signal_groups(&gate.lease_pgids(&lease_id), libc::SIGTERM);
                    }
                    Step::Sigkill => {
                        sigkill_at = Some(t0.elapsed());
                        report.stage = "kill";
                        signal_groups(&gate.lease_pgids(&lease_id), libc::SIGKILL);
                    }
                    Step::Finish { synthesize_turn_end } => {
                        let perms = std::mem::take(&mut *lock(&tracker.pending_permissions));
                        if !perms.is_empty() {
                            sink.cancel_permissions(&perms);
                        }
                        let tools = std::mem::take(&mut *lock(&tracker.open_tools));
                        if !tools.is_empty() {
                            sink.cancel_tools(&tools);
                        }
                        // The tracker is the source of truth: an adapter turn.end that raced the timers wins.
                        if synthesize_turn_end && !tracker.turn_end.swap(true, Ordering::SeqCst) {
                            sink.turn_end();
                            report.turn_end_synthesized = true;
                        }
                        report.permissions_cancelled = perms.len();
                        report.tools_cancelled = tools.len();
                        if report.stage != "soft" {
                            report.lease_released = gate.release(&lease_id);
                        }
                        report.sigterm_after_ms = sigterm_at.map(|d| d.as_millis() as u64);
                        report.sigkill_after_ms = sigkill_at.map(|d| d.as_millis() as u64);
                        report.done_after_ms = t0.elapsed().as_millis() as u64;
                        return report;
                    }
                }
            }
            std::thread::sleep(POLL);
            if tracker.turn_end_seen() {
                steps = machine.turn_ended();
            }
            if steps.is_empty() {
                let alive = gate.lease_pgids(&lease_id).iter().any(|g| !procinfo::live_group_pids(*g).is_empty());
                steps = machine.tick(Instant::now(), alive);
            }
        }
    })
}

/// A process group id that is safe to signal: not 0/1 and not the gate's own process group.
pub fn usable_pgid(pgid: pid_t) -> bool {
    pgid > 1 && pgid != unsafe { libc::getpgrp() }
}

fn signal_groups(pgids: &[pid_t], sig: libc::c_int) {
    for &g in pgids.iter().filter(|g| usable_pgid(**g)) {
        unsafe { libc::killpg(g, sig) };
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TermOutcome {
    /// Nobody was left in the group.
    AlreadyGone,
    /// Exited after SIGTERM.
    Terminated,
    /// Needed SIGKILL.
    Killed,
    /// pgid <= 1 or the gate's own group: never signalled.
    Refused,
}

/// Blocking: SIGTERM the group, wait up to `grace` for it to empty, then SIGKILL. Returns early when it empties.
pub fn terminate_group(pgid: pid_t, grace: Duration) -> TermOutcome {
    if !usable_pgid(pgid) {
        return TermOutcome::Refused;
    }
    if procinfo::live_group_pids(pgid).is_empty() {
        return TermOutcome::AlreadyGone;
    }
    unsafe { libc::killpg(pgid, libc::SIGTERM) };
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if procinfo::live_group_pids(pgid).is_empty() {
            return TermOutcome::Terminated;
        }
        std::thread::sleep(POLL);
    }
    if procinfo::live_group_pids(pgid).is_empty() {
        return TermOutcome::Terminated;
    }
    unsafe { libc::killpg(pgid, libc::SIGKILL) };
    TermOutcome::Killed
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
