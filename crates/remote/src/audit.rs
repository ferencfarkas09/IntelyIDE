//! Append-only, hash-chained audit log `remote-audit.jsonl` (remote-plan 4.2, 4.3). Every line carries the hash of the previous
//! one, and the head hash is kept in the secret store, so editing, deleting or truncating lines shows. It records pairing,
//! step-up, approve/deny/prompt/stop/start and every rejected or rate-limited attempt, with device, request, risk and the hash
//! of the displayed intent. Never tokens, tool output or file content.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use intely_settings::{Secret, SecretStore};
use serde::{Deserialize, Serialize};

use crate::error::{RemoteError, Result};
use crate::identity::KEY_AUDIT_HEAD;
use crate::redact::display;
use crate::util::sha256_hex;

const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub seq: u64,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub ts: u64,
    pub event: String,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub device_id: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub req_id: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub agent_id: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub risk: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub intent_hash: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub detail: Option<String>,
    pub prev: String,
    pub hash: String,
}

/// What a caller records; the log adds sequence, time and the chain.
#[derive(Debug, Clone, Default)]
pub struct Record<'a> {
    pub event: &'a str,
    pub device_id: Option<&'a str>,
    pub req_id: Option<&'a str>,
    pub agent_id: Option<&'a str>,
    pub risk: Option<&'a str>,
    pub intent_hash: Option<&'a str>,
    pub detail: Option<&'a str>,
}

impl<'a> Record<'a> {
    pub fn new(event: &'a str) -> Self {
        Self { event, ..Self::default() }
    }

    pub fn device(mut self, d: &'a str) -> Self {
        self.device_id = Some(d);
        self
    }

    pub fn req(mut self, r: &'a str) -> Self {
        self.req_id = Some(r);
        self
    }

    pub fn agent(mut self, a: &'a str) -> Self {
        self.agent_id = Some(a);
        self
    }

    pub fn risk(mut self, r: &'a str) -> Self {
        self.risk = Some(r);
        self
    }

    pub fn intent(mut self, h: &'a str) -> Self {
        self.intent_hash = Some(h);
        self
    }

    pub fn detail(mut self, d: &'a str) -> Self {
        self.detail = Some(d);
        self
    }
}

fn entry_hash(e: &AuditEntry) -> String {
    let mut c = e.clone();
    c.hash = String::new();
    sha256_hex(format!("{}\n{}", e.prev, serde_json::to_string(&c).expect("entry serializes")).as_bytes())
}

pub struct AuditLog {
    path: PathBuf,
    secrets: Arc<dyn SecretStore>,
    head: String,
    seq: u64,
}

impl AuditLog {
    pub fn path_in(state_dir: &Path) -> PathBuf {
        state_dir.join("remote-audit.jsonl")
    }

    pub fn open(state_dir: &Path, secrets: Arc<dyn SecretStore>) -> Result<Self> {
        let path = Self::path_in(state_dir);
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };
        let (mut head, mut prev_head, mut seq) = (GENESIS.to_string(), GENESIS.to_string(), 0u64);
        for (i, line) in text.lines().enumerate() {
            let e: AuditEntry = serde_json::from_str(line).map_err(|_| RemoteError::Tampered(format!("audit line {} does not parse", i + 1)))?;
            if e.prev != head || e.hash != entry_hash(&e) || e.seq != seq + 1 {
                return Err(RemoteError::Tampered(format!("audit chain broken at line {}", i + 1)));
            }
            prev_head = head;
            head = e.hash.clone();
            seq = e.seq;
        }
        let stored = secrets.get(KEY_AUDIT_HEAD)?.map(|s| s.expose().to_string());
        match stored.as_deref() {
            None if seq == 0 => {}
            None => return Err(RemoteError::Tampered("audit head hash is missing from the secret store".into())),
            Some(h) if h == head => {}
            // a crash between the line and the head update: the file is one line ahead; accept and heal
            Some(h) if seq > 0 && h == prev_head => secrets.set(KEY_AUDIT_HEAD, Secret::new(head.clone()))?,
            Some(_) => return Err(RemoteError::Tampered("audit log was truncated or replaced".into())),
        }
        Ok(Self { path, secrets, head, seq })
    }

    /// The explicit desktop action after a tamper alarm: keep the old file aside and start a new chain. Never automatic.
    pub fn reset_after_tamper(state_dir: &Path, secrets: &Arc<dyn SecretStore>, now_ms: u64) -> Result<()> {
        let path = Self::path_in(state_dir);
        if path.exists() {
            fs::rename(&path, state_dir.join(format!("remote-audit.jsonl.tampered-{now_ms}")))?;
        }
        secrets.remove(KEY_AUDIT_HEAD)?;
        Ok(())
    }

    pub fn append(&mut self, rec: Record<'_>, now_ms: u64) -> Result<AuditEntry> {
        let cap = |s: &str| display(s, 200);
        let mut e = AuditEntry {
            seq: self.seq + 1,
            ts: now_ms,
            event: rec.event.to_string(),
            device_id: rec.device_id.map(cap),
            req_id: rec.req_id.map(cap),
            agent_id: rec.agent_id.map(cap),
            risk: rec.risk.map(cap),
            intent_hash: rec.intent_hash.map(cap),
            detail: rec.detail.map(cap),
            prev: self.head.clone(),
            hash: String::new(),
        };
        e.hash = entry_hash(&e);
        let mut line = serde_json::to_vec(&e).expect("entry serializes");
        line.push(b'\n');
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        OpenOptions::new().create(true).append(true).mode(0o600).open(&self.path)?.write_all(&line)?;
        self.secrets.set(KEY_AUDIT_HEAD, Secret::new(e.hash.clone()))?;
        self.head = e.hash.clone();
        self.seq = e.seq;
        Ok(e)
    }

    /// The last `n` entries, newest last (for Settings > Remote).
    pub fn tail(&self, n: usize) -> Vec<AuditEntry> {
        let text = fs::read_to_string(&self.path).unwrap_or_default();
        let all: Vec<AuditEntry> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        all.into_iter().rev().take(n).rev().collect()
    }

    pub fn len(&self) -> u64 {
        self.seq
    }

    pub fn is_empty(&self) -> bool {
        self.seq == 0
    }
}
