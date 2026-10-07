use intely_runindex::night::*;

fn new(prompt: &str) -> NewItem {
    NewItem { role_id: "developer".into(), prompt: prompt.into(), repo_ids: vec!["backend".into()], max_minutes: Some(10), max_tokens: Some(50_000) }
}

fn obs(now_ms: u64, run: Option<RunObs>) -> Observation {
    Observation { now_ms, on_battery: false, read_only: false, run }
}

fn working(tokens: u64) -> Option<RunObs> {
    Some(RunObs { phase: Phase::Working, tokens })
}

fn plan_of(n: usize) -> NightPlan {
    let mut p = NightPlan::default();
    for i in 0..n {
        p.add(new(&format!("job {i}"))).unwrap();
    }
    p
}

#[test]
fn adding_validates_and_caps_the_night() {
    let mut p = NightPlan::default();
    assert_eq!(p.add(new("  ")).unwrap_err().code, "emptyPrompt");
    assert_eq!(p.add(NewItem { repo_ids: vec![], ..new("x") }).unwrap_err().code, "noRepo");
    assert_eq!(p.add(NewItem { role_id: " ".into(), ..new("x") }).unwrap_err().code, "noRole");
    assert_eq!(p.add(NewItem { max_minutes: Some(0), ..new("x") }).unwrap_err().code, "badBudget");
    assert_eq!(p.add(NewItem { max_minutes: Some(481), ..new("x") }).unwrap_err().code, "badBudget");
    assert_eq!(p.add(NewItem { max_tokens: Some(10), ..new("x") }).unwrap_err().code, "badBudget");
    assert_eq!(p.add(new(&"x".repeat(12_001))).unwrap_err().code, "promptTooLong");
    let defaults = p.add(NewItem { max_minutes: None, max_tokens: None, ..new("x") }).unwrap();
    assert_eq!((defaults.max_minutes, defaults.max_tokens), (DEFAULT_MINUTES, DEFAULT_TOKENS));
    for i in 1..MAX_RUNS_PER_NIGHT {
        p.add(new(&format!("job {i}"))).unwrap();
    }
    let e = p.add(new("one too many")).unwrap_err();
    assert_eq!(e.code, "nightCap", "the hard cap of runs per night");
    assert_eq!(p.items.len(), MAX_RUNS_PER_NIGHT);
}

#[test]
fn nothing_starts_until_armed_and_runs_go_one_at_a_time_in_order() {
    let mut p = plan_of(2);
    assert!(p.tick(&obs(0, None)).is_empty(), "not armed");
    p.set_armed(true, 0);
    assert_eq!(p.tick(&obs(1, None)), vec![Effect::Start { item_id: "n-1".into() }]);
    p.on_started("n-1", "agent-1", 1);
    // while n-1 works nothing else starts
    assert!(p.tick(&obs(2, working(10))).is_empty());
    assert_eq!(p.items[1].state, ItemState::Queued);
    // n-1 finishes: n-2 is next
    assert!(p.tick(&obs(3, Some(RunObs { phase: Phase::Finished { ok: true }, tokens: 700 }))).is_empty());
    assert_eq!(p.items[0].state, ItemState::Done);
    assert_eq!(p.items[0].tokens_used, 700);
    assert_eq!(p.tick(&obs(4, None)), vec![Effect::Start { item_id: "n-2".into() }]);
    p.on_started("n-2", "agent-2", 4);
    p.tick(&obs(5, Some(RunObs { phase: Phase::Finished { ok: false }, tokens: 5 })));
    assert_eq!(p.items[1].state, ItemState::Failed);
    assert!(p.tick(&obs(6, None)).is_empty(), "the night is over");
    assert!(!p.armed, "and the queue disarms itself");
}

#[test]
fn a_run_stops_on_its_time_budget() {
    let mut p = plan_of(1);
    p.set_armed(true, 0);
    p.on_started("n-1", "agent-1", 1_000);
    assert!(p.tick(&obs(1_000 + 9 * 60_000, working(1))).is_empty());
    let fx = p.tick(&obs(1_000 + 10 * 60_000, working(1)));
    assert_eq!(fx, vec![Effect::Stop { run_id: "agent-1".into(), reason: "timeBudget".into() }]);
    // asked once; while it winds down nothing repeats
    assert!(p.tick(&obs(1_000 + 10 * 60_000 + 500, working(1))).is_empty());
    p.tick(&obs(1_000 + 10 * 60_000 + 900, Some(RunObs { phase: Phase::Finished { ok: false }, tokens: 1 })));
    assert_eq!(p.items[0].state, ItemState::Stopped, "a budget stop is Stopped, not Failed");
    assert_eq!(p.items[0].reason.as_deref(), Some("timeBudget"));
}

#[test]
fn a_run_stops_on_its_token_budget() {
    let mut p = plan_of(1);
    p.set_armed(true, 0);
    p.on_started("n-1", "agent-1", 0);
    assert!(p.tick(&obs(10, working(49_999))).is_empty());
    let fx = p.tick(&obs(20, working(50_000)));
    assert_eq!(fx, vec![Effect::Stop { run_id: "agent-1".into(), reason: "tokenBudget".into() }]);
    p.tick(&obs(30, Some(RunObs { phase: Phase::Finished { ok: true }, tokens: 52_000 })));
    assert_eq!((p.items[0].state, p.items[0].tokens_used), (ItemState::Stopped, 52_000));
}

