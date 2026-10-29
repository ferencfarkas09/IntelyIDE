//! Class selectors that are defined in a stylesheet but that no script or markup seems to use. It only reports: nothing is
//! deleted or changed. Class names are looked for in the strings of scripts and markup (`className="a b"`, `class="..."`,
//! `classList.add('x')`, `clsx('a', ...)`), in CSS-module imports (`styles.foo`, `styles['foo']`) and in the static start of
//! names built at run time (`` `btn-${kind}` `` makes every `btn-...` class "dynamic, unsure"). Every finding has a confidence.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Serialize;

use crate::cssscan::{defined_classes, scan_file};
use crate::walk::walk;
use crate::{is_source, is_style, Confidence, Reader, WebError, FACT_BUDGET, SRC_CAP, STYLE_CAP};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnusedClass {
    pub name: String,
    pub line: u32,
    /// `unused` or `dynamic` (a name built at run time may produce it).
    pub status: &'static str,
    pub confidence: Confidence,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleFile {
    pub path: String,
    /// A CSS module (`*.module.css`): its classes are used through an import.
    pub module: bool,
    /// A module that no file seems to import.
    pub not_imported: bool,
    pub classes: Vec<UnusedClass>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnusedReport {
    pub files: Vec<StyleFile>,
    pub classes_checked: u32,
    pub files_scanned: u32,
    /// Class names are built at run time somewhere, so every "unused" is less sure.
    pub dynamic_classes: bool,
    pub truncated: bool,
    pub skipped: Vec<String>,
}

#[derive(Default)]
pub(crate) struct ClassRefs {
    pub(crate) words: HashSet<String>,
    prefixes: HashSet<String>,
    /// Class names are composed at run time somewhere (a template, a helper like clsx, `classList=`, a computed `styles[...]`).
    pub(crate) dynamic: bool,
}

fn word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b >= 0x80
}

const MAX_WORDS: usize = 200_000;

fn add_words(seg: &str, refs: &mut ClassRefs) {
    // a class written with characters a split would break (`md:flex`, `w-1/2`, `h-[3px]`) is looked for whole
    for tok in seg.split_whitespace() {
        let tok = tok.trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '{' | '}'));
        if tok.len() <= 64 && tok.contains([':', '/', '[', ']', '%', '.']) && refs.words.len() < MAX_WORDS {
            refs.words.insert(tok.to_string());
        }
    }
    for w in seg.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || !c.is_ascii())) {
        if !w.is_empty() && w.len() <= 64 && refs.words.len() < MAX_WORDS {
            refs.words.insert(w.to_string());
        }
    }
}

fn add_prefix(seg: &str, refs: &mut ClassRefs) {
    if seg.ends_with(|c: char| c.is_whitespace()) {
        return;
    }
    if let Some(last) = seg.rsplit(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || !c.is_ascii())).next() {
        if last.len() >= 2 && refs.prefixes.len() < 5000 {
            refs.prefixes.insert(last.to_string());
        }
    }
}

/// Calls of the class-composing helpers (`clsx({ active: on })`, `cn`, `classnames`, `cx`, `twMerge`, `cva`, ...) take class names as
/// bare object keys, shorthand properties and identifiers, not only as strings: every word inside such a call counts as a use. A project
/// that composes classes this way is not "sure" about any unused class.
const HELPERS: &[&str] = &["clsx", "cn", "classnames", "classnamesbind", "cx", "twmerge", "cva", "cls", "classes", "classlist", "tw", "cc", "join", "classname", "mergeclasses", "cm"];

fn scan_helpers(text: &str, refs: &mut ClassRefs) {
    let b = text.as_bytes();
    let mut calls = 0;
    // the arguments of nested or repeated calls overlap, so the bytes looked at in them are budgeted: about twice the file
    let mut budget = text.len() * 2 + 4096;
    for (at, _) in text.match_indices('(') {
        let mut k = at;
        while k > 0 && at - k < 24 && (b[k - 1].is_ascii_alphanumeric() || b[k - 1] == b'_' || b[k - 1] == b'$') {
            k -= 1;
        }
        if k == at || !HELPERS.contains(&text[k..at].to_ascii_lowercase().as_str()) {
            continue;
        }
        // `join(` is only a helper when it is `.join(' ')`-free of meaning; it is far too common, so only count it next to a class word
        if text[k..at].eq_ignore_ascii_case("join") {
            continue;
        }
        calls += 1;
        if calls > 20_000 {
            break;
        }
        refs.dynamic = true;
        let end = (at + 4000).min(b.len());
        if budget < end - at {
            continue;
        }
        budget -= end - at;
        let mut depth = 0usize;
        let mut close = end;
        for (d, c) in b[at..end].iter().enumerate() {
            match c {
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        close = at + d;
                        break;
                    }
                }
                _ => {}
            }
        }
        if let Some(args) = text.get(at + 1..close) {
            add_words(args, refs);
        }
    }
}

