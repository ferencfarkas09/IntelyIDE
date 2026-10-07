//! The Mac's long-lived identity: the Noise static key, the relay room id and the relay's Mac token. All three live in the
//! secret store (Keychain) only; "revoke all" rotates every one of them, so a leaked QR or an old device can never reconnect.

use std::sync::Arc;

use intely_settings::{Secret, SecretStore};

use crate::error::{RemoteError, Result};
use crate::noise::StaticKey;
use crate::util::{b64u, random};

pub const KEY_STATIC: &str = "remote.mac.key";
pub const KEY_ROOM: &str = "remote.room.id";
pub const KEY_MAC_TOKEN: &str = "remote.mac.token";
pub const KEY_REGISTRY_MAC: &str = "remote.registry.key";
pub const KEY_AUDIT_HEAD: &str = "remote.audit.head";

#[derive(Clone)]
pub struct Identity {
    pub static_key: StaticKey,
    /// 128 random bits, base64url (22 characters).
    pub room_id: String,
    /// 256 random bits, base64url (43 characters); the relay stores only its hash.
    pub mac_token: String,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity").field("public", &hex::encode(self.static_key.public)).field("room_id", &self.room_id).finish_non_exhaustive()
    }
}

fn get(secrets: &dyn SecretStore, key: &str) -> Result<Option<String>> {
    Ok(secrets.get(key)?.map(|s| s.expose().to_string()))
}

fn put(secrets: &dyn SecretStore, key: &str, value: &str) -> Result<()> {
    secrets.set(key, Secret::new(value)).map_err(RemoteError::from)
}

impl Identity {
    pub fn fresh() -> Self {
        Self { static_key: StaticKey::generate(), room_id: b64u(&random::<16>()), mac_token: b64u(&random::<32>()) }
    }

    pub fn load_or_create(secrets: &Arc<dyn SecretStore>) -> Result<Self> {
        let s = secrets.as_ref();
        let key = get(s, KEY_STATIC)?.and_then(|v| StaticKey::from_secret(&v));
        let room = get(s, KEY_ROOM)?;
        let token = get(s, KEY_MAC_TOKEN)?;
        match (key, room, token) {
            (Some(static_key), Some(room_id), Some(mac_token)) => Ok(Self { static_key, room_id, mac_token }),
            _ => {
                let id = Self::fresh();
                id.store(s)?;
                Ok(id)
            }
        }
    }

    fn store(&self, s: &dyn SecretStore) -> Result<()> {
        put(s, KEY_STATIC, &self.static_key.to_secret())?;
        put(s, KEY_ROOM, &self.room_id)?;
        put(s, KEY_MAC_TOKEN, &self.mac_token)
    }

    /// Revoke-all: new key, new room, new token.
    pub fn rotate(secrets: &Arc<dyn SecretStore>) -> Result<Self> {
        let id = Self::fresh();
        id.store(secrets.as_ref())?;
        Ok(id)
    }
}
