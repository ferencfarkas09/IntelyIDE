//! Branch hygiene (#20): which local branches are merged into the default branch or stale, a safe delete behind a typed
//! confirmation, and the tag list. Deleting is jail-checked, refuses the current, default, protected and live branches and
//! anything not merged, and never forces (`git branch -d`). Nothing here talks to a remote.

use std::path::Path;

use intely_core::jail::{glob_match, Jail};
use intely_core::{code, EngineError};

use crate::git::{self, ref_exists};
use crate::types::{BranchRow, Hygiene, TagRow};

/// Always protected, on top of the workspace's `protectedBranches` and the repo's `liveBranches`.
pub const ALWAYS_PROTECTED: [&str; 5] = ["main", "master", "production", "develop", "release/*"];
const MAX_BRANCHES: usize = 200;
const MAX_TAGS: usize = 100;
pub const DEFAULT_STALE_DAYS: u32 = 60;

fn err(code_: &str, msg: impl Into<String>) -> EngineError {
    EngineError::new(code_, msg.into())
}

pub fn is_protected(name: &str, patterns: &[String], default: Option<&str>) -> bool {
    default == Some(name) || ALWAYS_PROTECTED.iter().any(|p| glob_match(p, name)) || patterns.iter().any(|p| glob_match(p, name))
}

/// The default branch: what `origin/HEAD` points at, else `main`/`master`/`develop`, else the current branch.
pub fn default_branch(jail: &Jail, repo: &Path) -> Option<String> {
    if let Ok(o) = git::run(jail, repo, &["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]) {
        if o.ok {
            if let Some(b) = o.stdout.trim().strip_prefix("origin/") {
                if !b.is_empty() {
                    return Some(b.to_owned());
                }
            }
        }
    }
    ["main", "master", "develop"].into_iter().find(|b| ref_exists(jail, repo, &format!("refs/heads/{b}"))).map(str::to_owned).or_else(|| current_branch(jail, repo))
}

pub fn current_branch(jail: &Jail, repo: &Path) -> Option<String> {
    let o = git::run(jail, repo, &["symbolic-ref", "-q", "--short", "HEAD"]).ok()?;
    let b = o.stdout.trim();
    (o.ok && !b.is_empty()).then(|| b.to_owned())
}

/// The ref merges are judged against: the local default branch, else `origin/<default>`.
fn base_ref(jail: &Jail, repo: &Path, default: &str) -> Option<String> {
    [format!("refs/heads/{default}"), format!("refs/remotes/origin/{default}")].into_iter().find(|r| ref_exists(jail, repo, r)).map(|r| r.trim_start_matches("refs/heads/").trim_start_matches("refs/remotes/").to_owned())
}

fn merged_set(jail: &Jail, repo: &Path, base: &str) -> Vec<String> {
    git::read(jail, repo, &["branch", "--merged", base, "--format=%(refname:short)"]).map(|s| s.lines().map(|l| l.trim().to_owned()).filter(|l| !l.is_empty()).collect()).unwrap_or_default()
}

fn counts(jail: &Jail, repo: &Path, base: &str, name: &str) -> (u32, u32) {
    let range = format!("{base}...{name}");
    let Ok(o) = git::run(jail, repo, &["rev-list", "--left-right", "--count", &range]) else { return (0, 0) };
    let mut it = o.stdout.split_whitespace().filter_map(|n| n.parse::<u32>().ok());
    let behind = it.next().unwrap_or(0);
    let ahead = it.next().unwrap_or(0);
    (ahead, behind)
}

/// Local branches with merged / stale / ahead-behind facts, plus the tags. `now` is Unix seconds (a parameter for tests).
pub fn report(jail: &Jail, repo_id: &str, repo: &Path, patterns: &[String], stale_days: u32, now: i64) -> Result<Hygiene, EngineError> {
    let default = default_branch(jail, repo);
    let current = current_branch(jail, repo);
    let base = default.as_deref().and_then(|d| base_ref(jail, repo, d));
    let merged = base.as_deref().map(|b| merged_set(jail, repo, b)).unwrap_or_default();
    let listing = git::read(
        jail,
        repo,
        &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)\t%(committerdate:unix)\t%(upstream:short)\t%(upstream:track)\t%(subject)", "refs/heads"],
    )?;
    let mut branches = Vec::new();
    for line in listing.lines().take(MAX_BRANCHES) {
        let mut f = line.splitn(5, '\t');
        let name = f.next().unwrap_or("").to_owned();
        if name.is_empty() {
            continue;
        }
        let ts: i64 = f.next().and_then(|t| t.parse().ok()).unwrap_or(0);
        let upstream = f.next().filter(|u| !u.is_empty()).map(str::to_owned);
        let gone = f.next().is_some_and(|t| t.contains("gone"));
        let subject = f.next().unwrap_or("").to_owned();
        let is_current = current.as_deref() == Some(name.as_str());
        let protected = is_protected(&name, patterns, default.as_deref());
        let is_merged = merged.contains(&name);
        let (ahead, behind) = match base.as_deref() {
            Some(b) if default.as_deref() != Some(name.as_str()) => counts(jail, repo, b, &name),
            _ => (0, 0),
        };
        let age_days = ((now - ts).max(0) / 86_400) as u32;
        let blocked = if is_current {
            Some("current branch".to_owned())
        } else if protected {
            Some("protected or live branch".to_owned())
        } else if base.is_none() {
            Some("no default branch to compare with".to_owned())
        } else if !is_merged {
            Some("not merged into the default branch".to_owned())
        } else {
            None
        };
        branches.push(BranchRow {
            current: is_current,
            protected,
            merged: is_merged,
            ahead,
            behind,
            last_commit_ts: ts,
            age_days,
            subject,
            upstream,
            upstream_gone: gone,
            stale: !is_current && !protected && age_days >= stale_days,
            deletable: blocked.is_none(),
            blocked,
            name,
        });
    }
    let tags = git::read(jail, repo, &["for-each-ref", "--sort=-creatordate", &format!("--count={MAX_TAGS}"), "--format=%(refname:short)\t%(creatordate:unix)\t%(objecttype)\t%(subject)", "refs/tags"])?
        .lines()
        .filter_map(|l| {
            let mut f = l.splitn(4, '\t');
            let name = f.next()?.to_owned();
            Some(TagRow { name, ts: f.next()?.parse().ok()?, annotated: f.next()? == "tag", subject: f.next().unwrap_or("").to_owned() })
        })
        .collect();
    Ok(Hygiene { repo_id: repo_id.to_owned(), default_branch: default, stale_days, branches, tags })
}

