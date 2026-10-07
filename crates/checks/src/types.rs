//! Serde types that cross the IPC boundary (camelCase). Hand-mirrored in `ui/src/modules/checks/types.ts` and
//! `ui/src/modules/hygiene/types.ts`. Script bodies, secret values and `.env` values are never part of them.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInfo {
    pub id: String,
    pub label: String,
    /// `lint`, `test`, `syntax`, `swagger` or `cargo`.
    pub kind: String,
    /// What is executed, e.g. `npm run lint:changed`. The script name only, never the body.
    pub runner: String,
    /// Changed files the check is aimed at (0 for whole-repo checks).
    pub file_count: u32,
    /// Why the check cannot run right now (no matching changed files).
    pub disabled: Option<String>,
    /// A caveat shown next to the check, e.g. "may regenerate files".
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckStatus {
    Running,
    Passed,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    /// `<repoId>:<checkId>`; one instance per check, the log survives a restart.
    pub id: String,
    pub repo_id: String,
    pub check_id: String,
    pub label: String,
    pub runner: String,
    pub status: CheckStatus,
    pub exit_code: Option<i32>,
    /// Unix seconds.
    pub started_at: u32,
    pub duration_ms: u32,
}

/// Masked and redacted lines, ANSI kept. `reset` is true after a restart: drop what you have.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogChunk {
    pub run_id: String,
    pub start_seq: u32,
    pub lines: Vec<String>,
    pub reset: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub path: String,
    /// 1-based line in the new file; 0 when unknown.
    pub line: u32,
    pub kind: String,
    /// The line with the matched text replaced by a marker. The secret itself never leaves the engine.
    pub preview: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretScan {
    pub repo_id: String,
    pub findings: Vec<Finding>,
    /// Ticked files not read on purpose (`.env` files, binaries, too large).
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvFile {
    pub path: String,
    /// `example` (names read) or `real` (existence only: the content is refused).
    pub kind: String,
    /// Environment label from the file name: `default`, `production`, ...
    pub environment: String,
    pub names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingVar {
    pub name: String,
    /// Up to three source files that reference it.
    pub used_in: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEnv {
    pub repo_id: String,
    pub files: Vec<EnvFile>,
    pub declared: u32,
    pub referenced: u32,
    pub missing: Vec<MissingVar>,
    /// Real count of undeclared names; `missing` is capped, so this tells the UI when the list is partial.
    pub missing_total: u32,
    /// Declared in an example file, never referenced in code.
    pub unused: Vec<String>,
    pub has_example: bool,
    pub scanned_files: u32,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub repo_id: String,
    pub declared: bool,
    pub referenced: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NameRow {
    pub name: String,
    pub repos: Vec<Presence>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvReport {
    pub repos: Vec<RepoEnv>,
    pub names: Vec<NameRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRow {
    pub name: String,
    pub current: bool,
    pub protected: bool,
    pub merged: bool,
    pub ahead: u32,
    pub behind: u32,
    pub last_commit_ts: i64,
    pub age_days: u32,
    pub subject: String,
    pub upstream: Option<String>,
    pub upstream_gone: bool,
    pub stale: bool,
    /// Safe delete is offered (merged, not current, not protected).
    pub deletable: bool,
    pub blocked: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRow {
    pub name: String,
    pub ts: i64,
    pub annotated: bool,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hygiene {
    pub repo_id: String,
    pub default_branch: Option<String>,
    pub stale_days: u32,
    pub branches: Vec<BranchRow>,
    pub tags: Vec<TagRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRow {
    pub path: String,
    pub name: String,
    pub head: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub locked: bool,
    pub prunable: bool,
    /// The repository's own checkout.
    pub main: bool,
    /// Created by the IDE and tracked in its state: the only kind it may remove.
    pub owned: bool,
    /// `cursor` for worktrees under `.cursor`, `other` for the rest; `None` for the main checkout and owned ones.
    pub external: Option<String>,
}
