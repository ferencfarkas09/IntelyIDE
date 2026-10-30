//! "Auto-test after a run": the one unit-test command of a repo, chosen the same way every time from the script catalog.
//!
//! Only `Test` scripts that are `Safety::Normal` and allowed to agents qualify, and only under a few well-known names
//! (`test:unit`, `unit`, `test`, `vitest`, `jest`, `test:ci`). A script whose name or whose referenced bodies mention
//! end-to-end, device or deploy tooling, or a watch mode, is never chosen. Without such a script the synthetic
//! `cargo test` entry is used, then the synthetic pytest entry (only present when the repo has pytest markers).
//! The pick carries no script body; the start re-picks on the backend, so the UI never names what runs.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::catalog::{self, PYTEST_ID};
use crate::types::{Safety, ScriptGroup, ScriptInfo};

/// Which test runner the pick drives; the UI chooses its output parser by it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum TestKind {
    Vitest,
    Jest,
    Cargo,
    Pytest,
    Unknown,
}

/// The chosen test command of one repo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TestPick {
    /// A `ScriptInfo.id`: `npm:test`, `cargo:test` or `pytest:test`.
    pub script: String,
    /// What is executed, safe to show (`npm run test`), never the body.
    pub runner: String,
    pub kind: TestKind,
}

/// npm script names that may be picked, best first.
const PREFERRED: [&str; 12] = ["test:unit", "test-unit", "test_unit", "unit", "unit:test", "test", "tests", "vitest", "jest", "test:ci", "test-ci", "ci:test"];

/// Words (of the name or of any body the script runs) that rule a script out: end-to-end, browser, device, deploy and
/// long-running tooling. `watch` and `watchall` also cover `--watch` / `--watchAll`.
const NEVER: [&str; 34] = [
    "e2e", "cypress", "playwright", "detox", "maestro", "appium", "lambdatest", "browserstack", "saucelabs", "wdio", "webdriverio", "webdriver", "selenium", "puppeteer",
    "nightwatch", "testcafe", "integration", "emulator", "simulator", "xcodebuild", "gradlew", "adb", "deploy", "publish", "release", "upload", "ship", "docker",
    "compose", "watch", "watchall", "nodemon", "k6", "artillery",
];

/// Text that rules a script out: the `npm init` placeholder (it only fails), the Vitest UI server, servers started for
/// browser tests.
const NEVER_TEXT: [&str; 4] = ["no test specified", "--ui", "start-server-and-test", "wait-on"];

/// The unit-test command of the repo at `repo`, or `None` when nothing safe qualifies.
pub fn pick(repo: &Path) -> Option<TestPick> {
    let cat = catalog::catalog("", repo).ok()?;
    let usable = |s: &&ScriptInfo| s.group == ScriptGroup::Test && s.safety == Safety::Normal && !s.forbidden_to_agents;
    let candidates: Vec<&ScriptInfo> = cat.scripts.iter().filter(usable).collect();
    if let Some(p) = pick_npm(repo, &candidates) {
        return Some(p);
    }
    let synthetic = |id: &str, kind: TestKind| candidates.iter().find(|s| s.id == id).map(|s| TestPick { script: s.id.clone(), runner: s.runner.clone(), kind });
    synthetic("cargo:test", TestKind::Cargo).or_else(|| synthetic(PYTEST_ID, TestKind::Pytest))
}

fn pick_npm(repo: &Path, candidates: &[&ScriptInfo]) -> Option<TestPick> {
    let npm: Vec<&ScriptInfo> = candidates.iter().copied().filter(|s| s.source == "npm").collect();
    if npm.is_empty() {
        return None;
    }
    let (_, scripts, _) = catalog::load(repo).ok()?;
    for name in PREFERRED {
        let id = format!("npm:{name}");
        let Some(info) = npm.iter().find(|s| s.id == id) else { continue };
        let all = catalog::closure(name, &scripts);
        let lower = all.to_ascii_lowercase();
        if NEVER_TEXT.iter().any(|t| lower.contains(t)) || catalog::words(name).iter().chain(catalog::words(&all).iter()).any(|w| NEVER.contains(&w.as_str())) {
            continue;
        }
        return Some(TestPick { script: info.id.clone(), runner: info.runner.clone(), kind: kind_of(&all) });
    }
    None
}

