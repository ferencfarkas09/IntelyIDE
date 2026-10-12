//! The few places where Unix and Windows differ for a child process or a file: file modes, advisory locks, process
//! groups, signals. Everything is a no-op or the closest Windows equivalent there, so callers stay free of `cfg`.
//! On Windows a "process group" is the process tree of the leader (`taskkill /T`).

use std::fs::{DirBuilder, File, OpenOptions};
use std::io;
use std::path::Path;

/// Process and process-group ids (`libc::pid_t` does not exist on Windows).
pub type Pid = i32;

/// `mode` for files created through `options` (ignored on Windows, where ACLs inherit from the parent directory).
pub fn open_mode(options: &mut OpenOptions, mode: u32) -> &mut OpenOptions {
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(options, mode);
    #[cfg(not(unix))]
    let _ = mode;
    options
}

/// `mode` for directories created through `builder` (ignored on Windows).
pub fn dir_mode(builder: &mut DirBuilder, mode: u32) -> &mut DirBuilder {
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(builder, mode);
    #[cfg(not(unix))]
    let _ = mode;
    builder
}

/// `chmod` that ignores failures; a no-op on Windows.
pub fn set_mode_best_effort(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
}

/// The file may be executed: an execute bit on Unix; on Windows the extension decides.
pub fn is_executable(meta: &std::fs::Metadata, path: &Path) -> bool {
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        let _ = path;
        std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
        matches!(ext.as_deref(), Some("exe" | "cmd" | "bat" | "com"))
    }
}

/// Takes an exclusive advisory lock without waiting. `Ok(false)` when somebody else holds it.
pub fn try_lock_exclusive(file: &File) -> io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // SAFETY: plain syscall on a descriptor we own.
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc == 0 {
            return Ok(true);
        }
        let err = io::Error::last_os_error();
        if err.kind() == io::ErrorKind::WouldBlock || err.raw_os_error() == Some(libc::EWOULDBLOCK) || err.raw_os_error() == Some(libc::EAGAIN) {
            Ok(false)
        } else {
            Err(err)
        }
    }
    #[cfg(not(unix))]
    {
        match file.try_lock() {
            Ok(()) => Ok(true),
            Err(std::fs::TryLockError::WouldBlock) => Ok(false),
            Err(std::fs::TryLockError::Error(e)) => Err(e),
        }
    }
}

/// Puts the child in a process group of its own (Unix) or hides its console window (Windows), so a GUI app never
/// flashes a terminal and a whole tree can be ended later with [`kill_group`].
pub trait NewGroup {
    fn new_group(&mut self) -> &mut Self;
}

#[cfg(unix)]
impl NewGroup for tokio::process::Command {
    fn new_group(&mut self) -> &mut Self {
        self.process_group(0)
    }
}

#[cfg(unix)]
impl NewGroup for std::process::Command {
    fn new_group(&mut self) -> &mut Self {
        std::os::unix::process::CommandExt::process_group(self, 0)
    }
}

/// `CREATE_NO_WINDOW`.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
impl NewGroup for tokio::process::Command {
    fn new_group(&mut self) -> &mut Self {
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(windows)]
impl NewGroup for std::process::Command {
    fn new_group(&mut self) -> &mut Self {
        std::os::windows::process::CommandExt::creation_flags(self, CREATE_NO_WINDOW)
    }
}

/// Hides the console window of a child on Windows; does nothing elsewhere.
pub fn no_window<C: NewGroup>(cmd: &mut C) -> &mut C {
    #[cfg(windows)]
    cmd.new_group();
    #[cfg(not(windows))]
    let _ = &cmd;
    cmd
}

/// The group the process leads.
pub fn own_pgid() -> Pid {
    #[cfg(unix)]
    {
        unsafe { libc::getpgrp() }
    }
    #[cfg(not(unix))]
    {
        std::process::id() as Pid
    }
}

/// Ends the group (Unix: SIGKILL, or SIGTERM when `!kill`; Windows: `taskkill /T`, with `/F` when `kill`).
/// Refuses pid/group 0 and 1 and the group of this process.
pub fn kill_group(pgid: Pid, kill: bool) {
    if pgid <= 1 || pgid == own_pgid() {
        return;
    }
    #[cfg(unix)]
    {
        // SAFETY: plain syscall on a group created by the caller.
        unsafe { libc::killpg(pgid, if kill { libc::SIGKILL } else { libc::SIGTERM }) };
    }
    #[cfg(not(unix))]
    {
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/PID", &pgid.to_string(), "/T"]);
        if kill {
            cmd.arg("/F");
        }
        let _ = no_window(&mut cmd).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
    }
}

/// The process exists (a process of another user counts as existing).
pub fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only probes for existence.
        let rc = unsafe { libc::kill(pid as i32, 0) };
        rc == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        let mut cmd = std::process::Command::new("tasklist");
        cmd.args(["/FI", &format!("PID eq {pid}"), "/NH"]);
        no_window(&mut cmd).output().is_ok_and(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().any(|w| w == pid.to_string()))
    }
}

/// The user's home directory: `HOME`, or `USERPROFILE` on Windows.
pub fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).filter(|h| !h.is_empty()).map(Into::into)
}

