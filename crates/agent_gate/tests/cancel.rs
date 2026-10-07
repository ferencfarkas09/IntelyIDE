//! Cancel protocol: soft interrupt window, SIGTERM, SIGKILL, exactly one turn.end, pending permissions cancelled.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::Group;
use intely_agent_gate::gate::cancel::{self, CancelMachine, CancelPhase, CancelPlan, CancelSink, CancelTracker, Step};
use intely_agent_gate::{AcquireReq, Gate, GateConfig};

/// Records what the adapter side was asked to do, and when.
struct FakeAgent {
    t0: Instant,
    tracker: Arc<CancelTracker>,
    log: Mutex<Vec<(String, Duration)>>,
    turn_ends: Arc<AtomicUsize>,
    /// Simulates an adapter that honours `interrupt()` after this delay by ending its turn itself.
    obey_after: Option<Duration>,
}

impl FakeAgent {
    fn new(tracker: Arc<CancelTracker>, obey_after: Option<Duration>) -> Arc<Self> {
        Arc::new(Self { t0: Instant::now(), tracker, log: Mutex::new(Vec::new()), turn_ends: Arc::new(AtomicUsize::new(0)), obey_after })
    }

    fn note(&self, what: impl Into<String>) {
        self.log.lock().unwrap().push((what.into(), self.t0.elapsed()));
    }

    fn events(&self) -> Vec<String> {
        self.log.lock().unwrap().iter().map(|(w, _)| w.clone()).collect()
    }
}

impl CancelSink for FakeAgent {
    fn interrupt(&self) {
        self.note("interrupt");
        if let Some(delay) = self.obey_after {
            let (tracker, turn_ends) = (self.tracker.clone(), self.turn_ends.clone());
            // the adapter's own turn.end arrives asynchronously, through the event path
            std::thread::spawn(move || {
                std::thread::sleep(delay);
                turn_ends.fetch_add(1, Ordering::SeqCst);
                tracker.mark_turn_end();
            });
        }
    }

    fn cancel_permissions(&self, ids: &[String]) {
        self.note(format!("permissions:{}", ids.join(",")));
    }

    fn cancel_tools(&self, ids: &[String]) {
        self.note(format!("tools:{}", ids.join(",")));
    }

    fn turn_end(&self) {
        self.turn_ends.fetch_add(1, Ordering::SeqCst);
        self.note("turn.end");
    }
}

fn plan(soft_ms: u64, term_ms: u64) -> CancelPlan {
    CancelPlan { soft: Duration::from_millis(soft_ms), term: Duration::from_millis(term_ms) }
}

fn req(agent: &str) -> AcquireReq {
    AcquireReq {
        agent_id: agent.into(),
        provider: "claude".into(),
        writer: true,
        repo_id: Some("admin".into()),
        owner: "sidecar-1".into(),
        ttl_ms: Some(60_000),
        rss_budget_mb: 0,
    }
}

fn tracker_with_pending() -> Arc<CancelTracker> {
    let t = Arc::new(CancelTracker::default());
    t.permission_asked("p1");
    t.permission_asked("p2");
    t.permission_answered("p2");
    t.tool_started("t1");
    t.tool_started("t2");
    t.tool_finished("t2");
    t
}

#[test]
fn an_obedient_adapter_ends_the_turn_in_the_soft_window_and_nothing_is_killed() {
    let gate = Gate::new(GateConfig::default());
    let lease = gate.acquire(req("a1")).unwrap();
    let group = Group::sleeper();
    gate.renew(&lease.lease_id, &[group.pgid()]).unwrap();
    let tracker = tracker_with_pending();
    let agent = FakeAgent::new(tracker.clone(), Some(Duration::from_millis(100)));

    let report = cancel::run(gate.clone(), lease.lease_id.clone(), plan(1500, 1000), agent.clone(), tracker).join().unwrap();
    assert_eq!(report.stage, "soft");
    assert!(report.sigterm_after_ms.is_none() && report.sigkill_after_ms.is_none());
    assert!(!report.turn_end_synthesized);
    assert_eq!(agent.turn_ends.load(Ordering::SeqCst), 1, "exactly one turn.end: the adapter's own");
    assert_eq!(agent.events(), ["interrupt", "permissions:p1", "tools:t1"]);
    assert!(group.alive(), "the CLI stays up for the next turn");
    assert!(gate.has_lease(&lease.lease_id), "and keeps its lease");
    assert!(!report.lease_released);
    assert!(report.done_after_ms < 1000, "{report:?}");
}

