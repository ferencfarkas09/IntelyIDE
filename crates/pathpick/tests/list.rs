mod common;

use std::fs;
use std::os::unix::fs::symlink;

use common::*;
use intely_pathpick::*;

fn opts(hidden: bool, files: bool) -> ListOpts {
    ListOpts { hidden, files, extensions: None }
}

#[test]
fn directories_first_collated_with_git_badges_and_a_hidden_toggle() {
    let fx = Fx::new();
    let base = fx.dir("base");
    fx.repo("base/Zeta");
    fx.dir("base/alpha");
    fx.dir("base/.hidden");
    fx.dir("base/Beta.app");
    fs::write(base.join("a.txt"), "x").unwrap();
    let v = fx.validator();
    let l = v.list(&s(&base), &opts(false, true)).unwrap();
    let names: Vec<_> = l.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["alpha", "Beta.app", "Zeta", "a.txt"]);
    assert_eq!(l.entries.iter().find(|e| e.name == "Zeta").unwrap().is_repo, Some(true));
    assert_eq!(l.entries.iter().find(|e| e.name == "alpha").unwrap().is_repo, Some(false));
    assert!(l.entries.iter().find(|e| e.name == "Beta.app").unwrap().package);
    assert_eq!(l.parent.as_deref(), Some(s(&fx.root).as_str()));
    let l = v.list(&s(&base), &opts(true, false)).unwrap();
    assert!(l.entries.iter().any(|e| e.name == ".hidden" && e.hidden));
    assert!(!l.entries.iter().any(|e| e.name == "a.txt"), "files only when asked");
}

#[test]
fn file_kinds_filter_by_extension() {
    let fx = Fx::new();
    let base = fx.dir("b");
    for n in ["ca.pem", "other.PEM", "x.txt", "id_ed25519"] {
        fs::write(base.join(n), "x").unwrap();
    }
    let l = fx.validator().list(&s(&base), &ListOpts { hidden: false, files: true, extensions: Some(vec!["pem".into(), ".crt".into()]) }).unwrap();
    let names: Vec<_> = l.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["ca.pem", "other.PEM"]);
    let l = fx.validator().list(&s(&base), &opts(false, true)).unwrap();
    assert!(l.entries.iter().any(|e| e.name == "id_ed25519"), "no extension filter lists every file");
}

#[test]
fn truncates_at_2000_and_skips_non_utf8_names() {
    use std::os::unix::ffi::OsStrExt;
    let fx = Fx::new();
    let base = fx.dir("big");
    for i in 0..2100 {
        fs::create_dir(base.join(format!("d{i:04}"))).unwrap();
    }
    let bad = std::ffi::OsStr::from_bytes(b"bad\xff\xfename");
    let _ = fs::create_dir(base.join(bad));
    let l = fx.validator().list(&s(&base), &opts(false, false)).unwrap();
    assert_eq!(l.entries.len(), 2000);
    assert!(l.truncated);
    assert!(l.total_seen >= 2100);
    assert_eq!(l.entries.iter().filter(|e| e.is_repo.is_some()).count(), 400, "at most 400 .git probes");
    assert!(l.skipped_unreadable <= 1);
}

#[test]
fn symlinks_are_marked_and_the_e2e_jail_never_follows_them_out() {
    let fx = Fx::new();
    let fixture = fx.dir("fixture");
    let target = fx.dir("fixture/real");
    let outside = fx.dir("outside");
    symlink(&target, fixture.join("link-in")).unwrap();
    symlink(&outside, fixture.join("link-out")).unwrap();
    let l = fx.validator().list(&s(&fixture), &opts(false, false)).unwrap();
    assert!(matches!(l.entries.iter().find(|e| e.name == "link-in").unwrap().kind, EntryKind::SymlinkDir));
    let v = Validator::new(fx.policy(intely_core::jail::Jail::e2e(&fixture)));
    let l = v.list(&s(&fixture), &opts(false, false)).unwrap();
    assert!(matches!(l.entries.iter().find(|e| e.name == "link-in").unwrap().kind, EntryKind::SymlinkDir));
    assert!(matches!(l.entries.iter().find(|e| e.name == "link-out").unwrap().kind, EntryKind::Other));
    assert_eq!(v.list(&s(&fx.root), &opts(false, false)).unwrap_err().code, "testJail");
    assert_eq!(l.parent, None, "no way up out of the fixture");
}

#[test]
fn protected_parents_and_children_are_never_probed() {
    let fx = Fx::new();
    // home/Documents is a guarded folder, and so is its content.
    let docs = fx.dir("home/Documents");
    fx.repo("home/Documents/proj");
    let v = fx.validator();
    let l = v.list(&s(&docs), &opts(false, false)).unwrap();
    assert_eq!(l.protected_folder, Some(ProtectedFolder::Documents));
    assert!(l.entries.iter().all(|e| e.is_repo.is_none()));
    // Listing home: the guarded children carry the marker and are not probed; others are.
    fx.dir("home/Desktop");
    fx.repo("home/code");
    let l = v.list(&s(&fx.home), &opts(false, false)).unwrap();
    let desk = l.entries.iter().find(|e| e.name == "Desktop").unwrap();
    assert_eq!((desk.protected_folder, desk.is_repo), (Some(ProtectedFolder::Desktop), None));
    assert_eq!(l.entries.iter().find(|e| e.name == "code").unwrap().is_repo, Some(true));
}

#[test]
fn errors_are_typed() {
    let fx = Fx::new();
    let v = fx.validator();
    assert_eq!(v.list(&s(&fx.root.join("missing")), &opts(false, false)).unwrap_err().code, "notFound");
    let f = fx.root.join("f");
    fs::write(&f, "x").unwrap();
    assert_eq!(v.list(&s(&f), &opts(false, false)).unwrap_err().code, "notADirectory");
    assert_eq!(v.list("nope", &opts(false, false)).unwrap_err().code, "pathInvalid");
}

#[test]
fn start_info_in_e2e_mode_is_the_fixture_root() {
    let fx = Fx::new();
    let v = fx.e2e_validator();
    let info = v.start_info(None);
    assert_eq!(info.home, s(&fx.root));
    assert_eq!(info.start_path, s(&fx.root));
    assert!(info.volumes.is_empty());
    assert_eq!(info.places.len(), 1);
}
