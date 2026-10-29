//! Tauri glue of the Web and Node helpers on top of `intely_webtools`. Everything here reads: the static scans never write a file,
//! `webtools_try` sends one request to a dev server on this computer (the ports of the servers the Scripts panel started, loopback
//! only, see `intely_webtools::tryit`), and `webtools_deps_check` runs `npm outdated` / `npm audit` once, after the person confirmed
//! that they use the network. The webview never sends a command line: only a repo id and a folder that a `package.json` was found in.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use intely_core::jail::Jail;
use intely_core::EngineError;
use intely_runner::types::ServerStatus;
use intely_webtools::tryit::{TryRequest, TryResponse};
use intely_webtools::{
    bundle_report, detect, env_report, find_rule, parse_audit, parse_outdated, react_checks, route_map, token_report, unused_styles, AuditReport, BundleReport, Detect, EnvReport, OutdatedPkg, ReactOptions, ReactReport, RouteMap,
    RuleMatch, RuleQuery, TokensReport, WebError,
};
use serde::Serialize;
use tauri::State;

use super::runner::RunState;
use crate::agents::{blocking, repos};
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

fn web(e: WebError) -> EngineError {
    EngineError::new(e.code, e.message)
}

async fn repo_path(engine: &EngineSlot, repo_id: &str) -> Res<std::path::PathBuf> {
    repos(engine).await?.into_iter().find(|r| r.id == repo_id).map(|r| r.path).ok_or_else(|| EngineError::new("notFound", format!("unknown repository {repo_id}")))
}

#[tauri::command]
pub async fn webtools_detect(engine: State<'_, EngineSlot>, repo_id: String) -> Res<Detect> {
    let root = repo_path(&engine, &repo_id).await?;
    blocking(move || detect(&root).map_err(web)).await
}

#[tauri::command]
pub async fn webtools_tokens(engine: State<'_, EngineSlot>, repo_id: String) -> Res<TokensReport> {
    let root = repo_path(&engine, &repo_id).await?;
    blocking(move || token_report(&root).map_err(web)).await
}

#[tauri::command]
pub async fn webtools_unused_styles(engine: State<'_, EngineSlot>, repo_id: String) -> Res<intely_webtools::UnusedReport> {
    let root = repo_path(&engine, &repo_id).await?;
    blocking(move || unused_styles(&root).map_err(web)).await
}

#[tauri::command]
pub async fn webtools_react(engine: State<'_, EngineSlot>, repo_id: String, max_lines: Option<u32>, max_props: Option<u32>) -> Res<ReactReport> {
    let root = repo_path(&engine, &repo_id).await?;
    let opts = ReactOptions { max_lines: max_lines.unwrap_or(200).clamp(20, 2000), max_props: max_props.unwrap_or(10).clamp(3, 60) };
    blocking(move || react_checks(&root, opts).map_err(web)).await
}

#[tauri::command]
pub async fn webtools_bundle(engine: State<'_, EngineSlot>, repo_id: String) -> Res<BundleReport> {
    let root = repo_path(&engine, &repo_id).await?;
    blocking(move || bundle_report(&root).map_err(web)).await
}

#[tauri::command]
pub async fn webtools_routes(engine: State<'_, EngineSlot>, repo_id: String) -> Res<RouteMap> {
    let root = repo_path(&engine, &repo_id).await?;
    blocking(move || route_map(&root).map_err(web)).await
}

#[tauri::command]
pub async fn webtools_find_rule(engine: State<'_, EngineSlot>, repo_id: String, query: RuleQuery) -> Res<Vec<RuleMatch>> {
    let root = repo_path(&engine, &repo_id).await?;
    blocking(move || find_rule(&root, &query).map_err(web)).await
}

