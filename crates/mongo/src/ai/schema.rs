//! Schema digest fetch (sample 200 + latest 100 by `_id`), the per-connection cache (TTL 1 h) and collection routing
//! (keyword match with Hungarian prefix stemming and a glossary).

use std::collections::BTreeMap;

use serde_json::Value;

use super::errors::DbError;
use super::ports::{DbPort, SampleKind};
use super::privacy::fold;
use crate::digest::{self, Digest};

pub const SAMPLE_RANDOM: usize = 200;
pub const SAMPLE_LATEST: usize = 100;
pub const DIGEST_TTL_MS: i64 = 3_600_000;
/// About 3k tokens at 4 characters per token for the target collection.
pub const DIGEST_BUDGET_CHARS: usize = 12_000;
/// About 300 tokens for the other collections.
pub const OTHERS_BUDGET_CHARS: usize = 1_200;

/// Random sample plus the latest documents, de-duplicated by `_id` so presence percentages are not skewed.
pub async fn fetch_digest<D: DbPort>(db: &D, collection: &str) -> Result<Digest, DbError> {
    let mut docs = db.sample(collection, SampleKind::Random(SAMPLE_RANDOM)).await?;
    let latest = db.sample(collection, SampleKind::Latest(SAMPLE_LATEST)).await?;
    let mut seen: std::collections::HashSet<String> = docs.iter().map(|d| d.get("_id").map_or(String::new(), Value::to_string)).collect();
    for d in latest {
        if seen.insert(d.get("_id").map_or(String::new(), Value::to_string)) {
            docs.push(d);
        }
    }
    // Index and count failures are not fatal: the digest is still useful without them.
    let indexes = db.indexes(collection).await.unwrap_or_default();
    let estimated = db.estimated_count(collection).await.ok();
    Ok(digest::build(collection, &docs, estimated, indexes))
}

#[derive(Debug, Default)]
pub struct DigestCache {
    map: BTreeMap<(String, String), (Digest, i64)>,
}

impl DigestCache {
    pub fn get(&self, conn: &str, collection: &str, now_ms: i64) -> Option<&Digest> {
        self.map.get(&(conn.to_string(), collection.to_string())).filter(|(_, at)| now_ms - at < DIGEST_TTL_MS).map(|(d, _)| d)
    }
    pub fn put(&mut self, conn: &str, collection: &str, d: Digest, now_ms: i64) {
        self.map.insert((conn.to_string(), collection.to_string()), (d, now_ms));
    }
    pub fn invalidate(&mut self, conn: &str, collection: Option<&str>) {
        self.map.retain(|(c, k), _| !(c == conn && collection.is_none_or(|x| x == k)));
    }
    /// Cached or fetched; `refresh` is the manual refresh button.
    pub async fn get_or_fetch<D: DbPort>(&mut self, db: &D, conn: &str, collection: &str, now_ms: i64, refresh: bool) -> Result<Digest, DbError> {
        if !refresh {
            if let Some(d) = self.get(conn, collection, now_ms) {
                return Ok(d.clone());
            }
        }
        let d = fetch_digest(db, collection).await?;
        self.put(conn, collection, d.clone(), now_ms);
        Ok(d)
    }
    /// Top field paths of every cached digest of the connection (for the "other collections" section).
    pub fn top_fields(&self, conn: &str, now_ms: i64) -> BTreeMap<String, Vec<String>> {
        let mut out = BTreeMap::new();
        for ((c, k), (d, at)) in &self.map {
            if c == conn && now_ms - at < DIGEST_TTL_MS {
                let mut f: Vec<&crate::digest::FieldStat> = d.fields.iter().filter(|f| !f.path.contains('.')).collect();
                f.sort_by(|a, b| b.docs.cmp(&a.docs).then(a.path.cmp(&b.path)));
                out.insert(k.clone(), f.iter().take(8).map(|f| f.path.clone()).collect());
            }
        }
        out
    }
}

/// Built-in Hungarian stems for the usual POS collections; the per-connection glossary adds to it.
/// Now owned by the Happy preset; the generic preset has no built-in glossary.
pub const DEFAULT_GLOSSARY: &[(&str, &str)] = &crate::presets::happy::GLOSSARY;

