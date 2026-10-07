//! Normalises Happy's payloads into the small DTOs the webview gets. The shapes are the ones in (design notes: integrations-plan)
//! and the mock server's fixtures; reading is tolerant (several key spellings, missing fields default, unknown fields are
//! ignored) because nothing was recorded from the live API yet.

use serde_json::Value;

use crate::time::parse_iso;
use crate::types::{Meeting, MeetingStatus, ProjectHit, TimeEntry, TimeTotals, TimerPhase, TimerView, Trackable, TodayView, UserInfo};

pub(crate) fn text(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| match v.get(k)? {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

pub(crate) fn number(v: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|k| v.get(k)?.as_f64()).map(|f| f as i64)
}

pub(crate) fn millis(v: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|k| match v.get(k)? {
        Value::String(s) => parse_iso(s),
        Value::Number(n) => n.as_i64().map(|ms| if ms < 100_000_000_000 { ms * 1000 } else { ms }),
        _ => None,
    })
}

pub(crate) fn list<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).or(Some(v)).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

pub(crate) fn seconds(v: i64) -> u32 {
    v.clamp(0, i64::from(u32::MAX)) as u32
}

pub fn user(v: &Value) -> Option<UserInfo> {
    let v = v.get("user").unwrap_or(v);
    let id = text(v, &["id", "_id", "userId"])?;
    let name = text(v, &["name", "fullName", "displayName", "email"]).unwrap_or_else(|| id.clone());
    let roles = v.get("effectiveRoles").or_else(|| v.get("roles")).and_then(Value::as_array).map(|a| a.iter().filter_map(|r| r.as_str().map(str::to_owned).or_else(|| text(r, &["name", "id"]))).collect()).unwrap_or_default();
    let store = list(v, "restaurants").first();
    Some(UserInfo {
        id,
        name,
        roles,
        restaurant_id: store.and_then(|s| text(s, &["id", "_id"])),
        restaurant_name: store.and_then(|s| text(s, &["name", "title"])),
    })
}

/// The project and task controllers wrap their answer as `{ success, data }`; the widget controllers answer raw json.
pub(crate) fn unwrap_data(v: &Value) -> &Value {
    match (v.get("success"), v.get("data")) {
        (Some(_), Some(data)) => data,
        _ => v,
    }
}

/// An id that is either a plain string or a populated object (`projectId: { _id, title, ... }`).
pub(crate) fn id_of(v: &Value, key: &str) -> Option<String> {
    match v.get(key)? {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        o @ Value::Object(_) => text(o, &["_id", "id"]),
        _ => None,
    }
}

/// A running or paused `ProjectTimeEntry` of `GET /api/projects/me/running-timer`. The server answers no task title, and a
/// running entry's `durationSec` is 0 until it is closed, so the clock counts from `start` alone; a paused one is a closed
/// entry whose `durationSec` is what the frozen clock shows.
fn timer_row(v: &Value, phase: TimerPhase) -> TimerView {
    let paused = phase == TimerPhase::Paused;
    TimerView {
        phase,
        kind: "project".to_owned(),
        target_id: id_of(v, "projectId").unwrap_or_default(),
        task_id: id_of(v, "taskId"),
        title: text(v, &["projectTitle"]).or_else(|| v.get("projectId").and_then(|p| text(p, &["title"]))).unwrap_or_else(|| "Untitled".to_owned()),
        project: None,
        started_at_ms: if paused { 0 } else { millis(v, &["start"]).unwrap_or(0) },
        accumulated_sec: if paused { seconds(number(v, &["durationSec"]).unwrap_or(0)) } else { 0 },
        can_break: false,
        offset_ms: 0,
        stale: false,
    }
}

/// `GET /api/projects/me/running-timer` -> `{ success, data: { running: row | null, paused: row | null } }`. Project timers
/// only: a work-order timer reads as idle here (see [`timer_from_widget`]).
pub fn timer_from_running(v: &Value) -> TimerView {
    let d = unwrap_data(v);
    match (d.get("running").filter(|r| r.is_object()), d.get("paused").filter(|p| p.is_object())) {
        (Some(r), _) => timer_row(r, TimerPhase::Running),
        (None, Some(p)) => timer_row(p, TimerPhase::Paused),
        (None, None) => TimerView::idle(),
    }
}

