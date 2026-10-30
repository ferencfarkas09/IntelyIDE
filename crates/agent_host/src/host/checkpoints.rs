//! Run checkpoints (docs/checkpoints.md): the host takes one before each follow-up prompt and after each turn, the person adds named
//! save points, and a restore puts the run's repositories back one step (or to any checkpoint) through the same dry run and
//! explicit confirmation as Rewind. The git work is `intely_agent_gate::rewind` (checkpoint refs under `refs/intely/checkpoints/`);
//! this file decides which repositories, numbers the step for the whole run, and applies the same "not while a run works there"
//! rules as [`AgentHost::rewind`]. Runs on a server have no local checkpoints (their files live in the server's copy).
//!
//! The opt-in protection of ignored config files keeps copies in `<data_dir>/checkpoint-files` (see `rewind::vault`); the switch is
//! persisted in `<data_dir>/checkpoints.json`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use intely_agent_gate::rewind::vault::{ConfigVault, PROTECTED_NAMES};
use intely_agent_gate::rewind::{CheckpointPlan, CheckpointRestore, FileDiff, MAX_CHECKPOINT_RUNS};
use intely_core::jail::Jail;
use intely_core::EngineError;
use serde::{Deserialize, Serialize};

use super::{err, lock, unknown_agent, AgentHost, Inner};
use crate::run::RepoRef;

const SETTINGS_FILE: &str = "checkpoints.json";
const VAULT_DIR: &str = "checkpoint-files";

/// The host's part of checkpoints: the vault, its switch, and a lock so two checkpoints of the host never interleave.
pub(super) struct Checkpoints {
    vault: ConfigVault,
    protect_config: AtomicBool,
    settings: PathBuf,
    busy: Mutex<()>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    protect_config: bool,
}

