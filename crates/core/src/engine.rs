//! The engine facade: one method per UI command (contract section 4).
//!
//! Every command goes through the actor of the repo it concerns. Runs (commit, push, pull, fetch) are
//! registered by run id so they can be cancelled, and the engine can kill all of them on shutdown.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::{watch, RwLock as AsyncRwLock};

use crate::env::EnvResolver;
use crate::exec::{pinned_git_path, run_git, CancelToken, GitCtx, RunInfo, RunOpts};
use crate::jail::Jail;
use crate::git::{commit, outgoing, pull_fetch, push};
use crate::repo_actor::{BoxFuture, ProcessGate, RepoActor, SnapshotFn};
use crate::workspace::SaveOptions;
use crate::{
    code, diff, guard, jail, status, workspace, ChangedFile, CommitRequest, DiffSource, DoctorRepo, DoctorReport,
    EngineError, EngineStatus, EventSink, Failure, FailureKind, FileContents, FileSelection, GuardState, HookInfo,
    HookKind, Hunk, OpEvent, OpKind, OpResult, OutgoingInfo, PullMode, PushRequest, PushTarget, PushTargetMapping,
    Protection, RepoCommit, RepoConfig, RepoId, RepoOutcome, RepoSnapshot, RunStarted, StepStatus, UntrackedList, Workspace,
};

#[cfg(test)]
mod tests;

/// How long [`Engine::shutdown`] waits for cancelled runs to wind down (their process groups get SIGTERM, then SIGKILL after 3 s).
const SHUTDOWN_GRACE: Duration = Duration::from_secs(6);
/// The same wait during a workspace switch ((design notes: workspaces-spec) 4.10: the engine step has 4 s).
const SWITCH_GRACE: Duration = Duration::from_secs(4);

/// The git-facing operations the engine drives; the real implementation forwards to `status` and `git::*`.
trait Ops: Send + Sync + 'static {
    fn snapshot<'a>(&'a self, ctx: &'a GitCtx, repo: &'a RepoConfig) -> BoxFuture<'a, Result<RepoSnapshot, EngineError>>;
    fn commit<'a>(
        &'a self,
        ctx: &'a GitCtx,
        repo: &'a RepoConfig,
        repo_commit: &'a RepoCommit,
        no_verify: bool,
    ) -> BoxFuture<'a, RepoOutcome>;
    fn push<'a>(
        &'a self,
        ctx: &'a GitCtx,
        repo: &'a RepoConfig,
        target: &'a PushTarget,
        no_verify: bool,
    ) -> BoxFuture<'a, RepoOutcome>;
    fn pull<'a>(&'a self, ctx: &'a GitCtx, repo: &'a RepoConfig, mode: PullMode) -> BoxFuture<'a, RepoOutcome>;
    fn fetch<'a>(&'a self, ctx: &'a GitCtx, repo: &'a RepoConfig) -> BoxFuture<'a, RepoOutcome>;
}

struct GitOps;

impl Ops for GitOps {
    fn snapshot<'a>(&'a self, ctx: &'a GitCtx, repo: &'a RepoConfig) -> BoxFuture<'a, Result<RepoSnapshot, EngineError>> {
        Box::pin(status::snapshot(ctx, repo))
    }

    fn commit<'a>(
        &'a self,
        ctx: &'a GitCtx,
        repo: &'a RepoConfig,
        repo_commit: &'a RepoCommit,
        no_verify: bool,
    ) -> BoxFuture<'a, RepoOutcome> {
        Box::pin(commit::run_commit(ctx, repo, repo_commit, no_verify))
    }

    fn push<'a>(
        &'a self,
        ctx: &'a GitCtx,
        repo: &'a RepoConfig,
        target: &'a PushTarget,
        no_verify: bool,
    ) -> BoxFuture<'a, RepoOutcome> {
        Box::pin(push::run_push(ctx, repo, target, no_verify))
    }

    fn pull<'a>(&'a self, ctx: &'a GitCtx, repo: &'a RepoConfig, mode: PullMode) -> BoxFuture<'a, RepoOutcome> {
        Box::pin(pull_fetch::pull(ctx, repo, mode))
    }

    fn fetch<'a>(&'a self, ctx: &'a GitCtx, repo: &'a RepoConfig) -> BoxFuture<'a, RepoOutcome> {
        Box::pin(pull_fetch::fetch(ctx, repo))
    }
}

#[derive(Clone, Copy)]
enum Lane {
    Write,
    Network,
    WriteNetwork,
}

type Op = Box<dyn FnOnce(GitCtx, RepoConfig) -> BoxFuture<'static, RepoOutcome> + Send>;

#[derive(Clone)]
struct Run {
    id: String,
    kind: OpKind,
    cancel: CancelToken,
}

/// Counts running run coordinators so shutdown can wait for them.
struct Flight(Arc<watch::Sender<usize>>);

impl Flight {
    fn enter(counter: &Arc<watch::Sender<usize>>) -> Self {
        counter.send_modify(|n| *n += 1);
        Self(counter.clone())
    }
}

impl Drop for Flight {
    fn drop(&mut self) {
        self.0.send_modify(|n| *n -= 1);
    }
}

/// Protection that applies to a repository whatever workspace it is opened from ((design notes: workspaces-spec) 4.12, I7).
/// The app passes the registry's `effective_protection`; the engine unions it with the open workspace's own patterns,
/// so a source can only add protection, never remove it.
pub trait ProtectionSource: Send + Sync {
    fn protection(&self, repo_path: &Path) -> Protection;
}

/// What stands in the way of a switch right now.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EngineBusy {
    /// Running commit/push/pull/fetch runs: (run id, kind).
    pub runs: Vec<(String, OpKind)>,
    /// Held [`MutationGuard`]s (graph operations, `gh pr create`), by kind.
    pub guards: Vec<&'static str>,
}

impl EngineBusy {
    pub fn is_empty(&self) -> bool {
        self.runs.is_empty() && self.guards.is_empty()
    }
}

/// Forwards the events of one generation only while it is the live one; a retired generation is silent.
struct GenSink {
    epoch: u64,
    live: Arc<AtomicU64>,
    real: Arc<dyn EventSink>,
}

