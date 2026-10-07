//! Draft vault, dialog handles and import staging (T5), with an injectable clock. The vault module sits behind the
//! `mongo` feature in `lib.rs`, so this file runs with `--features mongo`.
#![cfg(feature = "mongo")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use intely_mongo::api::{DialogKind, ProfileInput, WireSecret};
use intely_mongo::error::code;
use intely_mongo::vault::{Clock, DialogHandles, DraftSecrets, DraftVault, ImportStaging, DRAFT_CAP, DRAFT_TTL, HANDLE_TTL};
use intely_settings::Secret;

const CANARY: &str = "CANARY-vault-5be0";

fn clock() -> (Arc<AtomicU64>, Clock) {
    let t = Arc::new(AtomicU64::new(1_000));
    let c = t.clone();
    (t, Arc::new(move || c.load(Ordering::SeqCst)))
}

fn secrets(pw: &str) -> DraftSecrets {
    DraftSecrets { password: Some(Secret::new(pw)), key_password: Some(Secret::new("kp")) }
}

fn advance(t: &AtomicU64, d: Duration) {
    t.fetch_add(d.as_millis() as u64, Ordering::SeqCst);
}

#[test]
fn a_draft_is_redeemed_for_the_same_identity() {
    let v = DraftVault::new();
    let tok = v.put("id-A", secrets(CANARY)).unwrap();
    assert_eq!(tok.len(), 32);
    let s = v.get(&tok, "id-A").unwrap();
    assert_eq!(s.password.as_ref().unwrap().expose(), CANARY);
    assert_eq!(s.key_password.as_ref().unwrap().expose(), "kp");
    // get does not consume (a test and the following save use the same draft); take does
    assert!(v.take(&tok, "id-A").is_ok());
    assert_eq!(v.take(&tok, "id-A").unwrap_err().code, code::NEED_SECRET);
}

#[test]
fn tokens_are_random_and_unknown_tokens_are_refused() {
    let v = DraftVault::new();
    let a = v.put("i", secrets("x")).unwrap();
    let b = v.put("i", secrets("x")).unwrap();
    assert_ne!(a, b);
    let e = v.get("0000", "i").unwrap_err();
    assert_eq!(e.code, code::NEED_SECRET);
    assert!(e.message.starts_with("needs:"));
}

#[test]
fn an_identity_change_is_refused_and_wipes_the_entry() {
    let v = DraftVault::new();
    let tok = v.put("host-A", secrets(CANARY)).unwrap();
    let e = v.get(&tok, "host-B").unwrap_err();
    assert_eq!(e.code, code::NEED_SECRET);
    assert!(!e.message.contains(CANARY));
    // the entry is gone even for the right identity afterwards
    assert!(v.get(&tok, "host-A").is_err());
    assert!(v.is_empty());
}

#[test]
fn an_owned_draft_only_redeems_for_its_owner() {
    let v = DraftVault::new();
    let tok = v.put_for(Some("c1"), "id", secrets("x")).unwrap();
    assert!(v.get_for(&tok, Some("c2"), "id").is_err());
    let tok = v.put_for(Some("c1"), "id", secrets("x")).unwrap();
    assert!(v.get_for(&tok, None, "id").is_err(), "an owned draft is not redeemable anonymously");
    let tok = v.put_for(Some("c1"), "id", secrets("x")).unwrap();
    assert!(v.get_for(&tok, Some("c1"), "id").is_ok());
    v.clear_owner("c1");
    assert!(v.get_for(&tok, Some("c1"), "id").is_err());
}

#[test]
fn drafts_expire_after_ten_minutes() {
    let (t, c) = clock();
    let v = DraftVault::with_clock(c);
    let tok = v.put("i", secrets("x")).unwrap();
    advance(&t, DRAFT_TTL - Duration::from_millis(1));
    assert!(v.get(&tok, "i").is_ok());
    advance(&t, Duration::from_millis(1));
    assert_eq!(v.get(&tok, "i").unwrap_err().code, code::NEED_SECRET);
    assert_eq!(v.len(), 0);
}

#[test]
fn the_vault_holds_at_most_sixteen_and_drops_the_oldest() {
    let (t, c) = clock();
    let v = DraftVault::with_clock(c);
    let first = v.put("i", secrets("0")).unwrap();
    let mut last = String::new();
    for n in 1..=DRAFT_CAP {
        advance(&t, Duration::from_millis(1));
        last = v.put("i", secrets(&n.to_string())).unwrap();
    }
    assert_eq!(v.len(), DRAFT_CAP);
    assert!(v.get(&first, "i").is_err(), "the oldest was evicted");
    assert_eq!(v.get(&last, "i").unwrap().password.unwrap().expose(), DRAFT_CAP.to_string());
}

