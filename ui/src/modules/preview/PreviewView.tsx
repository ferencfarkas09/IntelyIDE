import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { ipc } from "../../ipc";
import { execute } from "../../platform/commands";
import { devServers } from "../../store/devservers";
import { repos } from "../../store/workspace";
import {
  Badge, Button, EmptyState, ExternalLink, Globe, Icon, IconButton, Input, Moon, MousePointerClick, RefreshCcwDot, RefreshCw, RotateCw, Select, SegmentedControl, Sun, TriangleAlert, type SelectOption,
} from "../../ui-kit";
import { activeFile, currentUrl, openPage, pageForActiveFile, setPreviewUrl } from "./actions";
import { kindName as kindLabel, KIND_START } from "./catalog";
import { registerController } from "./controller";
import { DEVICES, deviceName, envLabel, FRAME_SANDBOX, ENV_TONE, ENVS, deviceById, frameSize, scaleFor, viaProxy, withCacheBust, ZOOMS, type Env, type Zoom } from "./logic";
import { PageList } from "./PageList";
import { catalogOf, loadRepoState, patchRepoState, refreshCatalog, repoState } from "./state";
import "./preview.css";
import { ecoInterval } from "../../platform/eco";
import { t } from "../../i18n";
import { componentPreviewEnabled } from "./toggle";

const POLL_MS = 3000;

const deviceOptions = (): SelectOption<string>[] => DEVICES.map((d) => ({ value: d.id, label: d.kind === "fluid" || d.kind === "custom" ? deviceName(d) : `${d.name} (${d.width}×${d.height})` }));
const zoomOptions = (): SelectOption<string>[] => [{ value: "fit", label: t("pv.zoom.fit") }, ...ZOOMS.map((z) => ({ value: String(z), label: `${Math.round(z * 100)}%` }))];
const envOptions = (): SelectOption<Env>[] => ENVS.map((e) => ({ value: e, label: envLabel(e) }));

export interface PreviewViewProps {
  repoId: string;
  mode: "tab" | "dock";
  /** The dock lets the user pick the repo; a tab is bound to one. */
  onRepoChange?: (repoId: string) => void;
}

