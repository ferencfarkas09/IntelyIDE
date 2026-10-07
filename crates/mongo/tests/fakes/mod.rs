//! Docker-free network fakes (T14a): an in-process rustls "mongod" over an `rcgen` chain, a plain-TCP server, a closed
//! port, a silent listener, a resetting listener and a SOCKS5 listener in front of the TLS server. Loopback only; the
//! servers answer just enough of the wire protocol (OP_MSG and the legacy OP_QUERY handshake) for `ping`, `hello`,
//! `buildInfo` and `connectionStatus`. Nothing here touches the real network, Docker or a real `mongod`.
#![allow(dead_code)]

pub mod certs;
pub mod servers;
pub mod socks;
