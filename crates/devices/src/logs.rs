//! Device log streams: `xcrun simctl spawn <device> log stream` for the iOS simulator and `adb logcat` for Android, read
//! line by line into one bounded ring per platform. Every line is length-capped and passed through the secret masker
//! before it is stored; the ring keeps at most [`MAX_LINES`] lines and [`MAX_BYTES`] bytes and counts what it dropped.

use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use intely_core::{code, EngineError};

use crate::parse::{classify_line, clean, valid_serial, valid_udid, MAX_LINE};
use crate::tools::{prepare, Devices, Tools};
use crate::types::{LogChunk, LogEntry};

pub const MAX_LINES: usize = 2000;
pub const MAX_BYTES: usize = 1024 * 1024;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogTarget {
    /// `udid`: a specific simulator, else the booted one. `process`: the app's process name for the predicate.
    Ios { udid: Option<String>, process: Option<String> },
    /// `serial`: a specific device, else the only one adb sees.
    Android { serial: Option<String> },
}

impl LogTarget {
    pub fn platform(&self) -> &'static str {
        match self {
            LogTarget::Ios { .. } => "ios",
            LogTarget::Android { .. } => "android",
        }
    }
}

/// The predicate of the iOS stream: the app process, and the React Native log subsystem. The process name was validated
/// (letters, digits, space, `_ - .`), so it cannot close the quotes.
pub fn ios_predicate(process: Option<&str>) -> String {
    let ok = process.filter(|p| !p.is_empty() && p.len() <= 60 && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b' ')));
    match ok {
        Some(p) => format!("process == \"{p}\" OR subsystem == \"com.facebook.react.log\""),
        None => "subsystem == \"com.facebook.react.log\"".to_owned(),
    }
}

/// argv (after the program) of the stream of `target`; `None` when an id does not pass validation.
pub fn stream_args(target: &LogTarget) -> Option<Vec<String>> {
    match target {
        LogTarget::Ios { udid, process } => {
            let device = match udid {
                Some(u) if valid_udid(u) => u.as_str(),
                Some(_) => return None,
                None => "booted",
            };
            Some(["simctl", "spawn", device, "log", "stream", "--style", "compact", "--predicate"].iter().map(|s| (*s).to_owned()).chain([ios_predicate(process.as_deref())]).collect())
        }
        LogTarget::Android { serial } => {
            let mut a = Vec::new();
            match serial {
                Some(s) if valid_serial(s) => a.extend(["-s".to_owned(), s.clone()]),
                Some(_) => return None,
                None => {}
            }
            // Recent history first, then live. DEBUG and libc carry the native crash reports.
            a.extend(["logcat", "-v", "threadtime", "-T", "200", "ReactNative:V", "ReactNativeJS:V", "AndroidRuntime:V", "DEBUG:I", "libc:F", "*:S"].map(str::to_owned));
            Some(a)
        }
    }
}

#[derive(Default)]
struct Ring {
    lines: VecDeque<(u32, LogEntry)>,
    bytes: usize,
    next_seq: u32,
    dropped: u32,
}

impl Ring {
    fn first_seq(&self) -> u32 {
        self.lines.front().map_or(self.next_seq, |(s, _)| *s)
    }

    fn push(&mut self, entry: LogEntry) {
        self.bytes += entry.text.len() + 16;
        self.lines.push_back((self.next_seq, entry));
        self.next_seq = self.next_seq.wrapping_add(1);
        while self.lines.len() > MAX_LINES || (self.bytes > MAX_BYTES && self.lines.len() > 1) {
            if let Some((_, old)) = self.lines.pop_front() {
                self.bytes = self.bytes.saturating_sub(old.text.len() + 16);
                self.dropped = self.dropped.saturating_add(1);
            }
        }
    }

    fn clear(&mut self) {
        self.lines.clear();
        self.bytes = 0;
    }
}

struct Session {
    ring: Mutex<Ring>,
    running: AtomicBool,
    exit_code: Mutex<Option<i32>>,
    pgid: Mutex<Option<i32>>,
}

impl Session {
    fn push_line(&self, raw: &str) {
        let text = clean(&intely_runner::mask::mask(raw), MAX_LINE);
        if text.trim().is_empty() {
            return;
        }
        let level = classify_line(&text);
        lock(&self.ring).push(LogEntry { level, text });
    }
}

/// Splits a byte stream into lines without ever holding more than `MAX_LINE * 4` bytes of one line (the rest of an over-long
/// line is dropped up to its newline).
fn pump(mut r: impl Read, mut on_line: impl FnMut(&str)) {
    let mut buf = [0u8; 8192];
    let mut line: Vec<u8> = Vec::new();
    let mut skipping = false;
    while let Ok(n) = r.read(&mut buf) {
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            if b == b'\n' {
                if !line.is_empty() {
                    on_line(&String::from_utf8_lossy(&line));
                }
                line.clear();
                skipping = false;
            } else if !skipping {
                if line.len() >= MAX_LINE * 4 {
                    skipping = true;
                } else {
                    line.push(b);
                }
            }
        }
    }
    if !line.is_empty() {
        on_line(&String::from_utf8_lossy(&line));
    }
}

