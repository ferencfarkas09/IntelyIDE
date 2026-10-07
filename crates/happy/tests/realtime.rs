//! The shared realtime connection and Team chat against a scripted loopback Socket.IO + REST server: zero cost when off,
//! one reference-counted socket, auth and join, reconnect with replay/dedupe, the 401 stop, 402 and idempotent sends,
//! pagination, focus gating, meeting live events, and token / message-body canaries. Nothing leaves 127.0.0.1.

mod common;

use std::time::Duration;

use common::sio::{real_message, ChatApi, FakeSio, Mode};
use common::{fixtures, wait_for, Resp, Rig, Stub, JWT};
use intely_happy::types::{ChatEvent, ChatLink, ConfigPatch, MeetingStatus, MessageChange, PrefsPatch, ProviderState, SendState};
use intely_happy::Kind;
use serde_json::json;

struct Env {
    stub: Stub,
    sio: FakeSio,
    api: ChatApi,
    rig: Rig,
}

async fn env() -> Env {
    let (sio, api) = (FakeSio::default(), ChatApi::new());
    let handler_api = api.clone();
    let stub = Stub::start_with(
        move |req| {
            if !ChatApi::authed(req) {
                return Resp::json(401, json!({ "code": "DEVICE_LOGGED_OUT", "message": "Session revoked" }));
            }
            handler_api.handle(req).unwrap_or_else(|| fixtures(req))
        },
        Some(sio.clone()),
    )
    .await;
    let rig = Rig::fast(stub.url()).await;
    Env { stub, sio, api, rig }
}

impl Env {
    /// Chat (and optionally meet) on with a valid token, waiting until the providers are ready.
    async fn start(&self, meet: bool) {
        self.rig.switch_chat(true, meet).await;
        let test = self.rig.hub.save_token(JWT).await;
        assert!(test.ok, "{test:?}");
        self.rig.wait_state("chat", ProviderState::Ready).await;
        if meet {
            self.rig.wait_state("meet", ProviderState::Ready).await;
        }
    }

    async fn live(&self) {
        wait_for(|| async { self.rig.hub.socket_link() == ChatLink::Live && self.sio.live() == 1 }).await;
    }

    fn chats(&self) -> Vec<ChatEvent> {
        self.rig.sink.chats.lock().unwrap().clone()
    }

    fn messages(&self, change: MessageChange) -> Vec<String> {
        self.chats()
            .into_iter()
            .filter_map(|e| match e {
                ChatEvent::Message { message, change: c, .. } if c == change => Some(message.id),
                _ => None,
            })
            .collect()
    }
}

fn message_event(id: &str, text: &str) -> serde_json::Value {
    json!({ "channelId": "c_1", "message": real_message(id, "c_1", "u_2", "Anna", text, 1_820_000_000_000i64) })
}

/// A thread reply by Anna in the thread of `m000`, as the server pushes it.
fn reply_event(id: &str, text: &str) -> serde_json::Value {
    let mut m = real_message(id, "c_1", "u_2", "Anna", text, 1_820_000_100_000i64);
    m["threadRoot"] = json!("m000");
    json!({ "channelId": "c_1", "message": m })
}

#[tokio::test]
async fn switched_off_opens_no_socket_and_sends_no_request() {
    let e = env().await;
    e.rig.give_token();
    let prefs = |on| Some(intely_happy::types::PrefsPatch { enabled: Some(on), ..Default::default() });
    // Providers on, master off.
    e.rig.hub.set_config(intely_happy::types::ConfigPatch { master: Some(false), chat: prefs(true), meet: prefs(true), ..Default::default() }).await.unwrap();
    e.rig.hub.start().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!((e.stub.count(), e.sio.attempts(), e.rig.hub.socket_running(), e.rig.hub.socket_attempts()), (0, 0, false, 0));
    // Master on, no provider on.
    e.rig.hub.set_config(intely_happy::types::ConfigPatch { master: Some(true), chat: prefs(false), meet: prefs(false), ..Default::default() }).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!((e.stub.count(), e.sio.attempts(), e.rig.hub.socket_running(), e.rig.hub.has_client()), (0, 0, false, false));
    // Timer only: a REST provider never needs the socket.
    e.rig.switch_on(true, false).await;
    e.rig.wait_state("timer", ProviderState::Ready).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!((e.sio.attempts(), e.rig.hub.socket_running()), (0, false));
}

