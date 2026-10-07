//! `cloud-audit.jsonl`: a small append-only, hash-chained record of the cloud operations (deploy, redeploy, rotate, rollback, remove, forget).
//!
//! Why not the Remote audit chain: that one lives behind `remote::live()`, which would start the whole gateway just to write a line.
//! This one is standalone: no thread, no socket, no Keychain, no file until the first operation, and nothing is read until the next.
//! Each line holds the time, the event, a detail slug, the outcome, the Worker name and the last four characters of the account id,
//! plus the hash of the previous line and its own hash (sha256 over all fields, each length-prefixed). It has no field that could hold
//! argv values, output, an e-mail or a secret, and every text field is re-validated on write. It is never pruned and lives next to
//! (not inside) the relay state directory, so "forget" does not delete it.
//!
//! The hash chain is tamper-EVIDENT, not tamper-proof: someone who can write the file can rewrite all of it. It shows an edit in the
//! middle, a removed line or a swapped order to anyone who runs [`CloudAudit::verify`]. A removed TAIL leaves a valid shorter chain,
//! so every append also rewrites `cloud-audit.anchor` (the line count and the last hash, replaced atomically): a log shorter than its
//! anchor, or one whose line at the anchored position changed, is reported as well. Whoever deletes the anchor too is not noticed.
//!
//! Several processes can share the data directory (an installed app and a dev build): every append holds an exclusive `flock` on
//! `cloud-audit.lock`, re-reads and re-verifies the file under it, and writes the line with one `write`. A damaged log is not
//! continued; [`CloudAudit::quarantine`] (the "forget" command) keeps it aside, untouched, and starts a new chain.

use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::deployer::lock;
use crate::error::{DeployError, Result};
use crate::kit::private_dir;

pub const FILE: &str = "cloud-audit.jsonl";
/// The line count and last hash of the chain after the latest append (`<count> <hash>`).
pub const ANCHOR: &str = "cloud-audit.anchor";
const LOCK_FILE: &str = "cloud-audit.lock";
/// `prev` of the first entry.
pub const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// The events of this log. `outcome` is `started` (written BEFORE the operation runs, so an operation without a record does not run),
/// then `ok`, `failed:<code>` or `cancelled`.
pub mod event {
    pub const DEPLOY: &str = "deploy";
    pub const REDEPLOY: &str = "redeploy";
    pub const ROTATE: &str = "rotate";
    pub const ROLLBACK: &str = "rollback";
    pub const REMOVE: &str = "remove";
    pub const FORGET: &str = "forget";
    /// The three `wrangler secret put` calls of an existing profile (they write to the real account, so they are recorded too).
    pub const VAPID_PUSH: &str = "vapidPush";
    /// The first line of a new chain that replaced a damaged one (`CloudAudit::quarantine`).
    pub const AUDIT_RESET: &str = "auditReset";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub seq: u64,
    pub ts: u64,
    pub event: String,
    pub detail: String,
    pub outcome: String,
    pub worker: String,
    pub account_tail: String,
    pub prev: String,
    pub hash: String,
}

/// What an operation records (before the chain fields are added).
#[derive(Debug, Clone)]
pub struct AuditRecord<'a> {
    pub ts: u64,
    pub event: &'a str,
    pub detail: &'a str,
    pub outcome: &'a str,
    pub worker: &'a str,
    pub account_tail: &'a str,
}

/// The text itself when it is a plain slug, `invalid` otherwise: a hostile or accidental value is never written in part.
fn slug(s: &str, extra: &[char], max: usize) -> String {
    if s.len() <= max && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(&c)) {
        s.to_owned()
    } else {
        "invalid".to_owned()
    }
}

fn chain_hash(e: &AuditEntry) -> String {
    let mut h = Sha256::new();
    for part in [e.prev.as_str(), &e.seq.to_string(), &e.ts.to_string(), &e.event, &e.detail, &e.outcome, &e.worker, &e.account_tail] {
        h.update((part.len() as u64).to_le_bytes());
        h.update(part.as_bytes());
    }
    hex::encode(h.finalize())
}

/// Where a chain stops being valid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Broken {
    /// 1-based line number.
    pub line: usize,
    pub why: &'static str,
}

pub struct CloudAudit {
    path: PathBuf,
    write: Mutex<()>,
}

