//! Team, phases T3 and T4 (docs/team.md): a note into a teammate's run and a snapshot of a teammate's workspace. A child of `team.rs`.
//!
//! The ONLY things a teammate can ask of this machine arrive here as [`CollabMsg`]; any other plaintext of a `direct` envelope is
//! dropped by the parser (`crates/team/src/collab.rs`). A note waits for the person's accept (or the per-member opt-in
//! `autoAcceptNotesFrom`) and then takes the same `host.note` path as a note typed in the run panel; a snapshot is built only for a
//! project the person switched on (`workspaceProjects`). Nothing here answers a permission card, sends a prompt or starts a run.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use intely_agent_core::api::RunStatus;
use intely_agent_core::events::types::{AgentEvent, EventKind, NoteState};
use intely_core::{ChangeKind, DiffSource, GuardState, Hunk, HunkLineKind};
use intely_remote::util::{b64u, random};
use intely_team::audit::event;
use intely_team::collab::{attributed, build_snapshot, chunk_snapshot, clean_note, fit_snapshot, judge_note, CollabMsg, CollabSettings, NoteStatus, Gate, PendingNote, PendingNotes, RateLimit, SenderGate, RawFile, Reassembly, RunFacts, Snapshot, MAX_FILES, MAX_SNAPSHOT_BYTES};

use super::*;

/// Chunks per flush (the relay allows 300 frames per 10 s per socket; run sharing shares that budget).
const CHUNKS_PER_FLUSH: usize = 6;
const FLUSH_EVERY: Duration = Duration::from_millis(250);
/// A snapshot is accepted only for a request made this recently.
const REQUEST_TTL: Duration = Duration::from_secs(120);
const MAX_SENT: usize = 100;
const MAX_TRACKED: usize = 50;
const MAX_SNAPSHOTS: usize = 40;

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
}

