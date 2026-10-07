//! Embedded trust anchors with roles, and the revocation rules ((design notes: updater-spec) 4.7).
//!
//! The public keys are the contents of the `.pub` files of `tauri signer generate` (base64 of the
//! two-line minisign public key file). Private keys never touch the repository. The key id is the
//! 16-hex-digit id minisign prints (`minisign public key: 1679E4138E7635FE`), upper case.

use std::borrow::Cow;
use std::collections::BTreeSet;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;

use crate::ErrorCode;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Role {
    /// Signs the feed at every release; offline with the owner.
    Feed,
    /// The only role that may revoke keys; offline, never in CI.
    FeedStandby,
    /// Signs the update tarballs; may live in CI (the feed pins every artifact's size and SHA-256).
    Artifact,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustedKey {
    /// 16 hex digits, the minisign key id (upper case). `REPLACE_WITH_KEY_ID` in a placeholder.
    pub id: Cow<'static, str>,
    /// Contents of the tauri `.pub` file. `REPLACE_WITH_PUBLIC_KEY` in a placeholder.
    pub public_b64: Cow<'static, str>,
    pub role: Role,
}

pub const PLACEHOLDER_KEY: &str = "REPLACE_WITH_PUBLIC_KEY";
pub const PLACEHOLDER_ID: &str = "REPLACE_WITH_KEY_ID";

const fn placeholder(role: Role) -> TrustedKey {
    TrustedKey { id: Cow::Borrowed(PLACEHOLDER_ID), public_b64: Cow::Borrowed(PLACEHOLDER_KEY), role }
}

/// Filled by the owner at gate G-K1 (key ceremony, `(design notes: updater-keys)`). Until then the engine
/// answers `noTrustedKey` ("updates are not configured in this build"), which is not an error banner.
/// Required before the first release: one Feed, one FeedStandby and TWO Artifact keys (the CI key
/// and an offline spare), all distinct, none a test key (`check-updater-config.mjs`, gate G21).
pub const TRUSTED_KEYS: &[TrustedKey] = &[
    placeholder(Role::Feed),
    placeholder(Role::FeedStandby),
    placeholder(Role::Artifact),
    placeholder(Role::Artifact),
];

/// The `seq` of the newest feed published when this build was made (4.6 step 2b). A fresh install
/// never accepts a feed below it. Checked against the committed `site/data/update/*.json` by gate G21.
pub const INITIAL_FEED_FLOOR: u64 = 0;

/// Which kind of file a signature belongs to. A key of one role never verifies the other kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileKind {
    Feed,
    Artifact,
}

impl FileKind {
    pub fn accepts(self, role: Role) -> bool {
        match self {
            FileKind::Feed => matches!(role, Role::Feed | Role::FeedStandby),
            FileKind::Artifact => role == Role::Artifact,
        }
    }

    /// The error code for an unknown or wrong-role key.
    pub fn bad_key_code(self) -> ErrorCode {
        match self {
            FileKind::Feed => ErrorCode::FeedSignature,
            FileKind::Artifact => ErrorCode::Signature,
        }
    }
}

/// Key id bytes as stored in a key or signature (little endian) to the printed hex form.
pub fn key_id_hex(bytes: &[u8; 8]) -> String {
    bytes.iter().rev().map(|b| format!("{b:02X}")).collect()
}

/// `true` for exactly 16 hex digits (either case).
pub fn is_key_id(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Decode the contents of a tauri `.pub` file into the verifier key and its id.
pub fn decode_public(public_b64: &str) -> Result<(minisign_verify::PublicKey, String), ErrorCode> {
    let raw = B64.decode(public_b64.trim()).map_err(|_| ErrorCode::NoTrustedKey)?;
    let text = String::from_utf8(raw).map_err(|_| ErrorCode::NoTrustedKey)?;
    let pk = minisign_verify::PublicKey::decode(&text).map_err(|_| ErrorCode::NoTrustedKey)?;
    let line = text.lines().nth(1).ok_or(ErrorCode::NoTrustedKey)?;
    let bin = B64.decode(line.trim()).map_err(|_| ErrorCode::NoTrustedKey)?;
    if bin.len() != 42 {
        return Err(ErrorCode::NoTrustedKey);
    }
    let mut id = [0u8; 8];
    id.copy_from_slice(&bin[2..10]);
    Ok((pk, key_id_hex(&id)))
}

/// The key id of a minisign signature (the `.sig` text, already base64-decoded once).
pub fn signature_key_id(sig_text: &str) -> Result<String, ErrorCode> {
    let line = sig_text.lines().nth(1).ok_or(ErrorCode::Signature)?;
    let bin = B64.decode(line.trim()).map_err(|_| ErrorCode::Signature)?;
    if bin.len() != 74 {
        return Err(ErrorCode::Signature);
    }
    let mut id = [0u8; 8];
    id.copy_from_slice(&bin[2..10]);
    Ok(key_id_hex(&id))
}

/// Why a `revoke` entry did not take effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IgnoredRevoke {
    /// The signer is not a FeedStandby key (a Feed-signed `revoke` is ignored and logged).
    SignerNotStandby,
    /// The id is not in the embedded set.
    UnknownKey,
    /// Nothing revokes a FeedStandby key.
    TargetIsStandby,
    /// No key revokes itself.
    SelfRevoke,
    /// Not 16 hex digits.
    Malformed,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RevokeOutcome {
    pub applied: Vec<String>,
    pub ignored: Vec<(String, IgnoredRevoke)>,
}

/// The revoked key ids (`trust.json`, persisted by `state.rs`, U4). Pure data: no file access here.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Revocations {
    ids: BTreeSet<String>,
}

