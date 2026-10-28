//! A repository shaped like a mobile app with a Node package: scan, preview and apply end to end.

use std::fs;
use std::path::Path;

use intely_versions::{apply, plan, scan, Change, Kind, Role};

const PACKAGE: &str = "{\n  \"name\": \"services\",\n  \"version\": \"3.88.7\",\n  \"scripts\": {\n    \"start\": \"node index.js\"\n  },\n  \"config\": { \"version\": \"legacy\" }\n}\n";
const LOCK: &str = "{\n  \"name\": \"services\",\n  \"version\": \"3.88.7\",\n  \"lockfileVersion\": 3,\n  \"packages\": {\n    \"\": {\n      \"name\": \"services\",\n      \"version\": \"3.88.7\"\n    },\n    \"node_modules/left-pad\": {\n      \"version\": \"1.3.0\"\n    }\n  }\n}\n";
const PBXPROJ: &str = "// !$*UTF8*$!\n{\n\tobjects = {\n\t\tAA /* Debug */ = {\n\t\t\tbuildSettings = {\n\t\t\t\tCURRENT_PROJECT_VERSION = 45;\n\t\t\t\tMARKETING_VERSION = 1.2.3;\n\t\t\t\tPRODUCT_NAME = App;\n\t\t\t};\n\t\t};\n\t\tBB /* Release */ = {\n\t\t\tbuildSettings = {\n\t\t\t\tCURRENT_PROJECT_VERSION = 45;\n\t\t\t\tMARKETING_VERSION = 1.2.3;\n\t\t\t};\n\t\t};\n\t\tCC /* Tests */ = {\n\t\t\tbuildSettings = {\n\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tMARKETING_VERSION = 1.0;\n\t\t\t};\n\t\t};\n\t};\n}\n";
const PLIST_VAR: &str = "<?xml version=\"1.0\"?>\n<plist version=\"1.0\">\n<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>$(MARKETING_VERSION)</string>\n\t<key>CFBundleVersion</key>\n\t<string>$(CURRENT_PROJECT_VERSION)</string>\n</dict>\n</plist>\n";
const PLIST_LIT: &str = "<plist version=\"1.0\">\n<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>2.0.1</string>\n\t<key>CFBundleVersion</key>\n\t<string>17</string>\n</dict>\n</plist>\n";
const GRADLE: &str = "android {\n    defaultConfig {\n        applicationId \"com.example.app\"\n        versionCode 12\n        versionName \"1.4.0\"\n    }\n}\n";

fn write(root: &Path, rel: &str, text: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    write(d.path(), "package.json", PACKAGE);
    write(d.path(), "package-lock.json", LOCK);
    write(d.path(), "ios/App.xcodeproj/project.pbxproj", PBXPROJ);
    write(d.path(), "ios/App/Info.plist", PLIST_VAR);
    write(d.path(), "ios/Widget/Info.plist", PLIST_LIT);
    write(d.path(), "android/app/build.gradle", GRADLE);
    write(d.path(), "node_modules/left-pad/package.json", "{\"version\":\"1.3.0\"}");
    write(d.path(), "ios/Pods/Pods.xcodeproj/project.pbxproj", "MARKETING_VERSION = 9.9.9;\n");
    d
}

fn change(id: &str, from: &str, to: &str) -> Change {
    Change { id: id.into(), from: from.into(), to: to.into() }
}

fn text(root: &Path, rel: &str) -> String {
    fs::read_to_string(root.join(rel)).unwrap()
}