impl CloudAudit {
    /// `dir` is the app data directory (the one that holds `relay-deploy/`). Nothing is created here.
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join(FILE), write: Mutex::new(()) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Every entry that parses, in order (empty when the file does not exist).
    pub fn read(&self) -> Vec<AuditEntry> {
        fs::read_to_string(&self.path).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
    }

    fn anchor_path(&self) -> PathBuf {
        self.path.with_file_name(ANCHOR)
    }

    /// The anchor: `(count, hash of that line)`; `None` when there is none yet (a log from before the anchor existed) or it is unreadable.
    fn anchor(&self) -> Option<(usize, String)> {
        let text = fs::read_to_string(self.anchor_path()).ok()?;
        let (count, hash) = text.trim().split_once(' ')?;
        Some((count.parse().ok()?, hash.to_owned()))
    }

    fn write_anchor(&self, count: usize, hash: &str) -> Result<()> {
        let tmp = self.path.with_file_name(format!("{ANCHOR}.tmp"));
        let mut f = fs::OpenOptions::new().create(true).write(true).truncate(true).mode(0o600).open(&tmp)?;
        write!(f, "{count} {hash}\n")?;
        f.sync_all()?;
        fs::rename(&tmp, self.anchor_path())?;
        Ok(())
    }

    /// The hash of every line, in order, when the whole text is a valid chain.
    fn check(text: &str) -> std::result::Result<Vec<String>, Broken> {
        let mut prev = GENESIS.to_owned();
        let mut hashes: Vec<String> = Vec::new();
        for (i, l) in text.lines().enumerate() {
            let e: AuditEntry = serde_json::from_str(l).map_err(|_| Broken { line: i + 1, why: "not an entry" })?;
            if e.seq != hashes.len() as u64 + 1 {
                return Err(Broken { line: i + 1, why: "sequence" });
            }
            if e.prev != prev {
                return Err(Broken { line: i + 1, why: "link" });
            }
            if e.hash != chain_hash(&e) {
                return Err(Broken { line: i + 1, why: "hash" });
            }
            prev = e.hash.clone();
            hashes.push(e.hash);
        }
        Ok(hashes)
    }

    /// The chain must still reach the anchor and agree with it there. One line MORE than the anchor is a crash between the line and
    /// its anchor, which is fine.
    fn check_anchor(&self, hashes: &[String]) -> std::result::Result<(), Broken> {
        let Some((count, hash)) = self.anchor() else { return Ok(()) };
        if count > hashes.len() {
            return Err(Broken { line: hashes.len() + 1, why: "tail removed" });
        }
        if count > 0 && hashes[count - 1] != hash {
            return Err(Broken { line: count, why: "anchor" });
        }
        Ok(())
    }

    fn read_text(&self) -> std::result::Result<String, Broken> {
        match fs::read_to_string(&self.path) {
            Ok(t) => Ok(t),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(_) => Err(Broken { line: 0, why: "unreadable" }),
        }
    }

    /// Checks the whole chain: every line parses, the numbers count 1, 2, 3, every `prev` is the hash before it, every hash is the one
    /// its fields give and the chain still reaches its anchor (so a removed tail shows). `Ok(n)` entries, or the first broken line.
    /// A missing file is a valid empty chain.
    pub fn verify(&self) -> std::result::Result<usize, Broken> {
        let hashes = Self::check(&self.read_text()?)?;
        self.check_anchor(&hashes)?;
        Ok(hashes.len())
    }

