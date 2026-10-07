//! Install-location classes (spec 4.10) and validation of a staged bundle (spec 4.11 P6).
//!
//! The crate never reads the environment: the caller passes the executable path, the home
//! directory (inside `SystemProbe`) and every expected value in. All external programs run through
//! `Runner` with a fixed argv and a scrubbed environment, so the tests can script `codesign`.
//! The crate contains no literal bundle identifier: it arrives as `ValidateParams::bundle_id`.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use semver::Version;
use serde::Deserialize;

use crate::stage::{euid, random_hex};
use crate::version::Arch;
use crate::{ErrorCode, UpdateError};

pub const CODESIGN: &str = "/usr/bin/codesign";
/// `Resources/sdk-pin/tree.sha256`: the pin of the Agent SDK tree this bundle expects (spec A10).
pub const SDK_PIN_REL: &str = "Contents/Resources/sdk-pin/tree.sha256";

const PLIST_MAX_BYTES: u64 = 1024 * 1024;
const BUILD_JSON_MAX_BYTES: u64 = 64 * 1024;
const SDK_PIN_MAX_BYTES: u64 = 4096;
const RUN_OUTPUT_CAP: u64 = 1024 * 1024;

// ------------------------------------------------------------------------------------------
// Install-location classes
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LocationClass {
    Installed,
    DiskImage,
    Translocated,
    NotWritable,
    SharedInstall,
    ReadOnlyVolume,
    External,
    NotABundle,
    FakeApp,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BundleLocation {
    pub class: LocationClass,
    /// The canonical `.../<Name>.app` (None for `NotABundle`).
    pub app_path: Option<PathBuf>,
    /// The folder holding the app: where the stage directory is created.
    pub parent: Option<PathBuf>,
    /// `CFBundleIdentifier` of the running bundle.
    pub bundle_id: Option<String>,
}

impl BundleLocation {
    /// The error code of the class when it forbids installing; None when the class allows it.
    pub fn install_refusal(&self) -> Option<ErrorCode> {
        match self.class {
            LocationClass::Installed | LocationClass::External | LocationClass::FakeApp => None,
            LocationClass::DiskImage => Some(ErrorCode::DiskImage),
            LocationClass::Translocated => Some(ErrorCode::Translocated),
            LocationClass::NotWritable => Some(ErrorCode::NotWritable),
            LocationClass::SharedInstall => Some(ErrorCode::SharedInstall),
            LocationClass::ReadOnlyVolume => Some(ErrorCode::ReadOnlyVolume),
            LocationClass::NotABundle => Some(ErrorCode::NotABundle),
        }
    }

    /// The running bundle's identifier must equal the configured one (spec 4.10).
    pub fn check_identity(&self, expected: &str) -> Result<(), UpdateError> {
        match &self.bundle_id {
            Some(id) if id == expected => Ok(()),
            _ => Err(UpdateError::new(ErrorCode::BundleIdMismatch)),
        }
    }
}

/// The file-system facts `classify` needs; injectable so every class can be scripted.
pub trait FsProbe {
    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf>;
    /// Create and remove `.intely-write-probe-<rand>` in `dir`.
    fn write_probe(&self, dir: &Path) -> io::Result<()>;
    /// `st_uid` of the path itself (`lstat`).
    fn owner_uid(&self, path: &Path) -> io::Result<u32>;
    fn euid(&self) -> u32;
    /// `statfs` flag `MNT_RDONLY` of the volume holding `path`.
    fn is_readonly_volume(&self, path: &Path) -> bool;
    fn device(&self, path: &Path) -> io::Result<u64>;
    /// Device of the user's home directory (None when unknown).
    fn home_device(&self) -> Option<u64>;
    /// `CFBundleIdentifier` of `<app>/Contents/Info.plist`.
    fn bundle_id(&self, app: &Path) -> Option<String>;
}

/// The real probe. `home` is passed in by the caller (this crate does not read the environment).
pub struct SystemProbe {
    pub home: Option<PathBuf>,
}

impl FsProbe for SystemProbe {
    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        fs::canonicalize(path)
    }

    fn write_probe(&self, dir: &Path) -> io::Result<()> {
        let rand = random_hex(6).map_err(|_| io::Error::new(io::ErrorKind::Other, "no random source"))?;
        let probe = dir.join(format!(".intely-write-probe-{rand}"));
        fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&probe)?;
        fs::remove_file(&probe)
    }

    fn owner_uid(&self, path: &Path) -> io::Result<u32> {
        Ok(fs::symlink_metadata(path)?.uid())
    }

    fn euid(&self) -> u32 {
        euid()
    }

    fn is_readonly_volume(&self, path: &Path) -> bool {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let Ok(c) = CString::new(path.as_os_str().as_bytes()) else { return false };
        let mut st: libc::statfs = unsafe { std::mem::zeroed() };
        // SAFETY: `c` is a valid C string and `st` a properly sized, writable statfs buffer.
        let rc = unsafe { libc::statfs(c.as_ptr(), &mut st) };
        rc == 0 && (st.f_flags & libc::MNT_RDONLY as u32) != 0
    }

    fn device(&self, path: &Path) -> io::Result<u64> {
        Ok(fs::metadata(path)?.dev())
    }

    fn home_device(&self) -> Option<u64> {
        self.home.as_ref().and_then(|h| fs::metadata(h).ok()).map(|m| m.dev())
    }

    fn bundle_id(&self, app: &Path) -> Option<String> {
        let dict = read_plist_dict(&app.join("Contents/Info.plist")).ok()?;
        dict.get("CFBundleIdentifier")?.as_string().map(str::to_string)
    }
}

