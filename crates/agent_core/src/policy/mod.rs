//! The permission broker: tool intents, shell analysis, hard stops, the decision order and the enforcement chip.

pub mod autoallow;
pub mod decide;
pub mod enforcement;
pub mod fsrpc;
pub mod fsview;
pub mod glob;
pub mod hardstop;
pub mod intent;
pub mod paths;
pub mod session_allow;
pub mod shellparse;

/// The ten groups of the Bypass confirm dialog ("what stays blocked", permission-modes spec 1.3). Every id is a hard stop that
/// Bypass keeps; the UI pins its dialog bullets against this list (exported as `bypassKeeps` in `constants.json`) and the
/// policy tests pin it against real `decide` calls (test P-14).
pub const BYPASS_KEEPS: [&str; 10] = ["git", "gitTricks", "protectedPaths", "persistence", "secrets", "wrangler", "ideState", "procEnv", "isolation", "catastrophic"];

/// How the broker classifies one tool of the pinned SDK (`sdk-tools.d.ts`). Plain data for `SDK_TOOL_COVERAGE`; not the
/// event `ToolKind` of `events::types`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolKind {
    Exec,
    Write,
    Read,
    Net,
    Spawn,
    Mcp,
    PlanMode,
    /// Only touches the session's own UI and task state, or reads (`AUTO_KNOWN_OTHER`).
    OtherKnown,
    /// Publishes, uploads or acts outside the machine: denied in Automatic and Bypass.
    OtherStateChange,
}

/// Every `*Input` interface of the pinned `sdk-tools.d.ts`, with the tool name the hook sees and exactly one kind
/// (permission-modes spec 2.2). Exported as `sdkToolCoverage` in `constants.json`; the sidecar test S-12 compares it with the
/// pinned file, so an SDK bump that adds a tool fails until a kind is chosen.
pub const SDK_TOOL_COVERAGE: &[(&str, &str, ToolKind)] = &[
    ("AgentInput", "Agent", ToolKind::Spawn),
    ("BashInput", "Bash", ToolKind::Exec),
    ("ExitPlanModeInput", "ExitPlanMode", ToolKind::PlanMode),
    ("FileEditInput", "Edit", ToolKind::Write),
    ("FileReadInput", "Read", ToolKind::Read),
    ("FileWriteInput", "Write", ToolKind::Write),
    ("GlobInput", "Glob", ToolKind::Read),
    ("GrepInput", "Grep", ToolKind::Read),
    ("TaskStopInput", "TaskStop", ToolKind::OtherKnown),
    ("ListMcpResourcesInput", "ListMcpResourcesTool", ToolKind::Mcp),
    ("RefreshMcpToolsInput", "RefreshMcpTools", ToolKind::Mcp),
    ("McpInput", "Mcp", ToolKind::OtherStateChange),
    ("NotebookEditInput", "NotebookEdit", ToolKind::Write),
    ("ReadMcpResourceDirInput", "ReadMcpResourceDir", ToolKind::Mcp),
    ("ReadMcpResourceInput", "ReadMcpResourceTool", ToolKind::Mcp),
    ("ReportFindingsInput", "ReportFindings", ToolKind::OtherKnown),
    ("TodoWriteInput", "TodoWrite", ToolKind::OtherKnown),
    ("WebFetchInput", "WebFetch", ToolKind::Net),
    ("WebSearchInput", "WebSearch", ToolKind::Net),
    ("AskUserQuestionInput", "AskUserQuestion", ToolKind::OtherKnown),
    ("SendFeedbackInput", "SendFeedback", ToolKind::OtherStateChange),
    ("ClaudeDesignInput", "ClaudeDesign", ToolKind::OtherStateChange),
    ("ProjectsInput", "Projects", ToolKind::OtherStateChange),
    ("EnterPlanModeInput", "EnterPlanMode", ToolKind::PlanMode),
    ("TaskCreateInput", "TaskCreate", ToolKind::OtherKnown),
    ("TaskGetInput", "TaskGet", ToolKind::OtherKnown),
    ("TaskUpdateInput", "TaskUpdate", ToolKind::OtherKnown),
    ("TaskListInput", "TaskList", ToolKind::OtherKnown),
    ("WorkflowInput", "Workflow", ToolKind::OtherStateChange),
    ("CronCreateInput", "CronCreate", ToolKind::OtherStateChange),
    ("CronDeleteInput", "CronDelete", ToolKind::OtherStateChange),
    ("CronListInput", "CronList", ToolKind::OtherKnown),
    ("ScheduleWakeupInput", "ScheduleWakeup", ToolKind::OtherStateChange),
    ("RemoteTriggerInput", "RemoteTrigger", ToolKind::OtherStateChange),
    ("ShowOnboardingRolePickerInput", "ShowOnboardingRolePicker", ToolKind::OtherKnown),
    ("ReadNotificationsInput", "ReadNotifications", ToolKind::OtherKnown),
    // A `Monitor` with a `command` is a command (judged like Bash); its `ws` form is the state-change tool (spec GZ-6).
    ("MonitorInput", "Monitor", ToolKind::Exec),
    ("ProposeSkillsInput", "ProposeSkills", ToolKind::OtherStateChange),
    ("ProposeGoalInput", "ProposeGoal", ToolKind::OtherStateChange),
    ("ArtifactInput", "Artifact", ToolKind::OtherStateChange),
    ("PushNotificationInput", "PushNotification", ToolKind::OtherStateChange),
    ("EnterWorktreeInput", "EnterWorktree", ToolKind::OtherStateChange),
    ("ExitWorktreeInput", "ExitWorktree", ToolKind::OtherStateChange),
];
