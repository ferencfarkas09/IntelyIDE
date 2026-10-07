//! SSH tunnel on the user's own `ssh` plus an app-owned SOCKS5 relay. Unix only.
//!
//! `ssh` is only the authenticated transport: one ControlMaster per tunnel (`ssh -N -M -S <dir>/c`), and the relay
//! ([`relay`]) spawns `ssh -S <dir>/c -W host:port` over it for every stream the driver opens. Nothing in this module
//! connects, reconnects or scans by itself: every [`Tunnel::open`] is the result of a human click, and a master that
//! dies is reported through [`Tunnel::on_exit`] and never re-opened.
//!
//! Lifecycle of [`Tunnel::open`]: jail gate, validation, binary check, sweep of orphans of dead apps (once per process),
//! the private directory ([`dir`]), the askpass helper and its one FIFO ([`askpass`]), the master, the pid-file line
//! ([`sweep`]), the ready poll (`ssh -O check`), the relay. Every failure path tears down what was built so far
//! (`Drop`): the master is killed, the files and the directory are removed, the pid-file line is dropped. Teardown is
//! [`Tunnel::close`] (graceful `-O exit`), [`Tunnel::close_blocking`] (works without a runtime) or `Drop`.
//!
//! Error messages start with the diagnosis code (`tunnel.auth: ...`); remote-influenced ssh text is sanitised and scrubbed
//! of the user, the key path, the home directory and the secrets before it is appended.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use intely_settings::Secret;

use self::askpass::{AskpassKind, AskpassSetup, FifoOutcome};
use self::dir::TunnelDir;
use self::relay::{AllowRules, Relay, RelayConfig, SshSpawner, StreamFailure};
use self::ssh::{tcode, tunnel_error, CommandRunner, EnvInputs, FileFacts, RunRequest, SshBinary, SshCtx, SystemRunner};
use self::sweep::{PidEntry, ProcessTable, SystemProcs};
use crate::api::{HostKeyStatus, TunnelState};
use crate::connspec::{AllowedHost, HostPort, SshSpec, Tunnel as TunnelSpec, TunnelAuth};
use crate::error::{code, Result, StudioError};
use crate::host;
use crate::jail::{Jail, NetworkPolicy};

pub mod askpass;
pub mod dir;
pub mod knownhosts;
pub mod relay;
pub mod socks;
pub mod ssh;
pub mod sweep;

/// Diagnosis codes of the tunnel layer that `ssh.rs` (T4a) does not declare. The T3 classifier maps them to a step.
pub mod ocode {
    pub const AUTH: &str = "tunnel.auth";
    pub const DNS: &str = "tunnel.dns";
    pub const KEY_PERMS: &str = "tunnel.keyPerms";
    pub const INTERACTIVE: &str = "tunnel.interactive";
}

/// The destinations (`host:port`) the relay may be asked to reach.
#[derive(Debug, Clone, Default)]
pub struct AllowList {
    pub entries: Vec<HostPort>,
}

/// The loopback SOCKS5 endpoint the driver talks to (random per-tunnel credentials).
#[derive(Clone)]
pub struct Socks5Endpoint {
    pub port: u16,
    pub user: String,
    pub pass: String,
}

impl std::fmt::Debug for Socks5Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // never the credentials (same as `Relay`)
        f.debug_struct("Socks5Endpoint").field("port", &self.port).finish_non_exhaustive()
    }
}

#[derive(Debug, Default)]
pub struct TunnelSecrets {
    pub ssh_secret: Option<Secret>,
    pub key_password: Option<Secret>,
}

pub type CancelFlag = Arc<AtomicBool>;

// ---------------------------------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------------------------------

/// Starts the ssh master. The real launcher runs `Command`; tests count launches or wrap the real one.
pub trait MasterLauncher: Send + Sync {
    /// The child must have a piped stderr; stdin and stdout are not used.
    fn launch(&self, program: &Path, args: &[String], env: &[(String, String)]) -> io::Result<Child>;
}

pub struct SystemLauncher;

impl MasterLauncher for SystemLauncher {
    fn launch(&self, program: &Path, args: &[String], env: &[(String, String)]) -> io::Result<Child> {
        let mut cmd = Command::new(program);
        cmd.args(args).env_clear().envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
        cmd.spawn()
    }
}

