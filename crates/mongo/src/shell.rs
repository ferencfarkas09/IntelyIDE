//! mongosh-style literal parser. Pure Rust, no driver: text in, **canonical Extended JSON** (`serde_json::Value`) out.
//!
//! Accepts strict (E)JSON and a deliberate mongosh subset: unquoted keys, single quotes, trailing commas, comments,
//! regex literals, `ObjectId()`, `ISODate()` / `new Date()`, `NumberLong/Int/Decimal`, `Double`, `UUID`, `Timestamp`,
//! `BinData`, `HexData`, `MinKey/MaxKey`, `DBRef`, `RegExp`. **No** identifiers, arithmetic, member access or other
//! calls: this is a data parser, never an evaluator (no `$where`/function bodies are executed or even representable).
//!
//! Number typing follows the shell: an integer literal that fits `i32` is Int32, everything else is Double. Use
//! `NumberLong(...)` for Int64. Dates without an offset are UTC. `ISODate()` / `new Date()` without arguments need
//! `ParseOptions::now_ms` (the caller decides what "now" is); `ObjectId()` without argument is refused because it would
//! be a random value inside a query.

use serde_json::{json, Map, Value};

pub const MAX_INPUT_BYTES: usize = 64 * 1024;
pub const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, Default)]
pub struct ParseOptions {
    /// Value used for `ISODate()` / `new Date()` without arguments. `None` makes them an error.
    pub now_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
    /// 1-based line and column of the error (columns count characters).
    pub line: usize,
    pub col: usize,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (line {}, column {})", self.message, self.line, self.col)
    }
}
impl std::error::Error for ParseError {}

/// Any value (object, array, scalar).
pub fn parse(text: &str) -> Result<Value, ParseError> {
    parse_with(text, &ParseOptions::default())
}

pub fn parse_with(text: &str, opts: &ParseOptions) -> Result<Value, ParseError> {
    let mut p = P { text, s: text.as_bytes(), i: 0, depth: 0, opts };
    if text.len() > MAX_INPUT_BYTES {
        return Err(p.err_at(0, format!("input is larger than {} KB", MAX_INPUT_BYTES / 1024)));
    }
    p.ws()?;
    if p.i >= p.s.len() {
        return Err(p.err("empty input"));
    }
    let v = p.value()?;
    p.ws()?;
    if p.i < p.s.len() {
        return Err(p.err("unexpected text after the value"));
    }
    Ok(v)
}

/// A query body: must be an object; empty / whitespace / comment-only text means `{}` (an empty editor).
pub fn parse_document(text: &str, opts: &ParseOptions) -> Result<Value, ParseError> {
    let mut p = P { text, s: text.as_bytes(), i: 0, depth: 0, opts };
    if text.len() > MAX_INPUT_BYTES {
        return Err(p.err_at(0, format!("input is larger than {} KB", MAX_INPUT_BYTES / 1024)));
    }
    p.ws()?;
    if p.i >= p.s.len() {
        return Ok(json!({}));
    }
    let start = p.i;
    let v = p.value()?;
    p.ws()?;
    if p.i < p.s.len() {
        return Err(p.err("unexpected text after the value"));
    }
    if !v.is_object() || v.as_object().is_some_and(is_ejson_scalar) {
        return Err(p.err_at(start, "expected a document like { ... }".to_string()));
    }
    Ok(v)
}

/// Canonical EJSON wrappers are single-key objects starting with `$` (`{"$oid": ..}`); they are values, not documents.
fn is_ejson_scalar(m: &Map<String, Value>) -> bool {
    m.len() <= 2
        && m.keys().next().is_some_and(|k| {
            matches!(
                k.as_str(),
                "$oid" | "$date" | "$numberInt" | "$numberLong" | "$numberDouble" | "$numberDecimal" | "$regularExpression" | "$binary" | "$timestamp" | "$minKey" | "$maxKey" | "$undefined" | "$symbol" | "$code" | "$uuid"
            )
        })
}

