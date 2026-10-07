//! The shared realtime connection: one hand-written Engine.IO v4 / Socket.IO v5 client over `tokio-tungstenite`, reference
//! counted by the providers that want live events (chat, meet).
//!
//! Why hand-written (spike, 2026-10-03): the protocol subset the plan needs is tiny (a WebSocket-only transport, the
//! `0 open / 2 ping / 3 pong / 40 connect(auth) / 42 event` frames), `rust_socketio` would add its own reqwest and runtime
//! stack plus a `serde`-less payload type, and a hand-written client puts the auth payload and the reconnect policy under our
//! control (the token is built into one frame and never logged). The frames are verified against the real `socket.io` npm
//! server in `scripts/mock-happy` (`cargo test -p intely-happy --test mock_server -- --ignored`).
//!
//! Zero cost when off: [`Realtime::new`] spawns nothing and opens nothing; the connection task exists only while at least one
//! owner is registered through [`Realtime::sync`]. The server's field names and event names are the plan's guesses
//! ((design notes: integrations-plan) 2.2) until the real service is probed.

use std::collections::BTreeSet;
use std::fmt;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use intely_settings::Secret;
use reqwest::Url;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Error as WsError, Message};

use crate::net::{ApiError, Kind};
use crate::types::ChatLink;

const MAX_FRAME: usize = 1024 * 1024;

/// Reconnect and handshake timing; the defaults are the plan's (1 s -> 30 s with jitter), tests shorten them.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub backoff_base: Duration,
    pub backoff_max: Duration,
    pub handshake: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self { backoff_base: Duration::from_secs(1), backoff_max: Duration::from_secs(30), handshake: Duration::from_secs(10) }
    }
}

/// `base * 2^(attempt-1)`, capped, plus up to 30 % jitter.
pub fn reconnect_delay(timing: &Timing, attempt: u32, jitter: f64) -> Duration {
    let exp = 2f64.powi(attempt.saturating_sub(1).min(16) as i32);
    let secs = (timing.backoff_base.as_secs_f64() * exp).min(timing.backoff_max.as_secs_f64());
    Duration::from_secs_f64(secs * (1.0 + 0.3 * jitter.clamp(0.0, 1.0)))
}

fn jitter() -> f64 {
    f64::from(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos()) % 1000) / 1000.0
}

/// Everything the connection needs. `Debug` never prints the token.
#[derive(Clone)]
pub struct Target {
    pub base: Url,
    pub token: Secret,
    pub user_id: String,
    pub user_name: String,
}

impl fmt::Debug for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Target").field("host", &self.base.host_str()).field("user_id", &self.user_id).field("token", &"***").finish()
    }
}

impl Target {
    fn same_connection(&self, other: &Target) -> bool {
        self.base == other.base && self.token == other.token && self.user_id == other.user_id
    }

    fn ws_url(&self) -> Option<Url> {
        let mut url = self.base.clone();
        url.set_scheme(if self.base.scheme() == "https" { "wss" } else { "ws" }).ok()?;
        url.set_path("/socket.io/");
        url.set_query(Some("EIO=4&transport=websocket"));
        Some(url)
    }

    /// The Socket.IO `auth` payload (plan 2.2: `{token, userId, name}`).
    fn auth(&self) -> Value {
        json!({ "token": self.token.expose(), "userId": self.user_id, "name": self.user_name })
    }
}

/// What the hub does with the connection's life. Called from the connection task, never with a lock of ours held.
pub trait Handler: Send + Sync + 'static {
    fn link(&self, link: ChatLink);
    /// A server event (`chat:message`, ...). Must return quickly.
    fn event(&self, name: &str, data: Value);
    /// The Socket.IO namespace is connected and `join:user` was sent. `reconnect` is false for the first connect after
    /// `sync` started the task.
    fn connected(&self, reconnect: bool);
    /// The server refused the credentials (HTTP 401 on the upgrade or a connect error): the connection is not retried.
    fn rejected(&self, err: ApiError);
}

// ---- Engine.IO v4 / Socket.IO v5 framing ----

#[derive(Debug, Clone, PartialEq)]
pub enum Packet {
    Open { ping_interval: Duration, ping_timeout: Duration },
    Ping,
    Pong,
    Close,
    Connected,
    ConnectError(String),
    Disconnect,
    Event { name: String, data: Value },
    /// Binary events, acks and anything else this client does not use.
    Ignored,
}

