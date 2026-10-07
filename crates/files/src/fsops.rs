//! Directory listing, file reads and atomic writes inside a registered repo.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use intely_core::exec::resolve_in_repo;
use intely_core::guard::classify;
use intely_core::{code, EngineError, GuardState};

use crate::types::*;
use crate::{codes, encoding, io_err, nfc, Files};

/// Files above this size are read only up to this many bytes: the result has `tooLarge` set and the text is a read-only prefix.
pub const MAX_READ_BYTES: u64 = 5 * 1024 * 1024;
const BINARY_SNIFF: usize = 8000;

fn invalid(rel: &str, why: &str) -> EngineError {
    EngineError::new(code::INVALID_SELECTION, format!("path {rel:?} {why}"))
}

/// Nothing below `.git` is addressable: it holds remote URLs and credentials helpers.
fn deny_git_dir(rel: &str) -> Result<(), EngineError> {
    if rel.split('/').any(|c| c.eq_ignore_ascii_case(".git")) {
        return Err(invalid(rel, "is inside .git"));
    }
    Ok(())
}

fn canonical_root(root: &RepoRoot) -> Result<PathBuf, EngineError> {
    root.path.canonicalize().map_err(|e| EngineError::new(code::REPO_MISSING, format!("{}: {e}", root.path.display())))
}

/// `rel` may be empty for the repo root. Returns the absolute path; intermediate symlinks must stay inside the repo.
fn resolve_dir(root: &RepoRoot, rel: &str) -> Result<PathBuf, EngineError> {
    let rel = rel.trim_matches('/');
    if rel.is_empty() || rel == "." {
        return canonical_root(root);
    }
    deny_git_dir(rel)?;
    resolve_in_repo(&root.path, rel)
}

/// A file path inside the repo whose final component, if it is a symlink, points back inside the repo.
fn resolve_file(root: &RepoRoot, rel: &str) -> Result<PathBuf, EngineError> {
    deny_git_dir(rel)?;
    let full = resolve_in_repo(&root.path, rel)?;
    if fs::symlink_metadata(&full).is_ok_and(|m| m.file_type().is_symlink()) {
        let target = full.canonicalize().map_err(|e| io_err(rel, e))?;
        if !target.starts_with(canonical_root(root)?) {
            return Err(invalid(rel, "is a symlink that leaves the repository"));
        }
    }
    Ok(full)
}

fn mtime_ms(md: &fs::Metadata) -> f64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// The commit panel's guard for a path that is read or written by hand (tracked or not): secret names and the
/// never-add directories.
fn guard_of(rel: &str) -> GuardState {
    classify(rel, true, None)
}

fn join_rel(dir: &str, name: &str) -> String {
    let dir = dir.trim_matches('/');
    if dir.is_empty() || dir == "." {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

pub(crate) fn detect_eol(text: &str) -> Eol {
    let (mut lf, mut crlf) = (0usize, 0usize);
    let bytes = text.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            if i > 0 && bytes[i - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    match (lf, crlf) {
        (0, 0) => Eol::None,
        (_, 0) => Eol::Lf,
        (0, _) => Eol::Crlf,
        _ => Eol::Mixed,
    }
}

/// `None` text means the bytes are binary.
pub(crate) fn decode(bytes: &[u8]) -> (Option<String>, Encoding) {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return match std::str::from_utf8(rest) {
            Ok(s) => (Some(s.to_owned()), Encoding::Utf8Bom),
            Err(_) => (None, Encoding::Utf8Bom),
        };
    }
    for (bom, enc) in [([0xFF, 0xFE], Encoding::Utf16Le), ([0xFE, 0xFF], Encoding::Utf16Be)] {
        if let Some(rest) = bytes.strip_prefix(&bom) {
            return (decode_utf16(rest, enc), enc);
        }
    }
    if bytes[..bytes.len().min(BINARY_SNIFF)].contains(&0) {
        return (None, Encoding::Utf8);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => (Some(s.to_owned()), Encoding::Utf8),
        Err(_) => {
            let legacy = encoding::guess_legacy(bytes);
            (Some(encoding::decode_single_byte(bytes, legacy)), legacy)
        }
    }
}

fn decode_utf16(rest: &[u8], enc: Encoding) -> Option<String> {
    let le = enc == Encoding::Utf16Le;
    let units: Vec<u16> = rest.chunks_exact(2).map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }).collect();
    String::from_utf16(&units).ok().filter(|_| rest.len() % 2 == 0)
}

