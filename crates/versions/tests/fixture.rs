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

#[cfg(unix)]
#[test]
fn a_planted_tmp_symlink_is_not_followed() {
    // A repository can hold a link named like the writer's temporary file; Git keeps links, so a clone brings it along.
    let d = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let victim = outside.path().join("victim");
    fs::write(&victim, "KEEP").unwrap();
    write(d.path(), "package.json", PACKAGE);
    std::os::unix::fs::symlink(&victim, d.path().join("package.json.intely-tmp")).unwrap();
    let r = apply(d.path(), &[change("package.json#version", "3.88.7", "3.88.8")]);
    assert_eq!(fs::read_to_string(&victim).unwrap(), "KEEP", "the writer followed a planted <name>.intely-tmp link out of the repository");
    assert!(r.is_ok());
    assert!(text(d.path(), "package.json").contains("\"version\": \"3.88.8\""));
    // and no temporary file is left behind
    assert!(fs::read_dir(d.path()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
}

#[cfg(unix)]
#[test]
fn a_version_file_that_is_a_link_is_refused() {
    let d = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let ext = outside.path().join("package.json");
    fs::write(&ext, PACKAGE).unwrap();
    write(d.path(), "package.json", PACKAGE);
    let before = scan(d.path());
    assert_eq!(before.fields.len(), 1);
    // the file is swapped for a link between the scan and the write
    fs::remove_file(d.path().join("package.json")).unwrap();
    std::os::unix::fs::symlink(&ext, d.path().join("package.json")).unwrap();
    let err = apply(d.path(), &[change("package.json#version", "3.88.7", "3.88.8")]).unwrap_err();
    assert!(matches!(err.code, "stale" | "notRegular"), "{err}");
    assert_eq!(fs::read_to_string(&ext).unwrap(), PACKAGE, "the file behind the link was written");
}

#[cfg(unix)]
#[test]
fn a_symlinked_lock_file_is_neither_read_nor_replaced() {
    let d = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let ext = outside.path().join("ext.json");
    fs::write(&ext, LOCK).unwrap();
    write(d.path(), "package.json", PACKAGE);
    std::os::unix::fs::symlink(&ext, d.path().join("package-lock.json")).unwrap();
    assert!(scan(d.path()).fields[0].companions.is_empty());
    assert_eq!(apply(d.path(), &[change("package.json#version", "3.88.7", "3.88.8")]).unwrap(), vec!["package.json"]);
    assert!(fs::symlink_metadata(d.path().join("package-lock.json")).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_to_string(&ext).unwrap(), LOCK);
}

#[test]
fn a_lock_file_over_the_cap_is_left_alone() {
    let d = tempfile::tempdir().unwrap();
    write(d.path(), "package.json", PACKAGE);
    let f = fs::File::create(d.path().join("package-lock.json")).unwrap();
    f.set_len(65 * 1024 * 1024).unwrap();
    assert!(scan(d.path()).fields[0].companions.is_empty());
    assert_eq!(apply(d.path(), &[change("package.json#version", "3.88.7", "3.88.8")]).unwrap(), vec!["package.json"]);
}

#[test]
fn a_damaged_plist_is_not_changed_beyond_its_version() {
    // the first value never closes: its text would swallow the next key, so it is not a place to write
    let d = tempfile::tempdir().unwrap();
    let broken = "<plist version=\"1.0\">\n<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>2.0.1\n\t<key>CFBundleVersion</key>\n\t<string>17</string>\n</dict>\n</plist>\n";
    write(d.path(), "ios/Widget/Info.plist", broken);
    let s = scan(d.path());
    assert_eq!(s.fields.len(), 1, "{:?}", s.fields);
    assert_eq!(s.fields[0].key, "CFBundleVersion");
    apply(d.path(), &[change("ios/Widget/Info.plist#CFBundleVersion", "17", "18")]).unwrap();
    assert_eq!(text(d.path(), "ios/Widget/Info.plist"), broken.replace("<string>17</string>", "<string>18</string>"));
}

fn package(root: &Path, json: &str) {
    write(root, "package.json", json);
}

fn only(root: &Path) -> intely_versions::Field {
    scan(root).fields.into_iter().find(|f| f.id == "package.json#version").expect("version field")
}

#[test]
fn a_bare_number_takes_a_number_and_nothing_else() {
    let d = tempfile::tempdir().unwrap();
    package(d.path(), "{ \"version\": 1.5 }\n");
    let f = only(d.path());
    assert!(f.numeric);
    for bad in ["1.5.1", "2-beta", "01.5", "1e3", "+1", "", " 2"] {
        let e = plan(d.path(), &[change(&f.id, "1.5", bad)]).unwrap_err();
        assert!(e.code == "badValue", "{bad}: {}", e.code);
    }
    apply(d.path(), &[change(&f.id, "1.5", "2.25")]).unwrap();
    assert_eq!(text(d.path(), "package.json"), "{ \"version\": 2.25 }\n");
}

#[test]
fn a_quoted_version_takes_the_usual_characters_and_a_plus_only_where_the_file_can_hold_it() {
    let d = tempfile::tempdir().unwrap();
    package(d.path(), "{ \"version\": \"1.0.0\" }\n");
    let f = only(d.path());
    assert!(!f.numeric);
    apply(d.path(), &[change(&f.id, "1.0.0", "1.0.1-rc.1+build.7")]).unwrap();
    // a bare Xcode value stops at `+`
    write(d.path(), "ios/App.xcodeproj/project.pbxproj", PBXPROJ);
    let id = "ios/App.xcodeproj/project.pbxproj#MARKETING_VERSION";
    assert!(plan(d.path(), &[change(id, "1.2.3", "1.2.4+9")]).is_err());
    assert!(plan(d.path(), &[change(id, "1.2.3", "1.2.4")]).is_ok());
}

#[test]
fn a_build_number_has_no_leading_zero() {
    let d = tempfile::tempdir().unwrap();
    write(d.path(), "android/app/build.gradle", GRADLE);
    let id = "android/app/build.gradle#versionCode";
    for bad in ["007", "01", "1.4", "", "x"] {
        assert!(plan(d.path(), &[change(id, "12", bad)]).is_err(), "{bad}");
    }
    apply(d.path(), &[change(id, "12", "0")]).unwrap();
    assert!(text(d.path(), "android/app/build.gradle").contains("versionCode 0\n"));
}

#[test]
fn a_value_that_is_a_variable_a_tag_or_huge_is_not_listed() {
    let d = tempfile::tempdir().unwrap();
    let huge = "9".repeat(5000);
    write(d.path(), "android/app/build.gradle", &format!("android {{\n    defaultConfig {{\n        versionCode 12\n        versionName \"{huge}\"\n    }}\n}}\n"));
    write(d.path(), "ios/Widget/Info.plist", "<plist><dict>\n<key>CFBundleShortVersionString</key>\n<string>$(X)</string>\n<key>CFBundleVersion</key>\n<string><b>2</b></string>\n</dict></plist>\n");
    let s = scan(d.path());
    let ids: Vec<&str> = s.fields.iter().map(|f| f.id.as_str()).collect();
    assert_eq!(ids, vec!["android/app/build.gradle#versionCode"], "{ids:?}");
}

#[test]
fn a_string_with_a_raw_line_break_is_a_damaged_file_and_is_left_alone() {
    let d = tempfile::tempdir().unwrap();
    package(d.path(), "{ \"version\": \"1.0\n.0\" }\n");
    assert!(scan(d.path()).fields.iter().all(|f| f.path != "package.json"));
}

#[test]
fn a_utf8_byte_order_mark_does_not_hide_the_first_line() {
    let d = tempfile::tempdir().unwrap();
    write(d.path(), "android/app/build.gradle", &["\u{feff}", GRADLE].concat());
    // the first line of a gradle file is not what carries the versions, so put one there too
    write(d.path(), "app/build.gradle", "\u{feff}versionCode 3\n");
    let s = scan(d.path());
    assert!(s.fields.iter().any(|f| f.id == "app/build.gradle#versionCode" && f.value == "3"), "{:?}", s.fields.iter().map(|f| &f.id).collect::<Vec<_>>());
    apply(d.path(), &[change("app/build.gradle#versionCode", "3", "4")]).unwrap();
    assert_eq!(text(d.path(), "app/build.gradle"), "\u{feff}versionCode 4\n");
}

#[cfg(unix)]
#[test]
fn a_read_only_file_is_refused_and_nothing_is_written() {
    use std::os::unix::fs::PermissionsExt;
    let d = repo();
    let ro = d.path().join("android/app/build.gradle");
    fs::set_permissions(&ro, fs::Permissions::from_mode(0o444)).unwrap();
    // a root user can write anywhere; the refusal is about the mode bits, which are what the person set on purpose
    let r = apply(d.path(), &[change("package.json#version", "3.88.7", "3.88.8"), change("android/app/build.gradle#versionName", "1.4.0", "1.4.1")]);
    fs::set_permissions(&ro, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(r.unwrap_err().code, "readOnly");
    assert_eq!(text(d.path(), "package.json"), PACKAGE);
    assert_eq!(text(d.path(), "package-lock.json"), LOCK);
}

#[test]
fn several_places_in_a_big_file_are_written_in_one_pass_and_keep_every_other_byte() {
    let d = tempfile::tempdir().unwrap();
    let mut body = String::from("// !$*UTF8*$!\n{\n\tobjects = {\n");
    for i in 0..3000 {
        body.push_str(&format!("\t\tT{i} = {{\n\t\t\tbuildSettings = {{\n\t\t\t\tMARKETING_VERSION = 1.2.3;\n\t\t\t}};\n\t\t}};\n"));
    }
    body.push_str("\t};\n}\n");
    write(d.path(), "ios/App.xcodeproj/project.pbxproj", &body);
    let id = "ios/App.xcodeproj/project.pbxproj#MARKETING_VERSION";
    let f = scan(d.path()).fields.into_iter().find(|f| f.id == id).unwrap();
    assert_eq!(f.occurrences, 3000);
    apply(d.path(), &[change(id, "1.2.3", "1.2.4")]).unwrap();
    assert_eq!(text(d.path(), "ios/App.xcodeproj/project.pbxproj"), body.replace("1.2.3", "1.2.4"));
}

/// A process beside the app swaps a folder of the repository for a link to somewhere else while Apply runs. The write goes into the
/// folder that was checked (it is held open), never through the link, so the other folder is never touched.
#[cfg(unix)]
#[test]
fn a_folder_swapped_for_a_link_while_writing_never_lets_a_write_leave_the_repository() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    let d = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    const OUT: &str = "{ \"version\": \"9.9.9\" }\n";
    write(outside.path(), "package.json", OUT);
    write(d.path(), "app/package.json", "{ \"version\": \"1.0.0\" }\n");
    let root = d.path().to_path_buf();
    let out = outside.path().to_path_buf();
    let stop = Arc::new(AtomicBool::new(false));
    let swapper = {
        let (root, stop) = (root.clone(), stop.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                // app -> app.real, app becomes a link out; then back
                if fs::rename(root.join("app"), root.join("app.real")).is_ok() {
                    let _ = std::os::unix::fs::symlink(&out, root.join("app"));
                    std::thread::yield_now();
                    let _ = fs::remove_file(root.join("app"));
                    let _ = fs::rename(root.join("app.real"), root.join("app"));
                }
            }
        })
    };
    let start = Instant::now();
    let mut wrote = 0u32;
    let mut turn = 0u32;
    while start.elapsed() < Duration::from_millis(1500) {
        let from = format!("1.0.{turn}");
        let to = format!("1.0.{}", turn + 1);
        if apply(&root, &[change("app/package.json#version", &from, &to)]).is_ok() {
            wrote += 1;
            turn += 1;
        } else if let Some(now) = scan(&root).fields.iter().find(|f| f.id == "app/package.json#version") {
            // a refused or interrupted round: carry on from whatever the file holds now
            turn = now.value.rsplit('.').next().and_then(|n| n.parse().ok()).unwrap_or(turn);
        }
    }
    stop.store(true, Ordering::Relaxed);
    swapper.join().unwrap();
    assert!(wrote > 0, "no write got through at all");
    assert_eq!(text(outside.path(), "package.json"), OUT);
    let strays: Vec<String> = fs::read_dir(outside.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n != "package.json").collect();
    assert!(strays.is_empty(), "files left outside the repository: {strays:?}");
}