// ---- canonical EJSON constructors -------------------------------------------------------------------------------

pub fn int32(n: i32) -> Value {
    json!({ "$numberInt": n.to_string() })
}
pub fn int64(n: i64) -> Value {
    json!({ "$numberLong": n.to_string() })
}
pub fn double(n: f64) -> Value {
    let s = if n.is_nan() {
        "NaN".to_string()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else if n == 0.0 && n.is_sign_negative() {
        "-0.0".into()
    } else if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{n:.1}")
    } else {
        // Rust's shortest round-trip repr; canonical EJSON only asks that it parses back to the same double.
        format!("{n}")
    };
    json!({ "$numberDouble": s })
}
pub fn date_ms(ms: i64) -> Value {
    json!({ "$date": { "$numberLong": ms.to_string() } })
}

// ---- parser -----------------------------------------------------------------------------------------------------

struct P<'a> {
    text: &'a str,
    s: &'a [u8],
    i: usize,
    depth: usize,
    opts: &'a ParseOptions,
}

type R<T> = Result<T, ParseError>;

impl<'a> P<'a> {
    fn err(&self, m: impl Into<String>) -> ParseError {
        self.err_at(self.i, m.into())
    }
    fn err_at(&self, at: usize, message: String) -> ParseError {
        let mut at_c = at.min(self.s.len());
        while at_c > 0 && !self.text.is_char_boundary(at_c) {
            at_c -= 1;
        }
        let before = &self.text[..at_c];
        let line = before.bytes().filter(|b| *b == b'\n').count() + 1;
        let col = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
        ParseError { message, line, col }
    }
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    /// Whitespace, `// line` and `/* block */` comments.
    fn ws(&mut self) -> R<()> {
        loop {
            match self.peek() {
                Some(b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c) => self.i += 1,
                Some(b'/') if self.s.get(self.i + 1) == Some(&b'/') => {
                    while self.peek().is_some_and(|b| b != b'\n') {
                        self.i += 1;
                    }
                }
                Some(b'/') if self.s.get(self.i + 1) == Some(&b'*') => {
                    let start = self.i;
                    self.i += 2;
                    loop {
                        match self.peek() {
                            None => return Err(self.err_at(start, "unterminated /* comment".into())),
                            Some(b'*') if self.s.get(self.i + 1) == Some(&b'/') => {
                                self.i += 2;
                                break;
                            }
                            _ => self.i += 1,
                        }
                    }
                }
                // BOM / NBSP: treat as whitespace.
                Some(0xEF) if self.s[self.i..].starts_with("\u{feff}".as_bytes()) => self.i += 3,
                Some(0xC2) if self.s[self.i..].starts_with("\u{a0}".as_bytes()) => self.i += 2,
                _ => return Ok(()),
            }
        }
    }