/// Everything a tunnel needs from the process around it. [`TunnelEnv::new`] reads the process environment once; tests set
/// the public fields explicitly (no environment access in the tunnel code itself).
#[derive(Clone)]
pub struct TunnelEnv {
    pub jail: Jail,
    /// Holds `mongo_known_hosts` and `mongo-ssh.pids`.
    pub state_dir: PathBuf,
    /// Base of the private tunnel directories.
    pub temp_dir: PathBuf,
    pub home: PathBuf,
    /// The local OS user (not the ssh user).
    pub local_user: String,
    pub auth_sock: Option<String>,
    /// `INTELY_SSH_BINARY`; honoured only under the E2E jail.
    pub ssh_override: Option<String>,
    pub runner: Arc<dyn CommandRunner>,
    pub launcher: Arc<dyn MasterLauncher>,
    pub procs: Arc<dyn ProcessTable>,
    pub facts: fn(&Path) -> Option<FileFacts>,
    pub connect_timeout_s: u32,
    /// Pause between two `ssh -O check` polls.
    pub poll: Duration,
}

impl std::fmt::Debug for TunnelEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TunnelEnv").field("policy", &self.jail.policy()).finish_non_exhaustive()
    }
}

impl TunnelEnv {
    pub fn new(jail: Jail, state_dir: PathBuf) -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Self {
            jail,
            state_dir,
            temp_dir: std::env::temp_dir(),
            home: PathBuf::from(var("HOME").unwrap_or_else(|| "/var/empty".into())),
            local_user: var("USER").or_else(|| var("LOGNAME")).unwrap_or_else(|| "user".into()),
            auth_sock: var("SSH_AUTH_SOCK"),
            ssh_override: var("INTELY_SSH_BINARY"),
            runner: Arc::new(SystemRunner),
            launcher: Arc::new(SystemLauncher),
            procs: Arc::new(SystemProcs),
            facts: ssh::facts_of,
            connect_timeout_s: 10,
            poll: Duration::from_millis(150),
        }
    }

    pub fn app_known_hosts(&self) -> PathBuf {
        self.state_dir.join("mongo_known_hosts")
    }

    pub fn home_known_hosts(&self) -> PathBuf {
        self.home.join(".ssh").join("known_hosts")
    }

    fn env_inputs(&self) -> EnvInputs {
        EnvInputs { home: self.home.to_string_lossy().into_owned(), user: self.local_user.clone(), auth_sock: self.auth_sock.clone() }
    }

    /// The bases a tunnel directory can be created in (the temp directory, and `/tmp` for the short-path fallback).
    fn temp_bases(&self) -> Vec<PathBuf> {
        vec![self.temp_dir.clone(), PathBuf::from("/tmp")]
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------------

/// Over the control socket a failed `ssh -W` only says "Stdio forwarding request failed: Session open refused by peer", for
/// a forbidden forwarding and for a refused target alike (OpenSSH 10, seen against a real sshd). The reason is printed by the
/// master (`channel 2: open failed: administratively prohibited` or `... connect failed: Connection refused`): the newest line
/// that names one wins.
pub fn master_failure_code(master_stderr: &str) -> Option<&'static str> {
    master_stderr.lines().rev().find_map(|l| relay::classify_w_failure(&[l.to_string()]))
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What the master's stderr says, by substring. Only the `tunnel.*` codes are derived from remote text; the host-key
/// status itself is never taken from it (see [`Class::HostKey`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// ssh refused the host key. Unknown versus changed comes from `ssh-keygen -F`, not from this text.
    HostKey,
    Code(&'static str),
}

/// Classifies the (sanitised) stderr of a master that exited before it was ready. First match wins; unknown text is a
/// plain `tunnel.network`.
pub fn classify_master_stderr(text: &str) -> Class {
    let t = text.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| t.contains(n));
    if has(&["host key verification failed", "remote host identification has changed"]) {
        return Class::HostKey;
    }
    if has(&["authenticated with partial success", "verification code", "duo two-factor", "two-factor", "one-time password"]) {
        return Class::Code(ocode::INTERACTIVE);
    }
    if has(&["incorrect passphrase", "bad passphrase", "wrong passphrase"]) {
        return Class::Code(tcode::PASSPHRASE);
    }
    if has(&["unprotected private key file", "are too open"]) {
        return Class::Code(ocode::KEY_PERMS);
    }
    if has(&["bad owner or permissions", "bad configuration option", "garbage at end of line", "unsupported option", "terminating, 1 bad configuration"]) {
        return Class::Code(tcode::CONFIG);
    }
    if (t.contains("load key") && has(&["no such file", "invalid format", "not a valid"])) || (has(&["no such identity", "identity file"]) && has(&["not accessible", "no such file"])) {
        return Class::Code(tcode::KEY_FILE);
    }
    if has(&["permission denied", "too many authentication failures", "authentication failed", "no more authentication methods"]) {
        return Class::Code(ocode::AUTH);
    }
    if has(&["could not resolve hostname", "name or service not known", "nodename nor servname", "temporary failure in name resolution"]) {
        return Class::Code(ocode::DNS);
    }
    Class::Code(tcode::NETWORK)
}

