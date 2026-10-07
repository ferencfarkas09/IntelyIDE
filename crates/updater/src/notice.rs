//! Update NOTIFICATION: "is a newer release published?" and nothing more. Self-contained: it shares nothing with the verified
//! install engine (no gate, keys, feed or download). One HTTPS GET to the releases list of the project on `api.github.com`,
//! no credentials, no header except `Accept` and `User-Agent`, 5 s connect / 15 s total, 1 MiB body cap, redirects only to the
//! same host over https. Answers are never installed or downloaded; the app opens the release page and the user installs the DMG.
//!
//! The Tauri glue (scheduler, settings, events) lives in `src-tauri/src/modules/updates.rs`. This module never reads the
//! environment; the endpoint is a parameter so tests can point it at a loopback stub.

use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The only production endpoint.
pub const ENDPOINT: &str = "https://api.github.com/repos/ferencfarkas09/IntelyIDE/releases?per_page=10";
const API_HOST: &str = "api.github.com";
const RELEASE_URL_PREFIX: &str = "https://github.com/ferencfarkas09/IntelyIDE/releases/";
pub const BODY_CAP: usize = 1024 * 1024;
pub const NOTES_CAP: usize = 8 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(15);
pub const INTERVAL_SECS: u64 = 24 * 3600;
pub const ERROR_BACKOFF_SECS: u64 = 3600;

/// `1.2.3` or `1.2.3-alpha.1` (no leading `v`, no build metadata), by semver precedence rules.
pub fn parse_version(s: &str) -> Option<Version> {
    if s.contains('+') {
        return None;
    }
    Version::parse(s).ok()
}

/// The tag shape `^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`, parsed.
pub fn parse_tag(tag: &str) -> Option<Version> {
    parse_version(tag.strip_prefix('v')?)
}

/// Release pages only: the answer is an error when the link points anywhere else.
pub fn valid_release_url(url: &str) -> bool {
    url.starts_with(RELEASE_URL_PREFIX) && url.len() <= 512 && url.bytes().all(|b| b.is_ascii_graphic()) && !url.contains("..")
}

/// Plain text, at most `NOTES_CAP` bytes (cut at a character boundary), carriage returns and control characters dropped.
pub fn truncate_notes(body: &str) -> String {
    let mut out = String::new();
    for c in body.chars() {
        if c == '\r' || (c.is_control() && c != '\n' && c != '\t') {
            continue;
        }
        if out.len() + c.len_utf8() > NOTES_CAP {
            break;
        }
        out.push(c);
    }
    out.trim().to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Latest {
    pub version: String,
    pub tag: String,
    pub url: String,
    pub published_at: String,
    pub prerelease: bool,
    pub notes: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dmg_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dmg_bytes: Option<u64>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    #[serde(default)]
    size: u64,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<Asset>,
}

/// The highest valid, non-draft release. Entries that do not parse are skipped. `Ok(None)` when there is none.
/// An error code (`badUrl`) when the winner's page is not on the project's release pages.
pub fn select_latest(releases: &[Value]) -> Result<Option<(Version, Latest)>, &'static str> {
    let best = releases
        .iter()
        .filter_map(|v| serde_json::from_value::<Release>(v.clone()).ok())
        .filter(|r| !r.draft)
        .filter_map(|r| parse_tag(&r.tag_name).map(|v| (v, r)))
        .max_by(|a, b| a.0.cmp(&b.0));
    let Some((version, r)) = best else { return Ok(None) };
    if !valid_release_url(&r.html_url) {
        return Err("badUrl");
    }
    let dmg = r.assets.iter().find(|a| a.name.to_ascii_lowercase().ends_with(".dmg"));
    let latest = Latest {
        version: r.tag_name.trim_start_matches('v').to_owned(),
        tag: r.tag_name.clone(),
        url: r.html_url.clone(),
        published_at: r.published_at.clone().unwrap_or_default().chars().take(40).collect(),
        prerelease: r.prerelease,
        notes: truncate_notes(r.body.as_deref().unwrap_or("")),
        dmg_name: dmg.map(|a| a.name.chars().take(200).collect()),
        dmg_bytes: dmg.map(|a| a.size).filter(|s| *s > 0),
    };
    Ok(Some((version, latest)))
}

