//! Git process spawning (contract section 6.1): pinned git binary, fixed environment, own process group.

use std::any::Any;
use std::borrow::Cow;
use std::collections::HashMap;
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::Notify;
use tokio::time::Instant;

use crate::env::EnvResolver;
use crate::jail::{check_agent_git, Jail, Mode, Origin};
use crate::parse::progress::{classify_progress_line, LineSplitter, ProgressLine};
use crate::{code, EngineError, EventSink, FailureKind, OpEvent, OpKind, OpLine, StepStatus, StreamKind};

/// Grace period between SIGTERM and SIGKILL of a cancelled or timed-out process group.
pub const KILL_GRACE: Duration = Duration::from_secs(3);
/// How long to keep draining the pipes once the leader exited (a daemon may inherit them).
const PIPE_DRAIN_GRACE: Duration = Duration::from_secs(2);
/// Per-stream capture limit when [`RunOpts::max_output`] is not set.
pub const DEFAULT_MAX_OUTPUT: usize = 64 * 1024 * 1024;

/// Cooperative cancellation of one run; cancelling kills the process group of every child of the run.
#[derive(Clone, Default)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl CancelToken {
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Resolves once [`cancel`](Self::cancel) was called (immediately if it already was).
    pub async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// Identity of a long-running operation; attached to a [`GitCtx`] so `op:event`s carry the run id.
#[derive(Clone)]
pub struct RunInfo {
    pub run_id: String,
    pub kind: OpKind,
    pub cancel: CancelToken,
}

/// Which concurrency lane a spawn belongs to (contract section 7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnClass {
    /// Status/diff/log style reads.
    Read,
    /// Hook-running commands (commit, push): counted separately so reads never queue behind them.
    Hook,
    /// fetch / push / ls-remote.
    Network,
}

/// Hook point for the global concurrency cap (owned by the repo actor): `acquire` resolves when a slot is free and the
/// returned guard is held until the process finished.
pub trait SpawnGate: Send + Sync {
    fn acquire(&self, class: SpawnClass) -> Pin<Box<dyn Future<Output = Box<dyn Any + Send>> + Send + '_>>;
}

/// Everything a git call needs besides the repo: pinned binary, login-shell env, event sink and the optional run.
#[derive(Clone)]
pub struct GitCtx {
    pub git_path: PathBuf,
    pub env: Arc<EnvResolver>,
    pub sink: Arc<dyn EventSink>,
    pub run: Option<RunInfo>,
    /// Optional global concurrency gate; `None` means unlimited.
    pub gate: Option<Arc<dyn SpawnGate>>,
    /// Safety jail (docs/safety.md); the process-wide one from the environment unless replaced.
    pub jail: Arc<Jail>,
    /// Who asked for the process. [`Origin::Agent`] passes only the agent allow-list ([`crate::jail::check_agent_git`]);
    /// the IDE's own operations stay [`Origin::Human`] (deny-list guard and jail only).
    pub origin: Origin,
}

impl GitCtx {
    pub fn new(git_path: PathBuf, env: Arc<EnvResolver>, sink: Arc<dyn EventSink>) -> Self {
        Self { git_path, env, sink, run: None, gate: None, jail: Jail::global(), origin: Origin::Human }
    }

    /// A copy of this context for a process an agent originated: every call goes through the allow-list.
    pub fn for_agent(&self) -> Self {
        Self { origin: Origin::Agent, ..self.clone() }
    }

    /// A copy of this context under another jail (tests; the app uses the global one).
    pub fn with_jail(&self, jail: Arc<Jail>) -> Self {
        Self { jail, ..self.clone() }
    }

    /// A copy of this context bound to one run (commit/push/pull/fetch).
    pub fn with_run(&self, run: RunInfo) -> Self {
        Self { run: Some(run), ..self.clone() }
    }

    /// A copy of this context whose spawns go through `gate`.
    pub fn with_gate(&self, gate: Arc<dyn SpawnGate>) -> Self {
        Self { gate: Some(gate), ..self.clone() }
    }

    pub fn is_cancelled(&self) -> bool {
        self.run.as_ref().is_some_and(|r| r.cancel.is_cancelled())
    }
}

/// Per-call options; `Default` is a plain read-only call without stdin and without the login-shell env.
#[derive(Default)]
pub struct RunOpts {
    /// Adds `--no-optional-locks`.
    pub read_only: bool,
    pub stdin: Option<Vec<u8>>,
    /// Hook-running commands (commit, push) get the resolved login-shell environment.
    pub login_env: bool,
    pub extra_env: HashMap<String, String>,
    /// Emit stdout/stderr lines as `op:event` of the run bound to the context (needs `stream_repo_id`).
    pub stream_to_run: bool,
    /// Repo id and step status carried by the streamed `op:event`s (status defaults to `hooks`).
    pub stream_repo_id: Option<String>,
    pub stream_status: Option<StepStatus>,
    pub timeout: Option<Duration>,
    /// Per-stream capture limit in bytes (default [`DEFAULT_MAX_OUTPUT`]); the excess is dropped and
    /// `GitOutput::truncated` is set.
    pub max_output: Option<usize>,
    /// Terminate the process once `max_output` is exceeded instead of draining it.
    pub kill_on_limit: bool,
    /// Concurrency lane; defaults to `Hook` when `login_env` is set, else `Read`.
    pub class: Option<SpawnClass>,
}

#[derive(Debug, Default)]
pub struct GitOutput {
    /// `None` when killed by a signal (cancel, timeout, output limit).
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl GitOutput {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    pub fn stdout_text(&self) -> Cow<'_, str> {
        String::from_utf8_lossy(&self.stdout)
    }

