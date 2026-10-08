//! Sentry's JSON to the views' types. Every function reads defensively: a field that is missing or of another type is left out,
//! never a panic, and text that will be shown (and handed to an agent) passes through the secret scrubber first.

use serde_json::Value;

use crate::types::{Actor, Breadcrumb, ContextLine, EventSummary, ExceptionInfo, Frame, Issue, Project, Tag};

const MAX_FRAMES: usize = 30;
const MAX_CRUMBS: usize = 15;
const MAX_TAGS: usize = 30;
const MAX_CONTEXT_LINES: usize = 11;

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn opt_text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// Sentry writes `count` as a string and `userCount` as a number; take either.
fn number(v: &Value, key: &str) -> u64 {
    match v.get(key) {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// Text that is shown or handed on: secret shapes masked, control characters gone, and cut to `max` characters.
fn shown(s: &str, max: usize) -> String {
    let clean: String = intely_checks::secrets::redact(s).chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').collect();
    if clean.chars().count() <= max {
        clean
    } else {
        let mut cut: String = clean.chars().take(max).collect();
        cut.push('…');
        cut
    }
}

fn id_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

pub fn project(v: &Value) -> Option<Project> {
    let id = id_of(v.get("id")?);
    (!id.is_empty()).then(|| Project { id, slug: shown(&text(v, "slug"), 80), name: shown(&opt_text(v, "name").unwrap_or_else(|| text(v, "slug")), 80) })
}

pub fn projects(v: &Value) -> Vec<Project> {
    v.as_array().map(|a| a.iter().filter_map(project).collect()).unwrap_or_default()
}

fn actor(v: &Value) -> Option<Actor> {
    if !v.is_object() {
        return None;
    }
    let id = id_of(v.get("id").unwrap_or(&Value::Null));
    let kind = shown(&opt_text(v, "type").unwrap_or_else(|| "user".to_owned()), 20);
    let name = shown(&opt_text(v, "name").or_else(|| opt_text(v, "email")).or_else(|| opt_text(v, "username")).unwrap_or_else(|| id.clone()), 80);
    (!id.is_empty() || !name.is_empty()).then_some(Actor { kind, id, name })
}

/// One issue of the list or of the detail endpoint; `None` when it has no id.
pub fn issue(v: &Value) -> Option<Issue> {
    let id = id_of(v.get("id")?);
    if id.is_empty() {
        return None;
    }
    let meta = v.get("metadata").unwrap_or(&Value::Null);
    Some(Issue {
        id,
        short_id: shown(&text(v, "shortId"), 40),
        title: shown(&text(v, "title"), 300),
        culprit: shown(&text(v, "culprit"), 200),
        level: shown(&opt_text(v, "level").unwrap_or_else(|| "error".to_owned()), 20),
        status: shown(&opt_text(v, "status").unwrap_or_else(|| "unresolved".to_owned()), 20),
        count: number(v, "count"),
        user_count: number(v, "userCount"),
        first_seen: shown(&text(v, "firstSeen"), 40),
        last_seen: shown(&text(v, "lastSeen"), 40),
        permalink: shown(&text(v, "permalink"), 400),
        project: v.get("project").and_then(project),
        assigned_to: v.get("assignedTo").and_then(actor),
        error_type: opt_text(meta, "type").map(|s| shown(&s, 120)),
        error_value: opt_text(meta, "value").map(|s| shown(&s, 400)),
        is_unhandled: v.get("isUnhandled").and_then(Value::as_bool).unwrap_or(false),
    })
}

pub fn issues(v: &Value) -> Vec<Issue> {
    v.as_array().map(|a| a.iter().filter_map(issue).collect()).unwrap_or_default()
}

/// What may stand in a `cursor` query value: Sentry's own cursors are short (`0:25:0`).
pub(crate) fn cursor_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'-' | b'_'))
}

