//! Output masking for everything wrangler (or pnpm) prints (spec 4.3 `mask.rs`, 5.3). Applied to every line before it is stored,
//! emitted, logged or put into an error message. Idempotent: masking masked text changes nothing.
//!
//! Order: canonical form (ANSI escapes and invisible characters removed, so a secret split by colour codes is found), the intake cap,
//! the exact values of every secret the run was given, `intely_runner::mask`, Cloudflare token prefixes, token shapes after `token`
//! / `Bearer` / `CLOUDFLARE_API_TOKEN`, OAuth-style query values, and e-mail addresses.

use intely_relay_bundle::Secret;

pub const MASK: &str = "***";
/// A masked line is cut to this length (the rest is dropped) AFTER masking, so a secret straddling the cut cannot leak its prefix.
pub const MAX_LINE_BYTES: usize = 8 * 1024;
/// A longer raw line is cut before any scanning, so a hostile child cannot make the masker slow. Far above any secret's length.
pub const MAX_INTAKE_BYTES: usize = 64 * 1024;
/// Secrets shorter than this are not registered for exact replacement (a one-letter value would shred every line).
const MIN_EXACT: usize = 6;

const CF_PREFIXES: [&str; 3] = ["cfut_", "cfat_", "cfk_"];
const SHAPE_KEYWORDS: [&str; 3] = ["cloudflare_api_token", "bearer", "token"];
const QUERY_KEYS: [&str; 8] = ["code", "state", "token", "access_token", "refresh_token", "id_token", "client_secret", "code_verifier"];

#[derive(Clone, Default)]
pub struct Masker {
    /// Exact values (and their percent-encoded forms), longest first.
    exact: Vec<String>,
}

impl std::fmt::Debug for Masker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Masker").field("secrets", &self.exact.len()).finish()
    }
}

impl Masker {
    pub fn new(known: &[Secret]) -> Self {
        let values: Vec<&str> = known.iter().map(Secret::expose).collect();
        Self::with_values(&values)
    }

    pub fn with_values(values: &[&str]) -> Self {
        let mut exact: Vec<String> = Vec::new();
        for v in values {
            let v = v.trim();
            if v.len() < MIN_EXACT {
                continue;
            }
            // As given, and with the case folded (a tool may shout or lower-case a value it echoes).
            for form in [v.to_owned(), v.to_uppercase(), v.to_lowercase()] {
                let enc = percent_encode(&form);
                if enc != form {
                    exact.push(enc);
                }
                exact.push(form);
            }
        }
        exact.sort_by_key(|v| std::cmp::Reverse(v.len()));
        exact.dedup();
        Self { exact }
    }

    pub fn mask(&self, line: &str) -> String {
        let mut s = canonical(truncate(line, MAX_INTAKE_BYTES));
        // Exact values first: a secret that another pattern would only half-mask must not leave its other half behind.
        for v in &self.exact {
            if s.contains(v.as_str()) {
                s = s.replace(v.as_str(), MASK);
            }
        }
        s = intely_runner::mask::mask(&s);
        s = mask_cf_prefixes(&s);
        s = mask_shapes(&s);
        s = mask_query_values(&s);
        let s = mask_emails(&s);
        truncate(&s, MAX_LINE_BYTES).to_owned()
    }
}

/// `a***@e***.test`: the hint the UI shows instead of an address.
pub fn email_hint(email: &str) -> String {
    mask_emails(email.trim())
}

fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Removes ANSI escape sequences (CSI and OSC), zero-width and other control characters (tab stays a space).
fn canonical(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\u{1b}' => match it.peek().copied() {
                Some('[') => {
                    it.next();
                    for n in it.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    it.next();
                    while let Some(n) = it.next() {
                        if n == '\u{7}' {
                            break;
                        }
                        if n == '\u{1b}' {
                            it.next();
                            break;
                        }
                    }
                }
                _ => {
                    it.next();
                }
            },
            '\t' => out.push(' '),
            '\u{200b}'..='\u{200f}' | '\u{2060}' | '\u{feff}' | '\u{202a}'..='\u{202e}' => {}
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn is_tok(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')
}

fn replace_ranges(s: &str, mut ranges: Vec<(usize, usize)>) -> String {
    if ranges.is_empty() {
        return s.to_owned();
    }
    ranges.sort_unstable();
    let mut out = String::with_capacity(s.len());
    let mut at = 0;
    for (a, b) in ranges {
        if a < at {
            continue;
        }
        out.push_str(&s[at..a]);
        out.push_str(MASK);
        at = b;
    }
    out.push_str(&s[at..]);
    out
}

/// `cfut_`, `cfat_`, `cfk_` followed by 30 or more token characters.
fn mask_cf_prefixes(s: &str) -> String {
    let b = s.as_bytes();
    let mut ranges = Vec::new();
    for p in CF_PREFIXES {
        let mut from = 0;
        while let Some(i) = s[from..].find(p) {
            let start = from + i;
            let mut end = start + p.len();
            while end < b.len() && is_tok(b[end]) {
                end += 1;
            }
            if end - start - p.len() >= 30 {
                ranges.push((start, end));
            }
            from = start + p.len();
        }
    }
    replace_ranges(s, ranges)
}

