//! Types of the UI <-> Rust command surface for agent runs (`agent_*` Tauri commands, providers-plan 5.10 `AgentHub`).
//! The events themselves are [`crate::events::types::AgentEvent`]; these are the request and summary shapes around them.

#[cfg(feature = "specta")]
use specta_typescript::Number;

use crate::delegates::{DelegateInfo, ExcludedDelegate};
use crate::mcp::McpExposure;
use crate::policy::enforcement::Tier;
use crate::providers::{Effort, PermissionMode, ProviderCaps};
use crate::usage::UsageRecord;

wire_enums! {
    /// Coarse state of a run for the run list and the Rail badge.
    pub enum RunStatus {
        Running,
        NeedsYou,
        Done,
        Error,
    }

    /// What a permission card can answer. Only the options of the pending `permission.request` are accepted.
    /// `AllowOnce` and `Deny` are always possible; `AllowRun` (the card's "allow always in this session") only when the
    /// request offered it and the host can derive a session allow; `AllowAlways` (role + repo, persisted) is still never
    /// offered and is rejected with `optionNotOffered`.
    pub enum PermissionDecision {
        AllowOnce,
        AllowRun,
        AllowAlways,
        Deny,
    }
}

wire_types! {
    /// What the role asked for, to compare with the `effective` values of `session.started`.
    #[serde(rename_all = "camelCase")]
    pub struct Requested {
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub effort: Option<Effort>,
        pub permission: PermissionMode,
    }

    #[serde(rename_all = "camelCase")]
    pub struct AgentEffective {
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub effort: Option<Effort>,
        pub permission: PermissionMode,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub sandbox: Option<String>,
    }

    /// One row of `agent_list` / the reply of `agent_start`; the run header reads all of it.
    #[serde(rename_all = "camelCase")]
    pub struct AgentSummary {
        pub agent_id: String,
        pub provider: String,
        pub role: String,
        pub model: String,
        pub title: String,
        pub status: RunStatus,
        pub permission: PermissionMode,
        pub requested: Requested,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub effective: Option<AgentEffective>,
        pub repo_ids: Vec<String>,
        pub caps: ProviderCaps,
        pub enforcement: Tier,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub started_at: u64,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub usage: Option<UsageRecord>,
        /// The roles the lead may delegate to (empty for a single-role run).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub delegates: Vec<DelegateInfo>,
        /// The modes this run can be switched to live (empty = the chip is static): `switchable_modes(provider)`.
        #[serde(default)]
        pub switchable_modes: Vec<PermissionMode>,
        /// MCP servers of this run and how many of their tools run without a prompt in Automatic and Bypass (empty = no MCP).
        #[serde(default)]
        pub mcp: Vec<McpExposure>,
    }

    /// Why an Auto run would wait before it starts (shown before Start): `repoWriter` = another run is writing to the
    /// repository (`agent_id`/`title` name it), `writers` = every writer slot is busy, `slots` = every agent slot is busy.
    #[serde(rename_all = "camelCase")]
    pub struct AutoQueue {
        pub kind: String,
        pub agent_id: String,
        pub title: String,
    }

    /// What an Auto run would do on these repositories (`agents_auto_info`); computed with the same delegate set `start` uses.
    #[serde(rename_all = "camelCase")]
    pub struct AutoInfo {
        /// `false` = New run falls back to the role picker; `reason` is a code (`claudeDisabled`, `notInstalled`,
        /// `notLoggedIn`, `cliTooOld`, `autoDisabled`).
        pub available: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub reason: Option<String>,
        pub model: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub effort: Option<Effort>,
        pub permission: PermissionMode,
        pub delegates: Vec<DelegateInfo>,
        pub excluded: Vec<ExcludedDelegate>,
        /// `Some(code)` when the lead would run alone: `delegationDisabled`, `canaryTripped` or `cliTooOld` (roles may exist), or
        /// `noRoles` (the set is empty).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub delegation_off: Option<String>,
        /// The run would wait for this one to finish writing to the repository.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub queued_behind: Option<AutoQueue>,
        /// The spend cap of the whole run, when there is one.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub max_budget_usd: Option<f64>,
        pub delegation_cap: u32,
        /// Lead `max_turns` + cap x the sub-agent turn ceiling.
        pub worst_case_turns: u32,
    }

    /// One entry of the New run popover.
    #[serde(rename_all = "camelCase")]
    pub struct RoleInfo {
        pub name: String,
        pub description: String,
        pub provider: String,
        pub model: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub effort: Option<Effort>,
        pub permission: PermissionMode,
        pub default_repo_ids: Vec<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct AgentStartRequest {
        pub role: String,
        pub repo_ids: Vec<String>,
        pub prompt: String,
        /// The run mode. Absent = the role's own permission, exactly as before.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub mode: Option<PermissionMode>,
        /// Ids of the MCP servers this run uses (the New run picker's explicit selection). Absent = NO MCP at all, so a caller that
        /// does not know MCP (queued runs, tray quick actions, Remote, scripts) never starts a server.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub mcp_servers: Option<Vec<String>>,
    }

    /// An `@file` mention of the composer.
    #[serde(rename_all = "camelCase")]
    pub struct AgentAttachment {
        pub repo_id: String,
        pub path: String,
    }

    /// Answer to a `question.request`: the labels of the chosen options (the option label is its identity).
    #[serde(rename_all = "camelCase")]
    pub struct QuestionAnswer {
        pub option_ids: Vec<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub text: Option<String>,
    }
}
