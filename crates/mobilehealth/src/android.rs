//! Android checks: Gradle scripts, `gradle.properties`, the Gradle wrapper, signing, the manifest and its permissions.

use std::collections::BTreeSet;
use std::ops::Range;

use crate::data::{self, cmp_version};
use crate::gradle::{blocks, children, line_of, literal, number, number_after_name, properties, reference_name, settings, strip_comments};
use crate::perm::{self, Perms};
use crate::xml::{self, Tok};
use crate::{q, Confidence, Ctx, Severity};

const MAX_MODULES: usize = 4;
const PLACEHOLDER_APP_IDS: &[&str] = &["com.example", "com.myapp", "com.helloworld", "com.anonymous", "com.yourcompany", "com.mycompany", "org.example"];
/// Permissions the Play Store restricts or reviews more closely; the wording always says to check the current policy.
const SENSITIVE: &[&str] = &[
    "android.permission.READ_SMS",
    "android.permission.SEND_SMS",
    "android.permission.RECEIVE_SMS",
    "android.permission.READ_CALL_LOG",
    "android.permission.WRITE_CALL_LOG",
    "android.permission.CALL_PHONE",
    "android.permission.READ_PHONE_STATE",
    "android.permission.ACCESS_BACKGROUND_LOCATION",
    "android.permission.MANAGE_EXTERNAL_STORAGE",
    "android.permission.REQUEST_INSTALL_PACKAGES",
    "android.permission.SYSTEM_ALERT_WINDOW",
    "android.permission.QUERY_ALL_PACKAGES",
];

struct Script {
    rel: String,
    clean: String,
}

fn dir_of(rel: &str) -> &str {
    rel.rsplit_once('/').map_or("", |(d, _)| d)
}

fn at(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// Joins lexically; `None` when the result leaves the project.
fn norm(base: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = base.split('/').filter(|p| !p.is_empty()).collect();
    for p in rel.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p => parts.push(p),
        }
    }
    Some(parts.join("/"))
}

fn plugin_version(root: &str, toml: Option<&str>) -> Option<String> {
    let ver_at = |s: &str| -> Option<String> {
        let v: String = s.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-').collect();
        v.chars().next().filter(char::is_ascii_digit).map(|_| v)
    };
    if let Some(p) = root.find("com.android.tools.build:gradle:") {
        if let Some(v) = ver_at(&root[p + "com.android.tools.build:gradle:".len()..]) {
            return Some(v);
        }
    }
    let mut from = 0;
    while let Some(p) = root[from..].find("com.android.application") {
        let start = from + p + "com.android.application".len();
        let window = root.get(start..(start + 80).min(root.len())).unwrap_or("");
        let window = window.split('\n').next().unwrap_or("");
        if let Some(v) = window.find("version") {
            let tail = window[v + 7..].trim_start_matches([' ', '(', '"', '\'']);
            if let Some(v) = ver_at(tail) {
                return Some(v);
            }
        }
        from = start;
    }
    let toml = toml?;
    for l in toml.lines() {
        let l = l.trim();
        if let Some((k, v)) = l.split_once('=') {
            let k = k.trim();
            if k == "agp" || k == "androidGradlePlugin" || k == "android-gradle-plugin" {
                return ver_at(v.trim().trim_matches('"'));
            }
        }
    }
    None
}

