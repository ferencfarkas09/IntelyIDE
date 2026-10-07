//! The Rust-side chat cache: per-channel messages (<= 200, 50 channels), replay/dedupe by message id, optimistic sends
//! reconciled by `clientMessageId`, unread counters, and the typing tracker. Pure data, no I/O.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::chat::{Bootstrap, MAX_CHANNELS, MAX_MESSAGES, SEND_COST};
use crate::types::{ChatChannel, ChatLink, ChatMessage, ChatSummary, MessageChange, MessagePage, SendState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    /// A message we had not seen: counters move and an event goes out.
    Inserted,
    /// The server's copy of an optimistic message (same `clientMessageId`).
    Replaced,
    Updated,
    /// Already known (a replay after a reconnect, or the socket echo of a REST page): nothing to do.
    Duplicate,
}

impl Applied {
    pub fn change(self) -> Option<MessageChange> {
        match self {
            Applied::Inserted => Some(MessageChange::New),
            Applied::Replaced => Some(MessageChange::Replaced),
            Applied::Updated => Some(MessageChange::Updated),
            Applied::Duplicate => None,
        }
    }
}

#[derive(Default)]
pub struct ChatCache {
    pub channels: Vec<ChatChannel>,
    messages: HashMap<String, Vec<ChatMessage>>,
    has_more: HashMap<String, bool>,
    /// Least recently used channel ids with cached messages, oldest first.
    lru: VecDeque<String>,
    /// Ids that were deleted, so a replayed `chat:message` cannot bring them back.
    tombstones: HashSet<String>,
    pub credits: Option<f64>,
    pub credits_empty: bool,
    pub loaded: bool,
    pub stale: bool,
    /// The store the bootstrap answered for (sent back on directory/direct/search/threads/create).
    pub restaurant_id: Option<String>,
    pub can_create_channel: bool,
    pub can_manage_channels: bool,
    /// Thread root id -> replies the user has not seen (server-driven).
    unread_threads: HashMap<String, u32>,
}

/// Where a thread's replies are cached: next to the channels, under a key a channel id can never have.
pub fn thread_key(root: &str) -> String {
    format!("t:{root}")
}

/// The cache key of a message: its channel, or its thread (replies never mix into the channel's list).
fn key_of(m: &ChatMessage) -> String {
    m.thread_root.as_deref().map_or_else(|| m.channel_id.clone(), thread_key)
}

fn order(m: &ChatMessage) -> (i64, &str) {
    (m.created_at_ms, m.id.as_str())
}

impl ChatCache {
    pub fn clear(&mut self) {
        *self = ChatCache::default();
    }

    pub fn channel(&self, id: &str) -> Option<&ChatChannel> {
        self.channels.iter().find(|c| c.id == id)
    }

    fn channel_mut(&mut self, id: &str) -> Option<&mut ChatChannel> {
        self.channels.iter_mut().find(|c| c.id == id)
    }

    pub fn summary(&self, link: ChatLink) -> ChatSummary {
        ChatSummary {
            unread_total: self.channels.iter().filter(|c| !c.muted).map(|c| c.unread_count).sum(),
            mention_total: self.channels.iter().map(|c| c.mention_count).sum(),
            thread_unread: self.unread_threads.len() as u32,
            can_create_channel: self.can_create_channel,
            can_manage_channels: self.can_manage_channels,
            channels: self.channels.clone(),
            credits: self.credits,
            send_cost: SEND_COST,
            credits_empty: self.credits_empty,
            link,
            stale: self.stale,
            loaded: self.loaded,
        }
    }

    pub fn set_bootstrap(&mut self, b: Bootstrap) {
        self.channels = b.channels;
        self.credits = b.credits;
        self.restaurant_id = b.restaurant_id.or(self.restaurant_id.take());
        self.can_create_channel = b.can_create_channel;
        self.can_manage_channels = b.can_manage_channels;
        self.credits_empty = b.credits.is_some_and(|c| c <= 0.0);
        self.loaded = true;
        self.stale = false;
        let known: HashSet<&str> = self.channels.iter().map(|c| c.id.as_str()).collect();
        // Thread keys (`t:<root>`) are not channels: they stay.
        self.messages.retain(|id, _| known.contains(id.as_str()) || id.starts_with("t:"));
        self.has_more.retain(|id, _| known.contains(id.as_str()));
        self.lru.retain(|id| known.contains(id.as_str()) || id.starts_with("t:"));
    }

