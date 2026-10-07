//! MongoDB Studio core. Tauri-free. Everything that needs no server compiles without the `mongo` feature (no driver,
//! no TLS stack): the closed read-only command set, the mongosh literal parser, URI/host classification, profiles with
//! the tamper check, the audit log, the validators, the explain walker and the AI reply validator. The driver and the
//! gateway ([`studio::Studio`]) sit behind feature `mongo`.
//!
//! Read-only by construction: [`types::ReadCommand`] has no write variant and the gateway offers no raw command.

pub mod ai;
pub mod api;
pub mod audit;
pub mod connspec;
pub mod connstring;
pub mod diagnose;
pub mod digest;
pub mod error;
pub mod exchange;
pub mod explain;
pub mod host;
pub mod jail;
pub mod presets;
pub mod profile;
pub mod shell;
pub mod types;
pub mod validate;

#[cfg(feature = "mongo")]
pub mod driver;
#[cfg(feature = "mongo")]
pub mod studio;
#[cfg(all(feature = "mongo", unix))]
pub mod gate;
#[cfg(all(feature = "mongo", unix))]
pub mod tunnel;
#[cfg(feature = "mongo")]
pub mod vault;

pub use types::{ReadCommand, DEFAULT_MAX_TIME_MS, MAX_BYTES, MAX_DOCS};
