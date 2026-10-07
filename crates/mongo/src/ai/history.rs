//! History and few-shot examples. Raw literals are never stored: the question is stored after the masking filter and the
//! query as a *template* in which every literal is a typed placeholder. Result data is never stored.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::privacy::fold;
use super::prompt::FewShot;
use crate::shell::{self, ParseOptions};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub ts_ms: i64,
    pub collection: String,
    /// After the masking filter.
    pub question: String,
    /// JSON text of `{filter, projection?, sort?, limit?}` with every literal replaced by a typed placeholder.
    pub query: String,
    pub edited: bool,
    pub accepted: bool,
    pub duration_ms: Option<u64>,
    pub count: Option<u64>,
}

/// Every literal to a typed placeholder; keys and structure stay.
pub fn template(v: &Value) -> Value {
    match v {
        Value::String(_) => json!("<string>"),
        Value::Number(_) => json!("<number>"),
        Value::Bool(_) => json!("<bool>"),
        Value::Null => Value::Null,
        Value::Array(a) => Value::Array(a.iter().map(template).collect()),
        Value::Object(m) => {
            if m.len() == 1 {
                let (k, _) = m.iter().next().unwrap();
                let t = match k.as_str() {
                    "$oid" => Some("<objectid>"),
                    "$date" => Some("<date>"),
                    "$numberInt" | "$numberLong" | "$numberDouble" | "$numberDecimal" => Some("<number>"),
                    "$regularExpression" => Some("<regex>"),
                    "$binary" => Some("<binary>"),
                    _ => None,
                };
                if let Some(t) = t {
                    return json!(t);
                }
            }
            Value::Object(m.iter().map(|(k, c)| (k.clone(), template(c))).collect())
        }
    }
}

impl HistoryEntry {
    /// `question_masked` must already have passed the masking filter; the query text is templated here.
    #[allow(clippy::too_many_arguments)]
    pub fn new(ts_ms: i64, collection: &str, question_masked: &str, filter: &str, projection: Option<&str>, sort: Option<&str>, limit: Option<i64>, edited: bool, accepted: bool, duration_ms: Option<u64>, count: Option<u64>) -> Self {
        let po = ParseOptions { now_ms: Some(ts_ms) };
        let t = |s: &str| shell::parse_document(s, &po).map(|v| template(&v)).unwrap_or_else(|_| json!("<unparsed>"));
        let mut q = serde_json::Map::new();
        q.insert("filter".into(), t(filter));
        if let Some(p) = projection.filter(|s| !s.trim().is_empty()) {
            q.insert("projection".into(), t(p));
        }
        if let Some(s) = sort.filter(|s| !s.trim().is_empty()) {
            q.insert("sort".into(), t(s));
        }
        if let Some(l) = limit {
            q.insert("limit".into(), json!(l));
        }
        Self { ts_ms, collection: collection.to_string(), question: question_masked.to_string(), query: Value::Object(q).to_string(), edited, accepted, duration_ms, count }
    }
}

pub fn to_jsonl(entries: &[HistoryEntry]) -> String {
    entries.iter().filter_map(|e| serde_json::to_string(e).ok()).collect::<Vec<_>>().join("\n")
}
pub fn from_jsonl(text: &str) -> Vec<HistoryEntry> {
    text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

fn words(s: &str) -> Vec<String> {
    fold(s).split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3).map(|w| w.chars().take(5).collect()).collect()
}

/// Up to `n` accepted examples of the same collection, ranked by word overlap with the masked question. Newest first on ties.
pub fn select_few_shot(history: &[HistoryEntry], collection: &str, question_masked: &str, n: usize) -> Vec<FewShot> {
    let qw = words(question_masked);
    let mut scored: Vec<(usize, i64, &HistoryEntry)> = history
        .iter()
        .filter(|h| h.accepted && h.collection == collection && h.question != question_masked)
        .map(|h| (words(&h.question).iter().filter(|w| qw.contains(w)).count(), h.ts_ms, h))
        .filter(|(s, _, _)| *s > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    scored.into_iter().take(n).map(|(_, _, h)| FewShot { question: h.question.clone(), query: format!("{{\"collection\":{},\"query\":{}}}", json!(h.collection), h.query) }).collect()
}
