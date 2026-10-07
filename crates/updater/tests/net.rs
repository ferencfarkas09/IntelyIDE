//! U2: the network layer against a hostile server, CDN and DNS ((design notes: updater-spec) 10.2 `net`).
//!
//! Real sockets only to a loopback server (`Endpoints::loopback`); the production host rules, the
//! redirect allow-list and the address checks run against a scripted transport and a fake resolver,
//! so no TLS, no network and no real DNS are involved.
mod common;

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::server::{Route, Server};
use intely_relay_bundle::net::Resolver;
use intely_updater::endpoints::Endpoints;
use intely_updater::net::*;
use intely_updater::version::{Arch, Channel};
use intely_updater::{ErrorCode, UpdateError};
use semver::Version;

const MIB: u64 = 1024 * 1024;
const ART_PATH: &str = "/releases/download/v0.1.1/IntelyIDE_0.1.1_x64.app.tar.gz";
const PROD_ART_URL: &str = "https://github.com/ferencfarkas09/IntelyIDE/releases/download/v0.1.1/IntelyIDE_0.1.1_x64.app.tar.gz";

// ------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------

fn quick() -> NetTimeouts {
    NetTimeouts {
        connect: Duration::from_secs(2),
        feed_total: Duration::from_secs(5),
        download_idle: Duration::from_secs(5),
        download_total: Duration::from_secs(60),
    }
}

fn pattern(n: usize, seed: u32) -> Vec<u8> {
    let mut x = seed.wrapping_mul(2654435761).wrapping_add(12345);
    (0..n)
        .map(|_| {
            x = x.wrapping_mul(1664525).wrapping_add(1013904223);
            (x >> 24) as u8
        })
        .collect()
}

fn sha(data: &[u8]) -> String {
    hex::encode(ring::digest::digest(&ring::digest::SHA256, data).as_ref())
}

fn art_for(data: &[u8]) -> ArtifactRef {
    ArtifactRef { version: Version::new(0, 1, 1), arch: Arch::X64, bytes: data.len() as u64, sha256: sha(data) }
}

fn loopback_http(server: &Server, timeouts: NetTimeouts) -> ReqwestUpdateHttp {
    ReqwestUpdateHttp::with_timeouts(Endpoints::loopback(&server.origin()).unwrap(), timeouts)
}

fn feed_json() -> FeedFile {
    FeedFile { base: 0, channel: Channel::Stable, kind: FeedKind::Json }
}

fn feed_sig() -> FeedFile {
    FeedFile { base: 0, channel: Channel::Stable, kind: FeedKind::Sig }
}

async fn dl(h: &dyn UpdateHttp, art: &ArtifactRef, dest: &Path) -> Result<Downloaded, UpdateError> {
    h.download_artifact(art, dest, &Cancel::new(), &|_| {}).await
}

fn code<T: std::fmt::Debug>(r: Result<T, UpdateError>) -> ErrorCode {
    r.expect_err("expected an error").code
}

fn dest_in(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().join("IntelyIDE_0.1.1_x64.app.tar.gz.part")
}

const ALLOWED_HEADERS: [&str; 4] = ["accept", "cache-control", "host", "user-agent"];

fn assert_clean_headers(r: &common::server::Req) {
    for n in r.header_names() {
        assert!(ALLOWED_HEADERS.contains(&n.as_str()), "unexpected request header {n}");
    }
    for bad in ["cookie", "referer", "authorization", "proxy-authorization", "accept-encoding", "origin", "x-forwarded-for"] {
        assert!(r.header(bad).is_none(), "header {bad} must never be sent");
    }
    assert_eq!(r.header("user-agent"), Some("IntelyIDE-updater"));
    assert_eq!(r.header("cache-control"), Some("no-cache"));
    assert!(!r.target.contains('?') || r.path() != "/update/stable.json", "no query on a feed request");
}

// ------------------------------------------------------------------------------------------
// fakes for the production-host tests
// ------------------------------------------------------------------------------------------

#[derive(Default)]
struct FakeResolver {
    answers: Mutex<HashMap<String, VecDeque<std::io::Result<Vec<IpAddr>>>>>,
    calls: Mutex<Vec<String>>,
}

impl FakeResolver {
    fn new() -> Arc<FakeResolver> {
        Arc::new(FakeResolver::default())
    }
    fn answer(&self, host: &str, ips: &[&str]) {
        let v: Vec<IpAddr> = ips.iter().map(|s| s.parse().unwrap()).collect();
        self.answers.lock().unwrap().entry(host.to_string()).or_default().push_back(Ok(v));
    }
    fn fail(&self, host: &str) {
        self.answers.lock().unwrap().entry(host.to_string()).or_default().push_back(Err(std::io::Error::other("nxdomain")));
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl Resolver for FakeResolver {
    fn resolve(&self, host: &str, _port: u16) -> std::io::Result<Vec<IpAddr>> {
        self.calls.lock().unwrap().push(host.to_string());
        let mut map = self.answers.lock().unwrap();
        let q = map.get_mut(host).expect("unexpected resolution");
        // The last answer repeats; earlier ones are consumed (a rebinding script).
        if q.len() > 1 {
            q.pop_front().unwrap()
        } else {
            match q.front().unwrap() {
                Ok(v) => Ok(v.clone()),
                Err(_) => Err(std::io::Error::other("nxdomain")),
            }
        }
    }
}

enum Step {
    Resp { status: u16, headers: Vec<(String, String)>, chunks: Vec<Vec<u8>> },
    Hang,
}

fn ok(body: &[u8]) -> Step {
    Step::Resp { status: 200, headers: vec![], chunks: body.chunks(1000).map(|c| c.to_vec()).collect() }
}

fn redir(status: u16, location: &str) -> Step {
    Step::Resp { status, headers: vec![("location".into(), location.into())], chunks: vec![] }
}

struct SeenHop {
    url: String,
    accept: &'static str,
    pinned: Option<Pinned>,
}

#[derive(Default)]
struct ScriptedTransport {
    steps: Mutex<VecDeque<Step>>,
    seen: Mutex<Vec<SeenHop>>,
}

impl ScriptedTransport {
    fn new(steps: Vec<Step>) -> Arc<ScriptedTransport> {
        Arc::new(ScriptedTransport { steps: Mutex::new(steps.into()), seen: Mutex::new(vec![]) })
    }
    fn seen_urls(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|s| s.url.clone()).collect()
    }
}

struct VecBody(VecDeque<Vec<u8>>);

impl BodyStream for VecBody {
    fn next_chunk<'a>(&'a mut self) -> NetFuture<'a, Option<Vec<u8>>> {
        Box::pin(async move { Ok(self.0.pop_front()) })
    }
}

