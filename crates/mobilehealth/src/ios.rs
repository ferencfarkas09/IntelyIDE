//! iOS checks: the Xcode project (`project.pbxproj`), `Info.plist`, entitlements, the Podfile and its lock files.

use std::collections::BTreeSet;

use crate::data::cmp_version;
use crate::openstep::{self, Node};
use crate::perm::{self, Perms};
use crate::xml::{self, PVal};
use crate::{q, Confidence, Ctx, Severity};

const APP: &str = "com.apple.product-type.application";
const PLACEHOLDER_IDS: &[&str] = &["org.reactjs.native.example", "com.example", "com.anonymous", "com.yourcompany", "com.mycompany", "org.example"];

#[derive(Clone)]
struct Setting {
    key: String,
    value: String,
    line: u32,
}

struct Cfg {
    name: String,
    line: u32,
    settings: Vec<Setting>,
    /// A build setting file other than CocoaPods' own: values can come from there, so a missing one proves nothing.
    custom_base: bool,
}

impl Cfg {
    fn get(&self, key: &str) -> Option<&Setting> {
        self.settings.iter().find(|s| s.key == key)
    }
}

#[derive(PartialEq, Clone, Copy)]
enum Kind {
    App,
    Extension,
    Other,
}

struct Target {
    name: String,
    kind: Kind,
    cfgs: Vec<Cfg>,
}

struct Model {
    project: Vec<Cfg>,
    targets: Vec<Target>,
}

impl Model {
    /// The setting as the target sees it in one configuration: its own, else the project's.
    fn eff(&self, t: &Target, cfg: &str, key: &str) -> Option<Setting> {
        let own = t.cfgs.iter().find(|c| c.name == cfg).and_then(|c| c.get(key));
        let own = own.filter(|s| !s.value.contains("$(inherited)") && !s.value.contains("${inherited}"));
        own.or_else(|| self.project.iter().find(|c| c.name == cfg).and_then(|c| c.get(key))).cloned()
    }
    fn cfg<'a>(&self, t: &'a Target, name: &str) -> Option<&'a Cfg> {
        t.cfgs.iter().find(|c| c.name == name)
    }
}

fn cfgs_of(objects: &Node, list_id: &str) -> Vec<Cfg> {
    let Some(list) = objects.get(list_id) else { return Vec::new() };
    let mut out = Vec::new();
    for id in list.get("buildConfigurations").map(Node::items).unwrap_or(&[]) {
        let Some(c) = id.str().and_then(|i| objects.get(i)) else { continue };
        if c.gets("isa") != Some("XCBuildConfiguration") {
            continue;
        }
        let bs = c.get("buildSettings");
        let settings = bs
            .map(|b| b.entries().iter().filter_map(|(k, n)| n.str().map(|v| Setting { key: k.clone(), value: v.to_string(), line: n.line })).collect())
            .unwrap_or_default();
        let custom_base = c
            .gets("baseConfigurationReference")
            .and_then(|r| objects.get(r))
            .and_then(|f| f.gets("path"))
            .is_some_and(|p| !p.contains("Pods"));
        out.push(Cfg { name: c.gets("name").unwrap_or("").to_string(), line: bs.map_or(c.line, |b| b.line), settings, custom_base });
    }
    out
}

fn model(root: &Node) -> Option<Model> {
    let objects = root.get("objects")?;
    let project = objects.get(root.gets("rootObject")?)?;
    let proj_cfgs = project.gets("buildConfigurationList").map(|l| cfgs_of(objects, l)).unwrap_or_default();
    let mut targets = Vec::new();
    for id in project.get("targets").map(Node::items).unwrap_or(&[]) {
        let Some(t) = id.str().and_then(|i| objects.get(i)) else { continue };
        if t.gets("isa") != Some("PBXNativeTarget") {
            continue;
        }
        let pt = t.gets("productType").unwrap_or("");
        let kind = if pt == APP {
            Kind::App
        } else if pt.starts_with("com.apple.product-type.app-extension") || pt.starts_with("com.apple.product-type.extensionkit-extension") {
            Kind::Extension
        } else {
            Kind::Other
        };
        targets.push(Target { name: t.gets("name").unwrap_or("?").to_string(), kind, cfgs: t.gets("buildConfigurationList").map(|l| cfgs_of(objects, l)).unwrap_or_default() });
    }
    Some(Model { project: proj_cfgs, targets })
}

