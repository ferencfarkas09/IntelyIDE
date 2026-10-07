//! Connection profiles: `settings.json` namespace `mongo` (no secrets, no URIs) plus the secrets in the secret store: a
//! legacy connection string (`uri.<id>`) or, for a profile with a structured [`ConnSpec`], one JSON bundle `sec.<id>`
//! (password, key passphrase, ssh secret, proxy password, and the identity hash of the destination they were typed
//! for). The safety-relevant fields and the connection itself are signed with a key that lives only in the secret store,
//! so an edit from outside the IDE (or through the generic settings command) fails the check on the next read: a v2
//! (legacy) record is reset to the safe defaults, a v3 record is reset in memory and flagged `needs_review` until the
//! user saves it again. The signature is checked on **every** read, not only at start-up.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use intely_settings::{Object, Secret, SecretStore, SettingsStore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::api::{AiMode, AiPrefs, Domain, Environment, Notice, ProfileInput, ProfileMeta, ProfileView, ReadPreference, SecretKind, SecretStoreKind, SecretsStatus, SessionSecrets, TlsRelax, WireSecret};
use crate::connspec::{ConnSpec, ReadPrefMode, Tunnel, TunnelAuth};
use crate::error::{code, Result, StudioError};
use crate::host::{self, HostInfo};
use crate::types::{EffectiveLevel, DEFAULT_MAX_TIME_MS, MAX_TIME_CEILING_MS};

pub const NS: &str = "mongo";
/// Keychain service of the Mongo secrets (the account is `uri.<profile id>` and `tamper-key`).
pub const KEYCHAIN_SERVICE: &str = "hu.happygastro.intelyswitchide.mongo";
const TAMPER_KEY: &str = "tamper-key";

/// The fields a tampering user would flip. Signed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Safety {
    pub read_only: bool,
    pub environment: Environment,
    pub ai_mode: AiMode,
    #[serde(default)]
    pub tenant_lock: Option<String>,
    /// The host the user typed to lower the host rule for this connection.
    #[serde(default)]
    pub level_override: Option<String>,
    /// Relaxed certificate checks (typed confirmation to turn on, refused at the effective Production level).
    #[serde(default)]
    pub tls_relax: TlsRelax,
}

impl Safety {
    /// What a reset puts back: read-only, AI off, no override, tagged Production. A tenant lock only restricts, so it stays.
    pub fn safe(tenant_lock: Option<String>) -> Self {
        Self { read_only: true, environment: Environment::Production, ai_mode: AiMode::Off, tenant_lock, level_override: None, tls_relax: TlsRelax::None }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    name: String,
    #[serde(default)]
    color: String,
    #[serde(default = "default_max_time")]
    max_time_ms: u32,
    #[serde(default)]
    host: String,
    host_level: EffectiveLevel,
    #[serde(default)]
    remote_host: Option<String>,
    safety: Safety,
    /// Revision counter, part of the signature and mirrored in the secret store: restoring an older signed copy of this
    /// record (a weaker safety state) is detected because the secret store remembers the newest revision.
    #[serde(default)]
    rev: u64,
    #[serde(default)]
    sig: String,
    /// Signature format: 0 = a record written before `sigv` existed (v1/v2), 3 = this scheme.
    #[serde(default)]
    sigv: u8,
    /// An older reader that cannot verify this record must not touch it.
    #[serde(default)]
    min_reader: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    conn: Option<ConnSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    group: Option<String>,
    #[serde(default)]
    favorite: bool,
    /// Absent on a legacy record (read as Happy); always written by v3.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    domain: Option<Domain>,
    #[serde(default)]
    ai_prefs: AiPrefs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_used_ms: Option<u64>,
}

impl Stored {
    /// Fields the v1/v2 signature does not cover: on a record without `sigv` they must be absent.
    fn has_v3_extras(&self) -> bool {
        self.conn.is_some() || self.safety.tls_relax != TlsRelax::None || !self.ai_prefs.deny_fields.is_empty() || !self.ai_prefs.glossary.is_empty() || self.domain.is_some() || self.min_reader != 0
    }

    fn domain_or_legacy(&self) -> Domain {
        self.domain.unwrap_or(if self.sigv < 3 { Domain::Happy } else { Domain::Generic })
    }
}

/// Which stored secrets exist and belong to the connection as it is now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SecretFlags {
    pub password: bool,
    pub key_password: bool,
    pub ssh_secret: bool,
    pub proxy_password: bool,
    pub identity_matches: bool,
}

/// The secrets of one connection as the driver and ssh layers get them. `Secret` never prints itself.
#[derive(Debug, Clone, Default)]
pub struct ConnSecrets {
    pub password: Option<Secret>,
    pub key_password: Option<Secret>,
    pub ssh_secret: Option<Secret>,
    pub proxy_password: Option<Secret>,
}

/// The `sec.<id>` item. Zeroed on drop, `Debug` prints only which parts exist.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretBundle {
    identity: String,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    key_password: Option<String>,
    #[serde(default)]
    ssh_secret: Option<String>,
    #[serde(default)]
    proxy_password: Option<String>,
}

impl SecretBundle {
    fn is_empty(&self) -> bool {
        self.password.is_none() && self.key_password.is_none() && self.ssh_secret.is_none() && self.proxy_password.is_none()
    }

    fn slot(&mut self, kind: SecretKind) -> &mut Option<String> {
        match kind {
            SecretKind::Password => &mut self.password,
            SecretKind::KeyPassword => &mut self.key_password,
            SecretKind::SshSecret => &mut self.ssh_secret,
            SecretKind::ProxyPassword => &mut self.proxy_password,
        }
    }
}

impl std::fmt::Debug for SecretBundle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SecretBundle(password={}, keyPassword={}, sshSecret={}, proxyPassword={})", self.password.is_some(), self.key_password.is_some(), self.ssh_secret.is_some(), self.proxy_password.is_some())
    }
}

impl Drop for SecretBundle {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.password.zeroize();
        self.key_password.zeroize();
        self.ssh_secret.zeroize();
        self.proxy_password.zeroize();
    }
}

fn default_max_time() -> u32 {
    DEFAULT_MAX_TIME_MS as u32
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub color: String,
    pub max_time_ms: u32,
    pub host: String,
    pub host_level: EffectiveLevel,
    pub remote_host: Option<String>,
    pub safety: Safety,
    /// A legacy connection string exists in the secret store.
    pub has_uri: bool,
    /// The structured connection, when the profile has one.
    pub conn: Option<ConnSpec>,
    pub group: Option<String>,
    pub favorite: bool,
    pub domain: Domain,
    pub ai_prefs: AiPrefs,
    pub last_used_ms: Option<u64>,
    /// The signature check failed: connect and test refuse (`mongoNeedsReview`) until the user saves the profile again.
    pub needs_review: bool,
    pub secrets: SecretFlags,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            color: String::new(),
            max_time_ms: DEFAULT_MAX_TIME_MS as u32,
            host: String::new(),
            host_level: EffectiveLevel::ProductionLevel,
            remote_host: None,
            safety: Safety::safe(None),
            has_uri: false,
            conn: None,
            group: None,
            favorite: false,
            domain: Domain::Generic,
            ai_prefs: AiPrefs::default(),
            last_used_ms: None,
            needs_review: false,
            secrets: SecretFlags::default(),
        }
    }
}

