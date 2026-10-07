//! The only code that talks to a server (feature `mongo`). Reads only. Loopback hosts connect freely; any other host
//! needs `SessionOpts::allow_remote` (set by the Studio for profiles whose effective level is Production-level).
//!
//! Cancel model: every operation runs in a spawned task and the future is never dropped (the driver README warns that
//! dropping can corrupt state). The UI cancel sets a flag, then finds our own op by its `comment` tag through
//! `currentOp` (`$ownOps`) and sends `killOp`; `maxTimeMS` remains the backstop.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use bson::{doc, Bson, Document};
use intely_settings::Secret;
use mongodb::options::{ClientOptions, ServerAddress, Socks5Proxy, Tls};
use mongodb::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::ReadPreference as Pref;
use crate::connspec::{AuthMechanism, ConnSpec, Scheme, TlsMode, Tunnel};
use crate::connstring::{self, Mask, RenderSecrets};
use crate::explain::{self, PlanSummary};
use crate::host::{self, SeedRule};
use crate::shell::{self, ParseOptions};
use crate::types::*;

#[derive(Debug)]
pub enum Error {
    /// The spike only connects to loopback hosts.
    NonLoopback,
    Uri(String),
    Parse(String),
    Rejected(String),
    Cancelled,
    Server(String),
    /// The pre-flight found replica-set members outside the connection the user described (jailed sessions only).
    Members(Vec<String>),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::NonLoopback => f.write_str("only loopback hosts are allowed in this build"),
            Error::Uri(m) | Error::Parse(m) | Error::Rejected(m) | Error::Server(m) => f.write_str(m),
            Error::Cancelled => f.write_str("cancelled"),
            Error::Members(m) => write!(f, "the server announced replica-set members outside the connection: {}", m.join(", ")),
        }
    }
}
impl std::error::Error for Error {}

/// Value-light message: command errors keep code, code name and the server text; everything is scrubbed of URIs.
/// (Callers on the AI path drop the text and keep only code + name.)
fn server(e: mongodb::error::Error, fragments: &[String]) -> Error {
    match &*e.kind {
        mongodb::error::ErrorKind::Command(c) => Error::Server(host::scrub(&format!("{} ({}): {}", c.code_name, c.code, c.message), fragments)),
        _ => Error::Server(host::scrub(&e.to_string(), fragments)),
    }
}
fn code_of(e: &mongodb::error::Error) -> Option<i32> {
    match &*e.kind {
        mongodb::error::ErrorKind::Command(c) => Some(c.code),
        _ => None,
    }
}

#[derive(Debug, Clone)]
pub struct SessionOpts {
    pub max_time_ms: u64,
    pub now_ms: Option<i64>,
    /// Without this a non-loopback host is refused before any socket exists (tests and the jails leave it off).
    pub allow_remote: bool,
    /// The level the profile asks for (tag and override); the host rule can only raise it.
    pub min_level: EffectiveLevel,
    pub server_selection_ms: u64,
    /// The user typed the host to lower the level (`min_level` is then the lowered effective level and the host rule
    /// no longer raises it). Off by default: the host rule can only raise.
    pub host_override: bool,
    /// Jailed sessions (E2E / read-only): before the real client exists, ask each seed (`directConnection=true`,
    /// `hello`) who its members are and refuse the ones outside the seeds, so topology discovery can never dial them.
    pub preflight_members: bool,
}
impl Default for SessionOpts {
    fn default() -> Self {
        Self { max_time_ms: DEFAULT_MAX_TIME_MS, now_ms: None, allow_remote: false, min_level: EffectiveLevel::Local, server_selection_ms: 5_000, host_override: false, preflight_members: false }
    }
}

/// The level D10 and the read preference judge: the host rule raises `min_level` unless the user typed the host.
fn effective(opts: &SessionOpts, host_level: EffectiveLevel) -> EffectiveLevel {
    if !opts.host_override && host_level == EffectiveLevel::ProductionLevel {
        EffectiveLevel::ProductionLevel
    } else {
        opts.min_level
    }
}

fn driver_pref(pref: Pref, max_staleness: Option<Duration>) -> mongodb::options::ReadPreference {
    use mongodb::options::{ReadPreference as P, ReadPreferenceOptions as O};
    let o = || max_staleness.map(|m| O::builder().max_staleness(m).build());
    match pref {
        Pref::PrimaryPreferred => P::PrimaryPreferred { options: o() },
        Pref::SecondaryPreferred => P::SecondaryPreferred { options: o() },
        Pref::Primary => P::Primary,
        Pref::Secondary => P::Secondary { options: o() },
        Pref::Nearest => P::Nearest { options: o() },
    }
}

/// Client options every session gets: app name, timeouts, a small pool and the read preference of the level
/// (`secondaryPreferred` for Production-level, `primaryPreferred` otherwise). Pure, so it is tested without a server.
pub fn apply_options(co: &mut ClientOptions, opts: &SessionOpts, level: EffectiveLevel) {
    co.app_name = Some("IntelySwitchIDE".into());
    co.server_selection_timeout = Some(Duration::from_millis(opts.server_selection_ms));
    co.connect_timeout = Some(Duration::from_secs(5));
    co.max_pool_size = Some(4);
    // One loopback seed (a local server or an SSH tunnel) is the whole topology: without this the driver follows the
    // member addresses the server advertises, which may be remote hosts the jail and the level never saw.
    let single_loopback = co.hosts.len() == 1 && matches!(&co.hosts[0], mongodb::options::ServerAddress::Tcp { host, .. } if host::is_loopback_host(&host.to_ascii_lowercase()));
    if single_loopback && co.direct_connection.is_none() && co.load_balanced != Some(true) {
        co.direct_connection = Some(true);
    }
    co.selection_criteria = Some(mongodb::options::SelectionCriteria::ReadPreference(driver_pref(crate::profile::Profile::read_preference(level), None)));
}

// ---- structured connections (`ConnSpec`) ------------------------------------------------------------------------

/// A SOCKS5 endpoint the driver connects through: the user's own proxy, or the loopback relay of an SSH tunnel.
#[derive(Clone)]
pub struct ProxyEndpoint {
    pub host: String,
    pub port: u16,
    /// RFC 1929 user name and password. Set on `ClientOptions`, never in a URI.
    pub auth: Option<(String, Secret)>,
}
impl std::fmt::Debug for ProxyEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ProxyEndpoint({}:{}, auth={})", self.host, self.port, self.auth.is_some())
    }
}

/// Everything `Session::connect_spec` needs besides the options. Secrets come from the Keychain, the draft vault or the
/// connect prompt; none of this is `Debug` on purpose.
pub struct SpecConnect<'a> {
    pub spec: &'a ConnSpec,
    pub password: Option<&'a Secret>,
    /// Passphrase of an encrypted client key; set on `ClientOptions`, never in the URI.
    pub key_password: Option<&'a Secret>,
    pub proxy_password: Option<&'a Secret>,
    /// For `Tunnel::Ssh`: the open relay (the driver talks to it as a SOCKS5 proxy).
    pub relay: Option<ProxyEndpoint>,
    /// The signed `tls_relax` setting (`tlsAllowInvalidCertificates`); refused at the effective Production level.
    pub tls_relax: bool,
}

impl<'a> SpecConnect<'a> {
    pub fn new(spec: &'a ConnSpec) -> Self {
        Self { spec, password: None, key_password: None, proxy_password: None, relay: None, tls_relax: false }
    }

    /// Every literal that must not reach an error: the per-connection scrub registry (`host::spec_fragments`).
    pub fn fragments(&self) -> Vec<String> {
        let mut secrets: Vec<&str> = [self.password, self.key_password, self.proxy_password].into_iter().flatten().map(Secret::expose).collect();
        if let Some((_, p)) = self.relay.as_ref().and_then(|r| r.auth.as_ref()) {
            secrets.push(p.expose());
        }
        let mut f = host::spec_fragments(self.spec, &secrets);
        if let Some((u, _)) = self.relay.as_ref().and_then(|r| r.auth.as_ref()) {
            f.push(u.clone());
        }
        f
    }
}

fn config_err(fragments: &[String], code: &str, detail: &str) -> Error {
    Error::Uri(format!("{code}: {}", host::scrub(detail, fragments)))
}

fn tcp_hosts(hosts: &[ServerAddress]) -> Option<Vec<(String, u16)>> {
    hosts.iter().map(|h| match h {
        ServerAddress::Tcp { host, port } => Some((host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase(), port.unwrap_or(27017))),
        #[allow(unreachable_patterns)]
        _ => None,
    }).collect()
}

