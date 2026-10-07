//! The Time Tracker's server calls: the poll (live timer every 4 s, the widgets summary about every 12 s), entries with
//! paging, the picker's server search and the new-task call. Shapes are the real backend's (`docs`: the Happy backend
//! project, task and widgets controllers); see `parse.rs`.

use std::collections::HashSet;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::time::Instant;

use super::Hub;
use crate::net::{ApiError, Kind, Method, Scope};
use crate::parse::{self, id_of, text, unwrap_data};
use crate::time::{now_ms, to_iso};
use crate::types::{TaskSearch, TimeEntry, TimeTotals, TimerPhase, TimerView, TodayView, Trackable};

/// The widgets summary carries work-order timers (the live endpoint is project-only) and task titles; it is cached on the
/// server for 30 s, so it is read about every third poll.
const SUMMARY_EVERY: Duration = Duration::from_secs(11);
/// `GET /api/projects/time-entries` answers at most 500 rows and has no offset: older rows are reached with `to=<oldest start>`.
const PAGE: usize = 500;
const MAX_PAGES: usize = 4;
const MAX_QUERY: usize = 80;
const MAX_TITLE: usize = 200;

fn same_target(a: &TimerView, b: &TimerView) -> bool {
    a.kind == b.kind && a.target_id == b.target_id && a.task_id == b.task_id
}

fn clean_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// What the poll shows, given the live project timer (`rt`), the widget timer when the summary was read this tick, and
/// what is shown now.
pub(crate) fn merge_polled(rt: TimerView, widget: Option<TimerView>, prev: &TimerView) -> TimerView {
    if rt.phase != TimerPhase::Idle {
        if let Some(w) = widget.filter(|w| w.phase != TimerPhase::Idle && same_target(w, &rt)) {
            return TimerView { title: w.title, project: w.project, can_break: w.can_break, ..rt };
        }
        if rt.project.is_none() && prev.phase != TimerPhase::Idle && same_target(prev, &rt) {
            return TimerView { title: prev.title.clone(), project: prev.project.clone(), ..rt };
        }
        return rt;
    }
    // The live endpoint knows nothing of work orders: they come from the summary, and between two summary reads the
    // last work-order state stands.
    match widget {
        Some(w) if w.kind == "workOrder" && w.phase != TimerPhase::Idle => w,
        Some(_) => TimerView::idle(),
        None if prev.kind == "workOrder" && prev.phase != TimerPhase::Idle => prev.clone(),
        None => TimerView::idle(),
    }
}

impl Hub {
    pub(super) async fn poll_timer(&self) -> Result<(), ApiError> {
        let seq = self.st().timer_seq;
        let v = self.request(Scope::Timer, Method::Get, "/api/projects/me/running-timer", &[], None).await?;
        let rt = parse::timer_from_running(&v);
        // A task timer started elsewhere has no title on the live endpoint: read the summary for it at once.
        let (due, prev) = {
            let st = self.st();
            let untitled = rt.phase != TimerPhase::Idle && rt.task_id.is_some() && !same_target(&st.timer, &rt);
            // A work-order timer exists only in the summary, so while one is shown the summary is read on every poll.
            let work_order = st.timer.kind == "workOrder" && st.timer.phase != TimerPhase::Idle;
            (untitled || work_order || st.timer_summary_at.map_or(true, |t| t.elapsed() >= SUMMARY_EVERY), st.timer.clone())
        };
        let mut widget = None;
        if due {
            let read = self.summary().await;
            // Every attempt counts, a failing summary (429, 5xx, a permanent 403) is not retried on each poll.
            self.st().timer_summary_at = Some(Instant::now());
            match read {
                Ok(s) => widget = Some(parse::timer_from_widget(&s)),
                Err(e) if e.kind == Kind::Unauthorized => return Err(e),
                // The summary is a bonus; the live read above already succeeded.
                Err(_) => {}
            }
        }
        // An action finished while this poll was in flight: its answer is newer than this read.
        if self.st().timer_seq != seq {
            return Ok(());
        }
        self.set_timer(merge_polled(rt, widget, &prev));
        Ok(())
    }

    /// The user id the entries and totals are filtered by: without `userId` the backend answers every visible user's rows, so
    /// an unknown user is asked for once (after at least 5 s since the last ask) and otherwise it is an error, never a query.
    async fn need_user(&self) -> Result<String, ApiError> {
        self.ensure_user(Some(Duration::from_secs(5)))
            .await
            .ok_or_else(|| ApiError::new(Kind::Offline, None, "userUnknown", "Your account is not loaded yet, try again in a moment"))
    }

    async fn summary(&self) -> Result<Value, ApiError> {
        let store = self.st().user.as_ref().and_then(|u| u.restaurant_id.clone());
        let query: Vec<(&str, &str)> = store.as_deref().map(|s| ("restaurantId", s)).into_iter().collect();
        self.request(Scope::Timer, Method::Get, "/api/widgets/summary", &query, None).await
    }

