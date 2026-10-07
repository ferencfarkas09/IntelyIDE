//! Environment variable NAMES across repositories (#19): what the example files declare and what the code references
//! (`process.env.X`, `import.meta.env.X`). Values are never read: only example-style files (`.env.example`,
//! `.env.production.sample`, ...) are opened, and for those only the text before `=` is kept. A real `.env`, `.env.local`
//! or `.env.production` is listed as present and refused: [`read_names`] returns an error for it, whatever the caller asks.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::types::{EnvFile, EnvReport, MissingVar, NameRow, Presence, RepoEnv};

const SKIP_DIRS: [&str; 16] = [
    "node_modules", ".git", "dist", "build", "out", "target", "coverage", ".next", ".expo", "android", "ios", "vendor", ".cache", ".turbo", ".history", "web-build",
];
const SOURCE_EXT: [&str; 8] = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte"];
const MAX_FILES: usize = 4000;
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_DEPTH: usize = 9;
const MAX_EXAMPLE_BYTES: u64 = 256 * 1024;
const MAX_MISSING: usize = 200;
const MAX_ROWS: usize = 400;
/// Provided by the runtime or the bundler, not by a `.env` file.
const BUILTIN: [&str; 14] = ["NODE_ENV", "MODE", "DEV", "PROD", "SSR", "BASE_URL", "CI", "HOME", "PATH", "PWD", "USER", "TZ", "TERM", "LANG"];
const EXAMPLE_SUFFIXES: [&str; 5] = [".example", ".sample", ".template", ".dist", ".defaults"];

fn base(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// `.env`, `.env.local`, `.env.production`, `prod.env`: a file that holds real values.
pub fn is_real_env(path: &str) -> bool {
    let b = base(path).to_ascii_lowercase();
    (b == ".env" || b.starts_with(".env.") || b.ends_with(".env")) && !is_example(&b)
}

/// `.env.example`, `.env.production.sample`: a file that documents names.
pub fn is_example(base_name: &str) -> bool {
    let b = base_name.to_ascii_lowercase();
    (b.starts_with(".env") || b.ends_with(".env") || b.contains(".env.")) && EXAMPLE_SUFFIXES.iter().any(|s| b.ends_with(s))
}

/// `.env.production.example` -> `production`; `.env.example` -> `default`.
fn environment(base_name: &str) -> String {
    let b = base_name.to_ascii_lowercase();
    let mut core = b.as_str();
    for s in EXAMPLE_SUFFIXES {
        core = core.strip_suffix(s).unwrap_or(core);
    }
    match core.strip_prefix(".env.") {
        Some(env) if !env.is_empty() => env.to_owned(),
        _ => "default".to_owned(),
    }
}

fn valid_name(n: &str) -> bool {
    let mut c = n.chars();
    c.next().is_some_and(|f| f.is_ascii_alphabetic() || f == '_') && c.all(|x| x.is_ascii_alphanumeric() || x == '_')
}

/// The variable names an example file declares. Refuses (`Err`) any file that is not example-style, so a real `.env`
/// can never be opened through this function. The value after `=` is dropped line by line and never stored.
pub fn read_names(path: &Path) -> Result<Vec<String>, String> {
    let b = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !is_example(b) {
        return Err(format!("{b}: only example files are read; a real env file is never opened"));
    }
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_EXAMPLE_BYTES {
        return Err(format!("{b}: too large"));
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut out = BTreeSet::new();
    for line in text.lines() {
        let l = line.trim_start();
        if l.starts_with('#') {
            continue;
        }
        let l = l.strip_prefix("export ").unwrap_or(l);
        if let Some((key, _value)) = l.split_once('=') {
            let key = key.trim();
            if valid_name(key) {
                out.insert(key.to_owned());
            }
        }
    }
    Ok(out.into_iter().collect())
}

fn env_file_list(repo: &Path) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let Ok(dir) = fs::read_dir(repo) else { return out };
    for e in dir.flatten() {
        let Some(name) = e.file_name().to_str().map(str::to_owned) else { continue };
        if !e.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        if is_example(&name) {
            out.push((name, true));
        } else if is_real_env(&name) {
            out.push((name, false));
        }
    }
    out.sort();
    out
}

/// `process.env.NAME`, `process.env["NAME"]`, `import.meta.env.NAME` in one source text.
pub fn referenced_names(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for marker in ["process.env", "import.meta.env"] {
        for (i, _) in text.match_indices(marker) {
            let rest = &text[i + marker.len()..];
            let name: String = if let Some(r) = rest.strip_prefix('.') {
                r.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect()
            } else if let Some(r) = rest.strip_prefix("[\"").or_else(|| rest.strip_prefix("['")) {
                r.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect()
            } else {
                continue;
            };
            if valid_name(&name) && name.chars().next().is_some_and(|c| c.is_ascii_uppercase() || c == '_') && !BUILTIN.contains(&name.as_str()) {
                out.insert(name);
            }
        }
    }
    out
}

struct Scan {
    names: BTreeMap<String, Vec<String>>,
    files: usize,
    truncated: bool,
}

fn walk(root: &Path, dir: &Path, depth: usize, scan: &mut Scan) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        if scan.files >= MAX_FILES {
            scan.truncated = true;
            return;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(ft) = e.file_type() else { continue };
        let path: PathBuf = e.path();
        if ft.is_dir() {
            if depth < MAX_DEPTH && !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                walk(root, &path, depth + 1, scan);
            }
        } else if ft.is_file() && path.extension().and_then(|x| x.to_str()).is_some_and(|x| SOURCE_EXT.contains(&x)) && !name.ends_with(".min.js") {
            if e.metadata().is_ok_and(|m| m.len() > MAX_FILE_BYTES) {
                continue;
            }
            scan.files += 1;
            if let Ok(text) = fs::read_to_string(&path) {
                let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned();
                for n in referenced_names(&text) {
                    let used = scan.names.entry(n).or_default();
                    if used.len() < 3 {
                        used.push(rel.clone());
                    }
                }
            }
        }
    }
}