impl Transport for ScriptedTransport {
    fn send<'a>(&'a self, req: &'a HopRequest) -> NetFuture<'a, HopResponse> {
        Box::pin(async move {
            self.seen.lock().unwrap().push(SeenHop { url: req.url.as_str().to_string(), accept: req.accept, pinned: req.pinned.clone() });
            let step = self.steps.lock().unwrap().pop_front();
            match step {
                None => Err(UpdateError::with(ErrorCode::Offline, "script exhausted")),
                Some(Step::Hang) => std::future::pending().await,
                Some(Step::Resp { status, headers, chunks }) => Ok(HopResponse { status, headers, body: Box::new(VecBody(chunks.into())) }),
            }
        })
    }
}

fn prod_resolver() -> Arc<FakeResolver> {
    let r = FakeResolver::new();
    r.answer("github.com", &["140.82.112.4"]);
    r.answer("release-assets.githubusercontent.com", &["185.199.108.133"]);
    r.answer("objects.githubusercontent.com", &["185.199.109.133"]);
    r.answer("a.b.githubusercontent.com", &["185.199.110.133"]);
    r.answer("ferencfarkas09.github.io", &["185.199.108.153"]);
    r.answer("raw.githubusercontent.com", &["185.199.111.133"]);
    r
}

fn prod_http(resolver: Arc<FakeResolver>, transport: Arc<ScriptedTransport>, timeouts: NetTimeouts) -> ReqwestUpdateHttp {
    ReqwestUpdateHttp::with_parts(Endpoints::production(), resolver, transport, timeouts)
}

fn small_art() -> (Vec<u8>, ArtifactRef) {
    let data = pattern(5000, 7);
    let art = art_for(&data);
    (data, art)
}

// ------------------------------------------------------------------------------------------
// feed requests (loopback server, real transport)
// ------------------------------------------------------------------------------------------

#[tokio::test]
async fn request_headers_are_the_exact_set() {
    let s = Server::start();
    s.route("/update/stable.json", Route::body(b"{}".to_vec()));
    s.route("/update/stable.json.sig", Route::body(b"sig".to_vec()));
    let h = loopback_http(&s, quick());
    let f = h.fetch_feed(feed_json()).await.unwrap();
    assert_eq!((f.status, f.body.as_slice()), (200, &b"{}"[..]));
    let g = h.fetch_feed(feed_sig()).await.unwrap();
    assert_eq!(g.body, b"sig");
    let reqs = s.requests();
    assert_eq!(reqs.len(), 2);
    for r in &reqs {
        assert_eq!(r.method, "GET");
        assert_clean_headers(r);
    }
    assert_eq!(reqs[0].target, "/update/stable.json");
    assert_eq!(reqs[0].header("accept"), Some("application/json"));
    assert_eq!(reqs[1].target, "/update/stable.json.sig");
    assert_eq!(reqs[1].header("accept"), Some("application/octet-stream"));
}

#[tokio::test]
async fn feed_redirect_is_refused_and_never_followed() {
    let s = Server::start();
    for code in [301, 302, 303, 307, 308] {
        s.route("/update/stable.json", Route::redirect(code, &format!("{}/elsewhere", s.origin())));
        s.route("/elsewhere", Route::body(b"{}".to_vec()));
        let h = loopback_http(&s, quick());
        assert_eq!(code_of(h.fetch_feed(feed_json()).await), ErrorCode::RedirectRefused, "status {code}");
    }
    assert_eq!(s.count("/elsewhere"), 0);
}

fn code_of<T: std::fmt::Debug>(r: Result<T, UpdateError>) -> ErrorCode {
    code(r)
}

#[tokio::test]
async fn feed_non_200_is_reported_with_an_empty_body() {
    let s = Server::start();
    let h = loopback_http(&s, quick());
    // No route at all: the server answers 404.
    let f = h.fetch_feed(feed_json()).await.unwrap();
    assert_eq!((f.status, f.body.len()), (404, 0));
    s.route("/update/stable.json", Route::status(503).header("Retry-After", "5"));
    let f = h.fetch_feed(feed_json()).await.unwrap();
    assert_eq!((f.status, f.body.len()), (503, 0));
}

#[tokio::test]
async fn feed_body_cap_at_the_boundary_with_and_without_content_length() {
    let s = Server::start();
    let h = loopback_http(&s, quick());
    let max = 256 * 1024;
    s.route("/update/stable.json", Route::body(vec![b'a'; max]));
    assert_eq!(h.fetch_feed(feed_json()).await.unwrap().body.len(), max);
    s.route("/update/stable.json", Route::body(vec![b'a'; max + 1]));
    assert_eq!(code(h.fetch_feed(feed_json()).await), ErrorCode::FeedTooLarge);
    s.route("/update/stable.json", Route::body(vec![b'a'; max + 1]).chunked());
    assert_eq!(code(h.fetch_feed(feed_json()).await), ErrorCode::FeedTooLarge);
    s.route("/update/stable.json", Route::body(vec![b'a'; max + 1]).close_delimited());
    assert_eq!(code(h.fetch_feed(feed_json()).await), ErrorCode::FeedTooLarge);
    // A lying Content-Length above the cap is refused before the body is read.
    s.route("/update/stable.json", Route::status(200).claim_length(10 * MIB));
    assert_eq!(code(h.fetch_feed(feed_json()).await), ErrorCode::FeedTooLarge);

    s.route("/update/stable.json.sig", Route::body(vec![b'a'; 4096]));
    assert_eq!(h.fetch_feed(feed_sig()).await.unwrap().body.len(), 4096);
    s.route("/update/stable.json.sig", Route::body(vec![b'a'; 4097]));
    assert_eq!(code(h.fetch_feed(feed_sig()).await), ErrorCode::FeedTooLarge);
}

#[tokio::test]
async fn feed_cut_connection_is_a_transport_failure() {
    let s = Server::start();
    let h = loopback_http(&s, quick());
    s.route("/update/stable.json", Route::body(vec![b'a'; 4000]).truncate_after(1000));
    assert_eq!(code(h.fetch_feed(feed_json()).await), ErrorCode::Offline);
}

#[tokio::test]
async fn feed_header_block_above_64_kib_is_refused() {
    let s = Server::start();
    let h = loopback_http(&s, quick());
    s.route("/update/stable.json", Route::body(b"{}".to_vec()).huge_header());
    assert_eq!(code(h.fetch_feed(feed_json()).await), ErrorCode::TooLarge);
}

#[tokio::test]
async fn feed_second_base_does_not_exist_on_loopback() {
    let s = Server::start();
    let h = loopback_http(&s, quick());
    let r = h.fetch_feed(FeedFile { base: 1, channel: Channel::Stable, kind: FeedKind::Json }).await;
    assert_eq!(code(r), ErrorCode::BadUrl);
    assert_eq!(s.total(), 0);
}

