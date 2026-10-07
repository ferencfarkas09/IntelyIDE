//! One actor per repo: coalesced read lane, single write mutex, network lane (contract section 7).
//!
//! The global process cap is not taken here: it is enforced per spawned process by [`ProcessGate`], so a
//! queued repo never holds a global slot while it waits for its own lane.

use std::any::Any;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};

use tokio::sync::{watch, Notify, Semaphore};
use tokio::task::JoinHandle;

use crate::exec::{SpawnClass, SpawnGate};
use crate::watcher::{self, RepoWatcher};
use crate::{code, EngineError, EventSink, HeadInfo, HookInfo, HookKind, RepoConfig, RepoSnapshot, RepoState};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Computes a fresh snapshot (revision and change detection are the actor's job).
pub type SnapshotFn = Arc<dyn Fn(RepoConfig) -> BoxFuture<'static, Result<RepoSnapshot, EngineError>> + Send + Sync>;

/// Status reads (and other short reads) per repo.
const READ_LANE: usize = 2;
/// Concurrent git processes across all repos, per counter.
pub const GLOBAL_PROCESS_CAP: usize = 4;

/// The global process cap, enforced per spawned process through `GitCtx::gate`. Hook runs and network
/// calls share one counter and reads have their own, so status reads never queue behind a slow hook.
pub struct ProcessGate {
    reads: Arc<Semaphore>,
    slow: Arc<Semaphore>,
}

impl ProcessGate {
    pub fn new(reads: usize, slow: usize) -> Self {
        Self { reads: Arc::new(Semaphore::new(reads)), slow: Arc::new(Semaphore::new(slow)) }
    }
}

impl Default for ProcessGate {
    fn default() -> Self {
        Self::new(GLOBAL_PROCESS_CAP, GLOBAL_PROCESS_CAP)
    }
}

impl SpawnGate for ProcessGate {
    fn acquire(&self, class: SpawnClass) -> BoxFuture<'_, Box<dyn Any + Send>> {
        let counter = match class {
            SpawnClass::Read => &self.reads,
            SpawnClass::Hook | SpawnClass::Network => &self.slow,
        }
        .clone();
        Box::pin(async move { Box::new(counter.acquire_owned().await.expect("process gate closed")) as Box<dyn Any + Send> })
    }
}

#[derive(Default)]
struct Cache {
    snapshot: Option<RepoSnapshot>,
    revision: u64,
}

struct Shared {
    repo: RwLock<RepoConfig>,
    read_lane: Semaphore,
    write_lock: tokio::sync::Mutex<()>,
    network_lane: Semaphore,
    source: SnapshotFn,
    sink: Arc<dyn EventSink>,
    cache: Mutex<Cache>,
    /// Count of refresh requests; the loop catches up to it, so any number of requests during one read cost one more read.
    requested: AtomicU64,
    wake: Notify,
    /// Highest request number whose snapshot has been applied; `u64::MAX` once the actor is stopped.
    completed: watch::Sender<u64>,
    watcher: Mutex<Option<RepoWatcher>>,
    watch_enabled: bool,
}

