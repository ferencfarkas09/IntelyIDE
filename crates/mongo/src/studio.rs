//! The gateway the Tauri commands call (feature `mongo`). Everything the webview can do to a database goes through
//! here, and the only thing it can express is a [`ReadCommand`]. Off means zero cost: [`Studio::new`] opens nothing and
//! spawns nothing; the first socket appears in `connect`, which refuses while the switch is off. Disabling closes every
//! pool, cancels running operations and drops every cursor.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use serde_json::Value;

use crate::api::*;
use crate::audit::{self, AuditEvent, AuditLog, AuditRecord};
use crate::driver::{CancelToken, Error as DriverError, RunResult, Session, SessionOpts};
use crate::error::{code, Result, StudioError};
use crate::explain;
use crate::host;
use crate::jail::NetworkPolicy;
use crate::profile::{Profile, ProfileStore};
use crate::shell::{self, ParseOptions};
use crate::types::{EffectiveLevel, ReadCommand, RoleChip};
use crate::validate;
use crate::vault::DraftSecrets;

mod ai;
mod test;
pub mod tunnels;
pub use ai::TierNames;
pub use test::{TestProgress, RESET_PHRASE};

pub const DEFAULT_PAGE: u32 = 50;
const MAX_PAGE: u32 = 200;

/// How many documents a `find` buffers per load: a few pages, not the 1000-document ceiling. Pages beyond the loaded
/// part are fetched on demand with a `skip`.
fn load_window(page: u32) -> usize {
    (page as usize * 4).clamp(200, crate::types::MAX_DOCS)
}

/// Where state changes go (the Tauri layer emits `mongo:state`). Tauri-free.
pub trait Sink: Send + Sync {
    fn state(&self, status: &StudioStatus);
    /// The step list of a running connection test (the Tauri layer emits `mongo:test`). Default: ignored.
    fn test_progress(&self, _progress: &TestProgress) {}
}

struct Conn {
    session: Session,
    view: ConnectionView,
}

struct CursorState {
    connection: String,
    cmd: ReadCommand,
    /// Position (relative to the command's own skip) of `docs[0]`.
    start: u32,
    docs: Vec<String>,
    truncated: bool,
    bytes: u32,
    elapsed_ms: u32,
    plan: Option<PlanView>,
    secondary_ok: bool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

pub struct Studio {
    profiles: Arc<ProfileStore>,
    audit: AuditLog,
    network: NetworkPolicy,
    enabled: AtomicBool,
    conns: Mutex<HashMap<String, Arc<Conn>>>,
    cursors: Mutex<HashMap<String, CursorState>>,
    runs: Mutex<HashMap<String, (String, CancelToken)>>,
    sink: Mutex<Option<Arc<dyn Sink>>>,
    now_ms: Option<i64>,
    /// Schema digests per connection (the AI pipeline's cache); dropped on disconnect and on switch-off.
    ai_digests: Mutex<HashMap<String, crate::ai::schema::DigestCache>>,
    /// Tunnel ownership (T6c): lazily empty, no thread or file until the first tunnel opens.
    tunnels: tunnels::Tunnels,
    /// T6b state. Every part is empty (or not even created) until the first use under the switch: no thread, no file.
    extras: test::Extras,
}

fn valid_tab(tab: &str) -> Result<()> {
    let ok = !tab.is_empty() && tab.len() <= 64 && tab.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    ok.then_some(()).ok_or_else(|| StudioError::new(code::INVALID, "a tab id is 1 to 64 letters, digits, - and _"))
}

fn map_driver(e: DriverError) -> StudioError {
    match e {
        DriverError::NonLoopback => StudioError::new(code::TEST_JAIL, "this build only connects to loopback hosts here"),
        DriverError::Uri(m) => StudioError::new(code::INVALID, m),
        DriverError::Parse(m) => StudioError::new(code::PARSE, m),
        DriverError::Rejected(m) => StudioError::new(code::REJECTED, m),
        DriverError::Cancelled => StudioError::new(code::CANCELLED, "cancelled"),
        DriverError::Server(m) => StudioError::new(code::SERVER, m),
        e @ DriverError::Members(_) => StudioError::new(code::TEST_JAIL, e.to_string()),
    }
}

fn target(cmd: &ReadCommand) -> (Option<&str>, Option<&str>) {
    match cmd {
        ReadCommand::ListDatabases => (None, None),
        ReadCommand::ListCollections { db } => (Some(db), None),
        ReadCommand::ListIndexes { db, collection }
        | ReadCommand::Find { db, collection, .. }
        | ReadCommand::Aggregate { db, collection, .. }
        | ReadCommand::Count { db, collection, .. }
        | ReadCommand::Distinct { db, collection, .. }
        | ReadCommand::Sample { db, collection, .. } => (Some(db), Some(collection)),
        ReadCommand::Explain { inner, .. } => target(inner),
    }
}

/// The text that carries the query's literals (filter or pipeline), for the audit shape/hash and the tenant lock.
fn query_text(cmd: &ReadCommand) -> Option<(&str, bool)> {
    match cmd {
        ReadCommand::Find { filter, .. } | ReadCommand::Count { filter, .. } | ReadCommand::Distinct { filter, .. } => Some((filter, false)),
        ReadCommand::Aggregate { pipeline, .. } => Some((pipeline, true)),
        ReadCommand::Explain { inner, .. } => query_text(inner),
        _ => None,
    }
}

fn is_sample(cmd: &ReadCommand) -> bool {
    match cmd {
        ReadCommand::Sample { .. } => true,
        ReadCommand::Explain { inner, .. } => is_sample(inner),
        _ => false,
    }
}

/// Server-internal namespaces that hold credentials, config and the oplog: never readable through the grid, a copy or an
/// export (listing collections and indexes stays allowed, so the tree can show them).
fn protected_namespace(cmd: &ReadCommand) -> Option<String> {
    let (db, collection) = target(cmd);
    let reads_documents = !matches!(cmd, ReadCommand::ListDatabases | ReadCommand::ListCollections { .. } | ReadCommand::ListIndexes { .. });
    if !reads_documents {
        return None;
    }
    let bad_db = db.is_some_and(|d| matches!(d.to_ascii_lowercase().as_str(), "admin" | "local" | "config"));
    let bad_coll = collection.is_some_and(|c| c.to_ascii_lowercase().starts_with("system."));
    (bad_db || bad_coll).then(|| "the admin, local and config databases and system.* collections cannot be read here".to_string())
}

fn inner_aggregate(cmd: &ReadCommand) -> Option<(&str, &str)> {
    match cmd {
        ReadCommand::Aggregate { db, pipeline, .. } => Some((db, pipeline)),
        ReadCommand::Explain { inner, .. } => inner_aggregate(inner),
        _ => None,
    }
}

fn plan_view(p: explain::PlanSummary) -> PlanView {
    let warnings = explain::warnings(&p, None);
    let clamp = |n: Option<i64>| n.map(|v| v.clamp(0, i64::from(i32::MAX)) as i32);
    PlanView {
        stages: p.stages,
        collscan: p.collscan,
        index_names: p.index_names,
        engine: p.engine,
        docs_examined: clamp(p.docs_examined),
        keys_examined: clamp(p.keys_examined),
        n_returned: clamp(p.n_returned),
        rejected_plans: p.rejected_plans as u32,
        warnings,
    }
}

fn ms32(d: std::time::Duration) -> u32 {
    d.as_millis().min(u128::from(u32::MAX)) as u32
}

impl Studio {
    /// Opens nothing, spawns nothing, reads no secret: callable outside a runtime.
    pub fn new(profiles: Arc<ProfileStore>, network: NetworkPolicy) -> Self {
        let audit = AuditLog::new(profiles.settings_dir().join("mongo-audit.jsonl"));
        let tunnels = tunnels::Tunnels::new(profiles.clone(), audit.path().to_path_buf());
        let enabled = profiles.enabled();
        Self {
            profiles,
            audit,
            network,
            enabled: AtomicBool::new(enabled),
            conns: Mutex::new(HashMap::new()),
            cursors: Mutex::new(HashMap::new()),
            runs: Mutex::new(HashMap::new()),
            sink: Mutex::new(None),
            now_ms: None,
            ai_digests: Mutex::new(HashMap::new()),
            tunnels,
            extras: test::Extras::default(),
        }
    }

