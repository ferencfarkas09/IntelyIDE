//! Moving uncommitted changes between this Mac and a server, in either direction, as ONE explicit person's action.
//!
//! Nothing here commits, pushes, fetches, checks out or stages: a patch is applied to the WORKING TREE only (`git apply`, never
//! `--index`). It runs only from the UI commands of `src-tauri/src/modules/servers.rs`; no agent, broker or MCP path reaches it
//! (`tests/transfer_guard.rs` keeps it so). The local side obeys the IDE's mutation jail (`Jail::check_op`), the transfer is
//! all-or-nothing (`git apply --check` first, `git apply` is atomic), and every path of the patch is validated before it is applied,
//! on this side by [`validate_patch`] and on the server by the script itself.
//!
//! Preconditions, checked on every plan and again by the apply: both sides name the same `origin`, both are on the SAME HEAD commit
//! (otherwise nothing happens and the person is told to pull/push so both sides agree: nothing is ever fetched here), and the
//! destination is clean, or the person chose "apply on top" and `git apply --check` accepts the patch.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use intely_core::jail::Jail;
use intely_core::parse::status_v2::parse_status_v2;
use intely_core::{guard, Change, ChangeKind, EngineError, GuardState};
use serde::{Deserialize, Serialize};

use crate::cfg::ServerCfg;
use crate::quote::{sh_quote, sh_quote_path_for_remote};
use crate::repos::same_origin;
use crate::ssh::Ssh;
use crate::view::{check_folder, redact_url, remote_sh, server_changes, valid_rel_file, ServerChanges, ViewState, SHELL_PRELUDE};

/// The patch as a whole.
pub const MAX_PATCH_BYTES: usize = 20 * 1024 * 1024;
/// Untracked files carried along.
pub const MAX_UNTRACKED_FILES: usize = 200;
/// One untracked file.
pub const MAX_UNTRACKED_BYTES: u64 = 1024 * 1024;
const BUILD_TIMEOUT: Duration = Duration::from_secs(120);

type Res<T> = Result<T, EngineError>;

fn err(code: &str, message: impl Into<String>) -> EngineError {
    EngineError::new(code, message)
}

fn ssh_err(e: crate::ssh::SshError) -> EngineError {
    err("ssh", e.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    /// The server's changes come here.
    Bring,
    /// This Mac's changes go there.
    Send,
}

/// The local repository of a transfer.
#[derive(Debug, Clone)]
pub struct LocalRepo {
    pub path: PathBuf,
    /// `origin` as `local_origin` reads it; `None` = no origin.
    pub origin: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFile {
    pub path: String,
    pub orig_path: Option<String>,
    pub kind: ChangeKind,
    pub untracked: bool,
}

/// A path that needs the person's extra tick (`env`, `editor`, `hooks`, `config`, `packageScripts`, `executable`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Risky {
    pub path: String,
    pub code: String,
}

/// A change that cannot travel; any such entry stops the whole transfer.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Blocked {
    pub path: String,
    /// `binary`, `tooLarge`, `secret`, `symlink`, `unusualName`, `conflict`, `tooMany`.
    pub code: String,
    pub reason: String,
}

/// What the confirmation dialog shows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPlan {
    pub direction: Direction,
    pub files: Vec<PlanFile>,
    pub tracked: u32,
    pub untracked: u32,
    pub server_head: Option<String>,
    pub local_head: Option<String>,
    pub same_origin: bool,
    pub same_head: bool,
    /// The destination has no uncommitted change (the person may otherwise choose "apply on top").
    pub destination_clean: bool,
    pub blocked: Vec<Blocked>,
    /// Paths that need the extra tick before they travel.
    pub risky: Vec<Risky>,
    /// Lines added and removed per file, as git reads the patch.
    pub stat: Vec<StatEntry>,
    /// Size of the patch in bytes.
    pub bytes: u64,
    /// Identifies exactly this patch: the apply builds the patch again and goes ahead only when it has the same id.
    pub patch_id: String,
    /// Why nothing can happen at all (`originDiffers`, `headDiffers`, `noCommits`, `notRepository`, `runActive`) and what to do.
    pub refusal: Option<Refusal>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub files: u32,
    pub bytes: u64,
}

// ---- patch validation (this side) ------------------------------------------------------------------------------------------------

const BANNED_COMPONENTS: [&str; 5] = [".git", ".gitmodules", ".gitattributes", ".githooks", "git~1"];

/// A path of a patch: relative, inside the tree, every component safe on every file system (no trailing space or dot, no `:`, no
/// invisible characters, see `valid_rel_file`) and not a git control path or a hooks folder.
pub fn valid_patch_path(p: &str) -> bool {
    valid_rel_file(p) && p.split('/').all(|c| !BANNED_COMPONENTS.contains(&c.to_ascii_lowercase().as_str()) && !c.contains('\\'))
}

/// Header lines that create or change a symbolic link or a submodule (the text layer; git's own reading is the first layer).
fn creates_link_or_submodule(patch: &[u8]) -> bool {
    patch.split(|b| *b == b'\n').any(|l| {
        let l = String::from_utf8_lossy(l);
        let l = l.trim_end_matches('\r');
        // (git reads a mode as octal with leading zeros, so the digits are compared as a number)
        let mode_of = |rest: &str| u32::from_str_radix(rest.split_whitespace().next().unwrap_or(""), 8).ok();
        let new_mode = l.strip_prefix("new file mode ").or_else(|| l.strip_prefix("new mode ")).and_then(mode_of);
        let index_mode = l.strip_prefix("index ").and_then(|r| r.split_whitespace().nth(1)).and_then(|m| u32::from_str_radix(m, 8).ok());
        [new_mode, index_mode].into_iter().flatten().any(|m| m & 0o170000 == 0o120000 || m & 0o170000 == 0o160000)
    })
}

