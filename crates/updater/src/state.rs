//! Everything the updater keeps on disk under `<state>/updates/` ((design notes: updater-spec) 4.5, 4.11 A3/A7,
//! 6.5, 7.2): `state.json` (a HINT, never trusted for a security decision), `trust.json`,
//! `feedstate.json`, the feed cache, the pre-swap snapshot `pre-<token>/`, the markers the
//! relauncher and the new instance exchange, the lock, `updates.log`, and the start-up logic
//! (`early_boot`, `recover`) that makes every crash point of 7.2 converge.
//!
//! Rules this file keeps:
//! * Every write is temp + fsync + rename, mode 0600 (directories 0700), `O_NOFOLLOW`.
//! * Every deletion goes through a path DERIVED from the app location and a strict name check
//!   (stage pattern + marker + real directory + owner); a path read from `state.json` is only a
//!   hint to compare against (T21).
//! * Nothing here reads the environment, spawns a thread or keeps a timer. The clock is a
//!   parameter. No `unsafe`.

use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ring::digest;
use semver::Version;
use serde::{Deserialize, Serialize};

use crate::keys::Revocations;
use crate::limits::{FEED_MAX_BYTES, FEED_SIG_MAX_BYTES, STAGE_RETENTION};
use crate::stage::{inspect_stage_dir, is_stage_dir_name, random_hex, remove_stage_dir};
use crate::version::Channel;
use crate::{ErrorCode, UpdateError};

// ------------------------------------------------------------------------------------------
// Errors and small file helpers
// ------------------------------------------------------------------------------------------

fn io_err(e: &io::Error, what: &str) -> UpdateError {
    match e.raw_os_error() {
        Some(libc::EACCES) | Some(libc::EPERM) => UpdateError::with(ErrorCode::NotWritable, what.to_string()),
        Some(libc::EROFS) => UpdateError::with(ErrorCode::ReadOnlyVolume, what.to_string()),
        Some(libc::ENOSPC) => UpdateError::with(ErrorCode::NoSpace, what.to_string()),
        _ => UpdateError::with(ErrorCode::SwapFailed, format!("{what}: {}", e.kind())),
    }
}

fn corrupt(what: &str) -> UpdateError {
    UpdateError::with(ErrorCode::FeedInvalid, format!("{what} is corrupt"))
}

/// Temp + fsync + rename into place, `O_NOFOLLOW|O_EXCL` on the temp file, then fsync of the
/// directory so a power loss keeps either the old or the new content, never a torn file.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no parent"))?;
    let name = path.file_name().and_then(|n| n.to_str()).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no file name"))?;
    let rand = random_hex(6).map_err(|_| io::Error::new(io::ErrorKind::Other, "no random source"))?;
    let tmp = dir.join(format!(".{name}.tmp-{rand}"));
    let result = (|| {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(mode).custom_flags(libc::O_NOFOLLOW).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
        return result;
    }
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Reads a regular file (never through a symlink) of at most `cap` bytes.
pub(crate) fn read_capped(path: &Path, cap: u64) -> io::Result<Vec<u8>> {
    let f = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path)?;
    let meta = f.metadata()?;
    if !meta.file_type().is_file() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "not a regular file"));
    }
    if meta.len() > cap {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "file too large"));
    }
    let mut out = Vec::with_capacity(meta.len() as usize);
    f.take(cap + 1).read_to_end(&mut out)?;
    if out.len() as u64 > cap {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "file too large"));
    }
    Ok(out)
}

fn make_private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().recursive(true).mode(0o700).create(path)
}

