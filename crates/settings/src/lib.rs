//! Tauri-free backend of the `settings` module: the versioned settings store, the secret store (webview-blind), and the
//! provider registry. Types that cross the IPC boundary live in `types` and are exported to `ui/src/bindings/settings.ts`
//! by `pnpm bindings`.

pub mod agents;
pub mod error;
pub mod events;
pub mod hash;
pub mod providers;
pub mod secrets;
pub mod store;
pub mod types;

pub use error::{code, SettingsError};
pub use providers::ProviderRegistry;
#[cfg(target_os = "macos")]
pub use secrets::{KeychainSecretStore, ScopedKeychainStore};
pub use secrets::{name_looks_secret, FallbackSecretStore, LegacyFallbackStore, MemorySecretStore, LEGACY_SERVICE, Secret, SecretStore, SecretsHealth};
pub use store::{Change, Object, SettingsStore};
