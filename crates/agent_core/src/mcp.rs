//! The MCP types every crate compiles against ((design notes: mcp-management-spec) 5.1): what a user decided for a tool, the per-server
//! rules the broker judges calls with, and the supplier interface the host consumes. Declarations with trivial bodies: the
//! `intely-mcp` crate (the supplier itself) and the policy table (`policy::decide`) build on top of them.
//!
//! Secrets: `McpWire` and `McpSecrets` print `[redacted]` under `{:?}` and neither is `Display`; `McpResolved` has no `Serialize`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// What the user decided for a tool (or a server's default). `ask` is the default of a new server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum McpPolicy {
    #[default]
    Ask,
    Allow,
    Deny,
}

impl McpPolicy {
    /// Allow < Ask < Deny. Used by the live tighten-only merge (`McpServerRules::tighten`) and for colliding tool keys.
    pub fn stricter(self, other: McpPolicy) -> McpPolicy {
        fn rank(p: McpPolicy) -> u8 {
            match p {
                McpPolicy::Allow => 0,
                McpPolicy::Ask => 1,
                McpPolicy::Deny => 2,
            }
        }
        if rank(other) > rank(self) {
            other
        } else {
            self
        }
    }
}

/// One tool the last Test learned (keyed by its fitted key) and/or the user gave an override.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolRule {
    /// The user's override; `None` = the server's default applies.
    #[serde(default)]
    pub policy: Option<McpPolicy>,
    /// The server annotated this tool `readOnlyHint: true` in a Test whose fingerprint still matches. Never true for a stale list.
    #[serde(default)]
    pub read_only: bool,
    /// The last successful Test listed this tool (as opposed to an override the user kept for a name the Test did not list).
    #[serde(default)]
    pub learned: bool,
}

/// Everything the broker needs to judge the calls of one server. Keyed by server NAME in `PolicyContext.mcp_tools`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRules {
    #[serde(default)]
    pub default_policy: McpPolicy,
    /// Keyed by `fit(server, key)`.
    #[serde(default)]
    pub tools: BTreeMap<String, McpToolRule>,
    /// A Test succeeded and its fingerprint still matches the record. Only then is a learned tool "listed".
    #[serde(default)]
    pub fresh: bool,
}

/// The CLI's own resource tools join the MCP class under this fixed pseudo-tool key.
pub const RESOURCES_TOOL: &str = "resources";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct McpToolVerdict {
    pub policy: McpPolicy,
    pub read_only: bool,
    pub listed: bool,
}

impl McpServerRules {
    /// For one CLI-visible tool name (the part after `mcp__<server>__`). An unknown tool: the server default, not read-only, not listed.
    /// The pseudo-tool `resources` is always listed and never read-only. A learned tool counts as read-only or listed only while
    /// the record is `fresh` (fail closed on a stale list).
    pub fn effective(&self, tool: &str) -> McpToolVerdict {
        let rule = self.tools.get(tool);
        let policy = rule.and_then(|r| r.policy).unwrap_or(self.default_policy);
        if tool == RESOURCES_TOOL {
            return McpToolVerdict { policy, read_only: false, listed: true };
        }
        match rule {
            Some(r) => McpToolVerdict { policy, read_only: r.read_only && r.learned && self.fresh, listed: r.learned && self.fresh },
            None => McpToolVerdict { policy, read_only: false, listed: false },
        }
    }

