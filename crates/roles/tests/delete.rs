//! Deleting role files: every check before anything is touched, a verified backup of every file first, symlink-proof and
//! race-safe. Throwaway directories only.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use intely_agent_host::RepoRef;
use intely_core::jail::Jail;
use intely_roles::store::MemoryOverlay;
use intely_roles::RoleStore;

const ROLE: &str = "---\nname: researcher\ndescription: Reads\ntools: Read, Grep\n---\n\nFind.\n";

struct Rig {
    tmp: tempfile::TempDir,
    store: RoleStore,
    global: PathBuf,
    repos: Vec<RepoRef>,
}

fn write(dir: &Path, file: &str, text: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(file), text).unwrap();
}

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

impl Rig {
    fn new() -> Self {
        Self::with(|s| s)
    }

    fn with(f: impl FnOnce(RoleStore) -> RoleStore) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let global = tmp.path().join("home/.claude/agents");
        std::fs::create_dir_all(&global).unwrap();
        let repos: Vec<RepoRef> = ["r1", "r2"]
            .iter()
            .map(|id| {
                let path = tmp.path().join(id);
                std::fs::create_dir_all(path.join(".claude/agents")).unwrap();
                RepoRef { id: (*id).into(), path }
            })
            .collect();
        let store = f(RoleStore::new(global.clone(), Box::new(MemoryOverlay::default())).with_backup_dir(tmp.path().join("backups")).with_builtin_names(vec!["developer".into()]));
        Self { tmp, store, global, repos }
    }

    fn repo_dir(&self, i: usize) -> PathBuf {
        self.repos[i].path.join(".claude/agents")
    }

    fn delete(&self, which: &[&str], typed: &str) -> Result<intely_roles::types::DeleteReport, intely_roles::RoleError> {
        self.store.delete(&ids(which), typed, None, &self.repos)
    }
}

#[test]
fn a_delete_needs_the_exact_typed_name() {
    let r = Rig::new();
    write(&r.global, "researcher.md", ROLE);
    for typed in ["", "researche", "Researcher", "researcher ", "yes"] {
        assert_eq!(r.delete(&["researcher"], typed).unwrap_err().code, "confirmDelete", "{typed:?}");
    }
    assert!(r.global.join("researcher.md").exists());
    assert!(r.store.backups().is_empty(), "nothing was backed up either");
}

#[test]
fn it_deletes_after_a_backup_that_equals_the_file_and_touches_nothing_else() {
    let r = Rig::new();
    write(&r.global, "researcher.md", ROLE);
    write(&r.global, "keep.md", "---\nname: keep\n---\nx\n");
    write(&r.repo_dir(0), "researcher.md", ROLE);
    write(&r.repo_dir(1), "researcher.md", ROLE);
    let report = r.delete(&["researcher", "researcher@r1"], "researcher").unwrap();
    assert_eq!(report.deleted.len(), 2);
    assert!(!r.global.join("researcher.md").exists() && !r.repo_dir(0).join("researcher.md").exists());
    assert!(r.global.join("keep.md").exists() && r.repo_dir(1).join("researcher.md").exists(), "only the named files go");
    assert_eq!(report.backups.len(), 2);
    for b in &report.backups {
        assert_eq!(std::fs::read_to_string(b).unwrap(), ROLE, "the backup holds the removed content");
        assert!(!Path::new(b).components().any(|c| c.as_os_str() == ".claude"));
    }
    assert_eq!(r.store.backups().len(), 2);
}

#[test]
fn builtins_unknown_ids_and_paths_outside_the_agents_directories_are_refused() {
    let r = Rig::new();
    assert_eq!(r.delete(&["developer"], "developer").unwrap_err().code, "builtinNoFile");
    assert_eq!(r.delete(&["ghost"], "ghost").unwrap_err().code, "unknownRole");
    assert_eq!(r.delete(&["researcher@nope"], "researcher").unwrap_err().code, "unknownRole");
    assert_eq!(r.delete(&[], "x").unwrap_err().code, "unknownRole");
    // a role of an unregistered repository, and a file with a .git component are not role files
    write(&r.global, "researcher.md", ROLE);
    let other = r.tmp.path().join("other");
    std::fs::create_dir_all(other.join(".claude/agents")).unwrap();
    let store = RoleStore::new(r.global.clone(), Box::new(MemoryOverlay::default())).with_backup_dir(r.tmp.path().join("backups"));
    let other_repo = [RepoRef { id: "o".into(), path: other.clone() }];
    write(&other.join(".claude/agents"), "ghost.md", ROLE.replace("researcher", "ghost").as_str());
    let ids_v = ids(&["ghost@o"]);
    assert!(store.delete(&ids_v, "ghost", None, &other_repo).is_ok(), "a registered repo is fine");
    write(&other.join(".claude/agents"), "ghost2.md", ROLE.replace("researcher", "ghost2").as_str());
    assert_eq!(store.delete(&ids(&["ghost2@o"]), "ghost2", None, &[]).unwrap_err().code, "unknownRole", "an unregistered repo has no roles at all");
}

