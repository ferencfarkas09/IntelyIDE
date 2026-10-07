import { ipc } from "../../ipc";
import type { DocClient, DocState } from "./client";
import { base64ToBytes, CHUNK_BYTES, MAX_DATA_BYTES, type DataKind } from "./logic";

export interface LoadResult {
  state: DocState;
  size: number;
  /** Only the first 50 MB of a log or JSONL file were read. */
  truncated: boolean;
}

export class TooLargeError extends Error {
  constructor(readonly size: number) {
    super("too large");
  }
}

/**
 * Streams a file into the engine in 4 MiB ranges. JSON larger than the cap is refused (a cut-off document cannot be parsed);
 * logs and JSONL show their first 50 MB. `onProgress` gets the fraction read; `isCancelled` stops the loop early.
 */
export async function loadInto(client: DocClient, repoId: string, path: string, kind: DataKind, hooks: { onProgress?: (f: number, state: DocState) => void; isCancelled?: () => boolean } = {}): Promise<LoadResult> {
  const { size } = await ipc.viewers.stat(repoId, path);
  if (kind === "json" && size > MAX_DATA_BYTES) throw new TooLargeError(size);
  const limit = Math.min(size, MAX_DATA_BYTES);
  await client.begin(kind);
  let offset = 0;
  let state: DocState | undefined;
  while (offset < limit) {
    if (hooks.isCancelled?.()) break;
    const r = await ipc.viewers.readRange(repoId, path, offset, Math.min(CHUNK_BYTES, limit - offset));
    if (r.len === 0) break;
    state = await client.chunk(base64ToBytes(r.base64));
    offset += r.len;
    hooks.onProgress?.(offset / Math.max(1, limit), state);
    if (r.eof) break;
  }
  const done = await client.end();
  hooks.onProgress?.(1, done);
  return { state: done, size, truncated: size > MAX_DATA_BYTES };
}
