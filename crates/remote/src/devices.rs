//! The device registry (remote-plan 2.5): `devices.json` in the state directory, 0600, atomically written and MAC-protected.
//! The HMAC key lives in the secret store, the app re-reads the file only to verify it (never to adopt changes), and a file
//! that does not verify means Remote stops and every device counts as revoked. The state directory is a hard stop for agent
//! writes (agent_core policy), this is the second line.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use intely_settings::{Secret, SecretStore};
use serde::{Deserialize, Deserializer, Serialize};

use crate::error::{RemoteError, Result};
use crate::identity::KEY_REGISTRY_MAC;
use crate::util::{b64u, ct_eq, hmac_sha256, random};
use crate::wire::Capability;

pub const MAX_DEVICES: usize = 5;
pub const UNUSED_EXPIRY_DAYS: u64 = 30;
pub const DEFAULT_REAUTH_HOURS: u64 = 12;

fn cap_lenient<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Capability, D::Error> {
    // an old or edited file with an admin-like level loads as the weakest one
    Ok(match String::deserialize(d)?.as_str() {
        "reply" => Capability::Reply,
        _ => Capability::View,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Passkey {
    pub credential_id: String,
    /// SEC1 uncompressed P-256 point, hex.
    pub public_key: String,
    pub counter: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    /// The phone's Noise static public key, hex.
    pub static_pub: String,
    #[serde(default)]
    pub passkey: Option<Passkey>,
    #[serde(deserialize_with = "cap_lenient")]
    pub capability: Capability,
    pub created_at: u64,
    pub last_seen_at: u64,
    /// Last passkey assertion (or the pairing itself); `reply` is only effective inside the re-auth window.
    pub last_reauth_at: u64,
    /// SHA-256 hex of the relay device token (the relay stores the same hash).
    pub token_hash: String,
    #[serde(default)]
    pub push_endpoint_hash: Option<String>,
    /// The Mac has sent this phone its build-signing key (`welcome`); the phone shows pinned / unpinned / pin lost itself.
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Serialize, Deserialize)]
struct FileFormat {
    v: u32,
    mac: String,
    devices: Vec<Device>,
}

pub struct DeviceRegistry {
    path: PathBuf,
    secrets: Arc<dyn SecretStore>,
    key: Vec<u8>,
    devices: Vec<Device>,
    /// MAC of what this process last wrote (or verified at open): the only value the file may carry.
    known_mac: String,
    dirty: bool,
}

impl DeviceRegistry {
    pub fn path_in(state_dir: &Path) -> PathBuf {
        state_dir.join("devices.json")
    }

    pub fn open(state_dir: &Path, secrets: Arc<dyn SecretStore>) -> Result<Self> {
        let path = Self::path_in(state_dir);
        let key = match secrets.get(KEY_REGISTRY_MAC)? {
            Some(k) => hex::decode(k.expose()).map_err(|_| RemoteError::Tampered("registry key is not valid".into()))?,
            None => {
                if path.exists() {
                    return Err(RemoteError::Tampered("devices.json exists but its MAC key is missing".into()));
                }
                let k = random::<32>().to_vec();
                secrets.set(KEY_REGISTRY_MAC, Secret::new(hex::encode(&k)))?;
                k
            }
        };
        let mut reg = Self { path, secrets, key, devices: Vec::new(), known_mac: String::new(), dirty: false };
        match fs::read(&reg.path) {
            Ok(bytes) => {
                let f: FileFormat = serde_json::from_slice(&bytes).map_err(|e| RemoteError::Tampered(format!("devices.json does not parse: {e}")))?;
                if f.v != 1 || !reg.mac_ok(&f.devices, &f.mac) {
                    return Err(RemoteError::Tampered("devices.json does not match its MAC".into()));
                }
                reg.known_mac = f.mac;
                reg.devices = f.devices;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                reg.known_mac = reg.mac_of(&reg.devices);
            }
            Err(e) => return Err(e.into()),
        }
        Ok(reg)
    }

    fn mac_of(&self, devices: &[Device]) -> String {
        hex::encode(hmac_sha256(&self.key, &serde_json::to_vec(devices).expect("devices serialize")))
    }

    fn mac_ok(&self, devices: &[Device], mac: &str) -> bool {
        hex::decode(mac).is_ok_and(|m| ct_eq(&m, &hmac_sha256(&self.key, &serde_json::to_vec(devices).expect("devices serialize"))))
    }

    /// Re-reads the file and checks it still carries exactly the MAC of our last write. Never adopts its content.
    pub fn verify_on_disk(&self) -> Result<()> {
        match fs::read(&self.path) {
            Ok(bytes) => {
                let f: FileFormat = serde_json::from_slice(&bytes).map_err(|e| RemoteError::Tampered(format!("devices.json does not parse: {e}")))?;
                if f.mac != self.known_mac || !self.mac_ok(&f.devices, &f.mac) {
                    return Err(RemoteError::Tampered("devices.json changed outside the app".into()));
                }
                Ok(())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && self.devices.is_empty() && !self.dirty => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(RemoteError::Tampered("devices.json was deleted".into())),
            Err(e) => Err(e.into()),
        }
    }

    fn persist(&mut self) -> Result<()> {
        let mac = self.mac_of(&self.devices);
        let body = serde_json::to_vec_pretty(&FileFormat { v: 1, mac: mac.clone(), devices: self.devices.clone() }).expect("serializes");
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
            // the state dir is owner-only; a freshly created one must not be world-readable
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
        let tmp = self.path.with_extension("json.tmp");
        {
            let mut f = fs::OpenOptions::new().create(true).truncate(true).write(true).mode(0o600).open(&tmp)?;
            f.write_all(&body)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &self.path)?;
        self.known_mac = mac;
        self.dirty = false;
        Ok(())
    }

    pub fn list(&self) -> &[Device] {
        &self.devices
    }

    pub fn get(&self, id: &str) -> Option<&Device> {
        self.devices.iter().find(|d| d.id == id)
    }

    pub fn find_by_static(&self, public: &[u8; 32]) -> Option<&Device> {
        let h = hex::encode(public);
        self.devices.iter().find(|d| d.static_pub == h)
    }

    /// 16 base64url characters; never starts with `pair-` (that prefix names the relay's temporary pairing sockets).
    pub fn new_device_id() -> String {
        loop {
            let id = b64u(&random::<12>());
            if !id.starts_with("pair-") {
                return id;
            }
        }
    }

    pub fn new_device_token() -> String {
        b64u(&random::<32>())
    }

    pub fn add(&mut self, device: Device) -> Result<()> {
        if self.devices.len() >= MAX_DEVICES {
            return Err(RemoteError::Invalid(format!("at most {MAX_DEVICES} devices can be paired")));
        }
        if self.devices.iter().any(|d| d.id == device.id || d.static_pub == device.static_pub) {
            return Err(RemoteError::Invalid("device already paired".into()));
        }
        self.devices.push(device);
        self.persist()
    }

    pub fn revoke(&mut self, id: &str) -> Result<bool> {
        let before = self.devices.len();
        self.devices.retain(|d| d.id != id);
        let removed = self.devices.len() != before;
        if removed {
            self.persist()?;
        }
        Ok(removed)
    }

    /// Removes every device; returns their ids. The caller rotates the identity (key, room, token).
    pub fn revoke_all(&mut self) -> Result<Vec<String>> {
        let ids = self.devices.drain(..).map(|d| d.id).collect();
        self.persist()?;
        Ok(ids)
    }

    pub fn set_capability(&mut self, id: &str, cap: Capability) -> Result<()> {
        let d = self.devices.iter_mut().find(|d| d.id == id).ok_or(RemoteError::UnknownDevice)?;
        d.capability = cap;
        self.persist()
    }

    pub fn set_passkey(&mut self, id: &str, passkey: Passkey) -> Result<()> {
        let d = self.devices.iter_mut().find(|d| d.id == id).ok_or(RemoteError::UnknownDevice)?;
        d.passkey = Some(passkey);
        self.persist()
    }

    /// A successful assertion: store the new counter and restart the re-auth window.
    pub fn passkey_used(&mut self, id: &str, counter: u32, now: u64) -> Result<()> {
        let d = self.devices.iter_mut().find(|d| d.id == id).ok_or(RemoteError::UnknownDevice)?;
        if let Some(p) = d.passkey.as_mut() {
            p.counter = counter;
        }
        d.last_reauth_at = now;
        self.persist()
    }

    /// Cheap bookkeeping: the file is rewritten by [`Self::flush`] at most once in a while.
    pub fn touch(&mut self, id: &str, now: u64) {
        if let Some(d) = self.devices.iter_mut().find(|d| d.id == id) {
            if now.saturating_sub(d.last_seen_at) > 60_000 || d.last_seen_at == 0 {
                d.last_seen_at = now;
                self.dirty = true;
            }
        }
    }

    /// The Mac delivered its build-signing key to this device (flushed with the next `flush`).
    pub fn mark_pinned(&mut self, id: &str) {
        if let Some(d) = self.devices.iter_mut().find(|d| d.id == id && !d.pinned) {
            d.pinned = true;
            self.dirty = true;
        }
    }

    pub fn flush(&mut self) -> Result<()> {
        if self.dirty {
            self.persist()?;
        }
        Ok(())
    }

    /// Devices unused for 30 days expire.
    pub fn expire_unused(&mut self, now: u64) -> Result<Vec<String>> {
        let limit = UNUSED_EXPIRY_DAYS * 24 * 3600 * 1000;
        let gone: Vec<String> = self.devices.iter().filter(|d| now.saturating_sub(d.last_seen_at.max(d.created_at)) > limit).map(|d| d.id.clone()).collect();
        if !gone.is_empty() {
            self.devices.retain(|d| !gone.contains(&d.id));
            self.persist()?;
        }
        Ok(gone)
    }

    pub fn secrets(&self) -> &Arc<dyn SecretStore> {
        &self.secrets
    }
}
