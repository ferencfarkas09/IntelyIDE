//! Test kit shared by the integration tests ((design notes: updater-spec) 10.1). No credential, no network.
//! Each task owns its helper file; U1 created the stubs.
#![allow(dead_code)]

pub mod fixture_app;
pub mod fixture_bin;
pub mod keys;
pub mod server;
pub mod tarball;

use std::path::PathBuf;

/// `crates/updater/tests/fixtures/<name>`
pub fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

pub fn fixture_text(name: &str) -> String {
    std::fs::read_to_string(fixture(name)).unwrap_or_else(|e| panic!("fixture {name}: {e}"))
}