/// The read preference a spec asks for; `Auto` keeps the rule by level.
pub fn resolve_read_preference(level: EffectiveLevel, mode: ReadPrefMode) -> ReadPreference {
    match mode {
        ReadPrefMode::Auto => Profile::read_preference(level),
        ReadPrefMode::Primary => ReadPreference::Primary,
        ReadPrefMode::PrimaryPreferred => ReadPreference::PrimaryPreferred,
        ReadPrefMode::Secondary => ReadPreference::Secondary,
        ReadPrefMode::SecondaryPreferred => ReadPreference::SecondaryPreferred,
        ReadPrefMode::Nearest => ReadPreference::Nearest,
    }
}

impl Profile {
    /// `Err(mongoNeedsReview)` while the signature check is failing. Every connect and test goes through this.
    pub fn require_reviewed(&self) -> Result<()> {
        if self.needs_review {
            return Err(StudioError::new(code::NEEDS_REVIEW, format!("The connection settings of \"{}\" were changed outside the IDE. Review and save them again.", self.name)));
        }
        Ok(())
    }

    /// `max(tag, host rule)`. The host rule comes from the live URI when given (authoritative), else from save time.
    pub fn effective_level(&self, actual: Option<&HostInfo>) -> EffectiveLevel {
        let (host_rule, remote) = match actual {
            Some(i) => (host::effective_level(i), host::first_remote_host(i).map(str::to_string)),
            None => (self.host_level, self.remote_host.clone()),
        };
        let lowered = host_rule == EffectiveLevel::ProductionLevel
            && matches!((&self.safety.level_override, &remote), (Some(typed), Some(r)) if typed.eq_ignore_ascii_case(r));
        let host_level = if lowered { EffectiveLevel::Local } else { host_rule };
        if self.safety.environment == Environment::Production || host_level == EffectiveLevel::ProductionLevel {
            EffectiveLevel::ProductionLevel
        } else {
            EffectiveLevel::Local
        }
    }

    pub fn read_preference(level: EffectiveLevel) -> ReadPreference {
        match level {
            EffectiveLevel::Local => ReadPreference::PrimaryPreferred,
            EffectiveLevel::ProductionLevel => ReadPreference::SecondaryPreferred,
        }
    }

    pub fn view(&self) -> ProfileView {
        let level = self.effective_level(None);
        ProfileView {
            id: self.id.clone(),
            name: self.name.clone(),
            environment: self.safety.environment,
            color: self.color.clone(),
            read_only: self.safety.read_only,
            ai_mode: self.safety.ai_mode,
            tenant_lock: self.safety.tenant_lock.clone(),
            level_override: self.safety.level_override.is_some(),
            host: self.host.clone(),
            has_uri: self.has_uri || self.conn.is_some(),
            host_level: self.host_level,
            effective_level: level,
            read_preference: resolve_read_preference(level, self.conn.as_ref().map_or(ReadPrefMode::Auto, |c| c.topology.read_preference)),
            max_time_ms: self.max_time_ms,
            spec: self.conn.clone(),
            legacy_uri: self.conn.is_none() && self.has_uri,
            needs_review: self.needs_review,
            has_password: self.secrets.password,
            has_key_password: self.secrets.key_password,
            has_ssh_secret: self.secrets.ssh_secret,
            has_proxy_password: self.secrets.proxy_password,
            group: self.group.clone(),
            favorite: self.favorite,
            domain: self.domain,
            ai_prefs: self.ai_prefs.clone(),
            tls_relax: self.safety.tls_relax,
            last_used_ms: self.last_used_ms.map(|m| m as f64),
            uri_masked: self
                .conn
                .as_ref()
                .and_then(|c| crate::connstring::render(c, &crate::connstring::RenderSecrets::default(), crate::connstring::Mask::Masked).ok())
                .unwrap_or_default(),
        }
    }
}

pub struct ProfileStore {
    settings: Arc<SettingsStore>,
    secrets: Arc<dyn SecretStore>,
    guard: Mutex<()>,
    notices: Mutex<Vec<Notice>>,
    key: Mutex<Option<Vec<u8>>>,
    /// Newest revision per profile as the secret store holds it, plus the persisted "in review" flag (a trailing `!` in the
    /// item: an outside edit of settings.json cannot clear it). Read once per process, then kept here.
    revs: Mutex<std::collections::HashMap<String, (Option<u64>, bool)>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn uri_key(id: &str) -> String {
    format!("uri.{id}")
}

fn rev_key(id: &str) -> String {
    format!("rev.{id}")
}

fn sec_key(id: &str) -> String {
    format!("sec.{id}")
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

pub(crate) fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let (mut ipad, mut opad) = ([0x36u8; 64], [0x5cu8; 64]);
    for i in 0..64 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let inner = Sha256::new().chain_update(ipad).chain_update(msg).finalize();
    Sha256::new().chain_update(opad).chain_update(inner).finalize().into()
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn random_bytes<const N: usize>() -> [u8; N] {
    use std::io::Read;
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let mut out = [0u8; N];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut out)).is_ok() {
        return out;
    }
    // No /dev/urandom: stretch time, pid and a counter. Only reached on a broken system.
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let seed = Sha256::new().chain_update(t.to_le_bytes()).chain_update(std::process::id().to_le_bytes()).chain_update(SEQ.fetch_add(1, Ordering::Relaxed).to_le_bytes()).finalize();
    for (i, b) in out.iter_mut().enumerate() {
        *b = seed[i % 32];
    }
    out
}

fn signing_string(id: &str, s: &Safety, host_level: EffectiveLevel, remote_host: Option<&str>, rev: u64) -> String {
    format!("{}\u{1f}{rev}", signing_string_v1(id, s, host_level, remote_host).replacen("v1", "v2", 1))
}

fn domain_str(d: Option<Domain>) -> &'static str {
    d.map_or("", Domain::as_str)
}

fn glossary_hash(p: &AiPrefs) -> String {
    let joined = p.glossary.iter().map(|g| format!("{}\u{1f}{}", g.from, g.to)).collect::<Vec<_>>().join("\u{1e}");
    sha256_hex(joined.as_bytes())
}

/// The v3 string: v2 plus the relax flag, the sorted deny list, the preset, the glossary hash and the connection hash.
#[allow(clippy::too_many_arguments)]
fn signing_string_v3(id: &str, s: &Safety, host_level: EffectiveLevel, remote_host: Option<&str>, domain: Option<Domain>, ai: &AiPrefs, conn_hash: &str, rev: u64) -> String {
    let mut deny = ai.deny_fields.clone();
    deny.sort();
    format!(
        "v3\u{1f}{id}\u{1f}{:?}\u{1f}{}\u{1f}{:?}\u{1f}{}\u{1f}{}\u{1f}{:?}\u{1f}{}\u{1f}{:?}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{conn_hash}\u{1f}{rev}",
        s.environment,
        s.read_only,
        s.ai_mode,
        s.tenant_lock.as_deref().unwrap_or(""),
        s.level_override.as_deref().unwrap_or(""),
        host_level,
        remote_host.unwrap_or(""),
        s.tls_relax,
        deny.join("\u{1e}"),
        domain_str(domain),
        glossary_hash(ai),
    )
}