fn secs(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn age(now: SystemTime, then: SystemTime) -> Duration {
    now.duration_since(then).unwrap_or(Duration::ZERO)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(digest::digest(&digest::SHA256, bytes).as_ref())
}

// ------------------------------------------------------------------------------------------
// Tokens, markers, directories
// ------------------------------------------------------------------------------------------

/// A token is 16 lowercase hex digits; it names markers and snapshot directories, so it is
/// validated before it ever becomes part of a path.
pub fn is_token(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    pub fn new() -> Result<Token, UpdateError> {
        Ok(Token(random_hex(8)?))
    }

    pub fn parse(s: &str) -> Option<Token> {
        is_token(s).then(|| Token(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Marker {
    /// Written by the new instance first thing in its process; holds its pid.
    Started,
    /// Written by the new instance after the webview reported ready (+ 3 s).
    Confirmed,
    /// Written by the relauncher after it put the old bundle back.
    RolledBack,
    /// Written by the old instance after it restored the snapshot.
    Restored,
    /// Written by the new instance's normal exit handler while still unconfirmed.
    CleanExit,
}

impl Marker {
    const ALL: [Marker; 5] = [Marker::Started, Marker::Confirmed, Marker::RolledBack, Marker::Restored, Marker::CleanExit];

    fn prefix(self) -> &'static str {
        match self {
            Marker::Started => "started-",
            Marker::Confirmed => "confirmed-",
            Marker::RolledBack => "rolled-back-",
            Marker::Restored => "restored-",
            Marker::CleanExit => "clean-exit-",
        }
    }
}

/// The directory `<state>/updates` and the names inside it.
#[derive(Clone, Debug)]
pub struct UpdateDirs {
    root: PathBuf,
}

impl UpdateDirs {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        UpdateDirs { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn state_file(&self) -> PathBuf {
        self.root.join("state.json")
    }

    pub fn trust_file(&self) -> PathBuf {
        self.root.join("trust.json")
    }

    pub fn feedstate_file(&self) -> PathBuf {
        self.root.join("feedstate.json")
    }

    pub fn feed_cache_dir(&self) -> PathBuf {
        self.root.join("feed-cache")
    }

    pub fn dl_dir(&self) -> PathBuf {
        self.root.join("dl")
    }

    pub fn lock_file(&self) -> PathBuf {
        self.root.join("lock")
    }

    pub fn log_file(&self) -> PathBuf {
        self.root.join("updates.log")
    }

    pub fn pre_dir(&self, token: &Token) -> PathBuf {
        self.root.join(format!("pre-{}", token.as_str()))
    }

    pub fn marker(&self, kind: Marker, token: &Token) -> PathBuf {
        self.root.join(format!("{}{}", kind.prefix(), token.as_str()))
    }

    /// Creates `updates/`, `dl/` and `feed-cache/` (0700). The root must be a real directory.
    pub fn ensure(&self) -> Result<(), UpdateError> {
        for d in [self.root.clone(), self.dl_dir(), self.feed_cache_dir()] {
            make_private_dir(&d).map_err(|e| io_err(&e, "create state directory"))?;
        }
        let m = fs::symlink_metadata(&self.root).map_err(|e| io_err(&e, "state directory"))?;
        if !m.file_type().is_dir() {
            return Err(UpdateError::with(ErrorCode::NotWritable, "state directory is not a real directory"));
        }
        Ok(())
    }

    pub fn marker_exists(&self, kind: Marker, token: &Token) -> bool {
        fs::symlink_metadata(self.marker(kind, token)).map(|m| m.file_type().is_file()).unwrap_or(false)
    }

    pub fn write_marker(&self, kind: Marker, token: &Token, content: &str) -> Result<(), UpdateError> {
        write_atomic(&self.marker(kind, token), content.as_bytes(), 0o600).map_err(|e| io_err(&e, "write marker"))
    }

    pub fn remove_markers(&self, token: &Token) {
        for kind in Marker::ALL {
            let _ = fs::remove_file(self.marker(kind, token));
        }
    }
}

// ------------------------------------------------------------------------------------------
// state.json (a hint)
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Staged,
    Applying,
    Confirmed,
    RolledBack,
}

/// `{ phase: "staged", version, arch, tarName, stageDir, appPath, preparedAt, bytes }` after
/// prepare (P7); `{ phase: "applying", token, from, to, stageDir, appPath }` during an apply (A3).
/// Unknown fields are ignored. No hash is ever stored here or trusted from here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub phase: Phase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tar_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_dir: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepared_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}

const STATE_MAX_BYTES: u64 = 64 * 1024;

impl UpdateState {
    /// P7.
    pub fn staged(version: &str, arch: &str, tar_name: &str, stage_dir: &Path, app_path: &Path, prepared_at: SystemTime, bytes: u64) -> UpdateState {
        UpdateState {
            phase: Phase::Staged,
            version: Some(version.to_string()),
            arch: Some(arch.to_string()),
            tar_name: Some(tar_name.to_string()),
            stage_dir: Some(stage_dir.to_path_buf()),
            app_path: Some(app_path.to_path_buf()),
            prepared_at: Some(secs(prepared_at)),
            bytes: Some(bytes),
            token: None,
            from: None,
            to: None,
        }
    }

    fn token(&self) -> Option<Token> {
        self.token.as_deref().and_then(Token::parse)
    }
}

/// `None` when the file is missing, unreadable or malformed: it is only ever a hint.
pub fn read_state(dirs: &UpdateDirs) -> Option<UpdateState> {
    let bytes = read_capped(&dirs.state_file(), STATE_MAX_BYTES).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn write_state(dirs: &UpdateDirs, state: &UpdateState) -> Result<(), UpdateError> {
    let bytes = serde_json::to_vec(state).map_err(|_| corrupt("state"))?;
    write_atomic(&dirs.state_file(), &bytes, 0o600).map_err(|e| io_err(&e, "write state.json"))
}

pub fn clear_state(dirs: &UpdateDirs) {
    let _ = fs::remove_file(dirs.state_file());
}

// ------------------------------------------------------------------------------------------
// feedstate.json, trust.json, the feed cache
// ------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PerChannel<T> {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stable: Option<T>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpha: Option<T>,
}

impl<T: Copy> PerChannel<T> {
    pub fn get(&self, ch: Channel) -> Option<T> {
        match ch {
            Channel::Stable => self.stable,
            Channel::Alpha => self.alpha,
        }
    }

    pub fn set(&mut self, ch: Channel, v: T) {
        match ch {
            Channel::Stable => self.stable = Some(v),
            Channel::Alpha => self.alpha = Some(v),
        }
    }
}

/// The security state of the update decision, outside `settings.json` so the webview cannot reach it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedState {
    /// The highest accepted `seq` per channel.
    #[serde(default)]
    pub floor: PerChannel<u64>,
    /// The highest verified version string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highest_seen: Option<String>,
    /// Epoch seconds of the last verified feed per channel.
    #[serde(default)]
    pub verified_at: PerChannel<u64>,
}

/// Missing file: the default (a fresh install). A corrupt file is an error the engine must see
/// (silently resetting the floor would reopen a replay); `quarantine` moves it aside.
pub fn load_feed_state(dirs: &UpdateDirs) -> Result<FeedState, UpdateError> {
    match read_capped(&dirs.feedstate_file(), STATE_MAX_BYTES) {
        Ok(b) => serde_json::from_slice(&b).map_err(|_| corrupt("feedstate.json")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(FeedState::default()),
        Err(_) => Err(corrupt("feedstate.json")),
    }
}

pub fn save_feed_state(dirs: &UpdateDirs, st: &FeedState) -> Result<(), UpdateError> {
    let bytes = serde_json::to_vec(st).map_err(|_| corrupt("feedstate"))?;
    write_atomic(&dirs.feedstate_file(), &bytes, 0o600).map_err(|e| io_err(&e, "write feedstate.json"))
}

/// Revoked key ids. Missing file: none. Any defect is an error (`Revocations::from_json` is strict).
pub fn load_revocations(dirs: &UpdateDirs) -> Result<Revocations, UpdateError> {
    match read_capped(&dirs.trust_file(), 8192) {
        Ok(b) => {
            let text = String::from_utf8(b).map_err(|_| corrupt("trust.json"))?;
            Revocations::from_json(&text).map_err(|_| corrupt("trust.json"))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Revocations::new()),
        Err(_) => Err(corrupt("trust.json")),
    }
}

pub fn save_revocations(dirs: &UpdateDirs, rev: &Revocations) -> Result<(), UpdateError> {
    write_atomic(&dirs.trust_file(), rev.to_json().as_bytes(), 0o600).map_err(|e| io_err(&e, "write trust.json"))
}

/// Moves a corrupt state file to `<name>.corrupt-<rand>` so it is kept for diagnosis.
pub fn quarantine(path: &Path) -> Result<PathBuf, UpdateError> {
    let name = path.file_name().and_then(|n| n.to_str()).ok_or_else(|| corrupt("path"))?;
    let to = path.with_file_name(format!("{name}.corrupt-{}", random_hex(4)?));
    fs::rename(path, &to).map_err(|e| io_err(&e, "quarantine"))?;
    Ok(to)
}

pub fn write_feed_cache(dirs: &UpdateDirs, ch: Channel, feed: &[u8], sig: &str) -> Result<(), UpdateError> {
    let dir = dirs.feed_cache_dir();
    make_private_dir(&dir).map_err(|e| io_err(&e, "create feed cache"))?;
    // Signature first: a crash in between leaves a pair that no longer verifies and is dropped on load.
    write_atomic(&dir.join(format!("{}.json.sig", ch.as_str())), sig.as_bytes(), 0o600).map_err(|e| io_err(&e, "write feed cache"))?;
    write_atomic(&dir.join(format!("{}.json", ch.as_str())), feed, 0o600).map_err(|e| io_err(&e, "write feed cache"))
}

/// The cached bytes; the caller re-verifies them on every load.
pub fn read_feed_cache(dirs: &UpdateDirs, ch: Channel) -> Option<(Vec<u8>, String)> {
    let dir = dirs.feed_cache_dir();
    let feed = read_capped(&dir.join(format!("{}.json", ch.as_str())), FEED_MAX_BYTES).ok()?;
    let sig = read_capped(&dir.join(format!("{}.json.sig", ch.as_str())), FEED_SIG_MAX_BYTES).ok()?;
    Some((feed, String::from_utf8(sig).ok()?))
}

// ------------------------------------------------------------------------------------------
// Pre-swap snapshot of the small state files (A3, A7, T29)
// ------------------------------------------------------------------------------------------

const SNAPSHOT_FILE_MAX: u64 = 8 * 1024 * 1024;
const SNAPSHOT_MANIFEST_MAX: u64 = 256 * 1024;

#[derive(Serialize, Deserialize)]
struct SnapshotEntry {
    id: String,
    path: PathBuf,
    existed: bool,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    mode: u32,
}

#[derive(Serialize, Deserialize)]
struct SnapshotManifest {
    schema: u32,
    entries: Vec<SnapshotEntry>,
}

/// Copies `files` (small files only) to `pre-<token>/`. A file that does not exist is recorded as
/// absent so a rollback removes what the new version created. On any error nothing is left behind.
pub fn snapshot_create(dirs: &UpdateDirs, token: &Token, files: &[PathBuf]) -> Result<(), UpdateError> {
    let pre = dirs.pre_dir(token);
    let result = (|| -> Result<(), UpdateError> {
        make_private_dir(&pre).map_err(|e| io_err(&e, "create snapshot"))?;
        let mut entries = Vec::new();
        for (i, path) in files.iter().enumerate() {
            let id = format!("f{i:04}");
            match fs::symlink_metadata(path) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    entries.push(SnapshotEntry { id, path: path.clone(), existed: false, size: 0, sha256: String::new(), mode: 0 });
                }
                Err(e) => return Err(io_err(&e, "snapshot stat")),
                Ok(m) if !m.file_type().is_file() => {
                    return Err(UpdateError::with(ErrorCode::SwapFailed, "snapshot: not a regular file"));
                }
                Ok(m) => {
                    let bytes = read_capped(path, SNAPSHOT_FILE_MAX).map_err(|e| io_err(&e, "snapshot read"))?;
                    write_atomic(&pre.join(&id), &bytes, 0o600).map_err(|e| io_err(&e, "snapshot write"))?;
                    entries.push(SnapshotEntry { id, path: path.clone(), existed: true, size: bytes.len() as u64, sha256: sha256_hex(&bytes), mode: m.mode() & 0o777 });
                }
            }
        }
        let manifest = serde_json::to_vec(&SnapshotManifest { schema: 1, entries }).map_err(|_| corrupt("snapshot"))?;
        write_atomic(&pre.join("manifest.json"), &manifest, 0o600).map_err(|e| io_err(&e, "snapshot manifest"))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&pre);
    }
    result
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SnapshotRestore {
    pub restored: usize,
    /// Files that did not exist before the swap and were removed.
    pub removed: usize,
    /// Entries skipped because they failed an integrity check or are not in the allowed list.
    pub skipped: usize,
}

/// Puts the snapshot back over the live files. Only paths in `files` are touched (the manifest is
/// not trusted for a path); each entry is checked against its recorded hash; a broken entry is
/// skipped, never half-applied, so the old app can still start.
pub fn snapshot_restore(dirs: &UpdateDirs, token: &Token, files: &[PathBuf]) -> Result<SnapshotRestore, UpdateError> {
    let pre = dirs.pre_dir(token);
    let raw = read_capped(&pre.join("manifest.json"), SNAPSHOT_MANIFEST_MAX).map_err(|_| corrupt("snapshot manifest"))?;
    let manifest: SnapshotManifest = serde_json::from_slice(&raw).map_err(|_| corrupt("snapshot manifest"))?;
    if manifest.schema != 1 {
        return Err(corrupt("snapshot manifest"));
    }
    let mut out = SnapshotRestore::default();
    for e in &manifest.entries {
        if !files.contains(&e.path) || !e.path.is_absolute() {
            out.skipped += 1;
            continue;
        }
        if !e.existed {
            match fs::symlink_metadata(&e.path) {
                Ok(m) if m.file_type().is_file() || m.file_type().is_symlink() => {
                    if fs::remove_file(&e.path).is_ok() {
                        out.removed += 1;
                    } else {
                        out.skipped += 1;
                    }
                }
                _ => {}
            }
            continue;
        }
        let ok_id = e.id.len() == 5 && e.id.starts_with('f') && e.id[1..].bytes().all(|b| b.is_ascii_digit());
        let bytes = if ok_id { read_capped(&pre.join(&e.id), SNAPSHOT_FILE_MAX).ok() } else { None };
        match bytes {
            Some(b) if sha256_hex(&b) == e.sha256 && b.len() as u64 == e.size => {
                if write_atomic(&e.path, &b, e.mode & 0o777).is_ok() {
                    out.restored += 1;
                } else {
                    out.skipped += 1;
                }
            }
            _ => out.skipped += 1,
        }
    }
    Ok(out)
}

pub fn snapshot_remove(dirs: &UpdateDirs, token: &Token) {
    let _ = fs::remove_dir_all(dirs.pre_dir(token));
}

// ------------------------------------------------------------------------------------------
// The lock (T20)
// ------------------------------------------------------------------------------------------

pub trait ProcessProbe {
    fn alive(&self, pid: u32) -> bool;
}

/// `/bin/ps -p <pid>`: exit 0 when the process exists, whoever owns it.
pub struct PsProbe;

impl ProcessProbe for PsProbe {
    fn alive(&self, pid: u32) -> bool {
        Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "pid="])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map(|o| o.status.success() && !o.stdout.iter().all(|b| b.is_ascii_whitespace()))
            .unwrap_or(false)
    }
}

/// `<state>/updates/lock` holding the pid, created with `O_EXCL`. A lock whose pid is gone is
/// stale and replaced. Released on drop.
#[derive(Debug)]
pub struct UpdateLock {
    path: PathBuf,
    pid: u32,
}

fn read_pid(path: &Path) -> Option<u32> {
    read_capped(path, 64).ok().and_then(|b| String::from_utf8(b).ok()).and_then(|s| s.trim().parse::<u32>().ok())
}

impl UpdateLock {
    pub fn acquire(dirs: &UpdateDirs, pid: u32, probe: &dyn ProcessProbe) -> Result<UpdateLock, UpdateError> {
        let path = dirs.lock_file();
        // The pid is written to a private temp file first and the lock appears by `link(2)`, which
        // fails if it exists: the lock is never visible empty, so nobody mistakes it for stale.
        let tmp = path.with_file_name(format!(".lock.tmp-{}", random_hex(6)?));
        write_atomic_new(&tmp, format!("{pid}\n").as_bytes()).map_err(|e| io_err(&e, "write lock"))?;
        let result = (|| {
            for _ in 0..3 {
                match fs::hard_link(&tmp, &path) {
                    Ok(()) => return Ok(UpdateLock { path: path.clone(), pid }),
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => match read_pid(&path) {
                        Some(h) if probe.alive(h) => return Err(UpdateError::new(ErrorCode::AlreadyRunning)),
                        judged => {
                            // Stale (dead holder or garbage): move it aside atomically; only one racer wins the rename.
                            let aside = path.with_file_name(format!("lock.stale-{}", random_hex(4)?));
                            if fs::rename(&path, &aside).is_ok() {
                                // Another racer may have replaced the stale lock between our read and the
                                // rename: if what we moved is not what we judged, put it back.
                                if read_pid(&aside) != judged {
                                    let _ = fs::hard_link(&aside, &path);
                                }
                                let _ = fs::remove_file(&aside);
                            }
                        }
                    },
                    Err(e) => return Err(io_err(&e, "create lock")),
                }
            }
            Err(UpdateError::new(ErrorCode::AlreadyRunning))
        })();
        let _ = fs::remove_file(&tmp);
        result
    }
}

/// `O_EXCL|O_NOFOLLOW` 0600 file with content, fsynced (no rename).
fn write_atomic_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

impl Drop for UpdateLock {
    fn drop(&mut self) {
        if read_pid(&self.path) == Some(self.pid) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

// ------------------------------------------------------------------------------------------
// updates.log (6.5, T17)
// ------------------------------------------------------------------------------------------

const LOG_ROTATE_BYTES: u64 = 256 * 1024;
const DETAIL_MAX: usize = 200;

/// Epoch seconds as `YYYY-MM-DDTHH:MM:SSZ`.
pub fn rfc3339(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86_400) as i64;
    let rem = epoch_secs % 86_400;
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// Masks what must not reach the log: the home directory (and any `/Users/<name>`), URL queries and
/// fragments, and long base64-looking tokens (signatures).
pub fn redact(text: &str, home: Option<&Path>) -> String {
    let mut s = text.to_string();
    if let Some(h) = home.and_then(|h| h.to_str()).filter(|h| h.len() > 1) {
        s = s.replace(h, "~");
    }
    let mut out = String::with_capacity(s.len());
    let mut first = true;
    for tok in s.split(' ') {
        if !first {
            out.push(' ');
        }
        first = false;
        let mut tok = tok.to_string();
        if let Some(i) = tok.find("/Users/") {
            let rest = &tok[i + 7..];
            let end = rest.find('/').unwrap_or(rest.len());
            tok = format!("{}~{}", &tok[..i], &rest[end..]);
        }
        if tok.contains("://") {
            if let Some(i) = tok.find(['?', '#']) {
                tok.truncate(i);
            }
        }
        let b64 = tok.len() >= 48 && !tok.contains("://") && tok.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='));
        if b64 {
            out.push_str("<redacted>");
        } else {
            out.push_str(&tok);
        }
    }
    out
}

/// One log line: time, event, and only these optional facts.
#[derive(Clone, Debug, Default)]
pub struct LogEvent<'a> {
    pub event: &'a str,
    pub code: Option<ErrorCode>,
    pub from: Option<&'a str>,
    pub to: Option<&'a str>,
    pub host: Option<&'a str>,
    pub bytes: Option<u64>,
    pub ms: Option<u64>,
    /// Free text; redacted and capped.
    pub detail: Option<&'a str>,
}

impl<'a> LogEvent<'a> {
    pub fn new(event: &'a str) -> Self {
        LogEvent { event, ..Default::default() }
    }

    pub fn code(mut self, c: ErrorCode) -> Self {
        self.code = Some(c);
        self
    }

    pub fn versions(mut self, from: Option<&'a str>, to: Option<&'a str>) -> Self {
        self.from = from;
        self.to = to;
        self
    }

    pub fn detail(mut self, d: &'a str) -> Self {
        self.detail = Some(d);
        self
    }
}

pub struct UpdateLog {
    path: PathBuf,
    home: Option<PathBuf>,
}

impl UpdateLog {
    pub fn new(dirs: &UpdateDirs, home: Option<PathBuf>) -> Self {
        UpdateLog { path: dirs.log_file(), home }
    }

    /// Appends one JSON line (0600), rotating at 256 KiB (one old file kept). Never fails the caller.
    pub fn append(&self, now: SystemTime, ev: &LogEvent<'_>) {
        let home = self.home.as_deref();
        let mut obj = serde_json::Map::new();
        obj.insert("ts".into(), rfc3339(secs(now)).into());
        obj.insert("event".into(), redact(ev.event, home).into());
        if let Some(c) = ev.code {
            obj.insert("code".into(), c.as_str().into());
        }
        if let Some(v) = ev.from {
            obj.insert("from".into(), redact(v, home).into());
        }
        if let Some(v) = ev.to {
            obj.insert("to".into(), redact(v, home).into());
        }
        if let Some(h) = ev.host {
            // A host name only: no scheme, port, path or query.
            let host = h.split("://").last().unwrap_or("").split(['/', '?', '#', ':']).next().unwrap_or("");
            obj.insert("host".into(), host.into());
        }
        if let Some(v) = ev.bytes {
            obj.insert("bytes".into(), v.into());
        }
        if let Some(v) = ev.ms {
            obj.insert("ms".into(), v.into());
        }
        if let Some(d) = ev.detail {
            let r: String = redact(d, home).chars().filter(|c| !c.is_control()).take(DETAIL_MAX).collect();
            obj.insert("detail".into(), r.into());
        }
        let Ok(mut line) = serde_json::to_string(&serde_json::Value::Object(obj)) else { return };
        line.push('\n');
        if fs::metadata(&self.path).map(|m| m.len() >= LOG_ROTATE_BYTES).unwrap_or(false) {
            let _ = fs::rename(&self.path, self.path.with_file_name("updates.log.1"));
        }
        if let Ok(mut f) = fs::OpenOptions::new().append(true).create(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(&self.path) {
            let _ = f.write_all(line.as_bytes());
        }
    }

    /// The last `n` lines (already redacted when written), for "Copy diagnostic details".
    pub fn tail(&self, n: usize) -> Vec<String> {
        let Ok(bytes) = read_capped(&self.path, LOG_ROTATE_BYTES * 2) else { return Vec::new() };
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().collect();
        lines[lines.len().saturating_sub(n)..].iter().map(|l| l.to_string()).collect()
    }
}

// ------------------------------------------------------------------------------------------
// Names that come from state.json are validated before they are used in a path
// ------------------------------------------------------------------------------------------

/// `<product>_<version>_<arch>.app.tar.gz`: a single path component of safe characters.
pub fn valid_tar_name(name: &str) -> bool {
    name.len() <= 128
        && name.ends_with(".app.tar.gz")
        && !name.starts_with('.')
        && !name.contains("..")
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'+'))
}

fn verified_path(dirs: &UpdateDirs, tar_name: &str) -> Option<PathBuf> {
    valid_tar_name(tar_name).then(|| dirs.dl_dir().join(format!("{tar_name}.verified")))
}

/// The stage directory re-derived from the app location: same parent as the app, a stage name.
/// The path in `state.json` is only compared against it.
fn derived_stage(state: &UpdateState, app_path: &Path) -> Option<PathBuf> {
    let recorded = state.stage_dir.as_deref()?;
    let name = recorded.file_name()?.to_str()?;
    if !is_stage_dir_name(name) || recorded.parent() != app_path.parent() {
        return None;
    }
    Some(app_path.parent()?.join(name))
}

// ------------------------------------------------------------------------------------------
// A3: begin an apply
// ------------------------------------------------------------------------------------------

pub struct ApplyBegin<'a> {
    pub from: &'a str,
    pub to: &'a str,
    pub stage_dir: &'a Path,
    pub app_path: &'a Path,
    pub snapshot_files: &'a [PathBuf],
}