    /// D26, called once at start-up by the glue: turns `mongo.happyPreset` on the first time this build sees existing
    /// profiles (see [`ProfileStore::migrate_happy_preset`]). Best effort: unreadable settings leave everything as is.
    pub fn migrate_happy_preset(&self) -> bool {
        self.profiles.migrate_happy_preset().unwrap_or(false)
    }

    /// A fixed "now" for `ISODate()` / `new Date()` literals (tests).
    pub fn with_now(mut self, now_ms: i64) -> Self {
        self.now_ms = Some(now_ms);
        self
    }

    pub fn set_sink(&self, sink: Arc<dyn Sink>) {
        *lock(&self.sink) = Some(sink);
    }

    pub fn profiles(&self) -> &ProfileStore {
        &self.profiles
    }

    pub fn audit_path(&self) -> &std::path::Path {
        self.audit.path()
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn session_count(&self) -> usize {
        lock(&self.conns).len()
    }

    pub fn cursor_count(&self) -> usize {
        lock(&self.cursors).len()
    }

    fn ensure_enabled(&self) -> Result<()> {
        self.is_enabled().then_some(()).ok_or_else(|| StudioError::new(code::DISABLED, "MongoDB Studio is off (Settings > Database)"))
    }

    pub fn status(&self) -> StudioStatus {
        self.reap_ended_tunnels();
        let mut connections: Vec<ConnectionView> = lock(&self.conns).values().map(|c| c.view.clone()).collect();
        for v in &mut connections {
            v.tunnel = self.tunnels.connection_state(&v.id).or(v.tunnel);
        }
        connections.sort_by(|a, b| a.id.cmp(&b.id));
        StudioStatus { compiled: true, enabled: self.is_enabled(), network: self.network.as_str().into(), connections, notices: self.profiles.notices() }
    }

    fn emit(&self) {
        let sink = lock(&self.sink).clone();
        if let Some(s) = sink {
            s.state(&self.status());
        }
    }

    pub fn dismiss_notices(&self) {
        self.profiles.clear_notices();
        self.emit();
    }

    /// The master switch. Turning it off closes pools, cancels running operations and drops every cursor.
    pub fn set_enabled(&self, on: bool) -> Result<StudioStatus> {
        self.profiles.set_enabled(on)?;
        self.enabled.store(on, Ordering::Relaxed);
        if !on {
            self.shutdown_all();
        }
        self.emit();
        Ok(self.status())
    }

    fn shutdown_all(&self) {
        let runs: Vec<CancelToken> = lock(&self.runs).drain().map(|(_, (_, t))| t).collect();
        for t in &runs {
            t.mark_cancelled();
        }
        let conns: Vec<Arc<Conn>> = lock(&self.conns).drain().map(|(_, c)| c).collect();
        lock(&self.cursors).clear();
        lock(&self.ai_digests).clear();
        self.tunnels.close_all_detached();
        self.shutdown_extras();
        for c in conns {
            self.audit_disconnect(&c);
            let s = c.session.clone();
            let tokens = runs.clone();
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                rt.spawn(async move {
                    for t in &tokens {
                        let _ = s.cancel(t).await;
                    }
                    s.close();
                });
            }
        }
    }

    // ---- profiles -------------------------------------------------------------------------------------------

    pub fn profile_list(&self) -> Result<Vec<ProfileView>> {
        Ok(self.profiles.list()?.iter().map(Profile::view).collect())
    }

    pub fn profile_save(&self, input: ProfileInput) -> Result<ProfileView> {
        let input = self.redeem_draft(input)?;
        let p = self.profiles.save(input)?;
        // A saved change must not leave a live connection with the old URI or level.
        self.drop_connection(&p.id);
        self.forget_session_secrets(&p.id);
        self.emit();
        Ok(p.view())
    }

    pub fn profile_delete(&self, id: &str) -> Result<()> {
        self.profiles.delete(id)?;
        self.drop_connection(id);
        self.forget_session_secrets(id);
        self.emit();
        Ok(())
    }

