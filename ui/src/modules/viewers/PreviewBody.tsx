import { createEffect, createMemo, createResource, createSignal, on, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { Button, EmptyState, ExternalLink, FileText, IconButton, ImageIcon, Maximize2, Spinner, ZoomIn, ZoomOut } from "../../ui-kit";
import { MarkdownView } from "./MarkdownView";
import { formatBytes, MAX_IMAGE_BYTES, previewKindOf, fileName } from "./logic";
import { FileTooLargeError, readDataUrl, readText } from "./source";
import "./viewers.css";

export interface PreviewFile {
  repoId: string;
  path: string;
}

/** Re-runs a loader when the file changes on disk (the editor saved it). */
function createFileVersion(file: () => PreviewFile | undefined): () => number {
  const [version, setVersion] = createSignal(0);
  createEffect(
    on(file, (f) => {
      if (!f) return;
      const off = ipc.files.onFileChanged((e) => {
        if (e.repoId === f.repoId && e.path === f.path) setVersion((v) => v + 1);
      });
      void ipc.files.watch(f.repoId, f.path).catch(() => undefined);
      onCleanup(() => {
        off();
        void ipc.files.unwatch(f.repoId, f.path).catch(() => undefined);
      });
    }),
  );
  return version;
}

/** The preview of one file: Markdown (safe renderer), SVG and raster images with zoom, PDF as an external-viewer card. */
export function PreviewBody(props: { file: PreviewFile | undefined }) {
  const kind = createMemo(() => (props.file ? previewKindOf(props.file.path) : null));
  const version = createFileVersion(() => props.file);
  const key = createMemo(() => (props.file && kind() ? { repoId: props.file.repoId, path: props.file.path, kind: kind()!, v: version() } : undefined), undefined, {
    equals: (a, b) => a?.repoId === b?.repoId && a?.path === b?.path && a?.kind === b?.kind && a?.v === b?.v,
  });

  const [content] = createResource(key, async (k) => {
    if (k.kind === "markdown") return { text: await readText(k.repoId, k.path) };
    if (k.kind === "image" || k.kind === "svg") return { image: await readDataUrl(k.repoId, k.path, MAX_IMAGE_BYTES) };
    return {};
  });

  return (
    <Show when={props.file} fallback={<EmptyState icon={FileText} title={t("viewers.pv.nothing")} description={t("viewers.pv.nothingDesc")} />}>
      <Show when={kind()} fallback={<EmptyState icon={FileText} title={t("viewers.pv.noType")} description={t("viewers.pv.noTypeDesc")} />}>
        <Show
          when={!content.error}
          fallback={
            <EmptyState
              icon={ImageIcon}
              tone={content.error instanceof FileTooLargeError ? "neutral" : "danger"}
              title={content.error instanceof FileTooLargeError ? t("viewers.pv.tooLarge") : t("viewers.pv.failed")}
              description={content.error instanceof FileTooLargeError ? t("viewers.pv.overLimit", { size: formatBytes(content.error.size), max: formatBytes(content.error.max) }) : ((content.error as { message?: string })?.message ?? "")}
              action={<OpenExternal file={props.file!} />}
            />
          }
        >
          <Show when={kind() === "pdf"}>
            <div class="pvw__center">
              <EmptyState icon={FileText} title={fileName(props.file!.path)} description={t("viewers.pv.pdf")} action={<OpenExternal file={props.file!} primary />} />
            </div>
          </Show>
          <Show when={kind() === "markdown"}>
            <div class="pvw__scroll">
              <Show when={content()?.text !== undefined} fallback={<Loading />}>
                <MarkdownView text={content()!.text!} repoId={props.file!.repoId} path={props.file!.path} />
              </Show>
            </div>
          </Show>
          <Show when={kind() === "image" || kind() === "svg"}>
            <Show when={content()?.image} fallback={<Loading />}>
              <ImageView url={content()!.image!.url} name={fileName(props.file!.path)} size={content()!.image!.size} />
            </Show>
          </Show>
        </Show>
      </Show>
    </Show>
  );
}

const Loading = () => (
  <div class="pvw__center">
    <Spinner />
  </div>
);

function OpenExternal(props: { file: PreviewFile; primary?: boolean }) {
  return (
    <Button size="sm" variant={props.primary ? "primary" : "secondary"} icon={ExternalLink} onClick={() => void ipc.viewers.openExternal(props.file.repoId, props.file.path).catch(() => undefined)}>
      {t("viewers.pv.external")}
    </Button>
  );
}

const STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

function ImageView(props: { url: string; name: string; size: number }) {
  const [natural, setNatural] = createSignal<{ w: number; h: number }>();
  const [zoom, setZoom] = createSignal<number | "fit">("fit");
  const factor = () => (zoom() === "fit" ? 1 : (zoom() as number));
  const step = (dir: 1 | -1) => {
    const cur = factor();
    const next = dir === 1 ? (STEPS.find((s) => s > cur + 1e-6) ?? STEPS[STEPS.length - 1]) : ([...STEPS].reverse().find((s) => s < cur - 1e-6) ?? STEPS[0]);
    setZoom(next);
  };
  return (
    <>
      <div class="pvw__bar">
        <ImageIcon size={14} aria-hidden="true" />
        <span class="ui-truncate">{props.name}</span>
        <Show when={natural()}>
          <span class="ui-tnum" style={{ color: "var(--text-3)", "font-size": "var(--text-xs)" }}>
            {natural()!.w} x {natural()!.h}, {formatBytes(props.size)}
          </span>
        </Show>
        <span style={{ flex: "1" }} />
        <IconButton icon={ZoomOut} label={t("viewers.zoomOut")} size="sm" onClick={() => step(-1)} />
        <span class="imgv__zoom ui-tnum">{zoom() === "fit" ? t("viewers.fitShort") : `${Math.round((zoom() as number) * 100)}%`}</span>
        <IconButton icon={ZoomIn} label={t("viewers.zoomIn")} size="sm" onClick={() => step(1)} />
        <IconButton icon={Maximize2} label={t("viewers.fit")} size="sm" pressed={zoom() === "fit"} onClick={() => setZoom("fit")} />
        <Button size="sm" variant="ghost" onClick={() => setZoom(1)}>
          100%
        </Button>
      </div>
      <div
        class="imgv"
        data-fit={zoom() === "fit" ? "" : undefined}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) (e.preventDefault(), step(e.deltaY < 0 ? 1 : -1));
        }}
      >
        <img
          src={props.url}
          alt={props.name}
          style={zoom() !== "fit" && natural() ? { width: `${natural()!.w * factor()}px`, height: `${natural()!.h * factor()}px` } : undefined}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        />
      </div>
    </>
  );
}
