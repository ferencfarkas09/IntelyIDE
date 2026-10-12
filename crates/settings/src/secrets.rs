//! Secret storage. The webview can only ask `has`, `set` and `remove`; `get` exists for Rust-side consumers (a native
//! provider adapter) and is not exposed over IPC. Values are wrapped in [`Secret`], which never prints itself.
//!
//! Tests and the E2E/READONLY jails use [`MemorySecretStore`]; [`KeychainSecretStore`] talks to the macOS Keychain and is
//! only constructed on an explicit user action path (dev builds can trigger Keychain permission dialogs).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::time::Duration;

use crate::error::{code, Result, SettingsError};

/// A secret value. `Debug` and `Display` print a placeholder, so it cannot leak through logs or error formatting.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([redacted])")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted]")
    }
}

pub trait SecretStore: Send + Sync {
    fn has(&self, key: &str) -> Result<bool>;
    fn set(&self, key: &str, value: Secret) -> Result<()>;
    /// Removing a key that does not exist is not an error.
    fn remove(&self, key: &str) -> Result<()>;
    /// Rust-side only; never reachable from the webview.
    fn get(&self, key: &str) -> Result<Option<Secret>>;
    /// Where the secrets live right now and whether the preferred place failed (see [`FallbackSecretStore`]).
    fn health(&self) -> SecretsHealth {
        SecretsHealth { backend: "memory", degraded: false, message: None }
    }
    /// Forgets a remembered failure so the preferred backend is tried again (the user fixed the Keychain access).
    fn retry(&self) {}
    /// False while a first, slow call (the vault load with its dialogs) is still ahead; [`FallbackSecretStore`] then waits longer.
    fn is_warm(&self) -> bool {
        true
    }
    /// The keys that exist, from attributes only: no secret is read, so no Keychain prompt. Stores that cannot list say none.
    fn keys(&self) -> Result<Vec<String>> {
        Ok(Vec::new())
    }
}

/// What the Settings UI shows next to the secret fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretsHealth {
    /// `keychain` or `memory`: where a secret entered now would be stored.
    pub backend: &'static str,
    /// The Keychain failed and the in-memory store took over; secrets entered now are gone after a restart.
    pub degraded: bool,
    /// A clear, user-readable explanation and what to do about it.
    pub message: Option<String>,
}

/// Key of a provider's API key (plan 4.2: `<providerId>:<profile>`).
pub fn provider_key(provider_id: &str) -> String {
    format!("providers.{provider_id}:default")
}

/// Keys are short ASCII identifiers (`providers.openai:default`, `happy.token`); anything else is refused so a key can
/// never carry a path, a URL or free text.
pub fn validate_key(key: &str) -> Result<()> {
    let ok = !key.is_empty()
        && key.len() <= 128
        && key.starts_with(|c: char| c.is_ascii_alphanumeric())
        && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
    ok.then_some(()).ok_or_else(|| SettingsError::new(code::INVALID_KEY, "a secret key is 1 to 128 characters of letters, digits and . _ : -"))
}

#[derive(Default)]
pub struct MemorySecretStore {
    items: Mutex<HashMap<String, Secret>>,
}

impl MemorySecretStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl fmt::Debug for MemorySecretStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut keys: Vec<_> = self.items.lock().unwrap_or_else(PoisonError::into_inner).keys().cloned().collect();
        keys.sort();
        f.debug_struct("MemorySecretStore").field("keys", &keys).finish()
    }
}

impl SecretStore for MemorySecretStore {
    fn has(&self, key: &str) -> Result<bool> {
        validate_key(key)?;
        Ok(self.items.lock().unwrap_or_else(PoisonError::into_inner).contains_key(key))
    }

    fn set(&self, key: &str, value: Secret) -> Result<()> {
        validate_key(key)?;
        self.items.lock().unwrap_or_else(PoisonError::into_inner).insert(key.to_owned(), value);
        Ok(())
    }

    fn remove(&self, key: &str) -> Result<()> {
        validate_key(key)?;
        self.items.lock().unwrap_or_else(PoisonError::into_inner).remove(key);
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<Secret>> {
        validate_key(key)?;
        Ok(self.items.lock().unwrap_or_else(PoisonError::into_inner).get(key).cloned())
    }

    fn keys(&self) -> Result<Vec<String>> {
        Ok(self.items.lock().unwrap_or_else(PoisonError::into_inner).keys().cloned().collect())
    }
}

/// Keychain service name used by versions before 1.0 (the development-era bundle identifier). Read only: items found
/// here are copied to [`SERVICE`] and never deleted by a read.
pub const LEGACY_SERVICE: &str = "hu.happygastro.intelyswitchide";

/// A store under the current name with a read-only fallback to the store under the legacy name.
/// `get` asks `current` first; on a miss it asks `legacy`, copies a hit to `current` (best effort: a failed copy is
/// ignored and the value is still returned) and returns it. A read never deletes anything from `legacy`.
/// `has` sees both. `set` writes `current` only. `remove` removes from both, so a deleted secret cannot come back from
/// the legacy item. A failing legacy lookup counts as a miss: it must not break the current store.
pub struct LegacyFallbackStore {
    current: Arc<dyn SecretStore>,
    legacy: Arc<dyn SecretStore>,
}

impl LegacyFallbackStore {
    pub fn new(current: Arc<dyn SecretStore>, legacy: Arc<dyn SecretStore>) -> Self {
        Self { current, legacy }
    }
}

impl fmt::Debug for LegacyFallbackStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LegacyFallbackStore")
    }
}

impl SecretStore for LegacyFallbackStore {
    fn has(&self, key: &str) -> Result<bool> {
        validate_key(key)?;
        if self.current.has(key)? {
            return Ok(true);
        }
        Ok(self.legacy.has(key).unwrap_or(false))
    }

    fn set(&self, key: &str, value: Secret) -> Result<()> {
        self.current.set(key, value)
    }

    fn remove(&self, key: &str) -> Result<()> {
        validate_key(key)?;
        let current = self.current.remove(key);
        let legacy = self.legacy.remove(key);
        current.and(legacy)
    }

    fn get(&self, key: &str) -> Result<Option<Secret>> {
        validate_key(key)?;
        if let Some(found) = self.current.get(key)? {
            return Ok(Some(found));
        }
        let Ok(Some(found)) = self.legacy.get(key) else { return Ok(None) };
        let _ = self.current.set(key, found.clone());
        Ok(Some(found))
    }

    fn health(&self) -> SecretsHealth {
        self.current.health()
    }
}

/// Keychain account of the single item that holds every secret (see [`VaultStore`]).
pub const VAULT_ACCOUNT: &str = "vault";
/// Entry of the vault that lists the keys taken over from legacy items. It starts with `_`, which no secret key may.
const MIGRATED: &str = "_migrated";

#[derive(Default)]
struct VaultState {
    map: BTreeMap<String, String>,
    /// Keys whose legacy item was read once (or whose secret was removed): that item is never read again.
    migrated: BTreeSet<String>,
}

