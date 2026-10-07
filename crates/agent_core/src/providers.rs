//! Provider registry types: capability matrix, models, definitions, detection (providers-plan 1.3, 1.4).
//! The UI reads capabilities, never provider ids.

use std::collections::BTreeMap;

use crate::policy::enforcement::Tier;

wire_enums! {
    /// What a provider can take as attachments of a user message (CONTRACT-CHANGE alpha attachments).
    pub enum AttachmentsCap {
        None,
        Images,
        ImagesPdf,
        Files,
    }

    /// `yes` shows the control, `partial` shows it with a "may not apply" badge, `no` hides it.
    pub enum Cap {
        Yes,
        Partial,
        No,
    }

    pub enum CapKey {
        Streaming,
        ToolEvents,
        Permissions,
        Resume,
        Fork,
        ModelList,
        Effort,
        Subagents,
        Usage,
        Hooks,
        ModelSwitch,
        Cancel,
        Sandbox,
    }

    pub enum ProviderKind {
        Sdk,
        Acp,
        Cli,
        Api,
    }

    pub enum ProviderHost {
        Sidecar,
        Native,
    }

    pub enum AuthMode {
        Subscription,
        ApiKey,
        Bedrock,
        Vertex,
        Token,
    }

    /// Effective state of a provider (`provider:state`); the enable switch stores intent, this says what runs.
    pub enum ProviderState {
        Off,
        NotInstalled,
        NeedsLogin,
        NeedsKey,
        Probing,
        Ready,
        Throttled,
        Offline,
        Blocked,
        Error,
    }

    pub enum AuthState {
        Unknown,
        Ok,
        NeedsLogin,
        NeedsKey,
    }

    pub enum SettingKind {
        Text,
        Secret,
        Url,
        Toggle,
        Number,
    }

    /// Abstract effort ladder; resolution clamps the role's request to `ModelInfo::effort_levels`.
    pub enum Effort {
        Low,
        Medium,
        High,
        Xhigh,
        Max,
    }
}

