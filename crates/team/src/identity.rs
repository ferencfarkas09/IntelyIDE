//! A member's long-lived identity, mirrored on `intely_remote::identity`: everything secret lives in the secret store only.
//! Ed25519 signs envelopes and rosters; the X25519 key is the Noise static key (invite handshake, key hand-over); the token
//! is the member's relay credential (the relay stores only its hash).

use std::sync::Arc;

use intely_remote::noise::StaticKey;
use intely_remote::util::{b64u, random};
use intely_settings::{Secret, SecretStore};
use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};

use crate::error::{Result, TeamError};

pub const KEY_ID: &str = "team.member.id";
pub const KEY_SIGN: &str = "team.member.sign";
pub const KEY_NOISE: &str = "team.member.noise";
pub const KEY_TOKEN: &str = "team.member.token";
pub const KEY_KEYS: &str = "team.keys";
pub const KEY_AUDIT_HEAD: &str = "team.audit.head";

#[derive(Clone)]
pub struct Identity {
    /// Relay-valid id (`[A-Za-z0-9_-]{1,64}`), random, public.
    pub member_id: String,
    /// 256 random bits, base64url; the relay stores only its hash.
    pub token: String,
    pub noise: StaticKey,
    seed: [u8; 32],
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity").field("member_id", &self.member_id).field("sign_public", &hex::encode(self.sign_public())).finish_non_exhaustive()
    }
}

fn get(s: &dyn SecretStore, key: &str) -> Result<Option<String>> {
    Ok(s.get(key)?.map(|v| v.expose().to_string()))
}

fn put(s: &dyn SecretStore, key: &str, value: &str) -> Result<()> {
    s.set(key, Secret::new(value)).map_err(TeamError::from)
}

/// Verifies an Ed25519 signature; `false` for anything malformed.
pub fn verify(public: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    UnparsedPublicKey::new(&ED25519, public).verify(msg, sig).is_ok()
}

impl Identity {
    pub fn fresh() -> Self {
        Self { member_id: b64u(&random::<9>()), token: b64u(&random::<32>()), noise: StaticKey::generate(), seed: random::<32>() }
    }

    pub fn load_or_create(secrets: &Arc<dyn SecretStore>) -> Result<Self> {
        let s = secrets.as_ref();
        let seed = get(s, KEY_SIGN)?.and_then(|v| hex::decode(v).ok()).and_then(|v| <[u8; 32]>::try_from(v).ok());
        let noise = get(s, KEY_NOISE)?.and_then(|v| StaticKey::from_secret(&v));
        match (get(s, KEY_ID)?, get(s, KEY_TOKEN)?, seed, noise) {
            (Some(member_id), Some(token), Some(seed), Some(noise)) => Ok(Self { member_id, token, noise, seed }),
            _ => {
                let id = Self::fresh();
                id.store(s)?;
                Ok(id)
            }
        }
    }

    fn store(&self, s: &dyn SecretStore) -> Result<()> {
        put(s, KEY_ID, &self.member_id)?;
        put(s, KEY_TOKEN, &self.token)?;
        put(s, KEY_SIGN, &hex::encode(self.seed))?;
        put(s, KEY_NOISE, &self.noise.to_secret())
    }

    /// Leaving a team or wiping the install: a new identity, so an old token or key can never come back.
    pub fn rotate(secrets: &Arc<dyn SecretStore>) -> Result<Self> {
        let id = Self::fresh();
        id.store(secrets.as_ref())?;
        Ok(id)
    }

    fn keypair(&self) -> Ed25519KeyPair {
        Ed25519KeyPair::from_seed_unchecked(&self.seed).expect("a 32-byte seed is always a valid Ed25519 seed")
    }

    pub fn sign_public(&self) -> [u8; 32] {
        self.keypair().public_key().as_ref().try_into().expect("Ed25519 public keys are 32 bytes")
    }

    pub fn sign(&self, msg: &[u8]) -> Vec<u8> {
        self.keypair().sign(msg).as_ref().to_vec()
    }
}
