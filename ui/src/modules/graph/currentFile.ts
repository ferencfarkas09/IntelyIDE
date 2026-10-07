import { activeTab } from "../../platform/tabs";
import { selectedFile } from "../../store/selection";

export interface FileRef {
  repoId: string;
  path: string;
}

/** The file the user is looking at: the active tab's file (editor, hunks, history, diff of a commit), else the one selected in Changes. */
export function currentFile(): FileRef | null {
  const params = activeTab()?.params;
  if (params && typeof params.repoId === "string" && typeof params.path === "string") return { repoId: params.repoId, path: params.path };
  return selectedFile();
}

/** A command argument that names a file, else the current one. */
export function fileFromArgs(args: unknown): FileRef | null {
  const a = args as Partial<FileRef> | undefined;
  return typeof a?.repoId === "string" && typeof a.path === "string" ? { repoId: a.repoId, path: a.path } : currentFile();
}
