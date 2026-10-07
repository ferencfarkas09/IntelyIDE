mod common;

use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use common::*;
use intely_pathpick::scan::*;
use intely_pathpick::*;

struct Out {
    found: Vec<Picked>,
    last: ScanProgress,
}

fn scan_with(fx: &Fx, v: &Validator, root: &Path, cfg: &ScanConfig, clock: &dyn ScanClock, cancel: &AtomicBool) -> Out {
    let tokens = fx.tokens();
    let mut found = Vec::new();
    let last = run_scan(v, &tokens, "s1", root, cfg, clock, cancel, &mut |p| found.push(p), &mut |_| {});
    Out { found, last }
}

fn scan(fx: &Fx, root: &Path, cfg: &ScanConfig) -> Out {
    scan_with(fx, &fx.validator(), root, cfg, &InstantClock::start(), &AtomicBool::new(false))
}

fn names(o: &Out) -> Vec<String> {
    let mut n: Vec<String> = o.found.iter().map(|p| p.name.clone()).collect();
    n.sort();
    n
}

#[test]
fn finds_repos_skips_decoys_and_never_descends_into_a_repo() {
    let fx = Fx::new();
    let parent = fx.dir("p");
    fx.repo("p/a");
    fx.repo("p/group/b");
    fx.repo("p/a/nested");
    fx.repo("p/node_modules/dep");
    fx.repo("p/.hidden/h");
    fx.repo("p/target/t");
    fx.dir("p/plain");
    symlink(fx.root.join("p/a"), parent.join("link")).unwrap();
    let o = scan(&fx, &parent, &ScanConfig::default());
    assert_eq!(names(&o), ["a", "b"]);
    assert!(o.last.done && !o.last.cancelled);
    assert_eq!(o.last.skipped_symlinks, 1);
    assert_eq!(o.last.found, 2);
    // Every result is fully validated and carries its own token.
    assert!(o.found.iter().all(|p| p.token.len() == 32 && p.kind == PathKind::Repo));
}

#[test]
fn hidden_directories_only_when_asked() {
    let fx = Fx::new();
    let parent = fx.dir("p");
    fx.repo("p/.dot/r");
    let mut cfg = ScanConfig::default();
    assert!(scan(&fx, &parent, &cfg).found.is_empty());
    cfg.include_hidden = true;
    assert_eq!(names(&scan(&fx, &parent, &cfg)), ["r"]);
}

#[test]
fn depth_limit_is_reported() {
    let fx = Fx::new();
    let parent = fx.dir("p");
    fx.repo("p/l1/l2/l3/deep");
    fx.repo("p/l1/near");
    let mut cfg = ScanConfig::default();
    cfg.depth = 3;
    let o = scan(&fx, &parent, &cfg);
    assert_eq!(names(&o), ["near"]);
    assert_eq!(o.last.reason, Some(ScanReason::Depth));
    cfg.depth = 5;
    let o = scan(&fx, &parent, &cfg);
    assert_eq!(names(&o), ["deep", "near"]);
    assert_eq!(o.last.reason, None);
}

#[test]
fn the_repo_cap_stops_the_scan() {
    let fx = Fx::new();
    let parent = fx.dir("p");
    for i in 0..5 {
        fx.repo(&format!("p/r{i}"));
    }
    let mut cfg = ScanConfig::default();
    cfg.max_repos = 3;
    let o = scan(&fx, &parent, &cfg);
    assert_eq!(o.found.len(), 3);
    assert_eq!((o.last.truncated, o.last.reason), (true, Some(ScanReason::Repos)));
}

#[test]
fn the_directory_cap_stops_the_scan() {
    let fx = Fx::new();
    let parent = fx.dir("p");
    for i in 0..10 {
        fx.dir(&format!("p/d{i}/inner"));
    }
    let mut cfg = ScanConfig::default();
    cfg.max_dirs = 4;
    let o = scan(&fx, &parent, &cfg);
    assert_eq!((o.last.truncated, o.last.reason), (true, Some(ScanReason::Dirs)));
    assert_eq!(o.last.visited, 4);
}

