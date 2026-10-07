//! Commit lists from `git log` with a unit-separator format.

use crate::{code, CommitInfo, EngineError};

/// `git log --format=<LOG_FORMAT>`: fields are separated by US (0x1f) and records end with RS (0x1e), so no subject or
/// author text can break the framing. Order: oid, short oid, author name, author time (epoch seconds), subject.
pub const LOG_FORMAT: &str = "%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e";

pub fn parse_log(raw: &[u8]) -> Result<Vec<CommitInfo>, EngineError> {
    let text = String::from_utf8_lossy(raw);
    let mut out = Vec::new();
    for rec in text.split('\u{1e}') {
        let rec = rec.trim_matches(|c| c == '\n' || c == '\r');
        if rec.is_empty() {
            continue;
        }
        let mut f = rec.split('\u{1f}');
        let (Some(oid), Some(short), Some(author), Some(at), Some(subject), None) = (f.next(), f.next(), f.next(), f.next(), f.next(), f.next()) else {
            return Err(EngineError::new(code::GIT, format!("log: malformed record {rec:?}")));
        };
        let secs: i64 = at.parse().map_err(|_| EngineError::new(code::GIT, format!("log: bad timestamp {at:?}")))?;
        out.push(CommitInfo {
            oid: oid.to_owned(),
            short_oid: short.to_owned(),
            subject: subject.to_owned(),
            author: author.to_owned(),
            date_ms: secs * 1000,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "1111111111111111111111111111111111111111";
    const B: &str = "2222222222222222222222222222222222222222";

    #[test]
    fn parses_records_with_tformat_newlines() {
        let raw = format!("{A}\u{1f}1111111\u{1f}Fixture User\u{1f}1700000000\u{1f}feat: add x\u{1e}\n{B}\u{1f}2222222\u{1f}Árvíz Tűrő\u{1f}1700000100\u{1f}fix: \"quoted\" | pipe\u{1e}\n");
        let c = parse_log(raw.as_bytes()).unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!((c[0].oid.as_str(), c[0].short_oid.as_str(), c[0].author.as_str(), c[0].date_ms, c[0].subject.as_str()), (A, "1111111", "Fixture User", 1_700_000_000_000, "feat: add x"));
        assert_eq!((c[1].author.as_str(), c[1].subject.as_str()), ("Árvíz Tűrő", "fix: \"quoted\" | pipe"));
    }

    #[test]
    fn empty_output_and_empty_subject() {
        assert!(parse_log(b"").unwrap().is_empty());
        assert!(parse_log(b"\n").unwrap().is_empty());
        let raw = format!("{A}\u{1f}1111111\u{1f}n\u{1f}1\u{1f}\u{1e}\n");
        assert_eq!(parse_log(raw.as_bytes()).unwrap()[0].subject, "");
    }

    #[test]
    fn malformed_records_error() {
        assert!(parse_log(b"a\x1fb\x1e").is_err());
        assert!(parse_log(format!("{A}\u{1f}1\u{1f}n\u{1f}notanumber\u{1f}s\u{1e}").as_bytes()).is_err());
        assert!(parse_log(format!("{A}\u{1f}1\u{1f}n\u{1f}1\u{1f}s\u{1f}extra\u{1e}").as_bytes()).is_err());
    }
}
