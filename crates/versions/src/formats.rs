//! What a version looks like in each kind of file. `occurrences` lists every place a version is written, with the byte
//! range of the value, so reading and editing share one source of truth and an edit changes only those bytes
//! (indentation, quotes, line endings and everything around the value stay as they are).

use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::json;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    PackageJson,
    Pbxproj,
    InfoPlist,
    Gradle,
    Cargo,
    Tauri,
    Expo,
    Pyproject,
    Pubspec,
}

/// The marketing version people read, or the build number the store counts up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Version,
    Build,
}

pub(crate) struct Occ {
    pub key: String,
    pub role: Role,
    pub range: Range<usize>,
    pub value: String,
    /// A bare JSON number (Expo's `versionCode`): only digits may be written there.
    pub numeric: bool,
}

fn occ(key: &str, role: Role, text: &str, range: Range<usize>) -> Occ {
    Occ { key: key.to_string(), role, value: text[range.clone()].to_string(), range, numeric: false }
}

/// (start, line without its line ending) for every line.
fn lines(text: &str) -> impl Iterator<Item = (usize, &str)> {
    let mut pos = 0usize;
    text.split_inclusive('\n').map(move |l| {
        let s = pos;
        pos += l.len();
        (s, l.trim_end_matches(['\n', '\r']))
    })
}

/// The value written after `from` in `line`: a quoted string (its content) or a bare word up to whitespace or one of
/// `stops`. Offsets are within `line`. Empty values give `None`.
fn value_after(line: &str, from: usize, stops: &[char]) -> Option<(usize, usize)> {
    let rest = line.get(from..)?;
    let skipped = rest.len() - rest.trim_start().len();
    let s = from + skipped;
    let tail = line.get(s..)?;
    let first = tail.chars().next()?;
    if first == '"' || first == '\'' {
        let close = tail[1..].find(first)?;
        return (close > 0).then_some((s + 1, s + 1 + close));
    }
    let len = tail.find(|c: char| c.is_whitespace() || stops.contains(&c)).unwrap_or(tail.len());
    (len > 0).then_some((s, s + len))
}

pub(crate) fn occurrences(kind: Kind, text: &str) -> Vec<Occ> {
    match kind {
        Kind::PackageJson => json_keys(text, &[("version", Role::Version, &["version"])]),
        Kind::Tauri => {
            let mut v = json_keys(text, &[("version", Role::Version, &["version"])]);
            if v.is_empty() {
                v = json_keys(text, &[("version", Role::Version, &["package", "version"])]);
            }
            v
        }
        Kind::Expo => json_keys(
            text,
            &[
                ("expo.version", Role::Version, &["expo", "version"]),
                ("expo.ios.buildNumber", Role::Build, &["expo", "ios", "buildNumber"]),
                ("expo.android.versionCode", Role::Build, &["expo", "android", "versionCode"]),
            ],
        ),
        Kind::Pbxproj => pbxproj(text),
        Kind::InfoPlist => plist(text),
        Kind::Gradle => gradle(text),
        Kind::Cargo => toml(text, &["package", "workspace.package"]),
        Kind::Pyproject => toml(text, &["project", "tool.poetry"]),
        Kind::Pubspec => pubspec(text),
    }
}

fn json_keys(text: &str, keys: &[(&str, Role, &[&str])]) -> Vec<Occ> {
    let mut out = Vec::new();
    for (key, role, path) in keys {
        if let Some(l) = json::locate(text, path) {
            if l.start < l.end {
                let mut o = occ(key, *role, text, l.start..l.end);
                o.numeric = !l.quoted;
                out.push(o);
            }
        }
    }
    out
}

/// `MARKETING_VERSION = 1.2.3;` and `CURRENT_PROJECT_VERSION = 45;` in every build configuration of every target.
fn pbxproj(text: &str) -> Vec<Occ> {
    let mut out = Vec::new();
    for (start, line) in lines(text) {
        let t = line.trim_start();
        for (key, role) in [("MARKETING_VERSION", Role::Version), ("CURRENT_PROJECT_VERSION", Role::Build)] {
            let Some(rest) = t.strip_prefix(key) else { continue };
            let Some(after) = rest.trim_start().strip_prefix('=') else { continue };
            let eq = line.len() - after.len();
            if let Some((a, b)) = value_after(line, eq, &[';']) {
                if !line[a..b].contains("$(") {
                    out.push(occ(key, role, text, start + a..start + b));
                }
            }
        }
    }
    out
}

/// The literal `<string>` after `<key>CFBundleShortVersionString</key>` / `CFBundleVersion`. A value such as
/// `$(MARKETING_VERSION)` is read from the Xcode project, so it is not a place to write.
fn plist(text: &str) -> Vec<Occ> {
    let mut out = Vec::new();
    for (key, role) in [("CFBundleShortVersionString", Role::Version), ("CFBundleVersion", Role::Build)] {
        let tag = format!("<key>{key}</key>");
        let Some(at) = text.find(&tag) else { continue };
        let after = at + tag.len();
        let rest = &text[after..];
        let trimmed = rest.trim_start();
        let Some(body) = trimmed.strip_prefix("<string>") else { continue };
        let s = after + (rest.len() - trimmed.len()) + "<string>".len();
        let Some(len) = body.find("</string>") else { continue };
        let range = s..s + len;
        if range.is_empty() || text[range.clone()].contains("$(") {
            continue;
        }
        out.push(occ(key, role, text, range));
    }
    out
}

