//! The shared CLAUDE.md cases (`fixtures/claude-notes/cases.json`) against the Project notes mirror. The sidecar checks the
//! same file (`sidecar/test/project-notes-fixture.test.ts`), so the two cannot drift apart unnoticed.

use std::path::{Path, PathBuf};

use intely_files::claude_notes::plan;
use serde_json::{json, Value};

fn content(s: &Value) -> String {
    if let Some(t) = s["text"].as_str() {
        return t.to_owned();
    }
    let unit = s["repeat"].as_str().unwrap_or("");
    format!("{}{}", unit.repeat(s["count"].as_u64().unwrap_or(0) as usize), s["then"].as_str().unwrap_or(""))
}

fn write(dir: &Path, rel: &str, s: &Value) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, content(s)).unwrap();
}

#[test]
fn the_shared_cases_give_the_same_files_as_the_sidecar() {
    let text = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/claude-notes/cases.json")).unwrap();
    let cases: Value = serde_json::from_str(&text).unwrap();
    for c in cases["cases"].as_array().unwrap() {
        let temps: Vec<tempfile::TempDir> = c["dirs"].as_array().unwrap().iter().map(|_| tempfile::tempdir().unwrap()).collect();
        for (files, t) in c["dirs"].as_array().unwrap().iter().zip(&temps) {
            for (rel, s) in files.as_object().unwrap() {
                write(t.path(), rel, s);
            }
        }
        let config = tempfile::tempdir().unwrap();
        if !c["user"].is_null() {
            write(config.path(), "CLAUDE.md", &c["user"]);
        }
        let order: Vec<usize> = c["runDirs"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect();
        let run_dirs: Vec<PathBuf> = order.iter().map(|i| temps[*i].path().to_path_buf()).collect();
        let p = plan(&run_dirs, Some(config.path()));
        let got: Vec<Value> = p
            .files
            .iter()
            .map(|f| json!({ "scope": f.scope, "dir": f.dir_index.map(|i| order[i]), "rel": f.rel, "length": f.length, "shortened": f.shortened }))
            .collect();
        assert_eq!(Value::Array(got), c["expect"], "{}", c["name"]);
    }
}