impl GenSink {
    fn is_live(&self) -> bool {
        self.live.load(Ordering::SeqCst) == self.epoch
    }
}

impl EventSink for GenSink {
    fn snapshot(&self, s: RepoSnapshot) {
        if self.is_live() {
            self.real.snapshot(s);
        }
    }
    fn op_event(&self, e: OpEvent) {
        if self.is_live() {
            self.real.op_event(e);
        }
    }
    fn op_result(&self, r: OpResult) {
        if self.is_live() {
            self.real.op_result(r);
        }
    }
    /// The login environment belongs to the engine, not to a workspace.
    fn env(&self, e: crate::EnvStatus) {
        self.real.env(e);
    }
}

/// What survives a switch.
struct Shared {
    git_path: PathBuf,
    env: Arc<EnvResolver>,
    gate: Arc<ProcessGate>,
    jail: Arc<Jail>,
    sink: Arc<dyn EventSink>,
    /// Epoch of the live generation; also read by every [`GenSink`].
    epoch: Arc<AtomicU64>,
    ops: Arc<dyn Ops>,
    watch: bool,
    protection: Option<Arc<dyn ProtectionSource>>,
    /// Set by [`Engine::begin_switch`] while a switch is under way.
    switching: Arc<AtomicBool>,
}

struct Inner {
    /// `None`: the detached generation (no workspace is open).
    workspace_path: Option<PathBuf>,
    backup_dir: Option<PathBuf>,
    workspace: AsyncRwLock<Workspace>,
    actors: RwLock<HashMap<RepoId, Arc<RepoActor>>>,
    /// Bound to `shutdown`, so even run-less reads (status) are killed with the generation.
    ctx: GitCtx,
    shutdown: CancelToken,
    ops: Arc<dyn Ops>,
    runs: Mutex<HashMap<String, (CancelToken, OpKind)>>,
    in_flight: Arc<watch::Sender<usize>>,
    /// The engine is shutting down (app exit).
    closing: AtomicBool,
    /// A switch replaced this generation; late callers get `workspaceSwitching`.
    retired: AtomicBool,
    /// Start file watchers (off in tests that use fake repos).
    watch: bool,
    switching: Arc<AtomicBool>,
    guards: Mutex<Vec<(u64, &'static str)>>,
    guard_seq: AtomicU64,
    guard_count: AtomicUsize,
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.cancel_everything();
        // A retired generation that a late task still references must not keep actors or file watchers alive.
        if let Ok(actors) = self.actors.get_mut() {
            actors.values().for_each(|a| a.shutdown());
        }
    }
}

/// RAII proof that a mutating operation (rebase, cherry-pick, stash, branch, rollback, hunk staging, `gh pr create`)
/// is in progress: a workspace switch refuses (`workspaceBusy`, blocking `gitOp`) instead of cancelling it half-way.
pub struct MutationGuard {
    inner: Arc<Inner>,
    id: u64,
}

