//! The switch contract ((design notes: workspaces-spec) 4.10): what a module must offer so a workspace switch can ask "what is
//! running?" and "stop it", the gate that keeps new work out while a switch is under way, and the pure runner that
//! applies the per-step budgets. No Tauri types here: unit tests build everything from fakes, including time.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use intely_core::types::code;
use intely_core::{BusyItem, BusyKind, BusyReport, EngineError, Survivor, SwitchWarning};
use tauri::{AppHandle, Manager};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// ---- budgets (4.10 table) -------------------------------------------------------------------------------------------

pub const BUDGET_AGENTS: Duration = Duration::from_secs(4);
pub const BUDGET_RUNNER: Duration = Duration::from_secs(4);
pub const BUDGET_CHECKS: Duration = Duration::from_secs(1);
pub const BUDGET_TERM: Duration = Duration::from_secs(1);
pub const BUDGET_PREVIEW: Duration = Duration::from_secs(1);
pub const BUDGET_FILES: Duration = Duration::from_secs(1);
pub const BUDGET_MONGO: Duration = Duration::from_secs(1);
/// The engine swap (`Engine::switch_workspace`, SHUTDOWN_GRACE).
pub const BUDGET_ENGINE: Duration = Duration::from_secs(4);
pub const BUDGET_REGISTRY: Duration = Duration::from_secs(1);
/// Hooks that only flip state (contract caches, the Remote notice): they get one poll and no waiting.
pub const BUDGET_NONE: Duration = Duration::ZERO;

/// The whole switch has 20 s; the steps below must add up to at most this.
pub const BUDGET_TOTAL_MAX: Duration = Duration::from_secs(18);
/// A gate that was never cleared by `workspaces_ready` clears itself after this long.
pub const GATE_SELF_CLEAR: Duration = Duration::from_secs(15);

/// Hooks in teardown order with their budgets: agents first (they hold file handles in repos and spawn git), then the
/// processes that cwd into repos, then caches and connections.
pub const TEARDOWN_ORDER: [(&str, Duration); 9] = [
    ("agents", BUDGET_AGENTS),
    ("runner", BUDGET_RUNNER),
    ("checks", BUDGET_CHECKS),
    ("term", BUDGET_TERM),
    ("preview", BUDGET_PREVIEW),
    ("files", BUDGET_FILES),
    ("contract", BUDGET_NONE),
    ("mongo", BUDGET_MONGO),
    ("remote", BUDGET_NONE),
];

/// Budget of the hook called `name` (unknown names get none).
pub fn budget_for(name: &str) -> Duration {
    TEARDOWN_ORDER.iter().find(|(n, _)| *n == name).map_or(BUDGET_NONE, |(_, b)| *b)
}

/// Sum of every budget of a switch: the hooks, the engine swap and the registry write.
pub fn total_budget() -> Duration {
    TEARDOWN_ORDER.iter().map(|(_, b)| *b).sum::<Duration>() + BUDGET_ENGINE + BUDGET_REGISTRY
}

/// `<name>Stuck`, the warning code a hook that missed its budget produces (translated by the UI).
pub fn stuck_code(name: &str) -> String {
    format!("{name}Stuck")
}

// ---- the trait --------------------------------------------------------------------------------------------------------

/// Implemented by the state type of every module that owns processes, watchers, connections or caches of a workspace.
pub trait SwitchHook: Send + Sync {
    /// `"agents"`, `"runner"`, `"term"`, `"checks"`, `"preview"`, `"files"`, `"contract"`, `"mongo"`, `"remote"`.
    fn name(&self) -> &'static str;
    /// Cheap and synchronous: what `stop` would end. Labels are data (names, ids), never English sentences.
    fn busy(&self) -> Vec<BusyItem>;
    /// Ends everything `busy` reports. Idempotent (a second call is harmless) and the module stays usable afterwards.
    /// Returns warning codes only.
    fn stop(&self) -> BoxFuture<'_, Vec<SwitchWarning>>;
    /// Processes of the last `stop` that ignored the group kill and are still running.
    fn survivors(&self) -> Vec<Survivor> {
        Vec::new()
    }
    /// Ends one of [`SwitchHook::survivors`] (by pid, never an arbitrary one). `false` when the pid is not a survivor
    /// of this hook.
    fn kill_survivor(&self, _pid: u32) -> bool {
        false
    }
}

