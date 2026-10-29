//! The Setup doctor: are the tools a vibe coder's stack needs installed (Node 24 for the agent, git, gh, the Xcode command
//! line tools, CocoaPods, the Android SDK, watchman)? It only looks: every probe is a `--version` style call on the
//! login-shell PATH with a deadline, no network, nothing installed or changed. The Agent SDK and the Claude login are
//! answered by the provider state the app already keeps (the UI adds them), so no credential is read here.
//! On Windows the Apple and Android-specific probes are not run and say so.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;

use crate::gh::find_in_path;
use crate::proc;

/// The Agent sidecar runs on Node 24 or newer.
pub const NODE_MIN_MAJOR: u32 = 24;
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupCheck {
    /// `node`, `git`, `gh`, `xcode`, `cocoapods`, `android`, `watchman`.
    pub id: String,
    /// `ok`, `warn` (installed but not usable as is), `missing`, `notChecked` (not on this platform).
    pub status: String,
    pub version: Option<String>,
    /// Where it was found (a program or a folder); never a file content.
    pub path: Option<String>,
    /// A short machine code for the UI's sentence: `tooOld`, `noVersion`, `noAdb`, `notConfigured`.
    pub reason: Option<String>,
    /// `optional` checks never make the summary red.
    pub optional: bool,
}

pub struct SetupOpts {
    /// The login-shell PATH the IDE starts tools from.
    pub login_path: String,
    /// The login-shell environment (only `ANDROID_HOME`, `ANDROID_SDK_ROOT` and `HOME` are read).
    pub env: HashMap<String, String>,
}

fn check(id: &str, status: &str, optional: bool) -> SetupCheck {
    SetupCheck { id: id.into(), status: status.into(), version: None, path: None, reason: None, optional }
}

fn probe(bin: &Path, args: &[&str], opts: &SetupOpts) -> Option<proc::Out> {
    let mut cmd = if bin.file_name().is_some_and(|n| n == "git") { intely_core::exec::hardened_git(bin) } else { Command::new(bin) };
    cmd.args(args).env("PATH", &opts.login_path).env("LC_ALL", "C").env("GH_NO_UPDATE_NOTIFIER", "1").env("COCOAPODS_DISABLE_STATS", "1");
    // never in a repository: a tool must not pick up a repository's configuration
    cmd.current_dir(std::env::temp_dir());
    proc::run(cmd, TIMEOUT).ok()
}

/// The first token that starts with a digit: "v24.1.0" -> "24.1.0", "git version 2.50.1 (Apple Git-155)" -> "2.50.1".
pub fn version_token(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    line.split_whitespace().map(|t| t.trim_start_matches('v')).find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit())).map(|t| t.trim_end_matches([',', ';']).to_owned())
}

/// The major version of a dotted version, `None` when it does not start with a number.
pub fn major(version: &str) -> Option<u32> {
    version.split('.').next()?.parse().ok()
}

fn tool(id: &str, bin: &str, args: &[&str], optional: bool, opts: &SetupOpts) -> (SetupCheck, Option<PathBuf>) {
    let Some(path) = find_in_path(&opts.login_path, bin) else { return (check(id, "missing", optional), None) };
    let mut c = check(id, "ok", optional);
    c.path = Some(path.to_string_lossy().into_owned());
    match probe(&path, args, opts).filter(|o| o.ok).and_then(|o| version_token(&o.stdout).or_else(|| version_token(&o.stderr))) {
        Some(v) => c.version = Some(v),
        None => {
            c.status = "warn".into();
            c.reason = Some("noVersion".into());
        }
    }
    (c, Some(path))
}

fn node(opts: &SetupOpts) -> SetupCheck {
    let (mut c, _) = tool("node", "node", &["--version"], false, opts);
    if let Some(m) = c.version.as_deref().and_then(major) {
        if m < NODE_MIN_MAJOR {
            c.status = "warn".into();
            c.reason = Some("tooOld".into());
        }
    }
    c
}

#[cfg(target_os = "macos")]
fn xcode(opts: &SetupOpts) -> SetupCheck {
    let Some(bin) = find_in_path(&opts.login_path, "xcode-select").or_else(|| Some(PathBuf::from("/usr/bin/xcode-select")).filter(|p| p.is_file())) else {
        return check("xcode", "missing", false);
    };
    match probe(&bin, &["-p"], opts) {
        Some(o) if o.ok && !o.stdout.trim().is_empty() && Path::new(o.stdout.trim()).is_dir() => {
            let mut c = check("xcode", "ok", false);
            c.path = Some(o.stdout.trim().to_owned());
            c
        }
        _ => check("xcode", "missing", false),
    }
}

#[cfg(not(target_os = "macos"))]
fn xcode(_opts: &SetupOpts) -> SetupCheck {
    check("xcode", "notChecked", true)
}

#[cfg(target_os = "macos")]
fn cocoapods(opts: &SetupOpts) -> SetupCheck {
    tool("cocoapods", "pod", &["--version"], true, opts).0
}

#[cfg(not(target_os = "macos"))]
fn cocoapods(_opts: &SetupOpts) -> SetupCheck {
    check("cocoapods", "notChecked", true)
}

