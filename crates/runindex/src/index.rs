//! The session search index: a compact in-memory inverted index over the run documents, built lazily from the JSONL
//! logs (`<data dir>/runs/*.jsonl`) and refreshed incrementally (only runs whose log or meta file changed are read
//! again). Persisted as one JSON file of documents (the postings are rebuilt on load), so a restart does not re-read
//! the logs. No dependency beyond serde: a SQLite FTS5 index was not needed for a few hundred logs.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::doc::{extract, parse_log, MetaFile, RunDoc};

pub const VERSION: u32 = 1;
/// A log larger than this is not indexed (it would also be unreadable in the Inspector).
const MAX_LOG_BYTES: u64 = 64 * 1024 * 1024;

const F_TITLE: u8 = 1;
const F_PROMPT: u8 = 2;
const F_REPLY: u8 = 4;
const F_TOOL: u8 = 8;
const F_FILE: u8 = 16;
const F_META: u8 = 32;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sig {
    len: u64,
    mtime_ms: u64,
    meta_len: u64,
    meta_mtime_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    sig: Sig,
    doc: RunDoc,
}

#[derive(Serialize, Deserialize)]
struct Saved {
    version: u32,
    entries: Vec<Entry>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshStats {
    pub added: u32,
    pub updated: u32,
    pub removed: u32,
    pub unchanged: u32,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    /// Words (all must match, the last may be a prefix; every word matches by prefix) and `"quoted phrases"`.
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub from_ms: Option<u64>,
    #[serde(default)]
    pub to_ms: Option<u64>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    /// `title` | `prompt` | `reply` | `tool` | `file`
    pub field: String,
    pub text: String,
    /// Highlighted ranges as `[start, end)` character offsets into `text`.
    pub marks: Vec<[u32; 2]>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub run_id: String,
    pub title: String,
    pub role: String,
    pub model: String,
    pub repo_ids: Vec<String>,
    pub status: String,
    pub started_ms: u64,
    pub ended_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    pub score: u32,
    pub snippets: Vec<Snippet>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<Hit>,
    /// Matches before the limit.
    pub total: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counted {
    pub value: String,
    pub count: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facets {
    pub repos: Vec<Counted>,
    pub roles: Vec<Counted>,
    pub models: Vec<Counted>,
    pub statuses: Vec<Counted>,
}

/// Lowercase alphanumeric words of at least two characters (digits count).
pub fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 2).map(|w| w.to_lowercase()).collect()
}

/// `Vec<char>` of the lowercase text with one char per original char (so offsets stay valid).
fn fold(text: &str) -> Vec<char> {
    text.chars().map(|c| c.to_lowercase().next().unwrap_or(c)).collect()
}

fn find_all(hay: &[char], needle: &[char], out: &mut Vec<(usize, usize)>) {
    if needle.is_empty() || needle.len() > hay.len() {
        return;
    }
    let mut i = 0;
    while i + needle.len() <= hay.len() {
        if hay[i..i + needle.len()] == *needle {
            out.push((i, i + needle.len()));
            i += needle.len();
        } else {
            i += 1;
        }
    }
}

struct Parsed {
    terms: Vec<String>,
    phrases: Vec<String>,
}

fn parse(text: &str) -> Parsed {
    let mut terms = Vec::new();
    let mut phrases = Vec::new();
    for (i, part) in text.split('"').enumerate() {
        if i % 2 == 1 {
            let p = part.trim().to_lowercase();
            if !p.is_empty() {
                terms.extend(tokens(&p));
                phrases.push(p);
            }
        } else {
            terms.extend(tokens(part));
        }
    }
    terms.dedup();
    Parsed { terms, phrases }
}

fn doc_fields(doc: &RunDoc) -> Vec<(u8, String)> {
    let mut out = vec![(F_TITLE, doc.title.clone())];
    out.extend(doc.prompts.iter().map(|p| (F_PROMPT, p.clone())));
    out.extend(doc.replies.iter().map(|p| (F_REPLY, p.clone())));
    out.extend(doc.tools.iter().map(|p| (F_TOOL, p.clone())));
    out.extend(doc.files.iter().map(|p| (F_FILE, p.clone())));
    let meta = format!("{} {} {} {}", doc.role, doc.model, doc.repo_ids.join(" "), doc.status);
    out.push((F_META, meta));
    out
}

fn weight(bit: u8) -> u32 {
    match bit {
        F_TITLE => 6,
        F_PROMPT => 4,
        F_FILE => 3,
        F_TOOL => 2,
        F_META => 2,
        _ => 1,
    }
}

fn field_name(bit: u8) -> &'static str {
    match bit {
        F_TITLE => "title",
        F_PROMPT => "prompt",
        F_FILE => "file",
        F_TOOL => "tool",
        _ => "reply",
    }
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

#[derive(Default)]
pub struct Index {
    entries: BTreeMap<String, Entry>,
    postings: BTreeMap<String, BTreeMap<String, u8>>,
}

impl Index {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Ids of the runs that started at or after `ms`, oldest first.
    pub fn ids_since(&self, ms: u64) -> Vec<String> {
        let mut docs: Vec<&RunDoc> = self.entries.values().map(|e| &e.doc).filter(|d| d.started_ms >= ms).collect();
        docs.sort_by(|a, b| a.started_ms.cmp(&b.started_ms).then(a.id.cmp(&b.id)));
        docs.into_iter().map(|d| d.id.clone()).collect()
    }

