//! A small unified diff of an in-place edit. An edit replaces text inside lines and never adds or removes a line, so
//! the two texts have the same line count and a line-by-line comparison is exact.

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
                out.push_str(&format!(" {}\n", a[k]));
            } else {
                out.push_str(&format!("-{}\n+{}\n", a[k], b[k]));
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
    fn line_endings_are_not_part_of_the_diff() {
        let d = render("f", "v=1\r\nz\r\n", "v=2\r\nz\r\n");
        assert!(d.contains("-v=1\n+v=2\n"), "{d}");
    }
}
