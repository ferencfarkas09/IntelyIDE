//! Workspace file handling (contract sections 1 and 3).

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use crate::registry::{fs::path_key, fsutil, model};
use crate::{code, EngineError, MessageMode, RepoConfig, Workspace, WorkspaceSettings};

/// The workspace failed validation (not part of `types::code`).
pub const INVALID_WORKSPACE: &str = "invalidWorkspace";

const DEFAULT_PROTECTED: [&str; 4] = ["main", "master", "production", "release/*"];

/// `INTELY_WORKSPACE` if set, else `~/Library/Application Support/IntelySwitchIDE/workspace.json`.
pub fn resolve_path() -> PathBuf {
    if let Some(p) = std::env::var_os("INTELY_WORKSPACE") {
        return PathBuf::from(p);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join("Library/Application Support/IntelySwitchIDE/workspace.json")
}

/// The directory that holds all IDE state (registry, workspace files, backups, side stores): the parent of the
/// legacy `workspace.json`, `INTELY_WORKSPACES`' directory under an active jail, or the directory of `INTELY_WORKSPACE`.
/// Everything that needs "the state directory" (graph bundles, the agent path policy) must use this function.
pub fn state_dir() -> PathBuf {
    crate::registry::Location::resolve().dir
}

/// A workspace with no repositories and the generic defaults (protected branches, shared commit messages).
pub fn empty() -> Workspace {
    Workspace {
        version: 1,
        repos: Vec::new(),
        protected_branches: DEFAULT_PROTECTED.iter().map(|b| (*b).to_owned()).collect(),
        live_branches: BTreeMap::new(),
        settings: WorkspaceSettings { message_mode: MessageMode::Shared, untracked_checked: false },
    }
}

/// Reads the workspace file. A missing file is an empty workspace in memory (nothing is written, nothing is
/// seeded: no repository list lives in code). A corrupt file is reported, never overwritten.
pub fn load(path: &Path) -> Result<Workspace, EngineError> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty()),
        Err(e) => return Err(e.into()),
    };
    let ws: Workspace = serde_json::from_slice(&bytes).map_err(|e| {
        EngineError::new(INVALID_WORKSPACE, "the workspace file is not valid").with_detail(format!("{}: {e}", path.display()))
    })?;
    if ws.version != 1 {
        return Err(EngineError::new(
            INVALID_WORKSPACE,
            format!("unsupported workspace version {}", ws.version),
        ));
    }
    Ok(ws)
}

/// Reads an existing workspace file: a missing file is `workspaceFileMissing`, a damaged one `invalidWorkspace`; the
/// structure is validated, repo paths are not (a switch must not stat user folders). Never seeds, never writes.
pub fn load_existing(path: &Path) -> Result<Workspace, EngineError> {
    let bytes = match fsutil::read_capped(path, 4 * 1024 * 1024) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(EngineError::new(code::WORKSPACE_FILE_MISSING, "the workspace file is missing").with_detail(path.display().to_string()))
        }
        Err(e) => return Err(EngineError::new(code::IO, e.to_string()).with_detail(path.display().to_string())),
    };
    let ws: Workspace = serde_json::from_slice(&bytes)
        .map_err(|e| EngineError::new(INVALID_WORKSPACE, "the workspace file is not valid").with_detail(format!("{}: {e}", path.display())))?;
    validate_structure(&ws)?;
    Ok(ws)
}

/// Options of a workspace-file save.
#[derive(Debug, Clone, Default)]
pub struct SaveOptions {
    /// Where the previous version of the file is copied to (`ws-<id>.<unixms>.json`, newest 5 kept) before a
    /// structural save. `None` for pinned and legacy files: no backup, as before.
    pub backup_dir: Option<PathBuf>,
}

fn backup_before(path: &Path, opts: &SaveOptions) {
    let Some(dir) = &opts.backup_dir else { return };
    if !path.exists() {
        return;
    }
    let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else { return };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let _ = fsutil::rotate_backup(path, dir, &format!("ws-{stem}."), None, 5, 0, now);
}