    pub fn profile_duplicate(&self, id: &str) -> Result<ProfileView> {
        let p = self.profiles.duplicate(id)?;
        self.emit();
        Ok(p.view())
    }

    fn drop_connection(&self, id: &str) {
        let removed = lock(&self.conns).remove(id);
        lock(&self.cursors).retain(|_, c| c.connection != id);
        lock(&self.ai_digests).remove(id);
        self.tunnels.close_connection_detached(id);
        if let Some(c) = removed {
            self.audit_disconnect(&c);
            c.session.clone().close();
        }
    }

    // ---- connections ----------------------------------------------------------------------------------------

    fn view_of(profile: &Profile, level: EffectiveLevel, probe: &crate::driver::Probe, session: &Session) -> ConnectionView {
        ConnectionView {
            id: profile.id.clone(),
            name: profile.name.clone(),
            server_version: probe.server_version.clone(),
            topology: probe.topology.clone(),
            ping_ms: probe.ping_ms.min(u64::from(u32::MAX)) as u32,
            effective_level: level,
            environment: profile.safety.environment,
            read_only: profile.safety.read_only,
            read_preference: Profile::read_preference(level),
            role_elevated: !matches!(probe.role, RoleChip::ReadOnly),
            role: probe.role.clone(),
            tls: session.tls(),
            tunnel: None,
            tls_relax: if session.relaxed() { TlsRelax::Certificates } else { profile.safety.tls_relax },
        }
    }

    /// The path of a legacy profile that stores one connection string.
    async fn open(&self, profile: &Profile, uri: &str) -> Result<(Session, ConnectionView)> {
        let fragments = host::credential_fragments(uri);
        let info = host::parse_uri(uri).map_err(|e| StudioError::new(code::INVALID, host::scrub(&e.0, &fragments)))?;
        self.network.check_legacy_uri(host::effective_level(&info), uri)?;
        let level = profile.effective_level(Some(&info));
        let opts = SessionOpts { max_time_ms: u64::from(profile.max_time_ms), now_ms: self.now_ms, allow_remote: true, min_level: level, preflight_members: self.network != NetworkPolicy::Full, ..Default::default() };
        let session = Session::connect(uri, opts).await.map_err(|e| {
            let m = map_driver(e);
            if m.code == code::SERVER {
                StudioError::new(code::CONNECT, m.message)
            } else {
                m
            }
        })?;
        match session.probe().await {
            Ok(probe) => {
                // A loopback seed can front a remote replica set (an SSH tunnel): judge the members the server names.
                let level = if probe.remote_members { EffectiveLevel::ProductionLevel } else { level };
                if probe.remote_members {
                    if let Err(e) = self.network.check(EffectiveLevel::ProductionLevel) {
                        session.close();
                        return Err(e);
                    }
                }
                let view = Self::view_of(profile, level, &probe, &session);
                Ok((session, view))
            }
            Err(e) => {
                session.close();
                let m = map_driver(e);
                Err(StudioError::new(if m.code == code::SERVER { code::CONNECT } else { m.code }, m.message))
            }
        }
    }

    pub async fn connect(&self, id: &str) -> Result<ConnectionView> {
        self.connect_with(id, SessionSecrets::default()).await
    }

    /// Connects a saved profile. `secrets` are what the connect prompt (S9) collected for a profile that does not store
    /// them; they are bound to the connection identity and kept in memory only. A profile with fields (a `ConnSpec`) goes
    /// through the tunnel and the spec driver path; a legacy profile keeps its stored connection string unchanged.
    pub async fn connect_with(&self, id: &str, secrets: SessionSecrets) -> Result<ConnectionView> {
        self.ensure_enabled()?;
        if let Some(c) = lock(&self.conns).get(id) {
            return Ok(c.view.clone());
        }
        let profile = self.profiles.connectable(id)?;
        let view = match profile.conn.clone() {
            Some(spec) => self.connect_spec_profile(&profile, spec, secrets).await?,
            None => self.connect_legacy(&profile).await?,
        };
        self.emit();
        Ok(view)
    }

    async fn connect_legacy(&self, profile: &Profile) -> Result<ConnectionView> {
        let id = profile.id.as_str();
        let uri = self.profiles.uri(id)?.ok_or_else(|| StudioError::new(code::NO_URI, "this connection has no saved connection string"))?;
        let (session, view) = self.open(profile, uri.expose()).await?;
        if !self.is_enabled() {
            session.close();
            return Err(StudioError::new(code::DISABLED, "MongoDB Studio was switched off"));
        }
        let previous = lock(&self.conns).insert(id.to_string(), Arc::new(Conn { session, view: view.clone() }));
        if let Some(p) = previous {
            p.session.clone().close();
        }
        Ok(view)
    }

    pub fn disconnect(&self, id: &str) {
        self.drop_connection(id);
        self.emit();
    }

    /// Test a draft (or a saved connection) without saving or keeping it: connect, probe, close. The one-argument form
    /// has no test id (no `mongo:test` events of its own, no busy or rate limit); [`Studio::test_with`] is the staged one.
    pub async fn test(&self, input: ProfileInput) -> Result<TestReport> {
        self.run_test(input, None).await
    }

    // ---- reads ----------------------------------------------------------------------------------------------

    fn conn(&self, id: &str) -> Result<Arc<Conn>> {
        self.reap_ended_tunnels();
        lock(&self.conns).get(id).cloned().ok_or_else(|| StudioError::new(code::NOT_CONNECTED, "connect first"))
    }

    fn parse_opts(&self) -> ParseOptions {
        ParseOptions { now_ms: self.now_ms }
    }

