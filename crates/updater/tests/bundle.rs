//! U3: install-location classes and staged-bundle validation ((design notes: updater-spec) 10.2 `bundle`).
mod common;

use std::cell::RefCell;
use std::fs;
use std::io;
use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use common::fixture_app::*;
use common::tarball::tar_dir_gz;
use intely_updater::bundle::*;
use intely_updater::stage::{create_stage_dir, unpack, Limits};
use intely_updater::version::Arch;
use intely_updater::ErrorCode;
use semver::Version;

// ------------------------------------------------------------------------------------------
// classify
// ------------------------------------------------------------------------------------------

struct FakeProbe {
    canon_fails: bool,
    write_err: Option<i32>,
    owner: u32,
    euid: u32,
    readonly: bool,
    device: u64,
    home_device: Option<u64>,
    bundle_id: Option<String>,
    probed: RefCell<Vec<PathBuf>>,
}

impl FakeProbe {
    fn new() -> FakeProbe {
        FakeProbe {
            canon_fails: false,
            write_err: None,
            owner: 501,
            euid: 501,
            readonly: false,
            device: 1,
            home_device: Some(1),
            bundle_id: Some(TEST_BUNDLE_ID.into()),
            probed: RefCell::new(Vec::new()),
        }
    }
}

impl FsProbe for FakeProbe {
    fn canonicalize(&self, p: &Path) -> io::Result<PathBuf> {
        if self.canon_fails {
            Err(io::Error::from_raw_os_error(libc::ENOENT))
        } else {
            Ok(p.to_path_buf())
        }
    }
    fn write_probe(&self, dir: &Path) -> io::Result<()> {
        self.probed.borrow_mut().push(dir.to_path_buf());
        match self.write_err {
            Some(e) => Err(io::Error::from_raw_os_error(e)),
            None => Ok(()),
        }
    }
    fn owner_uid(&self, _: &Path) -> io::Result<u32> {
        Ok(self.owner)
    }
    fn euid(&self) -> u32 {
        self.euid
    }
    fn is_readonly_volume(&self, _: &Path) -> bool {
        self.readonly
    }
    fn device(&self, _: &Path) -> io::Result<u64> {
        Ok(self.device)
    }
    fn home_device(&self) -> Option<u64> {
        self.home_device
    }
    fn bundle_id(&self, _: &Path) -> Option<String> {
        self.bundle_id.clone()
    }
}

fn exe(app: &str) -> PathBuf {
    PathBuf::from(format!("{app}/Contents/MacOS/IntelyIDE"))
}

#[test]
fn classify_installed_and_external() {
    let p = FakeProbe::new();
    let loc = classify(&exe("/Applications/IntelyIDE.app"), &p);
    assert_eq!(loc.class, LocationClass::Installed);
    assert_eq!(loc.app_path.as_deref(), Some(Path::new("/Applications/IntelyIDE.app")));
    assert_eq!(loc.parent.as_deref(), Some(Path::new("/Applications")));
    assert_eq!(loc.bundle_id.as_deref(), Some(TEST_BUNDLE_ID));
    assert_eq!(loc.install_refusal(), None);
    assert_eq!(p.probed.borrow().as_slice(), [PathBuf::from("/Applications")]);

    let mut p = FakeProbe::new();
    p.device = 7;
    let loc = classify(&exe("/Volumes/Work/Apps/IntelyIDE.app"), &p);
    assert_eq!(loc.class, LocationClass::External);
    assert_eq!(loc.install_refusal(), None);
    // Unknown home device: not External.
    let mut p = FakeProbe::new();
    p.home_device = None;
    p.device = 7;
    assert_eq!(classify(&exe("/Applications/IntelyIDE.app"), &p).class, LocationClass::Installed);
}

#[test]
fn classify_disk_image() {
    let mut p = FakeProbe::new();
    p.readonly = true;
    let loc = classify(&exe("/Volumes/IntelyIDE 0.1.0/IntelyIDE.app"), &p);
    assert_eq!(loc.class, LocationClass::DiskImage);
    assert_eq!(loc.install_refusal(), Some(ErrorCode::DiskImage));
    // A failed probe on a /Volumes path counts too (read-only or not allowed).
    let mut p = FakeProbe::new();
    p.write_err = Some(libc::EACCES);
    assert_eq!(classify(&exe("/Volumes/IntelyIDE 0.1.0/IntelyIDE.app"), &p).class, LocationClass::DiskImage);
    let mut p = FakeProbe::new();
    p.write_err = Some(libc::EROFS);
    assert_eq!(classify(&exe("/Volumes/IntelyIDE 0.1.0/IntelyIDE.app"), &p).class, LocationClass::DiskImage);
    // A writable external volume is not a disk image.
    assert_eq!(classify(&exe("/Volumes/Work/IntelyIDE.app"), &FakeProbe::new()).class, LocationClass::Installed);
    // Read-only flag outside /Volumes: not a disk image (the write probe decides).
    let mut p = FakeProbe::new();
    p.readonly = true;
    assert_eq!(classify(&exe("/Applications/IntelyIDE.app"), &p).class, LocationClass::Installed);
}

