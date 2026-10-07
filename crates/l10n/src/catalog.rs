//! A tiny structural JSON scanner for locale catalogs. It never rebuilds a file: it finds byte ranges, so an edit can
//! splice one line in and leave key order, indentation and every other byte alone (the catalogs can be 18 MB and are
//! hand-formatted, one key per line).

use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct Leaf {
    pub path: Vec<String>,
    pub value: String,
    /// Byte range of the string literal, quotes included.
    pub span: (usize, usize),
}

#[derive(Debug, Clone)]
pub struct Obj {
    pub path: Vec<String>,
    /// Byte offset of the closing brace.
    pub close: usize,
    /// Byte offset just after the last entry's value (None for `{}`).
    pub last_end: Option<usize>,
    /// Byte offset of the first entry's key quote (None for `{}`).
    pub first_key: Option<usize>,
    /// Byte offset of the last entry's key quote.
    pub last_key: Option<usize>,
}

#[derive(Debug, Default)]
pub struct Scan {
    pub leaves: Vec<Leaf>,
    pub objects: Vec<Obj>,
}

impl Scan {
    pub fn flat(&self) -> BTreeMap<String, String> {
        self.leaves.iter().map(|l| (l.path.join("."), l.value.clone())).collect()
    }
    pub fn leaf(&self, path: &[String]) -> Option<&Leaf> {
        self.leaves.iter().find(|l| l.path == path)
    }
    pub fn obj(&self, path: &[String]) -> Option<&Obj> {
        self.objects.iter().find(|o| o.path == path)
    }
}

/// Keys of the object that starts at the beginning of `text` (trailing data ignored), in file order.
pub fn leading_keys(text: &str) -> Vec<String> {
    let mut p = P { s: text.as_bytes(), text, i: 0, out: Scan::default() };
    p.ws();
    let _ = p.value(&mut Vec::new(), 0);
    p.out.leaves.iter().filter(|l| l.path.len() == 1).map(|l| l.path[0].clone()).collect()
}

struct P<'a> {
    s: &'a [u8],
    text: &'a str,
    i: usize,
    out: Scan,
}

pub fn scan(text: &str) -> Result<Scan, String> {
    let mut p = P { s: text.as_bytes(), text, i: 0, out: Scan::default() };
    p.ws();
    p.value(&mut Vec::new(), 0)?;
    p.ws();
    if p.i != p.s.len() {
        return Err(format!("trailing data at byte {}", p.i));
    }
    Ok(p.out)
}

impl P<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn string(&mut self) -> Result<(String, (usize, usize)), String> {
        let start = self.i;
        if self.s.get(self.i) != Some(&b'"') {
            return Err(format!("expected a string at byte {}", self.i));
        }
        self.i += 1;
        let mut esc = false;
        loop {
            match self.s.get(self.i) {
                None => return Err("unterminated string".into()),
                Some(b'\\') if !esc => esc = true,
                Some(b'"') if !esc => break,
                _ => esc = false,
            }
            self.i += 1;
        }
        self.i += 1;
        Ok((unescape(&self.text[start + 1..self.i - 1]), (start, self.i)))
    }

    fn value(&mut self, path: &mut Vec<String>, depth: usize) -> Result<(), String> {
        if depth > 48 {
            return Err("nested too deep".into());
        }
        match self.s.get(self.i) {
            Some(b'{') => {
                self.i += 1;
                let mut first = None;
                let mut last_key = None;
                let mut last_end = None;
                loop {
                    self.ws();
                    match self.s.get(self.i) {
                        Some(b'}') => break,
                        Some(b'"') => {
                            let ks = self.i;
                            first.get_or_insert(ks);
                            last_key = Some(ks);
                            let (key, _) = self.string()?;
                            self.ws();
                            if self.s.get(self.i) != Some(&b':') {
                                return Err(format!("expected ':' at byte {}", self.i));
                            }
                            self.i += 1;
                            self.ws();
                            path.push(key);
                            self.value(path, depth + 1)?;
                            path.pop();
                            last_end = Some(self.i);
                            self.ws();
                            match self.s.get(self.i) {
                                Some(b',') => self.i += 1,
                                Some(b'}') => {}
                                _ => return Err(format!("expected ',' or '}}' at byte {}", self.i)),
                            }
                        }
                        _ => return Err(format!("unexpected byte {} in object", self.i)),
                    }
                }
                self.out.objects.push(Obj { path: path.clone(), close: self.i, last_end, first_key: first, last_key });
                self.i += 1;
                Ok(())
            }
            Some(b'[') => {
                self.i += 1;
                loop {
                    self.ws();
                    match self.s.get(self.i) {
                        Some(b']') => break,
                        Some(b',') => self.i += 1,
                        None => return Err("unterminated array".into()),
                        _ => self.skip_value(depth + 1)?,
                    }
                }
                self.i += 1;
                Ok(())
            }
            Some(b'"') => {
                let (value, span) = self.string()?;
                self.out.leaves.push(Leaf { path: path.clone(), value, span });
                Ok(())
            }
            Some(_) => {
                let start = self.i;
                while self.i < self.s.len() && !matches!(self.s[self.i], b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r') {
                    self.i += 1;
                }
                if start == self.i {
                    return Err(format!("unexpected byte {}", self.i));
                }
                Ok(())
            }
            None => Err("unexpected end".into()),
        }
    }

    /// Arrays hold no catalog strings we care about: parse nested values without recording leaves.
    fn skip_value(&mut self, depth: usize) -> Result<(), String> {
        let keep = std::mem::take(&mut self.out);
        let r = self.value(&mut Vec::new(), depth);
        self.out = keep;
        r
    }
}