/// A path in the paths list and what git says about its size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatEntry {
    pub path: String,
    pub added: Option<u32>,
    pub deleted: Option<u32>,
    pub binary: bool,
}

/// What git itself reads from a patch (`git apply --numstat -z` and `--summary`), not what the patch's text claims.
#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub stat: Vec<StatEntry>,
    /// Every path the patch touches, old names of renames included.
    pub paths: Vec<String>,
    /// Paths that become executable (mode 100755).
    pub exec: Vec<String>,
}

fn parse_numstat(numstat: &[u8]) -> (Vec<StatEntry>, Vec<String>) {
    let (mut stat, mut paths) = (Vec::new(), Vec::new());
    let mut recs = numstat.split(|b| *b == 0);
    while let Some(rec) = recs.next() {
        let s = String::from_utf8_lossy(rec).into_owned();
        let mut it = s.splitn(3, '\t');
        let (Some(a), Some(d), Some(rest)) = (it.next(), it.next(), it.next()) else { continue };
        let num = |x: &str| x.parse::<u32>().ok();
        let binary = a == "-" && d == "-";
        if rest.is_empty() {
            // a rename or copy: the old and the new path follow
            let (old, new) = (recs.next(), recs.next());
            if let Some(o) = old {
                paths.push(String::from_utf8_lossy(o).into_owned());
            }
            if let Some(n) = new {
                let p = String::from_utf8_lossy(n).into_owned();
                stat.push(StatEntry { path: p.clone(), added: num(a), deleted: num(d), binary });
                paths.push(p);
            }
        } else {
            stat.push(StatEntry { path: rest.to_string(), added: num(a), deleted: num(d), binary });
            paths.push(rest.to_string());
        }
    }
    (stat, paths)
}

/// Reads the modes from `git apply --summary`: only plain files (100644, 100755) may be created or become the new mode.
fn check_summary(summary: &str) -> Res<Vec<String>> {
    let mut exec = Vec::new();
    for line in summary.lines() {
        let (mode, path) = if let Some(r) = line.strip_prefix(" create mode ") {
            let mut it = r.splitn(2, ' ');
            (it.next().unwrap_or(""), it.next().unwrap_or(""))
        } else if let Some(r) = line.strip_prefix(" mode change ") {
            // `100644 => 100755 path`
            let mut it = r.splitn(4, ' ');
            let _old = it.next();
            if it.next() != Some("=>") {
                return Err(err("badPatch", "the patch has a mode line that cannot be read"));
            }
            (it.next().unwrap_or(""), it.next().unwrap_or(""))
        } else {
            continue;
        };
        match mode {
            "100644" => {}
            "100755" => exec.push(path.trim_matches('"').to_string()),
            m => return Err(err("badPatch", format!("the changes create or change a link, a submodule or another special file (mode {m}); nothing is carried over"))),
        }
    }
    Ok(exec)
}

/// Refuses a patch that touches anything outside the working files: absolute or `..` paths, `.git` and its siblings, hooks folders,
/// invisible or file-system-tricky names, and links, submodules or other special modes. Git reads the patch (`--numstat`,
/// `--summary`); the header text is a second layer.
pub fn validate_patch(jail: &Jail, repo: &Path, patch: &[u8]) -> Res<Facts> {
    if patch.is_empty() {
        return Err(err("nothingToTransfer", "there is nothing to transfer"));
    }
    if creates_link_or_submodule(patch) {
        return Err(err("badPatch", "the changes contain a symbolic link or a submodule; they are not carried over"));
    }
    let out = git_local(jail, repo, &["apply", "--numstat", "-z"], Some(patch))?;
    if !out.ok {
        return Err(err("badPatch", format!("the patch cannot be read: {}", out.stderr.trim())));
    }
    let summary = git_local(jail, repo, &["apply", "--summary"], Some(patch))?;
    if !summary.ok {
        return Err(err("badPatch", format!("the patch cannot be read: {}", summary.stderr.trim())));
    }
    let exec = check_summary(&String::from_utf8_lossy(&summary.stdout))?;
    let (stat, paths) = parse_numstat(&out.stdout);
    for p in &paths {
        if !valid_patch_path(p) {
            return Err(err("badPatch", format!("the changes touch '{}', which is not carried over (paths must stay inside the working files, never .git or hooks)", p.escape_debug())));
        }
    }
    Ok(Facts { stat, paths, exec })
}

/// Files that run or configure something on their own when a tool opens the folder (environment files, editor tasks, git hooks of
/// husky, make, cargo and npm configuration). A transfer that carries one needs the person's extra tick. Keep in step with the
/// server script (`RISKY_RE`).
pub fn risky_path(path: &str) -> Option<&'static str> {
    let lower = path.to_lowercase();
    let comps: Vec<&str> = lower.split('/').collect();
    let (last, dirs) = comps.split_last()?;
    let template = [".example", ".sample", ".template"].iter().any(|s| lower.ends_with(s));
    if comps.iter().any(|c| *c == ".env" || c.starts_with(".env.")) && !template {
        return Some("env");
    }
    if *last == ".envrc" {
        return Some("env");
    }
    if dirs.iter().any(|c| *c == ".vscode" || *c == ".idea") {
        return Some("editor");
    }
    if dirs.contains(&".husky") {
        return Some("hooks");
    }
    if lower.starts_with(".cargo/config") || lower.contains("/.cargo/config") {
        return Some("config");
    }
    if matches!(*last, "makefile" | "gnumakefile" | ".npmrc" | ".pre-commit-config.yaml") {
        return Some("config");
    }
    None
}

