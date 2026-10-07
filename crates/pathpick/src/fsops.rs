//! The filesystem seam of the picker and its deadline guard ((design notes: workspaces-spec) 4.5, 5.4, T15).
//!
//! `FsOps` is what validation and listing call for stat and canonicalise; `FakeFs` can block or sleep so a hung volume is
//! testable. `Guard` runs a whole operation on a worker thread with a deadline: a call past it is abandoned (reported as
//! `unresponsive`), the number of abandoned threads is capped, and a mount that hung once is skipped for the session.

use std::collections::HashSet;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use intely_core::EngineError;

use crate::types::codes;

#[derive(Debug, Clone, Copy)]
pub struct StatInfo {
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub dev: u64,
    pub ino: u64,
    pub uid: u32,
    pub size: u64,
    pub flags: u32,
}

impl StatInfo {
    pub fn from_metadata(md: &std::fs::Metadata) -> Self {
        #[cfg(target_os = "macos")]
        let flags = std::os::macos::fs::MetadataExt::st_flags(md);
        #[cfg(not(target_os = "macos"))]
        let flags = 0;
        Self {
            is_dir: md.is_dir(),
            is_file: md.is_file(),
            is_symlink: md.file_type().is_symlink(),
            dev: md.dev(),
            ino: md.ino(),
            uid: md.uid(),
            size: md.len(),
            flags,
        }
    }
}

pub trait FsOps: Send + Sync {
    /// `lstat`
    fn symlink_stat(&self, path: &Path) -> io::Result<StatInfo>;
    /// `stat` (follows links)
    fn stat(&self, path: &Path) -> io::Result<StatInfo>;
    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf>;
    /// Entry names with their `lstat`, in directory order. Names that are not UTF-8 come back as `None`.
    fn read_dir(&self, path: &Path, limit: usize) -> io::Result<RawDir>;
}

pub struct RawDir {
    pub entries: Vec<(String, Option<StatInfo>)>,
    pub skipped_unreadable: u32,
    pub hit_limit: bool,
}

pub struct RealFs;

impl FsOps for RealFs {
    fn symlink_stat(&self, path: &Path) -> io::Result<StatInfo> {
        std::fs::symlink_metadata(path).map(|m| StatInfo::from_metadata(&m))
    }

    fn stat(&self, path: &Path) -> io::Result<StatInfo> {
        std::fs::metadata(path).map(|m| StatInfo::from_metadata(&m))
    }

    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        std::fs::canonicalize(path)
    }

    fn read_dir(&self, path: &Path, limit: usize) -> io::Result<RawDir> {
        let mut out = RawDir { entries: Vec::new(), skipped_unreadable: 0, hit_limit: false };
        for item in std::fs::read_dir(path)? {
            let Ok(item) = item else {
                out.skipped_unreadable += 1;
                continue;
            };
            if out.entries.len() >= limit {
                out.hit_limit = true;
                break;
            }
            let Ok(name) = item.file_name().into_string() else {
                out.skipped_unreadable += 1;
                continue;
            };
            let stat = std::fs::symlink_metadata(item.path()).ok().map(|m| StatInfo::from_metadata(&m));
            out.entries.push((name, stat));
        }
        Ok(out)
    }
}

/// A filesystem that delegates to the real one but can stall: every call on a path containing a registered marker
/// sleeps (`delay`) or waits until `release()` (`block`).
#[derive(Default)]
pub struct FakeFs {
    inner: Option<RealFs>,
    rules: Mutex<Vec<(String, Option<Duration>)>>,
    gate: (Mutex<bool>, Condvar),
    pub calls: AtomicUsize,
}

impl FakeFs {
    pub fn new() -> Self {
        Self { inner: Some(RealFs), ..Default::default() }
    }

    /// Calls on paths containing `marker` wait until [`FakeFs::release`].
    pub fn block(&self, marker: &str) {
        self.rules.lock().unwrap().push((marker.to_owned(), None));
    }

    pub fn delay(&self, marker: &str, d: Duration) {
        self.rules.lock().unwrap().push((marker.to_owned(), Some(d)));
    }

    pub fn release(&self) {
        *self.gate.0.lock().unwrap() = true;
        self.gate.1.notify_all();
    }

