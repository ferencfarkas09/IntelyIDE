//! Privacy modes and the filters that sit between the user's text / the schema and the model.
//!
//! This round ships **P0 (AI off, default)** and **P1 (schema only, no enum values)**. P2/P3/PL do not exist as
//! variants, so no configuration can ask for samples. Every text path to the model goes through one [`Masker`] in every
//! mode; the payload preview is the very request that is sent (see `prompt::PayloadPreview`).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::digest::Digest;
use crate::types::EffectiveLevel;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrivacyMode {
    /// AI off: nothing is sent, the pipeline refuses before any port is touched.
    #[default]
    P0,
    /// Schema only: question (post-filter), collection names, field paths and types, presence, indexes. No values.
    P1,
    /// P1 plus the value sets of low-cardinality string fields (status, type, category), after the value filter and never
    /// for credential- or PII-named fields. An explicit consent level: the payload preview shows every value.
    P1Enum,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPolicy {
    pub mode: PrivacyMode,
    /// `effective_level` of the connection: any non-loopback host is `ProductionLevel`.
    pub level: Option<EffectiveLevel>,
    /// Per-connection deny list: field names (any path segment, case/accent-insensitive) never shown to the model.
    pub deny_fields: Vec<String>,
    /// User glossary for collection routing, e.g. `("rendeles", "orders")`.
    pub glossary: Vec<(String, String)>,
    pub tenant_field: Option<String>,
    pub tenant_lock: bool,
}

impl AiPolicy {
    pub fn p1(level: EffectiveLevel) -> Self {
        Self { mode: PrivacyMode::P1, level: Some(level), ..Default::default() }
    }
    pub fn with_enums(&self) -> bool {
        self.mode == PrivacyMode::P1Enum
    }
    pub fn is_on(&self) -> bool {
        self.mode != PrivacyMode::P0
    }
    /// Unknown level counts as production-level (fail closed).
    pub fn production_level(&self) -> bool {
        !matches!(self.level, Some(EffectiveLevel::Local))
    }
}

// ---- literal masking ------------------------------------------------------------------------------------------------

/// Replaces literals by typed placeholders and remembers the originals locally. The originals are re-substituted only into
/// the draft shown to the user, never into anything sent to a model.
#[derive(Debug, Clone, Default)]
pub struct Masker {
    kept: Vec<(String, String)>,
    counts: BTreeMap<&'static str, usize>,
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric()
}

impl Masker {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn kept(&self) -> &[(String, String)] {
        &self.kept
    }
    pub fn count(&self) -> usize {
        self.kept.len()
    }

    fn placeholder(&mut self, kind: &'static str, original: &str) -> String {
        if let Some((ph, _)) = self.kept.iter().find(|(p, o)| o == original && p.starts_with(&format!("<{kind}"))) {
            return ph.clone();
        }
        let n = self.counts.entry(kind).or_insert(0);
        *n += 1;
        let ph = if *n == 1 { format!("<{kind}>") } else { format!("<{kind}_{n}>") };
        self.kept.push((ph.clone(), original.to_string()));
        ph
    }

    /// Prose (the question, the Fix input): quoted strings, emails, ObjectId-like hex, IBAN-like strings, phone and tax
    /// numbers and any long digit run.
    pub fn mask_question(&mut self, text: &str) -> String {
        let pre = self.mask_quoted(text);
        let mut out = String::with_capacity(pre.len());
        let toks: Vec<&str> = pre.split_inclusive(char::is_whitespace).collect();
        let mut i = 0;
        while i < toks.len() {
            let tok = toks[i];
            let word = tok.trim_end();
            let trail = &tok[word.len()..];
            let (lead, core, tail) = split_punct(word);
            // phone-like run: "+36 30 123 4567", "06 30 123 4567", "(06) 1 234 5678"
            if digitish(core) && phone_start(core) && !is_iso_date(core) {
                let mut j = i;
                let mut digits = count_digits(core);
                let mut span = core.to_string();
                let mut end_trail = trail.to_string();
                while j + 1 < toks.len() {
                    let nxt = toks[j + 1].trim_end();
                    let (_, c2, t2) = split_punct(nxt);
                    if digitish(c2) && t2.is_empty() || (digitish(c2) && !c2.is_empty()) {
                        digits += count_digits(c2);
                        span.push_str(&end_trail);
                        span.push_str(c2);
                        end_trail = toks[j + 1][nxt.len()..].to_string();
                        j += 1;
                        if !t2.is_empty() {
                            break;
                        }
                    } else {
                        break;
                    }
                }
                if digits >= 8 {
                    let ph = self.placeholder("number", &span);
                    out.push_str(lead);
                    out.push_str(&ph);
                    out.push_str(if j == i { tail } else { split_punct(toks[j].trim_end()).2 });
                    out.push_str(&end_trail);
                    i = j + 1;
                    continue;
                }
            }
            let ph = self.classify_core(core);
            match ph {
                Some(p) => {
                    out.push_str(lead);
                    out.push_str(&p);
                    out.push_str(tail);
                }
                None => out.push_str(word),
            }
            out.push_str(trail);
            i += 1;
        }
        out
    }

    fn classify_core(&mut self, core: &str) -> Option<String> {
        if core.is_empty() || core.starts_with('<') {
            return None;
        }
        if core.contains("://") {
            return Some(self.placeholder("uri", core));
        }
        if core.contains('@') && core.rsplit('@').next().is_some_and(|d| d.contains('.')) && core.len() > 4 {
            return Some(self.placeholder("email", core));
        }
        if core.len() == 24 && core.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Some(self.placeholder("objectid", core));
        }
        if looks_iban(core) {
            return Some(self.placeholder("iban", core));
        }
        if digitish(core) && count_digits(core) >= 8 && !is_iso_date(core) {
            return Some(self.placeholder("number", core));
        }
        None
    }

    /// `"Kovács Anna"`, `'x'`, `„y”`: whole quoted strings become `<string>`. An opening quote must not follow a letter
    /// (apostrophes), the closing one must not precede a letter.
    fn mask_quoted(&mut self, text: &str) -> String {
        let chars: Vec<char> = text.chars().collect();
        let mut out = String::new();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            let close = match c {
                '"' => Some('"'),
                '\'' => Some('\''),
                '„' => Some('”'),
                '“' => Some('”'),
                '«' => Some('»'),
                '`' => Some('`'),
                _ => None,
            };
            if let Some(close) = close {
                let prev_word = i > 0 && is_word(chars[i - 1]);
                if !prev_word {
                    let mut j = i + 1;
                    let mut found = None;
                    while j < chars.len() && j - i <= 200 && chars[j] != '\n' {
                        if (chars[j] == close || (c == '„' && chars[j] == '"')) && !chars.get(j + 1).is_some_and(|n| is_word(*n)) && j > i + 1 {
                            found = Some(j);
                            break;
                        }
                        j += 1;
                    }
                    if let Some(j) = found {
                        let inner: String = chars[i + 1..j].iter().collect();
                        out.push_str(&self.placeholder("string", &inner));
                        i = j + 1;
                        continue;
                    }
                }
            }
            out.push(c);
            i += 1;
        }
        out
    }

    /// Query text (editor content, previous draft, history): string VALUES (not keys) and PII-shaped tokens are replaced
    /// and the quotes are kept, so the text stays a query. `blanket` replaces every string value (user-origin text);
    /// without it only PII-shaped values are replaced (the model's own draft).
    pub fn mask_query(&mut self, text: &str, blanket: bool) -> String {
        let chars: Vec<char> = text.chars().collect();
        let mut out = String::new();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if blanket && c == '/' && !matches!(chars.get(i + 1), Some('/') | Some('*')) && out.trim_end().chars().last().is_none_or(|p| matches!(p, ':' | ',' | '[' | '(' | '{')) {
                // regex literal /pattern/flags: the whole pattern is a value (names, e-mails) and becomes an EJSON regex
                let mut j = i + 1;
                let mut esc = false;
                while j < chars.len() && chars[j] != '\n' && (esc || chars[j] != '/') {
                    esc = !esc && chars[j] == '\\';
                    j += 1;
                }
                if j < chars.len() && chars[j] == '/' && j > i + 1 {
                    let pattern: String = chars[i + 1..j].iter().collect();
                    let mut k = j + 1;
                    while k < chars.len() && chars[k].is_ascii_alphabetic() {
                        k += 1;
                    }
                    let flags: String = chars[j + 1..k].iter().collect();
                    let ph = self.placeholder("regex", &pattern);
                    out.push_str(&format!("{{\"$regularExpression\":{{\"pattern\":\"{ph}\",\"options\":\"{flags}\"}}}}"));
                    i = k;
                    continue;
                }
            }
            if c == '"' || c == '\'' || (blanket && c == '`') {
                let mut j = i + 1;
                let mut esc = false;
                while j < chars.len() {
                    if esc {
                        esc = false;
                    } else if chars[j] == '\\' {
                        esc = true;
                    } else if chars[j] == c {
                        break;
                    }
                    j += 1;
                }
                if j >= chars.len() {
                    out.extend(&chars[i..]);
                    break;
                }
                let inner = unescape(&chars[i + 1..j].iter().collect::<String>());
                let mut k = j + 1;
                while k < chars.len() && chars[k].is_whitespace() {
                    k += 1;
                }
                let is_key = chars.get(k) == Some(&':');
                let is_operator = inner.starts_with('$');
                let repl = if is_key || is_operator || inner.is_empty() || inner.starts_with('<') {
                    None
                } else if blanket {
                    let kind = if is_iso_date(&inner) { "date" } else if inner.len() == 24 && inner.bytes().all(|b| b.is_ascii_hexdigit()) { "objectid" } else if inner.contains('@') && inner.contains('.') { "email" } else { "string" };
                    Some(self.placeholder(kind, &inner))
                } else {
                    self.classify_core(inner.trim()).filter(|_| !is_iso_date(&inner))
                };
                match repl {
                    Some(p) => {
                        out.push(c);
                        out.push_str(&p);
                        out.push(c);
                    }
                    None => out.extend(&chars[i..=j]),
                }
                i = j + 1;
                continue;
            }
            if c.is_ascii_digit() {
                let mut j = i;
                while j < chars.len() && chars[j].is_ascii_digit() {
                    j += 1;
                }
                let prev_word = i > 0 && is_word(chars[i - 1]);
                if j - i >= 6 && !prev_word && !chars.get(j).is_some_and(|n| is_word(*n) || *n == '.') {
                    let s: String = chars[i..j].iter().collect();
                    out.push_str(&format!("\"{}\"", self.placeholder("number", &s)));
                } else {
                    out.extend(&chars[i..j]);
                }
                i = j;
                continue;
            }
            out.push(c);
            i += 1;
        }
        out
    }

    /// Put placeholders back into text that goes to the user (not to the model).
    pub fn unmask(&self, text: &str) -> String {
        self.unmask_with(text, |s| s.to_string())
    }

    /// Same for query text: the original is escaped so it stays inside a JSON / shell string.
    pub fn unmask_query(&self, text: &str) -> String {
        // a digit run that was a bare number in the query comes back as a number, not as a quoted string
        let mut text = text.to_string();
        for (p, o) in &self.kept {
            if p.starts_with("<number") && !o.is_empty() && o.bytes().all(|b| b.is_ascii_digit()) {
                text = text.replace(&format!("\"{p}\""), o);
            }
        }
        self.unmask_with(&text, |s| s.replace('\\', "\\\\").replace('"', "\\\""))
    }

    fn unmask_with(&self, text: &str, esc: impl Fn(&str) -> String) -> String {
        let mut order: Vec<&(String, String)> = self.kept.iter().collect();
        order.sort_by_key(|(p, _)| std::cmp::Reverse(p.len()));
        let mut out = text.to_string();
        for (p, o) in order {
            out = out.replace(p.as_str(), &esc(o));
        }
        out
    }

    /// The reverse: any known original that shows up in text bound for the model (a validator message, the model's own
    /// draft after unmasking, a server error) goes back to its placeholder.
    pub fn remask(&self, text: &str) -> String {
        let mut order: Vec<&(String, String)> = self.kept.iter().collect();
        order.sort_by_key(|(_, o)| std::cmp::Reverse(o.len()));
        let mut out = text.to_string();
        for (p, o) in order {
            if !o.is_empty() {
                out = out.replace(o.as_str(), p);
                let esc = o.replace('\\', "\\\\").replace('"', "\\\"");
                if esc != *o {
                    out = out.replace(&esc, p);
                }
            }
        }
        out
    }
}

