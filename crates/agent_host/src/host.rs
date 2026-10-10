//! The agent host: owns the sidecar process, speaks the NDJSON protocol with it, and is the single command surface
//! behind the `agent_*` commands (providers-plan 5.1, 5.5, 5.6, 5.10).
//!
//! Rules this file enforces:
//! * the sidecar is started lazily, on the first run;
//! * `policy/decide` is judged by `agent_core::policy` and answered within 2 s, otherwise (or on any doubt) denied;
//! * events are appended to the log before they are published (append-before-publish);
//! * leases and process groups go through `intely_agent_gate`, a dead sidecar loses all of them;
//! * the sidecar can only send the message types dispatched below, nothing else is routed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use intely_agent_core::api::{AgentStartRequest, AgentSummary, AutoInfo, AutoQueue, PermissionDecision, QuestionAnswer, RoleInfo};
use intely_agent_core::delegates::DelegateRepo;
use intely_agent_core::events::log::{EventLog, JsonlEventLog};
use intely_agent_core::events::types::{AgentEvent, BatchEvent, DecidedBy, EffectiveChange, ErrorClass, EventKind, McpServerStatus, ModeChangeReason, PermissionOption, PermissionOutcome, StopReason, ToolStatus};
use intely_agent_core::mcp::{McpPolicy, McpSelection, McpServerRules};
use intely_agent_core::policy::decide::{decide_with, decide_wire, fail_closed, session_allow_for, Decision, DelegateRule, PolicyContext, PolicyDecision, SavedAllow, SessionAllowOffer, STRICT_BACKGROUND};
use intely_agent_core::policy::enforcement::{EnforcementBook, EnforcementChip, Tier};
use intely_agent_core::policy::fsrpc::RpcFs;
use intely_agent_core::policy::fsview::FsView;
use intely_agent_core::policy::intent::{PolicyRequest, ToolIntent};
use intely_agent_core::providers::{supported_modes, switchable_modes, AuthMode, PermissionMode, ProviderCaps};
use intely_agent_core::sidecar::{AcpLaunch, AuthHandoff, McpStatusReply, McpToggle, ResumeRef, SessionEnv, SessionStart, POLICY_REPLY_TIMEOUT_MS};
use intely_agent_gate::gate::cancel::{self, CancelSink, CancelTracker};
use intely_agent_gate::gate::reaper::{Reaper, ReaperConfig};
use intely_agent_gate::rewind::Rewind;
use intely_agent_gate::{shim, AcquireReq, AdmissionKind, Gate, OrphanRegistry, ReclaimReason, Reclaimed};
use intely_core::jail::Jail;
use intely_core::EngineError;
use serde_json::{json, Value};

use crate::config::{find_on_path, scrub_env, HostConfig, PolicyFault, ProviderLaunch};
use crate::roles::{self, RoleDef};
use crate::remote::{self, NotReady, RemoteFs, SidecarFs, FS_QUERY_TIMEOUT, REMOTE_POLICY_TIMEOUT_MS};
use crate::run::{context_for, context_for_remote, meta_path, plan_dir, Live, Meta, RemoteDirs, RepoRef, Run, RunState, SnapshotRef};
use crate::sidecar::{Handler, Incoming, Sidecar};

/// Where committed events go. Called only after the durable append, in `seq` order per agent.
pub trait HostSink: Send + Sync {
    fn events(&self, events: Vec<AgentEvent>);
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn err(code: &str, message: impl Into<String>) -> EngineError {
    EngineError::new(code, message)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Expected tree RSS of one agent, reserved at admission until its first process group is registered.
fn rss_budget_mb(provider: &str) -> u64 {
    if provider == "claude" {
        300
    } else {
        16
    }
}

fn strip_nulls(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.retain(|_, x| !x.is_null());
            m.values_mut().for_each(strip_nulls);
        }
        Value::Array(a) => a.iter_mut().for_each(strip_nulls),
        _ => {}
    }
}

#[derive(Default)]
struct State {
    sidecar: Option<Arc<Sidecar>>,
    /// The `--providers` list the running sidecar was started with.
    sidecar_providers: Vec<String>,
    /// Capabilities a session of this provider reported (`session.info`), newest wins: negotiated truth beats the static table.
    negotiated: HashMap<String, ProviderCaps>,
    generation: u64,
    counter: u64,
    agents: HashMap<String, Run>,
    history_loaded: bool,
    shutting_down: bool,
}

struct Inner {
    cfg: HostConfig,
    gate: Arc<Gate>,
    log: Arc<JsonlEventLog>,
    sink: Arc<dyn HostSink>,
    rewind: Rewind,
    /// `enforcement.json` as last read; re-read when the file changes (the attempt-suite harness writes it).
    book: Mutex<(Option<SystemTime>, EnforcementBook)>,
    book_path: PathBuf,
    state: Mutex<State>,
    /// One sidecar per server (by the server's id), each reached through `ssh`; started with the first run there. It has a lock of its own
    /// because the policy's look at a server's files needs the sidecar while a decision is being made, and a decision must never need
    /// `state` (an answer to a card judges again while it holds `state`). Order: `state` first, then this; this one is held only to copy
    /// or change the map, never across a call.
    remote: Mutex<HashMap<String, RemoteLink>>,
    reaper: Mutex<Option<Reaper>>,
    /// The sidecar's canary fired: a sub-agent call reached policy without an actor. Delegation stays off until the host restarts.
    delegation_tripped: AtomicBool,
    me: Weak<Inner>,
}

/// Error code of a run that was refused because Rewind could not snapshot a repo.
pub const NO_SAFETY_NET: &str = "noSafetyNet";

/// Name of the role a Test run uses; never a user role.
pub const PROBE_ROLE: &str = "probe";

/// What a card is withdrawn with when the rules changed under it (permission-modes spec 5.1 step 8, MCP spec 5.2 item 8). Verbatim.
pub const RULES_CHANGED_MESSAGE: &str = "The rules changed while this was waiting (mode or MCP policy).";

/// Most session allows kept per list (the lead's and each delegate role's), permission-modes spec 4.8.
const MAX_SAVED_ALLOWS: usize = 64;

/// Longest feedback (characters) an ExitPlanMode rejection forwards to the model.
const MAX_FEEDBACK_CHARS: usize = 4000;

/// Longest note (characters) the user can add to a running agent; the sidecar checks the same bound.
pub const MAX_NOTE_CHARS: usize = 4000;

/// A plan directory nobody touched for this long is removed at startup (permission-modes spec 5.8).
const PLAN_DIR_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 3600);

/// The wire name of a mode, for messages.
fn mode_name(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::ReadOnly => "readOnly",
        PermissionMode::Ask => "ask",
        PermissionMode::Edit => "edit",
        PermissionMode::Automatic => "automatic",
        PermissionMode::Bypass => "bypass",
    }
}

/// The more restrictive of two modes on the policy ladder; a tie keeps `a`.
fn stricter(a: PermissionMode, b: PermissionMode) -> PermissionMode {
    if b.strictness() < a.strictness() {
        b
    } else {
        a
    }
}

/// The `session.info` event that records a mode change (`effective.permission` plus why).
fn mode_info(permission: PermissionMode, reason: ModeChangeReason) -> EventKind {
    EventKind::SessionInfo {
        title: None,
        native_id: None,
        models: Vec::new(),
        caps: None,
        effective: Some(EffectiveChange { model: None, effort: None, permission: Some(permission), reason: Some(reason) }),
        delegates: Vec::new(),
        slash_commands: Vec::new(),
        mcp_servers: Vec::new(),
    }
}

/// Removes the plan directories of runs that ended long ago (best effort; the directory of a live run is touched by its CLI).
fn sweep_plan_dirs(dir: &Path, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let old = std::fs::metadata(&path).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > max_age);
        if old && path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// The `origin` URL of a local repository as git spells it, without credentials; `None` when it has none.
fn local_origin(git: &Path, repo: &Path) -> Option<String> {
    let out = std::process::Command::new(git).arg("-C").arg(repo).args(["remote", "get-url", "origin"]).env("GIT_TERMINAL_PROMPT", "0").stdin(std::process::Stdio::null()).output().ok()?;
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || url.is_empty() {
        return None;
    }
    // https://user:token@host/x -> https://host/x
    Some(match url.split_once("://") {
        Some((scheme, rest)) => match rest.split_once('/').map_or(rest, |(host, _)| host).rfind('@') {
            Some(at) => format!("{scheme}://{}", &rest[at + 1..]),
            None => url,
        },
        None => url,
    })
}

/// The connection to one server: its sidecar, and the machine it was started for (address and port). A server whose address was edited
/// since is another machine, so its old connection is never used for a new run.
#[derive(Clone)]
struct RemoteLink {
    sc: Arc<Sidecar>,
    target: String,
}

/// What the answer to a card of a run on a server needs to know about the rules, worked out BEFORE `state` is locked: the look at the
/// server's files is a trip over the network, and nothing else of the host may wait for it. Valid only for the rule set it was made
/// under (`epoch`).
struct Prejudged {
    epoch: u64,
    fresh: Option<PolicyDecision>,
    session: Option<(SavedAllow, SessionAllowOffer)>,
}

/// The answer to a card of a run on a server was judged under rules that changed meanwhile; the person can click again.
const RULES_MOVED_MESSAGE: &str = "The rules of this run changed while the server's files were being checked. Answer again.";

/// The verdict of the CURRENT rules on an intent that already waits as a card. The delegation counter is detached (a copy of its
/// value), so judging a pending `Agent` card never takes a slot of the cap (permission-modes spec 5.1 step 8).
fn rejudge(ctx: &PolicyContext, agent_id: &str, req_id: &str, provider: &str, intent: &ToolIntent) -> PolicyDecision {
    let mut ctx = ctx.clone();
    if let Ok(counter) = serde_json::from_value(json!(ctx.delegation_used.get())) {
        ctx.delegation_used = counter;
    }
    decide_with(&ctx, &PolicyRequest { agent_id: agent_id.to_string(), tool_id: req_id.to_string(), provider: provider.to_string(), intent: intent.clone() }, STRICT_BACKGROUND)
}

/// Whether applying a live update changed what the rules say: a stricter default, a stricter or newly unlisted tool. `tighten` also writes
/// explicit per-tool policies that equal the old effective ones, which must not count as a change.
fn rules_tightened(before: &McpServerRules, after: &McpServerRules) -> bool {
    before.default_policy != after.default_policy
        || before.fresh != after.fresh
        || before.tools.keys().chain(after.tools.keys()).any(|t| before.effective(t) != after.effective(t))
}

/// A refused mode change or answer maps a gate admission error to the host's codes.
fn admission_error(e: &intely_agent_gate::AdmissionError) -> EngineError {
    let code = if e.kind == AdmissionKind::WriteLease { "writeLease" } else { "noSlot" };
    err(code, e.detail.clone())
}

/// What a Test run found out (`AgentHost::probe`): the session opened read-only in an empty scratch directory, no prompt
/// was sent and no model was called, so it cost nothing and could not edit a thing.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub provider: String,
    pub ok: bool,
    /// The model the session reported (Claude names it only with its first turn, so it can be absent).
    pub model: Option<String>,
    /// What the session reported at start (`session.info`); `None` when it reported none.
    pub caps: Option<ProviderCaps>,
    /// `caps` came from the running session. False: only the documented defaults exist for this provider.
    pub negotiated: bool,
    pub effective: Option<intely_agent_core::api::AgentEffective>,
    /// Facts the adapter reported that differ from what was asked (a model or mode the agent could not apply).
    pub error: Option<String>,
    pub ms: u64,
}

/// Per-run start options.
#[derive(Debug, Clone, Default)]
pub struct StartOptions {
    /// Start even when a repo cannot be snapshotted (the user ticked "run without safety net" for this run).
    pub run_without_safety_net: bool,
    /// Run the role on this provider instead of its own (the New run picker); `None` or the role's own = unchanged.
    pub provider: Option<String>,
    /// A Test run: nothing stored or published, never listed (`AgentHost::probe`).
    pub quiet: bool,
    /// The user confirmed the Bypass dialog for this start. Only `start_now_with` from the New run dialog sets it; the queue never does.
    pub bypass_confirmed: bool,
    /// Run on this server (its id in Settings > Servers) instead of on this Mac; `None` or empty = this Mac.
    pub location: Option<String>,
}

/// Options of a live mode switch (`AgentHost::set_mode`).
#[derive(Debug, Clone, Copy, Default)]
pub struct SetModeOpts {
    /// The user confirmed the Bypass dialog for this switch.
    pub confirm_bypass: bool,
}

/// What an answer to a permission card carries beyond the decision.
#[derive(Debug, Clone, Default)]
pub struct AnswerExtra {
    /// ExitPlanMode approval only: the working mode the run continues in (`ask`, `edit` or `automatic`).
    pub mode: Option<PermissionMode>,
    /// ExitPlanMode rejection only: the user's text for the model.
    pub feedback: Option<String>,
}

/// What `answer_permission_with` decided under the lock: refuse the click (the rules changed), or send the answer.
enum Step {
    Withdraw(Arc<Sidecar>),
    Send { sc: Arc<Sidecar>, allow: bool, mode: Option<PermissionMode>, undo: Undo, lease: Option<String>, repo_id: Option<String>, meta: Option<Meta> },
}

/// What an answer changed before the sidecar took it, to put back when it does not.
#[derive(Default)]
struct Undo {
    /// The session allow that was pushed (`None` role = the lead's list).
    saved: Option<(Option<String>, SavedAllow)>,
    /// The writer flag the lease had before the answer flipped it.
    lease: Option<bool>,
    /// The mode the run was in before a plan approval changed it.
    mode: Option<PermissionMode>,
}

#[derive(Clone)]
pub struct AgentHost {
    inner: Arc<Inner>,
}

impl AgentHost {
    /// Cheap: nothing is spawned until the first run. Sweeps process groups a previous IDE instance left behind.
    pub fn new(cfg: HostConfig, sink: Arc<dyn HostSink>) -> Self {
        let log = Arc::new(JsonlEventLog::new(&cfg.data_dir));
        let gate = match OrphanRegistry::open(cfg.data_dir.join("gate.json")) {
            Ok(orphans) => {
                match orphans.sweep() {
                    Ok(report) if !report.killed.is_empty() => eprintln!("agent host: stopped leftover process groups {:?}", report.killed),
                    Ok(_) => {}
                    Err(e) => eprintln!("agent host: orphan sweep failed: {e}"),
                }
                Gate::with_orphans(cfg.gate.clone(), Arc::new(orphans))
            }
            Err(e) => {
                eprintln!("agent host: no orphan registry ({e}); process groups are not tracked across restarts");
                Gate::new(cfg.gate.clone())
            }
        };
        sweep_plan_dirs(&cfg.data_dir.join(crate::run::PLANS_DIR), PLAN_DIR_MAX_AGE);
        let book_path = cfg.data_dir.join("enforcement.json");
        let book = (file_mtime(&book_path), EnforcementBook::load(&book_path).unwrap_or_default());
        let inner = Arc::new_cyclic(|me| Inner {
            rewind: Rewind::new(&cfg.git),
            cfg,
            gate: gate.clone(),
            log,
            sink,
            book: Mutex::new(book),
            book_path,
            state: Mutex::new(State::default()),
            remote: Mutex::new(HashMap::new()),
            reaper: Mutex::new(None),
            delegation_tripped: AtomicBool::new(false),
            me: me.clone(),
        });
        let weak = Arc::downgrade(&inner);
        gate.on_reclaim(move |r| {
            if let Some(inner) = weak.upgrade() {
                inner.on_reclaimed(r);
            }
        });
        Self { inner }
    }

    /// Recorded enforcement per (provider, role kind) for Settings, Roles and the New run picker. It is the same
    /// computation a run's chip uses ([`Inner::chip_for`]), so the two can never disagree. `claude-sdk` is shown as
    /// `claude`. A pair never measured is absent (the UI reads absent as weak). The tier comes from the book, never from configuration.
    pub fn enforcement(&self) -> Vec<(String, bool, EnforcementChip)> {
        let book = self.inner.book();
        let mut pairs: Vec<(String, bool)> = Vec::new();
        for run in &book.runs {
            let provider = if run.key.adapter == "claude-sdk" { "claude".to_string() } else { run.key.adapter.clone() };
            let pair = (provider, run.key.role_mode == PermissionMode::ReadOnly);
            if !pairs.contains(&pair) {
                pairs.push(pair);
            }
        }
        pairs.into_iter().map(|(provider, read_only)| {
            let chip = self.inner.chip_for(&provider, read_only, Some(AuthMode::Subscription));
            (provider, read_only, chip)
        }).collect()
    }

    /// Capabilities negotiated by a session of `provider` in this process (`None` until one reported them).
    pub fn negotiated_caps(&self, provider: &str) -> Option<ProviderCaps> {
        lock(&self.inner.state).negotiated.get(provider).cloned()
    }

