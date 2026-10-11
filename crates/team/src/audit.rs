//! The team's own audit trail: the Remote hash chain (`intely_remote::audit::AuditLog`) with its own file and head key, so the two
//! chains never share a head. Records who joined, who was revoked, notes received and memory writes. Never keys or content.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use intely_remote::audit::{AuditEntry, AuditLog, Record};
use intely_settings::SecretStore;

use crate::error::Result;
use crate::identity::KEY_AUDIT_HEAD;

pub mod event {
    pub const TEAM_CREATED: &str = "team.created";
    pub const INVITE_OPENED: &str = "team.invite.opened";
    pub const INVITE_FAILED: &str = "team.invite.failed";
    pub const MEMBER_JOINED: &str = "team.member.joined";
    pub const MEMBER_REVOKED: &str = "team.member.revoked";
    pub const KEY_ROTATED: &str = "team.key.rotated";
    pub const LEFT: &str = "team.left";
    pub const REJECTED: &str = "team.rejected";
    pub const NOTE_RECEIVED: &str = "team.note.received";
    pub const NOTE_ACCEPTED: &str = "team.note.accepted";
    pub const NOTE_REJECTED: &str = "team.note.rejected";
    pub const WORKSPACE_SERVED: &str = "team.workspace.served";
    pub const MEMORY_WRITE: &str = "team.memory.write";
}

pub struct TeamAudit(AuditLog);

impl TeamAudit {
    pub fn path_in(state_dir: &Path) -> PathBuf {
        state_dir.join("team-audit.jsonl")
    }

    pub fn open(state_dir: &Path, secrets: Arc<dyn SecretStore>) -> Result<Self> {
        Ok(Self(AuditLog::open_at(Self::path_in(state_dir), KEY_AUDIT_HEAD, secrets)?))
    }

    /// `member` goes into the entry's device field, `detail` is a short code or count, never content.
    pub fn record(&mut self, event: &str, member: Option<&str>, detail: Option<&str>, now_ms: u64) -> Result<AuditEntry> {
        let mut r = Record::new(event);
        r.device_id = member;
        r.detail = detail;
        Ok(self.0.append(r, now_ms)?)
    }

    pub fn tail(&self, n: usize) -> Vec<AuditEntry> {
        self.0.tail(n)
    }

    pub fn len(&self) -> u64 {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}