pub fn decode(frame: &str) -> Packet {
    let mut chars = frame.chars();
    match chars.next() {
        Some('0') => {
            let v: Value = serde_json::from_str(chars.as_str()).unwrap_or(Value::Null);
            let ms = |k: &str, d: u64| Duration::from_millis(v.get(k).and_then(Value::as_u64).unwrap_or(d).clamp(1000, 600_000));
            Packet::Open { ping_interval: ms("pingInterval", 25_000), ping_timeout: ms("pingTimeout", 20_000) }
        }
        Some('1') => Packet::Close,
        Some('2') => Packet::Ping,
        Some('3') => Packet::Pong,
        Some('4') => decode_message(chars.as_str()),
        _ => Packet::Ignored,
    }
}

fn decode_message(rest: &str) -> Packet {
    let mut chars = rest.chars();
    let Some(kind) = chars.next() else { return Packet::Ignored };
    let mut body = chars.as_str();
    // Optional namespace ("/chat,") and, for events, an ack id; this client only uses the default namespace.
    if let Some(stripped) = body.strip_prefix('/') {
        body = stripped.split_once(',').map_or("", |(_, tail)| tail);
    }
    match kind {
        '0' => Packet::Connected,
        '1' => Packet::Disconnect,
        '2' => {
            let body = body.trim_start_matches(|c: char| c.is_ascii_digit());
            match serde_json::from_str::<Value>(body) {
                Ok(Value::Array(mut args)) if matches!(args.first(), Some(Value::String(_))) => {
                    let name = args.remove(0).as_str().unwrap_or_default().to_owned();
                    Packet::Event { name, data: args.into_iter().next().unwrap_or(Value::Null) }
                }
                _ => Packet::Ignored,
            }
        }
        '4' => Packet::ConnectError(serde_json::from_str::<Value>(body).ok().and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned)).unwrap_or_default()),
        _ => Packet::Ignored,
    }
}

pub fn encode_event(name: &str, data: &Value) -> String {
    format!("42{}", json!([name, data]))
}

fn encode_connect(auth: &Value) -> String {
    format!("40{auth}")
}

/// A connect error that is about credentials ends the connection; anything else is retried.
fn rejection(message: &str) -> ApiError {
    let m = message.to_ascii_lowercase();
    if ["unauthor", "401", "token", "auth", "jwt", "revoked", "expired", "logged_out"].iter().any(|k| m.contains(k)) {
        ApiError::new(Kind::Unauthorized, Some(401), "socketUnauthorized", "The realtime connection was refused: the Happy session expired or was revoked")
    } else {
        ApiError::new(Kind::Forbidden, Some(403), "socketForbidden", "The realtime connection was refused by the server")
    }
}

fn connect_failure(e: &WsError) -> ApiError {
    // The error text can carry the URL: build our own message and never format `e`.
    if let WsError::Http(resp) = e {
        match resp.status().as_u16() {
            401 => return ApiError::new(Kind::Unauthorized, Some(401), "socketUnauthorized", "The realtime connection was refused: the Happy session expired or was revoked"),
            403 => return ApiError::new(Kind::Forbidden, Some(403), "socketForbidden", "The realtime connection was refused by the server"),
            // No Socket.IO endpoint on this host (the plan's open question: it may live on another port): do not hammer it.
            404 | 410 => return ApiError::new(Kind::NotFound, Some(404), "socketUnavailable", "The server has no realtime endpoint at this address"),
            s => return ApiError::new(Kind::Backoff, Some(s), "socketUnavailable", "The realtime server is unavailable"),
        }
    }
    ApiError::new(Kind::Offline, None, "socketOffline", "Could not open the realtime connection")
}

// ---- the shared connection ----

enum Out {
    Event(String, Value),
}

struct State {
    owners: BTreeSet<&'static str>,
    target: Option<Target>,
    task: Option<JoinHandle<()>>,
    tx: Option<mpsc::UnboundedSender<Out>>,
    link: ChatLink,
}

struct Shared {
    handler: Arc<dyn Handler>,
    timing: Timing,
    attempts: AtomicU32,
    st: Mutex<State>,
}

#[derive(Clone)]
pub struct Realtime(Arc<Shared>);

