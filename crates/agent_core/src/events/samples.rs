//! One valid stream with every event kind, and the invariant cases. Both are exported as fixtures
//! (`packages/protocol/fixtures`) so the TypeScript side parses and checks exactly what Rust produced.

use std::collections::BTreeMap;

use serde_json::json;

use super::invariants::ViolationCode;
use super::types::*;
use crate::delegates::{DelegateInfo, DelegateScope};
use crate::policy::decide::{SessionAllowKind, SessionAllowOffer};
use crate::policy::intent::{Actor, ToolIntent};
use crate::providers::{AuthMode, Cap, CapDelta, CapEntry, CapKey, Effort, ModelInfo, PermissionMode, ProviderCaps};
use crate::usage::{CostBasis, ModelTokens, TokenCounts, UsageRecord};

pub fn event(agent: &str, seq: u64, turn: Option<&str>, kind: EventKind) -> AgentEvent {
    AgentEvent {
        agent_id: agent.to_string(),
        seq,
        ts: 1_790_000_000_000 + seq * 40,
        turn_id: turn.map(str::to_string),
        provider: "claude".to_string(),
        kind,
        raw: None,
    }
}

fn text(message_id: &str, text: &str) -> EventKind {
    EventKind::TextDelta { message_id: message_id.into(), text: text.into(), parent_tool_id: None }
}

fn tool_start(tool_id: &str) -> EventKind {
    EventKind::ToolStart { tool_id: tool_id.into(), name: "Bash".into(), tool_kind: ToolKind::Exec, input: json!({"command": "git status"}), parent_tool_id: None }
}

fn tool_result(tool_id: &str, status: ToolStatus) -> EventKind {
    EventKind::ToolResult { tool_id: tool_id.into(), status, output: None, diff: None, duration_ms: None }
}

fn turn_end(reason: StopReason) -> EventKind {
    EventKind::TurnEnd { stop_reason: reason }
}

fn permission_request(req_id: &str) -> EventKind {
    let mut intent = ToolIntent::exec("git status");
    intent.actor = Some(Actor { agent_id: "sub-1".into(), role: "researcher".into() });
    EventKind::PermissionRequest { req_id: req_id.into(), tool_id: "t9".into(), intent, options: vec![PermissionOption::AllowOnce, PermissionOption::AllowRun, PermissionOption::Deny], session_allow: Some(SessionAllowOffer { kind: SessionAllowKind::Exec, scope: "git status".into() }), plan: None, plan_truncated: None, modes: Vec::new() }
}

