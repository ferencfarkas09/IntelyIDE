mod common;

use std::fs;
use std::os::unix::fs::symlink;
use std::sync::Arc;

use common::*;
use intely_pathpick::tokens::{MAX_OUTSTANDING, TTL_MS};
use intely_pathpick::*;

fn setup() -> (Fx, Arc<FakeClock>, PathTokens, Validator) {
    let fx = Fx::new();
    let clock = Arc::new(FakeClock::new(1_000));
    let t = PathTokens::with_clock(clock.clone());
    let v = fx.validator();
    (fx, clock, t, v)
}

#[test]
fn a_token_is_32_hex_and_redeems_once() {
    let (fx, _c, t, v) = setup();
    let repo = fx.repo("r");
    let p = t.issue(v.validate(&s(&repo), &root_purpose()).unwrap(), &root_purpose());
    assert_eq!(p.token.len(), 32);
    assert!(p.token.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    let r = t.redeem(&p.token, &[root_purpose()], &v).unwrap();
    assert_eq!(r.validated.path, repo);
    assert_eq!(t.redeem(&p.token, &[root_purpose()], &v).err().unwrap().code, "tokenUsed");
}

#[test]
fn forged_unknown_tokens_are_not_validated() {
    let (_fx, _c, t, v) = setup();
    assert_eq!(t.redeem(&"a".repeat(32), &[root_purpose()], &v).err().unwrap().code, "pathNotValidated");
    assert_eq!(t.redeem("", &[root_purpose()], &v).err().unwrap().code, "pathNotValidated");
}

#[test]
fn tokens_expire_after_five_minutes() {
    let (fx, c, t, v) = setup();
    let repo = fx.repo("r");
    let p = t.issue(v.validate(&s(&repo), &root_purpose()).unwrap(), &root_purpose());
    c.advance(TTL_MS + 1);
    assert_eq!(t.redeem(&p.token, &[root_purpose()], &v).err().unwrap().code, "tokenExpired");
    assert_eq!(t.outstanding(), 0);
}

#[test]
fn a_wrong_purpose_does_not_consume_the_token() {
    let (fx, _c, t, v) = setup();
    let repo = fx.repo("r");
    let p = t.issue(v.validate(&s(&repo), &root_purpose()).unwrap(), &root_purpose());
    assert_eq!(t.redeem(&p.token, &[Purpose::ScanRoot], &v).err().unwrap().code, "wrongPurpose");
    assert!(t.redeem(&p.token, &[Purpose::ScanRoot, root_purpose()], &v).is_ok());
}

#[test]
fn capacity_evicts_the_oldest() {
    let (fx, c, t, v) = setup();
    let dir = fx.dir("d");
    let first = t.issue(v.validate(&s(&dir), &Purpose::ScanRoot).unwrap(), &Purpose::ScanRoot);
    for _ in 0..MAX_OUTSTANDING {
        c.advance(1);
        t.issue(v.validate(&s(&dir), &Purpose::ScanRoot).unwrap(), &Purpose::ScanRoot);
    }
    assert_eq!(t.outstanding(), MAX_OUTSTANDING);
    assert_eq!(t.redeem(&first.token, &[Purpose::ScanRoot], &v).err().unwrap().code, "tokenExpired");
}

#[test]
fn a_directory_swapped_for_a_symlink_between_issue_and_redeem_is_refused() {
    let (fx, _c, t, v) = setup();
    let repo = fx.repo("proj");
    let other = fx.repo("other");
    let p = t.issue(v.validate(&s(&repo), &root_purpose()).unwrap(), &root_purpose());
    fs::rename(&repo, fx.root.join("proj.moved")).unwrap();
    symlink(&other, &repo).unwrap();
    let e = t.redeem(&p.token, &[root_purpose()], &v).err().unwrap();
    assert_eq!(e.code, "pathNotValidated");
}

#[test]
fn a_subfolder_result_carries_a_second_token_for_its_root() {
    let (fx, _c, t, v) = setup();
    let repo = fx.repo("r");
    let sub = fx.dir("r/pkg");
    let p = t.issue(v.validate(&s(&sub), &root_purpose()).unwrap(), &root_purpose());
    let root = p.root.as_ref().unwrap();
    assert_ne!(root.token, p.token);
    assert_eq!(t.redeem(&root.token, &[root_purpose()], &v).unwrap().validated.path, repo);
}