/// After `ClientOptions::parse`: the hosts the driver will contact must be the hosts the form shows (Standard), or
/// resolved names below the SRV parent domain. Nothing the string or a TXT record says can add a destination.
pub fn check_hosts(spec: &ConnSpec, resolved: &[ServerAddress]) -> Result<(), Error> {
    let bad = || Error::Uri("config.invalid: the connection string names hosts other than the ones in the form".into());
    let got = tcp_hosts(resolved).ok_or_else(bad)?;
    if got.is_empty() {
        return Err(bad());
    }
    match spec.scheme {
        Scheme::Standard => {
            let mut want: Vec<(String, u16)> = spec.hosts.iter().map(|h| (h.host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase(), h.port.unwrap_or(27017))).collect();
            let mut got = got;
            want.sort();
            got.sort();
            (want == got).then_some(()).ok_or_else(bad)
        }
        Scheme::Srv => {
            let rule = SeedRule::from_spec(spec);
            let parent = rule.srv_parent.ok_or_else(bad)?;
            got.iter().all(|(h, _)| h.ends_with(&format!(".{parent}"))).then_some(()).ok_or_else(bad)
        }
    }
}

/// Pure options for a structured connection (D17 timeouts, clamps, read preference, direct-connection rule).
/// `level` is the effective level the read preference follows when the spec says `Auto`.
pub fn apply_spec_options(co: &mut ClientOptions, spec: &ConnSpec, level: EffectiveLevel) {
    co.app_name = Some(spec.app_name.clone().filter(|a| !a.is_empty()).unwrap_or_else(|| "IntelySwitchIDE".into()));
    co.connect_timeout = Some(Duration::from_millis(u64::from(spec.timeouts.connect())));
    co.server_selection_timeout = Some(Duration::from_millis(u64::from(spec.timeouts.server_selection())));
    // pool and discovery options are clamped even though the parser clamped them: this is the last stop before the socket
    let tunnelled_ssh = matches!(spec.tunnel, Tunnel::Ssh(_));
    let max_pool = co.max_pool_size.unwrap_or(4).clamp(1, if tunnelled_ssh { 4 } else { 8 });
    co.max_pool_size = Some(max_pool);
    co.min_pool_size = co.min_pool_size.map(|m| m.min(4).min(max_pool));
    co.max_idle_time = co.max_idle_time.map(|d| d.clamp(Duration::from_millis(1_000), Duration::from_millis(3_600_000)));
    co.heartbeat_freq = co.heartbeat_freq.map(|d| d.clamp(Duration::from_millis(500), Duration::from_millis(60_000)));
    co.local_threshold = co.local_threshold.map(|d| d.min(Duration::from_millis(1_000)));
    co.srv_max_hosts = co.srv_max_hosts.map(|n| n.min(16));
    // A single loopback seed on this computer is the whole topology (see `apply_options`). Never for a tunnel: the
    // seed names a host as the bastion sees it, and discovery must stay on so real member names reach the relay.
    let single_loopback = spec.tunnel.is_none() && spec.scheme == Scheme::Standard && co.hosts.len() == 1 && matches!(&co.hosts[0], ServerAddress::Tcp { host, .. } if host::is_loopback_host(&host.to_ascii_lowercase()));
    if single_loopback && co.direct_connection.is_none() && co.load_balanced != Some(true) {
        co.direct_connection = Some(true);
    }
    let staleness = spec.topology.max_staleness_s.map(|s| Duration::from_secs(u64::from(s)));
    let pref = crate::profile::resolve_read_preference(level, spec.topology.read_preference);
    co.selection_criteria = Some(mongodb::options::SelectionCriteria::ReadPreference(driver_pref(pref, staleness)));
}

/// TLS relax, key passphrase and proxy: set on the options, never in the URI.
fn apply_secrets_and_proxy(co: &mut ClientOptions, input: &SpecConnect<'_>, fragments: &[String]) -> Result<(), Error> {
    let spec = input.spec;
    if let Some(Tls::Enabled(t)) = &mut co.tls {
        t.allow_invalid_certificates = input.tls_relax.then_some(true);
    }
    if spec.tls.client_cert_file.as_deref().is_some_and(|p| !p.is_empty()) {
        match (&mut co.tls, input.key_password) {
            (Some(Tls::Enabled(t)), Some(k)) => t.tls_certificate_key_file_password = Some(k.expose().as_bytes().to_vec()),
            (Some(Tls::Enabled(_)), None) => {}
            _ => return Err(config_err(fragments, "config.invalid", "a client certificate needs TLS")),
        }
    }
    let endpoint = match &spec.tunnel {
        Tunnel::None => None,
        Tunnel::Socks5(p) => {
            let auth = match (&p.username, input.proxy_password) {
                (Some(u), Some(pw)) if !u.is_empty() => Some((u.clone(), pw.clone())),
                (Some(u), None) if !u.is_empty() => Some((u.clone(), Secret::new(""))),
                _ => None,
            };
            let loopback = host::is_loopback_host(&p.host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase());
            // RFC 1929 credentials are plain text: a proxy on another machine is accepted only with TLS on to the database
            if !loopback && spec.tls.mode != TlsMode::On && spec.scheme != Scheme::Srv {
                return Err(config_err(fragments, "config.proxyPlain", "a proxy on another computer needs TLS on"));
            }
            Some(ProxyEndpoint { host: p.host.clone(), port: p.port, auth })
        }
        Tunnel::Ssh(_) => Some(input.relay.clone().ok_or_else(|| config_err(fragments, "tunnel.notOpen", "the SSH tunnel is not open"))?),
    };
    if let Some(e) = endpoint {
        let auth = e.auth.map(|(u, p)| (u, p.expose().to_string()));
        co.socks5_proxy = Some(Socks5Proxy::builder().host(e.host).port(e.port).authentication(auth).build());
    }
    Ok(())
}

fn file_exists(p: &str) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file())
}

/// Builds the driver options for a spec without opening a socket (SRV/TXT names are resolved by `parse`; the caller
/// has already passed the jail). Returns the options, the effective level and the scrub registry.
pub async fn build_spec_options(input: &SpecConnect<'_>, opts: &SessionOpts) -> Result<(ClientOptions, EffectiveLevel, Vec<String>), Error> {
    let spec = input.spec;
    let fragments = input.fragments();
    if let Some(p) = spec.errors().into_iter().next() {
        return Err(Error::Uri(format!("{}: {}", p.code, p.path)));
    }
    let host_level = spec.host_level();
    if host_level != EffectiveLevel::Local && !opts.allow_remote {
        return Err(Error::NonLoopback);
    }
    let level = effective(opts, host_level);
    if input.tls_relax && level == EffectiveLevel::ProductionLevel {
        return Err(Error::Rejected("config.tlsRelaxRefused: certificate checks cannot be skipped on a production-level connection".into()));
    }
    for (field, path) in [("tls.caFile", &spec.tls.ca_file), ("tls.clientCertFile", &spec.tls.client_cert_file)] {
        if path.as_deref().is_some_and(|p| !p.is_empty() && !file_exists(p)) {
            return Err(Error::Uri(format!("config.fileMissing: {field}")));
        }
    }
    let mut rendered = spec.clone();
    if matches!(spec.auth.mechanism, AuthMechanism::X509 | AuthMechanism::Plain) && rendered.auth.source.as_deref().is_none_or(str::is_empty) {
        rendered.auth.source = Some("$external".into());
    }
    let uri = connstring::render_ext(&rendered, &RenderSecrets { password: input.password.cloned() }, Mask::Full, input.tls_relax).map_err(|e| config_err(&fragments, "config.invalid", &e.message))?;
    let mut co = ClientOptions::parse(uri.as_str()).await.map_err(|e| {
        // `mongodb+srv` resolves its SRV and TXT records while parsing: a DNS failure is not a malformed configuration
        let code = if matches!(&*e.kind, mongodb::error::ErrorKind::DnsResolve { .. }) { crate::diagnose::classify(&e, &crate::diagnose::Ctx::default()).code } else { "config.invalid".to_string() };
        config_err(&fragments, &code, &e.to_string())
    })?;
    check_hosts(spec, &co.hosts)?;
    apply_spec_options(&mut co, spec, level);
    apply_secrets_and_proxy(&mut co, input, &fragments)?;
    Ok((co, level, fragments))
}

/// True when a `hello` reply names a replica-set member (`hosts`, `passives`, `arbiters`) on a non-loopback host.
pub fn has_remote_members(hello: &Document) -> bool {
    ["hosts", "passives", "arbiters"].iter().filter_map(|k| hello.get_array(k).ok()).flatten().filter_map(Bson::as_str).any(|m| {
        let h = m.strip_prefix('[').and_then(|r| r.split(']').next()).unwrap_or_else(|| m.rsplit_once(':').map_or(m, |(a, _)| a));
        !host::is_loopback_host(&h.to_ascii_lowercase())
    })
}

