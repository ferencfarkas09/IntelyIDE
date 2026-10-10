//! Allow-list `git` shim (providers-plan 3.1, 5.8). A generated `sh` script named `git` in a private directory that
//! is put first on the agent's `PATH`. It passes the read-only verbs and `git add` for explicit existing files, and
//! refuses everything else with a clear message and a line in the refusal log (exit status 126).
//!
//! **This is a speed bump, not a security layer.** Calling the real binary by absolute path (`/usr/bin/git`,
//! `/usr/local/bin/git`) bypasses the shim; the PreToolUse hook (`policy.rs`, suite S2) is what catches that.
//! The shim resolves the real git by absolute path, so it cannot recurse into itself.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// Exit status of a refused command.
pub const REFUSED_EXIT: i32 = 126;

#[derive(Debug, Clone)]
pub struct Shim {
    /// Private directory that goes first on `PATH`.
    pub dir: PathBuf,
    pub script: PathBuf,
    /// One tab-separated line per refusal: epoch seconds, working directory, the arguments.
    pub refusal_log: PathBuf,
}

impl Shim {
    /// `PATH` value with the shim directory in front of `existing`.
    pub fn path_value(&self, existing: Option<&OsStr>) -> OsString {
        let mut out = self.dir.as_os_str().to_os_string();
        if let Some(rest) = existing.filter(|p| !p.is_empty()) {
            out.push(":");
            out.push(rest);
        }
        out
    }

    /// Lines of the refusal log (empty if nothing was refused yet).
    pub fn refusals(&self) -> Vec<String> {
        fs::read_to_string(&self.refusal_log).map(|t| t.lines().map(str::to_owned).collect()).unwrap_or_default()
    }
}

/// Writes the shim into `dir` (created `0700`, must be owned by the current user). `real_git` must be an absolute
/// path to an executable that is not inside `dir`.
pub fn generate(dir: &Path, real_git: &Path) -> io::Result<Shim> {
    generate_with(dir, real_git, true)
}

/// Like [`generate`], but `git add` is refused too: the shim only reads. For processes the Run panel starts in
/// read-only mode (docs/safety.md).
pub fn generate_read_only(dir: &Path, real_git: &Path) -> io::Result<Shim> {
    generate_with(dir, real_git, false)
}

fn generate_with(dir: &Path, real_git: &Path, allow_add: bool) -> io::Result<Shim> {
    if !real_git.is_absolute() || !real_git.is_file() {
        return Err(invalid(format!("real git must be an absolute path to a file: {}", real_git.display())));
    }
    if real_git.as_os_str().as_bytes().contains(&b'\n') {
        return Err(invalid("real git path contains a newline".into()));
    }
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    let dir = dir.canonicalize()?;
    if fs::metadata(&dir)?.uid() != unsafe { libc::geteuid() } {
        return Err(invalid(format!("shim directory {} is not owned by the current user", dir.display())));
    }
    if real_git.canonicalize()?.starts_with(&dir) {
        return Err(invalid("real git is inside the shim directory (the shim would call itself)".into()));
    }
    let script = dir.join("git");
    let refusal_log = dir.join("refusals.log");
    let body = render(real_git, &refusal_log, allow_add);
    let tmp = dir.join(".git.tmp");
    {
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o755).open(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, &script)?;
    fs::OpenOptions::new().append(true).create(true).mode(0o600).open(&refusal_log)?;
    Ok(Shim { dir, script, refusal_log })
}

fn invalid(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg)
}

/// POSIX single-quoting.
fn sq(path: &Path) -> String {
    sq_str(&path.to_string_lossy())
}

