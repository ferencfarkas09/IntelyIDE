//! Draft vault, dialog handles and import staging (T5). Everything here lives in Rust memory only: the webview holds
//! random tokens, never a secret and never a path.
//!
//! * [`DraftVault`]: the secrets of a pasted string (10 minutes, at most 16 entries), bound to the connection identity
//!   they were typed for. A redeem for another identity (or another owner) is refused and the entry is wiped.
//! * [`DialogHandles`]: one-time tickets for a file a native dialog (opened by Rust) returned (5 minutes, single redeem).
//! * [`ImportStaging`]: the parsed profiles of an import preview, keyed by the redeemed handle token, until the user
//!   picks which ones to import.
//!
//! Time is injectable ([`Clock`]) so expiry is tested without sleeping. Secrets are stored in `Zeroizing<String>`
//! buffers, wiped on removal, expiry, eviction and drop. (The caller's own `Secret` copy is outside this module.)

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use intely_settings::Secret;
use zeroize::Zeroizing;

use crate::api::{DialogHandle, DialogKind, ProfileInput};
use crate::error::{code, Result, StudioError};

pub const DRAFT_TTL: Duration = Duration::from_secs(10 * 60);
pub const DRAFT_CAP: usize = 16;
pub const HANDLE_TTL: Duration = Duration::from_secs(5 * 60);
pub const HANDLE_CAP: usize = 16;
pub const STAGING_CAP: usize = 4;

/// Milliseconds on any monotone-enough scale; only differences matter.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// Wall-clock milliseconds. (A clock set backwards makes entries look younger, never older.)
pub fn system_clock() -> Clock {
    Arc::new(|| SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64))
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn token() -> Result<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|_| StudioError::new(code::SETTINGS, "no secure random source"))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

fn expired(now: u64, born: u64, ttl: Duration) -> bool {
    now.saturating_sub(born) >= ttl.as_millis() as u64
}

#[derive(Debug, Default)]
pub struct DraftSecrets {
    pub password: Option<Secret>,
    pub key_password: Option<Secret>,
}

struct DraftEntry {
    owner: Option<String>,
    identity: String,
    password: Option<Zeroizing<String>>,
    key_password: Option<Zeroizing<String>>,
    born: u64,
}

impl DraftEntry {
    fn secrets(&self) -> DraftSecrets {
        DraftSecrets { password: self.password.as_ref().map(|s| Secret::new(s.as_str())), key_password: self.key_password.as_ref().map(|s| Secret::new(s.as_str())) }
    }
}

fn need_draft() -> StudioError {
    StudioError::new(code::NEED_SECRET, "needs:draft")
}

pub struct DraftVault {
    clock: Clock,
    entries: Mutex<Vec<(String, DraftEntry)>>,
}

impl std::fmt::Debug for DraftVault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DraftVault").field("entries", &lock(&self.entries).len()).finish()
    }
}

impl Default for DraftVault {
    fn default() -> Self {
        Self::new()
    }
}

impl DraftVault {
    pub fn new() -> Self {
        Self::with_clock(system_clock())
    }

    pub fn with_clock(clock: Clock) -> Self {
        Self { clock, entries: Mutex::new(Vec::new()) }
    }

    fn purge(&self, v: &mut Vec<(String, DraftEntry)>) {
        let now = (self.clock)();
        v.retain(|(_, e)| !expired(now, e.born, DRAFT_TTL));
    }

    /// Stores the secrets for `identity` and returns the token. At 16 entries the oldest is dropped (and wiped).
    pub fn put(&self, identity: &str, secrets: DraftSecrets) -> Result<String> {
        self.put_for(None, identity, secrets)
    }

    /// Like [`put`](Self::put), for a stored profile (`owner` = its id): only a redeem naming the same owner succeeds.
    pub fn put_for(&self, owner: Option<&str>, identity: &str, secrets: DraftSecrets) -> Result<String> {
        let tok = token()?;
        let entry = DraftEntry {
            owner: owner.map(str::to_string),
            identity: identity.to_string(),
            password: secrets.password.as_ref().map(|s| Zeroizing::new(s.expose().to_string())),
            key_password: secrets.key_password.as_ref().map(|s| Zeroizing::new(s.expose().to_string())),
            born: (self.clock)(),
        };
        let mut v = lock(&self.entries);
        self.purge(&mut v);
        while v.len() >= DRAFT_CAP {
            v.remove(0);
        }
        v.push((tok.clone(), entry));
        Ok(tok)
    }

    /// Reads the secrets without consuming the token (a test and the following save use the same draft). A different
    /// identity or owner wipes the entry and is refused, as is an unknown or expired token.
    pub fn get(&self, token: &str, identity: &str) -> Result<DraftSecrets> {
        self.get_for(token, None, identity)
    }

    pub fn get_for(&self, token: &str, owner: Option<&str>, identity: &str) -> Result<DraftSecrets> {
        let mut v = lock(&self.entries);
        self.purge(&mut v);
        let Some(i) = v.iter().position(|(t, _)| t == token) else { return Err(need_draft()) };
        let e = &v[i].1;
        let owner_ok = e.owner.as_deref().is_none_or(|o| Some(o) == owner);
        if e.identity != identity || !owner_ok {
            v.remove(i);
            return Err(need_draft());
        }
        Ok(e.secrets())
    }

    /// Redeems a token for the same identity it was stored under and removes it; a different identity or an expired
    /// token is refused.
    pub fn take(&self, token: &str, identity: &str) -> Result<DraftSecrets> {
        self.take_for(token, None, identity)
    }

    pub fn take_for(&self, token: &str, owner: Option<&str>, identity: &str) -> Result<DraftSecrets> {
        let s = self.get_for(token, owner, identity)?;
        self.discard(token);
        Ok(s)
    }

