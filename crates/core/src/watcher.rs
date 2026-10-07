//! One FSEvents watcher per repo root with its own trailing debounce (contract section 6.8).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::event::{EventKind, MetadataKind, ModifyKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use unicode_normalization::UnicodeNormalization;

use crate::{code, EngineError};

/// Quiet period after the last relevant event before `on_change` fires.
pub const DEBOUNCE: Duration = Duration::from_millis(220);
/// A sustained storm still fires at least this often.
const MAX_WAIT: Duration = Duration::from_millis(1500);
const MAX_CACHED_IGNORE_DIRS: usize = 4096;

/// Directory or file names that never matter to `git status` in practice (kept apart from the agent never-read list).
const EXCLUDED_NAMES: &[&str] = &["node_modules", "dist", "build", ".expo", "target", ".history", "_to_delete", ".DS_Store"];

enum Msg {
    Change,
    Stop,
}

/// Dropping the watcher stops it.
pub struct RepoWatcher {
    watcher: Option<RecommendedWatcher>,
    tx: Sender<Msg>,
}

impl Drop for RepoWatcher {
    fn drop(&mut self) {
        self.watcher = None;
        let _ = self.tx.send(Msg::Stop);
    }
}

/// Calls `on_change` (debounced 200-250 ms) after relevant filesystem changes under `root`.
pub fn watch(root: &Path, on_change: Arc<dyn Fn() + Send + Sync>) -> Result<RepoWatcher, EngineError> {
    let root = root
        .canonicalize()
        .map_err(|e| EngineError::new(code::REPO_MISSING, format!("{}: {e}", root.display())))?;
    let filter = PathFilter::new(&root);
    let (tx, rx) = mpsc::channel();

    std::thread::Builder::new()
        .name("repo-watcher-debounce".into())
        .spawn(move || debounce(&rx, on_change.as_ref()))?;

    let handler_tx = tx.clone();
    let handler = move |res: notify::Result<notify::Event>| {
        let relevant = match res {
            Ok(event) => is_relevant(&event, &filter),
            // The stream lost track of something: let the next status decide.
            Err(_) => true,
        };
        if relevant {
            let _ = handler_tx.send(Msg::Change);
        }
    };
    let started = notify::recommended_watcher(handler)
        .and_then(|mut w| w.watch(&root, RecursiveMode::Recursive).map(|()| w));
    match started {
        Ok(watcher) => Ok(RepoWatcher { watcher: Some(watcher), tx }),
        Err(e) => {
            let _ = tx.send(Msg::Stop);
            Err(EngineError::new(code::IO, format!("cannot watch {}: {e}", root.display())))
        }
    }
}

fn debounce(rx: &mpsc::Receiver<Msg>, on_change: &(dyn Fn() + Send + Sync)) {
    loop {
        match rx.recv() {
            Ok(Msg::Change) => {}
            Ok(Msg::Stop) | Err(_) => return,
        }
        let burst_start = Instant::now();
        loop {
            let left = MAX_WAIT.saturating_sub(burst_start.elapsed());
            if left.is_zero() {
                break;
            }
            match rx.recv_timeout(DEBOUNCE.min(left)) {
                Ok(Msg::Change) => {}
                Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                Err(RecvTimeoutError::Timeout) => break,
            }
        }
        on_change();
    }
}

fn is_relevant(event: &notify::Event, filter: &PathFilter) -> bool {
    match event.kind {
        EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(MetadataKind::Extended)) => return false,
        _ => {}
    }
    event.need_rescan() || event.paths.is_empty() || event.paths.iter().any(|p| filter.accepts(p))
}

/// Static rules (`.git` reduction, hard excludes) first, then the repo's `.gitignore` files.
struct PathFilter {
    root: PathBuf,
    root_nfc: String,
    ignores: Mutex<HashMap<PathBuf, Option<Arc<Gitignore>>>>,
}