/// The text appended to a tunnel error: the sanitised stderr with the user, key path, home directory and every secret
/// replaced by `***`, on one line, at most 300 characters.
fn detail(raw: &str, fragments: &[String]) -> String {
    let scrubbed = host::scrub(raw, fragments);
    let one: String = scrubbed.split_whitespace().collect::<Vec<_>>().join(" ");
    one.chars().take(300).collect()
}

fn fragments_of(env: &TunnelEnv, spec: &SshSpec, secrets: &TunnelSecrets) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    for s in [secrets.ssh_secret.as_ref(), secrets.key_password.as_ref()].into_iter().flatten() {
        v.push(s.expose().to_string());
    }
    if let Some(k) = &spec.key_file {
        v.push(k.clone());
    }
    v.push(spec.user.clone());
    let h = env.home.to_string_lossy().into_owned();
    if h.len() > 1 {
        v.push(h);
    }
    // an empty or one-character fragment would blank the whole message
    v.retain(|f| f.len() >= 2);
    // longest first, so a path is replaced before the user name inside it
    v.sort_by_key(|f| std::cmp::Reverse(f.len()));
    v
}

/// `%` is a token character in ssh option values (`ControlPath`).
fn ctl_arg(control: &Path) -> Result<String> {
    let s = control.to_str().ok_or_else(|| tunnel_error(tcode::CONFIG, "the control path is not valid text"))?;
    if !s.starts_with('/') || s.chars().any(|c| c.is_control()) || s.len() >= dir::MAX_CONTROL_PATH {
        return Err(tunnel_error(tcode::CONFIG, "the control path is not valid"));
    }
    Ok(s.replace('%', "%%"))
}

/// `ssh [-F /dev/null] -S <ctl> -O <check|exit> -- <host>`
pub fn control_argv(spec: &SshSpec, control: &Path, policy: NetworkPolicy, op: &str) -> Result<Vec<String>> {
    ssh::check_spec(spec)?;
    let mut v: Vec<String> = Vec::new();
    if ssh::config_off(spec, policy) {
        v.push("-F".into());
        v.push("/dev/null".into());
    }
    v.extend(["-S".to_string(), ctl_arg(control)?, "-O".to_string(), op.to_string(), "--".to_string(), spec.host.clone()]);
    Ok(v)
}

// ---------------------------------------------------------------------------------------------------------------------
// The tunnel
// ---------------------------------------------------------------------------------------------------------------------

struct Shared {
    /// The master runs and nobody is closing the tunnel.
    up: AtomicBool,
    closing: AtomicBool,
    /// The master ended without being asked to.
    died: AtomicBool,
    child: Mutex<Option<Child>>,
    callbacks: Mutex<Vec<Arc<dyn Fn() + Send + Sync>>>,
    stderr: Arc<Mutex<Vec<u8>>>,
}

