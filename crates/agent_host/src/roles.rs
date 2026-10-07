//! Built-in roles of Phase 2a. The Roles layer (Phase 5) replaces this table with `~/.claude/agents/*.md` plus the
//! overlay; until then these three Claude roles and the scripted mock roles are what "New run" offers.

use intely_agent_core::api::RoleInfo;
use intely_agent_core::delegates::{DelegateDef, DelegateSet};
use intely_agent_core::providers::{AttachmentsCap, Cap, CapEntry, Effort, PermissionMode, ProviderCaps};
use intely_agent_core::sidecar::ResolvedRole;

use crate::config::HostConfig;

/// Scenarios of the mock adapter (`sidecar/src/adapters/mock/scenarios`).
pub const MOCK_SCENARIOS: [(&str, &str); 12] = [
    ("plain-reply", "A streamed answer with one read tool call."),
    ("tool-permission", "A shell call that waits for Allow once / Deny."),
    ("ask-question", "A clarifying question card."),
    ("error", "A provider error, then a retry."),
    ("throttle", "A rate-limit pause."),
    ("interrupt", "A long run to stop with Stop."),
    ("subagent-tree", "A subagent with nested tools."),
    ("hard-stop", "A git commit refused by the hard stop."),
    ("plan-approval", "Plan mode: a plan, then an approval card with a choice of the working mode."),
    ("mcp-tools", "MCP tools of the fixture server: read-only, writing, denied and not-in-set calls, each judged by the broker."),
    ("bash-twice", "The same shell command twice: a card with Allow always in this session, then the second call runs without one."),
    ("notes", "A subagent at work: add a note to it or to the lead and watch the note go from Queued to Delivered."),
];

/// Scripts of the fake ACP agent (`sidecar/tests/fakes/acp-scripts`) that e2e scenario z plays as roles: the scenario name
/// is the script file. The two write roles are the only ones allowed on a provider that has not passed the write suites.
pub const ACP_MOCK_SCENARIOS: [(&str, &str, PermissionMode); 3] = [
    ("plain-reply", "ACP fake: a streamed answer.", PermissionMode::ReadOnly),
    ("asks-command", "ACP fake: a shell command that waits for Allow once / Deny.", PermissionMode::Edit),
    ("terminal-git-push", "ACP fake: a terminal call that runs git push, refused by the hard stop.", PermissionMode::Edit),
];

/// Tools that reach outside the working tree or other sessions; no built-in role needs them.
pub const CLAUDE_DISALLOWED: [&str; 9] = [
    "RemoteTrigger", "SendMessage", "ListAgents", "CronCreate", "ScheduleWakeup", "Workflow", "PushNotification", "DesignSync", "EnterWorktree",
];

pub const SYSTEM_PREAMBLE: &str = "You are an agent running inside IntelySwitchIDE. The working tree is the user's repository; the session lists the folders you work \
in, and one task often spans several repositories, so move between them freely (cd, absolute paths). Work like a careful engineer: read what you \
change, edit with the editing tools, run the project's own lint and tests for what you touched with the shell (npm, npx, jest, eslint, python3 \
heredocs, git status, diff, log and show are all fine), keep scratch files in /tmp, and report what you changed and what you verified. Staging a \
deliberate list of files is fine (git add <file>). Do not run git commands that write history or refs (commit, push, tag, reset --hard, stash, \
rebase, add -A, add .): the IDE refuses them and the user commits and pushes by hand. When you need an answer from the user, ask with the \
AskUserQuestion tool instead of guessing.";