#[test]
fn the_jail_and_a_missing_backup_directory_refuse_without_touching_the_file() {
    let outside = tempfile::tempdir().unwrap();
    for (jail, code) in [(Jail::read_only(), "readOnly"), (Jail::e2e(outside.path()), "testJail")] {
        let r = Rig::with(|s| s.with_jail(jail));
        write(&r.global, "researcher.md", ROLE);
        assert_eq!(r.delete(&["researcher"], "researcher").unwrap_err().code, code);
        assert!(r.global.join("researcher.md").exists());
    }
    let tmp = tempfile::tempdir().unwrap();
    let global = tmp.path().join("agents");
    write(&global, "researcher.md", ROLE);
    let no_dir = RoleStore::new(global.clone(), Box::new(MemoryOverlay::default()));
    assert_eq!(no_dir.delete(&ids(&["researcher"]), "researcher", None, &[]).unwrap_err().code, "noBackupDir");
    let inside = RoleStore::new(global.clone(), Box::new(MemoryOverlay::default())).with_backup_dir(tmp.path().join("home/.claude/backups"));
    assert_eq!(inside.delete(&ids(&["researcher"]), "researcher", None, &[]).unwrap_err().code, "noBackupDir");
    assert!(global.join("researcher.md").exists());
}

#[test]
fn an_unreadable_file_is_not_deleted() {
    let r = Rig::new();
    write(&r.global, "researcher.md", ROLE);
    let p = r.global.join("researcher.md");
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o000)).unwrap();
    let readable = std::fs::read(&p).is_ok(); // running as root would defeat the test
    let res = r.delete(&["researcher"], "researcher");
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
    if !readable {
        assert!(res.is_err(), "backup_required fails, so nothing is deleted");
        assert!(p.exists());
    }
}

#[test]
fn a_failing_backup_deletes_nothing_from_a_multi_file_request() {
    let r = Rig::new();
    write(&r.global, "researcher.md", ROLE);
    write(&r.repo_dir(0), "researcher.md", ROLE);
    let bad = r.repo_dir(0).join("researcher.md");
    std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o000)).unwrap();
    let readable = std::fs::read(&bad).is_ok();
    let res = r.delete(&["researcher", "researcher@r1"], "researcher");
    std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o644)).unwrap();
    if !readable {
        assert!(res.is_err());
        assert!(r.global.join("researcher.md").exists() && bad.exists(), "the first file was not deleted either");
        assert!(r.store.backups().is_empty(), "the backups made before the failure are removed");
    }
    // a backup directory that cannot be created fails the same way
    let tmp = tempfile::tempdir().unwrap();
    let global = tmp.path().join("agents");
    write(&global, "researcher.md", ROLE);
    std::fs::write(tmp.path().join("blocker"), "a file, not a directory").unwrap();
    let store = RoleStore::new(global.clone(), Box::new(MemoryOverlay::default())).with_backup_dir(tmp.path().join("blocker/backups"));
    assert_eq!(store.delete(&ids(&["researcher"]), "researcher", None, &[]).unwrap_err().code, "io");
    assert!(global.join("researcher.md").exists());
}

