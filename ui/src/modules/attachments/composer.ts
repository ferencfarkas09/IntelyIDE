// Glue between one composer (agent chat, New Run) and the attachments machinery: an AttachmentStore, a drop target
// registered with the router, the paste handler and the capability gate ("providers without support refuse the drop").
import { onCleanup } from "solid-js";
import { registerDropTarget, type DropItem } from "../../platform/dropzone";
import { repos } from "../../store/workspace";
import { toast } from "../../ui-kit";
import { t } from "../../i18n";
import { createAttachmentStore, type AttachmentStore } from "./store";
import { providerLabel } from "./types";

export type AttachmentsCap = "none" | "images" | "imagesPdf" | "files";

const isPdf = (i: DropItem) => i.mime === "application/pdf" || /\.pdf$/i.test(i.name);

/** Why this provider takes none of / not all of the items, or undefined when it accepts them. */
export function capRefusal(cap: AttachmentsCap | null | undefined, items: readonly DropItem[], provider: string): string | undefined {
  const files = items.filter((i) => i.kind === "file" || i.kind === "image");
  if (files.length === 0) return t("attach.onlyFiles");
  if (cap === "none") return t("chat.noAttachments", { provider });
  if (cap === "images" && files.some((i) => i.kind !== "image")) return t("attach.imagesOnly", { provider });
  if (cap === "imagesPdf" && files.some((i) => i.kind !== "image" && !isPdf(i))) return t("attach.imagesPdfOnly", { provider });
  return undefined;
}

export interface ComposerAttachOptions {
  /** Persistence key and drop-target id: `agent:<id>`, `newrun`. */
  key: string;
  /** "the agent composer": shown in "Drop to attach to <label>". */
  label: string;
  provider: () => string | undefined;
  caps: () => AttachmentsCap | null | undefined;
  root: () => HTMLElement | undefined;
  /** Router priority when the composer is visible but not focused; focus adds 50. */
  priority?: number;
  active?: () => boolean;
  /** Test seam. */
  draftId?: string;
}

export interface ComposerAttachments {
  store: AttachmentStore;
  provider: () => string;
  accepts(items: readonly DropItem[]): boolean;
  refusal(items: readonly DropItem[]): string | undefined;
  onPaste(e: ClipboardEvent): void;
  pick(files: File[]): void;
}

export function createComposerAttachments(o: ComposerAttachOptions): ComposerAttachments {
  const store = createAttachmentStore({ key: o.key, draftId: o.draftId, repos: () => repos().map((r) => ({ id: r.id, path: r.path })) });
  const provider = () => providerLabel(o.provider());
  const refusal = (items: readonly DropItem[]) => capRefusal(o.caps(), items, provider());
  const accepts = (items: readonly DropItem[]) => refusal(items) === undefined;
  const visible = () => {
    const el = o.root();
    return !!el && el.isConnected && el.getClientRects().length > 0;
  };
  const focused = () => !!o.root()?.contains(document.activeElement);

  const off = registerDropTarget({
    id: `composer:${o.key}`,
    get priority() {
      return (o.priority ?? 50) + (focused() ? 50 : 0);
    },
    get label() {
      return o.label;
    },
    accepts,
    refusal,
    isActive: () => (o.active ? o.active() : true) && visible(),
    element: () => o.root(),
    onDrop: async (items) => {
      const bad = refusal(items);
      if (bad) return void toast.error(t("attach.cannot"), bad);
      await store.addDropItems(items.filter((i) => i.kind === "file" || i.kind === "image"));
    },
  });
  onCleanup(() => (off(), store.dispose()));

  const take = (files: File[]) => {
    const items: DropItem[] = files.map((f) => ({ kind: f.type.startsWith("image/") ? "image" : "file", name: f.name, mime: f.type, size: f.size, blob: f }));
    const bad = refusal(items);
    if (bad) return void toast.error(t("attach.cannot"), bad);
    void store.addFiles(files);
  };

  return {
    store,
    provider,
    accepts,
    refusal,
    pick: take,
    onPaste(e) {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length === 0) return; // plain text paste is the textarea's business
      e.preventDefault();
      take(files);
    },
  };
}
