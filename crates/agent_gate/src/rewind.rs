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
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

use intely_core::{guard, GuardState};
use serde::Serialize;

mod checkpoint;
pub mod vault;
pub use checkpoint::{CheckpointInfo, CheckpointPlan, CheckpointRestore, CheckpointStage, FileDiff, CHECKPOINT_PREFIX, MAX_CHECKPOINTS, MAX_CHECKPOINT_RUNS, MAX_UNTRACKED_BYTES};

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
    #[error("no checkpoint {1} for run {0}")]
    UnknownCheckpoint(String, u32),
    #[error("the new and untracked files add up to {0} bytes, more than a checkpoint keeps")]
    TooLarge(u64),
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
    /// Bytes of the untracked files in the tree (the size guard of checkpoints).
    untracked_bytes: u64,
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
        // Create only: the all-zero id as the old value makes git refuse a ref that exists by now. Linked worktrees of one repository share
        // the ref namespace, so two snapshots of the same run (taken at the same time) must not overwrite each other's tree.
        let nothing = "0".repeat(commit.len());
        self.git(&top, &["update-ref", "-m", "intely snapshot", &ref_name, &commit, &nothing], &[], None)?;
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
        self.write_from_tree(&top, &git_dir, &snap.tree, &to_write)?;
        let index_restored = plan.index_differs;
        if index_restored {
            self.git(&top, &["read-tree", "--reset", &snap.index_tree], &[], None)?;
            let _ = self.git(&top, &["update-index", "-q", "--refresh"], &[], None);
        }
        Ok(RestoreReport { overwritten: plan.overwrite.len(), recreated: plan.recreate.len(), deleted: plan.delete.len(), index_restored })
    }

    /// Writes `paths` with their content in `tree` into the working tree (through a throwaway index, so the user's index is not
    /// touched). `checkout-index` refuses to write through a symbolic link in a leading directory.
    fn write_from_tree(&self, top: &Path, git_dir: &Path, tree: &str, paths: &[&String]) -> Result<(), RewindError> {
        if paths.is_empty() {
            return Ok(());
        }
        let tmp = TempIndex::new(git_dir, "restore");
        let env = [("GIT_INDEX_FILE", tmp.0.as_os_str())];
        self.git(top, &["read-tree", tree], &env, None)?;
        let mut stdin = Vec::new();
        for rel in paths {
            stdin.extend_from_slice(rel.as_bytes());
            stdin.push(0);
        }
        self.git(top, &["checkout-index", "-f", "-q", "-z", "--stdin"], &env, Some(&stdin))?;
        Ok(())
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
    ///
    /// The tree is built on a copy of the user's index, so git's stat cache says which tracked files are unchanged and only the ones that
    /// changed (and the untracked ones) are read and hashed again. Hashing every file of a large working tree took seconds per repository
    /// and held up the start of a run; the copy makes it a fraction of a second and yields the tree that hashing every file would, as far
    /// as git's own check of a file (size, times, mode) can tell: what `git status` calls clean is taken as clean. A repository whose
    /// configuration weakens that check (`core.trustctime=false`, `core.checkStat=minimal`) gets the slow way, and so does any failure of
    /// the quick one: the tree is then built from an empty index.
    fn work_tree(&self, top: &Path) -> Result<WorkTree, RewindError> {
        // `-v` is `-t` with a lowercase tag for a file marked assume-unchanged (git then trusts the index, not the file).
        let listing = self.git(top, &["ls-files", "-z", "-v", "--cached", "--others", "--exclude-standard"], &[], None)?;
        let mut skipped = Vec::new();
        let mut untracked_bytes = 0u64;
        let mut paths: BTreeSet<Vec<u8>> = BTreeSet::new();
        let mut cached: Vec<&[u8]> = Vec::new();
        let mut untrusted: BTreeSet<&[u8]> = BTreeSet::new();
        for entry in listing.split(|b| *b == 0).filter(|e| e.len() > 2) {
            let (tag, path) = (entry[0], &entry[2..]);
            if tag != b'?' {
                cached.push(path);
            }
            if tag == b'h' {
                untrusted.insert(path);
            }
            if tag != b'H' && tag != b'h' && tag != b'?' {
                continue; // skip-worktree entries are not in the working tree
            }
            let text = String::from_utf8_lossy(path).into_owned();
            let on_disk = std::fs::symlink_metadata(top.join(path_from_git(path)));
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
                untracked_bytes += meta.len();
            }
            paths.insert(path.to_vec());
        }
        let git_dir = self.git_dir(top)?;
        let real = PathBuf::from(self.git_text(top, &["rev-parse", "--path-format=absolute", "--git-path", "index"])?);
        let quick = if real.is_file() && self.stat_check_is_strict(top) { self.tree_from_index_copy(top, &git_dir, &real, &paths, &cached, &untrusted).ok() } else { None };
        let tree = match quick {
            Some(tree) => tree,
            None => self.tree_from_scratch(top, &git_dir, &paths)?,
        };
        skipped.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(WorkTree { tree, files: paths.len(), skipped, untracked_bytes })
    }

    /// Git's check of a file for a change is strict (size, mtime, ctime, inode and mode all count) unless the configuration loosens it.
    fn stat_check_is_strict(&self, top: &Path) -> bool {
        // `core.trustctime` is a git boolean: `false`, `0`, `no`, `off` and an empty value all mean false, so git reads it (`--bool`)
        // instead of the text being compared. `core.checkStat` is a word.
        let ctime_ignored = self.git_text(top, &["config", "--bool", "--get", "core.trustctime"]).is_ok_and(|v| v.trim() == "false");
        let minimal = self.git_text(top, &["config", "--get", "core.checkstat"]).is_ok_and(|v| v.trim().eq_ignore_ascii_case("minimal"));
        !ctime_ignored && !minimal
    }

    /// The tree of `paths` as they are on disk now, built on a copy of the user's index: entries that are no longer in the snapshot are
    /// taken out, and only the files git sees as changed, the untracked ones and the ones marked assume-unchanged (git would not look at
    /// them) are hashed again; the rest keeps the entry of the index, which the stat data vouches for. Any failure is the caller's cue to
    /// build the tree from scratch.
    fn tree_from_index_copy(&self, top: &Path, git_dir: &Path, real: &Path, paths: &BTreeSet<Vec<u8>>, cached: &[&[u8]], untrusted: &BTreeSet<&[u8]>) -> Result<String, RewindError> {
        let tmp = TempIndex::new(git_dir, "snap");
        std::fs::copy(real, &tmp.0)?;
        // The copy keeps the time of the real index: git decides from it which entries were written too close to the index to be trusted.
        let written = std::fs::metadata(real)?.modified()?;
        std::fs::OpenOptions::new().write(true).open(&tmp.0)?.set_modified(written)?;
        let env = [("GIT_INDEX_FILE", tmp.0.as_os_str())];
        let nul_list = |items: &mut dyn Iterator<Item = &[u8]>| {
            let mut out = Vec::new();
            for item in items {
                out.extend_from_slice(item);
                out.push(0);
            }
            out
        };
        // Out of the copy: entries that are not in the snapshot (files deleted on disk, skip-worktree entries, submodules), and the
        // assume-unchanged ones, which `update-index --add` would keep as they are instead of reading the file.
        let gone = nul_list(&mut cached.iter().copied().filter(|p| !paths.contains(*p) || untrusted.contains(p)));
        if !gone.is_empty() {
            self.git(top, &["update-index", "--force-remove", "-z", "--stdin"], &env, Some(&gone))?;
        }
        let changed_out = self.git(top, &["diff-files", "-z", "--name-only"], &env, None)?;
        let changed: BTreeSet<&[u8]> = changed_out.split(|b| *b == 0).filter(|p| !p.is_empty()).collect();
        let known: BTreeSet<&[u8]> = cached.iter().copied().collect();
        let again = nul_list(&mut paths.iter().map(Vec::as_slice).filter(|p| !known.contains(p) || untrusted.contains(p) || changed.contains(p)));
        if !again.is_empty() {
            self.git(top, &["update-index", "--add", "-z", "--stdin"], &env, Some(&again))?;
        }
        self.git_text_env(top, &["write-tree"], &env)
    }

    /// The same tree from an empty index: every file is read and hashed. Slow on a large working tree, and the answer whatever state the index is in.
    fn tree_from_scratch(&self, top: &Path, git_dir: &Path, paths: &BTreeSet<Vec<u8>>) -> Result<String, RewindError> {
        let tmp = TempIndex::new(git_dir, "snap");
        let env = [("GIT_INDEX_FILE", tmp.0.as_os_str())];
        let mut stdin = Vec::new();
        for p in paths {
            stdin.extend_from_slice(p);
            stdin.push(0);
        }
        if !paths.is_empty() {
            self.git(top, &["update-index", "--add", "-z", "--stdin"], &env, Some(&stdin))?;
        }
        self.git_text_env(top, &["write-tree"], &env)
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
        // The input goes in from a thread of its own while this one reads the output: `update-index --add --stdin` answers every path with a
        // line on stderr when it has something to say (a line-ending warning per file), and a parent that writes all of stdin first stops
        // when that pipe is full, with git stopped on its side of it.
        let writer = stdin.map(|input| {
            let mut pipe = child.stdin.take().expect("piped stdin");
            let input = input.to_vec();
            std::thread::spawn(move || pipe.write_all(&input))
        });
        let out = child.wait_with_output()?;
        if let Some(writer) = writer {
            // (git may leave before it has read everything, when it fails: the status below says why)
            match writer.join() {
                Ok(Err(e)) if e.kind() != std::io::ErrorKind::BrokenPipe => return Err(e.into()),
                _ => {}
            }
        }
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

/// A path as git prints it (`-z`, bytes). Unix paths are arbitrary bytes; on Windows git prints UTF-8.
fn path_from_git(bytes: &[u8]) -> std::path::PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        std::path::PathBuf::from(OsStr::from_bytes(bytes))
    }
    #[cfg(not(unix))]
    {
        std::path::PathBuf::from(String::from_utf8_lossy(bytes).into_owned())
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod hardening_tests {
    #[cfg_attr(not(unix), allow(unused_imports))]
    use super::*;

    #[cfg_attr(not(unix), allow(dead_code))]
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

    #[cfg(unix)]
    /// A committed, dirty repo whose `core.fsmonitor` is a program that leaves `marker` behind. The control run proves
    /// that an unhardened git really executes it.
    fn hostile_repo() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        #[cfg(unix)]
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

    #[cfg(unix)]
    #[test]
    fn a_rewind_snapshot_never_runs_core_fsmonitor() {
        let (_d, repo, marker) = hostile_repo();
        let info = Rewind::default().snapshot(&repo, "run-1").expect("snapshot");
        assert!(info.files >= 1);
        assert!(!marker.exists(), "the rewind snapshot executed core.fsmonitor");
    }
}
