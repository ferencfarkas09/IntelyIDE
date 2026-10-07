//! The structured connection description (`ConnSpec`): what the connection form edits and what a profile stores instead
//! of a connection string. **Nothing secret lives here** (passwords, passphrases and the assembled URI are built at
//! connect time from the secret store), so every type may be serialized, logged and shown to the webview. Lean: no
//! driver, std plus serde and sha2 only.
//!
//! The field order of every struct is frozen by `tests/golden/conn_hash.json`, and [`ConnSpec::conn_hash`] is computed
//! from a hand-written canonical encoding (never serde output), so adding a defaulted field never changes the hash of an
//! existing profile.

use serde::{Deserialize, Serialize};

use crate::host::{self, HostInfo};
use crate::profile::sha256_hex;
use crate::types::EffectiveLevel;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum Scheme {
    #[default]
    Standard,
    Srv,
}

/// `Srv`: exactly one host and no port.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct HostPort {
    pub host: String,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum AuthMechanism {
    None,
    /// SCRAM, negotiated by the driver.
    #[default]
    Default,
    ScramSha1,
    ScramSha256,
    X509,
    Plain,
}

impl AuthMechanism {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Default => "default",
            Self::ScramSha1 => "scramSha1",
            Self::ScramSha256 => "scramSha256",
            Self::X509 => "x509",
            Self::Plain => "plain",
        }
    }

    /// Mechanisms that send a password.
    pub fn uses_password(self) -> bool {
        matches!(self, Self::Default | Self::ScramSha1 | Self::ScramSha256 | Self::Plain)
    }

    pub fn is_scram(self) -> bool {
        matches!(self, Self::Default | Self::ScramSha1 | Self::ScramSha256)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AuthSpec {
    #[serde(default)]
    pub mechanism: AuthMechanism,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub username: Option<String>,
    /// The authentication database (`$external` for X.509 and PLAIN).
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub source: Option<String>,
    #[serde(default)]
    pub save_password: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum TlsMode {
    #[default]
    Auto,
    On,
    Off,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TlsSpec {
    #[serde(default)]
    pub mode: TlsMode,
    /// PEM file; empty means the built-in roots.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub ca_file: Option<String>,
    /// PEM file with certificate and key.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub client_cert_file: Option<String>,
    #[serde(default)]
    pub save_key_password: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum ReadPrefMode {
    /// By level: primary-preferred locally, secondary-preferred for Production-level.
    #[default]
    Auto,
    Primary,
    PrimaryPreferred,
    Secondary,
    SecondaryPreferred,
    Nearest,
}

impl ReadPrefMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Primary => "primary",
            Self::PrimaryPreferred => "primaryPreferred",
            Self::Secondary => "secondary",
            Self::SecondaryPreferred => "secondaryPreferred",
            Self::Nearest => "nearest",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TopologySpec {
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub replica_set: Option<String>,
    /// `None` = automatic.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub direct_connection: Option<bool>,
    #[serde(default)]
    pub read_preference: ReadPrefMode,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub max_staleness_s: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum Compressor {
    Zstd,
    Zlib,
    Snappy,
}

impl Compressor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Zstd => "zstd",
            Self::Zlib => "zlib",
            Self::Snappy => "snappy",
        }
    }
}

/// The compressors the build carries (Cargo features of the `mongodb` dependency). zstd waits for the spike S1.
pub const COMPILED_COMPRESSORS: &[Compressor] = &[Compressor::Zlib, Compressor::Snappy];

/// `None` = 10 s; clamped to 1..=60 s.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Timeouts {
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub connect_ms: Option<u32>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub server_selection_ms: Option<u32>,
}

pub const DEFAULT_TIMEOUT_MS: u32 = 10_000;

impl Timeouts {
    pub fn connect(&self) -> u32 {
        self.connect_ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1_000, 60_000)
    }

    pub fn server_selection(&self) -> u32 {
        self.server_selection_ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1_000, 60_000)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ExtraOption {
    pub key: String,
    pub value: String,
}

/// Options a pasted string or the Advanced tab may carry (case-insensitive on input; the parser clamps the values).
pub const EXTRA_ALLOW_LIST: &[&str] = &[
    "maxPoolSize",
    "minPoolSize",
    "maxIdleTimeMS",
    "heartbeatFrequencyMS",
    "localThresholdMS",
    "readConcernLevel",
    "srvMaxHosts",
    "srvServiceName",
    "loadBalanced",
];

/// The canonical spelling of an allow-listed option, `None` when it is not on the list.
pub fn canonical_extra_key(key: &str) -> Option<&'static str> {
    EXTRA_ALLOW_LIST.iter().copied().find(|k| k.eq_ignore_ascii_case(key))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum TunnelAuth {
    #[default]
    Agent,
    KeyFile,
    Password,
}

impl TunnelAuth {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::KeyFile => "keyFile",
            Self::Password => "password",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AllowedHost {
    pub host: String,
    pub port: u16,
}

fn yes() -> bool {
    true
}

/// An SSH bastion. There is no jump-host field (D21): put `ProxyJump` in `~/.ssh/config`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct SshSpec {
    /// A host name or a `~/.ssh/config` alias.
    pub host: String,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub port: Option<u16>,
    pub user: String,
    #[serde(default)]
    pub auth: TunnelAuth,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub key_file: Option<String>,
    #[serde(default)]
    pub save_secret: bool,
    #[serde(default = "yes")]
    pub use_ssh_config: bool,
    #[serde(default)]
    pub allowed_hosts: Vec<AllowedHost>,
}

impl Default for SshSpec {
    fn default() -> Self {
        Self { host: String::new(), port: None, user: String::new(), auth: TunnelAuth::Agent, key_file: None, save_secret: false, use_ssh_config: true, allowed_hosts: Vec::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ProxySpec {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub username: Option<String>,
    #[serde(default)]
    pub save_password: bool,
}

/// Serialized as `{"kind":"none"}`, `{"kind":"ssh",...}` or `{"kind":"socks5",...}`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Tunnel {
    #[default]
    None,
    Ssh(SshSpec),
    Socks5(ProxySpec),
}

impl Tunnel {
    pub fn is_none(&self) -> bool {
        matches!(self, Self::None)
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Ssh(_) => "ssh",
            Self::Socks5(_) => "socks5",
        }
    }

    /// The host a user types to lower the level of a tunnelled connection (the bastion or the proxy).
    pub fn endpoint_host(&self) -> Option<&str> {
        match self {
            Self::None => None,
            Self::Ssh(s) => Some(&s.host),
            Self::Socks5(p) => Some(&p.host),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ConnSpec {
    #[serde(default)]
    pub scheme: Scheme,
    #[serde(default)]
    pub hosts: Vec<HostPort>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub database: Option<String>,
    #[serde(default)]
    pub auth: AuthSpec,
    #[serde(default)]
    pub tls: TlsSpec,
    #[serde(default)]
    pub topology: TopologySpec,
    #[serde(default)]
    pub compressors: Vec<Compressor>,
    #[serde(default)]
    pub timeouts: Timeouts,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub app_name: Option<String>,
    #[serde(default)]
    pub extra: Vec<ExtraOption>,
    #[serde(default)]
    pub tunnel: Tunnel,
}

/// One problem found by [`ConnSpec::validate`]. `code` becomes an i18n key; `warning` problems do not block a save.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct FieldProblem {
    pub path: String,
    pub code: String,
    #[serde(default)]
    pub warning: bool,
}

fn problem(out: &mut Vec<FieldProblem>, path: impl Into<String>, code: &str) {
    out.push(FieldProblem { path: path.into(), code: code.into(), warning: false });
}

fn warn(out: &mut Vec<FieldProblem>, path: impl Into<String>, code: &str) {
    out.push(FieldProblem { path: path.into(), code: code.into(), warning: true });
}

fn bracketed_ipv6(h: &str) -> bool {
    h.len() > 2 && h.starts_with('[') && h.ends_with(']') && h[1..h.len() - 1].chars().all(|c| c.is_ascii_hexdigit() || matches!(c, ':' | '.' | '%'))
}

/// `[A-Za-z0-9._-]`, 1 to 253 characters, no leading `-`; or a bracketed IPv6 literal.
pub fn valid_host(h: &str) -> bool {
    if bracketed_ipv6(h) {
        return true;
    }
    !h.is_empty() && h.len() <= 253 && !h.starts_with('-') && h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn plain_name(s: &str) -> bool {
    !s.is_empty() && s.chars().count() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'))
}

fn user_name_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && !s.starts_with('-') && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Absolute (unix or Windows style), at most 1024 characters, no NUL, no `..` segment. Existence is checked at use.
pub fn valid_file_path(p: &str) -> bool {
    let b = p.as_bytes();
    let absolute = p.starts_with('/') || p.starts_with("\\\\") || (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'));
    absolute && p.len() <= 1024 && !p.contains('\0') && !p.split(['/', '\\']).any(|seg| seg == "..")
}

fn link_local_or_metadata(h: &str) -> bool {
    let h = h.to_ascii_lowercase();
    h.starts_with("169.254.") || h.starts_with("fe8") || h.starts_with("fe9") || h.starts_with("fea") || h.starts_with("feb") || h == "metadata.google.internal"
}

fn strip_brackets(h: &str) -> &str {
    h.strip_prefix('[').and_then(|r| r.strip_suffix(']')).unwrap_or(h)
}

/// Escapes the two characters that would let one canonical line pose as two.
fn esc(v: &str) -> String {
    v.replace('\\', "\\\\").replace('\n', "\\n")
}

impl ConnSpec {
    /// The facts the host rule needs (lower-cased hosts, brackets of IPv6 literals removed).
    pub fn host_info(&self) -> HostInfo {
        HostInfo {
            srv: self.scheme == Scheme::Srv,
            hosts: self.hosts.iter().map(|h| strip_brackets(&h.host).to_ascii_lowercase()).collect(),
            has_credentials: self.auth.username.as_deref().is_some_and(|u| !u.is_empty()),
            database: self.database.clone().filter(|d| !d.is_empty()),
        }
    }

    /// The host rule for this spec. **Any tunnel is Production-level**, whatever the host names say: a bastion's
    /// `127.0.0.1` is not this computer.
    pub fn host_level(&self) -> EffectiveLevel {
        if !self.tunnel.is_none() {
            return EffectiveLevel::ProductionLevel;
        }
        host::effective_level(&self.host_info())
    }

    /// The host a user types to lower the level: the bastion or proxy of a tunnel, else the first remote database host.
    pub fn remote_host(&self) -> Option<String> {
        match &self.tunnel {
            Tunnel::None => host::first_remote_host(&self.host_info()).map(str::to_string),
            t => t.endpoint_host().map(|h| strip_brackets(h).to_ascii_lowercase()),
        }
    }

    fn all_loopback(&self) -> bool {
        self.scheme == Scheme::Standard && !self.hosts.is_empty() && self.hosts.iter().all(|h| host::is_loopback_host(&strip_brackets(&h.host).to_ascii_lowercase()))
    }

    /// Everything wrong with this spec, errors and warnings, in a stable order. Existence of files is not checked here.
    pub fn validate(&self) -> Vec<FieldProblem> {
        let mut out = Vec::new();
        // hosts
        if self.hosts.is_empty() {
            problem(&mut out, "hosts", "host.required");
        }
        if self.hosts.len() > 16 {
            problem(&mut out, "hosts", "host.count");
        }
        for (i, h) in self.hosts.iter().enumerate() {
            if !valid_host(&h.host) {
                problem(&mut out, format!("hosts[{i}].host"), "host.invalid");
            }
            if h.port == Some(0) {
                problem(&mut out, format!("hosts[{i}].port"), "port.range");
            }
        }
        if self.scheme == Scheme::Srv {
            if self.hosts.len() != 1 {
                problem(&mut out, "hosts", "srv.oneHost");
            }
            if self.hosts.iter().any(|h| h.port.is_some()) {
                problem(&mut out, "hosts[0].port", "srv.noPort");
            }
            if self.topology.direct_connection.is_some() {
                problem(&mut out, "topology.directConnection", "srv.direct");
            }
            if self.extra.iter().any(|e| e.key.eq_ignore_ascii_case("loadBalanced")) {
                problem(&mut out, "extra", "srv.loadBalanced");
            }
        }
        // names
        if let Some(d) = self.database.as_deref().filter(|d| !d.is_empty()) {
            if d.chars().count() > 120 || d.chars().any(|c| matches!(c, '/' | '\\' | '.' | '"' | '$' | ' ' | '\0')) {
                problem(&mut out, "database", "database.invalid");
            }
        }
        if let Some(r) = self.topology.replica_set.as_deref().filter(|r| !r.is_empty()) {
            if !plain_name(r) {
                problem(&mut out, "topology.replicaSet", "replicaSet.invalid");
            }
        }
        if let Some(a) = self.app_name.as_deref().filter(|a| !a.is_empty()) {
            if !plain_name(a) {
                problem(&mut out, "appName", "appName.invalid");
            }
        }
        // authentication
        if let Some(u) = self.auth.username.as_deref() {
            if u.len() > 256 || u.contains('\0') {
                problem(&mut out, "auth.username", "auth.usernameInvalid");
            }
        }
        if let Some(s) = self.auth.source.as_deref().filter(|s| !s.is_empty()) {
            if s.len() > 120 || !s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '.' | '-')) {
                problem(&mut out, "auth.source", "auth.sourceInvalid");
            } else if matches!(self.auth.mechanism, AuthMechanism::X509 | AuthMechanism::Plain) && s != "$external" {
                problem(&mut out, "auth.source", "auth.sourceExternal");
            }
        }
        if self.auth.mechanism == AuthMechanism::X509 && self.tls.client_cert_file.as_deref().is_none_or(str::is_empty) {
            problem(&mut out, "tls.clientCertFile", "tls.clientCertNeeded");
        }
        // TLS files
        for (path, v) in [("tls.caFile", &self.tls.ca_file), ("tls.clientCertFile", &self.tls.client_cert_file)] {
            if let Some(p) = v.as_deref().filter(|p| !p.is_empty()) {
                if !valid_file_path(p) {
                    problem(&mut out, path, "file.path");
                }
            }
        }
        // topology
        if self.topology.max_staleness_s.is_some_and(|s| s < 90) {
            problem(&mut out, "topology.maxStalenessS", "staleness.min");
        }
        if matches!(self.topology.read_preference, ReadPrefMode::Secondary | ReadPrefMode::SecondaryPreferred) && self.topology.replica_set.as_deref().is_none_or(str::is_empty) {
            warn(&mut out, "topology.readPreference", "readPref.noReplicaSet");
        }
        // compression
        for (i, c) in self.compressors.iter().enumerate() {
            if self.compressors[..i].contains(c) {
                problem(&mut out, format!("compressors[{i}]"), "compressor.duplicate");
            } else if !COMPILED_COMPRESSORS.contains(c) {
                problem(&mut out, format!("compressors[{i}]"), "compressor.unsupported");
            }
        }
        // extra options
        for (i, e) in self.extra.iter().enumerate() {
            let Some(key) = canonical_extra_key(&e.key) else {
                problem(&mut out, format!("extra[{i}].key"), "extra.key");
                continue;
            };
            if e.value.len() > 256 || e.value.chars().any(char::is_control) {
                problem(&mut out, format!("extra[{i}].value"), "extra.value");
            }
            if key == "loadBalanced" && self.scheme == Scheme::Standard && self.hosts.len() != 1 {
                problem(&mut out, format!("extra[{i}]"), "extra.loadBalanced");
            }
            if key == "srvServiceName" && !valid_host(&e.value) {
                problem(&mut out, format!("extra[{i}].value"), "extra.value");
            }
        }
        // tunnel
        match &self.tunnel {
            Tunnel::None => {}
            Tunnel::Ssh(s) => {
                if !valid_host(&s.host) || bracketed_ipv6(&s.host) {
                    problem(&mut out, "tunnel.host", "ssh.host");
                }
                if s.port == Some(0) {
                    problem(&mut out, "tunnel.port", "port.range");
                }
                if !user_name_ok(&s.user) {
                    problem(&mut out, "tunnel.user", "ssh.user");
                }
                match (s.auth, s.key_file.as_deref().filter(|k| !k.is_empty())) {
                    (TunnelAuth::KeyFile, None) => problem(&mut out, "tunnel.keyFile", "ssh.keyFileRequired"),
                    (TunnelAuth::KeyFile, Some(k)) if !valid_file_path(k) => problem(&mut out, "tunnel.keyFile", "file.path"),
                    (TunnelAuth::KeyFile, Some(_)) | (_, None) => {}
                    (_, Some(_)) => problem(&mut out, "tunnel.keyFile", "ssh.keyFileAuth"),
                }
                if s.allowed_hosts.len() > 64 {
                    problem(&mut out, "tunnel.allowedHosts", "ssh.allowedCount");
                }
                for (i, a) in s.allowed_hosts.iter().enumerate() {
                    if !valid_host(&a.host) || bracketed_ipv6(&a.host) {
                        problem(&mut out, format!("tunnel.allowedHosts[{i}].host"), "ssh.allowedHost");
                    } else if link_local_or_metadata(&a.host) {
                        problem(&mut out, format!("tunnel.allowedHosts[{i}].host"), "ssh.allowedLinkLocal");
                    }
                    if a.port == 0 {
                        problem(&mut out, format!("tunnel.allowedHosts[{i}].port"), "port.range");
                    }
                }
            }
            Tunnel::Socks5(p) => {
                if !valid_host(&p.host) {
                    problem(&mut out, "tunnel.host", "proxy.host");
                }
                if p.port == 0 {
                    problem(&mut out, "tunnel.port", "port.range");
                }
                if p.username.as_deref().is_some_and(|u| u.len() > 255 || u.contains('\0')) {
                    problem(&mut out, "tunnel.username", "proxy.username");
                }
            }
        }
        // plain-text secrets to a remote host
        let saved_password = self.auth.mechanism.is_scram() && self.auth.save_password;
        if (self.auth.mechanism == AuthMechanism::Plain || saved_password) && self.tls.mode == TlsMode::Off && !self.all_loopback() {
            problem(&mut out, "tls.mode", "config.plainRemote");
        }
        out
    }

    /// Only the blocking problems.
    pub fn errors(&self) -> Vec<FieldProblem> {
        self.validate().into_iter().filter(|p| !p.warning).collect()
    }

    fn canonical_lines(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut put = |k: &str, v: &str| out.push(format!("{k}={}", esc(v)));
        if self.scheme == Scheme::Srv {
            put("scheme", "srv");
        }
        for (i, h) in self.hosts.iter().enumerate() {
            put(&format!("h.{i:03}"), &format!("{}:{}", h.host, h.port.map(|p| p.to_string()).unwrap_or_default()));
        }
        if let Some(d) = &self.database {
            put("db", d);
        }
        if self.auth.mechanism != AuthMechanism::Default {
            put("auth.mech", self.auth.mechanism.as_str());
        }
        if let Some(u) = &self.auth.username {
            put("auth.user", u);
        }
        if let Some(s) = &self.auth.source {
            put("auth.source", s);
        }
        if self.auth.save_password {
            put("auth.savePassword", "1");
        }
        if self.tls.mode != TlsMode::Auto {
            put("tls.mode", if self.tls.mode == TlsMode::On { "on" } else { "off" });
        }
        if let Some(c) = &self.tls.ca_file {
            put("tls.ca", c);
        }
        if let Some(c) = &self.tls.client_cert_file {
            put("tls.cert", c);
        }
        if self.tls.save_key_password {
            put("tls.saveKeyPassword", "1");
        }
        if let Some(r) = &self.topology.replica_set {
            put("topo.rs", r);
        }
        if let Some(d) = self.topology.direct_connection {
            put("topo.direct", if d { "1" } else { "0" });
        }
        if self.topology.read_preference != ReadPrefMode::Auto {
            put("topo.readPref", self.topology.read_preference.as_str());
        }
        if let Some(s) = self.topology.max_staleness_s {
            put("topo.staleness", &s.to_string());
        }
        for (i, c) in self.compressors.iter().enumerate() {
            put(&format!("comp.{i:03}"), c.as_str());
        }
        if let Some(t) = self.timeouts.connect_ms {
            put("to.connect", &t.to_string());
        }
        if let Some(t) = self.timeouts.server_selection_ms {
            put("to.select", &t.to_string());
        }
        if let Some(a) = &self.app_name {
            put("app", a);
        }
        for (i, e) in self.extra.iter().enumerate() {
            put(&format!("x.{i:03}"), &format!("{}={}", e.key, e.value));
        }
        match &self.tunnel {
            Tunnel::None => {}
            Tunnel::Ssh(s) => {
                put("t.kind", "ssh");
                put("t.host", &s.host);
                if let Some(p) = s.port {
                    put("t.port", &p.to_string());
                }
                put("t.user", &s.user);
                if s.auth != TunnelAuth::Agent {
                    put("t.auth", s.auth.as_str());
                }
                if let Some(k) = &s.key_file {
                    put("t.key", k);
                }
                if s.save_secret {
                    put("t.saveSecret", "1");
                }
                if !s.use_ssh_config {
                    put("t.noConfig", "1");
                }
                for (i, a) in s.allowed_hosts.iter().enumerate() {
                    put(&format!("t.allow.{i:03}"), &format!("{}:{}", a.host, a.port));
                }
            }
            Tunnel::Socks5(p) => {
                put("t.kind", "socks5");
                put("t.host", &p.host);
                put("t.port", &p.port.to_string());
                if let Some(u) = &p.username {
                    put("t.user", u);
                }
                if p.save_password {
                    put("t.savePassword", "1");
                }
            }
        }
        out.sort();
        out
    }

    /// SHA-256 (hex) of the canonical encoding: sorted `key=value` lines, defaults and `None` omitted. Signed into the
    /// profile (an outside edit of host, bastion, key file or allow-list is a mismatch).
    pub fn conn_hash(&self) -> String {
        sha256_hex(format!("connspec-v1\n{}", self.canonical_lines().join("\n")).as_bytes())
    }

    /// The destination a stored secret was typed for: scheme, hosts and ports, tunnel kind, host, port and user, proxy
    /// host and port, the ssh auth kind (and key file), mechanism, user name and TLS mode. A secret is never sent to a changed identity.
    pub fn secret_identity(&self) -> String {
        let mut s = String::from("identity-v2\n");
        s.push_str(&format!("scheme={}\n", if self.scheme == Scheme::Srv { "srv" } else { "standard" }));
        for h in &self.hosts {
            s.push_str(&format!("host={}:{}\n", esc(&h.host.to_ascii_lowercase()), h.port.map(|p| p.to_string()).unwrap_or_default()));
        }
        s.push_str(&format!("tunnel={}\n", self.tunnel.kind()));
        match &self.tunnel {
            Tunnel::None => {}
            // the auth kind and the key file are part of it: a key passphrase must never be offered to the bastion as a
            // password (or the other way round), nor be used for another key
            Tunnel::Ssh(t) => s.push_str(&format!(
                "tunnel.host={}\ntunnel.port={}\ntunnel.user={}\ntunnel.auth={}\ntunnel.key={}\n",
                esc(&t.host.to_ascii_lowercase()),
                t.port.map(|p| p.to_string()).unwrap_or_default(),
                esc(&t.user),
                t.auth.as_str(),
                if t.auth == TunnelAuth::KeyFile { esc(t.key_file.as_deref().unwrap_or("")) } else { String::new() }
            )),
            Tunnel::Socks5(p) => s.push_str(&format!("proxy.host={}\nproxy.port={}\nproxy.user={}\n", esc(&p.host.to_ascii_lowercase()), p.port, esc(p.username.as_deref().unwrap_or("")))),
        }
        let tls = match self.tls.mode {
            TlsMode::Auto => "auto",
            TlsMode::On => "on",
            TlsMode::Off => "off",
        };
        s.push_str(&format!("mech={}\nuser={}\ntls={tls}\n", self.auth.mechanism.as_str(), esc(self.auth.username.as_deref().unwrap_or(""))));
        sha256_hex(s.as_bytes())
    }
}
