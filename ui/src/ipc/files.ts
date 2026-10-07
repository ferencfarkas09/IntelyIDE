import type { GuardState } from "../bindings";
import { call, subscribe } from "./rpc";
import type { RepoId, Unsubscribe } from "./index";

export type FileKind = "file" | "dir" | "symlink";
export type Eol = "lf" | "crlf" | "mixed" | "none";
/** How the bytes of a file map to text; pass it back to `writeFile` to keep the file's encoding. */
export type Encoding = "utf8" | "utf8Bom" | "utf16le" | "utf16be" | "latin1" | "latin2" | "windows1250";

export interface DirEntry {
  name: string;
  kind: FileKind;
  size?: number;
  /** Matched by .gitignore. */
  ignored?: boolean;
  /** Secret or generated file the IDE never opens (same guard as the commit panel). */
  neverRead?: boolean;
  /** One-letter porcelain status, e.g. "M", "A", "?". */
  gitStatus?: string;
}

export interface FileRead {
  /** Absent for binary or guarded files. With `tooLarge` it is only the first 5 MiB and the file must stay read-only. */
  text?: string;
  binary: boolean;
  /** Over 5 MiB: `text` (when present) is a read-only prefix of the file. */
  tooLarge: boolean;
  size: number;
  mtimeMs: number;
  eol: Eol;
  /** Absent in the mock; the real backend always reports it. */
  encoding?: Encoding;
  guard: GuardState;
}

export interface FileChanged {
  repoId: RepoId;
  path: string;
  kind: "created" | "changed" | "deleted";
}

export interface FilesIpc {
  listDir(repoId: RepoId, relPath: string): Promise<DirEntry[]>;
  /** Guarded files return no text unless `reveal` is set. */
  readFile(repoId: RepoId, relPath: string, opts?: { reveal?: boolean; encoding?: Encoding }): Promise<FileRead>;
  /** Rejects with code `staleFile` when the file changed since `expectedMtimeMs`; 0 means the file is expected not to exist (it is created). */
  writeFile(repoId: RepoId, relPath: string, text: string, expectedMtimeMs: number, opts?: { reveal?: boolean; encoding?: Encoding }): Promise<{ mtimeMs: number }>;
  /** Every non-ignored file path of the repo, for quick open. */
  quickOpenIndex(repoId: RepoId): Promise<string[]>;
  /** Creates an empty file or directory. Rejects with code `exists` when the path is taken. */
  createEntry(repoId: RepoId, relPath: string, kind: "file" | "dir"): Promise<void>;
  /** Rejects with code `exists` when `to` is taken. */
  renameEntry(repoId: RepoId, from: string, to: string): Promise<void>;
  /** Moves to the Trash, never a hard delete. */
  trashEntry(repoId: RepoId, relPath: string): Promise<void>;
  /** Shows the entry in Finder. */
  revealEntry(repoId: RepoId, relPath: string): Promise<void>;
  /** Start / stop `onFileChanged` events for a file the editor has open. Your own `writeFile` is not echoed back. */
  watch(repoId: RepoId, relPath: string): Promise<void>;
  unwatch(repoId: RepoId, relPath: string): Promise<void>;
  onFileChanged(cb: (e: FileChanged) => void): Unsubscribe;
}

export function createTauriFiles(): FilesIpc {
  return {
    listDir: (repoId, relPath) => call("files_list_dir", { repoId, relPath }),
    readFile: (repoId, relPath, opts) => call("files_read_file", { repoId, relPath, reveal: opts?.reveal, encoding: opts?.encoding }),
    writeFile: (repoId, relPath, text, expectedMtimeMs, opts) =>
      call("files_write_file", { repoId, relPath, text, expectedMtimeMs, reveal: opts?.reveal, encoding: opts?.encoding }),
    quickOpenIndex: (repoId) => call("files_quick_open_index", { repoId }),
    createEntry: (repoId, relPath, kind) => call("files_create_entry", { repoId, relPath, kind }),
    renameEntry: (repoId, from, to) => call("files_rename_entry", { repoId, from, to }),
    trashEntry: (repoId, relPath) => call("files_trash_entry", { repoId, relPath }),
    revealEntry: (repoId, relPath) => call("files_reveal_entry", { repoId, relPath }),
    watch: (repoId, relPath) => call("files_watch", { repoId, relPath }),
    unwatch: (repoId, relPath) => call("files_unwatch", { repoId, relPath }),
    onFileChanged: (cb) => subscribe("files:changed", cb),
  };
}
