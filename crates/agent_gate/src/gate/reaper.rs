//! Background reaper: every `interval` it sweeps expired leases and dead owners, and reclaims leases that have
//! been idle (no turn running, no activity) for `idle` (default 10 minutes, providers-plan 4.4). A reclaimed
//! idle agent is resumed on demand by the caller.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use super::lease::{Gate, ReclaimReason, Reclaimed};

pub const DEFAULT_IDLE: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy)]
pub struct ReaperConfig {
    pub interval: Duration,
    pub idle: Duration,
}

impl Default for ReaperConfig {
    fn default() -> Self {
        Self { interval: Duration::from_secs(1), idle: DEFAULT_IDLE }
    }
}

/// Reclaims every idle lease once.
pub fn reap_idle(gate: &Gate, idle: Duration) -> Vec<Reclaimed> {
    gate.idle_leases(idle).into_iter().filter_map(|id| gate.reclaim(&id, ReclaimReason::Idle)).collect()
}

/// Stops the thread on drop.
pub struct Reaper {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Reaper {
    pub fn spawn(gate: Arc<Gate>, cfg: ReaperConfig) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread = std::thread::spawn(move || {
            while !flag.load(Ordering::SeqCst) {
                gate.sweep();
                reap_idle(&gate, cfg.idle);
                // Sleep in short slices so drop returns promptly.
                let mut left = cfg.interval;
                while !left.is_zero() && !flag.load(Ordering::SeqCst) {
                    let slice = left.min(Duration::from_millis(50));
                    std::thread::sleep(slice);
                    left -= slice;
                }
            }
        });
        Self { stop, thread: Some(thread) }
    }
}

impl Drop for Reaper {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
