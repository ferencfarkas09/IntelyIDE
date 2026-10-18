//! Tauri glue of the localization checker and the release assistant (Wave 3 X1) on top of `intely_l10n`.
//! `l10n_analyze` and `l10n_release_plan` only read. `l10n_apply` and `l10n_release_apply` write locale JSON,
//! `package.json` and the changelog file, after the jail said yes; nothing here commits, tags or pushes.
//! `l10n_draft` asks a Haiku utility session (a one-shot `claude -p` with no tools) for translations; the answers are
//! only returned, the UI lets the human accept them per key before `l10n_apply` writes anything.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use intely_core::jail::{Jail, Mode};
use intely_core::EngineError;
use intely_l10n::analyze::Report;
use intely_l10n::draft::{parse, prompt, DraftItem, Drafted};
use intely_l10n::edit::{apply, Applied, Edit};
use intely_l10n::release::{apply as release_apply, plan, ApplyRequest, Plan};
use tauri::State;

use crate::agents::{blocking, repos};
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

const MODEL: &str = "claude-haiku-4-5-20251001";
const BATCH: usize = 40;
const TIMEOUT: Duration = Duration::from_secs(150);

async fn repo_path(engine: &EngineSlot, repo_id: &str) -> Res<PathBuf> {
    repos(engine).await?.into_iter().find(|r| r.id == repo_id).map(|r| r.path).ok_or_else(|| EngineError::new("notFound", format!("unknown repository {repo_id}")))
}

#[tauri::command]
pub async fn l10n_analyze(engine: State<'_, EngineSlot>, repo_id: String) -> Res<Report> {
    let root = repo_path(&engine, &repo_id).await?;
    blocking(move || Ok(intely_l10n::analyze(&root))).await
}

#[tauri::command]
pub async fn l10n_apply(engine: State<'_, EngineSlot>, repo_id: String, edits: Vec<Edit>) -> Res<Applied> {
    let root = repo_path(&engine, &repo_id).await?;
    Jail::global().check_op("l10n_apply", &root)?;
    blocking(move || apply(&root, &edits).map_err(|e| EngineError::new(e.code, e.message))).await
}

#[tauri::command]
pub async fn l10n_draft(items: Vec<DraftItem>) -> Res<Vec<Drafted>> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    if std::env::var_os("INTELY_L10N_FAKE").is_some() {
        // Deterministic stand-in for the model (tests, e2e, offline demos).
        return Ok(items.iter().map(|i| Drafted { id: i.id.clone(), text: format!("[{}] {}", i.lang, i.reference), valid: true, note: None }).collect());
    }
    if Jail::global().mode() == Mode::ReadOnly {
        return Err(EngineError::new(intely_core::jail::READ_ONLY, "read-only mode (INTELY_READONLY): translating needs the network"));
    }
    blocking(move || {
        let mut out = Vec::new();
        for chunk in items.chunks(BATCH) {
            let answer = run_claude(&prompt(chunk))?;
            out.extend(parse(&answer, chunk).map_err(|m| EngineError::new("model", m))?);
        }
        Ok(out)
    })
    .await
}

fn claude_bin() -> PathBuf {
    if let Some(p) = std::env::var_os("INTELY_CLAUDE_BIN") {
        return PathBuf::from(p);
    }
    let home = intely_core::sys::home_dir().unwrap_or_default();
    let mut places = vec![home.join(".local/bin"), home.join(".claude/local"), PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];
    if cfg!(windows) {
        places.extend(std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("npm")));
    }
    places
        .iter()
        .flat_map(|d| intely_core::sys::executable_names("claude").into_iter().map(move |n| d.join(n)))
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from(intely_core::sys::program("claude")))
}

/// One tool-less Haiku call from an empty directory, so no project settings, hooks or memory are loaded.
pub(crate) fn run_claude(prompt: &str) -> Res<String> {
    run_claude_with(MODEL, prompt, TIMEOUT)
}

/// The same one-shot with another model (a name or an alias such as `sonnet`) and time limit. Every call gets its own empty directory,
/// so calls that run at the same time (one draft per repository) do not remove each other's.
pub(crate) fn run_claude_with(model: &str, prompt: &str, timeout: Duration) -> Res<String> {
    run_claude_at(None, None, model, prompt, timeout)
}

/// [`run_claude_with`] with the `claude` the login shell finds and its `PATH` (a program started from the Dock has a short one, and a `claude`
/// installed with npm needs `node` on it), as the agent runs get them. `INTELY_CLAUDE_BIN` still wins, as everywhere else.
pub(crate) fn run_claude_at(bin: Option<PathBuf>, path: Option<&str>, model: &str, prompt: &str, timeout: Duration) -> Res<String> {
    static CALLS: AtomicU64 = AtomicU64::new(0);
    let bin = std::env::var_os("INTELY_CLAUDE_BIN").map(PathBuf::from).or(bin).unwrap_or_else(claude_bin);
    // a folder of its own that did not exist before (never someone else's), private to this user
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let dir = std::env::temp_dir().join(format!("intely-claude-{}-{}-{nonce:x}", std::process::id(), CALLS.fetch_add(1, Ordering::Relaxed)));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&dir).map_err(|e| EngineError::new("io", e.to_string()))?;
    let result = one_shot(&bin, path, model, prompt, timeout, &dir);
    let _ = std::fs::remove_dir(&dir);
    result
}

