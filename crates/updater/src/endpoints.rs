//! Single source of the repository slug, the Pages host and path, the raw mirror and the CDN
//! suffix; URL builders and the hop validators ((design notes: updater-spec) 4.6 "Hosts").
//!
//! Everything in the production constants is compiled into every installed client and cannot be
//! changed by an update: the owner confirms them at gate G0 before the key ceremony.
//! `scripts/release/updater/names.mjs`, `site/site.config.json`, the notes-link prefixes of the UI
//! and CODEOWNERS are checked against this file by `check-updater-config.mjs`.

use semver::Version;
use url::{Host, Url};

use crate::version::{Arch, Channel};
use crate::ErrorCode;

pub const REPO_OWNER: &str = "ferencfarkas09";
pub const REPO_NAME: &str = "IntelyIDE";
/// `ferencfarkas09/IntelyIDE`
pub const REPO_SLUG: &str = "ferencfarkas09/IntelyIDE";
/// The product name used in artifact file names (`tauri.conf.json productName`).
pub const PRODUCT_NAME: &str = "IntelyIDE";

/// Feed base 1: GitHub Pages.
pub const PAGES_HOST: &str = "ferencfarkas09.github.io";
pub const PAGES_BASE_PATH: &str = "/IntelyIDE";
/// Feed base 2: the same committed bytes, served by the raw mirror.
pub const RAW_HOST: &str = "raw.githubusercontent.com";
pub const RAW_FEED_DIR: &str = "/ferencfarkas09/IntelyIDE/main/site/data/update";
/// First hop of an artifact download.
pub const RELEASE_HOST: &str = "github.com";
pub const RELEASE_PATH_PREFIX: &str = "/ferencfarkas09/IntelyIDE/releases/download/";
/// Redirect hops of an artifact download: `<at least one label>` + this suffix.
pub const CDN_SUFFIX: &str = ".githubusercontent.com";

/// The pages "Open the download page" opens (constants, never taken from the feed).
pub const DOWNLOAD_PAGE_URL: &str = "https://ferencfarkas09.github.io/IntelyIDE/";
pub const RELEASES_PAGE_URL: &str = "https://github.com/ferencfarkas09/IntelyIDE/releases";

/// Hosts and path prefixes a link in the notes or `notesUrl` may point to (spec 4.6
/// `validate_project_link`; the UI's table is generated from the same pair).
pub const PROJECT_LINK_PREFIXES: [(&str, &str); 2] =
    [("github.com", "/ferencfarkas09/IntelyIDE/"), ("ferencfarkas09.github.io", "/IntelyIDE/")];

