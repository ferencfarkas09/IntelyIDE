//! A small YAML reader for the subset the swagger fragments use: block mappings and sequences, plain and quoted scalars,
//! flow `{}` / `[]`, block scalars (`|`, `>`), comments. No anchors, tags or multiple documents. Every node also gets
//! its 1-based source line through [`parse_with_lines`] (top-level keys only) so "open swagger path" can jump to it.

use serde_json::{Map, Number, Value};

struct Line {
    indent: usize,
    text: String,
    raw: String,
    no: usize,
}

pub struct Parsed {
    pub value: Value,
    /// Line of every top-level key, and of every key directly under a top-level `paths` mapping (key `paths/<path>`).
    pub lines: Vec<(String, usize)>,
}

pub fn parse(src: &str) -> Result<Value, String> {
    parse_with_lines(src).map(|p| p.value)
}

pub fn parse_with_lines(src: &str) -> Result<Parsed, String> {
    let mut lines: Vec<Line> = Vec::new();
    for (i, raw) in src.lines().enumerate() {
        let raw = raw.trim_end_matches('\r');
        let stripped = strip_comment(raw);
        if stripped.trim().is_empty() || stripped.trim() == "---" {
            lines.push(Line { indent: usize::MAX, text: String::new(), raw: raw.to_string(), no: i + 1 });
            continue;
        }
        let indent = stripped.len() - stripped.trim_start().len();
        lines.push(Line { indent, text: stripped.trim().to_string(), raw: raw.to_string(), no: i + 1 });
    }
    let mut p = P { lines, pos: 0, tops: Vec::new(), depth: 0 };
    p.skip_blank();
    if p.pos >= p.lines.len() {
        return Ok(Parsed { value: Value::Null, lines: vec![] });
    }
    let base = p.lines[p.pos].indent;
    let value = p.node(base)?;
    Ok(Parsed { value, lines: p.tops })
}

fn strip_comment(s: &str) -> String {
    let b: Vec<char> = s.chars().collect();
    let (mut q, mut out) = (None::<char>, String::new());
    for i in 0..b.len() {
        let c = b[i];
        match q {
            Some(open) => {
                if c == open {
                    q = None;
                }
            }
            None => {
                if (c == '"' || c == '\'') && (i == 0 || matches!(b[i - 1], ' ' | '[' | '{' | ',' | ':' | '-')) {
                    q = Some(c);
                } else if c == '#' && (i == 0 || b[i - 1] == ' ' || b[i - 1] == '\t') {
                    break;
                }
            }
        }
        out.push(c);
    }
    out
}

struct P {
    lines: Vec<Line>,
    pos: usize,
    tops: Vec<(String, usize)>,
    depth: usize,
}

impl P {
    fn skip_blank(&mut self) {
        while self.pos < self.lines.len() && self.lines[self.pos].indent == usize::MAX {
            self.pos += 1;
        }
    }

    fn node(&mut self, indent: usize) -> Result<Value, String> {
        self.skip_blank();
        let Some(l) = self.lines.get(self.pos) else { return Ok(Value::Null) };
        self.depth += 1;
        if self.depth > 200 {
            return Err("nesting too deep".into());
        }
        let r = if l.text == "-" || l.text.starts_with("- ") { self.seq(indent) } else if split_key(&l.text).is_some() { self.map(indent) } else { self.scalar_line() };
        self.depth -= 1;
        r
    }

    fn scalar_line(&mut self) -> Result<Value, String> {
        let text = self.lines[self.pos].text.clone();
        self.pos += 1;
        self.inline(&text)
    }

