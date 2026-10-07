//! A scripted Socket.IO server for the tests: Engine.IO v4 over a real WebSocket on loopback, served from the same port as the
//! HTTP stub (so the hub's single base URL covers REST and the socket). Nothing leaves 127.0.0.1.
#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::{http, Message};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Ok,
    /// The upgrade request is answered with HTTP 401.
    Http401,
    /// The Socket.IO connect is answered with `44{"message":..}`.
    ConnectError(&'static str),
}

enum Cmd {
    Emit(String, Value),
    Raw(String),
    Drop,
}

struct St {
    mode: Mode,
    attempts: usize,
    auths: Vec<Value>,
    upgrade_auth: Vec<Option<String>>,
    received: Vec<(String, Value)>,
    conns: Vec<(usize, mpsc::UnboundedSender<Cmd>)>,
    next: usize,
}

#[derive(Clone)]
pub struct FakeSio(Arc<Mutex<St>>);

impl Default for FakeSio {
    fn default() -> Self {
        FakeSio(Arc::new(Mutex::new(St { mode: Mode::Ok, attempts: 0, auths: Vec::new(), upgrade_auth: Vec::new(), received: Vec::new(), conns: Vec::new(), next: 0 })))
    }
}

/// Whether the first bytes of a connection are a Socket.IO WebSocket upgrade.
pub fn is_socket_request(head: &[u8]) -> bool {
    head.starts_with(b"GET /socket.io/")
}

impl FakeSio {
    pub fn set_mode(&self, mode: Mode) {
        self.0.lock().unwrap().mode = mode;
    }

    /// Connection attempts that reached the server (also the refused ones).
    pub fn attempts(&self) -> usize {
        self.0.lock().unwrap().attempts
    }

    /// Sockets that are open right now.
    pub fn live(&self) -> usize {
        self.0.lock().unwrap().conns.len()
    }

    /// The `auth` payloads of every Socket.IO connect.
    pub fn auths(&self) -> Vec<Value> {
        self.0.lock().unwrap().auths.clone()
    }

    /// The `Authorization` header of every upgrade request.
    pub fn upgrade_auth(&self) -> Vec<Option<String>> {
        self.0.lock().unwrap().upgrade_auth.clone()
    }

    /// Events the client emitted: `(name, first argument)`.
    pub fn received(&self) -> Vec<(String, Value)> {
        self.0.lock().unwrap().received.clone()
    }

    pub fn emit(&self, name: &str, data: Value) {
        for (_, tx) in &self.0.lock().unwrap().conns {
            let _ = tx.send(Cmd::Emit(name.to_owned(), data.clone()));
        }
    }

    pub fn raw(&self, frame: &str) {
        for (_, tx) in &self.0.lock().unwrap().conns {
            let _ = tx.send(Cmd::Raw(frame.to_owned()));
        }
    }

    /// Closes every open socket from the server side.
    pub fn drop_all(&self) {
        for (_, tx) in &self.0.lock().unwrap().conns {
            let _ = tx.send(Cmd::Drop);
        }
    }