#[tokio::test]
async fn one_socket_serves_chat_and_meet_and_closes_with_the_last_owner() {
    let e = env().await;
    e.start(true).await;
    e.live().await;
    assert_eq!(e.sio.attempts(), 1, "chat and meet share one connection");
    assert_eq!(e.sio.auths(), vec![json!({ "token": JWT, "userId": "u_1", "name": "Teszt Elek" })]);
    assert_eq!(e.sio.upgrade_auth(), vec![Some(format!("Bearer {JWT}"))], "the upgrade request carries the same token as REST");
    wait_for(|| async { e.sio.received().iter().any(|(n, v)| n == "join:user" && v == "u_1") }).await;
    // Chat off: meet still holds the socket.
    e.rig.switch_chat(false, true).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!((e.sio.live(), e.rig.hub.socket_running()), (1, true));
    // Meet off too: the socket is closed and the task gone.
    e.rig.switch_chat(false, false).await;
    wait_for(|| async { e.sio.live() == 0 && !e.rig.hub.socket_running() }).await;
    assert_eq!(e.rig.hub.socket_link(), ChatLink::Off);
}

#[tokio::test]
async fn socket_messages_move_counters_and_replays_are_deduplicated() {
    let e = env().await;
    e.start(false).await;
    e.live().await;
    assert_eq!(e.rig.hub.chat_summary().unread_total, 2);
    for _ in 0..3 {
        e.sio.emit("chat:message", message_event("x1", "first"));
    }
    wait_for(|| async { !e.messages(MessageChange::New).is_empty() }).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(e.messages(MessageChange::New), ["x1"], "the same message replayed twice produces one event");
    let summary = e.rig.hub.chat_summary();
    assert_eq!(summary.unread_total, 3, "one new unread, not three");
    assert!(e.chats().iter().any(|c| matches!(c, ChatEvent::Message { notify: true, .. })), "a message in an unviewed channel asks for a toast");
    // `chat:read` goes to ALL members: somebody else's read must not clear the user's counters, the user's own read (another
    // device) does.
    e.sio.emit("chat:read", json!({ "channelId": "c_1", "userId": "u_2", "lastReadMessageId": "x1" }));
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(e.rig.hub.chat_summary().unread_total, 3, "another member's read is not ours");
    e.sio.emit("chat:read", json!({ "channelId": "c_1", "userId": "u_1", "lastReadMessageId": "x1" }));
    wait_for(|| async { e.rig.hub.chat_summary().unread_total == 0 }).await;
    // An edit updates, a delete leaves a tombstone that a replay cannot undo.
    e.sio.emit("chat:message:updated", message_event("x1", "edited"));
    wait_for(|| async { !e.messages(MessageChange::Updated).is_empty() }).await;
    e.sio.emit("chat:message:deleted", json!({ "channelId": "c_1", "messageId": "x1" }));
    wait_for(|| async { !e.messages(MessageChange::Deleted).is_empty() }).await;
    e.sio.emit("chat:message", message_event("x1", "first"));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(e.messages(MessageChange::New), ["x1"]);
}