/// Reads a pipe to its end into the shared buffer.
fn collect(mut pipe: impl std::io::Read + Send + 'static, into: Arc<Mutex<Vec<u8>>>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 {
                break;
            }
            into.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(&chunk[..n]);
        }
    })
}

/// The prompt goes in and both outputs come out on threads of their own, so that the time limit covers all of it: a program that stops
/// reading its input, floods an output or leaves a child holding a pipe cannot hold this call past `timeout`.
fn one_shot(bin: &std::path::Path, path: Option<&str>, model: &str, prompt: &str, timeout: Duration, dir: &std::path::Path) -> Res<String> {
    let mut command = Command::new(bin);
    command.args(["-p", "--model", model, "--output-format", "text", "--tools", "", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config"]).current_dir(dir);
    if let Some(path) = path {
        command.env("PATH", path);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| EngineError::new("model", format!("could not start claude: {e}")))?;
    let input = prompt.as_bytes().to_vec();
    let writer = child.stdin.take().map(|mut stdin| {
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        })
    });
    let (out, err) = (Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(Vec::new())));
    let readers: Vec<_> = [child.stdout.take().map(|p| collect(p, out.clone())), child.stderr.take().map(|p| collect(p, err.clone()))].into_iter().flatten().collect();
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(EngineError::new("timeout", format!("the answer took longer than {} seconds", timeout.as_secs())));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(EngineError::new("model", e.to_string())),
        }
    };
    // what the program wrote before it ended is complete once its pipes close; a child that still holds them is not waited for
    let grace = Instant::now();
    while grace.elapsed() < Duration::from_secs(2) && !readers.iter().all(|r| r.is_finished()) {
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(writer);
    let text = |b: &Arc<Mutex<Vec<u8>>>| String::from_utf8_lossy(&b.lock().unwrap_or_else(|e| e.into_inner())).into_owned();
    if !status.success() {
        let why: String = text(&err).chars().take(300).collect();
        return Err(EngineError::new("model", format!("claude exited with {status}: {why}")));
    }
    Ok(text(&out))
}

#[tauri::command]
pub async fn l10n_release_plan(engine: State<'_, EngineSlot>, repo_id: String, bump: Option<String>) -> Res<Plan> {
    let root = repo_path(&engine, &repo_id).await?;
    blocking(move || plan(&root, bump.as_deref()).map_err(|e| EngineError::new(e.code, e.message))).await
}

#[tauri::command]
pub async fn l10n_release_apply(engine: State<'_, EngineSlot>, repo_id: String, request: ApplyRequest) -> Res<Vec<String>> {
    let root = repo_path(&engine, &repo_id).await?;
    Jail::global().check_op("l10n_release_apply", &root)?;
    blocking(move || release_apply(&root, &request).map_err(|e| EngineError::new(e.code, e.message))).await
}

#[cfg(all(test, unix))]
mod one_shot_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A stand-in for `claude`: a script that gets the arguments and the prompt like the real one.
    fn script(body: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("claude");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("script");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        (dir, path)
    }

    #[test]
    fn a_large_prompt_goes_in_and_the_whole_answer_comes_out() {
        let (_keep, bin) = script("cat");
        let prompt = "x".repeat(300_000);
        let out = run_claude_at(Some(bin), None, "sonnet", &prompt, Duration::from_secs(20)).expect("answer");
        assert_eq!(out.len(), prompt.len());
    }

    #[test]
    fn a_program_that_never_reads_its_input_is_stopped_at_the_limit() {
        let (_keep, bin) = script("sleep 30");
        let started = Instant::now();
        let err = run_claude_at(Some(bin), None, "sonnet", &"x".repeat(300_000), Duration::from_millis(600)).unwrap_err();
        assert_eq!(err.code, "timeout");
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    }

    #[test]
    fn a_child_that_keeps_the_pipes_open_does_not_hold_the_answer_back() {
        let (_keep, bin) = script("cat >/dev/null\necho the answer\n(sleep 30 &)\nexit 0");
        let started = Instant::now();
        let out = run_claude_at(Some(bin), None, "sonnet", "hello", Duration::from_secs(20)).expect("answer");
        assert_eq!(out.trim(), "the answer");
        assert!(started.elapsed() < Duration::from_secs(8), "{:?}", started.elapsed());
    }

    #[test]
    fn a_failure_says_why_and_the_arguments_keep_the_tools_off() {
        let (_keep, bin) = script("echo \"args: $*\" >&2\nexit 3");
        let err = run_claude_at(Some(bin), None, "sonnet", "hi", Duration::from_secs(20)).unwrap_err();
        assert_eq!(err.code, "model");
        for needle in ["exit status: 3", "-p", "--model sonnet", "--tools", "--setting-sources", "--strict-mcp-config", "--no-session-persistence"] {
            assert!(err.message.contains(needle), "{needle} in {}", err.message);
        }
    }

    #[test]
    fn every_call_gets_its_own_private_folder_that_is_removed_after() {
        let (_keep, bin) = script("pwd");
        let a = run_claude_at(Some(bin.clone()), None, "sonnet", "", Duration::from_secs(20)).expect("a");
        let b = run_claude_at(Some(bin), None, "sonnet", "", Duration::from_secs(20)).expect("b");
        assert_ne!(a.trim(), b.trim());
        assert!(!std::path::Path::new(a.trim()).exists() && !std::path::Path::new(b.trim()).exists());
    }
}