#[test]
fn scan_lists_every_version_of_the_app_and_nothing_of_its_dependencies() {
    let d = repo();
    let s = scan(d.path());
    let ids: Vec<(&str, &str, u32, bool)> = s.fields.iter().map(|f| (f.id.as_str(), f.value.as_str(), f.occurrences, f.mixed)).collect();
    assert_eq!(
        ids,
        vec![
            ("android/app/build.gradle#versionCode", "12", 1, false),
            ("android/app/build.gradle#versionName", "1.4.0", 1, false),
            ("ios/App.xcodeproj/project.pbxproj#CURRENT_PROJECT_VERSION", "45", 3, true),
            ("ios/App.xcodeproj/project.pbxproj#MARKETING_VERSION", "1.2.3", 3, true),
            ("ios/Widget/Info.plist#CFBundleShortVersionString", "2.0.1", 1, false),
            ("ios/Widget/Info.plist#CFBundleVersion", "17", 1, false),
            ("package.json#version", "3.88.7", 1, false),
        ]
    );
    assert!(!s.truncated && s.skipped.is_empty());
    let pkg = s.fields.iter().find(|f| f.id == "package.json#version").unwrap();
    assert_eq!((pkg.kind, pkg.role), (Kind::PackageJson, Role::Version));
    assert_eq!(pkg.companions, vec!["package-lock.json".to_string()]);
    let build = s.fields.iter().find(|f| f.key == "CURRENT_PROJECT_VERSION").unwrap();
    assert_eq!(build.role, Role::Build);
}

#[test]
fn apply_changes_only_the_version_bytes_and_keeps_the_lock_file_in_step() {
    let d = repo();
    let changes = vec![change("package.json#version", "3.88.7", "3.88.8"), change("ios/App.xcodeproj/project.pbxproj#MARKETING_VERSION", "1.2.3", "1.2.4"), change("ios/App.xcodeproj/project.pbxproj#CURRENT_PROJECT_VERSION", "45", "46"), change("android/app/build.gradle#versionName", "1.4.0", "1.4.1"), change("android/app/build.gradle#versionCode", "12", "13")];
    let written = apply(d.path(), &changes).unwrap();
    assert_eq!(written, vec!["android/app/build.gradle", "ios/App.xcodeproj/project.pbxproj", "package.json", "package-lock.json"]);
    assert_eq!(text(d.path(), "package.json"), PACKAGE.replacen("\"version\": \"3.88.7\"", "\"version\": \"3.88.8\"", 1));
    assert_eq!(text(d.path(), "package-lock.json"), LOCK.replacen("\"version\": \"3.88.7\"", "\"version\": \"3.88.8\"", 2));
    assert_eq!(text(d.path(), "ios/App.xcodeproj/project.pbxproj"), PBXPROJ.replace("MARKETING_VERSION = 1.2.3;", "MARKETING_VERSION = 1.2.4;").replace("MARKETING_VERSION = 1.0;", "MARKETING_VERSION = 1.2.4;").replace("CURRENT_PROJECT_VERSION = 45;", "CURRENT_PROJECT_VERSION = 46;").replace("CURRENT_PROJECT_VERSION = 1;", "CURRENT_PROJECT_VERSION = 46;"));
    assert_eq!(text(d.path(), "android/app/build.gradle"), GRADLE.replace("versionCode 12", "versionCode 13").replace("\"1.4.0\"", "\"1.4.1\""));
    // untouched files stay byte for byte
    assert_eq!(text(d.path(), "ios/Widget/Info.plist"), PLIST_LIT);
    assert_eq!(text(d.path(), "ios/App/Info.plist"), PLIST_VAR);
    assert!(!d.path().join("package.json.intely-tmp").exists());
    // and the next scan reads the new values
    let s = scan(d.path());
    assert_eq!(s.fields.iter().find(|f| f.id == "package.json#version").unwrap().value, "3.88.8");
    assert!(s.fields.iter().find(|f| f.key == "MARKETING_VERSION").is_some_and(|f| !f.mixed && f.value == "1.2.4"));
}

#[test]
fn plan_shows_the_diff_and_writes_nothing() {
    let d = repo();
    let p = plan(d.path(), &[change("package.json#version", "3.88.7", "4.0.0")]).unwrap();
    assert_eq!(p.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["package.json", "package-lock.json"]);
    assert!(p[0].diff.contains("-  \"version\": \"3.88.7\",\n+  \"version\": \"4.0.0\","), "{}", p[0].diff);
    assert_eq!(text(d.path(), "package.json"), PACKAGE);
}

