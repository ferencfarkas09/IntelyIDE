//! Tauri glue of the localization checker and the release assistant (Wave 3 X1) on top of `intely_l10n`.
//! `l10n_analyze` and `l10n_release_plan` only read. `l10n_apply` and `l10n_release_apply` write locale JSON,
//! `package.json` and the changelog file, after the jail said yes; nothing here commits, tags or pushes.
//! `l10n_draft` asks a Haiku utility session (a one-shot `claude -p` with no tools) for translations; the answers are
//! only returned, the UI lets the human accept them per key before `l10n_apply` writes anything.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
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
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    [home.join(".local/bin/claude"), home.join(".claude/local/claude"), PathBuf::from("/opt/homebrew/bin/claude"), PathBuf::from("/usr/local/bin/claude")]
        .into_iter()
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("claude"))
}

/// One tool-less Haiku call from an empty directory, so no project settings, hooks or memory are loaded.
pub(crate) fn run_claude(prompt: &str) -> Res<String> {
    let dir = std::env::temp_dir().join(format!("intely-l10n-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| EngineError::new("io", e.to_string()))?;
    let mut child = Command::new(claude_bin())
        .args(["-p", "--model", MODEL, "--output-format", "text", "--tools", "", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config"])
        .current_dir(&dir)
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
            Ok(None) if started.elapsed() > TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(EngineError::new("timeout", "the translation took longer than 150 seconds"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(EngineError::new("model", e.to_string())),
        }
    };
    let out = child.wait_with_output().map_err(|e| EngineError::new("model", e.to_string()))?;
    let _ = std::fs::remove_dir(&dir);
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
