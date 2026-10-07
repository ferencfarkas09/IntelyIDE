//! U1: minisign verification, trusted-comment binding, role separation, revocation matrix, the key
//! set rules and the golden test against the real `tauri signer` (spec 10.1, 10.2 `verify`).
mod common;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use common::keys::{TestKey, TestKeys};
use intely_updater::feed::check_seq;
use intely_updater::keys::*;
use intely_updater::verify::*;
use intely_updater::version::{parse_strict, Channel};
use intely_updater::ErrorCode;

const PROD: VerifyPolicy = VerifyPolicy::PRODUCTION;

fn feed_bytes() -> Vec<u8> {
    br#"{"schema":1,"channel":"stable","seq":2}"#.to_vec()
}

fn comment(file: &str) -> String {
    TestKey::comment(file, "0.1.1")
}

/// Decode a .sig file to its text, apply `f`, encode again.
fn edit_sig(sig_b64: &str, f: impl FnOnce(String) -> String) -> String {
    let text = String::from_utf8(B64.decode(sig_b64).unwrap()).unwrap();
    B64.encode(f(text))
}

#[test]
fn valid_feed_signature_from_feed_and_standby_keys() {
    let k = TestKeys::generate();
    let set = k.key_set();
    let data = feed_bytes();
    for signer in [&k.feed, &k.standby] {
        let sig = signer.sign(&data, &comment("stable.json"));
        let v = verify_feed(&set, &Revocations::new(), PROD, &data, &sig, Channel::Stable).unwrap();
        assert_eq!(v.key_id, signer.id());
        assert_eq!(v.role, signer.role);
        assert_eq!(v.comment.file, "stable.json");
        assert_eq!(v.comment.version.as_deref(), Some("0.1.1"));
        assert_eq!(v.comment.timestamp.as_deref(), Some("1790000000"));
        v.check_version(&parse_strict("0.1.1").unwrap(), PROD).unwrap();
    }
}

#[test]
fn valid_artifact_signature_from_both_artifact_keys() {
    let k = TestKeys::generate();
    let set = k.key_set();
    let data = vec![7u8; 4096];
    let name = "IntelyIDE_0.1.1_x64.app.tar.gz";
    for signer in [&k.artifact, &k.spare] {
        let sig = signer.sign(&data, &comment(name));
        let v = verify_artifact(&set, &Revocations::new(), PROD, &data, &sig, name).unwrap();
        assert_eq!(v.role, Role::Artifact);
        assert_eq!(v.key_id, signer.id());
    }
}

#[test]
fn role_separation() {
    let k = TestKeys::generate();
    let set = k.key_set();
    let data = feed_bytes();
    // a feed signed by an Artifact key
    for a in [&k.artifact, &k.spare] {
        let sig = a.sign(&data, &comment("stable.json"));
        assert_eq!(verify_feed(&set, &Revocations::new(), PROD, &data, &sig, Channel::Stable).unwrap_err(), ErrorCode::FeedSignature);
    }
    // an artifact signed by a Feed or standby key
    let name = "IntelyIDE_0.1.1_x64.app.tar.gz";
    for f in [&k.feed, &k.standby] {
        let sig = f.sign(&data, &comment(name));
        assert_eq!(verify_artifact(&set, &Revocations::new(), PROD, &data, &sig, name).unwrap_err(), ErrorCode::Signature);
    }
}

#[test]
fn unknown_key_id_is_refused_even_with_a_valid_signature() {
    let k = TestKeys::generate();
    let stranger = TestKey::generate(Role::Feed);
    let data = feed_bytes();
    let sig = stranger.sign(&data, &comment("stable.json"));
    assert_eq!(verify_feed(&k.key_set(), &Revocations::new(), PROD, &data, &sig, Channel::Stable).unwrap_err(), ErrorCode::FeedSignature);
    let asig = stranger.sign(&data, &comment("a.tar.gz"));
    assert_eq!(verify_artifact(&k.key_set(), &Revocations::new(), PROD, &data, &asig, "a.tar.gz").unwrap_err(), ErrorCode::Signature);
}