/// The SDK folder: `ANDROID_HOME`, else `ANDROID_SDK_ROOT`, else the place Android Studio puts it on a Mac.
pub fn android_home(env: &HashMap<String, String>) -> Option<PathBuf> {
    let set = |k: &str| env.get(k).map(|v| v.trim()).filter(|v| !v.is_empty()).map(PathBuf::from);
    set("ANDROID_HOME").or_else(|| set("ANDROID_SDK_ROOT")).or_else(|| {
        if cfg!(target_os = "macos") {
            set("HOME").map(|h| h.join("Library/Android/sdk")).filter(|p| p.is_dir())
        } else {
            None
        }
    })
}

fn android(opts: &SetupOpts) -> SetupCheck {
    if cfg!(windows) {
        return check("android", "notChecked", true);
    }
    let home = android_home(&opts.env);
    let adb = home.as_ref().map(|h| h.join("platform-tools").join("adb")).filter(|p| p.is_file()).or_else(|| find_in_path(&opts.login_path, "adb"));
    let mut c = check("android", "ok", true);
    match (&home, &adb) {
        (None, None) => return check("android", "missing", true),
        (Some(h), _) if !h.is_dir() => {
            c.status = "warn".into();
            c.reason = Some("notConfigured".into());
            c.path = Some(h.to_string_lossy().into_owned());
            return c;
        }
        (_, None) => {
            c.status = "warn".into();
            c.reason = Some("noAdb".into());
        }
        (_, Some(a)) => c.version = probe(a, &["version"], opts).filter(|o| o.ok).and_then(|o| version_token(o.stdout.lines().find(|l| l.contains("version")).unwrap_or(""))),
    }
    if home.is_none() {
        c.status = "warn".into();
        c.reason = Some("notConfigured".into());
    }
    c.path = home.or(adb).map(|p| p.to_string_lossy().into_owned());
    c
}

/// Every check, in the order the panel lists them.
pub fn run(opts: &SetupOpts) -> Vec<SetupCheck> {
    vec![
        node(opts),
        tool("git", "git", &["--version"], false, opts).0,
        tool("gh", "gh", &["--version"], true, opts).0,
        xcode(opts),
        cocoapods(opts),
        android(opts),
        if cfg!(windows) { check("watchman", "notChecked", true) } else { tool("watchman", "watchman", &["--version"], true, opts).0 },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_read_from_the_usual_shapes() {
        assert_eq!(version_token("v24.1.0\n").as_deref(), Some("24.1.0"));
        assert_eq!(version_token("git version 2.50.1 (Apple Git-155)").as_deref(), Some("2.50.1"));
        assert_eq!(version_token("gh version 2.80.0 (2026-01-01)\nhttps://x").as_deref(), Some("2.80.0"));
        assert_eq!(version_token("1.16.2").as_deref(), Some("1.16.2"));
        assert_eq!(version_token("Android Debug Bridge version 1.0.41").as_deref(), Some("1.0.41"));
        assert_eq!(version_token("no digits here"), None);
        assert_eq!(major("24.1.0"), Some(24));
        assert_eq!(major("x"), None);
    }

    #[cfg(unix)]
    fn fake(dir: &Path, name: &str, out: &str) {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\necho '{out}'\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn an_old_node_is_a_warning_and_a_missing_tool_is_missing() {
        let bin = tempfile::tempdir().unwrap();
        fake(bin.path(), "node", "v20.11.0");
        fake(bin.path(), "watchman", "2025.01.06.00");
        let opts = SetupOpts { login_path: bin.path().to_string_lossy().into_owned(), env: HashMap::new() };
        let all = run(&opts);
        let by = |id: &str| all.iter().find(|c| c.id == id).unwrap().clone();
        let n = by("node");
        assert_eq!((n.status.as_str(), n.reason.as_deref(), n.version.as_deref()), ("warn", Some("tooOld"), Some("20.11.0")));
        assert_eq!(by("git").status, "missing");
        assert!(by("gh").optional);
        assert_eq!(by("watchman").status, "ok");
        assert_eq!(by("android").status, "missing");
        fake(bin.path(), "node", "v24.3.0");
        assert_eq!(run(&opts)[0].status, "ok");
    }

    #[cfg(unix)]
    #[test]
    fn the_android_sdk_is_found_from_the_environment() {
        let sdk = tempfile::tempdir().unwrap();
        let empty = tempfile::tempdir().unwrap();
        let mut env = HashMap::new();
        env.insert("ANDROID_HOME".to_owned(), sdk.path().to_string_lossy().into_owned());
        let opts = SetupOpts { login_path: empty.path().to_string_lossy().into_owned(), env: env.clone() };
        let c = android(&opts);
        assert_eq!((c.status.as_str(), c.reason.as_deref()), ("warn", Some("noAdb")));
        std::fs::create_dir_all(sdk.path().join("platform-tools")).unwrap();
        fake(&sdk.path().join("platform-tools"), "adb", "Android Debug Bridge version 1.0.41");
        let c = android(&opts);
        assert_eq!((c.status.as_str(), c.version.as_deref()), ("ok", Some("1.0.41")));
        env.insert("ANDROID_HOME".to_owned(), "/nonexistent/sdk".to_owned());
        let c = android(&SetupOpts { login_path: opts.login_path.clone(), env });
        assert_eq!((c.status.as_str(), c.reason.as_deref()), ("warn", Some("notConfigured")));
    }
}