    /// The data directory exists (private) and the exclusive lock on the log is held until the returned guard drops.
    fn locked(&self) -> Result<FileLock> {
        if let Some(dir) = self.path.parent() {
            private_dir(dir)?;
        }
        let f = fs::OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).open(self.path.with_file_name(LOCK_FILE))?;
        // SAFETY: flock on a descriptor this struct owns.
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(DeployError::Io(format!("the audit log lock failed: {}", std::io::Error::last_os_error())));
        }
        Ok(FileLock(f))
    }

    fn corrupt() -> DeployError {
        DeployError::coded("auditCorrupt", "the cloud audit log is damaged")
    }

    fn append_locked(&self, rec: &AuditRecord) -> Result<AuditEntry> {
        let hashes = Self::check(&self.read_text().map_err(|_| Self::corrupt())?).map_err(|_| Self::corrupt())?;
        self.check_anchor(&hashes).map_err(|_| Self::corrupt())?;
        let prev = hashes.last().cloned().unwrap_or_else(|| GENESIS.to_owned());
        let mut e = AuditEntry {
            seq: hashes.len() as u64 + 1,
            ts: rec.ts,
            event: slug(rec.event, &[], 24),
            detail: slug(rec.detail, &['-', '_'], 40),
            outcome: slug(rec.outcome, &['_', '-', ':'], 60),
            worker: slug(rec.worker, &['-'], 63),
            account_tail: slug(rec.account_tail, &[], 4),
            prev,
            hash: String::new(),
        };
        e.hash = chain_hash(&e);
        let line = format!("{}\n", serde_json::to_string(&e).map_err(|err| DeployError::Io(err.to_string()))?);
        let mut f = fs::OpenOptions::new().create(true).append(true).mode(0o600).open(&self.path)?;
        f.write_all(line.as_bytes())?;
        f.sync_all()?;
        self.write_anchor(hashes.len() + 1, &e.hash)?;
        Ok(e)
    }

    /// Appends one entry. Fails (so the caller can refuse the operation) when the file cannot be written or the chain on disk is not
    /// valid (an edit, a removed line or tail, garbage): a damaged log is never silently continued.
    pub fn append(&self, rec: &AuditRecord) -> Result<AuditEntry> {
        let _one = lock(&self.write);
        // the first operation may be the first thing that ever writes into the data directory
        let _file = self.locked()?;
        self.append_locked(rec)
    }

    /// The way out of a damaged log: when the chain does not verify, the file is renamed to `cloud-audit.jsonl.damaged-<ts>` (kept,
    /// untouched, as evidence), the anchor is dropped and a new chain starts with one `auditReset` line. `Ok(None)` when the log is fine.
    pub fn quarantine(&self, ts: u64) -> Result<Option<PathBuf>> {
        let _one = lock(&self.write);
        let _file = self.locked()?;
        if self.verify().is_ok() {
            return Ok(None);
        }
        let mut aside = self.path.with_file_name(format!("{FILE}.damaged-{ts}"));
        let mut n = 1;
        while aside.exists() {
            aside = self.path.with_file_name(format!("{FILE}.damaged-{ts}-{n}"));
            n += 1;
        }
        if self.path.exists() {
            fs::rename(&self.path, &aside)?;
        }
        let _ = fs::remove_file(self.anchor_path());
        self.append_locked(&AuditRecord { ts, event: event::AUDIT_RESET, detail: "damaged-log-kept", outcome: "ok", worker: "", account_tail: "" })?;
        Ok(Some(aside))
    }
}

/// An exclusive advisory lock that lasts as long as the descriptor.
struct FileLock(fs::File);

impl Drop for FileLock {
    fn drop(&mut self) {
        // SAFETY: unlocking the descriptor this guard owns; closing it would release the lock anyway.
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec<'a>(ts: u64, event: &'a str, outcome: &'a str) -> AuditRecord<'a> {
        AuditRecord { ts, event, detail: "", outcome, worker: "intely-relay-0123456789ab", account_tail: "cdef" }
    }

    fn log() -> (tempfile::TempDir, CloudAudit) {
        let tmp = tempfile::tempdir().unwrap();
        let a = CloudAudit::new(tmp.path());
        (tmp, a)
    }

    #[test]
    fn nothing_exists_until_the_first_operation() {
        let (tmp, a) = log();
        assert!(!a.path().exists() && a.read().is_empty());
        assert_eq!(a.verify(), Ok(0));
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 0, "constructing and reading create nothing");
    }

