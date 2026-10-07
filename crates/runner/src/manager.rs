//! Managed dev-server processes. One entry per script (`<repoId>:<script id>`), kept after it exits so the log survives.
//!
//! Each start spawns `<pm> run <script>` in its own process group (stdout and stderr piped, stdin closed, `FORCE_COLOR=1`),
//! records the group in the orphan registry, and runs three kinds of threads: readers, a waiter and a collector that
//! assembles lines, masks them ([`crate::mask`]), keeps a bounded ring, detects ports and batches `log` events. One monitor
//! thread (alive only while a server is) polls the tree RSS and `lsof`. Stop is SIGTERM to the group and to the groups its
//! descendants moved into, then SIGKILL after a grace. Nothing restarts by itself.

use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use intely_agent_gate::gate::cancel::{terminate_group, usable_pgid};
use intely_agent_gate::gate::{procinfo, rss};
use intely_agent_gate::OrphanRegistry;
use intely_core::jail::Jail;
use intely_core::{code, EngineError};

use crate::catalog;
use crate::guard;
use crate::mask;
use crate::port;
use crate::types::{LogChunk, ProcessAccess, Safety, ServerInfo, ServerStatus};

const MAX_LINES: usize = 5000;
const MAX_BYTES: usize = 1_500_000;
const MAX_LINE_CHARS: usize = 8192;
/// Log events are flushed at most this often.
const BATCH_WINDOW: Duration = Duration::from_millis(50);
/// A half line with no newline is flushed after this much silence.
/// A line without a newline is shown after this long. Deliberately slow: a token written in two pieces with a pause in
/// between is masked as one line, so the pieces must not be shown separately inside this window.
const PARTIAL_IDLE: Duration = Duration::from_secs(3);
const READ_CHUNK: usize = 16 * 1024;
/// How long the collector keeps draining after the process exited.
const DRAIN_GRACE: Duration = Duration::from_millis(400);
const MONITOR_TICK: Duration = Duration::from_secs(2);
/// A server with no port after this long is shown as running anyway.
const STARTING_MAX: Duration = Duration::from_secs(10);
const LSOF_EARLY: Duration = Duration::from_secs(180);
const LSOF_EVERY: Duration = Duration::from_secs(10);

pub trait RunSink: Send + Sync + 'static {
    fn state(&self, server: ServerInfo);
    fn log(&self, chunk: LogChunk);
}

#[derive(Default)]
pub struct StartOpts {
    /// The user clicked "Run anyway" on a script that needs it.
    pub confirmed: bool,
    pub allow_second_heavy: bool,
    /// Overlaid on the process environment (the login-shell `PATH` and friends).
    pub env: HashMap<String, String>,
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

    fn push(&mut self, line: String) -> u32 {
        let seq = self.next_seq();
        self.bytes += line.len();
        self.lines.push_back(line);
        while self.lines.len() > MAX_LINES || self.bytes > MAX_BYTES {
            if let Some(old) = self.lines.pop_front() {
                self.bytes -= old.len();
                self.first = self.first.wrapping_add(1);
            }
        }
        seq
    }

    fn since(&self, from: u32) -> (u32, Vec<String>) {
        let start = from.max(self.first);
        let skip = start.saturating_sub(self.first) as usize;
        (start, self.lines.iter().skip(skip).cloned().collect())
    }

    fn clear(&mut self) {
        self.first = self.next_seq();
        self.lines.clear();
        self.bytes = 0;
    }
}

struct Live {
    runner: String,
    heavy_mb: Option<u32>,
    status: ServerStatus,
    pid: Option<i32>,
    started_at: u32,
    started: Instant,
    exit_code: Option<i32>,
    log_ports: Vec<u16>,
    lsof_ports: Vec<u16>,
    rss_mb: Option<u32>,
    procs: u32,
    last_lsof: Option<Instant>,
    ring: Ring,
    /// Bumped on every start; threads of an older run stop touching the entry.
    generation: u64,
}

struct Server {
    id: String,
    repo_id: String,
    repo: PathBuf,
    script_id: String,
    live: Mutex<Live>,
}