/// All secrets in ONE backend item (a JSON map key -> value), loaded once per process into memory and written back as a
/// whole on every change. macOS asks for permission per Keychain item, so one item means at most one prompt per launch
/// (none after "Always Allow"), instead of one per secret.
///
/// The first load also migrates: the keys the `legacy` stores list (attributes only, no prompt, so only items that exist
/// are asked about) are read once, merged into the vault, and recorded in the vault's `_migrated` list so the legacy item
/// is never read again. The vault is written after EACH item, so quitting half way keeps the progress. Legacy items are NOT
/// deleted (a delete could prompt a second time); a later, explicit cleanup may remove them. A key already in the vault or
/// in the list is not read. The first store listing a key wins.
///
/// If reading an existing legacy item fails (denied, locked), the whole load fails and nothing is cached: callers see
/// "Keychain unavailable", never "secret missing", so no caller can create a replacement that would shadow the old secret.
/// The next launch asks again.
///
/// Every write re-reads the vault item and applies only its own change to it, so two processes (or instances) do not
/// overwrite each other's keys.
pub struct VaultStore {
    vault: Arc<dyn SecretStore>,
    legacy: Vec<Arc<dyn SecretStore>>,
    cache: Mutex<Option<VaultState>>,
    loaded: AtomicBool,
}

impl VaultStore {
    /// `vault` holds the one item under [`VAULT_ACCOUNT`]; `legacy` are searched newest first.
    pub fn new(vault: Arc<dyn SecretStore>, legacy: Vec<Arc<dyn SecretStore>>) -> Self {
        Self { vault, legacy, cache: Mutex::new(None), loaded: AtomicBool::new(false) }
    }

    fn read_stored(&self) -> Result<VaultState> {
        let mut map: BTreeMap<String, String> = match self.vault.get(VAULT_ACCOUNT)? {
            Some(s) => serde_json::from_str(s.expose()).map_err(|_| SettingsError::new(code::KEYCHAIN, "the stored secrets are not readable; they were left untouched"))?,
            None => BTreeMap::new(),
        };
        let migrated = map.remove(MIGRATED).and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
        Ok(VaultState { map, migrated })
    }

    /// Re-reads the vault item, applies the one change (`value` None removes the key; `mark` records the key as migrated),
    /// writes it, and only then replaces the cache.
    fn commit(&self, st: &mut VaultState, key: &str, value: Option<String>, mark: bool) -> Result<()> {
        let mut next = self.read_stored()?;
        next.migrated.extend(st.migrated.iter().cloned());
        if mark {
            next.migrated.insert(key.to_owned());
        }
        match value {
            Some(v) => next.map.insert(key.to_owned(), v),
            None => next.map.remove(key),
        };
        let mut all = next.map.clone();
        if !next.migrated.is_empty() {
            all.insert(MIGRATED.to_owned(), serde_json::to_string(&next.migrated).unwrap_or_default());
        }
        let json = serde_json::to_string(&all).map_err(|_| SettingsError::new(code::KEYCHAIN, "the secrets could not be serialised"))?;
        self.vault.set(VAULT_ACCOUNT, Secret::new(json))?;
        *st = next;
        Ok(())
    }

    /// Reads the vault item and merges in the legacy items. Called once per process (until it succeeds).
    fn load(&self) -> Result<VaultState> {
        let mut st = self.read_stored()?;
        for store in &self.legacy {
            for key in store.keys()?.into_iter().filter(|k| k != VAULT_ACCOUNT && validate_key(k).is_ok()) {
                if st.map.contains_key(&key) || st.migrated.contains(&key) {
                    continue;
                }
                // A failing read of an item that exists ends the load (see the type docs).
                if let Some(found) = store.get(&key)? {
                    let value = found.expose().to_owned();
                    // If the write fails the value still serves from memory; it is not recorded, so the next launch asks again.
                    if self.commit(&mut st, &key, Some(value.clone()), true).is_err() {
                        st.map.insert(key, value);
                    }
                }
            }
        }
        Ok(st)
    }

    fn with_state<T>(&self, f: impl FnOnce(&mut VaultState) -> Result<T>) -> Result<T> {
        let mut guard = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        if guard.is_none() {
            *guard = Some(self.load()?);
            self.loaded.store(true, Ordering::SeqCst);
        }
        f(guard.as_mut().expect("loaded above"))
    }

    /// Loads the vault now (the one prompt) instead of at the first secret read.
    pub fn warm(&self) -> Result<()> {
        self.with_state(|_| Ok(()))
    }
}

impl fmt::Debug for VaultStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("VaultStore")
    }
}

impl SecretStore for VaultStore {
    /// From the cache once loaded. Before that, while no vault item exists yet, from the attribute listings of the legacy
    /// stores (no secret is read, no prompt). Only when a vault item exists does it have to be read, which is the one prompt.
    fn has(&self, key: &str) -> Result<bool> {
        validate_key(key)?;
        if !self.loaded.load(Ordering::SeqCst) && !self.vault.has(VAULT_ACCOUNT)? {
            return Ok(self.legacy.iter().any(|s| s.keys().is_ok_and(|k| k.iter().any(|x| x == key))));
        }
        self.with_state(|s| Ok(s.map.contains_key(key)))
    }

    fn set(&self, key: &str, value: Secret) -> Result<()> {
        validate_key(key)?;
        self.with_state(|s| self.commit(s, key, Some(value.expose().to_owned()), false))
    }

    fn remove(&self, key: &str) -> Result<()> {
        validate_key(key)?;
        self.with_state(|s| {
            // Also recorded as migrated, so a legacy item of this name cannot bring the secret back.
            if !s.map.contains_key(key) && s.migrated.contains(key) {
                return Ok(());
            }
            self.commit(s, key, None, true)
        })
    }

    fn get(&self, key: &str) -> Result<Option<Secret>> {
        validate_key(key)?;
        self.with_state(|s| Ok(s.map.get(key).map(|v| Secret::new(v.as_str()))))
    }

    fn health(&self) -> SecretsHealth {
        self.vault.health()
    }

    fn keys(&self) -> Result<Vec<String>> {
        self.with_state(|s| Ok(s.map.keys().cloned().collect()))
    }

    fn is_warm(&self) -> bool {
        self.loaded.load(Ordering::SeqCst)
    }
}

/// Keychain services of the Mongo connections (current and 0.x name); their items are migrated into the vault too.
pub const MONGO_SERVICE: &str = "com.intelyhome.intelyide.mongo";
pub const LEGACY_MONGO_SERVICE: &str = "hu.happygastro.intelyswitchide.mongo";

pub use keychain::{KeychainSecretStore, ScopedKeychainStore, SERVICE};

mod keychain {
    use std::sync::{Arc, OnceLock};

    use super::{LegacyFallbackStore, Secret, SecretStore, SecretsHealth, VaultStore, LEGACY_MONGO_SERVICE, LEGACY_SERVICE, MONGO_SERVICE};
    use crate::error::Result;
    use backend::{get, has, keys, remove, set};
    #[cfg(all(target_os = "macos", test))]
    pub use backend::keychain_message;

    /// One Keychain service for the whole IDE; one generic-password item per key (account = key).
    /// Items stored by earlier versions under [`LEGACY_SERVICE`] are read once and copied here.
    pub const SERVICE: &str = "com.intelyhome.intelyide";

    /// Holds no state; every call goes to the user's Keychain.
    #[derive(Debug, Default, Clone, Copy)]
    pub struct KeychainSecretStore;

    /// The same store under another service name, for the manual Keychain test (`tests/keychain.rs`), which must never
    /// touch the items of the real IDE.
    #[derive(Debug, Clone)]
    pub struct ScopedKeychainStore {
        service: String,
        legacy: Option<String>,
    }

