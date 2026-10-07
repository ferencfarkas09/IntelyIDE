import { ipc } from "../../ipc";
import { base64ToBytes, bytesToBase64, CHUNK_BYTES, mimeOf } from "./logic";

export class FileTooLargeError extends Error {
  constructor(readonly size: number, readonly max: number) {
    super("file too large");
  }
}

/** Reads a whole file through the ranged viewer reads (guard and repo jail apply), refusing anything over `max` bytes. */
export async function readBytes(repoId: string, path: string, max: number): Promise<Uint8Array> {
  const { size } = await ipc.viewers.stat(repoId, path);
  if (size > max) throw new FileTooLargeError(size, max);
  const out = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const r = await ipc.viewers.readRange(repoId, path, offset, Math.min(CHUNK_BYTES, size - offset));
    if (r.len === 0) break;
    out.set(base64ToBytes(r.base64), offset);
    offset += r.len;
    if (r.eof) break;
  }
  return out.subarray(0, offset);
}

/** A `data:` URL for an image file (the content security policy allows `img-src data:` and nothing remote). */
export async function readDataUrl(repoId: string, path: string, max: number): Promise<{ url: string; size: number }> {
  const bytes = await readBytes(repoId, path, max);
  return { url: `data:${mimeOf(path)};base64,${bytesToBase64(bytes)}`, size: bytes.length };
}

export async function readText(repoId: string, path: string, max = 5 * 1024 * 1024): Promise<string> {
  return new TextDecoder().decode(await readBytes(repoId, path, max));
}