struct RepoScan {
    env: RepoEnv,
    declared: BTreeSet<String>,
    referenced: BTreeSet<String>,
}

fn scan_repo(repo_id: &str, repo: &Path) -> RepoScan {
    let mut files = Vec::new();
    let mut declared = BTreeSet::new();
    for (name, example) in env_file_list(repo) {
        if example {
            let names = read_names(&repo.join(&name)).unwrap_or_default();
            declared.extend(names.iter().cloned());
            files.push(EnvFile { environment: environment(&name), path: name, kind: "example".into(), names });
        } else {
            // Existence only: the content of a real env file is refused.
            files.push(EnvFile { environment: environment(&name), path: name, kind: "real".into(), names: Vec::new() });
        }
    }
    let mut scan = Scan { names: BTreeMap::new(), files: 0, truncated: false };
    walk(repo, repo, 0, &mut scan);
    let has_example = files.iter().any(|f| f.kind == "example");
    let missing_total = scan.names.keys().filter(|n| !declared.contains(*n)).count() as u32;
    let missing = scan
        .names
        .iter()
        .filter(|(n, _)| !declared.contains(*n))
        .take(MAX_MISSING)
        .map(|(n, used)| MissingVar { name: n.clone(), used_in: used.clone() })
        .collect();
    let unused = declared.iter().filter(|n| !scan.names.contains_key(*n)).cloned().collect();
    let referenced: BTreeSet<String> = scan.names.keys().cloned().collect();
    RepoScan {
        env: RepoEnv {
            repo_id: repo_id.to_owned(),
            files,
            declared: declared.len() as u32,
            referenced: referenced.len() as u32,
            missing,
            missing_total,
            unused,
            has_example,
            scanned_files: scan.files as u32,
            truncated: scan.truncated,
        },
        declared,
        referenced,
    }
}

/// One repository: its example files, what the code references and what is missing from the examples.
pub fn analyze_repo(repo_id: &str, repo: &Path) -> RepoEnv {
    scan_repo(repo_id, repo).env
}

/// Every repository plus the cross-repo name matrix (names that differ between repos first).
pub fn analyze(repos: &[(String, PathBuf)]) -> EnvReport {
    let per: Vec<RepoScan> = repos.iter().map(|(id, path)| scan_repo(id, path)).collect();
    let all: BTreeSet<&String> = per.iter().flat_map(|s| s.declared.iter().chain(s.referenced.iter())).collect();
    let mut rows: Vec<NameRow> = all
        .into_iter()
        .map(|n| NameRow {
            name: n.clone(),
            repos: per.iter().map(|s| Presence { repo_id: s.env.repo_id.clone(), declared: s.declared.contains(n), referenced: s.referenced.contains(n) }).collect(),
        })
        .collect();
    let uniform = |r: &NameRow| r.repos.iter().all(|p| p.declared == r.repos[0].declared && p.referenced == r.repos[0].referenced);
    rows.sort_by(|a, b| uniform(a).cmp(&uniform(b)).then_with(|| a.name.cmp(&b.name)));
    rows.truncate(MAX_ROWS);
    EnvReport { repos: per.into_iter().map(|s| s.env).collect(), names: rows }
}