#[tokio::test]
async fn feed_total_timeout_and_header_stall() {
    let s = Server::start();
    s.route("/update/stable.json", Route::body(b"{}".to_vec()).never_respond());
    let t = NetTimeouts { feed_total: Duration::from_millis(300), ..quick() };
    let h = loopback_http(&s, t);
    let started = Instant::now();
    assert_eq!(code(h.fetch_feed(feed_json()).await), ErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(3));
    // A body that trickles in slower than the total allows.
    s.route("/update/stable.json", Route::body(vec![b'a'; 100_000]).slow(20_000));
    assert_eq!(code(h.fetch_feed(feed_json()).await), ErrorCode::Timeout);
}

#[tokio::test]
async fn feed_production_urls_and_no_redirect_on_either_base() {
    let t = ScriptedTransport::new(vec![ok(b"{}"), ok(b"{}"), redir(301, "https://ferencfarkas09.github.io/IntelyIDE/update/stable.json")]);
    let h = prod_http(prod_resolver(), t.clone(), quick());
    h.fetch_feed(feed_json()).await.unwrap();
    h.fetch_feed(FeedFile { base: 1, channel: Channel::Stable, kind: FeedKind::Sig }).await.unwrap();
    assert_eq!(code(h.fetch_feed(FeedFile { base: 0, channel: Channel::Alpha, kind: FeedKind::Json }).await), ErrorCode::RedirectRefused);
    assert_eq!(
        t.seen_urls(),
        [
            "https://ferencfarkas09.github.io/IntelyIDE/update/stable.json",
            "https://raw.githubusercontent.com/ferencfarkas09/IntelyIDE/main/site/data/update/stable.json.sig",
            "https://ferencfarkas09.github.io/IntelyIDE/update/alpha.json",
        ]
    );
    let seen = t.seen.lock().unwrap();
    assert_eq!(seen[0].pinned.as_ref().unwrap().host, "ferencfarkas09.github.io");
    assert_eq!(seen[0].accept, "application/json");
    assert_eq!(seen[1].accept, "application/octet-stream");
    let h2 = prod_http(prod_resolver(), ScriptedTransport::new(vec![]), quick());
    assert_eq!(code(h2.fetch_feed(FeedFile { base: 2, channel: Channel::Stable, kind: FeedKind::Json }).await), ErrorCode::BadUrl);
}

// ------------------------------------------------------------------------------------------
// artifact download (loopback server, real transport)
// ------------------------------------------------------------------------------------------

#[tokio::test]
async fn happy_download_writes_a_0600_file_with_monotonic_progress() {
    use std::os::unix::fs::PermissionsExt;
    let data = pattern(3 * MIB as usize, 1);
    let art = art_for(&data);
    let s = Server::start();
    s.route(ART_PATH, Route::body(data.clone()));
    let h = loopback_http(&s, quick());
    let dir = tempfile::tempdir().unwrap();
    let dest = dest_in(&dir);
    let seen = Mutex::new(Vec::<Progress>::new());
    let cancel = Cancel::new();
    let got = h.download_artifact(&art, &dest, &cancel, &|p| seen.lock().unwrap().push(p)).await.unwrap();
    assert_eq!(got, Downloaded { bytes: art.bytes, sha256: art.sha256.clone() });
    assert_eq!(std::fs::read(&dest).unwrap(), data);
    assert_eq!(std::fs::metadata(&dest).unwrap().permissions().mode() & 0o7777, 0o600);
    let seen = seen.into_inner().unwrap();
    assert_eq!(seen.first().unwrap().done, 0);
    assert_eq!(*seen.last().unwrap(), Progress { done: art.bytes, total: art.bytes });
    assert!(seen.windows(2).all(|w| w[0].done <= w[1].done));
    assert!(seen.iter().all(|p| p.total == art.bytes));
    let reqs = s.requests();
    assert_eq!(reqs.len(), 1);
    assert_clean_headers(&reqs[0]);
    assert_eq!(reqs[0].header("accept"), Some("application/octet-stream"));
    assert!(!reqs[0].target.contains('?'), "no query string on the first artifact hop");
}

#[tokio::test]
async fn truncated_download_is_refused_and_the_part_file_removed() {
    let data = pattern(200_000, 2);
    let art = art_for(&data);
    let s = Server::start();
    s.route(ART_PATH, Route::body(data.clone()).truncate_after(100_000));
    let h = loopback_http(&s, quick());
    let dir = tempfile::tempdir().unwrap();
    let dest = dest_in(&dir);
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::Truncated);
    assert!(!dest.exists());
    // The same cut on a chunked body (no Content-Length at all).
    s.route(ART_PATH, Route::body(data.clone()).chunked().truncate_after(100_000));
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::Truncated);
    assert!(!dest.exists());
    // A close-delimited body that simply ends early.
    s.route(ART_PATH, Route::body(data[..150_000].to_vec()).close_delimited());
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::Truncated);
    assert!(!dest.exists());
}

#[tokio::test]
async fn content_length_that_lies_in_either_direction_is_refused() {
    let data = pattern(100_000, 3);
    let art = art_for(&data);
    let s = Server::start();
    let h = loopback_http(&s, quick());
    let dir = tempfile::tempdir().unwrap();
    let dest = dest_in(&dir);
    // Claims fewer bytes than the signed size (and delivers that many).
    s.route(ART_PATH, Route::body(data[..99_990].to_vec()));
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::SizeMismatch);
    // Claims more bytes than the signed size.
    s.route(ART_PATH, Route::body(data.clone()).claim_length(100_010));
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::SizeMismatch);
    assert!(!dest.exists());
}

#[tokio::test]
async fn body_longer_than_the_signed_size_aborts_at_the_excess() {
    let data = pattern(100_000, 4);
    let art = art_for(&data);
    let mut longer = data.clone();
    longer.extend_from_slice(&[0u8; 50_000]);
    let s = Server::start();
    let h = loopback_http(&s, quick());
    let dir = tempfile::tempdir().unwrap();
    let dest = dest_in(&dir);
    s.route(ART_PATH, Route::body(longer.clone()).close_delimited());
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::TooLarge);
    assert!(!dest.exists());
    s.route(ART_PATH, Route::body(longer).chunked());
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::TooLarge);
    assert!(!dest.exists());
}

