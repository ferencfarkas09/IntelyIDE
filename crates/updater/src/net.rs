//! Network layer of the updater ((design notes: updater-spec) 4.6, 6.2 T1/T7/T8/T9/T16, 7.1, 10.2 `net`).
//!
//! Written for a hostile server, a hostile CDN and a hostile DNS answer:
//!
//! * Every request URL is built from constants (`Endpoints`) or comes from a `Location` header and
//!   passes `Endpoints::validate_hop` in the one private function [`hop_url`] before anything
//!   else sees it. Nothing public in this file takes a URL string.
//! * Every hop is resolved exactly once; ALL answers must pass `is_forbidden_address`; the
//!   validated answer SET is pinned (tried in order, SNI = the host name) so a second, different
//!   DNS answer is never consulted. reqwest is given a resolver that always fails, so it can never
//!   resolve anything on its own.
//! * Every reqwest client is built by [`client_for_hop`]: `redirect(Policy::none())`,
//!   `no_proxy()`, no cookie store (the cargo feature is off and the builder never asks for one),
//!   no referer, https only (outside the loopback test endpoints), TLS 1.2 or later, HTTP/1.1,
//!   no connection reuse across hops. Redirects are followed here, by hand, at most
//!   `MAX_REDIRECTS` times, each hop re-validated.
//! * Size, time and header limits come from `limits.rs`; the artifact size is enforced before the
//!   body is read and while it streams; the SHA-256 is computed while streaming; the `.part` file is
//!   created 0600 with `O_EXCL|O_NOFOLLOW` and deleted on every failure.
//!
//! The crate-level seams are two small traits: [`UpdateHttp`] (what the engine calls; the engine
//! tests use a scripted fake) and [`Transport`] (one hop on the wire; the tests use a scripted
//! transport to exercise the redirect and address rules without TLS). The environment is never read
//! and no thread or timer outlives a call.

use std::future::Future;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use intely_relay_bundle::net::{is_forbidden_address, Resolver, SystemResolver};
use ring::digest;
use semver::Version;
use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;
use tokio::time::Instant;
use url::{Host, Url};

use crate::endpoints::{Endpoints, Hop};
use crate::limits::{
    ARTIFACT_MAX_BYTES, CONNECT_TIMEOUT, DOWNLOAD_IDLE_TIMEOUT, DOWNLOAD_TOTAL_TIMEOUT, FEED_MAX_BYTES, FEED_SIG_MAX_BYTES,
    FEED_TOTAL_TIMEOUT, MAX_REDIRECTS,
};
use crate::version::{Arch, Channel};
use crate::{ErrorCode, UpdateError};

/// Constant user agent: no version, no identifier (spec 4.6 request headers).
pub const USER_AGENT: &str = "IntelyIDE-updater";
/// Sum of header names and values of one response above which the answer is refused.
pub const HEADER_CAP: usize = 64 * 1024;
/// At most this many pinned addresses per hop.
const MAX_PINNED_ADDRS: usize = 16;
/// Progress callbacks are throttled to this interval (plus the first and the last one).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

pub type NetFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, UpdateError>> + Send + 'a>>;

// ------------------------------------------------------------------------------------------
// Types
// ------------------------------------------------------------------------------------------

/// The time limits of spec 4.6. Production uses `Default`; tests pass milliseconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NetTimeouts {
    /// TCP connect (and the DNS step of a hop).
    pub connect: Duration,
    /// Whole feed or signature fetch.
    pub feed_total: Duration,
    /// A download that delivers no byte for this long is aborted.
    pub download_idle: Duration,
    /// Whole download.
    pub download_total: Duration,
}

impl Default for NetTimeouts {
    fn default() -> Self {
        NetTimeouts {
            connect: CONNECT_TIMEOUT,
            feed_total: FEED_TOTAL_TIMEOUT,
            download_idle: DOWNLOAD_IDLE_TIMEOUT,
            download_total: DOWNLOAD_TOTAL_TIMEOUT,
        }
    }
}

/// A URL that has passed `Endpoints::validate_hop` for the recorded hop kind. There is no public
/// constructor: only this module can make one, and only through [`hop_url`].
#[derive(Clone, Debug)]
pub struct ValidatedUrl {
    url: Url,
    hop: Hop,
}

