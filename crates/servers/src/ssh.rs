//! The system `ssh` binary: argument vectors, one-shot execution with a wall-clock timeout, tar upload, error classes.
//!
//! No secrets pass through here. Authentication is the user's key or agent (`BatchMode=yes` forbids prompts), so
//! stderr is returned as it is (capped).

use crate::cfg::{validate_remote_path, ServerCfg};
use crate::quote::sh_quote_path_for_remote;
use serde::Serialize;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use std::os::unix::process::CommandExt;

/// Output cap per stream (stdout and stderr each).
pub const OUTPUT_CAP: usize = 1024 * 1024;
/// Longest stderr tail kept in an error.
pub const TAIL_MAX: usize = 2048;

/// How to start `ssh`.
#[derive(Debug, Clone)]
pub struct Ssh {
    /// The ssh executable (`ssh`, or `$INTELY_SSH_BIN`).
    pub bin: PathBuf,
    /// Directory of the control sockets, made by [`private_control_dir`] (a folder of this user that nobody else can enter). Empty =
    /// no sharing of connections: every call opens its own.
    ///
    /// Unix socket paths are limited to about 100 bytes and `%C` is 40 chars plus a temporary suffix of 17, so keep
    /// this path short (for example `/tmp/intely-ssh-501`); see [`Ssh::control_path_fits`].
    pub control_dir: PathBuf,
}

impl Ssh {
    /// `bin` = `$INTELY_SSH_BIN` when set and not empty, else `ssh`.
    pub fn from_env(control_dir: impl Into<PathBuf>) -> Self {
        Self::from_bin(std::env::var_os("INTELY_SSH_BIN"), control_dir)
    }

    /// Same as [`Ssh::from_env`] with the variable passed in (testable without touching the process env).
    pub fn from_bin(bin: Option<OsString>, control_dir: impl Into<PathBuf>) -> Self {
        let bin = match bin {
            Some(b) if !b.is_empty() => PathBuf::from(b),
            _ => PathBuf::from("ssh"),
        };
        Self { bin, control_dir: control_dir.into() }
    }

    /// True when `<control_dir>/%C` stays under the unix socket path limit (104 on macOS, 108 on Linux).
    pub fn control_path_fits(&self) -> bool {
        self.control_dir.as_os_str().is_empty() || self.control_dir.as_os_str().len() + 1 + 40 + 17 < 104
    }

    /// Options, optional port, `--` and the destination. The remote command is appended by the caller as ONE argument.
    pub fn base_args(&self, cfg: &ServerCfg) -> Vec<OsString> {
        // `-a` and `-x`, and the options after them, switch off what a `Host *` line of the user's `~/.ssh/config` may have switched on: the agent
        // that is forwarded to a server would let the agent running there sign in as the user to other machines, and a forwarded port or
        // a local command is not what this connection is for. The first value of an option wins, and the command line is read first.
        let mut a: Vec<OsString> = vec!["-T".into(), "-a".into(), "-x".into()];
        for o in [
            "BatchMode=yes",
            "ConnectTimeout=10",
            "ServerAliveInterval=15",
            "ServerAliveCountMax=3",
            "ForwardAgent=no",
            "ForwardX11=no",
            "ClearAllForwardings=yes",
            "PermitLocalCommand=no",
        ] {
            a.push("-o".into());
            a.push(o.into());
        }
        if self.control_dir.as_os_str().is_empty() {
            for o in ["ControlMaster=no", "ControlPath=none"] {
                a.push("-o".into());
                a.push(o.into());
            }
        } else {
            for o in ["ControlMaster=auto", "ControlPersist=60"] {
                a.push("-o".into());
                a.push(o.into());
            }
            let mut cp = OsString::from("ControlPath=");
            cp.push(self.control_dir.join("%C"));
            a.push("-o".into());
            a.push(cp);
        }
        if let Some(p) = cfg.port {
            a.push("-p".into());
            a.push(p.to_string().into());
        }
        a.push("--".into());
        a.push(cfg.destination.clone().into());
        a
    }

