//! Pull and fetch of one repo (network lane).

use std::path::Path;
use std::time::Duration;

use crate::exec::{classify_failure, run_git, GitCtx, GitOutput, RunOpts, SpawnClass};
use crate::git::common::{
    check_cancel, check_ref_name, current_branch, emit, failure_message, finish, git_dir, git_ok, in_progress_state,
    outcome, outcome_from_stop, output_tail, read_only, streaming, Stop,
};
use crate::git::outgoing::{resolve_target, tracking_ref, ResolvedTarget};
use crate::{Failure, FailureKind, OpKind, PullMode, RepoConfig, RepoOutcome, StepStatus};

const FETCH_TIMEOUT: Duration = Duration::from_secs(120);

/// Fetches the repo's target branch (upstream or push-target mapping) and merges it as `mode` says;
/// `FfOnly` fails with `nonFastForward` when the branches diverged. Refused while a merge/rebase is in progress.
pub async fn pull(ctx: &GitCtx, repo: &RepoConfig, mode: PullMode) -> RepoOutcome {
    let result = match pull_steps(ctx, repo, mode).await {
        Ok(o) => o,
        Err(stop) => outcome_from_stop(&repo.id, stop),
    };
    finish(ctx, result)
}

/// Targeted fetch: only the target branch's tracking ref is updated, no tags.
pub async fn fetch(ctx: &GitCtx, repo: &RepoConfig) -> RepoOutcome {
    let result = match fetch_steps(ctx, repo).await {
        Ok(o) => o,
        Err(stop) => outcome_from_stop(&repo.id, stop),
    };
    finish(ctx, result)
}

async fn target_of(ctx: &GitCtx, repo: &RepoConfig) -> Result<ResolvedTarget, Stop> {
    let path = Path::new(&repo.path);
    if current_branch(ctx, path).await?.is_none() {
        return Err(Stop::failed(FailureKind::Unknown, "HEAD is detached, there is no branch to update"));
    }
    let target = resolve_target(ctx, repo).await?;
    check_ref_name("remote", &target.remote)?;
    check_ref_name("branch", &target.remote_branch)?;
    Ok(target)
}

async fn fetch_steps(ctx: &GitCtx, repo: &RepoConfig) -> Result<RepoOutcome, Stop> {
    let id = repo.id.as_str();
    let path = Path::new(&repo.path);
    check_cancel(ctx)?;
    let target = target_of(ctx, repo).await?;
    emit(ctx, id, StepStatus::Preparing, None);
    let refspec = format!("+refs/heads/{}:{}", target.remote_branch, tracking_ref(&target));
    let args = ["fetch", "--no-tags", "--progress", target.remote.as_str(), refspec.as_str()];
    let opts = RunOpts {
        login_env: true,
        class: Some(SpawnClass::Network),
        timeout: Some(FETCH_TIMEOUT),
        ..streaming(id, StepStatus::Preparing)
    };
    let out = run_git(ctx, path, &args, &opts).await?;
    finish_network(ctx, id, &out, "fetch")
}

async fn pull_steps(ctx: &GitCtx, repo: &RepoConfig, mode: PullMode) -> Result<RepoOutcome, Stop> {
    let id = repo.id.as_str();
    let path = Path::new(&repo.path);
    check_cancel(ctx)?;
    let gd = git_dir(ctx, path).await?;
    if let Some(state) = in_progress_state(&gd) {
        return Err(Stop::failed(FailureKind::Conflict, format!("A {state} is in progress; finish or abort it first")));
    }
    let unmerged = git_ok(ctx, path, &["ls-files", "-u", "-z"], &read_only()).await?;
    if !unmerged.stdout.is_empty() {
        return Err(Stop::failed(FailureKind::Conflict, "Unmerged files remain; resolve the conflicts first"));
    }
    let target = target_of(ctx, repo).await?;
    emit(ctx, id, StepStatus::Preparing, None);
    let strategy = match mode {
        PullMode::FfOnly => "--ff-only",
        PullMode::Merge => "--no-rebase",
        PullMode::Rebase => "--rebase",
    };
    let mut args = vec!["pull", "--progress", strategy];
    if mode == PullMode::Merge {
        args.push("--no-edit");
    }
    let refspec = format!("refs/heads/{}", target.remote_branch);
    args.extend([target.remote.as_str(), refspec.as_str()]);
    let opts = RunOpts { login_env: true, class: Some(SpawnClass::Network), ..streaming(id, StepStatus::Preparing) };
    let out = run_git(ctx, path, &args, &opts).await?;
    finish_network(ctx, id, &out, "pull")
}

fn finish_network(ctx: &GitCtx, id: &str, out: &GitOutput, what: &str) -> Result<RepoOutcome, Stop> {
    if out.code == Some(0) {
        return Ok(outcome(id, StepStatus::Done));
    }
    if ctx.is_cancelled() {
        return Err(Stop::Cancelled);
    }
    let kind = match classify_failure(&OpKind::Fetch, out.code, &out.stdout_text(), &out.stderr_text()) {
        FailureKind::HookRejected => FailureKind::Unknown,
        k => k,
    };
    let err = out.stderr_text();
    let kind = match kind {
        FailureKind::Unknown if is_diverged(&err) => FailureKind::NonFastForward,
        FailureKind::Unknown if err.contains("would be overwritten") || err.contains("local changes") => {
            FailureKind::Conflict
        }
        k => k,
    };
    let message = match kind {
        FailureKind::NonFastForward if what == "pull" => "The branches diverged; fast-forward is not possible".to_owned(),
        _ => failure_message(&kind, what, out.code),
    };
    Ok(RepoOutcome { failure: Some(Failure { kind, message, output: Some(output_tail(out)) }), ..outcome(id, StepStatus::Failed) })
}

/// `git pull --ff-only` on diverged branches.
fn is_diverged(stderr: &str) -> bool {
    stderr.contains("Not possible to fast-forward") || stderr.contains("diverging branches")
}