/// `versionName "1.2.3"` / `versionName = "1.2.3"` and `versionCode 12` / `versionCode = 12` as plain literals.
fn gradle(text: &str) -> Vec<Occ> {
    let mut out = Vec::new();
    for (start, line) in lines(text) {
        let t = line.trim_start();
        let lead = line.len() - t.len();
        for (key, role) in [("versionName", Role::Version), ("versionCode", Role::Build)] {
            let Some(rest) = t.strip_prefix(key) else { continue };
            if !rest.starts_with(|c: char| c.is_whitespace() || c == '=') {
                continue;
            }
            let mut from = lead + key.len();
            let r = line[from..].trim_start();
            from = line.len() - r.len();
            if let Some(after_eq) = r.strip_prefix('=') {
                from = line.len() - after_eq.len();
            }
            let Some((a, b)) = value_after(line, from, &[]) else { continue };
            let quoted = matches!(line.as_bytes()[a - 1], b'"' | b'\'') && a > from;
            let tail = line[if quoted { b + 1 } else { b }..].trim();
            if !(tail.is_empty() || tail.starts_with("//")) {
                continue;
            }
            let v = &line[a..b];
            let ok = match role {
                Role::Version => quoted && !v.contains('$'),
                Role::Build => !quoted && v.chars().all(|c| c.is_ascii_digit()),
            };
            if ok {
                let mut o = occ(key, role, text, start + a..start + b);
                o.numeric = role == Role::Build;
                out.push(o);
            }
        }
    }
    out
}

/// `version = "x"` inside the given tables (`[package]` and `[workspace.package]`, `[project]` and `[tool.poetry]`).
fn toml(text: &str, tables: &[&str]) -> Vec<Occ> {
    let mut out = Vec::new();
    let mut table: Option<String> = None;
    for (start, line) in lines(text) {
        let t = line.trim_start();
        if let Some(h) = t.strip_prefix('[') {
            let name = h.split(']').next().unwrap_or("").trim();
            table = (!t.starts_with("[[")).then(|| name.to_string());
            continue;
        }
        let Some(current) = table.as_deref().filter(|n| tables.contains(n)) else { continue };
        let Some(rest) = t.strip_prefix("version") else { continue };
        let Some(after) = rest.trim_start().strip_prefix('=') else { continue };
        let from = line.len() - after.len();
        if let Some((a, b)) = value_after(line, from, &[]) {
            if matches!(line.as_bytes()[a - 1], b'"' | b'\'') && a > from {
                out.push(occ(&format!("{current}.version"), Role::Version, text, start + a..start + b));
            }
        }
    }
    out
}

