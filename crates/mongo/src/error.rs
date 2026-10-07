//! One error type for everything the webview can trigger. Messages are scrubbed of URIs and credentials where they are
//! built; the Tauri layer maps `code` and `message` to the IPC error and adds nothing.

use serde::Serialize;

pub mod code {
    pub const DISABLED: &str = "mongoDisabled";
    pub const READ_ONLY_JAIL: &str = "readOnly";
    pub const TEST_JAIL: &str = "testJail";
    pub const NOT_FOUND: &str = "mongoNotFound";
    pub const INVALID: &str = "mongoInvalid";
    pub const CONFIRM: &str = "mongoConfirm";
    pub const NO_URI: &str = "mongoNoUri";
    pub const NOT_CONNECTED: &str = "mongoNotConnected";
    pub const SETTINGS: &str = "mongoSettings";
    pub const AUDIT: &str = "mongoAudit";
    pub const REJECTED: &str = "mongoRejected";
    pub const PARSE: &str = "mongoParse";
    pub const CANCELLED: &str = "mongoCancelled";
    pub const SERVER: &str = "mongoServer";
    pub const CONNECT: &str = "mongoConnect";
    pub const BUSY: &str = "mongoBusy";
    /// A secret the connection needs is absent, or was typed for another destination. The message carries `needs:<kinds>`.
    pub const NEED_SECRET: &str = "mongoNeedSecret";
    /// The profile failed its signature check: review and save it again before it may connect or be tested.
    pub const NEEDS_REVIEW: &str = "mongoNeedsReview";
    pub const TUNNEL: &str = "mongoTunnel";
    pub const HOST_KEY: &str = "mongoHostKey";
    pub const IMPORT: &str = "mongoImport";
    /// A native-dialog handle is unknown, expired, used, or of the wrong kind.
    pub const HANDLE: &str = "mongoHandle";
    /// The connection's AI mode is off (P0): nothing was prepared and no port was touched.
    pub const AI_OFF: &str = "mongoAiOff";
    pub const NO_PROVIDER: &str = "mongoNoProvider";
    /// The model ran out of turns or returned nothing usable: a retry usually works.
    pub const MODEL_BUSY: &str = "mongoModelBusy";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StudioError {
    pub code: &'static str,
    pub message: String,
}

impl StudioError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl std::fmt::Display for StudioError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for StudioError {}

impl From<intely_settings::SettingsError> for StudioError {
    fn from(e: intely_settings::SettingsError) -> Self {
        // Settings errors never carry a URI (it is not stored there), but scrub anyway.
        StudioError::new(code::SETTINGS, crate::host::redact(&e.message))
    }
}

pub type Result<T> = std::result::Result<T, StudioError>;

/// What a stub that a later task fills in answers (T1a left it with its final signature).
pub fn unimplemented(what: &str) -> StudioError {
    StudioError::new(code::INVALID, format!("not implemented yet: {what}"))
}