impl Drop for MutationGuard {
    fn drop(&mut self) {
        self.inner.guards.lock().expect("guards lock").retain(|(id, _)| *id != self.id);
        self.inner.guard_count.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Marks a switch as running (a second one gets `workspaceSwitching`); the flag clears when the ticket drops.
pub struct SwitchTicket {
    flag: Arc<AtomicBool>,
}

impl Drop for SwitchTicket {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

pub struct Engine {
    inner: RwLock<Arc<Inner>>,
    shared: Shared,
}

impl Engine {
    /// Must be called inside a tokio runtime context (the engine spawns background tasks).
    /// `workspace_path` is the workspace file; a missing file is an empty workspace (nothing is seeded or written).
    pub fn new(workspace_path: PathBuf, sink: Arc<dyn EventSink>) -> Result<Self, EngineError> {
        Self::new_with_jail(workspace_path, sink, Jail::global())
    }

    /// Like [`Engine::new`] under an explicit safety jail (tests); the app uses the one from the environment.
    pub fn new_with_jail(workspace_path: PathBuf, sink: Arc<dyn EventSink>, jail: Arc<Jail>) -> Result<Self, EngineError> {
        let engine = Self::build_with_jail(workspace_path, sink, Arc::new(GitOps), true, jail)?;
        engine.resolve_env();
        Ok(engine)
    }

    /// The engine of the app: `path` is the workspace file of the registry (or `None`: detached, no workspace open),
    /// `backup_dir` receives `ws-<id>.<ms>.json` copies of structural saves, `protection` is the registry's
    /// effective protection. The file is read and structurally validated (paths are not stat'ed).
    pub fn new_for(
        path: Option<PathBuf>,
        backup_dir: Option<PathBuf>,
        sink: Arc<dyn EventSink>,
        jail: Arc<Jail>,
        protection: Arc<dyn ProtectionSource>,
    ) -> Result<Self, EngineError> {
        let ws = match &path {
            Some(p) => workspace::load_existing(p)?,
            None => workspace::empty(),
        };
        let mut shared = Self::make_shared(sink, Arc::new(GitOps), true, jail);
        shared.protection = Some(protection);
        let engine = Self::from_parts(shared, path, backup_dir, ws);
        engine.resolve_env();
        Ok(engine)
    }

    /// An engine with an empty in-memory workspace and no file: what the app runs while no workspace is open.
    pub fn new_detached(sink: Arc<dyn EventSink>) -> Self {
        Self::new_detached_with_jail(sink, Jail::global())
    }

    pub fn new_detached_with_jail(sink: Arc<dyn EventSink>, jail: Arc<Jail>) -> Self {
        let engine = Self::from_parts(Self::make_shared(sink, Arc::new(GitOps), true, jail), None, None, workspace::empty());
        engine.resolve_env();
        engine
    }

    fn resolve_env(&self) {
        let env = self.shared.env.clone();
        let sink = self.shared.sink.clone();
        tokio::spawn(async move {
            let _ = env.resolve().await;
            sink.env(env.status());
        });
    }

    #[cfg(test)]
    fn build(workspace_path: PathBuf, sink: Arc<dyn EventSink>, ops: Arc<dyn Ops>, watch: bool) -> Result<Self, EngineError> {
        Self::build_with_jail(workspace_path, sink, ops, watch, Jail::global())
    }

    fn build_with_jail(
        workspace_path: PathBuf,
        sink: Arc<dyn EventSink>,
        ops: Arc<dyn Ops>,
        watch: bool,
        jail: Arc<Jail>,
    ) -> Result<Self, EngineError> {
        let ws = workspace::load(&workspace_path)?;
        Ok(Self::from_parts(Self::make_shared(sink, ops, watch, jail), Some(workspace_path), None, ws))
    }

    fn make_shared(sink: Arc<dyn EventSink>, ops: Arc<dyn Ops>, watch: bool, jail: Arc<Jail>) -> Shared {
        let git_path = pinned_git_path();
        let env = Arc::new(EnvResolver::new(&git_path.to_string_lossy()));
        Shared {
            git_path,
            env,
            gate: Arc::new(ProcessGate::default()),
            jail,
            sink,
            epoch: Arc::new(AtomicU64::new(1)),
            ops,
            watch,
            protection: None,
            switching: Arc::new(AtomicBool::new(false)),
        }
    }

    fn from_parts(shared: Shared, path: Option<PathBuf>, backup_dir: Option<PathBuf>, ws: Workspace) -> Self {
        let epoch = shared.epoch.load(Ordering::SeqCst);
        let inner = Arc::new(Inner::generation(&shared, epoch, path, backup_dir, &ws));
        inner.apply_workspace_unchecked(&ws);
        Self { inner: RwLock::new(inner), shared }
    }

    /// The current generation. Every public method calls this exactly once and uses only the result (invariant I10),
    /// so a command can never straddle two generations.
    fn cur(&self) -> Arc<Inner> {
        self.inner.read().expect("generation lock").clone()
    }

    /// Process-wide counter incremented by every switch; events and commands carry it to tell generations apart.
    pub fn epoch(&self) -> u64 {
        self.shared.epoch.load(Ordering::SeqCst)
    }

    /// `true` while no workspace is open.
    pub fn is_detached(&self) -> bool {
        self.cur().workspace_path.is_none()
    }

    /// The workspace file of the current generation.
    pub fn workspace_path(&self) -> Option<PathBuf> {
        self.cur().workspace_path.clone()
    }

    pub async fn workspace_get(&self) -> Result<Workspace, EngineError> {
        let inner = self.cur();
        let ws = inner.workspace.read().await.clone();
        Ok(ws)
    }

    /// Validates that every path is a git work tree. Detached: `noWorkspace`; during a switch: `workspaceSwitching`.
    pub async fn workspace_save(&self, ws: Workspace) -> Result<Workspace, EngineError> {
        let inner = self.cur();
        inner.check_editable()?;
        let path = inner.workspace_path.clone().ok_or_else(no_workspace)?;
        let mut current = inner.workspace.write().await;
        inner.check_editable()?;
        let saved = workspace::save_to(&path, &ws, &SaveOptions { backup_dir: inner.backup_dir.clone() }).await?;
        inner.check_editable()?;
        inner.apply_workspace_unchecked(&saved);
        *current = saved.clone();
        Ok(saved)
    }

    // ---- switching ---------------------------------------------------------------------------------------------

    /// What a switch would refuse over: running git runs and held mutation guards of the current generation.
    pub fn busy(&self) -> EngineBusy {
        self.cur().busy()
    }

    /// Starts a switch. While the ticket lives, runs, mutation guards, saves and push-target edits fail with
    /// `workspaceSwitching`; a second ticket cannot be taken.
    pub fn begin_switch(&self) -> Result<SwitchTicket, EngineError> {
        if self.shared.switching.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err(switching());
        }
        Ok(SwitchTicket { flag: self.shared.switching.clone() })
    }

    /// RAII marker of a mutating operation; fails with `workspaceSwitching` during or after a switch.
    pub fn mutation_guard(&self, kind: &'static str) -> Result<MutationGuard, EngineError> {
        let inner = self.cur();
        inner.take_guard(kind)
    }

    /// Replaces the open workspace by `target` (`None`: detached). The target file is read and structurally validated
    /// before anything is stopped (I3); runs and guarded operations make it fail with `workspaceBusy` (the caller
    /// cancels runs and retries; a switch never kills git work). Returns the new epoch.
    pub async fn switch_workspace(&self, target: Option<PathBuf>, backup_dir: Option<PathBuf>) -> Result<u64, EngineError> {
        let ticket = self.begin_switch()?;
        self.switch_with(&ticket, target, backup_dir).await
    }

    /// [`Engine::switch_workspace`] for a caller that already holds the [`SwitchTicket`] (the orchestrator takes it
    /// before the first teardown step so nothing new can start while the other modules stop).
    pub async fn switch_with(&self, _ticket: &SwitchTicket, target: Option<PathBuf>, backup_dir: Option<PathBuf>) -> Result<u64, EngineError> {
        let new_ws = match &target {
            Some(path) => workspace::load_existing(path)?,
            None => workspace::empty(),
        };
        let old = self.cur();
        let busy = old.busy();
        if !busy.is_empty() {
            let detail = busy.runs.iter().map(|(id, k)| format!("{k:?} {id}")).chain(busy.guards.iter().map(|g| (*g).to_owned())).collect::<Vec<_>>().join(", ");
            return Err(EngineError::new(code::WORKSPACE_BUSY, "a git operation is still running").with_detail(detail));
        }
        // From here on the old generation is dead: its calls fail, its tasks are cancelled, its actors stop.
        old.retired.store(true, Ordering::SeqCst);
        old.cancel_everything();
        old.shutdown_actors();
        let mut idle = old.in_flight.subscribe();
        let _ = tokio::time::timeout(SWITCH_GRACE, idle.wait_for(|n| *n == 0)).await;

        let epoch = self.shared.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        let next = Arc::new(Inner::generation(&self.shared, epoch, target, backup_dir, &new_ws));
        next.apply_workspace_unchecked(&new_ws);
        *self.inner.write().expect("generation lock") = next;
        Ok(epoch)
    }

    /// The login-shell environment (whitelisted variables) once resolved; the process `PATH` plus fallbacks before that.
    /// Agent runs start their processes from it, so they find `node` and `claude` like a terminal would.
    pub fn login_env(&self) -> std::collections::HashMap<String, String> {
        let inner = self.cur();
        inner.ctx.env.hook_env()
    }

    /// The engine's git context (pinned binary, login env, jail, spawn gate) for feature modules that run their own git calls.
    pub fn git_ctx(&self) -> GitCtx {
        let inner = self.cur();
        inner.ctx.clone()
    }

    pub async fn engine_status(&self) -> Result<EngineStatus, EngineError> {
        let inner = self.cur();
        let repo_ids = inner.workspace.read().await.repos.iter().map(|r| r.id.clone()).collect();
        Ok(EngineStatus { env: inner.ctx.env.status(), repo_ids })
    }

    /// Latest cached snapshot; computes one if there is none.
    pub async fn snapshot_get(&self, repo_id: &str) -> Result<RepoSnapshot, EngineError> {
        let inner = self.cur();
        inner.actor(repo_id)?.snapshot().await
    }

    /// `None` refreshes all repos; results arrive as `repo:snapshot` events.
    pub async fn snapshot_refresh(&self, repo_id: Option<&str>) -> Result<(), EngineError> {
        let inner = self.cur();
        match repo_id {
            Some(id) => inner.actor(id)?.refresh(),
            None => inner.actors.read().expect("actors lock").values().for_each(|a| a.refresh()),
        }
        Ok(())
    }

    pub async fn list_untracked(&self, repo_id: &str, dir: &str, limit: u32) -> Result<UntrackedList, EngineError> {
        let inner = self.cur();
        check_rel_path(dir)?;
        let actor = inner.actor(repo_id)?;
        let repo = actor.config();
        actor.read(|| status::list_untracked(&inner.ctx, &repo, dir, limit)).await
    }

    pub async fn file_contents(
        &self,
        repo_id: &str,
        path: &str,
        orig_path: Option<&str>,
        source: DiffSource,
        reveal: bool,
    ) -> Result<FileContents, EngineError> {
        let inner = self.cur();
        check_rel_path(path)?;
        orig_path.map(check_rel_path).transpose()?;
        check_source(&source)?;
        let actor = inner.actor(repo_id)?;
        let repo = actor.config();
        actor.read(|| diff::file_contents(&inner.ctx, &repo, path, orig_path, &source, reveal)).await
    }

    pub async fn file_hunks(&self, repo_id: &str, path: &str, source: DiffSource) -> Result<Vec<Hunk>, EngineError> {
        let inner = self.cur();
        check_rel_path(path)?;
        check_source(&source)?;
        let actor = inner.actor(repo_id)?;
        let repo = actor.config();
        actor.read(|| diff::file_hunks(&inner.ctx, &repo, path, &source)).await
    }

    pub async fn commit_message_last(&self, repo_id: &str) -> Result<String, EngineError> {
        let inner = self.cur();
        let actor = inner.actor(repo_id)?;
        let repo = actor.config();
        actor.read(|| commit::last_message(&inner.ctx, &repo)).await
    }

    /// Progress arrives as `op:event`, the final result as `op:result`.
    pub async fn commit_start(&self, req: CommitRequest) -> Result<RunStarted, EngineError> {
        let inner = self.cur();
        if req.repos.is_empty() {
            return Err(EngineError::new(code::INVALID_SELECTION, "nothing to commit"));
        }
        let mut seen = HashSet::new();
        let mut jobs = Vec::new();
        let mut blocked = Vec::new();
        for rc in req.repos {
            let actor = inner.actor(&rc.repo_id)?;
            inner.ctx.jail.check_op("commit_start", Path::new(&actor.config().path))?;
            if !seen.insert(rc.repo_id.clone()) {
                return Err(EngineError::new(code::INVALID_SELECTION, format!("repo '{}' appears twice", rc.repo_id)));
            }
            blocked.extend(guard_violations(&actor, &rc));
            let (ops, no_verify) = (inner.ops.clone(), req.no_verify);
            let op: Op = Box::new(move |ctx, repo| Box::pin(async move { ops.commit(&ctx, &repo, &rc, no_verify).await }));
            jobs.push((actor, op));
        }
        if !blocked.is_empty() {
            return Err(EngineError::new(
                code::GUARD_BLOCKED,
                format!("{} file(s) are blocked by the commit guard", blocked.len()),
            )
            .with_detail(blocked.join("\n")));
        }
        inner.start_run(req.run_id, OpKind::Commit, Lane::Write, jobs)
    }

    pub async fn commit_cancel(&self, run_id: &str) -> Result<(), EngineError> {
        let inner = self.cur();
        inner.cancel_run(run_id);
        Ok(())
    }

    pub async fn push_plan(&self, repo_ids: &[RepoId], refetch: bool) -> Result<Vec<OutgoingInfo>, EngineError> {
        let inner = self.cur();
        let ws = inner.workspace.read().await.clone();
        let shared_protection = self.shared.protection.clone();
        let actors = repo_ids.iter().map(|id| inner.actor(id)).collect::<Result<Vec<_>, _>>()?;
        let tasks: Vec<_> = actors
            .into_iter()
            .map(|actor| {
                let id = actor.config().id;
                // `protected` in the plan means "live": the protected patterns plus the repo's own live branches.
                let (ctx, protected) = (inner.ctx.clone(), protection_patterns(&shared_protection, &ws, &id, Path::new(&actor.config().path)));
                let task = tokio::spawn(async move {
                    let repo = actor.config();
                    let planned = if refetch {
                        actor.network(|| push::plan(&ctx, &repo, &protected, true)).await
                    } else {
                        actor.read(|| push::plan(&ctx, &repo, &protected, false)).await
                    };
                    planned.unwrap_or_else(|e| blocked_plan(&repo.id, e.message))
                });
                (id, task)
            })
            .collect();
        let mut plans = Vec::new();
        for (id, task) in tasks {
            plans.push(task.await.unwrap_or_else(|_| blocked_plan(&id, "internal error while planning the push".into())));
        }
        Ok(plans)
    }

    pub async fn push_commit_files(&self, repo_id: &str, oid: &str) -> Result<Vec<ChangedFile>, EngineError> {
        let inner = self.cur();
        check_oid(oid)?;
        let actor = inner.actor(repo_id)?;
        let repo = actor.config();
        actor.read(|| push::commit_files(&inner.ctx, &repo, oid)).await
    }

    pub async fn push_start(&self, req: PushRequest) -> Result<RunStarted, EngineError> {
        let inner = self.cur();
        if req.targets.is_empty() {
            return Err(EngineError::new(code::INVALID_SELECTION, "nothing to push"));
        }
        let mut seen = HashSet::new();
        let mut jobs = Vec::new();
        let ws = inner.workspace.read().await.clone();
        let jail = inner.ctx.jail.clone();
        for target in req.targets {
            let actor = inner.actor(&target.repo_id)?;
            if !seen.insert(target.repo_id.clone()) {
                return Err(EngineError::new(code::INVALID_SELECTION, format!("repo '{}' appears twice", target.repo_id)));
            }
            if !valid_ref_part(&target.remote) || !valid_ref_part(&target.remote_branch) {
                return Err(EngineError::new(code::INVALID_SELECTION, "invalid remote or branch name"));
            }
            // Safety layers before any process exists (docs/safety.md): the jail, then the live-branch confirmation.
            let repo = actor.config();
            jail.check_op("push_start", Path::new(&repo.path))?;
            jail.check_remotes(&inner.ctx.git_path, Path::new(&repo.path)).await?;
            let patterns = protection_patterns(&self.shared.protection, &ws, &repo.id, Path::new(&repo.path));
            let head = remote_head_branch(&inner.ctx, Path::new(&repo.path), &target.remote).await;
            let live = jail::matches_live(&patterns, head.as_deref(), &target.remote_branch);
            jail::check_live_push(live, &target.remote_branch, target.confirm_live.as_deref(), req.no_verify)?;
            let (ops, no_verify) = (inner.ops.clone(), req.no_verify);
            let op: Op = Box::new(move |ctx, repo| Box::pin(async move { ops.push(&ctx, &repo, &target, no_verify).await }));
            jobs.push((actor, op));
        }
        inner.start_run(req.run_id, OpKind::Push, Lane::Network, jobs)
    }

    pub async fn push_cancel(&self, run_id: &str) -> Result<(), EngineError> {
        let inner = self.cur();
        inner.cancel_run(run_id);
        Ok(())
    }

    pub async fn pull(&self, repo_id: &str, mode: PullMode) -> Result<RunStarted, EngineError> {
        let inner = self.cur();
        let actor = inner.actor(repo_id)?;
        check_network_mutation(&inner, "pull", &actor).await?;
        let ops = inner.ops.clone();
        let op: Op = Box::new(move |ctx, repo| Box::pin(async move { ops.pull(&ctx, &repo, mode).await }));
        inner.start_run(new_run_id(), OpKind::Pull, Lane::WriteNetwork, vec![(actor, op)])
    }

    pub async fn fetch(&self, repo_id: &str) -> Result<RunStarted, EngineError> {
        let inner = self.cur();
        let actor = inner.actor(repo_id)?;
        check_network_mutation(&inner, "fetch", &actor).await?;
        let ops = inner.ops.clone();
        let op: Op = Box::new(move |ctx, repo| Box::pin(async move { ops.fetch(&ctx, &repo).await }));
        inner.start_run(new_run_id(), OpKind::Fetch, Lane::Network, vec![(actor, op)])
    }

    /// The open workspace as every other live-branch lookup must see it (I7): per repo, the patterns the
    /// [`ProtectionSource`] knows from every other workspace that contains the same repository are added to
    /// `liveBranches`. Without a source this is [`Engine::workspace_get`]. Meant for features outside the engine (graph
    /// rebase, branch deletion, PR creation) that judge a branch themselves.
    pub async fn effective_workspace(&self) -> Result<Workspace, EngineError> {
        let inner = self.cur();
        let mut ws = inner.workspace.read().await.clone();
        let Some(source) = self.shared.protection.clone() else { return Ok(ws) };
        let repos: Vec<(RepoId, PathBuf)> = ws.repos.iter().map(|r| (r.id.clone(), PathBuf::from(&r.path))).collect();
        let found = tokio::task::spawn_blocking(move || repos.into_iter().map(|(id, path)| (id, source.protection(&path))).collect::<Vec<_>>())
            .await
            .map_err(|e| EngineError::new(code::IO, e.to_string()))?;
        for (id, p) in found {
            let own = ws.protected_branches.clone();
            let live = ws.live_branches.entry(id).or_default();
            for extra in p.protected.into_iter().chain(p.live) {
                if !own.contains(&extra) && !live.contains(&extra) {
                    live.push(extra);
                }
            }
        }
        Ok(ws)
    }

    /// Stored in `pushTargets` of the workspace, never written to git config.
    pub async fn set_push_target(
        &self,
        repo_id: &str,
        local_branch: &str,
        remote: &str,
        branch: &str,
    ) -> Result<Workspace, EngineError> {
        let inner = self.cur();
        if ![local_branch, remote, branch].into_iter().all(valid_ref_part) {
            return Err(EngineError::new(code::INVALID_SELECTION, "invalid branch or remote name"));
        }
        inner.check_editable()?;
        let path = inner.workspace_path.clone().ok_or_else(no_workspace)?;
        let mut current = inner.workspace.write().await;
        inner.check_editable()?;
        let mut next = current.clone();
        next.repos
            .iter_mut()
            .find(|r| r.id == repo_id)
            .ok_or_else(|| unknown_repo(repo_id))?
            .push_targets
            .insert(local_branch.to_owned(), PushTargetMapping { remote: remote.to_owned(), branch: branch.to_owned() });
        workspace::persist(&path, &next)?;
        inner.apply_workspace_unchecked(&next);
        *current = next.clone();
        Ok(next)
    }

    pub async fn doctor(&self) -> Result<DoctorReport, EngineError> {
        let inner = self.cur();
        let ws = inner.workspace.read().await.clone();
        let ctx = &inner.ctx;
        let opts = RunOpts { read_only: true, timeout: Some(Duration::from_secs(10)), ..RunOpts::default() };
        let probe = ws.repos.iter().map(|r| PathBuf::from(&r.path)).find(|p| p.is_dir()).unwrap_or_else(|| PathBuf::from("."));

        let git_version = match run_git(ctx, &probe, &["--version"], &opts).await {
            Ok(out) => String::from_utf8_lossy(&out.stdout).trim().trim_start_matches("git version ").to_owned(),
            Err(_) => "unknown".to_owned(),
        };
        let credential_helpers = match run_git(ctx, &probe, &["config", "--get-all", "credential.helper"], &opts).await {
            Ok(out) if out.code == Some(0) => String::from_utf8_lossy(&out.stdout).lines().map(str::to_owned).collect(),
            _ => Vec::new(),
        };

        let tasks: Vec<_> = ws
            .repos
            .iter()
            .filter_map(|r| inner.actor(&r.id).ok())
            .map(|actor| {
                let (ctx, opts) = (ctx.clone(), RunOpts { read_only: true, timeout: Some(Duration::from_secs(15)), ..RunOpts::default() });
                let id = actor.config().id;
                let task = tokio::spawn(async move {
                    let repo = actor.config();
                    let (ls_remote_ok, message) = actor.network(|| ls_remote_probe(&ctx, &repo, &opts)).await;
                    let hooks = actor.cached().map_or(HookInfo { kind: HookKind::None, path: None }, |s| s.hooks);
                    DoctorRepo { repo_id: repo.id, ls_remote_ok, hooks, message }
                });
                (id, task)
            })
            .collect();
        let mut repos = Vec::new();
        for (id, task) in tasks {
            repos.push(task.await.unwrap_or_else(|_| DoctorRepo {
                repo_id: id,
                ls_remote_ok: false,
                hooks: HookInfo { kind: HookKind::None, path: None },
                message: Some("internal error while probing the remote".into()),
            }));
        }
        Ok(DoctorReport {
            git_path: ctx.git_path.to_string_lossy().into_owned(),
            git_version,
            credential_helpers,
            path_has_node: ctx.env.status().node_path.is_some(),
            repos,
        })
    }

    /// Cancels every run (killing the process groups of their git children and of status reads), stops the
    /// actors and watchers and waits for the runs to finish. New runs are refused afterwards.
    pub async fn shutdown(&self) {
        let inner = self.cur();
        inner.closing.store(true, Ordering::SeqCst);
        inner.cancel_everything();
        inner.shutdown_actors();
        let mut idle = inner.in_flight.subscribe();
        let _ = tokio::time::timeout(SHUTDOWN_GRACE, idle.wait_for(|n| *n == 0)).await;
    }
}

impl Inner {
    /// A fresh generation: own cancel token, own event filter, the engine-wide env, gate and jail.
    fn generation(shared: &Shared, epoch: u64, path: Option<PathBuf>, backup_dir: Option<PathBuf>, ws: &Workspace) -> Inner {
        let shutdown = CancelToken::default();
        let sink: Arc<dyn EventSink> = Arc::new(GenSink { epoch, live: shared.epoch.clone(), real: shared.sink.clone() });
        let ctx = GitCtx::new(shared.git_path.clone(), shared.env.clone(), sink)
            .with_jail(shared.jail.clone())
            .with_gate(shared.gate.clone())
            .with_run(RunInfo { run_id: String::new(), kind: OpKind::Fetch, cancel: shutdown.clone() });
        Inner {
            workspace_path: path,
            backup_dir,
            workspace: AsyncRwLock::new(ws.clone()),
            actors: RwLock::new(HashMap::new()),
            ctx,
            shutdown,
            ops: shared.ops.clone(),
            runs: Mutex::new(HashMap::new()),
            in_flight: Arc::new(watch::channel(0).0),
            closing: AtomicBool::new(false),
            retired: AtomicBool::new(false),
            watch: shared.watch,
            switching: shared.switching.clone(),
            guards: Mutex::new(Vec::new()),
            guard_seq: AtomicU64::new(0),
            guard_count: AtomicUsize::new(0),
        }
    }

    /// Saves and edits are refused while a switch runs, after this generation was replaced and at shutdown.
    fn check_editable(&self) -> Result<(), EngineError> {
        if self.switching.load(Ordering::SeqCst) || self.retired.load(Ordering::SeqCst) {
            return Err(switching());
        }
        if self.closing.load(Ordering::SeqCst) {
            return Err(EngineError::new(code::CANCELLED, "the engine is shutting down"));
        }
        Ok(())
    }

    fn take_guard(self: &Arc<Self>, kind: &'static str) -> Result<MutationGuard, EngineError> {
        // The flag is read under the lock the switch also takes when it counts guards, so a guard is either seen by
        // the switch or refused here.
        let mut guards = self.guards.lock().expect("guards lock");
        if self.switching.load(Ordering::SeqCst) || self.retired.load(Ordering::SeqCst) {
            return Err(switching());
        }
        if self.closing.load(Ordering::SeqCst) {
            return Err(EngineError::new(code::CANCELLED, "the engine is shutting down"));
        }
        let id = self.guard_seq.fetch_add(1, Ordering::SeqCst);
        guards.push((id, kind));
        self.guard_count.fetch_add(1, Ordering::SeqCst);
        Ok(MutationGuard { inner: self.clone(), id })
    }

    fn busy(&self) -> EngineBusy {
        let runs = self.runs.lock().expect("runs lock").iter().map(|(id, (_, kind))| (id.clone(), kind.clone())).collect();
        let guards = self.guards.lock().expect("guards lock").iter().map(|(_, k)| *k).collect();
        EngineBusy { runs, guards }
    }

    fn shutdown_actors(&self) {
        for actor in self.actors.read().expect("actors lock").values() {
            actor.shutdown();
        }
    }

    fn actor(&self, repo_id: &str) -> Result<Arc<RepoActor>, EngineError> {
        self.actors.read().expect("actors lock").get(repo_id).cloned().ok_or_else(|| unknown_repo(repo_id))
    }

    fn spawn_actor(&self, repo: RepoConfig) -> Arc<RepoActor> {
        let (ops, ctx) = (self.ops.clone(), self.ctx.clone());
        let source: SnapshotFn = Arc::new(move |repo| {
            let (ops, ctx) = (ops.clone(), ctx.clone());
            Box::pin(async move { ops.snapshot(&ctx, &repo).await })
        });
        // A killed app can leave an orphaned commit and its temp index behind (see `git::orphans`).
        let root = std::path::PathBuf::from(&repo.path);
        tokio::task::spawn_blocking(move || crate::git::orphans::sweep_stale_temp_indexes(&root));
        RepoActor::spawn(repo, source, self.ctx.sink.clone(), self.watch)
    }

    /// Brings the actors in line with `ws`: new repos start (and read their first snapshot), removed or
    /// re-pathed ones stop, the rest pick up name, colour and push targets.
    fn apply_workspace_unchecked(&self, ws: &Workspace) {
        let wanted: HashMap<&str, &RepoConfig> = ws.repos.iter().map(|r| (r.id.as_str(), r)).collect();
        let mut actors = self.actors.write().expect("actors lock");
        actors.retain(|id, actor| match wanted.get(id.as_str()) {
            Some(repo) if repo.path == actor.config().path => {
                actor.set_config((*repo).clone());
                true
            }
            _ => {
                actor.shutdown();
                false
            }
        });
        for repo in &ws.repos {
            if !actors.contains_key(&repo.id) {
                let actor = self.spawn_actor(repo.clone());
                actor.refresh();
                actors.insert(repo.id.clone(), actor);
            }
        }
    }

    fn begin_run(&self, run_id: String, kind: OpKind) -> Result<Run, EngineError> {
        if run_id.is_empty() {
            return Err(EngineError::new(code::INVALID_SELECTION, "the run id must not be empty"));
        }
        let mut runs = self.runs.lock().expect("runs lock");
        // Read under the `runs` lock: a switch sets its flag first and counts the runs second, so a run is either
        // visible to the switch or refused here.
        if self.switching.load(Ordering::SeqCst) || self.retired.load(Ordering::SeqCst) {
            return Err(switching());
        }
        if self.closing.load(Ordering::SeqCst) {
            return Err(EngineError::new(code::CANCELLED, "the engine is shutting down"));
        }
        if runs.contains_key(&run_id) {
            return Err(EngineError::new(code::INVALID_SELECTION, format!("run '{run_id}' already exists")));
        }
        let cancel = CancelToken::default();
        runs.insert(run_id.clone(), (cancel.clone(), kind.clone()));
        Ok(Run { id: run_id, kind, cancel })
    }

    fn cancel_run(&self, run_id: &str) {
        if let Some((token, _)) = self.runs.lock().expect("runs lock").get(run_id) {
            token.cancel();
        }
    }

    fn cancel_everything(&self) {
        self.shutdown.cancel();
        self.runs.lock().expect("runs lock").values().for_each(|(t, _)| t.cancel());
    }

    fn emit(&self, run: &Run, repo_id: &str, status: StepStatus) {
        self.ctx.sink.op_event(OpEvent {
            run_id: run.id.clone(),
            repo_id: repo_id.to_owned(),
            kind: run.kind.clone(),
            status,
            line: None,
            percent: None,
        });
    }

    /// Registers the run, announces every repo as queued and executes the jobs in the background:
    /// repos in parallel, each inside its own actor lane.
    fn start_run(
        self: &Arc<Self>,
        run_id: String,
        kind: OpKind,
        lane: Lane,
        jobs: Vec<(Arc<RepoActor>, Op)>,
    ) -> Result<RunStarted, EngineError> {
        let run = self.begin_run(run_id, kind)?;
        let flight = Flight::enter(&self.in_flight);
        for (actor, _) in &jobs {
            self.emit(&run, &actor.config().id, StepStatus::Queued);
        }
        let inner = self.clone();
        let started = RunStarted { run_id: run.id.clone() };
        tokio::spawn(async move {
            let _flight = flight;
            let tasks: Vec<_> = jobs
                .into_iter()
                .map(|(actor, op)| {
                    let id = actor.config().id;
                    (id, tokio::spawn(run_job(inner.clone(), run.clone(), actor, lane, op)))
                })
                .collect();
            let mut outcomes = Vec::new();
            for (id, task) in tasks {
                outcomes.push(
                    task.await.unwrap_or_else(|_| failed(&id, FailureKind::Unknown, "internal error: the operation panicked")),
                );
            }
            inner.finish_run(&run, outcomes);
        });
        Ok(started)
    }

    fn finish_run(&self, run: &Run, outcomes: Vec<RepoOutcome>) {
        self.runs.lock().expect("runs lock").remove(&run.id);
        // The final step of every repo is also sent as an event, so the UI never depends on the op layer emitting it.
        for outcome in &outcomes {
            self.emit(run, &outcome.repo_id, outcome.status.clone());
        }
        self.ctx.sink.op_result(OpResult {
            run_id: run.id.clone(),
            kind: run.kind.clone(),
            repos: outcomes,
            finished_at_ms: now_ms(),
        });
    }
}

/// One repo's part of a run inside its actor lane; skipped if the run was cancelled while it queued.
async fn run_job(inner: Arc<Inner>, run: Run, actor: Arc<RepoActor>, lane: Lane, op: Op) -> RepoOutcome {
    let repo = actor.config();
    let ctx = inner.ctx.with_run(RunInfo { run_id: run.id.clone(), kind: run.kind.clone(), cancel: run.cancel.clone() });
    let work = || async {
        if run.cancel.is_cancelled() {
            outcome(&repo.id, StepStatus::Cancelled, None)
        } else {
            op(ctx, repo.clone()).await
        }
    };
    let result = match lane {
        Lane::Write => actor.write(work).await,
        Lane::Network => actor.network(work).await,
        Lane::WriteNetwork => actor.write_network(work).await,
    };
    actor.refresh();
    result
}

async fn ls_remote_probe(ctx: &GitCtx, repo: &RepoConfig, opts: &RunOpts) -> (bool, Option<String>) {
    let target = match outgoing::resolve_target(ctx, repo).await {
        Ok(t) => t,
        Err(e) => return (false, Some(e.message)),
    };
    let args = ["ls-remote", "--exit-code", "--heads", target.remote.as_str()];
    match run_git(ctx, Path::new(&repo.path), &args, opts).await {
        Ok(out) if out.code == Some(0) => (true, None),
        Ok(out) => (false, String::from_utf8_lossy(&out.stderr).lines().next().map(str::to_owned)),
        Err(e) => (false, Some(e.message)),
    }
}

fn outcome(repo_id: &str, status: StepStatus, failure: Option<Failure>) -> RepoOutcome {
    RepoOutcome {
        repo_id: repo_id.to_owned(),
        status,
        commit_oid: None,
        reconciled: false,
        failure,
        hook_modified_files: Vec::new(),
        push_results: None,
    }
}

fn failed(repo_id: &str, kind: FailureKind, message: &str) -> RepoOutcome {
    outcome(repo_id, StepStatus::Failed, Some(Failure { kind, message: message.to_owned(), output: None }))
}

fn blocked_plan(repo_id: &str, reason: String) -> OutgoingInfo {
    OutgoingInfo {
        repo_id: repo_id.to_owned(),
        local: String::new(),
        remote: String::new(),
        remote_branch: String::new(),
        new_remote_branch: false,
        protected: false,
        commits: Vec::new(),
        stale_as_of_ms: None,
        checked_by_default: false,
        can_push: false,
        blocked_reason: Some(reason),
        remote_only: None,
        remote_oid: None,
    }
}

/// Files of a commit request that the guard refuses, as `repo: path (why)` lines.
/// The cached snapshot knows whether a file is new to the repo (only those are blocked) and how big it is; a path it
/// does not list is judged as a new file by its name alone. `commit` re-checks against the real index.
fn guard_violations(actor: &RepoActor, rc: &RepoCommit) -> Vec<String> {
    let snapshot = actor.cached();
    let by_path: HashMap<&str, &GuardState> = snapshot
        .as_ref()
        .map(|s| s.changes.iter().map(|c| (c.path.as_str(), &c.guard)).collect())
        .unwrap_or_default();
    rc.files
        .iter()
        .filter_map(|file| {
            let path = match file {
                FileSelection::Whole { path, .. } | FileSelection::Partial { path, .. } => path,
            };
            let why = if path.ends_with('/') {
                "untracked directory, expand it first"
            } else {
                let state = match by_path.get(path.as_str()) {
                    Some(known) => (*known).clone(),
                    None => guard::classify(path, true, None),
                };
                match state {
                    GuardState::Ok | GuardState::Sensitive => return None,
                    GuardState::NeverAdd => "never-add path",
                    GuardState::Secret => "possible secret",
                    GuardState::TooLarge => "file is too large",
                }
            };
            Some(format!("{}: {path} ({why})", rc.repo_id))
        })
        .collect()
}

/// Protected patterns plus the repo's own `liveBranches`.
fn local_patterns(ws: &Workspace, repo_id: &str) -> Vec<String> {
    let mut patterns = ws.protected_branches.clone();
    patterns.extend(ws.live_branches.get(repo_id).into_iter().flatten().cloned());
    patterns
}

/// What counts as a live branch for one repository: the patterns of the open workspace, plus whatever the
/// [`ProtectionSource`] knows about the same repository from every other workspace (I7). Only ever adds.
fn protection_patterns(source: &Option<Arc<dyn ProtectionSource>>, ws: &Workspace, repo_id: &str, repo_path: &Path) -> Vec<String> {
    let mut patterns = local_patterns(ws, repo_id);
    if let Some(source) = source {
        let p = source.protection(repo_path);
        for extra in p.protected.into_iter().chain(p.live) {
            if !patterns.contains(&extra) {
                patterns.push(extra);
            }
        }
    }
    patterns
}

/// Jail check of a command that changes the repo and talks to its remote.
async fn check_network_mutation(inner: &Inner, op: &str, actor: &RepoActor) -> Result<(), EngineError> {
    let path = actor.config().path;
    inner.ctx.jail.check_op(op, Path::new(&path))?;
    inner.ctx.jail.check_remotes(&inner.ctx.git_path, Path::new(&path)).await
}

fn no_workspace() -> EngineError {
    EngineError::new(code::NO_WORKSPACE, "no workspace is open")
}

fn switching() -> EngineError {
    EngineError::new(code::WORKSPACE_SWITCHING, "a workspace switch is in progress")
}

/// The branch `refs/remotes/<remote>/HEAD` points at, when the clone knows it.
async fn remote_head_branch(ctx: &GitCtx, repo: &Path, remote: &str) -> Option<String> {
    let head_ref = format!("refs/remotes/{remote}/HEAD");
    let opts = RunOpts { read_only: true, ..Default::default() };
    let out = run_git(ctx, repo, &["symbolic-ref", "-q", "--short", &head_ref], &opts).await.ok()?;
    let name = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (out.code == Some(0)).then(|| name.strip_prefix(&format!("{remote}/")).map(str::to_owned)).flatten()
}

fn unknown_repo(repo_id: &str) -> EngineError {
    EngineError::new(code::REPO_MISSING, format!("unknown repo '{repo_id}'"))
}

fn new_run_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Repo-relative paths only: no absolute paths, no `..`, no NUL.
fn check_rel_path(path: &str) -> Result<(), EngineError> {
    let escapes = Path::new(path)
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)));
    if escapes || path.contains('\0') {
        return Err(EngineError::new(code::INVALID_SELECTION, format!("'{path}' is not a repo-relative path")));
    }
    Ok(())
}

