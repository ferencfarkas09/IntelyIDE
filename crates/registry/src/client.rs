//! The only door to the registry: a Rust-side HTTP client with a host rule (https, or http on a loopback address for tests), no
//! redirects, a `(method, path)` allow-list, a response cap, and nothing of the token on any error path.
//!
//! TLS is `native-tls` (Security.framework on macOS), like the other integrations: no second TLS stack is shipped.

use std::time::Duration;

use intely_settings::Secret;
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use reqwest::redirect::Policy;
use reqwest::{StatusCode, Url};
use serde_json::Value;

use crate::types::Problem;

const MAX_BODY: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// The only requests the app makes.
const RULES: &[(&str, &str)] = &[("POST", "/v1/register"), ("POST", "/v1/ping"), ("GET", "/v1/me"), ("POST", "/v1/newsletter"), ("POST", "/v1/forget")];

pub fn allowed(method: &str, path: &str) -> bool {
    RULES.iter().any(|(m, p)| *m == method && *p == path)
}

/// `https://api.example`, or `http://127.0.0.1:PORT` (tests): no credentials, no path, no query.
pub fn validate_base(raw: &str) -> Result<Url, Problem> {
    let bad = |why: &str| Problem::new("invalidUrl", format!("The registry address is not usable: {why}"));
    let url = Url::parse(raw.trim()).map_err(|_| bad("it is not a web address"))?;
    let host = url.host_str().ok_or_else(|| bad("it has no host"))?;
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "[::1]";
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err(bad("it must start with https://")),
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || url.path() != "/" {
        return Err(bad("it must be the address of the server only"));
    }
    Ok(url)
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: Url,
}