/// Decodes `bytes` as the encoding the user picked ("Reopen with encoding"). The Unicode encodings are strict and fail
/// on bytes that do not fit (the file would be corrupted on save); the single-byte ones accept anything.
pub(crate) fn decode_as(bytes: &[u8], enc: Encoding) -> Result<Option<String>, EngineError> {
    if bytes[..bytes.len().min(BINARY_SNIFF)].contains(&0) && !matches!(enc, Encoding::Utf16Le | Encoding::Utf16Be) {
        return Ok(None);
    }
    let unfit = |what: &str| EngineError::new(code::IO, format!("the bytes are not valid {what}"));
    Ok(Some(match enc {
        Encoding::Utf8 => std::str::from_utf8(bytes).map_err(|_| unfit("UTF-8"))?.to_owned(),
        Encoding::Utf8Bom => std::str::from_utf8(bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)).map_err(|_| unfit("UTF-8"))?.to_owned(),
        Encoding::Utf16Le | Encoding::Utf16Be => {
            let bom: [u8; 2] = if enc == Encoding::Utf16Le { [0xFF, 0xFE] } else { [0xFE, 0xFF] };
            decode_utf16(bytes.strip_prefix(&bom).unwrap_or(bytes), enc).ok_or_else(|| unfit("UTF-16"))?
        }
        Encoding::Latin1 | Encoding::Latin2 | Encoding::Windows1250 => encoding::decode_single_byte(bytes, enc),
    }))
}

pub(crate) fn encode(text: &str, encoding: Encoding) -> Result<Vec<u8>, EngineError> {
    Ok(match encoding {
        Encoding::Utf8 => text.as_bytes().to_vec(),
        Encoding::Utf8Bom => [&[0xEF, 0xBB, 0xBF][..], text.as_bytes()].concat(),
        Encoding::Utf16Le => [0xFF, 0xFE].into_iter().chain(text.encode_utf16().flat_map(u16::to_le_bytes)).collect(),
        Encoding::Utf16Be => [0xFE, 0xFF].into_iter().chain(text.encode_utf16().flat_map(u16::to_be_bytes)).collect(),
        Encoding::Latin1 | Encoding::Latin2 | Encoding::Windows1250 => encoding::encode_single_byte(text, encoding)
            .map_err(|c| EngineError::new(code::IO, format!("{c:?} cannot be saved as {}", encoding_label(encoding))))?,
    })
}

fn encoding_label(enc: Encoding) -> &'static str {
    match enc {
        Encoding::Utf8 => "UTF-8",
        Encoding::Utf8Bom => "UTF-8 with BOM",
        Encoding::Utf16Le => "UTF-16 LE",
        Encoding::Utf16Be => "UTF-16 BE",
        Encoding::Latin1 => "ISO-8859-1",
        Encoding::Latin2 => "ISO-8859-2",
        Encoding::Windows1250 => "Windows-1250",
    }
}

struct RawEntry {
    name: String,
    kind: FileKind,
    size: Option<f64>,
}

fn read_entries(dir: &Path) -> Result<Vec<RawEntry>, EngineError> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| io_err(dir.display(), e))?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        let (kind, size) = if ft.is_symlink() {
            (FileKind::Symlink, None)
        } else if ft.is_dir() {
            (FileKind::Dir, None)
        } else {
            (FileKind::File, entry.metadata().ok().map(|m| m.len() as f64))
        };
        out.push(RawEntry { name: nfc(&name), kind, size });
    }
    Ok(out)
}

