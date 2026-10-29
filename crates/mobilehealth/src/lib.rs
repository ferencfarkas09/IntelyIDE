//! Read-only health check of the iOS and Android parts of a repository (Tauri-free, no network, no process is started, fixture-tested).
//! It reads Xcode projects, `Info.plist`, `Podfile`, Gradle scripts, `AndroidManifest.xml`, `package.json` and Expo's `app.json` as
//! text and reports what would break a build, a signing step or a store submission, in plain language, with the file and line.
//!
//! A repository is hostile input: files are opened without following links, every read has a size cap, every walk a limit, nothing
//! is executed (`app.config.js` is never evaluated), and a secret found in a file is reported by name only, never by value.

mod android;
mod cross;
mod data;
mod gradle;
mod ignore;
mod ios;
mod openstep;
mod perm;
mod safefs;
mod store;
mod walk;
mod xml;

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use safefs::Fail;

pub use data::{reviewed, Reviewed};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warn,
    Info,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

/// One thing worth a look. `id` is stable and names the check; the app words it (English and Hungarian) from the id and `params`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: &'static str,
    /// `ios`, `android`, `cross`, `expo` or `env`: the first part of the id.
    pub platform: &'static str,
    pub severity: Severity,
    /// Relative to the repository root.
    pub file: Option<String>,
    pub line: Option<u32>,
    /// Set when the finding is a guess from package names and native code (permissions).
    pub confidence: Option<Confidence>,
    /// Plain values the text mentions (a target name, two versions). Never a secret.
    pub params: BTreeMap<String, String>,
    /// What to ask a coding agent, precise enough to run as it is.
    pub prompt: String,
}

/// A value the project settles on, shown beside the findings (the version, the bundle id, the SDK levels).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub key: &'static str,
    pub value: String,
    pub file: Option<String>,
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Missing,
    /// Cannot be known from the repository; look elsewhere (a store console, the vendor's current page).
    Check,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItem {
    pub id: &'static str,
    pub platform: &'static str,
    pub status: Status,
    pub file: Option<String>,
    pub params: BTreeMap<String, String>,
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// Relative to the repository root; empty = the root itself.
    pub path: String,
    pub ios: bool,
    pub android: bool,
    pub react_native: bool,
    pub expo: bool,
    pub flutter: bool,
    pub facts: Vec<Fact>,
    pub findings: Vec<Finding>,
    pub checklist: Vec<ChecklistItem>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub detected: bool,
    pub projects: Vec<Project>,
    /// Codes of things left out (`tooLarge:<file>`, `stoppedSearching`): the app words them.
    pub skipped: Vec<String>,
    pub data: Reviewed,
}

/// What the scan may ask of the machine besides the repository. Passed in so a test does not depend on the environment.
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub android_home: Option<String>,
}

impl Env {
    pub fn from_process() -> Env {
        let get = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Env { android_home: get("ANDROID_HOME").or_else(|| get("ANDROID_SDK_ROOT")) }
    }
}

/// Whether the folder holds an iOS or Android project (`ios/`, `android/`, an `.xcodeproj`, a Gradle build). Cheap.
pub fn detect(root: &Path) -> bool {
    !walk::find_projects(root).0.is_empty()
}

pub fn scan(root: &Path) -> Report {
    scan_with(root, &Env::from_process())
}

pub fn scan_with(root: &Path, env: &Env) -> Report {
    let (bases, notes) = walk::find_projects(root);
    let mut report = Report { detected: !bases.is_empty(), data: reviewed(), ..Report::default() };
    report.skipped.extend(notes.iter().map(|n| n.to_string()));
    for base in bases {
        let mut cx = Ctx::new(root, &base, env);
        cx.run();
        report.skipped.append(&mut cx.skipped);
        report.projects.push(cx.project);
    }
    report
}

/// The state of one project during a scan.
pub(crate) struct Ctx<'a> {
    pub root: &'a Path,
    pub base: String,
    pub env: &'a Env,
    pub files: walk::Files,
    pub pkg: Pkg,
    pub project: Project,
    pub skipped: Vec<String>,
}

