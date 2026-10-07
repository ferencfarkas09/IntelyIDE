//! The only door to Happy: a Rust-side HTTP client with a host allow-list (https, or loopback http), no redirects, a
//! per-provider `(method, path)` allow-list, response caps, and redaction on every error path.
//!
//! TLS is `native-tls` (Security.framework on macOS): it links the system stack instead of shipping rustls and ring, which
//! keeps the binary smaller ((design notes: integrations-plan) 0), and `tauri-plugin-http` is avoided on purpose because it hands
//! the webview a `fetch`.

use std::fmt;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use intely_core::jail::{Jail, Mode};
use intely_settings::Secret;
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, DATE};
use reqwest::redirect::Policy;
use reqwest::Url;
use serde_json::Value;
use tokio::sync::Semaphore;

use crate::redact::{redact, redact_with};
use crate::time::{now_ms, parse_http_date};
use crate::types::Env;

/// Environment variables that carry the base URL of the preset environments (no host is built into the app).
pub const PRODUCTION_URL_VAR: &str = "INTELY_HAPPY_PRODUCTION_URL";
pub const SANDBOX_URL_VAR: &str = "INTELY_HAPPY_SANDBOX_URL";

/// Where the preset environments live: the process environment first, then `happy.baseUrls.{production,sandbox}` in
/// settings.json. An empty slot means "not configured" and surfaces as `invalidBaseUrl`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Presets {
    pub production: Option<String>,
    pub sandbox: Option<String>,
}

impl Presets {
    /// Pure core of [`Presets::load`]: `var` looks up an environment variable, `stored` is the `happy` settings namespace.
    pub fn from_sources(var: impl Fn(&str) -> Option<String>, stored: &serde_json::Map<String, Value>) -> Self {
        let clean = |s: Option<String>| s.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
        let file = |key: &str| clean(stored.get("baseUrls").and_then(|b| b.get(key)).and_then(Value::as_str).map(str::to_owned));
        Self { production: clean(var(PRODUCTION_URL_VAR)).or_else(|| file("production")), sandbox: clean(var(SANDBOX_URL_VAR)).or_else(|| file("sandbox")) }
    }

    pub fn load(stored: &serde_json::Map<String, Value>) -> Self {
        Self::from_sources(|k| std::env::var(k).ok(), stored)
    }
}

const MAX_BODY: usize = 2 * 1024 * 1024;
const MAX_IN_FLIGHT: usize = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Patch,
    Delete,
}

#[derive(Debug, Clone, Copy)]
pub struct Rule {
    pub method: Method,
    /// `{id}` matches one path segment of letters, digits, `-` and `_`.
    pub pattern: &'static str,
    pub mutating: bool,
}

const fn get(pattern: &'static str) -> Rule {
    Rule { method: Method::Get, pattern, mutating: false }
}

const fn post(pattern: &'static str) -> Rule {
    Rule { method: Method::Post, pattern, mutating: true }
}

/// A POST that only records what the user has seen (read markers): not a send, so `allow_actions` does not gate it.
const fn post_read(pattern: &'static str) -> Rule {
    Rule { method: Method::Post, pattern, mutating: false }
}

const fn patch(pattern: &'static str) -> Rule {
    Rule { method: Method::Patch, pattern, mutating: true }
}

const fn delete(pattern: &'static str) -> Rule {
    Rule { method: Method::Delete, pattern, mutating: true }
}

/// Which provider a request is made for; each has its own allow-list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Scope {
    Connection,
    Timer,
    Meet,
    Chat,
    Notifications,
    Tasks,
}