/// The cursor of the next page from a `Link` header: `rel="next"` with `results="true"`. A cursor the next request would refuse is
/// no next page (handing it on would make "Load more" ask for the first page again).
pub fn next_cursor(link: Option<&str>) -> Option<String> {
    for part in link?.split(',') {
        let attrs = |name: &str| part.split(';').find_map(|a| a.trim().strip_prefix(&format!("{name}=")).map(|v| v.trim_matches('"').to_owned()));
        if attrs("rel").as_deref() == Some("next") && attrs("results").as_deref() == Some("true") {
            return attrs("cursor").filter(|c| cursor_ok(c));
        }
    }
    None
}

/// The id of the signed-in user from `/users/me/`, and a name to show.
pub fn me(v: &Value) -> Option<(String, String)> {
    let id = id_of(v.get("id")?);
    let name = shown(&opt_text(v, "name").or_else(|| opt_text(v, "email")).or_else(|| opt_text(v, "username")).unwrap_or_else(|| id.clone()), 80);
    (!id.is_empty()).then_some((id, name))
}

fn frame(v: &Value) -> Frame {
    let line = v.get("lineNo").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
    let context = v
        .get("context")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|r| {
                    let pair = r.as_array()?;
                    Some(ContextLine { line: u32::try_from(pair.first()?.as_u64()?).ok()?, code: shown(pair.get(1)?.as_str()?, 200) })
                })
                .take(MAX_CONTEXT_LINES)
                .collect()
        })
        .unwrap_or_default();
    Frame {
        filename: shown(&opt_text(v, "filename").or_else(|| opt_text(v, "absPath")).unwrap_or_default(), 200),
        function: shown(&text(v, "function"), 120),
        line,
        in_app: v.get("inApp").and_then(Value::as_bool).unwrap_or(false),
        context,
    }
}

fn exception(v: &Value) -> ExceptionInfo {
    let frames: Vec<Frame> = v.pointer("/stacktrace/frames").and_then(Value::as_array).map(|a| a.iter().map(frame).collect()).unwrap_or_default();
    let skip = frames.len().saturating_sub(MAX_FRAMES);
    ExceptionInfo { kind: shown(&text(v, "type"), 120), value: shown(&text(v, "value"), 600), frames: frames.into_iter().skip(skip).collect() }
}