    /// The Test run of a provider (Roles editor, Settings > Providers): opens one session, read-only, in an empty scratch
    /// directory under the state dir, waits for what the adapter reports (`session.started`, `session.info` with the
    /// negotiated capabilities), then closes it again and removes every trace. No prompt is sent, so no model is called.
    /// The run is quiet: nothing is stored or published and it is never listed.
    pub fn probe(&self, provider: &str, model: Option<&str>) -> Result<ProbeReport, EngineError> {
        let inner = &self.inner;
        let started = std::time::Instant::now();
        if provider == "mock" {
            return Err(err("probeUnsupported", "the scripted mock provider has nothing to negotiate"));
        }
        let scripted = inner.cfg.acp_mock.as_ref().is_some_and(|m| m.provider == provider);
        if provider != "claude" && !scripted && inner.launch_of(provider).is_none() {
            return Err(not_enabled(provider));
        }
        let agent_id = inner.new_agent_id();
        let dir = inner.cfg.data_dir.join("probe").join(&agent_id);
        intely_agent_core::events::log::create_private_dir_all(&dir).map_err(|e| err("probe", format!("cannot create the scratch directory: {e}")))?;
        let role = RoleDef {
            name: PROBE_ROLE.into(),
            description: "Test run".into(),
            provider: provider.into(),
            model: model.map(str::to_owned).unwrap_or_else(|| if provider == "claude" { "claude-haiku-4-5-20251001".into() } else { "default".into() }),
            effort: None,
            permission: PermissionMode::ReadOnly,
            system_prompt: None,
            tools: Vec::new(),
            disallowed_tools: if provider == "claude" { roles::CLAUDE_DISALLOWED.iter().map(|t| t.to_string()).collect() } else { Vec::new() },
            max_turns: Some(1),
            mock_scenario: None,
            all_repos: false,
            file: None,
        };
        let resolved = role.resolved(&inner.cfg);
        let meta = Meta {
            agent_id: agent_id.clone(),
            provider: provider.into(),
            role: PROBE_ROLE.into(),
            model: resolved.model.clone(),
            effort: None,
            permission: PermissionMode::ReadOnly,
            repos: vec![RepoRef { id: "probe".into(), path: dir.clone() }],
            started_at: now_ms(),
            native_id: None,
            snapshots: Vec::new(),
            mcp: Vec::new(),
            role_hash: None,
            role_permission: None,
            location: None,
            remote: None,
        };
        let ctx = context_for(&meta, std::env::var_os("HOME").map(PathBuf::from), role.disallowed_tools.clone(), &inner.cfg.data_dir);
        lock(&inner.state).agents.insert(agent_id.clone(), Run::new(meta, RunState::default(), ctx, true));
        let opened = inner.open_session(&role, &agent_id, None);
        let mut report = ProbeReport { provider: provider.into(), ok: opened.is_ok(), model: None, caps: None, negotiated: false, effective: None, error: opened.as_ref().err().map(|e| e.message.clone()), ms: 0 };
        if opened.is_ok() {
            // the adapter's first events follow the reply to session/start by a few milliseconds (two batches at most)
            let deadline = std::time::Instant::now() + Duration::from_secs(6);
            let mut settled_since: Option<std::time::Instant> = None;
            while std::time::Instant::now() < deadline {
                let seen = lock(&inner.state).agents.get(&agent_id).map(|r| (r.state.model.is_some(), r.state.caps.is_some()));
                match seen {
                    Some((true, true)) => break,
                    // one of the two is there (Claude reports its capabilities at open and the model only with the first turn): give the other a moment
                    Some((true, false) | (false, true)) => {
                        let since = *settled_since.get_or_insert_with(std::time::Instant::now);
                        if since.elapsed() > Duration::from_millis(900) {
                            break;
                        }
                    }
                    _ => {}
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
        let sc = {
            let mut st = lock(&inner.state);
            if let Some(run) = st.agents.get(&agent_id) {
                report.model = run.state.model.clone();
                report.caps = run.state.caps.clone();
                report.negotiated = run.state.caps.is_some();
                report.effective = run.state.effective.clone();
            }
            let sc = st.agents.get(&agent_id).and_then(|r| r.live.as_ref().map(|l| l.generation)).and_then(|g| inner.sidecar_gen(&st, g));
            if let Some(run) = st.agents.get_mut(&agent_id) {
                run.muted = true;
            }
            sc
        };
        if let Some(sc) = sc {
            let _ = sc.request("session/close", json!({"agentId": agent_id}), Duration::from_secs(8));
        }
        lock(&inner.state).agents.remove(&agent_id);
        let _ = std::fs::remove_dir_all(&dir);
        report.ms = started.elapsed().as_millis() as u64;
        if report.ok && report.model.is_none() && report.caps.is_none() {
            report.ok = false;
            report.error = Some("the session opened but reported nothing within 6 s".into());
        }
        Ok(report)
    }

    /// The providers (besides Claude and the scripted ones) the host would start right now.
    pub fn launches(&self) -> Vec<ProviderLaunch> {
        self.inner.cfg.launches()
    }

    /// The ACP provider that runs against the scripted fake agent (e2e only), if any.
    pub fn acp_mock_provider(&self) -> Option<String> {
        self.inner.cfg.acp_mock.as_ref().map(|m| m.provider.clone())
    }

    pub fn gate(&self) -> &Arc<Gate> {
        &self.inner.gate
    }

    pub fn roles(&self, repos: &[RepoRef]) -> Vec<RoleInfo> {
        let ids: Vec<String> = repos.iter().map(|r| r.id.clone()).collect();
        roles::builtin(&self.inner.cfg).iter().map(|r| roles::info(r, &self.inner.cfg, &ids)).collect()
    }

    /// The New run dialog's view of a role the Roles layer resolved.
    pub fn role_info(&self, role: &RoleDef, repos: &[RepoRef]) -> RoleInfo {
        let ids: Vec<String> = repos.iter().map(|r| r.id.clone()).collect();
        roles::info(role, &self.inner.cfg, &ids)
    }

    /// Starts a run of a built-in role: Rewind snapshots, shim, `session/start`, first prompt.
    pub fn start(&self, req: AgentStartRequest, repos: &[RepoRef]) -> Result<AgentSummary, EngineError> {
        let role = self.inner.builtin_named(&req.role).ok_or_else(|| err("unknownRole", format!("no role named {}", req.role)))?;
        self.start_role(&role, req, repos)
    }

    /// Like [`Self::start`] for a role the Roles layer resolved (`~/.claude/agents` plus the IDE overlay).
    pub fn start_role(&self, role: &RoleDef, req: AgentStartRequest, repos: &[RepoRef]) -> Result<AgentSummary, EngineError> {
        self.start_role_with(role, req, repos, StartOptions::default())
    }

    /// [`Self::start_role`] with per-run options (the "run without safety net" tick of the New run dialog).
    pub fn start_role_with(&self, role: &RoleDef, req: AgentStartRequest, repos: &[RepoRef], opts: StartOptions) -> Result<AgentSummary, EngineError> {
        let inner = &self.inner;
        let prompt = req.prompt.trim().to_string();
        if prompt.is_empty() {
            return Err(err("emptyPrompt", "write a prompt first"));
        }
        check_prompt_size(&prompt)?;
        if role.name == roles::AUTO_ROLE && !inner.cfg.defaults().auto_enabled {
            return Err(err("autoDisabled", "Auto is switched off in Settings > Roles; pick a role"));
        }
        if req.repo_ids.is_empty() {
            return Err(err("noRepo", "pick at least one repository"));
        }
        let mut scope = Vec::new();
        for id in &req.repo_ids {
            let repo = repos.iter().find(|r| &r.id == id).ok_or_else(|| err("unknownRepo", format!("unknown repository {id}")))?;
            if !repo.path.is_dir() {
                return Err(err("unknownRepo", format!("{} is not a directory", repo.path.display())));
            }
            scope.push(repo.clone());
        }
        // docs/safety.md: under INTELY_READONLY / INTELY_E2E an agent never starts on a repo outside the fixture
        for repo in &scope {
            Jail::global().check_op("agent run", &repo.path)?;
        }
        let switched;
        let role = match opts.provider.as_deref().filter(|p| !p.is_empty() && *p != role.provider) {
            Some(p) => {
                switched = role.on_provider(p);
                &switched
            }
            None => role,
        };
        // The run mode (D9): the request's choice wins over the role for the lead and for a single role; the role's own permission is the
        // default and, for a delegate, a ceiling. A request without a mode keeps the role's permission, exactly as before.
        let mode = req.mode.unwrap_or(role.permission);
        inner.check_mode(&role.provider, mode, opts.bypass_confirmed, false)?;
        let mut moded = role.clone();
        moded.permission = mode;
        let run_role = &moded;
        inner.check_provider_gate(run_role)?;
        let mcp = req.mcp_servers.clone().unwrap_or_default();
        if !mcp.is_empty() {
            // INTELY_READONLY: no MCP server starts (MCP spec 5.2 point 5; the supplier checks too)
            Jail::global().check_op("start MCP servers", &scope[0].path)?;
        }
        // a run on a server: Claude (or the scripted mock) only, no MCP servers (they would start on this Mac, not there)
        let location = opts.location.clone().filter(|l| !l.is_empty());
        if location.is_some() {
            if !matches!(role.provider.as_str(), "claude" | "mock") {
                return Err(err("remoteProvider", "only Claude runs can execute on a server"));
            }
            if !mcp.is_empty() {
                return Err(err("remoteMcp", "MCP servers are not available for runs on a server yet; start the run without them"));
            }
        }
        let resolved = run_role.resolved(&inner.cfg);
        let meta = Meta {
            agent_id: inner.new_agent_id(),
            provider: role.provider.clone(),
            role: role.name.clone(),
            model: resolved.model.clone(),
            effort: resolved.effort,
            permission: mode,
            repos: scope,
            started_at: now_ms(),
            native_id: None,
            snapshots: Vec::new(),
            mcp,
            role_hash: role.file.as_ref().map(|f| f.content_hash.clone()),
            role_permission: Some(role.permission),
            location,
            remote: None,
        };
        self.launch(run_role, meta, &resolved.disallowed_tools, Some(&prompt), opts)
    }

    /// Opens an existing provider session (a resumed or forked transcript) as a new, idle run; the first message
    /// comes later through [`Self::send`]. Rewind snapshots are taken like for a fresh run.
    pub fn adopt(&self, role: &RoleDef, repos: Vec<RepoRef>, native_id: &str) -> Result<AgentSummary, EngineError> {
        let inner = &self.inner;
        if repos.is_empty() {
            return Err(err("noRepo", "pick at least one repository"));
        }
        for repo in &repos {
            Jail::global().check_op("agent run", &repo.path)?;
        }
        let resolved = role.resolved(&inner.cfg);
        let meta = Meta {
            agent_id: inner.new_agent_id(),
            provider: role.provider.clone(),
            role: role.name.clone(),
            model: resolved.model.clone(),
            effort: resolved.effort,
            permission: role.permission,
            repos,
            started_at: now_ms(),
            native_id: Some(native_id.to_string()),
            snapshots: Vec::new(),
            mcp: Vec::new(),
            role_hash: role.file.as_ref().map(|f| f.content_hash.clone()),
            role_permission: Some(role.permission),
            location: None,
            remote: None,
        };
        self.launch(role, meta, &resolved.disallowed_tools, None, StartOptions::default())
    }

    fn launch(&self, role: &RoleDef, mut meta: Meta, role_deny: &[String], prompt: Option<&str>, opts: StartOptions) -> Result<AgentSummary, EngineError> {
        let inner = &self.inner;
        let agent_id = meta.agent_id.clone();
        // A run on a server: where its folders are there is settled (and checked) before anything is taken on this Mac.
        if let Some(loc) = meta.location.clone() {
            meta.remote = Some(inner.prepare_remote(&loc, &meta)?);
        }
        // Mandatory (docs/safety.md, layer 8): a run that can edit the user's repos starts only with a Rewind snapshot of
        // every repo. A repo that cannot be snapshotted (merge in progress, no commits, no git) refuses the run unless the
        // user ticked "run without safety net" for this run; then the run starts and Rewind has nothing for that repo.
        // (A run on a server works in the server's own copy: Rewind snapshots of the local repo would restore the wrong tree.)
        for repo in &meta.repos.clone() {
            if meta.remote.is_some() {
                break;
            }
            match inner.rewind.snapshot(&repo.path, &agent_id) {
                Ok(info) => meta.snapshots.push(SnapshotRef { repo_id: repo.id.clone(), path: repo.path.clone(), ref_name: info.ref_name, skipped: info.skipped.len() }),
                Err(e) if opts.run_without_safety_net => eprintln!("agent host: no Rewind snapshot for {} (run without safety net): {e}", repo.id),
                Err(e) => {
                    for s in &meta.snapshots {
                        let _ = inner.rewind.delete(&s.path, &agent_id);
                    }
                    return Err(err(NO_SAFETY_NET, format!("no Rewind snapshot could be taken for {} ({e}); the run would have no way back. Start it with \"run without safety net\" only if you accept that", repo.id)));
                }
            }
        }
        let (ctx, remote_fs) = inner.context_for_run(&meta, role_deny.to_vec());
        let resume = meta.native_id.clone();
        {
            let mut st = lock(&inner.state);
            let mut run = Run::new(meta.clone(), RunState::default(), ctx, opts.quiet);
            run.remote_fs = remote_fs;
            st.agents.insert(agent_id.clone(), run);
        }
        inner.persist_meta(&meta);
        if let Err(e) = inner.open_session(role, &agent_id, resume).and_then(|()| prompt.map_or(Ok(()), |p| inner.prompt(&agent_id, p, Vec::new()))) {
            let mut st = lock(&inner.state);
            if st.agents.get(&agent_id).is_some_and(|r| r.state.last_seq == 0) {
                st.agents.remove(&agent_id);
                drop(st);
                let _ = std::fs::remove_file(meta_path(&inner.runs_dir(), &agent_id));
                let _ = std::fs::remove_dir_all(plan_dir(&inner.cfg.data_dir, &agent_id));
                // a refused run (no slot, write lease) must not leave a snapshot ref behind, a queued retry takes a new one
                for s in &meta.snapshots {
                    let _ = inner.rewind.delete(&s.path, &agent_id);
                }
            }
            return Err(e);
        }
        inner.summary_of(&agent_id).ok_or_else(|| err("internal", "the run vanished while starting"))
    }

    /// A follow-up prompt. A run whose session ended (idle reaper, hard cancel, restart) is resumed first.
    pub fn send(&self, agent_id: &str, text: &str) -> Result<(), EngineError> {
        self.send_with(agent_id, text, Vec::new())
    }

    /// [`send`](Self::send) with attachments: `files` are resolved attachment records (`id, name, mime, size, kind,
    /// sha256, inline, path`) from the attachment store; the sidecar turns them into message content.
    pub fn send_with(&self, agent_id: &str, text: &str, files: Vec<serde_json::Value>) -> Result<(), EngineError> {
        let inner = &self.inner;
        let text = text.trim();
        if text.is_empty() && files.is_empty() {
            return Err(err("emptyPrompt", "write a prompt first"));
        }
        check_prompt_size(text)?;
        if inner.ensure_live(agent_id)? {
            return Err(err("turnOpen", "the agent is still working; stop it first or wait"));
        }
        inner.prompt(agent_id, text, files)
    }

    /// Re-opens the session of a run whose session ended (idle reaper, hard cancel, restart) without sending anything.
    pub fn resume(&self, agent_id: &str) -> Result<AgentSummary, EngineError> {
        self.inner.ensure_live(agent_id)?;
        self.inner.summary_of(agent_id).ok_or_else(|| unknown_agent(agent_id))
    }

    /// The server `id` moved to another machine or was taken out of the settings: its finished runs give up their sessions and the
    /// connection to the old machine is closed. Refused while a run there works or waits for the person, because that run is on the old
    /// machine. Looking at the runs and ending the idle sessions happen under one lock, so a run cannot become busy in between.
    pub fn release_server(&self, id: &str) -> Result<(), EngineError> {
        let inner = &self.inner;
        let idle: Vec<String> = {
            let mut st = lock(&inner.state);
            let here: Vec<(String, bool)> = st.agents.iter().filter(|(_, r)| r.meta.location.as_deref() == Some(id) && r.live.is_some()).map(|(agent_id, r)| (agent_id.clone(), r.is_idle())).collect();
            let busy = here.iter().filter(|(_, idle)| !idle).count();
            if busy > 0 {
                return Err(err("serverBusy", format!("{busy} run{} on this server {} still working or waiting for you; stop {} first", if busy == 1 { "" } else { "s" }, if busy == 1 { "is" } else { "are" }, if busy == 1 { "it" } else { "them" })));
            }
            for (agent_id, _) in &here {
                if let Some(run) = st.agents.get_mut(agent_id) {
                    run.end_session();
                }
            }
            here.into_iter().map(|(agent_id, _)| agent_id).collect()
        };
        // the sessions are closed properly (in parallel, each bounded by its timeout) before the connection goes
        // (the map is not locked meanwhile: the closing sidecar takes that lock itself in `on_closed`)
        let gone = lock(&inner.remote).remove(id);
        if let Some(link) = gone {
            let closers: Vec<_> = idle
                .into_iter()
                .map(|agent_id| {
                    let sc = link.sc.clone();
                    std::thread::spawn(move || {
                        let _ = sc.request("session/close", json!({"agentId": agent_id}), Duration::from_secs(5));
                    })
                })
                .collect();
            for t in closers {
                let _ = t.join();
            }
            inner.stop_sidecar(&link.sc);
        }
        Ok(())
    }

    /// Stop: ask the adapter to interrupt; escalate to SIGTERM and SIGKILL of the CLI's group when it does not comply.
    pub fn interrupt(&self, agent_id: &str) -> Result<(), EngineError> {
        self.inner.interrupt(agent_id)
    }

    /// The live MCP status of a run's session (`session/mcp-status`), after reconnecting or toggling one server when asked. Read-only
    /// otherwise: it changes nothing about the run's rules. A run with no live session answers `notRunning`.
    pub fn mcp_status(&self, agent_id: &str, reconnect: Option<String>, toggle: Option<McpToggle>) -> Result<Vec<McpServerStatus>, EngineError> {
        let sc = {
            let st = lock(&self.inner.state);
            self.inner.live_sidecar(&st, agent_id)?
        };
        let body = json!({"agentId": agent_id, "reconnect": reconnect, "toggle": toggle});
        let v = sc.request("session/mcp-status", body, Duration::from_secs(20)).map_err(|e| err("mcpStatus", e.to_string()))?;
        if !v["error"].is_null() {
            let detail = v["detail"].as_str().or_else(|| v["error"].as_str()).unwrap_or("the agent could not report its MCP servers");
            return Err(err("mcpStatus", detail.to_string()));
        }
        serde_json::from_value::<McpStatusReply>(v).map(|r| r.servers).map_err(|e| err("mcpStatus", format!("unexpected reply: {e}")))
    }

    /// Adds a note to the turn that is running (`session/note`): `parent_tool_id` is the `Agent` call that started the sub-agent it is for,
    /// absent = the lead. The sidecar delivers it with that agent's next tool call and reports it as `note` events (queued, delivered or
    /// dropped); this returns the note's id once the sidecar has taken it. Refused when nothing is working, the sub-agent is not running,
    /// or the provider cannot take notes.
    pub fn note(&self, agent_id: &str, parent_tool_id: Option<String>, text: &str) -> Result<String, EngineError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(err("noteEmpty", "the note is empty"));
        }
        if text.chars().count() > MAX_NOTE_CHARS {
            return Err(err("noteTooLong", format!("a note is at most {MAX_NOTE_CHARS} characters")));
        }
        let sc = {
            let st = lock(&self.inner.state);
            self.inner.live_sidecar(&st, agent_id)?
        };
        let note_id = format!("n-{}", uuid::Uuid::new_v4());
        let body = json!({"agentId": agent_id, "noteId": note_id, "text": text, "parentToolId": parent_tool_id});
        let v = sc.request("session/note", body, Duration::from_secs(10)).map_err(|e| err("note", e.to_string()))?;
        match v["error"].as_str() {
            None => Ok(note_id),
            Some(code) => {
                let code = match code {
                    "noTurn" => "noteNoTurn",
                    "unknownTarget" => "noteUnknownTarget",
                    "unsupported" => "noteUnsupported",
                    "noSession" => "noteNoSession",
                    "tooLong" => "noteTooLong",
                    "empty" => "noteEmpty",
                    _ => "note",
                };
                Err(err(code, v["detail"].as_str().unwrap_or("the agent did not take the note").to_string()))
            }
        }
    }

    /// The plan limits of the signed-in Claude account (`usage/limits`): how much of the 5 hour session and the 7 day week is used. The
    /// sidecar starts the claude CLI for a moment and asks it; nothing goes to the model. It needs no run, but does start the sidecar.
    /// A missing CLI and the sidecar's own failures are answers with an `error` field, never an `Err`, so the Usage view can say why.
    pub fn usage_limits(&self) -> Result<Value, EngineError> {
        let env_vars = scrub_env(&(self.inner.cfg.env)());
        let all: HashMap<String, String> = env_vars.clone().into_iter().collect();
        // without the CLI there is nothing to ask, and no reason to start the sidecar for it
        let Some(bin) = self.inner.cfg.claude_bin.clone().or_else(|| find_on_path("claude", &all)) else {
            return Ok(json!({"error": "claudeNotFound"}));
        };
        // no provider adapter is needed: the limits are asked of the SDK directly
        let sc = self.inner.ensure_sidecar(None)?;
        let body = json!({"env": {"claudeBin": bin.to_string_lossy(), "vars": env_vars}, "cwd": self.inner.cfg.data_dir});
        sc.request("usage/limits", body, Duration::from_secs(40)).map_err(|e| err("usageLimits", e.to_string()))
    }

    /// Switches the permission mode of a run, live when it has a session (permission-modes spec 5.1). Rust is the authority; the SDK follows:
    /// a tightening is applied in Rust first, a loosening only counts once the sidecar took it (otherwise Rust rolls back).
    pub fn set_mode(&self, agent_id: &str, new: PermissionMode, opts: SetModeOpts) -> Result<AgentSummary, EngineError> {
        let inner = &self.inner;
        {
            let mut st = lock(&inner.state);
            inner.load_history(&mut st);
            let run = st.agents.get_mut(agent_id).ok_or_else(|| unknown_agent(agent_id))?;
            if run.quiet {
                return Err(err("modeNotSupported", "a Test run has no permission mode to switch"));
            }
            if run.mode_busy {
                return Err(err("modeBusy", "a mode change of this run is already in progress"));
            }
            run.mode_busy = true;
        }
        let result = self.switch_mode(agent_id, new, opts);
        if let Some(run) = lock(&inner.state).agents.get_mut(agent_id) {
            run.mode_busy = false;
        }
        result
    }

    fn switch_mode(&self, agent_id: &str, new: PermissionMode, opts: SetModeOpts) -> Result<AgentSummary, EngineError> {
        let inner = &self.inner;
        // steps 2-5 of the spec in one critical section: validate, take the writer lease the new mode needs, then set the Rust side
        let (old, sc, lease, repo_id, had_writer, meta) = {
            let mut st = lock(&inner.state);
            let sc = inner.live_sidecar(&st, agent_id).ok();
            let run = st.agents.get_mut(agent_id).ok_or_else(|| unknown_agent(agent_id))?;
            let old = run.meta.permission;
            if new == old {
                drop(st);
                return inner.summary_of(agent_id).ok_or_else(|| unknown_agent(agent_id));
            }
            inner.check_mode(&run.meta.provider, new, opts.confirm_bypass, true)?;
            let lease = run.live.as_ref().and_then(|l| l.lease_id.clone()).filter(|_| sc.is_some());
            let repo_id = run.meta.repos.first().map(|r| r.id.clone());
            let had_writer = lease.as_deref().and_then(|l| inner.gate.leases().into_iter().find(|i| i.lease_id == l)).map(|i| i.writer);
            if let (Some(lease), Some(have)) = (lease.as_deref(), had_writer) {
                let want = run.writer_needed_in(new);
                if want != have {
                    inner.gate.set_writer(lease, want, repo_id.as_deref()).map_err(|e| admission_error(&e))?;
                }
            }
            run.ctx.mode = new;
            run.ctx.strict_jail = new != PermissionMode::Bypass;
            run.meta.permission = new;
            run.rules_epoch += 1;
            let meta = run.meta.clone();
            if sc.is_none() {
                // no session behind it (idle reaper, stopped): one event records it, the next open_session reads meta.permission
                inner.synthesize(&mut st, agent_id, vec![mode_info(new, ModeChangeReason::User)]);
            }
            (old, sc, lease, repo_id, had_writer, meta)
        };
        inner.persist_meta(&meta);
        let tightening = new.strictness() < old.strictness();
        let mut outcome: Result<(), EngineError> = Ok(());
        if let Some(sc) = sc {
            let failure = match sc.request("session/permission", json!({"agentId": agent_id, "mode": new}), Duration::from_secs(5)) {
                Ok(v) if v["error"].is_null() => None,
                Ok(v) => Some(v["detail"].as_str().or_else(|| v["error"].as_str()).unwrap_or("the agent refused the mode").to_string()),
                Err(e) => Some(e.to_string()),
            };
            if let Some(detail) = failure {
                if tightening {
                    // Rust already enforces the stricter mode, which is the safe side; the SDK mode lags and follows at the next start
                    outcome = Err(err("modeNotApplied", format!("The IDE already enforces {}; the agent's own mode could not be updated and follows at the next start ({detail})", mode_name(new))));
                } else {
                    let meta = {
                        let mut st = lock(&inner.state);
                        st.agents.get_mut(agent_id).map(|run| {
                            run.ctx.mode = old;
                            run.ctx.strict_jail = old != PermissionMode::Bypass;
                            run.meta.permission = old;
                            run.meta.clone()
                        })
                    };
                    if let (Some(lease), Some(have)) = (lease.as_deref(), had_writer) {
                        let _ = inner.gate.set_writer(lease, have, repo_id.as_deref());
                    }
                    if let Some(m) = meta {
                        inner.persist_meta(&m);
                    }
                    // best effort: the sidecar's own view matches Rust again
                    let _ = sc.request("session/permission", json!({"agentId": agent_id, "mode": old}), Duration::from_secs(5));
                    outcome = Err(err("modeNotApplied", format!("The agent did not take the {} mode, so the run stays in {} ({detail})", mode_name(new), mode_name(old))));
                }
            }
        }
        if tightening {
            // a card that waited under the looser rules may be a denial now (spec 5.1 step 8)
            inner.rejudge_pending(agent_id);
        }
        outcome?;
        inner.summary_of(agent_id).ok_or_else(|| unknown_agent(agent_id))
    }

    /// The Settings changed the MCP policy of servers that live runs use: applies the tighter rules to those runs, withdraws the cards that
    /// became denials and moves the sidecar's decision epoch (MCP spec 5.2 items 7 and 8). Tighten only: a Deny applies at once, anything
    /// looser only from the next start. Returns how many runs got tighter rules.
    pub fn tighten_mcp(&self) -> usize {
        let inner = &self.inner;
        let Some(rules) = inner.cfg.mcp_rules.clone() else { return 0 };
        let mut pairs: Vec<(String, String)> = Vec::new();
        {
            let st = lock(&inner.state);
            for run in st.agents.values().filter(|r| r.live.is_some()) {
                for (name, id) in &run.mcp_ids {
                    if !pairs.iter().any(|(i, _)| i == id) {
                        pairs.push((id.clone(), name.clone()));
                    }
                }
            }
        }
        if pairs.is_empty() {
            return 0;
        }
        let updates = rules(&pairs);
        let mut changed: Vec<String> = Vec::new();
        {
            let mut st = lock(&inner.state);
            for (agent_id, run) in st.agents.iter_mut().filter(|(_, r)| r.live.is_some() && !r.mcp_ids.is_empty()) {
                let mut touched = false;
                for (name, id) in run.mcp_ids.clone() {
                    let Some(update) = updates.iter().find(|u| u.id == id) else { continue };
                    let before = run.ctx.mcp_tools.get(&name).cloned();
                    match &update.rules {
                        Some(newer) => run.ctx.mcp_tools.entry(name.clone()).or_default().tighten(newer),
                        // removed from the Settings: its process lives until the run ends, but no call to it is allowed any more
                        None => {
                            run.ctx.mcp_tools.insert(name.clone(), McpServerRules { default_policy: McpPolicy::Deny, tools: Default::default(), fresh: false });
                        }
                    }
                    touched |= before.as_ref().map_or(true, |b| rules_tightened(b, &run.ctx.mcp_tools[&name]));
                }
                if touched {
                    run.rules_epoch += 1;
                    changed.push(agent_id.clone());
                }
            }
        }
        for agent_id in &changed {
            inner.rejudge_pending(agent_id);
            // an idempotent setPermissionMode with the unchanged mode: the sidecar drops its cached decisions (mode epoch, spec 6.4)
            let target = {
                let st = lock(&inner.state);
                inner.live_sidecar(&st, agent_id).ok().zip(st.agents.get(agent_id).map(|r| r.meta.permission))
            };
            if let Some((sc, mode)) = target {
                let _ = sc.request("session/permission", json!({"agentId": agent_id, "mode": mode}), Duration::from_secs(5));
            }
        }
        changed.len()
    }

    /// [`AgentHost::answer_permission`] plus the ExitPlanMode mode and feedback (permission-modes spec 4.10, 5.3, 5.4).
    pub fn answer_permission_with(&self, agent_id: &str, req_id: &str, decision: PermissionDecision, extra: AnswerExtra) -> Result<(), EngineError> {
        let inner = &self.inner;
        let feedback = extra.feedback.as_deref().map(str::trim).filter(|f| !f.is_empty()).map(|f| f.chars().take(MAX_FEEDBACK_CHARS).collect::<String>());
        let allowing = matches!(decision, PermissionDecision::AllowOnce | PermissionDecision::AllowRun);
        // a run on a server is judged against the server's files over the network: that happens here, never under the lock below
        let prejudged = inner.prejudge_remote(agent_id, req_id, allowing, decision == PermissionDecision::AllowRun);
        let step = {
            let mut st = lock(&inner.state);
            let sc = inner.live_sidecar(&st, agent_id)?;
            let run = st.agents.get_mut(agent_id).ok_or_else(|| unknown_agent(agent_id))?;
            let pending = run.state.perms.get(req_id).ok_or_else(|| err("unknownRequest", format!("no pending permission request {req_id}")))?;
            let wanted = match decision {
                PermissionDecision::AllowOnce => PermissionOption::AllowOnce,
                PermissionDecision::AllowRun => PermissionOption::AllowRun,
                PermissionDecision::Deny => PermissionOption::Deny,
                PermissionDecision::AllowAlways => return Err(err("optionNotOffered", "saved rules per role and repository are not available yet")),
            };
            if !pending.options.contains(&wanted) {
                return Err(err("optionNotOffered", "that answer is not offered for this request"));
            }
            if pending.answering {
                return Err(err("alreadyAnswered", "this request was already answered"));
            }
            let intent = pending.intent.clone();
            let is_plan = intent.tool.as_deref() == Some("ExitPlanMode") && intent.actor.is_none();
            if extra.mode.is_some() && !(is_plan && decision == PermissionDecision::AllowOnce) {
                return Err(err("invalidAnswer", "a mode is only accepted when approving a plan"));
            }
            if extra.feedback.is_some() && decision != PermissionDecision::Deny {
                return Err(err("invalidAnswer", "feedback goes with a rejection"));
            }
            // The click is judged again with the CURRENT rules: one that raced a tightening (a switch to Plan, an MCP policy that went to
            // Deny) must not become an allow. A fresh Allow (the user loosened the mode meanwhile) or Ask stands (spec 5.3).
            let on_server = run.meta.location.is_some();
            let prejudged = prejudged.as_ref().filter(|p| p.epoch == run.rules_epoch);
            if allowing && on_server && prejudged.is_none() {
                return Err(err("rulesMoved", RULES_MOVED_MESSAGE));
            }
            let fresh = match (allowing, prejudged) {
                (false, _) => None,
                (true, Some(p)) => p.fresh.clone(),
                (true, None) => Some(rejudge(&run.ctx, agent_id, req_id, &run.meta.provider, &intent)),
            };
            // a card asked under the rules that still hold was judged by them already (a scripted card of the mock provider may even carry an
            // intent the broker would deny); one whose rules moved since is refused when it became a denial
            let moved = run.card_epoch.get(req_id) != Some(&run.rules_epoch);
            if moved && fresh.as_ref().is_some_and(|f| f.decision == Decision::Deny) {
                if let Some(p) = run.state.perms.get_mut(req_id) {
                    p.answering = true;
                }
                Step::Withdraw(sc)
            } else {
                let mut undo = Undo::default();
                let lease = run.live.as_ref().and_then(|l| l.lease_id.clone());
                let repo_id = run.meta.repos.first().map(|r| r.id.clone());
                let mut body_mode = None;
                if decision == PermissionDecision::AllowRun {
                    // the host derives the saved allow itself and never trusts the event's offer
                    match prejudged.map_or_else(|| session_allow_for(&run.ctx, &intent), |p| p.session.clone()) {
                        Some((saved, _offer)) => {
                            if matches!(saved, SavedAllow::WriteInside) && !run.writer_needed() {
                                if let Some(lease) = lease.as_deref() {
                                    inner.gate.set_writer(lease, true, repo_id.as_deref()).map_err(|e| admission_error(&e))?;
                                    undo.lease = Some(false);
                                }
                            }
                            let role = intent.actor.as_ref().map(|a| a.role.clone());
                            let list = match &role {
                                Some(r) => run.ctx.saved_by_role.entry(r.clone()).or_default(),
                                None => &mut run.ctx.saved,
                            };
                            if !list.contains(&saved) && list.len() < MAX_SAVED_ALLOWS {
                                list.push(saved.clone());
                                undo.saved = Some((role, saved));
                            }
                        }
                        // the rules already allow it (another card of the same kind was answered "always" first, or the user loosened the
                        // mode meanwhile): the click is an allow and there is nothing left to remember
                        None if fresh.as_ref().is_some_and(|f| f.decision == Decision::Allow) => {}
                        None => return Err(err("optionNotOffered", "no session allow can be derived for this request")),
                    }
                } else if is_plan && decision == PermissionDecision::AllowOnce {
                    // an ExitPlanMode approval: the run continues in the chosen working mode, set in the same critical section that marks the card answered
                    if run.mode_busy {
                        return Err(err("modeBusy", "a mode change of this run is already in progress"));
                    }
                    let current = run.meta.permission;
                    let target = if current == PermissionMode::ReadOnly { extra.mode.unwrap_or(PermissionMode::Ask) } else { current };
                    if !PermissionMode::AFTER_PLAN.contains(&target) {
                        return Err(err("invalidMode", "Bypass is never offered when leaving plan mode; pick ask, edit or automatic"));
                    }
                    if target != current {
                        inner.check_mode(&run.meta.provider, target, false, true)?;
                        let have = lease.as_deref().and_then(|l| inner.gate.leases().into_iter().find(|i| i.lease_id == l)).map(|i| i.writer);
                        if let (Some(lease), Some(have)) = (lease.as_deref(), have) {
                            let want = run.writer_needed_in(target);
                            if want != have {
                                inner.gate.set_writer(lease, want, repo_id.as_deref()).map_err(|e| admission_error(&e))?;
                                undo.lease = Some(have);
                            }
                        }
                        run.ctx.mode = target;
                        run.ctx.strict_jail = target != PermissionMode::Bypass;
                        run.meta.permission = target;
                        run.rules_epoch += 1;
                        undo.mode = Some(current);
                        run.mode_busy = true;
                    }
                    body_mode = Some(target);
                }
                if let Some(p) = run.state.perms.get_mut(req_id) {
                    p.answering = true;
                }
                let meta = undo.mode.map(|_| run.meta.clone());
                Step::Send { sc, allow: allowing, mode: body_mode, undo, lease, repo_id, meta }
            }
        };
        match step {
            Step::Withdraw(sc) => {
                if inner.withdraw(&sc, agent_id, req_id) {
                    return Err(err("modeChanged", "The rules changed while this was waiting (mode or MCP policy); the request was refused. Ask again if it still applies"));
                }
                if let Some(p) = lock(&inner.state).agents.get_mut(agent_id).and_then(|r| r.state.perms.get_mut(req_id)) {
                    p.answering = false;
                }
                Err(err("sidecarUnavailable", "the agent process did not take the answer"))
            }
            Step::Send { sc, allow, mode, undo, lease, repo_id, meta } => {
                if let Some(m) = &meta {
                    inner.persist_meta(m);
                }
                let mut body = json!({"agentId": agent_id, "reqId": req_id, "outcome": if allow { "allow" } else { "deny" }});
                if let Some(m) = mode {
                    body["mode"] = json!(m);
                }
                if !allow {
                    if let Some(f) = &feedback {
                        body["message"] = json!(f);
                    }
                }
                let sent = sc.request("permission/answer", body, Duration::from_secs(5)).is_ok();
                let restored = {
                    let mut st = lock(&inner.state);
                    st.agents.get_mut(agent_id).map(|run| {
                        if !sent {
                            // the sidecar never saw the answer: the card is answerable again and nothing the answer would have changed stays changed
                            if let Some(p) = run.state.perms.get_mut(req_id) {
                                p.answering = false;
                            }
                            if let Some((role, saved)) = &undo.saved {
                                let list = match role {
                                    Some(r) => run.ctx.saved_by_role.get_mut(r),
                                    None => Some(&mut run.ctx.saved),
                                };
                                if let Some(list) = list {
                                    list.retain(|a| a != saved);
                                }
                            }
                            if let Some(old) = undo.mode {
                                run.ctx.mode = old;
                                run.ctx.strict_jail = old != PermissionMode::Bypass;
                                run.meta.permission = old;
                            }
                            if let (Some(have), Some(lease)) = (undo.lease, lease.as_deref()) {
                                let _ = inner.gate.set_writer(lease, have, repo_id.as_deref());
                            }
                        }
                        if undo.mode.is_some() {
                            run.mode_busy = false;
                        }
                        run.meta.clone()
                    })
                };
                if !sent {
                    if let (Some(m), true) = (restored, undo.mode.is_some()) {
                        inner.persist_meta(&m);
                    }
                    return Err(err("sidecarUnavailable", "the agent process did not take the answer"));
                }
                Ok(())
            }
        }
    }

    /// Exactly-once: the request must be pending and the answer one of its offered options.
    pub fn answer_permission(&self, agent_id: &str, req_id: &str, decision: PermissionDecision) -> Result<(), EngineError> {
        self.answer_permission_with(agent_id, req_id, decision, AnswerExtra::default())
    }

    pub fn answer_question(&self, agent_id: &str, req_id: &str, answer: QuestionAnswer) -> Result<(), EngineError> {
        let inner = &self.inner;
        let (sc, prompt, chosen) = {
            let mut st = lock(&inner.state);
            let sc = inner.live_sidecar(&st, agent_id)?;
            let run = st.agents.get_mut(agent_id).ok_or_else(|| unknown_agent(agent_id))?;
            let q = run.state.questions.get_mut(req_id).ok_or_else(|| err("unknownRequest", format!("no pending question {req_id}")))?;
            if q.answering {
                return Err(err("alreadyAnswered", "this question was already answered"));
            }
            let free = answer.text.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string);
            let chosen = match free {
                Some(t) => t,
                None => {
                    if answer.option_ids.is_empty() || answer.option_ids.iter().any(|o| !q.labels.contains(o)) {
                        return Err(err("invalidAnswer", "pick one of the offered options"));
                    }
                    answer.option_ids.join(", ")
                }
            };
            q.answering = true;
            (sc, q.prompt.clone(), chosen)
        };
        let body = json!({"agentId": agent_id, "reqId": req_id, "outcome": "allow", "answers": {prompt: chosen}});
        if sc.request("permission/answer", body, Duration::from_secs(5)).is_err() {
            if let Some(q) = lock(&inner.state).agents.get_mut(agent_id).and_then(|r| r.state.questions.get_mut(req_id)) {
                q.answering = false;
            }
            return Err(err("sidecarUnavailable", "the agent process did not take the answer"));
        }
        if let Some(run) = lock(&inner.state).agents.get_mut(agent_id) {
            run.state.questions.remove(req_id);
        }
        Ok(())
    }

