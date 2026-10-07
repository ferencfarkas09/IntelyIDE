//! The GitHub CLI behind the jail. `gh` is found on the PATH it is given (the login-shell PATH in the app, a directory
//! with a fake in tests). In `INTELY_READONLY` no `gh` call that reaches the network runs; in `INTELY_E2E` only a `gh`
//! that lives under the fixture root (a fake) runs, never the real one. Tokens are never read: `gh` authenticates
//! itself, we only look at exit codes, and anything token-shaped is stripped from the text we hand back.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use intely_core::jail::{Jail, Mode, READ_ONLY, TEST_JAIL};
use intely_core::{code, EngineError};

use crate::proc::{self, Out};
use crate::types::GhStatus;

pub const GH_MISSING: &str = "ghMissing";
pub const GH_AUTH: &str = "ghAuth";

pub fn find_in_path(path: &str, bin: &str) -> Option<PathBuf> {
    path.split(':')
        .filter(|d| !d.is_empty())
        .map(|d| Path::new(d).join(bin))
        .find(|p| p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

/// Replaces anything shaped like a GitHub token. Defensive: `gh` does not print its token in the calls we make.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let rest = &text[i..];
        let starts = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"].iter().find(|p| rest.starts_with(**p));
        if let Some(p) = starts {
            let n = rest[p.len()..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(rest.len() - p.len());
            out.push_str("[token]");
            i += p.len() + n;
        } else {
            let ch = rest.chars().next().expect("non-empty");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

pub struct Gh {
    bin: PathBuf,
    path: String,
    jail: Arc<Jail>,
}

impl Gh {
    pub fn locate(jail: Arc<Jail>, path: &str) -> Result<Gh, EngineError> {
        let bin = find_in_path(path, "gh").ok_or_else(|| EngineError::new(GH_MISSING, "the GitHub CLI (gh) was not found on the PATH"))?;
        if jail.mode() == Mode::E2e && !jail.in_fixture(&bin) {
            return Err(EngineError::new(TEST_JAIL, "test jail (INTELY_E2E): the real gh is never used, only a fake under the fixture root"));
        }
        Ok(Gh { bin, path: path.to_owned(), jail })
    }

    pub fn path(&self) -> &Path {
        &self.bin
    }

    /// Whether a call that reaches the network may run for `repo` right now.
    pub fn network_allowed(&self, repo: &Path) -> Result<(), EngineError> {
        match self.jail.mode() {
            Mode::Off => Ok(()),
            Mode::ReadOnly => Err(EngineError::new(READ_ONLY, "read-only mode (INTELY_READONLY): no GitHub call runs")),
            Mode::E2e if self.jail.in_fixture(repo) => Ok(()),
            Mode::E2e => Err(EngineError::new(TEST_JAIL, "test jail (INTELY_E2E): this repo is outside the fixture root")),
        }
    }

    fn command(&self, repo: &Path, args: &[String]) -> Command {
        let mut cmd = Command::new(&self.bin);
        cmd.args(args).current_dir(repo);
        cmd.env("PATH", &self.path)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("GH_SPINNER_DISABLED", "1")
            .env("GH_PAGER", "cat")
            .env("GH_FORCE_TTY", "0")
            .env("NO_COLOR", "1")
            .env("GIT_TERMINAL_PROMPT", "0");
        cmd
    }

    /// Runs `gh <args>` in `repo` after the network rule. Output is token-redacted.
    pub fn run(&self, repo: &Path, args: &[String], timeout: Duration) -> Result<Out, EngineError> {
        self.network_allowed(repo)?;
        let mut o = proc::run(self.command(repo, args), timeout)?;
        o.stdout = redact(&o.stdout);
        o.stderr = redact(&o.stderr);
        Ok(o)
    }

    /// A call that must succeed; an auth failure becomes `ghAuth`.
    pub fn read(&self, repo: &Path, args: &[String]) -> Result<String, EngineError> {
        let o = self.run(repo, args, Duration::from_secs(25))?;
        if o.ok {
            return Ok(o.stdout);
        }
        Err(failure(&o))
    }

    /// `gh auth status` by exit code only; its text is dropped (it names the account).
    pub fn authenticated(&self, repo: &Path) -> Result<bool, EngineError> {
        Ok(self.run(repo, &["auth".into(), "status".into()], Duration::from_secs(15))?.ok)
    }

    pub fn version(&self) -> Option<String> {
        let mut cmd = Command::new(&self.bin);
        cmd.arg("--version").env("PATH", &self.path).env("GH_NO_UPDATE_NOTIFIER", "1");
        let o = proc::run(cmd, Duration::from_secs(5)).ok().filter(|o| o.ok)?;
        o.stdout.lines().next().map(|l| l.trim().trim_start_matches("gh version ").split(' ').next().unwrap_or("").to_owned()).filter(|v| !v.is_empty())
    }
}

pub fn failure(o: &Out) -> EngineError {
    let text = o.stderr.trim();
    let lower = text.to_ascii_lowercase();
    if lower.contains("gh auth login") || lower.contains("not logged in") || lower.contains("authentication") || lower.contains("http 401") {
        return EngineError::new(GH_AUTH, "gh is not signed in: run `gh auth login` in a terminal");
    }
    EngineError::new(code::GIT, format!("gh: {}", text.lines().next().unwrap_or("failed")))
}

/// What the PR tab shows before it calls anything that needs the network.
pub fn status(jail: Arc<Jail>, path: &str, repo: &Path) -> GhStatus {
    let gh = match Gh::locate(Arc::clone(&jail), path) {
        Ok(gh) => gh,
        Err(e) if e.code == GH_MISSING => return GhStatus { installed: false, version: None, path: None, authenticated: None, blocked: None },
        Err(e) => return GhStatus { installed: true, version: None, path: None, authenticated: None, blocked: Some(e.code) },
    };
    let (version, path) = (gh.version(), Some(gh.path().to_string_lossy().into_owned()));
    match gh.network_allowed(repo) {
        Err(e) => GhStatus { installed: true, version, path, authenticated: None, blocked: Some(e.code) },
        Ok(()) => GhStatus { installed: true, version, path, authenticated: gh.authenticated(repo).ok(), blocked: None },
    }
}