    /// Everything the picker offers without typing: the summary's quick-start rows.
    pub async fn timer_trackables(&self) -> Result<Vec<Trackable>, ApiError> {
        self.require(super::Id::Timer)?;
        Ok(parse::trackables(&self.summary().await?))
    }

    /// Entries of `[from_ms, to_ms)` (local days in epoch milliseconds), newest first. Windows with more than 500 rows are
    /// paged with `to=<oldest start so far>` up to four pages; `truncated` says rows older than that are missing.
    pub async fn timer_entries(&self, from_ms: i64, to_ms: i64) -> Result<TodayView, ApiError> {
        self.require(super::Id::Timer)?;
        let from = to_iso(from_ms);
        let user = self.need_user().await?;
        let now = now_ms() + self.offset();
        let (mut to, mut all, mut seen, mut truncated) = (to_ms, Vec::<TimeEntry>::new(), HashSet::<String>::new(), false);
        for page in 0..MAX_PAGES {
            let to_s = to_iso(to);
            let mut query = vec![("from", from.as_str()), ("to", to_s.as_str()), ("limit", "500")];
            query.push(("userId", user.as_str()));
            let v = self.request(Scope::Timer, Method::Get, "/api/projects/time-entries", &query, None).await?;
            let raw = unwrap_data(&v).as_array().map_or(0, Vec::len);
            let rows = parse::entries(&v, now).entries;
            let oldest = rows.iter().map(|e| e.started_at_ms).min();
            let before = all.len();
            for e in rows {
                if e.id.is_empty() || seen.insert(e.id.clone()) {
                    all.push(e);
                }
            }
            if raw < PAGE {
                break;
            }
            match oldest {
                Some(o) if o > from_ms && o < to && all.len() > before && page + 1 < MAX_PAGES => to = o,
                _ => {
                    truncated = true;
                    break;
                }
            }
        }
        all.sort_by_key(|e| std::cmp::Reverse(e.started_at_ms));
        let total_seconds = all.iter().map(|e| e.seconds).sum();
        Ok(TodayView { entries: all, total_seconds, truncated })
    }

    /// Settled totals of the current day, week and month (the starts are local midnights in epoch milliseconds).
    pub async fn timer_totals(&self, day_ms: i64, week_ms: i64, month_ms: i64) -> Result<TimeTotals, ApiError> {
        self.require(super::Id::Timer)?;
        let (day, week, month) = (to_iso(day_ms), to_iso(week_ms), to_iso(month_ms));
        let user = self.need_user().await?;
        let query = vec![("dayStart", day.as_str()), ("weekStart", week.as_str()), ("monthStart", month.as_str()), ("userId", user.as_str())];
        let v = self.request(Scope::Timer, Method::Get, "/api/projects/time-entries/summary", &query, None).await?;
        Ok(parse::totals(&v))
    }

    /// The picker's server search: projects by name/code/customer and tasks by title/code, plus the tasks of the best
    /// matching projects, each task with its project title.
    pub async fn timer_search(&self, q: &str) -> Result<TaskSearch, ApiError> {
        self.require(super::Id::Timer)?;
        let q: String = q.trim().chars().take(MAX_QUERY).collect();
        if q.is_empty() {
            return Ok(TaskSearch { projects: Vec::new(), tasks: Vec::new() });
        }
        let (by_name, by_title) = ([("search", q.as_str()), ("limit", "6")], [("q", q.as_str()), ("limit", "15")]);
        let (projects, tasks) = tokio::join!(
            self.request(Scope::Timer, Method::Get, "/api/projects", &by_name, None),
            self.request(Scope::Timer, Method::Get, "/api/tasks/autocomplete", &by_title, None),
        );
        // One half failing (say the account may not list projects) still leaves the other; both failing is the error.
        let (projects, tasks) = match (projects, tasks) {
            (Err(a), Err(_)) => return Err(a),
            (Err(e), _) | (_, Err(e)) if e.kind == Kind::Unauthorized => return Err(e),
            (p, t) => (p.map(|v| parse::project_hits(&v)).unwrap_or_default(), t.unwrap_or(Value::Null)),
        };
        let mut rows = parse::task_rows(&tasks);
        for p in projects.iter().take(2) {
            if let Ok(v) = self.request(Scope::Timer, Method::Get, "/api/tasks", &[("projectId", p.id.as_str()), ("limit", "20")], None).await {
                rows.extend(parse::task_rows(&v));
            }
        }
        let mut seen = HashSet::new();
        rows.retain(|(task_id, _, _)| seen.insert(task_id.clone()));
        for p in &projects {
            self.st().project_titles.insert(p.id.clone(), p.title.clone());
        }
        let titles = self.project_titles(rows.iter().map(|(_, project, _)| project.clone()).collect()).await;
        let tasks = rows
            .into_iter()
            .map(|(task_id, project, title)| {
                let project_title = titles.iter().find(|(id, _)| *id == project).map(|(_, t)| t.clone());
                Trackable { kind: "project".to_owned(), id: project, task_id: Some(task_id), title, project: project_title }
            })
            .collect();
        Ok(TaskSearch { projects, tasks })
    }

