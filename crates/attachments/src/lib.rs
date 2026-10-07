//! Attachment store (Tauri-free): dropped, pasted and picked files are COPIED under
//! `<state dir>/attachments/<draftId>/<id>/<name>` (+ `<draftId>/<id>.json` metadata). Nothing here reads an arbitrary
//! path except `import_path`, which reads exactly the one file the user dropped and copies it. See docs/attachments.md.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// A raw image copied by path may be larger: the UI pipeline shrinks it and re-imports the result as bytes.
pub const MAX_IMAGE_RAW_BYTES: u64 = 40 * 1024 * 1024;
pub const MAX_PDF_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_TEXT_INLINE_BYTES: u64 = 200 * 1024;
pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_DRAFT_BYTES: u64 = 100 * 1024 * 1024;
pub const STALE_AFTER_MS: u64 = 7 * 24 * 3600 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Image,
    Text,
    Pdf,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardWarning {
    /// `secret` | `neverAdd` | `neverRead` | `key`
    pub reason: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub id: String,
    pub draft_id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub kind: Kind,
    pub sha256: String,
    pub created_ms: u64,
    #[serde(default)]
    pub guard: Option<GuardWarning>,
    /// The user explicitly confirmed sending a guarded file.
    #[serde(default)]
    pub confirmed: bool,
    /// Text files up to 200 KB are inlined into the prompt, bigger ones are referenced by path.
    pub inline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub meta: Meta,
    pub deduped: bool,
}

/// What the sidecar needs to build a user message: the metadata plus the absolute path of the stored copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    #[serde(flatten)]
    pub meta: Meta,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspected {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub guard: Option<GuardWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachError {
    pub code: &'static str,
    pub message: String,
}

impl AttachError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl std::fmt::Display for AttachError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AttachError {}

fn io(e: std::io::Error) -> AttachError {
    AttachError::new("io", e.to_string())
}

type Res<T> = Result<T, AttachError>;

/// `[A-Za-z0-9_-]{1,64}`: draft and attachment ids become directory names, so nothing else gets through.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A file name that is safe as one path component: no separators, not `.`/`..`, no control characters, bounded.
pub fn sanitize_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !c.is_control() && *c != ':').collect();
    let mut out = cleaned.trim().to_string();
    if out.chars().all(|c| c == '.') {
        out.clear(); // `.`, `..` and friends are path components, not names
    }
    if out.chars().count() > 120 {
        let ext = out.rsplit_once('.').map(|(_, e)| e.chars().take(10).collect::<String>());
        out = out.chars().take(100).collect();
        if let Some(e) = ext {
            out.push('.');
            out.push_str(&e);
        }
    }
    if out.is_empty() {
        "attachment".into()
    } else {
        out
    }
}

fn ext_of(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "json", "jsonc", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "html", "htm", "xml", "yml", "yaml", "toml", "ini", "rs", "py", "rb", "go", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "zsh", "bash", "sql", "csv", "tsv", "log", "diff", "patch", "vue", "svelte", "env", "conf", "properties", "gradle",
];

pub fn mime_for(name: &str, hint: Option<&str>) -> String {
    if let Some(h) = hint.filter(|h| !h.is_empty() && *h != "application/octet-stream") {
        return h.to_ascii_lowercase();
    }
    match ext_of(name).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        e if TEXT_EXTS.contains(&e) => "text/plain",
        _ => "application/octet-stream",
    }
    .into()
}

fn looks_textual(sample: &[u8]) -> bool {
    let head = &sample[..sample.len().min(8192)];
    if head.contains(&0) {
        return false;
    }
    match std::str::from_utf8(head) {
        Ok(_) => true,
        // The 8 KB cut may split a multi-byte character at the end.
        Err(e) => e.error_len().is_none() && e.valid_up_to() + 4 > head.len(),
    }
}

