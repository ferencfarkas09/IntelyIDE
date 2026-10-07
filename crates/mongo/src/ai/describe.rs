//! The plain-language explanation is generated from the **validated** query, never from the model's draft: what the
//! user reads is what will run. Hungarian when the question looks Hungarian.

use serde_json::Value;

use super::privacy::fold;
use super::validate::ValidatedFind;

pub fn looks_hungarian(question: &str) -> bool {
    if question.chars().any(|c| matches!(c, 'á' | 'é' | 'í' | 'ó' | 'ö' | 'ő' | 'ú' | 'ü' | 'ű' | 'Á' | 'É' | 'Í' | 'Ó' | 'Ö' | 'Ő' | 'Ú' | 'Ü' | 'Ű')) {
        return true;
    }
    let f = fold(question);
    ["rendel", "vendeg", "etterem", "mutasd", "melyik", "hany", "azok", "nincs", "nelkul", "elmult", "legujabb", "legutobbi", "osszes", "szeptember", "oktober", "datum", "kozott", "felett", "alatt", "termek", "szamla"].iter().any(|w| f.contains(w))
}

fn scalar(v: &Value) -> String {
    match v {
        Value::String(s) => format!("\"{s}\""),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        Value::Array(a) => format!("[{}]", a.iter().map(scalar).collect::<Vec<_>>().join(", ")),
        Value::Object(m) if m.len() == 1 => {
            let (k, c) = m.iter().next().unwrap();
            match (k.as_str(), c) {
                ("$oid", Value::String(s)) => format!("ObjectId({s})"),
                ("$date", Value::String(s)) => s.clone(),
                ("$date", Value::Object(o)) => o.get("$numberLong").and_then(Value::as_str).and_then(|x| x.parse::<i64>().ok()).map_or("date".into(), super::clock::iso_z),
                ("$numberInt" | "$numberLong" | "$numberDouble" | "$numberDecimal", Value::String(s)) => s.clone(),
                ("$regularExpression", r) => format!("/{}/{}", r.get("pattern").and_then(Value::as_str).unwrap_or(""), r.get("options").and_then(Value::as_str).unwrap_or("")),
                _ => v.to_string(),
            }
        }
        other => other.to_string(),
    }
}

/// A `$expr` aggregation expression in words: comparisons, `$size`, field references, `$and` / `$or`. Anything else is
/// shown compactly (the review strip still has the exact filter).
fn expr_text(v: &Value, hu: bool) -> String {
    match v {
        Value::String(s) if s.starts_with('$') => s[1..].to_string(),
        Value::Object(m) if m.len() == 1 => {
            let (op, a) = m.iter().next().unwrap();
            let sym = match op.as_str() {
                "$gt" => Some(">"),
                "$gte" => Some(">="),
                "$lt" => Some("<"),
                "$lte" => Some("<="),
                "$eq" => Some("="),
                "$ne" => Some("!="),
                _ => None,
            };
            match (op.as_str(), a) {
                (_, Value::Array(args)) if sym.is_some() && args.len() == 2 => format!("{} {} {}", expr_text(&args[0], hu), sym.unwrap(), expr_text(&args[1], hu)),
                ("$and" | "$or", Value::Array(args)) => args.iter().map(|x| expr_text(x, hu)).collect::<Vec<_>>().join(match (op.as_str(), hu) { ("$and", true) => " és ", ("$and", false) => " and ", (_, true) => " vagy ", (_, false) => " or " }),
                ("$size", x) => format!("{}({})", if hu { "elemszám" } else { "number of elements in" }, expr_text(x, hu)),
                _ => scalar(v),
            }
        }
        other => scalar(other),
    }
}

