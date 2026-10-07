//! The loopback SOCKS5 relay with the destination allow-list (T4b).
//!
//! `ssh` is only the authenticated transport (spec 5.7). The driver talks SOCKS5 to this relay on `127.0.0.1:<random>`
//! with two random per-tunnel credentials; for every accepted CONNECT the relay asks a [`Spawner`] for a byte stream to
//! `host:port`. The real spawner ([`SshSpawner`]) runs `ssh -S <ctl> ... -W host:port` over the already-authenticated
//! master, so TLS verification, SNI and replica-set discovery with real member names work unchanged and no port is ever
//! opened by ssh itself. Tests drive the same code with an in-process spawner.
//!
//! Limits (all enforced here): at most [`DEFAULT_MAX_UNAUTHENTICATED`] sockets before authentication (the next one is
//! closed at once), a handshake deadline, a cap on concurrent streams ([`stream_cap`]), a token bucket on spawned
//! children, and the whole relay closes after [`DEFAULT_MAX_CONSECUTIVE_FAILURES`] consecutive failed children. A
//! destination is served only when it is on the allow-list ([`AllowRules`]); every refusal is recorded so the diagnosis can
//! say `tunnel.notAllowed` with the host instead of a bare "no server".
//!
//! Nothing here connects by itself, reconnects, or touches the disk. Unix only (the module is `cfg(unix)`).

use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::{JoinHandle, JoinSet};

use super::socks::{self, ct_eq, reply, Dest, SocksError};
use super::ssh::{self, tcode, tunnel_error};
use super::{AllowList, Socks5Endpoint};
use crate::connspec::{AllowedHost, HostPort, SshSpec};
use crate::error::Result;
use crate::jail::NetworkPolicy;

/// Diagnosis codes the relay and its spawner produce (the T3 classifier maps them to a step and fixes).
pub mod rcode {
    pub const NOT_ALLOWED: &str = "tunnel.notAllowed";
    pub const FORWARDING_DISABLED: &str = "tunnel.forwardingDisabled";
    pub const TARGET_REFUSED: &str = "tunnel.targetRefused";
    pub use super::tcode::IPV6;
}

pub const DEFAULT_MAX_UNAUTHENTICATED: usize = 8;
pub const DEFAULT_MAX_CONSECUTIVE_FAILURES: u32 = 20;
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// 20 spawned `-W` children per second, burst 40.
pub const DEFAULT_BUCKET_BURST: u32 = 40;
pub const DEFAULT_BUCKET_PER_SEC: u32 = 20;
/// How long a finished stream waits for its child's exit status before it counts as neither success nor failure.
pub const DEFAULT_FINISH_GRACE: Duration = Duration::from_secs(3);
/// The driver's default seed port when a host list entry has none.
const DEFAULT_MONGO_PORT: u16 = 27017;
const MAX_RULES: usize = 256;
const MAX_REFUSED: usize = 64;
const STDERR_KEEP_LINES: usize = 5;

/// `max(64, members x (maxPoolSize + 2) + 8)`; the pool size is clamped to 4 under a tunnel (spec 5.7.7).
pub fn stream_cap(members: usize, max_pool_size: u32) -> usize {
    let pool = max_pool_size.clamp(1, 4) as usize;
    (members.max(1).saturating_mul(pool + 2).saturating_add(8)).max(64)
}

// ---------------------------------------------------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------------------------------------------------

fn norm_host(h: &str) -> String {
    let h = h.trim().to_ascii_lowercase();
    h.strip_suffix('.').map(str::to_owned).unwrap_or(h)
}

/// Strict dotted-quad parse: four decimal octets, no leading zeros.
fn strict_ipv4(h: &str) -> Option<[u8; 4]> {
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut out = [0u8; 4];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit()) || (p.len() > 1 && p.starts_with('0')) {
            return None;
        }
        out[i] = p.parse().ok()?;
    }
    Some(out)
}

const METADATA_NAMES: &[&str] = &["metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal", "metadata.azure.com"];

