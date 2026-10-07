//! Pairing offers (remote-plan 2.4). A one-time 128-bit code, valid 60 s, single use. It is the PSK of `Noise_IKpsk2` and, through
//! a second derivation, the relay's `pair.<token>` credential. The QR carries relay host, room id, the Mac's static key and the
//! code in the URL *fragment* (never sent to a server); the manual code carries the code only (key and room come from the
//! relay and are authenticated by the PSK handshake and the 6-digit comparison on both screens).

use serde::{Deserialize, Serialize};

use crate::identity::Identity;
use crate::noise::{pair_token_from_otp, psk_from_otp};
use crate::util::{b64u, sha256_hex};

pub const OFFER_TTL_MS: u64 = 60_000;
/// Wrong-PSK or garbage handshakes tolerated before the offer is burned.
pub const MAX_FAILED_ATTEMPTS: u32 = 3;
/// After the handshake the phone must prove the PSK with its hello within this time.
pub const HELLO_TIMEOUT_MS: u64 = 15_000;
/// After the hello the Mac user has this long to compare the codes and decide.
pub const CONFIRM_TIMEOUT_MS: u64 = 120_000;

pub struct Offer {
    pub otp: [u8; 16],
    pub expires_at: u64,
    pub failed: u32,
    /// The link currently running the handshake (one at a time).
    pub active: Option<(String, u64)>,
}

impl Offer {
    pub fn new(otp: [u8; 16], now: u64) -> Self {
        Self { otp, expires_at: now + OFFER_TTL_MS, failed: 0, active: None }
    }

    pub fn psk(&self) -> [u8; 32] {
        psk_from_otp(&self.otp)
    }

    pub fn relay_token_hash(&self) -> String {
        sha256_hex(pair_token_from_otp(&self.otp).as_bytes())
    }
}

/// What the Mac UI shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct OfferView {
    /// The QR payload: `#p=<relayHost>,<roomId>,<macStaticPub>,<otp>` (all base64url except the host).
    pub qr_fragment: String,
    /// The one-time code grouped for typing: 26 base32 characters.
    pub manual_code: String,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub expires_at: u64,
}

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// 128 bits -> 26 base32 characters in groups of 4/5/5/5/5/2... grouped as `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X`.
pub fn manual_code(otp: &[u8; 16]) -> String {
    let mut bits = 0u32;
    let mut acc = 0u32;
    let mut out = String::new();
    for b in otp {
        acc = (acc << 8) | u32::from(*b);
        bits += 8;
        while bits >= 5 {
            out.push(CROCKFORD[((acc >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(CROCKFORD[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out.as_bytes().chunks(5).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("-")
}

pub fn parse_manual_code(code: &str) -> Option<[u8; 16]> {
    let mut acc = 0u32;
    let mut bits = 0u32;
    let mut out = Vec::new();
    for c in code.chars().filter(|c| *c != '-' && !c.is_whitespace()) {
        let c = match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            x => x,
        };
        let v = CROCKFORD.iter().position(|x| *x as char == c)? as u32;
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            out.push(((acc >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    out.truncate(16);
    out.try_into().ok()
}

pub fn offer_view(offer: &Offer, id: &Identity, relay_host: &str) -> OfferView {
    OfferView {
        qr_fragment: format!("#p={relay_host},{},{},{}", id.room_id, b64u(&id.static_key.public), b64u(&offer.otp)),
        manual_code: manual_code(&offer.otp),
        expires_at: offer.expires_at,
    }
}

/// What `qr.ts` can encode (`MAX_BYTES` there).
pub const QR_MAX_BYTES: usize = 288;

/// Length of the pairing link `https://<host>/#p=<host>,<room 22>,<mac key 43>,<otp 22>` the Mac UI turns into a QR.
pub fn qr_link_len(relay_host: &str) -> usize {
    "https://".len() + relay_host.len() + "/#p=".len() + relay_host.len() + 1 + 22 + 1 + 43 + 1 + 22
}

/// A relay whose pairing QR would not fit is refused when it is chosen, not when the first phone is paired.
pub fn qr_fits(relay_host: &str) -> bool {
    qr_link_len(relay_host) <= QR_MAX_BYTES
}
