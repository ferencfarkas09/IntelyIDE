//! Finds the mobile projects of a repository and lists their files. Shallow and bounded on purpose: dependency and build folders
//! hold other people's projects, and a repository controls every name in it. Links are never followed (see `safefs`).

use std::collections::BTreeSet;
use std::path::Path;

use crate::safefs::{self, Entry};

const SKIP_DIRS: &[&str] = &[
    "node_modules", "Pods", "Carthage", "build", "DerivedData", "vendor", "xcuserdata", "intermediates", ".gradle", ".git", ".idea", ".expo", ".bundle", ".cxx", "captures", "dist", "target", "__pycache__",
];
/// Folders of a project root that are walked; everything else there is JavaScript or tooling. (A project whose root is itself the
/// native project is walked whole.)
const PROJECT_DIRS: &[&str] = &["ios", "android", "fastlane", "screenshots", "store", "metadata", "assets"];
const MAX_DISCOVERY_DIRS: usize = 1500;
const MAX_DISCOVERY_DEPTH: usize = 3;
pub(crate) const MAX_PROJECTS: usize = 8;
const MAX_DIRS: usize = 4000;
const MAX_FILES: usize = 30_000;
const MAX_DEPTH: usize = 9;

fn gradle_name(n: &str) -> bool {
    matches!(n, "build.gradle" | "build.gradle.kts")
}
fn settings_name(n: &str) -> bool {
    matches!(n, "settings.gradle" | "settings.gradle.kts")
}

/// Whether a folder (with these entries) is a mobile project root.
fn is_project(entries: &[(String, Entry)]) -> bool {
    let has = |f: &dyn Fn(&str) -> bool, dir: bool| entries.iter().any(|(n, e)| f(n) && if dir { e.is_dir() } else { e.is_file() });
    has(&|n| n == "ios" || n == "android", true) || has(&|n| n.ends_with(".xcodeproj"), true) || (has(&gradle_name, false) && (has(&settings_name, false) || has(&|n| n == "app", true)))
}

/// The project roots below `root` as paths relative to it ("" = the repository root itself), and notes about what was skipped.
pub(crate) fn find_projects(root: &Path) -> (Vec<String>, Vec<&'static str>) {
    let mut found = Vec::new();
    let mut notes = Vec::new();
    let mut visited = 0usize;
    let mut queue = std::collections::VecDeque::from([(String::new(), 0usize)]);
    while let Some((rel, depth)) = queue.pop_front() {
        visited += 1;
        if visited > MAX_DISCOVERY_DIRS {
            notes.push("stoppedSearching");
            break;
        }
        let Ok(entries) = safefs::list(root, &rel) else { continue };
        if is_project(&entries) {
            if found.len() >= MAX_PROJECTS {
                notes.push("tooManyProjects");
                break;
            }
            found.push(rel);
            continue;
        }
        if depth >= MAX_DISCOVERY_DEPTH {
            continue;
        }
        for (name, e) in entries {
            if e.is_dir() && !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
                queue.push_back((if rel.is_empty() { name } else { format!("{rel}/{name}") }, depth + 1));
            }
        }
    }
    found.sort();
    (found, notes)
}

pub(crate) struct Files {
    /// Every file below the project, as a path relative to it.
    pub files: Vec<String>,
    /// Folders (relative to the project) that had more entries than could be looked at.
    pub truncated_dirs: Vec<String>,
    pub dirs: BTreeSet<String>,
    pub truncated: bool,
}

impl Files {
    #[cfg(test)]
    pub fn has(&self, rel: &str) -> bool {
        self.files.binary_search_by(|f| f.as_str().cmp(rel)).is_ok()
    }
    /// Files whose last path segment is `name`.
    pub fn named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a String> + 'a {
        self.files.iter().filter(move |f| f.rsplit('/').next() == Some(name))
    }
    pub fn ending<'a>(&'a self, suffix: &'a str) -> impl Iterator<Item = &'a String> + 'a {
        self.files.iter().filter(move |f| f.ends_with(suffix))
    }
}

pub(crate) fn collect(root: &Path, base: &str) -> Files {
    let join = |a: &str, b: &str| match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_string(),
        (_, true) => a.to_string(),
        _ => format!("{a}/{b}"),
    };
    let top = safefs::list(root, base).unwrap_or_default();
    let native_root = !top.iter().any(|(n, e)| e.is_dir() && (n == "ios" || n == "android"));
    let mut out = Files { files: Vec::new(), truncated_dirs: Vec::new(), dirs: BTreeSet::new(), truncated: false };
    let mut queue = std::collections::VecDeque::from([(String::new(), 0usize)]);
    let mut visited = 0usize;
    while let Some((rel, depth)) = queue.pop_front() {
        visited += 1;
        if visited > MAX_DIRS {
            out.truncated = true;
            break;
        }
        let Ok((entries, cut)) = safefs::list_full(root, &join(base, &rel)) else { continue };
        if cut && out.truncated_dirs.len() < 20 {
            out.truncated_dirs.push(rel.clone());
        }
        for (name, e) in entries {
            let child = join(&rel, &name);
            match e {
                Entry::File(_) => {
                    if out.files.len() >= MAX_FILES {
                        out.truncated = true;
                        break;
                    }
                    out.files.push(child);
                }
                Entry::Dir => {
                    out.dirs.insert(child.clone());
                    let skip = SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.');
                    let allowed = depth > 0 || native_root || PROJECT_DIRS.contains(&name.as_str());
                    if !skip && allowed && depth < MAX_DEPTH {
                        queue.push_back((child, depth + 1));
                    }
                }
                _ => {}
            }
        }
    }
    out.files.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "x").unwrap();
    }

    #[test]
    fn finds_projects_and_skips_dependency_folders() {
        let d = tempfile::tempdir().unwrap();
        for f in ["apps/mobile/ios/App.xcodeproj/project.pbxproj", "apps/mobile/android/build.gradle", "node_modules/x/ios/a", "web/index.html", "native/build.gradle", "native/settings.gradle"] {
            touch(d.path(), f);
        }
        let (p, _) = find_projects(d.path());
        assert_eq!(p, vec!["apps/mobile", "native"]);
        let (none, _) = find_projects(tempfile::tempdir().unwrap().path());
        assert!(none.is_empty());
    }

    #[test]
    fn collect_walks_native_folders_only_and_never_links() {
        let d = tempfile::tempdir().unwrap();
        for f in ["package.json", "ios/Podfile", "ios/Pods/x/y", "android/app/build.gradle", "src/deep/x.js", "ios/.xcode.env"] {
            touch(d.path(), f);
        }
        #[cfg(unix)]
        {
            let out = tempfile::tempdir().unwrap();
            touch(out.path(), "leak.txt");
            std::os::unix::fs::symlink(out.path(), d.path().join("ios/linked")).unwrap();
            let f = collect(d.path(), "");
            assert!(!f.files.iter().any(|x| x.contains("leak")));
        }
        let f = collect(d.path(), "");
        assert_eq!(f.files, vec!["android/app/build.gradle", "ios/.xcode.env", "ios/Podfile", "package.json"]);
        assert!(f.has("ios/Podfile") && !f.has("src/deep/x.js"));
    }
}