/// Link-local (169.254.0.0/16), cloud metadata names, and every numeric spelling that is not a plain dotted quad (a
/// decimal, octal or hex integer could hide 169.254.169.254).
fn blocked_address(host: &str) -> bool {
    let h = norm_host(host);
    if METADATA_NAMES.contains(&h.as_str()) {
        return true;
    }
    let numeric = h.bytes().all(|b| b.is_ascii_digit() || b == b'.') || h.starts_with("0x");
    if !numeric {
        return false;
    }
    match strict_ipv4(&h) {
        Some(o) => o[0] == 169 && o[1] == 254,
        None => true,
    }
}

/// The "Allow this host" validator: a plain host name or dotted quad plus a port. IPv6 literals, link-local and metadata
/// addresses are refused. Returns the normalised entry.
pub fn validate_allow_host(host: &str, port: u16) -> Result<AllowedHost> {
    ssh::check_target(host, port)?;
    if blocked_address(host) {
        return Err(tunnel_error(tcode::CONFIG, "link-local and cloud metadata addresses cannot be allowed"));
    }
    Ok(AllowedHost { host: norm_host(host), port })
}

/// The parent domain of an SRV name: everything after the first label (`c0.ab12c.mongodb.net` -> `ab12c.mongodb.net`).
/// The driver requires at least three labels.
pub fn srv_parent_domain(srv_host: &str) -> Result<String> {
    let h = norm_host(srv_host);
    let labels: Vec<&str> = h.split('.').collect();
    if labels.len() < 3 || labels.iter().any(|l| l.is_empty()) || !ssh::host_ok(&h) {
        return Err(tunnel_error(tcode::CONFIG, "the SRV name must have at least three labels"));
    }
    Ok(labels[1..].join("."))
}

/// What the relay may be asked to reach: exact `host:port` pairs, and parent domains (SRV) for which any subdomain on any
/// port is allowed (the SRV record chooses the port; the driver enforces the same suffix rule).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AllowRules {
    exact: Vec<(String, u16)>,
    parents: Vec<String>,
}

impl AllowRules {
    /// Standard scheme: the seed hosts (port 27017 when none) plus the user's `allowed_hosts`.
    pub fn standard(seeds: &[HostPort], extra: &[AllowedHost]) -> Result<Self> {
        let mut r = Self::default();
        for s in seeds {
            let port = s.port.unwrap_or(DEFAULT_MONGO_PORT);
            ssh::check_target(&s.host, port)?;
            r.push_exact(&s.host, port)?;
        }
        r.extend(extra)?;
        Ok(r)
    }

    /// SRV scheme: any subdomain of the SRV name's parent domain, plus the user's `allowed_hosts`.
    pub fn srv(srv_host: &str, extra: &[AllowedHost]) -> Result<Self> {
        let mut r = Self { exact: Vec::new(), parents: vec![srv_parent_domain(srv_host)?] };
        r.extend(extra)?;
        Ok(r)
    }

    /// From the lean [`AllowList`]: an entry with a port is exact; an entry without one is an SRV name (parent domain).
    pub fn from_allow_list(list: &AllowList) -> Result<Self> {
        let mut r = Self::default();
        for e in &list.entries {
            match e.port {
                Some(p) => {
                    ssh::check_target(&e.host, p)?;
                    r.push_exact(&e.host, p)?;
                }
                None => r.parents.push(srv_parent_domain(&e.host)?),
            }
        }
        Ok(r)
    }

    fn push_exact(&mut self, host: &str, port: u16) -> Result<()> {
        if self.exact.len() >= MAX_RULES {
            return Err(tunnel_error(tcode::CONFIG, "too many allowed hosts"));
        }
        let h = norm_host(host);
        if !self.exact.iter().any(|(eh, ep)| *eh == h && *ep == port) {
            self.exact.push((h, port));
        }
        Ok(())
    }

    /// Adds user-confirmed hosts after the "Allow this host" validation (link-local and metadata refused).
    pub fn extend(&mut self, hosts: &[AllowedHost]) -> Result<()> {
        for a in hosts {
            let v = validate_allow_host(&a.host, a.port)?;
            self.push_exact(&v.host, v.port)?;
        }
        Ok(())
    }

