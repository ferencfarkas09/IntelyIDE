//! Tauri glue of the preview module (Beta-2 P2): the Rust side of the loopback gate for the embedded dev-server frame.
//!
//! The frame is an `<iframe>` in the webview (not a child webview: that needs the `unstable` feature, floats above the DOM
//! so palettes and toasts hide behind it, and would be a second webview with its own IPC surface). The frame's origin has no
//! capability, so it cannot call `invoke`; the CSP's `frame-src` is exactly `http://127.0.0.1:* http://localhost:*`.
//!
//! Five commands, all loopback only and none of them starting a dev server:
//! - `preview_check_url`: the authoritative URL gate (the UI runs the same rules first; `url-cases.json` keeps both in step);
//! - `preview_probe`: a TCP connect to `127.0.0.1` / `::1` to tell "nothing listens there" from a frame that failed;
//! - `preview_open_external`: opens the re-validated address in the system browser (refused in the E2E jail);
//! - `preview_proxy_start` / `preview_proxy_stop`: the click-to-source reverse proxy in front of one dev-server port.
//!
//! The gate matches the raw text against the two literal hosts, so alternative IP spellings, `*.localhost` and names that
//! merely resolve to loopback (DNS rebinding) never pass, and nothing is resolved here.

use std::collections::{hash_map::Entry, HashMap};
use std::path::PathBuf;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use intely_core::{BusyItem, BusyKind, EngineError, SwitchWarning};
use intely_preview_proxy::{Proxy, ProxyConfig};
use serde::Serialize;
use tauri::{Manager, State};

use super::switchhook::{self, BoxFuture, SwitchHook};

mod component;
mod gate;
pub use gate::{probe_port, validate, Gate, Refusal};

type Res<T> = Result<T, EngineError>;

/// The `frame-src` sources of `tauri.conf.json`. A test fails when the config differs.
#[cfg(test)]
pub const FRAME_SRC: [&str; 2] = ["http://127.0.0.1:*", "http://localhost:*"];
const PROBE_TIMEOUT: Duration = Duration::from_millis(400);

impl From<Refusal> for EngineError {
    fn from(r: Refusal) -> Self {
        EngineError::new(r.code(), r.message())
    }
}


#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTarget {
    /// Normalised: this exact string is what the frame loads.
    pub url: String,
    pub host: String,
    pub port: u16,
    pub origin: String,
}

impl From<Gate> for PreviewTarget {
    fn from(g: Gate) -> Self {
        PreviewTarget { url: g.url, host: g.host, port: g.port, origin: g.origin }
    }
}

#[tauri::command]
pub async fn preview_check_url(url: String) -> Res<PreviewTarget> {
    Ok(validate(&url)?.into())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub reachable: bool,
    pub port: u16,
    pub ms: u64,
}

#[tauri::command]
pub async fn preview_probe(url: String) -> Res<ProbeResult> {
    let target = validate(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let reachable = probe_port(&target.host, target.port, PROBE_TIMEOUT);
        ProbeResult { reachable, port: target.port, ms: started.elapsed().as_millis() as u64 }
    })
    .await
    .map_err(|_| EngineError::new("io", "the probe task failed"))
}

