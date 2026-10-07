//! The workspace registry ((design notes: workspaces-spec) 4.2 to 4.6, 4.12): `workspaces.json` indexes the workspaces,
//! every workspace lives in its own `workspaces/<id>.json` (exactly the `Workspace` v1 format). Pure data on disk, no
//! Tauri, no engine. Every method blocks (file locks, filesystem probes): async callers use `spawn_blocking`.
//!
//! Guarantees: writes are atomic with backups (I5); one app instance per directory (I9); problems are data, a damaged
//! or newer registry is reported and never overwritten (T12); the registry never touches a repository folder except
//! through the bounded [`fs::Prober`] (T15).

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::jail::{Jail, Mode};
use crate::types::code;
use crate::workspace::{self, INVALID_WORKSPACE};
use crate::{
    BackupInfo, EngineError, OpenError, OpenErrorReason, ProblemKind, Protection, RegistryProblem, RegistryView, RepoConfig,
    RepoSummary, Workspace, WorkspaceEntry, WorkspaceFileState, WorkspaceOrigin, WorkspaceSummary,
};

pub mod fs;
pub mod fsutil;
mod migrate;
pub mod model;
mod probe;
mod protection;
pub mod stores;

pub use migrate::stamp_night_queue;
pub use fs::{FakeBehavior, FakeFs, FsProbe, RealFs};
pub use fsutil::{FileLock, Fault};
pub use model::{NewRepo, NewWorkspace, RepoKind, ValidatedRepo, FLOOR_PROTECTED, MIGRATED_ID, MIGRATED_NAME, PALETTE};
pub use stores::{risk_hash, TrustState};

use fs::{path_key, Prober};
use model::{RegistryFile, StoredEntry};

/// How long a mutation waits for `.workspaces.lock`.
pub const LOCK_WAIT: Duration = Duration::from_secs(5);
const REGISTRY_CAP: u64 = 4 * 1024 * 1024;
const WORKSPACE_CAP: u64 = 4 * 1024 * 1024;
const REMOVED_KEEP: usize = 20;
const REGISTRY_BACKUPS: usize = 10;
const WORKSPACE_BACKUPS: usize = 5;

/// Where everything lives (4.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Location {
    /// `workspaces.json`.
    pub registry: PathBuf,
    /// `INTELY_WORKSPACE`: the registry is bypassed and this single legacy file is the only workspace.
    pub pinned: Option<PathBuf>,
    /// Directory holding the registry, `workspaces/`, `backups/`, the lock files and the side stores.
    pub dir: PathBuf,
    /// `INTELY_WORKSPACES` was set but ignored because no jail is active.
    pub env_ignored: bool,
}

impl Location {
    pub fn resolve() -> Self {
        Self::from_env(|k| std::env::var(k).ok())
    }

    /// 1. `INTELY_WORKSPACE`: pinned. 2. `INTELY_WORKSPACES` while a jail is active. 3. `INTELY_DATA_DIR`. 4. the default
    /// state directory.
    pub fn from_env(var: impl Fn(&str) -> Option<String>) -> Self {
        let nonempty = |k: &str| var(k).filter(|v| !v.is_empty());
        // `INTELY_DATA_DIR` (tests, the e2e harness) moves every piece of IDE state, so a run with it never touches the real one.
        let default_dir = || match nonempty("INTELY_DATA_DIR") {
            Some(d) => PathBuf::from(d),
            None => PathBuf::from(var("HOME").unwrap_or_default()).join("Library/Application Support/IntelySwitchIDE"),
        };
        if let Some(p) = nonempty("INTELY_WORKSPACE") {
            let file = PathBuf::from(p);
            let dir = file.parent().filter(|d| !d.as_os_str().is_empty()).map_or_else(|| PathBuf::from("."), Path::to_path_buf);
            return Self { registry: dir.join("workspaces.json"), pinned: Some(file), dir, env_ignored: false };
        }
        let mut env_ignored = false;
        if let Some(p) = nonempty("INTELY_WORKSPACES") {
            if Jail::from_vars(&var).is_active() {
                let file = PathBuf::from(p);
                let dir = file.parent().filter(|d| !d.as_os_str().is_empty()).map_or_else(|| PathBuf::from("."), Path::to_path_buf);
                return Self { registry: file, pinned: None, dir, env_ignored: false };
            }
            env_ignored = true;
        }
        let dir = default_dir();
        Self { registry: dir.join("workspaces.json"), pinned: None, dir, env_ignored }
    }