    /// Titles of the given project ids: cached ones at once, the rest from `GET /api/projects/{id}` (at most 8 per call).
    async fn project_titles(&self, ids: Vec<String>) -> Vec<(String, String)> {
        let mut want: Vec<String> = Vec::new();
        for id in ids {
            if clean_id(&id) && !want.contains(&id) {
                want.push(id);
            }
        }
        let missing: Vec<String> = {
            let st = self.st();
            want.iter().filter(|id| !st.project_titles.contains_key(*id)).take(8).cloned().collect()
        };
        let fetched = futures_util::future::join_all(missing.iter().map(|id| async move {
            let path = format!("/api/projects/{id}");
            let v = self.request(Scope::Timer, Method::Get, &path, &[], None).await.ok()?;
            Some((id.clone(), text(unwrap_data(&v), &["title", "name"])?))
        }))
        .await;
        let mut st = self.st();
        for (id, title) in fetched.into_iter().flatten() {
            st.project_titles.insert(id, title);
        }
        let known: Vec<(String, String)> = want.into_iter().filter_map(|id| st.project_titles.get(&id).map(|t| (id.clone(), t.clone()))).collect();
        known
    }

    /// Creates a task in a project and returns it as a start target. 400 (bad title or project), 403 and 404 reach the
    /// caller as `rejected`, `forbidden` and `notFound`; they never touch the provider state.
    pub async fn timer_create_task(&self, project_id: &str, title: &str) -> Result<Trackable, ApiError> {
        self.require(super::Id::Timer)?;
        let title = title.trim();
        if !clean_id(project_id) {
            return Err(ApiError::invalid("invalidProject", "Pick a project first"));
        }
        if title.is_empty() || title.chars().count() > MAX_TITLE {
            return Err(ApiError::invalid("invalidTitle", "Give the task a title of up to 200 characters"));
        }
        let body = json!({ "projectId": project_id, "title": title });
        let v = self.request(Scope::Timer, Method::Post, "/api/tasks", &[], Some(&body)).await?;
        let created = unwrap_data(&v);
        let task_id = id_of(created, "_id").or_else(|| text(created, &["id"])).ok_or_else(|| ApiError::invalid("badResponse", "The server did not return the new task"))?;
        let project = self.project_titles(vec![project_id.to_owned()]).await.into_iter().next().map(|(_, t)| t);
        Ok(Trackable { kind: "project".to_owned(), id: project_id.to_owned(), task_id: Some(task_id), title: text(created, &["title"]).unwrap_or_else(|| title.to_owned()), project })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(phase: TimerPhase, kind: &str, id: &str, task: Option<&str>, title: &str, project: Option<&str>) -> TimerView {
        TimerView { phase, kind: kind.into(), target_id: id.into(), task_id: task.map(Into::into), title: title.into(), project: project.map(Into::into), ..TimerView::idle() }
    }

    #[test]
    fn a_live_project_timer_wins_and_borrows_the_title_of_the_same_target() {
        let rt = view(TimerPhase::Running, "project", "p1", Some("t1"), "Shop POS", None);
        let rich = view(TimerPhase::Running, "project", "p1", Some("t1"), "Receipts", Some("Shop POS"));
        let shown = merge_polled(rt.clone(), Some(rich.clone()), &TimerView::idle());
        assert_eq!((shown.title.as_str(), shown.project.as_deref()), ("Receipts", Some("Shop POS")));
        let kept = merge_polled(rt.clone(), None, &rich);
        assert_eq!(kept.title, "Receipts", "the title survives the polls without a summary");
        let other = view(TimerPhase::Running, "project", "p2", None, "Admin", None);
        assert_eq!(merge_polled(rt, None, &other).title, "Shop POS", "a different target does not borrow");
    }

    #[test]
    fn work_order_timers_come_from_the_summary_only() {
        let wo = view(TimerPhase::Running, "workOrder", "w1", None, "#WO-1", None);
        assert_eq!(merge_polled(TimerView::idle(), Some(wo.clone()), &TimerView::idle()), wo);
        assert_eq!(merge_polled(TimerView::idle(), None, &wo), wo, "between two summaries the work order stands");
        assert_eq!(merge_polled(TimerView::idle(), Some(TimerView::idle()), &wo), TimerView::idle());
        let stale_project = view(TimerPhase::Running, "project", "p1", None, "Old", None);
        assert_eq!(merge_polled(TimerView::idle(), Some(stale_project.clone()), &TimerView::idle()), TimerView::idle(), "a cached project timer never revives a stopped one");
        assert_eq!(merge_polled(TimerView::idle(), None, &stale_project), TimerView::idle(), "a project timer stopped elsewhere clears at once");
    }
}
