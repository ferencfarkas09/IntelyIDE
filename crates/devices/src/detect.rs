//! Project detection: is this repository a React Native or Expo app, and what does it look like. Reads `package.json`,
//! `app.json`, `ios/Podfile.lock`, `android/gradle.properties` and a few other small files (each capped), follows no
//! symbolic link out of the repository and never opens `.env*`.

use std::path::{Path, PathBuf};

use crate::parse::clean;
use crate::types::{PodsState, ProjectInfo, ProjectKind};

const MAX_FILE: u64 = 2 * 1024 * 1024;

fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&read_text(path)?).ok()
}

fn is_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
}

fn dep(pkg: &serde_json::Value, name: &str) -> Option<String> {
    ["dependencies", "devDependencies", "peerDependencies"].iter().find_map(|k| pkg.get(k)?.get(name)?.as_str().map(str::to_owned))
}

/// `^0.76.5` -> `0.76.5`; a range such as `>=0.7 <1` is kept as written (capped).
fn version_of(spec: &str) -> String {
    clean(spec.trim().trim_start_matches(['^', '~', '=', 'v']), 40)
}

fn installed_version(root: &Path, name: &str) -> Option<String> {
    let json = read_json(&root.join("node_modules").join(name).join("package.json"))?;
    let v = json.get("version")?.as_str()?;
    Some(clean(v, 40))
}

/// `(major, minor)` of a version string; `None` for a tag such as `latest` or `workspace:*`.
pub fn major_minor(v: &str) -> Option<(u32, u32)> {
    let mut parts = v.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty());
    let first_char = v.chars().next()?;
    if !first_char.is_ascii_digit() {
        return None;
    }
    Some((parts.next()?.parse().ok()?, parts.next().and_then(|p| p.parse().ok()).unwrap_or(0)))
}

fn properties_flag(text: &str, key: &str) -> Option<bool> {
    text.lines().filter_map(|l| l.trim().split_once('=')).find(|(k, _)| k.trim() == key).and_then(|(_, v)| match v.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    })
}

fn package_manager(root: &Path) -> String {
    for (file, pm) in [("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lockb", "bun"), ("bun.lock", "bun")] {
        if root.join(file).is_file() {
            return pm.to_owned();
        }
    }
    "npm".to_owned()
}

fn pods(root: &Path, has_ios: bool) -> PodsState {
    if !has_ios {
        return PodsState::NotApplicable;
    }
    let manifest = read_text(&root.join("ios/Pods/Manifest.lock"));
    let Some(manifest) = manifest else { return PodsState::Missing };
    match read_text(&root.join("ios/Podfile.lock")) {
        Some(lock) if lock != manifest => PodsState::Stale,
        _ => PodsState::Installed,
    }
}

/// The Android SDK the tools are taken from: the environment and the usual install places, nothing the repository says. A
/// directory only counts when it holds `platform-tools` or `emulator`. The project's own `local.properties` is NOT used
/// here: a repository could point `sdk.dir` at a folder of its own, and `adb` and `emulator` from there would be run.
pub fn android_sdk(home: Option<&Path>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = ["ANDROID_HOME", "ANDROID_SDK_ROOT"].iter().filter_map(std::env::var_os).map(PathBuf::from).collect();
    if let Some(h) = home {
        candidates.push(h.join("Library/Android/sdk"));
        candidates.push(h.join("Android/Sdk"));
        candidates.push(h.join("AppData/Local/Android/Sdk"));
    }
    candidates.into_iter().find(|d| has_sdk_parts(d))
}

fn has_sdk_parts(d: &Path) -> bool {
    d.is_absolute() && (is_dir(&d.join("platform-tools")) || is_dir(&d.join("emulator")))
}

/// What the status card shows: the trusted SDK, else the `sdk.dir` of `android/local.properties` (shown, never run).
fn android_sdk_display(root: &Path, home: Option<&Path>) -> Option<PathBuf> {
    android_sdk(home).or_else(|| {
        let text = read_text(&root.join("android/local.properties"))?;
        let dir = text.lines().filter_map(|l| l.split_once('=')).find(|(k, _)| k.trim() == "sdk.dir").map(|(_, v)| v.trim().replace("\\:", ":").replace("\\\\", "\\"))?;
        Some(PathBuf::from(dir)).filter(|d| has_sdk_parts(d))
    })
}

