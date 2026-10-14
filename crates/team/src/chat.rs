//! Chat in a shared run (docs/team.md, "Chat in a run"). Tauri-free and I/O-free.
//!
//! A shared run has one thread. The OWNER of the run is its hub: a member's message goes to the owner, who stamps it with his own
//! clock, keeps it and fans it out, so every member sees one order and one history. A member that connects later asks the owner for the
//! last messages. The thread is human to human: nothing in it is ever given to an agent. This module only holds the message type, the
//! text rules, and the bounded store both sides keep; the owner's side saves the thread to a local file with [`encode_lines`].

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};

/// A chat message is at most this many characters and bytes (a character can take four bytes).
pub const MAX_CHAT_CHARS: usize = 2000;
pub const MAX_CHAT_BYTES: usize = 8000;
/// Messages one member may post per minute (counted by the owner).
pub const CHAT_PER_MIN: usize = 20;
/// What a thread keeps: the oldest messages go first.
pub const THREAD_MAX: usize = 200;
pub const THREAD_BYTES: usize = 256 * 1024;
/// Threads kept in memory; the least recently used one goes (the owner's own are on disk).
pub const THREADS_MAX: usize = 60;
/// What an owner answers a history request with: the newest messages that fit. The byte cap counts the JSON of the messages (a quote
/// or a newline takes two bytes there), and is chosen so that the sealed answer stays well inside one relay frame (64 KiB).
pub const HISTORY_MAX: usize = 50;
pub const HISTORY_BYTES: usize = 24 * 1024;
/// A line of a thread may be dated this far ahead of this machine's clock (clocks differ); further ahead is taken as "now". Without
/// this, one entry with an absurd time would sort after every real message for good.
pub const MAX_FUTURE_MS: u64 = 24 * 3600 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEntry {
    pub msg_id: String,
    /// The member id of the author (the name comes from the signed roster, never from the message).
    pub author: String,
    pub text: String,
    /// Milliseconds on the owner's clock.
    pub at: u64,
}