fn sq_str(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// The shim script for a git that lives on another machine (a server). The caller writes it as an executable file called `git` into a
/// directory of its own, uploads that directory and puts it first on the `PATH` of the agent there. `real_git` and `refusal_log` are
/// paths on that machine; neither may contain a line break.
pub fn render_remote(real_git: &str, refusal_log: &str, allow_add: bool) -> io::Result<String> {
    for p in [real_git, refusal_log] {
        if !p.starts_with('/') || p.contains(['\n', '\r', '\0']) {
            return Err(invalid(format!("not an absolute path on one line: {p:?}")));
        }
    }
    Ok(TEMPLATE.replace("@REAL_GIT@", &sq_str(real_git)).replace("@REFUSAL_LOG@", &sq_str(refusal_log)).replace("@ALLOW_ADD@", if allow_add { "1" } else { "0" }))
}

fn render(real_git: &Path, log: &Path, allow_add: bool) -> String {
    TEMPLATE.replace("@REAL_GIT@", &sq(real_git)).replace("@REFUSAL_LOG@", &sq(log)).replace("@ALLOW_ADD@", if allow_add { "1" } else { "0" })
}

const TEMPLATE: &str = r#"#!/bin/sh
# IntelySwitchIDE allow-list git shim (generated, do not edit). A speed bump for accidental calls, not a security
# layer: /usr/bin/git and other absolute paths bypass it; the policy hook is what catches those.
REAL_GIT=@REAL_GIT@
REFUSAL_LOG=@REFUSAL_LOG@
ALLOW_ADD=@ALLOW_ADD@
unset CDPATH GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_EXTERNAL_DIFF GIT_PAGER GIT_EXEC_PATH GIT_SSH GIT_SSH_COMMAND \
  GIT_ASKPASS GIT_PROXY_COMMAND GIT_EDITOR GIT_SEQUENCE_EDITOR
GIT_TERMINAL_PROMPT=0
export GIT_TERMINAL_PROMPT
ORIG=$(printf '%s' "$*" | /usr/bin/tr '\n\r\t' '   ')

refuse() {
  printf '%s\t%s\t%s\n' "$(/bin/date +%s)" "$PWD" "$ORIG" >> "$REFUSAL_LOG" 2>/dev/null
  printf 'intely git shim: refused "git %s": %s\n' "$ORIG" "$1" >&2
  printf 'Agents may read the repository and stage explicit files; commits, pushes and every other change are made by the human in the IDE.\n' >&2
  exit 126
}

# Options that write files or run programs, also as unambiguous abbreviations (git accepts --outp, --ext-d, ...).
deny_common() {
  for a in "$@"; do
    case "$a" in
      --) return 0 ;;
      --*)
        n=${a%%=*}
        for danger in --output --ext-diff --open-files-in-pager --upload-pack --receive-pack --exec-path --no-index; do
          case "$danger" in "$n"*) refuse "option $a can write files or run programs" ;; esac
        done ;;
    esac
  done
}

START=$(pwd -P)
OPTLOCK=""
while [ $# -gt 0 ]; do
  case "$1" in
    -C)
      [ $# -ge 2 ] || refuse "-C needs a directory"
      cd -- "$2" 2>/dev/null || { printf "fatal: cannot change to '%s': No such file or directory\n" "$2" >&2; exit 128; }
      shift 2 ;;
    --no-pager|--no-replace-objects) shift ;;
    --no-optional-locks) OPTLOCK=--no-optional-locks; shift ;;
    --version) [ $# -eq 1 ] || refuse "--version takes no further arguments"; exec "$REAL_GIT" --version ;;
    -*) refuse "global option $1 is not allowed (only -C <dir>, --no-pager, --no-optional-locks)" ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || refuse "no command given"
VERB=$1
shift

