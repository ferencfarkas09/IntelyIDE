import { call } from "./rpc";
import type { RepoId } from "./index";

export interface ViewerStat {
  size: number;
  mtimeMs: number;
}

/** A slice of a file; `base64` is the standard encoding of `len` bytes starting at `offset`. */
export interface ViewerRange {
  base64: string;
  offset: number;
  len: number;
  eof: boolean;
}

/** Ranged byte reads for the viewers (large logs, JSON, images). Guarded files, `.git` and symlink escapes are refused (`guardBlocked`, `invalidSelection`). */
export interface ViewersIpc {
  stat(repoId: RepoId, relPath: string): Promise<ViewerStat>;
  /** At most 8 MiB per call. */
  readRange(repoId: RepoId, relPath: string, offset: number, len: number): Promise<ViewerRange>;
  /** Opens the file in the system's default app (a PDF in Preview). Refused in the E2E jail. */
  openExternal(repoId: RepoId, relPath: string): Promise<void>;
}

export function createTauriViewers(): ViewersIpc {
  return {
    stat: (repoId, relPath) => call("viewers_stat", { repoId, relPath }),
    readRange: (repoId, relPath, offset, len) => call("viewers_read_range", { repoId, relPath, offset, len }),
    openExternal: (repoId, relPath) => call("viewers_open_external", { repoId, relPath }),
  };
}
