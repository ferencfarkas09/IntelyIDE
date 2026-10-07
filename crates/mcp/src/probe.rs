//! The Test client (MCP spec 4): `initialize` + `tools/list` against a stdio or a Streamable HTTP server, and nothing else. It calls no tool,
//! reads no resource, runs no prompt. Tauri-free and async; every string that leaves it passed the exact-value scrubber and `redact` first.

use std::collections::BTreeMap;
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use intely_core::jail::{Jail, Mode};
use intely_settings::Secret;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

use crate::error::{code, McpErr};
use crate::scrub::Scrubber;
use crate::types::McpTransport;

pub const PROTOCOL_VERSION: &str = "2025-06-18";
/// The oldest protocol revision a server may answer with.
const OLDEST_PROTOCOL: &str = "2024-11-05";
const MAX_LINE: usize = 1 << 20;
const MAX_STDOUT: usize = 4 << 20;
const MAX_BODY: usize = 4 << 20;
const MAX_PAGES: usize = 10;
pub const MAX_TOOLS_PER_SERVER: usize = 500;
const STDERR_RING: usize = 4 << 10;
const STDERR_REPORT: usize = 2 << 10;
const INSTRUCTIONS_CAP: usize = 4000;
const GRACE: Duration = Duration::from_millis(300);

/// A configured variable or header with its VALUE resolved (it exists only for the duration of the call; `Secret` never prints itself).
pub struct ProbeVar {
    pub name: String,
    pub value: Secret,
    pub secret: bool,
}

/// What `probe` needs: the record's connection with its secret values resolved. `command` is already resolved to an executable path.
pub struct ProbeServer {
    pub name: String,
    pub transport: McpTransport,
    pub command: Option<PathBuf>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub env: Vec<ProbeVar>,
    pub headers: Vec<ProbeVar>,
}

pub struct ProbeOptions {
    /// The whole Test, spawn to the last page (default 10 s).
    pub timeout: Duration,
    /// The already scrubbed base environment of the child (`scrub_env(login env)`): nothing else of the IDE process reaches it.
    pub env: BTreeMap<String, String>,
    pub client_version: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProbedTool {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub read_only_hint: Option<bool>,
    pub destructive_hint: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProbeOk {
    pub protocol_version: String,
    pub server_name: String,
    pub server_version: String,
    /// `tools`, `resources`, `prompts`.
    pub capabilities: (bool, bool, bool),
    pub tools: Vec<ProbedTool>,
    pub truncated: bool,
    /// `initialize.instructions`, sanitised and cut, or `None`.
    pub instructions: Option<String>,
    /// sha256 of the RAW instructions text, or `None`.
    pub instructions_hash: Option<String>,
}

pub struct ProbeResult {
    pub ms: u64,
    /// The last 2 KiB of the server's stderr, scrubbed and redacted (stdio only; may be empty).
    pub stderr_tail: String,
    pub outcome: Result<ProbeOk, McpErr>,
}

// ---- text hygiene -------------------------------------------------------------------------------------------------------------

/// One line, control, direction and zero-width characters stripped, cut at `max` characters.
pub fn sanitize_line(text: &str, max: usize) -> String {
    let cleaned: String = text.chars().map(|c| if c.is_whitespace() { ' ' } else { c }).filter(|c| !crate::model::forbidden_char(*c)).collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    cut(&collapsed, max)
}

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_owned()
    } else {
        let mut s: String = text.chars().take(max.saturating_sub(1)).collect();
        s.push('\u{2026}');
        s
    }
}

/// Multi-line text (the server's instructions): line breaks stay, every other control, direction or zero-width character goes; cut at 4000
/// characters with a visible mark.
pub fn sanitize_block(text: &str, max: usize) -> String {
    let cleaned: String = text.replace("\r\n", "\n").chars().map(|c| if c == '\t' { ' ' } else { c }).filter(|c| *c == '\n' || !crate::model::forbidden_char(*c)).collect();
    if cleaned.chars().count() <= max {
        cleaned
    } else {
        let mut s: String = cleaned.chars().take(max).collect();
        s.push_str("\n[...cut]");
        s
    }
}

