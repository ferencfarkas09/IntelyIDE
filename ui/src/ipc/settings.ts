import { call, subscribe } from "./rpc";
import type { Unsubscribe } from "./index";

export type SettingsValue = Record<string, unknown>;

export interface SettingsChange {
  ns: string;
  value: SettingsValue;
}

/** What the backend enforces, read-only: Settings > Safety shows it and never edits it. */
export interface SafetyStatus {
  /** `readOnly` (INTELY_READONLY) refuses every mutation, `e2e` (INTELY_E2E) allows them only below `fixtureRoot`. */
  jail: "off" | "readOnly" | "e2e";
  fixtureRoot?: string | null;
  /** Path-component patterns the commit guard never lets into an index. */
  neverAdd: string[];
  /** File-name patterns treated as secrets. */
  secretPatterns: string[];
  /** Untracked files above this size are guarded. */
  maxUntrackedBytes: number;
}

export interface SettingsIpc {
  /** One namespace of settings.json (e.g. "editor", "terminal"); unknown namespaces return `{}`. */
  get(ns: string): Promise<SettingsValue>;
  /**
   * Shallow-merges `patch` into the namespace; unknown keys are preserved and a `null` value removes the key. Keys that
   * look like secrets (`apiKey`, `token`, `password`...) are refused with code `secretInSettings`: use `ipc.secrets`.
   */
  set(ns: string, patch: SettingsValue): Promise<SettingsValue>;
  onChange(cb: (e: SettingsChange) => void): Unsubscribe;
  /** The jail mode and the commit guard's built-in lists. */
  safetyStatus(): Promise<SafetyStatus>;
}

/** Secret values only ever go in: the webview can ask whether one exists, never read it back. */
export interface SecretsIpc {
  has(key: string): Promise<boolean>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Where secrets are kept right now. `degraded`: the Keychain failed and they are kept in memory only (lost at restart); `message` says why. */
  status(): Promise<SecretsStatus>;
  /** Asks the macOS Keychain again after a failure (the next secret call tries it). */
  retryKeychain(): Promise<void>;
}

export interface SecretsStatus {
  backend: "keychain" | "memory";
  degraded: boolean;
  message: string | null;
}

export function createTauriSettings(): SettingsIpc {
  return {
    get: (ns) => call("settings_get", { ns }),
    set: (ns, patch) => call("settings_set", { ns, patch }),
    onChange: (cb) => subscribe<SettingsChange>("settings:changed", cb),
    safetyStatus: () => call("settings_safety_status"),
  };
}

export function createTauriSecrets(): SecretsIpc {
  return {
    has: (key) => call("secrets_has", { key }),
    set: (key, value) => call("secrets_set", { key, value }),
    remove: (key) => call("secrets_remove", { key }),
    status: () => call("secrets_status"),
    retryKeychain: () => call("secrets_retry_keychain"),
  };
}
