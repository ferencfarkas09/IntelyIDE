//! Live events of the hub: the shared socket's reconciliation (opened only while a socket provider is ready), the handler that
//! turns Socket.IO events into cache changes and `happy:chat` / `happy:meetings` deltas. The chat REST verbs and the polling
//! safety net are in `chat_api.rs` ((design notes: integrations-plan) 1.5 and 2.2).
//!
//! Message bodies never go into logs or error texts here; errors carry the server's code and a fixed message.

use std::sync::Weak;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::cache::{Applied, ChatCache, Typing, TYPING_TTL_MS};
use crate::chat::{self, should_notify};
use crate::hub::{last_error, Hub, Id, Inner, St};
use crate::net::{ApiError, Kind};
use crate::parse;
use crate::socket::{Handler, Target};
use crate::time::now_ms;
use crate::types::{ChatEvent, ChatLink, ChatPerson, ChatSummary, MeetView, MeetingStatus, MessageChange, ProviderState};

/// Everything the chat provider keeps in memory; dropped with the connection (`reset`).
#[derive(Default)]
pub(crate) struct ChatState {
    pub(crate) cache: ChatCache,
    pub(crate) typing: Typing,
    /// The UI's report: the chat tab is visible.
    pub(crate) dock_open: bool,
    pub(crate) open_channel: Option<String>,
    /// Set on focus gain and after a reconnect: the next tick refreshes everything once.
    pub(crate) catchup: bool,
    pub(crate) misses: u32,
    pub(crate) last_bootstrap: Option<Instant>,
    pub(crate) last_channel: Option<Instant>,
    pub(crate) people: Option<(Instant, Vec<ChatPerson>)>,
    pub(crate) last_typing_sent: Option<Instant>,
    pub(crate) last_summary: Option<ChatSummary>,
    /// A delayed refresh of the thread counters is already scheduled (see `refresh_threads_soon`).
    pub(crate) threads_pending: bool,
    user_pending: bool,
}

impl ChatState {
    /// Forgets the data but keeps what the UI reported about itself (`dock_open`, `open_channel`).
    pub(crate) fn reset(&mut self) {
        let (dock_open, open_channel) = (self.dock_open, self.open_channel.take());
        *self = ChatState { dock_open, open_channel, ..ChatState::default() };
    }
}

/// The socket handler; it holds the hub weakly because the hub owns the connection.
pub(crate) struct RtBridge(pub(crate) Weak<Inner>);

impl RtBridge {
    fn hub(&self) -> Option<Hub> {
        self.0.upgrade().map(Hub)
    }
}

impl Handler for RtBridge {
    fn link(&self, link: ChatLink) {
        if let Some(hub) = self.hub() {
            hub.0.sink.chat(&ChatEvent::Link { link });
            hub.0.chat_wake.notify_one();
        }
    }

    fn event(&self, name: &str, data: Value) {
        if let Some(hub) = self.hub() {
            hub.on_socket_event(name, &data);
        }
    }

    fn connected(&self, reconnect: bool) {
        let Some(hub) = self.hub() else { return };
        if !reconnect {
            return;
        }
        // Events may have been lost while the socket was down: refresh the lists and the open channel (replays dedupe by id).
        hub.st().chat.catchup = true;
        hub.0.chat_wake.notify_one();
        if hub.provider_running(Id::Meet) {
            tokio::spawn(async move {
                let _ = hub.poll_meet().await;
            });
        }
    }

    fn rejected(&self, err: ApiError) {
        if let Some(hub) = self.hub() {
            hub.socket_refused(&err);
        }
    }
}

impl Hub {
    pub(crate) fn provider_running(&self, id: Id) -> bool {
        self.st().prov[id.idx()].task.is_some()
    }