    pub fn workspaces_dir(&self) -> PathBuf {
        self.dir.join("workspaces")
    }
    pub fn removed_dir(&self) -> PathBuf {
        self.workspaces_dir().join("removed")
    }
    pub fn backups_dir(&self) -> PathBuf {
        self.dir.join("backups")
    }
    pub fn legacy_file(&self) -> PathBuf {
        self.dir.join("workspace.json")
    }
    fn mutation_lock(&self) -> PathBuf {
        self.dir.join(".workspaces.lock")
    }
    fn instance_lock(&self) -> PathBuf {
        self.dir.join(".app.lock")
    }
    fn trust_file(&self) -> PathBuf {
        self.dir.join("trust.json")
    }
    fn floor_file(&self) -> PathBuf {
        self.dir.join("live-floor.json")
    }
}

/// Injectable environment: clock, id source, filesystem and crash injection (tests).
#[derive(Clone)]
pub struct Env {
    pub now_ms: fn() -> i64,
    pub new_id: fn() -> String,
    pub fs: Arc<dyn FsProbe>,
    /// Crash injection at named stages (`tmp-written`, `renamed` of every atomic write, `migrate:backup`,
    /// `migrate:workspace-file`, `migrate:registry`).
    pub fault: Option<Fault>,
    /// `night-queue.json`: entries without a `workspaceId` get `w-migrated` when the legacy file is migrated.
    pub night_queue: Option<PathBuf>,
    /// How long a mutation waits for `.workspaces.lock` ([`LOCK_WAIT`] in the app).
    pub lock_wait: Duration,
}

fn real_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

impl Env {
    pub fn real() -> Self {
        Self { now_ms: real_now, new_id: model::new_id, fs: Arc::new(RealFs), fault: None, night_queue: None, lock_wait: LOCK_WAIT }
    }
}

#[derive(Debug, Clone)]
pub struct ActiveWorkspace {
    pub id: String,
    pub path: PathBuf,
    pub workspace: Workspace,
}

pub struct Opened {
    pub registry: Registry,
    /// The workspace to open at launch (`None`: Welcome).
    pub active: Option<ActiveWorkspace>,
    pub problem: Option<RegistryProblem>,
}

pub struct Registry {
    loc: Location,
    env: Env,
    jail: Arc<Jail>,
    prober: Prober,
    instance: Mutex<Option<FileLock>>,
    /// Problems found at open that are not read back from the registry file.
    blocked: Mutex<Option<(ProblemKind, String)>>,
    legacy_problem: Mutex<Option<String>>,
    /// This launch migrated the legacy `workspace.json`; reported once through the view (`RegistryView::just_migrated`).
    just_migrated: AtomicBool,
}

fn problem(kind: ProblemKind, message: impl Into<String>) -> RegistryProblem {
    RegistryProblem { kind, message: message.into(), backups: Vec::new() }
}

impl Registry {
    /// Never fails: problems are data. Takes the instance lock, migrates a legacy `workspace.json` when there is no
    /// registry yet, and loads the active workspace. It never stats a repository folder (3.1).
    pub fn open(loc: Location, jail: Arc<Jail>, env: Env) -> Opened {
        let reg = Registry {
            prober: Prober::new(env.fs.clone()),
            loc,
            env,
            jail,
            instance: Mutex::new(None),
            blocked: Mutex::new(None),
            legacy_problem: Mutex::new(None),
            just_migrated: AtomicBool::new(false),
        };
        if let Some(pinned) = reg.loc.pinned.clone() {
            let active = workspace::load_existing(&pinned).ok().map(|workspace| ActiveWorkspace { id: "pinned".into(), path: pinned, workspace });
            return Opened { registry: reg, active, problem: None };
        }
        if reg.jail.mode() == Mode::E2e && !reg.jail.in_fixture(&reg.loc.registry) {
            *reg.blocked.lock().expect("blocked") = Some((ProblemKind::TestJail, "the workspace list is outside the test fixture folder".into()));
            return Opened { registry: reg, active: None, problem: Some(problem(ProblemKind::TestJail, "the workspace list is outside the test fixture folder")) };
        }
        match fsutil::ensure_dir(&reg.loc.dir).and_then(|()| fsutil::try_lock(&reg.loc.instance_lock())) {
            Ok(Some(lock)) => *reg.instance.lock().expect("instance") = Some(lock),
            Ok(None) => {
                *reg.blocked.lock().expect("blocked") = Some((ProblemKind::OtherInstance, "another instance is using this workspace list".into()));
                return Opened { registry: reg, active: None, problem: Some(problem(ProblemKind::OtherInstance, "another instance is using this workspace list")) };
            }
            Err(e) => {
                let msg = format!("{}: {e}", reg.loc.dir.display());
                *reg.blocked.lock().expect("blocked") = Some((ProblemKind::IoError, msg.clone()));
                return Opened { registry: reg, active: None, problem: Some(problem(ProblemKind::IoError, msg)) };
            }
        }
        // A kill between the temp write and the rename leaves `.<file>.json.<pid>.<n>.tmp`; nothing else writes while we hold the lock.
        fsutil::sweep_stale_tmp(&reg.loc.dir);
        fsutil::sweep_stale_tmp(&reg.loc.workspaces_dir());
        if !reg.loc.registry.exists() && reg.loc.legacy_file().exists() {
            match reg.migrate_legacy() {
                Ok(()) => reg.just_migrated.store(true, Ordering::Relaxed),
                Err(why) => *reg.legacy_problem.lock().expect("legacy") = Some(why),
            }
        }
        let active = reg.load_active();
        let problem = reg.current_problem();
        Opened { registry: reg, active, problem }
    }

