//! Change notifications for the files an editor has open: one non-recursive watcher on the parent folder per file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use intely_core::exec::resolve_in_repo;
use intely_core::{code, EngineError};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use crate::types::{FileChangeKind, FileChanged, RepoRoot};
use crate::{io_err, Files, FilesSink};

const DEBOUNCE: Duration = Duration::from_millis(120);

/// The mtime (ms) the editor knows about; `None` while the file does not exist.
type Seen = Arc<Mutex<Option<f64>>>;

struct FileWatch {
    _watcher: RecommendedWatcher,
    seen: Seen,
}

#[derive(Default)]
pub struct Watches {
    files: Mutex<HashMap<(String, String), FileWatch>>,
}

impl Watches {
    pub fn clear(&self) {
        self.files.lock().expect("watch lock").clear();
    }

    pub fn len(&self) -> usize {
        self.files.lock().expect("watch lock").len()
    }

    /// Our own save is not an external change: remember its mtime so the event it causes is dropped.
    pub fn note_written(&self, repo_id: &str, rel: &str, mtime_ms: f64) {
        if let Some(w) = self.files.lock().expect("watch lock").get(&(repo_id.to_owned(), rel.to_owned())) {
            *w.seen.lock().expect("seen lock") = Some(mtime_ms);
        }
    }
}

fn stat(path: &Path) -> Option<f64> {
    let md = std::fs::metadata(path).ok()?;
    md.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as f64)
}

impl Files {
    /// Starts reporting `files:changed` for the file (idempotent). The file may not exist yet, but its folder must.
    pub fn watch_file(&self, root: &RepoRoot, rel_path: &str) -> Result<(), EngineError> {
        let key = (root.id.clone(), rel_path.to_owned());
        let mut files = self.watches.files.lock().expect("watch lock");
        if files.contains_key(&key) {
            return Ok(());
        }
        let target: PathBuf = resolve_in_repo(&root.path, rel_path)?;
        let parent = target.parent().ok_or_else(|| EngineError::new(code::INVALID_SELECTION, "no parent folder"))?.to_path_buf();
        let seen: Seen = Arc::new(Mutex::new(stat(&target)));

        let (tx, rx) = mpsc::channel::<()>();
        let watched = target.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            // An error means the stream lost track of something: let the stat decide.
            if res.map_or(true, |e| e.paths.iter().any(|p| p == &watched)) {
                let _ = tx.send(());
            }
        })
        .map_err(|e| io_err("watch", e))?;
        watcher.watch(&parent, RecursiveMode::NonRecursive).map_err(|e| io_err(parent.display(), e))?;

        let (sink, repo_id, rel, thread_seen): (Arc<dyn FilesSink>, _, _, Seen) =
            (self.sink.clone(), root.id.clone(), rel_path.to_owned(), seen.clone());
        std::thread::Builder::new().name("file-watcher".into()).spawn(move || {
            // Ends when the watcher (and with it the sender) is dropped.
            while rx.recv().is_ok() {
                loop {
                    match rx.recv_timeout(DEBOUNCE) {
                        Ok(()) => {}
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                let now = stat(&target);
                let mut seen = thread_seen.lock().expect("seen lock");
                let kind = match (*seen, now) {
                    (None, Some(_)) => FileChangeKind::Created,
                    (Some(_), None) => FileChangeKind::Deleted,
                    (Some(before), Some(after)) if before != after => FileChangeKind::Changed,
                    _ => continue,
                };
                *seen = now;
                drop(seen);
                sink.file_changed(FileChanged { repo_id: repo_id.clone(), path: rel.clone(), kind });
            }
        })?;
        files.insert(key, FileWatch { _watcher: watcher, seen });
        Ok(())
    }

    pub fn unwatch_file(&self, repo_id: &str, rel_path: &str) {
        self.watches.files.lock().expect("watch lock").remove(&(repo_id.to_owned(), rel_path.to_owned()));
    }
}