/// What the next request of a transfer is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hop {
    /// First request for a feed or its signature (no redirect is ever followed for these).
    FeedFirst,
    /// First request for an artifact (no query string).
    ArtifactFirst,
    /// A redirect target of an artifact download (a query string is allowed here).
    ArtifactRedirect,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Mode {
    Production,
    /// `http://127.0.0.1:<port>`, only for the E2E harness and tests.
    Loopback { port: u16 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoints {
    mode: Mode,
}

/// Artifact file name: `IntelyIDE_<version>_<arch>.app.tar.gz`.
pub fn artifact_name(version: &Version, arch: Arch) -> String {
    format!("{PRODUCT_NAME}_{version}_{}.app.tar.gz", arch.token())
}

/// Release tag: `v<version>`.
pub fn tag_name(version: &Version) -> String {
    format!("v{version}")
}

impl Endpoints {
    pub fn production() -> Endpoints {
        Endpoints { mode: Mode::Production }
    }

    /// Loopback endpoints for the E2E harness and tests (hook class A, spec 8.3): absent from
    /// release builds unless the `loopback` feature is enabled. `origin` must be exactly
    /// `http://127.0.0.1:<port>`.
    #[cfg(any(debug_assertions, feature = "loopback"))]
    pub fn loopback(origin: &str) -> Result<Endpoints, ErrorCode> {
        let rest = origin.strip_prefix("http://127.0.0.1:").ok_or(ErrorCode::HostNotAllowed)?;
        if rest.is_empty() || rest.len() > 5 || !rest.bytes().all(|b| b.is_ascii_digit()) {
            return Err(ErrorCode::HostNotAllowed);
        }
        let port: u16 = rest.parse().map_err(|_| ErrorCode::HostNotAllowed)?;
        if port == 0 {
            return Err(ErrorCode::HostNotAllowed);
        }
        Ok(Endpoints { mode: Mode::Loopback { port } })
    }

    pub fn is_loopback(&self) -> bool {
        matches!(self.mode, Mode::Loopback { .. })
    }

    fn origin(&self) -> Option<String> {
        match self.mode {
            Mode::Production => None,
            Mode::Loopback { port } => Some(format!("http://127.0.0.1:{port}")),
        }
    }

    /// Number of feed bases (2 in production, 1 on loopback).
    pub fn feed_base_count(&self) -> usize {
        if self.is_loopback() {
            1
        } else {
            FEED_BASES.len()
        }
    }

    /// Feed URL of base `base` (0 = Pages, 1 = raw mirror) for `channel`.
    pub fn feed_url(&self, base: usize, channel: Channel) -> Option<String> {
        if let Some(o) = self.origin() {
            return (base == 0).then(|| format!("{o}/update/{}.json", channel.as_str()));
        }
        FEED_BASES.get(base).map(|b| format!("https://{}{}/{}.json", b.host, b.dir, channel.as_str()))
    }

    pub fn feed_sig_url(&self, base: usize, channel: Channel) -> Option<String> {
        self.feed_url(base, channel).map(|u| format!("{u}.sig"))
    }

    /// The only URL an artifact may have; the feed's `url` field must equal it.
    pub fn artifact_url(&self, version: &Version, arch: Arch) -> String {
        let name = artifact_name(version, arch);
        let tag = tag_name(version);
        match self.origin() {
            Some(o) => format!("{o}/releases/download/{tag}/{name}"),
            None => format!("https://{RELEASE_HOST}{RELEASE_PATH_PREFIX}{tag}/{name}"),
        }
    }

    /// Validate the next request URL of a transfer. Nothing in `net.rs` accepts a URL that has
    /// not passed this function. Codes: an unparsable or non-normalised URL, userinfo or a
    /// non-https scheme/port on a first hop is `badUrl` / `hostNotAllowed`; a redirect hop with a
    /// wrong scheme is `redirectRefused`, with a wrong host `hostNotAllowed`.
    pub fn validate_hop(&self, hop: Hop, raw: &str) -> Result<Url, ErrorCode> {
        let max_len = if hop == Hop::ArtifactRedirect { MAX_REDIRECT_URL_BYTES } else { MAX_URL_BYTES };
        let parts = split_raw(raw, max_len).ok_or(ErrorCode::BadUrl)?;
        let url = Url::parse(raw).map_err(|_| ErrorCode::BadUrl)?;
        if !url.username().is_empty() || url.password().is_some() || parts.authority.contains('@') {
            return Err(ErrorCode::HostNotAllowed);
        }
        if !path_is_clean(&parts, &url) {
            return Err(ErrorCode::BadUrl);
        }
        if url.fragment().is_some() {
            return Err(ErrorCode::BadUrl);
        }
        let redirect = hop == Hop::ArtifactRedirect;
        let scheme_err = if redirect { ErrorCode::RedirectRefused } else { ErrorCode::HostNotAllowed };

        match self.mode {
            Mode::Production => {
                if url.scheme() != "https" {
                    return Err(scheme_err);
                }
                // No port at all (the url crate drops an explicit :443, so look at the raw text).
                if parts.authority.contains(':') || url.port().is_some() {
                    return Err(ErrorCode::HostNotAllowed);
                }
                let host = match url.host() {
                    Some(Host::Domain(d)) => d.to_string(),
                    _ => return Err(ErrorCode::HostNotAllowed),
                };
                match hop {
                    Hop::FeedFirst => {
                        if url.query().is_some() {
                            return Err(ErrorCode::BadUrl);
                        }
                        let ok = (host == PAGES_HOST
                            && all_channels().any(|c| {
                                let p = format!("{PAGES_BASE_PATH}/update/{}.json", c.as_str());
                                url.path() == p || url.path() == format!("{p}.sig")
                            }))
                            || (host == RAW_HOST
                                && all_channels().any(|c| {
                                    let p = format!("{RAW_FEED_DIR}/{}.json", c.as_str());
                                    url.path() == p || url.path() == format!("{p}.sig")
                                }));
                        if ok {
                            Ok(url)
                        } else {
                            Err(ErrorCode::HostNotAllowed)
                        }
                    }
                    Hop::ArtifactFirst => {
                        if url.query().is_some() {
                            return Err(ErrorCode::BadUrl);
                        }
                        if host == RELEASE_HOST && url.path().starts_with(RELEASE_PATH_PREFIX) {
                            Ok(url)
                        } else {
                            Err(ErrorCode::HostNotAllowed)
                        }
                    }
                    Hop::ArtifactRedirect => {
                        if is_cdn_host(&host) {
                            Ok(url)
                        } else {
                            Err(ErrorCode::HostNotAllowed)
                        }
                    }
                }
            }
            Mode::Loopback { port } => {
                let is_origin = url.scheme() == "http"
                    && matches!(url.host(), Some(Host::Ipv4(a)) if a.octets() == [127, 0, 0, 1])
                    && url.port() == Some(port);
                match hop {
                    Hop::FeedFirst => {
                        let ok = is_origin
                            && url.query().is_none()
                            && all_channels().any(|c| {
                                let p = format!("/update/{}.json", c.as_str());
                                url.path() == p || url.path() == format!("{p}.sig")
                            });
                        if ok {
                            Ok(url)
                        } else {
                            Err(ErrorCode::HostNotAllowed)
                        }
                    }
                    Hop::ArtifactFirst => {
                        if is_origin && url.query().is_none() && url.path().starts_with("/releases/download/") {
                            Ok(url)
                        } else {
                            Err(ErrorCode::HostNotAllowed)
                        }
                    }
                    Hop::ArtifactRedirect => {
                        // The harness serves redirects from its own origin; the CDN rule still applies
                        // to https hops so a fake resolver can exercise it.
                        if is_origin {
                            return Ok(url);
                        }
                        if url.scheme() != "https" {
                            return Err(scheme_err);
                        }
                        match url.host() {
                            Some(Host::Domain(d)) if is_cdn_host(d) && url.port().is_none() => Ok(url),
                            _ => Err(ErrorCode::HostNotAllowed),
                        }
                    }
                }
            }
        }
    }
}

fn all_channels() -> impl Iterator<Item = Channel> {
    [Channel::Stable, Channel::Alpha].into_iter()
}

struct FeedBase {
    host: &'static str,
    dir: &'static str,
}

/// The two feed bases in order (4.6): Pages first, the raw mirror after a 404, 5xx or transport
/// error (never after a verification failure).
const FEED_BASES: [FeedBase; 2] = [
    FeedBase { host: PAGES_HOST, dir: "/IntelyIDE/update" },
    FeedBase { host: RAW_HOST, dir: RAW_FEED_DIR },
];

/// `<label>(.<label>)*` + `.githubusercontent.com`, with at least one label in front and only
/// letters, digits and hyphens in the labels (`evilgithubusercontent.com` does not qualify).
pub fn is_cdn_host(host: &str) -> bool {
    let Some(front) = host.strip_suffix(CDN_SUFFIX) else {
        return false;
    };
    !front.is_empty()
        && front.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

struct RawParts<'a> {
    authority: &'a str,
    path: &'a str,
}

/// Longest URL accepted on a first hop or as a project link.
const MAX_URL_BYTES: usize = 2048;
/// Longest redirect target: signed CDN URLs carry a JWT or SAS query that can pass 2 KiB.
const MAX_REDIRECT_URL_BYTES: usize = 8192;

/// Split `https://authority/path?query#frag` from the RAW text (the url crate normalises `..`,
/// `\\` and `:443`, which is exactly what must not be trusted). Rejects control characters,
/// whitespace, backslashes and non-ASCII.
fn split_raw(raw: &str, max_len: usize) -> Option<RawParts<'_>> {
    if raw.is_empty() || raw.len() > max_len || !raw.is_ascii() {
        return None;
    }
    if raw.bytes().any(|b| b <= b' ' || b == 0x7f || b == b'\\') {
        return None;
    }
    let rest = raw.split_once("://")?.1;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let after = &rest[end..];
    let pend = after.find(['?', '#']).unwrap_or(after.len());
    Some(RawParts { authority, path: &after[..pend] })
}

/// The raw path has no `.`/`..` segment, no empty segment (`//`), no encoded dot, slash or
/// backslash, and the url crate would not have changed it.
fn path_is_clean(parts: &RawParts<'_>, url: &Url) -> bool {
    let p = parts.path;
    if p.is_empty() || !p.starts_with('/') || p != url.path() {
        return false;
    }
    let lower = p.to_ascii_lowercase();
    if lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c") || lower.contains("%00") {
        return false;
    }
    let segs: Vec<&str> = p[1..].split('/').collect();
    let last = segs.len() - 1;
    for (i, s) in segs.iter().enumerate() {
        if *s == "." || *s == ".." {
            return false;
        }
        if s.is_empty() && i != last {
            return false;
        }
    }
    true
}