pub struct RepoActor {
    shared: Arc<Shared>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl RepoActor {
    /// Must be called inside a tokio runtime. Starts the refresh loop and, if `watch` is set, the file watcher.
    pub fn spawn(repo: RepoConfig, source: SnapshotFn, sink: Arc<dyn EventSink>, watch: bool) -> Arc<Self> {
        let shared = Arc::new(Shared {
            repo: RwLock::new(repo),
            read_lane: Semaphore::new(READ_LANE),
            write_lock: tokio::sync::Mutex::new(()),
            network_lane: Semaphore::new(1),
            source,
            sink,
            cache: Mutex::new(Cache::default()),
            requested: AtomicU64::new(0),
            wake: Notify::new(),
            completed: watch::channel(0).0,
            watcher: Mutex::new(None),
            watch_enabled: watch,
        });
        let task = tokio::spawn(refresh_loop(shared.clone()));
        Arc::new(Self { shared, task: Mutex::new(Some(task)) })
    }

    pub fn config(&self) -> RepoConfig {
        self.shared.repo.read().expect("repo config lock").clone()
    }

    /// Replaces name, colour and push targets; the path of a running actor never changes.
    pub fn set_config(&self, repo: RepoConfig) {
        *self.shared.repo.write().expect("repo config lock") = repo;
    }

    /// The latest snapshot without any I/O.
    pub fn cached(&self) -> Option<RepoSnapshot> {
        self.shared.cache.lock().expect("snapshot cache lock").snapshot.clone()
    }

    /// Latest cached snapshot; computes one if there is none yet.
    pub async fn snapshot(&self) -> Result<RepoSnapshot, EngineError> {
        if let Some(s) = self.cached() {
            return Ok(s);
        }
        self.refresh_wait().await;
        self.cached().ok_or_else(|| EngineError::new(code::CANCELLED, "the repo actor was stopped"))
    }

    /// Schedules a coalesced re-read; the result is emitted through the event sink only if it changed.
    pub fn refresh(&self) {
        self.shared.request();
    }

    /// Like [`Self::refresh`], but resolves once a snapshot requested at or after this call has been applied.
    pub async fn refresh_wait(&self) {
        let ticket = self.shared.request();
        let mut done = self.shared.completed.subscribe();
        let _ = done.wait_for(|c| *c >= ticket).await;
    }

    /// Short read-only git work: two at a time per repo.
    pub async fn read<T, F, Fut>(&self, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        self.shared.read(f).await
    }

    /// Commit, checkout and other mutations: one at a time per repo.
    pub async fn write<T, F, Fut>(&self, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let _write = self.shared.write_lock.lock().await;
        f().await
    }

    /// Fetch, push and ls-remote: one at a time per repo, independent of the write mutex.
    pub async fn network<T, F, Fut>(&self, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let _lane = self.shared.network_lane.acquire().await.expect("network lane closed");
        f().await
    }

    /// Pull: mutates the work tree and talks to the remote.
    pub async fn write_network<T, F, Fut>(&self, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let _write = self.shared.write_lock.lock().await;
        let _lane = self.shared.network_lane.acquire().await.expect("network lane closed");
        f().await
    }

    /// Stops the refresh loop and the watcher; pending [`Self::refresh_wait`] callers are released.
    pub fn shutdown(&self) {
        if let Some(task) = self.task.lock().expect("actor task lock").take() {
            task.abort();
        }
        *self.shared.watcher.lock().expect("watcher lock") = None;
        self.shared.completed.send_replace(u64::MAX);
    }
}

impl Drop for RepoActor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl Shared {
    fn request(&self) -> u64 {
        let ticket = self.requested.fetch_add(1, Ordering::SeqCst) + 1;
        self.wake.notify_one();
        ticket
    }

    async fn read<T, F, Fut>(&self, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let _lane = self.read_lane.acquire().await.expect("read lane closed");
        f().await
    }

    /// (Re)starts the watcher if there is none, e.g. because the repo path only appeared later.
    fn ensure_watcher(self: &Arc<Self>) {
        if !self.watch_enabled {
            return;
        }
        let mut slot = self.watcher.lock().expect("watcher lock");
        if slot.is_some() {
            return;
        }
        let weak: Weak<Shared> = Arc::downgrade(self);
        let root = self.repo.read().expect("repo config lock").path.clone();
        let on_change = Arc::new(move || {
            if let Some(shared) = weak.upgrade() {
                shared.request();
            }
        });
        *slot = watcher::watch(std::path::Path::new(&root), on_change).ok();
    }

    async fn compute(self: &Arc<Self>) {
        let repo = self.repo.read().expect("repo config lock").clone();
        let repo_id = repo.id.clone();
        let source = self.source.clone();
        let result = self
            .read(|| async move {
                // Own task so a panicking source ends up as an error snapshot instead of killing the loop.
                tokio::spawn(source(repo)).await.unwrap_or_else(|_| {
                    Err(EngineError::new(code::GIT, "internal error while reading the repo status"))
                })
            })
            .await;
        self.apply(&repo_id, result);
    }

