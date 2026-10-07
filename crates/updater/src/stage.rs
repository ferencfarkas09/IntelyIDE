//! Stage directory lifecycle, hardened `.app.tar.gz` extraction and the tree hash
//! ((design notes: updater-spec) 4.11 P4/P5/A2, 6.2 T10/T11/T21).
//!
//! Nothing here trusts the archive:
//! - the tar stream is parsed by this module (only `tar::Header` decodes a 512-byte block), so
//!   extension headers (GNU long name, pax) are size-capped before they are read and the whole
//!   decompressed stream is capped;
//! - every entry path is checked lexically (no absolute path, no `.`/`..`, no NUL or control
//!   character, one fixed top-level directory, depth and length limits) and then created by walking
//!   its parent components with `openat(O_NOFOLLOW | O_DIRECTORY)` from the stage root descriptor,
//!   so a path that passes through ANY symlink (also one created earlier in the same archive) is
//!   refused;
//! - a symlink target must be relative and may contain no `..` component at all (by induction no
//!   chain of such links can leave the bundle); after the unpack the tree is walked and every
//!   symlink is resolved physically, as a belt-and-braces check;
//! - only regular files, directories and symlinks are accepted; hard links, device nodes, FIFOs,
//!   sparse and contiguous entries are refused; setuid, setgid and sticky bits are masked off;
//!   extended attributes are never restored;
//! - the tree hash is built from a virtual tree while streaming, so it can be computed from the
//!   signed tarball without writing anything (A2) and compared with the hash of the stage on disk.
//!
//! Tree hash (spec 4.11 P5): SHA-256 over the lines of all entries sorted by relative path (the
//! bundle directory itself has the empty path), each line
//! `kind NUL path NUL mode NUL size NUL digest LF` with `kind` in `d`/`f`/`l`, `mode` the
//! permission bits `& 0o777` after normalisation as four octal digits, `size` the byte count of a
//! regular file (`0` otherwise), `digest` the lowercase hex SHA-256 of a regular file's content or
//! the target text of a symlink (empty for a directory). Symlinks always carry mode `0777` (their
//! permission bits mean nothing on macOS and depend on the umask). No timestamps, owners or
//! extended attributes enter the hash.
//!
//! Mode normalisation (identical while streaming and while unpacking): `& 0o777`, and a regular
//! file gets at least `0400`, a directory at least `0700`, so that the updater itself can always
//! read and later delete what it extracted.

use std::collections::{BTreeMap, VecDeque};
use std::ffi::{CString, OsString};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use flate2::read::GzDecoder;
use ring::digest;
use tar::EntryType;

use crate::limits;
use crate::{ErrorCode, UpdateError};

/// Stage directory name: `<STAGE_PREFIX><16 lowercase hex>` beside the installed app.
pub const STAGE_PREFIX: &str = ".IntelyIDE.update-";
/// A stage directory is only ever deleted when it contains this regular file.
pub const STAGE_MARKER: &str = ".intely-update-stage";

/// Longest GNU long name / long link / pax extension block this module reads.
const EXT_MAX_BYTES: u64 = 64 * 1024;
const MAX_COMPONENT_BYTES: usize = 255;
const MAX_LINK_TARGET_BYTES: usize = 1024;
const SYMLINK_HOPS: usize = 40;

// ------------------------------------------------------------------------------------------
// Limits and results
// ------------------------------------------------------------------------------------------

/// The unpack limits of spec 4.6. The default is the table of `limits.rs`; tests pass smaller
/// values to hit a boundary without writing 50,000 files.
#[derive(Clone, Debug)]
pub struct Limits {
    /// Files + directories + symlinks (implicit parent directories count, the bundle directory does not).
    pub max_entries: usize,
    pub max_path_bytes: usize,
    /// Number of path components including the bundle directory.
    pub max_depth: usize,
    pub max_unpacked_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_entries: limits::UNPACK_MAX_ENTRIES,
            max_path_bytes: limits::UNPACK_MAX_PATH_BYTES,
            max_depth: limits::UNPACK_MAX_DEPTH,
            max_unpacked_bytes: limits::UNPACKED_MAX_BYTES,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeSummary {
    /// Lowercase hex SHA-256, see the module comment.
    pub tree_hash: String,
    pub entries: usize,
    /// Sum of the sizes of all regular files.
    pub bytes: u64,
}

#[derive(Clone, Debug)]
pub struct Unpacked {
    /// `<stage dir>/<bundle dir name>`
    pub root: PathBuf,
    pub summary: TreeSummary,
}

// ------------------------------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------------------------------

fn bad(detail: &str) -> UpdateError {
    UpdateError::with(ErrorCode::BadArchive, detail)
}

fn unsafe_entry(detail: &str) -> UpdateError {
    UpdateError::with(ErrorCode::UnsafeEntry, detail)
}

pub(crate) fn random_hex(bytes: usize) -> Result<String, UpdateError> {
    use ring::rand::SecureRandom;
    let mut buf = vec![0u8; bytes];
    ring::rand::SystemRandom::new().fill(&mut buf).map_err(|_| bad("no random source"))?;
    Ok(hex::encode(buf))
}

/// The effective uid of this process.
pub(crate) fn euid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

fn sha256_hex(ctx: digest::Context) -> String {
    hex::encode(ctx.finish().as_ref())
}

/// Maps an I/O error from the file system to an error code.
fn map_fs_err(e: &io::Error) -> UpdateError {
    match e.raw_os_error() {
        Some(libc::ELOOP) | Some(libc::ENOTDIR) | Some(libc::ENAMETOOLONG) => unsafe_entry("path passes through a link or is invalid"),
        Some(libc::ENOSPC) | Some(libc::EDQUOT) => UpdateError::new(ErrorCode::NoSpace),
        Some(libc::EEXIST) => bad("entry exists already"),
        Some(libc::EACCES) | Some(libc::EPERM) => UpdateError::with(ErrorCode::NotWritable, "not writable"),
        Some(libc::EROFS) => UpdateError::new(ErrorCode::ReadOnlyVolume),
        Some(n) => UpdateError::with(ErrorCode::BadArchive, format!("io error {n}")),
        None => bad("io error"),
    }
}

/// Raised by the cap reader when the decompressed stream is longer than any valid archive.
#[derive(Debug)]
struct CapExceeded;

impl std::fmt::Display for CapExceeded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("decompressed stream exceeds the cap")
    }
}