fn not_a_bundle() -> BundleLocation {
    BundleLocation { class: LocationClass::NotABundle, app_path: None, parent: None, bundle_id: None }
}

/// Classifies the running executable (spec 4.10). `exe` is the path of the running binary as the
/// caller knows it; it is canonicalised here and must look like `.../<Name>.app/Contents/MacOS/<exe>`.
pub fn classify(exe: &Path, probe: &dyn FsProbe) -> BundleLocation {
    let Ok(canon) = probe.canonicalize(exe) else { return not_a_bundle() };
    let Some(macos) = canon.parent() else { return not_a_bundle() };
    let Some(contents) = macos.parent() else { return not_a_bundle() };
    let Some(app) = contents.parent() else { return not_a_bundle() };
    let named = |p: &Path, n: &str| p.file_name().map(|f| f == n).unwrap_or(false);
    let app_ok = app.file_name().and_then(|f| f.to_str()).map(|f| f.len() > 4 && f.ends_with(".app")).unwrap_or(false);
    if !named(macos, "MacOS") || !named(contents, "Contents") || !app_ok {
        return not_a_bundle();
    }
    let Some(bundle_id) = probe.bundle_id(app) else { return not_a_bundle() };
    classify_app(app, bundle_id, probe, false)
}

/// Classification of an app path the caller already knows (the E2E fake app: `fake` turns the
/// otherwise installable classes into `FakeApp`, spec 4.10 last row).
pub fn classify_app(app: &Path, bundle_id: String, probe: &dyn FsProbe, fake: bool) -> BundleLocation {
    let parent = app.parent().map(Path::to_path_buf);
    let make = |class| BundleLocation { class, app_path: Some(app.to_path_buf()), parent: parent.clone(), bundle_id: Some(bundle_id.clone()) };

    if app.to_string_lossy().contains("/AppTranslocation/") {
        return make(LocationClass::Translocated);
    }
    let under_volumes = app.starts_with("/Volumes/");
    if under_volumes && probe.is_readonly_volume(app) {
        return make(LocationClass::DiskImage);
    }
    let Some(parent_dir) = parent.as_deref() else { return make(LocationClass::NotWritable) };
    if let Err(e) = probe.write_probe(parent_dir) {
        return make(if under_volumes {
            LocationClass::DiskImage
        } else if e.raw_os_error() == Some(libc::EROFS) {
            LocationClass::ReadOnlyVolume
        } else {
            LocationClass::NotWritable
        });
    }
    match probe.owner_uid(app) {
        Ok(uid) if uid == probe.euid() => {}
        _ => return make(LocationClass::SharedInstall),
    }
    if fake {
        return make(LocationClass::FakeApp);
    }
    match (probe.home_device(), probe.device(app).ok()) {
        (Some(h), Some(a)) if h != a => make(LocationClass::External),
        _ => make(LocationClass::Installed),
    }
}

