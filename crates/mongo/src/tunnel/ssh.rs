//! The ssh binary check, the argv and environment builders, the command runner and `ssh -G` resolution (T4a).
//!
//! Everything here is pure or goes through a [`CommandRunner`], so the tests drive it with a fake runner and no real ssh
//! server. Nothing here opens a socket or starts a process by itself: the spawning entry points take a [`Jail`] and
//! refuse under `INTELY_READONLY` before any child starts. No secret ever enters an argv or an environment built here.
//!
//! Errors are [`StudioError`]s whose `message` starts with the diagnosis code (`tunnel.noSsh: ...`), so the diagnosis
//! can classify them without parsing prose; the messages never carry user names, key paths or other input text.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::connspec::{valid_file_path, SshSpec, Tunnel, TunnelAuth};
use crate::error::{code, Result, StudioError};
use crate::host;
use crate::jail::{Jail, NetworkPolicy};

/// Diagnosis codes of the tunnel layer produced by this file and its siblings.
pub mod tcode {
    pub const NO_SSH: &str = "tunnel.noSsh";
    pub const CONFIG: &str = "tunnel.config";
    pub const KEY_FILE: &str = "tunnel.keyFile";
    pub const PASSPHRASE: &str = "tunnel.passphrase";
    pub const IPV6: &str = "tunnel.ipv6";
    pub const NETWORK: &str = "tunnel.network";
    pub const HOST_KEY_UNKNOWN: &str = "tunnel.hostKeyUnknown";
    pub const HOST_KEY_CHANGED: &str = "tunnel.hostKeyChanged";
    pub const HOST_KEY_UNSCANNABLE: &str = "tunnel.hostKeyUnscannable";
}

pub fn tunnel_error(diag: &'static str, msg: impl std::fmt::Display) -> StudioError {
    StudioError::new(code::TUNNEL, format!("{diag}: {msg}"))
}

pub fn host_key_error(diag: &'static str, msg: impl std::fmt::Display) -> StudioError {
    StudioError::new(code::HOST_KEY, format!("{diag}: {msg}"))
}

// ---------------------------------------------------------------------------------------------------------------------
// The binary
// ---------------------------------------------------------------------------------------------------------------------

/// `OpenSSH_9.6p1, LibreSSL 3.3.6` -> 9.6.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct SshVersion {
    pub major: u32,
    pub minor: u32,
}

impl SshVersion {
    /// `SSH_ASKPASS_REQUIRE=force` exists from OpenSSH 8.4.
    pub const ASKPASS_FORCE: SshVersion = SshVersion { major: 8, minor: 4 };

    pub fn supports_askpass_force(self) -> bool {
        self >= Self::ASKPASS_FORCE
    }
}

pub fn parse_version(text: &str) -> Option<SshVersion> {
    let rest = &text[text.find("OpenSSH_")? + "OpenSSH_".len()..];
    let mut parts = rest.splitn(2, '.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor_text: String = parts.next()?.chars().take_while(char::is_ascii_digit).collect();
    Some(SshVersion { major, minor: minor_text.parse().ok()? })
}

/// What the trust check needs to know about a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileFacts {
    pub is_file: bool,
    pub uid: u32,
    pub mode: u32,
}

/// The facts of a real file (follows symlinks: the target is what runs). `None` when it does not exist.
#[cfg(unix)]
pub fn facts_of(path: &Path) -> Option<FileFacts> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path).ok()?;
    Some(FileFacts { is_file: m.is_file(), uid: m.uid(), mode: m.mode() & 0o7777 })
}

#[cfg(not(unix))]
pub fn facts_of(_path: &Path) -> Option<FileFacts> {
    None
}

