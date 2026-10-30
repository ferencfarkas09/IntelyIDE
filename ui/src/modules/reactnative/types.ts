// Shapes of the devices IPC (crates/devices, camelCase). Script bodies never appear: only script names.
export type ProjectKind = "expo" | "reactNative";
export type PodsState = "notApplicable" | "missing" | "stale" | "installed";

export interface ProjectInfo {
  kind: ProjectKind;
  name: string;
  rnVersion: string | null;
  expoVersion: string | null;
  newArch: boolean | null;
  hermes: boolean | null;
  packageManager: string;
  hasIos: boolean;
  hasAndroid: boolean;
  pods: PodsState;
  androidSdk: string | null;
  metroScript: string | null;
  iosScript: string | null;
  androidScript: string | null;
  iosProcess: string | null;
  notes: string[];
}

export type SimState = "booted" | "shutdown" | "busy";
export interface IosSimulator {
  udid: string;
  name: string;
  runtime: string;
  state: SimState;
}

export type AdbState = "device" | "offline" | "unauthorized" | "noPermissions" | "other";
export interface AndroidDevice {
  serial: string;
  state: AdbState;
  model: string | null;
  product: string | null;
  isEmulator: boolean;
}

export type ToolName = "xcrun" | "adb" | "emulator";
/** `hint` is a code (`xcode`, `macOnly`, `androidPlatformTools`, `androidEmulator`), translated by the panel. */
export interface ToolStatus {
  name: ToolName;
  available: boolean;
  hint: string | null;
}

export interface DeviceList {
  ios: IosSimulator[];
  avds: string[];
  android: AndroidDevice[];
  tools: ToolStatus[];
  notes: string[];
}

export type Level = "info" | "warn" | "error";
export interface LogEntry {
  level: Level;
  text: string;
}
export type Platform = "ios" | "android";
export interface LogChunk {
  platform: Platform;
  startSeq: number;
  entries: LogEntry[];
  reset: boolean;
  running: boolean;
  exitCode: number | null;
  dropped: number;
}

/** Where a line came from: the Metro output or one of the two device streams. */
export type Source = "metro" | "ios" | "android";

export type ErrorKind =
  | "redbox"
  | "unresolvedModule"
  | "undefinedFunction"
  | "nativeCrash"
  | "gradleFailed"
  | "xcodeFailed"
  | "noBundleUrl"
  | "portInUse"
  | "podsOutOfDate"
  | "jsException";

export interface ErrorCard {
  /** Stable for the same kind and text, so a repeated error is one card. */
  id: string;
  kind: ErrorKind;
  source: Source;
  /** The line that matched, masked by the backend, capped. */
  snippet: string;
  /** Lines around the match (the stack top), capped. */
  context: string[];
  count: number;
}
