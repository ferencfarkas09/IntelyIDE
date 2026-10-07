//! IntelyIDE relay bundle ((design notes: remote-cloudflare-spec) 4.5, 4.8): stages and signs the phone PWA bundle in Rust, generates the
//! signing and VAPID keys, and checks a deployed relay. Tauri-free; `cargo test -p intely-relay-bundle`.
//!
//! Zero cost when off: no thread, socket or timer exists here between calls. Local files and plain HTTPS GETs only; this crate never
//! spawns a process (wrangler included) and never writes a key to disk.

pub mod audit;
pub mod error;
pub mod manifest;
pub mod net;
pub mod sign;
pub mod stage;
pub mod vapid;

pub use audit::{
    check_relay, check_relay_with, BundleVerdict, Expected, Http, HttpFuture, HttpRequest, HttpResponse, MacCredential, RelayCheck,
};
pub use error::{BundleError, Result};
pub use intely_settings::secrets::Secret;
pub use net::ReqwestHttp;
pub use sign::{
    fingerprint, generate_signing_key, public_key_of, stage_and_sign, stage_and_sign_with, verify_staged, SignOptions, Staged, StagedBundle,
};
pub use stage::Limits;
pub use vapid::{generate_vapid, public_from_private, VapidKeys};