    pub fn stderr_text(&self) -> Cow<'_, str> {
        String::from_utf8_lossy(&self.stderr)
    }

    /// `Ok(self)` on exit code 0, else a `git` error carrying stderr.
    pub fn ok_or_err(self, what: &str) -> Result<Self, EngineError> {
        if self.success() {
            return Ok(self);
        }
        let how = self.code.map_or("killed".to_owned(), |c| format!("exit {c}"));
        Err(EngineError::new(code::GIT, format!("{what} failed ({how})")).with_detail(self.stderr_text().trim().to_owned()))
    }
}

/// [`GitOutput`] plus how the run ended.
#[derive(Debug, Default)]
pub struct RunResult {
    pub output: GitOutput,
    /// A stream exceeded `RunOpts::max_output`; the excess was dropped.
    pub truncated: bool,
    pub timed_out: bool,
    /// The run's [`CancelToken`] fired and the process group was terminated.
    pub cancelled: bool,
}

/// `/usr/local/bin/git` if it exists, else the first `git` on `PATH`.
pub fn pinned_git_path() -> PathBuf {
    let preferred = Path::new("/usr/local/bin/git");
    if preferred.exists() {
        return preferred.to_path_buf();
    }
    std::env::var_os("PATH")
        .and_then(|paths| std::env::split_paths(&paths).map(|d| d.join("git")).find(|p| p.is_file()))
        .unwrap_or_else(|| PathBuf::from("git"))
}

/// Config every git process of the IDE carries, whoever spawns it ((design notes: workspaces-spec) 5.5, T4): `core.fsmonitor`
/// set to a program path would otherwise be executed by any status refresh of a hostile repository. A boolean
/// `core.fsmonitor=true` is overridden too, so the built-in daemon is not started either.
pub const HARDENING_ARGS: [&str; 2] = ["-c", "core.fsmonitor=false"];

/// The one way to start a blocking git process: `git -c core.fsmonitor=false`, the caller adds the rest. A lint test
/// (`crates/core/tests/hardening.rs`) fails on any git `Command::new` that neither uses this nor the async twin.
pub fn hardened_git(git: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut cmd = std::process::Command::new(git);
    cmd.args(HARDENING_ARGS);
    cmd
}

/// [`hardened_git`] for tokio.
pub fn hardened_git_tokio(git: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(git);
    cmd.args(HARDENING_ARGS);
    cmd
}

/// Runs `git -C <repo> -c gc.auto=0 -c maintenance.auto=false <args>` and collects its output.
/// A non-zero exit, a timeout or a cancel are not errors (the code is `None` when the process was killed, and
/// [`CancelToken::is_cancelled`] tells a cancel apart); `Err` is only returned when the repo directory is missing or git
/// could not be spawned. [`run_git_full`] additionally reports truncation, timeout and cancel.
pub async fn run_git(ctx: &GitCtx, repo: &Path, args: &[&str], opts: &RunOpts) -> Result<GitOutput, EngineError> {
    Ok(run_git_full(ctx, repo, args, opts, None).await?.output)
}

/// Like [`run_git`], additionally calling `on_line` for every complete output line (CR, LF and CRLF all end a line, so
/// progress output is delivered as it is produced). stdout and stderr are still collected into the result.
pub async fn run_git_streaming(
    ctx: &GitCtx,
    repo: &Path,
    args: &[&str],
    opts: &RunOpts,
    mut on_line: impl FnMut(StreamKind, &str) + Send,
) -> Result<GitOutput, EngineError> {
    Ok(run_git_full(ctx, repo, args, opts, Some(&mut on_line)).await?.output)
}

/// Variables that would redirect git away from the repo given with `-C`.
const SCRUBBED_ENV: [&str; 7] =
    ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_PREFIX"];