#[test]
fn classify_translocated() {
    let p = FakeProbe::new();
    let loc = classify(&exe("/private/var/folders/ab/cd/T/AppTranslocation/0F3C-1/d/IntelyIDE.app"), &p);
    assert_eq!(loc.class, LocationClass::Translocated);
    assert_eq!(loc.install_refusal(), Some(ErrorCode::Translocated));
    assert!(p.probed.borrow().is_empty(), "no probe on a translocated copy");
}

#[test]
fn classify_not_writable_read_only_volume_and_shared() {
    let mut p = FakeProbe::new();
    p.write_err = Some(libc::EACCES);
    let loc = classify(&exe("/Applications/IntelyIDE.app"), &p);
    assert_eq!((loc.class, loc.install_refusal()), (LocationClass::NotWritable, Some(ErrorCode::NotWritable)));
    let mut p = FakeProbe::new();
    p.write_err = Some(libc::EPERM);
    assert_eq!(classify(&exe("/Applications/IntelyIDE.app"), &p).class, LocationClass::NotWritable);

    let mut p = FakeProbe::new();
    p.write_err = Some(libc::EROFS);
    let loc = classify(&exe("/Users/x/Applications/IntelyIDE.app"), &p);
    assert_eq!((loc.class, loc.install_refusal()), (LocationClass::ReadOnlyVolume, Some(ErrorCode::ReadOnlyVolume)));

    // The probe succeeds (group-writable /Applications) but the bundle belongs to another account.
    let mut p = FakeProbe::new();
    p.owner = 0;
    let loc = classify(&exe("/Applications/IntelyIDE.app"), &p);
    assert_eq!((loc.class, loc.install_refusal()), (LocationClass::SharedInstall, Some(ErrorCode::SharedInstall)));
}

#[test]
fn classify_not_a_bundle_and_fake_app() {
    for path in [
        "/Users/x/proj/target/debug/intely-switch-ide",
        "/Applications/IntelyIDE.app/Contents/Resources/IntelyIDE",
        "/Applications/IntelyIDE.app/Contents/MacOS",
        "/Applications/Contents/MacOS/IntelyIDE",
        "/Applications/.app/Contents/MacOS/IntelyIDE",
        "/IntelyIDE",
    ] {
        let loc = classify(Path::new(path), &FakeProbe::new());
        assert_eq!(loc.class, LocationClass::NotABundle, "{path}");
        assert_eq!(loc.install_refusal(), Some(ErrorCode::NotABundle));
        assert!(loc.app_path.is_none());
    }
    let mut p = FakeProbe::new();
    p.canon_fails = true;
    assert_eq!(classify(&exe("/Applications/IntelyIDE.app"), &p).class, LocationClass::NotABundle);
    let mut p = FakeProbe::new();
    p.bundle_id = None;
    assert_eq!(classify(&exe("/Applications/IntelyIDE.app"), &p).class, LocationClass::NotABundle);

    let loc = classify_app(Path::new("/tmp/fixture/Fake.app"), TEST_BUNDLE_ID.into(), &FakeProbe::new(), true);
    assert_eq!((loc.class, loc.install_refusal()), (LocationClass::FakeApp, None));
    // A fake app that is not writable is still refused.
    let mut p = FakeProbe::new();
    p.write_err = Some(libc::EACCES);
    assert_eq!(classify_app(Path::new("/tmp/fixture/Fake.app"), TEST_BUNDLE_ID.into(), &p, true).class, LocationClass::NotWritable);
}

#[test]
fn identity_of_the_running_bundle_must_match_the_configuration() {
    let loc = classify(&exe("/Applications/IntelyIDE.app"), &FakeProbe::new());
    loc.check_identity(TEST_BUNDLE_ID).unwrap();
    assert_eq!(loc.check_identity("someone.else").unwrap_err().code, ErrorCode::BundleIdMismatch);
}

#[test]
fn real_probe_classifies_a_real_fixture_app() {
    let tmp = tempfile::tempdir().unwrap();
    let real = tmp.path().canonicalize().unwrap();
    let app = make_app(&real, "Real.app", &AppSpec::default());
    // Reach it through a symlinked directory: the class and the paths are canonical.
    let alias = real.join("alias");
    symlink(&real, &alias).unwrap();
    let probe = SystemProbe { home: Some(real.clone()) };
    let loc = classify(&alias.join("Real.app/Contents/MacOS").join(TEST_EXE), &probe);
    assert_eq!(loc.class, LocationClass::Installed);
    assert_eq!(loc.app_path.as_deref(), Some(app.as_path()));
    assert_eq!(loc.bundle_id.as_deref(), Some(TEST_BUNDLE_ID));
    assert!(fs::read_dir(&real).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".intely-write-probe")), "probe file left behind");
    assert_eq!(real_euid_matches(&app), true);
}

fn real_euid_matches(app: &Path) -> bool {
    SystemProbe { home: None }.euid() == fs::symlink_metadata(app).unwrap().uid()
}

