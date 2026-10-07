//! Quick-open file index: `git ls-files` per repo, cached until the repo watcher reports a change.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use intely_core::guard::classify;
use intely_core::watcher::{watch, RepoWatcher};
use intely_core::{EngineError, GuardState};

use crate::types::{RepoId, RepoRoot};
use crate::{git_failure, nfc, Files};

struct Entry {
    files: Arc<Vec<String>>,
    dirty: Arc<AtomicBool>,
    /// Absent when the repo could not be watched; the entry is then recomputed on every request.
    _watcher: Option<RepoWatcher>,
}

#[derive(Default)]
pub struct IndexCache {
    repos: Mutex<HashMap<RepoId, Entry>>,
}

impl IndexCache {
    pub fn clear(&self) {
        self.repos.lock().expect("index lock").clear();
    }

    pub fn len(&self) -> usize {
        self.repos.lock().expect("index lock").len()
    }

    pub fn invalidate(&self, repo_id: &str) {
        if let Some(entry) = self.repos.lock().expect("index lock").get(repo_id) {
            entry.dirty.store(true, Ordering::SeqCst);
        }
    }

    fn fresh(&self, repo_id: &str) -> Option<Arc<Vec<String>>> {
        let repos = self.repos.lock().expect("index lock");
        let entry = repos.get(repo_id)?;
        (!entry.dirty.load(Ordering::SeqCst)).then(|| entry.files.clone())
    }
}

impl Files {
    /// Every tracked or untracked-but-not-ignored file that exists on disk, sorted; secret and never-add files are left out.
    pub async fn quick_open_index(&self, root: &RepoRoot) -> Result<Arc<Vec<String>>, EngineError> {
        if let Some(files) = self.index.fresh(&root.id) {
            return Ok(files);
        }
        // Cleared before the listing starts: a change during the listing marks the entry dirty again.
        let dirty = Arc::new(AtomicBool::new(false));
        let watcher = {
            let flag = dirty.clone();
            watch(&root.path, Arc::new(move || flag.store(true, Ordering::SeqCst))).ok()
        };
        if watcher.is_none() {
            dirty.store(true, Ordering::SeqCst);
        }
        let out = self.git_read(&root.path, &["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"]).await?;
        if !out.success() {
            return Err(git_failure("git ls-files", &out));
        }
        let base = root.path.clone();
        let stdout = out.stdout;
        let files = tokio::task::spawn_blocking(move || {
            let mut files: Vec<String> = stdout
                .split(|b| *b == 0)
                .filter(|p| !p.is_empty())
                .map(|p| nfc(&String::from_utf8_lossy(p)))
                .filter(|p| classify(p, true, None) == GuardState::Ok && std::fs::symlink_metadata(base.join(p)).is_ok())
                .collect();
            files.sort();
            files
        })
        .await
        .map_err(|e| crate::io_err("index", e))?;
        let files = Arc::new(files);
        self.index.repos.lock().expect("index lock").insert(root.id.clone(), Entry { files: files.clone(), dirty, _watcher: watcher });
        Ok(files)
    }
}