impl ValidatedUrl {
    pub fn as_url(&self) -> &Url {
        &self.url
    }
    pub fn as_str(&self) -> &str {
        self.url.as_str()
    }
    pub fn hop(&self) -> Hop {
        self.hop
    }
}

/// The one place a URL string becomes a [`ValidatedUrl`].
fn hop_url(endpoints: &Endpoints, hop: Hop, raw: &str) -> Result<ValidatedUrl, ErrorCode> {
    let url = endpoints.validate_hop(hop, raw)?;
    Ok(ValidatedUrl { url, hop })
}

/// Cooperative cancellation of a download (`update_cancel`). Cheap to clone.
#[derive(Clone, Default)]
pub struct Cancel(Arc<CancelInner>);

#[derive(Default)]
struct CancelInner {
    flag: AtomicBool,
    notify: Notify,
}

impl Cancel {
    pub fn new() -> Cancel {
        Cancel::default()
    }
    pub fn cancel(&self) {
        self.0.flag.store(true, Ordering::SeqCst);
        self.0.notify.notify_waiters();
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.flag.load(Ordering::SeqCst)
    }
    /// Resolves when [`Cancel::cancel`] has been called (immediately if it already was).
    pub async fn cancelled(&self) {
        loop {
            let notified = self.0.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeedKind {
    Json,
    Sig,
}

/// Which feed file to fetch: `base` 0 is GitHub Pages, 1 the raw mirror (4.6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeedFile {
    pub base: usize,
    pub channel: Channel,
    pub kind: FeedKind,
}

/// The final answer of a feed or signature request. A status other than 200 has an empty body: the
/// engine decides (404 and 5xx fall over to the second base, anything else is an error).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fetched {
    pub status: u16,
    pub body: Vec<u8>,
}

/// What the (Feed-signed) feed says about the artifact. The URL is rebuilt from constants here; the
/// feed's own `url` field is compared by `feed.rs`, never used for a request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactRef {
    pub version: Version,
    pub arch: Arch,
    /// Exact size of the tarball.
    pub bytes: u64,
    /// 64 lowercase hex characters.
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress {
    pub done: u64,
    pub total: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Downloaded {
    pub bytes: u64,
    /// Lowercase hex SHA-256 of the file as written.
    pub sha256: String,
}

/// What the engine uses. The signature check is NOT part of it: `verify.rs` runs on the returned
/// file/bytes.
pub trait UpdateHttp: Send + Sync {
    /// One GET of a feed or signature file. Never follows a redirect (`RedirectRefused`).
    fn fetch_feed<'a>(&'a self, file: FeedFile) -> NetFuture<'a, Fetched>;

    /// Stream the artifact to `dest` (created 0600, `O_EXCL|O_NOFOLLOW`; deleted on every failure).
    /// Size and SHA-256 must equal `art`.
    fn download_artifact<'a>(
        &'a self,
        art: &'a ArtifactRef,
        dest: &'a Path,
        cancel: &'a Cancel,
        on_progress: &'a (dyn Fn(Progress) + Send + Sync),
    ) -> NetFuture<'a, Downloaded>;
}

// ------------------------------------------------------------------------------------------
// Transport: one hop on the wire
// ------------------------------------------------------------------------------------------

/// The validated answer set of one hop, pinned for the connection (SNI stays the host name).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pinned {
    pub host: String,
    pub addrs: Vec<SocketAddr>,
}

pub struct HopRequest {
    pub url: ValidatedUrl,
    pub accept: &'static str,
    /// `None` only for the IP-literal loopback origin of the test endpoints.
    pub pinned: Option<Pinned>,
}

pub struct HopResponse {
    pub status: u16,
    /// Header names lowercased.
    pub headers: Vec<(String, String)>,
    pub body: Box<dyn BodyStream>,
}

/// The body of a response, one chunk at a time. `next_chunk` must be cancel safe (the caller drops
/// the future on a timeout or a cancel).
pub trait BodyStream: Send {
    fn next_chunk<'a>(&'a mut self) -> NetFuture<'a, Option<Vec<u8>>>;
}

pub trait Transport: Send + Sync {
    fn send<'a>(&'a self, req: &'a HopRequest) -> NetFuture<'a, HopResponse>;
}

/// reqwest cannot resolve anything on its own: every host is pinned by the updater.
struct NoDns;