impl std::error::Error for CapExceeded {}

fn map_read_err(e: io::Error) -> UpdateError {
    if e.get_ref().map(|inner| inner.is::<CapExceeded>()).unwrap_or(false) {
        return UpdateError::with(ErrorCode::BombSize, "decompressed stream too long");
    }
    if e.kind() == io::ErrorKind::UnexpectedEof {
        return bad("truncated archive");
    }
    bad("unreadable archive")
}

/// Limits the number of bytes read from the (decompressing) inner reader; exceeding it is an error,
/// not an EOF, so a gzip bomb cannot pose as a short archive.
struct CapReader<R> {
    inner: R,
    left: u64,
}

impl<R: Read> Read for CapReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.left == 0 {
            let mut one = [0u8; 1];
            return match self.inner.read(&mut one)? {
                0 => Ok(0),
                _ => Err(io::Error::new(io::ErrorKind::Other, CapExceeded)),
            };
        }
        let want = (buf.len() as u64).min(self.left) as usize;
        let n = self.inner.read(&mut buf[..want])?;
        self.left -= n as u64;
        Ok(n)
    }
}

// ------------------------------------------------------------------------------------------
// The virtual tree and the tree hash
// ------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum NodeKind {
    Dir { explicit: bool },
    File { size: u64, digest: String },
    Symlink { target: String },
}

#[derive(Clone, Debug)]
struct Node {
    kind: NodeKind,
    mode: u32,
}

#[derive(Default)]
struct Tree {
    nodes: BTreeMap<String, Node>,
    /// Case-folded path -> the exact path that claimed it: default APFS is case-insensitive, so
    /// `a/` and `A/` would merge on disk while the virtual tree (and its hash) keeps them apart.
    folded: BTreeMap<String, String>,
    /// Nodes except the root.
    entries: usize,
    bytes: u64,
}

fn normalize_file_mode(mode: u32) -> u32 {
    (mode & 0o777) | 0o400
}

fn normalize_dir_mode(mode: u32) -> u32 {
    (mode & 0o777) | 0o700
}

const SYMLINK_MODE: u32 = 0o777;

impl Tree {
    /// Refuses a new path that differs from an earlier one only by case.
    fn claim(&mut self, key: &str) -> Result<(), UpdateError> {
        match self.folded.insert(key.to_lowercase(), key.to_string()) {
            Some(prev) if prev != key => Err(unsafe_entry("two paths differ only by case")),
            _ => Ok(()),
        }
    }

    fn summary(&self) -> TreeSummary {
        let mut ctx = digest::Context::new(&digest::SHA256);
        for (path, node) in &self.nodes {
            let (kind, size, d): (&str, u64, &str) = match &node.kind {
                NodeKind::Dir { .. } => ("d", 0, ""),
                NodeKind::File { size, digest } => ("f", *size, digest.as_str()),
                NodeKind::Symlink { target } => ("l", 0, target.as_str()),
            };
            let line = format!("{kind}\0{path}\0{:04o}\0{size}\0{d}\n", node.mode & 0o777);
            ctx.update(line.as_bytes());
        }
        TreeSummary { tree_hash: sha256_hex(ctx), entries: self.entries, bytes: self.bytes }
    }
}

// ------------------------------------------------------------------------------------------
// Entry path rules
// ------------------------------------------------------------------------------------------

fn has_control(s: &str) -> bool {
    s.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
}

fn is_decomposing_char(c: char) -> bool {
    matches!(c as u32, 0x0300..=0x036F | 0x1100..=0x11FF | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F)
}

