//! Pty sessions: one login shell per terminal in its own process group, output coalesced into ~16 ms batches.
//! Scrollback lives in the webview (xterm.js); nothing is stored here.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use intely_agent_gate::gate::cancel::{terminate_group, usable_pgid};
use intely_agent_gate::gate::procinfo::{child_pids, live_group_pids, pgid_of};
use intely_agent_gate::OrphanRegistry;
use intely_core::jail::Jail;
use intely_core::{code, EngineError};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use crate::types::TermEvent;
use crate::utf8::Utf8Carry;

/// Output is flushed to the UI at most this often.
pub const BATCH_WINDOW: Duration = Duration::from_millis(16);
/// A batch never grows past this, so one `cat bigfile` cannot build a single huge message.
const MAX_BATCH: usize = 128 * 1024;
const READ_CHUNK: usize = 16 * 1024;
/// Chunks buffered between the reader and the batcher; a full queue blocks the reader and with it the child.
const QUEUE_DEPTH: usize = 64;
/// SIGTERM to SIGKILL grace when a terminal is closed.
const CLOSE_GRACE: Duration = Duration::from_secs(2);
const SHUTDOWN_GRACE: Duration = Duration::from_millis(800);
/// How long the shell gets to leave after SIGHUP before the harder signals follow.
const HANGUP_WAIT: Duration = Duration::from_millis(300);
/// How long after the shell exited the waiter lets the reader drain the last output.
const DRAIN_GRACE: Duration = Duration::from_millis(250);

pub type Emit = Box<dyn Fn(TermEvent) + Send + 'static>;

pub struct SpawnSpec {
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    /// Overlaid on the process environment (the login-shell `PATH` and friends).
    pub env: HashMap<String, String>,
    /// Defaults to `$SHELL`, else `/bin/zsh`.
    pub shell: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct Opened {
    pub term_id: String,
    pub pid: i32,
    pub shell: String,
    pub cwd: PathBuf,
}

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    pgid: i32,
}

type Sessions = Arc<Mutex<HashMap<String, Arc<Session>>>>;

pub struct TermManager {
    sessions: Sessions,
    jail: Arc<Jail>,
    orphans: Option<Arc<OrphanRegistry>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn io_err(what: &str, e: impl std::fmt::Display) -> EngineError {
    EngineError::new(code::IO, format!("{what}: {e}"))
}

pub fn default_shell() -> PathBuf {
    std::env::var_os("SHELL").filter(|s| !s.is_empty()).map_or_else(|| PathBuf::from("/bin/zsh"), PathBuf::from)
}

impl TermManager {
    /// `orphans` records every shell's process group so a crashed IDE's shells are swept on the next start.
    pub fn new(jail: Arc<Jail>, orphans: Option<Arc<OrphanRegistry>>) -> Self {
        Self { sessions: Arc::default(), jail, orphans }
    }

    /// Opens the orphan state file at `path` and sweeps the shells of dead IDE instances on a background thread.
    pub fn orphan_registry(path: &Path) -> Option<Arc<OrphanRegistry>> {
        let registry = Arc::new(OrphanRegistry::open(path).ok()?);
        let sweeper = registry.clone();
        std::thread::spawn(move || {
            let _ = sweeper.sweep();
        });
        Some(registry)
    }

