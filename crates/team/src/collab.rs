//! Team, phases T3, T4 and T6 (docs/team.md): a note or a follow-up into a teammate's run, a snapshot of a teammate's workspace (with
//! the branch's commits), and chat in a shared run. Tauri-free and I/O-free.
//!
//! These are the ONLY things a teammate can ask of another machine, and every one is decided on the owner's side: a note waits for the
//! owner's accept (or a per-member opt-in), a follow-up ALWAYS waits for the owner's accept, a snapshot is built only for a project the
//! owner switched on, and chat only lands in the thread of a run the owner shares (it is never handed to an agent). Anything else a
//! `direct` envelope carries (a permission answer, a start, a stop, a question answer, a prompt) does not parse here: [`CollabMsg::parse`]
//! returns `None` for every `t` that is not listed below, and the caller drops it. There is no variant to add them to by accident.

use std::collections::{HashMap, HashSet, VecDeque};

use intely_remote::util::{b64u, b64u_decode, sha256_hex};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::chat::{clean_chat, text_ok, ChatEntry, HISTORY_MAX, MAX_CHAT_BYTES};
use crate::redact::{is_secret_file, mask_emails, scrub};
use crate::share::MAX_MSG;

/// A note is at most this many bytes on the wire and this many characters (the host's limit is 4000 including the "Note from ..." line).
pub const MAX_NOTE_BYTES: usize = 4096;
pub const MAX_NOTE_CHARS: usize = 3800;
/// Notes a member may send per minute (counted by the receiver, per sender).
pub const NOTES_PER_MIN: usize = 10;
/// Notes waiting for the owner's decision; the oldest are dropped first.
pub const MAX_PENDING_NOTES: usize = 40;
/// Of those, what one teammate can hold at once.
pub const MAX_PENDING_PER_SENDER: usize = 5;
/// Workspace requests one teammate can make per snapshot gap, whatever the project.
pub const WS_REQUESTS_PER_WINDOW: usize = 6;
/// A requester gets one snapshot per project this often.
pub const SNAPSHOT_GAP_MS: u64 = 30_000;
/// Total diff text of a snapshot, and of one file in it.
pub const MAX_SNAPSHOT_BYTES: usize = 512 * 1024;
pub const MAX_FILE_BYTES: usize = 64 * 1024;
pub const MAX_FILES: usize = 300;
/// Raw bytes per chunk: base64 makes 14 KiB into ~19 KiB, so the message stays under [`MAX_MSG`] (24 KiB).
pub const CHUNK_RAW: usize = 14 * 1024;
/// A snapshot of more chunks than this is refused by the receiver (diff text is 512 KiB; JSON escaping can double it).
pub const MAX_CHUNKS: u32 = 128;
/// Follow-ups a member may send per minute (counted by the receiver, per sender).
pub const FOLLOWUPS_PER_MIN: usize = 5;
/// The newest commits of the checked-out branch a snapshot carries, and the longest subject of one.
pub const MAX_COMMITS: usize = 40;
/// A sender over a limit is told about it at most this often (and the audit log gets one line per telling).
pub const REFUSAL_GAP_MS: u64 = 10_000;
pub const MAX_SUBJECT_CHARS: usize = 160;
const MAX_AUTHOR_CHARS: usize = 60;

/// Where a note stands, as the sender sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoteStatus {
    /// The owner's machine took it and waits for the person.
    Received,
    Accepted,
    Rejected,
    /// The agent got it with a tool call.
    Delivered,
    /// The agent's work ended before it could be delivered.
    Dropped,
    /// Not even shown to the owner (`reason` says why).
    Refused,
}

/// What a pending message from a teammate is: a note for a run that works (delivered with the agent's next tool call), or a follow-up
/// for a run that does not (sent as a new prompt). A follow-up is never accepted without the owner's click.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum NoteKind {
    #[default]
    #[serde(rename = "note")]
    Note,
    #[serde(rename = "followup")]
    FollowUp,
}

/// The plaintext of a `direct` (or, for `chat.msg`, `fanout`) envelope of T3 / T4 / T6.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all_fields = "camelCase")]
pub enum CollabMsg {
    #[serde(rename = "note.send")]
    NoteSend { run_id: String, note_id: String, text: String },
    /// A suggestion for a run that is not working; the owner decides, every time.
    #[serde(rename = "followup.send")]
    FollowUpSend { run_id: String, note_id: String, text: String },
    #[serde(rename = "followup.status")]
    FollowUpStatus {
        run_id: String,
        note_id: String,
        status: NoteStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// Member -> the run's owner: a chat message for the thread of that run.
    #[serde(rename = "chat.send")]
    ChatSend { run_id: String, msg_id: String, text: String },
    /// The run's owner -> everyone: a message of the thread, stamped with the owner's clock (accepted only from the owner of the run).
    #[serde(rename = "chat.msg")]
    ChatMsg { run_id: String, msg_id: String, author: String, text: String, at: u64 },
    /// Member -> owner: "send me the last messages of this run's thread".
    #[serde(rename = "chat.request")]
    ChatRequest { run_id: String },
    #[serde(rename = "chat.history")]
    ChatHistory { run_id: String, msgs: Vec<ChatEntry> },
    /// Owner -> sender: the message was not taken (`rate`, `unknownRun`, `notMember`, `invalid`).
    #[serde(rename = "chat.denied")]
    ChatDenied { run_id: String, msg_id: String, reason: String },
    #[serde(rename = "note.status")]
    NoteStatus {
        run_id: String,
        note_id: String,
        status: NoteStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "ws.request")]
    WsRequest { project_key: String },
    #[serde(rename = "ws.chunk")]
    WsChunk { project_key: String, snap_id: String, index: u32, count: u32, sha256: String, data: String },
    #[serde(rename = "ws.denied")]
    WsDenied { project_key: String, reason: String },
}

