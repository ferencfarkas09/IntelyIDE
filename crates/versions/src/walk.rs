//! Finds the files that can hold a version. Shallow on purpose: a repository's own apps and targets sit a few folders
//! down (`ios/App/App.xcodeproj`, `android/app`), while dependency and build folders hold other people's versions.

use std::path::Path;

use crate::formats::Kind;

/// Folders that never hold the project's own versions (dependencies, build output, caches).
const SKIP_DIRS: &[&str] = &[
    "node_modules", "Pods", "Carthage", "build", "DerivedData", "target", "dist", "out", "vendor", "coverage", "xcuserdata", "__pycache__", "venv", "env", "Frameworks",
];
const MAX_DIRS: usize = 4000;
const MAX_DEPTH: usize = 3;
pub(crate) const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

pub(crate) struct Cand {
    pub rel: String,
    pub kind: Kind,
}

/// The kind of a file by its name and how many folders below the repository root it lies (0 = the root itself).
fn kind_of(name: &str, parent: &str, depth: usize) -> Option<Kind> {
    let (kind, max) = match name {
        "package.json" => (Kind::PackageJson, 2),
        "project.pbxproj" if parent.ends_with(".xcodeproj") => (Kind::Pbxproj, 3),
        "Info.plist" => (Kind::InfoPlist, 3),
        "build.gradle" | "build.gradle.kts" => (Kind::Gradle, 3),
        "Cargo.toml" => (Kind::Cargo, 1),
        "tauri.conf.json" => (Kind::Tauri, 2),
        "app.json" => (Kind::Expo, 1),
        "pyproject.toml" => (Kind::Pyproject, 1),
        "pubspec.yaml" => (Kind::Pubspec, 1),
        _ => return None,
    };
    (depth <= max).then_some(kind)
}

pub(crate) fn candidates(root: &Path) -> (Vec<Cand>, Vec<String>) {
    let mut found = Vec::new();
    let mut notes = Vec::new();
    let mut visited = 0usize;
    let mut stack = vec![(root.to_path_buf(), String::new(), 0usize)];
    while let Some((dir, rel, depth)) = stack.pop() {
        visited += 1;
        if visited > MAX_DIRS {
            notes.push(format!("stopped after {MAX_DIRS} folders"));
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let parent = rel.rsplit('/').next().unwrap_or("").to_string();
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if depth < MAX_DEPTH && !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
                    let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                    stack.push((entry.path(), child, depth + 1));
                }
            } else if ft.is_file() {
                let Some(kind) = kind_of(&name, &parent, depth) else { continue };
                if entry.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) {
                    notes.push(format!("{} is too large to read", if rel.is_empty() { name } else { format!("{rel}/{name}") }));
                    continue;
                }
                found.push(Cand { rel: if rel.is_empty() { name } else { format!("{rel}/{name}") }, kind });
            }
        }
    }
    found.sort_by(|a, b| a.rel.cmp(&b.rel));
    (found, notes)
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
    fn finds_the_project_files_and_skips_dependencies_and_hidden_folders() {
        let d = tempfile::tempdir().unwrap();
        for f in [
            "package.json",
            "ios/App.xcodeproj/project.pbxproj",
            "ios/App/Info.plist",
            "ios/Pods/Pods.xcodeproj/project.pbxproj",
            "node_modules/dep/package.json",
            "android/app/build.gradle",
            ".git/package.json",
            "build/Info.plist",
            "src-tauri/Cargo.toml",
            "src-tauri/tauri.conf.json",
            "docs/deep/er/est/package.json",
            "stray/project.pbxproj",
        ] {
            touch(d.path(), f);
        }
        let (found, notes) = candidates(d.path());
        let rels: Vec<&str> = found.iter().map(|c| c.rel.as_str()).collect();
        assert_eq!(rels, vec!["android/app/build.gradle", "ios/App.xcodeproj/project.pbxproj", "ios/App/Info.plist", "package.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]);
        assert!(notes.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_are_not_followed() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        touch(outside.path(), "package.json");
        std::os::unix::fs::symlink(outside.path(), d.path().join("linked")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("package.json"), d.path().join("package.json")).unwrap();
        let (found, _) = candidates(d.path());
        assert!(found.is_empty());
    }

    #[test]
    fn a_file_that_is_too_large_is_reported_not_read() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("package.json"), vec![b' '; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        let (found, notes) = candidates(d.path());
        assert!(found.is_empty());
        assert_eq!(notes, vec!["package.json is too large to read".to_string()]);
    }
}