const CONNECTION_RULES: &[Rule] = &[get("/api/user/me")];
const TIMER_RULES: &[Rule] = &[
    get("/api/projects/me/running-timer"),
    get("/api/widgets/summary"),
    get("/api/projects/time-entries"),
    get("/api/projects/time-entries/summary"),
    // The picker's server search and new task: projects by name, tasks by title, a project's own tasks and its title.
    get("/api/projects"),
    get("/api/projects/{id}"),
    get("/api/tasks"),
    get("/api/tasks/autocomplete"),
    post("/api/tasks"),
    post("/api/widgets/timer/start"),
    post("/api/widgets/timer/stop"),
    post("/api/widgets/timer/pause"),
    post("/api/widgets/timer/resume"),
];
const MEET_RULES: &[Rule] = &[get("/api/chat/meetings"), post("/api/chat/meetings/{id}/join")];
/// Team chat: the real backend's routes (`teamChat.controller.js`). Meetings stay in `MEET_RULES`.
const CHAT_RULES: &[Rule] = &[
    get("/api/chat/bootstrap"),
    get("/api/chat/channels"),
    post("/api/chat/channels"),
    post("/api/chat/direct"),
    get("/api/chat/directory"),
    get("/api/chat/search"),
    get("/api/chat/threads"),
    get("/api/chat/messages/{id}/thread"),
    get("/api/chat/channels/{id}/messages"),
    post("/api/chat/channels/{id}/messages"),
    post_read("/api/chat/channels/{id}/read"),
    patch("/api/chat/channels/{id}"),
    patch("/api/chat/channels/{id}/preferences"),
    post("/api/chat/channels/{id}/join"),
    post("/api/chat/channels/{id}/leave"),
    get("/api/chat/channels/{id}/members"),
    post("/api/chat/channels/{id}/members"),
    delete("/api/chat/channels/{id}/members/{id}"),
    patch("/api/chat/messages/{id}"),
    delete("/api/chat/messages/{id}"),
    post("/api/chat/messages/{id}/reactions"),
    post("/api/chat/messages/{id}/pin"),
];

/// Notifications inbox (plan E3): the real verbs are PATCH (read, unread, read-all) and DELETE.
const NOTIFICATION_RULES: &[Rule] = &[
    get("/api/notifications/badge"),
    get("/api/notifications"),
    patch("/api/notifications/read-all"),
    patch("/api/notifications/{id}/read"),
    patch("/api/notifications/{id}/unread"),
    delete("/api/notifications/{id}"),
];
/// My tasks (plan E4), read-only: moving a task between statuses is not wired.
const TASK_RULES: &[Rule] = &[get("/api/tasks"), get("/api/tasks/statuses")];

impl Scope {
    pub fn rules(self) -> &'static [Rule] {
        match self {
            Scope::Connection => CONNECTION_RULES,
            Scope::Timer => TIMER_RULES,
            Scope::Meet => MEET_RULES,
            Scope::Chat => CHAT_RULES,
            Scope::Notifications => NOTIFICATION_RULES,
            Scope::Tasks => TASK_RULES,
        }
    }
}

fn segment_matches(pattern: &str, segment: &str) -> bool {
    if pattern == "{id}" {
        !segment.is_empty() && segment.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    } else {
        pattern == segment
    }
}

/// Only letters, digits, `/`, `-` and `_` after `/api/`: no `..`, `//`, `%2f`, `@`, `:`, query or fragment can pass.
fn path_is_clean(path: &str) -> bool {
    path.starts_with("/api/") && !path.contains("//") && !path.ends_with('/') && path.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_'))
}