    /// The raw Keychain under one service name, with no migration.
    #[derive(Debug, Clone)]
    struct RawKeychain {
        service: String,
    }

    fn raw(service: &str) -> Arc<dyn SecretStore> {
        Arc::new(RawKeychain { service: service.to_owned() })
    }

    impl ScopedKeychainStore {
        pub fn new(service: impl Into<String>) -> Self {
            Self { service: service.into(), legacy: None }
        }

        /// Like [`Self::new`], with a read-only fallback to the items of an older service name (see [`LegacyFallbackStore`]).
        pub fn with_legacy(service: impl Into<String>, legacy: impl Into<String>) -> Self {
            Self { service: service.into(), legacy: Some(legacy.into()) }
        }

        fn store(&self) -> Arc<dyn SecretStore> {
            match &self.legacy {
                Some(legacy) => Arc::new(LegacyFallbackStore::new(raw(&self.service), raw(legacy))),
                None => raw(&self.service),
            }
        }

        pub fn service(&self) -> &str {
            &self.service
        }
    }

    /// The macOS Keychain (generic-password items, account = key).
    #[cfg(target_os = "macos")]
    mod backend {
        use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
        use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

        use super::super::{validate_key, Secret};
        use crate::error::{code, Result, SettingsError};

        const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

        /// A message the user can act on, by OSStatus. The raw status stays in `detail`.
        pub fn keychain_message(status: i32) -> &'static str {
            match status {
                -128 => "Keychain access was cancelled or denied. Choose \"Always Allow\" in the macOS dialog, or allow IntelyIDE in Keychain Access, and try again.",
                -25293 => "The Keychain rejected the authorisation. Unlock the login keychain (Keychain Access) and try again.",
                -25308 => "The Keychain is locked or cannot show its dialog right now. Unlock the login keychain and try again.",
                -34018 => "This development build is not signed for Keychain access (ad-hoc signature, no entitlement), so macOS refuses it. Secrets are kept in memory for this session.",
                -25291 | -25295 => "No usable Keychain was found (login keychain missing or unavailable).",
                _ => "The macOS Keychain refused the request.",
            }
        }

        fn keychain_error(e: security_framework::base::Error) -> SettingsError {
            SettingsError::new(code::KEYCHAIN, keychain_message(e.code())).with_detail(format!("OSStatus {}", e.code()))
        }

        pub fn has(service: &str, key: &str) -> Result<bool> {
            validate_key(key)?;
            // Attributes only: the secret data is not read, so no access prompt for the item.
            match ItemSearchOptions::new().class(ItemClass::generic_password()).service(service).account(key).load_attributes(true).search() {
                Ok(found) => Ok(!found.is_empty()),
                Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(false),
                Err(e) => Err(keychain_error(e)),
            }
        }

        /// The accounts of a service from attributes only (no secret data is read, so no access prompt).
        pub fn keys(service: &str) -> Result<Vec<String>> {
            match ItemSearchOptions::new().class(ItemClass::generic_password()).service(service).load_attributes(true).limit(Limit::All).search() {
                Ok(found) => Ok(found.iter().filter_map(|r| r.simplify_dict()).filter_map(|d| d.get("acct").cloned()).collect()),
                Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(Vec::new()),
                Err(e) => Err(keychain_error(e)),
            }
        }

        pub fn set(service: &str, key: &str, value: Secret) -> Result<()> {
            validate_key(key)?;
            set_generic_password(service, key, value.expose().as_bytes()).map_err(keychain_error)
        }

        pub fn remove(service: &str, key: &str) -> Result<()> {
            validate_key(key)?;
            match delete_generic_password(service, key) {
                Err(e) if e.code() != ERR_SEC_ITEM_NOT_FOUND => Err(keychain_error(e)),
                _ => Ok(()),
            }
        }

