//! Changelog and release assistant: reads the commits since the last tag (or the commit that set the current version),
//! drafts a release entry in the repo's own changelog shape and proposes a version bump. Everything is a proposal;
//! `apply` writes only what the human accepted, and nothing here commits or tags.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::catalog::{escape, leading_keys, scan, set_key};
use crate::git::git;

const CHANGELOGS: [&str; 2] = ["src/components/modules/whatsNew/changelog.json", "app/components/changelog.json"];
const MAX_COMMITS: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
    /// feature | improvement | fix | performance | security | internal
    pub kind: &'static str,
    pub scope: Option<String>,
    pub breaking: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub title: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub description: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    #[serde(rename = "type")]
    pub kind: String,
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub version: String,
    pub date: String,
    pub highlight: BTreeMap<String, String>,
    pub groups: Vec<Group>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub version_file: Option<String>,
    pub changelog_path: Option<String>,
    pub current: String,
    pub proposed: String,
    pub bump: &'static str,
    /// `tag`, `versionCommit` or `none`.
    pub base_kind: &'static str,
    pub base: Option<String>,
    pub commits: Vec<Commit>,
    pub langs: Vec<String>,
    pub entry: Entry,
    pub tag_hint: Option<String>,
    pub diff: String,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRequest {
    pub version: String,
    pub entry: Option<Entry>,
    pub changelog_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ReleaseError {
    pub code: &'static str,
    pub message: String,
}

fn fail<T>(code: &'static str, message: impl Into<String>) -> Result<T, ReleaseError> {
    Err(ReleaseError { code, message: message.into() })
}

pub fn parse_commit(hash: &str, subject: &str, author: &str, date: &str) -> Commit {
    let (head, rest) = match subject.find(':') {
        Some(i) if !subject[..i].contains(' ') => (&subject[..i], subject[i + 1..].trim()),
        _ => ("", subject.trim()),
    };
    let breaking = head.ends_with('!');
    let head = head.trim_end_matches('!');
    let (ty, scope) = match head.split_once('(') {
        Some((t, s)) => (t, Some(s.trim_end_matches(')').to_string())),
        None => (head, None),
    };
    let lower = rest.to_lowercase();
    let kind = match ty.to_lowercase().as_str() {
        "feat" | "feature" => "feature",
        "fix" | "hotfix" | "bugfix" => "fix",
        "perf" => "performance",
        "security" | "sec" => "security",
        "refactor" | "style" | "improve" | "improvement" | "ux" => "improvement",
        "chore" | "docs" | "test" | "tests" | "build" | "ci" | "revert" => "internal",
        _ if lower.starts_with("fix") => "fix",
        _ if lower.starts_with("add ") || lower.starts_with("new ") || lower.starts_with("implement") => "feature",
        _ => "improvement",
    };
    Commit { hash: hash.chars().take(9).collect(), subject: rest.to_string(), author: author.to_string(), date: date.to_string(), kind, scope, breaking }
}

fn skip_commit(c: &Commit) -> bool {
    let l = c.subject.to_lowercase();
    l.starts_with("merge ") || l.starts_with("bump ") || l.contains("version bump") || l.starts_with("release ") || l.starts_with("release:") || (c.kind == "internal" && l.contains("release"))
}

fn sentence(s: &str) -> String {
    let mut cs = s.trim().trim_end_matches('.').chars();
    match cs.next() {
        Some(f) => f.to_uppercase().collect::<String>() + cs.as_str(),
        None => String::new(),
    }
}

pub fn bump_version(cur: &str, bump: &str) -> Option<String> {
    let core = cur.split(['-', '+']).next()?;
    let mut p = core.split('.').map(|x| x.parse::<u64>().ok());
    let (a, b, c) = (p.next()??, p.next()??, p.next()??);
    Some(match bump {
        "major" => format!("{}.0.0", a + 1),
        "minor" => format!("{a}.{}.0", b + 1),
        _ => format!("{a}.{b}.{}", c + 1),
    })
}

/// UTC civil date from days since the epoch (Howard Hinnant's algorithm).
pub fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn today() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (y, m, d) = civil(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

const GROUP_ORDER: [&str; 6] = ["feature", "improvement", "performance", "security", "fix", "internal"];

pub fn plan(root: &Path, bump: Option<&str>) -> Result<Plan, ReleaseError> {
    let mut notes = Vec::new();
    let version_file = root.join("package.json").is_file().then(|| "package.json".to_string());
    let Some(vf) = version_file.clone() else { return fail("noVersion", "no package.json with a version in this repository") };
    let pkg = std::fs::read_to_string(root.join(&vf)).map_err(|e| ReleaseError { code: "io", message: e.to_string() })?;
    let current = scan(&pkg)
        .ok()
        .and_then(|s| s.leaf(&["version".to_string()]).map(|l| l.value.clone()))
        .ok_or(ReleaseError { code: "noVersion", message: "package.json has no \"version\"".into() })?;

    let changelog_path = CHANGELOGS.iter().find(|p| root.join(p).is_file()).map(|p| p.to_string());
    // Languages and key order of the newest existing entry.
    let mut langs: Vec<String> = vec!["en".into()];
    if let Some(p) = &changelog_path {
        if let Ok(text) = std::fs::read_to_string(root.join(p)) {
            if let Some(h) = text.find("\"highlight\"").and_then(|i| text[i..].find('{').map(|b| i + b)) {
                let keys = leading_keys(&text[h..]);
                if !keys.is_empty() {
                    langs = keys;
                }
            }
        }
    }

    // Base: last tag, else the commit that set the current version.
    let tag = git(root, &["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "--match", "[0-9]*"]).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let version_commit = || git(root, &["log", "-n1", "--format=%H", &format!("-S\"version\": \"{current}\""), "--", &vf]).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    // A tag only counts as the base when it names the current version; an older tag would sweep in older releases.
    let (base_kind, base) = match &tag {
        Some(t) if t.trim_start_matches('v') == current => ("tag", Some(t.clone())),
        _ => match version_commit() {
            Some(h) => ("versionCommit", Some(h)),
            None => match tag {
                Some(t) => ("tag", Some(t)),
                None => ("none", None),
            },
        },
    };
    let range = base.as_ref().map(|b| format!("{b}..HEAD"));
    let mut args = vec!["log", "--no-merges", "--format=%H%x1f%s%x1f%an%x1f%as%x1f%b%x1e"];
    let n = format!("-n{MAX_COMMITS}");
    args.push(&n);
    if let Some(r) = &range {
        args.push(r);
    } else {
        notes.push("No tag and no version commit found: showing the latest commits only.".into());
    }
    let raw = git(root, &args).unwrap_or_default();
    let mut commits = Vec::new();
    let mut bodies = Vec::new();
    for rec in raw.split('\x1e') {
        let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
        if f.len() < 5 || f[0].is_empty() {
            continue;
        }
        let c = parse_commit(f[0], f[1], f[2], f[3]);
        if skip_commit(&c) {
            continue;
        }
        let body = f[4].trim().lines().take_while(|l| !l.trim().is_empty()).collect::<Vec<_>>().join(" ");
        bodies.push(body.chars().take(300).collect::<String>());
        commits.push(c);
    }
    let bump_name: &'static str = match bump {
        Some("major") => "major",
        Some("minor") => "minor",
        Some("patch") => "patch",
        _ if commits.iter().any(|c| c.breaking) => "major",
        _ if commits.iter().any(|c| c.kind == "feature") => "minor",
        _ => "patch",
    };
    let proposed = bump_version(&current, bump_name).ok_or(ReleaseError { code: "badVersion", message: format!("cannot bump version '{current}'") })?;

    let mut groups: Vec<Group> = Vec::new();
    for kind in GROUP_ORDER {
        let items: Vec<Item> = commits
            .iter()
            .zip(&bodies)
            .filter(|(c, _)| c.kind == kind)
            .map(|(c, body)| Item {
                title: BTreeMap::from([("en".to_string(), sentence(&c.subject))]),
                description: if body.is_empty() { BTreeMap::new() } else { BTreeMap::from([("en".to_string(), sentence(body) + ".")]) },
            })
            .collect();
        if !items.is_empty() {
            groups.push(Group { kind: kind.to_string(), items });
        }
    }
    let count = |k: &str| commits.iter().filter(|c| c.kind == k).count();
    let mut parts = Vec::new();
    for (k, label) in [("feature", "new features"), ("improvement", "improvements"), ("fix", "fixes")] {
        if count(k) > 0 {
            parts.push(format!("{} {label}", count(k)));
        }
    }
    let highlight = BTreeMap::from([("en".to_string(), if parts.is_empty() { "Maintenance release.".to_string() } else { format!("This release brings {}.", parts.join(", ")) })]);
    let entry = Entry { version: proposed.clone(), date: today(), highlight, groups };
    if changelog_path.is_none() {
        notes.push("This repository has no changelog file: only the version bump can be applied.".into());
    }
    if commits.is_empty() {
        notes.push("No commits since the base: nothing to describe.".into());
    }
    let tag_hint = git(root, &["tag", "--list"]).filter(|t| !t.trim().is_empty()).map(|t| {
        let v = t.lines().any(|l| l.starts_with('v'));
        format!("git tag {}{proposed}", if v { "v" } else { "" })
    });
    let diff = render_diff(root, &vf, &pkg, &current, &proposed, changelog_path.as_deref(), &entry, &langs);
    Ok(Plan { version_file: Some(vf), changelog_path, current, proposed, bump: bump_name, base_kind, base, commits, langs, entry, tag_hint, diff, notes })
}