#[tokio::test]
async fn oversize_claims_are_refused_before_the_body_is_read() {
    let s = Server::start();
    let h = loopback_http(&s, quick());
    let dir = tempfile::tempdir().unwrap();
    let dest = dest_in(&dir);
    // The feed claims more than 512 MiB: nothing is even connected to.
    let big = ArtifactRef { version: Version::new(0, 1, 1), arch: Arch::X64, bytes: 600 * MIB, sha256: sha(b"x") };
    assert_eq!(code(dl(&h, &big, &dest).await), ErrorCode::TooLarge);
    assert_eq!(s.total(), 0);
    // The server claims more than 512 MiB (headers only, no body follows).
    let data = pattern(10_000, 5);
    s.route(ART_PATH, Route::status(200).claim_length(600 * MIB));
    assert_eq!(code(dl(&h, &art_for(&data), &dest).await), ErrorCode::TooLarge);
    assert!(!dest.exists());
    // Exactly 512 MiB is a legal claim (it is then compared with the signed size).
    let exact = ArtifactRef { bytes: 512 * MIB, ..art_for(&data) };
    s.route(ART_PATH, Route::status(200).claim_length(512 * MIB).truncate_after(0));
    assert_eq!(code(dl(&h, &exact, &dest).await), ErrorCode::Truncated);
    // Zero is never a legal size.
    let zero = ArtifactRef { bytes: 0, ..art_for(&data) };
    assert_eq!(code(dl(&h, &zero, &dest).await), ErrorCode::SizeMismatch);
}

#[tokio::test]
async fn hash_mismatch_removes_the_file() {
    let data = pattern(50_000, 6);
    let mut other = data.clone();
    other[10] ^= 1;
    let s = Server::start();
    s.route(ART_PATH, Route::body(other));
    let h = loopback_http(&s, quick());
    let dir = tempfile::tempdir().unwrap();
    let dest = dest_in(&dir);
    assert_eq!(code(dl(&h, &art_for(&data), &dest).await), ErrorCode::HashMismatch);
    assert!(!dest.exists());
    // A malformed expected hash never reaches the network.
    let bad = ArtifactRef { sha256: "ABC".into(), ..art_for(&data) };
    let before = s.total();
    assert_eq!(code(dl(&h, &bad, &dest).await), ErrorCode::HashMismatch);
    assert_eq!(s.total(), before);
}

#[tokio::test]
async fn bad_status_codes_on_the_artifact() {
    let data = pattern(1000, 8);
    let art = art_for(&data);
    let s = Server::start();
    let h = loopback_http(&s, quick());
    let dir = tempfile::tempdir().unwrap();
    let dest = dest_in(&dir);
    for status in [404u16, 500, 503, 304, 206] {
        s.route(ART_PATH, Route::status(status));
        let e = dl(&h, &art, &dest).await.unwrap_err();
        assert_eq!((e.code, e.detail.as_deref()), (ErrorCode::BadStatus, Some(status.to_string().as_str())));
        assert!(!dest.exists());
    }
}

#[tokio::test]
async fn artifact_header_block_above_64_kib_is_refused() {
    let data = pattern(1000, 9);
    let s = Server::start();
    s.route(ART_PATH, Route::body(data.clone()).huge_header());
    let h = loopback_http(&s, quick());
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(code(dl(&h, &art_for(&data), &dest_in(&dir)).await), ErrorCode::TooLarge);
}

// ---- timeouts, cancel, the .part file ----

#[tokio::test]
async fn idle_stall_and_total_timeout_delete_the_part_file() {
    let data = pattern(200_000, 10);
    let art = art_for(&data);
    let s = Server::start();
    let dir = tempfile::tempdir().unwrap();
    let dest = dest_in(&dir);

    s.route(ART_PATH, Route::body(data.clone()).stall_after(1000));
    let h = loopback_http(&s, NetTimeouts { download_idle: Duration::from_millis(300), ..quick() });
    let started = Instant::now();
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(!dest.exists());

    // The server never answers the request: the idle limit covers the header wait too.
    s.route(ART_PATH, Route::body(data.clone()).never_respond());
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::Timeout);
    assert!(!dest.exists());

    // Bytes keep arriving, but too slowly for the total limit.
    s.route(ART_PATH, Route::body(data.clone()).slow(40_000));
    let h = loopback_http(&s, NetTimeouts { download_total: Duration::from_millis(500), ..quick() });
    let started = Instant::now();
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(4));
    assert!(!dest.exists());
}

#[tokio::test]
async fn cancel_stops_the_download_and_deletes_the_part_file() {
    let data = pattern(200_000, 11);
    let art = art_for(&data);
    let s = Server::start();
    s.route(ART_PATH, Route::body(data.clone()).slow(40_000));
    let h = loopback_http(&s, quick());
    let dir = tempfile::tempdir().unwrap();
    let dest = dest_in(&dir);
    let cancel = Cancel::new();
    let c2 = cancel.clone();
    let started = Instant::now();
    let (r, _) = tokio::join!(h.download_artifact(&art, &dest, &cancel, &|_| {}), async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        c2.cancel();
    });
    assert_eq!(code(r), ErrorCode::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(4));
    assert!(!dest.exists());

    // Cancelled before the start: nothing is requested.
    let before = s.total();
    let pre = Cancel::new();
    pre.cancel();
    let r = h.download_artifact(&art, &dest, &pre, &|_| {}).await;
    assert_eq!(code(r), ErrorCode::Cancelled);
    assert_eq!(s.total(), before);

    // Cancelled while the server never answers.
    s.route(ART_PATH, Route::body(data.clone()).never_respond());
    let cancel = Cancel::new();
    let c2 = cancel.clone();
    let (r, _) = tokio::join!(h.download_artifact(&art, &dest, &cancel, &|_| {}), async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        c2.cancel();
    });
    assert_eq!(code(r), ErrorCode::Cancelled);
}

#[tokio::test]
async fn part_file_is_created_exclusively_and_never_through_a_symlink() {
    let data = pattern(10_000, 12);
    let art = art_for(&data);
    let s = Server::start();
    s.route(ART_PATH, Route::body(data.clone()));
    let h = loopback_http(&s, quick());
    let dir = tempfile::tempdir().unwrap();
    let dest = dest_in(&dir);

    // A symlink planted at the path: refused, the victim is untouched, the link stays.
    let victim = dir.path().join("victim");
    std::fs::write(&victim, b"keep").unwrap();
    std::os::unix::fs::symlink(&victim, &dest).unwrap();
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::AlreadyRunning);
    assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
    assert!(std::fs::symlink_metadata(&dest).unwrap().file_type().is_symlink());
    std::fs::remove_file(&dest).unwrap();

    // A dangling symlink as well.
    std::os::unix::fs::symlink(dir.path().join("nowhere"), &dest).unwrap();
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::AlreadyRunning);
    assert!(!dir.path().join("nowhere").exists());
    std::fs::remove_file(&dest).unwrap();

    // An existing regular file is not overwritten.
    std::fs::write(&dest, b"old").unwrap();
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::AlreadyRunning);
    assert_eq!(std::fs::read(&dest).unwrap(), b"old");
    std::fs::remove_file(&dest).unwrap();

    // A missing directory cannot be written.
    let missing = dir.path().join("no-such-dir").join("x.part");
    assert_eq!(code(dl(&h, &art, &missing).await), ErrorCode::NotWritable);

    // And the clean path still works afterwards.
    dl(&h, &art, &dest).await.unwrap();
}