fn status_letter(x: u8, y: u8) -> char {
    match (x, y) {
        (b'?', b'?') => '?',
        (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D') => 'U',
        (b'D', _) | (_, b'D') => 'D',
        (b'A', _) => 'A',
        _ => 'M',
    }
}

fn status_rank(c: char) -> u8 {
    match c {
        'U' => 5,
        'D' => 4,
        'M' => 3,
        'A' => 2,
        _ => 1,
    }
}

/// `git status --porcelain=v1 -z` records mapped to the direct children of `dir_rel` they fall under.
pub(crate) fn child_statuses(porcelain: &[u8], dir_rel: &str) -> HashMap<String, char> {
    let prefix = if dir_rel.trim_matches('/').is_empty() { String::new() } else { format!("{}/", dir_rel.trim_matches('/')) };
    let mut out: HashMap<String, char> = HashMap::new();
    for rec in porcelain.split(|b| *b == 0).filter(|r| r.len() > 3) {
        let (xy, path) = (&rec[..2], String::from_utf8_lossy(&rec[3..]).into_owned());
        let Some(rest) = nfc(&path).strip_prefix(&prefix).map(str::to_owned) else { continue };
        let child = rest.split('/').find(|c| !c.is_empty()).unwrap_or("").to_owned();
        if child.is_empty() {
            continue;
        }
        let letter = status_letter(xy[0], xy[1]);
        out.entry(child).and_modify(|c| *c = if status_rank(letter) > status_rank(*c) { letter } else { *c }).or_insert(letter);
    }
    out
}

impl Files {
    /// Lazy listing of one directory (`rel_path` empty for the repo root): directories first, then files, each group
    /// by name without regard to case. Symlinks are listed but never followed.
    pub async fn list_dir(&self, root: &RepoRoot, rel_path: &str) -> Result<Vec<DirEntry>, EngineError> {
        let rel = rel_path.trim_matches('/').to_owned();
        let dir = resolve_dir(root, &rel)?;
        let md = fs::symlink_metadata(&dir).map_err(|e| io_err(&rel, e))?;
        if md.file_type().is_symlink() {
            return Err(invalid(&rel, "is a symlink and is not followed"));
        }
        if !md.is_dir() {
            return Err(invalid(&rel, "is not a directory"));
        }
        let raw = tokio::task::spawn_blocking(move || read_entries(&dir)).await.map_err(|e| io_err("list", e))??;

        // Directories are probed with a trailing slash so directory-only patterns (`build/`) match.
        let mut probe = Vec::new();
        for e in &raw {
            probe.extend_from_slice(join_rel(&rel, &e.name).as_bytes());
            if e.kind == FileKind::Dir {
                probe.push(b'/');
            }
            probe.push(0);
        }
        let self_ignored = if rel.is_empty() { false } else { self.is_ignored(&root.path, &format!("{rel}/")).await };
        let (ignored, status) = tokio::join!(self.check_ignored(&root.path, probe), async {
            if self_ignored {
                return HashMap::new();
            }
            let pathspec = if rel.is_empty() { ".".to_owned() } else { rel.clone() };
            let args = ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal", "--", pathspec.as_str()];
            match self.git_read(&root.path, &args).await {
                Ok(out) if out.success() => child_statuses(&out.stdout, &rel),
                _ => HashMap::new(),
            }
        });

        let mut entries: Vec<DirEntry> = raw
            .into_iter()
            .map(|e| {
                let path = join_rel(&rel, &e.name);
                let key = if e.kind == FileKind::Dir { format!("{path}/") } else { path.clone() };
                DirEntry {
                    kind: e.kind,
                    size: e.size,
                    ignored: ignored.contains(&key),
                    never_read: guard_of(&path) != GuardState::Ok,
                    git_status: status.get(&e.name).map(char::to_string),
                    name: e.name,
                }
            })
            .collect();
        entries.sort_by(|a, b| {
            let dir = |e: &DirEntry| e.kind != FileKind::Dir;
            dir(a).cmp(&dir(b)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.name.cmp(&b.name))
        });
        Ok(entries)
    }

    async fn is_ignored(&self, repo: &Path, probe: &str) -> bool {
        self.check_ignored(repo, [probe.as_bytes(), &[0]].concat()).await.contains(probe)
    }

    /// The subset of the NUL-separated `probe` paths that .gitignore matches (tracked files never are).
    async fn check_ignored(&self, repo: &Path, probe: Vec<u8>) -> HashSet<String> {
        if probe.is_empty() {
            return HashSet::new();
        }
        match self.git_read_stdin(repo, &["check-ignore", "-z", "--stdin"], probe).await {
            // Exit 1 means nothing matched.
            Ok(out) if matches!(out.code, Some(0)) => {
                out.stdout.split(|b| *b == 0).filter(|p| !p.is_empty()).map(|p| nfc(&String::from_utf8_lossy(p))).collect()
            }
            _ => HashSet::new(),
        }
    }

    /// Guarded (secret, never-add) files come back without text unless `reveal` is set.
    pub async fn read_file(&self, root: &RepoRoot, rel_path: &str, reveal: bool) -> Result<FileRead, EngineError> {
        self.read_file_as(root, rel_path, reveal, None).await
    }

    /// Like [`Files::read_file`], decoding with `encoding` instead of detecting it ("Reopen with encoding").
    pub async fn read_file_as(&self, root: &RepoRoot, rel_path: &str, reveal: bool, encoding: Option<Encoding>) -> Result<FileRead, EngineError> {
        let rel = rel_path.to_owned();
        let full = resolve_file(root, &rel)?;
        tokio::task::spawn_blocking(move || read_file_sync(&full, &rel, reveal, encoding)).await.map_err(|e| io_err("read", e))?
    }

    /// Atomic write (temp file in the same folder, then rename). `expected_mtime_ms` is the `mtimeMs` of the read the
    /// editor holds, or 0 for a new file; a different mtime on disk fails with `staleFile`. Guarded files need `reveal`.
    pub async fn write_file(
        &self,
        root: &RepoRoot,
        rel_path: &str,
        text: &str,
        expected_mtime_ms: f64,
        reveal: bool,
        encoding: Option<Encoding>,
    ) -> Result<WriteResult, EngineError> {
        self.git.jail.check_op("write file", &root.path)?;
        let rel = rel_path.to_owned();
        let full = resolve_file(root, &rel)?;
        if guard_of(&rel) != GuardState::Ok && !reveal {
            return Err(EngineError::new(code::GUARD_BLOCKED, format!("{rel} is a guarded file; reveal it first")));
        }
        let bytes = encode(text, encoding.unwrap_or(Encoding::Utf8))?;
        let root_canon = canonical_root(root)?;
        let result = tokio::task::spawn_blocking({
            let rel = rel.clone();
            move || write_file_sync(&full, &root_canon, &rel, &bytes, expected_mtime_ms)
        })
        .await
        .map_err(|e| io_err("write", e))??;
        self.watches.note_written(&root.id, &rel, result.mtime_ms);
        self.index.invalidate(&root.id);
        Ok(result)
    }
}

impl Files {
    /// Creates an empty file or folder (and missing parent folders). Fails with `exists` when the path is taken.
    pub async fn create_entry(&self, root: &RepoRoot, rel_path: &str, kind: FileKind) -> Result<(), EngineError> {
        self.git.jail.check_op("create entry", &root.path)?;
        let (rel, root_canon) = (rel_path.trim_end_matches('/').to_owned(), canonical_root(root)?);
        let full = resolve_file(root, &rel)?;
        tokio::task::spawn_blocking(move || {
            if fs::symlink_metadata(&full).is_ok() {
                return Err(EngineError::new(codes::EXISTS, format!("{rel} already exists")));
            }
            let parent = full.parent().ok_or_else(|| invalid(&rel, "has no parent folder"))?;
            fs::create_dir_all(parent).map_err(|e| io_err(&rel, e))?;
            if !parent.canonicalize().map_err(|e| io_err(&rel, e))?.starts_with(&root_canon) {
                return Err(invalid(&rel, "escapes the repository"));
            }
            match kind {
                FileKind::Dir => fs::create_dir(&full),
                _ => fs::OpenOptions::new().write(true).create_new(true).open(&full).map(drop),
            }
            .map_err(|e| io_err(&rel, e))
        })
        .await
        .map_err(|e| io_err("create", e))??;
        self.index.invalidate(&root.id);
        Ok(())
    }

    /// Fails with `exists` when `to` is taken; the target folder must exist.
    pub async fn rename_entry(&self, root: &RepoRoot, from: &str, to: &str) -> Result<(), EngineError> {
        self.git.jail.check_op("rename entry", &root.path)?;
        let (from, to) = (from.trim_end_matches('/').to_owned(), to.trim_end_matches('/').to_owned());
        let (src, dst) = (resolve_in_repo_entry(root, &from)?, resolve_in_repo_entry(root, &to)?);
        tokio::task::spawn_blocking(move || {
            if fs::symlink_metadata(&src).is_err() {
                return Err(io_err(&from, "no such file or folder"));
            }
            if fs::symlink_metadata(&dst).is_ok() {
                return Err(EngineError::new(codes::EXISTS, format!("{to} already exists")));
            }
            fs::rename(&src, &dst).map_err(|e| io_err(format!("{from} -> {to}"), e))
        })
        .await
        .map_err(|e| io_err("rename", e))??;
        self.index.invalidate(&root.id);
        Ok(())
    }

    /// Moves the entry into `trash_dir` (the user's Trash) under a free name; nothing is ever deleted.
    pub async fn trash_entry(&self, root: &RepoRoot, rel_path: &str, trash_dir: &Path) -> Result<(), EngineError> {
        self.git.jail.check_op("trash entry", &root.path)?;
        let rel = rel_path.trim_end_matches('/').to_owned();
        let src = resolve_in_repo_entry(root, &rel)?;
        let trash = trash_dir.to_path_buf();
        tokio::task::spawn_blocking(move || {
            if fs::symlink_metadata(&src).is_err() {
                return Err(io_err(&rel, "no such file or folder"));
            }
            fs::create_dir_all(&trash).map_err(|e| io_err(trash.display(), e))?;
            let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let mut dst = trash.join(&name);
            let mut n = 1;
            while fs::symlink_metadata(&dst).is_ok() {
                n += 1;
                dst = trash.join(format!("{name} {n}"));
            }
            fs::rename(&src, &dst).map_err(|e| io_err(format!("{rel} to the Trash"), e))
        })
        .await
        .map_err(|e| io_err("trash", e))??;
        self.index.invalidate(&root.id);
        Ok(())
    }

    /// The absolute path of an entry inside the repo (for "reveal in Finder"); the entry must exist.
    pub fn entry_path(&self, root: &RepoRoot, rel_path: &str) -> Result<PathBuf, EngineError> {
        let rel = rel_path.trim_end_matches('/');
        let full = if rel.is_empty() { canonical_root(root)? } else { resolve_in_repo_entry(root, rel)? };
        fs::symlink_metadata(&full).map_err(|e| io_err(rel, e))?;
        Ok(full)
    }
}

/// Like [`resolve_file`] but the final component is never followed (a symlink entry is addressed as itself).
fn resolve_in_repo_entry(root: &RepoRoot, rel: &str) -> Result<PathBuf, EngineError> {
    deny_git_dir(rel)?;
    resolve_in_repo(&root.path, rel)
}

/// Drops an incomplete UTF-8 sequence cut off at the end of a partial read (at most three bytes).
fn trim_partial_utf8(bytes: &[u8]) -> &[u8] {
    match std::str::from_utf8(bytes) {
        Err(e) if e.error_len().is_none() => &bytes[..e.valid_up_to()],
        _ => bytes,
    }
}

fn read_file_sync(full: &Path, rel: &str, reveal: bool, forced: Option<Encoding>) -> Result<FileRead, EngineError> {
    let md = fs::metadata(full).map_err(|e| io_err(rel, e))?;
    if !md.is_file() {
        return Err(invalid(rel, "is not a file"));
    }
    let (size, mtime) = (md.len(), mtime_ms(&md));
    let guard = guard_of(rel);
    let guarded = guard != GuardState::Ok;
    let base = FileRead {
        text: None,
        binary: false,
        too_large: false,
        size: size as f64,
        mtime_ms: mtime,
        eol: Eol::None,
        encoding: Encoding::Utf8,
        guard,
    };
    if guarded && !reveal {
        return Ok(base);
    }
    let partial = size > MAX_READ_BYTES;
    let mut bytes = Vec::new();
    fs::File::open(full).and_then(|f| f.take(MAX_READ_BYTES).read_to_end(&mut bytes)).map_err(|e| io_err(rel, e))?;
    if partial {
        // A prefix may end inside a multi-byte character or a UTF-16 unit.
        let utf16 = matches!(forced, Some(Encoding::Utf16Le | Encoding::Utf16Be)) || bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]);
        let keep = if utf16 { bytes.len() & !1 } else { trim_partial_utf8(&bytes).len() };
        if bytes.len() - keep <= 3 {
            bytes.truncate(keep);
        }
    }
    let base = FileRead { too_large: partial, ..base };
    let (text, encoding) = match forced {
        Some(enc) => (decode_as(&bytes, enc)?, enc),
        None => decode(&bytes),
    };
    Ok(match text {
        Some(text) => FileRead { eol: detect_eol(&text), text: Some(text), encoding, ..base },
        None => FileRead { binary: true, encoding, ..base },
    })
}