/// M0-compatible wrapper: masked text and the (placeholder, original) pairs.
pub fn mask_question(q: &str) -> (String, Vec<(String, String)>) {
    let mut m = Masker::new();
    let t = m.mask_question(q);
    (t, m.kept)
}

/// Basic JSON / shell string escapes, so the stored original is the text and `unmask_query` can escape it once.
fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            match it.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(o) => out.push(o),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn split_punct(word: &str) -> (&str, &str, &str) {
    let is_p = |c: char| !c.is_alphanumeric() && !matches!(c, '@' | '+' | '(' | '-' | '_' | '<');
    let start = word.find(|c: char| !is_p(c)).unwrap_or(word.len());
    let rest = &word[start..];
    let end_rel = rest.rfind(|c: char| !(is_p(c) && c != ')') ).map_or(0, |k| k + rest[k..].chars().next().map_or(1, char::len_utf8));
    (&word[..start], &rest[..end_rel], &rest[end_rel..])
}

fn digitish(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '/' | '(' | ')')) && s.chars().any(|c| c.is_ascii_digit())
}
fn count_digits(s: &str) -> usize {
    s.chars().filter(char::is_ascii_digit).count()
}
fn phone_start(s: &str) -> bool {
    s.starts_with('+') || s.starts_with('(') || s.starts_with("06") || s.starts_with("00") || s.contains('-') || s.contains('/')
}
fn looks_iban(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 15 && b.len() <= 34 && b[0].is_ascii_uppercase() && b[1].is_ascii_uppercase() && b[2].is_ascii_digit() && b[3].is_ascii_digit() && b.iter().all(u8::is_ascii_alphanumeric)
}
pub(crate) fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 10 && b[4] == b'-' && b[7] == b'-' && b[..4].iter().all(u8::is_ascii_digit) && b[5..7].iter().all(u8::is_ascii_digit) && b[8..10].iter().all(u8::is_ascii_digit)
}