/// Splits an archive path into the components below the bundle directory.
fn split_entry_path(raw: &[u8], is_dir: bool, bundle_dir: &str, lim: &Limits) -> Result<Vec<String>, UpdateError> {
    if raw.is_empty() {
        return Err(unsafe_entry("empty path"));
    }
    if raw.len() > lim.max_path_bytes {
        return Err(unsafe_entry("path too long"));
    }
    let text = std::str::from_utf8(raw).map_err(|_| unsafe_entry("path is not UTF-8"))?;
    if has_control(text) {
        return Err(unsafe_entry("control character in path"));
    }
    if text.starts_with('/') {
        return Err(unsafe_entry("absolute path"));
    }
    let text = match text.strip_suffix('/') {
        Some(t) if is_dir => t,
        Some(_) => return Err(unsafe_entry("trailing slash on a non-directory")),
        None => text,
    };
    let mut comps: Vec<String> = Vec::new();
    for c in text.split('/') {
        if c.is_empty() || c == "." || c == ".." {
            return Err(unsafe_entry("empty, '.' or '..' path component"));
        }
        if c.len() > MAX_COMPONENT_BYTES {
            return Err(unsafe_entry("path component too long"));
        }
        // HFS+/APFS treat NFC and NFD spellings as one name; without a normalisation table here,
        // refuse the decomposed forms (combining marks, Hangul jamo) so no two names can collide.
        if c.chars().any(is_decomposing_char) {
            return Err(unsafe_entry("decomposed unicode in path"));
        }
        comps.push(c.to_string());
    }
    if comps.len() > lim.max_depth {
        return Err(unsafe_entry("path too deep"));
    }
    if comps[0] != bundle_dir {
        return Err(unsafe_entry("entry outside the bundle directory"));
    }
    comps.remove(0);
    Ok(comps)
}

/// A symlink target: relative, no `..` component, no control character.
fn validate_link_target(raw: &[u8]) -> Result<String, UpdateError> {
    if raw.is_empty() || raw.len() > MAX_LINK_TARGET_BYTES {
        return Err(unsafe_entry("symlink target empty or too long"));
    }
    let text = std::str::from_utf8(raw).map_err(|_| unsafe_entry("symlink target is not UTF-8"))?;
    if has_control(text) {
        return Err(unsafe_entry("control character in symlink target"));
    }
    if text.starts_with('/') {
        return Err(unsafe_entry("absolute symlink target"));
    }
    if text.split('/').any(|c| c == "..") {
        return Err(unsafe_entry("symlink target contains '..'"));
    }
    Ok(text.to_string())
}

fn validate_bundle_dir_name(name: &str) -> Result<(), UpdateError> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || has_control(name) || name.len() > MAX_COMPONENT_BYTES {
        return Err(unsafe_entry("invalid bundle directory name"));
    }
    Ok(())
}

// ------------------------------------------------------------------------------------------
// Tar stream parsing
// ------------------------------------------------------------------------------------------

const BLOCK: usize = 512;

fn read_block<R: Read>(r: &mut R) -> Result<Option<[u8; BLOCK]>, UpdateError> {
    let mut buf = [0u8; BLOCK];
    let mut got = 0;
    while got < BLOCK {
        let n = r.read(&mut buf[got..]).map_err(map_read_err)?;
        if n == 0 {
            return if got == 0 { Ok(None) } else { Err(bad("truncated archive")) };
        }
        got += n;
    }
    Ok(Some(buf))
}

fn skip_padding<R: Read>(r: &mut R, size: u64) -> Result<(), UpdateError> {
    let pad = ((BLOCK as u64) - size % BLOCK as u64) % BLOCK as u64;
    if pad > 0 {
        let mut buf = [0u8; BLOCK];
        r.read_exact(&mut buf[..pad as usize]).map_err(map_read_err)?;
    }
    Ok(())
}

fn read_ext_data<R: Read>(r: &mut R, size: u64) -> Result<Vec<u8>, UpdateError> {
    if size > EXT_MAX_BYTES {
        return Err(bad("extension header too large"));
    }
    let mut v = vec![0u8; size as usize];
    r.read_exact(&mut v).map_err(map_read_err)?;
    skip_padding(r, size)?;
    Ok(v)
}

fn checksum_ok(block: &[u8; BLOCK], header: &tar::Header) -> bool {
    let stored = match header.cksum() {
        Ok(v) => v,
        Err(_) => return false,
    };
    let (mut unsigned, mut signed) = (0u32, 0i32);
    for (i, &b) in block.iter().enumerate() {
        let b = if (148..156).contains(&i) { b' ' } else { b };
        unsigned += b as u32;
        signed += b as i8 as i32;
    }
    stored == unsigned || (signed >= 0 && stored == signed as u32)
}

#[derive(Default)]
struct Pax {
    path: Option<Vec<u8>>,
    linkpath: Option<Vec<u8>>,
    size: Option<u64>,
}

/// Parses the pax records this module cares about (`path`, `linkpath`, `size`); every other
/// record (times, owners, `SCHILY.xattr.*`, `LIBARCHIVE.*`) is ignored and never applied.
fn parse_pax(data: &[u8]) -> Result<Pax, UpdateError> {
    let mut pax = Pax::default();
    let mut i = 0;
    while i < data.len() {
        let sp = data[i..].iter().position(|&b| b == b' ').ok_or_else(|| bad("bad pax record"))?;
        let len: usize = std::str::from_utf8(&data[i..i + sp]).ok().and_then(|s| s.parse().ok()).ok_or_else(|| bad("bad pax length"))?;
        let end = i.checked_add(len).filter(|&e| len > sp + 1 && e <= data.len());
        let end = match end {
            Some(e) if data[e - 1] == b'\n' => e,
            _ => return Err(bad("bad pax record")),
        };
        let rec = &data[i + sp + 1..end - 1];
        let eq = rec.iter().position(|&b| b == b'=').ok_or_else(|| bad("bad pax record"))?;
        let (key, value) = (&rec[..eq], &rec[eq + 1..]);
        match key {
            b"path" => {
                if pax.path.replace(value.to_vec()).is_some() {
                    return Err(bad("duplicate pax path"));
                }
            }
            b"linkpath" => {
                if pax.linkpath.replace(value.to_vec()).is_some() {
                    return Err(bad("duplicate pax linkpath"));
                }
            }
            b"size" => {
                let v = std::str::from_utf8(value).ok().and_then(|s| s.parse::<u64>().ok()).ok_or_else(|| bad("bad pax size"))?;
                if pax.size.replace(v).is_some() {
                    return Err(bad("duplicate pax size"));
                }
            }
            _ => {}
        }
        i = end;
    }
    Ok(pax)
}