/// `package.json` changes that touch an npm lifecycle script (run by `npm install`).
fn package_scripts_touched(patch: &[u8]) -> Vec<String> {
    let (mut cur, mut out) = (String::new(), Vec::new());
    for l in patch.split(|b| *b == b'\n') {
        let l = String::from_utf8_lossy(l);
        if let Some(rest) = l.strip_prefix("diff --git ") {
            cur = rest.rsplit_once(" b/").map(|(_, n)| n.to_string()).unwrap_or_default();
        } else if (l.starts_with('+') || l.starts_with('-')) && !l.starts_with("+++") && !l.starts_with("---") && cur.ends_with("package.json") && ["\"preinstall\"", "\"postinstall\"", "\"install\"", "\"prepare\"", "\"prepublish\""].iter().any(|k| l.contains(k)) && !out.contains(&cur) {
            out.push(cur.clone());
        }
    }
    out
}

/// The paths of a patch that need the extra tick, with the reason code.
pub fn risky_of(facts: &Facts, patch: &[u8]) -> Vec<Risky> {
    let mut out: Vec<Risky> = Vec::new();
    let mut add = |path: &str, code: &str| {
        if !out.iter().any(|r| r.path == path) {
            out.push(Risky { path: path.to_string(), code: code.into() });
        }
    };
    for p in &facts.paths {
        if let Some(c) = risky_path(p) {
            add(p, c);
        }
    }
    for p in package_scripts_touched(patch) {
        add(&p, "packageScripts");
    }
    for p in &facts.exec {
        add(p, "executable");
    }
    out
}

/// The sections of a patch (`diff --git` blocks) with their byte length, by new path.
fn section_sizes(patch: &[u8]) -> Vec<(String, usize)> {
    let mut out: Vec<(String, usize)> = Vec::new();
    for l in patch.split_inclusive(|b| *b == b'\n') {
        if let Some(rest) = l.strip_prefix(b"diff --git ") {
            let rest = String::from_utf8_lossy(rest);
            out.push((rest.trim_end().rsplit_once(" b/").map(|(_, n)| n.to_string()).unwrap_or_default(), 0));
        }
        if let Some(last) = out.last_mut() {
            last.1 += l.len();
        }
    }
    out
}

/// The checks of the plan, run again on the patch itself: secret-looking names, new binary or big files.
fn patch_blocked(files: &[PlanFile], facts: &Facts, patch: &[u8]) -> Vec<Blocked> {
    let mut out = Vec::new();
    let sizes = section_sizes(patch);
    for s in &facts.stat {
        let new_file = files.iter().find(|f| f.path == s.path).is_some_and(|f| f.untracked);
        let why = if guard::is_secret_name(&s.path) {
            Some(("secret", "the file looks like a secret; it is not carried over"))
        } else if new_file && s.binary {
            Some(("binary", "a new binary file is not carried over; commit it or copy it yourself"))
        } else if new_file && sizes.iter().any(|(p, n)| *p == s.path && *n as u64 > 2 * MAX_UNTRACKED_BYTES + 4096) {
            Some(("tooLarge", "a new file over 1 MB is not carried over"))
        } else {
            None
        };
        if let Some((code, reason)) = why {
            out.push(Blocked { path: s.path.clone(), code: code.into(), reason: reason.into() });
        }
    }
    out
}

// ---- local git --------------------------------------------------------------------------------------------------------------------

struct LOut {
    ok: bool,
    stdout: Vec<u8>,
    stderr: String,
}

/// A local git call ends after this long (the process is killed) and keeps at most [`LOCAL_OUT_CAP`] of its stdout.
const LOCAL_TIMEOUT: Duration = Duration::from_secs(60);
const LOCAL_OUT_CAP: usize = MAX_PATCH_BYTES + 2 * 1024 * 1024;
const LOCAL_ERR_CAP: usize = 64 * 1024;

fn drain(mut r: impl std::io::Read + Send + 'static, cap: usize) -> std::thread::JoinHandle<(Vec<u8>, bool)> {
    std::thread::spawn(move || {
        let (mut buf, mut cut, mut chunk) = (Vec::new(), false, [0u8; 16 * 1024]);
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let room = cap.saturating_sub(buf.len());
                    cut |= n > room;
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                }
            }
        }
        (buf, cut)
    })
}

/// Runs the pinned, hardened git in `repo` with `input` on stdin. `diff --no-index` exits 1 for "different", which is accepted.
/// Wall-clock timeout (kill) and an output cap: an endless or huge answer is an error, never a hang or an out-of-memory.
fn git_local(jail: &Jail, repo: &Path, args: &[&str], input: Option<&[u8]>) -> Res<LOut> {
    git_local_with(jail, repo, args, input, LOCAL_TIMEOUT, LOCAL_OUT_CAP)
}

