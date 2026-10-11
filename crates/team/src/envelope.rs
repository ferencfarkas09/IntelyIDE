//! The signed envelope `{epoch, sender, seq, nonce, ct, sig}` (docs/team.md). `ct` is XChaCha20-Poly1305 under the epoch key;
//! `sig` is the sender's Ed25519 signature over everything else, so a member holding the team key still cannot speak as someone
//! else. A per-sender sequence number, strictly increasing, rejects replays and reordered copies.

use std::collections::HashMap;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use intely_remote::util::{b64u, b64u_decode, random};
use serde::{Deserialize, Serialize};

use crate::error::{Result, TeamError};
use crate::identity::{verify, Identity};
use crate::keyring::Keyring;
use crate::roster::RosterBody;
use crate::wire::{frame, tag, unframe};

pub const MAX_PLAINTEXT: usize = 40 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    #[serde(rename = "e")]
    pub epoch: u32,
    #[serde(rename = "s")]
    pub sender: String,
    #[serde(rename = "q")]
    pub seq: u64,
    #[serde(rename = "n")]
    pub nonce: String,
    #[serde(rename = "c")]
    pub ct: String,
    #[serde(rename = "g")]
    pub sig: String,
}

fn header(team_id: &str, epoch: u32, sender: &str, seq: u64) -> Vec<u8> {
    let mut h = b"intely-team/env/v1\0".to_vec();
    h.extend_from_slice(team_id.as_bytes());
    h.push(0);
    h.extend_from_slice(&epoch.to_be_bytes());
    h.extend_from_slice(sender.as_bytes());
    h.push(0);
    h.extend_from_slice(&seq.to_be_bytes());
    h
}

fn signing_input(team_id: &str, e: &Envelope, nonce: &[u8], ct: &[u8]) -> Vec<u8> {
    let mut m = header(team_id, e.epoch, &e.sender, e.seq);
    m.extend_from_slice(nonce);
    m.extend_from_slice(ct);
    m
}

impl Envelope {
    /// The relay payload (`p`).
    pub fn encode(&self) -> String {
        frame(tag::ENVELOPE, &serde_json::to_vec(self).expect("envelope serializes"))
    }

    pub fn decode(p: &str) -> Result<Self> {
        let (t, body) = unframe(p)?;
        if t != tag::ENVELOPE {
            return Err(TeamError::Invalid("not an envelope".into()));
        }
        Ok(serde_json::from_slice(&body)?)
    }
}

pub fn seal(team_id: &str, keys: &Keyring, me: &Identity, seq: u64, plaintext: &[u8]) -> Result<Envelope> {
    if plaintext.len() > MAX_PLAINTEXT {
        return Err(TeamError::Invalid("message too large".into()));
    }
    let epoch = keys.current();
    let key = keys.key(epoch).ok_or(TeamError::NoKey(epoch))?;
    let nonce = random::<24>();
    let aad = header(team_id, epoch, &me.member_id, seq);
    let ct = XChaCha20Poly1305::new(key.into()).encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad: &aad }).map_err(|_| TeamError::Crypto("encrypt".into()))?;
    let mut e = Envelope { epoch, sender: me.member_id.clone(), seq, nonce: b64u(&nonce), ct: b64u(&ct), sig: String::new() };
    e.sig = b64u(&me.sign(&signing_input(team_id, &e, &nonce, &ct)));
    Ok(e)
}

/// Highest sequence number seen per sender.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplayGuard {
    last: HashMap<String, u64>,
}

impl ReplayGuard {
    pub fn fresh(&self, sender: &str, seq: u64) -> bool {
        seq > self.last.get(sender).copied().unwrap_or(0)
    }

    fn commit(&mut self, sender: &str, seq: u64) {
        self.last.insert(sender.to_string(), seq);
    }

    pub fn forget(&mut self, sender: &str) {
        self.last.remove(sender);
    }
}

/// Checks in this order: sender is on the roster, signature, replay, key for the epoch, AEAD. The replay counter moves only
/// after everything else passed, so a forged or garbled frame cannot burn a real sequence number.
pub fn open(team_id: &str, keys: &Keyring, roster: &RosterBody, guard: &mut ReplayGuard, e: &Envelope) -> Result<Vec<u8>> {
    let member = roster.member(&e.sender).ok_or(TeamError::UnknownSender)?;
    let (nonce, ct, sig) = (b64u_decode(&e.nonce), b64u_decode(&e.ct), b64u_decode(&e.sig));
    let (Some(nonce), Some(ct), Some(sig)) = (nonce, ct, sig) else { return Err(TeamError::Invalid("envelope fields".into())) };
    if nonce.len() != 24 || e.epoch > roster.epoch {
        return Err(TeamError::Invalid("envelope fields".into()));
    }
    let pubkey = member.sign_key().ok_or(TeamError::Forged)?;
    if !verify(&pubkey, &signing_input(team_id, e, &nonce, &ct), &sig) {
        return Err(TeamError::Forged);
    }
    if !guard.fresh(&e.sender, e.seq) {
        return Err(TeamError::Replay);
    }
    let key = keys.key(e.epoch).ok_or(TeamError::NoKey(e.epoch))?;
    let aad = header(team_id, e.epoch, &e.sender, e.seq);
    let pt = XChaCha20Poly1305::new(key.into()).decrypt(XNonce::from_slice(&nonce), Payload { msg: &ct, aad: &aad }).map_err(|_| TeamError::Crypto("decrypt".into()))?;
    guard.commit(&e.sender, e.seq);
    Ok(pt)
}
