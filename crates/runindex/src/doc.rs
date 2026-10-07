//! One run as the search index and the brief see it: the facts of a JSONL event log folded into a flat document.
//! Everything that is text goes through `scrub` (the runner's masker and the checks crate's secret redactor) before it is
//! stored, so a secret that slipped into a prompt or a tool output never reaches the index, a snippet or the state file.

use std::collections::{BTreeMap, BTreeSet};

use intely_agent_core::events::types::{AgentEvent, EventKind, StopReason, ToolStatus};
use serde::{Deserialize, Serialize};

/// Longest single prompt or reply kept, in characters.
const MAX_TEXT: usize = 8_000;
/// Budget for all replies of one run, in bytes; later replies are dropped (`truncated`).
const MAX_REPLY_BYTES: usize = 300_000;
const MAX_PROMPTS: usize = 40;
const MAX_FILES: usize = 400;
const MAX_TOOLS: usize = 80;

/// `runs/<id>.meta.json` as far as the index needs it (the host writes more; unknown fields are ignored).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaFile {
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub repos: Vec<MetaRepo>,
    #[serde(default)]
    pub started_at: u64,
    #[serde(default)]
    pub snapshots: Vec<MetaSnapshot>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaRepo {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaSnapshot {
    #[serde(default)]
    pub repo_id: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub ref_name: String,
}

/// The searchable shape of a run. Texts are already scrubbed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDoc {
    pub id: String,
    pub title: String,
    pub role: String,
    pub model: String,
    pub repo_ids: Vec<String>,
    /// `running` | `done` | `failed` | `cancelled`
    pub status: String,
    pub started_ms: u64,
    pub ended_ms: u64,
    pub prompts: Vec<String>,
    pub replies: Vec<String>,
    pub tools: Vec<String>,
    pub files: Vec<String>,
    /// The last cumulative cost the provider reported; absent when no usage event carried one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    pub events: u64,
    #[serde(default)]
    pub truncated: bool,
}

/// Masks secret shapes and strips control sequences. Idempotent.
pub fn scrub(text: &str) -> String {
    intely_checks::secrets::redact(&intely_runner::mask::mask(text))
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

fn first_line(text: &str, max: usize) -> String {
    clip(text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or(""), max)
}

/// Path-like string fields of a tool input (Claude and ACP spellings).
pub fn input_paths(input: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    for key in ["file_path", "filePath", "path", "notebook_path", "file"] {
        if let Some(s) = input.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty() && s.len() < 400) {
            out.push(s.to_owned());
        }
    }
    out
}