    pub fn permits(&self, host: &str, port: u16) -> bool {
        let h = norm_host(host);
        if self.exact.iter().any(|(eh, ep)| *eh == h && *ep == port) {
            return true;
        }
        self.parents.iter().any(|p| h.len() > p.len() + 1 && h.ends_with(p.as_str()) && h.as_bytes()[h.len() - p.len() - 1] == b'.')
    }

    pub fn is_empty(&self) -> bool {
        self.exact.is_empty() && self.parents.is_empty()
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Token bucket (pure; the caller passes the clock)
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct TokenBucket {
    capacity: f64,
    per_sec: f64,
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    pub fn new(burst: u32, per_sec: u32, now: Instant) -> Self {
        Self { capacity: f64::from(burst), per_sec: f64::from(per_sec), tokens: f64::from(burst), last: now }
    }

    pub fn try_take(&mut self, now: Instant) -> bool {
        let dt = now.saturating_duration_since(self.last).as_secs_f64();
        self.last = self.last.max(now);
        self.tokens = (self.tokens + dt * self.per_sec).min(self.capacity);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The spawner seam
// ---------------------------------------------------------------------------------------------------------------------

/// A byte stream the relay can bridge to a client socket.
pub trait Duplex: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Duplex for T {}

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// How a stream's child ended. `success` is false only when the child failed by itself (non-zero exit); a child the relay
/// stopped, or one still running at the grace deadline, is not a failure.
#[derive(Debug, Clone, Default)]
pub struct StreamOutcome {
    pub success: bool,
    /// The last few stderr lines, sanitised (control and bidi characters stripped). Remote-influenced: scrub before display.
    pub stderr_tail: Vec<String>,
}

pub struct Spawned {
    pub io: Box<dyn Duplex>,
    /// Resolves when the child has exited. Owns the child: dropping it (the relay closed) kills it.
    pub finished: BoxFuture<StreamOutcome>,
}

pub trait Spawner: Send + Sync + 'static {
    fn spawn(&self, host: &str, port: u16) -> io::Result<Spawned>;
}

/// The last failed `-W` child, for the diagnosis.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamFailure {
    pub target: HostPort,
    /// `tunnel.forwardingDisabled`, `tunnel.targetRefused` or none (unclassified).
    pub code: Option<&'static str>,
    pub lines: Vec<String>,
}

/// Maps the stderr of a failed `ssh -W` to a `tunnel.*` code by substring. Only these two are derived from remote text.
pub fn classify_w_failure(lines: &[String]) -> Option<&'static str> {
    let has = |needle: &str| lines.iter().any(|l| l.to_ascii_lowercase().contains(needle));
    if has("administratively prohibited") {
        Some(rcode::FORWARDING_DISABLED)
    } else if has("open failed: connect failed") || has("connection refused") {
        Some(rcode::TARGET_REFUSED)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The real spawner: `ssh -S <ctl> ... -W host:port`
// ---------------------------------------------------------------------------------------------------------------------

/// Spawns one `ssh -W` child per stream over the master's control socket. The argv comes from [`ssh::stream_argv`]
/// (validated host, `--`, no shell); the environment is exactly `env`. Under the read-only jail nothing is spawned.
pub struct SshSpawner {
    program: PathBuf,
    spec: SshSpec,
    control: PathBuf,
    policy: NetworkPolicy,
    env: Vec<(String, String)>,
}

impl SshSpawner {
    pub fn new(program: PathBuf, spec: SshSpec, control: PathBuf, policy: NetworkPolicy, env: Vec<(String, String)>) -> Self {
        Self { program, spec, control, policy, env }
    }
}

impl std::fmt::Debug for SshSpawner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshSpawner").field("policy", &self.policy).finish_non_exhaustive()
    }
}

async fn read_tail(err: tokio::process::ChildStderr) -> Vec<String> {
    let mut buf = Vec::with_capacity(1024);
    let _ = err.take(8 * 1024).read_to_end(&mut buf).await;
    let text = ssh::sanitize_stderr(&buf);
    let mut lines: Vec<String> = text.lines().map(|l| l.trim().chars().take(200).collect::<String>()).filter(|l| !l.is_empty()).collect();
    let drop_n = lines.len().saturating_sub(STDERR_KEEP_LINES);
    lines.drain(..drop_n);
    lines
}

/// A child's stdout and stdin as one duplex stream. Shutting it down closes the child's stdin (tokio's own
/// `ChildStdin::poll_shutdown` does nothing), which is what tells `ssh -W` that the client is done.
struct ChildIo {
    stdout: tokio::process::ChildStdout,
    stdin: Option<tokio::process::ChildStdin>,
}

impl AsyncRead for ChildIo {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<io::Result<()>> {
        Pin::new(&mut self.stdout).poll_read(cx, buf)
    }
}

impl AsyncWrite for ChildIo {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &[u8]) -> std::task::Poll<io::Result<usize>> {
        match self.stdin.as_mut() {
            Some(w) => Pin::new(w).poll_write(cx, buf),
            None => std::task::Poll::Ready(Err(io::ErrorKind::BrokenPipe.into())),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<io::Result<()>> {
        match self.stdin.as_mut() {
            Some(w) => Pin::new(w).poll_flush(cx),
            None => std::task::Poll::Ready(Ok(())),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, _cx: &mut std::task::Context<'_>) -> std::task::Poll<io::Result<()>> {
        self.stdin.take();
        std::task::Poll::Ready(Ok(()))
    }
}

impl Spawner for SshSpawner {
    fn spawn(&self, host: &str, port: u16) -> io::Result<Spawned> {
        if self.policy == NetworkPolicy::Refused {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "the read-only jail starts no child process"));
        }
        let argv = ssh::stream_argv(&self.spec, &self.control, self.policy, host, port).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.message))?;
        let mut cmd = tokio::process::Command::new(&self.program);
        cmd.args(&argv).env_clear().envs(self.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
        let mut child = cmd.spawn()?;
        let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
            return Err(io::Error::other("the child has no pipes"));
        };
        let io: Box<dyn Duplex> = Box::new(ChildIo { stdout, stdin: Some(stdin) });
        let finished: BoxFuture<StreamOutcome> = Box::pin(async move {
            let (status, stderr_tail) = tokio::join!(child.wait(), read_tail(stderr));
            StreamOutcome { success: status.map(|s| s.success()).unwrap_or(false), stderr_tail }
        });
        Ok(Spawned { io, finished })
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct RelayConfig {
    pub allow: AllowRules,
    pub max_streams: usize,
    pub max_unauthenticated: usize,
    pub handshake_timeout: Duration,
    pub bucket_burst: u32,
    pub bucket_per_sec: u32,
    pub max_consecutive_failures: u32,
    pub finish_grace: Duration,
}

impl RelayConfig {
    pub fn new(allow: AllowRules) -> Self {
        Self {
            allow,
            max_streams: stream_cap(1, 4),
            max_unauthenticated: DEFAULT_MAX_UNAUTHENTICATED,
            handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
            bucket_burst: DEFAULT_BUCKET_BURST,
            bucket_per_sec: DEFAULT_BUCKET_PER_SEC,
            max_consecutive_failures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
            finish_grace: DEFAULT_FINISH_GRACE,
        }
    }

