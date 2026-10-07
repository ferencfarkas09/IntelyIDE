//! Noise over any byte pipe (remote-plan 2.4). One fixed suite, no negotiation: `Noise_IKpsk2` for pairing (the phone knows
//! the Mac's static key from the QR and proves possession of the one-time PSK) and `Noise_IK` for every reconnect (fresh
//! ephemerals per connection = forward secrecy). The prologue pins the protocol version, so a downgrade fails the handshake.
//! After the handshake each direction is a counter-based AEAD stream: a replayed, dropped-in or reordered frame fails to
//! decrypt. Every [`REKEY_EVERY`] messages each direction rekeys.

use snow::params::NoiseParams;
use snow::{Builder, HandshakeState, TransportState};

use crate::error::{RemoteError, Result};
use crate::util::{random, sha256};

pub const SUITE_IK: &str = "Noise_IK_25519_ChaChaPoly_SHA256";
pub const SUITE_IKPSK2: &str = "Noise_IKpsk2_25519_ChaChaPoly_SHA256";
pub const PROLOGUE: &[u8] = b"intely-remote\x00v1\x00min=1";
pub const REKEY_EVERY: u64 = 65_536;
/// Largest Noise message.
pub const MAX_NOISE_MSG: usize = 65_535;

#[derive(Clone)]
pub struct StaticKey {
    pub private: [u8; 32],
    pub public: [u8; 32],
}

impl std::fmt::Debug for StaticKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "StaticKey(public={})", hex::encode(self.public))
    }
}

impl StaticKey {
    pub fn generate() -> Self {
        let kp = Builder::new(params(SUITE_IK)).generate_keypair().expect("the default resolver has X25519");
        Self { private: kp.private.try_into().expect("32 bytes"), public: kp.public.try_into().expect("32 bytes") }
    }

    /// `private:public` as hex, the shape stored in the secret store.
    pub fn to_secret(&self) -> String {
        format!("{}:{}", hex::encode(self.private), hex::encode(self.public))
    }

    pub fn from_secret(s: &str) -> Option<Self> {
        let (a, b) = s.split_once(':')?;
        Some(Self { private: hex::decode(a).ok()?.try_into().ok()?, public: hex::decode(b).ok()?.try_into().ok()? })
    }
}

fn params(suite: &str) -> NoiseParams {
    suite.parse().expect("the suite constants are valid")
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// Pairing: IKpsk2 with the one-time PSK.
    Pairing,
    /// Reconnect: IK.
    Reconnect,
}

/// The 32-byte PSK of a pairing from its 128-bit one-time code.
pub fn psk_from_otp(otp: &[u8; 16]) -> [u8; 32] {
    let mut m = b"intely-remote/pair-psk/v1".to_vec();
    m.extend_from_slice(otp);
    sha256(&m)
}

/// The relay credential `pair.<token>` of a pairing, derived from the same code so the phone needs nothing else.
pub fn pair_token_from_otp(otp: &[u8; 16]) -> String {
    let mut m = b"intely-remote/pair-token/v1".to_vec();
    m.extend_from_slice(otp);
    crate::util::b64u(&sha256(&m))
}

pub struct Handshake {
    hs: HandshakeState,
    kind: Kind,
}

impl Handshake {
    pub fn initiator(kind: Kind, local: &StaticKey, mac_public: &[u8; 32], psk: Option<&[u8; 32]>) -> Result<Self> {
        let mut b = Builder::new(params(if kind == Kind::Pairing { SUITE_IKPSK2 } else { SUITE_IK }))
            .local_private_key(&local.private)?
            .remote_public_key(mac_public)?
            .prologue(PROLOGUE)?;
        if let Some(p) = psk {
            b = b.psk(2, p)?;
        }
        Ok(Self { hs: b.build_initiator()?, kind })
    }