impl Server {
    fn is_live(live: &Live) -> bool {
        matches!(live.status, ServerStatus::Starting | ServerStatus::Running | ServerStatus::Stopping)
    }

    fn info(&self, live: &Live) -> ServerInfo {
        let ports = if live.lsof_ports.is_empty() { live.log_ports.clone() } else { live.lsof_ports.clone() };
        ServerInfo {
            id: self.id.clone(),
            repo_id: self.repo_id.clone(),
            script: self.script_id.clone(),
            runner: live.runner.clone(),
            status: live.status.clone(),
            pid: live.pid,
            started_at: live.started_at,
            exit_code: live.exit_code,
            url: ports.first().filter(|_| Self::is_live(live)).map(|p| format!("http://localhost:{p}")),
            ports: if Self::is_live(live) { ports } else { Vec::new() },
            rss_mb: live.rss_mb,
            procs: live.procs,
            heavy_mb: live.heavy_mb,
        }
    }
}

struct Inner {
    jail: Arc<Jail>,
    allow_processes: AtomicBool,
    orphans: Option<Arc<OrphanRegistry>>,
    sink: Arc<dyn RunSink>,
    servers: Mutex<HashMap<String, Arc<Server>>>,
    monitoring: AtomicBool,
    closing: AtomicBool,
    grace: Duration,
}

pub struct RunManager {
    inner: Arc<Inner>,
}

enum Msg {
    Data(bool, Vec<u8>),
    Eof,
    Exited(Option<i32>),
}

impl RunManager {
    pub fn new(jail: Arc<Jail>, orphans: Option<Arc<OrphanRegistry>>, sink: Arc<dyn RunSink>) -> Self {
        Self::with_grace(jail, orphans, sink, Duration::from_secs(5))
    }

