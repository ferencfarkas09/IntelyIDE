//! The expanded Doctor: tool versions and paths, credential helper presence, PATH sanity for GUI-launched apps, stale
//! lock files, hooks, free disk space, large untracked directories and the IDE's own leftovers. It only reports.
//! Nothing is deleted or changed here; the one action it offers (`refreshEnv`) is applied by the app and is reversible.
//! Credential helpers are listed by name only; values, tokens and command lines never enter the report.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use crate::gh::find_in_path;
use crate::proc;
use crate::types::{DoctorCheck, DoctorItem, Level};

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;
/// A lock younger than this may belong to a git command that is running right now.
const STALE_LOCK_MINUTES: u64 = 10;
const LOCKS: [&str; 5] = ["index.lock", "HEAD.lock", "config.lock", "shallow.lock", "packed-refs.lock"];
const WALK_CAP: usize = 20_000;

pub struct DoctorOpts {
    /// The login-shell PATH the IDE starts tools from.
    pub login_path: String,
    /// The PATH this process was launched with (what a GUI-launched app gets).
    pub process_path: String,
    /// `ready`, `resolving` or `failed`: the state of the login-shell probe.
    pub env_state: String,
    pub repos: Vec<(String, PathBuf)>,
    pub data_dir: PathBuf,
    pub temp_dir: PathBuf,
    /// Substrings that mark a process as started by the IDE (the sidecar script, the git shim directory, the data dir).
    pub orphan_markers: Vec<String>,
    pub warn_free_bytes: u64,
    pub error_free_bytes: u64,
    /// Extra environment for the child processes (tests point `GIT_CONFIG_GLOBAL` at a fixture).
    pub env: Vec<(String, String)>,
    /// A directory younger than this is not a leftover.
    pub leftover_age: Duration,
    pub now: SystemTime,
}

impl DoctorOpts {
    pub fn new(login_path: String, process_path: String, env_state: String, repos: Vec<(String, PathBuf)>, data_dir: PathBuf) -> Self {
        Self {
            login_path,
            process_path,
            env_state,
            repos,
            data_dir,
            temp_dir: std::env::temp_dir(),
            orphan_markers: vec!["sidecar/dist/index.js".into(), "sidecar/index.js".into(), "intely-run-git-".into()],
            warn_free_bytes: 5 * GIB,
            error_free_bytes: GIB,
            env: Vec::new(),
            leftover_age: Duration::from_secs(24 * 3600),
            now: SystemTime::now(),
        }
    }
}

struct B(DoctorCheck);

fn check(group: &str, level: Level, code: &str) -> B {
    B(DoctorCheck { group: group.into(), level, code: code.into(), params: BTreeMap::new(), items: Vec::new(), repo_id: None, fix: None })
}

impl B {
    fn p(mut self, k: &str, v: impl ToString) -> Self {
        self.0.params.insert(k.into(), v.to_string());
        self
    }
    fn item(mut self, name: impl Into<String>) -> Self {
        self.0.items.push(DoctorItem { name: name.into(), ..Default::default() });
        self
    }
    fn items(mut self, items: Vec<DoctorItem>) -> Self {
        self.0.items = items;
        self
    }
    fn repo(mut self, id: &str) -> Self {
        self.0.repo_id = Some(id.into());
        self
    }
    fn fix(mut self, fix: &str) -> Self {
        self.0.fix = Some(fix.into());
        self
    }
}

fn minutes_since(opts: &DoctorOpts, t: SystemTime) -> u64 {
    opts.now.duration_since(t).map_or(0, |d| d.as_secs() / 60)
}

fn child(bin: &Path, args: &[&str], opts: &DoctorOpts, cwd: Option<&Path>) -> Option<proc::Out> {
    // git runs in (or reads the config of) the user's repositories: never let a repo's core.fsmonitor start a program
    let mut cmd = if bin.file_name().is_some_and(|n| n == "git") { intely_core::exec::hardened_git(bin) } else { Command::new(bin) };
    cmd.args(args).env("PATH", &opts.login_path).env("GIT_TERMINAL_PROMPT", "0").env("GH_NO_UPDATE_NOTIFIER", "1").env("LC_ALL", "C");
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    proc::run(cmd, Duration::from_secs(15)).ok()
}

