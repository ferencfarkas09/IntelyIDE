//! `git init`: the only place where the IDE creates a repository ((design notes: workspaces-spec) 3.6.5, invariant I6).
//!
//! Everything goes through the exec layer, so the jail judges it like any other mutation (`init` is one of
//! `MUTATING_COMMANDS`): refused in read-only mode and outside the fixture root of a test jail. Whether the user
//! confirmed and whether the folder is sensible to initialise (`initTooBroad`) is decided by the caller; this module
//! only guarantees that nothing else than a plain, template-less `git init` happens in an existing directory.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use crate::env::{EnvOptions, EnvResolver};
use crate::exec::{pinned_git_path, run_git, GitCtx, RunOpts};
use crate::jail::Jail;
use crate::{code, EngineError, EnvStatus, EventSink, OpEvent, OpResult, RepoSnapshot};

/// `EngineError.code` when the folder already holds a `.git` entry.
pub const ALREADY_REPO: &str = "alreadyRepo";
/// `EngineError.code` for a branch name that is not a plain ref name.
pub const INVALID_BRANCH: &str = "invalidBranch";

const INIT_TIMEOUT: Duration = Duration::from_secs(30);

struct DiscardSink;

impl EventSink for DiscardSink {
    fn snapshot(&self, _: RepoSnapshot) {}
    fn op_event(&self, _: OpEvent) {}
    fn op_result(&self, _: OpResult) {}
    fn env(&self, _: EnvStatus) {}
}

/// Conservative ref-name check: letters, digits, `.`, `_`, `-` and `/`; no leading `-` or `/`, no `..`, no `//`, no
/// trailing `/`, `.` or `.lock`, at most 100 bytes.
pub fn valid_branch_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'))
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("/.")
}

/// `git init -b <initial_branch>` in the existing directory `dir` under `jail`, with a fresh [`GitCtx`] (pinned git,
/// no events). The jail is consulted before any process exists.
pub async fn init_repo(jail: &Arc<Jail>, dir: &Path, initial_branch: &str) -> Result<(), EngineError> {
    let git = pinned_git_path();
    let env = Arc::new(EnvResolver::with_options(&git.to_string_lossy(), EnvOptions { cache_path: None, ..Default::default() }));
    let ctx = GitCtx::new(git, env, Arc::new(DiscardSink)).with_jail(jail.clone());
    init_repo_with(&ctx, dir, initial_branch).await
}

/// [`init_repo`] over an existing context (the engine's own, or a test's).
pub async fn init_repo_with(ctx: &GitCtx, dir: &Path, initial_branch: &str) -> Result<(), EngineError> {
    if !valid_branch_name(initial_branch) {
        return Err(EngineError::new(INVALID_BRANCH, "the initial branch name is not valid"));
    }
    ctx.jail.check_op("git init", dir)?;
    // Not `exists()`: a dangling `.git` symlink is as much "already something" as a real one.
    if std::fs::symlink_metadata(dir.join(".git")).is_ok() {
        return Err(EngineError::new(ALREADY_REPO, format!("{} already has a .git entry", dir.display())));
    }
    // No templates: a global `init.templateDir` or GIT_TEMPLATE_DIR must not plant hooks into the new repository
    // (`--template=` wins over both; the `-c` is belt and braces).
    let opts = RunOpts { timeout: Some(INIT_TIMEOUT), ..Default::default() };
    let args = ["-c", "init.templateDir=", "init", "-q", "--template=", "-b", initial_branch];
    let out = run_git(ctx, dir, &args, &opts).await?;
    if !out.success() {
        return Err(EngineError::new(code::GIT, "git init failed").with_detail(out.stderr_text().trim().to_owned()));
    }
    Ok(())
}