fn parent_of(rel: &str) -> &str {
    rel.rsplit_once('/').map_or("", |(d, _)| d)
}

/// Joins `base` and `rel` lexically; `None` when the result would leave the project.
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

/// A path from a build setting, made relative to the project.
fn setting_path(proj_dir: &str, value: &str) -> Option<String> {
    let v = value.trim();
    let v = v.strip_prefix("$(SRCROOT)/").or_else(|| v.strip_prefix("${SRCROOT}/")).unwrap_or(v);
    if v.is_empty() || v.contains("$(") || v.contains("${") || v.starts_with('/') {
        return None;
    }
    norm(proj_dir, v)
}

fn literal(v: &str) -> bool {
    !v.is_empty() && !v.contains("$(") && !v.contains("${")
}

pub(crate) fn run(cx: &mut Ctx, perms: &Perms) {
    let projects: Vec<String> = cx.files.ending(".xcodeproj/project.pbxproj").cloned().collect();
    let mut marketing: Vec<(String, String, String, u32, String)> = Vec::new(); // target, cfg, value, line, file
    let mut builds: Vec<(String, String, String, u32, String)> = Vec::new();
    let mut deploy: Vec<(String, u32, String)> = Vec::new();
    let mut declared: Option<Declared> = None;
    let mut entitlement_files: Vec<String> = Vec::new();
    for file in &projects {
        let Some(text) = cx.read(file) else { continue };
        let Some(m) = openstep::parse(&text).ok().and_then(|r| model(&r)) else {
            cx.skipped.push(format!("unreadable:{}", cx.path(file)));
            continue;
        };
        project_checks(cx, file, &m, &mut marketing, &mut builds, &mut deploy, &mut declared, &mut entitlement_files);
    }
    versions(cx, &marketing, &builds);
    if let Some(d) = declared.take() {
        permissions(cx, perms, &d);
        push(cx, perms, &entitlement_files);
    }
    let podfile = cx.files.named("Podfile").min_by_key(|f| f.len()).cloned();
    if let Some(p) = podfile {
        podfile_checks(cx, &p, &deploy);
    }
    if cx.project.react_native {
        xcode_env(cx);
    }
}

struct Declared {
    /// key -> (value, file, line)
    keys: Vec<(String, String, String, u32)>,
    /// A plist or setting that could not be read: a missing key proves nothing.
    complete: bool,
}