impl reqwest::dns::Resolve for NoDns {
    fn resolve(&self, _name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async { Err("the updater pins every address itself".into()) })
    }
}

/// THE constructor of every HTTP client of the updater (spec 11.2 U2). One request per client:
/// no connection survives a hop.
pub fn client_for_hop(timeouts: &NetTimeouts, pinned: Option<&Pinned>, https_only: bool) -> Result<reqwest::Client, UpdateError> {
    let mut b = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .referer(false)
        .user_agent(USER_AGENT)
        .connect_timeout(timeouts.connect)
        .https_only(https_only)
        .min_tls_version(reqwest::tls::Version::TLS_1_2)
        .pool_max_idle_per_host(0)
        .http1_only()
        .dns_resolver(NoDns);
    if let Some(p) = pinned {
        b = b.resolve_to_addrs(&p.host, &p.addrs);
    }
    b.build().map_err(|_| UpdateError::with(ErrorCode::Offline, "client"))
}

/// The production transport: reqwest over the system TLS stack.
pub struct ReqwestTransport {
    timeouts: NetTimeouts,
    https_only: bool,
}

impl ReqwestTransport {
    pub fn new(timeouts: NetTimeouts, https_only: bool) -> ReqwestTransport {
        ReqwestTransport { timeouts, https_only }
    }
}

struct ReqwestBody(reqwest::Response);

impl BodyStream for ReqwestBody {
    fn next_chunk<'a>(&'a mut self) -> NetFuture<'a, Option<Vec<u8>>> {
        Box::pin(async move {
            match self.0.chunk().await {
                Ok(c) => Ok(c.map(|b| b.to_vec())),
                Err(e) if e.is_timeout() => Err(UpdateError::new(ErrorCode::Timeout)),
                Err(_) => Err(UpdateError::new(ErrorCode::Truncated)),
            }
        })
    }
}

impl Transport for ReqwestTransport {
    fn send<'a>(&'a self, req: &'a HopRequest) -> NetFuture<'a, HopResponse> {
        Box::pin(async move {
            let client = client_for_hop(&self.timeouts, req.pinned.as_ref(), self.https_only)?;
            let resp = client
                .get(req.url.as_url().clone())
                .header(reqwest::header::ACCEPT, req.accept)
                .header(reqwest::header::CACHE_CONTROL, "no-cache")
                .send()
                .await
                .map_err(|e| {
                    if e.is_timeout() {
                        UpdateError::new(ErrorCode::Timeout)
                    } else {
                        UpdateError::with(ErrorCode::Offline, if e.is_connect() { "connect" } else { "request" })
                    }
                })?;
            let headers = resp
                .headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_ascii_lowercase(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
                .collect();
            Ok(HopResponse { status: resp.status().as_u16(), headers, body: Box::new(ReqwestBody(resp)) })
        })
    }
}

// ------------------------------------------------------------------------------------------
// The client the engine uses
// ------------------------------------------------------------------------------------------

pub struct ReqwestUpdateHttp {
    endpoints: Endpoints,
    resolver: Arc<dyn Resolver>,
    transport: Arc<dyn Transport>,
    timeouts: NetTimeouts,
}

impl ReqwestUpdateHttp {
    /// Production wiring: the system resolver, the reqwest transport, spec timeouts. `https_only`
    /// is on unless the endpoints are the loopback test endpoints.
    pub fn new(endpoints: Endpoints) -> ReqwestUpdateHttp {
        let timeouts = NetTimeouts::default();
        let https_only = !endpoints.is_loopback();
        ReqwestUpdateHttp {
            endpoints,
            resolver: Arc::new(SystemResolver),
            transport: Arc::new(ReqwestTransport::new(timeouts, https_only)),
            timeouts,
        }
    }

    /// Same wiring with chosen time limits (tests; the real transport).
    pub fn with_timeouts(endpoints: Endpoints, timeouts: NetTimeouts) -> ReqwestUpdateHttp {
        let https_only = !endpoints.is_loopback();
        ReqwestUpdateHttp {
            endpoints,
            resolver: Arc::new(SystemResolver),
            transport: Arc::new(ReqwestTransport::new(timeouts, https_only)),
            timeouts,
        }
    }