// ------------------------------------------------------------------------------------------
// The sink abstraction: scan (hash only) and disk (hardened unpack)
// ------------------------------------------------------------------------------------------

trait Sink {
    /// Create (or re-mode) a directory. `rel` is empty for the bundle directory itself.
    fn mkdir(&mut self, rel: &[String], mode: u32) -> Result<(), UpdateError>;
    /// Consume exactly `size` bytes of `src`, return the hex SHA-256 of the content.
    fn file(&mut self, rel: &[String], mode: u32, size: u64, src: &mut dyn Read) -> Result<String, UpdateError>;
    fn symlink(&mut self, rel: &[String], target: &str) -> Result<(), UpdateError>;
}

fn copy_hash(src: &mut dyn Read, size: u64, mut dst: Option<&mut File>) -> Result<String, UpdateError> {
    let mut ctx = digest::Context::new(&digest::SHA256);
    let mut buf = vec![0u8; (size.min(64 * 1024) as usize).max(1)];
    let mut done = 0u64;
    loop {
        let n = src.read(&mut buf).map_err(map_read_err)?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
        if let Some(d) = dst.as_deref_mut() {
            d.write_all(&buf[..n]).map_err(|e| map_fs_err(&e))?;
        }
        done += n as u64;
    }
    if done != size {
        return Err(bad("truncated archive"));
    }
    Ok(sha256_hex(ctx))
}

struct ScanSink;

impl Sink for ScanSink {
    fn mkdir(&mut self, _rel: &[String], _mode: u32) -> Result<(), UpdateError> {
        Ok(())
    }
    fn file(&mut self, _rel: &[String], _mode: u32, size: u64, src: &mut dyn Read) -> Result<String, UpdateError> {
        copy_hash(src, size, None)
    }
    fn symlink(&mut self, _rel: &[String], _target: &str) -> Result<(), UpdateError> {
        Ok(())
    }
}

// ---- the descriptor-based writer -----------------------------------------------------------

fn cstr(s: &str) -> Result<CString, UpdateError> {
    CString::new(s).map_err(|_| unsafe_entry("NUL in path"))
}

