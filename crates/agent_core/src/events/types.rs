//! Normalized `AgentEvent` (providers-plan 1.5). Wire format: camelCase, `kind` strings like `tool.start`,
//! times in epoch milliseconds, absent options omitted. A payload field can never be called `kind`
//! (the tag), hence `tool_kind`.

#[cfg(feature = "specta")]
use specta_typescript::{Number, Unknown};

use crate::delegates::DelegateInfo;
use crate::policy::decide::SessionAllowOffer;
use crate::policy::intent::ToolIntent;
use crate::providers::{AuthMode, CapDelta, Effort, ModelInfo, PermissionMode, ProviderCaps};
use crate::usage::UsageRecord;

wire_enums! {
    /// The ACP tool taxonomy.
    pub enum ToolKind {
        Read,
        Edit,
        Delete,
        Move,
        Search,
        Exec,
        Fetch,
        Think,
        Mcp,
        Other,
    }

    pub enum ToolStatus {
        Running,
        Ok,
        Error,
        Denied,
        Cancelled,
    }

    /// Where a note the user added to a running agent stands.
    pub enum NoteState {
        /// Accepted; it waits for the target's next tool call.
        Queued,
        /// Handed to the target together with that tool call.
        Delivered,
        /// The target can no longer see it (its work ended first).
        Dropped,
    }

    /// Who decided a permission request.
    pub enum DecidedBy {
        HardStop,
        RoleDeny,
        Saved,
        User,
        /// A built-in class rule, or nobody yet (an `ask`).
        Default,
        /// The policy channel was down, slow or garbled.
        FailClosed,
    }

    pub enum PermissionOutcome {
        Allow,
        Deny,
        Cancelled,
    }

    /// What the user can answer a permission request with; `once` variants only for shell and write.
    pub enum PermissionOption {
        #[serde(rename = "allow_once")]
        AllowOnce,
        /// "Allow always in this session" (a saved allow the host keeps for the run). Offered only when `session_allow` is present.
        #[serde(rename = "allow_run")]
        AllowRun,
        #[serde(rename = "deny")]
        Deny,
    }

    /// Why a run's permission mode changed (`EffectiveChange.reason`).
    pub enum ModeChangeReason {
        User,
        PlanApproved,
        ResumeDowngrade,
        /// A repository role narrowed a resumed run.
        RoleChanged,
        Provider,
    }

    pub enum StatusState {
        Idle,
        Thinking,
        Running,
        WaitingUser,
        Throttled,
        Retrying,
        Compacting,
    }

    pub enum ErrorClass {
        Auth,
        Rate,
        Network,
        Protocol,
        Provider,
        Policy,
        Internal,
    }

    pub enum StopReason {
        EndTurn,
        MaxTokens,
        MaxTurns,
        Refusal,
        Cancelled,
        Error,
    }
}

wire_types! {
    /// One attachment of a `user.message`: what the transcript shows and the log keeps (never the contents).
    #[serde(rename_all = "camelCase")]
    pub struct AttachmentRef {
        pub id: String,
        pub name: String,
        pub mime: String,
        /// Bytes (an attachment is at most 40 MB, so u32 is exact and TypeScript-safe).
        pub size: u32,
        /// `image` | `text` | `pdf` | `file`
        pub kind: String,
        pub sha256: String,
    }
}

