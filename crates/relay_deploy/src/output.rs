//! Parsers and the error classifier for wrangler output (spec 4.3 `output.rs`). The output shapes marked `[unverified]` in the spec
//! come from the public documentation, not from a real run: the parsers ignore unknown fields and fail closed on missing required
//! ones, and the fixtures under `tests/fixtures` are replaced by captured outputs after the manual step M1.

use intely_core::jail::Mode;
use serde::Serialize;
use serde_json::Value;
use url::{Host, Url};

use crate::error::{DeployError, Result};
use crate::mask::{email_hint, Masker};

/// The only host a sign-in URL may point at before the UI shows it.
pub const LOGIN_HOST: &str = "dash.cloudflare.com";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Account {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthType {
    Oauth,
    Token,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoAmI {
    pub logged_in: bool,
    pub auth_type: Option<AuthType>,
    /// `a***@e***.test`; the address itself is never kept.
    pub email_hint: Option<String>,
    pub accounts: Vec<Account>,
    pub chosen_account_id: Option<String>,
}

impl WhoAmI {
    pub fn logged_out() -> Self {
        Self { logged_in: false, auth_type: None, email_hint: None, accounts: Vec::new(), chosen_account_id: None }
    }

    /// The account a deploy will target: the chosen one, or the only one. More than one without a choice is `needsAccount`.
    /// `manual_id` is the token-mode Account ID field (a scoped token may not list accounts).
    pub fn resolve_account(&self, chosen: Option<&str>, manual_id: Option<&str>) -> Result<Account> {
        if let Some(id) = chosen.filter(|c| !c.is_empty()) {
            if let Some(a) = self.accounts.iter().find(|a| a.id == id) {
                return Ok(a.clone());
            }
            if valid_account_id(id) && self.accounts.is_empty() {
                return Ok(Account { id: id.to_owned(), name: String::new() });
            }
            return Err(DeployError::coded("needsAccount", "the chosen account is not one of the signed-in accounts"));
        }
        if let Some(id) = manual_id.map(str::trim).filter(|m| !m.is_empty()) {
            if !valid_account_id(id) {
                return Err(DeployError::coded("needsAccount", "the account id is not a Cloudflare account id"));
            }
            let name = self.accounts.iter().find(|a| a.id == id).map(|a| a.name.clone()).unwrap_or_default();
            return Ok(Account { id: id.to_owned(), name });
        }
        match self.accounts.as_slice() {
            [one] => Ok(one.clone()),
            _ => Err(DeployError::coded("needsAccount", "choose which Cloudflare account to use")),
        }
    }
}

/// Cloudflare account ids are 32 hex characters; the check is a little looser so a format change does not lock users out.
pub fn valid_account_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

pub fn account_tail(id: &str) -> String {
    let n = id.chars().count();
    id.chars().skip(n.saturating_sub(4)).collect()
}

fn clean_name(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(100).collect::<String>().trim().to_owned()
}

/// `wrangler whoami --json` (shape `[unverified]`: `{loggedIn, authType, email, accounts:[{id,name}]}`). A non-JSON text that says the
/// user is not authenticated is `WhoAmI::logged_out()`; anything else that is not the expected object is an error (fail closed).
pub fn parse_whoami(text: &str) -> Result<WhoAmI> {
    let trimmed = text.trim();
    let start = trimmed.find('{');
    let v: Option<Value> = start.and_then(|i| serde_json::from_str(&trimmed[i..]).ok());
    let Some(v) = v.filter(Value::is_object) else {
        let l = trimmed.to_ascii_lowercase();
        if l.contains("not authenticated") || l.contains("not logged in") || l.contains("wrangler login") {
            return Ok(WhoAmI::logged_out());
        }
        return Err(DeployError::coded("deployFailed", "whoami did not return the expected JSON"));
    };
    let accounts: Vec<Account> = v
        .get("accounts")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    let id = x.get("id")?.as_str()?;
                    valid_account_id(id).then(|| Account { id: id.to_owned(), name: clean_name(x.get("name").and_then(Value::as_str).unwrap_or("")) })
                })
                .collect()
        })
        .unwrap_or_default();
    let auth_type = v.get("authType").and_then(Value::as_str).map(|t| t.to_ascii_lowercase()).and_then(|t| {
        if t.contains("oauth") {
            Some(AuthType::Oauth)
        } else if t.contains("token") || t.contains("key") {
            Some(AuthType::Token)
        } else {
            None
        }
    });
    let logged_in = match v.get("loggedIn").and_then(Value::as_bool) {
        Some(b) => b,
        None => !accounts.is_empty() || auth_type.is_some(),
    };
    if !logged_in {
        return Ok(WhoAmI::logged_out());
    }
    let email_hint = v.get("email").and_then(Value::as_str).filter(|e| e.contains('@')).map(email_hint);
    Ok(WhoAmI { logged_in, auth_type, email_hint, accounts, chosen_account_id: None })
}

