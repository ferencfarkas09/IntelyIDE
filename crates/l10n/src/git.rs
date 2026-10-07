//! Read-only git access (status, show, diff, log, describe). Nothing here can change a repository.

use std::path::Path;
use std::process::Command;

pub fn git(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("--no-pager")
        .args(["-c", "core.quotepath=off", "-c", "core.fsmonitor=false"])
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Debug, Clone)]
pub struct Changed {
    pub path: String,
    pub untracked: bool,
}

/// Staged, unstaged and untracked files (individual files, not folders).
pub fn changed_files(root: &Path) -> Vec<Changed> {
    let Some(raw) = git(root, &["status", "--porcelain=v1", "-z", "-uall"]) else { return Vec::new() };
    let mut out = Vec::new();
    let mut it = raw.split('\0');
    while let Some(rec) = it.next() {
        if rec.len() < 4 {
            continue;
        }
        let (xy, path) = rec.split_at(2);
        let path = path[1..].to_string();
        if xy.contains('R') || xy.contains('C') {
            it.next();
        }
        if xy.contains('D') && !xy.contains('A') && xy.trim_start_matches(' ').starts_with('D') || xy == " D" {
            continue;
        }
        out.push(Changed { path, untracked: xy == "??" });
    }
    out
}

/// The committed version of a file; `None` when there is no HEAD or the file is new.
pub fn head_blob(root: &Path, rel: &str) -> Option<String> {
    git(root, &["show", &format!("HEAD:{rel}")])
}

/// Added lines (without the `+`) of a tracked file relative to HEAD.
pub fn added_lines(root: &Path, rel: &str) -> Option<Vec<String>> {
    let d = git(root, &["diff", "HEAD", "-U0", "--no-color", "--no-ext-diff", "--", rel])?;
    Some(d.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).map(|l| l[1..].to_string()).collect())
}
