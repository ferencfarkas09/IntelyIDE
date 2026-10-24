import { createSignal } from "solid-js";
import { registryApi, problemOf } from "./api";
import type { RegisterInput, RegistryProblem, RegistryStatus } from "./types";

export { problemOf };

/** What the registry stores and why, in plain words (a heading of `docs/privacy.md`). */
export const PRIVACY_URL = "https://github.com/ferencfarkas09/IntelyIDE/blob/main/docs/privacy.md#registration-and-usage-details";

/** Wait before the first-start screen opens, so the shell has settled and the What's new window (if any) has had its turn. Tests shorten it. */
let settle = 1800;
export const settleMs = (): number => settle;
export const setSettleMs = (ms: number): void => void (settle = ms);

const [status, setStatus] = createSignal<RegistryStatus | undefined>();
export { status };

/** Which dialog is open: the first-start screen, the one for a changed notice, or none. */
export type DialogKind = "register" | "reconsent";
const [dialog, setDialog] = createSignal<DialogKind | undefined>();
export { dialog };

export const openRegister = (): void => void setDialog("register");
export const openReconsent = (): void => void setDialog("reconsent");
export const closeDialog = (): void => void setDialog(undefined);

/** The language and the time zone the webview knows; the app adds the rest of the details itself. */
export function environment(): { locale: string; tz: string } {
  let tz = "UTC";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    /* an old webview */
  }
  return { locale: (typeof navigator !== "undefined" && navigator.language) || "und", tz };
}

export async function loadStatus(): Promise<RegistryStatus | undefined> {
  try {
    const s = await registryApi().status();
    setStatus(s);
    return s;
  } catch {
    return undefined;
  }
}

/** Registers; the answer is the new status. A rejection is a problem the dialog shows (`problemOf`). */
export async function register(input: Omit<RegisterInput, "locale" | "tz">): Promise<RegistryStatus> {
  const s = await registryApi().register({ ...input, ...environment() });
  setStatus(s);
  return s;
}

export async function decline(): Promise<RegistryStatus> {
  const s = await registryApi().decline();
  setStatus(s);
  return s;
}

export async function forget(): Promise<RegistryStatus> {
  const s = await registryApi().forget();
  setStatus(s);
  return s;
}

export async function setNewsletter(on: boolean): Promise<RegistryStatus> {
  const s = await registryApi().newsletter(on);
  setStatus(s);
  return s;
}

export async function reconsent(accept: boolean): Promise<RegistryStatus> {
  const s = await registryApi().reconsent(accept, environment().locale, environment().tz);
  setStatus(s);
  return s;
}

export const openPrivacy = (): Promise<void> => registryApi().openExternal(PRIVACY_URL).catch(() => {});

/** The words for a problem the person can act on; anything else shows the registry's own message. */
export function problemKey(p: RegistryProblem): "account.err.offline" | "account.err.unavailable" | "account.err.rateLimited" | "account.err.name" | "account.err.email" | "account.err.consent" | undefined {
  switch (p.code) {
    case "offline":
      return "account.err.offline";
    // the registry answered, but not with what the app expects (a server error, or another service on the host): nothing the person can fix
    case "badResponse":
    case "server":
    case "tryLater":
      return "account.err.unavailable";
    case "rateLimited":
      return "account.err.rateLimited";
    case "invalidName":
      return "account.err.name";
    case "invalidEmail":
      return "account.err.email";
    case "noConsent":
      return "account.err.consent";
    default:
      return undefined;
  }
}

export function resetAccount(): void {
  setStatus(undefined);
  setDialog(undefined);
}