fn tail_of(ring: &Mutex<Vec<u8>>, scrub: &Scrubber) -> String {
    let bytes = ring.lock().unwrap_or_else(PoisonError::into_inner).clone();
    let start = bytes.len().saturating_sub(STDERR_REPORT);
    let text = String::from_utf8_lossy(&bytes[start..]).into_owned();
    // the cut may have split a character or a line: drop the partial first line when we cut
    let text = if start > 0 { text.split_once('\n').map_or(text.clone(), |(_, rest)| rest.to_owned()) } else { text };
    sanitize_block(&scrub.clean(&text), STDERR_REPORT)
}

// ---- JSON-RPC pieces ----------------------------------------------------------------------------------------------------------

fn initialize_params(version: &str) -> Value {
    json!({ "protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": { "name": "IntelySwitchIDE", "version": version } })
}

struct Init {
    protocol_version: String,
    server_name: String,
    server_version: String,
    capabilities: (bool, bool, bool),
    instructions: Option<String>,
}

fn parse_init(result: &Value, scrub: &Scrubber) -> Result<Init, McpErr> {
    let version = result.get("protocolVersion").and_then(Value::as_str).unwrap_or_default();
    let date_shaped = version.len() == 10 && version.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() });
    if !date_shaped || version < OLDEST_PROTOCOL {
        return Err(McpErr::new(code::PROTOCOL, "the server answered with a protocol version this IDE does not speak"));
    }
    let info = result.get("serverInfo");
    let text = |key: &str| info.and_then(|i| i.get(key)).and_then(Value::as_str).map(|s| sanitize_line(&scrub.clean(s), 120)).unwrap_or_default();
    let caps = result.get("capabilities");
    let has = |k: &str| caps.and_then(|c| c.get(k)).is_some_and(|v| !v.is_null());
    Ok(Init {
        protocol_version: version.to_owned(),
        server_name: text("name"),
        server_version: text("version"),
        capabilities: (has("tools"), has("resources"), has("prompts")),
        instructions: result.get("instructions").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned),
    })
}

