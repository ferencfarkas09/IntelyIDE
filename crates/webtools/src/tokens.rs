//! Design tokens of a stylesheet world: custom properties (`--brand`), SCSS variables and maps (`$brand`), Less variables
//! (`@brand`); how often each one is used; the unused ones; hard-coded colours and spacings that equal a token; colours written
//! several times. References are counted across stylesheets, scripts and markup. Names can be built at run time (`var(--${name})`),
//! so an "unused" token carries a confidence.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::Serialize;

use crate::color::{components, normalize_color, normalize_length, swatch};
use crate::cssscan::{scan_file, Facts};
use crate::styles::{scan_class_refs, ClassRefs};
use crate::walk::walk;
use crate::{clean, is_source, is_style, Confidence, Reader, FACT_BUDGET, SRC_CAP, STYLE_CAP, WebError};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    /// `--brand`, `$brand` or `@brand`.
    pub name: String,
    /// `custom`, `scss`, `scssMap` or `less`.
    pub kind: &'static str,
    pub value: String,
    pub file: String,
    pub line: u32,
    /// In how many places the name is defined (a theme redefines it).
    pub definitions: u32,
    /// `var(--x)` / `$x` / `@x` references.
    pub uses: u32,
    /// The name written some other way (`getPropertyValue('--x')`).
    pub mentions: u32,
    pub unused: bool,
    /// A Tailwind v4 theme variable (`--color-brand`) that a utility class (`bg-brand`) uses without writing `var(--color-brand)`.
    pub utility: bool,
    pub confidence: Confidence,
    /// The value as a colour that is safe to paint, when it is one.
    pub swatch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardCoded {
    pub file: String,
    pub line: u32,
    pub prop: String,
    pub value: String,
    pub token: String,
    /// How to write the token here: `var(--brand)`, `$brand`, `@brand`.
    pub suggestion: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateColor {
    pub value: String,
    pub swatch: Option<String>,
    /// Tokens that hold this colour (two or more: the same colour under two names).
    pub tokens: Vec<String>,
    /// Times the colour is written by hand where no token holds it.
    pub hardcoded: u32,
    pub examples: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Swatch {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokensReport {
    pub tokens: Vec<Token>,
    pub hardcoded: Vec<HardCoded>,
    pub duplicates: Vec<DuplicateColor>,
    pub swatches: Vec<Swatch>,
    pub files_scanned: u32,
    /// Somewhere a name is put together at run time: an "unused" token may be used after all.
    pub dynamic_names: bool,
    pub truncated: bool,
    pub skipped: Vec<String>,
}

#[derive(Default)]
pub(crate) struct Refs {
    pub uses: HashMap<String, u32>,
    pub mentions: HashMap<String, u32>,
    pub dollar: HashMap<String, u32>,
    pub at: HashMap<String, u32>,
    pub dynamic: bool,
}

const MAX_NAMES: usize = 60_000;

fn ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b >= 0x80
}

fn prev_is_var(b: &[u8], i: usize) -> bool {
    let mut k = i;
    let mut spaces = 0;
    while k > 0 && b[k - 1].is_ascii_whitespace() && spaces < 16 {
        k -= 1;
        spaces += 1;
    }
    b[..k].ends_with(b"var(")
}

/// After the name: optional spaces, an optional quote, then a colon (a definition or a style prop being set).
fn defines(b: &[u8], j: usize) -> bool {
    let mut k = j;
    if matches!(b.get(k), Some(b'"' | b'\'')) {
        k += 1;
    }
    while k < b.len() && (b[k] == b' ' || b[k] == b'\t') {
        k += 1;
    }
    b.get(k) == Some(&b':')
}

pub(crate) fn scan_refs(text: &str, ext: &str, refs: &mut Refs) {
    let b = text.as_bytes();
    let style = is_style(ext);
    let less = ext == "less";
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'-' && b.get(i + 1) == Some(&b'-') && (i == 0 || !ident_byte(b[i - 1])) {
            let mut j = i + 2;
            while j < b.len() && ident_byte(b[j]) {
                j += 1;
            }
            if j == i + 2 {
                if matches!(b.get(j), Some(b'$' | b'"' | b'\'' | b'`')) && !style {
                    refs.dynamic = true;
                }
                i += 2;
                continue;
            }
            if refs.uses.len() + refs.mentions.len() < MAX_NAMES {
                let name = &text[i..j];
                if prev_is_var(b, i) {
                    *refs.uses.entry(name.to_string()).or_insert(0) += 1;
                } else if !defines(b, j) {
                    *refs.mentions.entry(name.to_string()).or_insert(0) += 1;
                }
            }
            i = j;
        } else if c == b'$' && b.get(i + 1).is_some_and(|n| n.is_ascii_alphabetic() || *n == b'_' || *n == b'-') {
            let mut j = i + 1;
            while j < b.len() && ident_byte(b[j]) {
                j += 1;
            }
            if refs.dollar.len() < MAX_NAMES && !(style && defines(b, j)) {
                *refs.dollar.entry(text[i..j].to_string()).or_insert(0) += 1;
            }
            i = j;
        } else if c == b'@' && less && b.get(i + 1).is_some_and(|n| n.is_ascii_alphabetic() || *n == b'_') {
            let mut j = i + 1;
            while j < b.len() && ident_byte(b[j]) {
                j += 1;
            }
            if refs.at.len() < MAX_NAMES && !defines(b, j) {
                *refs.at.entry(text[i..j].to_string()).or_insert(0) += 1;
            }
            i = j;
        } else {
            i += 1;
        }
    }
}

struct Acc {
    token: Token,
    root: bool,
}

const TAILWIND_NAMESPACES: &[&str] = &["color", "font", "text", "spacing", "radius", "shadow", "inset-shadow", "drop-shadow", "breakpoint", "animate", "ease", "tracking", "leading", "blur", "perspective", "aspect", "container"];
const SPACING_PROPS: &[&str] = &["gap", "row-gap", "column-gap", "top", "left", "right", "bottom", "width", "height", "min-width", "min-height", "max-width", "max-height", "font-size", "letter-spacing"];

fn is_spacing_prop(p: &str) -> bool {
    p.starts_with("margin") || p.starts_with("padding") || p.starts_with("border-radius") || p.starts_with("inset") || SPACING_PROPS.contains(&p)
}

const MAX_HARDCODED: usize = 300;

pub fn token_report(root: &Path) -> Result<TokensReport, WebError> {
    let w = walk(root);
    let mut reader = Reader::new(root);
    let mut refs = Refs::default();
    let mut class_refs = ClassRefs::default();
    let mut tailwind = false;
    let mut style_facts: Vec<(String, Facts)> = Vec::new();
    let mut kept = 0usize;
    let mut files = 0u32;
    for e in &w.files {
        let style = is_style(&e.ext);
        if !style && !is_source(&e.ext) {
            continue;
        }
        let Some(text) = reader.read(e, if style { STYLE_CAP } else { SRC_CAP }) else { continue };
        files += 1;
        scan_refs(&text, &e.ext, &mut refs);
        if style {
            tailwind |= text.contains("@theme") || text.contains("@import \"tailwindcss") || text.contains("@import 'tailwindcss") || text.contains("@tailwind ");
            let facts = scan_file(&text, &e.ext);
            kept += facts.approx_bytes();
            if kept > FACT_BUDGET {
                if !reader.truncated {
                    reader.skipped.push("stopped keeping details: the style sheets are very large together".into());
                }
                reader.truncated = true;
            } else {
                style_facts.push((e.rel.clone(), facts));
            }
        } else {
            scan_class_refs(&text, &mut class_refs);
        }
    }

    let mut order: Vec<(&'static str, String)> = Vec::new();
    let mut accs: HashMap<(&'static str, String), Acc> = HashMap::new();
    let forwards = style_facts.iter().any(|(_, f)| f.forwards);
    for (rel, f) in &style_facts {
        let ext = rel.rsplit('.').next().unwrap_or("");
        for d in &f.decls {
            let (kind, in_root) = if d.prop.starts_with("--") {
                ("custom", d.in_root)
            } else if d.prop.starts_with('$') && d.prop.len() > 1 && d.top_level {
                (if d.value.starts_with('(') && d.value.contains(':') { "scssMap" } else { "scss" }, true)
            } else if d.prop.starts_with('@') && d.prop.len() > 1 && ext == "less" && d.top_level {
                ("less", true)
            } else {
                continue;
            };
            let key = (kind, d.prop.clone());
            match accs.get_mut(&key) {
                Some(a) => {
                    a.token.definitions += 1;
                    if in_root && !a.root {
                        a.root = true;
                        a.token.value = clean(&d.value, 120);
                        a.token.file = rel.clone();
                        a.token.line = d.line;
                    }
                }
                None => {
                    order.push(key.clone());
                    let value = clean(&d.value, 120);
                    accs.insert(
                        key,
                        Acc {
                            root: in_root,
                            token: Token { name: d.prop.clone(), kind, value, file: rel.clone(), line: d.line, definitions: 1, uses: 0, mentions: 0, unused: false, utility: false, confidence: Confidence::High, swatch: None },
                        },
                    );
                }
            }
        }
    }
    let mut tokens: Vec<Token> = Vec::new();
    for key in &order {
        let mut t = accs.remove(key).map(|a| a.token).expect("ordered key");
        match t.kind {
            "custom" => {
                t.uses = refs.uses.get(&t.name).copied().unwrap_or(0);
                t.mentions = refs.mentions.get(&t.name).copied().unwrap_or(0);
                t.unused = t.uses == 0 && t.mentions == 0;
                if refs.dynamic {
                    t.confidence = Confidence::Medium;
                }
            }
            "less" => {
                t.uses = refs.at.get(&t.name).copied().unwrap_or(0);
                t.unused = t.uses == 0;
            }
            _ => {
                t.uses = refs.dollar.get(&t.name).copied().unwrap_or(0);
                t.unused = t.uses == 0;
                if forwards {
                    t.confidence = Confidence::Medium;
                }
            }
        }
        t.swatch = swatch(&t.value);
        tokens.push(t);
    }
    if tailwind {
        // every `-suffix` of every word written in a string: `bg-brand-500` offers `brand-500` and `500`
        let mut tails: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for w in &class_refs.words {
            for (i, _) in w.match_indices('-') {
                tails.insert(&w[i + 1..]);
            }
        }
        for t in tokens.iter_mut().filter(|t| t.kind == "custom" && t.uses == 0 && t.mentions == 0) {
            let Some(rest) = t.name.strip_prefix("--") else { continue };
            if let Some(suffix) = TAILWIND_NAMESPACES.iter().find_map(|ns| rest.strip_prefix(ns).and_then(|r| r.strip_prefix('-'))) {
                if tails.contains(suffix) {
                    t.utility = true;
                    t.unused = false;
                }
            }
        }
    }
    tokens.sort_by(|a, b| a.kind.cmp(b.kind).then_with(|| a.name.cmp(&b.name)));

    // value -> token, first one wins
    let mut by_color: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut by_length: HashMap<String, String> = HashMap::new();
    for t in tokens.iter().filter(|t| t.kind != "scssMap") {
        if let Some(c) = normalize_color(&t.value) {
            by_color.entry(c).or_default().push(t.name.clone());
        } else if let Some(l) = normalize_length(&t.value) {
            by_length.entry(l).or_insert_with(|| t.name.clone());
        }
    }
    let suggest = |name: &str| if name.starts_with("--") { format!("var({name})") } else { name.to_string() };

    let mut hardcoded = Vec::new();
    let mut loose: HashMap<String, (u32, Vec<String>)> = HashMap::new();
    for (rel, f) in &style_facts {
        for d in &f.decls {
            if d.prop.starts_with("--") || d.prop.starts_with('$') || d.prop.starts_with('@') {
                continue;
            }
            for part in components(&d.value) {
                if let Some(c) = normalize_color(part) {
                    if let Some(names) = by_color.get(&c) {
                        if hardcoded.len() < MAX_HARDCODED {
                            hardcoded.push(HardCoded { file: rel.clone(), line: d.line, prop: clean(&d.prop, 60), value: clean(part, 60), token: names[0].clone(), suggestion: suggest(&names[0]) });
                        }
                    } else {
                        let e = loose.entry(c).or_insert((0, Vec::new()));
                        e.0 += 1;
                        if e.1.len() < 3 {
                            e.1.push(format!("{rel}:{}", d.line));
                        }
                    }
                } else if is_spacing_prop(&d.prop) {
                    if let Some(name) = normalize_length(part).and_then(|l| by_length.get(&l)) {
                        if hardcoded.len() < MAX_HARDCODED {
                            hardcoded.push(HardCoded { file: rel.clone(), line: d.line, prop: clean(&d.prop, 60), value: clean(part, 60), token: name.clone(), suggestion: suggest(name) });
                        }
                    }
                }
            }
        }
    }
    let mut duplicates: Vec<DuplicateColor> = by_color
        .iter()
        .filter(|(_, names)| names.len() >= 2)
        .map(|(c, names)| DuplicateColor { value: c.clone(), swatch: swatch(c), tokens: names.clone(), hardcoded: 0, examples: Vec::new() })
        .collect();
    duplicates.extend(loose.into_iter().filter(|(_, (n, _))| *n >= 3).map(|(c, (n, ex))| DuplicateColor { swatch: swatch(&c), value: c, tokens: Vec::new(), hardcoded: n, examples: ex }));
    duplicates.sort_by(|a, b| (b.hardcoded + b.tokens.len() as u32).cmp(&(a.hardcoded + a.tokens.len() as u32)).then_with(|| a.value.cmp(&b.value)));
    duplicates.truncate(50);

    let swatches: Vec<Swatch> = tokens.iter().filter_map(|t| t.swatch.clone().map(|value| Swatch { name: t.name.clone(), value })).take(200).collect();
    let mut skipped = reader.skipped;
    skipped.extend(w.notes);
    Ok(TokensReport { tokens, hardcoded, duplicates, swatches, files_scanned: files, dynamic_names: refs.dynamic, truncated: reader.truncated, skipped })
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

    #[test]
    fn counts_uses_and_finds_unused_custom_properties_and_scss_variables() {
        let d = repo(&[
            ("src/theme.css", ":root { --brand: #FF0000; --gap: 8px; --old: #123456; --dyn: 1px; --text: #FF0000 }\n.a { color: var(--brand); padding: var(--gap) }"),
            ("src/App.tsx", "export const A = () => <div style={{ margin: 'var(--gap)', '--local': 1 }} />;"),
            ("src/vars.scss", "$primary: #0f0;\n$unused: 3px;\n$spacers: (sm: 4px, md: 8px);\n.b { color: $primary; margin: map-get($spacers, sm) }"),
        ]);
        let r = token_report(d.path()).unwrap();
        let get = |n: &str| r.tokens.iter().find(|t| t.name == n).unwrap();
        assert_eq!((get("--brand").uses, get("--brand").unused), (1, false));
        assert_eq!(get("--gap").uses, 2);
        assert!(get("--old").unused && get("--old").confidence == Confidence::High);
        assert!(!get("$primary").unused && get("$unused").unused && !get("$spacers").unused);
        assert_eq!(get("$spacers").kind, "scssMap");
        assert!(!r.dynamic_names);
    }

    #[test]
    fn a_name_built_at_run_time_lowers_the_confidence_of_unused() {
        let d = repo(&[("a.css", ":root { --c-red: red }"), ("a.tsx", "const v = `var(--${name})`;")]);
        let r = token_report(d.path()).unwrap();
        assert!(r.dynamic_names);
        assert!(r.tokens[0].unused && r.tokens[0].confidence == Confidence::Medium);
    }

    #[test]
    fn a_name_that_is_only_mentioned_is_not_unused() {
        let d = repo(&[("a.css", ":root { --c: red }"), ("a.ts", "getComputedStyle(el).getPropertyValue('--c')")]);
        let r = token_report(d.path()).unwrap();
        assert_eq!((r.tokens[0].uses, r.tokens[0].mentions, r.tokens[0].unused), (0, 1, false));
    }

    #[test]
    fn hardcoded_values_that_equal_a_token_and_duplicate_colours() {
        let d = repo(&[
            ("t.css", ":root { --brand: #ff0000; --also: #F00; --space: 16px; }"),
            ("a.css", ".a { color: #f00; background: rgb(0, 0, 0); border: 1px solid #000; padding: 16px 4px; width: 16px }\n.b { color: #000000 } .c { color: BLACK }"),
        ]);
        let r = token_report(d.path()).unwrap();
        let hc: Vec<(&str, &str, &str)> = r.hardcoded.iter().map(|h| (h.prop.as_str(), h.value.as_str(), h.suggestion.as_str())).collect();
        assert!(hc.contains(&("color", "#f00", "var(--also)")) || hc.contains(&("color", "#f00", "var(--brand)")));
        assert!(hc.iter().any(|h| h.0 == "padding" && h.1 == "16px" && h.2 == "var(--space)"));
        let dup_tokens = r.duplicates.iter().find(|x| x.value == "#ff0000").unwrap();
        assert_eq!(dup_tokens.tokens.len(), 2);
        let black = r.duplicates.iter().find(|x| x.value == "#000000").unwrap();
        assert!(black.hardcoded >= 3 && black.tokens.is_empty() && !black.examples.is_empty());
        assert!(r.swatches.iter().any(|s| s.name == "--brand" && s.value == "#ff0000"));
    }

    #[test]
    fn hostile_values_never_become_swatches() {
        let d = repo(&[("a.css", ":root { --x: red; --y: #fff} \n:root { --z: url(javascript:alert(1)); --w: rgb(1,2,3);background:x }")]);
        let r = token_report(d.path()).unwrap();
        assert!(r.swatches.iter().all(|s| s.value.starts_with('#') || s.value.starts_with("rgb(")));
        assert!(!r.swatches.iter().any(|s| s.name == "--z"));
    }

    #[test]
    fn huge_and_binary_files_do_not_break_the_scan() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("big.css"), vec![b'a'; (STYLE_CAP + 1) as usize]).unwrap();
        std::fs::write(d.path().join("bad.css"), [0xff, 0xfe, b'{', b'}', 0x80, b'-', b'-']).unwrap();
        let line = "var(--".repeat(300_000);
        std::fs::write(d.path().join("m.js"), line).unwrap();
        let r = token_report(d.path()).unwrap();
        assert!(r.skipped.iter().any(|s| s.contains("big.css")));
    }

    #[test]
    fn a_pile_of_hostile_style_sheets_cannot_grow_the_scan_without_a_bound() {
        let d = tempfile::tempdir().unwrap();
        let selector = format!(".{}", "s".repeat(588));
        for i in 0..60 {
            std::fs::write(d.path().join(format!("h{i}.css")), format!("{selector} {{ {} }}", "a:1px;".repeat(19_000))).unwrap();
        }
        let t = std::time::Instant::now();
        let r = token_report(d.path()).unwrap();
        assert!(r.truncated && r.skipped.iter().any(|s| s.contains("very large together")), "{:?}", r.skipped);
        assert!(t.elapsed().as_secs() < if cfg!(debug_assertions) { 20 } else { 4 }, "{:?}", t.elapsed());
    }

    #[test]
    fn tailwind_v4_theme_variables_used_as_utility_classes_are_not_unused() {
        let d = repo(&[
            ("app.css", "@import \"tailwindcss\";\n@theme { --color-brand: #5b8def; --color-ghost: #eee; --font-display: serif; --other: 1px }"),
            ("A.tsx", "export const A = () => <h1 className=\"bg-brand/50 font-display text-lg\" />;"),
        ]);
        let r = token_report(d.path()).unwrap();
        let get = |n: &str| r.tokens.iter().find(|t| t.name == n).unwrap();
        assert!(get("--color-brand").utility && !get("--color-brand").unused);
        assert!(get("--font-display").utility && !get("--font-display").unused);
        assert!(get("--color-ghost").unused && !get("--color-ghost").utility, "no class uses ghost");
        assert!(get("--other").unused, "not a theme namespace");
        // without Tailwind in the project the same names get no such credit
        let d = repo(&[("app.css", ":root { --color-brand: #5b8def }"), ("A.tsx", "const c = 'bg-brand';")]);
        assert!(token_report(d.path()).unwrap().tokens[0].unused);
    }
}
