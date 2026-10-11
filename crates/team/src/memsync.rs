//! Shared Claude memory (docs/team.md, beta): a project's `~/.claude/projects/<p>/memory/*.md` and its root `CLAUDE.md`, kept equal
//! on every teammate's machine through the relay's compare-and-swap blobs. The relay sees only opaque keys and ciphertext.
//!
//! - Blob key = SHA-256(project key, relative path), so the relay cannot read paths; the real path travels inside the payload.
//! - Payload = the author's signature over (team, epoch, author, blob key, version, nonce, ciphertext); the ciphertext is
//!   XChaCha20-Poly1305 under the epoch key. Blobs are re-read later, so unlike chat envelopes there is no replay counter: the
//!   version bound into the signature and the compare-and-swap are the freshness.
//! - Per file `{version, baseHash}`. A remote change over an unchanged local file is applied; over a changed one the remote becomes
//!   the file and the local text moves to `<name>.conflict-<member>-<ts>.md` (never synced) until a person picks "Keep theirs" or
//!   "Use mine" ([`resolve`]). A file changed since its base is never lost to a remote tombstone: the tombstone removes the file but
//!   the local text moves to the conflict copy first.
//! - `memory/*.md` are written automatically. The repository's `CLAUDE.md` is a separate opt-in ([`Roots::claude_md`]) and a remote
//!   change to it is never written on its own: it waits as a [`PendingChange`] until a person applies or ignores it.
//! - Names are matched case-insensitively (the blob key folds case): a second spelling of a path that differs only by case is
//!   rejected, so macOS and Linux machines never end up with two files that collide.
//! - The engine is plain async over [`Remote`], so it runs against a fake relay in tests.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use intely_remote::util::{random, sha256_hex};
use serde::{Deserialize, Serialize};

use crate::error::{Result, TeamError};
use crate::identity::{verify, Identity};
use crate::keyring::Keyring;
use crate::roster::RosterBody;

/// A synced file: at most this long. (The relay holds 256 KB per blob including the envelope, so this leaves room for it.)
pub const MAX_FILE: usize = 240 * 1024;
pub const MAX_FILES: usize = 500;
const MAGIC: &[u8; 2] = b"M1";
const CONFLICT_MARK: &str = ".conflict-";

// ---------------------------------------------------------------- paths

