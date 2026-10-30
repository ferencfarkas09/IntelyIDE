//! The only way this crate touches the disk, and it only reads.
//!
//! A repository is hostile input: it can hold links (Git keeps them) that point out of it, named pipes, devices and files of
//! any size. So on Unix a file is reached through directory handles opened one folder at a time without following links, and
//! what is read is checked on the open handle, not on the path. Elsewhere the same checks are made by path (best effort).

use std::path::Path;

/// Why a path could not be read. A code, never a path or file content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Fail {
    Missing,
    TooLarge,
    NotRegular,
    Outside,
    Io,
}

/// What a path is, looked at without following a link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Entry {
    Missing,
    File(u64),
    Dir,
    Link,
    Other,
}

impl Entry {
    pub fn is_file(self) -> bool {
        matches!(self, Entry::File(_))
    }
    pub fn is_dir(self) -> bool {
        self == Entry::Dir
    }
}

/// A directory never lists more than this many names: a folder of millions of files must not stall a scan.
pub(crate) const MAX_ENTRIES: usize = 5000;

/// The file's text (invalid UTF-8 becomes U+FFFD). Refused unless `rel` is a regular file of at most `cap` bytes and every folder
/// on the way is a real folder.
pub(crate) fn read(root: &Path, rel: &str, cap: u64) -> Result<String, Fail> {
    let bytes = imp::read(root, rel, cap)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub(crate) fn stat(root: &Path, rel: &str) -> Entry {
    imp::stat(root, rel)
}

/// The names in the folder `rel` ("" = the repository root) with what each is, sorted by name, and whether the folder had more
/// than could be looked at. At most `MAX_ENTRIES` names are looked at, but the well-known project files are always among them:
/// a hostile folder of thousands of names must not be able to hide `build.gradle` or `Info.plist` and so cause a false "missing".
pub(crate) fn list_full(root: &Path, rel: &str) -> Result<(Vec<(String, Entry)>, bool), Fail> {
    let (mut v, truncated) = imp::list(root, rel)?;
    v.sort_by(|a, b| a.0.cmp(&b.0));
    Ok((v, truncated))
}

pub(crate) fn list(root: &Path, rel: &str) -> Result<Vec<(String, Entry)>, Fail> {
    list_full(root, rel).map(|l| l.0)
}

/// Names of files and folders that the checks look for by name.
fn priority(name: &str) -> bool {
    matches!(
        name,
        "package.json" | "app.json" | "pubspec.yaml" | "Podfile" | "Podfile.lock" | "Podfile.properties.json" | "Pods" | "ios" | "android" | "app" | "src" | "main" | "res" | "fastlane" | "gradle" | "gradlew" | "build.gradle" | "build.gradle.kts" | "settings.gradle" | "settings.gradle.kts" | "gradle.properties" | "local.properties" | "libs.versions.toml" | "gradle-wrapper.properties" | "wrapper" | "AndroidManifest.xml" | "Info.plist" | "project.pbxproj" | "PrivacyInfo.xcprivacy" | "Contents.json" | ".xcode.env" | ".gitignore" | "Manifest.lock"
    ) || name.starts_with("app.config.")
        || name.starts_with(".env")
        || name.starts_with("mipmap")
        || name.starts_with("LaunchScreen")
        || name.starts_with("ic_launcher")
        || (name.len() < 64 && [".xcodeproj", ".xcassets", ".appiconset", ".entitlements", ".storyboard"].iter().any(|e| name.ends_with(e)))
}

/// Keeps every priority name and the first `MAX_ENTRIES` others, without remembering more than that of a folder of millions.
struct Picker {
    prio: Vec<String>,
    rest: Vec<String>,
    seen: usize,
    truncated: bool,
}

/// More names than this are not even counted.
const MAX_SEEN: usize = 2_000_000;

impl Picker {
    fn new() -> Picker {
        Picker { prio: Vec::new(), rest: Vec::new(), seen: 0, truncated: false }
    }
    /// `false` = stop feeding names.
    fn push(&mut self, name: String) -> bool {
        self.seen += 1;
        if self.seen > MAX_SEEN {
            self.truncated = true;
            return false;
        }
        if priority(&name) && self.prio.len() < 2000 {
            self.prio.push(name);
        } else if self.rest.len() < MAX_ENTRIES {
            self.rest.push(name);
        } else {
            self.truncated = true;
        }
        true
    }
    fn names(mut self) -> (Vec<String>, bool) {
        self.prio.append(&mut self.rest);
        (self.prio, self.truncated)
    }
}

fn parts_of(rel: &str) -> Result<Vec<&str>, Fail> {
    if rel.is_empty() {
        return Ok(Vec::new());
    }
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".." || p.contains('\0')) {
        return Err(Fail::Outside);
    }
    Ok(parts)
}