    /// Runs a command in a spawned task and returns a window onto its (capped) result. Replaces the tab's cursor.
    pub async fn run(&self, req: RunRequest) -> Result<WindowView> {
        self.ensure_enabled()?;
        valid_tab(&req.tab)?;
        let page = req.page_size.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
        let conn = self.conn(&req.connection)?;
        // The signature of the safety fields is checked before every operation.
        let profile = self.profiles.verified(&req.connection)?;
        match self.execute(&conn, &profile, &req.tab, &req.command, load_window(page)).await {
            Ok(r) => {
                let st = CursorState {
                    connection: req.connection.clone(),
                    cmd: req.command.clone(),
                    start: 0,
                    docs: r.docs,
                    truncated: r.truncated,
                    bytes: r.bytes.min(u32::MAX as usize) as u32,
                    elapsed_ms: r.elapsed_ms.min(u64::from(u32::MAX)) as u32,
                    plan: r.plan.map(plan_view),
                    secondary_ok: conn.view.read_preference == ReadPreference::SecondaryPreferred,
                };
                let w = Self::window_of(&req.tab, &st, 0, page);
                lock(&self.cursors).insert(req.tab, st);
                Ok(w)
            }
            Err(e) => {
                lock(&self.cursors).remove(&req.tab);
                Err(e)
            }
        }
    }

    async fn execute(&self, conn: &Conn, profile: &Profile, tab: &str, cmd: &ReadCommand, window: usize) -> Result<RunResult> {
        let started = Instant::now();
        let outcome = self.guarded(conn, profile, tab, cmd, window).await;
        self.record(profile, conn, cmd, &outcome, started);
        outcome
    }

    async fn guarded(&self, conn: &Conn, profile: &Profile, tab: &str, cmd: &ReadCommand, window: usize) -> Result<RunResult> {
        if let Some(why) = protected_namespace(cmd) {
            return Err(StudioError::new(code::REJECTED, why));
        }
        // Tenant lock: the filter (or the first `$match`, and every join below it) must pin the tenant field to a literal.
        if let Some(field) = profile.safety.tenant_lock.as_deref() {
            if is_sample(cmd) {
                return Err(StudioError::new(code::REJECTED, format!("tenant lock: a sample reads random documents of every `{field}`; use a find")));
            }
            if let Some((text, is_pipeline)) = query_text(cmd) {
                let po = self.parse_opts();
                if is_pipeline {
                    let problem = match shell::parse_with(text, &po) {
                        Ok(v) => validate::tenant_pipeline_problem(&v, field),
                        Err(_) => Some(format!("tenant lock: the pipeline must start with a $match that constrains `{field}`")),
                    };
                    if let Some(p) = problem {
                        return Err(StudioError::new(code::REJECTED, p));
                    }
                } else if !shell::parse_document(text, &po).is_ok_and(|v| validate::constrains_tenant(&v, field)) {
                    return Err(StudioError::new(code::REJECTED, format!("tenant lock: the filter must pin `{field}` to a value (equals, or in a short list)")));
                }
            }
        }
        // `$lookup`, `$unionWith`, `$graphLookup` may only read collections that exist in the same database.
        if let Some((db, pipeline)) = inner_aggregate(cmd) {
            if let Ok(v) = shell::parse_with(pipeline, &self.parse_opts()) {
                let foreign = validate::foreign_collections(&v);
                if !foreign.is_empty() {
                    let names = conn.session.run(&ReadCommand::ListCollections { db: db.to_string() }, &CancelToken::new()).await.map_err(map_driver)?;
                    let known: Vec<String> = names.docs.iter().filter_map(|d| serde_json::from_str::<Value>(d).ok()).filter_map(|v| v["name"].as_str().map(str::to_string)).collect();
                    if let Some(missing) = foreign.iter().find(|f| !known.contains(f)) {
                        return Err(StudioError::new(code::REJECTED, format!("unknown collection \"{missing}\" in a lookup")));
                    }
                }
            }
        }
        let token = CancelToken::new();
        if let Some((_, old)) = lock(&self.runs).insert(tab.to_string(), (conn.view.id.clone(), token.clone())) {
            // A newer run in the same tab supersedes the older one.
            old.mark_cancelled();
        }
        let joined = conn.session.spawn_window(cmd.clone(), token.clone(), window).await;
        {
            let mut runs = lock(&self.runs);
            if runs.get(tab).is_some_and(|(_, t)| t.tag() == token.tag()) {
                runs.remove(tab);
            }
        }
        match joined {
            Ok(r) => r.map_err(map_driver),
            Err(_) => Err(StudioError::new(code::SERVER, "the operation task ended unexpectedly")),
        }
    }

    fn record(&self, profile: &Profile, conn: &Conn, cmd: &ReadCommand, outcome: &Result<RunResult>, started: Instant) {
        let (db, collection) = target(cmd);
        let (shape, hash) = match query_text(cmd) {
            Some((text, is_pipeline)) if !text.trim().is_empty() => {
                let po = self.parse_opts();
                let parsed = if is_pipeline { shell::parse_with(text, &po) } else { shell::parse_document(text, &po) };
                (parsed.ok().map(|v| audit::filter_shape(&v)), Some(audit::filter_hash(&profile.id, text)))
            }
            _ => (None, None),
        };
        let (count, truncated, outcome_s) = match outcome {
            Ok(r) => (Some(r.docs.len().min(u32::MAX as usize) as u32), r.truncated, "ok".to_string()),
            Err(e) => (None, false, format!("error:{}", e.code)),
        };
        let rec = AuditRecord {
            ts: audit::iso_utc(audit::now_ms()),
            connection_id: profile.id.clone(),
            environment: format!("{:?}", profile.safety.environment).to_lowercase(),
            level: format!("{:?}", conn.view.effective_level),
            class: "read".into(),
            op: cmd.kind().into(),
            db: db.map(str::to_string),
            collection: collection.map(str::to_string),
            filter_shape: shape,
            filter_hash: hash,
            count,
            truncated,
            origin: "desktop".into(),
            duration_ms: ms32(started.elapsed()),
            outcome: outcome_s,
        };
        // An audit failure never hides a result, but it is not silent: it shows up as a notice.
        if let Err(e) = self.audit.append(&rec) {
            self.profiles.push_notice(Notice { profile_id: String::new(), message: format!("The audit log could not be written: {}", host::redact(&e.message)) });
        }
    }

