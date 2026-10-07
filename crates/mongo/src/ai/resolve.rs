//! Local enum-value resolver. In P1 the model never sees stored enum values, so it guesses ("kiszállítás", "dessert",
//! "drink") while the data says `delivery`, `desszert`, `ital`. The sampled value sets stay on this machine: after the
//! model answered, an equality / `$in` / `$ne` / `$nin` on an enum-like field whose string is not a stored value is
//! mapped to the stored value(s) (case/accent, Hungarian-English synonym groups, shared stem, edit distance 1-2).
//! Nothing here is sent anywhere; the user sees every rewrite as an assumption.

use std::collections::BTreeSet;

use serde_json::{json, Value};

use super::privacy::fold;
use crate::digest::Digest;

/// Universal synonym groups of folded stems (accents stripped, separators removed), English only.
const UNIVERSAL: &[&[&str]] = &[
    &["delivery"],
    &["takeaway", "takeout"],
    &["dinein"],
    &["open"],
    &["closed"],
    &["paid"],
    &["cancelled", "canceled"],
    &["refunded", "refund"],
    &["pending"],
    &["active"],
    &["inactive"],
    &["cash"],
    &["card"],
    &["new"],
    &["regular"],
    &["vip"],
    &["drink", "drinks", "beverage", "beverages"],
    &["dessert", "desserts", "sweet"],
    &["soup", "soups"],
    &["main", "maincourse", "entree"],
    &["terrace"],
    &["male"],
    &["female"],
    &["admin"],
    &["waiter"],
    &["manager"],
    &["huf"],
    &["eur", "euro"],
];

/// Hungarian extension, loaded only for the Happy preset: extra words of the universal group whose first word is the key.
/// Hungarian words are matched by prefix.
const HUNGARIAN: &[(&str, &[&str])] = &[
    ("delivery", &["kiszallit", "kiszallitas", "hazhozszallit", "futar", "szallit"]),
    ("takeaway", &["elvitel", "elvitelre", "elviteles"]),
    ("dinein", &["helyben", "asztal", "vendeglatas"]),
    ("open", &["nyitott", "folyamatban"]),
    ("closed", &["lezart", "zart", "lezarva"]),
    ("paid", &["fizetett", "kifizetett"]),
    ("cancelled", &["sztornozott", "sztorno", "visszavont", "torolt", "lemondott"]),
    ("refunded", &["visszateritett", "visszateritve", "visszafizetett"]),
    ("pending", &["fuggoben", "fuggo", "varakozo"]),
    ("active", &["aktiv"]),
    ("inactive", &["inaktiv", "passziv"]),
    ("cash", &["keszpenz", "keszpenzes", "kp"]),
    ("card", &["kartya", "kartyas", "bankkartya"]),
    ("new", &["uj", "ujonnan", "friss"]),
    ("regular", &["rendszeres", "torzs", "torzsvendeg", "stammgast"]),
    ("vip", &["kiemelt"]),
    ("drink", &["ital", "italok", "udito"]),
    ("dessert", &["desszert", "desszertek", "edesseg"]),
    ("soup", &["leves", "levesek"]),
    ("main", &["foetel", "foetelek"]),
    ("terrace", &["terasz"]),
    ("male", &["ferfi"]),
    ("female", &["no", "noi"]),
    ("admin", &["adminisztrator"]),
    ("waiter", &["pincer", "felszolgalo"]),
    ("manager", &["vezeto", "uzletvezeto"]),
    ("huf", &["forint", "ft"]),
];

/// Effective groups: the universal English set, plus the Hungarian words when `hungarian` is on.
fn groups(hungarian: bool) -> Vec<Vec<&'static str>> {
    UNIVERSAL
        .iter()
        .map(|g| {
            let mut v = g.to_vec();
            if hungarian {
                for (head, extra) in HUNGARIAN {
                    if g[0] == *head {
                        v.extend_from_slice(extra);
                    }
                }
            }
            v
        })
        .collect()
}

fn norm(s: &str) -> String {
    fold(s).chars().filter(|c| c.is_alphanumeric()).collect()
}

fn stem(n: &str) -> &str {
    n.trim_end_matches(|c: char| c.is_ascii_digit())
}

fn word_match(value: &str, word: &str) -> bool {
    value == word || (word.len() >= 4 && value.starts_with(word)) || (value.len() >= 4 && word.starts_with(value))
}

fn lev(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1]));
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Stored values the guess `v` stands for, empty when nothing fits. `stored` is the sampled value set.
pub fn resolve_value(v: &str, stored: &BTreeSet<String>) -> Vec<String> {
    resolve_value_for(v, stored, true)
}