/// The rule that allows `method path`, if any.
pub fn permit(rules: &[Rule], method: Method, path: &str) -> Option<Rule> {
    if !path_is_clean(path) {
        return None;
    }
    rules.iter().copied().find(|r| {
        r.method == method && {
            let (mut want, mut have) = (r.pattern.split('/'), path.split('/'));
            loop {
                match (want.next(), have.next()) {
                    (None, None) => break true,
                    (Some(w), Some(h)) if segment_matches(w, h) => {}
                    _ => break false,
                }
            }
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// 401: the whole connection stops.
    Unauthorized,
    /// 403: that provider is not permitted.
    Forbidden,
    /// 402: the store has no credits left.
    Credits,
    NotFound,
    Conflict,
    /// 423, 429, 5xx: back off.
    Backoff,
    /// Timeout, connection refused, DNS.
    Offline,
    /// Refused by our own allow-lists before anything was sent.
    Blocked,
    /// Any other 4xx, an unreadable body, a bad setting.
    Invalid,
}

#[derive(Debug, Clone)]
pub struct ApiError {
    pub kind: Kind,
    pub status: Option<u16>,
    /// The server's `code` when it sent one, else a short camelCase name.
    pub code: String,
    /// Redacted and short.
    pub message: String,
}

impl ApiError {
    pub fn new(kind: Kind, status: Option<u16>, code: impl Into<String>, message: &str) -> Self {
        let message: String = redact(message).chars().take(200).collect();
        Self { kind, status, code: code.into(), message }
    }

    pub fn blocked(message: &str) -> Self {
        Self::new(Kind::Blocked, None, "blocked", message)
    }

    pub fn invalid(code: &str, message: &str) -> Self {
        Self::new(Kind::Invalid, None, code, message)
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// The jail (docs/safety.md): read-only mode makes no network call at all; the test jail talks to loopback only (the
/// mock server), never to the real Happy.
pub fn check_jail(jail: &Jail, base: &Url) -> Result<(), ApiError> {
    match jail.mode() {
        Mode::Off => Ok(()),
        Mode::ReadOnly => Err(ApiError::new(Kind::Blocked, None, "readOnly", "Read-only mode (INTELY_READONLY): Happy makes no network calls")),
        Mode::E2e if is_loopback(base) => Ok(()),
        Mode::E2e => Err(ApiError::new(Kind::Blocked, None, "testJail", "Test jail (INTELY_E2E): Happy may only talk to a local mock server")),
    }
}

/// The base URL of an environment. Custom accepts https, or http on a loopback host (the mock server), and nothing that
/// could redirect the token: no credentials in the URL, no path, query or fragment.
pub fn resolve_base_with(env: &Env, custom: Option<&str>, presets: &Presets) -> Result<Url, ApiError> {
    let pick = |v: Option<&str>, msg: &str| v.map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).ok_or_else(|| ApiError::invalid("invalidBaseUrl", msg));
    let raw = match env {
        Env::Production => pick(presets.production.as_deref(), "Enter the base URL of the production environment (settings.json happy.baseUrls.production, or INTELY_HAPPY_PRODUCTION_URL)")?,
        Env::Sandbox => pick(presets.sandbox.as_deref(), "Enter the base URL of the sandbox environment (settings.json happy.baseUrls.sandbox, or INTELY_HAPPY_SANDBOX_URL)")?,
        Env::Custom => pick(custom, "Enter the base URL of the custom environment")?,
    };
    let raw = raw.as_str();
    let bad = |why: &str| ApiError::invalid("invalidBaseUrl", why);
    let url = Url::parse(raw).map_err(|_| bad("The base URL is not a valid URL"))?;
    if url.host().is_none() {
        return Err(bad("The base URL has no host"));
    }
    let loopback = is_loopback(&url);
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err(bad("The base URL must be https (http is only allowed for localhost)")),
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || !matches!(url.path(), "" | "/") {
        return Err(bad("The base URL must be a bare origin, without credentials, path or query"));
    }
    Ok(url)
}

pub struct Client {
    http: reqwest::Client,
    base: Url,
    token: Secret,
    device_id: String,
    /// Server time minus local time, from the `Date` header of the last response.
    offset_ms: AtomicI64,
    gate: Semaphore,
}

impl Client {
    pub fn new(base: Url, token: Secret, device_id: String) -> Result<Self, ApiError> {
        let http = reqwest::Client::builder()
            .redirect(Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("IntelySwitchIDE/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| ApiError::invalid("client", "The HTTP client could not be created"))?;
        Ok(Self { http, base, token, device_id, offset_ms: AtomicI64::new(0), gate: Semaphore::new(MAX_IN_FLIGHT) })
    }

    pub fn offset_ms(&self) -> i64 {
        self.offset_ms.load(Ordering::Relaxed)
    }

    pub fn host(&self) -> &Url {
        &self.base
    }

    /// What the realtime connection needs: the same origin and the same token as the REST calls.
    pub(crate) fn credentials(&self) -> (Url, Secret) {
        (self.base.clone(), self.token.clone())
    }

    fn scrub(&self, e: ApiError) -> ApiError {
        ApiError { message: redact_with(&e.message, self.token.expose()), ..e }
    }

    fn url(&self, path: &str, query: &[(&str, &str)]) -> Url {
        let mut url = self.base.clone();
        url.set_path(path);
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        url
    }

    /// One request. `actions` says whether the provider may send mutating calls; the webview only reaches this through
    /// typed Rust verbs, never with a path of its own.
    pub async fn call(&self, scope: Scope, method: Method, path: &str, query: &[(&str, &str)], body: Option<&Value>, actions: bool) -> Result<Value, ApiError> {
        let rule = permit(scope.rules(), method, path).ok_or_else(|| ApiError::blocked("That request is not on the allow-list"))?;
        if rule.mutating && !actions {
            return Err(ApiError::blocked("Actions are switched off for this integration"));
        }
        let url = self.url(path, query);
        let _slot = self.gate.acquire().await.map_err(|_| ApiError::invalid("client", "The HTTP client is shutting down"))?;
        let mut auth = HeaderValue::from_str(&format!("Bearer {}", self.token.expose())).map_err(|_| ApiError::invalid("badToken", "The token contains characters a header cannot carry"))?;
        auth.set_sensitive(true);
        let mut req = self
            .http
            .request(
                match method {
                    Method::Get => reqwest::Method::GET,
                    Method::Post => reqwest::Method::POST,
                    Method::Patch => reqwest::Method::PATCH,
                    Method::Delete => reqwest::Method::DELETE,
                },
                url,
            )
            .header(ACCEPT, "application/json")
            .header("X-Device-Name", "Intely IDE")
            .header("X-Device-ID", &self.device_id)
            .header(AUTHORIZATION, auth);
        if let Some(body) = body {
            req = req.header(CONTENT_TYPE, "application/json").body(body.to_string());
        }
        let mut resp = req.send().await.map_err(|e| {
            let e = e.without_url();
            let (code, why) = if e.is_timeout() {
                ("timeout", "The server did not answer in time")
            } else if e.is_connect() {
                ("offline", "Could not connect to the server")
            } else {
                ("network", "The request failed")
            };
            ApiError::new(Kind::Offline, None, code, why)
        })?;
        if let Some(server_ms) = resp.headers().get(DATE).and_then(|v| v.to_str().ok()).and_then(parse_http_date) {
            self.offset_ms.store(server_ms - now_ms(), Ordering::Relaxed);
        }
        let status = resp.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|_| ApiError::new(Kind::Offline, Some(status.as_u16()), "network", "The response could not be read"))? {
            if bytes.len() + chunk.len() > MAX_BODY {
                return Err(ApiError::new(Kind::Invalid, Some(status.as_u16()), "tooLarge", "The response is larger than the 2 MB limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let json: Value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
        if status.is_success() {
            return Ok(json);
        }
        Err(self.scrub(from_status(status.as_u16(), &json)))
    }
}

fn from_status(status: u16, body: &Value) -> ApiError {
    let server_code = body.get("code").and_then(Value::as_str).or_else(|| body.pointer("/error/code").and_then(Value::as_str)).filter(|c| c.len() <= 64 && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'));
    let message = body.get("message").and_then(Value::as_str).or_else(|| body.get("error").and_then(Value::as_str)).unwrap_or("");
    let (kind, name, fallback) = match status {
        401 => (Kind::Unauthorized, "signedOut", "The Happy session expired or was revoked"),
        402 => (Kind::Credits, "insufficientCredits", "The store has no credits left"),
        403 => (Kind::Forbidden, "forbidden", "This account is not allowed to use that"),
        404 => (Kind::NotFound, "notFound", "Not found"),
        409 => (Kind::Conflict, "conflict", "The request conflicts with the current state"),
        300..=399 => (Kind::Invalid, "redirect", "The server answered with a redirect, which is not followed"),
        423 | 429 | 500..=599 => (Kind::Backoff, "unavailable", "The server is busy or unavailable"),
        _ => (Kind::Invalid, "rejected", "The server rejected the request"),
    };
    ApiError::new(kind, Some(status), server_code.unwrap_or(name), if message.is_empty() { fallback } else { message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_allow_list_matches_exact_paths_and_id_segments_only() {
        let meet = Scope::Meet.rules();
        assert!(permit(meet, Method::Get, "/api/chat/meetings").is_some());
        assert!(permit(meet, Method::Post, "/api/chat/meetings/m_1-x/join").is_some_and(|r| r.mutating));
        for (m, p) in [
            (Method::Post, "/api/chat/meetings"),
            (Method::Get, "/api/chat/meetings/m1/join"),
            (Method::Post, "/api/chat/meetings/../users/join"),
            (Method::Post, "/api/chat/meetings//join"),
            (Method::Post, "/api/chat/meetings/a%2Fb/join"),
            (Method::Post, "/api/chat/meetings/a@evil.test/join"),
            (Method::Get, "/api/chat/meetings?status=live"),
            (Method::Get, "/api/chat/meetings/"),
            (Method::Get, "api/chat/meetings"),
            (Method::Get, "/other/api/chat/meetings"),
        ] {
            assert!(permit(meet, m, p).is_none(), "{m:?} {p}");
        }
        assert!(permit(Scope::Timer.rules(), Method::Get, "/api/chat/meetings").is_none(), "scopes do not share rules");
        assert!(permit(Scope::Timer.rules(), Method::Post, "/api/widgets/timer/start").is_some());
        assert!(permit(Scope::Timer.rules(), Method::Post, "/api/widgets/timer/delete").is_none());
        let timer = Scope::Timer.rules();
        for (method, path, mutating) in [
            (Method::Get, "/api/projects", false),
            (Method::Get, "/api/projects/p_1", false),
            (Method::Get, "/api/tasks/autocomplete", false),
            (Method::Get, "/api/tasks", false),
            (Method::Get, "/api/projects/time-entries/summary", false),
            (Method::Post, "/api/tasks", true),
        ] {
            assert_eq!(permit(timer, method, path).map(|r| r.mutating), Some(mutating), "{path}");
        }
        for (method, path) in [(Method::Post, "/api/projects"), (Method::Post, "/api/tasks/t1"), (Method::Get, "/api/projects/p_1/tasks/t_1"), (Method::Post, "/api/projects/p_1/timer/start")] {
            assert!(permit(timer, method, path).is_none(), "{path}");
        }
    }

    #[test]
    fn the_chat_and_inbox_rules_cover_the_real_verbs_and_nothing_else() {
        let chat = Scope::Chat.rules();
        for (m, p) in [
            (Method::Get, "/api/chat/channels"),
            (Method::Post, "/api/chat/channels"),
            (Method::Get, "/api/chat/messages/m1/thread"),
            (Method::Post, "/api/chat/channels/c_1/members"),
            (Method::Delete, "/api/chat/channels/c_1/members/u_2"),
            (Method::Patch, "/api/chat/messages/m1"),
            (Method::Delete, "/api/chat/messages/m1"),
            (Method::Patch, "/api/chat/channels/c_1/preferences"),
        ] {
            assert!(permit(chat, m, p).is_some(), "{m:?} {p}");
        }
        for (m, p) in [(Method::Delete, "/api/chat/channels/c_1"), (Method::Patch, "/api/chat/channels/c_1/members"), (Method::Delete, "/api/chat/channels"), (Method::Get, "/api/chat/channels/c_1/members/u_2"), (Method::Post, "/api/chat/meetings")] {
            assert!(permit(chat, m, p).is_none(), "{m:?} {p}");
        }
        assert!(permit(chat, Method::Delete, "/api/chat/messages/m1").is_some_and(|r| r.mutating));
        assert!(permit(chat, Method::Post, "/api/chat/channels/c_1/read").is_some_and(|r| !r.mutating), "reading is not sending");
        assert!(permit(chat, Method::Post, "/api/chat/channels/c_1/messages").is_some_and(|r| r.mutating));
        let nt = Scope::Notifications.rules();
        assert!(permit(nt, Method::Patch, "/api/notifications/read-all").is_some_and(|r| r.mutating));
        assert!(permit(nt, Method::Patch, "/api/notifications/n_1/read").is_some() && permit(nt, Method::Patch, "/api/notifications/n_1/unread").is_some());
        assert!(permit(nt, Method::Delete, "/api/notifications/n_1").is_some());
        assert!(permit(nt, Method::Post, "/api/notifications/n_1/read").is_none() && permit(nt, Method::Delete, "/api/notifications").is_none());
    }

    #[test]
    fn the_base_url_must_be_https_or_loopback_and_bare() {
        let presets = Presets { production: Some("https://prod.example.test".into()), sandbox: Some("https://sandbox.example.test/".into()) };
        let resolve_base = |env: &Env, custom: Option<&str>| resolve_base_with(env, custom, &presets);
        assert!(resolve_base(&Env::Production, None).is_ok() && resolve_base(&Env::Sandbox, None).is_ok());
        for ok in ["https://happy.example.test", "http://127.0.0.1:4010", "http://localhost:4010/", "http://[::1]:4010"] {
            assert!(resolve_base(&Env::Custom, Some(ok)).is_ok(), "{ok}");
        }
        for bad in ["", "http://happy.example.test", "http://127.0.0.1.evil.test", "ftp://localhost", "https://user:pw@happy.example.test", "https://happy.example.test/api", "https://happy.example.test/?x=1", "https://happy.example.test/#f", "not a url"] {
            assert_eq!(resolve_base(&Env::Custom, Some(bad)).unwrap_err().code, "invalidBaseUrl", "{bad}");
        }
        assert!(resolve_base(&Env::Custom, None).is_err());
    }

    #[test]
    fn status_codes_map_to_kinds_and_keep_the_server_code() {
        let body = serde_json::json!({ "code": "DEVICE_LOGGED_OUT", "message": "bye eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sigsigsigsig" });
        let e = from_status(401, &body);
        assert_eq!((e.kind, e.code.as_str()), (Kind::Unauthorized, "DEVICE_LOGGED_OUT"));
        assert!(!e.message.contains("eyJzdWIi"), "{}", e.message);
        for (status, kind) in [(402, Kind::Credits), (403, Kind::Forbidden), (404, Kind::NotFound), (409, Kind::Conflict), (423, Kind::Backoff), (429, Kind::Backoff), (503, Kind::Backoff), (400, Kind::Invalid), (302, Kind::Invalid)] {
            assert_eq!(from_status(status, &Value::Null).kind, kind, "{status}");
        }
        assert_eq!(from_status(400, &serde_json::json!({ "code": "bad code with spaces" })).code, "rejected");
    }

    #[test]
    fn presets_come_from_env_vars_then_settings_and_are_validated_like_custom() {
        let stored = |v: Value| v.as_object().cloned().unwrap();
        let file = stored(serde_json::json!({ "baseUrls": { "production": "https://file-prod.example.test", "sandbox": " " } }));
        let no_env = |_: &str| None;
        let p = Presets::from_sources(no_env, &file);
        assert_eq!((p.production.as_deref(), p.sandbox.as_deref()), (Some("https://file-prod.example.test"), None));
        let env = |k: &str| (k == PRODUCTION_URL_VAR).then(|| " https://env-prod.example.test ".to_owned());
        let p = Presets::from_sources(env, &file);
        assert_eq!(resolve_base_with(&Env::Production, None, &p).unwrap().host_str(), Some("env-prod.example.test"));
        assert_eq!(resolve_base_with(&Env::Sandbox, None, &p).unwrap_err().code, "invalidBaseUrl");
        let none = Presets::from_sources(no_env, &serde_json::Map::new());
        assert_eq!(resolve_base_with(&Env::Production, None, &none).unwrap_err().code, "invalidBaseUrl");
        for bad in ["http://prod.example.test", "https://u:p@prod.example.test", "https://prod.example.test/api"] {
            let p = Presets { production: Some(bad.into()), sandbox: None };
            assert_eq!(resolve_base_with(&Env::Production, None, &p).unwrap_err().code, "invalidBaseUrl", "{bad}");
        }
    }
}
