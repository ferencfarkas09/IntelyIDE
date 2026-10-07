//! Serde types of the `ipc.graph` namespace (camelCase, like `intely-core`); exported to `ui/src/bindings/graph.ts` by
//! `pnpm bindings`. Times are epoch milliseconds.

use std::collections::BTreeMap;

use intely_core::{EngineError, RepoId};
use serde::{Deserialize, Serialize};
#[cfg(feature = "specta")]
use specta_typescript::Number;

macro_rules! api_types {
    ($($item:item)*) => {
        $(
            #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
            #[cfg_attr(feature = "specta", derive(specta::Type))]
            $item
        )*
    };
}

/// Commits per `logPage` call unless the caller asks for fewer.
pub const LOG_PAGE_SIZE: u32 = 500;

api_types! {
    #[serde(rename_all = "camelCase")]
    pub enum RefKind {
        /// A detached `HEAD`.
        Head,
        Branch,
        Remote,
        Tag,
    }

    /// One ref pointing at a commit (`--decorate=full`, namespaces stripped).
    #[serde(rename_all = "camelCase")]
    pub struct RefDecoration {
        pub name: String,
        pub kind: RefKind,
        /// `HEAD` points here (the checked-out branch, or the detached head).
        pub current: bool,
    }

    /// Colour and label of a repo, for the stripe in the interleaved timeline.
    #[serde(rename_all = "camelCase")]
    pub struct RepoStripe {
        pub repo_id: RepoId,
        pub name: String,
        pub color: String,
        pub badge: String,
    }

    /// `up`: a line from the top of the row at lane `from` into the node at lane `to` (a child arriving or a lane
    /// merging). `down`: from the node (`from`) to the bottom of the row at lane `to` (a parent). `through`: a lane
    /// that only passes the row (`from == to`).
    #[serde(rename_all = "camelCase")]
    pub enum LaneEdgeKind {
        Up,
        Down,
        Through,
    }

    #[serde(rename_all = "camelCase")]
    pub struct LaneEdge {
        pub from: u32,
        pub to: u32,
        /// Stable colour index of the line; the UI maps it onto a palette modulo its size.
        pub color: u32,
        pub kind: LaneEdgeKind,
    }

    /// One commit of the log. `lane`, `color`, `edges` and `width` describe the drawing of the repo's own graph; in a
    /// multi-repo timeline every repo has its own lane space and the row is tinted by `repoId`'s stripe.
    #[serde(rename_all = "camelCase")]
    pub struct GraphRow {
        pub repo_id: RepoId,
        pub oid: String,
        pub short_oid: String,
        pub parents: Vec<String>,
        pub subject: String,
        pub author: String,
        pub author_email: String,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub date_ms: i64,
        /// Names of `decorations`, for simple chips.
        pub refs: Vec<String>,
        pub decorations: Vec<RefDecoration>,
        pub lane: u32,
        pub color: u32,
        pub edges: Vec<LaneEdge>,
        /// Number of lanes this row occupies (the drawing needs `width * laneWidth` pixels).
        pub width: u32,
    }

    #[derive(Default)]
    #[serde(rename_all = "camelCase")]
    pub struct LogFilters {
        /// A single ref to walk; default: every branch, remote branch, tag and `HEAD`.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub branch: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub author: Option<String>,
        /// Case-insensitive substring of the commit message.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub text: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub path: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub since_ms: Option<i64>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub until_ms: Option<i64>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct LogPage {
        /// Newest first by commit time across repos; within a repo in `--topo-order`.
        pub rows: Vec<GraphRow>,
        /// Opaque; pass it back (with the same filters) for the next page. Absent on the last page.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub next_cursor: Option<String>,
        pub repos: Vec<RepoStripe>,
    }

    #[serde(rename_all = "camelCase")]
    pub enum FileKind {
        Added,
        Modified,
        Deleted,
        Renamed,
        Copied,
        TypeChange,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ChangedPath {
        pub path: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub orig_path: Option<String>,
        pub kind: FileKind,
        /// `None` for binary files.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub additions: Option<u32>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub deletions: Option<u32>,
        pub binary: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct CommitDetail {
        pub repo_id: RepoId,
        pub oid: String,
        pub short_oid: String,
        pub parents: Vec<String>,
        pub subject: String,
        /// The full message.
        pub message: String,
        pub author: String,
        pub author_email: String,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub date_ms: i64,
        pub refs: Vec<String>,
        pub decorations: Vec<RefDecoration>,
        /// Against the first parent (the empty tree for a root commit).
        pub files: Vec<ChangedPath>,
        pub additions: u32,
        pub deletions: u32,
    }

    #[serde(rename_all = "camelCase")]
    pub struct BlameLine {
        /// 1-based.
        pub line: u32,
        pub oid: String,
        pub author: String,
        pub author_email: String,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub date_ms: i64,
        /// Subject of the commit that last touched the line.
        pub summary: String,
        pub text: String,
        /// The root of a shallow or limited history (`^` in plain blame).
        pub boundary: bool,
        /// Changed in the working tree and not committed yet.
        pub uncommitted: bool,
    }

    /// The status-bar / inline blame of the line under the caret.
    #[serde(rename_all = "camelCase")]
    pub struct BlameCaret {
        pub line: u32,
        pub oid: String,
        pub short_oid: String,
        pub author: String,
        pub author_email: String,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub date_ms: i64,
        /// "3 days ago"; "Not committed yet" for an uncommitted line.
        pub relative_time: String,
        pub subject: String,
        pub uncommitted: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub enum RebaseAction {
        Pick,
        Reword,
        Squash,
        Fixup,
        Drop,
    }

    #[serde(rename_all = "camelCase")]
    pub struct RebaseStep {
        pub action: RebaseAction,
        /// Full oid of a commit in `onto..HEAD`.
        pub oid: String,
        pub subject: String,
        /// `reword`: the new message (required). `squash`: the final message of the whole chain (optional, default is
        /// git's combination of the messages). Not allowed on other actions.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub message: Option<String>,
    }

    /// Oldest first, like the todo list of `git rebase -i`.
    #[serde(rename_all = "camelCase")]
    pub struct RebasePlan {
        pub repo_id: RepoId,
        pub onto: String,
        pub steps: Vec<RebaseStep>,
    }

    #[serde(rename_all = "camelCase")]
    pub enum InProgressOp {
        None,
        Rebase,
        CherryPick,
    }

    #[serde(rename_all = "camelCase")]
    pub enum OpStatus {
        /// Nothing in progress.
        Idle,
        Done,
        /// Stopped on unmerged paths: resolve and stage them, then `continue`, or `abort`.
        Conflict,
        /// In progress without conflicts (for example a failed hook): `continue` or `abort`.
        Stopped,
    }

    /// Result of a rebase / cherry-pick call and of `rebaseState`.
    #[serde(rename_all = "camelCase")]
    pub struct OpOutcome {
        pub repo_id: RepoId,
        pub kind: InProgressOp,
        pub status: OpStatus,
        /// 1-based step being applied, 0 when unknown.
        pub step: u32,
        pub total: u32,
        pub conflict_files: Vec<String>,
        /// `HEAD` after the call.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub head: Option<String>,
        /// What git printed when it stopped.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub message: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct BranchCell {
        pub exists: bool,
        pub current: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub upstream: Option<String>,
        pub ahead: u32,
        pub behind: u32,
        /// The upstream branch was deleted on the remote.
        pub gone: bool,
    }

    /// One repo's checked-out branch.
    #[serde(rename_all = "camelCase")]
    pub struct RepoBranchInfo {
        pub repo_id: RepoId,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub current: Option<String>,
        /// `HEAD` is not on a branch (detached or unborn).
        pub detached: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub upstream: Option<String>,
        pub ahead: u32,
        pub behind: u32,
        pub gone: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct BranchRow {
        pub name: String,
        pub cells: BTreeMap<RepoId, BranchCell>,
        /// The branch exists in every repo of the matrix.
        pub in_all: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct BranchMatrix {
        pub repos: Vec<RepoBranchInfo>,
        /// Sorted by name.
        pub branches: Vec<BranchRow>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct RepoOpResult {
        pub repo_id: RepoId,
        pub ok: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub error: Option<EngineError>,
    }

    /// `applied` is false when a preflight failed in any repo: nothing was changed, `repos` tells why.
    #[serde(rename_all = "camelCase")]
    pub struct SameBranchResult {
        pub branch: String,
        pub applied: bool,
        pub repos: Vec<RepoOpResult>,
    }

    #[serde(rename_all = "camelCase")]
    pub enum BundleSource {
        /// Linked by the IDE when one coordinated commit created the commits.
        Recorded,
        /// Same subject in several repos within a time window.
        Heuristic,
    }

    #[serde(rename_all = "camelCase")]
    pub struct BundleLink {
        pub repo_id: RepoId,
        pub oid: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct BundleCommit {
        pub repo_id: RepoId,
        pub oid: String,
        pub short_oid: String,
        pub subject: String,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub date_ms: i64,
        /// No branch or tag reaches the commit any more (rewritten by a rebase or amend).
        pub missing: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct Bundle {
        pub id: String,
        pub name: String,
        pub source: BundleSource,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub branch: Option<String>,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub created_ms: i64,
        pub repo_ids: Vec<RepoId>,
        pub commits: Vec<BundleCommit>,
    }

    #[serde(rename_all = "camelCase")]
    pub enum MessageStyle {
        /// `type(scope): description`, optional body.
        Conventional,
        /// Conventional header plus the `Extended English:` and `Magyar bővített leírás:` paragraphs.
        Extended,
    }

    #[serde(rename_all = "camelCase")]
    pub enum Severity {
        Error,
        Warning,
    }

    #[serde(rename_all = "camelCase")]
    pub struct MessageIssue {
        pub severity: Severity,
        /// Stable id such as `header.format` or `extended.missingHungarian`.
        pub code: String,
        pub message: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ParsedHeader {
        #[serde(rename = "type")]
        pub kind: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub scope: Option<String>,
        pub breaking: bool,
        pub description: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct MessageCheck {
        /// No errors (warnings do not count).
        pub ok: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub header: Option<ParsedHeader>,
        pub issues: Vec<MessageIssue>,
    }

    #[serde(rename_all = "camelCase")]
    pub enum DraftSource {
        /// Derived from the paths and stats only.
        Template,
        /// Written by the utility model and validated.
        Model,
    }

    #[serde(rename_all = "camelCase")]
    pub struct SelectedPath {
        pub path: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct MessageDraft {
        pub message: String,
        pub source: DraftSource,
        /// Why the model was not used, or what it got wrong.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub note: Option<String>,
        pub issues: Vec<MessageIssue>,
    }
}

#[cfg(feature = "specta")]
pub fn type_collection() -> specta::Types {
    specta::Types::default()
        .register::<LogPage>()
        .register::<LogFilters>()
        .register::<CommitDetail>()
        .register::<BlameLine>()
        .register::<BlameCaret>()
        .register::<RebasePlan>()
        .register::<OpOutcome>()
        .register::<BranchMatrix>()
        .register::<SameBranchResult>()
        .register::<Bundle>()
        .register::<BundleLink>()
        .register::<MessageStyle>()
        .register::<MessageCheck>()
        .register::<MessageDraft>()
        .register::<SelectedPath>()
}

#[cfg(all(test, feature = "specta"))]
mod tests {
    #[test]
    fn the_type_collection_exports_to_typescript() {
        specta_typescript::Typescript::default().export(&super::type_collection(), specta_serde::Format).expect("export");
    }
}
