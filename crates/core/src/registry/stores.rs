//! The two small side stores next to the registry ((design notes: workspaces-spec) 4.2): `trust.json` (accepted config-risk
//! hashes per canonical repo path) and `live-floor.json` (live/protected patterns folded in from removed workspaces).
//! Pure data here; reading and writing under the registry lock is done by `Registry`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::types::code;
use crate::EngineError;

/// Stable hash of a set of config-risk key names (order and case do not matter).
pub fn risk_hash(keys: &[String]) -> String {
    let mut k: Vec<String> = keys.iter().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
    k.sort();
    k.dedup();
    hex::encode(Sha256::digest(k.join("\n").as_bytes()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustState {
    /// Never acknowledged.
    Unknown,
    /// Acknowledged and the risk set is the same.
    Trusted,
    /// Acknowledged once, but the risk set differs now.
    Changed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrustEntry {
    pub hash: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrustFile {
    pub version: u32,
    #[serde(default)]
    pub repos: BTreeMap<String, TrustEntry>,
}

impl Default for TrustFile {
    fn default() -> Self {
        Self { version: 1, repos: BTreeMap::new() }
    }
}

impl TrustFile {
    pub fn state(&self, canonical_path: &str, hash: &str) -> TrustState {
        match self.repos.get(canonical_path) {
            None => TrustState::Unknown,
            Some(e) if e.hash == hash => TrustState::Trusted,
            Some(_) => TrustState::Changed,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FloorEntry {
    pub path: String,
    #[serde(default)]
    pub identity: String,
    #[serde(default)]
    pub protected: Vec<String>,
    #[serde(default)]
    pub live: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FloorFile {
    pub version: u32,
    #[serde(default)]
    pub entries: Vec<FloorEntry>,
}

impl Default for FloorFile {
    fn default() -> Self {
        Self { version: 1, entries: Vec::new() }
    }
}

fn union(into: &mut Vec<String>, add: &[String]) {
    for a in add {
        if !into.contains(a) {
            into.push(a.clone());
        }
    }
}

impl FloorFile {
    /// Folds patterns for one repository (matched by canonical path or identity) into the floor.
    pub fn fold(&mut self, path: &str, identity: &str, protected: &[String], live: &[String]) {
        if protected.is_empty() && live.is_empty() {
            return;
        }
        let at = self.entries.iter().position(|e| e.path == path || (!identity.is_empty() && e.identity == identity));
        let e = match at {
            Some(i) => &mut self.entries[i],
            None => {
                self.entries.push(FloorEntry { path: path.to_owned(), identity: identity.to_owned(), ..Default::default() });
                self.entries.last_mut().expect("just pushed")
            }
        };
        if e.identity.is_empty() {
            e.identity = identity.to_owned();
        }
        union(&mut e.protected, protected);
        union(&mut e.live, live);
    }

    /// Entries that apply to a repository known by any of `keys` (`p:<folded path>` / `i:<dev:ino>`).
    pub fn matching<'a>(&'a self, keys: &'a [String]) -> impl Iterator<Item = &'a FloorEntry> + 'a {
        self.entries.iter().filter(move |e| {
            keys.iter().any(|k| *k == format!("p:{}", super::fs::path_key(&e.path)) || (!e.identity.is_empty() && *k == format!("i:{}", e.identity)))
        })
    }
}

pub fn parse<T: for<'de> Deserialize<'de>>(bytes: &[u8], what: &str) -> Result<T, EngineError> {
    serde_json::from_slice(bytes).map_err(|e| EngineError::new(code::REGISTRY_CORRUPT, format!("{what} is not valid")).with_detail(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn risk_hash_ignores_order_case_and_duplicates() {
        let a = risk_hash(&["core.fsmonitor".into(), "Filter.x.clean".into()]);
        let b = risk_hash(&["filter.x.clean".into(), "core.fsmonitor".into(), "core.fsmonitor".into()]);
        assert_eq!(a, b);
        assert_ne!(a, risk_hash(&["core.fsmonitor".into()]));
        assert_eq!(risk_hash(&[]), risk_hash(&["  ".into()]));
    }

    #[test]
    fn trust_states() {
        let mut t = TrustFile::default();
        assert_eq!(t.state("/r", "h1"), TrustState::Unknown);
        t.repos.insert("/r".into(), TrustEntry { hash: "h1".into(), at: 1 });
        assert_eq!(t.state("/r", "h1"), TrustState::Trusted);
        assert_eq!(t.state("/r", "h2"), TrustState::Changed);
    }

    #[test]
    fn floor_folds_by_path_or_identity_and_unions() {
        let mut f = FloorFile::default();
        f.fold("/r", "1:2", &["dev".into()], &["main".into()]);
        f.fold("/other-spelling", "1:2", &["dev".into(), "x".into()], &["rel/*".into()]);
        assert_eq!(f.entries.len(), 1);
        assert_eq!(f.entries[0].protected, vec!["dev", "x"]);
        assert_eq!(f.entries[0].live, vec!["main", "rel/*"]);
        f.fold("/empty", "9:9", &[], &[]);
        assert_eq!(f.entries.len(), 1, "nothing to fold, nothing stored");
        let keys = vec!["i:1:2".to_owned()];
        assert_eq!(f.matching(&keys).count(), 1);
        assert_eq!(f.matching(&["i:7:7".to_owned()]).count(), 0);
    }
}