#[test]
fn a_changed_file_is_refused_as_stale_and_nothing_is_written() {
    let d = repo();
    let changes = vec![change("package.json#version", "3.88.7", "3.88.8"), change("android/app/build.gradle#versionCode", "11", "12")];
    let err = apply(d.path(), &changes).unwrap_err();
    assert_eq!(err.code, "stale");
    assert_eq!(text(d.path(), "package.json"), PACKAGE);
    let gone = apply(d.path(), &[change("nope/package.json#version", "1", "2")]).unwrap_err();
    assert_eq!(gone.code, "stale");
}

#[test]
fn bad_values_and_requests_are_refused() {
    let d = repo();
    for (id, from, to) in [("package.json#version", "3.88.7", "../x"), ("package.json#version", "3.88.7", ""), ("package.json#version", "3.88.7", "1 2"), ("android/app/build.gradle#versionCode", "12", "1.5"), ("android/app/build.gradle#versionCode", "12", "-1"), ("ios/Widget/Info.plist#CFBundleVersion", "17", "x")] {
        assert_eq!(apply(d.path(), &[change(id, from, to)]).unwrap_err().code, "badValue", "{id} -> {to}");
    }
    assert_eq!(apply(d.path(), &[]).unwrap_err().code, "badRequest");
    let twice = [change("package.json#version", "3.88.7", "1.0.0"), change("package.json#version", "3.88.7", "1.0.1")];
    assert_eq!(apply(d.path(), &twice).unwrap_err().code, "badRequest");
    assert_eq!(text(d.path(), "package.json"), PACKAGE);
}

#[test]
fn windows_line_endings_and_a_byte_order_mark_survive() {
    let d = tempfile::tempdir().unwrap();
    let crlf = "{\r\n  \"name\": \"x\",\r\n  \"version\": \"1.0.0\"\r\n}\r\n";
    write(d.path(), "package.json", &format!("\u{feff}{crlf}"));
    apply(d.path(), &[change("package.json#version", "1.0.0", "1.0.1")]).unwrap();
    assert_eq!(text(d.path(), "package.json"), format!("\u{feff}{}", crlf.replace("1.0.0", "1.0.1")));
}

#[test]
fn a_package_without_a_matching_lock_file_changes_alone() {
    let d = tempfile::tempdir().unwrap();
    write(d.path(), "package.json", PACKAGE);
    write(d.path(), "package-lock.json", &LOCK.replace("3.88.7", "3.80.0"));
    let s = scan(d.path());
    assert!(s.fields[0].companions.is_empty());
    assert_eq!(apply(d.path(), &[change("package.json#version", "3.88.7", "3.88.8")]).unwrap(), vec!["package.json"]);
}

#[test]
fn several_apps_in_one_repository_keep_their_own_fields() {
    let d = tempfile::tempdir().unwrap();
    write(d.path(), "package.json", PACKAGE);
    write(d.path(), "src-tauri/tauri.conf.json", "{\n  \"productName\": \"a\",\n  \"version\": \"0.5.0\"\n}\n");
    write(d.path(), "src-tauri/Cargo.toml", "[package]\nname = \"a\"\nversion = \"0.5.0\"\n");
    write(d.path(), "pubspec.yaml", "name: mobile\nversion: 2.1.0+9\n");
    let s = scan(d.path());
    let ids: Vec<&str> = s.fields.iter().map(|f| f.id.as_str()).collect();
    assert_eq!(ids, vec!["package.json#version", "pubspec.yaml#version", "pubspec.yaml#build", "src-tauri/Cargo.toml#package.version", "src-tauri/tauri.conf.json#version"]);
    apply(d.path(), &[change("pubspec.yaml#version", "2.1.0", "2.2.0"), change("pubspec.yaml#build", "9", "10")]).unwrap();
    assert_eq!(text(d.path(), "pubspec.yaml"), "name: mobile\nversion: 2.2.0+10\n");
}
