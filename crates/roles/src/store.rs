//! Roles on disk: `~/.claude/agents/*.md` (global) and `<repo>/.claude/agents/*.md` (per repo), plus the IDE overlay
//! (permission mode, repo scope, provider, remote placeholder) that Claude Code's file format has no place for.
//! Writes touch only the keys the editor owns (see `frontmatter`) and only files inside those directories.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use intely_agent_core::providers::{Cap, Effort, PermissionMode};
use intely_agent_host::roles::{static_caps, RoleDef, RoleFile, CLAUDE_DISALLOWED, SYSTEM_PREAMBLE};
use intely_agent_host::RepoRef;
use intely_core::jail::{Jail, READ_ONLY, TEST_JAIL};
use intely_core::EngineError;
use serde::{Deserialize, Serialize};

use sha2::{Digest, Sha256};

use crate::frontmatter::Document;
use crate::permission::{derive_permission, min_permission, rank};
use crate::types::{ModelCaps, PermissionSource, Role, RoleDraft, RoleDrift, RoleEffort, RolePermission, RoleProviderCaps, RoleScope, RoleTrust, SkippedAgentsDir};

pub const MODEL_HAIKU: &str = "claude-haiku-4-5-20251001";
pub const MODEL_SONNET: &str = "claude-sonnet-5-5";
pub const MODEL_OPUS: &str = "claude-opus-5-5";
const MAX_ROLE_FILE: u64 = 256 * 1024;
/// A save that would change a role file was not confirmed by the caller (`RoleDraft::confirm_write`).
pub const CONFIRM_WRITE: &str = "confirmWrite";
/// There is no place for the backup of the old file, so the file is not touched.
pub const NO_BACKUP_DIR: &str = "noBackupDir";
/// `roles-overlay.json` could not be read: every role is read-only and writes are refused until it is reset.
pub const OVERLAY_CORRUPT: &str = "overlayCorrupt";
/// The name belongs to Claude's own agent types or to the IDE (`auto`, `Explore`, ...).
pub const RESERVED_NAME: &str = "reservedName";
/// Claude's own agent types and the IDE's own role names. Compared case-insensitively.
pub const RESERVED_NAMES: [&str; 7] = ["auto", "probe", "general-purpose", "explore", "plan", "statusline-setup", "fork"];

pub fn is_reserved(name: &str) -> bool {
    RESERVED_NAMES.iter().any(|r| r.eq_ignore_ascii_case(name.trim()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleError {
    pub code: &'static str,
    pub message: String,
}

fn rerr(code: &'static str, message: impl Into<String>) -> RoleError {
    RoleError { code, message: message.into() }
}

impl std::fmt::Display for RoleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RoleError {}

impl From<RoleError> for EngineError {
    fn from(e: RoleError) -> Self {
        EngineError::new(e.code, e.message)
    }
}

/// The IDE-side settings of one role (settings namespace `roles`). The key is the role file id (`name` for a global
/// file, `name@repoId` for a repository copy); `hidden`, `pin` and `approvedHashes` live on the entry whose key is the
/// group NAME. Unknown keys of older versions (`shadowNoticeDone`) are ignored on load and dropped on the next write.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlay {
    /// An explicit permission: it always wins over what the file derives.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<RolePermission>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub repo_scope: Vec<String>,
    #[serde(default)]
    pub remote_startable: bool,
    /// The whole group is hidden in IntelyIDE (list, New run, delegates). Files are never touched.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    /// `global` or `repo:<repoId>`: the copy a run uses although copies differ.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin: Option<String>,
    /// Content hashes of repository copies the user trusts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub approved_hashes: Vec<String>,
}

/// What reading the overlay found.
#[derive(Debug, Clone, PartialEq)]
pub enum OverlayState {
    Ok(BTreeMap<String, Overlay>),
    /// Present but unreadable or unparsable; `backup` is where the bytes were copied (never overwritten).
    Corrupt { backup: Option<PathBuf> },
}

/// Where the overlay lives. The settings module (track F) provides the real store; until then a JSON file.
pub trait OverlayStore: Send + Sync {
    fn load(&self) -> BTreeMap<String, Overlay>;
    fn save(&self, all: &BTreeMap<String, Overlay>) -> std::io::Result<()>;
    /// Like [`Self::load`], but a present and broken overlay is `Corrupt` instead of silently empty (an empty overlay
    /// would let every role derive its permission from its file).
    fn load_state(&self) -> OverlayState {
        OverlayState::Ok(self.load())
    }
    /// Starts over with an empty overlay (the repair action after `Corrupt`).
    fn reset(&self) -> std::io::Result<()> {
        self.save(&BTreeMap::new())
    }
    /// Where backups of role files go: next to the overlay (the IDE's data directory), never under `~/.claude`.
    fn backup_dir(&self) -> Option<PathBuf> {
        None
    }
}

pub struct FileOverlay(pub PathBuf);

impl FileOverlay {
    /// Copies unreadable bytes to `<file>.bak` (or `.bak2`, ...): an earlier backup is never overwritten.
    fn keep_bak(&self, bytes: &[u8]) -> Option<PathBuf> {
        let name = self.0.file_name()?.to_string_lossy().into_owned();
        for n in 1..100 {
            let target = self.0.with_file_name(if n == 1 { format!("{name}.bak") } else { format!("{name}.bak{n}") });
            match std::fs::read(&target) {
                Ok(existing) if existing == bytes => return Some(target),
                Ok(_) => continue,
                Err(_) => return std::fs::write(&target, bytes).ok().map(|_| target),
            }
        }
        None
    }
}

impl OverlayStore for FileOverlay {
    fn load(&self) -> BTreeMap<String, Overlay> {
        match self.load_state() {
            OverlayState::Ok(m) => m,
            OverlayState::Corrupt { .. } => BTreeMap::new(),
        }
    }

    fn load_state(&self) -> OverlayState {
        match std::fs::read(&self.0) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => OverlayState::Ok(BTreeMap::new()),
            Err(_) => OverlayState::Corrupt { backup: None },
            Ok(b) if b.iter().all(u8::is_ascii_whitespace) => OverlayState::Ok(BTreeMap::new()),
            Ok(b) => match serde_json::from_slice::<BTreeMap<String, Overlay>>(&b) {
                Ok(m) => OverlayState::Ok(m),
                Err(_) => OverlayState::Corrupt { backup: self.keep_bak(&b) },
            },
        }
    }

    fn save(&self, all: &BTreeMap<String, Overlay>) -> std::io::Result<()> {
        write_atomic(&self.0, &serde_json::to_vec_pretty(all).map_err(std::io::Error::other)?)
    }

    fn reset(&self) -> std::io::Result<()> {
        if let Ok(bytes) = std::fs::read(&self.0) {
            if !bytes.iter().all(u8::is_ascii_whitespace) && self.keep_bak(&bytes).is_none() {
                return Err(std::io::Error::other("cannot keep a copy of the unreadable overlay"));
            }
        }
        write_atomic(&self.0, b"{}")
    }

    fn backup_dir(&self) -> Option<PathBuf> {
        self.0.parent().map(|d| d.join("role-backups"))
    }
}

#[derive(Default)]
pub struct MemoryOverlay(Mutex<BTreeMap<String, Overlay>>);

impl OverlayStore for MemoryOverlay {
    fn load(&self) -> BTreeMap<String, Overlay> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn save(&self, all: &BTreeMap<String, Overlay>) -> std::io::Result<()> {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = all.clone();
        Ok(())
    }
}

/// Writes next to the target and renames, following a symlink (dotfile setups link `~/.claude/agents`).
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let real = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if let Some(dir) = real.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = real.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    if let Ok(meta) = std::fs::metadata(&real) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, &real).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// `YYYYMMDD-HHMMSS-mmm` in UTC (file names sort by time).
fn timestamp() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let (secs, ms) = (now.as_secs() as i64, now.subsec_millis());
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}{month:02}{day:02}-{:02}{:02}{:02}-{ms:03}", rem / 3_600, rem % 3_600 / 60, rem % 60)
}

pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric()) && name.len() <= 64 && chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The model an alias stands for; ids pass through.
pub fn resolve_model(model: &str) -> String {
    match model.trim().to_ascii_lowercase().as_str() {
        "" | "inherit" | "default" | "sonnet" => MODEL_SONNET.into(),
        "haiku" => MODEL_HAIKU.into(),
        "opus" => MODEL_OPUS.into(),
        _ => model.trim().to_string(),
    }
}

/// False when the provider declares no effort control or the model (Haiku) has none.
pub fn effort_available(provider: &str, model: &str) -> bool {
    static_caps(provider).effort.cap != Cap::No && !resolve_model(model).contains("haiku")
}

fn parse_effort(s: &str) -> Option<RoleEffort> {
    Some(match s.trim().to_ascii_lowercase().as_str() {
        "low" => RoleEffort::Low,
        "medium" => RoleEffort::Medium,
        "high" => RoleEffort::High,
        "xhigh" => RoleEffort::Xhigh,
        "max" => RoleEffort::Max,
        _ => return None,
    })
}

fn effort_str(e: RoleEffort) -> &'static str {
    match e {
        RoleEffort::Low => "low",
        RoleEffort::Medium => "medium",
        RoleEffort::High => "high",
        RoleEffort::Xhigh => "xhigh",
        RoleEffort::Max => "max",
    }
}

pub(crate) fn host_effort(e: RoleEffort) -> Effort {
    match e {
        RoleEffort::Low => Effort::Low,
        RoleEffort::Medium => Effort::Medium,
        RoleEffort::High => Effort::High,
        // `max` is never sent: it multiplies cost without a matching gain (saving it is refused, a hand-edited file is clamped)
        RoleEffort::Xhigh => Effort::Xhigh,
        RoleEffort::Max => Effort::High,
    }
}

pub(crate) fn host_permission(p: RolePermission) -> PermissionMode {
    match p {
        RolePermission::ReadOnly => PermissionMode::ReadOnly,
        RolePermission::Edit => PermissionMode::Edit,
        RolePermission::Ask => PermissionMode::Ask,
    }
}

pub fn role_id(name: &str, repo_id: Option<&str>) -> String {
    repo_id.map_or_else(|| name.to_string(), |r| format!("{name}@{r}"))
}

fn agents_dir(repo: &RepoRef) -> PathBuf {
    repo.path.join(".claude").join("agents")
}

/// A repository is untrusted input: a role is never written through a symlinked `.claude` or `.claude/agents`, or into
/// a directory that leaves the repository (the scan and the delete refuse the same directories).
fn guard_repo_agents_dir(repo: &RepoRef) -> Result<(), RoleError> {
    let dir = agents_dir(repo);
    for p in [repo.path.join(".claude"), dir.clone()] {
        if std::fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(rerr("agentsDirSymlink", format!("{} is a symlink; a role is not written through it", p.display())));
        }
    }
    if dir.exists() && !matches!((dir.canonicalize(), repo.path.canonicalize()), (Ok(d), Ok(r)) if d.starts_with(&r)) {
        return Err(rerr("agentsDirSymlink", format!("{} leaves the repository {}", dir.display(), repo.id)));
    }
    Ok(())
}

