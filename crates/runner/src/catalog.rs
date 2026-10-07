//! Script discovery for one repo: `package.json` scripts (name, group, safety, heavy flag, env var names) plus a few
//! synthetic `cargo` entries. The catalog never carries a body. A body is only available through [`display_command`],
//! masked and with env var values replaced, when the user asks for it. The files read are `package.json`,
//! `Cargo.toml` (existence) and `src-tauri/tauri.conf.json`; `.env*` files are never opened.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;

use intely_core::{code, EngineError};

use crate::mask;
use crate::types::{Catalog, Safety, ScriptGroup, ScriptInfo};

const MAX_JSON_BYTES: u64 = 2 * 1024 * 1024;
/// Node heap limit (MB) from which a script counts as a heavy server.
pub const HEAVY_MB: u32 = 4000;
/// How deep `npm run other` references are followed when classifying a script.
const REF_DEPTH: usize = 4;

/// Everything needed to spawn a script; built from the files again on every start, never taken from the UI.
#[derive(Debug, Clone)]
pub struct Plan {
    pub argv: Vec<String>,
    pub info: ScriptInfo,
}

pub fn catalog(repo_id: &str, repo: &Path) -> Result<Catalog, EngineError> {
    let (pm, scripts, notes) = load(repo)?;
    let mut infos: Vec<ScriptInfo> = scripts.iter().map(|(name, body)| npm_info(name, body, &scripts, &pm, repo)).collect();
    infos.extend(cargo_scripts(repo));
    infos.sort_by(|a, b| (group_rank(&a.group), a.source != "npm", priority(&a.name), &a.name).cmp(&(group_rank(&b.group), b.source != "npm", priority(&b.name), &b.name)));
    Ok(Catalog { repo_id: repo_id.to_owned(), package_manager: pm, scripts: infos, notes })
}

/// The spawn plan of one script (`npm:dev`, `cargo:check`).
pub fn plan(repo: &Path, script_id: &str) -> Result<Plan, EngineError> {
    let unknown = || EngineError::new("unknownScript", format!("the repo has no script {script_id}"));
    if let Some(kind) = script_id.strip_prefix("cargo:") {
        let info = cargo_scripts(repo).into_iter().find(|s| s.name == format!("cargo {kind}")).ok_or_else(unknown)?;
        let manifest = cargo_manifest(repo).ok_or_else(unknown)?;
        let mut argv = vec!["cargo".to_owned(), kind.to_owned()];
        if manifest != "Cargo.toml" {
            argv.extend(["--manifest-path".to_owned(), manifest]);
        }
        return Ok(Plan { argv, info });
    }
    let name = script_id.strip_prefix("npm:").ok_or_else(unknown)?;
    let (pm, scripts, _) = load(repo)?;
    let body = scripts.get(name).filter(|_| !name.starts_with('-') && !name.contains('\0')).ok_or_else(unknown)?;
    let info = npm_info(name, body, &scripts, &pm, repo);
    Ok(Plan { argv: vec![pm, "run".to_owned(), name.to_owned()], info })
}

/// The script body for the "Show command" button: secrets masked, inline env var values replaced by `…`.
pub fn display_command(repo: &Path, script_id: &str) -> Result<String, EngineError> {
    if let Some(kind) = script_id.strip_prefix("cargo:") {
        return Ok(format!("cargo {kind}"));
    }
    let name = script_id.strip_prefix("npm:").unwrap_or(script_id);
    let (_, scripts, _) = load(repo)?;
    let body = scripts.get(name).ok_or_else(|| EngineError::new("unknownScript", format!("the repo has no script {script_id}")))?;
    Ok(mask::redact_env_values(&mask::mask(body)))
}

fn group_rank(g: &ScriptGroup) -> u8 {
    match g {
        ScriptGroup::Start => 0,
        ScriptGroup::Dev => 1,
        ScriptGroup::Test => 2,
        ScriptGroup::Lint => 3,
        ScriptGroup::Build => 4,
        ScriptGroup::Other => 5,
    }
}

/// The plain names come first inside a group.
fn priority(name: &str) -> u8 {
    match name {
        "start" => 0,
        "dev" => 1,
        "test" | "lint" | "build" => 2,
        _ => 3,
    }
}

type Scripts = BTreeMap<String, String>;

