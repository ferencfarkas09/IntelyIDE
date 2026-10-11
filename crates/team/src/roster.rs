//! The member list, signed by an admin. The relay only knows ids and roles; names and keys live here. What the relay stores is the
//! signed roster *encrypted under the current epoch key* ([`SignedRoster::seal_payload`]), so it can neither read the names and keys
//! nor change anything without the AEAD and the signature failing. A roster is accepted only if its signer is an admin of the
//! roster the member already trusts (or, on joining, the admin whose Noise key the invite pinned).

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use intely_remote::util::{b64u, b64u_decode, random};
use serde::{Deserialize, Serialize};

use crate::error::{Result, TeamError};
use crate::identity::{verify, Identity};
use crate::keyring::Keyring;

pub const MAX_MEMBERS: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    Member,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterMember {
    pub id: String,
    pub name: String,
    pub role: Role,
    /// Ed25519, base64url.
    pub sign_pub: String,
    /// X25519 (Noise static), base64url.
    pub noise_pub: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterBody {
    pub team_id: String,
    pub version: u64,
    /// The key epoch members must hold to read the team's traffic.
    pub epoch: u32,
    pub ts: u64,
    pub members: Vec<RosterMember>,
}

impl RosterBody {
    pub fn member(&self, id: &str) -> Option<&RosterMember> {
        self.members.iter().find(|m| m.id == id)
    }
}

impl RosterMember {
    pub fn sign_key(&self) -> Option<Vec<u8>> {
        b64u_decode(&self.sign_pub).filter(|k| k.len() == 32)
    }

    pub fn noise_key(&self) -> Option<[u8; 32]> {
        b64u_decode(&self.noise_pub)?.try_into().ok()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedRoster {
    /// The exact JSON text that was signed.
    pub body: String,
    pub signer: String,
    /// Ed25519 over [`signing_input`], base64url.
    pub sig: String,
}

fn payload_aad(team_id: &str, epoch: u32) -> Vec<u8> {
    let mut a = b"intely-team/roster-payload/v1\0".to_vec();
    a.extend_from_slice(team_id.as_bytes());
    a.extend_from_slice(&epoch.to_be_bytes());
    a
}

fn signing_input(team_id: &str, body: &str) -> Vec<u8> {
    let mut m = b"intely-team/roster/v1\0".to_vec();
    m.extend_from_slice(team_id.as_bytes());
    m.push(0);
    m.extend_from_slice(body.as_bytes());
    m
}

impl SignedRoster {
    pub fn sign(body: &RosterBody, signer: &Identity) -> Result<Self> {
        let text = serde_json::to_string(body)?;
        let sig = b64u(&signer.sign(&signing_input(&body.team_id, &text)));
        Ok(Self { body: text, signer: signer.member_id.clone(), sig })
    }

    /// The relay payload of `roster.put`: `epoch (4 bytes BE) | nonce (24) | XChaCha20-Poly1305(signed roster JSON)`, base64url, under
    /// the current epoch key; the team id and epoch are the associated data.
    pub fn seal_payload(&self, team_id: &str, keys: &Keyring) -> Result<String> {
        let epoch = keys.current();
        let key = keys.key(epoch).ok_or(TeamError::NoKey(epoch))?;
        let nonce = random::<24>();
        let aad = payload_aad(team_id, epoch);
        let ct = XChaCha20Poly1305::new(key.into()).encrypt(XNonce::from_slice(&nonce), Payload { msg: &serde_json::to_vec(self)?, aad: &aad }).map_err(|_| TeamError::Crypto("encrypt".into()))?;
        let mut out = epoch.to_be_bytes().to_vec();
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        Ok(b64u(&out))
    }

    /// Opens a relay payload; `NoKey` while the key of its epoch has not arrived yet.
    pub fn open_payload(p: &str, team_id: &str, keys: &Keyring) -> Result<Self> {
        let raw = b64u_decode(p).filter(|r| r.len() > 28 + 16).ok_or_else(|| TeamError::Invalid("roster payload".into()))?;
        let epoch = u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]);
        let key = keys.key(epoch).ok_or(TeamError::NoKey(epoch))?;
        let plain = XChaCha20Poly1305::new(key.into()).decrypt(XNonce::from_slice(&raw[4..28]), Payload { msg: &raw[28..], aad: &payload_aad(team_id, epoch) }).map_err(|_| TeamError::Crypto("decrypt".into()))?;
        Ok(serde_json::from_slice(&plain)?)
    }

    /// Parses without trusting.
    pub fn parse(&self) -> Result<RosterBody> {
        Ok(serde_json::from_str(&self.body)?)
    }

    fn check_sig(&self, body: &RosterBody, signer_key: &[u8]) -> Result<()> {
        let sig = b64u_decode(&self.sig).ok_or(TeamError::Forged)?;
        if verify(signer_key, &signing_input(&body.team_id, &self.body), &sig) {
            Ok(())
        } else {
            Err(TeamError::Forged)
        }
    }

    /// Verifies a roster against the one already trusted: same team, higher version, signed by an admin of the old roster.
    pub fn verify_next(&self, team_id: &str, prev: &RosterBody) -> Result<RosterBody> {
        let body = self.parse()?;
        if body.team_id != team_id || body.version <= prev.version || body.epoch < prev.epoch || body.members.len() > MAX_MEMBERS {
            return Err(TeamError::Invalid("the roster is not a valid successor".into()));
        }
        let signer = prev.member(&self.signer).filter(|m| m.role == Role::Admin).ok_or(TeamError::NotAdmin)?;
        self.check_sig(&body, &signer.sign_key().ok_or(TeamError::Forged)?)?;
        // an admin of the old roster must still be in the new one as admin (nobody else may remove the signer)
        if body.member(&self.signer).map(|m| m.role) != Some(Role::Admin) {
            return Err(TeamError::Invalid("the signer must stay an admin".into()));
        }
        Ok(body)
    }

    /// Verifies the first roster a joiner sees: signed by the admin the invite (and the Noise channel) pinned.
    pub fn verify_first(&self, team_id: &str, admin_id: &str, admin_noise_pub: &[u8; 32]) -> Result<RosterBody> {
        let body = self.parse()?;
        if body.team_id != team_id || self.signer != admin_id || body.members.len() > MAX_MEMBERS {
            return Err(TeamError::Invalid("the roster does not belong to this invite".into()));
        }
        let admin = body.member(admin_id).filter(|m| m.role == Role::Admin && m.noise_key().as_ref() == Some(admin_noise_pub)).ok_or(TeamError::NotAdmin)?;
        self.check_sig(&body, &admin.sign_key().ok_or(TeamError::Forged)?)?;
        Ok(body)
    }
}
