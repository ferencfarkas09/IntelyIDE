//! IntelyIDE updater: verified in-app update ((design notes: updater-spec)).
//!
//! Tauri-free. The crate never reads environment variables (the Tauri module passes everything in)
//! and has no thread or timer of its own. This file holds the shared error vocabulary; the modules
//! are owned by the tasks of spec section 11 (U1: limits, keys, endpoints, version, feed, verify).

pub mod bundle;
pub mod busy;
pub mod endpoints;
pub mod engine;
pub mod feed;
pub mod gate;
pub mod keys;
pub mod limits;
pub mod net;
pub mod notice;
pub mod relaunch;
pub mod stage;
pub mod state;
pub mod swap;
pub mod verify;
pub mod version;

use std::fmt;

macro_rules! error_codes {
    ($($variant:ident => $text:literal),+ $(,)?) => {
        /// The stable error codes of spec 7.1. The Rust side never sends English: the UI maps
        /// `updates.err.<code>` to text.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum ErrorCode { $($variant),+ }

        impl ErrorCode {
            pub const ALL: &'static [ErrorCode] = &[$(ErrorCode::$variant),+];

            /// The camelCase wire name (`feedStale`, `hostNotAllowed`, ...).
            pub fn as_str(self) -> &'static str {
                match self { $(ErrorCode::$variant => $text),+ }
            }

            pub fn parse(s: &str) -> Option<ErrorCode> {
                match s { $($text => Some(ErrorCode::$variant),)+ _ => None }
            }
        }
    };
}

error_codes! {
    Offline => "offline",
    Timeout => "timeout",
    BadStatus => "badStatus",
    FeedTooLarge => "feedTooLarge",
    FeedInvalid => "feedInvalid",
    FeedSchema => "feedSchema",
    FeedSignature => "feedSignature",
    Signature => "signature",
    SignatureComment => "signatureComment",
    FeedStale => "feedStale",
    FeedChannel => "feedChannel",
    NoTrustedKey => "noTrustedKey",
    KeyRevoked => "keyRevoked",
    BadUrl => "badUrl",
    HostNotAllowed => "hostNotAllowed",
    RedirectRefused => "redirectRefused",
    PrivateAddress => "privateAddress",
    TooLarge => "tooLarge",
    Truncated => "truncated",
    SizeMismatch => "sizeMismatch",
    HashMismatch => "hashMismatch",
    BadArchive => "badArchive",
    UnsafeEntry => "unsafeEntry",
    BombEntries => "bombEntries",
    BombSize => "bombSize",
    BundleInvalid => "bundleInvalid",
    BundleIdMismatch => "bundleIdMismatch",
    VersionMismatch => "versionMismatch",
    ArchMismatch => "archMismatch",
    IdentityChanged => "identityChanged",
    CodesignFailed => "codesignFailed",
    OsTooOld => "osTooOld",
    NoPlatform => "noPlatform",
    NoSpace => "noSpace",
    DevBuild => "devBuild",
    ReadOnly => "readOnly",
    TestJail => "testJail",
    DiskImage => "diskImage",
    Translocated => "translocated",
    NotWritable => "notWritable",
    SharedInstall => "sharedInstall",
    ReadOnlyVolume => "readOnlyVolume",
    NotABundle => "notABundle",
    BlockedByFeed => "blockedByFeed",
    Withdrawn => "withdrawn",
    TooOldForDirect => "tooOldForDirect",
    Busy => "busy",
    PlanMismatch => "planMismatch",
    Stale => "stale",
    SettingsKeyReserved => "settingsKeyReserved",
    SwapFailed => "swapFailed",
    RolledBack => "rolledBack",
    RelaunchFailed => "relaunchFailed",
    Cancelled => "cancelled",
    NotPrepared => "notPrepared",
    AlreadyRunning => "alreadyRunning",
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl serde::Serialize for ErrorCode {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

/// An error with a stable code and an optional redacted detail (never a URL with a query, never a
/// signature text).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{code}{}", .detail.as_deref().map(|d| format!(": {d}")).unwrap_or_default())]
pub struct UpdateError {
    pub code: ErrorCode,
    pub detail: Option<String>,
}

impl UpdateError {
    pub fn new(code: ErrorCode) -> Self {
        UpdateError { code, detail: None }
    }
    pub fn with(code: ErrorCode, detail: impl Into<String>) -> Self {
        UpdateError { code, detail: Some(detail.into()) }
    }
}

impl From<ErrorCode> for UpdateError {
    fn from(code: ErrorCode) -> Self {
        UpdateError::new(code)
    }
}