    /// Every known run, newest first (live runs and the ones still in the log).
    pub fn list(&self) -> Vec<AgentSummary> {
        let inner = &self.inner;
        let mut st = lock(&inner.state);
        inner.load_history(&mut st);
        let mut out: Vec<AgentSummary> = st.agents.values().filter(|r| !r.quiet).map(|r| r.summary(inner.tier_of(r))).collect();
        out.sort_by(|a, b| b.started_at.cmp(&a.started_at).then_with(|| a.agent_id.cmp(&b.agent_id)));
        out
    }

    pub fn history(&self, agent_id: &str, after_seq: Option<u64>) -> Result<Vec<AgentEvent>, EngineError> {
        let events = self.inner.log.read(agent_id).map_err(|e| err("history", e.to_string()))?;
        let after = after_seq.unwrap_or(0);
        Ok(events.into_iter().filter(|e| e.seq > after).collect())
    }

    /// Restores the working trees of the run's repos to the snapshot taken before it started.
    pub fn rewind(&self, agent_id: &str) -> Result<(), EngineError> {
        let inner = &self.inner;
        let snapshots = {
            let mut st = lock(&inner.state);
            inner.load_history(&mut st);
            let run = st.agents.get(agent_id).ok_or_else(|| unknown_agent(agent_id))?;
            if run.state.turn_open {
                return Err(err("agentRunning", "stop the agent before rewinding"));
            }
            run.meta.snapshots.clone()
        };
        if snapshots.is_empty() {
            return Err(err("noSnapshot", "no Rewind snapshot was taken for this run"));
        }
        for s in &snapshots {
            Jail::global().check_op("agent rewind", &s.path)?;
        }
        let mut failures = Vec::new();
        for s in &snapshots {
            if let Err(e) = inner.rewind.restore(&s.path, agent_id, true) {
                failures.push(format!("{}: {e}", s.repo_id));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(err("rewind", failures.join("; ")))
        }
    }

    /// Stops the sidecar and with it every agent process. Blocks for a few seconds at most.
    pub fn shutdown(&self) {
        let inner = &self.inner;
        let (sc, remote): (Option<Arc<Sidecar>>, Vec<Arc<Sidecar>>) = {
            let mut st = lock(&inner.state);
            st.shutting_down = true;
            (st.sidecar.clone(), lock(&inner.remote).values().map(|r| r.sc.clone()).collect())
        };
        // the sidecars on servers stop in parallel (each ends with its ssh pipe); this Mac's one first
        let stoppers: Vec<_> = remote
            .into_iter()
            .map(|sc| {
                let me = self.inner.clone();
                std::thread::spawn(move || me.stop_sidecar(&sc))
            })
            .collect();
        if let Some(sc) = sc {
            inner.stop_sidecar(&sc);
        }
        for t in stoppers {
            let _ = t.join();
        }
        inner.gate.join_kills();
        *lock(&inner.reaper) = None;
    }

    /// The Auto lead's defaults as the settings say right now.
    pub fn agent_defaults(&self) -> crate::config::AgentDefaults {
        self.inner.cfg.defaults()
    }

    /// The policy context the host holds for a run right now: what every `policy/decide` of it is judged with (a copy; diagnostics and tests).
    pub fn context(&self, agent_id: &str) -> Option<PolicyContext> {
        lock(&self.inner.state).agents.get(agent_id).map(|r| r.ctx.clone())
    }

    /// The mode a run is in right now in Rust (`Meta.permission`, which follows every switch). `None` = unknown run.
    pub fn mode_of(&self, agent_id: &str) -> Option<PermissionMode> {
        lock(&self.inner.state).agents.get(agent_id).map(|r| r.meta.permission)
    }

    /// The mode the phone's verdicts treat a run as having (permission-modes spec 5.7): the LOOSER of the live effective mode and the
    /// recorded `Meta.permission`; a run with no live session counts as the mode it was recorded in (a recorded Bypass stays Bypass although
    /// a resume would start in Automatic). `None` = unknown run.
    pub fn run_mode(&self, agent_id: &str) -> Option<PermissionMode> {
        let st = lock(&self.inner.state);
        let run = st.agents.get(agent_id)?;
        let recorded = run.meta.permission;
        let live = run.live.as_ref().and_then(|_| run.state.effective.as_ref()).map(|e| e.permission);
        Some(live.filter(|l| l.strictness() > recorded.strictness()).unwrap_or(recorded))
    }

    /// Kill switch `INTELY_NO_UNATTENDED=1`: Automatic and Bypass are refused until the host restarts (permission-modes spec 5.10).
    pub fn unattended_disabled(&self) -> bool {
        self.inner.cfg.no_unattended
    }

    /// The canary fired in this process: delegation is off until the host restarts (`AutoInfo.delegation_off = canaryTripped`).
    pub fn delegation_tripped(&self) -> bool {
        self.inner.delegation_tripped.load(Ordering::SeqCst)
    }

    /// What an Auto run on `repos` would do right now: the lead, the delegates and the exclusions (from the same resolver the start
    /// uses), the budget and the worst case of turns. `available`/`reason` only reflect the Auto kill switch here; the caller adds
    /// what it knows about Claude itself (disabled, not installed, not logged in). `queued_behind` is the caller's too.
    pub fn auto_info(&self, repos: &[RepoRef], queued_behind: Option<AutoQueue>) -> AutoInfo {
        let inner = &self.inner;
        let defaults = inner.cfg.defaults();
        let lead = roles::auto_role(&inner.cfg);
        let resolved = lead.resolved(&inner.cfg);
        let plan = inner.plan_delegation(&lead, repos).unwrap_or_default();
        AutoInfo {
            available: defaults.auto_enabled,
            reason: (!defaults.auto_enabled).then(|| "autoDisabled".to_string()),
            model: resolved.model,
            effort: resolved.effort,
            permission: lead.permission,
            delegates: if plan.off.is_none() { plan.set.infos() } else { Vec::new() },
            excluded: plan.set.excluded.clone(),
            delegation_off: plan.off.map(str::to_string).or_else(|| (plan.set.is_empty() && inner.cfg.delegate_resolver.is_some()).then(|| "noRoles".to_string())),
            queued_behind,
            max_budget_usd: resolved.max_budget_usd,
            delegation_cap: defaults.delegation_cap,
            worst_case_turns: roles::LEAD_MAX_TURNS + defaults.delegation_cap * roles::DELEGATE_MAX_TURNS,
        }
    }

    /// A role by name as the host would start it: the Roles layer first, then the built-in table.
    pub fn find_role(&self, name: &str, repos: &[RepoRef]) -> Option<RoleDef> {
        self.inner.role_named(name, repos)
    }

    /// Persisted metadata of every run the host knows (cwd, repos, provider session id, snapshots).
    pub fn metas(&self) -> Vec<Meta> {
        let inner = &self.inner;
        let mut st = lock(&inner.state);
        inner.load_history(&mut st);
        st.agents.values().filter(|r| !r.quiet).map(|r| r.meta.clone()).collect()
    }

    /// One request to the sidecar (session history), starting it if needed. Stateless on the sidecar side.
    pub fn sidecar_request(&self, kind: &str, body: Value, timeout: Duration) -> Result<Value, EngineError> {
        let sc = self.inner.ensure_sidecar(None)?;
        sc.request(kind, body, timeout).map_err(|e| err("sidecarUnavailable", e.to_string()))
    }

    /// Leases the gate holds now (diagnostics and the RSS measurement).
    pub fn leases(&self) -> Vec<intely_agent_gate::gate::LeaseInfo> {
        self.inner.gate.leases()
    }

    /// Pid of the running sidecar, if any.
    pub fn sidecar_pid(&self) -> Option<u32> {
        lock(&self.inner.state).sidecar.as_ref().filter(|s| s.alive()).map(|s| s.pid)
    }

    /// Eco mode: closes the session of every run that is not working and has been idle for `min_idle_ms`, freeing its
    /// slot and memory. The run resumes by itself on its next message. Returns how many sessions were closed.
    pub fn suspend_idle(&self, min_idle_ms: u64) -> usize {
        let idle: Vec<_> = self.inner.gate.leases().into_iter().filter(|l| !l.busy && l.idle_ms >= min_idle_ms).collect();
        idle.into_iter().filter(|l| self.inner.gate.reclaim(&l.lease_id, ReclaimReason::Idle).is_some()).count()
    }
}

/// A provider other than Claude that is not switched on, installed and confirmed (Settings > Providers).
fn not_enabled(provider: &str) -> EngineError {
    err("providerNotEnabled", format!("{provider} is not available: switch on Experimental providers, enable {provider} and confirm its command line in Settings > Providers"))
}

fn unknown_agent(id: &str) -> EngineError {
    err("unknownAgent", format!("no run {id}"))
}

impl Inner {
    /// Checks a requested mode before anything changes (permission-modes spec 5.1 step 3, 5.2): the provider supports it (`live`: a
    /// switch of a run, otherwise a new run), the kill switch is off, and Bypass was confirmed.
    fn check_mode(&self, provider: &str, mode: PermissionMode, bypass_confirmed: bool, live: bool) -> Result<(), EngineError> {
        let allowed = if live { switchable_modes(provider) } else { supported_modes(provider) };
        if !allowed.contains(&mode) {
            return Err(err("modeNotSupported", format!("{provider} cannot {} in {} mode", if live { "switch to" } else { "start" }, mode_name(mode))));
        }
        if mode.is_unattended() && self.cfg.no_unattended {
            return Err(err("modeDisabled", format!("{} mode is switched off on this installation", mode_name(mode))));
        }
        if mode == PermissionMode::Bypass && !bypass_confirmed {
            return Err(err("bypassNotConfirmed", "Bypass needs an explicit confirmation"));
        }
        Ok(())
    }