// ------------------------------------------------------------------------------------------
// Runner
// ------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct RunOutput {
    /// None when killed by a signal.
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl RunOutput {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
}

/// Runs an external program with a fixed argv. Implementations must not use a shell.
pub trait Runner {
    fn run(&self, program: &Path, args: &[&str]) -> io::Result<RunOutput>;
}

/// The real runner: `env_clear()`, `PATH=/usr/bin:/bin`, `LANG=C`, no stdin, output capped,
/// killed after `timeout`.
pub struct SystemRunner {
    pub timeout: Duration,
}

impl Default for SystemRunner {
    fn default() -> Self {
        SystemRunner { timeout: Duration::from_secs(180) }
    }
}

fn read_capped<R: Read>(mut r: R) -> Vec<u8> {
    let mut out = Vec::new();
    let _ = (&mut r).take(RUN_OUTPUT_CAP).read_to_end(&mut out);
    // Keep draining so the child never blocks on a full pipe.
    let _ = io::copy(&mut r, &mut io::sink());
    out
}

impl Runner for SystemRunner {
    fn run(&self, program: &Path, args: &[&str]) -> io::Result<RunOutput> {
        let mut child = Command::new(program)
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let out = child.stdout.take().expect("piped");
        let err = child.stderr.take().expect("piped");
        let start = Instant::now();
        std::thread::scope(|s| {
            let ho = s.spawn(move || read_capped(out));
            let he = s.spawn(move || read_capped(err));
            let status = loop {
                match child.try_wait() {
                    Ok(Some(st)) => break Ok(st),
                    Ok(None) => {
                        if start.elapsed() > self.timeout {
                            let _ = child.kill();
                            let _ = child.wait();
                            break Err(io::Error::new(io::ErrorKind::TimedOut, "program timed out"));
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(e) => break Err(e),
                }
            };
            let stdout = ho.join().unwrap_or_default();
            let stderr = he.join().unwrap_or_default();
            status.map(|st| RunOutput { code: st.code(), stdout, stderr })
        })
    }
}

// ------------------------------------------------------------------------------------------
// Signature facts
// ------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SigningInfo {
    Adhoc,
    DeveloperId { team: String },
    Unknown,
}

impl SigningInfo {
    /// The value of `UpdateStatus` / `Config.signing`: `adhoc`, `developerId` or `unknown`.
    pub fn status_str(&self) -> &'static str {
        match self {
            SigningInfo::Adhoc => "adhoc",
            SigningInfo::DeveloperId { .. } => "developerId",
            SigningInfo::Unknown => "unknown",
        }
    }
}

/// `build.json` `signing.mode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuildSigning {
    Adhoc,
    DeveloperId,
}

impl BuildSigning {
    pub fn parse(s: &str) -> Option<BuildSigning> {
        match s {
            "adhoc" => Some(BuildSigning::Adhoc),
            "developer-id" => Some(BuildSigning::DeveloperId),
            _ => None,
        }
    }

    /// The one mapping of the file spelling to the status spelling (`developer-id` -> `developerId`).
    pub fn status_str(self) -> &'static str {
        match self {
            BuildSigning::Adhoc => "adhoc",
            BuildSigning::DeveloperId => "developerId",
        }
    }
}

pub type Entitlements = BTreeMap<String, plist::Value>;

#[derive(Clone, Debug)]
pub struct SignatureInfo {
    pub signing: SigningInfo,
    pub hardened_runtime: bool,
    pub entitlements: Entitlements,
}