    pub async fn serve(self, sock: TcpStream) {
        let mode = {
            let mut st = self.0.lock().unwrap();
            st.attempts += 1;
            st.mode
        };
        let seen = Arc::clone(&self.0);
        let gate = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
            seen.lock().unwrap().upgrade_auth.push(req.headers().get("authorization").and_then(|v| v.to_str().ok()).map(str::to_owned));
            if mode == Mode::Http401 {
                return Err(http::Response::builder().status(401).body(Some("unauthorized".to_owned())).unwrap());
            }
            Ok(resp)
        };
        let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(sock, gate).await else { return };
        if ws.send(Message::text(r#"0{"sid":"fake","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}"#)).await.is_err() {
            return;
        }
        let (tx, mut rx) = mpsc::unbounded_channel();
        let id = {
            let mut st = self.0.lock().unwrap();
            st.next += 1;
            st.next
        };
        let mut registered = false;
        loop {
            tokio::select! {
                frame = ws.next() => {
                    let Some(Ok(Message::Text(t))) = frame else { break };
                    let t = t.as_str();
                    if let Some(auth) = t.strip_prefix("40") {
                        self.0.lock().unwrap().auths.push(serde_json::from_str(auth).unwrap_or(Value::Null));
                        if let Mode::ConnectError(message) = mode {
                            let _ = ws.send(Message::text(format!("44{}", json!({ "message": message })))).await;
                            break;
                        }
                        if ws.send(Message::text(r#"40{"sid":"fake-ns"}"#)).await.is_err() {
                            break;
                        }
                        if !registered {
                            registered = true;
                            self.0.lock().unwrap().conns.push((id, tx.clone()));
                        }
                    } else if let Some(body) = t.strip_prefix("42") {
                        if let Ok(Value::Array(mut args)) = serde_json::from_str::<Value>(body) {
                            let name = args.remove(0).as_str().unwrap_or_default().to_owned();
                            self.0.lock().unwrap().received.push((name, args.into_iter().next().unwrap_or(Value::Null)));
                        }
                    }
                }
                cmd = rx.recv() => match cmd {
                    Some(Cmd::Emit(name, data)) => {
                        if ws.send(Message::text(format!("42{}", json!([name, data])))).await.is_err() {
                            break;
                        }
                    }
                    Some(Cmd::Raw(frame)) => {
                        if ws.send(Message::text(frame)).await.is_err() {
                            break;
                        }
                    }
                    Some(Cmd::Drop) | None => break,
                },
            }
        }
        let _ = ws.close(None).await;
        self.0.lock().unwrap().conns.retain(|(i, _)| *i != id);
    }
}

// ---- a small stateful chat REST fixture (the real backend's shapes, `chatSerializer.js`) ----

use crate::common::{Req, Resp, JWT};

const T0: i64 = 1_790_000_000_000;

/// A message in the real wire shape.
pub fn real_message(id: &str, channel: &str, sender: &str, name: &str, text: &str, at_ms: i64) -> Value {
    json!({
        "_id": id, "channel": channel, "restaurant": "r_1",
        "sender": { "_id": sender, "name": name, "avatar": "", "isPortal": false },
        "bot": null, "kind": "text", "text": text, "systemEvent": null,
        "mentions": { "users": [], "channel": false },
        "attachments": [], "reactions": [], "recordRefs": [], "meeting": null,
        "threadRoot": null, "replyCount": 0, "lastReplyAt": null, "replyUsers": [],
        "pinned": false, "pinnedBy": null, "editedAt": null, "deletedAt": null, "clientMessageId": null,
        "createdAt": intely_happy::time::to_iso(at_ms)
    })
}

fn real_channel(id: &str, kind: &str, name: &str, unread: u32, mention: u32, peers: Value) -> Value {
    json!({
        "_id": id, "restaurant": "r_1", "type": kind, "name": name, "description": "", "topic": "", "archived": false,
        "createdBy": "u_9", "createdAt": "2026-09-01T08:00:00.000Z", "lastMessageAt": "2026-10-03T08:00:00.000Z",
        "lastMessagePreview": { "text": "hello", "senderName": "Anna", "at": "2026-10-03T08:00:00.000Z" },
        "memberCount": 3, "record": null, "customer": null, "directPeers": peers, "pinnedCount": 0,
        "me": { "role": "member", "isMember": true, "unreadCount": unread, "mentionCount": mention, "lastReadMessageId": null, "lastReadAt": null, "notifyLevel": "all", "mutedUntil": null, "starred": false, "hidden": false }
    })
}

struct ChatSt {
    credits: f64,
    /// Newest last; thread replies carry `threadRoot`.
    messages: Vec<Value>,
    sent: Vec<Value>,
    reads: Vec<String>,
    seq: usize,
    not_enabled: bool,
    forbid_create: bool,
    created: Vec<Value>,
    members: Vec<Value>,
    /// The bodies of every POST/PATCH/DELETE the chat routes saw: `(method, path, body)`.
    writes: Vec<(String, String, Value)>,
    threads_unread: u32,
}

/// Bootstrap, paged messages (oldest -> newest, `before`/`after`/`around`), idempotent send, thread replies, the thread routes,
/// read marker, directory, direct/group channels, channel create/browse/join, members. Channel `c_1` holds 120 messages by
/// `u_2`; the user is `u_1`; `m000` has two thread replies.
#[derive(Clone)]
pub struct ChatApi(Arc<Mutex<ChatSt>>);

impl ChatApi {
    pub fn new() -> Self {
        let mut messages: Vec<Value> = (0..120).map(|i| real_message(&format!("m{i:03}"), "c_1", "u_2", "Anna", &format!("hello {i}"), T0 + i * 60_000)).collect();
        messages[0]["replyCount"] = json!(2);
        messages[0]["lastReplyAt"] = json!(intely_happy::time::to_iso(T0 + 200_000));
        for (k, at) in [(0, 100_000), (1, 200_000)] {
            let mut r = real_message(&format!("r{k:03}"), "c_1", "u_2", "Anna", &format!("reply {k}"), T0 + at);
            r["threadRoot"] = json!("m000");
            messages.push(r);
        }
        let members = vec![
            json!({ "_id": "u_1", "name": "Teszt Elek", "avatar": "", "email": "elek@example.test", "role": "admin", "isPortal": false, "joinedAt": "2026-09-01T08:00:00.000Z", "online": true }),
            json!({ "_id": "u_2", "name": "Anna", "avatar": "", "email": "anna@example.test", "role": "member", "isPortal": false, "joinedAt": "2026-09-01T08:00:00.000Z" }),
        ];
        ChatApi(Arc::new(Mutex::new(ChatSt { credits: 5.0, messages, sent: Vec::new(), reads: Vec::new(), seq: 0, not_enabled: false, forbid_create: false, created: Vec::new(), members, writes: Vec::new(), threads_unread: 1 })))
    }

