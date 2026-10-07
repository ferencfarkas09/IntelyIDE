//! `git blame --porcelain`, cached per file and revision so moving the caret costs nothing.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use intely_core::exec::clean_rel_path;
use intely_core::EngineError;

use crate::env::{check_rev, invalid, Env};
use crate::types::{BlameCaret, BlameLine};

const ZERO_OID: &str = "0000000000000000000000000000000000000000";
const CACHE_ENTRIES: usize = 24;

type Key = (String, String, String);

/// Most recently used first.
#[derive(Default)]
pub struct BlameCache {
    entries: Mutex<VecDeque<(Key, Arc<Vec<BlameLine>>)>>,
}

impl BlameCache {
    fn get(&self, key: &Key) -> Option<Arc<Vec<BlameLine>>> {
        let mut entries = self.entries.lock().expect("blame cache lock");
        let at = entries.iter().position(|(k, _)| k == key)?;
        let hit = entries.remove(at)?;
        let lines = hit.1.clone();
        entries.push_front(hit);
        Some(lines)
    }

    fn put(&self, key: Key, lines: Arc<Vec<BlameLine>>) {
        let mut entries = self.entries.lock().expect("blame cache lock");
        entries.retain(|(k, _)| k != &key);
        entries.push_front((key, lines));
        entries.truncate(CACHE_ENTRIES);
    }
}

/// What identifies the blamed content: the resolved commit for a revision, or HEAD plus the file's stamp for the working tree.
async fn content_key(env: &Env, repo: &std::path::Path, path: &str, rev: Option<&str>) -> Result<String, EngineError> {
    match rev {
        Some(rev) => {
            check_rev(rev)?;
            let spec = format!("{rev}^{{commit}}");
            Ok(env.read(repo, &["rev-parse", "--verify", "--end-of-options", &spec]).await?.trim().to_owned())
        }
        None => {
            let head = env.read(repo, &["rev-parse", "--verify", "-q", "HEAD"]).await.unwrap_or_default();
            let stamp = std::fs::metadata(repo.join(path))
                .ok()
                .map(|m| {
                    let ns = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
                    format!("{ns}:{}", m.len())
                })
                .unwrap_or_default();
            Ok(format!("worktree:{}:{stamp}", head.trim()))
        }
    }
}

pub async fn blame(env: &Env, cache: &BlameCache, repo_id: &str, path: &str, rev: Option<&str>) -> Result<Arc<Vec<BlameLine>>, EngineError> {
    let repo = env.path(repo_id)?;
    let path = clean_rel_path(path)?;
    let key = (repo_id.to_owned(), path.clone(), content_key(env, &repo, &path, rev).await?);
    if let Some(hit) = cache.get(&key) {
        return Ok(hit);
    }
    // For a revision the key is its resolved oid: safe to pass on as a plain argument.
    let mut args = vec!["blame", "--porcelain"];
    if rev.is_some() {
        args.push(&key.2);
    }
    args.extend(["--", &path]);
    let lines = Arc::new(parse_porcelain(&env.read(&repo, &args).await?));
    cache.put(key, lines.clone());
    Ok(lines)
}