fn write_file_sync(full: &Path, root: &Path, rel: &str, bytes: &[u8], expected_mtime_ms: f64) -> Result<WriteResult, EngineError> {
    let stale = || EngineError::new(codes::STALE_FILE, format!("{rel} changed on disk"));
    let existing = match fs::symlink_metadata(full) {
        Ok(md) if md.file_type().is_symlink() => return Err(invalid(rel, "is a symlink; refusing to replace it")),
        Ok(md) if md.is_dir() => return Err(invalid(rel, "is a directory")),
        Ok(md) => Some(md),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(io_err(rel, e)),
    };
    match &existing {
        Some(md) if (mtime_ms(md) - expected_mtime_ms).abs() >= 1.0 => return Err(stale()),
        None if expected_mtime_ms != 0.0 => return Err(stale()),
        _ => {}
    }
    let parent = full.parent().ok_or_else(|| invalid(rel, "has no parent folder"))?;
    fs::create_dir_all(parent).map_err(|e| io_err(rel, e))?;
    // New folders may have been created through a path the first check could only judge by its existing ancestor.
    if !parent.canonicalize().map_err(|e| io_err(rel, e))?.starts_with(root) {
        return Err(invalid(rel, "escapes the repository"));
    }
    let name = full.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = parent.join(format!(".{name}.intely-{}.tmp", &uuid::Uuid::new_v4().simple().to_string()[..8]));
    // The mtime of the new file is read from the temp file: a rename keeps it, and the path may already be gone again when something
    // consumes the file right after it appeared (a watcher, a hand-off file), which must not fail a finished write.
    let written = (|| -> std::io::Result<fs::Metadata> {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        if let Some(md) = &existing {
            fs::set_permissions(&tmp, md.permissions())?;
        }
        fs::metadata(&tmp)
    })();
    let finish = written.map_err(|e| io_err(rel, e)).and_then(|written_md| {
        // A last look right before the rename narrows the window for a concurrent writer.
        match (&existing, fs::metadata(full)) {
            (Some(before), Ok(now)) if mtime_ms(before) != mtime_ms(&now) => Err(stale()),
            (None, Ok(_)) => Err(stale()),
            _ => fs::rename(&tmp, full).map(|()| written_md).map_err(|e| io_err(rel, e)),
        }
    });
    let md = match finish {
        Ok(md) => md,
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
    };
    Ok(WriteResult { mtime_ms: mtime_ms(&md) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_detects_boms_binary_and_latin1() {
        assert_eq!(decode(b"hi\n"), (Some("hi\n".into()), Encoding::Utf8));
        assert_eq!(decode(&[0xEF, 0xBB, 0xBF, b'a']), (Some("a".into()), Encoding::Utf8Bom));
        assert_eq!(decode(&[0xFF, 0xFE, b'a', 0]), (Some("a".into()), Encoding::Utf16Le));
        assert_eq!(decode(&[0xFE, 0xFF, 0, b'a']), (Some("a".into()), Encoding::Utf16Be));
        assert_eq!(decode(b"a\0b").0, None);
        assert_eq!(decode(&[b'c', b'a', b'f', 0xE9]), (Some("caf\u{e9}".into()), Encoding::Latin1));
    }

    #[test]
    fn decode_guesses_hungarian_legacy_encodings() {
        // "\u{e1}rv\u{ed}zt\u{171}r\u{151}" in ISO-8859-2, and a Windows-1250 file with typographic quotes.
        assert_eq!(decode(b"\xe1rv\xedzt\xfbr\xf5"), (Some("\u{e1}rv\u{ed}zt\u{171}r\u{151}".into()), Encoding::Latin2));
        assert_eq!(decode(b"\x93k\xf6nyv\x94 \xf5"), (Some("\u{201c}k\u{f6}nyv\u{201d} \u{151}".into()), Encoding::Windows1250));
        // Valid UTF-8 always wins over the heuristic.
        assert_eq!(decode("\u{151}\u{171}".as_bytes()), (Some("\u{151}\u{171}".into()), Encoding::Utf8));
    }

    #[test]
    fn decode_as_is_strict_for_unicode_and_total_for_single_byte() {
        assert!(decode_as(b"caf\xe9", Encoding::Utf8).is_err());
        assert_eq!(decode_as(b"caf\xe9", Encoding::Latin1).unwrap().as_deref(), Some("caf\u{e9}"));
        assert_eq!(decode_as(b"\xf5", Encoding::Latin2).unwrap().as_deref(), Some("\u{151}"));
        assert_eq!(decode_as(&[0xEF, 0xBB, 0xBF, b'a'], Encoding::Utf8Bom).unwrap().as_deref(), Some("a"));
        assert!(decode_as(b"a\0b", Encoding::Latin2).unwrap().is_none());
        assert!(decode_as(&[0xFF, 0xFE, b'a'], Encoding::Utf16Le).is_err());
    }

    #[test]
    fn a_partial_read_cuts_at_a_character_boundary() {
        assert_eq!(trim_partial_utf8("a\u{151}".as_bytes()), "a\u{151}".as_bytes());
        assert_eq!(trim_partial_utf8(&"a\u{151}".as_bytes()[..2]), b"a");
    }

    #[test]
    fn encode_round_trips_every_encoding() {
        for (bytes, enc) in [
            (vec![0xEF, 0xBB, 0xBF, b'o', b'k'], Encoding::Utf8Bom),
            (vec![0xFF, 0xFE, b'o', 0, b'k', 0], Encoding::Utf16Le),
            (vec![b'c', 0xE9], Encoding::Latin1),
        ] {
            let (text, found) = decode(&bytes);
            assert_eq!(found, enc);
            assert_eq!(encode(&text.unwrap(), enc).unwrap(), bytes);
        }
        assert!(encode("\u{150}", Encoding::Latin1).is_err());
        assert_eq!(encode("\u{151}", Encoding::Latin2).unwrap(), vec![0xF5]);
        assert!(encode("\u{4e2d}", Encoding::Windows1250).is_err());
    }

    #[test]
    fn eol_is_detected() {
        assert_eq!(detect_eol("a"), Eol::None);
        assert_eq!(detect_eol("a\nb\n"), Eol::Lf);
        assert_eq!(detect_eol("a\r\nb\r\n"), Eol::Crlf);
        assert_eq!(detect_eol("a\r\nb\n"), Eol::Mixed);
    }

    #[test]
    fn child_statuses_aggregate_below_a_directory() {
        let porcelain = b" M src/a.ts\0?? src/new/x.ts\0A  src/new/y.ts\0 D README.md\0";
        let root = child_statuses(porcelain, "");
        assert_eq!(root.get("src"), Some(&'M'));
        assert_eq!(root.get("README.md"), Some(&'D'));
        let src = child_statuses(porcelain, "src");
        assert_eq!(src.get("a.ts"), Some(&'M'));
        assert_eq!(src.get("new"), Some(&'A'));
        assert_eq!(src.get("README.md"), None);
    }

    /// A file that another process consumes (reads and deletes) the moment it appears must not turn a finished write into an error:
    /// the e2e `cf` scenario hands commands to its driver through such a file (`.cf-cmd`) and once failed with
    /// `.cf-cmd: No such file or directory` because the mtime was read back from the path after the rename.
    #[test]
    fn a_file_consumed_right_after_the_rename_is_still_a_successful_write() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let full = root.join(".cmd");
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let eater = {
            let (full, stop) = (full.clone(), stop.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let _ = fs::remove_file(&full);
                    std::thread::yield_now();
                }
            })
        };
        for i in 0..800 {
            while full.exists() {
                std::thread::yield_now();
            }
            let r = write_file_sync(&full, &root, ".cmd", format!("line {i}\n").as_bytes(), 0.0);
            assert!(r.is_ok(), "write {i} failed: {:?}", r.err());
        }
        stop.store(true, Ordering::Relaxed);
        eater.join().unwrap();
    }
}
