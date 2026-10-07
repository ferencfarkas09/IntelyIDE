//! The secret masker: every command line the Run panel displays and every log line it keeps or sends goes through
//! [`mask`] first. Hand-rolled scanner (no regex dependency); all patterns are ASCII, so every cut is on a char boundary.
//!
//! Masked: GitHub / GitLab / Slack / OpenAI / Google / npm / AWS key shapes, JWTs, `user:pass@` in URLs, long hex
//! strings, `Bearer` tokens, `Authorization:` / `Cookie:` header values, and the value of any `KEY=value`, `"key": "value"`
//! or `--flag value` whose key names a secret (token, secret, password, auth, credential, ...). `$VAR` references are not
//! secrets and stay readable.
//!
//! Evasions covered: ANSI escapes, zero-width characters and backspaces inside a token (the line is scanned in its
//! canonical form; a line that holds a secret then loses its colours), `KEY = value` with spaces around `=`, and a
//! base64 string that decodes to something this masker would mask. Not covered: other encodings (hex of a token,
//! rot13, split across lines), and a token the process prints in pieces with more than the manager's hold time
//! between them.

pub const MASK: &str = "***";

const SECRET_KEYS: [&str; 12] = [
    "token", "secret", "password", "passwd", "pwd", "apikey", "api_key", "api-key", "auth", "credential", "private_key", "access_key",
];

/// Prefix, minimum length of the rest.
const PREFIXED: [(&str, usize); 13] = [
    ("github_pat_", 20),
    ("ghp_", 20),
    ("gho_", 20),
    ("ghu_", 20),
    ("ghs_", 20),
    ("ghr_", 20),
    ("glpat-", 16),
    ("xox", 10),
    ("sk-", 20),
    ("AIza", 30),
    ("npm_", 30),
    ("sk_live_", 16),
    ("rk_live_", 16),
];

