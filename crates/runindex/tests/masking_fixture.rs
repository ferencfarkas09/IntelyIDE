//! The shared masking cases (`fixtures/masking/cases.json`) against the masker the app puts error text through before it
//! reaches a prompt (`intely_runindex::doc::scrub`). The interface's fallback masker reads the same file
//! (`ui/src/ipc/mock/vibe.test.ts`), so the two stay in step.

use std::path::Path;

use intely_runindex::doc::scrub;
use serde_json::Value;

fn cases() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/masking/cases.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn join(v: &Value) -> String {
    v.as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect()
}

#[test]
fn every_secret_shape_of_the_shared_cases_is_masked() {
    let c = cases();
    let mut failed = Vec::new();
    for case in c["masked"].as_array().unwrap() {
        let input = join(&case["parts"]);
        let secret = join(&case["secret"]);
        let out = scrub(&input);
        if out.contains(&secret) {
            failed.push(format!("{}: {out:?}", case["name"].as_str().unwrap()));
        }
        assert_eq!(scrub(&out), out, "masking is idempotent: {}", case["name"]);
    }
    assert!(failed.is_empty(), "secrets left in:\n{}", failed.join("\n"));
}

#[test]
fn ordinary_text_of_the_shared_cases_is_left_alone() {
    for plain in cases()["plain"].as_array().unwrap() {
        let text = plain.as_str().unwrap();
        assert_eq!(scrub(text), text);
    }
}