impl Shared {
    fn new() -> Self {
        Self {
            up: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            died: AtomicBool::new(false),
            child: Mutex::new(None),
            callbacks: Mutex::new(Vec::new()),
            stderr: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// `Some(exit code)` once the master has ended.
    fn exited(&self) -> Option<Option<i32>> {
        let mut g = lock(&self.child);
        match g.as_mut() {
            None => Some(None),
            Some(c) => match c.try_wait() {
                Ok(Some(st)) => Some(st.code()),
                Ok(None) => None,
                Err(_) => Some(None),
            },
        }
    }

    fn kill_master(&self) {
        if let Some(c) = lock(&self.child).as_mut() {
            let _ = c.kill();
        }
    }

    fn reap(&self) {
        if let Some(mut c) = lock(&self.child).take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    fn mark_died(&self) {
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        self.up.store(false, Ordering::SeqCst);
        if self.died.swap(true, Ordering::SeqCst) {
            return;
        }
        let cbs: Vec<_> = lock(&self.callbacks).clone();
        for cb in cbs {
            cb();
        }
    }

    fn stderr_text(&self) -> String {
        ssh::sanitize_stderr(&lock(&self.stderr))
    }
}

const STDERR_KEEP: usize = 8 * 1024;

fn drain_stderr(mut err: std::process::ChildStderr, sink: Arc<Mutex<Vec<u8>>>) {
    use std::io::Read;
    std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            match err.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut s = lock(&sink);
                    let room = STDERR_KEEP.saturating_sub(s.len());
                    s.extend_from_slice(&buf[..n.min(room)]);
                }
            }
        }
    });
}

fn spawn_monitor(shared: Arc<Shared>) -> JoinHandle<()> {
    std::thread::spawn(move || loop {
        if shared.closing.load(Ordering::SeqCst) {
            return;
        }
        if shared.exited().is_some() {
            shared.mark_died();
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    })
}

struct Inner {
    env: TunnelEnv,
    spec: SshSpec,
    bin: SshBinary,
    dir: TunnelDir,
    control: PathBuf,
    shared: Arc<Shared>,
    relay: Option<Relay>,
    relay_task: Option<tokio::task::JoinHandle<()>>,
    monitor: Option<JoinHandle<()>>,
    askpass: Option<AskpassSetup>,
    writer: Option<(JoinHandle<FifoOutcome>, CancelFlag)>,
    registered: bool,
    torn_down: bool,
}

impl Inner {
    fn base_env(&self) -> Vec<(String, String)> {
        ssh::base_env(&self.env.env_inputs())
    }

    /// Stops the askpass writer (it unlinks the FIFO) and removes the helper.
    fn finish_askpass(&mut self) {
        if let Some((handle, cancel)) = self.writer.take() {
            cancel.store(true, Ordering::SeqCst);
            let _ = handle.join();
        }
        if let Some(a) = self.askpass.take() {
            askpass::remove(&a);
        }
    }

    /// Idempotent, runtime-free teardown. `graceful` asks the master to exit first (`ssh -O exit`, bounded).
    fn teardown(&mut self, graceful: Option<Duration>) {
        if self.torn_down {
            return;
        }
        self.torn_down = true;
        self.shared.closing.store(true, Ordering::SeqCst);
        self.shared.up.store(false, Ordering::SeqCst);
        self.finish_askpass();
        if let Some(t) = self.relay_task.take() {
            t.abort();
        }
        // dropping the relay aborts its accept task, which drops every stream and kills its `-W` child
        drop(self.relay.take());
        if let Some(limit) = graceful {
            if self.shared.exited().is_none() {
                if let Ok(args) = control_argv(&self.spec, &self.control, self.env.jail.policy(), "exit") {
                    let env = self.base_env();
                    let _ = self.env.runner.run(&RunRequest { program: &self.bin.ssh, args: &args, env: &env, stdin: None, timeout: limit.min(Duration::from_secs(2)) });
                }
                let t0 = Instant::now();
                while self.shared.exited().is_none() && t0.elapsed() < Duration::from_millis(400) {
                    std::thread::sleep(Duration::from_millis(15));
                }
            }
        }
        self.shared.kill_master();
        self.shared.reap();
        if let Some(m) = self.monitor.take() {
            let _ = m.join();
        }
        self.dir.remove();
        if self.registered {
            let _ = sweep::remove_entry(&self.env.jail, &self.env.state_dir, self.dir.path());
            self.registered = false;
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.teardown(None);
    }
}

pub struct Tunnel {
    inner: Option<Inner>,
    endpoint: Socks5Endpoint,
}

impl std::fmt::Debug for Tunnel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // never the SOCKS credentials
        f.debug_struct("Tunnel").field("state", &self.state()).field("port", &self.endpoint.port).finish()
    }
}

async fn blocking<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> Result<R> {
    tokio::task::spawn_blocking(f).await.map_err(|_| tunnel_error(tcode::CONFIG, "the tunnel worker stopped"))
}

fn cancelled() -> StudioError {
    StudioError::new(code::CANCELLED, "tunnel.cancelled: the tunnel was cancelled")
}