    fn touch(&mut self, channel: &str) {
        self.lru.retain(|c| c != channel);
        self.lru.push_back(channel.to_owned());
        while self.lru.len() > MAX_CHANNELS {
            if let Some(old) = self.lru.pop_front() {
                self.messages.remove(&old);
                self.has_more.remove(&old);
            }
        }
    }

    pub fn messages(&self, channel: &str) -> &[ChatMessage] {
        self.messages.get(channel).map_or(&[], Vec::as_slice)
    }

    pub fn has_more(&self, channel: &str) -> bool {
        self.has_more.get(channel).copied().unwrap_or(false)
    }

    /// A page from REST, merged with the dedupe rules so socket messages that arrived meanwhile are not duplicated. The
    /// older-history flag is taken from the first page and from every "older" page, not from refreshes of the newest one.
    /// Returns what was new or changed, in order.
    pub fn merge_page(&mut self, page: &MessagePage, older: bool) -> Vec<(ChatMessage, Applied)> {
        // A newest page that does not reach the cached tail (more than a page arrived while disconnected) would leave a gap
        // that cannot be paged: the page replaces the cache then (unsent messages stay).
        let gap = !older
            && page.has_more
            && match (self.messages.get(&page.channel_id).and_then(|l| l.iter().map(|m| order(m)).max()), page.messages.iter().map(order).min()) {
                (Some(cached_newest), Some(page_oldest)) => page_oldest > cached_newest,
                _ => false,
            };
        if gap {
            if let Some(list) = self.messages.get_mut(&page.channel_id) {
                list.retain(|m| m.send_state != SendState::Sent);
            }
            self.has_more.remove(&page.channel_id);
        }
        let changed = page
            .messages
            .iter()
            .filter_map(|m| match self.insert(m.clone()) {
                Applied::Duplicate => None,
                applied => Some((m.clone(), applied)),
            })
            .collect();
        if older || !self.has_more.contains_key(&page.channel_id) {
            self.has_more.insert(page.channel_id.clone(), page.has_more);
        }
        self.touch(&page.channel_id);
        changed
    }

    /// The oldest message the cache holds for a channel (the cursor of the next "older" page).
    pub fn oldest_id(&self, channel: &str) -> Option<&str> {
        self.messages.get(channel).and_then(|l| l.first()).map(|m| m.id.as_str())
    }

    fn insert(&mut self, m: ChatMessage) -> Applied {
        if self.tombstones.contains(&m.id) {
            return Applied::Duplicate;
        }
        if m.deleted {
            self.tombstones.insert(m.id.clone());
        }
        let list = self.messages.entry(key_of(&m)).or_default();
        let mut by_id = list.iter().position(|x| x.id == m.id);
        let mut by_client = m.client_message_id.as_ref().and_then(|cid| list.iter().position(|x| x.send_state != SendState::Sent && x.client_message_id.as_ref() == Some(cid)));
        // The server's copy is already there and a pending row for the same send is too (a retry of a send that had arrived):
        // the pending row goes.
        let mut dropped_pending = false;
        if let (Some(i), Some(c)) = (by_id, by_client) {
            list.remove(c);
            by_id = Some(if c < i { i - 1 } else { i });
            by_client = None;
            dropped_pending = true;
        }
        let applied = match (by_id, by_client) {
            (Some(i), _) if list[i] == m => if dropped_pending { Applied::Replaced } else { Applied::Duplicate },
            (Some(i), _) => {
                list[i] = m;
                if dropped_pending { Applied::Replaced } else { Applied::Updated }
            }
            (None, Some(i)) => {
                list[i] = m;
                Applied::Replaced
            }
            (None, None) => {
                list.push(m);
                Applied::Inserted
            }
        };
        if applied != Applied::Duplicate {
            list.sort_by(|a, b| order(a).cmp(&order(b)));
            if list.len() > MAX_MESSAGES {
                let drop = list.len() - MAX_MESSAGES;
                list.drain(..drop);
            }
        }
        applied
    }