fn git_local_with(jail: &Jail, repo: &Path, args: &[&str], input: Option<&[u8]>, timeout: Duration, out_cap: usize) -> Res<LOut> {
    let mut cmd = intely_core::exec::hardened_git(intely_core::exec::pinned_git_path());
    cmd.args(jail.config_args());
    cmd.args(["-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", "-c", "core.quotePath=false", "-c", "core.editor=true", "-c", "diff.external=", "-c", "core.protectHFS=true", "-c", "core.protectNTFS=true", "--no-replace-objects", "--no-optional-locks", "-C"]).arg(repo).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C").env("GIT_LITERAL_PATHSPECS", "1").env("GIT_PAGER", "cat");
    for (k, v) in jail.env() {
        cmd.env(k, v);
    }
    for k in jail.removed_env() {
        cmd.env_remove(k);
    }
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| err("git", format!("could not start git: {e}")))?;
    let writer = input.and_then(|bytes| {
        let mut stdin = child.stdin.take()?;
        let data = bytes.to_vec();
        Some(std::thread::spawn(move || {
            let _ = stdin.write_all(&data);
        }))
    });
    let (out, errh) = (drain(child.stdout.take().expect("piped"), out_cap), drain(child.stderr.take().expect("piped"), LOCAL_ERR_CAP));
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err("git", format!("git {} did not finish in {} s and was stopped", args.first().copied().unwrap_or(""), timeout.as_secs())));
            }
            Err(e) => return Err(err("git", e.to_string())),
        }
    };
    if let Some(w) = writer {
        let _ = w.join();
    }
    let ((stdout, cut), (stderr, _)) = (out.join().unwrap_or_default(), errh.join().unwrap_or_default());
    if cut {
        return Err(err("tooLarge", format!("git {} printed more than {} bytes; the changes are too big to carry over", args.first().copied().unwrap_or(""), out_cap)));
    }
    let no_index = args.contains(&"--no-index");
    Ok(LOut { ok: status.success() || (no_index && status.code() == Some(1)), stdout, stderr: String::from_utf8_lossy(&stderr).into_owned() })
}

struct LocalState {
    head: Option<String>,
    changes: Vec<Change>,
}

fn local_state(jail: &Jail, repo: &Path) -> Res<LocalState> {
    let head = git_local(jail, repo, &["rev-parse", "-q", "--verify", "HEAD"], None)?;
    let head = head.ok.then(|| String::from_utf8_lossy(&head.stdout).trim().to_string()).filter(|h| h.len() >= 40);
    let st = git_local(jail, repo, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=normal"], None)?;
    if !st.ok {
        return Err(err("git", format!("git status failed: {}", st.stderr.trim())));
    }
    Ok(LocalState { head, changes: parse_status_v2(&st.stdout)?.changes })
}

// ---- what may travel ---------------------------------------------------------------------------------------------------------------

/// An untracked file as either side saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Untracked {
    pub path: String,
    pub size: u64,
    pub binary: bool,
    pub symlink: bool,
    pub odd: bool,
}

fn judge_untracked(list: &[Untracked]) -> Vec<Blocked> {
    let mut out = Vec::new();
    if list.len() > MAX_UNTRACKED_FILES {
        out.push(Blocked { path: String::new(), code: "tooMany".into(), reason: format!("more than {MAX_UNTRACKED_FILES} new files; commit them where they are, or ignore them") });
    }
    for u in list.iter().take(MAX_UNTRACKED_FILES + 1) {
        let reason = if u.odd || !valid_patch_path(&u.path) {
            ("unusualName", "the file name has characters that cannot travel safely")
        } else if u.symlink {
            ("symlink", "a new symbolic link is not carried over")
        } else if u.binary {
            ("binary", "a new binary file is not carried over; commit it or copy it yourself")
        } else if u.size > MAX_UNTRACKED_BYTES {
            ("tooLarge", "a new file over 1 MB is not carried over")
        } else if guard::classify(&u.path, true, Some(u.size)) != GuardState::Ok {
            ("secret", "the file looks like a secret or a file that is never added; it is not carried over")
        } else {
            continue;
        };
        out.push(Blocked { path: u.path.clone(), code: reason.0.into(), reason: reason.1.into() });
    }
    out
}

fn judge_tracked(changes: &[Change]) -> Vec<Blocked> {
    changes
        .iter()
        .filter(|c| c.kind != ChangeKind::Untracked)
        .filter_map(|c| {
            let (code, reason) = if c.kind == ChangeKind::Conflicted {
                ("conflict", "the file has an unresolved merge conflict")
            } else if c.kind == ChangeKind::Submodule {
                ("symlink", "a submodule change is not carried over")
            } else if matches!(c.guard, GuardState::Sensitive | GuardState::Secret | GuardState::NeverAdd) {
                ("secret", "the file looks like a secret; it is not carried over")
            } else if !valid_patch_path(&c.path) || c.orig_path.as_deref().is_some_and(|o| !valid_patch_path(o)) {
                ("unusualName", "the path cannot travel safely")
            } else {
                return None;
            };
            Some(Blocked { path: c.path.clone(), code: code.into(), reason: reason.into() })
        })
        .collect()
}

fn plan_files(tracked: &[Change], untracked: &[Untracked]) -> Vec<PlanFile> {
    let mut files: Vec<PlanFile> = tracked.iter().filter(|c| c.kind != ChangeKind::Untracked).map(|c| PlanFile { path: c.path.clone(), orig_path: c.orig_path.clone(), kind: c.kind.clone(), untracked: false }).collect();
    files.extend(untracked.iter().map(|u| PlanFile { path: u.path.clone(), orig_path: None, kind: ChangeKind::Untracked, untracked: true }));
    files
}

// ---- the server side ---------------------------------------------------------------------------------------------------------------

fn manifest_script(path: &str) -> String {
    format!(
        r#"{SHELL_PRELUDE}d={q}
cd -P -- "$d" 2>/dev/null || exit 3
[ -e .git ] || exit 4
G ls-files -o --exclude-standard </dev/null | head -n {n} | while IFS= read -r f; do
  case "$f" in \"*) printf '0\tq\t%s\n' "$f"; continue;; esac
  if [ -L "$f" ]; then printf '0\ts\t%s\n' "$f"; continue; fi
  [ -f "$f" ] || {{ printf '0\tq\t%s\n' "$f"; continue; }}
  n=$(wc -c < "$f" | tr -d ' ')
  b=-
  if [ "$n" -gt 0 ] && [ "$(head -c 8000 < "$f" | tr -d '\000' | wc -c)" != "$(head -c 8000 < "$f" | wc -c)" ]; then b=b; fi
  printf '%s\t%s\t%s\n' "$n" "$b" "$f"
done
exit 0
"#,
        q = sh_quote_path_for_remote(path),
        n = MAX_UNTRACKED_FILES + 1
    )
}

