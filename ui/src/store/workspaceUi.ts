import { createEffect, createRoot, on } from "solid-js";
import { t } from "../i18n";
import { activeToolWindow, setToolWindow } from "../platform/rail";
import { restoreTabs, snapshotTabs, tabs, activeTab, type TabSnapshot } from "../platform/tabs";
import { toast } from "../ui-kit";
import { readStored, writeStored } from "../ui-kit/storage";
import { workspaceState } from "./workspace";
import { activeId, onLeaveWorkspace } from "./workspaces";

/*
 * What a workspace remembers about the window ((design notes: workspaces-spec) 4.13): its open editor and diff tabs, the active tab and
 * the left tool window. A switch reloads the page, so this is saved before the switch and restored after the next boot.
 * Everything touches localStorage in try/catch: a blocked storage just means nothing is restored.
 */

export const UI_KEY = "intely.ws.ui.v1";
export const MAX_REMEMBERED = 20;
export const SAVE_DEBOUNCE_MS = 500;
/** The editor ("file") and diff tabs. Terminal, run and agent tabs hold live processes or sessions and are not restored. */
export const RESTORABLE_TYPES: ReadonlySet<string> = new Set(["file", "diff"]);

export interface WorkspaceUi {
  tabs: TabSnapshot[];
  activeTabId: string | null;
  leftWindow: string | null;
  savedAt: number;
}

type Store = Record<string, WorkspaceUi>;

function readAll(): Store {
  try {
    const raw = readStored(UI_KEY);
    if (!raw) return {};
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Store) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Store): void {
  try {
    // LRU: keep the twenty most recently saved workspaces.
    const kept = Object.entries(all)
      .sort((a, b) => (b[1].savedAt ?? 0) - (a[1].savedAt ?? 0))
      .slice(0, MAX_REMEMBERED);
    writeStored(UI_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* nothing to do: the state is a convenience */
  }
}

export function readWorkspaceUi(id: string): WorkspaceUi | null {
  const v = readAll()[id];
  return v && Array.isArray(v.tabs) ? v : null;
}

export function forgetWorkspaceUi(id: string): void {
  const all = readAll();
  if (id in all) {
    delete all[id];
    writeAll(all);
  }
}

/** `jump` is a "scroll to this line now" timestamp: restoring it would scroll an editor that was only reopened. */
function withoutJump(tab: TabSnapshot): TabSnapshot {
  if (!tab.params || !("jump" in tab.params)) return tab;
  const { jump: _jump, ...params } = tab.params;
  return { ...tab, params };
}

/** Writes the current tabs, active tab and left tool window under the workspace id. */
export function saveWorkspaceUi(id: string | null = activeId(), now: number = Date.now()): void {
  if (!id) return;
  const snap = snapshotTabs();
  const all = readAll();
  all[id] = {
    tabs: snap.tabs.filter((tab) => RESTORABLE_TYPES.has(tab.type)).map(withoutJump),
    activeTabId: snap.activeTabId && snap.tabs.some((tab) => tab.id === snap.activeTabId && RESTORABLE_TYPES.has(tab.type)) ? snap.activeTabId : null,
    leftWindow: activeToolWindow("left"),
    savedAt: now,
  };
  writeAll(all);
}

/** Reopens the saved tabs of a workspace (registered `editor` and `diff` types only). Returns how many came back. */
export function restoreWorkspaceUi(id: string | null = activeId()): number {
  if (!id) return 0;
  const saved = readWorkspaceUi(id);
  if (!saved) return 0;
  if (saved.leftWindow && saved.leftWindow !== activeToolWindow("left")) setToolWindow("left", saved.leftWindow);
  const r = restoreTabs(saved.tabs, saved.activeTabId, RESTORABLE_TYPES);
  if (r.failed > 0) toast.warn(t("ws.toast.restoreFailed"));
  return r.restored;
}

/**
 * Keeps the saved state of the open workspace current and restores it once after boot. Saving starts only after the restore
 * attempt, so the empty tab list of a fresh page never overwrites what is saved. Returns the disposer.
 */
export function startWorkspaceUiSync(): () => void {
  let restored = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (restored && workspaceState() === "ready") saveWorkspaceUi();
  };
  const schedule = () => {
    if (!restored) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };
  const stopLeave = onLeaveWorkspace(() => {
    if (restored) saveWorkspaceUi();
  });
  const dispose = createRoot((d) => {
    createEffect(
      on(
        () => [workspaceState(), activeId()] as const,
        ([state, id]) => {
          if (state === "ready" && id && !restored) {
            restoreWorkspaceUi(id);
            restored = true;
          }
        },
      ),
    );
    createEffect(
      on(
        () => [tabs(), activeTab()?.id, activeToolWindow("left")] as const,
        () => schedule(),
        { defer: true },
      ),
    );
    return d;
  });
  const onHide = () => {
    if (globalThis.document?.visibilityState === "hidden" || !globalThis.document) flush();
  };
  globalThis.addEventListener?.("pagehide", flush);
  globalThis.document?.addEventListener("visibilitychange", onHide);
  return () => {
    flush();
    dispose();
    stopLeave();
    globalThis.removeEventListener?.("pagehide", flush);
    globalThis.document?.removeEventListener("visibilitychange", onHide);
  };
}
