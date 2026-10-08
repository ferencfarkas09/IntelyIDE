//! The only door to Sentry: a Rust-side HTTP client with a host rule (https, or http on a loopback address for tests), no
//! redirects, a `(method, path)` allow-list, a response cap, and nothing of the token on any error path.
//!
//! TLS is `native-tls` (Security.framework on macOS), like the other integrations: no second TLS stack is shipped.

use std::time::Duration;

use intely_settings::Secret;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, LINK, RETRY_AFTER};
use reqwest::redirect::Policy;
use reqwest::{StatusCode, Url};
use serde_json::Value;

use crate::types::ApiProblem;

const MAX_BODY: usize = 4 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// What Sentry answered: the JSON body and the `Link` header (the next page's cursor lives there).
#[derive(Debug, Clone)]
pub struct Reply {
    pub body: Value,
    pub link: Option<String>,
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: Url,
    token: Secret,
}

/// `https://sentry.io`, a self-hosted `https://sentry.example`, or `http://127.0.0.1:PORT` (tests): no credentials, no query.
pub fn validate_base(raw: &str) -> Result<Url, ApiProblem> {
    let bad = |why: &str| ApiProblem::new("invalidBaseUrl", format!("The Sentry address is not usable: {why}"));
    let url = Url::parse(raw.trim()).map_err(|_| bad("it is not a web address"))?;
    let host = url.host_str().ok_or_else(|| bad("it has no host"))?;
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "[::1]";
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err(bad("it must start with https://")),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad("it must not carry a user name or password"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(bad("it must be the address of the server only"));
    }
    Ok(url)
}

fn segment_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s != "." && s != ".." && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// The only requests the app makes. `{}` matches one path segment of letters, digits, `-`, `_` and `.`.
const RULES: &[(&str, &str)] = &[
    ("GET", "/api/0/organizations/{}/"),
    ("GET", "/api/0/organizations/{}/projects/"),
    ("GET", "/api/0/organizations/{}/issues/"),
    ("GET", "/api/0/organizations/{}/issues/{}/"),
    ("GET", "/api/0/organizations/{}/issues/{}/events/latest/"),
    ("GET", "/api/0/users/me/"),
    ("PUT", "/api/0/organizations/{}/issues/{}/"),
];

pub fn allowed(method: &str, path: &str) -> bool {
    RULES.iter().any(|(m, pattern)| {
        let mine: Vec<&str> = path.split('/').collect();
        let theirs: Vec<&str> = pattern.split('/').collect();
        *m == method && mine.len() == theirs.len() && mine.iter().zip(&theirs).all(|(a, b)| if *b == "{}" { segment_ok(a) } else { a == b })
    })
}

/// A message that is safe to show: secret shapes masked, one line, cut.
fn safe(s: &str, max: usize) -> String {
    let one_line: String = intely_checks::secrets::redact(s).split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        one_line
    } else {
        let mut cut: String = one_line.chars().take(max).collect();
        cut.push('…');
        cut
    }
}

/// Sentry's own words about a failure, with the token masked even where it is echoed back (a token has no secret shape of its own).
fn detail_of(body: &Value, token: &str) -> Option<String> {
    let d = body.get("detail")?;
    let text = d.as_str().map(str::to_owned).or_else(|| d.get("message").and_then(Value::as_str).map(str::to_owned))?;
    let text = if token.len() >= 6 { text.replace(token, "[token]") } else { text };
    Some(safe(&text, 240))
}

fn problem_for(status: StatusCode, body: &Value, headers: &HeaderMap, token: &str) -> ApiProblem {
    let detail = detail_of(body, token).map(|d| format!(": {d}")).unwrap_or_default();
    match status.as_u16() {
        401 => ApiProblem::new("unauthorized", format!("Sentry did not accept the token{detail}")),
        403 => ApiProblem::new("forbidden", format!("The token is not allowed to do that{detail}")),
        404 => ApiProblem::new("notFound", format!("Sentry has no such organization, project or issue{detail}")),
        429 => {
            let retry = headers.get(RETRY_AFTER).and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok());
            ApiProblem { code: "rateLimited".into(), message: "Sentry asks for a pause between requests".into(), retry_after_s: retry }
        }
        400 | 422 => ApiProblem::new("badRequest", format!("Sentry did not accept the request{detail}")),
        500..=599 => ApiProblem::new("server", format!("Sentry had a problem ({}){detail}", status.as_u16())),
        other => ApiProblem::new("badResponse", format!("Sentry answered with {other}{detail}")),
    }
}