    /// `grace`: SIGTERM to SIGKILL on stop.
    pub fn with_grace(jail: Arc<Jail>, orphans: Option<Arc<OrphanRegistry>>, sink: Arc<dyn RunSink>, grace: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                jail,
                allow_processes: AtomicBool::new(false),
                orphans,
                sink,
                servers: Mutex::default(),
                monitoring: AtomicBool::new(false),
                closing: AtomicBool::new(false),
                grace,
            }),
        }
    }

    /// Opens the orphan state file at `path` and sweeps the process groups of dead IDE instances on a background
    /// thread (the same registry the terminals use, in a file of its own).
    pub fn orphan_registry(path: &Path) -> Option<Arc<OrphanRegistry>> {
        intely_term::TermManager::orphan_registry(path)
    }

    pub fn allow_processes(&self) -> bool {
        self.inner.allow_processes.load(Ordering::SeqCst)
    }

    /// The session switch of Settings > Safety. Switching it off in read-only mode also stops what it allowed.
    pub fn set_allow_processes(&self, allowed: bool) {
        self.inner.allow_processes.store(allowed, Ordering::SeqCst);
        if !allowed && self.inner.jail.mode() == intely_core::jail::Mode::ReadOnly {
            self.stop_all();
        }
    }

    pub fn access(&self, repo: Option<&Path>) -> ProcessAccess {
        guard::access(&self.inner.jail, self.allow_processes(), repo)
    }

    pub fn start(&self, repo_id: &str, repo: &Path, script_id: &str, opts: StartOpts) -> Result<ServerInfo, EngineError> {
        let inner = &self.inner;
        guard::check_process(&inner.jail, self.allow_processes(), repo)?;
        let plan = catalog::plan(repo, script_id)?;
        if plan.info.safety == Safety::Confirm && !opts.confirmed {
            return Err(EngineError::new("confirmRequired", format!("{} needs a confirmation: {}", plan.info.runner, plan.info.reasons.join(", "))));
        }
        let id = format!("{repo_id}:{script_id}");
        if let Some(mb) = plan.info.heavy_mb.filter(|_| !opts.allow_second_heavy) {
            if let Some(other) = self.heavy_running(&id) {
                return Err(EngineError::new(
                    "heavyRunning",
                    format!("{other} is a heavy server and is running; {} needs up to {mb} MB of Node heap. Stop one of them first, or start anyway.", plan.info.runner),
                ));
            }
        }
        let server = lock(&inner.servers)
            .entry(id.clone())
            .or_insert_with(|| {
                Arc::new(Server {
                    id: id.clone(),
                    repo_id: repo_id.to_owned(),
                    repo: repo.to_owned(),
                    script_id: script_id.to_owned(),
                    live: Mutex::new(Live {
                        runner: plan.info.runner.clone(),
                        heavy_mb: plan.info.heavy_mb,
                        status: ServerStatus::Exited,
                        pid: None,
                        started_at: 0,
                        started: Instant::now(),
                        exit_code: None,
                        log_ports: Vec::new(),
                        lsof_ports: Vec::new(),
                        rss_mb: None,
                        procs: 0,
                        last_lsof: None,
                        ring: Ring::default(),
                        generation: 0,
                    }),
                })
            })
            .clone();
        {
            let live = lock(&server.live);
            if Server::is_live(&live) {
                return Err(EngineError::new("alreadyRunning", format!("{} is already running", live.runner)));
            }
        }

        let mut cmd = Command::new(&plan.argv[0]);
        cmd.args(&plan.argv[1..]).current_dir(repo).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
        for key in std::env::vars_os().filter_map(|(k, _)| k.into_string().ok()).filter(|k| k.starts_with("INTELY_") || k == "CI") {
            cmd.env_remove(key);
        }
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }
        for (k, v) in [("FORCE_COLOR", "1"), ("BROWSER", "none"), ("NO_UPDATE_NOTIFIER", "1"), ("npm_config_update_notifier", "false"), ("npm_config_fund", "false")] {
            cmd.env(k, v);
        }
        // Whatever a script runs may call git: an active jail hardens that environment too.
        for (k, v) in inner.jail.env() {
            cmd.env(k, v);
        }
        for k in inner.jail.removed_env() {
            cmd.env_remove(k);
        }
        // Read-only mode: scripts get a git that cannot change anything (after `opts.env`, which must not replace PATH).
        let path = opts.env.get("PATH").map(std::ffi::OsString::from).or_else(|| std::env::var_os("PATH"));
        if let Some(path) = guard::read_only_git_path(&inner.jail, path.as_deref())? {
            cmd.env("PATH", path);
        }

        let spawned = cmd.spawn();
        let generation = {
            let mut live = lock(&server.live);
            live.generation += 1;
            live.runner = plan.info.runner.clone();
            live.heavy_mb = plan.info.heavy_mb;
            live.exit_code = None;
            live.log_ports.clear();
            live.lsof_ports.clear();
            live.rss_mb = None;
            live.procs = 0;
            live.last_lsof = None;
            live.started = Instant::now();
            live.started_at = now_secs();
            let marker = format!("─── {} ───", live.runner);
            live.ring.push(marker);
            live.generation
        };
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                let info = {
                    let mut live = lock(&server.live);
                    live.status = ServerStatus::Failed;
                    live.pid = None;
                    live.ring.push(format!("could not start {}: {e}", plan.argv[0]));
                    server.info(&live)
                };
                inner.sink.state(info);
                return Err(EngineError::new(code::IO, format!("could not start {}: {e}", plan.argv[0])));
            }
        };
        let pid = child.id() as i32;
        if let Some(o) = &inner.orphans {
            if usable_pgid(pid) {
                let _ = o.record(pid, &id, "run");
            }
        }
        let info = {
            let mut live = lock(&server.live);
            live.status = ServerStatus::Starting;
            live.pid = Some(pid);
            server.info(&live)
        };
        inner.sink.state(info.clone());

        let (tx, rx) = channel::<Msg>();
        for (is_err, stream) in [(false, child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>)), (true, child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>))] {
            let Some(mut stream) = stream else { continue };
            let tx = tx.clone();
            std::thread::spawn(move || {
                let mut buf = vec![0u8; READ_CHUNK];
                while let Ok(n) = stream.read(&mut buf) {
                    if n == 0 || tx.send(Msg::Data(is_err, buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                let _ = tx.send(Msg::Eof);
            });
        }
        {
            let orphans = inner.orphans.clone();
            let grace = inner.grace;
            std::thread::spawn(move || {
                let code = child.wait().ok().and_then(|s| s.code().or_else(|| s.signal().map(|sig| 128 + sig)));
                // Whatever the main process left behind goes with it.
                end_groups(&[pid], Duration::from_secs(2).min(grace));
                if let Some(o) = orphans {
                    let _ = o.forget(pid);
                }
                let _ = tx.send(Msg::Exited(code));
            });
        }
        let inner2 = inner.clone();
        std::thread::spawn(move || collect(rx, &inner2, &server, generation));
        ensure_monitor(inner);
        Ok(info)
    }

    fn heavy_running(&self, except: &str) -> Option<String> {
        lock(&self.inner.servers).values().filter(|s| s.id != except).find_map(|s| {
            let live = lock(&s.live);
            (Server::is_live(&live) && live.heavy_mb.is_some()).then(|| live.runner.clone())
        })
    }

    fn find(&self, id: &str) -> Result<Arc<Server>, EngineError> {
        lock(&self.inner.servers).get(id).cloned().ok_or_else(|| EngineError::new(code::IO, format!("no server {id}")))
    }

    /// Ends the server's process tree without blocking the caller. A server that is not running is not an error.
    pub fn stop(&self, id: &str) -> Result<(), EngineError> {
        let server = self.find(id)?;
        let (pid, info) = {
            let mut live = lock(&server.live);
            if !matches!(live.status, ServerStatus::Starting | ServerStatus::Running) {
                return Ok(());
            }
            live.status = ServerStatus::Stopping;
            (live.pid, server.info(&live))
        };
        self.inner.sink.state(info);
        if let Some(pid) = pid {
            let mut groups = vec![pid];
            groups.extend(rss::descendant_pgids(&[pid]));
            let grace = self.inner.grace;
            std::thread::spawn(move || end_groups(&groups, grace));
        }
        Ok(())
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = lock(&self.inner.servers).keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id);
        }
    }

    /// Stop, wait for the exit, start again. Blocks for up to the stop grace.
    pub fn restart(&self, id: &str, env: HashMap<String, String>) -> Result<ServerInfo, EngineError> {
        let server = self.find(id)?;
        self.stop(id)?;
        let deadline = Instant::now() + self.inner.grace + Duration::from_secs(4);
        while Instant::now() < deadline && Server::is_live(&lock(&server.live)) {
            std::thread::sleep(Duration::from_millis(40));
        }
        self.start(&server.repo_id, &server.repo, &server.script_id, StartOpts { confirmed: true, allow_second_heavy: true, env })
    }

    pub fn list(&self) -> Vec<ServerInfo> {
        let mut all: Vec<ServerInfo> = lock(&self.inner.servers).values().map(|s| s.info(&lock(&s.live))).collect();
        all.sort_by(|a, b| (a.started_at, &a.id).cmp(&(b.started_at, &b.id)));
        all
    }

    /// The loopback URL of a running server's first port; the Tauri side opens it in the system browser.
    pub fn url(&self, id: &str) -> Option<String> {
        let server = self.find(id).ok()?;
        let live = lock(&server.live);
        server.info(&live).url
    }

    /// Lines with `seq >= from_seq`.
    pub fn logs(&self, id: &str, from_seq: u32) -> Result<LogChunk, EngineError> {
        let server = self.find(id)?;
        let live = lock(&server.live);
        let (start_seq, lines) = live.ring.since(from_seq);
        Ok(LogChunk { server_id: id.to_owned(), start_seq, lines, reset: false })
    }

    pub fn clear_log(&self, id: &str) -> Result<(), EngineError> {
        let server = self.find(id)?;
        let seq = {
            let mut live = lock(&server.live);
            live.ring.clear();
            live.ring.next_seq()
        };
        self.inner.sink.log(LogChunk { server_id: id.to_owned(), start_seq: seq, lines: Vec::new(), reset: true });
        Ok(())
    }

    /// Forgets an exited server (and its log).
    pub fn dismiss(&self, id: &str) {
        let mut servers = lock(&self.inner.servers);
        if servers.get(id).is_some_and(|s| !Server::is_live(&lock(&s.live))) {
            servers.remove(id);
        }
    }

    /// App exit: no server may outlive the IDE. Blocks for the stop grace at most.
    pub fn shutdown(&self) {
        self.inner.closing.store(true, Ordering::SeqCst);
        let ends: Vec<_> = lock(&self.inner.servers)
            .values()
            .filter_map(|s| {
                let live = lock(&s.live);
                let pid = live.pid.filter(|_| Server::is_live(&live))?;
                let mut groups = vec![pid];
                groups.extend(rss::descendant_pgids(&[pid]));
                Some(groups)
            })
            .map(|groups| {
                let grace = self.inner.grace.min(Duration::from_millis(1500));
                std::thread::spawn(move || end_groups(&groups, grace))
            })
            .collect();
        for e in ends {
            let _ = e.join();
        }
    }
}

