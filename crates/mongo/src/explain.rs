//! Explain walker. Works on the raw explain reply as JSON and handles both plan shapes: the classic engine
//! (`winningPlan.stage` / `inputStage(s)`) and the slot-based engine (`winningPlan.queryPlan` + `slotBasedPlan`),
//! find and aggregate (`stages[].$cursor.queryPlanner`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSummary {
    pub stages: Vec<String>,
    pub collscan: bool,
    pub index_names: Vec<String>,
    /// "classic", "sbe" or "unknown".
    pub engine: String,
    pub docs_examined: Option<i64>,
    pub keys_examined: Option<i64>,
    pub n_returned: Option<i64>,
    pub rejected_plans: usize,
}

pub fn summarize(explain: &Value) -> PlanSummary {
    let mut s = PlanSummary { engine: "unknown".into(), ..Default::default() };
    visit(explain, &mut s, false);
    if s.engine == "unknown" && !s.stages.is_empty() {
        s.engine = "classic".into();
    }
    s.collscan = s.stages.iter().any(|x| x == "COLLSCAN");
    s.stages.dedup();
    s.index_names.sort();
    s.index_names.dedup();
    s
}

/// Plain JSON numbers or canonical EJSON wrappers (`{"$numberInt": "5"}`, `$numberLong`, `$numberDouble`).
fn num(v: &Value) -> Option<i64> {
    if let Some(n) = v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)) {
        return Some(n);
    }
    let o = v.as_object()?;
    ["$numberInt", "$numberLong", "$numberDouble"].iter().find_map(|k| o.get(*k)).and_then(Value::as_str).and_then(|s| s.parse::<f64>().ok()).map(|f| f as i64)
}

fn visit(v: &Value, s: &mut PlanSummary, in_plan: bool) {
    match v {
        Value::Object(m) => {
            if m.contains_key("slotBasedPlan") {
                s.engine = "sbe".into();
            }
            if let Some(Value::Array(r)) = m.get("rejectedPlans") {
                s.rejected_plans += r.len();
            }
            if in_plan {
                if let Some(st) = m.get("stage").and_then(Value::as_str) {
                    s.stages.push(st.to_string());
                }
                if let Some(ix) = m.get("indexName").and_then(Value::as_str) {
                    s.index_names.push(ix.to_string());
                }
            }
            if let Some(n) = m.get("totalDocsExamined").and_then(num) {
                s.docs_examined.get_or_insert(n);
            }
            if let Some(n) = m.get("totalKeysExamined").and_then(num) {
                s.keys_examined.get_or_insert(n);
            }
            if let Some(n) = m.get("nReturned").and_then(num) {
                s.n_returned.get_or_insert(n);
            }
            for (k, child) in m {
                match k.as_str() {
                    "rejectedPlans" | "slotBasedPlan" => {}
                    "winningPlan" => visit(child, s, true),
                    _ => visit(child, s, in_plan),
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|c| visit(c, s, in_plan)),
        _ => {}
    }
}

/// Warnings of plan step 7: COLLSCAN on a big collection, plus `$lookup`-style hints are handled by the caller.
pub fn warnings(sum: &PlanSummary, estimated_docs: Option<u64>) -> Vec<String> {
    let mut w = Vec::new();
    if sum.collscan && estimated_docs.is_none_or(|n| n > 50_000) {
        w.push(format!("COLLSCAN on a collection of ~{} documents: no index serves this query", estimated_docs.map_or("unknown".to_string(), |n| n.to_string())));
    }
    if let (Some(e), Some(r)) = (sum.docs_examined, sum.n_returned) {
        if e > 1000 && e > r.max(1) * 100 {
            w.push(format!("examines {e} documents to return {r}"));
        }
    }
    w
}
