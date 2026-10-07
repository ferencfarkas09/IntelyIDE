//! Bundles: commits in several repos that belong together. Recorded bundles come from one coordinated commit and live in
//! the IDE's own state file; heuristic ones are found by an identical subject within a time window. Nothing is ever
//! written to a commit message or to git.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

use intely_core::{code, EngineError, RepoId};
use serde::{Deserialize, Serialize};

use crate::blame::now_ms;
use crate::env::{check_oid, invalid, Env};
use crate::types::{Bundle, BundleCommit, BundleLink, BundleSource};

const FILE_NAME: &str = "graph-bundles.json";
const SCAN_COMMITS: &str = "-n300";
/// Two commits with the same subject belong together when they are at most this far apart.
pub const DEFAULT_WINDOW_MS: i64 = 10 * 60 * 1000;
const MAX_RECORDED: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Stored {
    id: String,
    name: String,
    branch: Option<String>,
    created_ms: i64,
    commits: Vec<StoredCommit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredCommit {
    repo_id: RepoId,
    oid: String,
    subject: String,
    date_ms: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    bundles: Vec<Stored>,
}

/// The persisted list of recorded bundles. `path` is `None` in tests that do not need persistence.
pub struct BundleStore {
    path: Option<PathBuf>,
    loaded: Mutex<Option<File>>,
}

impl BundleStore {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        Self { path: data_dir.map(|d| d.join(FILE_NAME)), loaded: Mutex::new(None) }
    }

    fn with<T>(&self, f: impl FnOnce(&mut File) -> T) -> T {
        let mut guard = self.loaded.lock().expect("bundle store lock");
        let file = guard.get_or_insert_with(|| self.load());
        f(file)
    }

    /// A damaged file is kept aside (`.corrupt`) and replaced by an empty list.
    fn load(&self) -> File {
        let Some(path) = &self.path else { return File::default() };
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| {
                let _ = std::fs::rename(path, path.with_extension("json.corrupt"));
                File::default()
            }),
            Err(_) => File::default(),
        }
    }

    fn save(&self, file: &File) -> Result<(), EngineError> {
        let Some(path) = &self.path else { return Ok(()) };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(file).map_err(|e| EngineError::new(code::IO, e.to_string()))?)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    fn recorded(&self) -> Vec<Stored> {
        self.with(|f| f.bundles.clone())
    }

    pub fn remove(&self, id: &str) -> Result<(), EngineError> {
        self.with(|f| {
            f.bundles.retain(|b| b.id != id);
            self.save(f)
        })
    }
}

struct CommitInfo {
    subject: String,
    date_ms: i64,
}

async fn commit_info(env: &Env, repo_id: &str, oid: &str) -> Result<(String, CommitInfo), EngineError> {
    check_oid(oid)?;
    let repo = env.path(repo_id)?;
    let spec = format!("{oid}^{{commit}}");
    let out = env.read(&repo, &["show", "-s", "--format=%H%x00%ct%x00%s", &spec]).await?;
    let mut f = out.trim_end().splitn(3, '\0');
    let (Some(full), Some(ct), Some(subject)) = (f.next(), f.next(), f.next()) else {
        return Err(EngineError::new(code::GIT, "unexpected output of git show"));
    };
    Ok((full.to_owned(), CommitInfo { subject: subject.to_owned(), date_ms: ct.parse::<i64>().unwrap_or(0) * 1000 }))
}

async fn current_branch(env: &Env, repo_id: &str) -> Option<String> {
    let repo = env.path(repo_id).ok()?;
    let out = env.run(&repo, &["symbolic-ref", "-q", "--short", "HEAD"]).await.ok()?;
    out.success().then(|| out.stdout_text().trim().to_owned())
}

