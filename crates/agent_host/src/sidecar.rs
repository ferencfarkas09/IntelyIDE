//! The Node sidecar as a child process: NDJSON over stdio (providers-plan 5.5). This module only moves messages;
//! what they mean is decided by the host (`host.rs`). The sidecar is the only peer, and it can only send the
//! message types the host dispatches on.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LinkError {
    #[error("the sidecar is not running")]
    Closed,
    #[error("the sidecar did not answer {0} in time")]
    Timeout(String),
}

/// A message from the sidecar that is not a reply.
pub struct Incoming {
    pub id: u32,
    pub kind: String,
    pub body: Value,
}

pub trait Handler: Send + Sync {
    fn on_message(&self, sc: &Arc<Sidecar>, msg: Incoming);
    /// The pipe closed (exit, crash or kill); called exactly once.
    fn on_closed(&self, sc: &Arc<Sidecar>);
}

type Pending = HashMap<u32, mpsc::Sender<Value>>;

pub struct Sidecar {
    pub pid: u32,
    pub generation: u64,
    pub owner: String,
    stdin: Mutex<Option<ChildStdin>>,
    next_id: AtomicU32,
    pending: Mutex<Pending>,
    alive: AtomicBool,
    child: Mutex<Option<Child>>,
    stderr_tail: Mutex<VecDeque<String>>,
    hello: (Mutex<Option<Value>>, Condvar),
    threads: Mutex<Vec<JoinHandle<()>>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Sidecar {
    /// Starts the process in its own process group (so a kill reaches everything it left behind).
    pub fn spawn(mut cmd: Command, generation: u64, handler: Weak<dyn Handler>) -> std::io::Result<Arc<Self>> {
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
        let mut child = cmd.spawn()?;
        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let sc = Arc::new(Self {
            pid,
            generation,
            owner: format!("sidecar-{pid}"),
            stdin: Mutex::new(stdin),
            next_id: AtomicU32::new(1),
            pending: Mutex::new(HashMap::new()),
            alive: AtomicBool::new(true),
            child: Mutex::new(Some(child)),
            stderr_tail: Mutex::new(VecDeque::new()),
            hello: (Mutex::new(None), Condvar::new()),
            threads: Mutex::new(Vec::new()),
        });
        let mut threads = Vec::new();
        if let Some(out) = stdout {
            let sc2 = sc.clone();
            threads.push(std::thread::Builder::new().name("sidecar-reader".into()).spawn(move || sc2.read_loop(out, handler))?);
        }
        if let Some(err) = stderr {
            let sc2 = sc.clone();
            threads.push(std::thread::Builder::new().name("sidecar-stderr".into()).spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    let mut tail = lock(&sc2.stderr_tail);
                    if tail.len() >= 40 {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            })?);
        }
        *lock(&sc.threads) = threads;
        Ok(sc)
    }

    fn read_loop(self: &Arc<Self>, out: std::process::ChildStdout, handler: Weak<dyn Handler>) {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let (Some(1), Some(id), Some(kind)) = (v["v"].as_u64(), v["id"].as_u64(), v["type"].as_str()) else { continue };
            let body = v.get("body").cloned().unwrap_or(Value::Null);
            if kind == "reply" {
                if let Some(tx) = lock(&self.pending).remove(&(id as u32)) {
                    let _ = tx.send(body);
                }
                continue;
            }
            if kind == "hello" {
                *lock(&self.hello.0) = Some(body.clone());
                self.hello.1.notify_all();
            }
            match handler.upgrade() {
                Some(h) => h.on_message(self, Incoming { id: id as u32, kind: kind.to_string(), body }),
                None => break,
            }
        }
        self.alive.store(false, Ordering::SeqCst);
        lock(&self.pending).clear();
        self.hello.1.notify_all();
        if let Some(h) = handler.upgrade() {
            h.on_closed(self);
        }
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Last lines the sidecar wrote to stderr, for the error message when it dies.
    pub fn stderr_tail(&self) -> String {
        lock(&self.stderr_tail).iter().cloned().collect::<Vec<_>>().join("\n")
    }

    /// Blocks until the sidecar said `hello` (returns its body) or `timeout` passed or the pipe closed.
    pub fn wait_hello(&self, timeout: Duration) -> Option<Value> {
        let deadline = Instant::now() + timeout;
        let mut guard = lock(&self.hello.0);
        loop {
            if let Some(v) = guard.clone() {
                return Some(v);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() || !self.alive() {
                return None;
            }
            guard = self.hello.1.wait_timeout(guard, left).unwrap_or_else(|e| e.into_inner()).0;
        }
    }

    fn write(&self, v: &Value) -> Result<(), LinkError> {
        let mut line = serde_json::to_vec(v).map_err(|_| LinkError::Closed)?;
        line.push(b'\n');
        let mut guard = lock(&self.stdin);
        let stdin = guard.as_mut().ok_or(LinkError::Closed)?;
        if stdin.write_all(&line).and_then(|()| stdin.flush()).is_err() {
            *guard = None;
            return Err(LinkError::Closed);
        }
        Ok(())
    }

    /// Request and wait for the reply body.
    pub fn request(&self, kind: &str, body: Value, timeout: Duration) -> Result<Value, LinkError> {
        if !self.alive() {
            return Err(LinkError::Closed);
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        lock(&self.pending).insert(id, tx);
        if let Err(e) = self.write(&json!({"v": 1, "id": id, "type": kind, "body": body})) {
            lock(&self.pending).remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(v) => Ok(v),
            Err(RecvTimeoutError::Timeout) => {
                lock(&self.pending).remove(&id);
                Err(LinkError::Timeout(kind.to_string()))
            }
            Err(RecvTimeoutError::Disconnected) => Err(LinkError::Closed),
        }
    }

    pub fn reply(&self, id: u32, body: Value) {
        let _ = self.write(&json!({"v": 1, "id": id, "type": "reply", "body": body}));
    }

    /// Closes the sidecar's stdin: it stops its sessions and exits on its own.
    pub fn close_stdin(&self) {
        *lock(&self.stdin) = None;
    }

    /// `true` once the process has exited (reaps it).
    pub fn wait_exit(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            {
                let mut guard = lock(&self.child);
                match guard.as_mut() {
                    None => return true,
                    Some(c) => {
                        if matches!(c.try_wait(), Ok(Some(_)) | Err(_)) {
                            *guard = None;
                            return true;
                        }
                    }
                }
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Signals the sidecar's process group (its pgid equals its pid).
    pub fn signal(&self, sig: i32) {
        // SAFETY: plain signal delivery to a group we created; the pid is ours until reaped.
        unsafe {
            libc::killpg(self.pid as libc::pid_t, sig);
        }
    }

    /// Waits for the reader threads (after the process is gone).
    pub fn join_threads(&self) {
        let handles: Vec<_> = lock(&self.threads).drain(..).collect();
        for h in handles {
            let _ = h.join();
        }
    }
}