/// `version: 1.2.3+4`: the part before `+` is the version, the part after it the build number.
fn pubspec(text: &str) -> Vec<Occ> {
    let mut out = Vec::new();
    for (start, line) in lines(text) {
        let Some(rest) = line.strip_prefix("version:") else { continue };
        let from = line.len() - rest.len();
        let Some((a, b)) = value_after(line, from, &['#']) else { continue };
        let token = &line[a..b];
        match token.find('+') {
            Some(plus) => {
                out.push(occ("version", Role::Version, text, start + a..start + a + plus));
                if plus + 1 < token.len() {
                    let mut o = occ("build", Role::Build, text, start + a + plus + 1..start + b);
                    o.numeric = true;
                    out.push(o);
                }
            }
            None => out.push(occ("version", Role::Version, text, start + a..start + b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(kind: Kind, text: &str) -> Vec<(String, String)> {
        occurrences(kind, text).into_iter().map(|o| (o.key, o.value)).collect()
    }

    fn p(k: &str, v: &str) -> (String, String) {
        (k.to_string(), v.to_string())
    }

    #[test]
    fn package_json_reads_only_the_top_level_version() {
        let t = "{\n  \"name\": \"services\",\n  \"version\": \"4.2.0\",\n  \"config\": { \"version\": \"1\" }\n}\n";
        assert_eq!(pairs(Kind::PackageJson, t), vec![p("version", "4.2.0")]);
    }

    #[test]
    fn pbxproj_lists_every_configuration_and_skips_variables() {
        let t = "\t\t\t\tCURRENT_PROJECT_VERSION = 45;\n\t\t\t\tMARKETING_VERSION = 1.2.3;\n\t\t\t\tMARKETING_VERSION = \"1.2.3\";\n\t\t\t\tMARKETING_VERSION = \"$(inherited)\";\n\t\t\t\tPRODUCT_NAME = App;\n";
        assert_eq!(pairs(Kind::Pbxproj, t), vec![p("CURRENT_PROJECT_VERSION", "45"), p("MARKETING_VERSION", "1.2.3"), p("MARKETING_VERSION", "1.2.3")]);
    }

    #[test]
    fn info_plist_reads_literals_and_ignores_variable_references() {
        let lit = "<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>2.0.1</string>\n\t<key>CFBundleVersion</key>\n\t<string>17</string>\n</dict>";
        assert_eq!(pairs(Kind::InfoPlist, lit), vec![p("CFBundleShortVersionString", "2.0.1"), p("CFBundleVersion", "17")]);
        let var = "<key>CFBundleShortVersionString</key>\n<string>$(MARKETING_VERSION)</string>\n<key>CFBundleVersion</key>\n<string>$(CURRENT_PROJECT_VERSION)</string>";
        assert!(pairs(Kind::InfoPlist, var).is_empty());
    }

    #[test]
    fn gradle_reads_groovy_and_kotlin_literals_only() {
        let t = "    defaultConfig {\n        versionCode 12\n        versionName \"1.4.0\"\n    }\n";
        assert_eq!(pairs(Kind::Gradle, t), vec![p("versionCode", "12"), p("versionName", "1.4.0")]);
        let kts = "versionCode = 7\nversionName = \"0.9\" // beta\n";
        assert_eq!(pairs(Kind::Gradle, kts), vec![p("versionCode", "7"), p("versionName", "0.9")]);
        let dynamic = "versionCode project.property(\"code\")\nversionName \"1.0\" + suffix\nversionName \"$base\"\n";
        assert!(pairs(Kind::Gradle, dynamic).is_empty());
    }

    #[test]
    fn toml_reads_package_and_workspace_package_not_dependencies() {
        let t = "[workspace.package]\nversion = \"0.3.0\"\n\n[package]\nname = \"x\"\nversion = \"1.0.0\"\nedition = \"2021\"\n\n[dependencies]\nserde = { version = \"1\" }\nversion = \"9\"\n";
        assert_eq!(pairs(Kind::Cargo, t), vec![p("workspace.package.version", "0.3.0"), p("package.version", "1.0.0")]);
        let inherit = "[package]\nversion.workspace = true\n";
        assert!(pairs(Kind::Cargo, inherit).is_empty());
        let py = "[build-system]\nrequires = []\n[project]\nname = \"a\"\nversion = '2.1.0'\n";
        assert_eq!(pairs(Kind::Pyproject, py), vec![p("project.version", "2.1.0")]);
    }

    #[test]
    fn pubspec_splits_version_and_build() {
        assert_eq!(pairs(Kind::Pubspec, "name: app\nversion: 1.2.3+45 # note\n"), vec![p("version", "1.2.3"), p("build", "45")]);
        assert_eq!(pairs(Kind::Pubspec, "version: 1.2.3\n"), vec![p("version", "1.2.3")]);
    }

    #[test]
    fn line_based_formats_read_the_same_values_with_windows_line_endings() {
        assert_eq!(pairs(Kind::Gradle, "versionCode 12\r\nversionName \"1.4.0\"\r\n"), vec![p("versionCode", "12"), p("versionName", "1.4.0")]);
        assert_eq!(pairs(Kind::Pbxproj, "\t\tMARKETING_VERSION = 1.2.3;\r\n\t\tCURRENT_PROJECT_VERSION = 45;\r\n"), vec![p("MARKETING_VERSION", "1.2.3"), p("CURRENT_PROJECT_VERSION", "45")]);
        assert_eq!(pairs(Kind::Cargo, "[package]\r\nversion = \"0.1.0\"\r\n"), vec![p("package.version", "0.1.0")]);
        assert_eq!(pairs(Kind::Pubspec, "version: 1.0.0+3\r\n"), vec![p("version", "1.0.0"), p("build", "3")]);
        assert_eq!(pairs(Kind::InfoPlist, "<key>CFBundleVersion</key>\r\n<string>7</string>\r\n"), vec![p("CFBundleVersion", "7")]);
    }

    #[test]
    fn expo_reads_version_and_both_build_numbers() {
        let t = r#"{"expo":{"name":"x","version":"1.0.0","ios":{"buildNumber":"3"},"android":{"versionCode":8}}}"#;
        let o = occurrences(Kind::Expo, t);
        assert_eq!(o.iter().map(|o| (o.key.as_str(), o.value.as_str(), o.numeric)).collect::<Vec<_>>(), vec![("expo.version", "1.0.0", false), ("expo.ios.buildNumber", "3", false), ("expo.android.versionCode", "8", true)]);
    }

    #[test]
    fn tauri_reads_v2_top_level_and_v1_package_version() {
        assert_eq!(pairs(Kind::Tauri, r#"{"productName":"a","version":"1.13.1"}"#), vec![p("version", "1.13.1")]);
        assert_eq!(pairs(Kind::Tauri, r#"{"package":{"productName":"a","version":"0.5.0"}}"#), vec![p("version", "0.5.0")]);
    }
}
