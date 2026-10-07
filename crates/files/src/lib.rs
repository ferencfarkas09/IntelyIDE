//! Tauri-free backend of the `files` module (track C): file tree, editor reads and writes, quick open, search, branches,
//! stash and rollback. Types that cross the IPC boundary live in `types` and are exported to `ui/src/bindings/files.ts`
//! by `pnpm bindings`.
//!
//! Every path is repo-relative and resolved inside a registered [`RepoRoot`]; every git call goes through the engine's
//! exec layer (`intely_core::exec`), and every mutation passes `Jail::check_op` first (docs/safety.md).

mod branches;
mod encoding;
mod fsops;
mod index;
mod search;
mod watch;

pub mod types;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use intely_core::exec::{run_git, CancelToken, GitCtx, GitOutput, RunOpts};
use intely_core::{EngineError, EventSink, OpEvent, OpResult, RepoSnapshot};

pub use types::*;

pub mod codes {
    /// `writeFile` found the file changed on disk since the editor read it.
    pub const STALE_FILE: &str = "staleFile";
    /// Switching branches with uncommitted changes to tracked files.
    pub const DIRTY_TREE: &str = "dirtyTree";
    /// Deleting a branch that is not merged (retry with `force` after confirming).
    pub const NOT_MERGED: &str = "notMerged";
    /// Deleting a protected or live branch is never allowed.
    pub const PROTECTED_BRANCH: &str = "protectedBranch";
    pub const BRANCH_EXISTS: &str = "branchExists";
    pub const NO_SUCH_BRANCH: &str = "noSuchBranch";
    pub const NOTHING_TO_DO: &str = "nothingToDo";
    /// Creating or renaming onto a path that is taken.
    pub const EXISTS: &str = "exists";
}

/// Receiver of the module's events; the shell forwards them to the UI (`files:changed`, `search:results`).
pub trait FilesSink: Send + Sync {
    fn file_changed(&self, e: FileChanged);
    fn search_batch(&self, b: SearchBatch);
}

/// The git context needs an engine event sink; the files module never streams `op:event`s.
pub struct NullEngineSink;

impl EventSink for NullEngineSink {
    fn snapshot(&self, _: RepoSnapshot) {}
    fn op_event(&self, _: OpEvent) {}
    fn op_result(&self, _: OpResult) {}
    fn env(&self, _: intely_core::EnvStatus) {}
}

pub struct Files {
    git: GitCtx,
    sink: Arc<dyn FilesSink>,
    /// Login-shell environment for git commands that run hooks (`post-checkout`); set by the shell once resolved.
    hook_env: Mutex<HashMap<String, String>>,
    index: index::IndexCache,
    watches: watch::Watches,
    searches: Mutex<HashMap<String, CancelToken>>,
}

/// `GIT_LITERAL_PATHSPECS=1`: a file named `[id].tsx` is that file, not a glob over `i.tsx` and `d.tsx`.
fn literal_pathspecs() -> HashMap<String, String> {
    HashMap::from([("GIT_LITERAL_PATHSPECS".to_owned(), "1".to_owned())])
}

impl Files {
    pub fn new(git: GitCtx, sink: Arc<dyn FilesSink>) -> Self {
        Self {
            git,
            sink,
            hook_env: Mutex::default(),
            index: index::IndexCache::default(),
            watches: watch::Watches::default(),
            searches: Mutex::default(),
        }
    }

    pub fn set_hook_env(&self, env: HashMap<String, String>) {
        *self.hook_env.lock().expect("hook env lock") = env;
    }

    /// Workspace switch ((design notes: workspaces-spec) 4.10 row 8): drops every file watch and every repo watcher of the
    /// quick-open index with its cache, and cancels the running searches. Idempotent; the module is usable afterwards.
    pub fn reset(&self) {
        self.watches.clear();
        self.index.clear();
        let searches: Vec<CancelToken> = self.searches.lock().expect("searches lock").drain().map(|(_, t)| t).collect();
        searches.iter().for_each(CancelToken::cancel);
    }

    /// What is currently held open: (file watches, indexed repos, running searches). For the switch and its tests.
    pub fn open_resources(&self) -> (usize, usize, usize) {
        (self.watches.len(), self.index.len(), self.searches.lock().expect("searches lock").len())
    }

    /// A read-only git call: `Ok` even for a non-zero exit, the caller inspects the code.
    async fn git_read(&self, repo: &Path, args: &[&str]) -> Result<GitOutput, EngineError> {
        run_git(&self.git, repo, args, &RunOpts { read_only: true, extra_env: literal_pathspecs(), ..Default::default() }).await
    }

    async fn git_read_stdin(&self, repo: &Path, args: &[&str], stdin: Vec<u8>) -> Result<GitOutput, EngineError> {
        run_git(&self.git, repo, args, &RunOpts { read_only: true, stdin: Some(stdin), ..Default::default() }).await
    }

    /// A mutating git call (the exec guard checks the subcommand against the jail before the process starts).
    async fn git_write(&self, repo: &Path, args: &[&str], hooks: bool) -> Result<GitOutput, EngineError> {
        let mut extra_env = if hooks { self.hook_env.lock().expect("hook env lock").clone() } else { HashMap::new() };
        extra_env.extend(literal_pathspecs());
        run_git(&self.git, repo, args, &RunOpts { extra_env, ..Default::default() }).await
    }
}

/// Maps a failed git output to a typed error: a busy index lock keeps its own code.
fn git_failure(what: &str, out: &GitOutput) -> EngineError {
    let text = format!("{}{}", out.stderr_text(), out.stdout_text());
    if intely_core::exec::is_lock_busy(&text) {
        return EngineError::new(intely_core::code::LOCK_BUSY, format!("{what}: the repository is busy, try again"));
    }
    let how = out.code.map_or("killed".to_owned(), |c| format!("exit {c}"));
    EngineError::new(intely_core::code::GIT, format!("{what} failed ({how})")).with_detail(text.trim().to_owned())
}

pub(crate) fn io_err(what: impl std::fmt::Display, e: impl std::fmt::Display) -> EngineError {
    EngineError::new(intely_core::code::IO, format!("{what}: {e}"))
}

pub(crate) fn nfc(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    s.nfc().collect()
}