/// Collects the words of every string, template literal and quoted attribute value of a script or markup file.
pub(crate) fn scan_class_refs(text: &str, refs: &mut ClassRefs) {
    scan_helpers(text, refs);
    if text.contains("classList=") || text.contains("classList.toggle(") {
        refs.dynamic = true;
    }
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let q = b[i];
        if q != b'"' && q != b'\'' && q != b'`' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        let mut seg_start = j;
        while j < b.len() && b[j] != q {
            if q != b'`' && b[j] == b'\n' {
                break;
            }
            if b[j] == b'\\' {
                j += 2;
                continue;
            }
            if q == b'`' && b[j] == b'$' && b.get(j + 1) == Some(&b'{') {
                let seg = &text[seg_start..j.min(b.len())];
                add_words(seg, refs);
                add_prefix(seg, refs);
                refs.dynamic = true;
                // skip the expression: balanced braces
                let mut depth = 0usize;
                while j < b.len() {
                    match b[j] {
                        b'{' => depth += 1,
                        b'}' => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                    j += 1;
                }
                j += 1;
                seg_start = j.min(b.len());
                continue;
            }
            j += 1;
        }
        let end = j.min(b.len());
        if seg_start <= end {
            // slicing is on ASCII boundaries (quotes, `}`), so it is on character boundaries
            let seg = &text[seg_start..end];
            add_words(seg, refs);
            if q != b'`' && seg.ends_with(['-', '_']) {
                add_prefix(seg, refs);
            }
        }
        i = end + 1;
    }
}

#[derive(Default)]
struct ModuleUse {
    names: HashSet<String>,
    dynamic: bool,
    imported: bool,
    all: bool,
}

struct Import {
    importer: String,
    path: String,
    binding: Option<String>,
    named: Vec<String>,
}

/// The first quoted string of `s`, looked for in its first 300 bytes only (an unterminated quote must not make every call scan the rest
/// of the file).
fn quoted(s: &str) -> Option<&str> {
    let b = s.as_bytes();
    let window = &b[..b.len().min(300)];
    let start = window.iter().position(|c| *c == b'"' || *c == b'\'')?;
    let end = start + 1 + window[start + 1..].iter().position(|c| *c == window[start])?;
    s.get(start + 1..end)
}

fn is_module_path(p: &str) -> bool {
    let lower = p.to_ascii_lowercase();
    [".module.css", ".module.scss", ".module.sass", ".module.less"].iter().any(|e| lower.ends_with(e))
}

fn ident_at(s: &str) -> Option<&str> {
    let end = s.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$')).unwrap_or(s.len());
    (end > 0).then(|| &s[..end])
}

fn parse_imports(importer: &str, text: &str, out: &mut Vec<Import>) {
    for line in text.lines().filter(|l| l.len() < 400 && l.contains(".module.")) {
        let l = line.trim();
        let (Some(path), true) = (quoted(l.split_once("from").map_or_else(|| l.split_once("require(").map_or(l, |x| x.1), |x| x.1)), l.contains("import") || l.contains("require(")) else { continue };
        if !is_module_path(path) {
            continue;
        }
        let mut imp = Import { importer: importer.to_string(), path: path.to_string(), binding: None, named: Vec::new() };
        if let Some(rest) = l.strip_prefix("import ") {
            let head = rest.split(" from").next().unwrap_or("");
            if let Some(star) = head.strip_prefix("* as ") {
                imp.binding = ident_at(star.trim()).map(str::to_string);
            } else {
                if let Some(first) = ident_at(head.trim()) {
                    imp.binding = Some(first.to_string());
                }
                if let (Some(a), Some(z)) = (head.find('{'), head.find('}')) {
                    if a < z {
                        imp.named = head[a + 1..z].split(',').filter_map(|n| ident_at(n.trim().split(" as ").next().unwrap_or(""))).map(str::to_string).collect();
                    }
                }
            }
        } else if let Some((left, _)) = l.split_once('=') {
            let left = left.trim_start_matches("const ").trim_start_matches("let ").trim_start_matches("var ").trim();
            imp.binding = ident_at(left).map(str::to_string);
        }
        out.push(imp);
        if out.len() > 20_000 {
            return;
        }
    }
}