/// A `WidgetTimerState` (project or work order): the body of the verbs is `{ timer }` (`null` after a stop), the summary
/// carries the same object under its own `timer` key; pass either the wrapper or the object.
///
/// `startedAt` is the start of the current segment (`null` while paused) and pausing closes the entry, so nothing carries
/// over a pause: running time is `now - startedAt`, a paused clock shows `pausedElapsedSeconds`. `workSeconds` is the work
/// order's lifetime total and is deliberately not used.
pub fn timer_from_widget(v: &Value) -> TimerView {
    let t = v.get("timer").unwrap_or(v);
    if !t.is_object() {
        return TimerView::idle();
    }
    let phase = match text(t, &["state"]).as_deref() {
        Some("running") => TimerPhase::Running,
        Some("paused") => TimerPhase::Paused,
        Some("break") => TimerPhase::Break,
        _ => return TimerView::idle(),
    };
    let head = text(t, &["title", "projectTitle"]).unwrap_or_else(|| "Untitled".to_owned());
    let (title, project) = match text(t, &["taskTitle"]) {
        Some(task) => (task.clone(), text(t, &["projectTitle"]).or(Some(head)).filter(|p| *p != task)),
        None => (head, None),
    };
    let paused = phase == TimerPhase::Paused;
    TimerView {
        phase,
        kind: text(t, &["kind"]).unwrap_or_else(|| "project".to_owned()),
        target_id: text(t, &["id"]).unwrap_or_default(),
        task_id: text(t, &["taskId"]),
        title,
        project,
        started_at_ms: if paused { 0 } else { millis(t, &["startedAt"]).unwrap_or(0) },
        accumulated_sec: if paused { seconds(number(t, &["pausedElapsedSeconds"]).unwrap_or(0)) } else { 0 },
        can_break: t.get("canBreak").and_then(Value::as_bool).unwrap_or(false),
        offset_ms: 0,
        stale: false,
    }
}

/// `GET /api/widgets/summary` -> `{ trackables: [{ kind, id, title, subtitle, taskId, taskTitle }] }` (raw json). A row
/// with a task shows the task and groups under its project (or work order); one without shows the project itself.
pub fn trackables(v: &Value) -> Vec<Trackable> {
    list(v, "trackables")
        .iter()
        .filter_map(|t| {
            let kind = text(t, &["kind"]).unwrap_or_else(|| "project".to_owned());
            let (id, title) = (text(t, &["id"])?, text(t, &["title"])?);
            Some(match (text(t, &["taskId"]), text(t, &["taskTitle"])) {
                (Some(task_id), Some(task)) => Trackable { kind, id, task_id: Some(task_id), title: task, project: Some(title) },
                _ => Trackable { kind, id, task_id: None, title, project: None },
            })
        })
        .collect()
}

/// One row of `GET /api/projects/time-entries` -> `data: [...]`. The server answers the project as an object and never
/// resolves the task title, so a row shows its project (and the customer under it). A running row (`isRunning`, no `end`,
/// `durationSec` 0) counts up to `now_ms`, which the caller passes in server time.
fn time_entry(e: &Value, now_ms: i64) -> Option<TimeEntry> {
    let started = millis(e, &["start"])?;
    let running = e.get("isRunning").and_then(Value::as_bool).unwrap_or(false);
    let ended = if running { None } else { millis(e, &["end"]) };
    let abandoned = e.get("abandonedAt").is_some_and(|a| !a.is_null());
    let secs = if abandoned {
        0
    } else if ended.is_none() {
        (now_ms - started) / 1000
    } else {
        number(e, &["durationSec"]).unwrap_or_else(|| (ended.unwrap_or(now_ms) - started) / 1000)
    };
    let project = e.get("projectId").filter(|p| p.is_object());
    let note = text(e, &["note"]);
    let title = project.and_then(|p| text(p, &["title"])).or_else(|| text(e, &["projectTitle"])).unwrap_or_else(|| "Untitled".to_owned());
    Some(TimeEntry {
        id: text(e, &["_id", "id"]).unwrap_or_default(),
        title,
        project: project.and_then(|p| text(p, &["customerName"])).or(note),
        started_at_ms: started,
        ended_at_ms: ended,
        seconds: seconds(secs),
        abandoned,
    })
}