fn clean_id(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

/// A chat text as it is shown: control characters (except newline and tab) removed, trimmed.
pub fn clean_chat(text: &str) -> String {
    text.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t')).collect::<String>().trim().to_string()
}

/// `text` is already clean, not empty and within the caps.
pub fn text_ok(text: &str) -> bool {
    !text.is_empty() && text.len() <= MAX_CHAT_BYTES && text.chars().count() <= MAX_CHAT_CHARS && clean_chat(text) == text
}

impl ChatEntry {
    pub fn valid(&self) -> bool {
        clean_id(&self.msg_id, 80) && clean_id(&self.author, 64) && text_ok(&self.text)
    }

    /// The entry with a time that is not further in the future than [`MAX_FUTURE_MS`] (`now` in milliseconds, this machine's clock).
    pub fn clamped(mut self, now: u64) -> Self {
        self.at = self.at.min(now.saturating_add(MAX_FUTURE_MS));
        self
    }

    /// Bytes this entry counts for in a thread.
    fn weight(&self) -> usize {
        self.text.len() + self.msg_id.len() + self.author.len() + 32
    }
}

#[derive(Debug, Default)]
struct Thread {
    msgs: VecDeque<ChatEntry>,
    bytes: usize,
}

impl Thread {
    fn trim(&mut self) {
        while self.msgs.len() > THREAD_MAX || self.bytes > THREAD_BYTES {
            match self.msgs.pop_front() {
                Some(e) => self.bytes = self.bytes.saturating_sub(e.weight()),
                None => break,
            }
        }
    }

    fn insert(&mut self, e: ChatEntry) -> bool {
        if self.msgs.iter().any(|x| x.msg_id == e.msg_id) {
            return false;
        }
        // in the order of the owner's clock; a message with the same time goes after the ones already there
        let i = self.msgs.partition_point(|x| x.at <= e.at);
        self.bytes += e.weight();
        self.msgs.insert(i, e);
        self.trim();
        true
    }
}

/// The threads this machine knows, keyed by (owner member id, run id). Bounded in threads, messages and bytes.
#[derive(Debug, Default)]
pub struct ChatStore {
    threads: HashMap<(String, String), Thread>,
    /// Least recently touched first.
    lru: VecDeque<(String, String)>,
}

impl ChatStore {
    fn touch(&mut self, key: &(String, String)) {
        self.lru.retain(|k| k != key);
        self.lru.push_back(key.clone());
        while self.lru.len() > THREADS_MAX {
            if let Some(old) = self.lru.pop_front() {
                self.threads.remove(&old);
            }
        }
    }

    /// Adds one message. `false` for an invalid one or one this thread already has.
    pub fn push(&mut self, owner: &str, run: &str, e: ChatEntry) -> bool {
        if !e.valid() || !clean_id(owner, 64) || !clean_id(run, 80) {
            return false;
        }
        let key = (owner.to_string(), run.to_string());
        let added = self.threads.entry(key.clone()).or_default().insert(e);
        self.touch(&key);
        added
    }

    /// Adds what a history answer carries; the messages that were new, oldest first.
    pub fn merge(&mut self, owner: &str, run: &str, entries: Vec<ChatEntry>) -> Vec<ChatEntry> {
        let mut fresh: Vec<ChatEntry> = entries.into_iter().filter(|e| self.push(owner, run, e.clone())).collect();
        fresh.sort_by_key(|e| e.at);
        fresh
    }

    /// Replaces a thread (the owner's, read back from its file).
    pub fn set(&mut self, owner: &str, run: &str, entries: Vec<ChatEntry>) {
        let key = (owner.to_string(), run.to_string());
        self.threads.remove(&key);
        for e in entries {
            self.push(owner, run, e);
        }
        self.touch(&key);
    }

    pub fn has(&self, owner: &str, run: &str) -> bool {
        self.threads.contains_key(&(owner.to_string(), run.to_string()))
    }

    pub fn list(&self, owner: &str, run: &str) -> Vec<ChatEntry> {
        self.threads.get(&(owner.to_string(), run.to_string())).map(|t| t.msgs.iter().cloned().collect()).unwrap_or_default()
    }

    /// The newest messages that fit one answer ([`HISTORY_MAX`] messages, [`HISTORY_BYTES`] of JSON), oldest first.
    pub fn history(&self, owner: &str, run: &str) -> Vec<ChatEntry> {
        let Some(t) = self.threads.get(&(owner.to_string(), run.to_string())) else { return Vec::new() };
        let mut out: Vec<ChatEntry> = Vec::new();
        let mut bytes = 0usize;
        for e in t.msgs.iter().rev() {
            // + 1: the comma between two messages
            let json = serde_json::to_string(e).map_or_else(|_| e.weight() * 2, |s| s.len()) + 1;
            if out.len() >= HISTORY_MAX || bytes + json > HISTORY_BYTES {
                break;
            }
            bytes += json;
            out.push(e.clone());
        }
        out.reverse();
        out
    }

    /// A member left the team: the threads of its runs go.
    pub fn drop_owner(&mut self, owner: &str) {
        self.threads.retain(|(o, _), _| o != owner);
        self.lru.retain(|(o, _)| o != owner);
    }

    pub fn clear(&mut self) {
        self.threads.clear();
        self.lru.clear();
    }

    pub fn len(&self) -> usize {
        self.threads.len()
    }

    pub fn is_empty(&self) -> bool {
        self.threads.is_empty()
    }
}

/// One JSON object per line, oldest first (the owner's thread file).
pub fn encode_lines(entries: &[ChatEntry]) -> String {
    let mut s = String::new();
    for e in entries {
        if let Ok(line) = serde_json::to_string(e) {
            s.push_str(&line);
            s.push('\n');
        }
    }
    s
}

/// The valid entries of a thread file in the order of their times, without doubles, the newest ones that fit a thread
/// ([`THREAD_MAX`] messages, [`THREAD_BYTES`]); a damaged line is skipped.
pub fn decode_lines(text: &str) -> Vec<ChatEntry> {
    let mut t = Thread::default();
    for e in text.lines().filter_map(|l| serde_json::from_str::<ChatEntry>(l).ok()).filter(ChatEntry::valid) {
        t.insert(e);
    }
    t.msgs.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(id: &str, at: u64, text: &str) -> ChatEntry {
        ChatEntry { msg_id: id.into(), author: "mia".into(), text: text.into(), at }
    }

    #[test]
    fn text_is_cleaned_and_limited() {
        assert_eq!(clean_chat("  hi\u{7}\u{0}\nthere\t "), "hi\nthere");
        assert!(text_ok("hello"));
        assert!(!text_ok(""));
        assert!(!text_ok("  padded "), "must already be clean");
        assert!(!text_ok("bell\u{7}"));
        assert!(text_ok(&"x".repeat(MAX_CHAT_CHARS)));
        assert!(!text_ok(&"x".repeat(MAX_CHAT_CHARS + 1)));
        // four-byte characters: the character cap applies before the byte cap is reached
        assert!(text_ok(&"😀".repeat(MAX_CHAT_CHARS)));
        assert!(!text_ok(&"😀".repeat(MAX_CHAT_CHARS + 1)));
    }

    #[test]
    fn entries_need_clean_ids() {
        assert!(e("m1", 1, "ok").valid());
        assert!(!ChatEntry { msg_id: "m 1".into(), ..e("m1", 1, "ok") }.valid());
        assert!(!ChatEntry { author: "mia/../x".into(), ..e("m1", 1, "ok") }.valid());
        assert!(!ChatEntry { msg_id: "x".repeat(81), ..e("m1", 1, "ok") }.valid());
    }

    #[test]
    fn a_thread_is_ordered_by_the_owners_clock_and_has_no_duplicates() {
        let mut s = ChatStore::default();
        assert!(s.push("o", "r", e("a", 20, "second")));
        assert!(s.push("o", "r", e("b", 10, "first")));
        assert!(s.push("o", "r", e("c", 20, "third, same time as the second")));
        assert!(!s.push("o", "r", e("a", 99, "replay of a")));
        let ids: Vec<_> = s.list("o", "r").into_iter().map(|x| x.msg_id).collect();
        assert_eq!(ids, ["b", "a", "c"]);
        assert!(!s.push("o", "r", e("bad id", 1, "x")), "invalid is refused");
        assert!(!s.push("../o", "r", e("z", 1, "x")), "the key is checked too");
    }

    #[test]
    fn a_thread_is_bounded() {
        let mut s = ChatStore::default();
        for i in 0..(THREAD_MAX + 50) {
            s.push("o", "r", e(&format!("m{i}"), i as u64, "x"));
        }
        let l = s.list("o", "r");
        assert_eq!(l.len(), THREAD_MAX);
        assert_eq!(l[0].msg_id, "m50", "the oldest went first");
        // by bytes: a few large messages push the oldest out
        let mut s = ChatStore::default();
        let big = "y".repeat(MAX_CHAT_CHARS);
        for i in 0..200 {
            s.push("o", "r", e(&format!("b{i}"), i as u64, &big));
        }
        assert!(s.list("o", "r").len() * (MAX_CHAT_CHARS + 40) <= THREAD_BYTES + MAX_CHAT_CHARS + 40);
    }

    #[test]
    fn the_store_keeps_a_bounded_number_of_threads() {
        let mut s = ChatStore::default();
        for i in 0..(THREADS_MAX + 5) {
            s.push("o", &format!("r{i}"), e("m", 1, "x"));
        }
        assert_eq!(s.len(), THREADS_MAX);
        assert!(!s.has("o", "r0"), "the least recently used thread went");
        assert!(s.has("o", &format!("r{}", THREADS_MAX + 4)));
        // touching a thread keeps it
        s.push("o", "r10", e("m2", 2, "again"));
        for i in 0..THREADS_MAX {
            s.push("p", &format!("q{i}"), e("m", 1, "x"));
        }
        assert!(!s.has("o", "r10"), "after enough newer threads even that one goes");
    }

    #[test]
    fn history_is_the_newest_that_fit_oldest_first() {
        let mut s = ChatStore::default();
        for i in 0..(HISTORY_MAX + 10) {
            s.push("o", "r", e(&format!("m{i}"), i as u64, "hello"));
        }
        let h = s.history("o", "r");
        assert_eq!(h.len(), HISTORY_MAX);
        assert_eq!(h.first().unwrap().msg_id, "m10");
        assert_eq!(h.last().unwrap().msg_id, format!("m{}", HISTORY_MAX + 9));
        // by bytes
        let mut s = ChatStore::default();
        let t = "z".repeat(1900);
        for i in 0..30 {
            s.push("o", "r", e(&format!("m{i}"), i as u64, &t));
        }
        let h = s.history("o", "r");
        assert!(serde_json::to_string(&h).unwrap().len() <= HISTORY_BYTES);
        assert_eq!(h.last().unwrap().msg_id, "m29");
        assert!(h.len() < 30, "not everything fits");
        // text that escapes (quotes, newlines) counts twice, so fewer messages fit than the plain size would suggest
        let mut s = ChatStore::default();
        let q = "\"".repeat(1900);
        for i in 0..30 {
            s.push("o", "r", e(&format!("m{i}"), i as u64, &q));
        }
        let quoted = s.history("o", "r");
        assert!(serde_json::to_string(&quoted).unwrap().len() <= HISTORY_BYTES);
        assert!(quoted.len() < h.len());
        assert!(s.history("o", "nothing").is_empty());
    }

    #[test]
    fn merging_a_history_returns_only_what_is_new() {
        let mut s = ChatStore::default();
        s.push("o", "r", e("a", 1, "one"));
        let fresh = s.merge("o", "r", vec![e("b", 3, "three"), e("a", 1, "one"), e("c", 2, "two"), e("bad id", 4, "x")]);
        assert_eq!(fresh.iter().map(|x| x.msg_id.as_str()).collect::<Vec<_>>(), ["c", "b"]);
        assert_eq!(s.list("o", "r").len(), 3);
    }

    #[test]
    fn a_member_that_left_takes_its_threads_along() {
        let mut s = ChatStore::default();
        s.push("a", "r1", e("m", 1, "x"));
        s.push("b", "r2", e("m", 1, "x"));
        s.drop_owner("a");
        assert!(!s.has("a", "r1") && s.has("b", "r2"));
        s.clear();
        assert!(s.is_empty());
    }

    #[test]
    fn the_file_format_roundtrips_and_skips_damage() {
        let v = vec![e("a", 1, "one"), e("b", 2, "line one\nline two")];
        let text = encode_lines(&v);
        assert_eq!(text.lines().count(), 2, "a newline inside a message is escaped");
        assert_eq!(decode_lines(&text), v);
        let damaged = format!("not json\n{}{{\"msgId\":\"x y\",\"author\":\"a\",\"text\":\"bad id\",\"at\":1}}\n", text);
        assert_eq!(decode_lines(&damaged), v, "a damaged or invalid line is skipped");
        let many: String = (0..THREAD_MAX + 20).map(|i| encode_lines(&[e(&format!("m{i}"), i as u64, "x")])).collect();
        let back = decode_lines(&many);
        assert_eq!(back.len(), THREAD_MAX);
        assert_eq!(back[0].msg_id, "m20");
    }

    #[test]
    fn set_replaces_a_thread() {
        let mut s = ChatStore::default();
        s.push("o", "r", e("old", 1, "x"));
        s.set("o", "r", vec![e("n1", 5, "a"), e("n2", 6, "b")]);
        assert_eq!(s.list("o", "r").iter().map(|x| x.msg_id.as_str()).collect::<Vec<_>>(), ["n1", "n2"]);
    }

    #[test]
    fn a_time_far_in_the_future_is_taken_as_now_plus_a_day() {
        let now = 1_700_000_000_000;
        assert_eq!(e("m", now, "x").clamped(now).at, now);
        assert_eq!(e("m", now + MAX_FUTURE_MS, "x").clamped(now).at, now + MAX_FUTURE_MS);
        assert_eq!(e("m", u64::MAX, "x").clamped(now).at, now + MAX_FUTURE_MS);
        assert_eq!(e("m", 5, "x").clamped(u64::MAX).at, 5);
        // such an entry no longer keeps real messages from coming after it for more than a day
        let mut s = ChatStore::default();
        s.push("o", "r", e("late", u64::MAX, "from an owner with a broken clock").clamped(now));
        s.push("o", "r", e("real", now + MAX_FUTURE_MS + 1, "a message of tomorrow").clamped(now));
        assert_eq!(s.list("o", "r").len(), 2);
    }

    #[test]
    fn a_thread_file_is_read_back_bounded_ordered_and_without_doubles() {
        let big = "x".repeat(1900);
        let entries: Vec<ChatEntry> = (0..300).map(|i| e(&format!("m{i}"), i as u64, &big)).collect();
        let text = encode_lines(&entries);
        assert!(text.len() > THREAD_BYTES, "the file is bigger than a thread may be");
        let back = decode_lines(&text);
        assert!(back.len() < 200, "the byte cap applies, not only the count: {}", back.len());
        assert!(back.iter().map(|x| x.text.len() + x.msg_id.len() + x.author.len() + 32).sum::<usize>() <= THREAD_BYTES);
        assert_eq!(back.last().unwrap().msg_id, "m299", "the newest are kept");
        // out of order, a double and a damaged line
        let messy = format!("{}\nnot json\n{}\n{}\n", serde_json::to_string(&e("b", 2, "two")).unwrap(), serde_json::to_string(&e("a", 1, "one")).unwrap(), serde_json::to_string(&e("b", 9, "again")).unwrap());
        let back = decode_lines(&messy);
        assert_eq!(back.iter().map(|x| x.msg_id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(back[1].text, "two", "the first copy of an id wins");
    }
}
