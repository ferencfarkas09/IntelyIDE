//! The askpass helper and the secret FIFO (T4a).
//!
//! `ssh` asks for a key passphrase or a password through `SSH_ASKPASS` (forced with `SSH_ASKPASS_REQUIRE=force`, OpenSSH
//! 8.4+). The helper is a fixed `/bin/sh` script that releases the secret **only** when the prompt ssh passes it equals,
//! byte for byte, the prompt this tunnel expects (never a substring match, so a server-sent prompt or a host named
//! `passphrase.example.com` cannot extract anything). The secret reaches the script through one FIFO in the private
//! directory: it is written once by a short-lived thread, read once by `cat`, and unlinked. No secret is in an argv or an
//! environment variable. Only the FIFO the chosen auth needs is created (key file gives the passphrase, password gives
//! the password, agent none).

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

use intely_settings::Secret;

use super::ssh::{tcode, tunnel_error};
use super::CancelFlag;
use crate::connspec::TunnelAuth;
use crate::error::Result;
use crate::jail::Jail;

/// The helper script, frozen by a test. `$1` is the prompt ssh passes; `INTELY_ASKPASS_PROMPT_ALT` is the second accepted
/// prompt of password auth (the keyboard-interactive `Password: `). Anything else, and any second invocation (the FIFO is
/// gone by then), exits 1.
pub const SCRIPT: &str = r#"#!/bin/sh
if [ -n "$INTELY_ASKPASS_PROMPT" ] && [ "$1" = "$INTELY_ASKPASS_PROMPT" ]; then
  exec /bin/cat "$INTELY_ASKPASS_DIR/s" 2>/dev/null
fi
if [ -n "$INTELY_ASKPASS_PROMPT_ALT" ] && [ "$1" = "$INTELY_ASKPASS_PROMPT_ALT" ]; then
  exec /bin/cat "$INTELY_ASKPASS_DIR/s" 2>/dev/null
fi
exit 1
"#;

/// The keyboard-interactive prompt of a plain password server.
pub const KBDINT_PROMPT: &str = "Password: ";

/// A secret is read by ssh through a 1 KiB buffer and ends at the first newline.
pub const MAX_SECRET_BYTES: usize = 1000;

/// What ssh prints before reading a key passphrase (`key_path` as given to `-i`, S1 item e).
pub fn key_passphrase_prompt(key_path: &str) -> String {
    format!("Enter passphrase for key '{key_path}': ")
}

/// What ssh prints before reading a password. `host` is the RESOLVED host name (`ssh -G`), not an ssh_config alias
/// (S1 item e).
pub fn password_prompt(user: &str, host: &str) -> String {
    format!("{user}@{host}'s password: ")
}

/// Whether the master needs the askpass machinery at all.
pub fn needs_askpass(auth: TunnelAuth, has_secret: bool) -> bool {
    match auth {
        TunnelAuth::Agent => false,
        TunnelAuth::KeyFile => has_secret,
        TunnelAuth::Password => true,
    }
}

#[derive(Debug, Clone)]
pub enum AskpassKind {
    KeyPassphrase { key_path: String },
    Password { user: String, host: String },
}

/// The installed helper: its directory and the exact prompts it accepts. Holds no secret.
#[derive(Debug, Clone)]
pub struct AskpassSetup {
    pub dir: PathBuf,
    pub prompt: String,
    /// Password auth also accepts the keyboard-interactive `Password: `.
    pub alt_prompt: Option<String>,
}

impl AskpassSetup {
    pub fn script_path(&self) -> PathBuf {
        self.dir.join("askpass")
    }

    pub fn fifo_path(&self) -> PathBuf {
        self.dir.join("s")
    }