/// `x.md`: ASCII letters, digits, `.`, `_`, `-`; no leading dot, no `..`, never a conflict copy.
pub fn valid_name(n: &str) -> bool {
    n.len() <= 100
        && n.len() > 3
        && n.ends_with(".md")
        && !n.starts_with('.')
        && !n.contains("..")
        && !n.contains(CONFLICT_MARK)
        && n.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// The only paths that sync: `CLAUDE.md` and `memory/<name>.md`. Anything else (absolute, `..`, nested, odd characters) is refused.
pub fn valid_path(p: &str) -> bool {
    p == "CLAUDE.md" || p.strip_prefix("memory/").is_some_and(valid_name)
}

pub fn blob_key(project: &str, path: &str) -> String {
    sha256_hex(format!("intely-team/memory/v1\0{project}\0{}", path.to_ascii_lowercase()).as_bytes())
}

fn hash(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

/// Where a project's files live on this machine.
#[derive(Debug, Clone)]
pub struct Roots {
    pub project: String,
    /// The repository folder (holds `CLAUDE.md`).
    pub repo: PathBuf,
    /// `~/.claude/projects/<encoded path>/memory`.
    pub memory_dir: PathBuf,
    /// Also share the repository's `CLAUDE.md` (its own opt-in; remote changes to it wait for a person).
    pub claude_md: bool,
}

impl Roots {
    pub fn local(&self, path: &str) -> PathBuf {
        match path.strip_prefix("memory/") {
            Some(n) => self.memory_dir.join(n),
            None => self.repo.join(path),
        }
    }
}

/// How Claude Code names a project's folder under `~/.claude/projects`: the absolute path with `/` and `.` as `-`.
pub fn encode_project_dir(abs: &Path) -> String {
    abs.to_string_lossy().chars().map(|c| if matches!(c, '/' | '.' | '\\') { '-' } else { c }).collect()
}

// ---------------------------------------------------------------- local files

enum Local {
    Missing,
    /// A symlink, a directory, too large, unreadable: never read, written over or deleted.
    Skip,
    File(String, Vec<u8>),
}

fn read_local(p: &Path) -> Local {
    match std::fs::symlink_metadata(p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Local::Missing,
        Err(_) => Local::Skip,
        Ok(m) if !m.file_type().is_file() || m.len() > MAX_FILE as u64 => Local::Skip,
        Ok(_) => match std::fs::read(p) {
            Ok(b) if b.len() <= MAX_FILE => Local::File(hash(&b), b),
            _ => Local::Skip,
        },
    }
}

/// Names (as logical paths) worth a look in one project: `CLAUDE.md`, the valid `.md` names of the memory folder, and every
/// symlink or oversized `.md` there (so they are counted as skipped).
fn candidates(root: &Roots) -> Vec<String> {
    let mut v = vec!["CLAUDE.md".to_string()];
    let is_dir = std::fs::symlink_metadata(&root.memory_dir).is_ok_and(|m| m.file_type().is_dir());
    if is_dir {
        if let Ok(rd) = std::fs::read_dir(&root.memory_dir) {
            v.extend(rd.flatten().take(2000).filter_map(|e| e.file_name().into_string().ok()).filter(|n| valid_name(n)).map(|n| format!("memory/{n}")));
        }
    }
    v.sort();
    v
}

/// Tmp file in the same folder, then rename: a reader never sees half a file.
fn write_atomic(p: &Path, bytes: &[u8]) -> Result<()> {
    let dir = p.parent().ok_or_else(|| TeamError::Invalid("no parent".into()))?;
    if std::fs::symlink_metadata(dir).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(TeamError::Invalid("folder is a symlink".into()));
    }
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".intely-tmp-{}", hex::encode(random::<6>())));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, p).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

fn clean_member(name: &str) -> String {
    let s: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')).take(24).collect();
    if s.is_empty() {
        "member".into()
    } else {
        s
    }
}

/// `memory/a.md` -> `a.conflict-ana-1700000000000.md` (same folder).
fn conflict_file(path: &str, member: &str, ts: u64) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    let stem = name.strip_suffix(".md").unwrap_or(name);
    format!("{stem}{CONFLICT_MARK}{}-{ts}.md", clean_member(member))
}

// ---------------------------------------------------------------- blob format

fn aad(team_id: &str, epoch: u32, author: &str, key: &str, version: u64) -> Vec<u8> {
    let mut h = b"intely-team/blob/v1\0".to_vec();
    h.extend_from_slice(team_id.as_bytes());
    h.push(0);
    h.extend_from_slice(&epoch.to_be_bytes());
    h.extend_from_slice(author.as_bytes());
    h.push(0);
    h.extend_from_slice(key.as_bytes());
    h.push(0);
    h.extend_from_slice(&version.to_be_bytes());
    h
}

/// `M1 | epoch u32 | author_len u8 | author | nonce 24 | sig 64 | ciphertext`.
pub fn seal_blob(team_id: &str, keys: &Keyring, me: &Identity, key: &str, version: u64, plaintext: &[u8]) -> Result<Vec<u8>> {
    let epoch = keys.current();
    let k = keys.key(epoch).ok_or(TeamError::NoKey(epoch))?;
    let nonce = random::<24>();
    let aad = aad(team_id, epoch, &me.member_id, key, version);
    let ct = XChaCha20Poly1305::new(k.into()).encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad: &aad }).map_err(|_| TeamError::Crypto("encrypt".into()))?;
    let mut signed = aad;
    signed.extend_from_slice(&nonce);
    signed.extend_from_slice(&ct);
    let sig = me.sign(&signed);
    let mut out = MAGIC.to_vec();
    out.extend_from_slice(&epoch.to_be_bytes());
    out.push(me.member_id.len() as u8);
    out.extend_from_slice(me.member_id.as_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sig);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Returns the author (verified against the roster) and the plaintext.
