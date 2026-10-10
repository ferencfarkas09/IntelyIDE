//! The file system the policy looks at.
//!
//! The broker judges commands and file operations against real files: a symlink inside the folder that points into `.git`, a glob that
//! expands to `.env`, a script that contains `git push`, a folder that exists or does not. For a run on this machine those files are
//! read with `std::fs`. For a run on a remote server they are the SERVER's files, which the IDE reaches through an RPC, so every look
//! of the policy goes through [`FsView`] instead of `std::fs`.
//!
//! The view in force is a thread-local scope: [`with_fs`] sets it for the closure, every look in the policy (`paths`, `glob`, the
//! hard-stop walker) calls the free functions of this module, and without a scope (or with `None`) they use [`LocalFs`]. `decide`
//! enters the scope with `PolicyContext::fs`; `hardstop::analyze*` and `Jail::new` take no context and use the scope of their caller,
//! so code that calls them directly for a remote run wraps the call in [`with_fs`]. The scope is per thread: a decision that is moved to
//! another thread must enter it on that thread.
//!
//! A view answers `None` for anything it cannot tell (missing, no access, a failed RPC). The policy reads `None` as "not there", exactly
//! like an error of `std::fs`. That is not enough for a view over a network: "the server did not answer" is not "the file is not there",
//! and a decision made on the second would be more lenient than the facts. So a view reports such a look with [`mark_failed`], and
//! [`failed`] tells the decision, at its end, that it saw only part of the tree; `decide` then denies. The mark belongs to the scope, that
//! is to the one decision on the one thread, so decisions that run side by side cannot clear each other's marks.
//! `LocalFs` is the default and costs one thread-local read per look.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// What a view knows about one file. `is_file` / `is_dir` / `is_symlink` are exclusive; a symlink that was followed shows what it
/// points to, and `symlink_metadata` shows the link itself (`is_symlink`, neither file nor dir).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FsMeta {
    pub is_file: bool,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub len: u64,
    /// Any execute bit is set.
    pub executable: bool,
}

/// One entry of a directory. `is_dir` / `is_symlink` describe the entry itself (no following), like `lstat`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

/// A read-only look at a file tree. Every method answers `None` when the file is missing, not readable or the view cannot tell.
pub trait FsView: Send + Sync {
    /// `stat`: follows symlinks.
    fn metadata(&self, p: &Path) -> Option<FsMeta>;
    /// `lstat`: does not follow.
    fn symlink_metadata(&self, p: &Path) -> Option<FsMeta>;
    /// The raw text of a link.
    fn read_link(&self, p: &Path) -> Option<PathBuf>;
    /// Plain `realpath`: `None` when the path does not exist.
    fn canonicalize(&self, p: &Path) -> Option<PathBuf>;
    /// Optional one-shot version of `paths::canonical_lossy` (follow links of the existing part, canonicalize the longest existing
    /// ancestor, re-append the rest). A remote view answers it in one round trip instead of one per path component. `None` = not
    /// provided, the policy computes it from `read_link` and `canonicalize`.
    fn canonical_lossy(&self, _p: &Path) -> Option<PathBuf> {
        None
    }
    fn read_dir(&self, p: &Path) -> Option<Vec<FsEntry>>;
    /// The text of a regular file. `max` is the size the caller is willing to read: a remote view returns `None` for a bigger file
    /// (the local view reads whatever is there; the callers that care about size check `FsMeta::len` first, as they always did).
    fn read_to_string(&self, p: &Path, max: usize) -> Option<String>;
    /// `true` only for the view of THIS machine: it enables checks that compare a file with the programs installed here.
    fn is_local(&self) -> bool {
        false
    }
}

/// `std::fs` on this machine.
#[derive(Debug, Clone, Copy, Default)]
pub struct LocalFs;

fn meta_of(m: &std::fs::Metadata) -> FsMeta {
    use std::os::unix::fs::PermissionsExt;
    let t = m.file_type();
    FsMeta { is_file: t.is_file(), is_dir: t.is_dir(), is_symlink: t.is_symlink(), len: m.len(), executable: m.permissions().mode() & 0o111 != 0 }
}