    pub fn doc(&self, id: &str) -> Option<&RunDoc> {
        self.entries.get(id).map(|e| &e.doc)
    }

    /// Loads a saved index; a missing, unreadable or other-version file gives an empty one (the next refresh rebuilds it).
    pub fn load(path: &Path) -> Self {
        let Some(saved) = fs::read(path).ok().and_then(|b| serde_json::from_slice::<Saved>(&b).ok()).filter(|s| s.version == VERSION) else { return Self::new() };
        let mut idx = Self::new();
        for e in saved.entries {
            idx.put(e);
        }
        idx
    }

    /// Writes the documents (already scrubbed) next to the other state files, owner-only, atomically.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        if let Some(dir) = path.parent() {
            intely_agent_core::events::log::create_private_dir_all(dir)?;
        }
        let saved = Saved { version: VERSION, entries: self.entries.values().cloned().collect() };
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec(&saved).map_err(io::Error::other)?)?;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
        fs::rename(&tmp, path)
    }

    fn unindex(&mut self, id: &str) {
        let Some(old) = self.entries.get(id) else { return };
        let mut words = BTreeSet::new();
        for (_, text) in doc_fields(&old.doc) {
            words.extend(tokens(&text));
        }
        for w in words {
            if let Some(m) = self.postings.get_mut(&w) {
                m.remove(id);
                if m.is_empty() {
                    self.postings.remove(&w);
                }
            }
        }
    }

    fn put(&mut self, entry: Entry) {
        self.unindex(&entry.doc.id);
        for (bit, text) in doc_fields(&entry.doc) {
            for w in tokens(&text) {
                *self.postings.entry(w).or_default().entry(entry.doc.id.clone()).or_insert(0) |= bit;
            }
        }
        self.entries.insert(entry.doc.id.clone(), entry);
    }

    pub fn remove(&mut self, id: &str) -> bool {
        self.unindex(id);
        self.entries.remove(id).is_some()
    }

    /// Adds a document without a backing file (tests and callers that hold events already).
    pub fn insert_doc(&mut self, doc: RunDoc) {
        self.put(Entry { sig: Sig::default(), doc });
    }

    /// Reads the runs that are new or changed since the last refresh and drops the ones whose log is gone.
    pub fn refresh(&mut self, runs_dir: &Path) -> RefreshStats {
        let mut stats = RefreshStats::default();
        let mut seen = BTreeSet::new();
        let listing = fs::read_dir(runs_dir).map(|d| d.flatten().collect::<Vec<_>>()).unwrap_or_default();
        for item in listing {
            let path = item.path();
            let Some(id) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".jsonl")).map(str::to_owned) else { continue };
            let Ok(md) = item.metadata() else { continue };
            if md.len() > MAX_LOG_BYTES {
                continue;
            }
            let meta_path = runs_dir.join(format!("{id}.meta.json"));
            let (meta_len, meta_mtime_ms) = fs::metadata(&meta_path).map(|m| (m.len(), mtime_ms(&m))).unwrap_or((0, 0));
            let sig = Sig { len: md.len(), mtime_ms: mtime_ms(&md), meta_len, meta_mtime_ms };
            seen.insert(id.clone());
            let known = self.entries.get(&id).map(|e| e.sig);
            if known == Some(sig) {
                stats.unchanged += 1;
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else { continue };
            let meta = fs::read(&meta_path).ok().and_then(|b| serde_json::from_slice::<MetaFile>(&b).ok());
            let doc = extract(&id, &parse_log(&text), meta.as_ref());
            self.put(Entry { sig, doc });
            if known.is_some() {
                stats.updated += 1;
            } else {
                stats.added += 1;
            }
        }
        let gone: Vec<String> = self.entries.keys().filter(|k| !seen.contains(*k) && self.entries[*k].sig != Sig::default()).cloned().collect();
        for id in gone {
            self.remove(&id);
            stats.removed += 1;
        }
        stats
    }

    pub fn facets(&self) -> Facets {
        fn count(items: impl Iterator<Item = String>) -> Vec<Counted> {
            let mut m: BTreeMap<String, u32> = BTreeMap::new();
            for v in items.filter(|v| !v.is_empty()) {
                *m.entry(v).or_default() += 1;
            }
            let mut out: Vec<Counted> = m.into_iter().map(|(value, count)| Counted { value, count }).collect();
            out.sort_by(|a, b| b.count.cmp(&a.count).then(a.value.cmp(&b.value)));
            out
        }
        let docs = || self.entries.values().map(|e| &e.doc);
        Facets {
            repos: count(docs().flat_map(|d| d.repo_ids.iter().cloned())),
            roles: count(docs().map(|d| d.role.clone())),
            models: count(docs().map(|d| d.model.clone())),
            statuses: count(docs().map(|d| d.status.clone())),
        }
    }

    fn passes(doc: &RunDoc, q: &Query) -> bool {
        q.repo.as_deref().filter(|r| !r.is_empty()).map_or(true, |r| doc.repo_ids.iter().any(|d| d == r))
            && q.role.as_deref().filter(|r| !r.is_empty()).map_or(true, |r| doc.role.eq_ignore_ascii_case(r))
            && q.model.as_deref().filter(|r| !r.is_empty()).map_or(true, |r| doc.model.to_lowercase().contains(&r.to_lowercase()))
            && q.status.as_deref().filter(|r| !r.is_empty()).map_or(true, |r| doc.status == r)
            && q.from_ms.map_or(true, |f| doc.started_ms >= f)
            && q.to_ms.map_or(true, |t| doc.started_ms <= t)
    }

    pub fn search(&self, q: &Query) -> SearchResult {
        let parsed = parse(&q.text);
        let limit = q.limit.unwrap_or(50).clamp(1, 200) as usize;
        // Candidate documents with the fields each term hit.
        let mut cands: Option<BTreeMap<String, Vec<u8>>> = None;
        for term in &parsed.terms {
            let mut hit: BTreeMap<String, u8> = BTreeMap::new();
            for (word, docs) in self.postings.range(term.clone()..) {
                if !word.starts_with(term.as_str()) {
                    break;
                }
                for (id, mask) in docs {
                    *hit.entry(id.clone()).or_insert(0) |= mask;
                }
            }
            cands = Some(match cands {
                None => hit.into_iter().map(|(id, m)| (id, vec![m])).collect(),
                Some(prev) => prev
                    .into_iter()
                    .filter_map(|(id, mut masks)| {
                        hit.get(&id).map(|m| {
                            masks.push(*m);
                            (id, masks)
                        })
                    })
                    .collect(),
            });
            if cands.as_ref().is_some_and(|c| c.is_empty()) {
                return SearchResult::default();
            }
        }
        let pool: Vec<(&Entry, u32)> = match cands {
            Some(c) => c.into_iter().filter_map(|(id, masks)| self.entries.get(&id).map(|e| (e, masks.iter().map(|m| [F_TITLE, F_PROMPT, F_FILE, F_TOOL, F_META, F_REPLY].iter().filter(|b| m & **b != 0).map(|b| weight(*b)).sum::<u32>()).sum()))).collect(),
            None => self.entries.values().map(|e| (e, 0)).collect(),
        };
        let lowered = |s: &str| s.to_lowercase();
        let mut scored: Vec<(&Entry, u32)> = pool
            .into_iter()
            .filter(|(e, _)| Self::passes(&e.doc, q))
            .filter(|(e, _)| parsed.phrases.iter().all(|p| doc_fields(&e.doc).iter().any(|(_, t)| lowered(t).contains(p.as_str()))))
            .collect();
        scored.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.doc.started_ms.cmp(&a.0.doc.started_ms)).then(a.0.doc.id.cmp(&b.0.doc.id)));
        let total = scored.len() as u32;
        let hits = scored.into_iter().take(limit).map(|(e, score)| hit_of(&e.doc, score, &parsed)).collect();
        SearchResult { hits, total }
    }
}