    /// A message from the socket (or `chat:message:updated`). Counters are not touched here.
    pub fn apply_message(&mut self, m: ChatMessage) -> Applied {
        let channel = key_of(&m);
        let applied = self.insert(m);
        self.touch(&channel);
        applied
    }

    /// `chat:message:updated` (an edit, a reaction, a new reply count on a root): applied to a message the cache holds; one it
    /// does not hold is not inserted (it would appear out of place), but the update is still announced so a window that
    /// has it can refresh it.
    pub fn apply_update(&mut self, m: ChatMessage) -> Applied {
        let known = self.messages.get(&key_of(&m)).is_some_and(|list| list.iter().any(|x| x.id == m.id));
        if known {
            self.apply_message(m)
        } else {
            Applied::Updated
        }
    }

    pub fn apply_deleted(&mut self, channel: &str, id: &str) -> Option<ChatMessage> {
        self.tombstones.insert(id.to_owned());
        let m = self.messages.get_mut(channel)?.iter_mut().find(|m| m.id == id)?;
        if m.deleted {
            return None;
        }
        m.deleted = true;
        m.text.clear();
        Some(m.clone())
    }

    /// Adds an optimistic message (or refreshes the failed one a retry resends) and returns it.
    pub fn add_pending(&mut self, m: ChatMessage) -> ChatMessage {
        let channel = key_of(&m);
        let list = self.messages.entry(channel.clone()).or_default();
        match list.iter().position(|x| x.client_message_id == m.client_message_id && x.send_state != SendState::Sent) {
            Some(i) => list[i] = m.clone(),
            None => list.push(m.clone()),
        }
        list.sort_by(|a, b| order(a).cmp(&order(b)));
        self.touch(&channel);
        m
    }

    pub fn fail_pending(&mut self, channel: &str, client_id: &str, code: &str) -> Option<ChatMessage> {
        let m = self.messages.get_mut(channel)?.iter_mut().find(|m| m.client_message_id.as_deref() == Some(client_id) && m.send_state != SendState::Sent)?;
        m.send_state = SendState::Failed;
        m.error_code = Some(code.to_owned());
        Some(m.clone())
    }

    /// The pending or failed message for a client id (a retry resends its text).
    pub fn unsent(&self, channel: &str, client_id: &str) -> Option<&ChatMessage> {
        self.messages(channel).iter().find(|m| m.client_message_id.as_deref() == Some(client_id) && m.send_state != SendState::Sent)
    }

    /// Counters for a message that arrived from someone else.
    pub fn bump_unread(&mut self, channel: &str, mention: bool) {
        if let Some(c) = self.channel_mut(channel) {
            c.unread_count = c.unread_count.saturating_add(1);
            if mention {
                c.mention_count = c.mention_count.saturating_add(1);
            }
        }
    }

    pub fn set_last_message(&mut self, channel: &str, at_ms: i64) {
        if let Some(c) = self.channel_mut(channel) {
            c.last_message_at_ms = Some(c.last_message_at_ms.map_or(at_ms, |old| old.max(at_ms)));
        }
    }

    /// The replies of a thread, oldest first.
    pub fn thread_messages(&self, root: &str) -> &[ChatMessage] {
        self.messages(&thread_key(root))
    }

    /// Replies from `GET .../thread`, merged with the dedupe rules (a pending reply of the user is replaced, not doubled).
    pub fn merge_thread(&mut self, root: &str, replies: &[ChatMessage]) {
        for m in replies {
            self.insert(m.clone());
        }
        self.touch(&thread_key(root));
    }

    /// The server's list of threads with unread replies replaces what was known.
    pub fn set_unread_threads(&mut self, unread: HashMap<String, u32>) {
        self.unread_threads = unread;
    }

    /// The thread was opened (the server marks it read). Returns whether the aggregate changed.
    pub fn clear_thread_unread(&mut self, root: &str) -> bool {
        self.unread_threads.remove(root).is_some()
    }

