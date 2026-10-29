//! End-to-end checks on synthetic projects: every check has a case that breaks the healthy fixture in exactly one way.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use intely_mobilehealth::{detect, scan_with, Env, Project, Report, Severity, Status};

fn fixture_dir(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

fn copy(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type().unwrap().is_dir() {
            copy(&src, &dst);
        } else {
            fs::copy(&src, &dst).unwrap();
        }
    }
}

fn put(root: &Path, rel: &str, text: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn text(root: &Path, rel: &str) -> String {
    fs::read_to_string(root.join(rel)).unwrap()
}

/// Replaces every `from` in the file; the test fails if there is none (so a changed fixture cannot silently turn a case into a no-op).
fn ed(root: &Path, rel: &str, from: &str, to: &str) {
    let t = text(root, rel);
    assert!(t.contains(from), "{rel} has no {from:?}");
    put(root, rel, &t.replace(from, to));
}

fn ed1(root: &Path, rel: &str, from: &str, to: &str) {
    let t = text(root, rel);
    assert!(t.contains(from), "{rel} has no {from:?}");
    put(root, rel, &t.replacen(from, to, 1));
}

fn rm(root: &Path, rel: &str) {
    fs::remove_file(root.join(rel)).unwrap();
}

/// The healthy React Native project plus what Git would never hold: the debug keystore, local.properties and .xcode.env.
fn healthy() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    copy(&fixture_dir("rn_ok"), d.path());
    put(d.path(), "android/app/debug.keystore", "synthetic");
    put(d.path(), "android/local.properties", "sdk.dir=/opt/android-sdk\n");
    // not kept in the fixture folder: the tree-hygiene gate refuses any tracked file that looks like an env file
    put(d.path(), "ios/.xcode.env", "# synthetic\nexport NODE_BINARY=$(command -v node)\n");
    d
}

fn env() -> Env {
    Env { android_home: None }
}

fn project(root: &Path) -> Project {
    let r = scan_with(root, &env());
    assert!(r.detected, "nothing detected");
    r.projects.into_iter().next().unwrap()
}

fn ids(p: &Project) -> BTreeSet<&'static str> {
    p.findings.iter().map(|f| f.id).collect()
}

const PBX: &str = "ios/App.xcodeproj/project.pbxproj";
const APP_GRADLE: &str = "android/app/build.gradle";
const MANIFEST: &str = "android/app/src/main/AndroidManifest.xml";

type Mutate = fn(&Path);
struct Case {
    id: &'static str,
    severity: Severity,
    /// A part of the file the finding must point at.
    file: &'static str,
    mutate: Mutate,
}

macro_rules! case {
    ($id:expr, $sev:ident, $file:expr, $m:expr) => {
        Case { id: $id, severity: Severity::$sev, file: $file, mutate: $m }
    };
}