wire_types! {
    /// What the provider actually applied (the generalized init-assert compares it with the role).
    #[serde(rename_all = "camelCase")]
    pub struct Effective {
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub effort: Option<Effort>,
        pub permission: PermissionMode,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub sandbox: Option<String>,
    }

    /// The credential a session actually runs on, so the header can warn when it differs from the configured mode.
    #[serde(rename_all = "camelCase")]
    pub struct AuthFact {
        pub mode: AuthMode,
        /// What the CLI reports (`apiKeySource`), e.g. `none` for the subscription login.
        pub source: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub warning: Option<String>,
    }

    /// A mid-run change of model, effort or permission mode.
    #[serde(rename_all = "camelCase")]
    pub struct EffectiveChange {
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub model: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub effort: Option<Effort>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub permission: Option<PermissionMode>,
        /// Why `permission` changed; absent = `user`.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub reason: Option<ModeChangeReason>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ToolDiff {
        pub path: String,
        /// Absent for a new file.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub old: Option<String>,
        pub new: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct QuestionOption {
        pub label: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub description: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct PlanItem {
        pub content: String,
        /// Provider wording (`pending`, `in_progress`, `completed`).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub status: Option<String>,
    }

    #[serde(tag = "kind", rename_all_fields = "camelCase")]
    pub enum EventKind {
        #[serde(rename = "session.started")]
        SessionStarted {
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            native_id: Option<String>,
            model: String,
            effective: Effective,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            auth: Option<AuthFact>,
            /// Init-assert mismatches between the role and what the provider reports.
            #[serde(default)]
            assertions: Vec<String>,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            caps_delta: CapDelta,
        },
        /// The user's prompt, emitted by the sidecar host when a turn begins so a log rebuilds the whole transcript.
        #[serde(rename = "user.message")]
        UserMessage {
            message_id: String,
            text: String,
            /// Files the user attached (drag-drop, paste, picker). Metadata only; the bytes stay in the attachment store.
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            attachments: Vec<AttachmentRef>,
        },
        #[serde(rename = "text.delta")]
        TextDelta {
            message_id: String,
            text: String,
            /// Set for text produced inside a subagent.
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            parent_tool_id: Option<String>,
        },
        #[serde(rename = "text.done")]
        TextDone {
            message_id: String,
            text: String,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            parent_tool_id: Option<String>,
        },
        /// Summary text only; opaque reasoning blobs stay in `raw`.
        #[serde(rename = "thinking.delta")]
        ThinkingDelta {
            message_id: String,
            text: String,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            parent_tool_id: Option<String>,
        },
        #[serde(rename = "tool.start")]
        ToolStart {
            tool_id: String,
            name: String,
            tool_kind: ToolKind,
            /// Redacted input.
            #[cfg_attr(feature = "specta", specta(type = Unknown))]
            input: serde_json::Value,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            parent_tool_id: Option<String>,
        },
        #[serde(rename = "tool.update")]
        ToolUpdate {
            tool_id: String,
            status: ToolStatus,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            output: Option<String>,
        },
        #[serde(rename = "tool.result")]
        ToolResult {
            tool_id: String,
            status: ToolStatus,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            output: Option<String>,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            diff: Option<ToolDiff>,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            duration_ms: Option<u32>,
        },
        #[serde(rename = "permission.request")]
        PermissionRequest {
            req_id: String,
            tool_id: String,
            intent: ToolIntent,
            #[serde(default)]
            options: Vec<PermissionOption>,
            /// What the `allow_run` button would allow (display only; the host derives its own).
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            session_allow: Option<SessionAllowOffer>,
            /// ExitPlanMode: the FULL plan text, redacted, at most 64 KiB.
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            plan: Option<String>,
            /// The plan was cut at 64 KiB.
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            plan_truncated: Option<bool>,
            /// ExitPlanMode: the working modes the card offers (ask, edit, automatic).
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            modes: Vec<PermissionMode>,
        },
        #[serde(rename = "permission.resolved")]
        PermissionResolved { req_id: String, outcome: PermissionOutcome, by: DecidedBy },
        #[serde(rename = "question.request")]
        QuestionRequest {
            req_id: String,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            tool_id: Option<String>,
            prompt: String,
            #[serde(default)]
            options: Vec<QuestionOption>,
        },
        #[serde(rename = "plan")]
        Plan { items: Vec<PlanItem> },
        /// A note the user added to a running agent, the lead or one sub-agent. One event per state, joined by `note_id`.
        #[serde(rename = "note")]
        Note {
            note_id: String,
            state: NoteState,
            /// The sub-agent's `Agent` tool call; absent for the lead.
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            parent_tool_id: Option<String>,
            /// `queued` only: what the user wrote.
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            text: Option<String>,
            /// `delivered` only: the tool call the note rode on.
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            tool_id: Option<String>,
            /// `dropped` only: `finished`, `turnEnded` or `cancelled`.
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            reason: Option<String>,
        },
        #[serde(rename = "usage")]
        Usage { usage: UsageRecord },
        #[serde(rename = "status")]
        Status {
            state: StatusState,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            retry_after_ms: Option<u32>,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            scope: Option<String>,
        },
        #[serde(rename = "error")]
        Error { class: ErrorClass, message: String, retryable: bool },
        #[serde(rename = "turn.end")]
        TurnEnd { stop_reason: StopReason },
        #[serde(rename = "session.info")]
        SessionInfo {
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            title: Option<String>,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            native_id: Option<String>,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            models: Vec<ModelInfo>,
            /// The capability matrix computed for this session (runtime truth beats the static table).
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            caps: Option<ProviderCaps>,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            effective: Option<EffectiveChange>,
            /// The roles the lead may delegate to, emitted once after init (never the prompts).
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            delegates: Vec<DelegateInfo>,
            /// The CLI's slash commands of this session (names without the slash), from `system/init`.
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            slash_commands: Vec<String>,
            /// The MCP servers of this session and their state at init (`{name, status, error?, tools?}`).
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            mcp_servers: Vec<McpServerInfo>,
        },
    }

    /// The envelope: `{ agentId, seq, ts, turnId?, provider, kind, ...payload, raw? }`.
    #[serde(rename_all = "camelCase")]
    pub struct AgentEvent {
        pub agent_id: String,
        /// Per agent, starts at 1 (or at the `nextSeq` of a resumed session), strictly +1.
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub seq: u64,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub ts: u64,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub turn_id: Option<String>,
        pub provider: String,
        #[serde(flatten)]
        pub kind: EventKind,
        /// The untouched provider message (size-capped by the host), for the Inspector's raw view.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional, type = Unknown))]
        pub raw: Option<serde_json::Value>,
    }
}

wire_enums! {
    /// Connection state of an MCP server of a run, as the claude CLI reports it (`needs-auth` is `needsAuth` on the wire).
    pub enum McpServerState {
        Connected,
        Failed,
        Pending,
        NeedsAuth,
        Disabled,
    }
}

wire_types! {
    /// One MCP server of a run in `session.info` (from the CLI's `system/init`): never the config, env or headers.
    #[serde(rename_all = "camelCase")]
    pub struct McpServerInfo {
        pub name: String,
        pub status: McpServerState,
        /// The CLI's error text of a failed server (redacted by the sidecar).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub error: Option<String>,
        /// How many tools the server offers, when known.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub tools: Option<u32>,
    }

    /// A tool of an MCP server as `session/mcp-status` lists it.
    #[serde(rename_all = "camelCase")]
    pub struct McpToolInfo {
        pub name: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub description: Option<String>,
    }

    /// One server of the live `session/mcp-status` answer.
    #[serde(rename_all = "camelCase")]
    pub struct McpServerStatus {
        pub name: String,
        pub status: McpServerState,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub error: Option<String>,
        #[serde(default)]
        pub tools: Vec<McpToolInfo>,
    }
}

wire_types! {
    /// An event inside `events/batch`: `agentId` and `provider` are batch-level.
    #[serde(rename_all = "camelCase")]
    pub struct BatchEvent {
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub seq: u64,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub ts: u64,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub turn_id: Option<String>,
        #[serde(flatten)]
        pub kind: EventKind,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional, type = Unknown))]
        pub raw: Option<serde_json::Value>,
    }
}

