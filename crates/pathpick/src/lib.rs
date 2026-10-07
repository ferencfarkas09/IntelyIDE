//! Folder picker core ((design notes: workspaces-spec) section 5): path validation by file inspection (no git process),
//! read-only listing, one-time purpose-bound tokens, a bounded scan, and the pick backend chain. Tauri-free.
//!
//! The webview never makes Rust accept an unvalidated path: it receives [`types::Picked`] values with single-use tokens
//! and hands tokens (not paths) back to every command that registers a repository.

pub mod backend;
pub mod fsio;
pub mod fsops;
pub mod gitdir;
pub mod list;
#[cfg(feature = "osascript")]
pub mod osascript;
pub mod policy;
pub mod protected;
pub mod scan;
pub mod service;
pub mod tokens;
pub mod types;
pub mod validate;

pub use backend::{BackendChain, FakeBackend, NativeAnswer, NativeRequest, PickBackend};
pub use fsops::{FakeFs, FsOps, Guard, RealFs};
pub use policy::Policy;
pub use service::Picker;
pub use tokens::{FakeClock, PathTokens, Redeemed};
pub use types::*;
pub use validate::{Purpose, Validated, Validator};