/// The env files Git tracks, by path (names of files, never contents). Empty when Git cannot say.
fn tracked_env_files(root: &Path) -> Vec<String> {
    let mut cmd = intely_core::exec::hardened_git(intely_core::exec::pinned_git_path());
    cmd.arg("-C").arg(root).args(["ls-files", "-z", "--", ":(glob)**/.env", ":(glob)**/.env.*"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let Ok(mut child) = cmd.spawn() else { return Vec::new() };
    let Some(mut out) = child.stdout.take() else { return Vec::new() };
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut out).take(1024 * 1024).read_to_end(&mut buf);
        buf
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < Duration::from_secs(5) => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    let buf = reader.join().unwrap_or_default();
    String::from_utf8_lossy(&buf).split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect()
}

#[tauri::command]
pub async fn webtools_env(engine: State<'_, EngineSlot>, repo_id: String) -> Res<EnvReport> {
    let root = repo_path(&engine, &repo_id).await?;
    blocking(move || {
        let tracked = tracked_env_files(&root);
        env_report(&root, &tracked).map_err(web)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveServer {
    id: String,
    repo_id: String,
    runner: String,
    ports: Vec<u16>,
}

/// The dev servers started from the Scripts panel that are alive and listen somewhere.
fn live_servers(run: &RunState) -> Vec<LiveServer> {
    run.0
        .list()
        .into_iter()
        .filter(|s| matches!(s.status, ServerStatus::Starting | ServerStatus::Running) && !s.ports.is_empty())
        .map(|s| LiveServer { id: s.id, repo_id: s.repo_id, runner: s.runner, ports: s.ports })
        .collect()
}

#[tauri::command]
pub async fn webtools_servers(run: State<'_, RunState>) -> Res<Vec<LiveServer>> {
    Ok(live_servers(&run))
}

/// One request to `127.0.0.1` / `::1` on the port of a live dev server; any other port is refused.
#[tauri::command]
pub async fn webtools_try(run: State<'_, RunState>, request: TryRequest) -> Res<TryResponse> {
    let allowed: Vec<u16> = live_servers(&run).into_iter().flat_map(|s| s.ports).collect();
    blocking(move || intely_webtools::tryit::send(&request, &allowed).map_err(web)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepsReport {
    outdated: Option<Vec<OutdatedPkg>>,
    audit: Option<AuditReport>,
    /// Plain-language notes: a part that failed (offline, no lock file), never raw output.
    notes: Vec<String>,
}

const OUT_CAP: u64 = 4 * 1024 * 1024;
const RUN_LIMIT: Duration = Duration::from_secs(90);

/// Runs `npm <args>` in `dir` with the login environment, in a process group of its own, under a time limit and an output cap.
/// Returns (stdout, exit code). Exit 1 is normal for `npm outdated` (it means "something is outdated").
fn run_npm(dir: &Path, args: &[&str], env: &HashMap<String, String>, jail: &Jail) -> Result<(String, i32, String), EngineError> {
    let mut cmd = Command::new(intely_core::sys::program("npm"));
    cmd.args(args).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    intely_core::sys::NewGroup::new_group(&mut cmd);
    for key in std::env::vars_os().filter_map(|(k, _)| k.into_string().ok()).filter(|k| k.starts_with("INTELY_") || k == "CI") {
        cmd.env_remove(key);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    for (k, v) in [("NO_UPDATE_NOTIFIER", "1"), ("npm_config_update_notifier", "false"), ("npm_config_fund", "false"), ("npm_config_ignore_scripts", "true"), ("NO_COLOR", "1")] {
        cmd.env(k, v);
    }
    for (k, v) in jail.env() {
        cmd.env(k, v);
    }
    for k in jail.removed_env() {
        cmd.env_remove(k);
    }
    let path = env.get("PATH").map(std::ffi::OsString::from).or_else(|| std::env::var_os("PATH"));
    if let Some(p) = intely_runner::guard::read_only_git_path(jail, path.as_deref())? {
        cmd.env("PATH", p);
    }
    let mut child = cmd.spawn().map_err(|e| EngineError::new("npmMissing", format!("could not start npm: {e}. Is Node.js installed?")))?;
    let pid = child.id() as intely_core::sys::Pid;
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(o) = out.as_mut() {
            let _ = o.take(OUT_CAP).read_to_end(&mut buf);
            let _ = std::io::copy(o, &mut std::io::sink());
        }
        buf
    });
    let err_t = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(e) = err.as_mut() {
            let _ = e.take(8 * 1024).read_to_end(&mut buf);
            let _ = std::io::copy(e, &mut std::io::sink());
        }
        buf
    });
    let started = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s.code().unwrap_or(143),
            Ok(None) if started.elapsed() < RUN_LIMIT => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                intely_core::sys::kill_group(pid, true);
                let _ = child.kill();
                let _ = child.wait();
                break 124;
            }
        }
    };
    let stdout = String::from_utf8_lossy(&out_t.join().unwrap_or_default()).into_owned();
    let stderr = intely_runner::mask::mask(&String::from_utf8_lossy(&err_t.join().unwrap_or_default()));
    Ok((stdout, code, stderr))
}

fn first_line(s: &str) -> String {
    s.lines().find(|l| !l.trim().is_empty()).map(|l| l.trim().chars().take(160).collect()).unwrap_or_default()
}

/// Opt-in: `npm outdated --json` and `npm audit --json`. Both ask the npm registry, so the person confirms first (`confirmed`).
#[tauri::command]
pub async fn webtools_deps_check(engine: State<'_, EngineSlot>, run: State<'_, RunState>, repo_id: String, dir: String, confirmed: bool) -> Res<DepsReport> {
    if !confirmed {
        return Err(EngineError::new("confirmRequired", "Check dependencies asks the npm registry over the network and needs a confirmation"));
    }
    let root = repo_path(&engine, &repo_id).await?;
    let env: HashMap<String, String> = engine.get().map(intely_core::Engine::login_env).unwrap_or_default();
    let allowed = run.0.allow_processes();
    let (root2, dir2) = (root.clone(), dir.clone());
    // only a folder in which a package.json was found, with an npm lock file
    let found = blocking(move || detect(&root2).map_err(web)).await?;
    let Some(pkg) = found.packages.iter().find(|p| p.dir == dir2) else { return Err(EngineError::new("notFound", "no package.json in that folder")) };
    if pkg.manager != "npm" {
        return Err(EngineError::new("unsupportedManager", format!("only npm projects are supported (this folder uses {})", pkg.manager)));
    }
    let cwd = if dir.is_empty() { root } else { root.join(&dir) };
    let jail = Jail::global();
    intely_runner::guard::check_process(&jail, allowed, &cwd)?;
    blocking(move || {
        let mut report = DepsReport { outdated: None, audit: None, notes: Vec::new() };
        let (out, code, err) = run_npm(&cwd, &["outdated", "--json"], &env, &jail)?;
        if code == 124 {
            report.notes.push("timeout".into());
        } else {
            match parse_outdated(&out) {
                Ok(list) => report.outdated = Some(list),
                Err(e) => report.notes.push(format!("outdated: {}", if e.code == "npm" { e.message } else { first_line(&err) })),
            }
        }
        let (out, code, err) = run_npm(&cwd, &["audit", "--json"], &env, &jail)?;
        if code == 124 {
            report.notes.push("timeout".into());
        } else {
            match parse_audit(&out) {
                Ok(a) => report.audit = Some(a),
                Err(e) => report.notes.push(format!("audit: {}", if e.code == "npm" { e.message } else { first_line(&err) })),
            }
        }
        Ok(report)
    })
    .await
}
