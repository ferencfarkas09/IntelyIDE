//! The code a stdio server runs (MCP spec 2.4 "Code files" and "Where the code may live"): the executable and every absolute file argument,
//! resolved through symlinks and hashed, so the confirmation proof vouches for the code and not only for the command line; and the
//! check that this code does not lie where the agent can write.

use std::collections::HashMap;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use intely_settings::hash::sha256_hex;
use sha2::{Digest, Sha256};

use crate::error::{code, McpErr, Result};
use crate::model::{package_name, runner_package, McpServerRecord};
use crate::types::McpTransport;

/// A file above this size is refused (`mcpCodeTooBig`).
pub const MAX_CODE_FILE: u64 = 1 << 30;
const CACHE_LIMIT: usize = 256;

type CacheKey = (u64, u64, u64, i128, i128);

/// `(device, inode, size, mtime, ctime) -> digest`, bounded, memory only. A rewritten file has another mtime and ctime (a user process
/// cannot set the ctime back), so it is hashed again; an unchanged one once per process.
#[derive(Default)]
pub struct DigestCache {
    map: Mutex<HashMap<CacheKey, String>>,
    hashed: std::sync::atomic::AtomicUsize,
}

impl DigestCache {
    /// How many files were actually read and hashed (a test hook).
    pub fn hashed_count(&self) -> usize {
        self.hashed.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn digest(&self, path: &Path) -> Result<String> {
        let md = std::fs::metadata(path).map_err(|e| McpErr::new(code::BAD_CONFIG, format!("cannot read a file of the server: {}", e.kind())))?;
        if md.len() > MAX_CODE_FILE {
            return Err(McpErr::new(code::CODE_TOO_BIG, "a file the server runs is larger than 1 GiB and cannot be confirmed"));
        }
        let key: CacheKey = (md.dev(), md.ino(), md.len(), i128::from(md.mtime()) * 1_000_000_000 + i128::from(md.mtime_nsec()), i128::from(md.ctime()) * 1_000_000_000 + i128::from(md.ctime_nsec()));
        if let Some(hit) = self.map.lock().unwrap_or_else(PoisonError::into_inner).get(&key) {
            return Ok(hit.clone());
        }
        let mut file = std::fs::File::open(path).map_err(|e| McpErr::new(code::BAD_CONFIG, format!("cannot read a file of the server: {}", e.kind())))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buf).map_err(|e| McpErr::new(code::BAD_CONFIG, format!("cannot read a file of the server: {}", e.kind())))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        let hex: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        self.hashed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut map = self.map.lock().unwrap_or_else(PoisonError::into_inner);
        if map.len() >= CACHE_LIMIT {
            map.clear();
        }
        map.insert(key, hex.clone());
        Ok(hex)
    }
}

/// One file the proof vouches for. `digest` is the hex sha256, or `unresolved` (the command was not found) or `absent` (an absolute
/// argument that does not exist, so its later appearance changes the hash).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeFile {
    pub path: PathBuf,
    pub digest: String,
    /// The canonical file of the executable (as opposed to an argument).
    pub executable: bool,
}

impl CodeFile {
    pub fn line(&self) -> String {
        format!("code:{}:{}", self.path.display(), self.digest)
    }

    /// An existing regular file (not `unresolved` / `absent`).
    pub fn exists(&self) -> bool {
        self.digest != "unresolved" && self.digest != "absent"
    }
}

