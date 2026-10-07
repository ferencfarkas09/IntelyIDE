//! Secret storage. The webview can only ask `has`, `set` and `remove`; `get` exists for Rust-side consumers (a native
//! provider adapter) and is not exposed over IPC. Values are wrapped in [`Secret`], which never prints itself.
//!
//! Tests and the E2E/READONLY jails use [`MemorySecretStore`]; [`KeychainSecretStore`] talks to the macOS Keychain and is
//! only constructed on an explicit user action path (dev builds can trigger Keychain permission dialogs).

use std::collections::HashMap;
use std::fmt;
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

#[cfg(target_os = "macos")]
pub use keychain::{KeychainSecretStore, ScopedKeychainStore, SERVICE};

#[cfg(target_os = "macos")]
mod keychain {
    use security_framework::item::{ItemClass, ItemSearchOptions};
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    use std::sync::Arc;

    use super::{validate_key, LegacyFallbackStore, Secret, SecretStore, SecretsHealth, LEGACY_SERVICE};
    use crate::error::{code, Result, SettingsError};

    /// One Keychain service for the whole IDE; one generic-password item per key (account = key).
    /// Items stored by earlier versions under [`LEGACY_SERVICE`] are read once and copied here.
    pub const SERVICE: &str = "com.intelyhome.intelyide";
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

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

    fn has(service: &str, key: &str) -> Result<bool> {
        validate_key(key)?;
        // Attributes only: the secret data is not read, so no access prompt for the item.
        match ItemSearchOptions::new().class(ItemClass::generic_password()).service(service).account(key).load_attributes(true).search() {
            Ok(found) => Ok(!found.is_empty()),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(false),
            Err(e) => Err(keychain_error(e)),
        }
    }

    fn set(service: &str, key: &str, value: Secret) -> Result<()> {
        validate_key(key)?;
        set_generic_password(service, key, value.expose().as_bytes()).map_err(keychain_error)
    }

    fn remove(service: &str, key: &str) -> Result<()> {
        validate_key(key)?;
        match delete_generic_password(service, key) {
            Err(e) if e.code() != ERR_SEC_ITEM_NOT_FOUND => Err(keychain_error(e)),
            _ => Ok(()),
        }
    }

    fn get(service: &str, key: &str) -> Result<Option<Secret>> {
        validate_key(key)?;
        match get_generic_password(service, key) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(|s| Some(Secret::new(s)))
                .map_err(|_| SettingsError::new(code::KEYCHAIN, "the stored secret is not valid UTF-8")),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(keychain_error(e)),
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
            }
        };
    }

    delegating_store!(KeychainSecretStore, |_store| LegacyFallbackStore::new(raw(SERVICE), raw(LEGACY_SERVICE)));
    delegating_store!(ScopedKeychainStore, |store| store.store());
}

/// How long a Keychain call may take before the in-memory store takes over. A macOS permission dialog that nobody
/// answers (or one hidden behind another window) blocks the call, and the settings screen must not hang with it.
pub const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(20);

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
        let primary = Arc::clone(&self.primary);
        std::thread::spawn(move || {
            let _ = tx.send(f(&*primary));
        });
        match rx.recv_timeout(self.timeout) {
            Ok(Ok(v)) => Some(v),
            Ok(Err(e)) => {
                let detail = e.detail.as_deref().map(|d| format!(" ({d})")).unwrap_or_default();
                self.latch(format!("{} Secrets are kept in memory until you quit.{detail}", e.message));
                None
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.latch(format!(
                    "The Keychain did not answer within {} seconds; a macOS permission dialog may be waiting behind another window. Secrets are kept in memory until you quit.",
                    self.timeout.as_secs()
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
}