/// SIGTERM, then SIGKILL after `grace`, for every group in parallel.
fn end_groups(groups: &[i32], grace: Duration) {
    let kills: Vec<_> = groups.iter().map(|&g| std::thread::spawn(move || terminate_group(g, grace))).collect();
    for k in kills {
        let _ = k.join();
    }
}

#[derive(Default)]
struct LineBuf {
    bytes: Vec<u8>,
    since: Option<Instant>,
}

impl LineBuf {
    /// Complete lines; the rest stays.
    fn feed(&mut self, data: &[u8], out: &mut Vec<String>) {
        self.bytes.extend_from_slice(data);
        while let Some(p) = self.bytes.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.bytes.drain(..=p).collect();
            out.push(finish_line(&line[..line.len() - 1]));
        }
        self.since = (!self.bytes.is_empty()).then(|| self.since.unwrap_or_else(Instant::now));
        // A runaway line without a newline must not grow without bound.
        if self.bytes.len() > MAX_LINE_CHARS * 4 {
            let line = std::mem::take(&mut self.bytes);
            out.push(finish_line(&line));
            self.since = None;
        }
    }

    fn flush_if_idle(&mut self, force: bool, out: &mut Vec<String>) {
        if self.since.is_some_and(|t| force || t.elapsed() >= PARTIAL_IDLE) {
            let line = std::mem::take(&mut self.bytes);
            self.since = None;
            out.push(finish_line(&line));
        }
    }
}