pub struct RoleStore {
    pub(crate) global_dir: PathBuf,
    pub(crate) overlay: Box<dyn OverlayStore>,
    /// Serialises read-modify-write of the overlay and the role files.
    pub(crate) write: Mutex<()>,
    pub(crate) jail: Jail,
    /// Overrides [`OverlayStore::backup_dir`] (tests).
    backup_dir: Option<PathBuf>,
    /// The built-in roles of the host (name, and its definition when known); a role file with one of these names
    /// shadows it, and a repository copy never exceeds its permission.
    pub(crate) builtins: Vec<(String, Option<RoleDef>)>,
}

/// Everything one pass over the disk and the overlay found.
pub(crate) struct Snapshot {
    /// Every role file, global first; duplicates in one directory included (`shadowed_by_duplicate`).
    pub roles: Vec<Role>,
    pub overlay: BTreeMap<String, Overlay>,
    pub corrupt: bool,
    pub skipped: Vec<SkippedAgentsDir>,
}

impl RoleStore {
    pub fn new(global_dir: PathBuf, overlay: Box<dyn OverlayStore>) -> Self {
        Self { global_dir, overlay, write: Mutex::new(()), jail: (*Jail::global()).clone(), backup_dir: None, builtins: Vec::new() }
    }

    /// Replaces the process-wide jail (tests).
    pub fn with_jail(mut self, jail: Jail) -> Self {
        self.jail = jail;
        self
    }

    /// Where the backups of role files go instead of the overlay's directory.
    pub fn with_backup_dir(mut self, dir: PathBuf) -> Self {
        self.backup_dir = Some(dir);
        self
    }

    /// The names of the built-in roles (no definitions: they cannot be listed, and cap nothing).
    pub fn with_builtin_names(mut self, names: Vec<String>) -> Self {
        self.builtins = names.into_iter().map(|n| (n, None)).collect();
        self
    }

    /// The built-in roles of the host: a role file with one of these names shadows it, the group of a built-in without
    /// a file is listed, and a repository copy never exceeds the built-in's permission. Mock roles are not listed.
    pub fn with_builtin_defs(mut self, defs: Vec<RoleDef>) -> Self {
        self.builtins = defs.into_iter().map(|d| (d.name.clone(), Some(d))).collect();
        self
    }