/// Parses the stderr of `codesign -dv --verbose=4`.
pub fn parse_codesign_details(text: &str) -> (SigningInfo, bool) {
    let mut adhoc = false;
    let mut hardened = false;
    let mut developer_id = false;
    let mut team: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if line == "Signature=adhoc" {
            adhoc = true;
        }
        if let Some(v) = line.strip_prefix("TeamIdentifier=") {
            if v != "not set" && !v.is_empty() {
                team = Some(v.to_string());
            }
        }
        if let Some(v) = line.strip_prefix("Authority=") {
            if v.starts_with("Developer ID Application:") {
                developer_id = true;
            }
        }
        if line.starts_with("CodeDirectory") {
            if let Some(i) = line.find("flags=") {
                let rest = &line[i..];
                if let (Some(a), Some(b)) = (rest.find('('), rest.find(')')) {
                    if a < b {
                        for f in rest[a + 1..b].split(',') {
                            match f.trim() {
                                "adhoc" => adhoc = true,
                                "runtime" => hardened = true,
                                _ => {}
                            }
                        }
                    }
                }
            }
        }
    }
    let signing = match (adhoc, developer_id, team) {
        (true, _, _) => SigningInfo::Adhoc,
        (false, true, Some(team)) => SigningInfo::DeveloperId { team },
        _ => SigningInfo::Unknown,
    };
    (signing, hardened)
}

/// Parses the XML plist printed by `codesign -d --entitlements :-` (empty output = no entitlements).
pub fn parse_entitlements(stdout: &[u8]) -> Result<Entitlements, UpdateError> {
    let start = stdout.windows(5).position(|w| w == b"<?xml").or_else(|| stdout.windows(6).position(|w| w == b"<plist"));
    let Some(start) = start else { return Ok(Entitlements::new()) };
    let value = plist::Value::from_reader_xml(&stdout[start..]).map_err(|_| UpdateError::with(ErrorCode::BundleInvalid, "entitlements unreadable"))?;
    let dict = value.into_dictionary().ok_or_else(|| UpdateError::with(ErrorCode::BundleInvalid, "entitlements are not a dictionary"))?;
    Ok(dict.into_iter().collect())
}

/// Reads signing identity, hardened runtime and entitlements of a bundle through `codesign`.
pub fn read_signature(app: &Path, runner: &dyn Runner) -> Result<SignatureInfo, UpdateError> {
    let app_s = app.to_str().ok_or_else(|| UpdateError::with(ErrorCode::BundleInvalid, "path is not UTF-8"))?;
    let details = runner
        .run(Path::new(CODESIGN), &["-dv", "--verbose=4", app_s])
        .map_err(|_| UpdateError::with(ErrorCode::CodesignFailed, "codesign could not run"))?;
    if !details.success() {
        return Err(UpdateError::with(ErrorCode::CodesignFailed, "codesign -dv failed"));
    }
    // `codesign -d` writes its report to stderr.
    let (signing, hardened_runtime) = parse_codesign_details(&String::from_utf8_lossy(&details.stderr));
    let ents = runner
        .run(Path::new(CODESIGN), &["-d", "--entitlements", ":-", app_s])
        .map_err(|_| UpdateError::with(ErrorCode::CodesignFailed, "codesign could not run"))?;
    if !ents.success() {
        return Err(UpdateError::with(ErrorCode::CodesignFailed, "codesign -d --entitlements failed"));
    }
    Ok(SignatureInfo { signing, hardened_runtime, entitlements: parse_entitlements(&ents.stdout)? })
}

// ------------------------------------------------------------------------------------------
// Small readers
// ------------------------------------------------------------------------------------------

fn invalid(detail: &str) -> UpdateError {
    UpdateError::with(ErrorCode::BundleInvalid, detail)
}

/// Opens a regular file without following a symlink and reads at most `max` bytes (more is an error).
fn read_small(path: &Path, max: u64) -> Result<Vec<u8>, UpdateError> {
    let meta = fs::symlink_metadata(path).map_err(|_| invalid("file missing"))?;
    if !meta.file_type().is_file() || meta.len() > max {
        return Err(invalid("file is not a small regular file"));
    }
    let mut f = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path).map_err(|_| invalid("file unreadable"))?;
    let mut buf = Vec::new();
    (&mut f).take(max + 1).read_to_end(&mut buf).map_err(|_| invalid("file unreadable"))?;
    if buf.len() as u64 > max {
        return Err(invalid("file too large"));
    }
    Ok(buf)
}

