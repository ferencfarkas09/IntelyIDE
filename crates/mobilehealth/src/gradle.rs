//! Line-and-brace reading of Gradle build scripts (Groovy and Kotlin) and `.properties` files. It does not run Gradle and does not
//! understand the language: it finds literals where the common templates write them, and says "unknown" for anything computed.

use std::ops::Range;

/// The text with `//` and `/* */` comments blanked out (same length, same lines), so offsets stay valid and a commented-out
/// setting is not read as a real one.
pub(crate) fn strip_comments(t: &str) -> String {
    let b = t.as_bytes();
    let mut out = b.to_vec();
    let mut i = 0;
    let mut quote: Option<u8> = None;
    while i < b.len() {
        let c = b[i];
        match quote {
            Some(q) => {
                if c == b'\\' {
                    i += 2;
                    continue;
                }
                if c == q || c == b'\n' {
                    quote = None;
                }
                i += 1;
            }
            None => {
                if c == b'"' || c == b'\'' {
                    quote = Some(c);
                    i += 1;
                } else if c == b'/' && b.get(i + 1) == Some(&b'/') {
                    while i < b.len() && b[i] != b'\n' {
                        out[i] = b' ';
                        i += 1;
                    }
                } else if c == b'/' && b.get(i + 1) == Some(&b'*') {
                    while i < b.len() && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                        if b[i] != b'\n' {
                            out[i] = b' ';
                        }
                        i += 1;
                    }
                    for k in [i, i + 1] {
                        if k < b.len() {
                            out[k] = b' ';
                        }
                    }
                    i += 2;
                } else {
                    i += 1;
                }
            }
        }
    }
    // blanking only touched ASCII bytes outside multi-byte sequences (comment bytes are all replaced, a multi-byte char inside a
    // comment becomes spaces), so the result is valid UTF-8
    String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

pub(crate) fn line_of(t: &str, offset: usize) -> u32 {
    1 + t.as_bytes()[..offset.min(t.len())].iter().filter(|c| **c == b'\n').count() as u32
}

/// The end (exclusive) of the `{ ... }` that opens at `open` (a `{`), string-aware; `None` when unbalanced.
fn matching(t: &str, open: usize) -> Option<usize> {
    let b = t.as_bytes();
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut i = open;
    while i < b.len() {
        let c = b[i];
        match quote {
            Some(q) => {
                if c == b'\\' {
                    i += 1;
                } else if c == q || c == b'\n' {
                    quote = None;
                }
            }
            None => match c {
                b'"' | b'\'' => quote = Some(c),
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i + 1);
                    }
                }
                _ => {}
            },
        }
        i += 1;
        if depth > 200 {
            return None;
        }
    }
    None
}

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'.'
}

/// The bodies (inside the braces) of every `name { ... }` in `range`.
pub(crate) fn blocks(t: &str, range: Range<usize>, name: &str) -> Vec<Range<usize>> {
    let b = t.as_bytes();
    let mut out = Vec::new();
    let mut from = range.start;
    while let Some(p) = t.get(from..range.end).and_then(|s| s.find(name)) {
        let at = from + p;
        from = at + name.len();
        if at > 0 && is_ident(b[at - 1]) {
            continue;
        }
        let mut k = at + name.len();
        while k < range.end && matches!(b[k], b' ' | b'\t') {
            k += 1;
        }
        if k < range.end && b[k] == b'{' {
            if let Some(end) = matching(t, k) {
                if end <= range.end {
                    out.push(k + 1..end - 1);
                    from = end;
                }
            }
        }
    }
    out
}