fn render_diff(root: &Path, vf: &str, pkg: &str, cur: &str, next: &str, changelog: Option<&str>, entry: &Entry, langs: &[String]) -> String {
    let mut out = String::new();
    let old_line = pkg.lines().find(|l| l.contains("\"version\"") && l.contains(cur)).unwrap_or("").to_string();
    out.push_str(&format!("--- a/{vf}\n+++ b/{vf}\n-{old_line}\n+{}\n", old_line.replace(cur, next)));
    if let Some(p) = changelog {
        let indent = item_indent(&std::fs::read_to_string(root.join(p)).unwrap_or_default());
        out.push_str(&format!("--- a/{p}\n+++ b/{p}\n"));
        for l in entry_text(entry, langs, &indent).lines() {
            out.push_str(&format!("+{l}\n"));
        }
    }
    out
}

fn item_indent(text: &str) -> String {
    let Some(i) = text.find("\"releases\"") else { return "    ".into() };
    let after = &text[i..];
    let Some(b) = after.find('[') else { return "    ".into() };
    after[b + 1..].lines().skip(1).find(|l| !l.trim().is_empty()).map(|l| l.chars().take_while(|c| c.is_whitespace()).collect()).unwrap_or_else(|| "    ".into())
}

fn ordered<'a>(m: &'a BTreeMap<String, String>, langs: &[String]) -> Vec<(&'a String, &'a String)> {
    let mut v: Vec<_> = langs.iter().filter_map(|l| m.get_key_value(l)).collect();
    v.extend(m.iter().filter(|(k, _)| !langs.contains(k)));
    v
}

