//! The path validation pipeline ((design notes: workspaces-spec) 5.5): hygiene, resolve, jail, type, identity, classification,
//! ownership, warnings, config risk scan, HEAD. File inspection only; no git process.

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use intely_core::jail::Mode;
use intely_core::EngineError;
use unicode_normalization::UnicodeNormalization;

use crate::fsops::{mount_key, FsOps, Guard, RealFs, StatInfo, DEFAULT_DEADLINE};
use crate::gitdir::{read_head, scan_risks, shape_of, Found, Shape};
use crate::policy::Policy;
use crate::protected::classify as classify_protected;
use crate::types::{codes, PathKind, PickWarning, PickedRemote, ProtectedFolder};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Purpose {
    WorkspaceRoot,
    WorkspaceRepo,
    ScanRoot,
    File(String),
}

impl Purpose {
    pub fn parse(s: &str) -> Result<Self, EngineError> {
        match s {
            "workspaceRoot" => Ok(Self::WorkspaceRoot),
            "workspaceRepo" => Ok(Self::WorkspaceRepo),
            "scanRoot" => Ok(Self::ScanRoot),
            other => match other.strip_prefix("file:") {
                Some(field)
                    if !field.is_empty()
                        && field.len() <= 64
                        && field.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) =>
                {
                    Ok(Self::File(field.to_owned()))
                }
                _ => Err(EngineError::new(codes::PATH_INVALID, "unknown picker purpose")),
            },
        }
    }

    pub fn as_string(&self) -> String {
        match self {
            Self::WorkspaceRoot => "workspaceRoot".into(),
            Self::WorkspaceRepo => "workspaceRepo".into(),
            Self::ScanRoot => "scanRoot".into(),
            Self::File(f) => format!("file:{f}"),
        }
    }

    pub fn is_file(&self) -> bool {
        matches!(self, Self::File(_))
    }

    fn classifies(&self) -> bool {
        matches!(self, Self::WorkspaceRoot | Self::WorkspaceRepo)
    }
}

/// A fully validated path before it gets a token.
#[derive(Debug, Clone)]
pub struct Validated {
    pub path: PathBuf,
    pub name: String,
    pub kind: PathKind,
    pub identity: String,
    pub dev: u64,
    pub ino: u64,
    pub root: Option<Box<Validated>>,
    pub main: Option<String>,
    pub warnings: Vec<PickWarning>,
    pub config_risks: Vec<String>,
    /// sha256 of the risky keys together with their values; the values themselves never leave this crate.
    pub risk_digest: String,
    pub remotes: Vec<PickedRemote>,
    pub branch: Option<String>,
    pub detached: bool,
    pub protected_folder: Option<ProtectedFolder>,
    pub via_symlink: bool,
    pub gitfile_target: Option<String>,
    pub git_dir: Option<PathBuf>,
}

#[derive(Clone)]
pub struct Validator {
    pub policy: Policy,
    pub fs: Arc<dyn FsOps>,
    pub guard: Arc<Guard>,
    pub deadline: Duration,
}

pub fn err(code: &str, message: impl Into<String>) -> EngineError {
    EngineError::new(code, message)
}

impl Validator {
    pub fn new(policy: Policy) -> Self {
        Self { policy, fs: Arc::new(RealFs), guard: Arc::new(Guard::default()), deadline: DEFAULT_DEADLINE }
    }

    pub fn with_fs(mut self, fs: Arc<dyn FsOps>) -> Self {
        self.fs = fs;
        self
    }

    pub fn with_guard(mut self, guard: Arc<Guard>) -> Self {
        self.guard = guard;
        self
    }

    pub fn with_deadline(mut self, d: Duration) -> Self {
        self.deadline = d;
        self
    }

    /// Typed or clicked path to a [`Validated`], with the filesystem work on a guarded worker thread.
    pub fn validate(&self, raw: &str, purpose: &Purpose) -> Result<Validated, EngineError> {
        let path = hygiene(raw, &self.policy.home)?;
        let me = self.clone();
        let purpose = purpose.clone();
        let mount = mount_key(&path);
        self.guard.run(&mount, self.deadline, move || me.validate_path(&path, &purpose))?
    }

    /// The same pipeline without the worker thread (the caller already runs on one).
    pub fn validate_path(&self, path: &Path, purpose: &Purpose) -> Result<Validated, EngineError> {
        let (canonical, via_symlink) = self.resolve(path)?;
        self.policy.check_read(&canonical)?;
        let stat = self.fs.stat(&canonical).map_err(|e| io_error(&e, &canonical, &self.policy.home))?;
        if purpose.is_file() {
            if !stat.is_file {
                return Err(err(codes::NOT_A_FILE, "not a file"));
            }
            return Ok(self.plain(&canonical, PathKind::File, &stat, via_symlink));
        }
        if !stat.is_dir {
            return Err(err(codes::NOT_A_DIRECTORY, "not a directory"));
        }
        if !purpose.classifies() {
            return Ok(self.plain(&canonical, PathKind::Folder, &stat, via_symlink));
        }
        self.classify_dir(&canonical, &stat, via_symlink, true)
    }

