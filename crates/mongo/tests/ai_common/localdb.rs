//! Server-free stand-in for the loopback fixture: the synthetic NDJSON that `scripts/mongo-fixture/seed.mjs` writes, held in
//! memory behind the pipeline's [`DbPort`], plus a small query evaluator (find filters, sort, projection, limit) that is
//! just big enough for the golden set. It exists so the Hungarian/English golden run can be measured on a machine without
//! mongod. Unsupported operators are reported (`Err`) instead of guessed, so a case that needs one is counted as
//! "not executed", never as a match. The real server-backed run stays in `golden.rs`.
#![allow(dead_code)]

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::path::Path;

use intely_mongo::ai::errors::DbError;
use intely_mongo::ai::ports::{DbPort, ExplainFind, SampleKind};
use intely_mongo::explain::PlanSummary;
use intely_mongo::shell::{parse_document, parse_iso_date, ParseOptions};
use serde_json::{json, Value};

pub struct LocalDb {
    pub colls: BTreeMap<String, Vec<Value>>,
    /// Indices of each collection sorted by `_id` descending.
    latest: BTreeMap<String, Vec<usize>>,
    pub indexes: BTreeMap<String, Vec<String>>,
}

impl LocalDb {
    pub fn load(dir: &Path) -> Option<Self> {
        if !dir.join("orders.ndjson").exists() {
            return None;
        }
        let mut colls = BTreeMap::new();
        for name in ["restaurants", "users", "products", "customers", "orders", "legacy"] {
            let text = std::fs::read_to_string(dir.join(format!("{name}.ndjson"))).ok()?;
            let docs: Vec<Value> = text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect();
            colls.insert(name.to_string(), docs);
        }
        let latest = colls
            .iter()
            .map(|(k, v)| {
                let mut ix: Vec<usize> = (0..v.len()).collect();
                ix.sort_by(|a, b| id_key(&v[*b]).cmp(&id_key(&v[*a])));
                (k.clone(), ix)
            })
            .collect();
        let mut indexes = BTreeMap::new();
        indexes.insert("orders".to_string(), vec![r#"{"_id":1}"#.to_string(), r#"{"restaurant":1,"createdAt":-1}"#.to_string(), r#"{"status":1}"#.to_string()]);
        indexes.insert("customers".to_string(), vec![r#"{"_id":1}"#.to_string(), r#"{"restaurant":1}"#.to_string()]);
        Some(Self { colls, latest, indexes })
    }
}

fn id_key(d: &Value) -> String {
    d["_id"]["$oid"].as_str().map(str::to_string).unwrap_or_else(|| d["_id"].to_string())
}

impl DbPort for LocalDb {
    async fn list_collections(&self) -> Result<Vec<String>, DbError> {
        Ok(self.colls.keys().cloned().collect())
    }
    async fn sample(&self, c: &str, k: SampleKind) -> Result<Vec<Value>, DbError> {
        let docs = self.colls.get(c).ok_or_else(|| DbError::new(None, None, "no such collection"))?;
        Ok(match k {
            SampleKind::Random(n) => {
                // deterministic pseudo-random stride: same sample on every run, like a fixed seed
                let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
                let mut seen = std::collections::BTreeSet::new();
                while seen.len() < n.min(docs.len()) {
                    x ^= x << 13;
                    x ^= x >> 7;
                    x ^= x << 17;
                    seen.insert((x % docs.len() as u64) as usize);
                }
                seen.into_iter().map(|i| docs[i].clone()).collect()
            }
            SampleKind::Latest(n) => self.latest[c].iter().take(n).map(|i| docs[*i].clone()).collect(),
        })
    }
    async fn indexes(&self, c: &str) -> Result<Vec<String>, DbError> {
        Ok(self.indexes.get(c).cloned().unwrap_or_default())
    }
    async fn estimated_count(&self, c: &str) -> Result<u64, DbError> {
        Ok(self.colls.get(c).map_or(0, |v| v.len() as u64))
    }
    async fn explain_find(&self, _q: &ExplainFind) -> Result<PlanSummary, DbError> {
        Ok(PlanSummary { stages: vec!["FETCH".into(), "IXSCAN".into()], engine: "classic".into(), ..Default::default() })
    }
}

// ---- evaluator --------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum S {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Date(i64),
    Oid(String),
    Arr,
    Doc,
}

fn rank(s: &S) -> u8 {
    match s {
        S::Null => 0,
        S::Num(_) => 1,
        S::Str(_) => 2,
        S::Doc => 3,
        S::Arr => 4,
        S::Oid(_) => 5,
        S::Bool(_) => 6,
        S::Date(_) => 7,
    }
}

fn scalar(v: &Value) -> S {
    match v {
        Value::Null => S::Null,
        Value::Bool(b) => S::Bool(*b),
        Value::Number(n) => S::Num(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => S::Str(s.clone()),
        Value::Array(_) => S::Arr,
        Value::Object(m) => {
            if m.len() == 1 {
                let (k, c) = m.iter().next().unwrap();
                match (k.as_str(), c) {
                    ("$numberInt" | "$numberLong" | "$numberDouble" | "$numberDecimal", Value::String(s)) => return S::Num(s.parse().unwrap_or(f64::NAN)),
                    ("$oid", Value::String(s)) => return S::Oid(s.clone()),
                    ("$date", Value::Object(d)) => return S::Date(d.get("$numberLong").and_then(Value::as_str).and_then(|s| s.parse().ok()).unwrap_or(0)),
                    ("$date", Value::String(s)) => return S::Date(parse_iso_date(s).unwrap_or(0)),
                    ("$date", Value::Number(n)) => return S::Date(n.as_i64().unwrap_or(0)),
                    _ => {}
                }
            }
            S::Doc
        }
    }
}

fn cmp(a: &S, b: &S) -> Ordering {
    match (a, b) {
        (S::Num(x), S::Num(y)) => x.partial_cmp(y).unwrap_or(Ordering::Equal),
        (S::Str(x), S::Str(y)) => x.cmp(y),
        (S::Date(x), S::Date(y)) => x.cmp(y),
        (S::Oid(x), S::Oid(y)) => x.cmp(y),
        (S::Bool(x), S::Bool(y)) => x.cmp(y),
        _ => rank(a).cmp(&rank(b)),
    }
}

/// Values found at a dotted path, arrays traversed implicitly (and numeric segments index them).
fn at<'a>(v: &'a Value, segs: &[&str], out: &mut Vec<&'a Value>) {
    let Some((first, rest)) = segs.split_first() else {
        out.push(v);
        return;
    };
    match v {
        Value::Object(m) if scalar(v) == S::Doc => {
            if let Some(c) = m.get(*first) {
                at(c, rest, out);
            }
        }
        Value::Array(a) => {
            if let Ok(i) = first.parse::<usize>() {
                if let Some(c) = a.get(i) {
                    at(c, rest, out);
                }
            }
            for c in a {
                if c.is_object() {
                    at(c, segs, out);
                }
            }
        }
        _ => {}
    }
}

fn candidates<'a>(doc: &'a Value, path: &str) -> Vec<&'a Value> {
    let segs: Vec<&str> = path.split('.').collect();
    let mut out = Vec::new();
    at(doc, &segs, &mut out);
    out
}

/// A candidate matches a plain value when it equals it or (array) contains it.
fn value_eq(c: &Value, q: &Value) -> bool {
    if let Value::Array(a) = c {
        if !matches!(q, Value::Array(_)) {
            return a.iter().any(|x| value_eq(x, q));
        }
        return c == q;
    }
    let (sc, sq) = (scalar(c), scalar(q));
    match (&sc, &sq) {
        (S::Doc, S::Doc) | (S::Arr, S::Arr) => c == q,
        _ => sc == sq,
    }
}

fn is_regex(q: &Value) -> Option<(String, String)> {
    let m = q.as_object()?;
    let r = m.get("$regularExpression")?.as_object()?;
    Some((r.get("pattern")?.as_str()?.to_string(), r.get("options").and_then(Value::as_str).unwrap_or("").to_string()))
}

fn regex_match(text: &str, pattern: &str, options: &str) -> Result<bool, String> {
    let ci = options.contains('i');
    let (anchored, rest) = pattern.strip_prefix('^').map_or((false, pattern), |r| (true, r));
    let (end, body) = rest.strip_suffix('$').map_or((false, rest), |r| (true, r));
    let mut lit = String::new();
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => lit.push(chars.next().ok_or("dangling escape")?),
            '.' | '*' | '+' | '?' | '[' | ']' | '(' | ')' | '|' | '{' | '}' => return Err(format!("regex {pattern} is beyond the local evaluator")),
            c => lit.push(c),
        }
    }
    let (t, l) = if ci { (text.to_lowercase(), lit.to_lowercase()) } else { (text.to_string(), lit) };
    Ok(match (anchored, end) {
        (true, true) => t == l,
        (true, false) => t.starts_with(&l),
        (false, true) => t.ends_with(&l),
        (false, false) => t.contains(&l),
    })
}