pub(super) struct Collab {
    pending: PendingNotes,
    note_rate: RateLimit,
    snap_rate: RateLimit,
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
            snap_rate: RateLimit::snapshots(),
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

fn reply(inner: &mut Inner, to: &str, run_id: &str, note_id: &str, status: NoteStatus, reason: Option<&str>) {
    send_collab(inner, to, &CollabMsg::NoteStatus { run_id: run_id.into(), note_id: note_id.into(), status, reason: reason.map(str::to_string) });
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

// ---------------------------------------------------------------- incoming

/// A verified, parsed message of a member (the envelope's signature named `sender`).
pub(super) fn collab_in(app: &AppHandle, inner: &mut Inner, sender: &str, msg: CollabMsg) {
    let known = inner.team.as_ref().is_some_and(|t| t.me != sender && t.body().member(sender).is_some());
    if !known {
        audit(inner, event::REJECTED, Some(sender), Some("collab: not a member"));
        return;
    }
    let now = now_ms();
    match msg {
        CollabMsg::NoteSend { run_id, note_id, text } => {
            if !inner.collab.note_rate.allow(sender, now) {
                audit(inner, event::REJECTED, Some(sender), Some("note rate"));
                reply(inner, sender, &run_id, &note_id, NoteStatus::Refused, Some("rate"));
                return;
            }
            audit(inner, event::NOTE_RECEIVED, Some(sender), Some("note"));
            tauri::async_runtime::spawn(note_job(app.clone(), sender.to_string(), run_id, note_id, text));
        }
        CollabMsg::NoteStatus { run_id, note_id, status, reason } => {
            let Some(s) = inner.collab.sent.iter_mut().find(|s| s.member_id == sender && s.note_id == note_id && s.run_id == run_id) else {
                audit(inner, event::REJECTED, Some(sender), Some("status of an unknown note"));
                return;
            };
            s.status = status_name(status).into();
            s.reason = reason;
            let v = serde_json::to_value(&*s).unwrap_or_default();
            inner.ui.push(("team:note-status", v));
        }
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

async fn note_job(app: AppHandle, from: String, run_id: String, note_id: String, text: String) {
    let facts = facts_of(&app, &run_id).await;
    let auto = collab_settings(&app).auto_accept.contains(&from);
    let state = st(&app);
    let Ok((secrets, _)) = parts(&state) else { return };
    let accept_now = {
        let mut inner = lock(&state.inner);
        let inner = &mut *inner;
        let name = inner.team.as_ref().and_then(|t| t.body().member(&from)).map(|m| m.name.clone());
        if let Err(reason) = judge_note(name.is_some(), facts) {
            audit(inner, event::REJECTED, Some(&from), Some(&format!("note {reason}")));
            reply(inner, &from, &run_id, &note_id, NoteStatus::Refused, Some(reason));
            save(inner, &secrets);
            return;
        }
        let note = PendingNote { from: from.clone(), from_name: name.unwrap_or_default(), run_id: run_id.clone(), note_id: note_id.clone(), text: clean_note(&text), at: now_ms() };
        let card = note_view(&note, auto);
        let Some(evicted) = inner.collab.pending.add(note) else { return };
        // a note pushed out of the list is never decided: its sender is told (a stale card answers "no longer waiting")
        for gone in evicted {
            reply(inner, &gone.from, &gone.run_id, &gone.note_id, NoteStatus::Dropped, Some("overflow"));
        }
        reply(inner, &from, &run_id, &note_id, NoteStatus::Received, None);
        inner.ui.push(("team:note-in", card));
        flush(&app, inner);
        save(inner, &secrets);
        auto
    };
    if accept_now {
        let _ = accept_note(&app, &from, &note_id).await;
    }
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
    /// The member is trusted (`autoAcceptNotesFrom`): the note is passed on without a decision.
    auto: bool,
}

fn note_view(n: &PendingNote, auto: bool) -> Value {
    serde_json::to_value(NoteView { member_id: n.from.clone(), member_name: n.from_name.clone(), run_id: n.run_id.clone(), note_id: n.note_id.clone(), text: n.text.clone(), at: n.at, auto }).unwrap_or_default()
}

/// Hands an accepted note to the run, through the same call as a note typed in the run panel, attributed to the teammate.
async fn accept_note(app: &AppHandle, from: &str, note_id: &str) -> Res<()> {
    let state = st(app);
    let (secrets, _) = parts(&state)?;
    let note = {
        let mut inner = lock(&state.inner);
        let n = inner.collab.pending.take(from, note_id).ok_or_else(|| err("unknownNote", "that note is no longer waiting"))?;
        inner.collab.inflight += 1;
        watch_update(&inner.collab);
        n
    };
    // the run may have ended or been switched off since the note arrived
    let facts = facts_of(app, &note.run_id).await;
    let verdict = judge_note(true, facts);
    let result = match verdict {
        Err(reason) => Err(err("noteRefused", reason)),
        Ok(()) => {
            let (a, id, text) = (app.clone(), note.run_id.clone(), attributed(&note.from_name, &note.text));
            crate::agents::blocking(move || {
                let slot = a.try_state::<crate::agents::AgentSlot>().ok_or_else(|| err("unavailable", "agents are unavailable"))?;
                slot.host().note(&id, None, &text)
            })
            .await
        }
    };
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    inner.collab.inflight = inner.collab.inflight.saturating_sub(1);
    match result {
        Ok(local_id) => {
            let early = inner.collab.recent.iter().find(|(id, _)| *id == local_id).map(|(_, s)| *s);
            audit(inner, event::NOTE_ACCEPTED, Some(from), Some("note"));
            reply(inner, from, &note.run_id, &note.note_id, NoteStatus::Accepted, None);
            match early {
                Some(s) => reply(inner, from, &note.run_id, &note.note_id, if s == NoteState::Delivered { NoteStatus::Delivered } else { NoteStatus::Dropped }, None),
                None => {
                    if inner.collab.tracked.len() >= MAX_TRACKED {
                        if let Some(k) = inner.collab.tracked.keys().next().cloned() {
                            inner.collab.tracked.remove(&k);
                        }
                    }
                    inner.collab.tracked.insert(local_id, (from.to_string(), note.run_id.clone(), note.note_id.clone()));
                }
            }
            watch_update(&inner.collab);
            save(inner, &secrets);
            Ok(())
        }
        Err(e) => {
            watch_update(&inner.collab);
            audit(inner, event::REJECTED, Some(from), Some(&format!("note not delivered: {}", e.code)));
            reply(inner, from, &note.run_id, &note.note_id, NoteStatus::Dropped, Some(&e.code.chars().take(30).collect::<String>()));
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
            Some((from, run, rid)) => reply(inner, &from, &run, &rid, if *ns == NoteState::Delivered { NoteStatus::Delivered } else { NoteStatus::Dropped }, None),
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
    audit(inner, event::NOTE_REJECTED, Some(&member_id), Some("note"));
    reply(inner, &member_id, &n.run_id, &n.note_id, NoteStatus::Rejected, None);
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
    let s = SentNote { member_id, run_id, note_id: note_id.clone(), status: "sent".into(), reason: None, at: now_ms() };
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

/// What the Changes view knows about the project's repository: branch, ahead / behind and the changed files with their diffs. Secret
/// files, binaries and large files are listed without content; the caller redacts and caps the rest (`build_snapshot`).
async fn gather(app: &AppHandle, project_key: &str) -> Result<(Option<String>, u32, u32, Vec<RawFile>), &'static str> {
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
    Ok((snap.head.branch.clone(), snap.ahead, snap.behind, files))
}

async fn snapshot_job(app: AppHandle, to: String, project_key: String) {
    let deny = |why: &str| {
        let state = st(&app);
        let mut inner = lock(&state.inner);
        send_collab(&mut inner, &to, &CollabMsg::WsDenied { project_key: project_key.clone(), reason: why.into() });
    };
    let (branch, ahead, behind, raw) = match gather(&app, &project_key).await {
        Ok(x) => x,
        Err(why) => return deny(why),
    };
    let id = b64u(&random::<8>());
    let snap = fit_snapshot(build_snapshot(&id, &project_key, branch, ahead, behind, now_ms(), raw));
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