impl Revocations {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.ids.contains(&id.to_ascii_uppercase())
    }

    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.ids.iter().map(String::as_str)
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    /// `{"schema":1,"revoked":["ID", ...]}`
    pub fn to_json(&self) -> String {
        serde_json::json!({ "schema": 1, "revoked": self.ids.iter().collect::<Vec<_>>() }).to_string()
    }

    /// Strict: any defect (wrong schema, a non-hex id, more than 64 ids) is an error, so a tampered
    /// `trust.json` is noticed by the caller instead of being half-trusted.
    pub fn from_json(s: &str) -> Result<Self, ErrorCode> {
        if s.len() > 8192 {
            return Err(ErrorCode::FeedInvalid);
        }
        let v: serde_json::Value = serde_json::from_str(s).map_err(|_| ErrorCode::FeedInvalid)?;
        if v.get("schema").and_then(|x| x.as_u64()) != Some(1) {
            return Err(ErrorCode::FeedInvalid);
        }
        let arr = v.get("revoked").and_then(|x| x.as_array()).ok_or(ErrorCode::FeedInvalid)?;
        if arr.len() > 64 {
            return Err(ErrorCode::FeedInvalid);
        }
        let mut ids = BTreeSet::new();
        for e in arr {
            let id = e.as_str().filter(|s| is_key_id(s)).ok_or(ErrorCode::FeedInvalid)?;
            ids.insert(id.to_ascii_uppercase());
        }
        Ok(Revocations { ids })
    }
}

/// The set of trusted keys a client runs with: `TRUSTED_KEYS` in production, throwaway keys in tests.
#[derive(Clone, Debug)]
pub struct KeySet {
    keys: Vec<TrustedKey>,
}

impl KeySet {
    pub fn new(keys: Vec<TrustedKey>) -> Self {
        let keys = keys
            .into_iter()
            .map(|mut k| {
                if k.id != PLACEHOLDER_ID {
                    k.id = Cow::Owned(k.id.to_ascii_uppercase());
                }
                k
            })
            .collect();
        KeySet { keys }
    }

    pub fn production() -> Self {
        KeySet::new(TRUSTED_KEYS.to_vec())
    }

    pub fn keys(&self) -> &[TrustedKey] {
        &self.keys
    }

    pub fn find(&self, id: &str) -> Option<&TrustedKey> {
        let id = id.to_ascii_uppercase();
        self.keys.iter().find(|k| k.id == id)
    }

    fn is_placeholder(k: &TrustedKey) -> bool {
        k.public_b64 == PLACEHOLDER_KEY || k.id == PLACEHOLDER_ID
    }

    /// `Ok` when the set is usable: no placeholder, every key decodes and carries its own id, and
    /// there is a Feed key and an Artifact key. Otherwise `noTrustedKey` ("Updates are not
    /// configured in this build", spec 5.19).
    pub fn check_configured(&self) -> Result<(), ErrorCode> {
        let mut feed = false;
        let mut artifact = false;
        let mut seen = BTreeSet::new();
        for k in &self.keys {
            if Self::is_placeholder(k) {
                return Err(ErrorCode::NoTrustedKey);
            }
            let (_, id) = decode_public(&k.public_b64)?;
            if id != k.id || !seen.insert(id) {
                return Err(ErrorCode::NoTrustedKey);
            }
            match k.role {
                Role::Feed => feed = true,
                Role::Artifact => artifact = true,
                Role::FeedStandby => {}
            }
        }
        if feed && artifact {
            Ok(())
        } else {
            Err(ErrorCode::NoTrustedKey)
        }
    }

    /// The key that may verify a `kind` file signed with key `id`: it must be in the set, not
    /// revoked, and have a role that `kind` accepts.
    pub fn signer_for(&self, kind: FileKind, id: &str, revoked: &Revocations) -> Result<&TrustedKey, ErrorCode> {
        let key = self.find(id).filter(|k| !Self::is_placeholder(k)).ok_or(kind.bad_key_code())?;
        if revoked.contains(&key.id) {
            return Err(ErrorCode::KeyRevoked);
        }
        if !kind.accepts(key.role) {
            return Err(kind.bad_key_code());
        }
        Ok(key)
    }

    /// Apply the `revoke` list of a verified feed signed by `signer` (4.7): only a FeedStandby
    /// signer revokes, only Feed and Artifact keys, never itself. Revocations take effect from now
    /// on for everything signed by the revoked key, including a replayed old feed.
    pub fn apply_revoke(&self, signer: &TrustedKey, ids: &[String], into: &mut Revocations) -> RevokeOutcome {
        let mut out = RevokeOutcome::default();
        for raw in ids {
            if !is_key_id(raw) {
                out.ignored.push((raw.clone(), IgnoredRevoke::Malformed));
                continue;
            }
            let id = raw.to_ascii_uppercase();
            if signer.role != Role::FeedStandby {
                out.ignored.push((id, IgnoredRevoke::SignerNotStandby));
                continue;
            }
            if id == signer.id {
                out.ignored.push((id, IgnoredRevoke::SelfRevoke));
                continue;
            }
            match self.find(&id) {
                None => out.ignored.push((id, IgnoredRevoke::UnknownKey)),
                Some(t) if t.role == Role::FeedStandby => out.ignored.push((id, IgnoredRevoke::TargetIsStandby)),
                Some(_) => {
                    into.ids.insert(id.clone());
                    out.applied.push(id);
                }
            }
        }
        out
    }
}