/// Links the commits one coordinated commit created in several repos.
pub async fn record(env: &Env, store: &BundleStore, links: &[BundleLink], name: Option<&str>) -> Result<Bundle, EngineError> {
    let repos: BTreeSet<&str> = links.iter().map(|l| l.repo_id.as_str()).collect();
    if repos.len() < 2 || repos.len() != links.len() {
        return Err(invalid("a bundle links exactly one commit in each of at least two repositories"));
    }
    let mut commits = Vec::new();
    let mut branches = BTreeSet::new();
    for link in links {
        let (oid, info) = commit_info(env, &link.repo_id, &link.oid).await?;
        if let Some(b) = current_branch(env, &link.repo_id).await {
            branches.insert(b);
        }
        commits.push(StoredCommit { repo_id: link.repo_id.clone(), oid, subject: info.subject, date_ms: info.date_ms });
    }
    let stored = Stored {
        id: format!("r-{}", uuid::Uuid::new_v4().simple()),
        name: name.map(str::trim).filter(|n| !n.is_empty()).map_or_else(|| commits[0].subject.clone(), str::to_owned),
        branch: (branches.len() == 1).then(|| branches.into_iter().next()).flatten(),
        created_ms: now_ms(),
        commits,
    };
    store.with(|f| {
        f.bundles.push(stored.clone());
        if f.bundles.len() > MAX_RECORDED {
            let excess = f.bundles.len() - MAX_RECORDED;
            f.bundles.drain(..excess);
        }
        store.save(f)
    })?;
    Ok(present(&stored, &HashSet::new()))
}

fn present(s: &Stored, missing: &HashSet<(String, String)>) -> Bundle {
    Bundle {
        id: s.id.clone(),
        name: s.name.clone(),
        source: BundleSource::Recorded,
        branch: s.branch.clone(),
        created_ms: s.created_ms,
        repo_ids: s.commits.iter().map(|c| c.repo_id.clone()).collect(),
        commits: s
            .commits
            .iter()
            .map(|c| BundleCommit {
                repo_id: c.repo_id.clone(),
                short_oid: c.oid.chars().take(8).collect(),
                oid: c.oid.clone(),
                subject: c.subject.clone(),
                date_ms: c.date_ms,
                missing: missing.contains(&(c.repo_id.clone(), c.oid.clone())),
            })
            .collect(),
    }
}

/// Commits that no ref reaches any more (a rebase or amend rewrote them; the old objects linger until git collects them).
async fn find_missing(env: &Env, recorded: &[Stored]) -> HashSet<(String, String)> {
    let mut missing = HashSet::new();
    for s in recorded {
        for c in &s.commits {
            let exists = match env.path(&c.repo_id) {
                Ok(repo) => env
                    .run(&repo, &["for-each-ref", "--count=1", "--format=%(refname)", "--contains", &c.oid])
                    .await
                    .is_ok_and(|o| o.success() && !o.stdout_text().trim().is_empty()),
                Err(_) => false,
            };
            if !exists {
                missing.insert((c.repo_id.clone(), c.oid.clone()));
            }
        }
    }
    missing
}

struct Scanned {
    repo_id: RepoId,
    oid: String,
    subject: String,
    date_ms: i64,
}

async fn scan(env: &Env, repo_id: &str) -> Vec<Scanned> {
    let Ok(repo) = env.path(repo_id) else { return Vec::new() };
    let args = ["log", "--no-merges", "--format=%H%x00%ct%x00%s", SCAN_COMMITS, "--exclude=refs/stash", "--exclude=refs/notes/*", "--all"];
    let Ok(out) = env.read(&repo, &args).await else { return Vec::new() };
    out.lines()
        .filter_map(|l| {
            let mut f = l.splitn(3, '\0');
            Some(Scanned { repo_id: repo_id.to_owned(), oid: f.next()?.to_owned(), date_ms: f.next()?.parse::<i64>().ok()? * 1000, subject: f.next()?.to_owned() })
        })
        .collect()
}

/// Groups `commits` of different repos with an identical subject whose times fall within `window_ms` of the group's
/// first commit. One commit per repo and group (the newest); at least two repos.
fn cluster(mut commits: Vec<Scanned>, window_ms: i64) -> Vec<Vec<Scanned>> {
    commits.retain(|c| !c.subject.trim().is_empty());
    commits.sort_by(|a, b| a.subject.cmp(&b.subject).then(a.date_ms.cmp(&b.date_ms)));
    let mut groups: Vec<Vec<Scanned>> = Vec::new();
    for c in commits {
        match groups.last_mut() {
            Some(g) if g[0].subject == c.subject && c.date_ms - g[0].date_ms <= window_ms => g.push(c),
            _ => groups.push(vec![c]),
        }
    }
    groups
        .into_iter()
        .map(|g| {
            let mut newest: BTreeMap<RepoId, Scanned> = BTreeMap::new();
            for c in g {
                newest.insert(c.repo_id.clone(), c);
            }
            newest.into_values().collect::<Vec<_>>()
        })
        .filter(|g| g.len() >= 2)
        .collect()
}

