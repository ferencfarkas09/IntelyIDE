//! Push planning and execution (contract section 6.6; spec: spikes/commit-temp-index/RESULTS.md).

use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

use regex::Regex;

use crate::exec::{classify_failure, run_git, GitCtx, GitOutput, RunOpts, SpawnClass};
use crate::git::common::{
    check_ref_name, current_branch, emit, failure_message, finish, git_dir, git_ok, head_oid, lossy, outcome,
    output_tail, read_only, rev_parse, streaming,
};
use crate::git::outgoing::{outgoing_commits, resolve_target, tracking_ref, ResolvedTarget};
use crate::parse::push::parse_push_porcelain;
use crate::{
    ChangeKind, ChangedFile, EngineError, FailureKind, OpKind, OpLine, OutgoingInfo, PushTarget, RepoConfig,
    RepoOutcome, StepStatus, StreamKind, TagsMode,
};

const LS_REMOTE_TIMEOUT: Duration = Duration::from_secs(30);
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

/// Outgoing commits for the repo's resolved push target. `refetch` runs `ls-remote` and a targeted fetch when stale.
pub async fn plan(
    ctx: &GitCtx,
    repo: &RepoConfig,
    protected_branches: &[String],
    refetch: bool,
) -> Result<OutgoingInfo, EngineError> {
    let path = Path::new(&repo.path);
    let blocked = |local: &str, remote: &str, remote_branch: &str, reason: String| OutgoingInfo {
        repo_id: repo.id.clone(),
        local: local.to_owned(),
        remote: remote.to_owned(),
        remote_branch: remote_branch.to_owned(),
        new_remote_branch: false,
        protected: false,
        commits: Vec::new(),
        stale_as_of_ms: None,
        checked_by_default: false,
        can_push: false,
        blocked_reason: Some(reason),
        remote_only: None,
        remote_oid: None,
    };
    let Some(local) = current_branch(ctx, path).await? else {
        return Ok(blocked("HEAD", "", "", "HEAD is detached, there is no branch to push".to_owned()));
    };
    if head_oid(ctx, path).await?.is_none() {
        return Ok(blocked(&local, "", "", "The branch has no commits yet".to_owned()));
    }
    let target = resolve_target(ctx, repo).await?;
    let url = run_git(ctx, path, &["config", "--get", &format!("remote.{}.url", target.remote)], &read_only()).await?;
    if url.code != Some(0) {
        let reason = format!("Remote '{}' is not configured", target.remote);
        return Ok(blocked(&local, &target.remote, &target.remote_branch, reason));
    }

    let fresh = refetch && refresh_tracking(ctx, path, &target).await;
    let stale_as_of_ms = if fresh { None } else { Some(last_fetch_ms(ctx, path).await) };
    let (commits, new_remote_branch) = outgoing_commits(ctx, repo, &target).await?;
    let protected = is_protected(ctx, path, &target, protected_branches).await;
    let remote_oid = rev_parse(ctx, path, &tracking_ref(&target)).await.ok().flatten();
    let remote_only = if remote_oid.is_some() { remote_only_count(ctx, path, &local, &target).await } else { None };
    Ok(OutgoingInfo {
        repo_id: repo.id.clone(),
        local,
        remote: target.remote,
        remote_branch: target.remote_branch,
        new_remote_branch,
        protected,
        checked_by_default: !commits.is_empty(),
        commits,
        stale_as_of_ms,
        can_push: true,
        blocked_reason: None,
        remote_only,
        remote_oid,
    })
}

/// `git rev-list --count <local>..<tracking ref>`: what a forced push would discard, as of the last fetch.
async fn remote_only_count(ctx: &GitCtx, path: &Path, local: &str, target: &ResolvedTarget) -> Option<u32> {
    let tracking = tracking_ref(target);
    let range = format!("refs/heads/{local}..{tracking}");
    let out = run_git(ctx, path, &["rev-list", "--count", &range], &read_only()).await.ok()?;
    if out.code != Some(0) {
        return None;
    }
    lossy(&out.stdout).trim().parse().ok()
}

