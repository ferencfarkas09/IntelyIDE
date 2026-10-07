//! Notifications inbox and My tasks against a loopback stub: zero cost when off, the focused poll, mark read, the
//! 401/403 policy, tolerant tasks, and the token canary. Nothing here leaves 127.0.0.1.

mod common;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{wait_for, RecordingOpener, Req, Resp, Stub, JWT};
use intely_happy::types::{ConfigPatch, Env, HappyStatus, MeetView, PrefsPatch, ProviderState, TimerView};
use intely_happy::notifications::NotificationsView;
use intely_happy::tasks::TasksView;
use intely_happy::{Hub, Opener, Sink};
use intely_settings::secrets::{MemorySecretStore, Secret, SecretStore};
use intely_settings::SettingsStore;
use serde_json::json;

#[derive(Default)]
struct NtSink {
    inbox: Mutex<Vec<NotificationsView>>,
    tasks: Mutex<Vec<TasksView>>,
}

impl Sink for NtSink {
    fn state(&self, _: &HappyStatus) {}
    fn timer(&self, _: &TimerView) {}
    fn meetings(&self, _: &MeetView) {}
    fn notifications(&self, v: &NotificationsView) {
        self.inbox.lock().unwrap().push(v.clone());
    }
    fn tasks(&self, v: &TasksView) {
        self.tasks.lock().unwrap().push(v.clone());
    }
}

struct Rig {
    hub: Hub,
    sink: Arc<NtSink>,
    secrets: Arc<MemorySecretStore>,
    _dir: tempfile::TempDir,
}

impl Rig {
    async fn new(stub: &Stub) -> Rig {
        Rig::at(stub.url()).await
    }

    async fn at(url: String) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(SettingsStore::open(&dir.path().join("settings.json")).unwrap());
        let secrets = Arc::new(MemorySecretStore::new());
        let sink = Arc::new(NtSink::default());
        let hub = Hub::new(settings, Arc::clone(&secrets) as Arc<dyn SecretStore>, Arc::clone(&sink) as Arc<dyn Sink>, Arc::new(RecordingOpener::default()) as Arc<dyn Opener>);
        hub.set_config(ConfigPatch { env: Some(Env::Custom), custom_base_url: Some(url), ..Default::default() }).await.unwrap();
        Rig { hub, sink, secrets, _dir: dir }
    }

    fn give_token(&self) {
        self.secrets.set("happy.token.custom", Secret::new(JWT)).unwrap();
    }

    async fn switch(&self, master: bool, inbox: bool, tasks: bool, actions: bool) {
        let prefs = |on| Some(PrefsPatch { enabled: Some(on), allow_actions: Some(actions), ..Default::default() });
        self.hub.set_config(ConfigPatch { master: Some(master), notifications: prefs(inbox), tasks: prefs(tasks), ..Default::default() }).await.unwrap();
    }

    async fn state_of(&self, id: &str) -> ProviderState {
        self.hub.status().await.providers.into_iter().find(|p| p.id == id).unwrap().state
    }

    async fn wait_state(&self, id: &str, want: ProviderState) {
        wait_for(|| async { self.state_of(id).await == want }).await;
    }
}