/// The two streams (`ios`, `android`) of the app. Cheap to create; nothing runs until [`LogHub::start`].
#[derive(Default)]
pub struct LogHub {
    sessions: Mutex<HashMap<&'static str, Arc<Session>>>,
}

impl LogHub {
    pub fn new() -> Self {
        Self::default()
    }

    fn session(&self, platform: &str) -> Option<Arc<Session>> {
        lock(&self.sessions).get(platform).cloned()
    }

    /// Starts (or restarts) the stream of `target`. Its old lines are kept; a restart adds to them.
    pub fn start(&self, devices: &Devices, cwd: &Path, tools: &Tools, env: &std::collections::HashMap<String, String>, target: &LogTarget) -> Result<(), EngineError> {
        devices.check(cwd)?;
        let platform = target.platform();
        let program = match target {
            LogTarget::Ios { .. } => tools.xcrun.as_deref(),
            LogTarget::Android { .. } => tools.adb.as_deref(),
        }
        .ok_or_else(|| EngineError::new("toolMissing", if platform == "ios" { "xcrun is not installed" } else { "adb is not installed" }))?;
        let args = stream_args(target).ok_or_else(|| EngineError::new("invalidDevice", "not a device id"))?;
        self.stop(platform);
        let mut cmd = Command::new(program);
        cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
        prepare(&mut cmd, env);
        let mut child = cmd.spawn().map_err(|e| EngineError::new(code::IO, format!("could not start the log stream: {e}")))?;
        let session = {
            let mut map = lock(&self.sessions);
            let session = map.entry(platform).or_insert_with(|| Arc::new(Session { ring: Mutex::default(), running: AtomicBool::new(false), exit_code: Mutex::new(None), pgid: Mutex::new(None) })).clone();
            session
        };
        session.running.store(true, Ordering::SeqCst);
        *lock(&session.exit_code) = None;
        *lock(&session.pgid) = Some(child.id() as i32);
        let (stdout, stderr) = (child.stdout.take().expect("piped"), child.stderr.take().expect("piped"));
        let err_session = session.clone();
        let err_thread = std::thread::spawn(move || pump(stderr, |l| err_session.push_line(l)));
        std::thread::spawn(move || {
            pump(stdout, |l| session.push_line(l));
            let _ = err_thread.join();
            let status = child.wait().ok();
            *lock(&session.exit_code) = status.and_then(|s| s.code());
            *lock(&session.pgid) = None;
            session.running.store(false, Ordering::SeqCst);
        });
        Ok(())
    }

    /// Ends the stream (the lines stay until cleared).
    pub fn stop(&self, platform: &str) {
        if let Some(s) = self.session(platform) {
            if let Some(pgid) = lock(&s.pgid).take() {
                intely_core::sys::kill_group(pgid, true);
            }
        }
    }

    pub fn stop_all(&self) {
        self.stop("ios");
        self.stop("android");
    }

    pub fn clear(&self, platform: &str) {
        if let Some(s) = self.session(platform) {
            lock(&s.ring).clear();
        }
    }

    /// Lines with `seq >= from_seq`. `reset` when `from_seq` is before the oldest kept line (cleared or dropped).
    pub fn chunk(&self, platform: &str, from_seq: u32) -> LogChunk {
        let Some(s) = self.session(platform) else {
            return LogChunk { platform: platform.to_owned(), start_seq: 0, entries: Vec::new(), reset: false, running: false, exit_code: None, dropped: 0 };
        };
        let ring = lock(&s.ring);
        let first = ring.first_seq();
        let reset = from_seq < first && (ring.next_seq != 0);
        let from = from_seq.max(first);
        let entries: Vec<LogEntry> = ring.lines.iter().filter(|(seq, _)| *seq >= from).map(|(_, e)| e.clone()).collect();
        let exit_code = *lock(&s.exit_code);
        LogChunk { platform: platform.to_owned(), start_seq: from, entries, reset, running: s.running.load(Ordering::SeqCst), exit_code, dropped: ring.dropped }
    }
}

