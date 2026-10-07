//! Types that cross the IPC boundary (exported to `ui/src/bindings/mongo.ts` by `pnpm bindings`). Counts are `u32`/`i32`
//! (specta refuses 64-bit integers), documents travel as canonical Extended JSON strings so Int64 never becomes a JS
//! number. **No type here carries a connection string out of Rust**: `ProfileInput.uri` goes in, nothing returns it.

use serde::{Deserialize, Serialize};

use crate::connspec::ConnSpec;
use crate::types::{EffectiveLevel, ReadCommand, RoleChip};

/// The user-set label. Cosmetic plus a default: the host rule can raise the level, the tag alone never lowers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum Environment {
    Local,
    Sandbox,
    #[default]
    Production,
}

/// P0 (nothing leaves the machine) and P1 (schema only). Samples (P2/P3) are M2 and cannot be expressed here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum AiMode {
    #[default]
    Off,
    SchemaOnly,
    /// Schema plus the value sets of low-cardinality, non-PII string fields (explicit consent, shown in the preview).
    SchemaEnums,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum ReadPreference {
    PrimaryPreferred,
    SecondaryPreferred,
    Primary,
    Secondary,
    Nearest,
}

impl ReadPreference {
    /// A secondary may serve the read.
    pub fn secondary_ok(self) -> bool {
        matches!(self, Self::Secondary | Self::SecondaryPreferred | Self::Nearest)
    }
}

/// Which preset a profile uses for AI wording. A record saved before presets existed has no domain and is read as `Happy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum Domain {
    #[default]
    Generic,
    Happy,
}

impl Domain {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Generic => "generic",
            Self::Happy => "happy",
        }
    }
}

/// Relaxed certificate checks (rustls honours only the certificate one; there is no hostname-only option).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum TlsRelax {
    #[default]
    None,
    Certificates,
}

/// A secret that crosses the IPC boundary inwards only. `Debug` prints a placeholder, the value is zeroed on drop, and
/// nothing in this crate serializes it back out.
#[derive(Clone, PartialEq, Eq, Default, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(transparent)]
pub struct WireSecret(String);

impl Serialize for WireSecret {
    /// Never writes the value: a secret cannot leave through serialization (events, state, logs), only come in.
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str("")
    }
}

impl WireSecret {
    pub fn new(v: impl Into<String>) -> Self {
        Self(v.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl From<&str> for WireSecret {
    fn from(v: &str) -> Self {
        Self(v.to_string())
    }
}

impl From<String> for WireSecret {
    fn from(v: String) -> Self {
        Self(v)
    }
}

impl std::fmt::Debug for WireSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WireSecret([redacted])")
    }
}

impl Drop for WireSecret {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.0);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct GlossaryPair {
    pub from: String,
    pub to: String,
}

/// Per-profile AI wording. Both lists are signed (they can only be loosened through a typed confirmation).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AiPrefs {
    #[serde(default)]
    pub deny_fields: Vec<String>,
    #[serde(default)]
    pub glossary: Vec<GlossaryPair>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum TunnelState {
    Up,
    Down,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub id: String,
    pub name: String,
    pub environment: Environment,
    pub color: String,
    pub read_only: bool,
    pub ai_mode: AiMode,
    pub tenant_lock: Option<String>,
    /// A typed-host override lowers the host rule for this connection (shown as a chip).
    pub level_override: bool,
    /// Masked display host, computed at save time. Never the URI.
    pub host: String,
    pub has_uri: bool,
    /// What the host rule said when the URI was saved.
    pub host_level: EffectiveLevel,
    /// `max(tag, host rule)` with the override applied.
    pub effective_level: EffectiveLevel,
    pub read_preference: ReadPreference,
    pub max_time_ms: u32,
    /// The structured connection (non-secret: hosts, user names and file paths are in it, passwords never).
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub spec: Option<ConnSpec>,
    /// Saved by an older build as one string: offer "Convert it to fields".
    pub legacy_uri: bool,
    /// The signature check failed: connect and test answer `mongoNeedsReview` until the user saves again.
    pub needs_review: bool,
    pub has_password: bool,
    pub has_key_password: bool,
    pub has_ssh_secret: bool,
    pub has_proxy_password: bool,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub group: Option<String>,
    pub favorite: bool,
    pub domain: Domain,
    pub ai_prefs: AiPrefs,
    pub tls_relax: TlsRelax,
    /// Milliseconds since the epoch (a JS number; specta refuses 64-bit integers).
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub last_used_ms: Option<f64>,
    /// The connection rendered with the password masked (`user:***@`), empty when it cannot be rendered.
    pub uri_masked: String,
}

/// Create or update. `uri` is write-only (it goes to the Keychain through the secret store). Raising safety needs
/// nothing; **lowering** it (read-only off, AI on, level override, Production tag lowered) needs `confirm` equal to the
/// profile name, and the override needs the typed host.
#[derive(Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileInput {
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub id: Option<String>,
    pub name: String,
    pub environment: Environment,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub color: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub uri: Option<WireSecret>,
    /// `None` keeps the stored value (a new profile starts read-only).
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub read_only: Option<bool>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub ai_mode: Option<AiMode>,
    /// Empty string clears.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub tenant_lock: Option<String>,
    /// The host name typed by the user; must equal the first non-loopback host of the URI. Empty string clears.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub level_override_host: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub max_time_ms: Option<u32>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub confirm: Option<String>,
    /// The structured connection. `uri` and `spec` together are `mongoInvalid`.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub spec: Option<ConnSpec>,
    /// Write-only secrets. `None` keeps the stored one while the connection identity is unchanged; `Some("")` clears.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub password: Option<WireSecret>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub key_password: Option<WireSecret>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub ssh_secret: Option<WireSecret>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub proxy_password: Option<WireSecret>,
    /// A draft-vault token (secrets parsed from a pasted string); redeemed by the gateway, never by the profile store.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub draft: Option<String>,
    /// Empty string clears.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub group: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub favorite: Option<bool>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub domain: Option<Domain>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub ai_prefs: Option<AiPrefs>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub tls_relax: Option<TlsRelax>,
}