/// One output line: `\r\n` trimmed, a `\r` progress rewrite keeps the last segment, text capped.
fn finish_line(raw: &[u8]) -> String {
    let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
    let seg = raw.rsplit(|b| *b == b'\r').find(|s| !s.is_empty()).unwrap_or(raw);
    let mut text = String::from_utf8_lossy(seg).into_owned();
    if text.chars().count() > MAX_LINE_CHARS {
        text = text.chars().take(MAX_LINE_CHARS).collect::<String>() + " …";
    }
    text
}

fn collect(rx: std::sync::mpsc::Receiver<Msg>, inner: &Arc<Inner>, server: &Arc<Server>, generation: u64) {
    let mut bufs = [LineBuf::default(), LineBuf::default()];
    let mut pending: Vec<String> = Vec::new();
    let mut pending_start = 0u32;
    let mut pending_since: Option<Instant> = None;
    let mut eofs = 0;
    let mut exited: Option<(Option<i32>, Instant)> = None;
    let flush = |pending: &mut Vec<String>, start: u32| {
        if !pending.is_empty() {
            inner.sink.log(LogChunk { server_id: server.id.clone(), start_seq: start, lines: std::mem::take(pending), reset: false });
        }
    };
    loop {
        let timeout = match (pending_since, &exited) {
            (Some(t), _) => BATCH_WINDOW.saturating_sub(t.elapsed()).max(Duration::from_millis(1)),
            _ => Duration::from_millis(100),
        };
        let mut lines = Vec::new();
        match rx.recv_timeout(timeout) {
            Ok(Msg::Data(is_err, data)) => bufs[usize::from(is_err)].feed(&data, &mut lines),
            Ok(Msg::Eof) => {
                eofs += 1;
                if eofs == 2 {
                    bufs.iter_mut().for_each(|b| b.flush_if_idle(true, &mut lines));
                }
            }
            Ok(Msg::Exited(code)) => exited = Some((code, Instant::now())),
            Err(RecvTimeoutError::Timeout) => bufs.iter_mut().for_each(|b| b.flush_if_idle(false, &mut lines)),
            Err(RecvTimeoutError::Disconnected) => {
                bufs.iter_mut().for_each(|b| b.flush_if_idle(true, &mut lines));
                if exited.is_none() {
                    exited = Some((None, Instant::now()));
                }
            }
        }
        let mut changed = None;
        if !lines.is_empty() {
            let mut live = lock(&server.live);
            if live.generation != generation {
                return;
            }
            let before = server.info(&live);
            for line in lines {
                for p in port::ports_in_line(&line) {
                    if !live.log_ports.contains(&p) {
                        live.log_ports.push(p);
                    }
                }
                let masked = mask::mask(&line);
                let seq = live.ring.push(masked.clone());
                if pending.is_empty() {
                    pending_start = seq;
                    pending_since = Some(Instant::now());
                }
                pending.push(masked);
            }
            if matches!(live.status, ServerStatus::Starting) && !live.log_ports.is_empty() {
                live.status = ServerStatus::Running;
            }
            let after = server.info(&live);
            if before.ports != after.ports || before.status != after.status {
                changed = Some(after);
            }
        }
        if let Some(info) = changed {
            inner.sink.state(info);
        }
        if pending_since.is_some_and(|t| t.elapsed() >= BATCH_WINDOW) || pending.len() >= 200 {
            flush(&mut pending, pending_start);
            pending_since = None;
        }
        if let Some((_, at)) = exited {
            if eofs >= 2 || at.elapsed() >= DRAIN_GRACE {
                break;
            }
        }
    }
    flush(&mut pending, pending_start);
    let code = exited.and_then(|(c, _)| c);
    let info = {
        let mut live = lock(&server.live);
        if live.generation != generation {
            return;
        }
        // The user asked for it (SIGTERM/SIGINT/SIGKILL of the group): that is a stop, not a failure to show in red.
        let requested = live.status == ServerStatus::Stopping && matches!(code, Some(130 | 137 | 143));
        let code = if requested { None } else { code };
        live.status = ServerStatus::Exited;
        live.exit_code = code;
        live.pid = None;
        live.rss_mb = None;
        live.procs = 0;
        let line = match code {
            Some(0) => "─── exited ───".to_owned(),
            Some(c) => format!("─── exited with code {c} ───"),
            None if requested => "─── stopped ───".to_owned(),
            None => "─── exited ───".to_owned(),
        };
        let seq = live.ring.push(line.clone());
        inner.sink.log(LogChunk { server_id: server.id.clone(), start_seq: seq, lines: vec![line], reset: false });
        server.info(&live)
    };
    inner.sink.state(info);
}

