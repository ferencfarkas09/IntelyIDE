//! Colour and length literals as they are written in style sheets, normalised so that `#FFF`, `#ffffff` and `#fff` compare equal.
//! Only literals are recognised (no `color-mix()`, no `calc()`); a swatch value handed to the UI is validated again by [`swatch`].

/// The canonical spelling of a colour literal, or None when `v` is not one.
pub(crate) fn normalize_color(v: &str) -> Option<String> {
    let v = v.trim().trim_end_matches("!important").trim().to_ascii_lowercase();
    if v.len() > 80 {
        return None;
    }
    if let Some(h) = v.strip_prefix('#') {
        if h.bytes().all(|b| b.is_ascii_hexdigit()) {
            return match h.len() {
                3 | 4 => Some(format!("#{}", h.chars().flat_map(|c| [c, c]).collect::<String>())),
                6 | 8 => Some(format!("#{h}")),
                _ => None,
            };
        }
        return None;
    }
    for f in ["rgb(", "rgba(", "hsl(", "hsla("] {
        if v.starts_with(f) && v.ends_with(')') {
            let inner = &v[f.len()..v.len() - 1];
            if inner.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b',' | b'%' | b'/' | b' ' | b'-' | b'a'..=b'z')) && !inner.contains("var") && !inner.contains("calc") {
                let compact: String = inner.split_whitespace().collect::<Vec<_>>().join(" ").replace(", ", ",").replace(" ,", ",");
                return Some(format!("{f}{compact})"));
            }
        }
    }
    match v.as_str() {
        "white" => Some("#ffffff".into()),
        "black" => Some("#000000".into()),
        _ => None,
    }
}

/// `value` when it is safe to paint as a swatch (a hex colour or a plain rgb/hsl function), else None.
pub(crate) fn swatch(value: &str) -> Option<String> {
    let n = normalize_color(value)?;
    let ok = if let Some(hex) = n.strip_prefix('#') {
        hex.len() <= 8 && hex.bytes().all(|b| b.is_ascii_hexdigit())
    } else {
        n.len() <= 60 && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'(' | b')' | b'.' | b',' | b'%' | b'/' | b' ' | b'-'))
    };
    ok.then_some(n)
}

/// `16px`, `1.5rem`, `.5em` -> a canonical `0.5em`; zero and unitless numbers are not spacing values worth a token.
pub(crate) fn normalize_length(v: &str) -> Option<String> {
    let v = v.trim().trim_end_matches("!important").trim().to_ascii_lowercase();
    let unit = ["px", "rem", "em"].into_iter().find(|u| v.ends_with(u))?;
    let num = &v[..v.len() - unit.len()];
    if num.is_empty() || num.len() > 8 || !num.bytes().all(|b| b.is_ascii_digit() || b == b'.') || num.matches('.').count() > 1 {
        return None;
    }
    let parsed: f64 = num.parse().ok()?;
    if parsed == 0.0 {
        return None;
    }
    Some(format!("{parsed}{unit}"))
}

/// A value split into its space/comma separated parts, outside parentheses (`1px solid rgb(0, 0, 0)` -> 3 parts).
pub(crate) fn components(value: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start = None;
    for (i, c) in value.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        let sep = depth <= 0 && (c.is_whitespace() || c == ',');
        match (sep, start) {
            (false, None) => start = Some(i),
            (true, Some(s)) => {
                out.push(&value[s..i]);
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        out.push(&value[s..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_compare_equal_however_they_are_written() {
        assert_eq!(normalize_color("#FFF"), Some("#ffffff".into()));
        assert_eq!(normalize_color("#ffffff"), Some("#ffffff".into()));
        assert_eq!(normalize_color("RGBA(0, 0, 0, .5)"), Some("rgba(0,0,0,.5)".into()));
        assert_eq!(normalize_color("white"), Some("#ffffff".into()));
        assert_eq!(normalize_color("#12345"), None);
        assert_eq!(normalize_color("rgb(var(--r), 0, 0)"), None);
        assert_eq!(normalize_color("16px"), None);
    }

    #[test]
    fn a_swatch_is_only_ever_a_plain_colour() {
        assert!(swatch("#abc").is_some());
        assert!(swatch("rgb(1, 2, 3)").is_some());
        assert_eq!(swatch("red; background: url(http://x)"), None);
        assert_eq!(swatch("rgb(1,2,3); x"), None);
        assert_eq!(swatch("url(javascript:alert(1))"), None);
    }

    #[test]
    fn lengths_and_components() {
        assert_eq!(normalize_length("16PX"), Some("16px".into()));
        assert_eq!(normalize_length(".5rem"), Some("0.5rem".into()));
        assert_eq!(normalize_length("0px"), None);
        assert_eq!(normalize_length("12"), None);
        assert_eq!(components("1px solid rgb(0, 0, 0), red"), vec!["1px", "solid", "rgb(0, 0, 0)", "red"]);
    }
}