fn read_json(path: &Path) -> Option<serde_json::Value> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_JSON_BYTES {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn load(repo: &Path) -> Result<(String, Scripts, Vec<String>), EngineError> {
    let mut notes = Vec::new();
    let mut scripts = Scripts::new();
    let pkg = repo.join("package.json");
    if pkg.is_file() {
        match read_json(&pkg) {
            Some(json) => {
                if let Some(map) = json.get("scripts").and_then(|s| s.as_object()) {
                    for (k, v) in map {
                        if let Some(body) = v.as_str() {
                            scripts.insert(k.clone(), body.to_owned());
                        }
                    }
                }
            }
            None => notes.push("package.json could not be read (invalid or larger than 2 MB).".to_owned()),
        }
    } else if cargo_manifest(repo).is_none() {
        return Err(EngineError::new(code::IO, "the repo has no package.json or Cargo.toml"));
    }
    let pm = ["pnpm-lock.yaml:pnpm", "yarn.lock:yarn", "bun.lockb:bun", "bun.lock:bun"]
        .iter()
        .find_map(|e| {
            let (file, pm) = e.split_once(':')?;
            repo.join(file).is_file().then(|| pm.to_owned())
        })
        .unwrap_or_else(|| "npm".to_owned());
    Ok((pm, scripts, notes))
}

fn cargo_manifest(repo: &Path) -> Option<String> {
    ["Cargo.toml", "src-tauri/Cargo.toml"].iter().find(|m| repo.join(m).is_file()).map(|m| (*m).to_owned())
}

fn cargo_scripts(repo: &Path) -> Vec<ScriptInfo> {
    let Some(manifest) = cargo_manifest(repo) else { return Vec::new() };
    let mk = |kind: &str, group: ScriptGroup, confirm: Option<&str>| ScriptInfo {
        id: format!("cargo:{kind}"),
        name: format!("cargo {kind}"),
        source: "cargo".to_owned(),
        group,
        safety: if confirm.is_some() { Safety::Confirm } else { Safety::Normal },
        reasons: confirm.map(|r| vec![r.to_owned()]).unwrap_or_default(),
        forbidden_to_agents: confirm.is_some(),
        heavy_mb: None,
        env_names: Vec::new(),
        port_hint: None,
        runner: if manifest == "Cargo.toml" { format!("cargo {kind}") } else { format!("cargo {kind} --manifest-path {manifest}") },
    };
    vec![
        mk("check", ScriptGroup::Lint, None),
        mk("test", ScriptGroup::Test, None),
        mk("build", ScriptGroup::Build, Some("build: writes target/ and takes minutes")),
    ]
}

/// Lower-case alphanumeric words of a script name or body (`test:e2e:full` -> test, e2e, full).
fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_ascii_lowercase).collect()
}

/// A script together with the scripts it runs through `npm run x` / `pnpm x` style references.
fn closure(name: &str, scripts: &Scripts) -> String {
    fn walk(name: &str, scripts: &Scripts, depth: usize, seen: &mut HashSet<String>, out: &mut String) {
        if depth > REF_DEPTH || !seen.insert(name.to_owned()) {
            return;
        }
        let Some(body) = scripts.get(name) else { return };
        out.push_str(body);
        out.push('\n');
        for other in scripts.keys() {
            if other != name && references(body, other) {
                walk(other, scripts, depth + 1, seen, out);
            }
        }
    }
    let mut out = String::new();
    walk(name, scripts, 0, &mut HashSet::new(), &mut out);
    out
}

/// Whether `body` runs script `other`: `npm run other`, `pnpm run other`, `yarn other`.
fn references(body: &str, other: &str) -> bool {
    let toks: Vec<&str> = body.split_whitespace().map(|t| t.trim_matches(|c| matches!(c, '"' | '\'' | ';' | ')' | '('))).collect();
    toks.windows(2).any(|w| matches!(w[0], "run" | "run-script" | "yarn" | "pnpm" | "bun") && w[1] == other)
}

fn heap_mb(text: &str) -> Option<u32> {
    let mut best = None;
    for pat in ["max-old-space-size=", "max_old_space_size="] {
        let mut rest = text;
        while let Some(p) = rest.find(pat) {
            rest = &rest[p + pat.len()..];
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            if let Ok(n) = digits.parse::<u32>() {
                best = best.max(Some(n));
            }
        }
    }
    best
}

