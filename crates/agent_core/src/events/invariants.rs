//! Invariants of a normalized event stream, checked by the golden harness and by the mock (providers-plan 1.5):
//! `seq` strictly +1 per agent starting at 1, every `tool.start` ends in a `tool.result`
//! (a synthesized `cancelled` one on interrupt), every turn ends with exactly one `turn.end`.
//! Pending permission requests must be resolved (`cancelled` counts) before the turn ends.
//!
//! A turn is the run of turn-scoped events (text, thinking, tool, permission, question, plan) up to its
//! `turn.end`; `session.*`, `status`, `usage` and `error` belong to no turn. The TypeScript mirror
//! (`packages/protocol/src/invariants.ts`) must behave identically: both replay `samples::cases()`.

use std::collections::{BTreeMap, BTreeSet};

#[cfg(feature = "specta")]
use specta_typescript::Number;

use super::types::{AgentEvent, EventKind};

wire_enums! {
    pub enum ViolationCode {
        /// `seq` jumped forward.
        SeqGap,
        /// `seq` repeated or went backwards.
        SeqRepeat,
        ToolStartDuplicate,
        /// `tool.update` / `tool.result` for a tool that is not open.
        ToolResultWithoutStart,
        ToolUnclosed,
        PermissionUnresolved,
        ResolvedWithoutRequest,
        DuplicateTurnEnd,
        EventAfterTurnEnd,
        MissingTurnEnd,
    }
}

wire_types! {
    #[serde(rename_all = "camelCase")]
    pub struct Violation {
        pub agent_id: String,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub seq: u64,
        pub code: ViolationCode,
        pub detail: String,
    }
}

#[derive(Default)]
struct AgentState {
    next_seq: u64,
    last_seq: u64,
    open_tools: BTreeSet<String>,
    closed_tools: BTreeSet<String>,
    pending_permissions: BTreeSet<String>,
    /// `Some(id)` while a turn is open (`id` may be absent on the events).
    open_turn: Option<Option<String>>,
    ended_turns: BTreeSet<String>,
    last_was_turn_end: bool,
}

pub struct InvariantChecker {
    first_seq: u64,
    agents: BTreeMap<String, AgentState>,
}

impl Default for InvariantChecker {
    fn default() -> Self {
        Self::new()
    }
}

fn turn_scoped(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::UserMessage { .. }
            | EventKind::TextDelta { .. }
            | EventKind::TextDone { .. }
            | EventKind::ThinkingDelta { .. }
            | EventKind::ToolStart { .. }
            | EventKind::ToolUpdate { .. }
            | EventKind::ToolResult { .. }
            | EventKind::PermissionRequest { .. }
            | EventKind::PermissionResolved { .. }
            | EventKind::QuestionRequest { .. }
            | EventKind::Plan { .. }
    )
}

impl InvariantChecker {
    /// Expects every agent's first event to have `seq` 1.
    pub fn new() -> Self {
        Self { first_seq: 1, agents: BTreeMap::new() }
    }

    /// For a stream that starts mid-run.
    pub fn with_first_seq(first_seq: u64) -> Self {
        Self { first_seq, agents: BTreeMap::new() }
    }