#[allow(clippy::too_many_arguments)]
fn project_checks(
    cx: &mut Ctx,
    file: &str,
    m: &Model,
    marketing: &mut Vec<(String, String, String, u32, String)>,
    builds: &mut Vec<(String, String, String, u32, String)>,
    deploy: &mut Vec<(String, u32, String)>,
    declared: &mut Option<Declared>,
    entitlement_files: &mut Vec<String>,
) {
    let proj_dir = parent_of(parent_of(file)).to_string();
    let apps: Vec<&Target> = m.targets.iter().filter(|t| t.kind == Kind::App).collect();
    let main_release_id = apps.first().and_then(|t| m.eff(t, "Release", "PRODUCT_BUNDLE_IDENTIFIER")).map(|s| s.value);
    for t in m.targets.iter().filter(|t| t.kind != Kind::Other) {
        let release_name = if t.cfgs.iter().any(|c| c.name == "Release") { "Release" } else { t.cfgs.last().map_or("Release", |c| c.name.as_str()) };
        let Some(rel_cfg) = m.cfg(t, release_name) else { continue };
        let custom = rel_cfg.custom_base || m.project.iter().any(|c| c.name == release_name && c.custom_base);
        for c in &t.cfgs {
            if let Some(v) = m.eff(t, &c.name, "MARKETING_VERSION").filter(|s| literal(&s.value)) {
                marketing.push((t.name.clone(), c.name.clone(), v.value, v.line, file.to_string()));
            }
            if let Some(v) = m.eff(t, &c.name, "CURRENT_PROJECT_VERSION").filter(|s| literal(&s.value)) {
                builds.push((t.name.clone(), c.name.clone(), v.value, v.line, file.to_string()));
            }
        }
        // bundle id
        let ids: Vec<(String, Setting)> = t.cfgs.iter().filter_map(|c| m.eff(t, &c.name, "PRODUCT_BUNDLE_IDENTIFIER").map(|s| (c.name.clone(), s))).collect();
        if t.kind == Kind::App {
            let rel_id = m.eff(t, release_name, "PRODUCT_BUNDLE_IDENTIFIER");
            match &rel_id {
                None if !custom => cx.add(
                    "ios.bundleId.missing",
                    Severity::Error,
                    Some((file, rel_cfg.line)),
                    None,
                    &[("target", &t.name)],
                    format!("In {} the app target {} has no PRODUCT_BUNDLE_IDENTIFIER in its {release_name} build settings. Ask me which bundle identifier the app uses (do not invent one), set it in every build configuration of the target and change nothing else.", q(&cx.path(file)), q(&t.name)),
                ),
                Some(s) if literal(&s.value) => {
                    if std::ptr::eq(t, apps[0]) {
                        cx.fact("ios.bundleId", s.value.clone(), Some((file, s.line)));
                    }
                    if PLACEHOLDER_IDS.iter().any(|p| s.value.starts_with(p)) {
                        cx.add(
                            "ios.bundleId.placeholder",
                            Severity::Warn,
                            Some((file, s.line)),
                            None,
                            &[("target", &t.name), ("bundleId", &s.value)],
                            format!("The bundle identifier {} in {} looks like a template placeholder, not the app's own. Ask me for the real identifier (it must match the App ID registered with Apple), then set PRODUCT_BUNDLE_IDENTIFIER for every configuration of target {} and update anything else that mentions the old one (Expo config, URL schemes, Firebase files). Do not guess the identifier.", q(&s.value), q(&cx.path(file)), q(&t.name)),
                        );
                    }
                }
                _ => {}
            }
            let distinct: BTreeSet<&str> = ids.iter().filter(|(_, s)| literal(&s.value)).map(|(_, s)| s.value.as_str()).collect();
            if distinct.len() > 1 {
                let list = distinct.iter().copied().collect::<Vec<_>>().join(", ");
                let line = ids.iter().find(|(_, s)| s.value != ids[0].1.value).map_or(0, |(_, s)| s.line);
                cx.add(
                    "ios.bundleId.configsDiffer",
                    Severity::Warn,
                    Some((file, line)),
                    None,
                    &[("target", &t.name), ("values", &list)],
                    format!("Target {} in {} uses different PRODUCT_BUNDLE_IDENTIFIER values across its build configurations ({list}). Tell me whether that is intended (for example a separate Debug app); if not, make them all equal to the Release value. Do not change anything else.", q(&t.name), q(&cx.path(file))),
                );
            }
        } else if let (Some(main), Some((_, s))) = (&main_release_id, ids.iter().find(|(n, _)| n == release_name)) {
            if literal(main) && literal(&s.value) && !s.value.starts_with(&format!("{main}.")) {
                cx.add(
                    "ios.bundleId.extensionPrefix",
                    Severity::Error,
                    Some((file, s.line)),
                    None,
                    &[("target", &t.name), ("bundleId", &s.value), ("appBundleId", main)],
                    format!("The app extension target {} in {} has the bundle identifier {} but the app's is {}. An extension's identifier must start with the app's plus a dot, or App Store upload fails. Fix PRODUCT_BUNDLE_IDENTIFIER of that target (Release and Debug) and update provisioning settings that name it.", q(&t.name), q(&cx.path(file)), q(&s.value), q(main)),
                );
            }
        }
        if t.kind != Kind::App {
            continue;
        }
        // signing
        let team = m.eff(t, release_name, "DEVELOPMENT_TEAM");
        let signing_off = m.eff(t, release_name, "CODE_SIGNING_ALLOWED").is_some_and(|s| s.value == "NO");
        if !custom && !signing_off && team.as_ref().map_or(true, |s| s.value.trim().is_empty()) {
            cx.add(
                "ios.team.empty",
                Severity::Warn,
                Some((file, team.as_ref().map_or(rel_cfg.line, |s| s.line))),
                None,
                &[("target", &t.name), ("configuration", release_name)],
                format!("In {} the app target {} has no DEVELOPMENT_TEAM for {release_name}. Ask me for my Apple Developer Team ID (do not guess or look for one), set DEVELOPMENT_TEAM for every build configuration of the target, and keep CODE_SIGN_STYLE as it is unless I say otherwise.", q(&cx.path(file)), q(&t.name)),
            );
        }
        let style = m.eff(t, release_name, "CODE_SIGN_STYLE").map_or("Automatic".to_string(), |s| s.value);
        let spec = m.eff(t, release_name, "PROVISIONING_PROFILE_SPECIFIER").filter(|s| !s.value.trim().is_empty());
        let prof = m.eff(t, release_name, "PROVISIONING_PROFILE").filter(|s| !s.value.trim().is_empty());
        if style == "Manual" && spec.is_none() && prof.is_none() && !custom && !signing_off {
            cx.add(
                "ios.signing.manualNoProfile",
                Severity::Warn,
                Some((file, m.eff(t, release_name, "CODE_SIGN_STYLE").map_or(rel_cfg.line, |s| s.line))),
                None,
                &[("target", &t.name)],
                format!("Target {} in {} signs manually (CODE_SIGN_STYLE = Manual) but names no provisioning profile for {release_name}. Ask me which profile to use, or whether to switch the target to Automatic signing; do not invent a profile name.", q(&t.name), q(&cx.path(file))),
            );
        } else if style == "Automatic" {
            if let Some(s) = &spec {
                cx.add(
                    "ios.signing.automaticWithProfile",
                    Severity::Info,
                    Some((file, s.line)),
                    None,
                    &[("target", &t.name)],
                    format!("Target {} in {} uses Automatic signing but also names a provisioning profile (PROVISIONING_PROFILE_SPECIFIER). Xcode ignores or fights it. Ask me which way I sign, then remove the profile name or switch CODE_SIGN_STYLE to Manual accordingly.", q(&t.name), q(&cx.path(file))),
                );
            }
        }
        // deployment target
        let targets: Vec<(String, Setting)> = t.cfgs.iter().filter_map(|c| m.eff(t, &c.name, "IPHONEOS_DEPLOYMENT_TARGET").map(|s| (c.name.clone(), s))).filter(|(_, s)| literal(&s.value)).collect();
        let distinct: BTreeSet<&str> = targets.iter().map(|(_, s)| s.value.as_str()).collect();
        if distinct.len() > 1 {
            let list = distinct.iter().copied().collect::<Vec<_>>().join(", ");
            cx.add(
                "ios.deployment.inconsistent",
                Severity::Warn,
                Some((file, targets[1].1.line)),
                None,
                &[("target", &t.name), ("values", &list)],
                format!("Target {} in {} has different IPHONEOS_DEPLOYMENT_TARGET values across configurations ({list}). Make them the same (use the Release value) and tell me which one you kept.", q(&t.name), q(&cx.path(file))),
            );
        }
        if let Some((_, s)) = m.eff(t, release_name, "IPHONEOS_DEPLOYMENT_TARGET").map(|s| (0, s)).filter(|(_, s)| literal(&s.value)) {
            if std::ptr::eq(t, apps[0]) {
                cx.fact("ios.deployment", s.value.clone(), Some((file, s.line)));
            }
            deploy.push((s.value.clone(), s.line, file.to_string()));
        }
        // entitlements
        if let Some(s) = m.eff(t, release_name, "CODE_SIGN_ENTITLEMENTS").filter(|s| !s.value.trim().is_empty()) {
            if let Some(path) = setting_path(&proj_dir, &s.value) {
                if cx.is_file(&path) {
                    entitlement_files.push(path);
                } else {
                    cx.add(
                        "ios.entitlements.fileMissing",
                        Severity::Error,
                        Some((file, s.line)),
                        None,
                        &[("target", &t.name), ("entitlements", &path)],
                        format!("Target {} in {} points to the entitlements file {} (CODE_SIGN_ENTITLEMENTS) but it does not exist, so the build fails. Either restore the file from git history or remove the setting if the target needs no capabilities. Ask me before deleting anything.", q(&t.name), q(&cx.path(file)), q(&path)),
                    );
                }
            }
        }
        // Info.plist keys, once for the first app target
        if std::ptr::eq(t, apps[0]) && declared.is_none() {
            let mut d = Declared { keys: Vec::new(), complete: true };
            for c in &t.cfgs {
                for s in &c.settings {
                    if let Some(k) = s.key.strip_prefix("INFOPLIST_KEY_") {
                        d.keys.push((k.to_string(), s.value.clone(), file.to_string(), s.line));
                    }
                }
            }
            match m.eff(t, release_name, "INFOPLIST_FILE").and_then(|s| setting_path(&proj_dir, &s.value)) {
                Some(path) => {
                    let text = cx.read(&path);
                    match text.as_deref().map(xml::plist) {
                        Some(Ok(p)) => {
                            for (k, v, line) in p.entries {
                                if let PVal::Str(s) = v {
                                    d.keys.push((k, s, path.clone(), line));
                                } else {
                                    d.keys.push((k, "<set>".to_string(), path.clone(), line));
                                }
                            }
                            plist_version(cx, &path, &d, m, t, release_name, file);
                        }
                        Some(Err(_)) => {
                            cx.skipped.push(format!("unreadable:{}", cx.path(&path)));
                            d.complete = false;
                        }
                        None => d.complete = false,
                    }
                }
                None => {
                    if d.keys.is_empty() {
                        d.complete = false;
                    }
                }
            }
            *declared = Some(d);
        }
    }
}

