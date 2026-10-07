//! Minisign verification of the feed and of artifacts, trusted-comment binding, SHA-256
//! ((design notes: updater-spec) 4.6 "Signature files", 4.7).
//!
//! Signatures and public keys are in the format of `tauri signer`: the `.sig` / `.pub` files hold
//! the base64 of the two/four-line minisign text. The production policy refuses legacy `Ed`
//! signatures; only tests may allow them.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use minisign_verify::{PublicKey, Signature};
use ring::digest;
use semver::Version;

use crate::keys::{decode_public, signature_key_id, FileKind, KeySet, Revocations, Role};
use crate::limits::{ENTRY_SIG_MAX_BYTES, FEED_SIG_MAX_BYTES};
use crate::version::{self, Channel};
use crate::ErrorCode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VerifyPolicy {
    /// Legacy (non-prehashed) `Ed` signatures. Tests only.
    pub allow_legacy: bool,
    /// The trusted comment must carry a `version:` field equal to the expected version. The
    /// pinned CLI (2.12.1) embeds it with `--app-version` (U1 golden test), so production
    /// requires it; `sign-feed.sh` / `sign-artifacts.sh` pass `--app-version`.
    pub require_version: bool,
}

impl VerifyPolicy {
    pub const PRODUCTION: VerifyPolicy = VerifyPolicy { allow_legacy: false, require_version: true };
    /// Test mode: legacy signatures accepted, version binding optional.
    pub const TEST_LENIENT: VerifyPolicy = VerifyPolicy { allow_legacy: true, require_version: false };
}

/// The trusted comment of a signature, split on TAB into `key:value` fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustedComment {
    pub timestamp: Option<String>,
    pub file: String,
    pub version: Option<String>,
}

/// Parse a trusted comment: fields separated by TAB, each `key:value`; only `timestamp`, `file`
/// and `version` are known; a duplicate, an unknown key, a field without a colon, a missing or
/// empty `file`, a control character or an over-long value is `signatureComment`.
pub fn parse_trusted_comment(s: &str) -> Result<TrustedComment, ErrorCode> {
    let bad = ErrorCode::SignatureComment;
    if s.is_empty() || s.len() > 1024 {
        return Err(bad);
    }
    let (mut timestamp, mut file, mut ver) = (None, None, None);
    for field in s.split('\t') {
        let (k, v) = field.split_once(':').ok_or(bad)?;
        if v.len() > 512 || v.chars().any(|c| c.is_control()) {
            return Err(bad);
        }
        let slot = match k {
            "timestamp" => &mut timestamp,
            "file" => &mut file,
            "version" => &mut ver,
            _ => return Err(bad),
        };
        if slot.is_some() {
            return Err(bad);
        }
        *slot = Some(v.to_string());
    }
    let file = file.filter(|f| !f.is_empty()).ok_or(bad)?;
    if let Some(t) = &timestamp {
        if t.is_empty() || t.len() > 12 || !t.bytes().all(|b| b.is_ascii_digit()) {
            return Err(bad);
        }
    }
    if let Some(v) = &ver {
        version::parse_strict(v).map_err(|_| bad)?;
    }
    Ok(TrustedComment { timestamp, file, version: ver })
}

/// The outcome of a successful verification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verified {
    pub key_id: String,
    pub role: Role,
    pub comment: TrustedComment,
}

impl Verified {
    /// Bind the signature to a version: a `version:` field, when present, must equal `expected`;
    /// when the policy requires it, it must be present.
    pub fn check_version(&self, expected: &Version, policy: VerifyPolicy) -> Result<(), ErrorCode> {
        match &self.comment.version {
            Some(v) if *v == expected.to_string() => Ok(()),
            Some(_) => Err(ErrorCode::SignatureComment),
            None if policy.require_version => Err(ErrorCode::SignatureComment),
            None => Ok(()),
        }
    }
}

/// Decode the base64 of a `.sig` file to the minisign text, within `max` bytes of input.
fn sig_text(sig_b64: &str, max: usize, bad: ErrorCode) -> Result<String, ErrorCode> {
    let t = sig_b64.trim();
    if t.is_empty() || t.len() > max {
        return Err(bad);
    }
    let raw = B64.decode(t).map_err(|_| bad)?;
    String::from_utf8(raw).map_err(|_| bad)
}

/// A signature whose key was looked up and checked for role and revocation, ready to verify bytes.
pub struct PreparedSignature {
    public_key: PublicKey,
    signature: Signature,
    key_id: String,
    role: Role,
    expected_file: String,
    kind: FileKind,
    policy: VerifyPolicy,
}