pub fn open_blob(team_id: &str, keys: &Keyring, roster: &RosterBody, key: &str, version: u64, bytes: &[u8]) -> Result<(String, Vec<u8>)> {
    let bad = || TeamError::Invalid("blob fields".into());
    if bytes.len() < 7 || &bytes[..2] != MAGIC {
        return Err(bad());
    }
    let epoch = u32::from_be_bytes(bytes[2..6].try_into().map_err(|_| bad())?);
    let alen = bytes[6] as usize;
    let rest = &bytes[7..];
    if rest.len() < alen + 24 + 64 {
        return Err(bad());
    }
    let author = std::str::from_utf8(&rest[..alen]).map_err(|_| bad())?.to_string();
    let (nonce, rest) = rest[alen..].split_at(24);
    let (sig, ct) = rest.split_at(64);
    let member = roster.member(&author).ok_or(TeamError::UnknownSender)?;
    if epoch > roster.epoch {
        return Err(bad());
    }
    let aad = aad(team_id, epoch, &author, key, version);
    let mut signed = aad.clone();
    signed.extend_from_slice(nonce);
    signed.extend_from_slice(ct);
    if !verify(&member.sign_key().ok_or(TeamError::Forged)?, &signed, sig) {
        return Err(TeamError::Forged);
    }
    let k = keys.key(epoch).ok_or(TeamError::NoKey(epoch))?;
    let pt = XChaCha20Poly1305::new(k.into()).decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad: &aad }).map_err(|_| TeamError::Crypto("decrypt".into()))?;
    Ok((author, pt))
}

/// Inside the ciphertext: `kind u8 (0 file, 1 tombstone) | project 16 bytes | path_len u16 | path | content`.
pub fn pack(project: &str, path: &str, content: Option<&[u8]>) -> Vec<u8> {
    let mut v = vec![u8::from(content.is_none())];
    v.extend_from_slice(&hex::decode(project).unwrap_or_else(|_| vec![0; 16]));
    v.extend_from_slice(&(path.len() as u16).to_be_bytes());
    v.extend_from_slice(path.as_bytes());
    v.extend_from_slice(content.unwrap_or(&[]));
    v
}

struct Unpacked {
    project: String,
    path: String,
    content: Option<Vec<u8>>,
}

fn unpack(b: &[u8]) -> Option<Unpacked> {
    if b.len() < 19 || b[0] > 1 {
        return None;
    }
    let plen = u16::from_be_bytes([b[17], b[18]]) as usize;
    let path = std::str::from_utf8(b.get(19..19 + plen)?).ok()?.to_string();
    let content = b[19 + plen..].to_vec();
    if !valid_path(&path) || content.len() > MAX_FILE || (b[0] == 1 && !content.is_empty()) {
        return None;
    }
    Some(Unpacked { project: hex::encode(&b[1..17]), path, content: (b[0] == 0).then_some(content) })
}

// ---------------------------------------------------------------- relay seam

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub key: String,
    pub version: u64,
    pub author: String,
    pub ts: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blob {
    pub version: u64,
    pub author: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PutOutcome {
    Ok(u64),
    /// 409: somebody wrote first.
    Conflict,
    /// 413: the team's blob space is used up.
    Full,
}

#[allow(async_fn_in_trait)]
pub trait Remote {
    async fn list(&mut self) -> Result<Vec<Head>>;
    async fn get(&mut self, key: &str) -> Result<Option<Blob>>;
    async fn put(&mut self, key: &str, base_version: u64, data: &[u8]) -> Result<PutOutcome>;
}

// ---------------------------------------------------------------- state

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    pub project: String,
    pub path: String,
    pub version: u64,
    /// Hash of the text at the last sync; empty when that sync was a deletion.
    pub base_hash: String,
    pub deleted: bool,
    pub author: String,
    pub ts: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub project: String,
    pub path: String,
    /// The conflict copy's file name, next to the file.
    pub file: String,
    /// The teammate whose text is now the file.
    pub theirs_author: String,
    pub ts: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemState {
    /// By blob key.
    pub files: BTreeMap<String, FileState>,
    pub conflicts: Vec<Conflict>,
    /// Blobs that are not ours to apply (other projects, invalid), by the version already looked at.
    pub skipped: BTreeMap<String, u64>,
    pub skipped_for: Vec<String>,
    pub last_sync: u64,
    /// Remote versions of `CLAUDE.md` that wait for a person.
    #[serde(default)]
    pub pending: Vec<PendingChange>,
}

/// A teammate's version of `CLAUDE.md` that has not been written to disk. `text` is `None` for a deletion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChange {
    pub project: String,
    pub path: String,
    pub version: u64,
    pub author: String,
    pub ts: u64,
    pub text: Option<String>,
}

