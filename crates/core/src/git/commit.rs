//! Temp-index commit (contract section 6.5; spec: spikes/commit-temp-index/RESULTS.md).

use std::collections::{BTreeMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::exec::{classify_failure, is_lock_busy, run_git, GitCtx, GitOutput, RunOpts};
use crate::git::common::{
    check_cancel, emit, failure_message, finish, git_dir, git_ok, head_oid, in_progress_state, index_env, literal_env,
    lossy, outcome, outcome_from_stop, output_tail, read_only, rev_parse, streaming, Stop,
};
use crate::git::stage;
use crate::{
    code, EngineError, Failure, FailureKind, FileSelection, GuardState, OpKind, RepoCommit, RepoConfig, RepoOutcome,
    StepStatus,
};

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Waits before each reconcile attempt: about 3 s in total when `index.lock` stays held.
const RECONCILE_BACKOFF_MS: [u64; 7] = [0, 50, 100, 200, 400, 800, 1200];

type Step<T> = Result<T, Stop>;

/// Commits one repo. Progress goes out as `op:event` through `ctx.run`; failures are reported inside the outcome.
pub async fn run_commit(
    ctx: &GitCtx,
    repo: &RepoConfig,
    repo_commit: &RepoCommit,
    no_verify: bool,
) -> RepoOutcome {
    let result = commit_steps(ctx, repo, repo_commit, no_verify).await;
    // A cancel kills whatever git call is running, which surfaces as an ordinary error: report the cancel.
    let result = match result {
        Err(Stop::Failed(_)) if ctx.is_cancelled() => Err(Stop::Cancelled),
        r => r,
    };
    finish(ctx, result.unwrap_or_else(|stop| outcome_from_stop(&repo.id, stop)))
}

/// HEAD message, for the Amend prefill; empty while the branch is unborn.
pub async fn last_message(ctx: &GitCtx, repo: &RepoConfig) -> Result<String, EngineError> {
    let path = Path::new(&repo.path);
    if head_oid(ctx, path).await?.is_none() {
        return Ok(String::new());
    }
    let out = git_ok(ctx, path, &["log", "-1", "--format=%B"], &read_only()).await?;
    Ok(lossy(&out.stdout).trim_end().to_owned())
}

/// Re-runs only the real-index reset of a commit that finished with `reconciled: false`.
pub async fn reconcile(ctx: &GitCtx, repo: &RepoConfig, files: &[FileSelection]) -> Result<(), EngineError> {
    let files = stage::normalise(files)?;
    reset_real_index(ctx, Path::new(&repo.path), &stage::touched_paths(&files)).await
}

async fn commit_steps(ctx: &GitCtx, repo: &RepoConfig, rc: &RepoCommit, no_verify: bool) -> Step<RepoOutcome> {
    let id = repo.id.as_str();
    let root = Path::new(&repo.path);
    if rc.message.trim().is_empty() {
        return Err(Stop::failed(FailureKind::EmptyMessage, "The commit message is empty"));
    }
    check_cancel(ctx)?;
    emit(ctx, id, StepStatus::Preparing, None);

    let files = stage::normalise(&rc.files)?;
    let touched = stage::touched_paths(&files);
    if files.is_empty() && !rc.amend {
        return Err(Stop::failed(FailureKind::NothingToCommit, "No files are selected"));
    }
    let gd = git_dir(ctx, root).await?;
    refuse_guarded(ctx, root, &gd, &files).await?;
    if let Some(state) = in_progress_state(&gd) {
        return plain_commit(ctx, repo, rc, &files, &gd, no_verify, state).await;
    }
    if gd.join("index.lock").exists() {
        return Err(Stop::failed(FailureKind::LockBusy, "Another git process holds .git/index.lock"));
    }
    refuse_unmerged(ctx, root).await?;

    let head0 = head_oid(ctx, root).await?;
    if rc.amend && head0.is_none() {
        return Err(Stop::failed(FailureKind::NothingToCommit, "There is no commit to amend"));
    }
    let temp = TempIndex::new(&gd);
    seed(ctx, root, &gd, &temp.path, head0.is_some()).await?;
    stage::apply_selection(ctx, repo, &temp.path, &files).await?;
    check_cancel(ctx)?;
    if head_oid(ctx, root).await? != head0 {
        return Err(Stop::failed(FailureKind::HeadMoved, "HEAD moved while the commit was being prepared"));
    }

    let before = hash_files(root, &touched).await;
    let status = if no_verify { StepStatus::Committing } else { StepStatus::Hooks };
    emit(ctx, id, status.clone(), None);
    let opts = RunOpts {
        stdin: Some(message_bytes(&rc.message)),
        login_env: true,
        extra_env: index_env(&temp.path),
        ..streaming(id, status)
    };
    let mut args = vec!["commit", "-F", "-", "--cleanup=whitespace"];
    if rc.amend {
        args.push("--amend");
    }
    if no_verify {
        args.push("--no-verify");
    }
    let out = run_git(ctx, root, &args, &opts).await?;
    drop(temp);

    // A cancelled context kills every further spawn, but the follow-up steps must still run.
    let settle = GitCtx { run: None, ..ctx.clone() };
    let head_now = head_oid(&settle, root).await?;
    // A cancel can land after git moved the ref but before it exited; the commit then exists and must be reconciled.
    let committed = out.code == Some(0) || (ctx.is_cancelled() && head_now != head0);
    if !committed {
        return Err(commit_failure(ctx, &out, no_verify));
    }

    emit(ctx, id, StepStatus::Reconciling, None);
    // A hook may `git add` more files into the temp index (formatters, codegen): they are in the commit too.
    let added = hook_added_paths(&settle, root, head0.as_deref(), &touched).await;
    let mut reset = touched.clone();
    reset.extend(added.iter().cloned());
    let reconciled = reset_real_index(&settle, root, &reset).await;
    let after = hash_files(root, &touched).await;
    let mut hook_modified_files: Vec<String> = touched.into_iter().filter(|p| before.get(p) != after.get(p)).collect();
    hook_modified_files.extend(added);
    let mut done = outcome(id, StepStatus::Done);
    done.commit_oid = head_now;
    done.hook_modified_files = hook_modified_files;
    if let Err(e) = reconciled {
        done.reconciled = false;
        done.failure = Some(Failure {
            kind: FailureKind::LockBusy,
            message: "Committed, but the index could not be updated; retry the reconcile".to_owned(),
            output: Some(e.detail.unwrap_or(e.message)),
        });
    }
    Ok(done)
}

/// Merge, cherry-pick, revert and rebase states: git would silently drop unchecked staged files from a temp-index
/// commit, so commit what the real index holds, as a plain `git commit` does. The ticked whole files are staged
/// first, so a resolved but unstaged edit lands in the commit; staged files that are not ticked are committed too.
/// That staging touches the real index, so the index is saved first and put back if the commit does not happen.
async fn plain_commit(
    ctx: &GitCtx,
    repo: &RepoConfig,
    rc: &RepoCommit,
    files: &[FileSelection],
    gd: &Path,
    no_verify: bool,
    state: &str,
) -> Step<RepoOutcome> {
    let root = Path::new(&repo.path);
    if files.iter().any(|f| matches!(f, FileSelection::Partial { .. })) {
        let msg = format!("A {state} is in progress: partial selection is not possible, commit whole files");
        return Err(Stop::failed(FailureKind::InvalidSelection, msg));
    }
    if rc.amend {
        return Err(Stop::failed(FailureKind::InvalidSelection, format!("Cannot amend while a {state} is in progress")));
    }
    refuse_unmerged(ctx, root).await?;
    refuse_guarded_staged(ctx, root, gd).await?;
    let backup = IndexBackup::save(gd)?;
    let head0 = head_oid(ctx, root).await?;
    let result = plain_commit_steps(ctx, repo, rc, files, gd, no_verify).await;
    // Whatever stopped the commit, the ticked-but-unstaged edits must not stay staged. A cancel that landed after
    // git moved the ref still produced the commit, and its index is the right one.
    let settle = GitCtx { run: None, ..ctx.clone() };
    let moved = head_oid(&settle, root).await.ok().is_some_and(|now| now != head0);
    match result {
        Ok(done) => Ok(done),
        Err(_) if moved => {
            let mut done = outcome(&repo.id, StepStatus::Done);
            done.commit_oid = head_oid(&settle, root).await?;
            Ok(done)
        }
        Err(stop) => {
            backup.restore().await;
            Err(stop)
        }
    }
}

async fn plain_commit_steps(
    ctx: &GitCtx,
    repo: &RepoConfig,
    rc: &RepoCommit,
    files: &[FileSelection],
    gd: &Path,
    no_verify: bool,
) -> Step<RepoOutcome> {
    let id = repo.id.as_str();
    let root = Path::new(&repo.path);
    if !files.is_empty() {
        stage::apply_selection(ctx, repo, &gd.join("index"), files).await?;
    }
    let status = if no_verify { StepStatus::Committing } else { StepStatus::Hooks };
    emit(ctx, id, status.clone(), None);
    let opts = RunOpts { stdin: Some(message_bytes(&rc.message)), login_env: true, ..streaming(id, status) };
    let mut args = vec!["commit", "-F", "-", "--cleanup=whitespace"];
    if no_verify {
        args.push("--no-verify");
    }
    let out = run_git(ctx, root, &args, &opts).await?;
    if out.code != Some(0) {
        return Err(commit_failure(ctx, &out, no_verify));
    }
    let mut done = outcome(id, StepStatus::Done);
    done.commit_oid = head_oid(ctx, root).await?;
    Ok(done)
}

/// Unmerged index entries (a conflicted merge, or a stash pop that left `UU` behind) cannot be committed.
async fn refuse_unmerged(ctx: &GitCtx, root: &Path) -> Step<()> {
    let unmerged = git_ok(ctx, root, &["ls-files", "-u", "-z"], &read_only()).await?;
    if unmerged.stdout.is_empty() {
        Ok(())
    } else {
        Err(Stop::failed(FailureKind::Conflict, "Unmerged files remain; resolve the conflicts first"))
    }
}

/// A plain commit takes the whole real index, so every staged path must pass the guard, ticked or not. Paths that
/// HEAD or the commit being merged/picked already has are not new, whatever their name looks like.
async fn refuse_guarded_staged(ctx: &GitCtx, root: &Path, gd: &Path) -> Step<()> {
    let staged = git_ok(ctx, root, &["diff", "--cached", "--no-renames", "--name-only", "-z"], &read_only()).await?;
    let staged: Vec<String> = staged.stdout.split(|&b| b == 0).filter(|s| !s.is_empty()).map(lossy).collect();
    let candidates: Vec<&str> =
        staged.iter().map(String::as_str).filter(|p| crate::guard::classify(p, true, None) != GuardState::Ok).collect();
    let existing = existing_paths(ctx, root, gd, &candidates).await?;
    let blocked: Vec<&str> = candidates.into_iter().filter(|p| is_blocked(p, !existing.contains(*p), None)).collect();
    if blocked.is_empty() {
        Ok(())
    } else {
        Err(Stop::failed(FailureKind::GuardBlocked, format!("Not allowed to commit: {}", blocked.join(", "))))
    }
}

fn is_blocked(path: &str, is_new: bool, size: Option<u64>) -> bool {
    !matches!(crate::guard::classify(path, is_new, size), GuardState::Ok | GuardState::Sensitive)
}

/// Which of `paths` exist in HEAD or, while an operation is in progress, in the commit it brings in. Everything else
/// is new to the repo. Only guard candidates are asked about, so a clean repo costs no extra git process.
async fn existing_paths(ctx: &GitCtx, root: &Path, gd: &Path, paths: &[&str]) -> Result<HashSet<String>, EngineError> {
    let mut existing = HashSet::new();
    if paths.is_empty() {
        return Ok(existing);
    }
    let mut revs = vec!["HEAD"];
    revs.extend(["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"].into_iter().filter(|m| gd.join(m).exists()));
    for rev in revs {
        if rev_parse(ctx, root, &format!("{rev}^{{tree}}")).await?.is_none() {
            continue;
        }
        for chunk in paths.chunks(500) {
            let mut args = vec!["ls-tree", "-r", "--name-only", "-z", rev, "--"];
            args.extend(chunk);
            let out = git_ok(ctx, root, &args, &read_only()).await?;
            existing.extend(out.stdout.split(|&b| b == 0).filter(|s| !s.is_empty()).map(lossy));
        }
    }
    Ok(existing)
}

/// Paths the new commit changed against `head0` that were not selected (added by a hook through the temp index).
async fn hook_added_paths(ctx: &GitCtx, root: &Path, head0: Option<&str>, touched: &[String]) -> Vec<String> {
    let mut args = vec!["diff-tree", "-r", "--no-commit-id", "--name-only", "-z", "--no-renames"];
    match head0 {
        Some(old) => args.extend([old, "HEAD"]),
        None => args.extend(["--root", "HEAD"]),
    }
    let Ok(out) = run_git(ctx, root, &args, &read_only()).await else { return Vec::new() };
    if out.code != Some(0) {
        return Vec::new();
    }
    let known: HashSet<&str> = touched.iter().map(String::as_str).collect();
    let mut added: Vec<String> = out
        .stdout
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(lossy)
        .filter(|p| !known.contains(p.as_str()))
        .collect();
    added.sort();
    added.dedup();
    added
}

fn message_bytes(message: &str) -> Vec<u8> {
    let mut m = message.as_bytes().to_vec();
    if !m.ends_with(b"\n") {
        m.push(b'\n');
    }
    m
}

/// Refuses never-add/secret/too-large files. Those rules apply to files new to the repo (not in HEAD); a tracked
/// file with a secret-looking name is only flagged `sensitive` for the UI. Whether a path is untracked comes from
/// the real index.
async fn refuse_guarded(ctx: &GitCtx, root: &Path, gd: &Path, files: &[FileSelection]) -> Step<()> {
    let tracked = git_ok(ctx, root, &["ls-files", "-z", "--cached"], &read_only()).await?;
    let tracked: HashSet<&[u8]> = tracked.stdout.split(|&b| b == 0).filter(|s| !s.is_empty()).collect();
    let path_of = |f: &FileSelection| match f {
        FileSelection::Whole { path, .. } | FileSelection::Partial { path, .. } => path.clone(),
    };
    let paths: Vec<String> = files.iter().map(path_of).collect();
    let candidates: Vec<&str> =
        paths.iter().map(String::as_str).filter(|p| crate::guard::classify(p, true, None) != GuardState::Ok).collect();
    let existing = existing_paths(ctx, root, gd, &candidates).await?;

    let mut blocked = Vec::new();
    for (f, path) in files.iter().zip(&paths) {
        let untracked = matches!(f, FileSelection::Whole { .. }) && !tracked.contains(path.as_bytes());
        let size = if untracked { std::fs::metadata(root.join(path)).ok().map(|m| m.len()) } else { None };
        if is_blocked(path, untracked || !existing.contains(path.as_str()), size) {
            blocked.push(path.as_str());
        }
    }
    if blocked.is_empty() {
        Ok(())
    } else {
        Err(Stop::failed(FailureKind::GuardBlocked, format!("Not allowed to commit: {}", blocked.join(", "))))
    }
}

/// A private copy of the index inside the git dir; removed (with its lock) when dropped.
struct TempIndex {
    path: PathBuf,
}

impl TempIndex {
    fn new(git_dir: &Path) -> Self {
        let n = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        Self { path: git_dir.join(format!("ide-index.{}.{n}", std::process::id())) }
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let mut lock = self.path.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(lock);
    }
}

/// The real index saved before a plain commit stages into it (`ide-index.<pid>.<n>.bak`, swept after a crash like the
/// temp indexes). Deleted when dropped; `restore` puts it back through `index.lock`, the way git replaces the index.
struct IndexBackup {
    saved: PathBuf,
    index: PathBuf,
}

impl IndexBackup {
    fn save(git_dir: &Path) -> Result<Self, EngineError> {
        let n = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let saved = git_dir.join(format!("ide-index.{}.{n}.bak", std::process::id()));
        let index = git_dir.join("index");
        if index.exists() {
            std::fs::copy(&index, &saved)?;
            // The racy-git check compares entry times with the index file's own time: keep it.
            if let Ok(modified) = std::fs::metadata(&index).and_then(|m| m.modified()) {
                let _ = std::fs::File::options().write(true).open(&saved).and_then(|f| f.set_modified(modified));
            }
        }
        Ok(Self { saved, index })
    }

    /// Best effort: with `index.lock` held for the whole backoff the index stays as the failed commit left it.
    async fn restore(&self) {
        if !self.saved.exists() {
            return;
        }
        let mut lock = self.index.clone().into_os_string();
        lock.push(".lock");
        let lock = PathBuf::from(lock);
        for wait in RECONCILE_BACKOFF_MS {
            tokio::time::sleep(Duration::from_millis(wait)).await;
            let Ok(mut file) = std::fs::File::options().write(true).create_new(true).open(&lock) else { continue };
            let copied = std::fs::File::open(&self.saved).and_then(|mut src| std::io::copy(&mut src, &mut file));
            let stamped = std::fs::metadata(&self.saved).and_then(|m| m.modified()).and_then(|t| file.set_modified(t));
            drop(file);
            if copied.is_ok() && stamped.is_ok() && std::fs::rename(&lock, &self.index).is_ok() {
                return;
            }
            let _ = std::fs::remove_file(&lock);
        }
    }
}

impl Drop for IndexBackup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.saved);
    }
}