fn parse_manifest(text: &str) -> Vec<Untracked> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.splitn(3, '\t');
            let (size, flag, path) = (it.next()?, it.next()?, it.next()?);
            Some(Untracked { path: path.to_string(), size: size.parse().unwrap_or(0), binary: flag == "b", symlink: flag == "s", odd: flag == "q" })
        })
        .collect()
}

fn build_script(path: &str, head: &str) -> String {
    format!(
        r#"{SHELL_PRELUDE}d={q}
cd -P -- "$d" 2>/dev/null || exit 3
[ -e .git ] || exit 4
[ "$(G rev-parse -q --verify HEAD </dev/null 2>/dev/null)" = {head} ] || exit 10
G diff --binary --full-index --no-renames --no-ext-diff --no-textconv --no-color HEAD </dev/null || exit 17
while IFS= read -r f; do
  [ -n "$f" ] || continue
  G diff --no-index --binary --full-index --no-ext-diff --no-textconv --no-color -- /dev/null "$f" </dev/null
done
exit 0
"#,
        q = sh_quote_path_for_remote(path),
        head = sh_quote(head)
    )
}

/// The same rule as [`risky_path`], for the script (names are lowercased). Keep both in step.
const RISKY_RE: &str = r"(^|/)\.env([.]|$)|(^|/)\.envrc$|(^|/)\.(vscode|idea)/|(^|/)\.husky/|^\.cargo/config|/\.cargo/config|(^|/)(makefile|gnumakefile|\.npmrc|\.pre-commit-config\.yaml)$";

/// Applies a patch to the server's working tree. The script validates the paths itself (the rules of [`valid_patch_path`]), reads the
/// modes from git (`--summary`) and refuses links, submodules and special files, refuses the files of [`risky_path`] and executable
/// modes unless `accept_risky`, runs `git apply --check` before `git apply`, which changes all files or none.
fn apply_script(path: &str, head: &str, on_top: bool, accept_risky: bool) -> String {
    format!(
        r#"{SHELL_PRELUDE}d={q}
T=$(printf '\t')
IGN=$(printf '\302\255|\342\200[\213-\217\252-\256]|\342\201[\240-\257]|\357\273\277|\357\270[\200-\217]|\341\242[\213-\217]|\343\205\244')
GA() {{ G -c core.protectHFS=true -c core.protectNTFS=true "$@"; }}
t=$(mktemp -d "${{TMPDIR:-/tmp}}/intely-xfer.XXXXXX") || exit 20
trap 'rm -rf "$t"' EXIT
cat > "$t/p"
cd -P -- "$d" 2>/dev/null || exit 3
[ -e .git ] || exit 4
[ "$(G rev-parse -q --verify HEAD </dev/null 2>/dev/null)" = {head} ] || exit 10
if [ {on_top} = 0 ] && [ -n "$(G status --porcelain --untracked-files=normal </dev/null | head -n 1)" ]; then exit 12; fi
if grep -aEq '^(new file mode|new mode) 0*(120000|160000)$|^index [0-9a-f]+\.\.[0-9a-f]+ 0*(120000|160000)$' "$t/p"; then exit 13; fi
GA apply --summary "$t/p" </dev/null > "$t/sum" || exit 15
if grep -E '^ (create mode|mode change) ' "$t/sum" | grep -Ev '^ create mode 100(644|755) |^ mode change [0-7]+ => 100(644|755) ' | grep -q .; then exit 13; fi
GA apply --numstat -z "$t/p" </dev/null | tr '\000' '\n' | sed "s/^[-0-9][0-9]*$T[-0-9][0-9]*$T//" | tr 'A-Z' 'a-z' > "$t/names"
if grep -Eq '^/|\\|(^|/)(\.|\.\.|\.git|\.gitmodules|\.gitattributes|\.githooks|git~1)(/|$)|:|[ .](/|$)' "$t/names"; then exit 14; fi
if LC_ALL=C grep -Eq "$IGN" "$t/names"; then exit 14; fi
if [ {accept} = 0 ]; then
  if grep -E '{risky}' "$t/names" | grep -Ev '\.(example|sample|template)$' | grep -q .; then exit 18; fi
  if grep -Eq '^ (create mode|mode change [0-7]+ =>) 100755 ' "$t/sum"; then exit 18; fi
fi
GA apply --check --whitespace=nowarn "$t/p" </dev/null || exit 15
GA apply --whitespace=nowarn "$t/p" </dev/null || exit 16
exit 0
"#,
        q = sh_quote_path_for_remote(path),
        head = sh_quote(head),
        on_top = if on_top { 1 } else { 0 },
        accept = if accept_risky { 1 } else { 0 },
        risky = RISKY_RE
    )
}

fn server_exit(code: i32, stderr: &str) -> EngineError {
    let why = stderr.trim();
    match code {
        3 => err("notRepository", "the folder on the server is gone"),
        4 => err("notRepository", "the folder on the server is not a git repository"),
        10 => err("headDiffers", "the server moved to another commit meanwhile; look at the changes again"),
        12 => err("destinationDirty", "the working copy on the server has uncommitted changes; choose \"apply on top\" or clean it first"),
        18 => err("riskyPaths", "the changes touch files that run or configure something on their own (environment files, editor tasks, hooks, make or npm configuration) or become executable; tick the extra confirmation to carry them over"),
        13 | 14 => err("badPatch", "the changes touch a link, a submodule, .git or a hooks folder; nothing was applied"),
        15 => err("applyCheck", format!("the changes do not fit the working copy on the server; nothing was applied. {why}")),
        16 => err("applyFailed", format!("git apply failed on the server. {why}")),
        _ => err("ssh", if why.is_empty() { format!("the server command failed (exit {code})") } else { why.to_string() }),
    }
}

