//! What travels inside the relay's opaque `p` field: one tag byte, then the body, all base64url. The relay never looks at it.

use intely_remote::util::{b64u, b64u_decode};

use crate::error::{Result, TeamError};

pub mod tag {
    /// Joiner -> admin: Noise IKpsk2 message 1.
    pub const JOIN_INIT: u8 = 1;
    /// Admin -> joiner: Noise IKpsk2 message 2.
    pub const JOIN_RESP: u8 = 2;
    /// Admin -> joiner: the welcome (keys + signed roster), inside the Noise transport.
    pub const WELCOME: u8 = 3;
    /// Admin -> member: a new epoch key + the new signed roster (Noise_X).
    pub const REKEY: u8 = 4;
    /// Member -> members: a signed, encrypted [`crate::envelope::Envelope`].
    pub const ENVELOPE: u8 = 5;
    /// Joiner -> admin: the first Noise transport message, which proves the joiner holds the code.
    pub const JOIN_HELLO: u8 = 6;
}

pub fn frame(tag: u8, body: &[u8]) -> String {
    let mut v = Vec::with_capacity(body.len() + 1);
    v.push(tag);
    v.extend_from_slice(body);
    b64u(&v)
}

pub fn unframe(p: &str) -> Result<(u8, Vec<u8>)> {
    let b = b64u_decode(p).ok_or_else(|| TeamError::Invalid("payload is not base64url".into()))?;
    match b.split_first() {
        Some((t, rest)) => Ok((*t, rest.to_vec())),
        None => Err(TeamError::Invalid("empty payload".into())),
    }
}