#[cfg(unix)]
mod imp {
    use super::*;
    use rustix::fs::{fstat, openat, statat, AtFlags, Dir, FileType, Mode, OFlags, Stat, CWD};
    use rustix::io::Errno;
    use std::io::Read;
    use std::os::fd::OwnedFd;

    fn fail_of(e: Errno) -> Fail {
        match e {
            Errno::NOENT => Fail::Missing,
            Errno::LOOP | Errno::NOTDIR => Fail::Outside,
            _ => Fail::Io,
        }
    }

    /// The folder `parts` below the root as an open handle.
    fn dir_of(root: &Path, parts: &[&str]) -> Result<OwnedFd, Fail> {
        let mut dir = openat(CWD, root, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty()).map_err(fail_of)?;
        for part in parts {
            dir = openat(&dir, *part, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty()).map_err(fail_of)?;
        }
        Ok(dir)
    }

    fn entry_of(st: &Stat) -> Entry {
        match FileType::from_raw_mode(st.st_mode) {
            FileType::RegularFile => Entry::File(u64::try_from(st.st_size).unwrap_or(u64::MAX)),
            FileType::Directory => Entry::Dir,
            FileType::Symlink => Entry::Link,
            _ => Entry::Other,
        }
    }

    pub(super) fn read(root: &Path, rel: &str, cap: u64) -> Result<Vec<u8>, Fail> {
        let mut parts = parts_of(rel)?;
        let name = parts.pop().ok_or(Fail::Outside)?;
        let dir = dir_of(root, &parts)?;
        // NONBLOCK: opening a named pipe must not wait for a writer; it is refused below like any other special file
        let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY | OFlags::CLOEXEC;
        let fd = openat(&dir, name, flags, Mode::empty()).map_err(|e| if e == Errno::LOOP { Fail::NotRegular } else { fail_of(e) })?;
        let st = fstat(&fd).map_err(fail_of)?;
        if FileType::from_raw_mode(st.st_mode) != FileType::RegularFile {
            return Err(Fail::NotRegular);
        }
        if u64::try_from(st.st_size).map_or(true, |n| n > cap) {
            return Err(Fail::TooLarge);
        }
        let mut buf = Vec::new();
        // the file may have grown since fstat: never read more than the cap
        let n = std::fs::File::from(fd).take(cap + 1).read_to_end(&mut buf).map_err(|_| Fail::Io)?;
        if n as u64 > cap {
            return Err(Fail::TooLarge);
        }
        Ok(buf)
    }

    pub(super) fn stat(root: &Path, rel: &str) -> Entry {
        let Ok(mut parts) = parts_of(rel) else { return Entry::Missing };
        let Some(name) = parts.pop() else { return Entry::Dir };
        let Ok(dir) = dir_of(root, &parts) else { return Entry::Missing };
        statat(&dir, name, AtFlags::SYMLINK_NOFOLLOW).map_or(Entry::Missing, |st| entry_of(&st))
    }

    pub(super) fn list(root: &Path, rel: &str) -> Result<(Vec<(String, Entry)>, bool), Fail> {
        let parts = parts_of(rel)?;
        let dir = dir_of(root, &parts)?;
        let handle = dir.try_clone().map_err(|_| Fail::Io)?;
        let mut picker = Picker::new();
        for item in Dir::new(handle).map_err(fail_of)? {
            let Ok(item) = item else { continue };
            let name = item.file_name().to_string_lossy().into_owned();
            if name == "." || name == ".." {
                continue;
            }
            if !picker.push(name) {
                break;
            }
        }
        let (names, truncated) = picker.names();
        // only the names that were kept are looked at one by one
        let out = names
            .into_iter()
            .map(|name| {
                let kind = statat(&dir, name.as_str(), AtFlags::SYMLINK_NOFOLLOW).map_or(Entry::Missing, |st| entry_of(&st));
                (name, kind)
            })
            .collect();
        Ok((out, truncated))
    }
}

#[cfg(not(unix))]
mod imp {
    use super::*;
    use std::fs;
    use std::io::Read;

    fn entry_of(meta: &fs::Metadata) -> Entry {
        let ft = meta.file_type();
        if ft.is_symlink() {
            Entry::Link
        } else if ft.is_dir() {
            Entry::Dir
        } else if ft.is_file() {
            Entry::File(meta.len())
        } else {
            Entry::Other
        }
    }

