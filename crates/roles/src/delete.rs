//! Deleting role files ((design notes: roles-orchestration-spec) 3.4). A role file is user data in a place other tools read
//! (`~/.claude/agents`) or in a repository, so nothing is removed unless every check passed and every file has a
//! verified backup. The checks run in this order, all before anything is touched: the file exists (a built-in has none),
//! it is a regular `*.md` file directly inside an agents directory (symlink-proof), the jail allows the write, the exact
//! role name was typed, a symlinked global directory was confirmed a second time, and every file has a byte-compared
//! backup. Right before `remove_file` the file is examined again (same device and inode, same bytes as its backup).

use std::path::{Path, PathBuf};

use intely_agent_host::RepoRef;

use crate::store::{Overlay, RoleError, RoleStore};
use crate::types::{DeleteFile, DeletePreview, DeleteReport, DeletedFile, Role, RoleScope};

fn err(code: &'static str, message: impl Into<String>) -> RoleError {
    RoleError { code, message: message.into() }
}

/// What identifies a file on disk (so a swap between check and removal is noticed).
#[cfg(unix)]
fn identity(m: &std::fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (m.dev(), m.ino())
}

#[cfg(not(unix))]
fn identity(m: &std::fs::Metadata) -> (u64, u64) {
    (m.len(), m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as u64))
}

struct Target {
    role: Role,
    path: PathBuf,
    ident: (u64, u64),
    /// Canonical path of the file when the global agents directory is a symlink.
    link_target: Option<PathBuf>,
}

/// Called with the paths right after the checks and before the final re-check (tests swap a file here).
pub type RaceHook<'a> = &'a dyn Fn(&[PathBuf]);

impl RoleStore {
    /// Resolves the ids to files and runs the path checks (steps 1 and 2). Nothing is written.
    fn delete_plan(&self, ids: &[String], repos: &[RepoRef]) -> Result<(Vec<Target>, String), RoleError> {
        if ids.is_empty() {
            return Err(err("unknownRole", "no role was given"));
        }
        let snap = self.snapshot(repos);
        let global_link = std::fs::symlink_metadata(&self.global_dir).ok().filter(|m| m.file_type().is_symlink());
        let mut targets: Vec<Target> = Vec::new();
        for id in ids {
            if targets.iter().any(|t| t.role.id == *id) {
                continue;
            }
            let Some(role) = snap.roles.iter().find(|r| r.id == *id).cloned() else {
                let is_builtin = !id.contains('@') && !id.contains('#') && self.is_builtin(id) && !snap.roles.iter().any(|r| r.name.eq_ignore_ascii_case(id));
                return Err(if is_builtin { err("builtinNoFile", format!("{id} is a built-in role and has no file; hide it instead")) } else { err("unknownRole", format!("no role {id}")) });
            };
            let path = PathBuf::from(&role.path);
            let (dir, repo) = match (&role.scope, &role.repo_id) {
                (RoleScope::Global, _) => (self.global_dir.clone(), None),
                (RoleScope::Repo, Some(rid)) => {
                    let repo = repos.iter().find(|r| r.id == *rid).ok_or_else(|| err("outsideAgentsDir", format!("repository {rid} is not registered")))?;
                    (repo.path.join(".claude").join("agents"), Some(repo))
                }
                (RoleScope::Repo, None) => return Err(err("outsideAgentsDir", format!("{} has no repository", role.id))),
            };
            let name_ok = path.extension().is_some_and(|x| x == "md") && path.file_name().is_some();
            if path.parent() != Some(dir.as_path()) || !name_ok || path.components().any(|c| c.as_os_str() == ".git") {
                return Err(err("outsideAgentsDir", format!("{} is not a role file directly inside {}", path.display(), dir.display())));
            }
            let meta = std::fs::symlink_metadata(&path).map_err(|e| err("unknownRole", format!("{} cannot be examined: {e}", path.display())))?;
            if !meta.file_type().is_file() {
                return Err(err("outsideAgentsDir", format!("{} is not a regular file (a symlink or a directory)", path.display())));
            }
            if let Some(repo) = repo {
                let dir_meta = std::fs::symlink_metadata(&dir).map_err(|e| err("outsideAgentsDir", format!("{} cannot be examined: {e}", dir.display())))?;
                let inside = matches!((dir.canonicalize(), repo.path.canonicalize()), (Ok(d), Ok(r)) if d.starts_with(&r));
                if dir_meta.file_type().is_symlink() || !inside {
                    return Err(err("outsideAgentsDir", format!("{} is a symlink or leaves the repository {}", dir.display(), repo.id)));
                }
            }
            let link_target = if repo.is_none() && global_link.is_some() { path.canonicalize().ok() } else { None };
            targets.push(Target { ident: identity(&meta), role, path, link_target });
        }
        let first = &targets[0].role;
        if !targets.iter().all(|t| t.role.name.eq_ignore_ascii_case(&first.name)) {
            return Err(err("invalidRole", "the files to delete must all be copies of one role"));
        }
        // the group's name: the spelling of its first file
        let name = snap.roles.iter().find(|r| !r.shadowed_by_duplicate && r.name.eq_ignore_ascii_case(&first.name)).map_or_else(|| first.name.clone(), |r| r.name.clone());
        Ok((targets, name))
    }