    /// `chat:read` (this user read the channel on another device) or our own mark-read. Returns whether anything changed.
    pub fn clear_unread(&mut self, channel: &str) -> bool {
        match self.channel_mut(channel) {
            Some(c) if c.unread_count > 0 || c.mention_count > 0 => {
                (c.unread_count, c.mention_count) = (0, 0);
                true
            }
            _ => false,
        }
    }

    pub fn upsert_channel(&mut self, ch: ChatChannel) {
        match self.channel_mut(&ch.id) {
            Some(slot) => *slot = ch,
            None => self.channels.push(ch),
        }
    }

    pub fn remove_channel(&mut self, id: &str) -> bool {
        let before = self.channels.len();
        self.channels.retain(|c| c.id != id);
        self.messages.remove(id);
        self.has_more.remove(id);
        self.lru.retain(|c| c != id);
        before != self.channels.len()
    }
}

pub const TYPING_TTL_MS: i64 = 5000;

/// Who is typing where; entries expire after 5 s.
#[derive(Default)]
pub struct Typing {
    entries: HashMap<(String, String), (String, i64)>,
}

impl Typing {
    pub fn note(&mut self, channel: &str, user: &str, name: &str, now: i64) {
        self.entries.insert((channel.to_owned(), user.to_owned()), (name.to_owned(), now + TYPING_TTL_MS));
    }

    pub fn clear_user(&mut self, channel: &str, user: &str) {
        self.entries.remove(&(channel.to_owned(), user.to_owned()));
    }

    /// Drops expired entries and returns the channels whose list changed.
    pub fn expire(&mut self, now: i64) -> Vec<String> {
        let gone: Vec<(String, String)> = self.entries.iter().filter(|(_, (_, until))| *until <= now).map(|(k, _)| k.clone()).collect();
        for k in &gone {
            self.entries.remove(k);
        }
        let mut channels: Vec<String> = gone.into_iter().map(|(c, _)| c).collect();
        channels.sort();
        channels.dedup();
        channels
    }