impl MemState {
    pub fn parse(s: &str) -> Self {
        serde_json::from_str(s).unwrap_or_default()
    }
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
    pub fn pending_for(&self, project: &str, path: &str) -> Option<&PendingChange> {
        self.pending.iter().find(|p| p.project == project && p.path == path)
    }
    fn count(&self, project: &str) -> usize {
        self.files.values().filter(|f| f.project == project && !f.deleted).count()
    }
}

pub struct Ctx<'a> {
    pub team_id: &'a str,
    pub keys: &'a Keyring,
    pub me: &'a Identity,
    pub roster: &'a RosterBody,
}

impl Ctx<'_> {
    fn my_name(&self) -> String {
        self.roster.member(&self.me.member_id).map_or_else(|| "member".into(), |m| m.name.clone())
    }
}

/// One applied remote change (the host writes an audit entry for each).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    pub project: String,
    pub path: String,
    /// `write`, `delete`, `conflict` or `pending` (a `CLAUDE.md` change waiting for a person).
    pub kind: &'static str,
    pub author: String,
}

#[derive(Debug, Default)]
pub struct Report {
    pub applied: Vec<Applied>,
    /// New `CLAUDE.md` changes that wait for a decision (the host notifies about them).
    pub pending_new: Vec<Applied>,
    pub pushed: u32,
    /// Payloads refused: bad signature, unknown author, bad path, too large.
    pub rejected: u32,
    /// Local files left alone (symlink, too large, over the file cap) and a full relay.
    pub skipped: u32,
}

// ---------------------------------------------------------------- engine

/// One full round: pull what is newer, then push what changed here. `roots` are the enabled projects found on this machine.
pub async fn sync<R: Remote>(r: &mut R, cx: &Ctx<'_>, roots: &[Roots], st: &mut MemState, now: u64) -> Result<Report> {
    let mut rep = Report::default();
    // what a "skipped" verdict depended on: the projects (and their CLAUDE.md switch) and the roster, so a new member or key retries
    let mut enabled: Vec<String> = roots.iter().map(|x| format!("{}{}", x.project, if x.claude_md { "+c" } else { "" })).collect();
    enabled.sort();
    enabled.push(format!("roster:{}:{}", cx.roster.version, cx.roster.epoch));
    if st.skipped_for != enabled {
        st.skipped.clear();
        st.skipped_for = enabled;
    }
    for h in r.list().await? {
        let waiting = st.pending.iter().any(|p| blob_key(&p.project, &p.path) == h.key && p.version >= h.version);
        let seen = waiting
            || match st.files.get(&h.key) {
                Some(f) => h.version <= f.version,
                None => st.skipped.get(&h.key) == Some(&h.version),
            };
        if !seen {
            pull_one(r, cx, roots, st, &h.key, h.version, now, &mut rep).await?;
        }
    }
    for root in roots {
        push_project(r, cx, roots, root, st, now, &mut rep).await?;
    }
    st.last_sync = now;
    Ok(rep)
}

