//! The signed feed: parse and validate (schema 1), the sequence rule and the kill-switch verdicts
//! ((design notes: updater-spec) 4.6). Pure: no I/O, no clock (callers pass `now`).
//!
//! Signature verification is `verify.rs`; this module only sees bytes that already verified.

use semver::Version;
use serde::Deserialize;

use crate::endpoints::{validate_project_link, Endpoints};
use crate::keys::{is_key_id, Role, INITIAL_FEED_FLOOR};
use crate::limits::*;
use crate::version::{self, Arch, Channel};
use crate::ErrorCode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockReason {
    UpdaterBug,
    Migration,
    Security,
}

impl BlockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            BlockReason::UpdaterBug => "updaterBug",
            BlockReason::Migration => "migration",
            BlockReason::Security => "security",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockInstall {
    pub up_to: Version,
    pub reason: BlockReason,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// Equal to `Endpoints::artifact_url` (checked at parse time).
    pub url: String,
    /// Base64 of the artifact's `.sig` file.
    pub signature: String,
    pub bytes: u64,
    /// 64 lowercase hex.
    pub sha256: String,
    pub unpacked_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Feed {
    pub channel: Channel,
    pub seq: u64,
    /// Informational only (log, Settings): never used to accept or reject.
    pub generated_at: String,
    /// Unix seconds. After it the UI says "update information is stale"; never rejects.
    pub valid_until: Option<i64>,
    pub version: Version,
    pub pub_date: Option<String>,
    pub notes: String,
    pub notes_url: Option<String>,
    pub min_os: Option<String>,
    pub native_switch_ok: bool,
    pub entitlements_change: bool,
    pub platforms: Vec<(Arch, Entry)>,
    /// Upper-case key ids.
    pub revoke: Vec<String>,
    pub floor_reset: Option<u64>,
    pub block_install: Vec<BlockInstall>,
    pub withdrawn: Vec<Version>,
    pub min_from: Option<Version>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFeed {
    channel: String,
    seq: u64,
    generated_at: String,
    valid_until: Option<String>,
    version: String,
    #[serde(rename = "pub_date")]
    pub_date: Option<String>,
    #[serde(default)]
    notes: String,
    notes_url: Option<String>,
    min_os: Option<String>,
    #[serde(default)]
    native_switch_ok: bool,
    #[serde(default)]
    entitlements_change: bool,
    #[serde(default)]
    platforms: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    revoke: Vec<String>,
    floor_reset: Option<u64>,
    #[serde(default)]
    block_install: Vec<RawBlock>,
    #[serde(default)]
    withdrawn: Vec<String>,
    min_from: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBlock {
    up_to: String,
    reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEntry {
    url: String,
    signature: String,
    bytes: u64,
    sha256: String,
    unpacked_bytes: u64,
}

/// What the verified feed says about installing `candidate` on a running `current` (4.6 kill switches).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verdict {
    /// `blockInstall` matched: the version is announced, installability is `blockedByFeed`.
    pub block: Option<BlockReason>,
    /// The candidate version is listed in `withdrawn`: never offered, a ready stage is dropped.
    pub withdrawn: bool,
    /// `current < minFrom`: manual download or an intermediate release.
    pub too_old_for_direct: bool,
    /// `validUntil` has passed: the UI shows the freeze notice.
    pub stale: bool,
}

impl Feed {
    /// Parse and validate the bytes of a feed that already passed signature verification.
    /// `expected` is the channel that was requested; `endpoints` rebuilds the artifact URLs.
    pub fn parse(bytes: &[u8], expected: Channel, endpoints: &Endpoints) -> Result<Feed, ErrorCode> {
        if bytes.len() as u64 > FEED_MAX_BYTES {
            return Err(ErrorCode::FeedTooLarge);
        }
        let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| ErrorCode::FeedInvalid)?;
        let obj = value.as_object().ok_or(ErrorCode::FeedInvalid)?;
        match obj.get("schema").and_then(|s| s.as_u64()) {
            Some(1) => {}
            Some(_) => return Err(ErrorCode::FeedSchema),
            None => {
                // A schema we cannot even read as a number is a schema we do not know.
                return Err(if obj.contains_key("schema") { ErrorCode::FeedSchema } else { ErrorCode::FeedInvalid });
            }
        }
        let raw: RawFeed = serde_json::from_value(value).map_err(|_| ErrorCode::FeedInvalid)?;

        let channel = Channel::parse(&raw.channel).ok_or(ErrorCode::FeedChannel)?;
        if channel != expected {
            return Err(ErrorCode::FeedChannel);
        }
        if raw.seq < 1 || raw.seq > SEQ_MAX {
            return Err(ErrorCode::FeedInvalid);
        }
        parse_rfc3339(&raw.generated_at).ok_or(ErrorCode::FeedInvalid)?;
        let valid_until = match &raw.valid_until {
            Some(s) => Some(parse_rfc3339(s).ok_or(ErrorCode::FeedInvalid)?),
            None => None,
        };
        if let Some(p) = &raw.pub_date {
            parse_rfc3339(p).ok_or(ErrorCode::FeedInvalid)?;
        }
        let ver = version::parse_strict(&raw.version)?;
        if !channel.accepts(&ver) {
            return Err(ErrorCode::FeedInvalid);
        }
        validate_notes(&raw.notes)?;
        if let Some(u) = &raw.notes_url {
            if validate_project_link(u).is_none() {
                return Err(ErrorCode::FeedInvalid);
            }
        }
        if let Some(m) = &raw.min_os {
            version::parse_os_version(m).ok_or(ErrorCode::FeedInvalid)?;
        }
        if let Some(r) = raw.floor_reset {
            if r < 1 || r > SEQ_MAX {
                return Err(ErrorCode::FeedInvalid);
            }
        }

        if raw.revoke.len() > REVOKE_MAX || raw.block_install.len() > BLOCK_INSTALL_MAX || raw.withdrawn.len() > WITHDRAWN_MAX {
            return Err(ErrorCode::FeedInvalid);
        }
        let mut revoke = Vec::new();
        for id in &raw.revoke {
            if !is_key_id(id) {
                return Err(ErrorCode::FeedInvalid);
            }
            revoke.push(id.to_ascii_uppercase());
        }
        let mut block_install = Vec::new();
        for b in &raw.block_install {
            let reason = match b.reason.as_str() {
                "updaterBug" => BlockReason::UpdaterBug,
                "migration" => BlockReason::Migration,
                "security" => BlockReason::Security,
                _ => return Err(ErrorCode::FeedInvalid),
            };
            block_install.push(BlockInstall { up_to: version::parse_strict(&b.up_to)?, reason });
        }
        let mut withdrawn = Vec::new();
        for w in &raw.withdrawn {
            withdrawn.push(version::parse_strict(w)?);
        }
        let min_from = match &raw.min_from {
            Some(m) => Some(version::parse_strict(m)?),
            None => None,
        };

        let mut platforms = Vec::new();
        for (key, v) in &raw.platforms {
            // Platforms we do not know are ignored like any unknown field.
            let Some(arch) = Arch::from_platform_key(key) else { continue };
            let e: RawEntry = serde_json::from_value(v.clone()).map_err(|_| ErrorCode::FeedInvalid)?;
            platforms.push((arch, validate_entry(e, &ver, arch, endpoints)?));
        }
        platforms.sort_by_key(|(a, _)| a.token());

        Ok(Feed {
            channel,
            seq: raw.seq,
            generated_at: raw.generated_at,
            valid_until,
            version: ver,
            pub_date: raw.pub_date,
            notes: raw.notes,
            notes_url: raw.notes_url,
            min_os: raw.min_os,
            native_switch_ok: raw.native_switch_ok,
            entitlements_change: raw.entitlements_change,
            platforms,
            revoke,
            floor_reset: raw.floor_reset,
            block_install,
            withdrawn,
            min_from,
        })
    }

    /// The entry for `arch`, or `noPlatform`.
    pub fn entry_for(&self, arch: Arch) -> Result<&Entry, ErrorCode> {
        self.platforms.iter().find(|(a, _)| *a == arch).map(|(_, e)| e).ok_or(ErrorCode::NoPlatform)
    }

    /// Kill-switch evaluation for a client running `current`. `now` is unix seconds and only
    /// feeds the `stale` flag.
    pub fn verdict(&self, current: &Version, now: i64) -> Verdict {
        let block = self
            .block_install
            .iter()
            .find(|b| current.cmp_precedence(&b.up_to) != std::cmp::Ordering::Greater)
            .map(|b| b.reason);
        let withdrawn = self.withdrawn.iter().any(|w| w.cmp_precedence(&self.version).is_eq());
        let too_old_for_direct = self
            .min_from
            .as_ref()
            .is_some_and(|m| current.cmp_precedence(m) == std::cmp::Ordering::Less);
        let stale = self.valid_until.is_some_and(|u| now > u);
        Verdict { block, withdrawn, too_old_for_direct, stale }
    }

    /// True when `v` is listed in `withdrawn` (also used for a cached `Available` or a ready stage).
    pub fn is_withdrawn(&self, v: &Version) -> bool {
        self.withdrawn.iter().any(|w| w.cmp_precedence(v).is_eq())
    }
}

fn validate_entry(e: RawEntry, ver: &Version, arch: Arch, endpoints: &Endpoints) -> Result<Entry, ErrorCode> {
    if e.url != endpoints.artifact_url(ver, arch) {
        return Err(ErrorCode::BadUrl);
    }
    if e.signature.is_empty()
        || e.signature.len() > ENTRY_SIG_MAX_BYTES
        || !e.signature.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
    {
        return Err(ErrorCode::FeedInvalid);
    }
    if e.bytes > ARTIFACT_MAX_BYTES {
        return Err(ErrorCode::TooLarge);
    }
    if e.bytes < ARTIFACT_MIN_BYTES {
        return Err(ErrorCode::FeedInvalid);
    }
    if e.unpacked_bytes == 0 {
        return Err(ErrorCode::FeedInvalid);
    }
    if e.unpacked_bytes > UNPACKED_MAX_BYTES {
        return Err(ErrorCode::TooLarge);
    }
    if e.sha256.len() != 64 || !e.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(ErrorCode::FeedInvalid);
    }
    Ok(Entry { url: e.url, signature: e.signature, bytes: e.bytes, sha256: e.sha256, unpacked_bytes: e.unpacked_bytes })
}

/// Unicode format characters (bidi overrides and isolates, zero width, joiners, tag characters,
/// soft hyphen, BOM, interlinear annotation) plus the line and paragraph separators.
pub fn is_forbidden_format_char(c: char) -> bool {
    matches!(c as u32,
        0x00AD
        | 0x0600..=0x0605
        | 0x061C
        | 0x06DD
        | 0x070F
        | 0x08E2
        | 0x180E
        | 0x200B..=0x200F
        | 0x2028..=0x202E
        | 0x2060..=0x206F
        | 0xFEFF
        | 0xFFF9..=0xFFFB
        | 0x110BD
        | 0x110CD
        | 0x1BCA0..=0x1BCA3
        | 0x1D173..=0x1D17A
        | 0xE0001
        | 0xE0020..=0xE007F)
}

/// Notes: at most 8 KiB and 200 lines, no control character except `\n` and `\t`, no format
/// character. The renderer in the UI re-checks the same rules.
pub fn validate_notes(notes: &str) -> Result<(), ErrorCode> {
    if notes.len() > NOTES_MAX_BYTES || notes.lines().count() > NOTES_MAX_LINES {
        return Err(ErrorCode::FeedInvalid);
    }
    for c in notes.chars() {
        if (c.is_control() && c != '\n' && c != '\t') || is_forbidden_format_char(c) {
            return Err(ErrorCode::FeedInvalid);
        }
    }
    Ok(())
}

/// Result of the sequence rule (4.6 step 2b).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SeqDecision {
    /// The value to persist as `floor[channel]` once the whole feed was accepted.
    pub new_floor: u64,
    /// A `floorReset` was present but the signer is not the standby: it was ignored.
    pub floor_reset_ignored: bool,
}