/// The signature format before the revision counter existed; accepted once, to upgrade a profile saved by an older build.
fn signing_string_v1(id: &str, s: &Safety, host_level: EffectiveLevel, remote_host: Option<&str>) -> String {
    format!(
        "v1\u{1f}{id}\u{1f}{:?}\u{1f}{}\u{1f}{:?}\u{1f}{}\u{1f}{}\u{1f}{:?}\u{1f}{}",
        s.environment,
        s.read_only,
        s.ai_mode,
        s.tenant_lock.as_deref().unwrap_or(""),
        s.level_override.as_deref().unwrap_or(""),
        host_level,
        remote_host.unwrap_or("")
    )
}

impl ProfileStore {
    pub fn new(settings: Arc<SettingsStore>, secrets: Arc<dyn SecretStore>) -> Self {
        Self { settings, secrets, guard: Mutex::new(()), notices: Mutex::new(Vec::new()), key: Mutex::new(None), revs: Mutex::new(Default::default()) }
    }

    pub fn settings_dir(&self) -> std::path::PathBuf {
        self.settings.path().parent().map(std::path::Path::to_path_buf).unwrap_or_default()
    }

    pub fn enabled(&self) -> bool {
        self.settings.get(NS).ok().and_then(|o| o.get("enabled").and_then(Value::as_bool)).unwrap_or(false)
    }

    pub fn set_enabled(&self, on: bool) -> Result<()> {
        let mut patch = Object::new();
        patch.insert("enabled".into(), Value::Bool(on));
        self.settings.set(NS, patch)?;
        Ok(())
    }

    /// The persisted `mongo.happyPreset` switch (cosmetic and unsigned, but the Rust side still honours it).
    pub fn happy_preset(&self) -> bool {
        self.settings.get(NS).ok().and_then(|o| o.get("happyPreset").and_then(Value::as_bool)).unwrap_or(false)
    }

    /// D26, once per machine: the first time this build starts where profiles already exist, the Happy preset switch is
    /// turned on (those profiles are read as Happy, D14). The marker `happyPresetMigrated` is written either way, so a
    /// later "off" stays off and a fresh install never flips. A switch the user already set is left alone. Returns
    /// whether the switch was turned on. Unreadable settings are not touched.
    pub fn migrate_happy_preset(&self) -> Result<bool> {
        let ns = self.settings.get(NS)?;
        if ns.get("happyPresetMigrated").and_then(Value::as_bool) == Some(true) {
            return Ok(false);
        }
        let has_profiles = ns.get("profiles").and_then(Value::as_object).is_some_and(|p| !p.is_empty());
        let turn_on = has_profiles && !ns.contains_key("happyPreset");
        let mut patch = Object::new();
        patch.insert("happyPresetMigrated".into(), Value::Bool(true));
        if turn_on {
            patch.insert("happyPreset".into(), Value::Bool(true));
        }
        self.settings.set(NS, patch)?;
        Ok(turn_on)
    }

    pub fn notices(&self) -> Vec<Notice> {
        lock(&self.notices).clone()
    }

    pub fn push_notice(&self, n: Notice) {
        lock(&self.notices).push(n);
    }

    pub fn clear_notices(&self) {
        lock(&self.notices).clear();
    }

    /// The signing key: minted on first use and kept only in the secret store. If it is gone every signature fails,
    /// which resets the profiles to the safe defaults (fail closed).
    fn tamper_key(&self) -> Result<Vec<u8>> {
        // Cached for the process: a signature check on every run must not touch the Keychain every time.
        if let Some(k) = lock(&self.key).clone() {
            return Ok(k);
        }
        let key = match self.secrets.get(TAMPER_KEY)? {
            Some(k) => k.expose().as_bytes().to_vec(),
            None => {
                let key = hex(&random_bytes::<32>());
                self.secrets.set(TAMPER_KEY, Secret::new(key.clone()))?;
                key.into_bytes()
            }
        };
        *lock(&self.key) = Some(key.clone());
        Ok(key)
    }

    fn sign(&self, id: &str, s: &Safety, host_level: EffectiveLevel, remote_host: Option<&str>, rev: u64) -> Result<String> {
        Ok(hex(&hmac_sha256(&self.tamper_key()?, signing_string(id, s, host_level, remote_host, rev).as_bytes())))
    }

    fn sign_v1(&self, id: &str, s: &Safety, host_level: EffectiveLevel, remote_host: Option<&str>) -> Result<String> {
        Ok(hex(&hmac_sha256(&self.tamper_key()?, signing_string_v1(id, s, host_level, remote_host).as_bytes())))
    }

    fn sign_v3(&self, id: &str, st: &Stored, rev: u64) -> Result<String> {
        let conn_hash = st.conn.as_ref().map(ConnSpec::conn_hash).unwrap_or_default();
        let msg = signing_string_v3(id, &st.safety, st.host_level, st.remote_host.as_deref(), st.domain, &st.ai_prefs, &conn_hash, rev);
        Ok(hex(&hmac_sha256(&self.tamper_key()?, msg.as_bytes())))
    }

    fn rev_state(&self, id: &str) -> Result<(Option<u64>, bool)> {
        if let Some(r) = lock(&self.revs).get(id) {
            return Ok(*r);
        }
        let raw = self.secrets.get(&rev_key(id))?;
        let st = raw.map_or((None, false), |s| {
            let t = s.expose();
            let (num, flag) = t.strip_suffix('!').map_or((t, false), |n| (n, true));
            (num.parse::<u64>().ok(), flag)
        });
        lock(&self.revs).insert(id.to_string(), st);
        Ok(st)
    }

    /// The newest revision of a profile as the secret store remembers it (`None` before the first save under this scheme).
    fn secret_rev(&self, id: &str) -> Result<Option<u64>> {
        Ok(self.rev_state(id)?.0)
    }

    fn write_rev(&self, id: &str, rev: u64, review: bool) -> Result<()> {
        self.secrets.set(&rev_key(id), Secret::new(if review { format!("{rev}!") } else { rev.to_string() }))?;
        lock(&self.revs).insert(id.to_string(), (Some(rev), review));
        Ok(())
    }

    /// Records a revision and keeps the review flag as it is.
    fn set_rev(&self, id: &str, rev: u64) -> Result<()> {
        let review = self.rev_state(id)?.1;
        self.write_rev(id, rev, review)
    }

    fn raw_profiles(&self) -> Result<Object> {
        let ns = self.settings.get(NS)?;
        Ok(ns.get("profiles").and_then(Value::as_object).cloned().unwrap_or_default())
    }

    fn write_profiles(&self, map: Object) -> Result<()> {
        let mut patch = Object::new();
        patch.insert("profiles".into(), Value::Object(map));
        self.settings.set(NS, patch)?;
        Ok(())
    }

    fn read_bundle(&self, id: &str) -> Result<Option<SecretBundle>> {
        let Some(s) = self.secrets.get(&sec_key(id))? else { return Ok(None) };
        Ok(serde_json::from_str::<SecretBundle>(s.expose()).ok())
    }

    fn write_bundle(&self, id: &str, b: &SecretBundle) -> Result<()> {
        if b.is_empty() {
            return Ok(self.secrets.remove(&sec_key(id))?);
        }
        let json = serde_json::to_string(b).map_err(|e| StudioError::new(code::SETTINGS, e.to_string()))?;
        Ok(self.secrets.set(&sec_key(id), Secret::new(json))?)
    }

    fn secret_flags(&self, id: &str, conn: Option<&ConnSpec>) -> SecretFlags {
        let (Some(conn), Ok(Some(b))) = (conn, self.read_bundle(id)) else { return SecretFlags::default() };
        if b.identity != conn.secret_identity() {
            return SecretFlags::default();
        }
        SecretFlags { password: b.password.is_some(), key_password: b.key_password.is_some(), ssh_secret: b.ssh_secret.is_some(), proxy_password: b.proxy_password.is_some(), identity_matches: true }
    }