fn clean_id(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

/// A note text as it will be shown and handed to the agent: control characters (except newline and tab) removed, trimmed.
pub fn clean_note(text: &str) -> String {
    text.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t')).collect::<String>().trim().to_string()
}

impl CollabMsg {
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("collab message serializes")
    }

    /// `None` for anything that is not one of the messages above or breaks their limits.
    pub fn parse(plain: &[u8]) -> Option<Self> {
        if plain.len() > MAX_MSG * 2 {
            return None;
        }
        let m: Self = serde_json::from_slice(plain).ok()?;
        m.valid().then_some(m)
    }

    fn valid(&self) -> bool {
        match self {
            Self::NoteSend { run_id, note_id, text } => {
                let t = clean_note(text);
                clean_id(run_id, 80) && clean_id(note_id, 80) && text.len() <= MAX_NOTE_BYTES && !t.is_empty() && t.chars().count() <= MAX_NOTE_CHARS
            }
            Self::NoteStatus { run_id, note_id, reason, .. } | Self::FollowUpStatus { run_id, note_id, reason, .. } => {
                clean_id(run_id, 80) && clean_id(note_id, 80) && reason.as_ref().is_none_or(|r| r.len() <= 40)
            }
            Self::FollowUpSend { run_id, note_id, text } => {
                let t = clean_note(text);
                clean_id(run_id, 80) && clean_id(note_id, 80) && text.len() <= MAX_NOTE_BYTES && !t.is_empty() && t.chars().count() <= MAX_NOTE_CHARS
            }
            Self::ChatSend { run_id, msg_id, text } => clean_id(run_id, 80) && clean_id(msg_id, 80) && text.len() <= MAX_CHAT_BYTES && text_ok(&clean_chat(text)),
            Self::ChatMsg { run_id, msg_id, author, text, .. } => clean_id(run_id, 80) && clean_id(msg_id, 80) && clean_id(author, 64) && text_ok(text),
            Self::ChatRequest { run_id } => clean_id(run_id, 80),
            Self::ChatHistory { run_id, msgs } => clean_id(run_id, 80) && msgs.len() <= HISTORY_MAX && msgs.iter().all(ChatEntry::valid),
            Self::ChatDenied { run_id, msg_id, reason } => clean_id(run_id, 80) && clean_id(msg_id, 80) && reason.len() <= 40,
            Self::WsRequest { project_key } | Self::WsDenied { project_key, .. } => clean_id(project_key, 64),
            Self::WsChunk { project_key, snap_id, index, count, sha256, data } => {
                clean_id(project_key, 64) && clean_id(snap_id, 40) && *count >= 1 && *count <= MAX_CHUNKS && index < count && sha256.len() == 64 && data.len() <= MAX_MSG
            }
        }
    }
}

// ---------------------------------------------------------------- settings

/// The `team` settings of T3 / T4: `autoAcceptNotesFrom` (a list of member ids, default empty) and `workspaceProjects`
/// (`{ "<projectKey>": true }`, default empty = nobody can look at a workspace).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CollabSettings {
    pub auto_accept: HashSet<String>,
    pub workspace_projects: HashSet<String>,
}

impl CollabSettings {
    pub fn from_map(m: &Map<String, Value>) -> Self {
        let auto_accept = m.get("autoAcceptNotesFrom").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
        let workspace_projects = m.get("workspaceProjects").and_then(Value::as_object).map(|o| o.iter().filter(|(_, v)| v.as_bool() == Some(true)).map(|(k, _)| k.clone()).collect()).unwrap_or_default();
        Self { auto_accept, workspace_projects }
    }
}

// ---------------------------------------------------------------- rate limits

/// At most `max` events per `window_ms` per key.
#[derive(Debug, Clone)]
pub struct RateLimit {
    max: usize,
    window_ms: u64,
    seen: HashMap<String, VecDeque<u64>>,
}

impl RateLimit {
    pub fn new(max: usize, window_ms: u64) -> Self {
        Self { max, window_ms, seen: HashMap::new() }
    }

    pub fn notes() -> Self {
        Self::new(NOTES_PER_MIN, 60_000)
    }

    pub fn snapshots() -> Self {
        Self::new(1, SNAPSHOT_GAP_MS)
    }

    pub fn followups() -> Self {
        Self::new(FOLLOWUPS_PER_MIN, 60_000)
    }

    pub fn chat() -> Self {
        Self::new(crate::chat::CHAT_PER_MIN, 60_000)
    }

    /// "May I tell this sender it was refused?": once per [`REFUSAL_GAP_MS`] per key, so refusing a flood cannot become a flood of its own.
    pub fn refusals() -> Self {
        Self::new(1, REFUSAL_GAP_MS)
    }

    /// Records the event and says whether it is within the limit. A refused event is not recorded.
    pub fn allow(&mut self, key: &str, now_ms: u64) -> bool {
        if self.seen.len() > 512 {
            self.seen.retain(|_, q| q.back().is_some_and(|t| now_ms.saturating_sub(*t) < self.window_ms));
        }
        let q = self.seen.entry(key.to_string()).or_default();
        while q.front().is_some_and(|t| now_ms.saturating_sub(*t) >= self.window_ms) {
            q.pop_front();
        }
        if q.len() >= self.max {
            return false;
        }
        q.push_back(now_ms);
        true
    }
}

/// What to do with a workspace request before looking at anything else about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Pass,
    /// Over the sender's budget: drop it without an answer (an answer would let a flood make this machine talk back).
    Silent,
    /// As `Silent`, and this is the first dropped request of the window: one audit entry says so.
    SilentAudit,
}

/// A per-sender limiter that runs before any other check, so a flood costs the sender nothing to send and this machine nothing to
/// answer. Over the limit it stays quiet and audits once per window, not once per request.
#[derive(Debug, Clone)]
pub struct SenderGate {
    limit: RateLimit,
    noise: RateLimit,
}

impl SenderGate {
    pub fn workspace() -> Self {
        Self { limit: RateLimit::new(WS_REQUESTS_PER_WINDOW, SNAPSHOT_GAP_MS), noise: RateLimit::new(1, SNAPSHOT_GAP_MS * 2) }
    }

    pub fn check(&mut self, sender: &str, now_ms: u64) -> Gate {
        if self.limit.allow(sender, now_ms) {
            Gate::Pass
        } else if self.noise.allow(sender, now_ms) {
            Gate::SilentAudit
        } else {
            Gate::Silent
        }
    }
}

impl Default for RateLimit {
    fn default() -> Self {
        Self::notes()
    }
}

// ---------------------------------------------------------------- notes (owner side)

/// What the owner's machine knows about the run a note names.
#[derive(Debug, Clone, Copy)]
pub struct RunFacts {
    /// Its project is switched on for the team and this run was not opted out.
    pub shared: bool,
    /// Running or waiting for the person (a finished run takes no note).
    pub live: bool,
    /// Notes are Claude's (the other providers do not take them).
    pub claude: bool,
}

/// The one rule for an incoming note. `Err` is the `reason` sent back; nothing is shown to the owner then.
pub fn judge_note(sender_in_roster: bool, run: Option<RunFacts>) -> Result<(), &'static str> {
    if !sender_in_roster {
        return Err("notMember");
    }
    // a run that is not shared answers like one that does not exist: a teammate learns nothing about runs it cannot see
    let Some(r) = run.filter(|r| r.shared) else { return Err("unknownRun") };
    if !r.live {
        return Err("notLive");
    }
    if !r.claude {
        return Err("unsupported");
    }
    Ok(())
}

