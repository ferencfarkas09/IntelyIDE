//! The tables the checks lean on, kept in `data/*.json` so a reviewer can read and update them without touching code: which Gradle
//! an Android Gradle plugin needs, which store level the vendors named, which packages and native calls imply which permission.
//! Everything is bundled in the app; nothing is fetched.

use std::cmp::Ordering;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

const COMPAT: &str = include_str!("../data/compat.json");
const STORE: &str = include_str!("../data/store.json");
const PERMS: &str = include_str!("../data/permissions.json");
pub(crate) const CHECKS_JSON: &str = include_str!("../data/checks.json");

/// When each table was last looked over (shown in the app so nobody mistakes an old table for today's policy).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reviewed {
    pub compat: String,
    pub store: String,
}

#[derive(Deserialize)]
struct Compat {
    reviewed: String,
    #[serde(rename = "agpMinGradle")]
    table: Vec<Row>,
}
#[derive(Deserialize)]
struct Row {
    agp: String,
    gradle: String,
}
#[derive(Deserialize)]
struct Store {
    reviewed: String,
    play: Play,
}
#[derive(Deserialize)]
struct Play {
    #[serde(rename = "targetApi")]
    target_api: u32,
}

#[derive(Deserialize)]
pub(crate) struct PermDef {
    pub id: String,
    pub plist: Vec<String>,
    pub android: Vec<String>,
    /// (package, confidence)
    pub packages: Vec<(String, String)>,
    #[serde(rename = "iosSymbols")]
    pub ios_symbols: Vec<String>,
    #[serde(rename = "androidSymbols")]
    pub android_symbols: Vec<String>,
}
#[derive(Deserialize)]
struct Perms {
    permissions: Vec<PermDef>,
}

#[derive(Deserialize)]
struct CheckDef {
    id: String,
}
#[derive(Deserialize)]
struct Checks {
    findings: Vec<CheckDef>,
}

fn compat() -> &'static Compat {
    static C: OnceLock<Compat> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(COMPAT).expect("compat.json"))
}
fn store() -> &'static Store {
    static C: OnceLock<Store> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(STORE).expect("store.json"))
}

pub(crate) fn permissions() -> &'static [PermDef] {
    static C: OnceLock<Perms> = OnceLock::new();
    &C.get_or_init(|| serde_json::from_str(PERMS).expect("permissions.json")).permissions
}

pub(crate) fn check_ids() -> &'static [String] {
    static C: OnceLock<Vec<String>> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str::<Checks>(CHECKS_JSON).expect("checks.json").findings.into_iter().map(|c| c.id).collect())
}

pub(crate) fn registered(id: &str) -> bool {
    check_ids().iter().any(|c| c == id)
}

pub fn reviewed() -> Reviewed {
    Reviewed { compat: compat().reviewed.clone(), store: store().reviewed.clone() }
}

/// The level the vendors' pages named when the store table was reviewed.
pub(crate) fn play_target_api() -> u32 {
    store().play.target_api
}

/// The oldest Gradle the Android Gradle plugin `agp` needs, or `None` when the table does not list that plugin version.
pub(crate) fn min_gradle(agp: &str) -> Option<&'static str> {
    let key: Vec<&str> = agp.split('.').take(2).collect();
    let key = key.join(".");
    compat().table.iter().find(|r| r.agp == key).map(|r| r.gradle.as_str())
}

/// Compares dotted numeric versions (`8.10.2` > `8.9`); a non-numeric part counts as 0.
pub(crate) fn cmp_version(a: &str, b: &str) -> Ordering {
    let parts = |s: &str| s.split(['.', '-']).map(|p| p.chars().take_while(char::is_ascii_digit).collect::<String>().parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..pa.len().max(pb.len()) {
        match pa.get(i).unwrap_or(&0).cmp(pb.get(i).unwrap_or(&0)) {
            Ordering::Equal => {}
            o => return o,
        }
    }
    Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tables_parse_and_look_things_up() {
        assert_eq!(min_gradle("8.5.2"), Some("8.7"));
        assert_eq!(min_gradle("8.10.0"), Some("8.11.1"));
        assert_eq!(min_gradle("12.0"), None);
        assert!(play_target_api() >= 35);
        assert!(!permissions().is_empty() && !check_ids().is_empty());
        assert_eq!(reviewed().compat.len(), 10);
    }

    #[test]
    fn versions_compare_numerically() {
        assert_eq!(cmp_version("8.10.2", "8.9"), Ordering::Greater);
        assert_eq!(cmp_version("8.7", "8.7.0"), Ordering::Equal);
        assert_eq!(cmp_version("7.6", "8.0"), Ordering::Less);
        assert_eq!(cmp_version("x", "0"), Ordering::Equal);
    }

    #[test]
    fn ids_are_unique_and_dotted() {
        let mut seen = std::collections::BTreeSet::new();
        for id in check_ids() {
            assert!(seen.insert(id.clone()), "{id} twice");
            assert!(id.contains('.'));
        }
    }
}
