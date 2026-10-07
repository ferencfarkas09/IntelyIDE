//! Team chat, the pure part: server payloads -> DTOs, the polling cadence and the toast rule. No I/O here; the message
//! cache is in `cache.rs`, and `chat_hub.rs` wires everything to the REST client and the socket.
//!
//! The field names are the REAL backend's (the Happy backend's `chatSerializer.js`): ids are `_id`, a channel `type` is
//! `public|private|direct|group|record|customer`, lists come as `{ items }`, `mentions` is `{ users[], channel }`, a thread
//! reply carries `threadRoot`. Reading stays defensive (a missing field defaults, unknown fields are ignored).

use std::time::Duration;

use serde_json::Value;

use crate::parse::{millis, number, seconds, text};
use crate::time::now_ms;
use crate::types::{
    ChatAttachment, ChatChannel, ChatKind, ChatLink, ChatMember, ChatMessage, ChatPerson, ChatReaction, MessagePage, NotifyLevel, SearchHit, SendState, ThreadSummary, ThreadView,
};

/// Messages kept per channel and channels with messages kept (plan 1.5).
pub const MAX_MESSAGES: usize = 200;
pub const MAX_CHANNELS: usize = 50;
/// What one send costs in store credits on the real service (0.02 per backend `chatMessage.service.js`).
pub const SEND_COST: f64 = 0.02;
pub const MAX_TEXT: usize = 8000;
pub const PAGE: usize = 50;
/// The error code of the pilot gate (`chatPilot.js`): the store is not in the chat pilot.
pub const NOT_ENABLED: &str = "TEAM_CHAT_NOT_ENABLED";

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn rows<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).or(Some(v)).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn array<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

pub fn notify_level(v: &Value) -> NotifyLevel {
    match text(v, &["notifyLevel"]).as_deref() {
        Some("mentions") => NotifyLevel::Mentions,
        Some("none") => NotifyLevel::None,
        _ => NotifyLevel::All,
    }
}

pub fn kind(t: Option<&str>) -> ChatKind {
    match t {
        Some("private") => ChatKind::Private,
        Some("direct") => ChatKind::Direct,
        Some("group") => ChatKind::Group,
        Some("record") => ChatKind::Record,
        Some("customer") => ChatKind::Customer,
        _ => ChatKind::Channel,
    }
}

/// `{ _id, name, avatar }` (a "lite" user) or a member/directory row.
pub fn person(v: &Value) -> Option<ChatPerson> {
    let id = text(v, &["_id", "id", "userId"])?;
    let name = text(v, &["name", "displayName"]).or_else(|| text(v, &["email"])).unwrap_or_else(|| id.clone());
    Some(ChatPerson { id, name, detail: text(v, &["role", "email"]) })
}

/// One channel (bootstrap, browse, create, join, `chat:channel:updated`). The counters live under `me`.
pub fn channel(v: &Value) -> Option<ChatChannel> {
    let id = text(v, &["_id", "id", "channelId"])?;
    let me = v.get("me").filter(|m| m.is_object()).unwrap_or(&Value::Null);
    let peers: Vec<ChatPerson> = array(v, "directPeers").iter().filter_map(person).collect();
    let kind = kind(text(v, &["type"]).as_deref());
    // A direct/group channel has an empty name: it is its peers.
    let name = text(v, &["name"]).or_else(|| (!peers.is_empty()).then(|| peers.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", "))).unwrap_or_else(|| id.clone());
    let preview = v.get("lastMessagePreview").filter(|p| p.is_object());
    let now = now_ms();
    Some(ChatChannel {
        id,
        kind,
        name,
        unread_count: seconds(number(me, &["unreadCount"]).unwrap_or(0)),
        mention_count: seconds(number(me, &["mentionCount"]).unwrap_or(0)),
        muted: millis(me, &["mutedUntil"]).is_some_and(|until| until > now),
        notify_level: notify_level(me),
        last_message_at_ms: millis(v, &["lastMessageAt"]),
        topic: text(v, &["topic"]).unwrap_or_default(),
        description: text(v, &["description"]).unwrap_or_default(),
        member_count: seconds(number(v, &["memberCount"]).unwrap_or(0)),
        archived: flag(v, "archived"),
        starred: flag(me, "starred"),
        is_member: v.get("me").is_none() || flag(me, "isMember"),
        role: text(me, &["role"]),
        peers,
        last_preview: preview.and_then(|p| text(p, &["text"])),
        last_sender: preview.and_then(|p| text(p, &["senderName"])),
    })
}