/// The reserved role of a run that starts without a role: a lead that hands work to the roles ((design notes: roles-orchestration-spec) 4.2).
pub const AUTO_ROLE: &str = "auto";
/// e2e only: the scripted delegation scenario with the REAL resolved delegate set.
pub const MOCK_AUTO_ROLE: &str = "mock-auto";
pub const MOCK_AUTO_SCENARIO: &str = "delegate-roles";
/// Turns of the lead and the most a delegate may take (the broker and the SDK `maxTurns` enforce them).
pub const LEAD_MAX_TURNS: u32 = 400;
pub const DELEGATE_MAX_TURNS: u32 = 150;
/// Turns of a built-in role and of a role file that sets none (a role may still set its own lower value).
pub const BUILTIN_ROLE_MAX_TURNS: u32 = 120;
/// Oldest Claude CLI the delegation path was checked against (D12; the version of the user's machine). The opt-in live smoke
/// (`sidecar/test/claude-live.test.ts`) must pass against it before Auto is enabled by default in a release. Mirrored by
/// `MIN_CLI_FOR_DELEGATION` in `sidecar/src/adapters/claude-sdk/facts.ts`.
pub const MIN_CLI_FOR_DELEGATION: &str = "2.1.284";
/// Prefix of the sidecar's `error {class: policy}` when a sub-agent call could not be attributed to its role (the canary).
pub const DELEGATION_CANARY_MARK: &str = "INTELY-DELEGATION-CANARY";

/// The lead's instructions after the preamble (`{cap}` = the delegation cap). Verbatim from the spec; the last sentence about
/// the foreground is the one addition: the broker refuses an `Agent` call that does not pass `run_in_background: false`.
fn lead_prompt(cap: u32) -> String {
    format!(
        "You lead a small team of specialist agents that you can start with the Agent tool. Choose an agent by its description \
and give it a short, complete brief: the goal, the files, what to report back. Prefer the cheapest agent that can do the \
job and do small edits and quick lookups yourself. Agents cannot start other agents, do not see this conversation and do not read the project instructions: put the rules they need into the brief. \
Start at most {cap} agents in this run, wait for their reports and check what an editing agent changed before you rely \
on it. Never start two agents that change the same files at the same time. Nobody, you or the agents, commits or \
pushes: the user does that in the IDE. Always call the Agent tool with run_in_background set to false and without a \
model: the role decides the model, and you wait for the report."
    )
}

/// What the resume narrowing needs to know about a role that comes from a FILE (a global or repository role file); a built-in
/// role, a scripted role and the Auto lead carry none (permission-modes spec 5.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleFile {
    /// A repository copy nobody trusted or approved (`RoleTrust::Untrusted`).
    pub untrusted: bool,
    /// The permission was lowered by a ceiling (`PermissionSource::Ceiling`).
    pub ceiling: bool,
    /// `content_hash` of the file as it resolves now; compared with `Meta.role_hash`.
    pub content_hash: String,
}

#[derive(Debug, Clone)]
pub struct RoleDef {
    pub name: String,
    pub description: String,
    pub provider: String,
    pub model: String,
    pub effort: Option<Effort>,
    pub permission: PermissionMode,
    pub system_prompt: Option<String>,
    /// Allow-list of tools; empty = the provider's default set.
    pub tools: Vec<String>,
    pub disallowed_tools: Vec<String>,
    pub max_turns: Option<u32>,
    /// Mock roles: which scenario the adapter plays.
    pub mock_scenario: Option<String>,
    /// Pre-select every repo (research and review roles) instead of the first.
    pub all_repos: bool,
    /// Trust, ceiling and content hash of the role FILE this role came from; `None` for a built-in, a scripted role and the Auto lead.
    pub file: Option<RoleFile>,
}

