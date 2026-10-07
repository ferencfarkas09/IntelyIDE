import { createSignal } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { ipc } from "../../ipc";
import type { UpdateNotice } from "../../ipc/updates";

// One shared notice: the watcher feeds it (status read + `update:status` events), the chip, the card and the settings page read it.
const [notice, setNotice] = createSignal<UpdateNotice>();

export const updateNotice = notice;
export const applyNotice = setNotice;

/** The chip shows only for a newer release the user has not skipped. */
export const chipVisible = (): boolean => {
  const n = notice();
  return n?.state === "available" && !!n.latest && n.latest.version !== n.dismissedVersion;
};

/** A manual check; the answer also arrives as an event, this just returns it for the caller's own message. */
export async function checkNow(): Promise<UpdateNotice> {
  const next = await ipc.updates.check("manual");
  setNotice(next);
  return next;
}

/** Records that the one-time disclosure was shown (the backend makes no automatic request before this). */
export async function markDisclosed(): Promise<void> {
  await ipc.settings.set("updates", { disclosedAt: Math.floor(Date.now() / 1000) });
  setNotice(await ipc.updates.status());
}

export function resetUpdates(): void {
  setNotice(undefined);
}

const ERROR_CODES = ["network", "timeout", "rateLimited", "http", "tooLarge", "badResponse", "badUrl", "badVersion", "testJail", "unavailable"];

/** Text of a backend error code; an unknown code reads as a network problem. */
export function errorText(code: string | undefined): string {
  return t(`updates.err.${code && ERROR_CODES.includes(code) ? code : "network"}` as MessageKey);
}