    /// A ready `Command` with piped stdio for a long-running remote process (the sidecar). The remote command is one
    /// argument and the destination always follows `--`. The caller has validated `cfg`.
    pub fn command(&self, cfg: &ServerCfg, remote_command: &str) -> Command {
        let mut c = Command::new(&self.bin);
        c.args(self.base_args(cfg))
            .arg(remote_command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c
    }

    /// Runs `script` with `sh -s` on the server (script on stdin). A non-zero exit of the script is returned in
    /// [`ExecOut`]; ssh's own failures (exit 255), spawn errors and timeouts are errors.
    ///
    /// The script reads stdin itself, so any command in it that might read stdin needs `</dev/null`.
    pub fn exec(&self, cfg: &ServerCfg, script: &str, timeout: Duration) -> Result<ExecOut, SshError> {
        cfg.validate().map_err(|e| SshError::invalid(e.to_string()))?;
        let raw = run(self.command(cfg, "sh -s"), Input::Bytes(script.as_bytes()), timeout, None)
            .map_err(|e| SshError::spawn(&self.bin, &e))?;
        finish(raw, cfg, timeout)
    }

    /// Streams `entries` of `local_dir` into `remote_dir` on the server: `tar -cf -` locally piped into
    /// `mkdir -p <dir> && tar -xf -` over ssh. Both exit codes are checked.
    pub fn push_tar(
        &self,
        cfg: &ServerCfg,
        local_dir: &Path,
        entries: &[&str],
        remote_dir: &str,
        timeout: Duration,
    ) -> Result<(), SshError> {
        cfg.validate().map_err(|e| SshError::invalid(e.to_string()))?;
        validate_remote_path("remoteDir", remote_dir).map_err(|e| SshError::invalid(e.to_string()))?;
        if entries.is_empty() || !entries.iter().all(|e| tar_entry_ok(e)) {
            return Err(SshError::invalid("bad tar entry".into()));
        }
        let mut tar = Command::new("tar");
        tar.arg("-C")
            .arg(local_dir)
            .args(["-cf", "-", "--"])
            .args(entries)
            .env("COPYFILE_DISABLE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        let mut tar_child = tar.spawn().map_err(|e| SshError::spawn(Path::new("tar"), &e))?;
        let tar_pid = tar_child.id();
        let tar_err = tar_child.stderr.take().map(drain);
        let Some(tar_out) = tar_child.stdout.take() else {
            kill_group(tar_pid);
            let _ = tar_child.wait();
            return Err(SshError::invalid("tar has no stdout".into()));
        };
        let q = sh_quote_path_for_remote(remote_dir);
        let remote = format!("mkdir -p {q} && tar -C {q} -xf -");
        let raw = run(self.command(cfg, &remote), Input::Pipe(tar_out), timeout, Some(tar_pid));
        let tar_status = wait_until(&mut tar_child, Instant::now() + Duration::from_secs(5), tar_pid);
        let tar_stderr = collect(tar_err, Duration::from_secs(1)).0;
        let raw = raw.map_err(|e| SshError::spawn(&self.bin, &e))?;
        if raw.timed_out {
            return Err(SshError::timeout(timeout));
        }
        // A signal (None) is tar dying of SIGPIPE because ssh ended first: ssh's own result tells the story then.
        if let Some(c) = tar_status.filter(|c| *c != 0) {
            return Err(SshError::other(format!(
                "local tar failed ({c}): {}",
                tail(&String::from_utf8_lossy(&tar_stderr))
            )));
        }
        if raw.code != Some(0) {
            return Err(SshError::from_raw(&raw, cfg));
        }
        Ok(())
    }
}

fn tar_entry_ok(e: &str) -> bool {
    !e.is_empty()
        && !e.starts_with(['-', '/'])
        && e.split('/').all(|c| c != ".." && !c.is_empty())
        && e.chars().all(|c| c.is_ascii_alphanumeric() || "._/-+".contains(c))
}

/// What a finished remote command produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOut {
    /// Exit code of the remote command (`-1` when it was killed by a signal).
    pub code: i32,
    /// Standard output, capped at 1 MiB.
    pub stdout: Vec<u8>,
    /// Standard error (lossy UTF-8), capped at 1 MiB.
    pub stderr: String,
    /// True when either stream hit the cap.
    pub truncated: bool,
}

impl ExecOut {
    /// Exit code 0.
    pub fn success(&self) -> bool {
        self.code == 0
    }
    /// Standard output as lossy UTF-8.
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// The class of an ssh failure, for a message and a hint in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SshErrorKind {
    /// Unknown or changed host key.
    HostKey,
    /// No key or agent that logs in without a password.
    Auth,
    /// The connection or the command ran into a time limit.
    Timeout,
    /// The host name does not resolve.
    Dns,
    /// The port is closed.
    Refused,
    /// Anything else (including invalid input and spawn errors).
    Other,
}

impl SshErrorKind {
    /// Short stable code for the UI.
    pub fn code(self) -> &'static str {
        match self {
            Self::HostKey => "host_key",
            Self::Auth => "auth",
            Self::Timeout => "timeout",
            Self::Dns => "dns",
            Self::Refused => "refused",
            Self::Other => "other",
        }
    }
    /// One-line description.
    pub fn message(self) -> &'static str {
        match self {
            Self::HostKey => "The server's host key is not trusted",
            Self::Auth => "ssh could not log in",
            Self::Timeout => "The connection timed out",
            Self::Dns => "The host name could not be resolved",
            Self::Refused => "The connection was refused",
            Self::Other => "The ssh command failed",
        }
    }
    /// What the person can do about it.
    pub fn hint(self, destination: &str) -> Option<String> {
        match self {
            Self::HostKey => Some(format!(
                "connect once from a terminal so the host key is trusted: ssh {destination}"
            )),
            Self::Auth => Some("ssh needs a key or agent that logs in without a password".into()),
            Self::Timeout => Some("check that the server is up and reachable from this machine".into()),
            Self::Dns => Some("check the host name, or use an alias from ~/.ssh/config".into()),
            Self::Refused => Some("check the port and that sshd is running on the server".into()),
            Self::Other => None,
        }
    }
}