// ---- names ----------------------------------------------------------------------------------------------------------

/// Lower-case and strip Hungarian (and common Latin) accents.
pub fn fold(s: &str) -> String {
    s.chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'ö' | 'ő' => 'o',
            'ú' | 'ù' | 'û' | 'ü' | 'ű' => 'u',
            other => other,
        })
        .collect()
}

/// `vevoNev`, `szamla_sorszam`, `Address` to folded words.
fn words(seg: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for c in seg.chars() {
        if !c.is_alphanumeric() {
            if !cur.is_empty() {
                out.push(fold(&cur));
                cur.clear();
            }
            prev_lower = false;
            continue;
        }
        if c.is_uppercase() && prev_lower && !cur.is_empty() {
            out.push(fold(&cur));
            cur.clear();
        }
        prev_lower = c.is_lowercase() || c.is_ascii_digit();
        cur.push(c);
    }
    if !cur.is_empty() {
        out.push(fold(&cur));
    }
    out
}

const CREDENTIAL_LONG: &[&str] = &["password", "passwd", "jelszo", "secret", "token", "apikey", "titok", "privatekey"];
const CREDENTIAL_SHORT: &[&str] = &["pin", "salt", "hash", "pass", "pwd"];
const PII_LONG: &[&str] = &["email", "phone", "telefon", "mobil", "address", "lakcim", "szuletes", "birth", "anyja", "adoszam", "adoazonosito", "bankszamla", "szamla", "firstname", "lastname", "fullname", "surname", "vezeteknev", "keresztnev", "iban", "passport", "szemelyi"];
const PII_SHORT: &[&str] = &["nev", "cim", "tel", "tax", "taj", "ssn"];

