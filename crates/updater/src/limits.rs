//! Every numeric limit of the updater in one place ((design notes: updater-spec) 4.6, "Limits").
//! Each value has a boundary test in `tests/limits.rs` or in the test file of the module that enforces it.

use std::time::Duration;

pub const KIB: u64 = 1024;
pub const MIB: u64 = 1024 * KIB;
pub const GIB: u64 = 1024 * MIB;

/// Feed body and its signature file.
pub const FEED_MAX_BYTES: u64 = 256 * KIB;
pub const FEED_SIG_MAX_BYTES: u64 = 4 * KIB;
/// `platforms.<key>.signature` (base64 of an artifact `.sig`).
pub const ENTRY_SIG_MAX_BYTES: usize = (2 * KIB) as usize;

pub const NOTES_MAX_BYTES: usize = (8 * KIB) as usize;
pub const NOTES_MAX_LINES: usize = 200;

pub const REVOKE_MAX: usize = 8;
pub const BLOCK_INSTALL_MAX: usize = 4;
pub const WITHDRAWN_MAX: usize = 16;

/// Artifact `bytes` (the tarball size the feed pins).
pub const ARTIFACT_MIN_BYTES: u64 = MIB;
pub const ARTIFACT_MAX_BYTES: u64 = 512 * MIB;

/// Unpacked total, entries, path length, depth.
pub const UNPACKED_MAX_BYTES: u64 = GIB + GIB / 2;
pub const UNPACK_MAX_ENTRIES: usize = 50_000;
pub const UNPACK_MAX_PATH_BYTES: usize = 1024;
pub const UNPACK_MAX_DEPTH: usize = 32;

pub const MAX_REDIRECTS: usize = 3;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub const FEED_TOTAL_TIMEOUT: Duration = Duration::from_secs(15);
pub const DOWNLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
pub const DOWNLOAD_TOTAL_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// Free space needed on the app's volume: `bytes` + 2 x `unpackedBytes` + this margin.
pub const FREE_SPACE_MARGIN: u64 = 100 * MIB;

/// A Feed-key feed may carry a `seq` at most this far above the floor (the standby is unlimited).
pub const SEQ_MAX_JUMP: u64 = 1000;
/// Upper bound of any `seq`.
pub const SEQ_MAX: u64 = 1 << 40;

/// Auto-check cadence (the engine, U5, owns the timers; the numbers live here).
pub const FIRST_CHECK_DELAY: Duration = Duration::from_secs(90);
pub const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 3600);
pub const AUTO_THROTTLE: Duration = Duration::from_secs(20 * 3600);
pub const MANUAL_DEBOUNCE: Duration = Duration::from_secs(10);
pub const BACKOFF: [Duration; 4] = [
    Duration::from_secs(3600),
    Duration::from_secs(4 * 3600),
    Duration::from_secs(12 * 3600),
    Duration::from_secs(24 * 3600),
];
pub const FEED_RECHECK_AFTER: Duration = Duration::from_secs(3600);
pub const STAGE_RETENTION: Duration = Duration::from_secs(7 * 24 * 3600);

/// Strict version string length (a longer string is refused before parsing).
pub const VERSION_MAX_LEN: usize = 64;
