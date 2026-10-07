//! Generated wrangler config (spec 4.3 `config.rs`). Built from an ALLOW-LIST of keys, taking values from the kit's own
//! `remote-relay/wrangler.jsonc` through a string-aware JSONC reader and never copying unknown keys (no `account_id`, no routes, no
//! extra bindings, no secrets). The kit's own file is never modified; the generated one lives in the per-worker state directory and
//! is shown verbatim in the review.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::error::{DeployError, Result};
use crate::kit::{parse_jsonc, private_dir, sha256_hex, RelayKit, Snapshot};

fn bad(msg: &str) -> DeployError {
    DeployError::coded("deployFailed", format!("the relay kit's wrangler.jsonc is not usable: {msg}"))
}

/// Lowercase `a-z0-9-`, 1 to 63 characters, no leading or trailing dash (spec 3.2 step 3).
pub fn validate_worker_name(name: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name.len() <= 63
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'));
    ok.then_some(()).ok_or_else(|| DeployError::coded("nameInvalid", "a Worker name is 1 to 63 lowercase letters, digits and dashes, not starting or ending with a dash"))
}

/// A custom name with fewer than 12 characters besides dashes is easy to guess (the default has 12 random hex digits).
pub fn name_is_guessable(name: &str) -> bool {
    name.bytes().filter(|b| *b != b'-').count() < 12
}

/// `intely-relay-<12 hex>`; `random` supplies the entropy (the caller reads the OS source).
pub fn default_worker_name(random: &[u8; 6]) -> String {
    format!("intely-relay-{}", hex::encode(random))
}

/// A lowercase DNS name with at least two labels, no IP literal, not a `workers.dev` host (that is the default route).
pub fn validate_custom_domain(d: &str) -> Result<()> {
    let labels: Vec<&str> = d.split('.').collect();
    let label_ok = |l: &&str| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'));
    let ok = d.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(label_ok)
        && !labels.last().is_some_and(|t| t.bytes().all(|b| b.is_ascii_digit()))
        && !d.ends_with(".workers.dev");
    ok.then_some(()).ok_or_else(|| DeployError::coded("nameInvalid", "the custom domain is not a valid lowercase host name"))
}

