//! Read-only git for this crate: the pinned binary, optional locks off, and the jail's hardened environment in an
//! active jail. Nothing here mutates; the PR bridge never pushes.

use std::path::Path;
use std::time::Duration;

use intely_core::exec::{hardened_git, pinned_git_path};
use intely_core::jail::Jail;
use intely_core::{code, EngineError};

use crate::proc::{self, Out};

pub fn run(jail: &Jail, repo: &Path, args: &[&str]) -> Result<Out, EngineError> {
    let mut cmd = hardened_git(pinned_git_path());
    cmd.args(jail.config_args());
    cmd.args(["-c", "gc.auto=0", "-c", "maintenance.auto=false", "--no-optional-locks", "-C"]).arg(repo).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C");
    for (k, v) in jail.env() {
        cmd.env(k, v);
    }
    for k in jail.removed_env() {
        cmd.env_remove(k);
    }
    proc::run(cmd, Duration::from_secs(20))
}

/// Trimmed stdout of a command that must succeed.
pub fn read(jail: &Jail, repo: &Path, args: &[&str]) -> Result<String, EngineError> {
    let o = run(jail, repo, args)?;
    if o.ok {
        Ok(o.stdout.trim().to_owned())
    } else {
        Err(EngineError::new(code::GIT, format!("git {}: {}", args.first().copied().unwrap_or(""), o.stderr.trim())))
    }
}

/// Trimmed stdout, `None` when git fails or prints nothing.
pub fn try_read(jail: &Jail, repo: &Path, args: &[&str]) -> Option<String> {
    run(jail, repo, args).ok().filter(|o| o.ok).map(|o| o.stdout.trim().to_owned()).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod hardening_tests {
    use super::*;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new(intely_core::exec::pinned_git_path())
            .current_dir(dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "f@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "f@example.invalid")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A committed, dirty repo whose `core.fsmonitor` is a program that leaves `marker` behind. The control run proves
    /// that an unhardened git really executes it.
    fn hostile_repo() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let marker = root.join("marker");
        let script = root.join("hook.sh");
        std::fs::write(&script, format!("#!/bin/sh\n: > '{}'\nexit 0\n", marker.display())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(&repo, &["config", "core.fsmonitor", script.to_str().unwrap()]);
        std::fs::write(repo.join("a.txt"), "changed\n").unwrap();
        git(&repo, &["status", "--porcelain"]);
        assert!(marker.exists(), "control failed: a plain git status did not run core.fsmonitor");
        std::fs::remove_file(&marker).unwrap();
        (dir, repo, marker)
    }

    #[test]
    fn the_gitx_git_helper_never_runs_core_fsmonitor() {
        let (_d, repo, marker) = hostile_repo();
        let out = run(&Jail::off(), &repo, &["status", "--porcelain"]).unwrap();
        assert!(out.ok && out.stdout.contains("a.txt"), "{}", out.stderr);
        let _ = try_read(&Jail::off(), &repo, &["diff", "--stat"]);
        assert!(!marker.exists(), "intely-gitx executed core.fsmonitor");
    }
}
