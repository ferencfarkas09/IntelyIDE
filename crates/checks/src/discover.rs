//! Which checks a repo offers for the ticked files (#18), found from `package.json` and `Cargo.toml`: the repo's own
//! `lint:changed` / `lint` / swagger-validation scripts, a targeted jest or vitest run for the changed files,
//! `node --check` per changed JavaScript file and `cargo check`. Only checks that need no confirmation are offered (the
//! run module's safety classification decides: deploy, build, publish and docker scripts are not). The UI gets the
//! script NAME as `runner`, never a body.

use std::fs;
use std::path::Path;

use intely_runner::catalog;
use intely_runner::types::Safety;

use crate::types::CheckInfo;

const SOURCE_EXT: [&str; 6] = ["js", "jsx", "ts", "tsx", "mjs", "cjs"];
const NODE_EXT: [&str; 3] = ["js", "mjs", "cjs"];
const MAX_FILES: usize = 60;

/// A check with the argv lists it runs one after the other (a failing one fails the check; all of them run).
#[derive(Debug, Clone)]
pub struct Planned {
    pub info: CheckInfo,
    pub commands: Vec<Vec<String>>,
}

fn ext(path: &str) -> &str {
    path.rsplit_once('.').map_or("", |(_, e)| e)
}

/// Repo-relative, no `..`, no leading dash or NUL: safe to hand to a tool as an argument.
pub fn clean_rel(path: &str) -> Option<String> {
    let p = path.trim();
    let ok = !p.is_empty() && !p.starts_with('/') && !p.starts_with('-') && !p.contains('\0') && !p.split('/').any(|s| s == ".." || s.is_empty());
    ok.then(|| p.to_owned())
}

fn has_dep(repo: &Path, name: &str) -> bool {
    let Ok(meta) = fs::metadata(repo.join("package.json")) else { return false };
    if meta.len() > 2 * 1024 * 1024 {
        return false;
    }
    let Ok(text) = fs::read_to_string(repo.join("package.json")) else { return false };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return false };
    ["dependencies", "devDependencies"].iter().any(|k| v.get(k).and_then(|d| d.get(name)).is_some())
}

fn exec_prefix(pm: &str) -> Vec<String> {
    match pm {
        "pnpm" => vec!["pnpm".into(), "exec".into()],
        "yarn" => vec!["yarn".into()],
        _ => vec!["npx".into(), "--no-install".into()],
    }
}

/// The checks for `changed` (repo-relative paths the user ticked; empty means "no file context").
pub fn discover(repo_id: &str, repo: &Path, changed: &[String]) -> Vec<Planned> {
    let files: Vec<String> = changed.iter().filter_map(|p| clean_rel(p)).collect();
    let js: Vec<&String> = files.iter().filter(|p| SOURCE_EXT.contains(&ext(p))).take(MAX_FILES).collect();
    let node: Vec<&String> = files.iter().filter(|p| NODE_EXT.contains(&ext(p))).take(MAX_FILES).collect();
    let rust = files.iter().any(|p| ext(p) == "rs");
    let mut out = Vec::new();
    let mut seen_lint = false;

    if let Ok(cat) = catalog::catalog(repo_id, repo) {
        let offered = |name: &str| cat.scripts.iter().find(|s| s.source == "npm" && s.name == name && s.safety == Safety::Normal && !s.forbidden_to_agents);
        for (name, label) in [("lint:changed", "Lint changed files"), ("lint", "Lint the repository")] {
            if seen_lint {
                break;
            }
            if let Some(s) = offered(name) {
                if let Ok(plan) = catalog::plan(repo, &s.id) {
                    seen_lint = true;
                    out.push(Planned {
                        info: CheckInfo { id: format!("npm:{name}"), label: label.into(), kind: "lint".into(), runner: s.runner.clone(), file_count: if name == "lint:changed" { js.len() as u32 } else { 0 }, disabled: None, note: (name == "lint").then(|| "Whole repository, can be slow".to_owned()) },
                        commands: vec![plan.argv],
                    });
                }
            }
        }
        if has_dep(repo, "jest") || has_dep(repo, "vitest") {
            let vitest = has_dep(repo, "vitest");
            let mut argv = exec_prefix(&cat.package_manager);
            if vitest {
                argv.extend(["vitest".into(), "related".into(), "--run".into(), "--passWithNoTests".into()]);
            } else {
                argv.extend(["jest".into(), "--findRelatedTests".into(), "--passWithNoTests".into()]);
            }
            argv.extend(js.iter().map(|f| format!("./{f}")));
            let tool = if vitest { "vitest" } else { "jest" };
            out.push(Planned {
                info: CheckInfo {
                    id: "tests:related".into(),
                    label: "Tests for the changed files".into(),
                    kind: "test".into(),
                    runner: format!("{tool} on {} changed file{}", js.len(), if js.len() == 1 { "" } else { "s" }),
                    file_count: js.len() as u32,
                    disabled: js.is_empty().then(|| "Tick changed JavaScript or TypeScript files first".to_owned()),
                    note: None,
                },
                commands: if js.is_empty() { Vec::new() } else { vec![argv] },
            });
        }
        let swagger = cat.scripts.iter().filter(|s| s.source == "npm" && s.safety == Safety::Normal && !s.forbidden_to_agents).find(|s| {
            let n = s.name.to_ascii_lowercase();
            (n.contains("swagger") || n.contains("openapi")) && ["valid", "lint", "check", "verify"].iter().any(|k| n.contains(k))
        });
        if let Some(s) = swagger {
            if let Ok(plan) = catalog::plan(repo, &s.id) {
                out.push(Planned {
                    info: CheckInfo { id: s.id.clone(), label: "Swagger validation".into(), kind: "swagger".into(), runner: s.runner.clone(), file_count: 0, disabled: None, note: Some("May regenerate spec files".into()) },
                    commands: vec![plan.argv],
                });
            }
        }
    }
    if repo.join("package.json").is_file() {
        out.push(Planned {
            info: CheckInfo {
                id: "node:check".into(),
                label: "Syntax check (node --check)".into(),
                kind: "syntax".into(),
                runner: format!("node --check on {} file{}", node.len(), if node.len() == 1 { "" } else { "s" }),
                file_count: node.len() as u32,
                disabled: node.is_empty().then(|| "Tick changed .js, .mjs or .cjs files first".to_owned()),
                note: None,
            },
            commands: node.iter().map(|f| vec!["node".to_owned(), "--check".to_owned(), format!("./{f}")]).collect(),
        });
    }
    if let Ok(plan) = catalog::plan(repo, "cargo:check") {
        let mut argv = plan.argv;
        argv.extend(["--message-format".into(), "short".into(), "-j".into(), "2".into()]);
        out.push(Planned {
            info: CheckInfo { id: "cargo:check".into(), label: "Cargo check".into(), kind: "cargo".into(), runner: "cargo check".into(), file_count: 0, disabled: (!rust).then(|| "No changed Rust files ticked".to_owned()), note: Some("Compiles; slow on a cold cache".into()) },
            commands: vec![argv],
        });
    }
    out
}

/// One check by id, built for exactly the files given (the UI never sends a command).
pub fn find(repo_id: &str, repo: &Path, check_id: &str, changed: &[String]) -> Option<Planned> {
    discover(repo_id, repo, changed).into_iter().find(|p| p.info.id == check_id)
}
