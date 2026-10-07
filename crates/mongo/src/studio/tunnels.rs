//! Tunnel ownership inside the gateway (T6c).
//!
//! One [`Tunnels`] registry per [`Studio`]. A tunnel belongs to exactly one [`Owner`]: a live connection (`Connection`) or
//! a running connection test (`Test`). The two keys are different, every open starts its own ssh master, and the registry
//! has no lookup that could hand the tunnel of one owner to the other, so a test and a connection never share a tunnel.
//!
//! Every way out closes the tunnel: a failed open (`Tunnel::open` tears down what it built), a [`Lease`] dropped without
//! [`Lease::keep`] (the pipeline failed after the tunnel was up), [`Tunnels::cancel`], disconnect, switch-off
//! ([`Tunnels::close_all_detached`]), quit ([`Tunnels::close_all_blocking`], no runtime needed). A master that ends by
//! itself removes the entry, writes a `tunnel-close` audit line (`dropped`), posts a notice, queues the connection id
//! ([`Tunnels::take_ended`]) and runs the hook once. **Nothing reconnects**: only a human-started open creates a tunnel.
//!
//! Audit lines carry the masked host label, the tag, the level and a diagnosis code, never a user name, path or URI.

use std::sync::{Arc, Weak};
use std::time::Duration;

use super::{lock, Conn, Studio};
use crate::audit::AuditEvent;

#[cfg(unix)]
pub use imp::*;

#[cfg(not(unix))]
pub use stub::*;

/// There is no tunnel on this platform (OpenSSH for Windows has no ControlMaster): the registry is always empty.
#[cfg(not(unix))]
mod stub {
    use std::sync::Arc;
    use std::time::Duration;

    use crate::profile::ProfileStore;

    pub struct Tunnels;

    impl Tunnels {
        pub fn new(_profiles: Arc<ProfileStore>, _audit_path: std::path::PathBuf) -> Self {
            Tunnels
        }
        pub fn count(&self) -> usize {
            0
        }
        pub fn take_ended(&self) -> Vec<String> {
            Vec::new()
        }
        pub fn connection_state(&self, _id: &str) -> Option<crate::api::TunnelState> {
            None
        }
        pub fn close_connection_detached(&self, _id: &str) {}
        pub fn close_all_detached(&self) {}
        pub fn close_all_blocking(&self, _timeout: Duration) {}
        pub fn set_ended_hook(&self, _cb: impl Fn(&str) + Send + Sync + 'static) {}
        pub fn audit(&self, _ev: &crate::audit::AuditEvent) {}
    }
}

#[cfg(unix)]
mod imp {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex, MutexGuard};
    use std::time::{Duration, Instant};

    use crate::api::{ErrorClass, Notice, TunnelState};
    use crate::audit::{event, AuditEvent, AuditLog};
    use crate::connspec::{AllowedHost, HostPort, SshSpec};
    use crate::error::{code, Result, StudioError};
    use crate::host;
    use crate::profile::ProfileStore;
    use crate::tunnel::relay::StreamFailure;
    use crate::tunnel::{AllowList, CancelFlag, Socks5Endpoint, Tunnel, TunnelEnv, TunnelSecrets};

    fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
        m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Who a tunnel is for. The id is the profile id of a connection, or the UI-chosen id of a test.
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum Owner {
        Connection(String),
        Test(String),
    }

    impl Owner {
        pub fn id(&self) -> &str {
            match self {
                Owner::Connection(i) | Owner::Test(i) => i,
            }
        }

        fn key(&self) -> String {
            match self {
                Owner::Connection(i) => format!("c:{i}"),
                Owner::Test(i) => format!("t:{i}"),
            }
        }

        fn is_test(&self) -> bool {
            matches!(self, Owner::Test(_))
        }
    }