    #[test]
    fn entries_chain_from_the_genesis_and_verify() {
        let (_t, a) = log();
        let e1 = a.append(&rec(10, event::DEPLOY, "started")).unwrap();
        let e2 = a.append(&rec(11, event::DEPLOY, "ok")).unwrap();
        let e3 = a.append(&AuditRecord { detail: "signing", ..rec(12, event::ROTATE, "ok") }).unwrap();
        assert_eq!((e1.seq, e1.prev.as_str()), (1, GENESIS));
        assert_eq!((e2.seq, e2.prev.clone()), (2, e1.hash.clone()));
        assert_eq!((e3.seq, e3.prev.clone()), (3, e2.hash.clone()));
        assert_eq!(a.verify(), Ok(3));
        assert_eq!(a.read().iter().map(|e| e.event.as_str()).collect::<Vec<_>>(), ["deploy", "deploy", "rotate"]);
        let mode = fs::metadata(a.path()).unwrap().permissions();
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&mode) & 0o777, 0o600);
    }

    #[test]
    fn a_second_instance_continues_the_same_chain() {
        let (t, a) = log();
        a.append(&rec(1, event::REMOVE, "started")).unwrap();
        let b = CloudAudit::new(t.path());
        let e = b.append(&rec(2, event::REMOVE, "ok")).unwrap();
        assert_eq!(e.seq, 2);
        assert_eq!(b.verify(), Ok(2));
    }

    #[test]
    fn an_edited_removed_or_reordered_line_is_found() {
        let (_t, a) = log();
        for i in 0..4 {
            a.append(&rec(10 + i, event::DEPLOY, "ok")).unwrap();
        }
        let original = fs::read_to_string(a.path()).unwrap();
        let lines: Vec<&str> = original.lines().collect();
        // edit a field (the hash no longer fits)
        fs::write(a.path(), original.replace("\"ts\":11", "\"ts\":99")).unwrap();
        assert_eq!(a.verify(), Err(Broken { line: 2, why: "hash" }));
        // drop a line in the middle
        fs::write(a.path(), format!("{}\n{}\n{}\n", lines[0], lines[2], lines[3])).unwrap();
        assert_eq!(a.verify(), Err(Broken { line: 2, why: "sequence" }));
        // swap two lines
        fs::write(a.path(), format!("{}\n{}\n{}\n{}\n", lines[0], lines[2], lines[1], lines[3])).unwrap();
        assert!(a.verify().is_err());
        // garbage
        fs::write(a.path(), format!("{}\nnot json\n", lines[0])).unwrap();
        assert_eq!(a.verify(), Err(Broken { line: 2, why: "not an entry" }));
        // a truncated tail is not continued silently
        assert_eq!(a.append(&rec(50, event::DEPLOY, "started")).unwrap_err().code(), "auditCorrupt");
    }

    #[test]
    fn a_removed_tail_is_found_through_the_anchor() {
        let (_t, a) = log();
        for i in 0..5 {
            a.append(&rec(10 + i, event::DEPLOY, "ok")).unwrap();
        }
        assert_eq!(a.verify(), Ok(5));
        let original = fs::read_to_string(a.path()).unwrap();
        let lines: Vec<&str> = original.lines().collect();
        for keep in [4usize, 2, 0] {
            let kept: String = lines[..keep].iter().map(|l| format!("{l}\n")).collect();
            fs::write(a.path(), kept).unwrap();
            assert_eq!(a.verify(), Err(Broken { line: keep + 1, why: "tail removed" }), "kept {keep}");
            assert_eq!(a.append(&rec(50, event::DEPLOY, "started")).unwrap_err().code(), "auditCorrupt", "a shortened log is not continued");
        }
        // the whole file deleted
        fs::remove_file(a.path()).unwrap();
        assert_eq!(a.verify(), Err(Broken { line: 1, why: "tail removed" }));
        // a tail replaced by another valid-looking line cannot be the anchored one
        fs::write(a.path(), &original).unwrap();
        assert_eq!(a.verify(), Ok(5));
        let (b_dir, b) = log();
        for i in 0..5 {
            b.append(&rec(90 + i, event::DEPLOY, "ok")).unwrap();
        }
        let other = fs::read_to_string(b.path()).unwrap();
        drop(b_dir);
        fs::write(a.path(), other).unwrap();
        assert!(a.verify().is_err(), "a different chain of the same length does not match the anchor");
    }

    #[test]
    fn a_crash_between_the_line_and_its_anchor_is_not_an_alarm() {
        let (t, a) = log();
        a.append(&rec(1, event::DEPLOY, "started")).unwrap();
        let anchor_after_one = fs::read_to_string(t.path().join(ANCHOR)).unwrap();
        a.append(&rec(2, event::DEPLOY, "ok")).unwrap();
        fs::write(t.path().join(ANCHOR), anchor_after_one).unwrap();
        assert_eq!(a.verify(), Ok(2));
        a.append(&rec(3, event::DEPLOY, "started")).unwrap();
        assert_eq!(a.verify(), Ok(3));
    }

    #[test]
    fn a_log_without_an_anchor_is_still_valid_and_gets_one() {
        let (t, a) = log();
        a.append(&rec(1, event::DEPLOY, "started")).unwrap();
        fs::remove_file(t.path().join(ANCHOR)).unwrap();
        assert_eq!(a.verify(), Ok(1));
        a.append(&rec(2, event::DEPLOY, "ok")).unwrap();
        assert!(t.path().join(ANCHOR).is_file());
        assert_eq!(a.verify(), Ok(2));
    }

    #[test]
    fn an_edit_in_the_middle_stops_the_next_append_too() {
        let (_t, a) = log();
        for i in 0..4 {
            a.append(&rec(10 + i, event::DEPLOY, "ok")).unwrap();
        }
        let original = fs::read_to_string(a.path()).unwrap();
        fs::write(a.path(), original.replace("\"ts\":11", "\"ts\":99")).unwrap();
        assert_eq!(a.append(&rec(50, event::DEPLOY, "started")).unwrap_err().code(), "auditCorrupt");
    }

    #[test]
    fn instances_in_different_processes_cannot_interleave() {
        // one CloudAudit per thread stands for the installed app and a dev build sharing the data directory (separate Mutex, same flock)
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    let a = CloudAudit::new(&dir);
                    for i in 0..6 {
                        a.append(&rec(t * 100 + i, event::DEPLOY, "ok")).unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(CloudAudit::new(&dir).verify(), Ok(48));
    }

    #[test]
    fn a_damaged_log_is_kept_aside_and_a_new_chain_starts() {
        let (t, a) = log();
        assert_eq!(a.quarantine(5).unwrap(), None, "nothing to do for a log that does not exist");
        a.append(&rec(1, event::DEPLOY, "started")).unwrap();
        a.append(&rec(2, event::DEPLOY, "ok")).unwrap();
        assert_eq!(a.quarantine(5).unwrap(), None, "nothing to do for a valid log");
        assert_eq!(a.verify(), Ok(2));
        let mut text = fs::read_to_string(a.path()).unwrap();
        text.push_str("{\"seq\":3,\"partial\n");
        fs::write(a.path(), &text).unwrap();
        assert_eq!(a.append(&rec(6, event::FORGET, "started")).unwrap_err().code(), "auditCorrupt");
        let aside = a.quarantine(7).unwrap().expect("quarantined");
        assert_eq!(fs::read_to_string(&aside).unwrap(), text, "the damaged file is kept untouched");
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&fs::metadata(&aside).unwrap().permissions()) & 0o777, 0o600);
        assert_eq!(a.verify(), Ok(1));
        assert_eq!(a.read()[0].event, event::AUDIT_RESET);
        a.append(&rec(8, event::FORGET, "started")).unwrap();
        assert_eq!(a.verify(), Ok(2));
        // a second damage in the same second does not overwrite the first evidence
        fs::write(a.path(), "garbage\n").unwrap();
        let second = a.quarantine(7).unwrap().unwrap();
        assert_ne!(second, aside);
        assert_eq!(fs::read_to_string(&aside).unwrap(), text);
        assert!(t.path().join(ANCHOR).is_file());
    }

    #[test]
    fn nothing_but_slugs_can_be_written() {
        let (_t, a) = log();
        let hostile = AuditRecord {
            ts: 5,
            event: "deploy --token cfut_SECRET\nnew line",
            detail: "user@example.com",
            outcome: "failed: wrangler printed /Users/me/.wrangler/config",
            worker: "w\"},{\"x\":\"y",
            account_tail: "0123456789abcdef",
        };
        a.append(&hostile).unwrap();
        let text = fs::read_to_string(a.path()).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(!text.contains("user@example.com") && !text.contains("cfut_") && !text.contains(".wrangler") && !text.contains("--token"), "{text}");
        let e = &a.read()[0];
        assert_eq!((e.event.as_str(), e.detail.as_str(), e.outcome.as_str(), e.worker.as_str(), e.account_tail.as_str()), ("invalid", "invalid", "invalid", "invalid", "invalid"));
        assert_eq!(a.verify(), Ok(1));
    }

    #[test]
    fn an_unwritable_location_is_an_error_not_a_silent_skip() {
        let tmp = tempfile::tempdir().unwrap();
        // a regular file where the directory should be
        fs::write(tmp.path().join("blocker"), "x").unwrap();
        let a = CloudAudit::new(&tmp.path().join("blocker"));
        assert!(a.append(&rec(1, event::DEPLOY, "started")).is_err());
        // a directory that does not exist yet is created (private) by the first record
        let b = CloudAudit::new(&tmp.path().join("fresh/data"));
        b.append(&rec(2, event::DEPLOY, "started")).unwrap();
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&fs::metadata(tmp.path().join("fresh/data")).unwrap().permissions()) & 0o777, 0o700);
    }
}