fn script_names(pkg: &serde_json::Value) -> Vec<(String, String)> {
    pkg.get("scripts").and_then(|s| s.as_object()).map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned()))).collect()).unwrap_or_default()
}

/// The first script (preferring `prefer` names, in order) whose body contains one of `needles`.
fn find_script(scripts: &[(String, String)], prefer: &[&str], needles: &[&str]) -> Option<String> {
    let hit = |body: &str| {
        let b = body.to_ascii_lowercase();
        needles.iter().any(|n| b.contains(n))
    };
    prefer
        .iter()
        .find_map(|p| scripts.iter().find(|(k, body)| k == p && hit(body)))
        .or_else(|| scripts.iter().find(|(k, body)| !k.starts_with('-') && !k.starts_with("pre") && !k.starts_with("post") && hit(body)))
        .map(|(k, _)| k.clone())
}

/// A name the Xcode project, the log predicate and the UI can show safely.
fn process_name(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty() && s.len() <= 60 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b' '))).then(|| s.to_owned())
}

fn ios_process(root: &Path, expo_app: bool, has_ios: bool) -> Option<String> {
    if has_ios {
        if let Ok(rd) = std::fs::read_dir(root.join("ios")) {
            let mut names: Vec<String> = rd.filter_map(Result::ok).filter_map(|e| e.file_name().into_string().ok()).filter_map(|n| n.strip_suffix(".xcodeproj").map(str::to_owned)).collect();
            names.sort();
            if let Some(n) = names.into_iter().find_map(|n| process_name(&n)) {
                return Some(n);
            }
        }
    }
    expo_app.then(|| "Expo Go".to_owned())
}

/// `Some` when the folder is a React Native or Expo app: `package.json` depends on `react-native` or `expo`, and there is
/// an `ios/` or `android/` folder or an `app.json` / `app.config.*`.
pub fn detect(root: &Path) -> Option<ProjectInfo> {
    detect_with_home(root, intely_core::sys::home_dir().as_deref())
}