fn is_tok(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn apply(s: &str, mut ranges: Vec<(usize, usize)>) -> String {
    if ranges.is_empty() {
        return s.to_string();
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

/// Masks every secret shape in `text`. Idempotent; text without a secret comes back unchanged.
pub fn mask(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    if !text.bytes().any(|b| b == 0x1b || b == 0x08) && !text.chars().any(is_invisible) {
        return mask_plain(text);
    }
    // Escapes, zero-width characters and backspaces can hide a token from the scanners: look at the canonical views.
    // A view that holds a secret is what comes back (decoration lost); otherwise the line is kept as it was.
    for view in [strip_decoration(text, false), strip_decoration(text, true)] {
        let masked = mask_plain(&view);
        if masked != view {
            return masked;
        }
    }
    mask_plain(text)
}

fn is_invisible(c: char) -> bool {
    matches!(c, '\u{200b}'..='\u{200f}' | '\u{2060}'..='\u{2064}' | '\u{feff}' | '\u{00ad}' | '\u{202a}'..='\u{202e}')
}

/// `text` without ANSI escape sequences and invisible characters; a backspace is dropped, with the character before
/// it when `erase` is set (what a terminal would show).
fn strip_decoration(text: &str, erase: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut it = text.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\u{1b}' => match it.next() {
                Some('[') => {
                    while it.next_if(|n| matches!(n, '\u{30}'..='\u{3f}' | '\u{20}'..='\u{2f}')).is_some() {}
                    it.next_if(|n| matches!(n, '\u{40}'..='\u{7e}'));
                }
                Some(']') => {
                    while let Some(n) = it.next() {
                        if n == '\u{7}' || (n == '\u{1b}' && it.next_if_eq(&'\\').is_some()) {
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\u{8}' => {
                if erase {
                    out.pop();
                }
            }
            c if is_invisible(c) => {}
            c => out.push(c),
        }
    }
    out
}

fn mask_plain(text: &str) -> String {
    let s = apply(text, header_values(text));
    let s = apply(&s, url_credentials(&s));
    let s = apply(&s, prefixed_tokens(&s));
    let s = apply(&s, jwts(&s));
    let s = apply(&s, bearer(&s));
    let s = apply(&s, assignments(&s));
    let s = apply(&s, base64_runs(&s));
    apply(&s, hex_runs(&s))
}

/// Whether `text` still holds anything [`mask`] would change.
pub fn is_clean(text: &str) -> bool {
    mask(text) == text
}

fn eq_ci(hay: &[u8], at: usize, needle: &str) -> bool {
    hay.len() >= at + needle.len() && hay[at..at + needle.len()].eq_ignore_ascii_case(needle.as_bytes())
}

/// `Authorization: ...`, `Cookie: ...`, `Set-Cookie: ...`, `Proxy-Authorization: ...`: the rest of the line.
fn header_values(s: &str) -> Vec<(usize, usize)> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    for name in ["authorization:", "cookie:", "x-api-key:", "x-auth-token:"] {
        let mut i = 0;
        while i + name.len() <= b.len() {
            if eq_ci(b, i, name) && (i == 0 || !is_word(b[i - 1])) {
                let mut start = i + name.len();
                while start < b.len() && b[start] == b' ' {
                    start += 1;
                }
                let end = b[start..].iter().position(|c| *c == b'\n' || *c == b'\r').map_or(b.len(), |p| start + p);
                if end > start {
                    out.push((start, end));
                }
                i = end.max(i + 1);
            } else {
                i += 1;
            }
        }
    }
    out
}

/// `scheme://user:pass@host`: the userinfo part.
fn url_credentials(s: &str) -> Vec<(usize, usize)> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(p) = s[i..].find("://") {
        let start = i + p + 3;
        let end = b[start..]
            .iter()
            .position(|c| matches!(c, b'/' | b'?' | b'#' | b' ' | b'\t' | b'"' | b'\'' | b'<' | b'>' | b')' | b'\n' | b'\r'))
            .map_or(b.len(), |p| start + p);
        if let Some(at) = s[start..end].rfind('@').map(|a| start + a) {
            if at > start && &s[start..at] != MASK {
                out.push((start, at));
            }
        }
        i = end.max(start);
    }
    out
}

fn prefixed_tokens(s: &str) -> Vec<(usize, usize)> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if i > 0 && is_word(b[i - 1]) {
            i += 1;
            continue;
        }
        let mut hit = None;
        for (prefix, min) in PREFIXED {
            if b[i..].starts_with(prefix.as_bytes()) {
                let run = b[i + prefix.len()..].iter().take_while(|c| is_tok(**c)).count();
                if run >= min {
                    hit = Some(i + prefix.len() + run);
                    break;
                }
            }
        }
        // AWS access key ids: AKIA / ASIA + 16 upper-case alphanumerics.
        if hit.is_none() && (b[i..].starts_with(b"AKIA") || b[i..].starts_with(b"ASIA")) {
            let run = b[i + 4..].iter().take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit()).count();
            if run >= 16 {
                hit = Some(i + 4 + run);
            }
        }
        match hit {
            Some(mut end) => {
                while end > i && b[end - 1] == b'.' {
                    end -= 1;
                }
                out.push((i, end));
                i = end.max(i + 1);
            }
            None => i += 1,
        }
    }
    out
}

/// `eyJ...` with at least two dots (header.payload.signature).
fn jwts(s: &str) -> Vec<(usize, usize)> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(p) = s[i..].find("eyJ") {
        let at = i + p;
        let run = b[at..].iter().take_while(|c| is_tok(**c)).count();
        let mut end = at + run;
        while end > at && b[end - 1] == b'.' {
            end -= 1;
        }
        let dots = b[at..end].iter().filter(|c| **c == b'.').count();
        if (at == 0 || !is_word(b[at - 1])) && dots >= 2 && end - at >= 20 {
            out.push((at, end));
            i = end;
        } else {
            i = at + 3;
        }
    }
    out
}

fn bearer(s: &str) -> Vec<(usize, usize)> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 7 <= b.len() {
        if eq_ci(b, i, "bearer ") && (i == 0 || !is_word(b[i - 1])) {
            let start = i + 7;
            let run = b[start..].iter().take_while(|c| is_tok(**c) || matches!(c, b'+' | b'/' | b'=')).count();
            if run >= 8 {
                out.push((start, start + run));
            }
            i = start + run.max(1);
        } else {
            i += 1;
        }
    }
    out
}

fn secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    SECRET_KEYS.iter().any(|s| k.contains(s))
}