/// `ls-remote` of the one branch; a targeted fetch only when the tracking ref differs. `false` when the remote
/// could not be asked or fetched.
async fn refresh_tracking(ctx: &GitCtx, path: &Path, target: &ResolvedTarget) -> bool {
    let full = format!("refs/heads/{}", target.remote_branch);
    let opts = RunOpts {
        read_only: true,
        login_env: true,
        class: Some(SpawnClass::Network),
        timeout: Some(LS_REMOTE_TIMEOUT),
        ..Default::default()
    };
    let args = ["ls-remote", "--exit-code", "--heads", target.remote.as_str(), full.as_str()];
    let Ok(out) = run_git(ctx, path, &args, &opts).await else { return false };
    match out.code {
        // rc 2: the branch does not exist on the remote yet
        Some(2) => return true,
        Some(0) => {}
        _ => return false,
    }
    let text = lossy(&out.stdout);
    let remote_oid = text.lines().find_map(|l| l.split_once('\t').filter(|(_, r)| *r == full).map(|(o, _)| o.to_owned()));
    let tracking = tracking_ref(target);
    if remote_oid.is_some() && remote_oid == rev_parse(ctx, path, &tracking).await.ok().flatten() {
        return true;
    }
    fetch_branch(ctx, path, target).await.is_ok_and(|o| o.code == Some(0))
}

/// `git fetch --no-tags <remote> +refs/heads/<rb>:refs/remotes/<remote>/<rb>`: updates only that tracking ref.
pub(crate) async fn fetch_branch(
    ctx: &GitCtx,
    path: &Path,
    target: &ResolvedTarget,
) -> Result<GitOutput, EngineError> {
    let refspec = format!("+refs/heads/{}:{}", target.remote_branch, tracking_ref(target));
    let opts = RunOpts {
        login_env: true,
        class: Some(SpawnClass::Network),
        timeout: Some(FETCH_TIMEOUT),
        ..Default::default()
    };
    run_git(ctx, path, &["fetch", "--no-tags", &target.remote, &refspec], &opts).await
}

/// Time of the last fetch (`FETCH_HEAD`), 0 if the repo never fetched.
async fn last_fetch_ms(ctx: &GitCtx, path: &Path) -> i64 {
    let Ok(gd) = git_dir(ctx, path).await else { return 0 };
    std::fs::metadata(gd.join("FETCH_HEAD"))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

fn glob_match(pattern: &str, text: &str) -> bool {
    let re = format!("^{}$", regex::escape(pattern).replace(r"\*", ".*"));
    Regex::new(&re).is_ok_and(|r| r.is_match(text))
}

/// Protected patterns plus the remote's HEAD branch.
async fn is_protected(ctx: &GitCtx, path: &Path, target: &ResolvedTarget, patterns: &[String]) -> bool {
    if patterns.iter().any(|p| glob_match(p, &target.remote_branch)) {
        return true;
    }
    let head_ref = format!("refs/remotes/{}/HEAD", target.remote);
    let Ok(out) = run_git(ctx, path, &["symbolic-ref", "-q", "--short", &head_ref], &read_only()).await else {
        return false;
    };
    let name = lossy(&out.stdout);
    out.code == Some(0) && name.trim().strip_prefix(&format!("{}/", target.remote)) == Some(&target.remote_branch)
}

/// Files changed by one outgoing commit (against its first parent for merges).
pub async fn commit_files(ctx: &GitCtx, repo: &RepoConfig, oid: &str) -> Result<Vec<ChangedFile>, EngineError> {
    if oid.len() < 4 || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(EngineError::new(crate::code::GIT, format!("not a commit id: {oid:?}")));
    }
    let args = ["log", "-1", "--format=", "-z", "--name-status", "-M", "-m", "--first-parent", oid, "--"];
    let out = git_ok(ctx, Path::new(&repo.path), &args, &read_only()).await?;
    Ok(parse_name_status(&out.stdout))
}

fn parse_name_status(raw: &[u8]) -> Vec<ChangedFile> {
    use unicode_normalization::UnicodeNormalization;
    let mut tokens = raw.split(|&b| b == 0).map(|t| lossy(t).trim_matches('\n').to_owned()).filter(|t| !t.is_empty());
    let mut files = Vec::new();
    while let Some(status) = tokens.next() {
        let kind = match status.chars().next() {
            Some('A') => ChangeKind::Added,
            Some('D') => ChangeKind::Deleted,
            Some('R') => ChangeKind::Renamed,
            Some('C') => ChangeKind::Copied,
            Some('T') => ChangeKind::TypeChanged,
            Some('U') => ChangeKind::Conflicted,
            _ => ChangeKind::Modified,
        };
        let two = matches!(kind, ChangeKind::Renamed | ChangeKind::Copied);
        let first = tokens.next();
        let (orig_path, path) = if two { (first, tokens.next()) } else { (None, first) };
        if let Some(path) = path {
            files.push(ChangedFile {
                path: path.nfc().collect(),
                orig_path: orig_path.map(|p| p.nfc().collect()),
                kind,
            });
        }
    }
    files
}