    /// Feeds one event; returns what it violates (empty when fine).
    pub fn push(&mut self, e: &AgentEvent) -> Vec<Violation> {
        let first = self.first_seq;
        let st = self.agents.entry(e.agent_id.clone()).or_insert_with(|| AgentState { next_seq: first, ..AgentState::default() });
        let mut out = Vec::new();
        let mut bad = |code: ViolationCode, detail: String| {
            out.push(Violation { agent_id: e.agent_id.clone(), seq: e.seq, code, detail });
        };

        if e.seq != st.next_seq {
            let code = if e.seq > st.next_seq { ViolationCode::SeqGap } else { ViolationCode::SeqRepeat };
            bad(code, format!("expected seq {}, got {}", st.next_seq, e.seq));
        }
        st.next_seq = e.seq + 1;
        st.last_seq = e.seq;

        let turn_id = e.turn_id.as_deref();
        let after_end = turn_scoped(&e.kind) && turn_id.is_some_and(|id| st.ended_turns.contains(id));
        if after_end {
            bad(ViolationCode::EventAfterTurnEnd, format!("{} after turn {} ended", e.kind.name(), turn_id.unwrap_or_default()));
        } else if turn_scoped(&e.kind) {
            match &st.open_turn {
                None => st.open_turn = Some(turn_id.map(str::to_string)),
                Some(open) if turn_id.is_some() && open.is_some() && open.as_deref() != turn_id => {
                    bad(ViolationCode::MissingTurnEnd, format!("turn {} never ended before {} started", open.as_deref().unwrap_or_default(), turn_id.unwrap_or_default()));
                    st.open_turn = Some(turn_id.map(str::to_string));
                }
                Some(_) => {}
            }
            st.last_was_turn_end = false;
        }

        match &e.kind {
            EventKind::ToolStart { tool_id, .. } => {
                if st.open_tools.contains(tool_id) || st.closed_tools.contains(tool_id) {
                    bad(ViolationCode::ToolStartDuplicate, format!("tool {tool_id} started twice"));
                } else {
                    st.open_tools.insert(tool_id.clone());
                }
            }
            EventKind::ToolUpdate { tool_id, .. } if !st.open_tools.contains(tool_id) => {
                bad(ViolationCode::ToolResultWithoutStart, format!("tool.update for unknown tool {tool_id}"));
            }
            EventKind::ToolResult { tool_id, .. } => {
                if st.open_tools.remove(tool_id) {
                    st.closed_tools.insert(tool_id.clone());
                } else {
                    bad(ViolationCode::ToolResultWithoutStart, format!("tool.result for unknown tool {tool_id}"));
                }
            }
            EventKind::PermissionRequest { req_id, .. } => {
                st.pending_permissions.insert(req_id.clone());
            }
            EventKind::PermissionResolved { req_id, .. } if !st.pending_permissions.remove(req_id) => {
                bad(ViolationCode::ResolvedWithoutRequest, format!("permission.resolved for unknown request {req_id}"));
            }
            EventKind::TurnEnd { .. } => {
                let repeated = turn_id.is_some_and(|id| st.ended_turns.contains(id)) || (st.last_was_turn_end && st.open_turn.is_none());
                if repeated {
                    bad(ViolationCode::DuplicateTurnEnd, "turn.end twice for one turn".to_string());
                }
                if !st.open_tools.is_empty() {
                    bad(ViolationCode::ToolUnclosed, format!("tools still open at turn end: {}", join(&st.open_tools)));
                    st.closed_tools.append(&mut st.open_tools);
                }
                if !st.pending_permissions.is_empty() {
                    bad(ViolationCode::PermissionUnresolved, format!("permission requests still pending at turn end: {}", join(&st.pending_permissions)));
                    st.pending_permissions.clear();
                }
                if let Some(id) = turn_id {
                    st.ended_turns.insert(id.to_string());
                }
                st.open_turn = None;
                st.last_was_turn_end = true;
            }
            _ => {}
        }
        out
    }

    /// End of stream: anything still open is a violation.
    pub fn finish(&self) -> Vec<Violation> {
        let mut out = Vec::new();
        for (agent, st) in &self.agents {
            let mut bad = |code, detail: String| out.push(Violation { agent_id: agent.clone(), seq: st.last_seq, code, detail });
            if let Some(open) = &st.open_turn {
                bad(ViolationCode::MissingTurnEnd, format!("turn {} has no turn.end", open.as_deref().unwrap_or("(unnamed)")));
            }
            if !st.open_tools.is_empty() {
                bad(ViolationCode::ToolUnclosed, format!("tools never closed: {}", join(&st.open_tools)));
            }
            if !st.pending_permissions.is_empty() {
                bad(ViolationCode::PermissionUnresolved, format!("permission requests never resolved: {}", join(&st.pending_permissions)));
            }
        }
        out
    }
}

fn join(set: &BTreeSet<String>) -> String {
    set.iter().cloned().collect::<Vec<_>>().join(", ")
}

/// Checks a whole stream (events of several agents may be interleaved).
pub fn check(events: &[AgentEvent]) -> Vec<Violation> {
    let mut checker = InvariantChecker::new();
    let mut out: Vec<Violation> = events.iter().flat_map(|e| checker.push(e)).collect();
    out.extend(checker.finish());
    out
}