#[test]
fn the_time_limit_uses_the_injected_clock() {
    let fx = Fx::new();
    let parent = fx.dir("p");
    fx.dir("p/a/b");
    fx.dir("p/c/d");
    let clock = FakeScanClock::default();
    clock.advance(Duration::from_secs(16));
    let o = scan_with(&fx, &fx.validator(), &parent, &ScanConfig::default(), &clock, &AtomicBool::new(false));
    assert_eq!((o.last.truncated, o.last.reason), (true, Some(ScanReason::Time)));
    assert_eq!(o.last.visited, 0);
}

#[test]
fn cancel_stops_midway_and_keeps_the_results_so_far() {
    let fx = Fx::new();
    let parent = fx.dir("p");
    fx.repo("p/a-first");
    for i in 0..6 {
        fx.dir(&format!("p/d{i}/x"));
    }
    let cancel = AtomicBool::new(false);
    let tokens = fx.tokens();
    let v = fx.validator();
    let mut found = Vec::new();
    let last = run_scan(&v, &tokens, "s", &parent, &ScanConfig::default(), &InstantClock::start(), &cancel, &mut |p| {
        found.push(p);
    }, &mut |p| {
        if p.visited >= 2 {
            cancel.store(true, Ordering::SeqCst);
        }
    });
    assert!(last.cancelled, "{last:?}");
    assert!(last.visited < 13, "stopped before the whole tree was read: {}", last.visited);
    assert_eq!(found.len(), 1, "results found before the cancel stay");
}

#[test]
fn cancel_before_start_visits_nothing() {
    let fx = Fx::new();
    let parent = fx.dir("p");
    fx.repo("p/r");
    let o = scan_with(&fx, &fx.validator(), &parent, &ScanConfig::default(), &InstantClock::start(), &AtomicBool::new(true));
    assert!(o.last.cancelled && o.found.is_empty());
}

#[test]
fn the_e2e_jail_applies_to_the_root_and_candidates() {
    let fx = Fx::new();
    let fixture = fx.dir("fixture");
    fx.repo("fixture/in");
    let outside = fx.repo("outside/out");
    symlink(outside.parent().unwrap(), fixture.join("escape")).unwrap();
    let v = Validator::new(fx.policy(intely_core::jail::Jail::e2e(&fixture)));
    assert_eq!(v.validate(&s(&fx.root), &Purpose::ScanRoot).unwrap_err().code, "testJail");
    let o = scan_with(&fx, &v, &fixture, &ScanConfig::default(), &InstantClock::start(), &AtomicBool::new(false));
    assert_eq!(names(&o), ["in"]);
}

#[test]
fn a_home_scan_skips_the_protected_children() {
    let fx = Fx::new();
    fx.dir("home/Documents");
    fx.repo("home/Documents/secret");
    fx.repo("home/Desktop/also");
    fx.repo("home/code/api");
    let o = scan(&fx, &fx.home, &ScanConfig::default());
    assert_eq!(names(&o), ["api"]);
    let mut skipped = o.last.skipped_protected.clone();
    skipped.sort();
    assert_eq!(skipped, ["Desktop", "Documents"]);
}

#[test]
fn a_root_that_is_a_repository_yields_just_itself() {
    let fx = Fx::new();
    let repo = fx.repo("solo");
    fx.repo("solo/inner");
    let o = scan(&fx, &repo, &ScanConfig::default());
    assert_eq!(names(&o), ["solo"]);
}

#[test]
fn the_filesystem_root_is_refused() {
    assert_eq!(check_root(Path::new("/")).unwrap_err().code, "scanTooBroad");
    assert!(check_root(Path::new("/Users")).is_ok());
}

#[test]
fn other_devices_are_not_entered() {
    // Only checkable with two devices: the temp dir and /dev. If they are the same device, skip.
    use std::os::unix::fs::MetadataExt;
    let fx = Fx::new();
    let a = fs::metadata(&fx.root).unwrap().dev();
    let b = fs::metadata("/dev").unwrap().dev();
    if a == b {
        return;
    }
    let o = scan(&fx, Path::new("/dev"), &ScanConfig::default());
    assert!(o.found.is_empty());
}