/// Folds a run's events into a document. `meta` fills role, model and repos the log cannot say.
pub fn extract(id: &str, events: &[AgentEvent], meta: Option<&MetaFile>) -> RunDoc {
    let mut doc = RunDoc { id: id.to_owned(), events: events.len() as u64, ..RunDoc::default() };
    if let Some(m) = meta {
        doc.role = m.role.clone();
        doc.model = m.model.clone();
        doc.repo_ids = m.repos.iter().map(|r| r.id.clone()).filter(|r| !r.is_empty()).collect();
        doc.started_ms = m.started_at;
    }
    let mut tools = BTreeSet::new();
    let mut tool_order: Vec<String> = Vec::new();
    let mut files = BTreeSet::new();
    let mut file_order: Vec<String> = Vec::new();
    let mut deltas: BTreeMap<String, String> = BTreeMap::new();
    let mut done_ids: BTreeSet<String> = BTreeSet::new();
    let mut reply_ids: Vec<String> = Vec::new();
    let mut reply_text: BTreeMap<String, String> = BTreeMap::new();
    let mut title: Option<String> = None;
    let mut last_stop: Option<StopReason> = None;
    let mut errored_since_end = false;
    let mut reply_bytes = 0usize;
    for e in events {
        if doc.started_ms == 0 {
            doc.started_ms = e.ts;
        }
        doc.ended_ms = doc.ended_ms.max(e.ts);
        match &e.kind {
            EventKind::SessionStarted { model, .. } => {
                if doc.model.is_empty() {
                    doc.model = model.clone();
                }
            }
            EventKind::SessionInfo { title: t, .. } => {
                if let Some(t) = t.as_ref().filter(|t| !t.trim().is_empty()) {
                    title = Some(scrub(&first_line(t, 120)));
                }
            }
            EventKind::UserMessage { text, .. } => {
                if doc.prompts.len() < MAX_PROMPTS {
                    doc.prompts.push(clip(&scrub(text), MAX_TEXT));
                } else {
                    doc.truncated = true;
                }
            }
            EventKind::TextDelta { message_id, text, .. } => {
                deltas.entry(message_id.clone()).or_default().push_str(text);
                if !reply_ids.contains(message_id) {
                    reply_ids.push(message_id.clone());
                }
            }
            EventKind::TextDone { message_id, text, .. } => {
                done_ids.insert(message_id.clone());
                reply_text.insert(message_id.clone(), text.clone());
                if !reply_ids.contains(message_id) {
                    reply_ids.push(message_id.clone());
                }
            }
            EventKind::ToolStart { name, input, .. } => {
                if tools.insert(name.clone()) && tool_order.len() < MAX_TOOLS {
                    tool_order.push(scrub(&clip(name, 80)));
                }
                for p in input_paths(input) {
                    let p = scrub(&p);
                    if file_order.len() < MAX_FILES && files.insert(p.clone()) {
                        file_order.push(p);
                    }
                }
            }
            EventKind::ToolResult { diff: Some(d), .. } => {
                let p = scrub(&d.path);
                if file_order.len() < MAX_FILES && files.insert(p.clone()) {
                    file_order.push(p);
                }
            }
            EventKind::Usage { usage } => {
                if let Some(c) = usage.cumulative.cost_usd {
                    doc.cost_usd = Some(c);
                }
                if doc.model.is_empty() {
                    doc.model = usage.model.clone();
                }
            }
            EventKind::Error { retryable, .. } => {
                if !*retryable {
                    errored_since_end = true;
                }
            }
            EventKind::TurnEnd { stop_reason } => {
                last_stop = Some(*stop_reason);
                errored_since_end = false;
            }
            _ => {}
        }
    }
    for id in reply_ids {
        let text = if done_ids.contains(&id) { reply_text.remove(&id) } else { deltas.remove(&id) };
        let Some(text) = text.filter(|t| !t.trim().is_empty()) else { continue };
        let text = clip(&scrub(&text), MAX_TEXT);
        if reply_bytes + text.len() > MAX_REPLY_BYTES {
            doc.truncated = true;
            break;
        }
        reply_bytes += text.len();
        doc.replies.push(text);
    }
    doc.tools = tool_order;
    doc.files = file_order;
    doc.status = match (last_stop, errored_since_end) {
        (_, true) => "failed",
        (Some(StopReason::EndTurn), _) => "done",
        (Some(StopReason::Cancelled), _) => "cancelled",
        (Some(_), _) => "failed",
        (None, _) => "running",
    }
    .to_owned();
    doc.title = title.or_else(|| doc.prompts.first().map(|p| first_line(p, 80))).filter(|t| !t.is_empty()).unwrap_or_else(|| doc.role.clone());
    doc
}

/// A tool result error line for the brief: `Edit: <first line of the output>`.
pub fn is_error(status: ToolStatus) -> bool {
    matches!(status, ToolStatus::Error)
}

/// Parses a JSONL event log leniently: a torn tail, an empty line or a line of another shape is skipped.
pub fn parse_log(text: &str) -> Vec<AgentEvent> {
    text.lines().filter(|l| !l.trim().is_empty()).filter_map(|l| serde_json::from_str::<AgentEvent>(l).ok()).collect()
}