/// A literal version in `Info.plist` wins over `MARKETING_VERSION`; when the two disagree the build shows the plist's.
fn plist_version(cx: &mut Ctx, path: &str, d: &Declared, m: &Model, t: &Target, cfg: &str, file: &str) {
    let Some((_, short, _, line)) = d.keys.iter().find(|k| k.0 == "CFBundleShortVersionString" && k.2 == path) else { return };
    if !literal(short) {
        return;
    }
    let Some(mv) = m.eff(t, cfg, "MARKETING_VERSION").filter(|s| literal(&s.value)) else { return };
    if mv.value != *short {
        cx.add(
            "ios.version.plistOverrides",
            Severity::Warn,
            Some((path, *line)),
            None,
            &[("plistVersion", short), ("projectVersion", &mv.value), ("projectFile", file)],
            format!("{} writes CFBundleShortVersionString as the plain text {short}, while MARKETING_VERSION in {} is {}. The plain text wins in the built app, so changing MARKETING_VERSION has no effect. Change the plist value to $(MARKETING_VERSION) and make sure MARKETING_VERSION holds the version I want ({short} unless I say otherwise).", q(&cx.path(path)), q(&cx.path(file)), mv.value),
        );
    }
}

fn versions(cx: &mut Ctx, marketing: &[(String, String, String, u32, String)], builds: &[(String, String, String, u32, String)]) {
    for (list, id, key) in [(marketing, "ios.version.marketingDiffer", "MARKETING_VERSION"), (builds, "ios.version.buildDiffer", "CURRENT_PROJECT_VERSION")] {
        let distinct: BTreeSet<&str> = list.iter().map(|e| e.2.as_str()).collect();
        if distinct.len() > 1 {
            let values = distinct.iter().copied().collect::<Vec<_>>().join(", ");
            let first = &list[0];
            let odd = list.iter().find(|e| e.2 != first.2).unwrap_or(first);
            let id: &'static str = id;
            cx.add(
                id,
                Severity::Warn,
                Some((&odd.4, odd.3)),
                None,
                &[("values", &values), ("key", key), ("target", &odd.0)],
                format!("{key} is not the same in every target and configuration of the Xcode project ({values}). The App Store expects the app and its extensions to share one value. Make them all equal to the app target's Release value and tell me which value that is."),
            );
        }
    }
    if let Some(first) = marketing.first() {
        cx.fact("ios.version", first.2.clone(), Some((&first.4, first.3)));
    }
    if let Some(first) = builds.first() {
        cx.fact("ios.build", first.2.clone(), Some((&first.4, first.3)));
    }
}