    /// True once after a launch that migrated the legacy file (the page shows its one-time notice).
    pub fn take_just_migrated(&self) -> bool {
        self.just_migrated.swap(false, Ordering::Relaxed)
    }

    pub fn location(&self) -> &Location {
        &self.loc
    }

    pub fn jail(&self) -> &Arc<Jail> {
        &self.jail
    }

    pub fn is_pinned(&self) -> bool {
        self.loc.pinned.is_some()
    }

    pub fn prober(&self) -> &Prober {
        &self.prober
    }

    /// Directory for workspace-file backups (`ws-<id>.<ms>.json`); pass it to `workspace::save_to`.
    pub fn backup_dir(&self) -> PathBuf {
        self.loc.backups_dir()
    }

    pub fn now_ms(&self) -> i64 {
        (self.env.now_ms)()
    }

    /// The file of workspace `id`; the id must match `^[a-z0-9][a-z0-9-]{0,30}$` so a tampered registry cannot point
    /// outside `workspaces/`.
    pub fn workspace_path(&self, id: &str) -> Result<PathBuf, EngineError> {
        if let Some(p) = &self.loc.pinned {
            return if id == "pinned" { Ok(p.clone()) } else { Err(not_found(id)) };
        }
        if !model::valid_id(id) {
            return Err(not_found(id));
        }
        Ok(self.loc.workspaces_dir().join(format!("{id}.json")))
    }

