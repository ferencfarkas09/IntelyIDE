use thiserror::Error;

#[derive(Debug, Error)]
pub enum TeamError {
    #[error("secret store: {0}")]
    Secret(String),
    #[error("I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Invalid(String),
    #[error("crypto: {0}")]
    Crypto(String),
    #[error("signature does not verify")]
    Forged,
    #[error("replayed or out-of-order message")]
    Replay,
    #[error("sender is not a member of this team")]
    UnknownSender,
    #[error("no key for epoch {0}")]
    NoKey(u32),
    #[error("only an admin can do this")]
    NotAdmin,
    #[error("the invite is expired or already used")]
    InviteSpent,
    #[error("the team is full")]
    Full,
    #[error("transport: {0}")]
    Transport(String),
}

impl From<intely_settings::SettingsError> for TeamError {
    fn from(e: intely_settings::SettingsError) -> Self {
        TeamError::Secret(e.to_string())
    }
}

impl From<intely_remote::RemoteError> for TeamError {
    fn from(e: intely_remote::RemoteError) -> Self {
        TeamError::Crypto(e.to_string())
    }
}

impl From<snow::Error> for TeamError {
    fn from(e: snow::Error) -> Self {
        TeamError::Crypto(e.to_string())
    }
}

impl From<serde_json::Error> for TeamError {
    fn from(e: serde_json::Error) -> Self {
        TeamError::Invalid(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, TeamError>;