/// Every member a `hello` reply names (`hosts`, `passives`, `arbiters`), as `host:port`, in the order announced.
pub fn hello_members(hello: &Document) -> Vec<String> {
    ["hosts", "passives", "arbiters"].iter().filter_map(|k| hello.get_array(k).ok()).flatten().filter_map(Bson::as_str).map(str::to_string).collect()
}

/// True when a `hello` reply names a replica-set member outside the seeds the user described (see `SeedRule`).
pub fn members_outside(hello: &Document, rule: &SeedRule) -> bool {
    rule.outside(&hello_members(hello))
}

/// Longest the pre-flight waits for one seed. A seed that does not answer is not an error here: the real connection
/// reports it with the usual diagnosis. It is not trusted either: the dial gate judges every later dial of the real client.
const PREFLIGHT_MAX: Duration = Duration::from_secs(10);

/// True when the driver would run topology discovery from these options (several seeds, or a single one that is not
/// pinned with `directConnection`), over a direct socket: a proxy or tunnel relay judges every destination itself.
fn discovers_members(co: &ClientOptions) -> bool {
    co.direct_connection != Some(true) && co.load_balanced != Some(true) && co.socks5_proxy.is_none() && !co.hosts.is_empty()
}

/// The pre-flight of a jailed session. One throwaway client per seed with `directConnection=true`, no credentials (the
/// monitor connections of the real client never sign in either, and `hello` needs no sign-in) and no replica-set name:
/// it can only ever talk to its seed. The members each seed announces are judged against the seeds; any outsider ends
/// the connection before the real client exists. Seeds that do not answer are skipped (see [`PREFLIGHT_MAX`]).
async fn preflight_members(co: &ClientOptions, rule: &SeedRule, fragments: &[String]) -> Result<(), Error> {
    if !discovers_members(co) {
        return Ok(());
    }
    let wait = co.server_selection_timeout.unwrap_or(PREFLIGHT_MAX).min(PREFLIGHT_MAX);
    let mut tasks = Vec::new();
    for seed in &co.hosts {
        let mut one = co.clone();
        one.hosts = vec![seed.clone()];
        one.direct_connection = Some(true);
        one.repl_set_name = None;
        one.credential = None;
        one.max_pool_size = Some(1);
        one.min_pool_size = None;
        one.server_selection_timeout = Some(wait);
        tasks.push(tokio::spawn(async move {
            let client = Client::with_options(one).ok()?;
            let reply = tokio::time::timeout(wait + Duration::from_secs(2), client.database("admin").run_command(doc! { "hello": 1 })).await;
            client.shutdown().await;
            reply.ok()?.ok().map(|h| hello_members(&h))
        }));
    }
    let mut outsiders: Vec<String> = Vec::new();
    for t in tasks {
        if let Ok(Some(members)) = t.await {
            for m in rule.outsiders(&members) {
                if !outsiders.contains(&m) {
                    outsiders.push(m);
                }
            }
        }
    }
    if outsiders.is_empty() {
        Ok(())
    } else {
        Err(Error::Members(outsiders.into_iter().map(|m| host::scrub(&m, fragments)).collect()))
    }
}

/// Judges every destination the driver dials in a jailed session (see `gate.rs`). There is no gate off unix: the pre-flight stays.
#[cfg(unix)]
use crate::gate::DialGate;
#[cfg(not(unix))]
struct DialGate;
#[cfg(not(unix))]
impl DialGate {
    fn refused(&self) -> Vec<String> {
        Vec::new()
    }
}

/// After the pre-flight of a jailed session: when the driver will discover the topology over direct sockets, its dials go through a
/// loopback gate that refuses any destination outside the seeds at dial time. The pre-flight is a point in time (a seed that was
/// silent, or a set that changes its member list later, would still be followed); the gate is not.
#[cfg(unix)]
async fn gate_dials(co: &mut ClientOptions, rule: &SeedRule) -> Result<Option<Arc<DialGate>>, Error> {
    if !discovers_members(co) {
        return Ok(None);
    }
    let gate = DialGate::start(rule.clone(), co.connect_timeout.unwrap_or(PREFLIGHT_MAX)).await.map_err(|_| Error::Uri("config.invalid: the local dial gate could not be started".into()))?;
    let (user, pass) = gate.credentials();
    co.socks5_proxy = Some(Socks5Proxy::builder().host("127.0.0.1".to_string()).port(gate.port()).authentication(Some((user, pass))).build());
    Ok(Some(Arc::new(gate)))
}

#[cfg(not(unix))]
async fn gate_dials(_co: &mut ClientOptions, _rule: &SeedRule) -> Result<Option<Arc<DialGate>>, Error> {
    Ok(None)
}

#[derive(Clone)]
pub struct Session {
    client: Client,
    opts: SessionOpts,
    fragments: Arc<Vec<String>>,
    seeds: Arc<SeedRule>,
    /// Only in a jailed session with discovery: refuses destinations outside the seeds when the driver dials them.
    gate: Option<Arc<DialGate>>,
    relaxed: bool,
    tls: bool,
    pub level: EffectiveLevel,
}

static TOKEN_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct CancelToken {
    tag: String,
    flag: Arc<AtomicBool>,
}
impl Default for CancelToken {
    fn default() -> Self {
        Self::new()
    }
}
impl CancelToken {
    pub fn new() -> Self {
        let n = TOKEN_SEQ.fetch_add(1, Ordering::Relaxed);
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        Self { tag: format!("intely-op-{t:x}-{n}"), flag: Arc::new(AtomicBool::new(false)) }
    }
    pub fn tag(&self) -> &str {
        &self.tag
    }
    /// Marks the token without a server round trip (shutdown paths).
    pub fn mark_cancelled(&self) {
        self.flag.store(true, Ordering::Relaxed);
    }
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub server_version: String,
    pub topology: String,
    pub ping_ms: u64,
    pub level: EffectiveLevel,
    pub role: RoleChip,
    /// The server advertises replica-set members (`hello.hosts`, `passives`, `arbiters`) on non-loopback hosts, so a
    /// loopback seed (an SSH tunnel) really fronts a remote cluster: the connection counts as Production-level.
    #[serde(default)]
    pub remote_members: bool,
    /// Every member the server announces (`hello.hosts`, `passives`, `arbiters`), as `host:port`; empty for a standalone.
    #[serde(default)]
    pub members: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    /// Canonical Extended JSON, one document per entry.
    pub docs: Vec<String>,
    pub truncated: bool,
    pub bytes: usize,
    pub elapsed_ms: u64,
    pub plan: Option<PlanSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillOutcome {
    pub found_op: bool,
    pub killed: bool,
    pub error: Option<String>,
}

fn to_doc(v: Value) -> Result<Document, Error> {
    match Bson::try_from(v).map_err(|e| Error::Parse(e.to_string()))? {
        Bson::Document(d) => Ok(d),
        _ => Err(Error::Parse("expected a document".into())),
    }
}

impl Session {
    /// Connects (lazily: the driver opens sockets on first use) to a **loopback** host. Everything else is refused in M0.
    /// This is the path of legacy profiles that store one connection string: its options keep the old pinned values
    /// (5 s timeouts), and the new parser's policy runs over it (`host::legacy_policy`): a `tlsAllowInvalid*`,
    /// `tlsInsecure` or `proxy*` option marks the session relaxed and is refused at the effective Production level (D10).
    pub async fn connect(uri: &str, opts: SessionOpts) -> Result<Self, Error> {
        let fragments = Arc::new(host::credential_fragments(uri));
        let info = host::parse_uri(uri).map_err(|e| Error::Uri(host::scrub(&e.0, &fragments)))?;
        let host_level = host::effective_level(&info);
        if host_level != EffectiveLevel::Local && !opts.allow_remote {
            return Err(Error::NonLoopback);
        }
        let level = if host_level == EffectiveLevel::ProductionLevel || opts.min_level == EffectiveLevel::ProductionLevel { EffectiveLevel::ProductionLevel } else { EffectiveLevel::Local };
        let policy = host::legacy_policy(uri);
        if policy.relaxed && effective(&opts, host_level) == EffectiveLevel::ProductionLevel {
            return Err(Error::Rejected(format!("config.tlsRelaxRefused: the connection string relaxes certificate checks or names a proxy ({}); not allowed on a production-level connection", policy.options.join(", "))));
        }
        let mut co = ClientOptions::parse(uri).await.map_err(|e| Error::Uri(host::scrub(&e.to_string(), &fragments)))?;
        apply_options(&mut co, &opts, level);
        let seeds = SeedRule::from_hosts(tcp_hosts(&co.hosts).unwrap_or_default().into_iter().map(|(h, _)| h).collect());
        let mut gate = None;
        if opts.preflight_members {
            preflight_members(&co, &seeds, &fragments).await?;
            gate = gate_dials(&mut co, &seeds).await?;
        }
        let tls = matches!(co.tls, Some(Tls::Enabled(_)));
        let client = Client::with_options(co).map_err(|e| Error::Uri(host::scrub(&e.to_string(), &fragments)))?;
        Ok(Self { client, opts, fragments, seeds: Arc::new(seeds), gate, relaxed: policy.relaxed, tls, level })
    }

