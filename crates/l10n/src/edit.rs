//! Writes accepted translations into the locale JSON files: one spliced line per key, nothing else touched.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::catalog::{scan, set_key};
use crate::detect::detect;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub rel: String,
    pub path: Vec<String>,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub written: usize,
    pub files: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct EditError {
    pub code: &'static str,
    pub message: String,
}

fn err<T>(code: &'static str, message: impl Into<String>) -> Result<T, EditError> {
    Err(EditError { code, message: message.into() })
}

/// Applies every edit or none: all files are computed and verified in memory first, then written atomically one by one.
pub fn apply(root: &Path, edits: &[Edit]) -> Result<Applied, EditError> {
    let known: BTreeSet<String> = detect(root).into_iter().map(|c| c.rel).collect();
    let mut by_file: BTreeMap<&str, Vec<&Edit>> = BTreeMap::new();
    for e in edits {
        if !known.contains(&e.rel) {
            return err("badRequest", format!("{} is not a locale catalog of this repository", e.rel));
        }
        if e.path.is_empty() || e.path.iter().any(|p| p.is_empty()) {
            return err("badRequest", "empty key");
        }
        if e.value.trim().is_empty() || e.value.chars().any(|c| c.is_control() && c != '\n') {
            return err("badRequest", format!("empty or invalid text for {}", e.path.join(".")));
        }
        by_file.entry(&e.rel).or_default().push(e);
    }
    let mut outputs = Vec::new();
    for (rel, list) in by_file {
        let full = root.join(rel);
        let old = std::fs::read_to_string(&full).map_err(|e| EditError { code: "io", message: format!("{rel}: {e}") })?;
        let before = scan(&old).map_err(|m| EditError { code: "badCatalog", message: format!("{rel}: {m}") })?.flat();
        let mut text = old.clone();
        for e in &list {
            text = set_key(&text, &e.path, &e.value).map_err(|m| EditError { code: "badCatalog", message: format!("{rel}: {m}") })?;
        }
        let after = scan(&text).map_err(|m| EditError { code: "badCatalog", message: format!("{rel}: result is not valid JSON ({m})") })?.flat();
        serde_json::from_str::<serde_json::Value>(&text).map_err(|e| EditError { code: "badCatalog", message: format!("{rel}: result is not valid JSON ({e})") })?;
        let touched: BTreeSet<String> = list.iter().map(|e| e.path.join(".")).collect();
        for (k, v) in &before {
            if !touched.contains(k) && after.get(k) != Some(v) {
                return err("badCatalog", format!("{rel}: edit would change {k}"));
            }
        }
        outputs.push((rel.to_string(), full, text, list.len()));
    }
    let mut written = 0;
    let mut files = Vec::new();
    for (rel, full, text, n) in outputs {
        let tmp = full.with_extension("json.intely-tmp");
        std::fs::write(&tmp, &text).map_err(|e| EditError { code: "io", message: format!("{rel}: {e}") })?;
        if let Ok(meta) = std::fs::metadata(&full) {
            let _ = std::fs::set_permissions(&tmp, meta.permissions());
        }
        std::fs::rename(&tmp, &full).map_err(|e| EditError { code: "io", message: format!("{rel}: {e}") })?;
        written += n;
        files.push(rel);
    }
    Ok(Applied { written, files })
}