/// A complete, valid single-agent stream containing every kind exactly once.
pub fn sample_events() -> Vec<AgentEvent> {
    let model = ModelInfo {
        id: "claude-haiku-4-5-20251001".into(),
        label: "Haiku 4.5".into(),
        effort_levels: vec![],
        context_tokens: Some(200_000),
        price: None,
        caps: CapDelta::new(),
    };
    let kinds: Vec<(Option<&str>, EventKind)> = vec![
        (None, EventKind::SessionStarted {
            native_id: Some("5f2c1d7e-0000-4000-8000-000000000001".into()),
            model: model.id.clone(),
            effective: Effective { effort: Some(Effort::High), permission: PermissionMode::Edit, sandbox: None },
            auth: Some(AuthFact { mode: AuthMode::Subscription, source: "none".into(), warning: None }),
            assertions: vec![],
            caps_delta: BTreeMap::from([(CapKey::Effort, CapEntry::with_note(Cap::No, "Haiku 4.5 has no effort control"))]),
        }),
        (None, EventKind::SessionInfo {
            title: Some("Fix the status bar".into()),
            native_id: None,
            models: vec![model],
            caps: Some(ProviderCaps::default()),
            effective: Some(EffectiveChange { model: Some("claude-haiku-4-5-20251001".into()), effort: None, permission: Some(PermissionMode::Edit), reason: Some(ModeChangeReason::User) }),
            delegates: vec![DelegateInfo {
                name: "researcher".into(),
                description: "Reads and searches the code".into(),
                model: "claude-haiku-4-5-20251001".into(),
                effort: None,
                permission: PermissionMode::ReadOnly,
                tools: vec!["Read".into(), "Grep".into(), "Glob".into()],
                disallowed_tools: vec!["Agent".into(), "Task".into()],
                max_turns: Some(25),
                scope: DelegateScope::Global,
                color: Some("#4f9cf9".into()),
            }],
            slash_commands: vec!["compact".into(), "context".into(), "cost".into(), "review".into(), "init".into()],
            mcp_servers: vec![
                McpServerInfo { name: "github".into(), status: McpServerState::Connected, error: None, tools: Some(12) },
                McpServerInfo { name: "docs".into(), status: McpServerState::Failed, error: Some("spawn ENOENT".into()), tools: None },
            ],
        }),
        (Some("t1"), EventKind::UserMessage { message_id: "u1".into(), text: "Fix the status bar".into(), attachments: Vec::new() }),
        (Some("t1"), EventKind::Status { state: StatusState::Thinking, retry_after_ms: None, scope: None }),
        (Some("t1"), EventKind::ThinkingDelta { message_id: "m1".into(), text: "Looking at the repo state first.".into(), parent_tool_id: None }),
        (Some("t1"), text("m2", "Checking ")),
        (Some("t1"), EventKind::TextDone { message_id: "m2".into(), text: "Checking the status.".into(), parent_tool_id: None }),
        (Some("t1"), tool_start("t9")),
        (Some("t1"), permission_request("r1")),
        (Some("t1"), EventKind::PermissionResolved { req_id: "r1".into(), outcome: PermissionOutcome::Allow, by: DecidedBy::User }),
        (Some("t1"), EventKind::ToolUpdate { tool_id: "t9".into(), status: ToolStatus::Running, output: Some("On branch main".into()) }),
        (Some("t1"), EventKind::ToolResult {
            tool_id: "t9".into(),
            status: ToolStatus::Ok,
            output: Some("nothing to commit".into()),
            diff: Some(ToolDiff { path: "src/a.ts".into(), old: Some("a".into()), new: "b".into() }),
            duration_ms: Some(120),
        }),
        (Some("t1"), EventKind::Note {
            note_id: "n1".into(),
            state: NoteState::Delivered,
            parent_tool_id: None,
            text: Some("Use the staging database, not production".into()),
            tool_id: Some("t9".into()),
            reason: None,
        }),
        (Some("t1"), EventKind::QuestionRequest {
            req_id: "q1".into(),
            tool_id: Some("t10".into()),
            prompt: "Which branch?".into(),
            options: vec![QuestionOption { label: "main".into(), description: Some("the default".into()) }, QuestionOption { label: "sandbox".into(), description: None }],
        }),
        (Some("t1"), EventKind::Plan { items: vec![PlanItem { content: "Read status".into(), status: Some("completed".into()) }, PlanItem { content: "Report".into(), status: Some("in_progress".into()) }] }),
        (Some("t1"), EventKind::Usage {
            usage: UsageRecord {
                model: "claude-haiku-4-5-20251001".into(),
                cost_basis: CostBasis::Estimated,
                per_turn: TokenCounts { input_tokens: 1200, output_tokens: 80, cache_read: 900, cache_write: 0, reasoning_tokens: 0, cost_usd: Some(0.0021) },
                cumulative: TokenCounts { input_tokens: 1200, output_tokens: 80, cache_read: 900, cache_write: 0, reasoning_tokens: 0, cost_usd: Some(0.0021) },
                premium_requests: None,
                context_used: Some(2100),
                context_size: Some(200_000),
                per_model: vec![ModelTokens {
                    model: "claude-haiku-4-5-20251001".into(),
                    tokens: TokenCounts { input_tokens: 1200, output_tokens: 80, cache_read: 900, cache_write: 0, reasoning_tokens: 0, cost_usd: Some(0.0021) },
                }],
            },
        }),
        (Some("t1"), EventKind::Error { class: ErrorClass::Rate, message: "429 Too Many Requests".into(), retryable: true }),
        (Some("t1"), turn_end(StopReason::EndTurn)),
    ];
    let mut events: Vec<AgentEvent> = kinds.into_iter().enumerate().map(|(i, (turn, kind))| event("a1", i as u64 + 1, turn, kind)).collect();
    events[5].raw = Some(json!({"type": "stream_event", "delta": {"text": "Checking "}}));
    events
}