impl PreparedSignature {
    /// Everything except the data: decode, find the signing key (it must be in the set, not
    /// revoked, and have a role that `kind` accepts).
    pub fn new(
        kind: FileKind,
        keys: &KeySet,
        revoked: &Revocations,
        policy: VerifyPolicy,
        sig_b64: &str,
        expected_file: &str,
    ) -> Result<PreparedSignature, ErrorCode> {
        let bad = kind.bad_key_code();
        let max = match kind {
            FileKind::Feed => FEED_SIG_MAX_BYTES as usize,
            FileKind::Artifact => ENTRY_SIG_MAX_BYTES,
        };
        let text = sig_text(sig_b64, max, bad)?;
        let id = signature_key_id(&text).map_err(|_| bad)?;
        let key = keys.signer_for(kind, &id, revoked)?;
        let (public_key, pid) = decode_public(&key.public_b64)?;
        if pid != key.id {
            return Err(ErrorCode::NoTrustedKey);
        }
        let signature = Signature::decode(&text).map_err(|_| bad)?;
        Ok(PreparedSignature {
            public_key,
            signature,
            key_id: id,
            role: key.role,
            expected_file: expected_file.to_string(),
            kind,
            policy,
        })
    }

    fn finish(&self) -> Result<Verified, ErrorCode> {
        // The comment is only trusted after the (global) signature verified.
        let comment = parse_trusted_comment(self.signature.trusted_comment())?;
        if comment.file != self.expected_file {
            return Err(ErrorCode::SignatureComment);
        }
        Ok(Verified { key_id: self.key_id.clone(), role: self.role, comment })
    }

    /// Verify in-memory bytes (signature and global signature), then bind the trusted comment.
    pub fn verify_bytes(&self, data: &[u8]) -> Result<Verified, ErrorCode> {
        self.public_key
            .verify(data, &self.signature, self.policy.allow_legacy)
            .map_err(|_| self.kind.bad_key_code())?;
        self.finish()
    }

    /// Streaming verification for large artifacts (prehashed signatures only).
    pub fn stream(&self) -> Result<ArtifactStream<'_>, ErrorCode> {
        let v = self.public_key.verify_stream(&self.signature).map_err(|_| self.kind.bad_key_code())?;
        Ok(ArtifactStream { v, prepared: self })
    }
}

pub struct ArtifactStream<'a> {
    v: minisign_verify::StreamVerifier<'a>,
    prepared: &'a PreparedSignature,
}

impl ArtifactStream<'_> {
    pub fn update(&mut self, chunk: &[u8]) {
        self.v.update(chunk);
    }

    pub fn finalize(mut self) -> Result<Verified, ErrorCode> {
        self.v.finalize().map_err(|_| self.prepared.kind.bad_key_code())?;
        self.prepared.finish()
    }
}

/// Verify the bytes of `<channel>.json` against its `.sig` text. The trusted comment's `file:`
/// must be `<channel>.json`. The `version:` binding is checked by the caller after parsing
/// (`Verified::check_version`).
pub fn verify_feed(
    keys: &KeySet,
    revoked: &Revocations,
    policy: VerifyPolicy,
    feed_bytes: &[u8],
    sig_b64: &str,
    channel: Channel,
) -> Result<Verified, ErrorCode> {
    let file = format!("{}.json", channel.as_str());
    PreparedSignature::new(FileKind::Feed, keys, revoked, policy, sig_b64, &file)?.verify_bytes(feed_bytes)
}

/// Verify an artifact held in memory against the `signature` of its feed entry.
pub fn verify_artifact(
    keys: &KeySet,
    revoked: &Revocations,
    policy: VerifyPolicy,
    bytes: &[u8],
    sig_b64: &str,
    expected_name: &str,
) -> Result<Verified, ErrorCode> {
    PreparedSignature::new(FileKind::Artifact, keys, revoked, policy, sig_b64, expected_name)?.verify_bytes(bytes)
}

/// Lower-case hex SHA-256.
pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(digest::digest(&digest::SHA256, data).as_ref())
}

/// Incremental SHA-256 (the download hashes while streaming).
pub struct Sha256Stream(digest::Context);

impl Sha256Stream {
    pub fn new() -> Self {
        Sha256Stream(digest::Context::new(&digest::SHA256))
    }
    pub fn update(&mut self, chunk: &[u8]) {
        self.0.update(chunk);
    }
    pub fn finish_hex(self) -> String {
        hex::encode(self.0.finish().as_ref())
    }
}

impl Default for Sha256Stream {
    fn default() -> Self {
        Self::new()
    }
}
