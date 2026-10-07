//! "My tasks" ((design notes: integrations-plan) E4): DTOs and tolerant parsing. The endpoint paths and field names are GUESSES
//! (nothing was recorded from the live API): `GET /api/tasks?assignee=<me>` and `GET /api/tasks/statuses`. Reading accepts
//! several spellings (a status as a string or an object, a project as a name or an object) and ignores unknown fields.

use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(feature = "specta")]
use specta_typescript::Number;

use crate::parse::{list, millis, number, text};

/// The task text handed to an agent is capped: it goes into a prompt the user reads before pressing Run.
const DESCRIPTION_MAX: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TaskStatus {
    pub id: String,
    pub name: String,
    pub order: u32,
    /// A finished status (done, closed, ...): the list hides these by default.
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TaskItem {
    pub id: String,
    /// Human key such as `HP-142` or a number, when the server has one.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub key: Option<String>,
    pub title: String,
    /// The status id (matches `TaskStatus.id`), or the status name when the server only sends that.
    pub status: String,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub project: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub project_id: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub priority: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    #[cfg_attr(feature = "specta", specta(type = Option<Number>))]
    pub due_ms: Option<i64>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub description: Option<String>,
    /// A repository named by the server, when it sends one; the IDE maps projects to repositories itself otherwise.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub repo: Option<String>,
}

/// Event `happy:tasks` carries the same shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TasksView {
    pub tasks: Vec<TaskItem>,
    pub statuses: Vec<TaskStatus>,
    pub loaded: bool,
    pub stale: bool,
}

impl TasksView {
    pub fn empty() -> Self {
        Self { tasks: Vec::new(), statuses: Vec::new(), loaded: false, stale: false }
    }
}

fn is_done_word(s: &str) -> bool {
    matches!(s.to_ascii_lowercase().as_str(), "done" | "closed" | "complete" | "completed" | "resolved" | "finished" | "cancelled" | "canceled" | "kész" | "lezárt")
}

fn name_of(v: &Value, keys: &[&str]) -> Option<String> {
    match v {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        Value::Object(_) => text(v, keys),
        _ => None,
    }
}

/// `GET /api/tasks/statuses` -> `{ statuses: [...] }` (or a bare array), in the server's order.
pub fn statuses(v: &Value) -> Vec<TaskStatus> {
    let rows = ["statuses", "items", "data"].iter().find_map(|k| v.get(k).and_then(Value::as_array)).map_or_else(|| list(v, "statuses"), Vec::as_slice);
    let mut out: Vec<TaskStatus> = rows
        .iter()
        .enumerate()
        .filter_map(|(i, s)| {
            let name = name_of(s, &["name", "title", "label"])?;
            let id = text(s, &["id", "_id", "key", "code"]).unwrap_or_else(|| name.clone());
            let flag = ["done", "isDone", "closed", "isClosed", "final", "isFinal"].iter().find_map(|k| s.get(k).and_then(Value::as_bool));
            let category = text(s, &["category", "type", "kind"]);
            let done = flag.unwrap_or_else(|| category.as_deref().is_some_and(is_done_word) || is_done_word(&name));
            Some(TaskStatus { id, name, order: number(s, &["order", "position", "sort"]).map_or(i as u32, |n| n.clamp(0, 100_000) as u32), done })
        })
        .collect();
    out.sort_by_key(|s| s.order);
    out
}

fn capped(s: String) -> String {
    if s.chars().count() <= DESCRIPTION_MAX {
        s
    } else {
        let mut cut: String = s.chars().take(DESCRIPTION_MAX).collect();
        cut.push('…');
        cut
    }
}

/// `GET /api/tasks?assignee=...` -> `{ tasks: [...] }` (or `items`, or a bare array).
pub fn items(v: &Value) -> Vec<TaskItem> {
    let rows = ["tasks", "items", "data"].iter().find_map(|k| v.get(k).and_then(Value::as_array)).map_or_else(|| list(v, "tasks"), Vec::as_slice);
    rows.iter()
        .filter_map(|t| {
            let id = text(t, &["id", "_id", "taskId"])?;
            let status_v = t.get("status").or_else(|| t.get("state"));
            let status = status_v
                .and_then(|s| if s.is_object() { text(s, &["id", "_id", "name"]) } else { name_of(s, &[]) })
                .or_else(|| text(t, &["statusId", "statusName"]))
                .unwrap_or_default();
            let project_v = t.get("project");
            Some(TaskItem {
                id,
                key: text(t, &["key", "code", "identifier", "number", "ticket"]),
                title: text(t, &["title", "name", "summary"]).unwrap_or_else(|| "Untitled task".to_owned()),
                status,
                project: project_v.and_then(|p| name_of(p, &["name", "title"])).or_else(|| text(t, &["projectName", "projectTitle"])),
                project_id: project_v.filter(|p| p.is_object()).and_then(|p| text(p, &["id", "_id"])).or_else(|| text(t, &["projectId"])),
                priority: t.get("priority").and_then(|p| name_of(p, &["name", "label"]).or_else(|| p.as_i64().map(|n| n.to_string()))),
                due_ms: millis(t, &["dueDate", "dueAt", "due", "deadline"]),
                description: text(t, &["description", "body", "details"]).map(capped),
                repo: text(t, &["repository", "repo", "repoName"]),
            })
        })
        .collect()
}