#[test]
fn a_symlinked_repo_agents_directory_and_symlinked_files_are_refused() {
    let r = Rig::new();
    let secret = r.tmp.path().join("secret");
    write(&secret, "researcher.md", ROLE);
    // r2: the whole agents dir is a link to an outside directory
    std::fs::remove_dir_all(r.repo_dir(1)).unwrap();
    std::os::unix::fs::symlink(&secret, r.repo_dir(1)).unwrap();
    let e = r.delete(&["researcher@r2"], "researcher").unwrap_err();
    assert_eq!(e.code, "unknownRole", "the scan never lists a role of a symlinked agents dir: {e}");
    assert!(secret.join("researcher.md").exists());
    // a symlinked file inside a real dir is not listed either
    std::os::unix::fs::symlink(secret.join("researcher.md"), r.repo_dir(0).join("researcher.md")).unwrap();
    assert_eq!(r.delete(&["researcher@r1"], "researcher").unwrap_err().code, "unknownRole");
    assert!(secret.join("researcher.md").exists());
}

#[test]
fn a_file_swapped_for_a_symlink_between_the_check_and_the_removal_is_refused() {
    let r = Rig::new();
    write(&r.global, "researcher.md", ROLE);
    write(&r.global, "other.md", "---\nname: other\n---\nx\n");
    let target = r.tmp.path().join("precious.md");
    std::fs::write(&target, "precious").unwrap();
    let swap = |paths: &[PathBuf]| {
        std::fs::remove_file(&paths[0]).unwrap();
        std::os::unix::fs::symlink(&target, &paths[0]).unwrap();
    };
    let e = r.store.delete_with_hook(&ids(&["researcher"]), "researcher", None, &r.repos, &swap).unwrap_err();
    assert_eq!(e.code, "outsideAgentsDir", "{e}");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "precious");
    assert!(std::fs::symlink_metadata(r.global.join("researcher.md")).unwrap().file_type().is_symlink(), "the link itself is left alone");
    // a replaced regular file (other inode) is refused as well
    let r = Rig::new();
    write(&r.global, "researcher.md", ROLE);
    let replace = |paths: &[PathBuf]| {
        std::fs::remove_file(&paths[0]).unwrap();
        std::fs::write(&paths[0], "someone else wrote this").unwrap();
    };
    assert_eq!(r.store.delete_with_hook(&ids(&["researcher"]), "researcher", None, &r.repos, &replace).unwrap_err().code, "io");
    assert_eq!(std::fs::read_to_string(r.global.join("researcher.md")).unwrap(), "someone else wrote this");
}

#[test]
fn a_symlinked_global_directory_needs_a_second_typed_confirmation() {
    let tmp = tempfile::tempdir().unwrap();
    let real = tmp.path().join("dotfiles/agents");
    write(&real, "researcher.md", ROLE);
    let link = tmp.path().join("home/.claude/agents");
    std::fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let store = RoleStore::new(link, Box::new(MemoryOverlay::default())).with_backup_dir(tmp.path().join("backups"));
    let target = real.canonicalize().unwrap().to_string_lossy().into_owned();
    let preview = store.delete_preview(&ids(&["researcher"]), &[]).unwrap();
    assert_eq!(preview.link_target.as_deref(), Some(target.as_str()));
    assert!(preview.files[0].symlink_target.as_deref().is_some_and(|t| t.ends_with("dotfiles/agents/researcher.md")));
    assert_eq!(store.delete(&ids(&["researcher"]), "researcher", None, &[]).unwrap_err().code, "confirmLink");
    assert_eq!(store.delete(&ids(&["researcher"]), "researcher", Some("/wrong"), &[]).unwrap_err().code, "confirmLink");
    assert!(real.join("researcher.md").exists());
    store.delete(&ids(&["researcher"]), "researcher", Some(&target), &[]).unwrap();
    assert!(!real.join("researcher.md").exists());
}

#[test]
fn the_preview_lists_paths_and_the_backup_directory_and_writes_nothing() {
    let r = Rig::new();
    write(&r.global, "researcher.md", ROLE);
    write(&r.repo_dir(0), "researcher.md", ROLE);
    let p = r.store.delete_preview(&ids(&["researcher", "researcher@r1"]), &r.repos).unwrap();
    assert_eq!(p.name, "researcher");
    assert_eq!(p.files.len(), 2);
    assert_eq!((p.files[1].id.as_str(), p.files[1].repo_id.as_deref()), ("researcher@r1", Some("r1")));
    assert_eq!(p.backup_dir.as_deref(), Some(r.tmp.path().join("backups").to_str().unwrap()));
    assert!(p.link_target.is_none());
    assert!(r.store.backups().is_empty() && r.global.join("researcher.md").exists());
    assert_eq!(r.store.delete_preview(&ids(&["developer"]), &r.repos).unwrap_err().code, "builtinNoFile");
    assert_eq!(r.store.delete_preview(&ids(&["researcher", "other"]), &r.repos).unwrap_err().code, "unknownRole");
}