    fn to_profile(&self, id: &str, s: Stored, with_secrets: bool, needs_review: bool) -> Profile {
        let has_uri = with_secrets && self.secrets.has(&uri_key(id)).unwrap_or(false);
        let secrets = if with_secrets && !needs_review { self.secret_flags(id, s.conn.as_ref()) } else { SecretFlags::default() };
        let domain = s.domain_or_legacy();
        Profile {
            id: id.to_string(),
            name: s.name,
            color: s.color,
            max_time_ms: s.max_time_ms.clamp(1_000, MAX_TIME_CEILING_MS as u32),
            host: s.host,
            host_level: s.host_level,
            remote_host: s.remote_host,
            safety: s.safety,
            has_uri,
            conn: s.conn,
            group: s.group,
            favorite: s.favorite,
            domain,
            ai_prefs: s.ai_prefs,
            last_used_ms: s.last_used_ms,
            needs_review,
            secrets,
        }
    }

    /// Every profile, verified. A failed signature resets that profile's safety fields and records a notice.
    pub fn list(&self) -> Result<Vec<Profile>> {
        let _g = lock(&self.guard);
        self.load_locked(true)
    }

    /// One profile re-verified without touching the Keychain (`has_uri` and the secret flags are false): the run path
    /// uses this so that a tampered safety field is caught before every operation.
    pub fn verified(&self, id: &str) -> Result<Profile> {
        let _g = lock(&self.guard);
        self.load_locked(false)?.into_iter().find(|p| p.id == id).ok_or_else(|| StudioError::new(code::NOT_FOUND, "no such connection"))
    }

    /// [`verified`](Self::verified) that also answers `mongoNeedsReview` for a profile whose signature check failed: what
    /// connect and test call before they touch a secret, a file or the network.
    pub fn connectable(&self, id: &str) -> Result<Profile> {
        let p = self.verified(id)?;
        p.require_reviewed()?;
        Ok(p)
    }

    fn load_locked(&self, with_secrets: bool) -> Result<Vec<Profile>> {
        let mut map = self.raw_profiles()?;
        let mut out = Vec::new();
        let mut dirty = false;
        let ids: Vec<String> = map.keys().cloned().collect();
        for id in ids {
            let Ok(mut stored) = serde_json::from_value::<Stored>(map[&id].clone()) else {
                lock(&self.notices).push(Notice { profile_id: id.clone(), message: "A saved connection could not be read and was removed.".into() });
                map.remove(&id);
                dirty = true;
                continue;
            };
            let secret_rev = self.secret_rev(&id)?;
            let mut review = false;
            if stored.sigv >= 3 {
                // v3: any mismatch (including a `sigv` downgrade, which signs a different string) or an older signed copy
                // puts the profile into review. Nothing is rewritten: the record stays as it is until the user saves it.
                let sig_ok = constant_time_eq(&self.sign_v3(&id, &stored, stored.rev)?, &stored.sig);
                let replayed = sig_ok && secret_rev.is_some_and(|r| stored.rev < r);
                review = !sig_ok || replayed || self.rev_state(&id)?.1;
                if !review && secret_rev.is_none_or(|r| r < stored.rev) {
                    self.set_rev(&id, stored.rev)?;
                }
            } else if stored.has_v3_extras() {
                // a legacy record that gained `conn`, a relax flag, a deny list or a preset: those are not covered by
                // its signature, so they were written from outside
                review = true;
            } else {
                let expected = self.sign(&id, &stored.safety, stored.host_level, stored.remote_host.as_deref(), stored.rev)?;
                let sig_ok = constant_time_eq(&expected, &stored.sig);
                let legacy_ok = !sig_ok && stored.rev == 0 && secret_rev.is_none() && constant_time_eq(&self.sign_v1(&id, &stored.safety, stored.host_level, stored.remote_host.as_deref())?, &stored.sig);
                // an older signed copy put back into settings.json: valid signature, but not the newest revision
                let replayed = sig_ok && secret_rev.is_some_and(|r| stored.rev < r);
                if legacy_ok {
                    stored.rev = 1;
                    stored.sig = self.sign(&id, &stored.safety, stored.host_level, stored.remote_host.as_deref(), 1)?;
                    self.set_rev(&id, 1)?;
                    map.insert(id.clone(), serde_json::to_value(&stored).unwrap_or(Value::Null));
                    dirty = true;
                } else if !sig_ok || replayed {
                    stored.safety = Safety::safe(stored.safety.tenant_lock.clone());
                    stored.rev = secret_rev.unwrap_or(0).max(stored.rev) + 1;
                    stored.sig = self.sign(&id, &stored.safety, stored.host_level, stored.remote_host.as_deref(), stored.rev)?;
                    self.set_rev(&id, stored.rev)?;
                    lock(&self.notices).push(Notice {
                        profile_id: id.clone(),
                        message: format!("The safety settings of \"{}\" were changed outside the IDE. They were reset to read-only, AI off and the Production tag.", stored.name),
                    });
                    map.insert(id.clone(), serde_json::to_value(&stored).unwrap_or(Value::Null));
                    dirty = true;
                } else if secret_rev.is_none_or(|r| r < stored.rev) {
                    self.set_rev(&id, stored.rev)?;
                }
            }
            if review {
                // fail closed in memory: read-only, AI off, Production, no relax, and none of the stored host facts is trusted
                stored.safety = Safety::safe(stored.safety.tenant_lock.clone());
                stored.host_level = EffectiveLevel::ProductionLevel;
                stored.remote_host = None;
                // the flag is persisted in the secret store: it survives a restart and an outside edit, and only a save clears it
                if !self.rev_state(&id)?.1 {
                    self.write_rev(&id, secret_rev.unwrap_or(0).max(stored.rev), true)?;
                    lock(&self.notices).push(Notice { profile_id: id.clone(), message: format!("Connection settings of {} were changed outside the IDE. Review and save them again.", stored.name) });
                }
            }
            out.push(self.to_profile(&id, stored, with_secrets, review));
        }
        if dirty {
            self.write_profiles(map)?;
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.id.cmp(&b.id)));
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Result<Profile> {
        self.list()?.into_iter().find(|p| p.id == id).ok_or_else(|| StudioError::new(code::NOT_FOUND, "no such connection"))
    }

    /// The saved legacy connection string. Rust-side only: nothing returns it to the webview.
    pub fn uri(&self, id: &str) -> Result<Option<Secret>> {
        Ok(self.secrets.get(&uri_key(id))?)
    }

    /// Where secrets live right now, and which of this profile's secrets exist for its current connection.
    pub fn secrets_status(&self, id: Option<&str>) -> Result<SecretsStatus> {
        let h = self.secrets.health();
        let store = match (h.backend, h.degraded) {
            ("keychain", false) => SecretStoreKind::Keychain,
            ("memory", _) | ("keychain", true) => SecretStoreKind::Session,
            _ => SecretStoreKind::Unavailable,
        };
        let f = match id {
            Some(id) => self.get(id)?.secrets,
            None => SecretFlags::default(),
        };
        Ok(SecretsStatus { store, has_password: f.password, has_key_password: f.key_password, has_ssh_secret: f.ssh_secret, has_proxy_password: f.proxy_password, identity_matches: f.identity_matches })
    }