    /// One audit line for an AI call: its database reads (sample, indexes, count, explain) happen on the session directly,
    /// so the line is the trace that they happened. No question text, no schema, no literals.
    pub(crate) fn record_ai(&self, profile: &Profile, level: Option<EffectiveLevel>, op: &str, db: &str, collection: &str, ok: bool, started: Instant) {
        let rec = AuditRecord {
            ts: audit::iso_utc(audit::now_ms()),
            connection_id: profile.id.clone(),
            environment: format!("{:?}", profile.safety.environment).to_lowercase(),
            level: format!("{:?}", level.unwrap_or(EffectiveLevel::ProductionLevel)),
            class: "ai-read".into(),
            op: op.into(),
            db: Some(db.to_string()),
            collection: Some(collection.to_string()).filter(|c| !c.is_empty()),
            filter_shape: None,
            filter_hash: None,
            count: None,
            truncated: false,
            origin: "desktop".into(),
            duration_ms: ms32(started.elapsed()),
            outcome: if ok { "ok".into() } else { "error".into() },
        };
        if let Err(e) = self.audit.append(&rec) {
            self.profiles.push_notice(Notice { profile_id: String::new(), message: format!("The audit log could not be written: {}", host::redact(&e.message)) });
        }
    }

    fn window_of(tab: &str, st: &CursorState, offset: u32, count: u32) -> WindowView {
        let end = st.start + st.docs.len() as u32;
        let lo = offset.clamp(st.start, end);
        let hi = offset.saturating_add(count).min(end).max(lo);
        let docs = st.docs[(lo - st.start) as usize..(hi - st.start) as usize].to_vec();
        let pageable = matches!(st.cmd, ReadCommand::Find { .. });
        WindowView {
            tab: tab.to_string(),
            docs,
            offset: lo,
            loaded: st.docs.len() as u32,
            truncated: st.truncated,
            has_more: hi < end || (st.truncated && pageable),
            bytes: st.bytes,
            elapsed_ms: st.elapsed_ms,
            plan: st.plan.clone(),
            secondary_ok: st.secondary_ok,
        }
    }

    /// A window of the tab's cursor. Inside the loaded part it is a slice; past it, a `find` is re-run with the right
    /// `skip` (the loaded part never exceeds 1000 documents or 16 MB, so memory stays bounded).
    pub async fn window(&self, tab: &str, offset: u32, count: u32) -> Result<WindowView> {
        self.ensure_enabled()?;
        valid_tab(tab)?;
        let count = count.clamp(1, MAX_PAGE);
        let (connection, cmd) = {
            let c = lock(&self.cursors);
            let st = c.get(tab).ok_or_else(|| StudioError::new(code::NOT_FOUND, "no cursor in this tab: run a query first"))?;
            let inside = offset >= st.start && offset.saturating_add(count) <= st.start + st.docs.len() as u32;
            if inside || !matches!(st.cmd, ReadCommand::Find { .. }) || (!st.truncated && offset >= st.start) {
                return Ok(Self::window_of(tab, st, offset, count));
            }
            (st.connection.clone(), st.cmd.clone())
        };
        let ReadCommand::Find { db, collection, filter, projection, sort, skip, limit } = cmd.clone() else {
            return Err(StudioError::new(code::INVALID, "only a find can be paged past its loaded window"));
        };
        let remaining = match limit {
            Some(l) if l > 0 => {
                let r = l - i64::from(offset);
                if r <= 0 {
                    let c = lock(&self.cursors);
                    let st = c.get(tab).ok_or_else(|| StudioError::new(code::NOT_FOUND, "no cursor in this tab"))?;
                    return Ok(Self::window_of(tab, st, st.start + st.docs.len() as u32, count));
                }
                Some(r)
            }
            _ => None,
        };
        let conn = self.conn(&connection)?;
        let profile = self.profiles.verified(&connection)?;
        let reload = ReadCommand::Find { db, collection, filter, projection, sort, skip: Some(skip.unwrap_or(0).saturating_add(u64::from(offset))), limit: remaining };
        let r = self.execute(&conn, &profile, tab, &reload, load_window(count)).await?;
        let st = CursorState {
            connection,
            cmd,
            start: offset,
            docs: r.docs,
            truncated: r.truncated,
            bytes: r.bytes.min(u32::MAX as usize) as u32,
            elapsed_ms: r.elapsed_ms.min(u64::from(u32::MAX)) as u32,
            plan: None,
            secondary_ok: conn.view.read_preference == ReadPreference::SecondaryPreferred,
        };
        let w = Self::window_of(tab, &st, offset, count);
        lock(&self.cursors).insert(tab.to_string(), st);
        Ok(w)
    }

    pub fn cursor_close(&self, tab: &str) {
        lock(&self.cursors).remove(tab);
    }

