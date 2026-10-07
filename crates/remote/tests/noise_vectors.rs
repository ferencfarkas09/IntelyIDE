//! Cross-implementation vectors for the phone's TypeScript Noise (remote-web/src/noise). Fixed keys and fixed ephemerals make `snow`
//! deterministic; `remote-web/test/vectors/noise.json` is what the TS side must reproduce byte for byte. This test fails when the
//! committed file and the Rust side drift apart. Regenerate with `INTELY_WRITE_VECTORS=1 cargo test -p intely-remote --test noise_vectors`.

use std::path::PathBuf;

use intely_remote::noise::{pair_token_from_otp, psk_from_otp, PROLOGUE, SUITE_IK, SUITE_IKPSK2};
use intely_remote::pairing::{manual_code, parse_manual_code};
use intely_remote::util::{b64u, sha256, sha256_hex};
use serde_json::{json, Value};
use snow::{Builder, TransportState};

fn bytes(seed: u8) -> [u8; 32] {
    let mut k = [0u8; 32];
    for (i, b) in k.iter_mut().enumerate() {
        *b = seed.wrapping_mul(31).wrapping_add(i as u8).wrapping_add(7);
    }
    k
}

/// The X25519 public key of a private key. `snow` has no such call, so a throwaway IK handshake lets a responder report the
/// initiator's static key.
fn public(priv_key: &[u8; 32]) -> [u8; 32] {
    let params: snow::params::NoiseParams = SUITE_IK.parse().unwrap();
    let resp = Builder::new(params.clone()).generate_keypair().unwrap();
    let mut i = Builder::new(params.clone()).local_private_key(priv_key).unwrap().remote_public_key(&resp.public).unwrap().build_initiator().unwrap();
    let mut r = Builder::new(params).local_private_key(&resp.private).unwrap().build_responder().unwrap();
    let mut buf = vec![0u8; 512];
    let n = i.write_message(b"", &mut buf).unwrap();
    let mut out = vec![0u8; 512];
    r.read_message(&buf[..n], &mut out).unwrap();
    r.get_remote_static().unwrap().try_into().unwrap()
}

fn hexs(b: &[u8]) -> String {
    hex::encode(b)
}

fn sas(handshake_hash: &[u8]) -> String {
    let mut m = b"intely-remote/sas/v1".to_vec();
    m.extend_from_slice(handshake_hash);
    let h = sha256(&m);
    format!("{:06}", u32::from_be_bytes([h[0], h[1], h[2], h[3]]) % 1_000_000)
}

struct Run {
    json: Value,
}