    /// Answers a card with the deny of a changed rule set; `true` = the sidecar took it.
    fn withdraw(&self, sc: &Arc<Sidecar>, agent_id: &str, req_id: &str) -> bool {
        sc.request("permission/answer", json!({"agentId": agent_id, "reqId": req_id, "outcome": "deny", "message": RULES_CHANGED_MESSAGE}), Duration::from_secs(5)).is_ok()
    }

    /// For a run on a server: the verdicts an answer needs, made without holding `state` (see [`Prejudged`]). `None` for a run on this
    /// Mac, which is judged inside the critical section as always.
    fn prejudge_remote(&self, agent_id: &str, req_id: &str, fresh: bool, session: bool) -> Option<Prejudged> {
        let (ctx, provider, intent, epoch) = {
            let st = lock(&self.state);
            let run = st.agents.get(agent_id).filter(|r| r.meta.location.is_some())?;
            let pending = run.state.perms.get(req_id)?;
            (run.ctx.clone(), run.meta.provider.clone(), pending.intent.clone(), run.rules_epoch)
        };
        Some(Prejudged {
            epoch,
            fresh: fresh.then(|| rejudge(&ctx, agent_id, req_id, &provider, &intent)),
            session: if session { session_allow_for(&ctx, &intent) } else { None },
        })
    }

