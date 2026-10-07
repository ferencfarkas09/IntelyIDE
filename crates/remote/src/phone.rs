//! Reference phone-side client of the protocol, in Rust. It is the test double for the gateway (a fake phone that pairs,
//! reconnects, resumes, answers and misbehaves) and the executable specification the JS bundle of the PWA must match
//! (the cross-implementation vectors of R0 are produced from these functions).

use serde_json::Value;

use crate::error::{RemoteError, Result};
use crate::noise::{framed, psk_from_otp, tag, Handshake, Kind, StaticKey, Transport};
use crate::wire::{Capability, ClientMsg, PairMsg, PairReply, ServerMsg, PROTOCOL_VERSION};

fn to_bytes<T: serde::Serialize>(m: &T) -> Vec<u8> {
    let mut v = serde_json::to_value(m).expect("messages serialize");
    v.as_object_mut().expect("object").insert("v".into(), PROTOCOL_VERSION.into());
    serde_json::to_vec(&v).expect("serializes")
}

fn from_bytes<T: serde::de::DeserializeOwned>(b: &[u8]) -> Result<T> {
    let mut v: Value = serde_json::from_slice(b).map_err(|e| RemoteError::Invalid(e.to_string()))?;
    v.as_object_mut().ok_or_else(|| RemoteError::Invalid("not an object".into()))?.remove("v");
    serde_json::from_value(v).map_err(|e| RemoteError::Invalid(e.to_string()))
}

#[derive(Debug, Clone)]
pub struct Accepted {
    pub device_id: String,
    pub device_token: String,
    pub capability: Capability,
}

pub struct PhonePairing {
    pub key: StaticKey,
    hs: Option<Handshake>,
    transport: Option<Transport>,
    pub sas: Option<String>,
    pub accepted: Option<Accepted>,
    pub rejected: Option<String>,
    /// The Mac's build-signing key from the `welcome` that precedes `accepted`.
    pub welcome: Option<String>,
    name: String,
}

impl PhonePairing {
    /// `mac_public` and `otp` come from the QR; returns the first frame to send.
    pub fn start(key: StaticKey, mac_public: &[u8; 32], otp: &[u8; 16], name: &str) -> Result<(Self, Vec<u8>)> {
        let mut hs = Handshake::initiator(Kind::Pairing, &key, mac_public, Some(&psk_from_otp(otp)))?;
        let msg1 = hs.write(&[])?;
        Ok((Self { key, hs: Some(hs), transport: None, sas: None, accepted: None, rejected: None, welcome: None, name: name.into() }, framed(tag::PAIR_INIT, &msg1)))
    }

    /// Handles a frame from the Mac; returns frames to send back.
    pub fn on_frame(&mut self, frame: &[u8]) -> Result<Vec<Vec<u8>>> {
        let (t, body) = frame.split_first().ok_or_else(|| RemoteError::Invalid("empty".into()))?;
        match *t {
            tag::PAIR_RESP => {
                let mut hs = self.hs.take().ok_or_else(|| RemoteError::Invalid("unexpected".into()))?;
                hs.read(body)?;
                self.sas = Some(hs.sas());
                let mut tr = hs.into_transport()?;
                let hello = tr.encrypt(&to_bytes(&PairMsg::Hello { name: self.name.clone() }))?;
                self.transport = Some(tr);
                Ok(vec![framed(tag::DATA, &hello)])
            }
            tag::DATA => {
                let tr = self.transport.as_mut().ok_or_else(|| RemoteError::Invalid("no channel".into()))?;
                match from_bytes::<PairReply>(&tr.decrypt(body)?)? {
                    PairReply::Accepted { device_id, device_token, capability, .. } => self.accepted = Some(Accepted { device_id, device_token, capability }),
                    PairReply::Rejected { reason } => self.rejected = Some(reason),
                    PairReply::Welcome { bundle_pub } => self.welcome = Some(bundle_pub),
                }
                Ok(vec![])
            }
            _ => Err(RemoteError::Invalid("unknown tag".into())),
        }
    }

    pub fn send_pair_msg(&mut self, m: &PairMsg) -> Result<Vec<u8>> {
        let tr = self.transport.as_mut().ok_or_else(|| RemoteError::Invalid("no channel".into()))?;
        Ok(framed(tag::DATA, &tr.encrypt(&to_bytes(m))?))
    }
}

pub struct PhoneSession {
    hs: Option<Handshake>,
    transport: Option<Transport>,
}

impl PhoneSession {
    /// A reconnect: `Noise_IK` with fresh ephemerals. Returns the first frame.
    pub fn connect(key: &StaticKey, mac_public: &[u8; 32]) -> Result<(Self, Vec<u8>)> {
        let mut hs = Handshake::initiator(Kind::Reconnect, key, mac_public, None)?;
        let msg1 = hs.write(&[])?;
        Ok((Self { hs: Some(hs), transport: None }, framed(tag::IK_INIT, &msg1)))
    }

    pub fn is_open(&self) -> bool {
        self.transport.is_some()
    }

    /// Feeds one frame from the Mac; yields the server message of a data frame.
    pub fn on_frame(&mut self, frame: &[u8]) -> Result<Option<ServerMsg>> {
        let (t, body) = frame.split_first().ok_or_else(|| RemoteError::Invalid("empty".into()))?;
        match *t {
            tag::IK_RESP => {
                let mut hs = self.hs.take().ok_or_else(|| RemoteError::Invalid("unexpected".into()))?;
                hs.read(body)?;
                self.transport = Some(hs.into_transport()?);
                Ok(None)
            }
            tag::DATA => {
                let tr = self.transport.as_mut().ok_or_else(|| RemoteError::Invalid("no channel".into()))?;
                Ok(Some(from_bytes(&tr.decrypt(body)?)?))
            }
            _ => Err(RemoteError::Invalid("unknown tag".into())),
        }
    }

    pub fn send(&mut self, m: &ClientMsg) -> Result<Vec<u8>> {
        let tr = self.transport.as_mut().ok_or_else(|| RemoteError::Invalid("no channel".into()))?;
        Ok(framed(tag::DATA, &tr.encrypt(&to_bytes(m))?))
    }

    /// An encrypted frame carrying arbitrary bytes (for malformed-message tests).
    pub fn send_raw(&mut self, plaintext: &[u8]) -> Result<Vec<u8>> {
        let tr = self.transport.as_mut().ok_or_else(|| RemoteError::Invalid("no channel".into()))?;
        Ok(framed(tag::DATA, &tr.encrypt(plaintext)?))
    }
}