/// Splits hook reports into what blocks a switch for good (`gitRun`, `gitOp`) and what the user may confirm.
/// Empty items are dropped; `unsaved` is UI-only and never produced by Rust.
pub fn classify_busy(items: impl IntoIterator<Item = BusyItem>) -> BusyReport {
    let mut report = BusyReport { blocking: Vec::new(), confirmable: Vec::new() };
    for item in items.into_iter().filter(|i| i.count > 0) {
        match item.kind {
            BusyKind::GitRun | BusyKind::GitOp => report.blocking.push(item),
            _ => report.confirmable.push(item),
        }
    }
    report
}

// ---- time ---------------------------------------------------------------------------------------------------------------

/// Time as the switch sees it, so budgets can be tested without waiting.
pub trait Clock: Send + Sync {
    /// Milliseconds since an arbitrary start; only differences matter.
    fn now_ms(&self) -> u64;
    fn sleep(&self, d: Duration) -> BoxFuture<'static, ()>;
}

/// Wall time; sleeping uses one short-lived thread per call (a switch makes about ten), so no async timer is needed.
#[derive(Debug, Default, Clone, Copy)]
pub struct RealClock;

struct ThreadSleep {
    d: Duration,
    started: bool,
    shared: Arc<Mutex<(bool, Option<Waker>)>>,
}

impl Future for ThreadSleep {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let shared = self.shared.clone();
        {
            let mut g = shared.lock().expect("sleep state");
            if g.0 {
                return Poll::Ready(());
            }
            g.1 = Some(cx.waker().clone());
        }
        if !self.started {
            self.started = true;
            let (d, shared) = (self.d, self.shared.clone());
            std::thread::spawn(move || {
                std::thread::sleep(d);
                let mut g = shared.lock().expect("sleep state");
                g.0 = true;
                if let Some(w) = g.1.take() {
                    w.wake();
                }
            });
        }
        Poll::Pending
    }
}

impl Clock for RealClock {
    fn now_ms(&self) -> u64 {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64
    }

    fn sleep(&self, d: Duration) -> BoxFuture<'static, ()> {
        Box::pin(ThreadSleep { d, started: false, shared: Arc::new(Mutex::new((false, None))) })
    }
}

// ---- the gate -----------------------------------------------------------------------------------------------------------

/// Set from the first teardown step until the freshly booted page calls `workspaces_ready` (4.9). While set, every
/// entry point that spawns a process or starts a run calls [`SwitchGate::check`] and fails with `workspaceSwitching`.
/// A gate nobody clears (the page never booted) clears itself after [`GATE_SELF_CLEAR`].
pub struct SwitchGate {
    clock: Arc<dyn Clock>,
    /// `now_ms` at which the gate was set; `u64::MAX` = not set.
    set_at: AtomicU64,
}

const UNSET: u64 = u64::MAX;

impl SwitchGate {
    pub fn new(clock: Arc<dyn Clock>) -> Arc<Self> {
        Arc::new(Self { clock, set_at: AtomicU64::new(UNSET) })
    }

    pub fn real() -> Arc<Self> {
        Self::new(Arc::new(RealClock))
    }

    /// Sets the gate. The guard clears it again when dropped, unless [`GateGuard::hold`] is called: a switch that fails
    /// before it started tearing anything down must not leave the app locked.
    pub fn set(self: &Arc<Self>) -> GateGuard {
        self.set_at.store(self.clock.now_ms(), Ordering::SeqCst);
        GateGuard { gate: self.clone(), armed: true }
    }

    /// `workspaces_ready`.
    pub fn clear(&self) {
        self.set_at.store(UNSET, Ordering::SeqCst);
    }

    pub fn is_set(&self) -> bool {
        let at = self.set_at.load(Ordering::SeqCst);
        if at == UNSET {
            return false;
        }
        if self.clock.now_ms().saturating_sub(at) >= GATE_SELF_CLEAR.as_millis() as u64 {
            // only the thread that observes the expiry clears it; a concurrent `set` keeps its newer stamp
            let _ = self.set_at.compare_exchange(at, UNSET, Ordering::SeqCst, Ordering::SeqCst);
            return self.set_at.load(Ordering::SeqCst) != UNSET;
        }
        true
    }