/// The `https://dash.cloudflare.com/...` URL in one line of `wrangler login` output. Only that host is accepted and the result is for
/// display as plain selectable text; the IDE never opens it. Call with the RAW line (the masked one has its OAuth values removed).
pub fn parse_login_url(raw_line: &str) -> Option<String> {
    let i = raw_line.find("https://")?;
    let candidate: String = raw_line[i..].chars().take_while(|c| !c.is_whitespace() && !matches!(c, '"' | '\'' | '<' | '>' | '`')).collect();
    let u = Url::parse(&candidate).ok()?;
    let ok = u.scheme() == "https"
        && u.host_str() == Some(LOGIN_HOST)
        && u.username().is_empty()
        && u.password().is_none()
        && u.port().is_none()
        && u.fragment().is_none();
    ok.then(|| u.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeployResult {
    pub worker_name: String,
    pub version_id: Option<String>,
    pub targets: Vec<String>,
}

/// The wrangler output file (`WRANGLER_OUTPUT_FILE_PATH`, one JSON object per line). The last `type:"deploy"` line wins; a
/// `type:"command-failed"` line after it (or without any deploy line) yields a `deployFailed` error with the code and a short message.
pub fn parse_deploy_ndjson(text: &str) -> Result<DeployResult> {
    let mut deploy: Option<DeployResult> = None;
    let mut failed: Option<String> = None;
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        match v.get("type").and_then(Value::as_str) {
            Some("deploy") => {
                let name = v.get("worker_name").and_then(Value::as_str).unwrap_or("");
                let targets: Vec<String> = v.get("targets").and_then(Value::as_array).map(|t| t.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
                deploy = Some(DeployResult {
                    worker_name: name.to_owned(),
                    version_id: v.get("version_id").and_then(Value::as_str).map(str::to_owned),
                    targets,
                });
                failed = None;
            }
            Some("command-failed") => {
                let code = v.get("code").map(|c| c.to_string().trim_matches('"').to_owned()).unwrap_or_default();
                let msg = v.get("message").and_then(Value::as_str).unwrap_or("");
                let msg = Masker::default().mask(&msg.chars().take(300).collect::<String>());
                failed = Some(format!("wrangler reported a failure (code {code}): {msg}"));
            }
            _ => {}
        }
    }
    if let Some(f) = failed {
        return Err(DeployError::coded("deployFailed", f));
    }
    deploy.filter(|d| !d.worker_name.is_empty()).ok_or_else(|| DeployError::coded("deployFailed", "wrangler wrote no deploy result"))
}

/// A target the deploy printed and the user's review accepted. `ws_base` is what `relayUrl` becomes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayTarget {
    pub http_base: String,
    pub ws_base: String,
    pub host: String,
}

/// Accepts only `https://<workerName>.<label>.workers.dev` (exact name, four labels) or the validated custom domain; in the E2E jail
/// also `http://127.0.0.1:<port>`. Anything else (another host, http, userinfo, a path, a query, a port) fails with `deployFailed`.
pub fn accept_target(url: &str, worker_name: &str, custom_domain: Option<&str>, jail: Mode) -> Result<RelayTarget> {
    let bad = |why: &str| DeployError::coded("deployFailed", format!("wrangler printed a deploy target that was not accepted ({why})"));
    let u = Url::parse(url.trim()).map_err(|_| bad("not a URL"))?;
    if !u.username().is_empty() || u.password().is_some() || u.query().is_some() || u.fragment().is_some() || !matches!(u.path(), "" | "/") {
        return Err(bad("userinfo, path, query or fragment"));
    }
    if jail == Mode::E2e && u.scheme() == "http" {
        // The URL parser turns `127.1` into 127.0.0.1: the text the deploy printed must already be the canonical form.
        let typed_host = url.trim().strip_prefix("http://").and_then(|r| r.split(['/', ':']).next()).unwrap_or("");
        return match (u.host(), u.port()) {
            (Some(Host::Ipv4(ip)), Some(port)) if ip.octets() == [127, 0, 0, 1] && port != 0 && typed_host == "127.0.0.1" => {
                Ok(RelayTarget { http_base: format!("http://127.0.0.1:{port}"), ws_base: format!("ws://127.0.0.1:{port}"), host: format!("127.0.0.1:{port}") })
            }
            _ => Err(bad("only http://127.0.0.1:<port> is accepted in the test jail")),
        };
    }
    if u.scheme() != "https" || u.port().is_some() {
        return Err(bad("https on the default port only"));
    }
    let Some(Host::Domain(host)) = u.host() else { return Err(bad("a host name is required")) };
    let host = host.to_ascii_lowercase();
    let workers_dev = {
        let labels: Vec<&str> = host.split('.').collect();
        labels.len() == 4 && labels[0] == worker_name && labels[2] == "workers" && labels[3] == "dev" && valid_label(labels[1])
    };
    let custom = custom_domain.is_some_and(|d| d.eq_ignore_ascii_case(&host));
    if !(workers_dev || custom) {
        return Err(bad("the host is not <worker>.<subdomain>.workers.dev or the chosen custom domain"));
    }
    Ok(RelayTarget { http_base: format!("https://{host}"), ws_base: format!("wss://{host}"), host })
}

fn valid_label(l: &str) -> bool {
    !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    LoginPortBusy,
    NoSubdomain,
    AccountUnverified,
    RateLimited,
    Quota,
    Offline,
    Network,
    NotLoggedIn,
    Permission,
    AuthInvalid,
    NameTaken,
    Other,
}

impl ErrorKind {
    /// The spec error code (4.11). `Other` is a plain `deployFailed`.
    pub fn code(self) -> &'static str {
        match self {
            Self::LoginPortBusy => "loginPortBusy",
            Self::NoSubdomain => "noSubdomain",
            Self::AccountUnverified => "accountUnverified",
            Self::RateLimited => "rateLimited",
            Self::Quota => "quota",
            Self::Offline => "offline",
            Self::Network => "network",
            Self::NotLoggedIn => "notLoggedIn",
            Self::Permission => "permission",
            Self::AuthInvalid => "authInvalid",
            Self::NameTaken => "nameTaken",
            Self::Other => "deployFailed",
        }
    }
}