fn permissions(cx: &mut Ctx, perms: &Perms, d: &Declared) {
    let expo = cx.pkg.app_json.clone();
    let expo_keys: BTreeSet<String> = expo.as_ref().and_then(|v| v.pointer("/expo/ios/infoPlist")).and_then(|v| v.as_object()).map(|o| o.keys().cloned().collect()).unwrap_or_default();
    let plugins = crate::cross::expo_plugins(expo.as_ref());
    for def in perm::defs() {
        for key in &def.plist {
            if let Some((_, v, file, line)) = d.keys.iter().find(|k| &k.0 == key) {
                if v.trim().is_empty() {
                    let file = file.clone();
                    cx.add(
                        "ios.permission.emptyText",
                        Severity::Warn,
                        Some((&file, *line)),
                        None,
                        &[("key", key)],
                        format!("{} in {} is empty. Apple rejects apps whose permission text is empty, and users see nothing useful when asked. Ask me what the app uses it for and write one short, honest sentence in the app's main language.", key, q(&cx.path(&file))),
                    );
                }
            }
        }
        let Some(ev) = perms.ios.get(&def.id) else { continue };
        if def.plist.is_empty() || !d.complete {
            continue;
        }
        let present = def.plist.iter().any(|k| d.keys.iter().any(|x| &x.0 == k) || expo_keys.contains(k));
        let by_plugin = def.packages.iter().any(|(p, _)| plugins.contains(p.as_str()));
        if present || by_plugin {
            continue;
        }
        let sev = match ev.confidence {
            Confidence::High => Severity::Error,
            Confidence::Medium => Severity::Warn,
            Confidence::Low => Severity::Info,
        };
        let key = def.plist[0].as_str();
        let file = d.keys.first().map_or(String::new(), |k| k.2.clone());
        let line = 0;
        let why = perm::describe(&ev.why);
        let at = (!file.is_empty()).then_some((file.as_str(), line));
        cx.add(
            "ios.permission.missing",
            sev,
            at,
            Some(ev.confidence),
            &[("permission", &def.id), ("key", key), ("evidence", &ev.why)],
            format!("The app seems to use the {} permission (based on {why}), but the iOS app has no {key} text in its Info.plist. Without it iOS closes the app the moment it asks, and App Store review rejects it. First check whether the app really uses it; if so ask me for a short honest sentence explaining why and add {key} to the app's Info.plist (or INFOPLIST_KEY_{key} in the build settings if the project generates its Info.plist). If it does not use it, say so and change nothing.", def.id),
        );
    }
}

