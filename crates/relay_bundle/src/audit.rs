//! Relay check and audit (spec 4.8, network rules 4.12.5). Best effort, not a security claim: an adaptive server can serve the audit
//! and the phone differently, so a good verdict proves nothing about a hostile Worker (spec 2, 9).

use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use intely_core::jail::Jail;
use serde_json::Value;

use crate::error::Result;
use crate::manifest::{b64u_bytes, sha256_hex, verify_manifest_str, FailCode, Verified, VerifyOpts};
use crate::net::{check_jail, parse_origin, Origin};
use crate::Secret;

/// What the caller expects the relay to serve. All optional: without a key the verdict can only be `Observed`.
#[derive(Debug, Clone, Default)]
pub struct Expected {
    /// `manifestSha256` the deploy recorded (grouped or ungrouped hex).
    pub hash: Option<String>,
    /// Pinned raw Ed25519 key, base64url.
    pub pubkey: Option<String>,
    pub min_seq: Option<u64>,
}

/// The Mac's room credential: proves ownership to `/api/status`, which then also reports `do.ok`. Optional.
#[derive(Debug, Clone)]
pub struct MacCredential {
    pub room: String,
    pub token: Secret,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BundleVerdict {
    Ok,
    Observed,
    HashMismatch,
    BadSignature,
    KeyMismatch,
    Rollback,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayCheck {
    pub reachable: bool,
    pub latency_ms: Option<u32>,
    pub relay_version: Option<String>,
    pub protocol: Option<String>,
    pub do_ok: Option<bool>,
    pub push_configured: Option<bool>,
    pub served_hash: Option<String>,
    pub verdict: BundleVerdict,
    pub sw_matches: Option<bool>,
    pub checked_at: u64,
    /// Problem codes, never free text from the relay.
    pub problems: Vec<String>,
}

/// One plain GET (no body). The implementation adds the redirect, size and time limits of 4.12.5.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub type HttpFuture<'a> = Pin<Box<dyn Future<Output = Result<HttpResponse>> + Send + 'a>>;

/// The only network seam of this crate: tests inject a fake, production uses `net::ReqwestHttp`.
pub trait Http: Send + Sync {
    fn get(&self, req: HttpRequest) -> HttpFuture<'_>;
}

/// Total time for one check (each request has its own 10 s limit in `ReqwestHttp`).
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(30);
const PROTOCOL: &str = "intely.v1";

/// Checks a relay without the Mac credential (see `check_relay_with`).
pub async fn check_relay(base: &str, expected: &Expected, jail: &Jail, http: &dyn Http) -> RelayCheck {
    check_relay_with(base, expected, None, jail, http).await
}

/// Steps: jail and URL rules, `GET /api/status` (falls back to `/api/health`), `GET /bundle.json` verified under `expected.pubkey`,
/// then `/sw.js` and `/index.html` fetched with the headers a browser sends for a service worker script and compared with the
/// manifest. The jail is applied before any request: read-only mode makes no request at all, the E2E jail only loopback ones.
pub async fn check_relay_with(base: &str, expected: &Expected, mac: Option<&MacCredential>, jail: &Jail, http: &dyn Http) -> RelayCheck {
    let mut c = RelayCheck {
        reachable: false,
        latency_ms: None,
        relay_version: None,
        protocol: None,
        do_ok: None,
        push_configured: None,
        served_hash: None,
        verdict: BundleVerdict::Missing,
        sw_matches: None,
        checked_at: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        problems: Vec::new(),
    };
    let origin = match parse_origin(base).and_then(|o| check_jail(jail, &o).map(|_| o)) {
        Ok(o) => o,
        Err(e) => {
            c.problems.push(e.code().to_owned());
            return c;
        }
    };
    let done = tokio::time::timeout(TOTAL_TIMEOUT, run(&origin, expected, mac, http, &mut c)).await;
    if done.is_err() {
        c.problems.push("timeout".to_owned());
    }
    c
}

fn get(base: &str, path: &str, headers: &[(&str, &str)]) -> HttpRequest {
    HttpRequest { url: format!("{base}{path}"), headers: headers.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect() }
}

/// A relay-supplied token (version, protocol) is shown to the user: keep it short and plain.
fn plain(s: &str) -> Option<String> {
    (!s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'+'))).then(|| s.to_owned())
}

fn normalise_hash(h: &str) -> String {
    h.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_lowercase()
}