fn kind_of(closure_text: &str) -> TestKind {
    let w = catalog::words(closure_text);
    let has = |x: &str| w.iter().any(|y| y == x);
    let lower = closure_text.to_ascii_lowercase();
    if has("vitest") {
        TestKind::Vitest
    } else if has("jest") || lower.contains("react-scripts test") || lower.contains("craco test") {
        TestKind::Jest
    } else {
        TestKind::Unknown
    }
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

    fn pkg(scripts: &str) -> String {
        format!(r#"{{"name":"fx","version":"1.0.0","scripts":{{{scripts}}}}}"#)
    }

    fn picked(files: &[(&str, &str)]) -> Option<TestPick> {
        let dir = repo(files);
        pick(dir.path())
    }

    #[test]
    fn prefers_the_unit_script_and_detects_the_runner() {
        let p = picked(&[("package.json", &pkg(r#""test":"vitest","test:unit":"vitest run src","test:e2e":"playwright test""#)), ("pnpm-lock.yaml", "")]).unwrap();
        assert_eq!(p, TestPick { script: "npm:test:unit".into(), runner: "pnpm run test:unit".into(), kind: TestKind::Vitest });
        let p = picked(&[("package.json", &pkg(r#""test":"jest --passWithNoTests","lint":"eslint .""#))]).unwrap();
        assert_eq!((p.script.as_str(), p.kind), ("npm:test", TestKind::Jest));
        // React Native: jest through the test script (the preset lives in the jest config)
        let p = picked(&[("package.json", &pkg(r#""android":"react-native run-android","ios":"react-native run-ios","start":"react-native start","test":"jest""#))]).unwrap();
        assert_eq!((p.script.as_str(), p.runner.as_str(), p.kind), ("npm:test", "npm run test", TestKind::Jest));
        // a referenced script decides the runner, CRA counts as jest, anything else is unknown
        let p = picked(&[("package.json", &pkg(r#""test":"npm run unit","unit":"vitest run""#))]).unwrap();
        assert_eq!((p.script.as_str(), p.kind), ("npm:unit", TestKind::Vitest), "unit comes before test");
        assert_eq!(picked(&[("package.json", &pkg(r#""test":"react-scripts test""#))]).unwrap().kind, TestKind::Jest);
        assert_eq!(picked(&[("package.json", &pkg(r#""test":"mocha 'src/**/*.spec.js'""#))]).unwrap().kind, TestKind::Unknown);
        assert_eq!(picked(&[("package.json", &pkg(r#""test":"node --test""#))]).unwrap().kind, TestKind::Unknown);
        // a backend's own server tests are unit tests too
        assert_eq!(picked(&[("package.json", &pkg(r#""test":"jest tests/server""#))]).unwrap().kind, TestKind::Jest);
    }

    #[test]
    fn the_choice_is_the_same_every_time() {
        let dir = repo(&[("package.json", &pkg(r#""jest":"jest","vitest":"vitest run","test:ci":"jest --ci","tests":"vitest run""#))]);
        let first = pick(dir.path()).unwrap();
        assert_eq!(first.script, "npm:tests");
        for _ in 0..5 {
            assert_eq!(pick(dir.path()).unwrap(), first);
        }
    }

    #[test]
    fn never_picks_end_to_end_device_or_watch_scripts() {
        for scripts in [
            r#""test":"cypress run""#,
            r#""test":"playwright test""#,
            r#""test":"detox test -c ios.sim.release""#,
            r#""test":"maestro test flows/""#,
            r#""test":"wdio run wdio.conf.js""#,
            r#""test":"jest --config jest.integration.js""#,
            r#""test":"jest --watch""#,
            r#""test":"jest --watchAll""#,
            r#""test":"vitest --ui""#,
            r#""test:watch":"vitest""#,
            r#""test":"start-server-and-test start http://localhost:3000 cy:run","cy:run":"cypress run""#,
            r#""test:e2e":"playwright test","e2e":"detox test""#,
            r#""test":"echo \"Error: no test specified\" && exit 1""#,
            r#""test:lambdatest":"node lt.js""#,
        ] {
            assert_eq!(picked(&[("package.json", &pkg(scripts))]), None, "{scripts}");
        }
    }

    #[test]
    fn never_picks_a_script_that_chains_into_a_deploy() {
        let chained = pkg(r#""test":"jest && npm run ship","ship":"npm run go","go":"npx wrangler pages deploy ./dist""#);
        assert_eq!(picked(&[("package.json", &chained)]), None);
        // a safe sibling is still found
        let with_unit = pkg(r#""test":"jest && npm run ship","ship":"npm run go","go":"npx wrangler pages deploy ./dist","test:unit":"jest src""#);
        assert_eq!(picked(&[("package.json", &with_unit)]).unwrap().script, "npm:test:unit");
        // a test script that cleans up or installs needs a confirmation, so it is never started by itself
        assert_eq!(picked(&[("package.json", &pkg(r#""test":"rimraf coverage && jest""#))]), None);
        assert_eq!(picked(&[("package.json", &pkg(r#""test":"npm install && jest""#))]), None);
    }

    #[test]
    fn falls_back_to_cargo_then_pytest() {
        let p = picked(&[("Cargo.toml", "[package]\nname=\"x\"\n")]).unwrap();
        assert_eq!(p, TestPick { script: "cargo:test".into(), runner: "cargo test".into(), kind: TestKind::Cargo });
        let p = picked(&[("package.json", &pkg(r#""dev":"vite","build":"vite build""#)), ("src-tauri/Cargo.toml", "[package]\nname=\"x\"\n")]).unwrap();
        assert_eq!((p.script.as_str(), p.runner.as_str()), ("cargo:test", "cargo test --manifest-path src-tauri/Cargo.toml"));
        // npm wins over cargo when it has a unit-test script
        let p = picked(&[("package.json", &pkg(r#""test":"vitest run""#)), ("src-tauri/Cargo.toml", "[package]\nname=\"x\"\n")]).unwrap();
        assert_eq!(p.script, "npm:test");
        for marker in [("pytest.ini", "[pytest]\n"), ("conftest.py", "import pytest\n"), ("pyproject.toml", "[project]\nname='x'\n[tool.pytest.ini_options]\n")] {
            let p = picked(&[marker, ("app.py", "x = 1\n")]).unwrap();
            assert_eq!(p, TestPick { script: PYTEST_ID.into(), runner: "python3 -m pytest -q".into(), kind: TestKind::Pytest }, "{}", marker.0);
        }
        assert_eq!(picked(&[("app.py", "x = 1\n"), ("pyproject.toml", "[project]\nname='x'\n")]), None, "python without pytest markers");
        assert_eq!(picked(&[("tests/conftest.py", "")]), None, "only a conftest.py at the root counts");
    }

    #[test]
    fn hostile_or_empty_repos_give_nothing() {
        assert_eq!(picked(&[]), None);
        assert_eq!(picked(&[("package.json", "{nope")]), None);
        assert_eq!(picked(&[("package.json", &pkg(r#""dev":"vite""#))]), None);
        assert_eq!(picked(&[("package.json", &pkg(r#""test:e2e":"playwright test","test:integration":"jest -c int.js""#))]), None, "e2e-only repo");
        let mut big = pkg(r#""test":"vitest run""#);
        big.push_str(&" ".repeat(2 * 1024 * 1024 + 10));
        assert_eq!(picked(&[("package.json", &big)]), None, "a package.json over 2 MB is not read");
        // a script name with odd characters is never picked (only the fixed names are)
        assert_eq!(picked(&[("package.json", &pkg(r#""test; rm -rf /":"jest""#))]), None);
        // a huge pyproject is not read
        let huge = format!("[project]\n{}\n[tool.pytest.ini_options]\n", "#".repeat(600 * 1024));
        assert_eq!(picked(&[("pyproject.toml", &huge)]), None);
    }
}
