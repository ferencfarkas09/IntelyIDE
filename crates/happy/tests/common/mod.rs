//! Shared test rig: a hand-rolled loopback HTTP stub, an in-memory secret store and recording sink/opener. Nothing here
//! leaves 127.0.0.1.
#![allow(dead_code)]

pub mod sio;

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use intely_happy::types::{ConfigPatch, Env, HappyStatus, MeetView, PrefsPatch, ProviderState, TimerView};
use intely_happy::{Hub, Opener, Sink};
use intely_settings::secrets::{MemorySecretStore, Secret, SecretStore};
use intely_settings::SettingsStore;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A login-JWT-shaped canary: it must never show up in an error, a status or a settings file.
pub const JWT: &str = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzEiLCJkaWQiOiJ0ZXN0In0.Y2FuYXJ5LXNpZ25hdHVyZS12YWx1ZS0wMDAx";

#[derive(Debug, Clone)]
pub struct Req {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

pub struct Resp {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
}

impl Resp {
    pub fn json(status: u16, body: serde_json::Value) -> Self {
        Self { status, body: body.to_string(), headers: Vec::new() }
    }
}

type Handler = Arc<dyn Fn(&Req) -> Resp + Send + Sync>;

pub struct Stub {
    pub port: u16,
    pub requests: Arc<Mutex<Vec<Req>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Stub {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Stub {
    pub async fn start(handler: impl Fn(&Req) -> Resp + Send + Sync + 'static) -> Stub {
        Stub::start_with(handler, None).await
    }

    /// Like [`Stub::start`], and a Socket.IO WebSocket upgrade on the same port is served by `sio`.
    pub async fn start_with(handler: impl Fn(&Req) -> Resp + Send + Sync + 'static, sio: Option<sio::FakeSio>) -> Stub {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (log, handler): (_, Handler) = (Arc::clone(&requests), Arc::new(handler));
        let task = tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let (log, handler, sio) = (Arc::clone(&log), Arc::clone(&handler), sio.clone());
                tokio::spawn(async move {
                    if let Some(sio) = sio {
                        let mut head = [0u8; 16];
                        if sock.peek(&mut head).await.is_ok_and(|n| sio::is_socket_request(&head[..n])) {
                            return sio.serve(sock).await;
                        }
                    }
                    let Some(req) = read_request(&mut sock).await else { return };
                    log.lock().unwrap().push(req.clone());
                    let resp = handler(&req);
                    let reason = if resp.status == 200 { "OK" } else { "Status" };
                    let mut head = format!("HTTP/1.1 {} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n", resp.status, resp.body.len());
                    for (k, v) in &resp.headers {
                        head.push_str(&format!("{k}: {v}\r\n"));
                    }
                    let _ = sock.write_all(format!("{head}\r\n{}", resp.body).as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        Stub { port, requests, task }
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    pub fn paths(&self) -> Vec<String> {
        self.requests.lock().unwrap().iter().map(|r| format!("{} {}", r.method, r.path)).collect()
    }
}

async fn read_request(sock: &mut tokio::net::TcpStream) -> Option<Req> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    let head_end = loop {
        let n = sock.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.lines();
    let mut first = lines.next()?.split(' ');
    let (method, target) = (first.next()?.to_owned(), first.next()?.to_owned());
    let headers: HashMap<String, String> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned())).collect();
    let want: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    while buf.len() < head_end + 4 + want {
        let n = sock.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = String::from_utf8_lossy(&buf[(head_end + 4).min(buf.len())..]).into_owned();
    let (path, query) = target.split_once('?').map_or((target.clone(), String::new()), |(p, q)| (p.to_owned(), q.to_owned()));
    Some(Req { method, path, query, headers, body })
}

#[derive(Default)]
pub struct RecordingSink {
    pub states: Mutex<Vec<HappyStatus>>,
    pub timers: Mutex<Vec<TimerView>>,
    pub meetings: Mutex<Vec<MeetView>>,
    pub chats: Mutex<Vec<intely_happy::types::ChatEvent>>,
}

impl Sink for RecordingSink {
    fn state(&self, s: &HappyStatus) {
        self.states.lock().unwrap().push(s.clone());
    }
    fn timer(&self, t: &TimerView) {
        self.timers.lock().unwrap().push(t.clone());
    }
    fn meetings(&self, m: &MeetView) {
        self.meetings.lock().unwrap().push(m.clone());
    }
    fn chat(&self, e: &intely_happy::types::ChatEvent) {
        self.chats.lock().unwrap().push(e.clone());
    }
}

#[derive(Default)]
pub struct RecordingOpener {
    pub opened: Mutex<Vec<String>>,
}

impl Opener for RecordingOpener {
    fn open(&self, url: &str) -> Result<(), String> {
        self.opened.lock().unwrap().push(url.to_owned());
        Ok(())
    }
}

pub struct Rig {
    pub hub: Hub,
    pub sink: Arc<RecordingSink>,
    pub opener: Arc<RecordingOpener>,
    pub secrets: Arc<MemorySecretStore>,
    pub settings_path: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

impl Rig {
    /// A hub on a throwaway settings file and an in-memory secret store, pointed at `stub` as a custom environment.
    pub async fn new(stub: &Stub) -> Rig {
        Rig::at(stub.url()).await
    }

    pub async fn at(url: String) -> Rig {
        Rig::at_with(url, intely_happy::Timing::default()).await
    }

    /// A rig whose socket reconnects quickly (tests of the reconnect policy).
    pub async fn fast(url: String) -> Rig {
        Rig::at_with(url, intely_happy::Timing { backoff_base: Duration::from_millis(60), backoff_max: Duration::from_millis(250), handshake: Duration::from_secs(3) }).await
    }

    pub async fn at_with(url: String, timing: intely_happy::Timing) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let settings_path = dir.path().join("settings.json");
        let settings = Arc::new(SettingsStore::open(&settings_path).unwrap());
        let secrets = Arc::new(MemorySecretStore::new());
        let (sink, opener) = (Arc::new(RecordingSink::default()), Arc::new(RecordingOpener::default()));
        let hub = Hub::with_timing(settings, Arc::clone(&secrets) as Arc<dyn SecretStore>, Arc::clone(&sink) as Arc<dyn Sink>, Arc::clone(&opener) as Arc<dyn Opener>, (*intely_core::jail::Jail::global()).clone(), timing);
        let rig = Rig { hub, sink, opener, secrets, settings_path, _dir: dir };
        rig.hub.set_config(ConfigPatch { env: Some(Env::Custom), custom_base_url: Some(url), ..Default::default() }).await.unwrap();
        rig
    }

    pub fn give_token(&self) {
        self.secrets.set("happy.token.custom", Secret::new(JWT)).unwrap();
    }

    pub async fn switch_on(&self, timer: bool, meet: bool) {
        let prefs = |on| Some(PrefsPatch { enabled: Some(on), ..Default::default() });
        self.hub.set_config(ConfigPatch { master: Some(true), timer: prefs(timer), meet: prefs(meet), ..Default::default() }).await.unwrap();
    }

    pub async fn switch_chat(&self, chat: bool, meet: bool) {
        let prefs = |on| Some(PrefsPatch { enabled: Some(on), ..Default::default() });
        self.hub.set_config(ConfigPatch { master: Some(true), chat: prefs(chat), meet: prefs(meet), ..Default::default() }).await.unwrap();
    }

    pub async fn state_of(&self, id: &str) -> ProviderState {
        self.hub.status().await.providers.into_iter().find(|p| p.id == id).unwrap().state
    }

    pub async fn wait_state(&self, id: &str, want: ProviderState) {
        for _ in 0..250 {
            if self.state_of(id).await == want {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("{id} did not reach {want:?} within 5 s: {:?}", self.hub.status().await.providers);
    }
}

pub async fn wait_for<F, Fut>(mut cond: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    for _ in 0..250 {
        if cond().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("condition not reached within 5 s");
}

/// The happy path of every endpoint the providers use, shaped like the mock server's fixtures.
pub fn fixtures(req: &Req) -> Resp {
    use serde_json::json;
    if req.headers.get("authorization").map(String::as_str) != Some(&format!("Bearer {JWT}")) {
        return Resp::json(401, json!({ "code": "DEVICE_LOGGED_OUT", "message": "Session revoked" }));
    }
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/user/me") => Resp::json(200, json!({ "id": "u_1", "name": "Teszt Elek", "effectiveRoles": ["admin"], "restaurants": [{ "id": "r_1", "name": "Demo Gastro" }] })),
        ("GET", "/api/projects/me/running-timer") => Resp::json(200, json!({ "success": true, "data": { "running": { "_id": "e_run", "projectId": "p_pos", "projectTitle": "Shop POS", "taskId": "t_receipts", "start": "2026-10-03T08:00:00Z", "durationSec": 0, "billable": true }, "paused": null } })),
        ("GET", "/api/widgets/summary") => Resp::json(200, json!({ "timer": { "kind": "project", "id": "p_pos", "title": "Shop POS", "projectTitle": "Shop POS", "taskId": "t_receipts", "taskTitle": "Receipts", "customerName": null, "startedAt": "2026-10-03T08:00:00Z", "state": "running", "segmentType": null, "workSeconds": null, "breakSeconds": null, "pausedElapsedSeconds": null, "canBreak": false, "canPause": true }, "trackables": [{ "kind": "project", "id": "p_pos", "title": "Shop POS", "subtitle": null, "taskId": "t_receipts", "taskTitle": "Receipts" }] })),
        ("GET", "/api/notifications/badge") => Resp::json(200, json!({ "notifications": 0, "mail": 0, "total": 0 })),
        ("GET", "/api/notifications") => Resp::json(200, json!({ "docs": [], "total": 0, "limit": 30, "page": 1, "pages": 0 })),
        ("GET", "/api/tasks") => Resp::json(200, json!({ "tasks": [] })),
        ("GET", "/api/tasks/statuses") => Resp::json(200, json!({ "statuses": [] })),
        ("GET", "/api/chat/bootstrap") => Resp::json(200, json!({ "channels": [], "unreadTotal": 0, "mentionTotal": 0, "restaurantId": "r_1", "credits": 5, "permissions": { "createChannel": true } })),
        ("GET", "/api/chat/threads") => Resp::json(200, json!({ "items": [] })),
        ("GET", "/api/chat/meetings") if req.query.contains("live") => Resp::json(200, json!({ "meetings": [{ "id": "m_live_1", "title": "Standup", "channel": { "name": "general" }, "participantCount": 4, "host": { "name": "Anna" }, "startedAt": "2026-10-03T08:50:00Z" }] })),
        ("GET", "/api/chat/meetings") => Resp::json(200, json!({ "meetings": [] })),
        ("POST", "/api/chat/meetings/m_live_1/join") => Resp::json(200, json!({ "joinUrl": "https://meet.example.test/meet/join#server=wss://lk.example.test&token=LIVEKIT-CANARY" })),
        ("POST", "/api/widgets/timer/stop") => Resp::json(404, json!({ "code": "no_running_timer" })),
        _ => Resp::json(404, json!({ "code": "not_found" })),
    }
}