/// Opens the loopback address in the system browser. Automated runs (the E2E jail) never open windows.
#[tauri::command]
pub async fn preview_open_external(url: String) -> Res<()> {
    let target = validate(&url)?;
    if intely_core::jail::Jail::global().mode() == intely_core::jail::Mode::E2e {
        return Err(EngineError::new("testJail", "the E2E jail does not open a browser"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let status = std::process::Command::new("/usr/bin/open").arg(&target.url).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
        #[cfg(not(target_os = "macos"))]
        let status: std::io::Result<std::process::ExitStatus> = Err(std::io::Error::other("unsupported platform"));
        match status {
            Ok(s) if s.success() => Ok(()),
            _ => Err(EngineError::new("openFailed", "the browser could not be opened")),
        }
    })
    .await
    .map_err(|_| EngineError::new("io", "the browser task failed"))?
}

/// Click-to-source (`docs/preview-inspect.md`): one loopback reverse proxy per attached dev-server port, started on demand by the
/// preview frame and kept (idle: one listener, no timers) until the IDE quits. The proxy injects the inspector into HTML and
/// refuses everything that is not a loopback request for that one port.
#[derive(Default)]
pub struct PreviewState {
    proxies: Arc<Mutex<HashMap<u16, Proxy>>>,
    /// Component preview harness processes (`component.rs`).
    harnesses: Arc<component::HarnessSet>,
}

impl PreviewState {
    /// The `SwitchHook` of the proxies and component harnesses.
    pub fn hook(&self) -> Arc<dyn SwitchHook> {
        Arc::new(PreviewHook { proxies: self.proxies.clone(), harnesses: self.harnesses.clone() })
    }
}

/// `Some(hook)` once `setup` ran.
pub fn hook(app: &tauri::AppHandle) -> Option<Arc<dyn SwitchHook>> {
    app.try_state::<PreviewState>().map(|s| s.hook())
}

struct PreviewHook {
    proxies: Arc<Mutex<HashMap<u16, Proxy>>>,
    harnesses: Arc<component::HarnessSet>,
}

/// A harness that ignores the polite stop is killed after this (the switch step has 1 s).
const SWITCH_GRACE: Duration = Duration::from_millis(600);

impl SwitchHook for PreviewHook {
    fn name(&self) -> &'static str {
        "preview"
    }

    fn busy(&self) -> Vec<BusyItem> {
        let mut ports: Vec<u16> = self.proxies.lock().unwrap().keys().copied().collect();
        ports.extend(self.harnesses.ports());
        ports.sort_unstable();
        if ports.is_empty() {
            return Vec::new();
        }
        vec![BusyItem { kind: BusyKind::Preview, count: ports.len() as u32, labels: ports.iter().map(u16::to_string).collect() }]
    }

    fn stop(&self) -> BoxFuture<'_, Vec<SwitchWarning>> {
        let (proxies, harnesses) = (self.proxies.clone(), self.harnesses.clone());
        Box::pin(async move {
            let done = switchhook::blocking(move || {
                harnesses.stop_all_within(SWITCH_GRACE);
                let all: Vec<Proxy> = proxies.lock().unwrap().drain().map(|(_, p)| p).collect();
                all.into_iter().for_each(|p| p.stop());
            })
            .await;
            if done.is_some() {
                Vec::new()
            } else {
                vec![switchhook::stuck("preview")]
            }
        })
    }
}

/// A port that a process of the old workspace still holds is not offered to the preview (it would show the wrong app).
pub fn refuse_survivor_port(port: u16, survivor_ports: &[u16]) -> Res<()> {
    if survivor_ports.contains(&port) {
        return Err(EngineError::new("survivorPort", format!("port {port} still belongs to a process of the previous workspace")));
    }
    Ok(())
}

/// More attached ports than this is a runaway webview, not a user.
const MAX_PROXIES: usize = 8;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyInfo {
    /// `http://127.0.0.1:<proxy port>/`: the frame loads this origin plus the page path.
    pub url: String,
    pub port: u16,
    pub upstream_port: u16,
}

/// Starts (or reuses) the proxy in front of the dev server the loopback address names. In the E2E jail only a port a Run-panel
/// server listens on is accepted (fixture servers); elsewhere the user attached the address by hand, and the same gate as the
/// frame applies. Nothing here starts a server or reads the framed page.
#[tauri::command]
pub async fn preview_proxy_start(app: tauri::AppHandle, state: State<'_, PreviewState>, url: String) -> Res<ProxyInfo> {
    switchhook::gate_check(&app)?;
    let target = validate(&url)?;
    refuse_survivor_port(target.port, &super::runner::survivor_ports(&app))?;
    if intely_core::jail::Jail::global().mode() == intely_core::jail::Mode::E2e && !super::runner::live_ports(&app).contains(&target.port) && !state.harnesses.ports().contains(&target.port) {
        return Err(EngineError::new("testJail", "the E2E jail proxies only a port a Run-panel or component-preview server listens on"));
    }
    if let Some(p) = state.proxies.lock().unwrap().get(&target.port) {
        return Ok(ProxyInfo { url: p.url(), port: p.port(), upstream_port: target.port });
    }
    if state.proxies.lock().unwrap().len() >= MAX_PROXIES {
        return Err(EngineError::new("tooMany", "too many preview proxies are open"));
    }
    // IPv6-only dev servers (Node 18+ binds `localhost` to ::1): use ::1 only when 127.0.0.1 does not answer and ::1 does.
    let port = target.port;
    let v6 = tauri::async_runtime::spawn_blocking(move || !probe_port("127.0.0.1", port, PROBE_TIMEOUT) && std::net::TcpStream::connect_timeout(&SocketAddr::from((Ipv6Addr::LOCALHOST, port)), PROBE_TIMEOUT).is_ok())
        .await
        .map_err(|_| EngineError::new("io", "the probe task failed"))?;
    let ip: IpAddr = if v6 { Ipv6Addr::LOCALHOST.into() } else { Ipv4Addr::LOCALHOST.into() };
    let proxy = Proxy::start(ProxyConfig { upstream: SocketAddr::new(ip, target.port), allowed_ports: vec![target.port], inject: true })
        .await
        .map_err(|e| EngineError::new("proxy", e.to_string()))?;
    let info = ProxyInfo { url: proxy.url(), port: proxy.port(), upstream_port: target.port };
    // A concurrent start for the same port keeps the first one.
    match state.proxies.lock().unwrap().entry(target.port) {
        Entry::Occupied(o) => {
            proxy.stop();
            Ok(ProxyInfo { url: o.get().url(), port: o.get().port(), upstream_port: target.port })
        }
        Entry::Vacant(v) => {
            v.insert(proxy);
            Ok(info)
        }
    }
}