/// One `tools/list` page: the tools it carries and the next cursor.
fn parse_tools_page(result: &Value, scrub: &Scrubber) -> (Vec<ProbedTool>, Option<String>) {
    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    let name = t.get("name").and_then(Value::as_str).filter(|n| !n.is_empty())?;
                    let text = |key: &str, max: usize| t.get(key).and_then(Value::as_str).map(|s| sanitize_line(&scrub.clean(s), max)).filter(|s| !s.is_empty());
                    let ann = t.get("annotations");
                    let flag = |key: &str| ann.and_then(|a| a.get(key)).and_then(Value::as_bool);
                    Some(ProbedTool {
                        name: sanitize_line(&scrub.clean(name), 256),
                        title: text("title", 120),
                        description: text("description", 240),
                        read_only_hint: flag("readOnlyHint"),
                        destructive_hint: flag("destructiveHint"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let next = result.get("nextCursor").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_owned);
    (tools, next)
}

fn finish_ok(init: Init, tools: Vec<ProbedTool>, truncated: bool, scrub: &Scrubber) -> ProbeOk {
    let instructions_hash = init.instructions.as_deref().map(|t| intely_settings::hash::sha256_hex(t.as_bytes()));
    ProbeOk {
        protocol_version: init.protocol_version,
        server_name: init.server_name,
        server_version: init.server_version,
        capabilities: init.capabilities,
        tools,
        truncated,
        instructions: init.instructions.map(|t| sanitize_block(&scrub.clean(&t), INSTRUCTIONS_CAP)),
        instructions_hash,
    }
}

/// An error answer of the server: the code only. The message is the server's text and may echo what it was given.
fn rpc_error(msg: &Value) -> McpErr {
    let c = msg.get("error").and_then(|e| e.get("code")).and_then(Value::as_i64).unwrap_or(0);
    McpErr::new(code::PROTOCOL, format!("the server answered with an error (code {c})"))
}

// ---- the Test ----------------------------------------------------------------------------------------------------------------------

fn is_loopback_host(host: &str) -> bool {
    matches!(host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase().as_str(), "127.0.0.1" | "::1" | "localhost")
}

/// Checks the jail (4.1) before any process or socket, then runs the Test. Never panics; the child is gone when it returns.
pub async fn probe(server: &ProbeServer, opts: ProbeOptions, jail: &Jail) -> ProbeResult {
    let started = Instant::now();
    let scrub = Scrubber::new(server.env.iter().chain(server.headers.iter()).filter(|v| v.secret).map(|v| v.value.expose()));
    let done = |stderr_tail: String, outcome: Result<ProbeOk, McpErr>| ProbeResult { ms: started.elapsed().as_millis() as u64, stderr_tail, outcome };
    if jail.mode() == Mode::ReadOnly {
        return done(String::new(), Err(McpErr::new(code::READ_ONLY, "the read-only mode refuses to start MCP servers")));
    }
    match server.transport {
        McpTransport::Stdio => {
            let (outcome, tail) = probe_stdio(server, &opts, &scrub).await;
            done(tail, outcome)
        }
        McpTransport::Http => {
            let outcome = match probe_http_guarded(server, &opts, &scrub, jail).await {
                Ok(ok) => Ok(ok),
                Err(e) => Err(McpErr { code: e.code, message: scrub.clean(&e.message), detail: e.detail.map(|d| scrub.clean(&d)) }),
            };
            done(String::new(), outcome)
        }
    }
}

// ---- stdio ---------------------------------------------------------------------------------------------------------------------------

enum Incoming {
    Msg(Value),
    Closed,
    Protocol(String),
}

async fn read_stdout(mut out: ChildStdout, tx: mpsc::UnboundedSender<Incoming>) {
    let mut buf: Vec<u8> = Vec::new();
    let mut total = 0usize;
    let mut chunk = [0u8; 8192];
    loop {
        let n = match out.read(&mut chunk).await {
            Ok(0) | Err(_) => {
                let _ = tx.send(Incoming::Closed);
                return;
            }
            Ok(n) => n,
        };
        total += n;
        if total > MAX_STDOUT {
            let _ = tx.send(Incoming::Protocol("the server wrote more than 4 MiB to stdout".into()));
            return;
        }
        buf.extend_from_slice(&chunk[..n]);
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = &line[..line.len() - 1];
            if line.len() > MAX_LINE {
                let _ = tx.send(Incoming::Protocol("the server wrote a line longer than 1 MiB to stdout".into()));
                return;
            }
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            match serde_json::from_slice::<Value>(line) {
                Ok(v) if v.is_object() => {
                    let _ = tx.send(Incoming::Msg(v));
                }
                _ => {
                    let _ = tx.send(Incoming::Protocol("the server wrote something that is not JSON-RPC to stdout (a banner or log line belongs on stderr)".into()));
                    return;
                }
            }
        }
        if buf.len() > MAX_LINE {
            let _ = tx.send(Incoming::Protocol("the server wrote a line longer than 1 MiB to stdout".into()));
            return;
        }
    }
}

async fn read_stderr(mut err: ChildStderr, ring: Arc<Mutex<Vec<u8>>>) {
    let mut chunk = [0u8; 4096];
    while let Ok(n) = err.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        let mut r = ring.lock().unwrap_or_else(PoisonError::into_inner);
        r.extend_from_slice(&chunk[..n]);
        if r.len() > STDERR_RING {
            let cut = r.len() - STDERR_RING;
            r.drain(..cut);
        }
    }
}

struct Rpc {
    stdin: Option<ChildStdin>,
    rx: mpsc::UnboundedReceiver<Incoming>,
    next: u64,
}

impl Rpc {
    async fn send(&mut self, msg: &Value) -> Result<(), McpErr> {
        let mut line = serde_json::to_vec(msg).map_err(|e| McpErr::new(code::PROTOCOL, e.to_string()))?;
        line.push(b'\n');
        let stdin = self.stdin.as_mut().ok_or_else(|| McpErr::new(code::EXITED, "the server closed its input"))?;
        stdin.write_all(&line).await.map_err(|_| McpErr::new(code::EXITED, "the server exited before the handshake finished"))?;
        stdin.flush().await.map_err(|_| McpErr::new(code::EXITED, "the server exited before the handshake finished"))
    }

