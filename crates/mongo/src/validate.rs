//! The shared aggregation rules (plan 2.3): a stage allow-list with recursive sub-pipelines. The deny-list of
//! operators anywhere in the tree (`$out`, `$merge`, `$function`, `$where`, ...) lives in [`crate::ai::walk_deny`] and
//! runs first; this adds "only known read stages", no cross-database `$lookup`, and the optional tenant lock.

use serde_json::Value;

pub const STAGE_ALLOW: &[&str] = &[
    "$match", "$project", "$group", "$sort", "$limit", "$skip", "$unwind", "$lookup", "$addFields", "$set", "$unset", "$count", "$facet", "$bucket", "$bucketAuto", "$sortByCount",
    "$replaceRoot", "$replaceWith", "$sample", "$geoNear", "$setWindowFields", "$densify", "$unionWith", "$graphLookup",
];
const MAX_STAGES: usize = 100;
const MAX_NESTING: usize = 8;

/// Every problem found in a pipeline value (already deny-list clean).
pub fn validate_pipeline(v: &Value) -> Result<(), Vec<String>> {
    let mut errs = Vec::new();
    walk(v, 0, &mut errs);
    if errs.is_empty() {
        Ok(())
    } else {
        Err(errs)
    }
}

fn walk(v: &Value, depth: usize, errs: &mut Vec<String>) {
    let Value::Array(stages) = v else {
        errs.push("a pipeline is an array of stages".into());
        return;
    };
    if depth > MAX_NESTING {
        errs.push("sub-pipelines are nested too deeply".into());
        return;
    }
    if stages.len() > MAX_STAGES {
        errs.push(format!("a pipeline has at most {MAX_STAGES} stages"));
    }
    for s in stages {
        let Some(m) = s.as_object().filter(|m| m.len() == 1) else {
            errs.push("each stage is an object with exactly one operator".into());
            continue;
        };
        let (op, body) = m.iter().next().expect("one entry");
        if !STAGE_ALLOW.contains(&op.as_str()) {
            errs.push(format!("stage {op} is not allowed"));
            continue;
        }
        match op.as_str() {
            "$lookup" => {
                if body.get("from").is_some_and(|f| !f.is_string()) {
                    errs.push("$lookup: `from` must be a collection name of this database".into());
                }
                if let Some(p) = body.get("pipeline") {
                    walk(p, depth + 1, errs);
                }
            }
            "$graphLookup" if body.get("from").is_some_and(|f| !f.is_string()) => {
                errs.push("$graphLookup: `from` must be a collection name of this database".into());
            }
            "$facet" => match body.as_object() {
                Some(o) => o.values().for_each(|p| walk(p, depth + 1, errs)),
                None => errs.push("$facet takes an object of pipelines".into()),
            },
            "$unionWith" => match body {
                Value::String(_) => {}
                Value::Object(o) => {
                    if o.get("coll").is_some_and(|c| !c.is_string()) {
                        errs.push("$unionWith: `coll` must be a collection name of this database".into());
                    }
                    if let Some(p) = o.get("pipeline") {
                        walk(p, depth + 1, errs);
                    }
                }
                _ => errs.push("$unionWith takes a collection name or {coll, pipeline}".into()),
            },
            _ => {}
        }
    }
}

