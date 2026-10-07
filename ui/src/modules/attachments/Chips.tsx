// Attachment chips: thumbnail or icon, name, size, kind, remove, click to preview; a blocking warning chip for
// guarded files; a privacy line naming the provider that receives the files.
import type { AttachmentRef } from "@intely/protocol";
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js";
import { Button, File, FileText, Folder, IconButton, Plus, Spinner, TriangleAlert, X } from "../../ui-kit";
import { attachApi } from "./api";
import { t, type MessageKey } from "../../i18n";
import { guardText } from "./guards";
import { openLightbox } from "./lightbox";
import type { Attachment } from "./types";
import { formatBytes } from "./types";
import "./attachments.css";

export interface ChipsProps {
  items: readonly Attachment[];
  /** Provider display name for the warning and privacy text. */
  provider: string;
  onRemove(id: string): void;
  onConfirm(id: string): void;
}

const KIND_LABEL = { image: "attach.kind.image", pdf: "attach.kind.pdf", text: "attach.kind.text", file: "attach.kind.file", folder: "attach.kind.folder" } as const satisfies Record<Attachment["kind"], MessageKey>;
const kindLabel = (a: Attachment) => t(KIND_LABEL[a.kind]);

function Chip(props: { a: Attachment; provider: string; onRemove(): void; onConfirm(): void }) {
  const a = () => props.a;
  const guarded = () => a().status === "ready" && !!a().guard && !a().confirmed;
  const preview = () => a().thumb && openLightbox({ src: a().thumb!, name: a().name, detail: `${formatBytes(a().size)}${a().note ? ` · ${a().note}` : ""}` });
  return (
    <div class="att-chip" role="listitem" data-kind={a().kind} data-status={a().status} data-guard={guarded() ? "" : undefined} data-testid="att-chip">
      <button type="button" class="att-chip__body" aria-label={a().thumb ? t("attach.preview", { name: a().name }) : a().name} disabled={!a().thumb} onClick={preview}>
        <span class="att-chip__thumb" aria-hidden="true">
          <Switch>
            <Match when={a().status === "processing"}>
              <Spinner size={14} />
            </Match>
            <Match when={a().thumb}>
              <img src={a().thumb} alt="" />
            </Match>
            <Match when={a().kind === "folder"}>
              <Folder size={14} />
            </Match>
            <Match when={a().kind === "text" || a().kind === "pdf"}>
              <FileText size={14} />
            </Match>
            <Match when={true}>
              <File size={14} />
            </Match>
          </Switch>
        </span>
        <span class="att-chip__text">
          <span class="att-chip__name ui-truncate">{a().name}</span>
          <span class="att-chip__meta ui-truncate">
            {kindLabel(a())}
            {a().size ? ` · ${formatBytes(a().size)}` : ""}
            {a().status === "processing" ? ` · ${t("attach.preparing")}` : a().note ? ` · ${a().note}` : ""}
          </span>
        </span>
      </button>
      <IconButton icon={X} label={t("attach.remove", { name: a().name })} size="sm" onClick={props.onRemove} />
      <Show when={a().status === "error"}>
        <div class="att-chip__alert" role="alert" data-tone="danger">
          <TriangleAlert size={13} /> <span>{a().error}</span>
        </div>
      </Show>
      <Show when={guarded()}>
        <div class="att-chip__alert" role="alert" data-tone="warn" data-testid="att-guard">
          <TriangleAlert size={13} />
          <span>{guardText(a().guard!, props.provider)}</span>
          <Button size="sm" variant="secondary" onClick={props.onConfirm}>
            {t("attach.anyway")}
          </Button>
        </div>
      </Show>
    </div>
  );
}

export function AttachmentChips(props: ChipsProps) {
  const sends = createMemo(() => props.items.filter((a) => a.status !== "error" && a.kind !== "folder").length);
  return (
    <Show when={props.items.length > 0}>
      <div class="att-strip" data-testid="att-strip">
        <div class="att-strip__chips" role="list" aria-label={t("attach.list")}>
          <For each={props.items}>{(a) => <Chip a={a} provider={props.provider} onRemove={() => props.onRemove(a.id)} onConfirm={() => props.onConfirm(a.id)} />}</For>
        </div>
        <Show when={sends() > 0}>
          <p class="att-strip__privacy" data-testid="att-privacy">
            {t("attach.privacy", { provider: props.provider })}
          </p>
        </Show>
      </div>
    </Show>
  );
}

/** The (+) button: opens a file picker. In the app the picker yields File objects, so the bytes go through the import command. */
export function AttachButton(props: { onFiles(files: File[]): void; disabled?: boolean; reason?: string }) {
  let input!: HTMLInputElement;
  return (
    <>
      <input ref={(el) => (input = el)} type="file" multiple hidden data-testid="att-input" onChange={(e) => (props.onFiles([...(e.currentTarget.files ?? [])]), (e.currentTarget.value = ""))} />
      <IconButton icon={Plus} label={t("attach.add")} tooltip={props.reason ?? t("attach.addTip")} size="sm" disabled={props.disabled} onClick={() => input.click()} data-testid="att-add" />
    </>
  );
}

// One object URL per attachment id for the whole session: transcript rows re-render as events stream in, and every
// remount must not read the file again or leak a URL.
const thumbs = new Map<string, Promise<string | undefined>>();
const thumbUrl = (id: string): Promise<string | undefined> => {
  let p = thumbs.get(id);
  if (!p) {
    p = attachApi()
      .read(undefined, id)
      .then((b) => URL.createObjectURL(b))
      .catch(() => undefined); // cleaned up (7 days) or never existed on this machine
    thumbs.set(id, p);
  }
  return p;
};

/** Thumbnail of a stored image for the transcript (loaded lazily by attachment id). */
export function StoredThumb(props: { id: string; name: string; size: number }) {
  const [src] = createResource(() => props.id, thumbUrl);
  return (
    <Show when={src()} fallback={<span class="att-chip__thumb" aria-hidden="true"><File size={14} /></span>}>
      <button type="button" class="att-thumb" aria-label={t("attach.preview", { name: props.name })} onClick={() => openLightbox({ src: src()!, name: props.name, detail: formatBytes(props.size) })}>
        <img src={src()} alt={props.name} />
      </button>
    </Show>
  );
}

/** Attachments of a transcript message: image thumbnails (click for the lightbox) and file chips. */
export function MessageAttachments(props: { items: readonly AttachmentRef[] }) {
  return (
    <div class="att-strip__chips att-msg" data-testid="msg-attachments">
      <For each={props.items}>
        {(a) => (
          <Show
            when={a.kind === "image"}
            fallback={
              <span class="att-chip" data-kind={a.kind} data-testid="msg-attachment">
                <span class="att-chip__thumb" aria-hidden="true">{a.kind === "text" || a.kind === "pdf" ? <FileText size={14} /> : <File size={14} />}</span>
                <span class="att-chip__text">
                  <span class="att-chip__name ui-truncate">{a.name}</span>
                  <span class="att-chip__meta">{a.kind} · {formatBytes(a.size)}</span>
                </span>
              </span>
            }
          >
            <StoredThumb id={a.id} name={a.name} size={a.size} />
          </Show>
        )}
      </For>
    </div>
  );
}