    /// Every folder on the way must be a real folder, not a link.
    fn clean_path(root: &Path, parts: &[&str]) -> Result<std::path::PathBuf, Fail> {
        let mut p = root.to_path_buf();
        for part in parts {
            p.push(part);
            match fs::symlink_metadata(&p) {
                Ok(m) if m.file_type().is_symlink() => return Err(Fail::Outside),
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Fail::Missing),
                Err(_) => return Err(Fail::Io),
            }
        }
        Ok(p)
    }

    pub(super) fn read(root: &Path, rel: &str, cap: u64) -> Result<Vec<u8>, Fail> {
        let parts = parts_of(rel)?;
        let full = clean_path(root, &parts)?;
        let meta = fs::symlink_metadata(&full).map_err(|_| Fail::Missing)?;
        if !meta.file_type().is_file() {
            return Err(Fail::NotRegular);
        }
        if meta.len() > cap {
            return Err(Fail::TooLarge);
        }
        let mut buf = Vec::new();
        let n = fs::File::open(&full).map_err(|_| Fail::Io)?.take(cap + 1).read_to_end(&mut buf).map_err(|_| Fail::Io)?;
        if n as u64 > cap {
            return Err(Fail::TooLarge);
        }
        Ok(buf)
    }

    pub(super) fn stat(root: &Path, rel: &str) -> Entry {
        let Ok(parts) = parts_of(rel) else { return Entry::Missing };
        match clean_path(root, &parts) {
            Ok(p) => fs::symlink_metadata(p).map_or(Entry::Missing, |m| entry_of(&m)),
            Err(_) => Entry::Missing,
        }
    }

    pub(super) fn list(root: &Path, rel: &str) -> Result<(Vec<(String, Entry)>, bool), Fail> {
        let parts = parts_of(rel)?;
        let full = clean_path(root, &parts)?;
        let mut picker = Picker::new();
        for item in fs::read_dir(&full).map_err(|_| Fail::Io)?.flatten() {
            if !picker.push(item.file_name().to_string_lossy().into_owned()) {
                break;
            }
        }
        let (names, truncated) = picker.names();
        let out = names
            .into_iter()
            .map(|name| {
                let kind = fs::symlink_metadata(full.join(&name)).map_or(Entry::Missing, |m| entry_of(&m));
                (name, kind)
            })
            .collect();
        Ok((out, truncated))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_file_and_refuses_links_pipes_and_big_files() {
        let d = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), b"hi \xff there").unwrap();
        std::fs::write(out.path().join("secret.txt"), "s").unwrap();
        assert_eq!(read(d.path(), "a.txt", 100).unwrap(), "hi \u{fffd} there");
        assert_eq!(read(d.path(), "a.txt", 3), Err(Fail::TooLarge));
        assert_eq!(read(d.path(), "nope", 3), Err(Fail::Missing));
        assert_eq!(read(d.path(), "../x", 3), Err(Fail::Outside));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(out.path().join("secret.txt"), d.path().join("l.txt")).unwrap();
            std::os::unix::fs::symlink(out.path(), d.path().join("dir")).unwrap();
            assert_eq!(read(d.path(), "l.txt", 100), Err(Fail::NotRegular));
            assert_eq!(read(d.path(), "dir/secret.txt", 100), Err(Fail::Outside));
            assert_eq!(stat(d.path(), "l.txt"), Entry::Link);
            assert_eq!(stat(d.path(), "dir/secret.txt"), Entry::Missing);
            let names: Vec<String> = list(d.path(), "").unwrap().into_iter().map(|e| e.0).collect();
            assert_eq!(names, vec!["a.txt", "dir", "l.txt"]);
            assert_eq!(list(d.path(), "dir"), Err(Fail::Outside));
        }
    }

    #[test]
    fn a_crowded_folder_keeps_the_well_known_names_and_says_it_was_cut() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..(MAX_ENTRIES + 500) {
            std::fs::write(d.path().join(format!("a{i:06}")), b"").unwrap();
        }
        for f in ["build.gradle", "Info.plist", "Podfile", "zzz.xcodeproj"] {
            std::fs::write(d.path().join(f), b"").unwrap();
        }
        let (v, truncated) = list_full(d.path(), "").unwrap();
        assert!(truncated);
        assert!(v.len() <= MAX_ENTRIES + 2000);
        for f in ["build.gradle", "Info.plist", "Podfile", "zzz.xcodeproj"] {
            assert!(v.iter().any(|e| e.0 == f), "{f} was hidden");
        }
    }
}