    /// Injected parts for tests: a fake resolver, a scripted transport, short timeouts.
    pub fn with_parts(endpoints: Endpoints, resolver: Arc<dyn Resolver>, transport: Arc<dyn Transport>, timeouts: NetTimeouts) -> ReqwestUpdateHttp {
        ReqwestUpdateHttp { endpoints, resolver, transport, timeouts }
    }

    pub fn endpoints(&self) -> &Endpoints {
        &self.endpoints
    }

    /// Resolve the host of `url` ONCE and validate every answer. The IP-literal loopback origin of
    /// the test endpoints needs no resolution.
    async fn pin(&self, url: &ValidatedUrl) -> Result<Option<Pinned>, UpdateError> {
        let host = match url.as_url().host() {
            Some(Host::Domain(d)) => d.to_string(),
            Some(Host::Ipv4(a)) if self.endpoints.is_loopback() && a.is_loopback() => return Ok(None),
            _ => return Err(UpdateError::new(ErrorCode::HostNotAllowed)),
        };
        let port = url.as_url().port_or_known_default().ok_or_else(|| UpdateError::new(ErrorCode::BadUrl))?;
        let resolver = self.resolver.clone();
        let name = host.clone();
        let task = tokio::task::spawn_blocking(move || resolver.resolve(&name, port));
        let ips = match tokio::time::timeout(self.timeouts.connect, task).await {
            Err(_) => return Err(UpdateError::new(ErrorCode::Timeout)),
            Ok(Err(_)) | Ok(Ok(Err(_))) => return Err(UpdateError::with(ErrorCode::Offline, "dns")),
            Ok(Ok(Ok(v))) => v,
        };
        if ips.is_empty() {
            return Err(UpdateError::with(ErrorCode::Offline, "dns"));
        }
        if ips.iter().any(|ip| is_forbidden_address(*ip)) {
            return Err(UpdateError::with(ErrorCode::PrivateAddress, host));
        }
        let mut addrs: Vec<SocketAddr> = Vec::new();
        for ip in ips {
            let a = SocketAddr::new(ip, port);
            if !addrs.contains(&a) && addrs.len() < MAX_PINNED_ADDRS {
                addrs.push(a);
            }
        }
        Ok(Some(Pinned { host, addrs }))
    }

    /// One validated hop: resolve, pin, send; the answer's headers must fit the header cap.
    async fn hop(&self, url: ValidatedUrl, accept: &'static str, wait: Duration) -> Result<HopResponse, UpdateError> {
        if wait.is_zero() {
            return Err(UpdateError::new(ErrorCode::Timeout));
        }
        let started = Instant::now();
        let pinned = self.pin(&url).await?;
        let left = wait.saturating_sub(started.elapsed());
        let req = HopRequest { url, accept, pinned };
        let resp = match tokio::time::timeout(left, self.transport.send(&req)).await {
            Ok(r) => r?,
            Err(_) => return Err(UpdateError::new(ErrorCode::Timeout)),
        };
        let header_bytes: usize = resp.headers.iter().map(|(k, v)| k.len() + v.len()).sum();
        if header_bytes > HEADER_CAP {
            return Err(UpdateError::with(ErrorCode::TooLarge, "headers"));
        }
        Ok(resp)
    }

    /// The target of a redirect answer, validated as an artifact redirect hop.
    fn redirect_target(&self, from: &ValidatedUrl, resp: &HopResponse) -> Result<ValidatedUrl, UpdateError> {
        let mut locations = resp.headers.iter().filter(|(k, _)| k == "location").map(|(_, v)| v.as_str());
        let (Some(loc), None) = (locations.next(), locations.next()) else {
            return Err(UpdateError::with(ErrorCode::RedirectRefused, "location"));
        };
        // Only absolute targets: a relative reference would be normalised by the URL parser before
        // the validator could look at it.
        if !loc.contains("://") {
            return Err(UpdateError::with(ErrorCode::RedirectRefused, "relative"));
        }
        match hop_url(&self.endpoints, Hop::ArtifactRedirect, loc) {
            Ok(v) => Ok(v),
            Err(code) => {
                // GitHub answers a renamed or transferred repository with a redirect to the same host:
                // that is a refused redirect (spec 4.6, T24), not a "new host".
                let same_host = Url::parse(loc)
                    .ok()
                    .and_then(|u| u.host_str().map(|h| from.as_url().host_str().is_some_and(|f| f.eq_ignore_ascii_case(h))))
                    .unwrap_or(false);
                Err(UpdateError::new(if same_host { ErrorCode::RedirectRefused } else { code }))
            }
        }
    }

