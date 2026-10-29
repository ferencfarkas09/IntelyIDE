//! The only way this crate reads a file of a repository. A repository is hostile input: it can hold links (Git keeps them),
//! devices, named pipes and huge files. So on Unix a file is reached through directory handles opened one folder at a time
//! without following a link, and checked on the handle (a regular file within the cap); elsewhere the same checks are made by
//! path (best effort). Invalid UTF-8 is replaced, never an error.

use crate::{fail, io_err, WebError};
use std::path::Path;

/// The file's text (lossy). Refused unless `rel` is a regular file of at most `cap` bytes and every folder on the way is a real folder.
pub(crate) fn read(root: &Path, rel: &str, cap: u64) -> Result<String, WebError> {
    let bytes = imp::read_bytes(root, rel, cap)?;
    Ok(match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    })
}

fn clean_parts(rel: &str) -> Result<Vec<&str>, WebError> {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
        return fail("outside", format!("{rel} is not inside the repository"));
    }
    Ok(parts)
}

#[cfg(unix)]
mod imp {
    use super::*;
    use rustix::fs::{fstat, openat, FileType, Mode, OFlags, CWD};
    use rustix::io::Errno;
    use std::io::Read;

    fn errno_err(e: Errno) -> WebError {
        io_err(std::io::Error::from(e))
    }

    pub(super) fn read_bytes(root: &Path, rel: &str, cap: u64) -> Result<Vec<u8>, WebError> {
        let mut parts = clean_parts(rel)?;
        let name = parts.pop().unwrap_or("");
        let mut dir = openat(CWD, root, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty()).map_err(errno_err)?;
        for part in parts {
            dir = openat(&dir, part, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty()).map_err(|e| match e {
                Errno::LOOP | Errno::NOTDIR => WebError { code: "outside", message: format!("{rel} is not inside the repository") },
                other => errno_err(other),
            })?;
        }
        // NONBLOCK: opening a named pipe must not wait for a writer; it is refused below like any other special file
        let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY | OFlags::CLOEXEC;
        let fd = openat(&dir, name, flags, Mode::empty()).map_err(|e| match e {
            Errno::LOOP => WebError { code: "notRegular", message: format!("{rel} is not a regular file") },
            other => errno_err(other),
        })?;
        let st = fstat(&fd).map_err(errno_err)?;
        if FileType::from_raw_mode(st.st_mode) != FileType::RegularFile {
            return fail("notRegular", format!("{rel} is not a regular file"));
        }
        if u64::try_from(st.st_size).map_or(true, |n| n > cap) {
            return fail("tooLarge", format!("{rel} is larger than {cap} bytes"));
        }
        let mut out = Vec::new();
        // the file may have grown since fstat: never read more than the cap
        let n = std::fs::File::from(fd).take(cap + 1).read_to_end(&mut out).map_err(io_err)?;
        if n as u64 > cap {
            return fail("tooLarge", format!("{rel} is larger than {cap} bytes"));
        }
        Ok(out)
    }
}

#[cfg(not(unix))]
mod imp {
    use super::*;
    use std::io::Read;

    pub(super) fn read_bytes(root: &Path, rel: &str, cap: u64) -> Result<Vec<u8>, WebError> {
        clean_parts(rel)?;
        let full = root.join(rel);
        let meta = std::fs::symlink_metadata(&full).map_err(io_err)?;
        if !meta.file_type().is_file() {
            return fail("notRegular", format!("{rel} is not a regular file"));
        }
        if meta.len() > cap {
            return fail("tooLarge", format!("{rel} is larger than {cap} bytes"));
        }
        let inside = match (full.parent().map(std::fs::canonicalize), std::fs::canonicalize(root)) {
            (Some(Ok(parent)), Ok(base)) => parent.starts_with(base),
            _ => false,
        };
        if !inside {
            return fail("outside", format!("{rel} is not inside the repository"));
        }
        let mut out = Vec::new();
        std::fs::File::open(&full).map_err(io_err)?.take(cap + 1).read_to_end(&mut out).map_err(io_err)?;
        if out.len() as u64 > cap {
            return fail("tooLarge", format!("{rel} is larger than {cap} bytes"));
        }
        Ok(out)
    }
}
