//! Crash-safe file primitives for the workspace registry ((design notes: workspaces-spec) 4.4): atomic writes, advisory
//! locks, backup rings. Nothing here knows what a workspace is.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Named crash-injection points. A test installs a function that fails at a stage; production passes `None`.
pub type Fault = Arc<dyn Fn(&str) -> io::Result<()> + Send + Sync>;

fn hit(fault: Option<&Fault>, stage: &str) -> io::Result<()> {
    match fault {
        Some(f) => f(stage),
        None => Ok(()),
    }
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Temp file in the same directory (`.<name>.<pid>.<n>.tmp`, `create_new`, `mode`), `write_all`, `sync_all`, `rename`,
/// `fsync` of the directory. A failure removes the temp file and leaves the previous file untouched.
/// Stages for fault injection: `tmp-written` (data durable, not yet renamed), `renamed` (before the directory fsync).
pub fn write_atomic(path: &Path, bytes: &[u8], mode: u32, fault: Option<&Fault>) -> io::Result<()> {
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    ensure_dir(dir)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let tmp = dir.join(format!(".{name}.{}.{}.tmp", std::process::id(), TMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
    let result = (|| {
        let mut f = OpenOptions::new().write(true).create_new(true).mode(mode).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        hit(fault, "tmp-written")?;
        std::fs::rename(&tmp, path)?;
        hit(fault, "renamed")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return result;
    }
    // Durability of the rename itself; not being able to fsync a directory is not worth failing a completed write.
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Removes the leftovers of [`write_atomic`] for `*.json` files (`.<name>.json.<pid>.<n>.tmp`) that a process killed between
/// the temp write and the rename left behind. Call it only while holding the instance lock: no writer of another process
/// can be mid-write then. Returns how many files went; every error is ignored (a leftover is only clutter).
pub fn sweep_stale_tmp(dir: &Path) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_atomic_tmp_name(&name) {
            continue;
        }
        if entry.file_type().is_ok_and(|t| t.is_file()) && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn is_atomic_tmp_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('.').and_then(|n| n.strip_suffix(".tmp")) else { return false };
    let mut parts = rest.rsplitn(3, '.');
    let (counter, pid, stem) = (parts.next(), parts.next(), parts.next());
    let digits = |s: Option<&str>| s.is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
    digits(counter) && digits(pid) && stem.is_some_and(|s| s.ends_with(".json") && s.len() > ".json".len())
}

/// `create_dir_all` with mode 0700 for every directory it creates.
pub fn ensure_dir(dir: &Path) -> io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    let mut builder = std::fs::DirBuilder::new();
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.recursive(true).create(dir)
}

/// Reads at most `cap` bytes; a bigger file is an error (a registry is a few KiB, a runaway one is not trusted).
pub fn read_capped(path: &Path, cap: u64) -> io::Result<Vec<u8>> {
    use std::io::Read;
    let f = File::open(path)?;
    let mut buf = Vec::new();
    f.take(cap + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > cap {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "file is too large"));
    }
    Ok(buf)
}

/// An advisory `flock` held until the value is dropped (or the process exits).
#[derive(Debug)]
pub struct FileLock {
    _file: File,
    pub path: PathBuf,
}

/// Creates (0600) and locks `path` exclusively without waiting. `Ok(None)` when somebody else holds it.
pub fn try_lock(path: &Path) -> io::Result<Option<FileLock>> {
    if let Some(dir) = path.parent() {
        ensure_dir(dir)?;
    }
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600).open(path)?;
    // SAFETY: plain syscall on a descriptor we own.
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        return Ok(Some(FileLock { _file: file, path: path.to_path_buf() }));
    }
    let err = io::Error::last_os_error();
    if err.kind() == io::ErrorKind::WouldBlock || err.raw_os_error() == Some(libc::EWOULDBLOCK) || err.raw_os_error() == Some(libc::EAGAIN) {
        Ok(None)
    } else {
        Err(err)
    }
}

