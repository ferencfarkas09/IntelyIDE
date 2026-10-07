//! One agent run as the host knows it: persisted metadata plus the state folded from its event stream.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use intely_agent_core::api::{AgentEffective, AgentSummary, Requested, RunStatus};
use intely_agent_core::delegates::DelegateInfo;
use intely_agent_core::events::types::{AgentEvent, DecidedBy, EventKind, PermissionOption, PermissionOutcome, StopReason, ToolStatus};
use intely_agent_core::mcp::{McpExposure, McpServerRules};
use intely_agent_core::policy::decide::{PolicyContext, SavedAllow};
use intely_agent_core::policy::intent::ToolIntent;
use intely_agent_core::policy::enforcement::Tier;
use intely_agent_core::providers::{AuthMode, Effort, PermissionMode, ProviderCaps};
use intely_agent_core::usage::UsageRecord;
use intely_agent_gate::gate::CancelTracker;
use serde::{Deserialize, Serialize};

use crate::roles::static_caps;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRef {
    pub id: String,
    pub path: PathBuf,
}

/// The Rewind snapshot taken for one repo before the run started.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRef {
    pub repo_id: String,
    pub path: PathBuf,
    pub ref_name: String,
    pub skipped: usize,
}

/// `runs/<agentId>.meta.json`: what the event log cannot say about a run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub agent_id: String,
    pub provider: String,
    pub role: String,
    pub model: String,
    pub effort: Option<Effort>,
    pub permission: PermissionMode,
    pub repos: Vec<RepoRef>,
    pub started_at: u64,
    pub native_id: Option<String>,
    pub snapshots: Vec<SnapshotRef>,
    /// The MCP server ids of the run (ids, not names, so a rename survives a resume); never a secret.
    #[serde(default)]
    pub mcp: Vec<String>,
    /// The `content_hash` of the role FILE the run started with (a global or repository role file); `None` for a built-in
    /// role or the Auto lead. Feeds the resume narrowing.
    #[serde(default)]
    pub role_hash: Option<String>,
    /// The role's own permission at the start, before the request's mode overrode it. Feeds the resume narrowing.
    #[serde(default)]
    pub role_permission: Option<PermissionMode>,
}

pub struct PendingPermission {
    pub options: Vec<PermissionOption>,
    pub answering: bool,
    /// The intent exactly as the `permission.request` event carried it (already redacted by the sidecar).
    /// The host derives a session allow and recognises an ExitPlanMode request from it; it never trusts the event's own offer.
    pub intent: ToolIntent,
}

pub struct PendingQuestion {
    pub prompt: String,
    pub labels: Vec<String>,
    pub answering: bool,
}

/// State folded from the events, identical for a live run and one replayed from its log.
#[derive(Default)]
pub struct RunState {
    pub last_seq: u64,
    pub title: String,
    pub model: Option<String>,
    pub effective: Option<AgentEffective>,
    pub caps: Option<ProviderCaps>,
    pub usage: Option<UsageRecord>,
    pub turn_open: bool,
    pub turn_id: Option<String>,
    pub open_tools: BTreeSet<String>,
    pub perms: BTreeMap<String, PendingPermission>,
    pub questions: BTreeMap<String, PendingQuestion>,
    pub last_stop: Option<StopReason>,
    pub native_id: Option<String>,
    /// How this run authenticates, from `session.started`; the enforcement chip is looked up per auth mode.
    pub auth_mode: Option<AuthMode>,
    /// The roles the lead may delegate to, from the latest non-empty `session.info` (empty for a single-role run).
    pub delegates: Vec<DelegateInfo>,
}