/// Snapshot the small state files, then record `applying` with a fresh token. Nothing is removed.
/// A crash between the two steps leaves an orphan `pre-<token>` that the stale cleanup removes.
pub fn begin_apply(dirs: &UpdateDirs, b: &ApplyBegin<'_>) -> Result<Token, UpdateError> {
    begin_apply_with(dirs, b, Token::new()?)
}

/// `begin_apply` with a token chosen by the caller (the real-process harness must know it before
/// the fixture app is built).
pub fn begin_apply_with(dirs: &UpdateDirs, b: &ApplyBegin<'_>, token: Token) -> Result<Token, UpdateError> {
    let prior = read_state(dirs).filter(|s| s.phase == Phase::Staged);
    snapshot_create(dirs, &token, b.snapshot_files)?;
    let mut st = prior.unwrap_or(UpdateState {
        phase: Phase::Applying,
        version: Some(b.to.to_string()),
        arch: None,
        tar_name: None,
        stage_dir: None,
        app_path: None,
        prepared_at: None,
        bytes: None,
        token: None,
        from: None,
        to: None,
    });
    st.phase = Phase::Applying;
    st.token = Some(token.as_str().to_string());
    st.from = Some(b.from.to_string());
    st.to = Some(b.to.to_string());
    st.stage_dir = Some(b.stage_dir.to_path_buf());
    st.app_path = Some(b.app_path.to_path_buf());
    if let Err(e) = write_state(dirs, &st) {
        snapshot_remove(dirs, &token);
        return Err(e);
    }
    Ok(token)
}