/// Maps the stderr and exit code of a failed ssh run to a class. Only exit 255 is ssh's own failure: other exit codes
/// belong to the remote command, whose stderr (for example "Permission denied") says nothing about the login.
pub fn classify(stderr: &str, exit: i32) -> SshErrorKind {
    if exit != 255 {
        return SshErrorKind::Other;
    }
    let s = stderr.to_ascii_lowercase();
    let has = |p: &str| s.contains(p);
    if has("host key verification failed")
        || has("remote host identification has changed")
        || has("no matching host key type")
    {
        SshErrorKind::HostKey
    } else if has("permission denied")
        || has("too many authentication failures")
        || has("no more authentication methods")
    {
        SshErrorKind::Auth
    } else if has("could not resolve hostname")
        || has("name or service not known")
        || has("nodename nor servname")
        || has("temporary failure in name resolution")
    {
        SshErrorKind::Dns
    } else if has("connection timed out") || has("operation timed out") {
        SshErrorKind::Timeout
    } else if has("connection refused") {
        SshErrorKind::Refused
    } else {
        SshErrorKind::Other
    }
}

/// A failed ssh call: class, a stderr tail (max 2 KiB) and the hint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SshError {
    /// The class.
    pub kind: SshErrorKind,
    /// Last lines of stderr or a description.
    pub detail: String,
    /// What to do about it.
    pub hint: Option<String>,
}

impl std::fmt::Display for SshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.kind.message())?;
        if !self.detail.is_empty() {
            write!(f, ": {}", self.detail)?;
        }
        Ok(())
    }
}

impl std::error::Error for SshError {}

impl SshError {
    pub(crate) fn other(detail: String) -> Self {
        Self { kind: SshErrorKind::Other, detail: tail(&detail), hint: None }
    }
    pub(crate) fn invalid(detail: String) -> Self {
        Self::other(format!("invalid input: {detail}"))
    }
    fn spawn(bin: &Path, e: &std::io::Error) -> Self {
        Self::other(format!("cannot start {}: {e}", bin.display()))
    }
    fn timeout(d: Duration) -> Self {
        Self {
            kind: SshErrorKind::Timeout,
            detail: format!("no result after {} s", d.as_secs()),
            hint: SshErrorKind::Timeout.hint(""),
        }
    }
    fn from_raw(raw: &Raw, cfg: &ServerCfg) -> Self {
        let stderr = String::from_utf8_lossy(&raw.stderr);
        let kind = classify(&stderr, raw.code.unwrap_or(-1));
        Self { kind, detail: tail(&stderr), hint: kind.hint(&cfg.destination) }
    }
}

/// The last 2 KiB of `s`, on a char boundary, trimmed.
pub fn tail(s: &str) -> String {
    let s = s.trim();
    if s.len() <= TAIL_MAX {
        return s.to_string();
    }
    let mut from = s.len() - TAIL_MAX;
    while !s.is_char_boundary(from) {
        from += 1;
    }
    s[from..].trim_start().to_string()
}

