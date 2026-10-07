//! Compares the calls found in client repos with the backend contract and builds the report.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::matcher::{ratio, Index};
use crate::scan::{scan_repo, Call};
use crate::spec::{Endpoint, Source, Spec};
use crate::git;

pub struct ClientInput {
    pub id: String,
    pub root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Site {
    pub repo_id: String,
    pub file: String,
    pub line: usize,
    pub col: usize,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub id: String,
    pub method: String,
    pub path: String,
    pub operation_id: Option<String>,
    pub similarity: f32,
    pub source: Source,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    /// missing | renamed | method | requiredParam | responseField | deprecated | tagMismatch
    pub kind: String,
    /// error | warn | info
    pub severity: String,
    /// high | medium | low: how sure the detector is that this is a real mismatch.
    pub confidence: String,
    pub heuristic: bool,
    pub repo_id: String,
    pub site: Site,
    /// What the client calls: `GET /api/x/{}` or `Banks.getBanks`.
    pub target: String,
    pub suggestion: Option<Suggestion>,
    pub names: Vec<String>,
    pub allowed: Vec<String>,
    /// The swagger endpoint involved (where the call matched), for "open swagger path".
    pub swagger: Option<Source>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub files: usize,
    pub calls: usize,
    pub matched: usize,
    pub errors: usize,
    pub warnings: usize,
    pub infos: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientReport {
    pub repo_id: String,
    pub fingerprint: String,
    pub cached: bool,
    pub counts: Counts,
    pub findings: Vec<Finding>,
    /// Endpoint id -> call sites (at most 5 each).
    pub usage: BTreeMap<String, Vec<Site>>,
    /// Per source file: (calls, errors, warnings). Feeds the Changes tree badge.
    pub files: BTreeMap<String, (usize, usize, usize)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unused {
    pub id: String,
    pub method: String,
    pub path: String,
    pub operation_id: Option<String>,
    pub tags: Vec<String>,
    pub deprecated: bool,
    pub source: Source,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecInfo {
    pub repo_id: String,
    pub kind: String,
    pub title: String,
    pub version: String,
    pub host: String,
    pub files: Vec<String>,
    pub endpoints: usize,
    pub definitions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub fingerprint: String,
    pub spec: SpecInfo,
    pub clients: Vec<ClientReport>,
    pub unused: Vec<Unused>,
    /// The endpoint list of the explorer (summary rows).
    pub endpoints: Vec<Endpoint>,
    pub definitions: Vec<String>,
}

#[derive(Default)]
pub struct Cache {
    map: Mutex<HashMap<String, ClientReport>>,
}

impl Cache {
    pub fn len(&self) -> usize {
        self.map.lock().map(|m| m.len()).unwrap_or(0)
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

pub fn spec_fingerprint(spec_root: &Path) -> String {
    git::fingerprint(spec_root)
}

/// Runs the whole comparison. Client results are cached per (spec state, client state), so a repo whose commit and
/// working tree did not move is not scanned again.
pub fn analyze(spec: &Spec, spec_repo_id: &str, spec_fp: &str, clients: &[ClientInput], cache: &Cache) -> Report {
    let index = Index::new(&spec.endpoints);
    let mut reports = Vec::new();
    for c in clients {
        let fp = git::fingerprint(&c.root);
        let key = format!("{spec_fp}|{}|{fp}", c.id);
        if let Some(hit) = cache.map.lock().ok().and_then(|m| m.get(&key).cloned()) {
            reports.push(ClientReport { cached: true, ..hit });
            continue;
        }
        let files = git::list_files(&c.root);
        let (calls, scanned) = scan_repo(&c.root, &files);
        let mut r = check_client(&index, spec, &c.id, &calls, scanned);
        r.fingerprint = fp;
        if let Ok(mut m) = cache.map.lock() {
            if m.len() > 64 {
                m.clear();
            }
            m.insert(key, r.clone());
        }
        reports.push(r);
    }
    let used: HashSet<&str> = reports.iter().flat_map(|r| r.usage.keys().map(String::as_str)).collect();
    let mut unused: Vec<Unused> = spec
        .endpoints
        .iter()
        .filter(|e| !used.contains(e.id.as_str()))
        .map(|e| Unused { id: e.id.clone(), method: e.method.clone(), path: e.path.clone(), operation_id: e.operation_id.clone(), tags: e.tags.clone(), deprecated: e.deprecated, source: e.source.clone() })
        .collect();
    unused.truncate(6000);
    let mut defs: Vec<String> = spec.defs.keys().cloned().collect();
    defs.sort();
    let fingerprint = format!("{spec_fp}+{}", reports.iter().map(|r| r.fingerprint.as_str()).collect::<Vec<_>>().join("+"));
    Report {
        fingerprint,
        spec: SpecInfo { repo_id: spec_repo_id.into(), kind: spec.kind.into(), title: spec.title.clone(), version: spec.version.clone(), host: spec.host.clone(), files: spec.files.iter().take(8).cloned().collect(), endpoints: spec.endpoints.len(), definitions: spec.defs.len() },
        clients: reports,
        unused,
        endpoints: spec.endpoints.clone(),
        definitions: defs,
    }
}

fn site(repo: &str, c: &Call) -> Site {
    Site { repo_id: repo.into(), file: c.file.clone(), line: c.line, col: c.col, snippet: c.snippet.clone() }
}

fn suggestion(e: &Endpoint, sim: f32) -> Suggestion {
    Suggestion { id: e.id.clone(), method: e.method.clone(), path: e.path.clone(), operation_id: e.operation_id.clone(), similarity: (sim * 100.0).round() / 100.0, source: e.source.clone() }
}

const NOT_A_CALL_FIRST_SEGMENTS: [&str; 6] = ["login", "logout", "home", "settings", "profile", "dashboard"];

pub fn check_client(index: &Index, spec: &Spec, repo: &str, calls: &[Call], scanned: usize) -> ClientReport {
    let mut findings: Vec<Finding> = Vec::new();
    let mut usage: BTreeMap<String, Vec<Site>> = BTreeMap::new();
    let mut files: BTreeMap<String, (usize, usize, usize)> = BTreeMap::new();
    let mut matched = 0usize;
    let mut seq = 0usize;
    let mut push = |findings: &mut Vec<Finding>, kind: &str, sev: &str, conf: &str, heuristic: bool, c: &Call, target: String, f: &dyn Fn(&mut Finding)| {
        seq += 1;
        let mut fi = Finding { id: format!("{repo}:{}:{}:{seq}", c.file, c.line), kind: kind.into(), severity: sev.into(), confidence: conf.into(), heuristic, repo_id: repo.into(), site: site(repo, c), target, suggestion: None, names: vec![], allowed: vec![], swagger: None };
        f(&mut fi);
        findings.push(fi);
    };
    for c in calls {
        let entry = files.entry(c.file.clone()).or_default();
        entry.0 += 1;
        let before = findings.len();
        let mut hit: Option<usize> = None;
        match c.kind.as_str() {
            "swagger-client" => {
                let (tag, op) = (c.tag.clone().unwrap_or_default(), c.operation.clone().unwrap_or_default());
                let target = format!("{tag}.{op}");
                let ids = index.by_operation(&op);
                let exact = ids.iter().copied().find(|i| index.eps[*i].tags.iter().any(|t| t == &tag));
                match (exact, ids.first()) {
                    (Some(i), _) => hit = Some(i),
                    (None, Some(&i)) => {
                        let e = &index.eps[i];
                        push(&mut findings, "tagMismatch", "warn", "medium", false, c, target, &|f| {
                            f.names = e.tags.clone();
                            f.suggestion = Some(suggestion(e, 1.0));
                            f.swagger = Some(e.source.clone());
                        });
                    }
                    (None, None) => {
                        let best = index
                            .operation_ids()
                            .map(|o| {
                                let same_tag = index.by_operation(o).iter().any(|i| index.eps[*i].tags.iter().any(|t| t == &tag));
                                (ratio(&op, o) + if same_tag { 0.1 } else { 0.0 }, o)
                            })
                            .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(b.1.cmp(a.1)));
                        let sug = best.filter(|(s, _)| *s >= 0.65).map(|(s, o)| (s, index.by_operation(o)[0]));
                        let kind = if sug.is_some() { "renamed" } else { "missing" };
                        push(&mut findings, kind, "error", "high", false, c, target, &|f| {
                            if let Some((s, i)) = sug {
                                f.suggestion = Some(suggestion(&index.eps[i], s.min(1.0)));
                            }
                        });
                    }
                }
                if let Some(i) = hit {
                    check_swagger_client_params(index, i, c, &mut findings, &mut push);
                }
            }
            _ => {
                let path = c.path.clone().unwrap_or_default();
                let reference = c.kind == "reference";
                let first = path.split('/').nth(1).unwrap_or("");
                if reference && NOT_A_CALL_FIRST_SEGMENTS.contains(&first) {
                    continue;
                }
                let cands = index.candidates(&path);
                let target = match &c.method {
                    Some(m) => format!("{m} {path}"),
                    None => path.clone(),
                };
                if cands.is_empty() {
                    let near = index.nearest(&path, c.method.as_deref()).filter(|(_, s)| *s >= 0.6);
                    let kind = if near.is_some() { "renamed" } else { "missing" };
                    let (sev, conf) = if reference { ("warn", "low") } else { ("error", "medium") };
                    push(&mut findings, kind, sev, conf, reference, c, target, &|f| {
                        if let Some((i, s)) = near {
                            f.suggestion = Some(suggestion(&index.eps[i], s));
                        }
                    });
                } else if let Some(m) = &c.method {
                    match cands.iter().copied().find(|i| &index.eps[*i].method == m) {
                        Some(i) => hit = Some(i),
                        None => {
                            let best = cands[0];
                            let mut allowed: Vec<String> = cands.iter().filter(|i| index.eps[**i].path == index.eps[best].path).map(|i| index.eps[*i].method.clone()).collect();
                            allowed.dedup();
                            let e = &index.eps[best];
                            // the client does use this path (with the wrong verb): it is not an unused endpoint
                            let v = usage.entry(e.id.clone()).or_default();
                            if v.len() < 5 {
                                v.push(site(repo, c));
                            }
                            let conf = if c.method_guessed || index.loose(&path, best) { "low" } else { "medium" };
                            push(&mut findings, "method", "error", conf, conf == "low", c, target, &|f| {
                                f.allowed = allowed.clone();
                                f.swagger = Some(e.source.clone());
                                f.suggestion = allowed.first().map(|_| suggestion(e, 1.0));
                            });
                        }
                    }
                } else {
                    // method unknown (endpoint table): any method at the path counts as used
                    for i in cands.iter().copied().filter(|i| index.eps[*i].path == index.eps[cands[0]].path) {
                        usage.entry(index.eps[i].id.clone()).or_default();
                        let v = usage.get_mut(&index.eps[i].id).unwrap();
                        if v.len() < 5 {
                            v.push(site(repo, c));
                        }
                    }
                    matched += 1;
                    continue;
                }
                if let Some(i) = hit {
                    check_http_params(index, i, c, &path, &mut findings, &mut push);
                }
            }
        }
        if let Some(i) = hit {
            matched += 1;
            let e = &index.eps[i];
            let v = usage.entry(e.id.clone()).or_default();
            if v.len() < 5 {
                v.push(site(repo, c));
            }
            if e.deprecated {
                push(&mut findings, "deprecated", "warn", "high", false, c, e.id.clone(), &|f| f.swagger = Some(e.source.clone()));
            }
            check_reads(e, c, &mut findings, &mut push);
        }
        for f in &findings[before..] {
            match f.severity.as_str() {
                "error" => entry.1 += 1,
                "warn" => entry.2 += 1,
                _ => {}
            }
        }
    }
    let count = |s: &str| findings.iter().filter(|f| f.severity == s).count();
    let counts = Counts { files: scanned, calls: calls.len(), matched, errors: count("error"), warnings: count("warn"), infos: count("info") };
    let _ = spec;
    let sev_rank = |s: &str| match s {
        "error" => 0,
        "warn" => 1,
        _ => 2,
    };
    findings.sort_by(|a, b| sev_rank(&a.severity).cmp(&sev_rank(&b.severity)).then(a.site.file.cmp(&b.site.file)).then(a.site.line.cmp(&b.site.line)));
    findings.truncate(4000);
    ClientReport { repo_id: repo.into(), fingerprint: String::new(), cached: false, counts, findings, usage, files }
}

type Push<'a> = dyn FnMut(&mut Vec<Finding>, &str, &str, &str, bool, &Call, String, &dyn Fn(&mut Finding)) + 'a;

fn check_swagger_client_params(index: &Index, i: usize, c: &Call, findings: &mut Vec<Finding>, push: &mut Push) {
    let e = &index.eps[i];
    let Some(keys) = &c.keys else { return };
    let mut missing: Vec<String> = e.params.iter().filter(|p| p.required && p.location != "header" && !keys.contains(&p.name)).map(|p| p.name.clone()).collect();
    if e.has_body && e.body_required && !keys.iter().any(|k| k == "body" || k == "requestBody") {
        missing.push("body".into());
    }
    if !missing.is_empty() {
        push(findings, "requiredParam", "warn", "medium", false, c, format!("{}.{}", c.tag.clone().unwrap_or_default(), c.operation.clone().unwrap_or_default()), &|f| {
            f.names = missing.clone();
            f.swagger = Some(e.source.clone());
        });
    }
}

fn check_http_params(index: &Index, i: usize, c: &Call, path: &str, findings: &mut Vec<Finding>, push: &mut Push) {
    let e = &index.eps[i];
    let Some(q) = &c.query_keys else { return };
    // only when the call visibly builds a query (a literal query string or a params object)
    if q.is_empty() && !c.snippet.contains('?') && !c.snippet.contains("params") {
        return;
    }
    let missing: Vec<String> = e.params.iter().filter(|p| p.required && p.location == "query" && !q.contains(&p.name)).map(|p| p.name.clone()).collect();
    if !missing.is_empty() {
        push(findings, "requiredParam", "warn", "low", true, c, format!("{} {path}", c.method.clone().unwrap_or_default()), &|f| {
            f.names = missing.clone();
            f.swagger = Some(e.source.clone());
        });
    }
}

fn check_reads(e: &Endpoint, c: &Call, findings: &mut Vec<Finding>, push: &mut Push) {
    let Some(shape) = &e.response else { return };
    if shape.open || shape.array || c.reads.is_empty() {
        return;
    }
    let unknown: Vec<String> = c.reads.iter().filter(|r| !shape.props.contains(r) && !r.starts_with('_') && r.as_str() != "message").cloned().collect();
    if !unknown.is_empty() {
        let target = match (&c.tag, &c.operation) {
            (Some(t), Some(o)) => format!("{t}.{o}"),
            _ => e.id.clone(),
        };
        push(findings, "responseField", "info", "low", true, c, target, &|f| {
            f.names = unknown.clone();
            f.swagger = Some(e.source.clone());
        });
    }
}