impl RunState {
    pub fn apply(&mut self, e: &AgentEvent) {
        self.last_seq = e.seq;
        if e.turn_id.is_some() && !matches!(e.kind, EventKind::TurnEnd { .. }) {
            self.turn_open = true;
            self.turn_id = e.turn_id.clone();
        }
        match &e.kind {
            EventKind::SessionStarted { native_id, model, effective, auth, .. } => {
                self.model = Some(model.clone());
                self.auth_mode = auth.as_ref().map(|a| a.mode);
                self.effective = Some(AgentEffective { effort: effective.effort, permission: effective.permission, sandbox: effective.sandbox.clone() });
                if native_id.is_some() {
                    self.native_id = native_id.clone();
                }
            }
            EventKind::SessionInfo { title, caps, effective, delegates, .. } => {
                if !delegates.is_empty() {
                    self.delegates = delegates.clone();
                }
                if let Some(t) = title.as_ref().filter(|t| !t.trim().is_empty()) {
                    self.title = t.clone();
                }
                if let Some(c) = caps {
                    self.caps = Some(c.clone());
                }
                if let Some(ch) = effective {
                    if let Some(m) = &ch.model {
                        self.model = Some(m.clone());
                    }
                    if let Some(eff) = self.effective.as_mut() {
                        if ch.effort.is_some() {
                            eff.effort = ch.effort;
                        }
                        if let Some(p) = ch.permission {
                            eff.permission = p;
                        }
                    }
                }
            }
            EventKind::UserMessage { text, .. } => {
                self.turn_open = true;
                if self.title.is_empty() {
                    self.title = title_of(text);
                }
            }
            EventKind::ToolStart { tool_id, .. } => {
                self.open_tools.insert(tool_id.clone());
            }
            EventKind::ToolResult { tool_id, .. } => {
                self.open_tools.remove(tool_id);
            }
            EventKind::PermissionRequest { req_id, options, intent, .. } => {
                self.perms.insert(req_id.clone(), PendingPermission { options: options.clone(), answering: false, intent: intent.clone() });
            }
            EventKind::PermissionResolved { req_id, .. } => {
                self.perms.remove(req_id);
            }
            EventKind::QuestionRequest { req_id, prompt, options, .. } => {
                self.questions.insert(req_id.clone(), PendingQuestion { prompt: prompt.clone(), labels: options.iter().map(|o| o.label.clone()).collect(), answering: false });
            }
            EventKind::Usage { usage } => self.usage = Some(usage.clone()),
            EventKind::TurnEnd { stop_reason } => {
                self.turn_open = false;
                self.open_tools.clear();
                self.perms.clear();
                self.questions.clear();
                self.last_stop = Some(*stop_reason);
            }
            _ => {}
        }
    }

    pub fn status(&self) -> RunStatus {
        // A card that waits for the person is "needs you" whether or not a turn is open: work that outlived its turn can still ask,
        // and a run that reads Done while its approval card is on screen cannot be answered or stopped by anyone who trusts the label.
        let waiting = !self.perms.is_empty() || !self.questions.is_empty();
        if self.turn_open || waiting {
            return if waiting { RunStatus::NeedsYou } else { RunStatus::Running };
        }
        match self.last_stop {
            Some(StopReason::Error) => RunStatus::Error,
            Some(_) => RunStatus::Done,
            None => RunStatus::Running,
        }
    }
}

fn title_of(text: &str) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let mut title: String = line.chars().take(60).collect();
    if line.chars().count() > 60 {
        title.push('…');
    }
    title
}

/// Where a run lives on the current sidecar.
pub struct Live {
    pub generation: u64,
    pub lease_id: Option<String>,
}

pub struct Run {
    pub meta: Meta,
    pub state: RunState,
    pub ctx: PolicyContext,
    pub live: Option<Live>,
    /// Present while a cancel is being driven.
    pub cancel: Option<Arc<CancelTracker>>,
    /// The host closed the run on its own (hard cancel); later events of the old session are dropped.
    pub muted: bool,
    /// A Test run: its state is folded but nothing is stored or published, it is not listed and is discarded when done.
    pub quiet: bool,
    /// A mode change of this run is in progress (`set_mode` or a plan approval); a second one is refused with `modeBusy`.
    pub mode_busy: bool,
    /// MCP server NAME -> stable server id of the live session; runtime only (the tighten-only live update finds the record by id).
    pub mcp_ids: BTreeMap<String, String>,
    /// Names of the live session's servers whose config carries env values or headers (the consent lines warn about them); runtime only, no values.
    pub mcp_secret: BTreeSet<String>,
    /// Moves on every change of the rules a card was asked under (a mode change, a tighter MCP policy). A click on a card that was asked
    /// under an older epoch is judged again (permission-modes spec 5.3); one asked under the current rules was judged by them already.
    pub rules_epoch: u64,
    /// The rules epoch each pending request was folded under.
    pub card_epoch: BTreeMap<String, u64>,
}

impl Run {
    pub fn new(meta: Meta, state: RunState, ctx: PolicyContext, quiet: bool) -> Self {
        Self { meta, state, ctx, live: None, cancel: None, muted: false, quiet, mode_busy: false, mcp_ids: BTreeMap::new(), mcp_secret: BTreeSet::new(), rules_epoch: 0, card_epoch: BTreeMap::new() }
    }

    /// Forgets everything that belongs to one session and only to it: the in-memory session allows (D10, never persisted) and the MCP
    /// set the session was opened with. Called whenever a session opens (a fresh start and a resume alike) and at every place that ends one.
    pub fn reset_session_state(&mut self) {
        self.ctx.saved.clear();
        self.ctx.saved_by_role.clear();
        self.ctx.mcp_servers.clear();
        self.ctx.mcp_tools.clear();
        self.ctx.mcp_code_paths.clear();
        self.mcp_ids.clear();
        self.mcp_secret.clear();
    }

    /// The session behind this run is gone (start failure, cancel escalation, idle reclaim, sidecar exit): the allows of that session go with it.
    pub fn end_session(&mut self) {
        self.live = None;
        self.ctx.saved.clear();
        self.ctx.saved_by_role.clear();
    }

    /// The run holds (or needs) the repository writer lease: a writer mode, or a session allow for edits inside the run directories.
    pub fn writer_needed(&self) -> bool {
        self.writer_needed_in(self.meta.permission)
    }