// ---- redirects on the loopback origin ----

#[tokio::test]
async fn redirect_chain_of_one_to_three_hops_is_followed_a_fourth_is_refused() {
    let data = pattern(20_000, 13);
    let art = art_for(&data);
    let dir = tempfile::tempdir().unwrap();
    let dest = dest_in(&dir);
    for hops in 1..=3usize {
        let s = Server::start();
        let o = s.origin();
        let mut cur = ART_PATH.to_string();
        for i in 1..=hops {
            let next = format!("/cdn/{i}");
            s.route(&cur, Route::redirect(302, &format!("{o}{next}?sp=r&sig=abc{i}")));
            cur = next;
        }
        s.route(&cur, Route::body(data.clone()));
        let h = loopback_http(&s, quick());
        dl(&h, &art, &dest).await.unwrap_or_else(|e| panic!("{hops} hops: {e}"));
        assert_eq!(s.total(), hops + 1);
        for r in s.requests() {
            assert_clean_headers(&r);
        }
        std::fs::remove_file(&dest).unwrap();
    }

    // Three redirects followed, the fourth redirect answer is refused and its target never requested.
    let s = Server::start();
    let o = s.origin();
    s.route(ART_PATH, Route::redirect(302, &format!("{o}/cdn/1")));
    s.route("/cdn/1", Route::redirect(301, &format!("{o}/cdn/2")));
    s.route("/cdn/2", Route::redirect(307, &format!("{o}/cdn/3")));
    s.route("/cdn/3", Route::redirect(308, &format!("{o}/cdn/4")));
    s.route("/cdn/4", Route::body(data.clone()));
    let h = loopback_http(&s, quick());
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::RedirectRefused);
    assert_eq!(s.total(), 4);
    assert_eq!(s.count("/cdn/4"), 0);
    assert!(!dest.exists());

    // A redirect loop is cut by the same limit.
    s.route(ART_PATH, Route::redirect(302, &format!("{o}{ART_PATH}")));
    let before = s.total();
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::RedirectRefused);
    assert_eq!(s.total() - before, 4);
}

#[tokio::test]
async fn redirect_targets_that_break_the_rules_are_refused_unrequested() {
    let data = pattern(2000, 14);
    let art = art_for(&data);
    let dir = tempfile::tempdir().unwrap();
    let dest = dest_in(&dir);
    let s = Server::start();
    s.route("/trap", Route::body(data.clone()));
    let h = loopback_http(&s, quick());
    let o = s.origin();
    let table: Vec<(String, ErrorCode)> = vec![
        // http to another loopback port
        ("http://127.0.0.1:1/trap".into(), ErrorCode::RedirectRefused),
        (format!("http://localhost:{}/trap", s.port()), ErrorCode::RedirectRefused),
        ("ftp://objects.githubusercontent.com/x".into(), ErrorCode::RedirectRefused),
        // wrong hosts over https
        ("https://evil.example/x".into(), ErrorCode::HostNotAllowed),
        ("https://evilgithubusercontent.com/x".into(), ErrorCode::HostNotAllowed),
        ("https://githubusercontent.com/x".into(), ErrorCode::HostNotAllowed),
        ("https://objects.githubusercontent.com.evil.example/x".into(), ErrorCode::HostNotAllowed),
        ("https://user@objects.githubusercontent.com/x".into(), ErrorCode::HostNotAllowed),
        ("https://objects.githubusercontent.com:8443/x".into(), ErrorCode::HostNotAllowed),
        // same host as the first hop (the rename rule), here an IP literal
        ("https://127.0.0.1/x".into(), ErrorCode::RedirectRefused),
        // relative and scheme-relative references
        ("/trap".into(), ErrorCode::RedirectRefused),
        ("//objects.githubusercontent.com/x".into(), ErrorCode::RedirectRefused),
        ("trap".into(), ErrorCode::RedirectRefused),
        // a fragment, a dot segment and a backslash in an otherwise fine URL (same host as the hop: refused)
        (format!("{o}/trap#frag"), ErrorCode::RedirectRefused),
        (format!("{o}/a/../trap"), ErrorCode::RedirectRefused),
        (format!("{o}/a\\trap"), ErrorCode::RedirectRefused),
    ];
    for (loc, want) in table {
        s.route(ART_PATH, Route::redirect(302, &loc));
        assert_eq!(code(dl(&h, &art, &dest).await), want, "Location {loc}");
        assert!(!dest.exists());
    }
    // A redirect answer without a Location, or with two of them.
    s.route(ART_PATH, Route::status(302));
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::RedirectRefused);
    s.route(ART_PATH, Route::redirect(302, &format!("{o}/trap")).header("Location", &format!("{o}/trap")));
    assert_eq!(code(dl(&h, &art, &dest).await), ErrorCode::RedirectRefused);
    assert_eq!(s.count("/trap"), 0);
}

#[tokio::test]
async fn no_cookie_or_credential_survives_a_redirect() {
    let data = pattern(2000, 15);
    let art = art_for(&data);
    let s = Server::start();
    let o = s.origin();
    s.route(ART_PATH, Route::redirect(302, &format!("{o}/cdn/1")).header("Set-Cookie", "session=abc; Path=/").header("Referer", "x"));
    s.route("/cdn/1", Route::body(data.clone()));
    let h = loopback_http(&s, quick());
    let dir = tempfile::tempdir().unwrap();
    dl(&h, &art, &dest_in(&dir)).await.unwrap();
    let reqs = s.requests();
    assert_eq!(reqs.len(), 2);
    for r in &reqs {
        assert_clean_headers(r);
    }
}

// ------------------------------------------------------------------------------------------
// production host rules, address rules and answer-set pinning (scripted transport, fake DNS)
// ------------------------------------------------------------------------------------------