    /// What the delete dialog shows before it asks for the typed name: paths, canonical symlink targets, the backup
    /// directory. Writes nothing and checks neither the jail nor the confirmation.
    pub fn delete_preview(&self, ids: &[String], repos: &[RepoRef]) -> Result<DeletePreview, RoleError> {
        let (targets, name) = self.delete_plan(ids, repos)?;
        let link_target = std::fs::symlink_metadata(&self.global_dir)
            .ok()
            .filter(|m| m.file_type().is_symlink() && targets.iter().any(|t| t.role.scope == RoleScope::Global))
            .and_then(|_| self.global_dir.canonicalize().ok())
            .map(|p| p.to_string_lossy().into_owned());
        let files = targets
            .iter()
            .map(|t| DeleteFile {
                id: t.role.id.clone(),
                path: t.path.to_string_lossy().into_owned(),
                scope: t.role.scope,
                repo_id: t.role.repo_id.clone(),
                symlink_target: t.link_target.as_ref().map(|p| p.to_string_lossy().into_owned()),
            })
            .collect();
        Ok(DeletePreview { name, files, backup_dir: self.backup_dir_path().map(|p| p.to_string_lossy().into_owned()), link_target })
    }

    /// Deletes the role files with these ids (all copies of ONE role). `typed` must equal the role name exactly (case
    /// sensitive); `typed_link` must equal the canonical target when `~/.claude/agents` is a symlink.
    pub fn delete(&self, ids: &[String], typed: &str, typed_link: Option<&str>, repos: &[RepoRef]) -> Result<DeleteReport, RoleError> {
        self.delete_with_hook(ids, typed, typed_link, repos, &|_| {})
    }

    /// [`Self::delete`] with a hook that runs between the checks and the final re-check (the race test swaps a file).
    #[doc(hidden)]
    pub fn delete_with_hook(&self, ids: &[String], typed: &str, typed_link: Option<&str>, repos: &[RepoRef], hook: RaceHook<'_>) -> Result<DeleteReport, RoleError> {
        let _g = self.write.lock().unwrap_or_else(|e| e.into_inner());
        let (targets, name) = self.delete_plan(ids, repos)?;
        // the overlay is edited afterwards (hidden/pin of a name that is gone): never over a broken one
        let _ = self.overlay_for_write()?;
        for t in &targets {
            self.check_write("role delete", &t.path)?;
        }
        if typed != name {
            return Err(err("confirmDelete", format!("type the role name {name} exactly to delete {}", targets.iter().map(|t| t.path.display().to_string()).collect::<Vec<_>>().join(", "))));
        }
        if let Some(link) = targets.iter().find_map(|t| t.link_target.as_ref()) {
            let dir_target = self.global_dir.canonicalize().unwrap_or_else(|_| link.clone());
            if typed_link != Some(dir_target.to_string_lossy().as_ref()) {
                return Err(err("confirmLink", format!("{} is a link to {}: type that path to confirm", self.global_dir.display(), dir_target.display())));
            }
        }
        // a verified backup of EVERY file first; one failure deletes nothing (and removes the backups made so far)
        let mut backups: Vec<PathBuf> = Vec::new();
        for t in &targets {
            match self.backup_required(&t.path, &t.role.id) {
                Ok(b) => backups.push(b),
                Err(e) => {
                    for b in &backups {
                        let _ = std::fs::remove_file(b);
                    }
                    return Err(e);
                }
            }
        }
        let paths: Vec<PathBuf> = targets.iter().map(|t| t.path.clone()).collect();
        hook(&paths);
        let recheck = |t: &Target, backup: &Path| -> Result<(), RoleError> {
            let meta = std::fs::symlink_metadata(&t.path).map_err(|e| err("io", format!("{} changed during the delete: {e}", t.path.display())))?;
            if !meta.file_type().is_file() {
                return Err(err("outsideAgentsDir", format!("{} is no longer a regular file; nothing was deleted", t.path.display())));
            }
            if identity(&meta) != t.ident {
                return Err(err("io", format!("{} was replaced during the delete; nothing was deleted", t.path.display())));
            }
            let (now, saved) = (std::fs::read(&t.path), std::fs::read(backup));
            if now.is_err() || now.ok() != saved.ok() {
                return Err(err("io", format!("{} changed after its backup was made; nothing was deleted", t.path.display())));
            }
            Ok(())
        };
        let failed = targets.iter().zip(&backups).find_map(|(t, b)| recheck(t, b).err());
        if let Some(e) = failed {
            for b in &backups {
                let _ = std::fs::remove_file(b);
            }
            return Err(e);
        }
        let mut deleted = Vec::new();
        for (t, b) in targets.iter().zip(&backups) {
            recheck(t, b)?;
            std::fs::remove_file(&t.path).map_err(|e| err("io", format!("cannot delete {}: {e}", t.path.display())))?;
            deleted.push(DeletedFile { id: t.role.id.clone(), path: t.path.to_string_lossy().into_owned() });
        }
        self.drop_group_settings(&name, repos);
        Ok(DeleteReport { deleted, backups: backups.iter().map(|b| b.to_string_lossy().into_owned()).collect() })
    }

    /// The per-file overlay entries stay (a restored file keeps its settings); `hidden`, `pin` and the approved hashes
    /// of a NAME go only when no copy and no built-in of that name remains. Best effort: the files are already gone.
    fn drop_group_settings(&self, name: &str, repos: &[RepoRef]) {
        let snap = self.snapshot(repos);
        if snap.roles.iter().any(|r| r.name.eq_ignore_ascii_case(name)) || self.is_builtin(name) {
            return;
        }
        let Ok(mut all) = self.overlay_for_write() else { return };
        let key = crate::store::group_key(&all, name);
        if let Some(o) = all.get_mut(&key) {
            *o = Overlay { hidden: false, pin: None, approved_hashes: Vec::new(), ..o.clone() };
            let _ = self.store_overlay(all);
        }
    }
}