    /// The live merge of the host's tighten-only update. NEVER loosens: for every tool, `policy = Some(stricter(old effective, new
    /// effective))`; `read_only` and `fresh` only go from true to false; a tool present in `self` and absent in `newer` keeps its
    /// rule (its policy is tightened by the newer default); `default_policy = stricter(old, new)`. A tool only `newer` knows enters unlisted and not read-only.
    pub fn tighten(&mut self, newer: &McpServerRules) {
        let old_default = self.default_policy;
        for (key, new_rule) in &newer.tools {
            let new_eff = new_rule.policy.unwrap_or(newer.default_policy);
            match self.tools.get_mut(key) {
                Some(old) => {
                    let old_eff = old.policy.unwrap_or(old_default);
                    old.policy = Some(old_eff.stricter(new_eff));
                    old.read_only = old.read_only && new_rule.read_only;
                }
                None => {
                    self.tools.insert(key.clone(), McpToolRule { policy: Some(old_default.stricter(new_eff)), read_only: false, learned: false });
                }
            }
        }
        // a tool the newer rules do not know follows the newer DEFAULT: it keeps its entry but never ends up weaker than that default
        for old in self.tools.iter_mut().filter(|(k, _)| !newer.tools.contains_key(*k)).map(|(_, v)| v) {
            old.policy = Some(old.policy.unwrap_or(old_default).stricter(newer.default_policy));
        }
        self.default_policy = old_default.stricter(newer.default_policy);
        self.fresh = self.fresh && newer.fresh;
    }

    /// How many tools of this server run without a prompt in Automatic or Bypass: learned, not read-only, effective policy not Deny
    /// (an unlisted tool the server adds later cannot be counted).
    pub fn exposed(&self) -> u32 {
        self.tools.values().filter(|r| r.learned && !r.read_only && r.policy.unwrap_or(self.default_policy) != McpPolicy::Deny).count() as u32
    }
}

/// The CLI exposes tools as `mcp__<server>__<tool>`; the model API limits that name to 64 characters.
const MAX_EXPOSED_NAME: usize = 64;

/// `[^A-Za-z0-9_-]` -> `_`; NOT shortened (the stored key does not depend on the server name).
pub fn normalize_tool_name(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
}

/// The key cut to `max(1, 64 - 5 - server.len() - 2)` chars: what fits in the model API's 64-char limit for `mcp__<server>__<tool>`.
pub fn fit(server: &str, key: &str) -> String {
    let room = MAX_EXPOSED_NAME.saturating_sub("mcp__".len() + server.len() + "__".len()).max(1);
    key.chars().take(room).collect()
}

/// What a run asks for. `ids` are server ids (stable). `strict` = a new run (an unavailable server is an error);
/// `false` = a resume (an unavailable server is skipped and reported in `skipped`).
#[derive(Debug, Clone, Default)]
pub struct McpSelection {
    pub ids: Vec<String>,
    pub strict: bool,
    /// The run's directories (`PolicyContext.cwd` and `add_dirs`). The CLI starts stdio servers with this working directory, so the
    /// supplier refuses code that lies inside it (`mcpCodeInRunDir`).
    pub run_dirs: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpSkipped {
    pub id: String,
    pub name: String,
    /// A code of the MCP spec's error list.
    pub reason: String,
}

/// A supplier failure that the host turns into `EngineError { code, message }`.
/// `message` carries no secret and no server detail beyond the server NAME.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpError {
    pub code: String,
    pub message: String,
}

/// A JSON value that holds resolved secrets (the `mcp` field of `session/start`). It serialises transparently, so it travels on the
/// sidecar pipe like any value, but its `Debug` prints `McpWire([redacted])` and it has no `Display`: a `{:?}`, a panic message or a
/// failed `assert_eq!` of any struct that contains it can never print a secret.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct McpWire(serde_json::Value);

impl McpWire {
    pub fn new(v: serde_json::Value) -> Self {
        Self(v)
    }

    /// Null or an empty object.
    pub fn is_empty(&self) -> bool {
        match &self.0 {
            serde_json::Value::Null => true,
            serde_json::Value::Object(o) => o.is_empty(),
            _ => false,
        }
    }
}

impl std::fmt::Debug for McpWire {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("McpWire([redacted])")
    }
}

