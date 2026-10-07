//! Provider-neutral agent layer, Tauri-free: normalized events, policy broker, enforcement chip,
//! sidecar wire messages (providers-plan sections 1, 3.1, 5). The process gate, Rewind and the git shim
//! live in the separate `intely-agent-gate` crate.

#[macro_use]
mod macros;

pub mod api;
pub mod bus;
pub mod delegates;
pub mod events;
pub mod hub;
pub mod mcp;
pub mod policy;
pub mod projection;
pub mod providers;
pub mod sidecar;
pub mod usage;

#[cfg(feature = "specta")]
pub mod export;