    pub fn set_credits(&self, credits: f64) {
        self.0.lock().unwrap().credits = credits;
    }

    /// Every chat route answers `403 TEAM_CHAT_NOT_ENABLED` (the pilot gate) while on.
    pub fn set_not_enabled(&self, on: bool) {
        self.0.lock().unwrap().not_enabled = on;
    }

    pub fn set_forbid_create(&self, on: bool) {
        self.0.lock().unwrap().forbid_create = on;
    }

    /// Messages the server stored from sends (by `clientMessageId`).
    pub fn sent(&self) -> Vec<Value> {
        self.0.lock().unwrap().sent.clone()
    }

    /// The writes the routes saw, in order: `(method, path, parsed body)`.
    pub fn writes(&self) -> Vec<(String, String, Value)> {
        self.0.lock().unwrap().writes.clone()
    }

    /// A message by someone else, stored while the client may not be listening (it is not pushed over the socket).
    pub fn add_message(&self, id: &str, text: &str) -> Value {
        let mut st = self.0.lock().unwrap();
        let m = real_message(id, "c_1", "u_2", "Anna", text, T0 + 10_000_000 + st.messages.len() as i64 * 1000);
        st.messages.push(m.clone());
        m
    }

    pub fn reads(&self) -> Vec<String> {
        self.0.lock().unwrap().reads.clone()
    }

    pub fn authed(req: &Req) -> bool {
        req.headers.get("authorization").map(String::as_str) == Some(&format!("Bearer {JWT}"))
    }