fn handshake(suite: &str, psk: Option<[u8; 32]>) -> Run {
    let (mac_priv, phone_priv, mac_e, phone_e) = (bytes(1), bytes(2), bytes(3), bytes(4));
    let (mac_pub, phone_pub) = (public(&mac_priv), public(&phone_priv));
    let mut i = Builder::new(suite.parse().unwrap()).local_private_key(&phone_priv).unwrap().remote_public_key(&mac_pub).unwrap().prologue(PROLOGUE).unwrap().fixed_ephemeral_key_for_testing_only(&phone_e);
    let mut r = Builder::new(suite.parse().unwrap()).local_private_key(&mac_priv).unwrap().prologue(PROLOGUE).unwrap().fixed_ephemeral_key_for_testing_only(&mac_e);
    if let Some(p) = psk.as_ref() {
        i = i.psk(2, p).unwrap();
        r = r.psk(2, p).unwrap();
    }
    let mut i = i.build_initiator().unwrap();
    let mut r = r.build_responder().unwrap();
    let mut buf = vec![0u8; 65535];
    let n = i.write_message(b"", &mut buf).unwrap();
    let msg1 = buf[..n].to_vec();
    let mut rb = vec![0u8; 65535];
    r.read_message(&msg1, &mut rb).unwrap();
    let n = r.write_message(b"", &mut buf).unwrap();
    let msg2 = buf[..n].to_vec();
    i.read_message(&msg2, &mut rb).unwrap();
    assert_eq!(i.get_handshake_hash(), r.get_handshake_hash());
    let hh = i.get_handshake_hash().to_vec();
    let mut ti: TransportState = i.into_transport_mode().unwrap();
    let mut tr: TransportState = r.into_transport_mode().unwrap();
    let plain = ["", "hello mac", "{\"v\":1,\"t\":\"ping\"}"];
    let mut i2r = vec![];
    let mut r2i = vec![];
    for p in plain {
        let n = ti.write_message(p.as_bytes(), &mut buf).unwrap();
        let ct = buf[..n].to_vec();
        let n2 = tr.read_message(&ct, &mut rb).unwrap();
        assert_eq!(&rb[..n2], p.as_bytes());
        i2r.push(json!({"pt": hexs(p.as_bytes()), "ct": hexs(&ct)}));
    }
    for p in ["welcome", "{\"v\":1,\"t\":\"pong\"}"] {
        let n = tr.write_message(p.as_bytes(), &mut buf).unwrap();
        let ct = buf[..n].to_vec();
        ti.read_message(&ct, &mut rb).unwrap();
        r2i.push(json!({"pt": hexs(p.as_bytes()), "ct": hexs(&ct)}));
    }
    // rekey: 65537 messages initiator -> responder; the last one is encrypted under the rekeyed key
    let mut last = vec![];
    let mut sent = 3u64; // the three above
    while sent < 65_537 {
        let n = ti.write_message(b"x", &mut buf).unwrap();
        sent += 1;
        if sent % 65_536 == 0 {
            ti.rekey_outgoing();
        }
        last = buf[..n].to_vec();
    }
    let json = json!({
        "suite": suite,
        "prologue": hexs(PROLOGUE),
        "macPriv": hexs(&mac_priv), "macPub": hexs(&mac_pub),
        "phonePriv": hexs(&phone_priv), "phonePub": hexs(&phone_pub),
        "macEphemeral": hexs(&mac_e), "phoneEphemeral": hexs(&phone_e),
        "psk": psk.map(|p| hexs(&p)),
        "msg1": hexs(&msg1), "msg2": hexs(&msg2),
        "handshakeHash": hexs(&hh), "sas": sas(&hh),
        "initiatorToResponder": i2r, "responderToInitiator": r2i,
        "rekey": {"messages": 65_537, "plaintext": hexs(b"x"), "lastCiphertext": hexs(&last)},
    });
    Run { json }
}

fn vectors() -> Value {
    let otp: [u8; 16] = std::array::from_fn(|i| (i as u8).wrapping_mul(17).wrapping_add(3));
    let mac_pub = public(&bytes(1));
    json!({
        "about": "Generated by crates/remote/tests/noise_vectors.rs with snow fixed ephemerals. Do not edit.",
        "ik": handshake(SUITE_IK, None).json,
        "ikpsk2": handshake(SUITE_IKPSK2, Some(psk_from_otp(&otp))).json,
        "pairing": {
            "otp": hexs(&otp),
            "psk": hexs(&psk_from_otp(&otp)),
            "pairToken": pair_token_from_otp(&otp),
            "relayTokenHash": sha256_hex(pair_token_from_otp(&otp).as_bytes()),
            "manualCode": manual_code(&otp),
            "qrFragment": format!("#p=127.0.0.1:8787,{},{},{}", "AAAAAAAAAAAAAAAAAAAAAA", b64u(&mac_pub), b64u(&otp)),
            "macPub": hexs(&mac_pub),
        },
    })
}

#[test]
fn the_committed_vectors_match_what_snow_produces() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../remote-web/test/vectors/noise.json");
    let fresh = serde_json::to_string_pretty(&vectors()).unwrap() + "\n";
    if std::env::var("INTELY_WRITE_VECTORS").is_ok() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &fresh).unwrap();
    }
    let committed = std::fs::read_to_string(&path).expect("run with INTELY_WRITE_VECTORS=1 once to create remote-web/test/vectors/noise.json");
    // compared as parsed values: key order depends on serde_json's `preserve_order` feature, which another crate of the
    // workspace may switch on through feature unification; the committed bytes are not what the wire carries
    let committed: Value = serde_json::from_str(&committed).expect("noise.json is valid JSON");
    let fresh: Value = serde_json::from_str(&fresh).unwrap();
    assert_eq!(committed, fresh, "vector file is stale: regenerate with INTELY_WRITE_VECTORS=1");
    // the manual code round-trips
    let otp: [u8; 16] = std::array::from_fn(|i| (i as u8).wrapping_mul(17).wrapping_add(3));
    assert_eq!(parse_manual_code(&manual_code(&otp)), Some(otp));
}