fn has_stem(seg: &str, long: &[&str], short: &[&str], suffix_ok: &[&str]) -> bool {
    let f = fold(seg).replace(['_', '-', ' ', '.'], "");
    if long.iter().any(|s| f.contains(s)) {
        return true;
    }
    let ws = words(seg);
    ws.iter().any(|w| short.iter().any(|s| w == s || (suffix_ok.contains(s) && w.len() > s.len() + 1 && w.ends_with(s))))
}

/// Credential-like name (password, token, secret, hash, pin, ...): excluded from the schema in **every** mode.
pub fn is_credential_name(seg: &str) -> bool {
    has_stem(seg, CREDENTIAL_LONG, CREDENTIAL_SHORT, &["hash"])
}

/// PII-like name, Hungarian stems with and without accents: replaced by `<pii-field-N>` in P1 on production-level connections.
pub fn is_pii_name(seg: &str) -> bool {
    has_stem(seg, PII_LONG, PII_SHORT, &["nev", "cim"])
}

/// Identifier rule for anything that becomes part of the prompt.
pub fn is_safe_name(seg: &str) -> bool {
    !seg.is_empty() && seg.len() <= 64 && seg.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '-'))
}

fn replace_bounded(text: &str, needle: &str, with: &str) -> String {
    if needle.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(k) = rest.find(needle) {
        let before = rest[..k].chars().next_back();
        let after = rest[k + needle.len()..].chars().next();
        let ident = |c: char| c.is_alphanumeric() || c == '_';
        out.push_str(&rest[..k]);
        if before.is_some_and(ident) || after.is_some_and(ident) {
            out.push_str(needle);
        } else {
            out.push_str(with);
        }
        rest = &rest[k + needle.len()..];
    }
    out.push_str(rest);
    out
}

