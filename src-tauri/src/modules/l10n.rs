//! Tauri glue of the localization checker and the release assistant (Wave 3 X1) on top of `intely_l10n`.
//! `l10n_analyze` and `l10n_release_plan` only read. `l10n_apply` and `l10n_release_apply` write locale JSON,
//! `package.json` and the changelog file, after the jail said yes; nothing here commits, tags or pushes.
//! `l10n_draft` asks a Haiku utility session (a one-shot `claude -p` with no tools) for translations; the answers are
//! only returned, the UI lets the human accept them per key before `l10n_apply` writes anything.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
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
/// installed with npm needs `node` on it), as the agent runs get them.
pub(crate) fn run_claude_at(bin: Option<PathBuf>, path: Option<&str>, model: &str, prompt: &str, timeout: Duration) -> Res<String> {
    static CALLS: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!("intely-claude-{}-{}", std::process::id(), CALLS.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&dir).map_err(|e| EngineError::new("io", e.to_string()))?;
    let result = one_shot(&bin.unwrap_or_else(claude_bin), path, model, prompt, timeout, &dir);
    let _ = std::fs::remove_dir(&dir);
    result
}

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
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes());
    }
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(EngineError::new("timeout", format!("the answer took longer than {} seconds", timeout.as_secs())));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(EngineError::new("model", e.to_string())),
        }
    };
    let out = child.wait_with_output().map_err(|e| EngineError::new("model", e.to_string()))?;
    if !status.success() {
        let err: String = String::from_utf8_lossy(&out.stderr).chars().take(300).collect();
        return Err(EngineError::new("model", format!("claude exited with {status}: {err}")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
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