    /// After a tightening: every pending card the CURRENT rules now deny (a role denial or a hard stop) is answered with a deny, so a card
    /// opened under the looser rules cannot be clicked into an allow (permission-modes spec 5.1 step 8). A card whose fresh verdict is still
    /// Ask stays; one that would now be an Allow is left to its owner. A send failure leaves the card pending (the click path re-decides).
    fn rejudge_pending(&self, agent_id: &str) {
        // The cards are copied out and judged without `state`: for a run on a server the look at its files is a trip over the network.
        let (sc, ctx, provider, cards) = {
            let st = lock(&self.state);
            let Ok(sc) = self.live_sidecar(&st, agent_id) else { return };
            let Some(run) = st.agents.get(agent_id) else { return };
            let cards: Vec<(String, ToolIntent)> = run.state.perms.iter().filter(|(_, p)| !p.answering).map(|(id, p)| (id.clone(), p.intent.clone())).collect();
            (sc, run.ctx.clone(), run.meta.provider.clone(), cards)
        };
        let denied: Vec<String> = cards.into_iter().filter(|(req_id, intent)| rejudge(&ctx, agent_id, req_id, &provider, intent).decision == Decision::Deny).map(|(req_id, _)| req_id).collect();
        // a card that was answered meanwhile is left alone
        let ids: Vec<String> = {
            let mut st = lock(&self.state);
            let Some(run) = st.agents.get_mut(agent_id) else { return };
            denied
                .into_iter()
                .filter(|req_id| match run.state.perms.get_mut(req_id) {
                    Some(p) if !p.answering => {
                        p.answering = true;
                        true
                    }
                    _ => false,
                })
                .collect()
        };
        for req_id in ids {
            if !self.withdraw(&sc, agent_id, &req_id) {
                if let Some(p) = lock(&self.state).agents.get_mut(agent_id).and_then(|r| r.state.perms.get_mut(&req_id)) {
                    p.answering = false;
                }
            }
        }
    }

    /// Makes sure the run has a live session, resuming it if needed. Returns whether a turn is open.
    fn ensure_live(&self, agent_id: &str) -> Result<bool, EngineError> {
        let (role_name, native, live, turn_open, repos, provider, meta) = {
            let mut st = lock(&self.state);
            self.load_history(&mut st);
            let run = st.agents.get(agent_id).ok_or_else(|| unknown_agent(agent_id))?;
            let live = run.live.as_ref().and_then(|l| self.sidecar_gen(&st, l.generation)).is_some_and(|sc| sc.alive());
            (run.meta.role.clone(), run.state.native_id.clone().or_else(|| run.meta.native_id.clone()), live, run.state.turn_open, run.meta.repos.clone(), run.meta.provider.clone(), run.meta.clone())
        };
        if turn_open || live {
            return Ok(turn_open);
        }
        let mut role = self.role_named(&role_name, &repos).ok_or_else(|| err("unknownRole", format!("no role named {role_name}")))?;
        if role.provider != provider {
            // the run was started on another provider than its role's own (the New run picker); it stays there
            role = role.on_provider(&provider);
        }
        // The mode the run recorded decides, except that Bypass never resumes and a role that changed under the run narrows it
        // (permission-modes spec 5.5). The delegates of a team lead are rebuilt from the files.
        let (resumed, reason) = self.resume_mode_for(&role, &meta);
        role.permission = resumed;
        let native = native.ok_or_else(|| err("cannotResume", "this run has no session to resume"))?;
        // a run on a server that is brought back takes a place there like a new one
        if let (Some(loc), Some(registry)) = (meta.location.as_deref(), self.cfg.servers.as_ref()) {
            let scfg = registry.cfg(loc).ok_or_else(|| err("serverNotReady", NotReady::Unknown.message()))?;
            self.check_server_slot(loc, &scfg.name, scfg.max_agents, Some(agent_id))?;
        }
        if resumed != meta.permission {
            let changed = {
                let mut st = lock(&self.state);
                let changed = st.agents.get_mut(agent_id).map(|run| {
                    run.ctx.mode = resumed;
                    run.ctx.strict_jail = resumed != PermissionMode::Bypass;
                    run.meta.permission = resumed;
                    run.meta.clone()
                });
                // before open_session reads the last seq, so the event precedes the new session's first one
                self.synthesize(&mut st, agent_id, vec![mode_info(resumed, reason.unwrap_or(ModeChangeReason::ResumeDowngrade))]);
                changed
            };
            if let Some(m) = changed {
                self.persist_meta(&m);
            }
        }
        self.open_session(&role, agent_id, Some(native))?;
        Ok(false)
    }

    /// The mode a stopped run resumes in, and why it differs from the recorded one (permission-modes spec 5.5).
    fn resume_mode_for(&self, role: &RoleDef, meta: &Meta) -> (PermissionMode, Option<ModeChangeReason>) {
        let recorded = meta.permission;
        let mut resumed = recorded.resume_mode();
        let mut reason = (resumed != recorded).then_some(ModeChangeReason::ResumeDowngrade);
        let role_mode = role.permission;
        let narrow = match meta.role_permission {
            // a run recorded before the modes spec: only readOnly, edit and ask existed and the clamp was the stricter of the two
            None => true,
            Some(at_start) => {
                role.file.as_ref().is_some_and(|f| f.untrusted || f.ceiling || meta.role_hash.as_deref() != Some(f.content_hash.as_str()))
                    // demoted since the start (an overlay change does not change the file hash), whatever the role is
                    || role_mode.strictness() < at_start.strictness()
            }
        };
        if narrow {
            let n = stricter(resumed, role_mode);
            if n != resumed {
                resumed = n;
                reason = Some(ModeChangeReason::RoleChanged);
            }
        }
        if resumed.is_unattended() && self.cfg.no_unattended {
            resumed = PermissionMode::Ask;
            reason = Some(ModeChangeReason::Provider);
        }
        (resumed, reason)
    }

    /// A role by name: the Roles layer first (files and overlay), then the built-in table.
    fn role_named(&self, name: &str, repos: &[RepoRef]) -> Option<RoleDef> {
        // `auto` is reserved: never a file, always the lead as the settings configure it right now
        if name == roles::AUTO_ROLE {
            return Some(roles::auto_role(&self.cfg));
        }
        self.cfg.role_resolver.as_ref().and_then(|f| f(name, repos)).or_else(|| roles::builtin(&self.cfg).into_iter().find(|r| r.name == name))
    }

    /// A role of the built-in table, or the Auto lead.
    fn builtin_named(&self, name: &str) -> Option<RoleDef> {
        if name == roles::AUTO_ROLE {
            return Some(roles::auto_role(&self.cfg));
        }
        roles::builtin(&self.cfg).into_iter().find(|r| r.name == name)
    }

    /// The delegates a session of a delegating role opens with, from the CURRENT role files (`None` = not a delegating role).
    /// A kill switch (Settings), the canary or a CLI older than [`roles::MIN_CLI_FOR_DELEGATION`] leaves the lead alone.
    fn plan_delegation(&self, role: &RoleDef, repos: &[RepoRef]) -> Option<roles::Delegation> {
        if !role.is_delegating() {
            return None;
        }
        let defaults = self.cfg.defaults();
        let claude = role.provider == "claude";
        let off = if !defaults.delegation_enabled {
            Some("delegationDisabled")
        } else if self.delegation_tripped.load(Ordering::SeqCst) {
            Some("canaryTripped")
        } else if claude && self.cfg.cli_version.as_ref().and_then(|f| f("claude")).is_some_and(|v| !roles::version_at_least(&v, roles::MIN_CLI_FOR_DELEGATION)) {
            Some("cliTooOld")
        } else {
            None
        };
        let mut set = intely_agent_core::delegates::DelegateSet::default();
        if off.is_none() {
            if let Some(resolver) = &self.cfg.delegate_resolver {
                let run: Vec<DelegateRepo> = repos.iter().map(|r| DelegateRepo { id: r.id.clone(), path: r.path.clone() }).collect();
                set = resolver(&run);
                if let Some(m) = self.cfg.model_override.as_ref().filter(|_| claude) {
                    // cheap smoke runs: the override replaces every model, and its effort control is unknown
                    for d in &mut set.included {
                        d.spec.model = m.clone();
                        d.spec.effort = None;
                    }
                }
            }
        }
        Some(roles::Delegation { set, off })
    }

    fn runs_dir(&self) -> PathBuf {
        self.cfg.data_dir.join("runs")
    }

    fn new_agent_id(&self) -> String {
        let mut st = lock(&self.state);
        st.counter += 1;
        format!("a-{}-{}", now_ms(), st.counter)
    }

    fn persist_meta(&self, meta: &Meta) {
        let dir = self.runs_dir();
        let path = meta_path(&dir, &meta.agent_id);
        let write = || -> std::io::Result<()> {
            intely_agent_core::events::log::create_private_dir_all(&dir)?;
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_vec_pretty(meta).map_err(std::io::Error::other)?)?;
            std::fs::set_permissions(&tmp, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
            std::fs::rename(&tmp, &path)
        };
        if let Err(e) = write() {
            eprintln!("agent host: cannot write {}: {e}", path.display());
        }
    }

    /// The book as the harness last wrote it; a changed `enforcement.json` is picked up without a restart.
    fn book(&self) -> EnforcementBook {
        let mut cached = lock(&self.book);
        let mtime = file_mtime(&self.book_path);
        if mtime != cached.0 {
            *cached = (mtime, EnforcementBook::load(&self.book_path).unwrap_or_default());
        }
        cached.1.clone()
    }

    /// The one place an enforcement chip is computed (Settings, Roles, New run and every run's header read it).
    /// Evidence is looked up by (adapter, auth mode, role kind), not by CLI version, so a recorded run is found; it
    /// counts only while the installed CLI is the version it was recorded for (a different one reads as Weak with the
    /// stale run attached). `auth = None` takes the weakest recorded mode. `write` covers every mode that can change files.
    fn chip_for(&self, provider: &str, read_only: bool, auth: Option<AuthMode>) -> EnforcementChip {
        let adapter = if provider == "claude" { "claude-sdk" } else { provider };
        let book = self.book();
        let installed = self.cfg.cli_version.as_ref().and_then(|f| f(provider));
        let mut weakest: Option<EnforcementChip> = None;
        for run in book.runs.iter().filter(|r| r.key.adapter == adapter && (r.key.role_mode == PermissionMode::ReadOnly) == read_only && auth.map_or(true, |a| r.key.auth_mode == a)) {
            let mut chip = book.chip(&run.key);
            if installed.as_deref().is_some_and(|v| !run.key.cli_version.is_empty() && run.key.cli_version != v) {
                chip.tier = Tier::Weak;
            }
            if weakest.as_ref().map_or(true, |w| chip.tier < w.tier) {
                weakest = Some(chip);
            }
        }
        weakest.unwrap_or(EnforcementChip { tier: Tier::Weak, run: None })
    }

    /// The tier a role of this mode earns on its provider, computed from recorded suites only (unknown = weak).
    fn tier_for_role(&self, role: &RoleDef) -> Tier {
        self.chip_for(&role.provider, role.permission == PermissionMode::ReadOnly, Some(AuthMode::Subscription)).tier
    }

    /// A confirmed experimental provider by id.
    fn launch_of(&self, provider: &str) -> Option<ProviderLaunch> {
        self.cfg.launches().into_iter().find(|l| l.id == provider)
    }

    /// A role that can change files or run commands runs on a provider other than Claude only when that provider and
    /// mode have passed the attempt suites to the write tier (`strong`), or the user turned on "allow weak writer" for
    /// that provider (Settings > Safety, typed confirmation; Rewind and the hard stops still apply). The scripted e2e
    /// roles are the other exception. The New run dialog greys these choices out; this is the refusal that does not
    /// depend on the UI.
    fn check_provider_gate(&self, role: &RoleDef) -> Result<(), EngineError> {
        if matches!(role.provider.as_str(), "claude" | "mock") || role.permission == PermissionMode::ReadOnly || self.weak_writer_ok(role) {
            return Ok(());
        }
        let tier = self.tier_for_role(role);
        if tier >= Tier::Strong {
            return Ok(());
        }
        Err(err("providerReadOnly", format!("{} has not passed the write-role attempt suites (tier {tier:?}); only read-only roles run on it. Pick a read-only role or Claude", role.provider)))
    }

    /// Scripted fake-agent roles of the e2e harness, and a provider the user explicitly allowed to write below the write tier.
    fn weak_writer_ok(&self, role: &RoleDef) -> bool {
        let scripted = self.cfg.acp_mock.as_ref().is_some_and(|m| m.provider == role.provider) && role.mock_scenario.is_some();
        scripted || self.launch_of(&role.provider).is_some_and(|l| l.allow_weak_writer)
    }

    /// `session/start.acp` of a non-Claude provider. With `acp_mock` the command is the scripted fake agent of the role's
    /// scenario. Otherwise it is the command line the user confirmed; a provider without one does not start.
    /// `write_allowed` is set only for a role that changes files (the gate above already decided it may).
    fn acp_launch(&self, role: &RoleDef, node: Option<&Path>) -> Result<AcpLaunch, EngineError> {
        let write_allowed = role.permission != PermissionMode::ReadOnly;
        let mut launch = AcpLaunch { command: None, args: None, env: None, write_allowed: write_allowed.then_some(true), init_timeout_ms: None, term_ms: None };
        if let Some(m) = self.cfg.acp_mock.as_ref().filter(|m| m.provider == role.provider) {
            let scenario = role.mock_scenario.as_deref().unwrap_or("plain-reply");
            let script = m.scripts_dir.join(format!("{scenario}.jsonl"));
            let node = node.ok_or_else(|| err("nodeNotFound", "Node.js was not found on the login PATH"))?;
            if !m.agent_js.is_file() || !script.is_file() {
                return Err(err("acpMockMissing", format!("the fake ACP agent or its script is missing: {} / {}", m.agent_js.display(), script.display())));
            }
            launch.command = Some(node.to_string_lossy().into_owned());
            launch.args = Some(vec![m.agent_js.to_string_lossy().into_owned(), script.to_string_lossy().into_owned()]);
            return Ok(launch);
        }
        let l = self.launch_of(&role.provider).ok_or_else(|| not_enabled(&role.provider))?;
        launch.command = Some(l.command);
        launch.args = Some(l.args);
        Ok(launch)
    }

    fn tier_of(&self, run: &Run) -> Tier {
        // Before `session.started` the auth mode is unknown; runs start in subscription mode, which is what the provider-level chip shows too.
        self.chip_for(&run.meta.provider, run.meta.permission == PermissionMode::ReadOnly, Some(run.state.auth_mode.unwrap_or(AuthMode::Subscription))).tier
    }

    fn summary_of(&self, agent_id: &str) -> Option<AgentSummary> {
        let st = lock(&self.state);
        st.agents.get(agent_id).map(|r| r.summary(self.tier_of(r)))
    }

    /// A place for one more session on the server `loc`: fewer than `max` sessions are open there (`except`: a run that is being brought
    /// back is not counted against itself). The limit is the one of Settings > Servers, for new runs and for resumed ones alike. A
    /// finished run keeps its session for follow-up messages, so when the server is full the one that has been idle the longest gives its
    /// place up (it resumes with its next message), as on this Mac; only when every session is working or waiting for the person is the
    /// start refused.
    fn check_server_slot(&self, loc: &str, name: &str, max: u32, except: Option<&str>) -> Result<(), EngineError> {
        let mut open = 0;
        // (a candidate that became busy before it could be closed is looked for again; the number of tries is bounded)
        for _ in 0..8 {
            let (now_open, idlest) = {
                let st = lock(&self.state);
                let here: Vec<(&String, &Run)> = st.agents.iter().filter(|(id, r)| Some(id.as_str()) != except && r.meta.location.as_deref() == Some(loc) && r.live.is_some()).collect();
                let idlest = here.iter().filter(|(_, r)| r.is_idle()).min_by_key(|(_, r)| r.state.last_ts).map(|(id, _)| (*id).clone());
                (here.len(), idlest)
            };
            open = now_open;
            if open < max as usize {
                return Ok(());
            }
            match idlest {
                Some(id) => {
                    self.close_remote_session(&id, None);
                }
                None => break,
            }
        }
        Err(err("serverBusy", format!("{name} already runs {open} agents and none of them is finished (the limit in Settings > Servers)")))
    }