// ---- plans -------------------------------------------------------------------------------------------------------------------------

fn refusal(code: &str, message: impl Into<String>) -> Option<Refusal> {
    Some(Refusal { code: code.into(), message: message.into() })
}

/// The checks that apply to every transfer, in the order a person can act on them.
fn common_refusal(srv: &ServerChanges, local: &LocalRepo, local_head: &Option<String>) -> Option<Refusal> {
    match srv.state {
        ViewState::Missing => return refusal("notRepository", "the folder does not exist on the server"),
        ViewState::NotGit => return refusal("notRepository", "the folder on the server is not a git repository"),
        ViewState::Error => return refusal("notRepository", srv.error.clone().unwrap_or_else(|| "the server's working copy could not be read".into())),
        ViewState::Ok => {}
    }
    match (&local.origin, &srv.origin) {
        (Some(a), Some(b)) if same_origin(a, b) => {}
        (Some(a), Some(b)) => return refusal("originDiffers", format!("the two copies are not the same repository (this Mac: {}, server: {})", redact_url(a), redact_url(b))),
        _ => return refusal("originDiffers", "both copies need an origin, and it has to name the same repository; one of them has none"),
    }
    match (local_head, &srv.head) {
        (Some(a), Some(b)) if a == b => None,
        (Some(a), Some(b)) => refusal("headDiffers", format!("the two copies are on different commits (this Mac {}, server {}). Pull or push so both sides are on the same commit, then try again; nothing is fetched for you", &a[..a.len().min(8)], &b[..b.len().min(8)])),
        _ => refusal("noCommits", "one of the copies has no commit yet; make the first commit and push it so both sides are on the same commit"),
    }
}

/// What a plan is computed from, kept for the apply.
struct Inner {
    plan: TransferPlan,
    /// The patch the plan describes (empty when there is none to build).
    patch: Vec<u8>,
    /// The server's real folder.
    physical: Option<String>,
}

fn patch_id(patch: &[u8]) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    patch.hash(&mut h);
    format!("{:016x}-{}", h.finish(), patch.len())
}

/// The union of what the plan lists, as the patch must name it.
fn plan_paths(files: &[PlanFile]) -> std::collections::BTreeSet<String> {
    files.iter().flat_map(|f| std::iter::once(f.path.clone()).chain(f.orig_path.clone())).collect()
}

fn inner_plan(direction: Direction, ssh: &Ssh, cfg: &ServerCfg, server_path: &str, local: &LocalRepo, jail: &Jail, server_busy: bool) -> Res<Inner> {
    let srv = server_changes(ssh, cfg, server_path).map_err(ssh_err)?;
    let ls = local_state(jail, &local.path)?;
    let mut refusal = common_refusal(&srv, local, &ls.head);
    if refusal.is_none() && direction == Direction::Send && server_busy {
        refusal = Some(Refusal { code: "runActive".into(), message: "a run on this server is working in that repository; wait until it has finished, or stop it".into() });
    }
    let (tracked_src, untracked, destination_clean) = match direction {
        Direction::Bring => {
            let list = if refusal.is_none() { server_untracked(ssh, cfg, server_path)? } else { Vec::new() };
            (srv.changes.clone(), list, ls.changes.is_empty())
        }
        Direction::Send => (ls.changes.clone(), if refusal.is_none() { local_untracked(jail, &local.path)? } else { Vec::new() }, srv.changes.is_empty()),
    };
    let mut blocked = Vec::new();
    if refusal.is_none() {
        blocked = judge_tracked(&tracked_src);
        blocked.extend(judge_untracked(&untracked));
    }
    let files = plan_files(&tracked_src, &untracked);
    let mut plan = TransferPlan {
        direction,
        tracked: files.iter().filter(|f| !f.untracked).count() as u32,
        untracked: untracked.len() as u32,
        files,
        server_head: srv.head.clone(),
        local_head: ls.head.clone(),
        same_origin: refusal.as_ref().map_or(true, |r| r.code != "originDiffers"),
        same_head: refusal.as_ref().map_or(true, |r| r.code != "headDiffers" && r.code != "noCommits"),
        destination_clean,
        blocked,
        risky: Vec::new(),
        stat: Vec::new(),
        bytes: 0,
        patch_id: String::new(),
        refusal,
    };
    let physical = srv.physical.clone();
    let mut patch = Vec::new();
    if plan.refusal.is_none() && plan.blocked.is_empty() && !plan.files.is_empty() {
        // The patch itself is built now, read by git, and checked again: what the person confirms is these bytes.
        let list: Vec<&str> = plan.files.iter().filter(|f| f.untracked).map(|f| f.path.as_str()).collect();
        patch = match direction {
            Direction::Bring => server_patch(ssh, cfg, server_path, srv.head.as_deref().unwrap_or(""), &list)?,
            Direction::Send => local_patch(jail, &local.path, &list)?,
        };
        if patch.len() > MAX_PATCH_BYTES {
            return Err(err("tooLarge", format!("the changes are bigger than {} MB; commit them and use git", MAX_PATCH_BYTES / 1024 / 1024)));
        }
        match validate_patch(jail, &local.path, &patch) {
            Err(e) if e.code == "nothingToTransfer" => plan.refusal = refusal_of("nothingToTransfer", &e.message),
            Err(e) => plan.refusal = refusal_of(&e.code, &e.message),
            Ok(facts) => {
                if facts.paths.iter().cloned().collect::<std::collections::BTreeSet<_>>() != plan_paths(&plan.files) {
                    plan.refusal = refusal_of("changedSinceReview", "the changes differ from the list that was read a moment ago (a file changed meanwhile); look at them again");
                } else {
                    plan.blocked.extend(patch_blocked(&plan.files, &facts, &patch));
                    plan.risky = risky_of(&facts, &patch);
                    plan.stat = facts.stat;
                    plan.bytes = patch.len() as u64;
                    plan.patch_id = patch_id(&patch);
                }
            }
        }
    }
    Ok(Inner { plan, patch, physical })
}

