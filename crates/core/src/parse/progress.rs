//! Line splitting and classification of git's stderr/stdout stream (progress is separated by CR, not LF).

use std::sync::OnceLock;

use regex::Regex;

/// Turns arbitrarily chunked bytes into complete lines split on CR, LF or CRLF; empty lines are dropped.
/// Lines are decoded after splitting, so a multi-byte UTF-8 character split across chunks is safe.
#[derive(Default)]
pub struct LineSplitter {
    buf: Vec<u8>,
    last_was_cr: bool,
}

impl LineSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, chunk: &[u8], mut on_line: impl FnMut(&str)) {
        for &b in chunk {
            match b {
                b'\r' => {
                    self.flush(&mut on_line);
                    self.last_was_cr = true;
                }
                b'\n' => {
                    // The LF of a CRLF pair ends an already flushed line.
                    if !(self.last_was_cr && self.buf.is_empty()) {
                        self.flush(&mut on_line);
                    }
                    self.last_was_cr = false;
                }
                _ => {
                    self.buf.push(b);
                    self.last_was_cr = false;
                }
            }
        }
    }

    /// Emits a trailing partial line.
    pub fn finish(&mut self, mut on_line: impl FnMut(&str)) {
        self.flush(&mut on_line);
        self.last_was_cr = false;
    }

    fn flush(&mut self, on_line: &mut impl FnMut(&str)) {
        if !self.buf.is_empty() {
            on_line(&String::from_utf8_lossy(&self.buf));
            self.buf.clear();
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProgressLine {
    /// `Counting objects:  25% (1/4)`, optionally prefixed `remote: `.
    Progress {
        phase: String,
        percent: u8,
        current: u64,
        total: u64,
        bytes: Option<String>,
        rate: Option<String>,
        done: bool,
        remote: bool,
    },
    /// `remote: <text>` sideband line without a progress phase.
    Remote(String),
    /// `error:`, `fatal:`, `hint:` or `warning:` line (the prefix stays in `text`).
    Diagnostic { severity: String, text: String },
    Text(String),
}

fn phase_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^(?:remote: )?(Enumerating objects|Counting objects|Compressing objects|Writing objects|Resolving deltas|Receiving objects|Total)(?::\s*(\d+)% \((\d+)/(\d+)\))?(?:, ([\d.]+ \S+)(?: \| ([\d.]+ \S+/s))?)?(, done\.)?",
        )
        .expect("progress regex")
    })
}

pub fn classify_progress_line(line: &str) -> ProgressLine {
    if let Some(m) = phase_re().captures(line) {
        if let Some(pct) = m.get(2) {
            return ProgressLine::Progress {
                phase: m[1].to_owned(),
                percent: pct.as_str().parse().unwrap_or(0),
                current: m[3].parse().unwrap_or(0),
                total: m[4].parse().unwrap_or(0),
                bytes: m.get(5).map(|x| x.as_str().to_owned()),
                rate: m.get(6).map(|x| x.as_str().to_owned()),
                done: m.get(7).is_some(),
                remote: line.starts_with("remote: "),
            };
        }
    }
    if let Some(rest) = line.strip_prefix("remote: ") {
        return ProgressLine::Remote(rest.to_owned());
    }
    for severity in ["error", "fatal", "hint", "warning"] {
        if line.strip_prefix(severity).is_some_and(|r| r.starts_with(':')) {
            return ProgressLine::Diagnostic { severity: severity.to_owned(), text: line.to_owned() };
        }
    }
    ProgressLine::Text(line.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split_all(data: &[u8], chunk: usize) -> Vec<String> {
        let mut out = Vec::new();
        let mut sp = LineSplitter::new();
        for c in data.chunks(chunk) {
            sp.feed(c, |l| out.push(l.to_owned()));
        }
        sp.finish(|l| out.push(l.to_owned()));
        out
    }

    const PUSH_STDERR: &str = "Enumerating objects: 4, done.\nCounting objects:  25% (1/4)\rCounting objects: 100% (4/4)\rCounting objects: 100% (4/4), done.\nWriting objects: 100% (3/3), 260 bytes | 260.00 KiB/s, done.\nremote: Resolving deltas: 100% (1/1), done.\r\nremote: hello\nTotal 3 (delta 0)";

    #[test]
    fn splitter_cr_lf_crlf_any_chunk_size_and_trailing_partial() {
        for n in [1, 2, 3, 7, 64, 10000] {
            let out = split_all(PUSH_STDERR.as_bytes(), n);
            assert_eq!(out.len(), 8, "chunk {n}: {out:?}");
            assert_eq!(out[1], "Counting objects:  25% (1/4)");
            assert_eq!(out[5], "remote: Resolving deltas: 100% (1/1), done.");
            assert_eq!(out[7], "Total 3 (delta 0)");
        }
    }

    #[test]
    fn splitter_utf8_split_across_chunks() {
        assert_eq!(split_all("remote: árvíztűrő\n".as_bytes(), 1), vec!["remote: árvíztűrő"]);
    }

    #[test]
    fn classify_progress_phases() {
        let out = split_all(PUSH_STDERR.as_bytes(), 5);
        match classify_progress_line(&out[1]) {
            ProgressLine::Progress { phase, percent, current, total, done, .. } => {
                assert_eq!((phase.as_str(), percent, current, total, done), ("Counting objects", 25, 1, 4, false));
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(classify_progress_line(&out[3]), ProgressLine::Progress { done: true, .. }));
        match classify_progress_line(&out[4]) {
            ProgressLine::Progress { phase, bytes, rate, .. } => {
                assert_eq!(phase, "Writing objects");
                assert_eq!(bytes.as_deref(), Some("260 bytes"));
                assert_eq!(rate.as_deref(), Some("260.00 KiB/s"));
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(classify_progress_line(&out[5]), ProgressLine::Progress { remote: true, .. }));
        assert_eq!(classify_progress_line(&out[6]), ProgressLine::Remote("hello".into()));
        assert!(matches!(classify_progress_line(&out[7]), ProgressLine::Text(_)));
        // "Enumerating objects: 4, done." has no percentage, so it is plain text.
        assert!(matches!(classify_progress_line(&out[0]), ProgressLine::Text(_)));
    }

    #[test]
    fn classify_diagnostics() {
        assert!(matches!(
            classify_progress_line("error: failed to push some refs to x"),
            ProgressLine::Diagnostic { ref severity, .. } if severity == "error"
        ));
        assert!(matches!(
            classify_progress_line("hint: use git pull"),
            ProgressLine::Diagnostic { ref severity, .. } if severity == "hint"
        ));
        assert!(matches!(classify_progress_line("errors are text"), ProgressLine::Text(_)));
    }
}