impl Client {
    pub fn new(base: &str, token: Secret) -> Result<Self, ApiProblem> {
        let base = validate_base(base)?;
        let http = reqwest::Client::builder()
            .redirect(Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .user_agent("IntelyIDE")
            .build()
            .map_err(|e| ApiProblem::new("network", safe(&e.to_string(), 200)))?;
        Ok(Self { http, base, token })
    }

    fn url(&self, path: &str, query: &[(&str, &str)]) -> Result<Url, ApiProblem> {
        let mut url = self.base.clone();
        let prefix = url.path().trim_end_matches('/').to_owned();
        url.set_path(&format!("{prefix}{path}"));
        // a parameter is sent as given, empty ones too (`query=` means "no filter at all" to Sentry); callers leave out what they do not want
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter());
        }
        Ok(url)
    }

    async fn send(&self, method: &str, path: &str, query: &[(&str, &str)], body: Option<&Value>) -> Result<Reply, ApiProblem> {
        if !allowed(method, path) {
            return Err(ApiProblem::new("badRequest", "That request is not one the app makes"));
        }
        let url = self.url(path, query)?;
        let mut auth = HeaderValue::from_str(&format!("Bearer {}", self.token.expose())).map_err(|_| ApiProblem::new("unauthorized", "The token has characters a token cannot have"))?;
        auth.set_sensitive(true);
        let builder = if method == "PUT" { self.http.put(url) } else { self.http.get(url) };
        let mut builder = builder.header(AUTHORIZATION, auth).header(ACCEPT, "application/json");
        if let Some(b) = body {
            builder = builder.header(CONTENT_TYPE, "application/json").body(b.to_string());
        }
        let mut resp = builder.send().await.map_err(|e| ApiProblem::new("network", safe(&e.without_url().to_string(), 200)))?;
        let status = resp.status();
        let headers = resp.headers().clone();
        let mut bytes: Vec<u8> = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| ApiProblem::new("network", safe(&e.without_url().to_string(), 200)))? {
            if bytes.len() + chunk.len() > MAX_BODY {
                return Err(ApiProblem::new("badResponse", "Sentry's answer is too large"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let parsed: Option<Value> = serde_json::from_slice(&bytes).ok();
        if status.is_redirection() {
            return Err(ApiProblem::new("badResponse", "Sentry redirected the request, which the app does not follow"));
        }
        if !status.is_success() {
            return Err(problem_for(status, parsed.as_ref().unwrap_or(&Value::Null), &headers, self.token.expose()));
        }
        let body = parsed.ok_or_else(|| ApiProblem::new("badResponse", "Sentry's answer was not JSON"))?;
        Ok(Reply { body, link: headers.get(LINK).and_then(|v| v.to_str().ok()).map(str::to_owned) })
    }

    pub async fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Reply, ApiProblem> {
        self.send("GET", path, query, None).await
    }

    pub async fn put(&self, path: &str, body: &Value) -> Result<Reply, ApiProblem> {
        self.send("PUT", path, &[], Some(body)).await
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
                // read the head, then as much body as Content-Length says
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

    fn client(base: &str) -> Client {
        Client::new(base, Secret::new("sntrys_SECRETVALUE1234567890")).unwrap()
    }

    #[test]
    fn the_address_must_be_https_or_loopback_and_nothing_more() {
        assert!(validate_base("https://sentry.io").is_ok());
        assert!(validate_base("https://sentry.example.invalid/").is_ok());
        assert!(validate_base("http://127.0.0.1:9000").is_ok());
        assert!(validate_base("http://localhost:9000").is_ok());
        for bad in ["http://sentry.io", "ftp://sentry.io", "sentry.io", "", "https://sentry.io/?a=1", "https://sentry.io/#x", "http://192.168.1.5"] {
            assert_eq!(validate_base(bad).unwrap_err().code, "invalidBaseUrl", "{bad}");
        }
        // a user name and a password in the address (written in pieces: no credential-shaped text in the source)
        let with_login = ["https://", "someone", ":", "secret", "@", "sentry.io"].concat();
        assert_eq!(validate_base(&with_login).unwrap_err().code, "invalidBaseUrl");
    }

    #[test]
    fn only_the_requests_the_app_makes_are_allowed() {
        assert!(allowed("GET", "/api/0/organizations/acme/"));
        assert!(allowed("GET", "/api/0/organizations/acme/issues/"));
        assert!(allowed("GET", "/api/0/organizations/acme/issues/123/events/latest/"));
        assert!(allowed("PUT", "/api/0/organizations/acme/issues/123/"));
        assert!(allowed("GET", "/api/0/users/me/"));
        assert!(!allowed("PUT", "/api/0/organizations/acme/"), "no change of the organization");
        assert!(!allowed("GET", "/api/0/organizations/acme/members/"));
        assert!(!allowed("DELETE", "/api/0/organizations/acme/issues/123/"));
        assert!(!allowed("GET", "/api/0/organizations/a%2Fb/issues/"));
        assert!(!allowed("GET", "/api/0/organizations/../issues/"));
        assert!(!allowed("GET", "/api/0/organizations//issues/"));
    }

    #[tokio::test]
    async fn a_get_carries_the_token_and_the_query_and_returns_the_body_and_the_link() {
        let link = r#"<u>; rel="next"; results="true"; cursor="0:25:0""#.to_owned();
        let (base, seen) = serve(vec![Canned { status: 200, headers: vec![("Link", link.clone())], body: r#"[{"id":"1"}]"#.into() }]).await;
        let r = client(&base).get("/api/0/organizations/acme/issues/", &[("query", "is:unresolved level:error"), ("statsPeriod", "14d"), ("empty", "")]).await.unwrap();
        assert_eq!(r.body, json!([{ "id": "1" }]));
        assert_eq!(r.link.as_deref(), Some(link.as_str()));
        let req = seen.lock().unwrap()[0].clone();
        let head = req.lines().next().unwrap().to_owned();
        assert!(head.starts_with("GET /api/0/organizations/acme/issues/?query=is%3Aunresolved+level%3Aerror&statsPeriod=14d&empty= "), "{head}");
        assert!(head.contains("empty=") && head.contains("statsPeriod=14d"), "a parameter is sent as given, an empty one too: {head}");
        let lower = req.to_ascii_lowercase();
        assert!(lower.contains("authorization: bearer sntrys_secretvalue1234567890"), "{req}");
        assert!(lower.contains("accept: application/json"));
    }

    #[tokio::test]
    async fn a_put_sends_the_json_body() {
        let (base, seen) = serve(vec![ok(r#"{"id":"9","status":"resolved"}"#)]).await;
        let r = client(&base).put("/api/0/organizations/acme/issues/9/", &json!({ "status": "resolved" })).await.unwrap();
        assert_eq!(r.body["status"], "resolved");
        let req = seen.lock().unwrap()[0].clone();
        assert!(req.starts_with("PUT /api/0/organizations/acme/issues/9/ "), "{req}");
        assert!(req.to_ascii_lowercase().contains("content-type: application/json"));
        assert!(req.ends_with(r#"{"status":"resolved"}"#), "{req}");
    }

    #[tokio::test]
    async fn failures_are_told_apart_and_never_carry_the_token() {
        let cases = [
            (401, r#"{"detail":"Invalid token sntrys_SECRETVALUE1234567890"}"#, "unauthorized"),
            (403, r#"{"detail":"You do not have permission to perform this action."}"#, "forbidden"),
            (404, r#"{"detail":"The requested resource does not exist"}"#, "notFound"),
            (400, r#"{"detail":"bad cursor"}"#, "badRequest"),
            (500, "oops", "server"),
            (418, "{}", "badResponse"),
        ];
        for (code, body, want) in cases {
            let (base, _) = serve(vec![status(code, body)]).await;
            let e = client(&base).get("/api/0/organizations/acme/", &[]).await.unwrap_err();
            assert_eq!(e.code, want, "{code}");
            assert!(!e.message.contains("SECRETVALUE"), "{}", e.message);
        }
        let (base, _) = serve(vec![Canned { status: 429, headers: vec![("Retry-After", "17".into())], body: "{}".into() }]).await;
        let e = client(&base).get("/api/0/organizations/acme/", &[]).await.unwrap_err();
        assert_eq!((e.code.as_str(), e.retry_after_s), ("rateLimited", Some(17)));
    }

    #[tokio::test]
    async fn a_redirect_is_not_followed_and_a_huge_or_non_json_answer_is_refused() {
        let (base, seen) = serve(vec![Canned { status: 302, headers: vec![("Location", "http://127.0.0.1:1/elsewhere".into())], body: String::new() }]).await;
        let e = client(&base).get("/api/0/organizations/acme/", &[]).await.unwrap_err();
        assert_eq!(e.code, "badResponse");
        assert_eq!(seen.lock().unwrap().len(), 1);
        let (base, _) = serve(vec![ok(&"x".repeat(MAX_BODY + 10))]).await;
        assert_eq!(client(&base).get("/api/0/organizations/acme/", &[]).await.unwrap_err().code, "badResponse");
        let (base, _) = serve(vec![ok("<html>not json</html>")]).await;
        assert_eq!(client(&base).get("/api/0/organizations/acme/", &[]).await.unwrap_err().code, "badResponse");
    }

    #[tokio::test]
    async fn a_request_outside_the_list_is_refused_before_anything_is_sent() {
        let (base, seen) = serve(vec![ok("{}")]).await;
        let e = client(&base).get("/api/0/organizations/acme/members/", &[]).await.unwrap_err();
        assert_eq!(e.code, "badRequest");
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn nothing_listens_is_a_network_problem_without_the_token() {
        let e = client("http://127.0.0.1:9").get("/api/0/organizations/acme/", &[]).await.unwrap_err();
        assert_eq!(e.code, "network");
        assert!(!e.message.contains("SECRETVALUE"));
    }
}
