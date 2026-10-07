//! Stored shape of `workspaces.json`, naming rules, ids and colours ((design notes: workspaces-spec) 4.3, 4.12).

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::types::code;
use crate::{EngineError, WorkspaceEntry, WorkspaceOrigin};

pub const MAX_WORKSPACES: usize = 200;
pub const MAX_REPOS: usize = 100;
pub const MAX_NAME_CHARS: usize = 60;
/// Colours handed out in turn to new workspaces and new repositories. The first one is the migrated workspace's.
pub const PALETTE: [&str; 8] = ["#8b6cf0", "#3b9ae8", "#4caf7d", "#f0a23a", "#e5534b", "#d96ba0", "#2fb5a8", "#8a8f98"];
/// Branches that are protected in every workspace (the global floor of 4.12).
pub const FLOOR_PROTECTED: [&str; 4] = ["main", "master", "production", "release/*"];
/// Fixed id of the workspace created from the legacy `workspace.json`.
pub const MIGRATED_ID: &str = "w-migrated";
pub const MIGRATED_NAME: &str = "Happy workspace";

/// One line of the registry plus fields a newer minor version may have added (kept on rewrite).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredEntry {
    #[serde(flatten)]
    pub entry: WorkspaceEntry,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigratedInfo {
    pub from: String,
    pub sha256: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryFile {
    pub version: u32,
    #[serde(default)]
    pub rev: u64,
    #[serde(default)]
    pub active_id: Option<String>,
    #[serde(default)]
    pub workspaces: Vec<StoredEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migrated: Option<MigratedInfo>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl RegistryFile {
    pub fn empty() -> Self {
        Self { version: 1, rev: 0, active_id: None, workspaces: Vec::new(), migrated: None, extra: BTreeMap::new() }
    }

    pub fn find(&self, id: &str) -> Option<&StoredEntry> {
        self.workspaces.iter().find(|w| w.entry.id == id)
    }

    pub fn find_mut(&mut self, id: &str) -> Option<&mut StoredEntry> {
        self.workspaces.iter_mut().find(|w| w.entry.id == id)
    }

    pub fn ids(&self) -> HashSet<String> {
        self.workspaces.iter().map(|w| w.entry.id.clone()).collect()
    }

    pub fn next_order(&self) -> u32 {
        self.workspaces.iter().map(|w| w.entry.order + 1).max().unwrap_or(0)
    }

    /// Entries sorted by `order`, then name.
    pub fn sorted(&self) -> Vec<&StoredEntry> {
        let mut v: Vec<&StoredEntry> = self.workspaces.iter().collect();
        v.sort_by(|a, b| a.entry.order.cmp(&b.entry.order).then_with(|| a.entry.name.cmp(&b.entry.name)));
        v
    }
}

/// Parses and validates registry bytes. `registryCorrupt` for anything unreadable, `unsupportedVersion` for a newer file.
pub fn parse_registry(bytes: &[u8]) -> Result<RegistryFile, EngineError> {
    let corrupt = |why: String| EngineError::new(code::REGISTRY_CORRUPT, "the workspace list is not valid").with_detail(why);
    // Peek at the version first: a newer file may have a shape this build cannot parse at all.
    let value: Value = serde_json::from_slice(bytes).map_err(|e| corrupt(e.to_string()))?;
    match value.get("version") {
        Some(Value::Number(n)) if n.as_u64() == Some(1) => {}
        Some(Value::Number(n)) if n.as_u64().is_some_and(|v| v > 1) => {
            return Err(EngineError::new(code::UNSUPPORTED_VERSION, "the workspace list was written by a newer version"));
        }
        _ => return Err(corrupt("missing or invalid version".into())),
    }
    let file: RegistryFile = serde_json::from_value(value).map_err(|e| corrupt(e.to_string()))?;
    if file.workspaces.len() > MAX_WORKSPACES * 2 {
        return Err(corrupt("too many workspaces".into()));
    }
    let mut seen = HashSet::new();
    for w in &file.workspaces {
        if !valid_id(&w.entry.id) || !seen.insert(w.entry.id.clone()) {
            return Err(corrupt(format!("invalid or duplicate id {:?}", w.entry.id)));
        }
        if !valid_color(&w.entry.color) {
            return Err(corrupt(format!("invalid colour in {:?}", w.entry.id)));
        }
    }
    Ok(file)
}

pub fn to_json(file: &RegistryFile) -> Vec<u8> {
    let mut v = serde_json::to_vec_pretty(file).expect("registry serialises");
    v.push(b'\n');
    v
}

/// `^[a-z0-9][a-z0-9-]{0,30}$`
pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 31
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `#rrggbb`
pub fn valid_color(c: &str) -> bool {
    c.strip_prefix('#').is_some_and(|h| h.len() == 6 && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

pub fn new_id() -> String {
    let u = uuid::Uuid::new_v4().simple().to_string();
    format!("w{}", &u[..10])
}

/// Unicode format characters (category Cf) and line/paragraph separators (Zl, Zp): invisible, and bidi overrides can
/// make a name look like another one. This is the list of the Unicode database up to version 16 without the
/// script-specific private ranges, enough for display names.
fn is_invisible(c: char) -> bool {
    c.is_control()
        || matches!(c as u32,
            0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2 | 0x180E
            | 0x200B..=0x200F | 0x2028 | 0x2029 | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F
            | 0xFEFF | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

/// Whether `text` has control, format or separator characters.
pub fn has_invisible(text: &str) -> bool {
    text.chars().any(is_invisible)
}

/// NFC, trimmed, 1..=60 characters, no control, format or separator characters.
pub fn normalize_name(raw: &str) -> Result<String, EngineError> {
    let name: String = raw.nfc().collect::<String>().trim().to_owned();
    let n = name.chars().count();
    if n == 0 || n > MAX_NAME_CHARS || name.chars().any(is_invisible) {
        return Err(EngineError::new(code::INVALID_NAME, "the name must be 1 to 60 characters without control characters"));
    }
    Ok(name)
}

/// Comparison key for "unique ignoring case".
pub fn name_key(name: &str) -> String {
    name.nfc().collect::<String>().trim().to_lowercase()
}

pub fn check_color(c: &str) -> Result<(), EngineError> {
    if valid_color(c) {
        Ok(())
    } else {
        Err(EngineError::new(code::INVALID_COLOR, "use a colour like #8b6cf0"))
    }
}

/// First palette colour not in `used`; when all are used, cycles by `used.len()`.
pub fn next_color(used: &[String]) -> String {
    let taken: HashSet<String> = used.iter().map(|c| c.to_lowercase()).collect();
    PALETTE.iter().find(|c| !taken.contains(**c)).map_or_else(|| PALETTE[used.len() % PALETTE.len()].to_owned(), |c| (*c).to_owned())
}

/// Lowercase `[a-z0-9]`, other runs become `-`, trimmed.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.nfc().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_owned()
}

fn hex10(path: &str, extra: usize) -> String {
    let digest = Sha256::digest(path.as_bytes());
    hex::encode(digest)[..10 + extra].to_owned()
}

/// `slug(name)[..24] + "-" + hex10(sha256(canonical_path))`, hash extended by two hex digits per collision.
pub fn new_repo_id(name: &str, canonical_path: &str, taken: &HashSet<String>) -> String {
    let mut s = slug(name);
    s.truncate(24);
    let s = s.trim_matches('-').to_owned();
    let base = if s.is_empty() { "repo".to_owned() } else { s };
    for extra in (0..=40).step_by(2) {
        let id = format!("{base}-{}", hex10(canonical_path, extra));
        if !taken.contains(&id) {
            return id;
        }
    }
    format!("{base}-{}-{}", hex10(canonical_path, 0), uuid::Uuid::new_v4().simple())
}

/// Initials of the words of `name` (max 2, upper case); falls back to the first two letters.
pub fn badge_for(name: &str) -> String {
    let words: Vec<&str> = name.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
    let initials: String = words.iter().filter_map(|w| w.chars().next()).take(2).flat_map(char::to_uppercase).collect();
    if initials.chars().count() >= 2 || (words.len() == 1 && words[0].chars().count() < 2 && !initials.is_empty()) {
        return initials;
    }
    let letters: String = name.chars().filter(|c| c.is_alphanumeric()).take(2).flat_map(char::to_uppercase).collect();
    if letters.is_empty() {
        "WS".to_owned()
    } else {
        letters
    }
}

/// The kind of repository a path was validated as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepoKind {
    Repo,
    Worktree,
    Submodule,
}

/// A folder that `intely-pathpick` validated and the caller redeemed from its token. The registry never sees a token.
#[derive(Debug, Clone)]
pub struct ValidatedRepo {
    pub canonical_path: String,
    pub suggested_name: String,
    /// `"{dev}:{ino}"`
    pub identity: String,
    pub kind: RepoKind,
    /// Canonical path of the main repository of a linked worktree.
    pub main: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewRepo {
    pub repo: ValidatedRepo,
    pub name: Option<String>,
    pub badge: Option<String>,
    pub color: Option<String>,
}

impl NewRepo {
    pub fn plain(repo: ValidatedRepo) -> Self {
        Self { repo, name: None, badge: None, color: None }
    }
}

#[derive(Debug, Clone)]
pub struct NewWorkspace {
    pub name: String,
    pub color: Option<String>,
    pub repos: Vec<NewRepo>,
    pub origin: WorkspaceOrigin,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_colours() {
        assert!(valid_id("w3f9a1c2b4") && valid_id("w-migrated") && valid_id("0a"));
        for bad in ["", "-a", "A", "a/b", "a..b", "a b", "a_b", &"a".repeat(32)] {
            assert!(!valid_id(bad), "{bad:?}");
        }
        assert!(valid_color("#8b6cf0") && valid_color("#ABCDEF"));
        for bad in ["8b6cf0", "#8b6cf", "#8b6cg0", "red", "#8b6cf00"] {
            assert!(!valid_color(bad), "{bad:?}");
        }
        assert!(valid_id(&new_id()));
    }

    #[test]
    fn names_follow_the_rules() {
        assert_eq!(normalize_name("  Cafe\u{301}  ").unwrap(), "Caf\u{e9}");
        assert!(normalize_name("").is_err() && normalize_name("   ").is_err());
        assert!(normalize_name(&"x".repeat(60)).is_ok() && normalize_name(&"x".repeat(61)).is_err());
        for bad in ["a\nb", "a\tb", "a\u{202E}b", "a\u{200B}b", "a\u{2028}b", "a\u{FEFF}", "a\u{0}b", "\u{2066}x"] {
            assert_eq!(normalize_name(bad).unwrap_err().code, code::INVALID_NAME, "{bad:?}");
        }
        assert_eq!(name_key("Side Projects"), name_key("side  projects".replace("  ", " ").as_str()));
        assert_eq!(name_key("CAFE\u{301}"), name_key("caf\u{e9}"));
    }

    #[test]
    fn repo_ids_are_stable_and_extend_on_collision() {
        let a = new_repo_id("My Repo!", "/x/My Repo!", &HashSet::new());
        assert!(a.starts_with("my-repo-") && a.len() == "my-repo-".len() + 10, "{a}");
        assert_eq!(a, new_repo_id("My Repo!", "/x/My Repo!", &HashSet::new()));
        let taken: HashSet<String> = [a.clone()].into();
        let b = new_repo_id("My Repo!", "/x/My Repo!", &taken);
        assert_ne!(a, b);
        assert!(b.starts_with(&a) || b.len() == a.len() + 2, "{a} {b}");
        assert!(new_repo_id("///", "/x", &HashSet::new()).starts_with("repo-"));
        assert!(new_repo_id(&"y".repeat(60), "/x", &HashSet::new()).len() <= 24 + 1 + 10);
    }

    #[test]
    fn badges_and_colours_cycle() {
        assert_eq!(badge_for("shop-mobile"), "SM");
        assert_eq!(badge_for("admin"), "AD");
        assert_eq!(badge_for("x"), "X");
        assert_eq!(badge_for("!!"), "WS");
        assert_eq!(next_color(&[]), PALETTE[0]);
        assert_eq!(next_color(&[PALETTE[0].to_owned(), PALETTE[1].to_uppercase()]), PALETTE[2]);
        let all: Vec<String> = PALETTE.iter().map(|c| (*c).to_owned()).collect();
        assert_eq!(next_color(&all), PALETTE[0]);
    }

    #[test]
    fn unknown_fields_survive_a_round_trip_and_newer_versions_are_reported() {
        let text = r##"{"version":1,"rev":3,"activeId":"a","future":{"x":1},"workspaces":[{"id":"a","name":"A","color":"#8b6cf0","order":0,"createdAt":1,"lastOpenedAt":null,"origin":"created","pinnedAt":5}]}"##;
        let f = parse_registry(text.as_bytes()).unwrap();
        let again: Value = serde_json::from_slice(&to_json(&f)).unwrap();
        assert_eq!(again["future"], serde_json::json!({"x":1}));
        assert_eq!(again["workspaces"][0]["pinnedAt"], 5);
        assert_eq!(parse_registry(br#"{"version":2,"workspaces":"?"}"#).unwrap_err().code, code::UNSUPPORTED_VERSION);
        for bad in ["", "{", "[]", r#"{"version":"1"}"#, r#"{"version":1,"workspaces":[{"id":"A"}]}"#] {
            assert_eq!(parse_registry(bad.as_bytes()).unwrap_err().code, code::REGISTRY_CORRUPT, "{bad:?}");
        }
    }
}