/// Validates that every repo path is a git work tree, then writes atomically.
pub async fn save(path: &Path, ws: &Workspace) -> Result<Workspace, EngineError> {
    save_to(path, ws, &SaveOptions::default()).await
}

/// [`save`] with a backup of the previous file when `opts.backup_dir` is set.
pub async fn save_to(path: &Path, ws: &Workspace, opts: &SaveOptions) -> Result<Workspace, EngineError> {
    validate_structure(ws)?;
    ws.repos.iter().try_for_each(check_work_tree)?;
    backup_before(path, opts);
    write_atomic(path, ws)?;
    Ok(ws.clone())
}

/// For edits of an already accepted workspace (push targets): a repo that is temporarily unmounted must not block them.
pub fn persist(path: &Path, ws: &Workspace) -> Result<(), EngineError> {
    validate_structure(ws)?;
    write_atomic(path, ws)
}

fn invalid(message: impl Into<String>) -> EngineError {
    EngineError::new(INVALID_WORKSPACE, message)
}

/// Structural validation of a workspace (no filesystem access): version, patterns, unique ids and folders, names,
/// colours, badges and push targets.
pub fn validate_structure(ws: &Workspace) -> Result<(), EngineError> {
    if ws.version != 1 {
        return Err(invalid(format!("unsupported workspace version {}", ws.version)));
    }
    if ws.protected_branches.iter().any(|b| b.trim().is_empty()) {
        return Err(invalid("protected branch patterns must not be empty"));
    }
    if ws.live_branches.values().flatten().any(|b| b.trim().is_empty()) {
        return Err(invalid("live branch patterns must not be empty"));
    }
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    for repo in &ws.repos {
        if repo.id.is_empty() || !ids.insert(repo.id.as_str()) {
            return Err(invalid(format!("repo id '{}' is empty or duplicated", repo.id)));
        }
        if repo.name.trim().is_empty() || repo.name.chars().count() > model::MAX_NAME_CHARS || model::has_invisible(&repo.name) {
            return Err(invalid(format!("repo '{}': the name must be 1 to 60 visible characters", repo.id)));
        }
        if model::has_invisible(&repo.badge) {
            return Err(invalid(format!("repo '{}': the badge has invisible characters", repo.id)));
        }
        if !paths.insert(path_key(&repo.path)) {
            return Err(EngineError::new(code::ALREADY_IN_WORKSPACE, format!("{} appears twice in the workspace", repo.path)));
        }
        let hex = repo.color.strip_prefix('#').filter(|h| h.len() == 6 && h.bytes().all(|b| b.is_ascii_hexdigit()));
        if hex.is_none() {
            return Err(invalid(format!("repo '{}': color must be #rrggbb", repo.id)));
        }
        if !(1..=2).contains(&repo.badge.chars().count()) {
            return Err(invalid(format!("repo '{}': badge must be 1-2 characters", repo.id)));
        }
        for (local, target) in &repo.push_targets {
            if local.is_empty() || target.remote.is_empty() || target.branch.is_empty() {
                return Err(invalid(format!("repo '{}': incomplete push target for '{local}'", repo.id)));
            }
        }
    }
    Ok(())
}

/// A work tree root has `.git` as a directory with a `HEAD`, or as a `gitdir:` file (linked worktrees, submodules).
fn check_work_tree(repo: &RepoConfig) -> Result<(), EngineError> {
    let root = Path::new(&repo.path);
    if !root.is_absolute() {
        return Err(invalid(format!("repo '{}': the path must be absolute", repo.id)));
    }
    if !root.is_dir() {
        return Err(EngineError::new(code::REPO_MISSING, format!("{} does not exist", repo.path)));
    }
    let dot_git = root.join(".git");
    let is_work_tree = if dot_git.is_dir() {
        dot_git.join("HEAD").is_file()
    } else {
        std::fs::read_to_string(&dot_git).is_ok_and(|s| s.starts_with("gitdir:"))
    };
    if is_work_tree {
        Ok(())
    } else {
        Err(EngineError::new(code::NOT_A_REPO, format!("{} is not the root of a git work tree", repo.path)))
    }
}