#[allow(clippy::too_many_arguments)]
async fn pull_one<R: Remote>(r: &mut R, cx: &Ctx<'_>, roots: &[Roots], st: &mut MemState, key: &str, listed: u64, now: u64, rep: &mut Report) -> Result<()> {
    let Some(blob) = r.get(key).await? else { return Ok(()) };
    let reject = |st: &mut MemState, rep: &mut Report| {
        st.skipped.insert(key.to_string(), blob.version.max(listed));
        rep.rejected += 1;
    };
    let (author, pt) = match open_blob(cx.team_id, cx.keys, cx.roster, key, blob.version, &blob.data) {
        Ok(x) => x,
        // the author or the key has not reached this machine yet: not a verdict, try again next round
        Err(TeamError::NoKey(_) | TeamError::UnknownSender) => return Ok(()),
        Err(_) => return Ok(reject(st, rep)),
    };
    // the relay names the writer too: a member re-uploading somebody else's signed blob is not the author
    if author != blob.author {
        return Ok(reject(st, rep));
    }
    let Some(u) = unpack(&pt) else { return Ok(reject(st, rep)) };
    if blob_key(&u.project, &u.path) != key {
        return Ok(reject(st, rep));
    }
    let Some(root) = roots.iter().find(|x| x.project == u.project) else {
        // another project, or one not shared on this machine: not an error, looked at once per version
        st.skipped.insert(key.to_string(), blob.version);
        return Ok(());
    };
    if u.path == "CLAUDE.md" && !root.claude_md {
        st.skipped.insert(key.to_string(), blob.version);
        return Ok(());
    }
    if blob.version <= st.files.get(key).map_or(0, |f| f.version) {
        return Ok(());
    }
    // the same file under another spelling (`Foo.md` vs `foo.md`) would collide on a case-insensitive disk
    let other_spelling = st.files.get(key).is_some_and(|f| f.path != u.path) || candidates(root).iter().any(|c| *c != u.path && c.eq_ignore_ascii_case(&u.path));
    if other_spelling {
        return Ok(reject(st, rep));
    }
    if !st.files.contains_key(key) && u.content.is_some() && st.count(&u.project) >= MAX_FILES {
        rep.skipped += 1;
        return Ok(());
    }
    apply_remote(cx, root, st, key, &u, blob.version, &author, now, rep, false);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn apply_remote(cx: &Ctx<'_>, root: &Roots, st: &mut MemState, key: &str, u: &Unpacked, version: u64, author: &str, now: u64, rep: &mut Report, force: bool) {
    let target = root.local(&u.path);
    if u.path == "CLAUDE.md" && !force {
        hold_claude_md(&target, st, key, u, version, author, now, rep);
        return;
    }
    let base = st.files.get(key).map(|f| f.base_hash.clone()).unwrap_or_default();
    let rh = u.content.as_deref().map(hash);
    let mut kind: Option<&'static str> = None;
    match (read_local(&target), &u.content) {
        (Local::Skip, _) => {
            rep.skipped += 1;
            return;
        }
        // same text on both sides, or both gone
        (Local::File(h, _), Some(_)) if Some(&h) == rh.as_ref() => {}
        (Local::Missing, None) => {}
        // deleted here but the remote moved on: the remote wins, there is nothing to keep
        (Local::Missing, Some(c)) => {
            if write_atomic(&target, c).is_err() {
                rep.skipped += 1;
                return;
            }
            kind = Some("write");
        }
        (Local::File(h, bytes), content) => {
            if h != base {
                let name = conflict_file(&u.path, &cx.my_name(), now);
                if write_atomic(&target.with_file_name(&name), &bytes).is_err() {
                    rep.skipped += 1;
                    return;
                }
                st.conflicts.retain(|c| !(c.project == u.project && c.path == u.path));
                st.conflicts.push(Conflict { project: u.project.clone(), path: u.path.clone(), file: name, theirs_author: author.to_string(), ts: now });
                kind = Some("conflict");
            }
            let done = match content {
                Some(c) => write_atomic(&target, c).is_ok(),
                None => std::fs::remove_file(&target).is_ok(),
            };
            if !done {
                rep.skipped += 1;
                return;
            }
            kind = kind.or(Some(if content.is_some() { "write" } else { "delete" }));
        }
    }
    st.files.insert(
        key.to_string(),
        FileState { project: u.project.clone(), path: u.path.clone(), version, base_hash: rh.unwrap_or_default(), deleted: u.content.is_none(), author: author.to_string(), ts: now },
    );
    if let Some(kind) = kind {
        rep.applied.push(Applied { project: u.project.clone(), path: u.path.clone(), kind, author: author.to_string() });
    }
}

/// A remote `CLAUDE.md` is never written by the app on its own: it is what every teammate's agent reads first.
#[allow(clippy::too_many_arguments)]
fn hold_claude_md(target: &Path, st: &mut MemState, key: &str, u: &Unpacked, version: u64, author: &str, now: u64, rep: &mut Report) {
    let same = match (read_local(target), &u.content) {
        (Local::Skip, _) => {
            rep.skipped += 1;
            return;
        }
        (Local::File(h, _), Some(c)) => h == hash(c),
        (Local::Missing, None) => true,
        _ => false,
    };
    if same {
        st.files.insert(key.to_string(), FileState { project: u.project.clone(), path: u.path.clone(), version, base_hash: u.content.as_deref().map(hash).unwrap_or_default(), deleted: u.content.is_none(), author: author.to_string(), ts: now });
        return;
    }
    let text = match u.content.clone().map(String::from_utf8) {
        Some(Err(_)) => {
            rep.rejected += 1;
            return;
        }
        Some(Ok(t)) => Some(t),
        None => None,
    };
    st.pending.retain(|p| !(p.project == u.project && p.path == u.path));
    st.pending.push(PendingChange { project: u.project.clone(), path: u.path.clone(), version, author: author.to_string(), ts: now, text });
    rep.pending_new.push(Applied { project: u.project.clone(), path: u.path.clone(), kind: "pending", author: author.to_string() });
}

/// "Apply": writes the held `CLAUDE.md` (a local change since the last sync is saved as a conflict copy first, like any file).
pub fn apply_pending(cx: &Ctx<'_>, root: &Roots, st: &mut MemState, path: &str, now: u64) -> Result<Applied> {
    let i = st.pending.iter().position(|p| p.project == root.project && p.path == path).ok_or_else(|| TeamError::Invalid("no such pending change".into()))?;
    let p = st.pending[i].clone();
    let u = Unpacked { project: p.project.clone(), path: p.path.clone(), content: p.text.clone().map(String::into_bytes) };
    let mut rep = Report::default();
    apply_remote(cx, root, st, &blob_key(&p.project, &p.path), &u, p.version, &p.author, now, &mut rep, true);
    if rep.skipped > 0 {
        return Err(TeamError::Invalid("the file cannot be written".into()));
    }
    st.pending.retain(|x| !(x.project == p.project && x.path == p.path));
    Ok(rep.applied.pop().unwrap_or(Applied { project: p.project, path: p.path, kind: "write", author: p.author }))
}

/// "Ignore": the teammate's version is skipped; this machine's file counts as in sync with it until they change it again.
pub fn ignore_pending(root: &Roots, st: &mut MemState, path: &str) -> Result<()> {
    let i = st.pending.iter().position(|p| p.project == root.project && p.path == path).ok_or_else(|| TeamError::Invalid("no such pending change".into()))?;
    let (base_hash, deleted) = match read_local(&root.local(path)) {
        Local::File(h, _) => (h, false),
        Local::Missing => (String::new(), true),
        Local::Skip => return Err(TeamError::Invalid("the file cannot be read".into())),
    };
    let p = st.pending.remove(i);
    st.files.insert(blob_key(&p.project, &p.path), FileState { project: p.project, path: p.path, version: p.version, base_hash, deleted, author: p.author, ts: p.ts });
    Ok(())
}

/// For "View diff": (this machine's text, the teammate's held text).
pub fn pending_texts(root: &Roots, st: &MemState, path: &str) -> Result<(String, String)> {
    let p = st.pending_for(&root.project, path).ok_or_else(|| TeamError::Invalid("no such pending change".into()))?;
    let current = match read_local(&root.local(path)) {
        Local::File(_, b) => String::from_utf8_lossy(&b).into_owned(),
        _ => String::new(),
    };
    Ok((current, p.text.clone().unwrap_or_default()))
}

async fn push_project<R: Remote>(r: &mut R, cx: &Ctx<'_>, roots: &[Roots], root: &Roots, st: &mut MemState, now: u64, rep: &mut Report) -> Result<()> {
    // known spellings first, then what is on disk; two spellings of one name (case only) are one file: the later is left alone
    let mut paths: Vec<String> = vec![];
    let all = st.files.values().filter(|f| f.project == root.project && !f.deleted).map(|f| f.path.clone()).chain(candidates(root));
    for p in all {
        if p == "CLAUDE.md" && (!root.claude_md || st.pending_for(&root.project, &p).is_some()) {
            continue;
        }
        if let Some(same) = paths.iter().find(|x| x.eq_ignore_ascii_case(&p)) {
            if *same != p {
                rep.skipped += 1;
            }
            continue;
        }
        paths.push(p);
    }
    for path in paths {
        let key = blob_key(&root.project, &path);
        let known = st.files.get(&key).cloned();
        let (content, h) = match read_local(&root.local(&path)) {
            Local::Skip => {
                rep.skipped += 1;
                continue;
            }
            Local::File(h, b) => {
                if known.as_ref().is_some_and(|f| f.base_hash == h) {
                    continue;
                }
                (Some(b), h)
            }
            Local::Missing => match &known {
                Some(f) if !f.deleted => (None, String::new()),
                _ => continue,
            },
        };
        if known.is_none() && st.count(&root.project) >= MAX_FILES {
            rep.skipped += 1;
            continue;
        }
        let base = known.as_ref().map_or(0, |f| f.version);
        let blob = seal_blob(cx.team_id, cx.keys, cx.me, &key, base + 1, &pack(&root.project, &path, content.as_deref()))?;
        match r.put(&key, base, &blob).await? {
            PutOutcome::Ok(v) => {
                st.files.insert(key, FileState { project: root.project.clone(), path, version: v, base_hash: h, deleted: content.is_none(), author: cx.me.member_id.clone(), ts: now });
                rep.pushed += 1;
            }
            // the list was stale: fetch the newer version now; the conflict rules decide what happens to our text
            PutOutcome::Conflict => pull_one(r, cx, roots, st, &key, 0, now, rep).await?,
            PutOutcome::Full => rep.skipped += 1,
        }
    }
    Ok(())
}

/// The person's decision on a conflict. `mine == false` keeps what is in the file (the teammate's text) and drops the conflict
/// copy; `mine == true` puts the copy back as the file (the next round pushes it) and drops the copy.
pub fn resolve(root: &Roots, st: &mut MemState, path: &str, mine: bool) -> Result<()> {
    if !valid_path(path) {
        return Err(TeamError::Invalid("not a shared path".into()));
    }
    let i = st.conflicts.iter().position(|c| c.project == root.project && c.path == path).ok_or_else(|| TeamError::Invalid("no such conflict".into()))?;
    let c = st.conflicts[i].clone();
    let name_ok = c.file.len() <= 200 && c.file.ends_with(".md") && c.file.contains(CONFLICT_MARK) && !c.file.starts_with('.') && !c.file.contains("..") && c.file.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if !name_ok {
        st.conflicts.remove(i);
        return Err(TeamError::Invalid("bad conflict file".into()));
    }
    let target = root.local(path);
    let copy = target.with_file_name(&c.file);
    if mine {
        // only over what the sync wrote: anything newer in the file would be lost, so the person must look again
        let key = blob_key(&c.project, path);
        let want = st.files.get(&key).map(|f| f.base_hash.clone()).unwrap_or_default();
        let unchanged = match read_local(&target) {
            Local::File(h, _) => h == want,
            Local::Missing => want.is_empty(),
            Local::Skip => false,
        };
        if !unchanged {
            return Err(TeamError::Invalid("the file changed after the conflict; your copy was kept, sync and decide again".into()));
        }
        let Local::File(_, bytes) = read_local(&copy) else {
            st.conflicts.remove(i);
            return Err(TeamError::Invalid("the conflict copy is gone".into()));
        };
        if matches!(read_local(&target), Local::Skip) {
            return Err(TeamError::Invalid("the file cannot be written".into()));
        }
        write_atomic(&target, &bytes)?;
    }
    if std::fs::symlink_metadata(&copy).is_ok_and(|m| m.file_type().is_file()) {
        std::fs::remove_file(&copy)?;
    }
    st.conflicts.remove(i);
    Ok(())
}

#[cfg(test)]
mod tests;