    /// The stream cap for a replica set of `members` nodes at the given pool size.
    pub fn with_members(mut self, members: usize, max_pool_size: u32) -> Self {
        self.max_streams = stream_cap(members, max_pool_size);
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    /// [`Relay::shutdown`] was called.
    Shutdown,
    /// [`DEFAULT_MAX_CONSECUTIVE_FAILURES`] `-W` children in a row failed: the tunnel is not usable.
    TooManyFailures,
}

/// Counters for tests and the diagnosis.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RelayStats {
    pub accepted: usize,
    pub unauthenticated_rejected: usize,
    pub auth_failed: usize,
    pub refused: usize,
    pub ipv6_refused: usize,
    pub stream_cap_hits: usize,
    pub rate_limited: usize,
    pub spawned: usize,
}

#[derive(Default)]
struct Counters {
    accepted: AtomicUsize,
    unauthenticated_rejected: AtomicUsize,
    auth_failed: AtomicUsize,
    refused: AtomicUsize,
    ipv6_refused: AtomicUsize,
    stream_cap_hits: AtomicUsize,
    rate_limited: AtomicUsize,
    spawned: AtomicUsize,
}

struct Shared {
    cfg: RelayConfig,
    user: String,
    pass: String,
    spawner: Arc<dyn Spawner>,
    allow: Mutex<AllowRules>,
    refused: Mutex<Vec<HostPort>>,
    bucket: Mutex<TokenBucket>,
    last_failure: Mutex<Option<StreamFailure>>,
    unauth: Arc<AtomicUsize>,
    streams: Arc<AtomicUsize>,
    consecutive: AtomicU32,
    closed: watch::Sender<Option<CloseReason>>,
    n: Counters,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A counted slot released on drop.
struct Slot(Arc<AtomicUsize>);

impl Slot {
    fn acquire(counter: &Arc<AtomicUsize>, max: usize) -> Option<Slot> {
        if counter.fetch_add(1, Ordering::SeqCst) >= max {
            counter.fetch_sub(1, Ordering::SeqCst);
            None
        } else {
            Some(Slot(counter.clone()))
        }
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Shared {
    fn close(&self, reason: CloseReason) {
        self.closed.send_if_modified(|v| {
            if v.is_none() {
                *v = Some(reason);
                true
            } else {
                false
            }
        });
    }

    fn record_refused(&self, host: &str, port: u16) {
        self.n.refused.fetch_add(1, Ordering::Relaxed);
        let entry = HostPort { host: norm_host(host), port: Some(port) };
        let mut list = lock(&self.refused);
        if list.len() < MAX_REFUSED && !list.contains(&entry) {
            list.push(entry);
        }
    }

    fn note_failure(&self, host: &str, port: u16, lines: Vec<String>) {
        let n = self.consecutive.fetch_add(1, Ordering::SeqCst) + 1;
        let code = classify_w_failure(&lines);
        *lock(&self.last_failure) = Some(StreamFailure { target: HostPort { host: norm_host(host), port: Some(port) }, code, lines });
        if n >= self.cfg.max_consecutive_failures {
            self.close(CloseReason::TooManyFailures);
        }
    }

    fn credentials_ok(&self, user: &[u8], pass: &[u8]) -> bool {
        // both comparisons always run
        let u = ct_eq(user, self.user.as_bytes());
        let p = ct_eq(pass, self.pass.as_bytes());
        u & p
    }
}

fn random_hex() -> io::Result<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

pub struct Relay {
    shared: Arc<Shared>,
    port: u16,
    task: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for Relay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // never the credentials
        f.debug_struct("Relay").field("port", &self.port).field("closed", &self.closed()).finish()
    }
}

impl Relay {
    /// Binds `127.0.0.1:0`, draws two random 128-bit credentials and starts accepting. Nothing is spawned until a client
    /// has authenticated and asked for an allowed destination.
    pub async fn start(cfg: RelayConfig, spawner: Arc<dyn Spawner>) -> io::Result<Relay> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let (closed, closed_rx) = watch::channel(None);
        let shared = Arc::new(Shared {
            user: random_hex()?,
            pass: random_hex()?,
            allow: Mutex::new(cfg.allow.clone()),
            refused: Mutex::new(Vec::new()),
            bucket: Mutex::new(TokenBucket::new(cfg.bucket_burst, cfg.bucket_per_sec, Instant::now())),
            last_failure: Mutex::new(None),
            unauth: Arc::new(AtomicUsize::new(0)),
            streams: Arc::new(AtomicUsize::new(0)),
            consecutive: AtomicU32::new(0),
            closed,
            n: Counters::default(),
            spawner,
            cfg,
        });
        let task = tokio::spawn(accept_loop(shared.clone(), listener, closed_rx));
        Ok(Relay { shared, port, task: Some(task) })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The endpoint (port and credentials) to hand to the driver as its SOCKS5 proxy.
    pub fn endpoint(&self) -> Socks5Endpoint {
        Socks5Endpoint { port: self.port, user: self.shared.user.clone(), pass: self.shared.pass.clone() }
    }