pub fn kind_of(name: &str, mime: &str, sample: &[u8]) -> Kind {
    if mime.starts_with("image/") && mime != "image/svg+xml" {
        Kind::Image
    } else if mime == "application/pdf" {
        Kind::Pdf
    } else if mime.starts_with("text/") || mime == "application/json" || mime == "image/svg+xml" || TEXT_EXTS.contains(&ext_of(name).as_str()) || looks_textual(sample) {
        Kind::Text
    } else {
        Kind::File
    }
}

/// The never-add / secret / agent-never-read rules applied to a path (or just a name) the user wants to send.
pub fn guard_for(path: &str, size: Option<u64>) -> Option<GuardWarning> {
    let rel = path.trim_start_matches('/');
    match intely_core::guard::classify(rel, true, size.filter(|s| *s <= intely_core::guard::MAX_UNTRACKED_BYTES)) {
        intely_core::GuardState::Secret => return Some(GuardWarning { reason: "secret".into(), detail: "the name looks like a secret or key file".into() }),
        intely_core::GuardState::NeverAdd => return Some(GuardWarning { reason: "neverAdd".into(), detail: "it is inside a never-add directory".into() }),
        _ => {}
    }
    intely_agent_core::policy::paths::never_read_reason(Path::new(path)).map(|why| GuardWarning { reason: "neverRead".into(), detail: why.into() })
}

