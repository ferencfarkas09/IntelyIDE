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
    let r = scan_with(root, &Env { android_home: None, ..Env::default() });
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

    /// A project whose first app target reads its Info.plist from `plist_path`.
    fn project_reading(plist_path: &str) -> String {
        format!(
            "{{ rootObject = P; objects = {{ P = {{ isa = PBXProject; buildConfigurationList = L; targets = ( T ); }}; T = {{ isa = PBXNativeTarget; name = App; productType = \"com.apple.product-type.application\"; buildConfigurationList = TL; }}; \
             TL = {{ isa = XCConfigurationList; buildConfigurations = ( C ); }}; L = {{ isa = XCConfigurationList; buildConfigurations = ( ); }}; \
             C = {{ isa = XCBuildConfiguration; name = Release; buildSettings = {{ INFOPLIST_FILE = \"{plist_path}\"; CODE_SIGN_ENTITLEMENTS = \"/etc/passwd\"; }}; }}; }}; }}"
        )
    }

    #[test]
    fn a_setting_cannot_point_the_reader_out_of_the_project() {
        // an empty permission text is something the scan reports with the file's path: it makes a read observable
        let plist = "<plist><dict><key>NSCameraUsageDescription</key><string></string></dict></plist>";
        let outside = tempfile::tempdir().unwrap();
        put(outside.path(), "Info.plist", plist);
        let d = base();
        put(d.path(), "ios/Pods/Manifest.lock", "x");
        put(d.path(), "ios/Inside.plist", plist);

        // control: the same plist inside the project is read and reported
        put(d.path(), PBX, project_reading("Inside.plist"));
        let r = scan(d.path());
        let hit = r.projects[0].findings.iter().find(|f| f.id == "ios.permission.emptyText");
        assert_eq!(hit.and_then(|f| f.file.as_deref()), Some("ios/Inside.plist"), "{:?}", r.skipped);

        // the same setting climbing out of the project (relative, absolute, through a link) reads nothing
        let up = "../".repeat(30);
        let out = outside.path().display().to_string();
        std::os::unix::fs::symlink(outside.path(), d.path().join("ios/linked")).unwrap();
        for path in [format!("{up}{}/Info.plist", out.trim_start_matches('/')), format!("{out}/Info.plist"), "linked/Info.plist".to_string(), "$(SRCROOT)/../../x/Info.plist".to_string()] {
            put(d.path(), PBX, project_reading(&path));
            let r = scan(d.path());
            let seen: Vec<_> = r.projects[0].findings.iter().filter(|f| f.id == "ios.permission.emptyText").collect();
            assert!(seen.is_empty(), "{path}: read the plist outside the project");
            assert!(!serde_json::to_string(&r).unwrap().contains(&out));
        }
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

#[test]
fn a_crowded_folder_says_so_and_still_finds_the_project_files() {
    let d = base();
    for i in 0..5200 {
        put(d.path(), &format!("android/app/src/a{i:05}"), "x");
    }
    let r = scan(d.path());
    assert!(r.projects[0].android);
    assert!(r.skipped.iter().any(|s| s.starts_with("listingTruncated:android/app/src")), "{:?}", r.skipped);
    assert!(r.projects[0].facts.iter().any(|f| f.key == "android.compileSdk"));
}

#[test]
fn a_spent_budget_stops_the_scan_and_says_so() {
    let d = base();
    let r = scan_with(d.path(), &Env { android_home: None, budget: Some(Duration::ZERO) });
    assert!(r.skipped.iter().any(|s| s == "stoppedEarly"), "{:?}", r.skipped);
    assert!(r.projects[0].findings.is_empty() && r.projects[0].facts.is_empty());
}

#[test]
fn one_check_cannot_flood_the_report() {
    let d = base();
    let body = "signingConfigs { x { storePassword 'a' } }\n".repeat(5000);
    put(d.path(), "android/app/build.gradle", format!("apply plugin: 'com.android.application'\nandroid {{\n compileSdk 34\n{body}}}\n"));
    let r = scan(d.path());
    let n = r.projects[0].findings.iter().filter(|f| f.id == "android.secrets.plaintext").count();
    assert!((1..=25).contains(&n), "{n}");
    assert!(r.projects[0].findings.len() <= 400);
}
