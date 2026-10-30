//! Tauri-free backend of the React Native / Expo device loop (docs/react-native.md): project detection, the device
//! lists of `xcrun simctl`, `emulator` and `adb`, device log streams in a bounded masked ring, and the pure parsers that
//! sit between them. Metro and the app builds are NOT started here: they are `package.json` scripts and go through
//! `intely-runner`, so ports, memory, masking and the confirm-for-build rules apply. Every program started here goes
//! through the same "Allow processes" jail check as the Run panel, with an argument vector (never a shell) whose
//! variable parts (UDID, AVD name, serial, process name) were validated first. A tool that is not installed is a
//! disabled state with a hint, never an error.

pub mod detect;
pub mod logs;
pub mod net;
pub mod parse;
pub mod tools;
pub mod types;

pub use detect::detect;
pub use logs::{LogHub, LogTarget};
pub use tools::{Devices, Tools};