impl Checkpoints {
    pub(super) fn new(data_dir: &std::path::Path) -> Self {
        let settings = data_dir.join(SETTINGS_FILE);
        let saved: Settings = std::fs::read(&settings).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { vault: ConfigVault::new(data_dir.join(VAULT_DIR)), protect_config: AtomicBool::new(saved.protect_config), settings, busy: Mutex::new(()) }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCheckpoint {
    pub repo_id: String,
    pub files: usize,
    pub changed: usize,
}

/// One step of a run's timeline, over all its repositories.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCheckpoint {
    pub seq: u32,
    /// `start`, `turn`, `end`, `save` or `restore`.
    pub kind: String,
    pub label: Option<String>,
    /// Unix seconds.
    pub created_at: u64,
    pub repos: Vec<RepoCheckpoint>,
    /// Files changed since the previous step, over all repositories.
    pub changed: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCheckpointPlan {
    pub repo_id: String,
    #[serde(flatten)]
    pub plan: CheckpointPlan,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCheckpointRestore {
    pub repo_id: String,
    #[serde(flatten)]
    pub report: CheckpointRestore,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSettings {
    pub protect_config: bool,
    /// The file names the protection copies, shown next to the switch.
    pub names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigCopy {
    pub repo_id: String,
    pub path: String,
    pub size: u64,
    /// `same`, `differs` or `missing`.
    pub state: String,
}

impl Inner {
    /// The local repositories of a run, for checkpoints: none for a run on a server or a quiet (probe) run.
    fn checkpoint_repos(&self, agent_id: &str) -> Result<Vec<RepoRef>, EngineError> {
        let mut st = lock(&self.state);
        if !st.agents.contains_key(agent_id) {
            self.load_history(&mut st);
        }
        let run = st.agents.get(agent_id).ok_or_else(|| unknown_agent(agent_id))?;
        if run.quiet || run.meta.location.is_some() || run.meta.remote.is_some() {
            return Ok(Vec::new());
        }
        Ok(run.meta.repos.clone())
    }

    /// Takes one checkpoint of every repository of the run as one numbered step. `None` when nothing changed anywhere since the
    /// newest step and `force` is off. Errors of single repositories are logged and skipped: a checkpoint never blocks a run.
    pub(super) fn checkpoint_step(&self, agent_id: &str, kind: &str, label: Option<&str>, force: bool) -> Result<Option<u32>, EngineError> {
        let repos = self.checkpoint_repos(agent_id)?;
        if repos.is_empty() {
            return Ok(None);
        }
        let _one_at_a_time = lock(&self.checkpoints.busy);
        let mut stages = Vec::new();
        for repo in &repos {
            match self.rewind.stage_checkpoint(&repo.path, agent_id) {
                Ok(stage) => stages.push((repo, stage)),
                Err(e) => eprintln!("agent host: no checkpoint of {} for {agent_id}: {e}", repo.id),
            }
        }
        if stages.is_empty() || (!force && !stages.iter().any(|(_, s)| s.changed)) {
            return Ok(None);
        }
        let seq = stages.iter().map(|(_, s)| s.next_seq).max().unwrap_or(1);
        let protect = self.checkpoints.protect_config.load(Ordering::Relaxed);
        let mut taken = None;
        for (repo, stage) in &stages {
            match self.rewind.commit_checkpoint(stage, agent_id, seq, kind, label) {
                Ok(info) => {
                    taken = Some(taken.map_or(info.seq, |t: u32| t.max(info.seq)));
                    if info.seq == 1 {
                        // the run's first step: the checkpoints of older runs of this repository beyond the limit go
                        let _ = self.rewind.prune_checkpoint_runs(&repo.path, agent_id, MAX_CHECKPOINT_RUNS);
                    }
                    if protect {
                        // names only in the log, never content
                        if let Err(e) = self.checkpoints.vault.save(&self.rewind, &repo.path, agent_id, info.seq) {
                            eprintln!("agent host: config files of {} not copied: {e}", repo.id);
                        }
                    }
                }
                Err(e) => eprintln!("agent host: checkpoint of {} for {agent_id} not written: {e}", repo.id),
            }
        }
        if taken == Some(1) && protect {
            for old in self.checkpoints.vault.runs().into_iter().skip(MAX_CHECKPOINT_RUNS) {
                let _ = self.checkpoints.vault.delete_run(&old);
            }
        }
        Ok(taken)
    }

    /// Refuses while this run works, or while another run works in one of its repositories (a restore would overwrite its files).
    fn refuse_while_working(&self, agent_id: &str) -> Result<Vec<RepoRef>, EngineError> {
        let mut st = lock(&self.state);
        self.load_history(&mut st);
        let run = st.agents.get(agent_id).ok_or_else(|| unknown_agent(agent_id))?;
        if run.state.turn_open {
            return Err(err("agentRunning", "stop the agent before restoring a checkpoint"));
        }
        if run.meta.location.is_some() || run.meta.remote.is_some() {
            return Err(err("noCheckpoint", "a run on a server has no local checkpoints"));
        }
        let repos = run.meta.repos.clone();
        let working_there = st.agents.iter().find(|(id, other)| id.as_str() != agent_id && other.state.turn_open && other.meta.repos.iter().any(|r| repos.iter().any(|m| m.id == r.id))).map(|(id, _)| id.clone());
        if let Some(other) = working_there {
            return Err(err("repoBusy", format!("run {other} is still working in this repository; stop it before restoring, because a restore would overwrite its files")));
        }
        Ok(repos)
    }
}

fn gate_err(repo_id: &str, e: impl std::fmt::Display) -> EngineError {
    err("checkpoint", format!("{repo_id}: {e}"))
}

impl AgentHost {
    /// The run's timeline: its Rewind snapshot (step 0) and every checkpoint, oldest first, merged over its repositories.
    pub fn checkpoints(&self, agent_id: &str) -> Result<Vec<RunCheckpoint>, EngineError> {
        let inner = &self.inner;
        let repos = inner.checkpoint_repos(agent_id)?;
        let mut steps: BTreeMap<u32, RunCheckpoint> = BTreeMap::new();
        for repo in &repos {
            let Ok(list) = inner.rewind.checkpoints(&repo.path, agent_id) else { continue };
            for c in list {
                let step = steps.entry(c.seq).or_insert_with(|| RunCheckpoint { seq: c.seq, kind: c.kind.clone(), label: c.label.clone(), created_at: c.created_at, repos: Vec::new(), changed: 0 });
                step.created_at = step.created_at.min(c.created_at);
                if step.label.is_none() {
                    step.label = c.label.clone();
                }
                step.changed += c.changed;
                step.repos.push(RepoCheckpoint { repo_id: repo.id.clone(), files: c.files, changed: c.changed });
            }
        }
        Ok(steps.into_values().collect())
    }

    /// A named save point of every repository of the run, also when nothing changed. Returns its number.
    pub fn save_point(&self, agent_id: &str, label: &str) -> Result<u32, EngineError> {
        self.inner.checkpoint_step(agent_id, "save", Some(label), true)?.ok_or_else(|| err("noCheckpoint", "this run has no local repository to checkpoint"))
    }

    /// Dry run of restoring step `seq`, per repository: what would be overwritten, recreated and deleted, and the files edited after
    /// the newest checkpoint (kept unless the person chooses to overwrite them).
    pub fn checkpoint_plan(&self, agent_id: &str, seq: u32) -> Result<Vec<RepoCheckpointPlan>, EngineError> {
        let inner = &self.inner;
        let repos = inner.checkpoint_repos(agent_id)?;
        let mut out = Vec::new();
        for repo in &repos {
            match inner.rewind.plan_checkpoint_restore(&repo.path, agent_id, seq) {
                Ok(plan) => out.push(RepoCheckpointPlan { repo_id: repo.id.clone(), plan }),
                Err(intely_agent_gate::rewind::RewindError::UnknownCheckpoint(..)) => {}
                Err(e) => return Err(gate_err(&repo.id, e)),
            }
        }
        if out.is_empty() {
            return Err(err("noCheckpoint", format!("this run has no checkpoint {seq}")));
        }
        Ok(out)
    }

    /// Restores step `seq` in every repository of the run that has it. Refuses unless `confirm`; never while this run or another run
    /// in the same repositories works; obeys the jail. A checkpoint of the state right before is taken first, so the restore itself
    /// can be undone. Files edited after the newest checkpoint are written only with `overwrite_conflicts`.
    pub fn checkpoint_restore(&self, agent_id: &str, seq: u32, confirm: bool, overwrite_conflicts: bool) -> Result<Vec<RepoCheckpointRestore>, EngineError> {
        let inner = &self.inner;
        if !confirm {
            return Err(err("confirmRequired", "restoring overwrites files; review the list and confirm"));
        }
        let repos = inner.refuse_while_working(agent_id)?;
        for repo in &repos {
            Jail::global().check_op("checkpoint restore", &repo.path)?;
        }
        // judged before the safety checkpoint: that one must not turn the person's later edits into "known" ones
        let plans = self.checkpoint_plan(agent_id, seq)?;
        let before = format!("before restoring step {seq}");
        if let Err(e) = inner.checkpoint_step(agent_id, "restore", Some(&before), false) {
            eprintln!("agent host: no checkpoint before the restore of {agent_id}: {e}");
        }
        let mut out = Vec::new();
        let mut failures = Vec::new();
        for p in plans {
            let Some(repo) = repos.iter().find(|r| r.id == p.repo_id) else { continue };
            // the conflicts of the plan made before the safety checkpoint decide what is kept
            let keep: &[String] = if overwrite_conflicts { &[] } else { &p.plan.conflicts };
            let result = inner.rewind.restore_checkpoint_keeping(&repo.path, agent_id, seq, keep);
            match result {
                Ok(report) => out.push(RepoCheckpointRestore { repo_id: repo.id.clone(), report }),
                Err(e) => failures.push(format!("{}: {e}", repo.id)),
            }
        }
        // the state after the restore is the new reference point: edits made from here on are the ones a later restore keeps
        let after = format!("after restoring step {seq}");
        if let Err(e) = inner.checkpoint_step(agent_id, "restore", Some(&after), false) {
            eprintln!("agent host: no checkpoint after the restore of {agent_id}: {e}");
        }
        if failures.is_empty() {
            Ok(out)
        } else {
            Err(err("checkpoint", failures.join("; ")))
        }
    }

    /// Files that differ between steps `from` and `to` (`None` = now) in one repository of the run. Read-only.
    pub fn checkpoint_compare(&self, agent_id: &str, repo_id: &str, from: u32, to: Option<u32>) -> Result<Vec<FileDiff>, EngineError> {
        let repo = self.inner.checkpoint_repo(agent_id, repo_id)?;
        self.inner.rewind.compare_checkpoints(&repo.path, agent_id, from, to).map_err(|e| gate_err(repo_id, e))
    }

    /// The patch of one file between two steps (`to: None` = now), capped. Read-only.
    pub fn checkpoint_patch(&self, agent_id: &str, repo_id: &str, from: u32, to: Option<u32>, path: &str) -> Result<String, EngineError> {
        let repo = self.inner.checkpoint_repo(agent_id, repo_id)?;
        self.inner.rewind.checkpoint_patch(&repo.path, agent_id, from, to, path).map_err(|e| gate_err(repo_id, e))
    }

    pub fn checkpoint_settings(&self) -> CheckpointSettings {
        CheckpointSettings { protect_config: self.inner.checkpoints.protect_config.load(Ordering::Relaxed), names: PROTECTED_NAMES.iter().map(|n| (*n).to_string()).collect() }
    }

    /// Switches the copying of ignored config files on or off (persisted). Switching it off also forgets every copy made so far.
    pub fn set_protect_config(&self, on: bool) -> Result<CheckpointSettings, EngineError> {
        let cp = &self.inner.checkpoints;
        let body = serde_json::to_vec(&Settings { protect_config: on }).map_err(|e| err("io", e.to_string()))?;
        std::fs::write(&cp.settings, body).map_err(|e| err("io", e.to_string()))?;
        cp.protect_config.store(on, Ordering::Relaxed);
        if !on {
            for run in cp.vault.runs() {
                let _ = cp.vault.delete_run(&run);
            }
        }
        Ok(self.checkpoint_settings())
    }

    /// The config-file copies kept with step `seq`, names and sizes only.
    pub fn checkpoint_config(&self, agent_id: &str, seq: u32) -> Result<Vec<ConfigCopy>, EngineError> {
        let inner = &self.inner;
        let mut out = Vec::new();
        for repo in inner.checkpoint_repos(agent_id)? {
            let files = inner.checkpoints.vault.list(&inner.rewind, &repo.path, agent_id, seq).unwrap_or_default();
            out.extend(files.into_iter().map(|f| ConfigCopy { repo_id: repo.id.clone(), path: f.path, size: f.size, state: f.state }));
        }
        Ok(out)
    }

    /// Writes config-file copies of step `seq` back into one repository; needs `consent`, refuses while a run works there.
    pub fn restore_checkpoint_config(&self, agent_id: &str, seq: u32, repo_id: &str, paths: &[String], consent: bool) -> Result<Vec<String>, EngineError> {
        let inner = &self.inner;
        if !consent {
            return Err(err("confirmRequired", "writing config files back needs your consent"));
        }
        let repos = inner.refuse_while_working(agent_id)?;
        let repo = repos.iter().find(|r| r.id == repo_id).ok_or_else(|| err("unknownRepo", format!("{repo_id} is not a repository of this run")))?;
        Jail::global().check_op("checkpoint config restore", &repo.path)?;
        inner.checkpoints.vault.restore(&inner.rewind, &repo.path, agent_id, seq, paths, true).map_err(|e| gate_err(repo_id, e))
    }

    /// Forgets the run's checkpoints and config-file copies (all its repositories). The Rewind snapshot stays.
    pub fn delete_checkpoints(&self, agent_id: &str) -> Result<(), EngineError> {
        let inner = &self.inner;
        for repo in inner.checkpoint_repos(agent_id)? {
            inner.rewind.delete_checkpoints(&repo.path, agent_id).map_err(|e| gate_err(&repo.id, e))?;
        }
        inner.checkpoints.vault.delete_run(agent_id).map_err(|e| err("checkpoint", e.to_string()))
    }
}

impl Inner {
    fn checkpoint_repo(&self, agent_id: &str, repo_id: &str) -> Result<RepoRef, EngineError> {
        self.checkpoint_repos(agent_id)?.into_iter().find(|r| r.id == repo_id).ok_or_else(|| err("unknownRepo", format!("{repo_id} is not a local repository of this run")))
    }
}
