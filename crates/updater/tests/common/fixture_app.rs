//! Fixture `.app` trees ((design notes: updater-spec) 10.1): a real directory tree that can be ad-hoc signed
//! with `/usr/bin/codesign`, synthetic Mach-O headers, and a scripted `Runner`.
use std::cell::RefCell;
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use intely_updater::bundle::{RunOutput, Runner};

pub const TEST_BUNDLE_ID: &str = "test.example.updater";
pub const TEST_EXE: &str = "TestApp";

pub const CPU_X64: u32 = 0x0100_0007;
pub const CPU_ARM64: u32 = 0x0100_000c;

pub struct AppSpec {
    pub bundle_id: String,
    /// Full version as `build.json` and the feed spell it.
    pub version: String,
    /// `CFBundleShortVersionString`
    pub short_version: String,
    pub arch: String,
    pub signing_mode: String,
    pub min_os: Option<String>,
    pub exe: Vec<u8>,
    pub sdk_pin: Option<String>,
}

impl Default for AppSpec {
    fn default() -> Self {
        AppSpec {
            bundle_id: TEST_BUNDLE_ID.into(),
            version: "0.1.1".into(),
            short_version: "0.1.1".into(),
            arch: "x64".into(),
            signing_mode: "adhoc".into(),
            min_os: Some("13.5".into()),
            exe: thin_macho(CPU_X64),
            sdk_pin: Some("pin-a".into()),
        }
    }
}

pub fn thin_macho(cputype: u32) -> Vec<u8> {
    let mut v = vec![0xCF, 0xFA, 0xED, 0xFE];
    v.extend_from_slice(&cputype.to_le_bytes());
    v.resize(256, 0);
    v
}

pub fn fat_macho(cputypes: &[u32]) -> Vec<u8> {
    let mut v = vec![0xCA, 0xFE, 0xBA, 0xBE];
    v.extend_from_slice(&(cputypes.len() as u32).to_be_bytes());
    for (i, c) in cputypes.iter().enumerate() {
        v.extend_from_slice(&c.to_be_bytes());
        v.extend_from_slice(&0u32.to_be_bytes());
        v.extend_from_slice(&((4096 + i * 256) as u32).to_be_bytes());
        v.extend_from_slice(&256u32.to_be_bytes());
        v.extend_from_slice(&12u32.to_be_bytes());
    }
    v.resize(4096, 0);
    v
}

