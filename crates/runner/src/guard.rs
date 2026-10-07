//! The "Allow processes" capability: whether the jail lets the Run panel start a process (docs/safety.md).
//!
//! - jail off: yes.
//! - `INTELY_READONLY`: no, unless the user switched on "Allow processes" in Settings > Safety for this session. The
//!   switch lives in memory only and is off at every launch; it relaxes process starts and nothing else: the IDE's own
//!   git mutations and git network access stay refused, and what the process starts gets a hardened git environment
//!   plus a PATH-first read-only `git` shim ([`read_only_git_path`]). The shim is a speed bump: a script that calls
//!   git by absolute path, or writes the repo without git, is not stopped.
//! - `INTELY_E2E`: only inside the fixture root (`testJail` elsewhere), whatever the switch says.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use intely_core::jail::{Jail, Mode, READ_ONLY};
use intely_core::EngineError;
use intely_agent_gate::shim;

use crate::types::ProcessAccess;

pub const READ_ONLY_HINT: &str = "Starting a process is refused in read-only mode. Turn on \"Allow processes\" in Settings > Safety to run dev servers for this session.";

pub fn check_process(jail: &Jail, allowed: bool, cwd: &Path) -> Result<(), EngineError> {
    match jail.mode() {
        Mode::Off => Ok(()),
        Mode::ReadOnly if allowed => Ok(()),
        Mode::ReadOnly => Err(EngineError::new(READ_ONLY, READ_ONLY_HINT)),
        Mode::E2e => jail.check_op("run", cwd),
    }
}

pub fn access(jail: &Jail, allowed: bool, cwd: Option<&Path>) -> ProcessAccess {
    let mode = match jail.mode() {
        Mode::Off => "off",
        Mode::ReadOnly => "readOnly",
        Mode::E2e => "e2e",
    };
    let verdict = match cwd {
        Some(dir) => check_process(jail, allowed, dir),
        None if jail.mode() == Mode::E2e => Ok(()),
        None => check_process(jail, allowed, Path::new("/")),
    };
    ProcessAccess { allowed, jail: mode.to_owned(), startable: verdict.is_ok(), reason: verdict.err().map(|e| e.message) }
}

/// First executable `git` on `path`.
fn find_git(path: &OsStr) -> Option<PathBuf> {
    std::env::split_paths(path).map(|d| d.join("git")).find(|p| p.is_absolute() && p.is_file())
}

/// In read-only mode: the `PATH` value that puts a read-only `git` shim (no commit, checkout, reset, add, ...; exit
/// 126) in front of `path`. `None` outside read-only mode and when there is no git on `path`. An error when the shim
/// cannot be written: a process must not start without it.
pub fn read_only_git_path(jail: &Jail, path: Option<&OsStr>) -> Result<Option<OsString>, EngineError> {
    if jail.mode() != Mode::ReadOnly {
        return Ok(None);
    }
    let Some(real) = path.and_then(find_git) else { return Ok(None) };
    let dir = std::env::temp_dir().join(format!("intely-run-git-{}", unsafe { libc::geteuid() }));
    let shim = shim::generate_read_only(&dir, &real)
        .map_err(|e| EngineError::new(intely_core::code::IO, format!("could not prepare the read-only git shim: {e}")))?;
    Ok(Some(shim.path_value(path)))
}
