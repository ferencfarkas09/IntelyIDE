//! Tauri glue of the Web and Node helpers on top of `intely_webtools`. Everything here reads: the static scans never write a file,
//! `webtools_try` sends one request to a dev server on this computer (the ports of the servers the Scripts panel started, loopback
//! only, see `intely_webtools::tryit`), and `webtools_deps_check` runs `npm outdated` / `npm audit` once, after the person confirmed
//! that they use the network. The webview never sends a command line: only a repo id and a folder that a `package.json` was found in.

use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use intely_core::jail::Jail;
use intely_core::EngineError;
use intely_runner::types::ServerStatus;
use intely_webtools::npmrun::{self, Sandbox};
use intely_webtools::tryit::{Allowed, TryRequest, TryResponse};
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
    runner: String,
    ports: Vec<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveServers {
    /// False when the platform cannot list listening sockets (no `lsof`): Try it has nothing it may send to.
    available: bool,
    servers: Vec<LiveServer>,
}

/// The dev servers of ONE repository that the Scripts panel started and that are alive, with the sockets their process trees listen
/// on right now. The ports come from `lsof` for the server's own process group, never from what the server printed (a script can
/// print any port), so a hostile `dev` script cannot make another service on this computer a target.
fn live_servers_for(mgr: &intely_runner::RunManager, repo_id: &str) -> (bool, Vec<(LiveServer, Vec<Allowed>)>) {
    let mut available = true;
    let mut out = Vec::new();
    for s in mgr.list().into_iter().filter(|s| s.repo_id == repo_id && matches!(s.status, ServerStatus::Starting | ServerStatus::Running)) {
        let Some(listeners) = mgr.listeners(&s.id) else {
            available = false;
            continue;
        };
        let mut allowed: Vec<Allowed> = Vec::new();
        for l in listeners {
            match allowed.iter_mut().find(|a| a.port == l.port) {
                Some(a) => {
                    a.v4 |= l.v4;
                    a.v6 |= l.v6;
                }
                None => allowed.push(Allowed { port: l.port, v4: l.v4, v6: l.v6 }),
            }
        }
        if !allowed.is_empty() {
            out.push((LiveServer { id: s.id, runner: s.runner, ports: allowed.iter().map(|a| a.port).collect() }, allowed));
        }
    }
    (available, out)
}

#[tauri::command]
pub async fn webtools_servers(run: State<'_, RunState>, repo_id: String) -> Res<LiveServers> {
    let mgr = run.0.clone();
    blocking(move || {
        let (available, servers) = live_servers_for(&mgr, &repo_id);
        Ok(LiveServers { available, servers: servers.into_iter().map(|(s, _)| s).collect() })
    })
    .await
}

/// One request to `127.0.0.1` / `::1` on a port that `lsof` shows listening for a dev server of this repository, right now. Any
/// other port is refused. (A port can change hands between this listing and the connect; the window is a few milliseconds and the
/// request is a single GET/POST the person asked for.)
#[tauri::command]
pub async fn webtools_try(run: State<'_, RunState>, repo_id: String, request: TryRequest) -> Res<TryResponse> {
    let mgr = run.0.clone();
    blocking(move || {
        let (_, servers) = live_servers_for(&mgr, &repo_id);
        let allowed: Vec<Allowed> = servers.into_iter().flat_map(|(_, a)| a).collect();
        intely_webtools::tryit::send(&request, &allowed).map_err(web)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepsReport {
    outdated: Option<Vec<OutdatedPkg>>,
    audit: Option<AuditReport>,
    /// Plain-language notes: a part that failed (offline, no lock file), never raw output.
    notes: Vec<String>,
}

fn first_line(s: &str) -> String {
    s.lines().find(|l| !l.trim().is_empty()).map(|l| l.trim().chars().take(160).collect()).unwrap_or_default()
}

/// Opt-in: `npm outdated --json` and `npm audit --json`. Both ask the npm registry, so the person confirms first (`confirmed`).
/// npm never runs in the repository (a project's own `.npmrc` could turn the app's environment into a token for a registry of its
/// own): see `intely_webtools::npmrun`. What it sends is the dependency names and versions of this one project, to the npm registry.
#[tauri::command]
pub async fn webtools_deps_check(engine: State<'_, EngineSlot>, run: State<'_, RunState>, repo_id: String, dir: String, confirmed: bool) -> Res<DepsReport> {
    if !confirmed {
        return Err(EngineError::new("confirmRequired", "Check dependencies asks the npm registry over the network and needs a confirmation"));
    }
    let root = repo_path(&engine, &repo_id).await?;
    let login: Option<String> = engine.get().ok().and_then(|e| intely_core::Engine::login_env(e).get("PATH").cloned());
    let allowed = run.0.allow_processes();
    let (root2, dir2) = (root.clone(), dir.clone());
    // only a folder in which a package.json was found, with an npm lock file
    let found = blocking(move || detect(&root2).map_err(web)).await?;
    let Some(pkg) = found.packages.iter().find(|p| p.dir == dir2) else { return Err(EngineError::new("notFound", "no package.json in that folder")) };
    if pkg.manager != "npm" {
        return Err(EngineError::new("unsupportedManager", format!("only npm projects are supported (this folder uses {})", pkg.manager)));
    }
    let cwd = if dir.is_empty() { root.clone() } else { root.join(&dir) };
    let jail = Jail::global();
    intely_runner::guard::check_process(&jail, allowed, &cwd)?;
    blocking(move || {
        let sandbox = Sandbox::prepare(&root, &dir).map_err(web)?;
        // the jail's own variables (git hardening) and the read-only git shim keep applying to whatever npm starts
        let jail_env: Vec<(String, String)> = jail.env().iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let path = intely_runner::guard::read_only_git_path(&jail, login.as_deref().map(std::ffi::OsStr::new))?;
        let mut report = DepsReport { outdated: None, audit: None, notes: Vec::new() };
        let out = npmrun::run(&sandbox, "outdated", npmrun::DEFAULT_REGISTRY, login.as_deref(), &jail_env, path.clone(), npmrun::RUN_LIMIT).map_err(web)?;
        if out.code == 124 {
            report.notes.push("timeout".into());
        } else {
            match parse_outdated(&out.stdout, &sandbox.locked) {
                Ok(list) => report.outdated = Some(list),
                Err(e) => report.notes.push(format!("outdated: {}", if e.code == "npm" { e.message } else { first_line(&intely_runner::mask::mask(&out.stderr)) })),
            }
        }
        let out = npmrun::run(&sandbox, "audit", npmrun::DEFAULT_REGISTRY, login.as_deref(), &jail_env, path, npmrun::RUN_LIMIT).map_err(web)?;
        if out.code == 124 {
            report.notes.push("timeout".into());
        } else {
            match parse_audit(&out.stdout) {
                Ok(a) => report.audit = Some(a),
                Err(e) => report.notes.push(format!("audit: {}", if e.code == "npm" { e.message } else { first_line(&intely_runner::mask::mask(&out.stderr)) })),
            }
        }
        Ok(report)
    })
    .await
}