impl Tunnel {
    /// Opens the tunnel: the master, the ready check and the relay. A human action must be the reason for this call.
    ///
    /// Order: jail gate and validation, secrets present, binary check, sweep (once per process), private directory,
    /// askpass, master, pid-file line, ready poll, relay. A failure at any point tears everything down.
    pub async fn open(env: &TunnelEnv, spec: &SshSpec, secrets: &TunnelSecrets, allow: AllowList, cancel: CancelFlag) -> Result<Tunnel> {
        // 1. nothing is touched before the jail and the inputs are judged
        env.jail.policy().check_tunnel(&TunnelSpec::Ssh(spec.clone()), &allow.entries)?;
        ssh::check_spec(spec)?;
        let rules = AllowRules::from_allow_list(&allow)?;
        if rules.is_empty() {
            return Err(tunnel_error(tcode::CONFIG, "no database host is allowed through the tunnel"));
        }
        let secret = match spec.auth {
            TunnelAuth::Agent => None,
            TunnelAuth::KeyFile => secrets.key_password.as_ref(),
            TunnelAuth::Password => {
                if secrets.ssh_secret.is_none() {
                    return Err(StudioError::new(code::NEED_SECRET, "needs:sshSecret"));
                }
                secrets.ssh_secret.as_ref()
            }
        };
        if let Some(s) = secret {
            askpass::check_secret(s)?;
        }
        let frags = fragments_of(env, spec, secrets);
        let use_askpass = askpass::needs_askpass(spec.auth, secret.is_some());

        // 2. the binary (and its version, once, when a secret has to go through askpass)
        let mut bin = SshBinary::locate(env.jail.policy(), env.ssh_override.as_deref(), &env.facts)?;
        let base = ssh::base_env(&env.env_inputs());
        if use_askpass {
            bin.probe_version(&*env.runner, &env.jail, &base)?;
            bin.require_secret_mode()?;
        }
        let prompt_host = if spec.auth == TunnelAuth::Password {
            let ctx = SshCtx { runner: &*env.runner, bin: &bin, jail: &env.jail, env: &base };
            Some(ssh::resolve_host(&ctx, spec)?.hostname)
        } else {
            None
        };
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }

        // 3. orphans of dead apps, once per process
        let _ = sweep::sweep_once(&env.jail, &env.state_dir, &env.temp_bases(), &*env.procs);

        // 4. from here on every `?` drops `inner`, which tears down what exists
        let tdir = TunnelDir::create(&env.jail, &env.temp_dir)?;
        let control = tdir.control();
        let mut inner = Inner {
            env: env.clone(),
            spec: spec.clone(),
            bin: bin.clone(),
            dir: tdir,
            control: control.clone(),
            shared: Arc::new(Shared::new()),
            relay: None,
            relay_task: None,
            monitor: None,
            askpass: None,
            writer: None,
            registered: false,
            torn_down: false,
        };
        let connect_timeout = env.connect_timeout_s.clamp(1, 60);
        let budget = Duration::from_secs(u64::from(connect_timeout) + 15);

        let setup = if use_askpass {
            let kind = match spec.auth {
                TunnelAuth::KeyFile => AskpassKind::KeyPassphrase { key_path: spec.key_file.clone().unwrap_or_default() },
                _ => AskpassKind::Password { user: spec.user.clone(), host: prompt_host.clone().unwrap_or_else(|| spec.host.clone()) },
            };
            let s = askpass::install(&env.jail, inner.dir.path(), &kind)?;
            inner.askpass = Some(s.clone());
            Some(s)
        } else {
            None
        };

        let app_known = env.app_known_hosts();
        let home_known = env.home_known_hosts();
        let argv = ssh::master_argv(&ssh::MasterParams {
            spec,
            control: &control,
            app_known_hosts: &app_known,
            home_known_hosts: Some(&home_known),
            connect_timeout_s: connect_timeout,
            policy: env.jail.policy(),
            has_secret: use_askpass && spec.auth == TunnelAuth::KeyFile,
        })?;
        let master_env = ssh::ssh_env(&env.env_inputs(), spec.auth, setup.as_ref());

        let mut child = env.launcher.launch(&bin.ssh, &argv, &master_env).map_err(|_| tunnel_error(tcode::NO_SSH, "ssh could not be started"))?;
        let pid = child.id();
        if let Some(err) = child.stderr.take() {
            drain_stderr(err, inner.shared.stderr.clone());
        }
        *lock(&inner.shared.child) = Some(child);

