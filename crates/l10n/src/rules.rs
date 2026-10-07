//! Placeholder and plural rules shared by every locale (i18next conventions used by all four Happy repos).

use std::collections::BTreeSet;

/// `{{name}}` (a `, format` suffix is dropped), printf `%s %d %1$s`, and `{0}` / `{name}` single-brace tokens.
pub fn placeholders(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'{' && b.get(i + 1) == Some(&b'{') {
            if let Some(end) = text[i + 2..].find("}}") {
                let inner = text[i + 2..i + 2 + end].split(',').next().unwrap_or("").trim().trim_start_matches('-').trim();
                if !inner.is_empty() {
                    out.insert(format!("{{{{{inner}}}}}"));
                }
                i += end + 4;
                continue;
            }
        } else if b[i] == b'%' {
            let mut j = i + 1;
            while j < b.len() && (b[j].is_ascii_digit() || b[j] == b'$' || b[j] == b'.') {
                j += 1;
            }
            if j < b.len() && matches!(b[j], b's' | b'd' | b'i' | b'f' | b'@') {
                out.insert(text[i..=j].to_string());
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

pub const FORMS: [&str; 6] = ["zero", "one", "two", "few", "many", "other"];

/// Splits `items_one` into (`items`, `one`).
pub fn plural_split(key: &str) -> Option<(&str, &str)> {
    let (base, suffix) = key.rsplit_once('_')?;
    FORMS.contains(&suffix).then_some((base, suffix))
}

/// Plural categories the language needs (CLDR). Unknown codes ask for `one` and `other` only.
pub fn required_forms(lang: &str) -> &'static [&'static str] {
    match lang.split(['-', '_']).next().unwrap_or(lang) {
        "cn" | "zh" | "ja" | "ko" | "vi" | "th" | "id" => &["other"],
        "cz" | "cs" | "sk" => &["one", "few", "many", "other"],
        "pl" | "ru" | "uk" => &["one", "few", "many", "other"],
        "ro" => &["one", "few", "other"],
        "fr" | "es" | "it" | "pt" => &["one", "many", "other"],
        "sl" | "svn" => &["one", "two", "few", "other"],
        "ar" => &["zero", "one", "two", "few", "many", "other"],
        _ => &["one", "other"],
    }
}

pub fn is_lang_code(s: &str) -> bool {
    const KNOWN: [&str; 36] = [
        "en", "hu", "de", "cz", "cs", "sk", "fr", "it", "es", "ro", "pl", "cn", "zh", "svn", "sl", "sv", "pt", "nl", "ru", "uk", "hr", "sr", "bg", "ja", "ko", "tr", "ar", "he", "da", "fi",
        "nb", "no", "el", "vi", "th", "id",
    ];
    let head = s.split(['-', '_']).next().unwrap_or(s);
    KNOWN.contains(&head) && (s.len() == head.len() || s[head.len() + 1..].chars().all(|c| c.is_ascii_alphabetic()) && s.len() <= head.len() + 5)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_i18next_and_printf() {
        let p = placeholders("{{done}} of {{ total, number }} - %s %1$d 100%");
        assert_eq!(p.into_iter().collect::<Vec<_>>(), ["%1$d", "%s", "{{done}}", "{{total}}"]);
    }

    #[test]
    fn plural_suffix() {
        assert_eq!(plural_split("items_other"), Some(("items", "other")));
        assert_eq!(plural_split("items_total"), None);
    }

    #[test]
    fn lang_codes() {
        assert!(is_lang_code("en") && is_lang_code("zh-Hans") && is_lang_code("svn"));
        assert!(!is_lang_code("ai") && !is_lang_code("index") && !is_lang_code("common"));
    }
}