impl std::fmt::Debug for ProfileInput {
    /// The write-only fields (`uri`, the four secrets) print as placeholders: a `{:?}` of an input never carries one.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let red = |present: bool| if present { "[redacted]" } else { "None" };
        f.debug_struct("ProfileInput")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("environment", &self.environment)
            .field("uri", &red(self.uri.is_some()))
            .field("spec", &self.spec)
            .field("password", &red(self.password.is_some()))
            .field("key_password", &red(self.key_password.is_some()))
            .field("ssh_secret", &red(self.ssh_secret.is_some()))
            .field("proxy_password", &red(self.proxy_password.is_some()))
            .field("draft", &red(self.draft.is_some()))
            .field("read_only", &self.read_only)
            .field("ai_mode", &self.ai_mode)
            .field("tenant_lock", &self.tenant_lock)
            .field("level_override_host", &self.level_override_host)
            .field("max_time_ms", &self.max_time_ms)
            .field("group", &self.group)
            .field("favorite", &self.favorite)
            .field("domain", &self.domain)
            .field("ai_prefs", &self.ai_prefs)
            .field("tls_relax", &self.tls_relax)
            .finish_non_exhaustive()
    }
}

impl ProfileInput {
    /// The secrets this input supplies for a test or a connect without saving them.
    pub fn supplied_secrets(&self) -> SessionSecrets {
        SessionSecrets { password: self.password.clone(), ssh_secret: self.ssh_secret.clone(), key_password: self.key_password.clone(), proxy_password: self.proxy_password.clone() }
    }
}

/// Secrets typed at connect time (S9) for a profile that does not store them. Held in memory with the connection only.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSecrets {
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub password: Option<WireSecret>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub ssh_secret: Option<WireSecret>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub key_password: Option<WireSecret>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub proxy_password: Option<WireSecret>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum SecretKind {
    Password,
    KeyPassword,
    SshSecret,
    ProxyPassword,
}

impl SecretKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::KeyPassword => "keyPassword",
            Self::SshSecret => "sshSecret",
            Self::ProxyPassword => "proxyPassword",
        }
    }
}

/// Cosmetic edits that need no re-signing and no typed confirmation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileMeta {
    /// Empty string clears.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub group: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub favorite: Option<bool>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum SecretStoreKind {
    Keychain,
    /// Memory only: secrets last until the app quits.
    Session,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct SecretsStatus {
    pub store: SecretStoreKind,
    pub has_password: bool,
    pub has_key_password: bool,
    pub has_ssh_secret: bool,
    pub has_proxy_password: bool,
    /// The stored secrets were typed for the connection as it is now.
    pub identity_matches: bool,
}

/// A code the UI turns into a sentence (`mongoForm`/`mongoDiag` catalogs), with the option it concerns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub code: String,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub option: Option<String>,
}

/// The result of parsing a pasted connection string. The password stays in the Rust draft vault (`draft` is its token).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct UriParse {
    pub spec: ConnSpec,
    pub has_password: bool,
    pub has_key_password: bool,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub draft: Option<String>,
    pub warnings: Vec<Note>,
    pub unsupported: Vec<Note>,
}

