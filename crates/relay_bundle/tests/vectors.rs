//! The committed cross-implementation vectors (`remote-relay/tests/fixtures/bundle-v2/vectors.json`, made by `bundle-lib.mjs`):
//! every case must give the same verdict here, and the Rust signer must reproduce the `valid` bundle.json byte for byte.

mod common;

use std::collections::BTreeMap;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use common::*;
use intely_relay_bundle::manifest::{files_match, signed_message, verify_manifest, Json, VerifyOpts};
use intely_relay_bundle::{fingerprint, public_key_of, stage_and_sign};

fn case_field<'a>(case: &'a Json, key: &str) -> Option<&'a Json> {
    case.get(key).filter(|j| !matches!(j, Json::Null))
}

#[test]
fn every_vector_case_gives_the_expected_verdict() {
    let v = vectors();
    let site = site_files(&v);
    let Some(Json::Arr(cases)) = v.get("cases") else { panic!("cases") };
    assert!(cases.len() >= 70, "expected the full vector set, got {}", cases.len());
    let mut failures = Vec::new();
    for case in cases {
        let name = jstr(case, "name");
        let bundle = case.get("bundle").expect("bundle");
        let pin = case_field(case, "pin").and_then(Json::as_str);
        let opts = VerifyOpts {
            pin,
            min_seq: case_field(case, "minSeq").and_then(Json::as_u64),
            allow_v1: matches!(case.get("allowV1"), Some(Json::Bool(true))),
        };
        let expect = case.get("expect").unwrap();
        let expect_ok = matches!(expect.get("ok"), Some(Json::Bool(true)));
        let mut result = verify_manifest(bundle, &opts).map(|v| (v.hash.clone(), v.seq, v.files)).map_err(|f| f.code.as_str().to_owned());
        if let (Ok((_, _, files)), Some(Json::Obj(over))) = (&result, case.get("filesOverride")) {
            // The served set is the genuine site with the override applied (null removes a file).
            let mut served: BTreeMap<String, Vec<u8>> = site.clone();
            for (p, b) in over {
                match b {
                    Json::Null => {
                        served.remove(p);
                    }
                    other => {
                        served.insert(p.clone(), STANDARD.decode(other.as_str().unwrap()).unwrap());
                    }
                }
            }
            if !files_match(files, &served) {
                result = Err("hashMismatch".to_owned());
            }
        }
        let verdict_ok = match (&result, expect_ok) {
            (Ok((hash, seq, _)), true) => {
                let hash_ok = expect.get("hash").and_then(Json::as_str).is_none_or(|h| h == hash);
                let seq_ok = match expect.get("seq") {
                    Some(Json::Null) => seq.is_none(),
                    Some(j) => j.as_u64() == *seq,
                    None => true,
                };
                hash_ok && seq_ok
            }
            (Err(code), false) => Some(code.as_str()) == expect.get("code").and_then(Json::as_str),
            _ => false,
        };
        if !verdict_ok {
            failures.push(format!("{name}: got {:?}, expected {}", result.as_ref().map(|r| (&r.0, r.1)), serde_json::to_string(expect).unwrap()));
        }
    }
    assert!(failures.is_empty(), "{} vector cases differ:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn the_signed_message_matches_the_vector_bytes() {
    let v = vectors();
    let valid = v.get("valid").unwrap();
    let msg = signed_message(&jstr(valid, "manifestSha256"), v.get("seq").and_then(Json::as_u64).unwrap());
    assert_eq!(hex::encode(msg), jstr(valid, "signedMessageHex"));
}

#[test]
fn fingerprints_match_the_vectors() {
    let v = vectors();
    for k in ["A", "B"] {
        let key = v.get("keys").unwrap().get(k).unwrap();
        assert_eq!(fingerprint(&jstr(key, "pub")), jstr(key, "fingerprint"));
    }
    assert_eq!(fingerprint("not a key"), "");
    assert_eq!(fingerprint(&"A".repeat(43)).len(), 19, "four groups of four with spaces");
}

#[test]
fn the_rust_signer_reproduces_the_valid_vector_byte_for_byte() {
    let v = vectors();
    let site = site_files(&v);
    let tmp = tempfile::tempdir().unwrap();
    let dist = tmp.path().join("dist");
    write_site(&dist, &site);
    let key = vector_key(&v, "A");
    assert_eq!(public_key_of(&key).unwrap(), vector_pub(&v, "A"));

    let push: serde_json::Value = serde_json::from_slice(&site["push-config.json"]).unwrap();
    let vapid = push["vapidPublicKey"].as_str().unwrap().to_owned();
    let seq = v.get("seq").and_then(Json::as_u64).unwrap();
    let built = v.get("builtAt").and_then(Json::as_u64).unwrap();
    let staging = tmp.path().join("state/relay-deploy/w/dist");
    // prev + 1 = the vector's seq, `now` = its builtAt.
    let staged = stage_and_sign(&dist, &staging, &key, Some(&vapid), Some(seq - 1), built).unwrap();

    let expected = jstr(v.get("valid").unwrap(), "bundleJson");
    let actual = std::fs::read_to_string(staging.join("bundle.json")).unwrap();
    assert_eq!(actual, expected, "bundle.json must be byte-identical to the node reference output");
    assert_eq!(staged.hash, jstr(v.get("valid").unwrap(), "manifestSha256"));
    assert_eq!(staged.seq, seq);
    assert_eq!(staged.pubkey, vector_pub(&v, "A"));
    assert_eq!(staged.files, site.len());
    for (p, b) in &site {
        assert_eq!(&std::fs::read(staging.join(p)).unwrap(), b, "staged copy of {p}");
    }
}