/** The preview: address bar, environment label, device toolbar, page quick-list and the loopback frame. */
export function PreviewView(props: PreviewViewProps) {
  const s = () => repoState(props.repoId);
  const catalog = () => {
    const c = catalogOf(props.repoId);
    return c === "loading" ? undefined : c;
  };
  const url = () => currentUrl(props.repoId);

  const [draft, setDraft] = createSignal("");
  const [error, setError] = createSignal<string | undefined>();
  // `frameTarget` is the address the frame shows (what the bar says); `frameSrc` is what the iframe really loads: the same page
  // through the click-to-source proxy, or the address itself when no proxy could start.
  const [frameTarget, setFrameTarget] = createSignal("");
  const [frameSrc, setFrameSrc] = createSignal("");
  const [inspecting, setInspecting] = createSignal(document.documentElement.hasAttribute("data-intely-inspecting"));
  const [mounted, setMounted] = createSignal(true);
  const [reach, setReach] = createSignal<"unknown" | "up" | "down">("unknown");
  const [forced, setForced] = createSignal(false);
  const [listOpen, setListOpen] = createSignal(false);
  const [pane, setPane] = createSignal({ width: 0, height: 0 });
  let stage: HTMLDivElement | undefined;
  let urlInput: HTMLInputElement | undefined;

  onMount(() => {
    void loadRepoState(props.repoId);
    void refreshCatalog(props.repoId);
  });
  createEffect(
    on(
      () => props.repoId,
      (id) => {
        void loadRepoState(id);
        void refreshCatalog(id);
      },
      { defer: true },
    ),
  );

  // The address bar follows the stored address; the frame loads what the stored address says.
  createEffect(() => setDraft(url()));
  createEffect(
    on(url, (u) => {
      setForced(false);
      void load(u);
      void probe();
    }),
  );

  /** Points the frame at `target`, through the proxy when one can start (it needs only the loopback address, never the server). */
  async function load(target: string): Promise<void> {
    setFrameTarget(target);
    if (!target) {
      setFrameSrc("");
      return;
    }
    let src = target;
    try {
      src = viaProxy(target, (await ipc.preview.proxyStart(target)).url);
    } catch {
      // no proxy (refused, or not available here): the page still loads, click-to-source is simply idle
    }
    if (target === frameTarget()) setFrameSrc(src);
  }

  async function probe(): Promise<void> {
    const u = url();
    if (!u) {
      setReach("unknown");
      return;
    }
    try {
      const r = await ipc.preview.probe(u);
      if (u === url()) setReach(r.reachable ? "up" : "down");
    } catch {
      setReach("down");
    }
  }
  // A Run-panel server starting or stopping changes the answer: look again right away instead of waiting for the next poll.
  createEffect(on(() => devServers().map((d) => `${d.id}:${d.status}:${d.ports.join()}`).join("|"), () => void probe(), { defer: true }));
  // While nothing answers, look again every few seconds; stop as soon as it does. Nothing runs while the server is up.
  createEffect(() => {
    if (reach() !== "down") return;
    onCleanup(ecoInterval(() => void probe(), POLL_MS));
  });

  function remount(target: string): void {
    setMounted(false);
    void load(target);
    setTimeout(() => setMounted(true), 60);
    void probe();
  }
  const reload = () => remount(url());
  const hardReload = () => {
    remount(url() ? withCacheBust(url(), Date.now()) : "");
  };
  const rotate = () => {
    if (deviceById(s().device).kind !== "fluid") patchRepoState(props.repoId, { rotated: !s().rotated });
  };

  onMount(() => {
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => setInspecting(document.documentElement.hasAttribute("data-intely-inspecting")));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-intely-inspecting"] });
    onCleanup(() => mo.disconnect());
  });

  const unregister = registerController({ get repoId() { return props.repoId; }, reload, hardReload, rotate, focusUrl: () => urlInput?.focus() });
  onCleanup(unregister);

  onMount(() => {
    if (!stage || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setPane({ width: Math.floor(e.contentRect.width), height: Math.floor(e.contentRect.height) }));
    ro.observe(stage);
    onCleanup(() => ro.disconnect());
  });

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    const r = await setPreviewUrl(props.repoId, draft());
    if (r.ok) {
      setError(undefined);
      setDraft(r.url);
      if (r.url === frameTarget()) reload();
    } else setError(r.message);
  }

  const device = () => deviceById(s().device);
  const size = createMemo(() => frameSize(device(), s().rotated, s().custom));
  const scale = () => scaleFor(s().zoom, size(), pane());
  const kindName = () => (catalog() ? kindLabel(catalog()!.kind) : "");
  const startHint = () => {
    const k = catalog()?.kind;
    return k && k !== "unknown" ? KIND_START[k] : undefined;
  };
  const host = () => {
    try {
      return new URL(url()).host;
    } catch {
      return url();
    }
  };

  async function openForFile(): Promise<void> {
    const found = await pageForActiveFile();
    if (!found || found.repoId !== props.repoId) {
      setError(t("pv.err.noPage"));
      return;
    }
    const r = await openPage(props.repoId, found.match.page);
    setError(r === undefined ? t("pv.err.needsId", { link: found.match.page.link }) : r.ok ? undefined : r.message);
  }

  async function openExternal(): Promise<void> {
    try {
      await ipc.preview.openExternal(url());
    } catch (e) {
      setError((e as { message?: string }).message ?? t("pv.err.browser"));
    }
  }

  const showFrame = () => !!frameSrc() && (reach() !== "down" || forced());

  return (
    <div class="pv" data-mode={props.mode} data-env={s().env} data-testid="preview">
      <Show when={s().env === "production"}>
        <div class="pv__banner" role="alert">
          <Icon icon={TriangleAlert} size={14} />
          <span>
            <strong>{t("pv.banner.title")}</strong> {s().envNote ? t("pv.banner.textNote", { note: s().envNote }) : t("pv.banner.text")}
          </span>
        </div>
      </Show>

      <div class="pv__bar">
        <Show when={props.mode === "dock" && props.onRepoChange}>
          <Select<string>
            size="sm"
            wrapperClass="pv__repo"
            aria-label={t("pv.repo")}
            value={props.repoId}
            options={repos().map((r) => ({ value: r.id, label: r.name }))}
            onChange={(id) => props.onRepoChange?.(id)}
          />
        </Show>
        <form class="pv__url" onSubmit={(e) => void submit(e)}>
          <Input
            ref={(el) => (urlInput = el)}
            size="sm"
            wrapperClass="pv__urlfield"
            aria-label={t("pv.url.label")}
            placeholder="localhost:8082"
            spellcheck={false}
            autocomplete="off"
            invalid={!!error()}
            leading={<Icon icon={Globe} size={14} />}
            value={draft()}
            onInput={(e) => (setDraft(e.currentTarget.value), setError(undefined))}
            onKeyDown={(e) => e.key === "Escape" && (setDraft(url()), setError(undefined))}
          />
          <Button type="submit" size="sm" variant="secondary">
            {t("pv.url.go")}
          </Button>
        </form>
        <div class="pv__actions">
          <IconButton icon={RefreshCw} size="sm" label={t("pv.reload")} tooltip={t("pv.reload.tip")} onClick={reload} />
          <IconButton icon={RefreshCcwDot} size="sm" label={t("pv.hard")} tooltip={t("pv.hard.tip")} onClick={hardReload} />
          <IconButton
            icon={MousePointerClick}
            size="sm"
            label={t("pv.inspect")}
            pressed={inspecting()}
            tooltip={t("pv.inspect.tip")}
            onClick={() => void execute("preview.inspect.toggle")}
          />
          <IconButton icon={ExternalLink} size="sm" label={t("pv.openBrowser")} disabled={!url()} onClick={() => void openExternal()} />
          <Button size="sm" variant="ghost" aria-pressed={props.mode === "tab" ? s().list : listOpen()} onClick={() => (props.mode === "tab" ? patchRepoState(props.repoId, { list: !s().list }) : setListOpen(!listOpen()))}>
            {t("pv.pages")}
          </Button>
        </div>
      </div>
      <Show when={error()}>
        <div class="pv__error" role="alert" data-testid="preview-error">
          {error()}
        </div>
      </Show>

      <div class="pv__bar pv__bar--sub">
        <div class="pv__env" data-env={s().env}>
          <Select<Env> size="sm" aria-label={t("pv.env.label")} wrapperClass="pv__envselect" value={s().env} options={envOptions()} onChange={(env) => patchRepoState(props.repoId, { env })} />
          <Show when={s().env !== "unset"}>
            <Input
              size="sm"
              wrapperClass="pv__envnote"
              aria-label={t("pv.env.noteLabel")}
              placeholder={t("pv.env.notePlaceholder")}
              maxLength={80}
              spellcheck={false}
              value={s().envNote}
              onInput={(e) => patchRepoState(props.repoId, { envNote: e.currentTarget.value })}
            />
          </Show>
          <Badge tone={ENV_TONE[s().env]} variant={s().env === "production" ? "solid" : "subtle"} title={t("pv.env.badgeTip")}>
            {s().env === "unset" ? t("pv.env.unlabelled") : envLabel(s().env)}
          </Badge>
        </div>
        <div class="pv__devices">
          <Select<string> size="sm" aria-label={t("pv.device.label")} wrapperClass="pv__device" value={s().device} options={deviceOptions()} onChange={(device) => patchRepoState(props.repoId, { device })} />
          <Show when={device().kind === "custom"}>
            <Input
              size="sm"
              wrapperClass="pv__dim"
              type="number"
              aria-label={t("pv.device.width")}
              min={200}
              max={4000}
              value={s().custom.width}
              onChange={(e) => patchRepoState(props.repoId, { custom: { ...s().custom, width: Number(e.currentTarget.value) || s().custom.width } })}
            />
            <span class="pv__times" aria-hidden="true">
              {"×"}
            </span>
            <Input
              size="sm"
              wrapperClass="pv__dim"
              type="number"
              aria-label={t("pv.device.height")}
              min={200}
              max={4000}
              value={s().custom.height}
              onChange={(e) => patchRepoState(props.repoId, { custom: { ...s().custom, height: Number(e.currentTarget.value) || s().custom.height } })}
            />
          </Show>
          <IconButton icon={RotateCw} size="sm" label={t("pv.rotate")} pressed={s().rotated} disabled={device().kind === "fluid"} onClick={rotate} />
          <Select<string>
            size="sm"
            aria-label={t("pv.zoom")}
            wrapperClass="pv__zoom"
            value={String(s().zoom)}
            disabled={device().kind === "fluid"}
            options={zoomOptions()}
            onChange={(z) => patchRepoState(props.repoId, { zoom: (z === "fit" ? "fit" : Number(z)) as Zoom })}
          />
          <SegmentedControl
            size="sm"
            aria-label={t("pv.backdrop")}
            value={s().scheme}
            onChange={(scheme) => patchRepoState(props.repoId, { scheme })}
            options={[
              { value: "dark", icon: Moon, ariaLabel: t("pv.backdrop.dark"), tooltip: t("pv.backdrop.darkTip") },
              { value: "light", icon: Sun, ariaLabel: t("pv.backdrop.light"), tooltip: t("pv.backdrop.lightTip") },
            ]}
          />
          <Show when={props.mode === "tab"}>
            <Button size="sm" variant="ghost" disabled={!activeFile()} onClick={() => void openForFile()}>
              {t("pv.forFile")}
            </Button>
          </Show>
          <Show when={props.mode === "tab" && componentPreviewEnabled()}>
            <Button size="sm" variant="ghost" disabled={!activeFile()} title={t("pvc.cmd.open")} onClick={() => void execute("preview.component")}>
              {t("pvc.open.button")}
            </Button>
          </Show>
        </div>
      </div>

      <div class="pv__body">
        <Show when={props.mode === "tab" ? s().list : listOpen()}>
          <aside class="pv__pages" data-overlay={props.mode === "dock" ? "" : undefined} aria-label={t("pv.pages")}>
            <PageList repoId={props.repoId} onOpened={() => setListOpen(false)} onError={setError} />
          </aside>
        </Show>
        <div class="pv__stage" ref={stage} data-scheme={s().scheme} data-env={s().env}>
          <Show
            when={showFrame()}
            fallback={
              <Show
                when={url()}
                fallback={
                  <EmptyState
                    icon={Globe}
                    title={t("pv.empty.title")}
                    description={startHint() ? t("pv.empty.descHint", { kind: kindName(), command: startHint() }) : t("pv.empty.desc")}
                  />
                }
              >
                <EmptyState
                  icon={Globe}
                  title={t("pv.down.title", { host: host() })}
                  description={startHint() ? t("pv.down.descHint", { kind: kindName(), command: startHint() }) : t("pv.down.desc")}
                  action={
                    <div class="pv__empty-actions">
                      <Button size="sm" variant="secondary" onClick={() => void probe()}>
                        {t("pv.down.check")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setForced(true)}>
                        {t("pv.down.force")}
                      </Button>
                    </div>
                  }
                />
              </Show>
            }
          >
            <Show when={mounted()}>
              <div class="pv__scaler" data-kind={device().kind} style={size() ? { width: `${size()!.width * scale()}px`, height: `${size()!.height * scale()}px` } : undefined}>
                <iframe
                  class="pv__frame"
                  title={t("pv.frame")}
                  data-intely-preview=""
                  data-repo-id={props.repoId}
                  src={frameSrc()}
                  sandbox={FRAME_SANDBOX}
                  referrerPolicy="no-referrer"
                  allow=""
                  style={{
                    "color-scheme": s().scheme,
                    ...(size() ? { width: `${size()!.width}px`, height: `${size()!.height}px`, transform: `scale(${scale()})` } : {}),
                  }}
                />
              </div>
            </Show>
          </Show>
        </div>
      </div>

      <div class="pv__status" aria-live="polite">
        <span class="pv__dot" data-reach={reach()} aria-hidden="true" />
        <span class="pv__status-url" title={url()}>
          {host() || t("pv.status.noAddress")}
        </span>
        <Show when={size()}>
          <span class="ui-tnum">
            {size()!.width}
            {"×"}
            {size()!.height} @ {Math.round(scale() * 100)}%
          </span>
        </Show>
        <span class="pv__status-spacer" />
        <span>{reach() === "up" ? t("pv.status.up") : reach() === "down" ? t("pv.status.down") : t("pv.status.checking")}</span>
      </div>
    </div>
  );
}

export default PreviewView;
