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
    /// Windows: `git.cmd` next to the script, so that cmd and PowerShell (which only run `.exe`/`.cmd` from `PATH`) meet the
    /// allow-list too; it runs the script with Git for Windows' own `sh.exe`. `None` elsewhere, or when no Git Bash was found.
    pub cmd: Option<PathBuf>,
}

impl Shim {
    /// `PATH` value with the shim directory in front of `existing`.
    pub fn path_value(&self, existing: Option<&OsStr>) -> OsString {
        let mut out = self.dir.as_os_str().to_os_string();
        if let Some(rest) = existing.filter(|p| !p.is_empty()) {
            out.push(if cfg!(windows) { ";" } else { ":" });
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
    if real_git.to_string_lossy().contains('\n') {
        return Err(invalid("real git path contains a newline".into()));
    }
    fs::create_dir_all(dir)?;
    let dir = private_dir(dir)?;
    if real_git.canonicalize()?.starts_with(&dir) {
        return Err(invalid("real git is inside the shim directory (the shim would call itself)".into()));
    }
    let script = dir.join("git");
    let refusal_log = dir.join("refusals.log");
    let body = render(real_git, &refusal_log, allow_add);
    let tmp = dir.join(".git.tmp");
    {
        let mut f = open_options(0o755).write(true).create(true).truncate(true).open(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, &script)?;
    open_options(0o600).append(true).create(true).open(&refusal_log)?;
    let cmd = if cfg!(windows) { write_cmd_shim(&dir, real_git)? } else { None };
    Ok(Shim { dir, script, refusal_log, cmd })
}

/// Git for Windows' `sh.exe` that belongs to `real_git` (`<Git>\cmd\git.exe`, `<Git>\bin\git.exe` or
/// `<Git>\mingw64\bin\git.exe`): `bin\sh.exe` or `usr\bin\sh.exe` of the install, at most three folders up. Never taken
/// from `PATH`, so a repository cannot plant a `sh.exe` the shim would run.
pub fn git_bash_for(real_git: &Path) -> Option<PathBuf> {
    real_git.ancestors().skip(1).take(3).flat_map(|d| [d.join("bin").join("sh.exe"), d.join("usr").join("bin").join("sh.exe")]).find(|p| p.is_file())
}

/// The `git.cmd` body that hands every argument to the shim script through `sh`. `None` when a path holds a character a
/// batch file would expand or end a quote on (`%`, `"`, a line break): the cmd shim is then left out, never written wrong.
pub fn render_cmd(sh: &Path) -> Option<String> {
    let sh = sh.to_string_lossy();
    if sh.contains(['%', '"', '\n', '\r', '\0']) {
        return None;
    }
    Some(format!(
        "@echo off\r\nrem IntelySwitchIDE git shim for cmd and PowerShell (generated, do not edit): the same allow-list, run by Git Bash.\r\n\"{sh}\" \"%~dp0git\" %*\r\nexit /b %ERRORLEVEL%\r\n"
    ))
}

fn write_cmd_shim(dir: &Path, real_git: &Path) -> io::Result<Option<PathBuf>> {
    let Some(body) = git_bash_for(real_git).and_then(|sh| render_cmd(&sh)) else { return Ok(None) };
    if dir.to_string_lossy().contains(['%', '"']) {
        return Ok(None);
    }
    let path = dir.join("git.cmd");
    let tmp = dir.join(".git.cmd.tmp");
    {
        let mut f = open_options(0o755).write(true).create(true).truncate(true).open(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, &path)?;
    Ok(Some(path))
}

/// Makes `dir` private to the user and returns its canonical path. Unix: mode 0700 and owned by the current user. Windows:
/// the profile directory the caller picks is already private to the user (ACLs inherit from it).
#[cfg(unix)]
fn private_dir(dir: &Path) -> io::Result<PathBuf> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    let dir = dir.canonicalize()?;
    if fs::metadata(&dir)?.uid() != unsafe { libc::geteuid() } {
        return Err(invalid(format!("shim directory {} is not owned by the current user", dir.display())));
    }
    Ok(dir)
}

#[cfg(not(unix))]
fn private_dir(dir: &Path) -> io::Result<PathBuf> {
    dir.canonicalize()
}

fn open_options(mode: u32) -> fs::OpenOptions {
    #[allow(unused_mut)]
    let mut o = fs::OpenOptions::new();
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, mode);
    #[cfg(not(unix))]
    let _ = mode;
    o
}

fn invalid(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg)
}

/// POSIX single-quoting.
fn sq(path: &Path) -> String {
    // Git Bash (the shell Claude Code uses on Windows) runs this script: forward slashes keep `C:/...` paths intact.
    if cfg!(windows) { sq_str(&path.to_string_lossy().replace('\\', "/")) } else { sq_str(&path.to_string_lossy()) }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_bash_is_found_next_to_the_git_of_a_git_for_windows_install_only() {
        let root = tempfile::tempdir().unwrap();
        let git = root.path().join("Git");
        for d in ["cmd", "bin", "usr/bin", "mingw64/bin"] {
            fs::create_dir_all(git.join(d)).unwrap();
        }
        fs::write(git.join("cmd/git.exe"), "").unwrap();
        fs::write(git.join("mingw64/bin/git.exe"), "").unwrap();
        assert_eq!(git_bash_for(&git.join("cmd/git.exe")), None, "no sh.exe yet");
        fs::write(git.join("usr/bin/sh.exe"), "").unwrap();
        assert_eq!(git_bash_for(&git.join("cmd/git.exe")), Some(git.join("usr").join("bin").join("sh.exe")));
        fs::write(git.join("bin/sh.exe"), "").unwrap();
        assert_eq!(git_bash_for(&git.join("cmd/git.exe")), Some(git.join("bin").join("sh.exe")));
        assert_eq!(git_bash_for(&git.join("mingw64/bin/git.exe")), Some(git.join("bin").join("sh.exe")), "two folders up");
        let lone = root.path().join("elsewhere/deep/a/b/git.exe");
        assert_eq!(git_bash_for(&lone), None);
    }

    #[test]
    fn the_cmd_shim_hands_every_argument_to_the_script_and_refuses_paths_it_cannot_quote() {
        let body = render_cmd(Path::new(r"C:\Program Files\Git\bin\sh.exe")).unwrap();
        assert!(body.starts_with("@echo off\r\n"));
        assert!(body.contains("\"C:\\Program Files\\Git\\bin\\sh.exe\" \"%~dp0git\" %*\r\n"), "{body}");
        assert!(body.ends_with("exit /b %ERRORLEVEL%\r\n"));
        for bad in [r"C:\100%\sh.exe", "C:\\a\"b\\sh.exe", "C:\\a\nb\\sh.exe"] {
            assert_eq!(render_cmd(Path::new(bad)), None, "{bad:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_the_shim_also_writes_a_cmd_file_when_git_bash_is_there() {
        let dir = tempfile::tempdir().unwrap();
        let Some(git) = std::env::var("PATH").ok().and_then(|p| intely_core::sys::find_in_path(&p, "git")) else { return };
        let shim = generate(&dir.path().join("shim"), &git).unwrap();
        match git_bash_for(&git) {
            Some(_) => assert!(shim.cmd.as_ref().is_some_and(|c| c.is_file())),
            None => assert!(shim.cmd.is_none()),
        }
    }
}
