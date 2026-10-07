//! Schema digest from sampled canonical-EJSON documents: per path presence, type histogram, enum-likeness, traps.
//! `compact()` renders the TypeScript-like text that goes into the prompt. In privacy mode P1 (the M1 maximum)
//! enum VALUES are never rendered; only "enum-like (N values)" is.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde_json::Value;

const MAX_DEPTH: usize = 4;
const ENUM_MAX: usize = 15;

#[derive(Debug, Clone, Default)]
pub struct FieldStat {
    pub path: String,
    pub docs: usize,
    pub types: BTreeMap<String, usize>,
    pub in_array: bool,
    pub strings: BTreeSet<String>,
    pub string_overflow: bool,
    pub string_total: usize,
    pub strings_numeric: usize,
    pub strings_datelike: usize,
    /// Set by the privacy sanitizer when the value set was dropped: the number of distinct values it had (0 = none).
    pub enum_values: usize,
    /// Length of every array occurrence at this path (the compaction shows p95, elements are never expanded).
    pub array_lens: Vec<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct Digest {
    pub collection: String,
    pub sampled: usize,
    pub estimated: Option<u64>,
    pub fields: Vec<FieldStat>,
    pub indexes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CompactOpts {
    pub include_enum_values: bool,
    pub max_fields: usize,
    /// Deepest path kept (number of dots + 1).
    pub max_depth: usize,
    /// Drop fields present in fewer than this percent of the sampled documents.
    pub min_presence_pct: usize,
}
impl Default for CompactOpts {
    fn default() -> Self {
        Self { include_enum_values: false, max_fields: 80, max_depth: usize::MAX, min_presence_pct: 0 }
    }
}

pub fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Array(_) => "array",
        Value::Object(m) => match m.keys().next().map(String::as_str) {
            Some("$oid") if m.len() == 1 => "ObjectId",
            Some("$date") if m.len() == 1 => "Date",
            Some("$numberInt") if m.len() == 1 => "int",
            Some("$numberLong") if m.len() == 1 => "long",
            Some("$numberDouble") if m.len() == 1 => "double",
            Some("$numberDecimal") if m.len() == 1 => "Decimal128",
            Some("$regularExpression") => "regex",
            Some("$binary") => "binData",
            Some("$timestamp") => "Timestamp",
            Some("$minKey") => "MinKey",
            Some("$maxKey") => "MaxKey",
            Some("$undefined") => "undefined",
            Some("$symbol") => "Symbol",
            Some("$dbPointer") => "DBPointer",
            Some("$code") => "Code",
            _ => "object",
        },
    }
}

/// Placeholder segment for the keys of a map whose keys are data (ids, names, dates), not field names.
pub const DYNAMIC_KEY: &str = "<key>";
/// An object with more distinct child keys than this across the sample is a map, not a record.
const MAX_FIELD_KEYS: usize = 12;

/// A key that is itself a value: ObjectId, UUID, number, ISO date, e-mail or a token with spaces.
pub fn looks_like_value_key(k: &str) -> bool {
    let b = k.as_bytes();
    let hex24 = b.len() == 24 && b.iter().all(u8::is_ascii_hexdigit);
    let uuid = b.len() == 36 && b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() });
    let numeric = !b.is_empty() && b.iter().all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'-' | b'+')) && b.iter().any(u8::is_ascii_digit);
    let date = b.len() >= 8 && b[..4].iter().all(u8::is_ascii_digit) && matches!(b[4], b'-' | b'/' | b'.') && b[5].is_ascii_digit();
    hex24 || uuid || numeric || date || k.contains('@') || k.contains(char::is_whitespace)
}

/// Object paths whose keys must not be shown: more than [`MAX_FIELD_KEYS`] distinct keys, or any value-like key.
fn dynamic_parents(docs: &[Value]) -> HashSet<String> {
    fn go(v: &Value, path: &str, depth: usize, keys: &mut BTreeMap<String, BTreeSet<String>>) {
        match v {
            Value::Object(m) if type_name(v) == "object" && depth <= MAX_DEPTH => {
                let set = keys.entry(path.to_string()).or_default();
                for k in m.keys() {
                    set.insert(k.clone());
                }
                for (k, c) in m {
                    let child = if path.is_empty() { k.clone() } else { format!("{path}.{k}") };
                    go(c, &child, depth + 1, keys);
                }
            }
            Value::Array(a) if depth <= MAX_DEPTH => a.iter().for_each(|c| go(c, path, depth + 1, keys)),
            _ => {}
        }
    }
    let mut keys = BTreeMap::new();
    for d in docs {
        go(d, "", 0, &mut keys);
    }
    // the top level is the collection's own field list: only value-like keys are suspicious there, never the count
    keys.into_iter().filter(|(p, set)| (!p.is_empty() && set.len() > MAX_FIELD_KEYS) || set.iter().any(|k| looks_like_value_key(k))).map(|(p, _)| p).collect()
}

