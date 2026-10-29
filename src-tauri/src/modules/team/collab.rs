//! Team, phases T3, T4 and T6 (docs/team.md): a note or a follow-up into a teammate's run, a snapshot of a teammate's workspace with its
//! commit list, and chat in a shared run. A child of `team.rs`.
//!
//! The ONLY things a teammate can ask of this machine arrive here as [`CollabMsg`]; any other plaintext of a `direct` envelope is
//! dropped by the parser (`crates/team/src/collab.rs`). A note waits for the person's accept (or the per-member opt-in
//! `autoAcceptNotesFrom`) and then takes the same `host.note` path as a note typed in the run panel. A follow-up (for a run that is
//! not working) ALWAYS waits for the person's accept and then goes to the agent as a prompt headed with the teammate's name; the
//! opt-in never applies to it. A snapshot is built only for a project the person switched on (`workspaceProjects`). Chat is human to
//! human: this machine is the hub of the threads of its own runs, and nothing said in a thread reaches an agent. Nothing here answers a
//! permission card or starts a run.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use intely_agent_core::api::RunStatus;
use intely_agent_core::events::types::{AgentEvent, EventKind, NoteState};
use intely_core::{ChangeKind, DiffSource, GuardState, Hunk, HunkLineKind};
use intely_remote::util::{b64u, random, sha256_hex};
use intely_team::audit::event;
use intely_team::chat::{clean_chat, decode_lines, encode_lines, text_ok, ChatEntry, ChatStore, MAX_CHAT_CHARS};
use intely_team::collab::{
    attributed, attributed_followup, build_snapshot_with, chunk_snapshot, clean_note, fit_snapshot, judge_chat, judge_followup, judge_note, CollabMsg, CollabSettings, Gate, NoteKind, NoteStatus, PendingNote, PendingNotes, RateLimit,
    RawCommit, RawFile, Reassembly, RunFacts, SenderGate, Snapshot, SnapshotMeta, MAX_COMMITS, MAX_FILES, MAX_SNAPSHOT_BYTES,
};
use intely_team::redact::scrub;

use super::*;

/// Chunks per flush (the relay allows 300 frames per 10 s per socket; run sharing shares that budget).
const CHUNKS_PER_FLUSH: usize = 6;
const FLUSH_EVERY: Duration = Duration::from_millis(250);
/// A snapshot is accepted only for a request made this recently.
const REQUEST_TTL: Duration = Duration::from_secs(120);
const MAX_SENT: usize = 100;
const MAX_TRACKED: usize = 50;
const MAX_SNAPSHOTS: usize = 40;
/// A history answer is accepted only for a request made this recently.
const HISTORY_TTL: Duration = Duration::from_secs(120);
/// The thread file of a run is rewritten (newest messages only) once it is this big. A thread read back is at most 256 KB of text, which
/// is below this even when every character has to be escaped, so a rewrite is not needed again at once.
const CHAT_FILE_COMPACT: u64 = 1024 * 1024;
/// How many messages this machine sent into teammates' threads are remembered, to tell an answer to them from a stray one.
const MAX_CHAT_SENT: usize = 100;
/// The folder (inside the data folder) with the thread files of this machine's own shared runs. Leaving the team removes it.
pub(super) const CHAT_DIR: &str = "team-chat";

/// Accepted notes (and accepts in flight) whose `delivered` / `dropped` event is still awaited. Zero cost when zero.
static WATCH: AtomicUsize = AtomicUsize::new(0);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SentNote {
    member_id: String,
    run_id: String,
    note_id: String,
    /// `sent`, then what the owner's machine reported: `received`, `accepted`, `rejected`, `delivered`, `dropped`, `refused`.
    status: String,
    reason: Option<String>,
    at: u64,
    /// `note` (into a run that works) or `followup` (for a run that does not).
    kind: String,
}

fn kind_name(k: NoteKind) -> &'static str {
    match k {
        NoteKind::Note => "note",
        NoteKind::FollowUp => "followup",
    }
}

pub(super) struct Collab {
    pending: PendingNotes,
    note_rate: RateLimit,
    followup_rate: RateLimit,
    snap_rate: RateLimit,
    /// The threads of shared runs: this machine's own (read back from their files) and the ones it was told about.
    chat: ChatStore,
    chat_rate: RateLimit,
    /// Whether a sender over a limit is told so (once per [`intely_team::collab::REFUSAL_GAP_MS`] per kind), so refusing is no flood.
    refusal_rate: RateLimit,
    /// History requests this machine made, by (owner, run): only their answers are taken.
    chat_requested: HashMap<(String, String), Instant>,
    /// Messages this machine sent into teammates' threads and has no echo for yet, as (owner, run, message id): only a refusal of one
    /// of those is passed on.
    chat_sent: VecDeque<(String, String, String)>,
    /// Before anything else is looked at (T4): a flood is dropped without an answer.
    ws_gate: SenderGate,
    reasm: Reassembly,
    snapshots: HashMap<(String, String), Snapshot>,
    requested: HashMap<(String, String), Instant>,
    sent: VecDeque<SentNote>,
    /// Local note id -> (member, run id, the member's note id).
    tracked: HashMap<String, (String, String, String)>,
    /// Delivered / dropped events seen while an accept was still in flight.
    recent: VecDeque<(String, NoteState)>,
    inflight: usize,
}

impl Default for Collab {
    fn default() -> Self {
        Self {
            pending: PendingNotes::default(),
            note_rate: RateLimit::notes(),
            followup_rate: RateLimit::followups(),
            snap_rate: RateLimit::snapshots(),
            chat: ChatStore::default(),
            chat_rate: RateLimit::chat(),
            refusal_rate: RateLimit::refusals(),
            chat_requested: HashMap::new(),
            chat_sent: VecDeque::new(),
            ws_gate: SenderGate::workspace(),
            reasm: Reassembly::default(),
            snapshots: HashMap::new(),
            requested: HashMap::new(),
            sent: VecDeque::new(),
            tracked: HashMap::new(),
            recent: VecDeque::new(),
            inflight: 0,
        }
    }
}

fn watch_update(c: &Collab) {
    WATCH.store(c.tracked.len() + c.inflight, Ordering::Relaxed);
}

/// Emits what the locked code collected for the webview.
fn flush(app: &AppHandle, inner: &mut Inner) {
    for (name, payload) in inner.ui.drain(..) {
        let _ = app.emit(name, payload);
    }
}

fn collab_settings(app: &AppHandle) -> CollabSettings {
    let st = app.state::<TeamModState>();
    st.settings.as_ref().and_then(|s| s.get(NS).ok()).map(|m| CollabSettings::from_map(&m)).unwrap_or_default()
}

/// Seals one message to one member (live only, never queued).
fn send_collab(inner: &mut Inner, to: &str, msg: &CollabMsg) -> bool {
    let (Some(team), Some(me)) = (inner.team.as_mut(), inner.identity.as_ref()) else { return false };
    let Ok(env) = team.seal(me, &msg.encode()) else { return false };
    send(inner, out::direct(to, &env.encode(), false, "cl"))
}

fn reply(inner: &mut Inner, to: &str, kind: NoteKind, run_id: &str, note_id: &str, status: NoteStatus, reason: Option<&str>) {
    let (run_id, note_id, reason) = (run_id.to_string(), note_id.to_string(), reason.map(str::to_string));
    let msg = match kind {
        NoteKind::Note => CollabMsg::NoteStatus { run_id, note_id, status, reason },
        NoteKind::FollowUp => CollabMsg::FollowUpStatus { run_id, note_id, status, reason },
    };
    send_collab(inner, to, &msg);
}

fn status_name(s: NoteStatus) -> &'static str {
    match s {
        NoteStatus::Received => "received",
        NoteStatus::Accepted => "accepted",
        NoteStatus::Rejected => "rejected",
        NoteStatus::Delivered => "delivered",
        NoteStatus::Dropped => "dropped",
        NoteStatus::Refused => "refused",
    }
}

/// What a member reports about a note or follow-up this machine sent.
fn sent_status(inner: &mut Inner, sender: &str, kind: NoteKind, run_id: &str, note_id: &str, status: NoteStatus, reason: Option<String>) {
    let Some(s) = inner.collab.sent.iter_mut().find(|s| s.member_id == sender && s.note_id == note_id && s.run_id == run_id && s.kind == kind_name(kind)) else {
        audit(inner, event::REJECTED, Some(sender), Some("status of an unknown note"));
        return;
    };
    s.status = status_name(status).into();
    s.reason = reason;
    let v = serde_json::to_value(&*s).unwrap_or_default();
    inner.ui.push(("team:note-status", v));
}

// ---------------------------------------------------------------- incoming

#[derive(Clone, Copy)]
enum Limit {
    Note,
    FollowUp,
    Chat,
}

/// What to do with a request after it was counted against the sender's limit.
#[derive(Debug, PartialEq, Eq)]
enum Rate {
    /// Within the limit: go on.
    Within,
    /// Over the limit: refuse, tell the sender and write one line to the audit log.
    Refuse,
    /// Over the limit and the sender was told a moment ago: drop it without a word (a flood must not make this machine send a flood).
    Silent,
}

fn rate_check(inner: &mut Inner, sender: &str, limit: Limit, now: u64) -> Rate {
    let (name, within) = match limit {
        Limit::Note => ("note", inner.collab.note_rate.allow(sender, now)),
        Limit::FollowUp => ("followup", inner.collab.followup_rate.allow(sender, now)),
        Limit::Chat => ("chat", inner.collab.chat_rate.allow(sender, now)),
    };
    if within {
        Rate::Within
    } else if inner.collab.refusal_rate.allow(&format!("{sender}:{name}"), now) {
        Rate::Refuse
    } else {
        Rate::Silent
    }
}

