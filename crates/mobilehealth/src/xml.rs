//! A small, forgiving XML tokenizer for `Info.plist`, `.entitlements` and `AndroidManifest.xml`. It never expands an entity, never
//! loads a DTD or an external file, and stops at fixed limits, so a hostile file can cost time but not memory or reach.

/// More tokens than this and the file is treated as unreadable.
const MAX_TOKENS: usize = 400_000;
/// Nesting deeper than this is refused (a plist of a million `<dict>` would blow a recursive reader).
pub(crate) const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Tok {
    Open { name: String, attrs: Vec<(String, String)>, empty: bool, line: u32 },
    Close { name: String, line: u32 },
    Text { text: String, line: u32 },
}

fn unescape(s: &str) -> String {
    // only the five predefined entities and numeric references; anything else stays as written
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        // a reference is short: look only at the first few bytes, or a long run of '&' would be searched to its end each time
        let Some(end) = tail.as_bytes().iter().take(11).position(|b| *b == b';') else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let ent = &tail[1..end];
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => ent
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| ent.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => out.push(c),
            None => out.push_str(&tail[..=end]),
        }
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
    out
}

fn parse_tag(inner: &str, line: u32) -> Option<Tok> {
    if let Some(name) = inner.strip_prefix('/') {
        return Some(Tok::Close { name: name.trim().to_string(), line });
    }
    let (inner, empty) = match inner.strip_suffix('/') {
        Some(i) => (i, true),
        None => (inner, false),
    };
    let name_end = inner.find(|c: char| c.is_whitespace()).unwrap_or(inner.len());
    let name = &inner[..name_end];
    if name.is_empty() {
        return None;
    }
    let mut attrs = Vec::new();
    let mut rest = inner[name_end..].trim_start();
    while !rest.is_empty() {
        let Some(eq) = rest.find('=') else { break };
        let key = rest[..eq].trim().to_string();
        let after = rest[eq + 1..].trim_start();
        let Some(q) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else { break };
        let Some(close) = after[1..].find(q) else { break };
        if attrs.len() >= 128 {
            break;
        }
        attrs.push((key, crate::clean(&unescape(&after[1..1 + close]))));
        rest = after[close + 2..].trim_start();
    }
    Some(Tok::Open { name: name.to_string(), attrs, empty, line })
}

/// The tokens of `text`, or `None` when the file is too big a tangle to read.
pub(crate) fn tokens(text: &str) -> Option<Vec<Tok>> {
    scan(text).0
}

/// `tokens` and the number of steps it took (every construct counts, also the ones that produce no token): the work is linear in
/// the size of the text and stops at `MAX_TOKENS` steps.
pub(crate) fn scan(text: &str) -> (Option<Vec<Tok>>, usize) {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    let mut line = 1u32;
    let mut steps = 0usize;
    let nl = |s: &str| s.bytes().filter(|c| *c == b'\n').count() as u32;
    while i < b.len() {
        steps += 1;
        if steps > MAX_TOKENS {
            return (None, steps);
        }
        if b[i] != b'<' {
            let end = text[i..].find('<').map_or(b.len(), |e| i + e);
            let chunk = &text[i..end];
            if !chunk.trim().is_empty() {
                out.push(Tok::Text { text: crate::clean(&unescape(chunk.trim())), line });
            }
            line += nl(chunk);
            i = end;
            continue;
        }
        let rest = &text[i..];
        if rest.starts_with("<!--") {
            let end = rest.find("-->").map_or(rest.len(), |e| e + 3);
            line += nl(&rest[..end]);
            i += end;
        } else if rest.starts_with("<![CDATA[") {
            let end = rest.find("]]>").map_or(rest.len(), |e| e + 3);
            let body = rest.get(9..end.saturating_sub(3).max(9)).unwrap_or("");
            out.push(Tok::Text { text: crate::clean(body), line });
            line += nl(&rest[..end]);
            i += end;
        } else if rest.starts_with("<?") || rest.starts_with("<!") {
            // declaration, doctype (an internal subset in brackets is skipped as a whole)
            // look for the end first, then for a bracket only before it: searching the whole rest for '[' made every `<!>` cost the rest of the file
            let gt = rest.find('>');
            let subset = rest.starts_with("<!") && gt.is_some_and(|g| rest[..g].contains('['));
            let end = if subset { rest.find("]>").map_or(rest.len(), |e| e + 2) } else { gt.map_or(rest.len(), |e| e + 1) };
            line += nl(&rest[..end]);
            i += end;
        } else {
            // a tag: find the closing '>' outside quotes
            let mut q: Option<u8> = None;
            let mut end = None;
            for (k, c) in rest.bytes().enumerate().skip(1) {
                match (q, c) {
                    (Some(qc), c) if c == qc => q = None,
                    (None, b'"' | b'\'') => q = Some(c),
                    (None, b'>') => {
                        end = Some(k);
                        break;
                    }
                    _ => {}
                }
            }
            let Some(end) = end else { break };
            if let Some(t) = parse_tag(&rest[1..end], line) {
                out.push(t);
            }
            line += nl(&rest[..=end]);
            i += end + 1;
        }
    }
    (Some(out), steps)
}

/// A value of a top-level plist key.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum PVal {
    Str(String),
    Bool(bool),
    Other,
}