fn refusal_of(code: &str, message: &str) -> Option<Refusal> {
    Some(Refusal { code: code.into(), message: message.into() })
}

/// Builds the plan for the dialog: reads the server (one status, one list of new files, the patch) and this repository. Nothing is
/// changed anywhere. `server_busy` = a run of this server works on this repository now (only matters for [`Direction::Send`]).
pub fn plan(direction: Direction, ssh: &Ssh, cfg: &ServerCfg, server_path: &str, local: &LocalRepo, jail: &Jail, server_busy: bool) -> Res<TransferPlan> {
    Ok(inner_plan(direction, ssh, cfg, server_path, local, jail, server_busy)?.plan)
}

fn server_untracked(ssh: &Ssh, cfg: &ServerCfg, path: &str) -> Res<Vec<Untracked>> {
    check_folder(path).map_err(ssh_err)?;
    let out = ssh.exec_with(cfg, &remote_sh(&manifest_script(path)), &[], Duration::from_secs(30), 2 * 1024 * 1024).map_err(ssh_err)?;
    if out.code != 0 {
        return Err(server_exit(out.code, &out.stderr));
    }
    Ok(parse_manifest(&out.stdout_text()))
}

fn local_untracked(jail: &Jail, repo: &Path) -> Res<Vec<Untracked>> {
    let o = git_local(jail, repo, &["ls-files", "-o", "--exclude-standard", "-z"], None)?;
    if !o.ok {
        return Err(err("git", format!("git ls-files failed: {}", o.stderr.trim())));
    }
    let mut out = Vec::new();
    for raw in o.stdout.split(|b| *b == 0).filter(|r| !r.is_empty()).take(MAX_UNTRACKED_FILES + 1) {
        let Ok(path) = String::from_utf8(raw.to_vec()) else {
            out.push(Untracked { path: String::from_utf8_lossy(raw).into_owned(), size: 0, binary: false, symlink: false, odd: true });
            continue;
        };
        let full = repo.join(&path);
        let meta = std::fs::symlink_metadata(&full);
        let mut u = Untracked { path, size: 0, binary: false, symlink: false, odd: false };
        match meta {
            Ok(m) if m.file_type().is_symlink() => u.symlink = true,
            Ok(m) if m.is_file() => {
                u.size = m.len();
                let mut head = vec![0u8; 8000];
                let n = std::fs::File::open(&full).and_then(|mut f| std::io::Read::read(&mut f, &mut head)).unwrap_or(0);
                u.binary = head[..n].contains(&0);
            }
            _ => u.odd = true,
        }
        out.push(u);
    }
    Ok(out)
}

fn ready(plan: &TransferPlan, on_top: bool, accept_risky: bool, expected_id: &str) -> Res<()> {
    if let Some(r) = &plan.refusal {
        return Err(err(&r.code, r.message.clone()));
    }
    if !plan.blocked.is_empty() {
        let names: Vec<String> = plan.blocked.iter().take(5).map(|b| if b.path.is_empty() { b.reason.clone() } else { format!("{} ({})", b.path.escape_debug(), b.reason) }).collect();
        return Err(err("blocked", format!("these changes cannot be carried over, so nothing is: {}", names.join("; "))));
    }
    if plan.files.is_empty() {
        return Err(err("nothingToTransfer", "there are no changes to carry over"));
    }
    // what is applied is exactly what was confirmed
    if plan.patch_id.is_empty() || plan.patch_id != expected_id {
        return Err(err("changedSinceReview", "the changes are not the ones you confirmed (something changed meanwhile); nothing was applied. Look at them again"));
    }
    if !plan.risky.is_empty() && !accept_risky {
        return Err(err("riskyPaths", "the changes touch files that run or configure something on their own, or become executable; tick the extra confirmation to carry them over"));
    }
    if !plan.destination_clean && !on_top {
        let text = match plan.direction {
            Direction::Bring => "your working tree here has uncommitted changes; choose \"apply on top\" or commit or stash them first",
            Direction::Send => "the working copy on the server has uncommitted changes; choose \"apply on top\" or clean it first",
        };
        return Err(err("destinationDirty", text));
    }
    Ok(())
}

// ---- the two transfers -------------------------------------------------------------------------------------------------------------

/// The patch of the server's uncommitted changes (tracked changes against HEAD, binary included, plus the new files in `untracked`).
fn server_patch(ssh: &Ssh, cfg: &ServerCfg, server_path: &str, head: &str, untracked: &[&str]) -> Res<Vec<u8>> {
    check_folder(server_path).map_err(ssh_err)?;
    let input: String = untracked.iter().map(|f| format!("{f}\n")).collect();
    let out = ssh.exec_with(cfg, &remote_sh(&build_script(server_path, head)), input.as_bytes(), BUILD_TIMEOUT, MAX_PATCH_BYTES + 1).map_err(ssh_err)?;
    if out.code != 0 {
        return Err(server_exit(out.code, &out.stderr));
    }
    if out.truncated || out.stdout.len() > MAX_PATCH_BYTES {
        return Err(err("tooLarge", format!("the changes are bigger than {} MB; commit them on the server and pull", MAX_PATCH_BYTES / 1024 / 1024)));
    }
    Ok(out.stdout)
}

