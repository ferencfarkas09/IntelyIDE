mod common;

use std::fs;
use std::os::unix::fs::symlink;
use std::time::{Duration, Instant};

use common::*;
use intely_core::jail::Jail;
use intely_pathpick::*;

fn kind_of(fx: &Fx, p: &std::path::Path) -> PathKind {
    fx.validator().validate(&s(p), &root_purpose()).unwrap().kind
}

#[test]
fn classifies_the_common_shapes() {
    let fx = Fx::new();
    let repo = fx.repo("work/api");
    assert_eq!(kind_of(&fx, &repo), PathKind::Repo);
    let sub = fx.dir("work/api/src/deep");
    let v = fx.validator().validate(&s(&sub), &root_purpose()).unwrap();
    assert_eq!(v.kind, PathKind::Subfolder);
    assert_eq!(v.root.as_ref().unwrap().path, repo);
    assert_eq!(kind_of(&fx, &fx.dir("work/plain")), PathKind::NotGit);

    let bare = fx.dir("work/bare.git");
    fs::write(bare.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    fs::create_dir_all(bare.join("objects")).unwrap();
    fs::create_dir_all(bare.join("refs")).unwrap();
    assert_eq!(kind_of(&fx, &bare), PathKind::Bare);

    // Choosing the `.git` folder itself (or something inside it) offers the parent.
    let v = fx.validator().validate(&s(&repo.join(".git")), &root_purpose()).unwrap();
    assert_eq!(v.kind, PathKind::GitDir);
    assert_eq!(v.root.as_ref().unwrap().path, repo);
    let v = fx.validator().validate(&s(&repo.join(".git/refs")), &root_purpose()).unwrap();
    assert_eq!(v.kind, PathKind::GitDir);
}

#[test]
fn head_is_read_without_git() {
    let fx = Fx::new();
    let repo = fx.repo("r");
    let v = fx.validator().validate(&s(&repo), &root_purpose()).unwrap();
    assert_eq!((v.branch.as_deref(), v.detached), (Some("main"), false));
    fs::write(repo.join(".git/HEAD"), "0123456789abcdef0123456789abcdef01234567\n").unwrap();
    let v = fx.validator().validate(&s(&repo), &root_purpose()).unwrap();
    assert_eq!((v.branch, v.detached), (None, true));
}

#[test]
fn worktree_and_submodule_carry_limited_support() {
    let fx = Fx::new();
    let main = fx.repo("main");
    let wt_git = main.join(".git/worktrees/wt");
    fs::create_dir_all(&wt_git).unwrap();
    fs::write(wt_git.join("HEAD"), "ref: refs/heads/feature\n").unwrap();
    fs::write(wt_git.join("commondir"), "../..\n").unwrap();
    let wt = fx.dir("wt");
    fs::write(wt.join(".git"), format!("gitdir: {}\n", wt_git.display())).unwrap();
    let v = fx.validator().validate(&s(&wt), &root_purpose()).unwrap();
    assert_eq!(v.kind, PathKind::Worktree);
    assert_eq!(v.main.as_deref(), Some(s(&main.join(".git")).as_str()));
    assert!(v.warnings.contains(&PickWarning::LimitedSupport));
    assert_eq!(v.branch.as_deref(), Some("feature"));

    let sm_git = main.join(".git/modules/sm");
    fs::create_dir_all(&sm_git).unwrap();
    fs::write(sm_git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    let sm = fx.dir("main/sm");
    fs::write(sm.join(".git"), "gitdir: ../.git/modules/sm\n").unwrap();
    let v = fx.validator().validate(&s(&sm), &root_purpose()).unwrap();
    assert_eq!(v.kind, PathKind::Submodule);
    assert!(v.warnings.contains(&PickWarning::LimitedSupport));
}

#[test]
fn a_gitfile_redirect_is_a_repo_with_a_warning() {
    let fx = Fx::new();
    let foreign = fx.repo("elsewhere");
    let dir = fx.dir("shell");
    fs::write(dir.join(".git"), format!("gitdir: {}\n", foreign.join(".git").display())).unwrap();
    let v = fx.validator().validate(&s(&dir), &root_purpose()).unwrap();
    assert_eq!(v.kind, PathKind::Repo);
    assert!(v.warnings.contains(&PickWarning::GitfileRedirect));
    assert_eq!(v.gitfile_target.as_deref(), Some(s(&foreign.join(".git")).as_str()));
}

#[test]
fn errors_have_stable_codes() {
    let fx = Fx::new();
    let v = fx.validator();
    let code = |raw: &str, p: Purpose| v.validate(raw, &p).unwrap_err().code;
    assert_eq!(code(&s(&fx.root.join("nope")), root_purpose()), "notFound");
    assert_eq!(code("relative", root_purpose()), "pathInvalid");
    let file = fx.root.join("f.txt");
    fs::write(&file, "x").unwrap();
    assert_eq!(code(&s(&file), root_purpose()), "notADirectory");
    assert_eq!(code(&s(&fx.root), Purpose::File("caFile".into())), "notAFile");
    assert!(v.validate(&s(&file), &Purpose::File("caFile".into())).is_ok());
    assert_eq!(code("/Volumes/definitely-not-mounted-xyz/repo", root_purpose()), "volumeMissing");
    // A file as a path component is "not found", never a panic.
    assert_eq!(code(&s(&file.join("inner")), root_purpose()), "notFound");
}

#[test]
fn permission_denied_is_reported() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let fx = Fx::new();
    let locked = fx.dir("locked");
    let inner = fx.dir("locked/inner");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let e = fx.validator().validate(&s(&inner), &root_purpose()).unwrap_err();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(e.code, "permissionDenied");
}

#[test]
fn a_folder_that_cannot_be_searched_is_denied_not_called_a_non_repository() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let fx = Fx::new();
    let locked = fx.dir("locked");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let e = fx.validator().validate(&s(&locked), &root_purpose());
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(e.unwrap_err().code, "permissionDenied");
}

