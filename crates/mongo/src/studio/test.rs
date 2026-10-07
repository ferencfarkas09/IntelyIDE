//! The staged connection test (T6b) and the gateway side of the connection commands ((design notes: mongo-everyone-spec) 5.6
//! to 5.8).
//!
//! `Studio::test_with` runs the pipeline of 5.8: Config (the jail first, then validation, the typed confirmation of
//! relaxed checks, the secrets, the files), Tunnel, name lookup, TCP, then the driver connect plus `ping` (TLS and sign-in
//! are inferred from the classified error or from the success of the probe) and the permissions probe. Every stage
//! reports through [`TestProgress`] events; a failure becomes a [`Diagnosis`] of codes (never prose) and the step list
//! of the failed run comes from [`diagnose::steps_for`], so a step that was not reached is never shown green.
//!
//! Nothing outward happens before the Config step passed: the jail check runs before any lookup, file probe or spawn,
//! and a missing secret (`mongoNeedSecret`) or a profile in review (`mongoNeedsReview`) answers before the network.
//! A test and a connection never share a tunnel (the owner key differs) and every way out closes the tunnel.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use intely_settings::Secret;
use serde::Serialize;

use super::{lock, ms32, Conn, Sink, Studio};
use crate::api::*;
use crate::audit::{event, AuditEvent};
use crate::connspec::{AuthMechanism, ConnSpec, HostPort, Scheme, TlsMode, Tunnel, TunnelAuth};
use crate::diagnose::{self, Ctx, Hint};
use crate::driver::{CancelToken, Error as DriverError, ProxyEndpoint, Session, SessionOpts, SpecConnect};
use crate::error::{code, Result, StudioError};
use crate::host;
use crate::profile::{ConnSecrets, Profile, Safety};
use crate::types::{EffectiveLevel, ReadCommand, RoleChip};
use crate::vault::{DialogHandles, DraftVault, ImportStaging};

#[cfg(unix)]
use super::tunnels::{Lease, Owner, Who};
#[cfg(unix)]
use crate::tunnel::{AllowList, TunnelEnv, TunnelSecrets};

/// The phrase `reset_all` wants typed.
pub const RESET_PHRASE: &str = "reset mongo";

/// At most one test (or host-key scan) starts per this long, across all test ids.
const DEFAULT_GAP: Duration = Duration::from_secs(1);
/// The hard cap of one test (5.8: "hard cap 45 s, then `timeout.total`").
const BUDGET_CAP: Duration = Duration::from_secs(45);
const DNS_TIMEOUT: Duration = Duration::from_secs(3);

/// The payload of the `mongo:test` event: the whole step list after every change (`done` on the last one).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TestProgress {
    pub test_id: String,
    pub steps: Vec<TestStep>,
    pub done: bool,
}

// ---------------------------------------------------------------------------------------------------------------------
// State the gateway keeps for the new commands. Every part is empty (or not created) until first used.
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Default)]
struct Book {
    running: HashMap<String, Arc<AtomicBool>>,
    last_start: Option<Instant>,
}

/// Secrets typed at the connect prompt, kept in memory for this app session, bound to the identity they were typed for.
struct Remembered {
    identity: String,
    secrets: ConnSecrets,
}

#[derive(Default)]
pub(super) struct Extras {
    vault: OnceLock<DraftVault>,
    handles: OnceLock<DialogHandles>,
    staging: OnceLock<ImportStaging>,
    book: Mutex<Book>,
    remembered: Mutex<HashMap<String, Remembered>>,
    happy_preset: AtomicBool,
    gap: Mutex<Option<Duration>>,
    budget: Mutex<Option<Duration>>,
    #[cfg(unix)]
    tunnel_env: Mutex<Option<TunnelEnv>>,
}

impl Extras {
    pub(super) fn happy_preset(&self) -> bool {
        self.happy_preset.load(Ordering::Relaxed)
    }
}

static ADHOC: AtomicU64 = AtomicU64::new(1);

struct TestGuard<'a> {
    studio: &'a Studio,
    id: String,
}

impl Drop for TestGuard<'_> {
    fn drop(&mut self) {
        lock(&self.studio.extras.book).running.remove(&self.id);
    }
}

fn valid_test_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// ---------------------------------------------------------------------------------------------------------------------
// The step tracker
// ---------------------------------------------------------------------------------------------------------------------

const ORDER: [StepId; 7] = [StepId::Config, StepId::Tunnel, StepId::Dns, StepId::Connect, StepId::Tls, StepId::Auth, StepId::Permissions];

fn at(id: StepId) -> usize {
    ORDER.iter().position(|s| *s == id).unwrap_or(0)
}

struct Tracker {
    test_id: String,
    steps: Vec<TestStep>,
    since: [Option<Instant>; 7],
    sink: Option<Arc<dyn Sink>>,
}

impl Tracker {
    fn new(test_id: &str, sink: Option<Arc<dyn Sink>>) -> Self {
        Self { test_id: test_id.to_string(), steps: ORDER.iter().map(|id| TestStep { id: *id, state: StepState::Pending, ms: 0, note: None }).collect(), since: [None; 7], sink }
    }

    fn emit(&self, done: bool) {
        if let Some(s) = &self.sink {
            s.test_progress(&TestProgress { test_id: self.test_id.clone(), steps: self.steps.clone(), done });
        }
    }

    fn running(&mut self, id: StepId) {
        let i = at(id);
        self.steps[i].state = StepState::Running;
        self.since[i] = Some(Instant::now());
        self.emit(false);
    }

    fn finish(&mut self, id: StepId, state: StepState, note: Option<String>) {
        let i = at(id);
        self.steps[i].state = state;
        self.steps[i].ms = self.since[i].map_or(0, |t| ms32(t.elapsed()));
        self.steps[i].note = note;
        self.emit(false);
    }

    fn skip(&mut self, id: StepId) {
        self.finish(id, StepState::Skipped, None);
    }

    fn state(&self, id: StepId) -> StepState {
        self.steps[at(id)].state
    }

    /// The step that is running right now.
    fn current(&self) -> Option<usize> {
        self.steps.iter().position(|s| s.state == StepState::Running)
    }

    /// The step list of a failed run: what [`diagnose::steps_for`] says, with the measured times of the steps that ran.
    fn failed(&self, diag: &Diagnosis, ctx: &Ctx) -> Vec<TestStep> {
        let mut out = diagnose::steps_for(diag, ctx);
        for (o, mine) in out.iter_mut().zip(&self.steps) {
            o.ms = mine.ms;
            o.note = mine.note.clone();
        }
        out
    }

