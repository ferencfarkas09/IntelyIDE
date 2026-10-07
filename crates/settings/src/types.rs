//! Serde types of the `ipc.providers` namespace (camelCase, like `intely-core`). `ipc.settings` and `ipc.secrets` move
//! plain JSON objects and booleans, so they need no generated types.

use serde::{Deserialize, Serialize};

macro_rules! api_types {
    ($($item:item)*) => {
        $(
            #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
            #[cfg_attr(feature = "specta", derive(specta::Type))]
            $item
        )*
    };
}

api_types! {
    #[serde(rename_all = "camelCase")]
    pub enum ProviderKind {
        Sdk,
        Acp,
        Cli,
        Api,
    }

    #[serde(rename_all = "camelCase")]
    pub enum ProviderHost {
        Sidecar,
        Native,
    }

    /// `off -> notInstalled | needsLogin | needsKey -> probing -> ready <-> throttled | offline`, side exits `blocked`
    /// and `error` ((design notes: providers-plan) 1.3). The switch stores intent, the state says what actually runs.
    #[serde(rename_all = "camelCase")]
    pub enum ProviderState {
        Off,
        NotInstalled,
        NeedsLogin,
        NeedsKey,
        Probing,
        /// An experimental provider that is installed but has no confirmed command line yet (or a changed one).
        NeedsConfirm,
        Ready,
        Throttled,
        Offline,
        Blocked,
        Error,
    }

    #[serde(rename_all = "camelCase")]
    pub struct AuthModeInfo {
        pub id: String,
        pub label: String,
        /// The mode needs an API key or token in the Keychain (`ipc.secrets`, key `providers.<id>:default`).
        pub needs_key: bool,
    }

    /// What `command -v <bin>` plus `<bin> --version` found, using the login-shell PATH.
    #[serde(rename_all = "camelCase")]
    pub struct CliDetection {
        pub bin: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub path: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub version: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub min_version: Option<String>,
        /// `None` when there is no minimum or the version could not be read.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub meets_min: Option<bool>,
        /// The binary exists but `--version` failed or timed out.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub error: Option<String>,
    }

    /// Whether the command line the IDE would start was confirmed by the user: `unconfirmed` (never), `confirmed`, or
    /// `stale` (the stored line no longer matches its hash, or the program is gone: it asks again).
    #[serde(rename_all = "camelCase")]
    pub enum LaunchStatus {
        Unconfirmed,
        Confirmed,
        Stale,
    }

    /// The command line an experimental provider runs, shown in full for the one-time confirmation.
    #[serde(rename_all = "camelCase")]
    pub struct LaunchInfo {
        /// Absolute path of the program when found (or confirmed), else the bare name; empty for a custom ACP agent.
        pub command: String,
        pub args: Vec<String>,
        /// `command` is an absolute path to an executable file.
        pub resolved: bool,
        /// The user types the command line (generic ACP agent); otherwise it is the IDE's proposal and only the program path can differ.
        pub editable: bool,
        /// The flags were confirmed against a real agent. False for every proposal today: nothing but Claude and Codex's
        /// app-server was ever run against the real program.
        pub verified: bool,
        pub status: LaunchStatus,
        /// Epoch seconds.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub confirmed_at: Option<u32>,
        /// SHA-256 over the confirmed program and arguments (first 16 hex digits shown for support).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub hash: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ProviderInfo {
        pub id: String,
        pub name: String,
        pub kind: ProviderKind,
        pub host: ProviderHost,
        pub enabled: bool,
        pub state: ProviderState,
        /// A key is stored (key modes) or the CLI is installed (login modes).
        pub configured: bool,
        pub auth_modes: Vec<AuthModeInfo>,
        pub auth_mode: String,
        /// Not Claude: switched on only together with `Experimental providers`, confirmed command line required.
        pub experimental: bool,
        pub has_key: bool,
        /// `None` until a detection ran (detection happens when Settings > Providers opens, never at startup).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub cli: Option<CliDetection>,
        /// The command line for an experimental provider (absent for Claude).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub launch: Option<LaunchInfo>,
        /// Settings > Safety: this provider may run roles that change files although its enforcement is below the write tier.
        pub allow_weak_writer: bool,
        /// Why the state is what it is, when that is not obvious.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub message: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ProviderTest {
        pub ok: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub message: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub latency_ms: Option<u32>,
    }

    /// Event `providers:state`.
    #[serde(rename_all = "camelCase")]
    pub struct ProviderStateChange {
        pub id: String,
        pub state: ProviderState,
    }

    #[serde(rename_all = "camelCase")]
    pub enum DoctorLevel {
        Ok,
        Info,
        Warn,
        Error,
    }

    #[serde(rename_all = "camelCase")]
    pub struct DoctorFinding {
        /// `None` for findings about the environment as a whole.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub provider: Option<String>,
        pub level: DoctorLevel,
        pub code: String,
        pub message: String,
    }
}

#[cfg(feature = "specta")]
pub fn type_collection() -> specta::Types {
    specta::Types::default()
        .register::<ProviderInfo>()
        .register::<LaunchInfo>()
        .register::<ProviderTest>()
        .register::<ProviderStateChange>()
        .register::<DoctorFinding>()
}

#[cfg(all(test, feature = "specta"))]
mod tests {
    #[test]
    fn the_type_collection_exports_to_typescript() {
        specta_typescript::Typescript::default().export(&super::type_collection(), specta_serde::Format).expect("export");
    }
}
