import { createSignal } from "solid-js";
import { readStored, writeStored } from "../../ui-kit/storage";
import { compareVersions, MAX_RELEASES, RELEASES, releasesToShow, type Release } from "./logic";

/** The version of the last What's new window the person closed (the webview's own storage: one short string). */
export const SEEN_KEY = "intely.whatsnew.seen";

export const seenVersion = (): string | undefined => readStored(SEEN_KEY) ?? undefined;
export const rememberVersion = (version: string): void => writeStored(SEEN_KEY, version);

/** What the window lists while it is open; `from` is the version the person came from after an update. */
export interface WhatsNewView {
  releases: Release[];
  current: string;
  from?: string;
}

const [view, setView] = createSignal<WhatsNewView | undefined>();
export const whatsNewView = view;

/** The running version of the desktop app; undefined in a browser (the mock) and when the shell cannot tell. */
export async function appVersion(): Promise<string | undefined> {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return undefined;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return undefined;
  }
}

/** Opens the window for an update: the releases since `from`. */
export function showUpdate(current: string, from: string | undefined): void {
  setView({ releases: releasesToShow(RELEASES, from, current), current, from });
}

/** Opens the window on request (the command): the latest releases up to the running version, newest first. */
export async function openWhatsNew(): Promise<void> {
  const running = (await appVersion()) ?? RELEASES[0]?.version;
  if (!running) return;
  const upToNow = RELEASES.filter((r) => compareVersions(r.version, running) <= 0).slice(0, MAX_RELEASES);
  setView({ releases: upToNow.length ? upToNow : RELEASES.slice(0, 1), current: running });
}

export function closeWhatsNew(): void {
  const open = view();
  if (open) rememberVersion(open.current);
  setView(undefined);
}

export function resetWhatsNew(): void {
  setView(undefined);
}
