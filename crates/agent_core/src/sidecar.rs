//! Sidecar <-> Rust messages: NDJSON over stdio, envelope `{"v":1,"id":N,"type":"...","body":{...}}`
//! (providers-plan 5.5). Failing closed is part of the contract: no reply within
//! [`POLICY_REPLY_TIMEOUT_MS`], a malformed reply or a closed pipe means deny.

use std::collections::BTreeMap;
use std::fmt;

#[cfg(feature = "specta")]
use specta_typescript::{Number, Unknown};

use crate::delegates::DelegateSpec;
use crate::events::types::{BatchEvent, McpServerStatus, PermissionOutcome, StopReason};
use crate::mcp::McpWire;
use crate::policy::decide::PolicyDecision;
use crate::policy::intent::PolicyRequest;
use crate::providers::{AuthMode, Effort, PermissionMode};

pub const PROTOCOL_VERSION: u8 = 1;
pub const HEARTBEAT_MS: u32 = 2000;
pub const POLICY_REPLY_TIMEOUT_MS: u32 = 2000;
pub const LEASE_TTL_MS: u32 = 15_000;
pub const BATCH_MAX_EVENTS: u32 = 64;
pub const BATCH_MAX_MS: u32 = 33;
pub const CANCEL_SOFT_MS: u32 = 5000;
pub const CANCEL_TERM_MS: u32 = 3000;

/// An API key in flight. Never logged: `Debug` prints a placeholder.
#[derive(Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(***)")
    }
}

wire_enums! {
    /// Where the Claude CLI may read settings from; `[]` (isolated) unless a suite proves otherwise.
    pub enum SettingSource {
        User,
        Project,
        Local,
    }
}

