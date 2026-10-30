//! The opt-in copy of ignored config files (`.env`, `.env.local`, ...) taken with a checkpoint. Git ignores these files, so neither a
//! Rewind snapshot nor a checkpoint holds them; when the person switches the protection on, the files named in [`PROTECTED_NAMES`]
//! are copied OUTSIDE the repository, into the app's state directory: `<root>/<runId>/<repoKey>/<seq>/files/<path>`, directories
//! 0700 and files 0600. Their content is never logged, never sent anywhere and never shown; the interface only lists the names.
//!
//! Restoring a copy needs explicit consent per call, writes only names that are in that copy's manifest, never through a symbolic
//! link (the file itself or a directory above it) and never outside the repository.

use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{validate_run_id, Rewind, RewindError};

/// The exact file names that are protected. Only untracked files (ignored, or kept out of snapshots by the guard) are copied:
/// a tracked `.env` is already in every checkpoint.
pub const PROTECTED_NAMES: [&str; 10] = [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.test",
    ".env.test.local",
    ".env.production",
    ".env.production.local",
    ".env.staging",
    ".env.staging.local",
];
/// Largest single file copied; a larger "config file" is skipped (and listed as skipped).
pub const MAX_FILE_BYTES: u64 = 256 * 1024;
/// Most files copied per repository and checkpoint.
pub const MAX_FILES: usize = 32;
const MANIFEST: &str = "manifest.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    /// Repository-relative path, `/`-separated.
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFile {
    pub path: String,
    pub size: u64,
    /// `same` (the file now has the copied content), `differs` or `missing` (the file is gone).
    pub state: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    files: Vec<VaultEntry>,
    /// Names that matched but were not copied (too large, a link, unreadable).
    #[serde(default)]
    skipped: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ConfigVault {
    root: PathBuf,
}

impl ConfigVault {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Copies the protected files of `repo` that are not tracked. Returns what was copied (names only).
    pub fn save(&self, rewind: &Rewind, repo: &Path, run_id: &str, seq: u32) -> Result<Vec<VaultEntry>, RewindError> {
        validate_run_id(run_id)?;
        let top = rewind.toplevel(repo)?;
        let names = rewind.protected_candidates(&top)?;
        let dir = self.dir(&top, run_id, seq);
        let mut manifest = Manifest::default();
        for rel in names.into_iter().take(MAX_FILES) {
            let Some(src) = safe_join(&top, &rel) else { continue };
            match read_regular(&src) {
                Ok(bytes) => {
                    let dest = dir.join("files").join(&rel);
                    write_private(&dest, &bytes)?;
                    manifest.files.push(VaultEntry { path: rel, size: bytes.len() as u64 });
                }
                Err(_) => manifest.skipped.push(rel),
            }
        }
        if manifest.files.is_empty() && manifest.skipped.is_empty() {
            return Ok(Vec::new());
        }
        write_private(&dir.join(MANIFEST), &serde_json::to_vec(&manifest).map_err(std::io::Error::other)?)?;
        Ok(manifest.files)
    }

    /// The copies of one checkpoint and how each compares with the file in the repository now. Reads no content into the answer.
    pub fn list(&self, rewind: &Rewind, repo: &Path, run_id: &str, seq: u32) -> Result<Vec<VaultFile>, RewindError> {
        validate_run_id(run_id)?;
        let top = rewind.toplevel(repo)?;
        let dir = self.dir(&top, run_id, seq);
        let manifest = read_manifest(&dir);
        let mut out = Vec::new();
        for e in manifest.files {
            let Some(copy) = safe_join(&dir.join("files"), &e.path) else { continue };
            let saved = fs::read(&copy).ok();
            let now = safe_join(&top, &e.path).and_then(|p| read_regular(&p).ok());
            let state = match (&saved, &now) {
                (Some(a), Some(b)) if a == b => "same",
                (_, None) => "missing",
                _ => "differs",
            };
            out.push(VaultFile { path: e.path, size: e.size, state: state.into() });
        }
        Ok(out)
    }

    /// Whether the protected files of `repo` now differ from the copy kept with step `seq`: a file added, gone or changed. A step
    /// whose git tree did not change is still taken for that (an edit of `.env` alone changes nothing git sees).
    pub fn differs(&self, rewind: &Rewind, repo: &Path, run_id: &str, seq: u32) -> Result<bool, RewindError> {
        validate_run_id(run_id)?;
        let top = rewind.toplevel(repo)?;
        let names: Vec<String> = rewind.protected_candidates(&top)?.into_iter().take(MAX_FILES).collect();
        let dir = self.dir(&top, run_id, seq);
        let manifest = read_manifest(&dir);
        let mut copied: Vec<&str> = manifest.files.iter().map(|e| e.path.as_str()).chain(manifest.skipped.iter().map(String::as_str)).collect();
        copied.sort_unstable();
        let mut now: Vec<&str> = names.iter().map(String::as_str).collect();
        now.sort_unstable();
        if copied != now {
            return Ok(true);
        }
        for e in &manifest.files {
            let saved = safe_join(&dir.join("files"), &e.path).and_then(|p| fs::read(p).ok());
            let current = safe_join(&top, &e.path).and_then(|p| read_regular(&p).ok());
            if saved.is_none() || saved != current {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Writes the copies of `paths` back into the repository. Refuses without `consent`; a name that is not in the copy's manifest,
    /// a file that is a link, or a path through a linked directory is refused as a whole before anything is written.
    pub fn restore(&self, rewind: &Rewind, repo: &Path, run_id: &str, seq: u32, paths: &[String], consent: bool) -> Result<Vec<String>, RewindError> {
        validate_run_id(run_id)?;
        if !consent {
            return Err(RewindError::ConfirmationRequired);
        }
        let top = rewind.toplevel(repo)?;
        let dir = self.dir(&top, run_id, seq);
        let manifest = read_manifest(&dir);
        let mut work = Vec::new();
        for p in paths {
            if !manifest.files.iter().any(|e| &e.path == p) {
                return Err(RewindError::Io(std::io::Error::other(format!("{p} is not in this checkpoint's copy"))));
            }
            let target = safe_join(&top, p).ok_or_else(|| std::io::Error::other(format!("{p} is not a plain path inside the repository")))?;
            if linked_on_the_way(&top, &target) || fs::symlink_metadata(&target).is_ok_and(|m| !m.is_file()) {
                return Err(RewindError::Io(std::io::Error::other(format!("{p} is a link or sits behind one; it is not written"))));
            }
            let copy = safe_join(&dir.join("files"), p).ok_or_else(|| std::io::Error::other("bad copy path"))?;
            work.push((p.clone(), target, read_regular(&copy)?));
        }
        let mut done = Vec::new();
        for (p, target, bytes) in work {
            let mode = fs::metadata(&target).ok().map(|m| m.permissions());
            write_private(&target, &bytes)?;
            if let Some(perm) = mode {
                fs::set_permissions(&target, perm)?;
            }
            done.push(p);
        }
        Ok(done)
    }

    /// Forgets every copy of the run (all repositories).
    pub fn delete_run(&self, run_id: &str) -> Result<(), RewindError> {
        validate_run_id(run_id)?;
        let dir = self.root.join(run_id);
        if fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
            fs::remove_dir_all(dir)?;
        }
        Ok(())
    }

    /// Run ids with copies, newest first.
    pub fn runs(&self) -> Vec<String> {
        let mut runs: Vec<(std::time::SystemTime, String)> = fs::read_dir(&self.root)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.file_name().to_str()?.to_string())))
            .filter(|(_, id)| validate_run_id(id).is_ok())
            .collect();
        runs.sort_by(|a, b| b.cmp(a));
        runs.into_iter().map(|(_, id)| id).collect()
    }

    fn dir(&self, top: &Path, run_id: &str, seq: u32) -> PathBuf {
        self.root.join(run_id).join(repo_key(top)).join(format!("{seq:04}"))
    }
}