/// Happy path for everything the two providers use. `unread` is the badge the stub reports.
fn app(unread: Arc<AtomicU32>) -> impl Fn(&Req) -> Resp + Send + Sync + 'static {
    move |req| {
        if req.headers.get("authorization").map(String::as_str) != Some(&format!("Bearer {JWT}")) {
            return Resp::json(401, json!({ "code": "DEVICE_LOGGED_OUT", "message": "Session revoked" }));
        }
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api/user/me") => Resp::json(200, json!({ "id": "u_1", "name": "Teszt Elek", "effectiveRoles": ["admin"], "restaurants": [{ "id": "r_1", "name": "Demo Gastro" }] })),
            ("GET", "/api/notifications/badge") => Resp::json(200, json!({ "notifications": unread.load(Ordering::SeqCst), "mail": 5, "total": unread.load(Ordering::SeqCst) + 5 })),
            ("GET", "/api/notifications") => Resp::json(200, json!({ "docs": [
                { "_id": "n_1", "title": "Anna mentioned you", "message": "szia", "type": "chat", "read": false, "createdAt": "2026-10-03T09:00:00Z", "metadata": { "channelId": "c_1", "messageId": "m_1", "threadRoot": "", "eventKey": "chat.message.mention" } },
                { "_id": "n_2", "title": "Deploy finished", "type": "deploy", "read": true, "createdAt": "2026-10-03T08:00:00Z" }
            ], "total": 2, "limit": 30, "page": 1, "pages": 1 })),
            ("PATCH", "/api/notifications/n_1/read") | ("PATCH", "/api/notifications/n_1/unread") | ("PATCH", "/api/notifications/read-all") => Resp::json(200, json!({ "ok": true })),
            ("DELETE", "/api/notifications/n_1") => Resp::json(200, json!({ "ok": true })),
            ("GET", "/api/tasks") => Resp::json(200, json!({ "tasks": [
                { "id": "t_1", "key": "HP-1", "title": "Receipts", "status": "s_doing", "project": { "id": "p_pos", "name": "Shop POS" } },
                { "id": "t_2", "title": "Refunds", "status": "Review", "projectName": "Shop POS", "projectId": "p_pos" }
            ] })),
            ("GET", "/api/tasks/statuses") => Resp::json(200, json!({ "statuses": [{ "id": "s_todo", "name": "To do" }, { "id": "s_doing", "name": "In progress" }] })),
            _ => Resp::json(404, json!({ "code": "not_found" })),
        }
    }
}

async fn quiet() {
    tokio::time::sleep(Duration::from_millis(300)).await;
}

#[tokio::test]
async fn switched_off_costs_nothing_even_with_a_token_and_switches_on() {
    let stub = Stub::start(app(Arc::new(AtomicU32::new(0)))).await;
    let rig = Rig::new(&stub).await;
    rig.give_token();
    rig.switch(false, true, true, true).await;
    rig.hub.start().await;
    quiet().await;
    assert_eq!((stub.count(), rig.hub.running_tasks(), rig.hub.has_client()), (0, 0, false));
    assert_eq!((rig.state_of("notifications").await, rig.state_of("tasks").await), (ProviderState::Off, ProviderState::Off));
    // Master on but both providers off: still nothing.
    rig.switch(true, false, false, true).await;
    quiet().await;
    assert_eq!((stub.count(), rig.hub.running_tasks(), rig.hub.has_client()), (0, 0, false));
    assert!(rig.sink.inbox.lock().unwrap().is_empty() && rig.sink.tasks.lock().unwrap().is_empty());
}

#[tokio::test]
async fn without_a_token_both_wait_and_nothing_is_sent() {
    let stub = Stub::start(app(Arc::new(AtomicU32::new(0)))).await;
    let rig = Rig::new(&stub).await;
    rig.switch(true, true, true, true).await;
    quiet().await;
    assert_eq!((rig.state_of("notifications").await, rig.state_of("tasks").await), (ProviderState::WaitingForToken, ProviderState::WaitingForToken));
    assert_eq!((stub.count(), rig.hub.running_tasks()), (0, 0));
}

