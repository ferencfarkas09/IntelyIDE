//! Repository identity across workspaces: id reuse, duplicate detection and the effective protection of a repo
//! ((design notes: workspaces-spec) 4.12, invariant I7). Identity is the canonical path folded to NFC lower case, or the
//! `(dev, ino)` of the folder; a linked worktree also matches through its main repository.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::fs::{path_key, IdentityCache};
use super::model::{self, NewRepo, FLOOR_PROTECTED};
use super::{Registry, RegistryFile};
use crate::types::code;
use crate::{EngineError, Protection, RepoConfig, Workspace, WorkspaceEntry};

const IDENTITY_TIMEOUT: Duration = Duration::from_secs(1);

fn intersects(a: &[String], b: &[String]) -> bool {
    a.iter().any(|x| b.contains(x))
}

fn push_unique(into: &mut Vec<String>, items: impl IntoIterator<Item = String>) {
    for i in items {
        if !into.contains(&i) {
            into.push(i);
        }
    }
}

impl Registry {
    /// Every registered workspace file that can be read (damaged ones are skipped), in registry order.
    pub(super) fn all_workspaces(&self, file: &RegistryFile) -> Vec<(String, Workspace)> {
        file.sorted().into_iter().filter_map(|e| self.load_workspace(&e.entry.id).ok().map(|w| (e.entry.id.clone(), w))).collect()
    }

    fn workspaces_for_protection(&self) -> Vec<(String, Workspace)> {
        if let Some(p) = &self.loc.pinned {
            return crate::workspace::load_existing(p).ok().map(|w| vec![("pinned".to_owned(), w)]).unwrap_or_default();
        }
        match self.read_file() {
            Ok(Some(f)) => self.all_workspaces(&f),
            _ => Vec::new(),
        }
    }

    /// The main working tree of a linked worktree (`.git` file pointing into `<main>/.git/worktrees/<name>`).
    fn main_repo_of(&self, path: &Path) -> Option<PathBuf> {
        let p = path.to_path_buf();
        self.prober
            .run(&super::fs::mount_key(path), IDENTITY_TIMEOUT, move |fs| {
                let dot_git = p.join(".git");
                let text = String::from_utf8(fs.read_small(&dot_git, 4096).ok()?).ok()?;
                let target = text.lines().next()?.strip_prefix("gitdir:")?.trim().to_owned();
                let gitdir = if Path::new(&target).is_absolute() { PathBuf::from(&target) } else { p.join(&target) };
                if !gitdir.to_string_lossy().contains("/worktrees/") {
                    return None;
                }
                let common_rel = String::from_utf8(fs.read_small(&gitdir.join("commondir"), 4096).ok()?).ok()?;
                let common = fs.canonicalize(&gitdir.join(common_rel.trim())).ok()?;
                (common.file_name()? == ".git").then(|| common.parent().map(Path::to_path_buf)).flatten()
            })
            .ok()
            .flatten()
    }

    fn keys_with_main(&self, cache: &mut IdentityCache, path: &str) -> (Vec<String>, Vec<String>) {
        let keys = cache.keys(&self.prober, path, IDENTITY_TIMEOUT);
        let main = self.main_repo_of(Path::new(path)).map(|m| cache.keys(&self.prober, &m.to_string_lossy(), IDENTITY_TIMEOUT)).unwrap_or_default();
        (keys, main)
    }

    /// Builds the `RepoConfig`s for `repos` to be added to `existing` (which may be unsaved): an identity that already
    /// exists in any workspace file reuses that repo's id (shared per-repo prefs, live marks), otherwise a new
    /// identity-derived id is made. Refuses an identity already in `existing` or twice in the batch
    /// (`alreadyInWorkspace`). Reads the registry itself; call it without holding the registry lock.
    pub fn build_repo_configs(&self, existing: &Workspace, repos: &[NewRepo]) -> Result<Vec<RepoConfig>, EngineError> {
        let all = match self.read_file() {
            Ok(Some(f)) => self.all_workspaces(&f),
            _ => Vec::new(),
        };
        self.build_repos(existing, repos, &all)
    }

