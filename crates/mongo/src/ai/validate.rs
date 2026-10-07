//! The Rust validator (the real guard): runs on every attempt. Strict parse, recursive walk of the whole tree at every
//! depth (never a regex on text), stage allow-list and deny-list, typed-literal check, path check against the digest,
//! injected limits, tenant rule.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::privacy::{fold, is_credential_name};
use super::reply::GenReply;
use crate::digest::Digest;
use crate::shell::{self, ParseOptions};
use crate::types::MAX_DOCS;

pub const MAX_QUERY_BYTES: usize = 64 * 1024;
pub const MAX_QUERY_DEPTH: usize = 32;

/// Rejected anywhere in the tree, as an operator key at any depth (also inside `$literal`: conservative on purpose).
pub const DENY: &[&str] = &[
    "$where", "$function", "$accumulator", "$out", "$merge", "$eval", "mapReduce", "$mapReduce", "$currentOp", "$listSessions", "$listLocalSessions", "$planCacheStats", "$changeStream", "$changeStreamSplitLargeEvent", "$collStats",
    "$indexStats", "$listSearchIndexes", "$listSampledQueries", "$queryStats",
];

pub const STAGE_ALLOW: &[&str] = &[
    "$match", "$project", "$group", "$sort", "$limit", "$skip", "$unwind", "$lookup", "$addFields", "$set", "$unset", "$count", "$facet", "$bucket", "$bucketAuto", "$sortByCount", "$replaceRoot", "$replaceWith", "$sample", "$geoNear",
    "$setWindowFields", "$densify", "$unionWith", "$graphLookup",
];

pub fn walk_deny(v: &Value, errs: &mut Vec<String>) {
    match v {
        Value::Object(m) => {
            for (k, c) in m {
                if DENY.contains(&k.as_str()) {
                    errs.push(format!("operator {k} is not allowed"));
                }
                walk_deny(c, errs);
            }
        }
        Value::Array(a) => a.iter().for_each(|c| walk_deny(c, errs)),
        _ => {}
    }
}

pub fn depth(v: &Value) -> usize {
    match v {
        Value::Object(m) => 1 + m.values().map(depth).max().unwrap_or(0),
        Value::Array(a) => 1 + a.iter().map(depth).max().unwrap_or(0),
        _ => 0,
    }
}

pub struct ValidateCtx<'a> {
    pub known_collections: &'a [String],
    pub digest: Option<&'a Digest>,
    pub now_ms: i64,
    pub tenant_field: Option<&'a str>,
    pub tenant_lock: bool,
    /// Index key texts per collection (the `Digest::indexes` strings), for the `$lookup` foreign-index warning.
    pub indexes: Option<&'a BTreeMap<String, Vec<String>>>,
}

impl<'a> ValidateCtx<'a> {
    pub fn new(known: &'a [String], digest: Option<&'a Digest>, now_ms: i64) -> Self {
        Self { known_collections: known, digest, now_ms, tenant_field: None, tenant_lock: false, indexes: None }
    }
}

#[derive(Debug, Clone)]
pub struct ValidatedFind {
    pub collection: String,
    pub filter: Value,
    pub projection: Option<Value>,
    pub sort: Option<Value>,
    pub skip: Option<u64>,
    pub limit: i64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ValidatedPipeline {
    pub collection: String,
    pub stages: Vec<Value>,
    pub limit_appended: bool,
    pub warnings: Vec<String>,
}

fn is_wrapper(v: &Value, key: &str) -> bool {
    v.as_object().is_some_and(|m| m.len() == 1 && m.contains_key(key))
}

fn filter_fields<'a>(f: &'a Value, out: &mut Vec<(&'a str, &'a Value)>) {
    if let Value::Object(m) = f {
        for (k, v) in m {
            match k.as_str() {
                "$and" | "$or" | "$nor" => {
                    if let Value::Array(a) = v {
                        a.iter().for_each(|c| filter_fields(c, out));
                    }
                }
                k if k.starts_with('$') => {}
                _ => out.push((k, v)),
            }
        }
    }
}

