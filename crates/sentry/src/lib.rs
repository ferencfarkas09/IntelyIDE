//! The Sentry integration: the issues of one organization (a list with filters and search, one issue with its latest event) and
//! the three things an agent hand-off needs (assign the issue to me, mark it resolved, open it in the browser).
//!
//! The only door is [`client::Client`]: a Rust-side HTTP client with a host rule (https, or loopback http for tests), no
//! redirects, a `(method, path)` allow-list, response caps and the token redacted on every error path. The token lives in the
//! Keychain; nothing is requested until a token and an organization are set and a view asks. Tauri glue:
//! `src-tauri/src/modules/sentry.rs`.

pub mod client;
pub mod parse;
pub mod service;
pub mod types;

pub use client::Client;
pub use service::Sentry;
pub use types::{ApiProblem, Config, Connection, Issue, IssueDetail, IssuePage, IssueQuery, Project, Status};
