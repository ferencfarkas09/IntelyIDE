//! The wire types of the `mcp_*` commands ((design notes: mcp-management-spec) 3.1, 3.2, 3.3, 4.4), camelCase, exported to
//! `ui/src/bindings/mcp.ts` by `pnpm bindings`. They never carry a secret: a secret slot is only `present: bool`, and a secret value
//! travels one way (`McpVarInput.secretValue`, write-only).

use intely_agent_core::mcp::McpPolicy;
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

api_types! {
    #[serde(rename_all = "lowercase")]
    #[derive(Copy, Eq)]
    pub enum McpTransport {
        Stdio,
        Http,
    }

    /// The per-workspace tri-state (`inherit` removes the entry).
    #[serde(rename_all = "lowercase")]
    #[derive(Copy, Eq)]
    pub enum McpWorkspaceState {
        Inherit,
        On,
        Off,
    }

    /// Why a server cannot be tested or started right now (the first applicable one).
    #[serde(rename_all = "camelCase")]
    #[derive(Copy, Eq)]
    pub enum McpState {
        Ready,
        NeedsConfirm,
        SecretMissing,
        Invalid,
        Unsupported,
    }

    /// What the jail says about starting MCP servers (`readOnly` refuses, `e2e` allows loopback http only).
    #[serde(rename_all = "camelCase")]
    #[derive(Copy, Eq)]
    pub enum McpJail {
        Off,
        ReadOnly,
        E2e,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpVarView {
        pub name: String,
        pub secret: bool,
        /// Plain variables only; a secret value is never sent.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub value: Option<String>,
        /// Secret: an item exists in the Keychain; plain: true.
        pub present: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpToolView {
        pub name: String,
        pub key: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub title: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub description: Option<String>,
        pub read_only: bool,
        pub read_only_hint: Option<bool>,
        pub destructive_hint: Option<bool>,
        /// The user's override.
        pub policy: Option<McpPolicy>,
        pub effective_policy: McpPolicy,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub collision: Option<bool>,
        /// The key or the destructive hint matches the git/deploy write vocabulary (4.4).
        pub blocked_by_default: bool,
        /// The current override is the Test's seed, not the user's choice.
        pub seeded: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpServerInfoView {
        pub name: String,
        pub version: String,
        pub protocol_version: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpStalePolicy {
        pub tool: String,
        pub policy: McpPolicy,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpCodeFile {
        /// Escaped like `commandLine`.
        pub path: String,
        /// The first 12 hex characters of the digest (or `unresolved` / `absent`).
        pub sha256: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpServerView {
        pub id: String,
        pub name: String,
        pub transport: McpTransport,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub command: Option<String>,
        pub args: Vec<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub url: Option<String>,
        pub env: Vec<McpVarView>,
        pub headers: Vec<McpVarView>,
        pub enabled: bool,
        pub default_policy: McpPolicy,
        pub tools: Vec<McpToolView>,
        pub tools_tested_at: Option<f64>,
        pub tools_stale: bool,
        /// Overrides for tools the last Test did not list.
        pub stale_tool_policies: Vec<McpStalePolicy>,
        pub server_info: Option<McpServerInfoView>,
        pub state: McpState,
        /// The Keychain proof equals `confirmHash`.
        pub confirmed: bool,
        /// `origin == "import"`: the confirm dialog adds a warning line about hidden values.
        pub imported: bool,
        /// What the user must send to `mcp_confirm`; the dialog shows exactly what it covers.
        pub confirm_hash: String,
        /// Display form of command + args on ONE line (every non-printable or non-ASCII character escaped); never run through a shell.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub command_line: Option<String>,
        /// The confirm dialog's form: one entry per argument, escaped, never truncated, padding spaces shown as U+2423.
        pub args_display: Vec<String>,
        /// http: the host as stored (ASCII, punycode form).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub url_host: Option<String>,
        /// stdio: the files the confirmation vouches for.
        pub code_files: Vec<McpCodeFile>,
        /// An unpinned package runner: the code is fetched at every start.
        pub fetches_code: bool,
        pub created_at: f64,
        pub updated_at: f64,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpWorkspaceOverride {
        pub server_id: String,
        /// `on` or `off` (`inherit` has no entry).
        pub state: McpWorkspaceState,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpWorkspaceView {
        pub id: Option<String>,
        pub overrides: Vec<McpWorkspaceOverride>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpSecretsView {
        /// `keychain` or `memory`.
        pub backend: String,
        pub degraded: bool,
        pub message: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpProblem {
        pub index: u32,
        pub reason: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpList {
        pub schema: u32,
        pub servers: Vec<McpServerView>,
        pub workspace: McpWorkspaceView,
        pub secrets: McpSecretsView,
        pub jail: McpJail,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub read_only_reason: Option<String>,
        pub problems: Vec<McpProblem>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpVarInput {
        pub name: String,
        pub secret: bool,
        /// Plain variables only.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub value: Option<String>,
        /// WRITE-ONLY. Present = set or replace the Keychain item. Absent on an existing secret slot = keep it.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub secret_value: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpSaveInput {
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub id: Option<String>,
        pub name: String,
        pub transport: McpTransport,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub command: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub args: Option<Vec<String>>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub url: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub env: Option<Vec<McpVarInput>>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub headers: Option<Vec<McpVarInput>>,
        pub enabled: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpToolPatch {
        pub tool: String,
        /// `null` removes the override.
        pub policy: Option<McpPolicy>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub acknowledge_blocked: Option<bool>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpPolicyPatch {
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub default_policy: Option<McpPolicy>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub tools: Option<Vec<McpToolPatch>>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpTestError {
        pub code: String,
        pub message: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub detail: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpTestServerInfo {
        pub name: String,
        pub version: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpTestCapabilities {
        pub tools: bool,
        pub resources: bool,
        pub prompts: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpTestReport {
        pub ok: bool,
        pub ms: f64,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub protocol_version: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub server_info: Option<McpTestServerInfo>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub capabilities: Option<McpTestCapabilities>,
        pub tools: Vec<McpToolView>,
        pub tool_count: u32,
        pub truncated: bool,
        /// Keys, versus the previous successful Test.
        pub new_tools: Vec<String>,
        pub removed_tools: Vec<String>,
        /// Keys this Test seeded with `deny` (4.4).
        pub blocked_by_default: Vec<String>,
        pub fetches_code: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub instructions: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub instructions_changed: Option<bool>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub stderr_tail: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub error: Option<McpTestError>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpImportVar {
        pub name: String,
        pub secret: bool,
    }

    /// A closed set the UI words.
    #[serde(rename_all = "camelCase")]
    #[derive(Copy, Eq)]
    pub enum McpImportIssue {
        UnsupportedTransport,
        BadName,
        NameTaken,
        SecretInArgs,
        SecretInUrl,
        UnresolvedRef,
        BadCommand,
        BadVar,
        BadChars,
        RelativePath,
        TooMany,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpImportEntry {
        /// The original name in the file.
        pub key: String,
        pub suggested_name: String,
        /// `stdio`, `http` or `unknown`.
        pub transport: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub command_line: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub url_host: Option<String>,
        /// NAMES ONLY, never values.
        pub env: Vec<McpImportVar>,
        pub headers: Vec<McpImportVar>,
        pub issues: Vec<McpImportIssue>,
        pub importable: bool,
        pub conflict: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpImportPreview {
        pub import_id: String,
        /// Basename only.
        pub file_name: String,
        pub entries: Vec<McpImportEntry>,
        /// Top-level keys that were not objects.
        pub skipped_keys: u32,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub expires_at: u64,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpImportPick {
        pub key: String,
        pub name: String,
        /// Overwrite the server of the same name.
        pub replace: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpImportedServer {
        pub key: String,
        pub id: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpImportSkipped {
        pub key: String,
        pub reason: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpImportResult {
        pub imported: Vec<McpImportedServer>,
        pub skipped: Vec<McpImportSkipped>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpSecretPresence {
        pub server_id: String,
        /// `env:NAME` or `hdr:Name`.
        pub slot: String,
        pub present: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct McpRunServer {
        pub id: String,
        pub name: String,
        pub transport: McpTransport,
        /// The effective default for the workspace (2.5).
        pub default_on: bool,
        pub available: bool,
        /// `needsConfirm`, `secretMissing`, `invalid`, `unsupportedProvider`, `unsupportedAuth`, `readOnlyJail` or `unsupported`.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub unavailable: Option<String>,
        pub tool_count: u32,
        pub read_only_count: u32,
        pub default_policy: McpPolicy,
        /// The default or any tool is deny.
        pub has_denied: bool,
        /// A stdio server with at least one secret env slot (7.7 warns in Automatic and Bypass, 6.4 point 3).
        pub has_secret_env: bool,
        /// Listed tools that are not read-only and not deny: they run without a prompt in Automatic and Bypass.
        pub exposed_count: u32,
    }
}

#[cfg(feature = "specta")]
pub fn type_collection() -> specta::Types {
    specta::Types::default()
        .register::<McpList>()
        .register::<McpServerView>()
        .register::<McpSaveInput>()
        .register::<McpPolicyPatch>()
        .register::<McpTestReport>()
        .register::<McpImportPreview>()
        .register::<McpImportPick>()
        .register::<McpImportResult>()
        .register::<McpSecretPresence>()
        .register::<McpRunServer>()
        .register::<McpWorkspaceState>()
        .register::<McpPolicy>()
}

#[cfg(all(test, feature = "specta"))]
mod tests {
    #[test]
    fn the_type_collection_exports_to_typescript() {
        specta_typescript::Typescript::default().export(&super::type_collection(), specta_serde::Format).expect("export");
    }
}
