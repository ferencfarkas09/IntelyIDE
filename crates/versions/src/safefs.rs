//! The only way this crate reads or replaces a file.
//!
//! A repository can hold links (Git keeps them), and a process running beside the app can swap a folder for a link while a write is
//! under way. So on Unix a file is reached through directory handles opened one folder at a time without following links: whatever
//! happens to the path afterwards, a handle still names the folder that was checked, and the new file is created and renamed inside
//! that folder, never in whatever the path leads to by then. Elsewhere the same checks are made by path (best effort).

use crate::{fail, io_err, VersionsError};
use std::path::Path;

/// The file's text. Refused unless `rel` is a regular file (not a link, not a device) of at most `cap` bytes and every folder on the
/// way is a real folder.
pub(crate) fn read(root: &Path, rel: &str, cap: u64) -> Result<String, VersionsError> {
    imp::read(root, rel, cap)
}

/// Replaces the file with `text` through a new file beside it. `expect`: what the file must still hold right before the swap.
pub(crate) fn replace(root: &Path, rel: &str, text: &str, expect: Option<&str>, cap: u64) -> Result<(), VersionsError> {
    imp::replace(root, rel, text, expect, cap)
}

fn tmp_name(name: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    format!(".{name}.intely-{}-{nanos:x}-{}.tmp", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn stale<T>(rel: &str) -> Result<T, VersionsError> {
    fail("stale", format!("{rel} changed while the versions were being written"))
}

#[cfg(unix)]
mod imp {
    use super::*;
    use rustix::fs::{fchmod, fstat, fsync, openat, renameat, unlinkat, AtFlags, FileType, Mode, OFlags, Stat, CWD};
    use rustix::io::Errno;
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::fd::OwnedFd;

    fn errno_err(e: Errno) -> VersionsError {
        io_err(std::io::Error::from(e))
    }

    /// The folder holding `rel` as an open handle, and the file's name in it. `root` is the folder the person added to the workspace
    /// (opened by path, once); everything below it is opened without following a link.
    fn parent<'a>(root: &Path, rel: &'a str) -> Result<(OwnedFd, &'a str), VersionsError> {
        let mut parts: Vec<&str> = rel.split('/').collect();
        let name = match parts.pop() {
            Some(n) if !n.is_empty() && n != "." && n != ".." => n,
            _ => return fail("outside", format!("{rel} is not inside the repository")),
        };
        if parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
            return fail("outside", format!("{rel} is not inside the repository"));
        }
        let mut dir = openat(CWD, root, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty()).map_err(errno_err)?;
        for part in parts {
            dir = openat(&dir, part, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty()).map_err(|e| match e {
                // a link where a folder should be (the kernel says one or the other, by system)
                Errno::LOOP | Errno::NOTDIR => VersionsError { code: "outside", message: format!("{rel} is not inside the repository") },
                other => errno_err(other),
            })?;
        }
        Ok((dir, name))
    }

    /// The file `name` of `dir`, opened for reading and checked on the handle (not on the path): a regular file within the cap.
    fn open(dir: &OwnedFd, name: &str, rel: &str, cap: u64) -> Result<(File, Stat), VersionsError> {
        // NONBLOCK: opening a named pipe must not wait for a writer; it is refused below like any other special file
        let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY | OFlags::CLOEXEC;
        let fd = openat(dir, name, flags, Mode::empty()).map_err(|e| match e {
            Errno::LOOP => VersionsError { code: "notRegular", message: format!("{rel} is not a regular file") },
            other => errno_err(other),
        })?;
        let st = fstat(&fd).map_err(errno_err)?;
        if FileType::from_raw_mode(st.st_mode) != FileType::RegularFile {
            return fail("notRegular", format!("{rel} is not a regular file"));
        }
        if u64::try_from(st.st_size).map_or(true, |n| n > cap) {
            return fail("tooLarge", format!("{rel} is larger than {cap} bytes"));
        }
        Ok((File::from(fd), st))
    }

    fn text_of(mut file: File, rel: &str, cap: u64) -> Result<String, VersionsError> {
        let mut s = String::new();
        // the file may have grown since fstat: never read more than the cap
        let n = (&mut file).take(cap + 1).read_to_string(&mut s).map_err(io_err)?;
        if n as u64 > cap {
            return fail("tooLarge", format!("{rel} is larger than {cap} bytes"));
        }
        Ok(s)
    }

    pub(super) fn read(root: &Path, rel: &str, cap: u64) -> Result<String, VersionsError> {
        let (dir, name) = parent(root, rel)?;
        let (file, _) = open(&dir, name, rel, cap)?;
        text_of(file, rel, cap)
    }

    pub(super) fn replace(root: &Path, rel: &str, text: &str, expect: Option<&str>, cap: u64) -> Result<(), VersionsError> {
        let (dir, name) = parent(root, rel)?;
        let (_, st) = open(&dir, name, rel, cap)?;
        let mode = Mode::from_raw_mode(st.st_mode);
        if !mode.intersects(Mode::WUSR | Mode::WGRP | Mode::WOTH) {
            return fail("readOnly", format!("{rel} is read-only"));
        }
        let tmp = tmp_name(name);
        // O_CREAT|O_EXCL fails on anything already at that name (a planted link included) instead of following it
        let flags = OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let fd = openat(&dir, tmp.as_str(), flags, Mode::RUSR | Mode::WUSR).map_err(errno_err)?;
        let result = (|| -> Result<(), VersionsError> {
            let mut f = File::from(fd);
            f.write_all(text.as_bytes()).map_err(io_err)?;
            fsync(&f).map_err(errno_err)?;
            fchmod(&f, mode).map_err(errno_err)?;
            if let Some(want) = expect {
                // one more look right before the swap: the time left for someone else's edit to be lost is that of this read
                let (now, _) = open(&dir, name, rel, cap)?;
                if text_of(now, rel, cap)? != want {
                    return stale(rel);
                }
            }
            renameat(&dir, tmp.as_str(), &dir, name).map_err(errno_err)
        })();
        if result.is_err() {
            let _ = unlinkat(&dir, tmp.as_str(), AtFlags::empty());
        }
        result
    }
}

#[cfg(not(unix))]
mod imp {
    use super::*;
    use std::io::Write;

    fn plain_file(root: &Path, rel: &str, cap: u64) -> Result<std::fs::Metadata, VersionsError> {
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
        Ok(meta)
    }

    pub(super) fn read(root: &Path, rel: &str, cap: u64) -> Result<String, VersionsError> {
        plain_file(root, rel, cap)?;
        std::fs::read_to_string(root.join(rel)).map_err(io_err)
    }

    pub(super) fn replace(root: &Path, rel: &str, text: &str, expect: Option<&str>, cap: u64) -> Result<(), VersionsError> {
        let existing = plain_file(root, rel, cap)?;
        if existing.permissions().readonly() {
            return fail("readOnly", format!("{rel} is read-only"));
        }
        let full = root.join(rel);
        let name = full.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let tmp = full.with_file_name(tmp_name(&name));
        let result = (|| -> Result<(), VersionsError> {
            let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(io_err)?;
            f.write_all(text.as_bytes()).map_err(io_err)?;
            f.sync_all().map_err(io_err)?;
            std::fs::set_permissions(&tmp, existing.permissions()).map_err(io_err)?;
            if let Some(want) = expect {
                if read(root, rel, cap)? != want {
                    return stale(rel);
                }
            }
            std::fs::rename(&tmp, &full).map_err(io_err)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result
    }
}
