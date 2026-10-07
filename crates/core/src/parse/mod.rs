//! Pure parsers for git output; no process spawning, fully unit-testable.

pub mod diff;
pub mod log;
pub mod progress;
pub mod push;
pub mod status_v2;

use unicode_normalization::UnicodeNormalization;

/// Git path bytes as a UTF-8 (lossy), NFC-normalised string (contract section 1).
pub fn nfc_path(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    if s.is_ascii() {
        s.into_owned()
    } else {
        s.nfc().collect()
    }
}