#[test]
fn an_adapter_that_ignores_interrupt_gets_sigterm_after_the_soft_window() {
    let gate = Gate::new(GateConfig::default());
    let lease = gate.acquire(req("a1")).unwrap();
    let mut group = Group::with_grandchildren();
    gate.renew(&lease.lease_id, &[group.pgid()]).unwrap();
    let tracker = tracker_with_pending();
    let agent = FakeAgent::new(tracker.clone(), None);

    let report = cancel::run(gate.clone(), lease.lease_id.clone(), plan(400, 1500), agent.clone(), tracker).join().unwrap();
    assert_eq!(report.stage, "term");
    let term = report.sigterm_after_ms.unwrap();
    assert!((400..700).contains(&term), "SIGTERM at the end of the soft window: {report:?}");
    assert!(report.sigkill_after_ms.is_none());
    assert!(report.turn_end_synthesized);
    assert_eq!(agent.turn_ends.load(Ordering::SeqCst), 1);
    assert_eq!(agent.events(), ["interrupt", "permissions:p1", "tools:t1", "turn.end"]);
    assert!(group.gone_within(Duration::from_secs(1)), "leader and grandchildren are gone");
    assert!(report.lease_released && !gate.has_lease(&lease.lease_id));
    assert_eq!((report.permissions_cancelled, report.tools_cancelled), (1, 1));
}

#[test]
fn a_group_that_ignores_sigterm_is_killed_after_the_term_grace() {
    let gate = Gate::new(GateConfig::default());
    let lease = gate.acquire(req("a1")).unwrap();
    let mut group = Group::stubborn();
    gate.renew(&lease.lease_id, &[group.pgid()]).unwrap();
    std::thread::sleep(Duration::from_millis(250)); // trap installed
    let tracker = Arc::new(CancelTracker::default());
    let agent = FakeAgent::new(tracker.clone(), None);

    let report = cancel::run(gate.clone(), lease.lease_id.clone(), plan(300, 600), agent.clone(), tracker).join().unwrap();
    assert_eq!(report.stage, "kill");
    let (term, kill) = (report.sigterm_after_ms.unwrap(), report.sigkill_after_ms.unwrap());
    assert!((300..550).contains(&term), "{report:?}");
    assert!((term + 600..term + 900).contains(&kill), "SIGKILL one term-grace after SIGTERM: {report:?}");
    assert!(group.gone_within(Duration::from_secs(2)));
    assert_eq!(agent.turn_ends.load(Ordering::SeqCst), 1);
    assert!(report.lease_released);
}

#[test]
fn default_timings_are_sigterm_at_5s_and_sigkill_at_8s() {
    let gate = Gate::new(GateConfig::default());
    let lease = gate.acquire(req("a1")).unwrap();
    let mut group = Group::stubborn();
    gate.renew(&lease.lease_id, &[group.pgid()]).unwrap();
    std::thread::sleep(Duration::from_millis(250));
    let tracker = Arc::new(CancelTracker::default());
    let agent = FakeAgent::new(tracker.clone(), None);

    let report = cancel::run(gate.clone(), lease.lease_id.clone(), CancelPlan::default(), agent.clone(), tracker).join().unwrap();
    let (term, kill) = (report.sigterm_after_ms.unwrap(), report.sigkill_after_ms.unwrap());
    assert!((5000..5400).contains(&term), "{report:?}");
    assert!((8000..8500).contains(&kill), "{report:?}");
    assert!(group.gone_within(Duration::from_secs(2)), "no process left");
    assert_eq!(agent.turn_ends.load(Ordering::SeqCst), 1);
    assert!(gate.live_count() == 0);
}