fn check_oid(oid: &str) -> Result<(), EngineError> {
    if (4..=64).contains(&oid.len()) && oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(EngineError::new(code::INVALID_SELECTION, format!("'{oid}' is not a commit id")))
    }
}

fn check_source(source: &DiffSource) -> Result<(), EngineError> {
    match source {
        DiffSource::Commit { oid } => check_oid(oid),
        _ => Ok(()),
    }
}

/// A conservative subset of `git check-ref-format`; also keeps option-like names out of argv.
fn valid_ref_part(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with(['-', '/'])
        && !s.ends_with(['/', '.'])
        && !s.ends_with(".lock")
        && !s.contains("..")
        && !s.chars().any(|c| c.is_control() || c.is_whitespace() || "~^:?*[\\".contains(c))
}

/// Resolves on SIGTERM, SIGINT or SIGHUP. The shell turns it into a regular exit so `Engine::shutdown` runs; only
/// SIGKILL and crashes skip it (the next start sweeps what they leave, `git::orphans`).
pub async fn termination_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let (Ok(mut term), Ok(mut int), Ok(mut hup)) =
        (signal(SignalKind::terminate()), signal(SignalKind::interrupt()), signal(SignalKind::hangup()))
    else {
        return std::future::pending().await;
    };
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
        _ = hup.recv() => {}
    }
}