    /// Reads a workspace file without validating repo paths or structure (a damaged file is an error, not a panic).
    pub fn load_workspace(&self, id: &str) -> Result<Workspace, EngineError> {
        let path = self.workspace_path(id)?;
        let bytes = match fsutil::read_capped(&path, WORKSPACE_CAP) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(EngineError::new(code::WORKSPACE_FILE_MISSING, "the workspace file is missing").with_detail(path.display().to_string()))
            }
            Err(e) => return Err(EngineError::new(code::IO, e.to_string()).with_detail(path.display().to_string())),
        };
        let ws: Workspace = serde_json::from_slice(&bytes)
            .map_err(|e| EngineError::new(INVALID_WORKSPACE, "the workspace file is not valid").with_detail(format!("{}: {e}", path.display())))?;
        if ws.version != 1 {
            return Err(EngineError::new(INVALID_WORKSPACE, format!("unsupported workspace version {}", ws.version)));
        }
        Ok(ws)
    }

    // ---- reading -------------------------------------------------------------------------------------------------

    fn read_file(&self) -> Result<Option<RegistryFile>, EngineError> {
        match fsutil::read_capped(&self.loc.registry, REGISTRY_CAP) {
            Ok(bytes) => model::parse_registry(&bytes).map(Some),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(EngineError::new(code::IO, e.to_string()).with_detail(self.loc.registry.display().to_string())),
        }
    }

    fn load_active(&self) -> Option<ActiveWorkspace> {
        let file = self.read_file().ok().flatten()?;
        let id = file.active_id.as_ref().filter(|id| file.find(id).is_some())?.clone();
        let workspace = self.load_workspace(&id).ok()?;
        let path = self.workspace_path(&id).ok()?;
        Some(ActiveWorkspace { id, path, workspace })
    }

    fn current_problem(&self) -> Option<RegistryProblem> {
        if let Some((kind, msg)) = self.blocked.lock().expect("blocked").clone() {
            return Some(problem(kind, msg));
        }
        match self.read_file() {
            Err(e) if e.code == code::UNSUPPORTED_VERSION => Some(problem(ProblemKind::NewerVersion, e.message)),
            Err(e) => {
                let kind = if e.code == code::REGISTRY_CORRUPT { ProblemKind::Corrupt } else { ProblemKind::IoError };
                let msg = e.detail.clone().unwrap_or(e.message.clone());
                Some(RegistryProblem { kind, message: msg, backups: self.list_backups() })
            }
            Ok(Some(_)) => None,
            Ok(None) => self.legacy_problem.lock().expect("legacy").clone().map(|m| problem(ProblemKind::LegacyUnreadable, m)),
        }
    }

    /// Registry backups, newest first, only those that still parse.
    fn list_backups(&self) -> Vec<BackupInfo> {
        let dir = self.loc.backups_dir();
        let mut out = Vec::new();
        let Ok(rd) = std::fs::read_dir(&dir) else { return out };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(at) = fsutil::backup_timestamp(&name, "workspaces.") else { continue };
            let Ok(bytes) = fsutil::read_capped(&e.path(), REGISTRY_CAP) else { continue };
            if let Ok(f) = model::parse_registry(&bytes) {
                out.push(BackupInfo { name, at, workspaces: f.workspaces.len() as u32 });
            }
        }
        out.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| b.name.cmp(&a.name)));
        out
    }

    /// Cheap and probe-free: reads the registry and the (small) workspace files.
    pub fn view(&self) -> RegistryView {
        // A second instance may become the first once the other one quit ("Try again").
        self.retry_instance_lock();
        if let Some(pinned) = &self.loc.pinned {
            let ws = workspace::load_existing(pinned).ok();
            let summary = WorkspaceSummary {
                id: "pinned".into(),
                name: "pinned".into(),
                color: PALETTE[0].into(),
                order: 0,
                created_at: 0,
                last_opened_at: None,
                origin: WorkspaceOrigin::Created,
                repos: ws.as_ref().map(|w| w.repos.iter().map(repo_summary).collect()).unwrap_or_default(),
                file_state: if ws.is_some() { None } else { Some(WorkspaceFileState::Damaged) },
            };
            return RegistryView { version: 1, rev: 0, active_id: Some("pinned".into()), pinned: true, workspaces: vec![summary], problem: None, open_error: None, epoch: None, crash_loop: None, just_migrated: false, env_ignored: false };
        }
        let problem = self.current_problem();
        let file = self.read_file().ok().flatten();
        let Some(file) = file else {
            return RegistryView { version: 1, rev: 0, active_id: None, pinned: false, workspaces: Vec::new(), problem, open_error: None, epoch: None, crash_loop: None, just_migrated: false, env_ignored: self.loc.env_ignored };
        };
        let mut workspaces = Vec::new();
        for s in file.sorted() {
            let e = &s.entry;
            let (repos, state) = match self.load_workspace(&e.id) {
                Ok(ws) => (ws.repos.iter().map(repo_summary).collect(), None),
                Err(err) if err.code == code::WORKSPACE_FILE_MISSING => (Vec::new(), Some(WorkspaceFileState::Missing)),
                Err(_) => (Vec::new(), Some(WorkspaceFileState::Damaged)),
            };
            workspaces.push(WorkspaceSummary {
                id: e.id.clone(),
                name: e.name.clone(),
                color: e.color.clone(),
                order: e.order,
                created_at: e.created_at,
                last_opened_at: e.last_opened_at,
                origin: e.origin.clone(),
                repos,
                file_state: state,
            });
        }
        let active_id = file.active_id.clone().filter(|id| file.find(id).is_some());
        let open_error = active_id.as_ref().and_then(|id| {
            workspaces.iter().find(|w| &w.id == id).and_then(|w| match w.file_state {
                Some(WorkspaceFileState::Missing) => Some(OpenError { id: id.clone(), reason: OpenErrorReason::FileMissing }),
                Some(WorkspaceFileState::Damaged) => Some(OpenError { id: id.clone(), reason: OpenErrorReason::FileDamaged }),
                _ => None,
            })
        });
        RegistryView { version: 1, rev: file.rev, active_id, pinned: false, workspaces, problem, open_error, epoch: None, crash_loop: None, just_migrated: false, env_ignored: self.loc.env_ignored }
    }

    fn retry_instance_lock(&self) {
        let waiting = matches!(self.blocked.lock().expect("blocked").as_ref(), Some((ProblemKind::OtherInstance, _)));
        if !waiting {
            return;
        }
        if let Ok(Some(lock)) = fsutil::try_lock(&self.loc.instance_lock()) {
            *self.instance.lock().expect("instance") = Some(lock);
            *self.blocked.lock().expect("blocked") = None;
            if !self.loc.registry.exists() && self.loc.legacy_file().exists() {
                if let Err(why) = self.migrate_legacy() {
                    *self.legacy_problem.lock().expect("legacy") = Some(why);
                }
            }
        }
    }

    /// The active workspace as `open` would load it now (after a "Try again").
    pub fn active(&self) -> Option<ActiveWorkspace> {
        if self.loc.pinned.is_some() {
            let p = self.loc.pinned.clone()?;
            return workspace::load_existing(&p).ok().map(|workspace| ActiveWorkspace { id: "pinned".into(), path: p, workspace });
        }
        self.load_active()
    }

    // ---- writing -------------------------------------------------------------------------------------------------

    fn writable(&self) -> Result<(), EngineError> {
        if self.loc.pinned.is_some() {
            return Err(EngineError::new(code::PINNED, "the workspace is fixed by INTELY_WORKSPACE"));
        }
        self.retry_instance_lock();
        if let Some((kind, msg)) = self.blocked.lock().expect("blocked").clone() {
            let c = match kind {
                ProblemKind::OtherInstance => code::OTHER_INSTANCE,
                ProblemKind::TestJail => crate::jail::TEST_JAIL,
                _ => code::IO,
            };
            return Err(EngineError::new(c, msg));
        }
        Ok(())
    }

    fn fault(&self) -> Option<&Fault> {
        self.env.fault.as_ref()
    }

    fn hit(&self, stage: &str) -> Result<(), EngineError> {
        match self.fault() {
            Some(f) => f(stage).map_err(Into::into),
            None => Ok(()),
        }
    }

    /// One registry mutation: lock, re-read from disk under the lock, apply, back up (structural), write atomically.
    fn with_lock<T>(&self, f: impl FnOnce(&mut Tx<'_>) -> Result<T, EngineError>) -> Result<T, EngineError> {
        self.writable()?;
        fsutil::ensure_dir(&self.loc.dir)?;
        let lock = fsutil::lock_with_timeout(&self.loc.mutation_lock(), self.env.lock_wait)?
            .ok_or_else(|| EngineError::new(code::REGISTRY_BUSY, "the workspace list is busy"))?;
        let existing = self.read_file()?;
        let existed = existing.is_some();
        let mut tx = Tx { reg: self, file: existing.unwrap_or_else(RegistryFile::empty), structural: false, dirty: true };
        let out = f(&mut tx)?;
        if tx.dirty {
            let old_rev = tx.file.rev;
            tx.file.rev += 1;
            if tx.structural && existed {
                // `read_file` succeeded above, so the current file parses: a damaged file never pushes a good backup out.
                let _ = fsutil::rotate_backup(&self.loc.registry, &self.loc.backups_dir(), "workspaces.", Some(old_rev), REGISTRY_BACKUPS, 7, self.now_ms());
            }
            let json = model::to_json(&tx.file);
            fsutil::write_atomic(&self.loc.registry, &json, 0o600, self.fault())?;
        }
        drop(lock);
        Ok(out)
    }

    fn write_workspace_file(&self, id: &str, ws: &Workspace) -> Result<(), EngineError> {
        let path = self.workspace_path(id)?;
        let mut json = serde_json::to_vec_pretty(ws).map_err(|e| EngineError::new(code::IO, e.to_string()))?;
        json.push(b'\n');
        fsutil::write_atomic(&path, &json, 0o600, self.fault())?;
        Ok(())
    }

    // ---- the mutations -------------------------------------------------------------------------------------------

    pub fn create(&self, req: NewWorkspace) -> Result<WorkspaceEntry, EngineError> {
        let name = model::normalize_name(&req.name)?;
        if let Some(c) = &req.color {
            model::check_color(c)?;
        }
        if req.repos.len() > model::MAX_REPOS {
            return Err(EngineError::new(code::LIMIT_REACHED, "a workspace holds at most 100 repositories"));
        }
        self.with_lock(|tx| {
            if tx.file.workspaces.len() >= model::MAX_WORKSPACES {
                return Err(EngineError::new(code::LIMIT_REACHED, "at most 200 workspaces"));
            }
            tx.check_name_free(&name, None)?;
            let id = tx.fresh_id();
            let color = req.color.clone().unwrap_or_else(|| model::next_color(&tx.file.workspaces.iter().map(|w| w.entry.color.clone()).collect::<Vec<_>>()));
            let empty = empty_workspace();
            let all = self.all_workspaces(&tx.file);
            let repos = self.build_repos(&empty, &req.repos, &all)?;
            let mut ws = Workspace { repos, ..empty };
            ws.protected_branches = self.protected_for_new(&ws, &req.repos, &all);
            workspace::validate_structure(&ws)?;
            self.write_workspace_file(&id, &ws)?;
            let entry = WorkspaceEntry {
                id,
                name: name.clone(),
                color,
                order: tx.file.next_order(),
                created_at: self.now_ms(),
                last_opened_at: None,
                origin: req.origin.clone(),
            };
            tx.file.workspaces.push(StoredEntry { entry: entry.clone(), extra: BTreeMap::new() });
            tx.structural = true;
            Ok(entry)
        })
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<WorkspaceEntry, EngineError> {
        let name = model::normalize_name(name)?;
        self.with_lock(|tx| {
            tx.require(id)?;
            tx.check_name_free(&name, Some(id))?;
            let e = tx.file.find_mut(id).expect("required");
            e.entry.name = name;
            tx.structural = true;
            Ok(tx.file.find(id).expect("required").entry.clone())
        })
    }

    pub fn recolor(&self, id: &str, color: &str) -> Result<WorkspaceEntry, EngineError> {
        model::check_color(color)?;
        self.with_lock(|tx| {
            tx.require(id)?;
            tx.file.find_mut(id).expect("required").entry.color = color.to_lowercase();
            tx.structural = true;
            Ok(tx.file.find(id).expect("required").entry.clone())
        })
    }

    /// Copies the workspace file (repos, protected/live branches, settings); `lastOpenedAt` starts empty.
    pub fn duplicate(&self, id: &str, name: Option<&str>) -> Result<WorkspaceEntry, EngineError> {
        let wanted = name.map(model::normalize_name).transpose()?;
        self.with_lock(|tx| {
            tx.require(id)?;
            if tx.file.workspaces.len() >= model::MAX_WORKSPACES {
                return Err(EngineError::new(code::LIMIT_REACHED, "at most 200 workspaces"));
            }
            let src = tx.file.find(id).expect("required").entry.clone();
            let name = match wanted {
                Some(n) => {
                    tx.check_name_free(&n, None)?;
                    n
                }
                None => tx.unique_copy_name(&src.name),
            };
            let ws = self.load_workspace(id)?;
            let new_id = tx.fresh_id();
            self.write_workspace_file(&new_id, &ws)?;
            let entry = WorkspaceEntry {
                id: new_id,
                name,
                color: src.color,
                order: tx.file.next_order(),
                created_at: self.now_ms(),
                last_opened_at: None,
                origin: WorkspaceOrigin::Duplicate,
            };
            tx.file.workspaces.push(StoredEntry { entry: entry.clone(), extra: BTreeMap::new() });
            tx.structural = true;
            Ok(entry)
        })
    }

    /// Removes the entry; the workspace file moves to `workspaces/removed/<id>-<unixms>.json`, its live and protected
    /// patterns are folded into `live-floor.json` first (4.12). Refuses the active id.
    pub fn remove(&self, id: &str, confirm: bool) -> Result<(), EngineError> {
        if !confirm {
            return Err(EngineError::new(code::CONFIRM_REQUIRED, "removing a workspace needs confirmation"));
        }
        self.with_lock(|tx| {
            tx.require(id)?;
            if tx.file.active_id.as_deref() == Some(id) {
                return Err(EngineError::new(code::WORKSPACE_ACTIVE, "close the workspace before removing it"));
            }
            let ws = self.load_workspace(id).ok();
            if let Some(ws) = &ws {
                self.fold_into_floor(ws)?;
            }
            tx.file.workspaces.retain(|w| w.entry.id != id);
            tx.structural = true;
            // After the registry no longer lists it, the file moves aside. The registry write happens when `with_lock`
            // returns; moving first would lose the workspace on a failed write, so the move is deferred.
            Ok(())
        })?;
        self.archive_workspace_file(id);
        Ok(())
    }

    pub fn reorder(&self, ids: &[String]) -> Result<(), EngineError> {
        self.with_lock(|tx| {
            let have = tx.file.ids();
            let want: HashSet<String> = ids.iter().cloned().collect();
            if want.len() != ids.len() || want != have {
                return Err(EngineError::new(code::INVALID_SELECTION, "the order must list every workspace exactly once"));
            }
            for (i, id) in ids.iter().enumerate() {
                tx.file.find_mut(id).expect("checked").entry.order = i as u32;
            }
            tx.structural = true;
            Ok(())
        })
    }

    /// Records the active workspace (`None` closes) and stamps `lastOpenedAt`. Not a structural change: no backup.
    pub fn set_active(&self, id: Option<&str>) -> Result<(), EngineError> {
        self.with_lock(|tx| {
            if let Some(id) = id {
                tx.require(id)?;
                let now = self.now_ms();
                tx.file.find_mut(id).expect("required").entry.last_opened_at = Some(now);
            }
            tx.file.active_id = id.map(str::to_owned);
            Ok(())
        })
    }

    /// Writes the workspace file of a registered workspace (engine saves of non-pinned workspaces go through
    /// `workspace::save_to`; this is for registry-level edits such as relocating a repo of a non-active workspace).
    pub fn update_workspace(&self, id: &str, edit: impl FnOnce(&mut Workspace) -> Result<(), EngineError>) -> Result<Workspace, EngineError> {
        self.with_lock(|tx| {
            tx.require(id)?;
            let mut ws = self.load_workspace(id)?;
            edit(&mut ws)?;
            workspace::validate_structure(&ws)?;
            let path = self.workspace_path(id)?;
            if path.exists() {
                let _ = fsutil::rotate_backup(&path, &self.loc.backups_dir(), &format!("ws-{id}."), None, WORKSPACE_BACKUPS, 0, self.now_ms());
            }
            self.write_workspace_file(id, &ws)?;
            tx.dirty = false;
            Ok(ws)
        })
    }

    fn archive_workspace_file(&self, id: &str) {
        let Ok(src) = self.workspace_path(id) else { return };
        let removed = self.loc.removed_dir();
        if fsutil::ensure_dir(&removed).is_err() {
            return;
        }
        let dest = removed.join(format!("{id}-{}.json", self.now_ms()));
        if std::fs::rename(&src, &dest).is_ok() {
            self.prune_removed();
        }
    }

    fn prune_removed(&self) {
        let removed = self.loc.removed_dir();
        let Ok(rd) = std::fs::read_dir(&removed) else { return };
        let mut files: Vec<(i64, PathBuf)> = rd
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let stem = name.strip_suffix(".json")?;
                let ts: i64 = stem.rsplit('-').next()?.parse().ok()?;
                Some((ts, e.path()))
            })
            .collect();
        files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        for (_, p) in files.into_iter().skip(REMOVED_KEEP) {
            let _ = std::fs::remove_file(p);
        }
    }

    // ---- problem actions (3.11) ----------------------------------------------------------------------------------

    /// Replaces a damaged registry by one of its listed backups; the damaged file is moved to
    /// `workspaces.json.corrupt-<unixms>` first.
    pub fn restore_backup(&self, backup_name: &str) -> Result<(), EngineError> {
        self.writable()?;
        let listed = self.list_backups();
        let Some(info) = listed.iter().find(|b| b.name == backup_name) else {
            return Err(EngineError::new(code::INVALID_SELECTION, "that backup is not listed"));
        };
        let _lock = fsutil::lock_with_timeout(&self.loc.mutation_lock(), self.env.lock_wait)?.ok_or_else(|| EngineError::new(code::REGISTRY_BUSY, "the workspace list is busy"))?;
        match self.read_file() {
            Err(e) if e.code == code::UNSUPPORTED_VERSION => return Err(e),
            Err(_) => self.move_aside()?,
            Ok(Some(_)) => {
                // a healthy registry is snapshotted before it is replaced
                let _ = fsutil::rotate_backup(&self.loc.registry, &self.loc.backups_dir(), "workspaces.", None, REGISTRY_BACKUPS, 7, self.now_ms());
            }
            Ok(None) => {}
        }
        let bytes = fsutil::read_capped(&self.loc.backups_dir().join(&info.name), REGISTRY_CAP)?;
        fsutil::write_atomic(&self.loc.registry, &bytes, 0o600, self.fault())?;
        Ok(())
    }

    /// Moves a damaged registry aside (it is kept as `workspaces.json.corrupt-<unixms>`); a newer-version file is never touched.
    pub fn start_fresh(&self) -> Result<(), EngineError> {
        self.writable()?;
        let _lock = fsutil::lock_with_timeout(&self.loc.mutation_lock(), self.env.lock_wait)?.ok_or_else(|| EngineError::new(code::REGISTRY_BUSY, "the workspace list is busy"))?;
        match self.read_file() {
            Err(e) if e.code == code::UNSUPPORTED_VERSION => Err(e),
            Err(_) => self.move_aside(),
            Ok(_) => Ok(()),
        }
    }

    fn move_aside(&self) -> Result<(), EngineError> {
        let mut dest = self.loc.registry.clone().into_os_string();
        dest.push(format!(".corrupt-{}", self.now_ms()));
        std::fs::rename(&self.loc.registry, PathBuf::from(dest))?;
        Ok(())
    }

    // ---- side stores ---------------------------------------------------------------------------------------------

    /// Whether the acknowledged config-risk set of `canonical_path` is the one with hash `hash`.
    pub fn trust_state(&self, canonical_path: &str, hash: &str) -> TrustState {
        let file: stores::TrustFile = fsutil::read_capped(&self.loc.trust_file(), REGISTRY_CAP).ok().and_then(|b| stores::parse(&b, "trust.json").ok()).unwrap_or_default();
        file.state(canonical_path, hash)
    }

    /// Persists "the user accepted this risk set for this repo".
    pub fn trust_accept(&self, canonical_path: &str, hash: &str) -> Result<(), EngineError> {
        self.writable()?;
        let _lock = fsutil::lock_with_timeout(&self.loc.mutation_lock(), self.env.lock_wait)?.ok_or_else(|| EngineError::new(code::REGISTRY_BUSY, "the workspace list is busy"))?;
        let mut file: stores::TrustFile = match fsutil::read_capped(&self.loc.trust_file(), REGISTRY_CAP) {
            Ok(b) => stores::parse(&b, "trust.json")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => stores::TrustFile::default(),
            Err(e) => return Err(e.into()),
        };
        file.repos.insert(canonical_path.to_owned(), stores::TrustEntry { hash: hash.to_owned(), at: self.now_ms() });
        let mut json = serde_json::to_vec_pretty(&file).expect("serialises");
        json.push(b'\n');
        fsutil::write_atomic(&self.loc.trust_file(), &json, 0o600, self.fault())?;
        Ok(())
    }

    fn read_floor(&self) -> Result<stores::FloorFile, EngineError> {
        match fsutil::read_capped(&self.loc.floor_file(), REGISTRY_CAP) {
            Ok(b) => stores::parse(&b, "live-floor.json"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(stores::FloorFile::default()),
            Err(e) => Err(e.into()),
        }
    }

    /// Folds the protection of a workspace being removed into `live-floor.json` (called under the registry lock).
    fn fold_into_floor(&self, ws: &Workspace) -> Result<(), EngineError> {
        let mut floor = self.read_floor()?;
        let before = floor.clone();
        for repo in &ws.repos {
            let identity = self.prober.identity(Path::new(&repo.path), Duration::from_secs(1)).unwrap_or_default();
            let live = ws.live_branches.get(&repo.id).cloned().unwrap_or_default();
            let custom: Vec<String> = ws.protected_branches.iter().filter(|b| !FLOOR_PROTECTED.contains(&b.as_str())).cloned().collect();
            floor.fold(&repo.path, &identity, &custom, &live);
        }
        if floor != before {
            let mut json = serde_json::to_vec_pretty(&floor).expect("serialises");
            json.push(b'\n');
            fsutil::write_atomic(&self.loc.floor_file(), &json, 0o600, self.fault())?;
        }
        Ok(())
    }
}