fn open_dir_at(parent: RawFd, name: &str) -> Result<OwnedFd, UpdateError> {
    let c = cstr(name)?;
    // SAFETY: `c` is a valid NUL-terminated string that outlives the call; `parent` is a live
    // descriptor owned by the caller. O_NOFOLLOW|O_DIRECTORY make a symlink component an error.
    let fd = unsafe { libc::openat(parent, c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(map_fs_err(&io::Error::last_os_error()));
    }
    // SAFETY: `fd` was just returned by openat and is owned by nobody else.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn mkdir_at(parent: RawFd, name: &str) -> Result<(), io::Error> {
    let c = CString::new(name).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
    // SAFETY: valid C string, live descriptor.
    let rc = unsafe { libc::mkdirat(parent, c.as_ptr(), 0o700) };
    if rc < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn create_file_at(parent: RawFd, name: &str) -> Result<File, UpdateError> {
    let c = cstr(name)?;
    // SAFETY: valid C string, live descriptor. O_EXCL|O_NOFOLLOW: never reuse or follow anything.
    let fd = unsafe {
        libc::openat(parent, c.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600 as libc::c_uint)
    };
    if fd < 0 {
        return Err(map_fs_err(&io::Error::last_os_error()));
    }
    // SAFETY: `fd` was just returned by openat and is owned by nobody else.
    Ok(File::from(unsafe { OwnedFd::from_raw_fd(fd) }))
}

fn symlink_at(target: &str, parent: RawFd, name: &str) -> Result<(), UpdateError> {
    let t = cstr(target)?;
    let n = cstr(name)?;
    // SAFETY: valid C strings, live descriptor.
    let rc = unsafe { libc::symlinkat(t.as_ptr(), parent, n.as_ptr()) };
    if rc < 0 {
        return Err(map_fs_err(&io::Error::last_os_error()));
    }
    Ok(())
}

struct DiskSink {
    stage: OwnedFd,
    root_name: String,
    root: Option<OwnedFd>,
    /// Open descriptors of the directory chain of the previous entry (below the root).
    cache: Vec<(String, OwnedFd)>,
    created_root: bool,
}

impl DiskSink {
    fn root_fd(&self) -> Result<RawFd, UpdateError> {
        self.root.as_ref().map(|f| f.as_raw_fd()).ok_or_else(|| bad("bundle directory not created"))
    }

    fn parent_fd(&mut self, parent: &[String]) -> Result<RawFd, UpdateError> {
        let mut common = 0;
        while common < parent.len() && common < self.cache.len() && self.cache[common].0 == parent[common] {
            common += 1;
        }
        self.cache.truncate(common);
        for name in &parent[common..] {
            let at = match self.cache.last() {
                Some((_, fd)) => fd.as_raw_fd(),
                None => self.root_fd()?,
            };
            let fd = open_dir_at(at, name)?;
            self.cache.push((name.clone(), fd));
        }
        match self.cache.last() {
            Some((_, fd)) => Ok(fd.as_raw_fd()),
            None => self.root_fd(),
        }
    }
}

fn set_mode(f: File, mode: u32) -> Result<(), UpdateError> {
    f.set_permissions(fs::Permissions::from_mode(mode)).map_err(|e| map_fs_err(&e))
}

impl Sink for DiskSink {
    fn mkdir(&mut self, rel: &[String], mode: u32) -> Result<(), UpdateError> {
        let mode = normalize_dir_mode(mode);
        if rel.is_empty() {
            if self.root.is_none() {
                mkdir_at(self.stage.as_raw_fd(), &self.root_name).map_err(|e| map_fs_err(&e))?;
                self.created_root = true;
                self.root = Some(open_dir_at(self.stage.as_raw_fd(), &self.root_name)?);
            }
            let fd = self.root.as_ref().expect("root exists").try_clone().map_err(|e| map_fs_err(&e))?;
            return set_mode(File::from(fd), mode);
        }
        let (name, parents) = rel.split_last().expect("non-empty");
        let parent = self.parent_fd(parents)?;
        match mkdir_at(parent, name) {
            Ok(()) => {}
            Err(e) if e.raw_os_error() == Some(libc::EEXIST) => {}
            Err(e) => return Err(map_fs_err(&e)),
        }
        let fd = open_dir_at(parent, name)?;
        set_mode(File::from(fd), mode)
    }

    fn file(&mut self, rel: &[String], mode: u32, size: u64, src: &mut dyn Read) -> Result<String, UpdateError> {
        let (name, parents) = rel.split_last().ok_or_else(|| unsafe_entry("file at the bundle root path"))?;
        let parent = self.parent_fd(parents)?;
        let mut f = create_file_at(parent, name)?;
        let digest = copy_hash(src, size, Some(&mut f))?;
        set_mode(f, normalize_file_mode(mode))?;
        Ok(digest)
    }

    fn symlink(&mut self, rel: &[String], target: &str) -> Result<(), UpdateError> {
        let (name, parents) = rel.split_last().ok_or_else(|| unsafe_entry("symlink at the bundle root path"))?;
        let parent = self.parent_fd(parents)?;
        symlink_at(target, parent, name)
    }
}

// ------------------------------------------------------------------------------------------
// The shared entry loop
// ------------------------------------------------------------------------------------------

fn count_new(tree: &mut Tree, lim: &Limits) -> Result<(), UpdateError> {
    if tree.entries >= lim.max_entries {
        return Err(UpdateError::with(ErrorCode::BombEntries, "too many entries"));
    }
    tree.entries += 1;
    Ok(())
}

/// Creates the implicit parent directories of `parent` (mode 0755) and refuses a parent that is a
/// file or a symlink.
fn ensure_parents(tree: &mut Tree, sink: &mut dyn Sink, parent: &[String], lim: &Limits) -> Result<(), UpdateError> {
    for i in 1..=parent.len() {
        let prefix = &parent[..i];
        let key = prefix.join("/");
        match tree.nodes.get(&key) {
            Some(Node { kind: NodeKind::Dir { .. }, .. }) => {}
            Some(_) => return Err(unsafe_entry("entry below a file or a link")),
            None => {
                tree.claim(&key)?;
                count_new(tree, lim)?;
                sink.mkdir(prefix, 0o755)?;
                tree.nodes.insert(key, Node { kind: NodeKind::Dir { explicit: false }, mode: 0o755 });
            }
        }
    }
    Ok(())
}

fn process<R: Read>(reader: R, bundle_dir: &str, lim: &Limits, sink: &mut dyn Sink) -> Result<Tree, UpdateError> {
    // Header + padding overhead of every entry, plus extension blocks, on top of the file bytes.
    let overhead = (lim.max_entries as u64).saturating_mul(4 * BLOCK as u64).saturating_add(1024 * 1024);
    let mut r = CapReader { inner: GzDecoder::new(reader), left: lim.max_unpacked_bytes.saturating_add(overhead) };

    let mut tree = Tree::default();
    sink.mkdir(&[], 0o755)?;
    tree.nodes.insert(String::new(), Node { kind: NodeKind::Dir { explicit: false }, mode: 0o755 });

    let mut long_name: Option<Vec<u8>> = None;
    let mut long_link: Option<Vec<u8>> = None;
    let mut pax: Option<Pax> = None;

    while let Some(block) = read_block(&mut r)? {
        if block.iter().all(|&b| b == 0) {
            break;
        }
        let header = tar::Header::from_byte_slice(&block);
        if !checksum_ok(&block, header) {
            return Err(bad("bad header checksum"));
        }
        let mut size = header.entry_size().map_err(|_| bad("bad entry size"))?;
        let et = header.entry_type();

        match et {
            EntryType::GNULongName | EntryType::GNULongLink | EntryType::XHeader => {
                let mut data = read_ext_data(&mut r, size)?;
                match et {
                    EntryType::GNULongName => {
                        while data.last() == Some(&0) {
                            data.pop();
                        }
                        if long_name.replace(data).is_some() {
                            return Err(bad("two long names for one entry"));
                        }
                    }
                    EntryType::GNULongLink => {
                        while data.last() == Some(&0) {
                            data.pop();
                        }
                        if long_link.replace(data).is_some() {
                            return Err(bad("two long links for one entry"));
                        }
                    }
                    _ => {
                        if pax.replace(parse_pax(&data)?).is_some() {
                            return Err(bad("two pax headers for one entry"));
                        }
                    }
                }
                continue;
            }
            EntryType::XGlobalHeader => return Err(bad("global pax header")),
            _ => {}
        }

        let (is_file, is_dir) = match et {
            EntryType::Regular => (true, false),
            EntryType::Directory => (false, true),
            EntryType::Symlink => (false, false),
            EntryType::Link | EntryType::Char | EntryType::Block | EntryType::Fifo | EntryType::Continuous | EntryType::GNUSparse => {
                return Err(unsafe_entry("hard link, device, FIFO or sparse entry"));
            }
            _ => return Err(bad("unknown entry type")),
        };

        let pax_now = pax.take();
        if let Some(s) = pax_now.as_ref().and_then(|p| p.size) {
            size = s;
        }
        let path_raw: Vec<u8> = pax_now
            .as_ref()
            .and_then(|p| p.path.clone())
            .or_else(|| long_name.take())
            .unwrap_or_else(|| header.path_bytes().into_owned());
        long_name = None;
        let link_raw: Option<Vec<u8>> = pax_now
            .as_ref()
            .and_then(|p| p.linkpath.clone())
            .or_else(|| long_link.take())
            .or_else(|| header.link_name_bytes().map(|c| c.into_owned()));
        long_link = None;
        let mode = header.mode().map_err(|_| bad("bad mode"))? & 0o777;

        let rel = split_entry_path(&path_raw, is_dir, bundle_dir, lim)?;

        if is_file {
            if tree.bytes.checked_add(size).map_or(true, |t| t > lim.max_unpacked_bytes) {
                return Err(UpdateError::with(ErrorCode::BombSize, "unpacked size over the limit"));
            }
        } else if size != 0 {
            return Err(bad("directory or link with data"));
        }

        if rel.is_empty() {
            // The bundle directory itself.
            if !is_dir {
                return Err(unsafe_entry("the bundle directory name is used by a file or a link"));
            }
            let root = tree.nodes.get_mut("").expect("root exists");
            if matches!(root.kind, NodeKind::Dir { explicit: true }) {
                return Err(bad("duplicate bundle directory entry"));
            }
            root.kind = NodeKind::Dir { explicit: true };
            root.mode = normalize_dir_mode(mode);
            sink.mkdir(&[], mode)?;
            continue;
        }

        let (_, parents) = rel.split_last().expect("non-empty");
        ensure_parents(&mut tree, sink, parents, lim)?;
        let key = rel.join("/");
        // Some(true): an implicit directory; Some(false): anything else that exists.
        let existing = tree.nodes.get(&key).map(|n| matches!(n.kind, NodeKind::Dir { explicit: false }));

        if is_dir {
            match existing {
                Some(true) => {
                    // An implicit parent becomes an explicit entry: only its mode changes.
                    sink.mkdir(&rel, mode)?;
                    let n = tree.nodes.get_mut(&key).expect("exists");
                    n.kind = NodeKind::Dir { explicit: true };
                    n.mode = normalize_dir_mode(mode);
                }
                Some(false) => return Err(bad("duplicate entry")),
                None => {
                    tree.claim(&key)?;
                    count_new(&mut tree, lim)?;
                    sink.mkdir(&rel, mode)?;
                    tree.nodes.insert(key, Node { kind: NodeKind::Dir { explicit: true }, mode: normalize_dir_mode(mode) });
                }
            }
        } else if is_file {
            if existing.is_some() {
                return Err(bad("duplicate entry"));
            }
            tree.claim(&key)?;
            count_new(&mut tree, lim)?;
            let mut limited = (&mut r).take(size);
            let digest = sink.file(&rel, mode, size, &mut limited)?;
            if limited.limit() != 0 {
                return Err(bad("file data not consumed"));
            }
            skip_padding(&mut r, size)?;
            tree.bytes += size;
            tree.nodes.insert(key, Node { kind: NodeKind::File { size, digest }, mode: normalize_file_mode(mode) });
        } else {
            if existing.is_some() {
                return Err(bad("duplicate entry"));
            }
            let target = validate_link_target(&link_raw.ok_or_else(|| unsafe_entry("symlink without target"))?)?;
            tree.claim(&key)?;
            count_new(&mut tree, lim)?;
            sink.symlink(&rel, &target)?;
            tree.nodes.insert(key, Node { kind: NodeKind::Symlink { target }, mode: SYMLINK_MODE });
        }
    }

    if long_name.is_some() || long_link.is_some() || pax.is_some() {
        return Err(bad("extension header without an entry"));
    }
    if tree.entries == 0 {
        return Err(bad("empty archive"));
    }
    Ok(tree)
}

// ------------------------------------------------------------------------------------------
// Public API: streaming hash, unpack, disk hash, symlink walk
// ------------------------------------------------------------------------------------------

/// Computes the tree hash of a `.app.tar.gz` stream without writing anything (spec A2): the same
/// path, link and size rules as `unpack` apply, so a tarball that `unpack` refuses is refused here.
pub fn tree_hash_of_tarball<R: Read>(tar_gz: R, bundle_dir_name: &str, lim: &Limits) -> Result<TreeSummary, UpdateError> {
    validate_bundle_dir_name(bundle_dir_name)?;
    Ok(process(tar_gz, bundle_dir_name, lim, &mut ScanSink)?.summary())
}

/// Unpacks a `.app.tar.gz` stream into `<stage_dir>/<bundle_dir_name>` under the rules of the module
/// comment. `stage_dir` must exist (see `create_stage_dir`); `<bundle_dir_name>` inside it must not.
/// On any error the partially extracted bundle directory is removed again (the caller removes the
/// stage directory itself).
pub fn unpack<R: Read>(tar_gz: R, stage_dir: &Path, bundle_dir_name: &str, lim: &Limits) -> Result<Unpacked, UpdateError> {
    validate_bundle_dir_name(bundle_dir_name)?;
    let c = CString::new(stage_dir.as_os_str().as_bytes()).map_err(|_| unsafe_entry("NUL in stage path"))?;
    // SAFETY: valid C string; O_NOFOLLOW|O_DIRECTORY refuse a symlinked stage directory.
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(map_fs_err(&io::Error::last_os_error()));
    }
    // SAFETY: fresh descriptor owned by nobody else.
    let stage = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut sink = DiskSink { stage, root_name: bundle_dir_name.to_string(), root: None, cache: Vec::new(), created_root: false };
    let root = stage_dir.join(bundle_dir_name);
    let result = process(tar_gz, bundle_dir_name, lim, &mut sink).and_then(|tree| {
        verify_symlinks_confined(&root)?;
        Ok(tree.summary())
    });
    match result {
        Ok(summary) => Ok(Unpacked { root, summary }),
        Err(e) => {
            sink.cache.clear();
            if sink.created_root {
                let _ = fs::remove_dir_all(&root);
            }
            Err(e)
        }
    }
}

/// The tree hash of a directory on disk (the stage, spec A2 step 4). Refuses anything but regular
/// files, directories and symlinks.
pub fn tree_hash_of_dir(root: &Path, lim: &Limits) -> Result<TreeSummary, UpdateError> {
    let meta = fs::symlink_metadata(root).map_err(|e| map_fs_err(&e))?;
    if !meta.is_dir() {
        return Err(bad("not a directory"));
    }
    let mut tree = Tree::default();
    tree.nodes.insert(String::new(), Node { kind: NodeKind::Dir { explicit: true }, mode: meta.mode() & 0o777 });
    walk(root, "", &mut tree, lim, 1)?;
    Ok(tree.summary())
}

fn walk(dir: &Path, prefix: &str, tree: &mut Tree, lim: &Limits, depth: usize) -> Result<(), UpdateError> {
    if depth > lim.max_depth {
        return Err(unsafe_entry("tree too deep"));
    }
    for entry in fs::read_dir(dir).map_err(|e| map_fs_err(&e))? {
        let entry = entry.map_err(|e| map_fs_err(&e))?;
        let name = entry.file_name();
        let name = name.to_str().ok_or_else(|| unsafe_entry("file name is not UTF-8"))?.to_string();
        let key = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| map_fs_err(&e))?;
        if tree.entries >= lim.max_entries {
            return Err(UpdateError::with(ErrorCode::BombEntries, "too many entries"));
        }
        tree.entries += 1;
        let ft = meta.file_type();
        if ft.is_dir() {
            tree.nodes.insert(key.clone(), Node { kind: NodeKind::Dir { explicit: true }, mode: meta.mode() & 0o777 });
            walk(&path, &key, tree, lim, depth + 1)?;
        } else if ft.is_symlink() {
            let target = fs::read_link(&path).map_err(|e| map_fs_err(&e))?;
            let target = target.to_str().ok_or_else(|| unsafe_entry("symlink target is not UTF-8"))?.to_string();
            tree.nodes.insert(key, Node { kind: NodeKind::Symlink { target }, mode: SYMLINK_MODE });
        } else if ft.is_file() {
            let size = meta.len();
            tree.bytes = tree
                .bytes
                .checked_add(size)
                .filter(|b| *b <= lim.max_unpacked_bytes)
                .ok_or_else(|| UpdateError::with(ErrorCode::BombSize, "unpacked size over the limit"))?;
            let mut f = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&path).map_err(|e| map_fs_err(&e))?;
            let digest = copy_hash(&mut f, size, None).map_err(|_| bad("file changed while hashing"))?;
            tree.nodes.insert(key, Node { kind: NodeKind::File { size, digest }, mode: meta.mode() & 0o777 });
        } else {
            return Err(unsafe_entry("special file in the tree"));
        }
    }
    Ok(())
}