/// A regular file, owned by root, not group- or world-writable.
pub fn check_trusted(facts: Option<FileFacts>) -> Result<()> {
    match facts {
        None => Err(tunnel_error(tcode::NO_SSH, "the system OpenSSH tools were not found in /usr/bin")),
        Some(f) if !f.is_file => Err(tunnel_error(tcode::NO_SSH, "an OpenSSH tool in /usr/bin is not a regular file")),
        Some(f) if f.uid != 0 => Err(tunnel_error(tcode::NO_SSH, "an OpenSSH tool in /usr/bin is not owned by root")),
        Some(f) if f.mode & 0o022 != 0 => Err(tunnel_error(tcode::NO_SSH, "an OpenSSH tool in /usr/bin is writable by group or others")),
        Some(_) => Ok(()),
    }
}

pub const SYSTEM_DIR: &str = "/usr/bin";

#[derive(Debug, Clone)]
pub struct SshBinary {
    pub ssh: PathBuf,
    pub keygen: PathBuf,
    pub keyscan: PathBuf,
    pub version: Option<SshVersion>,
    /// True for the `INTELY_SSH_BINARY` test double: the ownership rule and the version rule are waived.
    pub overridden: bool,
}

impl SshBinary {
    /// `/usr/bin/{ssh,ssh-keygen,ssh-keyscan}` only, each a root-owned regular file that is not group/world-writable.
    /// `override_path` (the value of `INTELY_SSH_BINARY`) is honoured **only** under the E2E jail (`LoopbackOnly`);
    /// `ssh-keygen` and `ssh-keyscan` are then taken from the same directory when present there, else from `/usr/bin`.
    /// `facts` is injectable (tests); production passes [`facts_of`].
    pub fn locate(policy: NetworkPolicy, override_path: Option<&str>, facts: &dyn Fn(&Path) -> Option<FileFacts>) -> Result<Self> {
        let system = |name: &str| PathBuf::from(SYSTEM_DIR).join(name);
        if let (NetworkPolicy::LoopbackOnly, Some(o)) = (policy, override_path.filter(|o| !o.is_empty())) {
            let ssh = PathBuf::from(o);
            if !ssh.is_absolute() || !matches!(facts(&ssh), Some(f) if f.is_file && f.mode & 0o100 != 0) {
                return Err(tunnel_error(tcode::NO_SSH, "the ssh test double is missing or not executable"));
            }
            let dir = ssh.parent().map(Path::to_path_buf).unwrap_or_default();
            let pick = |name: &str| -> Result<PathBuf> {
                let sibling = dir.join(name);
                if matches!(facts(&sibling), Some(f) if f.is_file && f.mode & 0o100 != 0) {
                    return Ok(sibling);
                }
                let sys = system(name);
                check_trusted(facts(&sys))?;
                Ok(sys)
            };
            return Ok(Self { keygen: pick("ssh-keygen")?, keyscan: pick("ssh-keyscan")?, ssh, version: None, overridden: true });
        }
        let bin = Self { ssh: system("ssh"), keygen: system("ssh-keygen"), keyscan: system("ssh-keyscan"), version: None, overridden: false };
        for p in [&bin.ssh, &bin.keygen, &bin.keyscan] {
            check_trusted(facts(p))?;
        }
        Ok(bin)
    }

    /// Runs `ssh -V` once and stores the version. Refused under `INTELY_READONLY` (no child process starts there).
    pub fn probe_version(&mut self, runner: &dyn CommandRunner, jail: &Jail, env: &[(String, String)]) -> Result<()> {
        refuse_under_readonly(jail)?;
        let args = vec!["-V".to_string()];
        let out = runner
            .run(&RunRequest { program: &self.ssh, args: &args, env, stdin: None, timeout: Duration::from_secs(5) })
            .map_err(|_| tunnel_error(tcode::NO_SSH, "ssh could not be started"))?;
        // `ssh -V` prints to stderr
        let text = format!("{}{}", String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout));
        self.version = parse_version(&text);
        if self.version.is_none() && !self.overridden {
            return Err(tunnel_error(tcode::NO_SSH, "the ssh version could not be read"));
        }
        Ok(())
    }

    /// Password and key-passphrase modes need `SSH_ASKPASS_REQUIRE=force` (OpenSSH 8.4+). Agent and unencrypted-key
    /// modes work with any version.
    pub fn require_secret_mode(&self) -> Result<()> {
        match self.version {
            Some(v) if v.supports_askpass_force() => Ok(()),
            Some(v) => Err(tunnel_error(tcode::NO_SSH, format!("password and passphrase sign-in need OpenSSH 8.4 or newer; this is {}.{}", v.major, v.minor))),
            None if self.overridden => Ok(()),
            None => Err(tunnel_error(tcode::NO_SSH, "the ssh version is unknown")),
        }
    }
}

