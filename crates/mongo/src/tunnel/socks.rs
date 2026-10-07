//! The server half of SOCKS5 (RFC 1928) with username/password authentication (RFC 1929) for the tunnel relay (T4b).
//!
//! Only what the relay needs: method 0x02, command CONNECT, address types IPv4 and domain name (IPv6 is read and reported
//! so the relay can answer `tunnel.ipv6`). Every read is exact and bounded; nothing here opens a socket, spawns a process
//! or looks at a secret other than through [`ct_eq`].

use std::io;
use std::net::Ipv4Addr;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const VERSION: u8 = 5;
pub const AUTH_VERSION: u8 = 1;
pub const METHOD_NONE: u8 = 0x00;
pub const METHOD_PASSWORD: u8 = 0x02;
pub const METHOD_UNACCEPTABLE: u8 = 0xFF;
pub const CMD_CONNECT: u8 = 0x01;

pub const ATYP_IPV4: u8 = 0x01;
pub const ATYP_DOMAIN: u8 = 0x03;
pub const ATYP_IPV6: u8 = 0x04;

/// Longest host name the relay accepts (DNS limit); a domain length byte above this is an oversize frame.
pub const MAX_DOMAIN: usize = 253;
/// The relay's own credentials are 32 hex characters; anything longer cannot match and is refused unread.
pub const MAX_CREDENTIAL: usize = 64;

/// Reply codes of RFC 1928 section 6.
pub mod reply {
    pub const SUCCEEDED: u8 = 0x00;
    pub const GENERAL_FAILURE: u8 = 0x01;
    pub const NOT_ALLOWED: u8 = 0x02;
    pub const NETWORK_UNREACHABLE: u8 = 0x03;
    pub const HOST_UNREACHABLE: u8 = 0x04;
    pub const CONNECTION_REFUSED: u8 = 0x05;
    pub const COMMAND_NOT_SUPPORTED: u8 = 0x07;
    pub const ADDRESS_TYPE_NOT_SUPPORTED: u8 = 0x08;
}

/// Why a handshake step failed. Carries no input text: the peer is not trusted.
#[derive(Debug)]
pub enum SocksError {
    /// The first byte of a message was not the expected protocol version.
    Version(u8),
    /// The greeting listed no usable method (or none at all).
    NoAcceptableMethod,
    /// The sub-negotiation failed: wrong version byte, empty or oversize field, or wrong credentials.
    Auth,
    /// A frame field exceeds its limit (domain length, credential length).
    Oversize,
    /// The request is malformed (reserved byte, empty or non-text domain).
    Malformed,
    /// A command other than CONNECT.
    Command(u8),
    /// An address type other than IPv4, domain or IPv6.
    AddressType(u8),
    Io(io::Error),
}

impl From<io::Error> for SocksError {
    fn from(e: io::Error) -> Self {
        SocksError::Io(e)
    }
}

impl SocksError {
    /// The reply code the relay sends for this failure (when a reply makes sense at that step).
    pub fn reply_code(&self) -> u8 {
        match self {
            SocksError::Command(_) => reply::COMMAND_NOT_SUPPORTED,
            SocksError::AddressType(_) => reply::ADDRESS_TYPE_NOT_SUPPORTED,
            _ => reply::GENERAL_FAILURE,
        }
    }
}

impl std::fmt::Display for SocksError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SocksError::Version(_) => f.write_str("unsupported SOCKS version"),
            SocksError::NoAcceptableMethod => f.write_str("no acceptable authentication method"),
            SocksError::Auth => f.write_str("authentication failed"),
            SocksError::Oversize => f.write_str("a SOCKS field is too long"),
            SocksError::Malformed => f.write_str("malformed SOCKS request"),
            SocksError::Command(_) => f.write_str("unsupported SOCKS command"),
            SocksError::AddressType(_) => f.write_str("unsupported SOCKS address type"),
            SocksError::Io(_) => f.write_str("SOCKS connection error"),
        }
    }
}

impl std::error::Error for SocksError {}

/// The destination a CONNECT request names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dest {
    /// A host name, exactly as sent (not yet validated).
    Name(String),
    Ipv4(Ipv4Addr),
    /// Read and discarded: the relay refuses IPv6.
    Ipv6,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub dest: Dest,
    pub port: u16,
}

/// Constant-time equality: the running time depends on the longer length only, never on where the bytes differ.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() ^ b.len()) as u64;
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= u64::from(x ^ y);
    }
    diff == 0
}

