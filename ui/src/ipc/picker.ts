import type {
  Capabilities,
  DirListing,
  DropEvent,
  ListOpts,
  NativeOptions,
  Picked,
  ScanOpts,
  ScanProgress,
  ScanResults,
  ScanStarted,
  StartInfo,
} from "../bindings/pathpick";
import { call, subscribe } from "./rpc";
import type { Unsubscribe } from "./index";

export type {
  Capabilities,
  DirEntry,
  DirListing,
  DropEvent,
  ListOpts,
  NativeOptions,
  PathKind,
  Picked,
  PickWarning,
  ProtectedFolder,
  ScanOpts,
  ScanProgress,
  ScanResults,
  ScanStarted,
  StartInfo,
} from "../bindings/pathpick";

/** What a picked path is going to be used for. A token only redeems for the purpose it was issued for. */
export type PickPurpose = "workspaceRoot" | "workspaceRepo" | "scanRoot" | `file:${string}`;
export type PickKind = "folder" | "folders" | "file" | "files";

/**
 * The folder picker (`intely-pathpick`, (design notes: workspaces-spec) section 5). Every path that can become a repository
 * reaches Rust as a token: `Picked.token` is single-use, bound to its purpose and valid for five minutes. Failures are
 * `EngineError`s with these codes: pathInvalid, notFound, volumeMissing, notADirectory, notAFile, permissionDenied,
 * testJail, readOnly, tokenExpired, tokenUsed, wrongPurpose, nativeFailed, busy, tooBroad, initTooBroad,
 * unresponsive, scanTooBroad, pathNotValidated, io.
 */
export interface PickerIpc {
  capabilities(): Promise<Capabilities>;
  /** Home, the start folder, places and mounted volumes. In e2e mode `home` and `startPath` are the fixture root. */
  start(): Promise<StartInfo>;
  /** Read-only listing: names only, never contents. Child paths are `listing.path + "/" + entry.name`. */
  list(path: string, opts?: ListOpts): Promise<DirListing>;
  /** A typed or clicked path: validation, then a token. Quotes, `~`, `file://` and escaped spaces are understood. */
  pick(path: string, purpose: PickPurpose): Promise<Picked>;
  /** The system dialog. `null` is a cancel. */
  native(opts: NativeOptions): Promise<Picked[] | null>;
  scanStart(root: string, opts?: ScanOpts): Promise<ScanStarted>;
  scanResults(scanId: string, after?: number): Promise<ScanResults>;
  scanCancel(scanId: string): Promise<void>;
  /** The validated items of the last window drop; empties the inbox. */
  takeDrop(): Promise<Picked[]>;
  /** A screen that accepts dropped folders declares itself on mount and clears it on unmount. */
  dropListen(on: boolean): Promise<void>;
  /** Opens System Settings > Privacy & Security > Files and Folders. Takes no argument. */
  openPrivacySettings(): Promise<void>;
  /** `git init` in a folder that is not a repository, after the user typed its name. Returns the folder as a repository. */
  gitInit(token: string, confirm: string, confirmLarge?: boolean): Promise<Picked>;
  onScan(cb: (p: ScanProgress) => void): Unsubscribe;
  onDrop(cb: (e: DropEvent) => void): Unsubscribe;
}

export function createTauriPicker(): PickerIpc {
  return {
    capabilities: () => call("picker_capabilities"),
    start: () => call("picker_start"),
    list: (path, opts) => call("picker_list", { path, opts: { hidden: false, files: false, ...opts } }),
    pick: (path, purpose) => call("picker_pick", { path, purpose }),
    native: (opts) => call("picker_native", { opts }),
    scanStart: (root, opts) => call("picker_scan_start", { root, opts: { includeHidden: false, ...opts } }),
    scanResults: (scanId, after) => call("picker_scan_results", { scanId, after: after ?? null }),
    scanCancel: (scanId) => call("picker_scan_cancel", { scanId }),
    takeDrop: () => call("picker_take_drop"),
    dropListen: (on) => call("picker_drop_listen", { on }),
    openPrivacySettings: () => call("picker_open_privacy_settings"),
    gitInit: (token, confirm, confirmLarge) => call("picker_git_init", { token, confirm, confirmLarge: confirmLarge ?? false }),
    onScan: (cb) => subscribe<ScanProgress>("picker:scan", cb),
    onDrop: (cb) => subscribe<DropEvent>("picker:drop", cb),
  };
}