impl Shared {
    fn st(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set_link(&self, link: ChatLink) {
        let changed = {
            let mut st = self.st();
            std::mem::replace(&mut st.link, link.clone()) != link
        };
        if changed {
            self.handler.link(link);
        }
    }
}

impl Realtime {
    /// Builds nothing: no task, no socket, no runtime use.
    pub fn new(handler: Arc<dyn Handler>) -> Self {
        Self::with_timing(handler, Timing::default())
    }

    pub fn with_timing(handler: Arc<dyn Handler>, timing: Timing) -> Self {
        Realtime(Arc::new(Shared { handler, timing, attempts: AtomicU32::new(0), st: Mutex::new(State { owners: BTreeSet::new(), target: None, task: None, tx: None, link: ChatLink::Off }) }))
    }

    /// Declares who wants the socket. With no owner the task is aborted and the socket closed; with at least one, the task
    /// runs (started here when needed, or restarted when `target` names a different connection). Idempotent.
    pub fn sync(&self, owners: &[&'static str], target: Option<Target>) {
        let stop = {
            let mut st = self.0.st();
            st.owners = owners.iter().copied().collect();
            let wanted = if st.owners.is_empty() { None } else { target };
            match wanted {
                None => {
                    st.target = None;
                    st.tx = None;
                    st.task.take()
                }
                Some(target) => {
                    let alive = st.task.as_ref().is_some_and(|t| !t.is_finished());
                    if alive && st.target.as_ref().is_some_and(|t| t.same_connection(&target)) {
                        return;
                    }
                    let old = st.task.take();
                    let (tx, rx) = mpsc::unbounded_channel();
                    st.tx = Some(tx);
                    st.target = Some(target.clone());
                    st.link = ChatLink::Connecting;
                    let shared = Arc::clone(&self.0);
                    st.task = Some(tokio::spawn(run(shared, target, rx)));
                    drop(st);
                    if let Some(old) = old {
                        old.abort();
                    }
                    self.0.handler.link(ChatLink::Connecting);
                    return;
                }
            }
        };
        if let Some(task) = stop {
            task.abort();
        }
        self.0.set_link(ChatLink::Off);
    }

    pub fn link(&self) -> ChatLink {
        self.0.st().link.clone()
    }

    pub fn is_live(&self) -> bool {
        self.link() == ChatLink::Live
    }

    /// Whether a connection task exists (false whenever nobody asked for the socket).
    pub fn is_running(&self) -> bool {
        self.0.st().task.as_ref().is_some_and(|t| !t.is_finished())
    }

    pub fn owners(&self) -> Vec<&'static str> {
        self.0.st().owners.iter().copied().collect()
    }

    /// How many times a connection was attempted (tests).
    pub fn attempts(&self) -> u32 {
        self.0.attempts.load(Ordering::Relaxed)
    }

