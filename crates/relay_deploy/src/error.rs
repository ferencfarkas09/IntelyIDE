use intely_core::EngineError;
use intely_relay_bundle::BundleError;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, DeployError>;

/// Every error carries a stable `code` (spec 4.11 error list): the UI maps `code -> t("remote.cloud.err.<code>")`, Rust never sends
/// prose to be rendered. `message` is a short English hint for logs; it is built from masked text only and never holds a secret.
#[derive(Debug, Error)]
pub enum DeployError {
    #[error("{code}: {message}")]
    Coded { code: &'static str, message: String },
    #[error("io: {0}")]
    Io(String),
    #[error(transparent)]
    Bundle(#[from] BundleError),
}

impl DeployError {
    pub fn coded(code: &'static str, message: impl Into<String>) -> Self {
        Self::Coded { code, message: message.into() }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Coded { code, .. } => code,
            Self::Io(_) => "io",
            Self::Bundle(e) => e.code(),
        }
    }
}

impl From<std::io::Error> for DeployError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

impl From<DeployError> for EngineError {
    fn from(e: DeployError) -> Self {
        EngineError::new(e.code(), e.to_string())
    }
}