fn type_matches(c: &Value, name: &Value) -> bool {
    let s = scalar(c);
    let want = match name {
        Value::String(n) => n.as_str(),
        _ => return false,
    };
    match want {
        "number" => matches!(s, S::Num(_)),
        "string" => matches!(s, S::Str(_)),
        "bool" => matches!(s, S::Bool(_)),
        "date" => matches!(s, S::Date(_)),
        "null" => s == S::Null,
        "array" => s == S::Arr,
        "object" => s == S::Doc,
        "objectId" => matches!(s, S::Oid(_)),
        "int" | "long" | "double" | "decimal" => matches!(c.get("$numberInt").or(c.get("$numberLong")).or(c.get("$numberDouble")).or(c.get("$numberDecimal")).map(|_| ()), Some(())) && (want == "int" && c.get("$numberInt").is_some() || want == "long" && c.get("$numberLong").is_some() || want == "double" && c.get("$numberDouble").is_some() || want == "decimal" && c.get("$numberDecimal").is_some()),
        _ => false,
    }
}

fn op_ok(cands: &[&Value], op: &str, arg: &Value, opts: &Value) -> Result<bool, String> {
    let any = |f: &dyn Fn(&Value) -> bool| cands.iter().any(|c| f(c) || matches!(c, Value::Array(a) if a.iter().any(|x| f(x))));
    let ordered = |f: fn(Ordering) -> bool| {
        let q = scalar(arg);
        any(&|c| {
            let s = scalar(c);
            rank(&s) == rank(&q) && f(cmp(&s, &q))
        })
    };
    Ok(match op {
        "$eq" => cands.iter().any(|c| value_eq(c, arg)) || (arg.is_null() && cands.is_empty()),
        "$ne" => !(cands.iter().any(|c| value_eq(c, arg)) || (arg.is_null() && cands.is_empty())),
        "$gt" => ordered(|o| o == Ordering::Greater),
        "$gte" => ordered(|o| o != Ordering::Less),
        "$lt" => ordered(|o| o == Ordering::Less),
        "$lte" => ordered(|o| o != Ordering::Greater),
        "$in" | "$nin" => {
            let items = arg.as_array().ok_or("$in needs an array")?;
            let mut hit = false;
            for it in items {
                hit |= if let Some((p, o)) = is_regex(it) {
                    let mut h = false;
                    for c in cands {
                        if let Value::String(s) = c {
                            h |= regex_match(s, &p, &o)?;
                        }
                    }
                    h
                } else {
                    cands.iter().any(|c| value_eq(c, it)) || (it.is_null() && cands.is_empty())
                };
            }
            if op == "$in" { hit } else { !hit }
        }
        "$exists" => {
            let want = !matches!(arg, Value::Bool(false)) && arg != &json!(0);
            want == !cands.is_empty()
        }
        "$type" => match arg {
            Value::Array(names) => names.iter().any(|n| any(&|c| type_matches(c, n))),
            n => any(&|c| type_matches(c, n)) && !cands.is_empty(),
        },
        "$size" => {
            let n = scalar(arg);
            cands.iter().any(|c| matches!(c, Value::Array(a) if S::Num(a.len() as f64) == n))
        }
        "$regex" | "$regularExpression" => {
            let (p, o) = if op == "$regex" { (arg.as_str().ok_or("regex pattern")?.to_string(), opts.as_str().unwrap_or("").to_string()) } else { is_regex(&json!({ "$regularExpression": arg })).ok_or("regex")? };
            let mut h = false;
            for c in cands {
                match c {
                    Value::String(s) => h |= regex_match(s, &p, &o)?,
                    Value::Array(a) => {
                        for x in a {
                            if let Value::String(s) = x {
                                h |= regex_match(s, &p, &o)?;
                            }
                        }
                    }
                    _ => {}
                }
            }
            h
        }
        "$not" => {
            let m = arg.as_object().ok_or("$not needs an operator object")?;
            let mut all = true;
            for (k, a) in m {
                all &= op_ok(cands, k, a, &Value::Null)?;
            }
            !all
        }
        "$elemMatch" => {
            let mut hit = false;
            for c in cands {
                if let Value::Array(items) = c {
                    for it in items {
                        hit |= if it.is_object() && !arg.as_object().is_some_and(|m| m.keys().all(|k| k.starts_with('$') && !matches!(k.as_str(), "$and" | "$or" | "$nor"))) { matches(it, arg)? } else { cond(&[it], arg)? };
                    }
                }
            }
            hit
        }
        other => return Err(format!("operator {other} is beyond the local evaluator")),
    })
}

