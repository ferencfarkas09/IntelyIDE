//! Filesystem access of the registry behind a trait, so hung volumes can be simulated and never block a caller
//! ((design notes: workspaces-spec) 4.5, T15). Every call that may touch a user's repository folder runs through [`Prober`]:
//! on its own thread, with a deadline, an abandoned-thread cap and a per-mount circuit breaker.

use std::collections::{HashMap, HashSet};
use std::io;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

/// Abandoned (timed out and still running) probe threads allowed at the same time.
pub const MAX_ABANDONED: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsKind {
    Dir,
    File,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FsStat {
    pub kind: FsKind,
    pub dev: u64,
    pub ino: u64,
    pub uid: u32,
}

impl FsStat {
    /// `"{dev}:{ino}"`, the identity string of a directory.
    pub fn identity(&self) -> String {
        format!("{}:{}", self.dev, self.ino)
    }
}

/// The few filesystem operations the registry needs.
pub trait FsProbe: Send + Sync {
    /// `lstat`.
    fn stat(&self, path: &Path) -> io::Result<FsStat>;
    /// `stat` (follows symlinks).
    fn stat_follow(&self, path: &Path) -> io::Result<FsStat>;
    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf>;
    /// Safe-open read of a small regular file: `O_NONBLOCK | O_NOFOLLOW`, regular files only, at most `cap` bytes
    /// (a FIFO, a device or a symlink is an error, never a hang).
    fn read_small(&self, path: &Path, cap: usize) -> io::Result<Vec<u8>>;
}

fn to_stat(m: &std::fs::Metadata) -> FsStat {
    let ft = m.file_type();
    let kind = if ft.is_symlink() {
        FsKind::Symlink
    } else if ft.is_dir() {
        FsKind::Dir
    } else if ft.is_file() {
        FsKind::File
    } else {
        FsKind::Other
    };
    FsStat { kind, dev: m.dev(), ino: m.ino(), uid: m.uid() }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct RealFs;

impl FsProbe for RealFs {
    fn stat(&self, path: &Path) -> io::Result<FsStat> {
        std::fs::symlink_metadata(path).map(|m| to_stat(&m))
    }

    fn stat_follow(&self, path: &Path) -> io::Result<FsStat> {
        std::fs::metadata(path).map(|m| to_stat(&m))
    }

    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        std::fs::canonicalize(path)
    }

    fn read_small(&self, path: &Path, cap: usize) -> io::Result<Vec<u8>> {
        use std::io::Read;
        let file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path)?;
        if !file.metadata()?.is_file() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a regular file"));
        }
        let mut buf = Vec::new();
        file.take(cap as u64).read_to_end(&mut buf)?;
        Ok(buf)
    }
}

/// How a [`FakeFs`] treats paths below a prefix.
#[derive(Clone)]
pub enum FakeBehavior {
    /// Every call sleeps this long first (a slow volume).
    Sleep(Duration),
    /// Every call blocks until [`FakeFs::release`] (a hung volume).
    Hang,
    /// Every call fails with this kind.
    Fail(io::ErrorKind),
}

/// [`RealFs`] with scripted misbehaviour per path prefix.
#[derive(Default)]
pub struct FakeFs {
    rules: Mutex<Vec<(PathBuf, FakeBehavior)>>,
    gate: Arc<(Mutex<bool>, std::sync::Condvar)>,
    pub calls: AtomicUsize,
}

impl FakeFs {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn on(&self, prefix: impl Into<PathBuf>, behavior: FakeBehavior) {
        self.rules.lock().expect("fake fs rules").push((prefix.into(), behavior));
    }

    /// Lets every hanging call return.
    pub fn release(&self) {
        let (m, cv) = &*self.gate;
        *m.lock().expect("fake fs gate") = true;
        cv.notify_all();
    }

    fn apply(&self, path: &Path) -> io::Result<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let rule = self.rules.lock().expect("fake fs rules").iter().find(|(p, _)| path.starts_with(p)).map(|(_, b)| b.clone());
        match rule {
            None => Ok(()),
            Some(FakeBehavior::Sleep(d)) => {
                std::thread::sleep(d);
                Ok(())
            }
            Some(FakeBehavior::Fail(kind)) => Err(io::Error::new(kind, "injected")),
            Some(FakeBehavior::Hang) => {
                let (m, cv) = &*self.gate;
                let mut released = m.lock().expect("fake fs gate");
                while !*released {
                    released = cv.wait(released).expect("fake fs gate");
                }
                Ok(())
            }
        }
    }
}