fn version_of(bin: &Path, opts: &DoctorOpts) -> Option<String> {
    let o = child(bin, &["--version"], opts, None).filter(|o| o.ok)?;
    let line = o.stdout.lines().next()?.trim().to_owned();
    // "git version 2.50.1 (Apple Git-155)", "gh version 2.80.0 (2026-..)", "v24.1.0", "2.1.0 (Claude Code)", "codex-cli 0.40.0"
    let tok = line.split_whitespace().find(|t| t.trim_start_matches('v').chars().next().is_some_and(|c| c.is_ascii_digit())).unwrap_or(&line);
    Some(tok.trim_start_matches('v').to_owned())
}

// ---- tools ------------------------------------------------------------------------------------------------------------

fn tools(opts: &DoctorOpts, out: &mut Vec<DoctorCheck>) -> BTreeMap<&'static str, PathBuf> {
    let mut found = BTreeMap::new();
    for (name, missing) in [("git", Level::Error), ("node", Level::Warn), ("gh", Level::Info), ("claude", Level::Info), ("codex", Level::Info)] {
        match find_in_path(&opts.login_path, name) {
            None => out.push(check("tools", missing, "tool.missing").p("tool", name).0),
            Some(bin) => {
                let c = match version_of(&bin, opts) {
                    Some(v) => check("tools", Level::Ok, "tool.ok").p("tool", name).p("version", v),
                    None => check("tools", Level::Warn, "tool.noVersion").p("tool", name),
                };
                out.push(c.item(bin.to_string_lossy()).0);
                found.insert(name, bin);
            }
        }
    }
    found
}

// ---- credentials ------------------------------------------------------------------------------------------------------

/// The helper's name without its arguments or path: `osxkeychain`, `store`, `gh`; a `!` shell helper is "custom".
pub fn helper_name(raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        return String::new();
    }
    if raw.starts_with('!') {
        let rest = raw.trim_start_matches('!').trim();
        let words: Vec<&str> = rest.split_whitespace().collect();
        if words.first().is_some_and(|w| w.ends_with("/gh") || *w == "gh") && words.contains(&"git-credential") {
            return "gh".into();
        }
        return "custom".into();
    }
    let first = raw.split_whitespace().next().unwrap_or("");
    let base = first.rsplit('/').next().unwrap_or(first);
    base.strip_prefix("git-credential-").unwrap_or(base).to_owned()
}

fn credentials(opts: &DoctorOpts, git: Option<&Path>, out: &mut Vec<DoctorCheck>) {
    let Some(git) = git else { return };
    let probe = opts.repos.iter().map(|r| r.1.as_path()).find(|p| p.is_dir());
    let o = child(git, &["config", "--get-all", "credential.helper"], opts, probe);
    let names: Vec<String> = o.filter(|o| o.ok).map(|o| o.stdout.lines().map(helper_name).filter(|n| !n.is_empty()).collect::<BTreeSet<_>>().into_iter().collect()).unwrap_or_default();
    if names.is_empty() {
        out.push(check("credentials", Level::Warn, "cred.none").0);
        return;
    }
    let level = if names.iter().any(|n| n == "store") { Level::Warn } else { Level::Ok };
    let code = if level == Level::Warn { "cred.plaintext" } else { "cred.ok" };
    out.push(check("credentials", level, code).items(names.into_iter().map(|n| DoctorItem { name: n, ..Default::default() }).collect()).0);
}

// ---- PATH -------------------------------------------------------------------------------------------------------------

fn dirs(path: &str) -> Vec<&str> {
    path.split(':').filter(|d| !d.is_empty()).collect()
}

fn path_sanity(opts: &DoctorOpts, found: &BTreeMap<&'static str, PathBuf>, out: &mut Vec<DoctorCheck>) {
    if opts.env_state == "failed" {
        out.push(check("path", Level::Warn, "path.loginFailed").fix("refreshEnv").0);
    }
    let process: BTreeSet<&str> = dirs(&opts.process_path).into_iter().collect();
    let tool_dirs: BTreeSet<String> = found.values().filter_map(|p| p.parent()).map(|p| p.to_string_lossy().into_owned()).collect();
    let missing: Vec<&String> = tool_dirs.iter().filter(|d| !process.contains(d.as_str())).collect();
    if missing.is_empty() {
        out.push(check("path", Level::Ok, "path.guiOk").0);
    } else {
        out.push(check("path", Level::Info, "path.guiMinimal").p("count", missing.len()).items(missing.iter().map(|d| DoctorItem { name: (*d).clone(), ..Default::default() }).collect()).fix("refreshEnv").0);
    }
    let login = dirs(&opts.login_path);
    let gone: Vec<&str> = login.iter().copied().filter(|d| !Path::new(d).is_dir()).collect();
    let mut seen = BTreeSet::new();
    let dupes = login.iter().filter(|d| !seen.insert(**d)).count();
    if !gone.is_empty() || dupes > 0 {
        out.push(check("path", Level::Info, "path.untidy").p("missing", gone.len()).p("duplicates", dupes).items(gone.iter().take(8).map(|d| DoctorItem { name: (*d).to_owned(), ..Default::default() }).collect()).0);
    }
}