    pub fn open(&self, spec: SpawnSpec, emit: Emit) -> Result<Opened, EngineError> {
        // A shell can do anything: in READONLY it is refused outright, in E2E it must start inside the fixture root.
        self.jail.check_op("terminal", &spec.cwd)?;
        if !spec.cwd.is_dir() {
            return Err(io_err("terminal", format!("{} is not a directory", spec.cwd.display())));
        }
        let shell = spec.shell.clone().unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l");
        cmd.cwd(&spec.cwd);
        for key in std::env::vars_os().filter_map(|(k, _)| k.into_string().ok()).filter(|k| k.starts_with("INTELY_")) {
            cmd.env_remove(key);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        if !spec.env.contains_key("LANG") && std::env::var_os("LANG").is_none_or(|v| v.is_empty()) {
            // An app started from Finder has no locale; without UTF-8 the shell mangles every non-ASCII character.
            cmd.env("LANG", "en_US.UTF-8");
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "IntelySwitchIDE");
        for (k, v) in self.jail.env() {
            cmd.env(k, v);
        }
        for k in self.jail.removed_env() {
            cmd.env_remove(k);
        }

        let pair = native_pty_system()
            .openpty(PtySize { rows: spec.rows.max(1), cols: spec.cols.max(1), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| io_err("openpty", e))?;
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| io_err("spawn shell", e))?;
        // The master only sees EOF once the last slave handle is gone.
        drop(pair.slave);
        let pid = child.process_id().map_or(0, |p| p as i32);
        let reader = pair.master.try_clone_reader().map_err(|e| io_err("pty reader", e))?;
        let writer = pair.master.take_writer().map_err(|e| io_err("pty writer", e))?;
        let term_id = next_id(pid);
        if let Some(o) = &self.orphans {
            if usable_pgid(pid) {
                let _ = o.record(pid, &term_id, "terminal");
            }
        }
        lock(&self.sessions).insert(
            term_id.clone(),
            Arc::new(Session { master: Mutex::new(pair.master), writer: Mutex::new(writer), pgid: pid }),
        );

        let (tx, rx) = sync_channel::<Msg>(QUEUE_DEPTH);
        let reader_done = Arc::new(AtomicBool::new(false));
        spawn_reader(reader, tx.clone(), reader_done.clone());
        let orphans = self.orphans.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code() as i32);
            // Like a terminal window closing: whatever the shell left running gets SIGHUP.
            if usable_pgid(pid) {
                unsafe { libc::killpg(pid, libc::SIGHUP) };
            }
            let until = Instant::now() + DRAIN_GRACE;
            while !reader_done.load(Ordering::Acquire) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(5));
            }
            let _ = tx.send(Msg::Exited(code));
            if let Some(o) = orphans {
                let _ = o.forget(pid);
            }
        });
        let sessions = self.sessions.clone();
        let id = term_id.clone();
        std::thread::spawn(move || {
            batch(rx, &emit);
            lock(&sessions).remove(&id);
        });
        Ok(Opened { term_id, pid, shell: shell.to_string_lossy().into_owned(), cwd: spec.cwd })
    }

    fn session(&self, term_id: &str) -> Result<Arc<Session>, EngineError> {
        lock(&self.sessions).get(term_id).cloned().ok_or_else(|| EngineError::new(code::IO, format!("terminal {term_id} is not open")))
    }

    pub fn write(&self, term_id: &str, data: &str) -> Result<(), EngineError> {
        let s = self.session(term_id)?;
        let mut w = lock(&s.writer);
        w.write_all(data.as_bytes()).and_then(|()| w.flush()).map_err(|e| io_err("write", e))
    }

    pub fn resize(&self, term_id: &str, cols: u16, rows: u16) -> Result<(), EngineError> {
        let s = self.session(term_id)?;
        let size = PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 };
        let res = lock(&s.master).resize(size);
        res.map_err(|e| io_err("resize", e))
    }

    /// Ends the shell and everything it started (SIGHUP, then SIGTERM, then SIGKILL after a grace) without blocking
    /// the caller. Closing a terminal that is already gone is not an error.
    pub fn close(&self, term_id: &str) {
        let Some(s) = lock(&self.sessions).remove(term_id) else { return };
        let groups = process_groups(s.pgid);
        let orphans = self.orphans.clone();
        std::thread::spawn(move || {
            end_groups(&groups, CLOSE_GRACE);
            if let Some(o) = orphans {
                let _ = o.forget(s.pgid);
            }
        });
    }

    pub fn open_ids(&self) -> Vec<String> {
        lock(&self.sessions).keys().cloned().collect()
    }

    /// App exit: no shell may outlive the IDE. Blocks for the SIGTERM grace at most.
    pub fn shutdown(&self) {
        let all: Vec<Arc<Session>> = lock(&self.sessions).drain().map(|(_, s)| s).collect();
        let ends: Vec<_> = all
            .iter()
            .map(|s| process_groups(s.pgid))
            .map(|groups| std::thread::spawn(move || end_groups(&groups, SHUTDOWN_GRACE)))
            .collect();
        for e in ends {
            let _ = e.join();
        }
        if let Some(o) = &self.orphans {
            for s in &all {
                let _ = o.forget(s.pgid);
            }
        }
    }
}