    fn seq(&mut self, indent: usize) -> Result<Value, String> {
        let mut out = Vec::new();
        loop {
            self.skip_blank();
            let Some(l) = self.lines.get(self.pos) else { break };
            if l.indent != indent || !(l.text == "-" || l.text.starts_with("- ")) {
                break;
            }
            let rest = l.text.strip_prefix('-').unwrap().trim_start().to_string();
            if rest.is_empty() {
                self.pos += 1;
                self.skip_blank();
                match self.lines.get(self.pos) {
                    Some(n) if n.indent > indent => {
                        let ni = n.indent;
                        out.push(self.node(ni)?)
                    }
                    _ => out.push(Value::Null),
                }
            } else if split_key(&rest).is_some() {
                let off = l.text.len() - rest.len();
                let l = &mut self.lines[self.pos];
                l.indent = indent + off;
                l.text = rest;
                let ni = l.indent;
                out.push(self.map(ni)?);
            } else if rest.starts_with("- ") {
                let off = l.text.len() - rest.len();
                let l = &mut self.lines[self.pos];
                l.indent = indent + off;
                l.text = rest;
                let ni = l.indent;
                out.push(self.seq(ni)?);
            } else {
                self.pos += 1;
                let v = self.continued(rest, indent)?;
                out.push(v);
            }
        }
        Ok(Value::Array(out))
    }

    fn map(&mut self, indent: usize) -> Result<Value, String> {
        let mut out = Map::new();
        let top = self.depth == 1;
        let mut under_paths = false;
        loop {
            self.skip_blank();
            let Some(l) = self.lines.get(self.pos) else { break };
            if l.indent != indent {
                break;
            }
            let Some((key, rest)) = split_key(&l.text) else { break };
            let no = l.no;
            if top {
                self.tops.push((key.clone(), no));
            }
            self.pos += 1;
            let value = if rest.is_empty() {
                self.skip_blank();
                match self.lines.get(self.pos) {
                    Some(n) if n.indent > indent => {
                        let ni = n.indent;
                        if top && key == "paths" {
                            under_paths = true;
                        }
                        self.node_tracking(ni, under_paths && top && key == "paths")?
                    }
                    Some(n) if n.indent == indent && (n.text == "-" || n.text.starts_with("- ")) => self.seq(indent)?,
                    _ => Value::Null,
                }
            } else if rest.starts_with('|') || rest.starts_with('>') {
                self.block(&rest, indent)
            } else {
                self.continued(rest, indent)?
            };
            out.insert(key, value);
        }
        Ok(Value::Object(out))
    }

    /// Child mapping of a top-level `paths:`: records "paths/<key>" lines as it goes.
    fn node_tracking(&mut self, indent: usize, is_paths: bool) -> Result<Value, String> {
        if is_paths {
            if let Some(l) = self.lines.get(self.pos) {
                if split_key(&l.text).is_some() && !(l.text == "-" || l.text.starts_with("- ")) {
                    return self.paths_map(indent);
                }
            }
        }
        self.node(indent)
    }

    fn paths_map(&mut self, indent: usize) -> Result<Value, String> {
        let mut out = Map::new();
        loop {
            self.skip_blank();
            let Some(l) = self.lines.get(self.pos) else { break };
            if l.indent != indent {
                break;
            }
            let Some((key, rest)) = split_key(&l.text) else { break };
            self.tops.push((format!("paths/{key}"), l.no));
            self.pos += 1;
            let v = if rest.is_empty() {
                self.skip_blank();
                match self.lines.get(self.pos) {
                    Some(n) if n.indent > indent => {
                        let ni = n.indent;
                        self.node(ni)?
                    }
                    _ => Value::Null,
                }
            } else {
                self.continued(rest, indent)?
            };
            out.insert(key, v);
        }
        Ok(Value::Object(out))
    }

    fn block(&mut self, header: &str, parent: usize) -> Value {
        let fold = header.starts_with('>');
        let keep = header.contains('+');
        let mut body: Vec<String> = Vec::new();
        let mut ind: Option<usize> = None;
        while let Some(l) = self.lines.get(self.pos) {
            let raw_indent = l.raw.len() - l.raw.trim_start().len();
            if l.raw.trim().is_empty() {
                body.push(String::new());
                self.pos += 1;
                continue;
            }
            if raw_indent <= parent {
                break;
            }
            let i = *ind.get_or_insert(raw_indent);
            body.push(l.raw.get(i.min(l.raw.len())..).unwrap_or("").to_string());
            self.pos += 1;
        }
        while body.last().is_some_and(|s| s.is_empty()) {
            body.pop();
        }
        let text = if fold { body.join(" ").replace("  ", " ") } else { body.join("\n") };
        Value::String(if keep { format!("{text}\n") } else { text })
    }

