//! Signed bundle manifest, format v2 (spec 4.5). The reference implementation is `remote-relay/scripts/bundle-lib.mjs`; every
//! vector in `remote-relay/tests/fixtures/bundle-v2/vectors.json` must give the same verdict here (`tests/vectors.rs`).
//!
//! ```text
//! bundle.json    = { v: 2, files: [{path, sha256, size}], manifestSha256, seq, builtAt, sig, pubkey }
//! manifestSha256 = hex(sha256(JSON.stringify(files)))
//! signed message = utf8("intely-bundle-v2\n" + manifestSha256 + "\n" + seq)
//! ```
//! The manifest is parsed into an order-preserving [`Json`] value: the key order of a file entry is part of the format (it changes
//! `JSON.stringify` and so the hash), and `serde_json::Value` would sort the keys.

use std::collections::BTreeMap;
use std::fmt;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

pub const MANIFEST_NAME: &str = "bundle.json";
pub const DOMAIN_V2: &str = "intely-bundle-v2\n";
/// 2^53 - 1: the largest integer a JavaScript number (the phone) can hold exactly.
pub const MAX_SEQ: u64 = (1 << 53) - 1;
pub const MAX_MANIFEST_FILES: usize = 20_000;

/// One manifest entry. Field order is the wire order (`path`, `sha256`, `size`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// `sha256(JSON.stringify(files))` as lowercase hex.
pub fn manifest_hash(files: &[FileEntry]) -> String {
    sha256_hex(serde_json::to_string(files).unwrap_or_default().as_bytes())
}

/// The exact bytes that are signed.
pub fn signed_message(manifest_sha256: &str, seq: u64) -> Vec<u8> {
    format!("{DOMAIN_V2}{manifest_sha256}\n{seq}").into_bytes()
}

/// Manifest paths: no leading slash, no `.`/`..` segment, no `//`, only `[A-Za-z0-9._-]`, at most 512 characters.
pub fn valid_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 512
        && p.split('/').all(|s| !s.is_empty() && s != "." && s != ".." && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')))
}

/// Canonical base64url (no padding, re-encodes to the same text) of exactly `n` bytes.
pub fn b64u_bytes(s: &str, n: usize) -> Option<Vec<u8>> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return None;
    }
    let raw = URL_SAFE_NO_PAD.decode(s).ok()?;
    (raw.len() == n && URL_SAFE_NO_PAD.encode(&raw) == s).then_some(raw)
}

/// An order-preserving JSON value (objects keep their key order, duplicate keys are kept as they came).
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(serde_json::Number),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(kv) => kv.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        if let Json::Str(s) = self { Some(s) } else { None }
    }
    pub fn as_u64(&self) -> Option<u64> {
        if let Json::Num(n) = self { n.as_u64() } else { None }
    }
    pub fn as_array(&self) -> Option<&[Json]> {
        if let Json::Arr(a) = self { Some(a) } else { None }
    }
}

impl Serialize for Json {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Json::Null => s.serialize_unit(),
            Json::Bool(b) => s.serialize_bool(*b),
            Json::Num(n) => n.serialize(s),
            Json::Str(t) => s.serialize_str(t),
            Json::Arr(a) => {
                let mut seq = s.serialize_seq(Some(a.len()))?;
                for v in a {
                    seq.serialize_element(v)?;
                }
                seq.end()
            }
            Json::Obj(kv) => {
                let mut map = s.serialize_map(Some(kv.len()))?;
                for (k, v) in kv {
                    map.serialize_entry(k, v)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Json;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_none<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_bool<E>(self, b: bool) -> Result<Json, E> {
                Ok(Json::Bool(b))
            }
            fn visit_i64<E>(self, n: i64) -> Result<Json, E> {
                Ok(Json::Num(n.into()))
            }
            fn visit_u64<E>(self, n: u64) -> Result<Json, E> {
                Ok(Json::Num(n.into()))
            }
            fn visit_f64<E: de::Error>(self, n: f64) -> Result<Json, E> {
                serde_json::Number::from_f64(n).map(Json::Num).ok_or_else(|| E::custom("non-finite number"))
            }
            fn visit_str<E>(self, s: &str) -> Result<Json, E> {
                Ok(Json::Str(s.to_owned()))
            }
            fn visit_string<E>(self, s: String) -> Result<Json, E> {
                Ok(Json::Str(s))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Json, A::Error> {
                let mut out = Vec::new();
                while let Some(v) = a.next_element()? {
                    out.push(v);
                }
                Ok(Json::Arr(out))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Json, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = m.next_entry::<String, Json>()? {
                    out.push((k, v));
                }
                Ok(Json::Obj(out))
            }
        }
        d.deserialize_any(V)
    }
}

/// Why a manifest was refused, in the order the checks run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailCode {
    Format,
    V1Refused,
    KeyMismatch,
    HashMismatch,
    BadSignature,
    Rollback,
}

impl FailCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Format => "format",
            Self::V1Refused => "v1Refused",
            Self::KeyMismatch => "keyMismatch",
            Self::HashMismatch => "hashMismatch",
            Self::BadSignature => "badSignature",
            Self::Rollback => "rollback",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: FailCode,
    pub reason: &'static str,
}

fn fail<T>(code: FailCode, reason: &'static str) -> Result<T, Failure> {
    Err(Failure { code, reason })
}

