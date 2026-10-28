// Backend of the account views: the `registry_*` commands in the app, an in-memory fixture in a plain browser (where nothing is sent
// anywhere and nobody is asked). Tests swap it with `setRegistryApi`.
import { call } from "../../ipc/rpc";
import { inTauri } from "../l10n/api";
import type { RegisterInput, RegistryProblem, RegistryStatus, StoredData } from "./types";

export interface RegistryApi {
  status(): Promise<RegistryStatus>;
  register(input: RegisterInput): Promise<RegistryStatus>;
  decline(): Promise<RegistryStatus>;
  me(): Promise<StoredData>;
  newsletter(on: boolean): Promise<RegistryStatus>;
  forget(): Promise<RegistryStatus>;
  reconsent(accept: boolean, locale: string, tz: string): Promise<RegistryStatus>;
  openExternal(url: string): Promise<void>;
}

/** What a rejected command (an `EngineError`) says, as the views want it. */
export function problemOf(e: unknown): RegistryProblem {
  const x = (e ?? {}) as { code?: unknown; message?: unknown; detail?: unknown };
  const retry = typeof x.detail === "string" ? /retryAfterSeconds=(\d+)/.exec(x.detail)?.[1] : undefined;
  return { code: typeof x.code === "string" ? x.code : "unknown", message: typeof x.message === "string" ? x.message : String(e), ...(retry ? { retryAfterSeconds: Number(retry) } : {}) };
}

const tauriApi: RegistryApi = {
  status: () => call("registry_status", {}),
  register: (input) => call("registry_register", { input }),
  decline: () => call("registry_decline", {}),
  me: () => call("registry_me", {}),
  newsletter: (on) => call("registry_newsletter", { on }),
  forget: () => call("registry_forget", {}),
  reconsent: (accept, locale, tz) => call("registry_reconsent", { accept, locale, tz }),
  openExternal: (url) => call("open_external", { url }),
};

let override: RegistryApi | undefined;
export const setRegistryApi = (api: RegistryApi | undefined): void => void (override = api);

let mock: RegistryApi | undefined;
export function registryApi(): RegistryApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockRegistry());
}

// ---- the fixture -----------------------------------------------------------------------------------------------------

export const MOCK_NOTICE = "2026-10-28";
export const MOCK_URL = "https://registry.example.invalid"; // i18n-ignore

/** In memory only: starts "not registered, not asking" so a browser preview or a screenshot run never shows the first-start screen by itself. */
export function createMockRegistry(): RegistryApi {
  let status: RegistryStatus = { state: "declined", name: null, email: null, newsletter: null, notice: MOCK_NOTICE, consentedNotice: null, needsConsent: false, url: MOCK_URL };
  const registered = (input: { name: string; email: string; newsletter: boolean }): RegistryStatus =>
    (status = { ...status, state: "registered", name: input.name.trim(), email: input.email.trim().toLowerCase(), newsletter: input.newsletter ? "pending" : "none", consentedNotice: MOCK_NOTICE, needsConsent: false });
  const ended = (): RegistryStatus => (status = { ...status, state: "declined", name: null, email: null, newsletter: null, consentedNotice: null, needsConsent: false });
  return {
    status: async () => status,
    register: async (input) => {
      if (!input.consent) throw { code: "noConsent", message: "Nothing is sent without your agreement" };
      return registered(input);
    },
    decline: async () => (status = { ...status, state: "declined", needsConsent: false }),
    me: async () => {
      if (status.state !== "registered") throw { code: "notRegistered", message: "This computer is not registered" };
      const now = Math.floor(Date.now() / 1000);
      return {
        notice: MOCK_NOTICE,
        user: { name: status.name ?? "", email: status.email ?? "", consentNotice: MOCK_NOTICE, consentAt: now, newsletter: status.newsletter ?? "none" },
        computer: { os: "macos", os_version: "15.4", arch: "aarch64", cpu_cores: 10, ram_gb: 32, locale: "en-US", tz: "Europe/Budapest", app_version: "1.13.0", country: "HU", region: "Budapest", city: "Budapest", first_seen: now - 86400, last_seen: now, launches: 3 },
        computers: 1,
      };
    },
    newsletter: async (on) => (status = { ...status, newsletter: on ? "pending" : "unsubscribed" }),
    forget: async () => ended(),
    reconsent: async (accept) => (accept ? (status = { ...status, consentedNotice: MOCK_NOTICE, needsConsent: false }) : ended()),
    openExternal: async () => {},
  };
}
