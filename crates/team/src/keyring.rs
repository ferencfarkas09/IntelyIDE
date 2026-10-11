//! Team keys by epoch. A revoke starts a new epoch with a fresh random key that only the remaining members receive; older
//! epochs stay so history can still be read (a revoked member keeps what they already had, that cannot be undone).

use std::collections::BTreeMap;

use intely_remote::util::random;
use serde::{Deserialize, Serialize};

use crate::error::{Result, TeamError};

#[derive(Clone, PartialEq, Eq)]
pub struct Keyring {
    current: u32,
    keys: BTreeMap<u32, [u8; 32]>,
}

impl std::fmt::Debug for Keyring {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Keyring(current={}, epochs={:?})", self.current, self.keys.keys().collect::<Vec<_>>())
    }
}

#[derive(Serialize, Deserialize)]
struct Stored {
    current: u32,
    keys: BTreeMap<u32, String>,
}

impl Keyring {
    pub fn genesis() -> Self {
        Self { current: 1, keys: BTreeMap::from([(1, random::<32>())]) }
    }

    pub fn current(&self) -> u32 {
        self.current
    }

    pub fn key(&self, epoch: u32) -> Option<&[u8; 32]> {
        self.keys.get(&epoch)
    }

    pub fn has_current(&self) -> bool {
        self.keys.contains_key(&self.current)
    }

    /// A new epoch with a fresh random key; returns `(epoch, key)`.
    pub fn rotate(&mut self) -> (u32, [u8; 32]) {
        let epoch = self.current + 1;
        let key = random::<32>();
        self.keys.insert(epoch, key);
        self.current = epoch;
        (epoch, key)
    }

    /// Adds a key received from an admin. A different key for an epoch we already hold is refused.
    pub fn insert(&mut self, epoch: u32, key: [u8; 32]) -> Result<()> {
        match self.keys.get(&epoch) {
            Some(k) if *k != key => return Err(TeamError::Invalid(format!("conflicting key for epoch {epoch}"))),
            Some(_) => {}
            None => {
                self.keys.insert(epoch, key);
            }
        }
        self.current = self.current.max(epoch);
        Ok(())
    }

    /// Every key, for the welcome of a new member.
    pub fn all(&self) -> Vec<(u32, [u8; 32])> {
        self.keys.iter().map(|(e, k)| (*e, *k)).collect()
    }

    pub fn from_parts(current: u32, keys: impl IntoIterator<Item = (u32, [u8; 32])>) -> Result<Self> {
        let keys: BTreeMap<u32, [u8; 32]> = keys.into_iter().collect();
        if keys.is_empty() || !keys.contains_key(&current) {
            return Err(TeamError::Invalid("the keyring has no key for its current epoch".into()));
        }
        Ok(Self { current, keys })
    }

    pub fn to_secret(&self) -> String {
        serde_json::to_string(&Stored { current: self.current, keys: self.keys.iter().map(|(e, k)| (*e, hex::encode(k))).collect() }).expect("keyring serializes")
    }

    pub fn from_secret(s: &str) -> Option<Self> {
        let st: Stored = serde_json::from_str(s).ok()?;
        let keys = st.keys.into_iter().map(|(e, k)| Some((e, hex::decode(k).ok()?.try_into().ok()?))).collect::<Option<Vec<_>>>()?;
        Self::from_parts(st.current, keys).ok()
    }

    /// Everything but the epoch of `keep` is forgotten (leaving a team).
    pub fn wipe(&mut self) {
        self.keys.clear();
    }
}
