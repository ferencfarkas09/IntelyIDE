//! Unified diff text into hunks.

use std::sync::OnceLock;

use regex::Regex;

use crate::{code, EngineError, Hunk, HunkLine, HunkLineKind};

fn hunk_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@").expect("hunk header regex"))
}

/// Parses the hunks of a single-file unified diff (`git diff -U<n>`); everything before the first `@@` (file headers,
/// binary notices) is skipped, so a binary diff yields no hunks. `Hunk::index` is 0-based and `lines` holds the
/// context/add/del lines in order; `\ No newline at end of file` markers are not represented. Hunk extents are taken
/// from the header counts, so a line that merely looks like a header (`--- a`, `diff --git`) cannot end a hunk early.
pub fn parse_unified_diff(text: &str) -> Result<Vec<Hunk>, EngineError> {
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut lines = text.split('\n').peekable();
    while let Some(line) = lines.next() {
        let Some(m) = hunk_re().captures(line) else { continue };
        let num = |i: usize, default: u32| m.get(i).map_or(Ok(default), |x| x.as_str().parse::<u32>());
        let bad = |_| EngineError::new(code::GIT, format!("diff: bad hunk header {line:?}"));
        let (old_start, old_lines, new_start, new_lines) = (num(1, 1).map_err(bad)?, num(2, 1).map_err(bad)?, num(3, 1).map_err(bad)?, num(4, 1).map_err(bad)?);
        let (mut old_left, mut new_left) = (old_lines, new_lines);
        let mut body = Vec::new();
        while old_left > 0 || new_left > 0 {
            let Some(&l) = lines.peek() else { break };
            let (kind, take) = match l.as_bytes().first() {
                Some(b' ') => (HunkLineKind::Context, true),
                Some(b'+') => (HunkLineKind::Add, true),
                Some(b'-') => (HunkLineKind::Del, true),
                // some tools trim the single space of an empty context line
                None => (HunkLineKind::Context, true),
                Some(b'\\') => {
                    lines.next();
                    continue;
                }
                Some(_) => (HunkLineKind::Context, false),
            };
            if !take {
                break;
            }
            lines.next();
            match kind {
                HunkLineKind::Context => {
                    old_left = old_left.saturating_sub(1);
                    new_left = new_left.saturating_sub(1);
                }
                HunkLineKind::Add => new_left = new_left.saturating_sub(1),
                HunkLineKind::Del => old_left = old_left.saturating_sub(1),
            }
            body.push(HunkLine { kind, text: l.get(1..).unwrap_or("").to_owned() });
        }
        hunks.push(Hunk { index: hunks.len() as u32, header: line.to_owned(), old_start, old_lines, new_start, new_lines, lines: body });
    }
    Ok(hunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_HUNKS: &str = "diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,4 +1,4 @@ fn head\n one\n-two\n+TWO\n three\n four\n@@ -20,3 +20,4 @@\n twenty\n+inserted\n twenty-one\n twenty-two\n";

    #[test]
    fn two_hunks_with_counts_lines_and_section_header() {
        let h = parse_unified_diff(TWO_HUNKS).unwrap();
        assert_eq!(h.len(), 2);
        assert_eq!((h[0].index, h[0].header.as_str(), h[0].old_start, h[0].old_lines, h[0].new_start, h[0].new_lines), (0, "@@ -1,4 +1,4 @@ fn head", 1, 4, 1, 4));
        assert_eq!(
            h[0].lines.iter().map(|l| (l.kind.clone(), l.text.as_str())).collect::<Vec<_>>(),
            vec![
                (HunkLineKind::Context, "one"),
                (HunkLineKind::Del, "two"),
                (HunkLineKind::Add, "TWO"),
                (HunkLineKind::Context, "three"),
                (HunkLineKind::Context, "four"),
            ]
        );
        assert_eq!((h[1].index, h[1].old_start, h[1].old_lines, h[1].new_start, h[1].new_lines, h[1].lines.len()), (1, 20, 3, 20, 4, 4));
    }

    #[test]
    fn omitted_counts_default_to_one_and_no_newline_marker_is_skipped() {
        let h = parse_unified_diff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n").unwrap();
        assert_eq!((h[0].old_lines, h[0].new_lines, h[0].lines.len()), (1, 1, 2));
    }

    #[test]
    fn content_that_looks_like_headers_does_not_split_a_hunk() {
        // deleted line "-- a" shows as "--- a", added "++ b" as "+++ b"
        let h = parse_unified_diff("@@ -1,2 +1,2 @@\n--- a\n context\n+++ b\n").unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), vec!["-- a", "context", "++ b"]);
    }

    #[test]
    fn crlf_is_kept_and_empty_context_line_without_space_is_tolerated() {
        let h = parse_unified_diff("@@ -1,3 +1,3 @@\n a\r\n\n-b\n+c\n").unwrap();
        assert_eq!(h[0].lines[0].text, "a\r");
        assert_eq!(h[0].lines[1], HunkLine { kind: HunkLineKind::Context, text: String::new() });
        assert_eq!(h[0].lines.len(), 4);
    }

    #[test]
    fn new_file_hunk_and_binary_diff() {
        let h = parse_unified_diff("diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+x\n+y\n").unwrap();
        assert_eq!((h[0].old_start, h[0].old_lines, h[0].new_lines), (0, 0, 2));
        assert!(parse_unified_diff("diff --git a/b b/b\nBinary files a/b and b/b differ\n").unwrap().is_empty());
        assert!(parse_unified_diff("").unwrap().is_empty());
    }
}