#[tokio::test]
async fn thread_replies_stay_out_of_the_channel_and_its_counters_and_open_in_the_thread() {
    let e = env().await;
    e.start(false).await;
    e.live().await;
    // The bootstrap also asked for the threads with news (server-driven aggregate).
    assert_eq!(e.rig.hub.chat_summary().thread_unread, 1);
    let page = e.rig.hub.chat_open("c_1").await.unwrap();
    assert!(page.messages.iter().all(|m| m.thread_root.is_none()), "no reply inline");
    assert_eq!(page.messages.iter().find(|m| m.id == "m000").map(|m| m.reply_count), None, "m000 is older than the newest page");
    // The thread: root + replies, and opening it clears its unread.
    let t = e.rig.hub.chat_thread("m000").await.unwrap();
    assert_eq!((t.root.id.as_str(), t.root.reply_count, t.replies.iter().map(|m| m.id.as_str()).collect::<Vec<_>>()), ("m000", 2, vec!["r000", "r001"]));
    assert_eq!(e.rig.hub.chat_summary().thread_unread, 0);
    // A reply pushed by someone else: announced with its thread root, no channel unread, no inline cache entry.
    let before = e.rig.hub.chat_summary();
    e.sio.emit("chat:message", reply_event("r002", "ujabb valasz"));
    wait_for(|| async { e.chats().iter().any(|c| matches!(c, ChatEvent::Message { message, change: MessageChange::New, .. } if message.id == "r002" && message.thread_root.as_deref() == Some("m000"))) }).await;
    let after = e.rig.hub.chat_summary();
    assert_eq!((after.unread_total, after.mention_total), (before.unread_total, before.mention_total), "a reply never bumps the channel");
    assert!(!e.chats().iter().any(|c| matches!(c, ChatEvent::Message { notify: true, message, .. } if message.id == "r002")), "a plain reply asks for no toast");
    assert!(e.rig.hub.chat_open("c_1").await.unwrap().messages.iter().all(|m| m.id != "r002"));
    // The root is updated through chat:message:updated (reply count).
    let mut root = real_message("m000", "c_1", "u_2", "Anna", "hello 0", 1_790_000_000_000i64);
    root["replyCount"] = json!(3);
    e.sio.emit("chat:message:updated", json!({ "channelId": "c_1", "message": root }));
    wait_for(|| async { e.chats().iter().any(|c| matches!(c, ChatEvent::Message { message, change: MessageChange::Updated, .. } if message.id == "m000" && message.reply_count == 3)) }).await;
    // Replying from the user: the body carries threadRootId, the optimistic copy and the answer live in the thread.
    let sent = e.rig.hub.chat_send("c_1", "valaszolok", vec!["u_2".into()], Some("cm-thread".into()), Some("m000".into())).await.unwrap();
    assert_eq!((sent.thread_root.as_deref(), sent.send_state.clone()), (Some("m000"), SendState::Sent));
    let (_, _, body) = e.api.writes().into_iter().find(|(m, p, _)| m == "POST" && p.ends_with("/messages")).unwrap();
    assert_eq!((body["threadRootId"].as_str(), body["mentions"]["users"][0].as_str(), body["mentions"]["channel"].as_bool()), (Some("m000"), Some("u_2"), Some(false)));
    assert!(e.chats().iter().any(|c| matches!(c, ChatEvent::Message { message, change: MessageChange::New, .. } if message.send_state == SendState::Pending && message.thread_root.as_deref() == Some("m000"))));
    assert!(e.rig.hub.chat_open("c_1").await.unwrap().messages.iter().all(|m| m.thread_root.is_none() && m.id != sent.id));
    // A deleted reply is announced and stays deleted.
    e.sio.emit("chat:message:deleted", json!({ "channelId": "c_1", "messageId": "r002", "threadRoot": "m000" }));
    wait_for(|| async { !e.messages(MessageChange::Deleted).is_empty() }).await;
    // A reply that mentions the user does ask for a toast.
    let mut mention = reply_event("r003", "@Elek nezd meg");
    mention["message"]["mentions"] = json!({ "users": ["u_1"], "channel": false });
    e.sio.emit("chat:message", mention);
    wait_for(|| async { e.chats().iter().any(|c| matches!(c, ChatEvent::Message { notify: true, message, .. } if message.id == "r003")) }).await;
    // The threads list.
    let list = e.rig.hub.chat_threads(false).await.unwrap();
    assert_eq!((list.len(), list[0].channel_name.as_str(), list[0].root.id.as_str()), (1, "general", "m000"));
}

#[tokio::test]
async fn history_jumps_around_a_message_and_pages_forward_without_touching_the_cache() {
    let e = env().await;
    e.start(false).await;
    let w = e.rig.hub.chat_around("c_1", "m060").await.unwrap();
    assert_eq!((w.anchor_id.as_deref(), w.has_more, w.has_newer), (Some("m060"), true, true));
    assert!(w.messages.iter().any(|m| m.id == "m060") && w.messages.len() == 50);
    let newer = e.rig.hub.chat_newer("c_1", w.messages.last().map(|m| m.id.as_str()).unwrap()).await.unwrap();
    assert!(newer.messages.first().unwrap().created_at_ms > w.messages.last().unwrap().created_at_ms);
    // The newest page the cache keeps is untouched by the jump.
    let open = e.rig.hub.chat_open("c_1").await.unwrap();
    assert_eq!((open.messages.first().unwrap().id.as_str(), open.has_newer), ("m070", false));
}

#[tokio::test]
async fn the_chat_pilot_gate_is_a_friendly_state_without_a_retry_storm() {
    let e = env().await;
    e.api.set_not_enabled(true);
    e.rig.switch_chat(true, false).await;
    let test = e.rig.hub.save_token(JWT).await;
    assert!(test.ok);
    let chat = test.providers.iter().find(|p| p.id == "chat").unwrap();
    assert!(!chat.allowed && chat.hint.as_deref().is_some_and(|h| h.contains("not enabled")), "{chat:?}");
    e.rig.wait_state("chat", ProviderState::NotPermitted).await;
    let status = e.rig.hub.status().await;
    let p = status.providers.iter().find(|p| p.id == "chat").unwrap();
    assert_eq!(p.last_error.as_ref().map(|l| l.code.as_str()), Some("TEAM_CHAT_NOT_ENABLED"));
    let boots = || e.stub.paths().iter().filter(|p| p.ends_with("/api/chat/bootstrap")).count();
    let n = boots();
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(boots(), n, "no polling while the store is not enabled");
}