fn read_plist_dict(path: &Path) -> Result<plist::Dictionary, UpdateError> {
    let bytes = read_small(path, PLIST_MAX_BYTES)?;
    let value = plist::Value::from_reader(io::Cursor::new(bytes)).map_err(|_| invalid("Info.plist unreadable"))?;
    value.into_dictionary().ok_or_else(|| invalid("Info.plist is not a dictionary"))
}

fn plist_string<'a>(dict: &'a plist::Dictionary, key: &str) -> Result<&'a str, UpdateError> {
    dict.get(key).and_then(|v| v.as_string()).filter(|s| !s.is_empty()).ok_or_else(|| invalid(&format!("{key} missing")))
}

/// `a.b.c` numeric comparison of dotted versions: `have >= need`.
pub fn os_at_least(have: &str, need: &str) -> Option<bool> {
    fn parse(s: &str) -> Option<Vec<u64>> {
        if s.is_empty() {
            return None;
        }
        s.split('.').map(|p| p.parse::<u64>().ok()).collect()
    }
    let (h, n) = (parse(have)?, parse(need)?);
    for i in 0..h.len().max(n.len()) {
        let (a, b) = (h.get(i).copied().unwrap_or(0), n.get(i).copied().unwrap_or(0));
        if a != b {
            return Some(a > b);
        }
    }
    Some(true)
}

// ------------------------------------------------------------------------------------------
// build.json
// ------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawSigningMode {
    mode: String,
}

#[derive(Deserialize)]
struct RawBuild {
    version: String,
    arch: String,
    signing: RawSigningMode,
}

/// `Contents/Resources/build.json` with the pinned schema `{version, arch, signing: {mode}}`;
/// other fields (tool versions, build time) are ignored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuildJson {
    pub version: Version,
    pub arch: Arch,
    pub signing: BuildSigning,
}

pub fn parse_build_json(bytes: &[u8]) -> Result<BuildJson, UpdateError> {
    let raw: RawBuild = serde_json::from_slice(bytes).map_err(|_| invalid("build.json does not match the schema"))?;
    let version = crate::version::parse_strict(&raw.version).map_err(|_| invalid("build.json version is not strict semver"))?;
    let arch = match raw.arch.as_str() {
        "x64" => Arch::X64,
        "aarch64" => Arch::Aarch64,
        _ => return Err(invalid("build.json arch unknown")),
    };
    let signing = BuildSigning::parse(&raw.signing.mode).ok_or_else(|| invalid("build.json signing mode unknown"))?;
    Ok(BuildJson { version, arch, signing })
}

// ------------------------------------------------------------------------------------------
// Mach-O
// ------------------------------------------------------------------------------------------

const CPU_TYPE_X86_64: u32 = 0x0100_0007;
const CPU_TYPE_ARM64: u32 = 0x0100_000c;

fn cpu_type(arch: Arch) -> u32 {
    match arch {
        Arch::X64 => CPU_TYPE_X86_64,
        Arch::Aarch64 => CPU_TYPE_ARM64,
    }
}

