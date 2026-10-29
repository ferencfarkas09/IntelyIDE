//! Which permissions the app seems to use, and how sure that is. It is a guess made from package names (`expo-camera`) and from
//! calls in the project's own native code (`CLLocationManager`); the tables are in `data/permissions.json`. The result is always
//! shown with its confidence, never as a fact: JavaScript can ask for a permission in ways neither source shows.

use std::collections::BTreeMap;

use crate::data::{self, PermDef};
use crate::{Confidence, Ctx};

const MAX_SOURCES: usize = 300;
const MAX_SOURCE_BYTES: u64 = 256 * 1024;
const MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct Evidence {
    pub confidence: Confidence,
    /// `package:<name>` or `native:<file>`: what the guess rests on.
    pub why: String,
}

#[derive(Debug, Default)]
pub(crate) struct Perms {
    pub ios: BTreeMap<String, Evidence>,
    pub android: BTreeMap<String, Evidence>,
}

fn rank(c: Confidence) -> u8 {
    match c {
        Confidence::High => 3,
        Confidence::Medium => 2,
        Confidence::Low => 1,
    }
}

fn note(map: &mut BTreeMap<String, Evidence>, perm: &str, confidence: Confidence, why: String) {
    if map.get(perm).map_or(true, |e| rank(e.confidence) < rank(confidence)) {
        map.insert(perm.to_string(), Evidence { confidence, why });
    }
}

fn parse(c: &str) -> Confidence {
    match c {
        "high" => Confidence::High,
        "medium" => Confidence::Medium,
        _ => Confidence::Low,
    }
}

pub(crate) fn collect(cx: &mut Ctx) -> Perms {
    let mut out = Perms::default();
    let defs: &[PermDef] = data::permissions();
    for d in defs {
        for (pkg, conf) in &d.packages {
            if cx.pkg.has(pkg) {
                note(&mut out.ios, &d.id, parse(conf), format!("package:{pkg}"));
                note(&mut out.android, &d.id, parse(conf), format!("package:{pkg}"));
            }
        }
    }
    let sources: Vec<(String, bool)> = cx
        .files
        .files
        .iter()
        .filter_map(|f| {
            let ios = f.starts_with("ios/") && [".m", ".mm", ".h", ".swift"].iter().any(|e| f.ends_with(e));
            let android = f.starts_with("android/") && f.contains("/src/main/") && [".kt", ".java"].iter().any(|e| f.ends_with(e));
            (ios || android).then(|| (f.clone(), ios))
        })
        .take(MAX_SOURCES)
        .collect();
    let mut total = 0u64;
    for (file, is_ios) in sources {
        if total > MAX_TOTAL_BYTES {
            break;
        }
        let Some(text) = cx.read_cap(&file, MAX_SOURCE_BYTES) else { continue };
        total += text.len() as u64;
        for d in defs {
            let symbols = if is_ios { &d.ios_symbols } else { &d.android_symbols };
            if symbols.iter().any(|s| text.contains(s.as_str())) {
                let map = if is_ios { &mut out.ios } else { &mut out.android };
                note(map, &d.id, Confidence::High, format!("native:{file}"));
            }
        }
    }
    out
}

pub(crate) fn defs() -> &'static [PermDef] {
    data::permissions()
}

/// Turns an evidence reason into a short plain phrase for a prompt.
pub(crate) fn describe(why: &str) -> String {
    match why.split_once(':') {
        Some(("package", p)) => format!("the package {p} in package.json"),
        Some(("native", f)) => format!("native code in {f}"),
        _ => why.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_best_evidence_wins() {
        let mut m = BTreeMap::new();
        note(&mut m, "camera", Confidence::Low, "package:a".into());
        note(&mut m, "camera", Confidence::High, "native:f".into());
        note(&mut m, "camera", Confidence::Medium, "package:b".into());
        assert_eq!(m["camera"].why, "native:f");
        assert_eq!(describe("package:expo-camera"), "the package expo-camera in package.json");
    }
}