    /// The step list of a run that ran out of budget: the running step failed, everything after it was not reached.
    fn timed_out(&self) -> Vec<TestStep> {
        let cur = self.current().unwrap_or(at(StepId::Connect));
        self.steps
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let state = if i < cur {
                    if matches!(s.state, StepState::Ok | StepState::Skipped | StepState::Warn) { s.state } else { StepState::Skipped }
                } else if i == cur {
                    StepState::Failed
                } else {
                    StepState::Skipped
                };
                TestStep { state, ..s.clone() }
            })
            .collect()
    }
}

type Shared = Arc<Mutex<Tracker>>;

// ---------------------------------------------------------------------------------------------------------------------
// What the pipeline works on
// ---------------------------------------------------------------------------------------------------------------------

/// Everything derived from a spec before any outward action.
struct Prepared {
    spec: ConnSpec,
    secrets: ConnSecrets,
    /// The saved profile, or the draft the form describes (id, name, tag, host facts, safety).
    profile: Profile,
    level: EffectiveLevel,
    host_override: bool,
    relax: bool,
    ctx: Ctx,
}

enum Staged {
    Passed { view: ConnectionView, warnings: Vec<String>, refused: Vec<String>, members: Vec<String> },
    Failed { diag: Diagnosis, ctx: Ctx, host_key: Option<HostKeyView>, refused: Vec<String> },
}

type Prep = std::result::Result<Prepared, (Diagnosis, Ctx)>;

/// A tunnel lease (unix) and the open session, closed by [`Resources::close`] whatever happened.
#[derive(Default)]
struct Resources {
    session: Option<Session>,
    #[cfg(unix)]
    lease: Option<Lease>,
}

impl Resources {
    async fn close(&mut self) {
        if let Some(s) = self.session.take() {
            s.close();
        }
        #[cfg(unix)]
        if let Some(l) = self.lease.take() {
            l.close().await;
        }
    }

    fn tunnel_up(&self) -> bool {
        #[cfg(unix)]
        {
            self.lease.is_some()
        }
        #[cfg(not(unix))]
        {
            false
        }
    }
}

/// What the pass through the driver found.
struct Reached {
    /// `None` when only the role probe was refused (`authz` then says why).
    probe: Option<crate::driver::Probe>,
    authz: Option<Diagnosis>,
    tls: bool,
    has_auth: bool,
    refused: Vec<String>,
    tunnel_up: bool,
}

fn strip_brackets(h: &str) -> &str {
    h.trim_start_matches('[').trim_end_matches(']')
}

fn all_loopback(spec: &ConnSpec) -> bool {
    !spec.hosts.is_empty() && spec.hosts.iter().all(|h| host::is_loopback_host(&strip_brackets(&h.host).to_ascii_lowercase()))
}

/// What the classifier may mention. `scrub` carries the per-connection registry (user names, key paths, secrets).
fn ctx_for(spec: &ConnSpec, relax: bool, secrets: Option<&ConnSecrets>) -> Ctx {
    let exposed: Vec<&str> = secrets
        .map(|s| [&s.password, &s.key_password, &s.ssh_secret, &s.proxy_password].into_iter().flatten().map(Secret::expose).collect())
        .unwrap_or_default();
    Ctx {
        hosts: spec.hosts.iter().map(|h| strip_brackets(&h.host).to_string()).collect(),
        is_atlas: spec.hosts.iter().any(|h| h.host.to_ascii_lowercase().ends_with(".mongodb.net")),
        srv: spec.scheme == Scheme::Srv,
        tls_mode: spec.tls.mode,
        has_ca: spec.tls.ca_file.as_deref().is_some_and(|p| !p.is_empty()),
        has_client_cert: spec.tls.client_cert_file.as_deref().is_some_and(|p| !p.is_empty()),
        tunnel: spec.tunnel.kind(),
        relaxed: relax,
        refused_hosts: Vec::new(),
        scrub: host::spec_fragments(spec, &exposed),
    }
}

/// The profile a form describes: the saved one's identity and safety state, overlaid with what the form says.
fn draft_profile(input: &ProfileInput, spec: &ConnSpec, stored: Option<&Profile>) -> Profile {
    let remote = spec.remote_host();
    let typed = input.level_override_host.as_deref().map(str::trim);
    let level_override = match typed {
        Some("") => None,
        Some(t) => remote.as_deref().filter(|r| r.eq_ignore_ascii_case(t)).map(str::to_string),
        None => stored.and_then(|p| p.safety.level_override.clone()).filter(|o| remote.as_deref().is_some_and(|r| r.eq_ignore_ascii_case(o))),
    };
    Profile {
        id: input.id.clone().unwrap_or_else(|| "draft".into()),
        name: input.name.trim().to_string(),
        max_time_ms: input.max_time_ms.or(stored.map(|p| p.max_time_ms)).unwrap_or(crate::types::DEFAULT_MAX_TIME_MS as u32),
        host: host::display_host(&spec.host_info()),
        host_level: spec.host_level(),
        remote_host: remote,
        safety: Safety {
            read_only: true,
            environment: input.environment,
            ai_mode: AiMode::Off,
            tenant_lock: None,
            level_override,
            tls_relax: input.tls_relax.or(stored.map(|p| p.safety.tls_relax)).unwrap_or(TlsRelax::None),
        },
        conn: Some(spec.clone()),
        domain: stored.map_or(Domain::Generic, |p| p.domain),
        ..Profile::default()
    }
}

const PEM_CAP: usize = 256 * 1024;

/// Existence and a cheap PEM header check of the files a spec names (no new dependency, nothing parsed).
fn check_files(spec: &ConnSpec, ctx: &Ctx) -> Option<Diagnosis> {
    let mut files: Vec<(&str, &str, &[&str])> = Vec::new();
    if let Some(p) = spec.tls.ca_file.as_deref().filter(|p| !p.is_empty()) {
        files.push(("tls.caFile", p, &["BEGIN CERTIFICATE"]));
    }
    if let Some(p) = spec.tls.client_cert_file.as_deref().filter(|p| !p.is_empty()) {
        files.push(("tls.clientCertFile", p, &["BEGIN CERTIFICATE", "PRIVATE KEY"]));
    }
    if let Tunnel::Ssh(s) = &spec.tunnel {
        if let Some(p) = s.key_file.as_deref().filter(|p| !p.is_empty()) {
            files.push(("tunnel.keyFile", p, &[]));
        }
    }
    let diag = |c: &str, field: &str| diagnose::from_code(c, vec![("field".into(), field.into())], field, ctx);
    for (field, path, needles) in files {
        if !std::fs::metadata(path).is_ok_and(|m| m.is_file()) {
            return Some(diag("config.fileMissing", field));
        }
        if needles.is_empty() {
            continue;
        }
        let bytes = std::fs::File::open(path).and_then(|f| {
            use std::io::Read;
            let mut buf = Vec::new();
            f.take(PEM_CAP as u64).read_to_end(&mut buf).map(|_| buf)
        });
        let Ok(bytes) = bytes else { return Some(diag("config.fileMissing", field)) };
        let text = String::from_utf8_lossy(&bytes);
        if needles.iter().any(|n| !text.contains(n)) {
            return Some(diag("config.pemInvalid", field));
        }
    }
    None
}

