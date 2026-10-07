//! The orphan pid file and the sweep (T4c).
//!
//! Every tunnel records `{pid, start_time, owner_pid, owner_start, dir}` in `<state>/mongo-ssh.pids` (0600) while its
//! master runs, and removes the line when it closes. If the app dies without closing (SIGKILL, crash, power loss) the
//! lines stay; the first tunnel open of the next process sweeps them.
//!
//! A line is acted on only when its **owner app process is dead** (pid gone, or a different start time), so a second
//! running IDE keeps its tunnels. The line is hostile input (the file is writable by anything running as the user), so
//! before any removal the recorded `dir` must equal `<temp dir>/intely-ssh-<uid>-<16 hex>`, be owned by this user, not be
//! a symlink and have mode 0700; a line failing any check is dropped without touching the disk. Only the known files
//! (`c`, `askpass`, `s`) are unlinked and the directory `rmdir`ed (never `remove_dir_all`). The ssh process is signalled
//! only when `/bin/ps -o command= -p <pid>` (absolute path) contains its own `-S <dir>/c`.
//!
//! Nothing here runs under `INTELY_READONLY`.

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::dir::{current_uid, is_private_dir, remove_known, valid_dir_name};
use super::ssh::{tcode, tunnel_error, CommandRunner, RunRequest, SystemRunner};
use crate::error::{code, Result, StudioError};
use crate::jail::{Jail, NetworkPolicy};

pub const PID_FILE: &str = "mongo-ssh.pids";

/// The only program used to look at other processes: an absolute path, no `PATH` search.
pub const PS: &str = "/bin/ps";

/// At most this many lines are read or kept (a hostile file cannot make the sweep walk forever).
pub const MAX_ENTRIES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PidEntry {
    /// The ssh master.
    pub pid: u32,
    pub start_time: String,
    /// The app process that owns the tunnel.
    pub owner_pid: u32,
    pub owner_start: String,
    pub dir: String,
}

/// The view of other processes the sweep needs. The real one runs `/bin/ps`; tests use a fake table.
pub trait ProcessTable: Send + Sync {
    /// The start time of `pid` (an opaque string that is stable for the process lifetime), `None` when it is not running.
    fn start_time(&self, pid: u32) -> Option<String>;
    /// The full command line of `pid`.
    fn command(&self, pid: u32) -> Option<String>;
    /// SIGTERM. Never called for pid 0 or 1.
    fn terminate(&self, pid: u32);
}

pub struct SystemProcs;

fn ps(args: &[&str]) -> Option<String> {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let env = vec![("LANG".to_string(), "C".to_string()), ("LC_ALL".to_string(), "C".to_string()), ("PATH".to_string(), "/usr/bin:/bin".to_string())];
    let out = SystemRunner.run(&RunRequest { program: Path::new(PS), args: &args, env: &env, stdin: None, timeout: Duration::from_secs(3) }).ok()?;
    if out.code != Some(0) || out.timed_out {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

impl ProcessTable for SystemProcs {
    fn start_time(&self, pid: u32) -> Option<String> {
        ps(&["-o", "lstart=", "-p", &pid.to_string()])
    }

    fn command(&self, pid: u32) -> Option<String> {
        ps(&["-o", "command=", "-p", &pid.to_string()])
    }

    #[cfg(unix)]
    fn terminate(&self, pid: u32) {
        if pid > 1 {
            // SAFETY: plain kill(2) on a pid we just validated; a recycled pid is excluded by the start-time and command checks.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
    }

    #[cfg(not(unix))]
    fn terminate(&self, _pid: u32) {}
}

pub fn pid_path(state_dir: &Path) -> PathBuf {
    state_dir.join(PID_FILE)
}

fn parse(text: &str) -> Vec<PidEntry> {
    text.lines().take(MAX_ENTRIES * 2).filter_map(|l| serde_json::from_str::<PidEntry>(l.trim()).ok()).take(MAX_ENTRIES).collect()
}

fn render(entries: &[PidEntry]) -> String {
    entries.iter().filter_map(|e| serde_json::to_string(e).ok()).map(|l| l + "\n").collect()
}

/// Reads the entries without taking the lock (tests, diagnostics). A missing or unreadable file has no entries.
pub fn read_entries(state_dir: &Path) -> Vec<PidEntry> {
    std::fs::read_to_string(pid_path(state_dir)).map(|t| parse(&t)).unwrap_or_default()
}

/// Opens the pid file (created 0600, never through a symlink), takes an exclusive `flock`, hands the parsed entries to `f`
/// and writes them back in place. The write is jail-gated.
#[cfg(unix)]
fn edit<T>(jail: &Jail, state_dir: &Path, f: impl FnOnce(&mut Vec<PidEntry>) -> T) -> Result<T> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    let path = pid_path(state_dir);
    jail.check_write(&path)?;
    let fail = |m: &str| tunnel_error(tcode::CONFIG, m);
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|_| fail("the tunnel pid file could not be opened"))?;
    if !file.metadata().map(|m| m.is_file()).unwrap_or(false) {
        return Err(fail("the tunnel pid file is not a regular file"));
    }
    // SAFETY: the descriptor is open for the duration of the call; the lock is released when `file` is dropped.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(fail("the tunnel pid file could not be locked"));
    }
    let mut text = String::new();
    // a file we cannot read as text is treated as empty and overwritten
    let _ = (&mut file).take(1024 * 1024).read_to_string(&mut text);
    let mut entries = parse(&text);
    let out = f(&mut entries);
    let body = render(&entries);
    file.set_len(0).map_err(|_| fail("the tunnel pid file could not be written"))?;
    file.seek(SeekFrom::Start(0)).map_err(|_| fail("the tunnel pid file could not be written"))?;
    file.write_all(body.as_bytes()).map_err(|_| fail("the tunnel pid file could not be written"))?;
    Ok(out)
}

