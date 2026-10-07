//! Read-only git and file listing helpers. Only `rev-parse`, `ls-files` and `status` are ever run.

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

/// Tracked plus untracked-not-ignored files, relative with `/`. Falls back to a bounded directory walk outside git.
pub fn list_files(root: &Path) -> Vec<String> {
    if let Some(raw) = git(root, &["ls-files", "-z", "--cached", "--others", "--exclude-standard"]) {
        let mut v: Vec<String> = raw.split('\0').filter(|s| !s.is_empty()).filter(|s| root.join(s).is_file()).map(String::from).collect();
        v.sort();
        v.dedup();
        return v;
    }
    let mut out = Vec::new();
    walk(root, root, &mut out, 0);
    out.sort();
    out
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>, depth: usize) {
    if depth > 12 || out.len() > 60_000 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let p = e.path();
        if p.is_dir() {
            if !matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist" | "build") {
                walk(root, &p, out, depth + 1);
            }
        } else if let Ok(rel) = p.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

/// HEAD hash plus a hash of the dirty state (status lines with size and mtime of every changed file): the cache key of a repo.
pub fn fingerprint(root: &Path) -> String {
    let head = git(root, &["rev-parse", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_else(|| "nohead".into());
    let status = git(root, &["status", "--porcelain=v1", "-z", "-uall"]).unwrap_or_default();
    let mut h: u64 = 0xcbf29ce484222325;
    let mut eat = |b: &[u8]| {
        for x in b {
            h ^= *x as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    };
    for rec in status.split('\0').filter(|r| r.len() > 3) {
        eat(rec.as_bytes());
        if let Ok(m) = std::fs::metadata(root.join(&rec[3..])) {
            eat(&m.len().to_le_bytes());
            if let Ok(t) = m.modified().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).map_err(std::io::Error::other)) {
                eat(&t.as_millis().to_le_bytes());
            }
        }
    }
    format!("{}-{:x}", &head[..head.len().min(12)], h)
}