impl FsView for LocalFs {
    fn metadata(&self, p: &Path) -> Option<FsMeta> {
        std::fs::metadata(p).ok().map(|m| meta_of(&m))
    }
    fn symlink_metadata(&self, p: &Path) -> Option<FsMeta> {
        std::fs::symlink_metadata(p).ok().map(|m| meta_of(&m))
    }
    fn read_link(&self, p: &Path) -> Option<PathBuf> {
        std::fs::read_link(p).ok()
    }
    fn canonicalize(&self, p: &Path) -> Option<PathBuf> {
        std::fs::canonicalize(p).ok()
    }
    fn read_dir(&self, p: &Path) -> Option<Vec<FsEntry>> {
        let rd = std::fs::read_dir(p).ok()?;
        Some(
            rd.flatten()
                .map(|e| {
                    let t = e.file_type().ok();
                    FsEntry { name: e.file_name().to_string_lossy().into_owned(), is_dir: t.is_some_and(|t| t.is_dir()), is_symlink: t.is_some_and(|t| t.is_symlink()) }
                })
                .collect(),
        )
    }
    fn read_to_string(&self, p: &Path, _max: usize) -> Option<String> {
        std::fs::read_to_string(p).ok()
    }
    fn is_local(&self) -> bool {
        true
    }
}

thread_local! {
    /// The view of the running decision; `None` = [`LocalFs`].
    static CURRENT: RefCell<Option<Arc<dyn FsView>>> = const { RefCell::new(None) };
    /// `None` outside every scope. Inside one: did a look of this decision fail (see [`mark_failed`])?
    static FAILED: Cell<Option<bool>> = const { Cell::new(None) };
}

/// Puts the previous view and the previous failure mark back, also when the closure panics.
struct Restore(Option<Arc<dyn FsView>>, Option<bool>);

impl Drop for Restore {
    fn drop(&mut self) {
        let prev = self.0.take();
        let failed = self.1;
        // (the thread is going away when the slot is gone: nothing to restore then)
        let _ = CURRENT.try_with(|c| *c.borrow_mut() = prev);
        let _ = FAILED.try_with(|f| f.set(failed));
    }
}

type Cache<K, V> = Mutex<HashMap<K, Option<V>>>;

/// Remembers the answers of a non-local view for the length of one scope. A decision looks at the same few paths again and again (the
/// home, the working directory, the parents of every operand) and each look of a remote view is a round trip; the files do not change
/// while one command is being judged. The next decision enters a new scope and asks again.
struct Memo {
    inner: Arc<dyn FsView>,
    meta: Cache<PathBuf, FsMeta>,
    lmeta: Cache<PathBuf, FsMeta>,
    link: Cache<PathBuf, PathBuf>,
    real: Cache<PathBuf, PathBuf>,
    lossy: Cache<PathBuf, PathBuf>,
    dir: Cache<PathBuf, Vec<FsEntry>>,
    text: Cache<(PathBuf, usize), String>,
}

fn memo<K: std::hash::Hash + Eq, V: Clone>(c: &Cache<K, V>, key: K, ask: impl FnOnce() -> Option<V>) -> Option<V> {
    if let Some(hit) = c.lock().ok().and_then(|m| m.get(&key).cloned()) {
        return hit;
    }
    let got = ask();
    if let Ok(mut m) = c.lock() {
        m.insert(key, got.clone());
    }
    got
}

impl FsView for Memo {
    fn metadata(&self, p: &Path) -> Option<FsMeta> {
        memo(&self.meta, p.to_path_buf(), || self.inner.metadata(p))
    }
    fn symlink_metadata(&self, p: &Path) -> Option<FsMeta> {
        memo(&self.lmeta, p.to_path_buf(), || self.inner.symlink_metadata(p))
    }
    fn read_link(&self, p: &Path) -> Option<PathBuf> {
        memo(&self.link, p.to_path_buf(), || self.inner.read_link(p))
    }
    fn canonicalize(&self, p: &Path) -> Option<PathBuf> {
        memo(&self.real, p.to_path_buf(), || self.inner.canonicalize(p))
    }
    fn canonical_lossy(&self, p: &Path) -> Option<PathBuf> {
        memo(&self.lossy, p.to_path_buf(), || self.inner.canonical_lossy(p))
    }
    fn read_dir(&self, p: &Path) -> Option<Vec<FsEntry>> {
        memo(&self.dir, p.to_path_buf(), || self.inner.read_dir(p))
    }
    fn read_to_string(&self, p: &Path, max: usize) -> Option<String> {
        memo(&self.text, (p.to_path_buf(), max), || self.inner.read_to_string(p, max))
    }
    fn is_local(&self) -> bool {
        self.inner.is_local()
    }
}

