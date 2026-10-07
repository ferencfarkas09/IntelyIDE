//! `git log --topo-order --parents` paging with lane assignment, merged across repos by commit time.

use std::collections::{BTreeMap, VecDeque};

use intely_core::exec::clean_rel_path;
use intely_core::{EngineError, RepoId};
use serde::{Deserialize, Serialize};

use crate::env::{check_rev, invalid, Env};
use crate::lanes::Lanes;
use crate::types::{GraphRow, LogFilters, LogPage, RefDecoration, RefKind, RepoStripe, LOG_PAGE_SIZE};

/// Record separator, then NUL-separated fields; the subject is last and never contains NUL.
pub const FORMAT: &str = "--format=%x1e%H%x00%P%x00%an%x00%ae%x00%ct%x00%D%x00%s";
const MAX_PAGE: u32 = 2000;

#[derive(Debug, Clone, PartialEq)]
pub struct RawCommit {
    pub oid: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub date_ms: i64,
    pub decorations: Vec<RefDecoration>,
    pub subject: String,
}

pub fn parse_records(text: &str) -> Vec<RawCommit> {
    text.split('\x1e')
        .filter(|r| !r.trim().is_empty())
        .filter_map(|record| {
            let mut f = record.splitn(7, '\0');
            let oid = f.next()?.trim().to_owned();
            let parents = f.next()?.split_whitespace().map(str::to_owned).collect();
            let author = f.next()?.to_owned();
            let email = f.next()?.to_owned();
            let date_ms = f.next()?.parse::<i64>().ok()? * 1000;
            let decorations = parse_decorations(f.next()?);
            let subject = f.next()?.trim_end_matches('\n').to_owned();
            Some(RawCommit { oid, parents, author, email, date_ms, decorations, subject })
        })
        .collect()
}

/// `%D` of `--decorate=full`: `HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main`.
pub fn parse_decorations(text: &str) -> Vec<RefDecoration> {
    let mut out = Vec::new();
    for item in text.split(", ").map(str::trim).filter(|i| !i.is_empty()) {
        let (current, item) = match item.strip_prefix("HEAD -> ") {
            Some(rest) => (true, rest),
            None => (false, item),
        };
        let decoration = if item == "HEAD" {
            RefDecoration { name: "HEAD".into(), kind: RefKind::Head, current: true }
        } else if let Some(tag) = item.strip_prefix("tag: refs/tags/") {
            RefDecoration { name: tag.into(), kind: RefKind::Tag, current }
        } else if let Some(branch) = item.strip_prefix("refs/heads/") {
            RefDecoration { name: branch.into(), kind: RefKind::Branch, current }
        } else if let Some(remote) = item.strip_prefix("refs/remotes/") {
            if remote.ends_with("/HEAD") {
                continue;
            }
            RefDecoration { name: remote.into(), kind: RefKind::Remote, current }
        } else {
            continue;
        };
        out.push(decoration);
    }
    out
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RepoCursor {
    skip: u32,
    lanes: Lanes,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Cursor {
    repos: BTreeMap<RepoId, RepoCursor>,
}

fn decode_cursor(cursor: &str) -> Result<Cursor, EngineError> {
    serde_json::from_str(cursor).map_err(|e| invalid(format!("bad log cursor: {e}")))
}

/// The arguments after `log` for one page of one repo.
fn log_args(filters: &LogFilters, skip: u32, count: u32) -> Result<Vec<String>, EngineError> {
    let mut args: Vec<String> = ["-c", "log.showSignature=false", "log", "--no-color", "--topo-order", "--parents", "--decorate=full", FORMAT]
        .map(str::to_owned)
        .into();
    args.push(format!("--skip={skip}"));
    args.push(format!("-n{count}"));
    if let Some(author) = filters.author.as_deref().filter(|a| !a.is_empty()) {
        args.push(format!("--author={author}"));
    }
    if let Some(text) = filters.text.as_deref().filter(|t| !t.is_empty()) {
        args.push(format!("--grep={text}"));
    }
    if filters.author.is_some() || filters.text.is_some() {
        args.extend(["--fixed-strings".into(), "--regexp-ignore-case".into()]);
    }
    if let Some(since) = filters.since_ms {
        args.push(format!("--since={}", since / 1000));
    }
    if let Some(until) = filters.until_ms {
        args.push(format!("--until={}", until / 1000));
    }
    match filters.branch.as_deref().filter(|b| !b.is_empty()) {
        Some(branch) => {
            check_rev(branch)?;
            args.extend(["--end-of-options".into(), branch.to_owned()]);
        }
        None => args.extend(["--exclude=refs/stash".into(), "--exclude=refs/notes/*".into(), "--all".into()]),
    }
    if let Some(path) = filters.path.as_deref().filter(|p| !p.is_empty()) {
        args.push("--".into());
        args.push(clean_rel_path(path)?);
    }
    Ok(args)
}

pub async fn fetch_commits(env: &Env, repo_id: &str, filters: &LogFilters, skip: u32, count: u32) -> Result<Vec<RawCommit>, EngineError> {
    let repo = env.path(repo_id)?;
    let args = log_args(filters, skip, count)?;
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = env.run(&repo, &refs).await?;
    if !out.success() {
        return Err(crate::env::git_error("git log", &out));
    }
    Ok(parse_records(&out.stdout_text()))
}

pub fn row(repo_id: &str, c: RawCommit, placement: crate::lanes::Placement) -> GraphRow {
    GraphRow {
        repo_id: repo_id.to_owned(),
        short_oid: c.oid.chars().take(8).collect(),
        refs: c.decorations.iter().map(|d| d.name.clone()).collect(),
        oid: c.oid,
        parents: c.parents,
        subject: c.subject,
        author: c.author,
        author_email: c.email,
        date_ms: c.date_ms,
        decorations: c.decorations,
        lane: placement.lane,
        color: placement.color,
        edges: placement.edges,
        width: placement.width,
    }
}

/// One page of the interleaved log. Per repo the order is `--topo-order`; between repos the head with the newest commit
/// time goes first. `cursor` and `filters` must be the ones of the previous call.
pub async fn log_page(
    env: &Env,
    repo_ids: &[RepoId],
    cursor: Option<&str>,
    filters: &LogFilters,
    limit: Option<u32>,
) -> Result<LogPage, EngineError> {
    let limit = limit.unwrap_or(LOG_PAGE_SIZE).clamp(1, MAX_PAGE);
    let mut active: BTreeMap<RepoId, RepoCursor> = match cursor {
        Some(c) => decode_cursor(c)?.repos,
        None => repo_ids.iter().map(|id| (id.clone(), RepoCursor::default())).collect(),
    };
    for id in active.keys() {
        env.repo(id)?;
    }

    // One extra commit per repo tells whether there is a next page.
    let mut tasks = Vec::new();
    for (id, rc) in &active {
        let (env, filters, id, skip) = (env.clone(), filters.clone(), id.clone(), rc.skip);
        tasks.push(tokio::spawn(async move {
            let commits = fetch_commits(&env, &id, &filters, skip, limit + 1).await;
            (id, commits)
        }));
    }
    let mut queues: BTreeMap<RepoId, VecDeque<RawCommit>> = BTreeMap::new();
    let mut first_error = None;
    for task in tasks {
        match task.await {
            Ok((id, Ok(commits))) => {
                queues.insert(id, commits.into());
            }
            Ok((id, Err(e))) => {
                active.remove(&id);
                first_error.get_or_insert(e);
            }
            Err(e) => return Err(EngineError::new(intely_core::code::IO, format!("log task failed: {e}"))),
        }
    }
    if queues.is_empty() {
        if let Some(e) = first_error {
            return Err(e);
        }
    }

    let mut rows = Vec::new();
    let mut consumed: BTreeMap<RepoId, u32> = BTreeMap::new();
    while rows.len() < limit as usize {
        let next = queues
            .iter()
            .filter_map(|(id, q)| q.front().map(|c| (id, c.date_ms)))
            .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0)))
            .map(|(id, _)| id.clone());
        let Some(id) = next else { break };
        let commit = queues.get_mut(&id).and_then(VecDeque::pop_front).expect("front was just seen");
        let rc = active.get_mut(&id).expect("queued repos are active");
        let placement = rc.lanes.place(&commit.oid, &commit.parents);
        *consumed.entry(id.clone()).or_default() += 1;
        rows.push(row(&id, commit, placement));
    }

    let mut next = Cursor::default();
    for (id, queue) in &queues {
        if !queue.is_empty() {
            let mut rc = active.remove(id).expect("queued repos are active");
            rc.skip += consumed.get(id).copied().unwrap_or(0);
            next.repos.insert(id.clone(), rc);
        }
    }
    let next_cursor = if next.repos.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&next).map_err(|e| EngineError::new(intely_core::code::IO, e.to_string()))?)
    };
    let repos = active_stripes(env, repo_ids, &queues);
    Ok(LogPage { rows, next_cursor, repos })
}

