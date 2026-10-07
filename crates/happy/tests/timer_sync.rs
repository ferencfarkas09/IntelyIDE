//! The Time Tracker against a loopback stub that answers the REAL backend's shapes: sync with another client within the
//! +-5 s window, paging of long ranges, the picker's server search and creating a task. No network beyond 127.0.0.1.
mod common;

use std::sync::atomic::{AtomicU32, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{wait_for, Req, Resp, Rig, Stub, JWT};
use intely_happy::time::{now_ms, parse_iso, to_iso};
use intely_happy::types::{PrefsPatch, ProviderState, TimerPhase};
use serde_json::{json, Value};

const IDLE: u8 = 0;
const RUNNING: u8 = 1;
const PAUSED: u8 = 2;
const WORK_ORDER: u8 = 3;

fn param(req: &Req, key: &str) -> Option<String> {
    url::form_urlencoded::parse(req.query.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

fn widget(kind: &str, state: &str) -> Value {
    let (id, title, task) = if kind == "workOrder" { ("w_till", "#WO-77", "Fix the till printer") } else { ("p_pos", "Shop POS", "Receipts") };
    json!({ "kind": kind, "id": id, "title": title, "projectTitle": title, "taskId": "t1", "taskTitle": task, "customerName": null, "startedAt": if state == "paused" { Value::Null } else { json!("2026-10-03T08:00:00.000Z") }, "state": state, "segmentType": null, "workSeconds": null, "breakSeconds": null, "pausedElapsedSeconds": if state == "paused" { json!(300) } else { Value::Null }, "canBreak": kind == "workOrder", "canPause": true })
}

/// A stub whose timer is whatever `elsewhere` says, like the web admin or the phone would have left it.
fn server(elsewhere: Arc<AtomicU8>) -> impl Fn(&Req) -> Resp + Send + Sync + 'static {
    move |r| {
        if r.headers.get("authorization").map(String::as_str) != Some(&format!("Bearer {JWT}")) {
            return Resp::json(401, json!({ "code": "DEVICE_LOGGED_OUT" }));
        }
        let state = elsewhere.load(Ordering::SeqCst);
        match (r.method.as_str(), r.path.as_str()) {
            ("GET", "/api/user/me") => Resp::json(200, json!({ "id": "u_1", "name": "Teszt Elek", "restaurants": [{ "id": "r_1", "name": "Demo Gastro" }] })),
            ("GET", "/api/projects/me/running-timer") => {
                let row = json!({ "_id": "e1", "projectId": "p_pos", "projectTitle": "Shop POS", "taskId": "t1", "start": "2026-10-03T08:00:00.000Z", "durationSec": if state == PAUSED { 300 } else { 0 } });
                Resp::json(200, json!({ "success": true, "data": { "running": if state == RUNNING { row.clone() } else { Value::Null }, "paused": if state == PAUSED { row } else { Value::Null } } }))
            }
            ("GET", "/api/widgets/summary") => {
                let timer = match state {
                    RUNNING => widget("project", "running"),
                    PAUSED => widget("project", "paused"),
                    WORK_ORDER => widget("workOrder", "running"),
                    _ => Value::Null,
                };
                Resp::json(200, json!({ "timer": timer, "trackables": [] }))
            }
            _ => Resp::json(404, json!({ "code": "not_found" })),
        }
    }
}

async fn ready(stub: &Stub) -> Rig {
    let rig = Rig::new(stub).await;
    rig.switch_on(true, false).await;
    assert!(rig.hub.save_token(JWT).await.ok);
    rig.wait_state("timer", ProviderState::Ready).await;
    rig
}

async fn within(secs: u64, what: &str, mut cond: impl FnMut() -> bool) -> Duration {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(secs) {
        if cond() {
            return started.elapsed();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{what}: not seen within {secs} s");
}

#[tokio::test]
async fn a_timer_changed_elsewhere_shows_up_within_five_seconds_and_only_changes_emit() {
    let elsewhere = Arc::new(AtomicU8::new(IDLE));
    let stub = Stub::start(server(Arc::clone(&elsewhere))).await;
    let rig = ready(&stub).await;
    assert_eq!(rig.hub.timer_current().phase, TimerPhase::Idle);
    let before = rig.sink.timers.lock().unwrap().len();

    elsewhere.store(RUNNING, Ordering::SeqCst);
    let took = within(5, "running", || rig.hub.timer_current().phase == TimerPhase::Running).await;
    let view = rig.hub.timer_current();
    assert_eq!((view.title.as_str(), view.project.as_deref(), view.task_id.as_deref()), ("Receipts", Some("Shop POS"), Some("t1")), "the title comes from the summary");
    assert_eq!(view.started_at_ms, parse_iso("2026-10-03T08:00:00Z").unwrap(), "the clock counts from the server start");
    assert!(took < Duration::from_secs(5), "{took:?}");

    elsewhere.store(PAUSED, Ordering::SeqCst);
    within(5, "paused", || rig.hub.timer_current().phase == TimerPhase::Paused).await;
    assert_eq!(rig.hub.timer_current().accumulated_sec, 300);

    elsewhere.store(IDLE, Ordering::SeqCst);
    within(5, "idle", || rig.hub.timer_current().phase == TimerPhase::Idle).await;
    let after = rig.sink.timers.lock().unwrap().len();
    assert_eq!(after - before, 3, "one event per change: running, paused, idle");
    let polls = stub.paths().iter().filter(|p| p.ends_with("running-timer")).count();
    assert!(polls >= 4, "the live endpoint is polled every few seconds, saw {polls}");
}

#[tokio::test]
async fn a_work_order_timer_comes_from_the_summary_and_survives_the_live_polls() {
    let elsewhere = Arc::new(AtomicU8::new(WORK_ORDER));
    let stub = Stub::start(server(elsewhere)).await;
    let rig = ready(&stub).await;
    let view = rig.hub.timer_current();
    assert_eq!((view.phase, view.kind.as_str(), view.target_id.as_str(), view.can_break), (TimerPhase::Running, "workOrder", "w_till", true));
    let polls = || stub.paths().iter().filter(|p| p.ends_with("running-timer")).count();
    let seen = polls();
    within(6, "another live poll", || polls() > seen).await;
    assert_eq!(rig.hub.timer_current().kind, "workOrder", "an idle live endpoint does not clear a work order between summaries");
}

#[tokio::test]
async fn a_blurred_window_still_follows_the_timer_slowly_and_focus_catches_up_at_once() {
    let elsewhere = Arc::new(AtomicU8::new(IDLE));
    let stub = Stub::start(server(Arc::clone(&elsewhere))).await;
    let rig = ready(&stub).await;
    rig.hub.set_focus(false);
    tokio::time::sleep(Duration::from_millis(200)).await;
    // The owner works in the browser or on the phone: the IDE is not in front, and a timer started or stopped there must still show up
    // (the blurred pace is about 5 s).
    elsewhere.store(RUNNING, Ordering::SeqCst);
    within(8, "a timer started elsewhere is followed while blurred", || rig.hub.timer_current().phase == TimerPhase::Running).await;
    elsewhere.store(IDLE, Ordering::SeqCst);
    within(8, "a timer stopped elsewhere is followed while blurred", || rig.hub.timer_current().phase == TimerPhase::Idle).await;
    // and focus runs a catch-up poll at once
    elsewhere.store(PAUSED, Ordering::SeqCst);
    rig.hub.set_focus(true);
    within(2, "the catch-up on focus", || rig.hub.timer_current().phase == TimerPhase::Paused).await;
}

/// One 404 from the live endpoint after the provider has been answering is a hiccup (a gateway, a deploy): the poll backs off and goes on.
#[tokio::test]
async fn a_404_after_a_success_does_not_end_the_timer_poll() {
    let elsewhere = Arc::new(AtomicU8::new(IDLE));
    let misses = Arc::new(AtomicU32::new(0));
    let inner = server(Arc::clone(&elsewhere));
    let left = Arc::clone(&misses);
    let stub = Stub::start(move |r: &Req| {
        if r.path.ends_with("running-timer") && left.load(Ordering::SeqCst) > 0 {
            left.fetch_sub(1, Ordering::SeqCst);
            return Resp::json(404, json!({ "code": "not_found" }));
        }
        inner(r)
    })
    .await;
    let rig = ready(&stub).await;
    misses.store(1, Ordering::SeqCst);
    elsewhere.store(RUNNING, Ordering::SeqCst);
    within(15, "the poll recovers after the 404 and follows the change", || rig.hub.timer_current().phase == TimerPhase::Running).await;
    assert_eq!(misses.load(Ordering::SeqCst), 0, "the 404 was served");
    assert_eq!(rig.state_of("timer").await, ProviderState::Ready, "back to Ready, never NotPermitted");
}

/// 1200 rows, one every second going back from now; honours `from`, `to` (inclusive) and `limit` like the backend.
fn entries_server(total: usize) -> impl Fn(&Req) -> Resp + Send + Sync + 'static {
    let newest = now_ms() - 60_000;
    move |r| {
        if r.path != "/api/projects/time-entries" {
            return server(Arc::new(AtomicU8::new(IDLE)))(r);
        }
        let (from, to) = (param(r, "from").and_then(|s| parse_iso(&s)).unwrap_or(0), param(r, "to").and_then(|s| parse_iso(&s)).unwrap_or(i64::MAX));
        let limit: usize = param(r, "limit").and_then(|l| l.parse().ok()).unwrap_or(200).min(500);
        let rows: Vec<Value> = (0..total as i64)
            .map(|i| newest - i * 1000)
            .filter(|s| *s >= from && *s <= to)
            .take(limit)
            .map(|s| json!({ "_id": format!("e{s}"), "projectId": { "_id": "p_pos", "title": "Shop POS", "customerName": "Acme" }, "start": to_iso(s), "end": to_iso(s + 1000), "durationSec": 1, "isRunning": false, "abandonedAt": null }))
            .collect();
        Resp::json(200, json!({ "success": true, "data": rows }))
    }
}

#[tokio::test]
async fn a_long_range_is_paged_back_with_to_and_deduped() {
    let stub = Stub::start(entries_server(1200)).await;
    let rig = ready(&stub).await;
    let day = rig.hub.timer_entries(now_ms() - 3_600_000 * 24, now_ms() + 60_000).await.unwrap();
    assert_eq!((day.entries.len(), day.total_seconds, day.truncated), (1200, 1200, false));
    assert!(day.entries.windows(2).all(|w| w[0].started_at_ms > w[1].started_at_ms), "newest first, no duplicates");
    let pages = stub.paths().iter().filter(|p| p.ends_with("time-entries")).count();
    assert_eq!(pages, 3, "500 + 500 + the rest");
    assert!(stub.requests.lock().unwrap().iter().filter(|r| r.path.ends_with("time-entries")).all(|r| param(r, "limit").as_deref() == Some("500") && param(r, "userId").as_deref() == Some("u_1")));
}

#[tokio::test]
async fn more_rows_than_four_pages_are_flagged_truncated() {
    let stub = Stub::start(entries_server(3000)).await;
    let rig = ready(&stub).await;
    let day = rig.hub.timer_entries(now_ms() - 3_600_000 * 24, now_ms() + 60_000).await.unwrap();
    assert!(day.truncated && day.entries.len() >= 1900 && day.entries.len() <= 2000, "{}", day.entries.len());
}

fn picker_server(create: u16) -> impl Fn(&Req) -> Resp + Send + Sync + 'static {
    move |r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/api/projects") => Resp::json(200, json!({ "success": true, "data": { "projects": [{ "_id": "p_pos", "title": "Shop POS", "code": "HP", "customerName": "Acme" }], "pagination": { "page": 1, "limit": 6, "total": 1, "pages": 1 } } })),
        ("GET", "/api/tasks/autocomplete") => Resp::json(200, json!({ "success": true, "data": { "tasks": [{ "_id": "t1", "title": "Receipts", "code": "HP-1", "projectId": "p_pos" }, { "_id": "t9", "title": "Receipts again", "code": "AD-9", "projectId": "p_admin" }] } })),
        ("GET", "/api/tasks") => Resp::json(200, json!({ "success": true, "data": { "tasks": [{ "_id": "t1", "title": "Receipts", "projectId": "p_pos" }, { "_id": "t2", "title": "Refunds", "projectId": "p_pos" }], "pagination": {} } })),
        ("GET", "/api/projects/p_admin") => Resp::json(200, json!({ "success": true, "data": { "_id": "p_admin", "title": "Admin" } })),
        ("POST", "/api/tasks") if create == 201 => Resp::json(201, json!({ "success": true, "message": "Task created", "data": { "_id": "t_new", "title": "Gift cards", "projectId": "p_pos" } })),
        ("POST", "/api/tasks") => Resp::json(create, json!({ "success": false, "message": "nope" })),
        _ => server(Arc::new(AtomicU8::new(IDLE)))(r),
    }
}

#[tokio::test]
async fn the_search_asks_the_server_and_groups_tasks_under_their_projects() {
    let stub = Stub::start(picker_server(201)).await;
    let rig = ready(&stub).await;
    let found = rig.hub.timer_search("  rece ").await.unwrap();
    assert_eq!((found.projects.len(), found.projects[0].id.as_str(), found.projects[0].customer.as_deref()), (1, "p_pos", Some("Acme")));
    let tasks: Vec<_> = found.tasks.iter().map(|t| (t.task_id.as_deref().unwrap(), t.id.as_str(), t.title.as_str(), t.project.as_deref().unwrap())).collect();
    assert_eq!(tasks, vec![("t1", "p_pos", "Receipts", "Shop POS"), ("t9", "p_admin", "Receipts again", "Admin"), ("t2", "p_pos", "Refunds", "Shop POS")], "deduped, with the project of each task resolved");
    let reqs = stub.requests.lock().unwrap().clone();
    assert!(reqs.iter().any(|r| r.path == "/api/projects" && param(r, "search").as_deref() == Some("rece")), "trimmed and sent to the server");
    assert!(reqs.iter().any(|r| r.path == "/api/tasks/autocomplete" && param(r, "q").as_deref() == Some("rece")));
    assert!(reqs.iter().any(|r| r.path == "/api/tasks" && param(r, "projectId").as_deref() == Some("p_pos")));
    assert_eq!(rig.hub.timer_search("   ").await.unwrap().tasks.len(), 0, "an empty query asks nothing");
}

#[tokio::test]
async fn a_new_task_is_posted_and_comes_back_as_a_start_target() {
    let stub = Stub::start(picker_server(201)).await;
    let rig = ready(&stub).await;
    let t = rig.hub.timer_create_task("p_pos", "  Gift cards ").await.unwrap();
    assert_eq!((t.kind.as_str(), t.id.as_str(), t.task_id.as_deref(), t.title.as_str()), ("project", "p_pos", Some("t_new"), "Gift cards"));
    let post = stub.requests.lock().unwrap().iter().find(|r| r.method == "POST").cloned().unwrap();
    assert_eq!(serde_json::from_str::<Value>(&post.body).unwrap(), json!({ "projectId": "p_pos", "title": "Gift cards" }));
    assert_eq!(rig.hub.timer_create_task("p_pos", "   ").await.unwrap_err().code, "invalidTitle");
    assert_eq!(rig.hub.timer_create_task("../x", "ok").await.unwrap_err().code, "invalidProject");
}

#[tokio::test]
async fn create_task_errors_are_plain_and_leave_the_provider_running() {
    for (status, code) in [(400, "rejected"), (403, "forbidden"), (404, "notFound")] {
        let stub = Stub::start(picker_server(status)).await;
        let rig = ready(&stub).await;
        assert_eq!(rig.hub.timer_create_task("p_pos", "x").await.unwrap_err().code, code);
        assert_eq!(rig.state_of("timer").await, ProviderState::Ready, "{status} must not switch the tracker off");
    }
}

#[tokio::test]
async fn creating_a_task_needs_actions_on() {
    let stub = Stub::start(picker_server(201)).await;
    let rig = ready(&stub).await;
    let off = Some(PrefsPatch { allow_actions: Some(false), ..Default::default() });
    rig.hub.set_config(intely_happy::types::ConfigPatch { timer: off, ..Default::default() }).await.unwrap();
    wait_for(|| async { rig.hub.timer_create_task("p_pos", "x").await.is_err() }).await;
    assert_eq!(rig.hub.timer_create_task("p_pos", "x").await.unwrap_err().code, "blocked");
    assert!(!stub.paths().iter().any(|p| p.starts_with("POST")));
    assert!(rig.hub.timer_search("rece").await.is_ok(), "reading stays allowed");
}

fn count_of(stub: &Stub, path: &str) -> usize {
    stub.requests.lock().unwrap().iter().filter(|r| r.path == path).count()
}

/// `/me` answers 500 until `me_ok` is set; every other endpoint is the timer stub.
fn flaky_me(me_ok: Arc<AtomicU8>) -> impl Fn(&Req) -> Resp + Send + Sync + 'static {
    move |r| {
        if r.path == "/api/user/me" && me_ok.load(Ordering::SeqCst) == 0 {
            return Resp::json(500, json!({ "code": "boom" }));
        }
        if r.path == "/api/projects/time-entries" || r.path == "/api/projects/time-entries/summary" {
            return Resp::json(200, json!({ "success": true, "data": [] }));
        }
        server(Arc::new(AtomicU8::new(IDLE)))(r)
    }
}