/// Checks the magic and the `cputype` of a Mach-O executable: a thin 64-bit file must be of the
/// requested architecture, a universal file must contain a slice of it.
pub fn check_macho(path: &Path, arch: Arch) -> Result<(), UpdateError> {
    let meta = fs::symlink_metadata(path).map_err(|_| invalid("executable missing"))?;
    if !meta.file_type().is_file() {
        return Err(invalid("executable is not a regular file"));
    }
    let mut head = Vec::new();
    let f = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path).map_err(|_| invalid("executable unreadable"))?;
    f.take(4096).read_to_end(&mut head).map_err(|_| invalid("executable unreadable"))?;
    if head.len() < 8 {
        return Err(invalid("executable is not a Mach-O file"));
    }
    let want = cpu_type(arch);
    let be = |o: usize| u32::from_be_bytes([head[o], head[o + 1], head[o + 2], head[o + 3]]);
    let le = |o: usize| u32::from_le_bytes([head[o], head[o + 1], head[o + 2], head[o + 3]]);
    match [head[0], head[1], head[2], head[3]] {
        [0xCF, 0xFA, 0xED, 0xFE] => {
            if le(4) == want {
                Ok(())
            } else {
                Err(UpdateError::new(ErrorCode::ArchMismatch))
            }
        }
        [0xCE, 0xFA, 0xED, 0xFE] => Err(UpdateError::new(ErrorCode::ArchMismatch)),
        [0xCA, 0xFE, 0xBA, 0xBE] | [0xCA, 0xFE, 0xBA, 0xBF] => {
            let wide = head[3] == 0xBF;
            let stride = if wide { 32 } else { 20 };
            let n = be(4) as usize;
            // A Java class file shares the 0xCAFEBABE magic; real fat files have a handful of slices.
            if n == 0 || n > 16 || 8 + n * stride > head.len() {
                return Err(invalid("executable is not a Mach-O file"));
            }
            if (0..n).any(|i| be(8 + i * stride) == want) {
                Ok(())
            } else {
                Err(UpdateError::new(ErrorCode::ArchMismatch))
            }
        }
        _ => Err(invalid("executable is not a Mach-O file")),
    }
}

// ------------------------------------------------------------------------------------------
// Validation of the staged bundle (P6)
// ------------------------------------------------------------------------------------------

/// What is known about the running app (the engine reads it once with `read_signature`).
#[derive(Clone, Debug)]
pub struct RunningFacts {
    pub signing: SigningInfo,
    pub entitlements: Entitlements,
    /// Content of `Contents/Resources/sdk-pin/tree.sha256` of the running bundle.
    pub sdk_pin: Option<String>,
}

pub struct ValidateParams<'a> {
    /// `Config.bundle_id`: the only accepted `CFBundleIdentifier`.
    pub bundle_id: &'a str,
    /// The full version of the feed entry.
    pub version: &'a Version,
    pub arch: Arch,
    /// Running macOS (`sw_vers -productVersion`).
    pub os_version: &'a str,
    pub running: &'a RunningFacts,
    /// The verified feed said `entitlementsChange: true`.
    pub entitlements_change_allowed: bool,
    /// Path of `stapler` when the tool exists (Developer ID only).
    pub stapler: Option<&'a Path>,
}

#[derive(Clone, Debug)]
pub struct StagedBundle {
    pub signing: SigningInfo,
    pub hardened_runtime: bool,
    pub entitlements: Entitlements,
    /// The staged entitlements are not a subset of the running ones (allowed only by the feed).
    pub entitlements_change: bool,
    pub sdk_pin: Option<String>,
    pub sdk_pin_changed: bool,
    pub build: BuildJson,
    pub stapler_checked: bool,
}