/// `host:port` entries the relay may reach: the seeds (Standard) or the SRV name (parent domain), plus `allowed_hosts`.
#[cfg(unix)]
fn allow_list(spec: &ConnSpec, ssh: &crate::connspec::SshSpec) -> AllowList {
    let mut entries: Vec<HostPort> = spec
        .hosts
        .iter()
        .map(|h| HostPort { host: strip_brackets(&h.host).to_string(), port: if spec.scheme == Scheme::Srv { None } else { Some(h.port.unwrap_or(27017)) } })
        .collect();
    entries.extend(ssh.allowed_hosts.iter().map(|a| HostPort { host: a.host.clone(), port: Some(a.port) }));
    AllowList { entries }
}

/// Text about SRV or name lookups that the options builder wraps as `config.invalid` is a DNS problem.
fn classify_driver(e: &DriverError, ctx: &Ctx) -> Diagnosis {
    let text = e.to_string();
    if ctx.srv {
        if let DriverError::Uri(m) = e {
            let lower = m.to_ascii_lowercase();
            if m.starts_with("config.invalid") && ["srv", "txt", "dns", "resolve", "lookup", "no records"].iter().any(|k| lower.contains(k)) {
                let rest = m.split_once(':').map_or(m.as_str(), |(_, r)| r.trim());
                return diagnose::classify_hint(Hint::Dns, rest, ctx);
            }
        }
    }
    diagnose::classify_text(&text, ctx)
}