/// Recorded bundles first (newest first), then heuristic ones, restricted to `repo_ids` when given.
pub async fn list(env: &Env, store: &BundleStore, repo_ids: &[RepoId], window_ms: Option<i64>) -> Result<Vec<Bundle>, EngineError> {
    let wanted = |id: &str| repo_ids.is_empty() || repo_ids.iter().any(|r| r == id);
    let mut recorded: Vec<Stored> = store.recorded().into_iter().filter(|s| s.commits.iter().any(|c| wanted(&c.repo_id))).collect();
    recorded.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
    let missing = find_missing(env, &recorded).await;
    let mut out: Vec<Bundle> = recorded.iter().map(|s| present(s, &missing)).collect();

    let known: HashSet<String> = recorded.iter().flat_map(|s| s.commits.iter().map(|c| c.oid.clone())).collect();
    let ids: Vec<RepoId> = env.ws.repos.iter().map(|r| r.id.clone()).filter(|id| wanted(id)).collect();
    let mut tasks = Vec::new();
    for id in ids {
        let env = env.clone();
        tasks.push(tokio::spawn(async move { scan(&env, &id).await }));
    }
    let mut all = Vec::new();
    for t in tasks {
        all.extend(t.await.map_err(|e| EngineError::new(code::IO, e.to_string()))?);
    }
    all.retain(|c| !known.contains(&c.oid));
    let mut found: Vec<Vec<Scanned>> = cluster(all, window_ms.unwrap_or(DEFAULT_WINDOW_MS));
    found.sort_by(|a, b| b[0].date_ms.cmp(&a[0].date_ms));
    for g in found {
        out.push(Bundle {
            id: format!("h-{}", g.iter().map(|c| &c.oid[..c.oid.len().min(12)]).min().unwrap_or_default()),
            name: g[0].subject.clone(),
            source: BundleSource::Heuristic,
            branch: None,
            created_ms: g.iter().map(|c| c.date_ms).max().unwrap_or(0),
            repo_ids: g.iter().map(|c| c.repo_id.clone()).collect(),
            commits: g
                .into_iter()
                .map(|c| BundleCommit { short_oid: c.oid.chars().take(8).collect(), repo_id: c.repo_id, oid: c.oid, subject: c.subject, date_ms: c.date_ms, missing: false })
                .collect(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(repo: &str, oid: &str, subject: &str, t: i64) -> Scanned {
        Scanned { repo_id: repo.into(), oid: oid.into(), subject: subject.into(), date_ms: t * 1000 }
    }

    #[test]
    fn identical_subjects_in_different_repos_within_the_window_form_a_bundle() {
        let groups = cluster(
            vec![
                s("api", "a1", "feat: add fleet", 1000),
                s("web", "w1", "feat: add fleet", 1100),
                s("web", "w2", "feat: add fleet", 1200),
                s("api", "a2", "fix: typo", 1000),
                s("web", "w3", "feat: add fleet", 90_000),
            ],
            DEFAULT_WINDOW_MS,
        );
        assert_eq!(groups.len(), 1);
        let ids: Vec<&str> = groups[0].iter().map(|c| c.oid.as_str()).collect();
        assert_eq!(ids, vec!["a1", "w2"]);
    }

    #[test]
    fn the_same_repo_twice_is_not_a_bundle() {
        assert!(cluster(vec![s("api", "a1", "x", 1), s("api", "a2", "x", 2)], DEFAULT_WINDOW_MS).is_empty());
    }

    #[test]
    fn a_damaged_store_is_set_aside_and_starts_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(FILE_NAME), "{ nope").expect("write");
        let store = BundleStore::new(Some(dir.path().to_path_buf()));
        assert!(store.recorded().is_empty());
        assert!(dir.path().join("graph-bundles.json.corrupt").exists());
    }
}