/// The shell's group plus the groups of its descendants: an interactive shell puts every background job in a group
/// of its own, and those survive a signal sent to the shell's group alone.
fn process_groups(shell: i32) -> Vec<i32> {
    let mut groups = vec![shell];
    let mut queue = vec![shell];
    while let Some(pid) = queue.pop() {
        for child in child_pids(pid) {
            if let Some(g) = pgid_of(child).filter(|g| !groups.contains(g)) {
                groups.push(g);
            }
            queue.push(child);
        }
    }
    groups.into_iter().filter(|g| usable_pgid(*g)).collect()
}

/// SIGHUP like a closing terminal window (an interactive shell ignores SIGTERM), then the escalating kill.
fn end_groups(groups: &[i32], grace: Duration) {
    for &g in groups {
        unsafe { libc::killpg(g, libc::SIGHUP) };
    }
    let hangup = Instant::now() + HANGUP_WAIT;
    while Instant::now() < hangup && groups.iter().any(|&g| !live_group_pids(g).is_empty()) {
        std::thread::sleep(Duration::from_millis(10));
    }
    let kills: Vec<_> = groups.iter().map(|&g| std::thread::spawn(move || terminate_group(g, grace))).collect();
    for k in kills {
        let _ = k.join();
    }
}

enum Msg {
    Data(Vec<u8>),
    Exited(Option<i32>),
}

fn spawn_reader(mut reader: Box<dyn Read + Send>, tx: SyncSender<Msg>, done: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_CHUNK];
        // EIO is how a pty reports that the last slave handle closed.
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(Msg::Data(buf[..n].to_vec())).is_err() {
                break;
            }
        }
        done.store(true, Ordering::Release);
    });
}

/// Collects chunks for up to [`BATCH_WINDOW`] after the first one arrives, then emits them as one `Data` event.
fn batch(rx: std::sync::mpsc::Receiver<Msg>, emit: &Emit) {
    let mut carry = Utf8Carry::default();
    let mut code = None;
    loop {
        let mut bytes = match rx.recv() {
            Ok(Msg::Data(b)) => b,
            Ok(Msg::Exited(c)) => {
                code = c;
                break;
            }
            Err(_) => break,
        };
        let deadline = Instant::now() + BATCH_WINDOW;
        let mut exited = false;
        while bytes.len() < MAX_BATCH {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            match rx.recv_timeout(left) {
                Ok(Msg::Data(b)) => bytes.extend_from_slice(&b),
                Ok(Msg::Exited(c)) => {
                    code = c;
                    exited = true;
                    break;
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    exited = true;
                    break;
                }
            }
        }
        let data = carry.decode(&bytes);
        if !data.is_empty() {
            emit(TermEvent::Data { data });
        }
        if exited {
            break;
        }
    }
    let tail = carry.finish();
    if !tail.is_empty() {
        emit(TermEvent::Data { data: tail });
    }
    emit(TermEvent::Exit { code });
}

fn next_id(pid: i32) -> String {
    use std::sync::atomic::AtomicU64;
    static SEQ: AtomicU64 = AtomicU64::new(1);
    format!("term-{pid}-{}", SEQ.fetch_add(1, Ordering::Relaxed))
}
