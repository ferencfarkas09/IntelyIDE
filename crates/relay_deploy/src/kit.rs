//! The relay kit (spec 4.1, 4.12.1): a directory that contains `remote-relay/` and `remote-web/`. In this dev-only phase the kit is the
//! repo checkout, which agents and dependency scripts can write, so it is treated as untrusted input to the deploy: the wrangler used
//! is the one installed under the kit's own `node_modules` at exactly the pinned version, the source is copied to a snapshot that is
//! hashed, and `check()` spawns nothing.

use std::fs;
use std::io::Read;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use intely_core::jail::{Jail, Mode};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{DeployError, Result};

/// Source files the Worker snapshot may contain.
const SRC_EXT: [&str; 5] = ["ts", "js", "mjs", "json", "wasm"];
const MAX_SRC_FILES: usize = 300;
const MAX_SRC_FILE_BYTES: u64 = 1 << 20;
const MAX_ENTRY_BYTES: u64 = 32 << 20;

#[derive(Debug, Clone)]
pub struct RelayKit {
    pub root: PathBuf,
    pub relay_dir: PathBuf,
    pub web_dir: PathBuf,
    /// `<relay_dir>/node_modules/.bin/wrangler` (built by joining, never a PATH lookup).
    pub wrangler: PathBuf,
    /// `devDependencies.wrangler` of `remote-relay/package.json`.
    pub pinned: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KitReport {
    pub found: bool,
    pub wrangler_ok: bool,
    pub wrangler_version: Option<String>,
    pub wrangler_pinned: String,
    pub node_ok: bool,
    pub pnpm_ok: bool,
    pub dist_built: bool,
    pub dist_built_at: Option<u64>,
    pub relay_version: Option<String>,
}

impl KitReport {
    pub fn missing() -> Self {
        Self {
            found: false,
            wrangler_ok: false,
            wrangler_version: None,
            wrangler_pinned: String::new(),
            node_ok: false,
            pnpm_ok: false,
            dist_built: false,
            dist_built_at: None,
            relay_version: None,
        }
    }
}

/// A copy of the Worker source, hashed. `main` is relative to the config file that sits next to `dir`'s parent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub dir: PathBuf,
    /// `kit/src/index.ts`, relative to the worker directory.
    pub main: String,
    /// sha256 over the sorted `(path, sha256)` list of the snapshot (source files and `package.json`).
    pub hash: String,
    pub package_hash: String,
    pub files: Vec<(String, String, u64)>,
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn miss(msg: &str) -> DeployError {
    DeployError::coded("kitMissing", msg.to_owned())
}

pub(crate) fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

pub fn sha256_file(path: &Path, max: u64) -> Result<String> {
    let mut f = fs::File::open(path)?;
    if f.metadata()?.len() > max {
        return Err(DeployError::coded("kitMissing", "file too large to hash"));
    }
    let mut h = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

/// Searches `path_var` (a `PATH` value) for an executable file called `name`.
pub fn which_in(path_var: &str, name: &str) -> Option<PathBuf> {
    path_var.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join(name)).find(|p| fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

/// `v24.13.0` -> `[24, 13, 0]` (an nvm version directory); anything else is not a version.
fn node_version(name: &str) -> Option<Vec<u64>> {
    let v: Vec<u64> = name.strip_prefix('v')?.split('.').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    (v.len() == 3).then_some(v)
}

/// Where `node`, `pnpm` and the `#!/usr/bin/env node` of wrangler are looked up. A Finder-launched app inherits launchd's bare PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), so an nvm, Volta, pnpm-home or Homebrew install is invisible to it although the user's terminal
/// finds it. Order: the login shell's PATH (which the engine resolves and caches), the process PATH, then the usual install
/// directories: every installed nvm version (newest first) and the pnpm/Volta/npm-global homes under `home` when they exist, then
/// Homebrew. Duplicates and empty entries are dropped; nothing is spawned and nothing is searched below the nvm version list.
pub fn tool_path(process_path: &str, login_path: Option<&str>, home: Option<&Path>) -> String {
    let mut dirs: Vec<String> = Vec::new();
    let mut add = |d: &str| {
        if !d.is_empty() && !dirs.iter().any(|x| x == d) {
            dirs.push(d.to_owned());
        }
    };
    for d in login_path.unwrap_or_default().split(':').chain(process_path.split(':')) {
        add(d);
    }
    if let Some(h) = home {
        let mut nvm: Vec<(Vec<u64>, PathBuf)> = fs::read_dir(h.join(".nvm/versions/node"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| Some((node_version(&e.file_name().to_string_lossy())?, e.path().join("bin"))))
            .filter(|(_, bin)| bin.is_dir())
            .collect();
        nvm.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, bin) in nvm {
            add(&bin.to_string_lossy());
        }
        for rel in ["Library/pnpm", ".local/share/pnpm", ".volta/bin", ".npm-global/bin"] {
            let d = h.join(rel);
            if d.is_dir() {
                add(&d.to_string_lossy());
            }
        }
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin"] {
        add(d);
    }
    dirs.join(":")
}

impl RelayKit {
    /// Order (spec 4.1): `INTELY_RELAY_KIT` (explicit; in the E2E jail only inside the fixture root), the Settings `remote.cloud.kitDir`
    /// (the caller passes it only after a UI confirmation; in E2E only inside the fixture root), then the repo root found by walking
    /// up from the executable (dev builds). An explicit candidate that is not a kit is an error, never a silent fall-through.
    ///
    /// Under `cfg(test)` of this crate it always fails: unit tests build kits with [`RelayKit::at`] in a temp dir. (`cfg(test)` does not
    /// cross crate boundaries; the real guard is the `LiveGesture`, 4.12.3.)
    pub fn locate(jail: &Jail, env_kit: Option<&str>, settings_kit: Option<&Path>, exe: Option<&Path>) -> Result<Self> {
        #[cfg(test)]
        {
            let _ = (jail, env_kit, settings_kit, exe);
            Err(miss("RelayKit::locate is disabled in unit tests"))
        }
        #[cfg(not(test))]
        Self::locate_in(jail, env_kit, settings_kit, exe)
    }

    pub(crate) fn locate_in(jail: &Jail, env_kit: Option<&str>, settings_kit: Option<&Path>, exe: Option<&Path>) -> Result<Self> {
        let confine = |p: &Path| -> Result<()> {
            if jail.mode() == Mode::E2e && !jail.in_fixture(p) {
                return Err(DeployError::coded("testJail", "test jail (INTELY_E2E): the relay kit must be inside the fixture root"));
            }
            Ok(())
        };
        if let Some(p) = env_kit.filter(|p| !p.is_empty()) {
            confine(Path::new(p))?;
            return Self::at(Path::new(p));
        }
        if let Some(p) = settings_kit {
            confine(p)?;
            return Self::at(p);
        }
        if jail.mode() == Mode::E2e {
            return Err(miss("no relay kit configured for the test jail"));
        }
        let start = exe.and_then(Path::parent).ok_or_else(|| miss("cannot find the executable directory"))?;
        for dir in start.ancestors() {
            if dir.join("remote-relay/package.json").is_file() && dir.join("remote-web/package.json").is_file() {
                return Self::at(dir);
            }
        }
        Err(miss("this build is not running from a source checkout, so it cannot deploy a relay"))
    }

    /// A kit at `root` (canonicalised). Reads the pinned wrangler version; spawns nothing.
    pub fn at(root: &Path) -> Result<Self> {
        let root = fs::canonicalize(root).map_err(|_| miss("the relay kit directory does not exist"))?;
        let relay_dir = root.join("remote-relay");
        let web_dir = root.join("remote-web");
        if !relay_dir.join("package.json").is_file() || !web_dir.is_dir() {
            return Err(miss("the directory has no remote-relay and remote-web packages"));
        }
        let pinned = read_json(&relay_dir.join("package.json"))
            .and_then(|v| v["devDependencies"]["wrangler"].as_str().map(str::to_owned))
            .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit() || b == b'.'))
            .ok_or_else(|| miss("remote-relay/package.json does not pin an exact wrangler version"))?;
        let wrangler = relay_dir.join("node_modules").join(".bin").join("wrangler");
        Ok(Self { root, relay_dir, web_dir, wrangler, pinned })
    }

    pub fn installed_wrangler_version(&self) -> Option<String> {
        read_json(&self.relay_dir.join("node_modules/wrangler/package.json"))?["version"].as_str().map(str::to_owned)
    }

    pub fn relay_version(&self) -> Option<String> {
        read_json(&self.relay_dir.join("package.json"))?["version"].as_str().map(str::to_owned)
    }

    pub fn dist_index(&self) -> PathBuf {
        self.web_dir.join("dist/index.html")
    }

    pub fn dist_dir(&self) -> PathBuf {
        self.web_dir.join("dist")
    }

    /// The report behind step 1 and `relay_cloud_status`. Reads `package.json` files and the PATH only; spawns nothing.
    pub fn check(&self, path_var: &str) -> KitReport {
        let wrangler_version = self.installed_wrangler_version();
        let wrangler_ok = self.wrangler_bin().is_ok();
        let built = fs::metadata(self.dist_index()).ok().filter(|m| m.is_file());
        KitReport {
            found: true,
            wrangler_ok,
            wrangler_version,
            wrangler_pinned: self.pinned.clone(),
            node_ok: which_in(path_var, "node").is_some(),
            pnpm_ok: which_in(path_var, "pnpm").is_some(),
            dist_built: built.is_some(),
            dist_built_at: built.and_then(|m| u64::try_from(m.mtime()).ok()),
            relay_version: self.relay_version(),
        }
    }

    /// The wrangler to run: it must exist, its resolved path must lie inside `<relay_dir>/node_modules`, and the installed version
    /// (`node_modules/wrangler/package.json`) must equal the pinned one. No global wrangler, no PATH lookup, no `dlx`.
    pub fn wrangler_bin(&self) -> Result<PathBuf> {
        let nm = fs::canonicalize(self.relay_dir.join("node_modules")).map_err(|_| DeployError::coded("wranglerMissing", "run Prepare: wrangler is not installed in the relay kit"))?;
        let resolved = fs::canonicalize(&self.wrangler).map_err(|_| DeployError::coded("wranglerMissing", "run Prepare: wrangler is not installed in the relay kit"))?;
        if !resolved.starts_with(&nm) {
            return Err(DeployError::coded("wranglerMissing", "wrangler resolves outside the kit's node_modules"));
        }
        match self.installed_wrangler_version() {
            Some(v) if v == self.pinned => Ok(self.wrangler.clone()),
            Some(v) => Err(DeployError::coded("wranglerVersion", format!("wrangler {v} is installed, {} is pinned", self.pinned))),
            None => Err(DeployError::coded("wranglerMissing", "run Prepare: wrangler is not installed in the relay kit")),
        }
    }

    /// sha256 of the resolved wrangler entry file (bound to the preview, 4.12.1).
    pub fn wrangler_entry_hash(&self) -> Result<String> {
        let resolved = fs::canonicalize(&self.wrangler).map_err(|_| DeployError::coded("wranglerMissing", "wrangler is not installed"))?;
        sha256_file(&resolved, MAX_ENTRY_BYTES)
    }

    /// Number of changed files in `remote-relay` and `remote-web` from a read-only `git status`; `None` when git or a repo is absent.
    pub fn dirty_files(&self, path_var: &str) -> Option<usize> {
        let out = Command::new("git")
            .args(["--no-optional-locks", "-C"])
            .arg(&self.root)
            .args(["status", "--porcelain", "--", "remote-relay", "remote-web"])
            .env_clear()
            .env("PATH", path_var)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.trim().is_empty()).count())
    }

    /// Copies `remote-relay/src` (regular files only, lstat walk, allow-listed extensions, caps) and `remote-relay/package.json` into
    /// `dest/src` and `dest/package.json`, replacing a previous snapshot, and hashes the result (spec 4.12.4).
    pub fn snapshot_src(&self, dest: &Path) -> Result<Snapshot> {
        let src_root = self.relay_dir.join("src");
        let mut found: Vec<(String, PathBuf)> = Vec::new();
        walk_src(&src_root, &src_root, &mut found)?;
        if found.is_empty() {
            return Err(miss("remote-relay/src has no source files"));
        }
        found.sort();
        let _ = fs::remove_dir_all(dest);
        private_dir(dest)?;
        let mut files: Vec<(String, String, u64)> = Vec::new();
        let mut put = |rel: &str, bytes: &[u8]| -> Result<()> {
            let target = dest.join(rel);
            if let Some(parent) = target.parent() {
                private_dir(parent)?;
            }
            fs::write(&target, bytes)?;
            files.push((rel.to_owned(), sha256_hex(bytes), bytes.len() as u64));
            Ok(())
        };
        for (rel, abs) in &found {
            put(&format!("src/{rel}"), &read_regular(abs)?)?;
        }
        let pkg = read_regular(&self.relay_dir.join("package.json"))?;
        put("package.json", &pkg)?;
        files.sort();
        let package_hash = sha256_hex(&pkg);
        Ok(Snapshot { dir: dest.to_path_buf(), main: "kit/src/index.ts".to_owned(), hash: hash_files(&files), package_hash, files })
    }

    /// Re-hashes a snapshot directory made by [`snapshot_src`](Self::snapshot_src) (right before a deploy): `(hash, package_hash)`.
    /// Refuses anything that is not a regular file, so a swapped-in symlink fails the deploy.
    pub fn rehash_snapshot(dir: &Path) -> Result<(String, String)> {
        let mut found: Vec<(String, PathBuf)> = Vec::new();
        walk_src(dir, dir, &mut found)?;
        found.sort();
        let mut files: Vec<(String, String, u64)> = Vec::new();
        let mut pkg_hash = String::new();
        for (rel, abs) in &found {
            let bytes = read_regular(abs)?;
            if rel == "package.json" {
                pkg_hash = sha256_hex(&bytes);
            }
            files.push((rel.clone(), sha256_hex(&bytes), bytes.len() as u64));
        }
        Ok((hash_files(&files), pkg_hash))
    }

    /// The text of the kit's `remote-relay/wrangler.jsonc` (read through the same regular-file rule).
    pub fn wrangler_config_text(&self) -> Result<String> {
        let bytes = read_regular(&self.relay_dir.join("wrangler.jsonc"))?;
        String::from_utf8(bytes).map_err(|_| miss("wrangler.jsonc is not UTF-8"))
    }
}

