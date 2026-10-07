//! Serde types of the `ipc.run` namespace (camelCase, like `intely-core`). Script bodies are never part of these types:
//! a body only leaves the backend through `catalog::display_command`, masked, when the user asks to see it.

use serde::{Deserialize, Serialize};

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
    #[serde(rename_all = "camelCase")]
    pub enum ScriptGroup {
        Start,
        Dev,
        Test,
        Lint,
        Build,
        Other,
    }

    /// `Confirm`: shown, but starting it needs a click on "Run anyway" (deploy, build, publish, docker, process managers,
    /// data migrations, remote commands). Nothing ever starts by itself.
    #[serde(rename_all = "camelCase")]
    pub enum Safety {
        Normal,
        Confirm,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ScriptInfo {
        /// `<source>:<name>`, e.g. `npm:dev`, `cargo:check`.
        pub id: String,
        pub name: String,
        /// `npm` (package.json) or `cargo`.
        pub source: String,
        pub group: ScriptGroup,
        pub safety: Safety,
        /// Why a script needs a confirmation.
        pub reasons: Vec<String>,
        /// True for every script that deploys, builds, publishes or starts a process manager: an agent must never run it.
        pub forbidden_to_agents: bool,
        /// Node heap limit (MB) when it is 4000 or more: the "only one heavy server at a time" warning keys on it.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub heavy_mb: Option<u32>,
        /// Names only, never values.
        pub env_names: Vec<String>,
        /// Port the repo's own config names for this server (e.g. Tauri `devUrl`), shown before it is detected.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub port_hint: Option<u16>,
        /// What is executed, e.g. `npm run dev`. Safe to show: it holds the script name, not the body.
        pub runner: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct Catalog {
        pub repo_id: String,
        /// `npm`, `pnpm`, `yarn` or `bun`.
        pub package_manager: String,
        pub scripts: Vec<ScriptInfo>,
        pub notes: Vec<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub enum ServerStatus {
        /// Spawned, no port seen yet.
        Starting,
        Running,
        Stopping,
        Exited,
        /// Could not be spawned.
        Failed,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ServerInfo {
        /// `<repoId>:<script id>`; one instance per script, the log survives a restart.
        pub id: String,
        pub repo_id: String,
        pub script: String,
        pub runner: String,
        pub status: ServerStatus,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub pid: Option<i32>,
        /// Unix seconds.
        pub started_at: u32,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub exit_code: Option<i32>,
        /// Listening loopback ports (from `lsof` once known, else from the output).
        pub ports: Vec<u16>,
        /// `http://localhost:<port>` of the first port, loopback only.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub url: Option<String>,
        /// Resident size of the whole process tree.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub rss_mb: Option<u32>,
        pub procs: u32,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub heavy_mb: Option<u32>,
    }

    /// Masked, ANSI kept. `reset` is true after a clear: drop what you have, these lines are all there is.
    #[serde(rename_all = "camelCase")]
    pub struct LogChunk {
        pub server_id: String,
        pub start_seq: u32,
        pub lines: Vec<String>,
        pub reset: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct StartRequest {
        pub repo_id: String,
        /// A `ScriptInfo.id`.
        pub script: String,
        /// The user clicked "Run anyway" on a `Safety::Confirm` script.
        #[serde(default)]
        pub confirmed: bool,
        /// The user accepted the heavy-server warning.
        #[serde(default)]
        pub allow_second_heavy: bool,
    }

    /// What the jail says about starting processes right now.
    #[serde(rename_all = "camelCase")]
    pub struct ProcessAccess {
        /// The session switch in Settings > Safety (never persisted).
        pub allowed: bool,
        /// `off`, `readOnly` or `e2e`.
        pub jail: String,
        pub startable: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub reason: Option<String>,
    }
}

#[cfg(feature = "specta")]
pub fn type_collection() -> specta::Types {
    specta::Types::default()
        .register::<ScriptGroup>()
        .register::<Safety>()
        .register::<ScriptInfo>()
        .register::<Catalog>()
        .register::<ServerStatus>()
        .register::<ServerInfo>()
        .register::<LogChunk>()
        .register::<StartRequest>()
        .register::<ProcessAccess>()
}

#[cfg(all(test, feature = "specta"))]
mod tests {
    #[test]
    fn the_type_collection_exports_to_typescript() {
        specta_typescript::Typescript::default().export(&super::type_collection(), specta_serde::Format).expect("export");
    }
}