    /// Stores (or, with `None`, clears) one secret under the CURRENT connection identity. Reading back is impossible. A
    /// profile in review, a legacy profile and a secret whose `save_*` switch is off are refused.
    pub fn set_secret(&self, id: &str, kind: SecretKind, value: Option<WireSecret>) -> Result<Profile> {
        let _g = lock(&self.guard);
        let p = self.load_locked(true)?.into_iter().find(|p| p.id == id).ok_or_else(|| StudioError::new(code::NOT_FOUND, "no such connection"))?;
        p.require_reviewed()?;
        let conn = p.conn.as_ref().ok_or_else(|| StudioError::new(code::INVALID, "convert this connection to fields first"))?;
        let may_save = match kind {
            SecretKind::Password => conn.auth.save_password && conn.auth.mechanism.uses_password(),
            SecretKind::KeyPassword => conn.tls.save_key_password,
            SecretKind::SshSecret => matches!(&conn.tunnel, Tunnel::Ssh(s) if s.save_secret && s.auth != TunnelAuth::Agent),
            SecretKind::ProxyPassword => matches!(&conn.tunnel, Tunnel::Socks5(x) if x.save_password),
        };
        let identity = conn.secret_identity();
        let mut b = self.read_bundle(id)?.filter(|b| b.identity == identity).unwrap_or_else(|| SecretBundle { identity, password: None, key_password: None, ssh_secret: None, proxy_password: None });
        match value.filter(|v| !v.is_empty()) {
            Some(v) => {
                if !may_save {
                    return Err(StudioError::new(code::INVALID, "saving this secret is switched off for this connection"));
                }
                *b.slot(kind) = Some(v.expose().to_string());
            }
            None => *b.slot(kind) = None,
        }
        self.write_bundle(id, &b)?;
        drop(b);
        Ok(self.load_locked(true)?.into_iter().find(|p| p.id == id).ok_or_else(|| StudioError::new(code::NOT_FOUND, "no such connection"))?)
    }

    /// The secrets a test or a connect may use for `spec`: what the caller supplies now, else what is stored for the SAME
    /// connection identity. A stored secret typed for another destination is never returned. Missing required secrets
    /// are `mongoNeedSecret` with `needs:<kinds>`, BEFORE any connect, scan or spawn.
    pub fn resolve_secrets(&self, id: Option<&str>, spec: &ConnSpec, supplied: &SessionSecrets) -> Result<ConnSecrets> {
        let mut stored: Option<SecretBundle> = None;
        if let Some(id) = id {
            match self.verified(id) {
                Ok(p) => {
                    p.require_reviewed()?;
                    stored = self.read_bundle(id)?.filter(|b| b.identity == spec.secret_identity());
                }
                Err(e) if e.code == code::NOT_FOUND => {}
                Err(e) => return Err(e),
            }
        }
        let pick = |s: &Option<WireSecret>, st: Option<&String>| s.as_ref().filter(|x| !x.is_empty()).map(|x| Secret::new(x.expose())).or_else(|| st.map(|v| Secret::new(v.as_str())));
        let out = ConnSecrets {
            password: pick(&supplied.password, stored.as_ref().and_then(|b| b.password.as_ref())),
            key_password: pick(&supplied.key_password, stored.as_ref().and_then(|b| b.key_password.as_ref())),
            ssh_secret: pick(&supplied.ssh_secret, stored.as_ref().and_then(|b| b.ssh_secret.as_ref())),
            proxy_password: pick(&supplied.proxy_password, stored.as_ref().and_then(|b| b.proxy_password.as_ref())),
        };
        let mut needs: Vec<&str> = Vec::new();
        if spec.auth.mechanism.uses_password() && spec.auth.username.as_deref().is_some_and(|u| !u.is_empty()) && out.password.is_none() {
            needs.push(SecretKind::Password.as_str());
        }
        match &spec.tunnel {
            Tunnel::Ssh(s) if s.auth == TunnelAuth::Password && out.ssh_secret.is_none() => needs.push(SecretKind::SshSecret.as_str()),
            Tunnel::Socks5(p) if p.username.as_deref().is_some_and(|u| !u.is_empty()) && out.proxy_password.is_none() => needs.push(SecretKind::ProxyPassword.as_str()),
            _ => {}
        }
        if !needs.is_empty() {
            return Err(StudioError::new(code::NEED_SECRET, format!("needs:{}", needs.join(","))));
        }
        Ok(out)
    }

    /// Cosmetic edits (group, favourite, colour): no re-signing, no typed confirmation, nothing signed is touched.
    pub fn set_meta(&self, id: &str, meta: ProfileMeta) -> Result<Profile> {
        let _g = lock(&self.guard);
        let mut map = self.raw_profiles()?;
        let rec = map.get_mut(id).and_then(Value::as_object_mut).ok_or_else(|| StudioError::new(code::NOT_FOUND, "no such connection"))?;
        if let Some(g) = meta.group.as_deref() {
            let g = g.trim();
            if g.chars().count() > 40 || g.chars().any(char::is_control) {
                return Err(StudioError::new(code::INVALID, "a group name is at most 40 characters"));
            }
            if g.is_empty() {
                rec.remove("group");
            } else {
                rec.insert("group".into(), Value::String(g.to_string()));
            }
        }
        if let Some(f) = meta.favorite {
            rec.insert("favorite".into(), Value::Bool(f));
        }
        if let Some(c) = meta.color.as_deref() {
            if c.chars().count() > 32 || c.chars().any(char::is_control) {
                return Err(StudioError::new(code::INVALID, "not a colour"));
            }
            rec.insert("color".into(), Value::String(c.to_string()));
        }
        self.write_profiles(map)?;
        self.load_locked(true)?.into_iter().find(|p| p.id == id).ok_or_else(|| StudioError::new(code::NOT_FOUND, "no such connection"))
    }

    /// Records a successful connect (cosmetic, unsigned).
    pub fn mark_used(&self, id: &str, now_ms: u64) -> Result<()> {
        let _g = lock(&self.guard);
        let mut map = self.raw_profiles()?;
        if let Some(rec) = map.get_mut(id).and_then(Value::as_object_mut) {
            rec.insert("lastUsedMs".into(), Value::from(now_ms));
            self.write_profiles(map)?;
        }
        Ok(())
    }

    pub fn save(&self, input: ProfileInput) -> Result<Profile> {
        let _g = lock(&self.guard);
        let name = input.name.trim().to_string();
        if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
            return Err(StudioError::new(code::INVALID, "a connection name is 1 to 64 characters"));
        }
        let new_uri_text = input.uri.as_ref().map(|u| u.expose().trim()).filter(|u| !u.is_empty());
        if new_uri_text.is_some() && input.spec.is_some() {
            return Err(StudioError::new(code::INVALID, "send a connection string or fields, not both"));
        }
        if let Some(e) = input.spec.as_ref().and_then(|s| s.errors().into_iter().next()) {
            return Err(StudioError::new(code::INVALID, format!("config.invalid: {} ({})", e.code, e.path)));
        }
        let existing = self.load_locked(true)?;
        let old = match &input.id {
            Some(id) => Some(existing.iter().find(|p| &p.id == id).cloned().ok_or_else(|| StudioError::new(code::NOT_FOUND, "no such connection"))?),
            None => None,
        };
        let id = old.as_ref().map_or_else(|| format!("c{}", hex(&random_bytes::<6>())), |p| p.id.clone());
        let old_review = old.as_ref().is_some_and(|p| p.needs_review);
        if old_review && old.as_ref().is_some_and(|p| p.conn.is_some()) && input.spec.is_none() {
            return Err(StudioError::new(code::NEEDS_REVIEW, "review the connection settings and save them again"));
        }