    fn enter(&mut self) -> R<()> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.err(format!("nesting deeper than {MAX_DEPTH}")));
        }
        Ok(())
    }

    fn value(&mut self) -> R<Value> {
        self.ws()?;
        let Some(c) = self.peek() else { return Err(self.err("unexpected end of input")) };
        match c {
            b'{' => self.object(),
            b'[' => self.array(),
            b'"' | b'\'' => Ok(Value::String(self.string(c)?)),
            b'/' => self.regex(),
            b'-' | b'+' | b'0'..=b'9' | b'.' => self.number(),
            c if is_ident_start(c) => self.ident_value(),
            _ => Err(self.err(format!("unexpected character '{}'", self.cur_char()))),
        }
    }

    fn cur_char(&self) -> char {
        self.text.get(self.i..).and_then(|t| t.chars().next()).unwrap_or('?')
    }

    fn object(&mut self) -> R<Value> {
        self.enter()?;
        self.i += 1;
        let mut m = Map::new();
        loop {
            self.ws()?;
            match self.peek() {
                None => return Err(self.err("unterminated object, expected '}'")),
                Some(b'}') => {
                    self.i += 1;
                    break;
                }
                _ => {}
            }
            let key_at = self.i;
            let key = self.key()?;
            self.ws()?;
            if self.peek() != Some(b':') {
                return Err(self.err("expected ':' after the key"));
            }
            self.i += 1;
            let v = self.value()?;
            if m.insert(key.clone(), v).is_some() {
                return Err(self.err_at(key_at, format!("duplicate key \"{key}\"")));
            }
            self.ws()?;
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {}
                None => return Err(self.err("unterminated object, expected '}'")),
                _ => return Err(self.err("expected ',' or '}'")),
            }
        }
        self.depth -= 1;
        Ok(Value::Object(m))
    }

    fn key(&mut self) -> R<String> {
        match self.peek() {
            Some(q @ (b'"' | b'\'')) => self.string(q),
            Some(c) if is_ident_start(c) => Ok(self.ident().to_string()),
            Some(b'0'..=b'9') => {
                let start = self.i;
                while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                    self.i += 1;
                }
                Ok(self.text[start..self.i].to_string())
            }
            _ => Err(self.err("expected a key (identifier or string)")),
        }
    }

    fn array(&mut self) -> R<Value> {
        self.enter()?;
        self.i += 1;
        let mut a = Vec::new();
        loop {
            self.ws()?;
            match self.peek() {
                None => return Err(self.err("unterminated array, expected ']'")),
                Some(b']') => {
                    self.i += 1;
                    break;
                }
                _ => {}
            }
            a.push(self.value()?);
            self.ws()?;
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b']') => {}
                None => return Err(self.err("unterminated array, expected ']'")),
                _ => return Err(self.err("expected ',' or ']'")),
            }
        }
        self.depth -= 1;
        Ok(Value::Array(a))
    }

    fn string(&mut self, quote: u8) -> R<String> {
        let start = self.i;
        self.i += 1;
        let mut out = String::new();
        let mut run = self.i;
        loop {
            let Some(b) = self.peek() else { return Err(self.err_at(start, "unterminated string".into())) };
            if b == quote {
                out.push_str(&self.text[run..self.i]);
                self.i += 1;
                return Ok(out);
            }
            if b == b'\n' {
                return Err(self.err_at(start, "unterminated string (newline in string)".into()));
            }
            if b != b'\\' {
                self.i += 1;
                continue;
            }
            out.push_str(&self.text[run..self.i]);
            self.i += 1;
            let Some(e) = self.peek() else { return Err(self.err_at(start, "unterminated string".into())) };
            self.i += 1;
            match e {
                b'n' => out.push('\n'),
                b't' => out.push('\t'),
                b'r' => out.push('\r'),
                b'b' => out.push('\u{8}'),
                b'f' => out.push('\u{c}'),
                b'v' => out.push('\u{b}'),
                b'0' => out.push('\0'),
                b'\\' | b'\'' | b'"' | b'/' => out.push(e as char),
                b'x' => {
                    let h = self.hex(2)?;
                    out.push(char::from_u32(h).ok_or_else(|| self.err("invalid \\x escape"))?);
                }
                b'u' => {
                    let mut cp = self.hex(4)?;
                    if (0xD800..0xDC00).contains(&cp) {
                        if self.s[self.i..].starts_with(b"\\u") {
                            self.i += 2;
                            let lo = self.hex(4)?;
                            if !(0xDC00..0xE000).contains(&lo) {
                                return Err(self.err("invalid surrogate pair"));
                            }
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                        } else {
                            return Err(self.err("lone surrogate in \\u escape"));
                        }
                    }
                    out.push(char::from_u32(cp).ok_or_else(|| self.err("invalid \\u escape"))?);
                }
                b'\n' => {} // line continuation
                _ => return Err(self.err_at(self.i - 2, "unknown escape sequence".into())),
            }
            run = self.i;
        }
    }

    fn hex(&mut self, n: usize) -> R<u32> {
        let end = self.i + n;
        let h = self.text.get(self.i..end).filter(|h| h.bytes().all(|b| b.is_ascii_hexdigit()));
        let Some(h) = h else { return Err(self.err("invalid hex escape")) };
        self.i = end;
        Ok(u32::from_str_radix(h, 16).unwrap_or(0))
    }

    fn number(&mut self) -> R<Value> {
        let start = self.i;
        let mut neg = false;
        match self.peek() {
            Some(b'-') => {
                neg = true;
                self.i += 1;
            }
            Some(b'+') => self.i += 1,
            _ => {}
        }
        if self.peek().is_some_and(is_ident_start) {
            let id = self.ident();
            return match id {
                "Infinity" => Ok(double(if neg { f64::NEG_INFINITY } else { f64::INFINITY })),
                "NaN" => Ok(double(f64::NAN)),
                _ => Err(self.err_at(start, format!("unexpected '{id}' after a sign"))),
            };
        }
        let digits_start = self.i;
        if self.s[self.i..].starts_with(b"0x") || self.s[self.i..].starts_with(b"0X") {
            self.i += 2;
            let h = self.i;
            while self.peek().is_some_and(|b| b.is_ascii_hexdigit()) {
                self.i += 1;
            }
            let v = i64::from_str_radix(&self.text[h..self.i], 16).map_err(|_| self.err_at(start, "invalid hex number".into()))?;
            let v = if neg { -v } else { v };
            return Ok(match i32::try_from(v) {
                Ok(n) => int32(n),
                Err(_) => double(v as f64),
            });
        }
        let mut is_int = true;
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.i += 1;
        }
        if self.peek() == Some(b'.') {
            is_int = false;
            self.i += 1;
            while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                self.i += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            is_int = false;
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            let e = self.i;
            while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                self.i += 1;
            }
            if e == self.i {
                return Err(self.err_at(start, "invalid exponent".into()));
            }
        }
        let body = &self.text[digits_start..self.i];
        if !body.bytes().any(|b| b.is_ascii_digit()) {
            return Err(self.err_at(start, "invalid number".into()));
        }
        if self.peek().is_some_and(is_ident_start) {
            return Err(self.err("invalid number (unexpected letters)"));
        }
        let signed = format!("{}{}", if neg { "-" } else { "" }, body);
        if is_int {
            if let Ok(n) = signed.parse::<i32>() {
                return Ok(int32(n));
            }
        }
        let f: f64 = signed.parse().map_err(|_| self.err_at(start, "invalid number".into()))?;
        if f.is_infinite() {
            return Err(self.err_at(start, "number out of range".into()));
        }
        Ok(double(f))
    }

    fn regex(&mut self) -> R<Value> {
        let start = self.i;
        self.i += 1;
        let mut in_class = false;
        let body_start = self.i;
        loop {
            match self.peek() {
                None | Some(b'\n') => return Err(self.err_at(start, "unterminated regex literal".into())),
                Some(b'\\') => self.i += 2,
                Some(b'[') => {
                    in_class = true;
                    self.i += 1;
                }
                Some(b']') => {
                    in_class = false;
                    self.i += 1;
                }
                Some(b'/') if !in_class => break,
                _ => self.i += 1,
            }
            if self.i > self.s.len() {
                return Err(self.err_at(start, "unterminated regex literal".into()));
            }
        }
        let pattern = self.text[body_start..self.i].to_string();
        self.i += 1;
        if pattern.is_empty() {
            return Err(self.err_at(start, "empty regex literal".into()));
        }
        let fstart = self.i;
        while self.peek().is_some_and(|b| b.is_ascii_alphabetic()) {
            self.i += 1;
        }
        let flags = &self.text[fstart..self.i];
        regex_value(pattern, flags).map_err(|m| self.err_at(fstart, m))
    }

    fn ident(&mut self) -> &'a str {
        let start = self.i;
        while self.peek().is_some_and(|b| is_ident_start(b) || b.is_ascii_digit()) {
            self.i += 1;
        }
        &self.text[start..self.i]
    }

    fn ident_value(&mut self) -> R<Value> {
        let start = self.i;
        let mut name = self.ident();
        let mut has_new = false;
        if name == "new" {
            has_new = true;
            self.ws()?;
            if !self.peek().is_some_and(is_ident_start) {
                return Err(self.err("expected a constructor after 'new'"));
            }
            name = self.ident();
        }
        self.ws()?;
        if self.peek() != Some(b'(') {
            if has_new {
                return Err(self.err_at(start, format!("'new {name}' needs ( ... )")));
            }
            return match name {
                "true" => Ok(Value::Bool(true)),
                "false" => Ok(Value::Bool(false)),
                "null" => Ok(Value::Null),
                "undefined" => Ok(json!({ "$undefined": true })),
                "Infinity" => Ok(double(f64::INFINITY)),
                "NaN" => Ok(double(f64::NAN)),
                _ => Err(self.err_at(start, format!("unknown identifier '{name}' (only literals and BSON constructors are allowed)"))),
            };
        }
        if !is_known_ctor(name) {
            return Err(self.err_at(start, format!("'{name}(...)' is not allowed here (only BSON constructors are)")));
        }
        if name == "Date" && !has_new {
            return Err(self.err_at(start, "Date() without 'new' returns a string in JavaScript; use new Date(...) or ISODate(...)".into()));
        }
        self.i += 1;
        self.enter()?;
        let args = self.args()?;
        self.depth -= 1;
        self.construct(name, args, start)
    }

    /// Arguments after '(' up to and including ')'. Trailing comma allowed.
    fn args(&mut self) -> R<Vec<(usize, Value)>> {
        let mut a = Vec::new();
        loop {
            self.ws()?;
            match self.peek() {
                None => return Err(self.err("unterminated call, expected ')'")),
                Some(b')') => {
                    self.i += 1;
                    return Ok(a);
                }
                _ => {}
            }
            let at = self.i;
            a.push((at, self.value()?));
            self.ws()?;
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b')') => {}
                None => return Err(self.err("unterminated call, expected ')'")),
                _ => return Err(self.err("expected ',' or ')'")),
            }
        }
    }

    fn construct(&self, name: &str, args: Vec<(usize, Value)>, at: usize) -> R<Value> {
        let e = |m: String| self.err_at(at, m);
        let arity = |lo: usize, hi: usize| -> R<()> {
            if args.len() < lo || args.len() > hi {
                Err(e(format!("{name}() takes {} argument(s), got {}", if lo == hi { lo.to_string() } else { format!("{lo}-{hi}") }, args.len())))
            } else {
                Ok(())
            }
        };
        match name {
            "ObjectId" | "ObjectID" => {
                if args.is_empty() {
                    return Err(e("ObjectId() without an argument would generate a random id; pass the 24-character hex string".into()));
                }
                arity(1, 1)?;
                let s = args[0].1.as_str().ok_or_else(|| e("ObjectId() expects a 24-character hex string".into()))?;
                if s.len() != 24 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(e(format!("invalid ObjectId \"{s}\" (needs 24 hex characters)")));
                }
                Ok(json!({ "$oid": s.to_ascii_lowercase() }))
            }
            "ISODate" | "Date" => {
                if args.is_empty() {
                    return match self.opts.now_ms {
                        Some(ms) => Ok(date_ms(ms)),
                        None => Err(e(format!("{name}() without arguments needs a 'now' value; pass an explicit date"))),
                    };
                }
                if args.len() >= 2 {
                    let mut n = [0i64; 7];
                    n[2] = 1;
                    if args.len() > 7 {
                        return Err(e("Date() takes at most 7 arguments".into()));
                    }
                    for (k, (_, v)) in args.iter().enumerate() {
                        n[k] = as_int(v).ok_or_else(|| e("Date(year, month, ...) expects integers".into()))?;
                    }
                    if (0..100).contains(&n[0]) {
                        n[0] += 1900; // JS: 0..99 means 1900..1999
                    }
                    let (y, mo) = (n[0] + n[1].div_euclid(12), n[1].rem_euclid(12));
                    let ms = days_from_civil(y, mo + 1, 1) * 86_400_000 + (n[2] - 1) * 86_400_000 + n[3] * 3_600_000 + n[4] * 60_000 + n[5] * 1000 + n[6];
                    return Ok(date_ms(ms));
                }
                match &args[0].1 {
                    Value::String(s) => parse_iso_date(s).map(date_ms).map_err(e),
                    v => match as_int(v) {
                        Some(ms) => Ok(date_ms(ms)),
                        None => Err(e(format!("{name}() expects an ISO string or milliseconds"))),
                    },
                }
            }
            "NumberLong" => {
                arity(1, 1)?;
                let n = match &args[0].1 {
                    Value::String(s) => s.trim().parse::<i64>().ok(),
                    v => as_int(v),
                }
                .ok_or_else(|| e("NumberLong() expects an integer that fits in 64 bits (quote it for values above 2^53)".into()))?;
                Ok(int64(n))
            }
            "NumberInt" => {
                arity(1, 1)?;
                let n = match &args[0].1 {
                    Value::String(s) => s.trim().parse::<i64>().ok(),
                    v => as_int(v),
                }
                .and_then(|n| i32::try_from(n).ok())
                .ok_or_else(|| e("NumberInt() expects an integer that fits in 32 bits".into()))?;
                Ok(int32(n))
            }
            "NumberDecimal" | "Decimal128" => {
                arity(1, 1)?;
                let s = match &args[0].1 {
                    Value::String(s) => s.trim().to_string(),
                    v => as_f64(v).map(|f| f.to_string()).ok_or_else(|| e(format!("{name}() expects a string like \"1.25\"")))?,
                };
                if !valid_decimal(&s) {
                    return Err(e(format!("invalid decimal \"{s}\"")));
                }
                Ok(json!({ "$numberDecimal": s }))
            }
            "Double" => {
                arity(1, 1)?;
                let f = match &args[0].1 {
                    Value::String(s) => s.trim().parse::<f64>().ok(),
                    v => as_f64(v),
                }
                .ok_or_else(|| e("Double() expects a number".into()))?;
                Ok(double(f))
            }
            "UUID" => {
                arity(1, 1)?;
                let s = args[0].1.as_str().ok_or_else(|| e("UUID() expects a string".into()))?;
                let hex: String = s.chars().filter(|c| *c != '-').collect();
                if hex.len() != 32 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(e(format!("invalid UUID \"{s}\"")));
                }
                Ok(binary(4, &hex_bytes(&hex)))
            }
            "BinData" => {
                arity(2, 2)?;
                let sub = as_int(&args[0].1).filter(|n| (0..=255).contains(n)).ok_or_else(|| e("BinData() subtype must be 0-255".into()))?;
                let b64 = args[1].1.as_str().ok_or_else(|| e("BinData() expects a base64 string".into()))?;
                if !b64.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')) {
                    return Err(e("BinData() base64 contains invalid characters".into()));
                }
                Ok(json!({ "$binary": { "base64": b64, "subType": format!("{sub:02x}") } }))
            }
            "HexData" => {
                arity(2, 2)?;
                let sub = as_int(&args[0].1).filter(|n| (0..=255).contains(n)).ok_or_else(|| e("HexData() subtype must be 0-255".into()))?;
                let hex = args[1].1.as_str().ok_or_else(|| e("HexData() expects a hex string".into()))?;
                if hex.len() % 2 != 0 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(e("HexData() expects an even number of hex digits".into()));
                }
                Ok(binary(sub as u8, &hex_bytes(hex)))
            }
            "Timestamp" => {
                let (t, i) = match args.as_slice() {
                    [(_, a), (_, b)] => (as_int(a), as_int(b)),
                    [(_, Value::Object(o))] => (o.get("t").and_then(as_int), o.get("i").and_then(as_int)),
                    _ => return Err(e("Timestamp() expects (seconds, increment) or { t, i }".into())),
                };
                match (t.and_then(|v| u32::try_from(v).ok()), i.and_then(|v| u32::try_from(v).ok())) {
                    (Some(t), Some(i)) => Ok(json!({ "$timestamp": { "t": t, "i": i } })),
                    _ => Err(e("Timestamp() parts must be unsigned 32-bit integers".into())),
                }
            }
            "MinKey" => {
                arity(0, 0)?;
                Ok(json!({ "$minKey": 1 }))
            }
            "MaxKey" => {
                arity(0, 0)?;
                Ok(json!({ "$maxKey": 1 }))
            }
            "RegExp" => {
                arity(1, 2)?;
                let pat = args[0].1.as_str().ok_or_else(|| e("RegExp() expects a pattern string".into()))?.to_string();
                let flags = match args.get(1) {
                    Some((_, v)) => v.as_str().ok_or_else(|| e("RegExp() flags must be a string".into()))?.to_string(),
                    None => String::new(),
                };
                regex_value(pat, &flags).map_err(e)
            }
            "DBRef" => {
                arity(2, 3)?;
                let coll = args[0].1.as_str().ok_or_else(|| e("DBRef() collection must be a string".into()))?;
                let mut m = Map::new();
                m.insert("$ref".into(), Value::String(coll.into()));
                m.insert("$id".into(), args[1].1.clone());
                if let Some((_, db)) = args.get(2) {
                    m.insert("$db".into(), db.clone());
                }
                Ok(Value::Object(m))
            }
            _ => Err(e(format!("'{name}' is not supported"))),
        }
    }
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b == b'$'
}

