//! One-time migration of the legacy `workspace.json` into the registry ((design notes: workspaces-spec) 4.6).
//!
//! Under the registry lock: copy the legacy bytes to `backups/workspace.pre-registry.<ms>.json`, write them verbatim
//! as `workspaces/w-migrated.json`, then write the registry last. A crash before the last step is re-run from the
//! start (the id is fixed, the writes are idempotent); the legacy file is never touched or deleted.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::model::{self, MigratedInfo, RegistryFile, StoredEntry, MIGRATED_ID, MIGRATED_NAME, PALETTE};
use super::{fsutil, Registry};
use crate::{Workspace, WorkspaceEntry, WorkspaceOrigin};

const LEGACY_CAP: u64 = 1024 * 1024;

impl Registry {
    /// `Err(reason)` is the `legacyUnreadable` message; in that case nothing at all was written.
    pub(super) fn migrate_legacy(&self) -> Result<(), String> {
        let legacy = self.loc.legacy_file();
        let bytes = fsutil::read_capped(&legacy, LEGACY_CAP).map_err(|e| format!("{}: {e}", legacy.display()))?;
        let ws: Workspace = serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", legacy.display()))?;
        if ws.version != 1 {
            return Err(format!("{}: unsupported workspace version {}", legacy.display(), ws.version));
        }
        crate::workspace::validate_structure(&ws).map_err(|e| format!("{}: {}", legacy.display(), e.message))?;
        let sha = hex::encode(Sha256::digest(&bytes));
        let created_at = std::fs::metadata(&legacy)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or_else(|| self.now_ms(), |d| d.as_millis() as i64);

        let _lock = fsutil::lock_with_timeout(&self.loc.mutation_lock(), self.env.lock_wait)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "the workspace list is busy".to_owned())?;
        if self.loc.registry.exists() {
            return Ok(()); // somebody else finished first
        }
        let io = |e: crate::EngineError| format!("{}: {}", e.message, e.detail.unwrap_or_default());

        // 2. the one-time copy of the legacy bytes (skipped when a copy with the same hash exists)
        let backups = self.loc.backups_dir();
        if !has_backup_with_hash(&backups, &sha) {
            let dest = backups.join(format!("workspace.pre-registry.{}.json", self.now_ms()));
            fsutil::write_atomic(&dest, &bytes, 0o600, self.fault()).map_err(|e| e.to_string())?;
        }
        self.hit("migrate:backup").map_err(io)?;
        // 3. the workspace file, byte for byte
        let target = self.workspace_path(MIGRATED_ID).map_err(io)?;
        fsutil::write_atomic(&target, &bytes, 0o600, self.fault()).map_err(|e| e.to_string())?;
        self.hit("migrate:workspace-file").map_err(io)?;
        // 4. the registry, last
        let now = self.now_ms();
        let file = RegistryFile {
            version: 1,
            rev: 1,
            active_id: Some(MIGRATED_ID.to_owned()),
            workspaces: vec![StoredEntry {
                entry: WorkspaceEntry {
                    id: MIGRATED_ID.to_owned(),
                    name: MIGRATED_NAME.to_owned(),
                    color: PALETTE[0].to_owned(),
                    order: 0,
                    created_at,
                    last_opened_at: Some(now),
                    origin: WorkspaceOrigin::Migrated,
                },
                extra: BTreeMap::new(),
            }],
            migrated: Some(MigratedInfo { from: legacy.to_string_lossy().into_owned(), sha256: sha, at: now }),
            extra: BTreeMap::new(),
        };
        fsutil::write_atomic(&self.loc.registry, &model::to_json(&file), 0o600, self.fault()).map_err(|e| e.to_string())?;
        self.hit("migrate:registry").map_err(io)?;
        // 6. night-queue entries without a workspace id belong to the migrated workspace
        if let Some(q) = &self.env.night_queue {
            let _ = stamp_night_queue(q, MIGRATED_ID, self.fault());
        }
        Ok(())
    }
}

fn has_backup_with_hash(dir: &Path, sha: &str) -> bool {
    let Ok(rd) = std::fs::read_dir(dir) else { return false };
    rd.flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("workspace.pre-registry."))
        .any(|e| fsutil::read_capped(&e.path(), LEGACY_CAP).is_ok_and(|b| hex::encode(Sha256::digest(&b)) == sha))
}

/// Adds `workspaceId` to every item of the night queue that lacks one. Unknown fields are preserved; a file that is
/// absent or not understood is left alone. Returns how many items were stamped.
pub fn stamp_night_queue(path: &Path, workspace_id: &str, fault: Option<&fsutil::Fault>) -> std::io::Result<usize> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let Ok(mut doc) = serde_json::from_slice::<Value>(&bytes) else { return Ok(0) };
    let mut stamped = 0;
    if let Some(items) = doc.get_mut("items").and_then(Value::as_array_mut) {
        for item in items {
            if let Some(o) = item.as_object_mut() {
                if !o.contains_key("workspaceId") {
                    o.insert("workspaceId".into(), Value::String(workspace_id.to_owned()));
                    stamped += 1;
                }
            }
        }
    }
    if stamped > 0 {
        let mut out = serde_json::to_vec_pretty(&doc).map_err(std::io::Error::other)?;
        out.push(b'\n');
        fsutil::write_atomic(path, &out, 0o600, fault)?;
    }
    Ok(stamped)
}
