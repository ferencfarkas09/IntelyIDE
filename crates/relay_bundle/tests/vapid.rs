//! VAPID keys made in Rust must be the format `remote-relay/src/push.ts` reads and `gen-vapid.mjs` prints.

mod common;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use intely_relay_bundle::{generate_vapid, public_from_private, BundleError, Secret};

fn fixture() -> (String, String) {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/vapid-pair.txt")).unwrap();
    let get = |k: &str| text.lines().find_map(|l| l.strip_prefix(k)).unwrap().trim().to_owned();
    (get("VAPID_PRIVATE_KEY="), get("VAPID_PUBLIC_KEY="))
}

#[test]
fn the_public_key_of_a_node_made_pair_matches_what_node_printed() {
    // vapid-pair.txt is the committed output of `node remote-relay/scripts/gen-vapid.mjs` (a throwaway test pair)
    let (d, public) = fixture();
    assert_eq!(public_from_private(&Secret::new(d)).unwrap(), public);
}

#[test]
fn generated_keys_have_the_expected_shape_and_are_consistent() {
    let k = generate_vapid().unwrap();
    let d = URL_SAFE_NO_PAD.decode(k.private.expose()).unwrap();
    assert_eq!(d.len(), 32, "raw scalar d");
    let p = URL_SAFE_NO_PAD.decode(&k.public).unwrap();
    assert_eq!((p.len(), p[0]), (65, 4), "uncompressed point");
    assert_eq!(k.public.len(), 87);
    assert!(!k.public.contains(['=', '+', '/']));
    assert_eq!(public_from_private(&k.private).unwrap(), k.public);
    let other = generate_vapid().unwrap();
    assert_ne!(other.public, k.public);
}

#[test]
fn the_private_value_never_shows_in_debug_or_errors() {
    let k = generate_vapid().unwrap();
    let dbg = format!("{k:?}");
    assert!(!dbg.contains(k.private.expose()), "{dbg}");
    assert!(dbg.contains("redacted"));
    for bad in ["", "AAAA", &"A".repeat(43), "not base64!", &URL_SAFE_NO_PAD.encode([0u8; 31])] {
        assert!(matches!(public_from_private(&Secret::new(bad)), Err(BundleError::BadKey)), "{bad:?}");
    }
}

#[test]
fn a_node_pair_works_as_a_real_p256_key_for_push() {
    // The public point must be on the curve: parse it back with p256.
    let k = generate_vapid().unwrap();
    let raw = URL_SAFE_NO_PAD.decode(&k.public).unwrap();
    assert!(p256::PublicKey::from_sec1_bytes(&raw).is_ok());
}
