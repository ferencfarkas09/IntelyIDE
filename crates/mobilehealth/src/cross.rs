//! Checks that look at both platforms and at the configuration around them: Expo's `app.json`, version and identifier agreement
//! between iOS and Android, shared flags, and `.env` files. Only names are looked at for `.env` files; their content is never read.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::{q, Ctx, Severity};

/// The packages named in `expo.plugins` (each entry is a name or `[name, options]`).
pub(crate) fn expo_plugins(app: Option<&Value>) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let Some(list) = app.and_then(|v| v.pointer("/expo/plugins")).and_then(|v| v.as_array()) else { return out };
    for p in list.iter().take(200) {
        match p {
            Value::String(s) => {
                out.insert(s.clone());
            }
            Value::Array(a) => {
                if let Some(Value::String(s)) = a.first() {
                    out.insert(s.clone());
                }
            }
            _ => {}
        }
    }
    out
}

fn is_example(name: &str) -> bool {
    [".example", ".sample", ".template", ".defaults", ".dist"].iter().any(|s| name.ends_with(s))
}

pub(crate) fn run(cx: &mut Ctx) {
    expo(cx);
    agreement(cx);
    env_files(cx);
}

fn expo(cx: &mut Ctx) {
    let dynamic: Vec<String> = cx.files.files.iter().filter(|f| !f.contains('/') && ["app.config.js", "app.config.ts", "app.config.mjs", "app.config.cjs"].contains(&f.as_str())).cloned().collect();
    if let Some(f) = dynamic.first() {
        let f = f.clone();
        cx.add(
            "expo.config.dynamic",
            Severity::Info,
            Some((&f, 0)),
            None,
            &[],
            format!("{} is a script, so this check does not run it and cannot compare its version and identifiers with the native projects. Look at what it computes (version, ios.buildNumber, android.versionCode, bundle identifier, package) and tell me whether they agree with the Xcode project and the Gradle files; change nothing unless they do not.", q(&cx.path(&f))),
        );
    }
    let Some(app) = cx.pkg.app_json.clone() else { return };
    let Some(e) = app.get("expo") else { return };
    let s = |p: &str| e.pointer(p).and_then(|v| v.as_str().map(crate::clean).or_else(|| v.as_u64().map(|n| n.to_string())));
    let comparisons = [
        ("expo.version", s("/version"), "ios.version", "android.versionName", "expo.version.drift"),
        ("expo.ios.buildNumber", s("/ios/buildNumber"), "ios.build", "", "expo.version.drift"),
        ("expo.android.versionCode", s("/android/versionCode"), "", "android.versionCode", "expo.version.drift"),
        ("expo.ios.bundleIdentifier", s("/ios/bundleIdentifier"), "ios.bundleId", "", "expo.bundleId.drift"),
        ("expo.android.package", s("/android/package"), "", "android.applicationId", "expo.bundleId.drift"),
    ];
    for (key, val, ios_fact, android_fact, id) in comparisons {
        let Some(val) = val else { continue };
        for fact in [ios_fact, android_fact] {
            if fact.is_empty() {
                continue;
            }
            let Some(native) = cx.fact_value(fact).map(str::to_string) else { continue };
            if native != val {
                let id: &'static str = id;
                let l = cx.app_json_line(key.rsplit('.').next().unwrap_or(key));
                cx.add(
                    id,
                    Severity::Warn,
                    Some(("app.json", l)),
                    None,
                    &[("key", key), ("expo", &val), ("native", &native), ("fact", fact)],
                    format!("app.json says {key} is {val}, but the native project says {native} ({fact}). When the ios/ and android/ folders are committed, the native files are what gets built; Expo's value is used only if they are regenerated (prebuild --clean), which would then change the app. Ask me which one is right, then make both agree, editing app.json by hand and the native file for that platform only."),
                );
            }
        }
    }
}