struct Raw {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
    timed_out: bool,
}

fn finish(raw: Raw, cfg: &ServerCfg, timeout: Duration) -> Result<ExecOut, SshError> {
    if raw.timed_out {
        return Err(SshError::timeout(timeout));
    }
    if raw.code == Some(255) {
        return Err(SshError::from_raw(&raw, cfg));
    }
    Ok(ExecOut {
        code: raw.code.unwrap_or(-1),
        stdout: raw.stdout,
        stderr: String::from_utf8_lossy(&raw.stderr).into_owned(),
        truncated: raw.truncated,
    })
}

enum Input<'a> {
    Bytes(&'a [u8]),
    Pipe(ChildStdout),
}

/// Reads a stream to EOF, keeping at most [`OUTPUT_CAP`] bytes. Reports `(bytes, truncated)` when done.
fn drain(mut r: impl Read + Send + 'static) -> Receiver<(Vec<u8>, bool)> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let (mut buf, mut cut, mut chunk) = (Vec::new(), false, [0u8; 8192]);
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let room = OUTPUT_CAP.saturating_sub(buf.len());
                    if n > room {
                        cut = true;
                    }
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                }
            }
        }
        let _ = tx.send((buf, cut));
    });
    rx
}

fn collect(rx: Option<Receiver<(Vec<u8>, bool)>>, wait: Duration) -> (Vec<u8>, bool) {
    rx.and_then(|r| r.recv_timeout(wait).ok()).unwrap_or_default()
}