#[test]
fn real_write_probe_leaves_nothing_behind_and_reports_permission_denied() {
    let tmp = tempfile::tempdir().unwrap();
    let probe = SystemProbe { home: None };
    probe.write_probe(tmp.path()).unwrap();
    probe.write_probe(tmp.path()).unwrap();
    assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 0);
    let ro = tmp.path().join("ro");
    fs::create_dir(&ro).unwrap();
    fs::set_permissions(&ro, fs::Permissions::from_mode(0o500)).unwrap();
    let r = probe.write_probe(&ro);
    fs::set_permissions(&ro, fs::Permissions::from_mode(0o700)).unwrap();
    if probe.euid() != 0 {
        assert_eq!(r.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    }
    // A class from the real probe: a read-only parent is `NotWritable`.
    let app = make_app(tmp.path(), "Locked.app", &AppSpec::default());
    fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o500)).unwrap();
    let loc = classify_app(&app, TEST_BUNDLE_ID.into(), &probe, false);
    fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    if probe.euid() != 0 {
        assert_eq!(loc.class, LocationClass::NotWritable);
    }
    assert!(!probe.is_readonly_volume(tmp.path()));
}

// ------------------------------------------------------------------------------------------
// The runner
// ------------------------------------------------------------------------------------------

#[test]
fn system_runner_scrubs_the_environment_and_times_out() {
    let out = SystemRunner::default().run(Path::new("/usr/bin/env"), &[]).unwrap();
    assert!(out.success());
    let text = String::from_utf8(out.stdout).unwrap();
    let mut lines: Vec<&str> = text.lines().collect();
    lines.sort();
    assert_eq!(lines, ["LANG=C", "PATH=/usr/bin:/bin"], "the parent environment leaked into the child");
    let slow = SystemRunner { timeout: Duration::from_millis(200) };
    let err = slow.run(Path::new("/bin/sleep"), &["5"]).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    // A program that does not exist is an error, not a panic.
    assert!(SystemRunner::default().run(Path::new("/nonexistent/program"), &[]).is_err());
}

// ------------------------------------------------------------------------------------------
// Parsers
// ------------------------------------------------------------------------------------------

#[test]
fn codesign_output_parsing() {
    assert_eq!(parse_codesign_details(&adhoc_details()), (SigningInfo::Adhoc, false));
    assert_eq!(parse_codesign_details(&developer_id_details("ABCDE12345", true)), (SigningInfo::DeveloperId { team: "ABCDE12345".into() }, true));
    assert_eq!(parse_codesign_details(&developer_id_details("ABCDE12345", false)), (SigningInfo::DeveloperId { team: "ABCDE12345".into() }, false));
    // An Apple Development or self-signed certificate is not a Developer ID.
    let dev = "CodeDirectory v=20500 flags=0x0(none)\nAuthority=Apple Development: x (ABCDE12345)\nTeamIdentifier=ABCDE12345\n";
    assert_eq!(parse_codesign_details(dev).0, SigningInfo::Unknown);
    assert_eq!(parse_codesign_details("").0, SigningInfo::Unknown);
    // Developer ID authority without a team is not accepted.
    assert_eq!(parse_codesign_details("Authority=Developer ID Application: x\nTeamIdentifier=not set\n").0, SigningInfo::Unknown);
    assert_eq!(SigningInfo::Adhoc.status_str(), "adhoc");
    assert_eq!(SigningInfo::DeveloperId { team: "T".into() }.status_str(), "developerId");
    assert_eq!(BuildSigning::parse("developer-id").unwrap().status_str(), "developerId");
    assert!(BuildSigning::parse("developerId").is_none());

    assert!(parse_entitlements(b"").unwrap().is_empty());
    assert!(parse_entitlements(b"Executable=/x\n").unwrap().is_empty());
    let e = parse_entitlements(entitlements_xml(&[("a.b", true), ("c.d", false)]).as_bytes()).unwrap();
    assert_eq!(e.len(), 2);
    assert_eq!(parse_entitlements(b"<?xml version=\"1.0\"?><plist><array/></plist>").unwrap_err().code, ErrorCode::BundleInvalid);
    assert_eq!(parse_entitlements(b"<?xml junk").unwrap_err().code, ErrorCode::BundleInvalid);
}

#[test]
fn os_version_comparison() {
    assert_eq!(os_at_least("13.5", "13.5"), Some(true));
    assert_eq!(os_at_least("26.0.1", "13.5"), Some(true));
    assert_eq!(os_at_least("13.4.1", "13.5"), Some(false));
    assert_eq!(os_at_least("13", "13.0.0"), Some(true));
    assert_eq!(os_at_least("14", "13.5.1"), Some(true));
    assert_eq!(os_at_least("x", "13.5"), None);
    assert_eq!(os_at_least("13.5", ""), None);
}

