//! Helpers shared by commit, push, pull and fetch: outcomes, git-dir lookups, in-progress state, failure text.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::exec::{run_git, GitCtx, GitOutput, RunOpts};
use crate::{code, EngineError, Failure, FailureKind, OpEvent, OpLine, RepoOutcome, StepStatus};

/// Output kept in a [`Failure`]: the tail is where git and hooks print the reason.
const OUTPUT_TAIL_BYTES: usize = 32 * 1024;

/// Why a step sequence stopped: a failure to report, or a cancel (committed work stays in place).
pub(crate) enum Stop {
    Failed(Failure),
    Cancelled,
}

impl Stop {
    pub fn failed(kind: FailureKind, message: impl Into<String>) -> Self {
        Stop::Failed(Failure { kind, message: message.into(), output: None })
    }

    pub fn with_output(kind: FailureKind, message: impl Into<String>, output: String) -> Self {
        Stop::Failed(Failure { kind, message: message.into(), output: Some(output) })
    }
}

impl From<EngineError> for Stop {
    fn from(e: EngineError) -> Self {
        let kind = match e.code.as_str() {
            code::CANCELLED => return Stop::Cancelled,
            code::LOCK_BUSY => FailureKind::LockBusy,
            code::HEAD_MOVED => FailureKind::HeadMoved,
            code::GUARD_BLOCKED => FailureKind::GuardBlocked,
            code::INVALID_SELECTION => FailureKind::InvalidSelection,
            _ => FailureKind::Unknown,
        };
        Stop::Failed(Failure { kind, message: e.message, output: e.detail })
    }
}

/// An outcome with nothing pending; callers fill in what differs.
pub(crate) fn outcome(repo_id: &str, status: StepStatus) -> RepoOutcome {
    RepoOutcome {
        repo_id: repo_id.to_owned(),
        status,
        commit_oid: None,
        reconciled: true,
        failure: None,
        hook_modified_files: Vec::new(),
        push_results: None,
    }
}

pub(crate) fn outcome_from_stop(repo_id: &str, stop: Stop) -> RepoOutcome {
    match stop {
        Stop::Cancelled => outcome(repo_id, StepStatus::Cancelled),
        Stop::Failed(f) => RepoOutcome { failure: Some(f), ..outcome(repo_id, StepStatus::Failed) },
    }
}

/// Sends a status transition (and optionally one line) of the bound run as `op:event`; a no-op without a run.
pub(crate) fn emit(ctx: &GitCtx, repo_id: &str, status: StepStatus, line: Option<OpLine>) {
    if let Some(run) = &ctx.run {
        ctx.sink.op_event(OpEvent {
            run_id: run.run_id.clone(),
            repo_id: repo_id.to_owned(),
            kind: run.kind.clone(),
            status,
            line,
            percent: None,
        });
    }
}

/// Emits the final per-repo status as an `op:event`, so rows update before the run's `op:result`.
pub(crate) fn finish(ctx: &GitCtx, outcome: RepoOutcome) -> RepoOutcome {
    emit(ctx, &outcome.repo_id, outcome.status.clone(), None);
    outcome
}

pub(crate) fn check_cancel(ctx: &GitCtx) -> Result<(), Stop> {
    if ctx.is_cancelled() {
        Err(Stop::Cancelled)
    } else {
        Ok(())
    }
}

/// Options that stream the call's output lines (and progress percent) as `op:event`s with `status`.
pub(crate) fn streaming(repo_id: &str, status: StepStatus) -> RunOpts {
    RunOpts {
        stream_to_run: true,
        stream_repo_id: Some(repo_id.to_owned()),
        stream_status: Some(status),
        ..Default::default()
    }
}

pub(crate) fn read_only() -> RunOpts {
    RunOpts { read_only: true, ..Default::default() }
}

pub(crate) fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

/// Runs git and turns a non-zero exit into a `git` error carrying stderr as detail.
pub(crate) async fn git_ok(
    ctx: &GitCtx,
    repo: &Path,
    args: &[&str],
    opts: &RunOpts,
) -> Result<GitOutput, EngineError> {
    run_git(ctx, repo, args, opts).await?.ok_or_err(&format!("git {}", args.first().copied().unwrap_or("")))
}

/// `GIT_INDEX_FILE=<path>` for a call that must run against a temp index.
pub(crate) fn index_env(index_file: &Path) -> HashMap<String, String> {
    HashMap::from([("GIT_INDEX_FILE".to_owned(), index_file.to_string_lossy().into_owned())])
}

