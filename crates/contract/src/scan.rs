//! Finds the API calls in a client repository. Patterns learned by sampling the Happy clients:
//! `window.swaggerClient.apis.<Tag>.<operationId>({...})` (admin, POS), `apiFetch('/path', { method })` and plain
//! `fetch(\`https://host/api/...\`)` (mobile), axios-style `.get('/api/...')`, and endpoint tables (`name: (id) => \`/path/${id}\``).

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Call {
    pub file: String,
    pub line: usize,
    pub col: usize,
    /// `swagger-client`, `http` or `reference` (an endpoint table entry: method unknown).
    pub kind: String,
    pub method: Option<String>,
    /// Normalised: query removed, interpolations as `{}`.
    pub path: Option<String>,
    pub tag: Option<String>,
    pub operation: Option<String>,
    /// Keys of an object-literal argument. None = not visible (variable, spread, conditional).
    pub keys: Option<Vec<String>>,
    pub query_keys: Option<Vec<String>>,
    pub reads: Vec<String>,
    pub method_guessed: bool,
    pub snippet: String,
}

const SKIP_DIRS: [&str; 16] = ["node_modules/", ".history/", "/dist/", "dist/", "build/", "web-build/", "public/assets/", "src-tauri/gen/", "android/", "ios/", ".cxx/", "/__tests__/", "/tests/", "/e2e/", "/smoke/", "/mocks/"];
const EXTS: [&str; 7] = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue"];
const IGNORED_FIELDS: [&str; 24] = ["obj", "body", "data", "ok", "status", "statusText", "headers", "length", "map", "filter", "forEach", "find", "some", "every", "reduce", "slice", "push", "then", "catch", "finally", "json", "text", "toString", "includes"];
const DENY_OBJECTS: [&str; 18] = ["history", "navigate", "router", "navigation", "localstorage", "sessionstorage", "map", "searchparams", "params", "headers", "cache", "storage", "formdata", "set", "reflect", "weakmap", "urlsearchparams", "asyncstorage"];
const MAX_FILE: u64 = 800_000;

pub fn is_source(rel: &str) -> bool {
    let l = rel.to_lowercase();
    let hay = format!("/{l}");
    EXTS.iter().any(|e| l.ends_with(e)) && !l.contains(".min.") && !l.contains(".test.") && !l.contains(".spec.") && !l.ends_with(".d.ts") && !SKIP_DIRS.iter().any(|d| hay.contains(&format!("/{}", d.trim_start_matches('/'))))
}

fn table_file(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_lowercase();
    ["endpoint", "routes", "urls", "paths", "constants", "apiconfig"].iter().any(|k| name.contains(k)) || name.starts_with("ep.") || name.starts_with("api")
}

pub fn scan_repo(root: &Path, files: &[String]) -> (Vec<Call>, usize) {
    let mut calls = Vec::new();
    let mut scanned = 0;
    for rel in files.iter().filter(|f| is_source(f)) {
        let Ok(meta) = std::fs::metadata(root.join(rel)) else { continue };
        if meta.len() > MAX_FILE {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(root.join(rel)) else { continue };
        scanned += 1;
        calls.extend(scan_text(rel, &text));
    }
    (calls, scanned)
}

struct Src<'a> {
    b: &'a [u8],
    starts: Vec<usize>,
}

impl Src<'_> {
    fn pos(&self, at: usize) -> (usize, usize) {
        let l = self.starts.partition_point(|s| *s <= at) - 1;
        (l + 1, at - self.starts[l] + 1)
    }
    fn line_text(&self, line: usize) -> String {
        let s = self.starts[line - 1];
        let e = self.starts.get(line).copied().unwrap_or(self.b.len());
        String::from_utf8_lossy(&self.b[s..e]).trim().chars().take(160).collect()
    }
    fn indent_of(&self, line: usize) -> usize {
        let s = self.starts[line - 1];
        self.b[s..].iter().take_while(|c| **c == b' ' || **c == b'\t').count()
    }
}

fn ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && (b[i] as char).is_ascii_whitespace() {
        i += 1;
    }
    i
}

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$'
}