    async fn feed(&self, file: FeedFile) -> Result<Fetched, UpdateError> {
        let (raw, accept, cap) = match file.kind {
            FeedKind::Json => (self.endpoints.feed_url(file.base, file.channel), "application/json", FEED_MAX_BYTES),
            FeedKind::Sig => (self.endpoints.feed_sig_url(file.base, file.channel), "application/octet-stream", FEED_SIG_MAX_BYTES),
        };
        let raw = raw.ok_or_else(|| UpdateError::new(ErrorCode::BadUrl))?;
        let url = hop_url(&self.endpoints, Hop::FeedFirst, &raw)?;
        let deadline = Instant::now() + self.timeouts.feed_total;
        let resp = self.hop(url, accept, self.timeouts.feed_total).await?;
        if is_redirect_status(resp.status) {
            return Err(UpdateError::with(ErrorCode::RedirectRefused, "feed"));
        }
        if resp.status != 200 {
            return Ok(Fetched { status: resp.status, body: Vec::new() });
        }
        if content_length(&resp.headers)?.is_some_and(|n| n > cap) {
            return Err(UpdateError::new(ErrorCode::FeedTooLarge));
        }
        let mut body = resp.body;
        let mut out: Vec<u8> = Vec::new();
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(UpdateError::new(ErrorCode::Timeout));
            }
            match tokio::time::timeout(left, body.next_chunk()).await {
                Err(_) => return Err(UpdateError::new(ErrorCode::Timeout)),
                // A cut feed is a transport failure, not a damaged download.
                Ok(Err(e)) if e.code == ErrorCode::Truncated => return Err(UpdateError::with(ErrorCode::Offline, "body")),
                Ok(Err(e)) => return Err(e),
                Ok(Ok(None)) => break,
                Ok(Ok(Some(c))) => {
                    if out.len() as u64 + c.len() as u64 > cap {
                        return Err(UpdateError::new(ErrorCode::FeedTooLarge));
                    }
                    out.extend_from_slice(&c);
                }
            }
        }
        Ok(Fetched { status: 200, body: out })
    }

    async fn download(
        &self,
        art: &ArtifactRef,
        dest: &Path,
        cancel: &Cancel,
        on_progress: &(dyn Fn(Progress) + Send + Sync),
    ) -> Result<Downloaded, UpdateError> {
        // Static checks first: nothing is connected to, nothing is created.
        if art.bytes > ARTIFACT_MAX_BYTES {
            return Err(UpdateError::with(ErrorCode::TooLarge, "claim"));
        }
        if art.bytes == 0 {
            return Err(UpdateError::with(ErrorCode::SizeMismatch, "claim"));
        }
        if art.sha256.len() != 64 || !art.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(UpdateError::with(ErrorCode::HashMismatch, "expected"));
        }
        if cancel.is_cancelled() {
            return Err(UpdateError::new(ErrorCode::Cancelled));
        }

        let total_deadline = Instant::now() + self.timeouts.download_total;
        let first = self.endpoints.artifact_url(&art.version, art.arch);
        let mut url = hop_url(&self.endpoints, Hop::ArtifactFirst, &first)?;
        let mut redirects = 0usize;
        let resp = loop {
            let left = total_deadline.saturating_duration_since(Instant::now());
            let wait = self.timeouts.download_idle.min(left);
            let resp = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(UpdateError::new(ErrorCode::Cancelled)),
                r = self.hop(url.clone(), "application/octet-stream", wait) => r?,
            };
            if is_redirect_status(resp.status) {
                if redirects >= MAX_REDIRECTS {
                    return Err(UpdateError::with(ErrorCode::RedirectRefused, "count"));
                }
                url = self.redirect_target(&url, &resp)?;
                redirects += 1;
                continue;
            }
            break resp;
        };
        if resp.status != 200 {
            return Err(UpdateError::with(ErrorCode::BadStatus, resp.status.to_string()));
        }
        if let Some(n) = content_length(&resp.headers)? {
            if n > ARTIFACT_MAX_BYTES {
                return Err(UpdateError::with(ErrorCode::TooLarge, "content-length"));
            }
            if n != art.bytes {
                return Err(UpdateError::with(ErrorCode::SizeMismatch, "content-length"));
            }
        }

        let file = open_part(dest)?;
        let mut guard = PartGuard { path: dest.to_path_buf(), armed: true };
        let mut file = tokio::fs::File::from_std(file);
        let mut ctx = digest::Context::new(&digest::SHA256);
        let mut body = resp.body;
        let mut done: u64 = 0;
        let mut last_emit = Instant::now();
        on_progress(Progress { done: 0, total: art.bytes });
        loop {
            let left = total_deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(UpdateError::new(ErrorCode::Timeout));
            }
            let next = tokio::time::timeout(self.timeouts.download_idle.min(left), body.next_chunk());
            let chunk = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(UpdateError::new(ErrorCode::Cancelled)),
                r = next => match r {
                    Err(_) => return Err(UpdateError::new(ErrorCode::Timeout)),
                    Ok(r) => r?,
                },
            };
            let Some(chunk) = chunk else { break };
            done += chunk.len() as u64;
            if done > art.bytes {
                return Err(UpdateError::with(ErrorCode::TooLarge, "body"));
            }
            ctx.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| map_io(&e))?;
            if last_emit.elapsed() >= PROGRESS_INTERVAL {
                last_emit = Instant::now();
                on_progress(Progress { done, total: art.bytes });
            }
        }
        if done < art.bytes {
            return Err(UpdateError::new(ErrorCode::Truncated));
        }
        file.flush().await.map_err(|e| map_io(&e))?;
        file.sync_all().await.map_err(|e| map_io(&e))?;
        drop(file);
        let sha256 = hex::encode(ctx.finish().as_ref());
        if sha256 != art.sha256 {
            return Err(UpdateError::new(ErrorCode::HashMismatch));
        }
        on_progress(Progress { done, total: art.bytes });
        guard.armed = false;
        Ok(Downloaded { bytes: done, sha256 })
    }
}

