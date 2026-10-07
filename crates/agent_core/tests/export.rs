//! `packages/protocol` must be what the generator produces now (CI: regenerate and `git diff --exit-code`).
#![cfg(feature = "specta")]

use std::path::PathBuf;

use intely_agent_core::export::{fixture_files, typescript_files};

fn protocol_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol")
}

#[test]
fn generated_typescript_is_current() {
    for (stem, text) in typescript_files() {
        let path = protocol_dir().join(format!("src/generated/{stem}.ts"));
        assert_eq!(std::fs::read_to_string(&path).unwrap_or_default(), text, "{} is stale: run `pnpm protocol:gen`", path.display());
    }
}

#[test]
fn fixtures_are_current() {
    for (name, text) in fixture_files() {
        let path = protocol_dir().join("fixtures").join(&name);
        assert_eq!(std::fs::read_to_string(&path).unwrap_or_default(), text, "{} is stale: run `pnpm protocol:gen`", path.display());
    }
}

#[test]
fn every_generated_file_only_imports_what_exists() {
    for (stem, text) in typescript_files() {
        for line in text.lines().filter(|l| l.starts_with("import type")) {
            let from = line.split('"').nth(1).unwrap_or_default().trim_start_matches("./");
            assert!(typescript_files().contains_key(from), "{stem}.ts imports from unknown module {from}");
        }
    }
}
