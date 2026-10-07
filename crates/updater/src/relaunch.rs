//! The detached relauncher and watchdog ((design notes: updater-spec) 4.11 A5, Appendix D).
//!
//! The script is a constant with positional parameters only: no Rust value is ever interpolated
//! into its text, so the tests run exactly the shipped text. It waits for the old process to exit,
//! opens the new app, and rolls the old bundle back if the new one never starts or dies before it
//! confirmed. Liveness is the pid the new instance wrote into `started-<token>`, never a `pgrep`
//! of the path.

use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};

use crate::state::is_token;
use crate::{ErrorCode, UpdateError};

/// Called as `/bin/sh -c <SCRIPT> intely-relaunch <pid> <appPath> <stageDir> <token> <stateDir>
/// <openBinary> <bundleDirName>`. All seven parameters are always passed.
pub const SCRIPT: &str = r##"OPEN="$6"
i=0
while /bin/kill -0 "$1" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -gt 150 ] && exit 1                 # the old process never exited (30 s): do nothing more
  /bin/sleep 0.2
done
"$OPEN" "$2"
i=0
while [ ! -s "$5/started-$4" ] && [ "$i" -lt 30 ]; do   # the new instance writes its pid first thing in its process
  i=$((i + 1))
  /bin/sleep 1
done
if [ -s "$5/started-$4" ]; then
  read -r NEWPID < "$5/started-$4"
  i=0
  while [ ! -e "$5/confirmed-$4" ] && /bin/kill -0 "$NEWPID" 2>/dev/null && [ "$i" -lt 600 ]; do
    i=$((i + 1))
    /bin/sleep 1
  done
  [ -e "$5/confirmed-$4" ] && exit 0         # the new version said it is up: the app deletes the old bundle itself
  [ -e "$5/clean-exit-$4" ] && exit 0        # the user quit the new version normally before it confirmed: no rollback
  /bin/kill -0 "$NEWPID" 2>/dev/null && exit 0   # alive but not confirmed within the cap: never roll back a living app
fi
# the new app never started, or its process died before it confirmed: put the old one back
[ -d "$3/$7" ] || exit 1                     # the old app must be at the canonical place, else touch nothing
/bin/mv "$2" "$3/$7.failed" || exit 1
if ! /bin/mv "$3/$7" "$2"; then
  /bin/mv "$3/$7.failed" "$2"                # put the new one back: appPath is never left empty
  exit 1
fi
: > "$5/rolled-back-$4"
"$OPEN" "$2"
"##;

/// The production values of the sixth parameter.
pub const OPEN_BINARY: &str = "/usr/bin/open";
pub const SHELL: &str = "/bin/sh";

/// The seven positional parameters.
#[derive(Clone, Debug)]
pub struct RelaunchArgs<'a> {
    /// The pid of the running (old) process.
    pub pid: u32,
    /// The canonical installed app, which now holds the NEW bundle.
    pub app_path: &'a Path,
    /// The stage directory, which now holds the OLD bundle at `<bundle dir>`.
    pub stage_dir: &'a Path,
    pub token: &'a str,
    /// `<state>/updates`, where the markers live.
    pub state_dir: &'a Path,
    /// `/usr/bin/open` in production, a fake in tests.
    pub open_binary: &'a Path,
    pub bundle_dir_name: &'a str,
}

fn bad(detail: &str) -> UpdateError {
    UpdateError::with(ErrorCode::RelaunchFailed, detail)
}

fn plain_absolute(p: &Path, what: &str) -> Result<(), UpdateError> {
    let s = p.to_str().ok_or_else(|| bad(&format!("{what} is not UTF-8")))?;
    if !p.is_absolute() || s.chars().any(|c| c.is_control()) {
        return Err(bad(&format!("{what} must be an absolute path without control characters")));
    }
    Ok(())
}

impl RelaunchArgs<'_> {
    /// The values are already derived from trusted constants; this is a last line of defence
    /// against an argument that could make the script act on something else.
    pub fn validate(&self) -> Result<(), UpdateError> {
        if self.pid == 0 {
            return Err(bad("pid"));
        }
        if !is_token(self.token) {
            return Err(bad("token must be 16 lowercase hex digits"));
        }
        plain_absolute(self.app_path, "app path")?;
        plain_absolute(self.stage_dir, "stage directory")?;
        plain_absolute(self.state_dir, "state directory")?;
        plain_absolute(self.open_binary, "open binary")?;
        let n = self.bundle_dir_name;
        let ok = n.ends_with(".app")
            && n.len() > 4
            && !n.starts_with('.')
            && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'));
        if !ok {
            return Err(bad("bundle directory name"));
        }
        Ok(())
    }
}

/// The command, not yet spawned: scrubbed environment, null stdio, its own process group so it
/// survives the parent (the parent exits right after).
pub fn command(args: &RelaunchArgs<'_>) -> Result<Command, UpdateError> {
    args.validate()?;
    let mut cmd = Command::new(SHELL);
    cmd.arg("-c")
        .arg(SCRIPT)
        .arg("intely-relaunch")
        .arg(args.pid.to_string())
        .arg(args.app_path)
        .arg(args.stage_dir)
        .arg(args.token)
        .arg(args.state_dir)
        .arg(args.open_binary)
        .arg(args.bundle_dir_name)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    Ok(cmd)
}

/// Spawn the relauncher. The caller exits right afterwards; a spawn error means the swap has to be
/// undone in-process (`swap::undo_swap`).
pub fn spawn(args: &RelaunchArgs<'_>) -> Result<Child, UpdateError> {
    command(args)?.spawn().map_err(|e| bad(&format!("spawn failed: {e}")))
}