#[cfg(not(unix))]
fn edit<T>(_jail: &Jail, _state_dir: &Path, _f: impl FnOnce(&mut Vec<PidEntry>) -> T) -> Result<T> {
    Err(tunnel_error(tcode::NO_SSH, "SSH tunnels are not available on this system"))
}

/// Records a running tunnel. Refused under `INTELY_READONLY` (no tunnel can be open there anyway).
pub fn add_entry(jail: &Jail, state_dir: &Path, entry: PidEntry) -> Result<()> {
    if jail.policy() == NetworkPolicy::Refused {
        return Err(StudioError::new(code::READ_ONLY_JAIL, "the read-only jail refuses writes"));
    }
    edit(jail, state_dir, |v| {
        v.retain(|e| e.dir != entry.dir);
        if v.len() < MAX_ENTRIES {
            v.push(entry);
        }
    })
}

/// Forgets the tunnel that lived in `dir`. The file stays (empty) so a concurrent opener never loses a line.
pub fn remove_entry(jail: &Jail, state_dir: &Path, dir: &Path) -> Result<()> {
    if !pid_path(state_dir).exists() {
        return Ok(());
    }
    let dir = dir.to_string_lossy().into_owned();
    edit(jail, state_dir, |v| v.retain(|e| e.dir != dir))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SweepReport {
    /// Directories removed (their owner was dead).
    pub swept: usize,
    /// Master processes signalled.
    pub terminated: usize,
    /// Lines dropped without touching the disk (bad directory).
    pub dropped: usize,
    /// Lines kept because their owner app is still running.
    pub kept: usize,
}

fn canonical_lenient(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

/// Does `dir` have the exact shape and state the sweep may act on? `temp_dirs` are the bases a tunnel directory can be
/// created in (the temp directory, and `/tmp` for the short-path fallback).
pub fn dir_is_ours(dir: &Path, temp_dirs: &[PathBuf], uid: u32) -> bool {
    if !dir.is_absolute() || dir.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir)) {
        return false;
    }
    let Some(name) = dir.file_name().and_then(|n| n.to_str()) else { return false };
    if !valid_dir_name(name, uid) {
        return false;
    }
    let Some(parent) = dir.parent() else { return false };
    // the parent is compared as written and canonically (macOS: /var -> /private/var); the directory itself must not be a link
    let parent_ok = temp_dirs.iter().any(|t| t.as_path() == parent || canonical_lenient(t) == canonical_lenient(parent));
    parent_ok && is_private_dir(dir, uid)
}

/// The sweep. `temp_dirs` as for [`dir_is_ours`]. Does nothing (and starts no process) under the read-only jail.
pub fn sweep(jail: &Jail, state_dir: &Path, temp_dirs: &[PathBuf], procs: &dyn ProcessTable, uid: u32) -> SweepReport {
    let mut report = SweepReport::default();
    if jail.policy() == NetworkPolicy::Refused || !pid_path(state_dir).exists() {
        return report;
    }
    let edited = edit(jail, state_dir, |entries| {
        let mut keep: Vec<PidEntry> = Vec::new();
        for e in entries.drain(..) {
            let owner_alive = procs.start_time(e.owner_pid).is_some_and(|s| s == e.owner_start);
            if owner_alive {
                report.kept += 1;
                keep.push(e);
                continue;
            }
            let dir = PathBuf::from(&e.dir);
            if !dir_is_ours(&dir, temp_dirs, uid) {
                report.dropped += 1;
                continue;
            }
            let control = dir.join("c");
            let wanted = format!("-S {}", control.display());
            let same_process = procs.start_time(e.pid).is_some_and(|s| s == e.start_time) && procs.command(e.pid).is_some_and(|c| c.contains(&wanted));
            if same_process && e.pid > 1 {
                procs.terminate(e.pid);
                report.terminated += 1;
            }
            remove_known(&dir);
            report.swept += 1;
        }
        *entries = keep;
    });
    if edited.is_err() {
        return SweepReport::default();
    }
    report
}

/// Sweeps once per process and state directory: called by the first tunnel open.
pub fn sweep_once(jail: &Jail, state_dir: &Path, temp_dirs: &[PathBuf], procs: &dyn ProcessTable) -> Option<SweepReport> {
    static DONE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    let done = DONE.get_or_init(|| Mutex::new(HashSet::new()));
    {
        let mut set = done.lock().unwrap_or_else(|e| e.into_inner());
        if !set.insert(state_dir.to_path_buf()) {
            return None;
        }
    }
    Some(sweep(jail, state_dir, temp_dirs, procs, current_uid()))
}