fn hit_of(doc: &RunDoc, score: u32, parsed: &Parsed) -> Hit {
    Hit {
        run_id: doc.id.clone(),
        title: doc.title.clone(),
        role: doc.role.clone(),
        model: doc.model.clone(),
        repo_ids: doc.repo_ids.clone(),
        status: doc.status.clone(),
        started_ms: doc.started_ms,
        ended_ms: doc.ended_ms,
        cost_usd: doc.cost_usd,
        score,
        snippets: snippets(doc, parsed),
    }
}

/// Up to three snippets, one per kind of field, best kinds first.
fn snippets(doc: &RunDoc, parsed: &Parsed) -> Vec<Snippet> {
    let mut needles: Vec<Vec<char>> = parsed.phrases.iter().map(|p| fold(p)).collect();
    needles.extend(parsed.terms.iter().map(|t| fold(t)));
    if needles.is_empty() {
        return doc.prompts.first().map(|p| vec![window(p, &[], 0)]).unwrap_or_default();
    }
    let mut out: Vec<Snippet> = Vec::new();
    for bit in [F_TITLE, F_PROMPT, F_FILE, F_TOOL, F_REPLY] {
        if out.len() >= 3 {
            break;
        }
        for (b, text) in doc_fields(doc) {
            if b != bit {
                continue;
            }
            let hay = fold(&text);
            let mut found = Vec::new();
            for n in &needles {
                find_all(&hay, n, &mut found);
            }
            if let Some(first) = found.iter().map(|f| f.0).min() {
                let mut s = window(&text, &found, first);
                s.field = field_name(bit).to_owned();
                out.push(s);
                break;
            }
        }
    }
    out
}

/// A window of about 160 characters around `at`, with the matches inside it as marks.
fn window(text: &str, found: &[(usize, usize)], at: usize) -> Snippet {
    let chars: Vec<char> = text.chars().collect();
    let start = at.saturating_sub(50);
    let end = (at + 110).min(chars.len());
    let mut body: String = chars[start..end].iter().map(|c| if c.is_control() { ' ' } else { *c }).collect();
    let lead = usize::from(start > 0);
    if start > 0 {
        body.insert(0, '…');
    }
    if end < chars.len() {
        body.push('…');
    }
    let mut marks: Vec<[u32; 2]> = found.iter().filter(|(a, b)| *a >= start && *b <= end).map(|(a, b)| [(a - start + lead) as u32, (b - start + lead) as u32]).collect();
    marks.sort();
    let mut merged: Vec<[u32; 2]> = Vec::new();
    for m in marks {
        match merged.last_mut() {
            Some(last) if m[0] <= last[1] => last[1] = last[1].max(m[1]),
            _ => merged.push(m),
        }
    }
    Snippet { field: "prompt".into(), text: body, marks: merged }
}