fn cond(field: &str, v: &Value, hu: bool) -> String {
    let Value::Object(m) = v else { return format!("{field} = {}", scalar(v)) };
    let wrapper = m.keys().next().is_some_and(|k| matches!(k.as_str(), "$oid" | "$date" | "$numberInt" | "$numberLong" | "$numberDouble" | "$numberDecimal" | "$regularExpression"));
    if wrapper {
        return if m.contains_key("$regularExpression") { format!("{field} {} {}", if hu { "illeszkedik:" } else { "matches" }, scalar(v)) } else { format!("{field} = {}", scalar(v)) };
    }
    if !m.keys().any(|k| k.starts_with('$')) {
        return format!("{field} = {v}");
    }
    let parts: Vec<String> = m
        .iter()
        .map(|(op, x)| match op.as_str() {
            "$eq" => format!("{field} = {}", scalar(x)),
            "$ne" => format!("{field} != {}", scalar(x)),
            "$gt" => format!("{field} > {}", scalar(x)),
            "$gte" => format!("{field} >= {}", scalar(x)),
            "$lt" => format!("{field} < {}", scalar(x)),
            "$lte" => format!("{field} <= {}", scalar(x)),
            "$in" => format!("{field} {} {}", if hu { "az egyik:" } else { "in" }, scalar(x)),
            "$nin" => format!("{field} {} {}", if hu { "egyik sem:" } else { "not in" }, scalar(x)),
            "$exists" => format!("{field} {}", match (x.as_bool().unwrap_or(true), hu) { (true, false) => "exists", (false, false) => "does not exist", (true, true) => "létezik", (false, true) => "nem létezik" }),
            "$type" => format!("{field} {} {}", if hu { "típusa" } else { "has type" }, scalar(x)),
            "$regex" => format!("{field} {} /{}/", if hu { "illeszkedik:" } else { "matches" }, x.as_str().unwrap_or("")),
            "$options" => String::new(),
            "$size" => format!("{field} {} {}", if hu { "elemszáma" } else { "has this many elements:" }, scalar(x)),
            "$elemMatch" => format!("{field} {} ({})", if hu { "valamelyik eleme:" } else { "has an element where" }, describe_filter(x, hu)),
            other => format!("{field} {other} {}", scalar(x)),
        })
        .filter(|s| !s.is_empty())
        .collect();
    parts.join(if hu { " és " } else { " and " })
}

pub fn describe_filter(f: &Value, hu: bool) -> String {
    let Value::Object(m) = f else { return String::new() };
    let (and, or) = if hu { (" és ", " vagy ") } else { (" and ", " or ") };
    let mut parts = Vec::new();
    for (k, v) in m {
        match (k.as_str(), v) {
            ("$and", Value::Array(a)) => parts.push(format!("({})", a.iter().map(|c| describe_filter(c, hu)).collect::<Vec<_>>().join(and))),
            ("$or", Value::Array(a)) => parts.push(format!("({})", a.iter().map(|c| describe_filter(c, hu)).collect::<Vec<_>>().join(or))),
            ("$nor", Value::Array(a)) => parts.push(format!("{} ({})", if hu { "egyik sem:" } else { "none of" }, a.iter().map(|c| describe_filter(c, hu)).collect::<Vec<_>>().join(", "))),
            ("$expr", e) => parts.push(expr_text(e, hu)),
            (k, _) if k.starts_with('$') => parts.push(k.to_string()),
            (k, v) => parts.push(cond(k, v, hu)),
        }
    }
    parts.join(and)
}

pub fn describe_find(v: &ValidatedFind, question: &str) -> String {
    describe_find_for(v, question, true)
}

/// `hungarian = false` (generic preset) never produces the Hungarian templates.
pub fn describe_find_for(v: &ValidatedFind, question: &str, hungarian: bool) -> String {
    let hu = hungarian && looks_hungarian(question);
    let filter = describe_filter(&v.filter, hu);
    let sort = v.sort.as_ref().and_then(|s| s.as_object()).map(|m| {
        m.iter()
            .map(|(k, d)| {
                let desc = d.as_i64().or_else(|| d.get("$numberInt").and_then(Value::as_str).and_then(|x| x.parse().ok())).unwrap_or(1) < 0;
                format!("{k} {}", match (desc, hu) { (true, false) => "descending", (false, false) => "ascending", (true, true) => "csökkenő", (false, true) => "növekvő" })
            })
            .collect::<Vec<_>>()
            .join(", ")
    });
    if hu {
        let mut s = format!("A(z) {} gyűjteményben {}", v.collection, if filter.is_empty() { "minden dokumentumot keres".to_string() } else { format!("azokat a dokumentumokat keresi, ahol {filter}") });
        if let Some(so) = sort.filter(|s| !s.is_empty()) {
            s.push_str(&format!("; rendezés: {so}"));
        }
        s.push_str(&format!("; legfeljebb {} dokumentum.", v.limit));
        s
    } else {
        let mut s = format!("Finds {} in {}", if filter.is_empty() { "every document".to_string() } else { format!("documents where {filter}") }, v.collection);
        if let Some(so) = sort.filter(|s| !s.is_empty()) {
            s.push_str(&format!(", sorted by {so}"));
        }
        s.push_str(&format!(", up to {} documents.", v.limit));
        s
    }
}