/// Writes `<parent>/<dir_name>` with Info.plist, the executable, build.json, a resource and a
/// framework-style symlink. Not signed.
pub fn make_app(parent: &Path, dir_name: &str, spec: &AppSpec) -> PathBuf {
    let app = parent.join(dir_name);
    fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    fs::create_dir_all(app.join("Contents/Resources")).unwrap();
    let mut d = plist::Dictionary::new();
    d.insert("CFBundleIdentifier".into(), spec.bundle_id.clone().into());
    d.insert("CFBundleShortVersionString".into(), spec.short_version.clone().into());
    d.insert("CFBundleVersion".into(), spec.short_version.clone().into());
    d.insert("CFBundleExecutable".into(), TEST_EXE.into());
    d.insert("CFBundleName".into(), "TestApp".into());
    d.insert("CFBundlePackageType".into(), "APPL".into());
    if let Some(m) = &spec.min_os {
        d.insert("LSMinimumSystemVersion".into(), m.clone().into());
    }
    plist::Value::Dictionary(d).to_file_xml(app.join("Contents/Info.plist")).unwrap();
    let exe = app.join("Contents/MacOS").join(TEST_EXE);
    fs::write(&exe, &spec.exe).unwrap();
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
    let build = format!(r#"{{"version":"{}","arch":"{}","signing":{{"mode":"{}"}},"nodeVersion":"x","builtAt":"y"}}"#, spec.version, spec.arch, spec.signing_mode);
    fs::write(app.join("Contents/Resources/build.json"), build).unwrap();
    fs::write(app.join("Contents/Resources/data.txt"), b"resource bytes\n").unwrap();
    if let Some(pin) = &spec.sdk_pin {
        fs::create_dir_all(app.join("Contents/Resources/sdk-pin")).unwrap();
        fs::write(app.join(intely_updater::bundle::SDK_PIN_REL), format!("{pin}\n")).unwrap();
    }
    app
}

pub fn have_codesign() -> bool {
    Path::new("/usr/bin/codesign").exists()
}

/// Ad-hoc signs a bundle exactly like the release pipeline's ad-hoc mode.
pub fn sign_adhoc(app: &Path) {
    let out = Command::new("/usr/bin/codesign").args(["--force", "--sign", "-", "--timestamp=none"]).arg(app).output().unwrap();
    assert!(out.status.success(), "codesign failed: {}", String::from_utf8_lossy(&out.stderr));
}

/// A real, ad-hoc signed Mach-O: a copy of `/usr/bin/true` (universal on this machine).
pub fn system_true() -> Vec<u8> {
    fs::read("/usr/bin/true").unwrap()
}

/// A scripted `codesign`/`stapler`. Records every call (argv without the program).
pub struct FakeRunner {
    pub calls: RefCell<Vec<Vec<String>>>,
    pub verify_ok: bool,
    pub details_stderr: String,
    pub entitlements_xml: String,
    pub stapler_ok: bool,
}

impl FakeRunner {
    pub fn adhoc() -> FakeRunner {
        FakeRunner {
            calls: RefCell::new(Vec::new()),
            verify_ok: true,
            details_stderr: adhoc_details(),
            entitlements_xml: String::new(),
            stapler_ok: true,
        }
    }

    pub fn developer_id(team: &str, runtime: bool) -> FakeRunner {
        let mut r = FakeRunner::adhoc();
        r.details_stderr = developer_id_details(team, runtime);
        r
    }

    pub fn argv_of(&self, first: &str) -> Vec<Vec<String>> {
        self.calls.borrow().iter().filter(|c| c.first().map(|s| s == first).unwrap_or(false)).cloned().collect()
    }
}

impl Runner for FakeRunner {
    fn run(&self, program: &Path, args: &[&str]) -> io::Result<RunOutput> {
        let mut call = vec![program.to_string_lossy().to_string()];
        call.extend(args.iter().map(|s| s.to_string()));
        self.calls.borrow_mut().push(call);
        let code = |ok: bool| Some(if ok { 0 } else { 1 });
        Ok(match args.first().copied() {
            Some("--verify") => RunOutput { code: code(self.verify_ok), ..Default::default() },
            Some("-dv") => RunOutput { code: Some(0), stderr: self.details_stderr.clone().into_bytes(), ..Default::default() },
            Some("-d") => RunOutput { code: Some(0), stdout: self.entitlements_xml.clone().into_bytes(), ..Default::default() },
            Some("validate") => RunOutput { code: code(self.stapler_ok), ..Default::default() },
            other => panic!("unexpected program call {other:?}"),
        })
    }
}

pub fn adhoc_details() -> String {
    "Executable=/x/TestApp\nIdentifier=test.example.updater\nFormat=app bundle with Mach-O thin (x86_64)\nCodeDirectory v=20400 size=300 flags=0x2(adhoc) hashes=3+3 location=embedded\nSignature=adhoc\nTeamIdentifier=not set\n".into()
}

pub fn developer_id_details(team: &str, runtime: bool) -> String {
    let flags = if runtime { "0x10000(runtime)" } else { "0x0(none)" };
    format!(
        "Executable=/x/TestApp\nIdentifier=test.example.updater\nCodeDirectory v=20500 size=300 flags={flags} hashes=3+3 location=embedded\nAuthority=Developer ID Application: Someone ({team})\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier={team}\n"
    )
}

pub fn entitlements_xml(keys: &[(&str, bool)]) -> String {
    let mut s = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n");
    for (k, v) in keys {
        s.push_str(&format!("<key>{k}</key>\n<{}/>\n", if *v { "true" } else { "false" }));
    }
    s.push_str("</dict>\n</plist>\n");
    s
}