    /// Stores the snapshot and emits it unless it equals the previous one apart from revision and time.
    fn apply(&self, repo_id: &str, result: Result<RepoSnapshot, EngineError>) {
        let emitted = {
            let mut cache = self.cache.lock().expect("snapshot cache lock");
            let mut next = match result {
                Ok(s) => s,
                Err(e) => {
                    let mut s = cache.snapshot.clone().unwrap_or_else(|| blank_snapshot(repo_id));
                    s.error = Some(e.message);
                    s
                }
            };
            next.repo_id = repo_id.to_owned();
            let taken_at_ms = next.taken_at_ms;
            if let Some(prev) = &cache.snapshot {
                next.revision = prev.revision;
                next.taken_at_ms = prev.taken_at_ms;
                if next == *prev {
                    return;
                }
            }
            cache.revision += 1;
            next.revision = cache.revision;
            next.taken_at_ms = taken_at_ms;
            cache.snapshot = Some(next.clone());
            next
        };
        self.sink.snapshot(emitted);
    }
}

async fn refresh_loop(shared: Arc<Shared>) {
    let mut done = 0;
    loop {
        shared.wake.notified().await;
        loop {
            let target = shared.requested.load(Ordering::SeqCst);
            if target == done {
                break;
            }
            shared.ensure_watcher();
            shared.compute().await;
            done = target;
            shared.completed.send_replace(done);
        }
    }
}

pub(crate) fn blank_snapshot(repo_id: &str) -> RepoSnapshot {
    RepoSnapshot {
        repo_id: repo_id.to_owned(),
        revision: 0,
        taken_at_ms: 0,
        head: HeadInfo { branch: None, oid: None, detached: false, unborn: false },
        upstream: None,
        ahead: 0,
        behind: 0,
        state: RepoState::Normal,
        hooks: HookInfo { kind: HookKind::None, path: None },
        changes: Vec::new(),
        stash_count: 0,
        worktree_count: 0,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::{EnvStatus, OpEvent, OpResult};

    #[derive(Default)]
    struct Sink {
        snapshots: Mutex<Vec<RepoSnapshot>>,
    }

    impl EventSink for Sink {
        fn snapshot(&self, s: RepoSnapshot) {
            self.snapshots.lock().unwrap().push(s);
        }
        fn op_event(&self, _: OpEvent) {}
        fn op_result(&self, _: OpResult) {}
        fn env(&self, _: EnvStatus) {}
    }

    fn repo(id: &str) -> RepoConfig {
        RepoConfig {
            id: id.into(),
            path: format!("/nonexistent/{id}"),
            name: id.into(),
            color: "#4caf7d".into(),
            badge: "XX".into(),
            order: 0,
            push_targets: Default::default(),
        }
    }

    /// A source that sleeps `delay`, counts its calls and reports whatever `branch` currently holds.
    struct Fake {
        calls: AtomicUsize,
        branch: Mutex<String>,
        delay: Duration,
        fail: Mutex<bool>,
    }

    impl Fake {
        fn new(delay: Duration) -> Arc<Self> {
            Arc::new(Self { calls: AtomicUsize::new(0), branch: Mutex::new("main".into()), delay, fail: Mutex::new(false) })
        }

        fn source(self: &Arc<Self>) -> SnapshotFn {
            let this = self.clone();
            Arc::new(move |repo: RepoConfig| {
                let this = this.clone();
                Box::pin(async move {
                    this.calls.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(this.delay).await;
                    if *this.fail.lock().unwrap() {
                        return Err(EngineError::new(code::REPO_MISSING, "gone"));
                    }
                    let mut s = blank_snapshot(&repo.id);
                    s.head.branch = Some(this.branch.lock().unwrap().clone());
                    s.taken_at_ms = this.calls.load(Ordering::SeqCst) as i64;
                    Ok(s)
                })
            })
        }
    }

    fn actor(id: &str, fake: &Arc<Fake>, sink: &Arc<Sink>) -> Arc<RepoActor> {
        RepoActor::spawn(repo(id), fake.source(), sink.clone(), false)
    }

    #[tokio::test]
    async fn snapshots_are_revisioned_and_emitted_only_when_changed() {
        let fake = Fake::new(Duration::from_millis(5));
        let sink = Arc::new(Sink::default());
        let a = actor("a", &fake, &sink);

        a.refresh_wait().await;
        a.refresh_wait().await;
        a.refresh_wait().await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), 3);
        assert_eq!(sink.snapshots.lock().unwrap().len(), 1, "identical content is not re-emitted");
        assert_eq!(a.cached().unwrap().revision, 1);

        *fake.branch.lock().unwrap() = "dev".into();
        a.refresh_wait().await;
        let seen = sink.snapshots.lock().unwrap().clone();
        assert_eq!(seen.iter().map(|s| s.revision).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(seen[1].head.branch.as_deref(), Some("dev"));
        assert_eq!(a.snapshot().await.unwrap().revision, 2);
    }

    #[tokio::test]
    async fn refresh_requests_coalesce_into_at_most_one_extra_read() {
        let fake = Fake::new(Duration::from_millis(120));
        let sink = Arc::new(Sink::default());
        let a = actor("a", &fake, &sink);

        for _ in 0..200 {
            a.refresh();
            tokio::task::yield_now().await;
        }
        a.refresh_wait().await;
        let calls = fake.calls.load(Ordering::SeqCst);
        assert!((1..=3).contains(&calls), "200 requests caused {calls} reads");
    }

    #[tokio::test]
    async fn snapshot_get_computes_when_nothing_is_cached() {
        let fake = Fake::new(Duration::from_millis(10));
        let sink = Arc::new(Sink::default());
        let a = actor("a", &fake, &sink);
        assert!(a.cached().is_none());
        let s = a.snapshot().await.unwrap();
        assert_eq!((s.repo_id.as_str(), s.revision), ("a", 1));
        a.snapshot().await.unwrap();
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn read_failures_become_error_snapshots_that_keep_the_last_data() {
        let fake = Fake::new(Duration::from_millis(1));
        let sink = Arc::new(Sink::default());
        let a = actor("a", &fake, &sink);
        a.refresh_wait().await;
        *fake.fail.lock().unwrap() = true;
        a.refresh_wait().await;
        a.refresh_wait().await;
        let s = a.cached().unwrap();
        assert_eq!((s.revision, s.error.as_deref(), s.head.branch.as_deref()), (2, Some("gone"), Some("main")));
        *fake.fail.lock().unwrap() = false;
        a.refresh_wait().await;
        assert_eq!(a.cached().unwrap().error, None);
        assert_eq!(sink.snapshots.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn a_panicking_source_does_not_kill_the_actor() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let source: SnapshotFn = Arc::new(move |repo: RepoConfig| {
            let n = c.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                assert!(n > 0, "first read blows up");
                Ok(blank_snapshot(&repo.id))
            })
        });
        let sink = Arc::new(Sink::default());
        let a = RepoActor::spawn(repo("a"), source, sink, false);
        a.refresh_wait().await;
        assert!(a.cached().unwrap().error.is_some());
        a.refresh_wait().await;
        assert_eq!(a.cached().unwrap().error, None);
    }

    #[tokio::test]
    async fn four_repos_refresh_in_parallel() {
        let sink = Arc::new(Sink::default());
        let fakes: Vec<_> = (0..4).map(|_| Fake::new(Duration::from_millis(300))).collect();
        let actors: Vec<_> = fakes.iter().enumerate().map(|(i, f)| actor(&format!("r{i}"), f, &sink)).collect();

        let t = Instant::now();
        let waits: Vec<_> = actors
            .iter()
            .map(|a| {
                let a = a.clone();
                tokio::spawn(async move { a.refresh_wait().await })
            })
            .collect();
        for w in waits {
            w.await.unwrap();
        }
        assert!(t.elapsed() < Duration::from_millis(800), "took {:?} instead of ~300 ms", t.elapsed());
        assert_eq!(sink.snapshots.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn the_read_lane_runs_two_at_a_time() {
        let fake = Fake::new(Duration::ZERO);
        let sink = Arc::new(Sink::default());
        let a = actor("a", &fake, &sink);
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let jobs: Vec<_> = (0..6)
            .map(|_| {
                let (a, running, peak) = (a.clone(), running.clone(), peak.clone());
                tokio::spawn(async move {
                    a.read(|| async {
                        let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(60)).await;
                        running.fetch_sub(1, Ordering::SeqCst);
                    })
                    .await
                })
            })
            .collect();
        for j in jobs {
            j.await.unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn writes_in_one_repo_are_serialised() {
        let fake = Fake::new(Duration::ZERO);
        let sink = Arc::new(Sink::default());
        let a = actor("a", &fake, &sink);
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let jobs: Vec<_> = (0..4)
            .map(|_| {
                let (a, running, peak) = (a.clone(), running.clone(), peak.clone());
                tokio::spawn(async move {
                    a.write(|| async {
                        let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        running.fetch_sub(1, Ordering::SeqCst);
                    })
                    .await
                })
            })
            .collect();
        for j in jobs {
            j.await.unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn status_is_not_delayed_by_a_running_write_in_any_repo() {
        let sink = Arc::new(Sink::default());
        let (fa, fb) = (Fake::new(Duration::from_millis(20)), Fake::new(Duration::from_millis(20)));
        let (a, b) = (actor("a", &fa, &sink), actor("b", &fb, &sink));

        let hook = {
            let a = a.clone();
            tokio::spawn(async move { a.write(|| tokio::time::sleep(Duration::from_millis(1000))).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;

        let t = Instant::now();
        b.refresh_wait().await;
        a.refresh_wait().await;
        assert!(t.elapsed() < Duration::from_millis(400), "status waited {:?} behind a hook", t.elapsed());
        assert!(!hook.is_finished(), "the hook must still be running");
        hook.await.unwrap();
    }

    #[tokio::test]
    async fn process_gate_counts_hooks_and_network_apart_from_reads() {
        let gate = ProcessGate::new(2, 1);
        let hook = gate.acquire(SpawnClass::Hook).await;

        let waiting_network = tokio::time::timeout(Duration::from_millis(100), gate.acquire(SpawnClass::Network)).await;
        assert!(waiting_network.is_err(), "hooks and network share one counter");

        // Reads pass although the slow counter is saturated, up to their own cap.
        let (r1, r2) = (gate.acquire(SpawnClass::Read).await, gate.acquire(SpawnClass::Read).await);
        assert!(tokio::time::timeout(Duration::from_millis(100), gate.acquire(SpawnClass::Read)).await.is_err());
        drop(r1);
        let r3 = tokio::time::timeout(Duration::from_millis(500), gate.acquire(SpawnClass::Read)).await.expect("slot freed");

        drop(hook);
        tokio::time::timeout(Duration::from_millis(500), gate.acquire(SpawnClass::Network)).await.expect("slot freed");
        drop((r2, r3));
    }

    #[tokio::test]
    async fn process_gate_caps_concurrent_processes_at_four() {
        let gate = Arc::new(ProcessGate::default());
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let jobs: Vec<_> = (0..12)
            .map(|_| {
                let (gate, running, peak) = (gate.clone(), running.clone(), peak.clone());
                tokio::spawn(async move {
                    let _slot = gate.acquire(SpawnClass::Read).await;
                    peak.fetch_max(running.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    running.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        for j in jobs {
            j.await.unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), GLOBAL_PROCESS_CAP);
    }

    #[tokio::test]
    async fn network_and_write_lanes_are_independent_but_pull_takes_both() {
        let fake = Fake::new(Duration::ZERO);
        let sink = Arc::new(Sink::default());
        let a = actor("a", &fake, &sink);

        let slow_write = {
            let a = a.clone();
            tokio::spawn(async move { a.write(|| tokio::time::sleep(Duration::from_millis(300))).await })
        };
        tokio::time::sleep(Duration::from_millis(30)).await;
        let t = Instant::now();
        a.network(|| async {}).await;
        assert!(t.elapsed() < Duration::from_millis(150), "fetch waited for a commit");

        let t = Instant::now();
        a.write_network(|| async {}).await;
        assert!(t.elapsed() > Duration::from_millis(150), "pull must wait for the write mutex");
        slow_write.await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_releases_waiters_and_stops_refreshing() {
        let fake = Fake::new(Duration::from_millis(500));
        let sink = Arc::new(Sink::default());
        let a = actor("a", &fake, &sink);
        let waiter = {
            let a = a.clone();
            tokio::spawn(async move { a.snapshot().await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        a.shutdown();
        let result = tokio::time::timeout(Duration::from_secs(1), waiter).await.expect("waiter hung").unwrap();
        assert_eq!(result.unwrap_err().code, code::CANCELLED);
        a.refresh();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn set_config_changes_what_the_next_read_sees() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        let source: SnapshotFn = Arc::new(move |repo: RepoConfig| {
            s2.lock().unwrap().push(repo.name.clone());
            Box::pin(async move {
                let mut s = blank_snapshot(&repo.id);
                s.stash_count = repo.push_targets.len() as u32;
                Ok(s)
            })
        });
        let a = RepoActor::spawn(repo("a"), source, Arc::new(Sink::default()), false);
        a.refresh_wait().await;
        let mut renamed = a.config();
        renamed.name = "renamed".into();
        a.set_config(renamed);
        a.refresh_wait().await;
        assert_eq!(*seen.lock().unwrap(), vec!["a", "renamed"]);
    }
}