#[tokio::test]
async fn the_inbox_polls_the_badge_then_the_list_and_stays_quiet_until_the_next_interval() {
    let unread = Arc::new(AtomicU32::new(1));
    let stub = Stub::start(app(Arc::clone(&unread))).await;
    let rig = Rig::new(&stub).await;
    rig.give_token();
    rig.switch(true, true, false, true).await;
    rig.wait_state("notifications", ProviderState::Ready).await;
    let view = rig.hub.notifications_current();
    assert_eq!((view.unread, view.items.len(), view.loaded, view.stale), (1, 2, true, false));
    assert_eq!(view.items[0].id, "n_1", "newest first");
    // The inbox owns the shared socket now (`notification:new`): the stub has none, so a refused upgrade may add a badge read.
    let paths: Vec<String> = stub.paths().into_iter().filter(|p| p.contains("notifications")).collect();
    assert_eq!(&paths[..2], ["GET /api/notifications/badge", "GET /api/notifications"]);
    assert_eq!(paths.iter().filter(|p| p.as_str() == "GET /api/notifications").count(), 1, "the list once");
    assert!(stub.requests.lock().unwrap().iter().any(|r| r.path == "/api/notifications" && r.query.contains("includeMetadata=true") && r.query.contains("limit=30")), "the list asks for the chat target (metadata)");
    assert_eq!((view.items[0].channel_id.as_deref(), view.items[0].message_id.as_deref(), view.items[0].thread_root.as_deref(), view.items[0].kind.as_deref()), (Some("c_1"), Some("m_1"), None, Some("chat")));
    let settled = stub.paths().iter().filter(|p| p.contains("notifications")).count();
    quiet().await;
    assert_eq!(stub.paths().iter().filter(|p| p.contains("notifications")).count(), settled, "the next poll is 45 s away");
    assert_eq!(rig.sink.inbox.lock().unwrap().len(), 1, "one event for one change");
    assert!(!stub.paths().iter().any(|p| p.contains("/api/tasks")), "the tasks provider is off");
}

