import { createMemo, createRoot, createSignal } from "solid-js";
import { ipc } from "../../ipc";
import { activeTab } from "../../platform/tabs";
import { dataKindOf, previewKindOf } from "./logic";

// The Settings switch ("viewers.enabled", default on). `register()` cannot read settings, so the lazy watcher overlay does it once.
const [enabled, setEnabled] = createSignal(true);
export const viewersEnabled = enabled;

let watching = false;
export async function watchViewerSettings(): Promise<void> {
  if (watching) return;
  watching = true;
  try {
    const ns = await ipc.settings.get("viewers");
    if (typeof ns.enabled === "boolean") setEnabled(ns.enabled);
  } catch {
    // keep the default
  }
  ipc.settings.onChange((e) => {
    if (e.ns === "viewers" && typeof (e.value as { enabled?: unknown } | undefined)?.enabled === "boolean") setEnabled((e.value as { enabled: boolean }).enabled);
  });
}

export const setViewersEnabled = setEnabled;

export interface FileRef {
  repoId: string;
  path: string;
}

const sameFile = (a: FileRef | undefined, b: FileRef | undefined) => a?.repoId === b?.repoId && a?.path === b?.path;

/** The file of the active editor tab, if the active tab is an editor. Stable: the same file gives the same object. */
export const activeFile = createRoot(() =>
  createMemo((): FileRef | undefined => {
    const t = activeTab();
    const p = t?.params as { repoId?: unknown; path?: unknown } | undefined;
    return t?.type === "file" && typeof p?.repoId === "string" && typeof p.path === "string" ? { repoId: p.repoId, path: p.path } : undefined;
  }, undefined, { equals: sameFile }),
);

export const activeDataFile = (): FileRef | undefined => {
  const f = activeFile();
  return f && dataKindOf(f.path) ? f : undefined;
};
export const activePreviewFile = createRoot(() => createMemo((): FileRef | undefined => {
  const f = activeFile();
  return f && previewKindOf(f.path) ? f : undefined;
}, undefined, { equals: sameFile }));