pub struct Bootstrap {
    pub channels: Vec<ChatChannel>,
    pub credits: Option<f64>,
    pub restaurant_id: Option<String>,
    pub can_create_channel: bool,
    pub can_manage_channels: bool,
}

pub fn bootstrap(v: &Value) -> Bootstrap {
    let perms = v.get("permissions").unwrap_or(&Value::Null);
    Bootstrap {
        channels: array(v, "channels").iter().filter_map(channel).filter(|c| !c.archived).collect(),
        credits: v.get("credits").and_then(|c| c.as_f64().or_else(|| c.get("balance").and_then(Value::as_f64))),
        restaurant_id: text(v, &["restaurantId"]),
        can_create_channel: flag(perms, "createChannel"),
        can_manage_channels: flag(perms, "manageChannels"),
    }
}

/// Inbound text is capped like outbound text: the cache holds up to 200 messages x 50 channels and every one goes to the webview.
fn cap_text(mut t: String) -> String {
    if let Some((end, _)) = t.char_indices().nth(MAX_TEXT) {
        t.truncate(end);
        t.push('…');
    }
    t
}

fn ids<'a>(v: Option<&'a Value>) -> Vec<&'a str> {
    v.and_then(Value::as_array).map_or_else(Vec::new, |a| a.iter().filter_map(Value::as_str).collect())
}

fn reaction(v: &Value, me: &str) -> Option<ChatReaction> {
    let emoji = text(v, &["emoji"])?;
    let users = ids(v.get("users"));
    let count = number(v, &["count"]).map_or(users.len(), |c| c.max(0) as usize);
    (count > 0).then(|| ChatReaction { emoji, count: count.min(u32::MAX as usize) as u32, mine: users.contains(&me) })
}

fn attachment(v: &Value) -> Option<ChatAttachment> {
    let name = text(v, &["name"]).or_else(|| text(v, &["documentId"]))?;
    Some(ChatAttachment { name, mime_type: text(v, &["mimeType"]).unwrap_or_default(), size: seconds(number(v, &["size"]).unwrap_or(0)) })
}

/// A message from REST or from `chat:message`. `me` is the current user's id (decides `mine` and `mentionsMe`).
pub fn message(v: &Value, channel_id: Option<&str>, me: &str) -> Option<ChatMessage> {
    let id = text(v, &["_id", "id"])?;
    let channel_id = text(v, &["channel", "channelId"]).or_else(|| channel_id.map(str::to_owned))?;
    let sender = v.get("sender").filter(|s| s.is_object());
    let sender_id = sender.and_then(|s| text(s, &["_id", "id"])).unwrap_or_default();
    // A bot or a system line has no sender: the bot's name (or nothing) stands in.
    let sender_name = sender.and_then(|s| text(s, &["name"])).or_else(|| text(v, &["bot"])).unwrap_or_default();
    let mine = !sender_id.is_empty() && sender_id == me;
    let mentions = v.get("mentions").filter(|m| m.is_object());
    let mentions_me = !mine && mentions.is_some_and(|m| ids(m.get("users")).contains(&me) || flag(m, "channel"));
    let deleted = v.get("deletedAt").is_some_and(|d| !d.is_null());
    let kind = text(v, &["kind"]).unwrap_or_else(|| "text".to_owned());
    Some(ChatMessage {
        id,
        channel_id,
        client_message_id: text(v, &["clientMessageId"]),
        mine,
        sender_id,
        sender_name,
        text: if deleted { String::new() } else { cap_text(text(v, &["text"]).unwrap_or_default()) },
        created_at_ms: millis(v, &["createdAt"]).unwrap_or(0),
        edited: v.get("editedAt").is_some_and(|d| !d.is_null()),
        deleted,
        system: kind == "system",
        kind,
        mentions_me,
        send_state: SendState::Sent,
        error_code: None,
        thread_root: text(v, &["threadRoot"]),
        reply_count: seconds(number(v, &["replyCount"]).unwrap_or(0)),
        last_reply_at_ms: millis(v, &["lastReplyAt"]),
        reply_users: array(v, "replyUsers").iter().filter_map(person).collect(),
        reactions: if deleted { Vec::new() } else { array(v, "reactions").iter().filter_map(|r| reaction(r, me)).collect() },
        attachments: if deleted { Vec::new() } else { array(v, "attachments").iter().filter_map(attachment).collect() },
        pinned: flag(v, "pinned"),
    })
}