/// Statuses to show: the server's list, plus a synthetic one (in first-seen order, after the server's) for any status a task
/// carries that the list does not know, matched by id or by name. Tasks keep the id of the status they matched.
pub fn reconcile(mut statuses: Vec<TaskStatus>, tasks: &mut [TaskItem]) -> Vec<TaskStatus> {
    for task in tasks.iter_mut() {
        if task.status.is_empty() {
            task.status = "unknown".to_owned();
        }
        if let Some(found) = statuses.iter().find(|s| s.id == task.status).or_else(|| statuses.iter().find(|s| s.name.eq_ignore_ascii_case(&task.status))) {
            task.status = found.id.clone();
        } else {
            let order = statuses.len() as u32;
            let name = if task.status == "unknown" { "No status".to_owned() } else { task.status.clone() };
            statuses.push(TaskStatus { id: task.status.clone(), done: is_done_word(&name), name, order });
        }
    }
    statuses
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn statuses_keep_the_server_order_and_know_which_are_done() {
        let s = statuses(&json!({ "statuses": [
            { "id": "s_todo", "name": "To do", "order": 1 },
            { "id": "s_doing", "name": "In progress", "order": 2 },
            { "id": "s_done", "name": "Finished", "category": "done", "order": 3 },
            { "id": "s_x", "name": "Archived", "isDone": true, "order": 0 }
        ] }));
        assert_eq!(s.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["s_x", "s_todo", "s_doing", "s_done"]);
        assert_eq!(s.iter().map(|x| x.done).collect::<Vec<_>>(), vec![true, false, false, true]);
        assert!(statuses(&json!({})).is_empty());
    }

    #[test]
    fn tasks_accept_a_string_or_an_object_for_status_and_project() {
        let t = items(&json!({ "tasks": [
            { "id": "t1", "key": "HP-1", "title": "Receipts", "status": { "id": "s_todo", "name": "To do" }, "project": { "id": "p_pos", "name": "Shop POS" }, "priority": "high", "dueDate": "2026-10-10T00:00:00Z", "description": "Print the VAT line" },
            { "_id": "t2", "name": "Refunds", "statusId": "s_doing", "projectName": "Shop POS", "projectId": "p_pos", "number": 42, "repository": "shop-pos" },
            { "id": "t3", "title": "Plain", "status": "Done", "project": "Admin" },
            { "title": "no id is dropped" }
        ] }));
        assert_eq!(t.len(), 3);
        assert_eq!((t[0].key.as_deref(), t[0].status.as_str(), t[0].project.as_deref(), t[0].project_id.as_deref(), t[0].priority.as_deref()), (Some("HP-1"), "s_todo", Some("Shop POS"), Some("p_pos"), Some("high")));
        assert!(t[0].due_ms.is_some());
        assert_eq!((t[1].title.as_str(), t[1].status.as_str(), t[1].key.as_deref(), t[1].repo.as_deref(), t[1].project_id.as_deref()), ("Refunds", "s_doing", Some("42"), Some("shop-pos"), Some("p_pos")));
        assert_eq!((t[2].status.as_str(), t[2].project.as_deref(), t[2].project_id.as_deref()),("Done", Some("Admin"), None));
        assert!(items(&json!(null)).is_empty());
    }

    #[test]
    fn a_description_is_capped_for_the_agent_prompt() {
        let t = items(&json!([{ "id": "t", "title": "T", "description": "y".repeat(5000) }]));
        assert_eq!(t[0].description.as_deref().unwrap().chars().count(), DESCRIPTION_MAX + 1);
    }

    #[test]
    fn reconcile_matches_names_and_adds_the_statuses_the_list_does_not_know() {
        let known = statuses(&json!({ "statuses": [{ "id": "s_todo", "name": "To do" }, { "id": "s_done", "name": "Done" }] }));
        let mut tasks = items(&json!([
            { "id": "a", "title": "A", "status": "to do" },
            { "id": "b", "title": "B", "status": "Review" },
            { "id": "c", "title": "C" }
        ]));
        let all = reconcile(known, &mut tasks);
        assert_eq!(tasks.iter().map(|t| t.status.as_str()).collect::<Vec<_>>(), vec!["s_todo", "Review", "unknown"]);
        assert_eq!(all.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["To do", "Done", "Review", "No status"]);
        assert!(!all[2].done);
    }
}