/// A registry transaction: what a mutation closure sees.
struct Tx<'a> {
    reg: &'a Registry,
    file: RegistryFile,
    structural: bool,
    dirty: bool,
}

impl Tx<'_> {
    fn require(&self, id: &str) -> Result<(), EngineError> {
        if self.file.find(id).is_some() {
            Ok(())
        } else {
            Err(not_found(id))
        }
    }

    fn check_name_free(&self, name: &str, except: Option<&str>) -> Result<(), EngineError> {
        let key = model::name_key(name);
        if self.file.workspaces.iter().any(|w| Some(w.entry.id.as_str()) != except && model::name_key(&w.entry.name) == key) {
            return Err(EngineError::new(code::DUPLICATE_NAME, "a workspace with this name already exists"));
        }
        Ok(())
    }

    fn fresh_id(&self) -> String {
        let taken = self.file.ids();
        for _ in 0..16 {
            let id = (self.reg.env.new_id)();
            if model::valid_id(&id) && !taken.contains(&id) && id != MIGRATED_ID {
                return id;
            }
        }
        // the injected source is stuck (tests): derive a unique one
        let mut n = taken.len();
        loop {
            let id = format!("w{n:x}-x");
            if !taken.contains(&id) {
                return id;
            }
            n += 1;
        }
    }

    fn unique_copy_name(&self, base: &str) -> String {
        let mut candidate = format!("{base} copy");
        let mut n = 2;
        while self.check_name_free(&candidate, None).is_err() || model::normalize_name(&candidate).is_err() {
            if model::normalize_name(&candidate).is_err() {
                // the base is too long for a suffix: shorten it
                let cut: String = base.chars().take(40).collect();
                candidate = format!("{cut} copy {n}");
            } else {
                candidate = format!("{base} copy {n}");
            }
            n += 1;
        }
        candidate
    }
}

fn not_found(id: &str) -> EngineError {
    EngineError::new(code::WORKSPACE_NOT_FOUND, "no such workspace").with_detail(id.to_owned())
}

fn repo_summary(r: &RepoConfig) -> RepoSummary {
    RepoSummary { id: r.id.clone(), name: r.name.clone(), color: r.color.clone(), badge: r.badge.clone(), path: r.path.clone() }
}

/// A workspace with no repositories and the generic defaults.
pub fn empty_workspace() -> Workspace {
    workspace::empty()
}

/// Folded comparison key of a repository path.
pub fn repo_path_key(path: &str) -> String {
    path_key(path)
}

/// Re-exported for the engine: the union rule of 4.12 over a [`Protection`].
pub fn merge_protection(into: &mut Protection, other: &Protection) {
    for p in &other.protected {
        if !into.protected.contains(p) {
            into.protected.push(p.clone());
        }
    }
    for l in &other.live {
        if !into.live.contains(l) {
            into.live.push(l.clone());
        }
    }
}