#[tokio::test]
async fn a_poll_fetches_the_list_only_when_the_count_moved() {
    let unread = Arc::new(AtomicU32::new(1));
    let stub = Stub::start(app(Arc::clone(&unread))).await;
    let rig = Rig::new(&stub).await;
    rig.give_token();
    rig.switch(true, true, false, true).await;
    rig.wait_state("notifications", ProviderState::Ready).await;
    let lists = || stub.paths().iter().filter(|p| p.as_str() == "GET /api/notifications").count();
    assert_eq!(lists(), 1);
    rig.hub.poll_inbox().await.unwrap();
    assert_eq!(lists(), 1, "same count: badge only");
    unread.store(2, Ordering::SeqCst);
    rig.hub.poll_inbox().await.unwrap();
    assert_eq!(lists(), 2, "count moved: list again");
    assert_eq!(rig.hub.notifications_current().unread, 2);
    assert_eq!(rig.sink.inbox.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn mark_read_posts_and_updates_the_view_and_needs_allow_actions() {
    let stub = Stub::start(app(Arc::new(AtomicU32::new(1)))).await;
    let rig = Rig::new(&stub).await;
    rig.give_token();
    rig.switch(true, true, false, true).await;
    rig.wait_state("notifications", ProviderState::Ready).await;
    let view = rig.hub.notifications_mark_read("n_1").await.unwrap();
    assert_eq!((view.unread, view.items.iter().find(|i| i.id == "n_1").unwrap().read), (0, true));
    assert!(stub.paths().contains(&"PATCH /api/notifications/n_1/read".to_owned()));
    // Path tricks never reach the wire.
    let before = stub.count();
    for bad in ["../tasks", "n_1/../../me", "a%2fb", "n_1?x=1"] {
        let e = rig.hub.notifications_mark_read(bad).await.unwrap_err();
        assert_eq!(e.code, "blocked", "{bad}");
    }
    assert_eq!(stub.count(), before);
    assert!(rig.hub.notifications_mark_all_read().await.unwrap().items.iter().all(|i| i.read));
    assert!(stub.paths().contains(&"PATCH /api/notifications/read-all".to_owned()));
    let unread = rig.hub.notifications_mark_unread("n_1").await.unwrap();
    assert_eq!((unread.unread, unread.items.iter().find(|i| i.id == "n_1").unwrap().read), (1, false));
    let gone = rig.hub.notifications_delete("n_1").await.unwrap();
    assert_eq!((gone.unread, gone.items.len()), (0, 1));
    assert!(stub.paths().contains(&"DELETE /api/notifications/n_1".to_owned()));
    // With actions off, nothing mutating is sent but reading still works.
    rig.switch(true, true, false, false).await;
    let sent = stub.count();
    assert_eq!(rig.hub.notifications_mark_read("n_1").await.unwrap_err().code, "blocked");
    assert_eq!(stub.count(), sent);
    assert!(rig.hub.notifications_list().await.is_ok());
}

#[tokio::test]
async fn my_tasks_are_listed_with_statuses_reconciled_and_the_assignee_sent() {
    let stub = Stub::start(app(Arc::new(AtomicU32::new(0)))).await;
    let rig = Rig::new(&stub).await;
    rig.give_token();
    rig.switch(true, false, true, true).await;
    rig.wait_state("tasks", ProviderState::Ready).await;
    let view = rig.hub.tasks_current();
    assert!(view.loaded && !view.stale);
    assert_eq!(view.tasks.len(), 2);
    assert_eq!(view.statuses.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["To do", "In progress", "Review"], "an unknown status is added after the known ones");
    let t2 = view.tasks.iter().find(|t| t.id == "t_2").unwrap();
    assert_eq!((t2.status.as_str(), t2.project.as_deref(), t2.project_id.as_deref()), ("Review", Some("Shop POS"), Some("p_pos")));
    let tasks_req = stub.requests.lock().unwrap().iter().find(|r| r.path == "/api/tasks").cloned().unwrap();
    assert!(tasks_req.query.contains("assignee="), "{}", tasks_req.query);
    assert_eq!(rig.sink.tasks.lock().unwrap().len(), 1);
    assert!(!stub.paths().iter().any(|p| p.contains("notifications")), "the inbox provider is off");
    // Read-only: there is no verb for tasks at all.
    assert!(stub.requests.lock().unwrap().iter().all(|r| r.method == "GET"));
}

#[tokio::test]
async fn a_missing_statuses_endpoint_falls_back_to_the_tasks_own_statuses() {
    let stub = Stub::start(|req| {
        if req.headers.get("authorization").map(String::as_str) != Some(&format!("Bearer {JWT}")) {
            return Resp::json(401, json!({ "code": "DEVICE_LOGGED_OUT" }));
        }
        match req.path.as_str() {
            "/api/user/me" => Resp::json(200, json!({ "id": "u_1", "name": "X" })),
            "/api/tasks" => Resp::json(200, json!([{ "id": "a", "title": "A", "status": "Doing" }, { "id": "b", "title": "B", "status": "Done" }])),
            _ => Resp::json(404, json!({ "code": "not_found" })),
        }
    })
    .await;
    let rig = Rig::new(&stub).await;
    rig.give_token();
    rig.switch(true, false, true, true).await;
    rig.wait_state("tasks", ProviderState::Ready).await;
    let view = rig.hub.tasks_current();
    assert_eq!(view.statuses.iter().map(|s| (s.name.as_str(), s.done)).collect::<Vec<_>>(), vec![("Doing", false), ("Done", true)]);
}

#[tokio::test]
async fn a_403_makes_only_that_provider_not_permitted_and_a_401_signs_the_whole_connection_out() {
    let stub = Stub::start(|req| {
        if req.headers.get("authorization").map(String::as_str) != Some(&format!("Bearer {JWT}")) {
            return Resp::json(401, json!({ "code": "DEVICE_LOGGED_OUT" }));
        }
        match req.path.as_str() {
            "/api/user/me" => Resp::json(200, json!({ "id": "u_1", "name": "X" })),
            p if p.starts_with("/api/notifications") => Resp::json(403, json!({ "code": "forbidden_scope", "message": "no" })),
            "/api/tasks" => Resp::json(200, json!({ "tasks": [] })),
            "/api/tasks/statuses" => Resp::json(200, json!({ "statuses": [] })),
            _ => Resp::json(404, json!({ "code": "not_found" })),
        }
    })
    .await;
    let rig = Rig::new(&stub).await;
    rig.give_token();
    rig.switch(true, true, true, true).await;
    rig.wait_state("notifications", ProviderState::NotPermitted).await;
    rig.wait_state("tasks", ProviderState::Ready).await;
    let before = stub.paths().iter().filter(|p| p.contains("notifications")).count();
    quiet().await;
    assert_eq!(stub.paths().iter().filter(|p| p.contains("notifications")).count(), before, "no polling while not permitted");
    // A revoked session stops the tasks provider too.
    let revoked = Stub::start(|_| Resp::json(401, json!({ "code": "DEVICE_LOGGED_OUT", "message": "Session revoked" }))).await;
    let rig2 = Rig::new(&revoked).await;
    rig2.give_token();
    rig2.switch(true, true, true, true).await;
    rig2.wait_state("tasks", ProviderState::SignedOut).await;
    assert_eq!(rig2.state_of("notifications").await, ProviderState::SignedOut);
    assert_eq!(rig2.hub.running_tasks(), 0);
    assert!(rig2.hub.status().await.signed_out.is_some());
}

#[tokio::test]
async fn test_connection_probes_both_providers_and_nothing_leaks_the_token() {
    let stub = Stub::start(app(Arc::new(AtomicU32::new(1)))).await;
    let rig = Rig::new(&stub).await;
    let test = rig.hub.save_token(JWT).await;
    assert!(test.ok, "{test:?}");
    for id in ["notifications", "tasks"] {
        assert!(test.providers.iter().any(|p| p.id == id && p.allowed), "{id}: {:?}", test.providers);
    }
    rig.switch(true, true, true, true).await;
    rig.wait_state("notifications", ProviderState::Ready).await;
    rig.wait_state("tasks", ProviderState::Ready).await;
    let everything = format!("{:?}{:?}{:?}{:?}", rig.hub.notifications_current(), rig.hub.tasks_current(), rig.hub.status().await, test);
    assert!(!everything.contains(JWT) && !everything.contains("eyJhbGci"));
}

#[tokio::test]
async fn disconnect_clears_both_views_and_stops_the_tasks() {
    let stub = Stub::start(app(Arc::new(AtomicU32::new(1)))).await;
    let rig = Rig::new(&stub).await;
    rig.give_token();
    rig.switch(true, true, true, true).await;
    rig.wait_state("notifications", ProviderState::Ready).await;
    rig.wait_state("tasks", ProviderState::Ready).await;
    rig.hub.disconnect().await;
    assert_eq!((rig.hub.running_tasks(), rig.hub.has_client()), (0, false));
    assert_eq!(rig.hub.notifications_current(), NotificationsView::empty());
    assert_eq!(rig.hub.tasks_current(), TasksView::empty());
    assert_eq!(rig.sink.inbox.lock().unwrap().last().cloned(), Some(NotificationsView::empty()));
    assert_eq!(rig.sink.tasks.lock().unwrap().last().cloned(), Some(TasksView::empty()));
}

async fn mock_post(base: &str, path: &str, body: serde_json::Value) {
    let r = reqwest::Client::new().post(format!("{base}{path}")).header("content-type", "application/json").body(body.to_string()).send().await.expect("mock control request");
    assert!(r.status().is_success(), "{path}: {}", r.status());
}

/// Against the real mock server (scripts/mock-happy/server.mjs), like `mock_server.rs`:
///
///   node scripts/mock-happy/server.mjs --port 4011 &
///   INTELY_MOCK_HAPPY_URL=http://127.0.0.1:4011 INTELY_MOCK_HAPPY_TOKEN=<token printed by the server> \
///     cargo test -p intely-happy --test inbox_tasks -- --ignored --test-threads=1
#[tokio::test]
#[ignore = "needs scripts/mock-happy/server.mjs running"]
async fn the_hub_talks_to_the_mock_server_for_the_inbox_and_my_tasks() {
    use intely_happy::types::{TimerPhase, Trackable};

    let url = std::env::var("INTELY_MOCK_HAPPY_URL").expect("INTELY_MOCK_HAPPY_URL");
    let token = std::env::var("INTELY_MOCK_HAPPY_TOKEN").expect("INTELY_MOCK_HAPPY_TOKEN");
    assert!(url.starts_with("http://127.0.0.1:"), "the mock server is loopback only");
    mock_post(&url, "/__mock/reset", json!({})).await;
    let rig = Rig::at(url.clone()).await;
    rig.hub.set_config(ConfigPatch { master: Some(true), timer: Some(PrefsPatch { enabled: Some(true), ..Default::default() }), notifications: Some(PrefsPatch { enabled: Some(true), ..Default::default() }), tasks: Some(PrefsPatch { enabled: Some(true), ..Default::default() }), ..Default::default() }).await.unwrap();
    let test = rig.hub.save_token(&token).await;
    assert!(test.ok && test.providers.iter().all(|p| p.allowed), "{test:?}");
    rig.wait_state("notifications", ProviderState::Ready).await;
    rig.wait_state("tasks", ProviderState::Ready).await;

    let inbox = rig.hub.notifications_current();
    assert_eq!((inbox.unread, inbox.items.len(), inbox.loaded), (2, 4, true));
    assert_eq!(inbox.items[0].kind.as_deref(), Some("chat"), "newest first");
    assert!(inbox.items[0].channel_id.is_some(), "a chat notification says where it points");
    let first = inbox.items[0].id.clone();
    let after_read = rig.hub.notifications_mark_read(&first).await.unwrap();
    assert_eq!(after_read.unread, 1);
    rig.hub.poll_inbox().await.unwrap();
    assert_eq!(rig.hub.notifications_current().unread, 1, "the server agrees with the optimistic update");
    mock_post(&url, "/__mock/notify", json!({ "title": "Standup moved", "kind": "meeting" })).await;
    rig.hub.poll_inbox().await.unwrap();
    let view = rig.hub.notifications_current();
    assert_eq!((view.unread, view.items.len(), view.items[0].title.as_str()), (2, 5, "Standup moved"));
    assert_eq!(rig.sink.inbox.lock().unwrap().last().map(|v| v.unread), Some(2));
    assert_eq!(rig.hub.notifications_mark_all_read().await.unwrap().unread, 0);

    let tasks = rig.hub.tasks_current();
    assert_eq!((tasks.tasks.len(), tasks.statuses.len()), (7, 4), "the other assignee's task is not listed");
    let receipts = tasks.tasks.iter().find(|t| t.id == "t_receipts").unwrap().clone();
    assert_eq!((receipts.status.as_str(), receipts.project.as_deref(), receipts.project_id.as_deref(), receipts.key.as_deref()), ("s_doing", Some("Shop POS"), Some("p_pos"), Some("HP-142")));
    assert!(receipts.description.is_some() && receipts.due_ms.is_some());
    assert!(tasks.statuses.iter().find(|s| s.id == "s_done").unwrap().done);
    // The timer can be started on a task straight from its ids.
    let timer = rig.hub.timer_start(Trackable { kind: "project".into(), id: receipts.project_id.clone().unwrap(), task_id: Some(receipts.id.clone()), title: receipts.title.clone(), project: receipts.project.clone() }).await.unwrap();
    assert_eq!((timer.phase, timer.title.as_str()), (TimerPhase::Running, "Receipts"));
    rig.hub.timer_stop().await.unwrap();

    // A 403 on the inbox leaves the tasks alone.
    mock_post(&url, "/__mock/fail", json!({ "status": 403, "path": "/api/notifications" })).await;
    let _ = rig.hub.poll_inbox().await;
    assert_eq!(rig.hub.notifications_list().await.unwrap_err().kind, intely_happy::Kind::Forbidden);
    mock_post(&url, "/__mock/reset", json!({})).await;
    assert_eq!(rig.state_of("tasks").await, ProviderState::Ready);
}