        // The connection: fields (a spec), a pasted legacy URI, or what is stored.
        let conn: Option<ConnSpec> = match (&input.spec, new_uri_text) {
            (Some(spec), _) => Some(spec.clone()),
            (None, Some(_)) if old.as_ref().is_some_and(|p| p.conn.is_some()) => {
                return Err(StudioError::new(code::INVALID, "this connection uses fields: edit them instead of pasting a string"));
            }
            (None, _) => old.as_ref().and_then(|p| p.conn.clone()),
        };
        let (info, new_uri) = match (&conn, new_uri_text) {
            (Some(_), _) => (None, None),
            (None, Some(u)) => {
                if u.len() > 4096 {
                    return Err(StudioError::new(code::INVALID, "the connection string is too long"));
                }
                let info = host::parse_uri(u).map_err(|e| StudioError::new(code::INVALID, format!("not a usable connection string: {}", host::redact(&e.0))))?;
                (Some(info), Some(u.to_string()))
            }
            (None, None) => (self.uri(&id)?.and_then(|s| host::parse_uri(s.expose()).ok()), None),
        };
        let (host_level, remote_host, display) = match (&conn, &info) {
            (Some(c), _) => (c.host_level(), c.remote_host(), host::display_host(&c.host_info())),
            (None, Some(i)) => (host::effective_level(i), host::first_remote_host(i).map(str::to_string), host::display_host(i)),
            (None, None) => old.as_ref().map_or((EffectiveLevel::ProductionLevel, None, String::new()), |p| (p.host_level, p.remote_host.clone(), p.host.clone())),
        };
        if conn.is_none() && new_uri.is_none() && old.is_none() {
            return Err(StudioError::new(code::NO_URI, "paste a connection string"));
        }

        // Safety fields: unchanged unless the input says otherwise; a new profile starts read-only with AI off.
        let base = old.as_ref().map_or_else(|| Safety { environment: input.environment, ..Safety::safe(None) }, |p| p.safety.clone());
        let mut s = Safety {
            read_only: input.read_only.unwrap_or(base.read_only),
            environment: input.environment,
            ai_mode: input.ai_mode.unwrap_or(base.ai_mode),
            tenant_lock: match input.tenant_lock.as_deref() {
                Some(t) => Some(t.trim().to_string()).filter(|t| !t.is_empty()),
                None => base.tenant_lock.clone(),
            },
            level_override: base.level_override.clone(),
            tls_relax: input.tls_relax.unwrap_or(base.tls_relax),
        };
        match input.level_override_host.as_deref() {
            Some(typed) if typed.trim().is_empty() => s.level_override = None,
            Some(typed) => match &remote_host {
                Some(expected) if expected.eq_ignore_ascii_case(typed.trim()) => s.level_override = Some(expected.clone()),
                Some(_) => return Err(StudioError::new(code::CONFIRM, "the typed host does not match the host of this connection")),
                None => return Err(StudioError::new(code::INVALID, "this connection is already local-level")),
            },
            None => {}
        }
        // A replaced connection keeps an override only if it still names the new connection's host.
        if let (Some(typed), true) = (&s.level_override, new_uri.is_some() || input.spec.is_some()) {
            if !remote_host.as_deref().is_some_and(|r| r.eq_ignore_ascii_case(typed)) {
                s.level_override = None;
            }
        }

        // AI wording and preset.
        let domain = input.domain.or(old.as_ref().map(|p| p.domain)).unwrap_or_default();
        // The Happy preset is offered only while its switch is on; a profile that already uses it keeps it. The UI hides
        // the choice too, but a direct IPC call must not be able to get around the switch.
        if domain == Domain::Happy && old.as_ref().map(|p| p.domain) != Some(Domain::Happy) && !self.happy_preset() {
            return Err(StudioError::new(code::INVALID, "config.happyPresetOff: the Happy preset is switched off (Settings > Database)"));
        }
        let ai_prefs = normalize_ai_prefs(input.ai_prefs.clone().unwrap_or_else(|| old.as_ref().map(|p| p.ai_prefs.clone()).unwrap_or_default()))?;

        // Relaxed certificate checks are refused at the EFFECTIVE Production level, not merely when the tag says so.
        if s.tls_relax != TlsRelax::None {
            let candidate = Profile { host_level, remote_host: remote_host.clone(), safety: s.clone(), ..Profile::default() };
            if candidate.effective_level(None) == EffectiveLevel::ProductionLevel {
                return Err(StudioError::new(code::INVALID, "config.tlsRelaxRefused: certificate checks cannot be skipped on a Production-level connection"));
            }
        }

        let lowered = (base.read_only && !s.read_only)
            || (base.ai_mode == AiMode::Off && s.ai_mode != AiMode::Off)
            || (base.ai_mode != AiMode::SchemaEnums && s.ai_mode == AiMode::SchemaEnums)
            || (base.level_override.is_none() && s.level_override.is_some())
            || (old.is_some() && base.environment == Environment::Production && s.environment != Environment::Production)
            || (base.tenant_lock.is_some() && s.tenant_lock.is_none())
            || (base.tls_relax == TlsRelax::None && s.tls_relax != TlsRelax::None)
            || old.as_ref().is_some_and(|p| p.ai_prefs.deny_fields.iter().any(|d| !ai_prefs.deny_fields.contains(d)));
        if lowered && input.confirm.as_deref() != Some(name.as_str()) {
            return Err(StudioError::new(code::CONFIRM, "this lowers a safety setting: type the connection name to confirm"));
        }

        // Secrets. A stored secret is kept only while the connection identity is unchanged (and the profile is not in
        // review); a fresh value replaces it; `Some("")` clears; a switch that is off is never written.
        if let Some(u) = &new_uri {
            self.secrets.set(&uri_key(&id), Secret::new(u.clone()))?;
        }
        if let Some(c) = &conn {
            let identity = c.secret_identity();
            let old_bundle = if old.is_some() && !old_review { self.read_bundle(&id)? } else { None };
            let keep = old_bundle.as_ref().filter(|b| b.identity == identity);
            let pick = |supplied: &Option<WireSecret>, kept: Option<&String>| -> Option<String> {
                match supplied {
                    Some(v) if v.is_empty() => None,
                    Some(v) => Some(v.expose().to_string()),
                    None => kept.cloned(),
                }
            };
            let mut nb = SecretBundle {
                identity,
                password: pick(&input.password, keep.and_then(|b| b.password.as_ref())),
                key_password: pick(&input.key_password, keep.and_then(|b| b.key_password.as_ref())),
                ssh_secret: pick(&input.ssh_secret, keep.and_then(|b| b.ssh_secret.as_ref())),
                proxy_password: pick(&input.proxy_password, keep.and_then(|b| b.proxy_password.as_ref())),
            };
            if !(c.auth.save_password && c.auth.mechanism.uses_password()) {
                nb.password = None;
            }
            if !c.tls.save_key_password {
                nb.key_password = None;
            }
            if !matches!(&c.tunnel, Tunnel::Ssh(t) if t.save_secret && t.auth != TunnelAuth::Agent) {
                nb.ssh_secret = None;
            }
            if !matches!(&c.tunnel, Tunnel::Socks5(x) if x.save_password) {
                nb.proxy_password = None;
            }
            self.write_bundle(&id, &nb)?;
            // converting a legacy profile: the old string goes
            if old.as_ref().is_some_and(|p| p.has_uri) {
                self.secrets.remove(&uri_key(&id))?;
            }
        }

