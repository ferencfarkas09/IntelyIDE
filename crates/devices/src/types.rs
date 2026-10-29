//! Serde types of the devices IPC (camelCase). Script bodies never appear here: only script names.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectKind {
    Expo,
    ReactNative,
}

/// State of `ios/Pods` against `ios/Podfile.lock`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PodsState {
    /// No `ios/` folder.
    NotApplicable,
    /// `ios/Pods` is missing or empty: run `pod install`.
    Missing,
    /// `Pods/Manifest.lock` differs from `Podfile.lock`: the pods are out of date.
    Stale,
    Installed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub kind: ProjectKind,
    /// Display name from `app.json` or `package.json`.
    pub name: String,
    /// Installed version (`node_modules/react-native`) or the range from `package.json`.
    pub rn_version: Option<String>,
    pub expo_version: Option<String>,
    /// `None` when it cannot be told (unknown React Native version, nothing configured).
    pub new_arch: Option<bool>,
    pub hermes: Option<bool>,
    /// `npm`, `pnpm`, `yarn` or `bun`.
    pub package_manager: String,
    pub has_ios: bool,
    pub has_android: bool,
    pub pods: PodsState,
    /// Directory of the Android SDK when one was found.
    pub android_sdk: Option<String>,
    /// Names of `package.json` scripts (the runner id is `npm:<name>`).
    pub metro_script: Option<String>,
    pub ios_script: Option<String>,
    pub android_script: Option<String>,
    /// The process name the iOS log predicate filters on.
    pub ios_process: Option<String>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SimState {
    Booted,
    Shutdown,
    /// Booting, shutting down, creating.
    Busy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IosSimulator {
    pub udid: String,
    pub name: String,
    /// `iOS 17.5`.
    pub runtime: String,
    pub state: SimState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AdbState {
    Device,
    Offline,
    Unauthorized,
    NoPermissions,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidDevice {
    pub serial: String,
    pub state: AdbState,
    pub model: Option<String>,
    pub product: Option<String>,
    pub is_emulator: bool,
}

/// Whether one tool is usable. `hint` says how to get it when it is not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub name: String,
    pub available: bool,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceList {
    pub ios: Vec<IosSimulator>,
    pub avds: Vec<String>,
    pub android: Vec<AndroidDevice>,
    pub tools: Vec<ToolStatus>,
    /// Why a list is empty although the tool exists (a failed call, a timeout).
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub level: Level,
    /// Masked, one line, capped.
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogChunk {
    pub platform: String,
    pub start_seq: u32,
    pub entries: Vec<LogEntry>,
    /// True after a clear or when the lines asked for were already dropped: replace what you have.
    pub reset: bool,
    pub running: bool,
    pub exit_code: Option<i32>,
    /// Lines dropped because the ring was full, since the stream started.
    pub dropped: u32,
}