#[test]
fn build_json_schema() {
    let ok = br#"{"version":"0.1.0","arch":"x64","signing":{"mode":"adhoc"},"nodeVersion":"22","builtAt":"2026"}"#;
    let b = parse_build_json(ok).unwrap();
    assert_eq!((b.version.to_string(), b.arch, b.signing), ("0.1.0".to_string(), Arch::X64, BuildSigning::Adhoc));
    let b = parse_build_json(br#"{"version":"0.2.0-rc.1","arch":"aarch64","signing":{"mode":"developer-id"}}"#).unwrap();
    assert_eq!((b.arch, b.signing), (Arch::Aarch64, BuildSigning::DeveloperId));
    for bad in [
        &br#"{}"#[..],
        br#"{"version":"0.1.0","arch":"x64"}"#,
        br#"{"version":"0.1.0","arch":"x64","signing":{}}"#,
        br#"{"version":"0.1.0","arch":"x64","signing":"adhoc"}"#,
        br#"{"version":"v0.1.0","arch":"x64","signing":{"mode":"adhoc"}}"#,
        br#"{"version":"0.1.0+b","arch":"x64","signing":{"mode":"adhoc"}}"#,
        br#"{"version":"0.1","arch":"x64","signing":{"mode":"adhoc"}}"#,
        br#"{"version":"0.1.0","arch":"arm64","signing":{"mode":"adhoc"}}"#,
        br#"{"version":"0.1.0","arch":"universal","signing":{"mode":"adhoc"}}"#,
        br#"{"version":"0.1.0","arch":"x64","signing":{"mode":"developerId"}}"#,
        br#"{"version":"0.1.0","arch":"x64","signing":{"mode":"none"}}"#,
        b"not json",
        b"",
    ] {
        assert_eq!(parse_build_json(bad).unwrap_err().code, ErrorCode::BundleInvalid, "{}", String::from_utf8_lossy(bad));
    }
}

// ------------------------------------------------------------------------------------------
// Mach-O
// ------------------------------------------------------------------------------------------

#[test]
fn macho_magic_and_cputype() {
    let tmp = tempfile::tempdir().unwrap();
    let write = |name: &str, bytes: Vec<u8>| {
        let p = tmp.path().join(name);
        fs::write(&p, bytes).unwrap();
        p
    };
    let x = write("x64", thin_macho(CPU_X64));
    let a = write("arm", thin_macho(CPU_ARM64));
    check_macho(&x, Arch::X64).unwrap();
    check_macho(&a, Arch::Aarch64).unwrap();
    assert_eq!(check_macho(&x, Arch::Aarch64).unwrap_err().code, ErrorCode::ArchMismatch);
    assert_eq!(check_macho(&a, Arch::X64).unwrap_err().code, ErrorCode::ArchMismatch);
    // Universal: either arch is found, a third is not.
    let fat = write("fat", fat_macho(&[CPU_X64, CPU_ARM64]));
    check_macho(&fat, Arch::X64).unwrap();
    check_macho(&fat, Arch::Aarch64).unwrap();
    let fat_x = write("fatx", fat_macho(&[CPU_X64]));
    assert_eq!(check_macho(&fat_x, Arch::Aarch64).unwrap_err().code, ErrorCode::ArchMismatch);
    // 32-bit Mach-O, a script, a Java class file (0xCAFEBABE + big count), too short, a directory, a symlink.
    let mut thin32 = vec![0xCE, 0xFA, 0xED, 0xFE];
    thin32.extend_from_slice(&7u32.to_le_bytes());
    assert_eq!(check_macho(&write("t32", thin32), Arch::X64).unwrap_err().code, ErrorCode::ArchMismatch);
    for (n, b) in [("sh", b"#!/bin/sh\nexit 0\n".to_vec()), ("java", vec![0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 52]), ("short", vec![0xCF, 0xFA]), ("empty", vec![])] {
        assert_eq!(check_macho(&write(n, b), Arch::X64).unwrap_err().code, ErrorCode::BundleInvalid, "{n}");
    }
    assert_eq!(check_macho(tmp.path(), Arch::X64).unwrap_err().code, ErrorCode::BundleInvalid);
    let l = tmp.path().join("link");
    symlink(&x, &l).unwrap();
    assert_eq!(check_macho(&l, Arch::X64).unwrap_err().code, ErrorCode::BundleInvalid);
    assert_eq!(check_macho(&tmp.path().join("missing"), Arch::X64).unwrap_err().code, ErrorCode::BundleInvalid);
}

#[test]
fn the_system_binary_is_recognised() {
    let host = if cfg!(target_arch = "aarch64") { Arch::Aarch64 } else { Arch::X64 };
    check_macho(Path::new("/usr/bin/true"), host).unwrap();
}

// ------------------------------------------------------------------------------------------
// validate_staged (scripted codesign)
// ------------------------------------------------------------------------------------------

struct Fixture {
    _tmp: tempfile::TempDir,
    app: PathBuf,
}

fn fixture(spec: &AppSpec) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let app = make_app(tmp.path(), "Staged.app", spec);
    Fixture { _tmp: tmp, app }
}

fn running(signing: SigningInfo) -> RunningFacts {
    RunningFacts { signing, entitlements: Entitlements::new(), sdk_pin: Some("pin-a".into()) }
}

fn params<'a>(version: &'a Version, running: &'a RunningFacts) -> ValidateParams<'a> {
    ValidateParams { bundle_id: TEST_BUNDLE_ID, version, arch: Arch::X64, os_version: "14.2", running, entitlements_change_allowed: false, stapler: None }
}

fn v(s: &str) -> Version {
    Version::parse(s).unwrap()
}