#[tokio::test]
async fn channels_can_be_created_browsed_joined_and_left_with_friendly_refusals() {
    let e = env().await;
    e.start(false).await;
    let ch = e.rig.hub.chat_create_channel("  projekt  ", "Leiras", true, &["u_2".to_owned()]).await.unwrap();
    assert_eq!((ch.id.as_str(), ch.kind.clone(), ch.name.as_str()), ("c_new", intely_happy::types::ChatKind::Private, "projekt"));
    assert!(e.rig.hub.chat_summary().channels.iter().any(|c| c.id == "c_new"));
    let (_, _, body) = e.api.writes().into_iter().find(|(m, p, _)| m == "POST" && p == "/api/chat/channels").unwrap();
    assert_eq!((body["type"].as_str(), body["name"].as_str(), body["description"].as_str(), body["memberIds"][0].as_str(), body["restaurantId"].as_str()), (Some("private"), Some("projekt"), Some("Leiras"), Some("u_2"), Some("r_1")));
    assert_eq!(e.rig.hub.chat_create_channel("general", "", false, &[]).await.unwrap_err().code, "CHANNEL_NAME_TAKEN");
    assert_eq!(e.rig.hub.chat_create_channel("  ", "", false, &[]).await.unwrap_err().code, "NAME_REQUIRED");
    e.api.set_forbid_create(true);
    let err = e.rig.hub.chat_create_channel("masik", "", false, &[]).await.unwrap_err();
    assert_eq!((err.kind, err.code.as_str()), (Kind::Forbidden, "CREATE_FORBIDDEN"));
    assert_eq!(e.rig.state_of("chat").await, ProviderState::Ready, "a refused verb does not disable chat");
    // Browse, join, leave.
    let browse = e.rig.hub.chat_browse("ran").await.unwrap();
    assert_eq!((browse.len(), browse[0].is_member, browse[0].name.as_str()), (1, false, "random"));
    assert!(e.stub.requests.lock().unwrap().iter().any(|r| r.path == "/api/chat/channels" && r.query.contains("browse=true") && r.query.contains("search=ran") && r.query.contains("restaurantId=r_1")));
    let joined = e.rig.hub.chat_join("c_9").await.unwrap();
    assert!(joined.is_member && e.rig.hub.chat_summary().channels.iter().any(|c| c.id == "c_9"));
    e.rig.hub.chat_leave("c_9").await.unwrap();
    assert!(!e.rig.hub.chat_summary().channels.iter().any(|c| c.id == "c_9"));
}

#[tokio::test]
async fn people_are_invited_to_channels_but_never_to_direct_ones_and_group_dms_open_from_the_directory() {
    let e = env().await;
    e.start(false).await;
    let members = e.rig.hub.chat_members("c_1").await.unwrap();
    assert_eq!((members.len(), members[0].role.as_str(), members[0].online), (2, "admin", true));
    let added = e.rig.hub.chat_add_members("c_1", &["u_3".to_owned()]).await.unwrap();
    assert_eq!((added.len(), added[0].id.as_str()), (1, "u_3"));
    assert_eq!(e.rig.hub.chat_add_members("c_1", &[]).await.unwrap_err().code, "USERS_REQUIRED");
    assert_eq!(e.rig.hub.chat_add_members("d_1", &["u_3".to_owned()]).await.unwrap_err().code, "DIRECT_IMMUTABLE");
    let err = e.rig.hub.chat_add_members("c_priv", &["u_3".to_owned()]).await.unwrap_err();
    assert_eq!((err.kind, err.code.as_str()), (Kind::Forbidden, "MANAGE_FORBIDDEN"));
    e.rig.hub.chat_remove_member("c_1", "u_3").await.unwrap();
    assert!(e.api.writes().iter().any(|(m, p, _)| m == "DELETE" && p == "/api/chat/channels/c_1/members/u_3"));
    // Several people make a group conversation; the DM body is `userIds`.
    let group = e.rig.hub.chat_open_direct(&["u_2".to_owned(), "u_3".to_owned()]).await.unwrap();
    assert_eq!((group.kind.clone(), group.name.as_str(), group.peers.len()), (intely_happy::types::ChatKind::Group, "User u_2, User u_3", 2));
    assert!(group.kind.is_direct());
    let (_, _, body) = e.api.writes().into_iter().find(|(m, p, _)| m == "POST" && p == "/api/chat/direct").unwrap();
    assert_eq!((body["userIds"].as_array().map(Vec::len), body["restaurantId"].as_str()), (Some(2), Some("r_1")));
    assert_eq!(e.rig.hub.chat_open_direct(&[]).await.unwrap_err().code, "invalidUsers");
    assert!(e.stub.requests.lock().unwrap().iter().any(|r| r.path == "/api/chat/directory" && r.query.contains("restaurantId=r_1")) || e.rig.hub.chat_directory("").await.is_ok());
}