    pub(crate) fn builtin_def(&self, name: &str) -> Option<&RoleDef> {
        self.builtins.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).and_then(|(_, d)| d.as_ref())
    }

    pub(crate) fn is_builtin(&self, name: &str) -> bool {
        self.builtins.iter().any(|(n, _)| n.eq_ignore_ascii_case(name))
    }

    /// The backup directory, checked: configured, outside `.claude`, created.
    fn backup_dir_checked(&self) -> Result<PathBuf, RoleError> {
        let dir = self.backup_dir.clone().or_else(|| self.overlay.backup_dir()).ok_or_else(|| rerr(NO_BACKUP_DIR, "no backup directory is configured, so the role file is left as it is"))?;
        let real = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        let global_real = self.global_dir.canonicalize().unwrap_or_else(|_| self.global_dir.clone());
        if real.components().any(|c| c.as_os_str() == ".claude") || real.starts_with(&self.global_dir) || real.starts_with(&global_real) {
            return Err(rerr(NO_BACKUP_DIR, format!("the backup directory {} must not be inside .claude", dir.display())));
        }
        std::fs::create_dir_all(&dir).map_err(|e| rerr("io", format!("cannot create {}: {e}", dir.display())))?;
        Ok(dir)
    }

    fn backup_target(dir: &Path, role_id: &str) -> PathBuf {
        let stem = format!("{}-{}", timestamp(), role_id.replace(['@', '/', '#'], "_"));
        let mut target = dir.join(format!("{stem}.md"));
        for n in 1..1000 {
            if !target.exists() {
                break;
            }
            target = dir.join(format!("{stem}-{n}.md"));
        }
        target
    }

    /// Copies the current content of a role file into the backup directory before it is replaced. Returns the copy.
    fn backup(&self, file: &Path, role_id: &str) -> Result<Option<PathBuf>, RoleError> {
        let Ok(old) = std::fs::read(file) else { return Ok(None) };
        let dir = self.backup_dir_checked()?;
        let target = Self::backup_target(&dir, role_id);
        std::fs::write(&target, old).map_err(|e| rerr("io", format!("cannot write the backup {}: {e}", target.display())))?;
        Ok(Some(target))
    }

    /// The backup of a file that is about to be DELETED: it must exist and equal the file. An unreadable file is an
    /// error (`backup` would call it "nothing to back up"), and the bytes are read back and compared.
    pub(crate) fn backup_required(&self, file: &Path, role_id: &str) -> Result<PathBuf, RoleError> {
        let old = std::fs::read(file).map_err(|e| rerr("io", format!("cannot read {} for its backup: {e}", file.display())))?;
        let dir = self.backup_dir_checked()?;
        let target = Self::backup_target(&dir, role_id);
        let verify = std::fs::write(&target, &old).and_then(|_| std::fs::read(&target));
        match verify {
            Ok(back) if back == old => Ok(target),
            Ok(_) => {
                let _ = std::fs::remove_file(&target);
                Err(rerr("io", format!("the backup {} does not match {}", target.display(), file.display())))
            }
            Err(e) => {
                let _ = std::fs::remove_file(&target);
                Err(rerr("io", format!("cannot write the backup {}: {e}", target.display())))
            }
        }
    }

    /// The directory the backups go to, when one is configured (for the delete dialog).
    pub fn backup_dir_path(&self) -> Option<PathBuf> {
        self.backup_dir.clone().or_else(|| self.overlay.backup_dir())
    }

    /// Backups made so far, oldest first.
    pub fn backups(&self) -> Vec<PathBuf> {
        let Some(dir) = self.backup_dir_path() else { return Vec::new() };
        let mut files: Vec<PathBuf> = std::fs::read_dir(dir).map(|r| r.filter_map(Result::ok).map(|e| e.path()).collect()).unwrap_or_default();
        files.sort();
        files
    }

    /// The overlay for a write. A corrupt overlay refuses (`overlayCorrupt`): writing over it would lose the user's data.
    pub(crate) fn overlay_for_write(&self) -> Result<BTreeMap<String, Overlay>, RoleError> {
        match self.overlay.load_state() {
            OverlayState::Ok(m) => Ok(m),
            OverlayState::Corrupt { backup } => Err(rerr(OVERLAY_CORRUPT, format!("roles-overlay.json cannot be read{}; reset it first", backup.map(|b| format!(" (a copy is in {})", b.display())).unwrap_or_default()))),
        }
    }

    /// Writes the overlay; entries that carry nothing any more are dropped.
    pub(crate) fn store_overlay(&self, mut all: BTreeMap<String, Overlay>) -> Result<(), RoleError> {
        all.retain(|_, o| *o != Overlay::default());
        self.overlay.save(&all).map_err(|e| rerr("io", format!("cannot save the role settings: {e}")))
    }

    /// Every write goes through here: a role file is a mutation of the directory it lives in (a repo's working tree,
    /// or `~/.claude/agents`, which the user's own Claude Code sessions read).
    pub(crate) fn check_write(&self, what: &str, file: &Path) -> Result<(), RoleError> {
        let dir = file.parent().unwrap_or(file);
        self.jail.check_op(what, dir).map_err(|e| match e.code.as_str() {
            READ_ONLY => rerr(READ_ONLY, e.message),
            _ => rerr(TEST_JAIL, e.message),
        })
    }

    pub fn global_dir(&self) -> &Path {
        &self.global_dir
    }

    /// One pass over the disk and the overlay.
    pub(crate) fn snapshot(&self, repos: &[RepoRef]) -> Snapshot {
        let (overlay, corrupt) = match self.overlay.load_state() {
            OverlayState::Ok(m) => (m, false),
            OverlayState::Corrupt { .. } => (BTreeMap::new(), true),
        };
        self.snapshot_with(overlay, corrupt, repos)
    }

    pub(crate) fn snapshot_with(&self, overlay: BTreeMap<String, Overlay>, corrupt: bool, repos: &[RepoRef]) -> Snapshot {
        let mut skipped = Vec::new();
        let mut roles = scan(&self.global_dir, None, &overlay, &mut skipped);
        for repo in repos {
            roles.extend(scan(&agents_dir(repo), Some(repo), &overlay, &mut skipped));
        }
        self.finish(&mut roles, &overlay, corrupt);
        Snapshot { roles, overlay, corrupt, skipped }
    }

    /// What needs every file at once: trust of repository copies, the ceiling below a global or built-in role of the
    /// same name, and the fail-safe of a corrupt overlay.
    fn finish(&self, roles: &mut [Role], overlay: &BTreeMap<String, Overlay>, corrupt: bool) {
        if corrupt {
            for r in roles.iter_mut() {
                r.permission = RolePermission::ReadOnly;
                r.permission_source = PermissionSource::OverlayCorrupt;
                r.permission_reason = Some("overlayCorrupt".into());
                r.can_edit = false;
                r.can_run = false;
            }
        }
        let globals: Vec<(String, String, RolePermission)> = roles.iter().filter(|r| r.scope == RoleScope::Global && !r.shadowed_by_duplicate).map(|r| (r.name.to_ascii_lowercase(), r.content_hash.clone(), r.permission)).collect();
        for r in roles.iter_mut().filter(|r| r.scope == RoleScope::Repo) {
            let lower = r.name.to_ascii_lowercase();
            let approved = overlay.get(&group_key(overlay, &r.name)).is_some_and(|o| o.approved_hashes.contains(&r.content_hash));
            r.trust = if globals.iter().any(|(n, h, _)| *n == lower && *h == r.content_hash) {
                RoleTrust::Trusted
            } else if approved {
                RoleTrust::Approved
            } else {
                RoleTrust::Untrusted
            };
            // A repository copy never exceeds the global role of its name, or the built-in's (an explicit overlay is the user's decision).
            if corrupt || overlay.get(&r.id).is_some_and(|o| o.permission.is_some()) {
                continue;
            }
            let cap = globals.iter().find(|(n, ..)| *n == lower).map(|(.., p)| (*p, "ceiling:global")).or_else(|| self.builtin_def(&r.name).map(|d| (role_permission(d.permission), "ceiling:builtin")));
            if let Some((cap, why)) = cap {
                if rank(r.permission) > rank(cap) {
                    r.permission = min_permission(r.permission, cap);
                    r.permission_source = PermissionSource::Ceiling;
                    r.permission_reason = Some(why.into());
                    if r.permission == RolePermission::ReadOnly {
                        r.can_edit = false;
                        r.can_run = false;
                    }
                }
            }
        }
    }

    /// One `Role` per file, global first (the copies a duplicate name hides are not listed here; see `groups`).
    pub fn list(&self, repos: &[RepoRef]) -> Vec<Role> {
        self.snapshot(repos).roles.into_iter().filter(|r| !r.shadowed_by_duplicate).collect()
    }

    /// The host's view of a role: what `session/start` needs.
    pub fn role_def(role: &Role) -> RoleDef {
        let claude = role.provider == "claude";
        let prompt = role.system_prompt.clone().unwrap_or_default();
        RoleDef {
            name: role.name.clone(),
            description: role.description.clone().unwrap_or_default(),
            provider: role.provider.clone(),
            // `default`, `haiku` ... are Claude aliases; another provider's model id (or its own `default`) goes to it unchanged
            model: if claude { resolve_model(&role.model) } else { role.model.trim().to_string() },
            effort: role.effort.filter(|_| role.effort_available).map(host_effort),
            permission: host_permission(role.permission),
            system_prompt: claude.then(|| if prompt.is_empty() { SYSTEM_PREAMBLE.to_string() } else { format!("{SYSTEM_PREAMBLE}\n\n{prompt}") }),
            tools: role.tools.clone(),
            disallowed_tools: if claude { CLAUDE_DISALLOWED.iter().map(|t| t.to_string()).collect() } else { Vec::new() },
            max_turns: claude.then_some(120),
            mock_scenario: None,
            all_repos: false,
            file: (!role.builtin).then(|| RoleFile { untrusted: role.trust == RoleTrust::Untrusted, ceiling: role.permission_source == PermissionSource::Ceiling, content_hash: role.content_hash.clone() }),
        }
    }

    /// Creates or updates a role. Only the editor's keys of an existing file change (a field the draft leaves out stays
    /// as it is); the overlay is saved beside it. The permission is pinned into the overlay only when the user set it
    /// (`permission_explicit`) or changed it from what the file derives; otherwise a later `tools` edit re-derives it.
    pub fn save(&self, draft: impl Into<RoleDraft>, repos: &[RepoRef]) -> Result<Role, RoleError> {
        let d: RoleDraft = draft.into();
        let _g = self.write.lock().unwrap_or_else(|e| e.into_inner());
        if !valid_name(&d.name) {
            return Err(rerr("invalidName", format!("{:?} is not a valid role name (letters, digits, '-' and '_')", d.name)));
        }
        if is_reserved(&d.name) {
            return Err(rerr(RESERVED_NAME, format!("{} is reserved and cannot be used as a role name", d.name)));
        }
        if d.effort == Some(RoleEffort::Max) {
            return Err(rerr("effortMax", "effort `max` is disabled: it costs far more for little gain; use `xhigh` if you must"));
        }
        let overlay = self.overlay_for_write()?;
        let from_id = d.id.as_deref().and_then(|i| i.split_once('@')).map(|(_, r)| r.to_string());
        let scope = d.scope.unwrap_or(if from_id.is_some() { RoleScope::Repo } else { RoleScope::Global });
        let repo = match (scope, d.repo_id.or(from_id)) {
            (RoleScope::Global, _) => None,
            (RoleScope::Repo, Some(id)) => Some(repos.iter().find(|r| r.id == id).ok_or_else(|| rerr("unknownRepo", format!("unknown repository {id}")))?),
            (RoleScope::Repo, None) => return Err(rerr("invalidRole", "a repo role needs a repoId")),
        };
        if let Some(r) = repo {
            guard_repo_agents_dir(r)?;
        }
        let dir = repo.map_or_else(|| self.global_dir.clone(), agents_dir);
        let id = role_id(&d.name, repo.map(|r| r.id.as_str()));
        let before = self.snapshot_with(overlay.clone(), false, repos).roles;
        let existing = before.iter().find(|r| r.id == id && !r.shadowed_by_duplicate).cloned();
        if existing.is_none() && before.iter().any(|r| r.scope == scope && r.repo_id.as_deref() == repo.map(|r| r.id.as_str()) && r.name.eq_ignore_ascii_case(&d.name) && r.id != id) {
            return Err(rerr("exists", format!("a role named like {} already exists in {}", d.name, dir.display())));
        }
        let path = existing.as_ref().map_or_else(|| dir.join(format!("{}.md", d.name)), |r| PathBuf::from(&r.path));
        self.check_write("role save", &path)?;
        if existing.is_none() && path.exists() {
            return Err(rerr("exists", format!("{} already exists", path.display())));
        }
        let mut doc = std::fs::read_to_string(&path).map(|t| Document::parse(&t)).unwrap_or_else(|_| Document::parse(""));
        doc.set("name", Some(&d.name));
        doc.set("model", Some(d.model.trim()).filter(|m| !m.is_empty()));
        for (key, value) in [("description", &d.description), ("color", &d.color), ("memory", &d.memory)] {
            if let Some(v) = value {
                doc.set(key, Some(v.trim()));
            }
        }
        if let Some(e) = d.effort {
            doc.set("effort", Some(effort_str(e)));
        }
        if let Some(tools) = &d.tools {
            doc.set_list("tools", tools);
        }
        if let Some(prompt) = &d.system_prompt {
            doc.set_prompt(prompt);
        }
        let text = doc.render();
        if std::fs::read_to_string(&path).ok().as_deref() != Some(&text) {
            if d.confirm_write != Some(true) {
                return Err(rerr(CONFIRM_WRITE, format!("saving changes {}; confirm the write first (a backup of the current file is kept)", path.display())));
            }
            self.backup(&path, &id)?;
            write_atomic(&path, text.as_bytes()).map_err(|e| rerr("io", format!("cannot write {}: {e}", path.display())))?;
        }
        // what the file derives on its own, without this entry's pinned permission
        let mut unpinned = overlay.clone();
        if let Some(o) = unpinned.get_mut(&id) {
            o.permission = None;
        }
        let derived = self.snapshot_with(unpinned, false, repos).roles.into_iter().find(|r| r.id == id && !r.shadowed_by_duplicate).map(|r| r.permission);
        let mut all = overlay;
        let mut entry = all.get(&id).cloned().unwrap_or_default();
        let current = existing.as_ref().map(|r| r.permission).or(entry.permission).or(derived);
        match (d.permission_explicit, d.permission) {
            (Some(true), Some(p)) => entry.permission = Some(p),
            (None, Some(p)) if Some(p) != current => entry.permission = if Some(p) == derived { None } else { Some(p) },
            _ => {}
        }
        entry.provider = d.provider.or(existing.as_ref().map(|r| r.provider.clone())).filter(|p| p != "claude");
        entry.repo_scope = d.repo_scope.or(existing.as_ref().map(|r| r.repo_scope.clone())).unwrap_or_default();
        entry.remote_startable = d.remote_startable.or(existing.as_ref().map(|r| r.remote_startable)).unwrap_or(false);
        all.insert(id.clone(), entry);
        self.store_overlay(all)?;
        self.list(repos).into_iter().find(|r| r.id == id).ok_or_else(|| rerr("io", "the saved role cannot be read back"))
    }

    /// Repo copies that differ from the global role of the same name.
    pub fn drift(&self, repos: &[RepoRef]) -> Vec<RoleDrift> {
        let all = self.list(repos);
        let mut out = Vec::new();
        for copy in all.iter().filter(|r| r.scope == RoleScope::Repo) {
            let (Some(global), Some(repo_id)) = (all.iter().find(|g| g.scope == RoleScope::Global && g.name.eq_ignore_ascii_case(&copy.name)), copy.repo_id.clone()) else { continue };
            let fields = diff_fields(copy, global);
            if !fields.is_empty() {
                out.push(RoleDrift { role_id: copy.id.clone(), global_id: global.id.clone(), repo_id, fields });
            }
        }
        out
    }

    /// Makes a repo copy and the global role of the same name identical by copying one file over the other.
    pub fn resolve_drift(&self, repo_role_id: &str, keep_global: bool, confirm_write: bool, repos: &[RepoRef]) -> Result<(), RoleError> {
        let _g = self.write.lock().unwrap_or_else(|e| e.into_inner());
        let all = self.list(repos);
        let copy = all.iter().find(|r| r.id == repo_role_id && r.scope == RoleScope::Repo).ok_or_else(|| rerr("unknownRole", format!("no repo role {repo_role_id}")))?;
        let global = all.iter().find(|r| r.scope == RoleScope::Global && r.name.eq_ignore_ascii_case(&copy.name)).ok_or_else(|| rerr("unknownRole", format!("no global role {}", copy.name)))?;
        let (from, to) = if keep_global { (&global.path, &copy.path) } else { (&copy.path, &global.path) };
        self.check_write("role resolve drift", Path::new(to))?;
        if !confirm_write {
            return Err(rerr(CONFIRM_WRITE, format!("resolving the drift overwrites {to}; confirm the write first (a backup of the current file is kept)")));
        }
        let text = std::fs::read(from).map_err(|e| rerr("io", format!("cannot read {from}: {e}")))?;
        let target_id = if keep_global { repo_role_id.to_string() } else { global.id.clone() };
        self.backup(Path::new(to), &target_id)?;
        write_atomic(Path::new(to), &text).map_err(|e| rerr("io", format!("cannot write {to}: {e}")))
    }

    /// "Use optimal settings" on the global roles: of each of the seven standard roles the model, effort, permission AND tools are set to
    /// the optimal values (a missing role is created); the description and the prompt of an existing file stay as they are, and so
    /// does every other role. The write goes through `save`, so it needs the confirmation and keeps a backup of each file it replaces.
    /// (Named `preset_happy_tiering` before 2026-10-06; the old preset left the read-only roles without `Bash`.)
    pub fn preset_happy_tiering(&self, repos: &[RepoRef], confirm_write: bool) -> Result<Vec<Role>, RoleError> {
        let mut out = Vec::new();
        for p in HAPPY_TIERING {
            let existing = self.list(repos).into_iter().find(|r| r.scope == RoleScope::Global && r.name == p.name);
            let mut role = existing.clone().unwrap_or_else(|| Role {
                id: p.name.into(),
                name: p.name.into(),
                description: Some(p.description.into()),
                model: String::new(),
                effort_available: true,
                system_prompt: Some(p.prompt.into()),
                scope: RoleScope::Global,
                provider: "claude".into(),
                ..Role::default()
            });
            role.model = p.model.into();
            role.effort = Some(p.effort);
            role.permission = p.permission;
            role.tools = p.tools.iter().map(|t| t.to_string()).collect();
            role.tools_declared = true;
            let mut draft = RoleDraft::from(&role);
            draft.confirm_write = Some(confirm_write);
            out.push(self.save(draft, repos)?);
        }
        Ok(out)
    }

    /// Removes the overlay `permission` of these role ids so they derive it from their file again ("Use automatic").
    /// Nothing else of the entries changes.
    pub fn use_automatic(&self, ids: &[String]) -> Result<(), RoleError> {
        let _g = self.write.lock().unwrap_or_else(|e| e.into_inner());
        let mut all = self.overlay_for_write()?;
        for id in ids {
            if let Some(o) = all.get_mut(id) {
                o.permission = None;
            }
        }
        self.store_overlay(all)
    }

    /// Repairs a corrupt `roles-overlay.json`: the bytes stay in a `.bak` copy, the overlay starts empty.
    pub fn reset_overlay(&self) -> Result<(), RoleError> {
        let _g = self.write.lock().unwrap_or_else(|e| e.into_inner());
        self.overlay.reset().map_err(|e| rerr("io", format!("cannot reset the role settings: {e}")))
    }
}

