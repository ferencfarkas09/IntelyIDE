//! Shared engine <-> UI types (contract section 2). Wire format: camelCase, enums as string unions,
//! times in epoch milliseconds, sizes in bytes. 64-bit integers are exported to TypeScript as `number`.

use std::collections::BTreeMap;

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

pub type RepoId = String;

api_types! {
    #[serde(rename_all = "camelCase")]
    pub struct PushTargetMapping {
        pub remote: String,
        pub branch: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct RepoConfig {
        pub id: RepoId,
        pub path: String,
        pub name: String,
        /// `#rrggbb`
        pub color: String,
        /// 1-2 characters
        pub badge: String,
        pub order: u32,
        /// Local branch -> push target; never written to git config.
        pub push_targets: BTreeMap<String, PushTargetMapping>,
    }

    #[serde(rename_all = "camelCase")]
    pub enum MessageMode {
        Shared,
        PerRepo,
    }

    #[serde(rename_all = "camelCase")]
    pub struct WorkspaceSettings {
        pub message_mode: MessageMode,
        pub untracked_checked: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct Workspace {
        pub version: u32,
        pub repos: Vec<RepoConfig>,
        pub protected_branches: Vec<String>,
        /// Extra live-branch patterns per repo id, merged with `protectedBranches` (default empty).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub live_branches: BTreeMap<RepoId, Vec<String>>,
        pub settings: WorkspaceSettings,
    }

    #[serde(rename_all = "camelCase")]
    pub enum EnvState {
        Resolving,
        Ready,
        Failed,
    }

    #[serde(rename_all = "kebab-case")]
    pub enum EnvSource {
        LoginShell,
        Fallback,
    }

    #[serde(rename_all = "camelCase")]
    pub struct EnvStatus {
        pub state: EnvState,
        pub git_path: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub node_path: Option<String>,
        pub source: EnvSource,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub message: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct HeadInfo {
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub branch: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub oid: Option<String>,
        pub detached: bool,
        pub unborn: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct UpstreamInfo {
        pub remote: String,
        pub branch: String,
        pub gone: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub enum RepoState {
        Normal,
        Merging,
        Rebasing,
        CherryPicking,
        Reverting,
        Bisecting,
    }

    #[serde(rename_all = "camelCase")]
    pub enum HookKind {
        None,
        Husky,
        Custom,
    }

    #[serde(rename_all = "camelCase")]
    pub struct HookInfo {
        pub kind: HookKind,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub path: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub enum ChangeKind {
        Modified,
        Added,
        Deleted,
        Renamed,
        Copied,
        TypeChanged,
        Untracked,
        Conflicted,
        Submodule,
    }

    #[serde(rename_all = "camelCase")]
    pub enum GuardState {
        Ok,
        NeverAdd,
        Secret,
        TooLarge,
        // A tracked file whose name looks like a secret: committable, but flagged for an extra confirmation.
        Sensitive,
    }

    #[serde(rename_all = "camelCase")]
    pub struct Change {
        pub path: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub orig_path: Option<String>,
        pub kind: ChangeKind,
        /// One character, `" "` if none.
        pub index_status: String,
        /// One character, `" "` if none.
        pub worktree_status: String,
        pub staged: bool,
        pub partially_staged: bool,
        pub guard: GuardState,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub binary: Option<bool>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub size_bytes: Option<u64>,
        /// Collapsed untracked directory; `path` ends with `/`.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub dir: Option<bool>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct RepoSnapshot {
        pub repo_id: RepoId,
        /// Monotonic per repo.
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub revision: u64,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub taken_at_ms: i64,
        pub head: HeadInfo,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub upstream: Option<UpstreamInfo>,
        pub ahead: u32,
        pub behind: u32,
        pub state: RepoState,
        pub hooks: HookInfo,
        pub changes: Vec<Change>,
        pub stash_count: u32,
        pub worktree_count: u32,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub error: Option<String>,
    }

    #[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
    pub enum DiffSource {
        WorktreeVsHead,
        StagedVsHead,
        Commit { oid: String },
    }

    #[serde(rename_all = "camelCase")]
    pub struct FileContents {
        pub path: String,
        pub original: String,
        pub modified: String,
        pub binary: bool,
        pub too_large: bool,
        pub guard: GuardState,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub language: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub enum HunkLineKind {
        Context,
        Add,
        Del,
    }

    #[serde(rename_all = "camelCase")]
    pub struct HunkLine {
        pub kind: HunkLineKind,
        pub text: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct Hunk {
        pub index: u32,
        pub header: String,
        pub old_start: u32,
        pub old_lines: u32,
        pub new_start: u32,
        pub new_lines: u32,
        pub lines: Vec<HunkLine>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct HunkSelection {
        pub index: u32,
        /// Indexes into `Hunk::lines`; `None` selects the whole hunk.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub lines: Option<Vec<u32>>,
    }

    #[serde(tag = "mode", rename_all = "camelCase", rename_all_fields = "camelCase")]
    pub enum FileSelection {
        Whole {
            path: String,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(optional))]
            orig_path: Option<String>,
        },
        Partial {
            path: String,
            hunks: Vec<HunkSelection>,
        },
    }

    #[serde(rename_all = "camelCase")]
    pub struct RepoCommit {
        pub repo_id: RepoId,
        pub files: Vec<FileSelection>,
        pub message: String,
        pub amend: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct CommitRequest {
        /// uuid from the caller
        pub run_id: String,
        pub repos: Vec<RepoCommit>,
        pub no_verify: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub enum StepStatus {
        Queued,
        Preparing,
        Hooks,
        Committing,
        Reconciling,
        Pushing,
        Done,
        Skipped,
        Failed,
        Cancelled,
    }

    #[serde(rename_all = "camelCase")]
    pub enum FailureKind {
        HookRejected,
        NothingToCommit,
        EmptyMessage,
        Conflict,
        LockBusy,
        HeadMoved,
        Auth,
        NonFastForward,
        RemoteDeclined,
        Network,
        GuardBlocked,
        InvalidSelection,
        Unknown,
    }

    #[serde(rename_all = "camelCase")]
    pub struct Failure {
        pub kind: FailureKind,
        pub message: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub output: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub enum PushFlag {
        #[serde(rename = " ")]
        FastForward,
        #[serde(rename = "+")]
        Forced,
        #[serde(rename = "-")]
        Deleted,
        #[serde(rename = "*")]
        NewRef,
        #[serde(rename = "=")]
        UpToDate,
        #[serde(rename = "!")]
        Rejected,
    }

    #[serde(rename_all = "camelCase")]
    pub struct PushRefResult {
        pub flag: PushFlag,
        pub from: String,
        pub to: String,
        pub summary: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub reason: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct RepoOutcome {
        pub repo_id: RepoId,
        pub status: StepStatus,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub commit_oid: Option<String>,
        /// Commit succeeded but the real-index reset is still pending.
        pub reconciled: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub failure: Option<Failure>,
        pub hook_modified_files: Vec<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub push_results: Option<Vec<PushRefResult>>,
    }

    #[serde(rename_all = "camelCase")]
    pub enum OpKind {
        Commit,
        Push,
        Pull,
        Fetch,
    }

    #[serde(rename_all = "camelCase")]
    pub enum StreamKind {
        Stdout,
        Stderr,
    }

    #[serde(rename_all = "camelCase")]
    pub struct OpLine {
        pub stream: StreamKind,
        pub text: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct OpEvent {
        pub run_id: String,
        pub repo_id: RepoId,
        pub kind: OpKind,
        pub status: StepStatus,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub line: Option<OpLine>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub percent: Option<f32>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct OpResult {
        pub run_id: String,
        pub kind: OpKind,
        pub repos: Vec<RepoOutcome>,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub finished_at_ms: i64,
    }

    #[serde(rename_all = "camelCase")]
    pub struct CommitInfo {
        pub oid: String,
        pub short_oid: String,
        pub subject: String,
        pub author: String,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub date_ms: i64,
    }

    #[serde(rename_all = "camelCase")]
    pub struct OutgoingInfo {
        pub repo_id: RepoId,
        pub local: String,
        pub remote: String,
        pub remote_branch: String,
        pub new_remote_branch: bool,
        pub protected: bool,
        pub commits: Vec<CommitInfo>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub stale_as_of_ms: Option<i64>,
        pub checked_by_default: bool,
        pub can_push: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub blocked_reason: Option<String>,
        /// Commits on the remote-tracking branch that the local branch lacks (a forced push would drop them);
        /// absent while the tracking ref does not exist.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub remote_only: Option<u32>,
        /// Tip of the remote-tracking branch this plan was computed against (the lease value of a forced push);
        /// absent while the tracking ref does not exist.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub remote_oid: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ChangedFile {
        pub path: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub orig_path: Option<String>,
        pub kind: ChangeKind,
    }

    #[serde(rename_all = "camelCase")]
    pub enum TagsMode {
        None,
        Follow,
        All,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ForceWithLease {
        pub seen_oid: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct PushTarget {
        pub repo_id: RepoId,
        pub remote: String,
        pub remote_branch: String,
        pub tags: TagsMode,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub force_with_lease: Option<ForceWithLease>,
        /// The remote branch name typed by the human; required when the target is a live branch.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub confirm_live: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct PushRequest {
        pub run_id: String,
        pub targets: Vec<PushTarget>,
        pub no_verify: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct DoctorRepo {
        pub repo_id: RepoId,
        pub ls_remote_ok: bool,
        pub hooks: HookInfo,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub message: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct DoctorReport {
        pub git_path: String,
        pub git_version: String,
        pub credential_helpers: Vec<String>,
        pub path_has_node: bool,
        pub repos: Vec<DoctorRepo>,
    }

    #[serde(rename_all = "camelCase")]
    pub enum PullMode {
        FfOnly,
        Merge,
        Rebase,
    }

    // Command return shapes (contract section 4).

    #[serde(rename_all = "camelCase")]
    pub struct EngineStatus {
        pub env: EnvStatus,
        pub repo_ids: Vec<RepoId>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct UntrackedList {
        pub files: Vec<Change>,
        pub truncated: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct RunStarted {
        pub run_id: String,
    }

    // Workspaces ((design notes: workspaces-spec) 4.3, 4.5, 4.9, 4.11, Appendix B).

    #[serde(rename_all = "camelCase")]
    pub enum WorkspaceOrigin {
        Created,
        Duplicate,
        OpenedFolder,
        Scanned,
        Migrated,
    }

    /// One line of `workspaces.json`.
    #[serde(rename_all = "camelCase")]
    pub struct WorkspaceEntry {
        pub id: String,
        pub name: String,
        /// `#rrggbb`
        pub color: String,
        pub order: u32,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub created_at: i64,
        #[cfg_attr(feature = "specta", specta(type = Option<Number>))]
        pub last_opened_at: Option<i64>,
        pub origin: WorkspaceOrigin,
    }

    #[serde(rename_all = "camelCase")]
    pub struct RepoSummary {
        pub id: String,
        pub name: String,
        pub color: String,
        pub badge: String,
        pub path: String,
    }

    /// State of a workspace's own file as the registry sees it.
    #[serde(rename_all = "camelCase")]
    pub enum WorkspaceFileState {
        Ok,
        Damaged,
        Missing,
    }

    #[serde(rename_all = "camelCase")]
    pub struct WorkspaceSummary {
        pub id: String,
        pub name: String,
        pub color: String,
        pub order: u32,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub created_at: i64,
        #[cfg_attr(feature = "specta", specta(type = Option<Number>))]
        pub last_opened_at: Option<i64>,
        pub origin: WorkspaceOrigin,
        pub repos: Vec<RepoSummary>,
        /// Absent when everything is fine (older UIs ignore it).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub file_state: Option<WorkspaceFileState>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct BackupInfo {
        pub name: String,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub at: i64,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub workspaces: u32,
    }

    #[serde(rename_all = "camelCase")]
    pub enum ProblemKind {
        Corrupt,
        NewerVersion,
        LegacyUnreadable,
        IoError,
        TestJail,
        OtherInstance,
    }

    #[serde(rename_all = "camelCase")]
    pub struct RegistryProblem {
        pub kind: ProblemKind,
        pub message: String,
        pub backups: Vec<BackupInfo>,
    }

    #[serde(rename_all = "camelCase")]
    pub enum OpenErrorReason {
        AllMissing,
        FileDamaged,
        FileMissing,
    }

    /// Why the active workspace could not be opened at launch.
    #[serde(rename_all = "camelCase")]
    pub struct OpenError {
        pub id: String,
        pub reason: OpenErrorReason,
    }

    /// The workspace the last two launches never finished opening (crash-loop guard): the app starts on Welcome.
    #[serde(rename_all = "camelCase")]
    pub struct CrashLoopNotice {
        pub id: String,
        pub name: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct RegistryView {
        pub version: u32,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub rev: u64,
        pub active_id: Option<String>,
        pub pinned: bool,
        pub workspaces: Vec<WorkspaceSummary>,
        pub problem: Option<RegistryProblem>,
        pub open_error: Option<OpenError>,
        /// Epoch of the running engine generation (filled by the app, not by the registry).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional, type = Option<Number>))]
        pub epoch: Option<u64>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub crash_loop: Option<CrashLoopNotice>,
        /// This launch migrated the legacy `workspace.json`: the page shows its one-time notice (filled by the app, once).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub just_migrated: bool,
        /// `INTELY_WORKSPACES` was set but ignored because no jail is active.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub env_ignored: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub enum RepoStatus {
        Ok,
        Missing,
        VolumeMissing,
        NotRepo,
        NoAccess,
        Unresponsive,
    }

    #[serde(rename_all = "camelCase")]
    pub struct RepoProbe {
        pub repo_id: String,
        pub status: RepoStatus,
        pub branch: Option<String>,
        pub detached: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct WorkspaceProbe {
        pub id: String,
        pub repos: Vec<RepoProbe>,
    }

    #[serde(rename_all = "camelCase")]
    pub enum BusyKind {
        GitRun,
        GitOp,
        Agent,
        DevServer,
        Check,
        Terminal,
        Preview,
        Mongo,
        Unsaved,
    }

    /// `labels` are data (server names, repo names, file names), never English sentences.
    #[serde(rename_all = "camelCase")]
    pub struct BusyItem {
        pub kind: BusyKind,
        pub count: u32,
        pub labels: Vec<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct BusyReport {
        pub blocking: Vec<BusyItem>,
        pub confirmable: Vec<BusyItem>,
    }

    /// A subsystem that did not finish in its budget; `code` is e.g. `runnerStuck`, translated by the UI.
    #[serde(rename_all = "camelCase")]
    pub struct SwitchWarning {
        pub code: String,
        pub subsystem: String,
    }

    #[serde(rename_all = "camelCase")]
    pub enum SurvivorKind {
        DevServer,
        Terminal,
        Check,
        Preview,
    }

    /// A process of the old workspace that ignored the group kill.
    #[serde(rename_all = "camelCase")]
    pub struct Survivor {
        pub pid: u32,
        pub port: Option<u16>,
        pub cwd: String,
        pub kind: SurvivorKind,
    }

    #[serde(rename_all = "camelCase")]
    pub struct SwitchResult {
        pub active_id: Option<String>,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub epoch: u64,
        pub warnings: Vec<SwitchWarning>,
        pub survivors: Vec<Survivor>,
    }

    /// Branch patterns that apply to one repository, whatever workspace it is opened from (I7).
    #[serde(rename_all = "camelCase")]
    pub struct Protection {
        pub protected: Vec<String>,
        pub live: Vec<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct CreateResult {
        pub entry: WorkspaceEntry,
        pub reused: bool,
    }
}

/// Error codes carried in [`EngineError::code`].
pub mod code {
    pub const NOT_A_REPO: &str = "notARepo";
    pub const REPO_MISSING: &str = "repoMissing";
    pub const GUARD_BLOCKED: &str = "guardBlocked";
    pub const INVALID_SELECTION: &str = "invalidSelection";
    pub const LOCK_BUSY: &str = "lockBusy";
    pub const HEAD_MOVED: &str = "headMoved";
    pub const CANCELLED: &str = "cancelled";
    pub const IO: &str = "io";
    pub const GIT: &str = "git";
    pub const UNIMPLEMENTED: &str = "unimplemented";

    // Workspaces ((design notes: workspaces-spec) 4.5, Appendix B). Codes only: the UI translates them.
    pub const REGISTRY_CORRUPT: &str = "registryCorrupt";
    pub const UNSUPPORTED_VERSION: &str = "unsupportedVersion";
    pub const REGISTRY_BUSY: &str = "registryBusy";
    pub const WORKSPACE_NOT_FOUND: &str = "workspaceNotFound";
    pub const WORKSPACE_ACTIVE: &str = "workspaceActive";
    pub const DUPLICATE_NAME: &str = "duplicateName";
    pub const INVALID_NAME: &str = "invalidName";
    pub const INVALID_COLOR: &str = "invalidColor";
    pub const LIMIT_REACHED: &str = "limitReached";
    pub const PINNED: &str = "pinned";
    pub const LEGACY_UNREADABLE: &str = "legacyUnreadable";
    pub const PATH_NOT_VALIDATED: &str = "pathNotValidated";
    pub const NO_WORKSPACE: &str = "noWorkspace";
    pub const WORKSPACE_BUSY: &str = "workspaceBusy";
    pub const WORKSPACE_SWITCHING: &str = "workspaceSwitching";
    pub const STALE_EPOCH: &str = "staleEpoch";
    pub const TRUST_REQUIRED: &str = "trustRequired";
    pub const RISK_CHANGED: &str = "riskChanged";
    pub const OTHER_INSTANCE: &str = "otherInstance";
    pub const TOO_BROAD: &str = "tooBroad";
    pub const INIT_TOO_BROAD: &str = "initTooBroad";
    pub const ALREADY_IN_WORKSPACE: &str = "alreadyInWorkspace";
    pub const WORKSPACE_FILE_MISSING: &str = "workspaceFileMissing";
    pub const INVALID_WORKSPACE: &str = "invalidWorkspace";
    pub const CONFIRM_REQUIRED: &str = "confirmRequired";
}

/// The only error type of the engine facade; serialised as-is to the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[error("{code}: {message}")]
#[serde(rename_all = "camelCase")]
pub struct EngineError {
    pub code: String,
    pub message: String,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub detail: Option<String>,
}

impl EngineError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_owned(), message: message.into(), detail: None }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn unimplemented(what: &str) -> Self {
        Self::new(code::UNIMPLEMENTED, format!("{what} is not implemented yet"))
    }
}

impl From<std::io::Error> for EngineError {
    fn from(e: std::io::Error) -> Self {
        Self::new(code::IO, e.to_string())
    }
}

/// Every type that crosses the IPC boundary, for TypeScript generation.
#[cfg(feature = "specta")]
pub fn type_collection() -> specta::Types {
    specta::Types::default()
        .register::<RepoConfig>()
        .register::<Workspace>()
        .register::<EnvStatus>()
        .register::<EngineStatus>()
        .register::<RepoSnapshot>()
        .register::<UntrackedList>()
        .register::<DiffSource>()
        .register::<FileContents>()
        .register::<Hunk>()
        .register::<CommitRequest>()
        .register::<RunStarted>()
        .register::<OutgoingInfo>()
        .register::<ChangedFile>()
        .register::<PushRequest>()
        .register::<PullMode>()
        .register::<OpEvent>()
        .register::<OpResult>()
        .register::<DoctorReport>()
        .register::<crate::EngineError>()
        .register::<WorkspaceEntry>()
        .register::<WorkspaceSummary>()
        .register::<RepoSummary>()
        .register::<RegistryView>()
        .register::<CrashLoopNotice>()
        .register::<RegistryProblem>()
        .register::<BackupInfo>()
        .register::<WorkspaceProbe>()
        .register::<RepoProbe>()
        .register::<BusyReport>()
        .register::<BusyItem>()
        .register::<SwitchWarning>()
        .register::<Survivor>()
        .register::<SwitchResult>()
        .register::<Protection>()
        .register::<CreateResult>()
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    #[test]
    fn diff_source_is_internally_tagged() {
        let v = serde_json::to_value(DiffSource::Commit { oid: "abc".into() }).unwrap();
        assert_eq!(v, json!({ "kind": "commit", "oid": "abc" }));
        let w: DiffSource = serde_json::from_value(json!({ "kind": "worktreeVsHead" })).unwrap();
        assert_eq!(w, DiffSource::WorktreeVsHead);
    }

    #[test]
    fn file_selection_uses_camel_case_fields() {
        let v: FileSelection = serde_json::from_value(json!({ "mode": "whole", "path": "b", "origPath": "a" })).unwrap();
        assert_eq!(v, FileSelection::Whole { path: "b".into(), orig_path: Some("a".into()) });
    }

    #[test]
    fn push_flag_serialises_as_the_porcelain_character() {
        assert_eq!(serde_json::to_value(PushFlag::UpToDate).unwrap(), json!("="));
        assert_eq!(serde_json::to_value(PushFlag::FastForward).unwrap(), json!(" "));
    }

    #[test]
    fn optional_request_fields_may_be_omitted() {
        let t: PushTarget = serde_json::from_value(
            json!({ "repoId": "r", "remote": "origin", "remoteBranch": "main", "tags": "none" }),
        )
        .unwrap();
        assert_eq!(t.force_with_lease, None);
    }

    #[test]
    fn unimplemented_error_carries_its_code() {
        let e = EngineError::unimplemented("x");
        assert_eq!(e.code, code::UNIMPLEMENTED);
        assert_eq!(serde_json::to_value(&e).unwrap()["code"], json!("unimplemented"));
    }
}
