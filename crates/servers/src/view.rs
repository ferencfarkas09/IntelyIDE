//! The read-only view of a server's working copy: one bounded `git status` over the shared ssh connection, and the diff of one file on
//! demand. Nothing here writes on the server: git runs with optional locks off, `core.fsmonitor` off, no hooks, no pager, no external
//! diff or textconv. The folder is the resolved physical one (`~` expands on the server); the result uses the same `Change` records as
//! the Changes tree of a local repository and carries `source: server(<name>)`.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use intely_core::guard;
use intely_core::parse::status_v2::parse_status_v2;
use intely_core::{Change, ChangeKind, FileContents, GuardState};
use serde::Serialize;

use crate::cfg::{validate_repo_path, ServerCfg};
use crate::quote::{sh_quote, sh_quote_path_for_remote};
use crate::ssh::{Ssh, SshError};

/// Files listed at most; the rest is only counted.
pub const MAX_FILES: usize = 500;
/// A diff of one file bigger than this is not shown.
pub const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
/// Wall clock of one status or diff call.
pub const TIMEOUT: Duration = Duration::from_secs(15);
const STATUS_BYTES: usize = 2_000_000;

/// The one way git is started on the server by this crate: read-only, no hook, no pager, no external program.
pub(crate) const SHELL_PRELUDE: &str = r#"GIT_OPTIONAL_LOCKS=0; GIT_CONFIG_NOSYSTEM=1; GIT_TERMINAL_PROMPT=0; GIT_PAGER=cat; GIT_LITERAL_PATHSPECS=1; LC_ALL=C
export GIT_OPTIONAL_LOCKS GIT_CONFIG_NOSYSTEM GIT_TERMINAL_PROMPT GIT_PAGER GIT_LITERAL_PATHSPECS LC_ALL
G() { git --no-optional-locks --no-replace-objects -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.pager=cat -c core.quotePath=false -c core.editor=true -c diff.external= "$@"; }
"#;

/// `ssh host sh -c '<script>'`: the script is ONE quoted word, so the login shell of the server never parses it.
pub(crate) fn remote_sh(script: &str) -> String {
    format!("sh -c {}", sh_quote(script))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ViewState {
    /// A git repository; `changes` is its status.
    Ok,
    /// The folder does not exist on the server.
    Missing,
    /// The folder exists but is not a git repository.
    NotGit,
    /// `git status` itself failed (`error` says why).
    Error,
}

/// What the Changes tree shows for a repository on a server.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerChanges {
    /// `server(<name>)`: where these changes are.
    pub source: String,
    pub state: ViewState,
    /// The real folder on the server (links followed).
    pub physical: Option<String>,
    /// Full sha of HEAD; `None` on a branch without commits.
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub ahead: u32,
    pub behind: u32,
    /// `origin` without credentials.
    pub origin: Option<String>,
    pub changes: Vec<Change>,
    /// How many changed files there are in all (more than `changes.len()` when the list was cut at [`MAX_FILES`]).
    pub total: u32,
    pub truncated: bool,
    pub error: Option<String>,
    pub updated_at_ms: i64,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn status_script(path: &str) -> String {
    format!(
        r#"{SHELL_PRELUDE}d={q}
[ -d "$d" ] || {{ printf 'state=missing\n'; exit 0; }}
cd -P -- "$d" 2>/dev/null || {{ printf 'state=missing\n'; exit 0; }}
p=$(pwd -P)
case "$p" in *[[:cntrl:]]*) p=;; esac
printf 'physical=%s\n' "$p"
[ -e .git ] || {{ printf 'state=notgit\n'; exit 0; }}
printf 'head=%s\n' "$(G rev-parse -q --verify HEAD </dev/null 2>/dev/null)"
printf 'origin=%s\n' "$(G remote get-url origin </dev/null 2>/dev/null | head -n 1)"
printf 'state=ok\n--status--\n'
G status --porcelain=v2 -z --branch --untracked-files=normal </dev/null | head -c {cap}
printf '\n--end--\n'
"#,
        q = sh_quote_path_for_remote(path),
        cap = STATUS_BYTES
    )
}

/// The path is the resolved folder (`~/...` or absolute, as `resolve_repo_path` returns it).
pub(crate) fn check_folder(path: &str) -> Result<(), SshError> {
    validate_repo_path(path).map_err(|e| SshError::invalid(format!("repository folder: {}", e.reason)))
}