#[tokio::test]
async fn a_pushed_notification_reaches_the_inbox_at_once_and_the_socket_belongs_to_the_inbox_too() {
    let e = env().await;
    // Only the inbox is on: it opens the socket for `notification:new`.
    e.rig.hub.set_config(ConfigPatch { master: Some(true), notifications: Some(PrefsPatch { enabled: Some(true), ..Default::default() }), ..Default::default() }).await.unwrap();
    assert!(e.rig.hub.save_token(JWT).await.ok);
    e.rig.wait_state("notifications", ProviderState::Ready).await;
    e.live().await;
    let pushed = json!({ "_id": "n_77", "title": "Anna · general", "message": "szia", "type": "chat", "read": false, "relatedId": "m1", "relatedModel": "ChatMessage", "createdAt": "2026-10-03T10:00:00.000Z",
        "metadata": { "type": "chat", "channelId": "c_1", "messageId": "m1", "threadRoot": "m0", "restaurantId": "r_1", "actorName": "Anna", "preview": "szia", "eventKey": "chat.message.thread" } });
    e.sio.emit("notification:new", pushed.clone());
    wait_for(|| async { e.rig.hub.notifications_current().unread == 1 }).await;
    let view = e.rig.hub.notifications_current();
    assert_eq!((view.items[0].id.as_str(), view.items[0].channel_id.as_deref(), view.items[0].thread_root.as_deref(), view.items[0].event_key.as_deref()), ("n_77", Some("c_1"), Some("m0"), Some("chat.message.thread")));
    e.sio.emit("notification:new", pushed);
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(e.rig.hub.notifications_current().unread, 1, "a replay is not counted twice");
}

#[tokio::test]
async fn a_dropped_socket_reconnects_and_the_catch_up_fills_the_gap_exactly_once() {
    let e = env().await;
    e.start(false).await;
    e.live().await;
    let page = e.rig.hub.chat_open("c_1").await.unwrap();
    assert_eq!(page.messages.len(), 50);
    e.sio.drop_all();
    wait_for(|| async { e.sio.live() == 0 }).await;
    // A message arrives while the socket is down; the open channel is re-fetched when it comes back.
    e.api.add_message("gap1", "while you were away");
    wait_for(|| async { e.sio.attempts() >= 2 && e.sio.live() == 1 && e.rig.hub.socket_link() == ChatLink::Live }).await;
    wait_for(|| async { e.messages(MessageChange::New).contains(&"gap1".to_owned()) }).await;
    // The server also replays the same message over the new socket: still one event.
    e.sio.emit("chat:message", message_event("gap1", "while you were away"));
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(e.messages(MessageChange::New).iter().filter(|id| *id == "gap1").count(), 1);
    assert!(e.chats().iter().any(|c| matches!(c, ChatEvent::Link { link: ChatLink::Reconnecting })));
}

#[tokio::test]
async fn an_http_401_on_the_upgrade_signs_out_and_is_never_retried() {
    let e = env().await;
    e.sio.set_mode(Mode::Http401);
    e.rig.switch_chat(true, true).await;
    assert!(e.rig.hub.save_token(JWT).await.ok);
    wait_for(|| async { e.rig.hub.status().await.signed_out.is_some() }).await;
    let status = e.rig.hub.status().await;
    assert_eq!(status.signed_out.as_ref().map(|s| s.code.as_str()), Some("socketUnauthorized"));
    assert!(status.providers.iter().filter(|p| p.id == "chat" || p.id == "meet").all(|p| p.state == ProviderState::SignedOut));
    let attempts = e.sio.attempts();
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!((e.sio.attempts(), e.rig.hub.socket_running(), e.rig.hub.has_client()), (attempts, false, false), "no retry after a 401");
}

