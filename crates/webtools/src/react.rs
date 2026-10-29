//! Heuristic React checks on `.jsx` / `.tsx` files (and `.js` files that mention React): the things a person who builds by prompting
//! an agent never sees but that matter for users: images without alt text, buttons and links with no readable name, inputs
//! without a label, clicks on elements that a keyboard cannot reach, lists without `key`, and components that grew too big.
//! It reads the text with a tolerant JSX tag scanner, not a compiler, so every finding carries a confidence and the tool says so.
//! Nothing is changed.

use std::path::Path;

use serde::Serialize;

use crate::jsmask::{mask, matching};
use crate::walk::walk;
use crate::{clean, line_of, line_starts, Confidence, Reader, WebError, SRC_CAP};

#[derive(Debug, Clone, Copy)]
pub struct ReactOptions {
    /// A component longer than this many lines is reported.
    pub max_lines: u32,
    /// A component with more props than this is reported.
    pub max_props: u32,
}

impl Default for ReactOptions {
    fn default() -> Self {
        Self { max_lines: 200, max_props: 10 }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactFinding {
    /// `imgAlt`, `noAccessibleName`, `inputLabel`, `clickNonInteractive`, `listKey`, `fragmentKey`, `largeComponent`, `manyProps`.
    pub rule: &'static str,
    pub file: String,
    pub line: u32,
    /// The tag or component the finding is about.
    pub detail: String,
    /// Lines of a large component, props of a component with many.
    pub count: u32,
    pub confidence: Confidence,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactReport {
    pub findings: Vec<ReactFinding>,
    pub files_scanned: u32,
    pub truncated: bool,
    pub skipped: Vec<String>,
}

const WORK_PER_FILE: usize = 40_000_000;
const MAX_PER_FILE: usize = 60;
const MAX_TOTAL: usize = 1000;

struct Attr {
    name: String,
    /// The text of a string value, when the value is a string literal.
    text: Option<(usize, usize)>,
    has_value: bool,
}

struct Tag {
    name: String,
    lt: usize,
    end: usize,
    self_closing: bool,
    attrs: Vec<Attr>,
    spread: bool,
}

impl Tag {
    fn attr(&self, name: &str) -> Option<&Attr> {
        self.attrs.iter().find(|a| a.name == name)
    }
}

fn name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-' | b'$')
}

fn skip_ws(m: &[u8], mut i: usize) -> usize {
    while i < m.len() && m[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// Parses the opening tag at `lt` (`<`), or None when it does not look like one.
fn parse_tag(m: &[u8], lt: usize, work: &mut usize) -> Option<Tag> {
    let mut i = lt + 1;
    if m.get(i) == Some(&b'>') {
        return Some(Tag { name: String::new(), lt, end: i + 1, self_closing: false, attrs: Vec::new(), spread: false });
    }
    let start = i;
    while i < m.len() && name_byte(m[i]) {
        i += 1;
    }
    if i == start || !m[start].is_ascii_alphabetic() {
        return None;
    }
    let mut tag = Tag { name: String::from_utf8_lossy(&m[start..i]).into_owned(), lt, end: 0, self_closing: false, attrs: Vec::new(), spread: false };
    let limit = (lt + 30_000).min(m.len());
    loop {
        i = skip_ws(m, i);
        if i >= limit || *work == 0 {
            return None;
        }
        *work -= 1;
        match m[i] {
            b'>' => {
                tag.end = i + 1;
                return Some(tag);
            }
            b'/' if m.get(i + 1) == Some(&b'>') => {
                tag.end = i + 2;
                tag.self_closing = true;
                return Some(tag);
            }
            b'{' => {
                let close = matching(m, i, work)?;
                tag.spread = true;
                i = close + 1;
            }
            c if c.is_ascii_alphabetic() || c == b'_' || c == b'$' => {
                let s = i;
                while i < m.len() && name_byte(m[i]) {
                    i += 1;
                }
                let mut attr = Attr { name: String::from_utf8_lossy(&m[s..i]).into_owned(), text: None, has_value: false };
                let after = skip_ws(m, i);
                if m.get(after) == Some(&b'=') {
                    let v = skip_ws(m, after + 1);
                    match m.get(v) {
                        Some(&q) if q == b'"' || q == b'\'' => {
                            let end = m[v + 1..limit].iter().position(|b| *b == q)? + v + 1;
                            attr.text = Some((v + 1, end));
                            attr.has_value = true;
                            i = end + 1;
                        }
                        Some(b'{') => {
                            let close = matching(m, v, work)?;
                            attr.has_value = true;
                            i = close + 1;
                        }
                        _ => return None,
                    }
                }
                if tag.attrs.len() >= 80 {
                    return None;
                }
                tag.attrs.push(attr);
            }
            _ => return None,
        }
    }
}

/// Whether a `<` at `lt` can start JSX here (and not a comparison or a generic).
fn jsx_start(m: &[u8], lt: usize) -> bool {
    let mut k = lt;
    let mut steps = 0;
    while k > 0 && m[k - 1].is_ascii_whitespace() && steps < 400 {
        k -= 1;
        steps += 1;
    }
    if k == 0 {
        return true;
    }
    if b"(,=?:&|{}>;'\"`".contains(&m[k - 1]) {
        return true;
    }
    // JSX text before an inline tag: `Read <a href>more</a>` (a space, then a known element; `useState<string>` has no space)
    if k < lt && m[k - 1].is_ascii_alphanumeric() {
        let (_, name) = ident(m, lt + 1);
        return INLINE.iter().any(|n| n.as_bytes() == name);
    }
    m[..k].ends_with(b"return") && (k < 7 || !name_byte(m[k - 7]))
}

const INLINE: &[&str] = &["a", "b", "i", "u", "em", "strong", "span", "img", "button", "code", "small", "sup", "sub", "label", "input"];
const NON_INTERACTIVE: &[&str] = &["div", "span", "li", "p", "section", "article", "td", "tr", "img", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "header", "footer", "main", "aside"];

fn closing_of(m: &[u8], from: usize, name: &str, work: &mut usize) -> Option<usize> {
    let open = [b"<".as_slice(), name.as_bytes()].concat();
    let close = [b"</".as_slice(), name.as_bytes()].concat();
    let end = (from + 8000).min(m.len());
    let mut depth = 0usize;
    let mut k = from;
    while k < end {
        if *work == 0 {
            return None;
        }
        *work -= 1;
        if m[k] == b'<' {
            if m[k..].starts_with(&close) {
                if depth == 0 {
                    return Some(k);
                }
                depth -= 1;
            } else if m[k..].starts_with(&open) && m.get(k + open.len()).is_some_and(|c| !name_byte(*c)) {
                depth += 1;
            }
        }
        k += 1;
    }
    None
}

/// Some(true): there is text or something that may be text; Some(false): nothing a person could read (an empty element or
/// icons only); None: not sure.
fn has_text(m: &[u8], s: &[u8], from: usize, to: usize, work: &mut usize) -> Option<bool> {
    let mut k = from;
    while k < to {
        if *work == 0 {
            return None;
        }
        *work -= 1;
        match m[k] {
            b'<' => {
                if m.get(k + 1) == Some(&b'/') {
                    k = m[k..to].iter().position(|b| *b == b'>').map_or(to, |p| k + p + 1);
                    continue;
                }
                let t = parse_tag(m, k, work)?;
                let first = t.name.bytes().next().unwrap_or(b'A');
                if first.is_ascii_uppercase() || t.name.contains('.') || t.name == "title" || t.spread {
                    return Some(true);
                }
                if t.name == "img" {
                    if let Some(a) = t.attr("alt") {
                        match a.text {
                            Some((x, y)) if s[x..y].iter().all(u8::is_ascii_whitespace) => {}
                            _ => return Some(true),
                        }
                    }
                }
                if t.attr("aria-label").is_some() || t.attr("children").is_some() || t.attr("dangerouslySetInnerHTML").is_some() {
                    return Some(true);
                }
                k = t.end;
            }
            b'{' => {
                let close = matching(m, k, work)?;
                if m[k + 1..close].iter().any(|b| !b.is_ascii_whitespace()) {
                    return Some(true);
                }
                k = close + 1;
            }
            b if b.is_ascii_whitespace() => k += 1,
            _ => return Some(true),
        }
    }
    Some(false)
}

struct Ctx<'a> {
    file: &'a str,
    m: &'a [u8],
    s: &'a [u8],
    starts: Vec<usize>,
    out: Vec<ReactFinding>,
    work: usize,
    /// Text of the file mentions something that labels inputs (`htmlFor`, a `<Label` component).
    labels_somewhere: bool,
}

impl Ctx<'_> {
    fn push(&mut self, rule: &'static str, at: usize, detail: &str, count: u32, confidence: Confidence) {
        if self.out.len() < MAX_PER_FILE {
            self.out.push(ReactFinding { rule, file: self.file.to_string(), line: line_of(&self.starts, at), detail: clean(detail, 80), count, confidence });
        }
    }

    fn check_tag(&mut self, t: &Tag) {
        let name = t.name.as_str();
        match name {
            "img" if t.attr("alt").is_none() && !t.spread => self.push("imgAlt", t.lt, "img", 0, Confidence::High),
            "button" | "a" if !t.spread && t.attr("aria-label").is_none() && t.attr("aria-labelledby").is_none() && t.attr("title").is_none() && t.attr("children").is_none() => {
                let empty = if t.self_closing {
                    Some(false)
                } else {
                    match closing_of(self.m, t.end, name, &mut self.work) {
                        Some(close) => has_text(self.m, self.s, t.end, close, &mut self.work),
                        None => None,
                    }
                };
                if empty == Some(false) {
                    self.push("noAccessibleName", t.lt, name, 0, Confidence::Medium);
                }
            }
            "input" | "textarea" | "select" if !t.spread => {
                let kind = t.attr("type").map(|a| a.text.map(|(x, y)| String::from_utf8_lossy(&self.s[x..y]).to_ascii_lowercase()));
                let skip_kind = match &kind {
                    Some(Some(k)) => matches!(k.as_str(), "hidden" | "submit" | "button" | "reset" | "image"),
                    Some(None) => true, // type={...}: not sure
                    None => false,
                };
                if skip_kind || t.attr("aria-label").is_some() || t.attr("aria-labelledby").is_some() || t.attr("title").is_some() {
                    return;
                }
                let from = t.lt.saturating_sub(3000);
                let window = &self.m[from..t.lt];
                let last_open = window.windows(6).rposition(|w| w == b"<label");
                let last_close = window.windows(7).rposition(|w| w == b"</label");
                let wrapped = match (last_open, last_close) {
                    (Some(o), Some(c)) => o > c,
                    (Some(_), None) => true,
                    _ => false,
                };
                if wrapped {
                    return;
                }
                match t.attr("id") {
                    None => self.push("inputLabel", t.lt, name, 0, Confidence::Medium),
                    Some(_) if !self.labels_somewhere => self.push("inputLabel", t.lt, name, 0, Confidence::Low),
                    Some(_) => {}
                }
            }
            n if NON_INTERACTIVE.contains(&n) && !t.spread && t.attr("onClick").is_some() && ["role", "tabIndex", "onKeyDown", "onKeyUp", "onKeyPress"].iter().all(|k| t.attr(k).is_none()) => {
                self.push("clickNonInteractive", t.lt, n, 0, Confidence::Medium);
            }
            _ => {}
        }
    }

    /// `.map(x => <Tag ...>)` and `.map(x => { ... return <Tag ...> })` without a `key`.
    fn check_lists(&mut self) {
        let m = self.m;
        let hits: Vec<usize> = m.windows(5).enumerate().filter(|(_, w)| *w == b".map(").map(|(i, _)| i).take(2000).collect();
        for at in hits {
            let mut i = skip_ws(m, at + 5);
            // parameters
            if m.get(i) == Some(&b'(') {
                match matching(m, i, &mut self.work) {
                    Some(c) => i = c + 1,
                    None => continue,
                }
            } else {
                while i < m.len() && name_byte(m[i]) {
                    i += 1;
                }
            }
            i = skip_ws(m, i);
            if !m[i.min(m.len())..].starts_with(b"=>") {
                continue;
            }
            i = skip_ws(m, i + 2);
            while m.get(i) == Some(&b'(') {
                i = skip_ws(m, i + 1);
            }
            if m.get(i) == Some(&b'{') {
                let Some(close) = matching(m, i, &mut self.work) else { continue };
                let body = &m[i..close.min(i + 2500)];
                let Some(r) = body.windows(6).position(|w| w == b"return") else { continue };
                i = skip_ws(m, i + r + 6);
                while m.get(i) == Some(&b'(') {
                    i = skip_ws(m, i + 1);
                }
            }
            if m.get(i) != Some(&b'<') {
                continue;
            }
            let Some(t) = parse_tag(m, i, &mut self.work) else { continue };
            if t.name.is_empty() {
                self.push("fragmentKey", i, "<>", 0, Confidence::Medium);
            } else if t.attr("key").is_none() && !t.spread {
                self.push("listKey", i, &t.name, 0, Confidence::Medium);
            }
        }
    }
}

/// One component found in the text.
struct Comp {
    name: String,
    start: usize,
    end: usize,
    params: Option<(usize, usize)>,
    /// `FC<Props>` of the declaration.
    annotated: Option<String>,
}

fn ident(m: &[u8], i: usize) -> (usize, &[u8]) {
    let mut j = i;
    while j < m.len() && (m[j].is_ascii_alphanumeric() || m[j] == b'_' || m[j] == b'$') {
        j += 1;
    }
    (j, &m[i..j])
}

fn boundary_before(m: &[u8], i: usize) -> bool {
    i == 0 || !(m[i - 1].is_ascii_alphanumeric() || m[i - 1] == b'_' || m[i - 1] == b'$' || m[i - 1] == b'.')
}

fn find_all(m: &[u8], word: &[u8]) -> Vec<usize> {
    m.windows(word.len()).enumerate().filter(|(i, w)| *w == word && boundary_before(m, *i)).map(|(i, _)| i).take(5000).collect()
}

/// Skips `<...>` type arguments (bounded) starting at `i`; returns the index after them.
fn skip_angle(m: &[u8], i: usize) -> usize {
    if m.get(i) != Some(&b'<') {
        return i;
    }
    let mut depth = 0;
    for (k, b) in m[i..(i + 300).min(m.len())].iter().enumerate() {
        match b {
            b'<' => depth += 1,
            b'>' if m.get(i + k.wrapping_sub(1)) != Some(&b'=') => {
                depth -= 1;
                if depth == 0 {
                    return i + k + 1;
                }
            }
            _ => {}
        }
    }
    i
}

fn body_after_params(m: &[u8], mut i: usize, arrow: bool, work: &mut usize) -> Option<usize> {
    i = skip_ws(m, i);
    if m.get(i) == Some(&b':') {
        // a return type: up to the arrow or the brace
        let stop = (i + 300).min(m.len());
        let mut k = i;
        while k < stop {
            if arrow && m[k..].starts_with(b"=>") || !arrow && m[k] == b'{' {
                break;
            }
            if m[k] == b';' {
                return None;
            }
            k += 1;
        }
        if k >= stop {
            return None;
        }
        i = k;
    }
    if arrow {
        if !m[i.min(m.len())..].starts_with(b"=>") {
            return None;
        }
        i = skip_ws(m, i + 2);
    }
    match m.get(i) {
        Some(b'{') => matching(m, i, work),
        Some(b'(') => matching(m, i, work),
        _ => None,
    }
}

fn components(m: &[u8], work: &mut usize) -> Vec<Comp> {
    let mut out = Vec::new();
    for at in find_all(m, b"function") {
        let mut i = skip_ws(m, at + 8);
        let (j, name) = ident(m, i);
        if !name.first().is_some_and(u8::is_ascii_uppercase) {
            continue;
        }
        i = skip_angle(m, skip_ws(m, j));
        if m.get(i) != Some(&b'(') {
            continue;
        }
        let Some(pc) = matching(m, i, work) else { continue };
        if let Some(end) = body_after_params(m, pc + 1, false, work) {
            out.push(Comp { name: String::from_utf8_lossy(name).into_owned(), start: at, end, params: Some((i + 1, pc)), annotated: None });
        }
    }
    for kw in [&b"const"[..], b"let", b"var"] {
        for at in find_all(m, kw) {
            let mut i = skip_ws(m, at + kw.len());
            let (j, name) = ident(m, i);
            if !name.first().is_some_and(u8::is_ascii_uppercase) {
                continue;
            }
            i = skip_ws(m, j);
            let mut annotated = None;
            if m.get(i) == Some(&b':') {
                let stop = (i + 300).min(m.len());
                let Some(eq) = m[i..stop].iter().position(|b| *b == b'=') else { continue };
                let ann = &m[i + 1..i + eq];
                if let Some(lt) = ann.iter().position(|b| *b == b'<') {
                    let (_, inner) = ident(m, i + 1 + lt + 1);
                    if !inner.is_empty() {
                        annotated = Some(String::from_utf8_lossy(inner).into_owned());
                    }
                }
                i += eq;
            }
            if m.get(i) != Some(&b'=') || m.get(i + 1) == Some(&b'=') {
                continue;
            }
            i = skip_ws(m, i + 1);
            // wrappers: memo( forwardRef( observer( ...
            for _ in 0..3 {
                let (k, w) = ident(m, i);
                let mut k2 = k;
                let mut word = w.to_vec();
                if m.get(k) == Some(&b'.') {
                    let (k3, w2) = ident(m, k + 1);
                    word = w2.to_vec();
                    k2 = k3;
                }
                if [&b"memo"[..], b"forwardRef", b"observer"].contains(&word.as_slice()) {
                    let after = skip_angle(m, k2);
                    if m.get(after) == Some(&b'(') {
                        i = skip_ws(m, after + 1);
                        continue;
                    }
                }
                break;
            }
            if m[i.min(m.len())..].starts_with(b"async") {
                i = skip_ws(m, i + 5);
            }
            let params;
            let mut arrow = true;
            if m[i.min(m.len())..].starts_with(b"function") {
                arrow = false;
                let mut k = skip_ws(m, i + 8);
                let (k2, _) = ident(m, k);
                k = skip_ws(m, k2);
                if m.get(k) != Some(&b'(') {
                    continue;
                }
                let Some(pc) = matching(m, k, work) else { continue };
                params = (k + 1, pc);
            } else if m.get(i) == Some(&b'(') {
                let Some(pc) = matching(m, i, work) else { continue };
                params = (i + 1, pc);
            } else {
                let (k, w) = ident(m, i);
                if w.is_empty() || !m[skip_ws(m, k).min(m.len())..].starts_with(b"=>") {
                    continue;
                }
                params = (i, k);
            }
            if let Some(end) = body_after_params(m, params.1 + usize::from(m.get(params.1) == Some(&b')')), arrow, work) {
                out.push(Comp { name: String::from_utf8_lossy(name).into_owned(), start: at, end, params: Some(params), annotated });
            }
        }
    }
    out.sort_by_key(|c| c.start);
    out.dedup_by_key(|c| c.params);
    out
}

/// Entries at the top level of a destructuring pattern or of a type body: split at `,` `;` and (for types) newlines.
fn count_entries(m: &[u8], from: usize, to: usize, type_body: bool) -> u32 {
    let mut depth = 0i32;
    let mut count = 0u32;
    let mut seg_has_colon = false;
    let mut seg_has_content = false;
    let mut seg_rest = false;
    let flush = |colon: bool, content: bool, rest: bool, count: &mut u32| {
        if type_body && colon || !type_body && content && !rest {
            *count += 1;
        }
    };
    for &b in &m[from..to] {
        match b {
            b'{' | b'(' | b'[' => depth += 1,
            b'}' | b')' | b']' => depth -= 1,
            _ => {}
        }
        let sep = depth == 0 && (b == b',' || b == b';' || (type_body && b == b'\n'));
        if sep {
            flush(seg_has_colon, seg_has_content, seg_rest, &mut count);
            seg_has_colon = false;
            seg_has_content = false;
            seg_rest = false;
        } else if !b.is_ascii_whitespace() {
            if depth == 0 && b == b':' {
                seg_has_colon = true;
            }
            if !seg_has_content && b == b'.' {
                seg_rest = true;
            }
            seg_has_content = true;
        }
    }
    flush(seg_has_colon, seg_has_content, seg_rest, &mut count);
    count
}

fn type_body(m: &[u8], name: &str, work: &mut usize) -> Option<(usize, usize)> {
    for kw in ["interface ", "type "] {
        let pat = format!("{kw}{name}");
        let p = pat.as_bytes();
        for at in find_all(m, p) {
            let after = at + p.len();
            if m.get(after).is_some_and(|c| name_byte(*c)) {
                continue;
            }
            let stop = (after + 200).min(m.len());
            let Some(open) = m[after..stop].iter().position(|b| *b == b'{') else { continue };
            let open = after + open;
            if m[after..open].contains(&b';') {
                continue;
            }
            if let Some(close) = matching(m, open, work) {
                return Some((open + 1, close));
            }
        }
    }
    None
}

fn props_of(m: &[u8], c: &Comp, work: &mut usize) -> Option<u32> {
    let (a, z) = c.params?;
    let first_end = {
        let mut depth = 0i32;
        let mut end = z;
        for (k, &b) in m[a..z].iter().enumerate() {
            match b {
                b'{' | b'(' | b'[' | b'<' => depth += 1,
                b'}' | b')' | b']' | b'>' => depth -= 1,
                b',' if depth == 0 => {
                    end = a + k;
                    break;
                }
                _ => {}
            }
        }
        end
    };
    let p = skip_ws(m, a);
    if p >= first_end {
        return Some(0);
    }
    if m[p] == b'{' {
        let close = matching(m, p, work)?;
        return Some(count_entries(m, p + 1, close, false));
    }
    // `props: Name` or the declaration's `FC<Name>`
    let (_, _) = ident(m, p);
    let named = {
        let colon = m[p..first_end].iter().position(|b| *b == b':').map(|k| p + k + 1);
        colon.map(|k| String::from_utf8_lossy(ident(m, skip_ws(m, k)).1).into_owned()).filter(|n| !n.is_empty())
    };
    let name = named.or_else(|| c.annotated.clone())?;
    let (x, y) = type_body(m, &name, work)?;
    Some(count_entries(m, x, y, true))
}

fn react_file(file: &str, text: &str, opts: ReactOptions, labels_somewhere: bool) -> Vec<ReactFinding> {
    let s = text.as_bytes();
    let m = mask(s);
    let mut ctx = Ctx { file, m: &m, s, starts: line_starts(s), out: Vec::new(), work: WORK_PER_FILE, labels_somewhere };
    let lts: Vec<usize> = m.iter().enumerate().filter(|(_, b)| **b == b'<').map(|(i, _)| i).take(200_000).collect();
    for lt in lts {
        if ctx.work == 0 {
            break;
        }
        if !m.get(lt + 1).is_some_and(|c| c.is_ascii_alphabetic() || *c == b'>') || !jsx_start(&m, lt) {
            continue;
        }
        if let Some(t) = parse_tag(&m, lt, &mut ctx.work) {
            ctx.check_tag(&t);
        }
    }
    ctx.check_lists();
    let mut work = ctx.work.max(1_000_000);
    for c in components(&m, &mut work) {
        let lines = line_of(&ctx.starts, c.end) - line_of(&ctx.starts, c.start) + 1;
        if lines > opts.max_lines {
            ctx.push("largeComponent", c.start, &c.name, lines, Confidence::Medium);
        }
        if let Some(n) = props_of(&m, &c, &mut work) {
            if n > opts.max_props {
                ctx.push("manyProps", c.start, &c.name, n, Confidence::Medium);
            }
        }
    }
    ctx.out
}

fn skipped_file(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    [".test.", ".spec.", ".stories.", ".story.", "/__tests__/", "/__mocks__/", "/cypress/", "/e2e/"].iter().any(|p| lower.contains(p))
}

pub fn react_checks(root: &Path, opts: ReactOptions) -> Result<ReactReport, WebError> {
    let w = walk(root);
    let mut reader = Reader::new(root);
    let mut report = ReactReport::default();
    for e in &w.files {
        if !matches!(e.ext.as_str(), "jsx" | "tsx" | "js" | "mjs") || skipped_file(&e.rel) {
            continue;
        }
        let Some(text) = reader.read(e, SRC_CAP) else { continue };
        if matches!(e.ext.as_str(), "js" | "mjs") && !text.contains("react") && !text.contains("React") {
            continue;
        }
        report.files_scanned += 1;
        let labels = text.contains("htmlFor") || text.contains("<Label") || text.contains("<FormLabel") || text.contains("<label");
        report.findings.extend(react_file(&e.rel, &text, opts, labels));
        if report.findings.len() >= MAX_TOTAL {
            report.findings.truncate(MAX_TOTAL);
            report.truncated = true;
            break;
        }
    }
    report.truncated |= reader.truncated;
    report.skipped = reader.skipped;
    report.skipped.extend(w.notes);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(src: &str) -> Vec<(&'static str, u32, String)> {
        react_file("A.tsx", src, ReactOptions { max_lines: 12, max_props: 3 }, src.contains("htmlFor")).into_iter().map(|f| (f.rule, f.line, f.detail)).collect()
    }

    #[test]
    fn img_without_alt_and_empty_buttons_and_links() {
        let src = r#"export const A = () => (
  <div>
    <img src="a.png" />
    <img src="b.png" alt="" />
    <button onClick={go}><svg><path d="M0" /></svg></button>
    <button>Save</button>
    <button aria-label="Close"><svg /></button>
    <a href="/x"><img src="i.png" alt="Home" /></a>
    <a href="/y"></a>
    <button>{label}</button>
  </div>
);"#;
        assert_eq!(run(src), vec![("imgAlt", 3, "img".into()), ("noAccessibleName", 5, "button".into()), ("noAccessibleName", 9, "a".into())]);
    }

    #[test]
    fn inputs_need_a_label() {
        let src = r#"const A = () => (<form>
  <input type="text" />
  <input type="hidden" name="x" />
  <input aria-label="Name" />
  <label>Email <input type="email" /></label>
  <label htmlFor="n">N</label><input id="n" />
  <textarea />
</form>);"#;
        assert_eq!(run(src), vec![("inputLabel", 2, "input".into()), ("inputLabel", 7, "textarea".into())]);
    }