impl RoleDef {
    fn claude(name: &str, description: &str, model: &str, effort: Option<Effort>, permission: PermissionMode, prompt: &str, all_repos: bool) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            provider: "claude".into(),
            model: model.into(),
            effort,
            permission,
            system_prompt: Some(format!("{SYSTEM_PREAMBLE}\n\n{prompt}")),
            tools: Vec::new(),
            disallowed_tools: CLAUDE_DISALLOWED.iter().map(|t| t.to_string()).collect(),
            max_turns: Some(BUILTIN_ROLE_MAX_TURNS),
            mock_scenario: None,
            all_repos,
            file: None,
        }
    }

    /// The same role on another provider (the New run picker): the model is the new provider's default, and what only
    /// Claude understands (effort, tool names, turn cap, the Claude system prompt) is dropped.
    pub fn on_provider(&self, provider: &str) -> Self {
        Self { provider: provider.into(), model: "default".into(), effort: None, tools: Vec::new(), disallowed_tools: Vec::new(), max_turns: None, ..self.clone() }
    }

    /// A role that leads a team: Auto, and the scripted `mock-auto` of the e2e harness. Its delegates are resolved when a session
    /// opens (start, resume, a queued run leaving the queue), never frozen into the definition.
    pub fn is_delegating(&self) -> bool {
        self.name == AUTO_ROLE || (self.name == MOCK_AUTO_ROLE && self.provider == "mock")
    }

    pub fn resolved(&self, cfg: &HostConfig) -> ResolvedRole {
        let overridden = self.provider == "claude" && cfg.model_override.is_some();
        ResolvedRole {
            name: self.name.clone(),
            model: if overridden { cfg.model_override.clone().unwrap_or_default() } else { self.model.clone() },
            // an overridden model may have no effort control; the role's wish is dropped rather than asserted
            effort: if overridden { None } else { self.effort },
            permission: self.permission,
            system_prompt: self.system_prompt.clone(),
            tools: self.tools.clone(),
            disallowed_tools: self.disallowed_tools.clone(),
            max_turns: self.max_turns,
            max_budget_usd: if self.provider == "claude" { cfg.max_budget_usd.or_else(|| if self.name == AUTO_ROLE { cfg.defaults().max_budget_usd } else { None }) } else { None },
        }
    }
}

/// The Auto lead as configured right now (Settings > Roles "Auto run"): edit posture, writer lease, model and effort from the
/// settings, the lead prompt. `Agent`/`Task` stay available here; the host takes them away when the delegate set is empty.
pub fn auto_role(cfg: &HostConfig) -> RoleDef {
    let d = cfg.defaults();
    let mut role = RoleDef::claude(
        AUTO_ROLE,
        "Starts at once and hands parts of the work to your roles.",
        &d.model,
        d.effort,
        PermissionMode::Edit,
        &lead_prompt(d.delegation_cap),
        false,
    );
    role.max_turns = Some(LEAD_MAX_TURNS);
    role
}

/// What a session opens with when its role leads a team: the delegates (or none, and why), from the current role files.
#[derive(Debug, Clone, Default)]
pub struct Delegation {
    pub set: DelegateSet,
    /// Roles may exist but the lead works alone: `delegationDisabled`, `canaryTripped` or `cliTooOld`.
    pub off: Option<&'static str>,
}

impl Delegation {
    pub fn is_active(&self) -> bool {
        self.off.is_none() && !self.set.is_empty()
    }

    pub fn defs(&self) -> &[DelegateDef] {
        &self.set.included
    }
}

/// `1.2.3`-style versions compared numerically (a missing or odd part counts as 0).
pub fn version_at_least(have: &str, want: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> { v.trim().trim_start_matches('v').split(['.', '-', ' ']).take(3).map(|p| p.parse().unwrap_or(0)).collect() };
    let (mut a, mut b) = (parse(have), parse(want));
    a.resize(3, 0);
    b.resize(3, 0);
    a >= b
}