wire_types! {
    /// The role after the Roles layer resolved model and effort.
    #[serde(rename_all = "camelCase")]
    pub struct ResolvedRole {
        pub name: String,
        pub model: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub effort: Option<Effort>,
        /// The run mode (the host overrides the role's own permission with `Meta.permission`). Refused by non-Claude adapters
        /// when `automatic` or `bypass`.
        pub permission: PermissionMode,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub system_prompt: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub tools: Vec<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub disallowed_tools: Vec<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub max_turns: Option<u32>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub max_budget_usd: Option<f64>,
    }

    /// Key hand-off: from the `KeySource`, in memory, never argv or the sidecar's own env.
    #[serde(rename_all = "camelCase")]
    pub struct AuthHandoff {
        pub mode: AuthMode,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub key: Option<Secret>,
    }

    /// Paths and base environment Rust supplies; the sidecar scrubs `vars` again.
    #[serde(rename_all = "camelCase")]
    pub struct SessionEnv {
        /// The installed claude CLI (`pathToClaudeCodeExecutable`).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub claude_bin: Option<String>,
        /// The Codex CLI the user confirmed (or discovery found); the Codex adapter runs `<codexBin> app-server`.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub codex_bin: Option<String>,
        /// Allow-list git shim directory, put first in PATH.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub shim_dir: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub vars: Option<BTreeMap<String, String>>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ResumeRef {
        pub native_id: String,
    }

    /// `session/start.acp` (ACP adapters): a user-confirmed command line, or overrides for a profile (`gemini`), and the
    /// write switch. Without `write_allowed` the adapter opens read-only roles only.
    #[serde(rename_all = "camelCase")]
    pub struct AcpLaunch {
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub command: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub args: Option<Vec<String>>,
        /// Extra variables for the agent process (after the scrub).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub env: Option<BTreeMap<String, String>>,
        /// Set only when the computed enforcement chip of (adapter, auth mode, role mode, CLI version) lets a write role open.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub write_allowed: Option<bool>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub init_timeout_ms: Option<u32>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub term_ms: Option<u32>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct SessionStart {
        pub agent_id: String,
        pub provider: String,
        pub role: ResolvedRole,
        pub cwd: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub add_dirs: Vec<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub resume: Option<ResumeRef>,
        /// Pre-assigned native session id for a new session (Claude).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub session_id: Option<String>,
        pub env: SessionEnv,
        /// The IDE's MCP set (server name -> config), passed through untouched. `McpWire` prints `[redacted]` under `{:?}`: it holds
        /// resolved secrets, and its type is the same one from the supplier to the pipe.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional, type = Unknown))]
        pub mcp: Option<McpWire>,
        pub auth: AuthHandoff,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub writer: Option<bool>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub repo_id: Option<String>,
        /// First `seq` of this session (continues the agent's log after a resume); default 1.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional, type = Number))]
        pub next_seq: Option<u64>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub setting_sources: Option<Vec<SettingSource>>,
        /// Ablation switch of the enforcement suite; Rust never sets it in production.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub deny_rules: Option<bool>,
        /// Mock adapter only.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional, type = Unknown))]
        pub mock: Option<serde_json::Value>,
        /// ACP adapters only (`acp`, `gemini`).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub acp: Option<AcpLaunch>,
        /// The roles an Auto lead may hand work to (Claude and the mock adapter only). `None` = no delegation: the classic
        /// single-role run, and a request that serialises exactly as before.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub delegates: Option<Vec<DelegateSpec>>,
        /// Where the CLI keeps its plan notes (an absolute path; Claude only). `None` = the CLI default (never in production).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub plan_dir: Option<String>,
        /// `Some(false)` = leave the user's own `~/.claude/CLAUDE.md` out of the prompt (`agents.includeUserMemory` off; Claude only).
        /// `None` = the sidecar default (on), and a request that serialises exactly as before.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub include_user_memory: Option<bool>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct SlotAcquire {
        pub agent_id: String,
        pub provider: String,
        pub writer: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub repo_id: Option<String>,
        pub ttl_ms: u32,
    }

    #[serde(rename_all = "camelCase")]
    pub struct LeaseGrant {
        pub lease_id: String,
        pub ttl_ms: u32,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub tree_budget_mb: Option<u32>,
    }

    /// `slot/acquire`: `noSlot | rssBudget | writeLease`; `session/start`: `providerDisabled | loadFailed |
    /// duplicate | noSlot | rssBudget | writeLease | open`; `session/prompt`: `noSession | turnOpen`.
    #[serde(rename_all = "camelCase")]
    pub struct ReplyError {
        pub error: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub detail: Option<String>,
    }

    /// Reply to `session/start`.
    #[serde(rename_all = "camelCase")]
    pub struct SessionStarted {
        pub ok: bool,
        pub native_id: String,
    }

    /// Plain acknowledgement.
    #[serde(rename_all = "camelCase")]
    pub struct Acknowledged {
        pub ok: bool,
    }

    /// Reply to `session/mcp-status`.
    #[serde(rename_all = "camelCase")]
    pub struct McpStatusReply {
        pub ok: bool,
        pub servers: Vec<McpServerStatus>,
    }

    /// Toggle one MCP server of a live session.
    #[serde(rename_all = "camelCase")]
    pub struct McpToggle {
        pub server: String,
        pub enabled: bool,
    }

    /// Replies are matched to requests by `id`, so the body carries no type of its own.
    #[serde(untagged)]
    pub enum Reply {
        Error(ReplyError),
        Decision(PolicyDecision),
        Lease(LeaseGrant),
        Started(SessionStarted),
        McpStatus(McpStatusReply),
        Ack(Acknowledged),
    }

    #[serde(tag = "type", content = "body", rename_all_fields = "camelCase")]
    pub enum SidecarBody {
        #[serde(rename = "hello")]
        Hello { pid: u32, version: String, node: String, providers: Vec<String> },
        /// Also renews every lease of that sidecar.
        #[serde(rename = "heartbeat")]
        Heartbeat { pid: u32, loaded: Vec<String>, sessions: u32 },
        #[serde(rename = "policy/decide")]
        PolicyDecide(PolicyRequest),
        #[serde(rename = "slot/acquire")]
        SlotAcquire(SlotAcquire),
        #[serde(rename = "slot/renew")]
        SlotRenew {
            lease_id: String,
            #[serde(default)]
            pgids: Vec<u32>,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            rss_hint_mb: Option<u32>,
        },
        #[serde(rename = "slot/release")]
        SlotRelease { lease_id: String },
        #[serde(rename = "events/batch")]
        EventsBatch { agent_id: String, provider: String, events: Vec<BatchEvent> },
        #[serde(rename = "session/start")]
        SessionStart(SessionStart),
        #[serde(rename = "session/prompt")]
        SessionPrompt { agent_id: String, text: String },
        #[serde(rename = "session/close")]
        SessionClose { agent_id: String },
        /// Live permission-mode switch of a session (Claude and the mock adapter). Replies `Acknowledged { ok: true }` or a `ReplyError`
        /// with `noSession`, `unsupported`, `rejected` or `timeout`.
        #[serde(rename = "session/permission")]
        SessionPermission { agent_id: String, mode: PermissionMode },
        /// Live MCP status of a session (the SDK's `mcpServerStatus()`), optionally after reconnecting or toggling one server. Replies
        /// `McpStatusReply` or a `ReplyError` with `noSession`, `unsupported` or `failed`.
        #[serde(rename = "session/mcp-status")]
        SessionMcpStatus {
            agent_id: String,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            reconnect: Option<String>,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            toggle: Option<McpToggle>,
        },
        #[serde(rename = "cancel/request")]
        CancelRequest { agent_id: String, soft_ms: u32, term_ms: u32 },
        /// Sidecar -> Rust, after the turn ended (or the soft deadline passed).
        #[serde(rename = "cancel/done")]
        CancelDone { agent_id: String, stop_reason: StopReason, ms: u32 },
        #[serde(rename = "permission/answer")]
        PermissionAnswer {
            agent_id: String,
            req_id: String,
            outcome: PermissionOutcome,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            message: Option<String>,
            /// `AskUserQuestion`: question text -> chosen label.
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            answers: Option<BTreeMap<String, String>>,
            /// ExitPlanMode approval only: the mode the run continues in. The host has already validated it and set it in Rust.
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            mode: Option<PermissionMode>,
        },
        #[serde(rename = "reply")]
        Reply(Reply),
    }

    #[serde(rename_all = "camelCase")]
    pub struct SidecarMsg {
        pub v: u8,
        pub id: u32,
        #[serde(flatten)]
        pub body: SidecarBody,
    }
}

