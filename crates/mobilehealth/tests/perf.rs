//! Hostile shapes that are cheap to write and, in a careless reader, expensive to read: every one stays under the 4 MB read cap and
//! must be handled in a moment. The bound is generous (a loaded, cold CI machine took 4 s for a scan that takes a fraction of a second) and far below what the quadratic versions needed.

use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use intely_mobilehealth::{scan_with, Env};

const LIMIT: Duration = Duration::from_secs(20);
const MANIFEST: &str = "android/app/src/main/AndroidManifest.xml";
const PBX: &str = "ios/App.xcodeproj/project.pbxproj";

fn put(root: &Path, rel: &str, text: impl AsRef<[u8]>) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn base() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "package.json", "{\"dependencies\":{\"react-native\":\"0.74.0\"}}");
    put(d.path(), "ios/Podfile", "platform :ios, '13.0'\n");
    put(d.path(), "android/settings.gradle", "include ':app'\n");
    put(d.path(), "android/app/build.gradle", "apply plugin: 'com.android.application'\nandroid { namespace 'com.acme.x'\n compileSdk 34 }\n");
    d
}

fn bounded(root: &Path, what: &str) {
    let t = Instant::now();
    let r = scan_with(root, &Env { android_home: None, ..Env::default() });
    let took = t.elapsed();
    assert!(r.detected);
    assert!(took < LIMIT, "{what}: the scan took {took:?}");
}

#[test]
fn many_entities_in_a_manifest() {
    let d = base();
    put(d.path(), MANIFEST, format!("<manifest><application android:label=\"{}\"/></manifest>", "&amp;".repeat(700_000)));
    bounded(d.path(), "&amp; x 700k");
    let d = base();
    put(d.path(), MANIFEST, format!("<manifest>{}</manifest>", "&amp;".repeat(700_000)));
    bounded(d.path(), "text of &amp;");
}

#[test]
fn many_declarations_in_a_manifest() {
    let d = base();
    put(d.path(), MANIFEST, format!("<manifest>{}</manifest>", "<!>".repeat(1_300_000)));
    bounded(d.path(), "<!> x 1.3M");
    let d = base();
    put(d.path(), MANIFEST, format!("<manifest>{}</manifest>", "<?>".repeat(1_300_000)));
    bounded(d.path(), "<?> x 1.3M");
    let d = base();
    put(d.path(), MANIFEST, format!("<manifest>{}</manifest>", "<!-->".repeat(700_000)));
    bounded(d.path(), "<!--> x 700k");
}

#[test]
fn a_huge_attribute_list_and_many_tags() {
    let d = base();
    put(d.path(), MANIFEST, format!("<manifest><application {}/></manifest>", "a=\"1\" ".repeat(500_000)));
    bounded(d.path(), "500k attributes");
    let d = base();
    put(d.path(), MANIFEST, format!("<manifest>{}</manifest>", "<uses-permission android:name=\"x\"/>".repeat(100_000)));
    bounded(d.path(), "100k tags");
}

fn pbx_with(configs: usize, targets: usize) -> String {
    let mut s = String::from("{ rootObject = P; objects = {\n");
    for i in 0..configs {
        s.push_str(&format!("C{i} = {{ isa = XCBuildConfiguration; name = n{i}; buildSettings = {{ }}; }};\n"));
    }
    for i in 0..targets {
        s.push_str(&format!("T{i} = {{ isa = PBXNativeTarget; name = t{i}; productType = \"com.apple.product-type.application\"; buildConfigurationList = L; }};\n"));
    }
    s.push_str("L = { isa = XCConfigurationList; buildConfigurations = (");
    for i in 0..configs {
        s.push_str(&format!("C{i},"));
    }
    s.push_str("); };\nP = { isa = PBXProject; buildConfigurationList = L; targets = (");
    for i in 0..targets {
        s.push_str(&format!("T{i},"));
    }
    s.push_str("); }; }; }\n");
    s
}

#[test]
fn a_project_with_tens_of_thousands_of_configurations_and_targets() {
    let d = base();
    put(d.path(), PBX, pbx_with(40_000, 1));
    bounded(d.path(), "40k configurations");
    let d = base();
    put(d.path(), PBX, pbx_with(2, 20_000));
    bounded(d.path(), "20k targets");
    let d = base();
    put(d.path(), PBX, pbx_with(200, 200));
    bounded(d.path(), "200 x 200");
}

#[test]
fn a_configuration_with_a_huge_settings_dictionary() {
    let d = base();
    let mut s = String::from("{ rootObject = P; objects = { C = { isa = XCBuildConfiguration; name = Release; buildSettings = {\n");
    for i in 0..60_000 {
        s.push_str(&format!("K{i} = v{i};\n"));
    }
    s.push_str("}; }; L = { isa = XCConfigurationList; buildConfigurations = (C); }; T = { isa = PBXNativeTarget; name = App; productType = \"com.apple.product-type.application\"; buildConfigurationList = L; }; P = { isa = PBXProject; buildConfigurationList = L; targets = (T); }; }; }");
    put(d.path(), PBX, s);
    bounded(d.path(), "60k settings");
}

#[test]
fn gradle_files_full_of_braces_quotes_and_triple_quotes() {
    for (name, body) in [
        ("braces", "{ ".repeat(1_500_000)),
        ("closers", "} ".repeat(1_500_000)),
        ("quotes", "\"'".repeat(1_900_000)),
        ("triple", "\"\"\"".repeat(1_300_000)),
        ("blocks", "android { signingConfigs { x { storePassword 'a' } } }\n".repeat(60_000)),
        ("names", "signingConfigs { a {} b {} c {} } buildTypes { release { } }\n".repeat(60_000)),
        ("lines", "versionCode 1\n".repeat(280_000)),
    ] {
        let d = base();
        put(d.path(), "android/app/build.gradle", format!("apply plugin: 'com.android.application'\nandroid {{\n{body}\n}}\n"));
        bounded(d.path(), name);
    }
}

#[test]
fn properties_and_podfiles_with_a_million_lines() {
    let d = base();
    put(d.path(), "android/gradle.properties", "a=b\n".repeat(900_000));
    put(d.path(), "ios/Podfile", "platform :ios, 'x'\n# c\n".repeat(200_000));
    bounded(d.path(), "lines");
}

#[test]
fn a_folder_with_thousands_of_names_still_finds_the_well_known_ones() {
    let d = base();
    for i in 0..6000 {
        put(d.path(), &format!("android/a{i:05}"), "x");
    }
    let r = scan_with(d.path(), &Env { android_home: None, ..Env::default() });
    // build.gradle and settings.gradle sort after the first 5000 names of this folder; they must still be seen
    assert!(r.projects[0].android);
}