// ---- disk -------------------------------------------------------------------------------------------------------------

pub fn free_bytes(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a valid NUL-terminated path and `st` is a properly sized, writable statvfs.
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    #[allow(clippy::unnecessary_cast)]
    Some((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
}

fn disk(opts: &DoctorOpts, out: &mut Vec<DoctorCheck>) {
    // One line per volume: the repos and the IDE state directory that live on it.
    let mut volumes: BTreeMap<u64, (PathBuf, Vec<String>)> = BTreeMap::new();
    let mut add = |label: String, path: &Path| {
        let probe = path.ancestors().find(|a| a.exists()).unwrap_or(path);
        if let Ok(m) = fs::metadata(probe) {
            volumes.entry(m.dev()).or_insert_with(|| (probe.to_path_buf(), Vec::new())).1.push(label);
        }
    };
    for (id, p) in &opts.repos {
        add(id.clone(), p);
    }
    add("IDE state".to_owned(), &opts.data_dir);
    for (path, labels) in volumes.values() {
        let Some(free) = free_bytes(path) else { continue };
        let (level, code) = if free < opts.error_free_bytes {
            (Level::Error, "disk.critical")
        } else if free < opts.warn_free_bytes {
            (Level::Warn, "disk.low")
        } else {
            (Level::Ok, "disk.ok")
        };
        out.push(check("disk", level, code).p("free", free).p("warnBelow", opts.warn_free_bytes).items(labels.iter().map(|l| DoctorItem { name: l.clone(), ..Default::default() }).collect()).0);
    }
}

// ---- per repo ---------------------------------------------------------------------------------------------------------

fn git_dir(repo: &Path) -> Option<PathBuf> {
    let dot = repo.join(".git");
    if dot.is_dir() {
        return Some(dot);
    }
    let text = fs::read_to_string(&dot).ok()?;
    let rel = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let p = Path::new(rel);
    Some(if p.is_absolute() { p.to_path_buf() } else { repo.join(p) })
}

fn locks(opts: &DoctorOpts, id: &str, repo: &Path, out: &mut Vec<DoctorCheck>) {
    let Some(dir) = git_dir(repo) else { return };
    let mut stale = Vec::new();
    let mut fresh = Vec::new();
    for name in LOCKS {
        let Ok(m) = fs::metadata(dir.join(name)) else { continue };
        let age = m.modified().map_or(0, |t| minutes_since(opts, t));
        let item = DoctorItem { name: name.into(), age_minutes: Some(age), ..Default::default() };
        if age >= STALE_LOCK_MINUTES { stale.push(item) } else { fresh.push(item) }
    }
    if !stale.is_empty() {
        out.push(check("repo", Level::Warn, "lock.stale").repo(id).p("minutes", STALE_LOCK_MINUTES).items(stale).0);
    }
    if !fresh.is_empty() {
        out.push(check("repo", Level::Info, "lock.fresh").repo(id).items(fresh).0);
    }
}

fn hooks(opts: &DoctorOpts, git: &Path, id: &str, repo: &Path, out: &mut Vec<DoctorCheck>) {
    let configured = child(git, &["-C", &repo.to_string_lossy(), "config", "--get", "core.hooksPath"], opts, None).filter(|o| o.ok).map(|o| o.stdout.trim().to_owned()).filter(|s| !s.is_empty());
    let dir = match &configured {
        Some(p) => {
            let p = if let Some(rest) = p.strip_prefix("~/") { std::env::var_os("HOME").map(|h| Path::new(&h).join(rest)).unwrap_or_else(|| PathBuf::from(p)) } else { PathBuf::from(p) };
            if p.is_absolute() { p } else { repo.join(p) }
        }
        None => {
            let common = child(git, &["-C", &repo.to_string_lossy(), "rev-parse", "--git-common-dir"], opts, None).filter(|o| o.ok).map(|o| o.stdout.trim().to_owned());
            let common = common.map(PathBuf::from).map(|p| if p.is_absolute() { p } else { repo.join(p) }).or_else(|| git_dir(repo));
            match common {
                Some(c) => c.join("hooks"),
                None => return,
            }
        }
    };
    let mut present = Vec::new();
    let mut not_exec = Vec::new();
    for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(m) = e.metadata() else { continue };
        if !m.is_file() || name.ends_with(".sample") || name.starts_with('.') {
            continue;
        }
        if m.mode() & 0o111 == 0 { not_exec.push(name.clone()) }
        present.push(name);
    }
    present.sort();
    not_exec.sort();
    let shown = |names: Vec<String>| names.into_iter().map(|n| DoctorItem { name: n, ..Default::default() }).collect::<Vec<_>>();
    // `…At` variants carry the configured core.hooksPath.
    let at = configured.is_some();
    let mut c = match (present.is_empty(), at) {
        (true, false) => check("repo", Level::Info, "hooks.none"),
        (true, true) => check("repo", Level::Info, "hooks.noneAt"),
        (false, false) => check("repo", Level::Ok, "hooks.found").p("count", present.len()).items(shown(present)),
        (false, true) => check("repo", Level::Ok, "hooks.foundAt").p("count", present.len()).items(shown(present)),
    };
    c = c.repo(id);
    if let Some(p) = configured {
        c = c.p("hooksPath", p);
    }
    out.push(c.0);
    if !not_exec.is_empty() {
        out.push(check("repo", Level::Warn, "hooks.notExecutable").repo(id).items(shown(not_exec)).0);
    }
}

/// (files, bytes, capped) of a directory tree; symlinks are not followed.
fn measure(dir: &Path) -> (u64, u64, bool) {
    let (mut files, mut bytes, mut seen) = (0u64, 0u64, 0usize);
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).into_iter().flatten().flatten() {
            seen += 1;
            if seen > WALK_CAP {
                return (files, bytes, true);
            }
            let Ok(m) = e.path().symlink_metadata() else { continue };
            if m.is_dir() {
                stack.push(e.path());
            } else {
                files += 1;
                bytes += m.len();
            }
        }
    }
    (files, bytes, false)
}

