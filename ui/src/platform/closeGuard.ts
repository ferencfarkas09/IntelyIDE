import { createMemo, createRoot } from "solid-js";
import { call, subscribe } from "../ipc/rpc";
import { createRegistry } from "./registry";

/** Something that can hold unsaved work (the editor's dirty buffers). The close guard asks all sources before the window closes. */
export interface UnsavedSource {
  id: string;
  /** Names of the unsaved items, reactive. */
  titles: () => string[];
  /** Saves everything; true when nothing is left unsaved. */
  saveAll: () => Promise<boolean>;
  /**
   * `"session"`: the titles are live sessions (an open Production connection), not unsaved work. They arm the close guard and
   * the dialog asks whether to leave, in the words of `copy`, and `saveAll` ends them. They never count as unsaved work
   * (`unsavedTitles`, the workspace switch guard), because that guard has its own busy model. Default `"work"`.
   */
  kind?: "work" | "session";
  /** For a `"session"` source: the dialog text, already translated (reactive, read while the dialog is open). */
  copy?: () => SessionCopy;
}

/** What the close dialog says about live sessions. */
export interface SessionCopy {
  title: string;
  description: string;
  /** The primary button: ends the sessions and quits. */
  confirm: string;
}

const registry = createRegistry<UnsavedSource>(() => 0, "unsaved");

export const registerUnsavedSource = registry.register;
export const resetUnsavedSources = registry.clear;

const sessionSources = () => registry.items().filter((s) => s.kind === "session");

/** Every unsaved item across the sources. */
export const unsavedTitles = createRoot(() => createMemo((): string[] => registry.items().filter((s) => s.kind !== "session").flatMap((s) => s.titles())));

/** Every live session across the `"session"` sources (open Production connections). */
export const sessionTitles = createRoot(() => createMemo((): string[] => sessionSources().flatMap((s) => s.titles())));

/** The dialog text of the first `"session"` source that has something open. */
export const sessionCopy = (): SessionCopy | undefined => sessionSources().find((s) => s.titles().length > 0)?.copy?.();

/** Ends every live session (what "Disconnect and quit" does before the app exits); never throws. */
export async function endSessions(): Promise<void> {
  await Promise.all(sessionSources().map((s) => s.saveAll().catch(() => false)));
}

/** Saves every source; true when all of them ended clean. */
export async function saveAllUnsaved(): Promise<boolean> {
  const results = await Promise.all(registry.items().filter((s) => s.kind !== "session").map((s) => s.saveAll()));
  return results.every(Boolean);
}

/** The desktop host (Tauri) is only there in the real app; the browser mock has no window to close. */
const hosted = (): boolean => typeof window !== "undefined" && !!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

const hostCall = (command: string, args?: Record<string, unknown>): void => {
  if (hosted()) void call(command, args).catch((err) => console.error(`${command} failed`, err));
};

/** Tells the host whether closing the window needs the UI's say (only while something is unsaved). */
export const armCloseGuard = (armed: boolean): void => hostCall("close_guard_arm", { armed });
/** The dialog is open (a repeated close request is then held back quietly) or was dismissed. */
export const closeDialogOpen = (open: boolean): void => hostCall("close_guard_dialog", { open });
/** Leaves the app without asking again. */
export const exitApp = (): void => hostCall("close_guard_exit");
/** The host held a window close or a quit back because the guard is armed. */
export const onCloseRequested = (cb: () => void): (() => void) => {
  if (hosted()) return subscribe<null>("app:close-requested", cb);
  // The browser mock has no window to close: `window.dispatchEvent(new Event("intely:close-requested"))` imitates the host (UI work, tests).
  if (typeof window === "undefined") return () => {};
  window.addEventListener("intely:close-requested", cb);
  return () => window.removeEventListener("intely:close-requested", cb);
};