        pub fn get(service: &str, key: &str) -> Result<Option<Secret>> {
            validate_key(key)?;
            match get_generic_password(service, key) {
                Ok(bytes) => String::from_utf8(bytes)
                    .map(|s| Some(Secret::new(s)))
                    .map_err(|_| SettingsError::new(code::KEYCHAIN, "the stored secret is not valid UTF-8")),
                Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
                Err(e) => Err(keychain_error(e)),
            }
        }
    }

    /// Windows Credential Manager and the Secret Service (GNOME Keyring, KWallet) through `keyring-core`: one generic item per
    /// (service, key). The Secret Service has no size limit. Credential Manager caps a blob at 2560 bytes (stored as UTF-16, so
    /// 1280 characters), and the vault is one JSON map of every secret: a value longer than [`CHUNK`] characters is split over
    /// the items `key`, `key.1`, `key.2`, ... and `key` holds a `\u{1}chunks:<n>` marker instead. Reads join the pieces; a value
    /// that shrank leaves no stale piece behind (`set` removes the pieces beyond the new count).
    #[cfg(not(target_os = "macos"))]
    mod backend {
        use std::sync::OnceLock;

        use keyring_core::{Entry, Error as KeyError};

        use super::super::{validate_key, Secret};
        use crate::error::{code, Result, SettingsError};

        /// Characters per Credential Manager item: far below the 1280-character limit, so multi-byte text still fits.
        const CHUNK: usize = 600;
        const MARKER: &str = "\u{1}chunks:";
        /// Pieces a value may have (600 * 64 = 38 KB of secrets).
        const MAX_CHUNKS: usize = 64;

        fn store_error(e: KeyError) -> SettingsError {
            let message = match &e {
                KeyError::NoStorageAccess(_) | KeyError::PlatformFailure(_) => {
                    if cfg!(windows) {
                        "Windows Credential Manager refused the request."
                    } else {
                        "No Secret Service was found or it is locked. Start GNOME Keyring or KWallet and unlock it, then try again."
                    }
                }
                KeyError::TooLong(..) => "A secret is too long for the credential store.",
                _ => "The credential store refused the request.",
            };
            SettingsError::new(code::KEYCHAIN, message).with_detail(e.to_string())
        }

        /// Installs the credential store of the OS once. A failure is kept and reported on every call.
        fn ready() -> Result<()> {
            static STORE: OnceLock<std::result::Result<(), String>> = OnceLock::new();
            let state = STORE.get_or_init(|| {
                #[cfg(windows)]
                let built = windows_native_keyring_store::Store::new();
                #[cfg(not(windows))]
                let built = zbus_secret_service_keyring_store::Store::new();
                match built {
                    Ok(store) => {
                        keyring_core::set_default_store(store);
                        Ok(())
                    }
                    Err(e) => Err(e.to_string()),
                }
            });
            state.clone().map_err(|d| SettingsError::new(code::KEYCHAIN, "The credential store of this system is not available.").with_detail(d))
        }

        fn entry(service: &str, account: &str) -> Result<Entry> {
            ready()?;
            Entry::new(service, account).map_err(store_error)
        }

        fn read_one(service: &str, account: &str) -> Result<Option<String>> {
            match entry(service, account)?.get_password() {
                Ok(v) => Ok(Some(v)),
                Err(KeyError::NoEntry) => Ok(None),
                Err(e) => Err(store_error(e)),
            }
        }

        fn delete_one(service: &str, account: &str) -> Result<()> {
            match entry(service, account)?.delete_credential() {
                Ok(()) | Err(KeyError::NoEntry) => Ok(()),
                Err(e) => Err(store_error(e)),
            }
        }

        fn piece(key: &str, n: usize) -> String {
            format!("{key}.{n}")
        }

        fn pieces_of(head: &str) -> Option<usize> {
            head.strip_prefix(MARKER).and_then(|n| n.parse().ok()).filter(|n| (1..=MAX_CHUNKS).contains(n))
        }

        pub fn has(service: &str, key: &str) -> Result<bool> {
            validate_key(key)?;
            Ok(read_one(service, key)?.is_some())
        }

        /// The accounts of a service. Not enumerated: the only caller is the migration from earlier per-secret items, which never
        /// existed on these systems, so the list is empty.
        pub fn keys(_service: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }

        pub fn set(service: &str, key: &str, value: Secret) -> Result<()> {
            validate_key(key)?;
            let text = value.expose();
            let old = read_one(service, key)?.as_deref().and_then(pieces_of).unwrap_or(0);
            let chars: Vec<char> = text.chars().collect();
            let new = if !cfg!(windows) || chars.len() <= CHUNK {
                entry(service, key)?.set_password(text).map_err(store_error)?;
                0
            } else {
                let parts: Vec<String> = chars.chunks(CHUNK).map(|c| c.iter().collect()).collect();
                if parts.len() > MAX_CHUNKS {
                    return Err(SettingsError::new(code::KEYCHAIN, "A secret is too long for the credential store."));
                }
                for (i, part) in parts.iter().enumerate() {
                    entry(service, &piece(key, i + 1))?.set_password(part).map_err(store_error)?;
                }
                // the head last: a reader never sees a marker whose pieces are not there yet
                entry(service, key)?.set_password(&format!("{MARKER}{}", parts.len())).map_err(store_error)?;
                parts.len()
            };
            for n in (new + 1)..=old {
                delete_one(service, &piece(key, n))?;
            }
            Ok(())
        }

        pub fn remove(service: &str, key: &str) -> Result<()> {
            validate_key(key)?;
            let old = read_one(service, key)?.as_deref().and_then(pieces_of).unwrap_or(0);
            delete_one(service, key)?;
            for n in 1..=old {
                delete_one(service, &piece(key, n))?;
            }
            Ok(())
        }

        pub fn get(service: &str, key: &str) -> Result<Option<Secret>> {
            validate_key(key)?;
            let Some(head) = read_one(service, key)? else { return Ok(None) };
            let Some(count) = pieces_of(&head) else { return Ok(Some(Secret::new(head))) };
            let mut whole = String::new();
            for n in 1..=count {
                match read_one(service, &piece(key, n))? {
                    Some(p) => whole.push_str(&p),
                    None => return Err(SettingsError::new(code::KEYCHAIN, "A stored secret is incomplete; enter it again.")),
                }
            }
            Ok(Some(Secret::new(whole)))
        }
    }

    macro_rules! keychain_store {
        ($ty:ty, |$s:ident| $svc:expr) => {
            impl SecretStore for $ty {
                fn has(&self, key: &str) -> Result<bool> {
                    let $s = self;
                    has($svc, key)
                }
                fn set(&self, key: &str, value: Secret) -> Result<()> {
                    let $s = self;
                    set($svc, key, value)
                }
                fn remove(&self, key: &str) -> Result<()> {
                    let $s = self;
                    remove($svc, key)
                }
                fn get(&self, key: &str) -> Result<Option<Secret>> {
                    let $s = self;
                    get($svc, key)
                }
                fn health(&self) -> SecretsHealth {
                    SecretsHealth { backend: "keychain", degraded: false, message: None }
                }
                fn keys(&self) -> Result<Vec<String>> {
                    let $s = self;
                    keys($svc)
                }
            }
        };
    }

    keychain_store!(RawKeychain, |store| store.service.as_str());

    macro_rules! delegating_store {
        ($ty:ty, |$s:ident| $inner:expr) => {
            impl SecretStore for $ty {
                fn has(&self, key: &str) -> Result<bool> {
                    let $s = self;
                    $inner.has(key)
                }
                fn set(&self, key: &str, value: Secret) -> Result<()> {
                    let $s = self;
                    $inner.set(key, value)
                }
                fn remove(&self, key: &str) -> Result<()> {
                    let $s = self;
                    $inner.remove(key)
                }
                fn get(&self, key: &str) -> Result<Option<Secret>> {
                    let $s = self;
                    $inner.get(key)
                }
                fn health(&self) -> SecretsHealth {
                    SecretsHealth { backend: "keychain", degraded: false, message: None }
                }
                fn is_warm(&self) -> bool {
                    let $s = self;
                    $inner.is_warm()
                }
            }
        };
    }

    /// The one vault of the process: item `vault` of [`SERVICE`]. The per-secret items of earlier versions (ad-hoc builds,
    /// the 0.x names, the Mongo services) are copied into it on the first load and left in place.
    fn shared_vault() -> &'static VaultStore {
        static VAULT: OnceLock<VaultStore> = OnceLock::new();
        VAULT.get_or_init(|| {
            VaultStore::new(raw(SERVICE), vec![raw(SERVICE), raw(LEGACY_SERVICE), raw(MONGO_SERVICE), raw(LEGACY_MONGO_SERVICE)])
        })
    }

    delegating_store!(KeychainSecretStore, |_store| shared_vault());
    delegating_store!(ScopedKeychainStore, |store| store.store());
}

/// How long a Keychain call may take before the in-memory store takes over. A macOS permission dialog that nobody
/// answers (or one hidden behind another window) blocks the call, and the settings screen must not hang with it.
pub const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(20);

/// The first call into a store that is not warm yet (the vault load, which may show a dialog per old item) may take this long.
pub const WARM_TIMEOUT: Duration = Duration::from_secs(600);

/// The preferred store (the Keychain) with an in-memory store behind it. The first failure of the preferred store
/// (access denied, a dev build the OS does not trust, a dialog nobody answered, a locked keychain) is remembered: from
/// then on every call is served from memory, so a refusal costs one dialog, not one per call, and nothing crashes.
/// [`SecretStore::health`] carries the explanation for the UI; [`SecretStore::retry`] tries the Keychain again.
pub struct FallbackSecretStore {
    primary: Arc<dyn SecretStore>,
    memory: MemorySecretStore,
    timeout: Duration,
    degraded: Mutex<Option<String>>,
}

impl FallbackSecretStore {
    pub fn new(primary: Arc<dyn SecretStore>) -> Self {
        Self::with_timeout(primary, KEYCHAIN_TIMEOUT)
    }

    pub fn with_timeout(primary: Arc<dyn SecretStore>, timeout: Duration) -> Self {
        Self { primary, memory: MemorySecretStore::new(), timeout, degraded: Mutex::new(None) }
    }

    fn is_degraded(&self) -> bool {
        self.degraded.lock().unwrap_or_else(PoisonError::into_inner).is_some()
    }

    fn latch(&self, message: String) {
        let mut d = self.degraded.lock().unwrap_or_else(PoisonError::into_inner);
        if d.is_none() {
            *d = Some(message);
        }
    }