/// Temp file in the same directory, fsync, rename, fsync of the directory (0600).
fn write_atomic(path: &Path, ws: &Workspace) -> Result<(), EngineError> {
    let mut json = serde_json::to_vec_pretty(ws).map_err(|e| EngineError::new(code::IO, e.to_string()))?;
    json.push(b'\n');
    fsutil::write_atomic(path, &json, 0o600, None)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;
    use crate::PushTargetMapping;

    fn fake_repo(dir: &Path, name: &str) -> String {
        let root = dir.join(name);
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        root.to_string_lossy().into_owned()
    }

    fn repo(order: u32, id: &str, path: &str, color: &str, badge: &str) -> RepoConfig {
        RepoConfig { id: id.to_owned(), path: path.to_owned(), name: id.to_owned(), color: color.to_owned(), badge: badge.to_owned(), order, push_targets: BTreeMap::new() }
    }

    /// Four fixture repos, the shape the old seed had, with made-up paths.
    fn sample() -> Workspace {
        let mut ws = empty();
        ws.repos = vec![
            repo(0, "backend", "/fixture/backend", "#4caf7d", "BE"),
            repo(1, "admin", "/fixture/admin", "#8b6cf0", "AD"),
            repo(2, "services", "/fixture/services", "#f0a23a", "SV"),
            repo(3, "pos", "/fixture/pos", "#3b9ae8", "PO"),
        ];
        ws
    }

    fn one_repo_workspace(path: String) -> Workspace {
        let mut ws = sample();
        ws.repos.truncate(1);
        ws.repos[0].path = path;
        ws
    }

    #[test]
    fn an_empty_workspace_has_only_the_generic_defaults() {
        let ws = empty();
        assert!(ws.repos.is_empty() && ws.live_branches.is_empty());
        assert_eq!(ws.protected_branches, vec!["main", "master", "production", "release/*"]);
        assert_eq!(ws.settings.message_mode, MessageMode::Shared);
        assert!(!ws.settings.untracked_checked);
    }

    #[test]
    fn a_missing_file_loads_as_an_empty_workspace_and_writes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("nested/dir/workspace.json");
        assert_eq!(load(&file).unwrap(), empty());
        assert!(!file.exists() && !tmp.path().join("nested").exists());
        assert_eq!(load_existing(&file).unwrap_err().code, code::WORKSPACE_FILE_MISSING);
    }

    #[test]
    fn load_existing_validates_structure_but_not_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("w.json");
        let ws = sample();
        std::fs::write(&file, serde_json::to_vec(&ws).unwrap()).unwrap();
        assert_eq!(load_existing(&file).unwrap(), ws, "paths that do not exist are fine");
        let mut bad = ws.clone();
        bad.repos[1].color = "green".into();
        std::fs::write(&file, serde_json::to_vec(&bad).unwrap()).unwrap();
        assert_eq!(load_existing(&file).unwrap_err().code, INVALID_WORKSPACE);
        std::fs::write(&file, "{ not json").unwrap();
        assert_eq!(load_existing(&file).unwrap_err().code, INVALID_WORKSPACE);
    }

    #[test]
    fn structure_rejects_duplicate_folders_and_invisible_names() {
        let mut ws = sample();
        ws.repos[1].path = "/Fixture/Backend".into(); // same folder, other case
        assert_eq!(validate_structure(&ws).unwrap_err().code, code::ALREADY_IN_WORKSPACE);
        let mut ws = sample();
        ws.repos[0].name = "evil\u{202E}name".into();
        assert_eq!(validate_structure(&ws).unwrap_err().code, INVALID_WORKSPACE);
        ws.repos[0].name = "x".repeat(61);
        assert_eq!(validate_structure(&ws).unwrap_err().code, INVALID_WORKSPACE);
    }

    #[tokio::test]
    async fn save_to_backs_the_previous_file_up_and_keeps_five() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("wa1.json");
        let backups = tmp.path().join("backups");
        let repo_dir = fake_repo(tmp.path(), "repo");
        let opts = SaveOptions { backup_dir: Some(backups.clone()) };
        let mut ws = one_repo_workspace(repo_dir);
        save_to(&file, &ws, &opts).await.unwrap();
        assert!(!backups.exists(), "nothing to back up on the first save");
        for i in 0..8 {
            ws.protected_branches.push(format!("p{i}"));
            save_to(&file, &ws, &opts).await.unwrap();
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        let n = std::fs::read_dir(&backups).unwrap().count();
        assert_eq!(n, 5);
        assert_eq!(load(&file).unwrap(), ws);
    }

    #[test]
    fn corrupt_file_is_reported_and_left_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("workspace.json");
        std::fs::write(&file, "{ not json").unwrap();
        let err = load(&file).unwrap_err();
        assert_eq!(err.code, INVALID_WORKSPACE);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ not json");
    }

    #[test]
    fn live_branches_default_to_empty_and_reject_blank_patterns() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("workspace.json");
        let mut json = serde_json::to_value(sample()).unwrap();
        json.as_object_mut().unwrap().remove("liveBranches");
        std::fs::write(&file, json.to_string()).unwrap();
        assert!(load(&file).unwrap().live_branches.is_empty());

        let mut ws = sample();
        ws.live_branches.insert("admin".into(), vec![" ".into()]);
        assert_eq!(persist(&file, &ws).unwrap_err().code, INVALID_WORKSPACE);
    }

    #[tokio::test]
    async fn save_round_trips_and_leaves_no_temp_files() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("workspace.json");
        let mut ws = one_repo_workspace(fake_repo(tmp.path(), "repo"));
        ws.repos[0].push_targets.insert(
            "feature/x".into(),
            PushTargetMapping { remote: "origin".into(), branch: "other".into() },
        );
        assert_eq!(save(&file, &ws).await.unwrap(), ws);
        assert_eq!(load(&file).unwrap(), ws);
        let mut names: Vec<_> =
            std::fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, vec!["repo", "workspace.json"]);
    }

    #[tokio::test]
    async fn save_rejects_paths_that_are_not_work_trees() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("workspace.json");
        let plain = tmp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let empty_git = tmp.path().join("empty-git");
        std::fs::create_dir_all(empty_git.join(".git")).unwrap();

        for (path, expected) in [
            (plain.to_string_lossy().into_owned(), code::NOT_A_REPO),
            (empty_git.to_string_lossy().into_owned(), code::NOT_A_REPO),
            (tmp.path().join("missing").to_string_lossy().into_owned(), code::REPO_MISSING),
            ("relative/path".to_owned(), INVALID_WORKSPACE),
        ] {
            let err = save(&file, &one_repo_workspace(path.clone())).await.unwrap_err();
            assert_eq!(err.code, expected, "{path}");
        }
        assert!(!file.exists(), "a rejected save must not create the file");
    }

    #[tokio::test]
    async fn save_accepts_linked_worktrees_and_keeps_the_old_file_on_rejection() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("workspace.json");
        let linked = tmp.path().join("linked");
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::write(linked.join(".git"), "gitdir: /somewhere/.git/worktrees/linked\n").unwrap();
        let good = one_repo_workspace(linked.to_string_lossy().into_owned());
        save(&file, &good).await.unwrap();

        let mut bad = good.clone();
        bad.repos[0].color = "green".into();
        assert_eq!(save(&file, &bad).await.unwrap_err().code, INVALID_WORKSPACE);
        assert_eq!(load(&file).unwrap(), good);
    }

    #[tokio::test]
    async fn save_validates_ids_badges_and_targets() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("workspace.json");
        let base = one_repo_workspace(fake_repo(tmp.path(), "repo"));

        let mut dup = base.clone();
        dup.repos.push(dup.repos[0].clone());
        let mut badge = base.clone();
        badge.repos[0].badge = "ABC".into();
        let mut target = base.clone();
        target.repos[0]
            .push_targets
            .insert("a".into(), PushTargetMapping { remote: String::new(), branch: "b".into() });
        let mut version = base.clone();
        version.version = 2;
        for (name, ws) in [("dup", dup), ("badge", badge), ("target", target), ("version", version)] {
            assert_eq!(save(&file, &ws).await.unwrap_err().code, INVALID_WORKSPACE, "{name}");
        }
    }
}