fn cases() -> Vec<Case> {
    vec![
        case!("ios.team.empty", Warn, "project.pbxproj", |r| ed(r, PBX, "DEVELOPMENT_TEAM = ABCDE12345;", "DEVELOPMENT_TEAM = \"\";")),
        case!("ios.signing.manualNoProfile", Warn, "project.pbxproj", |r| ed(r, PBX, "CODE_SIGN_STYLE = Automatic;", "CODE_SIGN_STYLE = Manual;")),
        case!("ios.signing.automaticWithProfile", Info, "project.pbxproj", |r| ed(r, PBX, "CODE_SIGN_STYLE = Automatic;", "CODE_SIGN_STYLE = Automatic;\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = \"Demo Profile\";")),
        case!("ios.bundleId.missing", Error, "project.pbxproj", |r| ed(r, PBX, "PRODUCT_BUNDLE_IDENTIFIER = \"com.acme.demo\";", "")),
        case!("ios.bundleId.placeholder", Warn, "project.pbxproj", |r| ed(r, PBX, "com.acme.demo", "org.reactjs.native.example.Demo")),
        case!("ios.bundleId.configsDiffer", Warn, "project.pbxproj", |r| ed1(r, PBX, "\"com.acme.demo\"", "\"com.acme.demo.dev\"")),
        case!("ios.bundleId.extensionPrefix", Error, "project.pbxproj", |r| ed(r, PBX, "\"com.apple.product-type.bundle.unit-test\"", "\"com.apple.product-type.app-extension\"")),
        case!("ios.version.marketingDiffer", Warn, "project.pbxproj", |r| ed1(r, PBX, "MARKETING_VERSION = 1.2.0;", "MARKETING_VERSION = 1.3.0;")),
        case!("ios.version.buildDiffer", Warn, "project.pbxproj", |r| ed1(r, PBX, "CURRENT_PROJECT_VERSION = 7;", "CURRENT_PROJECT_VERSION = 8;")),
        case!("ios.version.plistOverrides", Warn, "Info.plist", |r| ed(r, "ios/App/Info.plist", "<key>CFBundleShortVersionString</key>\n\t<string>$(MARKETING_VERSION)</string>", "<key>CFBundleShortVersionString</key>\n\t<string>9.9.9</string>")),
        case!("ios.deployment.inconsistent", Warn, "project.pbxproj", |r| ed1(r, PBX, "INFOPLIST_FILE = App/Info.plist;", "INFOPLIST_FILE = App/Info.plist;\n\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 12.0;")),
        case!("ios.deployment.mismatch", Warn, "Podfile", |r| ed(r, "ios/Podfile", "platform :ios, '13.4'", "platform :ios, '15.1'")),
        case!("ios.entitlements.fileMissing", Error, "project.pbxproj", |r| rm(r, "ios/App/App.entitlements")),
        case!("ios.permission.missing", Warn, "Info.plist", |r| ed(r, "ios/App/Info.plist", "<key>NSCameraUsageDescription</key>\n\t<string>Demo scans codes with the camera.</string>\n", "")),
        case!("ios.permission.emptyText", Warn, "Info.plist", |r| ed(r, "ios/App/Info.plist", "<string>Demo scans codes with the camera.</string>", "<string></string>")),
        case!("ios.push.entitlementMissing", Warn, "entitlements", |r| ed(r, "package.json", "\"react-native-vision-camera\": \"^4.0.0\"", "\"react-native-vision-camera\": \"^4.0.0\",\n    \"expo-notifications\": \"0.28.0\"")),
        case!("ios.pods.lockMissing", Warn, "Podfile", |r| rm(r, "ios/Podfile.lock")),
        case!("ios.pods.notInstalled", Warn, "Podfile", |r| rm(r, "ios/Pods/Manifest.lock")),
        case!("ios.pods.outOfSync", Error, "Podfile.lock", |r| put(r, "ios/Podfile.lock", "PODS:\n  - Something-Else (1.0)\n")),
        case!("ios.xcodeEnv.missing", Info, ".xcode.env", |r| rm(r, "ios/.xcode.env")),
        case!("ios.xcodeEnv.hardcodedNode", Warn, ".xcode.env", |r| put(r, "ios/.xcode.env", "export NODE_BINARY=/Users/someone/.nvm/versions/node/v20/bin/node\n")),
        case!("android.androidx.off", Warn, "gradle.properties", |r| ed(r, "android/gradle.properties", "android.useAndroidX=true", "android.useAndroidX=false")),
        case!("android.appId.invalid", Error, APP_GRADLE, |r| ed(r, APP_GRADLE, "applicationId \"com.acme.demo\"", "applicationId \"demo\"")),
        case!("android.appId.placeholder", Warn, APP_GRADLE, |r| ed(r, APP_GRADLE, "applicationId \"com.acme.demo\"", "applicationId \"com.example.demo\"")),
        case!("android.gradle.noWrapper", Warn, "wrapper", |r| rm(r, "android/gradle/wrapper/gradle-wrapper.properties")),
        case!("android.gradle.tooOld", Error, "gradle-wrapper.properties", |r| ed(r, "android/gradle/wrapper/gradle-wrapper.properties", "gradle-8.9-bin.zip", "gradle-8.0-bin.zip")),
        case!("android.gradle.unknownAgp", Info, "gradle-wrapper.properties", |r| ed(r, "android/build.gradle", "gradle:8.5.2", "gradle:12.1.0")),
        case!("android.keystore.notIgnored", Error, "release.jks", |r| {
            put(r, "android/app/release.jks", "synthetic");
            ed(r, ".gitignore", "*.jks\n", "");
        }),
        case!("android.manifest.cleartext", Warn, "AndroidManifest.xml", |r| ed(r, MANIFEST, "<application ", "<application android:usesCleartextTraffic=\"true\" ")),
        case!("android.manifest.debuggable", Error, "AndroidManifest.xml", |r| ed(r, MANIFEST, "<application ", "<application android:debuggable=\"true\" ")),
        case!("android.namespace.missing", Error, APP_GRADLE, |r| ed(r, APP_GRADLE, "    namespace \"com.acme.demo\"\n", "")),
        case!("android.permission.sensitive", Warn, "AndroidManifest.xml", |r| ed(r, MANIFEST, "<uses-permission android:name=\"android.permission.INTERNET\" />", "<uses-permission android:name=\"android.permission.INTERNET\" />\n    <uses-permission android:name=\"android.permission.READ_SMS\" />")),
        case!("android.permission.undeclared", Info, "AndroidManifest.xml", |r| ed(r, MANIFEST, "    <uses-permission android:name=\"android.permission.CAMERA\" />\n", "")),
        case!("android.permission.unused", Info, "AndroidManifest.xml", |r| ed(r, MANIFEST, "<uses-permission android:name=\"android.permission.INTERNET\" />", "<uses-permission android:name=\"android.permission.INTERNET\" />\n    <uses-permission android:name=\"android.permission.READ_CONTACTS\" />")),
        case!("android.sdk.compileMissing", Error, APP_GRADLE, |r| ed(r, APP_GRADLE, "    compileSdk rootProject.ext.compileSdkVersion\n", "")),
        case!("android.sdk.targetAboveCompile", Error, APP_GRADLE, |r| ed(r, "android/build.gradle", "compileSdkVersion = 36", "compileSdkVersion = 34")),
        case!("android.sdk.minAboveTarget", Error, APP_GRADLE, |r| ed(r, "android/build.gradle", "minSdkVersion = 24", "minSdkVersion = 40")),
        case!("android.sdk.targetMissing", Warn, APP_GRADLE, |r| ed(r, APP_GRADLE, "        targetSdkVersion rootProject.ext.targetSdkVersion\n", "")),
        case!("android.sdkDir.missing", Info, "local.properties", |r| rm(r, "android/local.properties")),
        case!("android.secrets.plaintext", Error, APP_GRADLE, |r| ed(r, APP_GRADLE, "storePassword System.getenv(\"DEMO_STORE_PASSWORD\")", "storePassword 'hunter2hunter2'")),
        case!("android.signing.absoluteKeystore", Warn, APP_GRADLE, |r| ed(r, APP_GRADLE, "file(System.getenv(\"DEMO_STORE_FILE\") ?: \"release.jks\")", "file(\"/Users/dev/keys/release.jks\")")),
        case!("android.signing.keystoreMissing", Error, APP_GRADLE, |r| rm(r, "android/app/debug.keystore")),
        case!("android.signing.releaseUsesDebug", Error, APP_GRADLE, |r| ed(r, APP_GRADLE, "signingConfig signingConfigs.release", "signingConfig signingConfigs.debug")),
        case!("android.version.codeInvalid", Error, APP_GRADLE, |r| ed(r, APP_GRADLE, "versionCode 7", "versionCode 0")),
        case!("android.version.missing", Info, APP_GRADLE, |r| {
            ed(r, APP_GRADLE, "        versionCode 7\n", "");
            ed(r, APP_GRADLE, "        versionName \"1.2.0\"\n", "");
        }),
        case!("cross.version.mismatch", Info, "", |r| ed(r, APP_GRADLE, "versionName \"1.2.0\"", "versionName \"1.3.0\"")),
        case!("cross.bundleId.mismatch", Info, "", |r| ed(r, APP_GRADLE, "applicationId \"com.acme.demo\"", "applicationId \"com.acme.demo2\"")),
        case!("cross.newArch.mismatch", Warn, "", |r| ed(r, "ios/Podfile", "prepare_react_native_project!", "ENV['RCT_NEW_ARCH_ENABLED'] = '1'\nprepare_react_native_project!")),
        case!("cross.hermes.mismatch", Info, "", |r| ed(r, "android/gradle.properties", "hermesEnabled=true", "hermesEnabled=false")),
        case!("env.notIgnored", Error, ".env.local", |r| {
            put(r, ".env.local", "API_KEY=synthetic-not-a-secret\n");
            ed(r, ".gitignore", ".env*\n!.env.example\n", "");
        }),
        case!("env.missing", Info, ".env.example", |r| {
            ed(r, "package.json", "\"react-native-vision-camera\": \"^4.0.0\"", "\"react-native-vision-camera\": \"^4.0.0\",\n    \"react-native-config\": \"1.5.0\"");
            put(r, ".env.example", "API_URL=\n");
        }),
        case!("expo.version.drift", Warn, "app.json", |r| put(r, "app.json", "{\n  \"expo\": {\n    \"name\": \"demo\",\n    \"version\": \"9.0.0\"\n  }\n}\n")),
        case!("expo.bundleId.drift", Warn, "app.json", |r| put(r, "app.json", "{\n  \"expo\": {\n    \"ios\": { \"bundleIdentifier\": \"com.other.app\" }\n  }\n}\n")),
        case!("expo.config.dynamic", Info, "app.config.js", |r| put(r, "app.config.js", "module.exports = {};\n")),
    ]
}