/// Walks `root` and resolves every symlink physically, component by component, with a hop limit:
/// the result must stay inside `root` (a dangling link inside the bundle is allowed). `root`
/// itself is never resolved.
pub fn verify_symlinks_confined(root: &Path) -> Result<(), UpdateError> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| map_fs_err(&e))? {
            let path = entry.map_err(|e| map_fs_err(&e))?.path();
            let meta = fs::symlink_metadata(&path).map_err(|e| map_fs_err(&e))?;
            if meta.file_type().is_dir() {
                stack.push(path);
            } else if meta.file_type().is_symlink() {
                resolve_confined(root, &path)?;
            }
        }
    }
    Ok(())
}

/// Physical resolution of `link` below `root`; returns the resolved path (inside `root`).
pub fn resolve_confined(root: &Path, link: &Path) -> Result<PathBuf, UpdateError> {
    let rel = link.strip_prefix(root).map_err(|_| unsafe_entry("link outside the stage"))?;
    let mut pending: VecDeque<OsString> = VecDeque::new();
    for c in rel.components() {
        match c {
            Component::Normal(n) => pending.push_back(n.to_os_string()),
            _ => return Err(unsafe_entry("unexpected path component")),
        }
    }
    let mut cur = root.to_path_buf();
    let mut hops = 0usize;
    while let Some(name) = pending.pop_front() {
        if name == ".." {
            cur.pop();
            if !cur.starts_with(root) {
                return Err(unsafe_entry("symlink leaves the bundle"));
            }
            continue;
        }
        if name == "." {
            continue;
        }
        let next = cur.join(&name);
        match fs::symlink_metadata(&next) {
            Ok(m) if m.file_type().is_symlink() => {
                hops += 1;
                if hops > SYMLINK_HOPS {
                    return Err(unsafe_entry("symlink loop"));
                }
                let target = fs::read_link(&next).map_err(|e| map_fs_err(&e))?;
                if target.is_absolute() {
                    return Err(unsafe_entry("absolute symlink target"));
                }
                // The target is resolved relative to the directory holding the link (`cur`).
                let comps: Vec<OsString> = target
                    .components()
                    .map(|c| match c {
                        Component::Normal(n) => Ok(n.to_os_string()),
                        Component::CurDir => Ok(OsString::from(".")),
                        Component::ParentDir => Ok(OsString::from("..")),
                        _ => Err(unsafe_entry("unexpected symlink target component")),
                    })
                    .collect::<Result<_, _>>()?;
                for c in comps.into_iter().rev() {
                    pending.push_front(c);
                }
            }
            Ok(_) => cur = next,
            Err(e) if e.kind() == io::ErrorKind::NotFound => cur = next,
            Err(e) => return Err(map_fs_err(&e)),
        }
    }
    if !cur.starts_with(root) {
        return Err(unsafe_entry("symlink leaves the bundle"));
    }
    Ok(cur)
}