/// Runs `f` with `fs` as the view of this thread (`None` = this machine). Scopes nest; the previous view is restored afterwards.
/// A view other than this machine's is asked at most once per path inside the scope (see `Memo`).
pub fn with_fs<R>(fs: Option<Arc<dyn FsView>>, f: impl FnOnce() -> R) -> R {
    let fs = fs.map(|inner| -> Arc<dyn FsView> {
        if inner.is_local() {
            inner
        } else {
            Arc::new(Memo { inner, meta: Cache::default(), lmeta: Cache::default(), link: Cache::default(), real: Cache::default(), lossy: Cache::default(), dir: Cache::default(), text: Cache::default() })
        }
    });
    let prev = CURRENT.with(|c| std::mem::replace(&mut *c.borrow_mut(), fs));
    let prev_failed = FAILED.with(|f| f.replace(Some(false)));
    let _restore = Restore(prev, prev_failed);
    f()
}

/// A view calls this for a look it could not answer, as opposed to a file that is not there: no reply from the server, a reply that makes
/// no sense, a listing that was cut off, a file too big to read. The decision in progress then knows it did not see everything. Ignored
/// outside a scope.
pub fn mark_failed() {
    let _ = FAILED.try_with(|f| {
        if f.get().is_some() {
            f.set(Some(true));
        }
    });
}

/// Did a look of the decision in progress (this thread, the innermost [`with_fs`]) fail? Always `false` for [`LocalFs`].
pub fn failed() -> bool {
    FAILED.try_with(|f| f.get() == Some(true)).unwrap_or(false)
}

/// Calls `f` with the view in force. The view is cloned out of the slot first, so a view may itself use [`with_fs`].
fn with_view<R>(f: impl FnOnce(&dyn FsView) -> R) -> R {
    match CURRENT.with(|c| c.borrow().clone()) {
        Some(v) => f(&*v),
        None => f(&LocalFs),
    }
}

pub fn metadata(p: &Path) -> Option<FsMeta> {
    with_view(|v| v.metadata(p))
}

pub fn symlink_metadata(p: &Path) -> Option<FsMeta> {
    with_view(|v| v.symlink_metadata(p))
}

pub fn read_link(p: &Path) -> Option<PathBuf> {
    with_view(|v| v.read_link(p))
}

pub fn canonicalize(p: &Path) -> Option<PathBuf> {
    with_view(|v| v.canonicalize(p))
}

/// The one-shot `canonical_lossy` of the view, if it has one (see [`FsView::canonical_lossy`]).
pub fn canonical_lossy_shortcut(p: &Path) -> Option<PathBuf> {
    with_view(|v| v.canonical_lossy(p))
}

pub fn read_dir(p: &Path) -> Option<Vec<FsEntry>> {
    with_view(|v| v.read_dir(p))
}

/// Largest file the policy asks a remote view for when the caller names no limit (the RPC hard cap).
pub const READ_MAX: usize = 1024 * 1024;

pub fn read_to_string(p: &Path) -> Option<String> {
    read_to_string_max(p, READ_MAX)
}

pub fn read_to_string_max(p: &Path, max: usize) -> Option<String> {
    with_view(|v| v.read_to_string(p, max))
}

/// `Path::exists`: follows symlinks, so a dangling link does not exist.
pub fn exists(p: &Path) -> bool {
    metadata(p).is_some()
}

pub fn is_dir(p: &Path) -> bool {
    metadata(p).is_some_and(|m| m.is_dir)
}

pub fn is_file(p: &Path) -> bool {
    metadata(p).is_some_and(|m| m.is_file)
}