    /// The chat routes; `None` for any other path.
    pub fn handle(&self, req: &Req) -> Option<Resp> {
        if !req.path.starts_with("/api/chat/") || req.path.starts_with("/api/chat/meetings") {
            return None;
        }
        let mut st = self.0.lock().unwrap();
        if st.not_enabled {
            return Some(Resp::json(403, json!({ "code": "TEAM_CHAT_NOT_ENABLED", "message": "Team chat is not enabled for this store" })));
        }
        let body: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
        if req.method != "GET" {
            st.writes.push((req.method.clone(), req.path.clone(), body.clone()));
        }
        let param = |k: &str| req.query.split('&').find_map(|kv| kv.strip_prefix(&format!("{k}=")).map(str::to_owned));
        let parts: Vec<&str> = req.path.trim_start_matches('/').split('/').collect();
        // parts: ["api", "chat", ...]
        match (req.method.as_str(), &parts[2..]) {
            ("GET", ["bootstrap"]) => Some(Resp::json(200, json!({
                "channels": [
                    real_channel("c_1", "public", "general", 2, 1, json!([])),
                    real_channel("d_1", "direct", "", 0, 0, json!([{ "_id": "u_2", "name": "Anna", "avatar": "" }]))
                ],
                "unreadTotal": 2, "mentionTotal": 1, "me": { "_id": "u_1", "name": "Teszt Elek", "avatar": "", "isPortal": false }, "restaurantId": "r_1",
                "settings": {}, "credits": st.credits, "meetingConfigured": false,
                "permissions": { "createChannel": true, "manageChannels": false, "startMeeting": false, "recordMeeting": false, "editSettings": false }
            }))),
            ("GET", ["directory"]) => Some(Resp::json(200, json!({ "items": [
                { "_id": "u_2", "name": "Anna", "avatar": "", "email": "anna@example.test", "role": "member", "isPortal": false, "joinedAt": "2026-09-01T08:00:00.000Z" },
                { "_id": "u_3", "name": "Péter", "avatar": "", "email": "peter@example.test", "role": "member", "isPortal": false, "joinedAt": "2026-09-01T08:00:00.000Z" }
            ] }))),
            ("GET", ["channels"]) if param("browse").as_deref() == Some("true") => {
                let mut ch = real_channel("c_9", "public", "random", 0, 0, json!([]));
                ch["me"] = json!({ "role": null, "isMember": false, "unreadCount": 0, "mentionCount": 0, "lastReadMessageId": null, "lastReadAt": null, "notifyLevel": "all", "mutedUntil": null, "starred": false, "hidden": false });
                Some(Resp::json(200, json!({ "items": [ch] })))
            }
            ("POST", ["channels"]) => {
                if st.forbid_create {
                    return Some(Resp::json(403, json!({ "code": "CREATE_FORBIDDEN", "message": "You are not allowed to create channels" })));
                }
                if body["name"] == "general" {
                    return Some(Resp::json(409, json!({ "code": "CHANNEL_NAME_TAKEN", "message": "A channel with this name already exists", "channelId": "c_1" })));
                }
                let ch = real_channel("c_new", body["type"].as_str().unwrap_or("public"), body["name"].as_str().unwrap_or(""), 0, 0, json!([]));
                st.created.push(ch.clone());
                Some(Resp::json(201, ch))
            }
            ("POST", ["direct"]) => {
                let ids = body["userIds"].as_array().cloned().unwrap_or_default();
                if ids.is_empty() {
                    return Some(Resp::json(400, json!({ "code": "USERS_REQUIRED", "message": "At least one other user is required" })));
                }
                let kind = if ids.len() > 1 { "group" } else { "direct" };
                Some(Resp::json(200, real_channel("d_new", kind, "", 0, 0, json!(ids.iter().map(|i| json!({ "_id": i, "name": format!("User {}", i.as_str().unwrap_or("")), "avatar": "" })).collect::<Vec<_>>()))))
            }
            ("GET", ["threads"]) => {
                let root = st.messages[0].clone();
                let items = if st.threads_unread > 0 || param("unread").is_none() {
                    vec![json!({ "root": root, "channel": { "_id": "c_1", "name": "general", "type": "public" }, "replyCount": 2, "lastReplyAt": intely_happy::time::to_iso(T0 + 200_000), "unreadCount": st.threads_unread })]
                } else {
                    Vec::new()
                };
                Some(Resp::json(200, json!({ "items": items })))
            }
            ("GET", ["messages", id, "thread"]) => {
                let Some(root) = st.messages.iter().find(|m| m["_id"] == *id).cloned() else { return Some(Resp::json(404, json!({ "code": "NOT_FOUND", "message": "Not found" }))) };
                let items: Vec<Value> = st.messages.iter().filter(|m| m["threadRoot"] == *id).cloned().collect();
                st.threads_unread = 0;
                Some(Resp::json(200, json!({ "root": root, "items": items })))
            }
            ("GET", ["channels", "c_1", "messages"]) => {
                let limit: usize = param("limit").and_then(|l| l.parse().ok()).unwrap_or(50);
                let top: Vec<Value> = st.messages.iter().filter(|m| m["threadRoot"].is_null()).cloned().collect();
                let pos = |id: &str| top.iter().position(|m| m["_id"] == id);
                let (start, end) = if let Some(b) = param("before").and_then(|b| pos(&b)) {
                    (b.saturating_sub(limit), b)
                } else if let Some(a) = param("after").and_then(|a| pos(&a)) {
                    (a + 1, (a + 1 + limit).min(top.len()))
                } else if let Some(c) = param("around").and_then(|a| pos(&a)) {
                    let start = c.saturating_sub(limit / 2);
                    (start, (start + limit).min(top.len()))
                } else {
                    (top.len().saturating_sub(limit), top.len())
                };
                let mut out = json!({ "items": top[start..end].to_vec(), "hasMore": start > 0, "hasNewer": end < top.len() });
                if let Some(a) = param("around") {
                    out["anchorId"] = json!(a);
                }
                Some(Resp::json(200, out))
            }
            ("POST", ["channels", "c_1", "messages"]) => {
                let client = body["clientMessageId"].as_str().unwrap_or_default().to_owned();
                if let Some(old) = st.sent.iter().find(|m| m["clientMessageId"] == client) {
                    return Some(Resp::json(201, old.clone()));
                }
                if st.credits <= 0.0 {
                    return Some(Resp::json(402, json!({ "code": "INSUFFICIENT_CREDITS", "message": "no credits", "balance": 0 })));
                }
                st.seq += 1;
                let mut msg = real_message(&format!("s{:03}", st.seq), "c_1", "u_1", "Teszt Elek", body["text"].as_str().unwrap_or(""), T0 + 20_000_000 + st.seq as i64 * 1000);
                msg["clientMessageId"] = json!(client);
                msg["mentions"] = body["mentions"].clone();
                if let Some(root) = body["threadRootId"].as_str() {
                    msg["threadRoot"] = json!(root);
                    if let Some(r) = st.messages.iter_mut().find(|m| m["_id"] == root) {
                        r["replyCount"] = json!(r["replyCount"].as_i64().unwrap_or(0) + 1);
                    }
                }
                st.sent.push(msg.clone());
                st.messages.push(msg.clone());
                st.credits -= 0.02;
                Some(Resp::json(201, msg))
            }
            ("POST", ["channels", id, "read"]) => {
                st.reads.push((*id).to_owned());
                Some(Resp::json(200, json!({ "channelId": id, "lastReadMessageId": null, "unreadCount": 0, "mentionCount": 0 })))
            }
            ("POST", ["channels", id, "join"]) => Some(Resp::json(200, real_channel(id, "public", "random", 0, 0, json!([])))),
            ("POST", ["channels", id, "leave"]) => Some(Resp::json(200, json!({ "ok": true, "channelId": id }))),
            ("GET", ["channels", _, "members"]) => Some(Resp::json(200, json!({ "items": st.members }))),
            ("POST", ["channels", "d_1", "members"]) => Some(Resp::json(400, json!({ "code": "DIRECT_IMMUTABLE", "message": "Members cannot be added to a direct conversation" }))),
            ("POST", ["channels", "c_priv", "members"]) => Some(Resp::json(403, json!({ "code": "MANAGE_FORBIDDEN", "message": "Only channel admins can add members here" }))),
            ("POST", ["channels", _, "members"]) => {
                let added: Vec<Value> = body["userIds"].as_array().cloned().unwrap_or_default().iter().map(|u| json!({ "_id": u, "name": format!("User {}", u.as_str().unwrap_or("")), "avatar": "", "email": "", "role": "member", "isPortal": false, "joinedAt": "2026-10-03T08:00:00.000Z" })).collect();
                st.members.extend(added.clone());
                Some(Resp::json(200, json!({ "items": added })))
            }
            ("DELETE", ["channels", _, "members", _]) => Some(Resp::json(200, json!({ "ok": true }))),
            _ => None,
        }
    }
}