/// Original names <-> placeholders for one request.
#[derive(Debug, Clone, Default)]
pub struct NameMap {
    to_ph: BTreeMap<String, String>,
    from_ph: BTreeMap<String, String>,
    pii: usize,
    odd: usize,
}

impl NameMap {
    pub fn apply(&mut self, seg: &str, pii_mode: bool) -> String {
        if let Some(p) = self.to_ph.get(seg) {
            return p.clone();
        }
        if seg == crate::digest::DYNAMIC_KEY {
            return seg.to_string();
        }
        let ph = if !is_safe_name(seg) {
            self.odd += 1;
            format!("<odd-name-{}>", self.odd)
        } else if pii_mode && is_pii_name(seg) {
            self.pii += 1;
            format!("<pii-field-{}>", self.pii)
        } else {
            return seg.to_string();
        };
        self.to_ph.insert(seg.to_string(), ph.clone());
        self.from_ph.insert(ph.clone(), seg.to_string());
        ph
    }
    pub fn replaced(&self) -> usize {
        self.from_ph.len()
    }
    /// Originals for placeholders found in `text` (query text: escaped for JSON).
    pub fn restore_query(&self, text: &str) -> String {
        let mut out = text.to_string();
        for (ph, orig) in &self.from_ph {
            out = out.replace(ph.as_str(), &orig.replace('\\', "\\\\").replace('"', "\\\""));
        }
        out
    }
    pub fn restore(&self, text: &str) -> String {
        let mut out = text.to_string();
        for (ph, orig) in &self.from_ph {
            out = out.replace(ph.as_str(), orig);
        }
        out
    }
    /// Text bound for the model: originals back to placeholders (for example in validator hints). Only whole names
    /// are replaced (neighbours must not be letters, digits or underscores).
    pub fn hide(&self, text: &str) -> String {
        let mut out = text.to_string();
        for (orig, ph) in &self.to_ph {
            out = replace_bounded(&out, orig, ph);
        }
        out
    }
    pub fn placeholder_of(&self, orig: &str) -> Option<&str> {
        self.to_ph.get(orig).map(String::as_str)
    }
}

#[derive(Debug, Clone, Default)]
pub struct SchemaView {
    pub digest: Digest,
    pub collections: Vec<String>,
    pub names: NameMap,
    /// Names that stay visible in the prompt and could still be business- or PII-sensitive (for the preview).
    pub kept_names: Vec<String>,
    pub excluded: Vec<String>,
}

impl SchemaView {
    /// Text bound for the model: a credential-like or denied field path (and its last segment) that a validator message
    /// names is replaced, so no hint can reveal an excluded field.
    pub fn scrub_excluded(&self, text: &str) -> String {
        let mut out = text.to_string();
        for e in &self.excluded {
            out = replace_bounded(&out, e, "<excluded-field>");
            if let Some(last) = e.rsplit('.').next().filter(|l| is_credential_name(l)) {
                out = replace_bounded(&out, last, "<excluded-field>");
            }
        }
        out
    }
}

