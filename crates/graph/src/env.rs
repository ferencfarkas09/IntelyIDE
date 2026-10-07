//! What every graph call needs: the engine's git context plus a snapshot of the workspace.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use intely_core::exec::{run_git, GitCtx, GitOutput, RunOpts};
use intely_core::{code, EngineError, RepoConfig, Workspace};

/// Reads give up after this long; a rebase may run hooks and gets the longer write limit.
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const WRITE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub const UNKNOWN_REPO: &str = "unknownRepo";
pub const INVALID_ARGUMENT: &str = "invalidArgument";

#[derive(Clone)]
pub struct Env {
    pub git: GitCtx,
    pub ws: Workspace,
}

impl Env {
    pub fn new(git: GitCtx, ws: Workspace) -> Self {
        Self { git, ws }
    }

    pub fn repo(&self, repo_id: &str) -> Result<&RepoConfig, EngineError> {
        self.ws
            .repos
            .iter()
            .find(|r| r.id == repo_id)
            .ok_or_else(|| EngineError::new(UNKNOWN_REPO, format!("unknown repository id {repo_id:?}")))
    }

    pub fn path(&self, repo_id: &str) -> Result<PathBuf, EngineError> {
        Ok(PathBuf::from(&self.repo(repo_id)?.path))
    }

    /// Protected plus per-repo live branch patterns (the push rules of docs/safety.md, layer 6).
    pub fn live_patterns(&self, repo_id: &str) -> Vec<String> {
        let mut patterns = self.ws.protected_branches.clone();
        patterns.extend(self.ws.live_branches.get(repo_id).into_iter().flatten().cloned());
        patterns
    }

    /// A read-only git call; any exit code is returned to the caller.
    pub async fn run(&self, repo: &Path, args: &[&str]) -> Result<GitOutput, EngineError> {
        let opts = RunOpts { read_only: true, timeout: Some(READ_TIMEOUT), extra_env: literal_pathspecs(), ..RunOpts::default() };
        run_git(&self.git, repo, args, &opts).await
    }

    /// A read-only git call that must succeed; returns stdout.
    pub async fn read(&self, repo: &Path, args: &[&str]) -> Result<String, EngineError> {
        let out = self.run(repo, args).await?.ok_or_err(&format!("git {}", args.first().copied().unwrap_or("")))?;
        Ok(out.stdout_text().into_owned())
    }

    /// A mutating git call (the jail and the exec guard apply inside `run_git`) with the login-shell environment for hooks.
    pub async fn write(&self, repo: &Path, args: &[&str], extra_env: &[(&str, String)]) -> Result<GitOutput, EngineError> {
        let opts = RunOpts {
            login_env: true,
            timeout: Some(WRITE_TIMEOUT),
            extra_env: extra_env.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).chain(literal_pathspecs()).collect(),
            ..RunOpts::default()
        };
        run_git(&self.git, repo, args, &opts).await
    }
}

/// `GIT_LITERAL_PATHSPECS=1`: a path with glob characters (`[id].tsx`) names that file only.
fn literal_pathspecs() -> HashMap<String, String> {
    HashMap::from([("GIT_LITERAL_PATHSPECS".to_owned(), "1".to_owned())])
}

pub fn invalid(message: impl Into<String>) -> EngineError {
    EngineError::new(INVALID_ARGUMENT, message)
}

/// A hex object id as typed by the UI (full or abbreviated); anything else could be read as an option or a ref expression.
pub fn check_oid(oid: &str) -> Result<(), EngineError> {
    if (4..=64).contains(&oid.len()) && oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(invalid(format!("{oid:?} is not an object id")))
    }
}

/// A ref name or revision typed by the UI: must not look like an option or carry whitespace / control characters.
pub fn check_rev(rev: &str) -> Result<(), EngineError> {
    if rev.is_empty() || rev.starts_with('-') || rev.chars().any(|c| c.is_whitespace() || c.is_control()) {
        Err(invalid(format!("{rev:?} is not a valid revision")))
    } else {
        Ok(())
    }
}

pub fn git_error(what: &str, out: &GitOutput) -> EngineError {
    let how = out.code.map_or("killed".to_owned(), |c| format!("exit {c}"));
    EngineError::new(code::GIT, format!("{what} failed ({how})")).with_detail(out.stderr_text().trim().to_owned())
}