/// The newest event of an issue, boiled down. `None` when it has no id.
pub fn event(v: &Value) -> Option<EventSummary> {
    let event_id = opt_text(v, "eventID").or_else(|| opt_text(v, "id"))?;
    let mut exceptions = Vec::new();
    let mut crumbs: Vec<Breadcrumb> = Vec::new();
    let mut request_url = None;
    for entry in v.get("entries").and_then(Value::as_array).into_iter().flatten() {
        let data = entry.get("data").unwrap_or(&Value::Null);
        match entry.get("type").and_then(Value::as_str) {
            Some("exception") => exceptions.extend(data.get("values").and_then(Value::as_array).into_iter().flatten().filter(|e| e.is_object()).map(exception)),
            Some("breadcrumbs") => {
                crumbs.extend(data.get("values").and_then(Value::as_array).into_iter().flatten().map(|c| Breadcrumb {
                    timestamp: shown(&text(c, "timestamp"), 40),
                    category: shown(&text(c, "category"), 60),
                    message: shown(&text(c, "message"), 200),
                    level: shown(&opt_text(c, "level").unwrap_or_else(|| "info".to_owned()), 20),
                }))
            }
            Some("request") => request_url = opt_text(data, "url").map(|u| shown(&u, 300)),
            _ => {}
        }
    }
    let skip = crumbs.len().saturating_sub(MAX_CRUMBS);
    let tags: Vec<Tag> = v
        .get("tags")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|t| Some(Tag { key: shown(&opt_text(t, "key")?, 80), value: shown(&text(t, "value"), 160) })).take(MAX_TAGS).collect())
        .unwrap_or_default();
    let release = v.get("release").and_then(|r| r.get("version").and_then(Value::as_str).or_else(|| r.as_str())).filter(|s| !s.is_empty()).map(|s| shown(s, 120));
    let environment = tags.iter().find(|t| t.key == "environment").map(|t| t.value.clone());
    Some(EventSummary {
        event_id,
        date_created: shown(&text(v, "dateCreated"), 40),
        platform: shown(&text(v, "platform"), 40),
        release,
        environment,
        message: shown(&opt_text(v, "message").or_else(|| opt_text(v, "title")).unwrap_or_default(), 600),
        exceptions,
        breadcrumbs: crumbs.into_iter().skip(skip).collect(),
        tags,
        request_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_issue() -> Value {
        json!({
            "id": "1234567890", "shortId": "SHOP-1A", "title": "TypeError: Cannot read properties of undefined (reading 'id')",
            "culprit": "src/api/orders.js in loadOrder", "permalink": "https://sentry.io/organizations/acme/issues/1234567890/",
            "level": "error", "status": "unresolved", "count": "152", "userCount": 17,
            "firstSeen": "2026-09-30T10:00:00.000Z", "lastSeen": "2026-10-07T20:00:00.000Z",
            "project": { "id": "5", "name": "Shop Backend", "slug": "shop-backend", "platform": "node" },
            "metadata": { "type": "TypeError", "value": "Cannot read properties of undefined (reading 'id')", "filename": "orders.js" },
            "assignedTo": { "type": "user", "id": "42", "name": "Ferenc Farkas", "email": "f@example.invalid" },
            "isUnhandled": true, "stats": { "24h": [[1, 2]] }
        })
    }

    #[test]
    fn an_issue_of_the_list_becomes_the_flat_shape() {
        let i = issue(&sample_issue()).unwrap();
        assert_eq!((i.id.as_str(), i.short_id.as_str(), i.level.as_str(), i.status.as_str()), ("1234567890", "SHOP-1A", "error", "unresolved"));
        assert_eq!((i.count, i.user_count, i.is_unhandled), (152, 17, true));
        assert_eq!(i.project, Some(Project { id: "5".into(), slug: "shop-backend".into(), name: "Shop Backend".into() }));
        assert_eq!(i.assigned_to, Some(Actor { kind: "user".into(), id: "42".into(), name: "Ferenc Farkas".into() }));
        assert_eq!((i.error_type.as_deref(), i.culprit.as_str()), (Some("TypeError"), "src/api/orders.js in loadOrder"));
    }

    #[test]
    fn missing_and_odd_fields_are_left_out_instead_of_failing() {
        let i = issue(&json!({ "id": 7, "title": "x", "count": 12, "userCount": "3", "assignedTo": null, "project": {} })).unwrap();
        assert_eq!((i.id.as_str(), i.count, i.user_count), ("7", 12, 3));
        assert_eq!((i.level.as_str(), i.status.as_str(), i.project, i.assigned_to), ("error", "unresolved", None, None));
        assert!(issue(&json!({ "title": "no id" })).is_none());
        assert!(issue(&json!("nope")).is_none());
        assert_eq!(issues(&json!({ "detail": "not a list" })), vec![]);
        assert_eq!(issues(&json!([sample_issue(), { "title": "skipped" }, sample_issue()])).len(), 2);
    }

    #[test]
    fn a_team_and_an_email_only_user_are_named() {
        let t = issue(&json!({ "id": "1", "title": "t", "assignedTo": { "type": "team", "id": "3", "name": "backend" } })).unwrap();
        assert_eq!(t.assigned_to, Some(Actor { kind: "team".into(), id: "3".into(), name: "backend".into() }));
        let u = issue(&json!({ "id": "1", "title": "t", "assignedTo": { "id": "9", "email": "a@b.invalid" } })).unwrap();
        assert_eq!(u.assigned_to.map(|a| (a.kind, a.name)), Some(("user".to_owned(), "a@b.invalid".to_owned())));
    }

    #[test]
    fn shown_text_loses_secrets_and_control_characters_and_is_cut() {
        let i = issue(&json!({ "id": "1", "title": format!("bad \u{7}token ghp_{} here", "a".repeat(36)), "culprit": "c".repeat(500) })).unwrap();
        assert!(!i.title.contains("ghp_aaaa"), "{}", i.title);
        assert!(!i.title.contains('\u{7}'));
        assert_eq!(i.culprit.chars().count(), 201);
    }

    #[test]
    fn the_next_page_comes_from_the_link_header() {
        let link = r#"<https://sentry.io/api/0/x/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <https://sentry.io/api/0/x/?cursor=0:25:0>; rel="next"; results="true"; cursor="0:25:0""#;
        assert_eq!(next_cursor(Some(link)).as_deref(), Some("0:25:0"));
        let last = r#"<u>; rel="previous"; results="true"; cursor="0:0:1", <u>; rel="next"; results="false"; cursor="0:50:0""#;
        assert_eq!(next_cursor(Some(last)), None);
        assert_eq!(next_cursor(Some("garbage")), None);
        assert_eq!(next_cursor(None), None);
        // a cursor the next request would not accept is no next page
        let odd = format!(r#"<u>; rel="next"; results="true"; cursor="{}""#, "9".repeat(65));
        assert_eq!(next_cursor(Some(&odd)), None);
        assert_eq!(next_cursor(Some(r#"<u>; rel="next"; results="true"; cursor="0:25:0&x=1""#)), None);
    }

    #[test]
    fn free_text_in_every_field_is_scrubbed_before_it_is_shown_or_put_in_a_prompt() {
        let secret = format!("ghp_{}", "b".repeat(36));
        let i = issue(&json!({
            "id": "1", "shortId": format!("X {secret}"), "level": format!("e {secret}"), "status": format!("s {secret}"),
            "firstSeen": format!("t {secret}"), "lastSeen": format!("t {secret}"),
            "permalink": format!("https://sentry.invalid/o/a/issues/1/?x={secret}"),
            "project": { "id": "5", "slug": format!("p {secret}"), "name": format!("N {secret}") },
            "assignedTo": { "type": "user", "id": "9", "name": format!("who {secret}") }
        }))
        .unwrap();
        let (project, who) = (i.project.unwrap(), i.assigned_to.unwrap());
        for text in [&i.short_id, &i.level, &i.status, &i.first_seen, &i.last_seen, &i.permalink, &project.slug, &project.name, &who.name] {
            assert!(!text.contains("ghp_bbbb"), "{text}");
        }
        let e = event(&json!({
            "eventID": "e1", "dateCreated": format!("t {secret}"), "platform": format!("p {secret}"), "release": format!("1.0 {secret}"),
            "tags": [{ "key": format!("k {secret}"), "value": "v" }],
            "entries": [{ "type": "breadcrumbs", "data": { "values": [{ "timestamp": format!("t {secret}"), "category": "c", "message": "m", "level": format!("l {secret}") }] } }]
        }))
        .unwrap();
        let c = &e.breadcrumbs[0];
        for text in [&e.date_created, &e.platform, e.release.as_ref().unwrap(), &e.tags[0].key, &c.timestamp, &c.level] {
            assert!(!text.contains("ghp_bbbb"), "{text}");
        }
        assert!(!me(&json!({ "id": "1", "name": format!("m {secret}") })).unwrap().1.contains("ghp_bbbb"));
    }

    #[test]
    fn the_signed_in_user_and_the_projects() {
        assert_eq!(me(&json!({ "id": "42", "name": "Ferenc", "email": "f@x.invalid" })), Some(("42".into(), "Ferenc".into())));
        assert_eq!(me(&json!({ "id": "42", "email": "f@x.invalid" })).map(|m| m.1), Some("f@x.invalid".into()));
        assert_eq!(me(&json!({ "detail": "no" })), None);
        assert_eq!(projects(&json!([{ "id": "1", "slug": "a", "name": "A" }, { "id": "2", "slug": "b" }, {}])).iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), vec!["A", "b"]);
    }

    fn sample_event() -> Value {
        json!({
            "eventID": "e1", "dateCreated": "2026-10-07T20:00:00Z", "platform": "node", "message": "boom",
            "release": { "version": "1.2.3" },
            "tags": [{ "key": "environment", "value": "production" }, { "key": "browser", "value": "Safari 18" }, { "value": "no key" }],
            "entries": [
                { "type": "exception", "data": { "values": [{ "type": "TypeError", "value": "x is undefined", "stacktrace": { "frames": [
                    { "filename": "node_modules/express/router.js", "function": "handle", "lineNo": 10, "inApp": false },
                    { "filename": "src/api/orders.js", "function": "loadOrder", "lineNo": 42, "inApp": true, "context": [[41, "const o = await db.find(id);"], [42, "return o.id;"], ["x", "bad"]] }
                ] } }] } },
                { "type": "breadcrumbs", "data": { "values": [{ "timestamp": "t1", "category": "http", "message": "GET /orders/7", "level": "info" }] } },
                { "type": "request", "data": { "url": "https://shop.example.invalid/orders/7", "method": "GET" } }
            ]
        })
    }

    #[test]
    fn the_latest_event_keeps_the_stack_the_crumbs_the_tags_and_the_environment() {
        let e = event(&sample_event()).unwrap();
        assert_eq!((e.event_id.as_str(), e.platform.as_str(), e.release.as_deref(), e.environment.as_deref()), ("e1", "node", Some("1.2.3"), Some("production")));
        assert_eq!(e.tags.len(), 2, "a tag without a key is dropped");
        assert_eq!(e.exceptions.len(), 1);
        let ex = &e.exceptions[0];
        assert_eq!((ex.kind.as_str(), ex.value.as_str(), ex.frames.len()), ("TypeError", "x is undefined", 2));
        assert!(ex.frames[1].in_app && !ex.frames[0].in_app);
        assert_eq!((ex.frames[1].line, ex.frames[1].context.len()), (Some(42), 2));
        assert_eq!(ex.frames[1].context[1], ContextLine { line: 42, code: "return o.id;".into() });
        assert_eq!(e.breadcrumbs.len(), 1);
        assert_eq!(e.request_url.as_deref(), Some("https://shop.example.invalid/orders/7"));
    }

    #[test]
    fn long_stacks_and_trails_are_cut_from_the_old_end() {
        let frames: Vec<Value> = (0..50).map(|i| json!({ "filename": format!("f{i}.js"), "lineNo": i, "inApp": true })).collect();
        let crumbs: Vec<Value> = (0..40).map(|i| json!({ "timestamp": format!("t{i}"), "message": "m" })).collect();
        let e = event(&json!({ "id": "e", "entries": [
            { "type": "exception", "data": { "values": [{ "type": "E", "value": "v", "stacktrace": { "frames": frames } }] } },
            { "type": "breadcrumbs", "data": { "values": crumbs } }
        ] })).unwrap();
        assert_eq!(e.exceptions[0].frames.len(), 30);
        assert_eq!(e.exceptions[0].frames.last().unwrap().filename, "f49.js", "the failing call is the last one and stays");
        assert_eq!(e.exceptions[0].frames[0].filename, "f20.js");
        assert_eq!((e.breadcrumbs.len(), e.breadcrumbs[0].timestamp.as_str(), e.breadcrumbs.last().unwrap().timestamp.as_str()), (15, "t25", "t39"));
    }

    #[test]
    fn an_event_without_an_id_is_nothing() {
        assert!(event(&json!({ "message": "x" })).is_none());
        assert!(event(&json!([])).is_none());
    }
}