    /// What the notice and the audit line say about the owner. Nothing secret: the label is the masked display host.
    #[derive(Debug, Clone, Default)]
    pub struct Who {
        /// The profile name, for the notice (UI only, never in the audit file).
        pub name: String,
        /// `local`, `sandbox` or `production`.
        pub environment: String,
        /// `Local` or `ProductionLevel`.
        pub level: String,
        /// `host::display_host`.
        pub label: String,
    }

    #[derive(Debug, Clone, PartialEq)]
    pub struct TunnelInfo {
        pub state: TunnelState,
        /// Destinations the relay refused (feeds `tunnel.notAllowed`).
        pub refused: Vec<HostPort>,
        /// The diagnosis code of the last failed `-W` child (`tunnel.forwardingDisabled`, `tunnel.targetRefused`).
        pub failure_code: Option<&'static str>,
    }

    struct Entry {
        tunnel: Tunnel,
        who: Who,
        owner: Owner,
        gen: u64,
        since: Instant,
    }

    type EndedHook = Arc<dyn Fn(&str) + Send + Sync>;

    struct Core {
        audit: AuditLog,
        profiles: Arc<ProfileStore>,
        reg: Mutex<HashMap<String, Entry>>,
        /// Cancel flags of opens that are still running.
        pending: Mutex<HashMap<String, CancelFlag>>,
        gen: std::sync::atomic::AtomicU64,
        ended: Mutex<Vec<String>>,
        hook: Mutex<Option<EndedHook>>,
    }

    /// The registry. Cheap to create: no thread, no file, no process until the first open.
    pub struct Tunnels {
        core: Arc<Core>,
    }

    fn busy(what: &str) -> StudioError {
        StudioError::new(code::BUSY, format!("{what} is already being opened"))
    }

    fn cancelled() -> StudioError {
        StudioError::new(code::CANCELLED, "tunnel.cancelled: the tunnel was cancelled")
    }

    /// The error class and the code that go into the audit line.
    fn class_and_code(e: &StudioError) -> (ErrorClass, String) {
        if let Some(rest) = e.message.strip_prefix("tunnel.") {
            let tail: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            return (ErrorClass::Tunnel, format!("tunnel.{tail}"));
        }
        let class = match e.code {
            code::NEED_SECRET | code::INVALID | code::TEST_JAIL | code::READ_ONLY_JAIL | code::NEEDS_REVIEW => ErrorClass::Config,
            code::CANCELLED => ErrorClass::Other,
            _ => ErrorClass::Tunnel,
        };
        (class, e.code.to_string())
    }

    impl Core {
        fn event(&self, name: &str, key_id: &str, who: &Who) -> AuditEvent {
            AuditEvent::new(name, key_id).with_tag(&who.environment, &who.level).with_label(&who.label)
        }

        /// An audit failure never hides the outcome, but it is not silent: it shows up as a notice.
        fn write(&self, ev: &AuditEvent) {
            if let Err(e) = self.audit.append_event(ev) {
                self.profiles.push_notice(Notice { profile_id: String::new(), message: format!("The audit log could not be written: {}", host::redact(&e.message)) });
            }
        }

        fn close_event(&self, e: &Entry, dropped: bool) -> AuditEvent {
            let ev = self.event(event::TUNNEL_CLOSE, e.owner.id(), &e.who).with_duration(e.since.elapsed());
            if dropped {
                ev.failed(ErrorClass::Tunnel, "tunnel.dropped").with_outcome("dropped")
            } else {
                ev
            }
        }

        fn take(&self, key: &str) -> Option<Entry> {
            lock(&self.reg).remove(key)
        }

        fn take_gen(&self, key: &str, gen: u64) -> Option<Entry> {
            let mut r = lock(&self.reg);
            match r.get(key) {
                Some(e) if e.gen == gen => r.remove(key),
                _ => None,
            }
        }

        async fn dispose(&self, e: Entry) {
            let ev = self.close_event(&e, false);
            e.tunnel.close().await;
            self.write(&ev);
        }

        fn dispose_blocking(&self, e: Entry, timeout: Duration) {
            let ev = self.close_event(&e, false);
            e.tunnel.close_blocking(timeout);
            self.write(&ev);
        }