/// A legacy profile converted for review: nothing changes until the user saves it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ProfileDraft {
    pub input: ProfileInput,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub draft: Option<String>,
    pub dropped: Vec<Note>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub profile_id: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    pub id: String,
    pub name: String,
    pub server_version: String,
    pub topology: String,
    pub ping_ms: u32,
    pub effective_level: EffectiveLevel,
    pub environment: Environment,
    pub read_only: bool,
    pub read_preference: ReadPreference,
    /// The result of the role probe, always shown.
    pub role: RoleChip,
    /// The user can write (or the probe could not tell): "read-only here is an app-level guard", one level riskier.
    pub role_elevated: bool,
    /// The connection is TLS-protected.
    pub tls: bool,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub tunnel: Option<TunnelState>,
    pub tls_relax: TlsRelax,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum ErrorClass {
    Dns,
    Network,
    Tls,
    Auth,
    Authz,
    Selection,
    Tunnel,
    Config,
    Timeout,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum StepId {
    Config,
    Tunnel,
    Dns,
    Connect,
    Tls,
    Auth,
    Permissions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum StepState {
    Pending,
    Running,
    Ok,
    Warn,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TestStep {
    pub id: StepId,
    pub state: StepState,
    pub ms: u32,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub note: Option<String>,
}

/// A failure as codes and parameters; the UI renders prose from `mongoDiag`. `detail` is scrubbed English raw text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    pub class: ErrorClass,
    pub code: String,
    pub params: Vec<(String, String)>,
    pub detail: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum HostKeyStatus {
    Unknown,
    Known,
    Changed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct HostKeyView {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    /// `SHA256:...`
    pub fingerprint: String,
    pub status: HostKeyStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TestReport {
    pub ok: bool,
    pub elapsed_ms: u32,
    #[cfg_attr(feature = "specta", specta(optional))]
    pub error: Option<String>,
    #[cfg_attr(feature = "specta", specta(optional))]
    pub error_class: Option<ErrorClass>,
    #[cfg_attr(feature = "specta", specta(optional))]
    pub connection: Option<ConnectionView>,
    /// `hello.hosts` after a success.
    #[serde(default)]
    pub members: Vec<String>,
    /// Destinations the tunnel relay refused.
    #[serde(default)]
    pub refused: Vec<String>,
    #[serde(default)]
    pub steps: Vec<TestStep>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub diagnosis: Option<Diagnosis>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub host_key: Option<HostKeyView>,
    /// Warning codes (plain-text connection to a remote host, relaxed checks, writer account).
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct LocalHit {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AiCapabilities {
    pub node: bool,
    pub claude_cli: bool,
    pub script: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum DialogKind {
    Import,
    Export,
}

/// A one-time ticket for a file the user picked in a native dialog that Rust opened (the webview never sees a path).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct DialogHandle {
    pub token: String,
    pub kind: DialogKind,
    /// The file name only, for display.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    pub name: String,
    pub warnings: Vec<Note>,
    /// Every outbound endpoint (`host:port`): database hosts, bastion, proxy.
    pub endpoints: Vec<String>,
    pub needs_confirm: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub items: Vec<ImportItem>,
    pub notes: Vec<Note>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: u32,
    pub skipped: u32,
    pub notes: Vec<Note>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ForgetReport {
    /// Fingerprints removed and fingerprints now trusted for the host.
    pub old: Vec<String>,
    pub current: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ResetReport {
    pub profiles: u32,
    pub secrets: u32,
    pub files: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct StudioStatus {
    /// The cargo feature is built in (always true when this answers; the UI treats a missing command as `false`).
    pub compiled: bool,
    pub enabled: bool,
    /// `full`, `loopbackOnly` (E2E jail) or `refused` (read-only jail).
    pub network: String,
    pub connections: Vec<ConnectionView>,
    pub notices: Vec<Notice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRequest {
    /// One cursor per tab; running again in the same tab replaces its cursor.
    pub tab: String,
    pub connection: String,
    pub command: ReadCommand,
    /// Rows per page the first window carries (default 50).
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub page_size: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub stages: Vec<String>,
    pub collscan: bool,
    pub index_names: Vec<String>,
    pub engine: String,
    #[cfg_attr(feature = "specta", specta(optional))]
    pub docs_examined: Option<i32>,
    #[cfg_attr(feature = "specta", specta(optional))]
    pub keys_examined: Option<i32>,
    #[cfg_attr(feature = "specta", specta(optional))]
    pub n_returned: Option<i32>,
    pub rejected_plans: u32,
    pub warnings: Vec<String>,
}

/// A window of documents (canonical Extended JSON, Int64 as `{"$numberLong": "..."}`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct WindowView {
    pub tab: String,
    pub docs: Vec<String>,
    /// Absolute position of `docs[0]` (counting the command's own `skip`).
    pub offset: u32,
    /// How many documents the cursor holds right now (never above 1000).
    pub loaded: u32,
    /// The 1000-document or 16 MB cap stopped the load; more exist.
    pub truncated: bool,
    pub has_more: bool,
    pub bytes: u32,
    pub elapsed_ms: u32,
    #[cfg_attr(feature = "specta", specta(optional))]
    pub plan: Option<PlanView>,
    /// A secondary may have served the read.
    pub secondary_ok: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct CancelView {
    pub cancelled: bool,
    /// The server confirmed the kill of our own operation (otherwise `maxTimeMS` is the backstop).
    pub killed: bool,
}

/// The AI half of the gateway (`mongo_ai_*`). The wire shapes are `ui/src/ipc/mongoAi.ts`. Nothing here carries a document
/// or a secret: a draft is text that the user reviews and runs through `mongo_run`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AiEditor {
    pub filter: String,
    #[serde(default)]
    pub projection: String,
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub limit: Option<i32>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub returned: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AiAsk {
    pub tab: String,
    pub connection: String,
    pub db: String,
    pub collection: String,
    pub question: String,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub editor: Option<AiEditor>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub think_harder: Option<bool>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub refresh_schema: Option<bool>,
    /// `mongo_ai_explain` only: the plan lines the UI shows.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub plan: Option<Vec<String>>,
    /// The caller's UTC offset in minutes and zone name (the generic preset words dates in them; D24).
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub utc_offset_min: Option<i32>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub tz_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AiPayload {
    /// `schemaOnly` (P1) or `schemaEnums` (P1 plus the filtered value sets of low-cardinality fields).
    pub mode: String,
    /// The exact bytes that would reach the model, after the PII filter.
    pub text: String,
    pub bytes: u32,
    pub tokens_estimate: u32,
    pub kept_names: Vec<String>,
    pub replaced_names: u32,
    pub excluded_fields: u32,
    pub masked_literals: u32,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AiPlan {
    pub collscan: bool,
    pub index_names: Vec<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub estimated_docs: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AiDraft {
    /// The collection the draft is for. It differs from the tab's collection when the question is about another one.
    pub collection: String,
    pub filter: String,
    pub projection: String,
    pub sort: String,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub limit: Option<i32>,
    pub explanation: String,
    pub model_note: String,
    pub assumptions: Vec<String>,
    pub warnings: Vec<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub plan: Option<AiPlan>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub index_suggestion: Option<String>,
    pub changed_fields: Vec<String>,
    pub extra_confirm: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AiResult {
    /// `ready`, `needsClarification` or `failed`.
    pub status: String,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub draft: Option<AiDraft>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub clarification: Option<String>,
    pub message: String,
    pub problems: Vec<String>,
    pub repairs: u32,
    pub notes: Vec<String>,
    pub model: String,
    pub took_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AiExplanation {
    pub text: String,
}

#[cfg(feature = "specta")]
pub fn type_collection() -> specta::Types {
    specta::Types::default()
        .register::<ReadCommand>()
        .register::<RoleChip>()
        .register::<EffectiveLevel>()
        .register::<Environment>()
        .register::<AiMode>()
        .register::<ReadPreference>()
        .register::<Domain>()
        .register::<TlsRelax>()
        .register::<WireSecret>()
        .register::<GlossaryPair>()
        .register::<AiPrefs>()
        .register::<TunnelState>()
        .register::<ConnSpec>()
        .register::<crate::connspec::FieldProblem>()
        .register::<SessionSecrets>()
        .register::<SecretKind>()
        .register::<ProfileMeta>()
        .register::<SecretStoreKind>()
        .register::<SecretsStatus>()
        .register::<Note>()
        .register::<UriParse>()
        .register::<ProfileDraft>()
        .register::<StepId>()
        .register::<StepState>()
        .register::<TestStep>()
        .register::<Diagnosis>()
        .register::<HostKeyStatus>()
        .register::<HostKeyView>()
        .register::<LocalHit>()
        .register::<AiCapabilities>()
        .register::<DialogKind>()
        .register::<DialogHandle>()
        .register::<ImportItem>()
        .register::<ImportPreview>()
        .register::<ImportReport>()
        .register::<ForgetReport>()
        .register::<ResetReport>()
        .register::<ProfileView>()
        .register::<ProfileInput>()
        .register::<Notice>()
        .register::<ConnectionView>()
        .register::<ErrorClass>()
        .register::<TestReport>()
        .register::<StudioStatus>()
        .register::<RunRequest>()
        .register::<PlanView>()
        .register::<WindowView>()
        .register::<CancelView>()
        .register::<AiEditor>()
        .register::<AiAsk>()
        .register::<AiPayload>()
        .register::<AiPlan>()
        .register::<AiDraft>()
        .register::<AiResult>()
        .register::<AiExplanation>()
}

#[cfg(all(test, feature = "specta"))]
mod tests {
    #[test]
    fn the_type_collection_exports_to_typescript() {
        specta_typescript::Typescript::default().export(&super::type_collection(), specta_serde::Format).expect("export");
    }
}
