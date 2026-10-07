//! The run supervisor on top of `intely-agent-host`. The host owns the sidecar and the gate (at most 3 live agents,
//! 2 writers, one write lease per repo, idle reaper, cancel escalation); the supervisor adds what the Runs views need:
//!
//! * a FIFO queue instead of a refusal when a writer meets a busy repo (or all slots are busy),
//! * role resolution from files and the overlay, with the repo scope check,
//! * run records, resume, fork and adoption of transcripts started elsewhere,
//! * history: IDE runs (JSONL event logs) merged with the Claude transcript store (through the sidecar),
//! * the usage ledger and Rewind with an explicit confirmation.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use intely_agent_core::api::{AgentStartRequest, AgentSummary, AutoInfo, AutoQueue, RoleInfo, RunStatus};
use intely_agent_core::events::types::{AgentEvent, EventKind};
use intely_agent_core::providers::{Effort, PermissionMode};
use intely_agent_gate::rewind::Rewind;
use intely_agent_host::roles::{RoleDef, AUTO_ROLE};
use intely_agent_host::run::Meta;
use intely_agent_host::{AgentHost, HostSink, RepoRef, StartOptions};
use intely_core::jail::Jail;
use intely_core::EngineError;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::ledger::Ledger;
use crate::store::RoleStore;
use crate::types::{
    AdoptOptions, HistoryEntry, HistoryQuery, HistoryScope, HistorySource, RewindSnapshotInfo, Role, RoleEffort, RunRecord, RunState, RunsStartRequest, UsageSummary,
    UsageTotals,
};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn err(code: &str, message: impl Into<String>) -> EngineError {
    EngineError::new(code, message)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

const SIDECAR_TIMEOUT: Duration = Duration::from_secs(30);
const SESSION_PREFIX: &str = "session:";
const QUEUE_PREFIX: &str = "q-";
const DEFAULT_HISTORY: usize = 200;
const SEARCHED_RUNS: usize = 200;

pub struct SupervisorConfig {
    /// The host's data dir: `supervisor.json` (tags, fork parents) and `usage-ledger.json` live here.
    pub data_dir: PathBuf,
    pub git: PathBuf,
}

/// What the host's event log cannot say about a run; persisted in `supervisor.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Extra {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    forked_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

struct Queued {
    id: String,
    def: RoleDef,
    req: RunsStartRequest,
    repos: Vec<RepoRef>,
    enqueued_at: u64,
    note: String,
}

#[derive(Default)]
struct State {
    queue: VecDeque<Queued>,
    next_queue_id: u64,
    extras: BTreeMap<String, Extra>,
    /// Queued runs that could not start (the reason is shown instead of silently dropping them).
    dropped: VecDeque<RunRecord>,
}

struct Inner {
    host: AgentHost,
    roles: Arc<RoleStore>,
    rewind: Rewind,
    data_dir: PathBuf,
    ledger: Mutex<Ledger>,
    state: Mutex<State>,
    /// Serialises starts, adoptions and queue drains: admission is decided on a stable view of the leases.
    start: Mutex<()>,
}

#[derive(Clone)]
pub struct Supervisor {
    inner: Arc<Inner>,
}

/// Sits between the host and the real sink: feeds usage into the ledger and wakes the queue when a turn ends.
/// Create it first (the host needs a sink at construction), hand it to the host, then build the [`Supervisor`].
pub struct Observer {
    next: Arc<dyn HostSink>,
    sup: OnceLock<Weak<Inner>>,
}

impl Observer {
    pub fn new(next: Arc<dyn HostSink>) -> Arc<Self> {
        Arc::new(Self { next, sup: OnceLock::new() })
    }
}

impl HostSink for Observer {
    fn events(&self, events: Vec<AgentEvent>) {
        // called with the host's state lock held: only the supervisor's own locks may be taken here, never the host
        if let Some(inner) = self.sup.get().and_then(Weak::upgrade) {
            let mut wake = false;
            for e in &events {
                match &e.kind {
                    EventKind::Usage { usage } => lock(&inner.ledger).record(&e.agent_id, usage, e.ts),
                    EventKind::TurnEnd { .. } => wake = true,
                    _ => {}
                }
            }
            if wake && !lock(&inner.state).queue.is_empty() {
                std::thread::spawn(move || inner.drain());
            }
        }
        self.next.events(events);
    }
}

impl Supervisor {
    pub fn new(host: AgentHost, roles: Arc<RoleStore>, cfg: SupervisorConfig, observer: Option<&Observer>) -> Self {
        let extras = std::fs::read(cfg.data_dir.join("supervisor.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let inner = Arc::new(Inner {
            host,
            roles,
            rewind: Rewind::new(cfg.git),
            ledger: Mutex::new(Ledger::open(cfg.data_dir.join("usage-ledger.json"))),
            data_dir: cfg.data_dir,
            state: Mutex::new(State { extras, ..State::default() }),
            start: Mutex::new(()),
        });
        if let Some(o) = observer {
            let _ = o.sup.set(Arc::downgrade(&inner));
        }
        Self { inner }
    }

    pub fn host(&self) -> &AgentHost {
        &self.inner.host
    }

    pub fn roles(&self) -> &Arc<RoleStore> {
        &self.inner.roles
    }

    /// Starts a run, or queues it behind the writer (or the full slots) that block it.
    pub fn start(&self, req: RunsStartRequest, repos: &[RepoRef]) -> Result<RunRecord, EngineError> {
        let inner = &self.inner;
        let primary = req.repo_ids.first().cloned().ok_or_else(|| err("noRepo", "pick at least one repository"))?;
        let (def, role) = inner.resolve(&req.role_id, Some(&primary), repos)?;
        if let Some(role) = &role {
            if let Some(out) = req.repo_ids.iter().find(|r| !role.repo_scope.is_empty() && !role.repo_scope.contains(r)) {
                return Err(err("outOfScope", format!("role {} may not run on repository {out}", role.name)));
            }
        }
        if req.prompt.trim().is_empty() {
            return Err(err("emptyPrompt", "write a prompt first"));
        }
        // The queue, tray quick actions and scripts have no dialog: `bypass` is refused here instead of failing at dequeue time with nobody
        // to show it to, and `automatic` while the kill switch is on (permission-modes spec 4.4, GZ-25).
        let mode = req.mode.unwrap_or(def.permission);
        if mode == PermissionMode::Bypass {
            return Err(err("bypassNotConfirmed", "Bypass needs the confirmation of the New run dialog; a queued or scripted run cannot use it"));
        }
        if mode.is_unattended() && inner.host.unattended_disabled() {
            return Err(err("modeDisabled", "automatic mode is switched off on this installation"));
        }
        if !intely_agent_core::providers::supported_modes(&def.provider).contains(&mode) {
            return Err(err("modeNotSupported", format!("{} cannot start in that mode", def.provider)));
        }
        let _g = lock(&inner.start);
        if let Some(why) = inner.blocked(&def, &primary, mode) {
            return Ok(inner.enqueue(def, req, repos, why));
        }
        match inner.try_start(&def, &req, repos) {
            Err(e) if matches!(e.code.as_str(), "writeLease" | "noSlot") => Ok(inner.enqueue(def, req, repos, e.message)),
            other => other,
        }
    }

    /// Starts a run immediately for the chat UI, which tracks a live agent: no queue, so a busy repo or a full slot
    /// comes back as the host's error. Roles resolve through the role files and the overlay, scope included.
    pub fn start_now(&self, req: AgentStartRequest, repos: &[RepoRef]) -> Result<AgentSummary, EngineError> {
        self.start_now_with(req, repos, StartOptions::default())
    }

    /// [`Self::start_now`] with per-run options: `run_without_safety_net` lets the run start when Rewind cannot snapshot.
    pub fn start_now_with(&self, req: AgentStartRequest, repos: &[RepoRef], opts: StartOptions) -> Result<AgentSummary, EngineError> {
        let inner = &self.inner;
        let primary = req.repo_ids.first().cloned().ok_or_else(|| err("noRepo", "pick at least one repository"))?;
        let (def, role) = inner.resolve(&req.role, Some(&primary), repos)?;
        if let Some(role) = &role {
            if let Some(out) = req.repo_ids.iter().find(|r| !role.repo_scope.is_empty() && !role.repo_scope.contains(r)) {
                return Err(err("outOfScope", format!("role {} may not run on repository {out}", role.name)));
            }
        }
        let _g = lock(&inner.start);
        inner.host.start_role_with(&def, req, repos, opts)
    }

    /// The roles the "Run as role..." picker offers, one per name, from the same groups the Roles table shows: the host's
    /// built-ins, replaced by the winner of a role file of the same name, plus the file roles that have no built-in. Hidden
    /// groups, groups whose winner is an untrusted repository copy, and `auto` (it is not a role to pick) are absent.
    pub fn role_infos(&self, repos: &[RepoRef]) -> Vec<RoleInfo> {
        let host = &self.inner.host;
        let mut infos = host.roles(repos);
        for g in self.inner.roles.groups(repos) {
            if g.name.eq_ignore_ascii_case(AUTO_ROLE) {
                continue;
            }
            let same = |i: &RoleInfo| i.name.eq_ignore_ascii_case(&g.name);
            if g.hidden || g.role.trust == crate::types::RoleTrust::Untrusted {
                infos.retain(|i| !same(i));
                continue;
            }
            if g.role.builtin {
                continue; // the host's own entry stands
            }
            let info = host.role_info(&RoleStore::role_def(&g.role), repos);
            match infos.iter_mut().find(|i| same(i)) {
                Some(slot) => *slot = info,
                None => infos.push(info),
            }
        }
        infos
    }

    /// What an Auto run on these repositories would do (`agents_auto_info`): the lead, the delegates and the exclusions from the
    /// same resolver the start uses, the budget, and the queue reason when another run is writing to the primary repository.
    /// The caller adds what it knows about Claude itself (disabled, not installed, not logged in).
    pub fn auto_info(&self, repo_ids: &[String], repos: &[RepoRef], mode: Option<PermissionMode>) -> AutoInfo {
        let scope: Vec<RepoRef> = repo_ids.iter().filter_map(|id| repos.iter().find(|r| &r.id == id).cloned()).collect();
        let queue = repo_ids.first().and_then(|primary| {
            let lead = self.inner.host.find_role(AUTO_ROLE, &scope)?;
            // the mode only decides whether the run would write (Plan and Ask do not take the writer lease)
            self.inner.blocker(&lead, primary, mode.unwrap_or(lead.permission))
        });
        self.inner.host.auto_info(&scope, queue)
    }

    /// All runs the host knows plus the queued ones, newest first.
    pub fn list(&self) -> Vec<RunRecord> {
        self.inner.records()
    }

    /// Re-opens the session of an IDE run, or adopts a transcript found by `history` (`session:<uuid>`).
    pub fn resume(&self, id: &str, opts: &AdoptOptions, repos: &[RepoRef]) -> Result<RunRecord, EngineError> {
        let inner = &self.inner;
        if id.starts_with(QUEUE_PREFIX) {
            return Err(err("queued", "this run is still waiting for a free slot"));
        }
        let _g = lock(&inner.start);
        if let Some(session) = id.strip_prefix(SESSION_PREFIX) {
            let info = inner.external_session(session)?;
            let (def, scope) = inner.adopt_target(opts, None, info.cwd.as_deref(), repos)?;
            return inner.adopt(&def, scope, session, Extra::default(), None);
        }
        let meta = inner.meta_of(id)?;
        let def = inner.host.find_role(&meta.role, &meta.repos).ok_or_else(|| err("unknownRole", format!("no role named {}", meta.role)))?;
        if !inner.is_live(id) {
            if let Some(why) = inner.blocked(&def, meta.repos.first().map_or("", |r| r.id.as_str()), meta.permission.resume_mode()) {
                return Err(err("busy", why));
            }
        }
        inner.host.resume(id)?;
        inner.records().into_iter().find(|r| r.agent_id == id).ok_or_else(|| err("unknownAgent", format!("no run {id}")))
    }

    /// Copies the transcript (optionally up to a message) into a new session and opens it as a new run.
    pub fn fork(&self, id: &str, opts: &AdoptOptions, repos: &[RepoRef]) -> Result<RunRecord, EngineError> {
        let inner = &self.inner;
        let _g = lock(&inner.start);
        let (session, cwd, title, original) = if let Some(session) = id.strip_prefix(SESSION_PREFIX) {
            let info = inner.external_session(session)?;
            (session.to_string(), info.cwd.clone(), info.title(), None)
        } else {
            let meta = inner.meta_of(id)?;
            let session = meta.native_id.clone().ok_or_else(|| err("noSession", "this run has no provider session to fork yet"))?;
            let title = inner.records().into_iter().find(|r| r.agent_id == id).map(|r| r.title).unwrap_or_default();
            (session, meta.repos.first().map(|r| r.path.to_string_lossy().into_owned()), title, Some((meta.role.clone(), meta.repos.clone())))
        };
        let (def, scope) = inner.adopt_target(opts, original.as_ref().map(|(r, p)| (r.as_str(), p.as_slice())), cwd.as_deref(), repos)?;
        let title = format!("{title} (fork)");
        let mut body = json!({"sessionId": session, "title": title});
        if let Some(dir) = &cwd {
            body["dir"] = json!(dir);
        }
        if let Some(m) = &opts.up_to_message_id {
            body["upToMessageId"] = json!(m);
        }
        let reply = inner.host.sidecar_request("history/fork", body, SIDECAR_TIMEOUT)?;
        let forked = match reply["sessionId"].as_str() {
            Some(s) => s.to_string(),
            None => return Err(err(reply["error"].as_str().unwrap_or("fork"), reply["detail"].as_str().unwrap_or("the fork failed").to_string())),
        };
        let parent_total = lock(&inner.ledger).total_of(id);
        let extra = Extra { forked_from: Some(id.to_string()), tag: None, title: Some(title) };
        inner.adopt(&def, scope, &forked, extra, Some(parent_total))
    }

    /// Stops a running run (the escalation SIGTERM/SIGKILL belongs to the host) or removes a queued one.
    pub fn stop(&self, id: &str) -> Result<(), EngineError> {
        let inner = &self.inner;
        if id.starts_with(QUEUE_PREFIX) {
            let mut st = lock(&inner.state);
            let before = st.queue.len();
            st.queue.retain(|q| q.id != id);
            return if st.queue.len() < before { Ok(()) } else { Err(err("unknownAgent", format!("no queued run {id}"))) };
        }
        inner.host.interrupt(id)
    }

    /// Sets (or with `None` clears) a tag on a run or a transcript; the Claude transcript store gets it too.
    pub fn tag(&self, id: &str, tag: Option<&str>) -> Result<(), EngineError> {
        let inner = &self.inner;
        let tag = tag.map(str::trim).filter(|t| !t.is_empty()).map(|t| t.chars().take(64).collect::<String>());
        let session = match id.strip_prefix(SESSION_PREFIX) {
            Some(s) => Some((s.to_string(), None)),
            None => inner.meta_of(id).ok().and_then(|m| m.native_id.map(|n| (n, m.repos.first().map(|r| r.path.to_string_lossy().into_owned())))),
        };
        {
            let mut st = lock(&inner.state);
            st.extras.entry(id.to_string()).or_default().tag = tag.clone();
            inner.save_extras(&st);
        }
        if let Some((session_id, dir)) = session {
            let mut body = json!({"sessionId": session_id, "tag": tag});
            if let Some(d) = dir {
                body["dir"] = json!(d);
            }
            // best effort: the session file may not exist yet (nothing was said), the local tag is kept either way
            if let Err(e) = inner.host.sidecar_request("history/tag", body, SIDECAR_TIMEOUT) {
                eprintln!("supervisor: transcript tag not stored: {e}");
            }
        }
        Ok(())
    }

    /// IDE runs and transcripts from the Claude store, one row each, newest first.
    pub fn history(&self, q: &HistoryQuery, repos: &[RepoRef]) -> Vec<HistoryEntry> {
        self.inner.history(q, repos)
    }

    pub fn usage(&self) -> UsageSummary {
        lock(&self.inner.ledger).summary()
    }

    /// The snapshots taken before the run, with what restoring each would change now.
    pub fn rewind_snapshots(&self, run_id: &str) -> Result<Vec<RewindSnapshotInfo>, EngineError> {
        let inner = &self.inner;
        let meta = inner.meta_of(run_id)?;
        let mut out = Vec::new();
        for s in &meta.snapshots {
            let Some(info) = inner.rewind.list(&s.path).ok().and_then(|l| l.into_iter().find(|i| i.run_id == run_id)) else { continue };
            let plan = inner.rewind.plan_restore(&s.path, run_id).map_err(|e| err("rewind", format!("{}: {e}", s.repo_id)))?;
            out.push(RewindSnapshotInfo {
                run_id: run_id.into(),
                repo_id: s.repo_id.clone(),
                taken_at: info.created_at as f64,
                files: info.files as f64,
                skipped: info.skipped.len() as f64,
                overwrite: plan.overwrite,
                recreate: plan.recreate,
                delete: plan.delete,
                index_differs: plan.index_differs,
                head_changed: plan.head_changed,
            });
        }
        Ok(out)
    }

    /// Puts the working trees back to before the run (only `only_repo` if given). Does nothing unless `confirm` is true, and never while the run works.
    pub fn rewind_restore(&self, run_id: &str, confirm: bool, only_repo: Option<&str>) -> Result<(), EngineError> {
        let inner = &self.inner;
        if !confirm {
            return Err(err("confirmRequired", "restoring overwrites files; review the snapshot and confirm"));
        }
        let meta = inner.meta_of(run_id)?;
        if inner.records().iter().any(|r| r.agent_id == run_id && matches!(r.status, RunState::Running | RunState::NeedsYou)) {
            return Err(err("agentRunning", "stop the agent before rewinding"));
        }
        let snapshots: Vec<_> = meta.snapshots.iter().filter(|s| only_repo.map_or(true, |r| s.repo_id == r)).collect();
        if snapshots.is_empty() {
            return Err(err("noSnapshot", "no Rewind snapshot was taken for this run"));
        }
        for s in &snapshots {
            Jail::global().check_op("agent rewind", &s.path)?;
        }
        let mut failures = Vec::new();
        for s in &snapshots {
            if let Err(e) = inner.rewind.restore(&s.path, run_id, true) {
                failures.push(format!("{}: {e}", s.repo_id));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(err("rewind", failures.join("; ")))
        }
    }
}

/// One session of the Claude transcript store, as the sidecar reports it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    session_id: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    last_modified: f64,
    #[serde(default)]
    created_at: Option<f64>,
    #[serde(default)]
    custom_title: Option<String>,
    #[serde(default)]
    first_prompt: Option<String>,
    #[serde(default)]
    git_branch: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    tag: Option<String>,
}

impl SessionInfo {
    fn title(&self) -> String {
        self.custom_title.clone().filter(|t| !t.is_empty()).or_else(|| Some(self.summary.clone()).filter(|t| !t.is_empty())).or_else(|| self.first_prompt.clone()).unwrap_or_else(|| "Session".into())
    }
}

fn state_of(s: RunStatus) -> RunState {
    match s {
        RunStatus::Running => RunState::Running,
        RunStatus::NeedsYou => RunState::NeedsYou,
        RunStatus::Done => RunState::Done,
        RunStatus::Error => RunState::Error,
    }
}

fn effort_of(e: Effort) -> RoleEffort {
    match e {
        Effort::Low => RoleEffort::Low,
        Effort::Medium => RoleEffort::Medium,
        Effort::High => RoleEffort::High,
        Effort::Xhigh => RoleEffort::Xhigh,
        Effort::Max => RoleEffort::Max,
    }
}

fn under(root: &Path, cwd: &str) -> bool {
    Path::new(cwd).starts_with(root)
}

impl Inner {
    /// The role as the host starts it, and the file role it came from (`None` for a built-in such as the mock roles).
    fn resolve(&self, id_or_name: &str, primary: Option<&str>, repos: &[RepoRef]) -> Result<(RoleDef, Option<Role>), EngineError> {
        // `auto` is reserved: the lead as the settings configure it now, never a file (its delegates are resolved when the session opens)
        if id_or_name == AUTO_ROLE {
            return self.host.find_role(AUTO_ROLE, repos).map(|d| (d, None)).ok_or_else(|| err("unknownRole", "no role named auto"));
        }
        match self.roles.resolve_checked(id_or_name, primary, repos, false) {
            Ok(role) => return Ok((RoleStore::role_def(&role), Some(role))),
            // the host's role resolver also answers hidden roles (resume keeps working), so a NEW run must not fall through to it
            Err(e) if e.message.ends_with(" is hidden") || e.message.contains("untrusted repository role") => return Err(err("unknownRole", e.message)),
            Err(_) => {}
        }
        self.host.find_role(id_or_name, repos).map(|d| (d, None)).ok_or_else(|| err("unknownRole", format!("no role named {id_or_name}")))
    }

    /// [`Self::blocked`] as data, for the New run card: which run (or which limit) a start would wait for.
    fn blocker(&self, _def: &RoleDef, primary_repo: &str, mode: PermissionMode) -> Option<AutoQueue> {
        let cfg = self.host.gate().config();
        let busy: Vec<_> = self.host.leases().into_iter().filter(|l| l.busy).collect();
        if mode.is_writer() {
            if let Some(l) = busy.iter().find(|l| l.writer && l.repo_id.as_deref() == Some(primary_repo)) {
                let title = self.host.list().into_iter().find(|s| s.agent_id == l.agent_id).map(|s| s.title).unwrap_or_default();
                return Some(AutoQueue { kind: "repoWriter".into(), agent_id: l.agent_id.clone(), title });
            }
            if busy.iter().filter(|l| l.writer).count() >= cfg.max_writers {
                return Some(AutoQueue { kind: "writers".into(), agent_id: String::new(), title: String::new() });
            }
        }
        (busy.len() >= cfg.max_agents).then(|| AutoQueue { kind: "slots".into(), agent_id: String::new(), title: String::new() })
    }

    fn meta_of(&self, id: &str) -> Result<Meta, EngineError> {
        self.host.metas().into_iter().find(|m| m.agent_id == id).ok_or_else(|| err("unknownAgent", format!("no run {id}")))
    }

    fn is_live(&self, agent_id: &str) -> bool {
        self.host.leases().iter().any(|l| l.agent_id == agent_id)
    }

    /// Why a start would be refused right now (a busy writer on the repo, all writer or agent slots busy), if it would.
    /// Idle sessions do not count: the host reclaims them to make room.
    fn blocked(&self, _def: &RoleDef, primary_repo: &str, mode: PermissionMode) -> Option<String> {
        let cfg = self.host.gate().config();
        let busy: Vec<_> = self.host.leases().into_iter().filter(|l| l.busy).collect();
        if mode.is_writer() {
            if let Some(l) = busy.iter().find(|l| l.writer && l.repo_id.as_deref() == Some(primary_repo)) {
                return Some(format!("waiting for {} to finish writing to this repository", l.agent_id));
            }
            if busy.iter().filter(|l| l.writer).count() >= cfg.max_writers {
                return Some(format!("{} writers are working; waiting for one to finish", cfg.max_writers));
            }
        }
        (busy.len() >= cfg.max_agents).then(|| format!("{} agents are working; waiting for a free slot", cfg.max_agents))
    }

    fn enqueue(&self, def: RoleDef, req: RunsStartRequest, repos: &[RepoRef], note: String) -> RunRecord {
        let mut st = lock(&self.state);
        st.next_queue_id += 1;
        let q = Queued { id: format!("{QUEUE_PREFIX}{}", st.next_queue_id), def, req, repos: repos.to_vec(), enqueued_at: now_ms(), note };
        let rec = self.queued_record(&q);
        st.queue.push_back(q);
        rec
    }

    fn queued_record(&self, q: &Queued) -> RunRecord {
        let cwd = q.req.repo_ids.first().and_then(|id| q.repos.iter().find(|r| &r.id == id)).map(|r| r.path.to_string_lossy().into_owned()).unwrap_or_default();
        RunRecord {
            agent_id: q.id.clone(),
            session_id: None,
            role: q.def.name.clone(),
            model: q.def.model.clone(),
            effort: q.def.effort.map(effort_of),
            cwd,
            repo_ids: q.req.repo_ids.clone(),
            started_at: q.enqueued_at as f64,
            status: RunState::Queued,
            title: q.req.prompt.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().chars().take(60).collect(),
            forked_from: None,
            tag: None,
            note: Some(q.note.clone()),
        }
    }

    fn try_start(&self, def: &RoleDef, req: &RunsStartRequest, repos: &[RepoRef]) -> Result<RunRecord, EngineError> {
        let summary = self.host.start_role(def, AgentStartRequest { role: def.name.clone(), repo_ids: req.repo_ids.clone(), prompt: req.prompt.clone(), mode: req.mode, mcp_servers: None }, repos)?;
        self.await_busy(&summary.agent_id);
        self.records().into_iter().find(|r| r.agent_id == summary.agent_id).ok_or_else(|| err("internal", "the run vanished while starting"))
    }

    /// A lease is idle until the first `user.message` arrives; the next admission must see this run as working.
    fn await_busy(&self, agent_id: &str) {
        let deadline = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < deadline {
            if self.host.leases().iter().any(|l| l.agent_id == agent_id && l.busy) {
                return;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
    }

    /// Starts every queued run that is no longer blocked, oldest first.
    fn drain(self: Arc<Self>) {
        let _g = lock(&self.start);
        loop {
            let next = {
                let mut st = lock(&self.state);
                let pos = st.queue.iter().position(|q| self.blocked(&q.def, q.req.repo_ids.first().map_or("", String::as_str), q.req.mode.unwrap_or(q.def.permission)).is_none());
                pos.and_then(|i| st.queue.remove(i))
            };
            let Some(mut q) = next else { return };
            // An Auto run waited behind a writer: it leaves the queue with the lead settings of NOW (its delegates are always
            // resolved when the session opens, so they are the current files' too, not the ones at enqueue time).
            if q.def.name == AUTO_ROLE {
                if let Some(fresh) = self.host.find_role(AUTO_ROLE, &q.repos) {
                    q.def = fresh;
                }
            }
            match self.try_start(&q.def, &q.req, &q.repos) {
                Ok(_) => {}
                Err(e) if matches!(e.code.as_str(), "writeLease" | "noSlot") => {
                    let mut again = q;
                    again.note = e.message;
                    lock(&self.state).queue.push_front(again);
                    return;
                }
                Err(e) => {
                    let mut rec = self.queued_record(&q);
                    rec.status = RunState::Error;
                    rec.note = Some(format!("could not start: {}", e.message));
                    let mut st = lock(&self.state);
                    st.dropped.push_back(rec);
                    while st.dropped.len() > 20 {
                        st.dropped.pop_front();
                    }
                }
            }
        }
    }

    /// Role and repos for resuming or forking: the options, else the original run's, else `developer` and the repo
    /// that contains the transcript's working directory.
    fn adopt_target(&self, opts: &AdoptOptions, original: Option<(&str, &[RepoRef])>, cwd: Option<&str>, repos: &[RepoRef]) -> Result<(RoleDef, Vec<RepoRef>), EngineError> {
        let scope: Vec<RepoRef> = match (&opts.repo_ids, original) {
            (Some(ids), _) => ids.iter().map(|id| repos.iter().find(|r| &r.id == id).cloned().ok_or_else(|| err("unknownRepo", format!("unknown repository {id}")))).collect::<Result<_, _>>()?,
            (None, Some((_, r))) if !r.is_empty() => r.to_vec(),
            _ => cwd.and_then(|c| repos.iter().find(|r| under(&r.path, c))).cloned().into_iter().collect(),
        };
        if scope.is_empty() {
            return Err(err("unknownRepo", "this session's folder is not one of the registered repositories; pick the repositories to run it on"));
        }
        let name = opts.role_id.as_deref().or(original.map(|(r, _)| r)).unwrap_or("developer");
        let (def, role) = self.resolve(name, scope.first().map(|r| r.id.as_str()), repos)?;
        if let Some(role) = role.filter(|r| !r.repo_scope.is_empty()) {
            if let Some(out) = scope.iter().find(|r| !role.repo_scope.contains(&r.id)) {
                return Err(err("outOfScope", format!("role {} may not run on repository {}", role.name, out.id)));
            }
        }
        Ok((def, scope))
    }

    /// `parent_total`: `None` for a plain resume of a transcript, `Some(known or unknown total)` for a fork.
    fn adopt(&self, def: &RoleDef, repos: Vec<RepoRef>, native_id: &str, extra: Extra, parent_total: Option<Option<UsageTotals>>) -> Result<RunRecord, EngineError> {
        if let Some(why) = self.blocked(def, repos.first().map_or("", |r| r.id.as_str()), def.permission) {
            return Err(err("busy", why));
        }
        let summary = self.host.adopt(def, repos, native_id)?;
        let id = summary.agent_id.clone();
        // the session continues a transcript that was already paid for: that spend stays where it was booked
        lock(&self.ledger).continues(&id, parent_total.flatten());
        if extra.forked_from.is_some() || extra.title.is_some() {
            let mut st = lock(&self.state);
            st.extras.insert(id.clone(), extra);
            self.save_extras(&st);
        }
        self.records().into_iter().find(|r| r.agent_id == id).ok_or_else(|| err("internal", "the run vanished while starting"))
    }

    fn save_extras(&self, st: &State) {
        let path = self.data_dir.join("supervisor.json");
        let write = || -> std::io::Result<()> {
            std::fs::create_dir_all(&self.data_dir)?;
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_vec_pretty(&st.extras).map_err(std::io::Error::other)?)?;
            std::fs::rename(&tmp, &path)
        };
        if let Err(e) = write() {
            eprintln!("supervisor: cannot write {}: {e}", path.display());
        }
    }

    fn records(&self) -> Vec<RunRecord> {
        let metas: HashMap<String, Meta> = self.host.metas().into_iter().map(|m| (m.agent_id.clone(), m)).collect();
        let st = lock(&self.state);
        let mut out: Vec<RunRecord> = self
            .host
            .list()
            .into_iter()
            .map(|s: AgentSummary| {
                let meta = metas.get(&s.agent_id);
                let extra = st.extras.get(&s.agent_id);
                // an adopted run has no events yet, its title is the transcript's
                let title = match extra.and_then(|e| e.title.clone()) {
                    Some(t) if s.title == s.role => t,
                    _ => s.title,
                };
                RunRecord {
                    session_id: meta.and_then(|m| m.native_id.clone()),
                    role: s.role,
                    model: s.model,
                    effort: s.effective.as_ref().and_then(|e| e.effort).or(s.requested.effort).map(effort_of),
                    cwd: meta.and_then(|m| m.repos.first()).map(|r| r.path.to_string_lossy().into_owned()).unwrap_or_default(),
                    repo_ids: s.repo_ids,
                    started_at: s.started_at as f64,
                    status: state_of(s.status),
                    title,
                    forked_from: extra.and_then(|e| e.forked_from.clone()),
                    tag: extra.and_then(|e| e.tag.clone()),
                    note: None,
                    agent_id: s.agent_id,
                }
            })
            .collect();
        out.extend(st.queue.iter().map(|q| self.queued_record(q)));
        out.extend(st.dropped.iter().cloned());
        out.sort_by(|a, b| b.started_at.total_cmp(&a.started_at).then_with(|| a.agent_id.cmp(&b.agent_id)));
        out
    }

    fn sessions(&self, dir: Option<&Path>) -> Result<Vec<SessionInfo>, EngineError> {
        let mut body = json!({"limit": 500});
        if let Some(d) = dir {
            body["dir"] = json!(d.to_string_lossy());
        }
        let reply = self.host.sidecar_request("history/list", body, SIDECAR_TIMEOUT)?;
        match reply["sessions"].as_array() {
            Some(list) => Ok(list.iter().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect()),
            None => Err(err(reply["error"].as_str().unwrap_or("history"), reply["detail"].as_str().unwrap_or("the transcript store could not be read").to_string())),
        }
    }

    fn external_session(&self, session_id: &str) -> Result<SessionInfo, EngineError> {
        self.sessions(None)?.into_iter().find(|s| s.session_id == session_id).ok_or_else(|| err("unknownSession", format!("no transcript {session_id}")))
    }

    fn history(&self, q: &HistoryQuery, repos: &[RepoRef]) -> Vec<HistoryEntry> {
        let mut entries: Vec<HistoryEntry> = self
            .records()
            .into_iter()
            .filter(|r| r.status != RunState::Queued)
            .map(|r| HistoryEntry {
                id: r.agent_id,
                session_id: r.session_id,
                source: HistorySource::Ide,
                title: r.title,
                role: Some(r.role),
                model: Some(r.model),
                cwd: Some(r.cwd).filter(|c| !c.is_empty()),
                repo_ids: r.repo_ids,
                started_at: r.started_at,
                last_modified: r.started_at,
                status: Some(r.status),
                tag: r.tag,
                first_prompt: None,
                git_branch: None,
            })
            .collect();
        let mut seen: Vec<SessionInfo> = Vec::new();
        let mut collect = |res: Result<Vec<SessionInfo>, EngineError>| match res {
            Ok(list) => list.into_iter().for_each(|s| {
                if !seen.iter().any(|x| x.session_id == s.session_id) {
                    seen.push(s);
                }
            }),
            Err(e) => eprintln!("supervisor: transcript history unavailable: {e}"),
        };
        match q.scope.unwrap_or(HistoryScope::Repos) {
            HistoryScope::All => collect(self.sessions(None)),
            HistoryScope::Repos => repos.iter().for_each(|r| collect(self.sessions(Some(&r.path)))),
        }
        for s in seen {
            if let Some(e) = entries.iter_mut().find(|e| e.session_id.as_deref() == Some(s.session_id.as_str())) {
                e.last_modified = e.last_modified.max(s.last_modified);
                e.tag = e.tag.clone().or(s.tag);
                e.first_prompt = s.first_prompt;
                e.git_branch = s.git_branch;
                continue;
            }
            let repo_ids = s.cwd.as_deref().map(|c| repos.iter().filter(|r| under(&r.path, c)).map(|r| r.id.clone()).collect()).unwrap_or_default();
            entries.push(HistoryEntry {
                id: format!("{SESSION_PREFIX}{}", s.session_id),
                title: s.title(),
                session_id: Some(s.session_id),
                source: HistorySource::External,
                role: None,
                model: None,
                started_at: s.created_at.unwrap_or(s.last_modified),
                last_modified: s.last_modified,
                cwd: s.cwd,
                repo_ids,
                status: None,
                tag: s.tag,
                first_prompt: s.first_prompt,
                git_branch: s.git_branch,
            });
        }
        {
            // tags set on a transcript id before it was adopted
            let st = lock(&self.state);
            for e in entries.iter_mut().filter(|e| e.tag.is_none()) {
                e.tag = st.extras.get(&e.id).and_then(|x| x.tag.clone());
            }
        }
        if let Some(tag) = q.tag.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            entries.retain(|e| e.tag.as_deref().is_some_and(|t| t.eq_ignore_ascii_case(tag)));
        }
        entries.sort_by(|a, b| b.last_modified.total_cmp(&a.last_modified).then_with(|| a.id.cmp(&b.id)));
        if let Some(search) = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let terms: Vec<String> = search.to_lowercase().split_whitespace().map(str::to_string).collect();
            let mut read_logs = 0;
            entries.retain(|e| {
                let mut hay = [Some(&e.title), e.role.as_ref(), e.model.as_ref(), e.cwd.as_ref(), e.tag.as_ref(), e.first_prompt.as_ref(), e.git_branch.as_ref()]
                    .into_iter()
                    .flatten()
                    .map(|s| s.to_lowercase())
                    .collect::<Vec<_>>()
                    .join("\n");
                if terms.iter().any(|t| !hay.contains(t.as_str())) && e.source == HistorySource::Ide && read_logs < SEARCHED_RUNS {
                    read_logs += 1;
                    hay.push_str(&self.user_text(&e.id).to_lowercase());
                }
                terms.iter().all(|t| hay.contains(t.as_str()))
            });
        }
        entries.truncate(q.limit.map_or(DEFAULT_HISTORY, |l| l as usize));
        entries
    }

    /// What the user said to an IDE run (from its event log), for the history search.
    fn user_text(&self, agent_id: &str) -> String {
        self.host
            .history(agent_id, None)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|e| match e.kind {
                EventKind::UserMessage { text, .. } => Some(text),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}
