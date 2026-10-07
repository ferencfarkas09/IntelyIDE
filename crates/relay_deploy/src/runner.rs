//! One live operation at a time (`busy`), a stop flag and the log ring (3000 lines or 512 KB) with `since(seq)` so a reconnecting UI
//! can catch up, like `checks:log`. Everything here is plain data; no thread, timer or process lives between operations.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;

use crate::error::{DeployError, Result};

pub const RING_LINES: usize = 3000;
pub const RING_BYTES: usize = 512 * 1024;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What `relay-cloud:log` and `relay_cloud_logs` carry (same shape as `checks:log`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogChunk {
    pub run_id: String,
    pub start_seq: u32,
    pub lines: Vec<String>,
    /// The caller asked for lines the ring no longer holds: `lines` starts later than requested.
    pub reset: bool,
}

#[derive(Default)]
pub struct LogRing {
    lines: VecDeque<String>,
    first_seq: u32,
    bytes: usize,
}

impl LogRing {
    pub fn push(&mut self, line: &str) {
        self.bytes += line.len();
        self.lines.push_back(line.to_owned());
        while self.lines.len() > RING_LINES || self.bytes > RING_BYTES {
            if let Some(old) = self.lines.pop_front() {
                self.bytes -= old.len();
                self.first_seq += 1;
            } else {
                break;
            }
        }
    }

    pub fn next_seq(&self) -> u32 {
        self.first_seq + self.lines.len() as u32
    }

    pub fn since(&self, run_id: &str, from: u32) -> LogChunk {
        let reset = from < self.first_seq;
        let start = from.max(self.first_seq);
        let skip = (start - self.first_seq) as usize;
        LogChunk { run_id: run_id.to_owned(), start_seq: start, lines: self.lines.iter().skip(skip).cloned().collect(), reset }
    }
}

struct Active {
    run_id: String,
    op: String,
    cancel: Arc<AtomicBool>,
    log: Arc<Mutex<LogRing>>,
}

#[derive(Default)]
struct Cell {
    active: Option<Active>,
    /// The ring of the run that ended last, so a late `relay_cloud_logs` still works.
    last: Option<(String, Arc<Mutex<LogRing>>)>,
}

#[derive(Default)]
pub struct OpRunner {
    cell: Arc<Mutex<Cell>>,
    counter: AtomicU64,
}

/// Held for the duration of an operation; dropping it frees the runner.
pub struct RunGuard {
    run_id: String,
    cancel: Arc<AtomicBool>,
    log: Arc<Mutex<LogRing>>,
    cell: Arc<Mutex<Cell>>,
}

impl OpRunner {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// `busy` (with the running operation's name) when another operation is live.
    pub fn begin(&self, op: &str) -> Result<RunGuard> {
        let mut c = lock(&self.cell);
        if let Some(a) = &c.active {
            return Err(DeployError::coded("busy", format!("another relay operation is running ({})", a.op)));
        }
        let n = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let run_id = format!("{t:x}-{n}");
        let cancel = Arc::new(AtomicBool::new(false));
        let log = Arc::new(Mutex::new(LogRing::default()));
        c.active = Some(Active { run_id: run_id.clone(), op: op.to_owned(), cancel: cancel.clone(), log: log.clone() });
        Ok(RunGuard { run_id, cancel, log, cell: self.cell.clone() })
    }

    /// `(run id, operation)` of the live operation.
    pub fn busy(&self) -> Option<(String, String)> {
        lock(&self.cell).active.as_ref().map(|a| (a.run_id.clone(), a.op.clone()))
    }

    /// Asks the live operation to stop (the spawner kills the process group). Stopping a finished run is not an error.
    pub fn stop(&self, run_id: &str) {
        if let Some(a) = lock(&self.cell).active.as_ref().filter(|a| a.run_id == run_id) {
            a.cancel.store(true, Ordering::SeqCst);
        }
    }

    pub fn logs(&self, run_id: &str, from_seq: u32) -> Option<LogChunk> {
        let c = lock(&self.cell);
        let ring = match (&c.active, &c.last) {
            (Some(a), _) if a.run_id == run_id => a.log.clone(),
            (_, Some((id, r))) if id == run_id => r.clone(),
            _ => return None,
        };
        drop(c);
        let chunk = lock(&ring).since(run_id, from_seq);
        Some(chunk)
    }
}

impl std::fmt::Debug for RunGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunGuard").field("run_id", &self.run_id).finish()
    }
}

impl RunGuard {
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Appends an already masked line.
    pub fn log(&self, masked_line: &str) {
        lock(&self.log).push(masked_line);
    }

    pub fn chunk_since(&self, from: u32) -> LogChunk {
        lock(&self.log).since(&self.run_id, from)
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        let mut c = lock(&self.cell);
        if c.active.as_ref().is_some_and(|a| a.run_id == self.run_id) {
            c.active = None;
            c.last = Some((self.run_id.clone(), self.log.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_operation_is_busy_until_the_guard_drops() {
        let r = OpRunner::new();
        let g = r.begin("deploy").unwrap();
        let e = r.begin("login").unwrap_err();
        assert_eq!(e.code(), "busy");
        assert!(e.to_string().contains("deploy"));
        assert_eq!(r.busy().unwrap().1, "deploy");
        drop(g);
        assert!(r.busy().is_none());
        assert!(r.begin("login").is_ok());
    }

    #[test]
    fn stop_sets_the_flag_of_the_live_run_only() {
        let r = OpRunner::new();
        let g = r.begin("login").unwrap();
        r.stop("nope");
        assert!(!g.cancelled());
        r.stop(g.run_id());
        assert!(g.cancelled());
    }

    #[test]
    fn ring_keeps_the_last_lines_and_reports_a_reset() {
        let mut ring = LogRing::default();
        for i in 0..(RING_LINES + 10) {
            ring.push(&format!("l{i}"));
        }
        let c = ring.since("r", 0);
        assert!(c.reset);
        assert_eq!(c.start_seq, 10);
        assert_eq!(c.lines.len(), RING_LINES);
        let c = ring.since("r", ring.next_seq() - 2);
        assert!(!c.reset);
        assert_eq!(c.lines, vec![format!("l{}", RING_LINES + 8), format!("l{}", RING_LINES + 9)]);
        let mut big = LogRing::default();
        for _ in 0..10 {
            big.push(&"x".repeat(100 * 1024));
        }
        assert!(big.since("r", 0).lines.len() <= 5, "the byte cap applies");
    }

    #[test]
    fn logs_survive_the_run() {
        let r = OpRunner::new();
        let g = r.begin("deploy").unwrap();
        g.log("one");
        let id = g.run_id().to_owned();
        drop(g);
        assert_eq!(r.logs(&id, 0).unwrap().lines, vec!["one".to_owned()]);
        assert!(r.logs("other", 0).is_none());
    }
}