impl FsProbe for FakeFs {
    fn stat(&self, path: &Path) -> io::Result<FsStat> {
        self.apply(path)?;
        RealFs.stat(path)
    }
    fn stat_follow(&self, path: &Path) -> io::Result<FsStat> {
        self.apply(path)?;
        RealFs.stat_follow(path)
    }
    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        self.apply(path)?;
        RealFs.canonicalize(path)
    }
    fn read_small(&self, path: &Path, cap: usize) -> io::Result<Vec<u8>> {
        self.apply(path)?;
        RealFs.read_small(path, cap)
    }
}

/// The unit a hung call trips the breaker for: `/Volumes/<name>` for an external volume (every repo on it is skipped
/// afterwards), otherwise the path itself (a hung automount or network folder elsewhere must not poison unrelated repos).
pub fn mount_key(path: &Path) -> String {
    let mut comps = path.components();
    let (a, b, c) = (comps.next(), comps.next(), comps.next());
    match (a, b, c) {
        (Some(_), Some(std::path::Component::Normal(v)), Some(std::path::Component::Normal(name))) if v == "Volumes" => {
            format!("/Volumes/{}", name.to_string_lossy())
        }
        _ => path.to_string_lossy().into_owned(),
    }
}

/// A probe that did not answer in time (or was refused up front).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unresponsive;

/// Runs filesystem work with a deadline.
pub struct Prober {
    fs: Arc<dyn FsProbe>,
    abandoned: Arc<AtomicUsize>,
    tripped: Mutex<HashSet<String>>,
}

impl Prober {
    pub fn new(fs: Arc<dyn FsProbe>) -> Self {
        Self { fs, abandoned: Arc::new(AtomicUsize::new(0)), tripped: Mutex::new(HashSet::new()) }
    }

    pub fn fs(&self) -> &Arc<dyn FsProbe> {
        &self.fs
    }

    /// Threads that timed out and have not returned yet.
    pub fn abandoned(&self) -> usize {
        self.abandoned.load(Ordering::SeqCst)
    }

    pub fn is_tripped(&self, mount: &str) -> bool {
        self.tripped.lock().expect("breaker").contains(mount)
    }

    /// Runs `f` on a fresh thread and waits at most `timeout`. A timeout trips the breaker of `mount` for the rest of
    /// the session; a tripped mount, or too many abandoned threads, is refused without spawning anything.
    pub fn run<T: Send + 'static>(&self, mount: &str, timeout: Duration, f: impl FnOnce(&dyn FsProbe) -> T + Send + 'static) -> Result<T, Unresponsive> {
        if self.is_tripped(mount) || self.abandoned.load(Ordering::SeqCst) >= MAX_ABANDONED {
            return Err(Unresponsive);
        }
        let (tx, rx) = mpsc::channel();
        let state = Arc::new(AtomicU8::new(0)); // 0 running, 1 abandoned, 2 finished
        let (fs, abandoned, st) = (self.fs.clone(), self.abandoned.clone(), state.clone());
        let spawned = std::thread::Builder::new().name("intely-fs-probe".into()).spawn(move || {
            let out = f(&*fs);
            let _ = tx.send(out);
            if st.swap(2, Ordering::SeqCst) == 1 {
                abandoned.fetch_sub(1, Ordering::SeqCst);
            }
        });
        if spawned.is_err() {
            return Err(Unresponsive);
        }
        match rx.recv_timeout(timeout) {
            Ok(v) => Ok(v),
            Err(_) => {
                if state.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                    self.abandoned.fetch_add(1, Ordering::SeqCst);
                    self.tripped.lock().expect("breaker").insert(mount.to_owned());
                    Err(Unresponsive)
                } else {
                    // finished right at the deadline
                    rx.try_recv().map_err(|_| Unresponsive)
                }
            }
        }
    }

    /// `"{dev}:{ino}"` of the directory at `path` (following symlinks), `None` if it cannot be read in time.
    pub fn identity(&self, path: &Path, timeout: Duration) -> Option<String> {
        let (p, mount) = (path.to_path_buf(), mount_key(path));
        self.run(&mount, timeout, move |fs| fs.stat_follow(&p).ok().map(|s| s.identity())).ok().flatten()
    }
}