/// The resolved selection. `servers` CONTAINS SECRET VALUES (env, headers): the only way out is moving it into `SessionStart.mcp`.
pub struct McpResolved {
    /// SDK `mcpServers`: name -> `{ type: "stdio", command, args, env }` or `{ type: "http", url, headers }`.
    pub servers: McpWire,
    /// The server names in `servers` (the set the isolation guard and `PolicyContext.mcp_servers` use).
    pub names: Vec<String>,
    /// Server NAME -> stable server id, so a live update finds the record even after a rename.
    pub ids: BTreeMap<String, String>,
    /// Per-server rules for the broker, keyed by server name.
    pub rules: BTreeMap<String, McpServerRules>,
    /// Canonical paths of the code files of every resolved stdio server: the host puts them into `PolicyContext.mcp_code_paths`.
    pub code_paths: Vec<PathBuf>,
    pub skipped: Vec<McpSkipped>,
}

impl std::fmt::Debug for McpResolved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpResolved").field("servers", &self.servers).field("names", &self.names).field("ids", &self.ids).field("skipped", &self.skipped).finish()
    }
}

pub type McpSupplier = Arc<dyn Fn(&McpSelection) -> Result<McpResolved, McpError> + Send + Sync>;

/// What the Settings say NOW about the servers of live runs (no secrets, no config): the input of the tighten-only live update.
/// The query is `(server id, the name the run knows it by)`; `rules == None` = the server was removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpRuleUpdate {
    pub id: String,
    pub rules: Option<McpServerRules>,
}

pub type McpRulesSupplier = Arc<dyn Fn(&[(String, String)]) -> Vec<McpRuleUpdate> + Send + Sync>;

/// How many tools of one server of a live run run without a prompt in Automatic or Bypass (`McpServerRules::exposed`). Plain serde,
/// exported to TypeScript; it feeds `AgentSummary.mcp` and the consent lines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct McpExposure {
    pub name: String,
    pub exposed: u32,
    pub has_secret_env: bool,
}

/// Secret values of the given servers, for scrubbing a transcript the CLI wrote. No `Serialize`, no `Display`, `Debug` prints `[redacted]`.
pub struct McpSecrets(Vec<String>);

impl McpSecrets {
    pub fn new(values: Vec<String>) -> Self {
        Self(values)
    }

    pub fn values(&self) -> &[String] {
        &self.0
    }
}

impl std::fmt::Debug for McpSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[redacted]")
    }
}

