//! A small, linear-time scanner for CSS, SCSS, Less and (a little of) indented Sass. It is not a parser: it follows braces,
//! strings and comments and hands back the declarations and the selectors, which is all the token and style tools need.
//! Every loop moves forward byte by byte, so pathological input (unbalanced braces, megabytes of `{`, unterminated strings
//! and comments) costs time proportional to its size, and the number of results is capped.

pub(crate) const MAX_DECLS: usize = 20_000;
pub(crate) const MAX_RULES: usize = 20_000;
const MAX_DEPTH: usize = 200;
const MAX_PROP: usize = 64;
const MAX_VALUE: usize = 200;
const MAX_SELECTOR: usize = 300;

#[derive(Debug, Clone)]
pub(crate) struct Decl {
    pub prop: String,
    pub value: String,
    pub line: u32,
    /// Not inside any rule (a top-level variable).
    pub top_level: bool,
    /// Inside a rule whose selector is `:root` or `html`.
    pub in_root: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct Rule {
    pub selector: String,
    pub line: u32,
    /// Index of the enclosing rule (SCSS nesting).
    pub parent: Option<usize>,
}

/// A declaration worth keeping: a variable (custom property, SCSS or Less), `composes`, or a value that holds a digit, a `#`, a function
/// or a colour keyword, which are the only values the tools compare. The rest (`display: flex`) is dropped at once, so a hostile file
/// of thousands of tiny declarations costs nothing to keep.
fn worth_keeping(prop: &str, value: &str) -> bool {
    prop.starts_with("--") || prop.starts_with('$') || prop.starts_with('@') || prop == "composes" || value.bytes().any(|b| b.is_ascii_digit() || b == b'#' || b == b'(') || value.eq_ignore_ascii_case("white") || value.eq_ignore_ascii_case("black")
}

#[derive(Debug, Default)]
pub(crate) struct Facts {
    pub decls: Vec<Decl>,
    pub rules: Vec<Rule>,
    /// The file has an `@forward` (its variables are exported, so "unused" is less sure).
    pub forwards: bool,
}

impl Facts {
    /// A cheap estimate of the memory these facts hold, for the global budget of a scan.
    pub(crate) fn approx_bytes(&self) -> usize {
        self.decls.iter().map(|d| 64 + d.prop.len() + d.value.len()).sum::<usize>() + self.rules.iter().map(|r| 48 + r.selector.len()).sum::<usize>()
    }
}

enum Frame {
    At,
    Sel(usize),
    Props,
}

fn lossy(b: &[u8], max: usize) -> String {
    let s = String::from_utf8_lossy(b);
    let s = s.trim();
    if s.len() <= max {
        s.to_string()
    } else {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s[..end].to_string()
    }
}

fn prop_ok(p: &str) -> bool {
    !p.is_empty() && p.len() <= MAX_PROP && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'$' | b'@' | b'\\') || b >= 0x80)
}

