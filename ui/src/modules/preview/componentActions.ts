// Opening a component preview: from the open editor file (palette, the preview toolbar) or for a given file.
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { openTab } from "../../platform/tabs";
import { toast } from "../../ui-kit";
import { activeFile } from "./actions";
import { findComponents, isComponentFile } from "./components";

export const componentTabId = (repoId: string, path: string) => `previewc:${repoId}:${path}`;

export function openComponentTab(repoId: string, path: string, exportName?: string, name?: string): void {
  openTab({ type: "preview-component", id: componentTabId(repoId, path), title: t("pvc.tab", { name: name ?? (path.split("/").pop() ?? path) }), params: { repoId, path, ...(exportName ? { export: exportName } : {}) } });
}

/** Is the open editor file one the component preview can try? (the palette command's `when`) */
export function activeFileIsComponent(): boolean {
  const f = activeFile();
  return !!f && isComponentFile(f.path);
}

/** Palette command and toolbar button: previews the first component the open file exports. */
export async function previewActiveComponent(): Promise<void> {
  const f = activeFile();
  if (!f) return void toast.info(t("pvc.needFile.title"), t("pvc.needFile.body"));
  if (!isComponentFile(f.path)) return void toast.info(t("pvc.none.title"), t("pvc.none.body", { file: f.path }));
  let text = "";
  try {
    text = (await ipc.files.readFile(f.repoId, f.path)).text ?? "";
  } catch {
    // unreadable: the harness will say so
  }
  const found = text ? findComponents(f.path, text) : [];
  // The scan is a hint, not a gate: a file the scan does not understand may still render when the harness is asked for its default export.
  const first = found[0];
  if (!first && text) return void toast.info(t("pvc.none.title"), t("pvc.none.body", { file: f.path }));
  openComponentTab(f.repoId, f.path, first?.exportName, first?.name);
}