#[test]
fn copies_of_different_roles_cannot_be_deleted_in_one_request() {
    let r = Rig::new();
    write(&r.global, "researcher.md", ROLE);
    write(&r.global, "other.md", "---\nname: other\n---\nx\n");
    assert_eq!(r.delete(&["researcher", "other"], "researcher").unwrap_err().code, "invalidRole");
    assert!(r.global.join("other.md").exists() && r.global.join("researcher.md").exists());
}

#[test]
fn overlay_entries_stay_and_hidden_and_pin_go_with_the_last_copy() {
    let tmp = tempfile::tempdir().unwrap();
    let global = tmp.path().join("agents");
    write(&global, "dev.md", "---\nname: dev\ndescription: d\n---\nx\n");
    let overlay = tmp.path().join("data/roles-overlay.json");
    std::fs::create_dir_all(overlay.parent().unwrap()).unwrap();
    std::fs::write(&overlay, r#"{"dev":{"permission":"ask","hidden":true,"pin":"global","approvedHashes":["h"],"remoteStartable":false}}"#).unwrap();
    let store = RoleStore::new(global.clone(), Box::new(intely_roles::FileOverlay(overlay.clone()))).with_backup_dir(tmp.path().join("backups"));
    store.delete(&ids(&["dev"]), "dev", None, &[]).unwrap();
    let j: serde_json::Value = serde_json::from_slice(&std::fs::read(&overlay).unwrap()).unwrap();
    assert_eq!(j["dev"]["permission"], "ask", "a restored file keeps its settings");
    assert!(j["dev"].get("hidden").is_none() && j["dev"].get("pin").is_none() && j["dev"].get("approvedHashes").is_none(), "{j}");
    // with a built-in of that name the group stays, so hidden stays
    let tmp2 = tempfile::tempdir().unwrap();
    let global2 = tmp2.path().join("agents");
    write(&global2, "developer.md", "---\nname: developer\n---\nx\n");
    let overlay2 = tmp2.path().join("data/roles-overlay.json");
    std::fs::create_dir_all(overlay2.parent().unwrap()).unwrap();
    std::fs::write(&overlay2, r#"{"developer":{"hidden":true}}"#).unwrap();
    let store2 = RoleStore::new(global2, Box::new(intely_roles::FileOverlay(overlay2.clone()))).with_backup_dir(tmp2.path().join("backups")).with_builtin_names(vec!["developer".into()]);
    store2.delete(&ids(&["developer"]), "developer", None, &[]).unwrap();
    assert!(std::fs::read_to_string(&overlay2).unwrap().contains("\"hidden\":true"));
}

#[test]
fn a_corrupt_overlay_refuses_the_delete() {
    let tmp = tempfile::tempdir().unwrap();
    let global = tmp.path().join("agents");
    write(&global, "dev.md", "---\nname: dev\n---\nx\n");
    let overlay = tmp.path().join("data/roles-overlay.json");
    std::fs::create_dir_all(overlay.parent().unwrap()).unwrap();
    std::fs::write(&overlay, "not json").unwrap();
    let store = RoleStore::new(global.clone(), Box::new(intely_roles::FileOverlay(overlay))).with_backup_dir(tmp.path().join("backups"));
    assert_eq!(store.delete(&ids(&["dev"]), "dev", None, &[]).unwrap_err().code, "overlayCorrupt");
    assert!(global.join("dev.md").exists());
}

#[test]
fn the_file_a_duplicate_name_hides_can_be_deleted_by_its_own_id() {
    let r = Rig::new();
    write(&r.global, "a-dev.md", "---\nname: dev\ndescription: first\n---\nA\n");
    write(&r.global, "b-dev.md", "---\nname: dev\ndescription: second\n---\nB\n");
    let report = r.delete(&["dev#b-dev"], "dev").unwrap();
    assert_eq!(report.deleted.len(), 1);
    assert!(r.global.join("a-dev.md").exists() && !r.global.join("b-dev.md").exists());
    assert_eq!(std::fs::read_to_string(&report.backups[0]).unwrap(), "---\nname: dev\ndescription: second\n---\nB\n");
}