/// Deletes a merged, non-protected, non-current local branch after the user typed its name. Returns a one-line note with
/// the tip it pointed at, so the delete can be undone from the reflog-free `git branch <name> <tip>`.
pub fn delete_branch(jail: &Jail, repo: &Path, name: &str, patterns: &[String], confirm: &str) -> Result<String, EngineError> {
    if name.is_empty() || name.starts_with('-') || name.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(err("invalidName", "that is not a branch name"));
    }
    if !git::run(jail, repo, &["check-ref-format", "--branch", name]).is_ok_and(|o| o.ok) {
        return Err(err("invalidName", format!("'{name}' is not a valid branch name")));
    }
    let full = format!("refs/heads/{name}");
    if !ref_exists(jail, repo, &full) {
        return Err(err(code::REPO_MISSING, format!("no local branch '{name}'")));
    }
    let default = default_branch(jail, repo);
    if current_branch(jail, repo).as_deref() == Some(name) {
        return Err(err("currentBranch", "the checked-out branch cannot be deleted"));
    }
    if is_protected(name, patterns, default.as_deref()) {
        return Err(err("protectedBranch", format!("'{name}' is a protected or live branch and is never deleted here")));
    }
    // No exact typed confirmation, no jail question, no change.
    if confirm != name {
        return Err(err("confirmRequired", format!("type {name} to confirm")));
    }
    jail.check_op("branch delete", repo)?;
    let base = default.as_deref().and_then(|d| base_ref(jail, repo, d)).ok_or_else(|| err("noDefault", "no default branch to compare with"))?;
    if !merged_set(jail, repo, &base).iter().any(|b| b == name) {
        return Err(err("notMerged", format!("'{name}' is not merged into {base}; it is kept")));
    }
    let tip = git::read(jail, repo, &["rev-parse", "--short", &full])?.trim().to_owned();
    let o = git::run(jail, repo, &["branch", "-d", "--", name])?;
    if !o.ok {
        return Err(err("notMerged", o.stderr.trim().to_owned()));
    }
    Ok(format!("Deleted {name} (was {tip}). Restore it with: git branch {name} {tip}"))
}