pub fn builtin(cfg: &HostConfig) -> Vec<RoleDef> {
    let mut roles = Vec::new();
    if cfg.providers.iter().any(|p| p == "claude") {
        roles.push(RoleDef::claude(
            "developer",
            "Implements a change: edits files in the working tree, never commits.",
            "claude-sonnet-5-5",
            Some(Effort::Medium),
            PermissionMode::Edit,
            "Make the requested change with small, focused edits and report what you changed.",
            false,
        ));
        roles.push(RoleDef::claude(
            "researcher",
            "Reads and searches the code; cannot edit or run commands.",
            "claude-haiku-4-5-20251001",
            None,
            PermissionMode::ReadOnly,
            "Answer from the code. You cannot modify anything.",
            true,
        ));
        roles.push(RoleDef::claude(
            "reviewer",
            "Reviews the working-tree changes; read-only.",
            "claude-sonnet-5-5",
            Some(Effort::High),
            PermissionMode::ReadOnly,
            "Review the uncommitted changes for correctness and report findings by severity.",
            true,
        ));
    }
    if cfg.mock_enabled() {
        for (scenario, description) in MOCK_SCENARIOS {
            roles.push(RoleDef {
                name: format!("mock-{scenario}"),
                description: description.into(),
                provider: "mock".into(),
                model: "mock-1".into(),
                effort: None,
                permission: if matches!(scenario, "plain-reply" | "plan-approval") { PermissionMode::ReadOnly } else { PermissionMode::Edit },
                system_prompt: None,
                tools: Vec::new(),
                disallowed_tools: Vec::new(),
                max_turns: None,
                mock_scenario: Some(scenario.into()),
                all_repos: false,
                file: None,
            });
        }
    }
    if cfg.mock_enabled() {
        // the lead of the scripted delegation scenario; the delegates are the run's real resolved set (e2e scenario `ro`)
        roles.push(RoleDef {
            name: MOCK_AUTO_ROLE.into(),
            description: "Scripted delegation: a lead that starts the researcher and the writer role.".into(),
            provider: "mock".into(),
            model: "mock-1".into(),
            effort: None,
            permission: PermissionMode::Edit,
            system_prompt: None,
            tools: Vec::new(),
            disallowed_tools: Vec::new(),
            max_turns: None,
            mock_scenario: Some(MOCK_AUTO_SCENARIO.into()),
            all_repos: false,
            file: None,
        });
    }
    if let Some(m) = &cfg.acp_mock {
        for (scenario, description, permission) in ACP_MOCK_SCENARIOS {
            roles.push(RoleDef {
                name: format!("mock-acp-{scenario}"),
                description: description.into(),
                provider: m.provider.clone(),
                model: "default".into(),
                effort: None,
                permission,
                system_prompt: None,
                tools: Vec::new(),
                disallowed_tools: Vec::new(),
                max_turns: None,
                mock_scenario: Some(scenario.into()),
                all_repos: false,
                file: None,
            });
        }
    }
    roles
}

pub fn info(role: &RoleDef, cfg: &HostConfig, repo_ids: &[String]) -> RoleInfo {
    let resolved = role.resolved(cfg);
    RoleInfo {
        name: role.name.clone(),
        description: role.description.clone(),
        provider: role.provider.clone(),
        model: resolved.model,
        effort: resolved.effort,
        permission: role.permission,
        default_repo_ids: if role.all_repos { repo_ids.to_vec() } else { repo_ids.iter().take(1).cloned().collect() },
    }
}

/// What the run header shows until the adapter's own `session.info` arrives; the same matrix the adapters declare.
pub fn static_caps(provider: &str) -> ProviderCaps {
    let yes = || CapEntry::new(Cap::Yes);
    let mut caps = ProviderCaps::default();
    caps.streaming = yes();
    caps.tool_events = yes();
    caps.cancel = yes();
    caps.permissions = yes();
    caps.subagents = yes();
    caps.usage = yes();
    caps.resume = yes();
    caps.model_list = yes();
    // Images and PDFs as content blocks, text inlined, other files by path under a read-only context directory.
    caps.attachments = Some(AttachmentsCap::Files);
    // Claude and the scripted adapter take a note for a running agent (`session/note`).
    caps.notes = Some(true);
    match provider {
        "claude" => {
            caps.fork = yes();
            caps.hooks = yes();
            caps.model_switch = yes();
            caps.effort = CapEntry::with_note(Cap::Partial, "depends on the model; refined at session start");
            caps.sandbox = CapEntry::with_note(Cap::Partial, "did not hold under bypass in Phase 0; not counted as a layer");
        }
        _ => {
            caps.fork = CapEntry::with_note(Cap::No, "scripted");
            caps.effort = CapEntry::with_note(Cap::No, "mock");
        }
    }
    caps
}
