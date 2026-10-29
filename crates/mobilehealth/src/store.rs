//! The store-readiness checklist: what can be seen in the repository (icons, privacy manifest, screenshots). What the stores
//! require changes over time, so anything about a required level or a deadline is worded "check the current requirement" and the
//! date of the app's own table is shown beside it.

use crate::data;
use crate::{q, Ctx, Status};

const IMAGE_EXT: &[&str] = &[".png", ".jpg", ".jpeg", ".webp"];

fn is_image(f: &str) -> bool {
    let l = f.to_ascii_lowercase();
    IMAGE_EXT.iter().any(|e| l.ends_with(e))
}

pub(crate) fn run(cx: &mut Ctx) {
    if cx.project.ios {
        ios(cx);
    }
    if cx.project.android {
        android(cx);
    }
}

fn screenshots(cx: &Ctx, roots: &[&str]) -> Option<String> {
    cx.files.files.iter().find(|f| is_image(f) && roots.iter().any(|r| f.contains(r))).cloned()
}

fn ios(cx: &mut Ctx) {
    let manifest = cx.files.named("PrivacyInfo.xcprivacy").next().cloned();
    match manifest {
        Some(f) => cx.check("ios.privacyManifest", "ios", Status::Ok, Some(&f), &[], None),
        None => cx.check(
            "ios.privacyManifest",
            "ios",
            Status::Missing,
            None,
            &[],
            Some("The iOS app has no PrivacyInfo.xcprivacy privacy manifest. Apple's rules about privacy manifests and \"required reason\" APIs change, so first check the current requirement on developer.apple.com. Then find which of those APIs the app and its libraries use (file timestamps, UserDefaults, disk space, system boot time), and add a PrivacyInfo.xcprivacy to the app target that lists them with a truthful reason each. Ask me what data the app collects; do not guess and do not claim that nothing is collected unless I say so.".to_string()),
        ),
    }
    // the 1024 px marketing icon
    let sets: Vec<String> = cx.files.files.iter().filter(|f| f.ends_with(".appiconset/Contents.json") && f.contains("AppIcon")).cloned().collect();
    let mut ok = None;
    for f in &sets {
        let Some(text) = cx.read(f) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let dir = f.rsplit_once('/').map_or("", |(d, _)| d);
        let has = v.get("images").and_then(|i| i.as_array()).is_some_and(|a| {
            a.iter().any(|img| {
                img.get("size").and_then(|s| s.as_str()) == Some("1024x1024")
                    && img.get("filename").and_then(|s| s.as_str()).is_some_and(|n| !n.contains('/') && !n.contains("..") && cx.is_file(&format!("{dir}/{n}")))
            })
        });
        if has {
            ok = Some(f.clone());
            break;
        }
    }
    match ok {
        Some(f) => cx.check("ios.icon", "ios", Status::Ok, Some(&f), &[], None),
        None => {
            let at = sets.first().cloned();
            cx.check(
                "ios.icon",
                "ios",
                Status::Missing,
                at.as_deref(),
                &[],
                Some(format!("The iOS app has no 1024x1024 App Store icon in its AppIcon asset{}. Ask me for the final icon image (do not invent artwork); once I give it, add it to AppIcon.appiconset as the 1024x1024 entry (no transparency, no rounded corners) and keep the other entries.", at.as_ref().map_or(String::new(), |a| format!(" ({})", q(&cx.path(a)))))),
            )
        }
    }
    let launch = cx.files.files.iter().find(|f| f.rsplit('/').next().is_some_and(|n| n.starts_with("LaunchScreen") && (n.ends_with(".storyboard") || n.ends_with(".xib")))).cloned();
    match launch {
        Some(f) => cx.check("ios.launchScreen", "ios", Status::Ok, Some(&f), &[], None),
        None => cx.check("ios.launchScreen", "ios", Status::Check, None, &[], Some("Check whether the iOS app has a launch screen (a LaunchScreen.storyboard or a UILaunchScreen entry in Info.plist). Apps without one are shown letterboxed on newer devices. Tell me what you find before changing anything.".to_string())),
    }
    match screenshots(cx, &["fastlane/screenshots", "fastlane/metadata/ios", "screenshots/ios", "store/ios", "screenshots/iphone"]) {
        Some(f) => cx.check("ios.screenshots", "ios", Status::Ok, Some(&f), &[], None),
        None => cx.check("ios.screenshots", "ios", Status::Check, None, &[], None),
    }
}

fn android(cx: &mut Ctx) {
    let icon = cx.files.files.iter().find(|f| f.contains("/src/main/res/mipmap") && f.rsplit('/').next().is_some_and(|n| n.starts_with("ic_launcher"))).cloned();
    match icon {
        Some(f) => cx.check("android.icon", "android", Status::Ok, Some(&f), &[], None),
        None => cx.check("android.icon", "android", Status::Missing, None, &[], Some("The Android app has no launcher icon (no ic_launcher in any src/main/res/mipmap-* folder). Ask me for the icon artwork (do not invent one), then add an adaptive icon (foreground and background layers) and a plain fallback, and point android:icon and android:roundIcon in the manifest at it.".to_string())),
    }
    let level = data::play_target_api();
    let reviewed = data::reviewed().store;
    match cx.fact_value("android.targetSdk").and_then(|v| v.parse::<u32>().ok()) {
        Some(t) if t >= level => cx.check("android.targetApi", "android", Status::Ok, None, &[("target", &t.to_string()), ("level", &level.to_string()), ("reviewed", &reviewed)], None),
        Some(t) => cx.check(
            "android.targetApi",
            "android",
            Status::Missing,
            None,
            &[("target", &t.to_string()), ("level", &level.to_string()), ("reviewed", &reviewed)],
            Some(format!("targetSdk is {t}. The Play Store requires new apps and updates to target a recent API level and the level changes every year. First check the current requirement in the Play Console help page \"Target API level requirements for Google Play apps\" and tell me the number. Then raise compileSdk and targetSdk to that level, read the Android behavior-change notes for each level in between, run the build, and list what needed changing. Do not change minSdk.")),
        ),
        None => cx.check("android.targetApi", "android", Status::Check, None, &[("level", &level.to_string()), ("reviewed", &reviewed)], None),
    }
    match screenshots(cx, &["fastlane/metadata/android", "screenshots/android", "store/android", "screenshots/phone"]) {
        Some(f) => cx.check("android.screenshots", "android", Status::Ok, Some(&f), &[], None),
        None => cx.check("android.screenshots", "android", Status::Check, None, &[], None),
    }
}