/// A run of 40 or more token characters that follows `token`, `Bearer` or `CLOUDFLARE_API_TOKEN` (and separators).
fn mask_shapes(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let b = s.as_bytes();
    let mut ranges = Vec::new();
    for kw in SHAPE_KEYWORDS {
        let mut from = 0;
        while let Some(i) = lower[from..].find(kw) {
            let mut at = from + i + kw.len();
            from = at;
            while at < b.len() && matches!(b[at], b' ' | b':' | b'=' | b'"' | b'\'' | b'\\') {
                at += 1;
            }
            let start = at;
            while at < b.len() && is_tok(b[at]) {
                at += 1;
            }
            if at - start >= 40 {
                ranges.push((start, at));
            }
        }
    }
    replace_ranges(s, ranges)
}

/// `?code=...&state=...`: the value of an OAuth-style query key.
fn mask_query_values(s: &str) -> String {
    let b = s.as_bytes();
    let mut ranges = Vec::new();
    for (i, &c) in b.iter().enumerate() {
        if c != b'?' && c != b'&' {
            continue;
        }
        let rest = &s[i + 1..];
        for k in QUERY_KEYS {
            if rest.len() > k.len() && rest[..k.len()].eq_ignore_ascii_case(k) && rest.as_bytes()[k.len()] == b'=' {
                let vstart = i + 1 + k.len() + 1;
                let mut end = vstart;
                while end < b.len() && !matches!(b[end], b'&' | b' ' | b'"' | b'\'' | b'#' | b'<' | b'>') {
                    end += 1;
                }
                if end > vstart && &s[vstart..end] != MASK {
                    ranges.push((vstart, end));
                }
                break;
            }
        }
    }
    replace_ranges(s, ranges)
}

fn local_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-' | '*')
}

fn domain_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '*')
}