        /// Closes without waiting: on the runtime when there is one, on a short-lived thread otherwise.
        fn dispose_detached(self: &Arc<Self>, e: Entry) {
            let core = self.clone();
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                rt.spawn(async move { core.dispose(e).await });
            } else {
                std::thread::spawn(move || core.dispose_blocking(e, Duration::from_secs(2)));
            }
        }

        /// The ssh master ended without being asked to. Runs on the tunnel's monitor thread.
        fn master_ended(self: &Arc<Self>, key: &str, gen: u64) {
            let Some(e) = self.take_gen(key, gen) else { return };
            let ev = self.close_event(&e, true);
            self.write(&ev);
            if let Owner::Connection(id) = &e.owner {
                let name = if e.who.name.is_empty() { e.who.label.clone() } else { e.who.name.clone() };
                self.profiles.push_notice(Notice { profile_id: id.clone(), message: host::redact(&format!("The SSH tunnel for {name} ended")) });
                lock(&self.ended).push(id.clone());
                let hook = lock(&self.hook).clone();
                if let Some(h) = hook {
                    h(id);
                }
            }
            // Closing joins the monitor thread, which is the thread running this callback: do it elsewhere.
            let tunnel = e.tunnel;
            std::thread::spawn(move || tunnel.close_blocking(Duration::from_secs(1)));
        }