    /// Runs `f` against the primary store on its own thread, so a blocked dialog cannot block the caller. `None` means
    /// "use memory": the store failed, did not answer in time, or panicked, and the reason was remembered.
    fn primary_call<T: Send + 'static>(&self, f: impl FnOnce(&dyn SecretStore) -> Result<T> + Send + 'static) -> Option<T> {
        if self.is_degraded() {
            return None;
        }
        let (tx, rx) = mpsc::channel();
        let wait = if self.primary.is_warm() { self.timeout } else { self.timeout.max(WARM_TIMEOUT) };
        let primary = Arc::clone(&self.primary);
        std::thread::spawn(move || {
            let _ = tx.send(f(&*primary));
        });
        match rx.recv_timeout(wait) {
            Ok(Ok(v)) => Some(v),
            Ok(Err(e)) => {
                let detail = e.detail.as_deref().map(|d| format!(" ({d})")).unwrap_or_default();
                self.latch(format!("{} Secrets are kept in memory until you quit.{detail}", e.message));
                None
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.latch(format!(
                    "The Keychain did not answer within {} seconds; a macOS permission dialog may be waiting behind another window. Secrets are kept in memory until you quit.",
                    wait.as_secs()
                ));
                None
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.latch("The Keychain access failed unexpectedly. Secrets are kept in memory until you quit.".into());
                None
            }
        }
    }
}

impl SecretStore for FallbackSecretStore {
    fn has(&self, key: &str) -> Result<bool> {
        validate_key(key)?;
        let k = key.to_owned();
        match self.primary_call(move |p| p.has(&k)) {
            Some(found) => Ok(found || self.memory.has(key)?),
            None => self.memory.has(key),
        }
    }

    fn set(&self, key: &str, value: Secret) -> Result<()> {
        validate_key(key)?;
        let (k, v) = (key.to_owned(), value.clone());
        match self.primary_call(move |p| p.set(&k, v)) {
            Some(()) => Ok(()),
            None => self.memory.set(key, value),
        }
    }

    fn remove(&self, key: &str) -> Result<()> {
        validate_key(key)?;
        self.memory.remove(key)?;
        let k = key.to_owned();
        let _ = self.primary_call(move |p| p.remove(&k));
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<Secret>> {
        validate_key(key)?;
        let k = key.to_owned();
        match self.primary_call(move |p| p.get(&k)) {
            Some(Some(found)) => Ok(Some(found)),
            Some(None) | None => self.memory.get(key),
        }
    }

    fn health(&self) -> SecretsHealth {
        match self.degraded.lock().unwrap_or_else(PoisonError::into_inner).clone() {
            Some(message) => SecretsHealth { backend: "memory", degraded: true, message: Some(message) },
            None => self.primary.health(),
        }
    }

    fn retry(&self) {
        *self.degraded.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }
}

/// Masks credentials in text bound for logs, errors or stored events: `Bearer`/`Basic` values, the value after
/// `Authorization:`, `name=value` pairs whose name looks secret, and well-known token prefixes.
pub fn redact(text: &str) -> String {
    const MASK: &str = "[redacted]";
    const PREFIXES: [&str; 9] = ["sk-", "ghp_", "gho_", "ghu_", "ghs_", "github_pat_", "xoxb-", "xoxp-", "AIza"];
    let is_separator = |c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '(' | ')' | ',' | ';');
    let mut out = String::with_capacity(text.len());
    let mut after_scheme = false;
    let mut rest = text;
    while !rest.is_empty() {
        let sep_len = rest.find(|c| !is_separator(c)).unwrap_or(rest.len());
        out.push_str(&rest[..sep_len]);
        rest = &rest[sep_len..];
        let word_len = rest.find(is_separator).unwrap_or(rest.len());
        let word = &rest[..word_len];
        rest = &rest[word_len..];
        if word.is_empty() {
            continue;
        }
        let lower = word.to_ascii_lowercase();
        let is_scheme = matches!(lower.as_str(), "bearer" | "basic");
        let secret_value = (after_scheme && !is_scheme) || (word.len() >= 12 && PREFIXES.iter().any(|p| word.starts_with(p)));
        if secret_value {
            out.push_str(MASK);
        } else if let Some(masked) = mask_mongo_uri(word) {
            out.push_str(&masked);
        } else if let Some((name, _)) = word.split_once('=').filter(|(n, v)| !v.is_empty() && name_looks_secret(n)) {
            out.push_str(&format!("{name}={MASK}"));
        } else {
            out.push_str(word);
        }
        after_scheme = is_scheme || matches!(lower.as_str(), "authorization:" | "x-api-key:");
    }
    out
}

/// `mongodb(+srv)://user:pass@host/db` to `mongodb(+srv)://***@host/db` (any word that carries such a URI).
fn mask_mongo_uri(word: &str) -> Option<String> {
    let start = word.find("mongodb://").map(|k| k + 10).or_else(|| word.find("mongodb+srv://").map(|k| k + 14))?;
    let authority_end = word[start..].find('/').map_or(word.len(), |k| start + k);
    let at = start + word[start..authority_end].rfind('@')?;
    Some(format!("{}***{}", &word[..start], &word[at..]))
}