/// Content of the SDK pin file, trimmed; None when absent.
pub fn read_sdk_pin(app: &Path) -> Option<String> {
    let bytes = read_small(&app.join(SDK_PIN_REL), SDK_PIN_MAX_BYTES).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// `CFBundleShortVersionString` is the `X.Y.Z` core of the feed version.
fn version_core(v: &Version) -> String {
    format!("{}.{}.{}", v.major, v.minor, v.patch)
}

/// Validates the unpacked bundle at `app` (spec 4.11 P6). Cheap checks first, `codesign` last.
pub fn validate_staged(app: &Path, p: &ValidateParams<'_>, runner: &dyn Runner) -> Result<StagedBundle, UpdateError> {
    let meta = fs::symlink_metadata(app).map_err(|_| invalid("staged bundle missing"))?;
    if !meta.file_type().is_dir() {
        return Err(invalid("staged bundle is not a directory"));
    }

    // Info.plist
    let info = read_plist_dict(&app.join("Contents/Info.plist"))?;
    if plist_string(&info, "CFBundleIdentifier")? != p.bundle_id {
        return Err(UpdateError::new(ErrorCode::BundleIdMismatch));
    }
    if plist_string(&info, "CFBundleShortVersionString")? != version_core(p.version) {
        return Err(UpdateError::with(ErrorCode::VersionMismatch, "Info.plist version"));
    }
    if let Some(min) = info.get("LSMinimumSystemVersion") {
        let min = min.as_string().ok_or_else(|| invalid("LSMinimumSystemVersion is not a string"))?;
        match os_at_least(p.os_version, min) {
            Some(true) => {}
            Some(false) => return Err(UpdateError::new(ErrorCode::OsTooOld)),
            None => return Err(invalid("LSMinimumSystemVersion unreadable")),
        }
    }

    // build.json
    let build = parse_build_json(&read_small(&app.join("Contents/Resources/build.json"), BUILD_JSON_MAX_BYTES)?)?;
    if build.version != *p.version {
        return Err(UpdateError::with(ErrorCode::VersionMismatch, "build.json version"));
    }
    if build.arch != p.arch {
        return Err(UpdateError::with(ErrorCode::ArchMismatch, "build.json arch"));
    }

    // Executable
    let exe = plist_string(&info, "CFBundleExecutable")?;
    if exe.contains('/') || exe == "." || exe == ".." || exe.contains('\0') {
        return Err(invalid("CFBundleExecutable is not a file name"));
    }
    check_macho(&app.join("Contents/MacOS").join(exe), p.arch)?;

    // Signature
    let app_s = app.to_str().ok_or_else(|| invalid("path is not UTF-8"))?;
    let verify = runner
        .run(Path::new(CODESIGN), &["--verify", "--deep", "--strict", "--verbose=2", app_s])
        .map_err(|_| UpdateError::with(ErrorCode::CodesignFailed, "codesign could not run"))?;
    if !verify.success() {
        return Err(UpdateError::with(ErrorCode::CodesignFailed, "codesign --verify failed"));
    }
    let sig = read_signature(app, runner)?;

    // Identity continuity (T14)
    match (&p.running.signing, &sig.signing) {
        (SigningInfo::DeveloperId { team: a }, SigningInfo::DeveloperId { team: b }) if a == b => {}
        (SigningInfo::DeveloperId { .. }, _) => return Err(UpdateError::new(ErrorCode::IdentityChanged)),
        (SigningInfo::Adhoc, SigningInfo::Adhoc) | (SigningInfo::Adhoc, SigningInfo::DeveloperId { .. }) => {}
        (_, _) => return Err(UpdateError::new(ErrorCode::IdentityChanged)),
    }
    // build.json must tell the same story as the signature.
    if sig.signing.status_str() != build.signing.status_str() {
        return Err(invalid("build.json signing mode differs from the signature"));
    }

    let mut stapler_checked = false;
    if matches!(sig.signing, SigningInfo::DeveloperId { .. }) {
        if !sig.hardened_runtime {
            return Err(invalid("hardened runtime missing"));
        }
        if let Some(stapler) = p.stapler {
            let out = runner
                .run(stapler, &["validate", app_s])
                .map_err(|_| UpdateError::with(ErrorCode::CodesignFailed, "stapler could not run"))?;
            if !out.success() {
                return Err(UpdateError::with(ErrorCode::CodesignFailed, "stapler validate failed"));
            }
            stapler_checked = true;
        }
    }

    // Entitlements
    if sig.entitlements.contains_key("com.apple.security.get-task-allow") {
        return Err(invalid("get-task-allow in the staged entitlements"));
    }
    let entitlements_change = sig.entitlements.iter().any(|(k, v)| p.running.entitlements.get(k) != Some(v));
    if entitlements_change && !p.entitlements_change_allowed {
        return Err(invalid("staged entitlements are not a subset of the running ones"));
    }

    // SDK pin
    let sdk_pin = read_sdk_pin(app);
    let sdk_pin_changed = sdk_pin != p.running.sdk_pin;

    Ok(StagedBundle {
        signing: sig.signing,
        hardened_runtime: sig.hardened_runtime,
        entitlements: sig.entitlements,
        entitlements_change,
        sdk_pin,
        sdk_pin_changed,
        build,
        stapler_checked,
    })
}