/// sha256 over the sorted `(path, sha256)` list: the same for a fresh snapshot and for a re-hash of its directory.
fn hash_files(files: &[(String, String, u64)]) -> String {
    let mut h = Sha256::new();
    for (p, s, _) in files {
        h.update(p.as_bytes());
        h.update([0]);
        h.update(s.as_bytes());
        h.update(b"\n");
    }
    hex::encode(h.finalize())
}

fn read_regular(path: &Path) -> Result<Vec<u8>> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() {
        return Err(DeployError::coded("kitMissing", "the kit contains something that is not a regular file"));
    }
    if meta.len() > MAX_SRC_FILE_BYTES {
        return Err(DeployError::coded("kitMissing", "a kit source file is too large"));
    }
    Ok(fs::read(path)?)
}

fn walk_src(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = fs::symlink_metadata(&path)?;
        if name.starts_with('.') {
            return Err(DeployError::coded("kitMissing", "a hidden file in the relay source is not deployed"));
        }
        if meta.is_dir() {
            walk_src(root, &path, out)?;
        } else if meta.is_file() {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !SRC_EXT.contains(&ext) {
                return Err(DeployError::coded("kitMissing", "the relay source holds a file type that is not deployed"));
            }
            let rel = path.strip_prefix(root).map_err(|_| miss("path escape"))?.to_string_lossy().replace('\\', "/");
            out.push((rel, path));
            if out.len() > MAX_SRC_FILES {
                return Err(DeployError::coded("kitMissing", "the relay source has too many files"));
            }
        } else {
            return Err(DeployError::coded("kitMissing", "the relay source holds a symlink or special file"));
        }
    }
    Ok(())
}