#[derive(Debug, Default)]
pub(crate) struct Plist {
    pub entries: Vec<(String, PVal, u32)>,
}

impl Plist {
    pub fn get(&self, key: &str) -> Option<&(String, PVal, u32)> {
        self.entries.iter().find(|e| e.0 == key)
    }
}

#[derive(Debug, PartialEq)]
pub(crate) enum PlistErr {
    Binary,
    TooDeep,
    Unreadable,
}

/// The keys of the top-level `<dict>` of an XML property list, with string and boolean values; nested containers are skipped.
pub(crate) fn plist(text: &str) -> Result<Plist, PlistErr> {
    if text.starts_with("bplist") {
        return Err(PlistErr::Binary);
    }
    let toks = tokens(text).ok_or(PlistErr::Unreadable)?;
    let mut out = Plist::default();
    let mut depth = 0usize; // element depth, <plist> = 1, its <dict> = 2
    let mut key: Option<(String, u32)> = None;
    let mut i = 0;
    while i < toks.len() {
        match &toks[i] {
            Tok::Open { name, empty, line, .. } => {
                if !empty {
                    depth += 1;
                }
                if depth > MAX_DEPTH {
                    return Err(PlistErr::TooDeep);
                }
                let at_top = if *empty { depth == 2 } else { depth == 3 };
                match name.as_str() {
                    "key" if depth == 3 && !empty => {
                        if let Some(Tok::Text { text, .. }) = toks.get(i + 1) {
                            key = Some((text.clone(), *line));
                        }
                    }
                    "string" | "true" | "false" | "integer" | "real" | "date" | "data" if at_top => {
                        if let Some((k, l)) = key.take() {
                            let v = match (name.as_str(), empty) {
                                ("string", true) => PVal::Str(String::new()),
                                ("string", false) => match toks.get(i + 1) {
                                    Some(Tok::Text { text, .. }) => PVal::Str(text.clone()),
                                    _ => PVal::Str(String::new()),
                                },
                                ("true", _) => PVal::Bool(true),
                                ("false", _) => PVal::Bool(false),
                                _ => PVal::Other,
                            };
                            out.entries.push((k, v, l));
                        }
                    }
                    "array" | "dict" if at_top || (*empty && depth == 2) => {
                        if let Some((k, l)) = key.take() {
                            out.entries.push((k, PVal::Other, l));
                        }
                    }
                    _ => {}
                }
            }
            Tok::Close { .. } => depth = depth.saturating_sub(1),
            Tok::Text { .. } => {}
        }
        i += 1;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_top_level_keys_and_skips_nested_ones() {
        let t = "<?xml version=\"1.0\"?>\n<!DOCTYPE plist PUBLIC \"x\" \"y\">\n<plist version=\"1.0\">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>App &amp; Co</string>\n\t<key>Nested</key>\n\t<dict><key>Inner</key><string>x</string></dict>\n\t<key>NSCameraUsageDescription</key>\n\t<string></string>\n\t<key>UIFile</key><true/>\n</dict>\n</plist>";
        let p = plist(t).unwrap();
        assert_eq!(p.get("CFBundleName").unwrap().1, PVal::Str("App & Co".into()));
        assert!(p.get("Inner").is_none());
        assert_eq!(p.get("NSCameraUsageDescription").unwrap().1, PVal::Str(String::new()));
        assert_eq!(p.get("NSCameraUsageDescription").unwrap().2, 9);
        assert_eq!(p.get("UIFile").unwrap().1, PVal::Bool(true));
    }

    #[test]
    fn deep_nesting_binary_and_garbage_do_not_crash() {
        let deep = format!("<plist><dict><key>a</key>{}{}</dict></plist>", "<array>".repeat(5000), "</array>".repeat(5000));
        assert_eq!(plist(&deep).unwrap_err(), PlistErr::TooDeep);
        assert_eq!(plist("bplist00\u{1}\u{2}").unwrap_err(), PlistErr::Binary);
        assert!(plist("<<<<<<<<<<<< &&&& <key").is_ok() || plist("<<<<<<<<<<<< &&&& <key").is_err());
        let _ = tokens(&"<a b=\"".repeat(1000));
        assert!(tokens(&"<a/>".repeat(500_000)).is_none());
    }

    #[test]
    fn the_work_is_linear_in_the_size_of_the_text() {
        // each of these cost time quadratic in the length before: the step count and the clock both stay small now
        let t = std::time::Instant::now();
        for text in ["&amp;".repeat(800_000), format!("<a>{}</a>", "&amp;".repeat(800_000)), "<!>".repeat(1_300_000), "<?>".repeat(1_300_000), "<!-->".repeat(700_000), format!("<a {}/>", "b=\"1\" ".repeat(500_000))] {
            let (tokens, steps) = scan(&text);
            assert!(steps <= MAX_TOKENS + 1 && steps <= text.len(), "{steps} steps for {} bytes", text.len());
            assert!(tokens.is_some() || steps > MAX_TOKENS);
        }
        assert!(t.elapsed() < std::time::Duration::from_secs(30), "{:?}", t.elapsed());
        // an attribute list is cut off, not stored whole
        let (toks, _) = scan(&format!("<a {}/>", "b=\"1\" ".repeat(10_000)));
        assert!(matches!(&toks.unwrap()[0], Tok::Open { attrs, .. } if attrs.len() == 128));
    }
}