/// Same, with the Hungarian synonym extension switched by the preset (`false` = generic data sets).
pub fn resolve_value_for(v: &str, stored: &BTreeSet<String>, hungarian: bool) -> Vec<String> {
    if stored.is_empty() || stored.contains(v) {
        return vec![];
    }
    let nv = norm(v);
    if nv.is_empty() {
        return vec![];
    }
    let table: Vec<(String, &String)> = stored.iter().map(|s| (norm(s), s)).collect();
    // 1. same value up to case, accents and separators
    let same: Vec<String> = table.iter().filter(|(n, _)| *n == nv).map(|(_, s)| (*s).clone()).collect();
    if !same.is_empty() {
        return same;
    }
    // 2. synonym group (Hungarian <-> English)
    let mut by_group: Vec<String> = Vec::new();
    for g in groups(hungarian).iter().filter(|g| g.iter().any(|w| word_match(&nv, w))) {
        for (n, s) in &table {
            if g.iter().any(|w| n == w || (w.len() >= 4 && n.starts_with(w))) && !by_group.contains(*s) {
                by_group.push((*s).clone());
            }
        }
    }
    if !by_group.is_empty() {
        return by_group;
    }
    // 3. shared stem: "terasz" -> "Terasz 1", "Terasz 3"; "kiszállításos" -> "kiszállítás"
    if nv.len() >= 4 {
        let stems: Vec<String> = table.iter().filter(|(n, _)| { let st = stem(n); st.len() >= 4 && (st.starts_with(&nv) || nv.starts_with(st)) }).map(|(_, s)| (*s).clone()).collect();
        if !stems.is_empty() {
            return stems;
        }
    }
    // 4. a typo-sized edit distance to exactly one stored value
    let max = if nv.len() >= 8 { 2 } else { 1 };
    if nv.len() >= 5 {
        let mut best: Vec<(usize, &String)> = table.iter().map(|(n, s)| (lev(&nv, n), *s)).filter(|(d, _)| *d <= max).collect();
        best.sort();
        if let Some((d, _)) = best.first().copied() {
            let top: Vec<String> = best.iter().filter(|(x, _)| *x == d).map(|(_, s)| (*s).clone()).collect();
            if top.len() == 1 {
                return top;
            }
        }
    }
    vec![]
}

#[derive(Debug, Clone, PartialEq)]
pub struct Rewrite {
    pub path: String,
    pub from: String,
    pub to: Vec<String>,
}

/// Rewrite `filter` in place; returns what changed.
pub fn resolve_filter(filter: &mut Value, digest: &Digest) -> Vec<Rewrite> {
    resolve_filter_for(filter, digest, true)
}

/// Same, with the Hungarian synonym extension switched by the preset.
pub fn resolve_filter_for(filter: &mut Value, digest: &Digest, hungarian: bool) -> Vec<Rewrite> {
    let mut out = Vec::new();
    walk(filter, digest, hungarian, &mut out);
    out
}

fn stored_for<'a>(digest: &'a Digest, path: &str) -> Option<&'a BTreeSet<String>> {
    let f = digest.field(path)?;
    (f.is_enum_like(digest.sampled) && !f.strings.is_empty()).then_some(&f.strings)
}

fn walk(v: &mut Value, digest: &Digest, hu: bool, out: &mut Vec<Rewrite>) {
    let Value::Object(m) = v else { return };
    for (k, val) in m.iter_mut() {
        if matches!(k.as_str(), "$and" | "$or" | "$nor") {
            if let Value::Array(items) = val {
                items.iter_mut().for_each(|i| walk(i, digest, hu, out));
            }
            continue;
        }
        if k.starts_with('$') {
            continue;
        }
        let Some(stored) = stored_for(digest, k) else { continue };
        match val {
            Value::String(s) => {
                let to = resolve_value_for(s, stored, hu);
                if !to.is_empty() {
                    out.push(Rewrite { path: k.clone(), from: s.clone(), to: to.clone() });
                    *val = if to.len() == 1 { Value::String(to[0].clone()) } else { json!({ "$in": to }) };
                }
            }
            Value::Object(ops) => {
                for (op, arg) in ops.iter_mut() {
                    match op.as_str() {
                        "$eq" | "$ne" => {
                            if let Value::String(s) = arg.clone() {
                                let to = resolve_value_for(&s, stored, hu);
                                if !to.is_empty() {
                                    out.push(Rewrite { path: k.clone(), from: s, to: to.clone() });
                                    // several stored values: renamed to $in / $nin below
                                    *arg = if to.len() == 1 { Value::String(to[0].clone()) } else { json!(to) };
                                }
                            }
                        }
                        "$in" | "$nin" => {
                            if let Value::Array(items) = arg.clone() {
                                let mut next: Vec<Value> = Vec::new();
                                for it in items {
                                    match &it {
                                        Value::String(s) => {
                                            let to = resolve_value_for(s, stored, hu);
                                            if to.is_empty() {
                                                next.push(it.clone());
                                            } else {
                                                out.push(Rewrite { path: k.clone(), from: s.clone(), to: to.clone() });
                                                next.extend(to.into_iter().map(Value::String));
                                            }
                                        }
                                        _ => next.push(it.clone()),
                                    }
                                }
                                next.dedup();
                                *arg = Value::Array(next);
                            }
                        }
                        _ => {}
                    }
                }
                // `$eq`/`$ne` that became an array need the matching `$in`/`$nin` operator name
                let renames: Vec<(String, String)> = ops.iter().filter(|(op, a)| matches!(op.as_str(), "$eq" | "$ne") && a.is_array()).map(|(op, _)| (op.clone(), if op == "$eq" { "$in".to_string() } else { "$nin".to_string() })).collect();
                for (old, new) in renames {
                    if let Some(a) = ops.remove(&old) {
                        ops.insert(new, a);
                    }
                }
            }
            _ => {}
        }
    }
}

