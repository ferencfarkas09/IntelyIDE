//! The private temp directory of one tunnel (T4c): `<temp>/intely-ssh-<uid>-<16 hex random>`, created `0700` atomically.
//!
//! It holds the ssh control socket `c` (a full authenticated channel to the bastion), the askpass helper `askpass` (0700)
//! and, for a moment, the secret FIFO `s` (0600). Nothing else is ever put there, which is why removal unlinks exactly
//! those names and then `rmdir`s: never `remove_dir_all`. The agent policy refuses every path with an `intely-ssh-`
//! component (`agent_core` `policy/paths.rs`).

use std::path::{Path, PathBuf};

use super::ssh::{tcode, tunnel_error};
use crate::error::Result;
use crate::jail::Jail;

/// The prefix the agent policy protects. Keep in step with `agent_core::policy::paths::TUNNEL_DIR_PREFIX`.
pub const PREFIX: &str = "intely-ssh-";

/// Names that may live in a tunnel directory.
pub const KNOWN_FILES: [&str; 3] = ["c", "askpass", "s"];

/// `sun_path` is 104 bytes on macOS and 108 on Linux; the control path must stay under 100.
pub const MAX_CONTROL_PATH: usize = 100;

/// ssh does not bind the control socket at the path it is given but at `<path>.<16 random characters>` (17 more bytes) and
/// renames it afterwards, so against a real ssh `<dir>/c` must be shorter than 87 bytes (103 usable bytes on macOS); a longer one
/// fails with `unix_listener: path ... too long for Unix domain socket` (seen against a real sshd when the temp directory was
/// nested one level below the macOS default). A longer base is moved to `/tmp` when the jail allows writing there.
pub const SSH_SAFE_CONTROL_PATH: usize = 87;

pub fn dir_name(uid: u32, random_hex: &str) -> String {
    format!("{PREFIX}{uid}-{random_hex}")
}

/// `intely-ssh-<uid>-<16 lowercase hex>` for exactly this uid.
pub fn valid_dir_name(name: &str, uid: u32) -> bool {
    let Some(rest) = name.strip_prefix(PREFIX) else { return false };
    let Some(rest) = rest.strip_prefix(&format!("{uid}-")) else { return false };
    rest.len() == 16 && rest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(unix)]
pub fn current_uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

#[cfg(not(unix))]
pub fn current_uid() -> u32 {
    0
}

fn random_hex8() -> Result<String> {
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).map_err(|_| tunnel_error(tcode::CONFIG, "no random numbers are available"))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// What a directory must look like before anything is done to it: a real directory (not a symlink), owned by this user,
/// mode exactly 0700.
#[cfg(unix)]
pub fn is_private_dir(dir: &Path, uid: u32) -> bool {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    match std::fs::symlink_metadata(dir) {
        Ok(m) => m.is_dir() && !m.file_type().is_symlink() && m.uid() == uid && m.permissions().mode() & 0o777 == 0o700,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
pub fn is_private_dir(_dir: &Path, _uid: u32) -> bool {
    false
}

/// Unlinks the known files and `rmdir`s the directory. Idempotent; never recursive.
pub fn remove_known(dir: &Path) {
    for f in KNOWN_FILES {
        let _ = std::fs::remove_file(dir.join(f));
    }
    let _ = std::fs::remove_dir(dir);
}

#[derive(Debug)]
pub struct TunnelDir {
    path: PathBuf,
    uid: u32,
}

impl TunnelDir {
    /// Creates a fresh directory below `base` (normally `std::env::temp_dir()`): the write is jail-gated, the creation is
    /// atomic (`mkdir` with mode 0700 fails if the name exists, no `create_dir` then `chmod`) and owner, type and mode are
    /// re-checked. When `<dir>/c` would reach [`SSH_SAFE_CONTROL_PATH`] bytes the same pattern is used under `/tmp` (if the jail allows it).
    #[cfg(unix)]
    pub fn create(jail: &Jail, base: &Path) -> Result<Self> {
        let uid = current_uid();
        let mut base = base.to_path_buf();
        let name_len = dir_name(uid, "0000000000000000").len();
        if base.as_os_str().len() + 1 + name_len + 2 >= SSH_SAFE_CONTROL_PATH {
            // the test jail allows writes below the fixture or temp directory only: there the long base is kept (a fake ssh does
            // not bind a real socket; `ctl_arg` still refuses a path of MAX_CONTROL_PATH or more)
            let tmp = PathBuf::from("/tmp");
            if jail.check_write(&tmp).is_ok() {
                base = tmp;
            }
        }
        // up to three attempts: a pre-existing name is refused, never reused
        for _ in 0..3 {
            let name = dir_name(uid, &random_hex8()?);
            match Self::create_at(jail, base.join(name)) {
                Err(e) if e.message.contains("already exists") => continue,
                other => return other,
            }
        }
        Err(tunnel_error(tcode::CONFIG, "the tunnel directory could not be created"))
    }

    /// Creates exactly `path` (mode 0700, atomic). An existing file, directory or symlink of that name is refused and
    /// left alone.
    #[cfg(unix)]
    pub fn create_at(jail: &Jail, path: PathBuf) -> Result<Self> {
        use std::os::unix::fs::DirBuilderExt;
        let uid = current_uid();
        jail.check_write(&path)?;
        match std::fs::DirBuilder::new().mode(0o700).create(&path) {
            Ok(()) => {
                if !is_private_dir(&path, uid) {
                    let _ = std::fs::remove_dir(&path);
                    return Err(tunnel_error(tcode::CONFIG, "the tunnel directory is not private"));
                }
                Ok(Self { path, uid })
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(tunnel_error(tcode::CONFIG, "the tunnel directory already exists")),
            Err(_) => Err(tunnel_error(tcode::CONFIG, "the tunnel directory could not be created")),
        }
    }

    #[cfg(not(unix))]
    pub fn create(_jail: &Jail, _base: &Path) -> Result<Self> {
        Err(tunnel_error(tcode::NO_SSH, "SSH tunnels are not available on this system"))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The control socket path `<dir>/c`.
    pub fn control(&self) -> PathBuf {
        self.path.join("c")
    }

    /// Removes the known files and the directory, after re-checking that the path still is the private directory this
    /// value created (not replaced by a symlink or another owner's directory).
    pub fn remove(&self) {
        if is_private_dir(&self.path, self.uid) {
            remove_known(&self.path);
        }
    }
}
