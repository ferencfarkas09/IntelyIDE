//! The exact-value scrubber (MCP spec 4.6): every string that leaves the probe passes through it before `redact`. It knows the secret VALUES
//! of the record being tested (and of a staged import) and the forms a server is likely to echo them in (`derive_forms`).

const MASK: &str = "[redacted]";
const MIN_LEN: usize = 4;
const MAX_FORMS_PER_VALUE: usize = 8;

const B64_STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn b64_encode(bytes: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(alphabet[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

/// Standard or URL-safe alphabet, padding optional. `None` for anything else.
fn b64_decode(text: &str) -> Option<Vec<u8>> {
    let mut acc = 0u32;
    let mut bits = 0u32;
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    for c in text.trim_end_matches('=').bytes() {
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
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The text inside `JSON.stringify(value)`, without the quotes.
fn json_escape(text: &str) -> String {
    let quoted = serde_json::to_string(text).unwrap_or_default();
    quoted.trim_matches('"').to_owned()
}

/// A secret value and the forms a server or a library is likely to echo it in, deduplicated, each of 4 or more characters, at most 8 in
/// all (the value itself first). The same vectors are read by the sidecar's TypeScript twin (`packages/protocol/fixtures/mcp-secret-forms.json`).
pub fn derive_forms(value: &str) -> Vec<String> {
    let mut forms: Vec<String> = vec![value.to_owned()];
    let lower = value.to_ascii_lowercase();
    for scheme in ["bearer ", "basic ", "token "] {
        if lower.starts_with(scheme) {
            let rest = value[scheme.len()..].trim();
            forms.push(rest.to_owned());
            if scheme == "basic " {
                if let Some(decoded) = b64_decode(rest).and_then(|b| String::from_utf8(b).ok()).filter(|d| d.contains(':')) {
                    forms.push(decoded);
                }
            }
        }
    }
    forms.push(json_escape(value));
    forms.push(percent_encode(value));
    forms.push(b64_encode(value.as_bytes(), B64_STD, true));
    forms.push(b64_encode(value.as_bytes(), B64_URL, false));
    let mut out: Vec<String> = Vec::new();
    for f in forms {
        if f.len() >= MIN_LEN && !out.contains(&f) && out.len() < MAX_FORMS_PER_VALUE {
            out.push(f);
        }
    }
    out
}

/// Replaces every occurrence of a known secret (and its derived forms) by `[redacted]`. Values shorter than 4 characters only match when
/// the whole text equals them.
#[derive(Clone, Default)]
pub struct Scrubber {
    /// Longest first, so an overlapping shorter form never splits a longer one.
    forms: Vec<String>,
    short: Vec<String>,
}

impl std::fmt::Debug for Scrubber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Scrubber({} forms)", self.forms.len() + self.short.len())
    }
}

impl Scrubber {
    pub fn new<'a>(values: impl IntoIterator<Item = &'a str>) -> Self {
        let mut s = Self::default();
        for v in values.into_iter().filter(|v| !v.is_empty()) {
            if v.len() < MIN_LEN {
                if !s.short.iter().any(|x| x == v) {
                    s.short.push(v.to_owned());
                }
                continue;
            }
            for f in derive_forms(v) {
                if !s.forms.contains(&f) {
                    s.forms.push(f);
                }
            }
        }
        s.forms.sort_by_key(|f| std::cmp::Reverse(f.len()));
        s
    }

    pub fn is_empty(&self) -> bool {
        self.forms.is_empty() && self.short.is_empty()
    }

    pub fn scrub(&self, text: &str) -> String {
        if self.short.iter().any(|s| s == text) {
            return MASK.to_owned();
        }
        let mut out = text.to_owned();
        for f in &self.forms {
            if out.contains(f.as_str()) {
                out = out.replace(f.as_str(), MASK);
            }
        }
        out
    }

    /// The scrubber, then the pattern redactor of the settings crate (`Bearer x`, key prefixes, `name=value` of a secret-looking name).
    pub fn clean(&self, text: &str) -> String {
        intely_settings::secrets::redact(&self.scrub(text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANARY: &str = "CANARY-MCP-7f3a-env";

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(b64_encode(b"", B64_STD, true), "");
        assert_eq!(b64_encode(b"f", B64_STD, true), "Zg==");
        assert_eq!(b64_encode(b"fo", B64_STD, true), "Zm8=");
        assert_eq!(b64_encode(b"foobar", B64_STD, true), "Zm9vYmFy");
        assert_eq!(b64_encode(&[0xfb, 0xff, 0xfe], B64_STD, true), "+//+");
        assert_eq!(b64_encode(&[0xfb, 0xff, 0xfe], B64_URL, false), "-__-");
        assert_eq!(b64_decode("Zm9vYmFy").unwrap(), b"foobar");
        assert_eq!(b64_decode("Zg==").unwrap(), b"f");
        assert_eq!(b64_decode("-__-").unwrap(), vec![0xfb, 0xff, 0xfe]);
        assert!(b64_decode("a b").is_none());
    }

    #[test]
    fn derived_forms_cover_the_usual_echoes() {
        let forms = derive_forms("Bearer abc12345");
        assert!(forms.contains(&"abc12345".to_owned()), "the bare token");
        assert!(forms.contains(&"Bearer%20abc12345".to_owned()), "percent-encoded");
        assert!(forms.contains(&b64_encode(b"Bearer abc12345", B64_STD, true)));
        let basic = format!("Basic {}", b64_encode(b"alice:s3cret-pw", B64_STD, true));
        let forms = derive_forms(&basic);
        assert!(forms.contains(&"alice:s3cret-pw".to_owned()), "the decoded user:password");
        assert!(forms.contains(&b64_encode(b"alice:s3cret-pw", B64_STD, true)), "the base64 part");
        let forms = derive_forms("a\"b\\c d");
        assert!(forms.contains(&"a\\\"b\\\\c d".to_owned()), "JSON-escaped");
        assert!(!derive_forms("tok").contains(&"tok".to_owned()), "a value under 4 characters is not a form of itself");
        assert!(derive_forms(&"x".repeat(40)).len() <= MAX_FORMS_PER_VALUE);
        let forms = derive_forms("Token tokentokentoken");
        assert!(forms.contains(&"tokentokentoken".to_owned()));
    }

    #[test]
    fn the_scrubber_replaces_values_and_forms_and_only_long_ones_inside_text() {
        let s = Scrubber::new([CANARY, "Bearer secret-token-9", "ab"]);
        assert_eq!(s.scrub(&format!("failed with {CANARY} twice {CANARY}")), "failed with [redacted] twice [redacted]");
        assert_eq!(s.scrub("header: Bearer secret-token-9"), "header: [redacted]");
        assert_eq!(s.scrub("echo secret-token-9 here"), "echo [redacted] here", "the bare token of a Bearer value");
        assert_eq!(s.scrub("a cab ab"), "a cab ab", "a short value only matches the whole text");
        assert_eq!(s.scrub("ab"), "[redacted]");
        assert_eq!(s.scrub(&format!("q={}", b64_encode(CANARY.as_bytes(), B64_URL, false))), "q=[redacted]");
        let spaced = Scrubber::new(["p@ss w/ord"]);
        assert_eq!(spaced.scrub(&format!("q={}", percent_encode("p@ss w/ord"))), "q=[redacted]");
        assert_eq!(spaced.scrub("p@ss w/ord"), "[redacted]");
    }

    #[test]
    fn overlapping_values_do_not_split_each_other() {
        let s = Scrubber::new(["secretvalue", "secretvalue-long-one"]);
        assert_eq!(s.scrub("x secretvalue-long-one y"), "x [redacted] y");
    }

    #[test]
    fn clean_also_runs_the_pattern_redactor() {
        let s = Scrubber::new([CANARY]);
        assert_eq!(s.clean(&format!("{CANARY} Authorization: Bearer other.token.here")), "[redacted] Authorization: Bearer [redacted]");
        assert!(!format!("{s:?}").contains(CANARY));
    }

    #[test]
    fn the_shared_vectors_hold() {
        let text = include_str!("../../../packages/protocol/fixtures/mcp-secret-forms.json");
        let cases: Vec<serde_json::Value> = serde_json::from_str(text).expect("vectors");
        assert!(!cases.is_empty());
        for case in cases {
            let value = case["value"].as_str().unwrap();
            let want: std::collections::BTreeSet<String> = case["forms"].as_array().unwrap().iter().map(|f| f.as_str().unwrap().to_owned()).collect();
            let got: std::collections::BTreeSet<String> = derive_forms(value).into_iter().collect();
            assert_eq!(got, want, "{value}");
        }
    }
}