#[tokio::test]
async fn production_download_follows_a_cdn_redirect_with_pinned_answers() {
    let (data, art) = small_art();
    let cdn = "https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sp=r&sv=2018&sig=a%2Bb&jwt=eyJ.x.y";
    let t = ScriptedTransport::new(vec![redir(302, cdn), ok(&data)]);
    let r = prod_resolver();
    let h = prod_http(r.clone(), t.clone(), quick());
    let dir = tempfile::tempdir().unwrap();
    let dest = dest_in(&dir);
    dl(&h, &art, &dest).await.unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), data);
    assert_eq!(t.seen_urls(), [PROD_ART_URL.to_string(), cdn.to_string()]);
    // One resolution per hop, in order, nothing else.
    assert_eq!(r.calls(), ["github.com", "release-assets.githubusercontent.com"]);
    let seen = t.seen.lock().unwrap();
    assert_eq!(seen[0].pinned, Some(Pinned { host: "github.com".into(), addrs: vec!["140.82.112.4:443".parse().unwrap()] }));
    assert_eq!(
        seen[1].pinned,
        Some(Pinned { host: "release-assets.githubusercontent.com".into(), addrs: vec!["185.199.108.133:443".parse().unwrap()] })
    );
    assert!(seen.iter().all(|s| s.accept == "application/octet-stream"));
}

#[tokio::test]
async fn production_cdn_host_rule_accepts_real_subdomains_and_refuses_lookalikes() {
    let (data, art) = small_art();
    let dir = tempfile::tempdir().unwrap();
    let dest = dest_in(&dir);
    for good in [
        "https://objects.githubusercontent.com/x",
        "https://release-assets.githubusercontent.com/a/b?sp=r",
        "https://a.b.githubusercontent.com/x",
    ] {
        let t = ScriptedTransport::new(vec![redir(302, good), ok(&data)]);
        let h = prod_http(prod_resolver(), t.clone(), quick());
        dl(&h, &art, &dest).await.unwrap_or_else(|e| panic!("{good}: {e}"));
        assert_eq!(t.seen_urls().len(), 2);
        std::fs::remove_file(&dest).unwrap();
    }
    let table = [
        ("https://evilgithubusercontent.com/x", ErrorCode::HostNotAllowed),
        ("https://githubusercontent.com/x", ErrorCode::HostNotAllowed),
        ("https://objects.githubusercontent.com.evil.example/x", ErrorCode::HostNotAllowed),
        ("https://objects-githubusercontent.com/x", ErrorCode::HostNotAllowed),
        ("https://user@objects.githubusercontent.com/x", ErrorCode::HostNotAllowed),
        ("https://objects.githubusercontent.com:8443/x", ErrorCode::HostNotAllowed),
        ("https://objects.githubusercontent.com:443/x", ErrorCode::HostNotAllowed),
        ("https://evil.example/x", ErrorCode::HostNotAllowed),
        ("https://[::1]/x", ErrorCode::HostNotAllowed),
        ("https://127.0.0.1/x", ErrorCode::HostNotAllowed),
        ("https://ferencfarkas09.github.io/IntelyIDE/update/stable.json", ErrorCode::HostNotAllowed),
        ("http://objects.githubusercontent.com/x", ErrorCode::RedirectRefused),
        ("ftp://objects.githubusercontent.com/x", ErrorCode::RedirectRefused),
        ("/x", ErrorCode::RedirectRefused),
        ("//objects.githubusercontent.com/x", ErrorCode::RedirectRefused),
    ];
    for (loc, want) in table {
        let t = ScriptedTransport::new(vec![redir(302, loc), ok(&data)]);
        let r = prod_resolver();
        let h = prod_http(r.clone(), t.clone(), quick());
        assert_eq!(code(dl(&h, &art, &dest).await), want, "Location {loc}");
        assert_eq!(t.seen_urls().len(), 1, "the refused target is never requested ({loc})");
        assert_eq!(r.calls(), ["github.com"], "the refused target is never resolved ({loc})");
        assert!(!dest.exists());
    }
}

#[tokio::test]
async fn redirect_after_a_repository_rename_is_refused() {
    let (data, art) = small_art();
    let dir = tempfile::tempdir().unwrap();
    for to in [
        "https://github.com/NewOrg/IntelyIDE/releases/download/v0.1.1/IntelyIDE_0.1.1_x64.app.tar.gz",
        "https://github.com/ferencfarkas09/NewName/releases/download/v0.1.1/IntelyIDE_0.1.1_x64.app.tar.gz",
    ] {
        let t = ScriptedTransport::new(vec![redir(301, to), ok(&data)]);
        let h = prod_http(prod_resolver(), t.clone(), quick());
        assert_eq!(code(dl(&h, &art, &dest_in(&dir)).await), ErrorCode::RedirectRefused);
        assert_eq!(t.seen_urls().len(), 1);
    }
}

#[tokio::test]
async fn production_fourth_redirect_is_refused() {
    let (data, art) = small_art();
    let dir = tempfile::tempdir().unwrap();
    let cdn = "https://objects.githubusercontent.com/x";
    let t = ScriptedTransport::new(vec![redir(302, cdn), redir(302, cdn), redir(302, cdn), redir(302, cdn), ok(&data)]);
    let h = prod_http(prod_resolver(), t.clone(), quick());
    assert_eq!(code(dl(&h, &art, &dest_in(&dir)).await), ErrorCode::RedirectRefused);
    assert_eq!(t.seen_urls().len(), 4);
}

#[tokio::test]
async fn private_loopback_linklocal_cgnat_and_nat64_answers_are_refused_before_any_connection() {
    let (data, art) = small_art();
    let dir = tempfile::tempdir().unwrap();
    for bad in [
        "127.0.0.1",
        "10.0.0.1",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "198.18.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "::1",
        "fc00::1",
        "fd12::1",
        "fe80::1",
        "::ffff:10.0.0.1",
        "64:ff9b::a00:1",
        "2001:db8::1",
    ] {
        let t = ScriptedTransport::new(vec![ok(&data)]);
        let r = FakeResolver::new();
        r.answer("github.com", &[bad]);
        let h = prod_http(r, t.clone(), quick());
        let e = dl(&h, &art, &dest_in(&dir)).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::PrivateAddress, "{bad}");
        assert_eq!(e.detail.as_deref(), Some("github.com"));
        assert_eq!(t.seen_urls().len(), 0, "{bad}: nothing may be sent");
        // The same for a feed.
        let r = FakeResolver::new();
        r.answer("ferencfarkas09.github.io", &[bad]);
        let h = prod_http(r, ScriptedTransport::new(vec![ok(b"{}")]), quick());
        assert_eq!(code(h.fetch_feed(feed_json()).await), ErrorCode::PrivateAddress, "{bad}");
    }
}

#[tokio::test]
async fn one_private_answer_among_public_ones_refuses_the_hop() {
    let (data, art) = small_art();
    let dir = tempfile::tempdir().unwrap();
    let t = ScriptedTransport::new(vec![ok(&data)]);
    let r = FakeResolver::new();
    r.answer("github.com", &["140.82.112.4", "10.0.0.1"]);
    let h = prod_http(r, t.clone(), quick());
    assert_eq!(code(dl(&h, &art, &dest_in(&dir)).await), ErrorCode::PrivateAddress);
    assert_eq!(t.seen_urls().len(), 0);
}