#[tokio::test]
async fn a_socket_connect_error_about_the_session_also_stops_everything() {
    let e = env().await;
    e.sio.set_mode(Mode::ConnectError("unauthorized"));
    e.rig.switch_chat(true, false).await;
    assert!(e.rig.hub.save_token(JWT).await.ok);
    wait_for(|| async { e.rig.hub.status().await.signed_out.is_some() }).await;
    let attempts = e.sio.attempts();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(e.sio.attempts(), attempts);
    assert_eq!(e.rig.state_of("chat").await, ProviderState::SignedOut);
    // A new token starts it all again.
    e.sio.set_mode(Mode::Ok);
    assert!(e.rig.hub.save_token(JWT).await.ok);
    e.rig.wait_state("chat", ProviderState::Ready).await;
    e.live().await;
    assert!(e.rig.hub.status().await.signed_out.is_none());
}

#[tokio::test]
async fn a_forbidden_socket_is_not_retried_but_the_polls_carry_on() {
    let e = env().await;
    e.sio.set_mode(Mode::ConnectError("forbidden"));
    e.start(false).await;
    wait_for(|| async { e.sio.attempts() == 1 && !e.rig.hub.socket_running() }).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(e.sio.attempts(), 1);
    let status = e.rig.hub.status().await;
    assert!(status.signed_out.is_none());
    let chat = status.providers.iter().find(|p| p.id == "chat").unwrap();
    assert_eq!((&chat.state, chat.last_error.as_ref().map(|l| l.code.as_str())), (&ProviderState::Ready, Some("socketForbidden")));
    assert!(e.rig.hub.chat_refresh().await.is_ok(), "REST still works");
}

#[tokio::test]
async fn join_forbidden_closes_the_socket_for_good() {
    let e = env().await;
    e.start(false).await;
    e.live().await;
    e.sio.emit("join:forbidden", json!(null));
    wait_for(|| async { e.sio.live() == 0 && !e.rig.hub.socket_running() }).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(e.sio.attempts(), 1);
}

#[tokio::test]
async fn pagination_walks_back_through_history_and_sends_are_idempotent() {
    let e = env().await;
    e.start(false).await;
    e.live().await;
    let first = e.rig.hub.chat_open("c_1").await.unwrap();
    assert_eq!((first.messages.first().unwrap().id.as_str(), first.messages.last().unwrap().id.as_str(), first.has_more, first.cursor.as_deref()), ("m070", "m119", true, Some("m070")));
    let second = e.rig.hub.chat_older("c_1", "m070").await.unwrap();
    assert_eq!((second.messages.first().unwrap().id.as_str(), second.messages.last().unwrap().id.as_str(), second.has_more, second.cursor.as_deref()), ("m020", "m069", true, Some("m020")));
    let third = e.rig.hub.chat_older("c_1", "m020").await.unwrap();
    assert_eq!((third.messages.len(), third.has_more, third.cursor), (20, false, None));

    // A send: optimistic first, then replaced by the server's copy (or the echo), and stored once.
    let sent = e.rig.hub.chat_send("c_1", "  szia mindenkinek  ", vec![], Some("cm-fixed".into()), None).await.unwrap();
    assert_eq!((sent.send_state.clone(), sent.text.as_str(), sent.mine), (SendState::Sent, "szia mindenkinek", true));
    assert!(e.chats().iter().any(|c| matches!(c, ChatEvent::Message { message, change: MessageChange::New, .. } if message.send_state == SendState::Pending)));
    // The same client id again (a retry after a lost answer) is not stored twice.
    let again = e.rig.hub.chat_send("c_1", "szia mindenkinek", vec![], Some("cm-fixed".into()), None).await.unwrap();
    assert_eq!(again.id, sent.id);
    assert_eq!(e.api.sent().len(), 1);
    // The socket echo of the same message adds nothing.
    e.sio.emit("chat:message", json!({ "channelId": "c_1", "message": e.api.sent()[0] }));
    tokio::time::sleep(Duration::from_millis(250)).await;
    let page = e.rig.hub.chat_open("c_1").await.unwrap();
    assert_eq!(page.messages.iter().filter(|m| m.client_message_id.as_deref() == Some("cm-fixed")).count(), 1);
    assert!(page.messages.iter().all(|m| m.send_state == SendState::Sent));
    // Empty and oversized texts never leave.
    assert_eq!(e.rig.hub.chat_send("c_1", "   ", vec![], None, None).await.unwrap_err().code, "invalidMessage");
    assert_eq!(e.rig.hub.chat_send("c_1", &"x".repeat(8001), vec![], None, None).await.unwrap_err().code, "invalidMessage");
    assert_eq!(e.api.sent().len(), 1);
}

