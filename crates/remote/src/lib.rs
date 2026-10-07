//! IntelyIDE Remote gateway ((design notes: remote-plan)): watch, answer and prompt agent runs from a phone over an outbound relay, with
//! Noise end-to-end encryption, device capabilities, an audit trail and a kill switch. Tauri-free; `cargo test -p intely-remote`.
//!
//! Zero cost when off: nothing in this crate runs until [`slot::RemoteSlot::enable`]; the slot then owns one thread, one
//! gateway task, one bus subscriber and one transport, and dropping them all is `disable`.

pub mod api;
pub mod audit;
pub mod devices;
pub mod error;
pub mod gateway;
pub mod identity;
pub mod limits;
pub mod noise;
pub mod pairing;
pub mod phone;
pub mod policy;
pub mod redact;
pub mod relay_ws;
pub mod runner;
pub mod slot;
pub mod stepup;
pub mod store;
pub mod transport;
pub mod util;
pub mod wire;

pub use error::{RemoteError, Result};
pub use slot::RemoteSlot;