    /// Ends the session of a finished run on a server, here and there: the run stays in the list and resumes with its next message. The
    /// run is looked at again under the lock that ends the session (and, with `min_idle`, for how long it has been finished), so one that
    /// started a turn or is being resumed since the caller looked is left alone. Returns whether the session was closed.
    fn close_remote_session(&self, agent_id: &str, min_idle: Option<Duration>) -> bool {
        let loc = {
            let mut st = lock(&self.state);
            let Some(run) = st.agents.get_mut(agent_id) else { return false };
            if !run.is_idle() || min_idle.is_some_and(|d| now_ms().saturating_sub(run.state.last_ts) < d.as_millis() as u64) {
                return false;
            }
            let loc = run.meta.location.clone();
            run.end_session();
            loc
        };
        let sc = loc.and_then(|loc| lock(&self.remote).get(&loc).map(|r| r.sc.clone()));
        if let Some(sc) = sc {
            let id = agent_id.to_string();
            std::thread::spawn(move || {
                let _ = sc.request("session/close", json!({"agentId": id}), Duration::from_secs(5));
            });
        }
        true
    }

    /// Closes the sessions on the server `loc` that have been finished for `idle` or longer.
    fn reap_remote(&self, loc: &str, idle: Duration) {
        let now = now_ms();
        let stale: Vec<String> = {
            let st = lock(&self.state);
            st.agents.iter().filter(|(_, r)| r.meta.location.as_deref() == Some(loc) && r.is_idle() && now.saturating_sub(r.state.last_ts) >= idle.as_millis() as u64).map(|(id, _)| id.clone()).collect()
        };
        for id in stale {
            self.close_remote_session(&id, Some(idle));
        }
    }

    /// Settles where a run on the server `loc` works, before it starts: the server is ready, has a free slot, and every repo of the run
    /// is already there (the agent works in the server's own copy; nothing is copied or cloned behind the person's back).
    fn prepare_remote(&self, loc: &str, meta: &Meta) -> Result<RemoteDirs, EngineError> {
        let registry = self.cfg.servers.clone().ok_or_else(|| err("serversUnavailable", "servers are not available in this build"))?;
        let (scfg, _status, paths) = registry.ready(loc).map_err(|e| err("serverNotReady", e.message()))?;
        let mut dirs = Vec::new();
        let mut names: Vec<String> = Vec::new();
        for repo in &meta.repos {
            let dir = remote::remote_dir(&scfg, &paths.home, &repo.path).ok_or_else(|| err("remoteRepoName", format!("{} cannot be mapped to a folder on the server", repo.path.display())))?;
            let name = repo.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            // (two repositories of one run with the same folder name would share one folder there)
            if names.contains(&name) {
                return Err(err("remoteRepoName", format!("two repositories of this run are both called {name}; on a server they would share one folder")));
            }
            names.push(name);
            dirs.push(dir);
        }
        match intely_servers::repo_states(registry.ssh(), &scfg, &names) {
            Ok(states) => {
                let missing: Vec<&str> = states.iter().filter(|s| !s.exists || !s.is_git).map(|s| s.name.as_str()).collect();
                if !missing.is_empty() {
                    return Err(err("repoMissingOnServer", format!("{} is not on {} under {}: clone it first (Settings > Servers > Repositories)", missing.join(", "), scfg.name, scfg.root)));
                }
                // The same folder name is not the same repository: a copy of another project (or a fork) under that name would be worked
                // on instead. Both origins are compared as repositories (scheme, user, `.git` and the ssh/https spelling do not count);
                // a repository without an origin on either side cannot be told apart and is taken as it is.
                for (state, repo) in states.iter().zip(&meta.repos) {
                    let (Some(theirs), Some(ours)) = (state.origin.as_deref(), local_origin(&self.cfg.git, &repo.path)) else { continue };
                    if !intely_servers::same_origin(&ours, theirs) {
                        return Err(err(
                            "repoOriginMismatch",
                            format!("{} on {} is a different repository from the one on this Mac (origin {theirs} there, {ours} here). Fix the origin there or use another folder name", state.name, scfg.name),
                        ));
                    }
                }
            }
            Err(e) => return Err(err("serverNotReady", format!("{} did not answer: {e}", scfg.name))),
        }
        // last, because a full server gives the place of a finished run up for this one: nothing may be closed for a start that fails
        self.check_server_slot(loc, &scfg.name, scfg.max_agents, None)?;
        Ok(RemoteDirs { home: paths.home, dirs })
    }

    /// The policy context of a run, and for a run on a server the look at that server's files it is judged with.
    fn context_for_run(&self, meta: &Meta, role_deny: Vec<String>) -> (PolicyContext, Option<Arc<RemoteFs>>) {
        match (&meta.remote, &meta.location) {
            (Some(dirs), Some(loc)) => {
                let mut ctx = context_for_remote(meta, dirs, role_deny);
                let fs = self.remote_fs(loc);
                ctx.fs = Some(fs.clone() as Arc<dyn FsView>);
                (ctx, Some(fs))
            }
            _ => (context_for(meta, std::env::var_os("HOME").map(PathBuf::from), role_deny, &self.cfg.data_dir), None),
        }
    }

    /// The policy's look at the files of server `loc`: `fs/query` down the sidecar that runs there.
    fn remote_fs(&self, loc: &str) -> Arc<RemoteFs> {
        let (weak, loc) = (self.me.clone(), loc.to_string());
        Arc::new(RpcFs::new(SidecarFs::new(move |body| {
            let inner = weak.upgrade()?;
            // (only the lock of the sidecar map: a decision may be made while `state` is held, see `Inner::remote`)
            let sc = lock(&inner.remote).get(&loc).filter(|r| r.sc.alive()).map(|r| r.sc.clone())?;
            sc.request("fs/query", body, FS_QUERY_TIMEOUT).ok()
        })))
    }

    /// While the sidecar `sc` of the server `loc` lives, finished runs there give up their sessions after `HostConfig::remote_idle`.
    fn spawn_remote_reaper(&self, loc: &str, sc: &Arc<Sidecar>) {
        let (weak, sc, loc, idle) = (self.me.clone(), sc.clone(), loc.to_string(), self.cfg.remote_idle);
        let slice = Duration::from_millis(50);
        let every = (idle / 4).clamp(Duration::from_millis(100), Duration::from_secs(15));
        std::thread::spawn(move || {
            let mut waited = Duration::ZERO;
            while sc.alive() {
                std::thread::sleep(slice);
                waited += slice;
                if waited < every {
                    continue;
                }
                waited = Duration::ZERO;
                let Some(inner) = weak.upgrade() else { return };
                inner.reap_remote(&loc, idle);
            }
        });
    }

    /// The sidecar on server `loc`, started with the first run there (`ssh ... node index.js`; its stdin is the protocol pipe).
    fn ensure_remote_sidecar(&self, loc: &str) -> Result<(Arc<Sidecar>, remote::RemoteEnv), EngineError> {
        let registry = self.cfg.servers.clone().ok_or_else(|| err("serversUnavailable", "servers are not available in this build"))?;
        let (scfg, _status, paths) = registry.ready(loc).map_err(|e| err("serverNotReady", e.message()))?;
        // the machine this connection is for: a server whose address or port was edited meanwhile is another machine
        let target = format!("{}|{}", scfg.destination, scfg.port.map(|p| p.to_string()).unwrap_or_default());
        let mut stale: Option<Arc<Sidecar>> = None;
        let spawned = {
            let mut st = lock(&self.state);
            if st.shutting_down {
                return Err(err("shuttingDown", "the IDE is closing"));
            }
            let alive = lock(&self.remote).get(loc).filter(|r| r.sc.alive()).cloned();
            match alive {
                Some(link) if link.target == target => link.sc,
                other => {
                    if let Some(link) = other {
                        // The old connection goes to another machine. A run that works or waits there is on that machine: no new run may
                        // be put on it under the new address, and the connection cannot be closed under it. Finished runs give their
                        // sessions up (they come back with their next message).
                        let on_old = |r: &Run| r.meta.location.as_deref() == Some(loc) && r.live.as_ref().is_some_and(|l| l.generation == link.sc.generation);
                        if st.agents.values().any(|r| on_old(r) && !r.is_idle()) {
                            return Err(err("serverBusy", format!("{} was moved to another address while runs are working on the old one; stop them first", scfg.name)));
                        }
                        for run in st.agents.values_mut().filter(|r| on_old(r)) {
                            run.end_session();
                        }
                        stale = Some(link.sc);
                    }
                    let providers: Vec<String> = self.cfg.sidecar_providers().into_iter().filter(|p| matches!(p.as_str(), "claude" | "mock")).collect();
                    let command = intely_servers::sidecar_command(&paths, &providers, REMOTE_POLICY_TIMEOUT_MS);
                    let cmd = registry.ssh().command(&scfg, &command);
                    st.generation += 1;
                    let handler: Weak<dyn Handler> = self.me.clone();
                    let sc = Sidecar::spawn(cmd, st.generation, handler).map_err(|e| err("sidecarSpawn", format!("cannot reach {}: {e}", scfg.name)))?;
                    self.gate.register_owner(&sc.owner, None);
                    lock(&self.remote).insert(loc.to_string(), RemoteLink { sc: sc.clone(), target });
                    self.spawn_remote_reaper(loc, &sc);
                    sc
                }
            }
        };
        // (outside the state lock: stopping a connection takes a moment)
        if let Some(old) = stale {
            self.stop_sidecar(&old);
        }
        if spawned.wait_hello(Duration::from_secs(45)).is_none() {
            spawned.signal(libc::SIGKILL);
            let tail = spawned.stderr_tail();
            return Err(err("sidecarStart", format!("the agent sidecar on {} did not start{}", scfg.name, if tail.is_empty() { String::new() } else { format!(": {tail}") })));
        }
        Ok((spawned, remote::RemoteEnv { cfg: scfg, paths, registry }))
    }

