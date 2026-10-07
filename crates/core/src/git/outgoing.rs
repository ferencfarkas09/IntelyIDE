//! Push target resolution and outgoing commit lists (contract section 6.6).

use std::path::Path;

use crate::exec::GitCtx;
use crate::git::common::{current_branch, git_ok, lossy, read_only, rev_parse};
use crate::parse::log::{parse_log, LOG_FORMAT};
use crate::{code, CommitInfo, EngineError, RepoConfig};

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedTarget {
    pub local: String,
    pub remote: String,
    pub remote_branch: String,
}

/// Outgoing commit lists are capped, a first push of a long history would otherwise ship thousands of rows.
const MAX_OUTGOING: &str = "1000";

/// `workspace.pushTargets[local]` -> `@{push}` -> `@{u}` -> `origin/<local>`.
pub async fn resolve_target(ctx: &GitCtx, repo: &RepoConfig) -> Result<ResolvedTarget, EngineError> {
    let path = Path::new(&repo.path);
    let local = current_branch(ctx, path)
        .await?
        .ok_or_else(|| EngineError::new(code::GIT, "HEAD is detached, there is no branch to push"))?;
    if let Some(t) = repo.push_targets.get(&local) {
        return Ok(ResolvedTarget { local, remote: t.remote.clone(), remote_branch: t.branch.clone() });
    }
    let format = "--format=%(push)%00%(push:remotename)%00%(upstream)%00%(upstream:remotename)";
    let refname = format!("refs/heads/{local}");
    let out = git_ok(ctx, path, &["for-each-ref", format, &refname], &read_only()).await?;
    let text = lossy(&out.stdout);
    let fields: Vec<&str> = text.trim_end_matches('\n').split('\0').collect();
    if let [push, push_remote, upstream, upstream_remote] = fields[..] {
        for (full, remote) in [(push, push_remote), (upstream, upstream_remote)] {
            let prefix = format!("refs/remotes/{remote}/");
            if remote != "." && !remote.is_empty() {
                if let Some(branch) = full.strip_prefix(&prefix) {
                    return Ok(ResolvedTarget { local, remote: remote.to_owned(), remote_branch: branch.to_owned() });
                }
            }
        }
    }
    Ok(ResolvedTarget { remote: "origin".to_owned(), remote_branch: local.clone(), local })
}

/// Commits in `local` not on the remote branch; the flag is `newRemoteBranch` (tracking ref missing).
pub async fn outgoing_commits(
    ctx: &GitCtx,
    repo: &RepoConfig,
    target: &ResolvedTarget,
) -> Result<(Vec<CommitInfo>, bool), EngineError> {
    let path = Path::new(&repo.path);
    let local = format!("refs/heads/{}", target.local);
    let tracking = tracking_ref(target);
    let has_tracking = rev_parse(ctx, path, &tracking).await?.is_some();
    let range = format!("{tracking}..{local}");
    let remotes = format!("--remotes={}", target.remote);
    let format = format!("--format={LOG_FORMAT}");
    let mut args = vec!["log", "--no-color", "-n", MAX_OUTGOING, &format];
    if has_tracking {
        args.push(&range);
    } else {
        args.extend([local.as_str(), "--not", remotes.as_str()]);
    }
    args.push("--");
    let out = git_ok(ctx, path, &args, &read_only()).await?;
    Ok((parse_log(&out.stdout)?, !has_tracking))
}

/// `refs/remotes/<remote>/<branch>`
pub(crate) fn tracking_ref(target: &ResolvedTarget) -> String {
    format!("refs/remotes/{}/{}", target.remote, target.remote_branch)
}
