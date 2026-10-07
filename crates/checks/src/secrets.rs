//! Secret-looking value shapes in text that is about to be committed: GitHub tokens, AWS key ids, JWTs, credentials in
//! URLs, private key headers and a few other vendor shapes. Hand-written scanners (no regex dependency). A finding keeps
//! the line with the matched text replaced by a marker; the matched text itself is never stored or returned, and
//! [`redact`] is what the check runner applies to every output line.

use crate::envnames::is_real_env;
use crate::types::Finding;

const MAX_FINDINGS: usize = 200;
const MAX_LINE: usize = 20_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub kind: &'static str,
    pub start: usize,
    pub end: usize,
}

fn is_alnum(b: u8) -> bool {
    b.is_ascii_alphanumeric()
}

fn is_b64url(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

/// The byte before `at` is not part of a word, so `xghp_...` inside an identifier is not a token start.
fn boundary(line: &[u8], at: usize) -> bool {
    at == 0 || !(is_alnum(line[at - 1]) || line[at - 1] == b'_')
}

fn body(line: &[u8], from: usize, pred: impl Fn(u8) -> bool) -> usize {
    line[from..].iter().take_while(|b| pred(**b)).count()
}

fn prefixed(line: &str, prefix: &str, min: usize, pred: impl Fn(u8) -> bool + Copy, kind: &'static str, out: &mut Vec<Hit>) {
    let b = line.as_bytes();
    for (i, _) in line.match_indices(prefix) {
        if !boundary(b, i) {
            continue;
        }
        let from = i + prefix.len();
        let n = body(b, from, pred);
        if n >= min {
            out.push(Hit { kind, start: i, end: from + n });
        }
    }
}

fn aws(line: &str, out: &mut Vec<Hit>) {
    let b = line.as_bytes();
    for prefix in ["AKIA", "ASIA"] {
        for (i, _) in line.match_indices(prefix) {
            let from = i + 4;
            let n = body(b, from, |c| c.is_ascii_uppercase() || c.is_ascii_digit());
            let after = b.get(from + n).copied();
            if boundary(b, i) && n == 16 && after.map_or(true, |c| !is_alnum(c)) {
                out.push(Hit { kind: "AWS access key id", start: i, end: from + n });
            }
        }
    }
}

fn jwt(line: &str, out: &mut Vec<Hit>) {
    let b = line.as_bytes();
    for (i, _) in line.match_indices("eyJ") {
        if !boundary(b, i) {
            continue;
        }
        let a = body(b, i, is_b64url);
        let p1 = i + a;
        if a < 10 || b.get(p1) != Some(&b'.') || !line[p1 + 1..].starts_with("eyJ") {
            continue;
        }
        let c = body(b, p1 + 1, is_b64url);
        let p2 = p1 + 1 + c;
        if c < 10 || b.get(p2) != Some(&b'.') {
            continue;
        }
        let s = body(b, p2 + 1, is_b64url);
        if s >= 8 {
            out.push(Hit { kind: "JWT", start: i, end: p2 + 1 + s });
        }
    }
}

const PLACEHOLDER_PASSWORDS: [&str; 10] = ["password", "pass", "pwd", "secret", "changeme", "user", "username", "example", "yourpassword", "password123"];

fn url_credentials(line: &str, out: &mut Vec<Hit>) {
    let b = line.as_bytes();
    for (i, _) in line.match_indices("://") {
        let from = i + 3;
        let user = body(b, from, |c| !c.is_ascii_whitespace() && !matches!(c, b':' | b'@' | b'/' | b'?' | b'#' | b'"' | b'\'' | b'`'));
        if user == 0 || b.get(from + user) != Some(&b':') {
            continue;
        }
        let pw_from = from + user + 1;
        let pw = body(b, pw_from, |c| !c.is_ascii_whitespace() && !matches!(c, b'@' | b'/' | b'"' | b'\'' | b'`'));
        if pw == 0 || b.get(pw_from + pw) != Some(&b'@') {
            continue;
        }
        let secret = &line[pw_from..pw_from + pw];
        let templated = matches!(secret.as_bytes()[0], b'$' | b'{' | b'<' | b'%' | b'[' | b'*' | b'(') || secret.contains("${") || secret.contains("{{");
        let lower = secret.to_ascii_lowercase();
        let filler = lower.bytes().all(|c| matches!(c, b'x' | b'*' | b'.' | b'-' | b'_')) || PLACEHOLDER_PASSWORDS.contains(&lower.as_str());
        if !templated && !filler {
            out.push(Hit { kind: "Credentials in a URL", start: pw_from, end: pw_from + pw });
        }
    }
}

fn private_key(line: &str, out: &mut Vec<Hit>) {
    if let Some(i) = line.find("-----BEGIN ") {
        if let Some(rel) = line[i..].find("PRIVATE KEY-----") {
            out.push(Hit { kind: "Private key", start: i, end: i + rel + "PRIVATE KEY-----".len() });
        }
    }
}

/// Every secret-shaped span of one line, sorted and without overlaps.
pub fn detect(line: &str) -> Vec<Hit> {
    let line = if line.len() > MAX_LINE {
        let mut cut = MAX_LINE;
        while !line.is_char_boundary(cut) {
            cut -= 1;
        }
        &line[..cut]
    } else {
        line
    };
    let mut hits = Vec::new();
    for p in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
        prefixed(line, p, 36, is_alnum, "GitHub token", &mut hits);
    }
    prefixed(line, "github_pat_", 22, is_b64url, "GitHub token", &mut hits);
    aws(line, &mut hits);
    jwt(line, &mut hits);
    url_credentials(line, &mut hits);
    private_key(line, &mut hits);
    for p in ["xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-"] {
        prefixed(line, p, 10, is_b64url, "Slack token", &mut hits);
    }
    for p in ["sk_live_", "rk_live_"] {
        prefixed(line, p, 16, is_alnum, "Stripe live key", &mut hits);
    }
    prefixed(line, "AIza", 35, is_b64url, "Google API key", &mut hits);
    hits.sort_by_key(|h| (h.start, std::cmp::Reverse(h.end)));
    let mut merged: Vec<Hit> = Vec::new();
    for h in hits {
        if merged.last().is_some_and(|l| h.start < l.end) {
            continue;
        }
        merged.push(h);
    }
    merged
}