/// Where the IDE keeps its data below `home`: `Library/Application Support/IntelySwitchIDE` (macOS),
/// `.local/share/IntelySwitchIDE` (Linux), `AppData/Roaming/IntelySwitchIDE` (Windows).
pub fn data_dir_under(home: &Path) -> std::path::PathBuf {
    let rel = if cfg!(target_os = "macos") {
        "Library/Application Support/IntelySwitchIDE"
    } else if cfg!(windows) {
        "AppData/Roaming/IntelySwitchIDE"
    } else {
        ".local/share/IntelySwitchIDE"
    };
    home.join(rel)
}

/// [`data_dir_under`] the home directory of the user.
pub fn data_dir() -> Option<std::path::PathBuf> {
    home_dir().map(|h| data_dir_under(&h))
}

/// `(device, inode, owner uid)` of a file; zeros on Windows, where std has no stable equivalent.
pub fn file_ids(md: &std::fs::Metadata) -> (u64, u64, u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (md.dev(), md.ino(), md.uid())
    }
    #[cfg(not(unix))]
    {
        let _ = md;
        (0, 0, 0)
    }
}

/// The effective user id (0 on Windows).
pub fn euid() -> u32 {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions.
        unsafe { libc::geteuid() as u32 }
    }
    #[cfg(not(unix))]
    {
        0
    }
}

/// Opens `path` for reading without blocking on a FIFO and without following a symlink at the last component (Unix flags
/// `O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC`). Windows has no such flags: a symlink is refused up front instead.
pub fn open_read_nofollow(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    #[cfg(not(unix))]
    if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a regular file"));
    }
    options.open(path)
}

/// `node` on Unix; `node.exe` and the shell shims (`.cmd`, `.bat`) of Windows.
pub fn executable_names(bin: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![format!("{bin}.exe"), format!("{bin}.cmd"), format!("{bin}.bat")]
    } else {
        vec![bin.to_owned()]
    }
}

/// `command -v <bin>` against an explicit `PATH` string (split with the separator of the OS).
pub fn find_in_path(path: &str, bin: &str) -> Option<std::path::PathBuf> {
    std::env::split_paths(path)
        .filter(|d| !d.as_os_str().is_empty())
        .flat_map(|d| executable_names(bin).into_iter().map(move |n| d.join(n)))
        .find(|p| p.metadata().is_ok_and(|m| is_executable(&m, p)))
}

/// SIGHUP to the whole group, like a closing terminal window; on Windows the tree is asked to close (`taskkill /T`).
pub fn hangup_group(pgid: Pid) {
    if pgid <= 1 || pgid == own_pgid() {
        return;
    }
    #[cfg(unix)]
    {
        // SAFETY: plain syscall on a group created by the caller.
        unsafe { libc::killpg(pgid, libc::SIGHUP) };
    }
    #[cfg(not(unix))]
    kill_group(pgid, false);
}

/// The program to hand to `Command::new`. On Windows `CreateProcess` only appends `.exe`, so `npm` (really `npm.cmd`) would not
/// start: a bare name is looked up on `PATH` with the extensions of [`executable_names`]. Elsewhere the name is returned unchanged.
pub fn program(name: &str) -> std::ffi::OsString {
    #[cfg(windows)]
    if !name.contains(['/', '\\']) && Path::new(name).extension().is_none() {
        if let Some(found) = std::env::var("PATH").ok().and_then(|p| find_in_path(&p, name)) {
            return found.into_os_string();
        }
    }
    name.into()
}

/// Number of hard links to the file (always 1 on Windows, where std has no stable call for it).
pub fn nlink(md: &std::fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        std::os::unix::fs::MetadataExt::nlink(md)
    }
    #[cfg(not(unix))]
    {
        let _ = md;
        1
    }
}

/// Takes an exclusive advisory lock, waiting for it.
pub fn lock_exclusive(file: &File) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // SAFETY: plain syscall on a descriptor we own.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        file.lock()
    }
}

/// Releases the lock of [`lock_exclusive`] / [`try_lock_exclusive`] (closing the file does too).
pub fn unlock(file: &File) {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // SAFETY: unlocking a descriptor we own.
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    }
    #[cfg(not(unix))]
    let _ = file.unlock();
}

fn quiet(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    no_window(cmd)
}

/// Opens a URL or a file with the program the system chose for it: `open` (macOS), `explorer.exe` (Windows, which reports exit
/// status 1 even when it worked, so only the start is checked), `xdg-open` (Linux). The caller validates `target`.
pub fn open_external(target: &std::ffi::OsStr) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("/usr/bin/open");
    #[cfg(windows)]
    let mut cmd = std::process::Command::new("explorer.exe");
    #[cfg(not(any(target_os = "macos", windows)))]
    let mut cmd = std::process::Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    cmd.arg("--");
    cmd.arg(target);
    finish_open(quiet(&mut cmd))
}

/// Shows the file or folder in the file manager: selected in Finder / Explorer; on Linux (no standard way to select) its folder opens.
pub fn reveal_in_file_manager(path: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("/usr/bin/open");
        c.arg("-R").arg("--").arg(path);
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer.exe");
        let mut arg = std::ffi::OsString::from("/select,");
        arg.push(path);
        c.arg(arg);
        c
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(if path.is_dir() { path } else { path.parent().unwrap_or(path) });
        c
    };
    finish_open(quiet(&mut cmd))
}

#[cfg(windows)]
fn finish_open(cmd: &mut std::process::Command) -> io::Result<()> {
    cmd.spawn().map(drop)
}

#[cfg(not(windows))]
fn finish_open(cmd: &mut std::process::Command) -> io::Result<()> {
    if cmd.status()?.success() {
        Ok(())
    } else {
        Err(io::Error::other("the opener reported a failure"))
    }
}