fn ident(v: &Value) -> Option<&str> {
    let s = v.as_str()?;
    (!s.is_empty() && s.len() <= 64 && !s.starts_with(|c: char| c.is_ascii_digit()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')).then_some(s)
}

/// One thing the deploy creates or overwrites, for the review list. Data only, never a sentence: the UI picks the text for `kind`
/// in its own language (`remote.cloud.res.<kind>`) and fills in `label` (a name, a domain or a variable name) and `detail` (a
/// migration tag). `label` is empty when the kind says it all (`assets`, `routeWorkersDev`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Resource {
    pub kind: &'static str,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Resource {
    pub fn new(kind: &'static str, label: impl Into<String>) -> Self {
        Self { kind, label: label.into(), detail: None }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ConfigOpts {
    pub custom_domain: Option<String>,
    /// Echoed by `/api/status` (`stamp`): proves a later name check that this install deployed the Worker.
    pub stamp: String,
}

#[derive(Debug, Clone)]
pub struct GeneratedConfig {
    pub path: PathBuf,
    pub text: String,
    pub resources: Vec<Resource>,
    /// sha256 over the snapshot hash and the config shape without the hash variable itself (stored as `cloud.relayCodeHash`).
    pub relay_code_hash: String,
}

/// Pure core: kit config text in, generated config text out.
pub fn build(source_jsonc: &str, worker_name: &str, snapshot: &Snapshot, opts: &ConfigOpts) -> Result<(String, Vec<Resource>, String)> {
    validate_worker_name(worker_name)?;
    if let Some(d) = &opts.custom_domain {
        validate_custom_domain(d)?;
    }
    let src = parse_jsonc(source_jsonc).map_err(|_| bad("not parseable"))?;
    let mut out = Map::new();
    let mut resources = vec![Resource::new("worker", worker_name)];

    out.insert("name".into(), json!(worker_name));
    out.insert("main".into(), json!(snapshot.main));
    let date = src["compatibility_date"].as_str().filter(|d| d.len() == 10 && d.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() }));
    out.insert("compatibility_date".into(), json!(date.ok_or_else(|| bad("compatibility_date"))?));
    out.insert("observability".into(), json!({ "enabled": false }));

    // assets: the directory is always the staged copy; the other keys are checked against known values.
    let a = &src["assets"];
    let mut assets = Map::new();
    assets.insert("directory".into(), json!("dist"));
    if let Some(b) = a.get("binding") {
        assets.insert("binding".into(), json!(ident(b).ok_or_else(|| bad("assets.binding"))?));
    }
    if let Some(h) = a.get("html_handling") {
        let h = h.as_str().filter(|h| matches!(*h, "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none")).ok_or_else(|| bad("assets.html_handling"))?;
        assets.insert("html_handling".into(), json!(h));
    }
    if let Some(n) = a.get("not_found_handling") {
        let n = n.as_str().filter(|n| matches!(*n, "single-page-application" | "404-page" | "none")).ok_or_else(|| bad("assets.not_found_handling"))?;
        assets.insert("not_found_handling".into(), json!(n));
    }
    if let Some(r) = a.get("run_worker_first") {
        let list = r.as_array().filter(|l| l.len() <= 20).ok_or_else(|| bad("assets.run_worker_first"))?;
        let mut pats = Vec::new();
        for p in list {
            let p = p.as_str().filter(|p| p.len() <= 100 && (p.starts_with('/') || p.starts_with("!/")) && p.bytes().all(|b| b.is_ascii_graphic())).ok_or_else(|| bad("assets.run_worker_first"))?;
            pats.push(json!(p));
        }
        assets.insert("run_worker_first".into(), Value::Array(pats));
    }
    out.insert("assets".into(), Value::Object(assets));

    // Durable Object bindings (names and classes only; no script_name, so only this Worker's own classes).
    if let Some(bindings) = src["durable_objects"]["bindings"].as_array() {
        let mut list = Vec::new();
        for b in bindings {
            let (name, class) = (ident(&b["name"]), ident(&b["class_name"]));
            let (Some(name), Some(class)) = (name, class) else { return Err(bad("durable_objects.bindings")) };
            list.push(json!({ "name": name, "class_name": class }));
        }
        out.insert("durable_objects".into(), json!({ "bindings": list }));
    }
    if let Some(migrations) = src["migrations"].as_array() {
        let mut list = Vec::new();
        for m in migrations {
            let tag = m["tag"].as_str().filter(|t| !t.is_empty() && t.len() <= 32 && t.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))).ok_or_else(|| bad("migrations.tag"))?;
            let mut entry = Map::new();
            entry.insert("tag".into(), json!(tag));
            if let Some(classes) = m.get("new_sqlite_classes") {
                let names: Vec<&str> = classes.as_array().ok_or_else(|| bad("migrations.new_sqlite_classes"))?.iter().map(|c| ident(c).ok_or_else(|| bad("migrations.new_sqlite_classes"))).collect::<Result<_>>()?;
                for n in &names {
                    resources.push(Resource { kind: "durableObject", label: (*n).to_owned(), detail: Some(tag.to_owned()) });
                }
                entry.insert("new_sqlite_classes".into(), json!(names));
            }
            list.push(Value::Object(entry));
        }
        out.insert("migrations".into(), Value::Array(list));
    }

    // vars: only the join rate from the kit, plus the echo values the deploy tooling owns.
    let mut vars = Map::new();
    if let Some(rate) = src["vars"]["JOIN_RATE_PER_MIN"].as_str() {
        if rate.is_empty() || rate.len() > 5 || !rate.bytes().all(|b| b.is_ascii_digit()) {
            return Err(bad("vars.JOIN_RATE_PER_MIN"));
        }
        vars.insert("JOIN_RATE_PER_MIN".into(), json!(rate));
    }
    if !opts.stamp.is_empty() {
        if !opts.stamp.bytes().all(|b| b.is_ascii_hexdigit()) || opts.stamp.len() > 64 {
            return Err(bad("stamp"));
        }
        vars.insert("RELAY_STAMP".into(), json!(opts.stamp));
    }
    // The code hash covers the snapshot and the config shape; the variable that carries it is added afterwards.
    let (workers_dev, routes) = match &opts.custom_domain {
        Some(d) => (false, Some(json!([{ "pattern": d, "custom_domain": true }]))),
        None => (true, None),
    };
    out.insert("workers_dev".into(), json!(workers_dev));
    out.insert("preview_urls".into(), json!(false));
    match &opts.custom_domain {
        Some(d) => resources.push(Resource::new("route", d.clone())),
        None => resources.push(Resource::new("routeWorkersDev", "")),
    }
    if let Some(r) = routes {
        out.insert("routes".into(), r);
    }
    out.insert("vars".into(), Value::Object(vars.clone()));
    let shape = serde_json::to_string(&sorted(Value::Object(out.clone()))).map_err(|e| bad(&e.to_string()))?;
    let code_hash = sha256_hex(format!("{}\n{shape}", snapshot.hash).as_bytes());
    vars.insert("RELAY_CODE_HASH".into(), json!(code_hash));
    out.insert("vars".into(), Value::Object(vars));
    let text = serde_json::to_string_pretty(&sorted(Value::Object(out))).map_err(|e| bad(&e.to_string()))? + "\n";
    Ok((text, resources, code_hash))
}

/// Keys in sorted order at every level. `serde_json` keeps insertion order when any crate of the build turns on
/// `preserve_order` (the Mongo module does), and the code hash must not depend on which crates are compiled in.
fn sorted(v: Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut pairs: Vec<(String, Value)> = m.into_iter().collect();
            pairs.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Object(pairs.into_iter().map(|(k, v)| (k, sorted(v))).collect())
        }
        Value::Array(a) => Value::Array(a.into_iter().map(sorted).collect()),
        other => other,
    }
}

/// Reads the kit's `wrangler.jsonc`, builds the config and writes it to `<worker_dir>/wrangler.jsonc` (directory mode 0700). The
/// paths inside the config (`kit/src/index.ts`, `dist`) are relative to that file.
pub fn generate(kit: &RelayKit, worker_name: &str, snapshot: &Snapshot, worker_dir: &Path, opts: &ConfigOpts) -> Result<GeneratedConfig> {
    let source = kit.wrangler_config_text()?;
    let (text, resources, relay_code_hash) = build(&source, worker_name, snapshot, opts)?;
    private_dir(worker_dir)?;
    let path = worker_dir.join("wrangler.jsonc");
    fs::write(&path, &text)?;
    Ok(GeneratedConfig { path, text, resources, relay_code_hash })
}
