//! Credential masking for everything that can reach a log, an error message or an event. The settings crate masks bearer
//! values and well-known key prefixes; this adds Happy's login JWTs (`eyJ...`), query and fragment parameters
//! (`#server=..&token=..`) and the exact token the client holds.

use intely_settings::secrets::redact as redact_common;

const MASK: &str = "[redacted]";
const PARAMS: [&str; 4] = ["token=", "jwt=", "auth=", "authorization="];

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '+' | '/' | '=')
}

fn mask_jwts(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(first) = rest.chars().next() {
        let end = if is_token_char(first) { rest.find(|c: char| !is_token_char(c)).unwrap_or(rest.len()) } else { first.len_utf8() };
        let (word, tail) = rest.split_at(end);
        let looks_jwt = word.starts_with("eyJ") && word.matches('.').count() >= 2;
        out.push_str(if looks_jwt { MASK } else { word });
        rest = tail;
    }
    out
}

/// Masks the value after `name=` up to the next `& # ' " ) <whitespace>`.
fn mask_param(text: &str, name: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while let Some(found) = lower[at..].find(name) {
        let value_start = at + found + name.len();
        out.push_str(&text[at..value_start]);
        let value_len = text[value_start..].find(|c: char| c.is_whitespace() || matches!(c, '&' | '#' | '\'' | '"' | ')' | '<' | '>' | ',')).unwrap_or(text.len() - value_start);
        if value_len > 0 {
            out.push_str(MASK);
        }
        at = value_start + value_len;
    }
    out.push_str(&text[at..]);
    out
}

pub fn redact(text: &str) -> String {
    let masked = PARAMS.iter().fold(mask_jwts(text), |t, p| mask_param(&t, p));
    redact_common(&masked)
}

/// [`redact`], plus every occurrence of the exact `secret` (also when it is not JWT-shaped).
pub fn redact_with(text: &str, secret: &str) -> String {
    let text = if secret.len() >= 8 { text.replace(secret, MASK) } else { text.to_owned() };
    redact(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const JWT: &str = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzEifQ.c2lnbmF0dXJlLWNhbmFyeS0xMjM";

    #[test]
    fn a_jwt_is_masked_wherever_it_appears() {
        for text in [format!("token {JWT} rejected"), format!("({JWT})"), format!("{{\"jwt\":\"{JWT}\"}}"), format!("Authorization: Bearer {JWT}")] {
            let out = redact(&text);
            assert!(!out.contains("c2lnbmF0dXJl") && !out.contains("eyJzdWIi"), "{out}");
        }
    }

    #[test]
    fn query_and_fragment_parameters_are_masked_but_the_rest_stays() {
        let out = redact("https://meet.example/meet/join#server=wss://lk.example&token=abc123secretvalue&room=r1");
        assert!(!out.contains("abc123secretvalue"), "{out}");
        assert!(out.contains("server=wss://lk.example") && out.contains("room=r1"), "{out}");
        assert!(!redact("GET /x?access_token=zzzzzzzzzz HTTP/1.1").contains("zzzzzzzzzz"));
    }

    #[test]
    fn the_exact_secret_is_masked_even_when_it_has_no_known_shape() {
        let out = redact_with("failed for opaque-credential-value-42 at host", "opaque-credential-value-42");
        assert_eq!(out, "failed for [redacted] at host");
    }

    #[test]
    fn ordinary_text_is_untouched() {
        assert_eq!(redact("Time tracking is not enabled for this store"), "Time tracking is not enabled for this store");
    }
}
