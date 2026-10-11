//! Sharing runs with the team (docs/team.md, T2). Tauri-free and I/O-free: [`Publisher`] turns the host's events into redacted,
//! coalesced, size-bounded [`ShareMsg`]s for the people who may see them; [`RunStore`] is what a member keeps of what the others sent.
//! The caller seals each message into an envelope and hands it to the relay. A teammate can read; nothing here (or on the receiving
//! side) can answer a permission card, send a prompt or start a run.

use std::collections::{HashMap, HashSet, VecDeque};

use intely_agent_core::events::{AgentEvent, EventKind};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::redact::{clip, OutputScrub, Redactor, StreamScrub};

/// Plaintext bytes of one message. An envelope base64s it twice (ciphertext in the envelope, the envelope in the frame), so 24 KiB
/// become about 43 KiB, under the relay's 64 KiB frame.
pub const MAX_MSG: usize = 24 * 1024;
/// What a publisher keeps per run to bring a member who connects late up to date.
pub const RING_EVENTS: usize = 400;
pub const RING_BYTES: usize = 512 * 1024;
/// What a receiver keeps.
pub const STORE_EVENTS: usize = 3000;
pub const STORE_RUNS: usize = 40;
const PUBLISH_RUNS: usize = 50;
const QUEUE_MAX: usize = 2000;
const TEXT_BATCH_CAP: usize = 8 * 1024;
/// A receiver keeps at most this much per run and per member; the oldest events go first.
pub const STORE_RUN_BYTES: usize = 4 * 1024 * 1024;
pub const STORE_MEMBER_BYTES: usize = 32 * 1024 * 1024;
/// Opt-outs are only forgotten after this long.
pub const FORGET_AFTER_MS: u64 = 30 * 24 * 3600 * 1000;
/// A member gets a snapshot at most this often.
pub const SNAPSHOT_EVERY_MS: u64 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCard {
    pub run_id: String,
    pub project_key: String,
    pub project_name: String,
    pub title: String,
    /// `running`, `waiting` (a permission card or a question waits for the owner), `idle` or `error`.
    pub state: String,
    pub provider: String,
    pub model: String,
    pub started_at: u64,
    pub updated_at: u64,
}

impl RunCard {
    fn sanitized(mut self) -> Self {
        let cut = |s: &str, n: usize| s.chars().filter(|c| !c.is_control()).take(n).collect::<String>();
        self.run_id = cut(&self.run_id, 80);
        self.project_key = cut(&self.project_key, 64);
        self.project_name = cut(&self.project_name, 120);
        self.title = cut(&self.title, 200);
        self.state = if matches!(self.state.as_str(), "running" | "waiting" | "idle" | "error") { self.state } else { "idle".into() };
        self.provider = cut(&self.provider, 40);
        self.model = cut(&self.model, 80);
        self
    }
}

/// The plaintext of a run-sharing envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all_fields = "camelCase")]
pub enum ShareMsg {
    /// Every run the sender shares right now; replaces what the receiver had of that sender.
    #[serde(rename = "runs.snapshot")]
    Snapshot { runs: Vec<RunCard> },
    #[serde(rename = "run.card")]
    Card { run: RunCard },
    /// Redacted events in order (the wire shape of an `AgentEvent` without `raw`; the diff of a `tool.result` is `{path, old?, new, truncated}`).
    #[serde(rename = "run.events")]
    Events { run_id: String, events: Vec<Value> },
    /// The run is no longer shared (the owner switched it off, or the project).
    #[serde(rename = "run.gone")]
    Gone { run_id: String },
    /// "Send me what you share" (a member that just connected).
    #[serde(rename = "runs.request")]
    Request,
}

impl ShareMsg {
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("share message serializes")
    }

    /// `None` for anything that is not a run-sharing message (a later phase's traffic, or garbage).
    pub fn parse(plain: &[u8]) -> Option<Self> {
        serde_json::from_slice(plain).ok()
    }
}

// ---------------------------------------------------------------- publishing

/// What the person switched on, read from the `team` settings (`shareProjects`, `unsharedRuns`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShareSettings {
    pub projects: HashSet<String>,
    pub unshared_runs: HashSet<String>,
}

impl ShareSettings {
    pub fn from_map(m: &Map<String, Value>) -> Self {
        let keys = |name: &str, only_true: bool| -> HashSet<String> {
            m.get(name).and_then(Value::as_object).map(|o| o.iter().filter(|(_, v)| !only_true || v.as_bool() == Some(true)).map(|(k, _)| k.clone()).collect()).unwrap_or_default()
        };
        Self { projects: keys("shareProjects", true), unshared_runs: keys("unsharedRuns", false) }
    }

    /// The one rule: every repository of the run has a project key, the person shares all of those projects, and this run is not opted out.
    pub fn allows<S: AsRef<str>>(&self, project_keys: &[S], run_id: &str) -> bool {
        !project_keys.is_empty() && project_keys.iter().all(|k| self.projects.contains(k.as_ref())) && !self.unshared_runs.contains(run_id)
    }
}

/// The project of a run. A run with several repositories is shared only if all of them have a key and are shared (`keys`); `key` and
/// `name` are those of the first one, for the card.
/// Which opt-outs (`unsharedRuns`: run id -> when it was set) may be forgotten to keep the list short: old ones, of runs that are not
/// live (`busy`) and not `keep`. A live run (or one set a moment ago) never starts sharing because the list grew. May return nothing.
pub fn forgettable_opt_outs(unshared: &Map<String, Value>, busy: &HashSet<String>, keep: &str, now_ms: u64, max: usize) -> Vec<String> {
    if unshared.len() <= max {
        return Vec::new();
    }
    let mut old: Vec<(&String, u64)> = unshared.iter().map(|(k, v)| (k, v.as_u64().unwrap_or(0))).filter(|(k, t)| now_ms.saturating_sub(*t) > FORGET_AFTER_MS && !busy.contains(*k) && k.as_str() != keep).collect();
    old.sort_by_key(|(_, t)| *t);
    old.into_iter().take(unshared.len() - max).map(|(k, _)| k.clone()).collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    pub key: String,
    pub name: String,
    pub keys: Vec<String>,
}