fn loc(m: &BTreeMap<String, String>, langs: &[String], ind: &str) -> String {
    let rows: Vec<String> = ordered(m, langs).iter().map(|(k, v)| format!("{ind}  {}: {}", escape(k), escape(v))).collect();
    format!("{{\n{}\n{ind}}}", rows.join(",\n"))
}

/// The release object as text, in the file's own key order and 2-space style, with `indent` before every line.
pub fn entry_text(e: &Entry, langs: &[String], indent: &str) -> String {
    let i1 = format!("{indent}  ");
    let i2 = format!("{indent}    ");
    let i3 = format!("{indent}      ");
    let i4 = format!("{indent}        ");
    let groups: Vec<String> = e
        .groups
        .iter()
        .map(|g| {
            let items: Vec<String> = g
                .items
                .iter()
                .map(|it| {
                    let mut f = vec![format!("{i4}\"title\": {}", loc(&it.title, langs, &i4))];
                    if !it.description.is_empty() {
                        f.push(format!("{i4}\"description\": {}", loc(&it.description, langs, &i4)));
                    }
                    format!("{i3}{{\n{}\n{i3}}}", f.join(",\n"))
                })
                .collect();
            format!("{i2}{{\n{i3}\"type\": {},\n{i3}\"items\": [\n{}\n{i3}]\n{i2}}}", escape(&g.kind), items.join(",\n"))
        })
        .collect();
    format!(
        "{indent}{{\n{i1}\"version\": {},\n{i1}\"date\": {},\n{i1}\"highlight\": {},\n{i1}\"groups\": [\n{}\n{i1}]\n{indent}}}",
        escape(&e.version),
        escape(&e.date),
        loc(&e.highlight, langs, &i1),
        groups.join(",\n")
    )
}