    pub(super) fn build_repos(&self, existing: &Workspace, repos: &[NewRepo], all: &[(String, Workspace)]) -> Result<Vec<RepoConfig>, EngineError> {
        let mut cache = IdentityCache::default();
        let mut known: Vec<(String, Vec<String>)> = Vec::new();
        for (_, ws) in all {
            for r in &ws.repos {
                known.push((r.id.clone(), cache.keys(&self.prober, &r.path, IDENTITY_TIMEOUT)));
            }
        }
        let mut taken: HashSet<String> = known.iter().map(|(id, _)| id.clone()).collect();
        let mut used_here: HashSet<String> = existing.repos.iter().map(|r| r.id.clone()).collect();
        taken.extend(used_here.iter().cloned());
        let mut target_keys: Vec<Vec<String>> = existing.repos.iter().map(|r| cache.keys(&self.prober, &r.path, IDENTITY_TIMEOUT)).collect();
        let mut colors: Vec<String> = existing.repos.iter().map(|r| r.color.clone()).collect();
        let mut out = Vec::new();
        let base_order = existing.repos.len();
        if base_order + repos.len() > model::MAX_REPOS {
            return Err(EngineError::new(code::LIMIT_REACHED, "a workspace holds at most 100 repositories"));
        }
        for (i, new) in repos.iter().enumerate() {
            let v = &new.repo;
            if !Path::new(&v.canonical_path).is_absolute() {
                return Err(EngineError::new(code::PATH_NOT_VALIDATED, "the repository path must be absolute"));
            }
            let mut q = vec![format!("p:{}", path_key(&v.canonical_path))];
            if !v.identity.is_empty() {
                q.push(format!("i:{}", v.identity));
            }
            if target_keys.iter().any(|ks| intersects(ks, &q)) {
                return Err(EngineError::new(code::ALREADY_IN_WORKSPACE, "this folder is already in the workspace").with_detail(v.canonical_path.clone()));
            }
            let main_keys = v.main.as_deref().map(|m| cache.keys(&self.prober, m, IDENTITY_TIMEOUT)).unwrap_or_default();
            let reuse = known
                .iter()
                .find(|(id, ks)| intersects(ks, &q) && !used_here.contains(id))
                .or_else(|| known.iter().find(|(id, ks)| !main_keys.is_empty() && intersects(ks, &main_keys) && !used_here.contains(id)))
                .map(|(id, _)| id.clone());

            let display = match &new.name {
                Some(n) => model::normalize_name(n)?,
                None => model::normalize_name(&v.suggested_name).unwrap_or_else(|_| "repo".to_owned()),
            };
            let id = reuse.unwrap_or_else(|| model::new_repo_id(&display, &v.canonical_path, &taken));
            let badge = match &new.badge {
                Some(b) => {
                    let n = b.chars().count();
                    if !(1..=2).contains(&n) || b.chars().any(|c| c.is_control()) {
                        return Err(EngineError::new(crate::workspace::INVALID_WORKSPACE, "a badge has 1 or 2 characters"));
                    }
                    b.clone()
                }
                None => model::badge_for(&display),
            };
            let color = match &new.color {
                Some(c) => {
                    model::check_color(c)?;
                    c.to_lowercase()
                }
                None => model::next_color(&colors),
            };
            taken.insert(id.clone());
            used_here.insert(id.clone());
            colors.push(color.clone());
            target_keys.push(q);
            out.push(RepoConfig {
                id,
                path: v.canonical_path.clone(),
                name: display,
                color,
                badge,
                order: (base_order + i) as u32,
                push_targets: Default::default(),
            });
        }
        Ok(out)
    }

    /// `protectedBranches` of a new workspace: the global floor plus the custom patterns of every workspace (and of the
    /// live floor) that already contains one of the repos.
    pub(super) fn protected_for_new(&self, _ws: &Workspace, repos: &[NewRepo], all: &[(String, Workspace)]) -> Vec<String> {
        let mut out: Vec<String> = FLOOR_PROTECTED.iter().map(|s| (*s).to_owned()).collect();
        let mut cache = IdentityCache::default();
        let floor = self.read_floor().unwrap_or_default();
        for new in repos {
            let mut q = vec![format!("p:{}", path_key(&new.repo.canonical_path))];
            if !new.repo.identity.is_empty() {
                q.push(format!("i:{}", new.repo.identity));
            }
            for (_, ws) in all {
                if ws.repos.iter().any(|r| intersects(&cache.keys(&self.prober, &r.path, IDENTITY_TIMEOUT), &q)) {
                    push_unique(&mut out, ws.protected_branches.iter().cloned());
                }
            }
            for e in floor.matching(&q) {
                push_unique(&mut out, e.protected.iter().cloned());
            }
        }
        out
    }

    /// Protection of one repository, whatever workspace it is pushed from (I7): the global floor, the protected
    /// patterns of every workspace file that contains the same repository (same identity, or the same main
    /// repository for linked worktrees), the live marks of every such repo entry and the live floor of removed
    /// workspaces. Computed at push time; never fails (an unreadable file simply contributes nothing).
    pub fn effective_protection(&self, repo_path: &Path) -> Protection {
        let mut cache = IdentityCache::default();
        let (q_keys, q_main) = self.keys_with_main(&mut cache, &repo_path.to_string_lossy());
        let mut out = Protection { protected: FLOOR_PROTECTED.iter().map(|s| (*s).to_owned()).collect(), live: Vec::new() };
        for (_, ws) in self.workspaces_for_protection() {
            for r in &ws.repos {
                let (keys, main) = self.keys_with_main(&mut cache, &r.path);
                let same = intersects(&keys, &q_keys)
                    || (!q_main.is_empty() && (intersects(&keys, &q_main) || intersects(&main, &q_main)))
                    || (!main.is_empty() && intersects(&main, &q_keys));
                if same {
                    push_unique(&mut out.protected, ws.protected_branches.iter().cloned());
                    push_unique(&mut out.live, ws.live_branches.get(&r.id).cloned().unwrap_or_default());
                }
            }
        }
        if self.loc.pinned.is_none() {
            let floor = self.read_floor().unwrap_or_default();
            let mut all_keys = q_keys.clone();
            all_keys.extend(q_main.iter().cloned());
            for e in floor.matching(&all_keys) {
                push_unique(&mut out.protected, e.protected.iter().cloned());
                push_unique(&mut out.live, e.live.iter().cloned());
            }
        }
        out
    }

    /// An existing workspace whose repositories are exactly the folders with these identities (`"{dev}:{ino}"`).
    pub fn find_by_identity(&self, identities: &[String]) -> Option<WorkspaceEntry> {
        if identities.is_empty() || self.loc.pinned.is_some() {
            return None;
        }
        let want: HashSet<&str> = identities.iter().map(String::as_str).collect();
        let file = self.read_file().ok().flatten()?;
        for e in file.sorted() {
            let Ok(ws) = self.load_workspace(&e.entry.id) else { continue };
            if ws.repos.len() != want.len() {
                continue;
            }
            let ids: HashSet<String> = ws.repos.iter().filter_map(|r| self.prober.identity(Path::new(&r.path), IDENTITY_TIMEOUT)).collect();
            if ids.len() == want.len() && ids.iter().all(|i| want.contains(i.as_str())) {
                return Some(e.entry.clone());
            }
        }
        None
    }
}