/// Folds a path into a comparison key: NFC, lower-cased (HFS+/APFS are case-insensitive by default).
pub fn path_key(path: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    path.nfc().collect::<String>().to_lowercase()
}

/// Identity keys of a set of paths computed once: identity string when readable, else the folded path.
#[derive(Default)]
pub struct IdentityCache {
    map: HashMap<String, Vec<String>>,
}

impl IdentityCache {
    pub fn keys(&mut self, prober: &Prober, path: &str, timeout: Duration) -> Vec<String> {
        self.map
            .entry(path.to_owned())
            .or_insert_with(|| {
                let mut keys = vec![format!("p:{}", path_key(path))];
                if let Some(id) = prober.identity(Path::new(path), timeout) {
                    keys.push(format!("i:{id}"));
                }
                keys
            })
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_small_refuses_fifos_and_symlinks_without_hanging() {
        let d = tempfile::tempdir().unwrap();
        let fifo = d.path().join("HEAD");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let t = std::time::Instant::now();
        assert!(RealFs.read_small(&fifo, 4096).is_err());
        let link = d.path().join("config");
        std::os::unix::fs::symlink("/dev/zero", &link).unwrap();
        assert!(RealFs.read_small(&link, 4096).is_err());
        assert!(t.elapsed() < Duration::from_secs(1));
        let ok = d.path().join("ok");
        std::fs::write(&ok, vec![b'x'; 10_000]).unwrap();
        assert_eq!(RealFs.read_small(&ok, 4096).unwrap().len(), 4096);
    }

    #[test]
    fn a_hanging_call_is_abandoned_within_the_deadline_and_trips_the_mount() {
        let fake = FakeFs::new();
        let d = tempfile::tempdir().unwrap();
        fake.on(d.path(), FakeBehavior::Hang);
        let prober = Prober::new(fake.clone());
        let p = d.path().to_path_buf();
        let t = std::time::Instant::now();
        let r = prober.run("/Volumes/x", Duration::from_millis(80), move |fs| fs.stat(&p).is_ok());
        assert_eq!(r, Err(Unresponsive));
        assert!(t.elapsed() < Duration::from_secs(1));
        assert_eq!(prober.abandoned(), 1);
        assert!(prober.is_tripped("/Volumes/x"));
        // the breaker refuses the mount without spawning
        let calls = fake.calls.load(Ordering::SeqCst);
        assert_eq!(prober.run("/Volumes/x", Duration::from_millis(80), |_| 1), Err(Unresponsive));
        assert_eq!(fake.calls.load(Ordering::SeqCst), calls);
        // other mounts still work
        assert_eq!(prober.run("/", Duration::from_secs(1), |_| 7), Ok(7));
        // releasing lets the abandoned thread finish and the counter drop
        fake.release();
        for _ in 0..100 {
            if prober.abandoned() == 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(prober.abandoned(), 0);
    }

    #[test]
    fn the_abandoned_thread_cap_stops_spawning() {
        let fake = FakeFs::new();
        let d = tempfile::tempdir().unwrap();
        fake.on(d.path(), FakeBehavior::Hang);
        let prober = Prober::new(fake.clone());
        for i in 0..MAX_ABANDONED {
            let p = d.path().to_path_buf();
            let mount = format!("/Volumes/m{i}");
            assert_eq!(prober.run(&mount, Duration::from_millis(20), move |fs| fs.stat(&p).is_ok()), Err(Unresponsive));
        }
        assert_eq!(prober.abandoned(), MAX_ABANDONED);
        let calls = fake.calls.load(Ordering::SeqCst);
        assert_eq!(prober.run("/", Duration::from_millis(20), |_| 1), Err(Unresponsive), "cap reached: nothing new is spawned");
        assert_eq!(fake.calls.load(Ordering::SeqCst), calls);
        fake.release();
    }

    #[test]
    fn mounts_are_keyed_by_volume() {
        assert_eq!(mount_key(Path::new("/Volumes/Backup/repo")), "/Volumes/Backup");
        assert_eq!(mount_key(Path::new("/Users/x/repo")), "/Users/x/repo");
        assert_eq!(mount_key(Path::new("/Volumes")), "/Volumes");
    }

    #[test]
    fn path_keys_fold_unicode_forms_and_case() {
        assert_eq!(path_key("/tmp/Caf\u{e9}"), path_key("/tmp/cafe\u{301}"));
    }
}
