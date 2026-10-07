//! The cross-repo branch matrix and "same branch in all repos" create / switch.
//!
//! The track C `branches` backend does not exist yet; switching goes through `git checkout` here (which the jail's
//! exec guard knows as a mutating command). When that backend lands, `switch_repo` / `create_repo` are the two seams
//! to point at it.

use std::collections::BTreeMap;
use std::path::Path;

use intely_core::{EngineError, RepoId};

use crate::env::{git_error, invalid, Env};
use crate::rebase::op_state;
use crate::types::{
    BranchCell, BranchMatrix, BranchRow, InProgressOp, RepoBranchInfo, RepoOpResult, SameBranchResult,
};

pub const BRANCH_EXISTS: &str = "branchExists";
pub const BRANCH_MISSING: &str = "branchMissing";

#[derive(Debug, PartialEq)]
struct LocalBranch {
    name: String,
    current: bool,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    gone: bool,
}

/// `refname:short`, `upstream:short`, `upstream:track,nobracket`, `HEAD` separated by NUL.
fn parse_branches(text: &str) -> Vec<LocalBranch> {
    text.lines()
        .filter_map(|line| {
            let mut f = line.split('\0');
            let (name, upstream, track, head) = (f.next()?, f.next()?, f.next()?, f.next()?);
            let (mut ahead, mut behind, mut gone) = (0, 0, false);
            for part in track.split(',').map(str::trim) {
                if let Some(n) = part.strip_prefix("ahead ") {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix("behind ") {
                    behind = n.parse().unwrap_or(0);
                } else if part == "gone" {
                    gone = true;
                }
            }
            Some(LocalBranch {
                name: name.to_owned(),
                current: head.trim() == "*",
                upstream: Some(upstream.to_owned()).filter(|u| !u.is_empty()),
                ahead,
                behind,
                gone,
            })
        })
        .collect()
}

async fn local_branches(env: &Env, repo: &Path) -> Result<Vec<LocalBranch>, EngineError> {
    let out = env
        .read(
            repo,
            &["for-each-ref", "--format=%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)", "refs/heads"],
        )
        .await?;
    Ok(parse_branches(&out))
}

pub async fn matrix(env: &Env, repo_ids: &[RepoId]) -> Result<BranchMatrix, EngineError> {
    let ids: Vec<RepoId> = if repo_ids.is_empty() { env.ws.repos.iter().map(|r| r.id.clone()).collect() } else { repo_ids.to_vec() };
    let mut tasks = Vec::new();
    for id in &ids {
        let (env, id) = (env.clone(), id.clone());
        tasks.push(tokio::spawn(async move {
            let branches = match env.path(&id) {
                Ok(repo) => local_branches(&env, &repo).await,
                Err(e) => Err(e),
            };
            (id, branches)
        }));
    }
    let mut repos = Vec::new();
    let mut rows: BTreeMap<String, BTreeMap<RepoId, BranchCell>> = BTreeMap::new();
    for task in tasks {
        let (id, branches) = task.await.map_err(|e| EngineError::new(intely_core::code::IO, e.to_string()))?;
        let branches = branches?;
        let current = branches.iter().find(|b| b.current);
        repos.push(RepoBranchInfo {
            repo_id: id.clone(),
            current: current.map(|b| b.name.clone()),
            detached: current.is_none(),
            upstream: current.and_then(|b| b.upstream.clone()),
            ahead: current.map_or(0, |b| b.ahead),
            behind: current.map_or(0, |b| b.behind),
            gone: current.is_some_and(|b| b.gone),
        });
        for b in branches {
            rows.entry(b.name.clone()).or_default().insert(
                id.clone(),
                BranchCell { exists: true, current: b.current, upstream: b.upstream, ahead: b.ahead, behind: b.behind, gone: b.gone },
            );
        }
    }
    let branches = rows
        .into_iter()
        .map(|(name, mut cells)| {
            let in_all = ids.iter().all(|id| cells.contains_key(id));
            for id in &ids {
                cells.entry(id.clone()).or_insert(BranchCell { exists: false, current: false, upstream: None, ahead: 0, behind: 0, gone: false });
            }
            BranchRow { name, cells, in_all }
        })
        .collect();
    Ok(BranchMatrix { repos, branches })
}

async fn branch_exists(env: &Env, repo: &Path, name: &str) -> Result<bool, EngineError> {
    let spec = format!("refs/heads/{name}");
    Ok(env.run(repo, &["rev-parse", "--verify", "-q", "--end-of-options", &spec]).await?.success())
}

async fn valid_name(env: &Env, repo: &Path, name: &str) -> Result<(), EngineError> {
    if name.is_empty() || name.starts_with('-') {
        return Err(invalid(format!("{name:?} is not a valid branch name")));
    }
    if !env.run(repo, &["check-ref-format", "--branch", name]).await?.success() {
        return Err(invalid(format!("{name:?} is not a valid branch name")));
    }
    Ok(())
}

async fn preflight(env: &Env, repo_id: &str, name: &str, create: bool) -> Result<(), EngineError> {
    let repo = env.path(repo_id)?;
    env.git.jail.check_op(if create { "git checkout -b" } else { "git checkout" }, &repo)?;
    valid_name(env, &repo, name).await?;
    if op_state(env, repo_id).await?.kind != InProgressOp::None {
        return Err(EngineError::new(crate::rebase::OP_IN_PROGRESS, "a rebase or cherry-pick is in progress in this repository"));
    }
    match (branch_exists(env, &repo, name).await?, create) {
        (true, true) => Err(EngineError::new(BRANCH_EXISTS, format!("branch '{name}' already exists"))),
        (false, false) => Err(EngineError::new(BRANCH_MISSING, format!("branch '{name}' does not exist"))),
        _ => Ok(()),
    }
}

async fn create_repo(env: &Env, repo_id: &str, name: &str, start: Option<&str>) -> Result<(), EngineError> {
    let repo = env.path(repo_id)?;
    let mut args = vec!["checkout", "-b", name];
    if let Some(start) = start {
        crate::env::check_rev(start)?;
        args.push(start);
    }
    args.push("--");
    let out = env.write(&repo, &args, &[]).await?;
    if out.success() {
        Ok(())
    } else {
        Err(git_error("git checkout -b", &out))
    }
}

async fn switch_repo(env: &Env, repo_id: &str, name: &str) -> Result<(), EngineError> {
    let repo = env.path(repo_id)?;
    let out = env.write(&repo, &["checkout", name, "--"], &[]).await?;
    if out.success() {
        Ok(())
    } else {
        Err(git_error("git checkout", &out))
    }
}

/// Preflight in every repo first: if any fails nothing is changed (`applied: false`).
async fn same_branch(env: &Env, repo_ids: &[RepoId], name: &str, start: Option<&str>, create: bool) -> Result<SameBranchResult, EngineError> {
    if repo_ids.is_empty() {
        return Err(invalid("no repositories selected"));
    }
    let mut results: Vec<RepoOpResult> = Vec::new();
    for id in repo_ids {
        let error = preflight(env, id, name, create).await.err();
        results.push(RepoOpResult { repo_id: id.clone(), ok: error.is_none(), error });
    }
    if results.iter().any(|r| !r.ok) {
        return Ok(SameBranchResult { branch: name.to_owned(), applied: false, repos: results });
    }
    for r in &mut results {
        let done = if create { create_repo(env, &r.repo_id, name, start).await } else { switch_repo(env, &r.repo_id, name).await };
        if let Err(e) = done {
            r.ok = false;
            r.error = Some(e);
        }
    }
    Ok(SameBranchResult { branch: name.to_owned(), applied: true, repos: results })
}

pub async fn same_branch_create(env: &Env, repo_ids: &[RepoId], name: &str, start: Option<&str>) -> Result<SameBranchResult, EngineError> {
    same_branch(env, repo_ids, name, start, true).await
}

pub async fn same_branch_switch(env: &Env, repo_ids: &[RepoId], name: &str) -> Result<SameBranchResult, EngineError> {
    same_branch(env, repo_ids, name, None, false).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_tracking_is_parsed() {
        let text = "main\0origin/main\0ahead 2, behind 1\0*\ndev\0\0\0 \nold\0origin/old\0gone\0 \n";
        let b = parse_branches(text);
        assert_eq!((b[0].ahead, b[0].behind, b[0].current), (2, 1, true));
        assert_eq!(b[1].upstream, None);
        assert!(b[2].gone);
    }
}