#[tokio::test]
async fn a_402_keeps_the_message_for_retry_blocks_the_composer_and_never_leaks_the_text() {
    let e = env().await;
    e.start(false).await;
    e.api.set_credits(0.0);
    let body = "BODY-CANARY-secret-text";
    let err = e.rig.hub.chat_send("c_1", body, vec![], Some("cm-402".into()), None).await.unwrap_err();
    assert_eq!((err.kind, err.code.as_str()), (Kind::Credits, "INSUFFICIENT_CREDITS"));
    assert!(!err.message.contains("BODY-CANARY") && !format!("{err:?}").contains("BODY-CANARY"));
    let summary = e.rig.hub.chat_summary();
    assert!(summary.credits_empty && (summary.send_cost - 0.02).abs() < 1e-9);
    let failed = e.chats().into_iter().find_map(|c| match c {
        ChatEvent::Message { message, change: MessageChange::Failed, .. } => Some(message),
        _ => None,
    });
    let failed = failed.expect("the failed send stays visible");
    assert_eq!((failed.send_state, failed.error_code.as_deref(), failed.text.as_str()), (SendState::Failed, Some("INSUFFICIENT_CREDITS"), body));
    assert!(e.api.sent().is_empty());
    // Credits come back; the retry reuses the client id and goes through.
    e.api.set_credits(3.0);
    let sent = e.rig.hub.chat_send("c_1", body, vec![], Some("cm-402".into()), None).await.unwrap();
    assert_eq!(sent.send_state, SendState::Sent);
    assert!(!e.rig.hub.chat_summary().credits_empty);
    assert_eq!(e.api.sent().len(), 1);
    let status = format!("{:?}", e.rig.hub.status().await);
    assert!(!status.contains("BODY-CANARY"));
}