#[test]
fn a_key_with_the_right_id_but_other_key_material_is_refused() {
    // an attacker key that claims the id of a trusted key: the signature does not verify
    let k = TestKeys::generate();
    let attacker = TestKey::generate(Role::Feed);
    let data = feed_bytes();
    let sig = attacker.sign(&data, &comment("stable.json"));
    let forged = edit_sig(&sig, |t| {
        // replace the id bytes inside the signature line by the trusted key's id
        let lines: Vec<&str> = t.lines().collect();
        let mut bin = B64.decode(lines[1]).unwrap();
        let mut id = [0u8; 8];
        let hex = k.feed.id();
        for (i, b) in id.iter_mut().rev().enumerate() {
            *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        bin[2..10].copy_from_slice(&id);
        format!("{}\n{}\n{}\n{}\n", lines[0], B64.encode(bin), lines[2], lines[3])
    });
    assert_eq!(verify_feed(&k.key_set(), &Revocations::new(), PROD, &data, &forged, Channel::Stable).unwrap_err(), ErrorCode::FeedSignature);
}

#[test]
fn tampered_artifact_one_flipped_byte_and_one_appended_byte() {
    let k = TestKeys::generate();
    let set = k.key_set();
    let data = vec![1u8; 10_000];
    let name = "IntelyIDE_0.1.1_x64.app.tar.gz";
    let sig = k.artifact.sign(&data, &comment(name));
    verify_artifact(&set, &Revocations::new(), PROD, &data, &sig, name).unwrap();
    let mut flipped = data.clone();
    flipped[5000] ^= 1;
    assert_eq!(verify_artifact(&set, &Revocations::new(), PROD, &flipped, &sig, name).unwrap_err(), ErrorCode::Signature);
    let mut appended = data.clone();
    appended.push(0);
    assert_eq!(verify_artifact(&set, &Revocations::new(), PROD, &appended, &sig, name).unwrap_err(), ErrorCode::Signature);
    assert_eq!(verify_artifact(&set, &Revocations::new(), PROD, &data[..9_999], &sig, name).unwrap_err(), ErrorCode::Signature);
    // the feed too
    let fd = feed_bytes();
    let fsig = k.feed.sign(&fd, &comment("stable.json"));
    let mut bad = fd.clone();
    bad[10] ^= 1;
    assert_eq!(verify_feed(&set, &Revocations::new(), PROD, &bad, &fsig, Channel::Stable).unwrap_err(), ErrorCode::FeedSignature);
}

#[test]
fn signature_of_another_file_is_a_comment_mismatch() {
    let k = TestKeys::generate();
    let set = k.key_set();
    let data = feed_bytes();
    // the alpha feed's signature must not be accepted for stable.json (same bytes, other file)
    let sig = k.feed.sign(&data, &comment("alpha.json"));
    assert_eq!(verify_feed(&set, &Revocations::new(), PROD, &data, &sig, Channel::Stable).unwrap_err(), ErrorCode::SignatureComment);
    assert!(verify_feed(&set, &Revocations::new(), PROD, &data, &sig, Channel::Alpha).is_ok());
    let name = "IntelyIDE_0.1.1_x64.app.tar.gz";
    let asig = k.artifact.sign(&data, &comment("IntelyIDE_0.1.1_aarch64.app.tar.gz"));
    assert_eq!(verify_artifact(&set, &Revocations::new(), PROD, &data, &asig, name).unwrap_err(), ErrorCode::SignatureComment);
}

#[test]
fn global_signature_covers_the_trusted_comment() {
    let k = TestKeys::generate();
    let set = k.key_set();
    let data = feed_bytes();
    let sig = k.feed.sign(&data, &comment("alpha.json"));
    // an attacker rewrites the comment to name stable.json but cannot re-sign it
    let rewritten = edit_sig(&sig, |t| t.replace("file:alpha.json", "file:stable.json"));
    assert_eq!(verify_feed(&set, &Revocations::new(), PROD, &data, &rewritten, Channel::Stable).unwrap_err(), ErrorCode::FeedSignature);
}

#[test]
fn trusted_comment_parsing_table() {
    let ok = parse_trusted_comment("timestamp:1790000000\tfile:stable.json\tversion:0.1.1").unwrap();
    assert_eq!(ok.file, "stable.json");
    assert_eq!(parse_trusted_comment("file:x").unwrap().timestamp, None);
    assert_eq!(parse_trusted_comment("file:x\ttimestamp:1").unwrap().file, "x");
    for bad in [
        "",
        "timestamp:1790000000",                       // no file
        "file:",                                      // empty file
        "file:a\tfile:b",                             // duplicate
        "file:a\tfile:a",                             // duplicate, even when equal
        "file:a\ttimestamp:1\ttimestamp:2",           // duplicate
        "file:a\tversion:0.1.1\tversion:0.1.1",       // duplicate
        "file:a\tcolor:red",                          // unknown key
        "file:a\tprehashed",                          // field without a colon
        "file:a\ttimestamp:abc",                      // not digits
        "file:a\ttimestamp:1234567890123",            // too long
        "file:a\tversion:v0.1.1",                     // not strict semver
        "file:a\tversion:1.0",                        // not strict semver
        "file:a\u{0}b",                               // control character
        "file:a\r",                                   // control character
        "FILE:a",                                     // keys are case sensitive
    ] {
        assert_eq!(parse_trusted_comment(bad).unwrap_err(), ErrorCode::SignatureComment, "{bad:?}");
    }
    let long = format!("file:{}", "a".repeat(513));
    assert!(parse_trusted_comment(&long).is_err());
}

#[test]
fn comment_with_duplicate_or_unknown_fields_is_refused_end_to_end() {
    let k = TestKeys::generate();
    let set = k.key_set();
    let data = feed_bytes();
    for c in ["file:stable.json\tfile:stable.json", "file:stable.json\tcolor:red", "timestamp:1"] {
        let sig = k.feed.sign(&data, c);
        assert_eq!(verify_feed(&set, &Revocations::new(), PROD, &data, &sig, Channel::Stable).unwrap_err(), ErrorCode::SignatureComment, "{c}");
    }
}

#[test]
fn version_binding_of_the_trusted_comment() {
    let k = TestKeys::generate();
    let set = k.key_set();
    let data = feed_bytes();
    let v011 = parse_strict("0.1.1").unwrap();
    let v012 = parse_strict("0.1.2").unwrap();
    // present and equal
    let sig = k.feed.sign(&data, &TestKey::comment("stable.json", "0.1.1"));
    let v = verify_feed(&set, &Revocations::new(), PROD, &data, &sig, Channel::Stable).unwrap();
    assert!(v.check_version(&v011, PROD).is_ok());
    assert_eq!(v.check_version(&v012, PROD).unwrap_err(), ErrorCode::SignatureComment);
    assert_eq!(v.check_version(&v012, VerifyPolicy::TEST_LENIENT).unwrap_err(), ErrorCode::SignatureComment, "present but different always fails");
    // absent: required in production, optional in test mode
    let sig = k.feed.sign(&data, "timestamp:1790000000\tfile:stable.json");
    let v = verify_feed(&set, &Revocations::new(), PROD, &data, &sig, Channel::Stable).unwrap();
    assert_eq!(v.check_version(&v011, PROD).unwrap_err(), ErrorCode::SignatureComment);
    assert!(v.check_version(&v011, VerifyPolicy::TEST_LENIENT).is_ok());
}

#[test]
fn legacy_signatures_only_in_test_mode() {
    let k = TestKeys::generate();
    let set = k.key_set();
    let data = feed_bytes();
    let sig = k.feed.sign_legacy(&data, &comment("stable.json"));
    assert_eq!(verify_feed(&set, &Revocations::new(), PROD, &data, &sig, Channel::Stable).unwrap_err(), ErrorCode::FeedSignature, "production rejects legacy Ed");
    let v = verify_feed(&set, &Revocations::new(), VerifyPolicy::TEST_LENIENT, &data, &sig, Channel::Stable).unwrap();
    assert_eq!(v.role, Role::Feed);
    assert!(!PROD.allow_legacy && PROD.require_version);
    // the streaming verifier is prehashed-only
    let name = "a.tar.gz";
    let asig = k.artifact.sign_legacy(&data, &comment(name));
    let p = PreparedSignature::new(FileKind::Artifact, &set, &Revocations::new(), VerifyPolicy::TEST_LENIENT, &asig, name).unwrap();
    assert!(p.stream().is_err());
    assert!(p.verify_bytes(&data).is_ok());
}

#[test]
fn malformed_signature_files() {
    let k = TestKeys::generate();
    let set = k.key_set();
    let data = feed_bytes();
    let good = k.feed.sign(&data, &comment("stable.json"));
    let v = |s: &str| verify_feed(&set, &Revocations::new(), PROD, &data, s, Channel::Stable).unwrap_err();
    assert_eq!(v(""), ErrorCode::FeedSignature);
    assert_eq!(v("   \n"), ErrorCode::FeedSignature);
    assert_eq!(v("%%%not base64%%%"), ErrorCode::FeedSignature);
    assert_eq!(v(&B64.encode("hello")), ErrorCode::FeedSignature);
    assert_eq!(v(&B64.encode([0xff, 0xfe, 0xfd])), ErrorCode::FeedSignature, "not UTF-8");
    assert_eq!(v(&good[..good.len() / 2]), ErrorCode::FeedSignature, "truncated");
    assert_eq!(v(&edit_sig(&good, |t| t.lines().take(3).collect::<Vec<_>>().join("\n"))), ErrorCode::FeedSignature, "missing global signature line");
    assert_eq!(v(&edit_sig(&good, |t| t.replace("trusted comment: ", "trusted-comment: "))), ErrorCode::FeedSignature);
    // a trailing newline is fine (the files on disk end with one)
    assert!(verify_feed(&set, &Revocations::new(), PROD, &data, &format!("{good}\n"), Channel::Stable).is_ok());
    // size caps: feed signature 4 KiB, artifact signature 2 KiB
    let huge = "A".repeat(4097);
    assert_eq!(v(&huge), ErrorCode::FeedSignature);
    let name = "a.tar.gz";
    let asig = "A".repeat(2049);
    assert_eq!(verify_artifact(&set, &Revocations::new(), PROD, &data, &asig, name).unwrap_err(), ErrorCode::Signature);
}

#[test]
fn revoked_key_is_refused() {
    let k = TestKeys::generate();
    let set = k.key_set();
    let data = feed_bytes();
    let sig = k.feed.sign(&data, &comment("stable.json"));
    let mut rev = Revocations::new();
    let out = set.apply_revoke(set.find(&k.standby.id()).unwrap(), &[k.feed.id()], &mut rev);
    assert_eq!(out.applied, vec![k.feed.id()]);
    assert_eq!(verify_feed(&set, &rev, PROD, &data, &sig, Channel::Stable).unwrap_err(), ErrorCode::KeyRevoked);
    // the standby keeps signing feeds
    let ssig = k.standby.sign(&data, &comment("stable.json"));
    assert!(verify_feed(&set, &rev, PROD, &data, &ssig, Channel::Stable).is_ok());
    // a revoked Artifact key refuses artifacts, the spare still works
    let name = "a.tar.gz";
    let mut rev2 = Revocations::new();
    set.apply_revoke(set.find(&k.standby.id()).unwrap(), &[k.artifact.id()], &mut rev2);
    let a = k.artifact.sign(&data, &comment(name));
    let s = k.spare.sign(&data, &comment(name));
    assert_eq!(verify_artifact(&set, &rev2, PROD, &data, &a, name).unwrap_err(), ErrorCode::KeyRevoked);
    assert!(verify_artifact(&set, &rev2, PROD, &data, &s, name).is_ok());
}

#[test]
fn revocation_matrix() {
    let k = TestKeys::generate();
    let set = k.key_set();
    let ids = |v: &[&TestKey]| v.iter().map(|k| k.id()).collect::<Vec<_>>();
    let signer = |t: &TestKey| set.find(&t.id()).unwrap().clone();

    // only the standby revokes
    for not_standby in [&k.feed, &k.artifact, &k.spare] {
        let mut rev = Revocations::new();
        let out = set.apply_revoke(&signer(not_standby), &ids(&[&k.artifact, &k.feed]), &mut rev);
        assert!(out.applied.is_empty() && rev.is_empty(), "{:?} must not revoke", not_standby.role);
        assert!(out.ignored.iter().all(|(_, why)| *why == IgnoredRevoke::SignerNotStandby));
        assert_eq!(out.ignored.len(), 2);
    }
    // the standby revokes Feed and Artifact keys, both artifact keys at once too
    let mut rev = Revocations::new();
    let out = set.apply_revoke(&signer(&k.standby), &ids(&[&k.feed, &k.artifact, &k.spare]), &mut rev);
    assert_eq!(out.applied.len(), 3);
    assert!(out.ignored.is_empty());
    assert!(rev.contains(&k.feed.id()) && rev.contains(&k.artifact.id()) && rev.contains(&k.spare.id()));
    assert!(rev.contains(&k.feed.id().to_lowercase()), "case-insensitive");
    // nobody revokes the standby, and the standby does not revoke itself
    let mut rev = Revocations::new();
    let out = set.apply_revoke(&signer(&k.standby), &ids(&[&k.standby]), &mut rev);
    assert!(rev.is_empty());
    assert_eq!(out.ignored[0].1, IgnoredRevoke::SelfRevoke);
    let other_standby = TestKey::generate(Role::FeedStandby);
    let two = KeySet::new(vec![k.feed.trusted(), k.standby.trusted(), other_standby.trusted(), k.artifact.trusted()]);
    let out = two.apply_revoke(two.find(&k.standby.id()).unwrap(), &[other_standby.id()], &mut rev);
    assert_eq!(out.ignored[0].1, IgnoredRevoke::TargetIsStandby);
    assert!(rev.is_empty());
    // unknown and malformed ids change nothing
    let mut rev = Revocations::new();
    let out = set.apply_revoke(&signer(&k.standby), &["0123456789ABCDEF".to_string(), "xyz".to_string(), String::new()], &mut rev);
    assert!(rev.is_empty());
    assert_eq!(out.ignored.iter().map(|(_, w)| *w).collect::<Vec<_>>(), vec![IgnoredRevoke::UnknownKey, IgnoredRevoke::Malformed, IgnoredRevoke::Malformed]);
}

#[test]
fn a_revocation_takes_effect_with_an_equal_seq_and_after_a_poisoned_floor() {
    // 4.6 step 2: revocations are processed before the sequence rule and independent of it
    let k = TestKeys::generate();
    let set = k.key_set();
    let standby = set.find(&k.standby.id()).unwrap().clone();
    let mut rev = Revocations::new();
    // the standby feed has the same seq as the floor: accepted, and its revoke applies
    assert!(check_seq(Role::FeedStandby, Some(10), 0, 10, None).is_ok());
    set.apply_revoke(&standby, &[k.feed.id()], &mut rev);
    assert!(rev.contains(&k.feed.id()));
    // a stolen Feed key pushed the floor +1000; the standby can still reset it
    let poisoned = check_seq(Role::Feed, Some(10), 0, 1010, None).unwrap().new_floor;
    assert_eq!(check_seq(Role::FeedStandby, Some(poisoned), 0, 12, Some(12)).unwrap().new_floor, 12);
}

#[test]
fn revocations_json_round_trip_and_tamper() {
    let mut rev = Revocations::new();
    let k = TestKeys::generate();
    let set = k.key_set();
    set.apply_revoke(set.find(&k.standby.id()).unwrap(), &[k.feed.id(), k.artifact.id()], &mut rev);
    let back = Revocations::from_json(&rev.to_json()).unwrap();
    assert_eq!(back, rev);
    assert_eq!(Revocations::from_json(&Revocations::new().to_json()).unwrap(), Revocations::new());
    for bad in [
        "", "{}", "[]", r#"{"schema":2,"revoked":[]}"#, r#"{"schema":1}"#, r#"{"schema":1,"revoked":"x"}"#, r#"{"schema":1,"revoked":["nothex"]}"#,
        r#"{"schema":1,"revoked":[1]}"#, "not json",
    ] {
        assert!(Revocations::from_json(bad).is_err(), "{bad:?}");
    }
    let many: Vec<String> = (0..65).map(|i| format!("{i:016X}")).collect();
    assert!(Revocations::from_json(&serde_json::json!({"schema":1,"revoked":many}).to_string()).is_err());
}

#[test]
fn key_set_must_be_configured() {
    // the compiled-in set is placeholders until the owner's ceremony
    assert_eq!(KeySet::production().check_configured().unwrap_err(), ErrorCode::NoTrustedKey);
    assert!(TRUSTED_KEYS.iter().any(|k| k.role == Role::Feed));
    assert!(TRUSTED_KEYS.iter().filter(|k| k.role == Role::Artifact).count() >= 2);
    assert!(TRUSTED_KEYS.iter().any(|k| k.role == Role::FeedStandby));
    assert!(TRUSTED_KEYS.iter().all(|k| k.public_b64 == PLACEHOLDER_KEY));
    // a full throwaway set is configured
    let k = TestKeys::generate();
    assert!(k.key_set().check_configured().is_ok());
    // a missing role is not configured
    let no_artifact = KeySet::new(vec![k.feed.trusted(), k.standby.trusted()]);
    assert_eq!(no_artifact.check_configured().unwrap_err(), ErrorCode::NoTrustedKey);
    let no_feed = KeySet::new(vec![k.standby.trusted(), k.artifact.trusted()]);
    assert_eq!(no_feed.check_configured().unwrap_err(), ErrorCode::NoTrustedKey);
    // a placeholder among real keys is not configured
    let mut with_placeholder = vec![k.feed.trusted(), k.artifact.trusted()];
    with_placeholder.push(TRUSTED_KEYS[2].clone());
    assert_eq!(KeySet::new(with_placeholder).check_configured().unwrap_err(), ErrorCode::NoTrustedKey);
    // an id that does not belong to the key material, a duplicate, garbage key text
    let mut wrong_id = k.feed.trusted();
    wrong_id.id = "0000000000000001".into();
    assert_eq!(KeySet::new(vec![wrong_id, k.artifact.trusted()]).check_configured().unwrap_err(), ErrorCode::NoTrustedKey);
    assert_eq!(KeySet::new(vec![k.feed.trusted(), k.feed.trusted(), k.artifact.trusted()]).check_configured().unwrap_err(), ErrorCode::NoTrustedKey);
    let mut garbage = k.feed.trusted();
    garbage.public_b64 = "bm90IGEga2V5".into();
    assert_eq!(KeySet::new(vec![garbage, k.artifact.trusted()]).check_configured().unwrap_err(), ErrorCode::NoTrustedKey);
    // placeholders never verify anything, whatever id a signature claims
    let ph = KeySet::production();
    let data = feed_bytes();
    let sig = k.feed.sign(&data, &comment("stable.json"));
    assert!(verify_feed(&ph, &Revocations::new(), PROD, &data, &sig, Channel::Stable).is_err());
}

#[test]
fn key_id_hex_matches_the_minisign_print_form() {
    // tauri printed `minisign public key: 1679E4138E7635FE` for bytes FE 35 76 8E 13 E4 79 16
    assert_eq!(key_id_hex(&[0xFE, 0x35, 0x76, 0x8E, 0x13, 0xE4, 0x79, 0x16]), "1679E4138E7635FE");
    assert!(is_key_id("1679E4138E7635FE") && is_key_id("1679e4138e7635fe"));
    assert!(!is_key_id("1679E4138E7635F") && !is_key_id("1679E4138E7635FEE") && !is_key_id("1679E4138E7635FG"));
    let k = TestKey::generate(Role::Feed);
    let (_, id) = decode_public(&k.public_b64()).unwrap();
    assert_eq!(id, k.id());
}

#[test]
fn streaming_artifact_verification() {
    let k = TestKeys::generate();
    let set = k.key_set();
    let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let name = "IntelyIDE_0.1.1_x64.app.tar.gz";
    let sig = k.artifact.sign(&data, &comment(name));
    let p = PreparedSignature::new(FileKind::Artifact, &set, &Revocations::new(), PROD, &sig, name).unwrap();
    let mut s = p.stream().unwrap();
    for chunk in data.chunks(65_536) {
        s.update(chunk);
    }
    let v = s.finalize().unwrap();
    assert_eq!(v.comment.file, name);
    assert_eq!(v.role, Role::Artifact);
    // one byte off
    let mut s = p.stream().unwrap();
    let mut bad = data.clone();
    bad[100_000] ^= 0x80;
    for chunk in bad.chunks(65_536) {
        s.update(chunk);
    }
    assert_eq!(s.finalize().unwrap_err(), ErrorCode::Signature);
    // wrong expected file name is caught after the stream
    let p2 = PreparedSignature::new(FileKind::Artifact, &set, &Revocations::new(), PROD, &sig, "other.tar.gz").unwrap();
    let mut s = p2.stream().unwrap();
    s.update(&data);
    assert_eq!(s.finalize().unwrap_err(), ErrorCode::SignatureComment);
    // role confusion is refused before any byte is hashed
    let fsig = k.feed.sign(&data, &comment(name));
    assert_eq!(PreparedSignature::new(FileKind::Artifact, &set, &Revocations::new(), PROD, &fsig, name).err(), Some(ErrorCode::Signature));
}

#[test]
fn sha256_helpers() {
    assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    let mut s = Sha256Stream::new();
    s.update(b"a");
    s.update(b"bc");
    assert_eq!(s.finish_hex(), sha256_hex(b"abc"));
}

// ----------------------------------------------------------------------------------------------
// golden test against the real CLI

#[test]
fn golden_tauri_cli_signature_and_trusted_comment() {
    use std::process::Command;
    let cli = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../node_modules/.bin/tauri");
    if !cli.exists() {
        eprintln!("SKIP golden_tauri_cli_signature_and_trusted_comment: node_modules/.bin/tauri not found");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("k");
    let mut pw = [0u8; 12];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut pw).unwrap();
    let pw: String = pw.iter().map(|b| format!("{b:02x}")).collect();
    let run = |args: &[&str]| {
        let out = Command::new(&cli)
            .args(args)
            .env_remove("TAURI_SIGNING_PRIVATE_KEY")
            .env_remove("TAURI_SIGNING_PRIVATE_KEY_PATH")
            .env_remove("TAURI_SIGNING_PRIVATE_KEY_PASSWORD")
            .output()
            .expect("run tauri");
        assert!(out.status.success(), "tauri {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    run(&["signer", "generate", "--ci", "-p", &pw, "-w", key.to_str().unwrap()]);
    let pubkey = std::fs::read_to_string(dir.path().join("k.pub")).unwrap();

    let file = dir.path().join("stable.json");
    let data = feed_bytes();
    std::fs::write(&file, &data).unwrap();
    run(&["signer", "sign", "-f", key.to_str().unwrap(), "-p", &pw, "--app-version", "0.1.1", file.to_str().unwrap()]);
    let sig = std::fs::read_to_string(dir.path().join("stable.json.sig")).unwrap();

    // the pinned CLI (2.12.1) writes `timestamp:<n>\tfile:<name>\tversion:<v>` (Appendix F items 1 and 12)
    let text = String::from_utf8(B64.decode(sig.trim()).unwrap()).unwrap();
    assert!(text.contains("\tfile:stable.json\tversion:0.1.1"), "unexpected trusted comment format: {text}");

    for role in [Role::Feed, Role::Artifact] {
        let (_, id) = decode_public(pubkey.trim()).unwrap();
        let set = KeySet::new(vec![TrustedKey { id: id.into(), public_b64: pubkey.trim().to_string().into(), role }]);
        let r = verify_feed(&set, &Revocations::new(), PROD, &data, &sig, Channel::Stable);
        if role == Role::Feed {
            let v = r.expect("real tauri signature must verify in production mode");
            assert_eq!(v.comment.version.as_deref(), Some("0.1.1"));
            v.check_version(&parse_strict("0.1.1").unwrap(), PROD).unwrap();
        } else {
            assert_eq!(r.unwrap_err(), ErrorCode::FeedSignature, "same key in the Artifact role never verifies a feed");
            let a = verify_artifact(&set, &Revocations::new(), PROD, &data, &sig, "stable.json").unwrap();
            assert_eq!(a.role, Role::Artifact);
        }
    }
    // and a byte flip is still caught
    let set = KeySet::new(vec![TrustedKey { id: decode_public(pubkey.trim()).unwrap().1.into(), public_b64: pubkey.trim().to_string().into(), role: Role::Feed }]);
    let mut bad = data.clone();
    bad[3] ^= 1;
    assert!(verify_feed(&set, &Revocations::new(), PROD, &bad, &sig, Channel::Stable).is_err());
}