fn push(cx: &mut Ctx, perms: &Perms, entitlement_files: &[String]) {
    let Some(ev) = perms.ios.get("notifications") else { return };
    let mut files: Vec<String> = entitlement_files.to_vec();
    for f in cx.files.ending(".entitlements").cloned().collect::<Vec<_>>() {
        if !files.contains(&f) {
            files.push(f);
        }
    }
    for f in &files {
        if let Some(Ok(p)) = cx.read(f).as_deref().map(xml::plist) {
            if p.get("aps-environment").is_some() {
                return;
            }
        }
    }
    let why = perm::describe(&ev.why);
    let at = files.first().map(|f| (f.as_str(), 0));
    cx.add(
        "ios.push.entitlementMissing",
        Severity::Warn,
        at,
        Some(ev.confidence),
        &[("evidence", &ev.why)],
        format!("The app seems to use push notifications (based on {why}), but no entitlements file of the iOS project contains aps-environment, so registering for remote notifications fails on a real device. If the app does use push, add the Push Notifications capability to the app target (this creates the entitlements file and sets CODE_SIGN_ENTITLEMENTS), with aps-environment set to development for Debug and production for Release. If it does not, say so and change nothing."),
    );
}

fn podfile_checks(cx: &mut Ctx, podfile: &str, deploy: &[(String, u32, String)]) {
    let dir = parent_of(podfile).to_string();
    let at = |name: &str| if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") };
    let text = cx.read(podfile).unwrap_or_default();
    let lock = cx.entry(&at("Podfile.lock"));
    let manifest = cx.entry(&at("Pods/Manifest.lock"));
    if !lock.is_file() {
        cx.add(
            "ios.pods.lockMissing",
            Severity::Warn,
            Some((podfile, 0)),
            None,
            &[],
            format!("{} has no Podfile.lock beside it, so every `pod install` may pick different library versions. Run `pod install` in that folder (after `npm install`/`yarn` for React Native) and tell me whether Podfile.lock appeared; do not delete or edit Pods by hand.", q(&cx.path(podfile))),
        );
    }
    if !manifest.is_file() {
        cx.add(
            "ios.pods.notInstalled",
            Severity::Warn,
            Some((podfile, 0)),
            None,
            &[],
            format!("The CocoaPods libraries of {} are not installed (there is no Pods/Manifest.lock), so Xcode cannot build the project yet. Run `pod install` in the folder of the Podfile (after the JavaScript dependencies are installed) and report errors if it fails.", q(&cx.path(podfile))),
        );
    } else if lock.is_file() {
        let a = cx.read_cap(&at("Podfile.lock"), 8 * 1024 * 1024);
        let b = cx.read_cap(&at("Pods/Manifest.lock"), 8 * 1024 * 1024);
        if let (Some(a), Some(b)) = (a, b) {
            if a.replace("\r\n", "\n").trim_end() != b.replace("\r\n", "\n").trim_end() {
                cx.add(
                    "ios.pods.outOfSync",
                    Severity::Error,
                    Some((&at("Podfile.lock"), 0)),
                    None,
                    &[],
                    format!("{} and Pods/Manifest.lock differ, so Xcode stops with \"The sandbox is not in sync with the Podfile.lock\". Run `pod install` in that folder and report whether the build error goes away. Do not edit either lock file by hand.", q(&cx.path(&at("Podfile.lock")))),
                );
            }
        }
    }
    // platform and flags
    let mut pod_target: Option<(String, u32)> = None;
    let mut new_arch: Option<(bool, u32)> = None;
    let mut hermes: Option<(bool, u32)> = None;
    for (i, raw) in text.lines().enumerate() {
        let line = raw.split('#').next().unwrap_or("").trim();
        let n = i as u32 + 1;
        if let Some(rest) = line.strip_prefix("platform :ios,") {
            let rest = rest.trim();
            if let Some(qc) = rest.chars().next().filter(|c| *c == '\'' || *c == '"') {
                if let Some(end) = rest[1..].find(qc) {
                    pod_target = Some((rest[1..1 + end].to_string(), n));
                }
            }
        }
        if line.contains("RCT_NEW_ARCH_ENABLED") && line.contains('=') && !line.contains("==") {
            let v = line.rsplit('=').next().unwrap_or("").trim().trim_matches(['\'', '"']);
            match v {
                "1" | "true" => new_arch = Some((true, n)),
                "0" | "false" => new_arch = Some((false, n)),
                _ => {}
            }
        }
        if line.contains("new_arch_enabled") && !line.contains("==") {
            if line.contains("=> true") || line.contains(": true") {
                new_arch = Some((true, n));
            } else if line.contains("=> false") || line.contains(": false") {
                new_arch = Some((false, n));
            }
        }
        if line.contains("hermes_enabled") && !line.contains("==") {
            if line.contains("=> true") || line.contains(": true") {
                hermes = Some((true, n));
            } else if line.contains("=> false") || line.contains(": false") {
                hermes = Some((false, n));
            }
        }
    }
    if let Some(props) = cx.read(&at("Podfile.properties.json")).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) {
        if pod_target.is_none() {
            if let Some(v) = props.get("ios.deploymentTarget").and_then(|v| v.as_str()) {
                pod_target = Some((v.to_string(), 0));
            }
        }
        let flag = |k: &str| props.get(k).and_then(|v| v.as_str().map(|s| s == "true").or_else(|| v.as_bool()));
        if new_arch.is_none() {
            new_arch = flag("newArchEnabled").map(|b| (b, 0));
        }
        if hermes.is_none() {
            hermes = props.get("expo.jsEngine").and_then(|v| v.as_str()).map(|s| (s == "hermes", 0));
        }
    }
    if let Some((on, n)) = new_arch {
        cx.fact("ios.newArch", if on { "on" } else { "off" }, Some((podfile, n)));
    }
    if let Some((on, n)) = hermes {
        cx.fact("ios.hermes", if on { "on" } else { "off" }, Some((podfile, n)));
    }
    if let (Some((pv, pline)), Some((av, _, afile))) = (&pod_target, deploy.first()) {
        if literal(pv) && cmp_version(pv, av) != std::cmp::Ordering::Equal {
            cx.add(
                "ios.deployment.mismatch",
                Severity::Warn,
                Some((podfile, *pline)),
                None,
                &[("podfile", pv), ("project", av)],
                format!("The Podfile builds libraries for iOS {pv} while the Xcode project's deployment target is {av} ({}). When the Podfile is higher the build can fail with \"requires a minimum deployment target\"; when it is lower you get linker warnings. Ask me which minimum iOS version the app supports, then set the same value in the Podfile (platform :ios) and in IPHONEOS_DEPLOYMENT_TARGET of every target, and run `pod install`.", q(&cx.path(afile))),
            );
        }
    }
}

