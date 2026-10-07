//! The one error type of the crate. The Tauri glue turns it into an `EngineError` with the same `code`.

use std::fmt;

pub mod code {
    pub const IO: &str = "io";
    pub const INVALID_SETTINGS: &str = "invalidSettings";
    pub const UNSUPPORTED_VERSION: &str = "unsupportedVersion";
    pub const INVALID_NAMESPACE: &str = "invalidNamespace";
    pub const SECRET_IN_SETTINGS: &str = "secretInSettings";
    pub const INVALID_KEY: &str = "invalidKey";
    pub const KEYCHAIN: &str = "keychain";
    pub const UNKNOWN_PROVIDER: &str = "unknownProvider";
    pub const INVALID_AUTH_MODE: &str = "invalidAuthMode";
    pub const INVALID_LAUNCH: &str = "invalidLaunch";
    pub const CONFIRMATION_REQUIRED: &str = "confirmationRequired";
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsError {
    pub code: &'static str,
    pub message: String,
    pub detail: Option<String>,
}

impl SettingsError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), detail: None }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

impl fmt::Display for SettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SettingsError {}

impl From<std::io::Error> for SettingsError {
    fn from(e: std::io::Error) -> Self {
        Self::new(code::IO, e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, SettingsError>;
