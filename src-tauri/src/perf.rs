//! Opt-in startup and heartbeat log (`INTELY_PERF=1`): `$TMPDIR/intely-perf.log`, plus the `INTELY_READY` line on stderr.
//! Marks come from this shell (setup steps) and from the UI (`perf_mark`, spike heartbeat).

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static START: OnceLock<Instant> = OnceLock::new();
static ENABLED: OnceLock<bool> = OnceLock::new();

pub fn log_path() -> PathBuf {
    std::env::temp_dir().join("intely-perf.log")
}

fn enabled() -> bool {
    *ENABLED.get_or_init(|| std::env::var("INTELY_PERF").is_ok_and(|v| v == "1"))
}

fn since_start_ms() -> f64 {
    START.get().map_or(0.0, |s| s.elapsed().as_secs_f64() * 1000.0)
}

/// `t=<ms>` is the time since `init`, i.e. since the process started running `run()`.
pub fn line(msg: &str) {
    line_at(msg, None);
}

/// Like `line`, for an event that happened earlier at `epoch_ms` (wall clock, from the webview's `timeOrigin`).
fn line_at(msg: &str, epoch_ms: Option<f64>) {
    if !enabled() {
        return;
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    let wall = epoch_ms.filter(|e| *e <= now).unwrap_or(now);
    let t = since_start_ms() - (now - wall);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path()) {
        let _ = writeln!(f, "{wall:.0} t={t:.0}ms {msg}");
    }
}

pub fn init() {
    START.get_or_init(Instant::now);
    if enabled() {
        let _ = std::fs::remove_file(log_path());
    }
    line("process_start");
}

#[tauri::command]
pub fn heartbeat(frames: u32, interval_ms: f64, max_gap_ms: f64, since_frame_ms: f64) {
    line(&format!(
        "heartbeat frames={frames} intervalMs={interval_ms:.0} maxGapMs={max_gap_ms:.0} sinceFrameMs={since_frame_ms:.0}"
    ));
}

#[tauri::command]
pub fn first_paint(perf_now: f64, info: String) {
    line(&format!("first_paint perfNow={perf_now:.1} {info}"));
}

/// UI milestones: `first_paint` (the webview's first contentful paint, at `epoch_ms`), `first_snapshot` (first repo shown)
/// and `ready` (every repo shown, or the spike UI painted).
#[tauri::command]
pub fn perf_mark(name: String, detail: Option<String>, epoch_ms: Option<f64>) {
    let detail = detail.unwrap_or_default();
    line_at(&format!("{name} {detail}"), epoch_ms);
    if enabled() && name == "ready" {
        eprintln!("INTELY_READY t={:.0}ms {detail}", since_start_ms());
    }
}
