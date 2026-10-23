//! The registry client: what the app tells the owner's registry (a Cloudflare Worker, `registry/` in this repository) after a
//! person agreed on the first-start screen. Name and email, the newsletter choice, and the details of this computer (a fingerprint
//! hash, system, architecture, cores, memory, language, time zone, app version). Nothing is sent before the agreement, and the
//! person can look at what is stored and delete it from Settings.
//!
//! The only door is [`client::Client`]: https (or loopback http for tests), no redirects, a `(method, path)` allow-list, a response
//! cap. The token the registry returns lives in the Keychain. Tauri glue: `src-tauri/src/modules/registry.rs`.

pub mod client;
pub mod device;
pub mod service;
pub mod types;

pub use client::Client;
pub use service::Registry;
pub use types::{Problem, RegisterInput, State, Status, NOTICE, REGISTRY_URL};
