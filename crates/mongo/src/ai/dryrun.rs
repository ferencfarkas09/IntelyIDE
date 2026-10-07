//! Step 7: explain dry run (queryPlanner, does not execute) and the warnings that follow from the plan and the indexes.
//! An index suggestion is copyable text only; the IDE never creates an index.

use serde_json::Value;

use super::errors::DbError;
use super::ports::{DbPort, ExplainFind};
use super::validate::ValidatedFind;
use crate::digest::Digest;
use crate::explain::{self, PlanSummary};

#[derive(Debug, Clone, PartialEq)]
pub struct DryRun {
    pub plan: PlanSummary,
    pub warnings: Vec<String>,
    pub index_suggestion: Option<String>,
}

fn json_text(v: &Value) -> String {
    v.to_string()
}

pub async fn dry_run<D: DbPort>(db: &D, v: &ValidatedFind, digest: Option<&Digest>) -> Result<DryRun, DbError> {
    let q = ExplainFind {
        collection: v.collection.clone(),
        filter: json_text(&v.filter),
        projection: v.projection.as_ref().map(json_text),
        sort: v.sort.as_ref().map(json_text),
        skip: v.skip,
        limit: v.limit,
    };
    let plan = db.explain_find(&q).await?;
    let mut warnings = explain::warnings(&plan, digest.and_then(|d| d.estimated));
    if let Some(d) = digest {
        warnings.extend(static_warnings(v, d));
    }
    let index_suggestion = (plan.collscan || warnings.iter().any(|w| w.starts_with("examines"))).then(|| suggest_index(&v.collection, &v.filter, v.sort.as_ref())).flatten();
    Ok(DryRun { plan, warnings, index_suggestion })
}

/// First key of every index of the digest.
fn index_firsts(d: &Digest) -> Vec<String> {
    d.indexes.iter().filter_map(|t| serde_json::from_str::<Value>(t).ok()).filter_map(|v| v.as_object().and_then(|m| m.keys().next().cloned())).collect()
}

/// Unanchored or case-insensitive `$regex` on a field no index starts with.
pub fn static_warnings(v: &ValidatedFind, d: &Digest) -> Vec<String> {
    let firsts = index_firsts(d);
    let mut out = Vec::new();
    let Value::Object(m) = &v.filter else { return out };
    for (k, val) in m {
        if k.starts_with('$') {
            continue;
        }
        let (pattern, options) = match val {
            Value::Object(o) => match o.get("$regularExpression") {
                Some(r) => (r.get("pattern").and_then(Value::as_str), r.get("options").and_then(Value::as_str).unwrap_or("")),
                None => match o.get("$regex") {
                    Some(Value::String(p)) => (Some(p.as_str()), o.get("$options").and_then(Value::as_str).unwrap_or("")),
                    _ => (None, ""),
                },
            },
            _ => (None, ""),
        };
        if let Some(p) = pattern {
            let root = k.split('.').next().unwrap_or(k);
            let indexed = firsts.iter().any(|f| f == k || f == root);
            if (!p.starts_with('^') || options.contains('i')) && !indexed {
                out.push(format!("{} regex on {k} cannot use an index and scans every document", if options.contains('i') { "case-insensitive" } else { "unanchored" }));
            }
        }
    }
    out
}

fn is_range(v: &Value) -> bool {
    v.as_object().is_some_and(|o| o.keys().any(|k| matches!(k.as_str(), "$gt" | "$gte" | "$lt" | "$lte" | "$ne" | "$nin" | "$regex" | "$regularExpression" | "$exists" | "$type")))
}

/// Equality, sort, range (ESR) order, as a mongosh `createIndex` text.
pub fn suggest_index(collection: &str, filter: &Value, sort: Option<&Value>) -> Option<String> {
    let Value::Object(f) = filter else { return None };
    let mut eq = Vec::new();
    let mut range = Vec::new();
    for (k, v) in f {
        if k.starts_with('$') {
            continue;
        }
        let ejson_scalar = v.as_object().is_some_and(|o| o.len() == 1 && o.keys().next().is_some_and(|k| matches!(k.as_str(), "$oid" | "$date" | "$numberInt" | "$numberLong" | "$numberDouble")));
        if ejson_scalar || !v.is_object() || v.as_object().is_some_and(|o| o.keys().all(|k| matches!(k.as_str(), "$eq" | "$in"))) {
            eq.push(k.clone());
        } else if is_range(v) {
            range.push(k.clone());
        }
    }
    let mut keys: Vec<(String, i64)> = eq.into_iter().map(|k| (k, 1)).collect();
    if let Some(Value::Object(s)) = sort {
        for (k, d) in s {
            if !keys.iter().any(|(x, _)| x == k) {
                let dir = d.as_i64().or_else(|| d.get("$numberInt").and_then(Value::as_str).and_then(|x| x.parse().ok())).unwrap_or(1);
                keys.push((k.clone(), dir));
            }
        }
    }
    for k in range {
        if !keys.iter().any(|(x, _)| *x == k) {
            keys.push((k, 1));
        }
    }
    if keys.is_empty() {
        return None;
    }
    let body = keys.iter().map(|(k, d)| format!("{}: {d}", if k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') { k.clone() } else { format!("'{k}'") })).collect::<Vec<_>>().join(", ");
    Some(format!("db.{collection}.createIndex({{ {body} }})"))
}