fn stem(w: &str) -> String {
    let w = fold(w);
    let w = w.trim_end_matches('s');
    w.chars().take(5).collect()
}

fn question_words(q: &str) -> Vec<String> {
    fold(q).split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3).map(str::to_string).collect()
}

/// Collections ranked by how well they match the question; score 0 are dropped.
pub fn rank_collections(question: &str, names: &[String], glossary: &[(String, String)]) -> Vec<(String, usize)> {
    rank_collections_in(question, names, glossary, DEFAULT_GLOSSARY)
}

/// Same, with the preset's built-in glossary as `base` (empty for the generic preset).
pub fn rank_collections_in(question: &str, names: &[String], glossary: &[(String, String)], base: &[(&str, &str)]) -> Vec<(String, usize)> {
    let words = question_words(question);
    let mut out: Vec<(String, usize)> = Vec::new();
    for c in names {
        let cs = stem(c);
        let cf = fold(c);
        let mut score = 0;
        for w in &words {
            let ws: String = w.chars().take(5).collect();
            if w.starts_with(&cs) && cs.len() >= 3 || cf.starts_with(&ws) && ws.len() >= 4 {
                score += 2;
            }
            for (k, v) in base.iter().map(|(k, v)| (k.to_string(), v.to_string())).chain(glossary.iter().map(|(k, v)| (fold(k), fold(v)))) {
                let k = fold(&k);
                if w.starts_with(&k) && (cf == v || cf == format!("{v}s") || cf == format!("{v}es") || cf.starts_with(&v)) {
                    score += 3;
                }
            }
        }
        if score > 0 {
            out.push((c.clone(), score));
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    out
}

/// The collection the question is clearly about when it is not the selected one ("Debreceni éttermek" while `orders` is
/// open). Only a glossary or name hit that beats the selected collection by a margin switches; ties stay with the user.
pub fn better_collection(question: &str, names: &[String], selected: &str, glossary: &[(String, String)]) -> Option<String> {
    better_collection_in(question, names, selected, glossary, DEFAULT_GLOSSARY)
}

pub fn better_collection_in(question: &str, names: &[String], selected: &str, glossary: &[(String, String)], base: &[(&str, &str)]) -> Option<String> {
    let ranked = rank_collections_in(question, names, glossary, base);
    let sel = ranked.iter().find(|(n, _)| n == selected).map_or(0, |(_, s)| *s);
    ranked.into_iter().find(|(n, s)| n != selected && *s >= 3 && *s > sel + 2).map(|(n, _)| n)
}

/// The about-300-token section: other collection names, the most relevant ones with their top fields.
pub fn others_section(selected: &str, names: &[String], question: &str, glossary: &[(String, String)], top_fields: &BTreeMap<String, Vec<String>>) -> String {
    others_section_in(selected, names, question, glossary, top_fields, DEFAULT_GLOSSARY)
}

pub fn others_section_in(selected: &str, names: &[String], question: &str, glossary: &[(String, String)], top_fields: &BTreeMap<String, Vec<String>>, base: &[(&str, &str)]) -> String {
    let others: Vec<&String> = names.iter().filter(|n| n.as_str() != selected).collect();
    if others.is_empty() {
        return String::new();
    }
    let ranked = rank_collections_in(question, names, glossary, base);
    let mut out = String::from("Other collections in this database (names only unless noted; use the schema above for the selected one):\n");
    let mut used: Vec<&str> = Vec::new();
    for (n, _) in ranked.iter().filter(|(n, _)| n != selected).take(3) {
        if let Some(f) = top_fields.get(n) {
            out.push_str(&format!("- {n}: {}\n", f.join(", ")));
            used.push(n);
        }
    }
    let rest: Vec<&str> = others.iter().map(|s| s.as_str()).filter(|n| !used.contains(n)).collect();
    if !rest.is_empty() {
        out.push_str(&format!("- also: {}\n", rest.join(", ")));
    }
    if out.len() > OTHERS_BUDGET_CHARS {
        out.truncate(OTHERS_BUDGET_CHARS);
        while !out.is_char_boundary(out.len()) {
            out.pop();
        }
        out.push('\n');
    }
    out
}