pub(crate) fn run(cx: &mut Ctx, perms: &Perms) {
    let mut scripts: Vec<Script> = Vec::new();
    let names: Vec<String> = cx.files.files.iter().filter(|f| matches!(f.rsplit('/').next(), Some("build.gradle" | "build.gradle.kts"))).take(40).cloned().collect();
    for rel in names {
        if let Some(t) = cx.read(&rel) {
            scripts.push(Script { clean: strip_comments(&t), rel });
        }
    }
    // the folder of the Gradle build: the shallowest one with a settings script, else with a build script
    let settings_dir = cx.files.files.iter().filter(|f| matches!(f.rsplit('/').next(), Some("settings.gradle" | "settings.gradle.kts"))).map(|f| dir_of(f).to_string()).min_by_key(|d| d.len());
    let root_dir = settings_dir.or_else(|| scripts.iter().map(|s| dir_of(&s.rel).to_string()).min_by_key(|d| d.len()));
    let Some(root_dir) = root_dir else { return };
    let root_script = scripts.iter().find(|s| dir_of(&s.rel) == root_dir).map(|s| s.clean.clone()).unwrap_or_default();
    let props_rel = at(&root_dir, "gradle.properties");
    let props_text = cx.read(&props_rel);
    let props = props_text.as_deref().map(properties).unwrap_or_default();
    let prop = |k: &str| props.iter().find(|p| p.0 == k);
    let toml = cx.read(&at(&root_dir, "gradle/libs.versions.toml"));
    let agp = plugin_version(&root_script, toml.as_deref());
    if let Some(v) = &agp {
        cx.fact("android.agp", v.clone(), None);
    }

    wrapper(cx, &root_dir, agp.as_deref());
    sdk_dir(cx, &root_dir);

    // gradle.properties
    for (key, fact) in [("newArchEnabled", "android.newArch"), ("hermesEnabled", "android.hermes")] {
        if let Some((_, v, line)) = prop(key) {
            if v == "true" || v == "false" {
                cx.fact(fact, if v == "true" { "on" } else { "off" }, Some((&props_rel, *line)));
            }
        }
    }
    if cx.project.react_native && props_text.is_some() && prop("android.useAndroidX").is_none_or_false() {
        cx.add(
            "android.androidx.off",
            Severity::Warn,
            Some((&props_rel, prop("android.useAndroidX").map_or(0, |p| p.2))),
            None,
            &[],
            format!("{} does not turn on android.useAndroidX, which React Native's libraries need; the build fails with duplicate class or manifest merger errors. Set `android.useAndroidX=true` there and tell me if the build then reports anything else.", q(&cx.path(&props_rel))),
        );
    }
    for (k, v, line) in &props {
        let low = k.to_ascii_lowercase();
        let secretish = ["password", "passwd", "secret", "token", "apikey", "api_key"].iter().any(|w| low.contains(w));
        let placeholder = v.is_empty() || v.chars().all(|c| c == '*') || v.starts_with('$') || v.starts_with('<');
        if secretish && !placeholder {
            plaintext(cx, &props_rel, *line, k, "gradle.properties");
        }
    }

    // app modules
    let ext_source = format!("{root_script}\n{}", scripts.iter().map(|s| s.clean.as_str()).collect::<Vec<_>>().join("\n"));
    let mut first_module = true;
    let modules: Vec<&Script> = scripts.iter().filter(|s| s.clean.contains("com.android.application") || s.clean.contains("android.application")).take(MAX_MODULES).collect();
    for s in modules {
        module(cx, s, &root_dir, &ext_source, agp.as_deref(), &props, perms, first_module);
        first_module = false;
    }
    keystores(cx);
}

trait NoneOrFalse {
    fn is_none_or_false(&self) -> bool;
}
impl NoneOrFalse for Option<&(String, String, u32)> {
    fn is_none_or_false(&self) -> bool {
        self.map_or(true, |p| p.1 != "true")
    }
}

