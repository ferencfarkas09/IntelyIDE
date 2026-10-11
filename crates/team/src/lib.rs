//! IntelyIDE Team (docs/team.md), phase T1: who is in the team and how they talk without the relay reading anything.
//! Tauri-free; `cargo test -p intely-team`.
//!
//! - [`identity`]: per-install Ed25519 (signatures) + X25519 (Noise) keys and the relay token, in the secret store.
//! - [`invite`]: the admin's one-time offer and the joiner's side of the `Noise_IKpsk2` handshake (6-digit SAS on both screens).
//! - [`keyring`] + [`envelope`]: team key epochs (XChaCha20-Poly1305) and the signed, replay-protected envelope.
//! - [`roster`]: the admin-signed member list; [`state`]: everything a member keeps, including revoke with key rotation.
//! - [`collab`]: notes into a teammate's run (T3) and workspace snapshots (T4); the only requests a teammate can make.
//! - [`audit`]: the team's own hash-chained log (reuses `intely_remote::audit`).
//! - [`wire`] + [`client`]: framing of what the relay forwards, and the WebSocket client (inherits the Remote host jail/trust).

pub mod audit;
pub mod client;
pub mod collab;
pub mod envelope;
pub mod error;
pub mod identity;
pub mod inbox;
pub mod invite;
pub mod keyring;
pub mod memsync;
pub mod project;
pub mod redact;
pub mod rekey;
pub mod roster;
pub mod share;
pub mod state;
pub mod wire;

pub use error::{Result, TeamError};
