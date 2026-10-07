//! Evaluation harness pieces that need no server: the golden-set types, result comparison (execution match), cassettes
//! keyed by prompt hash so CI replays model answers offline and free, and the metrics summary.
//!
//! A cassette is either `live` (recorded from a real model) or `authored` (a hand-written model answer used to exercise
//! the validator, repair loop and safety paths). The summary reports them separately: only `live` rows say anything about
//! model quality.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::ports::{ModelPort, ModelError, ModelReply, Usage};
use super::prompt::GenRequest;

// ---- golden set -----------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaseKind {
    Normal,
    /// Adversarial / injection / unanswerable: scored on safety expectations, not on execution match.
    Safety,
    /// A planted fake-PII literal must never appear in a payload sent to the model.
    Pii,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScoreMode {
    /// Re-run both queries with projection `{_id: 1}` and compare the id lists (ordered when `ordered`).
    #[default]
    Ids,
    /// Compare projected values ignoring field names; extra fields in the generated rows are allowed.
    Values,
    /// Compare counts only (gold has a limit but no total order).
    Count,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gold {
    pub collection: String,
    #[serde(default)]
    pub filter: String,
    #[serde(default)]
    pub projection: Option<String>,
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expect {
    /// "ready" | "clarify" | "failed" | "not_ready" (anything but a ready draft) | "any"
    #[serde(default)]
    pub status: Option<String>,
    /// The final draft, if any, contains none of the deny-listed operators (always checked for safety cases).
    #[serde(default)]
    pub read_only_find: bool,
    /// The UI note "I only generate read queries" is shown.
    #[serde(default)]
    pub intent_note: bool,
    /// The draft targets this collection.
    #[serde(default)]
    pub collection: Option<String>,
    /// The final (user-facing, unmasked) filter text contains these.
    #[serde(default)]
    pub filter_contains: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Case {
    pub id: String,
    pub lang: String,
    pub kind: CaseKind,
    pub question: String,
    #[serde(default)]
    pub selected: Option<String>,
    #[serde(default)]
    pub gold: Option<Gold>,
    #[serde(default)]
    pub score: ScoreMode,
    #[serde(default)]
    pub ordered: bool,
    #[serde(default)]
    pub expect: Expect,
    /// Literals that must not appear in any payload sent to the model.
    #[serde(default)]
    pub planted: Vec<String>,
    /// Record this case from a real model in a live run (the live budget is small).
    #[serde(default)]
    pub live: bool,
    /// Authored model replies, one per round (the first answer, then the answers to repair requests).
    #[serde(default)]
    pub authored: Vec<Value>,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suite {
    pub now: String,
    pub db: String,
    pub cases: Vec<Case>,
}

// ---- comparison -----------------------------------------------------------------------------------------------------

fn leaf(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Null => out.push("null".into()),
        Value::Bool(b) => out.push(b.to_string()),
        Value::Number(n) => out.push(n.as_f64().map_or(n.to_string(), |f| format!("{f}"))),
        Value::String(s) => out.push(format!("s:{s}")),
        Value::Array(a) => a.iter().for_each(|c| leaf(c, out)),
        Value::Object(m) => {
            if m.len() == 1 {
                let (k, c) = m.iter().next().unwrap();
                match (k.as_str(), c) {
                    ("$numberInt" | "$numberLong" | "$numberDouble" | "$numberDecimal", Value::String(s)) => {
                        out.push(s.parse::<f64>().map_or(s.clone(), |f| format!("{f}")));
                        return;
                    }
                    ("$oid", Value::String(s)) => {
                        out.push(format!("oid:{s}"));
                        return;
                    }
                    ("$date", c) => {
                        out.push(format!("date:{}", c.get("$numberLong").and_then(Value::as_str).unwrap_or(&c.to_string())));
                        return;
                    }
                    _ => {}
                }
            }
            m.values().for_each(|c| leaf(c, out));
        }
    }
}

/// Multiset of leaf values of a row, field names ignored.
pub fn row_leaves(doc: &Value) -> Vec<String> {
    let mut v = Vec::new();
    leaf(doc, &mut v);
    v.sort();
    v
}

fn is_sub_multiset(small: &[String], big: &[String]) -> bool {
    let mut j = 0;
    for s in small {
        while j < big.len() && big[j] < *s {
            j += 1;
        }
        if j >= big.len() || big[j] != *s {
            return false;
        }
        j += 1;
    }
    true
}

/// Execution match on values: every gold row must be found in the generated rows (field names ignored, extra fields and a
/// stray `_id` allowed), one-to-one; with `ordered` the i-th gold row must match the i-th generated row. The row counts
/// must be equal.
pub fn values_match(gold: &[Value], got: &[Value], ordered: bool) -> bool {
    if gold.len() != got.len() {
        return false;
    }
    let g: Vec<Vec<String>> = gold.iter().map(row_leaves).collect();
    let r: Vec<Vec<String>> = got.iter().map(row_leaves).collect();
    if ordered {
        return g.iter().zip(&r).all(|(a, b)| is_sub_multiset(a, b));
    }
    let mut used = vec![false; r.len()];
    for a in &g {
        match (0..r.len()).find(|&i| !used[i] && is_sub_multiset(a, &r[i])) {
            Some(i) => used[i] = true,
            None => return false,
        }
    }
    true
}

/// Id lists: equal as lists when `ordered`, as sets otherwise.
pub fn ids_match(gold: &[Value], got: &[Value], ordered: bool) -> bool {
    let key = |x: &[Value]| -> Vec<String> { x.iter().map(|d| d.get("_id").map_or(d.to_string(), Value::to_string)).collect() };
    let (mut a, mut b) = (key(gold), key(got));
    if !ordered {
        a.sort();
        b.sort();
    }
    a == b
}

// ---- cassettes ------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cassette {
    pub key: String,
    pub case: String,
    pub round: usize,
    /// "live" | "authored"
    pub source: String,
    pub tier: String,
    pub model: Option<String>,
    pub reply: Value,
    pub usage: Usage,
}

fn path_of(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{key}.json"))
}

/// Replays recorded answers keyed by `GenRequest::cache_key`. A missing key means the prompt changed since recording.
pub struct CassettePort {
    pub dir: PathBuf,
    pub served: Mutex<Vec<Cassette>>,
}

impl CassettePort {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into(), served: Mutex::new(Vec::new()) }
    }
    pub fn take_served(&self) -> Vec<Cassette> {
        std::mem::take(&mut *self.served.lock().unwrap())
    }
}

