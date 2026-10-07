//! Serde types of the `ipc.roles` and `ipc.runs` namespaces (camelCase, like `intely-core`). Times are epoch
//! milliseconds. Efforts and permission modes are their own enums here: the wire never depends on `intely-agent-core`.

use serde::{Deserialize, Serialize};

macro_rules! ipc_types {
    ($($item:item)*) => {
        $(
            #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
            #[cfg_attr(feature = "specta", derive(specta::Type))]
            $item
        )*
    };
}

ipc_types! {
    #[derive(Copy, Eq)]
    #[serde(rename_all = "camelCase")]
    pub enum RoleEffort {
        Low,
        Medium,
        High,
        Xhigh,
        Max,
    }

    /// What the role may do to the working tree. Derived from the role file (`store::derive_permission`); `readOnly`
    /// is only the fail-safe default (a broken overlay, an unparsable `tools` line).
    #[derive(Copy, Eq, Default)]
    #[serde(rename_all = "camelCase")]
    pub enum RolePermission {
        #[default]
        ReadOnly,
        Edit,
        Ask,
    }

    #[derive(Copy, Eq, Default)]
    #[serde(rename_all = "camelCase")]
    pub enum RoleScope {
        #[default]
        Global,
        Repo,
    }

    /// Where a role's permission comes from. `ceiling`: clamped because the file lives in a repository (spec 3.2a).
    #[derive(Copy, Eq, Default)]
    #[serde(rename_all = "camelCase")]
    pub enum PermissionSource {
        Overlay,
        Frontmatter,
        Tools,
        AllTools,
        #[default]
        Default,
        OverlayCorrupt,
        Ceiling,
    }

    /// Whether a role file may be handed to an agent. Global files and built-ins are trusted; a repository copy is
    /// trusted when it equals a global copy, approved when the user approved its content hash, otherwise untrusted.
    #[derive(Copy, Eq, Default)]
    #[serde(rename_all = "camelCase")]
    pub enum RoleTrust {
        #[default]
        Trusted,
        Untrusted,
        Approved,
    }

    /// One role: the `~/.claude/agents/<name>.md` (or `<repo>/.claude/agents/<name>.md`) file plus the IDE overlay.
    #[derive(Default)]
    #[serde(rename_all = "camelCase")]
    pub struct Role {
        /// `name` for a global role, `name@repoId` for a repo copy.
        pub id: String,
        pub name: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub description: Option<String>,
        /// Frontmatter value: an alias (`sonnet`, `haiku`, `opus`, `inherit`) or a model id.
        pub model: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub effort: Option<RoleEffort>,
        /// False when the model or provider has no effort control: the control shows "n/a" and no effort is sent.
        pub effort_available: bool,
        #[serde(default)]
        pub tools: Vec<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub system_prompt: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub color: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub memory: Option<String>,
        pub scope: RoleScope,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub repo_id: Option<String>,
        /// The file this role is stored in.
        pub path: String,
        // ---- IDE overlay (settings namespace `roles`) ----
        pub permission: RolePermission,
        pub provider: String,
        /// Repos this role may run on; empty = every repo.
        #[serde(default)]
        pub repo_scope: Vec<String>,
        /// Placeholder for starting this role remotely; stored, not acted on in the alpha.
        #[serde(default)]
        pub remote_startable: bool,
        /// Why the settings are risky or ignored: machine codes (`effortXhigh`, `effortMax`, `effortNotSent`,
        /// `permissionModeIgnored`, `toolsUnparsable`, `mcpToolsIgnoredForDelegates`, `memoryIgnored`, `reserved`,
        /// `duplicateName`, `caseClash`), never sentences. The UI maps them to words.
        #[serde(default)]
        pub warnings: Vec<String>,
        // ---- derived (spec 3.3), all defaulted so older consumers keep working ----
        #[serde(default)]
        pub permission_source: PermissionSource,
        /// Machine reason: `overlay`, `permissionMode:<value>`, `tools:readOnly`, `tools:write`, `tools:all`,
        /// `tools:none`, `tools:unparsable`, `ceiling:<repo|global|builtin>`, `overlayCorrupt`, `builtin`.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub permission_reason: Option<String>,
        /// Frontmatter `disallowedTools` (read only here).
        #[serde(default)]
        pub disallowed_tools: Vec<String>,
        /// Frontmatter `maxTurns` (read only here).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub max_turns: Option<u32>,
        /// sha256 of the normalised effective fields; equal hashes mean "identical copies".
        #[serde(default)]
        pub content_hash: String,
        /// True only for the synthetic role of a host built-in (no file, `path` is empty).
        #[serde(default)]
        pub builtin: bool,
        /// The effective tools include Edit/Write/NotebookEdit (or all tools) and the permission is not read-only.
        #[serde(default)]
        pub can_edit: bool,
        /// The effective tools include Bash/Monitor (or all tools) and the permission is not read-only.
        #[serde(default)]
        pub can_run: bool,
        #[serde(default)]
        pub trust: RoleTrust,
        /// A second file of the same directory with this name: the first one is used, this one stays listed so it can
        /// be deleted. Its id is `<id>#<file stem>`.
        #[serde(default)]
        pub shadowed_by_duplicate: bool,
        /// The file has a `tools` key (an absent key means "all tools"; `tools:` or `tools: []` does not).
        #[serde(default)]
        pub tools_declared: bool,
    }

    /// What the editor sends to save a role. A field left out (`null`) stays as it is in the file and the overlay; an
    /// empty string removes a text field. A new role is global unless `scope` and `repoId` (or an `id` of the form
    /// `name@repoId`) say otherwise.
    #[serde(rename_all = "camelCase")]
    pub struct RoleDraft {
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub id: Option<String>,
        pub name: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub description: Option<String>,
        pub model: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub effort: Option<RoleEffort>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub tools: Option<Vec<String>>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub system_prompt: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub color: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub memory: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub scope: Option<RoleScope>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub repo_id: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub permission: Option<RolePermission>,
        /// Pinned into the overlay only when `permission_explicit` is true, or when it differs from what the file
        /// derives; otherwise the role keeps deriving its permission from its file.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub permission_explicit: Option<bool>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub provider: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub repo_scope: Option<Vec<String>>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub remote_startable: Option<bool>,
        /// Must be `true` for a save that changes a role file (`~/.claude/agents/*.md` or `<repo>/.claude/agents`):
        /// without it the store refuses with `confirmWrite` and writes nothing. The UI sets it after the user confirmed.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub confirm_write: Option<bool>,
    }

    /// A repo copy of a role that differs from the global one.
    #[serde(rename_all = "camelCase")]
    pub struct RoleDrift {
        /// Id of the differing copy.
        pub role_id: String,
        /// Id of the copy it differs from (the global role, or the winner of a group).
        pub global_id: String,
        /// Repository of the differing copy; empty when that copy is the global one.
        pub repo_id: String,
        /// Names of the differing fields (`model`, `effort`, `tools`, `description`, `systemPrompt`, `color`, `memory`,
        /// `disallowedTools`, `maxTurns`).
        pub fields: Vec<String>,
    }

    /// Why a role is not handed to the Auto lead (mirrors `intely_agent_core::delegates::ExcludeReason`).
    #[derive(Copy, Eq)]
    #[serde(rename_all = "camelCase")]
    pub enum ExcludeReason {
        Hidden,
        OtherProvider,
        NoDescription,
        ReservedName,
        PromptTooLarge,
        RepoScope,
        TooMany,
        Untrusted,
    }

    /// Is the group passed to the Auto lead, and if not why.
    #[derive(Default)]
    #[serde(rename_all = "camelCase")]
    pub struct DelegateStatus {
        pub ok: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub reason: Option<ExcludeReason>,
    }

    #[derive(Copy, Eq)]
    #[serde(rename_all = "camelCase")]
    pub enum WinnerReason {
        OnlyCopy,
        Identical,
        Global,
        Pinned,
        PrimaryRepo,
        BuiltIn,
    }

    /// One file of a role group.
    #[serde(rename_all = "camelCase")]
    pub struct RoleCopy {
        /// File id (`name` or `name@repoId`; `<id>#<stem>` for a duplicate name in one directory).
        pub id: String,
        pub scope: RoleScope,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub repo_id: Option<String>,
        pub path: String,
        pub content_hash: String,
        /// Its content hash equals the winner's.
        pub same_as_winner: bool,
        /// Same field names as `RoleDrift.fields`, winner vs this copy.
        pub fields_differ: Vec<String>,
        pub trust: RoleTrust,
        pub shadowed_by_duplicate: bool,
        pub warnings: Vec<String>,
    }

    /// All copies of one role name plus the built-in of that name: the unit the Roles table shows.
    #[serde(rename_all = "camelCase")]
    pub struct RoleGroup {
        /// The group id: the name (first copy's spelling; names compare case-insensitively).
        pub name: String,
        /// The winner with the overlay applied; a synthetic role (`builtin`, empty `path`) for a pure built-in.
        pub role: Role,
        pub copies: Vec<RoleCopy>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub winner_id: Option<String>,
        pub winner_reason: WinnerReason,
        /// Copies differ and there is no valid pin.
        pub conflict: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub pin: Option<String>,
        /// The pinned copy no longer exists (or is not usable): the pin is ignored.
        pub pin_missing: bool,
        pub hidden: bool,
        /// A file overrides a built-in of the same name.
        pub builtin_shadowed: bool,
        /// Winner vs every differing copy.
        pub diffs: Vec<RoleDrift>,
        pub delegate: DelegateStatus,
    }

    /// A role whose overlay permission differs from what its file derives (every role saved by 0.1.0 is pinned
    /// read-only). "Use automatic" removes the overlay permission.
    #[serde(rename_all = "camelCase")]
    pub struct PermissionMismatch {
        pub id: String,
        pub overlay: RolePermission,
        pub derived: RolePermission,
        /// Reason code of the derived permission (see `Role.permission_reason`).
        pub reason: String,
    }

    /// A repository whose `.claude/agents` directory was not read (a symlink, or outside the repository).
    #[serde(rename_all = "camelCase")]
    pub struct SkippedAgentsDir {
        pub repo_id: String,
        pub path: String,
        /// `agentsDirSymlink`.
        pub code: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub target: Option<String>,
    }

    /// Side information of the Roles table: migration list, overlay state, skipped directories.
    #[serde(rename_all = "camelCase")]
    pub struct RolesStatus {
        /// `roles-overlay.json` could not be parsed: every role is read-only and writes are refused until it is reset.
        pub overlay_corrupt: bool,
        /// Where the unreadable bytes were copied.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub overlay_backup: Option<String>,
        pub mismatches: Vec<PermissionMismatch>,
        pub skipped_dirs: Vec<SkippedAgentsDir>,
        /// Canonical target of `~/.claude/agents` when it is a symlink.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub global_dir_target: Option<String>,
        pub global_dir: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct DeleteFile {
        pub id: String,
        pub path: String,
        pub scope: RoleScope,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub repo_id: Option<String>,
        /// Canonical target when the file sits in a symlinked global directory.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub symlink_target: Option<String>,
    }

    /// What the delete dialog shows before it asks for the typed name.
    #[serde(rename_all = "camelCase")]
    pub struct DeletePreview {
        pub name: String,
        pub files: Vec<DeleteFile>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub backup_dir: Option<String>,
        /// The global agents directory is a symlink: the delete needs a second typed confirmation, the target path.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub link_target: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct DeletedFile {
        pub id: String,
        pub path: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct DeleteReport {
        pub deleted: Vec<DeletedFile>,
        pub backups: Vec<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ModelCaps {
        pub id: String,
        pub label: String,
        /// Empty: the model has no effort control.
        pub effort_levels: Vec<RoleEffort>,
    }

    /// What a provider offers a role; the editor's dropdowns are built from this.
    #[serde(rename_all = "camelCase")]
    pub struct RoleProviderCaps {
        pub provider: String,
        pub label: String,
        pub models: Vec<ModelCaps>,
        pub permission_modes: Vec<RolePermission>,
        pub tools: Vec<String>,
    }

    #[derive(Copy, Eq)]
    #[serde(rename_all = "camelCase")]
    pub enum RunState {
        Queued,
        Running,
        NeedsYou,
        Done,
        Error,
    }

    /// A run as the supervisor knows it.
    #[serde(rename_all = "camelCase")]
    pub struct RunRecord {
        /// Host agent id, or `q-<n>` while the run waits in the queue.
        pub agent_id: String,
        /// Provider session id (Claude session UUID); absent until the session opened.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub session_id: Option<String>,
        pub role: String,
        pub model: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub effort: Option<RoleEffort>,
        pub cwd: String,
        pub repo_ids: Vec<String>,
        pub started_at: f64,
        pub status: RunState,
        pub title: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub forked_from: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub tag: Option<String>,
        /// Why a queued run waits, or why it was dropped from the queue.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub note: Option<String>,
    }

    #[derive(Copy, Eq)]
    #[serde(rename_all = "camelCase")]
    pub enum HistorySource {
        /// Started by this IDE (has an event log).
        Ide,
        /// Found in the Claude transcript store only (terminal, other IDE).
        External,
    }

    /// One row of the History view: an IDE run, a transcript started elsewhere, or both merged.
    #[serde(rename_all = "camelCase")]
    pub struct HistoryEntry {
        /// Agent id for an IDE run, `session:<uuid>` for an external session.
        pub id: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub session_id: Option<String>,
        pub source: HistorySource,
        pub title: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub role: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub model: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub cwd: Option<String>,
        pub repo_ids: Vec<String>,
        pub started_at: f64,
        pub last_modified: f64,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub status: Option<RunState>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub tag: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub first_prompt: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub git_branch: Option<String>,
    }

    #[derive(Copy, Eq)]
    #[serde(rename_all = "camelCase")]
    pub enum HistoryScope {
        /// Sessions whose working directory is one of the registered repos.
        Repos,
        /// Every project in the transcript store.
        All,
    }

    #[serde(rename_all = "camelCase")]
    pub struct HistoryQuery {
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub search: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub tag: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub scope: Option<HistoryScope>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub limit: Option<u32>,
    }

    /// Where a resumed or forked session should run when it is not an IDE run (or to override the original).
    #[derive(Default)]
    #[serde(rename_all = "camelCase")]
    pub struct AdoptOptions {
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub role_id: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub repo_ids: Option<Vec<String>>,
        /// Fork only up to this message (`uuid` from the transcript).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub up_to_message_id: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct RunsStartRequest {
        pub role_id: String,
        pub repo_ids: Vec<String>,
        pub prompt: String,
        /// The run mode. The queue, tray quick actions and scripts have no dialog, so only `readOnly`, `ask`, `edit` and `automatic`
        /// are accepted; `bypass` is refused at enqueue (`bypassNotConfirmed`) and `automatic` while the kill switch is on (`modeDisabled`).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub mode: Option<intely_agent_core::providers::PermissionMode>,
    }

    /// Token counts and the cost estimate of a run or of everything.
    #[derive(Default)]
    #[serde(rename_all = "camelCase")]
    pub struct UsageTotals {
        pub input_tokens: f64,
        pub output_tokens: f64,
        pub cache_read: f64,
        pub cache_write: f64,
        pub reasoning_tokens: f64,
        pub cost_usd: f64,
    }

    #[serde(rename_all = "camelCase")]
    pub struct RunUsage {
        pub agent_id: String,
        pub model: String,
        pub totals: UsageTotals,
        /// The run continues a session that was already paid for and the share before it could only be estimated.
        pub baseline_estimated: bool,
        pub updated_at: f64,
    }

    #[serde(rename_all = "camelCase")]
    pub struct UsageSummary {
        pub runs: Vec<RunUsage>,
        pub total: UsageTotals,
    }

    #[serde(rename_all = "camelCase")]
    pub struct RewindSnapshotInfo {
        pub run_id: String,
        pub repo_id: String,
        pub taken_at: f64,
        pub files: f64,
        /// Files the snapshot guard left out (secrets, too large, nested repos).
        pub skipped: f64,
        /// What a restore would do now.
        pub overwrite: Vec<String>,
        pub recreate: Vec<String>,
        pub delete: Vec<String>,
        pub index_differs: bool,
        pub head_changed: bool,
    }
}

impl From<&Role> for RoleDraft {
    fn from(r: &Role) -> Self {
        Self {
            id: Some(r.id.clone()),
            name: r.name.clone(),
            description: r.description.clone(),
            model: r.model.clone(),
            effort: r.effort,
            tools: Some(r.tools.clone()),
            system_prompt: r.system_prompt.clone(),
            color: r.color.clone(),
            memory: r.memory.clone(),
            scope: Some(r.scope),
            repo_id: r.repo_id.clone(),
            permission: Some(r.permission),
            permission_explicit: None,
            provider: Some(r.provider.clone()),
            repo_scope: Some(r.repo_scope.clone()),
            remote_startable: Some(r.remote_startable),
            confirm_write: None,
        }
    }
}

impl RoleDraft {
    /// The same draft with the user's confirmation of the file write (`confirmWrite`).
    pub fn confirmed(mut self) -> Self {
        self.confirm_write = Some(true);
        self
    }
}

#[cfg(feature = "specta")]
pub fn type_collection() -> specta::Types {
    specta::Types::default()
        .register::<Role>()
        .register::<RoleDraft>()
        .register::<RoleGroup>()
        .register::<RolesStatus>()
        .register::<DeletePreview>()
        .register::<DeleteReport>()
        .register::<RoleProviderCaps>()
        .register::<RoleDrift>()
        .register::<RunRecord>()
        .register::<HistoryEntry>()
        .register::<HistoryQuery>()
        .register::<AdoptOptions>()
        .register::<RunsStartRequest>()
        .register::<UsageSummary>()
        .register::<RewindSnapshotInfo>()
}

#[cfg(all(test, feature = "specta"))]
mod tests {
    #[test]
    fn the_type_collection_exports_to_typescript() {
        specta_typescript::Typescript::default().export(&super::type_collection(), specta_serde::Format).expect("export");
    }
}