/// What a response body means for the running version: `Some` carries the newer release, `None` means up to date.
pub fn evaluate(body: &[u8], current: &Version) -> Result<Option<Latest>, &'static str> {
    let list: Vec<Value> = serde_json::from_slice(body).map_err(|_| "badResponse")?;
    Ok(select_latest(&list)?.and_then(|(v, latest)| (v > *current).then_some(latest)))
}

/// How long to wait before the next automatic check: 24 h (+ jitter) after the last good check, 1 h after an error, at once
/// when there has never been a check.
pub fn next_wait(now: u64, last_checked: Option<u64>, error_at: Option<u64>, jitter: u64) -> Duration {
    let due = match (error_at, last_checked) {
        (Some(e), l) if l.map_or(true, |l| e >= l) => e + ERROR_BACKOFF_SECS,
        (_, Some(l)) => l + INTERVAL_SECS + jitter,
        (_, None) => now,
    };
    Duration::from_secs(due.saturating_sub(now))
}

fn net_code(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        "timeout"
    } else {
        "network"
    }
}

async fn fetch(endpoint: &str, current: &str) -> Result<Vec<u8>, &'static str> {
    // Redirects stay on api.github.com over https (GitHub answers 301 for a renamed repository); anything else is an answer, not a hop.
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        let same_host = attempt.url().scheme() == "https" && attempt.url().host_str() == Some(API_HOST);
        if same_host && attempt.previous().len() < 3 {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });
    let client = reqwest::Client::builder()
        .redirect(policy)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TOTAL_TIMEOUT)
        .user_agent(format!("IntelyIDE/{current}"))
        .build()
        .map_err(|_| "network")?;
    let mut resp = client.get(endpoint).header("Accept", "application/vnd.github+json").send().await.map_err(|e| net_code(&e))?;
    match resp.status().as_u16() {
        200 => {}
        403 | 429 => return Err("rateLimited"),
        _ => return Err("http"),
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| net_code(&e))? {
        if body.len() + chunk.len() > BODY_CAP {
            return Err("tooLarge");
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// One check against `endpoint` (production: [`ENDPOINT`]). `Ok(Some)` = a strictly newer release exists, `Ok(None)` = up to date.
/// Error codes: `badVersion`, `network`, `timeout`, `rateLimited`, `http`, `tooLarge`, `badResponse`, `badUrl`.
pub async fn check(endpoint: &str, current: &str) -> Result<Option<Latest>, &'static str> {
    let current_version = parse_version(current).ok_or("badVersion")?;
    let body = fetch(endpoint, current).await?;
    evaluate(&body, &current_version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cmp::Ordering;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    fn v(s: &str) -> Version {
        parse_version(s).unwrap()
    }

    #[test]
    fn semver_orders_numbers_and_prereleases() {
        assert!(v("0.1.1") > v("0.1.0"));
        assert!(v("0.10.0") > v("0.9.9"));
        assert!(v("1.0.0") > v("1.0.0-rc.1"));
        assert!(v("1.0.0-alpha") < v("1.0.0-alpha.1"));
        assert!(v("1.0.0-alpha.1") < v("1.0.0-alpha.beta"));
        assert!(v("1.0.0-alpha.beta") < v("1.0.0-beta"));
        assert!(v("1.0.0-beta.2") < v("1.0.0-beta.11"));
        assert!(v("1.0.0-rc.1") > v("1.0.0-beta.11"));
        assert_eq!(v("0.1.0").cmp(&v("0.1.0")), Ordering::Equal);
        assert!(v("0.1.0-alpha.1") < v("0.1.0"));
    }

    #[test]
    fn versions_and_tags_are_validated() {
        for bad in ["", "1", "1.2", "1.2.3.4", "1.2.x", "1.2.3-", "1.2.3-a..b", "1.2.3+build", "-1.2.3", "1.2.3-a_b", "99999999999999999999.0.0"] {
            assert!(parse_version(bad).is_none(), "{bad}");
        }
        assert!(parse_tag("v0.1.0").is_some());
        assert!(parse_tag("v0.1.0-alpha.2").is_some());
        for bad in ["0.1.0", "V0.1.0", "v0.1", "release-1", "v0.1.0+x", "vv0.1.0"] {
            assert!(parse_tag(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn release_urls_must_be_project_release_pages() {
        assert!(valid_release_url("https://github.com/ferencfarkas09/IntelyIDE/releases/tag/v0.1.1"));
        for bad in [
            "http://github.com/ferencfarkas09/IntelyIDE/releases/tag/v1",
            "https://github.com/ferencfarkas09/Other/releases/tag/v1",
            "https://github.com.evil.test/ferencfarkas09/IntelyIDE/releases/",
            "https://github.com/ferencfarkas09/IntelyIDE/releases/../../x",
            "https://github.com/ferencfarkas09/IntelyIDE/releases/ tag",
            "javascript:alert(1)",
            "",
        ] {
            assert!(!valid_release_url(bad), "{bad}");
        }
    }

    #[test]
    fn notes_are_capped_on_a_char_boundary_and_stripped() {
        assert_eq!(truncate_notes("a\r\nb\u{7}c"), "a\nbc");
        let long = "é".repeat(NOTES_CAP);
        let cut = truncate_notes(&long);
        assert!(cut.len() <= NOTES_CAP && cut.len() > NOTES_CAP - 2);
        assert!(cut.chars().all(|c| c == 'é'));
    }

    fn rel(tag: &str, draft: bool, pre: bool) -> Value {
        json!({
            "tag_name": tag, "draft": draft, "prerelease": pre,
            "html_url": format!("https://github.com/ferencfarkas09/IntelyIDE/releases/tag/{tag}"),
            "published_at": "2026-10-06T10:00:00Z", "body": "Notes <b>x</b>",
            "assets": [{ "name": "notes.txt", "size": 3 }, { "name": "IntelyIDE_0.1.1.dmg", "size": 12345 }]
        })
    }

    #[test]
    fn selection_picks_the_highest_valid_non_draft() {
        let list = vec![rel("v0.1.0", false, true), rel("v0.2.0", true, false), rel("nightly", false, true), rel("v0.1.1-alpha.2", false, true), rel("v0.1.1-alpha.10", false, true), json!({ "nope": 1 })];
        let (ver, latest) = select_latest(&list).unwrap().unwrap();
        assert_eq!(ver, v("0.1.1-alpha.10"));
        assert_eq!(latest.version, "0.1.1-alpha.10");
        assert!(latest.prerelease);
        assert_eq!(latest.dmg_name.as_deref(), Some("IntelyIDE_0.1.1.dmg"));
        assert_eq!(latest.dmg_bytes, Some(12345));
        assert_eq!(latest.notes, "Notes <b>x</b>");
        assert!(select_latest(&[rel("v1.0.0", true, false)]).unwrap().is_none());
        assert!(select_latest(&[]).unwrap().is_none());
    }

    #[test]
    fn selection_refuses_a_foreign_url() {
        let mut r = rel("v0.1.1", false, false);
        r["html_url"] = json!("https://example.com/ferencfarkas09/IntelyIDE/releases/tag/v0.1.1");
        assert_eq!(select_latest(&[r]).unwrap_err(), "badUrl");
    }

    #[test]
    fn available_only_when_strictly_greater() {
        let body = serde_json::to_vec(&vec![rel("v0.1.0", false, true), rel("v0.1.1", false, true)]).unwrap();
        assert_eq!(evaluate(&body, &v("0.1.0")).unwrap().unwrap().version, "0.1.1");
        assert!(evaluate(&body, &v("0.1.1")).unwrap().is_none());
        assert!(evaluate(&body, &v("0.2.0")).unwrap().is_none());
        assert_eq!(evaluate(b"{}", &v("0.1.0")).unwrap_err(), "badResponse");
        assert_eq!(evaluate(b"nope", &v("0.1.0")).unwrap_err(), "badResponse");
    }

    #[test]
    fn schedule_waits_24h_then_1h_after_an_error() {
        assert_eq!(next_wait(1000, None, None, 5), Duration::ZERO);
        assert_eq!(next_wait(1000, Some(900), None, 60), Duration::from_secs(900 + INTERVAL_SECS + 60 - 1000));
        assert_eq!(next_wait(1000, Some(900), Some(950), 60), Duration::from_secs(950 + ERROR_BACKOFF_SECS - 1000));
        // an error older than the last good check does not count
        assert_eq!(next_wait(1000, Some(990), Some(950), 0), Duration::from_secs(990 + INTERVAL_SECS - 1000));
        assert_eq!(next_wait(10 * INTERVAL_SECS, Some(5), None, 0), Duration::ZERO);
    }

    // -- loopback stub ---------------------------------------------------------------------------------------------

    /// Serves `responses` in order, one per connection, and returns the URL and the request heads it saw.
    fn stub(responses: Vec<Vec<u8>>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/repos/ferencfarkas09/IntelyIDE/releases?per_page=10", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        std::thread::spawn(move || {
            for resp in responses {
                let Ok((mut s, _)) = listener.accept() else { return };
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                log.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).into_owned());
                let _ = s.write_all(&resp);
            }
        });
        (url, seen)
    }

    fn http(status: &str, body: &[u8]) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
        out.extend_from_slice(body);
        out
    }

    #[tokio::test]
    async fn a_check_sends_only_accept_and_user_agent_and_reports_available() {
        let body = serde_json::to_vec(&vec![rel("v0.1.0", false, true), rel("v0.1.1", false, true)]).unwrap();
        let (url, seen) = stub(vec![http("200 OK", &body)]);
        let latest = check(&url, "0.1.0").await.unwrap().unwrap();
        assert_eq!(latest.version, "0.1.1");
        let head = seen.lock().unwrap()[0].to_ascii_lowercase();
        assert!(head.starts_with("get /repos/ferencfarkas09/intelyide/releases?per_page=10 "));
        assert!(head.contains("user-agent: intelyide/0.1.0"));
        assert!(head.contains("accept: application/vnd.github+json"));
        assert!(!head.contains("authorization") && !head.contains("cookie"));
        let json = serde_json::to_value(&latest).unwrap();
        assert_eq!(json["publishedAt"], "2026-10-06T10:00:00Z");
        assert_eq!(json["dmgBytes"], 12345);
    }

    #[tokio::test]
    async fn up_to_date_and_error_answers() {
        let body = serde_json::to_vec(&vec![rel("v0.1.0", false, true)]).unwrap();
        let (url, _) = stub(vec![http("200 OK", &body), http("403 Forbidden", b"{}"), http("500 Oops", b"{}"), http("200 OK", b"[1,")]);
        assert_eq!(check(&url, "0.1.0").await, Ok(None));
        assert_eq!(check(&url, "0.1.0").await, Err("rateLimited"));
        assert_eq!(check(&url, "0.1.0").await, Err("http"));
        assert_eq!(check(&url, "0.1.0").await, Err("badResponse"));
        assert_eq!(check(&url, "nope").await, Err("badVersion"));
    }

    #[tokio::test]
    async fn an_oversized_body_is_refused() {
        let (url, _) = stub(vec![http("200 OK", &vec![b' '; BODY_CAP + 10])]);
        assert_eq!(check(&url, "0.1.0").await, Err("tooLarge"));
    }

    #[tokio::test]
    async fn a_redirect_off_host_is_not_followed() {
        let redirect = b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/evil\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
        let (url, _) = stub(vec![redirect]);
        assert_eq!(check(&url, "0.1.0").await, Err("http"));
    }
}