#[test]
fn discard_and_clear_remove_entries() {
    let v = DraftVault::new();
    let a = v.put("i", secrets("a")).unwrap();
    let b = v.put("i", secrets("b")).unwrap();
    v.discard(&a);
    assert!(v.get(&a, "i").is_err() && v.get(&b, "i").is_ok());
    v.clear();
    assert!(v.get(&b, "i").is_err() && v.is_empty());
}

#[test]
fn debug_output_never_carries_a_secret() {
    let v = DraftVault::new();
    v.put("i", secrets(CANARY)).unwrap();
    assert!(!format!("{v:?}").contains(CANARY));
    assert!(!format!("{:?}", secrets(CANARY)).contains(CANARY));
    let h = DialogHandles::new();
    h.issue(DialogKind::Import, PathBuf::from("/secret/dir/f.json")).unwrap();
    assert!(!format!("{h:?}").contains("secret"));
}

#[test]
fn a_dialog_handle_is_single_use_and_keeps_the_path_in_rust() {
    let h = DialogHandles::new();
    let handle = h.issue(DialogKind::Import, PathBuf::from("/Users/me/Documents/profiles.json")).unwrap();
    assert_eq!(handle.kind, DialogKind::Import);
    assert_eq!(handle.file_name.as_deref(), Some("profiles.json"));
    assert!(!serde_json::to_string(&handle).unwrap().contains("Documents"), "the wire handle has no path");
    assert_eq!(h.redeem(&handle.token, DialogKind::Import).unwrap(), PathBuf::from("/Users/me/Documents/profiles.json"));
    assert_eq!(h.redeem(&handle.token, DialogKind::Import).unwrap_err().code, code::HANDLE);
}

#[test]
fn a_handle_of_the_wrong_kind_is_refused_and_burned() {
    let h = DialogHandles::new();
    let handle = h.issue(DialogKind::Export, PathBuf::from("/tmp/out.json")).unwrap();
    assert_eq!(h.redeem(&handle.token, DialogKind::Import).unwrap_err().code, code::HANDLE);
    assert_eq!(h.redeem(&handle.token, DialogKind::Export).unwrap_err().code, code::HANDLE);
    assert_eq!(h.redeem("nonsense", DialogKind::Export).unwrap_err().code, code::HANDLE);
}

#[test]
fn a_handle_expires_after_five_minutes() {
    let (t, c) = clock();
    let h = DialogHandles::with_clock(c);
    let a = h.issue(DialogKind::Import, PathBuf::from("/tmp/a")).unwrap();
    let b = h.issue(DialogKind::Import, PathBuf::from("/tmp/b")).unwrap();
    advance(&t, HANDLE_TTL - Duration::from_millis(1));
    assert!(h.redeem(&a.token, DialogKind::Import).is_ok());
    advance(&t, Duration::from_millis(1));
    assert_eq!(h.redeem(&b.token, DialogKind::Import).unwrap_err().code, code::HANDLE);
    assert!(h.is_empty());
}

#[test]
fn handles_are_capped() {
    let h = DialogHandles::new();
    let first = h.issue(DialogKind::Import, PathBuf::from("/tmp/0")).unwrap();
    for n in 1..=16 {
        h.issue(DialogKind::Import, PathBuf::from(format!("/tmp/{n}"))).unwrap();
    }
    assert_eq!(h.len(), 16);
    assert!(h.redeem(&first.token, DialogKind::Import).is_err());
}

fn input(name: &str) -> ProfileInput {
    ProfileInput { name: name.into(), password: Some(WireSecret::new(CANARY)), ..Default::default() }
}

#[test]
fn staged_imports_are_selected_once_and_expire() {
    let (t, c) = clock();
    let s = ImportStaging::with_clock(c);
    s.stage("tok", vec![input("a"), input("b"), input("c")]);
    assert!(!format!("{s:?}").contains(CANARY));
    let got = s.take_selected("tok", &[2, 0, 0, 9]).unwrap();
    assert_eq!(got.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), vec!["c", "a"], "in the order asked, repeats and out-of-range ignored");
    assert_eq!(s.take_selected("tok", &[1]).unwrap_err().code, code::HANDLE, "single use");
    s.stage("tok2", vec![input("x")]);
    advance(&t, HANDLE_TTL);
    assert_eq!(s.take_selected("tok2", &[0]).unwrap_err().code, code::HANDLE);
    s.stage("tok3", vec![input("x")]);
    s.discard("tok3");
    assert!(s.take_selected("tok3", &[0]).is_err());
}