/// "Bring changes here": the server's uncommitted changes become uncommitted changes of the local working tree (never staged, never
/// committed). `plan_id` is the id of the plan the person confirmed; the patch is built again and applied only if it is the same.
/// Refused in a jail unless the repository is inside the fixture.
pub fn bring_changes(ssh: &Ssh, cfg: &ServerCfg, server_path: &str, local: &LocalRepo, jail: &Jail, on_top: bool, plan_id: &str, accept_risky: bool) -> Res<Applied> {
    jail.check_op("git apply", &local.path)?;
    let inner = inner_plan(Direction::Bring, ssh, cfg, server_path, local, jail, false)?;
    ready(&inner.plan, on_top, accept_risky, plan_id)?;
    // this side must still be what the plan saw
    let now = local_state(jail, &local.path)?;
    if now.head != inner.plan.local_head || (!on_top && !now.changes.is_empty()) {
        return Err(err("localChanged", "your repository changed while you were confirming (another commit, or new uncommitted changes); nothing was applied. Look at the changes again"));
    }
    apply_local(jail, &local.path, &inner.patch, inner.plan.files.len() as u32)
}

/// Validates and applies a patch to the working tree of `repo`: all or nothing, no `--index`.
pub(crate) fn apply_local(jail: &Jail, repo: &Path, patch: &[u8], files: u32) -> Res<Applied> {
    jail.check_op("git apply", repo)?;
    validate_patch(jail, repo, patch)?;
    let check = git_local(jail, repo, &["apply", "--check", "--whitespace=nowarn"], Some(patch))?;
    if !check.ok {
        return Err(err("applyCheck", format!("the changes do not fit your working tree; nothing was applied. {}", check.stderr.trim())));
    }
    let run = git_local(jail, repo, &["apply", "--whitespace=nowarn"], Some(patch))?;
    if !run.ok {
        return Err(err("applyFailed", format!("git apply failed. {}", run.stderr.trim())));
    }
    Ok(Applied { files, bytes: patch.len() as u64 })
}

/// The patch of this repository's uncommitted changes: tracked changes against HEAD (binary included) plus the new text files in
/// `untracked`.
fn local_patch(jail: &Jail, repo: &Path, untracked: &[&str]) -> Res<Vec<u8>> {
    let tracked = git_local(jail, repo, &["diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD"], None)?;
    if !tracked.ok {
        return Err(err("git", format!("git diff failed: {}", tracked.stderr.trim())));
    }
    let mut patch = tracked.stdout;
    for f in untracked {
        let one = git_local(jail, repo, &["diff", "--no-index", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", f], None)?;
        if !one.ok {
            return Err(err("git", format!("git diff of {} failed: {}", f.escape_debug(), one.stderr.trim())));
        }
        patch.extend_from_slice(&one.stdout);
        if patch.len() > MAX_PATCH_BYTES {
            break;
        }
    }
    Ok(patch)
}

/// "Send my changes there": this repository's uncommitted changes become uncommitted changes of the server's working copy. Refused
/// while a run of that server works in the repository. `busy` is asked again after the folder is locked against runs that start from
/// this IDE (`repolock`), right before the patch goes; a run started by another IDE or in a terminal on the server cannot be seen.
#[allow(clippy::too_many_arguments)]
pub fn send_changes(ssh: &Ssh, cfg: &ServerCfg, server_path: &str, local: &LocalRepo, jail: &Jail, on_top: bool, plan_id: &str, accept_risky: bool, busy: &dyn Fn() -> bool) -> Res<Applied> {
    let inner = inner_plan(Direction::Send, ssh, cfg, server_path, local, jail, busy())?;
    ready(&inner.plan, on_top, accept_risky, plan_id)?;
    let head = inner.plan.local_head.clone().ok_or_else(|| err("noCommits", "this repository has no commit yet"))?;
    let physical = inner.physical.as_deref().map(crate::cfg::canonical_path).ok_or_else(|| err("notRepository", "the real folder on the server is not known"))?;
    let _lock = crate::repolock::lock_for_transfer(&cfg.id, &physical).map_err(|m| err("repoBusy", m))?;
    if busy() {
        return Err(err("runActive", "a run on this server is working in that repository; wait until it has finished, or stop it"));
    }
    // this side must still be what the plan saw (the server side checks its own head and tree in the script)
    let now = local_state(jail, &local.path)?;
    if now.head != inner.plan.local_head {
        return Err(err("localChanged", "your repository moved to another commit while you were confirming; nothing was sent"));
    }
    send_patch(ssh, cfg, server_path, &head, on_top, accept_risky, &inner.patch, inner.plan.files.len() as u32)
}

/// Streams a patch to the apply script of the server.
#[allow(clippy::too_many_arguments)]
pub(crate) fn send_patch(ssh: &Ssh, cfg: &ServerCfg, server_path: &str, head: &str, on_top: bool, accept_risky: bool, patch: &[u8], files: u32) -> Res<Applied> {
    check_folder(server_path).map_err(ssh_err)?;
    let out = ssh.exec_with(cfg, &remote_sh(&apply_script(server_path, head, on_top, accept_risky)), patch, BUILD_TIMEOUT, 64 * 1024).map_err(ssh_err)?;
    if out.code != 0 {
        return Err(server_exit(out.code, &out.stderr));
    }
    Ok(Applied { files, bytes: patch.len() as u64 })
}

#[cfg(test)]
#[cfg(unix)] // the fake server of testkit is a set of /bin/sh scripts
#[path = "transfer_tests.rs"]
mod tests;