wire_types! {
    #[serde(rename_all = "camelCase")]
    pub struct CapEntry {
        pub cap: Cap,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub note: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ProviderCaps {
        pub streaming: CapEntry,
        pub tool_events: CapEntry,
        pub permissions: CapEntry,
        pub resume: CapEntry,
        pub fork: CapEntry,
        pub model_list: CapEntry,
        pub effort: CapEntry,
        /// Levels the active model accepts (empty = n/a); the UI renders its effort control from this, so a
        /// model without effort control is not special-cased anywhere.
        #[serde(default)]
        pub effort_levels: Vec<String>,
        pub subagents: CapEntry,
        pub usage: CapEntry,
        pub hooks: CapEntry,
        pub model_switch: CapEntry,
        pub cancel: CapEntry,
        pub sandbox: CapEntry,
        /// Attachments the provider accepts in a user message; absent = none.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub attachments: Option<AttachmentsCap>,
        /// The provider takes a note for a running agent (`session/note`); absent = no. The UI shows the note input only when `true`.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub notes: Option<bool>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ModelPrice {
        pub input_per_m_tok: f64,
        pub output_per_m_tok: f64,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ModelInfo {
        pub id: String,
        pub label: String,
        /// Empty = the model has no effort control (shown as a muted "n/a").
        #[serde(default)]
        pub effort_levels: Vec<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub context_tokens: Option<u32>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub price: Option<ModelPrice>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub caps: CapDelta,
    }

    #[serde(rename_all = "camelCase")]
    pub struct SettingField {
        pub key: String,
        pub label: String,
        pub kind: SettingKind,
        #[serde(default)]
        pub required: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct DetectSpec {
        pub cli: String,
        #[serde(default)]
        pub version_args: Vec<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub min_version: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ProviderDef {
        pub id: String,
        pub name: String,
        pub icon: String,
        pub kind: ProviderKind,
        pub host: ProviderHost,
        pub auth_modes: Vec<AuthMode>,
        #[serde(default)]
        pub settings_schema: Vec<SettingField>,
        pub default_caps: ProviderCaps,
        /// Starting chip; the real tier is computed from recorded attempt suites.
        pub enforcement: Tier,
        pub rss_budget_mb: u32,
        /// Network allow-list (hosts).
        #[serde(default)]
        pub allow: Vec<String>,
        pub detect: DetectSpec,
    }

    /// Result of `detect()`: installed? version? auth state? Never reads secrets.
    #[serde(rename_all = "camelCase")]
    pub struct Detection {
        pub installed: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub path: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub version: Option<String>,
        /// `None` when no minimum is configured.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub version_ok: Option<bool>,
        pub auth: AuthState,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub message: Option<String>,
    }
}

/// Runtime refinements of a static matrix (ACP `initialize`, `model/list`, `session.started`).
pub type CapDelta = BTreeMap<CapKey, CapEntry>;

impl CapEntry {
    pub fn new(cap: Cap) -> Self {
        Self { cap, note: None }
    }

    pub fn with_note(cap: Cap, note: &str) -> Self {
        Self { cap, note: Some(note.to_string()) }
    }
}

impl Default for ProviderCaps {
    /// Everything `no`: a provider claims nothing until its adapter says so.
    fn default() -> Self {
        let no = || CapEntry::new(Cap::No);
        Self {
            streaming: no(),
            tool_events: no(),
            permissions: no(),
            resume: no(),
            fork: no(),
            model_list: no(),
            effort: no(),
            effort_levels: Vec::new(),
            subagents: no(),
            usage: no(),
            hooks: no(),
            model_switch: no(),
            cancel: no(),
            sandbox: no(),
            attachments: None,
            notes: None,
        }
    }
}

impl ProviderCaps {
    pub fn get(&self, key: CapKey) -> &CapEntry {
        match key {
            CapKey::Streaming => &self.streaming,
            CapKey::ToolEvents => &self.tool_events,
            CapKey::Permissions => &self.permissions,
            CapKey::Resume => &self.resume,
            CapKey::Fork => &self.fork,
            CapKey::ModelList => &self.model_list,
            CapKey::Effort => &self.effort,
            CapKey::Subagents => &self.subagents,
            CapKey::Usage => &self.usage,
            CapKey::Hooks => &self.hooks,
            CapKey::ModelSwitch => &self.model_switch,
            CapKey::Cancel => &self.cancel,
            CapKey::Sandbox => &self.sandbox,
        }
    }

    pub fn set(&mut self, key: CapKey, entry: CapEntry) {
        let slot = match key {
            CapKey::Streaming => &mut self.streaming,
            CapKey::ToolEvents => &mut self.tool_events,
            CapKey::Permissions => &mut self.permissions,
            CapKey::Resume => &mut self.resume,
            CapKey::Fork => &mut self.fork,
            CapKey::ModelList => &mut self.model_list,
            CapKey::Effort => &mut self.effort,
            CapKey::Subagents => &mut self.subagents,
            CapKey::Usage => &mut self.usage,
            CapKey::Hooks => &mut self.hooks,
            CapKey::ModelSwitch => &mut self.model_switch,
            CapKey::Cancel => &mut self.cancel,
            CapKey::Sandbox => &mut self.sandbox,
        };
        *slot = entry;
    }

    /// Runtime truth beats the static table.
    pub fn apply(&mut self, delta: &CapDelta) {
        for (key, entry) in delta {
            self.set(*key, entry.clone());
        }
    }
}

// Written like `wire_enums!` writes an enum except `Deserialize`, which is by hand: it also reads the retired wire name `auto` as
// `automatic`, and the TypeScript exporter refuses `#[serde(alias)]`. Never compare the derived `Ord`; use `strictness()`.
/// The mode a run works in: `readOnly` (Plan), `ask`, `edit` (Accept edits), `automatic` or `bypass`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    ReadOnly,
    Edit,
    Ask,
    /// Works without prompts inside the run's folders. Replaces the retired `auto`, which is still read.
    Automatic,
    /// No prompts, no folder boundary; every hard stop stays. Never a default, never inherited by resume.
    Bypass,
}

impl<'de> serde::Deserialize<'de> for PermissionMode {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let name = <String as serde::Deserialize>::deserialize(d)?;
        match name.as_str() {
            "readOnly" => Ok(PermissionMode::ReadOnly),
            "edit" => Ok(PermissionMode::Edit),
            "ask" => Ok(PermissionMode::Ask),
            "automatic" | "auto" => Ok(PermissionMode::Automatic),
            "bypass" => Ok(PermissionMode::Bypass),
            other => Err(serde::de::Error::unknown_variant(other, &["readOnly", "edit", "ask", "automatic", "bypass"])),
        }
    }
}

impl PermissionMode {
    /// UI order: Plan, Ask, Accept edits, Automatic, Bypass.
    pub const ALL: [PermissionMode; 5] = [Self::ReadOnly, Self::Ask, Self::Edit, Self::Automatic, Self::Bypass];
    /// The working modes an ExitPlanMode approval may continue in: Ask, Edit, Automatic (Bypass is never offered there).
    pub const AFTER_PLAN: [PermissionMode; 3] = [Self::Ask, Self::Edit, Self::Automatic];

    /// 0 readOnly, 1 ask, 2 edit, 3 automatic, 4 bypass. The policy ladder; never compare the derived `Ord`.
    pub fn strictness(self) -> u8 {
        match self {
            PermissionMode::ReadOnly => 0,
            PermissionMode::Ask => 1,
            PermissionMode::Edit => 2,
            PermissionMode::Automatic => 3,
            PermissionMode::Bypass => 4,
        }
    }

    /// Takes the repository writer lease and needs the git shim: Edit, Automatic, Bypass. (Ask stays out, as today.)
    pub fn is_writer(self) -> bool {
        matches!(self, PermissionMode::Edit | PermissionMode::Automatic | PermissionMode::Bypass)
    }

    /// Everything but ReadOnly: the provider write gate, ACP `write_allowed`, the enforcement chip's "write" side.
    pub fn may_write(self) -> bool {
        self != PermissionMode::ReadOnly
    }

    /// Automatic or Bypass: `decide` never returns Ask for it.
    pub fn is_unattended(self) -> bool {
        matches!(self, PermissionMode::Automatic | PermissionMode::Bypass)
    }

    /// Bypass -> Automatic, everything else unchanged (what a resumed run starts in, before the role narrowing of the host).
    pub fn resume_mode(self) -> PermissionMode {
        if self == PermissionMode::Bypass { PermissionMode::Automatic } else { self }
    }
}

/// Modes a NEW run of this provider may start in (before the provider write gate): claude and mock all five, every other provider ReadOnly, Ask, Edit.
pub fn supported_modes(provider: &str) -> &'static [PermissionMode] {
    match provider {
        "claude" | "mock" => &PermissionMode::ALL,
        _ => &[PermissionMode::ReadOnly, PermissionMode::Ask, PermissionMode::Edit],
    }
}

/// Modes a LIVE run of this provider can be switched to: claude and mock all five, every other provider none (no live switch).
pub fn switchable_modes(provider: &str) -> &'static [PermissionMode] {
    match provider {
        "claude" | "mock" => &PermissionMode::ALL,
        _ => &[],
    }
}