#[test]
fn the_healthy_project_has_no_errors_or_warnings() {
    let d = healthy();
    let p = project(d.path());
    let bad: Vec<_> = p.findings.iter().filter(|f| f.severity != Severity::Info).map(|f| f.id).collect();
    assert!(bad.is_empty(), "{bad:?}");
    assert!(p.ios && p.android && p.react_native && !p.expo);
    let fact = |k: &str| p.facts.iter().find(|f| f.key == k).map(|f| f.value.as_str());
    assert_eq!(fact("ios.version"), Some("1.2.0"));
    assert_eq!(fact("ios.build"), Some("7"));
    assert_eq!(fact("ios.bundleId"), Some("com.acme.demo"));
    assert_eq!(fact("ios.deployment"), Some("13.4"));
    assert_eq!(fact("android.versionName"), Some("1.2.0"));
    assert_eq!(fact("android.versionCode"), Some("7"));
    assert_eq!(fact("android.applicationId"), Some("com.acme.demo"));
    assert_eq!(fact("android.compileSdk"), Some("36"));
    assert_eq!(fact("android.minSdk"), Some("24"));
    assert_eq!(fact("android.agp"), Some("8.5.2"));
    assert_eq!(fact("android.gradle"), Some("8.9"));
    assert_eq!(fact("android.newArch"), Some("off"));
    assert_eq!(fact("ios.hermes"), Some("on"));
}