/// Stops the proxy in front of one upstream port (a no-op when there is none).
#[tauri::command]
pub async fn preview_proxy_stop(state: State<'_, PreviewState>, upstream_port: u16) -> Res<()> {
    if let Some(p) = state.proxies.lock().unwrap().remove(&upstream_port) {
        p.stop();
    }
    Ok(())
}

/// Component preview (Stage B): starts the IDE-owned harness for one exported component of a repo and returns its ready info
/// (`id`, `url` on 127.0.0.1, `uses`, `installed`, `engine`...). A process start: the run module's jail rule applies.
#[tauri::command]
pub async fn preview_component_start(
    app: tauri::AppHandle,
    slot: State<'_, crate::commands::EngineSlot>,
    run: State<'_, super::runner::RunState>,
    repo_id: String,
    file: String,
    export: String,
) -> Res<serde_json::Value> {
    switchhook::gate_check(&app)?;
    let ws = slot.get()?.workspace_get().await?;
    let root = ws.repos.iter().find(|r| r.id == repo_id).map(|r| PathBuf::from(&r.path)).ok_or_else(|| EngineError::new(intely_core::code::REPO_MISSING, format!("unknown repo {repo_id}")))?;
    let allowed = run.0.allow_processes();
    let env: HashMap<String, String> = slot.get().map(intely_core::Engine::login_env).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        intely_runner::guard::check_process(&intely_core::jail::Jail::global(), allowed, &root)?;
        let component = component::validate(&root, &file, &export)?;
        component::start(&app.state::<PreviewState>().harnesses, component, &env)
    })
    .await
    .map_err(|_| EngineError::new("io", "the preview task failed"))?
}

/// The view closed (or switched component): the harness stops after 45 s unless a view comes back for it.
#[tauri::command]
pub async fn preview_component_release(app: tauri::AppHandle, state: State<'_, PreviewState>, id: String) -> Res<()> {
    if let Some(stamp) = state.harnesses.release(&id) {
        std::thread::spawn(move || {
            std::thread::sleep(component::IDLE_STOP);
            app.state::<PreviewState>().harnesses.stop_if_idle(&id, stamp);
        });
    }
    Ok(())
}

/// The harness's own log tail (build timings and failures; nothing from the previewed page).
#[tauri::command]
pub async fn preview_component_log(state: State<'_, PreviewState>, id: String) -> Res<Vec<String>> {
    Ok(state.harnesses.log(&id))
}

/// App exit: no listener or harness outlives the IDE.
pub fn shutdown(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<PreviewState>() {
        state.harnesses.stop_all();
        let all: Vec<_> = state.proxies.lock().unwrap().drain().collect();
        for (_, p) in all {
            p.stop();
        }
    }
}

pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(PreviewState::default());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upstream() -> (std::net::TcpListener, u16) {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let p = l.local_addr().unwrap().port();
        (l, p)
    }

    #[test]
    fn stop_closes_proxies_and_harnesses_twice_is_harmless_and_the_module_is_reusable() {
        let state = PreviewState::default();
        let hook = state.hook();
        assert_eq!(hook.name(), "preview");
        assert!(hook.busy().is_empty());
        let (_l1, up1) = upstream();
        let (_l2, up2) = upstream();
        for up in [up1, up2] {
            let proxy = tauri::async_runtime::block_on(Proxy::start(ProxyConfig { upstream: SocketAddr::new(Ipv4Addr::LOCALHOST.into(), up), allowed_ports: vec![up], inject: true })).unwrap();
            state.proxies.lock().unwrap().insert(up, proxy);
        }
        // a harness that ignores its stdin closing: the shorter switch grace kills it
        let child = std::process::Command::new("sleep").arg("60").stdin(std::process::Stdio::null()).spawn().unwrap();
        let pid = child.id() as i32;
        state.harnesses.adopt("h1", child, 4999);
        let busy = hook.busy();
        assert_eq!((busy[0].kind.clone(), busy[0].count), (BusyKind::Preview, 3));
        assert!(busy[0].labels.contains(&up1.to_string()) && busy[0].labels.contains(&"4999".to_string()));

        let t = Instant::now();
        let warnings = tauri::async_runtime::block_on(hook.stop());
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(t.elapsed() < Duration::from_millis(1500), "{:?}", t.elapsed());
        assert!(hook.busy().is_empty() && state.proxies.lock().unwrap().is_empty());
        assert!(std::process::Command::new("/bin/kill").args(["-0", &pid.to_string()]).stderr(std::process::Stdio::null()).status().is_ok_and(|s| !s.success()), "the harness process is gone");
        assert!(tauri::async_runtime::block_on(hook.stop()).is_empty(), "stop twice");

        // reusable
        let proxy = tauri::async_runtime::block_on(Proxy::start(ProxyConfig { upstream: SocketAddr::new(Ipv4Addr::LOCALHOST.into(), up1), allowed_ports: vec![up1], inject: true })).unwrap();
        state.proxies.lock().unwrap().insert(up1, proxy);
        assert_eq!(hook.busy()[0].count, 1);
        assert!(tauri::async_runtime::block_on(hook.stop()).is_empty());
    }

    #[test]
    fn the_preview_refuses_a_port_a_survivor_holds() {
        assert!(refuse_survivor_port(5173, &[3000]).is_ok());
        assert_eq!(refuse_survivor_port(3000, &[3000, 4000]).unwrap_err().code, "survivorPort");
        assert!(refuse_survivor_port(3000, &[]).is_ok());
    }

    #[test]
    fn the_gate_refuses_a_preview_start_while_a_switch_is_under_way() {
        use super::super::switchhook::{testing::FakeClock, SwitchGate};
        let gate = SwitchGate::new(Arc::new(FakeClock::new()));
        gate.set().hold();
        assert_eq!(switchhook::check_optional(Some(&gate)).unwrap_err().code, intely_core::code::WORKSPACE_SWITCHING);
    }

    #[test]
    fn the_gate_agrees_with_the_ui_on_every_shared_case() {
        let file: serde_json::Value = serde_json::from_str(include_str!("../../../ui/src/modules/preview/url-cases.json")).unwrap();
        let cases = file["cases"].as_array().unwrap();
        assert!(cases.len() > 50);
        for c in cases {
            let input = c["input"].as_str().unwrap();
            let shown: String = input.chars().take(60).collect();
            match (c["ok"].as_bool().unwrap(), validate(input)) {
                (true, Ok(t)) => assert_eq!(t.url, c["url"].as_str().unwrap(), "{shown:?}"),
                (false, Err(r)) => assert_eq!(r.code(), c["reason"].as_str().unwrap(), "{shown:?}"),
                (true, Err(r)) => panic!("{shown:?} was refused: {}", r.code()),
                (false, Ok(t)) => panic!("{shown:?} was accepted as {}", t.url),
            }
        }
    }

    #[test]
    fn the_csp_carries_exactly_the_two_loopback_frame_sources() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        let frame: Vec<&str> = csp.split(';').map(str::trim).filter_map(|d| d.strip_prefix("frame-src")).flat_map(str::split_whitespace).collect();
        let mut want = FRAME_SRC.to_vec();
        want.sort();
        let mut got = frame.clone();
        got.sort();
        assert_eq!(got, want);
        assert_eq!(csp.matches("frame-src").count(), 1);
        assert!(csp.contains("script-src 'self';"));
        // Every source of every directive is on the allow-list; a new origin anywhere needs a deliberate edit here.
        let allowed = ["'self'", "'unsafe-inline'", "data:", "ipc:", "http://ipc.localhost", "http://127.0.0.1:*", "http://localhost:*"];
        for d in csp.split(';').map(str::trim).filter(|d| !d.is_empty()) {
            for src in d.split_whitespace().skip(1) {
                assert!(allowed.contains(&src), "unexpected CSP source {src:?} in {d:?}");
            }
        }
    }

    #[test]
    fn no_capability_grants_a_remote_origin() {
        let cap: serde_json::Value = serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        assert!(cap.get("remote").is_none());
        assert_eq!(cap["windows"], serde_json::json!(["main"]));
        let conf = include_str!("../../tauri.conf.json");
        assert!(!conf.contains("dangerousRemoteDomainIpcAccess"));
    }
}
