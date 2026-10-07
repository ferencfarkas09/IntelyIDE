//! Fixture run logs: typed events written as JSONL into a temp `runs/` directory, the way the host does.

#![allow(dead_code)]

use std::fs;
use std::path::Path;

use intely_agent_core::events::samples::event;
use intely_agent_core::events::types::*;
use intely_agent_core::policy::intent::ToolIntent;
use intely_agent_core::usage::{CostBasis, TokenCounts, UsageRecord};
use serde_json::json;

pub const TOKEN: &str = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

pub struct Log {
    id: String,
    seq: u64,
    pub events: Vec<AgentEvent>,
}

impl Log {
    pub fn new(id: &str) -> Self {
        Self { id: id.into(), seq: 0, events: Vec::new() }
    }

    pub fn push(&mut self, kind: EventKind) -> &mut Self {
        self.seq += 1;
        self.events.push(event(&self.id, self.seq, Some("t1"), kind));
        self
    }

    pub fn prompt(&mut self, text: &str) -> &mut Self {
        self.push(EventKind::UserMessage { message_id: format!("u{}", self.seq), text: text.into(), attachments: vec![] })
    }

    pub fn reply(&mut self, text: &str) -> &mut Self {
        self.push(EventKind::TextDone { message_id: format!("a{}", self.seq), text: text.into(), parent_tool_id: None })
    }

    pub fn tool(&mut self, tool_id: &str, name: &str, kind: ToolKind, input: serde_json::Value, status: ToolStatus, output: Option<&str>) -> &mut Self {
        self.push(EventKind::ToolStart { tool_id: tool_id.into(), name: name.into(), tool_kind: kind, input, parent_tool_id: None });
        self.push(EventKind::ToolResult { tool_id: tool_id.into(), status, output: output.map(Into::into), diff: None, duration_ms: Some(5) })
    }

    pub fn edit(&mut self, tool_id: &str, path: &str) -> &mut Self {
        self.push(EventKind::ToolStart { tool_id: tool_id.into(), name: "Edit".into(), tool_kind: ToolKind::Edit, input: json!({ "file_path": path }), parent_tool_id: None });
        self.push(EventKind::ToolResult { tool_id: tool_id.into(), status: ToolStatus::Ok, output: None, diff: Some(ToolDiff { path: path.into(), old: Some("a".into()), new: "b".into() }), duration_ms: Some(5) })
    }

    pub fn usage(&mut self, cost: Option<f64>, input: u32, output: u32) -> &mut Self {
        let counts = TokenCounts { input_tokens: input, output_tokens: output, cache_read: 0, cache_write: 0, reasoning_tokens: 0, cost_usd: cost };
        self.push(EventKind::Usage { usage: UsageRecord { model: "claude-haiku-4-5-20251001".into(), cost_basis: CostBasis::Estimated, per_turn: counts.clone(), cumulative: counts, premium_requests: None, context_used: Some(input), context_size: Some(200_000), per_model: Vec::new() } })
    }

    pub fn end(&mut self, reason: StopReason) -> &mut Self {
        self.push(EventKind::TurnEnd { stop_reason: reason })
    }

    pub fn permission(&mut self, req_id: &str, tool_id: &str, command: &str) -> &mut Self {
        self.push(EventKind::PermissionRequest { req_id: req_id.into(), tool_id: tool_id.into(), intent: ToolIntent::exec(command), options: vec![PermissionOption::AllowOnce, PermissionOption::Deny], session_allow: None, plan: None, plan_truncated: None, modes: Vec::new() })
    }

    pub fn jsonl(&self) -> String {
        self.events.iter().map(|e| serde_json::to_string(e).unwrap()).collect::<Vec<_>>().join("\n") + "\n"
    }

    /// Writes `<runs>/<id>.jsonl` and, when given, `<runs>/<id>.meta.json`.
    pub fn write(&self, runs: &Path, meta: Option<serde_json::Value>) {
        fs::create_dir_all(runs).unwrap();
        fs::write(runs.join(format!("{}.jsonl", self.id)), self.jsonl()).unwrap();
        if let Some(m) = meta {
            fs::write(runs.join(format!("{}.meta.json", self.id)), serde_json::to_vec(&m).unwrap()).unwrap();
        }
    }
}

pub fn meta(role: &str, repos: &[&str], started: u64) -> serde_json::Value {
    json!({ "agentId": "x", "provider": "claude", "role": role, "model": "claude-haiku-4-5-20251001", "permission": "plan", "repos": repos.iter().map(|r| json!({ "id": r, "path": format!("/nowhere/{r}") })).collect::<Vec<_>>(), "startedAt": started, "snapshots": [] })
}

/// A finished run that edited two files, with usage.
pub fn finished(id: &str, prompt: &str) -> Log {
    let mut l = Log::new(id);
    l.prompt(prompt)
        .tool("r1", "Read", ToolKind::Read, json!({ "file_path": "src/orders/total.js" }), ToolStatus::Ok, Some("ok"))
        .edit("e1", "src/orders/total.js")
        .reply("Fixed the delivery fee rounding in the order total.")
        .usage(Some(0.0123), 4_000, 900)
        .end(StopReason::EndTurn);
    l
}