/// `alice@example.com` -> `a***@e***.com`. An address that already holds `***` is left alone (idempotent).
fn mask_emails(s: &str) -> String {
    let chars: Vec<(usize, char)> = s.char_indices().collect();
    let mut out = String::with_capacity(s.len());
    let mut copied = 0usize;
    let mut idx = 0usize;
    while idx < chars.len() {
        let (pos, c) = chars[idx];
        if c != '@' {
            idx += 1;
            continue;
        }
        let mut ls = idx;
        while ls > 0 && local_char(chars[ls - 1].1) {
            ls -= 1;
        }
        let mut de = idx + 1;
        while de < chars.len() && domain_char(chars[de].1) {
            de += 1;
        }
        let local_start = chars.get(ls).map(|x| x.0).unwrap_or(pos);
        let dom_start = pos + 1;
        let dom_end = chars.get(de).map(|x| x.0).unwrap_or(s.len());
        let domain = s[dom_start..dom_end].trim_end_matches('.');
        let local = &s[local_start..pos];
        if local.is_empty() || domain.is_empty() || local_start < copied || !(domain.contains('.') || domain.contains('*')) {
            idx += 1;
            continue;
        }
        let first = |t: &str| t.chars().next().map(String::from).unwrap_or_default();
        let new_local = if local.contains(MASK) { local.to_owned() } else { format!("{}{MASK}", first(local)) };
        let new_domain = if domain.contains(MASK) {
            domain.to_owned()
        } else {
            match domain.rfind('.') {
                Some(d) => format!("{}{MASK}{}", first(domain), &domain[d..]),
                None => format!("{}{MASK}", first(domain)),
            }
        };
        out.push_str(&s[copied..local_start]);
        out.push_str(&new_local);
        out.push('@');
        out.push_str(&new_domain);
        copied = dom_start + domain.len();
        idx = de.max(idx + 1);
    }
    out.push_str(&s[copied..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m() -> Masker {
        Masker::default()
    }

    #[test]
    fn cloudflare_token_prefixes() {
        let t = "cfut_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd";
        assert_eq!(m().mask(&format!("using {t} now")), "using *** now");
        assert_eq!(m().mask("cfk_short"), "cfk_short", "a short run is not a token");
        let t2 = "cfat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assert!(!m().mask(t2).contains("aaaaaaaaaa"));
    }

    #[test]
    fn exact_values_and_encoded_form() {
        let s = Secret::new("p@ss w0rd/secret+value");
        let mk = Masker::new(&[s]);
        let out = mk.mask("x p@ss w0rd/secret+value y and p%40ss%20w0rd%2Fsecret%2Bvalue z");
        assert!(!out.contains("w0rd"), "{out}");
        assert!(!out.contains("%2Fsecret"), "{out}");
        assert_eq!(Masker::new(&[Secret::new("abc")]).mask("abc stays"), "abc stays", "short values are not registered");
    }

    #[test]
    fn secret_split_by_ansi_is_found() {
        let mk = Masker::new(&[Secret::new("supersecretvalue123")]);
        let out = mk.mask("tok: super\u{1b}[31msecretvalue\u{1b}[0m123 end");
        assert!(!out.contains("secretvalue"), "{out}");
        let out = mk.mask("tok: super\u{200b}secretvalue123 end");
        assert!(!out.contains("secretvalue"), "{out}");
    }

    #[test]
    fn token_shapes_after_keywords() {
        let t = "A".repeat(40);
        assert_eq!(m().mask(&format!("CLOUDFLARE_API_TOKEN={t}")), "CLOUDFLARE_API_TOKEN=***");
        assert!(!m().mask(&format!("Authorization: Bearer {t}")).contains(&t));
        assert!(!m().mask(&format!("{{\"token\": \"{t}\"}}")).contains(&t));
    }

    #[test]
    fn oauth_query_values() {
        let out = m().mask("https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=54d11594&state=AbCd123&code_challenge=xyz&code=SECRETCODE");
        assert!(!out.contains("AbCd123") && !out.contains("SECRETCODE"), "{out}");
        assert!(out.contains("response_type=code") && out.contains("client_id=54d11594"), "{out}");
    }

    #[test]
    fn emails_become_hints() {
        assert_eq!(email_hint("ada@example.test"), "a***@e***.test");
        assert_eq!(m().mask("logged in as ada@example.test."), "logged in as a***@e***.test.");
        assert_eq!(m().mask("not an address: foo@bar"), "not an address: foo@bar");
    }

    #[test]
    fn idempotent() {
        let t = "A".repeat(40);
        let mk = Masker::new(&[Secret::new("zzzz-top-secret-9")]);
        for line in [
            format!("Bearer {t} and a@b.example.com"),
            "?code=abc&state=def user x@y.org zzzz-top-secret-9".to_owned(),
            "plain text".to_owned(),
            format!("cfut_{}", "x".repeat(40)),
        ] {
            let once = mk.mask(&line);
            assert_eq!(mk.mask(&once), once, "second pass changed {once}");
        }
    }

    #[test]
    fn long_lines_are_cut() {
        let line = "a".repeat(MAX_LINE_BYTES * 3);
        assert!(m().mask(&line).len() <= MAX_LINE_BYTES);
        let multi = "é".repeat(MAX_LINE_BYTES);
        assert!(m().mask(&multi).len() <= MAX_LINE_BYTES);
    }

    /// Regression: the cap used to cut the raw line before the exact replacement, so a secret straddling the cut leaked its prefix.
    #[test]
    fn a_secret_straddling_the_line_cap_does_not_leak() {
        let secret = "Zq9xK2mV7pL4wR8tY1uN5bC3dF6gH0jSaEoIvXzMqWk";
        let mk = Masker::with_values(&[secret]);
        for back in [1usize, 10, 25, secret.len() - 1] {
            let line = format!("{}{secret} tail", "a".repeat(MAX_LINE_BYTES - back));
            let out = mk.mask(&line);
            assert!(out.len() <= MAX_LINE_BYTES);
            assert!(!out.contains(&secret[..4]) && !out.contains(&secret[..10.min(back)]), "prefix leaked: {}", &out[out.len().saturating_sub(40)..]);
        }
    }

    #[test]
    fn upper_and_lower_cased_copies_of_a_secret_are_masked() {
        let secret = "Zq9xK2mV7pL4wR8tY1uN5bC3dF6gH0jSaEoIvXzMqWk";
        let mk = Masker::with_values(&[secret]);
        let out = mk.mask(&format!("a {} b {} c", secret.to_uppercase(), secret.to_lowercase()));
        assert_eq!(out, "a *** b *** c");
    }

    /// Property: no registered secret survives in any line it appears in, wherever it sits and however it is wrapped.
    #[test]
    fn property_no_registered_secret_survives() {
        let mut x: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let alphabet: Vec<char> = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./+=:@!#".chars().collect();
        let wrappers = ["", "\u{1b}[1m", "\u{1b}[32m", "\"", "'", "token=", "Bearer ", "?q=", "x"];
        for _ in 0..400 {
            let len = 8 + (next() % 50) as usize;
            let secret: String = (0..len).map(|_| alphabet[(next() % alphabet.len() as u64) as usize]).collect();
            let mk = Masker::with_values(&[secret.as_str()]);
            let pre = wrappers[(next() % wrappers.len() as u64) as usize];
            let post = wrappers[(next() % wrappers.len() as u64) as usize];
            // Occasionally split the secret with an escape sequence in the middle.
            let cut = 1 + (next() % (len as u64 - 1)) as usize;
            let body = if next() % 2 == 0 { secret.clone() } else { format!("{}\u{1b}[0m{}", &secret[..cut], &secret[cut..]) };
            let line = format!("{pre}{body}{post} tail {}", if next() % 2 == 0 { &secret } else { "" });
            let out = mk.mask(&line);
            assert!(!out.contains(secret.as_str()), "secret survived\n line: {line:?}\n out: {out:?}");
        }
    }
}