impl AgentEvent {
    pub fn to_batch(&self) -> BatchEvent {
        BatchEvent { seq: self.seq, ts: self.ts, turn_id: self.turn_id.clone(), kind: self.kind.clone(), raw: self.raw.clone() }
    }
}

impl BatchEvent {
    /// The full event, with the batch's `agentId` and `provider`.
    pub fn into_event(self, agent_id: &str, provider: &str) -> AgentEvent {
        AgentEvent { agent_id: agent_id.to_string(), seq: self.seq, ts: self.ts, turn_id: self.turn_id, provider: provider.to_string(), kind: self.kind, raw: self.raw }
    }
}

/// Every `kind` string; `EventKind::name` is an exhaustive match, so a new variant cannot be forgotten
/// (the samples test compares both lists).
pub const ALL_KINDS: [&str; 18] = [
    "session.started",
    "user.message",
    "text.delta",
    "text.done",
    "thinking.delta",
    "tool.start",
    "tool.update",
    "tool.result",
    "permission.request",
    "permission.resolved",
    "question.request",
    "plan",
    "note",
    "usage",
    "status",
    "error",
    "turn.end",
    "session.info",
];

impl EventKind {
    pub fn name(&self) -> &'static str {
        match self {
            EventKind::SessionStarted { .. } => "session.started",
            EventKind::UserMessage { .. } => "user.message",
            EventKind::TextDelta { .. } => "text.delta",
            EventKind::TextDone { .. } => "text.done",
            EventKind::ThinkingDelta { .. } => "thinking.delta",
            EventKind::ToolStart { .. } => "tool.start",
            EventKind::ToolUpdate { .. } => "tool.update",
            EventKind::ToolResult { .. } => "tool.result",
            EventKind::PermissionRequest { .. } => "permission.request",
            EventKind::PermissionResolved { .. } => "permission.resolved",
            EventKind::QuestionRequest { .. } => "question.request",
            EventKind::Plan { .. } => "plan",
            EventKind::Note { .. } => "note",
            EventKind::Usage { .. } => "usage",
            EventKind::Status { .. } => "status",
            EventKind::Error { .. } => "error",
            EventKind::TurnEnd { .. } => "turn.end",
            EventKind::SessionInfo { .. } => "session.info",
        }
    }
}
