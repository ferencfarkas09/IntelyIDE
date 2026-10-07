//! Team chat REST: the provider's polling safety net and the verbs the webview calls (bootstrap, messages with pagination,
//! threads, send with `clientMessageId`, read marker, directory, direct/group channels, create/browse/join/leave, members,
//! edit/delete/reactions/pins, search, preferences). Paths and field names are the real backend's (the Happy backend
//! `teamChat.controller.js`).
//!
//! Sending costs store credits on the real service: the summary carries `sendCost` and `creditsEmpty`, and a 402 keeps the
//! failed message visible for a retry. Message bodies are never put into an error or a log line. Users of more than one
//! store must name the store (`restaurantId`) on the directory, direct, search, threads and create calls: it is the one
//! the bootstrap answered for.

use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::cache::{thread_key, Applied};
use crate::chat::{self, cadence, MAX_TEXT, PAGE, SEND_COST};
use crate::hub::{random_id, Hub, Id};
use crate::net::{ApiError, Kind, Method, Scope};
use crate::time::now_ms;
use crate::types::{ChatChannel, ChatEvent, ChatMember, ChatMessage, ChatPerson, ChatSearch, ChatSummary, MessageChange, MessagePage, NotifyLevel, SendState, ThreadSummary, ThreadView};

const DIRECTORY_TTL: Duration = Duration::from_secs(300);
const TYPING_THROTTLE: Duration = Duration::from_secs(3);
const THREADS_DELAY: Duration = Duration::from_millis(1500);

/// How often the chat loop wakes up. Most wake-ups do nothing: `tick_chat` decides what is due.
pub(crate) fn tick_period(dock_open: bool) -> Duration {
    Duration::from_secs(if dock_open { 2 } else { 15 })
}

fn invalid(code: &str, message: &str) -> ApiError {
    ApiError::new(Kind::Invalid, None, code, message)
}

fn id_ok(id: &str) -> Result<(), ApiError> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) {
        return Err(invalid("invalidId", "That id is not valid"));
    }
    Ok(())
}

impl Hub {
    /// One wake-up of the chat loop: the first one, a focus gain or a reconnect refreshes the list (and the open channel);
    /// otherwise what the cadence says is due (see `chat::cadence`).
    pub(crate) async fn tick_chat(&self) -> Result<(), ApiError> {
        let (boot, channel) = {
            let mut st = self.st();
            let cad = cadence(st.chat.dock_open, &self.0.rt.link());
            let catch = std::mem::take(&mut st.chat.catchup);
            let slack = Duration::from_millis(500);
            let due = |last: Option<Instant>, every: Option<Duration>| every.is_some_and(|e| last.is_none_or(|l| l.elapsed() + slack >= e));
            let boot = catch || st.chat.last_bootstrap.is_none() || due(st.chat.last_bootstrap, cad.bootstrap);
            let channel = if st.chat.dock_open && (catch || due(st.chat.last_channel, cad.channel)) { st.chat.open_channel.clone() } else { None };
            (boot, channel)
        };
        if boot {
            self.fetch_bootstrap().await?;
        }
        if let Some(channel) = channel {
            match self.fetch_latest(&channel).await {
                // The open channel is gone (removed, or the member left): that is not "chat is unavailable". The pilot gate
                // (the whole store is not enabled) is, and it says so.
                Err(e) if matches!(e.kind, Kind::NotFound | Kind::Forbidden) && e.code != chat::NOT_ENABLED => self.st().chat.open_channel = None,
                other => other?,
            }
        }
        Ok(())
    }

    /// The store the calls name: the one the bootstrap answered for, else the user's first store.
    pub(crate) fn store(&self) -> Option<String> {
        let st = self.st();
        st.chat.cache.restaurant_id.clone().or_else(|| st.user.as_ref().and_then(|u| u.restaurant_id.clone()))
    }

    pub(crate) async fn fetch_bootstrap(&self) -> Result<(), ApiError> {
        let store = self.store();
        let query: Vec<(&str, &str)> = store.as_deref().map(|s| ("restaurantId", s)).into_iter().collect();
        let v = self.request(Scope::Chat, Method::Get, "/api/chat/bootstrap", &query, None).await?;
        {
            let mut st = self.st();
            st.chat.cache.set_bootstrap(chat::bootstrap(&v));
            st.chat.misses = 0;
            st.chat.last_bootstrap = Some(Instant::now());
        }
        self.emit_summary();
        // The thread-unread aggregate is server-driven too; a failure here never fails the list.
        self.refresh_threads().await;
        Ok(())
    }