/// A3b: the final busy check found something. Back to `staged`, snapshot removed.
pub fn abort_apply(dirs: &UpdateDirs, token: &Token) {
    if let Some(mut st) = read_state(dirs) {
        if st.phase == Phase::Applying && st.token.as_deref() == Some(token.as_str()) {
            st.phase = Phase::Staged;
            st.token = None;
            st.from = None;
            st.to = None;
            let _ = write_state(dirs, &st);
        }
    }
    snapshot_remove(dirs, token);
    dirs.remove_markers(token);
}

// ------------------------------------------------------------------------------------------
// A7: the first thing the new (or restored old) instance does
// ------------------------------------------------------------------------------------------

pub struct BootCtx<'a> {
    pub dirs: &'a UpdateDirs,
    /// The version of the running binary.
    pub running: &'a Version,
    pub pid: u32,
    /// The same list `begin_apply` snapshotted.
    pub snapshot_files: &'a [PathBuf],
    pub log: Option<&'a UpdateLog>,
    pub now: SystemTime,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BootOutcome {
    Nothing,
    /// This is the new version of an apply: `started-<token>` was written with our pid.
    Started { token: String },
    /// The watchdog rolled the new version back and this is the old one again; the snapshot was restored.
    RolledBack { token: String, failed_version: String, restore: SnapshotRestore },
}

