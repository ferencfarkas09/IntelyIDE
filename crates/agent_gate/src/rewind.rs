//! Rewind snapshots (ideas-backlog #1, providers-plan 5.8): before an agent run, every repo gets a snapshot ref
//! `refs/intely/snapshots/<runId>` that captures the working tree (tracked files plus untracked files that pass
//! the guard) and, separately, the index. Neither the user's index file nor the working tree is touched: trees are
//! built in a temporary `GIT_INDEX_FILE`, and the real index is only ever read through a copy.
//!
//! Layout of one snapshot: commit `S` (tree = working tree) whose first parent is commit `I` (tree = the user's
//! index at that moment), whose parent is `HEAD` (if any). Messages carry no trailers.
//!
//! Restore is two-step: [`Rewind::plan_restore`] lists what would change, [`Rewind::restore`] applies it only with
//! `confirm: true`. It overwrites changed files, recreates deleted ones, deletes only files that were created after
//! the snapshot and are not ignored, and resets the index to the snapshotted index. Guard-skipped files (never-add,
//! secret, too large) are never part of a snapshot and are never deleted. It refuses while a merge, rebase,
//! cherry-pick or revert is in progress.

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

use intely_core::{guard, GuardState};
use serde::Serialize;

pub const REF_PREFIX: &str = "refs/intely/snapshots/";
const MAX_SKIP_LINES: usize = 500;
const IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "IntelySwitchIDE"),
    ("GIT_AUTHOR_EMAIL", "snapshot@intely.invalid"),
    ("GIT_COMMITTER_NAME", "IntelySwitchIDE"),
    ("GIT_COMMITTER_EMAIL", "snapshot@intely.invalid"),
];

