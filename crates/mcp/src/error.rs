//! The one error type of the crate. The Tauri glue turns it into an `EngineError` with the same `code` (and passes `message` and
//! `detail` through the redactor and the exact-value scrubber first); the supplier turns it into `intely_agent_core::mcp::McpError`.

use std::fmt;

use intely_agent_core::mcp::McpError;
use intely_settings::SettingsError;

/// The stable error codes of the MCP spec (3.2, 4.7, 5.1). The UI maps them to text; none carries a secret.
pub mod code {
    pub const BAD_NAME: &str = "mcpBadName";
    pub const NAME_TAKEN: &str = "mcpNameTaken";
    pub const BAD_COMMAND: &str = "mcpBadCommand";
    pub const SECRET_IN_ARGS: &str = "mcpSecretInArgs";
    pub const BAD_URL: &str = "mcpBadUrl";
    pub const SECRET_IN_URL: &str = "mcpSecretInUrl";
    pub const BAD_VAR: &str = "mcpBadVar";
    pub const PLAIN_SECRET_NAME: &str = "mcpPlainSecretName";
    pub const BAD_SECRET: &str = "mcpBadSecret";
    pub const BAD_POLICY: &str = "mcpBadPolicy";
    pub const TOO_MANY: &str = "mcpTooMany";
    pub const UNKNOWN_SERVER: &str = "mcpUnknownServer";
    pub const NO_WORKSPACE: &str = "mcpNoWorkspace";
    pub const BUSY: &str = "mcpBusy";
    pub const CONFIRMATION_REQUIRED: &str = "confirmationRequired";
    pub const UNSUPPORTED_VERSION: &str = "unsupportedVersion";
    pub const READ_ONLY: &str = "readOnly";
    pub const KEYCHAIN: &str = "keychain";
    pub const INVALID_SETTINGS: &str = "invalidSettings";
    pub const RESERVED_NAMESPACE: &str = "reservedNamespace";
    pub const EXEC_VAR: &str = "mcpExecVar";
    pub const RELATIVE_PATH: &str = "mcpRelativePath";
    pub const BAD_CHARS: &str = "mcpBadChars";
    pub const CODE_TOO_BIG: &str = "mcpCodeTooBig";
    pub const BLOCKED_BY_DEFAULT: &str = "mcpBlockedByDefault";
    pub const AUTH_MODE_UNSUPPORTED: &str = "mcpAuthModeUnsupported";
    pub const IMPORT_INVALID: &str = "mcpImportInvalid";
    pub const IMPORT_EXPIRED: &str = "mcpImportExpired";
    pub const CODE_IN_RUN_DIR: &str = "mcpCodeInRunDir";
    pub const BAD_CONFIG: &str = "mcpBadConfig";
    pub const UNAVAILABLE: &str = "mcpUnavailable";
    pub const SECRETS_UNSUPPORTED: &str = "mcpSecretsUnsupported";
    // the Test (4.7)
    pub const SPAWN_FAILED: &str = "mcpSpawnFailed";
    pub const TIMEOUT: &str = "mcpTimeout";
    pub const EXITED: &str = "mcpExited";
    pub const PROTOCOL: &str = "mcpProtocol";
    pub const AUTH: &str = "mcpAuth";
    pub const HTTP_STATUS: &str = "mcpHttpStatus";
    pub const TLS: &str = "mcpTls";
    pub const CONNECT: &str = "mcpConnect";
    pub const TEST_JAIL: &str = "testJail";
    pub const SECRET_MISSING: &str = "mcpSecretMissing";
    pub const IO: &str = "io";
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpErr {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
}

impl McpErr {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_owned(), message: message.into(), detail: None }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

impl fmt::Display for McpErr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for McpErr {}

impl From<SettingsError> for McpErr {
    fn from(e: SettingsError) -> Self {
        Self { code: e.code.to_owned(), message: e.message, detail: e.detail }
    }
}

impl From<std::io::Error> for McpErr {
    fn from(e: std::io::Error) -> Self {
        Self::new(code::IO, e.to_string())
    }
}

/// The supplier's error carries a code and a message, no detail (the host maps it to an `EngineError`).
impl From<McpErr> for McpError {
    fn from(e: McpErr) -> Self {
        McpError { code: e.code, message: e.message }
    }
}

pub type Result<T> = std::result::Result<T, McpErr>;