    /// Steps 2 of the pipeline: `lstat`, `canonicalize`, and whether a symlink was crossed.
    fn resolve(&self, path: &Path) -> Result<(PathBuf, bool), EngineError> {
        let home = &self.policy.home;
        self.fs.symlink_stat(path).map_err(|e| io_error(&e, path, home))?;
        let canonical = self.fs.canonicalize(path).map_err(|e| io_error(&e, path, home))?;
        Ok((canonical, self.crossed_symlink(path)))
    }

    fn crossed_symlink(&self, path: &Path) -> bool {
        let mut prefix = PathBuf::new();
        for (i, c) in path.components().enumerate() {
            prefix.push(c.as_os_str());
            // `/tmp`, `/var` and `/etc` are symlinks on every Mac; they are not the user's doing.
            if i < 2 && matches!(prefix.to_str(), Some("/tmp" | "/var" | "/etc")) {
                continue;
            }
            if i == 0 {
                continue;
            }
            if self.fs.symlink_stat(&prefix).map(|s| s.is_symlink).unwrap_or(false) {
                return true;
            }
        }
        false
    }

    fn plain(&self, canonical: &Path, kind: PathKind, stat: &StatInfo, via_symlink: bool) -> Validated {
        Validated {
            path: canonical.to_path_buf(),
            name: nfc_name(canonical),
            kind,
            identity: identity(stat),
            dev: stat.dev,
            ino: stat.ino,
            root: None,
            main: None,
            warnings: self.location_warnings(canonical),
            config_risks: Vec::new(),
            risk_digest: String::new(),
            remotes: Vec::new(),
            branch: None,
            detached: false,
            protected_folder: classify_protected(canonical, &self.policy.home),
            via_symlink,
            gitfile_target: None,
            git_dir: None,
        }
    }

    /// Step 6 onwards for a directory. `walk` allows the ancestor search (off when classifying a found root).
    fn classify_dir(&self, canonical: &Path, stat: &StatInfo, via_symlink: bool, walk: bool) -> Result<Validated, EngineError> {
        // Inside a `.git` folder: offer the parent. (Checked first: a `.git` folder also looks like a bare repository.)
        if walk {
            if let Some(parent) = parent_of_dot_git(canonical) {
                let mut v = self.plain(canonical, PathKind::GitDir, stat, via_symlink);
                v.root = self.root_candidate(&parent).map(Box::new);
                return Ok(v);
            }
        }
        let Found { shape, git_symlink } = shape_of(canonical)?;
        let kind = match &shape {
            Shape::Repo { .. } | Shape::Redirect { .. } => PathKind::Repo,
            Shape::Worktree { .. } => PathKind::Worktree,
            Shape::Submodule { .. } => PathKind::Submodule,
            Shape::Bare => return Ok(self.plain(canonical, PathKind::Bare, stat, via_symlink)),
            Shape::NotGit => {
                if !walk {
                    return Ok(self.plain(canonical, PathKind::NotGit, stat, via_symlink));
                }
                return self.subfolder_or_not_git(canonical, stat, via_symlink);
            }
        };
        if self.too_broad(canonical) {
            return Err(err(codes::TOO_BROAD, "this folder is too broad to be a repository"));
        }
        let mut v = self.plain(canonical, kind, stat, via_symlink);
        let (git_dir, config_dir, main, target) = match shape {
            Shape::Repo { git_dir } => (git_dir.clone(), Some(git_dir), None, None),
            Shape::Worktree { git_dir, commondir } => {
                let main = commondir.as_ref().map(|c| c.to_string_lossy().into_owned());
                (git_dir, commondir, main, None)
            }
            Shape::Submodule { git_dir } => (git_dir.clone(), Some(git_dir), None, None),
            Shape::Redirect { git_dir, target } => (git_dir.clone(), Some(git_dir), None, Some(target)),
            Shape::Bare | Shape::NotGit => unreachable!(),
        };
        let (branch, detached) = read_head(&git_dir)?;
        let scan = scan_risks(Some(canonical), &git_dir, config_dir.as_deref())?;
        v.branch = branch;
        v.detached = detached;
        v.config_risks = scan.keys;
        v.risk_digest = scan.digest;
        v.remotes = scan.remotes;
        v.main = main;
        v.git_dir = Some(git_dir);
        if let Some(t) = target {
            v.gitfile_target = Some(t);
            push_unique(&mut v.warnings, PickWarning::GitfileRedirect);
        }
        if git_symlink {
            push_unique(&mut v.warnings, PickWarning::GitSymlink);
        }
        if matches!(kind, PathKind::Worktree | PathKind::Submodule) {
            push_unique(&mut v.warnings, PickWarning::LimitedSupport);
        }
        if stat.uid != self.policy.uid {
            push_unique(&mut v.warnings, PickWarning::ForeignOwner);
        }
        Ok(v)
    }