    /// [`Self::writer_needed`] as it would be in `mode`.
    pub fn writer_needed_in(&self, mode: PermissionMode) -> bool {
        mode.is_writer() || self.ctx.saved.iter().chain(self.ctx.saved_by_role.values().flatten()).any(|a| matches!(a, SavedAllow::WriteInside))
    }

    /// How many tools of each MCP server of the live session run without a prompt in an unattended mode.
    pub fn mcp_exposure(&self) -> Vec<McpExposure> {
        self.ctx
            .mcp_servers
            .iter()
            .map(|name| McpExposure { name: name.clone(), exposed: self.ctx.mcp_tools.get(name).map_or(0, McpServerRules::exposed), has_secret_env: self.mcp_secret.contains(name) })
            .collect()
    }

    pub fn summary(&self, tier: Tier) -> AgentSummary {
        AgentSummary {
            agent_id: self.meta.agent_id.clone(),
            provider: self.meta.provider.clone(),
            role: self.meta.role.clone(),
            model: self.state.model.clone().unwrap_or_else(|| self.meta.model.clone()),
            title: if self.state.title.is_empty() { self.meta.role.clone() } else { self.state.title.clone() },
            status: self.state.status(),
            permission: self.meta.permission,
            requested: Requested { effort: self.meta.effort, permission: self.meta.permission },
            effective: self.state.effective.clone(),
            repo_ids: self.meta.repos.iter().map(|r| r.id.clone()).collect(),
            caps: self.state.caps.clone().unwrap_or_else(|| static_caps(&self.meta.provider)),
            enforcement: tier,
            started_at: self.meta.started_at,
            usage: self.state.usage.clone(),
            delegates: self.state.delegates.clone(),
            switchable_modes: intely_agent_core::providers::switchable_modes(&self.meta.provider).to_vec(),
            mcp: self.mcp_exposure(),
        }
    }

    /// Events that close the open turn when the session behind it is gone: pending requests resolve `cancelled`,
    /// open tools get a `cancelled` result, then `error` (if any) and exactly one `turn.end`.
    pub fn closure(&self, error: Option<&str>, stop: StopReason, by: DecidedBy) -> Vec<EventKind> {
        if !self.state.turn_open {
            return Vec::new();
        }
        let mut out = Vec::new();
        for id in self.state.perms.keys() {
            out.push(EventKind::PermissionResolved { req_id: id.clone(), outcome: PermissionOutcome::Cancelled, by });
        }
        for id in &self.state.open_tools {
            out.push(EventKind::ToolResult { tool_id: id.clone(), status: ToolStatus::Cancelled, output: None, diff: None, duration_ms: None });
        }
        if let Some(message) = error {
            out.push(EventKind::Error { class: intely_agent_core::events::types::ErrorClass::Internal, message: message.to_string(), retryable: true });
        }
        out.push(EventKind::TurnEnd { stop_reason: stop });
        out
    }
}

pub fn meta_path(runs_dir: &Path, agent_id: &str) -> PathBuf {
    runs_dir.join(format!("{agent_id}.meta.json"))
}

/// Subdirectory of the state dir that holds attachments; agents may read it, never write it.
pub const ATTACHMENTS_DIR: &str = "attachments";
/// Subdirectory of the state dir where the CLI keeps the plan notes of a Claude run in Plan mode (`<state>/plans/<agentId>`).
pub const PLANS_DIR: &str = "plans";

/// Where the plan notes of one run live (permission-modes spec 5.8).
pub fn plan_dir(state_dir: &Path, agent_id: &str) -> PathBuf {
    state_dir.join(PLANS_DIR).join(agent_id)
}

/// The policy context of a run: its mode and where it may work.
pub fn context_for(meta: &Meta, home: Option<PathBuf>, role_deny: Vec<String>, state_dir: &Path) -> PolicyContext {
    let mut repos = meta.repos.iter();
    let cwd = repos.next().map(|r| r.path.clone()).unwrap_or_default();
    let mut ctx = PolicyContext::new(meta.permission, cwd);
    ctx.add_dirs = repos.map(|r| r.path.clone()).collect();
    ctx.add_dirs.push(state_dir.join(ATTACHMENTS_DIR)); // read-only context directory; writes stay hard-stopped
    ctx.home = home;
    ctx.role_deny = role_deny;
    ctx.state_dir = Some(state_dir.to_path_buf());
    // file-tool writes outside the run's repos are refused, not asked (docs/safety.md); only Bypass has no folder boundary (D6)
    ctx.strict_jail = meta.permission != PermissionMode::Bypass;
    ctx.scratch_dirs = intely_agent_core::policy::paths::default_scratch_dirs();
    if meta.provider == "claude" {
        ctx.plan_dir = Some(plan_dir(state_dir, &meta.agent_id));
    }
    ctx.subagents = vec!["*".into()];
    ctx
}