fn is_known_ctor(n: &str) -> bool {
    matches!(
        n,
        "ObjectId" | "ObjectID" | "ISODate" | "Date" | "NumberLong" | "NumberInt" | "NumberDecimal" | "Decimal128" | "Double" | "UUID" | "BinData" | "HexData" | "Timestamp" | "MinKey" | "MaxKey" | "RegExp" | "DBRef"
    )
}

/// Our own numbers are canonical wrappers; plain JSON numbers never appear in parser output.
fn as_int(v: &Value) -> Option<i64> {
    let o = v.as_object()?;
    if let Some(s) = o.get("$numberInt").and_then(Value::as_str) {
        return s.parse().ok();
    }
    if let Some(s) = o.get("$numberDouble").and_then(Value::as_str) {
        let f: f64 = s.parse().ok()?;
        return (f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15).then_some(f as i64);
    }
    None
}
fn as_f64(v: &Value) -> Option<f64> {
    let o = v.as_object()?;
    o.get("$numberInt").or_else(|| o.get("$numberDouble")).and_then(Value::as_str).and_then(|s| s.parse().ok())
}

fn regex_value(pattern: String, flags: &str) -> Result<Value, String> {
    let mut opts: Vec<char> = Vec::new();
    for c in flags.chars() {
        match c {
            'i' | 'm' | 's' | 'x' | 'u' | 'l' => {
                if !opts.contains(&c) {
                    opts.push(c)
                }
            }
            _ => return Err(format!("regex flag '{c}' is not supported by MongoDB (allowed: i m s x u l)")),
        }
    }
    opts.sort_unstable();
    Ok(json!({ "$regularExpression": { "pattern": pattern, "options": opts.into_iter().collect::<String>() } }))
}