impl Effort {
    pub fn parse(level: &str) -> Option<Effort> {
        Some(match level {
            "low" => Effort::Low,
            "medium" => Effort::Medium,
            "high" => Effort::High,
            "xhigh" => Effort::Xhigh,
            "max" => Effort::Max,
            _ => return None,
        })
    }
}

impl ModelInfo {
    /// Clamps a requested effort to what the model offers (nearest lower level, else the lowest);
    /// `None` when the model has no effort control. Levels outside the abstract ladder are ignored.
    pub fn clamp_effort(&self, requested: Effort) -> Option<Effort> {
        let mut levels: Vec<Effort> = self.effort_levels.iter().filter_map(|l| Effort::parse(l)).collect();
        levels.sort();
        let lowest = *levels.first()?;
        Some(levels.into_iter().rev().find(|l| *l <= requested).unwrap_or(lowest))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_default_to_no_and_delta_overrides() {
        let mut caps = ProviderCaps::default();
        assert_eq!(caps.get(CapKey::Hooks).cap, Cap::No);
        assert!(caps.effort_levels.is_empty());
        let mut delta = CapDelta::new();
        delta.insert(CapKey::Hooks, CapEntry::with_note(Cap::Partial, "unverified under --acp"));
        caps.apply(&delta);
        assert_eq!(caps.hooks, CapEntry::with_note(Cap::Partial, "unverified under --acp"));
        assert_eq!(caps.get(CapKey::Streaming).cap, Cap::No);
    }

    #[test]
    fn permission_mode_ladder_and_helpers() {
        let by_strictness: Vec<u8> = PermissionMode::ALL.iter().map(|m| m.strictness()).collect();
        assert_eq!(by_strictness, vec![0, 1, 2, 3, 4], "UI order is the policy ladder");
        assert!(!PermissionMode::Ask.is_writer() && PermissionMode::Edit.is_writer());
        assert!(PermissionMode::Automatic.is_writer() && PermissionMode::Bypass.is_writer());
        assert!(!PermissionMode::ReadOnly.may_write() && PermissionMode::Ask.may_write());
        assert!(PermissionMode::Automatic.is_unattended() && PermissionMode::Bypass.is_unattended());
        assert!(!PermissionMode::Edit.is_unattended());
        assert_eq!(PermissionMode::Bypass.resume_mode(), PermissionMode::Automatic);
        assert_eq!(PermissionMode::Edit.resume_mode(), PermissionMode::Edit);
        assert!(!PermissionMode::AFTER_PLAN.contains(&PermissionMode::Bypass));
    }

    #[test]
    fn permission_mode_wire_names_and_legacy_alias() {
        assert_eq!(serde_json::to_string(&PermissionMode::Automatic).unwrap(), "\"automatic\"");
        assert_eq!(serde_json::to_string(&PermissionMode::Bypass).unwrap(), "\"bypass\"");
        assert_eq!(serde_json::from_str::<PermissionMode>("\"auto\"").unwrap(), PermissionMode::Automatic, "the old wire name is still read");
        assert_eq!(serde_json::from_str::<PermissionMode>("\"readOnly\"").unwrap(), PermissionMode::ReadOnly);
    }

    #[test]
    fn provider_mode_tables() {
        assert_eq!(supported_modes("claude").len(), 5);
        assert_eq!(supported_modes("mock").len(), 5);
        assert_eq!(supported_modes("codex"), &[PermissionMode::ReadOnly, PermissionMode::Ask, PermissionMode::Edit]);
        assert!(switchable_modes("codex").is_empty());
        assert_eq!(switchable_modes("claude").len(), 5);
    }

    #[test]
    fn effort_clamps_to_model_levels() {
        let model = |levels: &[&str]| ModelInfo {
            id: "m".into(),
            label: "m".into(),
            effort_levels: levels.iter().map(|l| l.to_string()).collect(),
            context_tokens: None,
            price: None,
            caps: CapDelta::new(),
        };
        let m = model(&["low", "medium", "high", "turbo"]);
        assert_eq!(m.clamp_effort(Effort::Xhigh), Some(Effort::High));
        assert_eq!(m.clamp_effort(Effort::Medium), Some(Effort::Medium));
        assert_eq!(model(&["high"]).clamp_effort(Effort::Low), Some(Effort::High));
        assert_eq!(model(&["turbo"]).clamp_effort(Effort::Low), None, "unknown levels do not count");
        assert_eq!(model(&[]).clamp_effort(Effort::High), None, "Haiku-style model: effort n/a, derived from the data");
    }
}