impl Project {
    pub fn single(key: &str, name: &str) -> Self {
        Self { key: key.into(), name: name.into(), keys: vec![key.into()] }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dest {
    All,
    One(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Out {
    pub dest: Dest,
    pub msg: ShareMsg,
}

struct RunOut {
    card: RunCard,
    keys: Vec<String>,
    /// Streamed texts by message (and sub-agent), and streamed tool outputs by tool.
    streams: HashMap<String, StreamScrub>,
    outputs: HashMap<String, OutputScrub>,
    card_dirty: bool,
    pending: Vec<Value>,
    ring: VecDeque<(Value, usize)>,
    ring_bytes: usize,
}

#[derive(Default)]
pub struct Publisher {
    red: Redactor,
    runs: HashMap<String, RunOut>,
    queue: VecDeque<Out>,
    snapshots: HashMap<String, u64>,
}

impl ShareMsg {
    fn run_id(&self) -> Option<&str> {
        match self {
            ShareMsg::Card { run } => Some(&run.run_id),
            ShareMsg::Events { run_id, .. } | ShareMsg::Gone { run_id } => Some(run_id),
            _ => None,
        }
    }
}

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// Shrinks one redacted event until it fits `max` bytes: first the diff, then the long strings, last the whole payload.
pub fn fit_event(v: &mut Value, max: usize) {
    let size = |v: &Value| serde_json::to_string(v).map_or(usize::MAX, |s| s.len());
    if size(v) <= max {
        return;
    }
    if let Some(o) = v.as_object_mut() {
        if o.remove("diff").is_some() {
            o.insert("diffOmitted".into(), json!(true));
        }
    }
    for _ in 0..12 {
        if size(v) <= max {
            return;
        }
        let Some(o) = v.as_object_mut() else { break };
        let longest = o.iter().filter_map(|(k, x)| x.as_str().map(|s| (k.clone(), s.chars().count()))).max_by_key(|(_, n)| *n);
        match longest {
            Some((k, n)) if n > 200 => {
                let cut = clip(o[&k].as_str().unwrap_or(""), n / 2).0;
                o.insert(k, Value::String(cut));
            }
            _ => break,
        }
    }
    if size(v) > max {
        let keep: Map<String, Value> = ["kind", "agentId", "seq", "ts", "toolId", "messageId"].iter().filter_map(|k| v.get(*k).map(|x| ((*k).to_string(), x.clone()))).collect();
        let mut keep = keep;
        keep.insert("omitted".into(), json!(true));
        *v = Value::Object(keep);
    }
}

/// Events into messages of at most [`MAX_MSG`] bytes each.
pub fn pack(run_id: &str, events: Vec<Value>) -> Vec<ShareMsg> {
    let mut out = Vec::new();
    let (mut cur, mut size): (Vec<Value>, usize) = (Vec::new(), 0);
    for mut e in events {
        fit_event(&mut e, MAX_MSG - 512);
        let n = serde_json::to_string(&e).map_or(0, |s| s.len()) + 1;
        if !cur.is_empty() && size + n > MAX_MSG - 512 {
            out.push(ShareMsg::Events { run_id: run_id.to_string(), events: std::mem::take(&mut cur) });
            size = 0;
        }
        size += n;
        cur.push(e);
    }
    if !cur.is_empty() {
        out.push(ShareMsg::Events { run_id: run_id.to_string(), events: cur });
    }
    out
}

/// Appends an event to a pending list; consecutive text deltas of one message become one, and a `text.done` replaces the deltas of its message.
fn coalesce(pending: &mut Vec<Value>, ev: Value) {
    match str_of(&ev, "kind") {
        "text.delta" => {
            if let Some(last) = pending.last_mut() {
                let same = str_of(last, "kind") == "text.delta" && str_of(last, "messageId") == str_of(&ev, "messageId") && last.get("parentToolId") == ev.get("parentToolId");
                if same {
                    let mut text = str_of(last, "text").to_string();
                    if text.len() < TEXT_BATCH_CAP {
                        text.push_str(str_of(&ev, "text"));
                    }
                    last["text"] = Value::String(text);
                    last["seq"] = ev["seq"].clone();
                    return;
                }
            }
        }
        _ => {}
    }
    pending.push(ev);
}

fn stream_key(message_id: &str, parent: Option<&str>) -> String {
    format!("{}\u{1}{}", message_id, parent.unwrap_or(""))
}

fn split_key(k: &str) -> (&str, Option<&str>) {
    let (m, p) = k.split_once('\u{1}').unwrap_or((k, ""));
    (m, (!p.is_empty()).then_some(p))
}

fn delta_value(e: &AgentEvent, message_id: &str, parent: Option<&str>, text: String) -> Value {
    let mut v = json!({ "kind": "text.delta", "agentId": e.agent_id, "seq": e.seq, "ts": e.ts, "provider": e.provider, "messageId": message_id, "text": text });
    if let Some(p) = parent {
        v["parentToolId"] = json!(p);
    }
    v
}

impl Publisher {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_idle(&self) -> bool {
        self.runs.is_empty() && self.queue.is_empty()
    }

    pub fn shared_runs(&self) -> usize {
        self.runs.len()
    }

    fn push(&mut self, o: Out) {
        if self.queue.len() >= QUEUE_MAX {
            self.queue.pop_front();
        }
        self.queue.push_back(o);
    }

    /// One host event. `project` is the run's project (`None` = no `origin` somewhere, so never shared).
    pub fn on_event(&mut self, e: &AgentEvent, project: Option<&Project>, s: &ShareSettings) {
        let keys: &[String] = project.map_or(&[], |p| p.keys.as_slice());
        if !s.allows(keys, &e.agent_id) {
            self.withdraw(&e.agent_id);
            return;
        }
        let Some(project) = project else { return };
        if matches!(e.kind, EventKind::ThinkingDelta { .. } | EventKind::Note { .. }) {
            return;
        }
        if !self.runs.contains_key(&e.agent_id) {
            if self.runs.len() >= PUBLISH_RUNS {
                if let Some(old) = self.runs.iter().min_by_key(|(_, r)| r.card.updated_at).map(|(k, _)| k.clone()) {
                    self.withdraw(&old);
                }
            }
            let card = RunCard { run_id: e.agent_id.clone(), project_key: project.key.clone(), project_name: project.name.clone(), title: String::new(), state: "running".into(), provider: e.provider.clone(), model: String::new(), started_at: e.ts, updated_at: e.ts };
            self.runs.insert(e.agent_id.clone(), RunOut { card, keys: project.keys.clone(), streams: HashMap::new(), outputs: HashMap::new(), card_dirty: true, pending: Vec::new(), ring: VecDeque::new(), ring_bytes: 0 });
        }
        // Streamed text is scrubbed over the joined pieces, not piece by piece; the end of a message (or of the turn) flushes what is held.
        let mut flushed: Vec<Value> = Vec::new();
        let v = match &e.kind {
            EventKind::TextDelta { message_id, text, parent_tool_id } => {
                let run = self.runs.get_mut(&e.agent_id);
                let safe = run.map(|r| r.streams.entry(stream_key(message_id, parent_tool_id.as_deref())).or_default().push(text)).unwrap_or_default();
                (!safe.is_empty()).then(|| delta_value(e, message_id, parent_tool_id.as_deref(), safe))
            }
            EventKind::TextDone { message_id, parent_tool_id, .. } => {
                if let Some(run) = self.runs.get_mut(&e.agent_id) {
                    if let Some(mut st) = run.streams.remove(&stream_key(message_id, parent_tool_id.as_deref())) {
                        let rest = st.finish();
                        if !rest.is_empty() {
                            flushed.push(delta_value(e, message_id, parent_tool_id.as_deref(), rest));
                        }
                    }
                }
                self.red.event(e)
            }
            EventKind::TurnEnd { .. } | EventKind::Error { .. } => {
                if let Some(run) = self.runs.get_mut(&e.agent_id) {
                    let mut keys: Vec<String> = run.streams.keys().cloned().collect();
                    keys.sort();
                    for k in keys {
                        if let Some(mut st) = run.streams.remove(&k) {
                            let rest = st.finish();
                            if !rest.is_empty() {
                                let (mid, parent) = split_key(&k);
                                flushed.push(delta_value(e, mid, parent, rest));
                            }
                        }
                    }
                    run.outputs.clear();
                }
                self.red.event(e)
            }
            EventKind::ToolUpdate { tool_id, status, output: Some(chunk) } => {
                // streamed output: only complete lines of the joined text, scrubbed together; the final result carries the rest
                let out = self.runs.get_mut(&e.agent_id).map(|r| r.outputs.entry(tool_id.clone()).or_default().push(chunk)).unwrap_or_default();
                let mut redacted = e.clone();
                redacted.kind = EventKind::ToolUpdate { tool_id: tool_id.clone(), status: *status, output: Some(out) };
                self.red.event(&redacted)
            }
            EventKind::ToolResult { tool_id, .. } => {
                if let Some(run) = self.runs.get_mut(&e.agent_id) {
                    run.outputs.remove(tool_id);
                }
                self.red.event(e)
            }
            _ => self.red.event(e),
        };
        let Some(run) = self.runs.get_mut(&e.agent_id) else { return };
        let before = run.card.clone();
        run.card.updated_at = e.ts;
        match &e.kind {
            EventKind::SessionStarted { model, .. } => run.card.model = model.clone(),
            EventKind::SessionInfo { .. } => {
                if let Some(t) = v.as_ref().and_then(|v| v.get("title")).and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    run.card.title = t.to_string();
                }
            }
            EventKind::UserMessage { .. } => {
                run.card.state = "running".into();
                if run.card.title.is_empty() {
                    run.card.title = clip(v.as_ref().map_or("", |v| str_of(v, "text")).lines().next().unwrap_or(""), 80).0;
                }
            }
            EventKind::Status { state, .. } => {
                use intely_agent_core::events::StatusState as S;
                run.card.state = match state {
                    S::Idle => "idle",
                    S::WaitingUser => "waiting",
                    _ => "running",
                }
                .into();
            }
            EventKind::PermissionRequest { .. } | EventKind::QuestionRequest { .. } => run.card.state = "waiting".into(),
            EventKind::PermissionResolved { .. } => run.card.state = "running".into(),
            EventKind::TurnEnd { .. } => run.card.state = "idle".into(),
            EventKind::Error { .. } => run.card.state = "error".into(),
            _ => {}
        }
        if run.card != before {
            run.card_dirty = true;
        }
        for f in flushed {
            coalesce(&mut run.pending, f);
        }
        if let Some(v) = v {
            coalesce(&mut run.pending, v);
        }
    }

    /// Takes a run back: what is still waiting to be sent about it is dropped at once, then the team is told it is gone.
    fn withdraw(&mut self, run_id: &str) {
        if self.runs.remove(run_id).is_none() {
            return;
        }
        self.queue.retain_mut(|o| match &mut o.msg {
            ShareMsg::Snapshot { runs } => {
                runs.retain(|c| c.run_id != run_id);
                true
            }
            m => m.run_id() != Some(run_id),
        });
        self.push(Out { dest: Dest::All, msg: ShareMsg::Gone { run_id: run_id.to_string() } });
    }

    /// The person changed what is shared: runs that are no longer allowed are withdrawn.
    pub fn retain(&mut self, s: &ShareSettings) {
        let gone: Vec<String> = self.runs.iter().filter(|(id, r)| !s.allows(&r.keys, id)).map(|(id, _)| id.clone()).collect();
        for id in gone {
            self.withdraw(&id);
        }
    }

    /// Everything the member needs to see what is shared now: the cards, then each run's recent events.
    pub fn snapshot_for(&mut self, to: &str, now_ms: u64) {
        if self.snapshots.get(to).is_some_and(|t| now_ms.saturating_sub(*t) < SNAPSHOT_EVERY_MS) {
            return;
        }
        if self.snapshots.len() > 256 {
            self.snapshots.clear();
        }
        self.snapshots.insert(to.to_string(), now_ms);
        let mut cards: Vec<RunCard> = self.runs.values().map(|r| r.card.clone()).collect();
        cards.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.run_id.cmp(&b.run_id)));
        cards.truncate(STORE_RUNS);
        let listed: HashSet<String> = cards.iter().map(|c| c.run_id.clone()).collect();
        self.push(Out { dest: Dest::One(to.to_string()), msg: ShareMsg::Snapshot { runs: cards } });
        let mut replay: Vec<(String, Vec<Value>)> = self.runs.iter().filter(|(id, _)| listed.contains(*id)).map(|(id, r)| (id.clone(), r.ring.iter().map(|(v, _)| v.clone()).collect())).collect();
        replay.sort_by(|a, b| a.0.cmp(&b.0));
        for (id, events) in replay {
            for msg in pack(&id, events) {
                self.push(Out { dest: Dest::One(to.to_string()), msg });
            }
        }
    }

    /// Called every flush interval: cards that changed and the coalesced events go to the queue; at most `budget` messages come out
    /// (the relay limits frames per window; the rest waits for the next call).
    pub fn tick(&mut self, budget: usize) -> Vec<Out> {
        let mut ids: Vec<String> = self.runs.keys().cloned().collect();
        ids.sort();
        for id in ids {
            let Some(run) = self.runs.get_mut(&id) else { continue };
            let mut staged = Vec::new();
            if run.card_dirty {
                run.card_dirty = false;
                staged.push(Out { dest: Dest::All, msg: ShareMsg::Card { run: run.card.clone() } });
            }
            let events = std::mem::take(&mut run.pending);
            for ev in &events {
                let n = serde_json::to_string(ev).map_or(0, |s| s.len());
                run.ring.push_back((ev.clone(), n));
                run.ring_bytes += n;
            }
            while run.ring.len() > RING_EVENTS || run.ring_bytes > RING_BYTES {
                match run.ring.pop_front() {
                    Some((_, n)) => run.ring_bytes -= n,
                    None => break,
                }
            }
            staged.extend(pack(&id, events).into_iter().map(|msg| Out { dest: Dest::All, msg }));
            for o in staged {
                self.push(o);
            }
        }
        let n = budget.min(self.queue.len());
        self.queue.drain(..n).collect()
    }

    pub fn clear(&mut self) {
        self.runs.clear();
        self.queue.clear();
        self.snapshots.clear();
    }
}

// ---------------------------------------------------------------- receiving

#[derive(Debug)]
pub struct RemoteRun {
    pub card: RunCard,
    events: VecDeque<(Value, usize)>,
    bytes: usize,
    last_seq: u64,
    /// The events carrying `last_seq` (a delta flushed at the end of a message shares its number with the event that ended it).
    last_group: Vec<Value>,
}

impl RemoteRun {
    fn new(card: RunCard) -> Self {
        Self { card, events: VecDeque::new(), bytes: 0, last_seq: 0, last_group: Vec::new() }
    }

