//! "Find the CSS rule": given the tag, id and classes of an element in the preview, a ranked static search of the stylesheets for
//! the rules that style it. The class names of CSS modules in the page are hashed (`Button_primary__x7f3a`), so the readable middle
//! is tried too. Read-only.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::cssscan::{classes_in, scan_file, split_selectors};
use crate::walk::walk;
use crate::{clean, is_style, Reader, WebError, STYLE_CAP};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleQuery {
    pub tag: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub classes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleMatch {
    pub file: String,
    pub line: u32,
    pub selector: String,
    pub score: u32,
    /// What matched: `class`, `id`, `tag`, `module`.
    pub why: Vec<&'static str>,
}

fn ident(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b':') || b >= 0x80)
}

/// The readable part of a hashed CSS-module class: `Button_primary__x7f3a` -> `primary`, `_primary_1abcd_12` -> `primary`.
fn module_local(c: &str) -> Option<String> {
    if let Some((head, hash)) = c.rsplit_once("__") {
        if (4..=10).contains(&hash.len()) && hash.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
            if let Some((_, local)) = head.split_once('_') {
                if !local.is_empty() {
                    return Some(local.to_string());
                }
            }
        }
    }
    let t = c.strip_prefix('_')?;
    let (rest, num) = t.rsplit_once('_')?;
    let (local, hash) = rest.rsplit_once('_')?;
    (num.bytes().all(|b| b.is_ascii_digit()) && !num.is_empty() && (4..=8).contains(&hash.len()) && !local.is_empty()).then(|| local.to_string())
}

pub fn find_rule(root: &Path, q: &RuleQuery) -> Result<Vec<RuleMatch>, WebError> {
    let tag = q.tag.to_ascii_lowercase();
    let tag = if ident(&tag, 40) { tag } else { String::new() };
    let id = if ident(&q.id, 100) { q.id.clone() } else { String::new() };
    let classes: Vec<String> = q.classes.iter().filter(|c| ident(c, 100)).take(12).cloned().collect();
    if tag.is_empty() && id.is_empty() && classes.is_empty() {
        return Ok(Vec::new());
    }
    // (class to look for, came from a hashed module name)
    let mut wanted: Vec<(String, bool)> = classes.iter().map(|c| (c.clone(), false)).collect();
    wanted.extend(classes.iter().filter_map(|c| module_local(c)).map(|l| (l, true)));
    let w = walk(root);
    let mut reader = Reader::new(root);
    let mut out: Vec<RuleMatch> = Vec::new();
    for e in w.files.iter().filter(|e| is_style(&e.ext)) {
        let Some(text) = reader.read(e, STYLE_CAP) else { continue };
        let facts = scan_file(&text, &e.ext);
        let per = crate::cssscan::defined_classes(&facts.rules);
        for (rule, defined) in facts.rules.iter().zip(&per) {
            let mut score = 0u32;
            let mut why: Vec<&'static str> = Vec::new();
            let defined_names: Vec<&str> = defined.iter().map(|(n, _)| n.as_str()).collect();
            let mut matched_classes = 0u32;
            for (c, hashed) in &wanted {
                if defined_names.contains(&c.as_str()) {
                    score += if *hashed { 8 } else { 10 };
                    matched_classes += 1;
                    let w = if *hashed { "module" } else { "class" };
                    if !why.contains(&w) {
                        why.push(w);
                    }
                }
            }
            if !id.is_empty() && rule.selector.contains(&format!("#{id}")) {
                score += 15;
                why.push("id");
            }
            if !tag.is_empty() && matched_classes == 0 {
                let tag_hit = split_selectors(&rule.selector).iter().any(|part| {
                    let last = part.rsplit([' ', '>', '+', '~']).next().unwrap_or("");
                    let head = last.split(['.', '#', ':', '[']).next().unwrap_or("");
                    head.eq_ignore_ascii_case(&tag) && classes_in(last).is_empty()
                });
                if tag_hit {
                    score += 2;
                    why.push("tag");
                }
            }
            if matched_classes >= 2 {
                // several of the element's classes in one selector: very likely the rule written for it
                let same_part = split_selectors(&rule.selector).iter().any(|p| classes_in(p).iter().filter(|(n, _)| classes.contains(n)).count() >= 2);
                if same_part {
                    score += 8;
                }
            }
            if score > 0 && !rule.selector.starts_with('&') || score > 0 && matched_classes > 0 {
                out.push(RuleMatch { file: e.rel.clone(), line: rule.line, selector: clean(&rule.selector, 160), score, why });
            }
        }
    }
    out.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.file.cmp(&b.file)).then_with(|| a.line.cmp(&b.line)));
    out.truncate(10);
    Ok(out)
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

    fn q(tag: &str, id: &str, classes: &[&str]) -> RuleQuery {
        RuleQuery { tag: tag.into(), id: id.into(), classes: classes.iter().map(|c| c.to_string()).collect() }
    }

    #[test]
    fn ranks_class_rules_over_tag_rules() {
        let d = repo(&[
            ("src/base.css", "button { margin: 0 }\n.card { color: red }"),
            ("src/btn.scss", ".btn { padding: 4px }\n.btn.primary { color: blue }\n.btn { &:hover { color: red } }"),
        ]);
        let got = find_rule(d.path(), &q("button", "", &["btn", "primary"])).unwrap();
        assert_eq!((got[0].file.as_str(), got[0].line), ("src/btn.scss", 2));
        assert!(got.iter().any(|m| m.file == "src/base.css" && m.why == vec!["tag"]));
        assert!(got.iter().all(|m| m.selector != ".card"));
    }

    #[test]
    fn id_and_hashed_module_names() {
        let d = repo(&[("a.module.css", ".primary { color: red }"), ("b.css", "#hero { x: y }")]);
        let got = find_rule(d.path(), &q("div", "hero", &["Button_primary__x7f3a"])).unwrap();
        let files: Vec<&str> = got.iter().map(|m| m.file.as_str()).collect();
        assert_eq!(files, vec!["b.css", "a.module.css"]);
        assert_eq!(module_local("_title_1abcd_12").as_deref(), Some("title"));
        assert_eq!(module_local("plain-class"), None);
    }

    #[test]
    fn hostile_queries_are_dropped() {
        let d = repo(&[("a.css", ".a { x: y }")]);
        assert!(find_rule(d.path(), &q("", "", &["a b", "}{", "a;b"])).unwrap().is_empty());
        assert!(find_rule(d.path(), &q("<script>", "x y", &[])).unwrap().is_empty());
    }
}