/// Creates `path` (and parents) with mode 0700.
pub fn private_dir(path: &Path) -> Result<()> {
    fs::DirBuilder::new().recursive(true).mode(0o700).create(path)?;
    Ok(())
}

/// Removes `//` and `/* */` comments and trailing commas outside of string literals. The kit's `wrangler.jsonc` holds `/*` inside
/// string values (`"/r/*"`), so a naive stripper would corrupt it.
pub fn strip_jsonc(text: &str) -> String {
    let b: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_str = false;
    while i < b.len() {
        let c = b[i];
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < b.len() {
                out.push(b[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                out.push(c);
                i += 1;
            }
            '/' if b.get(i + 1) == Some(&'/') => {
                while i < b.len() && b[i] != '\n' {
                    i += 1;
                }
            }
            '/' if b.get(i + 1) == Some(&'*') => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == '*' && b[i + 1] == '/') {
                    i += 1;
                }
                i = (i + 2).min(b.len());
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    drop_trailing_commas(&out)
}

fn drop_trailing_commas(s: &str) -> String {
    let b: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut in_str = false;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < b.len() {
                out.push(b[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
        } else if c == ',' {
            let next = b[i + 1..].iter().find(|x| !x.is_whitespace());
            if matches!(next, Some('}') | Some(']')) {
                i += 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

pub fn parse_jsonc(text: &str) -> Result<Value> {
    serde_json::from_str(&strip_jsonc(text)).map_err(|_| miss("wrangler.jsonc could not be parsed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kit_dir(root: &Path, pinned: &str, installed: Option<&str>) {
        fs::create_dir_all(root.join("remote-relay/src")).unwrap();
        fs::create_dir_all(root.join("remote-relay/node_modules/wrangler/bin")).unwrap();
        fs::create_dir_all(root.join("remote-relay/node_modules/.bin")).unwrap();
        fs::create_dir_all(root.join("remote-web")).unwrap();
        fs::write(root.join("remote-relay/package.json"), format!(r#"{{"version":"1.2.3","devDependencies":{{"wrangler":"{pinned}"}}}}"#)).unwrap();
        fs::write(root.join("remote-web/package.json"), "{}").unwrap();
        fs::write(root.join("remote-relay/src/index.ts"), "export default {};\n").unwrap();
        if let Some(v) = installed {
            fs::write(root.join("remote-relay/node_modules/wrangler/package.json"), format!(r#"{{"version":"{v}"}}"#)).unwrap();
            fs::write(root.join("remote-relay/node_modules/wrangler/bin/wrangler.js"), "// stand-in\n").unwrap();
            std::os::unix::fs::symlink("../wrangler/bin/wrangler.js", root.join("remote-relay").join("node_modules/.bin/wrangler")).unwrap();
        }
    }

    #[test]
    fn locate_order_and_confinement() {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b, c) = (tmp.path().join("a"), tmp.path().join("b"), tmp.path().join("c"));
        for d in [&a, &b, &c] {
            kit_dir(d, "4.147.0", Some("4.147.0"));
        }
        let exe = c.join("target/debug/app");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        let off = Jail::off();
        let root_of = |k: RelayKit| k.root;
        let canon = |p: &Path| fs::canonicalize(p).unwrap();
        // 1. env wins over settings and the exe walk
        let k = RelayKit::locate_in(&off, Some(a.to_str().unwrap()), Some(&b), Some(&exe)).unwrap();
        assert_eq!(root_of(k), canon(&a));
        // 2. settings next
        assert_eq!(root_of(RelayKit::locate_in(&off, None, Some(&b), Some(&exe)).unwrap()), canon(&b));
        assert_eq!(root_of(RelayKit::locate_in(&off, Some(""), Some(&b), Some(&exe)).unwrap()), canon(&b), "an empty variable is unset");
        // 3. the repo root above the executable
        assert_eq!(root_of(RelayKit::locate_in(&off, None, None, Some(&exe)).unwrap()), canon(&c));
        // an explicit candidate that is not a kit is an error, never a silent fall-through
        let nokit = tmp.path().join("nokit");
        fs::create_dir_all(&nokit).unwrap();
        assert_eq!(RelayKit::locate_in(&off, Some(nokit.to_str().unwrap()), Some(&b), Some(&exe)).unwrap_err().code(), "kitMissing");
        assert_eq!(RelayKit::locate_in(&off, Some("/definitely/not/there"), None, Some(&exe)).unwrap_err().code(), "kitMissing");
        // a packaged build without a checkout
        let lone = tmp.path().join("Applications/IntelyIDE.app/Contents/MacOS/app");
        fs::create_dir_all(lone.parent().unwrap()).unwrap();
        assert_eq!(RelayKit::locate_in(&off, None, None, Some(&lone)).unwrap_err().code(), "kitMissing");
        assert_eq!(RelayKit::locate_in(&off, None, None, None).unwrap_err().code(), "kitMissing");
        // the test jail: only inside the fixture root, and never the exe walk
        let e2e = Jail::e2e(tmp.path());
        assert!(RelayKit::locate_in(&e2e, Some(a.to_str().unwrap()), None, None).is_ok());
        assert!(RelayKit::locate_in(&e2e, None, Some(&b), None).is_ok());
        assert_eq!(RelayKit::locate_in(&e2e, None, None, Some(&exe)).unwrap_err().code(), "kitMissing");
        let other = Jail::e2e(tmp.path().join("a"));
        assert_eq!(RelayKit::locate_in(&other, Some(b.to_str().unwrap()), None, None).unwrap_err().code(), "testJail");
        assert_eq!(RelayKit::locate_in(&other, None, Some(&b), None).unwrap_err().code(), "testJail");
        // the public entry point is disabled in this crate's own unit tests
        assert_eq!(RelayKit::locate(&off, Some(a.to_str().unwrap()), None, None).unwrap_err().code(), "kitMissing");
    }

    #[test]
    fn the_pin_must_be_exact_and_match_the_installed_wrangler() {
        let tmp = tempfile::tempdir().unwrap();
        for (i, bad) in ["^4.147.0", "~4.147.0", "latest", "", "4.147.0 || 5"].iter().enumerate() {
            let d = tmp.path().join(format!("k{i}"));
            kit_dir(&d, bad, Some("4.147.0"));
            assert_eq!(RelayKit::at(&d).unwrap_err().code(), "kitMissing", "{bad:?}");
        }
        let ok = tmp.path().join("ok");
        kit_dir(&ok, "4.147.0", Some("4.147.0"));
        let k = RelayKit::at(&ok).unwrap();
        assert_eq!(k.pinned, "4.147.0");
        assert!(k.wrangler_bin().is_ok());
        assert!(k.wrangler_entry_hash().is_ok());
        let old = tmp.path().join("old");
        kit_dir(&old, "4.147.0", Some("4.100.0"));
        assert_eq!(RelayKit::at(&old).unwrap().wrangler_bin().unwrap_err().code(), "wranglerVersion");
        let none = tmp.path().join("none");
        kit_dir(&none, "4.147.0", None);
        assert_eq!(RelayKit::at(&none).unwrap().wrangler_bin().unwrap_err().code(), "wranglerMissing");
        // a .bin/wrangler that resolves outside node_modules is refused
        let out = tmp.path().join("out");
        kit_dir(&out, "4.147.0", Some("4.147.0"));
        let evil = tmp.path().join("evil-wrangler");
        fs::write(&evil, "#!/bin/sh\n").unwrap();
        fs::remove_file(out.join("remote-relay").join("node_modules/.bin/wrangler")).unwrap();
        std::os::unix::fs::symlink(&evil, out.join("remote-relay").join("node_modules/.bin/wrangler")).unwrap();
        assert_eq!(RelayKit::at(&out).unwrap().wrangler_bin().unwrap_err().code(), "wranglerMissing");
    }

    #[test]
    fn check_reads_files_and_the_path_only() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path().join("k");
        kit_dir(&d, "4.147.0", Some("4.147.0"));
        let k = RelayKit::at(&d).unwrap();
        let bin = tmp.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        for n in ["node", "pnpm"] {
            fs::write(bin.join(n), "#!/bin/sh\n").unwrap();
            fs::set_permissions(bin.join(n), fs::Permissions::from_mode(0o755)).unwrap();
        }
        let r = k.check(&bin.to_string_lossy());
        assert!(r.found && r.wrangler_ok && r.node_ok && r.pnpm_ok && !r.dist_built);
        assert_eq!(r.wrangler_version.as_deref(), Some("4.147.0"));
        assert_eq!(r.relay_version.as_deref(), Some("1.2.3"));
        let r = k.check("/nonexistent");
        assert!(!r.node_ok && !r.pnpm_ok);
        fs::create_dir_all(d.join("remote-web/dist")).unwrap();
        fs::write(d.join("remote-web/dist/index.html"), "x").unwrap();
        let r = k.check("");
        assert!(r.dist_built && r.dist_built_at.is_some_and(|t| t > 1_600_000_000));
    }

    #[test]
    fn snapshot_copies_regular_source_files_and_rehash_matches() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path().join("k");
        kit_dir(&d, "4.147.0", Some("4.147.0"));
        fs::write(d.join("remote-relay/src/other.ts"), "export const x = 1;\n").unwrap();
        let k = RelayKit::at(&d).unwrap();
        let snap = k.snapshot_src(&tmp.path().join("w/kit")).unwrap();
        assert_eq!(snap.main, "kit/src/index.ts");
        let names: Vec<&str> = snap.files.iter().map(|f| f.0.as_str()).collect();
        assert_eq!(names, vec!["package.json", "src/index.ts", "src/other.ts"]);
        let (h, p) = RelayKit::rehash_snapshot(&tmp.path().join("w/kit")).unwrap();
        assert_eq!((h, p), (snap.hash.clone(), snap.package_hash.clone()));
        assert!(tmp.path().join("w/kit/src/index.ts").is_file());
        // a second snapshot replaces the first
        fs::write(d.join("remote-relay/src/other.ts"), "export const x = 2;\n").unwrap();
        assert_ne!(k.snapshot_src(&tmp.path().join("w/kit")).unwrap().hash, snap.hash);
        // refusals: symlink, hidden file, odd extension, special names
        for (name, make) in [
            ("link", Box::new(|p: &Path| std::os::unix::fs::symlink("/etc/hosts", p.join("remote-relay/src/link.ts")).unwrap()) as Box<dyn Fn(&Path)>),
            ("hidden", Box::new(|p: &Path| fs::write(p.join("remote-relay/src/.env"), "SECRET=1").unwrap())),
            ("ext", Box::new(|p: &Path| fs::write(p.join("remote-relay/src/key.pem"), "x").unwrap())),
        ] {
            let bad = tmp.path().join(format!("bad-{name}"));
            kit_dir(&bad, "4.147.0", Some("4.147.0"));
            make(&bad);
            assert_eq!(RelayKit::at(&bad).unwrap().snapshot_src(&tmp.path().join(format!("w-{name}/kit"))).unwrap_err().code(), "kitMissing", "{name}");
        }
    }

    fn executable(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "#!/bin/sh\n").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn a_finder_launched_app_finds_nvm_and_pnpm_installs_the_bare_path_cannot_see() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        executable(&h.join(".nvm/versions/node/v18.20.8/bin/node"));
        executable(&h.join(".nvm/versions/node/v24.13.0/bin/node"));
        executable(&h.join(".nvm/versions/node/v24.13.0/bin/pnpm"));
        let bare = "/usr/bin:/bin:/usr/sbin:/sbin";
        assert!(which_in(bare, "pnpm").is_none(), "the bare launchd PATH does not see pnpm");
        let path = tool_path(bare, None, Some(h));
        let dirs: Vec<&str> = path.split(':').collect();
        let v24 = h.join(".nvm/versions/node/v24.13.0/bin").to_string_lossy().into_owned();
        let v18 = h.join(".nvm/versions/node/v18.20.8/bin").to_string_lossy().into_owned();
        assert_eq!(which_in(&path, "pnpm"), Some(h.join(".nvm/versions/node/v24.13.0/bin/pnpm")));
        assert!(dirs.iter().position(|d| *d == v24).unwrap() < dirs.iter().position(|d| *d == v18).unwrap(), "the newest nvm version comes first: {path}");
        assert!(which_in(&path, "node").unwrap().starts_with(&v24), "node resolves to the newest version");
        assert!(dirs.contains(&"/usr/bin") && dirs.contains(&"/opt/homebrew/bin") && dirs.contains(&"/usr/local/bin"));
    }

    #[test]
    fn the_login_path_comes_first_and_duplicates_are_dropped() {
        let path = tool_path("/usr/bin:/bin:/usr/bin", Some("/Users/x/.nvm/v/bin:/usr/bin::/opt/homebrew/bin"), None);
        assert_eq!(path, "/Users/x/.nvm/v/bin:/usr/bin:/opt/homebrew/bin:/bin:/usr/local/bin");
        // no home and no login PATH: the process PATH plus the Homebrew directories
        assert_eq!(tool_path("/usr/bin", None, None), "/usr/bin:/opt/homebrew/bin:/usr/local/bin");
    }

    #[test]
    fn pnpm_homes_are_added_only_when_they_exist() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        executable(&h.join("Library/pnpm/pnpm"));
        let path = tool_path("/usr/bin", None, Some(h));
        assert!(path.split(':').any(|d| Path::new(d) == h.join("Library/pnpm")));
        assert!(!path.contains(".volta") && !path.contains(".npm-global") && !path.contains(".local/share/pnpm"), "{path}");
        assert_eq!(node_version("v24.13.0"), Some(vec![24, 13, 0]));
        assert_eq!(node_version("system"), None);
        assert_eq!(node_version("v24.13"), None);
    }

    #[test]
    fn the_jsonc_stripper_handles_edge_cases() {
        assert_eq!(parse_jsonc("{} // end").unwrap(), serde_json::json!({}));
        assert_eq!(parse_jsonc("/* a */ {\"k\": [1,],}").unwrap(), serde_json::json!({"k":[1]}));
        assert_eq!(parse_jsonc("{\"url\": \"http://x/y\"}").unwrap()["url"], "http://x/y");
        assert!(parse_jsonc("{ unterminated").is_err());
    }
}
