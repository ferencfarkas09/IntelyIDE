//! Walking and copying `remote-web/dist` (spec 4.12.2). The tree is treated as untrusted input: nothing is followed, nothing odd is
//! copied, and every refusal names the rule (`BundleError::Stage { code, path }`). The walk order is the one of
//! `listFiles` in `bundle-lib.mjs`: depth first, the entries of each directory sorted by UTF-16 code units.

use std::fs;
use std::io::Read;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use crate::error::{BundleError, Result};
use crate::manifest::{sha256_hex, valid_path, FileEntry, MANIFEST_NAME};

/// Caps for one stage run. The defaults are Cloudflare's static asset limits (20,000 files, 25 MiB per file) and a total budget.
#[derive(Debug, Clone)]
pub struct Limits {
    pub max_files: usize,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_files: 20_000, max_file_bytes: 25 * 1024 * 1024, max_total_bytes: 256 * 1024 * 1024 }
    }
}

const MAX_DEPTH: usize = 16;
/// Extensions that may be published (lower case). `_headers` is the one extension-less name that is allowed.
const ALLOWED_EXT: [&str; 11] = ["html", "js", "css", "json", "svg", "png", "webp", "ico", "woff2", "txt", "webmanifest"];
const HEADERS_FILE: &str = "_headers";
pub const PUSH_CONFIG: &str = "push-config.json";

fn refuse(code: &'static str, path: &str) -> BundleError {
    BundleError::Stage { code, path: path.to_owned() }
}

/// A file found by the walk (nothing has been read yet): path relative to the root, where it is, and its `lstat` result.
#[derive(Debug, Clone)]
pub struct Found {
    pub rel: String,
    pub abs: PathBuf,
    pub meta: fs::Metadata,
}

/// Name rules for one path component (file or directory). `rel` is only used in the error.
fn check_component(name: &str, rel: &str) -> Result<()> {
    if name.starts_with('.') {
        return Err(refuse("dotfile", rel));
    }
    if name.is_empty() || name.len() > 255 || !name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) {
        return Err(refuse("name", rel));
    }
    Ok(())
}

/// Extra rules for a file name: secret-looking names and the extension allow-list.
fn check_file_name(name: &str, rel: &str) -> Result<()> {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with("id_") || lower.starts_with(".env") || lower.ends_with(".pem") || lower.ends_with(".key") || lower.ends_with(".p12") {
        return Err(refuse("secretName", rel));
    }
    if name == HEADERS_FILE {
        return Ok(());
    }
    match lower.rsplit_once('.') {
        Some((_, ext)) if ALLOWED_EXT.contains(&ext) => Ok(()),
        _ => Err(refuse("extension", rel)),
    }
}

/// What the walk skips at the root.
#[derive(Debug, Clone, Copy)]
pub struct Skip {
    /// The root `push-config.json` (the stager writes its own).
    pub push_config: bool,
}

/// Walks `root` with `lstat`, applying every stage rule, and returns the files in manifest order (the root `bundle.json` is skipped).
pub fn walk(root: &Path, limits: &Limits, skip: Skip) -> Result<Vec<Found>> {
    let meta = fs::symlink_metadata(root).map_err(|e| BundleError::Io(format!("cannot read the build directory: {e}")))?;
    if meta.file_type().is_symlink() {
        return Err(refuse("symlink", "."));
    }
    if !meta.is_dir() {
        return Err(BundleError::Invalid("the build path is not a directory".into()));
    }
    let mut out = Vec::new();
    let mut total = 0u64;
    walk_dir(root, "", 0, limits, skip, &mut out, &mut total)?;
    Ok(out)
}

fn walk_dir(dir: &Path, rel: &str, depth: usize, limits: &Limits, skip: Skip, out: &mut Vec<Found>, total: &mut u64) -> Result<()> {
    if depth > MAX_DEPTH {
        return Err(refuse("depth", rel));
    }
    let mut names = Vec::new();
    for e in fs::read_dir(dir)? {
        let name = e?.file_name().into_string().map_err(|_| refuse("name", rel))?;
        names.push(name);
    }
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    for name in names {
        let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        check_component(&name, &child_rel)?;
        let abs = dir.join(&name);
        let meta = fs::symlink_metadata(&abs)?;
        let ft = meta.file_type();
        if ft.is_symlink() {
            return Err(refuse("symlink", &child_rel));
        } else if ft.is_dir() {
            walk_dir(&abs, &child_rel, depth + 1, limits, skip, out, total)?;
        } else if ft.is_file() {
            if depth == 0 && (child_rel == MANIFEST_NAME || (skip.push_config && child_rel == PUSH_CONFIG)) {
                continue;
            }
            if meta.nlink() > 1 {
                return Err(refuse("hardlink", &child_rel));
            }
            check_file_name(&name, &child_rel)?;
            if !valid_path(&child_rel) {
                return Err(refuse("name", &child_rel));
            }
            if out.len() >= limits.max_files {
                return Err(refuse("tooManyFiles", &child_rel));
            }
            if meta.len() > limits.max_file_bytes {
                return Err(refuse("fileTooBig", &child_rel));
            }
            *total += meta.len();
            if *total > limits.max_total_bytes {
                return Err(refuse("totalTooBig", &child_rel));
            }
            out.push(Found { rel: child_rel, abs, meta });
        } else {
            return Err(refuse("special", &child_rel));
        }
    }
    Ok(())
}

/// Reads and hashes every found file (each is re-checked against its `lstat`), in the order given.
pub fn entries(found: &[Found], limits: &Limits) -> Result<Vec<FileEntry>> {
    found
        .iter()
        .map(|f| {
            let bytes = read_regular(&f.abs, &f.meta, limits.max_file_bytes, &f.rel)?;
            Ok(FileEntry { path: f.rel.clone(), sha256: sha256_hex(&bytes), size: bytes.len() as u64 })
        })
        .collect()
}

/// Opens the file the walk just `lstat`ed and checks that it is still that file (same device and inode, one link), so a path swapped
/// for a symlink between the check and the read is caught.
pub fn read_regular(abs: &Path, expected: &fs::Metadata, max: u64, rel: &str) -> Result<Vec<u8>> {
    let mut f = fs::OpenOptions::new().read(true).open(abs)?;
    let m = f.metadata()?;
    if !m.is_file() || m.dev() != expected.dev() || m.ino() != expected.ino() || m.nlink() > 1 {
        return Err(refuse("changed", rel));
    }
    let mut buf = Vec::with_capacity(m.len().min(max) as usize);
    (&mut f).take(max + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > max {
        return Err(refuse("fileTooBig", rel));
    }
    Ok(buf)
}

/// Creates a directory (and parents) with mode 0700.
pub fn create_dir_private(path: &Path) -> Result<()> {
    fs::DirBuilder::new().recursive(true).mode(0o700).create(path)?;
    Ok(())
}

/// Writes a new file (never overwrites, never follows a link), mode 0644: the staged files are public by design.
pub fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o644).open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}