pub fn refuse_under_readonly(jail: &Jail) -> Result<()> {
    if jail.policy() == NetworkPolicy::Refused {
        return Err(StudioError::new(code::READ_ONLY_JAIL, "the read-only jail refuses tunnels and child processes"));
    }
    Ok(())
}

/// The network gate of every spawning entry point of this task: the same rule as [`NetworkPolicy::check_tunnel`].
pub fn gate(jail: &Jail, spec: &SshSpec) -> Result<()> {
    jail.policy().check_tunnel(&Tunnel::Ssh(spec.clone()), &[])
}

// ---------------------------------------------------------------------------------------------------------------------
// Running a command
// ---------------------------------------------------------------------------------------------------------------------

pub struct RunRequest<'a> {
    pub program: &'a Path,
    pub args: &'a [String],
    /// The whole environment: the child starts from nothing.
    pub env: &'a [(String, String)],
    pub stdin: Option<&'a [u8]>,
    pub timeout: Duration,
}

#[derive(Debug, Clone, Default)]
pub struct RunOutput {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
}

pub trait CommandRunner: Send + Sync {
    fn run(&self, req: &RunRequest<'_>) -> std::io::Result<RunOutput>;
}

const STDOUT_CAP: usize = 256 * 1024;
const STDERR_CAP: usize = 8 * 1024;

fn read_capped<R: Read>(mut r: R, cap: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                // keep draining so the child never blocks on a full pipe, but keep only `cap` bytes
                let room = cap.saturating_sub(out.len());
                out.extend_from_slice(&buf[..n.min(room)]);
            }
        }
    }
    out
}

/// Runs the real process: environment cleared, stdout capped at 256 KiB, stderr at 8 KiB, killed at the timeout.
pub struct SystemRunner;