    /// Puts the git guard of a run on the server: the script of `agent_gate::shim` rendered for the git there, uploaded to
    /// `<home>/.intely/shims/<agentId>`. Returns that folder.
    fn upload_remote_shim(&self, env: &remote::RemoteEnv, agent_id: &str) -> Result<String, EngineError> {
        let remote_dir = format!("{}/.intely/shims/{agent_id}", env.paths.home.trim_end_matches('/'));
        let script = shim::render_remote(&env.paths.git, &format!("{remote_dir}/refusals.log"), true).map_err(|e| err("shim", format!("cannot prepare the git guard: {e}")))?;
        let local = self.cfg.data_dir.join("shims").join(format!("{agent_id}.remote"));
        let _ = std::fs::remove_dir_all(&local);
        let result = (|| {
            std::fs::create_dir_all(&local)?;
            let git = local.join("git");
            std::fs::write(&git, script)?;
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755))?;
            }
            intely_servers::upload_shim(env.registry.ssh(), &env.cfg, &env.paths.home, agent_id, &local).map_err(std::io::Error::other)
        })();
        let _ = std::fs::remove_dir_all(&local);
        result.map_err(|e| err("shim", format!("cannot put the git guard on {}: {e}", env.cfg.name)))
    }

    /// The sidecar of one generation, here or on a server.
    fn sidecar_gen(&self, st: &State, generation: u64) -> Option<Arc<Sidecar>> {
        st.sidecar.iter().find(|s| s.generation == generation).cloned().or_else(|| lock(&self.remote).values().find(|r| r.sc.generation == generation).map(|r| r.sc.clone()))
    }

    fn live_sidecar(&self, st: &State, agent_id: &str) -> Result<Arc<Sidecar>, EngineError> {
        let run = st.agents.get(agent_id).ok_or_else(|| unknown_agent(agent_id))?;
        match run.live.as_ref().and_then(|l| self.sidecar_gen(st, l.generation)) {
            Some(sc) if sc.alive() => Ok(sc),
            _ => Err(err("notRunning", "the agent session is not running; send a message to resume it")),
        }
    }

    /// Spawns the sidecar if it is not running. The first call after startup pays for it, nothing else does. The
    /// `--providers` list comes from the confirmed experimental providers at that moment; when a session of an adapter that
    /// the running sidecar was not started with is needed (the settings changed since), an idle sidecar is restarted with
    /// the new list, and a busy one refuses the start (`providerRestart`) instead of killing live runs.
    fn ensure_sidecar(&self, need: Option<&str>) -> Result<Arc<Sidecar>, EngineError> {
        let stale = {
            let mut st = lock(&self.state);
            let missing = need.is_some_and(|a| !st.sidecar_providers.iter().any(|p| p == a));
            match st.sidecar.clone().filter(|s| s.alive()) {
                Some(sc) if missing => {
                    if st.agents.values().any(|r| r.live.is_some()) {
                        return Err(err("providerRestart", "the provider list changed: stop the running agents, then start this one again"));
                    }
                    st.sidecar = None;
                    Some(sc)
                }
                _ => None,
            }
        };
        if let Some(sc) = stale {
            self.stop_sidecar(&sc);
        }
        let sc = {
            let mut st = lock(&self.state);
            if st.shutting_down {
                return Err(err("shuttingDown", "the IDE is closing"));
            }
            if let Some(sc) = st.sidecar.as_ref().filter(|s| s.alive()) {
                sc.clone()
            } else {
                let env = (self.cfg.env)();
                let node = self.cfg.node.clone().or_else(|| find_on_path("node", &env)).ok_or_else(|| err("nodeNotFound", "Node.js was not found on the login PATH"))?;
                if !self.cfg.sidecar_js.is_file() {
                    return Err(err("sidecarMissing", format!("the agent sidecar bundle is missing: {}", self.cfg.sidecar_js.display())));
                }
                let _ = intely_agent_core::events::log::create_private_dir_all(&self.cfg.data_dir);
                let providers = self.cfg.sidecar_providers();
                let mut cmd = Command::new(node);
                cmd.arg(&self.cfg.sidecar_js).arg(format!("--providers={}", providers.join(",")));
                cmd.env_clear().envs(scrub_env(&env)).current_dir(&self.cfg.data_dir);
                st.generation += 1;
                let handler: Weak<dyn Handler> = self.me.clone();
                let sc = Sidecar::spawn(cmd, st.generation, handler).map_err(|e| err("sidecarSpawn", format!("cannot start the agent sidecar: {e}")))?;
                self.gate.register_owner(&sc.owner, Some(sc.pid as libc::pid_t));
                st.sidecar = Some(sc.clone());
                st.sidecar_providers = providers;
                sc
            }
        };
        {
            let mut reaper = lock(&self.reaper);
            if reaper.is_none() {
                *reaper = Some(Reaper::spawn(self.gate.clone(), ReaperConfig::default()));
            }
        }
        if sc.wait_hello(Duration::from_secs(15)).is_none() {
            sc.signal(libc::SIGKILL);
            let tail = sc.stderr_tail();
            return Err(err("sidecarStart", format!("the agent sidecar did not start{}", if tail.is_empty() { String::new() } else { format!(": {tail}") })));
        }
        Ok(sc)
    }

    /// Closes an idle sidecar: stdin first, then the signals; its process groups are the gate's to reclaim.
    fn stop_sidecar(&self, sc: &Arc<Sidecar>) {
        sc.close_stdin();
        if !sc.wait_exit(Duration::from_secs(6)) {
            sc.signal(libc::SIGTERM);
            if !sc.wait_exit(Duration::from_secs(2)) {
                sc.signal(libc::SIGKILL);
                sc.wait_exit(Duration::from_secs(2));
            }
        }
        sc.join_threads();
        self.gate.owner_closed(&sc.owner);
    }

    /// `session/start` for a new run (`resume` = None) or the resumption of an existing one.
    fn open_session(&self, role: &RoleDef, agent_id: &str, resume: Option<String>) -> Result<(), EngineError> {
        // a run on a server talks to the sidecar there; everything else of the start below is shared
        let remote_target = lock(&self.state).agents.get(agent_id).and_then(|r| r.meta.location.clone().zip(r.meta.remote.clone()));
        let (sc, remote_env) = match &remote_target {
            Some((loc, _)) => {
                let (sc, env) = self.ensure_remote_sidecar(loc)?;
                (sc, Some(env))
            }
            None => (self.ensure_sidecar(Some(role.provider.as_str()))?, None),
        };
        let env_vars = scrub_env(&(self.cfg.env)());
        let resuming = resume.is_some();
        let (meta, next_seq, writer, quiet, run_dirs) = {
            let mut st = lock(&self.state);
            let run = st.agents.get_mut(agent_id).ok_or_else(|| unknown_agent(agent_id))?;
            // a session opens with no allow of an earlier one (D10: they die with the session, the idle reaper included) and no stale MCP set
            run.reset_session_state();
            let run_dirs: Vec<PathBuf> = std::iter::once(run.ctx.cwd.clone()).chain(run.ctx.add_dirs.iter().cloned()).collect();
            (run.meta.clone(), run.state.last_seq + 1, run.writer_needed(), run.quiet, run_dirs)
        };
        // the run's mode is the only authority on what the role may do (a role passed in carries it; a debug build checks the callers agree)
        debug_assert_eq!(role.permission, meta.permission, "open_session needs a role whose permission is the run's mode");
        if remote_env.is_none() {
            for repo in &meta.repos {
                Jail::global().check_op("agent run", &repo.path)?;
            }
        }
        self.check_provider_gate(role)?;
        let acp = if !matches!(role.provider.as_str(), "claude" | "mock") {
            let all: HashMap<String, String> = env_vars.clone().into_iter().collect();
            Some(self.acp_launch(role, self.cfg.node.clone().or_else(|| find_on_path("node", &all)).as_deref())?)
        } else {
            None
        };
        let claude_bin = if let Some(env) = remote_env.as_ref().filter(|_| role.provider == "claude") {
            Some(env.paths.claude.clone())
        } else if role.provider == "claude" && remote_env.is_none() {
            let all: HashMap<String, String> = env_vars.clone().into_iter().collect();
            let bin = self.cfg.claude_bin.clone().or_else(|| find_on_path("claude", &all)).ok_or_else(|| err("claudeNotFound", "the claude CLI was not found on the login PATH"))?;
            Some(bin.to_string_lossy().into_owned())
        } else {
            None
        };
        // Codex runs `<codexBin> app-server`: the confirmed program (the host never lets the sidecar look for it).
        let codex_bin = if role.provider == "codex" { Some(self.launch_of("codex").ok_or_else(|| not_enabled("codex"))?.command) } else { None };
        let shim_dir_value = match &remote_env {
            Some(env) => self.upload_remote_shim(env, agent_id)?,
            None => {
                let shim_dir = self.cfg.data_dir.join("shims").join(agent_id);
                shim::generate(&shim_dir, &self.cfg.git).map_err(|e| err("shim", format!("cannot prepare the git guard: {e}")))?.dir.to_string_lossy().into_owned()
            }
        };
        let (cwd, add_dirs) = match &remote_target {
            // the folders of the server (the attachment store of this Mac does not exist there)
            Some((_, r)) => (r.dirs.first().cloned().unwrap_or_default(), r.dirs.iter().skip(1).cloned().collect::<Vec<String>>()),
            None => {
                let mut repos = meta.repos.iter();
                let cwd = repos.next().map(|r| r.path.to_string_lossy().into_owned()).unwrap_or_default();
                let mut add_dirs: Vec<String> = repos.map(|r| r.path.to_string_lossy().into_owned()).collect();
                // The attachment store, as a READ-ONLY context directory (the policy hard-stops every write under the state dir).
                add_dirs.push(self.cfg.data_dir.join("attachments").to_string_lossy().into_owned());
                (cwd, add_dirs)
            }
        };
        let mut resolved = role.resolved(&self.cfg);
        resolved.permission = meta.permission;
        // A team lead: resolve the delegates from the current files, give the broker the matching rules, and take Agent/Task away
        // from a lead that has nobody to hand work to (the lead then works alone; nothing falls back to "all tools").
        let plan = self.plan_delegation(role, &meta.repos);
        if let Some(p) = &plan {
            let defaults = self.cfg.defaults();
            if !p.is_active() {
                for t in ["Agent", "Task"] {
                    if !resolved.disallowed_tools.iter().any(|d| d == t) {
                        resolved.disallowed_tools.push(t.to_string());
                    }
                }
            }
            if let Some(run) = lock(&self.state).agents.get_mut(agent_id) {
                if p.is_active() {
                    let rules = p.defs().iter().map(|d| {
                        let s = &d.spec;
                        (s.name.clone(), DelegateRule { mode: s.permission, allowed_tools: (!s.tools.is_empty()).then(|| s.tools.clone()), role_deny: s.disallowed_tools.clone(), capped: d.capped })
                    });
                    run.ctx.subagents = p.defs().iter().map(|d| d.spec.name.clone()).collect();
                    run.ctx.delegates = Some(rules.collect());
                    run.ctx.delegation_cap = defaults.delegation_cap;
                } else {
                    // nobody to delegate to: no sub-agent at all, whatever the CLI offers
                    run.ctx.delegates = None;
                    run.ctx.subagents = Vec::new();
                    for t in ["Agent", "Task"] {
                        if !run.ctx.role_deny.iter().any(|d| d == t) {
                            run.ctx.role_deny.push(t.to_string());
                        }
                    }
                }
            }
        }
        let delegates = plan.as_ref().filter(|p| p.is_active()).map(|p| p.set.specs());
        // Where the CLI keeps its plan notes (Claude only): a private directory of this run under the state dir, removed with a failed launch.
        let plan_path = (role.provider == "claude" && !quiet && remote_env.is_none()).then(|| plan_dir(&self.cfg.data_dir, agent_id));
        if let Some(dir) = &plan_path {
            intely_agent_core::events::log::create_private_dir_all(dir).map_err(|e| err("planDir", format!("cannot prepare the plan directory: {e}")))?;
        }
        // The MCP servers of the run (MCP spec 5.2 point 4). The resolved config carries secrets: it lives in this function only, goes
        // out in `session/start` and is dropped right after; `Meta`, events, logs and errors never see it.
        let mut mcp_wire = None;
        if matches!(role.provider.as_str(), "claude" | "mock") && !meta.mcp.is_empty() {
            let supplier = self.cfg.mcp_supplier.clone().ok_or_else(|| err("mcpUnavailable", "MCP is not available in this build"))?;
            let resolved_mcp = supplier(&McpSelection { ids: meta.mcp.clone(), strict: !resuming, run_dirs }).map_err(|e| err(&e.code, e.message))?;
            for skipped in &resolved_mcp.skipped {
                eprintln!("agent host: MCP server {} skipped on resume: {}", skipped.name, skipped.reason);
            }
            // only the names of servers that carry env values or headers are kept (the consent lines warn about a secret in the environment)
            let secret: std::collections::BTreeSet<String> = serde_json::to_value(&resolved_mcp.servers)
                .ok()
                .and_then(|v| v.as_object().cloned())
                .map(|servers| servers.iter().filter(|(_, c)| ["env", "headers"].iter().any(|k| c.get(*k).and_then(Value::as_object).is_some_and(|m| !m.is_empty()))).map(|(n, _)| n.clone()).collect())
                .unwrap_or_default();
            if let Some(run) = lock(&self.state).agents.get_mut(agent_id) {
                run.ctx.mcp_servers = resolved_mcp.names.clone();
                run.ctx.mcp_tools = resolved_mcp.rules.clone();
                run.ctx.mcp_code_paths = resolved_mcp.code_paths.clone();
                run.mcp_ids = resolved_mcp.ids.clone();
                run.mcp_secret = secret;
            }
            if !resolved_mcp.servers.is_empty() {
                mcp_wire = Some(resolved_mcp.servers);
            }
        }
        let start = SessionStart {
            agent_id: agent_id.to_string(),
            provider: role.provider.clone(),
            role: resolved,
            cwd,
            add_dirs,
            resume: resume.map(|native_id| ResumeRef { native_id }),
            session_id: if meta.native_id.is_none() && next_seq == 1 { Some(uuid::Uuid::new_v4().to_string()) } else { None },
            // (on a server the sidecar uses its own environment: nothing of this Mac's login shell is sent there)
            env: SessionEnv { claude_bin, codex_bin, shim_dir: Some(shim_dir_value), vars: remote_env.is_none().then_some(env_vars) },
            mcp: mcp_wire,
            auth: AuthHandoff { mode: AuthMode::Subscription, key: None },
            writer: Some(writer),
            repo_id: meta.repos.first().map(|r| r.id.clone()),
            next_seq: Some(next_seq),
            setting_sources: None,
            deny_rules: None,
            mock: role.mock_scenario.as_ref().filter(|_| role.provider == "mock").map(|s| json!({"scenario": s, "speed": self.cfg.mock_speed})),
            acp,
            delegates,
            plan_dir: plan_path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            include_user_memory: (role.provider == "claude" && !self.cfg.include_user_memory()).then_some(false),
        };
        let mut body = serde_json::to_value(&start).map_err(|e| err("internal", e.to_string()))?;
        drop(start);
        strip_nulls(&mut body);
        {
            let mut st = lock(&self.state);
            if let Some(run) = st.agents.get_mut(agent_id) {
                run.live = Some(Live { generation: sc.generation, lease_id: None });
                run.muted = false;
                // (a resumed run still reads "finished" until its first event: it is not idle while its session starts)
                run.busy_until = Some(std::time::Instant::now() + self.cfg.start_timeout + Duration::from_secs(30));
            }
        }
        let fail = |code: &str, message: String| -> EngineError {
            if let Some(run) = lock(&self.state).agents.get_mut(agent_id) {
                run.end_session();
            }
            err(code, message)
        };
        match sc.request("session/start", body, self.cfg.start_timeout) {
            Err(e) => Err(fail("sidecarUnavailable", format!("the agent sidecar did not start the session: {e}"))),
            Ok(v) if v["ok"] == true => {
                if let Some(native) = v["nativeId"].as_str() {
                    let meta = {
                        let mut st = lock(&self.state);
                        st.agents.get_mut(agent_id).map(|run| {
                            run.meta.native_id = Some(native.to_string());
                            run.meta.clone()
                        })
                    };
                    if let Some(m) = meta {
                        self.persist_meta(&m);
                    }
                }
                Ok(())
            }
            Ok(v) => {
                let code = v["error"].as_str().unwrap_or("open").to_string();
                let detail = v["detail"].as_str().unwrap_or("the sidecar refused to start the session").to_string();
                Err(fail(&code, detail))
            }
        }
    }

    fn prompt(&self, agent_id: &str, text: &str, files: Vec<serde_json::Value>) -> Result<(), EngineError> {
        let sc = {
            let mut st = lock(&self.state);
            if !files.is_empty() && st.agents.get(agent_id).is_some_and(|r| r.meta.location.is_some()) {
                return Err(err("remoteAttachments", "attachments are not available for runs on a server yet"));
            }
            let sc = self.live_sidecar(&st, agent_id)?;
            // the turn opens when the first event for this message arrives; until then the run must not be taken for an idle one
            if let Some(run) = st.agents.get_mut(agent_id) {
                run.busy_until = Some(std::time::Instant::now() + Duration::from_secs(30));
            }
            sc
        };
        let reply = sc.request("session/prompt", if files.is_empty() { json!({"agentId": agent_id, "text": text}) } else { json!({"agentId": agent_id, "text": text, "attachments": files}) }, Duration::from_secs(15)).map_err(|e| err("sidecarUnavailable", e.to_string()))?;
        if let Some(code) = reply["error"].as_str() {
            return Err(err(code, reply["detail"].as_str().unwrap_or("the agent did not take the message")));
        }
        Ok(())
    }

    fn interrupt(&self, agent_id: &str) -> Result<(), EngineError> {
        let (sc, lease, tracker) = {
            let mut st = lock(&self.state);
            let Ok(sc) = self.live_sidecar(&st, agent_id) else { return Ok(()) };
            let run = st.agents.get_mut(agent_id).ok_or_else(|| unknown_agent(agent_id))?;
            // Stop must reach whatever is still waiting on the person (an approval card) even when no turn is open any more.
            let waiting = !run.state.perms.is_empty() || !run.state.questions.is_empty();
            if (!run.state.turn_open && !waiting) || run.cancel.is_some() {
                return Ok(());
            }
            let tracker = Arc::new(CancelTracker::default());
            run.state.perms.keys().for_each(|id| tracker.permission_asked(id));
            run.state.open_tools.iter().for_each(|id| tracker.tool_started(id));
            run.cancel = Some(tracker.clone());
            (sc, run.live.as_ref().and_then(|l| l.lease_id.clone()), tracker)
        };
        let plan = self.cfg.cancel;
        let Some(lease) = lease else {
            // no lease to escalate on: only the polite request is possible
            let body = json!({"agentId": agent_id, "softMs": plan.soft.as_millis() as u64, "termMs": plan.term.as_millis() as u64});
            let _ = sc.request("cancel/request", body, Duration::from_secs(2));
            if let Some(run) = lock(&self.state).agents.get_mut(agent_id) {
                run.cancel = None;
            }
            return Ok(());
        };
        let bridge = Arc::new(CancelBridge { inner: self.me.clone(), agent_id: agent_id.to_string(), sidecar: sc.clone() });
        let handle = cancel::run(self.gate.clone(), lease, plan, bridge, tracker);
        let weak = self.me.clone();
        let id = agent_id.to_string();
        std::thread::spawn(move || {
            let report = handle.join();
            let Some(inner) = weak.upgrade() else { return };
            let escalated = report.as_ref().is_ok_and(|r| r.stage != "soft");
            if let Some(run) = lock(&inner.state).agents.get_mut(&id) {
                run.cancel = None;
                if escalated {
                    // the CLI behind the session was killed: the session is gone until the next message resumes it
                    run.end_session();
                    run.muted = true;
                }
            }
            if escalated {
                let _ = sc.request("session/close", json!({"agentId": id}), Duration::from_secs(5));
            }
        });
        Ok(())
    }

    /// Appends then publishes (append-before-publish). Must be called with the state lock held so that events of
    /// one agent are published in the order they were stored.
    fn commit(&self, agent_id: &str, events: Vec<AgentEvent>) {
        if events.is_empty() {
            return;
        }
        if let Err(e) = self.log.append_batch(&events) {
            eprintln!("agent host: cannot store events of {agent_id}: {e}");
            return;
        }
        self.sink.events(events);
    }

    /// Host-made events (cancel, sidecar death): numbered after the last stored one.
    fn synthesize(&self, st: &mut State, agent_id: &str, kinds: Vec<EventKind>) {
        let Some(run) = st.agents.get_mut(agent_id) else { return };
        let (provider, turn_id, quiet) = (run.meta.provider.clone(), run.state.turn_id.clone(), run.quiet);
        let mut events = Vec::new();
        for kind in kinds {
            let event = AgentEvent { agent_id: agent_id.to_string(), seq: run.state.last_seq + 1, ts: now_ms(), turn_id: if run.state.turn_open { turn_id.clone() } else { None }, provider: provider.clone(), kind, raw: None };
            Self::apply(&self.gate, run, &event);
            events.push(event);
        }
        if !quiet {
            self.commit(agent_id, events);
        }
    }

    /// Folds one stored event into the run, and mirrors it to the gate and the cancel tracker.
    fn apply(gate: &Gate, run: &mut Run, e: &AgentEvent) {
        run.state.apply(e);
        match &e.kind {
            EventKind::PermissionRequest { req_id, .. } => {
                run.card_epoch.insert(req_id.clone(), run.rules_epoch);
            }
            EventKind::PermissionResolved { req_id, .. } => {
                run.card_epoch.remove(req_id);
            }
            EventKind::TurnEnd { .. } => {
                run.card_epoch.clear();
                // the turn that was on its way has come and gone: what the events say is the truth again
                run.busy_until = None;
            }
            _ => {}
        }
        if let Some(t) = &run.cancel {
            match &e.kind {
                EventKind::PermissionRequest { req_id, .. } => t.permission_asked(req_id),
                EventKind::PermissionResolved { req_id, .. } => t.permission_answered(req_id),
                EventKind::ToolStart { tool_id, .. } => t.tool_started(tool_id),
                EventKind::ToolResult { tool_id, .. } => t.tool_finished(tool_id),
                _ => {}
            }
        }
        if let Some(lease) = run.live.as_ref().and_then(|l| l.lease_id.as_deref()) {
            match &e.kind {
                EventKind::UserMessage { .. } => gate.set_busy(lease, true),
                EventKind::TurnEnd { .. } => gate.set_busy(lease, false),
                _ => gate.touch(lease),
            }
        }
    }

    fn ingest(&self, sc: &Arc<Sidecar>, agent_id: &str, provider: &str, batch: Vec<BatchEvent>) {
        let mut st = lock(&self.state);
        let Some(run) = st.agents.get_mut(agent_id) else {
            eprintln!("agent host: events for unknown agent {agent_id} dropped");
            return;
        };
        if run.muted || run.live.as_ref().map(|l| l.generation) != Some(sc.generation) {
            return;
        }
        let mut stored = Vec::with_capacity(batch.len());
        let quiet = run.quiet;
        let native_before = run.state.native_id.clone();
        for b in batch {
            if b.seq <= run.state.last_seq {
                continue;
            }
            if b.seq != run.state.last_seq + 1 {
                eprintln!("agent host: seq gap for {agent_id}: expected {}, got {}", run.state.last_seq + 1, b.seq);
            }
            let event = b.into_event(agent_id, provider);
            if let EventKind::Error { class: ErrorClass::Policy, message, .. } = &event.kind {
                if message.starts_with(roles::DELEGATION_CANARY_MARK) && !self.delegation_tripped.swap(true, Ordering::SeqCst) {
                    eprintln!("agent host: delegation switched off for this session of the app: a sub-agent call carried no agent_id ({agent_id})");
                }
            }
            Self::apply(&self.gate, run, &event);
            stored.push(event);
        }
        let meta = (run.state.native_id != native_before).then(|| {
            run.meta.native_id = run.state.native_id.clone();
            run.meta.clone()
        });
        if let Some(caps) = stored.iter().rev().find_map(|e| if let EventKind::SessionInfo { caps: Some(c), .. } = &e.kind { Some(c.clone()) } else { None }) {
            st.negotiated.insert(provider.to_string(), caps);
        }
        if !quiet {
            self.commit(agent_id, stored);
        }
        drop(st);
        if let Some(m) = meta.filter(|_| !quiet) {
            self.persist_meta(&m);
        }
    }

    fn lease_for(&self, agent_id: &str, lease_id: &str) {
        if let Some(run) = lock(&self.state).agents.get_mut(agent_id) {
            if let Some(live) = run.live.as_mut() {
                live.lease_id = Some(lease_id.to_string());
            }
        }
    }

    fn on_policy(&self, sc: &Arc<Sidecar>, id: u32, body: Value) {
        match self.cfg.policy_fault {
            Some(PolicyFault::Drop) => return,
            Some(PolicyFault::ClosePipe) => {
                sc.close_stdin();
                return;
            }
            None => {}
        }
        let (ctx, remote_fs) = match body["agentId"].as_str().and_then(|a| lock(&self.state).agents.get(a).map(|r| (r.ctx.clone(), r.remote_fs.clone()))) {
            Some((ctx, fs)) => (Some(ctx), fs),
            None => (None, None),
        };
        let sc = sc.clone();
        // a run on a server looks at its files through the network: the sidecar there was told the longer wait too (`--policy-timeout`)
        let wait_ms = (if remote_fs.is_some() { u64::from(REMOTE_POLICY_TIMEOUT_MS) } else { u64::from(POLICY_REPLY_TIMEOUT_MS) }) - 200;
        std::thread::spawn(move || {
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                // (a look at the server's files that cannot be answered makes `decide` itself deny: `fsview::mark_failed`. The mark
                // belongs to this decision on this thread, so tool calls judged side by side cannot lose each other's)
                let _ = tx.send(decide_wire(ctx.as_ref(), &body));
            });
            // the sidecar gives up after its own timeout and denies on its own; answering first keeps the audit trail honest
            let decision = rx.recv_timeout(Duration::from_millis(wait_ms)).unwrap_or_else(|_| fail_closed("the policy decision took too long"));
            sc.reply(id, serde_json::to_value(decision).unwrap_or(Value::Null));
        });
    }

    fn on_acquire(&self, sc: &Arc<Sidecar>, id: u32, body: Value) {
        let Some(agent_id) = body["agentId"].as_str().map(str::to_string) else {
            sc.reply(id, json!({"error": "noSlot", "detail": "malformed slot/acquire"}));
            return;
        };
        if !lock(&self.state).agents.contains_key(&agent_id) {
            sc.reply(id, json!({"error": "noSlot", "detail": "unknown agent"}));
            return;
        }
        // A run on a server takes no slot of this Mac's gate (its processes, memory and write lease are the server's business; its limit is
        // the server's `maxAgents`, checked when the run started): an acknowledgement the sidecar there can renew.
        if lock(&self.state).agents.get(&agent_id).is_some_and(|r| r.meta.location.is_some()) {
            sc.reply(id, json!({"leaseId": format!("remote:{agent_id}"), "ttlMs": 15_000}));
            return;
        }
        let mut b = body;
        b["owner"] = json!(sc.owner);
        b["rssBudgetMb"] = json!(rss_budget_mb(b["provider"].as_str().unwrap_or("")));
        let req: AcquireReq = match serde_json::from_value(b) {
            Ok(r) => r,
            Err(e) => {
                sc.reply(id, json!({"error": "noSlot", "detail": format!("malformed slot/acquire: {e}")}));
                return;
            }
        };
        let mut admitted = self.gate.acquire(req.clone());
        // a few idle sessions may have to go (a writer slot, a repo lease, an agent slot, memory): one at a time
        for _ in 0..4 {
            match &admitted {
                Err(e) if self.make_room(&req, e.kind) => admitted = self.gate.acquire(req.clone()),
                _ => break,
            }
        }
        match admitted {
            Ok(lease) => {
                self.lease_for(&agent_id, &lease.lease_id);
                sc.reply(id, serde_json::to_value(lease).unwrap_or(Value::Null));
            }
            Err(e) => sc.reply(id, serde_json::to_value(e).unwrap_or(Value::Null)),
        }
    }

    /// A finished run keeps its session (and its slot) for follow-up messages. When a new run is refused for lack of a
    /// slot, the longest-idle session that is not working makes room (it resumes on its next message).
    fn make_room(&self, req: &AcquireReq, why: AdmissionKind) -> bool {
        let mut idle: Vec<_> = self.gate.leases().into_iter().filter(|l| !l.busy).collect();
        // a writer needs a writer's slot: idle writers go first, then the longest idle
        idle.sort_by(|a, b| (req.writer && b.writer).cmp(&(req.writer && a.writer)).then(b.idle_ms.cmp(&a.idle_ms)));
        let victim = match why {
            AdmissionKind::WriteLease => idle.into_iter().find(|l| l.writer && l.repo_id == req.repo_id),
            AdmissionKind::NoSlot | AdmissionKind::RssBudget => idle.into_iter().next(),
        };
        victim.is_some_and(|l| self.gate.reclaim(&l.lease_id, ReclaimReason::Idle).is_some())
    }

    fn on_cancel_done(&self, body: &Value) {
        let (Some(agent), Some(ms)) = (body["agentId"].as_str(), body["ms"].as_u64()) else { return };
        let st = lock(&self.state);
        if let Some(t) = st.agents.get(agent).and_then(|r| r.cancel.clone()) {
            // within the soft window the adapter ended the turn itself; a late `done` means the sidecar had to force
            // it and the CLI may still be busy, so the escalation clock keeps running
            if ms < self.cfg.cancel.soft.as_millis() as u64 {
                t.mark_turn_end();
            }
        }
    }

    /// The gate took a lease away on its own.
    fn on_reclaimed(&self, r: &Reclaimed) {
        match r.reason {
            ReclaimReason::Idle => {
                let sc = {
                    let mut st = lock(&self.state);
                    if let Some(run) = st.agents.get_mut(&r.agent_id) {
                        run.end_session();
                    }
                    st.sidecar.clone()
                };
                if let Some(sc) = sc {
                    let id = r.agent_id.clone();
                    std::thread::spawn(move || {
                        let _ = sc.request("session/close", json!({"agentId": id}), Duration::from_secs(5));
                    });
                }
            }
            // renewals stopped: the sidecar hangs; killing it lets `on_closed` close the runs honestly
            ReclaimReason::Expired | ReclaimReason::OwnerGone => {
                if let Some(sc) = lock(&self.state).sidecar.clone() {
                    sc.signal(libc::SIGKILL);
                }
            }
            ReclaimReason::OwnerClosed | ReclaimReason::Cancelled => {}
        }
    }

    /// Runs found in the log that this process did not start.
    fn load_history(&self, st: &mut State) {
        if st.history_loaded {
            return;
        }
        st.history_loaded = true;
        let Ok(ids) = self.log.runs() else { return };
        for id in ids {
            if st.agents.contains_key(&id) {
                continue;
            }
            let Some(meta) = std::fs::read(meta_path(&self.runs_dir(), &id)).ok().and_then(|b| serde_json::from_slice::<Meta>(&b).ok()) else { continue };
            let Ok(events) = self.log.read(&id) else { continue };
            let mut state = RunState::default();
            events.iter().for_each(|e| state.apply(e));
            // The run keeps the mode it recorded, so a listed Bypass run still shows Bypass; a resume re-derives what it may continue in
            // from the role as it resolves then (`resume_mode_for`), and nothing a stopped run holds is ever consulted for a decision.
            let role_deny = self.role_named(&meta.role, &meta.repos).map(|r| r.disallowed_tools).unwrap_or_default();
            let (ctx, remote_fs) = self.context_for_run(&meta, role_deny);
            let mut run = Run::new(meta, state, ctx, false);
            run.remote_fs = remote_fs;
            st.agents.insert(id.clone(), run);
            // a turn that was still open when the previous IDE instance went away ended with it
            let closure = st.agents.get(&id).map(|r| r.closure(Some("the IDE closed while this run was working"), StopReason::Error, DecidedBy::FailClosed)).unwrap_or_default();
            self.synthesize(st, &id, closure);
        }
    }
}