    /// Connects (lazily) to a structured connection. The URI the driver parses is built here from the spec and the
    /// secrets and never leaves this function; the key passphrase and the proxy password go on the options. Timeouts are
    /// the spec's (10 s defaults, D17). Errors carry a leading code (`config.*`, `tunnel.*`) and scrubbed text.
    pub async fn connect_spec(input: SpecConnect<'_>, opts: SessionOpts) -> Result<Self, Error> {
        let (mut co, level, fragments) = build_spec_options(&input, &opts).await?;
        let seeds = SeedRule::from_spec(input.spec);
        let mut gate = None;
        if opts.preflight_members {
            preflight_members(&co, &seeds, &fragments).await?;
            gate = gate_dials(&mut co, &seeds).await?;
        }
        let tls = matches!(co.tls, Some(Tls::Enabled(_)));
        let client = Client::with_options(co).map_err(|e| config_err(&fragments, "config.invalid", &e.to_string()))?;
        Ok(Self { client, opts, fragments: Arc::new(fragments), seeds: Arc::new(seeds), gate, relaxed: input.tls_relax, tls, level })
    }

    /// Certificate checks are relaxed or a proxy came from the connection string: the loud chip.
    pub fn relaxed(&self) -> bool {
        self.relaxed
    }

    /// The driver will speak TLS.
    pub fn tls(&self) -> bool {
        self.tls
    }

    /// The per-connection scrub registry, for every error text and event that leaves the crate.
    pub fn fragments(&self) -> &[String] {
        &self.fragments
    }

    fn srv(&self, e: mongodb::error::Error) -> Error {
        server(e, &self.fragments)
    }