/// [`try_lock`] polled every 10 ms for at most `wait`. `Ok(None)` on timeout.
pub fn lock_with_timeout(path: &Path, wait: Duration) -> io::Result<Option<FileLock>> {
    let start = Instant::now();
    loop {
        if let Some(l) = try_lock(path)? {
            return Ok(Some(l));
        }
        if start.elapsed() >= wait {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Retention of a backup ring: the newest `keep` plus, when `daily_days > 0`, the newest backup of each of the last
/// `daily_days` days. File names are `<prefix><unixms><suffix>` where `suffix` is `.json` or `-r<rev>.json`.
pub fn prune_backups(dir: &Path, prefix: &str, keep: usize, daily_days: u64, now_ms: i64) -> io::Result<()> {
    let mut found: Vec<(i64, PathBuf)> = Vec::new();
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(ts) = backup_timestamp(&name, prefix) {
            found.push((ts, e.path()));
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    let mut keep_set: std::collections::HashSet<PathBuf> = found.iter().take(keep).map(|(_, p)| p.clone()).collect();
    if daily_days > 0 {
        const DAY: i64 = 86_400_000;
        let today = now_ms.div_euclid(DAY);
        for d in 0..daily_days as i64 {
            if let Some((_, p)) = found.iter().find(|(ts, _)| ts.div_euclid(DAY) == today - d) {
                keep_set.insert(p.clone());
            }
        }
    }
    for (_, p) in &found {
        if !keep_set.contains(p) {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(())
}

/// The `unixms` of `<prefix><unixms>...`; `None` when the name does not belong to the ring.
pub fn backup_timestamp(name: &str, prefix: &str) -> Option<i64> {
    let rest = name.strip_prefix(prefix)?;
    if !rest.ends_with(".json") {
        return None;
    }
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// Copies `src` into `dir/<prefix><now>[-r<rev>].json` atomically (0600), then prunes the ring.
pub fn rotate_backup(src: &Path, dir: &Path, prefix: &str, rev_tag: Option<u64>, keep: usize, daily_days: u64, now_ms: i64) -> io::Result<PathBuf> {
    let bytes = std::fs::read(src)?;
    let name = match rev_tag {
        Some(r) => format!("{prefix}{now_ms}-r{r}.json"),
        None => format!("{prefix}{now_ms}.json"),
    };
    let dest = dir.join(name);
    write_atomic(&dest, &bytes, 0o600, None)?;
    prune_backups(dir, prefix, keep, daily_days, now_ms)?;
    Ok(dest)
}

/// `chmod` that ignores failures on exotic filesystems.
pub fn set_mode_best_effort(path: &Path, mode: u32) {
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn write_atomic_replaces_and_leaves_no_temp() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("sub/x.json");
        write_atomic(&p, b"one", 0o600, None).unwrap();
        write_atomic(&p, b"two", 0o600, None).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two");
        assert_eq!(names(&d.path().join("sub")), vec!["x.json"]);
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(d.path().join("sub")).unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[test]
    fn a_fault_after_the_temp_write_keeps_the_old_file_and_removes_the_temp() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("x.json");
        write_atomic(&p, b"old", 0o600, None).unwrap();
        let fault: Fault = Arc::new(|stage| if stage == "tmp-written" { Err(io::Error::other("injected")) } else { Ok(()) });
        assert!(write_atomic(&p, b"new", 0o600, Some(&fault)).is_err());
        assert_eq!(std::fs::read(&p).unwrap(), b"old");
        assert_eq!(names(d.path()), vec!["x.json"]);
    }

    #[test]
    fn flock_is_exclusive_between_open_file_descriptions() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(".lock");
        let first = try_lock(&p).unwrap().expect("first lock");
        assert!(try_lock(&p).unwrap().is_none());
        assert!(lock_with_timeout(&p, Duration::from_millis(60)).unwrap().is_none());
        drop(first);
        assert!(try_lock(&p).unwrap().is_some());
    }

    #[test]
    fn prune_keeps_newest_plus_one_per_recent_day() {
        let d = tempfile::tempdir().unwrap();
        const DAY: i64 = 86_400_000;
        let now = 100 * DAY + 5_000;
        // three backups today, two yesterday, one 10 days ago
        for ts in [now - 3, now - 2, now - 1, now - DAY, now - DAY - 7, now - 10 * DAY] {
            std::fs::write(d.path().join(format!("workspaces.{ts}-r1.json")), b"{}").unwrap();
        }
        std::fs::write(d.path().join("other.json"), b"{}").unwrap();
        prune_backups(d.path(), "workspaces.", 2, 7, now).unwrap();
        let left = names(d.path());
        assert!(left.contains(&format!("workspaces.{}-r1.json", now - 1)));
        assert!(left.contains(&format!("workspaces.{}-r1.json", now - 2)));
        assert!(left.contains(&format!("workspaces.{}-r1.json", now - DAY)), "newest of yesterday kept: {left:?}");
        assert!(!left.contains(&format!("workspaces.{}-r1.json", now - 3)));
        assert!(!left.contains(&format!("workspaces.{}-r1.json", now - DAY - 7)));
        assert!(!left.contains(&format!("workspaces.{}-r1.json", now - 10 * DAY)));
        assert!(left.contains(&"other.json".to_owned()), "foreign files are never touched");
    }

    #[test]
    fn sweep_removes_only_the_temp_files_of_atomic_json_writes() {
        let d = tempfile::tempdir().unwrap();
        for stale in [".workspaces.json.4242.7.tmp", ".ws-a.json.1.0.tmp"] {
            std::fs::write(d.path().join(stale), b"{}").unwrap();
        }
        for keep in ["workspaces.json", ".workspaces.lock", ".settings.4242.7.tmp", ".json.1.2.tmp", ".x.json.a.2.tmp", "notes.tmp", ".workspaces.json.4242.tmp"] {
            std::fs::write(d.path().join(keep), b"x").unwrap();
        }
        std::fs::create_dir(d.path().join(".dir.json.1.2.tmp")).unwrap();
        assert_eq!(sweep_stale_tmp(d.path()), 2);
        let left = names(d.path());
        assert!(!left.iter().any(|n| n.starts_with(".workspaces.json.4242.7") || n.starts_with(".ws-a")), "{left:?}");
        assert_eq!(left.len(), 8, "{left:?}");
        assert_eq!(sweep_stale_tmp(&d.path().join("missing")), 0);
    }

    #[test]
    fn backup_names_parse() {
        assert_eq!(backup_timestamp("workspaces.123-r4.json", "workspaces."), Some(123));
        assert_eq!(backup_timestamp("workspaces.123.json", "workspaces."), Some(123));
        assert_eq!(backup_timestamp("ws-a.123.json", "workspaces."), None);
        assert_eq!(backup_timestamp("workspaces.x.json", "workspaces."), None);
        assert_eq!(backup_timestamp("workspaces.123.tmp", "workspaces."), None);
    }
}
