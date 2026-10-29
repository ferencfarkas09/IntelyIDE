//! A small unified diff of an in-place edit. An edit replaces text inside lines and never adds or removes a line, so
//! the two texts have the same line count and a line-by-line comparison is exact.

/// The longest piece of a line the diff shows. A minified file is one line of megabytes; the diff shows the stretch around the change.
const SHOWN: usize = 300;

/// `s` as far as the diff shows it: the whole line when short, else about `SHOWN` bytes around byte `at` (the first difference).
fn window(s: &str, at: usize) -> String {
    if s.len() <= SHOWN {
        return s.to_string();
    }
    let mut lo = at.saturating_sub(SHOWN / 3).min(s.len());
    while !s.is_char_boundary(lo) {
        lo -= 1;
    }
    let mut hi = (lo + SHOWN).min(s.len());
    while !s.is_char_boundary(hi) {
        hi += 1;
    }
    format!("{}{}{}", if lo > 0 { "…" } else { "" }, &s[lo..hi], if hi < s.len() { "…" } else { "" })
}

pub(crate) fn render(path: &str, before: &str, after: &str) -> String {
    let a: Vec<&str> = before.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    let b: Vec<&str> = after.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    let n = a.len().min(b.len());
    let changed: Vec<usize> = (0..n).filter(|&i| a[i] != b[i]).collect();
    let mut out = format!("--- a/{path}\n+++ b/{path}\n");
    let mut i = 0;
    while i < changed.len() {
        let lo = changed[i].saturating_sub(1);
        let mut hi = (changed[i] + 1).min(n - 1);
        let mut j = i;
        while j + 1 < changed.len() && changed[j + 1] <= hi + 2 {
            j += 1;
            hi = (changed[j] + 1).min(n - 1);
        }
        out.push_str(&format!("@@ -{},{} +{},{} @@\n", lo + 1, hi - lo + 1, lo + 1, hi - lo + 1));
        for k in lo..=hi {
            if a[k] == b[k] {
                out.push_str(&format!(" {}\n", window(a[k], 0)));
            } else {
                let at = a[k].bytes().zip(b[k].bytes()).take_while(|(x, y)| x == y).count();
                out.push_str(&format!("-{}\n+{}\n", window(a[k], at), window(b[k], at)));
            }
        }
        i = j + 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shows_the_changed_line_with_one_line_of_context() {
        let d = render("package.json", "{\n  \"version\": \"1.0.0\",\n  \"x\": 1\n}\n", "{\n  \"version\": \"1.0.1\",\n  \"x\": 1\n}\n");
        assert_eq!(d, "--- a/package.json\n+++ b/package.json\n@@ -1,3 +1,3 @@\n {\n-  \"version\": \"1.0.0\",\n+  \"version\": \"1.0.1\",\n   \"x\": 1\n");
    }

    #[test]
    fn nearby_changes_share_a_hunk_and_far_ones_do_not() {
        let before = "a\nA1\nb\nA2\nc\nd\ne\nf\ng\nA3\nh\n";
        let after = "a\nB1\nb\nB2\nc\nd\ne\nf\ng\nB3\nh\n";
        let d = render("f", before, after);
        assert_eq!(d.matches("@@").count(), 4, "{d}");
    }

    #[test]
    fn a_line_of_megabytes_is_shown_as_the_stretch_around_the_change() {
        let pad = "x".repeat(2_000_000);
        let before = format!("{{\"pad\":\"{pad}\",\"version\":\"1.0.0\",\"tail\":\"{pad}\"}}");
        let after = before.replace("1.0.0", "1.0.1");
        let d = render("package.json", &before, &after);
        assert!(d.len() < 2_000, "{} bytes", d.len());
        assert!(d.contains("\"version\":\"1.0.0\"") && d.contains("\"version\":\"1.0.1\""), "{d}");
        // multi-byte text around the change is never cut in the middle of a character
        let mb = format!("{}é\"version\":\"1.0.0\"{}", "é".repeat(500), "é".repeat(500));
        let d = render("f", &mb, &mb.replace("1.0.0", "1.0.1"));
        assert!(d.contains("1.0.1"));
    }

    #[test]
    fn line_endings_are_not_part_of_the_diff() {
        let d = render("f", "v=1\r\nz\r\n", "v=2\r\nz\r\n");
        assert!(d.contains("-v=1\n+v=2\n"), "{d}");
    }
}
