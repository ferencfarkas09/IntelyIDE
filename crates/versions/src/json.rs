//! A JSON locator: finds the byte range of one string or number value by its key path without building a tree, so
//! the file can be edited in place and keep its formatting. It reads plain JSON (no comments), which is what
//! `package.json`, `tauri.conf.json`, `app.json` and `package-lock.json` are.

pub(crate) struct Loc {
    pub start: usize,
    pub end: usize,
    /// True for a string (the range is inside the quotes), false for a number.
    pub quoted: bool,
}

struct P<'a> {
    b: &'a [u8],
    i: usize,
}

impl P<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    /// Reads a string starting at the opening quote; returns the range of its content and moves past the closing quote.
    fn string(&mut self) -> Option<(usize, usize)> {
        if self.b.get(self.i) != Some(&b'"') {
            return None;
        }
        let start = self.i + 1;
        let mut j = start;
        while j < self.b.len() {
            match self.b[j] {
                b'\\' => j += 2,
                b'"' => {
                    self.i = j + 1;
                    return Some((start, j));
                }
                // JSON allows no raw line break inside a string: a string that has one is a damaged file, not a place to write
                b'\n' | b'\r' => return None,
                _ => j += 1,
            }
        }
        None
    }

    fn skip_value(&mut self) -> Option<()> {
        self.ws();
        match *self.b.get(self.i)? {
            b'"' => self.string().map(|_| ()),
            b'{' | b'[' => {
                let mut depth = 0usize;
                while self.i < self.b.len() {
                    match self.b[self.i] {
                        b'"' => {
                            self.string()?;
                            continue;
                        }
                        b'{' | b'[' => depth += 1,
                        b'}' | b']' => {
                            depth -= 1;
                            if depth == 0 {
                                self.i += 1;
                                return Some(());
                            }
                        }
                        _ => {}
                    }
                    self.i += 1;
                }
                None
            }
            _ => {
                while self.i < self.b.len() && !matches!(self.b[self.i], b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r') {
                    self.i += 1;
                }
                Some(())
            }
        }
    }

    /// At the start of a value: when it is an object, looks for `path[0]` among its members.
    fn find(&mut self, path: &[&str], text: &str) -> Option<Loc> {
        self.ws();
        if self.b.get(self.i) != Some(&b'{') {
            return None;
        }
        self.i += 1;
        loop {
            self.ws();
            match self.b.get(self.i)? {
                b'}' => return None,
                b',' => {
                    self.i += 1;
                    continue;
                }
                _ => {}
            }
            let (ks, ke) = self.string()?;
            self.ws();
            if self.b.get(self.i) != Some(&b':') {
                return None;
            }
            self.i += 1;
            self.ws();
            if &text[ks..ke] == path[0] {
                if path.len() > 1 {
                    return self.find(&path[1..], text);
                }
                return match *self.b.get(self.i)? {
                    b'"' => {
                        let (s, e) = self.string()?;
                        Some(Loc { start: s, end: e, quoted: true })
                    }
                    b'-' | b'0'..=b'9' => {
                        let s = self.i;
                        while self.i < self.b.len() && matches!(self.b[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                            self.i += 1;
                        }
                        Some(Loc { start: s, end: self.i, quoted: false })
                    }
                    _ => None,
                };
            }
            self.skip_value()?;
        }
    }
}

/// The scalar (string or number) at `path`, an object-key path such as `["packages", "", "version"]`.
pub(crate) fn locate(text: &str, path: &[&str]) -> Option<Loc> {
    if path.is_empty() {
        return None;
    }
    let bom = if text.starts_with('\u{feff}') { '\u{feff}'.len_utf8() } else { 0 };
    let mut p = P { b: text.as_bytes(), i: bom };
    p.find(path, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn val<'a>(t: &'a str, path: &[&str]) -> Option<&'a str> {
        locate(t, path).map(|l| &t[l.start..l.end])
    }

    #[test]
    fn finds_the_top_level_key_not_a_nested_one() {
        let t = r#"{ "config": { "version": "9.9.9" }, "name": "x", "version": "1.2.3", "dependencies": { "version": "0.0.1" } }"#;
        assert_eq!(val(t, &["version"]), Some("1.2.3"));
        assert_eq!(val(t, &["config", "version"]), Some("9.9.9"));
    }

    #[test]
    fn skips_strings_with_braces_and_escapes() {
        let t = "{\n  \"scripts\": { \"a\": \"echo \\\"}{\\\"\" },\n  \"version\": \"2.0.0\"\n}\n";
        assert_eq!(val(t, &["version"]), Some("2.0.0"));
    }

    #[test]
    fn numbers_are_unquoted_and_the_empty_key_works() {
        let t = r#"{"expo":{"android":{"versionCode":12}},"packages":{"":{"version":"1.0.0"}}}"#;
        let l = locate(t, &["expo", "android", "versionCode"]).unwrap();
        assert!(!l.quoted);
        assert_eq!(&t[l.start..l.end], "12");
        assert_eq!(val(t, &["packages", "", "version"]), Some("1.0.0"));
    }

    #[test]
    fn missing_and_non_scalar_values_are_none() {
        let t = r#"{"version": {"a": 1}, "n": null, "list": [1,2]}"#;
        assert!(val(t, &["version"]).is_none());
        assert!(val(t, &["n"]).is_none());
        assert!(val(t, &["nope"]).is_none());
        assert!(locate("not json", &["version"]).is_none());
    }

    #[test]
    fn a_byte_order_mark_is_skipped() {
        let t = "\u{feff}{\"version\":\"3.1.4\"}";
        assert_eq!(val(t, &["version"]), Some("3.1.4"));
    }
}