/// Temp index = real index with every staged path reset to HEAD (cheap on big repos: `cp -p` keeps the stat data).
async fn seed(ctx: &GitCtx, root: &Path, gd: &Path, temp: &Path, has_head: bool) -> Result<(), EngineError> {
    let real = gd.join("index");
    let env = index_env(temp);
    if !has_head || !real.exists() {
        let args: &[&str] = if has_head { &["read-tree", "HEAD"] } else { &["read-tree", "--empty"] };
        git_ok(ctx, root, args, &RunOpts { extra_env: env, ..Default::default() }).await?;
        return Ok(());
    }
    tokio::fs::copy(&real, temp).await?;
    if let Ok(modified) = std::fs::metadata(&real).and_then(|m| m.modified()) {
        let _ = std::fs::File::options().write(true).open(temp).and_then(|f| f.set_modified(modified));
    }
    let staged = git_ok(
        ctx,
        root,
        &["diff", "--cached", "--no-renames", "--name-only", "-z", "HEAD"],
        &RunOpts { read_only: true, extra_env: env.clone(), ..Default::default() },
    )
    .await?;
    if !staged.stdout.is_empty() {
        let mut extra_env = env;
        extra_env.extend(literal_env());
        let opts = RunOpts { stdin: Some(staged.stdout), extra_env, ..Default::default() };
        git_ok(ctx, root, &["reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], &opts).await?;
    }
    Ok(())
}

/// `GIT_LITERAL_PATHSPECS=1 git reset` of the committed paths in the REAL index, retried while `index.lock` is held.
async fn reset_real_index(ctx: &GitCtx, root: &Path, paths: &[String]) -> Result<(), EngineError> {
    // An empty pathspec file means "no pathspec" to git, i.e. a full mixed reset that would unstage everything.
    if paths.is_empty() {
        return Ok(());
    }
    let mut stdin = Vec::new();
    for p in paths {
        stdin.extend_from_slice(p.as_bytes());
        stdin.push(0);
    }
    let mut last = EngineError::new(code::LOCK_BUSY, "index.lock is held");
    for wait in RECONCILE_BACKOFF_MS {
        tokio::time::sleep(Duration::from_millis(wait)).await;
        let opts = RunOpts {
            stdin: Some(stdin.clone()),
            extra_env: literal_env(),
            ..Default::default()
        };
        let out = run_git(ctx, root, &["reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], &opts).await?;
        if out.code == Some(0) {
            return Ok(());
        }
        let err = lossy(&out.stderr);
        let busy = is_lock_busy(&err);
        let kind = if busy { code::LOCK_BUSY } else { code::GIT };
        last = EngineError::new(kind, "git reset failed").with_detail(err.trim().to_owned());
        if !busy {
            break;
        }
    }
    Err(last)
}

/// SHA-256 of each file's bytes (`None` if unreadable), to find files a hook rewrote.
async fn hash_files(root: &Path, paths: &[String]) -> BTreeMap<String, Option<[u8; 32]>> {
    let root = root.to_path_buf();
    let paths = paths.to_vec();
    tokio::task::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|p| {
                let hash = std::fs::File::open(root.join(&p)).ok().and_then(|mut f| {
                    let mut hasher = Sha256::new();
                    let mut buf = [0u8; 64 * 1024];
                    loop {
                        match f.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => hasher.update(&buf[..n]),
                            Err(_) => return None,
                        }
                    }
                    Some(hasher.finalize().into())
                });
                (p, hash)
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Maps a failed `git commit` to a failure kind (exec's text heuristics; a hook is the usual cause of exit 1).
fn commit_failure(ctx: &GitCtx, out: &GitOutput, no_verify: bool) -> Stop {
    if ctx.is_cancelled() {
        return Stop::Cancelled;
    }
    let kind = match classify_failure(&OpKind::Commit, out.code, &out.stdout_text(), &out.stderr_text()) {
        FailureKind::HookRejected if no_verify => FailureKind::Unknown,
        k => k,
    };
    Stop::with_output(kind.clone(), failure_message(&kind, "commit", out.code), output_tail(out))
}