        /// Sets every pending cancel flag. Called BEFORE the registry is drained, so an open that finishes later sees it.
        fn cancel_pending(&self, only: Option<&str>) {
            for (k, f) in lock(&self.pending).iter() {
                if only.is_none_or(|o| o == k) {
                    f.store(true, Ordering::SeqCst);
                }
            }
        }
    }

    struct PendingGuard {
        core: Arc<Core>,
        key: String,
    }

    impl Drop for PendingGuard {
        fn drop(&mut self) {
            lock(&self.core.pending).remove(&self.key);
        }
    }

    /// The right to a tunnel that is up. Dropping it closes the tunnel unless [`Lease::keep`] was called, so a pipeline that
    /// fails after the tunnel opened cannot leave it behind. [`Lease::close`] awaits the graceful close.
    pub struct Lease {
        core: Arc<Core>,
        key: String,
        gen: u64,
        endpoint: Socks5Endpoint,
        keep: bool,
    }

    impl std::fmt::Debug for Lease {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            // never the SOCKS credentials
            f.debug_struct("Lease").field("key", &self.key).field("port", &self.endpoint.port).field("keep", &self.keep).finish()
        }
    }

    impl Lease {
        /// The loopback SOCKS5 endpoint for `ClientOptions.socks5_proxy`.
        pub fn proxy(&self) -> Socks5Endpoint {
            self.endpoint.clone()
        }

        /// The connection is established: the registry now owns the tunnel until `close_connection`, disconnect,
        /// switch-off, quit or the master's death.
        pub fn keep(mut self) {
            self.keep = true;
        }

        /// Closes the tunnel now and waits for it (graceful `-O exit`, directory removed).
        pub async fn close(mut self) {
            self.keep = true;
            if let Some(e) = self.core.take_gen(&self.key, self.gen) {
                self.core.dispose(e).await;
            }
        }
    }

    impl Drop for Lease {
        fn drop(&mut self) {
            if !self.keep {
                if let Some(e) = self.core.take_gen(&self.key, self.gen) {
                    self.core.dispose_detached(e);
                }
            }
        }
    }

    impl Tunnels {
        /// `audit_path` is the same `mongo-audit.jsonl` the gateway writes (one process-wide write lock).
        pub fn new(profiles: Arc<ProfileStore>, audit_path: PathBuf) -> Self {
            Self {
                core: Arc::new(Core {
                    audit: AuditLog::new(audit_path),
                    profiles,
                    reg: Mutex::new(HashMap::new()),
                    pending: Mutex::new(HashMap::new()),
                    gen: std::sync::atomic::AtomicU64::new(0),
                    ended: Mutex::new(Vec::new()),
                    hook: Mutex::new(None),
                }),
            }
        }

        /// Tunnels that are registered (up or not yet noticed dead).
        pub fn count(&self) -> usize {
            lock(&self.core.reg).len()
        }

        /// Opens a tunnel for `owner`. A human action must be the reason for this call: nothing in here retries.
        ///
        /// A second open for an owner that is still opening answers `mongoBusy`; a live connection tunnel of the same
        /// owner is closed first (the reconnect case); a test id that is already in use answers `mongoBusy`.
        #[allow(clippy::too_many_arguments)]
        pub async fn open(&self, env: &TunnelEnv, owner: Owner, who: Who, spec: &SshSpec, secrets: &TunnelSecrets, allow: AllowList, cancel: CancelFlag) -> Result<Lease> {
            let core = &self.core;
            let key = owner.key();
            {
                let mut p = lock(&core.pending);
                if p.contains_key(&key) {
                    return Err(busy("a tunnel for this connection"));
                }
                p.insert(key.clone(), cancel.clone());
            }
            let _pending = PendingGuard { core: core.clone(), key: key.clone() };

            let existing = lock(&core.reg).remove(&key);
            if let Some(old) = existing {
                if owner.is_test() {
                    lock(&core.reg).insert(key.clone(), old);
                    return Err(busy("this test"));
                }
                core.dispose(old).await;
            }

            let started = Instant::now();
            let opened = Tunnel::open(env, spec, secrets, allow, cancel.clone()).await;
            let tunnel = match opened {
                Ok(t) => t,
                Err(e) => {
                    let (class, c) = class_and_code(&e);
                    core.write(&core.event(event::TUNNEL_OPEN, owner.id(), &who).with_duration(started.elapsed()).failed(class, &c));
                    return Err(e);
                }
            };

            let gen = core.gen.fetch_add(1, Ordering::SeqCst) + 1;
            let endpoint = tunnel.proxy();
            {
                let c2 = core.clone();
                let k2 = key.clone();
                tunnel.on_exit(Box::new(move || c2.master_ended(&k2, gen)));
            }
            let mut tunnel = Some(tunnel);
            {
                // The flag is re-read under the registry lock: `cancel_pending` runs before the registry is drained, so
                // an open that finishes after a close-all either lands here before the drain or sees the flag.
                let mut r = lock(&core.reg);
                if !cancel.load(Ordering::SeqCst) {
                    r.insert(key.clone(), Entry { tunnel: tunnel.take().expect("tunnel"), who: who.clone(), owner: owner.clone(), gen, since: Instant::now() });
                }
            }
            if let Some(t) = tunnel {
                t.close().await;
                core.write(&core.event(event::TUNNEL_OPEN, owner.id(), &who).with_duration(started.elapsed()).failed(ErrorClass::Other, code::CANCELLED));
                return Err(cancelled());
            }
            core.write(&core.event(event::TUNNEL_OPEN, owner.id(), &who).with_duration(started.elapsed()));
            // A master that died while it was being registered fired its callback before the entry existed.
            let dead = lock(&core.reg).get(&key).is_some_and(|e| e.tunnel.state() == TunnelState::Down);
            if dead {
                core.master_ended(&key, gen);
            }
            Ok(Lease { core: core.clone(), key, gen, endpoint, keep: false })
        }

        fn with<R>(&self, owner: &Owner, f: impl FnOnce(&Entry) -> R) -> Option<R> {
            lock(&self.core.reg).get(&owner.key()).map(f)
        }

        pub fn info(&self, owner: &Owner) -> Option<TunnelInfo> {
            self.with(owner, |e| TunnelInfo { state: e.tunnel.state(), refused: e.tunnel.refused(), failure_code: e.tunnel.last_failure().and_then(|f: StreamFailure| f.code) })
        }

        /// The state the connection card shows. `None` when this connection has no tunnel.
        pub fn connection_state(&self, id: &str) -> Option<TunnelState> {
            self.with(&Owner::Connection(id.to_string()), |e| e.tunnel.state())
        }

        /// The "Allow these hosts" / "Allow this host" step: widens the relay's allow-list (the caller saves the widened
        /// `allowed_hosts`, which is signed through `conn_hash`).
        pub fn allow_more(&self, owner: &Owner, hosts: &[AllowedHost]) -> Result<()> {
            match lock(&self.core.reg).get(&owner.key()) {
                Some(e) => e.tunnel.allow_more(hosts),
                None => Err(StudioError::new(code::TUNNEL, "tunnel.network: the tunnel is closed")),
            }
        }

        /// Cancels a test: an open in progress stops, a tunnel it already built is closed (and awaited).
        pub async fn cancel_test(&self, test_id: &str) {
            self.close(&Owner::Test(test_id.to_string())).await;
        }

        /// Closes the tunnel of `owner` (an open in progress is cancelled too) and waits for the teardown.
        pub async fn close(&self, owner: &Owner) {
            let key = owner.key();
            self.core.cancel_pending(Some(&key));
            if let Some(e) = self.core.take(&key) {
                self.core.dispose(e).await;
            }
        }

        pub async fn close_connection(&self, id: &str) {
            self.close(&Owner::Connection(id.to_string())).await;
        }

        /// Sync, for `Studio::disconnect` and profile edits: the teardown runs in the background.
        pub fn close_connection_detached(&self, id: &str) {
            let key = Owner::Connection(id.to_string()).key();
            self.core.cancel_pending(Some(&key));
            if let Some(e) = self.core.take(&key) {
                self.core.dispose_detached(e);
            }
        }

        /// Every tunnel and every open in progress, awaited.
        pub async fn close_all(&self) {
            self.core.cancel_pending(None);
            let all: Vec<Entry> = lock(&self.core.reg).drain().map(|(_, e)| e).collect();
            for e in all {
                self.core.dispose(e).await;
            }
        }

        /// Sync, for the switch-off: the teardown runs in the background.
        pub fn close_all_detached(&self) {
            self.core.cancel_pending(None);
            let all: Vec<Entry> = lock(&self.core.reg).drain().map(|(_, e)| e).collect();
            for e in all {
                self.core.dispose_detached(e);
            }
        }

        /// Quit (`RunEvent::Exit`): no runtime needed. The tunnels close in parallel, so N tunnels cost one `timeout`,
        /// not N; the call returns when all of them are gone.
        pub fn close_all_blocking(&self, timeout: Duration) {
            self.core.cancel_pending(None);
            let all: Vec<Entry> = lock(&self.core.reg).drain().map(|(_, e)| e).collect();
            let workers: Vec<_> = all
                .into_iter()
                .map(|e| {
                    let core = self.core.clone();
                    std::thread::spawn(move || core.dispose_blocking(e, timeout))
                })
                .collect();
            for w in workers {
                let _ = w.join();
            }
        }

        /// Connection ids whose master ended since the last call. The gateway closes those connections.
        pub fn take_ended(&self) -> Vec<String> {
            std::mem::take(&mut *lock(&self.core.ended))
        }

        /// `cb(connection_id)` runs once per ended connection tunnel, on the tunnel's monitor thread.
        pub fn set_ended_hook(&self, cb: impl Fn(&str) + Send + Sync + 'static) {
            *lock(&self.core.hook) = Some(Arc::new(cb));
        }

        /// One lifecycle line (`connect`, `disconnect`, `profile-import`, ...). A failed write becomes a notice.
        pub fn audit(&self, ev: &AuditEvent) {
            self.core.write(ev);
        }
    }
}