fn build_command(ctx: &GitCtx, repo: &Path, args: &[&str], opts: &RunOpts) -> Command {
    let mut cmd = hardened_git_tokio(&ctx.git_path);
    cmd.arg("-C").arg(repo).args(["-c", "gc.auto=0", "-c", "maintenance.auto=false"]);
    cmd.args(ctx.jail.config_args());
    if opts.read_only {
        cmd.arg("--no-optional-locks");
    }
    cmd.args(args);
    for k in SCRUBBED_ENV {
        cmd.env_remove(k);
    }
    if opts.login_env {
        cmd.envs(ctx.env.hook_env());
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", ":").env("LC_ALL", "C").env("GIT_PAGER", "cat");
    cmd.envs(&opts.extra_env);
    // Last, so neither the login env nor `extra_env` can undo the jail's hardening.
    for k in ctx.jail.removed_env() {
        cmd.env_remove(k);
    }
    cmd.envs(ctx.jail.env().iter().copied());
    cmd.stdin(if opts.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    cmd
}

fn signal_group(pgid: Option<i32>, sig: i32) {
    if let Some(pgid) = pgid.filter(|p| *p > 1) {
        // SAFETY: plain syscall; the group was created by this module and is only signalled until it is reaped.
        unsafe { libc::killpg(pgid, sig) };
    }
}

/// SIGKILLs the process group if the owning future is dropped before the process finished.
struct GroupGuard {
    pgid: Option<i32>,
    armed: bool,
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        if self.armed {
            signal_group(self.pgid, libc::SIGKILL);
        }
    }
}

struct Capture {
    buf: Vec<u8>,
    limit: usize,
    truncated: bool,
}

impl Capture {
    fn push(&mut self, data: &[u8]) {
        let room = self.limit.saturating_sub(self.buf.len());
        if data.len() > room {
            self.truncated = true;
        }
        self.buf.extend_from_slice(&data[..data.len().min(room)]);
    }
}

async fn sleep_until_opt(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// The general form behind [`run_git`] and [`run_git_streaming`].
pub async fn run_git_full(
    ctx: &GitCtx,
    repo: &Path,
    args: &[&str],
    opts: &RunOpts,
    mut on_line: Option<&mut (dyn FnMut(StreamKind, &str) + Send)>,
) -> Result<RunResult, EngineError> {
    if !repo.is_dir() {
        return Err(EngineError::new(code::REPO_MISSING, format!("repository folder not found: {}", repo.display())));
    }
    // Before any process exists: a jailed argv, repo or remote is refused here whatever the caller did (docs/safety.md).
    if ctx.origin == Origin::Agent {
        check_agent_git(args)?;
    }
    ctx.jail.check_git(repo, args)?;
    if ctx.jail.mode() == Mode::E2e && Jail::is_network(args) {
        ctx.jail.check_remotes(&ctx.git_path, repo).await?;
    }
    let class = opts.class.unwrap_or(if opts.login_env { SpawnClass::Hook } else { SpawnClass::Read });
    let _slot = match &ctx.gate {
        Some(gate) => Some(gate.acquire(class).await),
        None => None,
    };

    let mut child = build_command(ctx, repo, args, opts)
        .spawn()
        .map_err(|e| EngineError::new(code::IO, format!("cannot start {}: {e}", ctx.git_path.display())))?;
    let pgid = child.id().map(|p| p as i32);
    let mut guard = GroupGuard { pgid, armed: true };

    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    if let (Some(data), Some(mut stdin)) = (opts.stdin.clone(), child.stdin.take()) {
        // A separate task, so a child that writes a lot before reading cannot deadlock us; EPIPE is the child's business.
        tokio::spawn(async move {
            let _ = stdin.write_all(&data).await;
        });
    }

    let limit = opts.max_output.unwrap_or(DEFAULT_MAX_OUTPUT);
    let mut out = Capture { buf: Vec::new(), limit, truncated: false };
    let mut err = Capture { buf: Vec::new(), limit, truncated: false };
    let split_lines = on_line.is_some() || (opts.stream_to_run && ctx.run.is_some());
    let (mut out_lines, mut err_lines) = (LineSplitter::new(), LineSplitter::new());
    let cancel = ctx.run.as_ref().map(|r| r.cancel.clone());

    let mut emit = |stream: StreamKind, line: &str| {
        if let Some(f) = on_line.as_mut() {
            f(stream.clone(), line);
        }
        if let (true, Some(run)) = (opts.stream_to_run, &ctx.run) {
            let percent = match (&stream, classify_progress_line(line)) {
                (StreamKind::Stderr, ProgressLine::Progress { percent, .. }) => Some(f32::from(percent)),
                _ => None,
            };
            ctx.sink.op_event(OpEvent {
                run_id: run.run_id.clone(),
                repo_id: opts.stream_repo_id.clone().unwrap_or_default(),
                kind: run.kind.clone(),
                status: opts.stream_status.clone().unwrap_or(StepStatus::Hooks),
                line: Some(OpLine { stream, text: line.to_owned() }),
                percent,
            });
        }
    };

    let timeout_at = opts.timeout.map(|t| Instant::now() + t);
    let mut kill_at: Option<Instant> = None;
    let mut drain_until: Option<Instant> = None;
    let (mut cancelled, mut timed_out) = (false, false);
    let mut exit = None;
    let (mut out_open, mut err_open) = (true, true);
    let (mut b1, mut b2) = (vec![0u8; 16 * 1024], vec![0u8; 16 * 1024]);

    // Terminate the group: SIGTERM now, SIGKILL after the grace period.
    macro_rules! terminate {
        () => {
            signal_group(pgid, libc::SIGTERM);
            kill_at = Some(Instant::now() + KILL_GRACE);
        };
    }

    while exit.is_none() || out_open || err_open {
        tokio::select! {
            r = stdout.read(&mut b1), if out_open => match r {
                Ok(n) if n > 0 => {
                    out.push(&b1[..n]);
                    if split_lines { out_lines.feed(&b1[..n], |l| emit(StreamKind::Stdout, l)); }
                }
                _ => out_open = false,
            },
            r = stderr.read(&mut b2), if err_open => match r {
                Ok(n) if n > 0 => {
                    err.push(&b2[..n]);
                    if split_lines { err_lines.feed(&b2[..n], |l| emit(StreamKind::Stderr, l)); }
                }
                _ => err_open = false,
            },
            r = child.wait(), if exit.is_none() => {
                exit = Some(r.map_err(|e| EngineError::new(code::IO, format!("waiting for git failed: {e}")))?);
                drain_until = Some(Instant::now() + PIPE_DRAIN_GRACE);
            }
            _ = async { match &cancel { Some(c) if !cancelled => c.cancelled().await, _ => std::future::pending().await } } => {
                cancelled = true;
                terminate!();
            }
            _ = sleep_until_opt(timeout_at.filter(|_| !timed_out && !cancelled && exit.is_none())) => {
                timed_out = true;
                terminate!();
            }
            _ = sleep_until_opt(kill_at) => {
                signal_group(pgid, libc::SIGKILL);
                kill_at = None;
            }
            _ = sleep_until_opt(drain_until) => break,
        }
        if opts.kill_on_limit && (out.truncated || err.truncated) && kill_at.is_none() && exit.is_none() {
            terminate!();
        }
    }
    if split_lines {
        out_lines.finish(|l| emit(StreamKind::Stdout, l));
        err_lines.finish(|l| emit(StreamKind::Stderr, l));
    }
    guard.armed = false;

    Ok(RunResult {
        output: GitOutput { code: exit.and_then(|s| s.code()), stdout: out.buf, stderr: err.buf },
        truncated: out.truncated || err.truncated,
        timed_out,
        cancelled,
    })
}

/// Resolves a repo-relative path argument to an absolute path inside the repo. Rejects absolute paths, `..`, NUL and
/// symlink escapes (the final component is not followed, so a tracked symlink itself stays addressable).
pub fn resolve_in_repo(repo: &Path, rel: &str) -> Result<PathBuf, EngineError> {
    let bad = |why: &str| EngineError::new(code::INVALID_SELECTION, format!("path {rel:?} {why}"));
    if rel.is_empty() || rel.contains('\0') {
        return Err(bad("is empty or contains NUL"));
    }
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err(bad("is absolute"));
    }
    let mut clean = PathBuf::new();
    for c in rel_path.components() {
        match c {
            Component::Normal(p) => clean.push(p),
            Component::CurDir => {}
            _ => return Err(bad("leaves the repository")),
        }
    }
    let root = repo.canonicalize().map_err(|e| EngineError::new(code::REPO_MISSING, format!("{}: {e}", repo.display())))?;
    let full = root.join(&clean);
    // Canonicalise the deepest existing ancestor of the parent directory: it resolves intermediate symlinks.
    let mut anchor = full.parent().unwrap_or(&root).to_path_buf();
    while !anchor.exists() {
        if !anchor.pop() {
            break;
        }
    }
    let anchor = anchor.canonicalize().map_err(|e| EngineError::new(code::IO, e.to_string()))?;
    if !anchor.starts_with(&root) {
        return Err(bad("escapes the repository through a symlink"));
    }
    Ok(full)
}

/// Normalises a repo-relative path to the `/`-separated form used in git specs and arguments (drops `.` components);
/// fails on the same inputs as [`resolve_in_repo`].
pub fn clean_rel_path(rel: &str) -> Result<String, EngineError> {
    let bad = || EngineError::new(code::INVALID_SELECTION, format!("path {rel:?} is not inside the repository"));
    if rel.is_empty() || rel.contains('\0') || Path::new(rel).is_absolute() {
        return Err(bad());
    }
    let mut parts = Vec::new();
    for part in rel.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(bad()),
            p => parts.push(p),
        }
    }
    if parts.is_empty() {
        return Err(bad());
    }
    let trailing = rel.ends_with('/');
    Ok(parts.join("/") + if trailing { "/" } else { "" })
}