/// The credentials of an URL are not shown.
pub(crate) fn redact_url(u: &str) -> String {
    match u.split_once("://") {
        Some((scheme, rest)) => match rest.split_once('/').map_or(rest, |(host, _)| host).rfind('@') {
            Some(at) => format!("{scheme}://{}", &rest[at + 1..]),
            None => u.to_string(),
        },
        None => u.to_string(),
    }
}

fn header_value(head: &str, key: &str) -> Option<String> {
    head.lines().find_map(|l| l.strip_prefix(key).map(|v| v.trim().to_string())).filter(|v| !v.is_empty())
}

/// Parses what [`status_script`] printed.
fn parse_status(name: &str, out: &[u8], stderr: &str) -> ServerChanges {
    let mut res = ServerChanges {
        source: format!("server({name})"),
        state: ViewState::Error,
        physical: None,
        head: None,
        branch: None,
        detached: false,
        ahead: 0,
        behind: 0,
        origin: None,
        changes: Vec::new(),
        total: 0,
        truncated: false,
        error: None,
        updated_at_ms: now_ms(),
    };
    let marker = b"--status--\n";
    let (head_bytes, body) = match out.windows(marker.len()).position(|w| w == marker) {
        Some(i) => (&out[..i], Some(&out[i + marker.len()..])),
        None => (out, None),
    };
    let head = String::from_utf8_lossy(head_bytes);
    res.physical = header_value(&head, "physical=").filter(|p| p.starts_with('/'));
    res.head = header_value(&head, "head=").filter(|h| h.len() >= 40 && h.chars().all(|c| c.is_ascii_hexdigit()));
    res.origin = header_value(&head, "origin=").map(|o| redact_url(&o));
    match header_value(&head, "state=").as_deref() {
        Some("missing") => {
            res.state = ViewState::Missing;
            return res;
        }
        Some("notgit") => {
            res.state = ViewState::NotGit;
            return res;
        }
        _ => {}
    }
    let Some(body) = body else {
        res.error = Some(if stderr.trim().is_empty() { "the server did not answer".to_string() } else { stderr.trim().to_string() });
        return res;
    };
    let end = b"\n--end--\n";
    let (body, complete) = match body.windows(end.len()).rposition(|w| w == end) {
        Some(i) => (&body[..i], true),
        None => (body, false),
    };
    // An output that was cut in the middle of a record: only whole records are parsed.
    let body = if complete { body } else { body.iter().rposition(|b| *b == 0).map_or(&body[..0], |i| &body[..=i]) };
    match parse_status_v2(body) {
        Ok(p) if p.branch.oid.is_some() || p.branch.head.is_some() || !p.changes.is_empty() => {
            res.state = ViewState::Ok;
            res.branch = p.branch.head.clone();
            res.detached = p.branch.head.is_none() && p.branch.oid.is_some();
            res.ahead = p.branch.ahead;
            res.behind = p.branch.behind;
            res.total = p.changes.len() as u32;
            res.truncated = !complete || p.changes.len() > MAX_FILES;
            res.changes = p.changes.into_iter().take(MAX_FILES).map(classify).collect();
        }
        Ok(_) => res.error = Some(if stderr.trim().is_empty() { "git status printed nothing".to_string() } else { stderr.trim().to_string() }),
        Err(e) => res.error = Some(e.to_string()),
    }
    res
}

fn classify(mut c: Change) -> Change {
    let new = matches!(c.kind, ChangeKind::Untracked | ChangeKind::Added);
    c.guard = guard::classify(&c.path, new, None);
    c
}

/// The status of the working copy of one repository on the server (one ssh call, 15 s). `Err` only for the connection itself
/// (unreachable, host key, timeout); a missing folder or a folder that is not a repository is a [`ViewState`].
pub fn server_changes(ssh: &Ssh, cfg: &ServerCfg, path: &str) -> Result<ServerChanges, SshError> {
    check_folder(path)?;
    let out = ssh.exec_with(cfg, &remote_sh(&status_script(path)), &[], TIMEOUT, STATUS_BYTES + 4096)?;
    Ok(parse_status(&cfg.name, &out.stdout, &out.stderr))
}

