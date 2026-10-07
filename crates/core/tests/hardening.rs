//! Git hardening ((design notes: workspaces-spec) T4, T7): a hostile `core.fsmonitor` is never executed by an IDE-spawned git,
//! every git spawn in the workspace goes through the hardened helper (lint), and `git init` is a jailed mutation.

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use common::{Fixture, Harness, Sandbox};
use intely_core::exec::{hardened_git, pinned_git_path, run_git, RunOpts, HARDENING_ARGS};
use intely_core::git::init::{init_repo, init_repo_with, ALREADY_REPO, INVALID_BRANCH};
use intely_core::jail::{Jail, MUTATING_COMMANDS, READ_ONLY, TEST_JAIL};
use intely_core::status;

/// Process-wide environment (`GIT_TEMPLATE_DIR`) is touched by one test; the others must not spawn git meanwhile.
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn lock() -> MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// A committed repo whose config makes `git status` start `<repo>/../hook.sh`, which leaves a marker file.
fn hostile(sb: &Sandbox, name: &str, program: Option<&str>) -> (Fixture, PathBuf) {
    let fx = sb.repo(name);
    fx.write("a.txt", "a\n");
    fx.commit_all("init");
    let marker = sb.root().join(format!("{name}.marker"));
    let script = sb.root().join(format!("{name}-hook.sh"));
    std::fs::write(&script, format!("#!/bin/sh\n: > '{}'\nexit 0\n", marker.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    fx.git(&["config", "core.fsmonitor", program.unwrap_or(script.to_str().unwrap())]);
    // dirty the stat data so a refresh has work to do
    fx.write("a.txt", "changed\n");
    (fx, marker)
}

#[tokio::test]
async fn a_marker_writing_fsmonitor_never_runs_via_core_snapshot_or_run_git() {
    let _g = lock();
    let sb = Sandbox::new();
    let (fx, marker) = hostile(&sb, "evil", None);

    // control: the unhardened git of the fixture helper really does run the program (otherwise this test proves nothing)
    fx.git(&["status", "--porcelain"]);
    assert!(marker.exists(), "control failed: a plain git status did not run core.fsmonitor");
    std::fs::remove_file(&marker).unwrap();

    let ctx = Harness::new().plain();
    let snap = status::snapshot(&ctx, &fx.cfg).await.expect("snapshot");
    assert!(snap.error.is_none(), "{:?}", snap.error);
    assert!(!marker.exists(), "core snapshot executed core.fsmonitor");

    for args in [&["status", "--porcelain"][..], &["diff", "--stat"], &["ls-files", "-m"], &["log", "-1", "--oneline"], &["commit", "--dry-run", "-a", "-m", "x"]] {
        let _ = run_git(&ctx, &fx.path, args, &RunOpts::default()).await.expect("run_git");
        assert!(!marker.exists(), "run_git {args:?} executed core.fsmonitor");
    }
}

#[tokio::test]
async fn a_boolean_fsmonitor_repo_still_snapshots_and_starts_no_daemon() {
    let _g = lock();
    let sb = Sandbox::new();
    let (fx, _marker) = hostile(&sb, "booly", Some("true"));
    let ctx = Harness::new().plain();
    let snap = status::snapshot(&ctx, &fx.cfg).await.expect("snapshot");
    assert!(snap.error.is_none(), "{:?}", snap.error);
    assert_eq!(snap.changes.len(), 1, "the modified file must be listed: {:?}", snap.changes);
    // `git fsmonitor--daemon status` exits non-zero when no daemon runs for the repo
    let out = std::process::Command::new(pinned_git_path()).arg("-C").arg(&fx.path).args(["fsmonitor--daemon", "status"]).output().unwrap();
    assert!(!out.status.success(), "a daemon was started: {}", String::from_utf8_lossy(&out.stdout));
}

#[test]
fn the_helper_carries_the_hardening_config() {
    let cmd = hardened_git("git");
    let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
    assert_eq!(args, HARDENING_ARGS);
    assert!(args.contains(&"core.fsmonitor=false".to_owned()));
}

// ---- lint: no unhardened git spawn in the workspace ---------------------------------------------------------------------

/// Files with a git `Command::new` that neither goes through the helper nor passes `core.fsmonitor=false` itself.
/// A git spawn is a `Command::new(<arg>)` whose argument mentions "git". Test modules (after the first `#[cfg(test)]`)
/// and `tests/` directories are skipped: fixtures run git on repos they built themselves.
fn unhardened_git_spawns(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name();
            if p.is_dir() {
                if name == "tests" || name == "target" || name == "node_modules" || name == ".git" {
                    continue;
                }
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }
    let mut files = Vec::new();
    walk(root, &mut files);
    files.sort();
    let mut bad = Vec::new();
    for f in files {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        let lines: Vec<&str> = text.lines().take_while(|l| l.trim() != "#[cfg(test)]").collect();
        for (i, l) in lines.iter().enumerate() {
            let t = l.trim_start();
            if t.starts_with("//") {
                continue;
            }
            let Some(at) = l.find("Command::new(") else { continue };
            if !l[at..].to_lowercase().contains("git") {
                continue;
            }
            let window = lines[i..lines.len().min(i + 10)].join("\n");
            if window.contains("core.fsmonitor=false") || window.contains("HARDENING_ARGS") {
                continue;
            }
            bad.push(format!("{}:{}: {}", f.display(), i + 1, l.trim()));
        }
    }
    bad
}

/// Known git spawns that do not touch user repositories. Every entry needs a reason; the list must only shrink.
const LINT_ALLOW: [(&str, &str); 1] = [("crates/relay_deploy/src/kit.rs", "reads the status of the IDE's own source checkout (remote-relay, remote-web), never a workspace repo")];

#[test]
fn every_git_spawn_in_the_workspace_is_hardened() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut bad = Vec::new();
    for dir in ["crates", "src-tauri/src"] {
        bad.extend(unhardened_git_spawns(&root.join(dir)));
    }
    bad.retain(|b| !LINT_ALLOW.iter().any(|(f, _)| b.contains(f)));
    assert!(bad.is_empty(), "git spawns without core.fsmonitor=false (use intely_core::exec::hardened_git):\n{}", bad.join("\n"));
}

#[test]
fn the_lint_fails_when_an_unhardened_git_spawn_is_injected() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("crates/x/src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("ok.rs"), "fn a() {\n    let mut c = hardened_git(pinned_git_path());\n    let d = Command::new(\"ls\");\n}\n").unwrap();
    std::fs::write(src.join("ok2.rs"), "fn a() {\n    let c = Command::new(\"git\")\n        .args([\"-c\", \"core.fsmonitor=false\"]);\n}\n").unwrap();
    std::fs::write(src.join("ok3.rs"), "fn a() {}\n#[cfg(test)]\nmod t { fn b() { Command::new(\"git\"); } }\n").unwrap();
    assert!(unhardened_git_spawns(dir.path()).is_empty());

    std::fs::write(src.join("bad.rs"), "fn a() {\n    let c = std::process::Command::new(pinned_git_path());\n    c.arg(\"status\");\n}\n").unwrap();
    let bad = unhardened_git_spawns(dir.path());
    assert_eq!(bad.len(), 1, "{bad:?}");
    assert!(bad[0].contains("bad.rs:2"), "{bad:?}");

    std::fs::write(src.join("bad2.rs"), "fn a() { let c = tokio::process::Command::new(&ctx.git_path); }\n").unwrap();
    assert_eq!(unhardened_git_spawns(dir.path()).len(), 2);
}

// ---- git init -------------------------------------------------------------------------------------------------------------

#[test]
fn init_is_a_mutating_command() {
    assert!(MUTATING_COMMANDS.contains(&"init"));
    assert_eq!(MUTATING_COMMANDS.len(), 18);
}

#[tokio::test]
async fn init_repo_works_under_the_e2e_jail_and_creates_no_template_hooks() {
    let _g = lock();
    let sb = Sandbox::new();
    let dir = sb.root().join("work/plain");
    std::fs::create_dir_all(&dir).unwrap();
    // a hostile template directory from the environment must not be copied
    let tpl = sb.root().join("tpl");
    std::fs::create_dir_all(tpl.join("hooks")).unwrap();
    std::fs::write(tpl.join("hooks/pre-commit"), "#!/bin/sh\nexit 1\n").unwrap();
    std::env::set_var("GIT_TEMPLATE_DIR", &tpl);
    let jail = Arc::new(Jail::e2e(sb.root()));
    let r = init_repo(&jail, &dir, "main").await;
    std::env::remove_var("GIT_TEMPLATE_DIR");
    r.expect("init under the e2e jail");
    assert!(dir.join(".git/HEAD").is_file());
    assert_eq!(std::fs::read_to_string(dir.join(".git/HEAD")).unwrap().trim(), "ref: refs/heads/main");
    assert!(!dir.join(".git/hooks/pre-commit").exists(), "a template hook was copied");
}

#[tokio::test]
async fn init_repo_is_refused_read_only_and_outside_the_e2e_root_and_creates_nothing() {
    let _g = lock();
    let sb = Sandbox::new();
    let other = Sandbox::new();
    let dir = sb.root().join("work/ro");
    std::fs::create_dir_all(&dir).unwrap();
    let ro = init_repo(&Arc::new(Jail::read_only()), &dir, "main").await.unwrap_err();
    assert_eq!(ro.code, READ_ONLY, "{ro:?}");
    assert!(!dir.join(".git").exists());

    let outside = other.root().join("work/out");
    std::fs::create_dir_all(&outside).unwrap();
    let e = init_repo(&Arc::new(Jail::e2e(sb.root())), &outside, "main").await.unwrap_err();
    assert_eq!(e.code, TEST_JAIL, "{e:?}");
    assert!(!outside.join(".git").exists());
}

#[tokio::test]
async fn init_repo_refuses_an_existing_git_entry_and_bad_branch_names() {
    let _g = lock();
    let sb = Sandbox::new();
    let jail = Arc::new(Jail::e2e(sb.root()));
    let repo = sb.repo("already");
    let e = init_repo(&jail, &repo.path, "main").await.unwrap_err();
    assert_eq!(e.code, ALREADY_REPO, "{e:?}");

    let dir = sb.root().join("work/branches");
    std::fs::create_dir_all(&dir).unwrap();
    for bad in ["", "-x", "a..b", "a b", "x/", "--template=/tmp", "a;b", "refs/../x", "main.lock", ".hidden"] {
        let e = init_repo(&jail, &dir, bad).await.unwrap_err();
        assert_eq!(e.code, INVALID_BRANCH, "{bad:?}");
    }
    assert!(!dir.join(".git").exists());
    // a dangling .git symlink counts as an existing entry
    let dang = sb.root().join("work/dangling");
    std::fs::create_dir_all(&dang).unwrap();
    std::os::unix::fs::symlink("/nonexistent-target", dang.join(".git")).unwrap();
    assert_eq!(init_repo(&jail, &dang, "main").await.unwrap_err().code, ALREADY_REPO);
}

#[tokio::test]
async fn init_repo_with_uses_the_given_context_and_missing_dirs_are_not_created() {
    let _g = lock();
    let sb = Sandbox::new();
    let ctx = Harness::new().plain().with_jail(Arc::new(Jail::e2e(sb.root())));
    let missing = sb.root().join("work/not-there");
    let e = init_repo_with(&ctx, &missing, "main").await.unwrap_err();
    assert_eq!(e.code, intely_core::code::REPO_MISSING, "{e:?}");
    assert!(!missing.exists());
}