    fn stall(&self, path: &Path) {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let hit = {
            let text = path.to_string_lossy();
            self.rules.lock().unwrap().iter().find(|(m, _)| text.contains(m.as_str())).cloned()
        };
        match hit {
            Some((_, Some(d))) => std::thread::sleep(d),
            Some((_, None)) => {
                let mut open = self.gate.0.lock().unwrap();
                while !*open {
                    open = self.gate.1.wait(open).unwrap();
                }
            }
            None => {}
        }
    }

    fn real(&self) -> &RealFs {
        self.inner.as_ref().expect("FakeFs::new")
    }
}

impl FsOps for FakeFs {
    fn symlink_stat(&self, path: &Path) -> io::Result<StatInfo> {
        self.stall(path);
        self.real().symlink_stat(path)
    }

    fn stat(&self, path: &Path) -> io::Result<StatInfo> {
        self.stall(path);
        self.real().stat(path)
    }

    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        self.stall(path);
        self.real().canonicalize(path)
    }

    fn read_dir(&self, path: &Path, limit: usize) -> io::Result<RawDir> {
        self.stall(path);
        self.real().read_dir(path, limit)
    }
}

/// The mount a path lives on, as far as the guard cares: `/Volumes/<name>` or the boot volume.
pub fn mount_key(path: &Path) -> String {
    let mut comps = path.components();
    let _root = comps.next();
    match (comps.next().and_then(|c| c.as_os_str().to_str()), comps.next().and_then(|c| c.as_os_str().to_str())) {
        (Some("Volumes"), Some(name)) => format!("/Volumes/{name}"),
        _ => "/".to_owned(),
    }
}

pub const MAX_ABANDONED: usize = 8;
pub const DEFAULT_DEADLINE: Duration = Duration::from_secs(3);

pub struct Guard {
    abandoned: Arc<AtomicUsize>,
    cap: usize,
    broken: Mutex<HashSet<String>>,
}

impl Default for Guard {
    fn default() -> Self {
        Self::new(MAX_ABANDONED)
    }
}

impl Guard {
    pub fn new(cap: usize) -> Self {
        Self { abandoned: Arc::new(AtomicUsize::new(0)), cap, broken: Mutex::new(HashSet::new()) }
    }

    pub fn abandoned(&self) -> usize {
        self.abandoned.load(Ordering::SeqCst)
    }

    pub fn is_broken(&self, mount: &str) -> bool {
        self.broken.lock().unwrap().contains(mount)
    }

    /// Runs `f` on a worker thread and waits at most `deadline`. `mount` is the circuit-breaker key ([`mount_key`]).
    pub fn run<T: Send + 'static>(
        &self,
        mount: &str,
        deadline: Duration,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, EngineError> {
        if self.is_broken(mount) {
            return Err(EngineError::new(codes::UNRESPONSIVE, format!("{mount} did not answer earlier and is skipped")));
        }
        if self.abandoned() >= self.cap {
            return Err(EngineError::new(codes::UNRESPONSIVE, "too many filesystem calls are stuck"));
        }
        // 0 running, 1 abandoned by the caller, 2 finished
        let state = Arc::new(AtomicU8::new(0));
        let (tx, rx) = mpsc::channel();
        let worker_state = state.clone();
        let abandoned = self.abandoned.clone();
        let spawned = std::thread::Builder::new().name("pathpick-fs".into()).spawn(move || {
            let out = f();
            let _ = tx.send(out);
            if worker_state.swap(2, Ordering::SeqCst) == 1 {
                abandoned.fetch_sub(1, Ordering::SeqCst);
            }
        });
        if spawned.is_err() {
            return Err(EngineError::new(codes::IO, "could not start a worker thread"));
        }
        match rx.recv_timeout(deadline) {
            Ok(v) => Ok(v),
            Err(_) => {
                if state.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                    self.abandoned.fetch_add(1, Ordering::SeqCst);
                    self.broken.lock().unwrap().insert(mount.to_owned());
                    Err(EngineError::new(codes::UNRESPONSIVE, format!("{mount} did not answer in time")))
                } else {
                    rx.recv().map_err(|_| EngineError::new(codes::IO, "worker thread failed"))
                }
            }
        }
    }
}