/// Kills a whole process group (the child was started with `process_group(0)`, so its pid is the group id).
fn kill_group(pid: u32) {
    let _ = Command::new("sh")
        .arg("-c")
        .arg(format!("kill -KILL -- -{pid} 2>/dev/null"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Waits for `child` until `deadline`, then kills its group. `None` = killed or unknown.
fn wait_until(child: &mut Child, deadline: Instant, pid: u32) -> Option<i32> {
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return st.code(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) | Err(_) => {
                kill_group(pid);
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Runs `cmd` (stdout and stderr piped) with `input` on stdin and a wall-clock `timeout`. On timeout the process group
/// (and `also_kill`'s group) is killed.
fn run(mut cmd: Command, input: Input<'_>, timeout: Duration, also_kill: Option<u32>) -> std::io::Result<Raw> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    let bytes = match input {
        Input::Bytes(b) => {
            cmd.stdin(Stdio::piped());
            Some(b.to_vec())
        }
        Input::Pipe(p) => {
            cmd.stdin(Stdio::from(p));
            None
        }
    };
    let mut child = cmd.spawn()?;
    let pid = child.id();
    if let (Some(bytes), Some(mut stdin)) = (bytes, child.stdin.take()) {
        thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
        });
    }
    let out = child.stdout.take().map(drain);
    let err = child.stderr.take().map(drain);
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let code = loop {
        match child.try_wait()? {
            Some(st) => break st.code(),
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            None => {
                timed_out = true;
                kill_group(pid);
                if let Some(p) = also_kill {
                    kill_group(p);
                }
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    // A grandchild that kept a pipe open must not hold us: wait a little, then give up on the rest.
    let wait = Duration::from_secs(if timed_out { 1 } else { 3 });
    let (stdout, cut_out) = collect(out, wait);
    let (stderr, cut_err) = collect(err, wait);
    Ok(Raw { code, stdout, stderr, truncated: cut_out || cut_err, timed_out })
}

/// Why `meta` is not a private folder of the user `uid`; `None` when it is (a real folder, not a link, owned by that user).
fn why_not_private(meta: &std::fs::Metadata, uid: u32) -> Option<&'static str> {
    use std::os::unix::fs::MetadataExt;
    let t = meta.file_type();
    if t.is_symlink() {
        Some("it is a symbolic link")
    } else if !t.is_dir() {
        Some("it is not a folder")
    } else if meta.uid() != uid {
        Some("it belongs to another user")
    } else {
        None
    }
}

/// Makes `dir` a folder of this user that nobody else can enter, or says why it cannot be one.
fn claim_dir(dir: &Path, uid: u32) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind};
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    // (`symlink_metadata`: a link planted at this name is looked at, not followed)
    let meta = std::fs::symlink_metadata(dir)?;
    if let Some(why) = why_not_private(&meta, uid) {
        return Err(Error::new(ErrorKind::PermissionDenied, why));
    }
    if meta.mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let meta = std::fs::symlink_metadata(dir)?;
    match why_not_private(&meta, uid) {
        Some(why) => Err(Error::new(ErrorKind::PermissionDenied, why)),
        None if meta.mode() & 0o077 != 0 => Err(Error::new(ErrorKind::PermissionDenied, "others can enter it")),
        None => Ok(()),
    }
}

/// The first of `candidates` that is, or can be made, a private folder of this user for the control sockets of `ssh`. The sockets sit in
/// a shared place (`/tmp`, because a socket path must be short) and their names are predictable (`%C` is a hash of the host, port and
/// user), so a folder that another user created first, or a link planted at its name, would let that user into every connection. Such a
/// candidate is skipped; `None` means no sharing of connections (`Ssh::control_dir` empty).
pub fn private_control_dir(candidates: &[PathBuf]) -> Option<PathBuf> {
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    let uid = unsafe { libc::geteuid() };
    candidates.iter().find(|dir| claim_dir(dir, uid).is_ok()).cloned()
}

/// Where the control sockets go by default: short (`/tmp/intely-ssh-<user>`, the socket path limit is about 100 bytes), once by name and
/// once by number in case the name was taken by somebody else.
pub fn default_control_dirs() -> Vec<PathBuf> {
    let user: String = std::env::var("USER").unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric()).take(16).collect();
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    let uid = unsafe { libc::geteuid() };
    let mut v = Vec::new();
    if !user.is_empty() {
        v.push(PathBuf::from(format!("/tmp/intely-ssh-{user}")));
    }
    v.push(PathBuf::from(format!("/tmp/intely-ssh-{uid}")));
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::*;

    fn cfg(port: Option<u16>) -> ServerCfg {
        ServerCfg { port, ..test_cfg() }
    }

    fn strs(v: Vec<OsString>) -> Vec<String> {
        v.into_iter().map(|s| s.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn base_args_shape() {
        let ssh = Ssh { bin: "ssh".into(), control_dir: "/tmp/cd".into() };
        let a = strs(ssh.base_args(&cfg(None)));
        assert_eq!(a[0], "-T");
        // no forwarding of any kind, whatever the user's ssh config says
        assert!(a[..4].contains(&"-a".to_string()) && a[..4].contains(&"-x".to_string()), "{a:?}");
        for o in [
            "BatchMode=yes",
            "ConnectTimeout=10",
            "ServerAliveInterval=15",
            "ServerAliveCountMax=3",
            "ForwardAgent=no",
            "ForwardX11=no",
            "ClearAllForwardings=yes",
            "PermitLocalCommand=no",
            "ControlMaster=auto",
            "ControlPersist=60",
            "ControlPath=/tmp/cd/%C",
        ] {
            let i = a.iter().position(|x| x == o).unwrap_or_else(|| panic!("{o}"));
            assert_eq!(a[i - 1], "-o");
        }
        assert!(!a.contains(&"-p".to_string()));
        assert_eq!(a[a.len() - 2], "--");
        assert_eq!(a[a.len() - 1], "big.example.com");
    }

    #[test]
    fn without_a_control_folder_connections_are_not_shared() {
        let ssh = Ssh { bin: "ssh".into(), control_dir: PathBuf::new() };
        let a = strs(ssh.base_args(&cfg(None)));
        assert!(a.contains(&"ControlMaster=no".to_string()) && a.contains(&"ControlPath=none".to_string()), "{a:?}");
        assert!(!a.iter().any(|x| x.starts_with("ControlMaster=auto") || x.starts_with("ControlPersist")), "{a:?}");
        assert!(ssh.control_path_fits());
    }

    fn mode_of(p: &Path) -> u32 {
        use std::os::unix::fs::MetadataExt;
        std::fs::symlink_metadata(p).unwrap().mode() & 0o777
    }

    #[test]
    fn a_missing_control_folder_is_made_private() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path().join("cd");
        assert_eq!(private_control_dir(&[d.clone()]), Some(d.clone()));
        assert_eq!(mode_of(&d), 0o700);
        // asking again finds it as it is
        assert_eq!(private_control_dir(&[d.clone()]), Some(d));
    }

    #[test]
    fn an_open_control_folder_of_ours_is_closed() {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().unwrap();
        let d = t.path().join("cd");
        std::fs::create_dir(&d).unwrap();
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(private_control_dir(&[d.clone()]), Some(d.clone()));
        assert_eq!(mode_of(&d), 0o700);
    }

    #[test]
    fn a_link_or_a_file_at_the_name_is_not_used() {
        let t = tempfile::tempdir().unwrap();
        let real = t.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let link = t.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let file = t.path().join("file");
        std::fs::write(&file, "x").unwrap();
        let ours = t.path().join("ours");
        // the first two are skipped, the third is made
        assert_eq!(private_control_dir(&[link, file, ours.clone()]), Some(ours));
        // and with nothing else to take there is no folder at all
        assert_eq!(private_control_dir(&[t.path().join("link"), t.path().join("file")]), None);
        assert_eq!(private_control_dir(&[]), None);
    }

    #[test]
    fn a_folder_of_another_user_is_not_private() {
        let t = tempfile::tempdir().unwrap();
        let meta = std::fs::symlink_metadata(t.path()).unwrap();
        use std::os::unix::fs::MetadataExt;
        assert_eq!(why_not_private(&meta, meta.uid()), None);
        assert_eq!(why_not_private(&meta, meta.uid().wrapping_add(1)), Some("it belongs to another user"));
    }

    #[test]
    fn the_default_folders_are_short_enough_for_a_socket() {
        let dirs = default_control_dirs();
        assert!(!dirs.is_empty());
        for d in dirs {
            assert!(Ssh { bin: "ssh".into(), control_dir: d.clone() }.control_path_fits(), "{}", d.display());
        }
    }

    #[test]
    fn port_comes_before_the_separator() {
        let ssh = Ssh { bin: "ssh".into(), control_dir: "/tmp/cd".into() };
        let a = strs(ssh.base_args(&cfg(Some(2222))));
        let p = a.iter().position(|x| x == "-p").unwrap();
        let d = a.iter().position(|x| x == "--").unwrap();
        assert_eq!(a[p + 1], "2222");
        assert!(p < d);
    }

    #[test]
    fn hostile_destination_stays_after_the_separator_as_one_argument() {
        let ssh = Ssh { bin: "ssh".into(), control_dir: "/tmp/cd".into() };
        let c = ServerCfg { destination: "-oProxyCommand=touch /tmp/x".into(), ..test_cfg() };
        let a = strs(ssh.base_args(&c));
        let d = a.iter().position(|x| x == "--").unwrap();
        assert_eq!(a.iter().filter(|x| x.as_str() == "--").count(), 1);
        assert_eq!(a[d + 1], "-oProxyCommand=touch /tmp/x");
        assert!(a[..d].iter().all(|x| !x.contains("ProxyCommand")));
    }

    #[test]
    fn command_has_one_remote_argument_and_piped_stdio() {
        let ssh = Ssh { bin: "ssh".into(), control_dir: "/tmp/cd".into() };
        let cmd = ssh.command(&cfg(Some(22)), "sh -c 'echo; ls'");
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args.last().unwrap(), "sh -c 'echo; ls'");
        let d = args.iter().position(|x| x == "--").unwrap();
        assert_eq!(args.len(), d + 3);
        assert_eq!(cmd.get_program(), "ssh");
    }

    #[test]
    fn from_bin_defaults_to_ssh() {
        assert_eq!(Ssh::from_bin(None, "/c").bin, PathBuf::from("ssh"));
        assert_eq!(Ssh::from_bin(Some("".into()), "/c").bin, PathBuf::from("ssh"));
        assert_eq!(Ssh::from_bin(Some("/x/fake".into()), "/c").bin, PathBuf::from("/x/fake"));
    }

    #[test]
    fn control_path_length_check() {
        assert!(Ssh::from_bin(None, "/tmp/intely-ssh-501").control_path_fits());
        assert!(!Ssh::from_bin(None, format!("/{}", "a".repeat(60))).control_path_fits());
    }

    // Messages copied from real OpenSSH output.
    #[test]
    fn classification_of_real_messages() {
        let cases: &[(&str, SshErrorKind)] = &[
            ("Host key verification failed.\r\n", SshErrorKind::HostKey),
            (
                "@@@@@@@@\r\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n@@@@@@@@\r\nHost key verification failed.",
                SshErrorKind::HostKey,
            ),
            ("Unable to negotiate with 1.2.3.4 port 22: no matching host key type found. Their offer: ssh-dss", SshErrorKind::HostKey),
            ("dev@big: Permission denied (publickey,password).", SshErrorKind::Auth),
            ("dev@big: Permission denied (publickey).", SshErrorKind::Auth),
            ("Received disconnect from 1.2.3.4 port 22:2: Too many authentication failures", SshErrorKind::Auth),
            ("ssh: Could not resolve hostname nohost: nodename nor servname provided, or not known", SshErrorKind::Dns),
            ("ssh: Could not resolve hostname nohost: Name or service not known", SshErrorKind::Dns),
            ("ssh: connect to host 10.255.255.1 port 22: Operation timed out", SshErrorKind::Timeout),
            ("ssh: connect to host 10.255.255.1 port 22: Connection timed out", SshErrorKind::Timeout),
            ("Connection timed out during banner exchange", SshErrorKind::Timeout),
            ("ssh: connect to host localhost port 22: Connection refused", SshErrorKind::Refused),
            ("kex_exchange_identification: read: Connection reset by peer", SshErrorKind::Other),
            ("", SshErrorKind::Other),
        ];
        for (text, want) in cases {
            assert_eq!(classify(text, 255), *want, "{text}");
        }
    }

    #[test]
    fn only_exit_255_is_classified() {
        assert_eq!(classify("mkdir: cannot create directory: Permission denied", 1), SshErrorKind::Other);
        assert_eq!(classify("Permission denied (publickey).", 0), SshErrorKind::Other);
        assert_eq!(classify("Permission denied (publickey).", 255), SshErrorKind::Auth);
    }

    #[test]
    fn hints() {
        assert_eq!(
            SshErrorKind::HostKey.hint("dev@big").unwrap(),
            "connect once from a terminal so the host key is trusted: ssh dev@big"
        );
        assert_eq!(
            SshErrorKind::Auth.hint("x").unwrap(),
            "ssh needs a key or agent that logs in without a password"
        );
        assert!(SshErrorKind::Other.hint("x").is_none());
        for k in [SshErrorKind::HostKey, SshErrorKind::Auth, SshErrorKind::Timeout, SshErrorKind::Dns, SshErrorKind::Refused] {
            assert!(!k.message().is_empty() && k.hint("h").is_some());
        }
    }

    #[test]
    fn tail_is_capped_on_a_char_boundary() {
        let s = "é".repeat(3000);
        let t = tail(&s);
        assert!(t.len() <= TAIL_MAX && t.chars().all(|c| c == 'é'));
        assert_eq!(tail("  short \n"), "short");
    }

    #[test]
    fn exec_runs_the_script_on_the_fake_server() {
        let f = Fake::new();
        let out = f.ssh.exec(&f.cfg, "echo hi; echo \"$HOME\" >&2; exit 3", Duration::from_secs(20)).unwrap();
        assert_eq!(out.code, 3);
        assert_eq!(out.stdout_text(), "hi\n");
        assert_eq!(out.stderr.trim(), f.home.to_string_lossy());
        assert!(!out.success());
    }

    #[test]
    fn exec_rejects_an_invalid_config_before_spawning() {
        let f = Fake::new();
        let c = ServerCfg { destination: "-oProxyCommand=x".into(), ..f.cfg.clone() };
        let e = f.ssh.exec(&c, "true", Duration::from_secs(5)).unwrap_err();
        assert_eq!(e.kind, SshErrorKind::Other);
        assert!(e.detail.contains("destination"));
    }

    #[test]
    fn exec_turns_exit_255_into_a_classified_error() {
        let f = Fake::new();
        let c = ServerCfg { destination: "refused.test".into(), ..f.cfg.clone() };
        let e = f.ssh.exec(&c, "true", Duration::from_secs(20)).unwrap_err();
        assert_eq!(e.kind, SshErrorKind::Refused);
        assert!(e.detail.contains("Connection refused"));
        let c = ServerCfg { destination: "badkey.test".into(), ..f.cfg.clone() };
        let e = f.ssh.exec(&c, "true", Duration::from_secs(20)).unwrap_err();
        assert_eq!(e.kind, SshErrorKind::HostKey);
        assert!(e.hint.unwrap().ends_with("ssh badkey.test"));
    }

    #[test]
    fn exec_times_out_and_kills_the_process_group() {
        let f = Fake::new();
        let marker = f.dir.path().join("late");
        let script = format!("sleep 30 && touch {}", marker.display());
        let t = Instant::now();
        let e = f.ssh.exec(&f.cfg, &script, Duration::from_millis(400)).unwrap_err();
        assert_eq!(e.kind, SshErrorKind::Timeout);
        assert!(t.elapsed() < Duration::from_secs(10));
        assert!(!marker.exists());
    }

    #[test]
    fn exec_caps_output() {
        let f = Fake::new();
        let out = f.ssh.exec(&f.cfg, "head -c 3000000 /dev/zero", Duration::from_secs(30)).unwrap();
        assert_eq!(out.stdout.len(), OUTPUT_CAP);
        assert!(out.truncated);
        assert!(out.success());
    }

    #[test]
    fn exec_with_a_missing_ssh_binary_is_an_error_not_a_panic() {
        let f = Fake::new();
        let ssh = Ssh { bin: "/nonexistent/ssh-binary".into(), control_dir: f.ssh.control_dir.clone() };
        let e = ssh.exec(&f.cfg, "true", Duration::from_secs(5)).unwrap_err();
        assert!(e.detail.contains("cannot start"));
    }

    #[test]
    fn script_commands_that_read_stdin_need_dev_null() {
        // Documents why: `cat` would eat the rest of the script.
        let f = Fake::new();
        let out = f.ssh.exec(&f.cfg, "cat </dev/null; echo after", Duration::from_secs(10)).unwrap();
        assert_eq!(out.stdout_text(), "after\n");
    }

    #[test]
    fn push_tar_copies_files_with_modes_into_the_server_home() {
        let f = Fake::new();
        let src = f.dir.path().join("src");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.txt"), "A").unwrap();
        std::fs::write(src.join("sub/b.sh"), "#!/bin/sh\n").unwrap();
        make_exec(&src.join("sub/b.sh"));
        f.ssh
            .push_tar(&f.cfg, &src, &["a.txt", "sub"], "~/up/it's here", Duration::from_secs(30))
            .unwrap();
        let dst = f.home.join("up/it's here");
        assert_eq!(std::fs::read_to_string(dst.join("a.txt")).unwrap(), "A");
        assert!(is_exec(&dst.join("sub/b.sh")));
        assert!(!dst.join("._a.txt").exists());
    }

    #[test]
    fn push_tar_reports_a_failing_local_tar() {
        let f = Fake::new();
        let src = f.dir.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        let e = f.ssh.push_tar(&f.cfg, &src, &["missing"], "~/x", Duration::from_secs(20)).unwrap_err();
        assert!(e.detail.contains("tar"), "{e}");
    }

    #[test]
    fn push_tar_reports_a_failing_remote() {
        let f = Fake::new();
        let src = f.dir.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a"), "x").unwrap();
        std::fs::write(f.home.join("blocker"), "file").unwrap();
        // mkdir -p under a regular file fails.
        let e = f.ssh.push_tar(&f.cfg, &src, &["a"], "~/blocker/dir", Duration::from_secs(20)).unwrap_err();
        assert_eq!(e.kind, SshErrorKind::Other);
        assert!(!e.detail.is_empty());
    }

    #[test]
    fn push_tar_rejects_bad_entries_and_dirs() {
        let f = Fake::new();
        let src = f.dir.path();
        for bad in ["", "-x", "/abs", "../up", "a/../b", "a b", "a;b", "a//b"] {
            let e = f.ssh.push_tar(&f.cfg, src, &[bad], "~/x", Duration::from_secs(5)).unwrap_err();
            assert!(e.detail.contains("bad tar entry"), "{bad:?}");
        }
        assert!(f.ssh.push_tar(&f.cfg, src, &[], "~/x", Duration::from_secs(5)).is_err());
        for dir in ["rel", "/a/../b", "~/a\nb", ""] {
            assert!(f.ssh.push_tar(&f.cfg, src, &["a"], dir, Duration::from_secs(5)).is_err(), "{dir:?}");
        }
    }

    #[test]
    fn push_tar_times_out() {
        let f = Fake::new();
        let slow = f.dir.path().join("slow-ssh");
        write_exec(&slow, "#!/bin/sh\nsleep 30\n");
        let ssh = Ssh { bin: slow, control_dir: f.ssh.control_dir.clone() };
        let src = f.dir.path().join("s");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a"), "x").unwrap();
        let t = Instant::now();
        let e = ssh.push_tar(&f.cfg, &src, &["a"], "~/x", Duration::from_millis(400)).unwrap_err();
        assert_eq!(e.kind, SshErrorKind::Timeout);
        assert!(t.elapsed() < Duration::from_secs(10));
    }
}