/// The first `:` outside parentheses and strings.
fn colon_at(s: &[u8]) -> Option<usize> {
    let mut depth = 0i32;
    let mut i = 0;
    while i < s.len() {
        match s[i] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b':' if depth <= 0 => return Some(i),
            b'"' | b'\'' => {
                let q = s[i];
                i += 1;
                while i < s.len() && s[i] != q {
                    if s[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

#[allow(unused_assignments)]
pub(crate) fn scan(text: &str, preproc: bool) -> Facts {
    let b = text.as_bytes();
    let mut facts = Facts::default();
    let mut stack: Vec<Frame> = Vec::new();
    let mut overflow = 0usize;
    let mut cur: Vec<u8> = Vec::new();
    let mut line = 1u32;
    let mut stmt_line = 1u32;
    let mut started = false;
    let mut paren = 0usize;
    let mut i = 0usize;
    // (no rule around, the rule around is :root or html)
    let scope_of = |stack: &[Frame], rules: &[Rule]| -> (bool, bool) {
        match stack.iter().rev().find_map(|f| if let Frame::Sel(r) = f { Some(&rules[*r].selector) } else { None }) {
            None => (true, false),
            Some(sel) => (false, sel.contains(":root") || sel.trim() == "html"),
        }
    };
    macro_rules! flush_decl {
        () => {{
            let stmt = lossy(&cur, 4096);
            cur.clear();
            started = false;
            if !stmt.is_empty() && facts.decls.len() < MAX_DECLS {
                let sb = stmt.as_bytes();
                if sb[0] == b'@' {
                    if stmt.starts_with("@forward") {
                        facts.forwards = true;
                    }
                    // Less variable: `@brand: #fff`
                    if preproc {
                        if let Some(c) = colon_at(sb) {
                            let (p, v) = (stmt[..c].trim(), stmt[c + 1..].trim());
                            if prop_ok(p) && p.len() > 1 && !p.contains(char::is_whitespace) {
                                let (top_level, in_root) = scope_of(&stack, &facts.rules);
                                facts.decls.push(Decl { prop: p.to_string(), value: lossy(v.as_bytes(), MAX_VALUE), line: stmt_line, top_level, in_root });
                            }
                        }
                    }
                } else if let Some(c) = colon_at(sb) {
                    let (p, v) = (stmt[..c].trim(), stmt[c + 1..].trim());
                    if prop_ok(p) && worth_keeping(p, v) {
                        let (top_level, in_root) = scope_of(&stack, &facts.rules);
                        facts.decls.push(Decl { prop: p.to_string(), value: lossy(v.as_bytes(), MAX_VALUE), line: stmt_line, top_level, in_root });
                    }
                }
            }
        }};
    }
    while i < b.len() {
        let c = b[i];
        if c == b'\n' {
            line += 1;
        }
        if !started && !c.is_ascii_whitespace() {
            started = true;
            stmt_line = line;
        }
        match c {
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i < b.len() && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                    if b[i] == b'\n' {
                        line += 1;
                    }
                    i += 1;
                }
                i += 2;
                cur.push(b' ');
                continue;
            }
            b'/' if preproc && paren == 0 && b.get(i + 1) == Some(&b'/') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            b'"' | b'\'' => {
                cur.push(c);
                i += 1;
                while i < b.len() && b[i] != c && b[i] != b'\n' {
                    if b[i] == b'\\' && i + 1 < b.len() && b[i + 1] != b'\n' {
                        cur.push(b[i]);
                        i += 1;
                    }
                    cur.push(b[i]);
                    i += 1;
                }
                if i < b.len() && b[i] == c {
                    cur.push(c);
                    i += 1;
                }
                continue;
            }
            b'#' if b.get(i + 1) == Some(&b'{') => {
                // Sass interpolation: copied as one piece
                let mut depth = 0usize;
                while i < b.len() {
                    if b[i] == b'\n' {
                        line += 1;
                    }
                    cur.push(b[i]);
                    if b[i] == b'{' {
                        depth += 1;
                    } else if b[i] == b'}' {
                        depth -= 1;
                        if depth == 0 {
                            i += 1;
                            break;
                        }
                    }
                    i += 1;
                }
                continue;
            }
            b'(' => {
                paren += 1;
                cur.push(c);
            }
            b')' => {
                paren = paren.saturating_sub(1);
                cur.push(c);
            }
            b'{' => {
                let prelude = lossy(&cur, MAX_SELECTOR);
                cur.clear();
                started = false;
                if stack.len() >= MAX_DEPTH {
                    overflow += 1;
                } else if prelude.starts_with('@') {
                    stack.push(Frame::At);
                } else if prelude.ends_with(':') {
                    stack.push(Frame::Props);
                } else if facts.rules.len() < MAX_RULES {
                    let parent = stack.iter().rev().find_map(|f| if let Frame::Sel(r) = f { Some(*r) } else { None });
                    facts.rules.push(Rule { selector: prelude, line: stmt_line, parent });
                    stack.push(Frame::Sel(facts.rules.len() - 1));
                } else {
                    stack.push(Frame::At);
                }
                paren = 0;
            }
            b'}' => {
                flush_decl!();
                if overflow > 0 {
                    overflow -= 1;
                } else {
                    stack.pop();
                }
                paren = 0;
            }
            b';' if paren == 0 => flush_decl!(),
            _ => cur.push(c),
        }
        i += 1;
    }
    flush_decl!();
    facts
}

/// Indented Sass (no braces): `$var: value` lines and selector lines that start with `.` or `&`. A line-based best effort.
pub(crate) fn scan_indented(text: &str) -> Facts {
    let mut facts = Facts::default();
    let mut stack: Vec<(usize, usize)> = Vec::new(); // (indent, rule index)
    for (n, raw) in text.lines().enumerate().take(200_000) {
        let line = raw.trim_end();
        let t = line.trim_start();
        if t.is_empty() || t.starts_with("//") {
            continue;
        }
        let indent = line.len() - t.len();
        while stack.last().is_some_and(|(ind, _)| *ind >= indent) {
            stack.pop();
        }
        let lineno = (n + 1) as u32;
        if t.starts_with('$') || t.starts_with("--") {
            if let Some((p, v)) = t.split_once(':') {
                if facts.decls.len() < MAX_DECLS && prop_ok(p.trim()) {
                    facts.decls.push(Decl { prop: p.trim().to_string(), value: lossy(v.as_bytes(), MAX_VALUE), line: lineno, top_level: true, in_root: false });
                }
            }
        } else if (t.starts_with('.') || t.starts_with('&') || t.starts_with('#')) && facts.rules.len() < MAX_RULES {
            let parent = stack.last().map(|(_, r)| *r);
            facts.rules.push(Rule { selector: lossy(t.as_bytes(), MAX_SELECTOR), line: lineno, parent });
            stack.push((indent, facts.rules.len() - 1));
        } else if let Some((p, v)) = t.split_once(':') {
            let (top_level, in_root) = match stack.last() {
                None => (true, false),
                Some((_, r)) => (false, facts.rules[*r].selector.contains(":root")),
            };
            if facts.decls.len() < MAX_DECLS && prop_ok(p.trim()) && !p.contains(' ') && worth_keeping(p.trim(), v) {
                facts.decls.push(Decl { prop: p.trim().to_string(), value: lossy(v.as_bytes(), MAX_VALUE), line: lineno, top_level, in_root });
            }
        }
    }
    facts
}

pub(crate) fn scan_file(text: &str, ext: &str) -> Facts {
    match ext {
        "sass" => scan_indented(text),
        "scss" | "less" => scan(text, true),
        _ => scan(text, false),
    }
}

fn ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b >= 0x80
}

/// The class names a selector writes: `(name, global)`; `global` is a class inside `:global(...)`. Classes inside `:not(...)`
/// are not definitions and are left out. Escapes (`.md\:flex`) are decoded; a class cut by interpolation (`.a-#{$b}`) is left out.
pub(crate) fn classes_in(selector: &str) -> Vec<(String, bool)> {
    let s = selector.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    let mut global_until: Vec<usize> = Vec::new(); // paren depth at which a :global( opened
    let mut depth = 0usize;
    let mut skip_until_depth: Option<usize> = None;
    while i < s.len() {
        match s[i] {
            b'[' => {
                while i < s.len() && s[i] != b']' {
                    if s[i] == b'"' || s[i] == b'\'' {
                        let q = s[i];
                        i += 1;
                        while i < s.len() && s[i] != q {
                            i += 1;
                        }
                    }
                    i += 1;
                }
            }
            b'(' => {
                depth += 1;
                let before = &s[..i];
                if before.ends_with(b":not") && skip_until_depth.is_none() {
                    skip_until_depth = Some(depth);
                } else if before.ends_with(b":global") {
                    global_until.push(depth);
                }
            }
            b')' => {
                if skip_until_depth == Some(depth) {
                    skip_until_depth = None;
                }
                if global_until.last() == Some(&depth) {
                    global_until.pop();
                }
                depth = depth.saturating_sub(1);
            }
            b'.' if skip_until_depth.is_none() => {
                let mut j = i + 1;
                let mut name = Vec::new();
                let mut cut = false;
                while j < s.len() {
                    if s[j] == b'\\' && j + 1 < s.len() {
                        name.push(s[j + 1]);
                        j += 2;
                    } else if ident_byte(s[j]) {
                        name.push(s[j]);
                        j += 1;
                    } else {
                        cut = s[j] == b'#' && s.get(j + 1) == Some(&b'{');
                        break;
                    }
                }
                let starts_ok = name.first().is_some_and(|c| !c.is_ascii_digit());
                if starts_ok && !cut && name.len() <= 200 {
                    out.push((String::from_utf8_lossy(&name).into_owned(), !global_until.is_empty() || selector.trim_start().starts_with(":global ")));
                }
                i = j.max(i + 1);
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    out
}

/// A selector split at its top-level commas.
pub(crate) fn split_selectors(selector: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    for (i, c) in selector.char_indices() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            ',' if depth <= 0 => {
                out.push(selector[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(selector[start..].trim());
    out.retain(|s| !s.is_empty());
    out
}

/// The `&-suffix` pieces of a selector part: `&-title`, `&__item`, `&_x` (an `&` directly followed by name characters).
pub(crate) fn amp_suffixes(part: &str) -> Vec<String> {
    let s = part.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < s.len() {
        if s[i] == b'&' {
            let mut j = i + 1;
            while j < s.len() && ident_byte(s[j]) {
                j += 1;
            }
            if j > i + 1 {
                out.push(part[i + 1..j].to_string());
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// Every class a rule defines, with nesting resolved: `.card { &__title {} }` defines `card` and `card__title`.
/// Returns, per rule, `(class, global)` pairs.
pub(crate) fn defined_classes(rules: &[Rule]) -> Vec<Vec<(String, bool)>> {
    let mut per: Vec<Vec<(String, bool)>> = Vec::with_capacity(rules.len());
    for r in rules {
        let mut mine = classes_in(&r.selector);
        if r.selector.contains('&') {
            if let Some(p) = r.parent {
                // `&-x` extends every class the parent defines; with a parent that lists several, each one gets the suffix
                let parent_classes: Vec<(String, bool)> = per[p].clone();
                for part in split_selectors(&r.selector) {
                    for suffix in amp_suffixes(part) {
                        for (pc, g) in &parent_classes {
                            if mine.len() < 400 {
                                mine.push((format!("{pc}{suffix}"), *g));
                            }
                        }
                    }
                }
            }
        }
        per.push(mine);
    }
    per
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declarations_rules_and_nesting() {
        let f = scan(":root { --brand: #ff0000; --gap: 8px }\n.card { color: var(--brand); &__title { margin: 0 } }\n", false);
        let props: Vec<(&str, &str, u32)> = f.decls.iter().map(|d| (d.prop.as_str(), d.value.as_str(), d.line)).collect();
        assert_eq!(props, vec![("--brand", "#ff0000", 1), ("--gap", "8px", 1), ("color", "var(--brand)", 2), ("margin", "0", 2)]);
        assert!(f.decls[0].in_root && !f.decls[0].top_level);
        assert!(!f.decls[2].in_root && !f.decls[2].top_level);
        assert_eq!(f.rules.iter().map(|r| r.selector.as_str()).collect::<Vec<_>>(), vec![":root", ".card", "&__title"]);
        assert_eq!(f.rules[2].parent, Some(1));
    }

    #[test]
    fn scss_variables_comments_and_urls() {
        let f = scan("// $hidden: 1;\n$brand: #fff; /* $gone: 2 */\n.a { background: url(http://x.test/a.png); }\n$map: (a: 1, b: 2);\n", true);
        let names: Vec<&str> = f.decls.iter().map(|d| d.prop.as_str()).collect();
        assert_eq!(names, vec!["$brand", "background", "$map"]);
        assert_eq!(f.decls[1].value, "url(http://x.test/a.png)");
        assert_eq!(f.decls[2].value, "(a: 1, b: 2)");
    }

    #[test]
    fn less_variables_and_sass_interpolation() {
        let f = scan("@brand: #00f;\n.a-#{$n} { color: @brand; }\n", true);
        assert_eq!(f.decls[0].prop, "@brand");
        assert_eq!(f.rules[0].selector, ".a-#{$n}");
    }

    #[test]
    fn classes_are_found_and_nesting_is_resolved() {
        assert_eq!(classes_in("div.a.b > .c:hover, [data-x='.no'] .d"), vec![("a".into(), false), ("b".into(), false), ("c".into(), false), ("d".into(), false)]);
        assert_eq!(classes_in(".x:not(.y) .md\\:flex"), vec![("x".into(), false), ("md:flex".into(), false)]);
        assert_eq!(classes_in(":global(.g) .l"), vec![("g".into(), true), ("l".into(), false)]);
        assert_eq!(classes_in(".w-.5 .a-#{$b}"), vec![("w-".into(), false)]);
        let f = scan(".card { &__title { &--big {} } &.on {} }", true);
        let per = defined_classes(&f.rules);
        assert_eq!(per[1], vec![("card__title".to_string(), false)]);
        assert_eq!(per[2], vec![("card__title--big".to_string(), false)]);
        assert_eq!(per[3], vec![("on".to_string(), false)]);
    }

    #[test]
    fn indented_sass() {
        let f = scan_indented("$brand: #fff\n.card\n  color: red\n  &__t\n    margin: 0\n");
        assert_eq!(f.decls.iter().map(|d| d.prop.as_str()).collect::<Vec<_>>(), vec!["$brand", "margin"]);
        assert_eq!(f.rules.len(), 2);
        assert_eq!(f.rules[1].parent, Some(0));
    }

    #[test]
    fn hostile_input_stays_linear_and_bounded() {
        let many_open = "{".repeat(2_000_000);
        let f = scan(&many_open, true);
        assert!(f.rules.len() <= MAX_RULES);
        let unterminated = format!("/* {}", "a".repeat(3_000_000));
        assert!(scan(&unterminated, false).decls.is_empty());
        let q = format!("a: \"{}", "x".repeat(3_000_000));
        assert!(scan(&q, false).decls.len() <= 1);
        let decls = "a:1;".repeat(200_000);
        assert_eq!(scan(&decls, false).decls.len(), MAX_DECLS);
        let pathological = format!(".{}", "a,".repeat(500_000));
        let _ = defined_classes(&scan(&format!("{pathological} {{}}"), true).rules);
    }

    #[test]
    fn declarations_that_nothing_compares_are_not_kept() {
        let f = scan(".a { display: flex; color: red; margin: 0 auto; padding: 4px; background: #fff; width: calc(1px + 2px); --x: y; composes: b }", false);
        let props: Vec<&str> = f.decls.iter().map(|d| d.prop.as_str()).collect();
        assert_eq!(props, vec!["margin", "padding", "background", "width", "--x", "composes"]);
    }

    /// The review's file: a 590-character selector and 30,000 tiny declarations, 117 KB. Before, every declaration cloned the whole selector
    /// (about 22 MB in memory for this one file).
    #[test]
    fn the_memory_of_the_facts_stays_a_small_multiple_of_the_input() {
        let selector = format!(".{}", "s".repeat(588));
        for decl in ["a:b;", "a:1;"] {
            let text = format!("{selector} {{ {} }}", decl.repeat(30_000));
            let f = scan(&text, true);
            assert!(f.approx_bytes() < 20 * text.len(), "{decl}: {} bytes of facts for {} bytes of input", f.approx_bytes(), text.len());
            assert!(f.decls.len() <= MAX_DECLS);
        }
        // and the selector is not copied per declaration at all
        let f = scan(&format!("{selector} {{ {} }}", "a:1;".repeat(1000)), true);
        assert!(f.approx_bytes() < 120 * 1000 + 2000, "{}", f.approx_bytes());
    }
}