    /// An inline value that may continue on deeper lines (plain multi-line scalar, unterminated quote or flow collection).
    fn continued(&mut self, first: String, indent: usize) -> Result<Value, String> {
        let mut text = first;
        let open_quote = |s: &str| {
            let t = s.trim_start();
            let q = t.chars().next();
            matches!(q, Some('"') | Some('\'')) && !closed_quote(t)
        };
        let flow_depth = |s: &str| -> i32 {
            let mut d = 0;
            let mut q = None::<char>;
            for c in s.chars() {
                match q {
                    Some(o) => {
                        if c == o {
                            q = None;
                        }
                    }
                    None => match c {
                        '"' | '\'' => q = Some(c),
                        '{' | '[' => d += 1,
                        '}' | ']' => d -= 1,
                        _ => {}
                    },
                }
            }
            d
        };
        let is_flow = text.starts_with('{') || text.starts_with('[');
        loop {
            let need = if is_flow { flow_depth(&text) > 0 } else if open_quote(&text) { true } else { false };
            if need {
                self.skip_blank();
                let Some(n) = self.lines.get(self.pos) else { break };
                text.push(' ');
                text.push_str(&n.text);
                self.pos += 1;
                continue;
            }
            // plain scalar continuation: deeper lines that are not mappings/sequences
            if !is_flow && !text.starts_with('"') && !text.starts_with('\'') {
                if let Some(n) = self.lines.get(self.pos) {
                    if n.indent != usize::MAX && n.indent > indent && split_key(&n.text).is_none() && !n.text.starts_with("- ") {
                        text.push(' ');
                        text.push_str(&n.text);
                        self.pos += 1;
                        continue;
                    }
                }
            }
            break;
        }
        self.inline(&text)
    }

    fn inline(&self, s: &str) -> Result<Value, String> {
        let chars: Vec<char> = s.trim().chars().collect();
        let mut i = 0;
        let v = flow_value(&chars, &mut i, false)?;
        Ok(v)
    }
}

fn closed_quote(t: &str) -> bool {
    let c: Vec<char> = t.chars().collect();
    let q = c[0];
    let mut i = 1;
    while i < c.len() {
        if q == '"' && c[i] == '\\' {
            i += 2;
            continue;
        }
        if c[i] == q {
            if q == '\'' && c.get(i + 1) == Some(&'\'') {
                i += 2;
                continue;
            }
            return true;
        }
        i += 1;
    }
    false
}

/// `key: rest` (rest trimmed, may be empty). Quoted keys are unquoted. None when the line is not a mapping entry.
fn split_key(text: &str) -> Option<(String, String)> {
    if text.starts_with('"') || text.starts_with('\'') {
        let c: Vec<char> = text.chars().collect();
        let q = c[0];
        let mut i = 1;
        while i < c.len() && c[i] != q {
            if q == '"' && c[i] == '\\' {
                i += 1;
            }
            i += 1;
        }
        let key: String = c[1..i.min(c.len())].iter().collect();
        let after: String = c.get(i + 1..)?.iter().collect();
        let after = after.trim_start();
        if after == ":" {
            return Some((key, String::new()));
        }
        return after.strip_prefix(": ").map(|r| (key, r.trim().to_string()));
    }
    if text.starts_with('{') || text.starts_with('[') {
        return None;
    }
    if let Some(r) = text.strip_suffix(':') {
        if !r.contains(": ") {
            return Some((r.trim().to_string(), String::new()));
        }
    }
    let at = text.find(": ")?;
    Some((text[..at].trim().to_string(), text[at + 2..].trim().to_string()))
}