/// The rule for an incoming follow-up: like a note, but for a run that is NOT working (a working run takes a note instead).
/// `Err` is the `reason` sent back; nothing is shown to the owner then.
pub fn judge_followup(sender_in_roster: bool, run: Option<RunFacts>) -> Result<(), &'static str> {
    if !sender_in_roster {
        return Err("notMember");
    }
    let Some(r) = run.filter(|r| r.shared) else { return Err("unknownRun") };
    if r.live {
        return Err("busy");
    }
    if !r.claude {
        return Err("unsupported");
    }
    Ok(())
}

/// The rule for an incoming chat message: a member of the team writing in the thread of a run that is shared (finished or not, any
/// provider). A run that is not shared answers like one that does not exist.
pub fn judge_chat(sender_in_roster: bool, run: Option<RunFacts>) -> Result<(), &'static str> {
    if !sender_in_roster {
        return Err("notMember");
    }
    run.filter(|r| r.shared).map(|_| ()).ok_or("unknownRun")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingNote {
    pub from: String,
    pub from_name: String,
    pub run_id: String,
    pub note_id: String,
    pub text: String,
    pub at: u64,
    pub kind: NoteKind,
}

/// Notes the owner has not decided on yet, in memory only.
#[derive(Debug, Default)]
pub struct PendingNotes {
    items: VecDeque<PendingNote>,
}

impl PendingNotes {
    /// `None` if this note id is already waiting (a replayed message). Otherwise the notes pushed out to make room: the sender's
    /// oldest when it already holds [`MAX_PENDING_PER_SENDER`], then the oldest overall when the list is full. Tell their senders.
    pub fn add(&mut self, n: PendingNote) -> Option<Vec<PendingNote>> {
        if self.items.iter().any(|p| p.from == n.from && p.note_id == n.note_id) {
            return None;
        }
        let mut evicted = vec![];
        while self.items.iter().filter(|p| p.from == n.from).count() >= MAX_PENDING_PER_SENDER {
            let Some(i) = self.items.iter().position(|p| p.from == n.from) else { break };
            evicted.extend(self.items.remove(i));
        }
        self.items.push_back(n);
        while self.items.len() > MAX_PENDING_NOTES {
            evicted.extend(self.items.pop_front());
        }
        Some(evicted)
    }

    pub fn take(&mut self, from: &str, note_id: &str) -> Option<PendingNote> {
        let i = self.items.iter().position(|p| p.from == from && p.note_id == note_id)?;
        self.items.remove(i)
    }

    pub fn list(&self) -> Vec<PendingNote> {
        self.items.iter().cloned().collect()
    }

    /// The member left: its notes go.
    pub fn drop_member(&mut self, id: &str) {
        self.items.retain(|p| p.from != id);
    }

    pub fn drop_run(&mut self, run_id: &str) -> Vec<PendingNote> {
        let (gone, keep): (Vec<_>, Vec<_>) = std::mem::take(&mut self.items).into_iter().partition(|p| p.run_id == run_id);
        self.items = keep.into();
        gone
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

/// The text the agent sees: clearly the teammate's, not the person's.
pub fn attributed(name: &str, text: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).take(60).collect();
    format!("Note from teammate {name}:\n{}", clean_note(text))
}

/// The prompt a follow-up becomes once the owner approved it: marked as the teammate's, and as approved, so the agent (and the
/// transcript, which every member can read) can tell it from something the person typed.
pub fn attributed_followup(name: &str, text: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).take(60).collect();
    format!("Follow-up from teammate {name} (the person running you approved it):\n{}", clean_note(text))
}

// ---------------------------------------------------------------- workspace snapshot (T4)

/// One changed file of a snapshot. `diff` is a unified diff (redacted); empty with `skipped` set when the content is not shared.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFile {
    pub path: String,
    /// `M`, `A`, `D`, `R`, `U` (untracked), `C` (conflicted) or `T`.
    pub status: String,
    pub diff: String,
    pub truncated: bool,
    /// `secret`, `binary`, `large`, `unreadable` or `limit`: why there is no (full) diff.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped: Option<String>,
}

/// One commit of the branch a snapshot was taken on (docs/team.md, "commit list"). No e-mail address, a redacted subject.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotCommit {
    /// The first ten characters of the commit id.
    pub oid: String,
    pub subject: String,
    /// The author's name as git has it.
    pub author: String,
    /// Author time, milliseconds.
    pub at: u64,
    /// Not on the upstream branch yet.
    pub unpushed: bool,
}

impl SnapshotCommit {
    /// What the receiving side insists on, whatever the sender claims: a hexadecimal id of at most ten characters, and names and
    /// subjects within their caps (they are shown as text, so this is about size, not about markup).
    pub fn sane(&self) -> bool {
        (7..=10).contains(&self.oid.len())
            && self.oid.bytes().all(|c| c.is_ascii_hexdigit())
            && self.subject.chars().count() <= MAX_SUBJECT_CHARS
            && self.author.chars().count() <= MAX_AUTHOR_CHARS
    }
}

/// What the owner's git integration reported for one commit.
#[derive(Debug, Clone)]
pub struct RawCommit {
    pub oid: String,
    pub subject: String,
    pub author: String,
    pub date_ms: i64,
    pub unpushed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub project_key: String,
    pub branch: Option<String>,
    /// The upstream branch (`origin/main`), when the branch has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub taken_at: u64,
    pub files: Vec<SnapshotFile>,
    /// The newest commits of the branch (a sender before the commit list sends none).
    #[serde(default)]
    pub commits: Vec<SnapshotCommit>,
    /// Files or text were left out to stay under the caps.
    pub truncated: bool,
}

fn plain(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect()
}

/// The commit list a teammate may see: at most [`MAX_COMMITS`], newest first as given, subjects through the redactor and cut, names
/// without control characters, ids shortened and checked to be hexadecimal.
pub fn build_commits(raw: Vec<RawCommit>) -> Vec<SnapshotCommit> {
    raw.into_iter()
        .filter(|c| c.oid.len() >= 7 && c.oid.chars().all(|ch| ch.is_ascii_hexdigit()))
        .take(MAX_COMMITS)
        .map(|c| SnapshotCommit {
            oid: c.oid.chars().take(10).collect(),
            // redact first, then cut: a secret that straddles the cut must not survive as a prefix
            subject: plain(&mask_emails(&scrub(&plain(&c.subject, 2000))), MAX_SUBJECT_CHARS),
            author: plain(&mask_emails(&c.author), MAX_AUTHOR_CHARS),
            at: c.date_ms.max(0) as u64,
            unpushed: c.unpushed,
        })
        .collect()
}