/// `KEY=value`, `"key": "value"` and `--flag value`, where the key names a secret.
fn assignments(s: &str) -> Vec<(usize, usize)> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    for (i, &c) in b.iter().enumerate() {
        match c {
            b'=' => {
                let kstart = b[..i].iter().rposition(|c| !is_tok(*c)).map_or(0, |p| p + 1);
                if kstart < i && secret_key(&s[kstart..i]) {
                    let value = i + 1 + b[i + 1..].iter().take_while(|c| **c == b' ' || **c == b'\t').count();
                    if let Some(r) = value_range(b, value) {
                        out.push(r);
                    }
                } else if let Some((key, value)) = spaced_assignment(b, i) {
                    if secret_key(&s[key.0..key.1]) {
                        if let Some(r) = value_range(b, value) {
                            out.push(r);
                        }
                    }
                }
            }
            b':' if i >= 2 && b[i - 1] == b'"' => {
                let kend = i - 1;
                let kstart = b[..kend].iter().rposition(|c| *c == b'"').map_or(0, |p| p + 1);
                if kstart < kend && secret_key(&s[kstart..kend]) {
                    let mut v = i + 1;
                    while v < b.len() && b[v] == b' ' {
                        v += 1;
                    }
                    if v < b.len() && b[v] == b'"' {
                        if let Some(r) = value_range(b, v) {
                            out.push(r);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    // `--token abc`: a secret-named flag without `=` masks the next argument.
    let mut i = 0;
    while i + 2 < b.len() {
        if b[i] == b'-' && b[i + 1] == b'-' && (i == 0 || b[i - 1] == b' ') {
            let end = b[i..].iter().position(|c| !is_tok(*c)).map_or(b.len(), |p| i + p);
            if end < b.len() && b[end] == b' ' && secret_key(&s[i + 2..end]) {
                if let Some(r) = value_range(b, end + 1) {
                    out.push(r);
                }
            }
            i = end.max(i + 2);
        } else {
            i += 1;
        }
    }
    out
}

/// `KEY = value`: the key range and the value start for the `=` at `eq`, when the `=` is a lone one with blanks on
/// both sides (`==`, `=>`, `!=` and the like are not assignments).
fn spaced_assignment(b: &[u8], eq: usize) -> Option<((usize, usize), usize)> {
    if b.get(eq + 1).is_some_and(|c| matches!(c, b'=' | b'>' | b'~')) || (eq > 0 && matches!(b[eq - 1], b'=' | b'!' | b'<' | b'>')) {
        return None;
    }
    let kend = b[..eq].iter().rposition(|c| *c != b' ' && *c != b'\t').map_or(0, |p| p + 1);
    let vstart = eq + 1 + b[eq + 1..].iter().take_while(|c| **c == b' ' || **c == b'\t').count();
    if kend == eq && vstart == eq + 1 {
        return None;
    }
    let kstart = b[..kend].iter().rposition(|c| !is_tok(*c)).map_or(0, |p| p + 1);
    (kstart < kend && vstart < b.len()).then_some(((kstart, kend), vstart))
}

/// The value starting at `at` (an opening quote makes it run to the closing one); `None` for an empty value, a `$VAR`
/// reference or something already masked.
fn value_range(b: &[u8], at: usize) -> Option<(usize, usize)> {
    let mut start = at;
    let quote = b.get(start).copied().filter(|c| matches!(c, b'"' | b'\''));
    if quote.is_some() {
        start += 1;
    }
    let end = match quote {
        Some(q) => b[start..].iter().position(|c| *c == q).map_or(b.len(), |p| start + p),
        None => b[start..]
            .iter()
            .position(|c| c.is_ascii_whitespace() || matches!(c, b'&' | b';' | b'|' | b'"' | b'\'' | b','))
            .map_or(b.len(), |p| start + p),
    };
    let value = &b[start..end];
    if value.is_empty() || value[0] == b'$' || value == MASK.as_bytes() || value.starts_with(b"%") {
        return None;
    }
    Some((start, end))
}

/// Standard or URL-safe base64 (padding optional) of at least 24 characters that decodes to UTF-8 text this masker
/// would change: `Authorization: Basic ...` style wrappers, encoded env files and the like.
fn base64_runs(s: &str) -> Vec<(usize, usize)> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_alphanumeric() {
            let run = b[i..].iter().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'-' | b'_')).count();
            let pad = b[i + run..].iter().take_while(|c| **c == b'=').count().min(2);
            if run >= 24 {
                if let Some(text) = decode_base64(&b[i..i + run]) {
                    if mask_plain(&text) != text {
                        out.push((i, i + run + pad));
                    }
                }
            }
            i += run + pad;
        } else {
            i += 1;
        }
    }
    out
}

fn decode_base64(src: &[u8]) -> Option<String> {
    let mut bytes = Vec::with_capacity(src.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in src {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    String::from_utf8(bytes).ok()
}

/// Maximal runs of 32 or more hex digits that are a whole word.
fn hex_runs(s: &str) -> Vec<(usize, usize)> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_alphanumeric() {
            let run = b[i..].iter().take_while(|c| c.is_ascii_alphanumeric()).count();
            if run >= 32 && b[i..i + run].iter().all(u8::is_ascii_hexdigit) {
                out.push((i, i + run));
            }
            i += run;
        } else {
            i += 1;
        }
    }
    out
}

/// Replaces the value of every inline `NAME=value` assignment (upper-case names) with `…`: the Run panel shows env var
/// names, never values.
pub fn redact_env_values(text: &str) -> String {
    let b = text.as_bytes();
    let mut ranges = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let boundary = i == 0 || b[i - 1].is_ascii_whitespace() || matches!(b[i - 1], b'&' | b';' | b'(' | b'|' | b'"' | b'\'');
        if boundary && (b[i].is_ascii_uppercase() || b[i] == b'_') {
            let n = b[i..].iter().take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || **c == b'_').count();
            if n >= 2 && b.get(i + n) == Some(&b'=') {
                let mut start = i + n + 1;
                let quote = b.get(start).copied().filter(|c| matches!(c, b'"' | b'\''));
                if quote.is_some() {
                    start += 1;
                }
                let end = match quote {
                    Some(q) => b[start..].iter().position(|c| *c == q).map_or(b.len(), |p| start + p),
                    None => b[start..].iter().position(|c| c.is_ascii_whitespace() || matches!(c, b'&' | b';' | b'|' | b')')).map_or(b.len(), |p| start + p),
                };
                if end > start {
                    ranges.push((start, end));
                }
                i = end.max(i + n + 1);
                continue;
            }
            i += n.max(1);
            continue;
        }
        i += 1;
    }
    if ranges.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for (a, e) in ranges {
        out.push_str(&text[at..a]);
        out.push('…');
        at = e;
    }
    out.push_str(&text[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Built at run time so no source file or fixture holds a token-shaped literal.
    fn gh() -> String {
        format!("{}{}", "ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")
    }

    #[test]
    fn github_tokens_in_every_position() {
        let t = gh();
        for line in [format!("set GH_TOKEN={t} && set GH_TOKEN={t}"), format!("curl -H x {t}"), format!("{t}"), format!("token:{t}.")] {
            let m = mask(&line);
            assert!(!m.contains(&t[4..]), "{line} -> {m}");
            assert!(m.contains(MASK));
        }
        let pat = format!("{}{}", "github_pat_", "11ABCDEFG0abcdefghijklmnopqrstuvwxyz_1234567890");
        assert!(!mask(&format!("x {pat} y")).contains("11ABCDEFG"));
    }

    #[test]
    fn aws_jwt_bearer_and_hex() {
        let aws = format!("{}{}", "AKIA", "IOSFODNN7EXAMPLE");
        assert_eq!(mask(&format!("key {aws}!")), "key ***!");
        let jwt = format!("{}{}", "eyJhbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc-def_123");
        assert_eq!(mask(&format!("t={jwt}")), "t=***");
        assert_eq!(mask("Authorization: Bearer abcdef123456"), "Authorization: ***");
        assert_eq!(mask("use Bearer abcdef123456 here"), "use Bearer *** here");
        let hex = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(mask(&format!("sha {hex}.")), "sha ***.");
        assert_eq!(mask("short deadbeef stays"), "short deadbeef stays");
    }

    #[test]
    fn url_credentials_and_query_secrets() {
        assert_eq!(mask("git clone https://bob:hunter2@example.com/r.git"), "git clone https://***@example.com/r.git");
        assert_eq!(mask("https://example.com/a?token=abc123&x=1"), "https://example.com/a?token=***&x=1");
        assert_eq!(mask("mongodb://u:p@h:27017/db"), "mongodb://***@h:27017/db");
        assert_eq!(mask("https://example.com:8080/path"), "https://example.com:8080/path");
    }

    #[test]
    fn secret_named_keys_and_flags() {
        assert_eq!(mask("API_KEY=abc DB_PASSWORD='p w' node x.js"), "API_KEY=*** DB_PASSWORD='***' node x.js");
        assert_eq!(mask(r#"{"password": "hunter2", "name": "bob"}"#), r#"{"password": "***", "name": "bob"}"#);
        assert_eq!(mask("tool --token abc123 --verbose"), "tool --token *** --verbose");
        assert_eq!(mask("tool --api-key=abc123"), "tool --api-key=***");
        assert_eq!(mask("npx tunnel --user $LT_USERNAME --key $LT_ACCESS_KEY"), "npx tunnel --user $LT_USERNAME --key $LT_ACCESS_KEY");
        assert_eq!(mask("SECRET_TOKEN=$HOME_TOKEN run"), "SECRET_TOKEN=$HOME_TOKEN run");
    }

    #[test]
    fn plain_text_is_untouched_and_masking_is_idempotent() {
        let plain = "Compiled successfully in 4.2s. Local: http://localhost:8082/ ünïcödé árvíztűrő tükörfúrógép";
        assert_eq!(mask(plain), plain);
        let t = gh();
        let once = mask(&format!("a {t} b"));
        assert_eq!(mask(&once), once);
        assert!(is_clean(plain));
        assert!(!is_clean(&t));
    }

    #[test]
    fn env_values_are_replaced_by_an_ellipsis() {
        assert_eq!(redact_env_values("cross-env NODE_ENV=production HAPPY_X=\"a b\" webpack && E2E_URL=https://x/y run"), "cross-env NODE_ENV=… HAPPY_X=\"…\" webpack && E2E_URL=… run");
        assert_eq!(redact_env_values("no assignment here, a=b stays"), "no assignment here, a=b stays");
        assert_eq!(redact_env_values("node --max-old-space-size=4800 x.js"), "node --max-old-space-size=4800 x.js");
    }

    #[test]
    fn a_token_hidden_by_ansi_zero_width_or_backspace_characters_is_still_masked() {
        let t = gh();
        let (a, b) = t.split_at(10);
        for line in [
            format!("tok {a}\u{1b}[31m{b}\u{1b}[0m end"),
            format!("tok {a}\u{200b}{b} end"),
            format!("tok {a}\u{feff}{b}"),
            format!("tok {a}\u{8}{b} end"),
            format!("tok {a}x\u{8}{b} end"),
            format!("tok \u{1b}]8;;http://x\u{7}{t}\u{1b}]8;;\u{7}"),
        ] {
            let m = mask(&line);
            assert!(!m.contains(&b[2..]) && !m.contains(&a[4..]), "{line:?} -> {m:?}");
            assert!(m.contains(MASK));
        }
        let colored = "\u{1b}[32mCompiled\u{1b}[0m ok \u{200b}";
        assert_eq!(mask(colored), colored, "a line without a secret keeps its colours");
        assert_eq!(mask(&format!("\u{1b}[1m{t}")), "***");
    }

    #[test]
    fn assignments_with_blanks_around_the_equals_sign_are_masked() {
        assert_eq!(mask("AWS_SECRET_ACCESS_KEY = wJalrXUtnFEMI/K7MDENG"), "AWS_SECRET_ACCESS_KEY = ***");
        assert_eq!(mask("export DB_PASSWORD =  hunter2 && run"), "export DB_PASSWORD =  *** && run");
        assert_eq!(mask("password= hunter2"), "password= ***");
        assert_eq!(mask("if (token == other) a => b; tokens != x"), "if (token == other) a => b; tokens != x");
        assert_eq!(mask("width = 100 and name = bob"), "width = 100 and name = bob");
        assert_eq!(mask("token = $TOKEN_VAR"), "token = $TOKEN_VAR");
    }

    #[test]
    fn base64_of_a_secret_is_masked_and_ordinary_long_words_are_not() {
        let t = gh();
        let enc = encode_b64(format!("GH_TOKEN={t}").as_bytes());
        let m = mask(&format!("payload {enc} done"));
        assert_eq!(m, "payload *** done");
        let url_safe = enc.replace('+', "-").replace('/', "_").trim_end_matches('=').to_owned();
        assert_eq!(mask(&url_safe), "***");
        let plain = "ThisIsAVeryLongCamelCaseIdentifierWithoutAnySecretInIt /usr/local/lib/node_modules/some-package-name/dist";
        assert_eq!(mask(plain), plain);
        assert_eq!(mask(&encode_b64(b"just some ordinary text, nothing to see here")), encode_b64(b"just some ordinary text, nothing to see here"));
    }

    fn encode_b64(data: &[u8]) -> String {
        const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in data.chunks(3) {
            let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
            for k in 0..=chunk.len() {
                out.push(A[((n >> (18 - 6 * k)) & 63) as usize] as char);
            }
            out.push_str(&"=".repeat(3 - chunk.len()));
        }
        out
    }

    #[test]
    fn multibyte_text_around_secrets_keeps_its_boundaries() {
        let t = gh();
        assert_eq!(mask(&format!("árvíz {t} tűrő")), "árvíz *** tűrő");
    }
}