impl ModelPort for CassettePort {
    async fn complete(&self, req: &GenRequest) -> Result<ModelReply, ModelError> {
        let p = path_of(&self.dir, &req.cache_key);
        let text = std::fs::read_to_string(&p).map_err(|_| ModelError(format!("no cassette for key {} (the prompt or the case changed since recording; re-record with INTELY_GOLDEN=live or =author)", req.cache_key)))?;
        let c: Cassette = serde_json::from_str(&text).map_err(|e| ModelError(format!("bad cassette {}: {e}", req.cache_key)))?;
        let out = ModelReply { reply: c.reply.clone(), usage: c.usage.clone() };
        self.served.lock().unwrap().push(c);
        Ok(out)
    }
}

/// Serves a fixed list of replies in order: the fake model of unit tests, and the author of `authored` cassettes.
pub struct ScriptedPort {
    pub replies: Mutex<VecDeque<Value>>,
    pub seen: Mutex<Vec<GenRequest>>,
}

impl ScriptedPort {
    pub fn new(replies: Vec<Value>) -> Self {
        Self { replies: Mutex::new(replies.into()), seen: Mutex::new(Vec::new()) }
    }
    pub fn requests(&self) -> Vec<GenRequest> {
        self.seen.lock().unwrap().clone()
    }
}

impl ModelPort for ScriptedPort {
    async fn complete(&self, req: &GenRequest) -> Result<ModelReply, ModelError> {
        self.seen.lock().unwrap().push(req.clone());
        let r = self.replies.lock().unwrap().pop_front().ok_or_else(|| ModelError("scripted model has no more replies".into()))?;
        Ok(ModelReply { reply: r, usage: Usage::default() })
    }
}

/// Wraps another port and writes every answer as a cassette.
pub struct RecordingPort<'a, M: ModelPort> {
    pub inner: &'a M,
    pub dir: PathBuf,
    pub source: &'static str,
    pub model: Option<String>,
    state: Mutex<(String, usize)>,
}

impl<'a, M: ModelPort> RecordingPort<'a, M> {
    pub fn new(inner: &'a M, dir: impl Into<PathBuf>, source: &'static str, model: Option<String>) -> Self {
        Self { inner, dir: dir.into(), source, model, state: Mutex::new((String::new(), 0)) }
    }
    pub fn set_case(&self, id: &str) {
        *self.state.lock().unwrap() = (id.to_string(), 0);
    }
}