impl PathFilter {
    fn new(root: &Path) -> Self {
        Self { root: root.to_owned(), root_nfc: nfc(root), ignores: Mutex::new(HashMap::new()) }
    }

    fn accepts(&self, abs: &Path) -> bool {
        let abs_nfc = nfc(abs);
        let Some(rel) = abs_nfc.strip_prefix(&self.root_nfc).and_then(|r| r.strip_prefix('/').or(r.is_empty().then_some(r)))
        else {
            return false;
        };
        passes_static_rules(rel) && !self.is_gitignored(abs)
    }

    fn is_gitignored(&self, abs: &Path) -> bool {
        // An event path that only matches the root after NFC normalisation cannot be matched against the files on disk.
        if !abs.starts_with(&self.root) {
            return false;
        }
        let mut dir = abs.parent();
        while let Some(d) = dir {
            if let Some(matcher) = self.matcher_for(d) {
                let m = matcher.matched_path_or_any_parents(abs, false);
                if m.is_ignore() {
                    return true;
                }
                if m.is_whitelist() {
                    return false;
                }
            }
            if d == self.root {
                break;
            }
            dir = d.parent();
        }
        false
    }

    fn matcher_for(&self, dir: &Path) -> Option<Arc<Gitignore>> {
        let mut cache = self.ignores.lock().expect("ignore cache lock");
        if let Some(cached) = cache.get(dir) {
            return cached.clone();
        }
        let mut builder = GitignoreBuilder::new(dir);
        let mut sources = vec![dir.join(".gitignore")];
        if dir == self.root {
            sources.push(dir.join(".git/info/exclude"));
        }
        sources.retain(|f| f.is_file());
        for file in &sources {
            // Unparsable lines are skipped by the crate; the valid ones still apply.
            let _ = builder.add(file);
        }
        let matcher = (!sources.is_empty()).then(|| builder.build().ok().map(Arc::new)).flatten();
        if cache.len() >= MAX_CACHED_IGNORE_DIRS {
            cache.clear();
        }
        cache.insert(dir.to_owned(), matcher.clone());
        matcher
    }
}

fn nfc(p: &Path) -> String {
    p.to_string_lossy().nfc().collect()
}

/// `rel` is repo-relative and NFC-normalised.
fn passes_static_rules(rel: &str) -> bool {
    let mut parts = rel.split('/').filter(|p| !p.is_empty()).peekable();
    if parts.peek() == Some(&".git") {
        parts.next();
        let inside: Vec<&str> = parts.collect();
        return git_dir_path_matters(&inside);
    }
    let mut prev = "";
    for part in parts {
        if EXCLUDED_NAMES.contains(&part)
            || part.starts_with("dump_")
            || part.starts_with("SERVER_MOVE")
            || (prev == "android" && part == ".cxx")
        {
            return false;
        }
        prev = part;
    }
    true
}