/// A verified, parsed message of a member (the envelope's signature named `sender`).
pub(super) fn collab_in(app: &AppHandle, inner: &mut Inner, sender: &str, msg: CollabMsg) {
    let known = inner.team.as_ref().is_some_and(|t| t.me != sender && t.body().member(sender).is_some());
    if !known {
        audit(inner, event::REJECTED, Some(sender), Some("collab: not a member"));
        return;
    }
    let now = now_ms();
    match msg {
        CollabMsg::NoteSend { run_id, note_id, text } => match rate_check(inner, sender, Limit::Note, now) {
            Rate::Within => {
                audit(inner, event::NOTE_RECEIVED, Some(sender), Some("note"));
                tauri::async_runtime::spawn(note_job(app.clone(), sender.to_string(), run_id, note_id, text, NoteKind::Note));
            }
            Rate::Refuse => {
                audit(inner, event::REJECTED, Some(sender), Some("note rate"));
                reply(inner, sender, NoteKind::Note, &run_id, &note_id, NoteStatus::Refused, Some("rate"));
            }
            Rate::Silent => {}
        },
        CollabMsg::FollowUpSend { run_id, note_id, text } => match rate_check(inner, sender, Limit::FollowUp, now) {
            Rate::Within => {
                audit(inner, event::FOLLOWUP_RECEIVED, Some(sender), Some("followup"));
                tauri::async_runtime::spawn(note_job(app.clone(), sender.to_string(), run_id, note_id, text, NoteKind::FollowUp));
            }
            Rate::Refuse => {
                audit(inner, event::REJECTED, Some(sender), Some("follow-up rate"));
                reply(inner, sender, NoteKind::FollowUp, &run_id, &note_id, NoteStatus::Refused, Some("rate"));
            }
            Rate::Silent => {}
        },
        CollabMsg::NoteStatus { run_id, note_id, status, reason } => sent_status(inner, sender, NoteKind::Note, &run_id, &note_id, status, reason),
        CollabMsg::FollowUpStatus { run_id, note_id, status, reason } => sent_status(inner, sender, NoteKind::FollowUp, &run_id, &note_id, status, reason),
        CollabMsg::ChatSend { run_id, msg_id, text } => match rate_check(inner, sender, Limit::Chat, now) {
            Rate::Within => {
                tauri::async_runtime::spawn(chat_job(app.clone(), sender.to_string(), run_id, msg_id, text));
            }
            Rate::Refuse => {
                audit(inner, event::REJECTED, Some(sender), Some("chat rate"));
                send_collab(inner, sender, &CollabMsg::ChatDenied { run_id, msg_id, reason: "rate".into() });
            }
            Rate::Silent => {}
        },
        CollabMsg::ChatMsg { run_id, msg_id, author, text, at } => chat_msg_in(inner, sender, run_id, ChatEntry { msg_id, author, text, at }),
        CollabMsg::ChatRequest { run_id } => match rate_check(inner, sender, Limit::Chat, now) {
            Rate::Within => {
                tauri::async_runtime::spawn(history_job(app.clone(), sender.to_string(), run_id));
            }
            Rate::Refuse => audit(inner, event::REJECTED, Some(sender), Some("chat rate")),
            Rate::Silent => {}
        },
        CollabMsg::ChatHistory { run_id, msgs } => chat_history_in(inner, sender, run_id, msgs),
        CollabMsg::ChatDenied { run_id, msg_id, reason } => chat_denied_in(inner, sender, run_id, msg_id, reason),
        CollabMsg::WsRequest { project_key } => {
            // first: nothing below (a settings read, an audit entry, an answer) is paid for a sender over its budget
            match inner.collab.ws_gate.check(sender, now) {
                Gate::Pass => {}
                Gate::SilentAudit => {
                    audit(inner, event::REJECTED, Some(sender), Some("workspace flood, dropped silently"));
                    return;
                }
                Gate::Silent => return,
            }
            if !collab_settings(app).workspace_projects.contains(&project_key) {
                audit(inner, event::REJECTED, Some(sender), Some("workspace off"));
                send_collab(inner, sender, &CollabMsg::WsDenied { project_key, reason: "off".into() });
                return;
            }
            if !inner.collab.snap_rate.allow(&format!("{sender}:{project_key}"), now) {
                audit(inner, event::REJECTED, Some(sender), Some("workspace rate"));
                send_collab(inner, sender, &CollabMsg::WsDenied { project_key, reason: "rate".into() });
                return;
            }
            tauri::async_runtime::spawn(snapshot_job(app.clone(), sender.to_string(), project_key));
        }
        CollabMsg::WsChunk { ref project_key, .. } => {
            let key = (sender.to_string(), project_key.clone());
            // only what this machine asked for
            if inner.collab.requested.get(&key).is_none_or(|t| t.elapsed() > REQUEST_TTL) {
                audit(inner, event::REJECTED, Some(sender), Some("unrequested snapshot"));
                return;
            }
            match inner.collab.reasm.push(sender, &msg) {
                Ok(Some(snap)) => {
                    inner.collab.requested.remove(&key);
                    if inner.collab.snapshots.len() >= MAX_SNAPSHOTS && !inner.collab.snapshots.contains_key(&key) {
                        inner.collab.snapshots.clear();
                    }
                    inner.ui.push(("team:workspace", serde_json::json!({ "memberId": sender, "snapshot": &snap })));
                    inner.collab.snapshots.insert(key, snap);
                }
                Ok(None) => {}
                Err(why) => {
                    inner.collab.requested.remove(&key);
                    audit(inner, event::REJECTED, Some(sender), Some(&format!("snapshot {why}")));
                    inner.ui.push(("team:workspace-denied", serde_json::json!({ "memberId": sender, "projectKey": key.1, "reason": "damaged" })));
                }
            }
        }
        CollabMsg::WsDenied { project_key, reason } => {
            if inner.collab.requested.remove(&(sender.to_string(), project_key.clone())).is_some() {
                let reason: String = reason.chars().take(20).collect();
                inner.ui.push(("team:workspace-denied", serde_json::json!({ "memberId": sender, "projectKey": project_key, "reason": reason })));
            }
        }
    }
}

pub(super) fn member_gone(inner: &mut Inner, id: &str) {
    let c = &mut inner.collab;
    c.pending.drop_member(id);
    c.chat.drop_owner(id);
    c.chat_requested.retain(|(m, _), _| m != id);
    c.chat_sent.retain(|(m, _, _)| m != id);
    c.reasm.drop_member(id);
    c.snapshots.retain(|(m, _), _| m != id);
    c.requested.retain(|(m, _), _| m != id);
    c.sent.retain(|s| s.member_id != id);
    c.tracked.retain(|_, (m, _, _)| m != id);
    watch_update(c);
}

pub(super) fn forget_all(inner: &mut Inner) {
    inner.collab = Collab::default();
    watch_update(&inner.collab);
}

// ---------------------------------------------------------------- notes: the owner's side

/// Blocking: what this machine knows about the run a note names. `None` = no such run.
fn run_facts(app: &AppHandle, run_id: &str) -> Option<RunFacts> {
    let slot = app.try_state::<crate::agents::AgentSlot>()?;
    let summary = slot.host().list().into_iter().find(|s| s.agent_id == run_id)?;
    let shared = match super::share::resolve_run(app, run_id) {
        Ok(Some(p)) => super::share::read_settings(app).allows(&p.keys, run_id),
        _ => false,
    };
    Some(RunFacts { shared, live: matches!(summary.status, RunStatus::Running | RunStatus::NeedsYou), claude: summary.provider == "claude" })
}

async fn facts_of(app: &AppHandle, run_id: &str) -> Option<RunFacts> {
    let (a, id) = (app.clone(), run_id.to_string());
    tauri::async_runtime::spawn_blocking(move || run_facts(&a, &id)).await.ok().flatten()
}

async fn note_job(app: AppHandle, from: String, run_id: String, note_id: String, text: String, kind: NoteKind) {
    let facts = facts_of(&app, &run_id).await;
    let auto = passes_unasked(kind, &collab_settings(&app).auto_accept, &from);
    let state = st(&app);
    let Ok((secrets, _)) = parts(&state) else { return };
    let accept_now = {
        let mut inner = lock(&state.inner);
        let inner = &mut *inner;
        let name = inner.team.as_ref().and_then(|t| t.body().member(&from)).map(|m| m.name.clone());
        let verdict = match kind {
            NoteKind::Note => judge_note(name.is_some(), facts),
            NoteKind::FollowUp => judge_followup(name.is_some(), facts),
        };
        if let Err(reason) = verdict {
            audit(inner, event::REJECTED, Some(&from), Some(&format!("{} {reason}", kind_name(kind))));
            reply(inner, &from, kind, &run_id, &note_id, NoteStatus::Refused, Some(reason));
            save(inner, &secrets);
            return;
        }
        let note = PendingNote { from: from.clone(), from_name: name.unwrap_or_default(), run_id: run_id.clone(), note_id: note_id.clone(), text: clean_note(&text), at: now_ms(), kind };
        let card = note_view(&note, auto);
        let Some(evicted) = inner.collab.pending.add(note) else { return };
        // a note pushed out of the list is never decided: its sender is told (a stale card answers "no longer waiting")
        for gone in evicted {
            reply(inner, &gone.from, gone.kind, &gone.run_id, &gone.note_id, NoteStatus::Dropped, Some("overflow"));
        }
        reply(inner, &from, kind, &run_id, &note_id, NoteStatus::Received, None);
        inner.ui.push(("team:note-in", card));
        flush(&app, inner);
        save(inner, &secrets);
        auto
    };
    if accept_now {
        let _ = accept_note(&app, &from, &note_id).await;
    }
}