fn valid_decimal(s: &str) -> bool {
    let t = s.trim_start_matches(['-', '+']);
    if matches!(t, "Infinity" | "Inf" | "NaN") {
        return true;
    }
    let (mant, exp) = match t.find(['e', 'E']) {
        Some(k) => (&t[..k], Some(&t[k + 1..])),
        None => (t, None),
    };
    let mant_ok = mant.bytes().all(|b| b.is_ascii_digit() || b == b'.') && mant.bytes().filter(|b| *b == b'.').count() <= 1 && mant.bytes().any(|b| b.is_ascii_digit());
    let exp_ok = exp.is_none_or(|x| {
        let x = x.trim_start_matches(['-', '+']);
        !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit())
    });
    mant_ok && exp_ok
}

fn hex_bytes(h: &str) -> Vec<u8> {
    (0..h.len() / 2).map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap_or(0)).collect()
}

fn binary(sub: u8, bytes: &[u8]) -> Value {
    json!({ "$binary": { "base64": base64(bytes), "subType": format!("{sub:02x}") } })
}

fn base64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in b.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Days since 1970-01-01 (proleptic Gregorian), Howard Hinnant's algorithm.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
    }
}

/// `YYYY-MM-DD[(T| )HH:MM[:SS[.fff]]][Z|(+|-)HH[:]MM]` to epoch milliseconds. No offset means UTC.
pub fn parse_iso_date(s: &str) -> Result<i64, String> {
    let bad = || format!("invalid date \"{s}\" (expected ISO 8601 like 2024-05-17T08:30:00Z)");
    let b = s.trim().as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let sl = b.get(from..from + len)?;
        sl.iter().all(u8::is_ascii_digit).then(|| sl.iter().fold(0i64, |a, d| a * 10 + i64::from(d - b'0')))
    };
    let y = num(0, 4).ok_or_else(bad)?;
    let mo = if b.get(4) == Some(&b'-') { num(5, 2) } else { None }.ok_or_else(bad)?;
    let d = if b.get(7) == Some(&b'-') { num(8, 2) } else { None }.ok_or_else(bad)?;
    if !(1..=12).contains(&mo) || d < 1 || d > days_in_month(y, mo) {
        return Err(bad());
    }
    let mut i = 10;
    let (mut h, mut mi, mut sec, mut ms) = (0, 0, 0, 0);
    let mut off = 0i64;
    if i < b.len() {
        if !matches!(b[i], b'T' | b't' | b' ') {
            return Err(bad());
        }
        i += 1;
        h = num(i, 2).ok_or_else(bad)?;
        if b.get(i + 2) != Some(&b':') {
            return Err(bad());
        }
        mi = num(i + 3, 2).ok_or_else(bad)?;
        i += 5;
        if b.get(i) == Some(&b':') {
            sec = num(i + 1, 2).ok_or_else(bad)?;
            i += 3;
            if matches!(b.get(i), Some(b'.' | b',')) {
                i += 1;
                let st = i;
                while b.get(i).is_some_and(u8::is_ascii_digit) {
                    i += 1;
                }
                if i == st || i - st > 9 {
                    return Err(bad());
                }
                let mut frac = std::str::from_utf8(&b[st..i.min(st + 3)]).unwrap_or("0").to_string();
                while frac.len() < 3 {
                    frac.push('0');
                }
                ms = frac.parse::<i64>().unwrap_or(0);
            }
        }
        if h > 23 || mi > 59 || sec > 59 {
            return Err(bad());
        }
        match b.get(i) {
            None => {}
            Some(b'Z' | b'z') => i += 1,
            Some(sg @ (b'+' | b'-')) => {
                let oh = num(i + 1, 2).ok_or_else(bad)?;
                let (om, adv) = if b.get(i + 3) == Some(&b':') {
                    (num(i + 4, 2).ok_or_else(bad)?, 6)
                } else if let Some(m) = num(i + 3, 2) {
                    (m, 5)
                } else {
                    (0, 3)
                };
                if oh > 23 || om > 59 {
                    return Err(bad());
                }
                off = (oh * 60 + om) * 60_000 * if *sg == b'-' { -1 } else { 1 };
                i += adv;
            }
            _ => return Err(bad()),
        }
        if i != b.len() {
            return Err(bad());
        }
    }
    Ok(days_from_civil(y, mo, d) * 86_400_000 + h * 3_600_000 + mi * 60_000 + sec * 1000 + ms - off)
}