    fn subfolder_or_not_git(&self, canonical: &Path, stat: &StatInfo, via_symlink: bool) -> Result<Validated, EngineError> {
        let home = &self.policy.home;
        let mut cur = canonical.parent();
        for _ in 0..20 {
            let Some(a) = cur else { break };
            if a == Path::new("/") || (home.starts_with(a) && a != home.as_path()) {
                break;
            }
            if self.policy.check_read(a).is_err() {
                break;
            }
            if let Ok(Found { shape: Shape::Repo { .. } | Shape::Worktree { .. } | Shape::Submodule { .. } | Shape::Redirect { .. }, .. }) =
                shape_of(a)
            {
                let root_stat = self.fs.stat(a).map_err(|e| io_error(&e, a, home))?;
                let root = self.classify_dir(a, &root_stat, false, false)?;
                let mut v = self.plain(canonical, PathKind::Subfolder, stat, via_symlink);
                v.root = Some(Box::new(root));
                return Ok(v);
            }
            cur = a.parent();
        }
        Ok(self.plain(canonical, PathKind::NotGit, stat, via_symlink))
    }

    fn root_candidate(&self, parent: &Path) -> Option<Validated> {
        self.policy.check_read(parent).ok()?;
        let stat = self.fs.stat(parent).ok()?;
        if !stat.is_dir {
            return None;
        }
        self.classify_dir(parent, &stat, false, false).ok().filter(|v| v.kind != PathKind::NotGit)
    }

    /// Repo roots that would enclose secrets or IDE state ((design notes: workspaces-spec) 5.5 step 6, D18).
    pub fn too_broad(&self, root: &Path) -> bool {
        let home = &self.policy.home;
        if root == Path::new("/") || root == Path::new("/Users") || root == Path::new("/Volumes") || root == home.as_path() {
            return true;
        }
        if home.starts_with(root) {
            return true;
        }
        if let Ok(rest) = root.strip_prefix("/Volumes") {
            if rest.components().count() == 1 {
                return true;
            }
        }
        let state = &self.policy.state_dir;
        if state.starts_with(root) || root.starts_with(state) {
            return true;
        }
        [".ssh", ".aws", ".gnupg", "Library"].iter().any(|d| root.starts_with(home.join(d)))
    }

    fn location_warnings(&self, canonical: &Path) -> Vec<PickWarning> {
        let mut w = Vec::new();
        let text = canonical.to_string_lossy();
        if ["Mobile Documents", "CloudStorage", "Dropbox", "OneDrive", "Google Drive"].iter().any(|m| text.contains(m)) {
            w.push(PickWarning::CloudFolder);
        }
        if matches!(fs_type(canonical).as_deref(), Some("smbfs" | "nfs" | "afpfs" | "webdav")) {
            w.push(PickWarning::Network);
        }
        if canonical.starts_with("/Volumes") && canonical != Path::new("/Volumes") {
            w.push(PickWarning::ExternalVolume);
        }
        if canonical.components().any(|c| c.as_os_str() == OsStr::new("node_modules")) {
            w.push(PickWarning::InsideIgnored);
        }
        w
    }

    /// `revalidate(token)` of (design notes: workspaces-spec) 5.5: the path must still be the same directory and carry the same
    /// risk set as when the token was issued.
    pub fn revalidate(&self, was: &Validated, purpose: &Purpose) -> Result<Validated, EngineError> {
        let now = self.validate(&was.path.to_string_lossy(), purpose)?;
        if now.dev != was.dev || now.ino != was.ino || now.path != was.path {
            return Err(err(codes::PATH_NOT_VALIDATED, "the folder changed after it was chosen"));
        }
        if now.config_risks != was.config_risks || now.risk_digest != was.risk_digest {
            return Err(err(codes::RISK_CHANGED, "the repository's git settings changed after they were shown"));
        }
        Ok(now)
    }
}

pub fn identity(stat: &StatInfo) -> String {
    format!("{}:{}", stat.dev, stat.ino)
}

pub fn nfc_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().nfc().collect()).unwrap_or_else(|| "/".to_owned())
}

fn push_unique(v: &mut Vec<PickWarning>, w: PickWarning) {
    if !v.contains(&w) {
        v.push(w);
    }
}