/// Writes the accepted version bump and changelog entry. Never commits or tags.
pub fn apply(root: &Path, req: &ApplyRequest) -> Result<Vec<String>, ReleaseError> {
    let io = |e: std::io::Error| ReleaseError { code: "io", message: e.to_string() };
    let pkg_path = root.join("package.json");
    let pkg = std::fs::read_to_string(&pkg_path).map_err(io)?;
    if req.version.is_empty() || !req.version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')) {
        return fail("badRequest", "invalid version");
    }
    let new_pkg = set_key(&pkg, &["version".to_string()], &req.version).map_err(|m| ReleaseError { code: "badCatalog", message: m })?;
    let mut files = vec![("package.json".to_string(), new_pkg)];
    if let (Some(entry), Some(rel)) = (&req.entry, &req.changelog_path) {
        if !CHANGELOGS.contains(&rel.as_str()) {
            return fail("badRequest", format!("{rel} is not a known changelog file"));
        }
        let text = std::fs::read_to_string(root.join(rel)).map_err(io)?;
        let indent = item_indent(&text);
        let at = text.find("\"releases\"").and_then(|i| text[i..].find('[').map(|b| i + b)).ok_or(ReleaseError { code: "badCatalog", message: "no \"releases\" array".into() })?;
        if text.contains(&format!("\"version\": {}", escape(&entry.version))) {
            return fail("exists", format!("{} already has an entry for {}", rel, entry.version));
        }
        let langs: Vec<String> = text.find("\"highlight\"").and_then(|i| text[i..].find('{').map(|b| leading_keys(&text[i + b..]))).filter(|k| !k.is_empty()).unwrap_or_else(|| vec!["en".into()]);
        let empty = text[at + 1..].trim_start().starts_with(']');
        let ins = format!("\n{}{}", entry_text(entry, &langs, &indent), if empty { "" } else { "," });
        let out = format!("{}{}{}", &text[..at + 1], ins, &text[at + 1..]);
        serde_json::from_str::<serde_json::Value>(&out).map_err(|e| ReleaseError { code: "badCatalog", message: format!("result is not valid JSON ({e})") })?;
        files.push((rel.clone(), out));
    }
    let mut written = Vec::new();
    for (rel, text) in files {
        let full = root.join(&rel);
        let tmp = full.with_extension("json.intely-tmp");
        std::fs::write(&tmp, &text).map_err(io)?;
        if let Ok(m) = std::fs::metadata(&full) {
            let _ = std::fs::set_permissions(&tmp, m.permissions());
        }
        std::fs::rename(&tmp, &full).map_err(io)?;
        written.push(rel);
    }
    Ok(written)
}