#[cfg(test)]
impl LogHub {
    /// Test hook: feeds lines as if a stream had printed them.
    pub fn feed(&self, platform: &'static str, lines: &[&str]) {
        let s = lock(&self.sessions).entry(platform).or_insert_with(|| Arc::new(Session { ring: Mutex::default(), running: AtomicBool::new(false), exit_code: Mutex::new(None), pgid: Mutex::new(None) })).clone();
        for l in lines {
            s.push_line(l);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Level;

    #[test]
    fn the_ring_keeps_at_most_the_line_cap_and_counts_what_it_dropped() {
        let hub = LogHub::new();
        let lines: Vec<String> = (0..MAX_LINES + 50).map(|i| format!("line {i}")).collect();
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        hub.feed("android", &refs);
        let c = hub.chunk("android", 0);
        assert_eq!(c.entries.len(), MAX_LINES);
        assert_eq!((c.dropped, c.start_seq, c.reset), (50, 50, true), "the first 50 are gone, so the reader is told to start over");
        assert_eq!(c.entries[0].text, "line 50");
        let tail = hub.chunk("android", c.start_seq + c.entries.len() as u32 - 2);
        assert_eq!((tail.entries.len(), tail.reset), (2, false));
    }

    #[test]
    fn the_ring_keeps_at_most_the_byte_cap() {
        let hub = LogHub::new();
        let big = "x".repeat(MAX_LINE);
        for _ in 0..(MAX_BYTES / 1000) {
            hub.feed("ios", &[big.as_str()]);
        }
        let c = hub.chunk("ios", 0);
        let bytes: usize = c.entries.iter().map(|e| e.text.len() + 16).sum();
        assert!(bytes <= MAX_BYTES, "{bytes}");
        assert!(c.dropped > 0);
    }

    #[test]
    fn lines_are_masked_capped_and_classified_before_they_are_stored() {
        let hub = LogHub::new();
        hub.feed("ios", &["2024-05-01 10:00:01.200 E   App[1:2] token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 and more", &"y".repeat(10_000), "   ", "\u{1b}[2J\u{7}hello"]);
        let c = hub.chunk("ios", 0);
        assert_eq!(c.entries.len(), 3, "the blank line is dropped");
        assert!(!c.entries[0].text.contains("ghp_abcdefghijklmnopqrstuvwxyz"), "{}", c.entries[0].text);
        assert_eq!(c.entries[0].level, Level::Error);
        assert_eq!(c.entries[1].text.len(), MAX_LINE);
        assert!(!c.entries[2].text.contains('\u{1b}'));
    }

    #[test]
    fn clear_empties_the_ring_and_tells_a_reader_to_start_over() {
        let hub = LogHub::new();
        hub.feed("ios", &["a", "b", "c"]);
        let before = hub.chunk("ios", 0);
        hub.clear("ios");
        let after = hub.chunk("ios", before.start_seq + 3);
        assert!(after.entries.is_empty());
        hub.feed("ios", &["d"]);
        let c = hub.chunk("ios", 3);
        assert_eq!((c.entries.len(), c.entries[0].text.as_str(), c.reset), (1, "d", false));
        assert!(hub.chunk("ios", 0).reset);
    }

    #[test]
    fn an_unknown_platform_is_an_empty_stopped_stream() {
        let c = LogHub::new().chunk("android", 5);
        assert!(c.entries.is_empty() && !c.running && !c.reset);
    }

    #[test]
    fn stream_arguments_are_fixed_and_the_ids_validated() {
        let a = stream_args(&LogTarget::Android { serial: Some("emulator-5554".into()) }).unwrap();
        assert_eq!(&a[..3], ["-s", "emulator-5554", "logcat"]);
        assert!(a.contains(&"ReactNativeJS:V".to_owned()) && a.contains(&"ReactNative:V".to_owned()) && a.contains(&"AndroidRuntime:V".to_owned()) && a.last().unwrap() == "*:S");
        assert!(stream_args(&LogTarget::Android { serial: Some("-e; reboot".into()) }).is_none());
        let i = stream_args(&LogTarget::Ios { udid: None, process: Some("My App".into()) }).unwrap();
        assert_eq!(&i[..3], ["simctl", "spawn", "booted"]);
        assert_eq!(i.last().unwrap(), "process == \"My App\" OR subsystem == \"com.facebook.react.log\"");
        assert!(stream_args(&LogTarget::Ios { udid: Some("booted; x".into()), process: None }).is_none());
    }

    #[test]
    fn a_process_name_cannot_break_out_of_the_predicate() {
        for evil in ["a\" OR 1 == 1 OR process == \"b", "a\\", "x\ny", "(a)", &"a".repeat(100)] {
            assert_eq!(ios_predicate(Some(evil)), "subsystem == \"com.facebook.react.log\"", "{evil}");
        }
    }

    #[test]
    fn pump_splits_lines_and_bounds_a_line_without_a_newline() {
        let mut got = Vec::new();
        pump(&b"one\ntwo\r\n\nthree"[..], |l| got.push(l.to_owned()));
        assert_eq!(got, ["one", "two\r", "three"]);
        let mut long = Vec::new();
        let mut data = vec![b'a'; MAX_LINE * 40];
        data.extend_from_slice(b"\nnext\n");
        pump(&data[..], |l| long.push(l.len()));
        assert_eq!(long, [MAX_LINE * 4, 4]);
    }
}