/// What `package.json` says that matters here.
#[derive(Debug, Default)]
pub(crate) struct Pkg {
    pub found: bool,
    pub version: Option<String>,
    pub deps: BTreeMap<String, String>,
    /// Expo's `app.json`, when there is one (the dynamic `app.config.*` files are never executed).
    pub app_json: Option<serde_json::Value>,
    app_json_text: String,
}

impl Pkg {
    pub fn has(&self, name: &str) -> bool {
        self.deps.contains_key(name)
    }
    /// The (major, minor) of the `react-native` dependency when it is written as a plain range.
    pub fn rn_version(&self) -> Option<(u32, u32)> {
        let v = self.deps.get("react-native")?;
        let v = v.trim_start_matches(['^', '~', '=', 'v', ' ']);
        let mut it = v.split('.').map(|p| p.chars().take_while(char::is_ascii_digit).collect::<String>());
        Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
    }
}

pub(crate) const CAP: u64 = 4 * 1024 * 1024;

impl<'a> Ctx<'a> {
    fn new(root: &'a Path, base: &str, env: &'a Env) -> Ctx<'a> {
        Ctx { root, base: base.to_string(), env, files: walk::collect(root, base), pkg: Pkg::default(), project: Project { path: base.to_string(), ..Project::default() }, skipped: Vec::new() }
    }

    /// The display path (relative to the repository root) of a path relative to the project.
    pub fn path(&self, rel: &str) -> String {
        if self.base.is_empty() {
            rel.to_string()
        } else {
            format!("{}/{rel}", self.base)
        }
    }

    fn abs_rel(&self, rel: &str) -> String {
        self.path(rel)
    }

    /// The text of a project file; a file that is too large or not a plain file is noted and left out.
    pub fn read(&mut self, rel: &str) -> Option<String> {
        self.read_cap(rel, CAP)
    }

    pub fn read_cap(&mut self, rel: &str, cap: u64) -> Option<String> {
        match safefs::read(self.root, &self.abs_rel(rel), cap) {
            Ok(t) => Some(t),
            Err(Fail::Missing) | Err(Fail::Outside) => None,
            Err(Fail::TooLarge) => {
                self.skipped.push(format!("tooLarge:{}", self.path(rel)));
                None
            }
            Err(Fail::NotRegular) => {
                self.skipped.push(format!("notRegular:{}", self.path(rel)));
                None
            }
            Err(Fail::Io) => None,
        }
    }

    pub fn is_file(&self, rel: &str) -> bool {
        safefs::stat(self.root, &self.abs_rel(rel)).is_file()
    }

    pub fn entry(&self, rel: &str) -> safefs::Entry {
        safefs::stat(self.root, &self.abs_rel(rel))
    }

    pub fn fact(&mut self, key: &'static str, value: impl Into<String>, at: Option<(&str, u32)>) {
        let (file, line) = match at {
            Some((f, l)) => (Some(self.path(f)), Some(l)),
            None => (None, None),
        };
        self.project.facts.push(Fact { key, value: value.into(), file, line });
    }

    pub fn fact_value(&self, key: &str) -> Option<&str> {
        self.project.facts.iter().find(|f| f.key == key).map(|f| f.value.as_str())
    }

    /// Records a finding. `at` is (project-relative file, line; 0 = no line).
    pub fn add(&mut self, id: &'static str, severity: Severity, at: Option<(&str, u32)>, confidence: Option<Confidence>, params: &[(&str, &str)], prompt: String) {
        debug_assert!(data::registered(id), "unregistered check id {id}");
        let (file, line) = match at {
            Some((f, l)) => (Some(self.path(f)), (l > 0).then_some(l)),
            None => (None, None),
        };
        let params = params.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let platform = id.split('.').next().unwrap_or("cross");
        let platform = ["ios", "android", "expo", "env"].into_iter().find(|p| *p == platform).unwrap_or("cross");
        self.project.findings.push(Finding { id, platform, severity, file, line, confidence, params, prompt });
    }

    pub fn check(&mut self, id: &'static str, platform: &'static str, status: Status, file: Option<&str>, params: &[(&str, &str)], prompt: Option<String>) {
        let file = file.map(|f| self.path(f));
        let params = params.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        self.project.checklist.push(ChecklistItem { id, platform, status, file, params, prompt });
    }

    /// Where the repository's ignore rules live: the project, its `ios` and `android` folders, and the repository root.
    pub fn ignore_rules(&mut self) -> ignore::Ignore {
        let mut rules = ignore::Ignore::parse("");
        let mut dirs = vec![String::new(), "ios".to_string(), "android".to_string(), "android/app".to_string()];
        if !self.base.is_empty() {
            dirs.push(String::from("<root>"));
        }
        for d in dirs {
            let text = if d == "<root>" {
                safefs::read(self.root, ".gitignore", 256 * 1024).ok()
            } else {
                let rel = if d.is_empty() { ".gitignore".to_string() } else { format!("{d}/.gitignore") };
                safefs::read(self.root, &self.abs_rel(&rel), 256 * 1024).ok()
            };
            if let Some(t) = text {
                rules = rules.merge(ignore::Ignore::parse(&t));
            }
        }
        rules
    }

    fn run(&mut self) {
        self.load_package();
        self.project.ios = self.files.dirs.contains("ios") || self.files.files.iter().any(|f| f.ends_with(".xcodeproj/project.pbxproj"));
        self.project.android = self.files.dirs.contains("android") || self.files.named("build.gradle").next().is_some() || self.files.named("build.gradle.kts").next().is_some();
        self.project.react_native = self.pkg.has("react-native");
        self.project.expo = self.pkg.has("expo");
        self.project.flutter = self.is_file("pubspec.yaml");
        let perms = perm::collect(self);
        if self.project.ios {
            ios::run(self, &perms);
        }
        if self.project.android {
            android::run(self, &perms);
        }
        cross::run(self);
        store::run(self);
        self.project.findings.sort_by(|a, b| a.severity.cmp(&b.severity).then(a.id.cmp(b.id)).then(a.file.cmp(&b.file)));
    }

    /// The line of `"key"` in `app.json` (the last place the key is written, which is where nested Expo keys sit), or 0.
    pub fn app_json_line(&self, key: &str) -> u32 {
        let needle = format!("\"{key}\"");
        self.pkg.app_json_text.lines().position(|l| l.contains(&needle)).map_or(0, |i| i as u32 + 1)
    }

    fn load_package(&mut self) {
        if let Some(text) = self.read("app.json") {
            self.pkg.app_json = serde_json::from_str(&text).ok();
            self.pkg.app_json_text = text;
        }
        let Some(text) = self.read("package.json") else { return };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return };
        self.pkg.found = true;
        self.pkg.version = v.get("version").and_then(|x| x.as_str()).map(str::to_string);
        for k in ["dependencies", "devDependencies", "peerDependencies"] {
            if let Some(o) = v.get(k).and_then(|x| x.as_object()) {
                for (name, ver) in o {
                    self.pkg.deps.entry(name.clone()).or_insert_with(|| ver.as_str().unwrap_or("").to_string());
                }
            }
        }
    }
}

/// Quote a repository path for a prompt: no line breaks or backticks that could end the quote.
pub(crate) fn q(s: &str) -> String {
    let clean: String = s.chars().filter(|c| !c.is_control() && *c != '`').take(200).collect();
    format!("`{clean}`")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rn_version_reads_ranges() {
        let mut p = Pkg::default();
        p.deps.insert("react-native".into(), "^0.74.5".into());
        assert_eq!(p.rn_version(), Some((0, 74)));
        p.deps.insert("react-native".into(), "latest".into());
        assert_eq!(p.rn_version(), None);
    }

    #[test]
    fn quoting_strips_what_could_break_a_prompt() {
        assert_eq!(q("a`b\nc"), "`abc`");
    }
}
