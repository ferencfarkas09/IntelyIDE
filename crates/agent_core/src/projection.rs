//! Run-status reducer (remote-plan R7): a pure fold over [`AgentEvent`]s that says where a run stands and what waits for
//! the human. The desktop inbox and the Remote gateway use the same function, so the phone never re-implements grouping.

use crate::api::RunStatus;
use crate::events::{AgentEvent, EventKind, StopReason};

const LAST_TEXT_CHARS: usize = 160;

#[derive(Debug, Clone, PartialEq)]
pub struct RunProjection {
    pub agent_id: String,
    pub status: RunStatus,
    pub last_seq: u64,
    /// Request ids (permission or question) the run is waiting on, oldest first.
    pub waiting_on: Vec<String>,
    /// First characters of the latest assistant text, for a one-line list row.
    pub last_text: String,
    pub title: Option<String>,
    /// `(tool id, request id)` of the open requests, so the tool's result closes a question (it has no `resolved` event).
    by_tool: Vec<(String, String)>,
}

impl RunProjection {
    pub fn new(agent_id: &str) -> Self {
        Self { agent_id: agent_id.to_string(), status: RunStatus::Running, last_seq: 0, waiting_on: Vec::new(), last_text: String::new(), title: None, by_tool: Vec::new() }
    }

    pub fn fold(agent_id: &str, events: &[AgentEvent]) -> Self {
        let mut p = Self::new(agent_id);
        events.iter().for_each(|e| p.apply(e));
        p
    }

    pub fn apply(&mut self, e: &AgentEvent) {
        self.last_seq = self.last_seq.max(e.seq);
        match &e.kind {
            EventKind::PermissionRequest { req_id, tool_id, .. } => self.wait(req_id, Some(tool_id)),
            EventKind::QuestionRequest { req_id, tool_id, .. } => self.wait(req_id, tool_id.as_ref()),
            EventKind::PermissionResolved { req_id, .. } => self.waiting_on.retain(|r| r != req_id),
            EventKind::UserMessage { .. } => self.status = RunStatus::Running,
            EventKind::TextDelta { text, parent_tool_id: None, .. } => {
                self.last_text.push_str(text);
                if self.last_text.chars().count() > LAST_TEXT_CHARS {
                    self.last_text = self.last_text.chars().take(LAST_TEXT_CHARS).collect();
                }
            }
            EventKind::TextDone { text, parent_tool_id: None, .. } => self.last_text = text.chars().take(LAST_TEXT_CHARS).collect(),
            EventKind::SessionInfo { title: Some(t), .. } => self.title = Some(t.clone()),
            EventKind::TurnEnd { stop_reason } => {
                // a turn that ended has nothing left to wait for
                self.waiting_on.clear();
                self.by_tool.clear();
                self.status = match stop_reason {
                    StopReason::Error | StopReason::Refusal => RunStatus::Error,
                    _ => RunStatus::Done,
                };
            }
            EventKind::Error { retryable: false, .. } => self.status = RunStatus::Error,
            EventKind::ToolResult { tool_id, .. } => {
                // the tool finished, so its question or permission is over (a question has no `resolved` event)
                let closed: Vec<String> = self.by_tool.iter().filter(|(t, _)| t == tool_id).map(|(_, r)| r.clone()).collect();
                self.by_tool.retain(|(t, _)| t != tool_id);
                self.waiting_on.retain(|r| !closed.contains(r));
            }
            _ => {}
        }
        if !self.waiting_on.is_empty() && !matches!(self.status, RunStatus::Done | RunStatus::Error) {
            self.status = RunStatus::NeedsYou;
        } else if self.waiting_on.is_empty() && self.status == RunStatus::NeedsYou {
            self.status = RunStatus::Running;
        }
    }
}

impl RunProjection {
    fn wait(&mut self, req_id: &str, tool_id: Option<&String>) {
        if !self.waiting_on.iter().any(|r| r == req_id) {
            self.waiting_on.push(req_id.to_string());
        }
        if let Some(t) = tool_id {
            self.by_tool.push((t.clone(), req_id.to_string()));
        }
    }
}