fn sorted(mut messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
    messages.sort_by(|a, b| (a.created_at_ms, &a.id).cmp(&(b.created_at_ms, &b.id)));
    messages.dedup_by(|a, b| a.id == b.id);
    messages
}

/// `GET .../messages` -> `{ items: [...], hasMore, hasNewer, anchorId? }`; the order is not assumed (sorted oldest first here).
/// Top-level messages only: a stray thread reply is dropped (replies live in the thread panel, never inline).
pub fn page(v: &Value, channel_id: &str, me: &str) -> MessagePage {
    let messages = sorted(rows(v, "items").iter().filter_map(|m| message(m, Some(channel_id), me)).filter(|m| m.thread_root.is_none()).collect());
    let has_more = flag(v, "hasMore");
    let cursor = if has_more { messages.first().map(|m| m.id.clone()) } else { None };
    MessagePage { channel_id: channel_id.to_owned(), messages, has_more, cursor, has_newer: flag(v, "hasNewer"), anchor_id: text(v, &["anchorId"]) }
}

/// `GET /api/chat/messages/{id}/thread` -> `{ root, items: [replies] }`.
pub fn thread(v: &Value, me: &str) -> Option<ThreadView> {
    let root = message(v.get("root")?, None, me)?;
    let replies = sorted(array(v, "items").iter().filter_map(|m| message(m, Some(&root.channel_id), me)).collect());
    Some(ThreadView { channel_id: root.channel_id.clone(), root, replies })
}

/// `GET /api/chat/threads` -> `{ items: [{ root, channel{_id,name,type}, replyCount, lastReplyAt, unreadCount }] }`.
pub fn threads(v: &Value, me: &str) -> Vec<ThreadSummary> {
    array(v, "items")
        .iter()
        .filter_map(|t| {
            let ch = t.get("channel").unwrap_or(&Value::Null);
            let channel_id = text(ch, &["_id", "id"])?;
            let root = message(t.get("root")?, Some(&channel_id), me)?;
            Some(ThreadSummary {
                reply_count: seconds(number(t, &["replyCount"]).unwrap_or(i64::from(root.reply_count))),
                last_reply_at_ms: millis(t, &["lastReplyAt"]).or(root.last_reply_at_ms),
                unread_count: seconds(number(t, &["unreadCount"]).unwrap_or(0)),
                channel_name: text(ch, &["name"]).unwrap_or_default(),
                channel_kind: kind(text(ch, &["type"]).as_deref()),
                channel_id,
                root,
            })
        })
        .collect()
}

/// `GET /api/chat/directory` -> `{ items: [{ _id, name, avatar, email, role, isPortal, joinedAt }] }`.
pub fn people(v: &Value) -> Vec<ChatPerson> {
    rows(v, "items").iter().filter_map(person).collect()
}

/// `GET .../members` -> `{ items: [{ _id, name, email, role, isPortal, joinedAt, online? }] }`.
pub fn members(v: &Value) -> Vec<ChatMember> {
    rows(v, "items")
        .iter()
        .filter_map(|m| {
            let p = person(m)?;
            Some(ChatMember { id: p.id, name: p.name, email: text(m, &["email"]), role: text(m, &["role"]).unwrap_or_else(|| "member".to_owned()), online: m.get("online").and_then(Value::as_bool).unwrap_or(false), portal: flag(m, "isPortal") })
        })
        .collect()
}

/// `GET /api/chat/channels?browse=true` and friends -> `{ items: [channel] }`.
pub fn channels(v: &Value) -> Vec<ChatChannel> {
    rows(v, "items").iter().filter_map(channel).collect()
}

