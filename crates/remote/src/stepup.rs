//! Step-up (remote-plan 4.2): a WebAuthn passkey assertion, `userVerification: required`, bound to one request and verified
//! here on the Mac in Rust (ES256 signature, rpIdHash, UP+UV flags, counter, challenge, origin), so the relay cannot forge it.

use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};

use crate::devices::Passkey;
use crate::util::{b64u, b64u_decode, random, sha256};
use crate::wire::StepUpProof;

pub const CHALLENGE_TTL_MS: u64 = 5 * 60_000;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StepUpError {
    #[error("no passkey is registered for this device")]
    NoPasskey,
    #[error("the challenge expired")]
    Expired,
    #[error("the assertion is not valid: {0}")]
    Invalid(&'static str),
}

#[derive(Debug, Clone)]
pub struct Challenge {
    pub bytes: [u8; 32],
    pub device_id: String,
    pub req_id: String,
    pub expires_at: u64,
}

impl Challenge {
    /// Bound to the request: the bytes depend on a fresh nonce, the request id and the hash of the displayed intent.
    pub fn issue(device_id: &str, req_id: &str, intent_hash: &str, now_ms: u64) -> Self {
        let nonce = random::<16>();
        let mut m = b"intely-remote/stepup/v1".to_vec();
        m.extend_from_slice(&nonce);
        m.extend_from_slice(req_id.as_bytes());
        m.push(0);
        m.extend_from_slice(intent_hash.as_bytes());
        Self { bytes: sha256(&m), device_id: device_id.into(), req_id: req_id.into(), expires_at: now_ms + CHALLENGE_TTL_MS }
    }

    pub fn encoded(&self) -> String {
        b64u(&self.bytes)
    }
}

/// SEC1 uncompressed point from either a raw 65-byte key or an SPKI DER (what `getPublicKey()` returns), validated on the curve.
pub fn parse_public_key(encoded: &str) -> Option<Vec<u8>> {
    let raw = b64u_decode(encoded)?;
    let point = match raw.len() {
        65 => raw,
        91 if raw[..26] == [0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00] => raw[26..].to_vec(),
        _ => return None,
    };
    VerifyingKey::from_sec1_bytes(&point).ok()?;
    Some(point)
}

/// Returns the authenticator counter to store.
pub fn verify(proof: &StepUpProof, ch: &Challenge, passkey: Option<&Passkey>, rp_id: &str, origin: &str, now_ms: u64) -> Result<u32, StepUpError> {
    let pk = passkey.ok_or(StepUpError::NoPasskey)?;
    if now_ms >= ch.expires_at {
        return Err(StepUpError::Expired);
    }
    if proof.credential_id != pk.credential_id {
        return Err(StepUpError::Invalid("another credential"));
    }
    let client = b64u_decode(&proof.client_data_json).ok_or(StepUpError::Invalid("clientDataJSON"))?;
    let auth = b64u_decode(&proof.authenticator_data).ok_or(StepUpError::Invalid("authenticatorData"))?;
    let sig = b64u_decode(&proof.signature).ok_or(StepUpError::Invalid("signature"))?;

    let cd: serde_json::Value = serde_json::from_slice(&client).map_err(|_| StepUpError::Invalid("clientDataJSON"))?;
    if cd.get("type").and_then(|v| v.as_str()) != Some("webauthn.get") {
        return Err(StepUpError::Invalid("wrong type"));
    }
    if cd.get("challenge").and_then(|v| v.as_str()).and_then(b64u_decode).as_deref() != Some(&ch.bytes[..]) {
        return Err(StepUpError::Invalid("wrong challenge"));
    }
    if cd.get("origin").and_then(|v| v.as_str()) != Some(origin) || cd.get("crossOrigin").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err(StepUpError::Invalid("wrong origin"));
    }
    if auth.len() < 37 || auth[..32] != sha256(rp_id.as_bytes()) {
        return Err(StepUpError::Invalid("wrong relying party"));
    }
    let flags = auth[32];
    if flags & 0x01 == 0 || flags & 0x04 == 0 {
        return Err(StepUpError::Invalid("user presence and verification are required"));
    }
    let counter = u32::from_be_bytes([auth[33], auth[34], auth[35], auth[36]]);
    // some platform authenticators always report 0; a non-zero counter must grow
    if !(counter == 0 && pk.counter == 0) && counter <= pk.counter {
        return Err(StepUpError::Invalid("replayed assertion (counter did not grow)"));
    }

    let key_bytes = hex::decode(&pk.public_key).map_err(|_| StepUpError::Invalid("stored key"))?;
    let key = VerifyingKey::from_sec1_bytes(&key_bytes).map_err(|_| StepUpError::Invalid("stored key"))?;
    let signature = Signature::from_der(&sig).map_err(|_| StepUpError::Invalid("signature encoding"))?;
    let mut signed = auth.clone();
    signed.extend_from_slice(&sha256(&client));
    key.verify(&signed, &signature).map_err(|_| StepUpError::Invalid("signature does not verify"))?;
    Ok(counter)
}