// ------------------------------------------------------------------------------------------
// Stage directory lifecycle (spec 4.11 P4, A7, T21)
// ------------------------------------------------------------------------------------------

/// `^\.IntelyIDE\.update-[0-9a-f]{16}$`
pub fn is_stage_dir_name(name: &str) -> bool {
    match name.strip_prefix(STAGE_PREFIX) {
        Some(rest) => rest.len() == 16 && rest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        None => false,
    }
}

/// Creates `<parent>/.IntelyIDE.update-<16 hex>` (mode 0700, `mkdir`, never into an existing path)
/// with the marker file. `PermissionDenied` becomes `notWritable`, `EROFS` `readOnlyVolume`.
pub fn create_stage_dir(parent: &Path) -> Result<PathBuf, UpdateError> {
    for _ in 0..8 {
        let path = parent.join(format!("{STAGE_PREFIX}{}", random_hex(8)?));
        match fs::DirBuilder::new().mode(0o700).create(&path) {
            Ok(()) => {
                let marker = path.join(STAGE_MARKER);
                let made = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&marker).and_then(|mut f| f.write_all(b"intely update stage\n"));
                if let Err(e) = made {
                    let _ = fs::remove_dir_all(&path);
                    return Err(map_fs_err(&e));
                }
                return Ok(path);
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(map_fs_err(&e)),
        }
    }
    Err(bad("could not create a unique stage directory"))
}