impl SidecarBody {
    /// The `type` string on the wire.
    pub fn type_name(&self) -> &'static str {
        match self {
            SidecarBody::Hello { .. } => "hello",
            SidecarBody::Heartbeat { .. } => "heartbeat",
            SidecarBody::PolicyDecide(_) => "policy/decide",
            SidecarBody::SlotAcquire(_) => "slot/acquire",
            SidecarBody::SlotRenew { .. } => "slot/renew",
            SidecarBody::SlotRelease { .. } => "slot/release",
            SidecarBody::EventsBatch { .. } => "events/batch",
            SidecarBody::SessionStart(_) => "session/start",
            SidecarBody::SessionPrompt { .. } => "session/prompt",
            SidecarBody::SessionClose { .. } => "session/close",
            SidecarBody::SessionPermission { .. } => "session/permission",
            SidecarBody::SessionMcpStatus { .. } => "session/mcp-status",
            SidecarBody::CancelRequest { .. } => "cancel/request",
            SidecarBody::CancelDone { .. } => "cancel/done",
            SidecarBody::PermissionAnswer { .. } => "permission/answer",
            SidecarBody::Reply(_) => "reply",
        }
    }
}

impl SidecarMsg {
    pub fn new(id: u32, body: SidecarBody) -> Self {
        Self { v: PROTOCOL_VERSION, id, body }
    }
}