fn log_event(l: Option<&UpdateLog>, now: SystemTime, ev: LogEvent<'_>) {
    if let Some(l) = l {
        l.append(now, &ev);
    }
}

/// Called before any other module opens settings, the registry or the Keychain.
pub fn early_boot(ctx: &BootCtx<'_>) -> BootOutcome {
    let Some(mut st) = read_state(ctx.dirs) else { return BootOutcome::Nothing };
    let Some(token) = st.token() else {
        return BootOutcome::Nothing;
    };
    let from = st.from.clone().unwrap_or_default();
    let to = st.to.clone().unwrap_or_default();
    let running = ctx.running.to_string();
    match st.phase {
        Phase::Applying if to == running => {
            // The first line of the new process: prove we started, with our pid.
            if ctx.dirs.write_marker(Marker::Started, &token, &format!("{}\n", ctx.pid)).is_ok() {
                log_event(ctx.log, ctx.now, LogEvent::new("started").versions(Some(&from), Some(&to)));
                return BootOutcome::Started { token: token.as_str().to_string() };
            }
            BootOutcome::Nothing
        }
        Phase::Applying | Phase::RolledBack if from == running && (st.phase == Phase::RolledBack || ctx.dirs.marker_exists(Marker::RolledBack, &token)) => {
            let restore = if ctx.dirs.marker_exists(Marker::Restored, &token) {
                SnapshotRestore::default()
            } else {
                // Restore first, mark after: a crash in between simply restores again (idempotent).
                let r = snapshot_restore(ctx.dirs, &token, ctx.snapshot_files).unwrap_or_default();
                let _ = ctx.dirs.write_marker(Marker::Restored, &token, "");
                r
            };
            if st.phase != Phase::RolledBack {
                st.phase = Phase::RolledBack;
                let _ = write_state(ctx.dirs, &st);
            }
            log_event(ctx.log, ctx.now, LogEvent::new("rolledBack").code(ErrorCode::RolledBack).versions(Some(&from), Some(&to)));
            BootOutcome::RolledBack { token: token.as_str().to_string(), failed_version: to, restore }
        }
        _ => BootOutcome::Nothing,
    }
}

