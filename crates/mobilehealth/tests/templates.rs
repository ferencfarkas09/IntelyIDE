//! The stock project layouts of the tools people start from. A health check that cries "error" on a fresh project is worse than
//! none, so none of these may produce an error-level finding.

use std::fs;
use std::path::Path;

use intely_mobilehealth::{scan_with, Env, Severity};

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

fn template(name: &str) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    copy(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/android_templates").join(name), d.path());
    // what Git never holds and the React Native template ships
    if d.path().join("android/app/build.gradle").exists() {
        fs::write(d.path().join("android/app/debug.keystore"), "synthetic").unwrap();
    }
    d
}

fn scan(d: &Path) -> intely_mobilehealth::Project {
    let r = scan_with(d, &Env { android_home: Some("/sdk".into()), ..Env::default() });
    assert!(r.detected);
    r.projects.into_iter().next().unwrap()
}

const ALL: &[&str] = &["as_kotlin", "as_groovy", "multimodule", "convention", "flavors", "rn_autolink", "expo_prebuild", "flutter"];

#[test]
fn no_stock_layout_produces_an_error() {
    for name in ALL {
        let d = template(name);
        let p = scan(d.path());
        let errors: Vec<_> = p.findings.iter().filter(|f| f.severity == Severity::Error).map(|f| (f.id, f.file.clone())).collect();
        assert!(errors.is_empty(), "{name}: {errors:?}");
    }
}

#[test]
fn the_root_script_that_only_declares_the_plugin_is_not_a_module() {
    for name in ["as_kotlin", "as_groovy", "multimodule"] {
        let d = template(name);
        let p = scan(d.path());
        assert!(!p.findings.iter().any(|f| f.file.as_deref().is_some_and(|f| f == "build.gradle" || f == "build.gradle.kts")), "{name}: {:?}", p.findings.iter().map(|f| (f.id, &f.file)).collect::<Vec<_>>());
        let fact = |k: &str| p.facts.iter().find(|f| f.key == k).map(|f| f.value.as_str());
        assert_eq!(fact("android.compileSdk"), Some("34"), "{name}");
        assert_eq!(fact("android.agp"), Some("8.5.2"), "{name}");
        assert_eq!(fact("android.gradle"), Some("8.9"), "{name}");
    }
    // library modules are not application modules either: one set of facts, from the app
    let p = scan(template("multimodule").path());
    assert_eq!(p.facts.iter().find(|f| f.key == "android.applicationId").unwrap().value, "com.acme.multi");
    assert!(!p.findings.iter().any(|f| f.file.as_deref().is_some_and(|f| f.contains("feature") || f.contains("core"))));
}

#[test]
fn a_module_whose_levels_come_from_a_convention_plugin_gets_notes_not_errors() {
    let p = scan(template("convention").path());
    let seen: Vec<_> = p.findings.iter().filter(|f| f.id.starts_with("android.sdk.") || f.id == "android.namespace.missing").collect();
    assert!(!seen.is_empty());
    assert!(seen.iter().all(|f| f.severity == Severity::Info), "{:?}", seen.iter().map(|f| (f.id, f.severity)).collect::<Vec<_>>());
}

#[test]
fn react_native_expo_and_flutter_layouts_are_read_through_their_variables() {
    let p = scan(template("rn_autolink").path());
    let fact = |k: &str| p.facts.iter().find(|f| f.key == k).map(|f| f.value.as_str());
    assert_eq!((fact("android.compileSdk"), fact("android.targetSdk"), fact("android.minSdk")), (Some("34"), Some("34"), Some("23")));
    // the stock release build is signed with the debug key: worth a warning, not an error
    let w = p.findings.iter().find(|f| f.id == "android.signing.releaseUsesDebug").unwrap();
    assert_eq!(w.severity, Severity::Warn);
    // Expo computes the levels with findProperty(...): unknown, so nothing is claimed
    let p = scan(template("expo_prebuild").path());
    assert!(p.findings.iter().all(|f| !f.id.starts_with("android.sdk.")));
    // Flutter writes them as flutter.* and declares the plugin in settings.gradle
    let p = scan(template("flutter").path());
    assert!(p.flutter);
    assert_eq!(p.facts.iter().find(|f| f.key == "android.agp").unwrap().value, "8.1.0");
    assert!(p.findings.iter().all(|f| !f.id.starts_with("android.sdk.") && f.id != "android.namespace.missing"));
}