/// `styles.foo`, `styles['foo']` for one binding; a computed index marks the module dynamic.
fn member_uses(text: &str, binding: &str, into: &mut ModuleUse) {
    let b = text.as_bytes();
    for (at, _) in text.match_indices(binding).take(50_000) {
        if at > 0 && (word_byte(b[at - 1]) || b[at - 1] == b'.' || b[at - 1] == b'$') {
            continue;
        }
        let after = at + binding.len();
        match b.get(after) {
            Some(b'.') => {
                let rest = &text[after + 1..];
                let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '-')).unwrap_or(rest.len());
                if end > 0 {
                    into.names.insert(rest[..end].to_string());
                }
            }
            Some(b'[') => {
                let rest = &text[after + 1..];
                match rest.as_bytes().first() {
                    Some(b'"' | b'\'') => {
                        if let Some(name) = quoted(rest) {
                            into.names.insert(name.to_string());
                        }
                    }
                    _ => into.dynamic = true,
                }
            }
            // passed on as a value (`<Box styles={styles}>`, `...styles`): any class may be used
            _ => {
                if text[after..].trim_start().starts_with([',', ')', '}', ';']) {
                    into.dynamic = true;
                }
            }
        }
    }
}

fn normalize(base: &str, rel: &str) -> String {
    let mut parts: Vec<&str> = base.split('/').filter(|p| !p.is_empty()).collect();
    for p in rel.split('/') {
        match p {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

const MAX_CLASSES: usize = 3000;

pub fn unused_styles(root: &Path) -> Result<UnusedReport, WebError> {
    let w = walk(root);
    let mut reader = Reader::new(root);
    let mut refs = ClassRefs::default();
    let mut imports: Vec<Import> = Vec::new();
    let mut importer_text: HashMap<String, String> = HashMap::new();
    let mut styles: Vec<(String, crate::cssscan::Facts)> = Vec::new();
    let mut kept = 0usize;
    let mut files = 0u32;
    for e in &w.files {
        let style = is_style(&e.ext);
        if !style && !is_source(&e.ext) {
            continue;
        }
        let Some(text) = reader.read(e, if style { STYLE_CAP } else { SRC_CAP }) else { continue };
        files += 1;
        if style {
            let facts = scan_file(&text, &e.ext);
            kept += facts.approx_bytes();
            if kept > FACT_BUDGET {
                if !reader.truncated {
                    reader.skipped.push("stopped keeping details: the style sheets are very large together".into());
                }
                reader.truncated = true;
            } else {
                styles.push((e.rel.clone(), facts));
            }
        } else {
            scan_class_refs(&text, &mut refs);
            let before = imports.len();
            parse_imports(&e.rel, &text, &mut imports);
            if imports.len() > before {
                importer_text.insert(e.rel.clone(), text);
            }
        }
    }
    let module_rels: Vec<&str> = styles.iter().map(|(r, _)| r.as_str()).filter(|r| is_module_path(r)).collect();
    let resolve = |imp: &Import| -> Option<String> {
        if imp.path.starts_with('.') {
            let dir = imp.importer.rsplit_once('/').map_or("", |x| x.0);
            let full = normalize(dir, &imp.path);
            return module_rels.iter().find(|r| **r == full).map(|r| r.to_string());
        }
        let tail = imp.path.trim_start_matches(|c: char| !c.is_ascii_alphanumeric()).trim_start_matches('/');
        let tail = tail.strip_prefix("src/").unwrap_or(tail);
        module_rels.iter().find(|r| **r == tail || r.ends_with(&format!("/{tail}"))).map(|r| r.to_string())
    };
    let mut uses: HashMap<String, ModuleUse> = HashMap::new();
    for imp in &imports {
        let Some(target) = resolve(imp) else { continue };
        let u = uses.entry(target).or_default();
        u.imported = true;
        u.names.extend(imp.named.iter().cloned());
        match (&imp.binding, importer_text.get(&imp.importer)) {
            (Some(b), Some(text)) => member_uses(text, b, u),
            _ => {
                if imp.named.is_empty() {
                    u.all = true;
                }
            }
        }
    }

    let dynamic_all = refs.dynamic || uses.values().any(|u| u.dynamic);
    let mut report = UnusedReport { files_scanned: files, dynamic_classes: dynamic_all, ..Default::default() };
    let mut total = 0usize;
    for (rel, facts) in &styles {
        if total >= MAX_CLASSES || report.files.len() >= 500 {
            report.truncated = true;
            break;
        }
        let module = is_module_path(rel);
        let mu = uses.get(rel);
        let per_rule = defined_classes(&facts.rules);
        let composed: HashSet<&str> = facts.decls.iter().filter(|d| d.prop == "composes").flat_map(|d| d.value.split_whitespace()).collect();
        let mut seen: HashSet<&str> = HashSet::new();
        let mut file = StyleFile { path: rel.clone(), module, not_imported: module && mu.is_none(), classes: Vec::new() };
        for (rule, classes) in facts.rules.iter().zip(&per_rule) {
            for (name, global) in classes {
                if !seen.insert(name.as_str()) {
                    continue;
                }
                report.classes_checked += 1;
                if composed.contains(name.as_str()) {
                    continue;
                }
                let local_module = module && !global;
                let (status, confidence) = if local_module {
                    match mu {
                        Some(u) if u.all || u.names.contains(name) => continue,
                        Some(u) if u.dynamic => ("dynamic", Confidence::Low),
                        Some(_) => ("unused", if dynamic_all { Confidence::Low } else { Confidence::High }),
                        None => ("unused", if dynamic_all { Confidence::Low } else { Confidence::Medium }),
                    }
                } else if refs.words.contains(name) {
                    continue;
                } else if refs.prefixes.iter().any(|p| name.starts_with(p.as_str())) {
                    ("dynamic", Confidence::Low)
                } else {
                    ("unused", if dynamic_all { Confidence::Low } else { Confidence::High })
                };
                if file.classes.len() < 400 {
                    file.classes.push(UnusedClass { name: name.clone(), line: rule.line, status, confidence });
                    total += 1;
                }
            }
        }
        if !file.classes.is_empty() {
            report.files.push(file);
        }
    }
    report.skipped = reader.skipped;
    report.skipped.extend(w.notes);
    report.truncated |= reader.truncated;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(files: &[(&str, &str)]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for (rel, text) in files {
            let p = d.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        d
    }

    fn names(r: &UnusedReport, path: &str) -> Vec<(String, &'static str, Confidence)> {
        r.files.iter().find(|f| f.path == path).map(|f| f.classes.iter().map(|c| (c.name.clone(), c.status, c.confidence)).collect()).unwrap_or_default()
    }

    #[test]
    fn finds_classes_nobody_references_in_static_strings() {
        let d = repo(&[
            ("src/app.css", ".used {} .gone {} .also-used {} .on {}"),
            ("src/App.tsx", "export const A = () => <div className=\"used x\"><i className={clsx('also-used', ok && 'on')} /></div>;"),
            ("index.html", "<p class='html-class'>Don't</p>"),
        ]);
        let r = unused_styles(d.path()).unwrap();
        // the clsx call in the fixture composes classes at run time, so even this verdict is "unsure"
        assert_eq!(names(&r, "src/app.css"), vec![("gone".into(), "unused", Confidence::Low)]);
        assert!(r.dynamic_classes);
    }

    #[test]
    fn names_built_at_run_time_are_dynamic_and_lower_the_confidence() {
        let d = repo(&[
            ("a.css", ".btn-primary {} .btn-danger {} .other {}"),
            ("a.jsx", "const c = `btn-${kind}`; const d = 'card-' + size;"),
        ]);
        let r = unused_styles(d.path()).unwrap();
        let got = names(&r, "a.css");
        assert_eq!(got.iter().find(|c| c.0 == "btn-primary").unwrap().1, "dynamic");
        let other = got.iter().find(|c| c.0 == "other").unwrap();
        assert_eq!((other.1, other.2), ("unused", Confidence::Low));
        assert!(r.dynamic_classes);
    }

    #[test]
    fn css_modules_use_the_import_not_the_word() {
        let d = repo(&[
            ("src/Card.module.scss", ".title {} .body {} .orphan {} :global(.g) {}"),
            ("src/Card.tsx", "import styles from './Card.module.scss';\nexport const C = () => <div className={styles.title}><p className={styles['body']} /></div>;"),
            ("src/Other.module.css", ".x {}"),
            ("src/Dyn.module.css", ".a {} .b {}"),
            ("src/Dyn.tsx", "import s from './Dyn.module.css';\nconst k = s[name];"),
        ]);
        let r = unused_styles(d.path()).unwrap();
        assert_eq!(names(&r, "src/Card.module.scss"), vec![("orphan".into(), "unused", Confidence::Low), ("g".into(), "unused", Confidence::Low)]);
        // a computed styles[name] anywhere makes the whole project unsure
        assert_eq!(names(&r, "src/Other.module.css"), vec![("x".into(), "unused", Confidence::Low)]);
        assert!(r.files.iter().find(|f| f.path == "src/Other.module.css").unwrap().not_imported);
        assert_eq!(names(&r, "src/Dyn.module.css").iter().map(|c| c.1).collect::<Vec<_>>(), vec!["dynamic", "dynamic"]);
    }

    #[test]
    fn nested_scss_suffixes_are_checked_by_their_full_name() {
        let d = repo(&[("a.scss", ".card { &__title { color: red } &__foot {} }"), ("a.tsx", "<div className=\"card card__title\" />")]);
        let r = unused_styles(d.path()).unwrap();
        assert_eq!(names(&r, "a.scss"), vec![("card__foot".into(), "unused", Confidence::High)]);
    }

    #[test]
    fn hostile_files_are_bounded() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.css"), ".a{}".repeat(100_000)).unwrap();
        std::fs::write(d.path().join("b.tsx"), "`${".repeat(200_000)).unwrap();
        std::fs::write(d.path().join("c.js"), "\"".repeat(1_000_000)).unwrap();
        std::fs::write(d.path().join("d.js"), [0xffu8, 0xfe, b'`', 0xc3]).unwrap();
        let r = unused_styles(d.path()).unwrap();
        assert!(r.files_scanned >= 3);
    }

    #[test]
    fn bare_object_keys_in_class_helper_calls_count_as_uses() {
        let d = repo(&[
            ("a.css", ".tab {} .active {} .disabled {} .selected {} .gone {} .on {}"),
            ("A.tsx", "export const A = () => <div className={clsx('tab', { active: on, disabled, selected: isSel })} />;\nconst b = cn(base, cond && 'on');"),
        ]);
        let r = unused_styles(d.path()).unwrap();
        // only .gone is reported, and a project that composes classes this way is not sure about it
        assert_eq!(names(&r, "a.css"), vec![("gone".into(), "unused", Confidence::Low)]);
        assert!(r.dynamic_classes);
        for helper in ["classnames", "cx", "twMerge", "cva", "cn", "classNames"] {
            let d = repo(&[("a.css", ".kv {}"), ("A.tsx", &format!("const c = {helper}('x', {{ kv: flag }});"))]);
            assert!(names(&unused_styles(d.path()).unwrap(), "a.css").is_empty(), "{helper}");
        }
    }

    #[test]
    fn without_any_dynamic_composition_the_unused_verdict_is_sure() {
        let d = repo(&[("a.css", ".gone {}"), ("A.tsx", "const x = <div className=\"y\" />;")]);
        let r = unused_styles(d.path()).unwrap();
        assert_eq!(names(&r, "a.css"), vec![("gone".into(), "unused", Confidence::High)]);
        assert!(!r.dynamic_classes);
        let d = repo(&[("a.css", ".gone {}"), ("A.tsx", "const x = <div classList={{ on: a }} />;")]);
        assert_eq!(names(&unused_styles(d.path()).unwrap(), "a.css")[0].2, Confidence::Low);
    }

    #[test]
    fn classes_with_escapes_are_matched_by_their_unescaped_name() {
        let d = repo(&[("a.css", ".md\\:flex { display: flex } .w-1\\/2 { width: 50% } .h-\\[3px\\] {} .gone {}"), ("A.tsx", "const x = <div className=\"md:flex w-1/2 h-[3px]\" />;")]);
        let r = unused_styles(d.path()).unwrap();
        assert_eq!(names(&r, "a.css").iter().map(|c| c.0.as_str()).collect::<Vec<_>>(), vec!["gone"]);
    }

    #[test]
    fn hostile_class_sources_are_scanned_in_linear_time() {
        let d = tempfile::tempdir().unwrap();
        let mb = 1_500_000;
        std::fs::write(d.path().join("a.tsx"), "cn(".repeat(mb / 3)).unwrap();
        std::fs::write(d.path().join("b.tsx"), "styles[\"".repeat(mb / 8)).unwrap();
        std::fs::write(d.path().join("c.tsx"), "import s from './x.module.css';\n".to_string() + &"s['".repeat(mb / 3)).unwrap();
        std::fs::write(d.path().join("x.module.css"), ".a{}").unwrap();
        std::fs::write(d.path().join("d.tsx"), "`${".repeat(mb / 3)).unwrap();
        std::fs::write(d.path().join("e.css"), ".a,".repeat(mb / 3)).unwrap();
        let t = std::time::Instant::now();
        let _ = unused_styles(d.path()).unwrap();
        assert!(t.elapsed().as_secs() < if cfg!(debug_assertions) { 20 } else { 4 }, "{:?}", t.elapsed());
    }
}