fn parent_of_dot_git(canonical: &Path) -> Option<PathBuf> {
    let mut acc = PathBuf::new();
    for c in canonical.components() {
        if let Component::Normal(n) = c {
            if n == OsStr::new(".git") {
                return Some(acc);
            }
        }
        acc.push(c.as_os_str());
    }
    None
}

/// Maps an I/O error of the resolve step to a picker error code.
pub fn io_error(e: &std::io::Error, path: &Path, home: &Path) -> EngineError {
    use std::io::ErrorKind::*;
    match e.kind() {
        NotFound | NotADirectory => {
            if let Ok(rest) = path.strip_prefix("/Volumes") {
                if let Some(name) = rest.components().next() {
                    if !Path::new("/Volumes").join(name).exists() {
                        return err(codes::VOLUME_MISSING, "the volume is not mounted");
                    }
                }
            }
            err(codes::NOT_FOUND, "the folder does not exist")
        }
        PermissionDenied => {
            let prot = classify_protected(path, home).map(|p| format!("{p:?}"));
            let e = err(codes::PERMISSION_DENIED, "access was denied");
            match prot {
                Some(p) => e.with_detail(p),
                None => e,
            }
        }
        _ => err(codes::IO, e.to_string()),
    }
}

/// Step 1: UTF-8 text to an absolute path, with the conveniences of a pasted path.
pub fn hygiene(raw: &str, home: &Path) -> Result<PathBuf, EngineError> {
    let bad = || err(codes::PATH_INVALID, "not a valid path");
    if raw.is_empty() || raw.len() > 4096 {
        return Err(bad());
    }
    let mut s = raw.trim().to_owned();
    if s.is_empty() || s.chars().any(|c| c.is_control()) {
        return Err(bad());
    }
    for q in ['"', '\''] {
        if s.len() >= 2 && s.starts_with(q) && s.ends_with(q) {
            s = s[1..s.len() - 1].to_owned();
            break;
        }
    }
    if let Some(rest) = s.strip_prefix("file://") {
        let rest = rest.strip_prefix("localhost").unwrap_or(rest);
        s = percent_decode(rest).ok_or_else(bad)?;
    }
    s = s.replace("\\ ", " ");
    if s == "~" {
        return Ok(home.to_path_buf());
    }
    if let Some(rest) = s.strip_prefix("~/") {
        return Ok(home.join(rest));
    }
    if s.starts_with('~') {
        return Err(bad());
    }
    if s.is_empty() || s.chars().any(|c| c == '\0') || !s.starts_with('/') {
        return Err(bad());
    }
    Ok(PathBuf::from(s))
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(target_os = "macos")]
fn fs_type(path: &Path) -> Option<String> {
    use std::ffi::{CStr, CString};
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: zeroed statfs is a valid out-parameter, the path is NUL terminated.
    let mut s: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    // SAFETY: f_fstypename is a NUL terminated C string filled in by the kernel.
    Some(unsafe { CStr::from_ptr(s.f_fstypename.as_ptr()) }.to_string_lossy().into_owned())
}

#[cfg(not(target_os = "macos"))]
fn fs_type(_path: &Path) -> Option<String> {
    None
}

pub fn mode_is_e2e(policy: &Policy) -> bool {
    policy.mode() == Mode::E2e
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hygiene_understands_pasted_paths() {
        let home = Path::new("/Users/alice");
        assert_eq!(hygiene("  \"/a/b c\"  ", home).unwrap(), PathBuf::from("/a/b c"));
        assert_eq!(hygiene("'/a/b'", home).unwrap(), PathBuf::from("/a/b"));
        assert_eq!(hygiene("file:///a/b%20c", home).unwrap(), PathBuf::from("/a/b c"));
        assert_eq!(hygiene("/a/b\\ c", home).unwrap(), PathBuf::from("/a/b c"));
        assert_eq!(hygiene("~", home).unwrap(), PathBuf::from("/Users/alice"));
        assert_eq!(hygiene("~/Projects/x", home).unwrap(), PathBuf::from("/Users/alice/Projects/x"));
        for bad in ["", "relative/x", "~bob/x", "/a\0b", "/a\nb", "file:///a%zz"] {
            assert_eq!(hygiene(bad, home).unwrap_err().code, codes::PATH_INVALID, "{bad:?}");
        }
        assert_eq!(hygiene(&"/a".repeat(3000), home).unwrap_err().code, codes::PATH_INVALID);
    }

    #[test]
    fn purposes_parse() {
        assert_eq!(Purpose::parse("file:caFile").unwrap(), Purpose::File("caFile".into()));
        assert!(Purpose::parse("file:").is_err());
        assert!(Purpose::parse("file:a/b").is_err());
        assert!(Purpose::parse("nope").is_err());
        assert_eq!(Purpose::parse("scanRoot").unwrap().as_string(), "scanRoot");
    }
}