#[derive(Clone, Debug)]
pub struct StageInfo {
    pub path: PathBuf,
    pub modified: SystemTime,
}

/// Checks that `path` is a stage directory this module may delete: the name matches the pattern, it
/// is a real directory (`lstat`, not a symlink) owned by `uid`, and it contains the marker as a
/// regular file. Everything else is `stale` (T21: a tampered `state.json` cannot redirect a deletion).
pub fn inspect_stage_dir(path: &Path, uid: u32) -> Result<StageInfo, UpdateError> {
    let refuse = |why: &str| UpdateError::with(ErrorCode::Stale, why);
    let name = path.file_name().and_then(|n| n.to_str()).ok_or_else(|| refuse("not a stage name"))?;
    if !is_stage_dir_name(name) {
        return Err(refuse("not a stage name"));
    }
    let meta = fs::symlink_metadata(path).map_err(|_| refuse("stage missing"))?;
    if !meta.file_type().is_dir() {
        return Err(refuse("stage is not a real directory"));
    }
    if meta.uid() != uid {
        return Err(refuse("stage has another owner"));
    }
    let marker = fs::symlink_metadata(path.join(STAGE_MARKER)).map_err(|_| refuse("stage marker missing"))?;
    if !marker.file_type().is_file() {
        return Err(refuse("stage marker is not a regular file"));
    }
    Ok(StageInfo { path: path.to_path_buf(), modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH) })
}

/// Deletes a stage directory after `inspect_stage_dir`. Symlinks inside are removed, never followed.
pub fn remove_stage_dir(path: &Path, uid: u32) -> Result<(), UpdateError> {
    inspect_stage_dir(path, uid)?;
    fs::remove_dir_all(path).map_err(|e| map_fs_err(&e))
}
