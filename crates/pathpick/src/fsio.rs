//! Safe-open reads for the files a hostile folder controls ((design notes: workspaces-spec) 5.5).
//!
//! `open(O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)`, `fstat`, require a regular file, read at most `cap` bytes. A
//! FIFO opened with `O_NONBLOCK` does not block, a device or a symlink is refused, so `.git/HEAD` as a FIFO or `config`
//! as a link to `/dev/zero` fails at once instead of hanging the command.

use std::fs::OpenOptions;
use std::io::{self, Read};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

pub const HEAD_CAP: usize = 4 * 1024;
pub const CONFIG_CAP: usize = 256 * 1024;

pub fn read_small(path: &Path, cap: usize) -> io::Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "not a regular file"));
    }
    let mut buf = Vec::new();
    file.take(cap as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

pub fn read_small_string(path: &Path, cap: usize) -> io::Result<String> {
    Ok(String::from_utf8_lossy(&read_small(path, cap)?).into_owned())
}