#[test]
fn every_check_fires_on_its_case_and_nowhere_else() {
    for c in cases() {
        let d = healthy();
        (c.mutate)(d.path());
        let p = project(d.path());
        let hits: Vec<_> = p.findings.iter().filter(|f| f.id == c.id).collect();
        assert!(!hits.is_empty(), "{}: not reported, got {:?}", c.id, ids(&p));
        let f = hits[0];
        assert_eq!(f.severity, c.severity, "{}: severity", c.id);
        assert!(f.file.as_deref().unwrap_or("").contains(c.file) || c.file.is_empty() || f.params.values().any(|v| v.contains(c.file)), "{}: file {:?}", c.id, f.file);
        assert!(f.prompt.len() > 40, "{}: prompt", c.id);
        let allowed: &[&str] = match c.id {
            // one change that is also seen from the other side
            "ios.bundleId.placeholder" | "cross.bundleId.mismatch" => &["cross.bundleId.mismatch", "ios.bundleId.placeholder"],
            "ios.version.marketingDiffer" => &["cross.version.mismatch"],
            "ios.push.entitlementMissing" => &["android.permission.undeclared"],
            _ => &[],
        };
        let extra: Vec<_> = ids(&p).into_iter().filter(|i| *i != c.id && !allowed.contains(i) && !i.starts_with("cross.")).collect();
        assert!(extra.is_empty(), "{}: also reported {extra:?}", c.id);
    }
}