/// The key of the overlay entry that holds `hidden`, `pin` and `approvedHashes` of a group: the entry whose key equals
/// the name (case-insensitively), or the name itself when there is none yet.
pub(crate) fn group_key(overlay: &BTreeMap<String, Overlay>, name: &str) -> String {
    overlay.keys().find(|k| !k.contains('@') && !k.contains('#') && k.eq_ignore_ascii_case(name)).cloned().unwrap_or_else(|| name.to_string())
}

pub(crate) fn role_permission(p: PermissionMode) -> RolePermission {
    match p {
        PermissionMode::ReadOnly => RolePermission::ReadOnly,
        PermissionMode::Edit => RolePermission::Edit,
        // a role never carries an unattended mode (the run mode is the request's); fail closed to Ask
        PermissionMode::Ask | PermissionMode::Automatic | PermissionMode::Bypass => RolePermission::Ask,
    }
}

pub(crate) fn role_effort_of(e: Effort) -> RoleEffort {
    match e {
        Effort::Low => RoleEffort::Low,
        Effort::Medium => RoleEffort::Medium,
        Effort::High => RoleEffort::High,
        Effort::Xhigh => RoleEffort::Xhigh,
        Effort::Max => RoleEffort::Max,
    }
}

fn sorted(v: &[String]) -> Vec<&String> {
    let mut v: Vec<&String> = v.iter().collect();
    v.sort();
    v
}

