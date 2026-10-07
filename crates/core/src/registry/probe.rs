//! `workspaces_probe`: where are the folders of a workspace and which branch are they on? File reads only, no git
//! process, every call bounded by a deadline ((design notes: workspaces-spec) 4.5, T15).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::fs::{mount_key, FsKind, FsProbe, Unresponsive};
use super::Registry;
use crate::{RepoProbe, RepoStatus, WorkspaceProbe};

/// Per repository.
pub const REPO_TIMEOUT: Duration = Duration::from_secs(2);
const CONCURRENCY: usize = 4;

/// Status, branch and detached flag of one repository folder, using only `fs`.
pub fn probe_repo(fs: &dyn FsProbe, path: &Path) -> (RepoStatus, Option<String>, bool) {
    use std::io::ErrorKind::{NotFound, PermissionDenied};
    let none = |s| (s, None, false);
    let st = match fs.stat_follow(path) {
        Ok(s) => s,
        Err(e) => {
            return match e.kind() {
                NotFound => {
                    if let Some(vol) = volume_root(path) {
                        if fs.stat_follow(&vol).is_err() {
                            return none(RepoStatus::VolumeMissing);
                        }
                    }
                    none(RepoStatus::Missing)
                }
                PermissionDenied => none(RepoStatus::NoAccess),
                _ => none(RepoStatus::Missing),
            };
        }
    };
    if st.kind != FsKind::Dir {
        return none(RepoStatus::NotRepo);
    }
    let dot_git = path.join(".git");
    let gitdir = match fs.stat_follow(&dot_git) {
        Ok(s) if s.kind == FsKind::Dir => dot_git,
        Ok(s) if s.kind == FsKind::File => {
            let Some(text) = fs.read_small(&dot_git, 4096).ok().and_then(|b| String::from_utf8(b).ok()) else { return none(RepoStatus::NotRepo) };
            let Some(target) = text.lines().next().and_then(|l| l.strip_prefix("gitdir:")).map(|t| t.trim().to_owned()) else { return none(RepoStatus::NotRepo) };
            if Path::new(&target).is_absolute() {
                PathBuf::from(target)
            } else {
                path.join(target)
            }
        }
        Err(e) if e.kind() == PermissionDenied => return none(RepoStatus::NoAccess),
        _ => return none(RepoStatus::NotRepo),
    };
    let Some(head) = fs.read_small(&gitdir.join("HEAD"), 4096).ok().and_then(|b| String::from_utf8(b).ok()) else { return none(RepoStatus::NotRepo) };
    let head = head.trim();
    if let Some(r) = head.strip_prefix("ref:") {
        let r = r.trim();
        return (RepoStatus::Ok, Some(r.strip_prefix("refs/heads/").unwrap_or(r).to_owned()), false);
    }
    if head.len() == 40 && head.bytes().all(|b| b.is_ascii_hexdigit()) {
        return (RepoStatus::Ok, None, true);
    }
    none(RepoStatus::NotRepo)
}

/// `/Volumes/<name>` when the path lives on an external volume.
fn volume_root(path: &Path) -> Option<PathBuf> {
    let key = mount_key(path);
    key.starts_with("/Volumes/").then(|| PathBuf::from(key))
}

impl Registry {
    /// Probes the repos of `ids` (all workspaces when `None`) with at most four concurrent probes, 2 s per repo and
    /// `deadline` in total. Repos that do not answer in time are `unresponsive`; a mount that hung once is skipped.
    pub fn probe(&self, ids: Option<&[String]>, deadline: Duration) -> Vec<WorkspaceProbe> {
        let started = Instant::now();
        let mut jobs: Vec<(usize, usize, String, String)> = Vec::new(); // (workspace slot, repo slot, repo id, path)
        let mut out: Vec<WorkspaceProbe> = Vec::new();
        let entries: Vec<String> = if self.loc.pinned.is_some() {
            vec!["pinned".to_owned()]
        } else {
            match self.read_file() {
                Ok(Some(f)) => f.sorted().into_iter().map(|e| e.entry.id.clone()).filter(|id| ids.is_none_or(|w| w.contains(id))).collect(),
                _ => Vec::new(),
            }
        };
        for id in entries {
            let Ok(ws) = self.load_workspace(&id) else { continue };
            let slot = out.len();
            out.push(WorkspaceProbe { id, repos: Vec::new() });
            for (i, r) in ws.repos.iter().enumerate() {
                out[slot].repos.push(RepoProbe { repo_id: r.id.clone(), status: RepoStatus::Unresponsive, branch: None, detached: false });
                jobs.push((slot, i, r.id.clone(), r.path.clone()));
            }
        }
        let results = Mutex::new(Vec::new());
        let next = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..CONCURRENCY.min(jobs.len()) {
                scope.spawn(|| loop {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    let Some((slot, idx, _, path)) = jobs.get(i) else { break };
                    let remaining = deadline.saturating_sub(started.elapsed());
                    let p = PathBuf::from(path);
                    let r = if remaining.is_zero() {
                        Err(Unresponsive)
                    } else {
                        self.prober.run(&mount_key(&p), remaining.min(REPO_TIMEOUT), move |fs| probe_repo(fs, &p))
                    };
                    results.lock().expect("probe results").push((*slot, *idx, r));
                });
            }
        });
        for (slot, idx, r) in results.into_inner().expect("probe results") {
            if let Ok((status, branch, detached)) = r {
                let p = &mut out[slot].repos[idx];
                p.status = status;
                p.branch = branch;
                p.detached = detached;
            }
        }
        out
    }
}
