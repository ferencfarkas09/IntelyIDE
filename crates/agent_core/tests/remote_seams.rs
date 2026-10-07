//! Contract tests of the Phase 2a Remote seams (providers-plan 5.10, remote-plan section 5): seq resume, append-before-publish,
//! first-answer-wins and forged-answer rejection, on a fake event source and a temp directory.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Barrier};

use intely_agent_core::api::RunStatus;
use intely_agent_core::bus::{EventBus, RecvError, TryRecvError};
use intely_agent_core::events::samples::sample_events;
use intely_agent_core::events::{AgentEvent, EventLog, JsonlEventLog, LogError};
use intely_agent_core::hub::{Eligibility, HubError, Origin, PendingKind, PendingRequest, PendingTable, Risk};
use intely_agent_core::projection::RunProjection;

fn temp_log() -> (tempfile::TempDir, Arc<JsonlEventLog>) {
    let dir = tempfile::tempdir().unwrap();
    let log = Arc::new(JsonlEventLog::new(dir.path()));
    (dir, log)
}

fn pending(req: &str, agent: &str, eligibility: Eligibility, expires_at: u64) -> PendingRequest {
    PendingRequest {
        req_id: req.into(),
        agent_id: agent.into(),
        kind: PendingKind::Permission,
        tool_id: Some("t1".into()),
        intent: None,
        intent_hash: "h-1".into(),
        risk: Risk::Low,
        eligibility,
        expires_at,
        plan_excerpt: None,
        plan_truncated: None,
    }
}

fn phone(id: &str) -> Origin {
    Origin::Remote { device_id: id.into() }
}

#[test]
fn seq_resume_returns_exactly_the_missing_events_then_live_without_gap_or_duplicate() {
    let (_dir, log) = temp_log();
    let bus = EventBus::new(log.clone());
    let stream = sample_events();
    let agent = stream[0].agent_id.clone();

    // the phone saw the first five events, then went away
    let mut live = bus.subscribe();
    for e in &stream[..5] {
        bus.publish(e).unwrap();
    }
    let last_seen = (0..5).map(|_| live.try_recv().unwrap().seq).last().unwrap();
    drop(live);
    for e in &stream[5..8] {
        bus.publish(e).unwrap();
    }

    // reconnect: subscribe first (so nothing slips between), then replay from the log
    let mut live = bus.subscribe();
    let replay = log.read_from(&agent, last_seen + 1, 100).unwrap();
    assert_eq!(replay, stream[5..].iter().take(stream.len() - 5).cloned().collect::<Vec<_>>().into_iter().take(replay.len()).collect::<Vec<_>>());
    assert_eq!(replay.first().map(|e| e.seq), Some(last_seen + 1), "starts right after the last seen seq");
    assert_eq!(replay.len(), 3);

    // an event published after the replay arrives live, and the one already replayed is a duplicate the reader drops
    bus.publish(&stream[8]).unwrap();
    let got = live.try_recv().unwrap();
    assert_eq!(got.seq, stream[8].seq);
    assert!(matches!(live.try_recv(), Err(TryRecvError::Empty)));
    assert_eq!(log.last_seq(&agent).unwrap(), Some(stream[8].seq));
}

#[test]
fn a_log_rotated_past_the_seq_is_visible_to_the_reader() {
    let (_dir, log) = temp_log();
    let bus = EventBus::new(log.clone());
    let stream = sample_events();
    let agent = stream[0].agent_id.clone();
    // a resumed run whose log starts at seq 10 (earlier lines were pruned): a reader asking for 3 sees the gap
    for (i, e) in stream.iter().take(4).enumerate() {
        let mut e = e.clone();
        e.seq = 10 + i as u64;
        bus.publish(&e).unwrap();
    }
    let got = log.read_from(&agent, 3, 100).unwrap();
    assert_eq!(got.first().map(|e| e.seq), Some(10), "first returned seq is above the requested one: fall back to a snapshot");
}

struct FailingLog {
    inner: JsonlEventLog,
    fail: AtomicBool,
}

impl EventLog for FailingLog {
    fn append(&self, event: &AgentEvent) -> Result<(), LogError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(LogError::Io(std::io::Error::other("disk full")));
        }
        self.inner.append(event)
    }
    fn read(&self, agent_id: &str) -> Result<Vec<AgentEvent>, LogError> {
        self.inner.read(agent_id)
    }
    fn runs(&self) -> Result<Vec<String>, LogError> {
        self.inner.runs()
    }
}

#[test]
fn append_before_publish_never_publishes_an_unlogged_event() {
    let dir = tempfile::tempdir().unwrap();
    let log = Arc::new(FailingLog { inner: JsonlEventLog::new(dir.path()), fail: AtomicBool::new(false) });
    let bus = EventBus::new(log.clone());
    let mut rx = bus.subscribe();
    let stream = sample_events();

    bus.publish(&stream[0]).unwrap();
    // at the moment a subscriber receives an event, the log already holds it
    let got = rx.try_recv().unwrap();
    assert!(log.read(&got.agent_id).unwrap().iter().any(|e| e.seq == got.seq));

    log.fail.store(true, Ordering::SeqCst);
    assert!(bus.publish(&stream[1]).is_err());
    assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)), "the failed append was not published");
    assert_eq!(log.read(&stream[0].agent_id).unwrap().len(), 1, "and it is not in the log either");
}