impl UpdateHttp for ReqwestUpdateHttp {
    fn fetch_feed<'a>(&'a self, file: FeedFile) -> NetFuture<'a, Fetched> {
        Box::pin(self.feed(file))
    }

    fn download_artifact<'a>(
        &'a self,
        art: &'a ArtifactRef,
        dest: &'a Path,
        cancel: &'a Cancel,
        on_progress: &'a (dyn Fn(Progress) + Send + Sync),
    ) -> NetFuture<'a, Downloaded> {
        Box::pin(self.download(art, dest, cancel, on_progress))
    }
}

// ------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------

fn is_redirect_status(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

/// The single, numeric Content-Length of a response, if any (a malformed or conflicting header is
/// a `badStatus`).
fn content_length(headers: &[(String, String)]) -> Result<Option<u64>, UpdateError> {
    let mut found: Option<u64> = None;
    for (k, v) in headers {
        if k != "content-length" {
            continue;
        }
        let n: u64 = v.trim().parse().map_err(|_| UpdateError::with(ErrorCode::BadStatus, "content-length"))?;
        if found.is_some_and(|f| f != n) {
            return Err(UpdateError::with(ErrorCode::BadStatus, "content-length"));
        }
        found = Some(n);
    }
    Ok(found)
}

/// `<dest>` created 0600, `O_CREAT|O_EXCL|O_NOFOLLOW`: an existing file or a pre-planted symlink is
/// refused and left alone.
fn open_part(dest: &Path) -> Result<std::fs::File, UpdateError> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dest)
        .map_err(|e| map_io(&e))
}

fn map_io(e: &std::io::Error) -> UpdateError {
    let code = match e.raw_os_error() {
        Some(n) if n == libc::ENOSPC || n == libc::EDQUOT => ErrorCode::NoSpace,
        Some(n) if n == libc::EROFS => ErrorCode::ReadOnlyVolume,
        Some(n) if n == libc::EEXIST || n == libc::ELOOP => ErrorCode::AlreadyRunning,
        _ => match e.kind() {
            std::io::ErrorKind::AlreadyExists => ErrorCode::AlreadyRunning,
            _ => ErrorCode::NotWritable,
        },
    };
    UpdateError::with(code, "partFile")
}

/// Deletes the `.part` file this download created, on every exit except success (including a
/// dropped future).
struct PartGuard {
    path: PathBuf,
    armed: bool,
}

impl Drop for PartGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
