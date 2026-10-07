//! `check_relay` against a scripted fake `Http` (no sockets): verdicts, the jail gate, status/health fallback and the headers a browser
//! sends for a service worker. The relay serves the committed bundle-v2 vector site, signed with the public test key A.

mod common;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use common::*;
use intely_core::jail::Jail;
use intely_relay_bundle::manifest::Json;
use intely_relay_bundle::{check_relay, check_relay_with, BundleError, BundleVerdict, Expected, MacCredential, RelayCheck, Secret};

const TOKEN: &str = "mac-room-token-0123456789";
const ROOM: &str = "room-abcdef0123456789";

#[derive(Clone, Default)]
struct Relay {
    /// path -> body (includes /bundle.json, /sw.js, /index.html)
    site: BTreeMap<String, Vec<u8>>,
    /// served instead of /sw.js when the request carries the `Service-Worker` header
    sw_for_worker: Option<Vec<u8>>,
    no_status: bool,
    status_text: Option<String>,
    fail_all: Option<&'static str>,
    status_code: Option<u16>,
    bundle_code: Option<u16>,
    version: Option<String>,
}

fn genuine() -> Relay {
    let v = vectors();
    let mut site: BTreeMap<String, Vec<u8>> = site_files(&v).into_iter().map(|(p, b)| (format!("/{p}"), b)).collect();
    site.insert("/bundle.json".into(), jstr(v.get("valid").unwrap(), "bundleJson").into_bytes());
    Relay { site, ..Default::default() }
}

fn with_bundle(mut r: Relay, bundle_json: String) -> Relay {
    r.site.insert("/bundle.json".into(), bundle_json.into_bytes());
    r
}

