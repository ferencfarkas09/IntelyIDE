//! The version files of a repository: find them, show them, and change several of them together (Tauri-free, no
//! network, fixture-tested). It knows `package.json` (and the `package-lock.json` beside it), Xcode projects
//! (`MARKETING_VERSION`, `CURRENT_PROJECT_VERSION`), literal `Info.plist` values, Android `build.gradle(.kts)`,
//! `Cargo.toml`, `tauri.conf.json`, Expo `app.json`, `pyproject.toml` and Flutter `pubspec.yaml`.
//!
//! An edit replaces only the bytes of the value, so indentation, quotes and line endings stay as they are and the
//! diff is exactly the version lines. Nothing here runs git, commits or tags.

mod diff;
mod formats;
mod json;
mod walk;

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::ops::Range;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub use formats::{Kind, Role};
use formats::{occurrences, Occ};

/// More than this and the repository is a collection of packages, not an app: the list stops and says so.
const MAX_FIELDS: usize = 80;
const MAX_CHANGES: usize = 200;

/// One version a repository writes down, in one file under one key. A key that appears several times in the file
/// (an Xcode target has a build configuration for Debug and Release, and there can be several targets) is one field.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    /// `<path>#<key>`: the same text the caller sends back in a [`Change`].
    pub id: String,
    pub path: String,
    pub kind: Kind,
    pub key: String,
    pub role: Role,
    /// The first occurrence's value; see `mixed`.
    pub value: String,
    pub occurrences: u32,
    /// The occurrences do not all hold the same value; a change sets all of them.
    pub mixed: bool,
    /// Files that change together with this one (the `package-lock.json` beside a `package.json`).
    pub companions: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub fields: Vec<Field>,
    pub truncated: bool,
    /// Things that were left out and why (a file that is too large, a scan that stopped early).
    pub skipped: Vec<String>,
}