/// Is the view in force this machine?
pub fn is_local() -> bool {
    with_view(|v| v.is_local())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Counting(AtomicUsize);

    impl FsView for Counting {
        fn metadata(&self, _: &Path) -> Option<FsMeta> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Some(FsMeta { is_dir: true, ..FsMeta::default() })
        }
        fn symlink_metadata(&self, _: &Path) -> Option<FsMeta> {
            None
        }
        fn read_link(&self, _: &Path) -> Option<PathBuf> {
            None
        }
        fn canonicalize(&self, _: &Path) -> Option<PathBuf> {
            None
        }
        fn read_dir(&self, _: &Path) -> Option<Vec<FsEntry>> {
            None
        }
        fn read_to_string(&self, _: &Path, _: usize) -> Option<String> {
            None
        }
    }

    #[test]
    fn default_is_local_and_scopes_nest() {
        assert!(is_local());
        let a: Arc<Counting> = Arc::new(Counting(AtomicUsize::new(0)));
        let view: Arc<dyn FsView> = a.clone();
        with_fs(Some(view), || {
            assert!(!is_local());
            assert!(is_dir(Path::new("/srv/nowhere")));
            with_fs(None, || {
                assert!(is_local());
                assert!(!exists(Path::new("/srv/nowhere")));
            });
            assert!(!is_local());
            assert!(exists(Path::new("/srv/nowhere/x")));
        });
        assert!(is_local());
        assert_eq!(a.0.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_remote_view_is_asked_once_per_path_inside_a_scope() {
        let a: Arc<Counting> = Arc::new(Counting(AtomicUsize::new(0)));
        let view: Arc<dyn FsView> = a.clone();
        with_fs(Some(view.clone()), || {
            for _ in 0..5 {
                assert!(is_dir(Path::new("/srv/x")));
            }
            assert!(is_dir(Path::new("/srv/y")));
        });
        assert_eq!(a.0.load(Ordering::SeqCst), 2);
        // a new scope asks again
        with_fs(Some(view), || assert!(exists(Path::new("/srv/x"))));
        assert_eq!(a.0.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_failed_look_belongs_to_its_scope() {
        // outside a scope there is nothing to mark
        mark_failed();
        assert!(!failed());
        let view: Arc<dyn FsView> = Arc::new(Counting(AtomicUsize::new(0)));
        with_fs(Some(view.clone()), || {
            assert!(!failed());
            mark_failed();
            assert!(failed());
            // an inner scope starts clean and does not hand its mark to the outer one
            with_fs(Some(view.clone()), || {
                assert!(!failed());
                mark_failed();
                assert!(failed());
            });
            assert!(failed(), "the outer mark is back");
        });
        assert!(!failed(), "nothing leaks out of the scope");
        // the next decision starts clean
        with_fs(Some(view), || assert!(!failed()));
    }

    #[test]
    fn a_mark_of_one_thread_is_not_seen_by_another() {
        let view: Arc<dyn FsView> = Arc::new(Counting(AtomicUsize::new(0)));
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let v2 = view.clone();
        let other = std::thread::spawn(move || {
            with_fs(Some(v2), || {
                mark_failed();
                tx.send(()).unwrap();
                done_rx.recv().unwrap();
                assert!(failed());
            });
        });
        rx.recv().unwrap();
        with_fs(Some(view), || assert!(!failed(), "a decision on this thread starts clean while the other still holds its mark"));
        done_tx.send(()).unwrap();
        other.join().unwrap();
    }

    #[test]
    fn scope_is_restored_after_a_panic() {
        let view: Arc<dyn FsView> = Arc::new(Counting(AtomicUsize::new(0)));
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| with_fs(Some(view), || panic!("boom"))));
        assert!(r.is_err());
        assert!(is_local());
    }

    #[test]
    fn scope_is_per_thread() {
        let view: Arc<dyn FsView> = Arc::new(Counting(AtomicUsize::new(0)));
        with_fs(Some(view), || {
            assert!(std::thread::spawn(is_local).join().unwrap());
        });
    }

    #[test]
    fn local_fs_reports_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir(root.join("d")).unwrap();
        std::fs::write(root.join("f.sh"), "echo").unwrap();
        std::os::unix::fs::symlink(root.join("d"), root.join("l")).unwrap();
        std::os::unix::fs::symlink(root.join("gone"), root.join("dangling")).unwrap();
        assert!(is_dir(&root.join("d")) && is_dir(&root.join("l")) && is_file(&root.join("f.sh")));
        assert!(!exists(&root.join("dangling")) && symlink_metadata(&root.join("dangling")).is_some_and(|m| m.is_symlink && !m.is_file && !m.is_dir));
        assert!(!metadata(&root.join("l")).unwrap().is_symlink && symlink_metadata(&root.join("l")).unwrap().is_symlink);
        assert_eq!(read_link(&root.join("l")), Some(root.join("d")));
        assert_eq!(read_to_string(&root.join("f.sh")).as_deref(), Some("echo"));
        let mut names: Vec<_> = read_dir(&root).unwrap().into_iter().map(|e| (e.name, e.is_dir, e.is_symlink)).collect();
        names.sort();
        assert_eq!(names, vec![("d".into(), true, false), ("dangling".into(), false, true), ("f.sh".into(), false, false), ("l".into(), false, true)]);
        assert_eq!(canonicalize(&root.join("l")), Some(root.join("d")));
        assert!(canonicalize(&root.join("gone")).is_none());
    }
}