// ---- the gateway side -----------------------------------------------------------------------------------------

impl Studio {
    pub fn tunnels(&self) -> &Tunnels {
        &self.tunnels
    }

    /// Writes a lifecycle line to the audit log (a failed write becomes a notice, never an error).
    /// The read-only jail writes no file at all, so a refused connect leaves no audit line either.
    pub fn audit_event(&self, ev: &AuditEvent) {
        if self.network == crate::jail::NetworkPolicy::Refused {
            return;
        }
        self.tunnels.audit(ev);
    }

    /// Makes a dying tunnel close its connection at once: when a master ends without being asked to, the connection
    /// is dropped (cursors and digests with it) and the state is emitted, with the notice already posted. Without this
    /// call the same cleanup runs at the next `status()` or `conn()`. Nothing reconnects.
    pub fn watch_tunnel_ends(self: &Arc<Self>) {
        let weak: Weak<Studio> = Arc::downgrade(self);
        self.tunnels.set_ended_hook(move |_| {
            if let Some(s) = weak.upgrade() {
                s.reap_ended_tunnels();
                s.emit();
            }
        });
    }

    /// The `disconnect` audit line of a connection that is going away: tag, level, masked label, nothing else.
    pub(super) fn audit_disconnect(&self, c: &Conn) {
        let label = self.profiles.get(&c.view.id).map(|p| p.host).unwrap_or_default();
        let tag = format!("{:?}", c.view.environment).to_lowercase();
        self.audit_event(&AuditEvent::new(crate::audit::event::DISCONNECT, &c.view.id).with_tag(&tag, &format!("{:?}", c.view.effective_level)).with_label(&label));
    }