    pub fn responder(kind: Kind, local: &StaticKey, psk: Option<&[u8; 32]>) -> Result<Self> {
        let mut b = Builder::new(params(if kind == Kind::Pairing { SUITE_IKPSK2 } else { SUITE_IK })).local_private_key(&local.private)?.prologue(PROLOGUE)?;
        if let Some(p) = psk {
            b = b.psk(2, p)?;
        }
        Ok(Self { hs: b.build_responder()?, kind })
    }

    pub fn write(&mut self, payload: &[u8]) -> Result<Vec<u8>> {
        let mut buf = vec![0u8; MAX_NOISE_MSG];
        let n = self.hs.write_message(payload, &mut buf)?;
        buf.truncate(n);
        Ok(buf)
    }

    /// Returns the (decrypted) payload of the message.
    pub fn read(&mut self, msg: &[u8]) -> Result<Vec<u8>> {
        if msg.len() > MAX_NOISE_MSG {
            return Err(RemoteError::Noise("message too long".into()));
        }
        let mut buf = vec![0u8; msg.len().max(1)];
        let n = self.hs.read_message(msg, &mut buf)?;
        buf.truncate(n);
        Ok(buf)
    }

    pub fn remote_static(&self) -> Option<[u8; 32]> {
        self.hs.get_remote_static().and_then(|k| k.try_into().ok())
    }

    pub fn is_finished(&self) -> bool {
        self.hs.is_handshake_finished()
    }

    /// The 6-digit code both screens show, derived from the handshake hash (final once both messages are processed).
    pub fn sas(&self) -> String {
        let mut m = b"intely-remote/sas/v1".to_vec();
        m.extend_from_slice(self.hs.get_handshake_hash());
        let h = sha256(&m);
        format!("{:06}", u32::from_be_bytes([h[0], h[1], h[2], h[3]]) % 1_000_000)
    }

    pub fn kind(&self) -> Kind {
        self.kind
    }

    pub fn into_transport(self) -> Result<Transport> {
        Ok(Transport { ts: self.hs.into_transport_mode()?, sent: 0, received: 0 })
    }
}

pub struct Transport {
    ts: TransportState,
    sent: u64,
    received: u64,
}

impl Transport {
    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>> {
        if plaintext.len() + 16 > MAX_NOISE_MSG {
            return Err(RemoteError::Noise("plaintext too long".into()));
        }
        let mut buf = vec![0u8; plaintext.len() + 16];
        let n = self.ts.write_message(plaintext, &mut buf)?;
        buf.truncate(n);
        self.sent += 1;
        if self.sent % REKEY_EVERY == 0 {
            self.ts.rekey_outgoing();
        }
        Ok(buf)
    }

    /// A frame that does not authenticate (garbage, replay, reorder, wrong session) is an error and leaves the state untouched.
    pub fn decrypt(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>> {
        if ciphertext.len() > MAX_NOISE_MSG || ciphertext.len() < 16 {
            return Err(RemoteError::Noise("bad frame length".into()));
        }
        let mut buf = vec![0u8; ciphertext.len()];
        let n = self.ts.read_message(ciphertext, &mut buf)?;
        buf.truncate(n);
        self.received += 1;
        if self.received % REKEY_EVERY == 0 {
            self.ts.rekey_incoming();
        }
        Ok(buf)
    }

    pub fn counters(&self) -> (u64, u64) {
        (self.sent, self.received)
    }
}

/// Frame tags on a link (the relay forwards them untouched; they are not secret).
pub mod tag {
    pub const PAIR_INIT: u8 = 1;
    pub const PAIR_RESP: u8 = 2;
    pub const IK_INIT: u8 = 3;
    pub const IK_RESP: u8 = 4;
    pub const DATA: u8 = 5;
    /// Mac -> phone, plaintext: "I have no session for this link" (the Mac restarted or the session was dropped); redo the handshake.
    pub const RESET: u8 = 6;
}

pub fn framed(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(body.len() + 1);
    v.push(tag);
    v.extend_from_slice(body);
    v
}

/// A random 128-bit one-time code.
pub fn new_otp() -> [u8; 16] {
    random::<16>()
}