        // the line is written right after the spawn, so a crash from here on leaves something the next start can sweep
        let entry = PidEntry {
            pid,
            start_time: env.procs.start_time(pid).unwrap_or_default(),
            owner_pid: std::process::id(),
            owner_start: env.procs.start_time(std::process::id()).unwrap_or_default(),
            dir: inner.dir.path().to_string_lossy().into_owned(),
        };
        sweep::add_entry(&env.jail, &env.state_dir, entry)?;
        inner.registered = true;

        if let (Some(setup), Some(secret)) = (setup.as_ref(), secret) {
            let flag: CancelFlag = Arc::new(AtomicBool::new(false));
            let handle = askpass::spawn_writer(setup.fifo_path(), secret, budget, flag.clone())?;
            inner.writer = Some((handle, flag));
        }

        // 5. ready poll
        let started = Instant::now();
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(cancelled());
            }
            if let Some(exit) = inner.shared.exited() {
                // let the drain thread read what the dead child wrote
                tokio::time::sleep(Duration::from_millis(60)).await;
                let text = inner.shared.stderr_text();
                return Err(Self::open_error(env, spec, &bin, &text, exit, &frags).await);
            }
            if control.exists() {
                let args = control_argv(spec, &control, env.jail.policy(), "check")?;
                let (runner, program, env_vars) = (env.runner.clone(), bin.ssh.clone(), base.clone());
                let out = blocking(move || runner.run(&RunRequest { program: &program, args: &args, env: &env_vars, stdin: None, timeout: Duration::from_secs(3) })).await?;
                if matches!(out, Ok(ref o) if o.code == Some(0) && !o.timed_out) {
                    break;
                }
            }
            if started.elapsed() >= budget {
                let why = detail(&inner.shared.stderr_text(), &frags);
                return Err(tunnel_error(tcode::NETWORK, format!("ssh did not become ready in {} s{}", budget.as_secs(), if why.is_empty() { String::new() } else { format!(": {why}") })));
            }
            tokio::time::sleep(env.poll).await;
        }
        // ssh does not ask again: the helper and the FIFO have done their job
        inner.finish_askpass();
        inner.shared.up.store(true, Ordering::SeqCst);

        // 6. the relay
        let spawner = SshSpawner::new(bin.ssh.clone(), spec.clone(), control.clone(), env.jail.policy(), base.clone());
        let cfg = RelayConfig::new(rules).with_members(allow.entries.len().max(1), 4);
        let relay = Relay::start(cfg, Arc::new(spawner)).await.map_err(|_| tunnel_error(tcode::NETWORK, "the local relay could not be started"))?;
        let endpoint = relay.endpoint();
        let mut closed = relay.subscribe_closed();
        let shared = inner.shared.clone();
        inner.relay_task = Some(tokio::spawn(async move {
            while closed.changed().await.is_ok() {
                if matches!(*closed.borrow(), Some(relay::CloseReason::TooManyFailures)) {
                    // the tunnel is not usable: end the master, the monitor reports it
                    shared.kill_master();
                    break;
                }
            }
        }));
        inner.relay = Some(relay);
        inner.monitor = Some(spawn_monitor(inner.shared.clone()));
        Ok(Tunnel { inner: Some(inner), endpoint })
    }

    /// The error for a master that ended before it was ready.
    async fn open_error(env: &TunnelEnv, spec: &SshSpec, bin: &SshBinary, text: &str, exit: Option<i32>, frags: &[String]) -> StudioError {
        let why = detail(text, frags);
        let with = |msg: &str| if why.is_empty() { msg.to_string() } else { format!("{msg}: {why}") };
        match classify_master_stderr(text) {
            Class::HostKey => {
                let (env2, spec2, bin2) = (env.clone(), spec.clone(), bin.clone());
                let report = blocking(move || {
                    let base = ssh::base_env(&env2.env_inputs());
                    let ctx = SshCtx { runner: &*env2.runner, bin: &bin2, jail: &env2.jail, env: &base };
                    knownhosts::inspect_host_key(&ctx, &spec2, &env2.app_known_hosts(), Some(&env2.home_known_hosts()))
                })
                .await;
                match report {
                    Ok(Ok(r)) => match r.status {
                        HostKeyStatus::Changed => ssh::host_key_error(tcode::HOST_KEY_CHANGED, "the server key differs from the saved one"),
                        HostKeyStatus::Unknown => ssh::host_key_error(tcode::HOST_KEY_UNKNOWN, "this server key is not trusted yet"),
                        HostKeyStatus::Known => tunnel_error(tcode::CONFIG, with("ssh refused a host key that is saved")),
                    },
                    Ok(Err(e)) if e.message.starts_with(tcode::HOST_KEY_UNSCANNABLE) => e,
                    // the scan itself failed: ssh still said the key is not trusted, the dialog reports the scan problem
                    _ => ssh::host_key_error(tcode::HOST_KEY_UNKNOWN, "this server key is not trusted yet"),
                }
            }
            Class::Code(c) => {
                let msg = match (c, exit) {
                    (tcode::NETWORK, Some(n)) => with(&format!("ssh ended with status {n} before the tunnel was ready")),
                    (tcode::NETWORK, None) => with("ssh ended before the tunnel was ready"),
                    _ => with("ssh could not set up the tunnel"),
                };
                tunnel_error(c, msg)
            }
        }
    }

    pub fn proxy(&self) -> Socks5Endpoint {
        self.endpoint.clone()
    }

    pub fn state(&self) -> TunnelState {
        match &self.inner {
            Some(i) if i.shared.up.load(Ordering::SeqCst) && !i.shared.closing.load(Ordering::SeqCst) => TunnelState::Up,
            _ => TunnelState::Down,
        }
    }

    /// Destinations the relay refused so far.
    pub fn refused(&self) -> Vec<HostPort> {
        self.inner.as_ref().and_then(|i| i.relay.as_ref()).map(Relay::refused).unwrap_or_default()
    }

    /// The last failed `-W` child (forwarding disabled, target refused), for the diagnosis.
    pub fn last_failure(&self) -> Option<StreamFailure> {
        let inner = self.inner.as_ref()?;
        let mut failure = inner.relay.as_ref().and_then(Relay::last_failure)?;
        if failure.code.is_none() {
            failure.code = master_failure_code(&inner.shared.stderr_text());
        }
        Some(failure)
    }

    /// Widens the allow-list with user-confirmed hosts (the "Allow these hosts" step).
    pub fn allow_more(&self, hosts: &[AllowedHost]) -> Result<()> {
        match self.inner.as_ref().and_then(|i| i.relay.as_ref()) {
            Some(r) => r.allow_more(hosts),
            None => Err(tunnel_error(tcode::NETWORK, "the tunnel is closed")),
        }
    }

    /// Registers `cb` to run when the master ends WITHOUT having been closed (connection lost, server restart, killed).
    /// Called at once when that has already happened. Nothing reconnects by itself.
    pub fn on_exit(&self, cb: Box<dyn Fn() + Send + Sync>) {
        let Some(i) = &self.inner else { return };
        let cb: Arc<dyn Fn() + Send + Sync> = Arc::from(cb);
        let already = {
            let mut g = lock(&i.shared.callbacks);
            if i.shared.died.load(Ordering::SeqCst) {
                true
            } else {
                g.push(cb.clone());
                false
            }
        };
        if already {
            cb();
        }
    }

    /// Graceful close: the relay stops, `ssh -O exit` (2 s), then the master is killed if it is still there, and the
    /// directory, the files and the pid-file line are removed.
    pub async fn close(mut self) {
        if let Some(mut inner) = self.inner.take() {
            if let Some(r) = inner.relay.take() {
                r.shutdown().await;
            }
            // if the runtime is going away the closure is dropped, and `Drop` finishes the job
            let _ = tokio::task::spawn_blocking(move || inner.teardown(Some(Duration::from_secs(2)))).await;
        }
    }

    /// The same without a runtime (quit, `RunEvent::Exit`). `timeout` bounds the graceful `-O exit`.
    pub fn close_blocking(mut self, timeout: Duration) {
        if let Some(mut inner) = self.inner.take() {
            inner.teardown(Some(timeout));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn master_stderr_is_classified_by_substring_into_tunnel_codes() {
        let c = |t: &str| classify_master_stderr(t);
        assert_eq!(c("No ED25519 host key is known for h and you have requested strict checking.\nHost key verification failed."), Class::HostKey);
        assert_eq!(c("@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @"), Class::HostKey);
        assert_eq!(c("u@h: Permission denied (publickey,password)."), Class::Code(ocode::AUTH));
        assert_eq!(c("Load key \"/k\": incorrect passphrase supplied to decrypt private key"), Class::Code(tcode::PASSPHRASE));
        assert_eq!(c("@ WARNING: UNPROTECTED PRIVATE KEY FILE! @"), Class::Code(ocode::KEY_PERMS));
        assert_eq!(c("Load key \"/k\": No such file or directory"), Class::Code(tcode::KEY_FILE));
        assert_eq!(c("/home/u/.ssh/config line 3: Bad configuration option: foo"), Class::Code(tcode::CONFIG));
        assert_eq!(c("ssh: Could not resolve hostname x: Name or service not known"), Class::Code(ocode::DNS));
        assert_eq!(c("Authenticated with partial success.\nPermission denied"), Class::Code(ocode::INTERACTIVE));
        assert_eq!(c("ssh: connect to host h port 22: Connection refused"), Class::Code(tcode::NETWORK));
        assert_eq!(c(""), Class::Code(tcode::NETWORK));
        // a hostile server banner cannot move the verdict to a host-key trust decision by itself: the status comes
        // from ssh-keygen, this text only triggers the look-up
        assert_eq!(c("welcome, everything is fine"), Class::Code(tcode::NETWORK));
    }

    #[test]
    fn a_mux_w_failure_is_told_apart_by_the_masters_own_line() {
        // real OpenSSH 10 master stderr, AllowTcpForwarding no / a closed target port
        assert_eq!(master_failure_code("channel 2: open failed: administratively prohibited: open failed\n"), Some("tunnel.forwardingDisabled"));
        assert_eq!(master_failure_code("channel 2: open failed: connect failed: Connection refused\n"), Some("tunnel.targetRefused"));
        // the newest verdict wins
        assert_eq!(master_failure_code("channel 2: open failed: connect failed: Connection refused\nchannel 3: open failed: administratively prohibited: open failed\n"), Some("tunnel.forwardingDisabled"));
        assert_eq!(master_failure_code("Warning: Permanently added '[127.0.0.1]:22' (ED25519) to the list of known hosts.\n"), None);
        assert_eq!(master_failure_code(""), None);
    }

    #[test]
    fn error_detail_hides_the_user_the_key_the_home_and_the_secrets() {
        let frags = vec!["/Users/alice/.ssh/id_work".to_string(), "hunter2-secret".to_string(), "alice".to_string()];
        let d = detail("alice@h: Permission denied\nLoad key /Users/alice/.ssh/id_work: hunter2-secret\n", &frags);
        for bad in ["alice", "hunter2", "id_work"] {
            assert!(!d.contains(bad), "{d}");
        }
        assert!(!d.contains('\n'));
        assert!(detail(&"x ".repeat(500), &[]).chars().count() <= 300);
    }

    #[test]
    fn control_argv_is_validated_and_escapes_percent() {
        let mut s = SshSpec { host: "bastion".into(), user: "u".into(), ..Default::default() };
        let v = control_argv(&s, Path::new("/tmp/intely-ssh-1-0/c"), NetworkPolicy::Full, "check").unwrap();
        assert_eq!(v, ["-S", "/tmp/intely-ssh-1-0/c", "-O", "check", "--", "bastion"]);
        let v = control_argv(&s, Path::new("/tmp/a%b/c"), NetworkPolicy::LoopbackOnly, "exit").unwrap();
        assert_eq!(&v[..4], ["-F", "/dev/null", "-S", "/tmp/a%%b/c"]);
        s.host = "-oProxyCommand=x".into();
        assert!(control_argv(&s, Path::new("/tmp/c"), NetworkPolicy::Full, "check").is_err());
        s.host = "bastion".into();
        assert!(control_argv(&s, Path::new("relative/c"), NetworkPolicy::Full, "check").is_err());
        assert!(control_argv(&s, Path::new(&format!("/{}/c", "a".repeat(120))), NetworkPolicy::Full, "check").is_err());
    }

    #[test]
    fn the_socks5_endpoint_debug_hides_the_credentials() {
        let e = Socks5Endpoint { port: 1080, user: "user-CANARY".into(), pass: "pass-CANARY".into() };
        let text = format!("{e:?}");
        assert!(text.contains("1080") && !text.contains("CANARY"), "{text}");
    }
}
