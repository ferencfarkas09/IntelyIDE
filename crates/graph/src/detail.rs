//! Commit detail (files with stats) and file history.

use std::collections::HashMap;

use intely_core::exec::clean_rel_path;
use intely_core::{EngineError, RepoId};

use crate::env::{check_oid, Env};
use crate::lanes::Placement;
use crate::log::{parse_decorations, parse_records, row, FORMAT};
use crate::types::{ChangedPath, CommitDetail, FileKind, GraphRow};

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const HISTORY_LIMIT: u32 = 500;

pub async fn commit_detail(env: &Env, repo_id: &str, oid: &str) -> Result<CommitDetail, EngineError> {
    check_oid(oid)?;
    let repo = env.path(repo_id)?;
    // %B (the full message) is last: it may contain anything but NUL.
    let meta = env
        .read(
            &repo,
            &["show", "-s", "--no-color", "--decorate=full", "--format=%H%x00%P%x00%an%x00%ae%x00%ct%x00%D%x00%s%x00%B", &format!("{oid}^{{commit}}")],
        )
        .await?;
    let mut f = meta.splitn(8, '\0');
    let mut next = |what: &str| f.next().ok_or_else(|| EngineError::new(intely_core::code::GIT, format!("git show: missing {what}")));
    let full = next("oid")?.trim().to_owned();
    let parents: Vec<String> = next("parents")?.split_whitespace().map(str::to_owned).collect();
    let author = next("author")?.to_owned();
    let author_email = next("email")?.to_owned();
    let date_ms = next("date")?.parse::<i64>().map_err(|e| EngineError::new(intely_core::code::GIT, e.to_string()))? * 1000;
    let decorations = parse_decorations(next("refs")?);
    let subject = next("subject")?.to_owned();
    let message = next("message")?.trim_end().to_owned();

    let base = parents.first().map_or(EMPTY_TREE, String::as_str);
    let status_args = ["diff", "--name-status", "-z", "-M", "--no-color", "--no-ext-diff", base, &full, "--"];
    let stats_args = ["diff", "--numstat", "-z", "-M", "--no-color", "--no-ext-diff", base, &full, "--"];
    let (status, stats) = tokio::join!(env.read(&repo, &status_args), env.read(&repo, &stats_args));
    let files = merge_files(parse_name_status(&status?), parse_numstat(&stats?));
    let additions = files.iter().filter_map(|f| f.additions).sum();
    let deletions = files.iter().filter_map(|f| f.deletions).sum();
    Ok(CommitDetail {
        repo_id: repo_id.to_owned(),
        short_oid: full.chars().take(8).collect(),
        oid: full,
        parents,
        subject,
        message,
        author,
        author_email,
        date_ms,
        refs: decorations.iter().map(|d| d.name.clone()).collect(),
        decorations,
        files,
        additions,
        deletions,
    })
}

/// `M\0path\0`, `R100\0old\0new\0` (-z).
fn parse_name_status(text: &str) -> Vec<(FileKind, String, Option<String>)> {
    let mut parts = text.split('\0').filter(|p| !p.is_empty());
    let mut out = Vec::new();
    while let Some(status) = parts.next() {
        let kind = match status.chars().next() {
            Some('A') => FileKind::Added,
            Some('D') => FileKind::Deleted,
            Some('R') => FileKind::Renamed,
            Some('C') => FileKind::Copied,
            Some('T') => FileKind::TypeChange,
            _ => FileKind::Modified,
        };
        if matches!(kind, FileKind::Renamed | FileKind::Copied) {
            let (Some(old), Some(new)) = (parts.next(), parts.next()) else { break };
            out.push((kind, new.to_owned(), Some(old.to_owned())));
        } else {
            let Some(path) = parts.next() else { break };
            out.push((kind, path.to_owned(), None));
        }
    }
    out
}

/// `12\t3\tpath\0` or, for renames, `12\t3\t\0old\0new\0`; binary files report `-\t-`. Keyed by the new path.
fn parse_numstat(text: &str) -> HashMap<String, (Option<u32>, Option<u32>)> {
    let mut parts = text.split('\0');
    let mut out = HashMap::new();
    while let Some(entry) = parts.next() {
        let mut f = entry.splitn(3, '\t');
        let (Some(add), Some(del), Some(path)) = (f.next(), f.next(), f.next()) else { continue };
        let path = if path.is_empty() {
            let (_old, new) = (parts.next(), parts.next());
            new.unwrap_or_default().to_owned()
        } else {
            path.to_owned()
        };
        out.insert(path, (add.parse().ok(), del.parse().ok()));
    }
    out
}

fn merge_files(status: Vec<(FileKind, String, Option<String>)>, mut stats: HashMap<String, (Option<u32>, Option<u32>)>) -> Vec<ChangedPath> {
    status
        .into_iter()
        .map(|(kind, path, orig_path)| {
            let (additions, deletions) = stats.remove(&path).unwrap_or((None, None));
            ChangedPath { binary: additions.is_none() && deletions.is_none(), path, orig_path, kind, additions, deletions }
        })
        .collect()
}

/// Commits that touched `path`, following renames, newest first (no lanes: a file's history is a list).
pub async fn file_history(env: &Env, repo_id: &RepoId, path: &str) -> Result<Vec<GraphRow>, EngineError> {
    let repo = env.path(repo_id)?;
    let path = clean_rel_path(path)?;
    let n = format!("-n{HISTORY_LIMIT}");
    let out = env
        .read(&repo, &["-c", "log.showSignature=false", "log", "--no-color", "--follow", "--decorate=full", FORMAT, &n, "--", &path])
        .await?;
    Ok(parse_records(&out)
        .into_iter()
        .map(|c| row(repo_id, c, Placement { lane: 0, color: 0, edges: Vec::new(), width: 1 }))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_status_and_numstat_are_merged_by_path() {
        let status = parse_name_status("M\0a.txt\0R100\0old.txt\0new.txt\0A\0bin.png\0D\0gone.txt\0");
        assert_eq!(status.len(), 4);
        assert_eq!(status[1], (FileKind::Renamed, "new.txt".into(), Some("old.txt".into())));
        let stats_full = parse_numstat("2\t1\ta.txt\00\t0\t\0old.txt\0new.txt\0-\t-\tbin.png\05\t0\tgone.txt\0");
        let files = merge_files(status, stats_full);
        assert_eq!((files[0].additions, files[0].deletions), (Some(2), Some(1)));
        assert_eq!(files[1].orig_path.as_deref(), Some("old.txt"));
        assert!(files[2].binary);
        assert!(!files[3].binary);
    }
}