    pub fn check(&self) -> Result<(), EngineError> {
        if self.is_set() {
            Err(EngineError::new(code::WORKSPACE_SWITCHING, "a workspace switch is in progress"))
        } else {
            Ok(())
        }
    }
}

pub struct GateGuard {
    gate: Arc<SwitchGate>,
    armed: bool,
}

impl GateGuard {
    /// The switch went past the point of no return: the gate stays set until `workspaces_ready` or the timeout.
    pub fn hold(mut self) {
        self.armed = false;
    }
}

impl Drop for GateGuard {
    fn drop(&mut self) {
        if self.armed {
            self.gate.clear();
        }
    }
}

// ---- the runner ----------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepReport {
    pub name: &'static str,
    pub budget: Duration,
    pub elapsed: Duration,
    pub timed_out: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TeardownReport {
    pub steps: Vec<StepReport>,
    pub warnings: Vec<SwitchWarning>,
}

/// Runs `fut` for at most `budget`. A budget of zero gives it exactly one poll. The future wins ties.
async fn with_budget<T>(clock: &dyn Clock, budget: Duration, mut fut: BoxFuture<'_, T>) -> Option<T> {
    if budget.is_zero() {
        return std::future::poll_fn(|cx| match fut.as_mut().poll(cx) {
            Poll::Ready(v) => Poll::Ready(Some(v)),
            Poll::Pending => Poll::Ready(None),
        })
        .await;
    }
    let mut timer = clock.sleep(budget);
    std::future::poll_fn(|cx| {
        if let Poll::Ready(v) = fut.as_mut().poll(cx) {
            return Poll::Ready(Some(v));
        }
        if timer.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        Poll::Pending
    })
    .await
}

/// Stops the hooks one after the other, each under its own budget. A hook that does not finish in time adds the
/// warning `<name>Stuck` and the sequence continues (a stuck dev server must not trap the user); its leftovers are the
/// process-group cleanup's business. Warnings a hook returns are kept in order.
pub async fn run_teardown(hooks: &[(Arc<dyn SwitchHook>, Duration)], clock: &dyn Clock) -> TeardownReport {
    let mut report = TeardownReport::default();
    for (hook, budget) in hooks {
        let started = clock.now_ms();
        let outcome = with_budget(clock, *budget, hook.stop()).await;
        let elapsed = Duration::from_millis(clock.now_ms().saturating_sub(started));
        let name = hook.name();
        match outcome {
            Some(mut warnings) => {
                report.warnings.append(&mut warnings);
                report.steps.push(StepReport { name, budget: *budget, elapsed, timed_out: false });
            }
            None => {
                report.warnings.push(SwitchWarning { code: stuck_code(name), subsystem: name.to_owned() });
                report.steps.push(StepReport { name, budget: *budget, elapsed, timed_out: true });
            }
        }
    }
    report
}

/// Hooks paired with their budgets from [`TEARDOWN_ORDER`], in that order; hooks not in the table go last with no budget.
pub fn ordered(hooks: &[Arc<dyn SwitchHook>]) -> Vec<(Arc<dyn SwitchHook>, Duration)> {
    let mut out = Vec::new();
    for (name, budget) in TEARDOWN_ORDER {
        out.extend(hooks.iter().filter(|h| h.name() == name).map(|h| (h.clone(), budget)));
    }
    out.extend(hooks.iter().filter(|h| !TEARDOWN_ORDER.iter().any(|(n, _)| *n == h.name())).map(|h| (h.clone(), BUDGET_NONE)));
    out
}

/// Everything the hooks report as busy, split into blocking and confirmable.
pub fn busy_report(hooks: &[Arc<dyn SwitchHook>]) -> BusyReport {
    classify_busy(hooks.iter().flat_map(|h| h.busy()))
}

// ---- helpers shared by the module hooks ----------------------------------------------------------------------------------

/// The gate of the running app, if the workspace module registered one (it does not in the spike modes).
pub fn gate_of(app: &AppHandle) -> Option<Arc<SwitchGate>> {
    app.try_state::<Arc<SwitchGate>>().map(|g| g.inner().clone())
}