    async fn notify(&mut self, method: &str) -> Result<(), McpErr> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method })).await
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, McpErr> {
        self.next += 1;
        let id = self.next;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
        loop {
            match self.rx.recv().await {
                None | Some(Incoming::Closed) => return Err(McpErr::new(code::EXITED, "the server exited before the handshake finished")),
                Some(Incoming::Protocol(m)) => return Err(McpErr::new(code::PROTOCOL, m)),
                Some(Incoming::Msg(msg)) => {
                    let method_of = msg.get("method").and_then(Value::as_str);
                    match (method_of, msg.get("id")) {
                        // a request FROM the server: answer ping, refuse everything else (roots, sampling, elicitation)
                        (Some(m), Some(sid)) => {
                            let answer = if m == "ping" {
                                json!({ "jsonrpc": "2.0", "id": sid, "result": {} })
                            } else {
                                json!({ "jsonrpc": "2.0", "id": sid, "error": { "code": -32601, "message": "not supported by this client" } })
                            };
                            self.send(&answer).await?;
                        }
                        (Some(_), None) => {}
                        (None, Some(rid)) if *rid == json!(id) => {
                            if msg.get("error").is_some() {
                                return Err(rpc_error(&msg));
                            }
                            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

async fn handshake_stdio(rpc: &mut Rpc, opts: &ProbeOptions, scrub: &Scrubber) -> Result<ProbeOk, McpErr> {
    let init = parse_init(&rpc.request("initialize", initialize_params(&opts.client_version)).await?, scrub)?;
    rpc.notify("notifications/initialized").await?;
    let (mut tools, mut truncated) = (Vec::new(), false);
    let mut cursor: Option<String> = None;
    for page in 0..MAX_PAGES {
        let params = cursor.as_ref().map_or(json!({}), |c| json!({ "cursor": c }));
        let (batch, next) = parse_tools_page(&rpc.request("tools/list", params).await?, scrub);
        tools.extend(batch);
        if tools.len() > MAX_TOOLS_PER_SERVER {
            tools.truncate(MAX_TOOLS_PER_SERVER);
            truncated = true;
            break;
        }
        match next {
            None => break,
            Some(_) if page + 1 == MAX_PAGES => {
                truncated = true;
                break;
            }
            Some(c) => cursor = Some(c),
        }
    }
    Ok(finish_ok(init, tools, truncated, scrub))
}

fn kill_group(pid: Option<u32>, signal: i32) {
    if let Some(pid) = pid.filter(|p| *p > 1) {
        // SAFETY: killpg only signals the process group we created with `process_group(0)`.
        unsafe {
            libc::killpg(pid as i32, signal);
        }
    }
}

async fn probe_stdio(server: &ProbeServer, opts: &ProbeOptions, scrub: &Scrubber) -> (Result<ProbeOk, McpErr>, String) {
    let Some(command) = server.command.as_ref() else {
        return (Err(McpErr::new(code::SPAWN_FAILED, "command not found on the login PATH")), String::new());
    };
    let dir = std::env::temp_dir().join(format!("intely-mcp-test-{}", uuid::Uuid::new_v4().simple()));
    if let Err(e) = std::fs::DirBuilder::new().mode(0o700).create(&dir) {
        return (Err(McpErr::new(code::IO, format!("cannot create a working directory for the test: {}", e.kind()))), String::new());
    }
    let mut cmd = Command::new(command);
    cmd.args(&server.args).env_clear().envs(&opts.env).current_dir(&dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).process_group(0);
    for v in &server.env {
        cmd.env(&v.name, v.value.expose());
    }
    let mut child: Child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            let why = match e.kind() {
                std::io::ErrorKind::NotFound => "command not found on the login PATH",
                std::io::ErrorKind::PermissionDenied => "the command is not executable",
                _ => "the command could not be started",
            };
            return (Err(McpErr::new(code::SPAWN_FAILED, why)), String::new());
        }
    };
    let pid = child.id();
    let (tx, rx) = mpsc::unbounded_channel();
    let ring = Arc::new(Mutex::new(Vec::new()));
    let readers = [
        child.stdout.take().map(|o| tokio::spawn(read_stdout(o, tx.clone()))),
        child.stderr.take().map(|e| tokio::spawn(read_stderr(e, Arc::clone(&ring)))),
    ];
    drop(tx);
    let mut rpc = Rpc { stdin: child.stdin.take(), rx, next: 0 };
    let result = tokio::time::timeout(opts.timeout, handshake_stdio(&mut rpc, opts, scrub)).await;
    // teardown: close stdin, ask the group to stop, 300 ms later make sure, reap, remove the directory
    drop(rpc.stdin.take());
    kill_group(pid, libc::SIGTERM);
    let status = tokio::time::timeout(GRACE, child.wait()).await.ok().and_then(Result::ok);
    kill_group(pid, libc::SIGKILL);
    let status = match status {
        Some(s) => Some(s),
        None => tokio::time::timeout(Duration::from_secs(2), child.wait()).await.ok().and_then(Result::ok),
    };
    for r in readers.into_iter().flatten() {
        let _ = tokio::time::timeout(Duration::from_millis(500), r).await;
    }
    let _ = std::fs::remove_dir_all(&dir);
    let tail = tail_of(&ring, scrub);
    let outcome = match result {
        Err(_) => Err(McpErr::new(code::TIMEOUT, format!("the server did not finish the handshake within {} seconds", opts.timeout.as_secs().max(1)))),
        Ok(Err(e)) if e.code == code::EXITED => {
            let exit = status.and_then(|s| s.code()).map_or("no exit code".to_owned(), |c| format!("exit code {c}"));
            Err(McpErr { detail: Some(if tail.is_empty() { exit } else { format!("{exit}\n{tail}") }), ..e })
        }
        Ok(r) => r,
    };
    (outcome, tail)
}

// ---- http ----------------------------------------------------------------------------------------------------------------------------

async fn probe_http_guarded(server: &ProbeServer, opts: &ProbeOptions, scrub: &Scrubber, jail: &Jail) -> Result<ProbeOk, McpErr> {
    let raw = server.url.as_deref().ok_or_else(|| McpErr::new(code::BAD_CONFIG, "the server has no address"))?;
    let url = url::Url::parse(raw).map_err(|_| McpErr::new(code::BAD_CONFIG, "the address is not valid"))?;
    let host = url.host_str().unwrap_or_default().to_owned();
    if jail.mode() == Mode::E2e {
        let port = url.port_or_known_default().unwrap_or(443);
        let loopback = is_loopback_host(&host)
            && match tokio::net::lookup_host((host.trim_start_matches('[').trim_end_matches(']'), port)).await {
                Ok(addrs) => {
                    let all: Vec<_> = addrs.collect();
                    !all.is_empty() && all.iter().all(|a| a.ip().is_loopback())
                }
                Err(_) => false,
            };
        if !loopback {
            return Err(McpErr::new(code::TEST_JAIL, "the test jail only talks to loopback addresses"));
        }
    }
    match tokio::time::timeout(opts.timeout, probe_http(server, opts, scrub, &url, is_loopback_host(&host))).await {
        Ok(r) => r,
        Err(_) => Err(McpErr::new(code::TIMEOUT, format!("the server did not answer within {} seconds", opts.timeout.as_secs().max(1)))),
    }
}

fn http_error(e: &reqwest::Error) -> McpErr {
    if e.is_timeout() {
        return McpErr::new(code::TIMEOUT, "the server did not answer in time");
    }
    let dbg = format!("{e:?}").to_ascii_lowercase();
    if dbg.contains("certificate") || dbg.contains("tls") || dbg.contains("ssl") {
        return McpErr::new(code::TLS, "the TLS handshake with the server failed (certificate or protocol)");
    }
    if e.is_connect() {
        return McpErr::new(code::CONNECT, "could not connect to the server");
    }
    McpErr::new(code::CONNECT, "the request to the server failed")
}

struct HttpCtx<'a> {
    client: reqwest::Client,
    url: &'a url::Url,
    headers: Vec<(reqwest::header::HeaderName, reqwest::header::HeaderValue)>,
    session: Option<String>,
    protocol: Option<String>,
}

impl HttpCtx<'_> {
    fn request(&self, method: reqwest::Method) -> reqwest::RequestBuilder {
        let mut req = self.client.request(method, self.url.clone()).header("Accept", "application/json, text/event-stream");
        for (n, v) in &self.headers {
            req = req.header(n.clone(), v.clone());
        }
        if let Some(s) = &self.session {
            req = req.header("Mcp-Session-Id", s.as_str());
        }
        if let Some(p) = &self.protocol {
            req = req.header("MCP-Protocol-Version", p.as_str());
        }
        req
    }

    /// POSTs `body`. `want` = the request id to wait for (`None` for a notification: 2xx is enough). Returns the JSON-RPC message.
    async fn post(&mut self, body: &Value, want: Option<u64>) -> Result<Option<Value>, McpErr> {
        let text = serde_json::to_string(body).map_err(|e| McpErr::new(code::PROTOCOL, e.to_string()))?;
        let mut resp = self.request(reqwest::Method::POST).header("Content-Type", "application/json").body(text).send().await.map_err(|e| http_error(&e))?;
        let status = resp.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            let oauth = resp.headers().contains_key("www-authenticate");
            let err = McpErr::new(code::AUTH, "the server refused the credentials");
            return Err(if oauth { err.with_detail("oauth") } else { err });
        }
        if !status.is_success() {
            return Err(McpErr::new(code::HTTP_STATUS, "the server answered with an HTTP error").with_detail(status.as_u16().to_string()));
        }
        if let Some(s) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            self.session = Some(s.to_owned());
        }
        let Some(id) = want else { return Ok(None) };
        let is_sse = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|c| c.to_ascii_lowercase().contains("text/event-stream"));
        let mut body: Vec<u8> = Vec::new();
        if !is_sse {
            while let Some(chunk) = resp.chunk().await.map_err(|e| http_error(&e))? {
                body.extend_from_slice(&chunk);
                if body.len() > MAX_BODY {
                    return Err(McpErr::new(code::PROTOCOL, "the response is larger than 4 MiB"));
                }
            }
            let msg: Value = serde_json::from_slice(&body).map_err(|_| McpErr::new(code::PROTOCOL, "the response is not JSON"))?;
            return Ok(Some(msg));
        }
        let mut seen = 0usize;
        loop {
            // events are separated by a blank line; the first `data:` payload with our id is the answer
            let text = String::from_utf8_lossy(&body).replace("\r\n", "\n");
            let mut consumed = 0usize;
            for event in text.split("\n\n").take(text.matches("\n\n").count()) {
                consumed += event.len() + 2;
                let data: String = event.lines().filter_map(|l| l.strip_prefix("data:")).map(str::trim_start).collect::<Vec<_>>().join("\n");
                if let Ok(v) = serde_json::from_str::<Value>(&data) {
                    if v.get("id") == Some(&json!(id)) {
                        return Ok(Some(v));
                    }
                }
            }
            let _ = consumed;
            let Some(chunk) = resp.chunk().await.map_err(|e| http_error(&e))? else {
                // the stream ended: the last event may lack its blank line
                let tail = String::from_utf8_lossy(&body).replace("\r\n", "\n");
                let data: String = tail.rsplit("\n\n").next().unwrap_or_default().lines().filter_map(|l| l.strip_prefix("data:")).map(str::trim_start).collect::<Vec<_>>().join("\n");
                return match serde_json::from_str::<Value>(&data) {
                    Ok(v) if v.get("id") == Some(&json!(id)) => Ok(Some(v)),
                    _ => Err(McpErr::new(code::PROTOCOL, "the event stream ended without an answer")),
                };
            };
            seen += chunk.len();
            body.extend_from_slice(&chunk);
            if seen > MAX_BODY {
                return Err(McpErr::new(code::PROTOCOL, "the event stream is larger than 4 MiB"));
            }
        }
    }

    async fn call(&mut self, id: u64, method: &str, params: Value) -> Result<Value, McpErr> {
        let msg = self.post(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }), Some(id)).await?.unwrap_or(Value::Null);
        if msg.get("error").is_some() {
            return Err(rpc_error(&msg));
        }
        msg.get("result").cloned().ok_or_else(|| McpErr::new(code::PROTOCOL, "the answer has no result"))
    }
}

