//! Finds the locale catalogs of a repository. Three layouts exist in the Happy repos (learned read-only):
//! admin `src/localization/modules/<ns>/<lang>.json`, mobile `locales/<lang>.json` (+ `locales/<ns>/<lang>.json`),
//! POS `src/localization/<lang>/<ns>.json`. One rule covers all of them: a `<lang>.json` is a catalog of its
//! directory's group; a `*.json` directly under a `<lang>/` directory is a catalog of the group named after the file.

use std::collections::BTreeSet;
use std::path::Path;

use serde::Serialize;

use crate::rules::is_lang_code;

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub group: String,
    pub lang: String,
    /// Repo-relative, `/`-separated.
    pub rel: String,
}

const ROOTS: [&str; 3] = ["src/localization/modules", "locales", "src/localization"];
const SKIP: [&str; 6] = ["node_modules", ".git", "dist", "build", "target", ".history"];

pub fn detect(root: &Path) -> Vec<Catalog> {
    let mut out = BTreeSet::new();
    for r in ROOTS {
        let base = root.join(r);
        if base.is_dir() {
            walk(&base, r, &mut String::new(), 0, &mut out);
        }
    }
    out.into_iter().collect()
}

fn walk(dir: &Path, rel_root: &str, rel_dir: &mut String, depth: usize, out: &mut BTreeSet<Catalog>) {
    if depth > 4 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if SKIP.contains(&name.as_str()) || name.starts_with('.') || (depth == 0 && rel_root == "src/localization" && name == "modules") {
                continue;
            }
            let len = rel_dir.len();
            if !rel_dir.is_empty() {
                rel_dir.push('/');
            }
            rel_dir.push_str(&name);
            walk(&e.path(), rel_root, rel_dir, depth + 1, out);
            rel_dir.truncate(len);
        } else if ft.is_file() {
            let Some(stem) = name.strip_suffix(".json") else { continue };
            let rel = if rel_dir.is_empty() { format!("{rel_root}/{name}") } else { format!("{rel_root}/{rel_dir}/{name}") };
            if is_lang_code(stem) {
                let group = if rel_dir.is_empty() { "(root)".to_string() } else { rel_dir.clone() };
                out.insert(Catalog { group, lang: stem.to_string(), rel });
            } else if let Some((parent, last)) = rel_dir.rsplit_once('/').map(|(p, l)| (p.to_string(), l)).or_else(|| (!rel_dir.is_empty()).then(|| (String::new(), rel_dir.as_str()))) {
                // `<lang>/<ns>.json` (POS). Only directly below a language directory.
                if is_lang_code(last) {
                    let group = if parent.is_empty() { stem.to_string() } else { format!("{parent}/{stem}") };
                    out.insert(Catalog { group, lang: last.to_string(), rel });
                }
            }
        }
    }
}