/// The normal exit handler of the new version while it is still unconfirmed: the watchdog must not
/// treat a user quitting within the first seconds as a crash.
pub fn mark_clean_exit(dirs: &UpdateDirs, running: &Version) {
    if let Some(st) = read_state(dirs) {
        if let (Phase::Applying, Some(token)) = (st.phase, st.token()) {
            if st.to.as_deref() == Some(running.to_string().as_str()) && !dirs.marker_exists(Marker::Confirmed, &token) {
                let _ = dirs.write_marker(Marker::CleanExit, &token, "");
            }
        }
    }
}

/// `update_ack_rollback`: the user saw the rollback notice.
pub fn ack_rollback(dirs: &UpdateDirs) {
    if let Some(st) = read_state(dirs) {
        if st.phase == Phase::RolledBack {
            if let Some(t) = st.token() {
                snapshot_remove(dirs, &t);
                dirs.remove_markers(&t);
            }
            clear_state(dirs);
        }
    }
}

// ------------------------------------------------------------------------------------------
// recover() and the cleanup
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiscardReason {
    /// The staged version is not newer than the running one (the user installed a DMG by hand).
    NotNewer,
    /// The kept signed tarball is missing or not a regular file of ours.
    TarballMissing,
    /// The A2 check (tarball hash/signature, stage tree hash) failed.
    CheckFailed(ErrorCode),
    /// The cached verified feed lists the version as withdrawn.
    Withdrawn,
    /// Prepared for another app path.
    OtherApp,
    /// `state.json` could not be turned into a stage that is safe to touch.
    Unreadable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecoverOutcome {
    Idle,
    /// The new version is running and the webview is not ready yet: call again after `update_boot_ready` + 3 s.
    AwaitingReady,
    /// The new version confirmed: `lastUpdatedFrom/To/At` are for the caller to write; the old bundle,
    /// the tarball and the snapshot were removed and `state.json` cleared.
    Confirmed { from: String, to: String },
    /// The old version is back after a watchdog rollback, waiting for `ack_rollback`.
    RolledBack { failed_version: String },
    /// A valid stage is ready for the Apply dialog.
    StageReady { version: String },
    StageDiscarded(DiscardReason),
}

pub struct RecoverCtx<'a> {
    pub dirs: &'a UpdateDirs,
    pub running: &'a Version,
    /// The canonical running bundle; `None` for a development build (no stage handling then).
    pub app_path: Option<&'a Path>,
    /// `Config.bundle_dir_name` (a constant, never taken from a tarball or `state.json`).
    pub bundle_dir_name: &'a str,
    pub uid: u32,
    pub now: SystemTime,
    /// The webview reported its first interactive screen at least 3 s ago.
    pub boot_ready: bool,
    /// `withdrawn` of the cached, re-verified feed.
    pub withdrawn: &'a [Version],
    /// A2 for a staged update: the kept tarball's hash and signature against the feed, and its
    /// streamed tree hash against the stage's. Supplied by the engine.
    pub stage_check: &'a dyn Fn(&UpdateState) -> Result<(), UpdateError>,
    pub log: Option<&'a UpdateLog>,
}

