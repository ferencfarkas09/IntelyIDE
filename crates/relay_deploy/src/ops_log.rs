//! `ops.jsonl` (spec 4.3, 5.3): an append-only debug log of relay operations. One line per operation with the time, the operation, the
//! outcome, the Worker name, the last four characters of the account id, the exit code and the duration. Never argv values, never
//! output, never an e-mail or a token: the record has no field that could hold them, and every text field is re-validated on write.
//! This is not the record of what happened: that is the tamper-evident Remote audit chain (T6).

use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::kit::private_dir;

pub const MAX_LINES: usize = 500;
pub const MAX_AGE_SECS: u64 = 90 * 86_400;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpRecord {
    pub ts: u64,
    pub op: String,
    /// `ok`, `failed:<code>`, `cancelled`.
    pub outcome: String,
    pub worker: String,
    pub account_tail: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
}

/// The text itself when it is a plain slug, `invalid` otherwise: a hostile or accidental value is never written in part.
fn slug(s: &str, extra: &[char], max: usize) -> String {
    if s.len() <= max && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(&c)) {
        s.to_owned()
    } else {
        "invalid".to_owned()
    }
}

impl OpRecord {
    fn cleaned(&self) -> Self {
        Self {
            ts: self.ts,
            op: slug(&self.op, &['_', '-'], 40),
            outcome: slug(&self.outcome, &['_', '-', ':'], 60),
            worker: slug(&self.worker, &['-'], 63),
            account_tail: slug(&self.account_tail, &[], 4),
            exit_code: self.exit_code,
            duration_ms: self.duration_ms,
        }
    }
}

pub struct OpsLog {
    path: PathBuf,
}

impl OpsLog {
    /// `root` is `<data dir>/relay-deploy`.
    pub fn new(root: &Path) -> Self {
        Self { path: root.join("ops.jsonl") }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn read(&self) -> Vec<OpRecord> {
        fs::read_to_string(&self.path).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
    }

    /// Appends one record and prunes to [`MAX_LINES`] lines and [`MAX_AGE_SECS`] (relative to `rec.ts`).
    pub fn append(&self, rec: &OpRecord) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            private_dir(dir)?;
        }
        let line = serde_json::to_string(&rec.cleaned()).map_err(|e| crate::DeployError::Io(e.to_string()))?;
        let mut f = fs::OpenOptions::new().create(true).append(true).mode(0o600).open(&self.path)?;
        writeln!(f, "{line}")?;
        drop(f);
        let all = self.read();
        let keep: Vec<&OpRecord> = all.iter().filter(|r| rec.ts.saturating_sub(r.ts) <= MAX_AGE_SECS).collect();
        if keep.len() != all.len() || keep.len() > MAX_LINES {
            let from = keep.len().saturating_sub(MAX_LINES);
            let text: String = keep[from..].iter().filter_map(|r| serde_json::to_string(r).ok()).map(|l| l + "\n").collect();
            fs::write(&self.path, text)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(ts: u64, worker: &str) -> OpRecord {
        OpRecord { ts, op: "deploy".into(), outcome: "ok".into(), worker: worker.into(), account_tail: "cdef".into(), exit_code: Some(0), duration_ms: 12 }
    }

    #[test]
    fn appends_and_keeps_only_the_last_500_lines() {
        let tmp = tempfile::tempdir().unwrap();
        let log = OpsLog::new(&tmp.path().join("relay-deploy"));
        for i in 0..520u64 {
            log.append(&rec(1_000_000 + i, "w")).unwrap();
        }
        let all = log.read();
        assert_eq!(all.len(), MAX_LINES);
        assert_eq!(all.first().unwrap().ts, 1_000_020);
        assert_eq!(all.last().unwrap().ts, 1_000_519);
        let mode = fs::metadata(log.path()).unwrap().permissions();
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&mode) & 0o777, 0o600);
    }

    #[test]
    fn drops_records_older_than_ninety_days() {
        let tmp = tempfile::tempdir().unwrap();
        let log = OpsLog::new(tmp.path());
        log.append(&rec(1_000, "old")).unwrap();
        log.append(&rec(1_000 + MAX_AGE_SECS + 1, "new")).unwrap();
        let all = log.read();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].worker, "new");
    }

    #[test]
    fn nothing_but_slugs_can_be_written() {
        let tmp = tempfile::tempdir().unwrap();
        let log = OpsLog::new(tmp.path());
        let hostile = OpRecord {
            ts: 5,
            op: "deploy --token cfut_SECRET\nnew line".into(),
            outcome: "failed: user@example.com".into(),
            worker: "w\"},{\"x\":\"y".into(),
            account_tail: "0123456789abcdef".into(),
            exit_code: None,
            duration_ms: 0,
        };
        log.append(&hostile).unwrap();
        let text = fs::read_to_string(log.path()).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(!text.contains("user@example.com") && !text.contains(' ') && !text.contains("--token"), "{text}");
        let r = &log.read()[0];
        assert_eq!((r.op.as_str(), r.outcome.as_str(), r.worker.as_str(), r.account_tail.as_str()), ("invalid", "invalid", "invalid", "invalid"));
        log.append(&rec(6, "intely-relay-0123456789ab")).unwrap();
        let last = log.read().pop().unwrap();
        assert_eq!((last.op.as_str(), last.outcome.as_str(), last.worker.as_str(), last.account_tail.as_str()), ("deploy", "ok", "intely-relay-0123456789ab", "cdef"));
    }
}