fn code_of(spec: AppSpec, runner: &FakeRunner, mut tweak: impl FnMut(&mut ValidateParams<'_>)) -> ErrorCode {
    let f = fixture(&spec);
    let version = v("0.1.1");
    let run = running(SigningInfo::Adhoc);
    let mut p = params(&version, &run);
    tweak(&mut p);
    validate_staged(&f.app, &p, runner).unwrap_err().code
}

#[test]
fn a_valid_bundle_passes_and_uses_the_fixed_argv() {
    let f = fixture(&AppSpec::default());
    let version = v("0.1.1");
    let run = running(SigningInfo::Adhoc);
    let runner = FakeRunner::adhoc();
    let staged = validate_staged(&f.app, &params(&version, &run), &runner).unwrap();
    assert_eq!(staged.signing, SigningInfo::Adhoc);
    assert!(!staged.entitlements_change && !staged.sdk_pin_changed && !staged.stapler_checked);
    assert_eq!(staged.build.version, version);
    let app = f.app.to_str().unwrap();
    assert_eq!(runner.argv_of("/usr/bin/codesign").len(), 3);
    assert_eq!(runner.calls.borrow()[0], ["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", app]);
    assert_eq!(runner.calls.borrow()[1], ["/usr/bin/codesign", "-dv", "--verbose=4", app]);
    assert_eq!(runner.calls.borrow()[2], ["/usr/bin/codesign", "-d", "--entitlements", ":-", app]);
}

#[test]
fn plist_checks() {
    let r = FakeRunner::adhoc();
    // Wrong identifier, in the staged bundle and as the expected one.
    assert_eq!(code_of(AppSpec { bundle_id: "other.id".into(), ..AppSpec::default() }, &r, |_| {}), ErrorCode::BundleIdMismatch);
    assert_eq!(code_of(AppSpec::default(), &r, |p| p.bundle_id = "expected.other"), ErrorCode::BundleIdMismatch);
    // Version core mismatch (short version) and build.json mismatches.
    assert_eq!(code_of(AppSpec { short_version: "0.1.2".into(), ..AppSpec::default() }, &r, |_| {}), ErrorCode::VersionMismatch);
    assert_eq!(code_of(AppSpec { version: "0.1.2".into(), ..AppSpec::default() }, &r, |_| {}), ErrorCode::VersionMismatch);
    assert_eq!(code_of(AppSpec { arch: "aarch64".into(), ..AppSpec::default() }, &r, |_| {}), ErrorCode::ArchMismatch);
    // The pre-release part belongs in build.json and the feed, not in the plist.
    let rc = AppSpec { version: "0.1.1-rc.1".into(), ..AppSpec::default() };
    let f = fixture(&rc);
    let pre = v("0.1.1-rc.1");
    let run = running(SigningInfo::Adhoc);
    validate_staged(&f.app, &params(&pre, &run), &r).unwrap();
}

#[test]
fn plist_keys_missing_or_broken() {
    let r = FakeRunner::adhoc();
    let run = running(SigningInfo::Adhoc);
    let version = v("0.1.1");
    for key in ["CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleExecutable"] {
        let f = fixture(&AppSpec::default());
        let plist_path = f.app.join("Contents/Info.plist");
        let mut d = plist::Value::from_file(&plist_path).unwrap().into_dictionary().unwrap();
        d.remove(key);
        plist::Value::Dictionary(d).to_file_xml(&plist_path).unwrap();
        let e = validate_staged(&f.app, &params(&version, &run), &r).unwrap_err();
        assert_eq!(e.code, ErrorCode::BundleInvalid, "{key}");
    }
    // Garbage plist, missing plist, missing build.json, executable name with a slash, missing executable.
    let f = fixture(&AppSpec::default());
    fs::write(f.app.join("Contents/Info.plist"), b"garbage").unwrap();
    assert_eq!(validate_staged(&f.app, &params(&version, &run), &r).unwrap_err().code, ErrorCode::BundleInvalid);
    let f = fixture(&AppSpec::default());
    fs::remove_file(f.app.join("Contents/Info.plist")).unwrap();
    assert_eq!(validate_staged(&f.app, &params(&version, &run), &r).unwrap_err().code, ErrorCode::BundleInvalid);
    let f = fixture(&AppSpec::default());
    fs::remove_file(f.app.join("Contents/Resources/build.json")).unwrap();
    assert_eq!(validate_staged(&f.app, &params(&version, &run), &r).unwrap_err().code, ErrorCode::BundleInvalid);
    let f = fixture(&AppSpec::default());
    fs::remove_file(f.app.join("Contents/MacOS").join(TEST_EXE)).unwrap();
    assert_eq!(validate_staged(&f.app, &params(&version, &run), &r).unwrap_err().code, ErrorCode::BundleInvalid);
    let f = fixture(&AppSpec::default());
    let plist_path = f.app.join("Contents/Info.plist");
    let mut d = plist::Value::from_file(&plist_path).unwrap().into_dictionary().unwrap();
    d.insert("CFBundleExecutable".into(), "../../evil".into());
    plist::Value::Dictionary(d).to_file_xml(&plist_path).unwrap();
    assert_eq!(validate_staged(&f.app, &params(&version, &run), &r).unwrap_err().code, ErrorCode::BundleInvalid);
    // Info.plist or build.json as symlinks are not followed.
    let f = fixture(&AppSpec::default());
    let real = f.app.join("Contents/Resources/data.txt");
    fs::remove_file(f.app.join("Contents/Resources/build.json")).unwrap();
    symlink(&real, f.app.join("Contents/Resources/build.json")).unwrap();
    assert_eq!(validate_staged(&f.app, &params(&version, &run), &r).unwrap_err().code, ErrorCode::BundleInvalid);
    // The staged bundle path is missing or a file.
    assert_eq!(validate_staged(Path::new("/nonexistent/x.app"), &params(&version, &run), &r).unwrap_err().code, ErrorCode::BundleInvalid);
    assert!(r.calls.borrow().is_empty(), "codesign must not run for structural failures");
}

#[test]
fn wrong_architecture_executable() {
    let r = FakeRunner::adhoc();
    assert_eq!(code_of(AppSpec { exe: thin_macho(CPU_ARM64), ..AppSpec::default() }, &r, |_| {}), ErrorCode::ArchMismatch);
    assert_eq!(code_of(AppSpec { exe: b"#!/bin/sh\n".to_vec(), ..AppSpec::default() }, &r, |_| {}), ErrorCode::BundleInvalid);
    // A universal executable satisfies either.
    let f = fixture(&AppSpec { exe: fat_macho(&[CPU_X64, CPU_ARM64]), ..AppSpec::default() });
    let version = v("0.1.1");
    let run = running(SigningInfo::Adhoc);
    validate_staged(&f.app, &params(&version, &run), &FakeRunner::adhoc()).unwrap();
}

#[test]
fn minimum_system_version() {
    let r = FakeRunner::adhoc();
    assert_eq!(code_of(AppSpec { min_os: Some("15.0".into()), ..AppSpec::default() }, &r, |_| {}), ErrorCode::OsTooOld);
    assert_eq!(code_of(AppSpec { min_os: Some("garbage".into()), ..AppSpec::default() }, &r, |_| {}), ErrorCode::BundleInvalid);
    // Equal passes; absent passes.
    for spec in [AppSpec { min_os: Some("14.2".into()), ..AppSpec::default() }, AppSpec { min_os: None, ..AppSpec::default() }] {
        let f = fixture(&spec);
        let version = v("0.1.1");
        let run = running(SigningInfo::Adhoc);
        validate_staged(&f.app, &params(&version, &run), &FakeRunner::adhoc()).unwrap();
    }
}

#[test]
fn codesign_failures() {
    let mut r = FakeRunner::adhoc();
    r.verify_ok = false;
    assert_eq!(code_of(AppSpec::default(), &r, |_| {}), ErrorCode::CodesignFailed);
}

#[test]
fn identity_continuity_matrix() {
    let team = |t: &str| SigningInfo::DeveloperId { team: t.into() };
    // (running, staged codesign output, build.json mode) -> result
    let cases: Vec<(SigningInfo, FakeRunner, &str, Option<ErrorCode>)> = vec![
        (team("TEAMAAAAAA"), FakeRunner::developer_id("TEAMAAAAAA", true), "developer-id", None),
        (team("TEAMAAAAAA"), FakeRunner::developer_id("TEAMBBBBBB", true), "developer-id", Some(ErrorCode::IdentityChanged)),
        (team("TEAMAAAAAA"), FakeRunner::adhoc(), "adhoc", Some(ErrorCode::IdentityChanged)),
        (SigningInfo::Adhoc, FakeRunner::adhoc(), "adhoc", None),
        (SigningInfo::Adhoc, FakeRunner::developer_id("TEAMAAAAAA", true), "developer-id", None),
        (SigningInfo::Unknown, FakeRunner::adhoc(), "adhoc", Some(ErrorCode::IdentityChanged)),
        (SigningInfo::Unknown, FakeRunner::developer_id("TEAMAAAAAA", true), "developer-id", Some(ErrorCode::IdentityChanged)),
    ];
    for (i, (run, runner, mode, want)) in cases.into_iter().enumerate() {
        let f = fixture(&AppSpec { signing_mode: mode.into(), ..AppSpec::default() });
        let version = v("0.1.1");
        let facts = running(run);
        let got = validate_staged(&f.app, &params(&version, &facts), &runner);
        match want {
            None => {
                got.unwrap_or_else(|e| panic!("case {i}: {e}"));
            }
            Some(code) => assert_eq!(got.unwrap_err().code, code, "case {i}"),
        }
    }
    // An unidentified staged signature (neither ad-hoc nor Developer ID) is refused for any running app.
    let mut r = FakeRunner::adhoc();
    r.details_stderr = "CodeDirectory v=20500 flags=0x0(none)\nAuthority=Some Self Signed\n".into();
    assert_eq!(code_of(AppSpec::default(), &r, |_| {}), ErrorCode::IdentityChanged);
}

#[test]
fn build_json_must_agree_with_the_signature() {
    let r = FakeRunner::developer_id("TEAMAAAAAA", true);
    let f = fixture(&AppSpec { signing_mode: "adhoc".into(), ..AppSpec::default() });
    let version = v("0.1.1");
    let facts = running(SigningInfo::DeveloperId { team: "TEAMAAAAAA".into() });
    assert_eq!(validate_staged(&f.app, &params(&version, &facts), &r).unwrap_err().code, ErrorCode::BundleInvalid);
}

#[test]
fn developer_id_needs_hardened_runtime_and_a_valid_ticket() {
    let facts = running(SigningInfo::DeveloperId { team: "TEAMAAAAAA".into() });
    let version = v("0.1.1");
    let spec = || AppSpec { signing_mode: "developer-id".into(), ..AppSpec::default() };
    let f = fixture(&spec());
    let no_runtime = FakeRunner::developer_id("TEAMAAAAAA", false);
    assert_eq!(validate_staged(&f.app, &params(&version, &facts), &no_runtime).unwrap_err().code, ErrorCode::BundleInvalid);
    // Stapler runs when the tool exists, with a fixed argv; a failing ticket is refused.
    let ok = FakeRunner::developer_id("TEAMAAAAAA", true);
    let stapler = Path::new("/Library/Developer/CommandLineTools/usr/bin/stapler");
    let mut p = params(&version, &facts);
    p.stapler = Some(stapler);
    let staged = validate_staged(&f.app, &p, &ok).unwrap();
    assert!(staged.stapler_checked && staged.hardened_runtime);
    assert_eq!(ok.argv_of(stapler.to_str().unwrap()), [vec![stapler.to_str().unwrap().to_string(), "validate".into(), f.app.to_str().unwrap().into()]]);
    let mut bad = FakeRunner::developer_id("TEAMAAAAAA", true);
    bad.stapler_ok = false;
    assert_eq!(validate_staged(&f.app, &p, &bad).unwrap_err().code, ErrorCode::CodesignFailed);
    // Without the tool the check is skipped (and reported as such).
    p.stapler = None;
    assert!(!validate_staged(&f.app, &p, &ok).unwrap().stapler_checked);
    // An ad-hoc staged bundle is not asked for a ticket or the runtime flag.
    let f2 = fixture(&AppSpec::default());
    let adhoc_facts = running(SigningInfo::Adhoc);
    let mut p2 = params(&version, &adhoc_facts);
    p2.stapler = Some(stapler);
    let adhoc = FakeRunner::adhoc();
    assert!(!validate_staged(&f2.app, &p2, &adhoc).unwrap().stapler_checked);
    assert!(adhoc.argv_of(stapler.to_str().unwrap()).is_empty());
}

#[test]
fn entitlement_rules() {
    let version = v("0.1.1");
    let f = fixture(&AppSpec::default());
    // get-task-allow is refused, true or false.
    for val in [true, false] {
        let mut r = FakeRunner::adhoc();
        r.entitlements_xml = entitlements_xml(&[("com.apple.security.get-task-allow", val)]);
        let facts = running(SigningInfo::Adhoc);
        assert_eq!(validate_staged(&f.app, &params(&version, &facts), &r).unwrap_err().code, ErrorCode::BundleInvalid);
    }
    // Subset passes; superset is refused unless the feed allows it, then it is reported.
    let mut facts = running(SigningInfo::Adhoc);
    facts.entitlements = parse_entitlements(entitlements_xml(&[("com.apple.security.cs.allow-jit", true), ("com.apple.security.network.client", true)]).as_bytes()).unwrap();
    let mut r = FakeRunner::adhoc();
    r.entitlements_xml = entitlements_xml(&[("com.apple.security.network.client", true)]);
    assert!(!validate_staged(&f.app, &params(&version, &facts), &r).unwrap().entitlements_change);
    r.entitlements_xml = entitlements_xml(&[("com.apple.security.network.client", true), ("com.apple.security.device.camera", true)]);
    assert_eq!(validate_staged(&f.app, &params(&version, &facts), &r).unwrap_err().code, ErrorCode::BundleInvalid);
    let mut p = params(&version, &facts);
    p.entitlements_change_allowed = true;
    let staged = validate_staged(&f.app, &p, &r).unwrap();
    assert!(staged.entitlements_change);
    // The same key with a different value is a change too.
    r.entitlements_xml = entitlements_xml(&[("com.apple.security.network.client", false)]);
    assert_eq!(validate_staged(&f.app, &params(&version, &facts), &r).unwrap_err().code, ErrorCode::BundleInvalid);
}

#[test]
fn sdk_pin_change_is_reported() {
    let version = v("0.1.1");
    let r = FakeRunner::adhoc();
    let f = fixture(&AppSpec { sdk_pin: Some("pin-b".into()), ..AppSpec::default() });
    let facts = running(SigningInfo::Adhoc);
    let staged = validate_staged(&f.app, &params(&version, &facts), &r).unwrap();
    assert!(staged.sdk_pin_changed);
    assert_eq!(staged.sdk_pin.as_deref(), Some("pin-b"));
    let f = fixture(&AppSpec::default());
    assert!(!validate_staged(&f.app, &params(&version, &facts), &r).unwrap().sdk_pin_changed);
    let f = fixture(&AppSpec { sdk_pin: None, ..AppSpec::default() });
    assert!(validate_staged(&f.app, &params(&version, &facts), &r).unwrap().sdk_pin_changed, "running has a pin, staged has none");
    assert_eq!(read_sdk_pin(&f.app), None);
    let mut none = running(SigningInfo::Adhoc);
    none.sdk_pin = None;
    assert!(!validate_staged(&f.app, &params(&version, &none), &r).unwrap().sdk_pin_changed);
}

// ------------------------------------------------------------------------------------------
// Real codesign on an ad-hoc fixture, through the real unpack
// ------------------------------------------------------------------------------------------

fn real_staged_app() -> Option<(tempfile::TempDir, PathBuf)> {
    if !have_codesign() {
        eprintln!("SKIP: /usr/bin/codesign is not available");
        return None;
    }
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let src = root.join("src");
    fs::create_dir(&src).unwrap();
    let app = make_app(&src, "TestBundle.app", &AppSpec { exe: system_true(), ..AppSpec::default() });
    // A framework-style symlink inside the sealed resources.
    fs::create_dir_all(app.join("Contents/Resources/Versions/A")).unwrap();
    fs::write(app.join("Contents/Resources/Versions/A/lib.dat"), b"lib").unwrap();
    symlink("A", app.join("Contents/Resources/Versions/Current")).unwrap();
    sign_adhoc(&app);
    let gz = tar_dir_gz(&app, "TestBundle.app");
    let apps = root.join("apps");
    fs::create_dir(&apps).unwrap();
    let stage = create_stage_dir(&apps).unwrap();
    let u = unpack(&gz[..], &stage, "TestBundle.app", &Limits::default()).unwrap();
    Some((tmp, u.root))
}

#[test]
fn real_adhoc_codesign_passes_and_fails_after_one_byte_changes() {
    let Some((_tmp, staged)) = real_staged_app() else { return };
    let version = v("0.1.1");
    let facts = running(SigningInfo::Adhoc);
    let runner = SystemRunner::default();
    let ok = validate_staged(&staged, &params(&version, &facts), &runner).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(ok.signing, SigningInfo::Adhoc);
    assert!(ok.entitlements.is_empty());
    // The signature facts straight from the real tool.
    let sig = read_signature(&staged, &runner).unwrap();
    assert_eq!(sig.signing, SigningInfo::Adhoc);
    // One resource byte changes: strict verification fails.
    let res = staged.join("Contents/Resources/data.txt");
    let mut bytes = fs::read(&res).unwrap();
    bytes[0] ^= 1;
    fs::write(&res, bytes).unwrap();
    assert_eq!(validate_staged(&staged, &params(&version, &facts), &runner).unwrap_err().code, ErrorCode::CodesignFailed);
}

#[test]
fn real_codesign_rejects_an_unsigned_bundle() {
    if !have_codesign() {
        eprintln!("SKIP: /usr/bin/codesign is not available");
        return;
    }
    let f = fixture(&AppSpec { exe: system_true(), ..AppSpec::default() });
    let version = v("0.1.1");
    let facts = running(SigningInfo::Adhoc);
    assert_eq!(validate_staged(&f.app, &params(&version, &facts), &SystemRunner::default()).unwrap_err().code, ErrorCode::CodesignFailed);
}

#[test]
fn the_crate_source_has_no_literal_bundle_identifier() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for e in fs::read_dir(src).unwrap() {
        let p = e.unwrap().path();
        let text = fs::read_to_string(&p).unwrap();
        assert!(!text.contains("com.intelyhome"), "{}", p.display());
        assert!(!text.contains("std::env"), "{}", p.display());
    }
}