        let max_time_ms = input.max_time_ms.map(|m| m.clamp(1_000, MAX_TIME_CEILING_MS as u32)).or(old.as_ref().map(|p| p.max_time_ms)).unwrap_or(DEFAULT_MAX_TIME_MS as u32);
        let color = input.color.clone().or(old.as_ref().map(|p| p.color.clone())).unwrap_or_default();
        let group = match input.group.as_deref() {
            Some(g) => {
                let g = g.trim();
                if g.chars().count() > 40 || g.chars().any(char::is_control) {
                    return Err(StudioError::new(code::INVALID, "a group name is at most 40 characters"));
                }
                Some(g.to_string()).filter(|g| !g.is_empty())
            }
            None => old.as_ref().and_then(|p| p.group.clone()),
        };
        let rev = self.secret_rev(&id)?.unwrap_or(0).max(old_stored_rev(&self.raw_profiles()?, &id)) + 1;
        let mut stored = Stored {
            name,
            color,
            max_time_ms,
            host: display,
            host_level,
            remote_host,
            safety: s,
            rev,
            sig: String::new(),
            sigv: 3,
            min_reader: 3,
            conn,
            group,
            favorite: input.favorite.or(old.as_ref().map(|p| p.favorite)).unwrap_or(false),
            domain: Some(domain),
            ai_prefs,
            last_used_ms: old.as_ref().and_then(|p| p.last_used_ms),
        };
        stored.sig = self.sign_v3(&id, &stored, rev)?;
        let mut map = self.raw_profiles()?;
        map.insert(id.clone(), serde_json::to_value(&stored).map_err(|e| StudioError::new(code::SETTINGS, e.to_string()))?);
        self.write_profiles(map)?;
        self.write_rev(&id, rev, false)?;
        Ok(self.to_profile(&id, stored, true, false))
    }

    /// Removes the profile and every secret-store account it owns (`uri.<id>`, `sec.<id>`, `rev.<id>`).
    pub fn delete(&self, id: &str) -> Result<()> {
        let _g = lock(&self.guard);
        let mut map = self.raw_profiles()?;
        if map.remove(id).is_none() {
            return Err(StudioError::new(code::NOT_FOUND, "no such connection"));
        }
        self.write_profiles(map)?;
        self.secrets.remove(&uri_key(id))?;
        self.secrets.remove(&sec_key(id))?;
        self.secrets.remove(&rev_key(id))?;
        lock(&self.revs).remove(id);
        Ok(())
    }

    /// A copy with a new id; secrets are copied inside the secret store and never read by the caller. A profile in review
    /// cannot be copied (the copy would be signed, which would bless the changed settings).
    pub fn duplicate(&self, id: &str) -> Result<Profile> {
        let _g = lock(&self.guard);
        let src = self.load_locked(true)?.into_iter().find(|p| p.id == id).ok_or_else(|| StudioError::new(code::NOT_FOUND, "no such connection"))?;
        src.require_reviewed()?;
        // A copy is a new Happy profile: the switch refuses it exactly as it refuses one saved from scratch.
        if src.domain == Domain::Happy && !self.happy_preset() {
            return Err(StudioError::new(code::INVALID, "config.happyPresetOff: the Happy preset is switched off (Settings > Database)"));
        }
        let new_id = format!("c{}", hex(&random_bytes::<6>()));
        if let Some(u) = self.secrets.get(&uri_key(id))? {
            self.secrets.set(&uri_key(&new_id), u)?;
        }
        if let Some(b) = self.secrets.get(&sec_key(id))? {
            self.secrets.set(&sec_key(&new_id), b)?;
        }
        let mut stored = Stored {
            name: format!("{} copy", src.name).chars().take(64).collect(),
            color: src.color.clone(),
            max_time_ms: src.max_time_ms,
            host: src.host.clone(),
            host_level: src.host_level,
            remote_host: src.remote_host.clone(),
            safety: src.safety.clone(),
            rev: 1,
            sig: String::new(),
            sigv: 3,
            min_reader: 3,
            conn: src.conn.clone(),
            group: src.group.clone(),
            favorite: false,
            domain: Some(src.domain),
            ai_prefs: src.ai_prefs.clone(),
            last_used_ms: None,
        };
        stored.sig = self.sign_v3(&new_id, &stored, 1)?;
        let mut map = self.raw_profiles()?;
        map.insert(new_id.clone(), serde_json::to_value(&stored).map_err(|e| StudioError::new(code::SETTINGS, e.to_string()))?);
        self.write_profiles(map)?;
        self.set_rev(&new_id, 1)?;
        Ok(self.to_profile(&new_id, stored, true, false))
    }
}

/// The revision written in the record itself (0 when absent): a save must go above both it and the secret store's.
fn old_stored_rev(map: &Object, id: &str) -> u64 {
    map.get(id).and_then(|v| v.get("rev")).and_then(Value::as_u64).unwrap_or(0)
}

/// Trims, de-duplicates and bounds the AI wording lists (at most 200 deny fields and 50 glossary pairs of 64 characters).
fn normalize_ai_prefs(p: AiPrefs) -> Result<AiPrefs> {
    let bad = |m: &str| Err(StudioError::new(code::INVALID, m.to_string()));
    let mut deny: Vec<String> = Vec::new();
    for d in p.deny_fields {
        let d = d.trim().to_string();
        if d.is_empty() || deny.contains(&d) {
            continue;
        }
        if d.chars().count() > 64 || d.chars().any(char::is_control) {
            return bad("a denied field name is at most 64 characters");
        }
        deny.push(d);
    }
    if deny.len() > 200 {
        return bad("at most 200 denied fields");
    }
    if p.glossary.len() > 50 {
        return bad("at most 50 glossary pairs");
    }
    let mut glossary = Vec::new();
    for g in p.glossary {
        let (from, to) = (g.from.trim().to_string(), g.to.trim().to_string());
        if from.is_empty() || to.is_empty() {
            continue;
        }
        if from.chars().count() > 64 || to.chars().count() > 64 || from.chars().chain(to.chars()).any(char::is_control) {
            return bad("a glossary entry is at most 64 characters");
        }
        glossary.push(crate::api::GlossaryPair { from, to });
    }
    Ok(AiPrefs { deny_fields: deny, glossary })
}

#[cfg(test)]
mod tests {
    use super::*;
    use intely_settings::MemorySecretStore;