/// Reads a quoted or template literal at `i`; interpolations become `{}`. Returns (content, end).
fn read_lit(b: &[u8], i: usize) -> Option<(String, usize)> {
    let q = *b.get(i)?;
    if !matches!(q, b'\'' | b'"' | b'`') {
        return None;
    }
    let mut out = Vec::new();
    let mut j = i + 1;
    while j < b.len() {
        let c = b[j];
        if c == b'\\' {
            if let Some(n) = b.get(j + 1) {
                out.push(*n);
            }
            j += 2;
            continue;
        }
        if c == q {
            return Some((String::from_utf8_lossy(&out).into_owned(), j + 1));
        }
        if q != b'`' && c == b'\n' {
            return None;
        }
        if q == b'`' && c == b'$' && b.get(j + 1) == Some(&b'{') {
            let mut d = 1;
            j += 2;
            while j < b.len() && d > 0 {
                match b[j] {
                    b'{' => d += 1,
                    b'}' => d -= 1,
                    b'`' => {
                        // nested template: skip it
                        j += 1;
                        while j < b.len() && b[j] != b'`' {
                            j += 1;
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            out.extend_from_slice(b"{}");
            continue;
        }
        out.push(c);
        j += 1;
    }
    None
}

/// A literal, possibly concatenated with `+`: `'/a/' + id + '/b'` -> `/a/{}/b`.
fn read_concat(b: &[u8], i: usize) -> Option<(String, usize)> {
    let (mut s, mut j) = read_lit(b, i)?;
    loop {
        let k = ws(b, j);
        if b.get(k) != Some(&b'+') {
            return Some((s, j));
        }
        let k = ws(b, k + 1);
        if let Some((more, e)) = read_lit(b, k) {
            s.push_str(&more);
            j = e;
        } else {
            let mut e = k;
            let mut d = 0i32;
            while e < b.len() {
                match b[e] {
                    b'(' | b'[' | b'{' => d += 1,
                    b')' | b']' | b'}' => {
                        if d == 0 {
                            break;
                        }
                        d -= 1;
                    }
                    b'+' | b',' | b';' | b'\n' if d == 0 => break,
                    _ => {}
                }
                e += 1;
            }
            if e == k {
                return Some((s, j));
            }
            s.push_str("{}");
            j = e;
        }
    }
}

/// (path, query keys, query dynamic) from a literal. None when it is not an API path.
pub fn normalize(lit: &str) -> Option<(String, Vec<String>, bool)> {
    let mut s = lit.trim().to_string();
    if let Some(r) = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://")) {
        s = r.find('/').map(|k| r[k..].to_string()).unwrap_or_default();
    } else if s.starts_with("{}/") {
        s = s[2..].to_string();
    } else if s.starts_with("{}{}/") {
        s = s[4..].to_string();
    }
    if !s.starts_with('/') || s.len() < 2 || s.starts_with("//") {
        return None;
    }
    let (path, q) = match s.split_once('?') {
        Some((p, q)) => (p.to_string(), Some(q.to_string())),
        None => (s, None),
    };
    let path = path.trim_end_matches('/').to_string();
    let first = path.split('/').nth(1).unwrap_or("");
    if first.is_empty() || first.contains("{}") || first.contains('.') || !path.chars().all(|c| c.is_ascii_alphanumeric() || "/{}_-.:~%".contains(c)) {
        return None;
    }
    let mut keys = Vec::new();
    let mut dynamic = false;
    if let Some(q) = q {
        for part in q.split('&').filter(|p| !p.is_empty()) {
            match part.split_once('=') {
                Some((k, _)) if !k.contains("{}") && !k.is_empty() => keys.push(k.trim_end_matches("[]").to_string()),
                None if part != "{}" && !part.contains("{}") => keys.push(part.to_string()),
                _ => dynamic = true,
            }
        }
    }
    Some((path, keys, dynamic))
}

fn callee_before(b: &[u8], open: usize) -> Option<(usize, String)> {
    let mut i = open;
    // chain of identifiers, dots, `?.` and bracket groups
    loop {
        if i == 0 {
            break;
        }
        let c = b[i - 1];
        if is_ident(c) || c == b'.' || c == b'?' {
            i -= 1;
        } else if c == b']' {
            let mut d = 0;
            let mut j = i;
            while j > 0 {
                j -= 1;
                match b[j] {
                    b']' => d += 1,
                    b'[' => {
                        d -= 1;
                        if d == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
            }
            if d != 0 {
                break;
            }
            i = j;
        } else {
            break;
        }
    }
    (i < open).then(|| (i, String::from_utf8_lossy(&b[i..open]).replace("?.", ".")))
}

fn matching_paren(b: &[u8], open: usize, cap: usize) -> usize {
    let mut d = 0i32;
    let mut i = open;
    let end = (open + cap).min(b.len());
    let mut q = None::<u8>;
    while i < end {
        let c = b[i];
        match q {
            Some(o) => {
                if c == b'\\' {
                    i += 1;
                } else if c == o {
                    q = None;
                }
            }
            None => match c {
                b'\'' | b'"' | b'`' => q = Some(c),
                b'(' | b'[' | b'{' => d += 1,
                b')' | b']' | b'}' => {
                    d -= 1;
                    if d == 0 {
                        return i;
                    }
                }
                _ => {}
            },
        }
        i += 1;
    }
    end
}

/// Top-level keys of an object literal starting at `i` (`{`). None for spreads or non-literals.
fn object_keys(b: &[u8], i: usize) -> Option<Vec<String>> {
    if b.get(i) != Some(&b'{') {
        return None;
    }
    let end = matching_paren(b, i, 4000);
    if b.get(end) != Some(&b'}') {
        return None;
    }
    let mut keys = Vec::new();
    let mut j = i + 1;
    let mut d = 0i32;
    let mut item_start = true;
    while j < end {
        let c = b[j];
        match c {
            b'\'' | b'"' | b'`' => {
                let at_item = item_start && d == 0;
                if let Some((s, e)) = read_lit(b, j) {
                    if at_item {
                        keys.push(s);
                    }
                    j = e;
                    item_start = false;
                    continue;
                }
            }
            b'{' | b'(' | b'[' => d += 1,
            b'}' | b')' | b']' => d -= 1,
            b',' if d == 0 => {
                item_start = true;
                j += 1;
                continue;
            }
            _ => {}
        }
        if d == 0 && item_start && !(c as char).is_ascii_whitespace() {
            if c == b'.' {
                return None;
            }
            if is_ident(c) {
                let s = j;
                while j < end && is_ident(b[j]) {
                    j += 1;
                }
                keys.push(String::from_utf8_lossy(&b[s..j]).into_owned());
                item_start = false;
                continue;
            }
            if c == b'[' {
                return None;
            }
        }
        j += 1;
    }
    Some(keys)
}

fn bound_var(b: &[u8], start: usize) -> Option<String> {
    // `const x = await <call>` / `x = <call>` right before the callee chain
    let mut i = start;
    let back = |i: &mut usize| {
        while *i > 0 && (b[*i - 1] as char).is_ascii_whitespace() {
            *i -= 1;
        }
    };
    back(&mut i);
    if i >= 5 && &b[i - 5..i] == b"await" {
        i -= 5;
        back(&mut i);
    }
    if i == 0 || b[i - 1] != b'=' || (i >= 2 && matches!(b[i - 2], b'=' | b'!' | b'<' | b'>')) {
        return None;
    }
    i -= 1;
    back(&mut i);
    let e = i;
    while i > 0 && is_ident(b[i - 1]) {
        i -= 1;
    }
    (i < e).then(|| String::from_utf8_lossy(&b[i..e]).into_owned())
}

fn then_var(b: &[u8], close: usize) -> Option<String> {
    let mut i = ws(b, close + 1);
    if b.get(i) != Some(&b'.') {
        return None;
    }
    i = ws(b, i + 1);
    if !b[i..].starts_with(b"then") {
        return None;
    }
    i = ws(b, i + 4);
    if b.get(i) != Some(&b'(') {
        return None;
    }
    i = ws(b, i + 1);
    if b[i..].starts_with(b"async") {
        i = ws(b, i + 5);
    }
    if b[i..].starts_with(b"function") {
        i = ws(b, i + 8);
    }
    if b.get(i) == Some(&b'(') {
        i = ws(b, i + 1);
    }
    let s = i;
    while i < b.len() && is_ident(b[i]) {
        i += 1;
    }
    (i > s).then(|| String::from_utf8_lossy(&b[s..i]).into_owned())
}

fn reads_of(src: &Src, var: &str, from: usize, call_line: usize, wrapped: bool) -> Vec<String> {
    let b = src.b;
    let base_indent = src.indent_of(call_line);
    // window: following lines until one dedents below the call line
    let mut end = from;
    let mut line = src.pos(from).0;
    while line < src.starts.len() && line < call_line + 60 {
        let s = src.starts[line];
        let e = src.starts.get(line + 1).copied().unwrap_or(b.len());
        let txt = &b[s..e];
        let blank = txt.iter().all(|c| (*c as char).is_ascii_whitespace());
        if !blank && src.indent_of(line + 1) < base_indent {
            break;
        }
        end = e;
        line += 1;
    }
    let win = &b[from.min(end)..end];
    let mut out: Vec<String> = Vec::new();
    let v = var.as_bytes();
    let mut i = 0;
    while i + v.len() < win.len() {
        if win[i..].starts_with(v) && (i == 0 || !is_ident(win[i - 1]) && win[i - 1] != b'.') && !is_ident(win[i + v.len()]) {
            let mut j = i + v.len();
            let take = |j: &mut usize| -> Option<String> {
                if win.get(*j) == Some(&b'?') && win.get(*j + 1) == Some(&b'.') {
                    *j += 1;
                }
                if win.get(*j) != Some(&b'.') {
                    return None;
                }
                let s = *j + 1;
                let mut e = s;
                while e < win.len() && is_ident(win[e]) {
                    e += 1;
                }
                (e > s).then(|| {
                    *j = e;
                    String::from_utf8_lossy(&win[s..e]).into_owned()
                })
            };
            if let Some(f1) = take(&mut j) {
                let field = if wrapped { if matches!(f1.as_str(), "obj" | "body" | "data") { take(&mut j) } else { None } } else { Some(f1) };
                if let Some(f) = field {
                    if !IGNORED_FIELDS.contains(&f.as_str()) && win.get(j) != Some(&b'(') && !out.contains(&f) {
                        out.push(f);
                    }
                }
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    out.truncate(40);
    out
}

pub fn scan_text(rel: &str, text: &str) -> Vec<Call> {
    let b = text.as_bytes();
    let mut starts = vec![0];
    starts.extend(b.iter().enumerate().filter(|(_, c)| **c == b'\n').map(|(i, _)| i + 1));
    let src = Src { b, starts };
    let mut calls = Vec::new();
    let mut taken: Vec<usize> = Vec::new();
    for open in 0..b.len() {
        if b[open] != b'(' {
            continue;
        }
        let Some((start, chain)) = callee_before(b, open) else { continue };
        let (line, col) = src.pos(start);
        // 1. swagger-client
        if let Some(ai) = chain.find("apis") {
            if ai == 0 || !is_ident(chain.as_bytes()[ai - 1]) {
                let rest = &chain[ai + 4..];
                let parts = bracket_parts(rest);
                if parts.len() == 2 && chain[..ai].to_lowercase().contains("swagger") || parts.len() == 2 && chain[..ai].ends_with('.') {
                    let close = matching_paren(b, open, 6000);
                    let arg = ws(b, open + 1);
                    let keys = if b.get(arg) == Some(&b')') { Some(vec![]) } else { object_keys(b, arg) };
                    let var = bound_var(b, start).or_else(|| then_var(b, close));
                    let reads = var.map(|v| reads_of(&src, &v, close, line, true)).unwrap_or_default();
                    calls.push(Call { file: rel.into(), line, col, kind: "swagger-client".into(), method: None, path: None, tag: Some(parts[0].clone()), operation: Some(parts[1].clone()), keys, query_keys: None, reads, method_guessed: false, snippet: src.line_text(line) });
                    taken.push(start);
                    continue;
                }
            }
        }
        // 2. http helpers
        let segs: Vec<&str> = chain.split('.').collect();
        let last = segs.last().copied().unwrap_or("");
        let lower = last.to_lowercase();
        let obj = if segs.len() > 1 { segs[segs.len() - 2].to_lowercase() } else { String::new() };
        let verb = match lower.as_str() {
            "get" => Some("GET"),
            "post" => Some("POST"),
            "put" => Some("PUT"),
            "patch" => Some("PATCH"),
            "delete" | "del" => Some("DELETE"),
            _ => None,
        };
        let generic = lower.ends_with("fetch") || lower.ends_with("request") || lower.contains("apirequest") || lower == "axios" || lower.starts_with("fetch") && lower.len() <= 12;
        if (verb.is_some() && !DENY_OBJECTS.contains(&obj.as_str()) && !obj.is_empty()) || generic {
            let arg = ws(b, open + 1);
            let Some((lit, lit_end)) = read_concat(b, arg) else { continue };
            let Some((path, qkeys, qdyn)) = normalize(&lit) else { continue };
            let close = matching_paren(b, open, 6000);
            let args_text = String::from_utf8_lossy(&b[open..close.min(b.len())]).into_owned();
            let (method, guessed) = match verb {
                Some(v) => (v.to_string(), false),
                None => match find_method(&args_text) {
                    Some(m) => (m, false),
                    None => ("GET".into(), true),
                },
            };
            // axios-style params object / options object keys
            let mut query_keys = if qdyn { None } else { Some(qkeys) };
            if let Some(p) = args_text.find("params:") {
                let at = open + p + 7;
                match object_keys(b, ws(b, at)) {
                    Some(k) => {
                        if let Some(q) = query_keys.as_mut() {
                            q.extend(k)
                        }
                    }
                    None => query_keys = None,
                }
            } else if args_text.contains("params") && args_text.matches("params").count() > 0 && !args_text.contains("params:") {
                // a shorthand or variable named params: not visible
                if args_text.contains("{ params") || args_text.contains(", params") || args_text.contains("params }") || args_text.contains("params,") {
                    query_keys = None;
                }
            }
            let _ = lit_end;
            let var = bound_var(b, start).or_else(|| then_var(b, close));
            let reads = var.map(|v| reads_of(&src, &v, close, line, false)).unwrap_or_default();
            calls.push(Call { file: rel.into(), line, col, kind: "http".into(), method: Some(method), path: Some(path), tag: None, operation: None, keys: None, query_keys, reads, method_guessed: guessed, snippet: src.line_text(line) });
            taken.push(arg);
        }
    }
    if table_file(rel) {
        endpoint_table(&src, rel, &taken, &mut calls);
    }
    calls
}

fn find_method(args: &str) -> Option<String> {
    let i = args.find("method")?;
    let rest = args[i + 6..].trim_start().strip_prefix(':')?.trim_start();
    let q = rest.chars().next().filter(|c| matches!(c, '\'' | '"' | '`'))?;
    let end = rest[1..].find(q)?;
    let m = rest[1..1 + end].to_uppercase();
    matches!(m.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE").then_some(m)
}

/// `.Tag.op` or `["Tag"]["op"]` or mixed: exactly the segments after `apis`.
fn bracket_parts(rest: &str) -> Vec<String> {
    let b = rest.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'.' {
            let s = i + 1;
            let mut e = s;
            while e < b.len() && is_ident(b[e]) {
                e += 1;
            }
            if e == s {
                return vec![];
            }
            out.push(rest[s..e].to_string());
            i = e;
        } else if b[i] == b'[' {
            match read_lit(b, i + 1) {
                Some((s, e)) if b.get(e) == Some(&b']') => {
                    out.push(s);
                    i = e + 1;
                }
                _ => return vec![],
            }
        } else {
            return vec![];
        }
    }
    out
}

/// Path literals that sit in an endpoint table (after `:`, `=>`, `=` or `return`) and were not already read as call arguments.
fn endpoint_table(src: &Src, rel: &str, taken: &[usize], calls: &mut Vec<Call>) {
    let b = src.b;
    let mut i = 0;
    while i < b.len() {
        if matches!(b[i], b'\'' | b'"' | b'`') {
            let Some((lit, e)) = read_lit(b, i) else {
                i += 1;
                continue;
            };
            let mut k = i;
            while k > 0 && (b[k - 1] as char).is_ascii_whitespace() {
                k -= 1;
            }
            let after = k >= 1 && (b[k - 1] == b':' || b[k - 1] == b'=' || k >= 2 && &b[k - 2..k] == b"=>") || k >= 6 && &b[k - 6..k] == b"return";
            if after && !taken.contains(&i) && lit.starts_with('/') {
                if let Some((path, _, _)) = normalize(&lit) {
                    let (line, col) = src.pos(i);
                    {
                        calls.push(Call { file: rel.into(), line, col, kind: "reference".into(), method: None, path: Some(path), tag: None, operation: None, keys: None, query_keys: None, reads: vec![], method_guessed: false, snippet: src.line_text(line) });
                    }
                }
            }
            i = e;
        } else {
            i += 1;
        }
    }
}
