//! When a run counts as idle: its session is open and nothing is going on in it. Only an idle session may be closed to make room on a
//! server, or after ten minutes without a word.

use std::sync::Arc;
use std::time::{Duration, Instant};

use intely_agent_core::events::types::{PermissionOption, StopReason};
use intely_agent_core::policy::decide::PolicyContext;
use intely_agent_core::policy::intent::ToolIntent;
use intely_agent_core::providers::PermissionMode;
use intely_agent_gate::gate::CancelTracker;
use intely_agent_host::run::{Live, Meta, PendingPermission, Run, RunState};

fn finished_run(stop: StopReason) -> Run {
    let meta = Meta {
        agent_id: "a1".into(),
        provider: "claude".into(),
        role: "developer".into(),
        model: "m".into(),
        effort: None,
        permission: PermissionMode::Edit,
        repos: Vec::new(),
        started_at: 0,
        native_id: Some("native".into()),
        snapshots: Vec::new(),
        mcp: Vec::new(),
        role_hash: None,
        role_permission: None,
        location: Some("srv".into()),
        remote: None,
    };
    let state = RunState { last_stop: Some(stop), ..RunState::default() };
    let mut run = Run::new(meta, state, PolicyContext::new(PermissionMode::Edit, "/x"), false);
    run.live = Some(Live { generation: 1, lease_id: None });
    run
}

#[test]
fn a_finished_or_failed_run_with_an_open_session_is_idle() {
    assert!(finished_run(StopReason::EndTurn).is_idle());
    assert!(finished_run(StopReason::Error).is_idle());
}

#[test]
fn a_run_without_a_session_is_not_idle() {
    let mut run = finished_run(StopReason::EndTurn);
    run.end_session();
    assert!(!run.is_idle());
}

#[test]
fn a_run_that_works_or_waits_is_not_idle() {
    let mut working = finished_run(StopReason::EndTurn);
    working.state.turn_open = true;
    assert!(!working.is_idle());

    let mut waiting = finished_run(StopReason::EndTurn);
    waiting.state.perms.insert("r1".into(), PendingPermission { options: vec![PermissionOption::AllowOnce, PermissionOption::Deny], answering: false, intent: ToolIntent::exec("touch x") });
    assert!(!waiting.is_idle());

    // a run that has not said anything yet reads "running", not "finished"
    let mut fresh = finished_run(StopReason::EndTurn);
    fresh.state.last_stop = None;
    assert!(!fresh.is_idle());
}

#[test]
fn a_run_being_stopped_or_switched_is_not_idle() {
    let mut stopping = finished_run(StopReason::EndTurn);
    stopping.cancel = Some(Arc::new(CancelTracker::default()));
    assert!(!stopping.is_idle());

    let mut switching = finished_run(StopReason::EndTurn);
    switching.mode_busy = true;
    assert!(!switching.is_idle());
}

/// A run that is coming back (its session is opening, or a message is on its way) still reads "finished" until its first event. It must
/// not be taken for an idle one, or a start on a full server could close it under its own `session/start`.
#[test]
fn a_run_that_is_coming_back_is_not_idle_until_its_time_is_up() {
    let mut run = finished_run(StopReason::EndTurn);
    run.busy_until = Some(Instant::now() + Duration::from_secs(60));
    assert!(!run.is_idle());
    run.busy_until = Some(Instant::now() - Duration::from_millis(1));
    assert!(run.is_idle(), "a mark that has run out no longer counts");
    // ending the session forgets the mark
    run.busy_until = Some(Instant::now() + Duration::from_secs(60));
    run.end_session();
    assert!(run.busy_until.is_none());
}
