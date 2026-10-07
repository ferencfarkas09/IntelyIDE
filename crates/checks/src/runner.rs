//! Runs a check as a child process in its own process group and streams its output. Starting is a human action; the jail
//! decides through the run module's "Allow processes" rule (`guard::check_process`). Every output line is masked with the
//! run module's secret masker and then redacted with this crate's secret shapes before it is stored or emitted.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use intely_core::jail::Jail;
use intely_core::{code, EngineError};
use intely_runner::{guard, mask};

use crate::discover::Planned;
use crate::secrets::redact_line;
use crate::types::{CheckRun, CheckStatus, LogChunk};

const MAX_LINES: usize = 3000;
const MAX_BYTES: usize = 512 * 1024;
const MAX_LIVE: usize = 2;
const KILL_GRACE: Duration = Duration::from_secs(3);

pub trait CheckSink: Send + Sync + 'static {
    fn state(&self, run: CheckRun);
    fn log(&self, chunk: LogChunk);
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_secs() -> u32 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as u32)
}

#[derive(Default)]
struct Ring {
    lines: VecDeque<String>,
    first: u32,
    bytes: usize,
}

impl Ring {
    fn next_seq(&self) -> u32 {
        self.first.wrapping_add(self.lines.len() as u32)
    }
    fn push(&mut self, line: String) {
        self.bytes += line.len();
        self.lines.push_back(line);
        while self.lines.len() > MAX_LINES || self.bytes > MAX_BYTES {
            if let Some(old) = self.lines.pop_front() {
                self.bytes -= old.len();
                self.first = self.first.wrapping_add(1);
            }
        }
    }
    fn since(&self, from: u32) -> (u32, Vec<String>) {
        let start = from.max(self.first);
        (start, self.lines.iter().skip(start.saturating_sub(self.first) as usize).cloned().collect())
    }
}

struct Slot {
    run: Mutex<CheckRun>,
    ring: Mutex<Ring>,
    pgid: AtomicI32,
    stop: AtomicBool,
    started: Mutex<Instant>,
}

pub struct CheckRunner {
    jail: Arc<Jail>,
    sink: Arc<dyn CheckSink>,
    slots: Mutex<HashMap<String, Arc<Slot>>>,
}

impl CheckRunner {
    pub fn new(jail: Arc<Jail>, sink: Arc<dyn CheckSink>) -> Arc<Self> {
        Arc::new(Self { jail, sink, slots: Mutex::new(HashMap::new()) })
    }

    pub fn access(&self, allowed: bool, repo: Option<&std::path::Path>) -> intely_runner::types::ProcessAccess {
        guard::access(&self.jail, allowed, repo)
    }

    /// Starts the check; `allowed` is the "Allow processes" switch, `env` the login-shell environment.
    pub fn start(self: &Arc<Self>, repo_id: &str, repo: &std::path::Path, planned: &Planned, allowed: bool, env: HashMap<String, String>) -> Result<CheckRun, EngineError> {
        guard::check_process(&self.jail, allowed, repo)?;
        if let Some(why) = &planned.info.disabled {
            return Err(EngineError::new("disabled", why.clone()));
        }
        if planned.commands.is_empty() {
            return Err(EngineError::new("disabled", "nothing to run"));
        }
        let id = format!("{repo_id}:{}", planned.info.id);
        let slot = {
            let mut slots = lock(&self.slots);
            let live = slots.values().filter(|s| lock(&s.run).status == CheckStatus::Running).count();
            if slots.get(&id).is_some_and(|s| lock(&s.run).status == CheckStatus::Running) {
                return Err(EngineError::new("alreadyRunning", format!("{} is already running", planned.info.label)));
            }
            if live >= MAX_LIVE {
                return Err(EngineError::new("busy", "two checks are already running; wait for one to finish"));
            }
            let run = CheckRun { id: id.clone(), repo_id: repo_id.to_owned(), check_id: planned.info.id.clone(), label: planned.info.label.clone(), runner: planned.info.runner.clone(), status: CheckStatus::Running, exit_code: None, started_at: now_secs(), duration_ms: 0 };
            let slot = Arc::new(Slot { run: Mutex::new(run), ring: Mutex::new(Ring::default()), pgid: AtomicI32::new(0), stop: AtomicBool::new(false), started: Mutex::new(Instant::now()) });
            slots.insert(id.clone(), slot.clone());
            slot
        };
        let first = lock(&slot.run).clone();
        self.sink.state(first.clone());
        self.sink.log(LogChunk { run_id: id.clone(), start_seq: 0, lines: Vec::new(), reset: true });
        let me = self.clone();
        let commands = planned.commands.clone();
        let repo = repo.to_owned();
        std::thread::spawn(move || me.execute(&slot, &repo, &commands, &env));
        Ok(first)
    }

    fn emit(&self, slot: &Slot, lines: Vec<String>) {
        self.sink_handle().emit(slot, lines);
    }

    fn execute(self: &Arc<Self>, slot: &Arc<Slot>, repo: &std::path::Path, commands: &[Vec<String>], env: &HashMap<String, String>) {
        let mut exit = 0;
        for argv in commands {
            if slot.stop.load(Ordering::SeqCst) {
                break;
            }
            self.emit(slot, vec![format!("\u{1b}[2m$ {}\u{1b}[0m", redact_line(&mask::mask(&argv.join(" "))))]);
            let code = self.one(slot, repo, argv, env);
            if code != 0 && exit == 0 {
                exit = code;
            }
        }
        let stopped = slot.stop.load(Ordering::SeqCst);
        let finished = {
            let mut run = lock(&slot.run);
            run.status = if stopped { CheckStatus::Stopped } else if exit == 0 { CheckStatus::Passed } else { CheckStatus::Failed };
            run.exit_code = Some(exit);
            run.duration_ms = lock(&slot.started).elapsed().as_millis().min(u32::MAX as u128) as u32;
            run.clone()
        };
        self.sink.state(finished);
    }