/// The link rule of spec 4.6, used for `notesUrl`, for links inside the notes and again at the
/// Rust boundary of `update_open_page`. The TypeScript twin in `ui/src/modules/updater/notes.ts`
/// is tested with the same table (`tests/fixtures/project_links.json`).
///
/// Scheme `https`, no userinfo, no port, host exactly `github.com` or `ferencfarkas09.github.io`
/// (case-insensitive like a URL parser), and a NORMALISED path (no `.`/`..` segment, no `%2e`,
/// `%2f`, `%5c`, no backslash, no repeated slash, case-sensitive) under `/ferencfarkas09/IntelyIDE/`
/// (github.com) or `/IntelyIDE/` (ferencfarkas09.github.io).
pub fn validate_project_link(raw: &str) -> Option<Url> {
    let parts = split_raw(raw, MAX_URL_BYTES)?;
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    if parts.authority.contains('@') || parts.authority.contains(':') {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return None;
    }
    let host = match url.host() {
        Some(Host::Domain(d)) => d,
        _ => return None,
    };
    if !parts.authority.eq_ignore_ascii_case(host) {
        return None;
    }
    if !path_is_clean(&parts, &url) {
        return None;
    }
    let ok = PROJECT_LINK_PREFIXES.iter().any(|(h, prefix)| host == *h && url.path().starts_with(prefix));
    ok.then_some(url)
}