case "$VERB" in
  status|diff|log|show|blame|rev-parse|ls-files|ls-tree|cat-file|describe|shortlog|rev-list)
    deny_common "$@" ;;
  grep)
    deny_common "$@"
    for a in "$@"; do
      case "$a" in
        --) break ;;
        -O*|-[!-]*O*) refuse "grep -O runs a program on the matches" ;;
      esac
    done ;;
  branch)
    LISTMODE=0
    for a in "$@"; do [ "$a" = --list ] && LISTMODE=1; done
    SKIP=0
    for a in "$@"; do
      if [ "$SKIP" = 1 ]; then SKIP=0; continue; fi
      case "$a" in
        --contains|--no-contains|--merged|--no-merged|--points-at) SKIP=1 ;;
        --contains=*|--no-contains=*|--merged=*|--no-merged=*|--points-at=*) ;;
        -a|--all|-r|--remotes|-v|-vv|--verbose|--list|--show-current|--no-color|--color|--color=*|--column|--no-column|--column=*) ;;
        --abbrev=*|--no-abbrev|--sort=*|--format=*|-i|--ignore-case) ;;
        -*) refuse "branch option $a can create, move or delete branches" ;;
        *) [ "$LISTMODE" = 1 ] || refuse "git branch $a would create a branch; use git branch --list '$a'" ;;
      esac
    done ;;
  config)
    MODE=0
    SKIP=0
    for a in "$@"; do
      if [ "$SKIP" = 1 ]; then SKIP=0; continue; fi
      case "$a" in
        --get|--get-all|--get-regexp|--get-urlmatch|-l|--list) MODE=1 ;;
        --local|--global|--system|--worktree|--show-origin|--show-scope|--bool|--int|--bool-or-int|--path|--null|-z) ;;
        --name-only|--includes|--no-includes|--type=*|--default=*) ;;
        --default) SKIP=1 ;;
        -*) refuse "config option $a can change configuration" ;;
      esac
    done
    [ "$MODE" = 1 ] || refuse "only read access to the configuration is allowed (git config --get <key>)" ;;
  remote)
    case "${1:-}" in
      "") ;;
      -v|--verbose) [ $# -eq 1 ] || refuse "only plain 'git remote -v' is allowed" ;;
      get-url)
        shift
        for a in "$@"; do
          case "$a" in --push|--all) ;; -*) refuse "remote get-url option $a is not allowed" ;; esac
        done
        set -- get-url "$@" ;;
      *) refuse "only 'git remote', 'git remote -v' and 'git remote get-url <name>' are allowed" ;;
    esac ;;
  stash)
    [ "${1:-}" = list ] || refuse "only 'git stash list' is allowed"
    deny_common "$@" ;;
  add)
    [ "$ALLOW_ADD" = 1 ] || refuse "git add is refused here: this shim is read-only"
    if [ "${1:-}" = -- ]; then shift; fi
    [ $# -gt 0 ] || refuse "git add needs explicit file paths"
    HERE=$(pwd -P)
    case "$HERE" in "$START"|"$START"/*) ;; *) refuse "git add outside the directory the agent started in ($START)" ;; esac
    for p in "$@"; do
      case "$p" in
        "") refuse "empty path" ;;
        -*) refuse "'$p': options are not allowed (no -A, -u, -p, -f, --pathspec-from-file); name the files" ;;
        :*) refuse "'$p': magic pathspecs are not allowed" ;;
        *"*"*|*"?"*|*"["*|*"\\"*) refuse "'$p': globs are not allowed" ;;
      esac
      case "${p##*/}" in
        *.example|*.sample|*.template|*.pub) ;;
        .env|.env.*|*.pem|*.key|*.p12|*.pfx|*.p8|*.jks|*.keystore|id_rsa*|id_ed25519*|.npmrc|.netrc|credentials.json|google-services.json)
          refuse "'$p' looks like a secret file" ;;
      esac
      [ ! -L "$p" ] || refuse "'$p' is a symlink"
      [ ! -d "$p" ] || refuse "'$p' is a directory; name the files"
      [ -f "$p" ] || refuse "'$p' is not an existing regular file"
    done
    GIT_LITERAL_PATHSPECS=1
    export GIT_LITERAL_PATHSPECS
    exec "$REAL_GIT" --no-pager $OPTLOCK add -- "$@" ;;
  *)
    refuse "git $VERB is not on the allow-list (read-only verbs and 'git add <file>' only)" ;;
esac

GIT_PAGER=cat
export GIT_PAGER
exec "$REAL_GIT" --no-pager $OPTLOCK "$VERB" "$@"
"#;