async fn wait_cancel(flag: &AtomicBool) {
    while !flag.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

fn cancelled() -> StudioError {
    StudioError::new(code::CANCELLED, "the test was cancelled")
}

fn budget_of(spec: &ConnSpec) -> Duration {
    let ct = Duration::from_millis(u64::from(spec.timeouts.connect()));
    let sel = Duration::from_millis(u64::from(spec.timeouts.server_selection()));
    let tunnel = if matches!(spec.tunnel, Tunnel::Ssh(_)) { ct + Duration::from_secs(15) } else { Duration::ZERO };
    (tunnel + ct + sel).min(BUDGET_CAP)
}

// ---------------------------------------------------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------------------------------------------------

impl Studio {
    /// Lowest time between two test (or host-key scan) starts; tests set it to zero.
    pub fn with_test_gap(self, gap: Duration) -> Self {
        *lock(&self.extras.gap) = Some(gap);
        self
    }

    /// Overrides the overall budget of a structured test (tests only; the default follows the spec's timeouts).
    pub fn with_test_budget(self, budget: Duration) -> Self {
        *lock(&self.extras.budget) = Some(budget);
        self
    }

    /// `mongo.happyPreset` (the glue copies the persisted setting here): a file's `domain: happy` is honoured on import
    /// only while it is on.
    pub fn set_happy_preset(&self, on: bool) {
        self.extras.happy_preset.store(on, Ordering::Relaxed);
    }

    /// Tests and the E2E harness describe the process around the tunnels (fake ssh, temp directories).
    #[cfg(unix)]
    pub fn with_tunnel_env(self, env: TunnelEnv) -> Self {
        *lock(&self.extras.tunnel_env) = Some(env);
        self
    }

    #[cfg(unix)]
    pub(super) fn tunnel_env(&self) -> TunnelEnv {
        let mut g = lock(&self.extras.tunnel_env);
        g.get_or_insert_with(|| TunnelEnv::new(self.jail(), self.profiles.settings_dir())).clone()
    }

    /// The write jail of this gateway: the network policy plus the fixture root of the E2E harness.
    pub(super) fn jail(&self) -> crate::jail::Jail {
        let root = std::env::var("INTELY_FIXTURE_ROOT").ok().filter(|r| !r.is_empty()).map(std::path::PathBuf::from);
        crate::jail::Jail::new(self.network, &std::env::temp_dir(), root.as_deref())
    }

    pub(super) fn vault(&self) -> &DraftVault {
        self.extras.vault.get_or_init(DraftVault::new)
    }

    pub(super) fn handles(&self) -> &DialogHandles {
        self.extras.handles.get_or_init(DialogHandles::new)
    }

    pub(super) fn staging(&self) -> &ImportStaging {
        self.extras.staging.get_or_init(ImportStaging::new)
    }

    /// Whether any of the lazily created parts exists (the zero-cost test).
    pub fn extras_created(&self) -> bool {
        self.extras.vault.get().is_some() || self.extras.handles.get().is_some() || self.extras.staging.get().is_some()
    }

    /// One start per gap across all ids (tests and host-key scans share it).
    pub(super) fn rate_gate(&self) -> Result<()> {
        let gap = lock(&self.extras.gap).unwrap_or(DEFAULT_GAP);
        let mut b = lock(&self.extras.book);
        if let Some(t) = b.last_start {
            if t.elapsed() < gap {
                return Err(StudioError::new(code::BUSY, "one connection test per second"));
            }
        }
        b.last_start = Some(Instant::now());
        Ok(())
    }

    /// Switch off, quit-time cleanup of everything T6b keeps: running tests are cancelled, drafts, handles, staged
    /// imports and remembered secrets are wiped.
    pub(super) fn shutdown_extras(&self) {
        for f in lock(&self.extras.book).running.values() {
            f.store(true, Ordering::SeqCst);
        }
        if let Some(v) = self.extras.vault.get() {
            v.clear();
        }
        if let Some(h) = self.extras.handles.get() {
            h.clear();
        }
        if let Some(s) = self.extras.staging.get() {
            s.clear();
        }
        lock(&self.extras.remembered).clear();
    }

    pub(super) fn forget_session_secrets(&self, id: &str) {
        lock(&self.extras.remembered).remove(id);
        if let Some(v) = self.extras.vault.get() {
            v.clear_owner(id);
        }
    }

    /// Fills the secrets a draft token carries into a save (the profile store never sees a token). The token is bound to
    /// the identity it was typed for: a spec for another destination is refused.
    pub(super) fn redeem_draft(&self, mut input: ProfileInput) -> Result<ProfileInput> {
        let Some(token) = input.draft.clone() else { return Ok(input) };
        let Some(spec) = input.spec.as_ref() else { return Err(StudioError::new(code::INVALID, "a draft belongs to fields, not to a connection string")) };
        let d = self.vault().take_for(&token, input.id.as_deref(), &spec.secret_identity())?;
        if input.password.is_none() {
            input.password = d.password.map(|s| WireSecret::new(s.expose()));
        }
        if input.key_password.is_none() {
            input.key_password = d.key_password.map(|s| WireSecret::new(s.expose()));
        }
        input.draft = None;
        Ok(input)
    }

    /// Supplied secrets plus whatever this session remembers for the same identity. A remembered secret never overrides a
    /// typed one and is never used for another destination.
    fn with_remembered(&self, id: Option<&str>, identity: &str, mut s: SessionSecrets) -> SessionSecrets {
        let Some(id) = id else { return s };
        if let Some(r) = lock(&self.extras.remembered).get(id).filter(|r| r.identity == identity) {
            let fill = |slot: &mut Option<WireSecret>, v: &Option<Secret>| {
                if slot.as_ref().is_none_or(WireSecret::is_empty) {
                    *slot = v.as_ref().map(|x| WireSecret::new(x.expose()));
                }
            };
            fill(&mut s.password, &r.secrets.password);
            fill(&mut s.key_password, &r.secrets.key_password);
            fill(&mut s.ssh_secret, &r.secrets.ssh_secret);
            fill(&mut s.proxy_password, &r.secrets.proxy_password);
        }
        s
    }

    fn remember(&self, id: &str, spec: &ConnSpec, secrets: &ConnSecrets) {
        lock(&self.extras.remembered).insert(id.to_string(), Remembered { identity: spec.secret_identity(), secrets: secrets.clone() });
    }

    /// The staged test with a test id: `mongo:test` events, one test per id at a time, one start per second overall.
    pub async fn test_with(&self, input: ProfileInput, test_id: &str) -> Result<TestReport> {
        self.run_test(input, Some(test_id)).await
    }

    /// Cancels a running test and closes the tunnel it opened. `false` when no such test runs.
    pub async fn test_cancel(&self, test_id: &str) -> Result<bool> {
        self.ensure_enabled()?;
        let flag = lock(&self.extras.book).running.get(test_id).cloned();
        let found = flag.is_some();
        if let Some(f) = flag {
            f.store(true, Ordering::SeqCst);
        }
        #[cfg(unix)]
        self.tunnels.cancel_test(test_id).await;
        Ok(found)
    }

    pub(super) async fn run_test(&self, input: ProfileInput, test_id: Option<&str>) -> Result<TestReport> {
        self.ensure_enabled()?;
        let (id, cancel, _guard) = match test_id {
            Some(id) => {
                if !valid_test_id(id) {
                    return Err(StudioError::new(code::INVALID, "a test id is 1 to 64 letters, digits, - and _"));
                }
                if lock(&self.extras.book).running.contains_key(id) {
                    return Err(StudioError::new(code::BUSY, "this test is already running"));
                }
                self.rate_gate()?;
                let flag = Arc::new(AtomicBool::new(false));
                lock(&self.extras.book).running.insert(id.to_string(), flag.clone());
                (id.to_string(), flag, Some(TestGuard { studio: self, id: id.to_string() }))
            }
            None => (format!("adhoc{}", ADHOC.fetch_add(1, Ordering::Relaxed)), Arc::new(AtomicBool::new(false)), None),
        };
        let started = Instant::now();
        let uri_text = input.uri.as_ref().map(|u| u.expose().trim().to_string()).filter(|u| !u.is_empty());
        if uri_text.is_some() && input.spec.is_some() {
            return Err(StudioError::new(code::INVALID, "send a connection string or fields, not both"));
        }
        let stored = match input.id.as_deref() {
            Some(pid) => Some(self.profiles.connectable(pid)?),
            None => None,
        };
        let tracker: Shared = Arc::new(Mutex::new(Tracker::new(&id, lock(&self.sink).clone())));
        let spec = input.spec.clone().or_else(|| if uri_text.is_none() { stored.as_ref().and_then(|p| p.conn.clone()) } else { None });
        let report = match spec {
            Some(spec) => self.test_spec(&input, spec, stored.as_ref(), &id, &cancel, &tracker, started).await?,
            None => {
                let uri = match uri_text {
                    Some(u) => u,
                    None => {
                        let pid = input.id.as_deref().ok_or_else(|| StudioError::new(code::NO_URI, "paste a connection string"))?;
                        self.profiles.uri(pid)?.ok_or_else(|| StudioError::new(code::NO_URI, "this connection has no saved connection string"))?.expose().to_string()
                    }
                };
                self.test_legacy(&input, &uri, &tracker, started).await?
            }
        };
        lock(&tracker).emit(true);
        Ok(report)
    }

    fn failed_report(&self, tr: &Shared, started: Instant, diag: Diagnosis, ctx: &Ctx, host_key: Option<HostKeyView>, refused: Vec<String>) -> TestReport {
        let mut t = lock(tr);
        let steps = t.failed(&diag, ctx);
        t.steps = steps.clone();
        TestReport {
            ok: false,
            elapsed_ms: ms32(started.elapsed()),
            error: Some(diag.detail.clone()).filter(|d| !d.is_empty()).or_else(|| Some(diag.code.clone())),
            error_class: Some(diag.class),
            steps,
            diagnosis: Some(diag),
            host_key,
            refused,
            ..Default::default()
        }
    }

    // ---- legacy profiles (one stored connection string) ------------------------------------------------------

    async fn test_legacy(&self, input: &ProfileInput, uri: &str, tr: &Shared, started: Instant) -> Result<TestReport> {
        let fragments = host::credential_fragments(uri);
        let info = host::parse_uri(uri).map_err(|e| StudioError::new(code::INVALID, host::scrub(&e.0, &fragments)))?;
        // A draft is judged by the tag it carries and the host rule; nothing is saved.
        let draft = Profile {
            id: input.id.clone().unwrap_or_else(|| "draft".into()),
            name: input.name.trim().to_string(),
            color: String::new(),
            max_time_ms: input.max_time_ms.unwrap_or(crate::types::DEFAULT_MAX_TIME_MS as u32),
            host: host::display_host(&info),
            host_level: host::effective_level(&info),
            remote_host: host::first_remote_host(&info).map(str::to_string),
            safety: Safety { read_only: true, environment: input.environment, ai_mode: AiMode::Off, tenant_lock: None, level_override: None, tls_relax: TlsRelax::None },
            has_uri: true,
            ..Profile::default()
        };
        let ctx = Ctx {
            hosts: info.hosts.clone(),
            is_atlas: info.hosts.iter().any(|h| h.ends_with(".mongodb.net")),
            srv: info.srv,
            tunnel: "none",
            scrub: fragments.clone(),
            ..Ctx::default()
        };
        {
            let mut t = lock(tr);
            t.running(StepId::Config);
            t.finish(StepId::Config, StepState::Ok, None);
            t.skip(StepId::Tunnel);
            t.running(StepId::Connect);
        }
        match self.open(&draft, uri).await {
            Ok((session, view)) => {
                let tls = session.tls();
                session.close();
                let mut t = lock(tr);
                t.skip(StepId::Dns);
                t.finish(StepId::Connect, StepState::Ok, None);
                if tls {
                    t.finish(StepId::Tls, StepState::Ok, None);
                } else {
                    t.skip(StepId::Tls);
                }
                t.finish(StepId::Auth, StepState::Ok, None);
                t.finish(StepId::Permissions, if matches!(view.role, RoleChip::Unknown { .. }) { StepState::Warn } else { StepState::Ok }, None);
                let steps = t.steps.clone();
                Ok(TestReport { ok: true, elapsed_ms: ms32(started.elapsed()), connection: Some(view), steps, ..Default::default() })
            }
            Err(e) => {
                let message = host::scrub(&e.message, &fragments);
                let diag = if matches!(e.code, code::READ_ONLY_JAIL | code::TEST_JAIL) {
                    diagnose::from_code("config.invalid", vec![("reason".into(), e.code.into())], &message, &ctx)
                } else {
                    diagnose::classify_text(&message, &ctx)
                };
                Ok(self.failed_report(tr, started, diag, &ctx, None, Vec::new()))
            }
        }
    }

    // ---- structured connections -----------------------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    async fn test_spec(&self, input: &ProfileInput, spec: ConnSpec, stored: Option<&Profile>, id: &str, cancel: &Arc<AtomicBool>, tr: &Shared, started: Instant) -> Result<TestReport> {
        let budget = lock(&self.extras.budget).unwrap_or_else(|| budget_of(&spec));
        let mut res = Resources::default();
        let staged = tokio::time::timeout(budget, self.spec_stages(input, spec.clone(), stored, id, cancel, tr, &mut res)).await;
        #[cfg(unix)]
        let refused_now = self.refused_of(&Owner::Test(id.to_string()));
        #[cfg(not(unix))]
        let refused_now: Vec<String> = Vec::new();
        res.close().await;
        match staged {
            Ok(Ok(Staged::Passed { view, warnings, refused, members })) => {
                let t = lock(tr);
                Ok(TestReport { ok: true, elapsed_ms: ms32(started.elapsed()), connection: Some(view), steps: t.steps.clone(), refused, warnings, members, ..Default::default() })
            }
            Ok(Ok(Staged::Failed { diag, ctx, host_key, refused })) => Ok(self.failed_report(tr, started, diag, &ctx, host_key, refused)),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                let ctx = ctx_for(&spec, false, None);
                let diag = diagnose::from_code("timeout.total", Vec::new(), "the test ran out of its overall budget", &ctx);
                let mut t = lock(tr);
                let steps = t.timed_out();
                t.steps = steps.clone();
                Ok(TestReport { ok: false, elapsed_ms: ms32(started.elapsed()), error: Some(diag.detail.clone()), error_class: Some(diag.class), steps, diagnosis: Some(diag), refused: refused_now, ..Default::default() })
            }
        }
    }

    #[cfg(unix)]
    fn refused_of(&self, owner: &Owner) -> Vec<String> {
        self.tunnels.info(owner).map(|i| i.refused.iter().map(|h| format!("{}:{}", h.host, h.port.unwrap_or(27017))).collect()).unwrap_or_default()
    }

    /// Config step: everything that can be judged without touching the network. Outer `Err` is a precondition the UI
    /// answers itself (`mongoNeedSecret`, `mongoConfirm`, `mongoNeedsReview`); inner `Err` is a diagnosed failure.
    fn prepare(&self, input: &ProfileInput, spec: ConnSpec, stored: Option<&Profile>) -> Result<Prep> {
        let ctx0 = ctx_for(&spec, false, None);
        let fail = |d: Diagnosis| -> Result<Prep> { Ok(Err((d, ctx0.clone()))) };
        // 1. the jail, before anything else: no lookup, no file probe, no spawn
        if let Err(e) = self.network.check_spec(&spec) {
            return fail(diagnose::from_code("config.invalid", vec![("reason".into(), e.code.into())], &e.message, &ctx0));
        }
        // 2. field problems
        if let Some(p) = spec.errors().into_iter().next() {
            let c = if p.code == "config.plainRemote" { "config.plainRemote" } else { "config.invalid" };
            return fail(diagnose::from_code(c, vec![("path".into(), p.path.clone()), ("problem".into(), p.code.clone())], &p.code, &ctx0));
        }
        // 3. relaxed certificate checks: refused at the effective Production level, typed confirmation otherwise
        let draft = draft_profile(input, &spec, stored);
        let relax = draft.safety.tls_relax != TlsRelax::None;
        if relax {
            if draft.effective_level(None) == EffectiveLevel::ProductionLevel {
                return fail(diagnose::from_code("config.tlsRelaxRefused", Vec::new(), "certificate checks cannot be skipped on a production-level connection", &ctx0));
            }
            let was_relaxed = stored.is_some_and(|p| p.safety.tls_relax != TlsRelax::None);
            if !was_relaxed && input.confirm.as_deref() != Some(draft.name.as_str()) {
                return Err(StudioError::new(code::CONFIRM, "skipping certificate checks needs the connection name typed to confirm"));
            }
        }
        // 4. secrets: supplied now, in a draft, remembered for this session, or stored for the SAME identity
        let identity = spec.secret_identity();
        let mut supplied = input.supplied_secrets();
        if let Some(tok) = input.draft.as_deref() {
            let d = self.vault().get_for(tok, input.id.as_deref(), &identity)?;
            if supplied.password.is_none() {
                supplied.password = d.password.map(|s| WireSecret::new(s.expose()));
            }
            if supplied.key_password.is_none() {
                supplied.key_password = d.key_password.map(|s| WireSecret::new(s.expose()));
            }
        }
        let supplied = self.with_remembered(input.id.as_deref(), &identity, supplied);
        let secrets = self.profiles.resolve_secrets(input.id.as_deref(), &spec, &supplied)?;
        let ctx = ctx_for(&spec, relax, Some(&secrets));
        // 5. files
        if let Some(d) = check_files(&spec, &ctx) {
            return Ok(Err((d, ctx)));
        }
        let level = draft.effective_level(None);
        let host_override = draft.safety.level_override.is_some();
        Ok(Ok(Prepared { spec, secrets, profile: draft, level, host_override, relax, ctx }))
    }

    #[allow(clippy::too_many_arguments)]
    async fn spec_stages(&self, input: &ProfileInput, spec: ConnSpec, stored: Option<&Profile>, id: &str, cancel: &Arc<AtomicBool>, tr: &Shared, res: &mut Resources) -> Result<Staged> {
        lock(tr).running(StepId::Config);
        let p = match self.prepare(input, spec, stored)? {
            Ok(p) => p,
            Err((diag, ctx)) => return Ok(Staged::Failed { diag, ctx, host_key: None, refused: Vec::new() }),
        };
        lock(tr).finish(StepId::Config, StepState::Ok, None);
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        let mut ctx = p.ctx.clone();
        let mut relay: Option<ProxyEndpoint> = None;
        let failed = |diag: Diagnosis, ctx: Ctx| Ok(Staged::Failed { diag, ctx, host_key: None, refused: Vec::new() });

        // ---- Tunnel
        match &p.spec.tunnel {
            Tunnel::Ssh(_) => {
                lock(tr).running(StepId::Tunnel);
                #[cfg(unix)]
                {
                    match self.open_ssh(&p, Owner::Test(id.to_string()), cancel.clone()).await {
                        Ok(Some((lease, ep))) => {
                            res.lease = Some(lease);
                            relay = Some(ep);
                            lock(tr).finish(StepId::Tunnel, StepState::Ok, None);
                        }
                        Ok(None) => lock(tr).skip(StepId::Tunnel),
                        Err(e) => {
                            if matches!(e.code, code::CANCELLED | code::NEED_SECRET | code::BUSY) {
                                return Err(e);
                            }
                            let diag = diagnose::classify_text(&e.message, &ctx);
                            let host_key = if matches!(diag.code.as_str(), "tunnel.hostKeyUnknown" | "tunnel.hostKeyChanged") { self.host_key_of(&p.spec).await } else { None };
                            return Ok(Staged::Failed { diag, ctx, host_key, refused: Vec::new() });
                        }
                    }
                }
                #[cfg(not(unix))]
                {
                    let _ = (id, &res);
                    let diag = diagnose::from_code("tunnel.noSsh", Vec::new(), "SSH tunnels are not available on this system", &ctx);
                    return failed(diag, ctx);
                }
            }
            _ => lock(tr).skip(StepId::Tunnel),
        }

        // ---- Name lookup and TCP (direct connections only; behind a proxy resolution is remote)
        let direct = p.spec.tunnel.is_none();
        let ct = Duration::from_millis(u64::from(p.spec.timeouts.connect()));
        if p.spec.scheme == Scheme::Standard && direct {
            lock(tr).running(StepId::Dns);
            let mut first: Option<SocketAddr> = None;
            for h in &p.spec.hosts {
                let name = strip_brackets(&h.host).to_string();
                let port = h.port.unwrap_or(27017);
                match tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host((name.clone(), port))).await {
                    Ok(Ok(mut it)) => {
                        if first.is_none() {
                            first = it.next();
                        }
                    }
                    Ok(Err(e)) => return failed(diagnose::from_code("dns.notFound", vec![("host".into(), name)], &e.to_string(), &ctx), ctx),
                    Err(_) => return failed(diagnose::from_code("dns.notFound", vec![("host".into(), name)], "the name lookup timed out", &ctx), ctx),
                }
            }
            lock(tr).finish(StepId::Dns, StepState::Ok, None);
            if let Some(addr) = first {
                lock(tr).running(StepId::Connect);
                match tokio::time::timeout(ct, tokio::net::TcpStream::connect(addr)).await {
                    Ok(Ok(s)) => drop(s),
                    Ok(Err(e)) => return failed(diagnose::classify_hint(Hint::Io(e.kind()), &e.to_string(), &ctx), ctx),
                    Err(_) => return failed(diagnose::classify_hint(Hint::Io(std::io::ErrorKind::TimedOut), "connection timed out", &ctx), ctx),
                }
                lock(tr).finish(StepId::Connect, StepState::Ok, None);
            }
        } else {
            // SRV and TXT names are always resolved on this computer, by the options builder below
            if p.spec.scheme == Scheme::Srv {
                lock(tr).running(StepId::Dns);
            } else {
                lock(tr).skip(StepId::Dns);
            }
            if !direct {
                lock(tr).skip(StepId::Connect);
            }
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }

        // ---- The driver: options (SRV lookup happens here), then ping and the role probe
        let opts = SessionOpts { max_time_ms: u64::from(p.profile.max_time_ms), now_ms: self.now_ms, allow_remote: true, min_level: p.level, host_override: p.host_override, preflight_members: self.network != crate::jail::NetworkPolicy::Full, ..Default::default() };
        let mut sc = SpecConnect::new(&p.spec);
        sc.password = p.secrets.password.as_ref();
        sc.key_password = p.secrets.key_password.as_ref();
        sc.proxy_password = p.secrets.proxy_password.as_ref();
        sc.relay = relay;
        sc.tls_relax = p.relax;
        let session = match Session::connect_spec(sc, opts).await {
            Ok(s) => s,
            // the pre-flight refused a member outside the connection: the same "jail" diagnosis a refused host gets
            Err(e @ DriverError::Members(_)) => return failed(diagnose::from_code("config.invalid", vec![("reason".into(), code::TEST_JAIL.into())], &e.to_string(), &ctx), ctx),
            Err(e) => return failed(classify_driver(&e, &ctx), ctx),
        };
        let tls = session.tls();
        res.session = Some(session.clone());
        if p.spec.scheme == Scheme::Srv {
            lock(tr).finish(StepId::Dns, StepState::Ok, None);
        }
        let has_auth = p.spec.auth.mechanism != AuthMechanism::None;
        lock(tr).running(if tls { StepId::Tls } else { StepId::Auth });
        let probe = tokio::select! {
            r = session.probe() => r,
            () = wait_cancel(cancel) => return Err(cancelled()),
        };
        #[cfg(unix)]
        let (refused, tunnel_code) = {
            let info = self.tunnels.info(&Owner::Test(id.to_string()));
            (
                info.as_ref().map(|i| i.refused.iter().map(|h| format!("{}:{}", h.host, h.port.unwrap_or(27017))).collect::<Vec<_>>()).unwrap_or_default(),
                info.and_then(|i| i.failure_code),
            )
        };
        #[cfg(not(unix))]
        let (refused, tunnel_code): (Vec<String>, Option<&'static str>) = (Vec::new(), None);
        ctx.refused_hosts = refused.clone();
        let tunnel_up = res.tunnel_up();
        match probe {
            Ok(pr) => self.finish_ok(&p, &session, Reached { probe: Some(pr), authz: None, tls, has_auth, refused, tunnel_up }, tr).await,
            Err(e) => {
                let text = e.to_string();
                let mut diag = diagnose::classify_text(&text, &ctx);
                if let Some(c) = tunnel_code.filter(|_| matches!(diag.class, ErrorClass::Selection | ErrorClass::Network | ErrorClass::Other)) {
                    diag = diagnose::from_code(c, Vec::new(), &text, &ctx);
                }
                if diag.class == ErrorClass::Authz {
                    // the driver connected and signed in; only the role probe was refused: a warning, not a failure
                    return self.finish_ok(&p, &session, Reached { probe: None, authz: Some(diag), tls, has_auth, refused, tunnel_up }, tr).await;
                }
                Ok(Staged::Failed { diag, ctx, host_key: None, refused })
            }
        }
    }

    /// The probe answered (or only the role probe was refused): TLS and sign-in were reached, the permissions step decides.
    async fn finish_ok(&self, p: &Prepared, session: &Session, r: Reached, tr: &Shared) -> Result<Staged> {
        let mut warnings: Vec<String> = Vec::new();
        {
            let mut t = lock(tr);
            if matches!(t.state(StepId::Connect), StepState::Pending | StepState::Running) {
                t.finish(StepId::Connect, StepState::Ok, None);
            }
            if r.tls {
                t.finish(StepId::Tls, StepState::Ok, None);
                t.running(StepId::Auth);
            } else {
                t.skip(StepId::Tls);
            }
            if r.has_auth {
                t.finish(StepId::Auth, StepState::Ok, None);
            } else {
                t.finish(StepId::Auth, StepState::Skipped, Some("noAuth".into()));
            }
            t.running(StepId::Permissions);
        }
        let (probe, mut perm_state, mut perm_note) = match r.probe {
            Some(pr) => {
                let st = if matches!(pr.role, RoleChip::Unknown { .. }) { StepState::Warn } else { StepState::Ok };
                (pr, st, None)
            }
            None => {
                // role probe refused: the connection is real, its role unknown
                let pr = crate::driver::Probe {
                    server_version: "?".into(),
                    topology: "?".into(),
                    ping_ms: 0,
                    level: p.level,
                    role: RoleChip::Unknown { reason: r.authz.as_ref().map_or_else(|| "authz.command".into(), |d| d.code.clone()) },
                    remote_members: false,
                    members: Vec::new(),
                };
                (pr, StepState::Warn, r.authz.as_ref().map(|d| d.code.clone()))
            }
        };
        // listDatabases: a restricted user may not list them (a hint, not a failure of the connection)
        if let Err(e) = session.run(&ReadCommand::ListDatabases, &CancelToken::new()).await {
            let d = diagnose::classify_text(&e.to_string(), &p.ctx);
            if d.class == ErrorClass::Authz {
                warnings.push("listDatabasesDenied".into());
                perm_state = StepState::Warn;
                perm_note = Some(d.code);
            }
        }
        let level = if probe.remote_members { EffectiveLevel::ProductionLevel } else { p.level };
        let mut view = Studio::view_of(&p.profile, level, &probe, session);
        if r.tunnel_up {
            view.tunnel = Some(TunnelState::Up);
        }
        lock(tr).finish(StepId::Permissions, perm_state, perm_note);
        if p.relax {
            warnings.push("tlsRelaxed".into());
        }
        if p.spec.tls.mode == TlsMode::Off && p.spec.tunnel.is_none() && !all_loopback(&p.spec) {
            warnings.push("plainRemote".into());
        }
        match &probe.role {
            RoleChip::CanWrite { .. } => warnings.push("writeCapable".into()),
            RoleChip::Unknown { .. } => warnings.push("roleUnknown".into()),
            RoleChip::ReadOnly => {}
        }
        Ok(Staged::Passed { view, warnings, refused: r.refused, members: probe.members })
    }

    /// The tunnel for a spec with an SSH bastion. `None` for the other kinds.
    #[cfg(unix)]
    async fn open_ssh(&self, p: &Prepared, owner: Owner, cancel: Arc<AtomicBool>) -> Result<Option<(Lease, ProxyEndpoint)>> {
        let Tunnel::Ssh(ssh) = &p.spec.tunnel else { return Ok(None) };
        let mut env = self.tunnel_env();
        env.connect_timeout_s = (p.spec.timeouts.connect() / 1000).clamp(1, 60);
        let secret = p.secrets.ssh_secret.clone();
        let ts = TunnelSecrets {
            ssh_secret: secret.clone().filter(|_| ssh.auth == TunnelAuth::Password),
            key_password: secret.filter(|_| ssh.auth == TunnelAuth::KeyFile),
        };
        let who = Who {
            name: p.profile.name.clone(),
            environment: format!("{:?}", p.profile.safety.environment).to_ascii_lowercase(),
            level: format!("{:?}", p.level),
            label: host::display_host(&p.spec.host_info()),
        };
        let lease = self.tunnels.open(&env, owner, who, ssh, &ts, allow_list(&p.spec, ssh), cancel).await?;
        let ep = lease.proxy();
        Ok(Some((lease, ProxyEndpoint { host: "127.0.0.1".into(), port: ep.port, auth: Some((ep.user, Secret::new(ep.pass))) })))
    }

    /// The fingerprint the S5 dialog shows, best effort (a failure just leaves it out).
    #[cfg(unix)]
    async fn host_key_of(&self, spec: &ConnSpec) -> Option<HostKeyView> {
        let Tunnel::Ssh(ssh) = &spec.tunnel else { return None };
        self.scan_host_key(ssh.clone()).await.ok()
    }

    // ---- connect -------------------------------------------------------------------------------------------

    pub(super) async fn connect_spec_profile(&self, profile: &Profile, spec: ConnSpec, supplied: SessionSecrets) -> Result<ConnectionView> {
        let id = profile.id.as_str();
        let started = Instant::now();
        let label = host::display_host(&spec.host_info());
        let out = self.connect_spec_inner(profile, spec, supplied, &label, started).await;
        if let Err(e) = &out {
            if !matches!(e.code, code::NEED_SECRET | code::NEEDS_REVIEW | code::DISABLED) {
                let (class, c) = match e.message.split(':').next().filter(|c| diagnose::ALL_CODES.contains(c)) {
                    Some(c) => (diagnose::class_of(c), c.to_string()),
                    None => (ErrorClass::Other, e.code.to_string()),
                };
                let tag = format!("{:?}", profile.safety.environment).to_ascii_lowercase();
                self.audit_event(&AuditEvent::new(event::CONNECT, id).with_tag(&tag, &format!("{:?}", profile.effective_level(None))).with_label(&label).with_duration(started.elapsed()).failed(class, &c));
            }
        }
        out
    }

    async fn connect_spec_inner(&self, profile: &Profile, spec: ConnSpec, supplied: SessionSecrets, label: &str, started: Instant) -> Result<ConnectionView> {
        let id = profile.id.as_str();
        // the jail, then the secrets (mongoNeedSecret), both before any file probe, scan or spawn
        self.network.check_spec(&spec)?;
        if let Some(e) = spec.errors().into_iter().next() {
            return Err(StudioError::new(code::INVALID, format!("config.invalid: {} ({})", e.code, e.path)));
        }
        let identity = spec.secret_identity();
        let typed_now = supplied.password.is_some() || supplied.key_password.is_some() || supplied.ssh_secret.is_some() || supplied.proxy_password.is_some();
        let supplied = self.with_remembered(Some(id), &identity, supplied);
        let secrets = self.profiles.resolve_secrets(Some(id), &spec, &supplied)?;
        let relax = profile.safety.tls_relax != TlsRelax::None;
        let ctx = ctx_for(&spec, relax, Some(&secrets));
        if let Some(d) = check_files(&spec, &ctx) {
            return Err(StudioError::new(code::INVALID, format!("{}: {}", d.code, d.detail)));
        }
        let level = profile.effective_level(None);
        let p = Prepared { spec, secrets, profile: profile.clone(), level, host_override: profile.safety.level_override.is_some(), relax, ctx };
        let mut res = Resources::default();
        let mut relay: Option<ProxyEndpoint> = None;
        #[cfg(unix)]
        if let Some((lease, ep)) = self.open_ssh(&p, Owner::Connection(id.to_string()), Arc::new(AtomicBool::new(false))).await? {
            res.lease = Some(lease);
            relay = Some(ep);
        }
        #[cfg(not(unix))]
        if matches!(p.spec.tunnel, Tunnel::Ssh(_)) {
            return Err(StudioError::new(code::TUNNEL, "tunnel.noSsh: SSH tunnels are not available on this system"));
        }
        let opts = SessionOpts { max_time_ms: u64::from(profile.max_time_ms), now_ms: self.now_ms, allow_remote: true, min_level: level, host_override: p.host_override, preflight_members: self.network != crate::jail::NetworkPolicy::Full, ..Default::default() };
        let mut sc = SpecConnect::new(&p.spec);
        sc.password = p.secrets.password.as_ref();
        sc.key_password = p.secrets.key_password.as_ref();
        sc.proxy_password = p.secrets.proxy_password.as_ref();
        sc.relay = relay;
        sc.tls_relax = p.relax;
        let session = match Session::connect_spec(sc, opts).await {
            Ok(s) => s,
            Err(e) => {
                res.close().await;
                return Err(connect_error(e));
            }
        };
        let probe = match session.probe().await {
            Ok(pr) => pr,
            Err(e) => {
                session.close();
                res.close().await;
                let m = connect_error(e);
                // a remembered secret that was refused is dropped, so the prompt comes back once and never loops
                if diagnose::classify_text(&m.message, &p.ctx).class == ErrorClass::Auth {
                    lock(&self.extras.remembered).remove(id);
                }
                return Err(m);
            }
        };
        let level = if probe.remote_members { EffectiveLevel::ProductionLevel } else { level };
        if probe.remote_members {
            if let Err(e) = self.network.check(EffectiveLevel::ProductionLevel) {
                session.close();
                res.close().await;
                return Err(e);
            }
        }
        let mut view = Self::view_of(profile, level, &probe, &session);
        if res.tunnel_up() {
            view.tunnel = Some(TunnelState::Up);
        }
        if !self.is_enabled() {
            session.close();
            res.close().await;
            return Err(StudioError::new(code::DISABLED, "MongoDB Studio was switched off"));
        }
        let previous = lock(&self.conns).insert(id.to_string(), Arc::new(Conn { session, view: view.clone() }));
        if let Some(prev) = previous {
            prev.session.clone().close();
        }
        // the registry owns the tunnel from here on
        #[cfg(unix)]
        if let Some(l) = res.lease.take() {
            l.keep();
        }
        if typed_now {
            self.remember(id, &p.spec, &p.secrets);
        }
        let _ = self.profiles.mark_used(id, crate::audit::now_ms().max(0) as u64);
        let tag = format!("{:?}", profile.safety.environment).to_ascii_lowercase();
        self.audit_event(&AuditEvent::new(event::CONNECT, id).with_tag(&tag, &format!("{level:?}")).with_label(label).with_duration(started.elapsed()));
        Ok(view)
    }
}

/// Driver errors of a spec connect keep their leading diagnosis code; plain server text is a `mongoConnect`.
fn connect_error(e: DriverError) -> StudioError {
    match e {
        DriverError::Server(m) => StudioError::new(code::CONNECT, m),
        DriverError::Uri(m) | DriverError::Rejected(m) if m.starts_with("tunnel.") => StudioError::new(code::TUNNEL, m),
        DriverError::Uri(m) => StudioError::new(code::INVALID, m),
        DriverError::Rejected(m) => StudioError::new(code::REJECTED, m),
        DriverError::Parse(m) => StudioError::new(code::PARSE, m),
        DriverError::NonLoopback => StudioError::new(code::TEST_JAIL, "this build only connects to loopback hosts here"),
        DriverError::Cancelled => StudioError::new(code::CANCELLED, "cancelled"),
        e @ DriverError::Members(_) => StudioError::new(code::TEST_JAIL, e.to_string()),
    }
}