/// `NAME=value` words and `$NAME` / `${NAME}` references; the values are dropped here.
fn env_names(text: &str) -> Vec<String> {
    let mut names = BTreeSet::new();
    let valid = |n: &str| n.len() >= 2 && n.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') && !n.starts_with(|c: char| c.is_ascii_digit());
    for word in text.split(|c: char| c.is_whitespace() || matches!(c, '&' | ';' | '|' | '(' | ')' | '"' | '\'')) {
        if let Some((n, _)) = word.split_once('=') {
            if valid(n) {
                names.insert(n.to_owned());
            }
        }
        let mut rest = word;
        while let Some(p) = rest.find('$') {
            rest = &rest[p + 1..];
            let rest2 = rest.strip_prefix('{').unwrap_or(rest);
            let n: String = rest2.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            if valid(&n) {
                names.insert(n);
            }
        }
    }
    names.into_iter().collect()
}

const TEST_WORDS: [&str; 9] = ["test", "tests", "e2e", "jest", "vitest", "cypress", "playwright", "cover", "lambdatest"];
const LINT_WORDS: [&str; 7] = ["lint", "eslint", "prettier", "format", "typecheck", "tsc", "check"];
const BUILD_WORDS: [&str; 17] = [
    "build", "builder", "compile", "bundle", "dist", "pack", "export", "publish", "deploy", "release", "ipa", "aab", "apk", "sign", "analyze", "clean", "rebuild",
];
const DEV_WORDS: [&str; 6] = ["dev", "serve", "watch", "web", "local", "nodemon"];
const DEV_BODY: [&str; 9] = ["expo start", "webpack serve", "webpack-dev-server", "srcwebserver", "srcserver", "next dev", "vite", "nodemon", "react-scripts start"];

fn group_of(name: &str, body: &str, scripts: &Scripts) -> ScriptGroup {
    let w = words(name);
    let has = |list: &[&str]| w.iter().any(|x| list.contains(&x.as_str()));
    let lower = name.to_ascii_lowercase();
    let lifecycle = ["pre", "post"].iter().any(|p| lower.strip_prefix(p).is_some_and(|rest| scripts.contains_key(rest) || matches!(rest, "install" | "publish" | "pack" | "version")))
        || matches!(lower.as_str(), "prepare" | "postinstall" | "preinstall");
    if lifecycle {
        return ScriptGroup::Other;
    }
    if has(&TEST_WORDS) {
        return ScriptGroup::Test;
    }
    if has(&LINT_WORDS) {
        return ScriptGroup::Lint;
    }
    if has(&BUILD_WORDS) {
        return ScriptGroup::Build;
    }
    if lower.starts_with("start") {
        return ScriptGroup::Start;
    }
    let body_lower = body.to_ascii_lowercase();
    if has(&DEV_WORDS) || DEV_BODY.iter().any(|h| body_lower.contains(h)) {
        return ScriptGroup::Dev;
    }
    ScriptGroup::Other
}

fn reasons_of(name: &str, group: &ScriptGroup, closure_text: &str) -> Vec<String> {
    let nw = words(name);
    let bw: BTreeSet<String> = words(closure_text).into_iter().collect();
    let in_either = |list: &[&str]| nw.iter().any(|x| list.contains(&x.as_str())) || list.iter().any(|x| bw.contains(*x));
    let lower_body = closure_text.to_ascii_lowercase();
    let mut r = Vec::new();
    if in_either(&["deploy", "publish", "release", "ship", "upload", "wrangler", "eas", "submit"]) {
        r.push("deploys or publishes".to_owned());
    }
    if in_either(&["docker", "compose"]) {
        r.push("uses Docker".to_owned());
    }
    if in_either(&["pm2", "nodemon", "forever"]) {
        r.push("process manager (pm2 / nodemon)".to_owned());
    }
    if in_either(&["ssh", "scp", "rsync", "s3cmd", "gradlew", "adb"]) {
        r.push("remote or device command".to_owned());
    }
    if nw.iter().any(|x| ["migrate", "migration", "migrations", "backfill", "rollback", "dedupe", "dedup", "populate", "sync", "import", "indexes", "seed"].contains(&x.as_str())) {
        r.push("changes data".to_owned());
    }
    if nw.iter().any(|x| x == "login") || bw.contains("login") {
        r.push("stores credentials".to_owned());
    }
    if lower_body.contains("git push") || lower_body.contains("git commit") {
        r.push("changes git history".to_owned());
    }
    if bw.contains("rimraf") || lower_body.contains("rm -rf") || lower_body.contains("rm -r ") || nw.iter().any(|x| x == "clean" || x == "remove" || x == "prune") {
        r.push("deletes files".to_owned());
    }
    if lower_body.contains("npm install") || lower_body.contains("npm i ") || lower_body.contains("yarn install") || lower_body.contains("pnpm install") {
        r.push("installs packages".to_owned());
    }
    if *group == ScriptGroup::Build && r.is_empty() {
        r.push("build: writes output and is heavy".to_owned());
    }
    if *group == ScriptGroup::Build && !r.iter().any(|x| x.starts_with("build")) && !r.is_empty() {
        r.push("build".to_owned());
    }
    r
}