/// `GET /api/projects/time-entries` -> `{ success, data: [rows] }`.
pub fn entries(v: &Value, now_ms: i64) -> TodayView {
    let rows = unwrap_data(v).as_array().map_or(&[][..], Vec::as_slice);
    let entries: Vec<TimeEntry> = rows.iter().filter_map(|e| time_entry(e, now_ms)).collect();
    let total_seconds = entries.iter().map(|e| e.seconds).sum();
    TodayView { entries, total_seconds, truncated: false }
}

/// `GET /api/projects/time-entries/summary` -> `data: { day, week, month: { totalSeconds, ... } }` (settled entries only).
pub fn totals(v: &Value) -> TimeTotals {
    let d = unwrap_data(v);
    let of = |k: &str| seconds(d.get(k).and_then(|r| number(r, &["totalSeconds"])).unwrap_or(0));
    TimeTotals { day_sec: of("day"), week_sec: of("week"), month_sec: of("month") }
}

/// `GET /api/projects?search` -> `data: { projects: [{ _id, title, code, customerName }] }`.
pub fn project_hits(v: &Value) -> Vec<ProjectHit> {
    list(unwrap_data(v), "projects")
        .iter()
        .filter_map(|p| Some(ProjectHit { id: id_of(p, "_id").or_else(|| text(p, &["id"]))?, title: text(p, &["title", "name"])?, code: text(p, &["code"]), customer: text(p, &["customerName"]) }))
        .collect()
}

/// `GET /api/tasks/autocomplete` and `GET /api/tasks` -> `data: { tasks: [{ _id, title, projectId }] }`, as
/// `(task id, project id, title)`; the project id is a plain id or a populated object.
pub fn task_rows(v: &Value) -> Vec<(String, String, String)> {
    list(unwrap_data(v), "tasks").iter().filter_map(|t| Some((id_of(t, "_id").or_else(|| text(t, &["id"]))?, id_of(t, "projectId")?, text(t, &["title"])?))).collect()
}

/// `GET /api/chat/meetings?status=...` -> `{ meetings: [...] }`.
pub fn meetings(v: &Value, status: MeetingStatus) -> Vec<Meeting> {
    list(v, "meetings")
        .iter()
        .filter_map(|m| {
            Some(Meeting {
                id: text(m, &["id", "_id"])?,
                title: text(m, &["title", "name"]).unwrap_or_else(|| "Meeting".to_owned()),
                channel: m.get("channel").and_then(|c| text(c, &["name", "title"]).or_else(|| c.as_str().map(str::to_owned))).or_else(|| text(m, &["channelName"])),
                status: status.clone(),
                start_ms: millis(m, &["startsAt", "scheduledAt", "startedAt", "start"]),
                participants: seconds(number(m, &["participantCount", "participants"]).unwrap_or(0)),
                host: m.get("host").and_then(|h| text(h, &["name", "displayName"]).or_else(|| h.as_str().map(str::to_owned))).or_else(|| text(m, &["hostName"])),
                waiting: number(m, &["waitingCount", "lobbyCount", "waiting"]).filter(|n| *n > 0).map(seconds),
            })
        })
        .collect()
}