pub async fn blame_caret(env: &Env, cache: &BlameCache, repo_id: &str, path: &str, line: u32, rev: Option<&str>) -> Result<BlameCaret, EngineError> {
    let lines = blame(env, cache, repo_id, path, rev).await?;
    let l = lines.get((line as usize).wrapping_sub(1)).ok_or_else(|| invalid(format!("line {line} is outside the file ({} lines)", lines.len())))?;
    Ok(BlameCaret {
        line,
        short_oid: l.oid.chars().take(8).collect(),
        oid: l.oid.clone(),
        author: l.author.clone(),
        author_email: l.author_email.clone(),
        date_ms: l.date_ms,
        relative_time: if l.uncommitted { "Not committed yet".into() } else { relative_time(now_ms(), l.date_ms) },
        subject: l.summary.clone(),
        uncommitted: l.uncommitted,
    })
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// "just now", "5 minutes ago", "3 days ago", "2 years ago".
pub fn relative_time(now_ms: i64, then_ms: i64) -> String {
    let secs = ((now_ms - then_ms) / 1000).max(0);
    let (n, unit) = match secs {
        0..=44 => return "just now".into(),
        45..=3_599 => ((secs + 30) / 60, "minute"),
        3_600..=86_399 => (secs / 3_600, "hour"),
        86_400..=604_799 => (secs / 86_400, "day"),
        604_800..=2_591_999 => (secs / 604_800, "week"),
        2_592_000..=31_535_999 => (secs / 2_592_000, "month"),
        _ => (secs / 31_536_000, "year"),
    };
    format!("{n} {unit}{} ago", if n == 1 { "" } else { "s" })
}

#[derive(Default)]
struct CommitMeta {
    author: String,
    email: String,
    time: i64,
    summary: String,
    boundary: bool,
}

/// Porcelain: a header `<oid> <orig> <final> [<group size>]`, the commit's metadata the first time it appears, then the
/// line itself prefixed by a tab.
pub fn parse_porcelain(text: &str) -> Vec<BlameLine> {
    let mut metas: HashMap<String, CommitMeta> = HashMap::new();
    let mut lines = Vec::new();
    let mut current: Option<(String, u32)> = None;
    for raw in text.split('\n') {
        if let Some(content) = raw.strip_prefix('\t') {
            let Some((oid, final_line)) = current.take() else { continue };
            let meta = metas.get(&oid);
            lines.push(BlameLine {
                line: final_line,
                uncommitted: oid == ZERO_OID,
                author: meta.map_or_else(String::new, |m| m.author.clone()),
                author_email: meta.map_or_else(String::new, |m| m.email.clone()),
                date_ms: meta.map_or(0, |m| m.time * 1000),
                summary: meta.map_or_else(String::new, |m| m.summary.clone()),
                boundary: meta.is_some_and(|m| m.boundary),
                text: content.to_owned(),
                oid,
            });
            continue;
        }
        let mut f = raw.split(' ');
        let first = f.next().unwrap_or_default();
        if first.len() == 40 && first.bytes().all(|b| b.is_ascii_hexdigit()) {
            let final_line = f.nth(1).and_then(|n| n.parse().ok()).unwrap_or(0);
            metas.entry(first.to_owned()).or_default();
            current = Some((first.to_owned(), final_line));
            continue;
        }
        let Some((oid, _)) = &current else { continue };
        let meta = metas.entry(oid.clone()).or_default();
        if let Some(v) = raw.strip_prefix("author ") {
            meta.author = v.to_owned();
        } else if let Some(v) = raw.strip_prefix("author-mail ") {
            meta.email = v.trim_matches(|c| c == '<' || c == '>').to_owned();
        } else if let Some(v) = raw.strip_prefix("author-time ") {
            meta.time = v.parse().unwrap_or(0);
        } else if let Some(v) = raw.strip_prefix("summary ") {
            meta.summary = v.to_owned();
        } else if raw == "boundary" {
            meta.boundary = true;
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_times_read_naturally() {
        let now = 1_000_000_000_000;
        assert_eq!(relative_time(now, now - 5_000), "just now");
        assert_eq!(relative_time(now, now - 5 * 60_000), "5 minutes ago");
        assert_eq!(relative_time(now, now - 3_600_000), "1 hour ago");
        assert_eq!(relative_time(now, now - 3 * 86_400_000), "3 days ago");
        assert_eq!(relative_time(now, now - 800 * 86_400_000), "2 years ago");
        assert_eq!(relative_time(now, now + 10_000), "just now");
    }

    #[test]
    fn porcelain_groups_share_the_commit_metadata() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let text = format!(
            "{a} 1 1 2\nauthor Ann\nauthor-mail <ann@x>\nauthor-time 1700000000\nsummary First\nboundary\nfilename f\n\tone\n{a} 2 2\n\ttwo\n{b} 1 3 1\nauthor Bob\nauthor-time 1710000000\nsummary Second\nfilename f\n\tthree\n"
        );
        let lines = parse_porcelain(&text);
        assert_eq!(lines.len(), 3);
        assert_eq!((lines[1].line, lines[1].author.as_str(), lines[1].text.as_str()), (2, "Ann", "two"));
        assert!(lines[1].boundary);
        assert_eq!((lines[2].summary.as_str(), lines[2].date_ms), ("Second", 1_710_000_000_000));
        assert!(!lines[2].boundary);
    }
}