impl Handler for Inner {
    fn on_message(&self, sc: &Arc<Sidecar>, msg: Incoming) {
        match msg.kind.as_str() {
            "hello" => {}
            "heartbeat" => {
                self.gate.heartbeat(&sc.owner);
            }
            "policy/decide" => self.on_policy(sc, msg.id, msg.body),
            "slot/acquire" => self.on_acquire(sc, msg.id, msg.body),
            "slot/renew" => {
                let asked: Vec<i64> = msg.body["pgids"].as_array().map(|a| a.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
                if msg.body["leaseId"].as_str().is_some_and(|l| l.starts_with("remote:")) {
                    // the process groups are the server's: none of them is ours to track
                    sc.reply(msg.id, json!({"ok": true, "ttlMs": 15_000, "rejectedPgids": asked}));
                    return;
                }
                // Only groups that really belong to this sidecar's process tree may be tracked (and later killed).
                let below: std::collections::HashSet<i32> = intely_agent_gate::gate::rss::descendants(sc.pid as i32).into_iter().collect();
                let ours = |g: i32| below.contains(&g) || intely_agent_gate::gate::procinfo::live_group_pids(g).iter().any(|p| below.contains(p));
                let (mut pgids, mut foreign) = (Vec::new(), Vec::new());
                for g in asked {
                    match i32::try_from(g) {
                        Ok(id) if ours(id) => pgids.push(id),
                        _ => foreign.push(g),
                    }
                }
                match msg.body["leaseId"].as_str().map(|l| self.gate.renew(l, &pgids)) {
                    Some(Ok(ok)) => {
                        let rejected: Vec<i64> = ok.rejected_pgids.iter().map(|g| i64::from(*g)).chain(foreign).collect();
                        sc.reply(msg.id, json!({"ok": true, "ttlMs": ok.ttl_ms, "rejectedPgids": rejected}))
                    }
                    _ => sc.reply(msg.id, json!({"error": "unknownLease"})),
                }
            }
            "slot/release" => {
                if let Some(lease) = msg.body["leaseId"].as_str().filter(|l| !l.starts_with("remote:")) {
                    self.gate.release(lease);
                    let mut st = lock(&self.state);
                    for run in st.agents.values_mut() {
                        if let Some(live) = run.live.as_mut().filter(|l| l.lease_id.as_deref() == Some(lease)) {
                            live.lease_id = None;
                        }
                    }
                }
            }
            "events/batch" => {
                let (Some(agent), Some(provider)) = (msg.body["agentId"].as_str(), msg.body["provider"].as_str()) else { return };
                match serde_json::from_value::<Vec<BatchEvent>>(msg.body["events"].clone()) {
                    Ok(events) => self.ingest(sc, agent, provider, events),
                    Err(e) => eprintln!("agent host: malformed events/batch from the sidecar: {e}"),
                }
            }
            "cancel/done" => self.on_cancel_done(&msg.body),
            other => {
                eprintln!("agent host: refusing sidecar message of type {other:?}");
                sc.reply(msg.id, json!({"error": "unknownType", "detail": other}));
            }
        }
    }

    fn on_closed(&self, sc: &Arc<Sidecar>) {
        let graceful = {
            let mut st = lock(&self.state);
            if st.sidecar.as_ref().is_some_and(|s| s.generation == sc.generation) {
                st.sidecar = None;
            }
            lock(&self.remote).retain(|_, r| r.sc.generation != sc.generation);
            st.shutting_down
        };
        // kills the CLI groups the sidecar registered; the gate's callback ignores this reason
        self.gate.owner_closed(&sc.owner);
        let mut st = lock(&self.state);
        let ids: Vec<String> = st.agents.iter().filter(|(_, r)| r.live.as_ref().is_some_and(|l| l.generation == sc.generation)).map(|(id, _)| id.clone()).collect();
        for id in ids {
            let message = if graceful { "the IDE was closed".to_string() } else { format!("the agent sidecar exited unexpectedly{}", tail_suffix(sc)) };
            let closure = st.agents.get(&id).map(|r| r.closure(Some(&message), StopReason::Error, DecidedBy::FailClosed)).unwrap_or_default();
            self.synthesize(&mut st, &id, closure);
            if let Some(run) = st.agents.get_mut(&id) {
                run.end_session();
                run.cancel = None;
            }
        }
    }
}

fn tail_suffix(sc: &Sidecar) -> String {
    let tail = sc.stderr_tail();
    match tail.lines().last() {
        Some(last) if !last.is_empty() => format!(" ({last})"),
        _ => String::new(),
    }
}

/// Connects the gate's cancel executor to this host.
struct CancelBridge {
    inner: Weak<Inner>,
    agent_id: String,
    sidecar: Arc<Sidecar>,
}

impl CancelBridge {
    fn synth(&self, f: impl FnOnce(&Run) -> Vec<EventKind>, mute: bool) {
        let Some(inner) = self.inner.upgrade() else { return };
        let mut st = lock(&inner.state);
        let kinds = st.agents.get(&self.agent_id).map(f).unwrap_or_default();
        if kinds.is_empty() {
            return;
        }
        inner.synthesize(&mut st, &self.agent_id, kinds);
        if mute {
            if let Some(run) = st.agents.get_mut(&self.agent_id) {
                run.muted = true;
            }
        }
    }
}

impl CancelSink for CancelBridge {
    fn interrupt(&self) {
        let Some(inner) = self.inner.upgrade() else { return };
        let plan = inner.cfg.cancel;
        let body = json!({"agentId": self.agent_id, "softMs": plan.soft.as_millis() as u64, "termMs": plan.term.as_millis() as u64});
        let _ = self.sidecar.request("cancel/request", body, Duration::from_secs(2));
    }

    fn cancel_permissions(&self, ids: &[String]) {
        self.synth(
            |run| ids.iter().filter(|id| run.state.perms.contains_key(*id)).map(|id| EventKind::PermissionResolved { req_id: id.clone(), outcome: PermissionOutcome::Cancelled, by: DecidedBy::User }).collect(),
            false,
        );
    }

    fn cancel_tools(&self, ids: &[String]) {
        self.synth(
            |run| ids.iter().filter(|id| run.state.open_tools.contains(*id)).map(|id| EventKind::ToolResult { tool_id: id.clone(), status: ToolStatus::Cancelled, output: None, diff: None, duration_ms: None }).collect(),
            false,
        );
    }

    fn turn_end(&self) {
        self.synth(|run| if run.state.turn_open { vec![EventKind::TurnEnd { stop_reason: StopReason::Cancelled }] } else { Vec::new() }, true);
    }
}

/// Longest prompt (bytes) the host forwards to a sidecar.
pub const MAX_PROMPT_BYTES: usize = 256 * 1024;

fn check_prompt_size(text: &str) -> Result<(), EngineError> {
    if text.len() > MAX_PROMPT_BYTES {
        return Err(err("promptTooLong", format!("the prompt is {} KB; the limit is {} KB", text.len() / 1024, MAX_PROMPT_BYTES / 1024)));
    }
    Ok(())
}

/// `git ls-files` of a repo filtered by `query` (case-insensitive substring, basename matches first), without files
/// the guard would refuse to add. Feeds the composer's `@file` picker.
pub fn repo_files(git: &Path, repo: &Path, query: &str, limit: usize) -> Vec<String> {
    let mut cmd = Command::new(git);
    // no fsmonitor program, no lock, no inherited GIT_DIR / GIT_INDEX_FILE ...: the same hardening the engine's runner applies
    cmd.args(["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    for (k, _) in std::env::vars_os().filter(|(k, _)| k.to_string_lossy().starts_with("GIT_")) {
        cmd.env_remove(k);
    }
    let Ok(out) = cmd.env("GIT_TERMINAL_PROMPT", "0").current_dir(repo).output() else {
        return Vec::new();
    };
    let q = query.to_lowercase();
    let mut hits: Vec<(u8, usize, String)> = out
        .stdout
        .split(|b| *b == 0)
        .filter_map(|p| std::str::from_utf8(p).ok())
        .filter(|p| !p.is_empty() && intely_core::guard::classify(p, true, None) == intely_core::GuardState::Ok)
        .filter_map(|p| {
            let lower = p.to_lowercase();
            if q.is_empty() {
                return Some((2, p.len(), p.to_string()));
            }
            let name = lower.rsplit('/').next().unwrap_or(&lower);
            let rank = if name.starts_with(&q) {
                0
            } else if lower.contains(&q) {
                1
            } else {
                return None;
            };
            Some((rank, p.len(), p.to_string()))
        })
        .collect();
    hits.sort();
    hits.into_iter().take(limit).map(|(_, _, p)| p).collect()
}