#[test]
fn symlink_resolves_to_canonical_and_is_flagged() {
    let fx = Fx::new();
    let repo = fx.repo("real/app");
    let link = fx.root.join("alias");
    symlink(&repo, &link).unwrap();
    let a = fx.validator().validate(&s(&link), &root_purpose()).unwrap();
    let b = fx.validator().validate(&s(&repo), &root_purpose()).unwrap();
    assert_eq!(a.path, repo);
    assert!(a.via_symlink && !b.via_symlink);
    assert_eq!(a.identity, b.identity, "two names for one directory dedupe");
}

#[test]
fn spaces_quotes_file_urls_and_tilde() {
    let fx = Fx::new();
    let repo = fx.repo("My Projects/it's");
    let v = fx.validator();
    for raw in [s(&repo), format!("\"{}\"", s(&repo)), format!("file://{}", s(&repo).replace(' ', "%20")), s(&repo).replace(' ', "\\ ")] {
        assert_eq!(v.validate(&raw, &root_purpose()).unwrap().path, repo, "{raw}");
    }
    let inhome = fx.home.join("proj");
    fs::create_dir_all(&inhome).unwrap();
    assert_eq!(v.validate("~/proj", &Purpose::ScanRoot).unwrap().path, inhome);
}

#[cfg(target_os = "macos")]
#[test]
fn an_nfd_directory_is_found_through_its_nfc_spelling() {
    use unicode_normalization::UnicodeNormalization;
    let fx = Fx::new();
    let nfd: String = "café".nfd().collect();
    let nfc: String = "café".nfc().collect();
    let repo = fx.repo(&format!("u/{nfd}"));
    let found = fx.validator().validate(&s(&fx.root.join("u").join(&nfc)), &root_purpose());
    // APFS normalises on lookup; on a volume that does not, the NFC spelling simply does not exist.
    if let Ok(v) = found {
        assert_eq!(v.name, nfc);
        assert_eq!(v.path.file_name().unwrap().to_string_lossy().nfc().collect::<String>(), nfc);
        assert!(fs::canonicalize(&repo).is_ok());
    }
}

#[test]
fn foreign_owner_warns_with_an_injected_uid() {
    let fx = Fx::new();
    let repo = fx.repo("theirs");
    let v = Validator::new(fx.policy(Jail::off()).with_uid(4_000_000));
    let got = v.validate(&s(&repo), &root_purpose()).unwrap();
    assert!(got.warnings.contains(&PickWarning::ForeignOwner));
    assert!(!fx.validator().validate(&s(&repo), &root_purpose()).unwrap().warnings.contains(&PickWarning::ForeignOwner));
}

#[test]
fn location_warnings() {
    let fx = Fx::new();
    let cloud = fx.repo("Dropbox/site");
    assert!(fx.validator().validate(&s(&cloud), &root_purpose()).unwrap().warnings.contains(&PickWarning::CloudFolder));
    let ignored = fx.repo("app/node_modules/dep");
    assert!(fx.validator().validate(&s(&ignored), &root_purpose()).unwrap().warnings.contains(&PickWarning::InsideIgnored));
    let linked = fx.repo("gs");
    fs::rename(linked.join(".git"), fx.root.join("realgit")).unwrap();
    symlink(fx.root.join("realgit"), linked.join(".git")).unwrap();
    assert!(fx.validator().validate(&s(&linked), &root_purpose()).unwrap().warnings.contains(&PickWarning::GitSymlink));
}