#[derive(Debug, Clone, Default)]
pub struct VerifyOpts<'a> {
    /// Pinned raw Ed25519 key (base64url): the root of trust. Without it the key inside the file is only a self-consistency check.
    pub pin: Option<&'a str>,
    /// Lowest acceptable `seq`; a lower one is a rollback.
    pub min_seq: Option<u64>,
    /// Accept the legacy v1 format (tests only).
    pub allow_v1: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    /// `manifestSha256`.
    pub hash: String,
    /// `None` for a v1 manifest.
    pub seq: Option<u64>,
    pub built_at: Option<u64>,
    pub pubkey: String,
    pub files: Vec<FileEntry>,
}

/// Parses `text` and verifies it. Anything that is not valid JSON is a `Format` failure.
pub fn verify_manifest_str(text: &str, opts: &VerifyOpts) -> Result<Verified, Failure> {
    match serde_json::from_str::<Json>(text) {
        Ok(j) => verify_manifest(&j, opts),
        Err(_) => fail(FailCode::Format, "manifest is not valid JSON"),
    }
}

/// Pure manifest check (no file system), the same decisions in the same order as `verifyManifest` in `bundle-lib.mjs`.
pub fn verify_manifest(bundle: &Json, opts: &VerifyOpts) -> Result<Verified, Failure> {
    if !matches!(bundle, Json::Obj(_)) {
        return fail(FailCode::Format, "manifest is not an object");
    }
    let version = bundle.get("v").and_then(Json::as_u64);
    let v1 = match version {
        Some(1) if !opts.allow_v1 => return fail(FailCode::V1Refused, "format v1 bundles are refused"),
        Some(1) => true,
        Some(2) => false,
        _ => return fail(FailCode::Format, "unknown bundle format version"),
    };
    let Some(raw_files) = bundle.get("files").and_then(Json::as_array).filter(|a| a.len() <= MAX_MANIFEST_FILES) else {
        return fail(FailCode::Format, "files must be an array");
    };
    let mut files = Vec::with_capacity(raw_files.len());
    let mut seen = std::collections::HashSet::new();
    for f in raw_files {
        let Json::Obj(kv) = f else { return fail(FailCode::Format, "file entry has the wrong shape") };
        if kv.len() != 3 || kv[0].0 != "path" || kv[1].0 != "sha256" || kv[2].0 != "size" {
            return fail(FailCode::Format, "file entry has the wrong shape");
        }
        let (Some(path), Some(sha), Some(size)) = (kv[0].1.as_str(), kv[1].1.as_str(), kv[2].1.as_u64()) else {
            return fail(FailCode::Format, "bad file entry");
        };
        if !valid_path(path) || path == MANIFEST_NAME || !is_sha256_hex(sha) || size > MAX_SEQ {
            return fail(FailCode::Format, "bad file entry");
        }
        if !seen.insert(path.to_owned()) {
            return fail(FailCode::Format, "duplicate file entry");
        }
        files.push(FileEntry { path: path.to_owned(), sha256: sha.to_owned(), size });
    }
    let Some(manifest_sha) = bundle.get("manifestSha256").and_then(Json::as_str).filter(|s| is_sha256_hex(s)) else {
        return fail(FailCode::Format, "manifestSha256 must be 64 lowercase hex digits");
    };
    let Some(sig) = bundle.get("sig").and_then(Json::as_str).and_then(|s| b64u_bytes(s, 64)) else {
        return fail(FailCode::Format, "sig must be 64 bytes of canonical base64url");
    };
    let Some(pubkey_text) = bundle.get("pubkey").and_then(Json::as_str) else {
        return fail(FailCode::Format, "pubkey must be 32 bytes of canonical base64url");
    };
    let Some(pubkey) = b64u_bytes(pubkey_text, 32) else {
        return fail(FailCode::Format, "pubkey must be 32 bytes of canonical base64url");
    };
    let mut seq = None;
    if !v1 {
        match bundle.get("seq").and_then(Json::as_u64) {
            Some(s) if s <= MAX_SEQ => seq = Some(s),
            _ => return fail(FailCode::Format, "seq must be an integer between 0 and 2^53-1"),
        }
    }
    if let Some(pin) = opts.pin {
        if b64u_bytes(pin, 32).is_none() {
            return fail(FailCode::Format, "the pinned key is not a 32-byte base64url key");
        }
        if pubkey_text != pin {
            return fail(FailCode::KeyMismatch, "signing key differs from the pinned key");
        }
    }
    if manifest_hash(&files) != manifest_sha {
        return fail(FailCode::HashMismatch, "manifest hash does not match the file list");
    }
    let message = match seq {
        Some(s) => signed_message(manifest_sha, s),
        None => manifest_sha.as_bytes().to_vec(),
    };
    if UnparsedPublicKey::new(&ED25519, &pubkey).verify(&message, &sig).is_err() {
        return fail(FailCode::BadSignature, "bad signature");
    }
    if let (Some(min), Some(s)) = (opts.min_seq, seq) {
        if s < min {
            return fail(FailCode::Rollback, "seq is older than the highest accepted one");
        }
    }
    Ok(Verified {
        hash: manifest_sha.to_owned(),
        seq,
        built_at: bundle.get("builtAt").and_then(Json::as_u64),
        pubkey: pubkey_text.to_owned(),
        files,
    })
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// True when `served` holds exactly the manifest's files with the manifest's hashes and sizes (nothing missing, nothing extra).
pub fn files_match(manifest: &[FileEntry], served: &BTreeMap<String, Vec<u8>>) -> bool {
    manifest.len() == served.len()
        && manifest.iter().all(|f| served.get(&f.path).is_some_and(|b| b.len() as u64 == f.size && sha256_hex(b) == f.sha256))
}