    pub fn discard(&self, token: &str) {
        lock(&self.entries).retain(|(t, _)| t != token);
    }

    /// Switch off, profile delete, dialog close and exit.
    pub fn clear(&self) {
        lock(&self.entries).clear();
    }

    /// Wipes every entry owned by a profile (delete, identity change).
    pub fn clear_owner(&self, owner: &str) {
        lock(&self.entries).retain(|(_, e)| e.owner.as_deref() != Some(owner));
    }

    pub fn len(&self) -> usize {
        let mut v = lock(&self.entries);
        self.purge(&mut v);
        v.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

struct HandleEntry {
    token: String,
    kind: DialogKind,
    path: PathBuf,
    born: u64,
}

/// One-time tickets for files picked in a native dialog that Rust opened. The path never leaves Rust.
pub struct DialogHandles {
    clock: Clock,
    entries: Mutex<Vec<HandleEntry>>,
}

impl std::fmt::Debug for DialogHandles {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DialogHandles").field("entries", &lock(&self.entries).len()).finish()
    }
}

impl Default for DialogHandles {
    fn default() -> Self {
        Self::new()
    }
}

impl DialogHandles {
    pub fn new() -> Self {
        Self::with_clock(system_clock())
    }

    pub fn with_clock(clock: Clock) -> Self {
        Self { clock, entries: Mutex::new(Vec::new()) }
    }

    /// Called by the Tauri glue after the user confirmed a file in the native dialog.
    pub fn issue(&self, kind: DialogKind, path: PathBuf) -> Result<DialogHandle> {
        let tok = token()?;
        let file_name = path.file_name().map(|n| n.to_string_lossy().chars().take(120).collect::<String>());
        let now = (self.clock)();
        let mut v = lock(&self.entries);
        v.retain(|e| !expired(now, e.born, HANDLE_TTL));
        while v.len() >= HANDLE_CAP {
            v.remove(0);
        }
        v.push(HandleEntry { token: tok.clone(), kind, path, born: now });
        Ok(DialogHandle { token: tok, kind, file_name })
    }

    /// Single redeem. An unknown, expired, used or wrong-kind handle is `mongoHandle`; a wrong-kind attempt burns the
    /// handle too (a hostile page cannot probe it).
    pub fn redeem(&self, token: &str, kind: DialogKind) -> Result<PathBuf> {
        let now = (self.clock)();
        let mut v = lock(&self.entries);
        v.retain(|e| !expired(now, e.born, HANDLE_TTL));
        let Some(i) = v.iter().position(|e| e.token == token) else {
            return Err(StudioError::new(code::HANDLE, "the file choice is unknown, expired or already used"));
        };
        let e = v.remove(i);
        if e.kind != kind {
            return Err(StudioError::new(code::HANDLE, "the file choice is for another action"));
        }
        Ok(e.path)
    }

    pub fn len(&self) -> usize {
        let now = (self.clock)();
        let mut v = lock(&self.entries);
        v.retain(|e| !expired(now, e.born, HANDLE_TTL));
        v.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&self) {
        lock(&self.entries).clear();
    }
}

struct Staged {
    token: String,
    inputs: Vec<ProfileInput>,
    born: u64,
}

/// The profiles an import preview parsed, kept in Rust (the URI-list ones carry their password in `ProfileInput`,
/// which has a redacted `Debug` and wipes on drop) until `mongo_profiles_import` takes the selected ones.
pub struct ImportStaging {
    clock: Clock,
    entries: Mutex<Vec<Staged>>,
}

impl std::fmt::Debug for ImportStaging {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportStaging").field("entries", &lock(&self.entries).len()).finish()
    }
}

impl Default for ImportStaging {
    fn default() -> Self {
        Self::new()
    }
}

impl ImportStaging {
    pub fn new() -> Self {
        Self::with_clock(system_clock())
    }

    pub fn with_clock(clock: Clock) -> Self {
        Self { clock, entries: Mutex::new(Vec::new()) }
    }

    /// Keyed by the (already redeemed) handle token the webview will send back with its selection.
    pub fn stage(&self, token: &str, inputs: Vec<ProfileInput>) {
        let now = (self.clock)();
        let mut v = lock(&self.entries);
        v.retain(|e| !expired(now, e.born, HANDLE_TTL) && e.token != token);
        while v.len() >= STAGING_CAP {
            v.remove(0);
        }
        v.push(Staged { token: token.to_string(), inputs, born: now });
    }

    /// Single use: removes the staged import and returns the selected profiles (indexes of the preview items; an
    /// out-of-range or repeated index is ignored). Unknown or expired is `mongoHandle`.
    pub fn take_selected(&self, token: &str, selected: &[u32]) -> Result<Vec<ProfileInput>> {
        let now = (self.clock)();
        let mut v = lock(&self.entries);
        v.retain(|e| !expired(now, e.born, HANDLE_TTL));
        let Some(i) = v.iter().position(|e| e.token == token) else {
            return Err(StudioError::new(code::HANDLE, "the import preview expired: choose the file again"));
        };
        let staged = v.remove(i);
        let mut seen = vec![false; staged.inputs.len()];
        let mut out = Vec::new();
        let mut inputs: Vec<Option<ProfileInput>> = staged.inputs.into_iter().map(Some).collect();
        for &s in selected {
            let s = s as usize;
            if s < inputs.len() && !seen[s] {
                seen[s] = true;
                out.push(inputs[s].take().expect("not yet taken"));
            }
        }
        Ok(out)
    }

    pub fn discard(&self, token: &str) {
        lock(&self.entries).retain(|e| e.token != token);
    }

    pub fn clear(&self) {
        lock(&self.entries).clear();
    }
}