fn xcode_env(cx: &mut Ctx) {
    let dir = cx.files.named("Podfile").min_by_key(|f| f.len()).map(|f| parent_of(f).to_string()).unwrap_or_else(|| "ios".to_string());
    let rel = if dir.is_empty() { ".xcode.env".to_string() } else { format!("{dir}/.xcode.env") };
    let Some(text) = cx.read(&rel) else {
        if cx.pkg.rn_version().is_some_and(|v| v >= (0, 69)) && cx.is_file(&format!("{}Podfile", if dir.is_empty() { String::new() } else { format!("{dir}/") })) {
            cx.add(
                "ios.xcodeEnv.missing",
                Severity::Info,
                Some((&rel, 0)),
                None,
                &[],
                format!("This React Native project has no {} file. Xcode's \"Bundle React Native code\" step uses it to find Node, and the build can fail with \"node: command not found\" outside a terminal. Create it with the content of the React Native template (`export NODE_BINARY=$(command -v node)`) and tell me what you wrote.", q(&cx.path(&rel))),
            );
        }
        return;
    };
    for (i, l) in text.lines().enumerate() {
        let l = l.trim();
        if l.starts_with('#') {
            continue;
        }
        if let Some(v) = l.strip_prefix("export NODE_BINARY=").or_else(|| l.strip_prefix("NODE_BINARY=")) {
            let v = v.trim().trim_matches(['"', '\'']);
            if v.starts_with("/Users/") || v.starts_with("/home/") || v.starts_with("C:\\") {
                cx.add(
                    "ios.xcodeEnv.hardcodedNode",
                    Severity::Warn,
                    Some((&rel, i as u32 + 1)),
                    None,
                    &[],
                    format!("{} points NODE_BINARY at a path inside one person's home folder, which breaks the build on every other machine and on CI. Replace it with `export NODE_BINARY=$(command -v node)` and put a machine-specific path, if needed, in .xcode.env.local (which stays out of git).", q(&cx.path(&rel))),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_inside_the_project() {
        assert_eq!(norm("ios/App", "../Info.plist").as_deref(), Some("ios/Info.plist"));
        assert_eq!(norm("ios", "../../etc/passwd"), None);
        assert_eq!(setting_path("ios", "$(SRCROOT)/App/Info.plist").as_deref(), Some("ios/App/Info.plist"));
        assert_eq!(setting_path("ios", "/etc/passwd"), None);
        assert_eq!(setting_path("ios", "$(FOO)/x"), None);
    }
}
