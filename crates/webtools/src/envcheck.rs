//! Compares the KEY NAMES of `.env` files with those of `.env.example`, and checks that the real `.env*` files are git-ignored.
//! The file is read whole (at most 256 KB) into a string that is dropped when its names have been taken; the parser returns names only,
//! so no value reaches a struct, an error message, a log or a prompt.
//! The `.gitignore` check is an approximation of Git's rules (the caller adds which files Git actually tracks).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::Serialize;

use crate::walk::walk;
use crate::{safefs, WebError};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvFile {
    /// Relative to the repository.
    pub path: String,
    /// `.env.example` and its relatives: meant to be committed.
    pub example: bool,
    /// A real env file that no `.gitignore` rule seems to cover.
    pub unprotected: bool,
    /// Git tracks this real env file (it is in the history).
    pub tracked: bool,
    pub keys: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingKey {
    pub key: String,
    /// The example file that lists it.
    pub example: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvDir {
    /// "" for the repository root.
    pub dir: String,
    pub files: Vec<EnvFile>,
    /// Listed in an example file, in none of the real files.
    pub missing: Vec<MissingKey>,
    /// In a real file, in no example file (a new variable nobody documented).
    pub undocumented: Vec<String>,
    pub no_example: bool,
    pub no_env: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvReport {
    pub dirs: Vec<EnvDir>,
    pub skipped: Vec<String>,
    /// Something was left out to stay within a limit (folders, env files or ignore rules).
    pub capped: bool,
}

const ENV_CAP: u64 = 256 * 1024;
/// Limits: env files per folder, env folders, and ignore rules in all (a hostile `.gitignore` of millions of lines must not make every file test slow).
const MAX_ENV_FILES: usize = 40;
const MAX_ENV_DIRS: usize = 40;
const MAX_PATTERNS: usize = 10_000;
const EXAMPLE_MARKS: &[&str] = &["example", "sample", "template", "dist", "defaults"];

fn is_env_name(name: &str) -> bool {
    name == ".env" || (name.starts_with(".env.") && name.len() > 5)
}

fn is_example(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    EXAMPLE_MARKS.iter().any(|m| lower.ends_with(&format!(".{m}")) || lower.ends_with(&format!("-{m}")))
}

/// The variable names of an env file. A line is `NAME=value` or `export NAME=value`; everything after `=` is dropped unread.
pub(crate) fn key_names(text: &str) -> Vec<String> {
    let mut out = BTreeSet::new();
    for line in text.lines().take(20_000) {
        let t = line.trim_start();
        if t.starts_with('#') {
            continue;
        }
        let t = t.strip_prefix("export ").map_or(t, str::trim_start);
        let Some((name, _)) = t.split_once('=') else { continue };
        let name = name.trim_end();
        let ok = !name.is_empty() && name.len() <= 128 && name.bytes().next().is_some_and(|b| b.is_ascii_alphabetic() || b == b'_') && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.');
        if ok && out.len() < 2000 {
            out.insert(name.to_string());
        }
    }
    out.into_iter().collect()
}

struct Pattern {
    glob: Vec<u8>,
    negate: bool,
    dir_only: bool,
    anchored: bool,
    base: String,
}

fn parse_gitignore(base: &str, text: &str, out: &mut Vec<Pattern>) {
    for line in text.lines().take(MAX_PATTERNS) {
        if out.len() >= MAX_PATTERNS {
            return;
        }
        let mut l = line.trim_end();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        let negate = l.starts_with('!');
        if negate {
            l = &l[1..];
        }
        let dir_only = l.ends_with('/');
        let l = l.trim_end_matches('/');
        let anchored = l.contains('/');
        let l = l.trim_start_matches('/');
        if l.is_empty() || l.len() > 200 {
            continue;
        }
        out.push(Pattern { glob: l.as_bytes().to_vec(), negate, dir_only, anchored, base: base.to_string() });
    }
}

/// `*` and `?` stay inside a path segment, `**` crosses them, `[abc]` is a class, `\x` is a literal x. Iterative: no recursion.
fn glob_match(p: &[u8], t: &[u8]) -> bool {
    let (mut pi, mut ti) = (0usize, 0usize);
    // backtrack points: after the last `*` (stays inside a segment) and after the last `**` (crosses segments)
    let mut back_one: Option<(usize, usize)> = None;
    let mut back_all: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() {
            match p[pi] {
                b'*' => {
                    let double = p.get(pi + 1) == Some(&b'*');
                    pi += if double { 2 } else { 1 };
                    if double && p.get(pi) == Some(&b'/') {
                        pi += 1;
                    }
                    if double {
                        back_all = Some((pi, ti));
                        back_one = None;
                    } else {
                        back_one = Some((pi, ti));
                    }
                    continue;
                }
                b'?' if t[ti] != b'/' => {
                    pi += 1;
                    ti += 1;
                    continue;
                }
                b'[' => {
                    if let Some(close) = p[pi + 1..].iter().position(|b| *b == b']').map(|x| pi + 1 + x) {
                        let set = &p[pi + 1..close];
                        let (neg, set) = if matches!(set.first(), Some(b'!' | b'^')) { (true, &set[1..]) } else { (false, set) };
                        let mut hit = false;
                        let mut k = 0;
                        while k < set.len() {
                            if k + 2 < set.len() && set[k + 1] == b'-' {
                                hit |= (set[k]..=set[k + 2]).contains(&t[ti]);
                                k += 3;
                            } else {
                                hit |= set[k] == t[ti];
                                k += 1;
                            }
                        }
                        if hit != neg && t[ti] != b'/' {
                            pi = close + 1;
                            ti += 1;
                            continue;
                        }
                    }
                }
                b'\\' if pi + 1 < p.len() && p[pi + 1] == t[ti] => {
                    pi += 2;
                    ti += 1;
                    continue;
                }
                c if c == t[ti] && c != b'?' && c != b'[' && c != b'\\' => {
                    pi += 1;
                    ti += 1;
                    continue;
                }
                _ => {}
            }
        }
        if let Some((spi, sti)) = back_one.filter(|(_, sti)| *sti < t.len() && t[*sti] != b'/') {
            back_one = Some((spi, sti + 1));
            pi = spi;
            ti = sti + 1;
        } else if let Some((spi, sti)) = back_all.filter(|(_, sti)| *sti < t.len()) {
            back_all = Some((spi, sti + 1));
            back_one = None;
            pi = spi;
            ti = sti + 1;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

fn state(patterns: &[Pattern], path: &str, is_dir: bool) -> Option<bool> {
    let mut result = None;
    for p in patterns {
        if p.dir_only && !is_dir {
            continue;
        }
        let rel = if p.base.is_empty() { Some(path) } else { path.strip_prefix(&format!("{}/", p.base)) };
        let Some(rel) = rel else { continue };
        let target = if p.anchored { rel } else { rel.rsplit('/').next().unwrap_or(rel) };
        if glob_match(&p.glob, target.as_bytes()) {
            result = Some(!p.negate);
        }
    }
    result
}

fn is_ignored(patterns: &[Pattern], rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    for n in 1..parts.len() {
        if state(patterns, &parts[..n].join("/"), true) == Some(true) {
            return true;
        }
    }
    state(patterns, rel, false) == Some(true)
}

/// `tracked`: repository-relative paths Git tracks (the caller asks Git); only env files are looked at.
pub fn env_report(root: &Path, tracked: &[String]) -> Result<EnvReport, WebError> {
    let w = walk(root);
    let mut patterns = Vec::new();
    let mut capped = false;
    for e in w.files.iter().filter(|e| e.rel == ".gitignore" || e.rel.ends_with("/.gitignore")).take(60) {
        if let Ok(text) = safefs::read(root, &e.rel, 128 * 1024) {
            parse_gitignore(e.rel.strip_suffix(".gitignore").unwrap_or("").trim_end_matches('/'), &text, &mut patterns);
        }
    }
    capped |= patterns.len() >= MAX_PATTERNS;
    let tracked: BTreeSet<&str> = tracked.iter().map(String::as_str).collect();
    let mut by_dir: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new(); // dir -> (rel, name)
    for e in &w.files {
        let name = e.rel.rsplit('/').next().unwrap_or(&e.rel);
        if is_env_name(name) {
            let dir = e.rel.strip_suffix(name).unwrap_or("").trim_end_matches('/').to_string();
            by_dir.entry(dir).or_default().push((e.rel.clone(), name.to_string()));
        }
    }
    let mut report = EnvReport { capped, ..Default::default() };
    report.capped |= by_dir.len() > MAX_ENV_DIRS;
    for (dir, mut files) in by_dir.into_iter().take(MAX_ENV_DIRS) {
        if files.len() > MAX_ENV_FILES {
            files.truncate(MAX_ENV_FILES);
            report.capped = true;
        }
        let mut out_files = Vec::new();
        let mut example_keys: BTreeMap<String, String> = BTreeMap::new();
        let mut real_keys: BTreeSet<String> = BTreeSet::new();
        let (mut has_example, mut has_real) = (false, false);
        for (rel, name) in &files {
            let example = is_example(name);
            let keys = match safefs::read(root, rel, ENV_CAP) {
                Ok(text) => key_names(&text),
                Err(e) => {
                    report.skipped.push(format!("{rel}: {}", e.message));
                    Vec::new()
                }
            };
            if example {
                has_example = true;
                for k in &keys {
                    example_keys.entry(k.clone()).or_insert_with(|| name.clone());
                }
            } else {
                has_real = true;
                real_keys.extend(keys.iter().cloned());
            }
            out_files.push(EnvFile { path: rel.clone(), example, unprotected: !example && !is_ignored(&patterns, rel), tracked: !example && tracked.contains(rel.as_str()), keys: keys.len() as u32 });
        }
        let missing = example_keys.iter().filter(|(k, _)| !real_keys.contains(*k)).map(|(k, f)| MissingKey { key: k.clone(), example: f.clone() }).collect();
        let undocumented = if has_example { real_keys.iter().filter(|k| !example_keys.contains_key(*k)).cloned().collect() } else { Vec::new() };
        report.dirs.push(EnvDir { dir, files: out_files, missing, undocumented, no_example: has_real && !has_example, no_env: has_example && !has_real });
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(files: &[(&str, &str)]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for (rel, text) in files {
            let p = d.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        d
    }

    #[test]
    fn names_only_never_values() {
        let keys = key_names("# c\nA=1\nexport B = \"s3cr3t value\"\n  C=\nbad line\n1X=2\nA=again\n=nokey\nD.E=x\n");
        assert_eq!(keys, vec!["A", "B", "C", "D.E"]);
    }

    #[test]
    fn compares_example_and_real_files_and_checks_gitignore() {
        let canary = "fixture-value-that-must-not-leak-123";
        let d = repo(&[
            (".env.example", "API_URL=\nDB_URL=\nNEW_KEY=\n"),
            (".env", &format!("API_URL=http://x\nDB_URL={canary}\nLOCAL_ONLY=1\n")),
            (".gitignore", "node_modules\n.env*\n!.env.example\n"),
            ("web/.env.local", "A=1\n"),
            ("web/.env.example", "A=\nB=\n"),
            ("web/.gitignore", "# nothing\n"),
        ]);
        let r = env_report(d.path(), &[]).unwrap();
        let root = r.dirs.iter().find(|x| x.dir.is_empty()).unwrap();
        assert_eq!(root.missing.iter().map(|m| m.key.as_str()).collect::<Vec<_>>(), vec!["NEW_KEY"]);
        assert_eq!(root.undocumented, vec!["LOCAL_ONLY"]);
        assert!(root.files.iter().all(|f| !f.unprotected));
        let web = r.dirs.iter().find(|x| x.dir == "web").unwrap();
        assert_eq!(web.missing.iter().map(|m| m.key.as_str()).collect::<Vec<_>>(), vec!["B"]);
        // web/.env.local: the root rule `.env*` matches any basename below the root too
        assert!(web.files.iter().all(|f| !f.unprotected));
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains(canary) && !json.contains("http://x"));
    }

    #[test]
    fn an_unignored_or_tracked_env_file_is_flagged() {
        let d = repo(&[(".env", "A=1\n"), (".gitignore", "dist\n"), (".env.production", "B=1")]);
        let r = env_report(d.path(), &[".env.production".to_string()]).unwrap();
        let root = &r.dirs[0];
        assert!(root.files.iter().all(|f| f.unprotected));
        assert!(root.files.iter().find(|f| f.path == ".env.production").unwrap().tracked);
        assert!(root.no_example);
    }

    #[test]
    fn gitignore_rules() {
        let mut p = Vec::new();
        parse_gitignore("", "/secrets/\n*.local\n!keep.local\nlogs/**/*.log\n", &mut p);
        assert!(is_ignored(&p, "secrets/a/.env"));
        assert!(is_ignored(&p, "x/.env.local"));
        assert!(!is_ignored(&p, "x/keep.local"));
        assert!(is_ignored(&p, "logs/a/b/c.log"));
        assert!(!is_ignored(&p, "other/secrets/.env"));
        assert!(glob_match(b"*.env", b"prod.env"));
        assert!(!glob_match(b"*.env", b"a/prod.env"));
        assert!(glob_match(b"[ab]?.x", b"bz.x"));
    }

    #[test]
    fn pathological_patterns_are_not_exponential() {
        let p = "*a".repeat(30) + "b";
        let t = "a".repeat(5000);
        assert!(!glob_match(p.as_bytes(), t.as_bytes()));
    }

    #[test]
    fn invalid_utf8_and_huge_files_do_not_fail() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(".env"), [b'A', b'=', 0xff, b'\n', b'B', b'=']).unwrap();
        std::fs::write(d.path().join(".env.example"), vec![b'x'; (ENV_CAP + 1) as usize]).unwrap();
        let r = env_report(d.path(), &[]).unwrap();
        assert_eq!(r.dirs[0].files.iter().find(|f| f.path == ".env").unwrap().keys, 2);
        assert!(!r.skipped.is_empty());
    }

    #[test]
    fn hostile_numbers_of_env_files_and_ignore_rules_are_capped() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..200 {
            std::fs::write(d.path().join(format!(".env.mode{i}")), "A=1\n").unwrap();
        }
        std::fs::write(d.path().join(".gitignore"), "*.x\n".repeat(50_000)).unwrap();
        let t = std::time::Instant::now();
        let r = env_report(d.path(), &[]).unwrap();
        assert!(r.capped);
        assert_eq!(r.dirs[0].files.len(), MAX_ENV_FILES);
        assert!(t.elapsed().as_secs() < if cfg!(debug_assertions) { 10 } else { 2 }, "{:?}", t.elapsed());
    }
}
