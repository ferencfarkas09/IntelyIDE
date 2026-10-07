//! VAPID key generation (spec 4.5): a P-256 pair made in Rust (`p256`), the private scalar `d` as base64url (the form
//! `remote-relay/src/push.ts` expects), the public key as the uncompressed point, base64url.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use p256::elliptic_curve::sec1::ToSec1Point;
use p256::SecretKey;
use ring::rand::{SecureRandom, SystemRandom};
use zeroize::Zeroizing;

use crate::error::{BundleError, Result};
use crate::manifest::b64u_bytes;
use crate::Secret;

#[derive(Debug, Clone)]
pub struct VapidKeys {
    /// The raw P-256 scalar `d`, base64url. `Debug` prints a placeholder.
    pub private: Secret,
    /// Uncompressed public point (65 bytes starting with 0x04), base64url.
    pub public: String,
}

fn public_of(sk: &SecretKey) -> String {
    URL_SAFE_NO_PAD.encode(sk.public_key().to_sec1_point(false).as_bytes())
}

pub fn generate_vapid() -> Result<VapidKeys> {
    let rng = SystemRandom::new();
    // A random 32-byte string is a valid scalar unless it is zero or at least the group order: practically never, so retry.
    for _ in 0..16 {
        let mut d = Zeroizing::new([0u8; 32]);
        rng.fill(&mut d[..]).map_err(|_| BundleError::BadKey)?;
        if let Ok(sk) = SecretKey::from_slice(&d[..]) {
            return Ok(VapidKeys { private: Secret::new(URL_SAFE_NO_PAD.encode(&d[..])), public: public_of(&sk) });
        }
    }
    Err(BundleError::BadKey)
}

/// The public point belonging to a private scalar made by `generate_vapid` or `remote-relay/scripts/gen-vapid.mjs`.
pub fn public_from_private(private: &Secret) -> Result<String> {
    let d = Zeroizing::new(b64u_bytes(private.expose(), 32).ok_or(BundleError::BadKey)?);
    let sk = SecretKey::from_slice(&d).map_err(|_| BundleError::BadKey)?;
    Ok(public_of(&sk))
}
