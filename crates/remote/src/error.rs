use thiserror::Error;

#[derive(Debug, Error)]
pub enum RemoteError {
    #[error("remote state was changed outside the app ({0}); Remote is stopped and every device counts as revoked")]
    Tampered(String),
    #[error("secret store: {0}")]
    Secret(String),
    #[error("I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Invalid(String),
    #[error("unknown device")]
    UnknownDevice,
    #[error("noise: {0}")]
    Noise(String),
    #[error("transport: {0}")]
    Transport(String),
}

impl From<intely_settings::SettingsError> for RemoteError {
    fn from(e: intely_settings::SettingsError) -> Self {
        RemoteError::Secret(e.to_string())
    }
}

impl From<snow::Error> for RemoteError {
    fn from(e: snow::Error) -> Self {
        RemoteError::Noise(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, RemoteError>;