fn remove_tarball(dirs: &UpdateDirs, state: &UpdateState) {
    if let Some(p) = state.tar_name.as_deref().and_then(|n| verified_path(dirs, n)) {
        let _ = fs::remove_file(p);
    }
}

/// Deletes the stage derived from the app location (only if it passes `inspect_stage_dir`), the
/// kept tarball and the snapshot of `state`, then clears `state.json`. The markers stay when the
/// update was confirmed: the watchdog may still be polling `confirmed-<token>`, and deleting it
/// would let a later quit of the new app look like a crash. `cleanup_stale` removes them after 7 days.
fn discard_state(dirs: &UpdateDirs, state: &UpdateState, app_path: Option<&Path>, uid: u32, keep_markers: bool) {
    if let Some(stage) = app_path.and_then(|a| derived_stage(state, a)) {
        let _ = remove_stage_dir(&stage, uid);
    }
    remove_tarball(dirs, state);
    if let Some(t) = state.token() {
        snapshot_remove(dirs, &t);
        if !keep_markers {
            dirs.remove_markers(&t);
        }
    }
    clear_state(dirs);
}

/// `discard()` of the engine: a staged update (stage, tarball, state) and the downloads.
pub fn discard_all(dirs: &UpdateDirs, app_path: Option<&Path>, uid: u32) {
    if let Some(st) = read_state(dirs) {
        if st.phase == Phase::Staged {
            discard_state(dirs, &st, app_path, uid, false);
        }
    }
    if let Ok(rd) = fs::read_dir(dirs.dl_dir()) {
        for e in rd.flatten() {
            let _ = fs::remove_file(e.path());
        }
    }
}

pub fn recover(ctx: &RecoverCtx<'_>) -> RecoverOutcome {
    tidy_interrupted_swap(ctx);
    let outcome = recover_state(ctx);
    let keep = read_state(ctx.dirs);
    cleanup_stale(ctx.dirs, ctx.app_path, keep.as_ref(), ctx.uid, ctx.now);
    outcome
}

/// A power loss inside the three-step swap fallback can leave a bundle under `<dir>.new` or
/// `<dir>.back` in the stage, and a failed swap back leaves a refused bundle installed (see
/// `swap.rs`). Roll back to the old bundle before anything inspects the stage (idempotent, cheap).
fn tidy_interrupted_swap(ctx: &RecoverCtx<'_>) {
    let Some(app) = ctx.app_path else { return };
    let Some(st) = read_state(ctx.dirs) else { return };
    let Some(stage) = derived_stage(&st, app) else { return };
    if let Ok(r) = crate::swap::repair_interrupted(&crate::swap::SystemFs, app, &stage, ctx.bundle_dir_name) {
        if r != crate::swap::Repair::Nothing {
            log_event(ctx.log, ctx.now, LogEvent::new("swapRepaired").detail(&format!("{r:?}")));
        }
    }
}

fn recover_state(ctx: &RecoverCtx<'_>) -> RecoverOutcome {
    let Some(mut st) = read_state(ctx.dirs) else { return RecoverOutcome::Idle };
    let running = ctx.running.to_string();
    let discard = |st: &UpdateState, why: DiscardReason| {
        discard_state(ctx.dirs, st, ctx.app_path, ctx.uid, false);
        log_event(ctx.log, ctx.now, LogEvent::new("stageDiscarded").detail(&format!("{why:?}")));
        RecoverOutcome::StageDiscarded(why)
    };
    match st.phase {
        Phase::Confirmed => {
            // A crash after the confirm marker but before the cleanup finished: finish it.
            let (from, to) = (st.from.clone().unwrap_or_default(), st.to.clone().unwrap_or_default());
            discard_state(ctx.dirs, &st, ctx.app_path, ctx.uid, true);
            RecoverOutcome::Confirmed { from, to }
        }
        Phase::RolledBack => RecoverOutcome::RolledBack { failed_version: st.to.clone().unwrap_or_default() },
        Phase::Applying => {
            let (from, to) = (st.from.clone().unwrap_or_default(), st.to.clone().unwrap_or_default());
            let Some(token) = st.token() else { return discard(&st, DiscardReason::Unreadable) };
            if to == running {
                if !ctx.boot_ready {
                    return RecoverOutcome::AwaitingReady;
                }
                // The new version is up: confirm first (the watchdog stops watching), then clean up.
                if ctx.dirs.write_marker(Marker::Confirmed, &token, "").is_err() {
                    return RecoverOutcome::AwaitingReady;
                }
                st.phase = Phase::Confirmed;
                let _ = write_state(ctx.dirs, &st);
                discard_state(ctx.dirs, &st, ctx.app_path, ctx.uid, true);
                log_event(ctx.log, ctx.now, LogEvent::new("confirmed").versions(Some(&from), Some(&to)));
                return RecoverOutcome::Confirmed { from, to };
            }
            if from == running {
                if ctx.dirs.marker_exists(Marker::RolledBack, &token) {
                    // early_boot was not run (or died before it recorded the rollback): record it now.
                    st.phase = Phase::RolledBack;
                    let _ = write_state(ctx.dirs, &st);
                    return RecoverOutcome::RolledBack { failed_version: to };
                }
                // Crash between A3 and A4: nothing was swapped. Back to a staged update.
                log_event(ctx.log, ctx.now, LogEvent::new("applyAbandoned").versions(Some(&from), Some(&to)));
                snapshot_remove(ctx.dirs, &token);
                ctx.dirs.remove_markers(&token);
                st.phase = Phase::Staged;
                st.token = None;
                st.from = None;
                st.to = None;
                let _ = write_state(ctx.dirs, &st);
                return recover_staged(ctx, st, &running, &discard);
            }
            // Neither version runs: the user installed something else by hand.
            discard(&st, DiscardReason::NotNewer)
        }
        Phase::Staged => recover_staged(ctx, st, &running, &discard),
    }
}