    /// One command; returns its exit code (127 when it could not start, 143 when signalled).
    fn one(&self, slot: &Arc<Slot>, repo: &std::path::Path, argv: &[String], env: &HashMap<String, String>) -> i32 {
        let mut cmd = Command::new(&argv[0]);
        cmd.args(&argv[1..]).current_dir(repo).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
        for key in std::env::vars_os().filter_map(|(k, _)| k.into_string().ok()).filter(|k| k.starts_with("INTELY_") || k == "CI") {
            cmd.env_remove(key);
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        for (k, v) in [("FORCE_COLOR", "1"), ("NO_UPDATE_NOTIFIER", "1"), ("npm_config_update_notifier", "false"), ("npm_config_fund", "false")] {
            cmd.env(k, v);
        }
        for (k, v) in self.jail.env() {
            cmd.env(k, v);
        }
        for k in self.jail.removed_env() {
            cmd.env_remove(k);
        }
        let path = env.get("PATH").map(std::ffi::OsString::from).or_else(|| std::env::var_os("PATH"));
        match guard::read_only_git_path(&self.jail, path.as_deref()) {
            Ok(Some(p)) => {
                cmd.env("PATH", p);
            }
            Ok(None) => {}
            Err(e) => {
                self.emit(slot, vec![e.message]);
                return 126;
            }
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                self.emit(slot, vec![format!("could not start {}: {e}", argv[0])]);
                return 127;
            }
        };
        slot.pgid.store(child.id() as i32, Ordering::SeqCst);
        let readers: Vec<_> = [child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)]
            .into_iter()
            .flatten()
            .map(|stream| {
                let me = self.sink_handle();
                let slot = slot.clone();
                std::thread::spawn(move || {
                    let mut r = BufReader::new(stream);
                    let mut batch: Vec<String> = Vec::new();
                    let mut buf = Vec::new();
                    loop {
                        buf.clear();
                        match r.read_until(b'\n', &mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {}
                        }
                        let text = String::from_utf8_lossy(&buf);
                        batch.push(redact_line(&mask::mask(text.trim_end_matches(['\n', '\r']))));
                        if r.buffer().is_empty() || batch.len() >= 100 {
                            me.emit(&slot, std::mem::take(&mut batch));
                        }
                    }
                    me.emit(&slot, batch);
                })
            })
            .collect();
        let status = child.wait();
        for r in readers {
            let _ = r.join();
        }
        slot.pgid.store(0, Ordering::SeqCst);
        match status {
            Ok(s) => s.code().unwrap_or(143),
            Err(_) => 1,
        }
    }

    fn sink_handle(&self) -> Emitter {
        Emitter { sink: self.sink.clone() }
    }

    /// SIGTERM to the process group, SIGKILL after a grace period.
    pub fn stop(&self, id: &str) -> Result<(), EngineError> {
        let slot = lock(&self.slots).get(id).cloned().ok_or_else(|| EngineError::new(code::REPO_MISSING, "unknown check"))?;
        slot.stop.store(true, Ordering::SeqCst);
        let pg = slot.pgid.load(Ordering::SeqCst);
        if pg > 0 {
            unsafe { libc::killpg(pg, libc::SIGTERM) };
            std::thread::spawn(move || {
                std::thread::sleep(KILL_GRACE);
                if slot.pgid.load(Ordering::SeqCst) == pg {
                    unsafe { libc::killpg(pg, libc::SIGKILL) };
                }
            });
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        let ids: Vec<String> = lock(&self.slots).keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id);
        }
    }

    pub fn list(&self) -> Vec<CheckRun> {
        let mut runs: Vec<CheckRun> = lock(&self.slots).values().map(|s| lock(&s.run).clone()).collect();
        runs.sort_by(|a, b| b.started_at.cmp(&a.started_at).then_with(|| a.id.cmp(&b.id)));
        runs
    }

    pub fn logs(&self, id: &str, from_seq: u32) -> Result<LogChunk, EngineError> {
        let slot = lock(&self.slots).get(id).cloned().ok_or_else(|| EngineError::new(code::REPO_MISSING, "unknown check"))?;
        let (start, lines) = lock(&slot.ring).since(from_seq);
        Ok(LogChunk { run_id: id.to_owned(), start_seq: start, lines, reset: false })
    }

    pub fn dismiss(&self, id: &str) {
        let mut slots = lock(&self.slots);
        if slots.get(id).is_some_and(|s| lock(&s.run).status != CheckStatus::Running) {
            slots.remove(id);
        }
    }
}

/// What a reader thread needs to push lines: the sink only, no back reference to the runner.
struct Emitter {
    sink: Arc<dyn CheckSink>,
}

impl Emitter {
    fn emit(&self, slot: &Slot, lines: Vec<String>) {
        if lines.is_empty() {
            return;
        }
        let (seq, run_id) = {
            let mut ring = lock(&slot.ring);
            let seq = ring.next_seq();
            for l in &lines {
                ring.push(l.clone());
            }
            (seq, lock(&slot.run).id.clone())
        };
        self.sink.log(LogChunk { run_id, start_seq: seq, lines, reset: false });
    }
}