/// Called first by every entry point that starts a process, a watcher or a run.
pub fn gate_check(app: &AppHandle) -> Result<(), EngineError> {
    match gate_of(app) {
        Some(g) => g.check(),
        None => Ok(()),
    }
}

/// [`gate_check`] for code that has no `AppHandle` (and for tests).
pub fn check_optional(gate: Option<&SwitchGate>) -> Result<(), EngineError> {
    gate.map_or(Ok(()), SwitchGate::check)
}

/// Whether any process of the group `pgid` exists (`kill -0 -- -pgid`).
pub fn group_alive(pgid: i32) -> bool {
    pgid > 1
        && std::process::Command::new("/bin/kill")
            .args(["-0", "--"])
            .arg(format!("-{pgid}"))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
}

/// SIGKILL to the whole group. Never `pgid <= 1`.
pub fn kill_group(pgid: i32) {
    if pgid > 1 {
        let _ = std::process::Command::new("/bin/kill")
            .args(["-KILL", "--"])
            .arg(format!("-{pgid}"))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// Polls `cond` every `poll` for at most `limit`; `true` when it held.
pub fn wait_until(limit: Duration, poll: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let start = std::time::Instant::now();
    loop {
        if cond() {
            return true;
        }
        if start.elapsed() >= limit {
            return false;
        }
        std::thread::sleep(poll);
    }
}

/// Runs blocking work off the async threads; `None` when the task panicked.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tauri::async_runtime::spawn_blocking(f).await.ok()
}

/// Who the open workspace is, for modules that stamp or filter their data by workspace (the Night queue). The workspace
/// module registers an `Arc<dyn ActiveWorkspace>` as managed state; without one (the spike modes) nothing is filtered.
pub trait ActiveWorkspace: Send + Sync {
    /// The id of the open workspace, `None` while none is open.
    fn active_id(&self) -> Option<String>;
}

/// `None` when no workspace module is registered or no workspace is open.
pub fn active_workspace_id(app: &AppHandle) -> Option<String> {
    app.try_state::<Arc<dyn ActiveWorkspace>>().and_then(|a| a.active_id())
}

/// Whether a workspace module is registered at all (without one, nothing is stamped or filtered).
pub fn has_workspaces(app: &AppHandle) -> bool {
    app.try_state::<Arc<dyn ActiveWorkspace>>().is_some()
}

/// The refusal point of every mutating git operation outside the engine (graph rebase, cherry-pick, branch operations,
/// `gh pr create`): the gate first (it is set before the first teardown step), then the engine's own guard, which a
/// switch counts as a blocking `gitOp`. Keep the returned guard alive for the whole operation.
pub fn begin_mutation(app: &AppHandle, engine: &intely_core::Engine, kind: &'static str) -> Result<intely_core::MutationGuard, EngineError> {
    begin_mutation_with(gate_of(app).as_deref(), engine, kind)
}

/// [`begin_mutation`] without an `AppHandle`.
pub fn begin_mutation_with(gate: Option<&SwitchGate>, engine: &intely_core::Engine, kind: &'static str) -> Result<intely_core::MutationGuard, EngineError> {
    check_optional(gate)?;
    engine.mutation_guard(kind)
}

/// The engine's busy report as the switch dialog wants it: git runs and held guards, both blocking.
pub fn engine_busy_items(b: &intely_core::EngineBusy) -> Vec<BusyItem> {
    let mut out = Vec::new();
    if !b.runs.is_empty() {
        out.push(BusyItem { kind: BusyKind::GitRun, count: b.runs.len() as u32, labels: b.runs.iter().map(|(id, _)| id.clone()).collect() });
    }
    if !b.guards.is_empty() {
        out.push(BusyItem { kind: BusyKind::GitOp, count: b.guards.len() as u32, labels: b.guards.iter().map(|g| (*g).to_owned()).collect() });
    }
    out
}

/// A warning with the `<name>Stuck` code.
pub fn stuck(name: &str) -> SwitchWarning {
    SwitchWarning { code: stuck_code(name), subsystem: name.to_owned() }
}

/// Survivors of every hook.
pub fn collect_survivors(hooks: &[Arc<dyn SwitchHook>]) -> Vec<Survivor> {
    hooks.iter().flat_map(|h| h.survivors()).collect()
}

// ---- test support (also for the orchestrator's tests) ---------------------------------------------------------------------

#[cfg(test)]
pub mod testing {
    use std::sync::atomic::AtomicBool;

    use super::*;

    struct Timer {
        deadline: u64,
        fired: Arc<AtomicBool>,
        waker: Option<Waker>,
    }

    /// Virtual time: `sleep` completes only when [`FakeClock::advance_to_next`] reaches its deadline.
    #[derive(Default)]
    pub struct FakeClock {
        now: AtomicU64,
        timers: Mutex<Vec<Timer>>,
    }

    struct FakeSleep {
        clock: Arc<FakeClock>,
        deadline: u64,
        fired: Arc<AtomicBool>,
        registered: bool,
    }

    impl Future for FakeSleep {
        type Output = ();
        fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
            if self.clock.now.load(Ordering::SeqCst) >= self.deadline || self.fired.load(Ordering::SeqCst) {
                return Poll::Ready(());
            }
            let mut timers = self.clock.timers.lock().expect("timers");
            if !self.registered {
                timers.push(Timer { deadline: self.deadline, fired: self.fired.clone(), waker: Some(cx.waker().clone()) });
                drop(timers);
                self.registered = true;
            } else if let Some(t) = timers.iter_mut().find(|t| Arc::ptr_eq(&t.fired, &self.fired)) {
                t.waker = Some(cx.waker().clone());
            }
            Poll::Pending
        }
    }

    impl FakeClock {
        pub fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        pub fn advance(&self, d: Duration) {
            self.now.fetch_add(d.as_millis() as u64, Ordering::SeqCst);
            self.fire_due();
        }

        fn fire_due(&self) {
            let now = self.now.load(Ordering::SeqCst);
            let mut timers = self.timers.lock().expect("timers");
            for t in timers.iter_mut().filter(|t| t.deadline <= now && !t.fired.load(Ordering::SeqCst)) {
                t.fired.store(true, Ordering::SeqCst);
                if let Some(w) = t.waker.take() {
                    w.wake();
                }
            }
            timers.retain(|t| !t.fired.load(Ordering::SeqCst));
        }

        /// Jumps to the earliest pending deadline and fires it. `false` when nothing waits on the clock.
        pub fn advance_to_next(&self) -> bool {
            let next = self.timers.lock().expect("timers").iter().filter(|t| !t.fired.load(Ordering::SeqCst)).map(|t| t.deadline).min();
            match next {
                Some(d) => {
                    let now = self.now.load(Ordering::SeqCst);
                    self.now.store(d.max(now), Ordering::SeqCst);
                    self.fire_due();
                    true
                }
                None => false,
            }
        }
    }

    impl Clock for Arc<FakeClock> {
        fn now_ms(&self) -> u64 {
            self.now.load(Ordering::SeqCst)
        }

        fn sleep(&self, d: Duration) -> BoxFuture<'static, ()> {
            let deadline = self.now.load(Ordering::SeqCst) + d.as_millis() as u64;
            Box::pin(FakeSleep { clock: self.clone(), deadline, fired: Arc::new(AtomicBool::new(false)), registered: false })
        }
    }

    /// Polls `fut` to completion on this thread, moving virtual time to the next deadline whenever it is pending.
    pub fn block_on_virtual<F: Future>(clock: &Arc<FakeClock>, fut: F) -> F::Output {
        let mut fut = Box::pin(fut);
        let mut cx = Context::from_waker(Waker::noop());
        loop {
            if let Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
                return v;
            }
            assert!(clock.advance_to_next(), "deadlock: the future waits for something other than the fake clock");
        }
    }

    /// A scripted hook: records `stop` calls into `log`, optionally takes `delay` of virtual time and returns `warnings`.
    pub struct FakeHook {
        pub name: &'static str,
        pub clock: Arc<FakeClock>,
        pub delay: Duration,
        pub warnings: Vec<SwitchWarning>,
        pub busy: Mutex<Vec<BusyItem>>,
        pub log: Arc<Mutex<Vec<String>>>,
    }

    impl FakeHook {
        pub fn new(name: &'static str, clock: &Arc<FakeClock>, log: &Arc<Mutex<Vec<String>>>) -> Arc<Self> {
            Arc::new(Self { name, clock: clock.clone(), delay: Duration::ZERO, warnings: Vec::new(), busy: Mutex::new(Vec::new()), log: log.clone() })
        }
    }

    impl SwitchHook for FakeHook {
        fn name(&self) -> &'static str {
            self.name
        }

        fn busy(&self) -> Vec<BusyItem> {
            self.busy.lock().expect("busy").clone()
        }

        fn stop(&self) -> BoxFuture<'_, Vec<SwitchWarning>> {
            Box::pin(async move {
                self.log.lock().expect("log").push(format!("start {}", self.name));
                if !self.delay.is_zero() {
                    self.clock.sleep(self.delay).await;
                }
                self.log.lock().expect("log").push(format!("end {}", self.name));
                // idempotent: whatever was busy is gone after the first stop
                self.busy.lock().expect("busy").clear();
                self.warnings.clone()
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    fn item(kind: BusyKind, count: u32) -> BusyItem {
        BusyItem { kind, count, labels: vec![] }
    }

    fn log() -> Arc<Mutex<Vec<String>>> {
        Arc::new(Mutex::new(Vec::new()))
    }

    fn hooks_in_order(clock: &Arc<FakeClock>, log: &Arc<Mutex<Vec<String>>>, tweak: impl Fn(&mut FakeHook)) -> Vec<Arc<dyn SwitchHook>> {
        TEARDOWN_ORDER
            .iter()
            .map(|(n, _)| {
                let mut h = Arc::try_unwrap(FakeHook::new(n, clock, log)).ok().expect("fresh");
                tweak(&mut h);
                Arc::new(h) as Arc<dyn SwitchHook>
            })
            .collect()
    }

    #[test]
    fn budgets_add_up_to_the_documented_total() {
        assert_eq!(total_budget(), BUDGET_TOTAL_MAX, "agents 4 + runner 4 + checks/term/preview/files/mongo 1 each + engine 4 + registry 1");
        assert!(total_budget() <= Duration::from_secs(18));
        assert_eq!(budget_for("runner"), BUDGET_RUNNER);
        assert_eq!(budget_for("nope"), Duration::ZERO);
        assert_eq!(stuck_code("runner"), "runnerStuck");
        for (n, _) in TEARDOWN_ORDER {
            assert!(["agents", "runner", "checks", "term", "preview", "files", "contract", "mongo", "remote"].contains(&n));
        }
    }

    #[test]
    fn hooks_run_in_the_documented_order_regardless_of_registration_order() {
        let clock = FakeClock::new();
        let log = log();
        let mut hooks = hooks_in_order(&clock, &log, |_| {});
        hooks.reverse();
        let plan = ordered(&hooks);
        assert_eq!(plan.iter().map(|(h, _)| h.name()).collect::<Vec<_>>(), TEARDOWN_ORDER.iter().map(|(n, _)| *n).collect::<Vec<_>>());
        let report = block_on_virtual(&clock, async { run_teardown(&plan, &clock).await });
        let started: Vec<_> = log.lock().unwrap().iter().filter_map(|l| l.strip_prefix("start ").map(str::to_owned)).collect();
        assert_eq!(started, TEARDOWN_ORDER.iter().map(|(n, _)| (*n).to_owned()).collect::<Vec<_>>());
        assert!(report.warnings.is_empty());
        assert!(report.steps.iter().all(|s| !s.timed_out && s.elapsed.is_zero()));
        assert_eq!(report.steps.iter().map(|s| s.budget).sum::<Duration>(), TEARDOWN_ORDER.iter().map(|(_, b)| *b).sum::<Duration>());
    }

    #[test]
    fn a_hook_past_its_budget_becomes_a_warning_and_the_sequence_continues() {
        let clock = FakeClock::new();
        let log = log();
        let hooks = hooks_in_order(&clock, &log, |h| {
            if h.name == "runner" {
                h.delay = Duration::from_secs(60);
            }
            if h.name == "term" {
                h.delay = Duration::from_millis(900); // inside its 1 s budget
            }
        });
        let plan = ordered(&hooks);
        let report = block_on_virtual(&clock, async { run_teardown(&plan, &clock).await });
        assert_eq!(report.warnings, vec![SwitchWarning { code: "runnerStuck".into(), subsystem: "runner".into() }]);
        let runner = report.steps.iter().find(|s| s.name == "runner").unwrap();
        assert!(runner.timed_out);
        assert_eq!(runner.elapsed, BUDGET_RUNNER, "the overrun is cut at the budget, not at 60 s");
        let term = report.steps.iter().find(|s| s.name == "term").unwrap();
        assert!(!term.timed_out && term.elapsed == Duration::from_millis(900));
        // everything after the stuck hook still ran
        let ended: Vec<String> = log.lock().unwrap().iter().filter_map(|l| l.strip_prefix("end ").map(str::to_owned)).collect();
        assert!(!ended.contains(&"runner".to_owned()));
        for n in ["checks", "term", "preview", "files", "contract", "mongo", "remote"] {
            assert!(ended.contains(&n.to_owned()), "{n} did not run");
        }
        assert!(report.steps.iter().map(|s| s.elapsed).sum::<Duration>() <= BUDGET_TOTAL_MAX);
    }

    #[test]
    fn warnings_returned_by_a_hook_are_kept_in_order_and_stop_twice_is_harmless() {
        let clock = FakeClock::new();
        let log = log();
        let hooks = hooks_in_order(&clock, &log, |h| {
            if h.name == "files" {
                h.warnings = vec![SwitchWarning { code: "filesStuck".into(), subsystem: "files".into() }];
            }
            if h.name == "agents" {
                h.busy = Mutex::new(vec![item(BusyKind::Agent, 2)]);
            }
        });
        assert_eq!(busy_report(&hooks).confirmable, vec![item(BusyKind::Agent, 2)]);
        let plan = ordered(&hooks);
        let first = block_on_virtual(&clock, async { run_teardown(&plan, &clock).await });
        assert_eq!(first.warnings.len(), 1);
        assert_eq!(busy_report(&hooks), BusyReport { blocking: vec![], confirmable: vec![] }, "stop ended what was busy");
        let second = block_on_virtual(&clock, async { run_teardown(&plan, &clock).await });
        assert_eq!(second.steps.len(), plan.len());
        assert!(second.steps.iter().all(|s| !s.timed_out));
    }

    #[test]
    fn a_zero_budget_hook_gets_one_poll_and_no_waiting() {
        let clock = FakeClock::new();
        let log = log();
        let quick = FakeHook::new("contract", &clock, &log);
        let mut slow = Arc::try_unwrap(FakeHook::new("remote", &clock, &log)).ok().unwrap();
        slow.delay = Duration::from_secs(1);
        let plan: Vec<(Arc<dyn SwitchHook>, Duration)> = vec![(quick, Duration::ZERO), (Arc::new(slow), Duration::ZERO)];
        let report = block_on_virtual(&clock, async { run_teardown(&plan, &clock).await });
        assert!(!report.steps[0].timed_out);
        assert!(report.steps[1].timed_out);
        assert_eq!(report.warnings[0].code, "remoteStuck");
    }

    #[test]
    fn busy_items_split_into_blocking_and_confirmable() {
        let r = classify_busy([
            item(BusyKind::GitRun, 1),
            item(BusyKind::GitOp, 2),
            item(BusyKind::Agent, 3),
            item(BusyKind::DevServer, 1),
            item(BusyKind::Terminal, 0),
            item(BusyKind::Mongo, 1),
        ]);
        assert_eq!(r.blocking.iter().map(|i| i.kind.clone()).collect::<Vec<_>>(), vec![BusyKind::GitRun, BusyKind::GitOp]);
        assert_eq!(r.confirmable.iter().map(|i| i.kind.clone()).collect::<Vec<_>>(), vec![BusyKind::Agent, BusyKind::DevServer, BusyKind::Mongo]);
    }

    #[test]
    fn the_gate_refuses_while_set_and_clears_on_ready_or_after_fifteen_seconds() {
        let clock = FakeClock::new();
        let gate = SwitchGate::new(Arc::new(clock.clone()));
        assert!(gate.check().is_ok());
        let guard = gate.set();
        let e = gate.check().unwrap_err();
        assert_eq!(e.code, code::WORKSPACE_SWITCHING);
        guard.hold();
        clock.advance(Duration::from_secs(14));
        assert!(gate.is_set(), "still set at 14 s");
        clock.advance(Duration::from_secs(1));
        assert!(!gate.is_set() && gate.check().is_ok(), "self-cleared at 15 s");
        // ready clears it at once
        let g = gate.set();
        g.hold();
        assert!(gate.is_set());
        gate.clear();
        assert!(gate.check().is_ok());
        // setting again restarts the 15 s
        let g = gate.set();
        g.hold();
        clock.advance(Duration::from_secs(10));
        let g = gate.set();
        g.hold();
        clock.advance(Duration::from_secs(10));
        assert!(gate.is_set(), "10 s after the second set");
    }

    #[test]
    fn a_dropped_guard_clears_the_gate_unless_it_was_held() {
        let clock = FakeClock::new();
        let gate = SwitchGate::new(Arc::new(clock.clone()));
        {
            let _g = gate.set();
            assert!(gate.is_set());
        }
        assert!(!gate.is_set(), "a switch that failed before teardown must not lock the app");
        gate.set().hold();
        assert!(gate.is_set());
    }

    struct NoSink;
    impl intely_core::EventSink for NoSink {
        fn snapshot(&self, _: intely_core::RepoSnapshot) {}
        fn op_event(&self, _: intely_core::OpEvent) {}
        fn op_result(&self, _: intely_core::OpResult) {}
        fn env(&self, _: intely_core::EnvStatus) {}
    }

    #[test]
    fn a_held_mutation_guard_shows_as_a_blocking_git_op_and_the_gate_refuses_new_ones() {
        use intely_core::Engine;
        let clock = testing::FakeClock::new();
        let gate = SwitchGate::new(Arc::new(clock));
        let engine = tauri::async_runtime::block_on(async { Engine::new_detached_with_jail(Arc::new(NoSink), Arc::new(intely_core::jail::Jail::off())) });

        assert!(engine_busy_items(&engine.busy()).is_empty());
        let guard = begin_mutation_with(Some(&gate), &engine, "rebase").unwrap();
        let report = classify_busy(engine_busy_items(&engine.busy()));
        assert_eq!(report.blocking, vec![BusyItem { kind: BusyKind::GitOp, count: 1, labels: vec!["rebase".into()] }]);
        assert!(report.confirmable.is_empty(), "a git operation cannot be confirmed away");

        // the switch has begun: the gate is set before the first teardown step
        gate.set().hold();
        let refused = begin_mutation_with(Some(&gate), &engine, "cherryPick").err().unwrap();
        assert_eq!(refused.code, code::WORKSPACE_SWITCHING);
        assert_eq!(engine.busy().guards, vec!["rebase"], "the refused one never counted");
        drop(guard);
        assert!(engine_busy_items(&engine.busy()).is_empty());

        // without a gate (spike modes) only the engine's own flag matters
        let ticket = engine.begin_switch().unwrap();
        assert_eq!(begin_mutation_with(None, &engine, "x").err().unwrap().code, code::WORKSPACE_SWITCHING);
        drop(ticket);
        assert!(begin_mutation_with(None, &engine, "x").is_ok());
    }

    #[test]
    fn the_real_clock_sleeps_and_wakes() {
        let t = std::time::Instant::now();
        let clock = RealClock;
        tauri::async_runtime::block_on(async { clock.sleep(Duration::from_millis(40)).await });
        assert!(t.elapsed() >= Duration::from_millis(35) && t.elapsed() < Duration::from_secs(5));
        let a = clock.now_ms();
        assert!(clock.now_ms() >= a);
    }

    #[test]
    fn the_real_runner_cuts_a_hook_that_never_finishes() {
        struct Never;
        impl SwitchHook for Never {
            fn name(&self) -> &'static str {
                "runner"
            }
            fn busy(&self) -> Vec<BusyItem> {
                vec![]
            }
            fn stop(&self) -> BoxFuture<'_, Vec<SwitchWarning>> {
                Box::pin(std::future::pending())
            }
        }
        let plan: Vec<(Arc<dyn SwitchHook>, Duration)> = vec![(Arc::new(Never), Duration::from_millis(60))];
        let t = std::time::Instant::now();
        let report = tauri::async_runtime::block_on(async { run_teardown(&plan, &RealClock).await });
        assert_eq!(report.warnings[0].code, "runnerStuck");
        assert!(t.elapsed() < Duration::from_secs(5));
    }
}
