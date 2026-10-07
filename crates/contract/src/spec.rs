//! The backend contract: endpoints, parameters and shallow schema shapes from swagger 2 / openapi 3, either one JSON
//! document or the backend's YAML fragments (`src/api/**/*.yaml`, `src/auth/**/*.yaml`, merged like its build script does).

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::yaml;

const METHODS: [&str; 7] = ["get", "put", "post", "delete", "patch", "options", "head"];
const JSON_CAP: u64 = 40 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Param {
    pub name: String,
    #[serde(rename = "in")]
    pub location: String,
    pub required: bool,
    #[serde(rename = "type")]
    pub ty: String,
}

/// The top-level fields of a request or response body: enough to compare with what a client sends or reads.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Shape {
    pub array: bool,
    pub props: Vec<String>,
    pub required: Vec<String>,
    /// Free-form or unknown: nothing can be said about missing fields.
    pub open: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub file: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub id: String,
    pub method: String,
    pub path: String,
    pub operation_id: Option<String>,
    pub tags: Vec<String>,
    pub summary: String,
    pub deprecated: bool,
    pub params: Vec<Param>,
    pub body_required: bool,
    pub has_body: bool,
    pub request: Option<Shape>,
    pub response: Option<Shape>,
    pub source: Source,
}

#[derive(Debug, Clone)]
pub struct Spec {
    pub kind: &'static str,
    pub title: String,
    pub version: String,
    pub host: String,
    pub base_path: String,
    pub endpoints: Vec<Endpoint>,
    pub defs: Map<String, Value>,
    /// path (without base path) -> raw path item, for the detail view.
    pub raw: BTreeMap<String, Value>,
    pub files: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Candidate {
    pub score: u64,
    pub kind: &'static str,
    pub files: Vec<String>,
}

fn is_yaml(f: &str) -> bool {
    f.ends_with(".yaml") || f.ends_with(".yml")
}

/// Cheap scoring (no parsing): does this repo own a swagger description, and how big is it?
pub fn discover(root: &Path, files: &[String]) -> Option<Candidate> {
    let frag: Vec<String> = files.iter().filter(|f| (f.starts_with("src/api/") || f.starts_with("src/auth/")) && is_yaml(f)).cloned().collect();
    if frag.len() >= 2 {
        let boost = if files.iter().any(|f| f == "scripts/build-swagger.mjs") { 200 } else { 0 };
        return Some(Candidate { score: 10_000 + boost + frag.len() as u64, kind: "fragments", files: frag });
    }
    let mut best: Option<(u64, String)> = None;
    for f in files {
        let base = f.rsplit('/').next().unwrap_or(f).to_lowercase();
        let named = (base.starts_with("swagger") || base.starts_with("openapi")) && (base.ends_with(".json") || is_yaml(&base));
        if !named || base.contains("temp") || base.contains("tmp") || f.contains("node_modules/") || f.starts_with(".history/") || f.contains("/ui/") {
            continue;
        }
        let Ok(m) = std::fs::metadata(root.join(f)) else { continue };
        if m.len() == 0 || m.len() > JSON_CAP {
            continue;
        }
        let score = 1 + m.len() / 1000;
        if best.as_ref().is_none_or(|(s, _)| score > *s) {
            best = Some((score, f.clone()));
        }
    }
    best.map(|(score, f)| Candidate { score: score.min(9_999), kind: "document", files: vec![f] })
}

pub fn load(root: &Path, files: &[String]) -> Result<Spec, String> {
    let cand = discover(root, files).ok_or_else(|| "no swagger or openapi description found".to_string())?;
    if cand.kind == "document" {
        load_document(root, &cand.files[0])
    } else {
        load_fragments(root, &cand.files)
    }
}

fn load_document(root: &Path, rel: &str) -> Result<Spec, String> {
    let text = std::fs::read_to_string(root.join(rel)).map_err(|e| format!("{rel}: {e}"))?;
    let (doc, lines): (Value, BTreeMap<String, usize>) = if is_yaml(rel) {
        let p = yaml::parse_with_lines(&text).map_err(|e| format!("{rel}: {e}"))?;
        (p.value, p.lines.into_iter().collect())
    } else {
        let doc = serde_json::from_str(&text).map_err(|e| format!("{rel}: {e}"))?;
        (doc, json_path_lines(&text))
    };
    let mut spec = from_value(&doc, |p| Source { file: rel.to_string(), line: lines.get(p).or_else(|| lines.get(&format!("paths/{p}"))).copied().unwrap_or(1) })?;
    spec.files = vec![rel.to_string()];
    Ok(spec)
}

/// Line of every `"/path":` key (first occurrence) in a pretty-printed JSON document.
fn json_path_lines(text: &str) -> BTreeMap<String, usize> {
    let mut m = BTreeMap::new();
    for (i, l) in text.lines().enumerate() {
        let t = l.trim_start();
        if let Some(rest) = t.strip_prefix("\"/") {
            if let Some(end) = rest.find("\":") {
                m.entry(format!("/{}", &rest[..end])).or_insert(i + 1);
            }
        }
    }
    m
}

fn load_fragments(root: &Path, files: &[String]) -> Result<Spec, String> {
    let mut paths = Map::new();
    let mut defs = Map::new();
    let mut lines: BTreeMap<String, (String, usize)> = BTreeMap::new();
    let mut used = Vec::new();
    let mut failed = 0usize;
    for f in files {
        let Ok(text) = std::fs::read_to_string(root.join(f)) else { continue };
        let Ok(p) = yaml::parse_with_lines(&text) else {
            failed += 1;
            continue;
        };
        let Value::Object(top) = p.value else { continue };
        let line_of = |k: &str| p.lines.iter().find(|(n, _)| n == k || n == &format!("paths/{k}")).map(|(_, l)| *l).unwrap_or(1);
        let mut any = false;
        for (k, v) in &top {
            if k.starts_with('/') {
                paths.entry(k.clone()).and_modify(|e| merge_item(e, v)).or_insert_with(|| v.clone());
                lines.entry(k.clone()).or_insert((f.clone(), line_of(k)));
                any = true;
            } else if k == "paths" {
                if let Value::Object(m) = v {
                    for (pk, pv) in m {
                        paths.entry(pk.clone()).and_modify(|e| merge_item(e, pv)).or_insert_with(|| pv.clone());
                        lines.entry(pk.clone()).or_insert((f.clone(), line_of(pk)));
                        any = true;
                    }
                }
            } else if k == "definitions" {
                if let Value::Object(m) = v {
                    for (dk, dv) in m {
                        defs.entry(dk.clone()).or_insert_with(|| dv.clone());
                    }
                    any = true;
                }
            }
        }
        if any {
            used.push(f.clone());
        }
    }
    if paths.is_empty() {
        return Err(format!("no paths found in {} yaml files ({failed} unreadable)", files.len()));
    }
    let doc = serde_json::json!({ "swagger": "2.0", "paths": Value::Object(paths), "definitions": Value::Object(defs), "basePath": "/" });
    let mut spec = from_value(&doc, |p| {
        let (file, line) = lines.get(p).cloned().unwrap_or_default();
        Source { file, line }
    })?;
    spec.files = used;
    Ok(spec)
}

fn merge_item(into: &mut Value, from: &Value) {
    if let (Value::Object(a), Value::Object(b)) = (into, from) {
        for (k, v) in b {
            a.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }
}

fn str_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

pub fn from_value(doc: &Value, source: impl Fn(&str) -> Source) -> Result<Spec, String> {
    let v3 = doc.get("openapi").is_some();
    if !v3 && doc.get("swagger").is_none() {
        return Err("not a swagger or openapi document".into());
    }
    let defs = if v3 { doc.pointer("/components/schemas") } else { doc.get("definitions") }.and_then(Value::as_object).cloned().unwrap_or_default();
    let host = if v3 {
        doc.pointer("/servers/0/url").and_then(Value::as_str).unwrap_or("").to_string()
    } else {
        let h = str_of(doc, "host");
        if h.is_empty() { h } else { format!("{}://{}", doc.pointer("/schemes/0").and_then(Value::as_str).unwrap_or("https"), h) }
    };
    let base_path = if v3 { String::new() } else { str_of(doc, "basePath") };
    let base = base_path.trim_end_matches('/').to_string();
    let paths = doc.get("paths").and_then(Value::as_object).ok_or("no paths object")?;
    let mut endpoints = Vec::new();
    let mut raw = BTreeMap::new();
    for (path, item) in paths {
        let Some(item_obj) = item.as_object() else { continue };
        raw.insert(path.clone(), item.clone());
        let shared: Vec<&Value> = item_obj.get("parameters").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
        for m in METHODS {
            let Some(op) = item_obj.get(m).filter(|o| o.is_object()) else { continue };
            let mut params: Vec<Param> = Vec::new();
            let mut has_body = false;
            let mut body_required = false;
            let mut request = None;
            let all = shared.iter().copied().chain(op.get("parameters").and_then(Value::as_array).into_iter().flatten());
            for p in all {
                let p = deref(p, doc);
                let name = str_of(p, "name");
                let loc = str_of(p, "in");
                if loc == "body" {
                    has_body = true;
                    body_required = p.get("required").and_then(Value::as_bool).unwrap_or(false);
                    request = p.get("schema").map(|s| shape(s, &defs));
                    continue;
                }
                if name.is_empty() {
                    continue;
                }
                let ty = p.get("type").or_else(|| p.pointer("/schema/type")).and_then(Value::as_str).unwrap_or("string").to_string();
                let required = loc == "path" || p.get("required").and_then(Value::as_bool).unwrap_or(false);
                params.retain(|q| !(q.name == name && q.location == loc));
                params.push(Param { name, location: loc, required, ty });
            }
            if let Some(rb) = op.get("requestBody") {
                let rb = deref(rb, doc);
                has_body = true;
                body_required = rb.get("required").and_then(Value::as_bool).unwrap_or(false);
                request = pick_content(rb.get("content")).map(|s| shape(s, &defs));
            }
            let response = success_schema(op, doc).map(|s| shape(s, &defs));
            let full = format!("{base}{path}");
            endpoints.push(Endpoint {
                id: format!("{} {}", m.to_uppercase(), full),
                method: m.to_uppercase(),
                path: full,
                operation_id: op.get("operationId").and_then(Value::as_str).map(String::from),
                tags: op.get("tags").and_then(Value::as_array).map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect()).unwrap_or_default(),
                summary: str_of(op, "summary"),
                deprecated: op.get("deprecated").and_then(Value::as_bool).unwrap_or(false),
                params,
                body_required,
                has_body,
                request,
                response,
                source: source(path),
            });
        }
    }
    let info = doc.get("info").cloned().unwrap_or(Value::Null);
    Ok(Spec { kind: if v3 { "openapi3" } else { "swagger2" }, title: str_of(&info, "title"), version: str_of(&info, "version"), host, base_path, endpoints, defs, raw, files: vec![] })
}

fn deref<'a>(v: &'a Value, doc: &'a Value) -> &'a Value {
    if let Some(r) = v.get("$ref").and_then(Value::as_str) {
        if let Some(p) = r.strip_prefix('#') {
            if let Some(t) = doc.pointer(p) {
                return t;
            }
        }
    }
    v
}

fn pick_content(content: Option<&Value>) -> Option<&Value> {
    let c = content?.as_object()?;
    let m = c.get("application/json").or_else(|| c.values().next())?;
    m.get("schema")
}

fn success_schema<'a>(op: &'a Value, doc: &'a Value) -> Option<&'a Value> {
    let rs = op.get("responses")?.as_object()?;
    let mut keys: Vec<&String> = rs.keys().filter(|k| k.starts_with('2')).collect();
    keys.sort();
    for k in keys {
        let r = deref(&rs[k], doc);
        if let Some(s) = r.get("schema").or_else(|| pick_content(r.get("content"))) {
            return Some(s);
        }
    }
    None
}

pub fn ref_name(r: &str) -> &str {
    r.rsplit('/').next().unwrap_or(r)
}

/// Properties and required list of a schema, following `$ref` and merging `allOf`. `array` when the schema is a list of those.
pub fn shape(schema: &Value, defs: &Map<String, Value>) -> Shape {
    let mut out = Shape::default();
    let mut cur = schema;
    for _ in 0..8 {
        let Some(c) = resolve(cur, defs) else { out.open = true; return out };
        if c.get("type").and_then(Value::as_str) == Some("array") || (c.get("items").is_some() && c.get("properties").is_none()) {
            out.array = true;
            match c.get("items") {
                Some(i) => cur = i,
                None => {
                    out.open = true;
                    return out;
                }
            }
            continue;
        }
        collect_props(c, defs, &mut out, 0);
        break;
    }
    if out.props.is_empty() {
        out.open = true;
    }
    out
}

fn resolve<'a>(v: &'a Value, defs: &'a Map<String, Value>) -> Option<&'a Value> {
    let mut cur = v;
    for _ in 0..16 {
        match cur.get("$ref").and_then(Value::as_str) {
            Some(r) => cur = defs.get(ref_name(r))?,
            None => return Some(cur),
        }
    }
    None
}

fn collect_props(c: &Value, defs: &Map<String, Value>, out: &mut Shape, depth: usize) {
    if depth > 6 {
        return;
    }
    if let Some(all) = c.get("allOf").and_then(Value::as_array) {
        for part in all {
            if let Some(p) = resolve(part, defs) {
                collect_props(p, defs, out, depth + 1);
            }
        }
    }
    for k in ["oneOf", "anyOf"] {
        if c.get(k).is_some() {
            out.open = true;
        }
    }
    if let Some(p) = c.get("properties").and_then(Value::as_object) {
        for k in p.keys() {
            if !out.props.contains(k) {
                out.props.push(k.clone());
            }
        }
    }
    if let Some(r) = c.get("required").and_then(Value::as_array) {
        for k in r.iter().filter_map(Value::as_str) {
            if !out.required.iter().any(|x| x == k) {
                out.required.push(k.to_string());
            }
        }
    }
    if c.get("additionalProperties").is_some_and(|a| !matches!(a, Value::Bool(false))) {
        out.open = true;
    }
}

// ---- schema tree for the explorer ----

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    #[serde(rename = "type")]
    pub ty: String,
    pub format: Option<String>,
    pub description: Option<String>,
    pub required: bool,
    #[serde(rename = "enum")]
    pub enum_values: Vec<Value>,
    pub example: Option<Value>,
    pub default: Option<Value>,
    pub ref_name: Option<String>,
    pub props: Vec<Prop>,
    pub items: Option<Box<Node>>,
    pub additional: Option<Box<Node>>,
    pub circular: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prop {
    pub name: String,
    pub node: Node,
}

const MAX_DEPTH: usize = 7;
const MAX_NODES: usize = 600;

pub fn node(schema: &Value, defs: &Map<String, Value>) -> Node {
    let mut budget = MAX_NODES;
    build(schema, defs, &mut Vec::new(), 0, &mut budget)
}

fn build(schema: &Value, defs: &Map<String, Value>, stack: &mut Vec<String>, depth: usize, budget: &mut usize) -> Node {
    let mut n = Node::default();
    let mut cur = schema;
    let mut refname = None;
    if let Some(r) = cur.get("$ref").and_then(Value::as_str) {
        let name = ref_name(r).to_string();
        if stack.contains(&name) {
            return Node { ty: "object".into(), ref_name: Some(name), circular: true, ..Default::default() };
        }
        match defs.get(&name) {
            Some(d) => {
                cur = d;
                refname = Some(name.clone());
                stack.push(name);
            }
            None => return Node { ty: "unknown".into(), ref_name: Some(name), ..Default::default() },
        }
    }
    let pushed = refname.is_some();
    n.ref_name = refname;
    if *budget == 0 || depth > MAX_DEPTH {
        n.truncated = true;
        n.ty = cur.get("type").and_then(Value::as_str).unwrap_or("object").into();
        if pushed {
            stack.pop();
        }
        return n;
    }
    *budget -= 1;
    let mut parts: Vec<&Value> = Vec::new();
    if let Some(all) = cur.get("allOf").and_then(Value::as_array) {
        parts.extend(all.iter());
    }
    parts.push(cur);
    let mut req: Vec<String> = Vec::new();
    for part in parts.iter().copied() {
        if part.get("$ref").is_some() && !std::ptr::eq(part, cur) {
            let sub = build(part, defs, stack, depth + 1, budget);
            for p in sub.props {
                if !n.props.iter().any(|q| q.name == p.name) {
                    n.props.push(p);
                }
            }
            continue;
        }
        if n.ty.is_empty() {
            if let Some(t) = part.get("type").and_then(Value::as_str) {
                n.ty = t.into();
            }
        }
        n.format = n.format.or_else(|| part.get("format").and_then(Value::as_str).map(String::from));
        n.description = n.description.or_else(|| part.get("description").and_then(Value::as_str).map(String::from));
        if let Some(e) = part.get("enum").and_then(Value::as_array) {
            n.enum_values = e.clone();
        }
        n.example = n.example.or_else(|| part.get("example").cloned());
        n.default = n.default.or_else(|| part.get("default").cloned());
        if let Some(r) = part.get("required").and_then(Value::as_array) {
            req.extend(r.iter().filter_map(Value::as_str).map(String::from));
        }
        if let Some(props) = part.get("properties").and_then(Value::as_object) {
            for (k, v) in props {
                let mut c = build(v, defs, stack, depth + 1, budget);
                c.required = false;
                if let Some(slot) = n.props.iter_mut().find(|p| &p.name == k) {
                    slot.node = c;
                } else {
                    n.props.push(Prop { name: k.clone(), node: c });
                }
            }
        }
        if let Some(i) = part.get("items") {
            n.items = Some(Box::new(build(i, defs, stack, depth + 1, budget)));
            if n.ty.is_empty() {
                n.ty = "array".into();
            }
        }
        if let Some(a) = part.get("additionalProperties").filter(|a| a.is_object()) {
            n.additional = Some(Box::new(build(a, defs, stack, depth + 1, budget)));
        }
    }
    for p in &mut n.props {
        p.node.required = req.contains(&p.name);
    }
    if n.ty.is_empty() {
        n.ty = "object".into();
    }
    if pushed {
        stack.pop();
    }
    n
}

/// The schema node of a named definition.
pub fn definition(spec: &Spec, name: &str) -> Option<Node> {
    let d = spec.defs.get(name)?;
    let _ = d;
    Some(node(&serde_json::json!({ "$ref": format!("#/definitions/{name}") }), &spec.defs))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseDetail {
    pub status: String,
    pub description: String,
    pub schema: Option<Node>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamDetail {
    pub name: String,
    #[serde(rename = "in")]
    pub location: String,
    pub required: bool,
    pub description: String,
    pub schema: Node,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub endpoint: Endpoint,
    pub description: String,
    pub params: Vec<ParamDetail>,
    pub request: Option<Node>,
    pub consumes: Vec<String>,
    pub responses: Vec<ResponseDetail>,
    pub secured: bool,
}

pub fn detail(spec: &Spec, id: &str) -> Option<Detail> {
    let ep = spec.endpoints.iter().find(|e| e.id == id)?.clone();
    let raw_path = ep.path.strip_prefix(spec.base_path.trim_end_matches('/')).unwrap_or(&ep.path);
    let item = spec.raw.get(raw_path).or_else(|| spec.raw.get(&ep.path))?;
    let op = item.get(ep.method.to_lowercase())?;
    let root = serde_json::json!({ "definitions": spec.defs });
    let mut params = Vec::new();
    let mut request = None;
    let shared = item.get("parameters").and_then(Value::as_array).into_iter().flatten();
    for p in shared.chain(op.get("parameters").and_then(Value::as_array).into_iter().flatten()) {
        let p = deref(p, &root);
        let loc = str_of(p, "in");
        if loc == "body" {
            request = p.get("schema").map(|s| node(s, &spec.defs));
            continue;
        }
        let schema = p.get("schema").cloned().unwrap_or_else(|| {
            let mut m = Map::new();
            for k in ["type", "format", "enum", "default", "items", "example"] {
                if let Some(v) = p.get(k) {
                    m.insert(k.into(), v.clone());
                }
            }
            Value::Object(m)
        });
        params.push(ParamDetail { name: str_of(p, "name"), required: loc == "path" || p.get("required").and_then(Value::as_bool).unwrap_or(false), description: str_of(p, "description"), location: loc, schema: node(&schema, &spec.defs) });
    }
    if let Some(rb) = op.get("requestBody") {
        request = pick_content(deref(rb, &root).get("content")).map(|s| node(s, &spec.defs));
    }
    let mut responses = Vec::new();
    if let Some(rs) = op.get("responses").and_then(Value::as_object) {
        for (status, r) in rs {
            let r = deref(r, &root);
            responses.push(ResponseDetail { status: status.clone(), description: str_of(r, "description"), schema: r.get("schema").or_else(|| pick_content(r.get("content"))).map(|s| node(s, &spec.defs)) });
        }
        responses.sort_by(|a, b| a.status.cmp(&b.status));
    }
    let consumes = op.get("consumes").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    let secured = op.get("security").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
    Some(Detail { description: str_of(op, "description"), endpoint: ep, params, request, consumes, responses, secured })
}

/// Used by the module to name the repo of the spec files for display.
pub fn describe(spec: &Spec) -> String {
    format!("{} {} ({} endpoints, {} definitions)", spec.kind, spec.version, spec.endpoints.len(), spec.defs.len())
}