/// Pushes one target. Progress goes out as `op:event` through `ctx.run`; failures are reported inside the outcome.
pub async fn run_push(ctx: &GitCtx, repo: &RepoConfig, target: &PushTarget, no_verify: bool) -> RepoOutcome {
    let result = push_steps(ctx, repo, target, no_verify).await;
    finish(ctx, result)
}

async fn push_steps(ctx: &GitCtx, repo: &RepoConfig, target: &PushTarget, no_verify: bool) -> RepoOutcome {
    let id = repo.id.as_str();
    let failed = |kind: FailureKind, message: &str, output: Option<String>| RepoOutcome {
        failure: Some(crate::Failure { kind, message: message.to_owned(), output }),
        ..outcome(id, StepStatus::Failed)
    };
    let path = Path::new(&repo.path);
    if ctx.is_cancelled() {
        return outcome(id, StepStatus::Cancelled);
    }
    for (what, name) in [("remote", &target.remote), ("branch", &target.remote_branch)] {
        if let Err(e) = check_ref_name(what, name) {
            return failed(FailureKind::Unknown, &e.message, None);
        }
    }
    let local = match current_branch(ctx, path).await {
        Ok(Some(b)) => b,
        Ok(None) => return failed(FailureKind::Unknown, "HEAD is detached, there is no branch to push", None),
        Err(e) => return failed(FailureKind::Unknown, &e.message, e.detail),
    };

    emit(ctx, id, StepStatus::Pushing, None);
    let refspec = format!("refs/heads/{local}:refs/heads/{}", target.remote_branch);
    let mut args: Vec<String> = ["push", "--porcelain", "--progress"].map(String::from).to_vec();
    if no_verify {
        args.push("--no-verify".to_owned());
    }
    match target.tags {
        TagsMode::None => {}
        TagsMode::Follow => args.push("--follow-tags".to_owned()),
        TagsMode::All => args.push("--tags".to_owned()),
    }
    if let Some(lease) = &target.force_with_lease {
        // The UI does not know the remote tip: an empty id means "the tracking ref as last fetched" (the push plan
        // refetches). The lease then names only the ref and `--force-if-includes` refuses a tip that the local
        // branch never contained, so a fetch between the plan and the push cannot move the lease past a
        // colleague's commit. An explicit id is used verbatim (and `--force-if-includes` would be a no-op, P3).
        let implicit = lease.seen_oid.is_empty();
        let seen = if implicit {
            match tracking_tip(ctx, path, &target.remote, &target.remote_branch).await {
                Some(oid) => oid,
                None => return failed(FailureKind::Unknown, "The remote branch is not known locally, fetch it before forcing", None),
            }
        } else {
            lease.seen_oid.clone()
        };
        if seen.len() < 4 || !seen.bytes().all(|b| b.is_ascii_hexdigit()) {
            return failed(FailureKind::Unknown, "The lease commit id is not a valid object id", None);
        }
        warn_if_lease_drops_commits(ctx, path, id, &local, &seen).await;
        if implicit {
            args.push(format!("--force-with-lease=refs/heads/{}", target.remote_branch));
            args.push("--force-if-includes".to_owned());
        } else {
            args.push(format!("--force-with-lease=refs/heads/{}:{seen}", target.remote_branch));
        }
    }
    args.extend([target.remote.clone(), refspec]);
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let opts = RunOpts {
        login_env: true,
        class: Some(SpawnClass::Network),
        ..streaming(id, StepStatus::Pushing)
    };
    let out = match run_git(ctx, path, &argv, &opts).await {
        Ok(o) => o,
        Err(e) => return failed(FailureKind::Unknown, &e.message, e.detail),
    };

    let results = parse_push_porcelain(&lossy(&out.stdout)).unwrap_or_default();
    if out.code == Some(0) {
        return RepoOutcome { push_results: Some(results), ..outcome(id, StepStatus::Done) };
    }
    if ctx.is_cancelled() {
        return outcome(id, StepStatus::Cancelled);
    }
    let kind = push_failure_kind(&out, no_verify);
    let message = failure_message(&kind, "push", out.code);
    RepoOutcome { push_results: Some(results), ..failed(kind, &message, Some(output_tail(&out))) }
}