    pub fn names(&self, channel: &str) -> Vec<String> {
        let mut names: Vec<String> = self.entries.iter().filter(|((c, _), _)| c == channel).map(|(_, (n, _))| n.clone()).collect();
        names.sort();
        names
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::chat::bootstrap;
    use crate::chat::tests::msg;

    fn reply(id: &str, ch: &str, root: &str, at: i64) -> ChatMessage {
        ChatMessage { thread_root: Some(root.into()), ..msg(id, ch, at) }
    }

    fn page(ch: &str, messages: Vec<ChatMessage>) -> MessagePage {
        MessagePage { channel_id: ch.into(), messages, has_more: false, cursor: None, has_newer: false, anchor_id: None }
    }

    fn pending(id: &str, ch: &str, client: &str, at: i64) -> ChatMessage {
        ChatMessage { sender_id: "u_1".into(), mine: true, client_message_id: Some(client.into()), send_state: SendState::Pending, ..msg(id, ch, at) }
    }

    #[test]
    fn counters_bump_clear_and_ignore_muted_channels_in_the_total() {
        let mut cache = ChatCache::default();
        cache.set_bootstrap(bootstrap(&json!({ "channels": [{ "_id": "c1", "name": "a" }, { "_id": "c2", "name": "b", "me": { "unreadCount": 2 } }, { "_id": "c3", "name": "m", "me": { "unreadCount": 9, "mutedUntil": "2999-01-01T00:00:00Z" } }], "unreadTotal": 99 })));
        assert_eq!(cache.summary(ChatLink::Off).unread_total, 2, "the server's unreadTotal is not trusted and muted channels do not count");
        cache.bump_unread("c1", false);
        cache.bump_unread("c1", true);
        cache.bump_unread("nope", true);
        let s = cache.summary(ChatLink::Live);
        assert_eq!((s.unread_total, s.mention_total), (4, 1));
        assert!(cache.clear_unread("c1") && !cache.clear_unread("c1"));
        assert_eq!(cache.summary(ChatLink::Live).unread_total, 2);
        assert!(cache.remove_channel("c2") && !cache.remove_channel("c2"));
    }

    #[test]
    fn replays_and_echoes_are_deduplicated_by_id_and_client_id() {
        let mut cache = ChatCache::default();
        assert_eq!(cache.apply_message(msg("m1", "c1", 10)), Applied::Inserted);
        assert_eq!(cache.apply_message(msg("m1", "c1", 10)), Applied::Duplicate, "the same event replayed after a reconnect");
        cache.merge_page(&page("c1", vec![msg("m1", "c1", 10), msg("m0", "c1", 5)]), false);
        assert_eq!(cache.messages("c1").iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m0", "m1"], "a REST page merges without duplicates");
        cache.add_pending(pending("local-1", "c1", "cm-1", 20));
        let echo = ChatMessage { sender_id: "u_1".into(), mine: true, client_message_id: Some("cm-1".into()), ..msg("m9", "c1", 21) };
        assert_eq!(cache.apply_message(echo.clone()), Applied::Replaced);
        assert_eq!(cache.apply_message(echo), Applied::Duplicate);
        assert_eq!(cache.messages("c1").iter().filter(|m| m.client_message_id.as_deref() == Some("cm-1")).count(), 1);
        assert!(cache.messages("c1").iter().all(|m| m.send_state == SendState::Sent));
    }

    #[test]
    fn edits_update_and_deletes_leave_a_tombstone_that_a_replay_cannot_undo() {
        let mut cache = ChatCache::default();
        cache.apply_message(msg("m1", "c1", 10));
        let edited = ChatMessage { text: "changed".into(), edited: true, ..msg("m1", "c1", 10) };
        assert_eq!(cache.apply_message(edited), Applied::Updated);
        assert!(cache.apply_deleted("c1", "m1").is_some_and(|m| m.deleted && m.text.is_empty()));
        assert!(cache.apply_deleted("c1", "m1").is_none(), "already deleted");
        assert_eq!(cache.apply_message(msg("m1", "c1", 10)), Applied::Duplicate, "a replayed message does not come back");
        assert!(cache.messages("c1")[0].deleted);
    }

    #[test]
    fn the_cache_is_bounded_per_channel_and_in_channel_count() {
        let mut cache = ChatCache::default();
        for i in 0..(MAX_MESSAGES as i64 + 30) {
            cache.apply_message(msg(&format!("m{i:04}"), "c1", i));
        }
        assert_eq!(cache.messages("c1").len(), MAX_MESSAGES);
        assert_eq!(cache.messages("c1")[0].id, "m0030", "the oldest are dropped");
        for i in 0..(MAX_CHANNELS + 5) {
            cache.apply_message(msg("m", &format!("ch{i}"), 1));
        }
        assert!(cache.messages("c1").is_empty(), "the least recently used channel was evicted");
        assert_eq!(cache.messages(&format!("ch{}", MAX_CHANNELS + 4)).len(), 1);
    }

    #[test]
    fn a_failed_send_keeps_its_text_for_a_retry_and_the_echo_still_replaces_it() {
        let mut cache = ChatCache::default();
        cache.add_pending(pending("local-2", "c1", "cm-2", 20));
        let failed = cache.fail_pending("c1", "cm-2", "INSUFFICIENT_CREDITS").unwrap();
        assert_eq!((failed.send_state, failed.error_code.as_deref()), (SendState::Failed, Some("INSUFFICIENT_CREDITS")));
        assert_eq!(cache.unsent("c1", "cm-2").map(|m| m.text.as_str()), Some("text local-2"));
        cache.add_pending(pending("local-2", "c1", "cm-2", 20));
        assert_eq!(cache.messages("c1").len(), 1, "a retry reuses the same row");
        let echo = ChatMessage { client_message_id: Some("cm-2".into()), ..msg("m5", "c1", 22) };
        assert_eq!(cache.apply_message(echo), Applied::Replaced);
        assert!(cache.unsent("c1", "cm-2").is_none());
    }

    #[test]
    fn thread_replies_are_cached_apart_from_the_channel_and_dedupe_like_messages() {
        let mut cache = ChatCache::default();
        assert_eq!(cache.apply_message(msg("m1", "c1", 10)), Applied::Inserted);
        assert_eq!(cache.apply_message(reply("r1", "c1", "m1", 11)), Applied::Inserted);
        assert_eq!(cache.apply_message(reply("r1", "c1", "m1", 11)), Applied::Duplicate);
        assert_eq!(cache.messages("c1").iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m1"], "a reply never shows inline");
        assert_eq!(cache.thread_messages("m1").iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["r1"]);
        // A pending reply is replaced by the server's copy, in the thread.
        cache.add_pending(ChatMessage { thread_root: Some("m1".into()), ..pending("local-3", "c1", "cm-3", 30) });
        let echo = ChatMessage { sender_id: "u_1".into(), mine: true, client_message_id: Some("cm-3".into()), ..reply("r2", "c1", "m1", 31) };
        assert_eq!(cache.apply_message(echo), Applied::Replaced);
        assert_eq!(cache.thread_messages("m1").len(), 2);
        assert!(cache.apply_deleted(&thread_key("m1"), "r1").is_some());
        // A bootstrap keeps thread entries and drops channels that are gone.
        cache.set_bootstrap(bootstrap(&json!({ "channels": [{ "_id": "c1", "name": "a" }] })));
        assert_eq!(cache.thread_messages("m1").len(), 2);
    }

    #[test]
    fn the_thread_unread_aggregate_is_server_driven_and_clears_when_opened() {
        let mut cache = ChatCache::default();
        cache.set_unread_threads([("m1".to_owned(), 2), ("m7".to_owned(), 1)].into_iter().collect());
        assert_eq!(cache.summary(ChatLink::Live).thread_unread, 2);
        assert!(cache.clear_thread_unread("m1") && !cache.clear_thread_unread("m1"));
        assert_eq!(cache.summary(ChatLink::Live).thread_unread, 1);
    }

    #[test]
    fn a_newest_page_that_misses_the_cached_tail_replaces_the_cache() {
        let mut cache = ChatCache::default();
        cache.merge_page(&page("c1", vec![msg("m1", "c1", 10), msg("m2", "c1", 20)]), false);
        // Connected page: overlaps the cache, merged.
        cache.merge_page(&MessagePage { has_more: true, ..page("c1", vec![msg("m2", "c1", 20), msg("m3", "c1", 30)]) }, false);
        assert_eq!(cache.messages("c1").len(), 3);
        // A page entirely newer than the cache with more history behind it: the gap cannot be paged, so the cache is replaced.
        cache.merge_page(&MessagePage { has_more: true, ..page("c1", vec![msg("m8", "c1", 80), msg("m9", "c1", 90)]) }, false);
        assert_eq!(cache.messages("c1").iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m8", "m9"]);
        assert!(cache.has_more("c1"));
        // Without `has_more` the page reaches the beginning: nothing to replace.
        cache.merge_page(&page("c1", vec![msg("m10", "c1", 100)]), false);
        assert_eq!(cache.messages("c1").len(), 3);
    }

    #[test]
    fn an_update_of_an_uncached_message_is_not_inserted() {
        let mut cache = ChatCache::default();
        cache.apply_message(msg("m1", "c1", 10));
        assert_eq!(cache.apply_update(msg("m7", "c1", 70)), Applied::Updated);
        assert_eq!(cache.messages("c1").len(), 1);
        assert_eq!(cache.oldest_id("c1"), Some("m1"));
    }

    #[test]
    fn typing_entries_expire() {
        let mut t = Typing::default();
        t.note("c1", "u_2", "Anna", 1000);
        t.note("c1", "u_3", "Béla", 3000);
        assert_eq!(t.names("c1"), ["Anna", "Béla"]);
        assert!(t.expire(5999).is_empty());
        assert_eq!(t.expire(6000), ["c1"]);
        assert_eq!(t.names("c1"), ["Béla"]);
        t.clear_user("c1", "u_3");
        assert!(t.names("c1").is_empty());
    }
}