/// Collections the pipeline reads besides its own (`$lookup`, `$graphLookup`, `$unionWith`), at any depth.
pub fn foreign_collections(v: &Value) -> Vec<String> {
    fn go(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::Array(a) => a.iter().for_each(|c| go(c, out)),
            Value::Object(m) if m.len() == 1 => {
                let (op, body) = m.iter().next().expect("one entry");
                match (op.as_str(), body) {
                    ("$lookup" | "$graphLookup", Value::Object(o)) => {
                        if let Some(Value::String(f)) = o.get("from") {
                            out.push(f.clone());
                        }
                        if let Some(p) = o.get("pipeline") {
                            go(p, out);
                        }
                    }
                    ("$unionWith", Value::String(s)) => out.push(s.clone()),
                    ("$unionWith", Value::Object(o)) => {
                        if let Some(Value::String(f)) = o.get("coll") {
                            out.push(f.clone());
                        }
                        if let Some(p) = o.get("pipeline") {
                            go(p, out);
                        }
                    }
                    ("$facet", Value::Object(o)) => o.values().for_each(|p| go(p, out)),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    go(v, &mut out);
    out.sort();
    out.dedup();
    out
}

/// Most values an `$in` may list when it carries the tenant lock.
const MAX_TENANT_IN: usize = 20;

/// A concrete scalar: string, boolean, number or a typed wrapper (`$oid`, `$date`, `$numberLong`, ...). Never null,
/// an array, a regex or a sub-document.
fn tenant_literal(v: &Value) -> bool {
    match v {
        Value::String(_) | Value::Bool(_) | Value::Number(_) => true,
        Value::Object(m) if m.len() == 1 => m.keys().next().is_some_and(|k| matches!(k.as_str(), "$oid" | "$date" | "$numberInt" | "$numberLong" | "$numberDouble" | "$numberDecimal" | "$uuid")),
        _ => false,
    }
}

/// `field: <literal>`, `{$eq: <literal>}` or `{$in: [<up to 20 literals>]}` (other operators may sit beside it, they only
/// narrow). Never `$ne`, `$nin`, `$exists`, `$regex`, `$not`, `null` or a bare operator-less sub-document.
fn tenant_value_constrains(v: &Value) -> bool {
    if tenant_literal(v) {
        return true;
    }
    let Value::Object(m) = v else { return false };
    if m.is_empty() || !m.keys().all(|k| k.starts_with('$')) {
        return false;
    }
    m.iter().any(|(k, x)| match k.as_str() {
        "$eq" => tenant_literal(x),
        "$in" => x.as_array().is_some_and(|a| !a.is_empty() && a.len() <= MAX_TENANT_IN && a.iter().all(tenant_literal)),
        _ => false,
    })
}

/// The tenant lock on a filter: some conjunct must be an equality-like constraint on `field` (see
/// [`tenant_value_constrains`]), at the top level, in a top-level `$and`, or in a `$or` whose every branch has one.
/// Shared by the run path and the AI validator.
pub fn constrains_tenant(filter: &Value, field: &str) -> bool {
    let Value::Object(m) = filter else { return false };
    if m.get(field).is_some_and(tenant_value_constrains) {
        return true;
    }
    let clauses = |k: &str, every: bool| {
        m.get(k).and_then(Value::as_array).is_some_and(|a| !a.is_empty() && if every { a.iter().all(|c| constrains_tenant(c, field)) } else { a.iter().any(|c| constrains_tenant(c, field)) })
    };
    clauses("$and", false) || clauses("$or", true)
}

/// The tenant lock on a pipeline: the first stage is a constrained `$match`, and every `$lookup`, `$unionWith` and
/// `$graphLookup` at any depth reads its other collection through a sub-pipeline (or `restrictSearchWithMatch`) that is
/// itself constrained, so a join cannot pull in another tenant's documents. Returns the first problem.
pub fn tenant_pipeline_problem(pipeline: &Value, field: &str) -> Option<String> {
    let Value::Array(stages) = pipeline else { return Some("a pipeline is an array of stages".into()) };
    let first_ok = stages.first().and_then(|s| s.get("$match")).is_some_and(|m| constrains_tenant(m, field));
    if !first_ok {
        return Some(format!("tenant lock: the pipeline must start with a $match that constrains `{field}`"));
    }
    scan_tenant_subs(stages, field, 0)
}

fn sub_starts_tenant(p: Option<&Value>, field: &str) -> bool {
    p.and_then(Value::as_array).and_then(|a| a.first()).and_then(|s| s.get("$match")).is_some_and(|m| constrains_tenant(m, field))
}

fn scan_tenant_subs(stages: &[Value], field: &str, depth: usize) -> Option<String> {
    if depth > MAX_NESTING {
        return Some("sub-pipelines are nested too deeply".into());
    }
    for s in stages {
        let Some((op, body)) = s.as_object().and_then(|m| m.iter().next()) else { continue };
        match op.as_str() {
            "$lookup" | "$unionWith" => {
                if !sub_starts_tenant(body.get("pipeline"), field) {
                    return Some(format!("tenant lock: {op} must read through a sub-pipeline that starts with a $match constraining `{field}`"));
                }
                if let Some(m) = body.get("pipeline").and_then(Value::as_array).and_then(|p| scan_tenant_subs(p, field, depth + 1)) {
                    return Some(m);
                }
            }
            "$graphLookup" if !body.get("restrictSearchWithMatch").is_some_and(|m| constrains_tenant(m, field)) => {
                return Some(format!("tenant lock: $graphLookup needs restrictSearchWithMatch constraining `{field}`"));
            }
            "$facet" => {
                for p in body.as_object().into_iter().flat_map(|o| o.values()).filter_map(Value::as_array) {
                    if let Some(m) = scan_tenant_subs(p, field, depth + 1) {
                        return Some(m);
                    }
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_known_read_stages_pass_at_every_depth() {
        assert!(validate_pipeline(&json!([{"$match": {"a": 1}}, {"$group": {"_id": "$a", "n": {"$sum": 1}}}, {"$sort": {"n": -1}}])).is_ok());
        for bad in [
            json!([{"$collStats": {}}]),
            json!([{"$indexStats": {}}]),
            json!([{"$out": "x"}]),
            json!([{"$match": {}}, {"$project": {"a": 1}, "$limit": 3}]),
            json!([{"$lookup": {"from": {"db": "other", "coll": "x"}, "localField": "a", "foreignField": "b", "as": "c"}}]),
            json!([{"$facet": {"a": [{"$merge": {"into": "x"}}]}}]),
            json!([{"$lookup": {"from": "x", "pipeline": [{"$currentOp": {}}], "as": "c"}}]),
            json!([{"$unionWith": {"coll": "x", "pipeline": [{"$listSessions": {}}]}}]),
            json!({"$match": {}}),
            json!([5]),
        ] {
            assert!(validate_pipeline(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn foreign_collections_are_found_in_sub_pipelines() {
        let p = json!([{"$lookup": {"from": "users", "pipeline": [{"$unionWith": "logs"}], "as": "u"}}, {"$facet": {"a": [{"$lookup": {"from": "shops", "localField": "s", "foreignField": "_id", "as": "x"}}]}}, {"$graphLookup": {"from": "tree"}}]);
        assert_eq!(foreign_collections(&p), vec!["logs", "shops", "tree", "users"]);
    }

    #[test]
    fn the_tenant_lock_needs_an_equality_on_the_field() {
        let f = "restaurant";
        for ok in [
            json!({"restaurant": {"$oid": "65f0c0ffee0000000000abcd"}, "a": 1}),
            json!({"restaurant": "A"}),
            json!({"restaurant": {"$eq": "A"}}),
            json!({"restaurant": {"$in": ["A", "B"]}}),
            json!({"$and": [{"x": 1}, {"restaurant": 2}]}),
            json!({"$or": [{"restaurant": "A"}, {"restaurant": "B"}]}),
        ] {
            assert!(constrains_tenant(&ok, f), "{ok}");
        }
        for bad in [
            json!({"a": 1}),
            json!({}),
            json!({"restaurant": {"$ne": "ZZZ"}}),
            json!({"restaurant": {"$exists": true}}),
            json!({"restaurant": {"$in": []}}),
            json!({"restaurant": {"$regex": ".*"}}),
            json!({"restaurant": {"$regularExpression": {"pattern": ".*", "options": ""}}}),
            json!({"restaurant": {"$nin": ["A"]}}),
            json!({"restaurant": {"$not": {"$eq": "A"}}}),
            json!({"restaurant": null}),
            json!({"restaurant": ["A"]}),
            json!({"restaurant": {"x": 1}}),
            json!({"$and": [{"restaurant": {"$ne": "A"}}]}),
            json!({"$or": [{"restaurant": "A"}, {"x": 2}]}),
            json!({"$nor": [{"restaurant": "A"}]}),
            json!({"restaurant": {"$in": (0..21).map(|i| json!(i)).collect::<Vec<_>>()}}),
        ] {
            assert!(!constrains_tenant(&bad, f), "{bad}");
        }
    }

    #[test]
    fn the_tenant_lock_covers_joins_in_a_pipeline() {
        let f = "restaurant";
        let m = json!({"$match": {"restaurant": "A"}});
        assert!(tenant_pipeline_problem(&json!([m.clone(), {"$group": {"_id": "$s"}}]), f).is_none());
        assert!(tenant_pipeline_problem(&json!([{"$group": {"_id": "$s"}}]), f).is_some());
        assert!(tenant_pipeline_problem(&json!([{"$match": {"restaurant": {"$ne": "A"}}}]), f).is_some());
        for bad in [
            json!([m.clone(), {"$unionWith": "orders"}]),
            json!([m.clone(), {"$unionWith": {"coll": "orders"}}]),
            json!([m.clone(), {"$unionWith": {"coll": "orders", "pipeline": [{"$limit": 5}]}}]),
            json!([m.clone(), {"$lookup": {"from": "orders", "pipeline": [], "as": "all"}}]),
            json!([m.clone(), {"$lookup": {"from": "orders", "localField": "a", "foreignField": "b", "as": "x"}}]),
            json!([m.clone(), {"$graphLookup": {"from": "orders", "startWith": "$a", "connectFromField": "a", "connectToField": "b", "as": "x"}}]),
            json!([m.clone(), {"$facet": {"a": [{"$lookup": {"from": "orders", "pipeline": [], "as": "all"}}]}}]),
            json!([m.clone(), {"$lookup": {"from": "orders", "pipeline": [{"$match": {"restaurant": "A"}}, {"$unionWith": "x"}], "as": "all"}}]),
        ] {
            assert!(tenant_pipeline_problem(&bad, f).is_some(), "{bad}");
        }
        for ok in [
            json!([m.clone(), {"$lookup": {"from": "orders", "pipeline": [{"$match": {"restaurant": "A"}}], "as": "x"}}]),
            json!([m.clone(), {"$unionWith": {"coll": "orders", "pipeline": [{"$match": {"restaurant": "A"}}]}}]),
            json!([m.clone(), {"$graphLookup": {"from": "orders", "restrictSearchWithMatch": {"restaurant": "A"}}}]),
        ] {
            assert!(tenant_pipeline_problem(&ok, f).is_none(), "{ok}");
        }
    }
}