#[derive(Debug, thiserror::Error)]
pub enum RewindError {
    #[error("not a git repository with a working tree: {0}")]
    NotARepo(String),
    #[error("invalid run id {0:?} (use letters, digits, '.', '_' and '-', at most 64 characters)")]
    InvalidRunId(String),
    #[error("a snapshot for run {0} already exists")]
    Exists(String),
    #[error("no snapshot for run {0}")]
    Unknown(String),
    #[error("{0} is in progress; finish or abort it first")]
    InProgress(&'static str),
    #[error("the index has unmerged entries; resolve the conflicts first")]
    Unmerged,
    #[error("restore needs explicit confirmation (confirm: true) after reviewing the plan")]
    ConfirmationRequired,
    #[error("git {args} failed: {stderr}")]
    Git { args: String, stderr: String },
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub path: String,
    /// `neverAdd`, `secret`, `tooLarge` or `nestedRepo`.
    pub reason: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub run_id: String,
    pub ref_name: String,
    pub commit: String,
    /// Tree of the working tree at snapshot time.
    pub tree: String,
    /// Tree of the user's index at snapshot time.
    pub index_tree: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub files: usize,
    pub skipped: Vec<Skipped>,
    pub created_at: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePlan {
    pub run_id: String,
    /// Files whose content differs from the snapshot.
    pub overwrite: Vec<String>,
    /// Files in the snapshot that are gone now.
    pub recreate: Vec<String>,
    /// Files created after the snapshot (not ignored, not guard-protected).
    pub delete: Vec<String>,
    /// The index differs from the snapshotted index and will be reset.
    pub index_differs: bool,
    /// HEAD moved since the snapshot; restore does not move it.
    pub head_changed: bool,
    /// Guard-protected files currently in the working tree; they are left untouched.
    pub protected: Vec<Skipped>,
}

impl RestorePlan {
    pub fn is_empty(&self) -> bool {
        self.overwrite.is_empty() && self.recreate.is_empty() && self.delete.is_empty() && !self.index_differs
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub overwritten: usize,
    pub recreated: usize,
    pub deleted: usize,
    pub index_restored: bool,
}

#[derive(Debug, Clone)]
pub struct Rewind {
    git: PathBuf,
}

impl Default for Rewind {
    fn default() -> Self {
        Self { git: intely_core::exec::pinned_git_path() }
    }
}

struct WorkTree {
    tree: String,
    files: usize,
    skipped: Vec<Skipped>,
}

/// A throwaway index file next to the real one; removed on drop.
struct TempIndex(PathBuf);

impl TempIndex {
    fn new(git_dir: &Path, tag: &str) -> Self {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        Self(git_dir.join(format!("intely-{tag}-{}-{}.index", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed))))
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

impl Rewind {
    pub fn new(git: impl Into<PathBuf>) -> Self {
        Self { git: git.into() }
    }

    /// Creates the snapshot ref for `run_id`; the user's index and working tree are not modified.
    pub fn snapshot(&self, repo: &Path, run_id: &str) -> Result<SnapshotInfo, RewindError> {
        validate_run_id(run_id)?;
        let top = self.toplevel(repo)?;
        let ref_name = format!("{REF_PREFIX}{run_id}");
        if self.git_ok(&top, &["rev-parse", "-q", "--verify", &ref_name]) {
            return Err(RewindError::Exists(run_id.into()));
        }
        if !self.git(&top, &["ls-files", "-u", "-z"], &[], None)?.is_empty() {
            return Err(RewindError::Unmerged);
        }
        let head = self.head(&top);
        let branch = self.git_text(&top, &["symbolic-ref", "-q", "--short", "HEAD"]).ok().filter(|b| !b.is_empty());
        let index_tree = self.index_tree(&top)?;
        let work = self.work_tree(&top)?;

        let mut index_args = vec!["commit-tree".to_string(), index_tree.clone(), "-m".into(), format!("intely index {run_id}")];
        if let Some(h) = &head {
            index_args.extend(["-p".to_string(), h.clone()]);
        }
        let index_commit = self.commit_tree(&top, &index_args)?;
        let message = snapshot_message(run_id, head.as_deref(), branch.as_deref(), &work);
        let commit = self.commit_tree(&top, &["commit-tree".to_string(), work.tree.clone(), "-p".into(), index_commit, "-m".into(), message])?;
        self.git(&top, &["update-ref", "-m", "intely snapshot", &ref_name, &commit], &[], None)?;
        Ok(SnapshotInfo {
            run_id: run_id.into(),
            ref_name,
            commit,
            tree: work.tree,
            index_tree,
            head,
            branch,
            files: work.files,
            skipped: work.skipped,
            created_at: now_secs(),
        })
    }

    /// All snapshots of the repo, newest first.
    pub fn list(&self, repo: &Path) -> Result<Vec<SnapshotInfo>, RewindError> {
        let top = self.toplevel(repo)?;
        let refs = self.git_text(&top, &["for-each-ref", "--format=%(refname)", REF_PREFIX])?;
        let mut out: Vec<SnapshotInfo> = refs.lines().filter_map(|r| r.strip_prefix(REF_PREFIX)).filter_map(|id| self.info(&top, id).ok()).collect();
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| a.run_id.cmp(&b.run_id)));
        Ok(out)
    }

    pub fn delete(&self, repo: &Path, run_id: &str) -> Result<(), RewindError> {
        validate_run_id(run_id)?;
        let top = self.toplevel(repo)?;
        let ref_name = format!("{REF_PREFIX}{run_id}");
        if !self.git_ok(&top, &["rev-parse", "-q", "--verify", &ref_name]) {
            return Err(RewindError::Unknown(run_id.into()));
        }
        self.git(&top, &["update-ref", "-d", &ref_name], &[], None)?;
        Ok(())
    }

    /// Dry run: what a restore would overwrite, recreate and delete.
    pub fn plan_restore(&self, repo: &Path, run_id: &str) -> Result<RestorePlan, RewindError> {
        let top = self.toplevel(repo)?;
        self.plan(&top, run_id).map(|(plan, _)| plan)
    }

    /// Applies the restore. Without `confirm` nothing happens and [`RewindError::ConfirmationRequired`] is returned.
    pub fn restore(&self, repo: &Path, run_id: &str, confirm: bool) -> Result<RestoreReport, RewindError> {
        let top = self.toplevel(repo)?;
        let (plan, snap) = self.plan(&top, run_id)?;
        if !confirm {
            return Err(RewindError::ConfirmationRequired);
        }
        let git_dir = self.git_dir(&top)?;

        // Deletions first, so a file/directory swap cannot block the checkout below.
        for rel in &plan.delete {
            let path = top.join(rel);
            if std::fs::symlink_metadata(&path).is_ok() {
                std::fs::remove_file(&path)?;
            }
            prune_empty_parents(&top, &path);
        }
        let to_write: Vec<&String> = plan.overwrite.iter().chain(&plan.recreate).collect();
        if !to_write.is_empty() {
            let tmp = TempIndex::new(&git_dir, "restore");
            let env = [("GIT_INDEX_FILE", tmp.0.as_os_str())];
            self.git(&top, &["read-tree", &snap.tree], &env, None)?;
            let mut stdin = Vec::new();
            for rel in &to_write {
                stdin.extend_from_slice(rel.as_bytes());
                stdin.push(0);
            }
            self.git(&top, &["checkout-index", "-f", "-q", "-z", "--stdin"], &env, Some(&stdin))?;
        }
        let index_restored = plan.index_differs;
        if index_restored {
            self.git(&top, &["read-tree", "--reset", &snap.index_tree], &[], None)?;
            let _ = self.git(&top, &["update-index", "-q", "--refresh"], &[], None);
        }
        Ok(RestoreReport { overwritten: plan.overwrite.len(), recreated: plan.recreate.len(), deleted: plan.delete.len(), index_restored })
    }

    fn plan(&self, top: &Path, run_id: &str) -> Result<(RestorePlan, SnapshotInfo), RewindError> {
        validate_run_id(run_id)?;
        self.refuse_in_progress(top)?;
        if !self.git(top, &["ls-files", "-u", "-z"], &[], None)?.is_empty() {
            return Err(RewindError::Unmerged);
        }
        let snap = self.info(top, run_id)?;
        let now = self.work_tree(top)?;
        let mut plan = RestorePlan { run_id: run_id.into(), protected: now.skipped.clone(), ..RestorePlan::default() };
        let diff = self.git(top, &["diff-tree", "-r", "-z", "--no-renames", "--name-status", &snap.tree, &now.tree], &[], None)?;
        let mut parts = diff.split(|b| *b == 0).filter(|p| !p.is_empty());
        while let (Some(status), Some(path)) = (parts.next(), parts.next()) {
            let path = String::from_utf8_lossy(path).into_owned();
            match status {
                b"A" => plan.delete.push(path),
                b"D" => plan.recreate.push(path),
                _ => plan.overwrite.push(path),
            }
        }
        plan.index_differs = self.index_tree(top)? != snap.index_tree;
        plan.head_changed = self.head(top) != snap.head;
        Ok((plan, snap))
    }

    fn refuse_in_progress(&self, top: &Path) -> Result<(), RewindError> {
        for (name, what) in [
            ("MERGE_HEAD", "a merge"),
            ("rebase-merge", "a rebase"),
            ("rebase-apply", "a rebase or am"),
            ("CHERRY_PICK_HEAD", "a cherry-pick"),
            ("REVERT_HEAD", "a revert"),
        ] {
            let path = self.git_text(top, &["rev-parse", "--path-format=absolute", "--git-path", name])?;
            if Path::new(&path).exists() {
                return Err(RewindError::InProgress(what));
            }
        }
        Ok(())
    }

    /// Tracked files (current working-tree content) plus untracked, non-ignored files that pass the guard.
    fn work_tree(&self, top: &Path) -> Result<WorkTree, RewindError> {
        let listing = self.git(top, &["ls-files", "-z", "-t", "--cached", "--others", "--exclude-standard"], &[], None)?;
        let mut skipped = Vec::new();
        let mut paths: BTreeSet<Vec<u8>> = BTreeSet::new();
        for entry in listing.split(|b| *b == 0).filter(|e| e.len() > 2) {
            let (tag, path) = (entry[0], &entry[2..]);
            if tag != b'H' && tag != b'?' {
                continue; // skip-worktree entries are not in the working tree
            }
            let text = String::from_utf8_lossy(path).into_owned();
            let on_disk = std::fs::symlink_metadata(top.join(OsStr::from_bytes(path)));
            let Ok(meta) = on_disk else { continue }; // deleted tracked file: simply absent from the tree
            if meta.is_dir() || !(meta.is_file() || meta.file_type().is_symlink()) {
                if tag == b'?' && path.ends_with(b"/") {
                    skipped.push(Skipped { path: text, reason: "nestedRepo" });
                }
                continue; // submodule directory or special file
            }
            if tag == b'?' {
                let reason = match guard::classify(&text, true, Some(meta.len())) {
                    GuardState::Ok | GuardState::Sensitive => None, // Sensitive is tracked-only; untracked files are new
                    GuardState::NeverAdd => Some("neverAdd"),
                    GuardState::Secret => Some("secret"),
                    GuardState::TooLarge => Some("tooLarge"),
                };
                if let Some(reason) = reason {
                    skipped.push(Skipped { path: text, reason });
                    continue;
                }
            }
            paths.insert(path.to_vec());
        }
        let git_dir = self.git_dir(top)?;
        let tmp = TempIndex::new(&git_dir, "snap");
        let env = [("GIT_INDEX_FILE", tmp.0.as_os_str())];
        let mut stdin = Vec::new();
        for p in &paths {
            stdin.extend_from_slice(p);
            stdin.push(0);
        }
        if !paths.is_empty() {
            self.git(top, &["update-index", "--add", "-z", "--stdin"], &env, Some(&stdin))?;
        }
        let tree = self.git_text_env(top, &["write-tree"], &env)?;
        skipped.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(WorkTree { tree, files: paths.len(), skipped })
    }

    /// Tree of the user's index, computed on a copy so the real index file is never rewritten.
    fn index_tree(&self, top: &Path) -> Result<String, RewindError> {
        let git_dir = self.git_dir(top)?;
        let real = self.git_text(top, &["rev-parse", "--path-format=absolute", "--git-path", "index"])?;
        let tmp = TempIndex::new(&git_dir, "index");
        if Path::new(&real).exists() {
            std::fs::copy(&real, &tmp.0)?;
        }
        self.git_text_env(top, &["write-tree"], &[("GIT_INDEX_FILE", tmp.0.as_os_str())])
    }

    fn info(&self, top: &Path, run_id: &str) -> Result<SnapshotInfo, RewindError> {
        let ref_name = format!("{REF_PREFIX}{run_id}");
        let raw = self.git(top, &["cat-file", "commit", &ref_name], &[], None).map_err(|_| RewindError::Unknown(run_id.into()))?;
        let text = String::from_utf8_lossy(&raw).into_owned();
        let (header, body) = text.split_once("\n\n").unwrap_or((&text, ""));
        let tree = header.lines().find_map(|l| l.strip_prefix("tree ")).unwrap_or_default().to_string();
        let created_at = header
            .lines()
            .find_map(|l| l.strip_prefix("committer "))
            .and_then(|l| l.rsplit(' ').nth(1))
            .and_then(|t| t.parse().ok())
            .unwrap_or(0);
        let commit = self.git_text(top, &["rev-parse", &ref_name])?;
        let index_tree = self.git_text(top, &["rev-parse", &format!("{ref_name}^1^{{tree}}")]).map_err(|_| RewindError::Unknown(run_id.into()))?;
        let mut info = SnapshotInfo {
            run_id: run_id.into(),
            ref_name,
            commit,
            tree,
            index_tree,
            head: None,
            branch: None,
            files: 0,
            skipped: Vec::new(),
            created_at,
        };
        for line in body.lines() {
            if let Some(h) = line.strip_prefix("head ") {
                info.head = (h != "none").then(|| h.to_string());
            } else if let Some(b) = line.strip_prefix("branch ") {
                info.branch = (b != "detached").then(|| b.to_string());
            } else if let Some(n) = line.strip_prefix("files ") {
                info.files = n.parse().unwrap_or(0);
            } else if let Some(rest) = line.strip_prefix("skip ") {
                if let Some((reason, path)) = rest.split_once(' ') {
                    let reason = match reason {
                        "neverAdd" => "neverAdd",
                        "secret" => "secret",
                        "tooLarge" => "tooLarge",
                        _ => "nestedRepo",
                    };
                    info.skipped.push(Skipped { path: path.into(), reason });
                }
            }
        }
        Ok(info)
    }

    fn head(&self, top: &Path) -> Option<String> {
        self.git_text(top, &["rev-parse", "-q", "--verify", "HEAD^{commit}"]).ok().filter(|h| !h.is_empty())
    }

    fn toplevel(&self, repo: &Path) -> Result<PathBuf, RewindError> {
        let out = self.git_text(repo, &["rev-parse", "--show-toplevel"]).map_err(|_| RewindError::NotARepo(repo.display().to_string()))?;
        if out.is_empty() {
            return Err(RewindError::NotARepo(repo.display().to_string()));
        }
        Ok(PathBuf::from(out))
    }

    fn git_dir(&self, top: &Path) -> Result<PathBuf, RewindError> {
        self.git_text(top, &["rev-parse", "--absolute-git-dir"]).map(PathBuf::from)
    }

    fn commit_tree(&self, top: &Path, args: &[String]) -> Result<String, RewindError> {
        let mut full = vec!["-c".to_string(), "commit.gpgsign=false".to_string()];
        full.extend_from_slice(args);
        let refs: Vec<&str> = full.iter().map(String::as_str).collect();
        let out = self.git(top, &refs, &IDENTITY.map(|(k, v)| (k, OsStr::new(v))), None)?;
        Ok(String::from_utf8_lossy(&out).trim().to_string())
    }

    fn git_text(&self, dir: &Path, args: &[&str]) -> Result<String, RewindError> {
        self.git_text_env(dir, args, &[])
    }

    fn git_text_env(&self, dir: &Path, args: &[&str], env: &[(&str, &OsStr)]) -> Result<String, RewindError> {
        Ok(String::from_utf8_lossy(&self.git(dir, args, env, None)?).trim().to_string())
    }

    fn git_ok(&self, dir: &Path, args: &[&str]) -> bool {
        self.git(dir, args, &[], None).is_ok()
    }

    fn git(&self, dir: &Path, args: &[&str], env: &[(&str, &OsStr)], stdin: Option<&[u8]>) -> Result<Vec<u8>, RewindError> {
        let mut cmd = intely_core::exec::hardened_git(&self.git);
        cmd.arg("-C").arg(dir).args(args).stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
        for k in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"] {
            cmd.env_remove(k);
        }
        cmd.env("GIT_OPTIONAL_LOCKS", "0").env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C");
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn()?;
        if let Some(input) = stdin {
            // git reads all of stdin before writing much, and its output is small, so no writer thread is needed.
            child.stdin.take().expect("piped stdin").write_all(input)?;
        }
        let out = child.wait_with_output()?;
        if out.status.success() {
            Ok(out.stdout)
        } else {
            Err(RewindError::Git { args: args.join(" "), stderr: String::from_utf8_lossy(&out.stderr).trim().to_string() })
        }
    }
}

fn snapshot_message(run_id: &str, head: Option<&str>, branch: Option<&str>, work: &WorkTree) -> String {
    let mut msg = format!(
        "intely snapshot {run_id}\n\nhead {}\nbranch {}\nfiles {}\n",
        head.unwrap_or("none"),
        branch.unwrap_or("detached"),
        work.files
    );
    for s in work.skipped.iter().filter(|s| !s.path.contains('\n')).take(MAX_SKIP_LINES) {
        msg.push_str(&format!("skip {} {}\n", s.reason, s.path));
    }
    msg
}

fn validate_run_id(id: &str) -> Result<(), RewindError> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.starts_with(|c: char| c.is_ascii_alphanumeric())
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !id.contains("..")
        && !id.ends_with(".lock");
    if ok {
        Ok(())
    } else {
        Err(RewindError::InvalidRunId(id.into()))
    }
}