/// Characters git and the file systems ignore or render invisibly: a name that hides `.git` or another control name with them is refused.
fn ignorable(c: char) -> bool {
    matches!(c, '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{115F}' | '\u{1160}' | '\u{17B4}' | '\u{17B5}' | '\u{180B}'..='\u{180F}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{3164}' | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}' | '\u{FFA0}' | '\u{FFF0}'..='\u{FFF8}' | '\u{E0000}'..='\u{E0FFF}')
}

/// One path component that is safe on every file system git runs on: not empty, not `.`/`..`, not `.git` in any case, no trailing space
/// or dot (NTFS), no `:` (NTFS streams), no invisible characters.
fn component_ok(c: &str) -> bool {
    !c.is_empty() && c != "." && c != ".." && !c.ends_with(' ') && !c.ends_with('.') && !c.contains(':') && !c.chars().any(ignorable) && !c.eq_ignore_ascii_case(".git")
}

/// A path inside the repository: relative, no `..`, no `.git`, and every component safe ([`component_ok`]).
pub fn valid_rel_file(p: &str) -> bool {
    !p.is_empty() && p.len() <= 4096 && !p.starts_with('/') && !p.chars().any(|c| c.is_control()) && p.trim_end_matches('/').split('/').all(component_ok)
}

fn file_script(path: &str, file: &str, orig: Option<&str>, untracked: bool) -> String {
    let diff = if untracked {
        format!("G diff --no-index --no-ext-diff --no-textconv --no-color -U1000000 -- /dev/null {} </dev/null", sh_quote(file))
    } else {
        let extra = orig.map(|o| format!(" {}", sh_quote(o))).unwrap_or_default();
        format!(
            "base=$(G rev-parse -q --verify HEAD </dev/null 2>/dev/null) || base=4b825dc642cb6eb9a060e54bf8d69288fbee4904\nG diff --no-ext-diff --no-textconv --no-color -U1000000 -M \"$base\" -- {}{extra} </dev/null",
            sh_quote(file)
        )
    };
    format!(
        "{SHELL_PRELUDE}d={q}\ncd -P -- \"$d\" 2>/dev/null || exit 3\n[ -e .git ] || exit 4\n{diff} | head -c {cap}\nexit 0\n",
        q = sh_quote_path_for_remote(path),
        cap = MAX_DIFF_BYTES + 1
    )
}

/// Both sides of a one-file unified diff printed with a huge context: the file before and after.
pub(crate) fn sides_from_diff(diff: &str) -> (String, String, bool) {
    let (mut orig, mut new) = (String::new(), String::new());
    let (mut in_hunk, mut binary) = (false, false);
    for line in diff.split_inclusive('\n') {
        let body = line.trim_end_matches('\n');
        if !in_hunk {
            if body.starts_with("Binary files ") || body == "GIT binary patch" {
                binary = true;
            }
            if body.starts_with("@@ ") {
                in_hunk = true;
            }
            continue;
        }
        if body.starts_with("@@ ") {
            continue;
        }
        match body.as_bytes().first() {
            Some(b' ') => {
                orig.push_str(&line[1..]);
                new.push_str(&line[1..]);
            }
            Some(b'-') => orig.push_str(&line[1..]),
            Some(b'+') => new.push_str(&line[1..]),
            _ => {}
        }
    }
    (orig, new, binary)
}

/// The two sides of one changed file, for the diff viewer. Secret-looking files are not read unless `reveal`; a diff over
/// [`MAX_DIFF_BYTES`] is reported as too large; a binary file as binary.
pub fn server_file(ssh: &Ssh, cfg: &ServerCfg, path: &str, file: &str, orig_path: Option<&str>, untracked: bool, reveal: bool) -> Result<FileContents, SshError> {
    check_folder(path)?;
    if !valid_rel_file(file) || orig_path.is_some_and(|o| !valid_rel_file(o)) {
        return Err(SshError::invalid("file path".into()));
    }
    let language = intely_core::diff::language_for(file);
    let secret = guard::is_secret_name(file);
    let guard_state = if secret { if untracked { GuardState::Secret } else { GuardState::Sensitive } } else { GuardState::Ok };
    let mut res = FileContents { path: file.to_string(), original: String::new(), modified: String::new(), binary: false, too_large: false, guard: guard_state, language };
    if secret && !reveal {
        return Ok(res);
    }
    let out = ssh.exec_with(cfg, &remote_sh(&file_script(path, file, orig_path, untracked)), &[], TIMEOUT, MAX_DIFF_BYTES + 4096)?;
    if out.code != 0 {
        return Err(SshError::other(if out.stderr.trim().is_empty() { format!("the folder is gone or not a repository (exit {})", out.code) } else { out.stderr }));
    }
    if out.stdout.len() > MAX_DIFF_BYTES {
        res.too_large = true;
        return Ok(res);
    }
    let (o, n, binary) = sides_from_diff(&String::from_utf8_lossy(&out.stdout));
    res.binary = binary;
    if !binary {
        res.original = o;
        res.modified = n;
    }
    Ok(res)
}