fn operands(v: &Value) -> Vec<&Value> {
    match v {
        Value::Object(m) if m.keys().next().is_some_and(|k| k.starts_with('$')) && !m.keys().any(|k| k.starts_with("$oid") || k.starts_with("$date") || k.starts_with("$number") || k.starts_with("$regularExpression")) => m
            .iter()
            .filter(|(k, _)| matches!(k.as_str(), "$eq" | "$ne" | "$gt" | "$gte" | "$lt" | "$lte"))
            .map(|(_, v)| v)
            .chain(m.iter().filter(|(k, _)| matches!(k.as_str(), "$in" | "$nin")).filter_map(|(_, v)| v.as_array()).flatten())
            .collect(),
        other => vec![other],
    }
}

fn shell_int(v: &Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    let o = v.as_object()?;
    ["$numberInt", "$numberLong", "$numberDouble"].iter().find_map(|k| o.get(*k)).and_then(Value::as_str).and_then(|s| s.parse::<f64>().ok()).map(|f| f as i64)
}

fn has_offset(tail: &str) -> bool {
    if tail.ends_with(['Z', 'z']) {
        return true;
    }
    match tail.rfind(['+', '-']) {
        Some(k) => {
            let rest: String = tail[k + 1..].chars().filter(|c| *c != ':').collect();
            matches!(rest.len(), 2 | 4) && rest.bytes().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

/// `{"$date": "..."}` strings need a time and an explicit offset (Z or +hh:mm): a bare date is a timezone guess.
fn check_dates(v: &Value, errs: &mut Vec<String>) {
    match v {
        Value::Object(m) => {
            if m.len() == 1 {
                if let Some(Value::String(s)) = m.get("$date") {
                    let b = s.as_bytes();
                    let has_time = b.len() > 10 && matches!(b[10], b'T' | b't' | b' ');
                    let has_off = has_time && has_offset(&s[10..]);
                    if !has_time || !has_off {
                        errs.push(format!("date \"{s}\" needs a time and an explicit offset, for example 2026-09-30T22:00:00Z"));
                    }
                }
            }
            m.values().for_each(|c| check_dates(c, errs));
        }
        Value::Array(a) => a.iter().for_each(|c| check_dates(c, errs)),
        _ => {}
    }
}

fn lev(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            cur.push((prev[j] + usize::from(ca != cb)).min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[b.len()]
}

fn nearest<'d>(d: &'d Digest, path: &str) -> Option<&'d str> {
    // never suggest a credential-like field: the hint goes back to the model, which must not learn that it exists
    d.fields.iter().map(|f| f.path.as_str()).filter(|p| !p.split('.').any(is_credential_name)).map(|p| (lev(&fold(path), &fold(p)), p)).filter(|(n, _)| *n <= path.len() / 2 + 1).min_by_key(|(n, _)| *n).map(|(_, p)| p)
}

/// Path against the digest. Returns false when the root is unknown.
fn check_path(d: &Digest, path: &str, what: &str, errs: &mut Vec<String>, warnings: &mut Vec<String>, root_is_error: bool) -> bool {
    if path.split('.').any(is_credential_name) {
        errs.push(format!("{what}: field \"{path}\" is excluded from AI queries"));
        return false;
    }
    let roots = d.roots();
    let root = path.split('.').next().unwrap_or("");
    if root == "_id" {
        return true;
    }
    if !roots.contains(root) {
        let hint = nearest(d, root).map_or(String::new(), |n| format!("; did you mean \"{n}\"?"));
        let msg = format!("{what}: unknown field \"{path}\"{hint}");
        if root_is_error {
            errs.push(msg);
        } else {
            warnings.push(msg);
        }
        return false;
    }
    let known = d.field(path).is_some() || d.fields.iter().any(|f| f.path.starts_with(&format!("{path}.")));
    // the digest depth cap is 4: deeper paths are not judged
    if !known && path.split('.').count() <= 4 && !d.fields.iter().any(|f| f.path.split('.').count() >= 4 && f.path.starts_with(&format!("{root}."))) {
        let hint = nearest(d, path).map_or(String::new(), |n| format!("; nearest in the sample: \"{n}\""));
        warnings.push(format!("{what}: path \"{path}\" was not seen in the sample{hint}"));
    }
    true
}

fn check_filter_types(d: &Digest, f: &Value, what: &str, errs: &mut Vec<String>, warnings: &mut Vec<String>) {
    let mut fields = Vec::new();
    filter_fields(f, &mut fields);
    for (path, val) in fields {
        if !check_path(d, path, what, errs, warnings, true) {
            continue;
        }
        if let Some((dom, share)) = d.field(path).and_then(|s| s.dominant()) {
            if share >= 0.9 && matches!(dom, "ObjectId" | "Date") {
                for o in operands(val) {
                    if o.is_string() {
                        errs.push(format!("{what}: {path} is {dom} but compared with a plain string; use {} instead", if dom == "Date" { "{\"$date\":\"...Z\"}" } else { "{\"$oid\":\"...\"}" }));
                        break;
                    }
                }
            }
            if dom == "string" && operands(val).iter().any(|o| is_wrapper(o, "$oid") || is_wrapper(o, "$date")) {
                warnings.push(format!("{path} is stored as string but compared with a typed value"));
            }
        }
    }
}

fn check_sort(d: Option<&Digest>, sort: &Value, errs: &mut Vec<String>, warnings: &mut Vec<String>) {
    let Value::Object(m) = sort else { return };
    for (k, v) in m {
        let meta = v.as_object().is_some_and(|o| o.len() == 1 && o.contains_key("$meta"));
        if !meta && !matches!(shell_int(v), Some(1) | Some(-1)) {
            errs.push(format!("sort: direction of {k} must be 1 or -1"));
        }
        let Some(d) = d else { continue };
        check_path(d, k, "sort", errs, warnings, false);
        let Some(f) = d.field(k) else { continue };
        let kinds: Vec<&str> = f.types.keys().map(String::as_str).filter(|t| *t != "null").collect();
        if kinds.len() > 1 && !kinds.iter().all(|t| matches!(*t, "int" | "long" | "double" | "Decimal128")) {
            warnings.push(format!("sort on {k}: mixed types ({}) sort by BSON type order (strings rank above numbers); filter with {{{k}: {{$type: 'number'}}}} first", kinds.join("|")));
        }
    }
}

fn tenant_check(ctx: &ValidateCtx, filter: &Value, errs: &mut Vec<String>, warnings: &mut Vec<String>) {
    let Some(t) = ctx.tenant_field else { return };
    // With the lock the run path demands the constraint on every collection, so the draft must carry it too.
    if !ctx.tenant_lock && !ctx.digest.is_some_and(|d| d.field(t).is_some()) {
        return;
    }
    if !crate::validate::constrains_tenant(filter, t) {
        let msg = format!("the collection is tenant-scoped by \"{t}\": the filter must set it to a value (equals, or in a short list)");
        if ctx.tenant_lock {
            errs.push(msg);
        } else {
            warnings.push(msg);
        }
    }
}

/// Validate the AI's find draft. Returns every problem found (the repair loop feeds them back, value-free).
pub fn validate_find_ctx(r: &GenReply, ctx: &ValidateCtx) -> Result<ValidatedFind, Vec<String>> {
    let mut errs = Vec::new();
    let mut warnings = Vec::new();
    if r.mode != "find" {
        errs.push(format!("mode \"{}\" is not supported (find only)", r.mode));
    }
    if !ctx.known_collections.iter().any(|c| *c == r.collection) {
        errs.push(format!("unknown collection \"{}\"", r.collection));
    }
    let total = r.filter.len() + r.projection.as_ref().map_or(0, String::len) + r.sort.as_ref().map_or(0, String::len);
    if total > MAX_QUERY_BYTES {
        errs.push(format!("query text is larger than {} KB", MAX_QUERY_BYTES / 1024));
        return Err(errs);
    }
    let po = ParseOptions { now_ms: Some(ctx.now_ms) };
    let mut doc = |name: &str, t: &str| match shell::parse_document(t, &po) {
        Ok(v) => Some(v),
        Err(e) => {
            errs.push(format!("{name}: {e}"));
            None
        }
    };
    let filter = doc("filter", &r.filter);
    let projection = r.projection.as_deref().filter(|s| !s.trim().is_empty()).and_then(|t| doc("projection", t));
    let sort = r.sort.as_deref().filter(|s| !s.trim().is_empty()).and_then(|t| doc("sort", t));
    for (name, v) in [("filter", &filter), ("projection", &projection), ("sort", &sort)] {
        if let Some(v) = v {
            let mut e = Vec::new();
            walk_deny(v, &mut e);
            if depth(v) > MAX_QUERY_DEPTH {
                e.push(format!("nesting deeper than {MAX_QUERY_DEPTH}"));
            }
            check_dates(v, &mut e);
            e.sort();
            e.dedup();
            errs.extend(e.into_iter().map(|m| format!("{name}: {m}")));
        }
    }
    if let Some(s) = &sort {
        check_sort(ctx.digest, s, &mut errs, &mut warnings);
    }
    if let (Some(f), Some(d)) = (&filter, ctx.digest) {
        check_filter_types(d, f, "filter", &mut errs, &mut warnings);
    }
    if let (Some(Value::Object(p)), Some(d)) = (&projection, ctx.digest) {
        for k in p.keys() {
            check_path(d, k, "projection", &mut errs, &mut warnings, false);
        }
    }
    if let Some(f) = &filter {
        tenant_check(ctx, f, &mut errs, &mut warnings);
    }
    let limit = r.limit.unwrap_or(50).clamp(1, MAX_DOCS as i64);
    if let Some(l) = r.limit {
        if l < 1 || l > MAX_DOCS as i64 {
            warnings.push(format!("limit {l} clamped to {limit}"));
        }
    }
    let skip = r.skip.filter(|s| *s > 0).map(|s| s as u64);
    if errs.is_empty() {
        Ok(ValidatedFind { collection: r.collection.clone(), filter: filter.unwrap_or_else(|| json!({})), projection, sort, skip, limit, warnings })
    } else {
        Err(errs)
    }
}

/// M0-compatible signature.
pub fn validate_find(r: &GenReply, known_collections: &[String], digest: Option<&Digest>, now_ms: i64) -> Result<ValidatedFind, Vec<String>> {
    validate_find_ctx(r, &ValidateCtx::new(known_collections, digest, now_ms))
}

// ---- pipelines (shared stage rules; AI aggregation itself is M2) ----------------------------------------------------

fn validate_stages(stages: &Value, ctx: &ValidateCtx, level: usize, errs: &mut Vec<String>, warnings: &mut Vec<String>) {
    let Some(arr) = stages.as_array() else {
        errs.push("a pipeline must be an array of stages".into());
        return;
    };
    if level > 4 {
        errs.push("sub-pipelines are nested too deeply".into());
        return;
    }
    let mut leading = true;
    for (i, st) in arr.iter().enumerate() {
        let Some(m) = st.as_object().filter(|m| m.len() == 1) else {
            errs.push(format!("stage {i}: each stage must be an object with exactly one operator"));
            continue;
        };
        let (op, body) = m.iter().next().unwrap();
        if DENY.contains(&op.as_str()) {
            errs.push(format!("stage {i}: operator {op} is not allowed"));
            continue;
        }
        if !STAGE_ALLOW.contains(&op.as_str()) {
            errs.push(format!("stage {i}: {op} is not an allowed stage"));
            continue;
        }
        let mut e = Vec::new();
        walk_deny(body, &mut e);
        errs.extend(e.into_iter().map(|m| format!("stage {i} ({op}): {m}")));
        match op.as_str() {
            "$match" => {
                if leading {
                    if let Some(d) = ctx.digest {
                        let mut e2 = Vec::new();
                        check_filter_types(d, body, "$match", &mut e2, warnings);
                        errs.extend(e2);
                    }
                }
            }
            "$sort" if leading => {
                check_sort(ctx.digest, body, errs, warnings);
            }
            "$limit" | "$skip" | "$sample" => {}
            "$lookup" | "$graphLookup" => {
                match body.get("from") {
                    Some(Value::String(c)) if ctx.known_collections.iter().any(|k| k == c) => {
                        if op == "$lookup" {
                            if let (Some(Value::String(ff)), Some(ix)) = (body.get("foreignField"), ctx.indexes.and_then(|m| m.get(c))) {
                                if !ix.iter().any(|t| t.contains(&format!("\"{ff}\"")) || ff == "_id") {
                                    warnings.push(format!("$lookup into {c} on {ff}: no index on the foreign field"));
                                }
                            }
                        }
                    }
                    Some(Value::String(c)) => errs.push(format!("stage {i} ({op}): unknown collection \"{c}\"")),
                    Some(_) => errs.push(format!("stage {i} ({op}): \"from\" must be a collection name of this database")),
                    None => errs.push(format!("stage {i} ({op}): missing \"from\"")),
                }
                if let Some(p) = body.get("pipeline") {
                    validate_stages(p, ctx, level + 1, errs, warnings);
                }
            }
            "$unionWith" => match body {
                Value::String(c) if ctx.known_collections.iter().any(|k| k == c) => {}
                Value::Object(o) => {
                    match o.get("coll") {
                        Some(Value::String(c)) if ctx.known_collections.iter().any(|k| k == c) => {}
                        _ => errs.push(format!("stage {i} ($unionWith): \"coll\" must be a known collection of this database")),
                    }
                    if let Some(p) = o.get("pipeline") {
                        validate_stages(p, ctx, level + 1, errs, warnings);
                    }
                }
                _ => errs.push(format!("stage {i} ($unionWith): unknown collection or bad form")),
            },
            "$facet" => match body {
                Value::Object(o) => o.values().for_each(|p| validate_stages(p, ctx, level + 1, errs, warnings)),
                _ => errs.push(format!("stage {i} ($facet): expected an object of pipelines")),
            },
            _ => {}
        }
        if !matches!(op.as_str(), "$match" | "$sort" | "$limit" | "$skip" | "$sample") {
            leading = false;
        }
    }
}

pub fn validate_pipeline(collection: &str, pipeline_text: &str, ctx: &ValidateCtx) -> Result<ValidatedPipeline, Vec<String>> {
    let mut errs = Vec::new();
    let mut warnings = Vec::new();
    if !ctx.known_collections.iter().any(|c| c == collection) {
        errs.push(format!("unknown collection \"{collection}\""));
    }
    if pipeline_text.len() > MAX_QUERY_BYTES {
        errs.push(format!("pipeline text is larger than {} KB", MAX_QUERY_BYTES / 1024));
        return Err(errs);
    }
    let v = match shell::parse_with(pipeline_text, &ParseOptions { now_ms: Some(ctx.now_ms) }) {
        Ok(v) => v,
        Err(e) => {
            errs.push(format!("pipeline: {e}"));
            return Err(errs);
        }
    };
    if depth(&v) > MAX_QUERY_DEPTH {
        errs.push(format!("nesting deeper than {MAX_QUERY_DEPTH}"));
    }
    check_dates(&v, &mut errs);
    validate_stages(&v, ctx, 0, &mut errs, &mut warnings);
    if let (Some(t), true) = (ctx.tenant_field, ctx.tenant_lock) {
        errs.extend(crate::validate::tenant_pipeline_problem(&v, t));
    }
    let mut stages = v.as_array().cloned().unwrap_or_default();
    let last = stages.last().and_then(|s| s.as_object()).and_then(|m| m.keys().next().cloned()).unwrap_or_default();
    let limit_appended = !matches!(last.as_str(), "$group" | "$count" | "$limit");
    if limit_appended {
        stages.push(json!({ "$limit": shell::int32(MAX_DOCS as i32) }));
    }
    errs.sort();
    errs.dedup();
    if errs.is_empty() {
        Ok(ValidatedPipeline { collection: collection.to_string(), stages, limit_appended, warnings })
    } else {
        Err(errs)
    }
}