impl<M: ModelPort> ModelPort for RecordingPort<'_, M> {
    async fn complete(&self, req: &GenRequest) -> Result<ModelReply, ModelError> {
        let r = self.inner.complete(req).await?;
        let (case, round) = {
            let mut s = self.state.lock().unwrap();
            let out = (s.0.clone(), s.1);
            s.1 += 1;
            out
        };
        let c = Cassette { key: req.cache_key.clone(), case, round, source: self.source.into(), tier: format!("{:?}", req.tier).to_lowercase(), model: self.model.clone(), reply: r.reply.clone(), usage: r.usage.clone() };
        std::fs::create_dir_all(&self.dir).map_err(|e| ModelError(e.to_string()))?;
        std::fs::write(path_of(&self.dir, &req.cache_key), serde_json::to_string_pretty(&c).unwrap()).map_err(|e| ModelError(e.to_string()))?;
        Ok(r)
    }
}

// ---- metrics --------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseResult {
    pub id: String,
    pub lang: String,
    pub kind: Option<CaseKind>,
    pub source: String,
    pub status: String,
    pub executed: bool,
    pub non_empty: bool,
    pub matched: Option<bool>,
    pub first_rejected: bool,
    pub repairs: usize,
    pub collscan: bool,
    pub cost_usd: f64,
    pub ms: u64,
    pub safety_ok: Option<bool>,
    pub detail: String,
    /// The final draft as `collection filter sort limit`, for diagnosing mismatches.
    #[serde(default)]
    pub query: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub cases: usize,
    pub normal: usize,
    pub executed: usize,
    pub non_empty: usize,
    pub matched: usize,
    pub match_pct: f64,
    pub hu_match_pct: f64,
    pub en_match_pct: f64,
    pub first_rejected: usize,
    pub repair_histogram: BTreeMap<usize, usize>,
    pub collscan: usize,
    pub cost_usd: f64,
    pub ms_median: u64,
    pub safety_cases: usize,
    pub safety_failures: usize,
    pub live_normal: usize,
    pub live_matched: usize,
    pub authored_normal: usize,
}

fn pct(n: usize, d: usize) -> f64 {
    if d == 0 { 0.0 } else { (n as f64 * 1000.0 / d as f64).round() / 10.0 }
}

pub fn summarize(rs: &[CaseResult]) -> Summary {
    let normal: Vec<&CaseResult> = rs.iter().filter(|r| r.kind == Some(CaseKind::Normal)).collect();
    let m = |l: Option<&str>| {
        let sel: Vec<&&CaseResult> = normal.iter().filter(|r| l.is_none_or(|l| r.lang == l)).collect();
        pct(sel.iter().filter(|r| r.matched == Some(true)).count(), sel.len())
    };
    let mut hist = BTreeMap::new();
    for r in rs {
        *hist.entry(r.repairs).or_insert(0) += 1;
    }
    let mut ms: Vec<u64> = rs.iter().filter(|r| r.ms > 0).map(|r| r.ms).collect();
    ms.sort_unstable();
    let safety: Vec<&CaseResult> = rs.iter().filter(|r| r.safety_ok.is_some()).collect();
    Summary {
        cases: rs.len(),
        normal: normal.len(),
        executed: normal.iter().filter(|r| r.executed).count(),
        non_empty: normal.iter().filter(|r| r.non_empty).count(),
        matched: normal.iter().filter(|r| r.matched == Some(true)).count(),
        match_pct: m(None),
        hu_match_pct: m(Some("hu")),
        en_match_pct: m(Some("en")),
        first_rejected: rs.iter().filter(|r| r.first_rejected).count(),
        repair_histogram: hist,
        collscan: rs.iter().filter(|r| r.collscan).count(),
        cost_usd: rs.iter().map(|r| r.cost_usd).sum(),
        ms_median: ms.get(ms.len() / 2).copied().unwrap_or(0),
        safety_cases: safety.len(),
        safety_failures: safety.iter().filter(|r| r.safety_ok == Some(false)).count(),
        live_normal: normal.iter().filter(|r| r.source == "live").count(),
        live_matched: normal.iter().filter(|r| r.source == "live" && r.matched == Some(true)).count(),
        authored_normal: normal.iter().filter(|r| r.source == "authored").count(),
    }
}