/// The monotonic `seq` rule. A Feed key needs `max(floor, initial) <= seq <= that + 1000` (an
/// older feed, or a jump above 1000, is `feedStale`, so a stolen Feed key cannot poison the floor
/// beyond the standby's reach). The standby bypasses the floor; its `floorReset` sets the floor
/// exactly, otherwise the floor moves up to `seq` and never down. No wall clock is involved.
pub fn check_seq(
    signer: Role,
    floor: Option<u64>,
    initial_floor: u64,
    seq: u64,
    floor_reset: Option<u64>,
) -> Result<SeqDecision, ErrorCode> {
    let base = floor.unwrap_or(0).max(initial_floor);
    match signer {
        Role::FeedStandby => {
            let new_floor = floor_reset.unwrap_or_else(|| base.max(seq));
            Ok(SeqDecision { new_floor, floor_reset_ignored: false })
        }
        Role::Feed => {
            if seq < base || seq > base.saturating_add(SEQ_MAX_JUMP) {
                return Err(ErrorCode::FeedStale);
            }
            Ok(SeqDecision { new_floor: seq, floor_reset_ignored: floor_reset.is_some() })
        }
        // An Artifact key never signs a feed (verify.rs refuses it earlier); fail closed.
        Role::Artifact => Err(ErrorCode::FeedSignature),
    }
}

