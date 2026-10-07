//! The checker: which i18n keys the working tree adds or changes, and what every locale of the repo is missing.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::Serialize;

use crate::catalog::{scan, Scan};
use crate::detect::{detect, Catalog};
use crate::git::{added_lines, changed_files, head_blob};
use crate::rules::{placeholders, plural_split, required_forms};

const MAX_ROWS_PER_GROUP: usize = 400;
const MAX_SOURCE_BYTES: u64 = 1_000_000;
const MAX_SOURCES: usize = 300;
const SNIPPET: usize = 160;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CellState {
    Ok,
    Missing,
    Placeholder,
    Plural,
    /// The group has no catalog for this language at all.
    NoFile,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub path: Vec<String>,
    pub reference: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub state: CellState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// What a draft has to write for this cell (empty when the state is ok or the file is missing).
    pub todo: Vec<Todo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub key: String,
    /// `added`, `changed` (in a locale JSON) or `used` (in changed code).
    pub reason: &'static str,
    pub plural: bool,
    pub ref_lang: String,
    pub reference: String,
    pub files: Vec<String>,
    pub cells: BTreeMap<String, Cell>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupReport {
    pub group: String,
    pub langs: Vec<String>,
    pub files: BTreeMap<String, String>,
    pub rows: Vec<Row>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Undefined {
    pub key: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBadge {
    pub path: String,
    pub missing: usize,
    pub problems: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LangTotal {
    pub lang: String,
    pub missing: usize,
    pub problems: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub layout: &'static str,
    pub langs: Vec<String>,
    pub reference: Option<String>,
    pub catalogs: usize,
    pub changed: usize,
    pub groups: Vec<GroupReport>,
    pub undefined: Vec<Undefined>,
    pub badges: Vec<FileBadge>,
    pub totals: Vec<LangTotal>,
    /// Source files skipped because there were too many or they were too big.
    pub skipped: usize,
}

fn layout_of(cats: &[Catalog]) -> &'static str {
    match cats.first() {
        None => "none",
        Some(c) if c.rel.starts_with("src/localization/modules/") => "admin",
        Some(c) if c.rel.starts_with("locales/") => "mobile",
        Some(_) => "pos",
    }
}

fn snippet(s: &str) -> String {
    let mut t: String = s.chars().take(SNIPPET).collect();
    if s.chars().count() > SNIPPET {
        t.push('…');
    }
    t
}

fn cap(s: &str) -> String {
    s.chars().take(2000).collect()
}

fn is_source(rel: &str) -> bool {
    matches!(rel.rsplit_once('.').map(|(_, e)| e), Some("js" | "jsx" | "ts" | "tsx" | "vue" | "mjs"))
}

/// Keys used through `t('...')`, `i18n.t("...")`, `$t(...)` and `i18nKey="..."` in a line of code. Dynamic keys (template
/// strings with `${`) are skipped.
pub fn keys_in_line(line: &str) -> Vec<String> {
    let b = line.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let call = b[i] == b't' && b.get(i + 1) == Some(&b'(') && (i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_') || b[i - 1] == b'$');
        let attr = line[i..].starts_with("i18nKey=");
        if call || attr {
            let mut j = i + if call { 2 } else { 8 };
            if attr && b.get(j) == Some(&b'{') {
                j += 1;
            }
            while b.get(j).is_some_and(|c| c.is_ascii_whitespace()) {
                j += 1;
            }
            if let Some(&q) = b.get(j).filter(|c| matches!(**c, b'\'' | b'"' | b'`')) {
                if let Some(end) = line[j + 1..].find(q as char) {
                    let k = &line[j + 1..j + 1 + end];
                    if !k.is_empty() && !k.contains("${") && !k.contains(char::is_whitespace) && k.len() < 200 {
                        out.push(k.split_once(':').filter(|(ns, _)| !ns.contains('.')).map_or(k, |(_, r)| r).to_string());
                    }
                    i = j + 1 + end;
                }
            }
        }
        i += 1;
    }
    out
}

struct Loaded {
    scan: Scan,
}

fn load(root: &Path, c: &Catalog) -> Option<Loaded> {
    let text = std::fs::read_to_string(root.join(&c.rel)).ok()?;
    Some(Loaded { scan: scan(&text).ok()? })
}

/// Base key of a flat map entry, collapsing `_one/_other` into one logical key.
fn logical(path: &[String]) -> (Vec<String>, bool) {
    match path.last().and_then(|l| plural_split(l)) {
        Some((base, _)) => {
            let mut p = path[..path.len() - 1].to_vec();
            p.push(base.to_string());
            (p, true)
        }
        None => (path.to_vec(), false),
    }
}

/// All leaves of one logical key in a catalog: (full path, form, value).
fn variants<'a>(sc: &'a Scan, base: &[String], plural: bool) -> Vec<(&'a Vec<String>, Option<&'a str>, &'a str)> {
    sc.leaves
        .iter()
        .filter_map(|l| {
            if !plural {
                return (l.path == base).then(|| (&l.path, None, l.value.as_str()));
            }
            let (b, p) = logical(&l.path);
            (p && b == base).then(|| (&l.path, l.path.last().and_then(|x| plural_split(x)).map(|(_, f)| f), l.value.as_str()))
        })
        .collect()
}

pub fn analyze(root: &Path) -> Report {
    let cats = detect(root);
    let mut langs: Vec<String> = cats.iter().map(|c| c.lang.clone()).collect::<BTreeSet<_>>().into_iter().collect();
    let reference = if langs.iter().any(|l| l == "en") { Some("en".to_string()) } else { langs.first().cloned() };
    if let Some(r) = &reference {
        langs.sort_by_key(|l| (l != r, l.clone()));
    }
    let mut report = Report { layout: layout_of(&cats), langs: langs.clone(), reference: reference.clone(), catalogs: cats.len(), changed: 0, groups: Vec::new(), undefined: Vec::new(), badges: Vec::new(), totals: Vec::new(), skipped: 0 };
    if cats.is_empty() {
        return report;
    }
    let changed = changed_files(root);
    report.changed = changed.len();

    // candidates: group -> logical key path -> (plural, reason, files)
    type Cand = (bool, &'static str, BTreeSet<String>);
    let mut cand: BTreeMap<String, BTreeMap<Vec<String>, Cand>> = BTreeMap::new();

    for ch in &changed {
        let Some(cat) = cats.iter().find(|c| c.rel == ch.path) else { continue };
        let Some(now) = load(root, cat) else { continue };
        let base = head_blob(root, &cat.rel).and_then(|t| scan(&t).ok()).map(|s| s.flat()).unwrap_or_default();
        for l in &now.scan.leaves {
            if l.value.trim().is_empty() {
                continue;
            }
            let key = l.path.join(".");
            let reason = match base.get(&key) {
                None => "added",
                Some(v) if *v != l.value => "changed",
                _ => continue,
            };
            let (lp, plural) = logical(&l.path);
            let e = cand.entry(cat.group.clone()).or_default().entry(lp).or_insert((plural, reason, BTreeSet::new()));
            if reason == "added" {
                e.1 = "added";
            }
            e.2.insert(cat.rel.clone());
        }
    }

    // Keys used by changed code.
    let mut used: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut scanned = 0;
    for ch in changed.iter().filter(|c| is_source(&c.path) && !cats.iter().any(|k| k.rel == c.path)) {
        if scanned >= MAX_SOURCES {
            report.skipped += 1;
            continue;
        }
        let full = root.join(&ch.path);
        if std::fs::metadata(&full).map(|m| m.len() > MAX_SOURCE_BYTES).unwrap_or(true) {
            report.skipped += 1;
            continue;
        }
        let lines = if ch.untracked || head_blob(root, &ch.path).is_none() {
            std::fs::read_to_string(&full).map(|t| t.lines().map(str::to_string).collect()).unwrap_or_default()
        } else {
            added_lines(root, &ch.path).unwrap_or_default()
        };
        scanned += 1;
        for l in &lines {
            for k in keys_in_line(l) {
                used.entry(k).or_default().insert(ch.path.clone());
            }
        }
    }
    let mut ref_cache: BTreeMap<String, Vec<Loaded>> = BTreeMap::new();
    if !used.is_empty() {
        let groups: BTreeSet<&String> = cats.iter().map(|c| &c.group).collect();
        for g in groups {
            let ls = cats.iter().filter(|c| &c.group == g && Some(&c.lang) == reference.as_ref()).filter_map(|c| load(root, c)).collect();
            ref_cache.insert(g.clone(), ls);
        }
    }
    for (key, files) in &used {
        let path: Vec<String> = key.split('.').map(str::to_string).collect();
        let plain = vec![key.clone()];
        let mut found = false;
        for (g, ls) in &ref_cache {
            let hit = [&path, &plain].into_iter().find_map(|p| {
                ls.iter().find_map(|l| {
                    if l.scan.leaf(p).is_some() {
                        Some((p.clone(), false))
                    } else {
                        (!variants(&l.scan, p, true).is_empty()).then(|| (p.clone(), true))
                    }
                })
            });
            if let Some((lp, plural)) = hit {
                found = true;
                let e = cand.entry(g.clone()).or_default().entry(lp).or_insert((plural, "used", BTreeSet::new()));
                e.2.extend(files.iter().cloned());
            }
        }
        if !found {
            report.undefined.push(Undefined { key: key.clone(), files: files.iter().cloned().collect() });
        }
    }
    report.undefined.truncate(200);

    // Evaluate every candidate against every language.
    let mut badge: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut totals: BTreeMap<String, (usize, usize)> = langs.iter().map(|l| (l.clone(), (0, 0))).collect();
    for (group, keys) in cand {
        let gcats: Vec<&Catalog> = cats.iter().filter(|c| c.group == group).collect();
        let loaded: BTreeMap<String, Loaded> = gcats.iter().filter_map(|c| load(root, c).map(|l| (c.lang.clone(), l))).collect();
        let mut g = GroupReport { group: group.clone(), langs: langs.clone(), files: gcats.iter().map(|c| (c.lang.clone(), c.rel.clone())).collect(), rows: Vec::new(), truncated: false };
        for (lp, (plural, reason, files)) in keys {
            if g.rows.len() >= MAX_ROWS_PER_GROUP {
                g.truncated = true;
                break;
            }
            // Reference language: the repo reference when it has the key, else the first language that does.
            let order = langs.iter().filter(|l| loaded.contains_key(*l));
            let Some((ref_lang, ref_vars)) = order.map(|l| (l.clone(), variants(&loaded[l].scan, &lp, plural))).find(|(_, v)| !v.is_empty()) else { continue };
            let ref_text = ref_vars.iter().find(|v| v.1 == Some("other")).or(ref_vars.first()).map(|v| v.2.to_string()).unwrap_or_default();
            let ref_ph: BTreeSet<String> = ref_vars.iter().flat_map(|v| placeholders(v.2)).collect();
            let ref_forms: Vec<(Option<String>, String)> = ref_vars.iter().map(|v| (v.1.map(str::to_string), v.2.to_string())).collect();
            let mut cells = BTreeMap::new();
            for lang in &langs {
                let cell = match loaded.get(lang) {
                    None => Cell { state: CellState::NoFile, note: Some(format!("No {lang} catalog for {group}")), todo: Vec::new() },
                    Some(l) => {
                        let vars = variants(&l.scan, &lp, plural);
                        let vars: Vec<_> = vars.into_iter().filter(|v| !v.2.trim().is_empty()).collect();
                        let build_todo = |forms: &[&str]| -> Vec<Todo> {
                            forms
                                .iter()
                                .map(|f| {
                                    let mut path = lp.clone();
                                    let last = path.pop().unwrap_or_default();
                                    path.push(format!("{last}_{f}"));
                                    let refr = ref_forms.iter().find(|(x, _)| x.as_deref() == Some(f)).or_else(|| ref_forms.iter().find(|(x, _)| x.as_deref() == Some("other"))).or(ref_forms.first()).map(|x| x.1.clone()).unwrap_or_default();
                                    Todo { path, reference: cap(&refr) }
                                })
                                .collect()
                        };
                        if vars.is_empty() {
                            let todo = if plural { build_todo(required_forms(lang)) } else { vec![Todo { path: lp.clone(), reference: cap(&ref_text) }] };
                            Cell { state: CellState::Missing, note: None, todo }
                        } else if plural {
                            let have: BTreeSet<&str> = vars.iter().filter_map(|v| v.1).collect();
                            let need: Vec<&str> = required_forms(lang).iter().copied().filter(|f| !have.contains(f)).collect();
                            if !need.is_empty() {
                                Cell { state: CellState::Plural, note: Some(format!("Needs plural form{}: {}", if need.len() == 1 { "" } else { "s" }, need.join(", "))), todo: build_todo(&need) }
                            } else {
                                ph_cell(&vars.iter().flat_map(|v| placeholders(v.2)).collect(), &ref_ph, || vars.iter().map(|v| Todo { path: v.0.clone(), reference: cap(&ref_text) }).collect())
                            }
                        } else {
                            ph_cell(&placeholders(vars[0].2), &ref_ph, || vec![Todo { path: lp.clone(), reference: cap(&ref_text) }])
                        }
                    }
                };
                cells.insert(lang.clone(), cell);
            }
            for (lang, c) in &cells {
                let t = totals.entry(lang.clone()).or_default();
                match c.state {
                    CellState::Missing | CellState::NoFile => t.0 += 1,
                    CellState::Placeholder | CellState::Plural => t.1 += 1,
                    CellState::Ok => {}
                }
            }
            let miss = cells.values().filter(|c| matches!(c.state, CellState::Missing | CellState::NoFile)).count();
            let prob = cells.values().filter(|c| matches!(c.state, CellState::Placeholder | CellState::Plural)).count();
            for f in &files {
                let b = badge.entry(f.clone()).or_default();
                b.0 += miss;
                b.1 += prob;
            }
            g.rows.push(Row { key: lp.join("."), reason, plural, ref_lang, reference: snippet(&ref_text), files: files.into_iter().collect(), cells });
        }
        if !g.rows.is_empty() {
            report.groups.push(g);
        }
    }
    report.badges = badge.into_iter().filter(|(_, b)| b.0 + b.1 > 0).map(|(path, b)| FileBadge { path, missing: b.0, problems: b.1 }).collect();
    report.totals = totals.into_iter().map(|(lang, t)| LangTotal { lang, missing: t.0, problems: t.1 }).collect();
    report
}

fn ph_cell(have: &BTreeSet<String>, want: &BTreeSet<String>, todo: impl FnOnce() -> Vec<Todo>) -> Cell {
    if have == want {
        return Cell { state: CellState::Ok, note: None, todo: Vec::new() };
    }
    let lacks: Vec<_> = want.difference(have).cloned().collect();
    let extra: Vec<_> = have.difference(want).cloned().collect();
    let mut note = Vec::new();
    if !lacks.is_empty() {
        note.push(format!("lacks {}", lacks.join(" ")));
    }
    if !extra.is_empty() {
        note.push(format!("extra {}", extra.join(" ")));
    }
    Cell { state: CellState::Placeholder, note: Some(note.join(", ")), todo: todo() }
}
