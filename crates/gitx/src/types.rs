//! Serde types that cross the IPC boundary (camelCase). Hand-mirrored in `ui/src/modules/pr/types.ts` and
//! `ui/src/modules/settings-core/doctorTypes.ts`. Tokens, credential values and script bodies are never part of them.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    /// `None` when it was not asked (no network allowed, or `gh` is missing).
    pub authenticated: Option<bool>,
    /// The jail code (`readOnly`, `testJail`) that stops network calls right now.
    pub blocked: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    /// `OPEN`, `CLOSED` or `MERGED`.
    pub state: String,
    pub is_draft: bool,
    pub head: String,
    pub base: String,
    pub author: String,
    pub url: String,
    /// `approved`, `changesRequested`, `reviewRequired` or `none`.
    pub review: String,
    /// `passing`, `failing`, `pending` or `none`.
    pub ci: String,
    pub checks_passed: u32,
    pub checks_failed: u32,
    pub checks_pending: u32,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrList {
    pub branch: Option<String>,
    /// Open PRs whose head is the current branch.
    pub current: Vec<PrSummary>,
    /// Open PRs of the signed-in user.
    pub mine: Vec<PrSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: String,
    pub workflow: String,
    pub state: String,
    /// `pass`, `fail`, `pending`, `skipping` or `cancel`.
    pub bucket: String,
    pub link: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReview {
    pub author: String,
    /// `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`.
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetail {
    pub summary: PrSummary,
    pub body: String,
    pub reviews: Vec<PrReview>,
    pub checks: Vec<PrCheck>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCommit {
    pub sha: String,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePlan {
    pub repo_name: String,
    pub head: Option<String>,
    pub base: Option<String>,
    pub bases: Vec<String>,
    pub upstream: Option<String>,
    /// Commits the branch has that its upstream does not: they would not be in the PR until pushed.
    pub unpushed: u32,
    pub commits: Vec<PlanCommit>,
    pub title: String,
    pub body: String,
    pub draft: bool,
    /// The exact command, shell-quoted for display; what runs is the same argv.
    pub command: String,
    /// Why Create is off right now; the draft is still shown.
    pub refusal: Option<Refusal>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub title: String,
    pub body: String,
    pub base: String,
    pub draft: bool,
    /// What the human typed; both must equal the repo name and the head branch exactly.
    pub confirm_repo: String,
    pub confirm_head: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateResult {
    pub url: String,
    pub command: String,
}

// ---- Doctor ---------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Ok,
    Info,
    Warn,
    Error,
}

/// A name the report lists (a tool path, a lock file, a directory, a process), with the numbers that belong to it.
/// Names and paths only, never values.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorItem {
    pub name: String,
    pub count: Option<u64>,
    pub bytes: Option<u64>,
    pub age_minutes: Option<u64>,
}

/// One line of the report. `code` and `params` are translated by the UI; `items` are names and paths, never values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    /// `tools`, `credentials`, `path`, `repo`, `disk`, `leftovers`.
    pub group: String,
    pub level: Level,
    pub code: String,
    pub params: std::collections::BTreeMap<String, String>,
    pub items: Vec<DoctorItem>,
    pub repo_id: Option<String>,
    /// A safe, reversible action offered next to the line: `refreshEnv`.
    pub fix: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub checks: Vec<DoctorCheck>,
    /// Epoch milliseconds.
    pub generated_at: i64,
}