/// `check_seq` with the compiled-in `INITIAL_FEED_FLOOR`.
pub fn check_seq_production(
    signer: Role,
    floor: Option<u64>,
    seq: u64,
    floor_reset: Option<u64>,
) -> Result<SeqDecision, ErrorCode> {
    check_seq(signer, floor, INITIAL_FEED_FLOOR, seq, floor_reset)
}

/// Parse an RFC 3339 timestamp (`YYYY-MM-DDTHH:MM:SS[.fraction](Z|+HH:MM|-HH:MM)`) to unix seconds.
/// Strict: upper-case `T` and `Z`, a real calendar date, no leap second.
pub fn parse_rfc3339(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b.len() > 35 || !s.is_ascii() {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let part = &s[from..to];
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok()).flatten()
    };
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || h > 23 || mi > 59 || sec > 59 || y < 1970 {
        return None;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let mdays = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if d < 1 || d > mdays[(mo - 1) as usize] {
        return None;
    }
    let mut i = 19;
    if b[i] == b'.' {
        let start = i + 1;
        i = start;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start || i - start > 9 {
            return None;
        }
    }
    let offset = match b.get(i)? {
        b'Z' if i + 1 == b.len() => 0,
        b'+' | b'-' if i + 6 == b.len() && b[i + 3] == b':' => {
            let (oh, om) = (num(i + 1, i + 3)?, num(i + 4, i + 6)?);
            if oh > 23 || om > 59 {
                return None;
            }
            let o = oh * 3600 + om * 60;
            if b[i] == b'+' { o } else { -o }
        }
        _ => return None,
    };
    // days from civil (Howard Hinnant)
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * ((mo + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86400 + h * 3600 + mi * 60 + sec - offset)
}