    /// Destinations refused so far (deduplicated, at most 64).
    pub fn refused(&self) -> Vec<HostPort> {
        lock(&self.shared.refused).clone()
    }

    pub fn stats(&self) -> RelayStats {
        let n = &self.shared.n;
        RelayStats {
            accepted: n.accepted.load(Ordering::Relaxed),
            unauthenticated_rejected: n.unauthenticated_rejected.load(Ordering::Relaxed),
            auth_failed: n.auth_failed.load(Ordering::Relaxed),
            refused: n.refused.load(Ordering::Relaxed),
            ipv6_refused: n.ipv6_refused.load(Ordering::Relaxed),
            stream_cap_hits: n.stream_cap_hits.load(Ordering::Relaxed),
            rate_limited: n.rate_limited.load(Ordering::Relaxed),
            spawned: n.spawned.load(Ordering::Relaxed),
        }
    }

    pub fn active_streams(&self) -> usize {
        self.shared.streams.load(Ordering::SeqCst)
    }

    pub fn consecutive_failures(&self) -> u32 {
        self.shared.consecutive.load(Ordering::SeqCst)
    }

    pub fn last_failure(&self) -> Option<StreamFailure> {
        lock(&self.shared.last_failure).clone()
    }

    /// Widens the allow-list with user-confirmed hosts (validated: no link-local or metadata addresses).
    pub fn allow_more(&self, hosts: &[AllowedHost]) -> Result<()> {
        lock(&self.shared.allow).extend(hosts)
    }