#[tokio::test]
async fn entries_and_totals_never_query_without_a_user_id() {
    let me_ok = Arc::new(AtomicU8::new(0));
    let stub = Stub::start(flaky_me(Arc::clone(&me_ok))).await;
    let rig = Rig::new(&stub).await;
    rig.give_token();
    rig.switch_on(true, false).await;
    rig.wait_state("timer", ProviderState::Ready).await;
    let (from, to) = (now_ms() - 86_400_000, now_ms() + 60_000);
    let err = rig.hub.timer_entries(from, to).await.unwrap_err();
    assert_eq!(err.code, "userUnknown");
    assert_eq!(rig.hub.timer_totals(from, from, from).await.unwrap_err().code, "userUnknown");
    assert_eq!(count_of(&stub, "/api/projects/time-entries") + count_of(&stub, "/api/projects/time-entries/summary"), 0, "no unfiltered query was sent");
    // The user becomes known: the next ask (5 s after the last one) goes through, with the id.
    me_ok.store(1, Ordering::SeqCst);
    wait_for(|| async { rig.hub.timer_entries(from, to).await.is_ok() }).await;
    assert!(stub.requests.lock().unwrap().iter().filter(|r| r.path.starts_with("/api/projects/time-entries")).all(|r| param(r, "userId").as_deref() == Some("u_1")));
}