/// What a snapshot knows besides its files.
#[derive(Debug, Clone, Default)]
pub struct SnapshotMeta {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub taken_at: u64,
    pub commits: Vec<RawCommit>,
}

/// What the owner's git integration reported for one changed file (gitignored files never get here: git status leaves them out).
#[derive(Debug, Clone)]
pub struct RawFile {
    pub path: String,
    pub status: String,
    pub binary: bool,
    /// The app's guard called it a secret or never-add file.
    pub guarded: bool,
    pub too_large: bool,
    /// Unified diff text; `None` when it could not be read.
    pub diff: Option<String>,
}

fn cut_at(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut i = max;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    &s[..i]
}

/// [`build_snapshot_with`] for a snapshot without a commit list.
pub fn build_snapshot(id: &str, project_key: &str, branch: Option<String>, ahead: u32, behind: u32, taken_at: u64, raw: Vec<RawFile>) -> Snapshot {
    build_snapshot_with(id, project_key, SnapshotMeta { branch, ahead, behind, taken_at, ..SnapshotMeta::default() }, raw)
}

/// Builds the snapshot a teammate may see: secret files and binaries are listed without content, text goes through the redactor, each
/// file is cut at [`MAX_FILE_BYTES`] with a marker, and the sum stays under [`MAX_SNAPSHOT_BYTES`]. The commit list is bounded and
/// redacted ([`build_commits`]).
pub fn build_snapshot_with(id: &str, project_key: &str, meta: SnapshotMeta, raw: Vec<RawFile>) -> Snapshot {
    let SnapshotMeta { branch, upstream, ahead, behind, taken_at, commits } = meta;
    let mut files = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;
    for f in raw {
        if files.len() >= MAX_FILES {
            truncated = true;
            break;
        }
        let path: String = f.path.chars().filter(|c| !c.is_control()).take(300).collect();
        let mut out = SnapshotFile { path, status: f.status.chars().take(1).collect(), diff: String::new(), truncated: false, skipped: None };
        if is_secret_file(&f.path) || f.guarded {
            out.skipped = Some("secret".into());
        } else if f.binary {
            out.skipped = Some("binary".into());
        } else if f.too_large {
            out.skipped = Some("large".into());
        } else if let Some(d) = f.diff.as_deref() {
            let room = MAX_SNAPSHOT_BYTES.saturating_sub(total);
            if room == 0 {
                out.skipped = Some("limit".into());
                truncated = true;
            } else {
                let limit = MAX_FILE_BYTES.min(room);
                // redact first, then cut: a secret that straddles the cut must not survive as a prefix
                let clean = scrub(d);
                if clean.len() > limit {
                    out.diff = format!("{}\n[... truncated]", cut_at(&clean, limit));
                    out.truncated = true;
                    truncated = true;
                } else {
                    out.diff = clean;
                }
                total += out.diff.len();
            }
        } else {
            out.skipped = Some("unreadable".into());
        }
        files.push(out);
    }
    Snapshot {
        id: id.to_string(),
        project_key: project_key.to_string(),
        branch: branch.map(|b| mask_emails(&scrub(&b))),
        upstream: upstream.map(|u| plain(&mask_emails(&scrub(&u)), 120)),
        ahead,
        behind,
        taken_at,
        files,
        commits: build_commits(commits),
        truncated,
    }
}

/// Splits a snapshot into messages of at most [`MAX_MSG`] bytes, in order, each carrying the whole snapshot's SHA-256.
pub fn chunk_snapshot(s: &Snapshot) -> Vec<CollabMsg> {
    let bytes = serde_json::to_vec(s).expect("snapshot serializes");
    let sha = sha256_hex(&bytes);
    let parts: Vec<&[u8]> = bytes.chunks(CHUNK_RAW).collect();
    let count = parts.len() as u32;
    parts.into_iter().enumerate().map(|(i, p)| CollabMsg::WsChunk { project_key: s.project_key.clone(), snap_id: s.id.clone(), index: i as u32, count, sha256: sha.clone(), data: b64u(p) }).collect()
}

/// A snapshot that fits in [`MAX_CHUNKS`] chunks: if the serialized form is larger (heavy escaping), files are dropped from the end.
pub fn fit_snapshot(mut s: Snapshot) -> Snapshot {
    while !s.files.is_empty() && serde_json::to_vec(&s).map_or(0, |b| b.len()) > MAX_CHUNKS as usize * CHUNK_RAW {
        s.files.pop();
        s.truncated = true;
    }
    s
}

#[derive(Debug)]
struct Partial {
    snap_id: String,
    count: u32,
    sha256: String,
    parts: Vec<Option<Vec<u8>>>,
    bytes: usize,
}

/// Receiver: puts the chunks of a snapshot back together. One partial snapshot per (member, project); a chunk of a newer snapshot id
/// replaces it. Chunks may arrive in any order and twice. The result is checked against the SHA-256 and parsed; it must name the
/// project and id the chunks carried.
#[derive(Debug, Default)]
pub struct Reassembly {
    partial: HashMap<(String, String), Partial>,
}

