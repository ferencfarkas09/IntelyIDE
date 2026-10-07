//! Delegation types ((design notes: roles-orchestration-spec) 3.5, 4.1): the roles an Auto lead may hand work to, as the
//! Roles layer builds them, the host forwards them in `session/start` and the sidecar passes them to the Claude
//! SDK `agents` option. They live here because `intely-roles` (builds the set) and `intely-agent-host` (consumes it)
//! both depend on this crate.

use std::path::PathBuf;
use std::sync::Arc;

use crate::providers::{Effort, PermissionMode};

wire_enums! {
    /// Where the winning copy of a delegate comes from.
    pub enum DelegateScope {
        Global,
        Repo,
        Builtin,
    }

    /// Why a role is not part of the delegate set (shown in New run and in the Roles table; the UI maps the code to words).
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
}

wire_types! {
    /// One role as the sidecar passes it to the SDK `agents` option (`session/start.delegates`). Rust resolved
    /// everything: aliases are model ids, the effort is clamped, MCP tools are stripped.
    #[serde(rename_all = "camelCase")]
    pub struct DelegateSpec {
        pub name: String,
        pub description: String,
        pub prompt: String,
        /// Resolved model id.
        pub model: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub effort: Option<Effort>,
        /// For the sidecar's labels and the init assertion; NOT passed to the SDK (the broker enforces it).
        pub permission: PermissionMode,
        /// Allow-list; empty = inherit the lead's tools minus `disallowed_tools`.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub tools: Vec<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub disallowed_tools: Vec<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub max_turns: Option<u32>,
        pub scope: DelegateScope,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub color: Option<String>,
    }

    /// [`DelegateSpec`] without the prompt: what `session.info`, the run summary and the Inspector carry (the event log
    /// must not hold N prompts).
    #[serde(rename_all = "camelCase")]
    pub struct DelegateInfo {
        pub name: String,
        pub description: String,
        pub model: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub effort: Option<Effort>,
        pub permission: PermissionMode,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub tools: Vec<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub disallowed_tools: Vec<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub max_turns: Option<u32>,
        pub scope: DelegateScope,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub color: Option<String>,
    }

    /// A role that is not a delegate, and why.
    #[serde(rename_all = "camelCase")]
    pub struct ExcludedDelegate {
        pub name: String,
        pub reason: ExcludeReason,
    }
}

impl DelegateSpec {
    pub fn info(&self) -> DelegateInfo {
        DelegateInfo {
            name: self.name.clone(),
            description: self.description.clone(),
            model: self.model.clone(),
            effort: self.effort,
            permission: self.permission,
            tools: self.tools.clone(),
            disallowed_tools: self.disallowed_tools.clone(),
            max_turns: self.max_turns,
            scope: self.scope,
            color: self.color.clone(),
        }
    }
}

/// A delegate with the provenance the Inspector shows (a file path, or the built-in's name). Never on the wire.
#[derive(Debug, Clone, PartialEq)]
pub struct DelegateDef {
    pub spec: DelegateSpec,
    /// Path of the winning file, or `builtin:<name>`.
    pub source: String,
    /// The role comes from a repository file whose permission the user never set explicitly (`derive_permission`: `repo_copy` without an
    /// overlay): its permission is a ceiling, never lifted in an unattended run (permission-modes spec 3, GZ-24). Not on the wire.
    pub capped: bool,
}

impl DelegateDef {
    pub fn name(&self) -> &str {
        &self.spec.name
    }
}

/// What the Roles layer hands the host for one run.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DelegateSet {
    pub included: Vec<DelegateDef>,
    pub excluded: Vec<ExcludedDelegate>,
}

impl DelegateSet {
    pub fn is_empty(&self) -> bool {
        self.included.is_empty()
    }

    pub fn specs(&self) -> Vec<DelegateSpec> {
        self.included.iter().map(|d| d.spec.clone()).collect()
    }

    pub fn infos(&self) -> Vec<DelegateInfo> {
        self.included.iter().map(|d| d.spec.info()).collect()
    }
}

/// A repository of a run, as the resolver sees it (`intely-agent-host`'s `RepoRef` has the same two fields).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegateRepo {
    pub id: String,
    pub path: PathBuf,
}

/// Builds the delegate set of a run on `repos` from the CURRENT role files and overlay: global copies plus the copies of
/// these repositories only (3.2a point 4). Set by the Tauri layer next to the role resolver.
pub type DelegateResolver = Arc<dyn Fn(&[DelegateRepo]) -> DelegateSet + Send + Sync>;

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str) -> DelegateSpec {
        DelegateSpec {
            name: name.into(),
            description: "d".into(),
            prompt: "p".into(),
            model: "claude-haiku-4-5-20251001".into(),
            effort: None,
            permission: PermissionMode::ReadOnly,
            tools: vec!["Read".into()],
            disallowed_tools: vec!["Agent".into()],
            max_turns: Some(25),
            scope: DelegateScope::Global,
            color: None,
        }
    }

    #[test]
    fn info_drops_the_prompt_and_keeps_the_rest() {
        let info = spec("researcher").info();
        let json = serde_json::to_value(&info).unwrap();
        assert!(json.get("prompt").is_none());
        assert_eq!(json["name"], "researcher");
        assert_eq!(json["permission"], "readOnly");
        assert_eq!(json["disallowedTools"][0], "Agent");
    }

    #[test]
    fn a_set_reports_specs_and_infos_in_order() {
        let set = DelegateSet {
            included: vec![DelegateDef { spec: spec("a"), source: "builtin:a".into(), capped: false }, DelegateDef { spec: spec("b"), source: "/x/b.md".into(), capped: false }],
            excluded: vec![ExcludedDelegate { name: "c".into(), reason: ExcludeReason::Untrusted }],
        };
        assert_eq!(set.specs().iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(set.infos().len(), 2);
        assert!(!set.is_empty() && DelegateSet::default().is_empty());
    }
}