pub fn build(collection: &str, docs: &[Value], estimated: Option<u64>, indexes: Vec<String>) -> Digest {
    let mut stats: BTreeMap<String, FieldStat> = BTreeMap::new();
    let dynamic = dynamic_parents(docs);
    for d in docs {
        let mut seen: HashSet<String> = HashSet::new();
        let mut seen_t: HashSet<(String, &'static str)> = HashSet::new();
        let mut cx = Walk { stats: &mut stats, seen: &mut seen, seen_t: &mut seen_t, dynamic: &dynamic };
        cx.walk(d, "", "", 0, false, true);
    }
    let fields: Vec<FieldStat> = stats.into_values().collect();
    Digest { collection: collection.to_string(), sampled: docs.len(), estimated, fields, indexes }
}

struct Walk<'a> {
    stats: &'a mut BTreeMap<String, FieldStat>,
    seen: &'a mut HashSet<String>,
    seen_t: &'a mut HashSet<(String, &'static str)>,
    dynamic: &'a HashSet<String>,
}

impl Walk<'_> {
    /// `raw` is the path with the real keys (it decides which maps are dynamic), `path` the one that is recorded.
    fn walk(&mut self, v: &Value, raw: &str, path: &str, depth: usize, in_array: bool, top: bool) {
        let child = |k: &str, dynamic: &HashSet<String>| -> (String, String) {
            let r = if raw.is_empty() { k.to_string() } else { format!("{raw}.{k}") };
            let shown = if dynamic.contains(raw) { DYNAMIC_KEY } else { k };
            let p = if path.is_empty() { shown.to_string() } else { format!("{path}.{shown}") };
            (r, p)
        };
        if let (true, Value::Object(m)) = (top, v) {
            for (k, c) in m {
                let (r, p) = child(k, self.dynamic);
                self.walk(c, &r, &p, depth, in_array, false);
            }
            return;
        }
        let t = type_name(v);
        let st = self.stats.entry(path.to_string()).or_insert_with(|| FieldStat { path: path.to_string(), ..Default::default() });
        if self.seen.insert(path.to_string()) {
            st.docs += 1;
        }
        st.in_array |= in_array;
        // An array is a container, not a type: its element types are recorded under the same path.
        if t == "array" {
            st.in_array = true;
        } else if self.seen_t.insert((path.to_string(), t)) {
            *st.types.entry(t.to_string()).or_insert(0) += 1;
        }
        match v {
            Value::String(s) => {
                st.string_total += 1;
                if s.len() > 64 || (st.strings.len() >= ENUM_MAX && !st.strings.contains(s)) {
                    st.string_overflow = true;
                } else {
                    st.strings.insert(s.clone());
                }
                if s.trim().parse::<f64>().is_ok() && !s.is_empty() {
                    st.strings_numeric += 1;
                }
                let b = s.as_bytes();
                if b.len() >= 10 && b[4] == b'-' && b[7] == b'-' && b[..4].iter().all(u8::is_ascii_digit) {
                    st.strings_datelike += 1;
                }
            }
            Value::Array(a) if depth < MAX_DEPTH => {
                st.array_lens.push(a.len());
                for c in a {
                    self.walk(c, raw, path, depth + 1, true, false);
                }
            }
            Value::Object(m) if t == "object" && depth < MAX_DEPTH => {
                for (k, c) in m {
                    let (r, p) = child(k, self.dynamic);
                    self.walk(c, &r, &p, depth + 1, in_array, false);
                }
            }
            _ => {}
        }
    }
}

impl FieldStat {
    pub fn is_enum_like(&self, sampled: usize) -> bool {
        self.types.len() == 1 && self.types.contains_key("string") && sampled >= 100 && !self.string_overflow && (!self.strings.is_empty() || self.enum_values > 0)
    }
    /// Dominant non-null type and its share of documents that have the path.
    pub fn dominant(&self) -> Option<(&str, f64)> {
        let total: usize = self.types.values().sum();
        self.types.iter().filter(|(k, _)| k.as_str() != "null").max_by_key(|(_, c)| **c).map(|(k, c)| (k.as_str(), *c as f64 / total.max(1) as f64))
    }
}

impl Digest {
    pub fn field(&self, path: &str) -> Option<&FieldStat> {
        self.fields.iter().find(|f| f.path == path)
    }
    pub fn roots(&self) -> BTreeSet<&str> {
        self.fields.iter().map(|f| f.path.split('.').next().unwrap_or("")).collect()
    }

    /// Compaction to a character budget (about 4 characters per token): drop rare fields, then deep paths, then the
    /// lowest-ranked fields until the text fits. The budget of the plan is 1.5-3k tokens for the target collection.
    pub fn compact_to_budget(&self, collections: &[String], base: &CompactOpts, max_chars: usize) -> String {
        let mut o = base.clone();
        let mut text = self.compact(collections, &o);
        for min in [5usize, 10, 20] {
            if text.len() <= max_chars {
                return text;
            }
            o.min_presence_pct = o.min_presence_pct.max(min);
            text = self.compact(collections, &o);
        }
        for depth in [3usize, 2] {
            if text.len() <= max_chars {
                return text;
            }
            o.max_depth = depth;
            text = self.compact(collections, &o);
        }
        while text.len() > max_chars && o.max_fields > 8 {
            o.max_fields = o.max_fields * 3 / 4;
            text = self.compact(collections, &o);
        }
        text
    }