fn npm_info(name: &str, body: &str, scripts: &Scripts, pm: &str, repo: &Path) -> ScriptInfo {
    let group = group_of(name, body, scripts);
    let all = closure(name, scripts);
    let reasons = reasons_of(name, &group, &all);
    let safety = if reasons.is_empty() { Safety::Normal } else { Safety::Confirm };
    ScriptInfo {
        id: format!("npm:{name}"),
        name: mask::mask(name),
        source: "npm".to_owned(),
        group,
        forbidden_to_agents: safety == Safety::Confirm,
        safety,
        reasons,
        heavy_mb: heap_mb(&all).filter(|mb| *mb >= HEAVY_MB),
        env_names: env_names(&all),
        port_hint: tauri_port_hint(repo, name),
        runner: format!("{pm} run {}", mask::mask(name)),
    }
}

/// `src-tauri/tauri.conf.json`: the script named by `beforeDevCommand` is the one that serves `devUrl`.
fn tauri_port_hint(repo: &Path, name: &str) -> Option<u16> {
    let conf = read_json(&repo.join("src-tauri/tauri.conf.json"))?;
    let build = conf.get("build")?;
    let before = build.get("beforeDevCommand")?.as_str()?;
    if !before.split_whitespace().any(|t| t == name) {
        return None;
    }
    let url = build.get("devUrl")?.as_str()?;
    url.rsplit(':').next()?.trim_end_matches('/').parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, body) in files {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
        dir
    }

    fn find<'a>(c: &'a Catalog, name: &str) -> &'a ScriptInfo {
        c.scripts.iter().find(|s| s.name == name).unwrap_or_else(|| panic!("no script {name}"))
    }

    #[test]
    fn groups_and_safety_follow_the_names_and_the_referenced_bodies() {
        let pkg = r#"{"scripts":{
            "start":"concurrently -k \"npm run open:src:web\"",
            "open:src:web":"babel-node --max-old-space-size=4800 tools/srcWebServer.js",
            "dev":"babel-node --max-old-space-size=2048 tools/srcWebServer.js",
            "test":"jest","test:e2e":"playwright test","lint":"eslint src",
            "build":"node build.js","publish:wrangler":"npx wrangler pages deploy ./dist",
            "lint:docker":"docker exec x npm run lint","start-prod":"pm2 start npm -- start",
            "dev-local":"DOTENV_CONFIG_PATH=.env.local nodemon src/app.js",
            "migrate:fix":"babel-node scripts/fix.js","prestart":"npm run start-message","start-message":"node msg.js",
            "ssh-logs":"ssh root@host pm2 logs"}}"#;
        let dir = repo(&[("package.json", pkg)]);
        let c = catalog("r", dir.path()).unwrap();
        assert_eq!(find(&c, "start").group, ScriptGroup::Start);
        assert_eq!(find(&c, "start").safety, Safety::Normal);
        assert_eq!(find(&c, "start").heavy_mb, Some(4800), "the heap limit of a referenced script counts");
        assert_eq!(find(&c, "dev").heavy_mb, None);
        assert_eq!(find(&c, "test").group, ScriptGroup::Test);
        assert_eq!(find(&c, "test:e2e").group, ScriptGroup::Test);
        assert_eq!(find(&c, "lint").group, ScriptGroup::Lint);
        assert_eq!(find(&c, "prestart").group, ScriptGroup::Other);
        for confirm in ["build", "publish:wrangler", "lint:docker", "start-prod", "dev-local", "migrate:fix", "ssh-logs"] {
            let s = find(&c, confirm);
            assert_eq!(s.safety, Safety::Confirm, "{confirm}");
            assert!(s.forbidden_to_agents && !s.reasons.is_empty(), "{confirm}");
        }
        assert_eq!(find(&c, "dev-local").env_names, vec!["DOTENV_CONFIG_PATH"]);
        assert_eq!(c.package_manager, "npm");
        assert_eq!(c.scripts[0].name, "start", "start sorts first");
    }

    #[test]
    fn the_catalog_never_carries_a_body_or_a_secret() {
        let canary = format!("{}{}", "ghp_", "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo");
        let pkg = format!(
            r#"{{"scripts":{{"login:github":"set GH_TOKEN={canary} && set GH_TOKEN={canary}","dev":"API_URL=https://u:pw@host/x node s.js"}}}}"#
        );
        let dir = repo(&[("package.json", &pkg)]);
        let c = catalog("r", dir.path()).unwrap();
        let wire = serde_json::to_string(&c).unwrap();
        assert!(!wire.contains(&canary[4..]) && !wire.contains("pw@") && !wire.contains("node s.js"), "{wire}");
        let login = find(&c, "login:github");
        assert_eq!(login.safety, Safety::Confirm);
        assert_eq!(login.env_names, vec!["GH_TOKEN"], "names only");
        let shown = display_command(dir.path(), "npm:login:github").unwrap();
        assert!(!shown.contains(&canary[4..]), "{shown}");
        assert!(shown.contains("GH_TOKEN="));
        let dev = display_command(dir.path(), "npm:dev").unwrap();
        assert!(!dev.contains("pw@") && !dev.contains("https://u"), "{dev}");
        assert!(dev.contains("API_URL=…"), "env values are replaced: {dev}");
    }

    #[test]
    fn plan_builds_argv_from_the_files_and_refuses_unknown_scripts() {
        let dir = repo(&[("package.json", r#"{"scripts":{"dev":"node s.js"}}"#), ("pnpm-lock.yaml", "")]);
        let p = plan(dir.path(), "npm:dev").unwrap();
        assert_eq!(p.argv, vec!["pnpm", "run", "dev"]);
        assert_eq!(p.info.runner, "pnpm run dev");
        for bad in ["npm:nope", "npm:--version", "evil", "cargo:check"] {
            assert_eq!(plan(dir.path(), bad).unwrap_err().code, "unknownScript", "{bad}");
        }
    }

    #[test]
    fn cargo_and_tauri_conf_add_entries_and_a_port_hint() {
        let dir = repo(&[
            ("package.json", r#"{"scripts":{"tauri:web:dev":"babel-node --max-old-space-size=4096 tools/srcServerTauri.js","other":"node x.js"}}"#),
            ("src-tauri/Cargo.toml", "[package]\nname=\"x\"\n"),
            ("src-tauri/tauri.conf.json", r#"{"build":{"devUrl":"http://localhost:8080","beforeDevCommand":"npm run tauri:web:dev"}}"#),
        ]);
        let c = catalog("pos", dir.path()).unwrap();
        let dev = find(&c, "tauri:web:dev");
        assert_eq!((dev.port_hint, dev.heavy_mb, dev.group.clone()), (Some(8080), Some(4096), ScriptGroup::Dev));
        assert_eq!(find(&c, "other").port_hint, None);
        assert_eq!(find(&c, "cargo test").group, ScriptGroup::Test);
        assert_eq!(find(&c, "cargo build").safety, Safety::Confirm);
        let p = plan(dir.path(), "cargo:check").unwrap();
        assert_eq!(p.argv, vec!["cargo", "check", "--manifest-path", "src-tauri/Cargo.toml"]);
    }

    #[test]
    fn a_folder_without_manifests_is_an_error_and_a_broken_package_json_a_note() {
        let empty = repo(&[]);
        assert!(catalog("r", empty.path()).is_err());
        let broken = repo(&[("package.json", "{nope")]);
        let c = catalog("r", broken.path()).unwrap();
        assert!(c.scripts.is_empty() && !c.notes.is_empty());
    }
}
