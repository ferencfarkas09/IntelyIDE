// Backend of the attachments module. In the Tauri app every call goes to the `attachment_*` commands (a COPY into
// ~/Library/Application Support/IntelySwitchIDE/attachments/<draftId>/). In a plain browser (mock UI, Playwright)
// an in-memory store with the same limits and guards stands in, so the whole flow is testable without the app.
import { call } from "../../ipc/rpc";
import { t } from "../../i18n";
import { guardForContent, guardForPath } from "./guards";
import type { AttachKind, Imported, Inspected, Meta, PathImport } from "./types";
import { FILE_LIMITS } from "./types";

export interface AttachApi {
  importBytes(draftId: string, blob: Blob, name: string, mime?: string, source?: string): Promise<Imported>;
  importPaths(draftId: string, paths: string[]): Promise<PathImport[]>;
  inspect(paths: string[]): Promise<Inspected[]>;
  list(draftId: string): Promise<Meta[]>;
  /** `draftId` undefined: look the id up (a transcript only knows the id). */
  read(draftId: string | undefined, id: string): Promise<Blob>;
  remove(draftId: string, id?: string): Promise<void>;
  confirm(draftId: string, id: string): Promise<Meta>;
  root(): Promise<string>;
}

export const inTauri = (): boolean => typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

function tauriApi(): AttachApi {
  return {
    async importBytes(draftId, blob, name, mime, source) {
      const { invoke } = await import("@tauri-apps/api/core");
      const headers: Record<string, string> = { "x-draft": draftId, "x-name": encodeURIComponent(name), "x-mime": mime ?? (blob.type || "application/octet-stream") };
      if (source) headers["x-source"] = encodeURIComponent(source);
      try {
        return await invoke<Imported>("attachment_import_bytes", new Uint8Array(await blob.arrayBuffer()), { headers });
      } catch (e) {
        throw asError(e);
      }
    },
    importPaths: (draftId, paths) => call("attachment_import_paths", { draftId, paths }),
    inspect: (paths) => call("attachment_inspect", { paths }),
    list: (draftId) => call("attachment_list", { draftId }),
    async read(draftId, id) {
      const { invoke } = await import("@tauri-apps/api/core");
      return new Blob([(await invoke<ArrayBuffer>("attachment_read", { draftId: draftId ?? null, id })) as BlobPart]);
    },
    remove: (draftId, id) => call("attachment_remove", { draftId, id: id ?? null }),
    confirm: (draftId, id) => call("attachment_confirm", { draftId, id }),
    root: () => call("attachment_root"),
  };
}

function asError(e: unknown): Error {
  const o = e as { code?: string; message?: string };
  return Object.assign(new Error(o?.message ?? String(e)), { code: o?.code ?? "io" });
}

const sha256 = async (blob: Blob): Promise<string> => {
  const buf = await blob.arrayBuffer();
  try {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    let h = 5381; // no WebCrypto (very old test envs): a stable stand-in, the real store hashes in Rust
    for (const b of new Uint8Array(buf)) h = ((h << 5) + h + b) | 0;
    return `mock${(h >>> 0).toString(16)}${buf.byteLength}`;
  }
};

const textual = (name: string, mime: string) => mime.startsWith("text/") || mime === "application/json" || /\.(md|txt|json|ya?ml|toml|ts|tsx|js|jsx|css|html|rs|py|go|sh|sql|csv|log|env|xml)$/i.test(name);

/** In-memory stand-in with the limits and guards of the Rust store. */
export function createMockApi(): AttachApi & { files: Map<string, Map<string, { meta: Meta; blob: Blob }>> } {
  const files = new Map<string, Map<string, { meta: Meta; blob: Blob }>>();
  const draft = (d: string) => files.get(d) ?? files.set(d, new Map()).get(d)!;
  const kindOf = (name: string, mime: string): AttachKind => (mime.startsWith("image/") && mime !== "image/svg+xml" ? "image" : mime === "application/pdf" ? "pdf" : textual(name, mime) ? "text" : "file");
  const api = {
    files,
    async importBytes(draftId: string, blob: Blob, name: string, mime?: string, source?: string): Promise<Imported> {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(draftId)) throw Object.assign(new Error("invalid draft id"), { code: "badId" });
      const base = name.split(/[\\/]/).pop()!.trim();
      const clean = /^\.*$/.test(base) ? "attachment" : base;
      const m = mime && mime !== "application/octet-stream" ? mime : blob.type || "application/octet-stream";
      const kind = kindOf(clean, m);
      const cap = kind === "image" ? FILE_LIMITS.imageBytes : kind === "pdf" ? FILE_LIMITS.pdfBytes : FILE_LIMITS.fileBytes;
      if (blob.size > cap) throw Object.assign(new Error(`${kind} is ${blob.size} bytes, the limit is ${cap}`), { code: "tooLarge" });
      const sha = await sha256(blob);
      const d = draft(draftId);
      const dup = [...d.values()].find((x) => x.meta.sha256 === sha);
      if (dup) return { meta: dup.meta, deduped: true };
      const guard = guardForPath(source ?? name) ?? guardForPath(name) ?? (kind === "text" ? guardForContent(await blob.text()) : null);
      const meta: Meta = { id: Math.random().toString(16).slice(2) + Date.now().toString(16), draftId, name: clean, mime: m, size: blob.size, kind, sha256: sha, createdMs: Date.now(), guard, confirmed: false, inline: kind === "text" && blob.size <= FILE_LIMITS.textInlineBytes };
      d.set(meta.id, { meta, blob });
      return { meta, deduped: false };
    },
    async importPaths(): Promise<PathImport[]> {
      throw Object.assign(new Error(t("attach.noPaths")), { code: "notAvailable" });
    },
    async inspect(paths: string[]): Promise<Inspected[]> {
      return paths.map((p) => ({ path: p, name: p.split("/").pop() ?? p, isDir: false, size: 0, guard: guardForPath(p) }));
    },
    async list(draftId: string) {
      return [...(files.get(draftId)?.values() ?? [])].map((x) => x.meta);
    },
    async read(draftId: string | undefined, id: string) {
      const f = draftId ? files.get(draftId)?.get(id) : [...files.values()].map((d) => d.get(id)).find(Boolean);
      if (!f) throw Object.assign(new Error("no such attachment"), { code: "notFound" });
      return f.blob;
    },
    async remove(draftId: string, id?: string) {
      if (id) files.get(draftId)?.delete(id);
      else files.delete(draftId);
    },
    async confirm(draftId: string, id: string) {
      const f = files.get(draftId)?.get(id);
      if (!f) throw Object.assign(new Error("no such attachment"), { code: "notFound" });
      f.meta = { ...f.meta, confirmed: true };
      return f.meta;
    },
    async root() {
      return "/mock/attachments";
    },
  };
  return api;
}

let current: AttachApi | undefined;
export const attachApi = (): AttachApi => (current ??= inTauri() ? tauriApi() : createMockApi());
/** Tests swap the backend. */
export const setAttachApi = (api: AttachApi | undefined): void => void (current = api);