#[cfg(test)]
#[cfg(unix)] // the fake server of testkit is a set of /bin/sh scripts
mod tests {
    use super::*;
    use crate::testkit::Fake;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
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

    /// `~/work/app` on the fake server: one commit with `a.txt` and `b.txt`.
    fn server_repo(f: &Fake) -> std::path::PathBuf {
        let repo = f.home.join("work/app");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(repo.join("b.txt"), "bee\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        repo
    }

    #[test]
    fn a_clean_repo_has_a_head_and_no_changes() {
        let f = Fake::new();
        server_repo(&f);
        let v = server_changes(&f.ssh, &f.cfg, "~/work/app").unwrap();
        assert_eq!(v.state, ViewState::Ok, "{:?}", v.error);
        assert_eq!(v.source, "server(Big)");
        assert!(v.changes.is_empty() && v.head.as_ref().is_some_and(|h| h.len() == 40) && v.branch.as_deref() == Some("main"));
        assert!(v.physical.as_deref().is_some_and(|p| p.ends_with("/work/app")));
    }

    #[test]
    fn changes_use_the_same_records_as_a_local_repo() {
        let f = Fake::new();
        let repo = server_repo(&f);
        std::fs::write(repo.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        std::fs::remove_file(repo.join("b.txt")).unwrap();
        std::fs::write(repo.join("new file.txt"), "x\n").unwrap();
        std::fs::write(repo.join(".env"), "TOKEN=1\n").unwrap();
        let v = server_changes(&f.ssh, &f.cfg, "~/work/app").unwrap();
        let kind = |p: &str| v.changes.iter().find(|c| c.path == p).map(|c| c.kind.clone());
        assert_eq!(kind("a.txt"), Some(ChangeKind::Modified));
        assert_eq!(kind("b.txt"), Some(ChangeKind::Deleted));
        assert_eq!(kind("new file.txt"), Some(ChangeKind::Untracked));
        assert_eq!(v.changes.iter().find(|c| c.path == ".env").map(|c| c.guard.clone()), Some(GuardState::Secret));
        assert_eq!(v.total, 4);
    }

    #[test]
    fn the_list_is_cut_at_500_files_and_says_so() {
        let f = Fake::new();
        let repo = server_repo(&f);
        for i in 0..520 {
            std::fs::write(repo.join(format!("f{i}.txt")), "x").unwrap();
        }
        let v = server_changes(&f.ssh, &f.cfg, "~/work/app").unwrap();
        assert_eq!((v.changes.len(), v.total, v.truncated), (MAX_FILES, 520, true));
    }

    #[test]
    fn a_missing_folder_and_a_plain_folder_are_states_not_errors() {
        let f = Fake::new();
        std::fs::create_dir_all(f.home.join("work/plain")).unwrap();
        assert_eq!(server_changes(&f.ssh, &f.cfg, "~/work/none").unwrap().state, ViewState::Missing);
        assert_eq!(server_changes(&f.ssh, &f.cfg, "~/work/plain").unwrap().state, ViewState::NotGit);
    }

    #[test]
    fn an_unreachable_server_is_an_error() {
        let f = Fake::new();
        let mut cfg = f.cfg.clone();
        cfg.destination = "refused.test".into();
        assert!(server_changes(&f.ssh, &cfg, "~/work/app").is_err());
    }

    #[test]
    fn a_hostile_path_cannot_become_a_command() {
        let f = Fake::new();
        server_repo(&f);
        let marker = f.home.join("pwned");
        let evil = format!("~/work/app'; touch {}; echo '", marker.display());
        let r = server_changes(&f.ssh, &f.cfg, &evil);
        assert!(!marker.exists(), "the folder name was run as a command: {r:?}");
        let evil2 = format!("~/work/$(touch {})", marker.display());
        let _ = server_changes(&f.ssh, &f.cfg, &evil2);
        assert!(!marker.exists());
    }

    #[test]
    fn git_never_runs_the_repos_fsmonitor_or_hooks_config() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fake::new();
        let repo = server_repo(&f);
        let marker = f.home.join("fsmonitor-ran");
        let hook = f.home.join("hook.sh");
        std::fs::write(&hook, format!("#!/bin/sh\n: > '{}'\nexit 0\n", marker.display())).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(&repo, &["config", "core.fsmonitor", hook.to_str().unwrap()]);
        std::fs::write(repo.join("a.txt"), "changed\n").unwrap();
        let v = server_changes(&f.ssh, &f.cfg, "~/work/app").unwrap();
        assert_eq!(v.total, 1);
        let c = server_file(&f.ssh, &f.cfg, "~/work/app", "a.txt", None, false, false).unwrap();
        assert!(c.modified.contains("changed"));
        assert!(!marker.exists(), "core.fsmonitor ran on the server");
    }

    #[test]
    fn a_file_comes_back_as_both_sides_and_a_secret_stays_hidden() {
        let f = Fake::new();
        let repo = server_repo(&f);
        std::fs::write(repo.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        std::fs::write(repo.join("n.txt"), "fresh\n").unwrap();
        std::fs::write(repo.join(".env"), "TOKEN=abc\n").unwrap();
        let c = server_file(&f.ssh, &f.cfg, "~/work/app", "a.txt", None, false, false).unwrap();
        assert_eq!((c.original.as_str(), c.modified.as_str()), ("one\ntwo\nthree\n", "one\nTWO\nthree\n"));
        let n = server_file(&f.ssh, &f.cfg, "~/work/app", "n.txt", None, true, false).unwrap();
        assert_eq!((n.original.as_str(), n.modified.as_str()), ("", "fresh\n"));
        let hidden = server_file(&f.ssh, &f.cfg, "~/work/app", ".env", None, true, false).unwrap();
        assert_eq!((hidden.modified.as_str(), hidden.guard.clone()), ("", GuardState::Secret));
        let shown = server_file(&f.ssh, &f.cfg, "~/work/app", ".env", None, true, true).unwrap();
        assert_eq!(shown.modified, "TOKEN=abc\n");
    }

    #[test]
    fn binary_and_big_files_are_flagged_and_bad_paths_refused() {
        let f = Fake::new();
        let repo = server_repo(&f);
        std::fs::write(repo.join("bin.dat"), [0u8, 1, 2, 3, 0, 255]).unwrap();
        std::fs::write(repo.join("big.txt"), "x\n".repeat(1_200_000)).unwrap();
        let b = server_file(&f.ssh, &f.cfg, "~/work/app", "bin.dat", None, true, false).unwrap();
        assert!(b.binary && b.modified.is_empty());
        let big = server_file(&f.ssh, &f.cfg, "~/work/app", "big.txt", None, true, false).unwrap();
        assert!(big.too_large);
        for bad in ["../x", "/etc/passwd", "a/../b", ".git/config", "", "a\nb"] {
            assert!(server_file(&f.ssh, &f.cfg, "~/work/app", bad, None, false, false).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn lookalike_and_file_system_tricks_are_not_valid_paths() {
        for bad in [".git ", ".git.", "a/.GIT/b", "x:y", "a/b:stream", "dir /f", "dir./f", ".g\u{200C}it", ".git\u{FEFF}", "a\u{202E}b", "\u{FE0F}", "..", "a//b"] {
            assert!(!valid_rel_file(bad), "{bad:?}");
        }
        for good in ["a.txt", "src/ünï/ő.rs", ".github/x.yml", ".gitignore", "a b/c d.txt"] {
            assert!(valid_rel_file(good), "{good:?}");
        }
    }

    #[test]
    fn sides_are_rebuilt_from_a_long_context_diff() {
        let d = "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
        assert_eq!(sides_from_diff(d), ("a\nb\nc\n".to_string(), "a\nB\nc\n".to_string(), false));
        assert!(sides_from_diff("diff --git a/x b/x\nBinary files a/x and b/x differ\n").2);
    }
}