/// Whether a note or follow-up of `from` goes on without the person's click: only a note of a member the person trusts
/// (`autoAcceptNotesFrom`). A follow-up starts a new turn, so it always waits for the person.
fn passes_unasked(kind: NoteKind, trusted: &HashSet<String>, from: &str) -> bool {
    kind == NoteKind::Note && trusted.contains(from)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteView {
    member_id: String,
    member_name: String,
    run_id: String,
    note_id: String,
    text: String,
    at: u64,
    /// The member is trusted (`autoAcceptNotesFrom`): the note is passed on without a decision. Never true for a follow-up.
    auto: bool,
    /// `note` or `followup`.
    kind: &'static str,
}

fn note_view(n: &PendingNote, auto: bool) -> Value {
    let auto = auto && n.kind == NoteKind::Note;
    serde_json::to_value(NoteView { member_id: n.from.clone(), member_name: n.from_name.clone(), run_id: n.run_id.clone(), note_id: n.note_id.clone(), text: n.text.clone(), at: n.at, auto, kind: kind_name(n.kind) }).unwrap_or_default()
}

/// Hands an accepted note to the run, through the same call as a note typed in the run panel, attributed to the teammate. A follow-up
/// becomes a prompt of the run (the same call as a message typed in its composer), headed with the teammate's name and the fact that
/// the person approved it.
async fn accept_note(app: &AppHandle, from: &str, note_id: &str) -> Res<()> {
    let state = st(app);
    let (secrets, _) = parts(&state)?;
    let note = {
        let mut inner = lock(&state.inner);
        let n = inner.collab.pending.take(from, note_id).ok_or_else(|| err("unknownNote", "that note is no longer waiting"))?;
        if n.kind == NoteKind::Note {
            inner.collab.inflight += 1;
            watch_update(&inner.collab);
        }
        n
    };
    // the run may have ended, started working or been switched off since the message arrived
    let facts = facts_of(app, &note.run_id).await;
    let result: Res<Option<String>> = match note.kind {
        NoteKind::Note => match judge_note(true, facts) {
            Err(reason) => Err(err("noteRefused", reason)),
            Ok(()) => {
                let (a, id, text) = (app.clone(), note.run_id.clone(), attributed(&note.from_name, &note.text));
                crate::agents::blocking(move || {
                    let slot = a.try_state::<crate::agents::AgentSlot>().ok_or_else(|| err("unavailable", "agents are unavailable"))?;
                    slot.host().note(&id, None, &text).map(Some)
                })
                .await
            }
        },
        NoteKind::FollowUp => match judge_followup(true, facts) {
            Err(reason) => Err(err("noteRefused", reason)),
            Ok(()) => {
                let (a, id, text) = (app.clone(), note.run_id.clone(), attributed_followup(&note.from_name, &note.text));
                crate::agents::blocking(move || {
                    let slot = a.try_state::<crate::agents::AgentSlot>().ok_or_else(|| err("unavailable", "agents are unavailable"))?;
                    slot.host().send(&id, &text).map(|()| None)
                })
                .await
            }
        },
    };
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    if note.kind == NoteKind::Note {
        inner.collab.inflight = inner.collab.inflight.saturating_sub(1);
    }
    let accepted = if note.kind == NoteKind::Note { event::NOTE_ACCEPTED } else { event::FOLLOWUP_ACCEPTED };
    match result {
        Ok(local_id) => {
            audit(inner, accepted, Some(from), Some(kind_name(note.kind)));
            reply(inner, from, note.kind, &note.run_id, &note.note_id, NoteStatus::Accepted, None);
            match local_id {
                // a note: delivered with the agent's next tool call (the run's events tell)
                Some(local_id) => {
                    let early = inner.collab.recent.iter().find(|(id, _)| *id == local_id).map(|(_, s)| *s);
                    match early {
                        Some(s) => reply(inner, from, note.kind, &note.run_id, &note.note_id, if s == NoteState::Delivered { NoteStatus::Delivered } else { NoteStatus::Dropped }, None),
                        None => {
                            if inner.collab.tracked.len() >= MAX_TRACKED {
                                if let Some(k) = inner.collab.tracked.keys().next().cloned() {
                                    inner.collab.tracked.remove(&k);
                                }
                            }
                            inner.collab.tracked.insert(local_id, (from.to_string(), note.run_id.clone(), note.note_id.clone()));
                        }
                    }
                }
                // a follow-up: the agent has it as a prompt now
                None => reply(inner, from, note.kind, &note.run_id, &note.note_id, NoteStatus::Delivered, None),
            }
            watch_update(&inner.collab);
            save(inner, &secrets);
            Ok(())
        }
        Err(e) => {
            watch_update(&inner.collab);
            audit(inner, event::REJECTED, Some(from), Some(&format!("{} not delivered: {}", kind_name(note.kind), e.code)));
            reply(inner, from, note.kind, &note.run_id, &note.note_id, NoteStatus::Dropped, Some(&e.code.chars().take(30).collect::<String>()));
            save(inner, &secrets);
            Err(e)
        }
    }
}

/// The hook of `share::tap`: reports `delivered` / `dropped` of accepted notes back to their sender. A single atomic load when nothing waits.
pub fn on_events(app: &AppHandle, events: &[AgentEvent]) {
    if WATCH.load(Ordering::Relaxed) == 0 {
        return;
    }
    let Some(state) = app.try_state::<TeamModState>() else { return };
    let Ok((secrets, _)) = parts(&state) else { return };
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    let mut any = false;
    for e in events {
        let EventKind::Note { note_id, state: ns, .. } = &e.kind else { continue };
        if *ns == NoteState::Queued {
            continue;
        }
        any = true;
        match inner.collab.tracked.remove(note_id) {
            Some((from, run, rid)) => reply(inner, &from, NoteKind::Note, &run, &rid, if *ns == NoteState::Delivered { NoteStatus::Delivered } else { NoteStatus::Dropped }, None),
            None => {
                inner.collab.recent.push_back((note_id.clone(), *ns));
                while inner.collab.recent.len() > 32 {
                    inner.collab.recent.pop_front();
                }
            }
        }
    }
    if any {
        watch_update(&inner.collab);
        save(inner, &secrets);
    }
}

// ---------------------------------------------------------------- notes: commands

#[tauri::command]
pub fn team_pending_notes(app: AppHandle, state: State<'_, TeamModState>) -> Res<Vec<Value>> {
    let auto = collab_settings(&app).auto_accept;
    Ok(lock(&state.inner).collab.pending.list().iter().map(|n| note_view(n, auto.contains(&n.from))).collect())
}

/// Accept hands the note to the run; reject tells the sender. Either way the card is gone.
#[tauri::command]
pub async fn team_note_decide(app: AppHandle, state: State<'_, TeamModState>, member_id: String, note_id: String, accept: bool) -> Res<()> {
    if accept {
        return accept_note(&app, &member_id, &note_id).await;
    }
    let (secrets, _) = parts(&state)?;
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    let n = inner.collab.pending.take(&member_id, &note_id).ok_or_else(|| err("unknownNote", "that note is no longer waiting"))?;
    audit(inner, if n.kind == NoteKind::Note { event::NOTE_REJECTED } else { event::FOLLOWUP_REJECTED }, Some(&member_id), Some(kind_name(n.kind)));
    reply(inner, &member_id, n.kind, &n.run_id, &n.note_id, NoteStatus::Rejected, None);
    save(inner, &secrets);
    Ok(())
}

/// Sends a note into a teammate's run. Live Claude runs of online members only; the teammate's machine decides.
#[tauri::command]
pub fn team_note_send(state: State<'_, TeamModState>, member_id: String, run_id: String, text: String) -> Res<String> {
    let (secrets, _) = parts(&state)?;
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    let Some(team) = inner.team.as_ref() else { return Err(err("noTeam", "you are not in a team")) };
    if team.me == member_id || team.body().member(&member_id).is_none() {
        return Err(err("unknownMember", "that member is not in the team"));
    }
    if !inner.online.get(&member_id).is_some_and(|o| o.0) {
        return Err(err("offline", "that member is offline"));
    }
    let live = inner.store.cards().into_iter().any(|(m, c)| m == member_id && c.run_id == run_id && c.provider == "claude" && matches!(c.state.as_str(), "running" | "waiting"));
    if !live {
        return Err(err("notLive", "notes go only into runs of Claude that are working"));
    }
    let note_id = format!("tn-{}", b64u(&random::<8>()));
    let msg = CollabMsg::NoteSend { run_id: run_id.clone(), note_id: note_id.clone(), text: text.clone() };
    if CollabMsg::parse(&msg.encode()).is_none() {
        return Err(err("noteInvalid", "a note must not be empty and is at most 3800 characters"));
    }
    if !send_collab(inner, &member_id, &msg) {
        return Err(err("offline", "the note could not be sent"));
    }
    let s = SentNote { member_id, run_id, note_id: note_id.clone(), status: "sent".into(), reason: None, at: now_ms(), kind: "note".into() };
    inner.collab.sent.push_back(s);
    while inner.collab.sent.len() > MAX_SENT {
        inner.collab.sent.pop_front();
    }
    save(inner, &secrets);
    Ok(note_id)
}

/// The notes this machine sent into a member's run, with the last status each reported.
#[tauri::command]
pub fn team_sent_notes(state: State<'_, TeamModState>, member_id: String, run_id: String) -> Res<Vec<SentNote>> {
    Ok(lock(&state.inner).collab.sent.iter().filter(|s| s.member_id == member_id && s.run_id == run_id).cloned().collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabSettingsView {
    auto_accept_notes_from: Vec<String>,
}

#[tauri::command]
pub fn team_collab_settings(app: AppHandle) -> Res<CollabSettingsView> {
    let mut ids: Vec<String> = collab_settings(&app).auto_accept.into_iter().collect();
    ids.sort();
    Ok(CollabSettingsView { auto_accept_notes_from: ids })
}

#[tauri::command]
pub fn team_set_auto_accept(state: State<'_, TeamModState>, member_id: String, enabled: bool) -> Res<()> {
    if member_id.is_empty() || member_id.len() > 64 {
        return Err(err("invalid", "not a member id"));
    }
    let settings = state.settings.as_ref().ok_or_else(|| err("unavailable", "Settings are unavailable"))?;
    let mut ids: Vec<String> = settings.get(NS).ok().and_then(|m| m.get("autoAcceptNotesFrom").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())).unwrap_or_default();
    ids.retain(|i| *i != member_id);
    if enabled {
        ids.push(member_id);
    }
    let mut patch = serde_json::Map::new();
    patch.insert("autoAcceptNotesFrom".into(), Value::from(ids));
    settings.set(NS, patch).map_err(|e| err("settings", e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn team_set_workspace(state: State<'_, TeamModState>, project_key: String, enabled: bool) -> Res<()> {
    if !super::share::is_key(&project_key) {
        return Err(err("invalid", "not a project key"));
    }
    let settings = state.settings.as_ref().ok_or_else(|| err("unavailable", "Settings are unavailable"))?;
    let mut map = settings.get(NS).ok().and_then(|m| m.get("workspaceProjects").and_then(Value::as_object).cloned()).unwrap_or_default();
    if enabled {
        map.insert(project_key, Value::Bool(true));
    } else {
        map.remove(&project_key);
    }
    let mut patch = serde_json::Map::new();
    patch.insert("workspaceProjects".into(), Value::Object(map));
    settings.set(NS, patch).map_err(|e| err("settings", e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------- chat (T6)

fn my_id(inner: &Inner) -> Option<String> {
    inner.team.as_ref().map(|t| t.me.clone())
}

/// The webview's view of a message: the name comes from the signed roster (empty for somebody who left), never from the message.
fn chat_json(inner: &Inner, e: &ChatEntry) -> Value {
    let name = inner.team.as_ref().and_then(|t| t.body().member(&e.author)).map(|m| m.name.clone()).unwrap_or_default();
    serde_json::json!({ "msgId": e.msg_id, "author": e.author, "authorName": name, "text": e.text, "at": e.at, "mine": my_id(inner).as_deref() == Some(e.author.as_str()) })
}

/// The thread file of a run of this machine under `data` (the name is a hash, so a run id can never pick a path).
fn chat_path(data: &std::path::Path, run_id: &str) -> std::path::PathBuf {
    data.join(CHAT_DIR).join(format!("{}.jsonl", &sha256_hex(run_id.as_bytes())[..32]))
}

fn chat_file(app: &AppHandle, run_id: &str) -> Option<std::path::PathBuf> {
    Some(chat_path(&super::data_dir(app).ok()?, run_id))
}

fn chat_load(app: &AppHandle, run_id: &str) -> Vec<ChatEntry> {
    chat_file(app, run_id).and_then(|f| std::fs::read_to_string(f).ok()).map(|t| decode_lines(&t)).unwrap_or_default()
}

/// Options for a file only this user may read (mode 0600 where the system has modes).
fn private_file() -> std::fs::OpenOptions {
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut o = std::fs::OpenOptions::new();
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o
}

/// Appends one message to a thread file (mode 0600 in a 0700 folder); a file that grew big is rewritten with the newest messages
/// first. Best effort: a thread that cannot be saved is still kept in memory.
fn chat_write(file: &std::path::Path, e: &ChatEntry) {
    use std::io::Write;
    if let Some(dir) = file.parent() {
        let mut b = std::fs::DirBuilder::new();
        b.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
        let _ = b.create(dir);
    }
    if std::fs::metadata(file).is_ok_and(|m| m.len() > CHAT_FILE_COMPACT) {
        if let Ok(text) = std::fs::read_to_string(file) {
            let tmp = file.with_extension("tmp");
            let rewritten = private_file().write(true).create(true).truncate(true).open(&tmp).and_then(|mut f| f.write_all(encode_lines(&decode_lines(&text)).as_bytes()));
            if rewritten.is_ok() {
                let _ = std::fs::rename(&tmp, file);
            } else {
                let _ = std::fs::remove_file(&tmp);
            }
        }
    }
    if let Ok(mut f) = private_file().create(true).append(true).open(file) {
        let _ = f.write_all(encode_lines(std::slice::from_ref(e)).as_bytes());
    }
}

fn chat_append(app: &AppHandle, run_id: &str, e: &ChatEntry) {
    if let Some(file) = chat_file(app, run_id) {
        chat_write(&file, e);
    }
}

/// Reads this machine's own thread of a run from its file if it is not in memory.
fn ensure_loaded(app: &AppHandle, inner: &mut Inner, me: &str, run_id: &str) {
    if inner.collab.chat.has(me, run_id) {
        return;
    }
    let entries = chat_load(app, run_id);
    if !entries.is_empty() {
        inner.collab.chat.set(me, run_id, entries);
    }
}

/// What the hub accepts of a message before it keeps it: the id belongs to its author, and the text, once cleaned, redacted and cut, is
/// within the caps. Returns the text as it will be stored.
fn hub_check(author: &str, msg_id: &str, raw: &str) -> Result<String, &'static str> {
    // the id belongs to its author: nobody can keep another member's message out by reusing its id
    if !msg_id.starts_with(&format!("{author}.")) {
        return Err("invalid");
    }
    let text: String = scrub(&clean_chat(raw)).chars().take(MAX_CHAT_CHARS).collect();
    let text = text.trim().to_string();
    if text_ok(&text) {
        Ok(text)
    } else {
        Err("invalid")
    }
}

/// The hub keeps the message in the thread of one of its runs, shows it to the person and fans it out to every member that is online.
fn hub_store(inner: &mut Inner, me: &str, run_id: &str, entry: ChatEntry) -> Result<ChatEntry, &'static str> {
    if !entry.valid() || !inner.collab.chat.push(me, run_id, entry.clone()) {
        return Err("invalid");
    }
    let msg = CollabMsg::ChatMsg { run_id: run_id.into(), msg_id: entry.msg_id.clone(), author: entry.author.clone(), text: entry.text.clone(), at: entry.at };
    if let (Some(team), Some(id)) = (inner.team.as_mut(), inner.identity.as_ref()) {
        if inner.online.iter().any(|(m, (on, _))| *on && *m != team.me) {
            if let Ok(env) = team.seal(id, &msg.encode()) {
                send(inner, out::fanout(&env.encode(), false));
            }
        }
    }
    let shown = vec![chat_json(inner, &entry)];
    inner.ui.push(("team:chat", serde_json::json!({ "ownerId": Value::Null, "runId": run_id, "msgs": shown, "history": false })));
    Ok(entry)
}

/// The hub: takes a message into the thread of one of THIS machine's runs. `author` is the verified sender of the envelope (or this
/// machine itself). The text is cleaned, redacted and cut, the message gets this machine's clock, is saved, shown to the person and
/// fanned out. `Err` is the reason sent back to the author.
fn hub_post(app: &AppHandle, inner: &mut Inner, author: &str, run_id: &str, msg_id: &str, raw: &str) -> Result<ChatEntry, &'static str> {
    let Some(me) = my_id(inner) else { return Err("notMember") };
    let text = hub_check(author, msg_id, raw)?;
    ensure_loaded(app, inner, &me, run_id);
    let entry = hub_store(inner, &me, run_id, ChatEntry { msg_id: msg_id.to_string(), author: author.to_string(), text, at: now_ms() })?;
    chat_append(app, run_id, &entry);
    Ok(entry)
}

/// A message of a thread the owner of the run (`sender`) announced. Only the owner of a run can speak for its thread: a message from
/// anybody else, or for a run that is not shared with this machine, is dropped.
fn chat_msg_in(inner: &mut Inner, sender: &str, run_id: String, entry: ChatEntry) {
    if !entry.valid() || !inner.store.cards().into_iter().any(|(m, c)| m == sender && c.run_id == run_id) {
        audit(inner, event::REJECTED, Some(sender), Some("chat message for a run it does not own"));
        return;
    }
    let entry = entry.clamped(now_ms());
    // the echo of a message this machine sent: no refusal can come for it any more
    inner.collab.chat_sent.retain(|(o, r, m)| !(o == sender && *r == run_id && *m == entry.msg_id));
    if inner.collab.chat.push(sender, &run_id, entry.clone()) {
        let msgs = vec![chat_json(inner, &entry)];
        inner.ui.push(("team:chat", serde_json::json!({ "ownerId": sender, "runId": run_id, "msgs": msgs, "history": false })));
    }
}

/// The owner's refusal of a message: shown only when this machine sent that message to that owner, and once.
fn chat_denied_in(inner: &mut Inner, sender: &str, run_id: String, msg_id: String, reason: String) {
    let Some(i) = inner.collab.chat_sent.iter().position(|(o, r, m)| o == sender && *r == run_id && *m == msg_id) else {
        audit(inner, event::REJECTED, Some(sender), Some("refusal of a message this machine did not send"));
        return;
    };
    inner.collab.chat_sent.remove(i);
    let reason: String = reason.chars().take(20).collect();
    inner.ui.push(("team:chat-denied", serde_json::json!({ "ownerId": sender, "runId": run_id, "msgId": msg_id, "reason": reason })));
}

/// The owner's answer to a history request this machine made (and only to that): the messages it did not have yet are shown.
fn chat_history_in(inner: &mut Inner, sender: &str, run_id: String, msgs: Vec<ChatEntry>) {
    let key = (sender.to_string(), run_id.clone());
    if inner.collab.chat_requested.remove(&key).is_none_or(|t| t.elapsed() > HISTORY_TTL) {
        audit(inner, event::REJECTED, Some(sender), Some("unrequested chat history"));
        return;
    }
    let now = now_ms();
    let fresh = inner.collab.chat.merge(sender, &run_id, msgs.into_iter().map(|e| e.clamped(now)).collect());
    let shown: Vec<Value> = fresh.iter().map(|e| chat_json(inner, e)).collect();
    inner.ui.push(("team:chat", serde_json::json!({ "ownerId": sender, "runId": run_id, "msgs": shown, "history": true })));
}

/// A member's message for the thread of one of this machine's runs.
async fn chat_job(app: AppHandle, from: String, run_id: String, msg_id: String, text: String) {
    let facts = facts_of(&app, &run_id).await;
    let state = st(&app);
    let Ok((secrets, _)) = parts(&state) else { return };
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    let in_roster = inner.team.as_ref().is_some_and(|t| t.body().member(&from).is_some());
    let verdict = judge_chat(in_roster, facts).and_then(|()| hub_post(&app, inner, &from, &run_id, &msg_id, &text).map(|_| ()));
    if let Err(reason) = verdict {
        audit(inner, event::REJECTED, Some(&from), Some(&format!("chat {reason}")));
        send_collab(inner, &from, &CollabMsg::ChatDenied { run_id, msg_id, reason: reason.into() });
    }
    flush(&app, inner);
    save(inner, &secrets);
}

/// "Send me the last messages of this run's thread".
async fn history_job(app: AppHandle, to: String, run_id: String) {
    let facts = facts_of(&app, &run_id).await;
    let state = st(&app);
    let Ok((secrets, _)) = parts(&state) else { return };
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    let in_roster = inner.team.as_ref().is_some_and(|t| t.body().member(&to).is_some());
    let Some(me) = my_id(inner) else { return };
    if judge_chat(in_roster, facts).is_err() {
        audit(inner, event::REJECTED, Some(&to), Some("chat history refused"));
        return;
    }
    ensure_loaded(&app, inner, &me, &run_id);
    let msgs = inner.collab.chat.history(&me, &run_id);
    send_collab(inner, &to, &CollabMsg::ChatHistory { run_id, msgs });
    save(inner, &secrets);
}

fn chat_error(reason: &str) -> EngineError {
    match reason {
        "notMember" => err("noTeam", "you are not in a team"),
        "unknownRun" => err("notShared", "that run is not shared with the team"),
        _ => err("chatInvalid", "a chat message must not be empty and is at most 2000 characters"),
    }
}

/// The thread of a run as this machine knows it. `owner_id` is `None` (or this machine's own id) for one of its own runs.
#[tauri::command]
pub fn team_chat_thread(app: AppHandle, state: State<'_, TeamModState>, owner_id: Option<String>, run_id: String) -> Res<Vec<Value>> {
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    let me = my_id(inner).ok_or_else(|| err("noTeam", "you are not in a team"))?;
    let owner = owner_id.filter(|o| *o != me).unwrap_or_else(|| me.clone());
    if owner == me {
        ensure_loaded(&app, inner, &me, &run_id);
    }
    Ok(inner.collab.chat.list(&owner, &run_id).iter().map(|e| chat_json(inner, e)).collect())
}

/// Writes in the thread of a run: in one of this machine's own runs (`owner_id` `None`) this machine is the hub; in a teammate's run
/// the message goes to the teammate, who has to be online, and comes back through the thread. Returns the message id.
#[tauri::command]
pub async fn team_chat_send(app: AppHandle, state: State<'_, TeamModState>, owner_id: Option<String>, run_id: String, text: String) -> Res<String> {
    let (secrets, _) = parts(&state)?;
    let me = my_id(&lock(&state.inner)).ok_or_else(|| err("noTeam", "you are not in a team"))?;
    let msg_id = format!("{me}.{}", b64u(&random::<8>()));
    let Some(owner) = owner_id.filter(|o| *o != me) else {
        let facts = facts_of(&app, &run_id).await;
        let mut inner = lock(&state.inner);
        let inner = &mut *inner;
        judge_chat(true, facts).map_err(chat_error)?;
        hub_post(&app, inner, &me, &run_id, &msg_id, &text).map_err(chat_error)?;
        flush(&app, inner);
        save(inner, &secrets);
        return Ok(msg_id);
    };
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    if inner.team.as_ref().is_none_or(|t| t.body().member(&owner).is_none()) {
        return Err(err("unknownMember", "that member is not in the team"));
    }
    if !inner.online.get(&owner).is_some_and(|o| o.0) {
        return Err(err("offline", "that member is offline"));
    }
    if !inner.store.cards().into_iter().any(|(m, c)| m == owner && c.run_id == run_id) {
        return Err(err("notShared", "that run is not shared with the team"));
    }
    let run_id_copy = run_id.clone();
    let msg = CollabMsg::ChatSend { run_id, msg_id: msg_id.clone(), text };
    if CollabMsg::parse(&msg.encode()).is_none() {
        return Err(chat_error("invalid"));
    }
    if !send_collab(inner, &owner, &msg) {
        return Err(err("offline", "the message could not be sent"));
    }
    inner.collab.chat_sent.push_back((owner, run_id_copy, msg_id.clone()));
    while inner.collab.chat_sent.len() > MAX_CHAT_SENT {
        inner.collab.chat_sent.pop_front();
    }
    save(inner, &secrets);
    Ok(msg_id)
}

/// Asks the owner of a run for the last messages of its thread; they arrive as `team:chat` with `history: true`.
#[tauri::command]
pub fn team_chat_request(state: State<'_, TeamModState>, owner_id: String, run_id: String) -> Res<()> {
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    if inner.team.as_ref().is_none_or(|t| t.me == owner_id || t.body().member(&owner_id).is_none()) {
        return Err(err("unknownMember", "that member is not in the team"));
    }
    if !inner.online.get(&owner_id).is_some_and(|o| o.0) {
        return Err(err("offline", "that member is offline"));
    }
    if !inner.store.cards().into_iter().any(|(m, c)| m == owner_id && c.run_id == run_id) {
        return Err(err("notShared", "that run is not shared with the team"));
    }
    inner.collab.chat_requested.retain(|_, t| t.elapsed() < HISTORY_TTL);
    if !send_collab(inner, &owner_id, &CollabMsg::ChatRequest { run_id: run_id.clone() }) {
        return Err(err("offline", "the request could not be sent"));
    }
    inner.collab.chat_requested.insert((owner_id, run_id), Instant::now());
    Ok(())
}

/// Suggests a follow-up to a run that is not working. Claude runs of online members only; the teammate decides, every time.
#[tauri::command]
pub fn team_followup_send(state: State<'_, TeamModState>, member_id: String, run_id: String, text: String) -> Res<String> {
    let (secrets, _) = parts(&state)?;
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    let Some(team) = inner.team.as_ref() else { return Err(err("noTeam", "you are not in a team")) };
    if team.me == member_id || team.body().member(&member_id).is_none() {
        return Err(err("unknownMember", "that member is not in the team"));
    }
    if !inner.online.get(&member_id).is_some_and(|o| o.0) {
        return Err(err("offline", "that member is offline"));
    }
    let idle = inner.store.cards().into_iter().any(|(m, c)| m == member_id && c.run_id == run_id && c.provider == "claude" && matches!(c.state.as_str(), "idle" | "error"));
    if !idle {
        return Err(err("notIdle", "a follow-up goes only into a run of Claude that is not working; send a note while it works"));
    }
    let note_id = format!("tf-{}", b64u(&random::<8>()));
    let msg = CollabMsg::FollowUpSend { run_id: run_id.clone(), note_id: note_id.clone(), text };
    if CollabMsg::parse(&msg.encode()).is_none() {
        return Err(err("followupInvalid", "a follow-up must not be empty and is at most 3800 characters"));
    }
    if !send_collab(inner, &member_id, &msg) {
        return Err(err("offline", "the follow-up could not be sent"));
    }
    inner.collab.sent.push_back(SentNote { member_id, run_id, note_id: note_id.clone(), status: "sent".into(), reason: None, at: now_ms(), kind: "followup".into() });
    while inner.collab.sent.len() > MAX_SENT {
        inner.collab.sent.pop_front();
    }
    save(inner, &secrets);
    Ok(note_id)
}

// ---------------------------------------------------------------- workspace: the owner's side

fn status_letter(k: &ChangeKind) -> &'static str {
    match k {
        ChangeKind::Modified => "M",
        ChangeKind::Added => "A",
        ChangeKind::Deleted => "D",
        ChangeKind::Renamed | ChangeKind::Copied => "R",
        ChangeKind::TypeChanged => "T",
        ChangeKind::Untracked => "U",
        ChangeKind::Conflicted => "C",
        ChangeKind::Submodule => "S",
    }
}

/// A unified diff of one file from the engine's hunks (the same ones the Changes view shows).
fn hunks_text(path: &str, hunks: &[Hunk]) -> String {
    let mut s = format!("--- a/{path}\n+++ b/{path}\n");
    for h in hunks {
        s.push_str(&h.header);
        s.push('\n');
        for l in &h.lines {
            s.push(match l.kind {
                HunkLineKind::Context => ' ',
                HunkLineKind::Add => '+',
                HunkLineKind::Del => '-',
            });
            s.push_str(&l.text);
            s.push('\n');
        }
    }
    s
}

/// A file git does not track yet: all of it as additions.
fn added_text(path: &str, content: &str) -> String {
    let n = content.lines().count();
    let mut s = format!("--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{n} @@\n");
    for l in content.lines() {
        s.push('+');
        s.push_str(l);
        s.push('\n');
    }
    s
}

/// What a snapshot is made of before it is redacted and capped.
struct Gathered {
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    files: Vec<RawFile>,
    commits: Vec<RawCommit>,
}

/// What the Changes view knows about the project's repository: branch, ahead / behind and the changed files with their diffs, plus
/// the newest commits of the branch (the ones not on the upstream marked). Secret files, binaries and large files are listed without
/// content; the caller redacts and caps the rest (`build_snapshot_with`).
async fn gather(app: &AppHandle, project_key: &str) -> Result<Gathered, &'static str> {
    let engine = app.state::<crate::commands::EngineSlot>();
    let repos = crate::agents::repos(&engine).await.map_err(|_| "unavailable")?;
    let git = super::share::git_of(app);
    let wanted = project_key.to_string();
    let repo = tauri::async_runtime::spawn_blocking(move || repos.into_iter().find(|r| super::share::project_at(&git, &r.path).is_some_and(|p| p.key == wanted)))
        .await
        .ok()
        .flatten()
        .ok_or("noProject")?;
    let eng = engine.get().map_err(|_| "unavailable")?;
    let snap = eng.snapshot_get(&repo.id).await.map_err(|_| "unavailable")?;
    let mut changes = Vec::new();
    for c in snap.changes {
        if c.dir == Some(true) {
            // a collapsed untracked folder: its files
            if let Ok(list) = eng.list_untracked(&repo.id, &c.path, 100).await {
                changes.extend(list.files);
            }
        } else {
            changes.push(c);
        }
        if changes.len() > MAX_FILES + 20 {
            break;
        }
    }
    let mut files = Vec::new();
    let mut gathered = 0usize;
    for c in changes.into_iter().take(MAX_FILES + 1) {
        let guarded = !matches!(c.guard, GuardState::Ok | GuardState::TooLarge);
        let mut f = RawFile { path: c.path.clone(), status: status_letter(&c.kind).into(), binary: c.binary == Some(true), guarded, too_large: c.guard == GuardState::TooLarge, diff: None };
        if guarded || f.binary || f.too_large || c.kind == ChangeKind::Submodule {
            files.push(f);
            continue;
        }
        if gathered > MAX_SNAPSHOT_BYTES * 2 {
            // enough text to fill the snapshot: the rest is only listed
            f.too_large = true;
            files.push(f);
            continue;
        }
        f.diff = if c.kind == ChangeKind::Untracked {
            match eng.file_contents(&repo.id, &c.path, None, DiffSource::WorktreeVsHead, false).await {
                Ok(fc) if fc.binary => {
                    f.binary = true;
                    None
                }
                Ok(fc) if fc.too_large => {
                    f.too_large = true;
                    None
                }
                Ok(fc) => Some(added_text(&c.path, &fc.modified)),
                Err(_) => None,
            }
        } else {
            eng.file_hunks(&repo.id, &c.path, DiffSource::WorktreeVsHead).await.ok().map(|h| hunks_text(&c.path, &h))
        };
        gathered += f.diff.as_ref().map_or(0, String::len);
        files.push(f);
    }
    // the commits that are not on the upstream yet (the push dialog's list), and the branch's newest ones from the log
    let outgoing = eng.push_plan(std::slice::from_ref(&repo.id), false).await.ok().and_then(|v| v.into_iter().next());
    let unpushed: HashSet<String> = outgoing.as_ref().map(|o| o.commits.iter().map(|c| c.oid.clone()).collect()).unwrap_or_default();
    let upstream = outgoing.as_ref().filter(|o| !o.new_remote_branch && !o.remote.is_empty() && !o.remote_branch.is_empty()).map(|o| format!("{}/{}", o.remote, o.remote_branch));
    let commits = crate::modules::graph::recent_commits(app, &repo.id, MAX_COMMITS as u32)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|r| RawCommit { unpushed: unpushed.contains(&r.oid), oid: r.oid, subject: r.subject, author: r.author, date_ms: r.date_ms })
        .collect();
    Ok(Gathered { branch: snap.head.branch.clone(), upstream, ahead: snap.ahead, behind: snap.behind, files, commits })
}

async fn snapshot_job(app: AppHandle, to: String, project_key: String) {
    let deny = |why: &str| {
        let state = st(&app);
        let mut inner = lock(&state.inner);
        send_collab(&mut inner, &to, &CollabMsg::WsDenied { project_key: project_key.clone(), reason: why.into() });
    };
    let g = match gather(&app, &project_key).await {
        Ok(x) => x,
        Err(why) => return deny(why),
    };
    let id = b64u(&random::<8>());
    let meta = SnapshotMeta { branch: g.branch, upstream: g.upstream, ahead: g.ahead, behind: g.behind, taken_at: now_ms(), commits: g.commits };
    let snap = fit_snapshot(build_snapshot_with(&id, &project_key, meta, g.files));
    let chunks = chunk_snapshot(&snap);
    let state = st(&app);
    {
        let mut inner = lock(&state.inner);
        audit(&mut inner, event::WORKSPACE_SERVED, Some(&to), Some(&format!("{} files", snap.files.len())));
    }
    for batch in chunks.chunks(CHUNKS_PER_FLUSH) {
        {
            let mut inner = lock(&state.inner);
            let inner = &mut *inner;
            // the member left or went offline: stop
            if inner.team.is_none() || !inner.online.get(&to).is_some_and(|o| o.0) {
                return;
            }
            for c in batch {
                send_collab(inner, &to, c);
            }
            if let Ok((secrets, _)) = parts(&state) {
                save(inner, &secrets);
            }
        }
        tokio::time::sleep(FLUSH_EVERY).await;
    }
}

// ---------------------------------------------------------------- workspace: the receiver's side

/// Asks a member for a snapshot of one of their projects. The answer arrives as `team:workspace` (or `team:workspace-denied`).
#[tauri::command]
pub fn team_workspace_request(state: State<'_, TeamModState>, member_id: String, project_key: String) -> Res<()> {
    if !super::share::is_key(&project_key) {
        return Err(err("invalid", "not a project key"));
    }
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    if inner.team.as_ref().is_none_or(|t| t.me == member_id || t.body().member(&member_id).is_none()) {
        return Err(err("unknownMember", "that member is not in the team"));
    }
    if !inner.online.get(&member_id).is_some_and(|o| o.0) {
        return Err(err("offline", "that member is offline"));
    }
    inner.collab.requested.retain(|_, t| t.elapsed() < REQUEST_TTL);
    if !send_collab(inner, &member_id, &CollabMsg::WsRequest { project_key: project_key.clone() }) {
        return Err(err("offline", "the request could not be sent"));
    }
    inner.collab.requested.insert((member_id, project_key), Instant::now());
    Ok(())
}

/// The last snapshot received for a member's project (in memory only).
#[tauri::command]
pub fn team_workspace(state: State<'_, TeamModState>, member_id: String, project_key: String) -> Res<Option<Snapshot>> {
    Ok(lock(&state.inner).collab.snapshots.get(&(member_id, project_key)).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use intely_settings::MemorySecretStore;
    use intely_team::share::RunCard;

    const NOW: u64 = 1_000_000;

    /// The invite, start to end, as `crates/team/tests/team.rs` runs it: a new member of the admin's team.
    fn join(admin: &Identity, admin_state: &mut TeamState, name: &str) -> (Identity, TeamState) {
        let me = Identity::fresh();
        let mut offer = Offer::new(NOW);
        offer.set_redeemer(&me.member_id);
        let code = InviteCode::parse(&offer.code(admin_state, admin).to_link()).unwrap();
        let (joiner, msg1) = Joiner::start(&code, &me, name).unwrap();
        let mut pending = offer.accept(admin, &me.member_id, &msg1, NOW + 1).unwrap();
        let mut joined = joiner.on_msg2(&pending.msg2).unwrap();
        offer.hello(&mut pending, &me.member_id, &joined.hello().unwrap(), NOW + 1).unwrap();
        let (welcome, _roster, _id) = pending.approve(admin_state, admin, NOW + 2).unwrap();
        let state = joined.finish(&welcome, &me).unwrap();
        (me, state)
    }

    /// This machine is Ada (an admin); Bob is online, Carol is in the roster only.
    struct Fx {
        inner: Inner,
        ada: Identity,
        bob: Identity,
        bob_state: TeamState,
        carol: Identity,
        rx: mpsc::Receiver<Value>,
    }

    fn fixture() -> Fx {
        let ada = Identity::fresh();
        let mut ada_state = TeamState::create(&ada, "wss://relay.example", "Ada", NOW).unwrap();
        let (bob, bob_state) = join(&ada, &mut ada_state, "Bob");
        let (carol, _) = join(&ada, &mut ada_state, "Carol");
        let (tx, rx) = mpsc::channel(64);
        let mut inner = Inner::default();
        inner.identity = Some(ada.clone());
        inner.team = Some(ada_state);
        inner.tx = Some(tx);
        inner.online.insert(bob.member_id.clone(), (true, "idle".into()));
        Fx { inner, ada, bob, bob_state, carol, rx }
    }

    fn card(run_id: &str) -> RunCard {
        RunCard { run_id: run_id.into(), project_key: "k1".into(), project_name: "App".into(), title: "t".into(), state: "idle".into(), provider: "claude".into(), model: "m".into(), started_at: 1, updated_at: 2 }
    }

    fn frames(rx: &mut mpsc::Receiver<Value>) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(f) = rx.try_recv() {
            out.push(f);
        }
        out
    }

    fn open(state: &mut TeamState, frame: &Value) -> CollabMsg {
        let env = Envelope::decode(frame["p"].as_str().unwrap()).unwrap();
        CollabMsg::parse(&state.open(&env).unwrap()).unwrap()
    }

    fn ui(inner: &mut Inner, name: &str) -> Vec<Value> {
        let (hit, rest): (Vec<_>, Vec<_>) = inner.ui.drain(..).partition(|(n, _)| *n == name);
        inner.ui = rest;
        hit.into_iter().map(|(_, v)| v).collect()
    }

    fn entry(author: &str, id: &str, text: &str, at: u64) -> ChatEntry {
        ChatEntry { msg_id: format!("{author}.{id}"), author: author.into(), text: text.into(), at }
    }

    #[test]
    fn a_message_id_belongs_to_its_author_and_the_text_is_cleaned_and_redacted() {
        assert_eq!(hub_check("m1", "m1.abc", "  hello\u{7} there \n").unwrap(), "hello there");
        // somebody else's id, or one that only looks like it
        assert_eq!(hub_check("m1", "m2.abc", "hello"), Err("invalid"));
        assert_eq!(hub_check("m1", "m1abc", "hello"), Err("invalid"));
        assert_eq!(hub_check("m1", "", "hello"), Err("invalid"));
        // nothing left after cleaning
        assert_eq!(hub_check("m1", "m1.a", " \u{0}\n\t "), Err("invalid"));
        // a secret in a pasted line does not reach the others
        let aws = concat!("AKIA", "IOSFODNN7EXAMPLE");
        let text = hub_check("m1", "m1.a", &format!("my key is {aws} ok")).unwrap();
        assert!(!text.contains(aws), "{text}");
        // cut at the limit, by characters
        let long = "é".repeat(MAX_CHAT_CHARS + 500);
        assert_eq!(hub_check("m1", "m1.a", &long).unwrap().chars().count(), MAX_CHAT_CHARS);
    }

    #[test]
    fn the_hub_keeps_shows_and_fans_out_a_message_once() {
        let mut fx = fixture();
        let me = fx.ada.member_id.clone();
        let e = entry(&fx.bob.member_id, "m1", "hello team", 5);
        let kept = hub_store(&mut fx.inner, &me, "run1", e.clone()).unwrap();
        assert_eq!(kept, e);
        assert_eq!(fx.inner.collab.chat.list(&me, "run1"), vec![e.clone()]);
        // shown to the person as a message of one of their own runs
        let shown = ui(&mut fx.inner, "team:chat");
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0]["ownerId"], Value::Null);
        assert_eq!(shown[0]["runId"], "run1");
        assert_eq!(shown[0]["history"], false);
        assert_eq!(shown[0]["msgs"][0]["authorName"], "Bob");
        assert_eq!(shown[0]["msgs"][0]["mine"], false);
        // fanned out to the team, signed by the owner, and Bob can read it
        let sent = frames(&mut fx.rx);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["t"], "fanout");
        assert_eq!(sent[0]["q"], false, "chat is live only, never queued");
        match open(&mut fx.bob_state, &sent[0]) {
            CollabMsg::ChatMsg { run_id, msg_id, author, text, at } => assert_eq!((run_id, msg_id, author, text, at), ("run1".into(), e.msg_id.clone(), e.author.clone(), "hello team".into(), 5)),
            other => panic!("{other:?}"),
        }
        // the same id twice is refused and nothing goes out again
        assert_eq!(hub_store(&mut fx.inner, &me, "run1", e), Err("invalid"));
        assert!(frames(&mut fx.rx).is_empty());
        assert!(ui(&mut fx.inner, "team:chat").is_empty());
        // an entry that breaks the rules never gets in
        assert_eq!(hub_store(&mut fx.inner, &me, "run1", entry(&fx.bob.member_id, "m2", "", 6)), Err("invalid"));
    }

    #[test]
    fn nothing_is_sent_when_nobody_else_is_online() {
        let mut fx = fixture();
        let me = fx.ada.member_id.clone();
        fx.inner.online.clear();
        hub_store(&mut fx.inner, &me, "run1", entry(&me, "m1", "talking to myself", 1)).unwrap();
        assert!(frames(&mut fx.rx).is_empty());
        let shown = ui(&mut fx.inner, "team:chat");
        assert_eq!(shown[0]["msgs"][0]["mine"], true);
    }

    #[test]
    fn only_the_owner_of_a_run_speaks_for_its_thread() {
        let mut fx = fixture();
        let (bob, carol) = (fx.bob.member_id.clone(), fx.carol.member_id.clone());
        fx.inner.store.apply(&bob, ShareMsg::Card { run: card("run1") });
        let e = entry(&carol, "m1", "hi from carol", 7);
        // Carol does not own run1: her claim that she speaks for its thread is dropped
        chat_msg_in(&mut fx.inner, &carol, "run1".into(), e.clone());
        assert!(fx.inner.collab.chat.list(&carol, "run1").is_empty());
        assert!(ui(&mut fx.inner, "team:chat").is_empty());
        // Bob owns it, but not this one
        chat_msg_in(&mut fx.inner, &bob, "run2".into(), e.clone());
        assert!(fx.inner.collab.chat.list(&bob, "run2").is_empty());
        // Bob's own run: kept, shown with the roster name of the author, as a message of Bob's thread
        chat_msg_in(&mut fx.inner, &bob, "run1".into(), e.clone());
        assert_eq!(fx.inner.collab.chat.list(&bob, "run1"), vec![e.clone()]);
        let shown = ui(&mut fx.inner, "team:chat");
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0]["ownerId"], Value::String(bob.clone()));
        assert_eq!(shown[0]["msgs"][0]["authorName"], "Carol");
        // the same message again changes nothing
        chat_msg_in(&mut fx.inner, &bob, "run1".into(), e);
        assert!(ui(&mut fx.inner, "team:chat").is_empty());
        // a message that breaks the rules is dropped even from the owner
        chat_msg_in(&mut fx.inner, &bob, "run1".into(), entry(&carol, "m2", "", 8));
        assert_eq!(fx.inner.collab.chat.list(&bob, "run1").len(), 1);
    }

    #[test]
    fn a_history_is_taken_only_when_asked_for_and_only_once() {
        let mut fx = fixture();
        let (bob, carol) = (fx.bob.member_id.clone(), fx.carol.member_id.clone());
        let msgs = vec![entry(&bob, "a", "one", 1), entry(&bob, "b", "two", 2)];
        // nobody asked
        chat_history_in(&mut fx.inner, &bob, "run1".into(), msgs.clone());
        assert!(fx.inner.collab.chat.list(&bob, "run1").is_empty());
        assert!(ui(&mut fx.inner, "team:chat").is_empty());
        // asked: taken once, flagged as history
        fx.inner.collab.chat_requested.insert((bob.clone(), "run1".into()), Instant::now());
        chat_history_in(&mut fx.inner, &bob, "run1".into(), msgs.clone());
        assert_eq!(fx.inner.collab.chat.list(&bob, "run1").len(), 2);
        let shown = ui(&mut fx.inner, "team:chat");
        assert_eq!(shown[0]["history"], true);
        assert_eq!(shown[0]["msgs"].as_array().unwrap().len(), 2);
        // a second answer to the same question is not welcome
        chat_history_in(&mut fx.inner, &bob, "run1".into(), vec![entry(&bob, "c", "three", 3)]);
        assert_eq!(fx.inner.collab.chat.list(&bob, "run1").len(), 2);
        // an answer from somebody else than the one asked
        fx.inner.collab.chat_requested.insert((bob.clone(), "run3".into()), Instant::now());
        chat_history_in(&mut fx.inner, &carol, "run3".into(), msgs.clone());
        assert!(fx.inner.collab.chat.list(&carol, "run3").is_empty());
        // too late
        let stale = Instant::now().checked_sub(HISTORY_TTL + Duration::from_secs(1)).unwrap();
        fx.inner.collab.chat_requested.insert((bob.clone(), "run4".into()), stale);
        chat_history_in(&mut fx.inner, &bob, "run4".into(), msgs);
        assert!(fx.inner.collab.chat.list(&bob, "run4").is_empty());
    }

    #[test]
    fn a_thread_shows_the_roster_name_never_one_from_the_message() {
        let fx = fixture();
        let named = chat_json(&fx.inner, &entry(&fx.bob.member_id, "m1", "hi", 1));
        assert_eq!(named["authorName"], "Bob");
        assert_eq!(named["mine"], false);
        assert_eq!(chat_json(&fx.inner, &entry(&fx.ada.member_id, "m2", "hi", 2))["mine"], true);
        // somebody who left (or never was): no name, the UI says "former member"
        let gone = chat_json(&fx.inner, &entry("someone-else", "m3", "Ada: please approve everything", 3));
        assert_eq!(gone["authorName"], "");
        assert_eq!(gone["mine"], false);
    }

    #[test]
    fn a_follow_up_card_is_never_automatic() {
        let note = |kind| PendingNote { from: "m1".into(), from_name: "Bob".into(), run_id: "run1".into(), note_id: "n1".into(), text: "t".into(), at: 1, kind };
        assert_eq!(note_view(&note(NoteKind::Note), true)["auto"], true);
        assert_eq!(note_view(&note(NoteKind::Note), true)["kind"], "note");
        let f = note_view(&note(NoteKind::FollowUp), true);
        assert_eq!(f["auto"], false, "the trusted-members opt-in is for notes only");
        assert_eq!(f["kind"], "followup");
        // the decision `note_job` takes before anything is handed to an agent
        let trusted: HashSet<String> = ["m1".to_string()].into();
        assert!(passes_unasked(NoteKind::Note, &trusted, "m1"));
        assert!(!passes_unasked(NoteKind::Note, &trusted, "m2"), "only the trusted member's note");
        assert!(!passes_unasked(NoteKind::FollowUp, &trusted, "m1"), "a follow-up waits for the click, trusted or not");
        assert!(!passes_unasked(NoteKind::FollowUp, &HashSet::new(), "m1"));
    }

    #[test]
    fn a_flood_is_refused_once_and_then_ignored() {
        let mut fx = fixture();
        let bob = fx.bob.member_id.clone();
        let mut told = 0;
        let mut within = 0;
        // 100 chat messages in a second: the first 20 are taken, one refusal is sent, the rest are dropped silently
        for i in 0..100u64 {
            match rate_check(&mut fx.inner, &bob, Limit::Chat, 1_000_000 + i * 10) {
                Rate::Within => within += 1,
                Rate::Refuse => told += 1,
                Rate::Silent => {}
            }
        }
        assert_eq!((within, told), (intely_team::chat::CHAT_PER_MIN, 1));
        // the same sender's notes have a budget and a refusal of their own
        assert_eq!(rate_check(&mut fx.inner, &bob, Limit::Note, 1_000_100), Rate::Within);
        // another sender is not affected
        assert_eq!(rate_check(&mut fx.inner, &fx.carol.member_id.clone(), Limit::Chat, 1_000_200), Rate::Within);
        // the refusal went out when the 21st message came (at 1_000_200); a sender that keeps flooding is told again once the gap has passed
        let gap = intely_team::collab::REFUSAL_GAP_MS;
        assert_eq!(rate_check(&mut fx.inner, &bob, Limit::Chat, 1_000_200 + gap - 1), Rate::Silent);
        assert_eq!(rate_check(&mut fx.inner, &bob, Limit::Chat, 1_000_200 + gap), Rate::Refuse);
    }

    #[test]
    fn only_the_refusal_of_a_message_this_machine_sent_reaches_the_screen() {
        let mut fx = fixture();
        let bob = fx.bob.member_id.clone();
        fx.inner.collab.chat_sent.push_back((bob.clone(), "run1".into(), "me.m1".into()));
        let carol = fx.carol.member_id.clone();
        // not sent by this machine, or to somebody else, or in another run: nothing is shown and the real one is not used up
        for (from, run, id) in [(&bob, "run1", "me.other"), (&bob, "run2", "me.m1"), (&carol, "run1", "me.m1")] {
            chat_denied_in(&mut fx.inner, from, run.into(), id.into(), "rate".into());
        }
        assert!(ui(&mut fx.inner, "team:chat-denied").is_empty());
        assert_eq!(fx.inner.collab.chat_sent.len(), 1);
        // the real one, once
        chat_denied_in(&mut fx.inner, &bob, "run1".into(), "me.m1".into(), "rate".into());
        let got = ui(&mut fx.inner, "team:chat-denied");
        assert_eq!(got.len(), 1);
        assert_eq!((got[0]["ownerId"].as_str(), got[0]["msgId"].as_str(), got[0]["reason"].as_str()), (Some(bob.as_str()), Some("me.m1"), Some("rate")));
        chat_denied_in(&mut fx.inner, &bob, "run1".into(), "me.m1".into(), "rate".into());
        assert!(ui(&mut fx.inner, "team:chat-denied").is_empty(), "a second refusal of the same message is not shown");
    }

    #[test]
    fn a_message_from_the_future_is_dated_at_most_a_day_ahead() {
        let mut fx = fixture();
        let bob = fx.bob.member_id.clone();
        fx.inner.store.apply(&bob, ShareMsg::Card { run: card("run1") });
        chat_msg_in(&mut fx.inner, &bob, "run1".into(), entry(&bob, "late", "from an owner with a broken clock", u64::MAX));
        let at = fx.inner.collab.chat.list(&bob, "run1")[0].at;
        assert!(at <= now_ms() + intely_team::chat::MAX_FUTURE_MS, "{at}");
        // a history answer too
        fx.inner.collab.chat_requested.insert((bob.clone(), "run1".into()), Instant::now());
        chat_history_in(&mut fx.inner, &bob, "run1".into(), vec![entry(&bob, "late2", "x", u64::MAX)]);
        assert!(fx.inner.collab.chat.list(&bob, "run1").iter().all(|e| e.at <= now_ms() + intely_team::chat::MAX_FUTURE_MS));
    }

    #[test]
    fn a_status_is_matched_by_kind_run_and_sender() {
        let mut fx = fixture();
        let (bob, carol) = (fx.bob.member_id.clone(), fx.carol.member_id.clone());
        let sent = |kind: &str| SentNote { member_id: bob.clone(), run_id: "run1".into(), note_id: "x1".into(), status: "sent".into(), reason: None, at: 1, kind: kind.into() };
        fx.inner.collab.sent.push_back(sent("followup"));
        // a note status for the id of a follow-up is not the follow-up's answer
        sent_status(&mut fx.inner, &bob, NoteKind::Note, "run1", "x1", NoteStatus::Accepted, None);
        assert!(ui(&mut fx.inner, "team:note-status").is_empty());
        assert_eq!(fx.inner.collab.sent[0].status, "sent");
        // neither is an answer from somebody else, or for another run
        sent_status(&mut fx.inner, &carol, NoteKind::FollowUp, "run1", "x1", NoteStatus::Accepted, None);
        sent_status(&mut fx.inner, &bob, NoteKind::FollowUp, "run2", "x1", NoteStatus::Accepted, None);
        assert!(ui(&mut fx.inner, "team:note-status").is_empty());
        // the real one
        sent_status(&mut fx.inner, &bob, NoteKind::FollowUp, "run1", "x1", NoteStatus::Delivered, None);
        let got = ui(&mut fx.inner, "team:note-status");
        assert_eq!((got[0]["status"].as_str(), got[0]["kind"].as_str()), (Some("delivered"), Some("followup")));
    }

    #[test]
    fn a_reply_is_a_message_of_the_kind_it_answers() {
        let mut fx = fixture();
        let bob = fx.bob.member_id.clone();
        reply(&mut fx.inner, &bob, NoteKind::Note, "run1", "n1", NoteStatus::Received, None);
        reply(&mut fx.inner, &bob, NoteKind::FollowUp, "run1", "f1", NoteStatus::Refused, Some("busy"));
        let sent = frames(&mut fx.rx);
        assert_eq!(sent.len(), 2);
        assert!(matches!(open(&mut fx.bob_state, &sent[0]), CollabMsg::NoteStatus { status: NoteStatus::Received, .. }));
        match open(&mut fx.bob_state, &sent[1]) {
            CollabMsg::FollowUpStatus { note_id, status, reason, .. } => assert_eq!((note_id.as_str(), status, reason.as_deref()), ("f1", NoteStatus::Refused, Some("busy"))),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_member_that_leaves_takes_the_chat_state_along() {
        let mut fx = fixture();
        let (bob, me) = (fx.bob.member_id.clone(), fx.ada.member_id.clone());
        fx.inner.collab.chat.push(&bob, "run1", entry(&bob, "a", "x", 1));
        fx.inner.collab.chat.push(&me, "run9", entry(&me, "b", "mine", 2));
        fx.inner.collab.chat_requested.insert((bob.clone(), "run1".into()), Instant::now());
        member_gone(&mut fx.inner, &bob);
        assert!(fx.inner.collab.chat.list(&bob, "run1").is_empty());
        assert!(fx.inner.collab.chat_requested.is_empty());
        assert_eq!(fx.inner.collab.chat.list(&me, "run9").len(), 1, "this machine's own threads stay");
        forget_all(&mut fx.inner);
        assert!(fx.inner.collab.chat.is_empty());
    }

    #[test]
    fn thread_files_are_private_named_by_a_hash_and_kept_small() {
        let dir = tempfile::tempdir().unwrap();
        // a run id cannot pick a path
        let hostile = chat_path(dir.path(), "../../etc/passwd");
        assert!(hostile.starts_with(dir.path().join(CHAT_DIR)), "{hostile:?}");
        assert!(!hostile.to_string_lossy().contains("passwd"));
        assert_eq!(hostile.extension().and_then(|e| e.to_str()), Some("jsonl"));
        assert_ne!(chat_path(dir.path(), "run1"), chat_path(dir.path(), "run2"));
        assert_eq!(chat_path(dir.path(), "run1"), chat_path(dir.path(), "run1"));
        // written and read back
        let file = chat_path(dir.path(), "run1");
        chat_write(&file, &entry("m1", "a", "first", 1));
        chat_write(&file, &entry("m1", "b", "second", 2));
        let back = decode_lines(&std::fs::read_to_string(&file).unwrap());
        assert_eq!(back.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), ["first", "second"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(file.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        // a file that grew big is rewritten with the newest messages, and stays private
        let text = "x".repeat(1900);
        for i in 0..800 {
            chat_write(&file, &entry("m1", &format!("big{i}"), &text, 10 + i));
        }
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(size <= CHAT_FILE_COMPACT + 8192, "{size} bytes: a file is rewritten once it passes {CHAT_FILE_COMPACT}");
        let kept = decode_lines(&std::fs::read_to_string(&file).unwrap());
        assert_eq!(kept.last().unwrap().msg_id, "m1.big799", "the newest message is the last line");
        assert!(kept.len() <= intely_team::chat::THREAD_MAX);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(!file.with_extension("tmp").exists());
    }

    #[test]
    fn leaving_the_team_removes_the_thread_files() {
        let dir = tempfile::tempdir().unwrap();
        let file = chat_path(dir.path(), "run1");
        chat_write(&file, &entry("m1", "a", "private words of a teammate", 1));
        assert!(file.exists());
        let mut inner = Inner::default();
        inner.state_dir = Some(dir.path().to_path_buf());
        let secrets: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::new());
        reset(&mut inner, &secrets);
        assert!(!dir.path().join(CHAT_DIR).exists());
        assert!(dir.path().exists(), "only the chat folder goes");
    }
}