#[test]
fn the_list_of_checks_matches_the_cases_the_registry_and_the_prompts() {
    let reg: serde_json::Value = serde_json::from_str(include_str!("../tables/checks.json")).unwrap();
    let registered: BTreeSet<String> = reg["findings"].as_array().unwrap().iter().map(|f| f["id"].as_str().unwrap().to_string()).collect();
    let tested: BTreeSet<String> = cases().iter().map(|c| c.id.to_string()).collect();
    assert_eq!(registered, tested, "checks.json and the cases differ");
    for f in reg["findings"].as_array().unwrap() {
        let id = f["id"].as_str().unwrap();
        let sev = cases().iter().find(|c| c.id == id).unwrap().severity;
        let want = match sev {
            Severity::Error => "error",
            Severity::Warn => "warn",
            Severity::Info => "info",
        };
        // the registry holds the most severe level a check can have; a case may show a milder one (a guess from a package name)
        let reg_sev = match f["severity"].as_str().unwrap() {
            "error" => Severity::Error,
            "warn" => Severity::Warn,
            _ => Severity::Info,
        };
        assert!(reg_sev <= sev, "{id}: {want} is more severe than checks.json says");
    }
}

#[test]
fn the_checklist_follows_the_files() {
    let status = |p: &Project, id: &str| p.checklist.iter().find(|c| c.id == id).map(|c| c.status);
    let d = healthy();
    let p = project(d.path());
    for id in ["ios.privacyManifest", "ios.icon", "ios.launchScreen", "android.icon", "android.targetApi"] {
        assert_eq!(status(&p, id), Some(Status::Ok), "{id}");
    }
    assert_eq!(status(&p, "ios.screenshots"), Some(Status::Check));
    assert_eq!(status(&p, "android.screenshots"), Some(Status::Check));

    type M = fn(&Path);
    let table: Vec<(&str, Status, M)> = vec![
        ("ios.privacyManifest", Status::Missing, |r| rm(r, "ios/App/PrivacyInfo.xcprivacy")),
        ("ios.icon", Status::Missing, |r| rm(r, "ios/App/Images.xcassets/AppIcon.appiconset/icon-1024.png")),
        ("ios.launchScreen", Status::Check, |r| rm(r, "ios/App/LaunchScreen.storyboard")),
        ("ios.screenshots", Status::Ok, |r| put(r, "fastlane/screenshots/en-US/1.png", "x")),
        ("android.icon", Status::Missing, |r| rm(r, "android/app/src/main/res/mipmap-hdpi/ic_launcher.png")),
        ("android.targetApi", Status::Missing, |r| ed(r, "android/build.gradle", "targetSdkVersion = 36", "targetSdkVersion = 30")),
        ("android.targetApi", Status::Check, |r| ed(r, APP_GRADLE, "        targetSdkVersion rootProject.ext.targetSdkVersion\n", "")),
        ("android.screenshots", Status::Ok, |r| put(r, "fastlane/metadata/android/en-US/images/phoneScreenshots/1.png", "x")),
    ];
    for (id, want, m) in table {
        let d = healthy();
        m(d.path());
        let p = project(d.path());
        assert_eq!(status(&p, id), Some(want), "{id}");
        let item = p.checklist.iter().find(|c| c.id == id).unwrap();
        assert_eq!(item.prompt.is_some(), want == Status::Missing || id == "ios.launchScreen", "{id}: prompt");
    }
    let reg: serde_json::Value = serde_json::from_str(include_str!("../tables/checks.json")).unwrap();
    let listed: BTreeSet<&str> = reg["checklist"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
    let seen: BTreeSet<&str> = p.checklist.iter().map(|c| c.id).collect();
    assert_eq!(listed, seen);
    // the table's date is shown, never hidden
    let target = p.checklist.iter().find(|c| c.id == "android.targetApi").unwrap();
    assert!(target.params.contains_key("reviewed") && target.params.contains_key("level"));
}

#[test]
fn single_platform_projects_are_scanned_for_that_platform_only() {
    let d = tempfile::tempdir().unwrap();
    copy(&fixture_dir("native_ios_only"), d.path());
    let p = project(d.path());
    assert!(p.ios && !p.android);
    let found = ids(&p);
    assert!(found.contains("ios.team.empty") && found.contains("ios.bundleId.placeholder"), "{found:?}");
    assert!(!found.iter().any(|i| i.starts_with("android.")));
    assert!(p.checklist.iter().all(|c| c.platform == "ios"));

    let d = tempfile::tempdir().unwrap();
    copy(&fixture_dir("native_android_only"), d.path());
    let p = project(d.path());
    assert!(p.android && !p.ios);
    let found = ids(&p);
    assert!(found.contains("android.gradle.noWrapper"), "{found:?}");
    assert!(!found.iter().any(|i| i.starts_with("ios.")));
    let fact = |k: &str| p.facts.iter().find(|f| f.key == k).map(|f| f.value.as_str());
    assert_eq!(fact("android.versionName"), Some("0.3.0"));
    assert_eq!(fact("android.agp"), Some("8.5.2"));
    assert_eq!(fact("android.targetSdk"), Some("34"));
}

#[test]
fn a_repository_without_mobile_projects_is_not_detected() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "package.json", "{}");
    put(d.path(), "src/index.js", "x");
    assert!(!detect(d.path()));
    assert!(!scan_with(d.path(), &env()).detected);
    let d = healthy();
    assert!(detect(d.path()));
}