#[tokio::test]
async fn a_redirect_to_an_allowed_host_that_resolves_privately_is_refused() {
    let (data, art) = small_art();
    let dir = tempfile::tempdir().unwrap();
    let t = ScriptedTransport::new(vec![redir(302, "https://objects.githubusercontent.com/x"), ok(&data)]);
    let r = FakeResolver::new();
    r.answer("github.com", &["140.82.112.4"]);
    r.answer("objects.githubusercontent.com", &["192.168.0.10"]);
    let h = prod_http(r, t.clone(), quick());
    assert_eq!(code(dl(&h, &art, &dest_in(&dir)).await), ErrorCode::PrivateAddress);
    assert_eq!(t.seen_urls().len(), 1);
}

#[tokio::test]
async fn dns_rebinding_is_impossible_because_each_hop_resolves_once_and_pins_the_answer() {
    let (data, art) = small_art();
    let dir = tempfile::tempdir().unwrap();
    let t = ScriptedTransport::new(vec![ok(&data)]);
    let r = FakeResolver::new();
    // The first answer is public; a second resolution would be private (the rebinding).
    r.answer("github.com", &["140.82.112.4"]);
    r.answer("github.com", &["127.0.0.1"]);
    let h = prod_http(r.clone(), t.clone(), quick());
    dl(&h, &art, &dest_in(&dir)).await.unwrap();
    assert_eq!(r.calls(), ["github.com"]);
    let seen = t.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].pinned.as_ref().unwrap().addrs, vec!["140.82.112.4:443".parse::<SocketAddr>().unwrap()]);
}

#[tokio::test]
async fn the_whole_validated_answer_set_is_pinned_in_order_and_deduplicated() {
    let (data, art) = small_art();
    let dir = tempfile::tempdir().unwrap();
    let t = ScriptedTransport::new(vec![ok(&data)]);
    let r = FakeResolver::new();
    r.answer("github.com", &["2606:50c0:8000::154", "140.82.112.4", "2606:50c0:8000::154", "140.82.112.3"]);
    let h = prod_http(r, t.clone(), quick());
    dl(&h, &art, &dest_in(&dir)).await.unwrap();
    let want: Vec<SocketAddr> = ["[2606:50c0:8000::154]:443", "140.82.112.4:443", "140.82.112.3:443"].iter().map(|s| s.parse().unwrap()).collect();
    assert_eq!(t.seen.lock().unwrap()[0].pinned.as_ref().unwrap().addrs, want);
}

#[tokio::test]
async fn dns_failures_are_offline_and_an_empty_answer_too() {
    let (data, art) = small_art();
    let dir = tempfile::tempdir().unwrap();
    let r = FakeResolver::new();
    r.fail("github.com");
    let h = prod_http(r, ScriptedTransport::new(vec![ok(&data)]), quick());
    assert_eq!(code(dl(&h, &art, &dest_in(&dir)).await), ErrorCode::Offline);
    let r = FakeResolver::new();
    r.answer("github.com", &[]);
    let h = prod_http(r, ScriptedTransport::new(vec![ok(&data)]), quick());
    assert_eq!(code(dl(&h, &art, &dest_in(&dir)).await), ErrorCode::Offline);
}

#[tokio::test]
async fn a_transport_that_never_answers_times_out() {
    let (_, art) = small_art();
    let dir = tempfile::tempdir().unwrap();
    let t = ScriptedTransport::new(vec![Step::Hang]);
    let h = prod_http(prod_resolver(), t, NetTimeouts { download_idle: Duration::from_millis(200), ..quick() });
    let started = Instant::now();
    assert_eq!(code(dl(&h, &art, &dest_in(&dir)).await), ErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn real_transport_with_a_private_answer_never_opens_a_socket() {
    // The real reqwest transport, the production endpoints, a fake resolver: refusal happens
    // before any connection, so this needs neither TLS nor a network.
    let (_, art) = small_art();
    let dir = tempfile::tempdir().unwrap();
    let r = FakeResolver::new();
    r.answer("github.com", &["10.1.2.3"]);
    let t = quick();
    let h = ReqwestUpdateHttp::with_parts(Endpoints::production(), r, Arc::new(ReqwestTransport::new(t, true)), t);
    assert_eq!(code(dl(&h, &art, &dest_in(&dir)).await), ErrorCode::PrivateAddress);
}

// ------------------------------------------------------------------------------------------
// the client itself: pinned address sets over real sockets, no DNS, no proxy
// ------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_broken_first_ipv6_answer_does_not_stall_or_fail_the_request() {
    let s = Server::start();
    s.route("/x", Route::body(b"hello".to_vec()));
    let port = s.port();
    // [::1] is first and refuses connections (the server listens on IPv4 only); the second answer works.
    let pinned = Pinned {
        host: "pinned.test".into(),
        addrs: vec![SocketAddr::new("::1".parse().unwrap(), port), SocketAddr::new("127.0.0.1".parse().unwrap(), port)],
    };
    let t = quick();
    let client = client_for_hop(&t, Some(&pinned), false).unwrap();
    let started = Instant::now();
    let resp = client.get(format!("http://pinned.test:{port}/x")).send().await.expect("the second pinned answer must be tried");
    assert_eq!(resp.text().await.unwrap(), "hello");
    assert!(started.elapsed() < Duration::from_millis(1500), "took {:?}", started.elapsed());
    assert_eq!(s.count("/x"), 1);
}

#[tokio::test]
async fn the_client_cannot_resolve_anything_by_itself() {
    let s = Server::start();
    s.route("/x", Route::body(b"hello".to_vec()));
    let t = quick();
    let client = client_for_hop(&t, None, false).unwrap();
    // Not pinned: reqwest has no resolver that works, so no connection (and no query to any DNS server).
    let r = client.get(format!("http://unpinned.test:{}/x", s.port())).send().await;
    assert!(r.is_err());
    // localhost is a name too, not an exception.
    let r = client.get(format!("http://localhost:{}/x", s.port())).send().await;
    assert!(r.is_err());
    assert_eq!(s.total(), 0);
}

#[tokio::test]
async fn the_client_does_not_follow_redirects_and_https_only_is_enforced() {
    let s = Server::start();
    s.route("/a", Route::redirect(302, &format!("{}/b", s.origin())));
    s.route("/b", Route::body(b"b".to_vec()));
    let t = quick();
    let client = client_for_hop(&t, None, false).unwrap();
    let resp = client.get(format!("{}/a", s.origin())).send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 302);
    assert_eq!(s.count("/b"), 0);
    // https_only: a plain http URL is refused by the client itself.
    let strict = client_for_hop(&t, None, true).unwrap();
    assert!(strict.get(format!("{}/b", s.origin())).send().await.is_err());
    assert_eq!(s.count("/b"), 0);
}