/// Removes directories that became empty, up to (never including) the repo root.
fn prune_empty_parents(top: &Path, file: &Path) {
    let mut dir = file.parent();
    while let Some(d) = dir {
        if d == top || !d.starts_with(top) || std::fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod hardening_tests {
    use super::*;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new(intely_core::exec::pinned_git_path())
            .current_dir(dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "f@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "f@example.invalid")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A committed, dirty repo whose `core.fsmonitor` is a program that leaves `marker` behind. The control run proves
    /// that an unhardened git really executes it.
    fn hostile_repo() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let marker = root.join("marker");
        let script = root.join("hook.sh");
        std::fs::write(&script, format!("#!/bin/sh\n: > '{}'\nexit 0\n", marker.display())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(&repo, &["config", "core.fsmonitor", script.to_str().unwrap()]);
        std::fs::write(repo.join("a.txt"), "changed\n").unwrap();
        git(&repo, &["status", "--porcelain"]);
        assert!(marker.exists(), "control failed: a plain git status did not run core.fsmonitor");
        std::fs::remove_file(&marker).unwrap();
        (dir, repo, marker)
    }

    #[test]
    fn a_rewind_snapshot_never_runs_core_fsmonitor() {
        let (_d, repo, marker) = hostile_repo();
        let info = Rewind::default().snapshot(&repo, "run-1").expect("snapshot");
        assert!(info.files >= 1);
        assert!(!marker.exists(), "the rewind snapshot executed core.fsmonitor");
    }
}