pub struct InvariantCase {
    pub name: &'static str,
    pub events: Vec<AgentEvent>,
    pub expect: Vec<ViolationCode>,
}

/// Streams with the violations a checker must report, in order (`check`: events first, then end of stream).
pub fn cases() -> Vec<InvariantCase> {
    use ViolationCode::*;
    // the first event of a stream has seq 1
    let e = |seq: u64, turn, kind| event("a1", seq + 1, turn, kind);
    let case = |name, events, expect| InvariantCase { name, events, expect };
    let gap = vec![e(0, None, EventKind::Status { state: StatusState::Idle, retry_after_ms: None, scope: None }), e(2, None, EventKind::Status { state: StatusState::Idle, retry_after_ms: None, scope: None })];
    let interleaved: Vec<AgentEvent> = (0..3)
        .flat_map(|i| {
            let mk = |agent: &str| {
                let kind = if i == 2 { turn_end(StopReason::EndTurn) } else { text("m1", "x") };
                event(agent, i + 1, Some("t1"), kind)
            };
            [mk("a1"), mk("b1")]
        })
        .collect();
    vec![
        case("valid-sample", sample_events(), vec![]),
        case("valid-two-agents-interleaved", interleaved, vec![]),
        case("valid-cancelled-turn", vec![
            e(0, Some("t1"), tool_start("t1")),
            e(1, Some("t1"), tool_result("t1", ToolStatus::Cancelled)),
            e(2, Some("t1"), turn_end(StopReason::Cancelled)),
        ], vec![]),
        case("seq-gap", gap, vec![SeqGap]),
        case("seq-repeat", vec![e(0, None, text("m", "a")), e(1, None, text("m", "b")), e(1, None, turn_end(StopReason::EndTurn))], vec![SeqRepeat]),
        case("seq-must-start-at-one", vec![event("a1", 2, None, text("m", "a")), event("a1", 3, None, turn_end(StopReason::EndTurn))], vec![SeqGap]),
        case("seq-zero-is-not-the-start", vec![event("a1", 0, None, text("m", "a")), event("a1", 1, None, turn_end(StopReason::EndTurn))], vec![SeqRepeat]),
        case("tool-without-result", vec![e(0, Some("t1"), tool_start("x")), e(1, Some("t1"), turn_end(StopReason::EndTurn))], vec![ToolUnclosed]),
        case("result-without-start", vec![e(0, Some("t1"), tool_result("x", ToolStatus::Ok)), e(1, Some("t1"), turn_end(StopReason::EndTurn))], vec![ToolResultWithoutStart]),
        case("duplicate-tool-start", vec![
            e(0, Some("t1"), tool_start("x")),
            e(1, Some("t1"), tool_start("x")),
            e(2, Some("t1"), tool_result("x", ToolStatus::Ok)),
            e(3, Some("t1"), turn_end(StopReason::EndTurn)),
        ], vec![ToolStartDuplicate]),
        case("double-turn-end", vec![e(0, None, text("m", "a")), e(1, None, turn_end(StopReason::EndTurn)), e(2, None, turn_end(StopReason::EndTurn))], vec![DuplicateTurnEnd]),
        case("double-turn-end-with-id", vec![e(0, Some("t1"), text("m", "a")), e(1, Some("t1"), turn_end(StopReason::EndTurn)), e(2, Some("t1"), turn_end(StopReason::Error))], vec![DuplicateTurnEnd]),
        case("missing-turn-end", vec![e(0, Some("t1"), text("m", "a"))], vec![MissingTurnEnd]),
        case("event-after-turn-end", vec![e(0, Some("t1"), text("m", "a")), e(1, Some("t1"), turn_end(StopReason::EndTurn)), e(2, Some("t1"), text("m", "late"))], vec![EventAfterTurnEnd]),
        case("new-turn-before-old-ended", vec![e(0, Some("t1"), text("m", "a")), e(1, Some("t2"), text("m", "b"))], vec![MissingTurnEnd, MissingTurnEnd]),
        case("unresolved-permission", vec![e(0, Some("t1"), permission_request("r1")), e(1, Some("t1"), turn_end(StopReason::Cancelled))], vec![PermissionUnresolved]),
        case("resolved-without-request", vec![
            e(0, Some("t1"), EventKind::PermissionResolved { req_id: "r9".into(), outcome: PermissionOutcome::Deny, by: DecidedBy::HardStop }),
            e(1, Some("t1"), turn_end(StopReason::EndTurn)),
        ], vec![ResolvedWithoutRequest]),
        case("tool-never-closed-at-end-of-stream", vec![e(0, Some("t1"), tool_start("x"))], vec![MissingTurnEnd, ToolUnclosed]),
    ]
}