    /// The variables ssh needs; the values are paths and prompt text, never a secret.
    pub fn env(&self) -> Vec<(String, String)> {
        let mut v = vec![
            ("SSH_ASKPASS".to_string(), self.script_path().to_string_lossy().into_owned()),
            ("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string()),
            ("DISPLAY".to_string(), ":0".to_string()),
            ("INTELY_ASKPASS_DIR".to_string(), self.dir.to_string_lossy().into_owned()),
            ("INTELY_ASKPASS_PROMPT".to_string(), self.prompt.clone()),
        ];
        if let Some(alt) = &self.alt_prompt {
            v.push(("INTELY_ASKPASS_PROMPT_ALT".to_string(), alt.clone()));
        }
        v
    }
}

/// A secret ssh can be handed through the FIFO: 1 to 1000 bytes, no newline, carriage return or NUL.
pub fn check_secret(secret: &Secret) -> Result<()> {
    let s = secret.expose();
    if s.is_empty() || s.len() > MAX_SECRET_BYTES {
        return Err(tunnel_error(tcode::PASSPHRASE, "the secret must be between 1 and 1000 bytes"));
    }
    if s.contains(['\n', '\r', '\0']) {
        return Err(tunnel_error(tcode::PASSPHRASE, "the secret must not contain a line break"));
    }
    Ok(())
}

/// Writes the helper script (0700, `create_new`) and creates the one FIFO (0600) in `dir`, which the tunnel directory
/// owner created 0700. A second call in the same directory fails: there is at most one FIFO. Writes are jail-gated.
#[cfg(unix)]
pub fn install(jail: &Jail, dir: &Path, kind: &AskpassKind) -> Result<AskpassSetup> {
    use std::io::Write;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let (prompt, alt_prompt) = match kind {
        AskpassKind::KeyPassphrase { key_path } => (key_passphrase_prompt(key_path), None),
        AskpassKind::Password { user, host } => (password_prompt(user, host), Some(KBDINT_PROMPT.to_string())),
    };
    let setup = AskpassSetup { dir: dir.to_path_buf(), prompt, alt_prompt };
    let (script, fifo) = (setup.script_path(), setup.fifo_path());
    jail.check_write(&script)?;
    jail.check_write(&fifo)?;
    let cfg = |m: &str| tunnel_error(tcode::CONFIG, m);
    let meta = std::fs::symlink_metadata(dir).map_err(|_| cfg("the tunnel directory is missing"))?;
    if !meta.is_dir() || meta.permissions().mode() & 0o077 != 0 {
        return Err(cfg("the tunnel directory is not private"));
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&script)
        .map_err(|_| cfg("the askpass helper could not be created"))?;
    f.write_all(SCRIPT.as_bytes()).map_err(|_| cfg("the askpass helper could not be written"))?;
    drop(f);
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).map_err(|_| cfg("the askpass helper mode could not be set"))?;
    let c = std::ffi::CString::new(fifo.as_os_str().as_bytes()).map_err(|_| cfg("the FIFO path is not valid"))?;
    // SAFETY: `c` is a valid NUL-terminated path for the duration of the call.
    if unsafe { libc::mkfifo(c.as_ptr(), 0o600) } != 0 {
        return Err(cfg("the secret FIFO could not be created"));
    }
    std::fs::set_permissions(&fifo, std::fs::Permissions::from_mode(0o600)).map_err(|_| cfg("the FIFO mode could not be set"))?;
    Ok(setup)
}

#[cfg(not(unix))]
pub fn install(_jail: &Jail, _dir: &Path, _kind: &AskpassKind) -> Result<AskpassSetup> {
    Err(tunnel_error(tcode::NO_SSH, "SSH tunnels are not available on this system"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FifoOutcome {
    /// A reader opened the FIFO and the secret was written.
    Delivered,
    /// Nobody opened the FIFO before the deadline (ssh never asked).
    TimedOut,
    /// The cancel flag was set (master ready, master exited, tunnel closed).
    Cancelled,
    /// The FIFO vanished or the write failed.
    Failed,
}

/// Starts the one-shot FIFO writer: it opens the FIFO `O_WRONLY|O_NONBLOCK` in a loop (that fails with ENXIO until
/// the helper has opened the read end), stops at `deadline` or when `cancel` is set, writes the secret once, closes,
/// unlinks the FIFO and zeroes its copy of the secret. The thread never outlives the deadline.
#[cfg(unix)]
pub fn spawn_writer(fifo: PathBuf, secret: &Secret, deadline: Duration, cancel: CancelFlag) -> Result<std::thread::JoinHandle<FifoOutcome>> {
    check_secret(secret)?;
    let data = secret.expose().as_bytes().to_vec();
    Ok(std::thread::spawn(move || write_once(&fifo, data, deadline, &cancel)))
}

#[cfg(not(unix))]
pub fn spawn_writer(_fifo: PathBuf, _secret: &Secret, _deadline: Duration, _cancel: CancelFlag) -> Result<std::thread::JoinHandle<FifoOutcome>> {
    Err(tunnel_error(tcode::NO_SSH, "SSH tunnels are not available on this system"))
}

#[cfg(unix)]
fn write_once(fifo: &Path, mut data: Vec<u8>, deadline: Duration, cancel: &CancelFlag) -> FifoOutcome {
    use std::io::{ErrorKind, Write};
    use std::os::unix::fs::OpenOptionsExt;
    use zeroize::Zeroize;

    let start = std::time::Instant::now();
    let outcome = loop {
        if cancel.load(Ordering::SeqCst) {
            break FifoOutcome::Cancelled;
        }
        if start.elapsed() >= deadline {
            break FifoOutcome::TimedOut;
        }
        match std::fs::OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW).open(fifo) {
            Ok(mut f) => {
                let mut off = 0;
                let res = loop {
                    if off == data.len() {
                        break FifoOutcome::Delivered;
                    }
                    match f.write(&data[off..]) {
                        Ok(n) => off += n,
                        Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::Interrupted => {
                            if start.elapsed() >= deadline || cancel.load(Ordering::SeqCst) {
                                break FifoOutcome::TimedOut;
                            }
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break FifoOutcome::Failed,
                    }
                };
                break res;
            }
            // ENXIO: no reader yet
            Err(e) if e.raw_os_error() == Some(libc::ENXIO) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) if e.kind() == ErrorKind::NotFound => break FifoOutcome::Failed,
            Err(_) => break FifoOutcome::Failed,
        }
    };
    data.zeroize();
    let _ = std::fs::remove_file(fifo);
    outcome
}

/// Removes the helper script and the FIFO (idempotent); used by the tunnel teardown.
pub fn remove(setup: &AskpassSetup) {
    let _ = std::fs::remove_file(setup.fifo_path());
    let _ = std::fs::remove_file(setup.script_path());
}