/// Whether a variable, header or query-parameter NAME looks like it holds a credential (`key`, `token`, `secret`, `password`, `passwd`, `auth`).
pub fn name_looks_secret(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["key", "token", "secret", "password", "passwd", "auth"].iter().any(|s| n.contains(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANARY: &str = "sk-CANARY-7f3a9c1e5b2d4a6f8c0e";

    #[test]
    fn the_memory_store_round_trips_and_has_never_needs_the_value() {
        let store = MemorySecretStore::new();
        assert!(!store.has("providers.openai:default").unwrap());
        store.set("providers.openai:default", Secret::new(CANARY)).unwrap();
        assert!(store.has("providers.openai:default").unwrap());
        assert_eq!(store.get("providers.openai:default").unwrap().unwrap().expose(), CANARY);
        store.remove("providers.openai:default").unwrap();
        store.remove("providers.openai:default").unwrap();
        assert!(!store.has("providers.openai:default").unwrap());
        assert!(store.get("providers.openai:default").unwrap().is_none());
    }

    #[test]
    fn invalid_keys_are_refused_by_every_operation() {
        let store = MemorySecretStore::new();
        for key in ["", "has space", "../etc", "-lead", "a/b", &"x".repeat(129), "naïve"] {
            assert_eq!(store.has(key).err().unwrap().code, code::INVALID_KEY, "{key}");
            assert_eq!(store.set(key, Secret::new("v")).err().unwrap().code, code::INVALID_KEY);
            assert_eq!(store.remove(key).err().unwrap().code, code::INVALID_KEY);
        }
    }

    #[test]
    fn a_secret_value_never_appears_in_debug_display_or_errors() {
        let secret = Secret::new(CANARY);
        let store = MemorySecretStore::new();
        store.set("providers.openai:default", secret.clone()).unwrap();
        let rendered = [format!("{secret:?}"), format!("{secret}"), format!("{store:?}"), format!("{:?}", Some(&secret))];
        for text in rendered {
            assert!(!text.contains(CANARY), "{text}");
        }
        let err = store.set("bad key", secret).err().unwrap();
        assert!(!format!("{err} {err:?}").contains(CANARY));
    }

    #[test]
    fn redact_masks_credentials_and_keeps_the_rest() {
        let cases = [
            ("Authorization: Bearer abc.def.ghi failed", "Authorization: Bearer [redacted] failed"),
            ("curl -H 'Authorization: Basic dXNlcjpwdw==' x", "curl -H 'Authorization: Basic [redacted]' x"),
            ("GET /v1/models?key=AIzaSyD-1234 now", "GET /v1/models?key=[redacted] now"),
            ("env ANTHROPIC_API_KEY=abc123 claude", "env ANTHROPIC_API_KEY=[redacted] claude"),
            ("stored sk-CANARY-7f3a9c1e5b2d4a6f8c0e ok", "stored [redacted] ok"),
            ("plain text, nothing here: 42", "plain text, nothing here: 42"),
        ];
        for (input, expected) in cases {
            assert_eq!(redact(input), expected);
        }
    }

    #[test]
    fn redact_masks_the_credentials_of_a_mongodb_uri() {
        let cases = [
            ("connect failed mongodb://app:CANARY-pw@db.example.com:27017/prod?authSource=admin timeout", "connect failed mongodb://***@db.example.com:27017/prod?authSource=admin timeout"),
            ("uri=mongodb+srv://u:CANARY-pw@cluster0.example.net/x", "uri=mongodb+srv://***@cluster0.example.net/x"),
            ("bad (mongodb://u:CANARY-pw@h:1)", "bad (mongodb://***@h:1)"),
            ("mongodb://127.0.0.1:27017/intely_test_x", "mongodb://127.0.0.1:27017/intely_test_x"),
        ];
        for (input, expected) in cases {
            let out = redact(input);
            assert_eq!(out, expected);
            assert!(!out.contains("CANARY-pw"));
        }
    }

    /// A primary store that fails (or hangs) like a denied Keychain.
    struct Broken {
        mode: &'static str,
        calls: Mutex<usize>,
    }

    impl Broken {
        fn new(mode: &'static str) -> Arc<Self> {
            Arc::new(Self { mode, calls: Mutex::new(0) })
        }

        fn act<T>(&self) -> Result<T> {
            *self.calls.lock().unwrap() += 1;
            match self.mode {
                "denied" => Err(SettingsError::new(code::KEYCHAIN, "Keychain access was cancelled or denied.").with_detail("OSStatus -128")),
                "hang" => {
                    std::thread::sleep(Duration::from_secs(5));
                    Err(SettingsError::new(code::KEYCHAIN, "late"))
                }
                _ => panic!("the Keychain library crashed"),
            }
        }
    }

    impl SecretStore for Broken {
        fn has(&self, _: &str) -> Result<bool> {
            self.act()
        }
        fn set(&self, _: &str, _: Secret) -> Result<()> {
            self.act()
        }
        fn remove(&self, _: &str) -> Result<()> {
            self.act()
        }
        fn get(&self, _: &str) -> Result<Option<Secret>> {
            self.act()
        }
    }

    #[test]
    fn a_denied_keychain_falls_back_to_memory_once_and_says_why() {
        let broken = Broken::new("denied");
        let store = FallbackSecretStore::with_timeout(broken.clone(), Duration::from_secs(2));
        assert!(!store.health().degraded);
        store.set("providers.openai:default", Secret::new(CANARY)).expect("a refusal is not an error for the caller");
        let h = store.health();
        assert!((h.backend, h.degraded) == ("memory", true), "{h:?}");
        let msg = h.message.unwrap();
        assert!(msg.contains("denied") && msg.contains("kept in memory") && msg.contains("OSStatus -128") && !msg.contains(CANARY), "{msg}");
        // served from memory from now on, and the Keychain is not asked again (no dialog per call)
        assert!(store.has("providers.openai:default").unwrap());
        assert_eq!(store.get("providers.openai:default").unwrap().unwrap().expose(), CANARY);
        store.remove("providers.openai:default").unwrap();
        assert!(!store.has("providers.openai:default").unwrap());
        assert_eq!(*broken.calls.lock().unwrap(), 1);
        // invalid keys are still refused, and the user can ask for another try
        assert_eq!(store.set("bad key", Secret::new("v")).err().unwrap().code, code::INVALID_KEY);
        store.retry();
        assert!(!store.health().degraded);
    }

    #[test]
    fn a_keychain_dialog_nobody_answers_does_not_hang_the_caller() {
        let store = FallbackSecretStore::with_timeout(Broken::new("hang"), Duration::from_millis(150));
        let started = std::time::Instant::now();
        store.set("happy.token", Secret::new("t")).unwrap();
        assert!(started.elapsed() < Duration::from_secs(3));
        let h = store.health();
        assert!(h.degraded && h.message.unwrap().contains("did not answer"), "degraded with an explanation");
        assert_eq!(store.get("happy.token").unwrap().unwrap().expose(), "t");
    }

    #[test]
    fn a_crashing_keychain_library_is_contained() {
        let store = FallbackSecretStore::with_timeout(Broken::new("panic"), Duration::from_secs(2));
        assert!(!store.has("happy.token").unwrap());
        assert!(store.health().degraded);
        store.set("happy.token", Secret::new("t")).unwrap();
        assert!(store.has("happy.token").unwrap());
    }

    #[test]
    fn a_healthy_primary_is_used_and_not_shadowed_by_memory() {
        let primary: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::new());
        let store = FallbackSecretStore::new(Arc::clone(&primary));
        store.set("happy.token", Secret::new("t")).unwrap();
        assert!(primary.has("happy.token").unwrap(), "the value went to the primary store");
        assert_eq!(store.get("happy.token").unwrap().unwrap().expose(), "t");
        assert!(!store.health().degraded);
        store.remove("happy.token").unwrap();
        assert!(!primary.has("happy.token").unwrap());
    }

    /// Two services of one fake Keychain; `fail_set` models a refused write.
    #[derive(Default)]
    struct Fake {
        items: Mutex<HashMap<String, Secret>>,
        fail_set: bool,
        removed: Mutex<usize>,
    }

    impl Fake {
        fn with(key: &str, v: &str) -> Arc<Self> {
            let f = Self::default();
            f.items.lock().unwrap().insert(key.into(), Secret::new(v));
            Arc::new(f)
        }
        fn failing_set() -> Arc<Self> {
            Arc::new(Self { fail_set: true, ..Self::default() })
        }
        fn holds(&self, key: &str) -> bool {
            self.items.lock().unwrap().contains_key(key)
        }
    }

    impl SecretStore for Fake {
        fn has(&self, key: &str) -> Result<bool> {
            Ok(self.holds(key))
        }
        fn set(&self, key: &str, value: Secret) -> Result<()> {
            if self.fail_set {
                return Err(SettingsError::new(code::KEYCHAIN, "Keychain access was cancelled or denied.").with_detail("OSStatus -128"));
            }
            self.items.lock().unwrap().insert(key.into(), value);
            Ok(())
        }
        fn remove(&self, key: &str) -> Result<()> {
            *self.removed.lock().unwrap() += 1;
            self.items.lock().unwrap().remove(key);
            Ok(())
        }
        fn get(&self, key: &str) -> Result<Option<Secret>> {
            Ok(self.items.lock().unwrap().get(key).cloned())
        }
    }

    const K: &str = "providers.openai:default";

    fn pair(current: &Arc<Fake>, legacy: &Arc<Fake>) -> LegacyFallbackStore {
        LegacyFallbackStore::new(current.clone(), legacy.clone())
    }

    #[test]
    fn the_new_service_wins_and_the_legacy_one_is_not_asked_to_change() {
        let (cur, old) = (Fake::with(K, "new"), Fake::with(K, "old"));
        assert_eq!(pair(&cur, &old).get(K).unwrap().unwrap().expose(), "new");
        assert_eq!(old.get(K).unwrap().unwrap().expose(), "old");
    }

    #[test]
    fn a_legacy_hit_is_copied_to_the_new_service_and_kept_in_the_legacy_one() {
        let (cur, old) = (Arc::new(Fake::default()), Fake::with(K, "old"));
        let store = pair(&cur, &old);
        assert!(store.has(K).unwrap(), "has sees legacy items");
        assert_eq!(store.get(K).unwrap().unwrap().expose(), "old");
        assert_eq!(cur.get(K).unwrap().unwrap().expose(), "old", "copied");
        assert!(old.holds(K), "a read never deletes the legacy item");
        assert_eq!(*old.removed.lock().unwrap(), 0);
        assert!(store.get("happy.token").unwrap().is_none());
        assert!(!store.has("happy.token").unwrap());
    }

    #[test]
    fn a_failed_copy_still_returns_the_value_and_keeps_the_legacy_item() {
        let (cur, old) = (Fake::failing_set(), Fake::with(K, "old"));
        let store = pair(&cur, &old);
        assert_eq!(store.get(K).unwrap().unwrap().expose(), "old");
        assert!(old.holds(K) && !cur.holds(K));
        assert_eq!(*old.removed.lock().unwrap(), 0);
    }

    #[test]
    fn set_writes_the_new_service_only() {
        let (cur, old) = (Arc::new(Fake::default()), Fake::with(K, "old"));
        pair(&cur, &old).set(K, Secret::new("fresh")).unwrap();
        assert_eq!(cur.get(K).unwrap().unwrap().expose(), "fresh");
        assert_eq!(old.get(K).unwrap().unwrap().expose(), "old");
    }

    #[test]
    fn remove_deletes_from_both_services_so_the_secret_cannot_come_back() {
        let (cur, old) = (Fake::with(K, "new"), Fake::with(K, "old"));
        let store = pair(&cur, &old);
        store.remove(K).unwrap();
        assert!(!cur.holds(K) && !old.holds(K));
        assert!(store.get(K).unwrap().is_none() && !store.has(K).unwrap());
        store.remove(K).unwrap();
    }

    #[test]
    fn the_legacy_store_refuses_invalid_keys_and_no_secret_leaks_into_errors_or_debug() {
        let (cur, old) = (Fake::failing_set(), Fake::with(K, CANARY));
        let store = pair(&cur, &old);
        assert_eq!(store.get("bad key").err().unwrap().code, code::INVALID_KEY);
        assert_eq!(store.has("bad key").err().unwrap().code, code::INVALID_KEY);
        assert_eq!(store.remove("bad key").err().unwrap().code, code::INVALID_KEY);
        let got = store.get(K).unwrap();
        let err = store.set(K, Secret::new(CANARY)).err().unwrap();
        for text in [format!("{store:?}"), format!("{got:?}"), format!("{err} {err:?}")] {
            assert!(!text.contains(CANARY), "{text}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn keychain_messages_are_actionable() {
        assert!(keychain::keychain_message(-128).contains("Always Allow"));
        assert!(keychain::keychain_message(-34018).contains("development build"));
        assert!(keychain::keychain_message(-25308).contains("locked"));
        assert!(keychain::keychain_message(1).contains("refused"));
    }

    #[test]
    fn provider_keys_are_valid_keys() {
        assert!(validate_key(&provider_key("openai")).is_ok());
    }

    // ---- the vault ----------------------------------------------------------------------------------------------------

    /// A memory store that counts reads and writes and can be told to fail writes.
    #[derive(Default)]
    struct Counting {
        inner: MemorySecretStore,
        gets: std::sync::atomic::AtomicUsize,
        fail_set: std::sync::atomic::AtomicBool,
    }

    impl SecretStore for Counting {
        fn has(&self, key: &str) -> Result<bool> {
            self.inner.has(key)
        }
        fn set(&self, key: &str, value: Secret) -> Result<()> {
            if self.fail_set.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(SettingsError::new(code::KEYCHAIN, "denied"));
            }
            self.inner.set(key, value)
        }
        fn remove(&self, key: &str) -> Result<()> {
            self.inner.remove(key)
        }
        fn get(&self, key: &str) -> Result<Option<Secret>> {
            self.gets.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.inner.get(key)
        }
        fn keys(&self) -> Result<Vec<String>> {
            self.inner.keys()
        }
    }

    fn n(c: &std::sync::atomic::AtomicUsize) -> usize {
        c.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[test]
    fn the_vault_reads_its_item_once_and_serves_every_later_call_from_memory() {
        let backend = Arc::new(Counting::default());
        let vault = VaultStore::new(backend.clone(), vec![]);
        vault.set("a.one", Secret::new("1")).unwrap();
        vault.set("a.two", Secret::new("2")).unwrap();
        for _ in 0..5 {
            assert_eq!(vault.get("a.one").unwrap().unwrap().expose(), "1");
            assert!(vault.has("a.two").unwrap());
        }
        // one read to load, one per write (to merge with what another instance wrote); reads never touch the Keychain
        assert_eq!(n(&backend.gets), 3, "the load, and the two writes each re-read once");
        let before = n(&backend.gets);
        for _ in 0..5 {
            vault.get("a.one").unwrap();
        }
        assert_eq!(n(&backend.gets), before);
        // a second process sees both values in the one item
        let again = VaultStore::new(backend.clone(), vec![]);
        assert_eq!(again.get("a.two").unwrap().unwrap().expose(), "2");
        assert_eq!(backend.inner.keys().unwrap(), vec![VAULT_ACCOUNT.to_owned()]);
    }

    #[test]
    fn a_failed_write_is_rolled_back_in_the_cache() {
        let backend = Arc::new(Counting::default());
        let vault = VaultStore::new(backend.clone(), vec![]);
        vault.set("a.one", Secret::new("1")).unwrap();
        backend.fail_set.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(vault.set("a.one", Secret::new("changed")).is_err());
        assert!(vault.set("a.new", Secret::new("x")).is_err());
        assert!(vault.remove("a.one").is_err());
        assert_eq!(vault.get("a.one").unwrap().unwrap().expose(), "1");
        assert!(!vault.has("a.new").unwrap());
    }

    #[test]
    fn legacy_items_are_moved_into_the_vault_read_once_and_never_deleted() {
        let backend = Arc::new(MemorySecretStore::new());
        let (old_a, old_b) = (Arc::new(Counting::default()), Arc::new(Counting::default()));
        old_a.inner.set("remote.mac.key", Secret::new("k1")).unwrap();
        old_a.inner.set("team.keys", Secret::new("k2")).unwrap();
        old_b.inner.set("remote.mac.key", Secret::new("older")).unwrap();
        old_b.inner.set("uri.c1", Secret::new("mongodb://x")).unwrap();
        let vault = VaultStore::new(backend.clone(), vec![old_a.clone(), old_b.clone()]);
        assert_eq!(vault.get("remote.mac.key").unwrap().unwrap().expose(), "k1", "the newer store wins");
        assert_eq!(vault.get("uri.c1").unwrap().unwrap().expose(), "mongodb://x");
        assert_eq!((n(&old_a.gets), n(&old_b.gets)), (2, 1), "only items that exist, each read once; a shadowed duplicate is not read");
        assert_eq!(old_a.inner.keys().unwrap().len(), 2, "legacy items are left in place");
        // a later process: the vault knows the keys were taken over, so the legacy stores are not read at all
        let fresh = VaultStore::new(backend, vec![old_a.clone(), old_b.clone()]);
        assert_eq!(fresh.get("team.keys").unwrap().unwrap().expose(), "k2");
        assert_eq!(fresh.keys().unwrap().len(), 3, "the marker is not a secret");
        assert_eq!((n(&old_a.gets), n(&old_b.gets)), (2, 1));
    }

    /// A legacy store whose read of one key can be made to fail.
    struct Denies(Arc<MemorySecretStore>, std::sync::atomic::AtomicBool);
    impl SecretStore for Denies {
        fn has(&self, k: &str) -> Result<bool> { self.0.has(k) }
        fn set(&self, k: &str, v: Secret) -> Result<()> { self.0.set(k, v) }
        fn remove(&self, k: &str) -> Result<()> { self.0.remove(k) }
        fn get(&self, k: &str) -> Result<Option<Secret>> {
            if k == "tamper-key" && self.1.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(SettingsError::new(code::KEYCHAIN, "denied"));
            }
            self.0.get(k)
        }
        fn keys(&self) -> Result<Vec<String>> { self.0.keys() }
    }

    #[test]
    fn a_denied_legacy_read_fails_the_load_so_no_replacement_secret_can_shadow_it() {
        let backend = Arc::new(MemorySecretStore::new());
        let old = Arc::new(MemorySecretStore::new());
        old.set("tamper-key", Secret::new("t")).unwrap();
        old.set("happy.token", Secret::new("h")).unwrap();
        let legacy = Arc::new(Denies(old, std::sync::atomic::AtomicBool::new(true)));
        let first = VaultStore::new(backend.clone(), vec![legacy.clone()]);
        // every operation is an error, never "missing": a caller that creates on None cannot get there
        assert!(first.get("tamper-key").is_err() && first.set("tamper-key", Secret::new("new")).is_err()); // (`has` answers from the listing before the vault exists, without reading)
        assert!(!first.is_warm());
        // progress made before the failure is kept; the denied item is asked again and now succeeds
        legacy.1.store(false, std::sync::atomic::Ordering::SeqCst);
        let second = VaultStore::new(backend.clone(), vec![legacy.clone()]);
        assert_eq!(second.get("tamper-key").unwrap().unwrap().expose(), "t");
        second.remove("happy.token").unwrap();
        let third = VaultStore::new(backend, vec![legacy]);
        assert!(!third.has("happy.token").unwrap(), "the legacy item is still there but is not read again");
    }

    #[test]
    fn migration_is_saved_after_each_item() {
        let backend = Arc::new(MemorySecretStore::new());
        let old = Arc::new(MemorySecretStore::new());
        old.set("a.first", Secret::new("1")).unwrap();
        old.set("tamper-key", Secret::new("t")).unwrap();
        let legacy = Arc::new(Denies(old, std::sync::atomic::AtomicBool::new(true)));
        assert!(VaultStore::new(backend.clone(), vec![legacy]).get("a.first").is_err());
        // whichever item came first before the denied one is already in the vault item
        let stored = backend.get(VAULT_ACCOUNT).unwrap();
        assert!(stored.is_none_or(|s| s.expose().contains("a.first") || !s.expose().contains("tamper-key")));
    }

    #[test]
    fn has_does_not_read_the_vault_before_it_exists_and_two_instances_do_not_lose_each_others_keys() {
        let backend = Arc::new(Counting::default());
        let old = Arc::new(MemorySecretStore::new());
        old.set("sentry.token", Secret::new("t")).unwrap();
        let a = VaultStore::new(backend.clone(), vec![old]);
        assert!(a.has("sentry.token").unwrap() && !a.has("nope.key").unwrap());
        assert_eq!(n(&backend.gets), 0, "no data was read");
        assert!(!a.is_warm());
        let b = VaultStore::new(backend.clone(), vec![]);
        a.set("k.a", Secret::new("A")).unwrap();
        b.set("k.b", Secret::new("B")).unwrap();
        a.set("k.c", Secret::new("C")).unwrap();
        let fresh = VaultStore::new(backend, vec![]);
        for k in ["k.a", "k.b", "k.c"] {
            assert!(fresh.has(k).unwrap(), "{k}");
        }
    }

    #[test]
    fn the_fallback_waits_for_the_vault_load_instead_of_dropping_to_memory() {
        struct Slow(MemorySecretStore, AtomicBool);
        impl SecretStore for Slow {
            fn has(&self, k: &str) -> Result<bool> { self.0.has(k) }
            fn set(&self, k: &str, v: Secret) -> Result<()> { std::thread::sleep(Duration::from_millis(300)); self.1.store(true, Ordering::SeqCst); self.0.set(k, v) }
            fn remove(&self, k: &str) -> Result<()> { self.0.remove(k) }
            fn get(&self, k: &str) -> Result<Option<Secret>> { self.0.get(k) }
            fn is_warm(&self) -> bool { self.1.load(Ordering::SeqCst) }
        }
        let slow = Arc::new(Slow(MemorySecretStore::new(), AtomicBool::new(false)));
        let store = FallbackSecretStore::with_timeout(slow.clone(), Duration::from_millis(50));
        store.set("a.b", Secret::new("v")).unwrap();
        assert!(!store.health().degraded, "a cold store gets the long timeout");
        assert!(slow.0.has("a.b").unwrap());
    }

    #[test]
    fn a_legacy_item_is_served_even_when_the_vault_could_not_be_written() {
        let backend = Arc::new(Counting::default());
        backend.fail_set.store(true, std::sync::atomic::Ordering::SeqCst);
        let old = Arc::new(MemorySecretStore::new());
        old.set("sentry.token", Secret::new("t")).unwrap();
        let vault = VaultStore::new(backend, vec![old.clone()]);
        assert_eq!(vault.get("sentry.token").unwrap().unwrap().expose(), "t");
        assert!(old.has("sentry.token").unwrap());
    }

    #[test]
    fn an_unreadable_vault_is_an_error_and_is_never_overwritten() {
        let backend = Arc::new(MemorySecretStore::new());
        backend.set(VAULT_ACCOUNT, Secret::new("not json")).unwrap();
        let vault = VaultStore::new(backend.clone(), vec![]);
        assert!(vault.get("a.one").is_err());
        assert!(vault.set("a.one", Secret::new("1")).is_err());
        assert_eq!(backend.get(VAULT_ACCOUNT).unwrap().unwrap().expose(), "not json");
    }

    #[test]
    fn the_vault_is_safe_to_use_from_many_threads_and_never_prints_a_value() {
        let backend = Arc::new(Counting::default());
        let vault = Arc::new(VaultStore::new(backend.clone(), vec![]));
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let v = Arc::clone(&vault);
                std::thread::spawn(move || v.set(&format!("k.{i}"), Secret::new(format!("canary-{i}"))).unwrap())
            })
            .collect();
        handles.into_iter().for_each(|h| h.join().unwrap());
        assert_eq!(vault.keys().unwrap().len(), 8);
        assert_eq!(n(&backend.gets), 1 + 8, "one load, one merge read per write");
        assert!(!format!("{vault:?}").contains("canary"));
    }
}