/// Failure classification from git/hook output text, used by commit, push, pull and fetch (heuristics from
/// spikes/commit-temp-index/RESULTS.md). The checks are ordered: an ssh failure prints both an auth line and
/// `Could not read from remote repository`, so auth wins over network.
pub fn is_lock_busy(text: &str) -> bool {
    text.contains("index.lock") && (text.contains("File exists") || text.contains("Another git process")) || text.contains("Unable to create") && text.contains(".lock': File exists")
}

pub fn is_auth_failure(text: &str) -> bool {
    const MARKERS: [&str; 11] = [
        "Authentication failed",
        "Permission denied (publickey",
        "Permission denied, please try again",
        "could not read Username",
        "could not read Password",
        "terminal prompts disabled",
        "Host key verification failed",
        "The requested URL returned error: 401",
        "The requested URL returned error: 403",
        "HTTP Basic: Access denied",
        "Invalid username or password",
    ];
    MARKERS.iter().any(|m| text.contains(m)) || (text.contains("Permission to ") && text.contains(" denied to "))
}

pub fn is_non_fast_forward(text: &str) -> bool {
    text.contains("[rejected]")
        || text.contains("(fetch first)")
        || text.contains("(non-fast-forward)")
        || text.contains("(stale info)")
        || text.contains("remote ref updated since checkout")
        || text.contains("Updates were rejected because")
        || text.contains("non-fast-forward")
}

pub fn is_remote_declined(text: &str) -> bool {
    text.contains("[remote rejected]")
        || text.contains("pre-receive hook declined")
        || text.contains("hook declined")
        || text.contains("protected branch")
        || text.contains("GH006")
        || text.contains("denied by remote")
}

pub fn is_network_error(text: &str) -> bool {
    const MARKERS: [&str; 11] = [
        "Could not resolve host",
        "Connection timed out",
        "Connection refused",
        "Connection reset",
        "Network is unreachable",
        "Operation timed out",
        "the remote end hung up unexpectedly",
        "early EOF",
        "unable to access",
        "Could not read from remote repository",
        "Failed to connect to",
    ];
    MARKERS.iter().any(|m| text.contains(m))
}

/// Explicit hook-failure markers (husky, lint-staged, git's own hook messages).
pub fn is_hook_rejected(text: &str) -> bool {
    text.contains("husky - ")
        && (text.contains("script failed") || text.contains("hook failed"))
        || text.contains("hook exited with")
        || text.contains("hook failed")
        || text.contains("pre-commit hook")
        || text.contains("pre-push hook")
        || text.contains("commit-msg hook")
        || text.contains("lint-staged") && (text.contains("[FAILED]") || text.contains("✖"))
}

/// A hook's own output can contain anything (`403`, `CONFLICT`, `unable to access`), so a plain exit 1 without a
/// `fatal:` line is decided before the text heuristics: git itself exits 128 on fatal errors. Git's own
/// nothing-to-commit report and a push that names a rejected ref are the exceptions.
fn hook_exit(kind: &OpKind, code: Option<i32>, stdout: &str, stderr: &str, text: &str) -> Option<FailureKind> {
    if code != Some(1) || text.lines().any(|l| l.trim_start().starts_with("fatal:")) {
        return None;
    }
    match kind {
        OpKind::Commit if !is_git_nothing_to_commit(stdout, stderr) => Some(FailureKind::HookRejected),
        OpKind::Push
            if text.contains("failed to push some refs") && !is_non_fast_forward(text) && !is_remote_declined(text) =>
        {
            Some(FailureKind::HookRejected)
        }
        _ => None,
    }
}

