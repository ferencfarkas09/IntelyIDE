use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use intely_pathpick::fsops::{mount_key, Guard};

#[test]
fn a_fast_call_returns_its_value() {
    let g = Guard::default();
    assert_eq!(g.run("/", Duration::from_secs(1), || 7).unwrap(), 7);
    assert_eq!(g.abandoned(), 0);
}

#[test]
fn a_hung_call_is_abandoned_within_the_deadline_and_the_mount_is_skipped_afterwards() {
    let g = Guard::default();
    let release = Arc::new(AtomicBool::new(false));
    let r = release.clone();
    let t = Instant::now();
    let e = g
        .run("/Volumes/Backup", Duration::from_millis(100), move || {
            while !r.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
        })
        .unwrap_err();
    assert_eq!(e.code, "unresponsive");
    assert!(t.elapsed() < Duration::from_secs(1));
    assert_eq!(g.abandoned(), 1);
    // The breaker: that mount is skipped for the session without starting another thread.
    let e = g.run("/Volumes/Backup", Duration::from_secs(1), || 1).unwrap_err();
    assert_eq!(e.code, "unresponsive");
    assert!(g.is_broken("/Volumes/Backup"));
    // Another mount still works.
    assert_eq!(g.run("/", Duration::from_secs(1), || 2).unwrap(), 2);
    release.store(true, Ordering::SeqCst);
    for _ in 0..100 {
        if g.abandoned() == 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(g.abandoned(), 0);
}

#[test]
fn the_abandoned_thread_cap_refuses_new_work() {
    let g = Guard::new(2);
    let release = Arc::new(AtomicBool::new(false));
    for i in 0..2 {
        let r = release.clone();
        let _ = g.run(&format!("/Volumes/v{i}"), Duration::from_millis(40), move || {
            while !r.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
        });
    }
    assert_eq!(g.abandoned(), 2);
    let e = g.run("/", Duration::from_secs(1), || 1).unwrap_err();
    assert_eq!(e.code, "unresponsive");
    release.store(true, Ordering::SeqCst);
}

#[test]
fn mount_keys() {
    use std::path::Path;
    assert_eq!(mount_key(Path::new("/Volumes/Backup/x/y")), "/Volumes/Backup");
    assert_eq!(mount_key(Path::new("/Users/alice")), "/");
    assert_eq!(mount_key(Path::new("/Volumes")), "/");
}