    /// Sends an event if the socket is live; nothing is queued otherwise (a typing hint is worthless later).
    pub fn emit(&self, event: &str, data: Value) -> bool {
        let st = self.0.st();
        st.link == ChatLink::Live && st.tx.as_ref().is_some_and(|tx| tx.send(Out::Event(event.to_owned(), data)).is_ok())
    }
}

/// A session that stayed live this long counts as healthy: the next drop starts the backoff over. A shorter one (a proxy
/// that accepts and drops at once) keeps growing it.
const HEALTHY_AFTER: Duration = Duration::from_secs(30);

fn failures_after(failures: u32, was_live: bool, lived: Duration) -> u32 {
    if was_live && lived >= HEALTHY_AFTER { 1 } else { failures.saturating_add(1) }
}

enum Ended {
    /// The credentials were refused; do not retry.
    Rejected(ApiError),
    /// The connection was live (or at least handshaken) and dropped.
    Dropped { was_live: bool },
}

async fn run(shared: Arc<Shared>, target: Target, mut rx: mpsc::UnboundedReceiver<Out>) {
    let mut failures = 0u32;
    let mut reconnect = false;
    loop {
        shared.attempts.fetch_add(1, Ordering::Relaxed);
        shared.set_link(if reconnect { ChatLink::Reconnecting } else { ChatLink::Connecting });
        let started = Instant::now();
        match session(&shared, &target, &mut rx, reconnect).await {
            Ended::Rejected(err) => {
                shared.set_link(ChatLink::Off);
                shared.handler.rejected(err);
                return;
            }
            Ended::Dropped { was_live } => {
                failures = failures_after(failures, was_live, started.elapsed());
                reconnect = true;
            }
        }
        shared.set_link(ChatLink::Reconnecting);
        tokio::time::sleep(reconnect_delay(&shared.timing, failures, jitter())).await;
        while rx.try_recv().is_ok() {}
    }
}

async fn next_text<S>(ws: &mut S, deadline: Instant) -> Result<Option<String>, ()>
where
    S: futures_util::Stream<Item = Result<Message, WsError>> + Unpin,
{
    loop {
        match tokio::time::timeout_at(deadline, ws.next()).await {
            Err(_) | Ok(None | Some(Err(_))) => return Err(()),
            Ok(Some(Ok(Message::Text(t)))) => return Ok(Some(t.as_str().to_owned())),
            Ok(Some(Ok(Message::Close(_)))) => return Ok(None),
            Ok(Some(Ok(_))) => {}
        }
    }
}

async fn session(shared: &Shared, target: &Target, rx: &mut mpsc::UnboundedReceiver<Out>, reconnect: bool) -> Ended {
    let dropped = |was_live| Ended::Dropped { was_live };
    let Some(mut request) = target.ws_url().and_then(|u| u.as_str().into_client_request().ok()) else { return dropped(false) };
    // The same token as the REST calls, for servers that check the upgrade request itself; the Socket.IO `auth` frame below
    // is what the plan expects. The header value is built last and never logged.
    if let Ok(mut value) = HeaderValue::from_str(&format!("Bearer {}", target.token.expose())) {
        value.set_sensitive(true);
        request.headers_mut().insert(AUTHORIZATION, value);
    }
    let config = WebSocketConfig::default().max_message_size(Some(MAX_FRAME)).max_frame_size(Some(MAX_FRAME));
    let connect = tokio_tungstenite::connect_async_with_config(request, Some(config), false);
    let mut ws = match tokio::time::timeout(shared.timing.handshake, connect).await {
        Ok(Ok((ws, _))) => ws,
        Ok(Err(e)) => {
            let err = connect_failure(&e);
            return if matches!(err.kind, Kind::Unauthorized | Kind::Forbidden | Kind::NotFound) { Ended::Rejected(err) } else { dropped(false) };
        }
        Err(_) => return dropped(false),
    };
    let deadline = Instant::now() + shared.timing.handshake;
    let (ping_interval, ping_timeout) = match next_text(&mut ws, deadline).await.map(|t| t.map(|t| decode(&t))) {
        Ok(Some(Packet::Open { ping_interval, ping_timeout })) => (ping_interval, ping_timeout),
        _ => return dropped(false),
    };
    if ws.send(Message::text(encode_connect(&target.auth()))).await.is_err() {
        return dropped(false);
    }
    loop {
        match next_text(&mut ws, deadline).await.map(|t| t.map(|t| decode(&t))) {
            Ok(Some(Packet::Connected)) => break,
            Ok(Some(Packet::ConnectError(message))) => {
                let err = rejection(&crate::redact::redact_with(&message, target.token.expose()));
                return Ended::Rejected(err);
            }
            Ok(Some(Packet::Ping)) => {
                if ws.send(Message::text("3")).await.is_err() {
                    return dropped(false);
                }
            }
            Ok(Some(_)) => {}
            _ => return dropped(false),
        }
    }
    if ws.send(Message::text(encode_event("join:user", &json!(target.user_id)))).await.is_err() {
        return dropped(false);
    }
    shared.set_link(ChatLink::Live);
    shared.handler.connected(reconnect);
    // The server pings every `ping_interval`; silence for interval + timeout (plus slack) means the socket is dead.
    let silence = ping_interval + ping_timeout + Duration::from_secs(1);
    let mut last_seen = Instant::now();
    loop {
        tokio::select! {
            frame = tokio::time::timeout_at(last_seen + silence, ws.next()) => {
                let Ok(Some(Ok(msg))) = frame else { return dropped(true) };
                last_seen = Instant::now();
                match msg {
                    Message::Text(t) => match decode(t.as_str()) {
                        Packet::Ping => {
                            if ws.send(Message::text("3")).await.is_err() {
                                return dropped(true);
                            }
                        }
                        Packet::Event { name, data } => shared.handler.event(&name, data),
                        Packet::Close | Packet::Disconnect => return dropped(true),
                        Packet::ConnectError(_) => return dropped(true),
                        _ => {}
                    },
                    Message::Close(_) => return dropped(true),
                    _ => {}
                }
            }
            out = rx.recv() => {
                let Some(Out::Event(name, data)) = out else { return dropped(true) };
                if ws.send(Message::text(encode_event(&name, &data))).await.is_err() {
                    return dropped(true);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_session_live_for_half_a_minute_resets_the_backoff() {
        assert_eq!(failures_after(4, true, Duration::from_secs(120)), 1, "a healthy session starts over");
        assert_eq!(failures_after(1, true, Duration::from_secs(1)), 2, "accepted and dropped at once keeps growing");
        assert_eq!(failures_after(2, false, Duration::from_secs(120)), 3);
        assert_eq!(failures_after(u32::MAX, false, Duration::ZERO), u32::MAX);
    }

    #[test]
    fn frames_decode_to_packets() {
        assert_eq!(decode(r#"0{"sid":"x","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}"#), Packet::Open { ping_interval: Duration::from_secs(25), ping_timeout: Duration::from_secs(20) });
        assert_eq!((decode("2"), decode("3"), decode("1")), (Packet::Ping, Packet::Pong, Packet::Close));
        assert_eq!(decode(r#"40{"sid":"abc"}"#), Packet::Connected);
        assert_eq!(decode(r#"44{"message":"unauthorized"}"#), Packet::ConnectError("unauthorized".to_owned()));
        assert_eq!(decode("41"), Packet::Disconnect);
        assert_eq!(decode(r#"42["chat:message",{"id":"m1"}]"#), Packet::Event { name: "chat:message".to_owned(), data: json!({ "id": "m1" }) });
        assert_eq!(decode(r#"42/chat,12["x",1]"#), Packet::Event { name: "x".to_owned(), data: json!(1) }, "namespace and ack id are skipped");
        assert_eq!(decode(r#"42["ping-only"]"#), Packet::Event { name: "ping-only".to_owned(), data: Value::Null });
        for ignored in ["", "5", "451-[\"b\",{\"_placeholder\":true,\"num\":0}]", "42not json", "42{}", "43[1]", "9"] {
            assert_eq!(decode(ignored), Packet::Ignored, "{ignored}");
        }
    }

    #[test]
    fn frames_encode_as_socket_io_text() {
        assert_eq!(encode_event("join:user", &json!("u_1")), r#"42["join:user","u_1"]"#);
        assert_eq!(encode_connect(&json!({ "a": 1 })), r#"40{"a":1}"#);
    }

    #[test]
    fn the_url_is_ws_on_the_same_host_and_the_target_never_prints_its_token() {
        let t = Target { base: Url::parse("http://127.0.0.1:4010").unwrap(), token: Secret::new("TOKEN-CANARY-1234"), user_id: "u_1".into(), user_name: "Elek".into() };
        assert_eq!(t.ws_url().unwrap().as_str(), "ws://127.0.0.1:4010/socket.io/?EIO=4&transport=websocket");
        let https = Target { base: Url::parse("https://api.example.test").unwrap(), ..t.clone() };
        assert_eq!(https.ws_url().unwrap().scheme(), "wss");
        assert!(!format!("{t:?}").contains("CANARY") && !format!("{t:?}").contains("4010/socket"));
        assert_eq!(t.auth(), json!({ "token": "TOKEN-CANARY-1234", "userId": "u_1", "name": "Elek" }));
    }

    #[test]
    fn the_reconnect_delay_doubles_to_thirty_seconds_with_jitter() {
        let t = Timing::default();
        let s = |n| reconnect_delay(&t, n, 0.0).as_secs_f64();
        assert_eq!((s(1), s(2), s(3), s(6), s(40)), (1.0, 2.0, 4.0, 30.0, 30.0));
        assert!(reconnect_delay(&t, 1, 1.0) > Duration::from_secs(1) && reconnect_delay(&t, 1, 1.0) <= Duration::from_millis(1300));
    }

    #[test]
    fn connect_errors_about_credentials_are_rejections_and_the_text_is_not_echoed() {
        let e = rejection("jwt expired eyJhbGciOiJIUzI1NiJ9.abc.def");
        assert_eq!((e.kind, e.code.as_str()), (Kind::Unauthorized, "socketUnauthorized"));
        assert!(!e.message.contains("eyJ"));
        assert_eq!(rejection("nope").kind, Kind::Forbidden);
    }
}