impl Reassembly {
    pub fn push(&mut self, member: &str, msg: &CollabMsg) -> Result<Option<Snapshot>, &'static str> {
        let CollabMsg::WsChunk { project_key, snap_id, index, count, sha256, data } = msg else { return Err("notAChunk") };
        let Some(raw) = b64u_decode(data) else { return Err("badData") };
        if raw.len() > CHUNK_RAW || *index >= *count || *count > MAX_CHUNKS {
            return Err("tooBig");
        }
        if self.partial.len() > 64 {
            self.partial.clear();
        }
        let key = (member.to_string(), project_key.clone());
        let fresh = self.partial.get(&key).is_none_or(|p| p.snap_id != *snap_id);
        if fresh {
            self.partial.insert(key.clone(), Partial { snap_id: snap_id.clone(), count: *count, sha256: sha256.clone(), parts: vec![None; *count as usize], bytes: 0 });
        }
        let p = self.partial.get_mut(&key).ok_or("lost")?;
        if p.count != *count || p.sha256 != *sha256 {
            self.partial.remove(&key);
            return Err("inconsistent");
        }
        let i = *index as usize;
        if p.parts[i].is_none() {
            p.bytes += raw.len();
            p.parts[i] = Some(raw);
        }
        if p.parts.iter().any(Option::is_none) {
            return Ok(None);
        }
        let p = self.partial.remove(&key).ok_or("lost")?;
        let whole: Vec<u8> = p.parts.into_iter().flatten().flatten().collect();
        if sha256_hex(&whole) != p.sha256 {
            return Err("badHash");
        }
        let snap: Snapshot = serde_json::from_slice(&whole).map_err(|_| "badSnapshot")?;
        if snap.id != p.snap_id || snap.project_key != *project_key || snap.files.len() > MAX_FILES || snap.commits.len() > MAX_COMMITS || !snap.commits.iter().all(SnapshotCommit::sane) {
            return Err("mismatch");
        }
        Ok(Some(snap))
    }

    pub fn drop_member(&mut self, id: &str) {
        self.partial.retain(|(m, _), _| m != id);
    }

    pub fn clear(&mut self) {
        self.partial.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(text: &str) -> Vec<u8> {
        CollabMsg::NoteSend { run_id: "r1".into(), note_id: "n1".into(), text: text.into() }.encode()
    }

    #[test]
    fn note_roundtrips_and_is_validated() {
        let ok = CollabMsg::parse(&note("please look at the parser"));
        assert!(matches!(ok, Some(CollabMsg::NoteSend { .. })));
        assert!(CollabMsg::parse(&note("   ")).is_none(), "empty");
        assert!(CollabMsg::parse(&note(&"x".repeat(MAX_NOTE_BYTES + 1))).is_none(), "over 4 KiB");
        assert!(CollabMsg::parse(&note(&"x".repeat(MAX_NOTE_BYTES))).is_none(), "4096 chars exceed the character cap");
        assert!(CollabMsg::parse(&note(&"x".repeat(MAX_NOTE_CHARS))).is_some());
        let bad_id = CollabMsg::NoteSend { run_id: "r 1\n".into(), note_id: "n1".into(), text: "hi".into() }.encode();
        assert!(CollabMsg::parse(&bad_id).is_none());
    }

    #[test]
    fn other_remote_actions_are_rejected() {
        // everything a teammate must never be able to do, in the shapes someone might try
        for t in [
            r#"{"t":"permission.answer","runId":"r1","requestId":"q","decision":"allowOnce"}"#,
            r#"{"t":"permission.decide","runId":"r1","requestId":"q","allow":true}"#,
            r#"{"t":"question.answer","runId":"r1","requestId":"q","answer":"yes"}"#,
            r#"{"t":"run.start","projectKey":"abc","prompt":"rm -rf /"}"#,
            r#"{"t":"run.stop","runId":"r1"}"#,
            r#"{"t":"run.send","runId":"r1","text":"hi"}"#,
            r#"{"t":"agent.prompt","runId":"r1","text":"hi"}"#,
            r#"{"t":"note.accept","runId":"r1","noteId":"n1"}"#,
            r#"{"t":"followup.accept","runId":"r1","noteId":"n1"}"#,
            r#"{"t":"followup.start","runId":"r1","text":"hi"}"#,
            r#"{"t":"chat.delete","runId":"r1","msgId":"m1"}"#,
            r#"{"t":"chat.send","runId":"r1","text":"no message id"}"#,
            r#"{"t":"runs.request"}"#,
            r#"{"t":"","runId":"r1"}"#,
            r#"{"runId":"r1","noteId":"n1","text":"no tag"}"#,
            r#"[]"#,
            r#"not json"#,
        ] {
            assert!(CollabMsg::parse(t.as_bytes()).is_none(), "{t} must not parse");
        }
        // and the run-sharing parser does not take a note either
        assert!(crate::share::ShareMsg::parse(&note("hello")).is_none());
        assert!(CollabMsg::parse(&crate::share::ShareMsg::Request.encode()).is_none());
    }

    #[test]
    fn judge_note_needs_member_shared_live_claude() {
        let ok = RunFacts { shared: true, live: true, claude: true };
        assert_eq!(judge_note(true, Some(ok)), Ok(()));
        assert_eq!(judge_note(false, Some(ok)), Err("notMember"));
        assert_eq!(judge_note(true, None), Err("unknownRun"));
        assert_eq!(judge_note(true, Some(RunFacts { shared: false, ..ok })), Err("unknownRun"), "same answer as a run that does not exist");
        assert_eq!(judge_note(true, Some(RunFacts { live: false, ..ok })), Err("notLive"));
        assert_eq!(judge_note(true, Some(RunFacts { claude: false, ..ok })), Err("unsupported"));
    }

    #[test]
    fn rate_limit_is_per_key_and_slides() {
        let mut r = RateLimit::notes();
        for i in 0..NOTES_PER_MIN {
            assert!(r.allow("a", i as u64 * 100));
        }
        assert!(!r.allow("a", 5_000), "the 11th within a minute");
        assert!(r.allow("b", 5_000), "another sender has its own budget");
        assert!(r.allow("a", 60_000), "the window moved on");
        let mut s = RateLimit::snapshots();
        assert!(s.allow("a:p", 0));
        assert!(!s.allow("a:p", 29_999));
        assert!(s.allow("a:p", 30_000));
        assert!(s.allow("b:p", 1));
    }

    #[test]
    fn pending_notes_are_bounded_and_decided_once() {
        let mut p = PendingNotes::default();
        let n = |from: &str, i: usize| PendingNote { from: from.into(), from_name: "Mia".into(), run_id: "r".into(), note_id: format!("n{i}"), text: "t".into(), at: 0, kind: NoteKind::Note };
        assert_eq!(p.add(n("m", 0)), Some(vec![]));
        assert_eq!(p.add(n("m", 0)), None, "replay");
        for i in 1..100 {
            p.add(n(&format!("s{}", i % 20), i));
        }
        assert_eq!(p.len(), MAX_PENDING_NOTES);
        assert!(p.take("s19", "n99").is_some());
        assert!(p.take("s19", "n99").is_none(), "decided once");
        assert!(p.take("other", "n98").is_none(), "only the sender's note");
        assert!(!p.drop_run("r").is_empty());
        assert!(p.is_empty());
    }

    #[test]
    fn one_sender_cannot_fill_the_pending_list() {
        let mut p = PendingNotes::default();
        let n = |from: &str, i: usize| PendingNote { from: from.into(), from_name: "x".into(), run_id: "r".into(), note_id: format!("n{i}"), text: "t".into(), at: 0, kind: NoteKind::Note };
        p.add(n("other", 0));
        let mut dropped = vec![];
        for i in 0..20 {
            dropped.extend(p.add(n("flood", i)).unwrap());
        }
        assert_eq!(p.list().iter().filter(|x| x.from == "flood").count(), MAX_PENDING_PER_SENDER);
        assert!(p.take("other", "n0").is_some(), "the other member's note is still there");
        assert_eq!(dropped.len(), 20 - MAX_PENDING_PER_SENDER);
        assert_eq!(dropped[0].note_id, "n0", "the oldest goes first");
    }

    #[test]
    fn workspace_flood_is_silent_and_audited_once_per_window() {
        let mut g = SenderGate::workspace();
        for i in 0..WS_REQUESTS_PER_WINDOW {
            assert_eq!(g.check("a", i as u64), Gate::Pass);
        }
        assert_eq!(g.check("a", 100), Gate::SilentAudit);
        for t in 101..200 {
            assert_eq!(g.check("a", t), Gate::Silent);
        }
        assert_eq!(g.check("b", 100), Gate::Pass, "per sender");
        assert_eq!(g.check("a", SNAPSHOT_GAP_MS + 10), Gate::Pass, "the window moved on");
    }

    #[test]
    fn settings_default_to_nothing() {
        let d = CollabSettings::from_map(&Map::new());
        assert!(d.auto_accept.is_empty() && d.workspace_projects.is_empty());
        let m: Map<String, Value> = serde_json::from_str(r#"{"autoAcceptNotesFrom":["a",1,"b"],"workspaceProjects":{"k1":true,"k2":false}}"#).unwrap();
        let s = CollabSettings::from_map(&m);
        assert_eq!(s.auto_accept.len(), 2);
        assert_eq!(s.workspace_projects, HashSet::from(["k1".to_string()]));
    }

    #[test]
    fn note_is_attributed_to_the_teammate() {
        let t = attributed("Mia\u{7}", "check the\u{0} tests");
        assert_eq!(t, "Note from teammate Mia:\ncheck the tests");
    }

    fn raw(path: &str, diff: &str) -> RawFile {
        RawFile { path: path.into(), status: "M".into(), binary: false, guarded: false, too_large: false, diff: Some(diff.into()) }
    }

    #[test]
    fn snapshot_leaves_out_secrets_binaries_and_redacts() {
        let key = format!("AKIA{}", "ABCDEFGHIJKLMNOP");
        let mut bin = raw("logo.png", "");
        bin.binary = true;
        let mut guarded = raw("notes.txt", "x");
        guarded.guarded = true;
        let s = build_snapshot(
            "s1",
            "k",
            Some("main".into()),
            1,
            2,
            9,
            vec![raw(".env.local", "+TOKEN=hunter2"), raw("deploy/id_rsa", concat!("+-----", "BEGIN OPENSSH PRIVATE KEY-----")), bin, guarded, raw("src/a.rs", &format!("+let k = \"{key}\";\n+password=hunter2\n+ok")), raw("src/b.rs", "+fine")],
        );
        let by = |p: &str| s.files.iter().find(|f| f.path == p).unwrap();
        assert_eq!(by(".env.local").skipped.as_deref(), Some("secret"));
        assert!(by(".env.local").diff.is_empty());
        assert_eq!(by("deploy/id_rsa").skipped.as_deref(), Some("secret"));
        assert_eq!(by("logo.png").skipped.as_deref(), Some("binary"));
        assert_eq!(by("notes.txt").skipped.as_deref(), Some("secret"));
        let a = &by("src/a.rs").diff;
        assert!(!a.contains(&key) && !a.contains("hunter2"), "{a}");
        assert!(a.contains("+ok"));
        assert_eq!(by("src/b.rs").diff, "+fine");
        let wire = serde_json::to_string(&s).unwrap();
        assert!(!wire.contains("hunter2") && !wire.contains(&key) && !wire.contains("PRIVATE KEY"));
    }

    #[test]
    fn snapshot_caps_per_file_and_total() {
        let big = format!("+{}\n", "x".repeat(200 * 1024));
        let files: Vec<RawFile> = (0..10).map(|i| raw(&format!("f{i}.txt"), &big)).collect();
        let s = build_snapshot("s", "k", None, 0, 0, 1, files);
        let total: usize = s.files.iter().map(|f| f.diff.len()).sum();
        assert!(total <= MAX_SNAPSHOT_BYTES + 10 * 32, "{total}");
        assert!(s.files[0].truncated && s.files[0].diff.ends_with("[... truncated]"));
        assert!(s.files[0].diff.len() <= MAX_FILE_BYTES + 32);
        assert!(s.files.iter().any(|f| f.skipped.as_deref() == Some("limit")));
        assert!(s.truncated);
        // multi-byte text is cut on a character boundary
        let multi = build_snapshot("s", "k", None, 0, 0, 1, vec![raw("m.txt", &"é".repeat(MAX_FILE_BYTES))]);
        assert!(multi.files[0].truncated);
    }

    fn big_snapshot() -> Snapshot {
        let files = (0..12).map(|i| raw(&format!("src/f{i}.rs"), &format!("+{}\n", format!("line {i} é ").repeat(2000)))).collect();
        build_snapshot("snap1", "key", Some("feat".into()), 3, 0, 5, files)
    }

    #[test]
    fn snapshot_chunks_fit_and_reassemble_in_any_order() {
        let s = fit_snapshot(big_snapshot());
        let chunks = chunk_snapshot(&s);
        assert!(chunks.len() > 3);
        for c in &chunks {
            assert!(c.encode().len() <= MAX_MSG, "chunk of {} bytes", c.encode().len());
            assert!(CollabMsg::parse(&c.encode()).is_some(), "every chunk is a valid message");
        }
        let mut r = Reassembly::default();
        let mut got = None;
        for c in chunks.iter().rev().chain(chunks.iter().take(1)) {
            if let Some(x) = r.push("mia", c).unwrap() {
                assert!(got.is_none());
                got = Some(x);
            }
        }
        assert_eq!(got.unwrap(), s);
    }

    #[test]
    fn reassembly_rejects_damage_and_keeps_members_apart() {
        let s = fit_snapshot(big_snapshot());
        let mut chunks = chunk_snapshot(&s);
        // a flipped byte fails the hash
        let CollabMsg::WsChunk { data, .. } = &mut chunks[1] else { panic!() };
        let mut raw = b64u_decode(data).unwrap();
        raw[0] ^= 1;
        *data = b64u(&raw);
        let mut r = Reassembly::default();
        let results: Vec<_> = chunks.iter().map(|c| r.push("mia", c)).collect();
        assert_eq!(results.last().unwrap().as_ref().unwrap_err(), &"badHash");
        // a chunk whose count differs from the first is refused
        let good = chunk_snapshot(&s);
        let mut r = Reassembly::default();
        r.push("mia", &good[0]).unwrap();
        let mut other = good[1].clone();
        if let CollabMsg::WsChunk { count, .. } = &mut other {
            *count += 1;
        }
        assert_eq!(r.push("mia", &other).unwrap_err(), "inconsistent");
        // two members do not mix
        let mut r = Reassembly::default();
        for c in &good[..good.len() - 1] {
            r.push("mia", c).unwrap();
        }
        assert!(r.push("bob", good.last().unwrap()).unwrap().is_none());
        assert!(r.push("mia", good.last().unwrap()).unwrap().is_some());
        // a non-chunk is refused
        assert!(r.push("mia", &CollabMsg::WsRequest { project_key: "k".into() }).is_err());
    }

    #[test]
    fn chunk_limits_are_enforced_by_parse() {
        let too_many = CollabMsg::WsChunk { project_key: "k".into(), snap_id: "s".into(), index: 0, count: MAX_CHUNKS + 1, sha256: "0".repeat(64), data: String::new() };
        assert!(CollabMsg::parse(&too_many.encode()).is_none());
        let past_end = CollabMsg::WsChunk { project_key: "k".into(), snap_id: "s".into(), index: 3, count: 3, sha256: "0".repeat(64), data: String::new() };
        assert!(CollabMsg::parse(&past_end.encode()).is_none());
    }

    // ------------------------------------------------------------ T6: chat, follow-ups, commits

    fn followup(text: &str) -> Vec<u8> {
        CollabMsg::FollowUpSend { run_id: "r1".into(), note_id: "f1".into(), text: text.into() }.encode()
    }

    fn chat_send(text: &str) -> Vec<u8> {
        CollabMsg::ChatSend { run_id: "r1".into(), msg_id: "c1".into(), text: text.into() }.encode()
    }

    #[test]
    fn followup_and_chat_roundtrip_and_are_validated() {
        assert!(matches!(CollabMsg::parse(&followup("please also run the tests")), Some(CollabMsg::FollowUpSend { .. })));
        assert!(CollabMsg::parse(&followup("   ")).is_none());
        assert!(CollabMsg::parse(&followup(&"x".repeat(MAX_NOTE_CHARS + 1))).is_none());
        assert!(matches!(CollabMsg::parse(&chat_send("hello team")), Some(CollabMsg::ChatSend { .. })));
        assert!(CollabMsg::parse(&chat_send("  ")).is_none());
        assert!(CollabMsg::parse(&chat_send(&"x".repeat(crate::chat::MAX_CHAT_CHARS + 1))).is_none());
        let bad_run = CollabMsg::ChatSend { run_id: "r 1\n".into(), msg_id: "c1".into(), text: "hi".into() }.encode();
        assert!(CollabMsg::parse(&bad_run).is_none());
        let msg = |author: &str, text: &str| CollabMsg::ChatMsg { run_id: "r1".into(), msg_id: "c1".into(), author: author.into(), text: text.into(), at: 5 }.encode();
        assert!(CollabMsg::parse(&msg("mia", "hello")).is_some());
        assert!(CollabMsg::parse(&msg("mia/x", "hello")).is_none(), "the author is an id");
        assert!(CollabMsg::parse(&msg("mia", "bell\u{7}")).is_none(), "a stamped message is clean already");
        assert!(CollabMsg::parse(&CollabMsg::ChatRequest { run_id: "r1".into() }.encode()).is_some());
        assert!(CollabMsg::parse(&CollabMsg::ChatDenied { run_id: "r1".into(), msg_id: "c1".into(), reason: "rate".into() }.encode()).is_some());
        let st = CollabMsg::FollowUpStatus { run_id: "r1".into(), note_id: "f1".into(), status: NoteStatus::Accepted, reason: None };
        assert!(CollabMsg::parse(&st.encode()).is_some());
    }

    #[test]
    fn a_chat_history_is_bounded() {
        let e = |i: usize| ChatEntry { msg_id: format!("m{i}"), author: "mia".into(), text: "hi".into(), at: i as u64 };
        let ok = CollabMsg::ChatHistory { run_id: "r1".into(), msgs: (0..HISTORY_MAX).map(e).collect() };
        assert!(CollabMsg::parse(&ok.encode()).is_some());
        let many = CollabMsg::ChatHistory { run_id: "r1".into(), msgs: (0..=HISTORY_MAX).map(e).collect() };
        assert!(CollabMsg::parse(&many.encode()).is_none());
        let mut bad = (0..3).map(e).collect::<Vec<_>>();
        bad[1].author = "../x".into();
        assert!(CollabMsg::parse(&CollabMsg::ChatHistory { run_id: "r1".into(), msgs: bad }.encode()).is_none());
    }

    #[test]
    fn judge_followup_needs_member_shared_claude_and_a_run_that_is_not_working() {
        let idle = RunFacts { shared: true, live: false, claude: true };
        assert_eq!(judge_followup(true, Some(idle)), Ok(()));
        assert_eq!(judge_followup(false, Some(idle)), Err("notMember"));
        assert_eq!(judge_followup(true, None), Err("unknownRun"));
        assert_eq!(judge_followup(true, Some(RunFacts { shared: false, ..idle })), Err("unknownRun"), "same answer as a run that does not exist");
        assert_eq!(judge_followup(true, Some(RunFacts { live: true, ..idle })), Err("busy"), "a working run takes a note instead");
        assert_eq!(judge_followup(true, Some(RunFacts { claude: false, ..idle })), Err("unsupported"));
        // and the note rule is the opposite on `live`
        assert_eq!(judge_note(true, Some(idle)), Err("notLive"));
    }

    #[test]
    fn judge_chat_needs_member_and_a_shared_run_whatever_its_state() {
        let any = RunFacts { shared: true, live: false, claude: false };
        assert_eq!(judge_chat(true, Some(any)), Ok(()), "a finished run of any provider has a thread");
        assert_eq!(judge_chat(true, Some(RunFacts { live: true, ..any })), Ok(()));
        assert_eq!(judge_chat(false, Some(any)), Err("notMember"));
        assert_eq!(judge_chat(true, None), Err("unknownRun"));
        assert_eq!(judge_chat(true, Some(RunFacts { shared: false, ..any })), Err("unknownRun"));
    }

    #[test]
    fn a_followup_is_marked_as_the_teammates_and_as_approved() {
        let t = attributed_followup("Mia\u{7}", "run the\u{0} tests too");
        assert_eq!(t, "Follow-up from teammate Mia (the person running you approved it):\nrun the tests too");
        assert_ne!(t.lines().next(), attributed("Mia", "x").lines().next(), "not the header of a note");
    }

    #[test]
    fn followups_and_chat_have_their_own_budgets() {
        let mut f = RateLimit::followups();
        for i in 0..FOLLOWUPS_PER_MIN {
            assert!(f.allow("a", i as u64));
        }
        assert!(!f.allow("a", 1000));
        assert!(f.allow("b", 1000));
        let mut c = RateLimit::chat();
        for i in 0..crate::chat::CHAT_PER_MIN {
            assert!(c.allow("a", i as u64));
        }
        assert!(!c.allow("a", 1000));
    }

    /// Test text with an address in it, written with a `#` so that no address is spelled out in the source.
    fn at(s: &str) -> String {
        s.replace('#', "@")
    }

    fn rc(oid: &str, subject: &str, unpushed: bool) -> RawCommit {
        RawCommit { oid: oid.into(), subject: subject.into(), author: "Mia Kovacs".into(), date_ms: 1_700_000_000_000, unpushed }
    }

    #[test]
    fn commits_are_bounded_redacted_and_without_an_email_address() {
        let key = format!("AKIA{}", "ABCDEFGHIJKLMNOP");
        let raw: Vec<RawCommit> = (0..60).map(|i| rc(&format!("{:040x}", i + 1), &format!("fix {i}"), i < 3)).collect();
        let c = build_commits(raw);
        assert_eq!(c.len(), MAX_COMMITS);
        assert_eq!(c[0].oid.len(), 10);
        assert!(c[0].unpushed && c[2].unpushed && !c[3].unpushed);
        let c = build_commits(vec![
            RawCommit { author: at("jane#corp.com"), ..rc("fedcba9876543210", &at("reported by jane.doe#corp.com, thanks"), false) },
            rc("abcdef0123456789", &format!("rotate {key} now\nsecond line"), false),
            rc("not-hex-id!", "dropped: the id is not hexadecimal", false),
            rc("abc", "dropped: too short to be an id", false),
            rc("1234567890abcdef", &"long ".repeat(100), false),
        ]);
        assert_eq!(c.len(), 3);
        assert_eq!((c[0].subject.as_str(), c[0].author.as_str()), ("reported by [email], thanks", "[email]"), "an address in a subject or in a name is masked");
        assert!(!c[1].subject.contains(&key) && !c[1].subject.contains('\n'), "{}", c[1].subject);
        assert!(c[2].subject.chars().count() <= MAX_SUBJECT_CHARS);
        let wire = serde_json::to_string(&c).unwrap();
        assert!(!wire.contains('@'), "no address on the wire: {wire}");
        // the branch and the upstream are text too
        let s = build_snapshot_with("s", "k", SnapshotMeta { branch: Some(at("fix/for-jane#corp.com")), upstream: Some(at("origin/fix/for-jane#corp.com")), ..SnapshotMeta::default() }, vec![]);
        assert!(!serde_json::to_string(&s).unwrap().contains('@'));
    }

    #[test]
    fn a_snapshot_carries_its_commits_through_the_chunks() {
        let meta = SnapshotMeta {
            branch: Some("feat".into()),
            upstream: Some("origin/feat".into()),
            ahead: 2,
            behind: 0,
            taken_at: 7,
            commits: vec![rc("abcdef0123", "first", true), rc("0123456789ab", "second", false)],
        };
        let s = fit_snapshot(build_snapshot_with("s1", "key", meta, vec![raw("src/a.rs", "+x")]));
        assert_eq!(s.commits.len(), 2);
        assert_eq!(s.upstream.as_deref(), Some("origin/feat"));
        let mut r = Reassembly::default();
        let mut got = None;
        for c in chunk_snapshot(&s) {
            if let Some(x) = r.push("mia", &c).unwrap() {
                got = Some(x);
            }
        }
        assert_eq!(got.unwrap(), s);
    }

    #[test]
    fn a_snapshot_of_an_older_sender_has_no_commits_and_still_parses() {
        let old = r#"{"id":"s","projectKey":"k","branch":"main","ahead":0,"behind":0,"takenAt":1,"files":[],"truncated":false}"#;
        let s: Snapshot = serde_json::from_str(old).unwrap();
        assert!(s.commits.is_empty() && s.upstream.is_none());
        // and one that claims more commits than the cap is refused after reassembly
        let mut big = fit_snapshot(build_snapshot("s2", "k", None, 0, 0, 1, vec![]));
        big.commits = (0..=MAX_COMMITS).map(|i| SnapshotCommit { oid: format!("{i:010x}"), subject: "x".into(), author: "a".into(), at: 1, unpushed: false }).collect();
        let mut r = Reassembly::default();
        let mut last = Ok(None);
        for c in chunk_snapshot(&big) {
            last = r.push("mia", &c);
        }
        assert_eq!(last.unwrap_err(), "mismatch");
        // so is one with a commit that cannot have come from the builder: an id that is not hexadecimal, a subject over the cap
        for bad in [
            SnapshotCommit { oid: "not-hex-id!".into(), subject: "x".into(), author: "a".into(), at: 1, unpushed: false },
            SnapshotCommit { oid: "abcdef0123456789abcdef".into(), subject: "x".into(), author: "a".into(), at: 1, unpushed: false },
            SnapshotCommit { oid: "abcdef0123".into(), subject: "s".repeat(MAX_SUBJECT_CHARS + 1), author: "a".into(), at: 1, unpushed: false },
            SnapshotCommit { oid: "abcdef0123".into(), subject: "x".into(), author: "a".repeat(MAX_AUTHOR_CHARS + 1), at: 1, unpushed: false },
        ] {
            let mut s = fit_snapshot(build_snapshot("s3", "k", None, 0, 0, 1, vec![]));
            s.commits = vec![bad];
            let mut r = Reassembly::default();
            let mut last = Ok(None);
            for c in chunk_snapshot(&s) {
                last = r.push("mia", &c);
            }
            assert_eq!(last.unwrap_err(), "mismatch");
        }
    }

    #[test]
    fn a_refusal_is_told_once_in_a_while() {
        let mut r = RateLimit::refusals();
        assert!(r.allow("mia:chat", 1_000));
        assert!(!r.allow("mia:chat", 1_001), "the second refusal inside the gap is silent");
        assert!(r.allow("mia:note", 1_002), "another kind of refusal is told on its own");
        assert!(r.allow("bo:chat", 1_003), "and so is another sender");
        assert!(r.allow("mia:chat", 1_000 + REFUSAL_GAP_MS));
    }
}