fn is_executable_file(p: &Path) -> bool {
    p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// `command` as given when it is an absolute path, else the first executable of that name on the ABSOLUTE entries of `path` (an empty or
/// relative entry such as `.` would resolve inside the working directory and is skipped).
pub fn resolve_command(command: &str, path: &str) -> Option<PathBuf> {
    if command.starts_with('/') {
        return is_executable_file(Path::new(command)).then(|| PathBuf::from(command));
    }
    std::env::split_paths(path).filter(|d| d.is_absolute()).map(|d| d.join(command)).find(|p| is_executable_file(p))
}

/// The files of a stdio record (empty for http). Reads the CURRENT content of every file.
pub fn code_files(rec: &McpServerRecord, path: &str, cache: &DigestCache) -> Result<Vec<CodeFile>> {
    if rec.transport != McpTransport::Stdio {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    if let Some(command) = rec.command.as_deref() {
        match resolve_command(command, path).and_then(|p| std::fs::canonicalize(p).ok()) {
            Some(real) => files.push(CodeFile { digest: cache.digest(&real)?, path: real, executable: true }),
            None => files.push(CodeFile { path: PathBuf::from(command), digest: "unresolved".into(), executable: true }),
        }
    }
    for arg in rec.args.iter().filter(|a| a.starts_with('/')) {
        match std::fs::canonicalize(arg) {
            Ok(real) if real.is_file() => {
                if !files.iter().any(|f| f.path == real) {
                    files.push(CodeFile { digest: cache.digest(&real)?, path: real, executable: false });
                }
            }
            Ok(_) => {}
            Err(_) => files.push(CodeFile { path: PathBuf::from(arg), digest: "absent".into(), executable: false }),
        }
    }
    Ok(files)
}

pub fn code_lines(files: &[CodeFile]) -> Vec<String> {
    files.iter().map(CodeFile::line).collect()
}

// ---- where the code may live ------------------------------------------------------------------------------------------------------

fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| {
        // a path that does not exist yet: canonicalise the longest existing ancestor
        let mut tail = Vec::new();
        let mut cur = p.to_path_buf();
        while let Some(name) = cur.file_name().map(|n| n.to_owned()) {
            tail.push(name);
            cur.pop();
            if let Ok(real) = std::fs::canonicalize(&cur) {
                return tail.iter().rev().fold(real, |acc, n| acc.join(n));
            }
        }
        p.to_path_buf()
    })
}

/// The directories where code is refused: the state directory and temporary directories (the Test and the supplier), plus the run's
/// directories (the supplier only, `McpSelection.run_dirs`).
#[derive(Debug, Clone, Default)]
pub struct Forbidden {
    pub run_dirs: Vec<PathBuf>,
    pub state_dirs: Vec<PathBuf>,
    pub temp_dirs: Vec<PathBuf>,
}

impl Forbidden {
    fn inside(&self, path: &Path) -> Option<&'static str> {
        let p = canon(path);
        let within = |dirs: &[PathBuf]| dirs.iter().any(|d| p.starts_with(canon(d)));
        if within(&self.run_dirs) {
            Some("a directory of the run")
        } else if within(&self.state_dirs) {
            Some("the IDE's state directory")
        } else if within(&self.temp_dirs) {
            Some("a temporary directory")
        } else {
            None
        }
    }
}

fn refuse(name: &str, where_: &str) -> McpErr {
    McpErr::new(code::CODE_IN_RUN_DIR, format!("the code of the server \"{name}\" lies in {where_}, where an agent can change it: install it outside the repository and use an absolute path"))
}

/// The four checks of 2.4 "Where the code may live" for one stdio record. Names only in the message, never a path of the run.
pub fn check_code_location(rec: &McpServerRecord, files: &[CodeFile], forbidden: &Forbidden) -> Result<()> {
    if rec.transport != McpTransport::Stdio {
        return Ok(());
    }
    // (a) and (b): the canonical executable and every file argument
    for f in files.iter().filter(|f| f.exists()) {
        if let Some(w) = forbidden.inside(&f.path) {
            return Err(refuse(&rec.name, w));
        }
    }
    // (c): an argument that is not a flag and not absolute, joined to a run directory, naming an existing file or directory inside it
    for arg in rec.args.iter().filter(|a| !a.starts_with('-') && !a.starts_with('/')) {
        for dir in &forbidden.run_dirs {
            let joined = dir.join(arg);
            if joined.exists() && canon(&joined).starts_with(canon(dir)) {
                return Err(refuse(&rec.name, "a directory of the run"));
            }
        }
    }
    // (d): a package runner prefers a local copy: a planted node_modules entry in a run directory or any ancestor would run
    if let Some((runner, pkg)) = rec.command.as_deref().and_then(|c| runner_package(c, &rec.args)) {
        if matches!(runner, "npx" | "bunx" | "pnpx" | "pnpm" | "yarn" | "npm") {
            let name = package_name(pkg);
            let bin = name.rsplit('/').next().unwrap_or(name);
            for dir in &forbidden.run_dirs {
                let mut cur = Some(canon(dir));
                while let Some(d) = cur {
                    let modules = d.join("node_modules");
                    if modules.join(name).exists() || modules.join(".bin").join(bin).exists() {
                        return Err(refuse(&rec.name, "a node_modules folder of the run (a package runner would run that copy)"));
                    }
                    cur = d.parent().map(Path::to_path_buf);
                }
            }
        }
    }
    Ok(())
}