/// The digest as the model may see it: credential-like and denied fields removed in every mode, odd names and (P1 on
/// production-level connections) PII-like names replaced by placeholders.
pub fn sanitize_schema(d: &Digest, collections: &[String], policy: &AiPolicy) -> SchemaView {
    let deny: BTreeSet<String> = policy.deny_fields.iter().map(|s| fold(s)).collect();
    let pii_mode = policy.production_level();
    let mut names = NameMap::default();
    let mut excluded: BTreeSet<String> = BTreeSet::new();
    let mut fields = Vec::new();
    for f in &d.fields {
        let segs: Vec<&str> = f.path.split('.').collect();
        if segs.iter().any(|s| is_credential_name(s) || deny.contains(&fold(s))) {
            excluded.insert(f.path.clone());
            continue;
        }
        let mut nf = f.clone();
        nf.path = segs.iter().map(|s| names.apply(s, pii_mode)).collect::<Vec<_>>().join(".");
        // enum VALUES never reach the prompt in P1: drop the value sets so no renderer can leak them. P1Enum keeps a
        // short, filtered set for fields that are not PII-named.
        if nf.is_enum_like(d.sampled) {
            nf.enum_values = nf.strings.len();
        }
        let keep_values = policy.with_enums() && nf.is_enum_like(d.sampled) && !segs.iter().any(|s| is_pii_name(s) || !is_safe_name(s) || person_like(s)) && enum_values_ok(&nf.strings);
        if !keep_values {
            nf.strings.clear();
        }
        fields.push(nf);
    }
    let cols: Vec<String> = collections.iter().map(|c| names.apply(c, false)).collect();
    let coll = names.apply(&d.collection, false);
    let indexes = d.indexes.iter().filter_map(|ix| sanitize_index(ix, &deny, pii_mode, &mut names)).collect();
    let digest = Digest { collection: coll, sampled: d.sampled, estimated: d.estimated, fields, indexes };
    let mut kept: BTreeSet<String> = BTreeSet::new();
    for f in &digest.fields {
        for s in f.path.split('.') {
            if !s.starts_with('<') {
                kept.insert(s.to_string());
            }
        }
    }
    SchemaView { digest, collections: cols, names, kept_names: kept.into_iter().collect(), excluded: excluded.into_iter().collect() }
}

/// Fields that usually hold names of people, even without a PII stem ("customerName", "owner"): their values are never listed.
fn person_like(seg: &str) -> bool {
    let f = fold(seg);
    ["name", "nev", "user", "customer", "vendeg", "ugyfel", "owner", "author", "guest", "person", "employee", "dolgozo", "client", "waiter", "pincer"].iter().any(|s| f.contains(s))
}

/// At most this many distinct values, each short and made of plain characters (no e-mail, number run, id or date).
const ENUM_SHOW_MAX: usize = 12;

fn enum_values_ok(values: &BTreeSet<String>) -> bool {
    !values.is_empty()
        && values.len() <= ENUM_SHOW_MAX
        && values.iter().all(|v| {
            !v.is_empty()
                && v.chars().count() <= 32
                && v.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | ' ' | '.' | '/' | '+'))
                && v.chars().filter(char::is_ascii_digit).count() < 6
                && !(v.len() == 24 && v.bytes().all(|b| b.is_ascii_hexdigit()))
                && !is_iso_date(v)
        })
}

/// One index key pattern (`{"a":1,"b.c":-1}` as JSON text) as the model may see it: dropped when any field name is
/// credential-like, denied or odd, or any direction is not a plain 1, -1 or a known index type; PII-like names are
/// replaced like in the schema. Sampled or not, the same name rules apply.
fn sanitize_index(text: &str, deny: &BTreeSet<String>, pii_mode: bool, names: &mut NameMap) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let m = v.as_object()?;
    let mut parts = Vec::new();
    for (k, dir) in m {
        let ok_dir = match dir {
            serde_json::Value::Number(_) => true,
            serde_json::Value::String(s) => matches!(s.as_str(), "text" | "hashed" | "2d" | "2dsphere"),
            _ => false,
        };
        let segs: Vec<&str> = k.split('.').collect();
        let fts = matches!(k.as_str(), "_fts" | "_ftsx");
        if !ok_dir || (!fts && segs.iter().any(|s| is_credential_name(s) || deny.contains(&fold(s)) || !is_safe_name(s))) {
            return None;
        }
        let shown = segs.iter().map(|s| names.apply(s, pii_mode)).collect::<Vec<_>>().join(".");
        parts.push(format!("\"{shown}\":{dir}"));
    }
    (!parts.is_empty()).then(|| format!("{{{}}}", parts.join(",")))
}

/// Top field names of other collections for the prompt: same rules and the same placeholder numbering as the main view.
pub fn sanitize_top_fields(view: &mut SchemaView, tops: &BTreeMap<String, Vec<String>>, policy: &AiPolicy) -> BTreeMap<String, Vec<String>> {
    let deny: BTreeSet<String> = policy.deny_fields.iter().map(|s| fold(s)).collect();
    let pii_mode = policy.production_level();
    let mut out = BTreeMap::new();
    for (coll, fields) in tops {
        let fields: Vec<String> = fields.iter().filter(|f| !f.split('.').any(|s| is_credential_name(s) || deny.contains(&fold(s)))).map(|f| view.names.apply(f, pii_mode)).collect();
        out.insert(view.names.apply(coll, false), fields);
    }
    out
}
