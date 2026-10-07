//! The closed command set. **No write variant exists**: the webview, the AI output and the tests can only express
//! reads, so read-only does not depend on a prompt or a flag. Query bodies are strings (mongosh literal or EJSON),
//! parsed in Rust by [`crate::shell`].

use serde::{Deserialize, Serialize};

pub const DEFAULT_MAX_TIME_MS: u64 = 15_000;
pub const MAX_TIME_CEILING_MS: u64 = 60_000;
pub const MAX_DOCS: usize = 1000;
pub const MAX_BYTES: usize = 16 * 1024 * 1024;
pub const BATCH_SIZE: u32 = 100;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "cmd", rename_all = "camelCase", deny_unknown_fields)]
pub enum ReadCommand {
    ListDatabases,
    #[serde(rename_all = "camelCase")]
    ListCollections { db: String },
    #[serde(rename_all = "camelCase")]
    ListIndexes { db: String, collection: String },
    #[serde(rename_all = "camelCase")]
    Find {
        db: String,
        collection: String,
        #[serde(default)]
        filter: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        projection: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        sort: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional, type = Option<u32>))]
        skip: Option<u64>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional, type = Option<i32>))]
        limit: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    Aggregate { db: String, collection: String, pipeline: String },
    /// Bounded `countDocuments` (limit + maxTimeMS), or `estimatedDocumentCount` when the filter is empty.
    #[serde(rename_all = "camelCase")]
    Count { db: String, collection: String, #[serde(default)] filter: String },
    #[serde(rename_all = "camelCase")]
    Distinct { db: String, collection: String, field: String, #[serde(default)] filter: String },
    /// `$sample` of `size` documents (1 to 1000) for the schema digest; the cheap path only when it is the first stage.
    #[serde(rename_all = "camelCase")]
    Sample { db: String, collection: String, size: u32 },
    /// queryPlanner by default; executionStats is an explicit user action because it executes the query.
    #[serde(rename_all = "camelCase")]
    Explain { inner: Box<ReadCommand>, #[serde(default)] execution_stats: bool },
}

impl ReadCommand {
    /// Short stable name for audit and logs (no literals).
    pub fn kind(&self) -> &'static str {
        match self {
            ReadCommand::ListDatabases => "listDatabases",
            ReadCommand::ListCollections { .. } => "listCollections",
            ReadCommand::ListIndexes { .. } => "listIndexes",
            ReadCommand::Find { .. } => "find",
            ReadCommand::Aggregate { .. } => "aggregate",
            ReadCommand::Count { .. } => "count",
            ReadCommand::Distinct { .. } => "distinct",
            ReadCommand::Sample { .. } => "sample",
            ReadCommand::Explain { .. } => "explain",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum EffectiveLevel {
    Local,
    /// Any non-loopback host (and any +srv host), whatever the user-set tag says.
    ProductionLevel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "role", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RoleChip {
    /// Privileges returned and none of them writes.
    ReadOnly,
    /// Writes possible (privileges list a write action, or the server has no access control at all).
    CanWrite { actions: Vec<String>, no_auth: bool },
    /// Privileges could not be read (restricted user, Atlas-like): treat as one level riskier.
    Unknown { reason: String },
}

pub const WRITE_ACTIONS: &[&str] = &[
    "insert", "update", "remove", "bypassDocumentValidation", "createCollection", "dropCollection", "dropDatabase", "dropIndex", "createIndex", "renameCollectionSameDB",
    "createUser", "dropUser", "grantRole", "revokeRole", "createRole", "dropRole", "convertToCapped", "collMod", "shutdown", "killop", "setParameter", "applyOps", "replSetConfigure",
];

/// Classify a `connectionStatus {showPrivileges: true}` reply (as JSON) into the connection chip.
pub fn classify_connection_status(reply: &serde_json::Value) -> RoleChip {
    let auth = &reply["authInfo"];
    let users = auth["authenticatedUsers"].as_array().map_or(0, Vec::len);
    if users == 0 {
        return RoleChip::CanWrite { actions: vec!["no access control: every action is allowed".into()], no_auth: true };
    }
    let Some(privs) = auth["authenticatedUserPrivileges"].as_array() else {
        return RoleChip::Unknown { reason: "the server did not return privileges".into() };
    };
    if privs.is_empty() {
        return RoleChip::Unknown { reason: "the user has no listed privileges (restricted or managed user)".into() };
    }
    let mut writes: Vec<String> = Vec::new();
    for p in privs {
        for a in p["actions"].as_array().into_iter().flatten().filter_map(|a| a.as_str()) {
            if WRITE_ACTIONS.contains(&a) && !writes.iter().any(|w| w == a) {
                writes.push(a.to_string());
            }
        }
    }
    if writes.is_empty() {
        RoleChip::ReadOnly
    } else {
        writes.truncate(8);
        RoleChip::CanWrite { actions: writes, no_auth: false }
    }
}