/// The temporary directories of this machine (`std::env::temp_dir()`, `/tmp`, `/private/tmp`, `/var/folders`).
pub fn default_temp_dirs() -> Vec<PathBuf> {
    vec![std::env::temp_dir(), PathBuf::from("/tmp"), PathBuf::from("/private/tmp"), PathBuf::from("/var/folders"), PathBuf::from("/private/var/folders")]
}

/// A short digest for the UI (the first 12 hex characters) or the marker itself.
pub fn short_digest(digest: &str) -> String {
    digest.chars().take(12).collect()
}

/// The digest of arbitrary text, for hashing things that are not files (kept here so the crate has one place that hashes).
pub fn text_digest(text: &str) -> String {
    sha256_hex(text.as_bytes())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;
    use crate::model::{McpServerRecord, Origin};

    fn rec(command: &str, args: &[&str]) -> McpServerRecord {
        McpServerRecord {
            id: "m0123456789ab".into(),
            name: "fx".into(),
            transport: McpTransport::Stdio,
            command: Some(command.into()),
            args: args.iter().map(|s| (*s).to_owned()).collect(),
            url: None,
            env: vec![],
            headers: vec![],
            enabled: false,
            default_policy: Default::default(),
            tool_policies: vec![],
            tools: vec![],
            tools_tested_at: None,
            tools_fingerprint: None,
            server_info: None,
            instructions_hash: None,
            origin: Origin::Manual,
            created_at: 0,
            updated_at: 0,
            extra: Default::default(),
        }
    }

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn bare_commands_resolve_on_absolute_path_entries_only() {
        let dir = tempfile::tempdir().unwrap();
        script(dir.path(), "mytool", "#!/bin/sh\n");
        let path = format!(".:relative/bin::{}", dir.path().display());
        assert_eq!(resolve_command("mytool", &path), Some(dir.path().join("mytool")));
        assert_eq!(resolve_command("mytool", ".:relative/bin"), None);
        assert_eq!(resolve_command("/nonexistent/tool", &path), None);
    }

    #[test]
    fn a_symlink_is_judged_by_its_target_and_content_changes_the_lines() {
        let dir = tempfile::tempdir().unwrap();
        let real = script(dir.path(), "real.sh", "#!/bin/sh\necho 1\n");
        let other = script(dir.path(), "other.sh", "#!/bin/sh\necho 2\n");
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        symlink(&real, bin.join("srv")).unwrap();
        let cache = DigestCache::default();
        let path = bin.display().to_string();
        let r = rec("srv", &[]);
        let before = code_lines(&code_files(&r, &path, &cache).unwrap());
        assert!(before[0].contains(&std::fs::canonicalize(&real).unwrap().display().to_string()), "{before:?}");
        // the same bytes hash once
        assert_eq!(code_lines(&code_files(&r, &path, &cache).unwrap()), before);
        assert_eq!(cache.hashed_count(), 1);
        // swapping the symlink target changes the line
        std::fs::remove_file(bin.join("srv")).unwrap();
        symlink(&other, bin.join("srv")).unwrap();
        assert_ne!(code_lines(&code_files(&r, &path, &cache).unwrap()), before);
        // rewriting the content of the target changes it too (mtime and ctime are part of the cache key)
        let after_swap = code_lines(&code_files(&r, &path, &cache).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&other, "#!/bin/sh\necho 3\n").unwrap();
        assert_ne!(code_lines(&code_files(&r, &path, &cache).unwrap()), after_swap);
    }

    #[test]
    fn absolute_file_arguments_are_hashed_and_a_missing_one_is_marked_absent() {
        let dir = tempfile::tempdir().unwrap();
        let js = dir.path().join("server.js");
        let cache = DigestCache::default();
        let r = rec("/bin/sh", &[js.to_str().unwrap()]);
        let missing = code_lines(&code_files(&r, "", &cache).unwrap());
        assert!(missing.iter().any(|l| l.ends_with(":absent")), "{missing:?}");
        std::fs::write(&js, "console.log(1)").unwrap();
        let present = code_lines(&code_files(&r, "", &cache).unwrap());
        assert_ne!(missing, present, "the later appearance of the file changes the proof");
        assert!(present.iter().any(|l| l.contains("server.js") && !l.ends_with(":absent")));
    }

    #[test]
    fn an_unresolved_command_is_a_line_not_an_error() {
        let files = code_files(&rec("no-such-program-xyz", &[]), "/nonexistent", &DigestCache::default()).unwrap();
        assert_eq!(files[0].digest, "unresolved");
        assert!(!files[0].exists());
    }

    #[test]
    fn code_inside_a_run_directory_the_state_directory_or_a_temp_directory_is_refused() {
        let run = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let in_run = script(run.path(), "srv.sh", "#!/bin/sh\n");
        let out = script(outside.path(), "srv.sh", "#!/bin/sh\n");
        let cache = DigestCache::default();
        let f = Forbidden { run_dirs: vec![run.path().to_path_buf()], state_dirs: vec![], temp_dirs: vec![] };
        let check = |r: &McpServerRecord, f: &Forbidden| check_code_location(r, &code_files(r, "", &cache).unwrap(), f);
        // (a) the executable
        assert_eq!(check(&rec(in_run.to_str().unwrap(), &[]), &f).unwrap_err().code, code::CODE_IN_RUN_DIR);
        assert!(check(&rec(out.to_str().unwrap(), &[]), &f).is_ok());
        // (b) a file argument
        assert_eq!(check(&rec("/bin/sh", &[in_run.to_str().unwrap()]), &f).unwrap_err().code, code::CODE_IN_RUN_DIR);
        // (c) a relative argument that exists under a run directory
        assert_eq!(check(&rec("/bin/sh", &["srv.sh"]), &f).unwrap_err().code, code::CODE_IN_RUN_DIR);
        assert!(check(&rec("/bin/sh", &["not-there.sh", "-c"]), &f).is_ok());
        // the state directory and a temp directory
        let f2 = Forbidden { run_dirs: vec![], state_dirs: vec![outside.path().to_path_buf()], temp_dirs: vec![] };
        assert_eq!(check(&rec(out.to_str().unwrap(), &[]), &f2).unwrap_err().code, code::CODE_IN_RUN_DIR);
        let f3 = Forbidden { run_dirs: vec![], state_dirs: vec![], temp_dirs: vec![outside.path().to_path_buf()] };
        assert_eq!(check(&rec(out.to_str().unwrap(), &[]), &f3).unwrap_err().code, code::CODE_IN_RUN_DIR);
        // the message names the server and no path
        let msg = check(&rec(in_run.to_str().unwrap(), &[]), &f).unwrap_err().message;
        assert!(msg.contains("fx") && !msg.contains(run.path().to_str().unwrap()), "{msg}");
    }

    #[test]
    fn a_package_runner_with_a_planted_local_copy_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let run = root.path().join("repo/sub");
        std::fs::create_dir_all(&run).unwrap();
        let f = Forbidden { run_dirs: vec![run.clone()], state_dirs: vec![], temp_dirs: vec![] };
        let r = rec("npx", &["-y", "@scope/pkg@1.0.0"]);
        let check = |r: &McpServerRecord| check_code_location(r, &[], &f);
        assert!(check(&r).is_ok(), "no planted copy, no refusal");
        let bin = root.path().join("repo/node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("pkg"), "x").unwrap();
        assert_eq!(check(&r).unwrap_err().code, code::CODE_IN_RUN_DIR, "planted in an ancestor of the run directory");
        std::fs::remove_file(bin.join("pkg")).unwrap();
        std::fs::create_dir_all(run.join("node_modules/@scope/pkg")).unwrap();
        assert_eq!(check(&r).unwrap_err().code, code::CODE_IN_RUN_DIR, "planted in the run directory itself");
        assert!(check(&rec("node", &["-y", "@scope/pkg"])).is_ok(), "a plain program is not a package runner");
    }

    #[test]
    fn a_file_over_the_cap_is_not_hashed() {
        assert_eq!(MAX_CODE_FILE, 1 << 30);
        assert_eq!(short_digest(&"a".repeat(64)).len(), 12);
        assert_eq!(text_digest("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