/// `git commit`'s own "nothing to commit" report: on stdout, no hook output on stderr, and it opens the output.
fn is_git_nothing_to_commit(stdout: &str, stderr: &str) -> bool {
    let first = stdout.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    stderr.trim().is_empty()
        && ["On branch ", "HEAD detached", "nothing ", "no changes added to commit", "Initial commit"]
            .iter()
            .any(|p| first.starts_with(p))
        && (stdout.contains("nothing to commit") || stdout.contains("no changes added to commit") || stdout.contains("nothing added to commit"))
}

/// Maps the output of a failed git run to a [`FailureKind`]. `kind` is the operation (commit: a non-zero exit without
/// `fatal:` and without a known cause is a hook failure, because git itself uses 128 for fatal errors; push: a failure
/// without ref lines is a hook abort).
pub fn classify_failure(kind: &OpKind, code: Option<i32>, stdout: &str, stderr: &str) -> FailureKind {
    let text = format!("{stderr}\n{stdout}");
    if is_lock_busy(&text) {
        return FailureKind::LockBusy;
    }
    if let Some(hook) = hook_exit(kind, code, stdout, stderr, &text) {
        return hook;
    }
    if is_auth_failure(&text) {
        return FailureKind::Auth;
    }
    if text.contains("unmerged files") || text.contains("CONFLICT") || text.contains("fix conflicts") {
        return FailureKind::Conflict;
    }
    if text.contains("nothing to commit") || text.contains("no changes added to commit") || text.contains("nothing added to commit") {
        return FailureKind::NothingToCommit;
    }
    if is_remote_declined(&text) {
        return FailureKind::RemoteDeclined;
    }
    if is_non_fast_forward(&text) {
        return FailureKind::NonFastForward;
    }
    if is_hook_rejected(&text) {
        return FailureKind::HookRejected;
    }
    if is_network_error(&text) {
        return FailureKind::Network;
    }
    match kind {
        OpKind::Commit if code == Some(1) && !text.contains("fatal:") => FailureKind::HookRejected,
        OpKind::Push if text.contains("failed to push some refs") => FailureKind::HookRejected,
        _ => FailureKind::Unknown,
    }
}

#[cfg(test)]
pub(crate) mod fixture {
    //! Throwaway repos for tests (contract section 9): isolated from the user's git config, identity "Fixture User".

    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::Arc;

    use super::*;
    use crate::env::{EnvOptions, EnvResolver};
    use crate::{EnvStatus, OpResult, RepoConfig, RepoSnapshot};

    pub struct NullSink;
    impl EventSink for NullSink {
        fn snapshot(&self, _: RepoSnapshot) {}
        fn op_event(&self, _: OpEvent) {}
        fn op_result(&self, _: OpResult) {}
        fn env(&self, _: EnvStatus) {}
    }

    #[derive(Default)]
    pub struct RecordingSink(pub std::sync::Mutex<Vec<OpEvent>>);
    impl EventSink for RecordingSink {
        fn snapshot(&self, _: RepoSnapshot) {}
        fn op_event(&self, e: OpEvent) {
            self.0.lock().unwrap().push(e);
        }
        fn op_result(&self, _: OpResult) {}
        fn env(&self, _: EnvStatus) {}
    }