fn plain(s: &str) -> Value {
    let t = s.trim();
    match t {
        "" | "~" | "null" | "Null" | "NULL" => Value::Null,
        "true" | "True" | "TRUE" => Value::Bool(true),
        "false" | "False" | "FALSE" => Value::Bool(false),
        _ => {
            if let Ok(n) = t.parse::<i64>() {
                if !(t.len() > 1 && t.starts_with('0')) {
                    return Value::Number(n.into());
                }
            }
            if t.contains('.') || t.contains('e') {
                if let (Ok(f), true) = (t.parse::<f64>(), t.chars().next().is_some_and(|c| c.is_ascii_digit() || c == '-')) {
                    if let Some(n) = Number::from_f64(f) {
                        return Value::Number(n);
                    }
                }
            }
            Value::String(t.to_string())
        }
    }
}

fn flow_value(c: &[char], i: &mut usize, in_flow: bool) -> Result<Value, String> {
    while *i < c.len() && c[*i] == ' ' {
        *i += 1;
    }
    match c.get(*i) {
        Some('{') => {
            *i += 1;
            let mut m = Map::new();
            loop {
                while *i < c.len() && (c[*i] == ' ' || c[*i] == ',') {
                    *i += 1;
                }
                match c.get(*i) {
                    None => return Err("unterminated {".into()),
                    Some('}') => {
                        *i += 1;
                        break;
                    }
                    _ => {}
                }
                let k = flow_scalar(c, i, true)?;
                while *i < c.len() && c[*i] == ' ' {
                    *i += 1;
                }
                let v = if c.get(*i) == Some(&':') {
                    *i += 1;
                    flow_value(c, i, true)?
                } else {
                    Value::Null
                };
                m.insert(match k { Value::String(s) => s, o => o.to_string() }, v);
            }
            Ok(Value::Object(m))
        }
        Some('[') => {
            *i += 1;
            let mut a = Vec::new();
            loop {
                while *i < c.len() && (c[*i] == ' ' || c[*i] == ',') {
                    *i += 1;
                }
                match c.get(*i) {
                    None => return Err("unterminated [".into()),
                    Some(']') => {
                        *i += 1;
                        break;
                    }
                    _ => {}
                }
                let before = *i;
                let v = flow_value(c, i, true)?;
                while *i < c.len() && c[*i] == ' ' {
                    *i += 1;
                }
                if c.get(*i) == Some(&':') {
                    // a single-pair map inside a flow sequence: `[Bearer: []]`
                    *i += 1;
                    let val = flow_value(c, i, true)?;
                    let mut m = Map::new();
                    m.insert(match v { Value::String(s) => s, o => o.to_string() }, val);
                    a.push(Value::Object(m));
                } else {
                    a.push(v);
                }
                if *i == before {
                    *i += 1;
                }
            }
            Ok(Value::Array(a))
        }
        _ => flow_scalar(c, i, in_flow),
    }
}

fn flow_scalar(c: &[char], i: &mut usize, in_flow: bool) -> Result<Value, String> {
    while *i < c.len() && c[*i] == ' ' {
        *i += 1;
    }
    match c.get(*i) {
        Some(&q) if q == '"' || q == '\'' => {
            *i += 1;
            let mut s = String::new();
            while *i < c.len() {
                let ch = c[*i];
                if q == '"' && ch == '\\' {
                    *i += 1;
                    match c.get(*i) {
                        Some('n') => s.push('\n'),
                        Some('t') => s.push('\t'),
                        Some(&o) => s.push(o),
                        None => {}
                    }
                } else if ch == q {
                    if q == '\'' && c.get(*i + 1) == Some(&'\'') {
                        s.push('\'');
                        *i += 1;
                    } else {
                        *i += 1;
                        return Ok(Value::String(s));
                    }
                } else {
                    s.push(ch);
                }
                *i += 1;
            }
            Err("unterminated quote".into())
        }
        _ => {
            let start = *i;
            while *i < c.len() {
                let ch = c[*i];
                if in_flow && (ch == ',' || ch == '}' || ch == ']') {
                    break;
                }
                if in_flow && ch == ':' && (c.get(*i + 1).is_none_or(|n| *n == ' ')) {
                    break;
                }
                *i += 1;
            }
            let s: String = c[start..*i].iter().collect();
            Ok(plain(&s))
        }
    }
}