impl Rewind {
    /// Untracked files of `top` (ignored ones included) whose name is one of [`PROTECTED_NAMES`], `/`-separated, sorted. Ignored
    /// directories are not entered (`node_modules`, build output).
    pub fn protected_candidates(&self, top: &Path) -> Result<Vec<String>, RewindError> {
        let mut out = std::collections::BTreeSet::new();
        for extra in [&["--ignored", "--directory"][..], &[][..]] {
            let mut args = vec!["ls-files", "-z", "--others", "--exclude-standard"];
            args.extend_from_slice(extra);
            let raw = self.git(top, &args, &[], None)?;
            for p in raw.split(|b| *b == 0).filter(|p| !p.is_empty() && !p.ends_with(b"/")) {
                let p = String::from_utf8_lossy(p).into_owned();
                let name = p.rsplit('/').next().unwrap_or(&p);
                if PROTECTED_NAMES.contains(&name) {
                    out.insert(p);
                }
            }
        }
        Ok(out.into_iter().collect())
    }
}

/// A stable short name for a repository's folder (FNV-1a of its path), so two repositories with the same name never share a folder.
fn repo_key(top: &Path) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in top.to_string_lossy().bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// `base/rel` when `rel` is a plain relative path (no `..`, no root, no prefix).
fn safe_join(base: &Path, rel: &str) -> Option<PathBuf> {
    let rel = Path::new(rel);
    if rel.as_os_str().is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(base.join(rel))
}

/// Whether a directory between `top` and `path` is a symbolic link.
fn linked_on_the_way(top: &Path, path: &Path) -> bool {
    let mut dir = path.parent();
    while let Some(d) = dir {
        if d == top || !d.starts_with(top) {
            return false;
        }
        if fs::symlink_metadata(d).is_ok_and(|m| m.file_type().is_symlink()) {
            return true;
        }
        dir = d.parent();
    }
    false
}

/// The bytes of a regular file of at most [`MAX_FILE_BYTES`], never through a link.
fn read_regular(path: &Path) -> std::io::Result<Vec<u8>> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return Err(std::io::Error::other("not a small regular file"));
    }
    let mut opts = fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let mut buf = Vec::new();
    opts.open(path)?.take(MAX_FILE_BYTES + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > MAX_FILE_BYTES {
        return Err(std::io::Error::other("the file grew past the limit"));
    }
    Ok(buf)
}

/// Writes through a temporary file next to `path` and a rename; directories are created 0700 and the file is 0600.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| std::io::Error::other("no parent"))?;
    let mut b = fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(parent)?;
    let tmp = parent.join(format!(".intely-{}-{}.tmp", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos())));
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let result = (|| {
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn read_manifest(dir: &Path) -> Manifest {
    fs::read(dir.join(MANIFEST)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