fn mark(kind: &str) -> String {
    format!("[redacted: {kind}]")
}

/// The line with every secret-shaped span replaced by a marker.
pub fn redact_line(line: &str) -> String {
    let hits = detect(line);
    if hits.is_empty() {
        return line.to_owned();
    }
    let mut out = String::with_capacity(line.len());
    let mut at = 0;
    for h in &hits {
        out.push_str(&line[at..h.start]);
        out.push_str(&mark(h.kind));
        at = h.end;
    }
    out.push_str(&line[at..]);
    out
}

/// Multi-line [`redact_line`]; text without a secret shape comes back unchanged.
pub fn redact(text: &str) -> String {
    text.split('\n').map(redact_line).collect::<Vec<_>>().join("\n")
}

fn preview(line: &str) -> String {
    let red = redact_line(line.trim());
    if red.chars().count() > 140 {
        let cut: String = red.chars().take(140).collect();
        format!("{cut}…")
    } else {
        red
    }
}

fn push(out: &mut Vec<Finding>, path: &str, line_no: u32, text: &str) {
    for kind in detect(text).into_iter().map(|h| h.kind).collect::<std::collections::BTreeSet<_>>() {
        if out.len() < MAX_FINDINGS {
            out.push(Finding { path: path.to_owned(), line: line_no, kind: kind.to_owned(), preview: preview(text) });
        }
    }
}