pub fn unescape(raw: &str) -> String {
    if !raw.contains('\\') {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    let mut it = raw.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('b') => out.push('\u{8}'),
            Some('f') => out.push('\u{c}'),
            Some('u') => {
                let hex: String = it.by_ref().take(4).collect();
                let mut cp = u32::from_str_radix(&hex, 16).unwrap_or(0xfffd);
                if (0xd800..0xdc00).contains(&cp) {
                    let mut look = it.clone();
                    if look.next() == Some('\\') && look.next() == Some('u') {
                        let lo_hex: String = look.by_ref().take(4).collect();
                        if let Ok(lo) = u32::from_str_radix(&lo_hex, 16) {
                            if (0xdc00..0xe000).contains(&lo) {
                                cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                                it = look;
                            }
                        }
                    }
                }
                out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
            }
            Some(o) => out.push(o),
            None => {}
        }
    }
    out
}

pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Sets `path` to `value`: replaces an existing string in place, or appends a new entry as the last key of its parent
/// object (creating missing parent objects). One spliced region; everything else is byte-identical.
pub fn set_key(text: &str, path: &[String], value: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("empty key".into());
    }
    let sc = scan(text)?;
    if let Some(leaf) = sc.leaf(path) {
        let mut out = String::with_capacity(text.len() + value.len());
        out.push_str(&text[..leaf.span.0]);
        out.push_str(&escape(value));
        out.push_str(&text[leaf.span.1..]);
        return Ok(out);
    }
    // Deepest existing ancestor object.
    let mut depth = path.len() - 1;
    let parent = loop {
        if let Some(o) = sc.obj(&path[..depth]) {
            break o;
        }
        if depth == 0 {
            return Err("the catalog root is not an object".into());
        }
        depth -= 1;
    };
    // A string where an object is needed would be overwritten: refuse.
    if sc.leaf(&path[..depth + 1]).is_some() {
        return Err(format!("'{}' is a string, not an object", path[..depth + 1].join(".")));
    }
    let rest = &path[depth..];
    let entry = nested_entry(rest, value);
    let line_start = |at: usize| text[..at].rfind('\n').map_or(0, |n| n + 1);
    let indent_of = |at: usize| {
        let ls = line_start(at);
        text[ls..].chars().take_while(|c| *c == ' ' || *c == '\t').collect::<String>()
    };
    let multiline = text[parent.first_key.unwrap_or(parent.close)..parent.close].contains('\n') || parent.first_key.is_none() && text[..parent.close].ends_with('\n');
    match parent.last_end {
        Some(end) => {
            let (ins, pretty) = if multiline {
                let ind = indent_of(parent.last_key.unwrap());
                (format!(",\n{ind}{}", indent_entry(&entry, &ind)), true)
            } else {
                (format!(", {entry}"), false)
            };
            let _ = pretty;
            Ok(format!("{}{}{}", &text[..end], ins, &text[end..]))
        }
        None => {
            // `{}`: expand to one entry on its own line, indented one level below the line that holds the brace.
            let base = indent_of(parent.close);
            let unit = if base.contains('\t') { "\t" } else { "  " };
            let ind = format!("{base}{unit}");
            let open = text[..parent.close].rfind('{').ok_or("no opening brace")?;
            Ok(format!("{}{{\n{ind}{}\n{base}{}", &text[..open], indent_entry(&entry, &ind), &text[parent.close..]))
        }
    }
}

fn nested_entry(rest: &[String], value: &str) -> String {
    if rest.len() == 1 {
        format!("{}: {}", escape(&rest[0]), escape(value))
    } else {
        format!("{}: {{\n  {}\n}}", escape(&rest[0]), nested_entry(&rest[1..], value).replace('\n', "\n  "))
    }
}

fn indent_entry(entry: &str, ind: &str) -> String {
    entry.replace('\n', &format!("\n{ind}"))
}