fn untracked(opts: &DoctorOpts, git: &Path, id: &str, repo: &Path, out: &mut Vec<DoctorCheck>) {
    let Some(o) = child(git, &["--no-optional-locks", "-C", &repo.to_string_lossy(), "ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory"], opts, None).filter(|o| o.ok) else { return };
    let mut large = Vec::new();
    for line in o.stdout.lines().filter(|l| l.ends_with('/')).take(40) {
        let (files, bytes, capped) = measure(&repo.join(line.trim_end_matches('/')));
        if files >= 500 || bytes >= 50 * MIB {
            large.push((DoctorItem { name: line.to_owned(), count: Some(files), bytes: Some(bytes), age_minutes: None }, capped));
        }
    }
    if !large.is_empty() {
        large.sort_by_key(|(i, _)| std::cmp::Reverse(i.bytes));
        let capped = large.iter().any(|(_, c)| *c);
        out.push(check("repo", Level::Warn, "untracked.large").repo(id).p("capped", capped).items(large.into_iter().map(|(i, _)| i).take(10).collect()).0);
    }
}

// ---- leftovers --------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Orphan {
    pub pid: u32,
    pub age_minutes: u64,
    /// Program (and script) base names only, never the arguments.
    pub name: String,
}

fn etime_minutes(s: &str) -> u64 {
    let (days, rest) = s.split_once('-').map_or((0, s), |(d, r)| (d.parse().unwrap_or(0), r));
    let parts: Vec<u64> = rest.split(':').map(|p| p.parse().unwrap_or(0)).collect();
    let (h, m) = match parts.as_slice() {
        [h, m, _] => (*h, *m),
        [m, _] => (0, *m),
        _ => (0, 0),
    };
    days * 24 * 60 + h * 60 + m
}

/// Processes whose parent is launchd (pid 1) and whose command line carries one of the IDE's markers.
/// `ps_text` is `ps -axo pid=,ppid=,etime=,command=`; a process of someone else's, or still under a parent, is never listed.
pub fn find_orphans(ps_text: &str, markers: &[String]) -> Vec<Orphan> {
    let mut out = Vec::new();
    for line in ps_text.lines() {
        let mut it = line.split_whitespace();
        let (Some(pid), Some(ppid), Some(etime)) = (it.next().and_then(|p| p.parse::<u32>().ok()), it.next().and_then(|p| p.parse::<u32>().ok()), it.next()) else { continue };
        let words: Vec<&str> = it.collect();
        let command = words.join(" ");
        if ppid != 1 || words.is_empty() || !markers.iter().any(|m| !m.is_empty() && command.contains(m.as_str())) {
            continue;
        }
        let base = |w: &str| w.rsplit('/').next().unwrap_or(w).to_owned();
        let mut name = base(words[0]);
        if let Some(script) = words.iter().skip(1).find(|w| !w.starts_with('-') && (w.ends_with(".js") || w.ends_with(".mjs"))) {
            name = format!("{name} {}", base(script));
        }
        out.push(Orphan { pid, age_minutes: etime_minutes(etime), name });
    }
    out
}