/// `--porcelain` prints `Done` even when refs are rejected, so the exit code decides success and this only
/// names the reason.
fn push_failure_kind(out: &GitOutput, no_verify: bool) -> FailureKind {
    match classify_failure(&OpKind::Push, out.code, &out.stdout_text(), &out.stderr_text()) {
        FailureKind::HookRejected if no_verify => FailureKind::Unknown,
        k => k,
    }
}

async fn tracking_tip(ctx: &GitCtx, path: &Path, remote: &str, branch: &str) -> Option<String> {
    let reference = format!("refs/remotes/{remote}/{branch}");
    let out = run_git(ctx, path, &["rev-parse", "--verify", "-q", &reference], &read_only()).await.ok()?;
    (out.code == Some(0)).then(|| out.stdout_text().trim().to_owned())
}

/// `--force-if-includes` is a no-op with an explicit-oid lease, so the engine warns instead (RESULTS.md P3).
async fn warn_if_lease_drops_commits(ctx: &GitCtx, path: &Path, id: &str, local: &str, seen: &str) {
    let local_ref = format!("refs/heads/{local}");
    let ancestor = run_git(ctx, path, &["merge-base", "--is-ancestor", seen, &local_ref], &read_only()).await;
    if ancestor.is_ok_and(|o| o.code == Some(0)) {
        return;
    }
    let text = format!("warning: remote commit {seen} is not part of {local}; the forced push discards remote work");
    emit(ctx, id, StepStatus::Pushing, Some(OpLine { stream: StreamKind::Stderr, text }));
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn out(code: i32, stdout: &str, stderr: &str) -> GitOutput {
        GitOutput { code: Some(code), stdout: stdout.as_bytes().to_vec(), stderr: stderr.as_bytes().to_vec() }
    }

    #[test]
    fn push_failures_map_to_kinds() {
        let rejected = "!\trefs/heads/a:refs/heads/b\t[rejected] (fetch first)\nDone\n";
        assert_eq!(push_failure_kind(&out(1, rejected, ""), false), FailureKind::NonFastForward);
        let declined = "!\trefs/heads/a:refs/heads/b\t[remote rejected] (pre-receive hook declined)\nDone\n";
        assert_eq!(push_failure_kind(&out(1, declined, ""), false), FailureKind::RemoteDeclined);
        let hook = out(1, "", "error: failed to push some refs to 'x'");
        assert_eq!(push_failure_kind(&hook, false), FailureKind::HookRejected);
        assert_eq!(push_failure_kind(&hook, true), FailureKind::Unknown);
        let net = out(128, "", "fatal: unable to access 'https://h/': Could not resolve host: h");
        assert_eq!(push_failure_kind(&net, false), FailureKind::Network);
        let auth = out(128, "", "git@h: Permission denied (publickey).\nfatal: Could not read from remote repository.");
        assert_eq!(push_failure_kind(&auth, false), FailureKind::Auth);
    }

    #[test]
    fn name_status_handles_renames_and_merge_noise() {
        let raw = b"M\0src/a.rs\0A\0new.txt\0R100\0old name.txt\0new name.txt\0D\0gone\0";
        let f = parse_name_status(raw);
        assert_eq!(f.len(), 4);
        assert_eq!((f[2].kind.clone(), f[2].orig_path.as_deref(), f[2].path.as_str()), (ChangeKind::Renamed, Some("old name.txt"), "new name.txt"));
        assert_eq!(f[3].kind, ChangeKind::Deleted);
    }

    #[test]
    fn protected_globs() {
        assert!(glob_match("release/*", "release/1.2"));
        assert!(glob_match("main", "main"));
        assert!(!glob_match("main", "mainline"));
        assert!(!glob_match("release/*", "my-release/1"));
        assert!(glob_match("a.b", "a.b") && !glob_match("a.b", "aXb"));
    }
}