#[test]
fn a_project_below_the_root_is_found_with_its_path() {
    let d = tempfile::tempdir().unwrap();
    copy(&fixture_dir("rn_ok"), &d.path().join("apps/mobile"));
    put(d.path(), "apps/mobile/android/app/debug.keystore", "x");
    let r: Report = scan_with(d.path(), &env());
    assert_eq!(r.projects.len(), 1);
    assert_eq!(r.projects[0].path, "apps/mobile");
    let f = r.projects[0].facts.iter().find(|f| f.key == "ios.version").unwrap();
    assert_eq!(f.file.as_deref(), Some("apps/mobile/ios/App.xcodeproj/project.pbxproj"));
}

#[test]
fn android_home_in_the_environment_settles_the_sdk_location() {
    let d = healthy();
    rm(d.path(), "android/local.properties");
    let with = scan_with(d.path(), &Env { android_home: Some("/sdk".into()) });
    assert!(!with.projects[0].findings.iter().any(|f| f.id == "android.sdkDir.missing"));
    put(d.path(), "android/local.properties", "# empty\n");
    let p = project(d.path());
    let f = p.findings.iter().find(|f| f.id == "android.sdkDir.missing").unwrap();
    assert_eq!(f.severity, Severity::Warn);
}

#[test]
fn a_secret_is_reported_by_name_and_never_by_value() {
    let d = healthy();
    ed(d.path(), APP_GRADLE, "keyPassword 'android'\n        }\n        release", "keyPassword 'android'\n        }\n        release");
    ed(d.path(), APP_GRADLE, "storePassword System.getenv(\"DEMO_STORE_PASSWORD\")", "storePassword 'S3cretValueOne'\n            keyPassword \"S3cretValueTwo\"");
    put(d.path(), "android/gradle.properties", "android.useAndroidX=true\nMYAPP_UPLOAD_STORE_PASSWORD=S3cretValueThree\nMYAPP_KEY_PASSWORD=*****\nSOME_API_TOKEN=\n");
    put(d.path(), ".env", "TOKEN=S3cretValueFour\n");
    let r = scan_with(d.path(), &env());
    let json = serde_json::to_string(&r).unwrap();
    for s in ["S3cretValue", "hunter2"] {
        assert!(!json.contains(s), "{s} leaked into the report");
    }
    let hits: Vec<_> = r.projects[0].findings.iter().filter(|f| f.id == "android.secrets.plaintext").collect();
    let keys: BTreeSet<&str> = hits.iter().map(|f| f.params["key"].as_str()).collect();
    assert_eq!(keys, BTreeSet::from(["storePassword", "keyPassword", "MYAPP_UPLOAD_STORE_PASSWORD"]));
    assert!(hits.iter().all(|f| f.severity == Severity::Error && f.prompt.contains("Do not print")));
    // the well-known debug password is not a secret
    assert!(!hits.iter().any(|f| f.params["place"] == "gradle" && f.line == Some(18)));
}