/// One field condition: a plain value, a regex, or an operator document.
fn cond(cands: &[&Value], q: &Value) -> Result<bool, String> {
    if let Some((p, o)) = is_regex(q) {
        return op_ok(cands, "$regex", &Value::String(p), &Value::String(o));
    }
    if let Value::Object(m) = q {
        if scalar(q) == S::Doc && !m.is_empty() && m.keys().all(|k| k.starts_with('$')) {
            let opts = m.get("$options").cloned().unwrap_or(Value::Null);
            for (k, a) in m {
                if k == "$options" {
                    continue;
                }
                if !op_ok(cands, k, a, &opts)? {
                    return Ok(false);
                }
            }
            return Ok(true);
        }
    }
    op_ok(cands, "$eq", q, &Value::Null)
}

fn expr(doc: &Value, e: &Value) -> Result<bool, String> {
    // only the form {$gt: [{$size: "$path"}, N]} (and $gte/$lt/$lte/$eq)
    let m = e.as_object().filter(|m| m.len() == 1).ok_or("$expr form is beyond the local evaluator")?;
    let (op, args) = m.iter().next().unwrap();
    let a = args.as_array().filter(|a| a.len() == 2).ok_or("$expr form is beyond the local evaluator")?;
    let size = a[0].get("$size").and_then(Value::as_str).and_then(|p| p.strip_prefix('$')).ok_or("$expr form is beyond the local evaluator")?;
    let len = candidates(doc, size).iter().find_map(|c| c.as_array().map(Vec::len)).map(|n| n as f64);
    let Some(len) = len else { return Ok(false) };
    let S::Num(n) = scalar(&a[1]) else { return Err("$expr number expected".into()) };
    Ok(match op.as_str() {
        "$gt" => len > n,
        "$gte" => len >= n,
        "$lt" => len < n,
        "$lte" => len <= n,
        "$eq" => len == n,
        _ => return Err("$expr operator is beyond the local evaluator".into()),
    })
}