    #[test]
    fn click_on_non_interactive_elements() {
        let src = r#"const A = () => (<div>
  <div onClick={a}>x</div>
  <div onClick={a} role="button" tabIndex={0} onKeyDown={k}>y</div>
  <button onClick={a}>z</button>
  <span {...rest} onClick={a} />
</div>);"#;
        assert_eq!(run(src), vec![("clickNonInteractive", 2, "div".into())]);
    }

    #[test]
    fn lists_need_keys() {
        let src = r#"const A = () => (<ul>
  {items.map((i) => <li>{i}</li>)}
  {items.map((i) => <li key={i.id}>{i}</li>)}
  {items.map(i => (
    <Row {...i} />
  ))}
  {items.map((i) => { const x = f(i); return (<Item name={x} />); })}
  {items.map((i) => <><b /></>)}
  {items.map((i) => i.id)}
</ul>);"#;
        assert_eq!(run(src), vec![("listKey", 2, "li".into()), ("listKey", 7, "Item".into()), ("fragmentKey", 8, "<>".into())]);
    }

    #[test]
    fn generics_and_comparisons_are_not_tags() {
        let src = "const a = useState<string>('x'); const b = x < y && z > w; const c = <T,>(v: T) => v;\nif (a <b) {}\n";
        assert!(run(src).is_empty());
    }

    #[test]
    fn large_components_and_many_props() {
        let body = (0..14).map(|i| format!("  const v{i} = {i};\n")).collect::<String>();
        let src = format!(
            "function Big({{ a, b, c, d, ...rest }}) {{\n{body}  return null;\n}}\nconst Small = ({{ a }}: {{ a: string }}) => null;\ninterface Props {{\n  a: string;\n  b?: number;\n  onX: (a: number,\n    b: number) => void;\n  c: string;\n}}\nconst Typed: React.FC<Props> = (props) => {{ return null; }};\n"
        );
        let got = run(&src);
        let rules: Vec<(&str, &str)> = got.iter().map(|g| (g.0, g.2.as_str())).collect();
        assert_eq!(rules, vec![("largeComponent", "Big"), ("manyProps", "Big"), ("manyProps", "Typed")]);
        assert_eq!(got[0].1, 1);
    }

    #[test]
    fn wrapped_components_are_found() {
        let src = "export const Card = React.memo(function Card({ a, b, c, d, e }) { return null; });\nconst Fw = forwardRef<HTMLDivElement, P>(({ a, b, c, d }, ref) => { return null; });\n";
        let got = run(src);
        assert_eq!(got.iter().filter(|g| g.0 == "manyProps").count(), 2);
    }

    #[test]
    fn jsx_text_with_an_apostrophe_does_not_hide_the_rest() {
        let src = "const A = () => (<div><p>Don't</p>\n<img src=\"x\" /></div>);";
        assert_eq!(run(src), vec![("imgAlt", 2, "img".into())]);
    }

    #[test]
    fn hostile_inputs_are_linear() {
        let nested = "<a x={".repeat(100_000);
        let _ = react_file("h.tsx", &nested, ReactOptions::default(), false);
        let fns = "function A(".repeat(100_000);
        let _ = react_file("h.tsx", &fns, ReactOptions::default(), false);
        let maps = ".map((x) => (".repeat(100_000);
        let _ = react_file("h.tsx", &maps, ReactOptions::default(), false);
        let lts = "<".repeat(1_000_000);
        let _ = react_file("h.tsx", &lts, ReactOptions::default(), false);
        let buttons = "<button>".repeat(100_000);
        let _ = react_file("h.tsx", &buttons, ReactOptions::default(), false);
    }
}