async fn run(origin: &Origin, expected: &Expected, mac: Option<&MacCredential>, http: &dyn Http, c: &mut RelayCheck) {
    let base = origin.origin();

    // 1. status (or health)
    let mut headers = vec![("accept", "application/json")];
    let bearer;
    if let Some(m) = mac {
        bearer = format!("Bearer {}", m.token.expose());
        headers.push(("authorization", bearer.as_str()));
        headers.push(("x-intely-room", m.room.as_str()));
    }
    let started = Instant::now();
    let mut status_hash: Option<String> = None;
    match http.get(get(&base, "/api/status", &headers)).await {
        Ok(r) if r.status == 200 => {
            c.latency_ms = Some(started.elapsed().as_millis().min(u32::MAX as u128) as u32);
            match serde_json::from_slice::<Value>(&r.body) {
                Ok(v) if v.get("relay").is_some_and(|x| x.is_object()) => {
                    c.reachable = true;
                    c.relay_version = v["relay"]["version"].as_str().and_then(plain);
                    c.protocol = v["relay"]["protocol"].as_str().and_then(plain);
                    c.do_ok = v["do"]["ok"].as_bool();
                    c.push_configured = v["push"]["configured"].as_bool();
                    status_hash = v["bundle"]["hash"].as_str().map(normalise_hash).filter(|h| !h.is_empty());
                    if c.protocol.as_deref() != Some(PROTOCOL) {
                        c.problems.push("protocol".to_owned());
                    }
                    if mac.is_some() && v["auth"].as_bool() != Some(true) {
                        c.problems.push("authRejected".to_owned());
                    }
                }
                _ => {
                    if !health(&base, http, c).await {
                        return;
                    }
                }
            }
        }
        Ok(r) => {
            c.problems.push(if (300..400).contains(&r.status) { "redirect" } else { "httpStatus" }.to_owned());
            if !health(&base, http, c).await {
                return;
            }
        }
        Err(e) => {
            c.problems.push(e.code().to_owned());
            return;
        }
    }

    // 2. the bundle manifest, as the phone fetches it
    let manifest = match http.get(get(&base, "/bundle.json", &[("accept", "application/json"), ("cache-control", "no-store")])).await {
        Ok(r) if r.status == 200 => r,
        Ok(r) => {
            c.problems.push(if (300..400).contains(&r.status) { "redirect" } else { "bundleMissing" }.to_owned());
            return;
        }
        Err(e) => {
            c.problems.push(e.code().to_owned());
            return;
        }
    };
    let text = String::from_utf8_lossy(&manifest.body).into_owned();
    if let Some(pin) = expected.pubkey.as_deref() {
        if b64u_bytes(pin, 32).is_none() {
            c.verdict = BundleVerdict::KeyMismatch;
            c.problems.push("badExpectedKey".to_owned());
            return;
        }
    }
    let verified = match verify_manifest_str(&text, &VerifyOpts { pin: expected.pubkey.as_deref(), min_seq: expected.min_seq, allow_v1: false }) {
        Ok(v) => v,
        Err(f) => {
            c.served_hash = served_hash_of(&text);
            c.verdict = match f.code {
                FailCode::Format => {
                    c.problems.push("bundleFormat".to_owned());
                    BundleVerdict::BadSignature
                }
                FailCode::V1Refused => {
                    c.problems.push("bundleV1".to_owned());
                    BundleVerdict::BadSignature
                }
                FailCode::KeyMismatch => BundleVerdict::KeyMismatch,
                FailCode::HashMismatch => {
                    c.problems.push("manifestHash".to_owned());
                    BundleVerdict::HashMismatch
                }
                FailCode::BadSignature => BundleVerdict::BadSignature,
                FailCode::Rollback => BundleVerdict::Rollback,
            };
            return;
        }
    };
    c.served_hash = Some(verified.hash.clone());
    c.verdict = match expected.hash.as_deref().map(normalise_hash) {
        Some(h) if h != verified.hash => BundleVerdict::HashMismatch,
        _ if expected.pubkey.is_some() => BundleVerdict::Ok,
        _ => BundleVerdict::Observed,
    };
    if status_hash.as_ref().is_some_and(|h| *h != verified.hash) {
        c.problems.push("statusHashDiffers".to_owned());
    }

    // 3. sw.js and index.html with the headers a browser sends for a service worker script
    let sw_ok = served_file_matches(&base, "sw.js", &verified, http, c).await;
    let index_ok = served_file_matches(&base, "index.html", &verified, http, c).await;
    c.sw_matches = Some(sw_ok && index_ok);
    if !(sw_ok && index_ok) && matches!(c.verdict, BundleVerdict::Ok | BundleVerdict::Observed) {
        c.verdict = BundleVerdict::HashMismatch;
    }
}

async fn health(base: &str, http: &dyn Http, c: &mut RelayCheck) -> bool {
    let started = Instant::now();
    match http.get(get(base, "/api/health", &[("accept", "application/json")])).await {
        Ok(r) if r.status == 200 && serde_json::from_slice::<Value>(&r.body).is_ok_and(|v| v["ok"].as_bool() == Some(true)) => {
            c.reachable = true;
            c.latency_ms.get_or_insert(started.elapsed().as_millis().min(u32::MAX as u128) as u32);
            c.problems.push("statusMissing".to_owned());
            true
        }
        Ok(_) => {
            c.problems.push("unreachable".to_owned());
            false
        }
        Err(e) => {
            c.problems.push(e.code().to_owned());
            false
        }
    }
}

fn served_hash_of(text: &str) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    let h = v.get("manifestSha256")?.as_str()?;
    (h.len() == 64 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))).then(|| h.to_owned())
}

async fn served_file_matches(base: &str, name: &str, manifest: &Verified, http: &dyn Http, c: &mut RelayCheck) -> bool {
    let code = if name == "sw.js" { "swMismatch" } else { "indexMismatch" };
    let Some(entry) = manifest.files.iter().find(|f| f.path == name) else {
        c.problems.push(code.to_owned());
        return false;
    };
    let headers = [("Service-Worker", "script"), ("Sec-Fetch-Dest", "serviceworker"), ("Accept", "*/*")];
    // The relay serves the page at "/": its asset config (auto-trailing-slash) redirects "/index.html" there.
    let url_path = if name == "index.html" { "/".to_owned() } else { format!("/{name}") };
    match http.get(get(base, &url_path, &headers)).await {
        Ok(r) if r.status == 200 => {
            let ok = r.body.len() as u64 == entry.size && sha256_hex(&r.body) == entry.sha256;
            if !ok {
                c.problems.push(code.to_owned());
            }
            ok
        }
        Ok(_) => {
            c.problems.push(code.to_owned());
            false
        }
        Err(e) => {
            c.problems.push(e.code().to_owned());
            false
        }
    }
}