    pub fn closed(&self) -> Option<CloseReason> {
        *self.shared.closed.borrow()
    }

    /// Resolves with the reason once the relay has closed (use it to close the tunnel behind it).
    pub fn subscribe_closed(&self) -> watch::Receiver<Option<CloseReason>> {
        self.shared.closed.subscribe()
    }

    /// Stops accepting, drops every open stream (their children are killed) and waits for the accept task.
    pub async fn shutdown(mut self) {
        self.shared.close(CloseReason::Shutdown);
        if let Some(t) = self.task.take() {
            let _ = t.await;
        }
    }
}

impl Drop for Relay {
    /// Works without a runtime: aborting the accept task drops its listener and every stream task with their children.
    fn drop(&mut self) {
        self.shared.close(CloseReason::Shutdown);
        if let Some(t) = self.task.take() {
            t.abort();
        }
    }
}

async fn accept_loop(shared: Arc<Shared>, listener: TcpListener, mut closed: watch::Receiver<Option<CloseReason>>) {
    let mut tasks: JoinSet<()> = JoinSet::new();
    loop {
        tokio::select! {
            _ = closed.changed() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
            accepted = listener.accept() => match accepted {
                Ok((sock, _)) => {
                    shared.n.accepted.fetch_add(1, Ordering::Relaxed);
                    tasks.spawn(handle_conn(shared.clone(), sock));
                }
                // out of descriptors or a transient accept error: back off instead of spinning
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            },
        }
    }
    // dropping `tasks` aborts every stream task; their children are `kill_on_drop`
}

async fn handshake(sh: &Shared, sock: &mut TcpStream, unauth: &mut Option<Slot>) -> std::result::Result<socks::Request, SocksError> {
    let methods = socks::read_greeting(sock).await?;
    let method = socks::choose_method(&methods);
    socks::write_method(sock, method).await?;
    if method.is_none() {
        return Err(SocksError::NoAcceptableMethod);
    }
    let (user, pass) = socks::read_password_auth(sock).await?;
    let ok = sh.credentials_ok(&user, &pass);
    socks::write_auth_status(sock, ok).await?;
    if !ok {
        sh.n.auth_failed.fetch_add(1, Ordering::Relaxed);
        return Err(SocksError::Auth);
    }
    // from here on the socket is authenticated and no longer counts against the unauthenticated cap
    unauth.take();
    match socks::read_request(sock).await {
        Ok(r) => Ok(r),
        Err(e) => {
            let _ = socks::write_reply(sock, e.reply_code()).await;
            Err(e)
        }
    }
}

/// Copies both ways. A client that stops sending is passed on as end-of-input to the child and its answer is still
/// delivered; a child that stops answering (it exited) ends the stream at once instead of waiting for the client.
async fn bridge(sock: &mut TcpStream, io: Box<dyn Duplex>) {
    let (mut cr, mut cw) = sock.split();
    let (mut ur, mut uw) = tokio::io::split(io);
    let c2u = async {
        let _ = tokio::io::copy(&mut cr, &mut uw).await;
        let _ = uw.shutdown().await;
    };
    let u2c = async {
        let _ = tokio::io::copy(&mut ur, &mut cw).await;
        let _ = cw.shutdown().await;
    };
    tokio::pin!(c2u, u2c);
    tokio::select! {
        _ = &mut u2c => {}
        _ = &mut c2u => { (&mut u2c).await; }
    }
}

async fn handle_conn(sh: Arc<Shared>, mut sock: TcpStream) {
    let _ = sock.set_nodelay(true);
    // a socket over the unauthenticated cap is closed unread, so a local process cannot starve the stream slots
    let Some(slot) = Slot::acquire(&sh.unauth, sh.cfg.max_unauthenticated) else {
        sh.n.unauthenticated_rejected.fetch_add(1, Ordering::Relaxed);
        return;
    };
    let mut slot = Some(slot);
    let req = match tokio::time::timeout(sh.cfg.handshake_timeout, handshake(&sh, &mut sock, &mut slot)).await {
        Ok(Ok(r)) => r,
        _ => return,
    };
    drop(slot);

    let host = match req.dest {
        Dest::Ipv6 => {
            sh.n.ipv6_refused.fetch_add(1, Ordering::Relaxed);
            let _ = socks::write_reply(&mut sock, reply::ADDRESS_TYPE_NOT_SUPPORTED).await;
            return;
        }
        Dest::Ipv4(ip) => ip.to_string(),
        Dest::Name(n) => n,
    };
    let port = req.port;
    // the charset is re-validated before the host can reach an argv; hostile text is not recorded
    if ssh::check_target(&host, port).is_err() {
        sh.n.refused.fetch_add(1, Ordering::Relaxed);
        let _ = socks::write_reply(&mut sock, reply::NOT_ALLOWED).await;
        return;
    }
    let host = norm_host(&host);
    if !lock(&sh.allow).permits(&host, port) {
        sh.record_refused(&host, port);
        let _ = socks::write_reply(&mut sock, reply::NOT_ALLOWED).await;
        return;
    }
    let Some(stream_slot) = Slot::acquire(&sh.streams, sh.cfg.max_streams) else {
        sh.n.stream_cap_hits.fetch_add(1, Ordering::Relaxed);
        let _ = socks::write_reply(&mut sock, reply::GENERAL_FAILURE).await;
        return;
    };
    if !lock(&sh.bucket).try_take(Instant::now()) {
        sh.n.rate_limited.fetch_add(1, Ordering::Relaxed);
        let _ = socks::write_reply(&mut sock, reply::GENERAL_FAILURE).await;
        return;
    }
    let spawned = match sh.spawner.spawn(&host, port) {
        Ok(s) => s,
        Err(_) => {
            sh.note_failure(&host, port, Vec::new());
            let _ = socks::write_reply(&mut sock, reply::GENERAL_FAILURE).await;
            return;
        }
    };
    sh.n.spawned.fetch_add(1, Ordering::Relaxed);
    let Spawned { io, finished } = spawned;
    if socks::write_reply(&mut sock, reply::SUCCEEDED).await.is_err() {
        return;
    }
    bridge(&mut sock, io).await;
    let _ = sock.shutdown().await;
    drop(stream_slot);
    match tokio::time::timeout(sh.cfg.finish_grace, finished).await {
        Ok(o) if o.success => sh.consecutive.store(0, Ordering::SeqCst),
        Ok(o) => sh.note_failure(&host, port, o.stderr_tail),
        Err(_) => {}
    }
}