/// `.git` is reduced to what changes status, branches or the repo state.
fn git_dir_path_matters(inside: &[&str]) -> bool {
    let Some(first) = inside.first() else { return false };
    let last = inside.last().copied().unwrap_or_default();
    match *first {
        "HEAD" | "index" | "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "BISECT_LOG" => inside.len() == 1,
        "refs" => !last.ends_with(".lock"),
        "rebase-merge" | "rebase-apply" => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    use super::*;

    fn counter() -> (Arc<AtomicUsize>, Arc<dyn Fn() + Send + Sync>) {
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = n.clone();
        (n, Arc::new(move || {
            n2.fetch_add(1, Ordering::SeqCst);
        }))
    }

    fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while !cond() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// FSEvents may replay events from just before the stream started; let them pass, then reset.
    fn settle(n: &AtomicUsize) {
        std::thread::sleep(Duration::from_millis(900));
        n.store(0, Ordering::SeqCst);
    }

    fn repo_fixture() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".git/refs/heads")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        tmp
    }

    #[test]
    fn static_rules_reduce_git_and_exclude_heavy_dirs() {
        for rel in [
            "src/a.ts",
            "README.md",
            ".git/HEAD",
            ".git/index",
            ".git/MERGE_HEAD",
            ".git/CHERRY_PICK_HEAD",
            ".git/refs/heads/main",
            ".git/rebase-merge/head-name",
            "src/build.ts",
            "builder/x.ts",
            "árvíztűrő/tükörfúrógép.txt",
        ] {
            assert!(passes_static_rules(rel), "{rel} should pass");
        }
        for rel in [
            "node_modules/pkg/index.js",
            "packages/app/node_modules/x/y.js",
            "dist/main.js",
            "src/build/out.js",
            ".expo/web/a",
            "target/debug/x",
            "android/.cxx/obj/a.o",
            ".history/a_20260101.ts",
            "dump_2026/data.json",
            "SERVER_MOVE_1/x",
            "_to_delete/x",
            ".DS_Store",
            "src/.DS_Store",
            ".git/index.lock",
            ".git/objects/ab/cdef",
            ".git/refs/heads/main.lock",
            ".git/ide-index.123.0",
            ".git/logs/HEAD",
            ".git/HEAD.lock",
            ".git",
        ] {
            assert!(!passes_static_rules(rel), "{rel} should be filtered");
        }
        assert!(passes_static_rules("ios/.cxx/x"), "only android/.cxx is excluded");
    }

    #[test]
    fn gitignore_files_prefilter_events() {
        let tmp = repo_fixture();
        let root = tmp.path().canonicalize().unwrap();
        std::fs::write(root.join(".gitignore"), "*.log\ncoverage/\n!keep.log\n").unwrap();
        std::fs::create_dir_all(root.join("src/gen")).unwrap();
        std::fs::write(root.join("src/.gitignore"), "gen/\n").unwrap();
        let filter = PathFilter::new(&root);
        assert!(filter.accepts(&root.join("src/a.ts")));
        assert!(filter.accepts(&root.join("keep.log")));
        assert!(!filter.accepts(&root.join("a.log")));
        assert!(!filter.accepts(&root.join("coverage/lcov.info")));
        assert!(!filter.accepts(&root.join("src/gen/out.ts")));
        assert!(filter.accepts(&root.join("gen/out.ts")), "the nested rule only applies below src/");
        assert!(!filter.accepts(&root.parent().unwrap().join("elsewhere/a.ts")));
    }

    #[test]
    fn nfd_event_paths_are_matched_in_nfc() {
        let nfc_root = Path::new("/repos/\u{e1}rv\u{ed}z");
        let filter = PathFilter::new(nfc_root);
        let nfd_event = Path::new("/repos/a\u{301}rvi\u{301}z/src/x.ts");
        assert!(filter.accepts(nfd_event));
        assert!(!filter.accepts(Path::new("/repos/a\u{301}rvi\u{301}z/node_modules/x.js")));
    }

    #[test]
    fn a_real_change_fires_once_after_the_debounce() {
        let tmp = repo_fixture();
        let root = tmp.path().canonicalize().unwrap();
        let (n, cb) = counter();
        let _w = watch(&root, cb).unwrap();
        settle(&n);

        let t = Instant::now();
        std::fs::write(root.join("src/a.ts"), "x").unwrap();
        wait_until("the first refresh", || n.load(Ordering::SeqCst) >= 1);
        assert!(t.elapsed() >= Duration::from_millis(150), "fired before the debounce: {:?}", t.elapsed());
        std::thread::sleep(Duration::from_millis(700));
        assert_eq!(n.load(Ordering::SeqCst), 1);

        std::fs::write(root.join(".git/index"), "i").unwrap();
        wait_until("the index refresh", || n.load(Ordering::SeqCst) >= 2);
    }

    #[test]
    fn file_storm_coalesces_into_a_handful_of_refreshes() {
        let tmp = repo_fixture();
        let root = tmp.path().canonicalize().unwrap();
        let (n, cb) = counter();
        let _w = watch(&root, cb).unwrap();
        settle(&n);

        for i in 0..2000 {
            std::fs::write(root.join(format!("src/f{i}.ts")), "x").unwrap();
        }
        wait_until("a refresh", || n.load(Ordering::SeqCst) >= 1);
        std::thread::sleep(Duration::from_millis(1000));
        let fired = n.load(Ordering::SeqCst);
        assert!((1..=5).contains(&fired), "2000 files produced {fired} refreshes");
    }

    #[test]
    fn excluded_and_ignored_paths_never_fire() {
        let tmp = repo_fixture();
        let root = tmp.path().canonicalize().unwrap();
        std::fs::write(root.join(".gitignore"), "*.log\n").unwrap();
        std::fs::create_dir_all(root.join("dist")).unwrap();
        let (n, cb) = counter();
        let _w = watch(&root, cb).unwrap();
        settle(&n);

        for i in 0..300 {
            std::fs::write(root.join(format!("node_modules/pkg/f{i}.js")), "x").unwrap();
            std::fs::write(root.join(format!("dist/f{i}.js")), "x").unwrap();
        }
        std::fs::write(root.join("debug.log"), "x").unwrap();
        std::fs::write(root.join(".git/index.lock"), "x").unwrap();
        std::thread::sleep(Duration::from_millis(1200));
        assert_eq!(n.load(Ordering::SeqCst), 0);

        std::fs::write(root.join("src/real.ts"), "x").unwrap();
        wait_until("the real change", || n.load(Ordering::SeqCst) >= 1);
    }

    #[test]
    fn dropping_the_watcher_stops_callbacks() {
        let tmp = repo_fixture();
        let root = tmp.path().canonicalize().unwrap();
        let (n, cb) = counter();
        let w = watch(&root, cb).unwrap();
        settle(&n);
        std::fs::write(root.join("src/a.ts"), "x").unwrap();
        wait_until("a refresh", || n.load(Ordering::SeqCst) >= 1);
        drop(w);
        let after_drop = n.load(Ordering::SeqCst);
        std::fs::write(root.join("src/b.ts"), "x").unwrap();
        std::thread::sleep(Duration::from_millis(800));
        assert_eq!(n.load(Ordering::SeqCst), after_drop);
    }

    #[test]
    fn watching_a_missing_directory_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, cb) = counter();
        let err = watch(&tmp.path().join("missing"), cb).err().expect("must fail");
        assert_eq!(err.code, code::REPO_MISSING);
    }

    /// Resident set size in KiB.
    fn rss_kib() -> u64 {
        let out = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
    }

    #[test]
    fn node_modules_heavy_tree_keeps_memory_flat() {
        let tmp = repo_fixture();
        let root = tmp.path().canonicalize().unwrap();
        for pkg in 0..150 {
            let dir = root.join(format!("node_modules/pkg{pkg}/lib"));
            std::fs::create_dir_all(&dir).unwrap();
            for f in 0..60 {
                std::fs::write(dir.join(format!("m{f}.js")), "module.exports = 1;\n").unwrap();
            }
        }
        std::thread::sleep(Duration::from_millis(900));

        let before = rss_kib();
        let (n, cb) = counter();
        let _w = watch(&root, cb).unwrap();
        settle(&n);
        for round in 0..3 {
            for pkg in 0..150 {
                std::fs::write(root.join(format!("node_modules/pkg{pkg}/lib/m0.js")), format!("// {round}\n")).unwrap();
            }
        }
        std::thread::sleep(Duration::from_millis(1000));
        let growth_mib = rss_kib().saturating_sub(before) / 1024;
        assert_eq!(n.load(Ordering::SeqCst), 0, "node_modules writes must not refresh");
        assert!(growth_mib < 40, "RSS grew by {growth_mib} MiB watching 9,000 node_modules files");
    }
}