/// `GET /api/chat/search` -> `{ messages[+channelName], files[], people[], channels[] }`.
pub fn search(v: &Value, me: &str) -> (Vec<SearchHit>, Vec<ChatChannel>, Vec<ChatPerson>) {
    let hits = array(v, "messages").iter().filter_map(|m| Some(SearchHit { channel_name: text(m, &["channelName"]).unwrap_or_default(), message: message(m, None, me)? })).collect();
    (hits, array(v, "channels").iter().filter_map(channel).collect(), array(v, "people").iter().filter_map(person).collect())
}

/// `(channelId, messageId)` of a `chat:message:deleted` style payload (either may be missing).
pub fn event_ids(v: &Value) -> (Option<String>, Option<String>) {
    (text(v, &["channelId", "channel"]).or_else(|| v.get("message").and_then(|m| text(m, &["channelId", "channel"]))), text(v, &["messageId", "id"]).or_else(|| v.get("message").and_then(|m| text(m, &["_id", "id"]))))
}

/// `(channelId, userId)` of a `chat:read` event. The server sends it to ALL members of small channels, so only the own id counts.
pub fn read_event(v: &Value) -> (Option<String>, Option<String>) {
    (text(v, &["channelId"]), text(v, &["userId"]))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cadence {
    pub bootstrap: Option<Duration>,
    /// Re-fetching the open channel.
    pub channel: Option<Duration>,
}

/// The polling safety net (plan 2.2). The socket is the main path, the polls only cover events lost across backend
/// workers: while the dock is open and the window focused the open channel is re-fetched every 10 s and the channel list
/// every 45 s; without a live socket 4 s and 15 s. With the dock closed nothing is polled while the socket is live (one
/// catch-up bootstrap on focus is the hub's job); without a socket the list is kept fresh every 45 s for the status bar.
pub fn cadence(dock_open: bool, link: &ChatLink) -> Cadence {
    let up = *link == ChatLink::Live;
    let s = Duration::from_secs;
    match (dock_open, up) {
        (true, true) => Cadence { bootstrap: Some(s(45)), channel: Some(s(10)) },
        (true, false) => Cadence { bootstrap: Some(s(15)), channel: Some(s(4)) },
        (false, true) => Cadence { bootstrap: None, channel: None },
        (false, false) => Cadence { bootstrap: Some(s(45)), channel: None },
    }
}

/// Whether a new message deserves a toast. `viewing` is true when that channel is open in a visible, focused dock.
/// A thread reply only asks when it mentions the user (the server's notification covers the threads one follows).
pub fn should_notify(ch: Option<&ChatChannel>, msg: &ChatMessage, viewing: bool) -> bool {
    if msg.mine || msg.system || msg.deleted || viewing {
        return false;
    }
    if msg.thread_root.is_some() {
        return msg.mentions_me && ch.is_none_or(|c| c.notify_level != NotifyLevel::None);
    }
    let Some(ch) = ch else { return msg.mentions_me };
    if ch.muted {
        return msg.mentions_me;
    }
    match ch.notify_level {
        NotifyLevel::None => false,
        NotifyLevel::Mentions => msg.mentions_me || ch.kind.is_direct(),
        NotifyLevel::All => true,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use serde_json::json;

    use super::*;

    /// A fixture copied from the real shape (`serializeMessage`).
    pub(crate) fn real_message(id: &str, channel: &str, sender: &str, text: &str, at: &str) -> Value {
        json!({
            "_id": id, "channel": channel, "restaurant": "r_1",
            "sender": { "_id": sender, "name": "Anna", "avatar": "", "isPortal": false },
            "bot": null, "kind": "text", "text": text, "systemEvent": null,
            "mentions": { "users": [], "channel": false },
            "attachments": [], "reactions": [], "recordRefs": [], "meeting": null,
            "threadRoot": null, "replyCount": 0, "lastReplyAt": null, "replyUsers": [],
            "pinned": false, "pinnedBy": null, "editedAt": null, "deletedAt": null, "clientMessageId": null, "createdAt": at
        })
    }

    pub(crate) fn msg(id: &str, ch: &str, at: i64) -> ChatMessage {
        let mut v = real_message(id, ch, "u_2", &format!("text {id}"), "2026-10-03T08:00:00Z");
        v["createdAt"] = json!(at);
        message(&v, None, "u_1").unwrap()
    }

    fn real_channel() -> Value {
        json!({
            "_id": "c1", "restaurant": "r_1", "type": "public", "name": "general", "description": "All hands", "topic": "Weekly", "archived": false,
            "createdBy": "u_9", "createdAt": "2026-09-01T08:00:00Z", "lastMessageAt": "2026-10-03T08:00:00Z",
            "lastMessagePreview": { "text": "hi", "senderName": "Anna", "at": "2026-10-03T08:00:00Z" },
            "memberCount": 12, "record": null, "customer": null, "directPeers": [], "pinnedCount": 0,
            "me": { "role": "admin", "isMember": true, "unreadCount": 3, "mentionCount": 1, "lastReadMessageId": null, "lastReadAt": null, "notifyLevel": "mentions", "mutedUntil": null, "starred": true, "hidden": false }
        })
    }

    #[test]
    fn bootstrap_reads_the_real_channel_shape() {
        let dm = json!({ "_id": "d1", "type": "direct", "name": "", "memberCount": 2, "directPeers": [{ "_id": "u_2", "name": "Anna", "avatar": "" }], "me": { "isMember": true, "unreadCount": 1, "mutedUntil": "2999-01-01T00:00:00Z" } });
        let b = bootstrap(&json!({ "channels": [real_channel(), dm, { "name": "no id" }], "unreadTotal": 99, "mentionTotal": 9, "me": { "_id": "u_1" }, "restaurantId": "r_1", "credits": { "balance": 1.5 }, "permissions": { "createChannel": true, "manageChannels": false } }));
        assert_eq!(b.channels.len(), 2);
        let c = &b.channels[0];
        assert_eq!((c.unread_count, c.mention_count, c.notify_level.clone(), c.kind.clone(), c.member_count, c.starred), (3, 1, NotifyLevel::Mentions, ChatKind::Channel, 12, true));
        assert_eq!((c.topic.as_str(), c.description.as_str(), c.role.as_deref(), c.last_preview.as_deref(), c.is_member), ("Weekly", "All hands", Some("admin"), Some("hi"), true));
        let d = &b.channels[1];
        assert_eq!((d.kind.clone(), d.name.as_str(), d.muted, d.peers.len()), (ChatKind::Direct, "Anna", true, 1), "a DM has no name: its peers are its name");
        assert_eq!((b.credits, b.restaurant_id.as_deref(), b.can_create_channel, b.can_manage_channels), (Some(1.5), Some("r_1"), true, false));
    }

    #[test]
    fn channel_types_map_to_kinds() {
        let k = |t: &str| channel(&json!({ "_id": "x", "type": t })).unwrap().kind;
        assert_eq!([k("public"), k("private"), k("direct"), k("group"), k("record"), k("customer")], [ChatKind::Channel, ChatKind::Private, ChatKind::Direct, ChatKind::Group, ChatKind::Record, ChatKind::Customer]);
        assert!(ChatKind::Group.is_direct() && ChatKind::Direct.is_direct() && !ChatKind::Private.is_direct());
    }

    #[test]
    fn messages_read_the_real_shape() {
        let mut v = real_message("m1", "c1", "u_2", "szia @Elek", "2026-10-03T08:00:00Z");
        v["mentions"] = json!({ "users": ["u_1"], "channel": false });
        v["editedAt"] = json!("2026-10-03T08:01:00Z");
        v["reactions"] = json!([{ "emoji": "👍", "users": ["u_1", "u_3"], "count": 2 }, { "emoji": "x", "users": [], "count": 0 }]);
        v["attachments"] = json!([{ "documentId": "d1", "name": "a.pdf", "mimeType": "application/pdf", "size": 1234, "url": "https://x.test/a", "thumbnailUrl": "" }]);
        v["replyCount"] = json!(3);
        v["lastReplyAt"] = json!("2026-10-03T09:00:00Z");
        v["replyUsers"] = json!([{ "_id": "u_3", "name": "Péter", "avatar": "" }]);
        let m = message(&v, None, "u_1").unwrap();
        assert_eq!((m.channel_id.as_str(), m.sender_id.as_str(), m.sender_name.as_str(), m.text.as_str(), m.mentions_me, m.mine, m.edited), ("c1", "u_2", "Anna", "szia @Elek", true, false, true));
        assert_eq!((m.reactions.len(), m.reactions[0].count, m.reactions[0].mine, m.attachments.len(), m.attachments[0].size), (1, 2, true, 1, 1234));
        assert_eq!((m.reply_count, m.reply_users.len(), m.last_reply_at_ms.is_some(), m.thread_root.clone()), (3, 1, true, None));
        // @channel counts as a mention, the own message never does.
        let mut all = real_message("m2", "c1", "u_2", "@channel", "2026-10-03T08:00:00Z");
        all["mentions"] = json!({ "users": [], "channel": true });
        assert!(message(&all, None, "u_1").unwrap().mentions_me && !message(&all, None, "u_2").unwrap().mentions_me);
        let mut gone = real_message("m3", "c1", "u_1", "secret", "2026-10-03T08:00:00Z");
        gone["deletedAt"] = json!("2026-10-03T08:01:00Z");
        let gone = message(&gone, None, "u_1").unwrap();
        assert!(gone.deleted && gone.text.is_empty() && gone.mine);
        // A message from the event payload takes its channel from the event; without any channel it is refused.
        let mut bare = real_message("m4", "", "u_2", "t", "2026-10-03T08:00:00Z");
        bare.as_object_mut().unwrap().remove("channel");
        assert_eq!(message(&bare, Some("c9"), "u_1").unwrap().channel_id, "c9");
        assert!(message(&bare, None, "u_1").is_none());
        assert!(message(&json!({ "text": "no id" }), Some("c1"), "u_1").is_none());
        let huge = message(&real_message("m9", "c1", "u_2", &"é".repeat(MAX_TEXT * 3), "2026-10-03T08:00:00Z"), None, "u_1").unwrap();
        assert!(huge.text.chars().count() == MAX_TEXT + 1 && huge.text.ends_with('…'));
        // A system line has no sender.
        let mut sys = real_message("m5", "c1", "u_2", "Anna joined", "2026-10-03T08:00:00Z");
        sys["sender"] = Value::Null;
        sys["kind"] = json!("system");
        let sys = message(&sys, None, "u_1").unwrap();
        assert!(sys.system && sys.sender_id.is_empty());
    }

    #[test]
    fn a_page_is_sorted_oldest_first_without_thread_replies_and_carries_the_cursor() {
        let mut reply = real_message("r1", "c1", "u_2", "reply", "2026-10-03T08:00:05Z");
        reply["threadRoot"] = json!("m1");
        let p = page(
            &json!({ "items": [real_message("m3", "c1", "u_2", "c", "2026-10-03T08:00:30Z"), real_message("m1", "c1", "u_2", "a", "2026-10-03T08:00:10Z"), reply, real_message("m2", "c1", "u_2", "b", "2026-10-03T08:00:20Z"), real_message("m2", "c1", "u_2", "b", "2026-10-03T08:00:20Z")], "hasMore": true, "hasNewer": true, "anchorId": "m2" }),
            "c1",
            "u_1",
        );
        assert_eq!(p.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m1", "m2", "m3"]);
        assert_eq!((p.has_more, p.cursor.as_deref(), p.has_newer, p.anchor_id.as_deref()), (true, Some("m1"), true, Some("m2")));
        assert_eq!(page(&json!({ "items": [], "hasMore": false, "hasNewer": false }), "c1", "u_1").cursor, None);
    }

    #[test]
    fn a_thread_and_the_thread_list_read_the_real_shape() {
        let mut root = real_message("m1", "c1", "u_2", "root", "2026-10-03T08:00:00Z");
        root["replyCount"] = json!(2);
        let mut r = real_message("r1", "c1", "u_1", "mine", "2026-10-03T08:01:00Z");
        r["threadRoot"] = json!("m1");
        let t = thread(&json!({ "root": root, "items": [r] }), "u_1").unwrap();
        assert_eq!((t.channel_id.as_str(), t.root.reply_count, t.replies.len(), t.replies[0].thread_root.as_deref(), t.replies[0].mine), ("c1", 2, 1, Some("m1"), true));
        let list = threads(&json!({ "items": [{ "root": root, "channel": { "_id": "c1", "name": "general", "type": "public" }, "replyCount": 2, "lastReplyAt": "2026-10-03T08:01:00Z", "unreadCount": 1 }] }), "u_1");
        assert_eq!((list.len(), list[0].channel_name.as_str(), list[0].unread_count, list[0].reply_count, list[0].root.id.as_str()), (1, "general", 1, 2, "m1"));
    }

    #[test]
    fn the_cadence_follows_the_dock_and_the_socket() {
        let s = Duration::from_secs;
        assert_eq!(cadence(true, &ChatLink::Live), Cadence { bootstrap: Some(s(45)), channel: Some(s(10)) });
        assert_eq!(cadence(true, &ChatLink::Reconnecting), Cadence { bootstrap: Some(s(15)), channel: Some(s(4)) });
        assert_eq!(cadence(false, &ChatLink::Live), Cadence { bootstrap: None, channel: None }, "closed dock + live socket: no polling");
        assert_eq!(cadence(false, &ChatLink::Off), Cadence { bootstrap: Some(s(45)), channel: None });
    }

    #[test]
    fn toasts_follow_the_notify_level() {
        let ch = |level: NotifyLevel, muted, kind| ChatChannel { notify_level: level, muted, kind, ..channel(&json!({ "_id": "c1", "name": "n" })).unwrap() };
        let (plain, mention) = (msg("m1", "c1", 1), ChatMessage { mentions_me: true, ..msg("m2", "c1", 2) });
        assert!(should_notify(Some(&ch(NotifyLevel::All, false, ChatKind::Channel)), &plain, false));
        assert!(!should_notify(Some(&ch(NotifyLevel::All, false, ChatKind::Channel)), &plain, true), "not while looking at it");
        assert!(!should_notify(Some(&ch(NotifyLevel::Mentions, false, ChatKind::Channel)), &plain, false));
        assert!(should_notify(Some(&ch(NotifyLevel::Mentions, false, ChatKind::Channel)), &mention, false));
        assert!(should_notify(Some(&ch(NotifyLevel::Mentions, false, ChatKind::Direct)), &plain, false), "a DM beats the mentions level");
        assert!(should_notify(Some(&ch(NotifyLevel::Mentions, false, ChatKind::Group)), &plain, false), "so does a group DM");
        assert!(!should_notify(Some(&ch(NotifyLevel::None, false, ChatKind::Channel)), &mention, false));
        assert!(!should_notify(Some(&ch(NotifyLevel::All, true, ChatKind::Channel)), &plain, false) && should_notify(Some(&ch(NotifyLevel::All, true, ChatKind::Channel)), &mention, false));
        assert!(!should_notify(Some(&ch(NotifyLevel::All, false, ChatKind::Channel)), &ChatMessage { mine: true, ..plain.clone() }, false));
        let reply = ChatMessage { thread_root: Some("m0".into()), ..plain };
        assert!(!should_notify(Some(&ch(NotifyLevel::All, false, ChatKind::Channel)), &reply, false), "a plain thread reply does not ask for a toast");
        assert!(should_notify(Some(&ch(NotifyLevel::All, false, ChatKind::Channel)), &ChatMessage { mentions_me: true, ..reply }, false));
    }

    #[test]
    fn people_and_members_read_items() {
        let p = people(&json!({ "items": [{ "_id": "u_2", "name": "Anna", "email": "a@example.test", "role": "sales", "isPortal": false }, { "_id": "u_3", "email": "b@example.test" }, { "name": "no id" }] }));
        assert_eq!(p.iter().map(|x| (x.id.as_str(), x.name.as_str(), x.detail.as_deref())).collect::<Vec<_>>(), [("u_2", "Anna", Some("sales")), ("u_3", "b@example.test", Some("b@example.test"))]);
        let m = members(&json!({ "items": [{ "_id": "u_2", "name": "Anna", "email": "a@example.test", "role": "admin", "isPortal": false, "joinedAt": "2026-10-03T08:00:00Z", "online": true }] }));
        assert_eq!((m[0].id.as_str(), m[0].role.as_str(), m[0].online, m[0].email.as_deref()), ("u_2", "admin", true, Some("a@example.test")));
    }

    #[test]
    fn a_read_event_names_its_reader() {
        assert_eq!(read_event(&json!({ "channelId": "c1", "userId": "u_2", "lastReadMessageId": "m1" })), (Some("c1".into()), Some("u_2".into())));
    }
}