/// A wish: the field `id` holds `from` now and should hold `to`. `from` guards against a file that changed since it was read.
#[derive(Debug, Clone, Deserialize)]
pub struct Change {
    pub id: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePlan {
    pub path: String,
    pub diff: String,
}

#[derive(Debug)]
pub struct VersionsError {
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for VersionsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for VersionsError {}

fn fail<T>(code: &'static str, message: impl Into<String>) -> Result<T, VersionsError> {
    Err(VersionsError { code, message: message.into() })
}

fn io_err(e: std::io::Error) -> VersionsError {
    VersionsError { code: "io", message: e.to_string() }
}

fn read(root: &Path, rel: &str) -> Result<String, VersionsError> {
    std::fs::read_to_string(root.join(rel)).map_err(io_err)
}

fn lock_path(rel: &str) -> String {
    match rel.rsplit_once('/') {
        Some((dir, _)) => format!("{dir}/package-lock.json"),
        None => "package-lock.json".to_string(),
    }
}

/// Where `package-lock.json` repeats the version of its package: the top level and the root entry in `packages`.
fn lock_ranges(text: &str, from: &str) -> Vec<Range<usize>> {
    [&["version"][..], &["packages", "", "version"][..]]
        .iter()
        .filter_map(|path| json::locate(text, path))
        .filter(|l| l.quoted && &text[l.start..l.end] == from)
        .map(|l| l.start..l.end)
        .collect()
}

fn companions(root: &Path, rel: &str, kind: Kind, key: &str, value: &str) -> Vec<String> {
    if kind != Kind::PackageJson || key != "version" {
        return Vec::new();
    }
    let lock = lock_path(rel);
    match std::fs::read_to_string(root.join(&lock)) {
        Ok(text) if !lock_ranges(&text, value).is_empty() => vec![lock],
        _ => Vec::new(),
    }
}

/// Every version field of the repository at `root`, in path order. Reads only; a file that cannot be read is listed in `skipped`.
pub fn scan(root: &Path) -> Scan {
    let (cands, skipped) = walk::candidates(root);
    let mut out = Scan { fields: Vec::new(), truncated: false, skipped };
    for c in cands {
        let Ok(text) = std::fs::read_to_string(root.join(&c.rel)) else {
            out.skipped.push(format!("{} could not be read", c.rel));
            continue;
        };
        let occs = occurrences(c.kind, &text);
        let mut keys: Vec<&str> = Vec::new();
        for o in &occs {
            if !keys.contains(&o.key.as_str()) {
                keys.push(&o.key);
            }
        }
        for key in keys {
            let same: Vec<&Occ> = occs.iter().filter(|o| o.key == key).collect();
            if out.fields.len() >= MAX_FIELDS {
                out.truncated = true;
                return out;
            }
            out.fields.push(Field {
                id: format!("{}#{}", c.rel, key),
                path: c.rel.clone(),
                kind: c.kind,
                key: key.to_string(),
                role: same[0].role,
                value: same[0].value.clone(),
                occurrences: same.len() as u32,
                mixed: same.iter().any(|o| o.value != same[0].value),
                companions: companions(root, &c.rel, c.kind, key, &same[0].value),
            });
        }
    }
    out
}

fn valid(role: Role, to: &str, numeric: bool) -> Result<(), VersionsError> {
    let ok = match role {
        Role::Version => to.len() <= 64 && to.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && to.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')),
        Role::Build => {
            !to.is_empty() && to.len() <= 16 && !to.starts_with('.') && !to.ends_with('.') && to.chars().all(|c| c.is_ascii_digit() || c == '.') && (!numeric || to.chars().all(|c| c.is_ascii_digit()))
        }
    };
    if ok {
        Ok(())
    } else {
        fail("badValue", format!("{to:?} is not a valid {}", if role == Role::Version { "version" } else { "build number" }))
    }
}

struct FileEdit {
    rel: String,
    before: String,
    after: String,
}

/// The new text of every file the changes touch. Nothing is written. Every change is checked against a fresh read.
fn compute(root: &Path, changes: &[Change]) -> Result<Vec<FileEdit>, VersionsError> {
    if changes.is_empty() {
        return fail("badRequest", "nothing to change");
    }
    if changes.len() > MAX_CHANGES {
        return fail("badRequest", format!("more than {MAX_CHANGES} changes at once"));
    }
    let current = scan(root);
    let by_id: BTreeMap<&str, &Field> = current.fields.iter().map(|f| (f.id.as_str(), f)).collect();
    let mut seen = BTreeSet::new();
    let mut by_file: BTreeMap<String, Vec<(&Change, &Field)>> = BTreeMap::new();
    for c in changes {
        if !seen.insert(c.id.as_str()) {
            return fail("badRequest", format!("{} is listed twice", c.id));
        }
        let Some(f) = by_id.get(c.id.as_str()) else {
            return fail("stale", format!("{} is no longer in the repository", c.id));
        };
        if f.value != c.from {
            return fail("stale", format!("{} changed since it was read: it is {} now, not {}", c.id, f.value, c.from));
        }
        by_file.entry(f.path.clone()).or_default().push((c, f));
    }
    let mut edits = Vec::new();
    for (rel, items) in by_file {
        let kind = items[0].1.kind;
        let before = read(root, &rel)?;
        let occs = occurrences(kind, &before);
        let mut repl: Vec<(Range<usize>, &str)> = Vec::new();
        let mut lock_jobs: Vec<(String, &str, &str)> = Vec::new();
        for (c, f) in &items {
            if c.to == c.from {
                continue;
            }
            for o in occs.iter().filter(|o| o.key == f.key) {
                valid(f.role, &c.to, o.numeric)?;
                repl.push((o.range.clone(), c.to.as_str()));
            }
            if !f.companions.is_empty() {
                lock_jobs.push((lock_path(&rel), c.from.as_str(), c.to.as_str()));
            }
        }
        if repl.is_empty() {
            continue;
        }
        repl.sort_by_key(|r| std::cmp::Reverse(r.0.start));
        let mut after = before.clone();
        for (range, to) in &repl {
            after.replace_range(range.clone(), to);
        }
        edits.push(FileEdit { rel: rel.clone(), before, after });
        for (lock_rel, from, to) in lock_jobs {
            let text = read(root, &lock_rel)?;
            let mut ranges = lock_ranges(&text, from);
            if ranges.is_empty() {
                continue;
            }
            ranges.sort_by_key(|r| std::cmp::Reverse(r.start));
            let mut after = text.clone();
            for r in ranges {
                after.replace_range(r, to);
            }
            edits.push(FileEdit { rel: lock_rel, before: text, after });
        }
    }
    Ok(edits)
}

/// The exact diff of every file the changes would touch. Writes nothing.
pub fn plan(root: &Path, changes: &[Change]) -> Result<Vec<FilePlan>, VersionsError> {
    Ok(compute(root, changes)?.into_iter().map(|e| FilePlan { diff: diff::render(&e.rel, &e.before, &e.after), path: e.rel }).collect())
}

fn write_atomic(root: &Path, rel: &str, text: &str) -> Result<(), VersionsError> {
    let full = root.join(rel);
    let name = full.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = full.with_file_name(format!("{name}.intely-tmp"));
    std::fs::write(&tmp, text).map_err(io_err)?;
    if let Ok(m) = std::fs::metadata(&full) {
        let _ = std::fs::set_permissions(&tmp, m.permissions());
    }
    std::fs::rename(&tmp, &full).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io_err(e)
    })
}

/// Writes the changes and returns the files that were written. All or nothing: a file that changed since it was
/// read, or a write that fails, puts the files already written back.
pub fn apply(root: &Path, changes: &[Change]) -> Result<Vec<String>, VersionsError> {
    let edits = compute(root, changes)?;
    let mut done: Vec<&FileEdit> = Vec::new();
    for e in &edits {
        let result = match read(root, &e.rel) {
            Ok(now) if now == e.before => write_atomic(root, &e.rel, &e.after),
            Ok(_) => fail("stale", format!("{} changed while the versions were being written", e.rel)),
            Err(err) => Err(err),
        };
        if let Err(err) = result {
            for d in done.iter().rev() {
                let _ = write_atomic(root, &d.rel, &d.before);
            }
            return Err(err);
        }
        done.push(e);
    }
    Ok(edits.into_iter().map(|e| e.rel).collect())
}