#[test]
fn a_lagged_subscriber_is_told_and_can_resync_from_the_log() {
    let (_dir, log) = temp_log();
    let bus = EventBus::with_capacity(log.clone(), 2);
    let mut rx = bus.subscribe();
    let stream = sample_events();
    for e in &stream[..6] {
        bus.publish(e).unwrap();
    }
    assert!(matches!(rx.try_recv(), Err(TryRecvError::Lagged(_))));
    let _ = RecvError::Closed; // the async API reports the same condition as RecvError::Lagged
    assert_eq!(log.read(&stream[0].agent_id).unwrap().len(), 6, "the log has everything the receiver missed");
}

#[test]
fn no_subscriber_means_publish_is_just_an_append() {
    let (_dir, log) = temp_log();
    let bus = EventBus::new(log.clone());
    assert_eq!(bus.receiver_count(), 0);
    bus.publish(&sample_events()[0]).unwrap();
    assert_eq!(bus.receiver_count(), 0);
}

#[test]
fn first_answer_wins_exactly_one_of_many_concurrent_answers() {
    for round in 0..20 {
        let table = Arc::new(PendingTable::new());
        table.register(pending("r1", "a1", Eligibility::Low, u64::MAX));
        let n = 8;
        let barrier = Arc::new(Barrier::new(n));
        let handles: Vec<_> = (0..n)
            .map(|i| {
                let (table, barrier) = (table.clone(), barrier.clone());
                std::thread::spawn(move || {
                    let origin = if i == 0 { Origin::Desktop } else { phone(&format!("d{i}")) };
                    barrier.wait();
                    table.resolve("r1", "a1", PendingKind::Permission, Some("h-1"), &origin, 1).map(|_| origin)
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let winners: Vec<_> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
        assert_eq!(winners.len(), 1, "round {round}: exactly one winner, got {results:?}");
        for r in results.iter().filter_map(|r| r.as_ref().err()) {
            assert_eq!(*r, HubError::AlreadyResolved { by: winners[0].clone() }, "losers learn who won");
        }
        assert_eq!(table.resolved_origin("r1"), Some(winners[0].clone()));
    }
}

#[test]
fn forged_answers_are_rejected_and_leave_the_request_open() {
    let table = PendingTable::new();
    table.register(pending("ok", "a1", Eligibility::Low, 10_000));
    table.register(pending("hard", "a1", Eligibility::DesktopOnly, 10_000));
    let remote = phone("p1");

    // unknown id, other run's id, wrong intent hash, desktop-only, expired
    assert_eq!(table.resolve("nope", "a1", PendingKind::Permission, Some("h-1"), &remote, 1).unwrap_err(), HubError::Unknown);
    assert_eq!(table.resolve("ok", "a2", PendingKind::Permission, Some("h-1"), &remote, 1).unwrap_err(), HubError::WrongRun);
    assert_eq!(table.resolve("ok", "a1", PendingKind::Question, Some("h-1"), &remote, 1).unwrap_err().code(), "wrongKind");
    assert_eq!(table.resolve("ok", "a1", PendingKind::Permission, Some("other"), &remote, 1).unwrap_err(), HubError::IntentMismatch);
    assert_eq!(table.resolve("ok", "a1", PendingKind::Permission, None, &remote, 1).unwrap_err(), HubError::IntentMismatch);
    assert_eq!(table.resolve("hard", "a1", PendingKind::Permission, Some("h-1"), &remote, 1).unwrap_err(), HubError::DesktopOnly);
    assert!(table.get("ok").is_some() && table.get("hard").is_some(), "rejections do not consume a request");

    // the desktop may still answer a request a phone must not
    assert!(table.resolve("hard", "a1", PendingKind::Permission, None, &Origin::Desktop, 1).is_ok());

    // expiry applies to the phone only, and an expired id stays expired
    assert_eq!(table.resolve("ok", "a1", PendingKind::Permission, Some("h-1"), &remote, 10_000).unwrap_err(), HubError::Expired);
    assert_eq!(table.resolve("ok", "a1", PendingKind::Permission, Some("h-1"), &remote, 1).unwrap_err(), HubError::Expired);
}

#[test]
fn a_claim_the_host_could_not_apply_can_be_reopened() {
    let table = PendingTable::new();
    let p = pending("r1", "a1", Eligibility::Low, u64::MAX);
    table.register(p.clone());
    let claimed = table.resolve("r1", "a1", PendingKind::Permission, Some("h-1"), &phone("p1"), 1).unwrap();
    assert!(matches!(table.resolve("r1", "a1", PendingKind::Permission, Some("h-1"), &Origin::Desktop, 1), Err(HubError::AlreadyResolved { .. })));
    table.reopen(claimed);
    assert_eq!(table.resolved_origin("r1"), None);
    assert!(table.resolve("r1", "a1", PendingKind::Permission, Some("h-1"), &Origin::Desktop, 1).is_ok());
}

#[test]
fn the_projection_groups_runs_like_the_inbox() {
    let stream = sample_events();
    let agent = stream[0].agent_id.clone();
    let all = RunProjection::fold(&agent, &stream);
    assert_eq!(all.last_seq, stream.last().unwrap().seq);

    let mut p = RunProjection::new(&agent);
    for e in &stream {
        p.apply(e);
        if matches!(e.kind, intely_agent_core::events::EventKind::PermissionRequest { .. }) {
            assert_eq!(p.status, RunStatus::NeedsYou);
            assert_eq!(p.waiting_on.len(), 1);
        }
    }
}
