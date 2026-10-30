//! Checkpoints: lightweight snapshots of the working tree taken while a run goes on (before each follow-up prompt, after each
//! turn, on "Save point" and before a restore), so one step can be undone instead of the whole run. They reuse the snapshot
//! machinery of [`Rewind`]: the tree is built in a throwaway `GIT_INDEX_FILE` from the tracked files and the untracked files that
//! pass the guard, and neither the user's index, branches, stash nor working tree is touched.
//!
//! Layout: one ref per checkpoint, `refs/intely/checkpoints/<runId>/<seq>` (`seq` zero-padded, 1 and up), pointing at a commit
//! whose tree is the working tree and whose only parent is `HEAD` (if any), so a pruned checkpoint's objects become garbage.
//! Number 0 is the run's Rewind snapshot (`refs/intely/snapshots/<runId>`), listed but never written here.
//!
//! A restore never resets the index and never moves `HEAD`. Files that changed after the newest checkpoint (edits by the person,
//! or by anything else after the run's last step) are listed as conflicts and left alone unless the caller says to overwrite them.

use std::path::Path;

use serde::Serialize;

use super::{now_secs, prune_empty_parents, validate_run_id, Rewind, RewindError, Skipped, WorkTree, REF_PREFIX};

pub const CHECKPOINT_PREFIX: &str = "refs/intely/checkpoints/";
/// Checkpoints kept per run and repository; the oldest are pruned first (save points last).
pub const MAX_CHECKPOINTS: usize = 50;
/// Runs per repository whose checkpoints are kept; the checkpoints of older runs are pruned when a new run takes its first one.
pub const MAX_CHECKPOINT_RUNS: usize = 20;
/// A checkpoint is refused when the untracked files it would store add up to more than this (the guard already skips single large files).
pub const MAX_UNTRACKED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_LABEL_CHARS: usize = 80;
/// Longest patch text one Compare returns.
const MAX_PATCH_BYTES: usize = 256 * 1024;
/// How often a checkpoint number that another writer took first is tried again with the next one.
const SEQ_RETRIES: u32 = 4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointInfo {
    pub run_id: String,
    pub seq: u32,
    pub ref_name: String,
    pub commit: String,
    pub tree: String,
    /// `start` (the Rewind snapshot), `turn` (before a prompt), `end` (after a turn), `save` (a named save point) or `restore` (before a restore).
    pub kind: String,
    pub label: Option<String>,
    pub created_at: u64,
    pub files: usize,
    /// Files that differ from the previous checkpoint of the list (all files for the first one).
    pub changed: usize,
}

/// The work of one checkpoint before it is written: lets a caller checkpoint several repositories as one step and skip the step
/// when none of them changed.
pub struct CheckpointStage {
    top: std::path::PathBuf,
    work: WorkTree,
    /// The newest checkpoint (or the snapshot, as 0) and its tree.
    pub latest: Option<(u32, String)>,
    /// The tree differs from the newest checkpoint (true when there is none).
    pub changed: bool,
    /// The number the next checkpoint of this repository would get.
    pub next_seq: u32,
}

impl CheckpointStage {
    pub fn files(&self) -> usize {
        self.work.files
    }