/// Reads the Keychain items of the given server ids (one `get` each). Errors carry codes of the MCP spec and no secret.
pub type McpScrubSupplier = Arc<dyn Fn(&[String]) -> Result<McpSecrets, McpError> + Send + Sync>;

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(policy: Option<McpPolicy>, read_only: bool, learned: bool) -> McpToolRule {
        McpToolRule { policy, read_only, learned }
    }

    #[test]
    fn policy_order_is_allow_ask_deny() {
        assert_eq!(McpPolicy::Allow.stricter(McpPolicy::Ask), McpPolicy::Ask);
        assert_eq!(McpPolicy::Deny.stricter(McpPolicy::Allow), McpPolicy::Deny);
        assert_eq!(McpPolicy::default(), McpPolicy::Ask);
        assert_eq!(serde_json::to_string(&McpPolicy::Deny).unwrap(), "\"deny\"");
    }

    #[test]
    fn effective_fails_closed_for_unknown_and_stale_tools() {
        let mut r = McpServerRules { default_policy: McpPolicy::Ask, tools: BTreeMap::new(), fresh: true };
        r.tools.insert("read_file".into(), rule(None, true, true));
        r.tools.insert("delete".into(), rule(Some(McpPolicy::Deny), false, true));
        assert_eq!(r.effective("read_file"), McpToolVerdict { policy: McpPolicy::Ask, read_only: true, listed: true });
        assert_eq!(r.effective("delete").policy, McpPolicy::Deny);
        assert_eq!(r.effective("other"), McpToolVerdict { policy: McpPolicy::Ask, read_only: false, listed: false });
        assert!(r.effective(RESOURCES_TOOL).listed && !r.effective(RESOURCES_TOOL).read_only);
        r.fresh = false;
        assert_eq!(r.effective("read_file"), McpToolVerdict { policy: McpPolicy::Ask, read_only: false, listed: false }, "a stale list never counts");
    }

    #[test]
    fn tighten_never_loosens() {
        let mut live = McpServerRules { default_policy: McpPolicy::Ask, tools: BTreeMap::new(), fresh: true };
        live.tools.insert("a".into(), rule(Some(McpPolicy::Deny), false, true));
        live.tools.insert("b".into(), rule(None, true, true));
        let mut newer = McpServerRules { default_policy: McpPolicy::Allow, tools: BTreeMap::new(), fresh: true };
        newer.tools.insert("a".into(), rule(Some(McpPolicy::Allow), true, true));
        newer.tools.insert("b".into(), rule(Some(McpPolicy::Deny), true, true));
        newer.tools.insert("c".into(), rule(Some(McpPolicy::Allow), true, true));
        live.tighten(&newer);
        assert_eq!(live.tools["a"].policy, Some(McpPolicy::Deny));
        assert_eq!(live.tools["b"].policy, Some(McpPolicy::Deny));
        assert!(!live.tools["c"].read_only && !live.tools["c"].learned, "a tool only the newer record knows enters unlisted");
        assert_eq!(live.default_policy, McpPolicy::Ask);
        let mut stale = newer.clone();
        stale.fresh = false;
        live.tighten(&stale);
        assert!(!live.fresh);
    }

    #[test]
    fn a_tool_only_the_old_rules_know_follows_the_newer_default() {
        let mut live = McpServerRules { default_policy: McpPolicy::Allow, tools: BTreeMap::new(), fresh: true };
        live.tools.insert("renamed_away".into(), rule(Some(McpPolicy::Allow), false, true));
        live.tools.insert("plain".into(), rule(None, false, true));
        let newer = McpServerRules { default_policy: McpPolicy::Deny, tools: BTreeMap::new(), fresh: true };
        live.tighten(&newer);
        assert_eq!(live.effective("renamed_away").policy, McpPolicy::Deny, "an explicit Allow does not outlive a Deny default for a tool the Settings no longer list");
        assert_eq!(live.effective("plain").policy, McpPolicy::Deny);
        assert!(live.tools.contains_key("renamed_away"), "the entry itself is kept");
    }

    #[test]
    fn names_fit_the_model_limit() {
        assert_eq!(normalize_tool_name("list repos.v2"), "list_repos_v2");
        assert_eq!(fit("fs", "a").len(), 1);
        let long = "x".repeat(100);
        assert_eq!(fit("fs", &long).len(), 64 - 5 - 2 - 2);
        assert_eq!(fit(&"s".repeat(32), &long).len(), 64 - 5 - 32 - 2);
    }

    #[test]
    fn exposure_counts_writing_tools_that_are_not_denied() {
        let mut r = McpServerRules::default();
        r.tools.insert("read".into(), rule(None, true, true));
        r.tools.insert("write".into(), rule(None, false, true));
        r.tools.insert("drop".into(), rule(Some(McpPolicy::Deny), false, true));
        r.tools.insert("kept-override".into(), rule(Some(McpPolicy::Allow), false, false));
        assert_eq!(r.exposed(), 1);
    }

    #[test]
    fn secrets_never_print() {
        let wire = McpWire::new(serde_json::json!({ "fs": { "env": { "TOKEN": "s3cret-value" } } }));
        assert!(!format!("{wire:?}").contains("s3cret-value"));
        assert!(!wire.is_empty() && McpWire::new(serde_json::json!({})).is_empty());
        let resolved = McpResolved { servers: wire, names: vec!["fs".into()], ids: BTreeMap::new(), rules: BTreeMap::new(), code_paths: Vec::new(), skipped: Vec::new() };
        assert!(!format!("{resolved:?}").contains("s3cret-value"));
        assert!(!format!("{:?}", McpSecrets::new(vec!["s3cret-value".into()])).contains("s3cret-value"));
    }
}