fn dir_size(path: &Path) -> u64 {
    let m = path.symlink_metadata();
    match m {
        Ok(m) if m.is_dir() => measure(path).1,
        Ok(m) => m.len(),
        Err(_) => 0,
    }
}

fn leftovers(opts: &DoctorOpts, out: &mut Vec<DoctorCheck>) {
    if let Some(ps) = find_in_path("/bin:/usr/bin", "ps").and_then(|ps| child(&ps, &["-axo", "pid=,ppid=,etime=,command="], opts, None)).filter(|o| o.ok) {
        let orphans = find_orphans(&ps.stdout, &opts.orphan_markers);
        if orphans.is_empty() {
            out.push(check("leftovers", Level::Ok, "orphans.none").0);
        } else {
            out.push(
                check("leftovers", Level::Warn, "orphans.found")
                    .p("count", orphans.len())
                    .items(orphans.iter().map(|o| DoctorItem { name: format!("{} (pid {})", o.name, o.pid), age_minutes: Some(o.age_minutes), ..Default::default() }).collect())
                    .0,
            );
        }
    }
    let mut old = Vec::new();
    for e in fs::read_dir(&opts.temp_dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let lower = name.to_ascii_lowercase();
        if !(lower.starts_with("intely-") || lower.starts_with("intely_") || lower.starts_with("intelyswitchide")) {
            continue;
        }
        let Ok(m) = e.metadata() else { continue };
        let age = m.modified().map_or(0, |t| minutes_since(opts, t));
        if age * 60 >= opts.leftover_age.as_secs() {
            old.push(DoctorItem { name, bytes: Some(dir_size(&e.path())), age_minutes: Some(age), ..Default::default() });
        }
    }
    if old.is_empty() {
        out.push(check("leftovers", Level::Ok, "temp.none").0);
    } else {
        old.sort_by(|a, b| b.bytes.cmp(&a.bytes));
        out.push(check("leftovers", Level::Info, "temp.old").p("count", old.len()).p("bytes", old.iter().filter_map(|i| i.bytes).sum::<u64>()).items(old.into_iter().take(10).collect()).0);
    }
}

/// The whole report. Never fails: a check that cannot run is left out.
pub fn run(opts: &DoctorOpts) -> Vec<DoctorCheck> {
    let mut out = Vec::new();
    let found = tools(opts, &mut out);
    let git = found.get("git").cloned();
    credentials(opts, git.as_deref(), &mut out);
    path_sanity(opts, &found, &mut out);
    disk(opts, &mut out);
    for (id, path) in &opts.repos {
        if !path.is_dir() {
            continue;
        }
        locks(opts, id, path, &mut out);
        if let Some(git) = &git {
            hooks(opts, git, id, path, &mut out);
            untracked(opts, git, id, path, &mut out);
        }
    }
    leftovers(opts, &mut out);
    out
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
    fn the_doctor_child_helper_never_runs_core_fsmonitor_through_git() {
        let (d, repo, marker) = hostile_repo();
        let opts = DoctorOpts {
            login_path: "/usr/bin:/bin:/usr/local/bin".into(),
            process_path: "/usr/bin:/bin".into(),
            env_state: "ready".into(),
            repos: vec![],
            data_dir: d.path().join("data"),
            temp_dir: d.path().join("tmp"),
            orphan_markers: vec![],
            warn_free_bytes: 0,
            error_free_bytes: 0,
            env: vec![("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()), ("GIT_CONFIG_SYSTEM".into(), "/dev/null".into())],
            leftover_age: Duration::from_secs(60),
            now: SystemTime::now(),
        };
        let git = intely_core::exec::pinned_git_path();
        let o = child(&git, &["--no-optional-locks", "-C", &repo.to_string_lossy(), "status", "--porcelain"], &opts, None).expect("ran");
        assert!(o.ok && o.stdout.contains("a.txt"), "{}", o.stderr);
        let _ = child(&git, &["-C", &repo.to_string_lossy(), "ls-files", "--others", "--exclude-standard"], &opts, None);
        assert!(!marker.exists(), "the doctor executed core.fsmonitor");
    }
}
