use thiserror::Error;

pub type Result<T> = std::result::Result<T, BundleError>;

/// Errors never carry key material, file contents or relay response bodies; `code()` is what the Tauri layer maps to a UI message.
#[derive(Debug, Error)]
pub enum BundleError {
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("io: {0}")]
    Io(String),
    /// The jail (INTELY_READONLY / INTELY_E2E) refused the operation; carries the jail's code (`readOnly` or `testJail`).
    #[error("refused by the jail: {0}")]
    Jail(String),
    /// A stage rule (spec 4.12.2) refused a path in the web build; `code` is a stable slug, `path` is relative to the dist root.
    #[error("refused to stage {path}: {code}")]
    Stage { code: &'static str, path: String },
    /// The signing key could not be read or is not an Ed25519 key.
    #[error("signing key is not usable")]
    BadKey,
    /// The stored `seq` is more than 24 hours ahead of this Mac's clock: the clock or the stored value is wrong (spec 4.5).
    #[error("the stored bundle seq {stored} is ahead of the clock ({now})")]
    SeqClock { stored: u64, now: u64 },
    #[error("the bundle seq counter is exhausted")]
    SeqExhausted,
    /// Network refusal or failure with a stable code: badUrl, hostNotAllowed, privateAddress, network, timeout, tooLarge.
    #[error("network: {0}")]
    Net(&'static str),
    /// A staged directory no longer matches its signed manifest.
    #[error("staged bundle changed: {0}")]
    Changed(String),
}

impl BundleError {
    /// Stable code for the UI (`remote.cloud.err.<code>`); the names follow the spec's error code list where one exists.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "invalid",
            Self::Io(_) => "io",
            Self::Jail(c) if c == "readOnly" => "readOnly",
            Self::Jail(_) => "testJail",
            Self::Stage { .. } => "stageRefused",
            Self::BadKey => "badKey",
            Self::SeqClock { .. } => "seqClock",
            Self::SeqExhausted => "seqClock",
            Self::Net(c) => c,
            Self::Changed(_) => "previewStale",
        }
    }
}

impl From<std::io::Error> for BundleError {
    fn from(e: std::io::Error) -> Self {
        // Only the kind and the OS text: io errors name paths of the user's own machine, never secrets.
        Self::Io(e.to_string())
    }
}