    pub fn compact(&self, collections: &[String], o: &CompactOpts) -> String {
        let mut fields: Vec<&FieldStat> = self.fields.iter().filter(|f| f.path.split('.').count() <= o.max_depth && (self.sampled == 0 || f.docs * 100 >= o.min_presence_pct * self.sampled)).collect();
        fields.sort_by(|a, b| b.docs.cmp(&a.docs).then(a.path.cmp(&b.path)));
        fields.truncate(o.max_fields);
        fields.sort_by(|a, b| a.path.cmp(&b.path));
        let mut out = format!("collection {} (~{} documents, sampled {})\n{{\n", self.collection, self.estimated.map_or("?".into(), |n| n.to_string()), self.sampled);
        for f in fields {
            let pct = if self.sampled == 0 { 0 } else { f.docs * 100 / self.sampled };
            let mut ty: Vec<String> = f.types.keys().cloned().collect();
            let mut notes: Vec<String> = Vec::new();
            if f.is_enum_like(self.sampled) {
                if o.include_enum_values && !f.strings.is_empty() {
                    ty = vec![f.strings.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join("|")];
                    notes.push("enum".into());
                } else {
                    let n = f.strings.len().max(f.enum_values);
                    notes.push(format!("enum-like, {n} value{}", if n == 1 { "" } else { "s" }));
                }
            }
            if ty.iter().any(|t| t == "ObjectId") {
                let base = f.path.rsplit('.').next().unwrap_or("").trim_end_matches("Id").trim_end_matches("_id");
                if let Some(c) = collections.iter().find(|c| !base.is_empty() && (c.as_str() == base || c.as_str() == format!("{base}s") || c.as_str() == format!("{base}es"))) {
                    notes.push(format!("ref {c}"));
                }
            }
            let numeric = |k: &str| matches!(k, "int" | "long" | "double" | "Decimal128");
            let non_null: Vec<(&String, &usize)> = f.types.iter().filter(|(k, _)| k.as_str() != "null").collect();
            if let Some(n) = f.types.get("null") {
                // null (present, value null) versus missing (the % above) are different filters: $eq null matches both
                notes.push(format!("null in {}% of docs that have it", (*n * 100 / f.docs.max(1)).max(1)));
            }
            if f.array_lens.len() >= 2 {
                let mut l = f.array_lens.clone();
                l.sort_unstable();
                let p95 = l[((l.len() * 95).div_ceil(100)).saturating_sub(1).min(l.len() - 1)];
                notes.push(format!("array length p95 {p95}"));
            }
            if non_null.len() > 1 && !non_null.iter().all(|(k, _)| numeric(k)) {
                let minor: Vec<String> = non_null.iter().map(|(k, c)| format!("{k} {}%", **c * 100 / f.docs.max(1))).collect();
                notes.push(format!("TRAP mixed types: {}", minor.join("/")));
            } else if non_null.len() > 1 {
                notes.push("mixed int/double".into());
            }
            if f.string_total > 0 && f.strings_numeric * 10 >= f.string_total * 9 {
                notes.push("TRAP strings that parse as numbers".into());
            }
            if f.string_total > 0 && f.strings_datelike * 10 >= f.string_total * 9 {
                notes.push("TRAP strings that look like ISO dates".into());
            }
            let ty_j = if ty.is_empty() { "unknown".to_string() } else { ty.join("|") };
            let ty_s = if f.in_array { format!("Array<{ty_j}>") } else { ty_j };
            out.push_str(&format!("  {}: {} /* {}%{}{} */\n", f.path, ty_s, pct, if notes.is_empty() { "" } else { ", " }, notes.join(", ")));
        }
        out.push_str("}\n");
        if !self.indexes.is_empty() {
            out.push_str(&format!("indexes: {}\n", self.indexes.join(" ; ")));
        }
        out
    }
}

/// Canonical EJSON number wrappers to plain JSON numbers (for compact display of index keys and the like).
pub fn plain(v: &Value) -> Value {
    match v {
        Value::Object(m) if m.len() == 1 => {
            for k in ["$numberInt", "$numberLong", "$numberDouble"] {
                if let Some(n) = m.get(k).and_then(Value::as_str).and_then(|s| s.parse::<f64>().ok()) {
                    return if n.fract() == 0.0 { Value::from(n as i64) } else { Value::from(n) };
                }
            }
            Value::Object(m.iter().map(|(k, c)| (k.clone(), plain(c))).collect())
        }
        Value::Object(m) => Value::Object(m.iter().map(|(k, c)| (k.clone(), plain(c))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(plain).collect()),
        other => other.clone(),
    }
}