#[tokio::test]
async fn read_marker_directory_and_typing() {
    let e = env().await;
    e.start(false).await;
    e.live().await;
    e.rig.hub.chat_open("c_1").await.unwrap();
    let summary = e.rig.hub.chat_mark_read("c_1").await.unwrap();
    assert_eq!(summary.unread_total, 0);
    assert_eq!(e.api.reads(), ["c_1"]);
    let people = e.rig.hub.chat_directory("pé").await.unwrap();
    assert_eq!(people.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Péter"]);
    let before = e.stub.paths().iter().filter(|p| p.ends_with("/api/chat/directory")).count();
    e.rig.hub.chat_directory("").await.unwrap();
    assert_eq!(e.stub.paths().iter().filter(|p| p.ends_with("/api/chat/directory")).count(), before, "the directory is cached");
    // Typing from someone else shows up, from the user itself does not; outgoing hints are throttled.
    e.sio.emit("chat:typing", json!({ "channelId": "c_1", "userId": "u_1", "name": "Teszt Elek" }));
    e.sio.emit("chat:typing", json!({ "channelId": "c_1", "userId": "u_2", "name": "Anna" }));
    wait_for(|| async { e.chats().iter().any(|c| matches!(c, ChatEvent::Typing { names, .. } if names == &["Anna".to_owned()])) }).await;
    assert!(!e.chats().iter().any(|c| matches!(c, ChatEvent::Typing { names, .. } if names.contains(&"Teszt Elek".to_owned()))));
    assert!(e.rig.hub.chat_typing("c_1") && !e.rig.hub.chat_typing("c_1"));
    wait_for(|| async { e.sio.received().iter().any(|(n, v)| n == "chat:typing" && v["channelId"] == "c_1") }).await;
}

#[tokio::test]
async fn typing_hints_follow_the_actions_gate_like_a_send() {
    let sent = |e: &Env| e.sio.received().iter().filter(|(n, _)| n == "chat:typing").count();
    // Chat off, meet on: the socket is live for the meetings, but there is no chat to type into.
    let e = env().await;
    e.rig.switch_chat(false, true).await;
    assert!(e.rig.hub.save_token(JWT).await.ok);
    e.rig.wait_state("meet", ProviderState::Ready).await;
    e.live().await;
    assert!(!e.rig.hub.chat_typing("c_1"));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(sent(&e), 0, "chat is off");
    // Chat on, "Allow sending messages" off: sends are blocked, and so are typing hints.
    e.rig.switch_chat(true, true).await;
    e.rig.wait_state("chat", ProviderState::Ready).await;
    let off = Some(PrefsPatch { allow_actions: Some(false), ..Default::default() });
    e.rig.hub.set_config(ConfigPatch { chat: off, ..Default::default() }).await.unwrap();
    assert!(!e.rig.hub.chat_typing("c_1"));
    assert_eq!(e.rig.hub.chat_send("c_1", "hi", vec![], None, None).await.unwrap_err().kind, Kind::Blocked);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(sent(&e), 0, "actions are off");
    // And back on: the hint goes out.
    let on = Some(PrefsPatch { allow_actions: Some(true), ..Default::default() });
    e.rig.hub.set_config(ConfigPatch { chat: on, ..Default::default() }).await.unwrap();
    assert!(e.rig.hub.chat_typing("c_1"));
    wait_for(|| async { sent(&e) == 1 }).await;
}

#[tokio::test]
async fn polling_is_focus_gated_and_regaining_focus_runs_one_catch_up() {
    let e = env().await;
    e.start(false).await;
    e.live().await;
    e.rig.hub.chat_open("c_1").await.unwrap();
    let bootstraps = || e.stub.paths().iter().filter(|p| p.ends_with("/api/chat/bootstrap")).count();
    e.rig.hub.set_focus(false);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (count, boots) = (e.stub.count(), bootstraps());
    tokio::time::sleep(Duration::from_millis(2600)).await;
    assert_eq!(e.stub.count(), count, "blurred: not a single request, even with the dock open");
    e.rig.hub.set_focus(true);
    wait_for(|| async { bootstraps() > boots }).await;
}

#[tokio::test]
async fn meeting_events_feed_the_meet_item() {
    let e = env().await;
    e.start(true).await;
    e.live().await;
    let before = e.rig.sink.meetings.lock().unwrap().len();
    e.sio.emit("chat:meeting", json!({ "action": "started", "meeting": { "id": "m_x", "title": "Hotfix call", "channel": { "name": "dev" }, "participantCount": 2, "host": { "name": "Péter" }, "startedAt": "2026-10-03T09:00:00Z" } }));
    wait_for(|| async { e.rig.hub.meet_current().meetings.iter().any(|m| m.id == "m_x") }).await;
    let m = e.rig.hub.meet_current().meetings.into_iter().find(|m| m.id == "m_x").unwrap();
    assert_eq!((m.title.as_str(), m.status, m.channel.as_deref(), m.participants), ("Hotfix call", MeetingStatus::Live, Some("dev"), 2));
    e.sio.emit("chat:meeting:lobby", json!({ "meetingId": "m_x", "waiting": 2 }));
    wait_for(|| async { e.rig.hub.meet_current().meetings.iter().any(|m| m.id == "m_x" && m.waiting == Some(2)) }).await;
    e.sio.emit("chat:meeting", json!({ "action": "ended", "meeting": { "id": "m_x" } }));
    wait_for(|| async { !e.rig.hub.meet_current().meetings.iter().any(|m| m.id == "m_x") }).await;
    assert!(e.rig.sink.meetings.lock().unwrap().len() >= before + 3, "each change reached the sink");
    assert!(e.rig.hub.meet_current().meetings.iter().any(|m| m.id == "m_live_1"), "the meetings from the poll stay");
}

#[tokio::test]
async fn the_token_never_shows_up_outside_the_auth_frame() {
    let e = env().await;
    e.sio.set_mode(Mode::ConnectError("token rejected eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzEiLCJkaWQiOiJ0ZXN0In0.Y2FuYXJ5LXNpZ25hdHVyZS12YWx1ZS0wMDAx"));
    e.rig.switch_chat(true, true).await;
    assert!(e.rig.hub.save_token(JWT).await.ok);
    wait_for(|| async { e.rig.hub.status().await.signed_out.is_some() }).await;
    let status = serde_json::to_string(&e.rig.hub.status().await).unwrap();
    let events = serde_json::to_string(&e.chats()).unwrap();
    let settings = std::fs::read_to_string(&e.rig.settings_path).unwrap();
    for (what, text) in [("status", status), ("events", events), ("settings", settings), ("summary", serde_json::to_string(&e.rig.hub.chat_summary()).unwrap())] {
        assert!(!text.contains("Y2FuYXJ5LXNpZ25hdHVyZS12YWx1ZS0wMDAx") && !text.contains("eyJzdWIi"), "{what} leaks the token");
    }
    assert_eq!((e.sio.auths().len(), e.sio.upgrade_auth().len()), (1, 1), "the token only went out in the Socket.IO auth frame and the upgrade header");
}