    fn add(&mut self, e: Value) {
        let n = serde_json::to_string(&e).map_or(0, |s| s.len());
        self.events.push_back((e, n));
        self.bytes += n;
        while self.events.len() > STORE_EVENTS || self.bytes > STORE_RUN_BYTES {
            match self.events.pop_front() {
                Some((_, n)) => self.bytes -= n,
                None => break,
            }
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Change {
    None,
    /// The list of runs changed.
    Runs,
    /// New events of one run (already de-duplicated).
    Events { run_id: String, events: Vec<Value> },
}

/// What this member knows of the others' shared runs. In memory only.
#[derive(Debug, Default)]
pub struct RunStore {
    by_member: HashMap<String, Vec<RemoteRun>>,
}

fn valid_event(v: &Value) -> bool {
    v.as_object().is_some_and(|o| o.get("kind").is_some_and(Value::is_string))
}

impl RunStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// `from` is the verified sender of the envelope. Messages that are only requests, and anything malformed, change nothing.
    pub fn apply(&mut self, from: &str, msg: ShareMsg) -> Change {
        let runs = self.by_member.entry(from.to_string()).or_default();
        match msg {
            ShareMsg::Request => Change::None,
            ShareMsg::Snapshot { runs: cards } => {
                let mut cards = cards;
                cards.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                let cards: Vec<RunCard> = cards.into_iter().take(STORE_RUNS).map(RunCard::sanitized).filter(|c| !c.run_id.is_empty()).collect();
                let mut next = Vec::new();
                for c in cards {
                    match runs.iter().position(|r| r.card.run_id == c.run_id) {
                        Some(i) => {
                            let mut r = runs.swap_remove(i);
                            r.card = c;
                            next.push(r);
                        }
                        None => next.push(RemoteRun::new(c)),
                    }
                }
                *runs = next;
                Change::Runs
            }
            ShareMsg::Card { run } => {
                let c = run.sanitized();
                if c.run_id.is_empty() {
                    return Change::None;
                }
                match runs.iter_mut().find(|r| r.card.run_id == c.run_id) {
                    Some(r) => r.card = c,
                    None => {
                        if runs.len() >= STORE_RUNS {
                            let oldest = runs.iter().enumerate().min_by_key(|(_, r)| r.card.updated_at).map(|(i, _)| i);
                            if let Some(i) = oldest {
                                runs.swap_remove(i);
                            }
                        }
                        runs.push(RemoteRun::new(c));
                    }
                }
                Change::Runs
            }
            ShareMsg::Gone { run_id } => {
                let n = runs.len();
                runs.retain(|r| r.card.run_id != run_id);
                if runs.len() != n {
                    Change::Runs
                } else {
                    Change::None
                }
            }
            ShareMsg::Events { run_id, events } => {
                let Some(run) = runs.iter_mut().find(|r| r.card.run_id == run_id) else { return Change::None };
                let mut fresh = Vec::new();
                for e in events.into_iter().filter(valid_event) {
                    let seq = e.get("seq").and_then(Value::as_u64).unwrap_or(0);
                    // a new session of the run (its numbers start over): what was kept belongs to the old one. The same event again is a replay.
                    if str_of(&e, "kind") == "session.started" && !run.events.iter().any(|(x, _)| *x == e) && seq <= run.last_seq {
                        run.events.clear();
                        run.bytes = 0;
                        run.last_seq = 0;
                        run.last_group.clear();
                    }
                    if seq != 0 && (seq < run.last_seq || (seq == run.last_seq && run.last_group.contains(&e))) {
                        continue;
                    }
                    if seq > run.last_seq {
                        run.last_seq = seq;
                        run.last_group.clear();
                    }
                    run.last_group.push(e.clone());
                    run.add(e.clone());
                    fresh.push(e);
                }
                // the member's budget: the oldest events of its biggest run go first
                let total: usize = runs.iter().map(|r| r.bytes).sum();
                let mut over = total.saturating_sub(STORE_MEMBER_BYTES);
                while over > 0 {
                    let Some(big) = runs.iter_mut().max_by_key(|r| r.bytes) else { break };
                    match big.events.pop_front() {
                        Some((_, n)) => {
                            big.bytes -= n;
                            over = over.saturating_sub(n);
                        }
                        None => break,
                    }
                }
                if fresh.is_empty() {
                    Change::None
                } else {
                    Change::Events { run_id, events: fresh }
                }
            }
        }
    }

    /// `(member id, card)` of every run, the most recently active first.
    pub fn cards(&self) -> Vec<(String, RunCard)> {
        let mut v: Vec<(String, RunCard)> = self.by_member.iter().flat_map(|(m, rs)| rs.iter().map(move |r| (m.clone(), r.card.clone()))).collect();
        v.sort_by(|a, b| b.1.updated_at.cmp(&a.1.updated_at).then(a.1.run_id.cmp(&b.1.run_id)));
        v
    }

    pub fn events(&self, member: &str, run_id: &str) -> Vec<Value> {
        self.by_member.get(member).and_then(|rs| rs.iter().find(|r| r.card.run_id == run_id)).map(|r| r.events.iter().map(|(e, _)| e.clone()).collect()).unwrap_or_default()
    }

    pub fn drop_member(&mut self, id: &str) -> bool {
        self.by_member.remove(id).is_some_and(|r| !r.is_empty())
    }

    pub fn clear(&mut self) {
        self.by_member.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use intely_agent_core::events::{StopReason, ToolDiff, ToolStatus};

    fn ev(run: &str, seq: u64, kind: EventKind) -> AgentEvent {
        AgentEvent { agent_id: run.into(), seq, ts: 1000 + seq, turn_id: None, provider: "claude".into(), kind, raw: None }
    }
    fn delta(run: &str, seq: u64, id: &str, t: &str) -> AgentEvent {
        ev(run, seq, EventKind::TextDelta { message_id: id.into(), text: t.into(), parent_tool_id: None })
    }
    fn on() -> ShareSettings {
        ShareSettings { projects: ["k1".to_string()].into(), unshared_runs: HashSet::new() }
    }
    fn proj() -> Project {
        Project::single("k1", "widgets")
    }
    fn drain(p: &mut Publisher) -> Vec<Out> {
        p.tick(1000)
    }

    #[test]
    fn nothing_is_published_unless_the_project_is_shared_and_the_run_not_opted_out() {
        let mut p = Publisher::new();
        let e = delta("r1", 1, "m", "hi");
        p.on_event(&e, None, &on());
        p.on_event(&e, Some(&Project::single("other", "x")), &on());
        p.on_event(&e, Some(&proj()), &ShareSettings::default());
        let mut off = on();
        off.unshared_runs.insert("r1".into());
        p.on_event(&e, Some(&proj()), &off);
        assert!(p.is_idle());
        assert!(drain(&mut p).is_empty());
        p.on_event(&e, Some(&proj()), &on());
        assert_eq!(p.shared_runs(), 1);
    }

    #[test]
    fn settings_read_only_true_projects_and_any_listed_run() {
        let m = json!({"shareProjects": {"a": true, "b": false}, "unsharedRuns": {"r9": true}});
        let s = ShareSettings::from_map(m.as_object().unwrap());
        assert!(s.allows(&["a"], "r1"));
        assert!(!s.allows(&["b"], "r1"));
        assert!(!s.allows(&["a"], "r9"));
        assert!(!s.allows::<&str>(&[], "r1"));
        // every repository of the run must be shared
        assert!(!s.allows(&["a", "b"], "r1"));
        assert!(!s.allows(&["a", "c"], "r1"));
    }

    #[test]
    fn opting_out_or_unsharing_withdraws_the_run() {
        let mut p = Publisher::new();
        p.on_event(&delta("r1", 1, "m", "hi"), Some(&proj()), &on());
        drain(&mut p);
        let mut off = on();
        off.unshared_runs.insert("r1".into());
        p.on_event(&delta("r1", 2, "m", "more"), Some(&proj()), &off);
        let out = drain(&mut p);
        assert_eq!(out, vec![Out { dest: Dest::All, msg: ShareMsg::Gone { run_id: "r1".into() } }]);
        p.on_event(&delta("r2", 1, "m", "hi"), Some(&proj()), &on());
        p.retain(&ShareSettings::default());
        assert!(drain(&mut p).iter().any(|o| o.msg == ShareMsg::Gone { run_id: "r2".into() }));
        assert!(p.is_idle());
    }

    #[test]
    fn thinking_never_goes_out_and_deltas_coalesce_into_one() {
        let mut p = Publisher::new();
        let s = on();
        p.on_event(&ev("r1", 1, EventKind::ThinkingDelta { message_id: "m".into(), text: "secret plan".into(), parent_tool_id: None }), Some(&proj()), &s);
        assert!(p.is_idle(), "a thinking-only run is not even announced");
        for (i, t) in ["Hel", "lo ", "world\n"].iter().enumerate() {
            p.on_event(&delta("r1", 2 + i as u64, "m", t), Some(&proj()), &s);
        }
        let out = drain(&mut p);
        let all = serde_json::to_string(&out.iter().map(|o| &o.msg).collect::<Vec<_>>()).unwrap();
        assert!(!all.contains("secret plan"));
        let events: Vec<&Value> = out.iter().filter_map(|o| if let ShareMsg::Events { events, .. } = &o.msg { Some(events) } else { None }).flatten().collect();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["text"], "Hello world\n");
        assert_eq!(events[0]["seq"], 4);
        assert!(matches!(out[0].msg, ShareMsg::Card { .. }), "the card comes first");
    }

    #[test]
    fn text_done_keeps_the_streamed_text_and_order_is_kept() {
        let mut p = Publisher::new();
        let s = on();
        p.on_event(&ev("r1", 1, EventKind::UserMessage { message_id: "u".into(), text: "do it".into(), attachments: vec![] }), Some(&proj()), &s);
        p.on_event(&delta("r1", 2, "m", "par\n"), Some(&proj()), &s);
        p.on_event(&ev("r1", 3, EventKind::TextDone { message_id: "m".into(), text: "partial answer".into(), parent_tool_id: None }), Some(&proj()), &s);
        p.on_event(&ev("r1", 4, EventKind::TurnEnd { stop_reason: StopReason::EndTurn }), Some(&proj()), &s);
        let out = drain(&mut p);
        let kinds: Vec<String> = out.iter().filter_map(|o| if let ShareMsg::Events { events, .. } = &o.msg { Some(events.iter().map(|e| str_of(e, "kind").to_string()).collect::<Vec<_>>()) } else { None }).flatten().collect();
        assert_eq!(kinds, ["user.message", "text.delta", "text.done", "turn.end"]);
        let ShareMsg::Card { run } = &out[0].msg else { panic!() };
        assert_eq!((run.state.as_str(), run.title.as_str(), run.project_name.as_str()), ("idle", "do it", "widgets"));
    }

    #[test]
    fn a_huge_diff_is_dropped_to_fit_a_message_and_every_message_fits() {
        let mut p = Publisher::new();
        let s = on();
        let big = "line of code\n".repeat(4000);
        let diff = ToolDiff { path: "src/a.rs".into(), old: Some(big.clone()), new: big };
        for i in 0..6 {
            p.on_event(&ev("r1", 1 + i, EventKind::ToolResult { tool_id: format!("t{i}"), status: ToolStatus::Ok, output: Some("o".repeat(20_000)), diff: Some(diff.clone()), duration_ms: None }), Some(&proj()), &s);
        }
        let out = drain(&mut p);
        assert!(out.len() >= 2);
        for o in &out {
            assert!(o.msg.encode().len() <= MAX_MSG, "{} bytes", o.msg.encode().len());
        }
        // base64 twice plus the envelope fields stays under the relay's 64 KiB frame
        assert!(MAX_MSG * 4 / 3 * 4 / 3 + 1024 < 64 * 1024);
    }

    #[test]
    fn a_secret_file_diff_is_never_published() {
        let mut p = Publisher::new();
        let d = ToolDiff { path: "app/.env".into(), old: None, new: "DB_PASSWORD=hunter2".into() };
        p.on_event(&ev("r1", 1, EventKind::ToolResult { tool_id: "t".into(), status: ToolStatus::Ok, output: None, diff: Some(d), duration_ms: None }), Some(&proj()), &on());
        let all = serde_json::to_string(&drain(&mut p).iter().map(|o| o.msg.clone()).collect::<Vec<_>>()).unwrap();
        assert!(!all.contains("hunter2") && !all.contains("DB_PASSWORD"));
    }

    #[test]
    fn a_member_who_connects_late_gets_the_cards_and_the_recent_events_directly() {
        let mut p = Publisher::new();
        let s = on();
        p.on_event(&ev("r1", 1, EventKind::TextDone { message_id: "m".into(), text: "one".into(), parent_tool_id: None }), Some(&proj()), &s);
        drain(&mut p);
        p.snapshot_for("m_new", 1_000);
        let out = drain(&mut p);
        assert!(out.iter().all(|o| o.dest == Dest::One("m_new".into())));
        assert!(matches!(&out[0].msg, ShareMsg::Snapshot { runs } if runs.len() == 1));
        assert!(matches!(&out[1].msg, ShareMsg::Events { events, .. } if events.len() == 1));
    }

    #[test]
    fn the_budget_limits_messages_per_tick_and_the_rest_waits() {
        let mut p = Publisher::new();
        let s = on();
        for r in 0..5 {
            p.on_event(&delta(&format!("r{r}"), 1, "m", "x\n"), Some(&proj()), &s);
        }
        let first = p.tick(4);
        assert_eq!(first.len(), 4);
        assert_eq!(p.tick(100).len(), 6);
    }

    #[test]
    fn the_store_applies_dedupes_and_bounds() {
        let mut st = RunStore::new();
        let card = |id: &str, t: u64| RunCard { run_id: id.into(), project_key: "k".into(), project_name: "w".into(), title: "t".into(), state: "weird".into(), provider: "claude".into(), model: "m".into(), started_at: 1, updated_at: t };
        assert_eq!(st.apply("m1", ShareMsg::Events { run_id: "r1".into(), events: vec![json!({"kind": "turn.end", "seq": 1})] }), Change::None, "events of an unknown run are ignored");
        assert_eq!(st.apply("m1", ShareMsg::Card { run: card("r1", 5) }), Change::Runs);
        assert_eq!(st.cards()[0].1.state, "idle", "an unknown state is cleaned");
        let e = |s: u64| json!({"kind": "text.done", "seq": s, "text": "x"});
        let Change::Events { events, .. } = st.apply("m1", ShareMsg::Events { run_id: "r1".into(), events: vec![e(1), e(2), json!("junk"), json!({"no": "kind"})] }) else { panic!() };
        assert_eq!(events.len(), 2);
        assert_eq!(st.apply("m1", ShareMsg::Events { run_id: "r1".into(), events: vec![e(2)] }), Change::None, "a replay is ignored");
        assert_eq!(st.events("m1", "r1").len(), 2);
        // a snapshot keeps the runs it lists (with their events) and drops the others
        st.apply("m1", ShareMsg::Card { run: card("r2", 6) });
        st.apply("m1", ShareMsg::Snapshot { runs: vec![card("r1", 7)] });
        assert_eq!(st.cards().len(), 1);
        assert_eq!(st.events("m1", "r1").len(), 2);
        // runs of different members stay apart
        st.apply("m2", ShareMsg::Card { run: card("r1", 8) });
        assert_eq!(st.cards().len(), 2);
        assert_eq!(st.apply("m1", ShareMsg::Gone { run_id: "r1".into() }), Change::Runs);
        assert_eq!(st.cards().len(), 1);
        assert!(st.drop_member("m2"));
        assert!(st.cards().is_empty());
        for i in 0..(STORE_RUNS as u64 + 10) {
            st.apply("m3", ShareMsg::Card { run: card(&format!("x{i}"), i) });
        }
        assert_eq!(st.cards().len(), STORE_RUNS);
    }

    #[test]
    fn messages_round_trip_and_foreign_plaintext_is_ignored() {
        let m = ShareMsg::Gone { run_id: "r1".into() };
        assert_eq!(ShareMsg::parse(&m.encode()), Some(m));
        assert_eq!(ShareMsg::parse(&ShareMsg::Request.encode()), Some(ShareMsg::Request));
        assert_eq!(ShareMsg::parse(b"{\"t\":\"note.send\"}"), None);
        assert_eq!(ShareMsg::parse(b"not json"), None);
    }

    fn texts(out: &[Out]) -> String {
        out.iter().filter_map(|o| if let ShareMsg::Events { events, .. } = &o.msg { Some(events) } else { None }).flatten().filter(|e| str_of(e, "kind") == "text.delta").map(|e| str_of(e, "text")).collect()
    }

    #[test]
    fn a_pem_block_split_over_deltas_never_reaches_the_queue() {
        let mut p = Publisher::new();
        let s = on();
        let parts = ["See:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7x", "9fQ3kZ\nLq8vPz0NNNN\n", "-----END RSA PRIVATE KEY-----\nok\n"];
        for (i, t) in parts.iter().enumerate() {
            p.on_event(&delta("r1", 1 + i as u64, "m", t), Some(&proj()), &s);
        }
        p.on_event(&ev("r1", 9, EventKind::TextDone { message_id: "m".into(), text: parts.concat(), parent_tool_id: None }), Some(&proj()), &s);
        let out = drain(&mut p);
        let all = serde_json::to_string(&out.iter().map(|o| &o.msg).collect::<Vec<_>>()).unwrap();
        assert!(!all.contains("MIIEow") && !all.contains("9fQ3kZ") && !all.contains("Lq8vPz0"), "{all}");
        assert!(texts(&out).contains("See:") && texts(&out).contains("ok"));
    }

    #[test]
    fn a_token_split_across_a_flush_boundary_is_masked() {
        let mut p = Publisher::new();
        let s = on();
        p.on_event(&delta("r1", 1, "m", "line one\nkey AKIAIOSF"), Some(&proj()), &s);
        let first = drain(&mut p);
        assert!(!texts(&first).contains("AKIA"), "{}", texts(&first));
        p.on_event(&delta("r1", 2, "m", "ODNN7EXAMPLE tail\n"), Some(&proj()), &s);
        p.on_event(&ev("r1", 3, EventKind::TurnEnd { stop_reason: StopReason::EndTurn }), Some(&proj()), &s);
        let all = texts(&first) + &texts(&drain(&mut p));
        assert!(!all.contains("AKIAIOSF") && !all.contains("ODNN7EXAMPLE"), "{all}");
        assert!(all.contains("line one") && all.contains("tail"));
    }

    #[test]
    fn a_run_with_a_repository_that_is_not_shared_is_not_published() {
        let mut p = Publisher::new();
        let two = Project { key: "k1".into(), name: "widgets".into(), keys: vec!["k1".into(), "k2".into()] };
        p.on_event(&delta("r1", 1, "m", "x\n"), Some(&two), &on());
        assert!(p.is_idle());
        let mut both = on();
        both.projects.insert("k2".into());
        p.on_event(&delta("r1", 1, "m", "x\n"), Some(&two), &both);
        assert_eq!(p.shared_runs(), 1);
        // switching one of the two off withdraws the run
        p.retain(&on());
        assert_eq!(p.shared_runs(), 0);
    }

    #[test]
    fn opting_out_purges_what_is_still_queued_for_the_run() {
        let mut p = Publisher::new();
        let s = on();
        for r in ["r1", "r2"] {
            p.on_event(&delta(r, 1, "m", "secret-ish\n"), Some(&proj()), &s);
        }
        let first = p.tick(1); // r1's card leaves, everything else waits in the queue
        assert_eq!(first.len(), 1);
        p.snapshot_for("m_new", 5);
        let mut off = on();
        off.unshared_runs.insert("r1".into());
        p.retain(&off);
        let rest = drain(&mut p);
        for o in &rest {
            match &o.msg {
                ShareMsg::Events { run_id, .. } => assert_ne!(run_id, "r1"),
                ShareMsg::Card { run } => assert_ne!(run.run_id, "r1"),
                ShareMsg::Snapshot { runs } => assert!(runs.iter().all(|c| c.run_id != "r1")),
                _ => {}
            }
        }
        assert!(rest.iter().any(|o| o.msg == ShareMsg::Gone { run_id: "r1".into() }));
        assert!(rest.iter().any(|o| matches!(&o.msg, ShareMsg::Events { run_id, .. } if run_id == "r2")));
    }

    #[test]
    fn a_member_gets_a_snapshot_at_most_every_ten_seconds() {
        let mut p = Publisher::new();
        p.on_event(&delta("r1", 1, "m", "x\n"), Some(&proj()), &on());
        drain(&mut p);
        p.snapshot_for("m_a", 1_000);
        p.snapshot_for("m_a", 5_000);
        p.snapshot_for("m_b", 5_000);
        let out = drain(&mut p);
        assert_eq!(out.iter().filter(|o| matches!(o.msg, ShareMsg::Snapshot { .. })).count(), 2);
        p.snapshot_for("m_a", 11_001);
        assert_eq!(drain(&mut p).iter().filter(|o| matches!(o.msg, ShareMsg::Snapshot { .. })).count(), 1);
    }

    #[test]
    fn a_snapshot_keeps_the_most_recently_active_runs() {
        let mut p = Publisher::new();
        let s = on();
        for i in 0..(STORE_RUNS as u64 + 5) {
            // "z" sorts last by id but is the newest; "a0" sorts first and is the oldest
            let id = if i == 0 { "a0".to_string() } else if i == STORE_RUNS as u64 + 4 { "zz".to_string() } else { format!("m{i:03}") };
            p.on_event(&delta(&id, 100 + i, "m", "x\n"), Some(&proj()), &s);
        }
        drain(&mut p);
        p.snapshot_for("m_new", 1);
        let out = drain(&mut p);
        let ShareMsg::Snapshot { runs } = &out[0].msg else { panic!() };
        assert_eq!(runs.len(), STORE_RUNS);
        assert!(runs.iter().any(|c| c.run_id == "zz"));
        assert!(runs.iter().all(|c| c.run_id != "a0"));
    }

    #[test]
    fn the_store_keeps_a_byte_budget_per_run_and_per_member() {
        let card = |id: &str| RunCard { run_id: id.into(), project_key: "k".into(), project_name: "w".into(), title: "t".into(), state: "idle".into(), provider: "c".into(), model: "m".into(), started_at: 1, updated_at: 1 };
        let big = "x".repeat(60_000);
        let mut st = RunStore::new();
        st.apply("m1", ShareMsg::Card { run: card("r1") });
        let mut seq = 0;
        for _ in 0..100 {
            let events: Vec<Value> = (0..4).map(|_| (seq += 1, json!({"kind": "text.done", "seq": seq, "text": big})).1).collect();
            st.apply("m1", ShareMsg::Events { run_id: "r1".into(), events });
        }
        let kept = st.events("m1", "r1");
        assert!(kept.len() * 60_000 <= STORE_RUN_BYTES + 60_100, "{} events", kept.len());
        assert_eq!(kept.last().unwrap()["seq"], seq, "the newest stay");
        // the member budget: many runs, each below the run budget
        let mut st = RunStore::new();
        let mut seq = 0;
        for r in 0..12 {
            let id = format!("r{r}");
            st.apply("m1", ShareMsg::Card { run: card(&id) });
            for _ in 0..16 {
                seq += 1;
                st.apply("m1", ShareMsg::Events { run_id: id.clone(), events: vec![json!({"kind": "text.done", "seq": seq, "text": big})] });
            }
        }
        let total: usize = (0..12).map(|r| st.events("m1", &format!("r{r}")).len() * 60_000).sum();
        assert!(total <= STORE_MEMBER_BYTES + 12 * 60_100, "{total}");
    }

    #[test]
    fn a_new_session_resets_the_sequence_but_a_replay_does_not() {
        let card = RunCard { run_id: "r1".into(), project_key: "k".into(), project_name: "w".into(), title: "t".into(), state: "idle".into(), provider: "c".into(), model: "m".into(), started_at: 1, updated_at: 1 };
        let mut st = RunStore::new();
        st.apply("m1", ShareMsg::Card { run: card });
        let started = |n: u64| json!({"kind": "session.started", "seq": 1, "model": format!("m{n}")});
        let say = |s: u64| json!({"kind": "text.done", "seq": s, "text": "x"});
        st.apply("m1", ShareMsg::Events { run_id: "r1".into(), events: vec![started(1), say(2), say(3), say(4)] });
        // the same history again (a snapshot replay) changes nothing
        assert_eq!(st.apply("m1", ShareMsg::Events { run_id: "r1".into(), events: vec![started(1), say(2), say(3)] }), Change::None);
        assert_eq!(st.events("m1", "r1").len(), 4);
        // the run starts a new session: its numbers start over and are accepted
        let Change::Events { events, .. } = st.apply("m1", ShareMsg::Events { run_id: "r1".into(), events: vec![started(2), say(2)] }) else { panic!("frozen") };
        assert_eq!(events.len(), 2);
        assert_eq!(st.events("m1", "r1").len(), 2);
    }

    #[test]
    fn the_opt_out_list_never_forgets_a_live_or_recent_run() {
        let now = 100 * FORGET_AFTER_MS;
        let m = json!({"old-done": 1, "old-live": 2, "new": now - 1000, "keep": 3, "older-done": 0}).as_object().unwrap().clone();
        let busy: HashSet<String> = ["old-live".to_string()].into();
        assert!(forgettable_opt_outs(&m, &busy, "keep", now, 5).is_empty(), "under the cap nothing goes");
        let gone = forgettable_opt_outs(&m, &busy, "keep", now, 3);
        assert_eq!(gone, ["older-done", "old-done"], "oldest first, only as many as needed");
        let gone = forgettable_opt_outs(&m, &busy, "keep", now, 0);
        assert!(!gone.contains(&"old-live".to_string()) && !gone.contains(&"new".to_string()) && !gone.contains(&"keep".to_string()));
    }
}