fn wrapper(cx: &mut Ctx, root_dir: &str, agp: Option<&str>) {
    let rel = at(root_dir, "gradle/wrapper/gradle-wrapper.properties");
    let Some(text) = cx.read(&rel) else {
        cx.add(
            "android.gradle.noWrapper",
            Severity::Warn,
            Some((&at(root_dir, "gradle/wrapper"), 0)),
            None,
            &[],
            "The Android project has no Gradle wrapper (gradle/wrapper/gradle-wrapper.properties), so nobody else can build it with the Gradle version it was written for. Generate it with `gradle wrapper --gradle-version <version>` (ask me which version, or use the one the Android Gradle plugin needs) and commit gradlew, gradlew.bat and the gradle/wrapper folder.".to_string(),
        );
        return;
    };
    let Some((url, line)) = properties(&text).into_iter().find(|p| p.0 == "distributionUrl").map(|p| (p.1, p.2)) else { return };
    let file = url.rsplit('/').next().unwrap_or("");
    let ver = file.strip_prefix("gradle-").and_then(|r| r.strip_suffix("-bin.zip").or_else(|| r.strip_suffix("-all.zip")));
    let Some(ver) = ver.filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit())) else { return };
    cx.fact("android.gradle", ver, Some((&rel, line)));
    let Some(agp) = agp else { return };
    match data::min_gradle(agp) {
        Some(min) if cmp_version(ver, min) == std::cmp::Ordering::Less => cx.add(
            "android.gradle.tooOld",
            Severity::Error,
            Some((&rel, line)),
            None,
            &[("gradle", ver), ("agp", agp), ("min", min)],
            format!("The Gradle wrapper is at {ver} but Android Gradle plugin {agp} needs Gradle {min} or newer, so the build stops at configuration. Update distributionUrl in {} to a Gradle version of at least {min} (check the current compatibility table on developer.android.com before choosing one), then run a build and report what it says.", q(&cx.path(&rel))),
        ),
        Some(_) => {}
        None => cx.add(
            "android.gradle.unknownAgp",
            Severity::Info,
            Some((&rel, line)),
            None,
            &[("gradle", ver), ("agp", agp), ("reviewed", &data::reviewed().compat)],
            format!("Android Gradle plugin {agp} is not in the compatibility table this app carries (last reviewed {}), so Gradle {ver} could not be checked against it. Look up the required Gradle version for plugin {agp} on developer.android.com and tell me whether {ver} is enough; change nothing unless it is not.", data::reviewed().compat),
        ),
    }
}

fn sdk_dir(cx: &mut Ctx, root_dir: &str) {
    if cx.env.android_home.is_some() {
        return;
    }
    let rel = at(root_dir, "local.properties");
    match cx.read(&rel) {
        Some(t) => {
            if !properties(&t).iter().any(|p| p.0 == "sdk.dir" && !p.1.is_empty()) {
                cx.add(
                    "android.sdkDir.missing",
                    Severity::Warn,
                    Some((&rel, 0)),
                    None,
                    &[],
                    format!("{} has no sdk.dir and ANDROID_HOME is not set, so Gradle cannot find the Android SDK. Open the project in Android Studio (it writes sdk.dir), or add `sdk.dir=<path to my Android SDK>` to that file; ask me for the path. The file must stay out of git.", q(&cx.path(&rel))),
                );
            }
        }
        None => cx.add(
            "android.sdkDir.missing",
            Severity::Info,
            Some((&rel, 0)),
            None,
            &[],
            "There is no local.properties and ANDROID_HOME is not set in the environment the app sees (macOS apps do not inherit shell variables), so a Gradle build started from here may not find the Android SDK. Android Studio creates local.properties on first open. If I build from a terminal where ANDROID_HOME is set, ignore this; otherwise ask me for the SDK path and write `sdk.dir=<path>` into android/local.properties (never commit it).".to_string(),
        ),
    }
}

fn plaintext(cx: &mut Ctx, file: &str, line: u32, key: &str, place: &str) {
    cx.add(
        "android.secrets.plaintext",
        Severity::Error,
        Some((file, line)),
        None,
        &[("key", key), ("place", place)],
        format!("{} line {line} holds a password or secret in plain text under the name {key}. Move it out of the repository: read it from an environment variable or from ~/.gradle/gradle.properties instead (System.getenv(\"NAME\") in the Gradle script), update the script, and tell me which names to set. Do not print, copy or log the current value anywhere, and remind me to change that password because it is already in the file (and possibly in git history).", q(&cx.path(file))),
    );
}