fn recover_staged(ctx: &RecoverCtx<'_>, st: UpdateState, running: &str, discard: &dyn Fn(&UpdateState, DiscardReason) -> RecoverOutcome) -> RecoverOutcome {
    let Some(app_path) = ctx.app_path else { return discard(&st, DiscardReason::Unreadable) };
    let Some(version) = st.version.as_deref().and_then(|v| crate::version::parse_strict(v).ok()) else {
        return discard(&st, DiscardReason::Unreadable);
    };
    if version.to_string() == running || version <= *ctx.running {
        return discard(&st, DiscardReason::NotNewer);
    }
    if ctx.withdrawn.contains(&version) {
        return discard(&st, DiscardReason::Withdrawn);
    }
    if st.app_path.as_deref() != Some(app_path) {
        return discard(&st, DiscardReason::OtherApp);
    }
    let Some(tar) = st.tar_name.as_deref().and_then(|n| verified_path(ctx.dirs, n)) else {
        return discard(&st, DiscardReason::Unreadable);
    };
    match fs::symlink_metadata(&tar) {
        Ok(m) if m.file_type().is_file() && m.uid() == ctx.uid => {}
        _ => return discard(&st, DiscardReason::TarballMissing),
    }
    let Some(stage) = derived_stage(&st, app_path) else { return discard(&st, DiscardReason::Unreadable) };
    if inspect_stage_dir(&stage, ctx.uid).is_err() {
        return discard(&st, DiscardReason::Unreadable);
    }
    match (ctx.stage_check)(&st) {
        Ok(()) => RecoverOutcome::StageReady { version: version.to_string() },
        Err(e) => discard(&st, DiscardReason::CheckFailed(e.code)),
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CleanupReport {
    pub stages: usize,
    pub downloads: usize,
    pub snapshots: usize,
    pub markers: usize,
}

const DL_LEFTOVER_AGE: Duration = Duration::from_secs(3600);

fn is_marker_name(name: &str) -> bool {
    Marker::ALL.iter().any(|k| name.strip_prefix(k.prefix()).map(is_token).unwrap_or(false))
}

/// Deletes only what matches a strict pattern AND is old enough AND is not referenced by `keep`:
/// stage directories (pattern + marker + real directory + owner, 7 days), `dl/` leftovers (1 hour,
/// except the tarball `keep` still needs), unreferenced `pre-*` snapshots and markers (7 days).
pub fn cleanup_stale(dirs: &UpdateDirs, app_path: Option<&Path>, keep: Option<&UpdateState>, uid: u32, now: SystemTime) -> CleanupReport {
    let mut rep = CleanupReport::default();
    let keep_token = keep.and_then(|s| s.token());
    let keep_tar = keep.and_then(|s| s.tar_name.as_deref().filter(|n| valid_tar_name(n)).map(|n| format!("{n}.verified")));
    if let Ok(rd) = fs::read_dir(dirs.dl_dir()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if keep_tar.as_deref() == Some(name.as_str()) {
                continue;
            }
            let Ok(m) = fs::symlink_metadata(e.path()) else { continue };
            let old = m.modified().map(|t| age(now, t) >= DL_LEFTOVER_AGE).unwrap_or(true);
            if old && !m.file_type().is_dir() && fs::remove_file(e.path()).is_ok() {
                rep.downloads += 1;
            }
        }
    }
    if let Ok(rd) = fs::read_dir(dirs.root()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let Ok(m) = fs::symlink_metadata(e.path()) else { continue };
            let old = m.modified().map(|t| age(now, t) >= STAGE_RETENTION).unwrap_or(false);
            let kept = |tok: &str| keep_token.as_ref().map(|k| k.as_str()) == Some(tok);
            if let Some(tok) = name.strip_prefix("pre-").filter(|t| is_token(t)) {
                if m.file_type().is_dir() && old && !kept(tok) && fs::remove_dir_all(e.path()).is_ok() {
                    rep.snapshots += 1;
                }
            } else if is_marker_name(&name) {
                let tok = name.rsplit('-').next().unwrap_or("");
                if m.file_type().is_file() && old && !kept(tok) && fs::remove_file(e.path()).is_ok() {
                    rep.markers += 1;
                }
            }
        }
    }
    if let Some(parent) = app_path.and_then(|a| a.parent()) {
        let keep_stage = keep.and_then(|s| s.stage_dir.as_deref()).and_then(|p| p.file_name()).map(|n| n.to_os_string());
        if let Ok(rd) = fs::read_dir(parent) {
            for e in rd.flatten() {
                let fname = e.file_name();
                if !fname.to_str().map(is_stage_dir_name).unwrap_or(false) || keep_stage.as_deref() == Some(fname.as_os_str()) {
                    continue;
                }
                let Ok(info) = inspect_stage_dir(&e.path(), uid) else { continue };
                if age(now, info.modified) >= STAGE_RETENTION && remove_stage_dir(&e.path(), uid).is_ok() {
                    rep.stages += 1;
                }
            }
        }
    }
    rep
}