    /// Makes every git spawned by this test process independent of the developer's git configuration.
    fn isolate_git_config() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            for (k, v) in [
                ("GIT_CONFIG_GLOBAL", "/dev/null"),
                ("GIT_CONFIG_SYSTEM", "/dev/null"),
                ("GIT_AUTHOR_NAME", "Fixture User"),
                ("GIT_AUTHOR_EMAIL", "fixture@example.invalid"),
                ("GIT_COMMITTER_NAME", "Fixture User"),
                ("GIT_COMMITTER_EMAIL", "fixture@example.invalid"),
            ] {
                std::env::set_var(k, v);
            }
        });
    }

    pub fn ctx_with(sink: Arc<dyn EventSink>) -> GitCtx {
        isolate_git_config();
        let git = pinned_git_path();
        let env = Arc::new(EnvResolver::with_options(&git.to_string_lossy(), EnvOptions { cache_path: None, ..Default::default() }));
        GitCtx::new(git, env, sink)
    }

    pub fn ctx() -> GitCtx {
        ctx_with(Arc::new(NullSink))
    }

    pub fn repo_config(path: &Path) -> RepoConfig {
        RepoConfig { id: "r1".into(), path: path.to_string_lossy().into_owned(), name: "fixture".into(), color: "#4caf7d".into(), badge: "FX".into(), order: 0, push_targets: Default::default() }
    }

    pub struct Fixture {
        pub dir: tempfile::TempDir,
        pub root: PathBuf,
    }

    impl Fixture {
        /// `git init -b main` with one empty initial commit.
        pub fn new() -> Self {
            let f = Self::unborn();
            f.git(&["commit", "--allow-empty", "-q", "-m", "init"]);
            f
        }

        pub fn unborn() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let root = dir.path().canonicalize().expect("canonical temp dir").join("repo");
            std::fs::create_dir_all(&root).unwrap();
            let f = Self { dir, root };
            f.git(&["init", "-q", "-b", "main"]);
            f
        }

        pub fn cmd(&self, args: &[&str]) -> Command {
            let mut c = Command::new(pinned_git_path());
            c.arg("-C").arg(&self.root).args(args);
            c.env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .env("GIT_AUTHOR_NAME", "Fixture User")
                .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
                .env("GIT_COMMITTER_NAME", "Fixture User")
                .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
                .env("LC_ALL", "C");
            c
        }

        /// Runs git in the fixture and returns trimmed stdout; panics on failure.
        pub fn git(&self, args: &[&str]) -> String {
            self.assert_inside();
            let out = self.cmd(args).output().expect("spawn git");
            assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_owned()
        }

        pub fn write(&self, rel: &str, content: impl AsRef<[u8]>) {
            let p = self.root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, content).unwrap();
        }

        pub fn commit_all(&self, msg: &str) {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", msg]);
        }

        pub fn config(&self) -> RepoConfig {
            repo_config(&self.root)
        }

        fn assert_inside(&self) {
            assert!(self.root.starts_with(self.dir.path().canonicalize().unwrap()), "fixture repo escaped its temp dir");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::*;
    use super::*;

    #[tokio::test]
    async fn run_git_collects_output_and_exit_code() {
        let f = Fixture::new();
        let out = run_git(&ctx(), &f.root, &["rev-parse", "--abbrev-ref", "HEAD"], &RunOpts { read_only: true, ..Default::default() }).await.unwrap();
        assert!(out.success());
        assert_eq!(out.stdout_text().trim(), "main");
        let bad = run_git(&ctx(), &f.root, &["cat-file", "-t", "nope"], &RunOpts::default()).await.unwrap();
        assert_eq!(bad.code, Some(128));
        assert!(bad.stderr_text().contains("fatal"));
        assert_eq!(bad.ok_or_err("cat-file").unwrap_err().code, code::GIT);
    }

    #[tokio::test]
    async fn fixed_environment_and_global_options_apply() {
        let f = Fixture::new();
        // `git var` GIT_EDITOR reflects the env; GIT_PAGER too. -c gc.auto/maintenance.auto are visible through `config`.
        let out = run_git(&ctx(), &f.root, &["var", "GIT_EDITOR"], &RunOpts::default()).await.unwrap();
        assert_eq!(out.stdout_text().trim(), ":");
        let out = run_git(&ctx(), &f.root, &["var", "GIT_PAGER"], &RunOpts::default()).await.unwrap();
        assert_eq!(out.stdout_text().trim(), "cat");
        let out = run_git(&ctx(), &f.root, &["config", "--get", "gc.auto"], &RunOpts::default()).await.unwrap();
        assert_eq!(out.stdout_text().trim(), "0");
        let out = run_git(&ctx(), &f.root, &["config", "--get", "maintenance.auto"], &RunOpts::default()).await.unwrap();
        assert_eq!(out.stdout_text().trim(), "false");
    }

    #[tokio::test]
    async fn inherited_git_dir_variables_are_scrubbed_and_extra_env_wins() {
        let f = Fixture::new();
        let mut opts = RunOpts::default();
        opts.extra_env.insert("GIT_INDEX_FILE".into(), f.root.join(".git/ide-index.test").to_string_lossy().into_owned());
        let out = run_git(&ctx(), &f.root, &["rev-parse", "--absolute-git-dir"], &opts).await.unwrap();
        assert!(out.success());
        let out = run_git(&ctx(), &f.root, &["rev-parse", "--git-path", "index"], &opts).await.unwrap();
        // --git-path honours GIT_INDEX_FILE, so the extra env reached git
        assert!(out.stdout_text().contains("ide-index.test"), "{}", out.stdout_text());
    }

    #[tokio::test]
    async fn stdin_is_piped() {
        let f = Fixture::new();
        let opts = RunOpts { stdin: Some(b"hello\n".to_vec()), ..Default::default() };
        let out = run_git(&ctx(), &f.root, &["hash-object", "--stdin"], &opts).await.unwrap();
        assert_eq!(out.stdout_text().trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
        // large stdin does not deadlock against a large stdout
        let big = vec![b'x'; 4 * 1024 * 1024];
        let opts = RunOpts { stdin: Some(big), ..Default::default() };
        let out = run_git(&ctx(), &f.root, &["hash-object", "--stdin"], &opts).await.unwrap();
        assert!(out.success());
    }

    #[tokio::test]
    async fn missing_repo_dir_is_an_error() {
        let f = Fixture::new();
        let e = run_git(&ctx(), &f.root.join("nope"), &["status"], &RunOpts::default()).await.unwrap_err();
        assert_eq!(e.code, code::REPO_MISSING);
    }

    #[tokio::test]
    async fn output_limit_truncates_and_can_kill() {
        let f = Fixture::new();
        f.write("big.bin", vec![b'a'; 200_000]);
        f.commit_all("big");
        let args = ["cat-file", "blob", "HEAD:big.bin"];
        let opts = RunOpts { max_output: Some(1000), ..Default::default() };
        let r = run_git_full(&ctx(), &f.root, &args, &opts, None).await.unwrap();
        assert!(r.truncated && r.output.stdout.len() == 1000 && r.output.success());
        let opts = RunOpts { max_output: Some(1000), kill_on_limit: true, ..Default::default() };
        let r = run_git_full(&ctx(), &f.root, &args, &opts, None).await.unwrap();
        assert!(r.truncated && r.output.stdout.len() == 1000);
    }

    /// A repo whose pre-commit hook blocks for a long time; it records the pids of the hook shell and of a background
    /// child (`sleep`) in `<pids>/hook` and `<pids>/bg`, and touches `<pids>/finished` if it ever completes.
    fn slow_hook_repo(pids: &Path) -> Fixture {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new();
        let hook = f.root.join(".git/hooks/pre-commit");
        let d = pids.display();
        std::fs::write(&hook, format!("#!/bin/sh\necho $$ > {d}/hook\nsleep 30 &\necho $! > {d}/bg\necho started\nsleep 30\ntouch {d}/finished\n")).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        f.write("a.txt", "a");
        f.git(&["add", "a.txt"]);
        f
    }

    fn pid_alive(pids: &Path, name: &str) -> bool {
        let pid: i32 = std::fs::read_to_string(pids.join(name)).unwrap_or_else(|_| panic!("{name} pid file")).trim().parse().unwrap();
        // SAFETY: signal 0 only probes for existence.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// Starting git plus its hook takes a while on a loaded machine: retry with a longer timeout until the hook got far
    /// enough to record its pids, so the assertions below are about the kill, not about start-up speed.
    async fn first_attempt_where_the_hook_started<F, Fut>(mut attempt: F) -> (tempfile::TempDir, Fixture)
    where
        F: FnMut(PathBuf, Duration) -> Fut,
        Fut: Future<Output = ()>,
    {
        let mut timeout = Duration::from_millis(1500);
        loop {
            let pids = tempfile::tempdir().unwrap();
            let f = slow_hook_repo(pids.path());
            attempt(f.root.clone(), timeout).await;
            if pids.path().join("bg").exists() {
                return (pids, f);
            }
            timeout *= 2;
            assert!(timeout < Duration::from_secs(20), "the hook never started");
        }
    }

    #[tokio::test]
    async fn timeout_kills_the_whole_process_group() {
        let started = std::time::Instant::now();
        let (pids, _f) = first_attempt_where_the_hook_started(|root, timeout| async move {
            let opts = RunOpts { timeout: Some(timeout), ..Default::default() };
            let r = run_git_full(&ctx(), &root, &["commit", "-m", "x"], &opts, None).await.unwrap();
            assert!(r.timed_out && !r.cancelled && r.output.code.is_none(), "{r:?}");
        })
        .await;
        assert!(started.elapsed() < Duration::from_secs(40));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!pids.path().join("finished").exists());
        assert!(!pid_alive(pids.path(), "hook") && !pid_alive(pids.path(), "bg"), "group member survived");
    }

    #[tokio::test]
    async fn cancel_sends_sigterm_to_the_group_and_reports_cancelled() {
        let pids = tempfile::tempdir().unwrap();
        let f = slow_hook_repo(pids.path());
        let cancel = CancelToken::default();
        let c = ctx().with_run(RunInfo { run_id: "run-1".into(), kind: OpKind::Commit, cancel: cancel.clone() });
        let started = std::time::Instant::now();
        let mut hook_said_started = false;
        let mut on_line = |stream: StreamKind, line: &str| {
            if stream == StreamKind::Stderr && line == "started" {
                hook_said_started = true;
                cancel.cancel();
            }
        };
        let r = run_git_full(&c, &f.root, &["commit", "-m", "x"], &RunOpts::default(), Some(&mut on_line)).await.unwrap();
        assert!(hook_said_started);
        assert!(r.cancelled && !r.timed_out && r.output.code.is_none(), "{r:?}");
        assert!(started.elapsed() < Duration::from_secs(8), "took {:?}", started.elapsed());
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!pids.path().join("finished").exists());
        assert!(!pid_alive(pids.path(), "hook") && !pid_alive(pids.path(), "bg"), "group member survived");
        assert!(c.is_cancelled());
    }

    #[tokio::test]
    async fn dropping_the_future_kills_the_process_group() {
        let (pids, _f) = first_attempt_where_the_hook_started(|root, timeout| async move {
            let (c, opts) = (ctx(), RunOpts::default());
            let fut = run_git(&c, &root, &["commit", "-m", "x"], &opts);
            assert!(tokio::time::timeout(timeout, fut).await.is_err(), "the hook is still running");
        })
        .await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!pid_alive(pids.path(), "hook") && !pid_alive(pids.path(), "bg"), "group member survived the drop");
    }

    #[tokio::test]
    async fn stream_to_run_emits_op_events_with_progress_percent() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let hook = f.root.join(".git/hooks/pre-commit");
        std::fs::write(&hook, "#!/bin/sh\necho out-line\nprintf 'Counting objects:  50%% (1/2)\\rCounting objects: 100%% (2/2)\\n' >&2\necho err-line >&2\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        f.write("a.txt", "a");
        f.git(&["add", "a.txt"]);
        let c = ctx_with(sink.clone()).with_run(RunInfo { run_id: "run-9".into(), kind: OpKind::Commit, cancel: CancelToken::default() });
        let opts = RunOpts {
            stream_to_run: true,
            stream_repo_id: Some("r1".into()),
            stream_status: Some(StepStatus::Hooks),
            login_env: true,
            ..Default::default()
        };
        let out = run_git(&c, &f.root, &["commit", "-m", "x"], &opts).await.unwrap();
        assert!(out.success());
        let ev = sink.0.lock().unwrap().clone();
        let texts: Vec<_> = ev.iter().map(|e| e.line.as_ref().unwrap().text.clone()).collect();
        assert!(texts.contains(&"out-line".to_owned()), "{texts:?}");
        assert!(texts.contains(&"err-line".to_owned()));
        assert!(ev.iter().all(|e| e.run_id == "run-9" && e.repo_id == "r1" && e.kind == OpKind::Commit));
        let pcts: Vec<_> = ev.iter().filter_map(|e| e.percent).collect();
        assert_eq!(pcts, vec![50.0, 100.0]);
    }

    #[tokio::test]
    async fn gate_hook_point_is_called_with_the_right_class() {
        struct Gate(std::sync::Mutex<Vec<SpawnClass>>);
        impl SpawnGate for Gate {
            fn acquire(&self, class: SpawnClass) -> Pin<Box<dyn Future<Output = Box<dyn Any + Send>> + Send + '_>> {
                self.0.lock().unwrap().push(class);
                Box::pin(async { Box::new(()) as Box<dyn Any + Send> })
            }
        }
        let f = Fixture::new();
        let gate = Arc::new(Gate(Default::default()));
        let c = ctx().with_gate(gate.clone());
        run_git(&c, &f.root, &["status"], &RunOpts::default()).await.unwrap();
        run_git(&c, &f.root, &["status"], &RunOpts { login_env: true, ..Default::default() }).await.unwrap();
        run_git(&c, &f.root, &["status"], &RunOpts { class: Some(SpawnClass::Network), ..Default::default() }).await.unwrap();
        assert_eq!(*gate.0.lock().unwrap(), vec![SpawnClass::Read, SpawnClass::Hook, SpawnClass::Network]);
    }

    #[tokio::test]
    async fn cancel_token_resolves_even_if_cancelled_before_waiting() {
        let t = CancelToken::default();
        t.cancel();
        tokio::time::timeout(Duration::from_millis(100), t.cancelled()).await.expect("already cancelled");
    }

    #[test]
    fn path_safety() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap().join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let outside = tmp.path().canonicalize().unwrap().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret"), root.join("link-to-file")).unwrap();

        assert_eq!(resolve_in_repo(&root, "src/a.rs").unwrap(), root.join("src/a.rs"));
        assert_eq!(resolve_in_repo(&root, "./src//a.rs").unwrap(), root.join("src/a.rs"));
        assert!(resolve_in_repo(&root, "new-dir/new.rs").is_ok(), "non-existent paths inside the repo are fine");
        assert!(resolve_in_repo(&root, "link-to-file").is_ok(), "the final symlink component is not followed");
        for bad in ["", "../x", "src/../../x", "/etc/passwd", "escape/secret", "escape/new/file", "a\0b", ".."] {
            let e = resolve_in_repo(&root, bad).unwrap_err();
            assert_eq!(e.code, code::INVALID_SELECTION, "{bad:?}");
        }
        assert_eq!(clean_rel_path("./a//b/./c.txt").unwrap(), "a/b/c.txt");
        assert_eq!(clean_rel_path("dir/").unwrap(), "dir/");
        assert!(clean_rel_path("a/../b").is_err() && clean_rel_path("/a").is_err() && clean_rel_path(".").is_err());
    }

    #[test]
    fn failure_classification_from_real_texts() {
        let lock = "fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository";
        assert!(is_lock_busy(lock));
        assert_eq!(classify_failure(&OpKind::Commit, Some(128), "", lock), FailureKind::LockBusy);

        let ssh = "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n";
        assert_eq!(classify_failure(&OpKind::Push, Some(128), "", ssh), FailureKind::Auth);
        let https = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
        assert_eq!(classify_failure(&OpKind::Fetch, Some(128), "", https), FailureKind::Auth);
        assert_eq!(classify_failure(&OpKind::Push, Some(128), "", "remote: Permission to a/b.git denied to user.\nfatal: unable to access"), FailureKind::Auth);

        let nff = "error: failed to push some refs to 'u'\nhint: Updates were rejected because the remote contains work that you do not";
        assert_eq!(classify_failure(&OpKind::Push, Some(1), "!\trefs/heads/a:refs/heads/a\t[rejected] (fetch first)\nDone\n", nff), FailureKind::NonFastForward);
        assert_eq!(classify_failure(&OpKind::Push, Some(1), "", "! [rejected]        a -> a (stale info)\nerror: failed to push some refs"), FailureKind::NonFastForward);

        let declined = "remote: policy says no\nTo u\n ! [remote rejected] a -> a (pre-receive hook declined)\nerror: failed to push some refs";
        assert_eq!(classify_failure(&OpKind::Push, Some(1), "", declined), FailureKind::RemoteDeclined);
        assert_eq!(classify_failure(&OpKind::Push, Some(1), "", "remote: error: GH006: Protected branch update failed"), FailureKind::RemoteDeclined);

        let net = "fatal: unable to access 'https://x/': Could not resolve host: x";
        assert_eq!(classify_failure(&OpKind::Fetch, Some(128), "", net), FailureKind::Network);
        assert_eq!(classify_failure(&OpKind::Push, Some(128), "", "fatal: the remote end hung up unexpectedly"), FailureKind::Network);

        // pre-push hook failure: only git's own summary line, no ref lines
        assert_eq!(classify_failure(&OpKind::Push, Some(1), "", "hook says no\nerror: failed to push some refs to 'u'"), FailureKind::HookRejected);
        // husky / lint-staged text and bare exit 1 on commit
        assert_eq!(classify_failure(&OpKind::Commit, Some(1), "", "husky - pre-commit script failed (code 1)"), FailureKind::HookRejected);
        assert_eq!(classify_failure(&OpKind::Commit, Some(1), "", "✖ eslint --fix:\nsome lint output"), FailureKind::HookRejected);
        assert_eq!(classify_failure(&OpKind::Commit, Some(1), "On branch main\nnothing to commit, working tree clean\n", ""), FailureKind::NothingToCommit);
        assert_eq!(classify_failure(&OpKind::Commit, Some(128), "", "error: Committing is not possible because you have unmerged files."), FailureKind::Conflict);
        assert_eq!(classify_failure(&OpKind::Commit, Some(128), "", "fatal: something odd"), FailureKind::Unknown);
        assert_eq!(classify_failure(&OpKind::Pull, Some(1), "", "weird"), FailureKind::Unknown);
    }

    #[test]
    fn hook_output_with_alarming_words_stays_a_hook_failure() {
        for noise in [
            "The requested URL returned error: 403",
            "CONFLICT markers found",
            "unable to access registry",
            "nothing to commit",
            "Could not resolve host: registry",
        ] {
            assert_eq!(classify_failure(&OpKind::Commit, Some(1), "", noise), FailureKind::HookRejected, "{noise}");
            let push = format!("{noise}\nerror: failed to push some refs to 'u'");
            assert_eq!(classify_failure(&OpKind::Push, Some(1), "", &push), FailureKind::HookRejected, "{noise}");
        }
        // hook output on stderr before git's own report is not "nothing to commit"
        assert_eq!(classify_failure(&OpKind::Commit, Some(1), "On branch main\nnothing to commit\n", "lint failed"), FailureKind::HookRejected);
    }
}