fn serve(r: Relay) -> Arc<FakeHttp> {
    let valid_hash = jstr(vectors().get("valid").unwrap(), "manifestSha256");
    Arc::new(FakeHttp::new(move |req| {
        if let Some(code) = r.fail_all {
            return Err(BundleError::Net(code));
        }
        let path = path_of(req);
        // auto-trailing-slash: the page lives at "/", "/index.html" is a redirect
        if path == "/index.html" {
            return Ok(status(307));
        }
        let path = if path == "/" { "/index.html".to_owned() } else { path };
        match path.as_str() {
            "/api/status" => {
                if let Some(code) = r.status_code {
                    return Ok(status(code));
                }
                if r.no_status {
                    return Ok(status(404));
                }
                if let Some(t) = &r.status_text {
                    return Ok(ok(t.clone()));
                }
                let auth = header(req, "authorization") == Some(&format!("Bearer {TOKEN}")) && header(req, "x-intely-room") == Some(ROOM);
                let mut body = serde_json::json!({
                    "ok": true, "auth": auth,
                    "relay": { "version": r.version.clone().unwrap_or_else(|| "0.0.0".into()), "protocol": "intely.v1", "codeHash": "c", "stamp": "s" },
                    "bundle": { "hash": valid_hash }, "push": { "configured": false }, "now": 1
                });
                if auth {
                    body["do"] = serde_json::json!({ "ok": true });
                }
                Ok(ok(body.to_string()))
            }
            "/api/health" => Ok(ok(r#"{"ok":true}"#)),
            "/bundle.json" if r.bundle_code.is_some() => Ok(status(r.bundle_code.unwrap())),
            "/sw.js" if header(req, "service-worker").is_some() && r.sw_for_worker.is_some() => Ok(ok(r.sw_for_worker.clone().unwrap())),
            p => Ok(r.site.get(p).map(|b| ok(b.clone())).unwrap_or_else(|| status(404))),
        }
    }))
}

fn expected(v: &Json) -> Expected {
    Expected { hash: Some(jstr(v.get("valid").unwrap(), "manifestSha256")), pubkey: Some(vector_pub(v, "A")), min_seq: None }
}

async fn check(relay: Relay, exp: &Expected) -> (RelayCheck, Arc<FakeHttp>) {
    let http = serve(relay);
    let c = check_relay("https://relay.example.com", exp, &Jail::off(), http.as_ref()).await;
    (c, http)
}

#[tokio::test]
async fn a_genuine_relay_is_ok_and_reports_status_fields() {
    let v = vectors();
    let (c, http) = check(Relay { version: Some("1.2.3".into()), ..genuine() }, &expected(&v)).await;
    assert!(c.reachable, "{c:?}");
    assert_eq!(c.verdict, BundleVerdict::Ok);
    assert_eq!(c.relay_version.as_deref(), Some("1.2.3"));
    assert_eq!(c.protocol.as_deref(), Some("intely.v1"));
    assert_eq!(c.push_configured, Some(false));
    assert_eq!(c.do_ok, None, "no Mac credential, no Durable Object payload");
    assert_eq!(c.sw_matches, Some(true));
    assert_eq!(c.served_hash.as_deref(), Some(expected(&v).hash.unwrap().as_str()));
    assert!(c.latency_ms.is_some() && c.checked_at > 1_700_000_000);
    assert!(c.problems.is_empty(), "{:?}", c.problems);
    // order and URLs: status first, then the manifest, then the two files; everything on the same origin
    assert_eq!(
        http.paths(),
        ["/api/status", "/bundle.json", "/sw.js", "/"].map(|p| format!("https://relay.example.com{p}")).to_vec()
    );
}

#[tokio::test]
async fn the_service_worker_fetch_carries_the_browser_headers() {
    let v = vectors();
    let (_, http) = check(genuine(), &expected(&v)).await;
    let reqs = http.requests();
    let sw = reqs.iter().find(|r| r.url.ends_with("/sw.js")).unwrap();
    assert_eq!(header(sw, "Service-Worker"), Some("script"));
    assert_eq!(header(sw, "Sec-Fetch-Dest"), Some("serviceworker"));
    assert_eq!(header(sw, "Accept"), Some("*/*"));
    assert!(reqs.iter().all(|r| header(r, "authorization").is_none()), "no credential unless the caller gave one");
}

#[tokio::test]
async fn the_mac_credential_adds_the_durable_object_check_and_never_leaks() {
    let v = vectors();
    let http = serve(genuine());
    let mac = MacCredential { room: ROOM.into(), token: Secret::new(TOKEN) };
    let c = check_relay_with("https://relay.example.com", &expected(&v), Some(&mac), &Jail::off(), http.as_ref()).await;
    assert_eq!(c.do_ok, Some(true));
    assert!(c.problems.is_empty(), "{:?}", c.problems);
    assert!(!format!("{c:?}").contains(TOKEN));
    // only the status request carries the credential
    let with_auth: Vec<_> = http.requests().into_iter().filter(|r| header(r, "authorization").is_some()).map(|r| path_of(&r)).collect();
    assert_eq!(with_auth, ["/api/status"]);
    // a wrong token looks like no token to the relay and is reported as a problem code
    let bad = MacCredential { room: ROOM.into(), token: Secret::new("wrong") };
    let c = check_relay_with("https://relay.example.com", &expected(&v), Some(&bad), &Jail::off(), serve(genuine()).as_ref()).await;
    assert_eq!(c.do_ok, None);
    assert!(c.problems.contains(&"authRejected".to_string()), "{:?}", c.problems);
}

#[tokio::test]
async fn without_a_pinned_key_the_verdict_is_observed_and_a_wrong_expected_hash_is_a_mismatch() {
    let v = vectors();
    let (c, _) = check(genuine(), &Expected::default()).await;
    assert_eq!(c.verdict, BundleVerdict::Observed);
    assert!(c.served_hash.is_some());
    let only_hash = Expected { hash: Some(jstr(v.get("valid").unwrap(), "manifestSha256")), ..Default::default() };
    assert_eq!(check(genuine(), &only_hash).await.0.verdict, BundleVerdict::Observed);
    // grouped / upper case hash text still compares equal
    let grouped = Expected { hash: Some(only_hash.hash.clone().unwrap().to_uppercase().as_bytes().chunks(4).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join(" ")), ..Default::default() };
    assert_eq!(check(genuine(), &grouped).await.0.verdict, BundleVerdict::Observed);
    let wrong = Expected { hash: Some("0".repeat(64)), pubkey: Some(vector_pub(&v, "A")), min_seq: None };
    let (c, _) = check(genuine(), &wrong).await;
    assert_eq!(c.verdict, BundleVerdict::HashMismatch);
    assert_eq!(c.served_hash, expected(&v).hash, "the served hash is still reported");
    assert_eq!(check(genuine(), &Expected { hash: Some("0".repeat(64)), ..Default::default() }).await.0.verdict, BundleVerdict::HashMismatch);
}

#[tokio::test]
async fn tampered_bundles_get_the_right_verdict() {
    let v = vectors();
    let Some(Json::Arr(cases)) = v.get("cases") else { panic!() };
    let by_name = |n: &str| cases.iter().find(|c| jstr(c, "name") == n).unwrap_or_else(|| panic!("no case {n}"));
    let bundle_of = |n: &str| serde_json::to_string(by_name(n).get("bundle").unwrap()).unwrap();
    let pin = vector_pub(&v, "A");
    let exp = Expected { hash: None, pubkey: Some(pin.clone()), min_seq: None };
    for (case, want, problem) in [
        ("tamper-seq-up", BundleVerdict::BadSignature, None),
        ("tamper-sig-last-byte", BundleVerdict::BadSignature, None),
        ("signed-by-other-key-pinned", BundleVerdict::KeyMismatch, None),
        ("pubkey-swapped-and-resigned-pinned", BundleVerdict::KeyMismatch, None),
        ("tamper-manifest-sha256", BundleVerdict::HashMismatch, Some("manifestHash")),
        ("v1-refused", BundleVerdict::BadSignature, Some("bundleV1")),
        ("path-parent-traversal", BundleVerdict::BadSignature, Some("bundleFormat")),
    ] {
        let (c, _) = check(with_bundle(genuine(), bundle_of(case)), &exp).await;
        assert!(c.reachable);
        assert_eq!(c.verdict, want, "{case}: {c:?}");
        if let Some(p) = problem {
            assert!(c.problems.contains(&p.to_string()), "{case}: {:?}", c.problems);
        }
        assert_eq!(c.sw_matches, None, "{case}: files of an untrusted manifest are not compared");
    }
    // rollback: the genuine manifest is older than the lowest acceptable seq
    let seq = v.get("seq").and_then(Json::as_u64).unwrap();
    let (c, _) = check(genuine(), &Expected { min_seq: Some(seq + 1), ..exp.clone() }).await;
    assert_eq!(c.verdict, BundleVerdict::Rollback);
    let (c, _) = check(genuine(), &Expected { min_seq: Some(seq), ..exp.clone() }).await;
    assert_eq!(c.verdict, BundleVerdict::Ok, "equal is accepted");
    // the expected key itself is malformed: fail closed
    let (c, _) = check(genuine(), &Expected { pubkey: Some("AAAA".into()), ..Default::default() }).await;
    assert_eq!(c.verdict, BundleVerdict::KeyMismatch);
    assert!(c.problems.contains(&"badExpectedKey".to_string()));
}

#[tokio::test]
async fn a_missing_or_broken_bundle_is_reported() {
    let v = vectors();
    let exp = expected(&v);
    let (c, _) = check(Relay { bundle_code: Some(404), ..genuine() }, &exp).await;
    assert_eq!((c.reachable, c.verdict.clone()), (true, BundleVerdict::Missing));
    assert!(c.problems.contains(&"bundleMissing".to_string()));
    let (c, _) = check(Relay { bundle_code: Some(302), ..genuine() }, &exp).await;
    assert_eq!(c.verdict, BundleVerdict::Missing);
    assert!(c.problems.contains(&"redirect".to_string()));
    let (c, _) = check(with_bundle(genuine(), "<html>not json</html>".into()), &exp).await;
    assert_eq!(c.verdict, BundleVerdict::BadSignature);
    assert!(c.problems.contains(&"bundleFormat".to_string()));
    assert_eq!(c.served_hash, None);
}

#[tokio::test]
async fn sw_js_that_differs_only_for_service_worker_fetches_is_caught() {
    let v = vectors();
    let exp = expected(&v);
    let evil = Relay { sw_for_worker: Some(b"self.addEventListener('fetch',()=>{});".to_vec()), ..genuine() };
    let (c, http) = check(evil.clone(), &exp).await;
    assert_eq!(c.sw_matches, Some(false));
    assert!(c.problems.contains(&"swMismatch".to_string()), "{:?}", c.problems);
    assert_eq!(c.verdict, BundleVerdict::HashMismatch, "the phone would refuse these bytes");
    assert!(http.requests().iter().any(|r| header(r, "service-worker").is_some()));
    // the same server answers a plain fetch (no Service-Worker header) with the genuine file: the fake does tell them apart
    let plain = serve(evil);
    let r = intely_relay_bundle::Http::get(plain.as_ref(), intely_relay_bundle::HttpRequest { url: "https://relay.example.com/sw.js".into(), headers: vec![] }).await.unwrap();
    assert_eq!(r.body, site_files(&v)["sw.js"]);
    // index.html differing
    let mut r = genuine();
    r.site.insert("/index.html".into(), b"<html>other</html>".to_vec());
    let (c, _) = check(r, &exp).await;
    assert_eq!(c.sw_matches, Some(false));
    assert!(c.problems.contains(&"indexMismatch".to_string()));
    // sw.js 404
    let mut r = genuine();
    r.site.remove("/sw.js");
    let (c, _) = check(r, &exp).await;
    assert_eq!(c.sw_matches, Some(false));
}

#[tokio::test]
async fn a_relay_without_status_falls_back_to_health() {
    let v = vectors();
    let (c, http) = check(Relay { no_status: true, ..genuine() }, &expected(&v)).await;
    assert!(c.reachable);
    assert_eq!(c.relay_version, None);
    assert_eq!(c.protocol, None);
    assert!(c.problems.contains(&"httpStatus".to_string()) && c.problems.contains(&"statusMissing".to_string()), "{:?}", c.problems);
    assert_eq!(c.verdict, BundleVerdict::Ok, "the bundle is still checked");
    assert!(http.paths()[1].ends_with("/api/health"));
    // a 200 that is not a status document also falls back
    let (c, _) = check(Relay { status_text: Some("<html>hello</html>".into()), ..genuine() }, &expected(&v)).await;
    assert!(c.reachable && c.problems.contains(&"statusMissing".to_string()));
    // neither works: unreachable, and the bundle is not fetched
    let http = Arc::new(FakeHttp::new(|_| Ok(status(404))));
    let c = check_relay("https://relay.example.com", &Expected::default(), &Jail::off(), http.as_ref()).await;
    assert!(!c.reachable);
    assert_eq!(c.verdict, BundleVerdict::Missing);
    assert!(c.problems.contains(&"unreachable".to_string()));
    assert_eq!(http.requests().len(), 2, "status and health only");
}

#[tokio::test]
async fn transport_errors_are_reported_by_code_and_stop_the_check() {
    for code in ["timeout", "network", "tooLarge", "privateAddress"] {
        let (c, http) = check(Relay { fail_all: Some(code), ..genuine() }, &Expected::default()).await;
        assert!(!c.reachable);
        assert_eq!(c.problems, vec![code.to_string()]);
        assert_eq!(http.requests().len(), 1, "no second attempt on a transport error");
    }
    let (c, _) = check(Relay { status_code: Some(302), ..genuine() }, &Expected::default()).await;
    assert!(c.problems.contains(&"redirect".to_string()));
}

#[tokio::test]
async fn relay_supplied_text_is_sanitised() {
    for evil in ["1.0 <script>", &"9".repeat(65), "", "line\nbreak"] {
        let (c, _) = check(Relay { version: Some(evil.to_string()), ..genuine() }, &Expected::default()).await;
        assert_eq!(c.relay_version, None, "{evil:?}");
        assert!(c.reachable);
    }
}

#[tokio::test]
async fn read_only_mode_makes_no_request_at_all() {
    let http = serve(genuine());
    for base in ["https://relay.example.com", "http://127.0.0.1:8787", "wss://relay.example.com"] {
        let c = check_relay(base, &Expected::default(), &Jail::read_only(), http.as_ref()).await;
        assert_eq!(c.problems, vec!["readOnly".to_string()], "{base}");
        assert!(!c.reachable);
    }
    assert!(http.requests().is_empty());
}

#[tokio::test]
async fn the_e2e_jail_allows_loopback_only() {
    let tmp = tempfile::tempdir().unwrap();
    let jail = Jail::e2e(tmp.path());
    let http = serve(genuine());
    for base in ["https://relay.example.com", "https://x.workers.dev", "wss://relay.example.com:8443"] {
        let c = check_relay(base, &Expected::default(), &jail, http.as_ref()).await;
        assert_eq!(c.problems, vec!["testJail".to_string()], "{base}");
    }
    assert!(http.requests().is_empty());
    let c = check_relay("http://127.0.0.1:8787", &Expected::default(), &jail, http.as_ref()).await;
    assert!(c.reachable, "{c:?}");
    assert!(http.paths()[0].starts_with("http://127.0.0.1:8787/api/status"));
    let c = check_relay("ws://localhost:8787", &Expected::default(), &jail, http.as_ref()).await;
    assert!(c.reachable);
}

#[tokio::test]
async fn bad_urls_are_refused_before_any_request() {
    let http = serve(genuine());
    for base in [
        "", "relay.example.com", "ftp://relay.example.com", "http://relay.example.com", "ws://relay.example.com", "https://user@relay.example.com",
        "https://relay.example.com/path", "https://relay.example.com?x=1", "https://relay.example.com#f", "https://1.2.3.4", "https://[::2]",
        "http://127.0.0.2:8080", "http://127.1", "http://0x7f.1", "http://2130706433", "https://relay.example.com\\@evil.com", "https://rela%79.example.com",
        "https://relay.example.com.", "https://foo.localhost", "https://intranet", "https://caf\u{e9}.example", "https://a b.example",
        "https://relay.example.com:0", "https://relay.example.com:99999", "https://relay.example.com:", "https://-a.example.com", "https://a-.example.com",
    ] {
        let c = check_relay(base, &Expected::default(), &Jail::off(), http.as_ref()).await;
        assert!(!c.reachable && c.problems.len() == 1, "{base:?} -> {c:?}");
        let code = &c.problems[0];
        assert!(code == "badUrl", "{base:?} -> {code}");
    }
    assert!(http.requests().is_empty());
}

#[tokio::test]
async fn a_few_urls_are_accepted_and_rebuilt_from_their_parts() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    let http = FakeHttp::new(move |req| {
        s2.lock().unwrap().push(req.url.clone());
        Ok(status(404))
    });
    for (base, first) in [
        ("https://Relay.Example.COM", "https://relay.example.com/api/status"),
        ("wss://relay.example.com/", "https://relay.example.com/api/status"),
        ("https://relay.example.com:8443", "https://relay.example.com:8443/api/status"),
        ("https://relay.example.com:443", "https://relay.example.com/api/status"),
        ("https://my-relay.abc.workers.dev", "https://my-relay.abc.workers.dev/api/status"),
        ("http://localhost:8787", "http://localhost:8787/api/status"),
        ("ws://[::1]:8787", "http://[::1]:8787/api/status"),
    ] {
        seen.lock().unwrap().clear();
        check_relay(base, &Expected::default(), &Jail::off(), &http).await;
        assert_eq!(seen.lock().unwrap()[0], first, "{base}");
    }
}