/// Reads the client greeting and returns its method list.
pub async fn read_greeting<R: AsyncRead + Unpin>(r: &mut R) -> Result<Vec<u8>, SocksError> {
    let mut head = [0u8; 2];
    r.read_exact(&mut head).await?;
    if head[0] != VERSION {
        return Err(SocksError::Version(head[0]));
    }
    if head[1] == 0 {
        return Err(SocksError::NoAcceptableMethod);
    }
    let mut methods = vec![0u8; head[1] as usize];
    r.read_exact(&mut methods).await?;
    Ok(methods)
}

/// Only username/password is acceptable; "no authentication" is never selected even when offered.
pub fn choose_method(methods: &[u8]) -> Option<u8> {
    methods.contains(&METHOD_PASSWORD).then_some(METHOD_PASSWORD)
}

pub async fn write_method<W: AsyncWrite + Unpin>(w: &mut W, method: Option<u8>) -> io::Result<()> {
    w.write_all(&[VERSION, method.unwrap_or(METHOD_UNACCEPTABLE)]).await?;
    w.flush().await
}

/// Reads the RFC 1929 request. Fields over [`MAX_CREDENTIAL`] are refused before their bytes are read.
pub async fn read_password_auth<R: AsyncRead + Unpin>(r: &mut R) -> Result<(Vec<u8>, Vec<u8>), SocksError> {
    let mut head = [0u8; 2];
    r.read_exact(&mut head).await?;
    if head[0] != AUTH_VERSION {
        return Err(SocksError::Auth);
    }
    let ulen = head[1] as usize;
    if ulen == 0 {
        return Err(SocksError::Auth);
    }
    if ulen > MAX_CREDENTIAL {
        return Err(SocksError::Oversize);
    }
    let mut user = vec![0u8; ulen];
    r.read_exact(&mut user).await?;
    let mut plen = [0u8; 1];
    r.read_exact(&mut plen).await?;
    let plen = plen[0] as usize;
    if plen == 0 {
        return Err(SocksError::Auth);
    }
    if plen > MAX_CREDENTIAL {
        return Err(SocksError::Oversize);
    }
    let mut pass = vec![0u8; plen];
    r.read_exact(&mut pass).await?;
    Ok((user, pass))
}

pub async fn write_auth_status<W: AsyncWrite + Unpin>(w: &mut W, ok: bool) -> io::Result<()> {
    w.write_all(&[AUTH_VERSION, if ok { 0 } else { 1 }]).await?;
    w.flush().await
}

/// Reads the request. A non-CONNECT command or an unknown address type is an error (the relay then answers 0x07 or
/// 0x08); an IPv6 destination is read to the end of the frame and returned as [`Dest::Ipv6`].
pub async fn read_request<R: AsyncRead + Unpin>(r: &mut R) -> Result<Request, SocksError> {
    let mut head = [0u8; 4];
    r.read_exact(&mut head).await?;
    if head[0] != VERSION {
        return Err(SocksError::Version(head[0]));
    }
    if head[2] != 0 {
        return Err(SocksError::Malformed);
    }
    if head[1] != CMD_CONNECT {
        return Err(SocksError::Command(head[1]));
    }
    let dest = match head[3] {
        ATYP_IPV4 => {
            let mut b = [0u8; 4];
            r.read_exact(&mut b).await?;
            Dest::Ipv4(Ipv4Addr::from(b))
        }
        ATYP_DOMAIN => {
            let mut len = [0u8; 1];
            r.read_exact(&mut len).await?;
            let len = len[0] as usize;
            if len == 0 {
                return Err(SocksError::Malformed);
            }
            if len > MAX_DOMAIN {
                return Err(SocksError::Oversize);
            }
            let mut name = vec![0u8; len];
            r.read_exact(&mut name).await?;
            Dest::Name(String::from_utf8(name).map_err(|_| SocksError::Malformed)?)
        }
        ATYP_IPV6 => {
            let mut b = [0u8; 16];
            r.read_exact(&mut b).await?;
            Dest::Ipv6
        }
        other => return Err(SocksError::AddressType(other)),
    };
    let mut port = [0u8; 2];
    r.read_exact(&mut port).await?;
    Ok(Request { dest, port: u16::from_be_bytes(port) })
}

/// A reply with the bound address `0.0.0.0:0` (the relay never reveals how it reached the target).
pub async fn write_reply<W: AsyncWrite + Unpin>(w: &mut W, code: u8) -> io::Result<()> {
    w.write_all(&[VERSION, code, 0, ATYP_IPV4, 0, 0, 0, 0, 0, 0]).await?;
    w.flush().await
}