    /// Closes the pool. Runs in the background; open handles finish first.
    pub fn close(self) {
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move { self.client.shutdown().await });
        }
    }

    fn max_time(&self) -> Duration {
        Duration::from_millis(self.opts.max_time_ms.clamp(1, MAX_TIME_CEILING_MS))
    }
    fn po(&self) -> ParseOptions {
        ParseOptions { now_ms: self.opts.now_ms }
    }
    fn body(&self, text: &str) -> Result<Document, Error> {
        let v = shell::parse_document(text, &self.po()).map_err(|e| Error::Parse(e.to_string()))?;
        let mut errs = Vec::new();
        crate::ai::walk_deny(&v, &mut errs);
        if let Some(e) = errs.into_iter().next() {
            return Err(Error::Rejected(e));
        }
        to_doc(v)
    }
    fn pipeline(&self, text: &str) -> Result<Vec<Document>, Error> {
        let v = shell::parse_with(text, &self.po()).map_err(|e| Error::Parse(e.to_string()))?;
        let mut errs = Vec::new();
        crate::ai::walk_deny(&v, &mut errs);
        if let Some(e) = errs.into_iter().next() {
            return Err(Error::Rejected(e));
        }
        crate::validate::validate_pipeline(&v).map_err(|e| Error::Rejected(e.join("; ")))?;
        let Value::Array(stages) = v else { return Err(Error::Parse("a pipeline is an array of stages".into())) };
        let mut out = Vec::new();
        for s in stages {
            let d = to_doc(s)?;
            if d.len() != 1 {
                return Err(Error::Parse("each stage has exactly one operator".into()));
            }
            out.push(d);
        }
        Ok(out)
    }

    pub async fn probe(&self) -> Result<Probe, Error> {
        // a destination the gate refused is a member outside the connection: the connection check names it
        if let Some(g) = &self.gate {
            let refused = g.refused();
            if !refused.is_empty() {
                return Err(Error::Members(refused.into_iter().map(|m| host::scrub(&m, &self.fragments)).collect()));
            }
        }
        let admin = self.client.database("admin");
        let t = Instant::now();
        admin.run_command(doc! { "ping": 1 }).await.map_err(|e| self.srv(e))?;
        let ping_ms = t.elapsed().as_millis() as u64;
        let build = admin.run_command(doc! { "buildInfo": 1 }).await.map_err(|e| self.srv(e))?;
        let hello = admin.run_command(doc! { "hello": 1 }).await.map_err(|e| self.srv(e))?;
        let topology = if hello.get_str("msg").ok() == Some("isdbgrid") {
            "sharded"
        } else if hello.contains_key("setName") {
            "replicaSet"
        } else {
            "standalone"
        };
        let remote_members = members_outside(&hello, &self.seeds);
        let members = hello_members(&hello);
        let status = admin.run_command(doc! { "connectionStatus": 1, "showPrivileges": true }).await.map_err(|e| self.srv(e))?;
        let role = classify_connection_status(&Bson::Document(status).into_relaxed_extjson());
        Ok(Probe { server_version: build.get_str("version").unwrap_or("?").to_string(), topology: topology.into(), ping_ms, level: self.level, role, remote_members, members })
    }

    /// Runs in a spawned task; the returned handle is awaited, never dropped mid-flight.
    pub fn spawn(&self, cmd: ReadCommand, token: CancelToken) -> tokio::task::JoinHandle<Result<RunResult, Error>> {
        self.spawn_window(cmd, token, MAX_DOCS)
    }

    /// Like [`Session::spawn`], but a `find` loads at most `window` documents (further ones on demand): the first page
    /// of a big collection does not buffer 1000 documents.
    pub fn spawn_window(&self, cmd: ReadCommand, token: CancelToken, window: usize) -> tokio::task::JoinHandle<Result<RunResult, Error>> {
        let me = self.clone();
        tokio::spawn(async move { me.run_window(&cmd, &token, window).await })
    }

    /// Flag + killOp for our own tagged operation.
    pub async fn cancel(&self, token: &CancelToken) -> KillOutcome {
        token.flag.store(true, Ordering::Relaxed);
        let admin = self.client.database("admin");
        let q = doc! { "currentOp": 1, "$ownOps": true, "$or": [ { "command.comment": token.tag() }, { "originatingCommand.comment": token.tag() } ] };
        let r = match admin.run_command(q).await {
            Ok(r) => r,
            Err(e) => return KillOutcome { found_op: false, killed: false, error: Some(host::scrub(&e.to_string(), &self.fragments)) },
        };
        let Some(op) = r.get_array("inprog").ok().and_then(|a| a.first()).and_then(|b| b.as_document()).and_then(|d| d.get("opid").cloned()) else {
            return KillOutcome { found_op: false, killed: false, error: None };
        };
        match admin.run_command(doc! { "killOp": 1, "op": op }).await {
            Ok(_) => KillOutcome { found_op: true, killed: true, error: None },
            Err(e) => KillOutcome { found_op: true, killed: false, error: Some(host::scrub(&e.to_string(), &self.fragments)) },
        }
    }

    pub async fn run(&self, cmd: &ReadCommand, token: &CancelToken) -> Result<RunResult, Error> {
        self.run_window(cmd, token, MAX_DOCS).await
    }

    async fn run_window(&self, cmd: &ReadCommand, token: &CancelToken, window: usize) -> Result<RunResult, Error> {
        let t = Instant::now();
        let mut r = self.exec(cmd, token, window.clamp(1, MAX_DOCS)).await.map_err(|e| match e {
            Error::Server(ref m) if token.is_cancelled() && (m.contains("(11601)") || m.to_lowercase().contains("interrupted")) => Error::Cancelled,
            e => e,
        })?;
        r.elapsed_ms = t.elapsed().as_millis() as u64;
        Ok(r)
    }

    async fn collect(&self, mut cur: mongodb::Cursor<Document>, token: &CancelToken, cap: usize, r: &mut RunResult) -> Result<(), Error> {
        loop {
            let more = cur.advance().await.map_err(|e| if code_of(&e) == Some(11601) { Error::Cancelled } else { self.srv(e) })?;
            if !more {
                return Ok(());
            }
            if token.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let raw = cur.current();
            let size = raw.as_bytes().len();
            if r.docs.len() >= cap || r.bytes + size > MAX_BYTES {
                r.truncated = true;
                return Ok(());
            }
            let d = Document::try_from(raw).map_err(|e| Error::Server(e.to_string()))?;
            r.bytes += size;
            r.docs.push(Bson::Document(d).into_canonical_extjson().to_string());
        }
    }

    async fn exec(&self, cmd: &ReadCommand, token: &CancelToken, window: usize) -> Result<RunResult, Error> {
        let mut r = RunResult::default();
        let tag = Bson::String(token.tag().to_string());
        match cmd {
            ReadCommand::ListDatabases => {
                let ms = self.max_time().as_millis() as i64;
                let out = self.client.database("admin").run_command(doc! { "listDatabases": 1, "nameOnly": true, "authorizedDatabases": true, "maxTimeMS": ms }).await.map_err(|e| self.srv(e))?;
                let names = out.get_array("databases").map(|a| a.iter().filter_map(|d| d.as_document().and_then(|d| d.get_str("name").ok())).map(str::to_string).collect::<Vec<_>>()).unwrap_or_default();
                r.docs = names.into_iter().map(|n| serde_json::json!({ "name": n }).to_string()).collect();
            }
            ReadCommand::ListCollections { db } => {
                let ms = self.max_time().as_millis() as i64;
                let out = self.client.database(db).run_command(doc! { "listCollections": 1, "nameOnly": true, "cursor": { "batchSize": 20_000 }, "maxTimeMS": ms }).await.map_err(|e| self.srv(e))?;
                if let Ok(c) = out.get_document("cursor") {
                    let batch = c.get_array("firstBatch").map(|a| a.iter().filter_map(|d| d.as_document().and_then(|d| d.get_str("name").ok())).map(str::to_string).collect::<Vec<_>>()).unwrap_or_default();
                    r.truncated = c.get_i64("id").map_or_else(|_| c.get_i32("id").is_ok_and(|i| i != 0), |i| i != 0);
                    r.docs = batch.into_iter().map(|n| serde_json::json!({ "name": n }).to_string()).collect();
                }
            }
            ReadCommand::ListIndexes { db, collection } => {
                let ms = self.max_time().as_millis() as i64;
                let out = self.client.database(db).run_command(doc! { "listIndexes": collection, "cursor": {}, "maxTimeMS": ms }).await.map_err(|e| self.srv(e))?;
                if let Ok(b) = out.get_document("cursor").and_then(|c| c.get_array("firstBatch")) {
                    r.docs = b.iter().map(|x| x.clone().into_canonical_extjson().to_string()).collect();
                }
            }
            ReadCommand::Find { db, collection, filter, projection, sort, skip, limit } => {
                let coll = self.client.database(db).collection::<Document>(collection);
                let cap = limit.filter(|l| *l > 0).map_or(window, |l| (l as usize).min(window));
                let mut a = coll.find(self.body(filter)?).max_time(self.max_time()).batch_size(BATCH_SIZE).limit(cap as i64 + 1).comment(tag);
                if let Some(p) = projection.as_deref().filter(|s| !s.trim().is_empty()) {
                    a = a.projection(self.body(p)?);
                }
                if let Some(s) = sort.as_deref().filter(|s| !s.trim().is_empty()) {
                    a = a.sort(self.body(s)?);
                }
                if let Some(k) = skip {
                    a = a.skip(*k);
                }
                let cur = a.await.map_err(|e| self.srv(e))?;
                self.collect(cur, token, cap, &mut r).await?;
                // The user's own limit is not truncation.
                if limit.is_some_and(|l| l > 0 && (l as usize) <= window) && r.docs.len() <= cap {
                    r.truncated = false;
                }
            }
            ReadCommand::Aggregate { db, collection, pipeline } => {
                let mut stages = self.pipeline(pipeline)?;
                let last = stages.last().and_then(|d| d.keys().next().cloned()).unwrap_or_default();
                if !matches!(last.as_str(), "$limit" | "$count" | "$group") {
                    stages.push(doc! { "$limit": MAX_DOCS as i64 + 1 });
                }
                let coll = self.client.database(db).collection::<Document>(collection);
                let cur = coll.aggregate(stages).max_time(self.max_time()).batch_size(BATCH_SIZE).allow_disk_use(false).comment(tag).await.map_err(|e| self.srv(e))?;
                self.collect(cur, token, MAX_DOCS, &mut r).await?;
            }
            ReadCommand::Sample { db, collection, size } => {
                let stages = vec![doc! { "$sample": { "size": i64::from((*size).clamp(1, MAX_DOCS as u32)) } }];
                let coll = self.client.database(db).collection::<Document>(collection);
                let cur = coll.aggregate(stages).max_time(self.max_time()).batch_size(BATCH_SIZE).allow_disk_use(false).comment(tag).await.map_err(|e| self.srv(e))?;
                self.collect(cur, token, MAX_DOCS, &mut r).await?;
            }
            ReadCommand::Count { db, collection, filter } => {
                let coll = self.client.database(db).collection::<Document>(collection);
                let f = self.body(filter)?;
                let n = if f.is_empty() {
                    coll.estimated_document_count().max_time(self.max_time()).await.map_err(|e| self.srv(e))?
                } else {
                    coll.count_documents(f).limit(100_000).max_time(self.max_time()).comment(tag).await.map_err(|e| self.srv(e))?
                };
                r.docs = vec![serde_json::json!({ "count": n, "capped": n >= 100_000 }).to_string()];
            }
            ReadCommand::Distinct { db, collection, field, filter } => {
                let coll = self.client.database(db).collection::<Document>(collection);
                let v = coll.distinct(field, self.body(filter)?).max_time(self.max_time()).comment(tag).await.map_err(|e| self.srv(e))?;
                for b in v.into_iter().take(MAX_DOCS) {
                    r.docs.push(b.into_canonical_extjson().to_string());
                }
            }
            ReadCommand::Explain { inner, execution_stats } => {
                let (db, inner_cmd) = self.explain_command(inner, token)?;
                let verbosity = if *execution_stats { "executionStats" } else { "queryPlanner" };
                let out = self
                    .client
                    .database(&db)
                    .run_command(doc! { "explain": inner_cmd, "verbosity": verbosity, "maxTimeMS": self.max_time().as_millis() as i64 })
                    .await
                    .map_err(|e| self.srv(e))?;
                let j = Bson::Document(out).into_canonical_extjson();
                r.plan = Some(explain::summarize(&j));
                r.docs = vec![j.to_string()];
            }
        }
        Ok(r)
    }

    /// The inner command document of an explain. This is the only place a raw command document is built, and only
    /// from the closed enum; no caller can pass one in.
    fn explain_command(&self, c: &ReadCommand, token: &CancelToken) -> Result<(String, Document), Error> {
        match c {
            ReadCommand::Find { db, collection, filter, projection, sort, skip, limit } => {
                let mut d = doc! { "find": collection, "filter": self.body(filter)? };
                if let Some(p) = projection.as_deref().filter(|s| !s.trim().is_empty()) {
                    d.insert("projection", self.body(p)?);
                }
                if let Some(s) = sort.as_deref().filter(|s| !s.trim().is_empty()) {
                    d.insert("sort", self.body(s)?);
                }
                if let Some(k) = skip {
                    d.insert("skip", *k as i64);
                }
                if let Some(l) = limit {
                    d.insert("limit", *l);
                }
                d.insert("comment", token.tag());
                Ok((db.clone(), d))
            }
            ReadCommand::Aggregate { db, collection, pipeline } => {
                // the same appended $limit as the real run, so an explain never plans an unbounded pipeline
                let mut stages = self.pipeline(pipeline)?;
                let last = stages.last().and_then(|d| d.keys().next().cloned()).unwrap_or_default();
                if !matches!(last.as_str(), "$limit" | "$count" | "$group") {
                    stages.push(doc! { "$limit": MAX_DOCS as i64 + 1 });
                }
                Ok((db.clone(), doc! { "aggregate": collection, "pipeline": stages, "cursor": {} }))
            }
            ReadCommand::Count { db, collection, filter } => Ok((db.clone(), doc! { "count": collection, "query": self.body(filter)? })),
            ReadCommand::Distinct { db, collection, field, filter } => Ok((db.clone(), doc! { "distinct": collection, "key": field, "query": self.body(filter)? })),
            _ => Err(Error::Rejected("explain supports find, aggregate, count and distinct".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::options::{ReadPreference, SelectionCriteria};

    #[test]
    fn production_level_reads_from_secondaries_and_local_from_the_primary() {
        let pref = |level| {
            let mut co = ClientOptions::default();
            apply_options(&mut co, &SessionOpts::default(), level);
            assert_eq!(co.app_name.as_deref(), Some("IntelySwitchIDE"));
            assert_eq!(co.max_pool_size, Some(4));
            match co.selection_criteria {
                Some(SelectionCriteria::ReadPreference(p)) => p,
                other => panic!("{other:?}"),
            }
        };
        assert!(matches!(pref(EffectiveLevel::ProductionLevel), ReadPreference::SecondaryPreferred { .. }));
        assert!(matches!(pref(EffectiveLevel::Local), ReadPreference::PrimaryPreferred { .. }));
    }

    #[test]
    fn a_single_loopback_seed_is_a_direct_connection_and_other_seeds_are_left_alone() {
        use mongodb::options::ServerAddress;
        let tcp = |h: &str| ServerAddress::Tcp { host: h.into(), port: Some(27017) };
        let direct = |hosts: Vec<ServerAddress>, level| {
            let mut co = ClientOptions::default();
            co.hosts = hosts;
            apply_options(&mut co, &SessionOpts::default(), level);
            co.direct_connection
        };
        // a replica set advertises its members: following them would open sockets the jail never saw
        assert_eq!(direct(vec![tcp("127.0.0.1")], EffectiveLevel::Local), Some(true));
        assert_eq!(direct(vec![tcp("localhost")], EffectiveLevel::ProductionLevel), Some(true));
        assert_eq!(direct(vec![tcp("db.example.com")], EffectiveLevel::ProductionLevel), None);
        assert_eq!(direct(vec![tcp("127.0.0.1"), tcp("127.0.0.2")], EffectiveLevel::Local), None);
    }

    #[test]
    fn remote_replica_set_members_make_a_loopback_seed_production_level() {
        assert!(!has_remote_members(&doc! { "hosts": ["127.0.0.1:27017", "localhost:27018"], "setName": "rs0" }));
        assert!(has_remote_members(&doc! { "hosts": ["127.0.0.1:27017", "172.17.0.4:27017"] }));
        assert!(has_remote_members(&doc! { "hosts": ["127.0.0.1:27017"], "passives": ["mongo-b.internal:27017"] }));
        assert!(has_remote_members(&doc! { "arbiters": ["[fd00::1]:27017"] }));
        assert!(!has_remote_members(&doc! { "ismaster": true }));
    }

    // ---- structured connections ----------------------------------------------------------------------------------

    use crate::connspec::{HostPort, ProxySpec, SshSpec};
    use mongodb::options::{ServerAddress, Tls};

    const PW: &str = "p@ss:w0rd/Canary#1";
    const KEYPW: &str = "key-Pass-Canary-77";
    const PROXYPW: &str = "proxy-Canary-55";

    fn spec(hosts: &[&str]) -> ConnSpec {
        ConnSpec { hosts: hosts.iter().map(|h| HostPort { host: (*h).into(), port: Some(27017) }).collect(), ..Default::default() }
    }
    fn user(mut s: ConnSpec) -> ConnSpec {
        s.auth.username = Some("svc-reader".into());
        s
    }
    fn ssh_tunnel() -> Tunnel {
        Tunnel::Ssh(SshSpec { host: "bastion.example.com".into(), user: "opsuser".into(), ..Default::default() })
    }
    fn relay() -> ProxyEndpoint {
        ProxyEndpoint { host: "127.0.0.1".into(), port: 41_999, auth: Some(("rl-user-0123456789abcdef".into(), Secret::new("rl-pass-0123456789abcdef"))) }
    }
    fn remote_ok() -> SessionOpts {
        SessionOpts { allow_remote: true, ..Default::default() }
    }
    fn secret(v: &str) -> Secret {
        Secret::new(v)
    }
    fn pref_of(co: &ClientOptions) -> mongodb::options::ReadPreference {
        match co.selection_criteria.clone() {
            Some(SelectionCriteria::ReadPreference(p)) => p,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn spec_options_use_ten_second_timeouts_and_clamp_everything() {
        let mut co = ClientOptions::default();
        apply_spec_options(&mut co, &spec(&["db.example.com"]), EffectiveLevel::ProductionLevel);
        assert_eq!(co.connect_timeout, Some(Duration::from_secs(10)));
        assert_eq!(co.server_selection_timeout, Some(Duration::from_secs(10)));
        assert_eq!(co.max_pool_size, Some(4));
        assert_eq!(co.app_name.as_deref(), Some("IntelySwitchIDE"));
        // spec values, clamped to 1..=60 s
        let mut s = spec(&["db.example.com"]);
        s.timeouts.connect_ms = Some(2_500);
        s.timeouts.server_selection_ms = Some(900_000);
        s.app_name = Some("my app".into());
        let mut co = ClientOptions::default();
        co.max_pool_size = Some(99);
        co.min_pool_size = Some(50);
        co.heartbeat_freq = Some(Duration::from_millis(1));
        co.local_threshold = Some(Duration::from_secs(60));
        co.max_idle_time = Some(Duration::from_millis(5));
        co.srv_max_hosts = Some(400);
        apply_spec_options(&mut co, &s, EffectiveLevel::Local);
        assert_eq!(co.connect_timeout, Some(Duration::from_millis(2_500)));
        assert_eq!(co.server_selection_timeout, Some(Duration::from_secs(60)));
        assert_eq!(co.app_name.as_deref(), Some("my app"));
        assert_eq!((co.max_pool_size, co.min_pool_size), (Some(8), Some(4)));
        assert_eq!(co.heartbeat_freq, Some(Duration::from_millis(500)));
        assert_eq!(co.local_threshold, Some(Duration::from_millis(1_000)));
        assert_eq!(co.max_idle_time, Some(Duration::from_millis(1_000)));
        assert_eq!(co.srv_max_hosts, Some(16));
        // under an ssh tunnel the pool stays at 4 or less
        s.tunnel = ssh_tunnel();
        let mut co = ClientOptions::default();
        co.max_pool_size = Some(8);
        apply_spec_options(&mut co, &s, EffectiveLevel::ProductionLevel);
        assert_eq!(co.max_pool_size, Some(4));
    }

    #[test]
    fn read_preference_follows_the_spec_and_auto_follows_the_level() {
        use mongodb::options::ReadPreference as P;
        let with = |mode, level, stale: Option<u32>| {
            let mut s = spec(&["db.example.com"]);
            s.topology.read_preference = mode;
            s.topology.max_staleness_s = stale;
            let mut co = ClientOptions::default();
            apply_spec_options(&mut co, &s, level);
            pref_of(&co)
        };
        use crate::connspec::ReadPrefMode as M;
        use EffectiveLevel::*;
        assert!(matches!(with(M::Auto, ProductionLevel, None), P::SecondaryPreferred { .. }));
        assert!(matches!(with(M::Auto, Local, None), P::PrimaryPreferred { .. }));
        // D25: an explicit choice is honoured at the Production level too
        assert!(matches!(with(M::Primary, ProductionLevel, None), P::Primary));
        assert!(matches!(with(M::Nearest, ProductionLevel, None), P::Nearest { .. }));
        match with(M::Secondary, ProductionLevel, Some(120)) {
            P::Secondary { options } => assert_eq!(options.unwrap().max_staleness, Some(Duration::from_secs(120))),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_direct_connection_rule_skips_tunnels_and_srv() {
        let direct = |s: &ConnSpec, hosts: Vec<ServerAddress>| {
            let mut co = ClientOptions::default();
            co.hosts = hosts;
            apply_spec_options(&mut co, s, EffectiveLevel::Local);
            co.direct_connection
        };
        let tcp = |h: &str| ServerAddress::Tcp { host: h.into(), port: Some(27017) };
        let plain = spec(&["127.0.0.1"]);
        assert_eq!(direct(&plain, vec![tcp("127.0.0.1")]), Some(true));
        let mut tunnelled = spec(&["127.0.0.1"]);
        tunnelled.tunnel = ssh_tunnel();
        assert_eq!(direct(&tunnelled, vec![tcp("127.0.0.1")]), None, "discovery stays on so real member names reach the relay");
        tunnelled.tunnel = Tunnel::Socks5(ProxySpec { host: "127.0.0.1".into(), port: 1080, ..Default::default() });
        assert_eq!(direct(&tunnelled, vec![tcp("127.0.0.1")]), None);
        assert_eq!(direct(&spec(&["db.example.com"]), vec![tcp("db.example.com")]), None);
    }

    #[test]
    fn the_resolved_hosts_must_be_the_hosts_of_the_form_or_below_the_srv_parent() {
        let tcp = |h: &str, p: Option<u16>| ServerAddress::Tcp { host: h.into(), port: p };
        let s = spec(&["A.example.com", "[::1]"]);
        assert!(check_hosts(&s, &[tcp("[::1]", Some(27017)), tcp("a.example.com", None)]).is_ok());
        assert!(check_hosts(&s, &[tcp("a.example.com", Some(27017))]).is_err());
        assert!(check_hosts(&s, &[tcp("a.example.com", Some(27017)), tcp("::1", Some(27017)), tcp("evil.example.net", Some(27017))]).is_err());
        assert!(check_hosts(&s, &[tcp("a.example.com", Some(27018)), tcp("::1", Some(27017))]).is_err());
        assert!(check_hosts(&s, &[]).is_err());
        let mut srv = spec(&["cluster0.abc.mongodb.net"]);
        srv.scheme = Scheme::Srv;
        srv.hosts[0].port = None;
        assert!(check_hosts(&srv, &[tcp("cluster0-shard-00-00.abc.mongodb.net", Some(27017)), tcp("cluster0-shard-00-01.abc.mongodb.net", Some(27017))]).is_ok());
        assert!(check_hosts(&srv, &[tcp("cluster0-shard-00-00.abc.mongodb.net", Some(27017)), tcp("shard.evil.example.com", Some(27017))]).is_err());
        assert!(check_hosts(&srv, &[tcp("abc.mongodb.net", Some(27017))]).is_err(), "the parent itself is not below the parent");
    }

    #[tokio::test]
    async fn the_form_becomes_driver_options_with_secrets_off_the_uri() {
        let dir = tempfile::tempdir().unwrap();
        let ca = dir.path().join("ca.pem");
        let cert = dir.path().join("client.pem");
        std::fs::write(&ca, "x").unwrap();
        std::fs::write(&cert, "x").unwrap();
        let mut s = user(spec(&["db1.example.com", "db2.example.com"]));
        s.database = Some("shop".into());
        s.topology.replica_set = Some("rs0".into());
        s.tls.mode = TlsMode::On;
        s.tls.ca_file = Some(ca.to_string_lossy().into());
        s.tls.client_cert_file = Some(cert.to_string_lossy().into());
        let mut input = SpecConnect::new(&s);
        let (pw, kp) = (secret(PW), secret(KEYPW));
        input.password = Some(&pw);
        input.key_password = Some(&kp);
        let (co, level, fragments) = build_spec_options(&input, &remote_ok()).await.unwrap();
        assert_eq!(level, EffectiveLevel::ProductionLevel);
        let cred = co.credential.as_ref().unwrap();
        assert_eq!(cred.username.as_deref(), Some("svc-reader"));
        assert_eq!(cred.password.as_deref(), Some(PW), "special characters survive the encode/parse round trip");
        assert_eq!(co.repl_set_name.as_deref(), Some("rs0"));
        let Some(Tls::Enabled(t)) = &co.tls else { panic!("tls") };
        assert_eq!(t.allow_invalid_certificates, None);
        assert_eq!(t.ca_file_path.as_deref(), Some(ca.as_path()));
        assert_eq!(t.cert_key_file_path.as_deref(), Some(cert.as_path()));
        assert_eq!(t.tls_certificate_key_file_password.as_deref(), Some(KEYPW.as_bytes()), "the passphrase is set on the options");
        assert!(co.socks5_proxy.is_none());
        assert!(fragments.iter().any(|f| f == PW) && fragments.iter().any(|f| f == KEYPW) && fragments.iter().any(|f| f == "svc-reader"));
    }

    #[tokio::test]
    async fn x509_and_plain_authenticate_against_the_external_database() {
        let dir = tempfile::tempdir().unwrap();
        let cert = dir.path().join("c.pem");
        std::fs::write(&cert, "x").unwrap();
        let mut s = user(spec(&["db.example.com"]));
        s.auth.mechanism = AuthMechanism::X509;
        s.tls.mode = TlsMode::On;
        s.tls.client_cert_file = Some(cert.to_string_lossy().into());
        let (co, _, _) = build_spec_options(&SpecConnect::new(&s), &remote_ok()).await.unwrap();
        let cred = co.credential.unwrap();
        assert_eq!(cred.source.as_deref(), Some("$external"));
        assert!(cred.password.is_none());
    }

    #[tokio::test]
    async fn the_hosts_assertion_and_validation_run_before_a_session_exists() {
        // invalid spec: a leading dash is never a host
        let bad = spec(&["-oProxyCommand=x"]);
        let e = build_spec_options(&SpecConnect::new(&bad), &remote_ok()).await.unwrap_err();
        assert!(matches!(&e, Error::Uri(m) if m.starts_with("host.invalid")), "{e}");
        // remote host without the allow flag: nothing is built
        let remote = spec(&["db.example.com"]);
        assert!(matches!(build_spec_options(&SpecConnect::new(&remote), &SessionOpts::default()).await, Err(Error::NonLoopback)));
        // a tunnel with no open relay
        let mut t = spec(&["127.0.0.1"]);
        t.tunnel = ssh_tunnel();
        let e = build_spec_options(&SpecConnect::new(&t), &remote_ok()).await.unwrap_err();
        assert!(matches!(&e, Error::Uri(m) if m.starts_with("tunnel.notOpen")), "{e}");
        // a file that vanished since the form was saved
        let mut f = spec(&["db.example.com"]);
        f.tls.mode = TlsMode::On;
        f.tls.ca_file = Some("/definitely/not/here/ca.pem".into());
        let e = build_spec_options(&SpecConnect::new(&f), &remote_ok()).await.unwrap_err();
        assert!(matches!(&e, Error::Uri(m) if m == "config.fileMissing: tls.caFile"), "{e}");
    }

    #[tokio::test]
    async fn a_tunnel_sets_the_proxy_and_is_production_level_whatever_the_host_says() {
        let mut s = spec(&["127.0.0.1"]);
        s.tunnel = ssh_tunnel();
        // refused without the remote flag even though the seed is 127.0.0.1: it is not this computer
        assert!(matches!(build_spec_options(&SpecConnect::new(&s), &SessionOpts::default()).await, Err(Error::NonLoopback)));
        let mut input = SpecConnect::new(&s);
        input.relay = Some(relay());
        let (co, level, fragments) = build_spec_options(&input, &remote_ok()).await.unwrap();
        assert_eq!(level, EffectiveLevel::ProductionLevel);
        assert_eq!(co.direct_connection, None);
        let p = co.socks5_proxy.clone().unwrap();
        assert_eq!((p.host.as_str(), p.port), ("127.0.0.1", Some(41_999)));
        assert_eq!(p.authentication, Some(("rl-user-0123456789abcdef".into(), "rl-pass-0123456789abcdef".into())));
        assert!(fragments.iter().any(|f| f == "rl-pass-0123456789abcdef") && fragments.iter().any(|f| f == "opsuser"));
        // only the typed host (the bastion) lowers it
        let lowered = SessionOpts { allow_remote: true, host_override: true, min_level: EffectiveLevel::Local, ..Default::default() };
        let (_, level, _) = build_spec_options(&input, &lowered).await.unwrap();
        assert_eq!(level, EffectiveLevel::Local);
    }

    #[tokio::test]
    async fn the_socks5_option_keeps_the_password_off_the_uri_and_demands_tls_for_a_remote_proxy() {
        let mut s = spec(&["10.1.2.3"]);
        s.tunnel = Tunnel::Socks5(ProxySpec { host: "127.0.0.1".into(), port: 1080, username: Some("pxuser".into()), save_password: false });
        let px = secret(PROXYPW);
        let mut input = SpecConnect::new(&s);
        input.proxy_password = Some(&px);
        let (co, _, fragments) = build_spec_options(&input, &remote_ok()).await.unwrap();
        let p = co.socks5_proxy.unwrap();
        assert_eq!(p.authentication, Some(("pxuser".into(), PROXYPW.into())));
        assert!(fragments.iter().any(|f| f == PROXYPW));
        // a proxy on another computer sees RFC 1929 credentials in clear: TLS to the database is required
        s.tunnel = Tunnel::Socks5(ProxySpec { host: "proxy.example.com".into(), port: 1080, username: Some("pxuser".into()), save_password: false });
        let mut input = SpecConnect::new(&s);
        input.proxy_password = Some(&px);
        let e = build_spec_options(&input, &remote_ok()).await.unwrap_err();
        assert!(matches!(&e, Error::Uri(m) if m.starts_with("config.proxyPlain")), "{e}");
        s.tls.mode = TlsMode::On;
        let mut input = SpecConnect::new(&s);
        input.proxy_password = Some(&px);
        assert!(build_spec_options(&input, &remote_ok()).await.is_ok());
    }

    #[tokio::test]
    async fn skipping_certificate_checks_is_keyed_on_the_effective_level() {
        fn relax(s: &ConnSpec) -> SpecConnect<'_> {
            let mut i = SpecConnect::new(s);
            i.tls_relax = true;
            i.relay = Some(relay());
            i
        }
        let allowed_flag = |extra: SessionOpts| SessionOpts { allow_remote: true, ..extra };
        // a local server: allowed, and it reaches the TLS options
        let mut local = spec(&["127.0.0.1"]);
        local.tls.mode = TlsMode::On;
        let (co, _, _) = build_spec_options(&relax(&local), &SessionOpts::default()).await.unwrap();
        assert!(matches!(&co.tls, Some(Tls::Enabled(t)) if t.allow_invalid_certificates == Some(true)));
        // a remote host without the typed override: refused
        let mut remote = spec(&["db.example.com"]);
        remote.tls.mode = TlsMode::On;
        let e = build_spec_options(&relax(&remote), &allowed_flag(SessionOpts::default())).await.unwrap_err();
        assert!(matches!(&e, Error::Rejected(m) if m.starts_with("config.tlsRelaxRefused")), "{e}");
        // the same host with the typed override and a Test tag: allowed
        let lowered = allowed_flag(SessionOpts { host_override: true, min_level: EffectiveLevel::Local, ..Default::default() });
        assert!(build_spec_options(&relax(&remote), &lowered).await.is_ok());
        // ... but a Production tag (min_level) still refuses, override or not
        let tagged = allowed_flag(SessionOpts { host_override: true, min_level: EffectiveLevel::ProductionLevel, ..Default::default() });
        assert!(build_spec_options(&relax(&remote), &tagged).await.is_err());
        // a tunnel to "127.0.0.1" is Production-level: refused without the override
        let mut tun = spec(&["127.0.0.1"]);
        tun.tls.mode = TlsMode::On;
        tun.tunnel = ssh_tunnel();
        assert!(build_spec_options(&relax(&tun), &allowed_flag(SessionOpts::default())).await.is_err());
        // without the flag nothing is relaxed even if a string said so
        let mut co = ClientOptions::parse("mongodb://127.0.0.1/?tls=true&tlsAllowInvalidCertificates=true").await.unwrap();
        let mut input = SpecConnect::new(&local);
        input.tls_relax = false;
        apply_secrets_and_proxy(&mut co, &input, &[]).unwrap();
        assert!(matches!(&co.tls, Some(Tls::Enabled(t)) if t.allow_invalid_certificates.is_none()));
    }

    #[tokio::test]
    async fn legacy_connection_strings_run_through_the_new_policy() {
        let at = |uri: &'static str, opts: SessionOpts| async move { Session::connect(uri, opts).await };
        let prod = SessionOpts { allow_remote: true, min_level: EffectiveLevel::ProductionLevel, ..Default::default() };
        // relaxed tls or a proxy option at the Production level: refused (D10)
        for uri in ["mongodb://db.example.com/x?tlsAllowInvalidCertificates=true", "mongodb://db.example.com/x?tlsInsecure=true", "mongodb://db.example.com/x?proxyHost=10.0.0.9"] {
            let e = at(uri, prod.clone()).await.err().expect(uri);
            assert!(matches!(&e, Error::Rejected(m) if m.starts_with("config.tlsRelaxRefused")), "{uri}: {e}");
        }
        // a local server may relax, and the session says so
        let s = at("mongodb://127.0.0.1/x?tls=true&tlsAllowInvalidCertificates=true", SessionOpts::default()).await.unwrap();
        assert!(s.relaxed());
        assert!(!at("mongodb://127.0.0.1/x", SessionOpts::default()).await.unwrap().relaxed());
        // with the typed host the same remote string connects (lazily) and is marked relaxed
        let typed = SessionOpts { allow_remote: true, host_override: true, min_level: EffectiveLevel::Local, ..Default::default() };
        let s = at("mongodb://db.example.com/x?tls=true&tlsAllowInvalidCertificates=true", typed).await.unwrap();
        assert!(s.relaxed() && s.tls());
        // the legacy pinned options are unchanged: 5 s timeouts, the level decides the read preference
        let mut co = ClientOptions::parse("mongodb://db.example.com/x").await.unwrap();
        apply_options(&mut co, &SessionOpts::default(), EffectiveLevel::ProductionLevel);
        assert_eq!((co.connect_timeout, co.server_selection_timeout), (Some(Duration::from_secs(5)), Some(Duration::from_secs(5))));
        assert!(matches!(pref_of(&co), mongodb::options::ReadPreference::SecondaryPreferred { options: None }));
    }

    #[test]
    fn the_member_rule_is_judged_against_the_seeds() {
        let tunnelled = {
            let mut s = spec(&["127.0.0.1"]);
            s.tunnel = ssh_tunnel();
            SeedRule::from_spec(&s)
        };
        assert!(!members_outside(&doc! { "hosts": ["127.0.0.1:27017"] }, &tunnelled));
        assert!(members_outside(&doc! { "hosts": ["127.0.0.1:27017"], "passives": ["mongo-b.internal:27017"] }, &tunnelled));
        // an overridden remote seed keeps its own members; a member outside the seeds re-raises the level
        let remote = SeedRule::from_spec(&spec(&["db1.example.com", "db2.example.com"]));
        assert!(!members_outside(&doc! { "hosts": ["db1.example.com:27017", "db2.example.com:27017"] }, &remote));
        assert!(members_outside(&doc! { "hosts": ["db1.example.com:27017", "10.9.9.9:27017"] }, &remote));
        // the old loopback rule for loopback seeds
        let local = SeedRule::from_spec(&spec(&["127.0.0.1"]));
        assert!(!members_outside(&doc! { "hosts": ["127.0.0.1:27017", "localhost:27018"] }, &local));
        assert!(members_outside(&doc! { "hosts": ["127.0.0.1:27017", "172.17.0.4:27017"] }, &local));
    }

    #[tokio::test]
    async fn no_password_passphrase_name_or_path_reaches_an_error_or_a_debug_dump() {
        let dir = tempfile::tempdir().unwrap();
        let cert = dir.path().join("client-canary-key.pem");
        std::fs::write(&cert, "x").unwrap();
        let cert_path: String = cert.to_string_lossy().into();
        // failure paths that carry text: invalid spec, hosts mismatch (synthetic), refusal, parse failure
        let mut s = user(spec(&["db.example.com"]));
        s.tls.mode = TlsMode::On;
        s.tls.client_cert_file = Some(cert_path.clone());
        s.topology.replica_set = Some("rs0".into());
        // srvMaxHosts with a replica set is a driver-level parse error that quotes parts of the string
        s.extra = vec![crate::connspec::ExtraOption { key: "srvMaxHosts".into(), value: "2".into() }];
        let (pw, kp) = (secret(PW), secret(KEYPW));
        let mut input = SpecConnect::new(&s);
        input.password = Some(&pw);
        input.key_password = Some(&kp);
        input.tls_relax = true;
        let mut errors = vec![build_spec_options(&input, &remote_ok()).await.err().map(|e| e.to_string())];
        input.tls_relax = false;
        errors.push(build_spec_options(&input, &remote_ok()).await.err().map(|e| e.to_string()));
        errors.push(build_spec_options(&input, &SessionOpts::default()).await.err().map(|e| e.to_string()));
        let mut bad = s.clone();
        bad.hosts[0].host = "bad host".into();
        let mut i2 = SpecConnect::new(&bad);
        i2.password = Some(&pw);
        errors.push(build_spec_options(&i2, &remote_ok()).await.err().map(|e| e.to_string()));
        assert_eq!(errors.iter().flatten().count(), 4, "every path must fail with text: {errors:?}");
        for e in errors.into_iter().flatten() {
            for leak in [PW, KEYPW, "svc-reader", "client-canary-key", "p%40ss"] {
                assert!(!e.contains(leak), "{leak} leaked: {e}");
            }
        }
        // the fragments scrub a driver message that echoes them
        let fragments = input.fragments();
        let echoed = format!("auth failed for svc-reader with {PW} using {cert_path}");
        let clean = host::scrub(&echoed, &fragments);
        assert!(!clean.contains("svc-reader") && !clean.contains("p@ss") && !clean.contains("client-canary-key"), "{clean}");
        // nothing the endpoint prints holds its credentials
        let dbg = format!("{:?}", relay());
        assert!(!dbg.contains("rl-user") && !dbg.contains("rl-pass"), "{dbg}");
    }
}