/// `GIT_LITERAL_PATHSPECS=1`: names fed to git are paths, never globs or pathspec magic.
pub(crate) fn literal_env() -> HashMap<String, String> {
    HashMap::from([("GIT_LITERAL_PATHSPECS".to_owned(), "1".to_owned())])
}

pub(crate) fn exit_text(code: Option<i32>) -> String {
    code.map_or_else(|| "killed by a signal".to_owned(), |c| format!("exit {c}"))
}

/// stderr then stdout, last [`OUTPUT_TAIL_BYTES`] bytes only.
pub(crate) fn output_tail(out: &GitOutput) -> String {
    let mut all = Vec::with_capacity(out.stdout.len() + out.stderr.len() + 1);
    all.extend_from_slice(&out.stdout);
    if !out.stdout.is_empty() && !out.stderr.is_empty() {
        all.push(b'\n');
    }
    all.extend_from_slice(&out.stderr);
    let start = all.len().saturating_sub(OUTPUT_TAIL_BYTES);
    lossy(&all[start..]).trim().to_owned()
}

/// `git rev-parse --absolute-git-dir` (the per-worktree dir for linked worktrees).
pub(crate) async fn git_dir(ctx: &GitCtx, repo: &Path) -> Result<PathBuf, EngineError> {
    let out = git_ok(ctx, repo, &["rev-parse", "--absolute-git-dir"], &read_only()).await?;
    Ok(PathBuf::from(lossy(&out.stdout).trim_end_matches('\n')))
}

/// Full HEAD oid, `None` while the branch is unborn.
pub(crate) async fn head_oid(ctx: &GitCtx, repo: &Path) -> Result<Option<String>, EngineError> {
    rev_parse(ctx, repo, "HEAD").await
}

pub(crate) async fn rev_parse(ctx: &GitCtx, repo: &Path, rev: &str) -> Result<Option<String>, EngineError> {
    let out = run_git(ctx, repo, &["rev-parse", "-q", "--verify", rev], &read_only()).await?;
    Ok((out.code == Some(0)).then(|| lossy(&out.stdout).trim().to_owned()))
}

/// Name of the checked-out branch, `None` when HEAD is detached.
pub(crate) async fn current_branch(ctx: &GitCtx, repo: &Path) -> Result<Option<String>, EngineError> {
    let out = run_git(ctx, repo, &["symbolic-ref", "-q", "--short", "HEAD"], &read_only()).await?;
    Ok((out.code == Some(0)).then(|| lossy(&out.stdout).trim_end_matches('\n').to_owned()))
}

/// Name of an in-progress merge, cherry-pick, revert or rebase, from the markers in the git dir.
pub(crate) fn in_progress_state(git_dir: &Path) -> Option<&'static str> {
    [
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
    ]
    .into_iter()
    .find(|(marker, _)| git_dir.join(marker).exists())
    .map(|(_, name)| name)
}

/// Remote/branch names are interpolated into refspecs and argv, so they must not look like options.
pub(crate) fn check_ref_name(what: &str, name: &str) -> Result<(), EngineError> {
    if name.is_empty() || name.starts_with('-') || name.contains(['\0', '\n', ':', ' ']) {
        return Err(EngineError::new(code::GIT, format!("invalid {what}: {name:?}")));
    }
    Ok(())
}

/// A one-line, user-facing reason for a failure kind (the raw output travels separately).
pub(crate) fn failure_message(kind: &FailureKind, what: &str, code: Option<i32>) -> String {
    match kind {
        FailureKind::HookRejected => format!("A Git hook rejected the {what} ({})", exit_text(code)),
        FailureKind::NothingToCommit => "Nothing to commit".to_owned(),
        FailureKind::Conflict => format!("The {what} stopped on conflicts or unmerged files"),
        FailureKind::LockBusy => "Another git process holds .git/index.lock".to_owned(),
        FailureKind::Auth => "Authentication failed".to_owned(),
        FailureKind::NonFastForward => "The remote branch has commits that are not local (non-fast-forward)".to_owned(),
        FailureKind::RemoteDeclined => "The remote declined the update".to_owned(),
        FailureKind::Network => "Could not reach the remote".to_owned(),
        _ => format!("git {what} failed ({})", exit_text(code)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn option_like_ref_names_are_rejected() {
        assert!(check_ref_name("remote", "--upload-pack=x").is_err());
        assert!(check_ref_name("branch", "feature/x").is_ok());
        assert!(check_ref_name("branch", "a:b").is_err());
    }
}
