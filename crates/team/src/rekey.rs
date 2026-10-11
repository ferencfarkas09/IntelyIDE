//! Hand-over of a new epoch key to one remaining member: `Noise_X` (the admin's static key is authenticated to the recipient, the
//! ephemeral gives the sender forward secrecy). One message, no round trip, so it can wait in the relay's queue for an offline member.

use intely_remote::noise::StaticKey;
use snow::Builder;

use crate::error::{Result, TeamError};

const SUITE: &str = "Noise_X_25519_ChaChaPoly_SHA256";
const PROLOGUE: &[u8] = b"intely-team\x00rekey\x00v1";

fn builder() -> Builder<'static> {
    Builder::new(SUITE.parse().expect("the suite constant is valid"))
}

pub fn seal(sender: &StaticKey, recipient_public: &[u8; 32], payload: &[u8]) -> Result<Vec<u8>> {
    let mut hs = builder().local_private_key(&sender.private)?.remote_public_key(recipient_public)?.prologue(PROLOGUE)?.build_initiator()?;
    let mut buf = vec![0u8; 65_535];
    let n = hs.write_message(payload, &mut buf)?;
    buf.truncate(n);
    Ok(buf)
}

/// Returns the sender's authenticated static key and the payload.
pub fn open(recipient: &StaticKey, msg: &[u8]) -> Result<([u8; 32], Vec<u8>)> {
    let mut hs = builder().local_private_key(&recipient.private)?.prologue(PROLOGUE)?.build_responder()?;
    let mut buf = vec![0u8; msg.len().max(1)];
    let n = hs.read_message(msg, &mut buf).map_err(|_| TeamError::Crypto("rekey message does not authenticate".into()))?;
    buf.truncate(n);
    let sender: [u8; 32] = hs.get_remote_static().and_then(|k| k.try_into().ok()).ok_or_else(|| TeamError::Crypto("rekey has no sender key".into()))?;
    Ok((sender, buf))
}
