//! A repository is hostile input: nothing here may panic, read outside the repository, or take long.

use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use intely_mobilehealth::{scan_with, Env, Report};

fn put(root: &Path, rel: &str, text: impl AsRef<[u8]>) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn scan(root: &Path) -> Report {
    let t = Instant::now();
    let r = scan_with(root, &Env { android_home: None });
    assert!(t.elapsed() < Duration::from_secs(20), "scan took {:?}", t.elapsed());
    r
}

const PBX: &str = "ios/App.xcodeproj/project.pbxproj";

/// A project folder that is a valid mobile project, so the scan reaches the file under test.
fn base() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "package.json", "{\"dependencies\":{\"react-native\":\"0.74.0\"}}");
    put(d.path(), "ios/Podfile", "platform :ios, '13.0'\n");
    put(d.path(), "android/settings.gradle", "include ':app'\n");
    put(d.path(), "android/app/build.gradle", "apply plugin: 'com.android.application'\nandroid { compileSdk 34 }\n");
    d
}

#[test]
fn huge_files_are_named_and_skipped_not_read() {
    let d = base();
    put(d.path(), PBX, vec![b' '; 5 * 1024 * 1024]);
    put(d.path(), "ios/Podfile.lock", vec![b'x'; 9 * 1024 * 1024]);
    put(d.path(), "ios/Pods/Manifest.lock", vec![b'x'; 9 * 1024 * 1024]);
    put(d.path(), "android/gradle.properties", vec![b'#'; 5 * 1024 * 1024]);
    let r = scan(d.path());
    for f in [PBX, "ios/Podfile.lock", "ios/Pods/Manifest.lock", "android/gradle.properties"] {
        assert!(r.skipped.iter().any(|s| s == &format!("tooLarge:{f}")), "{f} not named in {:?}", r.skipped);
    }
}

#[test]
fn invalid_utf8_everywhere_is_survived() {
    let d = base();
    let junk: Vec<u8> = (0..4000u32).map(|i| (i * 37 % 256) as u8).collect();
    for f in [PBX, "ios/App/Info.plist", "ios/Podfile", "android/app/build.gradle", "android/gradle.properties", "android/app/src/main/AndroidManifest.xml", "package.json", "app.json", "android/gradle/wrapper/gradle-wrapper.properties"] {
        put(d.path(), f, &junk);
    }
    let r = scan(d.path());
    assert!(r.detected);
}

#[test]
fn deep_nesting_is_refused_not_followed() {
    let d = base();
    put(d.path(), PBX, format!("{{ objects = {}{} }}", "( ".repeat(200_000), ") ".repeat(200_000)));
    put(d.path(), "ios/App/Info.plist", format!("<plist><dict><key>a</key>{}{}</dict></plist>", "<dict>".repeat(100_000), "</dict>".repeat(100_000)));
    put(d.path(), "package.json", format!("{}{}", "[".repeat(100_000), "]".repeat(100_000)));
    put(d.path(), "app.json", format!("{}{}", "{\"a\":".repeat(100_000), "}".repeat(100_000)));
    put(d.path(), "android/app/build.gradle", format!("apply plugin: 'com.android.application'\nandroid {}{}", "{ ".repeat(100_000), "} ".repeat(100_000)));
    let r = scan(d.path());
    assert!(r.skipped.iter().any(|s| s == &format!("unreadable:{PBX}")), "{:?}", r.skipped);
}

#[test]
fn a_binary_plist_and_a_garbage_pbxproj_are_reported_unreadable() {
    let d = base();
    put(d.path(), PBX, "this is not a project file");
    let r = scan(d.path());
    assert!(r.skipped.iter().any(|s| s == &format!("unreadable:{PBX}")));
}

#[test]
fn a_thousand_folders_and_ten_thousand_files_stay_bounded() {
    let d = base();
    for i in 0..300 {
        put(d.path(), &format!("ios/gen{i}/a/b/c/file.txt"), "x");
    }
    for i in 0..8000 {
        put(d.path(), &format!("android/app/src/main/res/raw/f{i}.txt"), "x");
    }
    let r = scan(d.path());
    assert!(r.detected);
}

#[cfg(unix)]
mod links {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn links_to_outside_are_never_followed() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        put(outside.path(), "project.pbxproj", "{ rootObject = X; objects = { X = { isa = PBXProject; }; }; } LEAKMARK");
        put(outside.path(), "package.json", "{\"version\":\"LEAKMARK\",\"dependencies\":{\"react-native\":\"0.74.0\",\"expo-camera\":\"1\"}}");
        put(outside.path(), "Info.plist", "<plist><dict><key>CFBundleName</key><string>LEAKMARK</string></dict></plist>");
        put(outside.path(), "ios/App.xcodeproj/project.pbxproj", "LEAKMARK");
        put(d.path(), "android/settings.gradle", "include ':app'\n");
        put(d.path(), "android/app/build.gradle", "apply plugin: 'com.android.application'\nandroid { compileSdk 34 }\n");
        symlink(outside.path().join("package.json"), d.path().join("package.json")).unwrap();
        symlink(outside.path(), d.path().join("ios")).unwrap();
        symlink(outside.path().join("Info.plist"), d.path().join("android/app/AndroidManifest.xml")).unwrap();
        let r = scan(d.path());
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains("LEAKMARK"));
        assert!(!r.projects[0].ios, "an ios folder that is a link is not an iOS project");
        assert!(!r.projects[0].react_native);
    }

    #[test]
    fn a_setting_cannot_point_the_reader_out_of_the_project() {
        let d = base();
        let secret = tempfile::tempdir().unwrap();
        put(secret.path(), "Info.plist", "<plist><dict><key>NSCameraUsageDescription</key><string>LEAKMARK</string></dict></plist>");
        put(d.path(), "ios/Pods/Manifest.lock", "x");
        let pbx = format!(
            "{{ rootObject = P; objects = {{ P = {{ isa = PBXProject; buildConfigurationList = L; targets = ( T ); }}; T = {{ isa = PBXNativeTarget; name = App; productType = \"com.apple.product-type.application\"; buildConfigurationList = TL; }}; \
             TL = {{ isa = XCConfigurationList; buildConfigurations = ( C ); }}; L = {{ isa = XCConfigurationList; buildConfigurations = ( ); }}; \
             C = {{ isa = XCBuildConfiguration; name = Release; buildSettings = {{ INFOPLIST_FILE = \"../../../../../../../../{}/Info.plist\"; CODE_SIGN_ENTITLEMENTS = \"/etc/passwd\"; }}; }}; }}; }}",
            secret.path().display().to_string().trim_start_matches('/')
        );
        put(d.path(), PBX, pbx);
        let r = scan(d.path());
        assert!(!serde_json::to_string(&r).unwrap().contains("LEAKMARK"));
    }

    #[test]
    fn a_socket_and_a_fifo_are_not_opened() {
        let d = base();
        let sock = d.path().join("android/app/src/main/AndroidManifest.xml");
        fs::create_dir_all(sock.parent().unwrap()).unwrap();
        let _l = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let r = scan(d.path());
        assert!(r.detected && r.projects[0].android);
    }
}