fn ensure_monitor(inner: &Arc<Inner>) {
    if inner.monitoring.swap(true, Ordering::SeqCst) {
        return;
    }
    let inner = inner.clone();
    std::thread::spawn(move || loop {
        let mut slept = Duration::ZERO;
        while slept < MONITOR_TICK && !inner.closing.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(100));
            slept += Duration::from_millis(100);
        }
        if inner.closing.load(Ordering::SeqCst) {
            inner.monitoring.store(false, Ordering::SeqCst);
            return;
        }
        let servers: Vec<Arc<Server>> = lock(&inner.servers).values().cloned().collect();
        let mut any = false;
        for server in servers {
            let (pid, generation, need_lsof) = {
                let live = lock(&server.live);
                let Some(pid) = live.pid.filter(|_| Server::is_live(&live)) else { continue };
                let due = live.last_lsof.map_or(true, |t| t.elapsed() >= if live.lsof_ports.is_empty() && live.started.elapsed() < LSOF_EARLY { MONITOR_TICK } else { LSOF_EVERY });
                (pid, live.generation, due)
            };
            any = true;
            let tree = rss::tree_pids(&[pid], &[pid]);
            let bytes: u64 = tree.iter().filter_map(|p| procinfo::rss_bytes(*p)).sum();
            let ports = need_lsof.then(|| port::listening_ports(&tree));
            let info = {
                let mut live = lock(&server.live);
                if live.generation != generation || !Server::is_live(&live) {
                    continue;
                }
                let before = server.info(&live);
                live.rss_mb = Some((bytes / (1024 * 1024)) as u32);
                live.procs = tree.len() as u32;
                if let Some(p) = ports {
                    live.last_lsof = Some(Instant::now());
                    live.lsof_ports = p;
                }
                if matches!(live.status, ServerStatus::Starting) && (!live.lsof_ports.is_empty() || !live.log_ports.is_empty() || live.started.elapsed() >= STARTING_MAX) {
                    live.status = ServerStatus::Running;
                }
                let after = server.info(&live);
                let moved = before.rss_mb.unwrap_or(0).abs_diff(after.rss_mb.unwrap_or(0)) >= 10;
                (before.ports != after.ports || before.status != after.status || before.procs != after.procs || moved || before.rss_mb.is_none()).then_some(after)
            };
            if let Some(info) = info {
                inner.sink.state(info);
            }
        }
        if !any {
            inner.monitoring.store(false, Ordering::SeqCst);
            // A start between the scan and the store would otherwise find the flag set and spawn no monitor.
            let started = lock(&inner.servers).values().any(|s| Server::is_live(&lock(&s.live)));
            if started && !inner.monitoring.swap(true, Ordering::SeqCst) {
                continue;
            }
            return;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_are_split_trimmed_and_progress_rewrites_keep_the_last_segment() {
        let mut buf = LineBuf::default();
        let mut out = Vec::new();
        buf.feed(b"one\r\ntwo\nprogress 10%\rprogress 100%\nhal", &mut out);
        assert_eq!(out, ["one", "two", "progress 100%"]);
        assert!(buf.bytes == b"hal");
        buf.feed(b"f\n", &mut out);
        assert_eq!(out.last().unwrap(), "half");
        let mut tail = Vec::new();
        buf.feed(b"partial", &mut tail);
        buf.flush_if_idle(true, &mut tail);
        assert_eq!(tail, ["partial"]);
    }

    #[test]
    fn an_unterminated_line_is_held_so_a_token_written_in_two_pieces_is_masked_whole() {
        let mut buf = LineBuf::default();
        let mut out = Vec::new();
        buf.feed(b"token is ghp_AAAAAAAAAA", &mut out);
        buf.since = Some(Instant::now() - Duration::from_millis(800));
        buf.flush_if_idle(false, &mut out);
        assert!(out.is_empty(), "nothing is shown inside the hold time");
        buf.feed(b"BBBBBBBBBB\n", &mut out);
        assert_eq!(out, ["token is ghp_AAAAAAAAAABBBBBBBBBB"]);
        buf.feed(b"waiting", &mut out);
        buf.since = Some(Instant::now() - PARTIAL_IDLE - Duration::from_millis(50));
        buf.flush_if_idle(false, &mut out);
        assert_eq!(out.last().unwrap(), "waiting");
        assert!(buf.bytes.is_empty() && buf.since.is_none());
    }

    #[test]
    fn the_ring_is_bounded_and_clear_keeps_the_sequence_going() {
        let mut ring = Ring::default();
        for i in 0..(MAX_LINES + 10) {
            ring.push(format!("l{i}"));
        }
        assert_eq!(ring.lines.len(), MAX_LINES);
        assert_eq!(ring.first, 10);
        let (start, lines) = ring.since(0);
        assert_eq!((start, lines.len(), lines[0].as_str()), (10, MAX_LINES, "l10"));
        let (start, lines) = ring.since(MAX_LINES as u32 + 8);
        assert_eq!((start, lines.len()), (MAX_LINES as u32 + 8, 2));
        let next = ring.next_seq();
        ring.clear();
        assert_eq!((ring.first, ring.lines.len()), (next, 0));
        assert_eq!(ring.push("x".into()), next);
    }

    #[test]
    fn a_very_long_line_is_capped() {
        let long = "a".repeat(MAX_LINE_CHARS + 50);
        assert_eq!(finish_line(long.as_bytes()).chars().count(), MAX_LINE_CHARS + 2);
    }
}