pub fn detect_with_home(root: &Path, home: Option<&Path>) -> Option<ProjectInfo> {
    let pkg = read_json(&root.join("package.json"))?;
    let rn_spec = dep(&pkg, "react-native");
    let expo_spec = dep(&pkg, "expo");
    if rn_spec.is_none() && expo_spec.is_none() {
        return None;
    }
    let has_ios = is_dir(&root.join("ios"));
    let has_android = is_dir(&root.join("android"));
    let app_json = read_json(&root.join("app.json"));
    let has_config = app_json.is_some() || ["app.config.js", "app.config.ts", "app.config.json"].iter().any(|f| root.join(f).is_file());
    if !has_ios && !has_android && !has_config {
        return None;
    }
    let expo_cfg = app_json.as_ref().and_then(|j| j.get("expo")).cloned().or(app_json.clone());
    let kind = if expo_spec.is_some() { ProjectKind::Expo } else { ProjectKind::ReactNative };
    let name = expo_cfg
        .as_ref()
        .and_then(|c| c.get("name").or_else(|| c.get("displayName")))
        .and_then(|v| v.as_str())
        .or_else(|| pkg.get("name").and_then(|v| v.as_str()))
        .map(|n| clean(n, 60))
        .unwrap_or_else(|| root.file_name().map(|n| clean(&n.to_string_lossy(), 60)).unwrap_or_default());
    let rn_version = installed_version(root, "react-native").or_else(|| rn_spec.as_deref().map(version_of));
    let expo_version = expo_spec.as_ref().map(|s| installed_version(root, "expo").unwrap_or_else(|| version_of(s)));
    let rn_mm = rn_version.as_deref().and_then(major_minor);

    let gradle = read_text(&root.join("android/gradle.properties")).unwrap_or_default();
    let podprops = read_json(&root.join("ios/Podfile.properties.json"));
    let new_arch = properties_flag(&gradle, "newArchEnabled")
        .or_else(|| podprops.as_ref().and_then(|p| p.get("newArchEnabled")).and_then(|v| v.as_str().map(|s| s == "true").or_else(|| v.as_bool())))
        .or_else(|| expo_cfg.as_ref().and_then(|c| c.get("newArchEnabled")).and_then(|v| v.as_bool()))
        .or_else(|| rn_mm.map(|(maj, min)| maj > 0 || min >= 76));
    let hermes = properties_flag(&gradle, "hermesEnabled")
        .or_else(|| expo_cfg.as_ref().and_then(|c| c.get("jsEngine")).and_then(|v| v.as_str()).map(|e| e == "hermes"))
        .or_else(|| podprops.as_ref().and_then(|p| p.get("expo.jsEngine")).and_then(|v| v.as_str()).map(|e| e == "hermes"))
        .or_else(|| rn_mm.map(|(maj, min)| maj > 0 || min >= 70));

    let scripts = script_names(&pkg);
    let metro_script = find_script(&scripts, &["start", "dev"], &["expo start", "react-native start", "rnc-cli start", "react-native-community/cli start"]);
    let ios_script = find_script(&scripts, &["ios"], &["run:ios", "run-ios"]);
    let android_script = find_script(&scripts, &["android"], &["run:android", "run-android"]);
    let mut notes = Vec::new();
    if metro_script.is_none() {
        notes.push("noMetroScript".to_owned());
    }
    Some(ProjectInfo {
        kind,
        name,
        rn_version,
        expo_version,
        new_arch,
        hermes,
        package_manager: package_manager(root),
        has_ios,
        has_android,
        pods: pods(root, has_ios),
        android_sdk: android_sdk_display(root, home).map(|p| p.to_string_lossy().into_owned()),
        metro_script,
        ios_script,
        android_script,
        ios_process: ios_process(root, expo_spec.is_some(), has_ios),
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PodsState;

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn expo(dir: &Path) {
        write(dir, "package.json", r#"{"name":"mine","scripts":{"start":"expo start","ios":"expo run:ios","android":"expo run:android","build":"eas build"},"dependencies":{"expo":"~52.0.1","react-native":"0.76.3"}}"#);
        write(dir, "app.json", r#"{"expo":{"name":"My App","newArchEnabled":false,"jsEngine":"jsc"}}"#);
    }

    #[test]
    fn an_expo_app_without_native_folders_is_detected_by_its_app_json() {
        let d = tempfile::tempdir().unwrap();
        expo(d.path());
        let p = detect_with_home(d.path(), None).unwrap();
        assert_eq!((p.kind, p.name.as_str()), (ProjectKind::Expo, "My App"));
        assert_eq!(p.rn_version.as_deref(), Some("0.76.3"));
        assert_eq!(p.expo_version.as_deref(), Some("52.0.1"));
        assert_eq!((p.new_arch, p.hermes), (Some(false), Some(false)), "app.json decides over the defaults of 0.76");
        assert_eq!((p.metro_script.as_deref(), p.ios_script.as_deref(), p.android_script.as_deref()), (Some("start"), Some("ios"), Some("android")));
        assert_eq!((p.has_ios, p.pods, p.package_manager.as_str()), (false, PodsState::NotApplicable, "npm"));
        assert_eq!(p.ios_process.as_deref(), Some("Expo Go"));
    }

    #[test]
    fn a_bare_react_native_app_reads_the_native_folders() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "package.json", r#"{"scripts":{"start":"react-native start","ios":"react-native run-ios","android":"react-native run-android"},"dependencies":{"react-native":"^0.72.4"}}"#);
        write(r, "pnpm-lock.yaml", "");
        write(r, "ios/HelloApp.xcodeproj/project.pbxproj", "");
        write(r, "ios/Podfile.lock", "PODS: a");
        write(r, "ios/Pods/Manifest.lock", "PODS: a");
        write(r, "android/gradle.properties", "org.gradle.jvmargs=-Xmx2g\nnewArchEnabled=true\nhermesEnabled=false\n");
        let sdk = d.path().join("home/Library/Android/sdk/platform-tools");
        std::fs::create_dir_all(&sdk).unwrap();
        // A repository that points sdk.dir into itself is shown at most, and never used to find tools.
        let planted = d.path().join("planted");
        std::fs::create_dir_all(planted.join("platform-tools")).unwrap();
        write(r, "android/local.properties", &format!("sdk.dir={}\n", planted.display()));
        assert_eq!(android_sdk(Some(&d.path().join("nowhere"))).filter(|p| p.starts_with(&planted)), None);
        let p = detect_with_home(r, Some(&d.path().join("home"))).unwrap();
        assert_eq!(p.kind, ProjectKind::ReactNative);
        assert_eq!((p.new_arch, p.hermes), (Some(true), Some(false)));
        assert_eq!((p.package_manager.as_str(), p.pods, p.ios_process.as_deref()), ("pnpm", PodsState::Installed, Some("HelloApp")));
        assert!(p.android_sdk.is_some_and(|s| s.ends_with("Android/sdk")) || std::env::var_os("ANDROID_HOME").is_some());
        assert!(p.notes.is_empty());
        // Pods out of date, then gone.
        write(r, "ios/Podfile.lock", "PODS: b");
        assert_eq!(detect_with_home(r, None).unwrap().pods, PodsState::Stale);
        std::fs::remove_dir_all(r.join("ios/Pods")).unwrap();
        assert_eq!(detect_with_home(r, None).unwrap().pods, PodsState::Missing);
    }

    #[test]
    fn defaults_follow_the_react_native_version_when_nothing_is_configured() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"dependencies":{"react-native":"0.64.0"}}"#);
        write(d.path(), "android/build.gradle", "");
        let p = detect_with_home(d.path(), None).unwrap();
        assert_eq!((p.new_arch, p.hermes), (Some(false), Some(false)));
        write(d.path(), "package.json", r#"{"dependencies":{"react-native":"latest"}}"#);
        let p = detect_with_home(d.path(), None).unwrap();
        assert_eq!((p.new_arch, p.hermes), (None, None), "a tag says nothing");
    }

    #[test]
    fn what_is_not_a_react_native_project_is_not_detected() {
        let d = tempfile::tempdir().unwrap();
        assert!(detect_with_home(d.path(), None).is_none(), "no package.json");
        write(d.path(), "package.json", r#"{"dependencies":{"react":"18"}}"#);
        write(d.path(), "ios/x", "");
        assert!(detect_with_home(d.path(), None).is_none(), "react alone");
        write(d.path(), "package.json", r#"{"dependencies":{"react-native":"0.76.0"}}"#);
        std::fs::remove_dir_all(d.path().join("ios")).unwrap();
        assert!(detect_with_home(d.path(), None).is_none(), "the dependency without ios/, android/ or app.json");
        write(d.path(), "package.json", "{not json");
        assert!(detect_with_home(d.path(), None).is_none());
    }

    #[test]
    fn hostile_files_are_tolerated() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", &format!(r#"{{"name":"{}","scripts":{{"start":["x"],"-rf":"expo start","ios":5}},"dependencies":{{"expo":{{}},"react-native":"\u001b[31m^1"}}}}"#, "n".repeat(500)));
        write(d.path(), "app.json", "[1,2,3]");
        write(d.path(), "ios/Podfile.properties.json", "\u{0}\u{0}");
        let p = detect_with_home(d.path(), None).unwrap();
        assert!(p.name.chars().count() <= 60 && !p.rn_version.unwrap_or_default().contains('\u{1b}'));
        assert_eq!(p.metro_script.as_deref(), None, "a script named like a flag is never offered");
        assert!(p.notes.contains(&"noMetroScript".to_owned()));
    }

    #[test]
    fn the_xcode_project_name_must_be_safe_for_a_predicate() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"dependencies":{"react-native":"0.76.0"}}"#);
        write(d.path(), "ios/a\"b.xcodeproj/x", "");
        assert_eq!(detect_with_home(d.path(), None).unwrap().ios_process, None);
    }

    #[test]
    fn version_parsing() {
        assert_eq!(major_minor("0.76.3"), Some((0, 76)));
        assert_eq!(major_minor("52"), Some((52, 0)));
        for bad in ["", "latest", "workspace:*", "^1.2"] {
            assert_eq!(major_minor(bad), None, "{bad}");
        }
    }
}