    pub fn skipped(&self) -> &[Skipped] {
        &self.work.skipped
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointPlan {
    pub run_id: String,
    pub seq: u32,
    /// Files whose content differs from the checkpoint.
    pub overwrite: Vec<String>,
    /// Files in the checkpoint that are gone now.
    pub recreate: Vec<String>,
    /// Files created after the checkpoint (not ignored, not guard-protected).
    pub delete: Vec<String>,
    /// Files of the three lists above that changed after the newest checkpoint: someone edited them after the run's last step. A
    /// restore leaves them alone unless told to overwrite them.
    pub conflicts: Vec<String>,
    /// HEAD moved since the checkpoint; a restore does not move it.
    pub head_changed: bool,
    /// Guard-protected files in the working tree; never touched.
    pub protected: Vec<Skipped>,
}

impl CheckpointPlan {
    pub fn is_empty(&self) -> bool {
        self.overwrite.is_empty() && self.recreate.is_empty() && self.delete.is_empty()
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRestore {
    pub overwritten: Vec<String>,
    pub recreated: Vec<String>,
    pub deleted: Vec<String>,
    /// Conflicting files that were left as they are.
    pub kept: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    /// `modified`, `created` or `deleted` (from the older side to the newer one).
    pub change: String,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

fn ref_of(run_id: &str, seq: u32) -> String {
    format!("{CHECKPOINT_PREFIX}{run_id}/{seq:04}")
}

/// One line of printable text, at most [`MAX_LABEL_CHARS`] characters; `None` when nothing is left.
pub fn clean_label(label: &str) -> Option<String> {
    let flat: String = label.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let words: Vec<&str> = flat.split_whitespace().collect();
    let text: String = words.join(" ").chars().take(MAX_LABEL_CHARS).collect();
    (!text.is_empty()).then_some(text)
}

fn valid_kind(kind: &str) -> bool {
    matches!(kind, "turn" | "end" | "save" | "restore")
}

impl Rewind {
    /// Builds the tree of the working tree now and compares it with the newest checkpoint; nothing is written.
    pub fn stage_checkpoint(&self, repo: &Path, run_id: &str) -> Result<CheckpointStage, RewindError> {
        validate_run_id(run_id)?;
        let top = self.toplevel(repo)?;
        // the cap is checked on the sizes of the listing, before a single file is hashed into the object store
        let work = self.work_tree(&top, Some(MAX_UNTRACKED_BYTES))?;
        let seqs = self.checkpoint_seqs(&top, run_id)?;
        let latest = match seqs.last() {
            Some(&seq) => Some((seq, self.git_text(&top, &["rev-parse", &format!("{}^{{tree}}", ref_of(run_id, seq))])?)),
            None => self.git_text(&top, &["rev-parse", "-q", "--verify", &format!("{REF_PREFIX}{run_id}^{{tree}}")]).ok().filter(|t| !t.is_empty()).map(|t| (0, t)),
        };
        let changed = match &latest {
            Some((_, tree)) => *tree != work.tree,
            None => true,
        };
        let next_seq = seqs.last().map_or(1, |s| s + 1);
        Ok(CheckpointStage { top, work, latest, changed, next_seq })
    }

    /// Writes the staged checkpoint as number `seq` (or the next free one, when another writer took `seq` meanwhile) and prunes the
    /// oldest ones beyond [`MAX_CHECKPOINTS`]. `kind` is `turn`, `end`, `save` or `restore`.
    pub fn commit_checkpoint(&self, stage: &CheckpointStage, run_id: &str, seq: u32, kind: &str, label: Option<&str>) -> Result<CheckpointInfo, RewindError> {
        self.commit_checkpoint_keeping(stage, run_id, seq, kind, label, &[])
    }

    /// [`Rewind::commit_checkpoint`] that never prunes the checkpoints of `keep` (the one a restore is about to put back: the safety
    /// checkpoint taken right before it must not delete it).
    pub fn commit_checkpoint_keeping(&self, stage: &CheckpointStage, run_id: &str, seq: u32, kind: &str, label: Option<&str>, keep: &[u32]) -> Result<CheckpointInfo, RewindError> {
        validate_run_id(run_id)?;
        let kind = if valid_kind(kind) { kind } else { "turn" };
        let label = label.and_then(clean_label);
        let top = &stage.top;
        let head = self.head(top);
        let mut seq = seq.max(1);
        let mut attempt = 0;
        let commit = loop {
            let mut message = format!("intely checkpoint {run_id} {seq}\n\nkind {kind}\nfiles {}\n", stage.work.files);
            if let Some(l) = &label {
                message.push_str(&format!("label {l}\n"));
            }
            let mut args = vec!["commit-tree".to_string(), stage.work.tree.clone(), "-m".into(), message];
            if let Some(h) = &head {
                args.extend(["-p".to_string(), h.clone()]);
            }
            let commit = self.commit_tree(top, &args)?;
            let nothing = "0".repeat(commit.len());
            match self.git(top, &["update-ref", "-m", "intely checkpoint", &ref_of(run_id, seq), &commit, &nothing], &[], None) {
                Ok(_) => break commit,
                Err(e) if attempt + 1 >= SEQ_RETRIES => return Err(e),
                Err(_) => {
                    attempt += 1;
                    seq = self.checkpoint_seqs(top, run_id)?.last().map_or(seq + 1, |s| (s + 1).max(seq + 1));
                }
            }
        };
        let changed = match &stage.latest {
            Some((_, tree)) => self.diff_names(top, tree, &stage.work.tree)?.len(),
            None => stage.work.files,
        };
        self.prune_checkpoints(top, run_id, MAX_CHECKPOINTS, keep)?;
        Ok(CheckpointInfo {
            run_id: run_id.into(),
            seq,
            ref_name: ref_of(run_id, seq),
            commit,
            tree: stage.work.tree.clone(),
            kind: kind.into(),
            label,
            created_at: now_secs(),
            files: stage.work.files,
            changed,
        })
    }

    /// Stages and writes a checkpoint of one repository. `None` when nothing changed since the newest one, unless `force` (a save point).
    pub fn checkpoint(&self, repo: &Path, run_id: &str, kind: &str, label: Option<&str>, force: bool) -> Result<Option<CheckpointInfo>, RewindError> {
        let stage = self.stage_checkpoint(repo, run_id)?;
        if !stage.changed && !force {
            return Ok(None);
        }
        self.commit_checkpoint(&stage, run_id, stage.next_seq, kind, label).map(Some)
    }

    /// The checkpoints of the run in this repository, oldest first; the Rewind snapshot comes first as number 0 (kind `start`).
    pub fn checkpoints(&self, repo: &Path, run_id: &str) -> Result<Vec<CheckpointInfo>, RewindError> {
        validate_run_id(run_id)?;
        let top = self.toplevel(repo)?;
        let mut out: Vec<CheckpointInfo> = Vec::new();
        if let Ok(snap) = self.info(&top, run_id) {
            out.push(CheckpointInfo {
                run_id: run_id.into(),
                seq: 0,
                ref_name: snap.ref_name,
                commit: snap.commit,
                tree: snap.tree,
                kind: "start".into(),
                label: None,
                created_at: snap.created_at,
                files: snap.files,
                changed: 0,
            });
        }
        for seq in self.checkpoint_seqs(&top, run_id)? {
            if let Ok(info) = self.checkpoint_info(&top, run_id, seq) {
                out.push(info);
            }
        }
        for i in 1..out.len() {
            out[i].changed = self.diff_names(&top, &out[i - 1].tree, &out[i].tree)?.len();
        }
        Ok(out)
    }

    /// Dry run: what restoring checkpoint `seq` would overwrite, recreate and delete, and which of those files were edited after
    /// the newest checkpoint.
    pub fn plan_checkpoint_restore(&self, repo: &Path, run_id: &str, seq: u32) -> Result<CheckpointPlan, RewindError> {
        validate_run_id(run_id)?;
        let top = self.toplevel(repo)?;
        self.checkpoint_plan(&top, run_id, seq)
    }

    /// Puts the working tree back to checkpoint `seq`. Without `confirm` nothing happens. Conflicting files (see
    /// [`CheckpointPlan::conflicts`]) are only written when `overwrite_conflicts` is set; the index and `HEAD` are never touched.
    pub fn restore_checkpoint(&self, repo: &Path, run_id: &str, seq: u32, confirm: bool, overwrite_conflicts: bool) -> Result<CheckpointRestore, RewindError> {
        validate_run_id(run_id)?;
        let top = self.toplevel(repo)?;
        let plan = self.checkpoint_plan(&top, run_id, seq)?;
        if !confirm {
            return Err(RewindError::ConfirmationRequired);
        }
        let keep = if overwrite_conflicts { Vec::new() } else { plan.conflicts.clone() };
        self.apply_checkpoint(&top, run_id, &plan, &keep)
    }

    /// A confirmed restore of checkpoint `seq` that leaves the files of `keep` as they are (a caller that judged the conflicts
    /// earlier, before it took a checkpoint of its own).
    pub fn restore_checkpoint_keeping(&self, repo: &Path, run_id: &str, seq: u32, keep: &[String]) -> Result<CheckpointRestore, RewindError> {
        validate_run_id(run_id)?;
        let top = self.toplevel(repo)?;
        let plan = self.checkpoint_plan(&top, run_id, seq)?;
        let mut keep: Vec<String> = keep.to_vec();
        keep.extend(plan.conflicts.iter().cloned());
        keep.sort();
        keep.dedup();
        self.apply_checkpoint(&top, run_id, &plan, &keep)
    }

    fn apply_checkpoint(&self, top: &Path, run_id: &str, plan: &CheckpointPlan, keep: &[String]) -> Result<CheckpointRestore, RewindError> {
        let tree = self.checkpoint_tree(top, run_id, plan.seq)?;
        let git_dir = self.git_dir(top)?;
        let kept = |p: &String| keep.contains(p);
        let mut report = CheckpointRestore::default();
        for rel in plan.overwrite.iter().chain(&plan.recreate).chain(&plan.delete).filter(|p| kept(p)) {
            report.kept.push(rel.clone());
        }
        for rel in plan.delete.iter().filter(|p| !kept(p)) {
            let path = top.join(rel);
            // never through a symbolic link: a directory of the path that became a link since the plan is left alone
            if has_linked_parent(top, &path) {
                report.kept.push(rel.clone());
                continue;
            }
            if std::fs::symlink_metadata(&path).is_ok() {
                std::fs::remove_file(&path)?;
            }
            prune_empty_parents(top, &path);
            report.deleted.push(rel.clone());
        }
        let overwrite: Vec<&String> = plan.overwrite.iter().filter(|p| !kept(p)).collect();
        let recreate: Vec<&String> = plan.recreate.iter().filter(|p| !kept(p)).collect();
        let write: Vec<&String> = overwrite.iter().chain(&recreate).copied().collect();
        self.write_from_tree(top, &git_dir, &tree, &write)?;
        report.overwritten = overwrite.into_iter().cloned().collect();
        report.recreated = recreate.into_iter().cloned().collect();
        report.kept.sort();
        Ok(report)
    }

    /// The files that differ between checkpoints `from` and `to` (`None` = the working tree now), with line counts. Read-only.
    pub fn compare_checkpoints(&self, repo: &Path, run_id: &str, from: u32, to: Option<u32>) -> Result<Vec<FileDiff>, RewindError> {
        validate_run_id(run_id)?;
        let top = self.toplevel(repo)?;
        let a = self.checkpoint_tree(&top, run_id, from)?;
        let b = match to {
            Some(seq) => self.checkpoint_tree(&top, run_id, seq)?,
            None => self.work_tree(&top, None)?.tree,
        };
        let status = self.git(&top, &["diff-tree", "-r", "-z", "--no-renames", "--name-status", &a, &b], &[], None)?;
        let numstat = self.git(&top, &["diff-tree", "-r", "-z", "--no-renames", "--numstat", &a, &b], &[], None)?;
        let mut counts = std::collections::BTreeMap::new();
        // `-z --numstat`: "<add>\t<del>\t<path>\0"
        for rec in numstat.split(|b| *b == 0).filter(|r| !r.is_empty()) {
            let text = String::from_utf8_lossy(rec);
            let mut parts = text.splitn(3, '\t');
            if let (Some(add), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next()) {
                counts.insert(path.to_string(), (add.parse::<u32>().ok(), del.parse::<u32>().ok()));
            }
        }
        let mut out = Vec::new();
        let mut parts = status.split(|b| *b == 0).filter(|p| !p.is_empty());
        while let (Some(code), Some(path)) = (parts.next(), parts.next()) {
            let path = String::from_utf8_lossy(path).into_owned();
            let change = match code {
                b"A" => "created",
                b"D" => "deleted",
                _ => "modified",
            };
            let (add, del) = counts.get(&path).copied().unwrap_or((None, None));
            out.push(FileDiff { path, change: change.into(), additions: add.unwrap_or(0), deletions: del.unwrap_or(0), binary: add.is_none() || del.is_none() });
        }
        Ok(out)
    }

    /// The patch of one file between two checkpoints (`to: None` = now), capped at 256 KiB. Only a path that differs is accepted.
    pub fn checkpoint_patch(&self, repo: &Path, run_id: &str, from: u32, to: Option<u32>, path: &str) -> Result<String, RewindError> {
        let files = self.compare_checkpoints(repo, run_id, from, to)?;
        if !files.iter().any(|f| f.path == path) {
            return Ok(String::new());
        }
        let top = self.toplevel(repo)?;
        let a = self.checkpoint_tree(&top, run_id, from)?;
        let b = match to {
            Some(seq) => self.checkpoint_tree(&top, run_id, seq)?,
            None => self.work_tree(&top, None)?.tree,
        };
        let raw = self.git(&top, &["diff-tree", "-p", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", &a, &b, "--", path], &[], None)?;
        let mut text = String::from_utf8_lossy(&raw[..raw.len().min(MAX_PATCH_BYTES)]).into_owned();
        if raw.len() > MAX_PATCH_BYTES {
            text.push_str("\n…\n");
        }
        Ok(text)
    }

    /// Removes every checkpoint ref of the run in this repository.
    pub fn delete_checkpoints(&self, repo: &Path, run_id: &str) -> Result<usize, RewindError> {
        validate_run_id(run_id)?;
        let top = self.toplevel(repo)?;
        let seqs = self.checkpoint_seqs(&top, run_id)?;
        for seq in &seqs {
            self.git(&top, &["update-ref", "-d", &ref_of(run_id, *seq)], &[], None)?;
        }
        Ok(seqs.len())
    }

    /// The runs that have checkpoints in this repository, newest first (by their newest checkpoint).
    pub fn checkpoint_runs(&self, repo: &Path) -> Result<Vec<String>, RewindError> {
        let top = self.toplevel(repo)?;
        let refs = self.git_text(&top, &["for-each-ref", "--sort=-committerdate", "--format=%(refname)", CHECKPOINT_PREFIX])?;
        let mut runs: Vec<String> = Vec::new();
        for r in refs.lines() {
            if let Some((run, _)) = r.strip_prefix(CHECKPOINT_PREFIX).and_then(|rest| rest.split_once('/')) {
                if !runs.iter().any(|x| x == run) {
                    runs.push(run.to_string());
                }
            }
        }
        Ok(runs)
    }

    /// Keeps the checkpoints of the newest `keep` runs of this repository (and always those of `current`) and deletes the rest.
    pub fn prune_checkpoint_runs(&self, repo: &Path, current: &str, keep: usize) -> Result<Vec<String>, RewindError> {
        let runs = self.checkpoint_runs(repo)?;
        let mut kept = 0;
        let mut pruned = Vec::new();
        for run in runs {
            if run == current || validate_run_id(&run).is_err() {
                continue;
            }
            kept += 1;
            if kept >= keep {
                self.delete_checkpoints(repo, &run)?;
                pruned.push(run);
            }
        }
        Ok(pruned)
    }

    fn checkpoint_plan(&self, top: &Path, run_id: &str, seq: u32) -> Result<CheckpointPlan, RewindError> {
        self.refuse_in_progress(top)?;
        let target = self.checkpoint_tree(top, run_id, seq)?;
        let now = self.work_tree(top, None)?;
        let mut plan = CheckpointPlan { run_id: run_id.into(), seq, protected: now.skipped.clone(), ..CheckpointPlan::default() };
        let diff = self.git(top, &["diff-tree", "-r", "-z", "--no-renames", "--name-status", &target, &now.tree], &[], None)?;
        let mut parts = diff.split(|b| *b == 0).filter(|p| !p.is_empty());
        while let (Some(status), Some(path)) = (parts.next(), parts.next()) {
            let path = String::from_utf8_lossy(path).into_owned();
            match status {
                b"A" => plan.delete.push(path),
                b"D" => plan.recreate.push(path),
                _ => plan.overwrite.push(path),
            }
        }
        // what changed after the newest checkpoint: the edits the run's own checkpoints do not know about
        let newest = match self.checkpoint_seqs(top, run_id)?.last() {
            Some(&last) => self.checkpoint_tree(top, run_id, last)?,
            None => self.checkpoint_tree(top, run_id, 0)?,
        };
        let edited = self.diff_names(top, &newest, &now.tree)?;
        plan.conflicts = plan.overwrite.iter().chain(&plan.recreate).chain(&plan.delete).filter(|p| edited.contains(*p)).cloned().collect();
        plan.conflicts.sort();
        // a checkpoint's only parent is the HEAD it was taken on; the snapshot records its HEAD in the message
        let recorded = if seq == 0 { self.info(top, run_id).ok().and_then(|s| s.head) } else { self.git_text(top, &["rev-parse", "-q", "--verify", &format!("{}^1", ref_of(run_id, seq))]).ok().filter(|h| !h.is_empty()) };
        plan.head_changed = recorded != self.head(top);
        Ok(plan)
    }

    fn checkpoint_tree(&self, top: &Path, run_id: &str, seq: u32) -> Result<String, RewindError> {
        let at = if seq == 0 { format!("{REF_PREFIX}{run_id}") } else { ref_of(run_id, seq) };
        self.git_text(top, &["rev-parse", "-q", "--verify", &format!("{at}^{{tree}}")]).ok().filter(|t| !t.is_empty()).ok_or_else(|| RewindError::UnknownCheckpoint(run_id.into(), seq))
    }

    fn checkpoint_seqs(&self, top: &Path, run_id: &str) -> Result<Vec<u32>, RewindError> {
        let prefix = format!("{CHECKPOINT_PREFIX}{run_id}/");
        let refs = self.git_text(top, &["for-each-ref", "--format=%(refname)", &prefix])?;
        let mut seqs: Vec<u32> = refs.lines().filter_map(|r| r.strip_prefix(&prefix)).filter_map(|n| n.parse().ok()).filter(|n| *n > 0).collect();
        seqs.sort_unstable();
        seqs.dedup();
        Ok(seqs)
    }

    fn checkpoint_info(&self, top: &Path, run_id: &str, seq: u32) -> Result<CheckpointInfo, RewindError> {
        let ref_name = ref_of(run_id, seq);
        let raw = self.git(top, &["cat-file", "commit", &ref_name], &[], None).map_err(|_| RewindError::UnknownCheckpoint(run_id.into(), seq))?;
        let text = String::from_utf8_lossy(&raw).into_owned();
        let (header, body) = text.split_once("\n\n").unwrap_or((&text, ""));
        let tree = header.lines().find_map(|l| l.strip_prefix("tree ")).unwrap_or_default().to_string();
        let created_at = header.lines().find_map(|l| l.strip_prefix("committer ")).and_then(|l| l.rsplit(' ').nth(1)).and_then(|t| t.parse().ok()).unwrap_or(0);
        let mut info = CheckpointInfo {
            run_id: run_id.into(),
            seq,
            commit: self.git_text(top, &["rev-parse", &ref_name])?,
            ref_name,
            tree,
            kind: "turn".into(),
            label: None,
            created_at,
            files: 0,
            changed: 0,
        };
        for line in body.lines() {
            if let Some(k) = line.strip_prefix("kind ") {
                info.kind = if valid_kind(k) { k.to_string() } else { "turn".into() };
            } else if let Some(l) = line.strip_prefix("label ") {
                info.label = clean_label(l);
            } else if let Some(n) = line.strip_prefix("files ") {
                info.files = n.parse().unwrap_or(0);
            }
        }
        Ok(info)
    }

    /// Paths that differ between two trees.
    fn diff_names(&self, top: &Path, a: &str, b: &str) -> Result<std::collections::BTreeSet<String>, RewindError> {
        if a == b {
            return Ok(Default::default());
        }
        let out = self.git(top, &["diff-tree", "-r", "-z", "--no-renames", "--name-only", a, b], &[], None)?;
        Ok(out.split(|b| *b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect())
    }

    /// Deletes the oldest checkpoints beyond `max`: plain ones first, save points only when they alone exceed `max`.
    fn prune_checkpoints(&self, top: &Path, run_id: &str, max: usize, keep: &[u32]) -> Result<(), RewindError> {
        let seqs = self.checkpoint_seqs(top, run_id)?;
        if seqs.len() <= max {
            return Ok(());
        }
        let mut excess = seqs.len() - max;
        let kinds: Vec<(u32, bool)> = seqs.iter().map(|&s| (s, self.checkpoint_info(top, run_id, s).is_ok_and(|i| i.kind == "save"))).collect();
        // never the newest one: it is what conflicts are judged against
        let newest = *seqs.last().unwrap_or(&0);
        for pass_saves in [false, true] {
            for &(seq, save) in &kinds {
                if excess == 0 {
                    return Ok(());
                }
                if save == pass_saves && seq != newest && !keep.contains(&seq) {
                    self.git(top, &["update-ref", "-d", &ref_of(run_id, seq)], &[], None)?;
                    excess -= 1;
                }
            }
        }
        Ok(())
    }
}

/// Whether a directory between `top` (excluded) and `path` (excluded) is a symbolic link.
fn has_linked_parent(top: &Path, path: &Path) -> bool {
    let mut dir = path.parent();
    while let Some(d) = dir {
        if d == top || !d.starts_with(top) {
            return false;
        }
        if std::fs::symlink_metadata(d).is_ok_and(|m| m.file_type().is_symlink()) {
            return true;
        }
        dir = d.parent();
    }
    false
}