impl Client {
    pub fn new(base: &str) -> Result<Self, Problem> {
        let base = validate_base(base)?;
        let http = reqwest::Client::builder()
            .redirect(Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .user_agent("IntelyIDE")
            .build()
            .map_err(|_| Problem::new("network", "The network client could not start"))?;
        Ok(Self { http, base })
    }

    /// One request. `token` goes in the `Authorization` header; the body is JSON. The answer is the JSON body of a 2xx.
    pub async fn send(&self, method: &str, path: &str, token: Option<&Secret>, body: Option<&Value>) -> Result<Value, Problem> {
        if !allowed(method, path) {
            return Err(Problem::new("badRequest", "That request is not one the app makes"));
        }
        let mut url = self.base.clone();
        url.set_path(path);
        let builder = if method == "GET" { self.http.get(url) } else { self.http.post(url) };
        let mut builder = builder.header(ACCEPT, "application/json");
        if let Some(t) = token {
            let mut auth = HeaderValue::from_str(&format!("Bearer {}", t.expose())).map_err(|_| Problem::new("unknownInstall", "The saved token cannot be used"))?;
            auth.set_sensitive(true);
            builder = builder.header(AUTHORIZATION, auth);
        }
        if let Some(b) = body {
            builder = builder.header(CONTENT_TYPE, "application/json").body(b.to_string());
        }
        let offline = || Problem::new("offline", "The registry could not be reached. Check the connection and try again.");
        let mut resp = builder.send().await.map_err(|_| offline())?;
        let status = resp.status();
        let retry = resp.headers().get(RETRY_AFTER).and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok());
        let mut bytes: Vec<u8> = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|_| offline())? {
            if bytes.len() + chunk.len() > MAX_BODY {
                return Err(Problem::new("badResponse", "The registry's answer is too large"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let parsed: Option<Value> = serde_json::from_slice(&bytes).ok();
        if status.is_success() {
            return parsed.ok_or_else(|| Problem::new("badResponse", "The registry's answer was not JSON"));
        }
        Err(problem_for(status, parsed.as_ref(), retry))
    }
}

fn problem_for(status: StatusCode, body: Option<&Value>, retry: Option<u64>) -> Problem {
    let word = body.and_then(|b| b.get("error")).and_then(Value::as_str).filter(|w| w.len() <= 40 && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')).unwrap_or("");
    match status.as_u16() {
        401 => Problem::new("unknownInstall", "The registry does not know this computer (any more)"),
        429 => Problem { retry_after_s: retry.or(Some(600)), ..Problem::new("rateLimited", "Too many requests: try again in a few minutes") },
        400 | 413 | 415 => Problem::new("badRequest", format!("The registry did not accept the request ({word})")),
        502 => Problem::new("tryLater", "The registry could not finish that just now. Try again in a moment."),
        500..=599 => Problem::new("server", format!("The registry had a problem ({})", status.as_u16())),
        other => Problem::new("badResponse", format!("The registry answered with {other}")),
    }
}

#[cfg(test)]
pub(crate) mod testserver {
    //! A one-shot-per-request HTTP server on loopback for the tests of the client and the service.
    use std::sync::{Arc, Mutex};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    pub struct Canned {
        pub status: u16,
        pub headers: Vec<(&'static str, String)>,
        pub body: String,
    }

    pub fn ok(body: &str) -> Canned {
        Canned { status: 200, headers: vec![], body: body.to_owned() }
    }

    pub fn status(code: u16, body: &str) -> Canned {
        Canned { status: code, headers: vec![], body: body.to_owned() }
    }

    /// Answers the requests in order (the last answer repeats) and records each one's head and body.
    pub async fn serve(answers: Vec<Canned>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let log = seen.clone();
        tokio::spawn(async move {
            let mut n = 0;
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let mut buf = vec![0u8; 65536];
                let mut len = 0;
                loop {
                    let Ok(k) = sock.read(&mut buf[len..]).await else { break };
                    if k == 0 {
                        break;
                    }
                    len += k;
                    let text = String::from_utf8_lossy(&buf[..len]).to_string();
                    if let Some(split) = text.find("\r\n\r\n") {
                        let want = text[..split].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if len >= split + 4 + want {
                            break;
                        }
                    }
                }
                log.lock().unwrap().push(String::from_utf8_lossy(&buf[..len]).to_string());
                let a = &answers[n.min(answers.len() - 1)];
                n += 1;
                let mut head = format!("HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n", a.status, a.body.len());
                for (k, v) in &a.headers {
                    head.push_str(&format!("{k}: {v}\r\n"));
                }
                head.push_str("\r\n");
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(a.body.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (format!("http://{addr}"), seen)
    }
}

#[cfg(test)]
mod tests {
    use super::testserver::{ok, serve, status, Canned};
    use super::*;
    use serde_json::json;

    #[test]
    fn the_address_must_be_https_or_loopback_and_nothing_more() {
        assert!(validate_base("https://api.example.invalid").is_ok());
        assert!(validate_base("https://api.example.invalid/").is_ok());
        assert!(validate_base("http://127.0.0.1:9000").is_ok());
        for bad in ["http://api.example.invalid", "ftp://x.example", "api.example", "", "https://x.example/?a=1", "https://x.example/#x", "https://x.example/v1", "http://192.168.1.5"] {
            assert_eq!(validate_base(bad).unwrap_err().code, "invalidUrl", "{bad}");
        }
        let with_login = ["https://", "someone", ":", "secret", "@", "x.example"].concat();
        assert_eq!(validate_base(&with_login).unwrap_err().code, "invalidUrl");
    }

    #[test]
    fn only_the_requests_the_app_makes_are_allowed() {
        for (m, p) in [("POST", "/v1/register"), ("POST", "/v1/ping"), ("GET", "/v1/me"), ("POST", "/v1/newsletter"), ("POST", "/v1/forget")] {
            assert!(allowed(m, p), "{m} {p}");
        }
        for (m, p) in [("GET", "/v1/register"), ("DELETE", "/v1/me"), ("GET", "/admin/api/summary"), ("GET", "/admin"), ("POST", "/v1/ping/"), ("POST", "/v1/../admin"), ("GET", "/v1/health")] {
            assert!(!allowed(m, p), "{m} {p}");
        }
    }

    #[tokio::test]
    async fn it_sends_the_token_and_the_body_and_reads_the_answer() {
        let (base, seen) = serve(vec![ok(r#"{"ok":true,"token":"abc"}"#)]).await;
        let c = Client::new(&base).unwrap();
        let v = c.send("POST", "/v1/ping", Some(&Secret::new("TOKEN-VALUE-1234")), Some(&json!({"a": 1}))).await.unwrap();
        assert_eq!(v["token"], "abc");
        let req = seen.lock().unwrap()[0].clone();
        assert!(req.starts_with("POST /v1/ping HTTP/1.1"), "{req}");
        assert!(req.to_ascii_lowercase().contains("authorization: bearer token-value-1234"));
        assert!(req.contains(r#"{"a":1}"#));
        assert!(req.contains("user-agent: IntelyIDE") || req.contains("User-Agent: IntelyIDE"));
    }

    #[tokio::test]
    async fn answers_become_problems_with_a_code_and_never_the_token() {
        for (code, body, want) in [
            (401, r#"{"ok":false,"error":"unknown_install"}"#, "unknownInstall"),
            (400, r#"{"ok":false,"error":"email"}"#, "badRequest"),
            (413, r#"{"ok":false,"error":"too_large"}"#, "badRequest"),
            (429, r#"{"ok":false,"error":"slow_down"}"#, "rateLimited"),
            (502, r#"{"ok":false,"error":"try_later"}"#, "tryLater"),
            (500, r#"{"ok":false,"error":"server"}"#, "server"),
            (418, "", "badResponse"),
        ] {
            let (base, _) = serve(vec![Canned { status: code, headers: vec![("Retry-After", "42".into())], body: body.into() }]).await;
            let p = Client::new(&base).unwrap().send("POST", "/v1/ping", Some(&Secret::new("TOKEN-VALUE-1234")), Some(&json!({}))).await.unwrap_err();
            assert_eq!(p.code, want, "{code}");
            assert!(!p.message.contains("TOKEN-VALUE-1234"));
            if code == 429 {
                assert_eq!(p.retry_after_s, Some(42));
            }
        }
        let (base, _) = serve(vec![status(400, r#"{"error":"<script>"}"#)]).await;
        let p = Client::new(&base).unwrap().send("POST", "/v1/register", None, Some(&json!({}))).await.unwrap_err();
        assert!(!p.message.contains("<script>"), "an odd error word is not repeated");
    }

    #[tokio::test]
    async fn a_redirect_is_not_followed_and_a_big_answer_is_refused() {
        let (base, seen) = serve(vec![Canned { status: 302, headers: vec![("Location", "http://127.0.0.1:1/v1/me".into())], body: String::new() }]).await;
        let p = Client::new(&base).unwrap().send("GET", "/v1/me", Some(&Secret::new("TOKEN-VALUE-1234")), None).await.unwrap_err();
        assert_eq!(p.code, "badResponse");
        assert_eq!(seen.lock().unwrap().len(), 1);
        let (base, _) = serve(vec![ok(&format!(r#"{{"pad":"{}"}}"#, "x".repeat(70_000)))]).await;
        assert_eq!(Client::new(&base).unwrap().send("GET", "/v1/me", None, None).await.unwrap_err().code, "badResponse");
    }

    #[tokio::test]
    async fn an_unreachable_server_is_offline() {
        let p = Client::new("http://127.0.0.1:1").unwrap().send("POST", "/v1/ping", None, Some(&json!({}))).await.unwrap_err();
        assert_eq!(p.code, "offline");
    }

    #[tokio::test]
    async fn a_request_outside_the_list_is_not_sent() {
        let (base, seen) = serve(vec![ok("{}")]).await;
        let p = Client::new(&base).unwrap().send("GET", "/admin/api/summary", None, None).await.unwrap_err();
        assert_eq!(p.code, "badRequest");
        assert!(seen.lock().unwrap().is_empty());
    }
}
