//! Static guard: the patch transfer between this Mac and a server is a person's click, never an agent's. Only the transfer module and
//! the Tauri command module (which the UI calls) may name its entry points; the agent host, the permission broker, the MCP server
//! and the sidecar never do.

use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

fn files(dir: &Path, exts: &[&str], out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            if !matches!(name.as_str(), "target" | "node_modules" | ".git" | "gen" | "dist" | "build") {
                files(&p, exts, out);
            }
        } else if p.extension().is_some_and(|x| exts.iter().any(|w| x == *w)) {
            out.push(p);
        }
    }
}

/// Built from pieces so this file does not contain the needles it searches for.
fn needle(parts: &[&str]) -> String {
    parts.concat()
}

#[test]
fn only_the_transfer_module_and_the_ui_commands_name_the_transfer_entry_points() {
    let needles = [needle(&["bring", "_changes("]), needle(&["send", "_changes("]), needle(&["apply", "_local("]), needle(&["send", "_patch("]), needle(&["servers", "::transfer"]), needle(&["servers_", "transfer"])];
    let allowed = ["crates/servers/src/transfer.rs", "crates/servers/src/transfer_tests.rs", "src-tauri/src/modules/servers.rs", "src-tauri/src/lib.rs"];
    let root = repo_root();
    let mut all = Vec::new();
    for d in ["crates", "src-tauri/src", "sidecar", "packages"] {
        files(&root.join(d), &["rs", "ts", "tsx", "js", "mjs"], &mut all);
    }
    let mut seen_in_commands = false;
    for f in all {
        let rel = f.strip_prefix(&root).unwrap().to_string_lossy().into_owned();
        if rel.ends_with("transfer_guard.rs") {
            continue;
        }
        let text = fs::read_to_string(&f).unwrap_or_default();
        for n in &needles {
            if text.contains(n.as_str()) {
                assert!(allowed.contains(&rel.as_str()), "{rel} names the patch transfer ({n}); only the UI commands may");
                seen_in_commands |= rel == "src-tauri/src/modules/servers.rs";
            }
        }
    }
    assert!(seen_in_commands, "the guard no longer finds the UI commands: update it with the rename");
}

#[test]
fn no_agent_side_crate_depends_on_the_transfer_by_manifest() {
    // the agent host uses the servers crate for runs (sidecar command, origin check); it must not reach the transfer module
    let root = repo_root();
    let mut all = Vec::new();
    for d in ["agent_host", "agent_core", "agent_gate", "mcp"] {
        files(&root.join("crates").join(d), &["rs"], &mut all);
    }
    let n = needle(&["transfer", "::"]);
    for f in all {
        let text = fs::read_to_string(&f).unwrap_or_default();
        for l in text.lines().filter(|l| l.contains("intely_servers")) {
            assert!(!l.contains(&n), "{}: {l}", f.display());
        }
    }
}