fn agreement(cx: &mut Ctx) {
    let (iv, av) = (cx.fact_value("ios.version").map(str::to_string), cx.fact_value("android.versionName").map(str::to_string));
    if let (Some(i), Some(a)) = (iv, av) {
        if i != a {
            cx.add(
                "cross.version.mismatch",
                Severity::Info,
                None,
                None,
                &[("ios", &i), ("android", &a)],
                format!("The iOS version is {i} but the Android versionName is {a}. Different numbers are fine when the two apps are released separately, but most teams keep them equal so support and release notes are simpler. Ask me whether they should agree; if yes, set both to the higher one (MARKETING_VERSION in the Xcode project, versionName in android/app/build.gradle). Do not touch the build numbers; iOS and Android count those separately."),
            );
        }
    }
    let (ib, ab) = (cx.fact_value("ios.bundleId").map(str::to_string), cx.fact_value("android.applicationId").map(str::to_string));
    if let (Some(i), Some(a)) = (ib, ab) {
        if i != a {
            cx.add(
                "cross.bundleId.mismatch",
                Severity::Info,
                None,
                None,
                &[("ios", &i), ("android", &a)],
                format!("The iOS bundle identifier is {i} but the Android applicationId is {a}. They are allowed to differ, but sharing one id makes Firebase, deep links and store pages easier to keep straight. Ask me whether they are meant to differ; change nothing unless I say so, because both ids are permanent once published."),
            );
        }
    }
    if let (Some(i), Some(a)) = (cx.fact_value("ios.newArch").map(str::to_string), cx.fact_value("android.newArch").map(str::to_string)) {
        if i != a {
            cx.add(
                "cross.newArch.mismatch",
                Severity::Warn,
                None,
                None,
                &[("ios", &i), ("android", &a)],
                format!("React Native's New Architecture is {i} on iOS (Podfile) but {a} on Android (gradle.properties newArchEnabled). Libraries behave differently on each, and bugs then show up on one platform only. Ask me which setting is intended, set both the same, then run `pod install` and a clean Gradle build."),
            );
        }
    }
    if let (Some(i), Some(a)) = (cx.fact_value("ios.hermes").map(str::to_string), cx.fact_value("android.hermes").map(str::to_string)) {
        if i != a {
            cx.add(
                "cross.hermes.mismatch",
                Severity::Info,
                None,
                None,
                &[("ios", &i), ("android", &a)],
                format!("The Hermes JavaScript engine is {i} on iOS but {a} on Android. Performance and some language features differ between engines. Ask me whether that is intended; if not, set hermes_enabled in the Podfile and hermesEnabled in gradle.properties to the same value."),
            );
        }
    }
}

fn env_files(cx: &mut Ctx) {
    let names: Vec<String> = cx.files.files.iter().filter(|f| !f.contains('/') && f.starts_with(".env")).cloned().collect();
    let real: Vec<&String> = names.iter().filter(|n| !is_example(n)).collect();
    if !real.is_empty() {
        let rules = cx.ignore_rules();
        for n in real {
            if !rules.ignores(n) {
                cx.add(
                    "env.notIgnored",
                    Severity::Error,
                    Some((n, 0)),
                    None,
                    &[("file", n)],
                    format!("{} exists in the project but no .gitignore rule covers it, so it can be committed with its secrets. Add `.env*` and `!.env.example` to .gitignore, check with `git ls-files` whether it is already tracked and tell me (do not rewrite history). Do not open, print or copy the file's values; I will handle the secrets.", q(&cx.path(n))),
                );
            }
        }
    }
    let lib = ["react-native-config", "react-native-dotenv", "react-native-dotenv-plugin", "dotenv"].into_iter().find(|l| cx.pkg.has(l));
    if let Some(lib) = lib {
        if !names.iter().any(|n| !is_example(n)) {
            let example = names.iter().find(|n| is_example(n)).cloned();
            cx.add(
                "env.missing",
                Severity::Info,
                example.as_deref().map(|e| (e, 0)),
                None,
                &[("package", lib)],
                format!("package.json uses {lib}, which reads a .env file, but there is none in the project folder. {} Create .env from the example if there is one and ask me for the values; never invent keys, and keep the file out of git.", if example.is_some() { "An example file exists." } else { "There is no example file either." }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugins_are_read_from_names_and_pairs() {
        let v: Value = serde_json::from_str(r#"{"expo":{"plugins":["expo-camera",["expo-location",{"a":1}],{"x":1},5]}}"#).unwrap();
        assert_eq!(expo_plugins(Some(&v)).into_iter().collect::<Vec<_>>(), vec!["expo-camera", "expo-location"]);
        assert!(expo_plugins(None).is_empty());
    }

    #[test]
    fn example_files_are_not_secrets() {
        assert!(is_example(".env.example") && is_example(".env.sample"));
        assert!(!is_example(".env.local"));
    }
}