#[allow(clippy::too_many_arguments)]
fn module(cx: &mut Ctx, s: &Script, root_dir: &str, ext_source: &str, agp: Option<&str>, props: &[(String, String, u32)], perms: &Perms, primary: bool) {
    let dir = dir_of(&s.rel).to_string();
    let t = &s.clean;
    let android: Range<usize> = blocks(t, 0..t.len(), "android").into_iter().next().unwrap_or(0..0);
    let one = |keys: &[&str]| -> Option<(String, usize)> { keys.iter().find_map(|k| settings(t, android.clone(), k).into_iter().next()) };
    let value = |keys: &[&str]| -> (Option<u32>, bool, u32) {
        // (resolved number, written at all, line)
        let Some((raw, off)) = one(keys) else { return (None, false, 0) };
        let line = line_of(t, off);
        if let Some(n) = number(&raw) {
            return (Some(n), true, line);
        }
        let n = reference_name(&raw).and_then(|name| number_after_name(ext_source, &name));
        (n, true, line)
    };
    let (mut compile, mut compile_set, compile_line) = value(&["compileSdk", "compileSdkVersion"]);
    if !compile_set {
        for body in blocks(t, android.clone(), "compileSdk") {
            if let Some(p) = t[body.clone()].find("release(") {
                compile = number(&t[body.start + p + 8..].chars().take_while(char::is_ascii_digit).collect::<String>());
                compile_set = true;
            }
        }
    }
    let (target, target_set, target_line) = value(&["targetSdk", "targetSdkVersion"]);
    let (min, _, min_line) = value(&["minSdk", "minSdkVersion"]);
    if primary {
        for (k, v, l) in [("android.compileSdk", compile, compile_line), ("android.targetSdk", target, target_line), ("android.minSdk", min, min_line)] {
            if let Some(v) = v {
                cx.fact(k, v.to_string(), Some((&s.rel, l)));
            }
        }
    }
    if !compile_set {
        cx.add(
            "android.sdk.compileMissing",
            Severity::Error,
            Some((&s.rel, if android.is_empty() { 0 } else { line_of(t, android.start) })),
            None,
            &[],
            format!("{} does not set compileSdk, so Gradle cannot build the module. Add `compileSdk` to the android block, using the same value as the rest of the project (look at targetSdk and the root build.gradle) and tell me which level you chose.", q(&cx.path(&s.rel))),
        );
    }
    if let (Some(tg), Some(c)) = (target, compile) {
        if tg > c {
            cx.add(
                "android.sdk.targetAboveCompile",
                Severity::Error,
                Some((&s.rel, target_line)),
                None,
                &[("target", &tg.to_string()), ("compile", &c.to_string())],
                format!("In {} targetSdk ({tg}) is higher than compileSdk ({c}). The app cannot be compiled against an API level it targets but does not have. Raise compileSdk to at least {tg} (and make sure that SDK platform is installed) or lower targetSdk; tell me which you chose.", q(&cx.path(&s.rel))),
            );
        }
    }
    if let (Some(mi), Some(tg)) = (min, target) {
        if mi > tg {
            cx.add(
                "android.sdk.minAboveTarget",
                Severity::Error,
                Some((&s.rel, min_line)),
                None,
                &[("min", &mi.to_string()), ("target", &tg.to_string())],
                format!("In {} minSdk ({mi}) is higher than targetSdk ({tg}), which Android Studio treats as an error. Set targetSdk to at least {mi}, normally the same as compileSdk, and tell me the values.", q(&cx.path(&s.rel))),
            );
        }
    }
    if !target_set && !android.is_empty() {
        cx.add(
            "android.sdk.targetMissing",
            Severity::Warn,
            Some((&s.rel, line_of(t, android.start))),
            None,
            &[],
            format!("{} does not set targetSdk, so the app behaves as if it targets its minSdk and the Play Store will refuse the upload. Add targetSdk to defaultConfig; ask me which level I want (normally the same as compileSdk). Check the current Play requirement before choosing.", q(&cx.path(&s.rel))),
        );
    }

    // namespace and application id
    let ns = one(&["namespace"]).and_then(|(raw, off)| literal(&raw).map(|v| (v, line_of(t, off))));
    if ns.is_none() && one(&["namespace"]).is_none() {
        let major = agp.and_then(|a| a.split('.').next()).and_then(|m| m.parse::<u32>().ok());
        let sev = match major {
            Some(m) if m >= 8 => Severity::Error,
            Some(_) => Severity::Info,
            None => Severity::Warn,
        };
        cx.add(
            "android.namespace.missing",
            sev,
            Some((&s.rel, if android.is_empty() { 0 } else { line_of(t, android.start) })),
            None,
            &[],
            format!("{} has no namespace. Android Gradle plugin 8 and newer refuse to build without one (older versions took the package from AndroidManifest.xml). Add `namespace \"<package>\"` to the android block using the package that is at the top of the Kotlin/Java sources (and in the manifest's package attribute if there is one); do not change applicationId.", q(&cx.path(&s.rel))),
        );
    }
    let app_id = one(&["applicationId"]).and_then(|(raw, off)| literal(&raw).map(|v| (v, line_of(t, off))));
    if primary {
        if let Some((id, l)) = app_id.as_ref().or(ns.as_ref()) {
            cx.fact("android.applicationId", id.clone(), Some((&s.rel, *l)));
        }
    }
    if let Some((id, l)) = &app_id {
        let segs: Vec<&str> = id.split('.').collect();
        let valid = segs.len() >= 2 && segs.iter().all(|p| p.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
        if !valid {
            cx.add(
                "android.appId.invalid",
                Severity::Error,
                Some((&s.rel, *l)),
                None,
                &[("applicationId", id)],
                format!("The applicationId {} in {} is not a valid Android package name (at least two parts separated by dots, each starting with a letter and using only letters, digits and underscores). Ask me for the real id before changing it; it is permanent once the app is published.", q(id), q(&cx.path(&s.rel))),
            );
        } else if PLACEHOLDER_APP_IDS.iter().any(|p| id == p || id.starts_with(&format!("{p}."))) {
            cx.add(
                "android.appId.placeholder",
                Severity::Warn,
                Some((&s.rel, *l)),
                None,
                &[("applicationId", id)],
                format!("The applicationId {} in {} looks like a template placeholder. It is permanent once the app is on the Play Store. Ask me for the real id (it should match the iOS bundle identifier when the apps are meant to be twins), then set applicationId and update what mentions the old one (google-services.json, Expo config, deep link schemes). Do not move the Kotlin/Java sources unless I ask.", q(id), q(&cx.path(&s.rel))),
            );
        }
    }

    // versions
    let code = one(&["versionCode"]);
    let name = one(&["versionName"]);
    if let Some((raw, off)) = &code {
        if let Some(n) = number(raw) {
            if primary {
                cx.fact("android.versionCode", n.to_string(), Some((&s.rel, line_of(t, *off))));
            }
            if n == 0 || n > 2_100_000_000 {
                cx.add(
                    "android.version.codeInvalid",
                    Severity::Error,
                    Some((&s.rel, line_of(t, *off))),
                    None,
                    &[("versionCode", &n.to_string())],
                    format!("versionCode {n} in {} is outside what the Play Store accepts (1 to 2,100,000,000). Ask me what the last published versionCode is and set the next higher whole number.", q(&cx.path(&s.rel))),
                );
            }
        }
    }
    if let Some((raw, off)) = &name {
        if let Some(v) = literal(raw) {
            if primary {
                cx.fact("android.versionName", v, Some((&s.rel, line_of(t, *off))));
            }
        }
    }
    if code.is_none() && name.is_none() && !android.is_empty() {
        cx.add(
            "android.version.missing",
            Severity::Info,
            Some((&s.rel, line_of(t, android.start))),
            None,
            &[],
            format!("{} sets neither versionCode nor versionName, so the app is version 1 on every build and the Play Store will not accept an update. Add both to defaultConfig; ask me for the current version name and the last published versionCode.", q(&cx.path(&s.rel))),
        );
    }

    signing(cx, s, &android, &dir, root_dir, props);
    manifest(cx, &dir, target, perms);
}

fn signing(cx: &mut Ctx, s: &Script, android: &Range<usize>, module_dir: &str, root_dir: &str, props: &[(String, String, u32)]) {
    let t = &s.clean;
    for sc in blocks(t, android.clone(), "signingConfigs") {
        for (name, body) in children(t, sc) {
            let get = |k: &str| settings(t, body.clone(), k).into_iter().next();
            for key in ["storePassword", "keyPassword"] {
                if let Some((raw, off)) = get(key) {
                    if let Some(v) = literal(&raw) {
                        // the well-known password of the debug key every Android project has is not a secret
                        if name == "debug" && v == "android" {
                            continue;
                        }
                        if !v.is_empty() {
                            plaintext(cx, &s.rel, line_of(t, off), key, "gradle");
                        }
                    }
                }
            }
            let Some((raw, off)) = get("storeFile") else { continue };
            let line = line_of(t, off);
            // the first quoted literal, or the property named inside file(...)
            let (lit, from_root) = (
                raw.find(['"', '\'']).and_then(|p| literal(raw[p..].trim_end_matches(')'))),
                raw.contains("rootProject.file"),
            );
            let path = lit.or_else(|| reference_name(&raw).and_then(|n| props.iter().find(|p| p.0 == n).map(|p| p.1.clone())));
            let Some(path) = path.filter(|p| !p.is_empty()) else { continue };
            if path.starts_with('/') || path.starts_with('~') || path.contains(":\\") {
                if path.starts_with("/Users/") || path.starts_with("/home/") || path.contains(":\\") {
                    cx.add(
                        "android.signing.absoluteKeystore",
                        Severity::Warn,
                        Some((&s.rel, line)),
                        None,
                        &[("config", &name)],
                        format!("Signing config {} in {} points at a keystore by an absolute path inside a home folder, which exists only on one machine. Use a path relative to the project or read it from a Gradle property, and ask me where the keystore should live. Do not copy the keystore file into the repository.", q(&name), q(&cx.path(&s.rel))),
                    );
                }
                continue;
            }
            let base = if from_root { root_dir } else { module_dir };
            let Some(full) = norm(base, &path) else { continue };
            if !cx.is_file(&full) {
                let sev = if name == "debug" { Severity::Error } else { Severity::Warn };
                cx.add(
                    "android.signing.keystoreMissing",
                    sev,
                    Some((&s.rel, line)),
                    None,
                    &[("config", &name), ("keystore", &full)],
                    format!("Signing config {} in {} names the keystore {} but that file does not exist, so building with it fails. If this is the release key it is normally kept out of git on purpose: ask me where it is and do not create or generate a new one. For the debug config, restore debug.keystore from the project template.", q(&name), q(&cx.path(&s.rel)), q(&full)),
                );
            }
        }
    }
    for bt in blocks(t, android.clone(), "buildTypes") {
        for (name, body) in children(t, bt) {
            if name != "release" {
                continue;
            }
            if let Some((raw, off)) = settings(t, body, "signingConfig").into_iter().next() {
                if raw.contains("signingConfigs.debug") || raw.contains("getByName(\"debug\")") || raw.contains("getByName('debug')") {
                    cx.add(
                        "android.signing.releaseUsesDebug",
                        Severity::Error,
                        Some((&s.rel, line_of(t, off))),
                        None,
                        &[],
                        format!("The release build type in {} is signed with the debug key. The Play Store rejects such uploads, and an app signed that way can never be updated with the real key. Add a release signing config that reads its keystore path and passwords from environment variables or ~/.gradle/gradle.properties, use it for release, and ask me for the names; do not create a keystore or print any password.", q(&cx.path(&s.rel))),
                    );
                }
            }
        }
    }
}

/// Keystore files in the Android folder that no ignore rule covers.
fn keystores(cx: &mut Ctx) {
    let found: Vec<String> = cx
        .files
        .files
        .iter()
        .filter(|f| f.starts_with("android/") && (f.ends_with(".jks") || f.ends_with(".keystore")) && f.rsplit('/').next() != Some("debug.keystore"))
        .take(5)
        .cloned()
        .collect();
    if found.is_empty() {
        return;
    }
    let rules = cx.ignore_rules();
    for f in found {
        let name = f.rsplit('/').next().unwrap_or("").to_string();
        if !rules.ignores(&name) {
            cx.add(
                "android.keystore.notIgnored",
                Severity::Error,
                Some((&f, 0)),
                None,
                &[("file", &name)],
                format!("The signing keystore {} sits in the repository and no .gitignore rule covers it. Anyone with the repository could sign apps as me. Add `*.jks` and `*.keystore` (keeping `!debug.keystore`) to .gitignore, check with `git ls-files` whether it is already tracked and tell me; if it is, do not rewrite history yourself, just tell me so I can decide.", q(&cx.path(&f))),
            );
        }
    }
}

fn manifest(cx: &mut Ctx, module_dir: &str, target: Option<u32>, perms: &Perms) {
    let rel = at(module_dir, "src/main/AndroidManifest.xml");
    let Some(text) = cx.read(&rel) else { return };
    let Some(toks) = xml::tokens(&text) else {
        cx.skipped.push(format!("unreadable:{}", cx.path(&rel)));
        return;
    };
    let mut declared: Vec<(String, u32)> = Vec::new();
    for t in &toks {
        if let Tok::Open { name, attrs, line, .. } = t {
            let get = |k: &str| attrs.iter().find(|a| a.0 == k).map(|a| a.1.as_str());
            match name.as_str() {
                "uses-permission" | "uses-permission-sdk-23" => {
                    if let Some(n) = get("android:name") {
                        declared.push((n.to_string(), *line));
                    }
                }
                "application" => {
                    if get("android:debuggable") == Some("true") {
                        cx.add(
                            "android.manifest.debuggable",
                            Severity::Error,
                            Some((&rel, *line)),
                            None,
                            &[],
                            format!("{} sets android:debuggable=\"true\" on the application. Release builds must not be debuggable (anyone can attach a debugger and read the app's data), and the Play Store rejects them. Remove the attribute from the main manifest (Gradle makes debug builds debuggable by itself) and tell me if a debug-only manifest needs it.", q(&cx.path(&rel))),
                        );
                    }
                    if get("android:usesCleartextTraffic") == Some("true") {
                        cx.add(
                            "android.manifest.cleartext",
                            Severity::Warn,
                            Some((&rel, *line)),
                            None,
                            &[],
                            format!("{} allows unencrypted http traffic for every build (android:usesCleartextTraffic=\"true\"). Move it to the debug manifest (src/debug/AndroidManifest.xml) if it is only for local development servers, or list the exact domains in a network security config. Ask me which hosts the app really talks to over http.", q(&cx.path(&rel))),
                        );
                    }
                }
                _ => {}
            }
        }
    }
    let expo_perms: BTreeSet<String> = cx
        .pkg
        .app_json
        .as_ref()
        .and_then(|v| v.pointer("/expo/android/permissions"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| if s.contains('.') { s.to_string() } else { format!("android.permission.{s}") }).collect())
        .unwrap_or_default();
    let has = |p: &str| declared.iter().any(|d| d.0 == p) || expo_perms.contains(p);
    for def in perm::defs() {
        if def.android.is_empty() {
            continue;
        }
        let used = perms.android.get(&def.id);
        let declared_any = def.android.iter().any(|p| has(p));
        match (used, declared_any) {
            (Some(ev), false) => {
                if def.id == "notifications" && target.is_some_and(|t| t < 33) {
                    continue;
                }
                let sev = match ev.confidence {
                    Confidence::High => Severity::Error,
                    Confidence::Medium => Severity::Info,
                    Confidence::Low => continue,
                };
                let name = def.android[0].as_str();
                let why = perm::describe(&ev.why);
                cx.add(
                    "android.permission.undeclared",
                    sev,
                    Some((&rel, 0)),
                    Some(ev.confidence),
                    &[("permission", &def.id), ("name", name), ("evidence", &ev.why)],
                    format!("The app seems to use the {} permission (based on {why}), but {} does not declare {name}. On Android the call then fails or crashes, unless the library adds the permission itself (many do through manifest merging; check the merged manifest before changing anything). If the app uses it, add <uses-permission android:name=\"{name}\" /> to the main manifest; if not, say so and change nothing.", def.id, q(&cx.path(&rel))),
                );
            }
            (None, true) => {
                let (name, line) = declared.iter().find(|d| def.android.contains(&d.0)).cloned().unwrap_or_default();
                cx.add(
                    "android.permission.unused",
                    Severity::Info,
                    Some((&rel, line)),
                    Some(Confidence::Low),
                    &[("permission", &def.id), ("name", &name)],
                    format!("{} declares {name} but nothing in package.json or the project's native code seems to use the {} permission. Every permission is shown to users in the store and some trigger extra review. Check whether the app (or a library, through JavaScript calls) needs it; remove the line only if nothing does, and tell me what you found.", q(&cx.path(&rel)), def.id),
                );
            }
            _ => {}
        }
    }
    for (name, line) in &declared {
        if SENSITIVE.contains(&name.as_str()) {
            cx.add(
                "android.permission.sensitive",
                Severity::Warn,
                Some((&rel, *line)),
                None,
                &[("name", name)],
                format!("{} declares {name}, a permission the Play Store restricts or reviews closely and that usually needs a declaration form before the app is accepted. Check the current Play policy for it. Then find out whether the app really needs it and tell me; remove it only if nothing uses it.", q(&cx.path(&rel))),
            );
        }
    }
}