#[test]
fn the_queue_pauses_on_battery_and_when_read_only_but_a_running_item_continues() {
    let mut p = plan_of(2);
    p.set_armed(true, 0);
    let battery = Observation { on_battery: true, ..obs(1, None) };
    assert!(p.tick(&battery).is_empty());
    assert_eq!(p.paused(&battery), Some(Paused::Battery));
    let ro = Observation { read_only: true, on_battery: true, ..obs(1, None) };
    assert_eq!(p.paused(&ro), Some(Paused::ReadOnly), "read-only wins the explanation");
    assert!(p.tick(&ro).is_empty());
    assert_eq!(p.tick(&obs(2, None)).len(), 1, "back on power: it starts");
    p.on_started("n-1", "agent-1", 2);
    let plugged_out = Observation { on_battery: true, ..obs(3, working(1)) };
    assert!(p.tick(&plugged_out).is_empty());
    assert_eq!(p.items[0].state, ItemState::Running, "a run in progress is not killed");
    p.tick(&Observation { on_battery: true, ..obs(4, Some(RunObs { phase: Phase::Finished { ok: true }, tokens: 1 })) });
    assert!(p.tick(&Observation { on_battery: true, ..obs(5, None) }).is_empty(), "the next one waits for power");
}

#[test]
fn a_busy_writer_makes_the_item_wait_and_any_other_refusal_fails_it() {
    let mut p = plan_of(2);
    p.set_armed(true, 0);
    p.on_start_failed("n-1", "writeLease", "another run is writing in backend", 1);
    assert_eq!(p.items[0].state, ItemState::Queued);
    assert_eq!(p.items[0].waiting.as_deref(), Some("another run is writing in backend"));
    assert_eq!(p.tick(&obs(2, None)), vec![Effect::Start { item_id: "n-1".into() }], "retried on the next tick");
    p.on_start_failed("n-1", "noSafetyNet", "cannot snapshot", 3);
    assert_eq!((p.items[0].state, p.items[0].reason.as_deref()), (ItemState::Failed, Some("noSafetyNet")), "no Rewind snapshot: the run never starts");
    assert_eq!(p.tick(&obs(4, None)), vec![Effect::Start { item_id: "n-2".into() }]);
}

#[test]
fn a_run_the_host_forgot_is_marked_interrupted() {
    let mut p = plan_of(1);
    p.set_armed(true, 0);
    p.on_started("n-1", "agent-1", 0);
    p.tick(&obs(5, None));
    assert_eq!((p.items[0].state, p.items[0].reason.as_deref()), (ItemState::Failed, Some("interrupted")));
}

#[test]
fn queue_edits() {
    let mut p = plan_of(3);
    p.move_item("n-3", -1).unwrap();
    assert_eq!(p.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["n-1", "n-3", "n-2"]);
    p.move_item("n-1", -1).unwrap();
    assert_eq!(p.items[0].id, "n-1", "moving past the top does nothing");
    p.set_armed(true, 0);
    p.on_started("n-1", "agent-1", 0);
    assert_eq!(p.remove("n-1").unwrap_err().code, "itemRunning");
    assert_eq!(p.move_item("n-1", 1).unwrap_err().code, "notQueued");
    p.remove("n-2").unwrap();
    assert_eq!(p.remove("n-2").unwrap_err().code, "unknownItem");
    p.skip_queued(9);
    assert_eq!(p.items[1].state, ItemState::Skipped);
    p.tick(&obs(10, Some(RunObs { phase: Phase::Finished { ok: true }, tokens: 1 })));
    p.clear_finished();
    assert!(p.items.is_empty());
}

#[test]
fn a_restart_never_resumes_the_night() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state/night-queue.json");
    let mut p = plan_of(2);
    p.set_armed(true, 0);
    p.on_started("n-1", "agent-1", 0);
    p.save(&path).unwrap();
    let loaded = NightPlan::load(&path);
    assert!(!loaded.armed, "never armed after a restart");
    assert_eq!((loaded.items[0].state, loaded.items[0].reason.as_deref()), (ItemState::Failed, Some("interrupted")));
    assert_eq!(loaded.items[1].state, ItemState::Queued);
    assert_eq!(loaded.next_id, 2);
    assert!(NightPlan::load(&dir.path().join("none.json")).items.is_empty());
}

#[test]
fn battery_is_read_from_pmset() {
    assert!(parse_on_battery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t87%; discharging; 4:10 remaining present: true"));
    assert!(!parse_on_battery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true"));
    assert!(!parse_on_battery(""), "a desktop without a battery is on power");
}

#[test]
fn the_user_can_stop_the_running_item() {
    let mut p = plan_of(2);
    p.set_armed(true, 0);
    assert!(p.request_stop().is_none(), "nothing runs yet");
    p.on_started("n-1", "agent-1", 0);
    assert_eq!(p.request_stop(), Some(Effect::Stop { run_id: "agent-1".into(), reason: USER_STOP.into() }));
    assert!(p.request_stop().is_none(), "asked once");
    p.tick(&obs(5, Some(RunObs { phase: Phase::Finished { ok: false }, tokens: 3 })));
    assert_eq!((p.items[0].state, p.items[0].reason.as_deref()), (ItemState::Stopped, Some(USER_STOP)));
}
