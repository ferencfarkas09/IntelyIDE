//! Static guards of spec 4.12.3 (threat T16): tests and agents never reach a real Cloudflare account. The primary guard is the
//! `LiveGesture` (only the Tauri command module can mint one); these tests make sure nobody works around it.

use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            if !matches!(name.as_str(), "target" | "node_modules" | ".git" | "gen") {
                rust_files(&p, out);
            }
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

fn all_rust() -> Vec<PathBuf> {
    let root = repo_root();
    let mut v = Vec::new();
    rust_files(&root.join("crates"), &mut v);
    rust_files(&root.join("src-tauri"), &mut v);
    v
}

/// Built from pieces so this file does not contain the needles it searches for.
fn needle(parts: &[&str]) -> String {
    parts.concat()
}

#[test]
fn only_the_tauri_command_module_mints_a_live_gesture() {
    let n = needle(&["mint_in_tauri", "_command("]);
    let allowed = ["crates/relay_deploy/src/wrangler.rs", "src-tauri/src/modules/relay_cloud.rs"];
    let root = repo_root();
    for f in all_rust() {
        let rel = f.strip_prefix(&root).unwrap().to_string_lossy().into_owned();
        let text = fs::read_to_string(&f).unwrap_or_default();
        if text.contains(&n) {
            assert!(allowed.contains(&rel.as_str()), "{rel} mints a LiveGesture; only the relay_cloud command module may");
        }
    }
    // The definition itself is where it is expected.
    let def = fs::read_to_string(root.join("crates/relay_deploy/src/wrangler.rs")).unwrap();
    assert!(def.contains(&format!("fn {n}")));
}

#[test]
fn no_test_file_names_the_kits_real_wrangler() {
    let n = needle(&["remote-relay/node_modules/", ".bin/wrangler"]);
    let root = repo_root();
    let mut hits = Vec::new();
    for f in all_rust() {
        let rel = f.strip_prefix(&root).unwrap().to_string_lossy().into_owned();
        let is_test_file = rel.contains("/tests/") || rel.ends_with("_test.rs") || rel.ends_with("tests.rs");
        let text = fs::read_to_string(&f).unwrap_or_default();
        if (is_test_file || text.contains("#[cfg(test)]")) && text.contains(&n) {
            hits.push(rel);
        }
    }
    assert!(hits.is_empty(), "these files reference the real wrangler: {hits:?}");
}

#[test]
fn the_process_spawner_is_not_constructed_outside_its_module() {
    let root = repo_root();
    let n = needle(&["ProcessSpawner", "::new("]);
    for f in all_rust() {
        let rel = f.strip_prefix(&root).unwrap().to_string_lossy().into_owned();
        if rel.starts_with("crates/relay_deploy/src/wrangler.rs") || rel.starts_with("crates/relay_deploy/tests/static_guard.rs") {
            continue;
        }
        let text = fs::read_to_string(&f).unwrap_or_default();
        if text.contains(&n) {
            assert_eq!(rel, "src-tauri/src/modules/relay_cloud.rs", "{rel} builds a real process spawner");
        }
    }
}
