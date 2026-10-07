//! Strict semver, channels, architectures ((design notes: updater-spec) 4.6, 4.8).

use semver::Version;
use std::cmp::Ordering;

use crate::limits::VERSION_MAX_LEN;
use crate::ErrorCode;

/// Parse a version the way the feed and the tags spell it: `MAJOR.MINOR.PATCH[-pre]`, no leading
/// `v`, no build metadata, no leading zeros, at most 64 characters, ASCII only.
pub fn parse_strict(s: &str) -> Result<Version, ErrorCode> {
    if s.is_empty() || s.len() > VERSION_MAX_LEN || !s.is_ascii() {
        return Err(ErrorCode::FeedInvalid);
    }
    if s.starts_with('v') || s.starts_with('V') || s.contains('+') || s.chars().any(char::is_whitespace) {
        return Err(ErrorCode::FeedInvalid);
    }
    let v = Version::parse(s).map_err(|_| ErrorCode::FeedInvalid)?;
    if !v.build.is_empty() {
        return Err(ErrorCode::FeedInvalid);
    }
    Ok(v)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Channel {
    Stable,
    Alpha,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Alpha => "alpha",
        }
    }

    pub fn parse(s: &str) -> Option<Channel> {
        match s {
            "stable" => Some(Channel::Stable),
            "alpha" => Some(Channel::Alpha),
            _ => None,
        }
    }

    /// The feed files a release is published into: a release without a pre-release part goes into
    /// `stable` and `alpha`, a release with one (`-alpha.N`, `-rc.N`) only into `alpha` (4.8).
    pub fn channels_for_release(v: &Version) -> &'static [Channel] {
        if v.pre.is_empty() {
            &[Channel::Stable, Channel::Alpha]
        } else {
            &[Channel::Alpha]
        }
    }

    /// The stable channel never carries a pre-release part.
    pub fn accepts(self, v: &Version) -> bool {
        match self {
            Channel::Stable => v.pre.is_empty(),
            Channel::Alpha => true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Arch {
    X64,
    Aarch64,
}

impl Arch {
    /// Architecture of the running binary.
    pub fn current() -> Arch {
        if cfg!(target_arch = "aarch64") {
            Arch::Aarch64
        } else {
            Arch::X64
        }
    }

    /// File-name token (`IntelyIDE_<version>_<token>.app.tar.gz`).
    pub fn token(self) -> &'static str {
        match self {
            Arch::X64 => "x64",
            Arch::Aarch64 => "aarch64",
        }
    }

    /// Key in the feed's `platforms` map.
    pub fn platform_key(self) -> &'static str {
        match self {
            Arch::X64 => "darwin-x86_64",
            Arch::Aarch64 => "darwin-aarch64",
        }
    }

    pub fn from_platform_key(k: &str) -> Option<Arch> {
        match k {
            "darwin-x86_64" => Some(Arch::X64),
            "darwin-aarch64" => Some(Arch::Aarch64),
            _ => None,
        }
    }

    pub const ALL: [Arch; 2] = [Arch::X64, Arch::Aarch64];
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// `candidate > current` by semver precedence.
    Newer,
    /// Equal or lower: never offered, never a downgrade.
    UpToDate,
    /// The candidate is lower than the highest version ever verified (a replayed older feed).
    FeedWentBackwards,
}

/// The pure version decision of 4.6 step 3.
pub fn decide(current: &Version, candidate: &Version, highest_seen: Option<&Version>) -> Decision {
    if candidate.cmp_precedence(current) != Ordering::Greater {
        return Decision::UpToDate;
    }
    if let Some(h) = highest_seen {
        if candidate.cmp_precedence(h) == Ordering::Less {
            return Decision::FeedWentBackwards;
        }
    }
    Decision::Newer
}

/// `minOs`: one to three dot-separated numbers ("13", "13.5", "13.5.1").
pub fn parse_os_version(s: &str) -> Option<Vec<u32>> {
    if s.is_empty() || s.len() > 16 {
        return None;
    }
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() > 3 {
        return None;
    }
    let mut out = Vec::new();
    for p in parts {
        if p.is_empty() || p.len() > 4 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        if p.len() > 1 && p.starts_with('0') {
            return None;
        }
        out.push(p.parse().ok()?);
    }
    Some(out)
}

/// True when `running` (from `sw_vers`) is at least `required`.
pub fn os_at_least(running: &str, required: &str) -> bool {
    let (Some(r), Some(q)) = (parse_os_version(running), parse_os_version(required)) else {
        return false;
    };
    for i in 0..3 {
        let a = r.get(i).copied().unwrap_or(0);
        let b = q.get(i).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    true
}