/// The join link of `POST .../join`.
pub fn join_url(v: &Value) -> Option<String> {
    text(v, &["joinUrl", "url"])
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_user_comes_from_me_with_the_first_store() {
        let u = user(&json!({ "id": "u_1", "name": "Teszt Elek", "effectiveRoles": ["admin", "timeTracker"], "restaurants": [{ "id": "r_1", "name": "Demo Gastro" }] })).unwrap();
        assert_eq!((u.id.as_str(), u.name.as_str(), u.roles.len()), ("u_1", "Teszt Elek", 2));
        assert_eq!((u.restaurant_id.as_deref(), u.restaurant_name.as_deref()), (Some("r_1"), Some("Demo Gastro")));
        assert!(user(&json!({})).is_none());
    }

    // Fixtures are the real backend's shapes (project.controller.js getRunningTimer / listTimeEntries, widgets.service.js).

    #[test]
    fn the_live_endpoint_answers_an_enveloped_project_row() {
        let running = json!({ "success": true, "data": { "running": { "_id": "e1", "projectId": "p1", "projectTitle": "Shop POS", "taskId": "t1", "start": "2026-10-03T08:00:00.000Z", "durationSec": 0, "billable": true, "note": "" }, "paused": null } });
        let v = timer_from_running(&running);
        assert_eq!((v.phase.clone(), v.kind.as_str(), v.target_id.as_str(), v.task_id.as_deref(), v.title.as_str(), v.project.as_deref(), v.accumulated_sec), (TimerPhase::Running, "project", "p1", Some("t1"), "Shop POS", None, 0));
        assert_eq!(v.started_at_ms, parse_iso("2026-10-03T08:00:00Z").unwrap());
        let paused = timer_from_running(&json!({ "success": true, "data": { "running": null, "paused": { "_id": "e1", "projectId": "p1", "projectTitle": "Shop POS", "taskId": null, "start": "2026-10-03T08:00:00Z", "end": "2026-10-03T08:10:00Z", "durationSec": 600, "pausedAt": "2026-10-03T08:10:00Z" } } }));
        assert_eq!((paused.phase, paused.accumulated_sec, paused.started_at_ms, paused.task_id), (TimerPhase::Paused, 600, 0, None));
        assert_eq!(timer_from_running(&json!({ "success": true, "data": { "running": null, "paused": null } })), TimerView::idle());
        assert_eq!(timer_from_running(&json!({})), TimerView::idle());
    }

    #[test]
    fn a_widget_timer_state_counts_from_its_segment_start() {
        let wo = json!({ "timer": { "kind": "workOrder", "id": "w9", "title": "#WO-123", "projectTitle": "#WO-123", "taskId": "s1", "taskTitle": "Replace the printer", "customerName": "Kiss Kft.", "startedAt": "2026-10-03T08:00:00.000Z", "state": "break", "segmentType": "BREAK", "workSeconds": 36000, "breakSeconds": 60, "pausedElapsedSeconds": null, "canBreak": true, "canPause": true } });
        let v = timer_from_widget(&wo);
        assert_eq!((v.phase, v.kind.as_str(), v.target_id.as_str(), v.title.as_str(), v.project.as_deref(), v.can_break), (TimerPhase::Break, "workOrder", "w9", "Replace the printer", Some("#WO-123"), true));
        assert_eq!((v.accumulated_sec, v.started_at_ms), (0, parse_iso("2026-10-03T08:00:00Z").unwrap()), "workSeconds is the lifetime total, not the clock");
        let project = timer_from_widget(&json!({ "timer": { "kind": "project", "id": "p1", "title": "Shop POS", "projectTitle": "Shop POS", "taskId": null, "taskTitle": null, "startedAt": null, "state": "paused", "workSeconds": null, "pausedElapsedSeconds": 300, "canBreak": false } }));
        assert_eq!((project.phase, project.title.as_str(), project.project, project.accumulated_sec, project.started_at_ms), (TimerPhase::Paused, "Shop POS", None, 300, 0));
        // The summary carries the same object under `timer`; a stop answers `{ timer: null }`.
        assert_eq!(timer_from_widget(&json!({ "timer": null })), TimerView::idle());
        assert_eq!(timer_from_widget(&json!({ "generatedAt": "x", "trackables": [] })), TimerView::idle());
    }

    #[test]
    fn trackables_are_the_flat_rows_of_the_summary() {
        let rows = trackables(&json!({ "trackables": [
            { "kind": "workOrder", "id": "w1", "title": "#WO-1", "subtitle": "Kiss Kft.", "taskId": "s1", "taskTitle": "Fix till" },
            { "kind": "project", "id": "p1", "title": "Shop POS", "subtitle": "Acme", "taskId": "t1", "taskTitle": "Receipts" },
            { "kind": "project", "id": "p2", "title": "Admin", "subtitle": null, "taskId": null, "taskTitle": null },
            { "kind": "project", "title": "broken" }
        ] }));
        let shown: Vec<_> = rows.iter().map(|r| (r.kind.as_str(), r.id.as_str(), r.task_id.as_deref(), r.title.as_str(), r.project.as_deref())).collect();
        assert_eq!(shown, vec![("workOrder", "w1", Some("s1"), "Fix till", Some("#WO-1")), ("project", "p1", Some("t1"), "Receipts", Some("Shop POS")), ("project", "p2", None, "Admin", None)]);
    }

    #[test]
    fn entries_read_the_enveloped_rows_with_their_project_object() {
        let now = parse_iso("2026-10-03T12:00:00Z").unwrap();
        let day = entries(&json!({ "success": true, "data": [
            { "_id": "e1", "projectId": { "_id": "p1", "code": "HP", "title": "Shop POS", "customerName": "Acme" }, "taskId": "t1", "userId": { "_id": "u1", "name": "Elek" }, "start": "2026-10-03T08:00:00Z", "end": "2026-10-03T09:00:00Z", "durationSec": 3600, "isRunning": false },
            { "_id": "e2", "projectId": { "_id": "p2", "title": "Admin" }, "start": "2026-10-03T09:00:00Z", "end": "2026-10-03T09:30:00Z", "durationSec": 120, "note": "billing", "isRunning": false },
            { "_id": "e3", "projectId": { "_id": "p2", "title": "Admin" }, "start": "2026-10-03T10:00:00Z", "end": "2026-10-03T23:00:00Z", "durationSec": 46800, "abandonedAt": "2026-10-03T23:00:00Z", "isRunning": false },
            { "_id": "e4", "projectId": { "_id": "p1", "title": "Shop POS" }, "start": "2026-10-03T11:30:00Z", "end": null, "durationSec": 0, "isRunning": true }
        ] }), now);
        assert_eq!(day.entries.iter().map(|e| e.seconds).collect::<Vec<_>>(), vec![3600, 120, 0, 1800], "a running row counts up to now");
        assert_eq!((day.total_seconds, day.entries[3].ended_at_ms, day.entries[2].abandoned), (5520, None, true));
        assert_eq!((day.entries[0].title.as_str(), day.entries[0].project.as_deref(), day.entries[1].project.as_deref()), ("Shop POS", Some("Acme"), Some("billing")));
        assert!(entries(&json!({ "success": true, "data": [] }), now).entries.is_empty());
        assert!(entries(&json!([]), now).entries.is_empty());
    }

    #[test]
    fn the_search_and_summary_answers_are_read_from_their_envelopes() {
        let hits = project_hits(&json!({ "success": true, "data": { "projects": [{ "_id": "p1", "title": "Shop POS", "code": "HP", "customerName": "Acme", "tasks": [] }, { "title": "no id" }], "pagination": { "page": 1, "limit": 6, "total": 1, "pages": 1 } } }));
        assert_eq!((hits.len(), hits[0].id.as_str(), hits[0].code.as_deref(), hits[0].customer.as_deref()), (1, "p1", Some("HP"), Some("Acme")));
        let rows = task_rows(&json!({ "success": true, "data": { "tasks": [{ "_id": "t1", "title": "Receipts", "code": "HP-1", "projectId": "p1" }, { "_id": "t2", "title": "Refunds", "projectId": { "_id": "p1", "title": "Shop POS" } }, { "_id": "t3", "projectId": "p1" }] } }));
        assert_eq!(rows, vec![("t1".into(), "p1".into(), "Receipts".into()), ("t2".into(), "p1".into(), "Refunds".into())]);
        let totals = totals(&json!({ "success": true, "data": { "ranges": {}, "day": { "totalSeconds": 60 }, "week": { "totalSeconds": 3600 }, "month": { "totalSeconds": 90000, "perUser": [] } } }));
        assert_eq!((totals.day_sec, totals.week_sec, totals.month_sec), (60, 3600, 90000));
    }

    #[test]
    fn meetings_never_carry_a_join_url() {
        let live = meetings(&json!({ "meetings": [{ "id": "m1", "title": "Standup", "channel": { "name": "general" }, "participantCount": 4, "host": { "name": "Anna" }, "startedAt": "2026-10-03T08:50:00Z", "joinUrl": "https://x.test/j#token=zzz" }] }), MeetingStatus::Live);
        assert_eq!((live[0].id.as_str(), live[0].channel.as_deref(), live[0].participants, live[0].host.as_deref()), ("m1", Some("general"), 4, Some("Anna")));
        assert!(!serde_json::to_string(&live).unwrap().contains("zzz"));
        assert_eq!(join_url(&json!({ "joinUrl": "https://x.test/j" })).as_deref(), Some("https://x.test/j"));
    }
}
