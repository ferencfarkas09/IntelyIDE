// One AttachmentStore per composer / draft. It owns the chips, runs files through the right pipeline (images through
// the image pipeline, everything else straight into the backend store), keeps the draft id across restarts and
// answers "may I send?" (guard warnings need an explicit confirm).
import { batch, createRoot, createSignal } from "solid-js";
import type { DropItem } from "../../platform/dropzone";
import { attachApi } from "./api";
import { t } from "../../i18n";
import { browserImageDeps, ImageError, processImage, type ImageDeps } from "./imagePipeline";
import type { Attachment, Meta } from "./types";

export interface RepoRef {
  id: string;
  path: string;
}

const KEY = (k: string) => `intely.attach.draft.${k}`;
const FOLDERS = (d: string) => `intely.attach.folders.${d}`;
const safe = <T>(f: () => T): T | undefined => {
  try {
    return f();
  } catch {
    return undefined; // storage can be blocked (private window, previews)
  }
};
const newDraftId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function repoForPath(path: string, repos: readonly RepoRef[]): { repo: RepoRef; rel: string } | undefined {
  const norm = (p: string) => p.replace(/\/+$/, "");
  const hit = [...repos].filter((r) => path === norm(r.path) || path.startsWith(`${norm(r.path)}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  return hit ? { repo: hit, rel: path.slice(norm(hit.path).length).replace(/^\/+/, "") } : undefined;
}

export interface StoreOptions {
  /** Persistence key of the composer, e.g. `agent:<id>` or `newrun`. */
  key: string;
  repos?: () => readonly RepoRef[];
  imageDeps?: ImageDeps;
  /** Test seam: a fixed draft id instead of a persisted one. */
  draftId?: string;
}

export interface AttachmentStore {
  readonly draftId: () => string;
  readonly items: () => Attachment[];
  addDropItems(items: readonly DropItem[]): Promise<void>;
  addFiles(files: readonly File[]): Promise<void>;
  remove(id: string): Promise<void>;
  confirm(id: string): Promise<void>;
  /** After a send: the files belong to the message now, the composer starts a fresh draft. */
  rotate(): void;
  /** Stored files for `agent_send`. */
  selection(): { draftId: string; ids: string[] };
  folderRefs(): Attachment[];
  /** Why sending is not possible right now, or undefined. */
  blocker(): string | undefined;
  /** Ready when the chip strip has anything. */
  hasAny(): boolean;
  dispose(): void;
}

export function createAttachmentStore(opts: StoreOptions): AttachmentStore {
  return createRoot((dispose) => {
    const api = () => attachApi();
    const deps = opts.imageDeps ?? browserImageDeps;
    const [draftId, setDraftId] = createSignal(opts.draftId ?? safe(() => localStorage.getItem(KEY(opts.key))) ?? newDraftId());
    if (!opts.draftId) safe(() => localStorage.setItem(KEY(opts.key), draftId()));
    const [items, setItems] = createSignal<Attachment[]>([]);
    const patch = (id: string, change: Partial<Attachment>) => setItems((all) => all.map((a) => (a.id === id ? { ...a, ...change } : a)));
    const drop = (id: string) => setItems((all) => all.filter((a) => a.id !== id));
    const revoke = (a: Attachment | undefined) => a?.thumb && safe(() => URL.revokeObjectURL(a.thumb!));
    const thumbOf = (blob: Blob) => safe(() => URL.createObjectURL(blob));
    let disposed = false;

    const fromMeta = (m: Meta, extra: Partial<Attachment> = {}): Attachment => ({ id: m.id, name: m.name, mime: m.mime, size: m.size, kind: m.kind, status: "ready", guard: m.guard, confirmed: m.confirmed, inline: m.inline, ...extra });
    const saveFolders = () => safe(() => localStorage.setItem(FOLDERS(draftId()), JSON.stringify(items().filter((a) => a.kind === "folder"))));

    // Restore the draft after a restart: stored files from the backend, folder references from localStorage.
    void (async () => {
      const folders = safe(() => JSON.parse(localStorage.getItem(FOLDERS(draftId())) ?? "[]") as Attachment[]) ?? [];
      const metas = await api().list(draftId()).catch(() => [] as Meta[]);
      if (disposed) return;
      const restored: Attachment[] = [...folders, ...metas.map((m) => fromMeta(m))];
      setItems((cur) => [...restored.filter((r) => !cur.some((c) => c.id === r.id)), ...cur]);
      for (const m of metas.filter((x) => x.kind === "image")) {
        void api().read(draftId(), m.id).then((b) => patch(m.id, { thumb: thumbOf(new Blob([b], { type: m.mime })) })).catch(() => undefined);
      }
    })();

    const fail = (id: string, e: unknown) => patch(id, { status: "error", error: (e as Error)?.message ?? String(e) });

    async function storeImage(placeholder: string, blob: Blob, name: string, source?: string, rawId?: string) {
      try {
        const out = await processImage(blob, name, deps);
        const imp = await api().importBytes(draftId(), out.blob, out.name, out.mime, source);
        if (rawId) await api().remove(draftId(), rawId).catch(() => undefined);
        batch(() => {
          drop(placeholder);
          if (!items().some((a) => a.id === imp.meta.id)) setItems((all) => [...all, fromMeta(imp.meta, { thumb: thumbOf(out.blob), note: imp.deduped ? t("attach.already") : out.note ?? (out.stripped ? t("attach.stripped") : undefined) })]);
          else if (imp.deduped) patch(imp.meta.id, { note: t("attach.already") });
        });
      } catch (e) {
        if (rawId) await api().remove(draftId(), rawId).catch(() => undefined);
        fail(placeholder, e instanceof ImageError ? e : e);
      }
    }

    async function addBlob(blob: Blob, name: string, mime: string, source?: string) {
      const ph = `pending:${Math.random().toString(36).slice(2)}`;
      setItems((all) => [...all, { id: ph, name, mime, size: blob.size, kind: mime.startsWith("image/") ? "image" : "file", status: "processing", confirmed: false }]);
      if (mime.startsWith("image/") && mime !== "image/svg+xml") return storeImage(ph, blob, name, source);
      try {
        const imp = await api().importBytes(draftId(), blob, name, mime, source);
        batch(() => {
          drop(ph);
          if (!items().some((a) => a.id === imp.meta.id)) setItems((all) => [...all, fromMeta(imp.meta, { note: imp.deduped ? t("attach.already") : undefined })]);
          else if (imp.deduped) patch(imp.meta.id, { note: t("attach.already") });
        });
      } catch (e) {
        fail(ph, e);
      }
    }

    async function addPaths(paths: string[]) {
      const info = await api().inspect(paths).catch(() => []);
      const repos = opts.repos?.() ?? [];
      const files: string[] = [];
      for (const i of info) {
        if (!i.isDir) {
          files.push(i.path);
          continue;
        }
        const hit = repoForPath(i.path, repos);
        const id = `folder:${i.path}`;
        if (!hit) {
          setItems((all) => [...all, { id, name: i.name, mime: "inode/directory", size: 0, kind: "folder", status: "error", error: t("attach.folderOutside"), confirmed: false, path: i.path }]);
        } else if (!items().some((a) => a.id === id)) {
          setItems((all) => [...all, { id, name: `${i.name}/`, mime: "inode/directory", size: 0, kind: "folder", status: "ready", confirmed: true, path: i.path, repoId: hit.repo.id, relPath: hit.rel, guard: i.guard, note: t("attach.folderIn", { repo: hit.repo.id }) }]);
          saveFolders();
        }
      }
      if (!files.length) return;
      const placeholders = files.map((p) => ({ p, id: `pending:${p}` }));
      setItems((all) => [...all, ...placeholders.map(({ p, id }) => ({ id, name: p.split("/").pop() ?? p, mime: "application/octet-stream", size: 0, kind: "file" as const, status: "processing" as const, confirmed: false }))]);
      let results;
      try {
        results = await api().importPaths(draftId(), files);
      } catch (e) {
        placeholders.forEach(({ id }) => fail(id, e));
        return;
      }
      for (const r of results) {
        const id = `pending:${r.path}`;
        if (r.error || !r.imported) {
          fail(id, new Error(r.error?.message ?? "import failed"));
        } else if (r.imported.meta.kind === "image") {
          // The copy is the raw original; shrink it, strip metadata and replace it with the processed image.
          const raw = await api().read(draftId(), r.imported.meta.id);
          await storeImage(id, new Blob([raw], { type: r.imported.meta.mime }), r.imported.meta.name, r.path, r.imported.deduped ? undefined : r.imported.meta.id);
        } else {
          batch(() => {
            drop(id);
            if (!items().some((a) => a.id === r.imported!.meta.id)) setItems((all) => [...all, fromMeta(r.imported!.meta, { note: r.imported!.deduped ? t("attach.already") : undefined })]);
          });
        }
      }
    }

    const store: AttachmentStore = {
      draftId,
      items,
      async addDropItems(list) {
        const paths = list.filter((i) => i.path && !i.blob).map((i) => i.path!);
        const blobs = list.filter((i) => i.blob);
        await Promise.all([paths.length ? addPaths(paths) : undefined, ...blobs.map((i) => addBlob(i.blob!, i.name, i.mime, i.path))]);
      },
      async addFiles(files) {
        await Promise.all(files.map((f) => addBlob(f, f.name || "pasted", f.type || "application/octet-stream")));
      },
      async remove(id) {
        const a = items().find((x) => x.id === id);
        revoke(a);
        drop(id);
        if (a && a.kind !== "folder" && !id.startsWith("pending:")) await api().remove(draftId(), id).catch(() => undefined);
        saveFolders();
      },
      async confirm(id) {
        try {
          const m = await api().confirm(draftId(), id);
          patch(id, { confirmed: m.confirmed });
        } catch (e) {
          fail(id, e);
        }
      },
      rotate() {
        items().forEach(revoke);
        safe(() => localStorage.removeItem(FOLDERS(draftId())));
        const next = newDraftId();
        batch(() => {
          setDraftId(next);
          setItems([]);
        });
        if (!opts.draftId) safe(() => localStorage.setItem(KEY(opts.key), next));
      },
      selection: () => ({ draftId: draftId(), ids: items().filter((a) => a.kind !== "folder" && a.status === "ready").map((a) => a.id) }),
      folderRefs: () => items().filter((a) => a.kind === "folder" && a.status === "ready"),
      blocker() {
        const all = items();
        if (all.some((a) => a.status === "processing")) return t("attach.stillPreparing");
        const unconfirmed = all.find((a) => a.status === "ready" && a.guard && !a.confirmed);
        if (unconfirmed) return t("attach.confirmOrRemove", { name: unconfirmed.name });
        return undefined;
      },
      hasAny: () => items().some((a) => a.status !== "error"),
      dispose() {
        disposed = true;
        items().forEach(revoke);
        dispose();
      },
    };
    return store;
  });
}