/// The `name { body }` entries directly inside `range`, with `create("x") {`, `register("x") {` and `getByName("x") {` named `x`.
pub(crate) fn children(t: &str, range: Range<usize>) -> Vec<(String, Range<usize>)> {
    let b = t.as_bytes();
    let mut out = Vec::new();
    let mut i = range.start;
    let mut line_start = range.start;
    while i < range.end {
        match b[i] {
            b'\n' | b';' => line_start = i + 1,
            b'{' => {
                let Some(end) = matching(t, i) else { break };
                let head = t[line_start..i].trim();
                if let Some(name) = child_name(head) {
                    out.push((name, i + 1..end - 1));
                }
                i = end;
                line_start = end;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    out
}

fn child_name(head: &str) -> Option<String> {
    if !head.is_empty() && head.bytes().all(is_ident) {
        return Some(head.to_string());
    }
    for f in ["create", "register", "getByName", "maybeCreate", "named"] {
        if let Some(rest) = head.strip_prefix(f) {
            let rest = rest.trim_start().strip_prefix('(')?;
            let q = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
            let end = rest[1..].find(q)?;
            return Some(rest[1..1 + end].to_string());
        }
    }
    None
}

/// `(raw value, byte offset of the value)` of every line of `range` that sets `key` (`key value`, `key = value`, `key(value)`).
pub(crate) fn settings(t: &str, range: Range<usize>, key: &str) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    let mut pos = range.start;
    for l in t[range.clone()].split_inclusive('\n') {
        let start = pos;
        pos += l.len();
        let s = l.trim_start();
        let Some(rest) = s.strip_prefix(key) else { continue };
        let Some(c) = rest.chars().next() else { continue };
        if !(c == ' ' || c == '\t' || c == '=' || c == '(') {
            continue;
        }
        let lead = l.len() - s.len();
        let after = rest.trim_start();
        let (after, paren) = match after.strip_prefix('=') {
            Some(a) => (a.trim_start(), false),
            None => match after.strip_prefix('(') {
                Some(a) => (a, true),
                None => (after, false),
            },
        };
        let mut raw = after.trim_end();
        if paren {
            raw = raw.strip_suffix(')').unwrap_or(raw).trim_end();
        }
        let raw = raw.trim_end_matches(';').trim();
        if raw.is_empty() || raw.starts_with('{') {
            continue;
        }
        let value_at = start + lead + (s.len() - after.len());
        out.push((raw.to_string(), value_at));
    }
    out
}

/// A quoted literal without interpolation, as its content.
pub(crate) fn literal(raw: &str) -> Option<String> {
    let q = raw.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let inner = raw[1..].strip_suffix(q)?;
    (!inner.contains(q) && !inner.contains('$') && !inner.contains('\\')).then(|| inner.to_string())
}

/// Digits only.
pub(crate) fn number(raw: &str) -> Option<u32> {
    (raw.len() <= 9 && !raw.is_empty() && raw.bytes().all(|c| c.is_ascii_digit())).then(|| raw.parse().ok()).flatten()
}

/// The number written after `name` somewhere in `t` (`name = 34`, `"name" to 34`, `set("name", 34)`): how a root script lists the
/// SDK levels in its `ext` block.
pub(crate) fn number_after_name(t: &str, name: &str) -> Option<u32> {
    let b = t.as_bytes();
    let mut from = 0;
    while let Some(p) = t[from..].find(name) {
        let at = from + p;
        from = at + name.len();
        if (at > 0 && is_ident(b[at - 1])) || b.get(at + name.len()).is_some_and(|c| is_ident(*c)) {
            continue;
        }
        let rest = t[at + name.len()..].trim_start_matches([' ', '\t', '"', '\'', ')', ']', '=', ',', '(']).trim_start_matches("to ");
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if let Some(n) = number(&digits) {
            return Some(n);
        }
    }
    None
}

/// The last dotted or quoted name in an expression such as `rootProject.ext.compileSdkVersion`,
/// `rootProject.ext.get("compileSdkVersion")` or `project.property("x")`.
pub(crate) fn reference_name(raw: &str) -> Option<String> {
    let r = raw.trim();
    if let Some(open) = r.find('(') {
        let inner = r[open + 1..].trim_end_matches(')').trim();
        return literal(inner);
    }
    let last = r.rsplit('.').next()?;
    (!last.is_empty() && last.bytes().all(is_ident)).then(|| last.to_string())
}

/// `key=value` lines of a `.properties` file: (key, value, line). Comments and continuation lines are not interpreted.
pub(crate) fn properties(t: &str) -> Vec<(String, String, u32)> {
    let mut out = Vec::new();
    for (n, l) in t.lines().enumerate() {
        let l = l.trim();
        if l.is_empty() || l.starts_with('#') || l.starts_with('!') {
            continue;
        }
        let sep = l.find(['=', ':']);
        let Some(sep) = sep else { continue };
        out.push((l[..sep].trim().to_string(), l[sep + 1..].trim().to_string(), n as u32 + 1));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comments_are_blanked_and_offsets_survive() {
        let t = "a // x\n/* b\n c */ d 'http://e'\n";
        let s = strip_comments(t);
        assert_eq!(s.len(), t.len());
        assert!(!s.contains('x') && !s.contains('b') && s.contains("http://e"));
        assert_eq!(s.matches('\n').count(), 3);
    }

    #[test]
    fn blocks_children_and_settings() {
        let t = "android {\n  signingConfigs {\n    debug {\n      storeFile file('debug.keystore')\n    }\n    create(\"release\") { storePassword \"x\" }\n  }\n  compileSdk = 34\n}\n";
        let all = 0..t.len();
        let android = blocks(t, all, "android");
        assert_eq!(android.len(), 1);
        let sc = blocks(t, android[0].clone(), "signingConfigs");
        let kids = children(t, sc[0].clone());
        assert_eq!(kids.iter().map(|k| k.0.as_str()).collect::<Vec<_>>(), vec!["debug", "release"]);
        let s = settings(t, android[0].clone(), "compileSdk");
        assert_eq!(s[0].0, "34");
        assert_eq!(number(&s[0].0), Some(34));
        assert_eq!(literal("'a b'"), Some("a b".into()));
        assert_eq!(literal("\"$x\""), None);
        assert_eq!(literal("\"a\" + b"), None);
    }

    #[test]
    fn references_and_ext_numbers() {
        assert_eq!(reference_name("rootProject.ext.compileSdkVersion").as_deref(), Some("compileSdkVersion"));
        assert_eq!(reference_name("rootProject.ext.get(\"minSdkVersion\")").as_deref(), Some("minSdkVersion"));
        let root = "buildscript { ext { buildToolsVersion = \"34.0.0\"\n minSdkVersion = 24\n compileSdkVersion = 35 } }";
        assert_eq!(number_after_name(root, "minSdkVersion"), Some(24));
        assert_eq!(number_after_name(root, "compileSdkVersion"), Some(35));
        assert_eq!(number_after_name("extra[\"targetSdk\"] = 34", "targetSdk"), Some(34));
        assert_eq!(number_after_name(root, "nothing"), None);
    }

    #[test]
    fn properties_skip_comments() {
        let p = properties("# c\nnewArchEnabled=true\n\nhermesEnabled : false\n");
        assert_eq!(p[0], ("newArchEnabled".into(), "true".into(), 2));
        assert_eq!(p[1].0, "hermesEnabled");
    }

    #[test]
    fn unbalanced_braces_do_not_loop_or_panic() {
        let t = "android { { { ".repeat(1000);
        assert!(blocks(&t, 0..t.len(), "android").is_empty());
        assert!(children(&t, 0..t.len()).is_empty());
    }
}