#[test]
fn comments_and_windows_line_endings_are_understood() {
    let d = healthy();
    let t = text(d.path(), APP_GRADLE).replace("versionCode 7", "// versionCode 99999999999\n        versionCode 7").replace('\n', "\r\n");
    put(d.path(), APP_GRADLE, &t);
    let p = project(d.path());
    assert!(ids(&p).iter().all(|i| p.findings.iter().find(|f| f.id == *i).unwrap().severity == Severity::Info));
    assert_eq!(p.facts.iter().find(|f| f.key == "android.versionCode").unwrap().value, "7");
    let line = p.facts.iter().find(|f| f.key == "android.versionCode").unwrap().line;
    assert_eq!(line, Some(12));
}

#[test]
fn expo_plugin_or_config_satisfies_a_permission_text() {
    let d = healthy();
    ed(d.path(), "ios/App/Info.plist", "<key>NSCameraUsageDescription</key>\n\t<string>Demo scans codes with the camera.</string>\n", "");
    assert!(ids(&project(d.path())).contains("ios.permission.missing"));
    put(d.path(), "app.json", "{\"expo\":{\"ios\":{\"infoPlist\":{\"NSCameraUsageDescription\":\"x\"}}}}");
    assert!(!ids(&project(d.path())).contains("ios.permission.missing"));
    put(d.path(), "app.json", "{\"expo\":{\"plugins\":[[\"react-native-vision-camera\",{}]]}}");
    assert!(!ids(&project(d.path())).contains("ios.permission.missing"));
}

#[test]
fn native_code_gives_high_confidence() {
    let d = healthy();
    ed(d.path(), "ios/App/Info.plist", "<key>NSCameraUsageDescription</key>\n\t<string>Demo scans codes with the camera.</string>\n", "");
    put(d.path(), "ios/App/Scanner.m", "AVCaptureSession *s = [AVCaptureSession new];\n");
    put(d.path(), "ios/App/Where.swift", "let m = CLLocationManager()\n");
    let p = project(d.path());
    let cam = p.findings.iter().find(|f| f.id == "ios.permission.missing" && f.params["permission"] == "camera").unwrap();
    assert_eq!(cam.severity, Severity::Error);
    assert!(format!("{:?}", cam.confidence).contains("High"));
    assert!(cam.params["evidence"].starts_with("native:ios/App/Scanner.m"));
    let loc = p.findings.iter().find(|f| f.id == "ios.permission.missing" && f.params["permission"] == "location").unwrap();
    assert_eq!(loc.params["key"], "NSLocationWhenInUseUsageDescription");
}

#[test]
fn the_report_serialises_for_the_app() {
    let d = healthy();
    ed(d.path(), PBX, "DEVELOPMENT_TEAM = ABCDE12345;", "DEVELOPMENT_TEAM = \"\";");
    let v = serde_json::to_value(scan_with(d.path(), &env())).unwrap();
    assert_eq!(v["detected"], true);
    let f = &v["projects"][0]["findings"][0];
    assert_eq!(f["id"], "ios.team.empty");
    assert_eq!(f["severity"], "warn");
    assert_eq!(f["platform"], "ios");
    assert!(f["line"].as_u64().unwrap() > 0 && f["file"].as_str().unwrap().ends_with("project.pbxproj"));
    assert!(v["data"]["compat"].as_str().unwrap().starts_with("20"));
    assert!(v["projects"][0]["checklist"][0]["status"].is_string());
}