#[test]
fn an_adapter_turn_end_after_sigterm_is_the_single_one() {
    let gate = Gate::new(GateConfig::default());
    let lease = gate.acquire(req("a1")).unwrap();
    // the group ignores SIGTERM but the adapter reports its turn.end during the term window
    let mut group = Group::stubborn();
    gate.renew(&lease.lease_id, &[group.pgid()]).unwrap();
    std::thread::sleep(Duration::from_millis(250));
    let tracker = Arc::new(CancelTracker::default());
    let agent = FakeAgent::new(tracker.clone(), None);
    let late = tracker.clone();
    let job = cancel::run(gate.clone(), lease.lease_id.clone(), plan(200, 500), agent.clone(), tracker);
    std::thread::sleep(Duration::from_millis(350));
    agent.turn_ends.fetch_add(1, Ordering::SeqCst); // the adapter's own turn.end
    late.mark_turn_end();
    let report = job.join().unwrap();
    assert!(!report.turn_end_synthesized, "the adapter already produced it");
    assert_eq!(agent.turn_ends.load(Ordering::SeqCst), 1, "still exactly one");
    assert!(!agent.events().contains(&"turn.end".to_string()));
    assert!(group.gone_within(Duration::from_secs(2)));
}

#[test]
fn a_lease_without_processes_still_ends_cleanly_with_one_turn_end() {
    let gate = Gate::new(GateConfig::default());
    let lease = gate.acquire(req("a1")).unwrap();
    let tracker = Arc::new(CancelTracker::default());
    let agent = FakeAgent::new(tracker.clone(), None);
    let report = cancel::run(gate.clone(), lease.lease_id.clone(), plan(100, 100), agent.clone(), tracker).join().unwrap();
    assert!(report.turn_end_synthesized);
    assert_eq!(agent.turn_ends.load(Ordering::SeqCst), 1);
    assert!(report.lease_released);
}

#[test]
fn the_machine_is_deterministic_on_a_fake_clock() {
    let t0 = Instant::now();
    let at = |ms| t0 + Duration::from_millis(ms);
    let (mut m, first) = CancelMachine::start(CancelPlan::default(), t0);
    assert_eq!(first, vec![Step::Interrupt]);
    assert_eq!(m.phase(), CancelPhase::Soft);
    assert!(m.tick(at(4999), true).is_empty());
    assert_eq!(m.tick(at(5000), true), vec![Step::Sigterm]);
    assert_eq!(m.phase(), CancelPhase::Terminating);
    assert!(m.tick(at(7999), true).is_empty());
    assert_eq!(m.tick(at(8000), true), vec![Step::Sigkill]);
    assert_eq!(m.phase(), CancelPhase::Killing);
    assert_eq!(m.tick(at(8100), false), vec![Step::Finish { synthesize_turn_end: true }]);
    assert_eq!(m.phase(), CancelPhase::Done);
    assert!(m.tick(at(9000), false).is_empty(), "finished machines stay quiet");
    assert!(m.turn_ended().is_empty(), "a late turn.end after the synthesized one is dropped");

    // the group exits on SIGTERM: no SIGKILL, still one turn.end
    let (mut m, _) = CancelMachine::start(CancelPlan::default(), t0);
    m.tick(at(5000), true);
    assert_eq!(m.tick(at(5200), false), vec![Step::Finish { synthesize_turn_end: true }]);

    // the adapter ends its turn in the soft window: nothing is signalled and nothing is synthesized
    let (mut m, _) = CancelMachine::start(CancelPlan::default(), t0);
    assert_eq!(m.turn_ended(), vec![Step::Finish { synthesize_turn_end: false }]);
    assert!(m.tick(at(6000), true).is_empty());

    // the adapter's turn.end lands during the term window: no synthesized one
    let (mut m, _) = CancelMachine::start(CancelPlan::default(), t0);
    m.tick(at(5000), true);
    assert!(m.turn_ended().is_empty());
    assert_eq!(m.tick(at(5100), false), vec![Step::Finish { synthesize_turn_end: false }]);
}