fn run_child(name: &str) -> String {
    let exe = std::env::current_exe().unwrap();
    let out = Command::new(exe)
        .args(["--exact", name, "--ignored", "--nocapture", "--test-threads=1"])
        .output()
        .expect("spawn the test binary");
    let text = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert!(out.status.success() && text.contains("1 passed"), "child {name} failed:\n{text}");
    text
}

#[test]
fn proxy_environment_variables_are_ignored() {
    run_child("child_proxy_environment");
}

/// Runs in its own process (process-wide environment); started by `proxy_environment_variables_are_ignored`.
#[tokio::test]
#[ignore]
async fn child_proxy_environment() {
    let trap = Server::start();
    let target = Server::start();
    target.route("/update/stable.json", Route::body(b"{}".to_vec()));
    let proxy = format!("http://127.0.0.1:{}", trap.port());
    for k in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] {
        std::env::set_var(k, &proxy);
    }
    std::env::remove_var("NO_PROXY");
    std::env::remove_var("no_proxy");
    // Control: a default client IS sent to the proxy, so the trap works.
    let _ = reqwest::Client::new().get(format!("{}/update/stable.json", target.origin())).send().await;
    assert!(trap.total() >= 1, "the control request must reach the trap proxy");
    let before = trap.total();
    let h = loopback_http(&target, quick());
    let f = h.fetch_feed(feed_json()).await.unwrap();
    assert_eq!(f.status, 200);
    assert_eq!(trap.total(), before, "the updater must ignore proxy variables");
    assert_eq!(target.count("/update/stable.json"), 1);
}

// ------------------------------------------------------------------------------------------
// memory: a 200 MiB body streams through one buffer
// ------------------------------------------------------------------------------------------

#[test]
fn streaming_a_200_mib_body_keeps_memory_flat() {
    run_child("child_stream_200_mib");
}

fn max_rss_bytes() -> u64 {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    assert_eq!(rc, 0);
    // macOS reports bytes, Linux kilobytes.
    if cfg!(target_os = "macos") {
        ru.ru_maxrss as u64
    } else {
        ru.ru_maxrss as u64 * 1024
    }
}

/// Runs in its own process so that the peak is this test's alone; started by the test above.
#[tokio::test]
#[ignore]
async fn child_stream_200_mib() {
    let total = 200 * MIB;
    let s = Server::start();
    s.route(ART_PATH, Route::zeros(total));
    // Expected hash of 200 MiB of zeros, computed in 1 MiB pieces.
    let zeros = vec![0u8; MIB as usize];
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    for _ in 0..200 {
        ctx.update(&zeros);
    }
    let art = ArtifactRef { version: Version::new(0, 1, 1), arch: Arch::X64, bytes: total, sha256: hex::encode(ctx.finish().as_ref()) };
    drop(zeros);
    let h = loopback_http(&s, NetTimeouts { download_total: Duration::from_secs(300), ..quick() });
    let dir = tempfile::tempdir().unwrap();
    let dest = dest_in(&dir);
    let baseline = max_rss_bytes();
    let counter = AtomicUsize::new(0);
    let got = h
        .download_artifact(&art, &dest, &Cancel::new(), &|_| {
            counter.fetch_add(1, Ordering::SeqCst);
        })
        .await
        .unwrap();
    let growth = max_rss_bytes().saturating_sub(baseline);
    assert_eq!(got.bytes, total);
    assert_eq!(std::fs::metadata(&dest).unwrap().len(), total);
    println!("peak RSS growth while streaming 200 MiB: {} KiB, progress callbacks: {}", growth / 1024, counter.load(Ordering::SeqCst));
    assert!(growth < 32 * MIB, "peak RSS grew by {} MiB", growth / MIB);
}

// ------------------------------------------------------------------------------------------
// structure: the single constructor, no raw URL parameters (spec 11.2 U2)
// ------------------------------------------------------------------------------------------

fn net_source() -> String {
    include_str!("../src/net.rs")
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn every_client_comes_from_client_for_hop_with_the_hardened_settings() {
    let src = net_source();
    assert_eq!(src.matches("Client::builder()").count(), 1, "exactly one client constructor");
    for forbidden in ["Client::new(", "reqwest::get(", "reqwest::blocking", "cookie_store", "cookie_provider", ".proxy(", "danger_accept", "Policy::limited", "Policy::default"] {
        assert!(!src.contains(forbidden), "net.rs must not contain {forbidden}");
    }
    let start = src.find("pub fn client_for_hop").expect("client_for_hop");
    let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
    for needed in ["redirect(reqwest::redirect::Policy::none())", ".no_proxy()", ".referer(false)", ".https_only(https_only)", ".dns_resolver(NoDns)", "Client::builder()"] {
        assert!(body.contains(needed), "client_for_hop must contain {needed}");
    }
    // The cookie store is a cargo feature; it is off, so a cookie jar cannot even be asked for.
    let manifest = include_str!("../Cargo.toml");
    assert!(!manifest.contains("cookies"), "the reqwest cookies feature must stay off");
    // The transport is the only caller of client_for_hop.
    assert_eq!(src.matches("client_for_hop(").count(), 2, "definition + the transport");
}

#[test]
fn no_function_takes_a_raw_url_except_the_validating_one() {
    let src = net_source();
    let mut with_str: Vec<&str> = Vec::new();
    for l in src.lines() {
        if l.contains("fn ") && (l.contains(": &str") || l.contains(": String") || l.contains("raw:") || l.contains(": Url")) {
            with_str.push(l.trim());
        }
    }
    assert_eq!(with_str.len(), 1, "{with_str:?}");
    assert!(with_str[0].starts_with("fn hop_url("), "{with_str:?}");
    let start = src.find("fn hop_url(").unwrap();
    let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
    assert!(body.contains("endpoints.validate_hop(hop, raw)?"));
    assert_eq!(src.matches("ValidatedUrl { url").count(), 1, "ValidatedUrl is built in hop_url only");
    // Nothing public takes or returns a bare URL string for a request.
    assert!(!src.contains("pub fn get("));
}

#[test]
fn the_time_limits_are_the_ones_of_the_spec() {
    let t = NetTimeouts::default();
    assert_eq!(t.connect, Duration::from_secs(5));
    assert_eq!(t.feed_total, Duration::from_secs(15));
    assert_eq!(t.download_idle, Duration::from_secs(30));
    assert_eq!(t.download_total, Duration::from_secs(20 * 60));
    assert_eq!(HEADER_CAP, 64 * 1024);
    assert_eq!(USER_AGENT, "IntelyIDE-updater");
}