impl CommandRunner for SystemRunner {
    fn run(&self, req: &RunRequest<'_>) -> std::io::Result<RunOutput> {
        let mut cmd = Command::new(req.program);
        cmd.args(req.args).env_clear().envs(req.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        cmd.stdin(if req.stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn()?;
        let writer = child.stdin.take().map(|mut si| {
            let data = req.stdin.unwrap_or_default().to_vec();
            std::thread::spawn(move || {
                let _ = si.write_all(&data);
            })
        });
        let so = child.stdout.take().map(|s| std::thread::spawn(move || read_capped(s, STDOUT_CAP)));
        let se = child.stderr.take().map(|s| std::thread::spawn(move || read_capped(s, STDERR_CAP)));
        let start = Instant::now();
        let (status, timed_out) = loop {
            if let Some(st) = child.try_wait()? {
                break (Some(st), false);
            }
            if start.elapsed() >= req.timeout {
                let _ = child.kill();
                let _ = child.wait();
                break (None, true);
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        if let Some(w) = writer {
            let _ = w.join();
        }
        let stdout = so.and_then(|h| h.join().ok()).unwrap_or_default();
        let stderr = se.and_then(|h| h.join().ok()).unwrap_or_default();
        Ok(RunOutput { code: status.and_then(|s| s.code()), stdout, stderr, timed_out })
    }
}

/// Everything a spawning helper needs, borrowed for one call.
pub struct SshCtx<'a> {
    pub runner: &'a dyn CommandRunner,
    pub bin: &'a SshBinary,
    pub jail: &'a Jail,
    /// Built by [`base_env`] (no secret, no `SSH_AUTH_SOCK`).
    pub env: &'a [(String, String)],
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation (applied at use, in addition to the save-time validation of `ConnSpec`)
// ---------------------------------------------------------------------------------------------------------------------

/// `[A-Za-z0-9._-]`, 1 to 253 characters, no leading `-`. Never an IPv6 literal, never a wildcard.
pub fn host_ok(h: &str) -> bool {
    !h.is_empty() && h.len() <= 253 && !h.starts_with('-') && h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub fn user_ok(u: &str) -> bool {
    !u.is_empty() && u.len() <= 64 && !u.starts_with('-') && u.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn path_has_control(p: &str) -> bool {
    p.chars().any(|c| c.is_control())
}

/// Re-validates the spec fields that reach an argv.
pub fn check_spec(spec: &SshSpec) -> Result<()> {
    if !host_ok(&spec.host) {
        return Err(tunnel_error(tcode::CONFIG, "the SSH host name is not valid"));
    }
    if !user_ok(&spec.user) {
        return Err(tunnel_error(tcode::CONFIG, "the SSH user name is not valid"));
    }
    if spec.port == Some(0) {
        return Err(tunnel_error(tcode::CONFIG, "the SSH port is not valid"));
    }
    match (&spec.auth, &spec.key_file) {
        (TunnelAuth::KeyFile, Some(k)) if valid_file_path(k) && !path_has_control(k) => {}
        (TunnelAuth::KeyFile, _) => return Err(tunnel_error(tcode::KEY_FILE, "pick a valid key file")),
        (_, Some(_)) => return Err(tunnel_error(tcode::CONFIG, "a key file is only used with key file sign-in")),
        _ => {}
    }
    Ok(())
}

/// A `-W` destination: a plain host name and a port. IPv6 literals are refused (`tunnel.ipv6`).
pub fn check_target(host: &str, port: u16) -> Result<()> {
    if host.starts_with('[') || host.contains(':') {
        return Err(tunnel_error(tcode::IPV6, "IPv6 addresses are not supported as database hosts; use a host name"));
    }
    if !host_ok(host) || port == 0 {
        return Err(tunnel_error(tcode::CONFIG, "the database host is not valid"));
    }
    Ok(())
}

/// A path passed to ssh as an option value: `%` is a token character there and is written `%%`.
fn pct(p: &str) -> String {
    p.replace('%', "%%")
}

/// The path of an option value inside double quotes (`UserKnownHostsFile`): no quote, backslash or control character.
fn quoted_path(p: &Path) -> Result<String> {
    let s = p.to_str().ok_or_else(|| tunnel_error(tcode::CONFIG, "a state path is not valid text"))?;
    if !s.starts_with('/') || path_has_control(s) || s.contains(['"', '\'', '\\']) {
        return Err(tunnel_error(tcode::CONFIG, "a state path contains characters ssh cannot be given safely"));
    }
    Ok(format!("\"{}\"", pct(s)))
}

fn control_path(p: &Path) -> Result<String> {
    let s = p.to_str().ok_or_else(|| tunnel_error(tcode::CONFIG, "the control path is not valid text"))?;
    if !s.starts_with('/') || path_has_control(s) {
        return Err(tunnel_error(tcode::CONFIG, "the control path is not valid"));
    }
    // sun_path is 104 bytes on macOS and 108 on Linux; the spec keeps it under 100
    if s.len() >= 100 {
        return Err(tunnel_error(tcode::CONFIG, "the control path is too long"));
    }
    Ok(pct(s))
}

fn jail_active(policy: NetworkPolicy) -> bool {
    policy != NetworkPolicy::Full
}

/// `-F /dev/null` when the user opted out of their ssh config, and always under a jail.
pub fn config_off(spec: &SshSpec, policy: NetworkPolicy) -> bool {
    !spec.use_ssh_config || jail_active(policy)
}

fn jail_host_check(spec: &SshSpec, policy: NetworkPolicy) -> Result<()> {
    match policy {
        NetworkPolicy::Full => Ok(()),
        NetworkPolicy::Refused => Err(StudioError::new(code::READ_ONLY_JAIL, "the read-only jail refuses tunnels and child processes")),
        NetworkPolicy::LoopbackOnly => {
            if host::is_loopback_host(&spec.host.to_ascii_lowercase()) {
                Ok(())
            } else {
                Err(StudioError::new(code::TEST_JAIL, "the test jail allows loopback bastions only"))
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------------------------------------------------

fn opt(v: &mut Vec<String>, kv: impl Into<String>) {
    v.push("-o".into());
    v.push(kv.into());
}

pub struct MasterParams<'a> {
    pub spec: &'a SshSpec,
    /// `<dir>/c`
    pub control: &'a Path,
    /// The app-owned `mongo_known_hosts`.
    pub app_known_hosts: &'a Path,
    /// `<home>/.ssh/known_hosts`, consulted too unless the ssh config is switched off (`-F /dev/null`).
    pub home_known_hosts: Option<&'a Path>,
    pub connect_timeout_s: u32,
    pub policy: NetworkPolicy,
    /// A passphrase (key file) or password is supplied through the askpass FIFO.
    pub has_secret: bool,
}

/// The argv (without the program) of the ControlMaster: `ssh -N -T -M -S <ctl> ... -- <host>`.
///
/// Deviations from the spec text, both deliberate: `GlobalKnownHostsFile=/dev/null` (so the host-key status computed from
/// the two known_hosts files is exactly what ssh will accept) and `BatchMode=no -o NumberOfPasswordPrompts=1` for a key
/// that has a passphrase (BatchMode=yes makes ssh give up on an encrypted key without asking askpass; S1 item e).
pub fn master_argv(p: &MasterParams<'_>) -> Result<Vec<String>> {
    check_spec(p.spec)?;
    jail_host_check(p.spec, p.policy)?;
    let ctl = control_path(p.control)?;
    let mut v: Vec<String> = ["-N", "-T", "-M"].iter().map(|s| s.to_string()).collect();
    v.push("-S".into());
    v.push(ctl);
    for kv in [
        "ControlPersist=no",
        "ExitOnForwardFailure=yes",
        "ClearAllForwardings=yes",
        "ForwardAgent=no",
        "ForwardX11=no",
        "ForwardX11Trusted=no",
        "PermitLocalCommand=no",
        "RemoteCommand=none",
        "RequestTTY=no",
        "Tunnel=no",
        "PKCS11Provider=none",
        "AddKeysToAgent=no",
        "StrictHostKeyChecking=yes",
        "CheckHostIP=no",
        "VerifyHostKeyDNS=no",
        "UpdateHostKeys=no",
        "HashKnownHosts=no",
        "GlobalKnownHostsFile=/dev/null",
    ] {
        opt(&mut v, kv);
    }
    let off = config_off(p.spec, p.policy);
    let mut files = vec![quoted_path(p.app_known_hosts)?];
    if let (false, Some(h)) = (off, p.home_known_hosts) {
        files.push(quoted_path(h)?);
    }
    opt(&mut v, format!("UserKnownHostsFile={}", files.join(" ")));
    opt(&mut v, "ServerAliveInterval=15");
    opt(&mut v, "ServerAliveCountMax=3");
    opt(&mut v, format!("ConnectTimeout={}", p.connect_timeout_s.clamp(1, 60)));
    if off {
        v.push("-F".into());
        v.push("/dev/null".into());
    }
    if jail_active(p.policy) {
        opt(&mut v, "ProxyCommand=none");
        opt(&mut v, "ProxyJump=none");
    }
    if let Some(port) = p.spec.port {
        v.push("-p".into());
        v.push(port.to_string());
    }
    v.push("-l".into());
    v.push(p.spec.user.clone());
    match p.spec.auth {
        TunnelAuth::Agent => {
            opt(&mut v, "BatchMode=yes");
            opt(&mut v, "PreferredAuthentications=publickey");
        }
        TunnelAuth::KeyFile => {
            let key = p.spec.key_file.as_deref().unwrap_or_default();
            v.push("-i".into());
            v.push(pct(key));
            opt(&mut v, "IdentitiesOnly=yes");
            opt(&mut v, "IdentityAgent=none");
            if p.has_secret {
                opt(&mut v, "BatchMode=no");
                opt(&mut v, "PreferredAuthentications=publickey");
                opt(&mut v, "NumberOfPasswordPrompts=1");
            } else {
                opt(&mut v, "BatchMode=yes");
            }
        }
        TunnelAuth::Password => {
            opt(&mut v, "IdentityAgent=none");
            opt(&mut v, "BatchMode=no");
            opt(&mut v, "PreferredAuthentications=password,keyboard-interactive");
            opt(&mut v, "PubkeyAuthentication=no");
            opt(&mut v, "NumberOfPasswordPrompts=1");
        }
    }
    v.push("--".into());
    v.push(p.spec.host.clone());
    Ok(v)
}

/// The argv of one relay stream: `ssh -S <ctl> ... -W host:port -q -- <host>`. `ControlMaster=no` and
/// `ProxyCommand=false` make the child fail when the master is gone instead of silently opening a new session.
pub fn stream_argv(spec: &SshSpec, control: &Path, policy: NetworkPolicy, target_host: &str, target_port: u16) -> Result<Vec<String>> {
    check_spec(spec)?;
    jail_host_check(spec, policy)?;
    check_target(target_host, target_port)?;
    let mut v: Vec<String> = Vec::new();
    if config_off(spec, policy) {
        v.push("-F".into());
        v.push("/dev/null".into());
    }
    v.push("-S".into());
    v.push(control_path(control)?);
    for kv in ["ControlMaster=no", "ProxyCommand=false", "BatchMode=yes", "StrictHostKeyChecking=yes"] {
        opt(&mut v, kv);
    }
    v.push("-W".into());
    v.push(format!("{}:{}", target_host.to_ascii_lowercase(), target_port));
    v.push("-q".into());
    v.push("--".into());
    v.push(spec.host.clone());
    Ok(v)
}

/// `ssh -G`: prints the resolved configuration without connecting.
pub fn ssh_g_argv(spec: &SshSpec, policy: NetworkPolicy) -> Result<Vec<String>> {
    check_spec(spec)?;
    jail_host_check(spec, policy)?;
    let mut v: Vec<String> = Vec::new();
    if config_off(spec, policy) {
        v.push("-F".into());
        v.push("/dev/null".into());
    }
    v.push("-G".into());
    if let Some(port) = spec.port {
        v.push("-p".into());
        v.push(port.to_string());
    }
    v.push("-l".into());
    v.push(spec.user.clone());
    v.push("--".into());
    v.push(spec.host.clone());
    Ok(v)
}

// ---------------------------------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------------------------------

pub struct EnvInputs {
    pub home: String,
    /// The local OS user name (not the ssh user).
    pub user: String,
    /// The agent socket, used only for [`TunnelAuth::Agent`].
    pub auth_sock: Option<String>,
}

fn clean_value(s: &str) -> String {
    s.chars().filter(|c| *c != '\0').collect()
}

/// The environment of a helper that never authenticates (`ssh -G`, `ssh-keyscan`, `ssh-keygen`): rebuilt from nothing.
pub fn base_env(i: &EnvInputs) -> Vec<(String, String)> {
    vec![
        ("HOME".into(), clean_value(&i.home)),
        ("USER".into(), clean_value(&i.user)),
        ("LOGNAME".into(), clean_value(&i.user)),
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("LANG".into(), "C".into()),
    ]
}

/// The environment of the master: [`base_env`], `SSH_AUTH_SOCK` only for agent sign-in, and the askpass variables when a
/// secret is supplied. Nothing secret is ever in it.
pub fn ssh_env(i: &EnvInputs, auth: TunnelAuth, askpass: Option<&super::askpass::AskpassSetup>) -> Vec<(String, String)> {
    let mut env = base_env(i);
    if let (TunnelAuth::Agent, Some(sock)) = (auth, i.auth_sock.as_deref()) {
        env.push(("SSH_AUTH_SOCK".into(), clean_value(sock)));
    }
    if let Some(a) = askpass {
        env.extend(a.env());
    }
    env
}

// ---------------------------------------------------------------------------------------------------------------------
// `ssh -G`
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub hostname: String,
    pub port: u16,
    pub user: String,
    pub proxy_jump: Option<String>,
    pub proxy_command: Option<String>,
}

impl Resolved {
    /// A bastion reached through `ProxyJump` or `ProxyCommand` cannot be scanned directly.
    pub fn scannable(&self) -> bool {
        self.proxy_jump.is_none() && self.proxy_command.is_none()
    }
}

pub fn parse_ssh_g(out: &str) -> Result<Resolved> {
    let (mut hostname, mut port, mut user, mut jump, mut cmd) = (None, None, None, None, None);
    for line in out.lines() {
        let Some((k, v)) = line.split_once(' ') else { continue };
        let v = v.trim();
        let slot = match k {
            "hostname" => &mut hostname,
            "port" => &mut port,
            "user" => &mut user,
            "proxyjump" => &mut jump,
            "proxycommand" => &mut cmd,
            _ => continue,
        };
        if slot.is_none() {
            *slot = Some(v.to_string());
        }
    }
    let bad = || tunnel_error(tcode::CONFIG, "ssh -G returned a configuration that could not be read");
    let hostname = hostname.filter(|h| host_ok(h)).ok_or_else(bad)?.to_ascii_lowercase();
    let port: u16 = port.and_then(|p| p.parse().ok()).filter(|p| *p != 0).ok_or_else(bad)?;
    let user = user.filter(|u| user_ok(u)).ok_or_else(bad)?;
    let unset = |v: Option<String>| v.filter(|s| !s.is_empty() && s != "none");
    Ok(Resolved { hostname, port, user, proxy_jump: unset(jump), proxy_command: unset(cmd) })
}

/// Resolves the bastion with `ssh -G` (no connection is made). Jail-gated; under a jail `-F /dev/null` is forced, so
/// the answer is the spec itself.
pub fn resolve_host(ctx: &SshCtx<'_>, spec: &SshSpec) -> Result<Resolved> {
    gate(ctx.jail, spec)?;
    let policy = ctx.jail.policy();
    let args = ssh_g_argv(spec, policy)?;
    let out = ctx
        .runner
        .run(&RunRequest { program: &ctx.bin.ssh, args: &args, env: ctx.env, stdin: None, timeout: Duration::from_secs(5) })
        .map_err(|_| tunnel_error(tcode::NO_SSH, "ssh could not be started"))?;
    if out.timed_out || out.code != Some(0) {
        return Err(tunnel_error(tcode::CONFIG, format!("ssh -G failed: {}", sanitize_stderr(&out.stderr))));
    }
    let r = parse_ssh_g(&String::from_utf8_lossy(&out.stdout))?;
    // the answer decides which host is scanned and trusted: under the test jail it must still be a loopback host
    if policy == NetworkPolicy::LoopbackOnly && !host::is_loopback_host(&r.hostname) {
        return Err(StudioError::new(code::TEST_JAIL, "the test jail allows loopback bastions only"));
    }
    Ok(r)
}

// ---------------------------------------------------------------------------------------------------------------------
// Remote-influenced text
// ---------------------------------------------------------------------------------------------------------------------

fn is_bidi(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// ssh stderr is remote-influenced text: at most the first 8 KB, control and bidi-override characters stripped (newline
/// and tab kept). Callers scrub it with `host::scrub` before it goes anywhere.
pub fn sanitize_stderr(raw: &[u8]) -> String {
    let cap = raw.len().min(STDERR_CAP);
    String::from_utf8_lossy(&raw[..cap]).chars().filter(|c| (*c == '\n' || *c == '\t' || !c.is_control()) && !is_bidi(*c)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parsing() {
        assert_eq!(parse_version("OpenSSH_10.3p1, LibreSSL 3.3.6"), Some(SshVersion { major: 10, minor: 3 }));
        assert_eq!(parse_version("OpenSSH_8.4p1 Ubuntu"), Some(SshVersion { major: 8, minor: 4 }));
        assert_eq!(parse_version("dropbear"), None);
        assert!(SshVersion { major: 8, minor: 4 }.supports_askpass_force());
        assert!(!SshVersion { major: 8, minor: 3 }.supports_askpass_force());
    }
}