/// Findings in the added lines of a unified diff (`git diff` output). Deleted and context lines are never judged.
pub fn scan_diff(diff: &str) -> Vec<Finding> {
    let mut out = Vec::new();
    let mut path = String::new();
    let mut skip = false;
    let mut line_no = 0u32;
    for l in diff.lines() {
        if let Some(rest) = l.strip_prefix("+++ ") {
            path = rest.strip_prefix("b/").unwrap_or(rest).trim_matches('"').to_owned();
            skip = rest == "/dev/null" || is_real_env(&path);
        } else if l.starts_with("--- ") || l.starts_with("diff --git") || l.starts_with("index ") {
            continue;
        } else if let Some(h) = l.strip_prefix("@@") {
            // @@ -a,b +c,d @@
            line_no = h.split_whitespace().find_map(|t| t.strip_prefix('+')).and_then(|t| t.split(',').next()).and_then(|n| n.parse().ok()).unwrap_or(0);
        } else if let Some(added) = l.strip_prefix('+') {
            if !skip {
                push(&mut out, &path, line_no, added);
            }
            line_no += 1;
        } else if l.starts_with(' ') {
            line_no += 1;
        }
    }
    out
}

/// Findings in a whole new file (an untracked file the commit would add).
pub fn scan_text(path: &str, text: &str) -> Vec<Finding> {
    let mut out = Vec::new();
    if is_real_env(path) {
        return out;
    }
    for (i, l) in text.lines().enumerate() {
        push(&mut out, path, i as u32 + 1, l);
    }
    out
}

const MAX_UNTRACKED_BYTES: u64 = 1024 * 1024;

/// The secret scan of what a commit of `paths` (repo-relative, the ticked files) would add: the diff against HEAD for
/// tracked files and the whole content of untracked ones. `.env` files, binaries and big files are skipped and listed;
/// a real env file is never opened.
pub fn scan_paths(jail: &intely_core::jail::Jail, repo_id: &str, repo: &std::path::Path, paths: &[String]) -> Result<crate::types::SecretScan, intely_core::EngineError> {
    use crate::{discover::clean_rel, git};
    let mut skipped = Vec::new();
    let mut wanted = Vec::new();
    for p in paths {
        match clean_rel(p) {
            Some(c) if is_real_env(&c) => skipped.push(c),
            Some(c) => wanted.push(c),
            None => skipped.push(p.clone()),
        }
    }
    let mut findings = Vec::new();
    if wanted.is_empty() {
        return Ok(crate::types::SecretScan { repo_id: repo_id.to_owned(), findings, skipped });
    }
    let mut args: Vec<&str> = vec!["diff", "HEAD", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "--"];
    args.extend(wanted.iter().map(String::as_str));
    // No commits yet (or a path git does not know): the diff is empty and the untracked pass below covers new files.
    if let Ok(o) = git::run(jail, repo, &args) {
        if o.ok {
            findings.extend(scan_diff(&o.stdout));
        }
    }
    let mut args: Vec<&str> = vec!["ls-files", "--others", "--exclude-standard", "--"];
    args.extend(wanted.iter().map(String::as_str));
    let untracked = git::read(jail, repo, &args).unwrap_or_default();
    for rel in untracked.lines().filter(|l| !l.is_empty()) {
        let Ok(full) = intely_core::exec::resolve_in_repo(repo, rel) else { continue };
        match std::fs::metadata(&full) {
            Ok(m) if m.is_file() && m.len() <= MAX_UNTRACKED_BYTES => match std::fs::read_to_string(&full) {
                Ok(text) => findings.extend(scan_text(rel, &text)),
                Err(_) => skipped.push(rel.to_owned()),
            },
            _ => skipped.push(rel.to_owned()),
        }
    }
    findings.truncate(MAX_FINDINGS);
    Ok(crate::types::SecretScan { repo_id: repo_id.to_owned(), findings, skipped })
}