fn content_guard(sample: &[u8]) -> Option<GuardWarning> {
    let head = String::from_utf8_lossy(&sample[..sample.len().min(64 * 1024)]);
    (head.contains("PRIVATE KEY-----") || head.contains("AWS_SECRET_ACCESS_KEY")).then(|| GuardWarning { reason: "key".into(), detail: "the contents look like a private key or a cloud credential".into() })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn draft_dir(&self, draft: &str) -> Res<PathBuf> {
        if !valid_id(draft) {
            return Err(AttachError::new("badId", "invalid draft id"));
        }
        Ok(self.root.join(draft))
    }

    fn check_id(id: &str) -> Res<()> {
        if valid_id(id) {
            Ok(())
        } else {
            Err(AttachError::new("badId", "invalid attachment id"))
        }
    }

    fn meta_path(dir: &Path, id: &str) -> PathBuf {
        dir.join(format!("{id}.json"))
    }

    pub fn list(&self, draft: &str) -> Res<Vec<Meta>> {
        let dir = self.draft_dir(draft)?;
        let mut out: Vec<Meta> = Vec::new();
        let Ok(rd) = fs::read_dir(&dir) else { return Ok(out) };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "json") {
                if let Some(m) = fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str::<Meta>(&s).ok()) {
                    out.push(m);
                }
            }
        }
        out.sort_by(|a, b| a.created_ms.cmp(&b.created_ms).then(a.id.cmp(&b.id)));
        Ok(out)
    }

    fn get(&self, draft: &str, id: &str) -> Res<Meta> {
        Self::check_id(id)?;
        let dir = self.draft_dir(draft)?;
        let s = fs::read_to_string(Self::meta_path(&dir, id)).map_err(|_| AttachError::new("notFound", "no such attachment"))?;
        serde_json::from_str(&s).map_err(|e| AttachError::new("corrupt", e.to_string()))
    }

    fn file_path(&self, m: &Meta) -> PathBuf {
        self.root.join(&m.draft_id).join(&m.id).join(sanitize_name(&m.name))
    }

    fn limit_for(kind: Kind, size: u64, from_path: bool) -> Res<()> {
        let (max, label) = match kind {
            Kind::Image if from_path => (MAX_IMAGE_RAW_BYTES, "image"),
            Kind::Image => (MAX_IMAGE_BYTES, "image"),
            Kind::Pdf => (MAX_PDF_BYTES, "PDF"),
            Kind::Text | Kind::File => (MAX_FILE_BYTES, "file"),
        };
        if size > max {
            return Err(AttachError::new("tooLarge", format!("{label} is {size} bytes, the limit is {max}")));
        }
        Ok(())
    }

    /// Stores `bytes` as a new attachment of `draft` (bytes from a paste, a picker or the image pipeline).
    pub fn import_bytes(&self, draft: &str, name: &str, mime_hint: Option<&str>, bytes: &[u8], source_path: Option<&str>) -> Res<Imported> {
        self.import_inner(draft, name, mime_hint, bytes, source_path, false)
    }

    fn import_inner(&self, draft: &str, name: &str, mime_hint: Option<&str>, bytes: &[u8], source_path: Option<&str>, from_path: bool) -> Res<Imported> {
        let dir = self.draft_dir(draft)?;
        // Judge the name as given: sanitising strips the leading dot of `.env`, which is exactly what the guard looks for.
        let original = name.rsplit(['/', '\\']).next().unwrap_or("").to_string();
        let name = sanitize_name(name);
        let mime = mime_for(&name, mime_hint);
        let kind = kind_of(&name, &mime, bytes);
        let size = bytes.len() as u64;
        Self::limit_for(kind, size, from_path)?;
        let sha = hex(&Sha256::digest(bytes));
        let existing = self.list(draft)?;
        if let Some(m) = existing.iter().find(|m| m.sha256 == sha) {
            return Ok(Imported { meta: m.clone(), deduped: true });
        }
        if existing.iter().map(|m| m.size).sum::<u64>() + size > MAX_DRAFT_BYTES {
            return Err(AttachError::new("draftFull", "this draft already holds the maximum amount of attachments"));
        }
        let guard = source_path
            .and_then(|p| guard_for(p, Some(size)))
            .or_else(|| guard_for(&original, Some(size)))
            .or_else(|| guard_for(&name, Some(size)))
            .or_else(|| if matches!(kind, Kind::Image | Kind::Pdf) { None } else { content_guard(bytes) });
        let id = uuid::Uuid::new_v4().simple().to_string();
        let meta = Meta { id: id.clone(), draft_id: draft.to_string(), name: name.clone(), mime, size, kind, sha256: sha, created_ms: now_ms(), guard, confirmed: false, inline: kind == Kind::Text && size <= MAX_TEXT_INLINE_BYTES };
        let file_dir = dir.join(&id);
        fs::create_dir_all(&file_dir).map_err(io)?;
        let tmp = file_dir.join(".partial");
        fs::write(&tmp, bytes).map_err(io)?;
        fs::rename(&tmp, file_dir.join(&name)).map_err(io)?;
        self.write_meta(&meta)?;
        Ok(Imported { meta, deduped: false })
    }

    /// Copies one file the user dropped or picked. Directories are refused (the UI turns those into path references),
    /// and so is anything inside the store itself.
    pub fn import_path(&self, draft: &str, path: &Path) -> Res<Imported> {
        let canon = fs::canonicalize(path).map_err(|e| AttachError::new("notFound", e.to_string()))?;
        if let Ok(root) = fs::canonicalize(&self.root) {
            if canon.starts_with(&root) {
                return Err(AttachError::new("insideStore", "that file is already inside the attachment store"));
            }
        }
        let md = fs::metadata(&canon).map_err(io)?;
        if !md.is_file() {
            return Err(AttachError::new("notAFile", "only regular files can be attached; use a path reference for folders"));
        }
        let name = canon.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "attachment".into());
        // Early limit check from the metadata, then a bounded read so a growing file cannot exceed it.
        let mime = mime_for(&name, None);
        let cap = if mime.starts_with("image/") { MAX_IMAGE_RAW_BYTES } else if mime == "application/pdf" { MAX_PDF_BYTES } else { MAX_FILE_BYTES };
        if md.len() > cap {
            return Err(AttachError::new("tooLarge", format!("file is {} bytes, the limit is {cap}", md.len())));
        }
        let mut buf = Vec::with_capacity(md.len() as usize);
        fs::File::open(&canon).map_err(io)?.take(cap + 1).read_to_end(&mut buf).map_err(io)?;
        // Judge both the canonical path and the path the user dropped (a symlink named `.env`).
        let dropped = path.to_string_lossy().into_owned();
        let source = if guard_for(&dropped, Some(buf.len() as u64)).is_some() { dropped } else { canon.to_string_lossy().into_owned() };
        self.import_inner(draft, &name, Some(&mime), &buf, Some(&source), true)
    }

    fn write_meta(&self, m: &Meta) -> Res<()> {
        let dir = self.draft_dir(&m.draft_id)?;
        let json = serde_json::to_vec_pretty(m).map_err(|e| AttachError::new("corrupt", e.to_string()))?;
        fs::write(Self::meta_path(&dir, &m.id), json).map_err(io)
    }

    /// Looks at dropped paths without reading them: folder or file, size, guard verdict.
    pub fn inspect(paths: &[PathBuf]) -> Vec<Inspected> {
        paths
            .iter()
            .map(|p| {
                let md = fs::metadata(p).ok();
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
                Inspected { path: p.to_string_lossy().into_owned(), name, is_dir: md.as_ref().is_some_and(|m| m.is_dir()), size, guard: guard_for(&p.to_string_lossy(), Some(size)) }
            })
            .collect()
    }

    /// The draft an attachment id lives in (transcripts only know the id). Ids are random, so the first hit is the one.
    pub fn locate(&self, id: &str) -> Res<Meta> {
        Self::check_id(id)?;
        let rd = fs::read_dir(&self.root).map_err(|_| AttachError::new("notFound", "no such attachment"))?;
        for e in rd.flatten() {
            let draft = e.file_name().to_string_lossy().into_owned();
            if valid_id(&draft) {
                if let Ok(m) = self.get(&draft, id) {
                    return Ok(m);
                }
            }
        }
        Err(AttachError::new("notFound", "no such attachment"))
    }

    pub fn read(&self, draft: &str, id: &str) -> Res<Vec<u8>> {
        let m = self.get(draft, id)?;
        fs::read(self.file_path(&m)).map_err(|_| AttachError::new("notFound", "the stored file is missing"))
    }

    pub fn confirm(&self, draft: &str, id: &str) -> Res<Meta> {
        let mut m = self.get(draft, id)?;
        m.confirmed = true;
        self.write_meta(&m)?;
        Ok(m)
    }

    pub fn remove(&self, draft: &str, id: &str) -> Res<()> {
        Self::check_id(id)?;
        let dir = self.draft_dir(draft)?;
        let _ = fs::remove_dir_all(dir.join(id));
        let _ = fs::remove_file(Self::meta_path(&dir, id));
        Ok(())
    }

    pub fn remove_draft(&self, draft: &str) -> Res<()> {
        let dir = self.draft_dir(draft)?;
        let _ = fs::remove_dir_all(dir);
        Ok(())
    }

    /// The files to hand to the sidecar. A guarded file the user did not confirm stops the send (fail closed).
    pub fn resolve_for_send(&self, draft: &str, ids: &[String]) -> Res<Vec<Resolved>> {
        ids.iter()
            .map(|id| {
                let m = self.get(draft, id)?;
                if m.guard.is_some() && !m.confirmed {
                    return Err(AttachError::new("unconfirmedGuard", format!("{} may contain secrets; confirm it before sending", m.name)));
                }
                let path = self.file_path(&m);
                if !path.is_file() {
                    return Err(AttachError::new("notFound", "the stored file is missing"));
                }
                Ok(Resolved { path: path.to_string_lossy().into_owned(), meta: m })
            })
            .collect()
    }

    /// Deletes drafts whose newest attachment is older than `max_age_ms` (an empty draft by its directory mtime).
    /// Returns the number of removed drafts.
    pub fn cleanup(&self, now_ms: u64, max_age_ms: u64) -> usize {
        let Ok(rd) = fs::read_dir(&self.root) else { return 0 };
        let mut removed = 0;
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let draft = e.file_name().to_string_lossy().into_owned();
            let mtime = || fs::metadata(&p).ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64);
            let newest = self.list(&draft).ok().and_then(|l| l.iter().map(|m| m.created_ms).max()).or_else(mtime).unwrap_or(0);
            if now_ms.saturating_sub(newest) > max_age_ms && fs::remove_dir_all(&p).is_ok() {
                removed += 1;
            }
        }
        removed
    }
}