#[tokio::test]
async fn a_failing_user_lookup_is_not_retried_in_a_loop() {
    let stub = Stub::start(|r: &Req| if r.path == "/api/user/me" { Resp::json(500, json!({ "code": "boom" })) } else { common::fixtures(r) }).await;
    let rig = Rig::new(&stub).await;
    rig.give_token();
    rig.switch_chat(true, false).await;
    rig.wait_state("chat", ProviderState::Ready).await;
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(count_of(&stub, "/api/user/me"), 1, "one lookup, then none for at least 30 s");
}

#[tokio::test]
async fn a_failing_summary_is_not_hammered_on_every_poll() {
    let stub = Stub::start(|r: &Req| if r.path == "/api/widgets/summary" { Resp::json(500, json!({ "code": "boom" })) } else { server(Arc::new(AtomicU8::new(IDLE)))(r) }).await;
    let _rig = ready(&stub).await;
    tokio::time::sleep(Duration::from_secs(9)).await;
    assert_eq!(count_of(&stub, "/api/widgets/summary"), 1, "the ~11 s spacing holds after a failure");
}

#[tokio::test]
async fn a_work_order_timer_reads_the_summary_on_every_poll() {
    let stub = Stub::start(server(Arc::new(AtomicU8::new(WORK_ORDER)))).await;
    let _rig = ready(&stub).await;
    within(10, "three summary reads in about 9 s", || count_of(&stub, "/api/widgets/summary") >= 3).await;
}

#[tokio::test]
async fn marking_a_channel_read_works_with_actions_off_while_sending_stays_blocked() {
    let stub = Stub::start(common::fixtures).await;
    let rig = Rig::new(&stub).await;
    rig.switch_chat(true, false).await;
    assert!(rig.hub.save_token(JWT).await.ok);
    rig.wait_state("chat", ProviderState::Ready).await;
    let off = Some(PrefsPatch { allow_actions: Some(false), ..Default::default() });
    rig.hub.set_config(intely_happy::types::ConfigPatch { chat: off, ..Default::default() }).await.unwrap();
    wait_for(|| async { rig.hub.chat_send("c1", "hi", Vec::new(), None, None).await.is_err() }).await;
    assert_eq!(rig.hub.chat_send("c1", "hi", Vec::new(), None, None).await.unwrap_err().code, "blocked");
    let _ = rig.hub.chat_mark_read("c1").await;
    assert_eq!(count_of(&stub, "/api/chat/channels/c1/read"), 1, "the read marker reaches the server");
}