async fn probe_http(server: &ProbeServer, opts: &ProbeOptions, scrub: &Scrubber, url: &url::Url, loopback: bool) -> Result<ProbeOk, McpErr> {
    let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(opts.timeout).user_agent(format!("IntelySwitchIDE/{} (mcp-test)", opts.client_version));
    if loopback {
        builder = builder.no_proxy();
    }
    let client = builder.build().map_err(|_| McpErr::new(code::CONNECT, "the HTTP client could not be created"))?;
    let mut headers = Vec::new();
    for v in &server.headers {
        let name = reqwest::header::HeaderName::from_bytes(v.name.as_bytes()).map_err(|_| McpErr::new(code::BAD_CONFIG, "a header name is not valid"))?;
        let mut value = reqwest::header::HeaderValue::from_str(v.value.expose()).map_err(|_| McpErr::new(code::BAD_CONFIG, "a header value is not valid"))?;
        value.set_sensitive(true);
        headers.push((name, value));
    }
    let mut ctx = HttpCtx { client, url, headers, session: None, protocol: None };
    let init_result = ctx.call(1, "initialize", initialize_params(&opts.client_version)).await?;
    let init = parse_init(&init_result, scrub)?;
    ctx.protocol = Some(init.protocol_version.clone());
    ctx.post(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), None).await?;
    let (mut tools, mut truncated) = (Vec::new(), false);
    let mut cursor: Option<String> = None;
    let mut id = 1u64;
    for page in 0..MAX_PAGES {
        id += 1;
        let params = cursor.as_ref().map_or(json!({}), |c| json!({ "cursor": c }));
        let (batch, next) = parse_tools_page(&ctx.call(id, "tools/list", params).await?, scrub);
        tools.extend(batch);
        if tools.len() > MAX_TOOLS_PER_SERVER {
            tools.truncate(MAX_TOOLS_PER_SERVER);
            truncated = true;
            break;
        }
        match next {
            None => break,
            Some(_) if page + 1 == MAX_PAGES => {
                truncated = true;
                break;
            }
            Some(c) => cursor = Some(c),
        }
    }
    // best effort: end the session; the outcome does not matter
    if ctx.session.is_some() {
        let _ = tokio::time::timeout(Duration::from_secs(2), ctx.request(reqwest::Method::DELETE).send()).await;
    }
    Ok(finish_ok(init, tools, truncated, scrub))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizing_strips_controls_and_cuts() {
        assert_eq!(sanitize_line("a\u{1b}[31m b\u{202e}c\n\td", 100), "a[31m bc d");
        assert_eq!(sanitize_line(&"x".repeat(300), 240).chars().count(), 240);
        assert!(sanitize_line(&"x".repeat(300), 240).ends_with('\u{2026}'));
        assert_eq!(sanitize_block("a\r\nb\u{1b}\u{202e}\tc", 100), "a\nb c");
        let long = sanitize_block(&"y".repeat(5000), INSTRUCTIONS_CAP);
        assert!(long.ends_with("[...cut]") && long.len() < 4100);
    }

    #[test]
    fn a_tools_page_reads_annotations_and_skips_nameless_entries() {
        let page = json!({ "tools": [
            { "name": "a", "description": "d\nx", "annotations": { "readOnlyHint": true } },
            { "name": "b", "annotations": { "readOnlyHint": false, "destructiveHint": true } },
            { "description": "no name" }, { "name": "" }, { "name": "c" }
        ], "nextCursor": "n1" });
        let (tools, next) = parse_tools_page(&page, &Scrubber::default());
        assert_eq!(tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
        assert_eq!(tools[0].read_only_hint, Some(true));
        assert_eq!(tools[0].description.as_deref(), Some("d x"));
        assert_eq!(tools[1].destructive_hint, Some(true));
        assert_eq!(tools[2].read_only_hint, None);
        assert_eq!(next.as_deref(), Some("n1"));
    }

    #[test]
    fn the_protocol_version_must_be_a_date_not_older_than_the_oldest() {
        let s = Scrubber::default();
        for ok in ["2025-06-18", "2024-11-05", "2026-01-01"] {
            assert!(parse_init(&json!({ "protocolVersion": ok }), &s).is_ok(), "{ok}");
        }
        for bad in ["2024-10-07", "1.0", "", "2025/06/18"] {
            assert_eq!(parse_init(&json!({ "protocolVersion": bad }), &s).err().unwrap().code, code::PROTOCOL, "{bad}");
        }
        assert!(parse_init(&json!({}), &s).is_err());
    }

    #[test]
    fn loopback_hosts() {
        for h in ["127.0.0.1", "localhost", "[::1]", "::1", "LOCALHOST"] {
            assert!(is_loopback_host(h), "{h}");
        }
        assert!(!is_loopback_host("example.com") && !is_loopback_host("10.0.0.1"));
    }
}
