use serde::{Deserialize, Serialize};

/// The version (a date) of the privacy notice the first-start screen shows (`ui/src/modules/account`, `docs/privacy.md`). When the
/// text changes, change this date: everybody who agreed to an older one is asked again, and nothing is sent for them until they answer.
pub const NOTICE: &str = "2026-10-28";

/// Where the registry lives: the only host this crate talks to. Shown on the first-start screen and in Settings.
pub const REGISTRY_URL: &str = "https://registry.intelyhome.com";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_s: Option<u64>,
}

impl Problem {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_owned(), message: message.into(), retry_after_s: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    /// Never asked on this computer (or the answer is not valid any more).
    Unasked,
    Registered,
    /// The person said no, or deleted their data: nothing is sent, and the screen does not come back by itself.
    Declined,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: State,
    pub name: Option<String>,
    pub email: Option<String>,
    /// `none`, `pending` (the confirmation mail was sent), `subscribed`, `unsubscribed` or `failed`, as the registry last said.
    pub newsletter: Option<String>,
    /// The version of the notice this build shows.
    pub notice: String,
    /// The version the person agreed to.
    pub consented_notice: Option<String>,
    /// The first-start screen is due: never asked, or registered under an older notice.
    pub needs_consent: bool,
    pub url: String,
}

/// What the first-start screen (or Settings) sends.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterInput {
    pub name: String,
    pub email: String,
    pub newsletter: bool,
    /// The box "I agree that this is stored": without it nothing is sent.
    pub consent: bool,
    /// From the webview (`navigator.language`, the time zone of `Intl`).
    pub locale: String,
    pub tz: String,
}
