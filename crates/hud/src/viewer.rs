//! Byte access for the viewers (JSON/log, image, PDF): ranged reads of one regular file inside a registered repo. The
//! files crate caps text at 5 MiB and never returns bytes, so large logs and images come through here instead.
//! Same rules as the editor: nothing under `.git`, no `..`, no symlink that leaves the repo, and guarded files (secrets,
//! never-add folders) are refused outright, with no "reveal" escape.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use intely_core::guard::classify;
use intely_core::GuardState;
use serde::Serialize;

/// One call returns at most this many bytes (the UI streams a big file in several calls).
pub const MAX_RANGE: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewerError {
    pub code: &'static str,
    pub message: String,
}

fn fail<T>(code: &'static str, message: impl Into<String>) -> Result<T, ViewerError> {
    Err(ViewerError { code, message: message.into() })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub size: u64,
    pub mtime_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    /// Standard base64 of the bytes read.
    pub base64: String,
    pub offset: u64,
    pub len: u64,
    pub eof: bool,
}

/// The absolute path of `rel` inside `root`, or why it is refused.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, ViewerError> {
    let rel = rel.trim_end_matches('/');
    if rel.is_empty() {
        return fail("invalidSelection", "no file");
    }
    let p = Path::new(rel);
    if p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return fail("invalidSelection", format!("path {rel:?} is not repo-relative"));
    }
    if rel.split('/').any(|c| c.eq_ignore_ascii_case(".git")) {
        return fail("invalidSelection", format!("path {rel:?} is inside .git"));
    }
    if classify(rel, true, None) != GuardState::Ok {
        return fail("guardBlocked", format!("{rel} is a guarded file"));
    }
    let canon_root = root.canonicalize().map_err(|e| ViewerError { code: "repoMissing", message: format!("{}: {e}", root.display()) })?;
    let full = canon_root.join(rel).canonicalize().map_err(|e| ViewerError { code: "io", message: format!("{rel}: {e}") })?;
    if !full.starts_with(&canon_root) {
        return fail("invalidSelection", format!("path {rel:?} leaves the repository"));
    }
    if !full.is_file() {
        return fail("invalidSelection", format!("{rel} is not a file"));
    }
    Ok(full)
}

pub fn stat(root: &Path, rel: &str) -> Result<Stat, ViewerError> {
    let full = resolve(root, rel)?;
    let md = std::fs::metadata(&full).map_err(|e| ViewerError { code: "io", message: e.to_string() })?;
    let mtime_ms = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_millis() as f64);
    Ok(Stat { size: md.len(), mtime_ms })
}

pub fn read_range(root: &Path, rel: &str, offset: u64, len: u64) -> Result<Range, ViewerError> {
    let full = resolve(root, rel)?;
    let io = |e: std::io::Error| ViewerError { code: "io", message: e.to_string() };
    let mut f = File::open(&full).map_err(io)?;
    let size = f.metadata().map_err(io)?.len();
    let want = len.min(MAX_RANGE).min(size.saturating_sub(offset));
    f.seek(SeekFrom::Start(offset)).map_err(io)?;
    let mut buf = vec![0u8; want as usize];
    f.read_exact(&mut buf).map_err(io)?;
    Ok(Range { base64: base64(&buf), offset, len: want, eof: offset + want >= size })
}

pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}