    /// The newest page of a channel, merged into the cache; what is new (a lost socket event) goes out as deltas.
    pub(crate) async fn fetch_latest(&self, channel: &str) -> Result<(), ApiError> {
        let path = format!("/api/chat/channels/{channel}/messages");
        let limit = PAGE.to_string();
        let v = self.request(Scope::Chat, Method::Get, &path, &[("limit", &limit)], None).await?;
        let page = chat::page(&v, channel, &self.me());
        let changed = {
            let mut st = self.st();
            st.chat.last_channel = Some(Instant::now());
            st.chat.cache.merge_page(&page, false)
        };
        for (message, applied) in changed {
            if let Some(change) = applied.change() {
                self.emit(&ChatEvent::Message { channel_id: channel.to_owned(), message, change, notify: false });
            }
        }
        Ok(())
    }

    /// The threads with unread replies (`GET /api/chat/threads?unread=true`) feed the "Threads" badge.
    pub(crate) async fn refresh_threads(&self) {
        let Ok(list) = self.fetch_threads(true).await else { return };
        let unread = list.iter().filter(|t| t.unread_count > 0).map(|t| (t.root.id.clone(), t.unread_count)).collect();
        self.st().chat.cache.set_unread_threads(unread);
        self.emit_summary();
    }

    /// A reply arrived: ask the server for the thread counters shortly (one request per burst).
    pub(crate) fn refresh_threads_soon(&self) {
        {
            let mut st = self.st();
            if st.chat.threads_pending {
                return;
            }
            st.chat.threads_pending = true;
        }
        let hub = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(THREADS_DELAY).await;
            hub.st().chat.threads_pending = false;
            hub.refresh_threads().await;
        });
    }

    async fn fetch_threads(&self, unread_only: bool) -> Result<Vec<ThreadSummary>, ApiError> {
        let store = self.store();
        let mut query: Vec<(&str, &str)> = vec![("limit", "100")];
        if unread_only {
            query.push(("unread", "true"));
        }
        if let Some(s) = store.as_deref() {
            query.push(("restaurantId", s));
        }
        let v = self.request(Scope::Chat, Method::Get, "/api/chat/threads", &query, None).await?;
        Ok(chat::threads(&v, &self.me()))
    }

    fn emit_applied(&self, message: &ChatMessage, applied: Applied) {
        if let Some(change) = applied.change() {
            self.emit(&ChatEvent::Message { channel_id: message.channel_id.clone(), message: message.clone(), change, notify: false });
        }
    }

    /// Applies the server's copy of a message an edit, a reaction or a pin returned, and announces it.
    fn apply_server_message(&self, v: &Value) -> Option<ChatMessage> {
        let m = chat::message(v.get("message").unwrap_or(v), None, &self.me())?;
        let applied = self.st().chat.cache.apply_update(m.clone());
        self.emit_applied(&m, applied);
        Some(m)
    }

    // ---- the verbs the webview calls ----

    pub fn chat_summary(&self) -> ChatSummary {
        self.st().chat.cache.summary(self.0.rt.link())
    }

    /// Fetches the channel list now.
    pub async fn chat_refresh(&self) -> Result<ChatSummary, ApiError> {
        self.require(Id::Chat)?;
        self.fetch_bootstrap().await?;
        Ok(self.chat_summary())
    }

    /// The UI reports whether the chat tab is visible and which channel is open; it switches the polling safety net on and off.
    pub fn chat_set_active(&self, dock_open: bool, channel: Option<String>) {
        let opened = {
            let mut st = self.st();
            let opened = dock_open && !st.chat.dock_open;
            st.chat.dock_open = dock_open;
            st.chat.open_channel = if dock_open { channel } else { None };
            opened
        };
        if opened {
            self.0.chat_wake.notify_one();
        }
    }

    /// Opens a channel: it becomes the polled channel, the newest page is fetched, and everything cached for it comes back.
    pub async fn chat_open(&self, channel: &str) -> Result<MessagePage, ApiError> {
        self.require(Id::Chat)?;
        id_ok(channel)?;
        self.chat_set_active(true, Some(channel.to_owned()));
        self.fetch_latest(channel).await?;
        let st = self.st();
        let messages = st.chat.cache.messages(channel).to_vec();
        let has_more = st.chat.cache.has_more(channel);
        let cursor = if has_more { messages.first().map(|m| m.id.clone()) } else { None };
        Ok(MessagePage { channel_id: channel.to_owned(), messages, has_more, cursor, has_newer: false, anchor_id: None })
    }

    /// One page of a channel's history by cursor: `before` (older), `after` (newer) or `around` (a window on one message,
    /// for jumping to it). Only the older pages are merged into the cache; the others are returned as they are, because
    /// they are not contiguous with the newest page the cache keeps.
    async fn history(&self, channel: &str, which: &str, cursor: &str) -> Result<MessagePage, ApiError> {
        self.require(Id::Chat)?;
        id_ok(channel)?;
        id_ok(cursor)?;
        let path = format!("/api/chat/channels/{channel}/messages");
        let limit = PAGE.to_string();
        let v = self.request(Scope::Chat, Method::Get, &path, &[("limit", &limit), (which, cursor)], None).await?;
        Ok(chat::page(&v, channel, &self.me()))
    }

    /// The next older page (`before` is the cursor of the page before).
    pub async fn chat_older(&self, channel: &str, before: &str) -> Result<MessagePage, ApiError> {
        let page = self.history(channel, "before", before).await?;
        {
            // Only a page that continues the cached list is kept: after a jump (`around`) the list on screen is not the cache.
            let mut st = self.st();
            if st.chat.cache.oldest_id(channel) == Some(before) {
                st.chat.cache.merge_page(&page, true);
            }
        }
        Ok(page)
    }

    /// The window around one message (a notification, a thread root, a search hit); `hasMore`/`hasNewer` say what is beyond.
    pub async fn chat_around(&self, channel: &str, message: &str) -> Result<MessagePage, ApiError> {
        self.history(channel, "around", message).await
    }

    /// The page after a message (after a jump: scrolling towards the present).
    pub async fn chat_newer(&self, channel: &str, after: &str) -> Result<MessagePage, ApiError> {
        self.history(channel, "after", after).await
    }

    /// Sends a message, or a thread reply when `thread_root` is given. The optimistic copy is in the cache (and in a
    /// `happy:chat` event) before the request leaves; the server's copy replaces it, and so does the socket echo, whichever
    /// comes first. A retry passes the failed message's `clientMessageId`, so a send that actually arrived is not
    /// duplicated. `mentions` are user ids. Spends store credits on the real service.
    pub async fn chat_send(&self, channel: &str, text: &str, mentions: Vec<String>, client_message_id: Option<String>, thread_root: Option<String>) -> Result<ChatMessage, ApiError> {
        self.require(Id::Chat)?;
        id_ok(channel)?;
        if let Some(root) = &thread_root {
            id_ok(root)?;
        }
        let text = text.trim();
        if text.is_empty() || text.chars().count() > MAX_TEXT {
            return Err(invalid("invalidMessage", "A message needs 1 to 8000 characters"));
        }
        let (me, name) = self.st().user.as_ref().map(|u| (u.id.clone(), u.name.clone())).unwrap_or_default();
        let client_id = client_message_id.unwrap_or_else(|| format!("cm-{}", random_id()));
        let key = thread_root.as_deref().map_or_else(|| channel.to_owned(), thread_key);
        let pending = ChatMessage {
            id: format!("local-{client_id}"),
            channel_id: channel.to_owned(),
            client_message_id: Some(client_id.clone()),
            sender_id: me.clone(),
            sender_name: name,
            text: text.to_owned(),
            created_at_ms: now_ms(),
            edited: false,
            deleted: false,
            system: false,
            kind: "text".to_owned(),
            mine: true,
            mentions_me: false,
            send_state: SendState::Pending,
            error_code: None,
            thread_root: thread_root.clone(),
            reply_count: 0,
            last_reply_at_ms: None,
            reply_users: Vec::new(),
            reactions: Vec::new(),
            attachments: Vec::new(),
            pinned: false,
        };
        let pending = self.st().chat.cache.add_pending(pending);
        self.emit(&ChatEvent::Message { channel_id: channel.to_owned(), message: pending, change: MessageChange::New, notify: false });
        let path = format!("/api/chat/channels/{channel}/messages");
        let mut body = json!({ "text": text, "clientMessageId": client_id, "mentions": { "users": mentions, "channel": false } });
        if let Some(root) = &thread_root {
            body["threadRootId"] = json!(root);
        }
        match self.request(Scope::Chat, Method::Post, &path, &[], Some(&body)).await {
            Ok(v) => {
                let sent = chat::message(v.get("message").unwrap_or(&v), Some(channel), &me).map(|m| ChatMessage { client_message_id: m.client_message_id.clone().or_else(|| Some(client_id.clone())), ..m });
                let Some(sent) = sent else {
                    return Err(self.send_failed(&key, channel, &client_id, &invalid("invalidResponse", "The server's answer to the send was unreadable")));
                };
                let applied = {
                    let mut st = self.st();
                    st.chat.cache.credits_empty = false;
                    st.chat.cache.credits = v.get("credits").and_then(Value::as_f64).or(st.chat.cache.credits.map(|c| (c - SEND_COST).max(0.0)));
                    if sent.thread_root.is_none() {
                        st.chat.cache.set_last_message(channel, sent.created_at_ms);
                    }
                    st.chat.cache.apply_message(sent.clone())
                };
                self.emit_applied(&sent, applied);
                self.emit_summary();
                Ok(sent)
            }
            Err(e) => Err(self.send_failed(&key, channel, &client_id, &e)),
        }
    }

    /// Keeps the failed message visible (with its text, for Retry). A 402 also blocks the composer until a send or a
    /// bootstrap says otherwise.
    fn send_failed(&self, key: &str, channel: &str, client_id: &str, e: &ApiError) -> ApiError {
        let failed = {
            let mut st = self.st();
            if e.kind == Kind::Credits {
                st.chat.cache.credits_empty = true;
            }
            st.chat.cache.fail_pending(key, client_id, &e.code)
        };
        if let Some(message) = failed {
            self.emit(&ChatEvent::Message { channel_id: channel.to_owned(), message, change: MessageChange::Failed, notify: false });
        }
        self.emit_summary();
        e.clone()
    }

    /// Marks a channel read: the counters clear at once, the server is told, and `chat:read` keeps other devices right.
    pub async fn chat_mark_read(&self, channel: &str) -> Result<ChatSummary, ApiError> {
        self.require(Id::Chat)?;
        id_ok(channel)?;
        let changed = self.st().chat.cache.clear_unread(channel);
        if changed {
            self.emit_summary();
        }
        let path = format!("/api/chat/channels/{channel}/read");
        self.request(Scope::Chat, Method::Post, &path, &[], Some(&json!({}))).await?;
        Ok(self.chat_summary())
    }

    // ---- threads ----

    /// A thread: the root and its replies. The server marks it read for the user, so its unread count clears here too.
    pub async fn chat_thread(&self, root: &str) -> Result<ThreadView, ApiError> {
        self.require(Id::Chat)?;
        id_ok(root)?;
        let path = format!("/api/chat/messages/{root}/thread");
        let v = self.request(Scope::Chat, Method::Get, &path, &[], None).await?;
        let view = chat::thread(&v, &self.me()).ok_or_else(|| invalid("invalidResponse", "The server's answer was unreadable"))?;
        let changed = {
            let mut st = self.st();
            st.chat.cache.merge_thread(root, &view.replies);
            st.chat.cache.clear_thread_unread(root)
        };
        if changed {
            self.emit_summary();
        }
        Ok(view)
    }

    /// The "Threads" list: threads the user takes part in, newest reply first; `unread_only` keeps those with news.
    pub async fn chat_threads(&self, unread_only: bool) -> Result<Vec<ThreadSummary>, ApiError> {
        self.require(Id::Chat)?;
        let list = self.fetch_threads(unread_only).await?;
        if unread_only {
            let unread = list.iter().filter(|t| t.unread_count > 0).map(|t| (t.root.id.clone(), t.unread_count)).collect();
            self.st().chat.cache.set_unread_threads(unread);
            self.emit_summary();
        }
        Ok(list)
    }

    // ---- people and conversations ----

    /// People for the mention picker, the new-direct-message search and the invite dialog: the directory is fetched once per
    /// 5 minutes and filtered here.
    pub async fn chat_directory(&self, query: &str) -> Result<Vec<ChatPerson>, ApiError> {
        self.require(Id::Chat)?;
        let cached = self.st().chat.people.as_ref().filter(|(at, _)| at.elapsed() < DIRECTORY_TTL).map(|(_, p)| p.clone());
        let people = match cached {
            Some(p) => p,
            None => {
                let store = self.store();
                let query: Vec<(&str, &str)> = store.as_deref().map(|s| ("restaurantId", s)).into_iter().collect();
                let v = self.request(Scope::Chat, Method::Get, "/api/chat/directory", &query, None).await?;
                let people = chat::people(&v);
                self.st().chat.people = Some((Instant::now(), people.clone()));
                people
            }
        };
        let needle = query.trim().to_lowercase();
        Ok(people.into_iter().filter(|p| needle.is_empty() || p.name.to_lowercase().contains(&needle)).take(30).collect())
    }

    fn put_channel(&self, v: &Value) -> Result<ChatChannel, ApiError> {
        let channel = chat::channel(v.get("channel").unwrap_or(v)).ok_or_else(|| invalid("invalidResponse", "The server's answer was unreadable"))?;
        self.st().chat.cache.upsert_channel(channel.clone());
        self.emit_summary();
        Ok(channel)
    }

    /// Opens (or creates) the direct channel with one person, or a group conversation with several (1 to 7 other people).
    pub async fn chat_open_direct(&self, user_ids: &[String]) -> Result<ChatChannel, ApiError> {
        self.require(Id::Chat)?;
        if user_ids.is_empty() || user_ids.len() > 7 {
            return Err(invalid("invalidUsers", "Pick 1 to 7 people"));
        }
        user_ids.iter().try_for_each(|u| id_ok(u))?;
        let mut body = json!({ "userIds": user_ids });
        if let Some(store) = self.store() {
            body["restaurantId"] = json!(store);
        }
        let v = self.request(Scope::Chat, Method::Post, "/api/chat/direct", &[], Some(&body)).await?;
        self.put_channel(&v)
    }

    /// Public channels the user has not joined (`browse`), optionally filtered by name.
    pub async fn chat_browse(&self, query: &str) -> Result<Vec<ChatChannel>, ApiError> {
        self.require(Id::Chat)?;
        let store = self.store();
        let search = query.trim();
        let mut q: Vec<(&str, &str)> = vec![("browse", "true")];
        if !search.is_empty() {
            q.push(("search", search));
        }
        if let Some(s) = store.as_deref() {
            q.push(("restaurantId", s));
        }
        let v = self.request(Scope::Chat, Method::Get, "/api/chat/channels", &q, None).await?;
        Ok(chat::channels(&v).into_iter().filter(|c| !c.archived).collect())
    }

    /// Creates a public or private channel. The server's refusals come through with their codes (`CREATE_FORBIDDEN`,
    /// `CHANNEL_NAME_TAKEN`, `NAME_REQUIRED`, ...).
    pub async fn chat_create_channel(&self, name: &str, description: &str, private: bool, member_ids: &[String]) -> Result<ChatChannel, ApiError> {
        self.require(Id::Chat)?;
        let name = name.trim();
        if name.is_empty() {
            return Err(ApiError::new(Kind::Invalid, None, "NAME_REQUIRED", "A channel needs a name"));
        }
        member_ids.iter().try_for_each(|u| id_ok(u))?;
        let mut body = json!({ "type": if private { "private" } else { "public" }, "name": name, "memberIds": member_ids });
        if !description.trim().is_empty() {
            body["description"] = json!(description.trim());
        }
        if let Some(store) = self.store() {
            body["restaurantId"] = json!(store);
        }
        let v = self.request(Scope::Chat, Method::Post, "/api/chat/channels", &[], Some(&body)).await?;
        self.put_channel(&v)
    }

    pub async fn chat_join(&self, channel: &str) -> Result<ChatChannel, ApiError> {
        self.require(Id::Chat)?;
        id_ok(channel)?;
        let v = self.request(Scope::Chat, Method::Post, &format!("/api/chat/channels/{channel}/join"), &[], Some(&json!({}))).await?;
        self.put_channel(&v)
    }

    pub async fn chat_leave(&self, channel: &str) -> Result<(), ApiError> {
        self.require(Id::Chat)?;
        id_ok(channel)?;
        self.request(Scope::Chat, Method::Post, &format!("/api/chat/channels/{channel}/leave"), &[], Some(&json!({}))).await?;
        let gone = self.st().chat.cache.remove_channel(channel);
        if gone {
            self.emit_summary();
        }
        Ok(())
    }

    /// Name, description and topic of a channel (the server decides who may).
    pub async fn chat_update_channel(&self, channel: &str, name: Option<String>, description: Option<String>, topic: Option<String>) -> Result<ChatChannel, ApiError> {
        self.require(Id::Chat)?;
        id_ok(channel)?;
        let mut body = Map::new();
        for (k, v) in [("name", name), ("description", description), ("topic", topic)] {
            if let Some(v) = v {
                body.insert(k.to_owned(), json!(v.trim()));
            }
        }
        let v = self.request(Scope::Chat, Method::Patch, &format!("/api/chat/channels/{channel}"), &[], Some(&Value::Object(body))).await?;
        self.put_channel(&v)
    }

    /// The member's own preferences for a channel: `notify_level`, mute (for an hour/day/forever, or off) and the star.
    pub async fn chat_preferences(&self, channel: &str, notify_level: Option<NotifyLevel>, muted_until_ms: Option<Option<i64>>, starred: Option<bool>) -> Result<ChatChannel, ApiError> {
        self.require(Id::Chat)?;
        id_ok(channel)?;
        let mut body = Map::new();
        if let Some(level) = notify_level {
            body.insert("notifyLevel".to_owned(), json!(match level { NotifyLevel::All => "all", NotifyLevel::Mentions => "mentions", NotifyLevel::None => "none" }));
        }
        if let Some(until) = muted_until_ms {
            body.insert("mutedUntil".to_owned(), until.map_or(Value::Null, |ms| json!(crate::time::to_iso(ms))));
        }
        if let Some(star) = starred {
            body.insert("starred".to_owned(), json!(star));
        }
        let v = self.request(Scope::Chat, Method::Patch, &format!("/api/chat/channels/{channel}/preferences"), &[], Some(&Value::Object(body))).await?;
        self.put_channel(&v)
    }

    // ---- members (invite) ----

    pub async fn chat_members(&self, channel: &str) -> Result<Vec<ChatMember>, ApiError> {
        self.require(Id::Chat)?;
        id_ok(channel)?;
        let v = self.request(Scope::Chat, Method::Get, &format!("/api/chat/channels/{channel}/members"), &[], None).await?;
        Ok(chat::members(&v))
    }

    /// Adds people to a channel (not to a direct/group one: the server refuses with `DIRECT_IMMUTABLE`; a private channel
    /// needs a channel admin: `MANAGE_FORBIDDEN`). Returns the members that were added.
    pub async fn chat_add_members(&self, channel: &str, user_ids: &[String]) -> Result<Vec<ChatMember>, ApiError> {
        self.require(Id::Chat)?;
        id_ok(channel)?;
        if user_ids.is_empty() {
            return Err(ApiError::new(Kind::Invalid, None, "USERS_REQUIRED", "Pick at least one person"));
        }
        user_ids.iter().try_for_each(|u| id_ok(u))?;
        let v = self.request(Scope::Chat, Method::Post, &format!("/api/chat/channels/{channel}/members"), &[], Some(&json!({ "userIds": user_ids }))).await?;
        Ok(chat::members(&v))
    }

    pub async fn chat_remove_member(&self, channel: &str, user_id: &str) -> Result<(), ApiError> {
        self.require(Id::Chat)?;
        id_ok(channel)?;
        id_ok(user_id)?;
        self.request(Scope::Chat, Method::Delete, &format!("/api/chat/channels/{channel}/members/{user_id}"), &[], None).await?;
        Ok(())
    }

    // ---- messages: edit, delete, react, pin, search ----

    pub async fn chat_edit(&self, message: &str, text: &str) -> Result<ChatMessage, ApiError> {
        self.require(Id::Chat)?;
        id_ok(message)?;
        let text = text.trim();
        if text.is_empty() || text.chars().count() > MAX_TEXT {
            return Err(invalid("invalidMessage", "A message needs 1 to 8000 characters"));
        }
        let v = self.request(Scope::Chat, Method::Patch, &format!("/api/chat/messages/{message}"), &[], Some(&json!({ "text": text }))).await?;
        self.apply_server_message(&v).ok_or_else(|| invalid("invalidResponse", "The server's answer was unreadable"))
    }

    /// Deletes the user's own message (or any, for an admin). `thread_root` says where the message lives in the cache.
    pub async fn chat_delete(&self, channel: &str, message: &str, thread_root: Option<String>) -> Result<(), ApiError> {
        self.require(Id::Chat)?;
        id_ok(channel)?;
        id_ok(message)?;
        self.request(Scope::Chat, Method::Delete, &format!("/api/chat/messages/{message}"), &[], None).await?;
        let key = thread_root.as_deref().map_or_else(|| channel.to_owned(), thread_key);
        let gone = self.st().chat.cache.apply_deleted(&key, message);
        if let Some(message) = gone {
            self.emit(&ChatEvent::Message { channel_id: channel.to_owned(), message, change: MessageChange::Deleted, notify: false });
        }
        Ok(())
    }

    /// Toggles the user's reaction on a message.
    pub async fn chat_react(&self, message: &str, emoji: &str) -> Result<ChatMessage, ApiError> {
        self.require(Id::Chat)?;
        id_ok(message)?;
        let emoji = emoji.trim();
        if emoji.is_empty() || emoji.chars().count() > 16 {
            return Err(invalid("invalidEmoji", "Pick an emoji"));
        }
        let v = self.request(Scope::Chat, Method::Post, &format!("/api/chat/messages/{message}/reactions"), &[], Some(&json!({ "emoji": emoji }))).await?;
        self.apply_server_message(&v).ok_or_else(|| invalid("invalidResponse", "The server's answer was unreadable"))
    }

    pub async fn chat_pin(&self, message: &str, pinned: bool) -> Result<ChatMessage, ApiError> {
        self.require(Id::Chat)?;
        id_ok(message)?;
        let v = self.request(Scope::Chat, Method::Post, &format!("/api/chat/messages/{message}/pin"), &[], Some(&json!({ "pinned": pinned }))).await?;
        self.apply_server_message(&v).ok_or_else(|| invalid("invalidResponse", "The server's answer was unreadable"))
    }

    /// Server-side search over messages, channels and people (up to 30 each).
    pub async fn chat_search(&self, query: &str, channel: Option<String>) -> Result<ChatSearch, ApiError> {
        self.require(Id::Chat)?;
        let q = query.trim();
        if q.chars().count() < 2 {
            return Ok(ChatSearch { messages: Vec::new(), channels: Vec::new(), people: Vec::new() });
        }
        let store = self.store();
        let mut params: Vec<(&str, &str)> = vec![("q", q), ("type", "all")];
        if let Some(c) = channel.as_deref() {
            id_ok(c)?;
            params.push(("channelId", c));
        }
        if let Some(s) = store.as_deref() {
            params.push(("restaurantId", s));
        }
        let v = self.request(Scope::Chat, Method::Get, "/api/chat/search", &params, None).await?;
        let (messages, channels, people) = chat::search(&v, &self.me());
        Ok(ChatSearch { messages, channels, people })
    }

    /// Tells the others that the user is typing; at most one hint per 3 s, and only over a live socket.
    pub fn chat_typing(&self, channel: &str) -> bool {
        // A typing hint is an outgoing action: it needs the integration on and "Allow sending messages", like a send.
        if self.require(Id::Chat).is_err() || !self.st().cfg.chat.allow_actions {
            return false;
        }
        {
            let mut st = self.st();
            if st.chat.last_typing_sent.is_some_and(|t| t.elapsed() < TYPING_THROTTLE) {
                return false;
            }
            st.chat.last_typing_sent = Some(Instant::now());
        }
        self.0.rt.emit("chat:typing", json!({ "channelId": channel }))
    }
}