    /// Drops the connections whose tunnel ended.
    pub(super) fn reap_ended_tunnels(&self) {
        for id in self.tunnels.take_ended() {
            self.drop_connection(&id);
        }
    }

    /// Quit: cancels runs, drops every connection, cursor and digest, and closes every tunnel without a runtime.
    pub fn close_all_blocking(&self, timeout: Duration) {
        let runs: Vec<crate::driver::CancelToken> = lock(&self.runs).drain().map(|(_, (_, t))| t).collect();
        for t in &runs {
            t.mark_cancelled();
        }
        let conns: Vec<Arc<Conn>> = lock(&self.conns).drain().map(|(_, c)| c).collect();
        lock(&self.cursors).clear();
        lock(&self.ai_digests).clear();
        for c in conns {
            self.audit_disconnect(&c);
            c.session.clone().close();
        }
        self.tunnels.close_all_blocking(timeout);
    }
}

/// The one proof that needs the gateway's private state: a connection whose tunnel dies is dropped, with its cursors, by
/// the hook that `watch_tunnel_ends` installs. The fake ssh stands in for `ssh`; the session is lazy (no server).
#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::sync::atomic::AtomicBool;
    use std::time::Instant;

    use intely_settings::{MemorySecretStore, SettingsStore};

    use super::*;
    use crate::api::{Environment, TlsRelax};
    use crate::connspec::{HostPort, SshSpec};
    use crate::driver::{Session, SessionOpts};
    use crate::jail::{Jail, NetworkPolicy};
    use crate::profile::{Profile, ProfileStore};
    use crate::studio::CursorState;
    use crate::tunnel::sweep::ProcessTable;
    use crate::tunnel::{AllowList, TunnelEnv, TunnelSecrets};
    use crate::types::{EffectiveLevel, ReadCommand, RoleChip};

    struct AlwaysAlive;

    impl ProcessTable for AlwaysAlive {
        fn start_time(&self, pid: u32) -> Option<String> {
            Some(format!("t{pid}"))
        }
        fn command(&self, _pid: u32) -> Option<String> {
            None
        }
        fn terminate(&self, _pid: u32) {}
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dying_master_closes_the_connection_with_its_cursors_and_emits_once() {
        let root = tempfile::tempdir().unwrap();
        let (fake, state) = (root.path().join("fake"), root.path().join("state"));
        std::fs::create_dir_all(&fake).unwrap();
        std::fs::create_dir_all(&state).unwrap();
        std::fs::create_dir_all(root.path().join("home")).unwrap();
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/mongo-fixture/fake-ssh");
        std::fs::copy(src.join("ssh"), fake.join("ssh")).unwrap();
        std::fs::set_permissions(fake.join("ssh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(fake.join("mode"), "die-after-n-seconds 1").unwrap();

        let jail = Jail::new(NetworkPolicy::LoopbackOnly, &std::env::temp_dir(), Some(root.path()));
        let mut env = TunnelEnv::new(jail, state.clone());
        env.temp_dir = root.path().to_path_buf();
        env.home = root.path().join("home");
        env.auth_sock = None;
        env.ssh_override = Some(fake.join("ssh").to_string_lossy().into_owned());
        env.procs = Arc::new(AlwaysAlive);
        env.poll = Duration::from_millis(30);

        let settings = Arc::new(SettingsStore::open(state.join("settings.json")).unwrap());
        let studio = Arc::new(Studio::new(Arc::new(ProfileStore::new(settings, Arc::new(MemorySecretStore::new()))), NetworkPolicy::LoopbackOnly));
        studio.watch_tunnel_ends();

        struct Count(std::sync::atomic::AtomicUsize);
        impl super::super::Sink for Count {
            fn state(&self, _s: &crate::api::StudioStatus) {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let sink = Arc::new(Count(std::sync::atomic::AtomicUsize::new(0)));
        studio.set_sink(sink.clone());

        // a live (lazy) session with a cursor, registered as the connection "p1"
        let session = Session::connect("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200", SessionOpts::default()).await.unwrap();
        let view = crate::api::ConnectionView {
            id: "p1".into(),
            name: "Bastion DB".into(),
            server_version: "7".into(),
            topology: "single".into(),
            ping_ms: 1,
            effective_level: EffectiveLevel::ProductionLevel,
            environment: Environment::Production,
            read_only: true,
            read_preference: Profile::read_preference(EffectiveLevel::ProductionLevel),
            role: RoleChip::ReadOnly,
            role_elevated: false,
            tls: false,
            tunnel: None,
            tls_relax: TlsRelax::None,
        };
        lock(&studio.conns).insert("p1".into(), Arc::new(Conn { session, view }));
        lock(&studio.cursors).insert(
            "tab-1".into(),
            CursorState { connection: "p1".into(), cmd: ReadCommand::ListDatabases, start: 0, docs: vec![], truncated: false, bytes: 0, elapsed_ms: 0, plan: None, secondary_ok: false },
        );
        assert_eq!(studio.session_count(), 1);

        let spec = SshSpec { host: "127.0.0.1".into(), port: Some(2222), user: "tester".into(), ..Default::default() };
        let allow = AllowList { entries: vec![HostPort { host: "127.0.0.1".into(), port: Some(27017) }] };
        let who = Who { name: "Bastion DB".into(), environment: "production".into(), level: "ProductionLevel".into(), label: "db.example.com".into() };
        studio.tunnels().open(&env, Owner::Connection("p1".into()), who, &spec, &TunnelSecrets::default(), allow, Arc::new(AtomicBool::new(false))).await.unwrap().keep();

        let t0 = Instant::now();
        while studio.session_count() > 0 && t0.elapsed() < Duration::from_secs(10) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(studio.session_count(), 0, "the connection was closed when its master ended");
        assert_eq!(studio.cursor_count(), 0, "its cursors were dropped");
        assert_eq!(sink.0.load(std::sync::atomic::Ordering::SeqCst), 1, "the state was emitted once");
        assert!(studio.status().connections.is_empty());
        assert!(studio.profiles().notices().iter().any(|n| n.profile_id == "p1" && n.message.contains("The SSH tunnel for Bastion DB ended")));
        // the disconnect was audited, with a label from nothing secret
        let text = std::fs::read_to_string(studio.audit_path()).unwrap();
        assert!(text.contains("\"op\":\"disconnect\"") && text.contains("\"op\":\"tunnel-close\""), "{text}");
        assert_eq!(studio.tunnels().count(), 0);
    }
}