const TABLE: [(ErrorKind, &[&str]); 11] = [
    (ErrorKind::LoginPortBusy, &["eaddrinuse", "address already in use", "port 8976"]),
    (ErrorKind::NoSubdomain, &["workers.dev subdomain", "register a workers.dev", "code: 10063", "you need to register"]),
    (ErrorKind::AccountUnverified, &["verify your email", "email address is not verified", "account is not verified", "email verification"]),
    (ErrorKind::RateLimited, &["rate limit", "too many requests", "code: 971", "status 429", "http 429"]),
    (ErrorKind::Quota, &["quota", "limit reached", "maximum number of", "exceeded the limit", "free tier limit"]),
    (ErrorKind::Offline, &["enetunreach", "eai_again", "network is unreachable", "you appear to be offline", "no internet"]),
    (ErrorKind::Network, &["enotfound", "getaddrinfo", "econnrefused", "etimedout", "econnreset", "fetch failed", "socket hang up", "network error", "connect timeout"]),
    (ErrorKind::NotLoggedIn, &["not authenticated", "not logged in", "non-interactive", "run `wrangler login`", "must be logged in", "set a cloudflare_api_token", "you are not logged"]),
    (ErrorKind::Permission, &["permission", "forbidden", "code: 10023", "not authorized", "insufficient"]),
    (ErrorKind::AuthInvalid, &["code: 10000", "authentication error", "invalid access token", "invalid api token", "invalid token", "token has expired", "refresh token", "unauthorized"]),
    (ErrorKind::NameTaken, &["already in use by another", "name is already taken", "script already exists under a different"]),
];

/// Maps the stderr/stdout lines of a failed run to an error kind. The first matching row of the table wins; the exit code only
/// matters for the caller (a zero exit is never an error).
pub fn classify(lines: &[String], exit: i32) -> ErrorKind {
    if exit == 0 {
        return ErrorKind::Other;
    }
    let text = lines.join("\n").to_ascii_lowercase();
    TABLE.iter().find(|(_, needles)| needles.iter().any(|n| text.contains(n))).map(|(k, _)| *k).unwrap_or(ErrorKind::Other)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NameCheck {
    Free,
    Mine,
    Foreign,
    Unknown,
}

impl NameCheck {
    /// `foreign` and `unknown` need the second typed phrase (spec 4.12.8).
    pub fn needs_overwrite_phrase(self) -> bool {
        matches!(self, Self::Foreign | Self::Unknown)
    }
}

/// `wrangler deployments list --name <n>` (output shape `[unverified]`). `mine` only when a deployment message carries this
/// install's stamp (`intely-relay:<stamp>`); a listing without it is `foreign`; an unrecognised failure is `unknown`.
pub fn classify_name_check(lines: &[String], exit: i32, stamp: &str) -> NameCheck {
    let text = lines.join("\n");
    let lower = text.to_ascii_lowercase();
    if exit == 0 {
        if !stamp.is_empty() && text.contains(&format!("intely-relay:{stamp}")) {
            return NameCheck::Mine;
        }
        return if lower.trim().is_empty() { NameCheck::Unknown } else { NameCheck::Foreign };
    }
    let missing = ["this worker does not exist", "does not exist", "could not find", "not found", "code: 10007"];
    if missing.iter().any(|n| lower.contains(n)) {
        NameCheck::Free
    } else {
        NameCheck::Unknown
    }
}