pub fn matches(doc: &Value, filter: &Value) -> Result<bool, String> {
    let Some(m) = filter.as_object() else { return Err("filter is not a document".into()) };
    for (k, q) in m {
        let ok = match k.as_str() {
            "$and" | "$or" | "$nor" => {
                let items = q.as_array().ok_or("$and/$or needs an array")?;
                let mut rs = Vec::new();
                for it in items {
                    rs.push(matches(doc, it)?);
                }
                match k.as_str() {
                    "$and" => rs.iter().all(|x| *x),
                    "$or" => rs.iter().any(|x| *x),
                    _ => !rs.iter().any(|x| *x),
                }
            }
            "$expr" => expr(doc, q)?,
            k if k.starts_with('$') => return Err(format!("operator {k} is beyond the local evaluator")),
            path => cond(&candidates(doc, path), q)?,
        };
        if !ok {
            return Ok(false);
        }
    }
    Ok(true)
}

fn sort_key(doc: &Value, path: &str) -> S {
    let c = candidates(doc, path);
    c.first().map_or(S::Null, |v| scalar(v))
}

fn project(doc: &Value, proj: &Value) -> Value {
    let Some(p) = proj.as_object() else { return doc.clone() };
    let truthy = |v: &Value| !matches!(v, Value::Bool(false)) && v != &json!(0) && v != &json!({"$numberInt": "0"});
    let mut out = serde_json::Map::new();
    if p.get("_id").is_none_or(truthy) {
        if let Some(id) = doc.get("_id") {
            out.insert("_id".into(), id.clone());
        }
    }
    for (k, v) in p {
        if k != "_id" && truthy(v) {
            let c = candidates(doc, k);
            out.insert(k.clone(), c.first().map_or(Value::Null, |x| (*x).clone()));
        }
    }
    Value::Object(out)
}

fn parse(text: &str, now_ms: i64) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    parse_document(text, &ParseOptions { now_ms: Some(now_ms) }).map_err(|e| e.to_string())
}

/// `find` over the in-memory collection. `filter`, `sort` and `projection` are mongosh/EJSON texts.
pub fn find(db: &LocalDb, coll: &str, filter: &str, projection: Option<&str>, sort: Option<&str>, limit: Option<i64>, now_ms: i64) -> Result<Vec<Value>, String> {
    let docs = db.colls.get(coll).ok_or("no such collection")?;
    let f = parse(filter, now_ms)?;
    let mut hits: Vec<&Value> = Vec::new();
    for d in docs {
        if matches(d, &f)? {
            hits.push(d);
        }
    }
    if let Some(s) = sort.filter(|s| !s.trim().is_empty()) {
        let keys: Vec<(String, bool)> = parse(s, now_ms)?.as_object().ok_or("sort")?.iter().map(|(k, v)| (k.clone(), scalar(v) == S::Num(-1.0))).collect();
        hits.sort_by(|a, b| {
            for (k, desc) in &keys {
                let o = cmp(&sort_key(a, k), &sort_key(b, k));
                if o != Ordering::Equal {
                    return if *desc { o.reverse() } else { o };
                }
            }
            Ordering::Equal
        });
    }
    if let Some(l) = limit {
        hits.truncate(l.max(0) as usize);
    }
    let proj = projection.filter(|p| !p.trim().is_empty()).map(|p| parse(p, now_ms)).transpose()?;
    Ok(hits.into_iter().map(|d| proj.as_ref().map_or_else(|| d.clone(), |p| project(d, p))).collect())
}