/// Claude tool calls with the intent `ToolIntent::from_claude_tool` makes of them; the TypeScript mapping
/// in `packages/protocol` must produce the same.
pub fn intent_cases() -> Vec<(&'static str, serde_json::Value, ToolIntent)> {
    let long = format!("echo {}", "x".repeat(200));
    [
        ("Bash", json!({"command": "git status"})),
        ("Bash", json!({"command": "ls\nrm -rf /tmp/x"})),
        ("Bash", json!({"command": long})),
        ("Bash", json!({})),
        ("Edit", json!({"file_path": "src/a.ts", "old_string": "a", "new_string": "b"})),
        ("Write", json!({"file_path": ".husky/pre-commit", "content": "x"})),
        ("MultiEdit", json!({"file_path": "src/a.ts", "edits": []})),
        ("NotebookEdit", json!({"notebook_path": "n.ipynb"})),
        ("Read", json!({"file_path": "/etc/hosts"})),
        ("Grep", json!({"pattern": "x", "path": "src"})),
        ("Grep", json!({"pattern": "x"})),
        ("Glob", json!({"pattern": "**/*.ts"})),
        ("Glob", json!({"pattern": "/etc/*.conf", "path": "src"})),
        ("Glob", json!({"pattern": "~/.ssh/*"})),
        ("Monitor", json!({"command": "tail -f app.log", "description": "watch"})),
        ("Monitor", json!({"command": "cp /usr/local/bin/git ./gg && ./gg push"})),
        ("RemoteTrigger", json!({"action": "run"})),
        ("LS", json!({"path": "sub"})),
        ("WebFetch", json!({"url": "https://docs.rs/serde", "prompt": "x"})),
        ("WebSearch", json!({"query": "rust serde"})),
        ("Task", json!({"subagent_type": "researcher", "prompt": "x"})),
        ("Agent", json!({"subagent_type": "reviewer"})),
        ("Agent", json!({"subagent_type": "researcher", "model": "opus", "isolation": "worktree", "run_in_background": true, "prompt": "x"})),
        ("Agent", json!({"subagent_type": "researcher", "run_in_background": false})),
        ("TodoWrite", json!({"todos": []})),
        ("ExitPlanMode", json!({})),
        ("AskUserQuestion", json!({})),
        ("mcp__github__get_issue", json!({"number": 5})),
        ("mcp__my_server__do__thing", json!({})),
        ("mcp__broken", json!({})),
        ("SomethingNew", json!({})),
    ]
    .into_iter()
    .map(|(tool, input)| {
        let intent = ToolIntent::from_claude_tool(tool, &input);
        (tool, input, intent)
    })
    .collect()
}