    #[test]
    fn a_record_signed_before_the_revision_counter_is_upgraded_without_a_notice() {
        use intely_settings::MemorySecretStore;
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemorySecretStore::new());
        let settings = Arc::new(SettingsStore::open(dir.path().join("settings.json")).unwrap());
        let store = ProfileStore::new(settings.clone(), secrets.clone());
        let input = ProfileInput { name: "Old".into(), environment: Environment::Sandbox, uri: Some("mongodb://127.0.0.1/intely_test_x".into()), ..Default::default() };
        let p = store.save(input).unwrap();
        // rewrite the record the way an older build stored it: v1 signature, no revision anywhere
        let v1 = store.sign_v1(&p.id, &p.safety, p.host_level, p.remote_host.as_deref()).unwrap();
        let mut profiles = settings.get(NS).unwrap().get("profiles").and_then(Value::as_object).cloned().unwrap();
        let rec = profiles.get_mut(&p.id).unwrap().as_object_mut().unwrap();
        for k in ["rev", "sigv", "minReader", "domain", "aiPrefs"] {
            rec.remove(k);
        }
        rec.insert("sig".into(), Value::String(v1));
        let mut patch = Object::new();
        patch.insert("profiles".into(), Value::Object(profiles));
        settings.set(NS, patch).unwrap();
        secrets.remove(&rev_key(&p.id)).unwrap();
        let fresh = ProfileStore::new(settings, secrets);
        let got = fresh.list().unwrap().remove(0);
        assert_eq!(got.safety.environment, Environment::Sandbox, "the Sandbox tag survives the upgrade");
        assert!(fresh.notices().is_empty());
        assert_eq!(fresh.secret_rev(&p.id).unwrap(), Some(1));
        assert!(fresh.list().unwrap()[0].safety.environment == Environment::Sandbox && fresh.notices().is_empty());
    }

    fn legacy_fixture() -> (tempfile::TempDir, Arc<MemorySecretStore>, Arc<SettingsStore>, ProfileStore, Profile) {
        use intely_settings::MemorySecretStore;
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemorySecretStore::new());
        let settings = Arc::new(SettingsStore::open(dir.path().join("settings.json")).unwrap());
        let store = ProfileStore::new(settings.clone(), secrets.clone());
        let p = store.save(ProfileInput { name: "Old".into(), environment: Environment::Sandbox, uri: Some("mongodb://127.0.0.1/intely_test_x".into()), ..Default::default() }).unwrap();
        (dir, secrets, settings, store, p)
    }

    /// Rewrites the record the way a v2 build stored it (no sigv, domain, aiPrefs; a v2 signature at the same revision).
    fn downgrade_to_v2(store: &ProfileStore, settings: &SettingsStore, p: &Profile, rev: u64) {
        let sig = store.sign(&p.id, &p.safety, p.host_level, p.remote_host.as_deref(), rev).unwrap();
        let mut profiles = settings.get(NS).unwrap().get("profiles").and_then(Value::as_object).cloned().unwrap();
        let rec = profiles.get_mut(&p.id).unwrap().as_object_mut().unwrap();
        for k in ["sigv", "minReader", "domain", "aiPrefs"] {
            rec.remove(k);
        }
        rec.insert("rev".into(), Value::from(rev));
        rec.insert("sig".into(), Value::String(sig));
        let mut patch = Object::new();
        patch.insert("profiles".into(), Value::Object(profiles));
        settings.set(NS, patch).unwrap();
    }

    #[test]
    fn a_v2_record_still_loads_as_the_happy_preset_and_is_re_signed_v3_only_when_edited() {
        let (_dir, secrets, settings, store, p) = legacy_fixture();
        let rev = store.secret_rev(&p.id).unwrap().unwrap();
        downgrade_to_v2(&store, &settings, &p, rev);
        let fresh = ProfileStore::new(settings.clone(), secrets.clone());
        let got = fresh.list().unwrap().remove(0);
        assert_eq!(got.domain, Domain::Happy, "no sigv and no domain: behaviour preserved");
        assert!(!got.needs_review && fresh.notices().is_empty());
        let rec = settings.get(NS).unwrap()["profiles"][&p.id].clone();
        assert!(rec.get("sigv").is_none(), "loading does not rewrite a valid v2 record");
        // editing it re-signs v3 and names the preset
        let edited = fresh.save(ProfileInput { id: Some(p.id.clone()), name: "Old".into(), environment: Environment::Sandbox, max_time_ms: Some(20_000), ..Default::default() }).unwrap();
        assert_eq!(edited.domain, Domain::Happy, "an edit keeps the preset the profile was read as");
        let rec = settings.get(NS).unwrap()["profiles"][&p.id].clone();
        assert_eq!(rec["sigv"], 3);
        assert!(!ProfileStore::new(settings, secrets).list().unwrap()[0].needs_review);
    }

    #[test]
    fn a_v2_record_with_a_domain_a_relax_flag_or_a_deny_list_is_in_review() {
        for (k, v) in [("domain", serde_json::json!("generic")), ("aiPrefs", serde_json::json!({"denyFields": ["x"], "glossary": []}))] {
            let (_dir, secrets, settings, store, p) = legacy_fixture();
            let rev = store.secret_rev(&p.id).unwrap().unwrap();
            downgrade_to_v2(&store, &settings, &p, rev);
            let mut profiles = settings.get(NS).unwrap().get("profiles").and_then(Value::as_object).cloned().unwrap();
            profiles.get_mut(&p.id).unwrap().as_object_mut().unwrap().insert(k.into(), v);
            let mut patch = Object::new();
            patch.insert("profiles".into(), Value::Object(profiles));
            settings.set(NS, patch).unwrap();
            let fresh = ProfileStore::new(settings, secrets);
            assert!(fresh.list().unwrap()[0].needs_review, "{k}");
        }
    }

    #[test]
    fn hmac_matches_the_rfc_4231_vector() {
        let mac = hmac_sha256(&[0x0b; 20], b"Hi There");
        assert_eq!(hex(&mac), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
        // a key longer than the block size is hashed first (RFC 4231 test case 6)
        let mac = hmac_sha256(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First");
        assert_eq!(hex(&mac), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    }

    #[test]
    fn effective_level_is_the_max_of_tag_and_host_rule() {
        let p = |env, host_level, ov: Option<&str>| Profile {
            id: "c1".into(),
            name: "n".into(),
            color: String::new(),
            max_time_ms: 15_000,
            host: String::new(),
            host_level,
            remote_host: Some("db.example.com".into()),
            safety: Safety { read_only: true, environment: env, ai_mode: AiMode::Off, tenant_lock: None, level_override: ov.map(str::to_string), tls_relax: TlsRelax::None },
            has_uri: true,
            ..Profile::default()
        };
        use EffectiveLevel::*;
        assert_eq!(p(Environment::Local, Local, None).effective_level(None), Local);
        assert_eq!(p(Environment::Sandbox, Local, None).effective_level(None), Local);
        assert_eq!(p(Environment::Production, Local, None).effective_level(None), ProductionLevel);
        assert_eq!(p(Environment::Local, ProductionLevel, None).effective_level(None), ProductionLevel);
        // the typed host lowers the host rule, but never the tag
        assert_eq!(p(Environment::Sandbox, ProductionLevel, Some("DB.example.com")).effective_level(None), Local);
        assert_eq!(p(Environment::Production, ProductionLevel, Some("db.example.com")).effective_level(None), ProductionLevel);
        // the live URI is authoritative: a URI that moved to another host ignores the override
        let moved = host::parse_uri("mongodb://other.example.org/x").unwrap();
        assert_eq!(p(Environment::Sandbox, Local, Some("db.example.com")).effective_level(Some(&moved)), ProductionLevel);
        let same = host::parse_uri("mongodb://db.example.com/x").unwrap();
        assert_eq!(p(Environment::Sandbox, ProductionLevel, Some("db.example.com")).effective_level(Some(&same)), Local);
        // a loopback first host cannot be used to type away a remote second host
        let mixed = host::parse_uri("mongodb://127.0.0.1,db.example.com/x").unwrap();
        assert_eq!(host::first_remote_host(&mixed), Some("db.example.com"));
    }
}
