import { call, subscribe } from "./rpc";
import type { Unsubscribe } from "./index";

export type UpdateState = "idle" | "checking" | "upToDate" | "available" | "error" | "disabled";

export interface UpdateLatest {
  version: string;
  tag: string;
  /** Always a release page of the project (checked in Rust); the notes are plain text. */
  url: string;
  publishedAt: string;
  prerelease: boolean;
  notes: string;
  dmgName?: string;
  dmgBytes?: number;
}

export interface UpdateNotice {
  /** The "check automatically" switch. */
  enabled: boolean;
  currentVersion: string;
  state: UpdateState;
  latest?: UpdateLatest;
  /** Unix seconds. */
  lastCheckedAt?: number;
  /** Error code, mapped to `updates.err.<code>`. */
  error?: string;
  dismissedVersion?: string;
  /** Unix seconds; missing until the one-time disclosure was shown. */
  disclosedAt?: number;
}

/** Update NOTIFICATION only: the app tells you a newer release exists and opens its page. It installs nothing. */
export interface UpdatesIpc {
  status(): Promise<UpdateNotice>;
  /** `auto` is refused by the backend unless the switch is on and the disclosure was shown. */
  check(reason: "auto" | "manual"): Promise<UpdateNotice>;
  setEnabled(enabled: boolean): Promise<UpdateNotice>;
  /** Skips one version. */
  dismiss(version: string): Promise<UpdateNotice>;
  onStatus(cb: (notice: UpdateNotice) => void): Unsubscribe;
  /** The "Check for Updates..." menu item. */
  onMenuCheck(cb: () => void): Unsubscribe;
}

export function createTauriUpdates(): UpdatesIpc {
  return {
    status: () => call("update_status"),
    check: (reason) => call("update_check", { reason }),
    setEnabled: (enabled) => call("update_set_enabled", { enabled }),
    dismiss: (version) => call("update_dismiss", { version }),
    onStatus: (cb) => subscribe<UpdateNotice>("update:status", cb),
    onMenuCheck: (cb) => subscribe<null>("menu:check-updates", () => cb()),
  };
}