fn active_stripes(env: &Env, repo_ids: &[RepoId], queues: &BTreeMap<RepoId, VecDeque<RawCommit>>) -> Vec<RepoStripe> {
    let ids: Vec<&RepoId> = if repo_ids.is_empty() { queues.keys().collect() } else { repo_ids.iter().collect() };
    ids.into_iter()
        .filter_map(|id| env.repo(id).ok())
        .map(|r| RepoStripe { repo_id: r.id.clone(), name: r.name.clone(), color: r.color.clone(), badge: r.badge.clone() })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::RefKind;

    #[test]
    fn decorations_are_classified_and_the_current_branch_is_marked() {
        let d = parse_decorations("HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main, refs/remotes/origin/HEAD, refs/heads/dev");
        let got: Vec<(&str, RefKind, bool)> = d.iter().map(|d| (d.name.as_str(), d.kind.clone(), d.current)).collect();
        assert_eq!(
            got,
            vec![
                ("main", RefKind::Branch, true),
                ("v1", RefKind::Tag, false),
                ("origin/main", RefKind::Remote, false),
                ("dev", RefKind::Branch, false),
            ]
        );
        assert_eq!(parse_decorations("HEAD")[0].kind, RefKind::Head);
    }

    #[test]
    fn records_are_split_into_commits() {
        let text = "\x1eaaa\0bbb ccc\0Ann\0a@x\01700000000\0HEAD -> refs/heads/main\0Subject one\n\x1ebbb\0\0Bob\0b@x\01600000000\0\0Second\n";
        let commits = parse_records(text);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].parents, vec!["bbb", "ccc"]);
        assert_eq!(commits[0].date_ms, 1_700_000_000_000);
        assert_eq!(commits[0].subject, "Subject one");
        assert!(commits[1].parents.is_empty());
    }

    #[test]
    fn a_filter_never_becomes_an_option() {
        let f = LogFilters { branch: Some("--output=/tmp/x".into()), ..LogFilters::default() };
        assert!(log_args(&f, 0, 10).is_err());
        let f = LogFilters { path: Some("../x".into()), ..LogFilters::default() };
        assert!(log_args(&f, 0, 10).is_err());
    }
}