/// The editor fields in which two copies differ (`RoleDrift.fields`), `a` against `b`.
pub(crate) fn diff_fields(a: &Role, b: &Role) -> Vec<String> {
    let mut fields = Vec::new();
    let mut check = |name: &str, differs: bool| {
        if differs {
            fields.push(name.to_string());
        }
    };
    check("description", a.description != b.description);
    check("model", a.model.trim() != b.model.trim());
    check("effort", a.effort != b.effort);
    check("tools", sorted(&a.tools) != sorted(&b.tools));
    check("systemPrompt", a.system_prompt.as_deref().map(str::trim) != b.system_prompt.as_deref().map(str::trim));
    check("color", a.color != b.color);
    check("memory", a.memory != b.memory);
    check("disallowedTools", sorted(&a.disallowed_tools) != sorted(&b.disallowed_tools));
    check("maxTurns", a.max_turns != b.max_turns);
    fields
}

/// sha256 over the normalised effective fields of a file: two files that say the same are "identical" although
/// comments or the order of tools differ. Overlay values are not part of it.
fn content_hash(doc: &Document, model: &str, effort: Option<RoleEffort>) -> String {
    let tools = doc.list_declared("tools").map(|l| {
        let mut t: Vec<String> = l.items;
        t.sort();
        t
    });
    let mut disallowed = doc.disallowed_tools();
    disallowed.sort();
    let fields = (doc.get("description"), model.trim(), effort.map(effort_str), tools, disallowed, doc.max_turns(), doc.prompt().trim(), doc.get("color"), doc.get("memory"), doc.permission_mode());
    let json = serde_json::to_string(&fields).unwrap_or_default();
    Sha256::digest(json.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

struct Tier {
    name: &'static str,
    model: &'static str,
    effort: RoleEffort,
    permission: RolePermission,
    description: &'static str,
    tools: &'static [&'static str],
    prompt: &'static str,
}

/// The tools of the optimal settings. Read-only roles read, search, look things up on the web and run read-only commands (the broker
/// refuses a write through `Bash` with a reason the model can act on); a role without `Bash` could not run `git diff` or `ls` and handed
/// back nothing. Work roles get the whole editing set. Nothing here reaches outside the working tree.
const READ: &[&str] = &["Read", "Grep", "Glob", "Bash", "WebSearch", "WebFetch"];
const WORK: &[&str] = &["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit", "Bash", "WebSearch", "WebFetch"];

/// The optimal role set (the owner's model tiering, tools that never end in a tool error): cheap models read and write prose, Sonnet
/// implements and reviews, Opus plans and coordinates. Effort `max` is never part of it. (Named `HAPPY_TIERING` before 2026-10-06.)
const HAPPY_TIERING: &[Tier] = &[
    Tier { name: "researcher", model: "haiku", effort: RoleEffort::Low, permission: RolePermission::ReadOnly, description: "Read-only lookup and multi-file search; answers in 15 lines or less.", tools: READ, prompt: "Find the answer in the code and report it briefly, with file paths. You cannot modify anything." },
    Tier { name: "docs-writer", model: "haiku", effort: RoleEffort::Low, permission: RolePermission::Edit, description: "All prose: commit and PR text, docs, JSDoc, i18n strings, renames.", tools: WORK, prompt: "Write or fix the prose that was asked for. Keep changes to text; do not change behaviour." },
    Tier { name: "developer", model: "sonnet", effort: RoleEffort::Medium, permission: RolePermission::Edit, description: "Default for coding, tests and debugging.", tools: WORK, prompt: "Make the requested change with small, focused edits and report what you changed." },
    Tier { name: "reviewer", model: "sonnet", effort: RoleEffort::High, permission: RolePermission::ReadOnly, description: "Reviews non-trivial changes; read-only.", tools: READ, prompt: "Review the uncommitted changes for correctness and report findings by severity." },
    Tier { name: "architect", model: "opus", effort: RoleEffort::High, permission: RolePermission::ReadOnly, description: "Interfaces, protocols, security and concurrency reasoning; on request or after the developer failed twice.", tools: READ, prompt: "Design the solution and say what each change must do and why. Do not implement." },
    Tier { name: "manager", model: "opus", effort: RoleEffort::High, permission: RolePermission::ReadOnly, description: "Plans work across three or more independent subtasks or several repos; never implements.", tools: READ, prompt: "Split the work into independent tasks with owners and an order. Do not implement." },
    Tier { name: "worker", model: "opus", effort: RoleEffort::High, permission: RolePermission::Edit, description: "Carries out one well-scoped task of a manager's plan.", tools: WORK, prompt: "Do exactly the task you were given, verify it, and report what changed." },
];

fn scan(dir: &Path, repo: Option<&RepoRef>, overlay: &BTreeMap<String, Overlay>, skipped: &mut Vec<SkippedAgentsDir>) -> Vec<Role> {
    let repo_id = repo.map(|r| r.id.as_str());
    if let Some(repo) = repo {
        // A repository is untrusted input: a symlinked `.claude/agents` (or one that leads outside the repository)
        // would make files elsewhere look like this repository's roles.
        match std::fs::symlink_metadata(dir) {
            Ok(m) if m.file_type().is_symlink() => {
                skipped.push(SkippedAgentsDir { repo_id: repo.id.clone(), path: dir.to_string_lossy().into_owned(), code: "agentsDirSymlink".into(), target: dir.canonicalize().ok().map(|t| t.to_string_lossy().into_owned()) });
                return Vec::new();
            }
            Ok(_) => {}
            Err(_) => return Vec::new(),
        }
        let inside = matches!((dir.canonicalize(), repo.path.canonicalize()), (Ok(d), Ok(r)) if d.starts_with(&r));
        if !inside {
            skipped.push(SkippedAgentsDir { repo_id: repo.id.clone(), path: dir.to_string_lossy().into_owned(), code: "agentsDirSymlink".into(), target: dir.canonicalize().ok().map(|t| t.to_string_lossy().into_owned()) });
            return Vec::new();
        }
    }
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    // `symlink_metadata`: a symlinked role file is skipped (it could point anywhere)
    let mut files: Vec<PathBuf> = read
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "md") && std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_file() && m.len() <= MAX_ROLE_FILE))
        .collect();
    files.sort();
    let mut roles: Vec<Role> = Vec::new();
    for path in files {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let doc = Document::parse(&text);
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let name = doc.get("name").or_else(|| Some(stem.clone())).unwrap_or_default();
        if !valid_name(&name) {
            continue;
        }
        let first = roles.iter().position(|r| !r.shadowed_by_duplicate && r.name.eq_ignore_ascii_case(&name));
        let duplicate = first.is_some();
        if let Some(i) = first {
            if !roles[i].warnings.iter().any(|w| w == "duplicateName") {
                roles[i].warnings.push("duplicateName".into());
            }
        }
        let base_id = role_id(&name, repo_id);
        let id = if duplicate { format!("{base_id}#{stem}") } else { base_id };
        let o = if duplicate { Overlay::default() } else { overlay.get(&id).cloned().unwrap_or_default() };
        let provider = o.provider.clone().unwrap_or_else(|| "claude".into());
        let model = doc.get("model").unwrap_or_else(|| "inherit".into());
        let effort = doc.get("effort").and_then(|e| parse_effort(&e));
        let available = effort_available(&provider, &model);
        let derived = derive_permission(&doc, o.permission, repo.is_some());
        let mut warnings = Vec::new();
        match effort {
            Some(RoleEffort::Xhigh) => warnings.push("effortXhigh".into()),
            Some(RoleEffort::Max) => warnings.push("effortMax".into()),
            _ => {}
        }
        if effort.is_some() && !available {
            warnings.push("effortNotSent".into());
        }
        warnings.extend(derived.warnings.iter().cloned());
        if is_reserved(&name) {
            warnings.push("reserved".into());
        }
        if doc.get("memory").is_some() {
            warnings.push("memoryIgnored".into());
        }
        if duplicate {
            warnings.push("duplicateName".into());
        }
        roles.push(Role {
            id,
            name,
            description: doc.get("description"),
            effort,
            effort_available: available,
            tools: doc.get_list("tools"),
            system_prompt: Some(doc.prompt().to_string()).filter(|p| !p.is_empty()),
            color: doc.get("color"),
            memory: doc.get("memory"),
            scope: if repo.is_some() { RoleScope::Repo } else { RoleScope::Global },
            repo_id: repo_id.map(str::to_string),
            path: path.to_string_lossy().into_owned(),
            permission: derived.permission,
            provider,
            repo_scope: o.repo_scope,
            remote_startable: o.remote_startable,
            warnings,
            permission_source: derived.source,
            permission_reason: Some(derived.reason),
            disallowed_tools: doc.disallowed_tools(),
            max_turns: doc.max_turns(),
            content_hash: content_hash(&doc, &model, effort),
            builtin: false,
            can_edit: derived.can_edit,
            can_run: derived.can_run,
            trust: if repo.is_some() { RoleTrust::Untrusted } else { RoleTrust::Trusted },
            shadowed_by_duplicate: duplicate,
            tools_declared: doc.list_declared("tools").is_some(),
            model,
        });
    }
    roles
}

/// What the Claude provider offers a role. `max` effort is not offered (see `save`).
pub fn claude_caps() -> RoleProviderCaps {
    use RoleEffort::{High, Low, Medium, Xhigh};
    let model = |id: &str, label: &str, effort_levels: Vec<RoleEffort>| ModelCaps { id: id.into(), label: label.into(), effort_levels };
    RoleProviderCaps {
        provider: "claude".into(),
        label: "Claude (Agent SDK)".into(),
        models: vec![model(MODEL_HAIKU, "Haiku 4.5", vec![]), model(MODEL_SONNET, "Sonnet 5.5", vec![Low, Medium, High]), model(MODEL_OPUS, "Opus 5.5", vec![Low, Medium, High, Xhigh])],
        permission_modes: vec![RolePermission::ReadOnly, RolePermission::Edit, RolePermission::Ask],
        tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "WebFetch", "Task"].map(String::from).to_vec(),
    }
}