/// Apply the rewrites to the model's filter text: a plain in-place swap of the quoted literal when it is unambiguous
/// (keeps the model's formatting), otherwise the resolved value serialized.
pub fn patch_text(text: &str, rewrites: &[Rewrite], resolved: &Value) -> String {
    let mut t = text.to_string();
    for r in rewrites {
        let simple = r.to.len() == 1;
        let (dq, sq) = (format!("\"{}\"", r.from), format!("'{}'", r.from));
        if simple && t.matches(&dq).count() + t.matches(&sq).count() == 1 {
            t = t.replace(&dq, &format!("\"{}\"", r.to[0])).replace(&sq, &format!("'{}'", r.to[0]));
        } else {
            return serde_json::to_string(resolved).unwrap_or_else(|_| text.to_string());
        }
    }
    t
}

/// Human line for the assumptions list.
pub fn describe(r: &Rewrite) -> String {
    let to = r.to.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(", ");
    format!("{}: \"{}\" is not a stored value; matched {} from the sampled values", r.path, r.from, to)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(v: &[&str]) -> BTreeSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn maps_hungarian_and_english_guesses_to_stored_values() {
        let types = set(&["dine_in", "takeaway", "delivery"]);
        assert_eq!(resolve_value("kiszállítás", &types), vec!["delivery"]);
        assert_eq!(resolve_value("kiszállításos", &types), vec!["delivery"]);
        assert_eq!(resolve_value("Elvitel", &types), vec!["takeaway"]);
        assert_eq!(resolve_value("helyben", &types), vec!["dine_in"]);
        assert_eq!(resolve_value("dine-in", &types), vec!["dine_in"]);
        assert!(resolve_value("delivery", &types).is_empty(), "stored values are never rewritten");
        let cats = set(&["desszert", "főétel", "ital", "leves"]);
        assert_eq!(resolve_value("dessert", &cats), vec!["desszert"]);
        assert_eq!(resolve_value("drink", &cats), vec!["ital"]);
        assert_eq!(resolve_value("main course", &cats), vec!["főétel"]);
        assert_eq!(resolve_value("soup", &cats), vec!["leves"]);
        let tables = set(&["Belső 2", "Terasz 1", "Terasz 3"]);
        assert_eq!(resolve_value("terasz", &tables), vec!["Terasz 1", "Terasz 3"]);
        assert!(resolve_value("minta", &types).is_empty());
    }

    #[test]
    fn rewrites_equality_in_and_ne() {
        let mut d = Digest { collection: "orders".into(), sampled: 200, ..Default::default() };
        d.fields.push(crate::digest::FieldStat { path: "type".into(), docs: 200, types: [("string".to_string(), 200)].into(), strings: set(&["dine_in", "takeaway", "delivery"]), ..Default::default() });
        d.fields.push(crate::digest::FieldStat { path: "table".into(), docs: 200, types: [("string".to_string(), 200)].into(), strings: set(&["Belső 2", "Terasz 1", "Terasz 3"]), ..Default::default() });
        let mut f = json!({"type": "kiszállítás", "table": {"$ne": "terasz"}, "$or": [{"type": {"$in": ["elvitel", "delivery"]}}]});
        let r = resolve_filter(&mut f, &d);
        assert_eq!(f, json!({"type": "delivery", "table": {"$nin": ["Terasz 1", "Terasz 3"]}, "$or": [{"type": {"$in": ["takeaway", "delivery"]}}]}));
        assert_eq!(r.len(), 3);
        assert!(describe(&r[0]).contains("kiszállítás"));
    }
}
