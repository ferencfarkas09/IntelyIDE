//! Branches, stash and rollback. Every mutation passes `Jail::check_op` first, and the git subcommands are chosen from
//! the exec guard's mutating list (`checkout`, `update-ref`, `stash`, `reset`, `restore`) so the low-level guard
//! refuses them independently of this layer.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use intely_core::exec::{clean_rel_path, resolve_in_repo};
use intely_core::guard::classify;
use intely_core::jail::glob_match;
use intely_core::{code, EngineError, GuardState};

use crate::types::*;
use crate::{codes, git_failure, io_err, Files};

const ZERO_OID: &str = "0000000000000000000000000000000000000000";

fn text(out: &intely_core::exec::GitOutput) -> String {
    out.stdout_text().trim().to_owned()
}

fn lines(out: &intely_core::exec::GitOutput) -> Vec<String> {
    out.stdout_text().lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect()
}

impl Files {
    pub async fn branch_list(&self, root: &RepoRoot) -> Result<BranchList, EngineError> {
        let refs = self.git_read(&root.path, &["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]).await?;
        if !refs.success() {
            return Err(git_failure("git for-each-ref", &refs));
        }
        let (mut local, mut remote) = (Vec::new(), Vec::new());
        for r in lines(&refs) {
            if let Some(b) = r.strip_prefix("refs/heads/") {
                local.push(b.to_owned());
            } else if let Some(b) = r.strip_prefix("refs/remotes/").filter(|b| !b.ends_with("/HEAD")) {
                remote.push(b.to_owned());
            }
        }
        let current = self.current_branch(&root.path).await?;
        let up = self.git_read(&root.path, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).await?;
        let upstream = up.success().then(|| text(&up)).filter(|u| !u.is_empty());
        let (mut ahead, mut behind) = (0, 0);
        if upstream.is_some() {
            let counts = self.git_read(&root.path, &["rev-list", "--left-right", "--count", "HEAD...@{u}"]).await?;
            let mut it = text(&counts).split_whitespace().map(|n| n.parse().unwrap_or(0)).collect::<Vec<u32>>().into_iter();
            if counts.success() {
                (ahead, behind) = (it.next().unwrap_or(0), it.next().unwrap_or(0));
            }
        }
        Ok(BranchList { local, remote, current, upstream, ahead, behind })
    }

    async fn current_branch(&self, repo: &Path) -> Result<Option<String>, EngineError> {
        let out = self.git_read(repo, &["symbolic-ref", "--short", "-q", "HEAD"]).await?;
        Ok(out.success().then(|| text(&out)).filter(|b| !b.is_empty()))
    }

    async fn ref_exists(&self, repo: &Path, full_ref: &str) -> Result<bool, EngineError> {
        Ok(self.git_read(repo, &["show-ref", "--verify", "--quiet", full_ref]).await?.success())
    }

    /// Creates a local branch at `from` (default HEAD) without switching to it. Starting from a remote branch records
    /// it as the upstream.
    pub async fn branch_create(&self, root: &RepoRoot, name: &str, from: Option<&str>) -> Result<(), EngineError> {
        self.git.jail.check_op("branch create", &root.path)?;
        let bad = |why: &str| EngineError::new(code::INVALID_SELECTION, format!("branch name {name:?} {why}"));
        if name.is_empty() || name.starts_with('-') {
            return Err(bad("is not valid"));
        }
        let check = self.git_read(&root.path, &["check-ref-format", "--branch", name]).await?;
        if !check.success() || text(&check) != name {
            return Err(bad("is not a valid branch name"));
        }
        if self.ref_exists(&root.path, &format!("refs/heads/{name}")).await? {
            return Err(EngineError::new(codes::BRANCH_EXISTS, format!("a branch named {name} already exists")));
        }
        let start = from.filter(|f| !f.is_empty()).unwrap_or("HEAD");
        if start.starts_with('-') {
            return Err(bad("has an invalid start point"));
        }
        let spec = format!("{start}^{{commit}}");
        let oid = self.git_read(&root.path, &["rev-parse", "--verify", "-q", &spec]).await?;
        if !oid.success() {
            return Err(EngineError::new(codes::NO_SUCH_BRANCH, format!("{start} is not a commit")));
        }
        let oid = text(&oid);
        let full = format!("refs/heads/{name}");
        let made = self.git_write(&root.path, &["update-ref", "-m", &format!("branch: Created from {start}"), &full, &oid, ZERO_OID], false).await?;
        if !made.success() {
            return Err(git_failure("create branch", &made));
        }
        if let Some((remote, branch)) = self.remote_branch(&root.path, start).await? {
            for (key, value) in [(format!("branch.{name}.remote"), remote), (format!("branch.{name}.merge"), format!("refs/heads/{branch}"))] {
                self.git_write(&root.path, &["config", &key, &value], false).await?;
            }
        }
        Ok(())
    }

    /// `origin/feature` -> (`origin`, `feature`) when that remote-tracking ref exists.
    async fn remote_branch(&self, repo: &Path, spec: &str) -> Result<Option<(String, String)>, EngineError> {
        let remotes = self.git_read(repo, &["remote"]).await?;
        for remote in lines(&remotes) {
            if let Some(branch) = spec.strip_prefix(&format!("{remote}/")) {
                if self.ref_exists(repo, &format!("refs/remotes/{remote}/{branch}")).await? {
                    return Ok(Some((remote, branch.to_owned())));
                }
            }
        }
        Ok(None)
    }

    /// Checks out `name`. Refuses (`dirtyTree`) while tracked files have uncommitted changes. A branch that exists only
    /// on a remote is created as a tracking branch. Switching onto a protected branch is fine.
    pub async fn branch_switch(&self, root: &RepoRoot, name: &str) -> Result<(), EngineError> {
        self.git.jail.check_op("branch switch", &root.path)?;
        if name.is_empty() || name.starts_with('-') {
            return Err(EngineError::new(code::INVALID_SELECTION, format!("branch name {name:?} is not valid")));
        }
        if self.current_branch(&root.path).await?.as_deref() == Some(name) {
            return Ok(());
        }
        let status = self.git_read(&root.path, &["status", "--porcelain=v1", "-z", "--untracked-files=no"]).await?;
        if !status.success() {
            return Err(git_failure("git status", &status));
        }
        let dirty: Vec<String> = status.stdout.split(|b| *b == 0).filter(|r| r.len() > 3).map(|r| String::from_utf8_lossy(&r[3..]).into_owned()).collect();
        if !dirty.is_empty() {
            let shown = dirty.iter().take(8).cloned().collect::<Vec<_>>().join(", ");
            return Err(EngineError::new(codes::DIRTY_TREE, format!("{} file(s) have uncommitted changes", dirty.len())).with_detail(shown));
        }
        let out = if self.ref_exists(&root.path, &format!("refs/heads/{name}")).await? {
            self.git_write(&root.path, &["checkout", "--quiet", name, "--"], true).await?
        } else {
            let remote = self.single_remote_for(&root.path, name).await?;
            let start = format!("{remote}/{name}");
            self.git_write(&root.path, &["checkout", "--quiet", "--track", "-b", name, &start], true).await?
        };
        if out.success() {
            Ok(())
        } else {
            Err(git_failure(&format!("switch to {name}"), &out))
        }
    }

    /// The remote that has `name`: the only one, else `origin`.
    async fn single_remote_for(&self, repo: &Path, name: &str) -> Result<String, EngineError> {
        let refs = self.git_read(repo, &["for-each-ref", "--format=%(refname)", "refs/remotes"]).await?;
        let found: Vec<String> = lines(&refs)
            .iter()
            .filter_map(|r| r.strip_prefix("refs/remotes/"))
            .filter_map(|r| r.split_once('/'))
            .filter(|(_, b)| *b == name)
            .map(|(remote, _)| remote.to_owned())
            .collect();
        match found.as_slice() {
            [one] => Ok(one.clone()),
            [] => Err(EngineError::new(codes::NO_SUCH_BRANCH, format!("there is no branch named {name}"))),
            many if many.iter().any(|r| r == "origin") => Ok("origin".to_owned()),
            _ => Err(EngineError::new(codes::NO_SUCH_BRANCH, format!("{name} exists on several remotes"))),
        }
    }

    /// Switches every repo of `roots` that has the branch; the rest are `skipped`. One repo failing does not stop the others.
    pub async fn branch_switch_all(&self, roots: &[RepoRoot], name: &str) -> Vec<SwitchOutcome> {
        let mut outcomes = Vec::new();
        for root in roots {
            let outcome = |status, code: Option<String>, error: Option<String>| SwitchOutcome { repo_id: root.id.clone(), status, code, error };
            let list = match self.branch_list(root).await {
                Ok(l) => l,
                Err(e) => {
                    outcomes.push(outcome(SwitchStatus::Failed, Some(e.code), Some(e.message)));
                    continue;
                }
            };
            let has = list.local.iter().any(|b| b == name) || list.remote.iter().any(|b| b.split_once('/').is_some_and(|(_, b)| b == name));
            if !has {
                outcomes.push(outcome(SwitchStatus::Skipped, None, Some(format!("no branch named {name}"))));
            } else if list.current.as_deref() == Some(name) {
                outcomes.push(outcome(SwitchStatus::Skipped, None, Some("already on it".into())));
            } else {
                outcomes.push(match self.branch_switch(root, name).await {
                    Ok(()) => outcome(SwitchStatus::Switched, None, None),
                    Err(e) => outcome(SwitchStatus::Failed, Some(e.code), Some(e.detail.unwrap_or(e.message))),
                });
            }
        }
        outcomes
    }

    /// Deletes a local branch. Protected and live branches (`protected_patterns`: the workspace's protected patterns plus
    /// the repo's live branches) are never deleted. An unmerged branch needs `force` (the caller's confirmation).
    pub async fn branch_delete(&self, root: &RepoRoot, name: &str, force: bool, protected_patterns: &[String]) -> Result<(), EngineError> {
        self.git.jail.check_op("branch delete", &root.path)?;
        if protected_patterns.iter().any(|p| glob_match(p, name)) {
            return Err(EngineError::new(codes::PROTECTED_BRANCH, format!("{name} is a protected or live branch and is never deleted")));
        }
        let full = format!("refs/heads/{name}");
        if name.is_empty() || name.starts_with('-') || !self.ref_exists(&root.path, &full).await? {
            return Err(EngineError::new(codes::NO_SUCH_BRANCH, format!("there is no local branch named {name}")));
        }
        if self.current_branch(&root.path).await?.as_deref() == Some(name) {
            return Err(EngineError::new(code::GIT, format!("cannot delete {name}: it is checked out")));
        }
        let oid = self.git_read(&root.path, &["rev-parse", "--verify", &full]).await?;
        let oid = text(&oid);
        if !force {
            // Like `git branch -d`: merged into its upstream, else into HEAD.
            let up = self.git_read(&root.path, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", &format!("{name}@{{u}}")]).await?;
            let target = if up.success() && !text(&up).is_empty() { text(&up) } else { "HEAD".to_owned() };
            let merged = self.git_read(&root.path, &["merge-base", "--is-ancestor", &full, &target]).await?;
            if !merged.success() {
                return Err(EngineError::new(codes::NOT_MERGED, format!("branch {name} is not fully merged into {target}")));
            }
        }
        let out = self.git_write(&root.path, &["update-ref", "-d", &full, &oid], false).await?;
        if !out.success() {
            return Err(git_failure("delete branch", &out));
        }
        // `git branch -d` also drops the branch's config section; none means exit 128/1, which is fine.
        let _ = self.git_write(&root.path, &["config", "--remove-section", &format!("branch.{name}")], false).await;
        Ok(())
    }

    pub async fn stash_list(&self, root: &RepoRoot) -> Result<Vec<StashEntry>, EngineError> {
        if !self.ref_exists(&root.path, "refs/stash").await? {
            return Ok(Vec::new());
        }
        let out = self.git_read(&root.path, &["log", "-g", "--format=%gd%x1f%gs%x1f%ct", "refs/stash"]).await?;
        if !out.success() {
            return Err(git_failure("git log -g", &out));
        }
        Ok(out.stdout_text().lines().filter_map(parse_stash_line).collect())
    }

    /// Stashes tracked changes, or only `paths` (untracked ones among them too). Guarded paths are refused.
    pub async fn stash_push(&self, root: &RepoRoot, paths: &[String], message: Option<&str>) -> Result<(), EngineError> {
        self.git.jail.check_op("stash push", &root.path)?;
        let mut args: Vec<String> = vec!["stash".into(), "push".into()];
        if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
            args.extend(["-m".into(), m.to_owned()]);
        }
        if !paths.is_empty() {
            args.extend(["--include-untracked".into(), "--".into()]);
            for p in paths {
                let clean = clean_rel_path(p)?;
                if classify(clean.trim_end_matches('/'), true, None) != GuardState::Ok {
                    return Err(EngineError::new(code::GUARD_BLOCKED, format!("{clean} is a guarded path and is not stashed")));
                }
                args.push(clean);
            }
        }
        // A staged delete (the old half of a staged rename) is no longer "known to git" as a pathspec, so `stash push`
        // would stash everything and then fail on that path: unstage the delete first, the file stays gone in the tree.
        if !paths.is_empty() {
            let mut deleted: Vec<&str> = vec!["diff", "--cached", "--name-only", "-z", "--diff-filter=D", "--no-renames", "--"];
            deleted.extend(args.iter().skip_while(|a| *a != "--").skip(1).map(String::as_str));
            let out = self.git_read(&root.path, &deleted).await?;
            let gone: Vec<String> = out.stdout.split(|b| *b == 0).filter(|r| !r.is_empty()).map(|r| String::from_utf8_lossy(r).into_owned()).collect();
            if out.success() && !gone.is_empty() {
                let mut reset: Vec<&str> = vec!["reset", "-q", "--"];
                reset.extend(gone.iter().map(String::as_str));
                let out = self.git_write(&root.path, &reset, false).await?;
                if !out.success() {
                    return Err(git_failure("unstaging a deleted path", &out));
                }
            }
        }
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = self.git_write(&root.path, &argv, false).await?;
        if !out.success() {
            return Err(git_failure("stash", &out));
        }
        if out.stdout_text().contains("No local changes to save") {
            return Err(EngineError::new(codes::NOTHING_TO_DO, "there are no local changes to stash"));
        }
        Ok(())
    }

    pub async fn stash_apply(&self, root: &RepoRoot, index: u32) -> Result<(), EngineError> {
        self.stash_op(root, "apply", index).await
    }

    pub async fn stash_pop(&self, root: &RepoRoot, index: u32) -> Result<(), EngineError> {
        self.stash_op(root, "pop", index).await
    }

    pub async fn stash_drop(&self, root: &RepoRoot, index: u32) -> Result<(), EngineError> {
        self.stash_op(root, "drop", index).await
    }

    async fn stash_op(&self, root: &RepoRoot, op: &str, index: u32) -> Result<(), EngineError> {
        self.git.jail.check_op(&format!("stash {op}"), &root.path)?;
        let entry = format!("stash@{{{index}}}");
        let out = self.git_write(&root.path, &["stash", op, "--quiet", &entry], false).await?;
        if out.success() {
            Ok(())
        } else {
            Err(git_failure(&format!("stash {op}"), &out))
        }
    }

    /// Discards the working-tree and index changes of `paths` after saving them under `backup_root`: tracked changes as
    /// `rollback.patch`, untracked files (moved, never deleted) under `untracked/`. Nothing changes if the backup fails.
    pub async fn rollback(&self, root: &RepoRoot, paths: &[String], backup_root: &Path) -> Result<RollbackResult, EngineError> {
        self.git.jail.check_op("rollback", &root.path)?;
        let clean = paths.iter().map(|p| clean_rel_path(p)).collect::<Result<Vec<_>, _>>()?;
        if clean.is_empty() {
            return Err(EngineError::new(code::INVALID_SELECTION, "no paths to roll back"));
        }
        for p in &clean {
            resolve_in_repo(&root.path, p.trim_end_matches('/'))?;
        }
        let mut spec: Vec<&str> = vec!["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--"];
        spec.extend(clean.iter().map(String::as_str));
        let status = self.git_read(&root.path, &spec).await?;
        if !status.success() {
            return Err(git_failure("git status", &status));
        }
        let (mut untracked, mut added, mut tracked) = (Vec::new(), Vec::new(), Vec::new());
        for rec in status.stdout.split(|b| *b == 0).filter(|r| r.len() > 3) {
            let path = crate::nfc(&String::from_utf8_lossy(&rec[3..]));
            match (rec[0], rec[1]) {
                (b'?', b'?') => untracked.push(path),
                (b'A', _) => added.push(path),
                _ => tracked.push(path),
            }
        }
        if untracked.is_empty() && added.is_empty() && tracked.is_empty() {
            return Err(EngineError::new(codes::NOTHING_TO_DO, "there are no changes to roll back"));
        }

        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
        let backup = backup_root.join(format!("{}-{stamp}-{}", root.id, &uuid::Uuid::new_v4().simple().to_string()[..8]));
        fs::create_dir_all(&backup).map_err(|e| io_err(backup.display(), e))?;
        let with_detail = |e: EngineError| {
            let detail = format!("backup kept at {}{}", backup.display(), e.detail.as_deref().map(|d| format!("; {d}")).unwrap_or_default());
            e.with_detail(detail)
        };

        if !tracked.is_empty() || !added.is_empty() {
            let mut diff: Vec<&str> = vec!["diff", "HEAD", "--binary", "--no-color", "--no-ext-diff", "--"];
            diff.extend(tracked.iter().chain(&added).map(String::as_str));
            let out = self.git_read(&root.path, &diff).await?;
            if !out.success() {
                return Err(with_detail(git_failure("saving the patch", &out)));
            }
            fs::write(backup.join("rollback.patch"), &out.stdout).map_err(|e| with_detail(io_err("rollback.patch", e)))?;
        }
        if !added.is_empty() {
            let mut reset: Vec<&str> = vec!["reset", "-q", "--"];
            reset.extend(added.iter().map(String::as_str));
            let out = self.git_write(&root.path, &reset, false).await?;
            if !out.success() {
                return Err(with_detail(git_failure("unstaging new files", &out)));
            }
        }
        for path in untracked.iter().chain(&added) {
            move_aside(&root.path, path, &backup.join("untracked")).map_err(with_detail)?;
        }
        if !tracked.is_empty() {
            let mut restore: Vec<&str> = vec!["restore", "--source=HEAD", "--staged", "--worktree", "--"];
            restore.extend(tracked.iter().map(String::as_str));
            let out = self.git_write(&root.path, &restore, false).await?;
            if !out.success() {
                return Err(with_detail(git_failure("restoring files", &out)));
            }
        }
        Ok(RollbackResult { backup_path: backup.to_string_lossy().into_owned() })
    }
}

/// `stash@{0}\x1fOn main: message\x1f1700000000`
fn parse_stash_line(line: &str) -> Option<StashEntry> {
    let mut parts = line.split('\u{1f}');
    let (name, subject, ct) = (parts.next()?, parts.next()?, parts.next()?);
    let index = name.strip_prefix("stash@{")?.strip_suffix('}')?.parse().ok()?;
    let branch = subject
        .strip_prefix("WIP on ")
        .or_else(|| subject.strip_prefix("On "))
        .and_then(|rest| rest.split_once(':'))
        .map(|(b, _)| b.to_owned());
    Some(StashEntry { index, message: subject.to_owned(), branch, created_ms: ct.trim().parse::<f64>().ok()? * 1000.0 })
}

/// Moves `rel` (inside `repo`) to `dest_root/rel`. A rename keeps the data in one piece; across volumes the file is
/// copied, verified by size and only then removed from the repo.
fn move_aside(repo: &Path, rel: &str, dest_root: &Path) -> Result<(), EngineError> {
    let from: PathBuf = resolve_in_repo(repo, rel.trim_end_matches('/'))?;
    let Ok(md) = fs::symlink_metadata(&from) else { return Ok(()) };
    let to = dest_root.join(rel);
    fs::create_dir_all(to.parent().unwrap_or(dest_root)).map_err(|e| io_err(rel, e))?;
    if fs::rename(&from, &to).is_ok() {
        remove_empty_parents(&from, repo);
        return Ok(());
    }
    if md.file_type().is_symlink() {
        let target = fs::read_link(&from).map_err(|e| io_err(rel, e))?;
        std::os::unix::fs::symlink(target, &to).map_err(|e| io_err(rel, e))?;
    } else {
        fs::copy(&from, &to).map_err(|e| io_err(rel, e))?;
        if fs::metadata(&to).map_or(true, |m| m.len() != md.len()) {
            return Err(EngineError::new(code::IO, format!("{rel}: the backup copy is incomplete; the file was left in place")));
        }
    }
    fs::remove_file(&from).map_err(|e| io_err(rel, e))?;
    remove_empty_parents(&from, repo);
    Ok(())
}

/// Folders that only held the moved file go away too (`remove_dir` fails on a non-empty folder, which is the point).
fn remove_empty_parents(file: &Path, repo: &Path) {
    let root = repo.canonicalize().unwrap_or_else(|_| repo.to_path_buf());
    let mut dir = file.parent();
    while let Some(d) = dir.filter(|d| *d != root && d.starts_with(&root)) {
        if fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stash_lines_carry_index_branch_and_time() {
        let e = parse_stash_line("stash@{2}\u{1f}On feature/x: park it\u{1f}1700000000").unwrap();
        assert_eq!((e.index, e.branch.as_deref(), e.message.as_str(), e.created_ms), (2, Some("feature/x"), "On feature/x: park it", 1.7e12));
        let wip = parse_stash_line("stash@{0}\u{1f}WIP on main: abc123 msg\u{1f}1").unwrap();
        assert_eq!(wip.branch.as_deref(), Some("main"));
        assert!(parse_stash_line("garbage").is_none());
    }
}
