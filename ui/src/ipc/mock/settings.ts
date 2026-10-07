import type { SafetyStatus, SecretsIpc, SettingsChange, SettingsIpc, SettingsValue } from "../settings";

/** The commit guard's lists as shipped in crates/core/src/guard.rs. */
export const MOCK_SAFETY: SafetyStatus = {
  jail: "off",
  fixtureRoot: null,
  neverAdd: ["dump_*", "SERVER_MOVE*", "_to_delete", "_check_*", "_tmp_*", "backup_*", ".history", "crm-export"],
  secretPatterns: [".env", ".env.*", "*.pfx", "google-services.json", "GoogleService-Info.plist", "google-service-account.json", "auth.json", "*.pem", "*.key", "*.p12", "*.p8", "*.jks", "*.keystore", "id_rsa*", "id_ed25519*", ".npmrc", ".netrc", "credentials.json", "serviceAccount*.json"],
  maxUntrackedBytes: 5 * 1024 * 1024,
};

export function createMockSettings(safety: SafetyStatus = MOCK_SAFETY): SettingsIpc {
  // `?jail=readOnly` shows the read-only banner the dev app has when it runs against the real repositories.
  if (new URLSearchParams(globalThis.location?.search).get("jail") === "readOnly") safety = { ...safety, jail: "readOnly" };
  const store = new Map<string, SettingsValue>();
  // `?happy=connected` opens the mock with the Happy integrations already switched on (see mock/happy.ts).
  if (new URLSearchParams(globalThis.location?.search).get("happy") === "connected") {
    const on = { enabled: true, showInStatusBar: true, allowActions: true };
    store.set("happy", { master: true, env: "sandbox", timer: on, meet: on, notifications: on, tasks: on });
  }
  const listeners = new Set<(e: SettingsChange) => void>();
  return {
    get: async (ns) => structuredClone(store.get(ns) ?? {}),
    async set(ns, patch) {
      const value: SettingsValue = { ...store.get(ns), ...structuredClone(patch) };
      Object.keys(value).filter((k) => value[k] === null).forEach((k) => delete value[k]);
      store.set(ns, value);
      listeners.forEach((cb) => cb({ ns, value: structuredClone(value) }));
      return structuredClone(value);
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    safetyStatus: async () => structuredClone(safety),
  };
}

/** Stores keys only, never the values: like the real thing, nothing can be read back. */
export function createMockSecrets(keys: Set<string> = new Set()): SecretsIpc {
  return {
    has: async (key) => keys.has(key),
    async set(key) {
      keys.add(key);
    },
    async remove(key) {
      keys.delete(key);
    },
    // `?secrets=degraded` shows the Keychain failure in the browser mock.
    status: async () => (new URLSearchParams(globalThis.location?.search).get("secrets") === "degraded" ? { backend: "memory" as const, degraded: true, message: "The Keychain was denied: this build is not signed. Secrets stay in memory until you restart." } : { backend: "memory" as const, degraded: false, message: null }),
    retryKeychain: async () => {},
  };
}