    /// Cancel the tab's running operation: flag, then `killOp` on our own tagged op; `maxTimeMS` is the backstop.
    pub async fn cancel(&self, tab: &str) -> Result<CancelView> {
        valid_tab(tab)?;
        let active = lock(&self.runs).get(tab).cloned();
        let Some((connection, token)) = active else { return Ok(CancelView { cancelled: false, killed: false }) };
        let conn = self.conn(&connection)?;
        let k = conn.session.cancel(&token).await;
        Ok(CancelView { cancelled: true, killed: k.killed })
    }
}

/// A user-readable class for a connection error message (auth, dns, tls, timeout, network).
pub fn classify_error(message: &str) -> ErrorClass {
    let m = message.to_lowercase();
    if m.contains("authentication") || m.contains("auth failed") || m.contains("(18)") || m.contains("unauthorized") {
        ErrorClass::Auth
    } else if m.contains("tls") || m.contains("certificate") || m.contains("handshake") || m.contains("ssl") {
        ErrorClass::Tls
    } else if m.contains("dns") || m.contains("lookup address") || m.contains("nodename") || m.contains("no such host") || m.contains("resolve") {
        ErrorClass::Dns
    } else if m.contains("timed out") || m.contains("timeout") || m.contains("server selection") {
        ErrorClass::Timeout
    } else if m.contains("refused") || m.contains("os error") || m.contains("connection") || m.contains("network") {
        ErrorClass::Network
    } else {
        ErrorClass::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find(db: &str, coll: &str) -> ReadCommand {
        ReadCommand::Find { db: db.into(), collection: coll.into(), filter: String::new(), projection: None, sort: None, skip: None, limit: None }
    }

    #[test]
    fn server_internal_namespaces_are_not_readable_but_still_listable() {
        for (db, coll) in [("admin", "system.users"), ("ADMIN", "x"), ("local", "oplog.rs"), ("config", "shards"), ("shop", "system.profile"), ("shop", "System.Views")] {
            assert!(protected_namespace(&find(db, coll)).is_some(), "{db}.{coll}");
        }
        let agg = ReadCommand::Aggregate { db: "admin".into(), collection: "system.users".into(), pipeline: "[]".into() };
        assert!(protected_namespace(&agg).is_some());
        let explain = ReadCommand::Explain { inner: Box::new(find("local", "startup_log")), execution_stats: false };
        assert!(protected_namespace(&explain).is_some());
        assert!(protected_namespace(&ReadCommand::Sample { db: "admin".into(), collection: "x".into(), size: 1 }).is_some());
        assert!(protected_namespace(&find("shop", "orders")).is_none());
        for listing in [ReadCommand::ListDatabases, ReadCommand::ListCollections { db: "admin".into() }, ReadCommand::ListIndexes { db: "admin".into(), collection: "system.users".into() }] {
            assert!(protected_namespace(&listing).is_none(), "{listing:?}");
        }
    }

    #[test]
    fn a_sample_is_found_through_an_explain() {
        let s = ReadCommand::Sample { db: "d".into(), collection: "c".into(), size: 3 };
        assert!(is_sample(&s) && is_sample(&ReadCommand::Explain { inner: Box::new(s), execution_stats: false }));
        assert!(!is_sample(&find("d", "c")));
    }

    #[test]
    fn the_first_window_is_a_few_pages_and_never_above_the_ceiling() {
        assert_eq!(load_window(50), 200);
        assert_eq!(load_window(25), 200);
        assert_eq!(load_window(100), 400);
        assert_eq!(load_window(200), 800);
        assert!(load_window(u32::MAX) <= crate::types::MAX_DOCS);
    }
}

// ---- the connection commands of (design notes: mongo-everyone-spec) 5.6 -------------------------------------------------------
//
// Exempt from the switch (they answer while Studio is off and open no socket and start no process): `status`,
// `set_enabled`, `profile_list`, `profile_save`, `profile_delete`, `profile_meta`, `secrets_status`, `reset_all`. Every
// other method below answers `mongoDisabled` while the switch is off.

impl Studio {
    /// `mongo_uri_parse`: the form fills from the spec; the password goes to the draft vault, bound to the parsed
    /// connection identity. The webview sees flags and a token only.
    pub fn uri_parse(&self, uri: &str) -> Result<UriParse> {
        self.ensure_enabled()?;
        let parsed = crate::connstring::parse_connection_string(uri)?;
        let (has_password, has_key_password) = (parsed.secrets.password.is_some(), parsed.secrets.key_password.is_some());
        let mut warnings = parsed.notes;
        if parsed.tls_relax && !warnings.iter().any(|n| n.code == "tls.relaxRequested") {
            warnings.push(Note { code: "tls.relaxRequested".into(), option: None });
        }
        let draft = if has_password || has_key_password {
            Some(self.vault().put(&parsed.spec.secret_identity(), DraftSecrets { password: parsed.secrets.password, key_password: parsed.secrets.key_password })?)
        } else {
            None
        };
        Ok(UriParse { spec: parsed.spec, has_password, has_key_password, draft, warnings, unsupported: parsed.unsupported })
    }

    /// `mongo_uri_render`: the masked string (`user:***@`), never a password.
    pub fn uri_render(&self, spec: &crate::connspec::ConnSpec, draft: Option<&str>) -> Result<String> {
        self.ensure_enabled()?;
        let has_draft_password = draft.is_some_and(|t| self.vault().get(t, &spec.secret_identity()).is_ok_and(|d| d.password.is_some()));
        let secrets = crate::connstring::RenderSecrets { password: has_draft_password.then(|| intely_settings::Secret::new("x")) };
        crate::connstring::render(spec, &secrets, crate::connstring::Mask::Masked)
    }

    /// `mongo_draft_discard` (also on dialog close).
    pub fn draft_discard(&self, token: &str) -> Result<()> {
        self.ensure_enabled()?;
        self.vault().discard(token);
        Ok(())
    }

    /// `mongo_profile_convert`: a legacy profile (one stored string) as fields, for review. Nothing is saved; the string
    /// stays where it is until the user saves the converted profile.
    pub fn profile_convert(&self, id: &str) -> Result<ProfileDraft> {
        self.ensure_enabled()?;
        let p = self.profiles.connectable(id)?;
        if p.conn.is_some() {
            return Err(StudioError::new(code::INVALID, "this connection already uses fields"));
        }
        let uri = self.profiles.uri(id)?.ok_or_else(|| StudioError::new(code::NO_URI, "this connection has no saved connection string"))?;
        let parsed = crate::connstring::parse_connection_string(uri.expose())?;
        let mut dropped = parsed.notes;
        dropped.extend(parsed.unsupported);
        if parsed.tls_relax {
            dropped.push(Note { code: "tls.relaxRequested".into(), option: None });
        }
        let identity = parsed.spec.secret_identity();
        let draft = if parsed.secrets.password.is_some() || parsed.secrets.key_password.is_some() {
            Some(self.vault().put_for(Some(id), &identity, DraftSecrets { password: parsed.secrets.password, key_password: parsed.secrets.key_password })?)
        } else {
            None
        };
        let input = ProfileInput {
            id: Some(id.to_string()),
            name: p.name.clone(),
            environment: p.safety.environment,
            color: Some(p.color.clone()).filter(|c| !c.is_empty()),
            read_only: Some(p.safety.read_only),
            ai_mode: Some(p.safety.ai_mode),
            tenant_lock: p.safety.tenant_lock.clone(),
            max_time_ms: Some(p.max_time_ms),
            spec: Some(parsed.spec),
            group: p.group.clone(),
            favorite: Some(p.favorite),
            domain: Some(p.domain),
            ai_prefs: Some(p.ai_prefs.clone()),
            ..Default::default()
        };
        Ok(ProfileDraft { input, draft, dropped })
    }

    /// `mongo_profile_meta`: group, favourite and colour; not signed, not confirmed.
    pub fn profile_meta(&self, id: &str, meta: ProfileMeta) -> Result<ProfileView> {
        let p = self.profiles.set_meta(id, meta)?;
        self.emit();
        Ok(p.view())
    }

    /// `mongo_profile_secret`: stores (or, with `None`, clears) one secret under the CURRENT connection identity.
    pub fn profile_secret(&self, id: &str, kind: SecretKind, value: Option<WireSecret>) -> Result<ProfileView> {
        self.ensure_enabled()?;
        let p = self.profiles.set_secret(id, kind, value)?;
        self.forget_session_secrets(id);
        self.emit();
        Ok(p.view())
    }

    /// `mongo_secrets_status`: where secrets live and which exist for the connection as it is now.
    pub fn secrets_status(&self, id: Option<&str>) -> Result<SecretsStatus> {
        self.profiles.secrets_status(id)
    }

    /// `mongo_ssh_hostkey`: resolve with `ssh -G`, scan, look up. Human-initiated, jail-gated, shares the test rate limit.
    #[cfg(unix)]
    pub async fn ssh_hostkey(&self, ssh: crate::connspec::SshSpec) -> Result<HostKeyView> {
        self.ensure_enabled()?;
        self.rate_gate()?;
        self.scan_host_key(ssh).await
    }

    #[cfg(unix)]
    pub(super) async fn scan_host_key(&self, ssh: crate::connspec::SshSpec) -> Result<HostKeyView> {
        use crate::tunnel::{knownhosts, ssh as sshm};
        self.network.check_tunnel(&crate::connspec::Tunnel::Ssh(ssh.clone()), &[])?;
        sshm::check_spec(&ssh)?;
        let env = self.tunnel_env();
        tokio::task::spawn_blocking(move || -> Result<HostKeyView> {
            let bin = sshm::SshBinary::locate(env.jail.policy(), env.ssh_override.as_deref(), &env.facts)?;
            let base = sshm::base_env(&sshm::EnvInputs { home: env.home.to_string_lossy().into_owned(), user: env.local_user.clone(), auth_sock: None });
            let ctx = sshm::SshCtx { runner: &*env.runner, bin: &bin, jail: &env.jail, env: &base };
            let report = knownhosts::inspect_host_key(&ctx, &ssh, &env.app_known_hosts(), Some(&env.home_known_hosts()))?;
            report.keys.into_iter().next().ok_or_else(|| StudioError::new(code::HOST_KEY, "tunnel.hostKeyUnscannable: no host key was offered"))
        })
        .await
        .map_err(|_| StudioError::new(code::HOST_KEY, "the host key scan stopped"))?
    }

    /// `mongo_ssh_trust`: the re-scan must offer the confirmed fingerprint; a changed key has no trust path.
    #[cfg(unix)]
    pub async fn ssh_trust(&self, host: &str, port: u16, fingerprint: &str) -> Result<()> {
        use crate::tunnel::{knownhosts, ssh as sshm};
        self.ensure_enabled()?;
        let env = self.tunnel_env();
        let (host, fp) = (host.to_string(), fingerprint.to_string());
        tokio::task::spawn_blocking(move || -> Result<()> {
            let bin = sshm::SshBinary::locate(env.jail.policy(), env.ssh_override.as_deref(), &env.facts)?;
            let base = sshm::base_env(&sshm::EnvInputs { home: env.home.to_string_lossy().into_owned(), user: env.local_user.clone(), auth_sock: None });
            let ctx = sshm::SshCtx { runner: &*env.runner, bin: &bin, jail: &env.jail, env: &base };
            let files = knownhosts::known_files(&env.app_known_hosts(), Some(&env.home_known_hosts()), env.jail.policy() != NetworkPolicy::Full);
            knownhosts::trust_host_key(&ctx, &host, port, &fp, &env.app_known_hosts(), &files)
        })
        .await
        .map_err(|_| StudioError::new(code::HOST_KEY, "the host key step stopped"))?
    }

    /// `mongo_ssh_forget`: removes only the entries of the app-owned file, after the host name was typed.
    #[cfg(unix)]
    pub async fn ssh_forget(&self, host: &str, port: u16, typed_host: &str) -> Result<ForgetReport> {
        use crate::tunnel::{knownhosts, ssh as sshm};
        self.ensure_enabled()?;
        let env = self.tunnel_env();
        let (host, typed) = (host.to_string(), typed_host.to_string());
        tokio::task::spawn_blocking(move || -> Result<ForgetReport> {
            let bin = sshm::SshBinary::locate(env.jail.policy(), env.ssh_override.as_deref(), &env.facts)?;
            let base = sshm::base_env(&sshm::EnvInputs { home: env.home.to_string_lossy().into_owned(), user: env.local_user.clone(), auth_sock: None });
            let ctx = sshm::SshCtx { runner: &*env.runner, bin: &bin, jail: &env.jail, env: &base };
            knownhosts::forget_host_key(&ctx, &host, port, &typed, &env.app_known_hosts())
        })
        .await
        .map_err(|_| StudioError::new(code::HOST_KEY, "the host key step stopped"))?
    }

    /// `mongo_dialog_open` / `mongo_dialog_save`, second half: the Tauri layer opened the native dialog itself and hands
    /// the picked path here; the webview only ever gets the one-time handle.
    pub fn dialog_issue(&self, kind: DialogKind, path: std::path::PathBuf) -> Result<DialogHandle> {
        self.ensure_enabled()?;
        if kind == DialogKind::Export {
            self.jail().check_write(&path)?;
        }
        self.handles().issue(kind, path)
    }

    /// `mongo_profiles_export`: redeems a save handle; secrets never leave (`exchange::export_document`).
    pub fn profiles_export(&self, ids: &[String], opts: crate::exchange::ExportOptions, handle: &str) -> Result<u32> {
        self.ensure_enabled()?;
        let path = self.handles().redeem(handle, DialogKind::Export)?;
        self.jail().check_write(&path)?;
        let mut profiles = Vec::new();
        for id in ids {
            profiles.push(self.profiles.get(id)?);
        }
        let n = profiles.iter().filter(|p| crate::exchange::exportable(p)).count();
        let doc = crate::exchange::export_document(&profiles, opts)?;
        crate::exchange::write_export_file(&path, &doc)?;
        self.audit_event(&AuditEvent::new(audit::event::PROFILE_EXPORT, "-").with_count(n));
        Ok(n as u32)
    }

    /// `mongo_profiles_import_preview`: redeems an open handle, reads the file (regular, <= 1 MiB) and stages the parsed
    /// profiles under the handle token until the user picks which ones to import.
    pub fn profiles_import_preview(&self, handle: &str) -> Result<ImportPreview> {
        self.ensure_enabled()?;
        // an import writes profiles: the read-only jail refuses it before the file is even opened
        self.jail().check_write(&self.profiles.settings_dir())?;
        let path = self.handles().redeem(handle, DialogKind::Import)?;
        let bytes = crate::exchange::read_import_file(&path, &crate::exchange::OsFiles)?;
        let opts = crate::exchange::ImportOptions { happy_preset: self.extras.happy_preset(), existing_names: self.profiles.list()?.into_iter().map(|p| p.name).collect() };
        let (preview, inputs) = if crate::exchange::looks_like_json(&bytes) {
            crate::exchange::import_json(&bytes, &opts)?
        } else {
            let text = std::str::from_utf8(&bytes).map_err(|_| StudioError::new(code::IMPORT, "import.encoding"))?;
            crate::exchange::import_uri_list(text, &opts)?
        };
        self.staging().stage(handle, inputs);
        Ok(preview)
    }

    /// `mongo_profiles_import`: every selected profile goes through the normal save (read-only, AI off, no relax).
    pub fn profiles_import(&self, handle: &str, selected: &[u32]) -> Result<ImportReport> {
        self.ensure_enabled()?;
        self.jail().check_write(&self.profiles.settings_dir())?;
        let inputs = self.staging().take_selected(handle, selected)?;
        let (mut imported, mut skipped, mut notes) = (0u32, 0u32, Vec::new());
        for input in inputs {
            match self.profile_save(input) {
                Ok(_) => imported += 1,
                Err(e) => {
                    skipped += 1;
                    notes.push(Note { code: e.code.to_string(), option: None });
                }
            }
        }
        self.audit_event(&AuditEvent::new(audit::event::PROFILE_IMPORT, "-").with_count(imported as usize));
        Ok(ImportReport { imported, skipped, notes })
    }

    /// `mongo_detect_local`: loopback 27017 to 27019, in parallel, 400 ms total. Only on a click; the read-only jail
    /// refuses it, the test jail allows it (loopback).
    pub async fn detect_local(&self) -> Result<Vec<LocalHit>> {
        self.ensure_enabled()?;
        if self.network == NetworkPolicy::Refused {
            return Err(StudioError::new(code::READ_ONLY_JAIL, "the read-only jail refuses local detection"));
        }
        async fn probe(port: u16) -> Option<LocalHit> {
            let c = tokio::time::timeout(std::time::Duration::from_millis(400), tokio::net::TcpStream::connect(("127.0.0.1", port))).await;
            matches!(c, Ok(Ok(_))).then(|| LocalHit { host: "127.0.0.1".into(), port })
        }
        let (a, b, c) = tokio::join!(probe(27017), probe(27018), probe(27019));
        Ok([a, b, c].into_iter().flatten().collect())
    }

    /// `mongo_ai_capabilities`: cheap file and PATH checks, no process. The glue passes the script and Claude CLI paths it
    /// would use.
    pub fn ai_capabilities(&self, script: Option<&std::path::Path>, claude_bin: Option<&std::path::Path>) -> Result<AiCapabilities> {
        self.ensure_enabled()?;
        let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        dirs.extend(["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"].map(std::path::PathBuf::from));
        let is_file = |p: &std::path::Path| std::fs::metadata(p).is_ok_and(|m| m.is_file());
        Ok(AiCapabilities { node: dirs.iter().any(|d| is_file(&d.join("node"))), claude_cli: claude_bin.is_some_and(is_file), script: script.is_some_and(is_file) })
    }

    /// `mongo_reset_all`: the "forget everything" path. Works while Studio is off. Closes everything, deletes every
    /// profile and its secret-store accounts, the app-owned known_hosts file, the tunnel pid file, stale tunnel
    /// directories of dead apps and, when asked, the audit log. Local data only.
    pub async fn reset_all(&self, typed_phrase: &str, audit_too: bool) -> Result<ResetReport> {
        if typed_phrase.trim() != RESET_PHRASE {
            return Err(StudioError::new(code::CONFIRM, "type the reset phrase to confirm"));
        }
        let jail = self.jail();
        let dir = self.profiles.settings_dir();
        jail.check_write(&dir)?;
        #[cfg(unix)]
        self.tunnels.close_all().await;
        self.shutdown_all();
        let profiles = self.profiles.list()?;
        let mut secrets = 0u32;
        for p in &profiles {
            let s = p.secrets;
            secrets += [s.password, s.key_password, s.ssh_secret, s.proxy_password, p.has_uri].into_iter().filter(|b| *b).count() as u32;
            self.profiles.delete(&p.id)?;
        }
        #[cfg(unix)]
        {
            let temps = vec![std::env::temp_dir(), std::path::PathBuf::from("/tmp")];
            crate::tunnel::sweep::sweep(&jail, &dir, &temps, &crate::tunnel::sweep::SystemProcs, crate::tunnel::dir::current_uid());
        }
        let mut files = 0u32;
        let mut remove = |p: std::path::PathBuf| {
            if p.exists() && jail.check_write(&p).is_ok() && std::fs::remove_file(&p).is_ok() {
                files += 1;
            }
        };
        for name in ["mongo_known_hosts", "mongo_known_hosts.old", "mongo-ssh.pids"] {
            remove(dir.join(name));
        }
        if audit_too {
            let a = self.audit.path().to_path_buf();
            for suffix in ["", ".1", ".2"] {
                let mut s = a.clone().into_os_string();
                s.push(suffix);
                remove(std::path::PathBuf::from(s));
            }
        } else {
            self.audit_event(&AuditEvent::new(audit::event::RESET, "-").with_count(profiles.len()));
        }
        self.emit();
        Ok(ResetReport { profiles: profiles.len() as u32, secrets, files })
    }
}
