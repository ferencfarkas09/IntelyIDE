//! What the views get: small, flat, camelCase on the wire. Everything is read defensively from Sentry's answers (see `parse`).

use serde::{Deserialize, Serialize};

/// A failure the view can explain: a stable `code`, a message without the token, and when to retry for `rateLimited`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProblem {
    /// `notConfigured`, `invalidBaseUrl`, `unauthorized`, `forbidden`, `notFound`, `rateLimited`, `badRequest`, `network`, `server`, `badResponse`.
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_s: Option<u64>,
}

impl ApiProblem {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_owned(), message: message.into(), retry_after_s: None }
    }
}

impl std::fmt::Display for ApiProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// What is saved in `settings.json` (the token is not: it is in the Keychain).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// `https://sentry.io` unless a self-hosted Sentry is used.
    pub base_url: String,
    /// The organization slug.
    pub org: String,
}

impl Default for Config {
    fn default() -> Self {
        Self { base_url: "https://sentry.io".to_owned(), org: String::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub base_url: String,
    pub org: String,
    pub has_token: bool,
    /// An organization and a token are set: the issue list can be asked for.
    pub configured: bool,
}

/// The answer of "Test connection".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub ok: bool,
    /// The organization's name.
    pub org_name: Option<String>,
    /// Who the token belongs to; absent for a token that is not a person's (it cannot be assigned issues).
    pub user: Option<String>,
    pub problem: Option<ApiProblem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub slug: String,
    pub name: String,
}

/// A user or a team an issue is assigned to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    /// `user` or `team`.
    pub kind: String,
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub id: String,
    /// The readable id, `SHOP-1A`.
    pub short_id: String,
    pub title: String,
    pub culprit: String,
    /// `fatal`, `error`, `warning`, `info`, `debug`.
    pub level: String,
    /// `unresolved`, `resolved`, `ignored`.
    pub status: String,
    /// Events in the selected period (all time when the list was not limited to one).
    pub count: u64,
    pub user_count: u64,
    pub first_seen: String,
    pub last_seen: String,
    pub permalink: String,
    pub project: Option<Project>,
    pub assigned_to: Option<Actor>,
    /// The exception type and value of the metadata, when there are any.
    pub error_type: Option<String>,
    pub error_value: Option<String>,
    pub is_unhandled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuePage {
    pub issues: Vec<Issue>,
    /// The cursor of the next page; absent on the last one.
    pub next_cursor: Option<String>,
}

/// What the list is asked for. Every field is optional on the wire: an empty one means "no such filter".
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IssueQuery {
    /// Sentry's search syntax, passed on as it is (`is:unresolved level:error browser:Safari`, or plain words).
    pub query: String,
    /// `unresolved` (default), `resolved`, `ignored` or `all`.
    pub status: String,
    /// How far back: `24h`, `7d`, `14d`, `30d`, `90d`.
    pub period: String,
    /// `date` (last seen), `freq` (most events), `new` (first seen), `user` (most users).
    pub sort: String,
    /// A project id.
    pub project: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextLine {
    pub line: u32,
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub filename: String,
    pub function: String,
    pub line: Option<u32>,
    pub in_app: bool,
    /// The source lines around `line`, when Sentry has them.
    pub context: Vec<ContextLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionInfo {
    pub kind: String,
    pub value: String,
    /// Oldest call first, the failing one last (Sentry's own order); at most the last 30.
    pub frames: Vec<Frame>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Breadcrumb {
    pub timestamp: String,
    pub category: String,
    pub message: String,
    pub level: String,
}

/// The newest event of an issue, boiled down to what is worth reading before a fix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSummary {
    pub event_id: String,
    pub date_created: String,
    pub platform: String,
    pub release: Option<String>,
    pub environment: Option<String>,
    pub message: String,
    pub exceptions: Vec<ExceptionInfo>,
    /// The last 15, oldest first.
    pub breadcrumbs: Vec<Breadcrumb>,
    pub tags: Vec<Tag>,
    pub request_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub issue: Issue,
    /// Absent when the newest event could not be read (the issue still shows).
    pub event: Option<EventSummary>,
}