    /// Opens the socket while a socket provider (chat, meet) is ready, closes it otherwise. Called from `publish`, so it
    /// follows every state change; it is idempotent and does nothing (no task, no socket) while the integrations are off.
    pub(crate) fn reconcile_socket(&self) {
        enum Plan {
            Release,
            Open(Vec<&'static str>, Target),
            NeedUser,
        }
        let plan = {
            let mut st = self.st();
            // Chat and Meet use the socket for their events; the notifications inbox for `notification:new`.
            let owners: Vec<&'static str> = [Id::Meet, Id::Chat, Id::Notifications]
                .into_iter()
                .filter(|id| {
                    let enabled = match id {
                        Id::Chat => st.cfg.chat.enabled,
                        Id::Notifications => st.cfg.notifications.enabled,
                        _ => st.cfg.meet.enabled,
                    };
                    st.cfg.master && enabled && matches!(st.prov[id.idx()].state, ProviderState::Ready | ProviderState::Degraded)
                })
                .map(Id::name)
                .collect();
            match (&st.client, &st.user) {
                _ if owners.is_empty() || st.signed_out.is_some() || st.socket_blocked => Plan::Release,
                (Some(client), Some(user)) => {
                    let (base, token) = client.credentials();
                    Plan::Open(owners, Target { base, token, user_id: user.id.clone(), user_name: user.name.clone() })
                }
                (Some(_), None) if !st.chat.user_pending && st.user_due() => {
                    st.chat.user_pending = true;
                    Plan::NeedUser
                }
                _ => return,
            }
        };
        match plan {
            Plan::Release => self.0.rt.sync(&[], None),
            Plan::Open(owners, target) => self.0.rt.sync(&owners, Some(target)),
            Plan::NeedUser => {
                let hub = self.clone();
                tokio::spawn(async move {
                    hub.refresh_user().await;
                    hub.st().chat.user_pending = false;
                    hub.publish();
                });
            }
        }
    }

    /// The server refused the socket. Credentials: the whole connection signs out (no retry). Anything else: the socket
    /// stays closed until a new token or a manual test, the REST polls carry on.
    pub(crate) fn socket_refused(&self, err: &ApiError) {
        if err.kind == Kind::Unauthorized {
            self.sign_out(last_error(err));
            return;
        }
        {
            let mut st = self.st();
            st.socket_blocked = true;
            for id in [Id::Meet, Id::Chat, Id::Notifications] {
                if st.prov[id.idx()].task.is_some() {
                    st.prov[id.idx()].last_error = Some(last_error(err));
                }
            }
        }
        self.publish();
    }

    /// The realtime connection's state (status, tests).
    pub fn socket_link(&self) -> ChatLink {
        self.0.rt.link()
    }

    pub fn socket_running(&self) -> bool {
        self.0.rt.is_running()
    }

    pub fn socket_attempts(&self) -> u32 {
        self.0.rt.attempts()
    }

    pub(crate) fn emit(&self, event: &ChatEvent) {
        self.0.sink.chat(event);
    }

    /// Sends the summary if it differs from the last one that went out.
    pub(crate) fn emit_summary(&self) {
        let summary = {
            let mut st = self.st();
            let summary = st.chat.cache.summary(self.0.rt.link());
            if st.chat.last_summary.as_ref() == Some(&summary) {
                return;
            }
            st.chat.last_summary = Some(summary.clone());
            summary
        };
        self.emit(&ChatEvent::Summary { summary });
    }

    pub(crate) fn me(&self) -> String {
        self.st().user.as_ref().map(|u| u.id.clone()).unwrap_or_default()
    }

    fn viewing(&self, st: &St, channel: &str) -> bool {
        st.chat.dock_open && st.chat.open_channel.as_deref() == Some(channel) && *self.0.focus.borrow()
    }

    pub(crate) fn on_socket_event(&self, name: &str, data: &Value) {
        match name {
            "chat:message" | "chat:message:updated" if self.provider_running(Id::Chat) => self.on_message(data, name.ends_with("updated")),
            "chat:message:deleted" if self.provider_running(Id::Chat) => self.on_deleted(data),
            "chat:channel:updated" if self.provider_running(Id::Chat) => {
                if let Some(ch) = chat::channel(data.get("channel").unwrap_or(data)) {
                    // An archived channel leaves the list like a removed one.
                    if ch.archived {
                        self.st().chat.cache.remove_channel(&ch.id);
                    } else {
                        self.st().chat.cache.upsert_channel(ch);
                    }
                    self.emit_summary();
                }
            }
            "chat:channel:removed" if self.provider_running(Id::Chat) => {
                if let (Some(id), _) = chat::event_ids(data) {
                    if self.st().chat.cache.remove_channel(&id) {
                        self.emit_summary();
                    }
                }
            }
            // The server sends `chat:read` to ALL members of a small channel: only the user's own reads clear the user's counters.
            "chat:read" if self.provider_running(Id::Chat) => {
                if let (Some(id), Some(reader)) = chat::read_event(data) {
                    if reader == self.me() && self.st().chat.cache.clear_unread(&id) {
                        self.emit_summary();
                    }
                }
            }
            "notification:new" if self.provider_running(Id::Notifications) => self.on_notification_new(data),
            "chat:typing" if self.provider_running(Id::Chat) => self.on_typing(data),
            "chat:meeting" if self.provider_running(Id::Meet) => self.on_meeting(data),
            "chat:meeting:lobby" if self.provider_running(Id::Meet) => self.on_lobby(data),
            "join:forbidden" => self.socket_refused(&ApiError::new(Kind::Forbidden, Some(403), "socketForbidden", "The server did not let this account join its realtime room")),
            _ => {}
        }
    }

    fn on_message(&self, data: &Value, updated: bool) {
        let me = self.me();
        let channel_hint = chat::event_ids(data).0;
        let Some(msg) = chat::message(data.get("message").unwrap_or(data), channel_hint.as_deref(), &me) else { return };
        // A thread reply lives in its thread: it never touches the channel's last message or unread counters (the server keeps
        // thread unread apart too), so it is announced and the thread counters are asked for.
        let thread = msg.thread_root.is_some();
        let (applied, notify, unknown, mark_read) = {
            let mut st = self.st();
            let applied = if updated { st.chat.cache.apply_update(msg.clone()) } else { st.chat.cache.apply_message(msg.clone()) };
            let unknown = !thread && st.chat.cache.channel(&msg.channel_id).is_none();
            let viewing = self.viewing(&st, &msg.channel_id);
            let mut notify = false;
            if applied == Applied::Inserted && !updated {
                // The sender stops "typing" the moment their message arrives.
                st.chat.typing.clear_user(&msg.channel_id, &msg.sender_id);
                if !thread {
                    st.chat.cache.set_last_message(&msg.channel_id, msg.created_at_ms);
                    if !msg.mine && !msg.system && !msg.deleted && !viewing {
                        st.chat.cache.bump_unread(&msg.channel_id, msg.mentions_me);
                    }
                }
                // Looking at the channel does not mean looking at one of its threads: the webview knows if the thread panel is open.
                notify = should_notify(st.chat.cache.channel(&msg.channel_id), &msg, viewing && !thread);
            }
            (applied, notify, unknown, !thread && viewing && !msg.mine && applied == Applied::Inserted)
        };
        if thread && !msg.mine && applied == Applied::Inserted {
            self.refresh_threads_soon();
        }
        if let Some(change) = applied.change() {
            self.emit(&ChatEvent::Message { channel_id: msg.channel_id.clone(), message: msg.clone(), change, notify });
            self.emit_summary();
            self.emit_typing(&msg.channel_id);
        }
        if mark_read {
            // The conversation is on screen: the message is read right away.
            let (hub, channel) = (self.clone(), msg.channel_id.clone());
            tokio::spawn(async move {
                let _ = hub.chat_mark_read(&channel).await;
            });
        }
        if unknown && applied == Applied::Inserted {
            // A channel the list has not seen yet (a new direct message): refresh the list.
            let hub = self.clone();
            tokio::spawn(async move {
                let _ = hub.fetch_bootstrap().await;
            });
        }
    }

    fn on_deleted(&self, data: &Value) {
        let (Some(channel), Some(id)) = chat::event_ids(data) else { return };
        let key = parse::text(data, &["threadRoot"]).map_or_else(|| channel.clone(), |root| crate::cache::thread_key(&root));
        let gone = self.st().chat.cache.apply_deleted(&key, &id);
        if let Some(message) = gone {
            self.emit(&ChatEvent::Message { channel_id: channel, message, change: MessageChange::Deleted, notify: false });
        }
    }

    fn on_typing(&self, data: &Value) {
        let (Some(channel), Some(user)) = (chat::event_ids(data).0, parse::text(data, &["userId", "senderId", "id"])) else { return };
        if user == self.me() {
            return;
        }
        let name = parse::text(data, &["name", "userName", "senderName"]).unwrap_or_else(|| user.clone());
        self.st().chat.typing.note(&channel, &user, &name, now_ms());
        self.emit_typing(&channel);
        let hub = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(TYPING_TTL_MS as u64 + 100)).await;
            let gone = hub.st().chat.typing.expire(now_ms());
            for channel in gone {
                hub.emit_typing(&channel);
            }
        });
    }

    fn emit_typing(&self, channel: &str) {
        let names = self.st().chat.typing.names(channel);
        self.emit(&ChatEvent::Typing { channel_id: channel.to_owned(), names });
    }

    // ---- meetings (feeding the existing Meet item) ----

    fn refetch_meetings(&self) {
        let hub = self.clone();
        tokio::spawn(async move {
            let _ = hub.poll_meet().await;
        });
    }

    /// `chat:meeting`: a meeting started, changed, was scheduled or ended. A payload without an id is not guessed at: the
    /// list is fetched again.
    fn on_meeting(&self, data: &Value) {
        let m = data.get("meeting").unwrap_or(data);
        let action = parse::text(data, &["action", "event", "type"]).or_else(|| parse::text(m, &["status", "state"])).unwrap_or_default().to_ascii_lowercase();
        let Some(id) = parse::text(m, &["id", "_id", "meetingId"]).or_else(|| parse::text(data, &["meetingId"])) else {
            return self.refetch_meetings();
        };
        let ended = ["ended", "end", "stopped", "closed", "finished", "cancel"].iter().any(|k| action.contains(k));
        let status = if action.contains("schedul") { MeetingStatus::Scheduled } else { MeetingStatus::Live };
        let mut view = self.meet_current();
        let old = view.meetings.iter().position(|x| x.id == id).map(|i| view.meetings.remove(i));
        if !ended {
            let source = if m.get("id").is_some() || m.get("_id").is_some() { m.clone() } else { json!({ "id": id }) };
            if let Some(mut next) = parse::meetings(&json!({ "meetings": [source] }), status).into_iter().next() {
                // A bare event ("started" with just an id) keeps what the list already knew.
                if let Some(old) = old {
                    if next.title == "Meeting" {
                        next.title = old.title;
                    }
                    next.channel = next.channel.or(old.channel);
                    next.host = next.host.or(old.host);
                    next.waiting = next.waiting.or(old.waiting);
                    next.start_ms = next.start_ms.or(old.start_ms);
                    if next.participants == 0 {
                        next.participants = old.participants;
                    }
                }
                view.meetings.insert(0, next);
            }
        }
        self.set_meetings(MeetView { meetings: view.meetings, stale: false });
    }

    /// `chat:meeting:lobby`: guests waiting to be let in; the count shows on the Meet item.
    fn on_lobby(&self, data: &Value) {
        let Some(id) = parse::text(data, &["meetingId", "id"]) else { return };
        let count = parse::number(data, &["waiting", "waitingCount", "count", "lobbyCount"]).or_else(|| data.get("guests").and_then(Value::as_array).map(|g| g.len() as i64)).unwrap_or(1).max(0) as u32;
        let mut view = self.meet_current();
        let Some(m) = view.meetings.iter_mut().find(|m| m.id == id) else {
            // A meeting the list does not know yet: fetch it, the count comes with the next event.
            return self.refetch_meetings();
        };
        m.waiting = Some(count).filter(|c| *c > 0);
        self.set_meetings(MeetView { meetings: view.meetings, stale: false });
    }
}