// ------------------------------------------------------------------------------------------
// A real mounted disk image (Appendix F item 6). Run with `-- --ignored`: it mounts and detaches.
// ------------------------------------------------------------------------------------------

struct Detach(String);

impl Drop for Detach {
    fn drop(&mut self) {
        let _ = std::process::Command::new("/usr/bin/hdiutil").args(["detach", "-force", &self.0]).output();
    }
}

#[test]
#[ignore]
fn real_disk_image_is_classified_as_a_disk_image() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    fs::create_dir(&src).unwrap();
    make_app(&src, "Mounted.app", &AppSpec::default());
    let vol = format!("IntelyUpdTest{}", std::process::id());
    let dmg = tmp.path().join("t.dmg");
    let out = std::process::Command::new("/usr/bin/hdiutil").args(["create", "-size", "8m", "-fs", "APFS", "-volname", &vol, "-srcfolder"]).arg(&src).arg(&dmg).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let out = std::process::Command::new("/usr/bin/hdiutil").args(["attach", "-readonly", "-nobrowse", "-noautoopen", "-plist"]).arg(&dmg).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let mount = format!("/Volumes/{vol}");
    let _guard = Detach(mount.clone());
    let probe = SystemProbe { home: None };
    assert!(probe.is_readonly_volume(Path::new(&mount)), "statfs MNT_RDONLY must be set on a read-only image");
    let exe = Path::new(&mount).join("Mounted.app/Contents/MacOS").join(TEST_EXE);
    let loc = classify(&exe, &probe);
    assert_eq!(loc.class, LocationClass::DiskImage);
    assert_eq!(loc.install_refusal(), Some(ErrorCode::DiskImage));
    assert!(fs::read_dir(&mount).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".intely-write-probe")));
}
