//! Project detection: is this repository a React Native or Expo app, and what does it look like. Reads `package.json`,
//! `app.json`, `ios/Podfile.lock`, `android/gradle.properties` and a few other small files (each capped). A path is read only
//! when it still lies inside the repository after every link on the way is resolved (see `resolve`), and `.env*` is never opened.

use std::path::{Path, PathBuf};

use crate::parse::clean;
use crate::types::{PodsState, ProjectInfo, ProjectKind};

const MAX_FILE: u64 = 2 * 1024 * 1024;

/// `rel` under `root`, with every link on the way resolved, when the result is still inside `root`: a link that leaves the
/// repository (`android -> /elsewhere`, `node_modules -> ~/x`) is not followed, one that stays inside (pnpm's
/// `node_modules/react-native`) is.
fn resolve(root: &Path, rel: &str) -> Option<PathBuf> {
    let target = root.join(rel).canonicalize().ok()?;
    target.starts_with(root.canonicalize().ok()?).then_some(target)
}

fn read_text(root: &Path, rel: &str) -> Option<String> {
    let path = resolve(root, rel)?;
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn read_json(root: &Path, rel: &str) -> Option<serde_json::Value> {
    serde_json::from_str(&read_text(root, rel)?).ok()
}

fn is_dir(root: &Path, rel: &str) -> bool {
    resolve(root, rel).is_some_and(|p| p.is_dir())
}

/// A folder of the user's own machine (an SDK), not of the repository.
fn dir_exists(path: &Path) -> bool {
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
    let json = read_json(root, &format!("node_modules/{name}/package.json"))?;
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
    let manifest = read_text(root, "ios/Pods/Manifest.lock");
    let Some(manifest) = manifest else { return PodsState::Missing };
    match read_text(root, "ios/Podfile.lock") {
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
    d.is_absolute() && (dir_exists(&d.join("platform-tools")) || dir_exists(&d.join("emulator")))
}

/// What the status card shows: the trusted SDK, else the `sdk.dir` of `android/local.properties` (shown, never run).
fn android_sdk_display(root: &Path, home: Option<&Path>) -> Option<PathBuf> {
    android_sdk(home).or_else(|| {
        let text = read_text(root, "android/local.properties")?;
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
        if let Some(rd) = resolve(root, "ios").and_then(|d| std::fs::read_dir(d).ok()) {
            let mut names: Vec<String> = rd.filter_map(Result::ok).filter_map(|e| e.file_name().into_string().ok()).filter_map(|n| n.strip_suffix(".xcodeproj").map(str::to_owned)).collect();
            names.sort();
            if let Some(n) = names.into_iter().find_map(|n| process_name(&n)) {
                return Some(n);
            }
        }
    }
    expo_app.then(|| "Expo Go".to_owned())
}

/// The ports Metro may legitimately listen on: the defaults (8081, and 19000 of older Expo), the `--port` / `-p` of the start
/// script, a `RCT_METRO_PORT` set in the script or in `env_port`. Only the project's own files and the user's environment are
/// read, never the output of the running script.
pub fn metro_ports(root: &Path, script: &str, env_port: Option<&str>) -> Vec<u16> {
    let mut ports: Vec<u16> = vec![8081, 19000];
    let mut add = |text: &str| {
        if let Ok(p) = text.trim().parse::<u32>() {
            if (1024..=65535).contains(&p) && !ports.contains(&(p as u16)) {
                ports.push(p as u16);
            }
        }
    };
    if let Some(p) = env_port {
        add(p);
    }
    let body = read_json(root, "package.json").and_then(|j| j.get("scripts")?.get(script)?.as_str().map(str::to_owned));
    if let Some(body) = body {
        let toks: Vec<&str> = body.split_whitespace().collect();
        for (i, t) in toks.iter().enumerate() {
            if let Some(v) = t.strip_prefix("--port=").or_else(|| t.strip_prefix("RCT_METRO_PORT=")) {
                add(v);
            } else if matches!(*t, "--port" | "-p") {
                if let Some(v) = toks.get(i + 1) {
                    add(v);
                }
            }
        }
    }
    ports
}

/// `Some` when the folder is a React Native or Expo app: `package.json` depends on `react-native` or `expo`, and there is
/// an `ios/` or `android/` folder or an `app.json` / `app.config.*`.
pub fn detect(root: &Path) -> Option<ProjectInfo> {
    detect_with_home(root, intely_core::sys::home_dir().as_deref())
}

pub fn detect_with_home(root: &Path, home: Option<&Path>) -> Option<ProjectInfo> {
    let pkg = read_json(root, "package.json")?;
    let rn_spec = dep(&pkg, "react-native");
    let expo_spec = dep(&pkg, "expo");
    if rn_spec.is_none() && expo_spec.is_none() {
        return None;
    }
    let has_ios = is_dir(root, "ios");
    let has_android = is_dir(root, "android");
    let app_json = read_json(root, "app.json");
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

    let gradle = read_text(root, "android/gradle.properties").unwrap_or_default();
    let podprops = read_json(root, "ios/Podfile.properties.json");
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

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_out_of_the_repository_is_not_followed() {
        let d = tempfile::tempdir().unwrap();
        let (repo, outside) = (d.path().join("repo"), d.path().join("outside"));
        write(&repo, "package.json", r#"{"dependencies":{"react-native":"0.76.0"}}"#);
        write(&outside, "gradle.properties", "newArchEnabled=false\nhermesEnabled=false\n");
        write(&outside, "node_modules/react-native/package.json", r#"{"version":"0.12.34"}"#);
        write(&outside, "Pods/Manifest.lock", "x");
        write(&outside, "Podfile.lock", "x");
        write(&outside, "Evil.xcodeproj/x", "");
        // android/ and ios/ point out of the repository; so does node_modules.
        std::os::unix::fs::symlink(&outside, repo.join("android")).unwrap();
        std::os::unix::fs::symlink(&outside, repo.join("ios")).unwrap();
        std::os::unix::fs::symlink(outside.join("node_modules"), repo.join("node_modules")).unwrap();
        write(&repo, "app.json", r#"{"expo":{"name":"x"}}"#);
        let p = detect_with_home(&repo, None).unwrap();
        assert_eq!((p.has_ios, p.has_android), (false, false), "a linked folder is not the project's own");
        assert_eq!(p.rn_version.as_deref(), Some("0.76.0"), "the version of a package outside the repository is not read");
        assert_eq!(p.new_arch, Some(true), "gradle.properties behind a link is not read");
        assert_eq!((p.pods, p.ios_process), (PodsState::NotApplicable, None));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_that_stays_inside_the_repository_is_followed() {
        // pnpm links node_modules/react-native into node_modules/.pnpm/...
        let d = tempfile::tempdir().unwrap();
        let repo = d.path();
        write(repo, "package.json", r#"{"dependencies":{"react-native":"^0.70.0"}}"#);
        write(repo, "app.json", "{}");
        write(repo, "node_modules/.pnpm/react-native@0.76.5/node_modules/react-native/package.json", r#"{"version":"0.76.5"}"#);
        std::os::unix::fs::symlink(repo.join("node_modules/.pnpm/react-native@0.76.5/node_modules/react-native"), repo.join("node_modules/react-native")).unwrap();
        assert_eq!(detect_with_home(repo, None).unwrap().rn_version.as_deref(), Some("0.76.5"));
    }

    #[test]
    fn the_xcode_project_name_must_be_safe_for_a_predicate() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"dependencies":{"react-native":"0.76.0"}}"#);
        write(d.path(), "ios/a\"b.xcodeproj/x", "");
        assert_eq!(detect_with_home(d.path(), None).unwrap().ios_process, None);
    }

    #[test]
    fn metro_ports_come_from_the_defaults_the_script_and_the_environment_only() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"scripts":{"start":"react-native start --port 8090","web":"expo start --port=19006","env":"RCT_METRO_PORT=8123 react-native start","short":"expo start -p 9000","low":"expo start --port 80","junk":"expo start --port abc"}}"#);
        assert_eq!(metro_ports(d.path(), "start", None), [8081, 19000, 8090]);
        assert_eq!(metro_ports(d.path(), "web", Some("7000")), [8081, 19000, 7000, 19006]);
        assert_eq!(metro_ports(d.path(), "env", None), [8081, 19000, 8123]);
        assert_eq!(metro_ports(d.path(), "short", None), [8081, 19000, 9000]);
        assert_eq!(metro_ports(d.path(), "low", None), [8081, 19000], "a privileged port is never a target");
        assert_eq!(metro_ports(d.path(), "junk", Some("999999")), [8081, 19000]);
        assert_eq!(metro_ports(d.path(), "missing", None), [8081, 19000]);
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