/// One JSON message of every `type` (replies in each shape), shared by the Rust round-trip test and the
/// TypeScript tests through `packages/protocol/fixtures/sidecar-messages.json`.
pub fn sample_messages() -> Vec<serde_json::Value> {
    use serde_json::json;
    let events: Vec<serde_json::Value> = crate::events::samples::sample_events()
        .iter()
        .take(2)
        .map(|e| serde_json::to_value(e.to_batch()).unwrap_or_default())
        .collect();
    vec![
        json!({"v":1,"id":1,"type":"hello","body":{"pid":4242,"version":"0.0.0","node":"v24.1.0","providers":["claude","mock"]}}),
        json!({"v":1,"id":2,"type":"heartbeat","body":{"pid":4242,"loaded":["claude"],"sessions":1}}),
        json!({"v":1,"id":41,"type":"policy/decide","body":{"agentId":"a1","toolId":"t9","provider":"claude","intent":{"class":"exec","paths":[],"rawCommand":"/usr/bin/git push origin HEAD","summary":"push"}}}),
        json!({"v":1,"id":41,"type":"reply","body":{"decision":"deny","by":"hardStop","reason":"git push is human-only"}}),
        json!({"v":1,"id":52,"type":"policy/decide","body":{"agentId":"a1","toolId":"t10","provider":"claude","intent":{
            "class":"write","tool":"Edit","paths":["src/a.ts"],"summary":"edit src/a.ts","actor":{"agentId":"agent-7","role":"researcher"}
        }}}),
        json!({"v":1,"id":53,"type":"policy/decide","body":{"agentId":"a1","toolId":"t11","provider":"claude","intent":{
            "class":"other","tool":"Agent","paths":[],"subagentType":"researcher","isolation":"worktree",
            "subagentFlags":{"hasModel":true,"background":true,"subagentType":"researcher"},"summary":"Agent"
        }}}),
        json!({"v":1,"id":42,"type":"slot/acquire","body":{"agentId":"a1","provider":"claude","writer":true,"repoId":"admin","ttlMs":15000}}),
        json!({"v":1,"id":42,"type":"reply","body":{"leaseId":"L7","ttlMs":15000,"treeBudgetMb":650}}),
        json!({"v":1,"id":42,"type":"reply","body":{"error":"noSlot","detail":"3/3 slots in use"}}),
        json!({"v":1,"id":43,"type":"slot/renew","body":{"leaseId":"L7","pgids":[48211],"rssHintMb":212}}),
        json!({"v":1,"id":43,"type":"reply","body":{"ok":true}}),
        json!({"v":1,"id":44,"type":"slot/release","body":{"leaseId":"L7"}}),
        json!({"v":1,"id":45,"type":"events/batch","body":{"agentId":"a1","provider":"claude","events":events}}),
        json!({"v":1,"id":46,"type":"session/start","body":{
            "agentId":"a1","provider":"claude",
            "role":{"name":"developer","model":"claude-haiku-4-5-20251001","permission":"edit","tools":[],"disallowedTools":[]},
            "cwd":"/work/repo","addDirs":[],"env":{"claudeBin":"/usr/local/bin/claude","shimDir":"/x/shim","vars":{"PATH":"/usr/bin"}},
            "auth":{"mode":"apiKey"},"writer":true,"repoId":"admin","nextSeq":1,"settingSources":[],"mcp":{"github":{"command":"x"}}
        }}),
        json!({"v":1,"id":54,"type":"session/start","body":{
            "agentId":"a2","provider":"claude",
            "role":{"name":"auto","model":"claude-sonnet-5-5","effort":"medium","permission":"edit","tools":[],"disallowedTools":[]},
            "cwd":"/work/repo","addDirs":[],"env":{"claudeBin":"/usr/local/bin/claude"},"auth":{"mode":"subscription"},"writer":true,"repoId":"admin",
            "planDir":"/x/plans",
            "delegates":[{
                "name":"researcher","description":"Reads and searches the code","prompt":"Answer from the code.","model":"claude-haiku-4-5-20251001",
                "permission":"readOnly","tools":["Read","Grep","Glob"],"disallowedTools":["Agent","Task"],"maxTurns":25,"scope":"global","color":"#4f9cf9"
            },{
                "name":"developer","description":"Implements a change","prompt":"Make the change.","model":"claude-sonnet-5-5","effort":"medium",
                "permission":"edit","tools":[],"disallowedTools":["Agent","Task"],"maxTurns":25,"scope":"builtin"
            }]
        }}),
        json!({"v":1,"id":46,"type":"reply","body":{"ok":true,"nativeId":"5f2c1d7e-0000-4000-8000-000000000001"}}),
        json!({"v":1,"id":47,"type":"session/prompt","body":{"agentId":"a1","text":"hello"}}),
        json!({"v":1,"id":48,"type":"session/close","body":{"agentId":"a1"}}),
        json!({"v":1,"id":49,"type":"cancel/request","body":{"agentId":"a1","softMs":5000,"termMs":3000}}),
        json!({"v":1,"id":50,"type":"cancel/done","body":{"agentId":"a1","stopReason":"cancelled","ms":812}}),
        json!({"v":1,"id":51,"type":"permission/answer","body":{"agentId":"a1","reqId":"r1","outcome":"allow","message":"ok","answers":{"Which branch?":"main"}}}),
        json!({"v":1,"id":60,"type":"session/permission","body":{"agentId":"a1","mode":"automatic"}}),
        json!({"v":1,"id":60,"type":"reply","body":{"ok":true}}),
        json!({"v":1,"id":61,"type":"reply","body":{"error":"unsupported","detail":"codex has no live permission switch"}}),
        json!({"v":1,"id":63,"type":"session/mcp-status","body":{"agentId":"a1"}}),
        json!({"v":1,"id":64,"type":"session/mcp-status","body":{"agentId":"a1","reconnect":"github"}}),
        json!({"v":1,"id":65,"type":"session/mcp-status","body":{"agentId":"a1","toggle":{"server":"github","enabled":false}}}),
        json!({"v":1,"id":63,"type":"reply","body":{"ok":true,"servers":[
            {"name":"github","status":"connected","tools":[{"name":"search_issues","description":"Search issues"},{"name":"get_issue"}]},
            {"name":"docs","status":"failed","error":"spawn ENOENT","tools":[]},
            {"name":"linear","status":"needsAuth","tools":[]}
        ]}}),
        json!({"v":1,"id":62,"type":"permission/answer","body":{"agentId":"a1","reqId":"perm-t9","outcome":"allow","mode":"edit"}}),
    ]
}