#[test]
fn the_e2e_jail_refuses_paths_outside_the_fixture_root() {
    let fx = Fx::new();
    let inside = fx.repo("fixture/repo");
    let outside = tempfile::tempdir().unwrap();
    let jail = Jail::e2e(fx.root.join("fixture"));
    let v = Validator::new(fx.policy(jail));
    assert!(v.validate(&s(&inside), &root_purpose()).is_ok());
    let e = v.validate(&s(outside.path()), &root_purpose()).unwrap_err();
    assert_eq!(e.code, "testJail");
    // A symlink inside the fixture that points out is judged by its target.
    symlink(outside.path(), fx.root.join("fixture/escape")).unwrap();
    assert_eq!(v.validate(&s(&fx.root.join("fixture/escape")), &root_purpose()).unwrap_err().code, "testJail");
}

#[test]
fn read_only_mode_still_validates() {
    let fx = Fx::new();
    let repo = fx.repo("r");
    let v = Validator::new(fx.policy(Jail::read_only()));
    assert_eq!(v.validate(&s(&repo), &root_purpose()).unwrap().kind, PathKind::Repo);
}

#[test]
fn too_broad_matrix() {
    let fx = Fx::new();
    let v = fx.validator();
    // $HOME as a dotfiles repository, an ancestor of $HOME, the state directory and secret folders are refused.
    let home_repo = fx.home.clone();
    fs::create_dir_all(home_repo.join(".git/objects")).unwrap();
    fs::create_dir_all(home_repo.join(".git/refs")).unwrap();
    fs::write(home_repo.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    assert_eq!(v.validate(&s(&home_repo), &root_purpose()).unwrap_err().code, "tooBroad");
    // ... which also makes every non-repo folder below it a refused "subfolder".
    let below = fx.home.join("Projects/loose");
    fs::create_dir_all(&below).unwrap();
    assert_eq!(v.validate(&s(&below), &root_purpose()).unwrap_err().code, "tooBroad");

    let fx2 = Fx::new();
    let v2 = fx2.validator();
    let ssh = fx2.home.join(".ssh/keys");
    fs::create_dir_all(ssh.join(".git/objects")).unwrap();
    fs::create_dir_all(ssh.join(".git/refs")).unwrap();
    fs::write(ssh.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    assert_eq!(v2.validate(&s(&ssh), &root_purpose()).unwrap_err().code, "tooBroad");
    for p in [&fx2.home, &fx2.root, &fx2.state] {
        assert!(v2.too_broad(p), "{p:?}");
    }
    assert!(v2.too_broad(std::path::Path::new("/")));
    assert!(v2.too_broad(std::path::Path::new("/Users")));
    assert!(v2.too_broad(std::path::Path::new("/Volumes/Backup")));
    assert!(!v2.too_broad(&fx2.home.join("Projects/ok")));
    assert!(v2.too_broad(&fx2.home.join("Library/Application Support/x")));
    // A plain non-git home folder is only "not git" (init has its own refusal).
    let fx3 = Fx::new();
    assert_eq!(fx3.validator().validate(&s(&fx3.home), &root_purpose()).unwrap().kind, PathKind::NotGit);
}

#[test]
fn a_fifo_as_head_and_a_dev_zero_config_are_unreadable_within_a_second() {
    let fx = Fx::new();
    let repo = fx.repo("hostile/fifo");
    fs::remove_file(repo.join(".git/HEAD")).unwrap();
    let c = std::ffi::CString::new(s(&repo.join(".git/HEAD"))).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    let t = Instant::now();
    let e = fx.validator().validate(&s(&repo), &root_purpose()).unwrap_err();
    assert!(t.elapsed() < Duration::from_secs(1));
    assert!(e.message.contains("unreadable"), "{e:?}");

    let repo2 = fx.repo("hostile/zero");
    fs::remove_file(repo2.join(".git/config")).unwrap();
    symlink("/dev/zero", repo2.join(".git/config")).unwrap();
    let t = Instant::now();
    let e = fx.validator().validate(&s(&repo2), &root_purpose()).unwrap_err();
    assert!(t.elapsed() < Duration::from_secs(1));
    assert!(e.message.contains("unreadable"), "{e:?}");
}

#[test]
fn a_hung_volume_answers_unresponsive_and_the_mount_is_then_skipped() {
    use std::sync::Arc;
    let fx = Fx::new();
    let repo = fx.repo("slowvol/repo");
    let fake = Arc::new(FakeFs::new());
    fake.block("slowvol");
    let v = fx.validator().with_fs(fake.clone()).with_deadline(Duration::from_millis(150));
    let t = Instant::now();
    let e = v.validate(&s(&repo), &root_purpose()).unwrap_err();
    assert_eq!(e.code, "unresponsive");
    assert!(t.elapsed() < Duration::from_secs(2));
    assert_eq!(v.guard.abandoned(), 1);
    fake.release();
    for _ in 0..50 {
        if v.guard.abandoned() == 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(v.guard.abandoned(), 0, "the abandoned thread is accounted for once it returns");
}
