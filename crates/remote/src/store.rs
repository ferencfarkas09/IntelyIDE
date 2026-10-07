//! The persistent Remote state behind one handle: device registry, audit log and identity. Opened once (on enable, or
//! on demand for Settings) and shared by the gateway and the slot, so a revoke from the Settings UI is effective in the same
//! instant for the running gateway, which checks the registry on every inbound frame.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use intely_settings::SecretStore;

use crate::audit::{AuditEntry, AuditLog, Record};
use crate::devices::{Device, DeviceRegistry};
use crate::error::Result;
use crate::identity::Identity;
use crate::util::Clock;
use crate::wire::Capability;

pub struct Store {
    pub state_dir: PathBuf,
    pub secrets: Arc<dyn SecretStore>,
    pub clock: Arc<dyn Clock>,
    registry: Mutex<DeviceRegistry>,
    audit: Mutex<AuditLog>,
    identity: Mutex<Identity>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Store {
    /// Fails with `Tampered` when `devices.json` or the audit chain do not verify; nothing is repaired.
    pub fn open(state_dir: &Path, secrets: Arc<dyn SecretStore>, clock: Arc<dyn Clock>) -> Result<Arc<Self>> {
        let registry = DeviceRegistry::open(state_dir, secrets.clone())?;
        let audit = AuditLog::open(state_dir, secrets.clone())?;
        let identity = Identity::load_or_create(&secrets)?;
        Ok(Arc::new(Self { state_dir: state_dir.to_path_buf(), secrets, clock, registry: Mutex::new(registry), audit: Mutex::new(audit), identity: Mutex::new(identity) }))
    }

    pub fn identity(&self) -> Identity {
        lock(&self.identity).clone()
    }

    pub fn devices(&self) -> Vec<Device> {
        lock(&self.registry).list().to_vec()
    }

    pub fn device(&self, id: &str) -> Option<Device> {
        lock(&self.registry).get(id).cloned()
    }

    pub fn device_by_static(&self, public: &[u8; 32]) -> Option<Device> {
        lock(&self.registry).find_by_static(public).cloned()
    }

    pub fn with_registry<R>(&self, f: impl FnOnce(&mut DeviceRegistry) -> R) -> R {
        f(&mut lock(&self.registry))
    }

    pub fn audit(&self, rec: Record<'_>) {
        let now = self.clock.now_ms();
        // the audit log failing to write must not take the gateway down, but it is never silent: the entry count stops growing
        // and the next open compares the chain with the head hash
        let _ = lock(&self.audit).append(rec, now);
    }

    pub fn audit_tail(&self, n: usize) -> Vec<AuditEntry> {
        lock(&self.audit).tail(n)
    }

    pub fn audit_len(&self) -> u64 {
        lock(&self.audit).len()
    }

    pub fn verify_registry(&self) -> Result<()> {
        lock(&self.registry).verify_on_disk()
    }

    /// Removes one device. Effective locally at once; the gateway (if running) drops its session on the next frame or event.
    pub fn revoke(&self, id: &str, why: &str) -> Result<bool> {
        let removed = lock(&self.registry).revoke(id)?;
        if removed {
            self.audit(Record::new("device.revoked").device(id).detail(why));
        }
        Ok(removed)
    }

    /// Revoke all: every device goes, and the Mac key, the room id and the relay token are rotated.
    pub fn revoke_all(&self, why: &str) -> Result<Vec<String>> {
        let ids = lock(&self.registry).revoke_all()?;
        let fresh = Identity::rotate(&self.secrets)?;
        *lock(&self.identity) = fresh;
        self.audit(Record::new("device.revokedAll").detail(&format!("{why}; {} devices", ids.len())));
        Ok(ids)
    }

    pub fn set_capability(&self, id: &str, cap: Capability) -> Result<()> {
        lock(&self.registry).set_capability(id, cap)?;
        self.audit(Record::new("device.capability").device(id).detail(match cap {
            Capability::View => "view",
            Capability::Reply => "reply",
        }));
        Ok(())
    }
}
