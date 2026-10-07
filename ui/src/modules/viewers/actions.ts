import { openTab } from "../../platform/tabs";
import { dataKindOf, fileName, previewKindOf } from "./logic";
import type { FileRef } from "./state";

export function openDataViewer(f: FileRef): void {
  if (!dataKindOf(f.path)) return;
  openTab({ type: "jsonview", id: `jsonview:${f.repoId}:${f.path}`, title: fileName(f.path), params: { repoId: f.repoId, path: f.path } });
}

export function openPreview(f: FileRef): void {
  if (!previewKindOf(f.path)) return;
  openTab({ type: "docview", id: `docview:${f.repoId}:${f.path}`, title: fileName(f.path), params: { repoId: f.repoId, path: f.path } });
}
