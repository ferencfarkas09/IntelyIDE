import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { execute } from "../../platform/commands";
import {
  Badge, Braces, Button, EmptyState, ExternalLink, IconButton, ImageIcon, Input, Moon, Monitor, MousePointerClick, RefreshCw, Select, SegmentedControl, Smartphone, Spinner, Sun, Tablet, TextArea, toast, TriangleAlert, type SelectOption,
} from "../../ui-kit";
import { componentApi, type HarnessInfo } from "./componentApi";
import { attachToAgentPrompt } from "./componentAttach";
import {
  dataUrlToBytes, NO_WRAPPERS, parseFrameMessage, parseJsonObject, PROTOCOL, pretty, pushEvent, prefsKey, VIEWPORTS, viewportById, withPreset, type FrameMessage, type JsonCheck, type Viewport, type Wrappers,
} from "./componentLogic";
import { loadPrefs, patchPrefs, prefsOf } from "./componentState";
import { findComponents, suggestProps, unsuggested } from "./components";
import { FRAME_SANDBOX, fitScale, viaProxy } from "./logic";
import "./preview.css";
import "./component.css";

type Phase = "starting" | "ready" | "error";
type PanelTab = "props" | "store" | "events";
type StatusMsg = Extract<FrameMessage, { kind: "status" }>;
type EventMsg = Extract<FrameMessage, { kind: "event" }> & { n: number };

const SHOT_TIMEOUT_MS = 10_000;
const COMMIT_MS = 200;

const errorText = (code: string | undefined, message: string | undefined): string => {
  switch (code) {
    case "noNode": return t("pvc.err.noNode");
    case "noBundler": return t("pvc.err.noBundler");
    case "noReact": return t("pvc.err.noReact");
    case "oldReact": return t("pvc.err.oldReact");
    case "readOnly": return t("pvc.err.readOnly");
    case "testJail": return t("pvc.err.testJail");
    case "tooMany": return t("pvc.err.tooMany");
    case "outsideRepo":
    case "badPath":
    case "badFile": return t("pvc.err.badFile");
    case "notFound": return t("pvc.err.notFound");
    default: return message ?? t("pvc.err.generic");
  }
};

const jsonMessage = (c: Exclude<JsonCheck, { ok: true }>): string => {
  switch (c.reason) {
    case "syntax": return t("pvc.json.syntax", { line: c.line, col: c.col, detail: c.detail });
    case "notObject": return t("pvc.json.notObject");
    case "tooLarge": return t("pvc.json.tooLarge");
    case "forbiddenKey": return t("pvc.json.forbidden", { key: c.detail });
  }
};

export interface ComponentViewProps {
  repoId: string;
  path: string;
  exportName?: string;
}

/** Renders one exported component of a repo, alone, in the loopback frame, through the IDE-generated harness. */
export function ComponentView(props: ComponentViewProps) {
  const [exp, setExp] = createSignal(props.exportName ?? "default");
  const key = createMemo(() => prefsKey(props.repoId, props.path, exp()));
  const prefs = () => prefsOf(key());

  const [phase, setPhase] = createSignal<Phase>("starting");
  const [err, setErr] = createSignal<{ code?: string; message?: string } | undefined>();
  const [info, setInfo] = createSignal<HarnessInfo | undefined>();
  const [frameSrc, setFrameSrc] = createSignal("");
  const [frameOrigin, setFrameOrigin] = createSignal("");
  const [hello, setHello] = createSignal<Extract<FrameMessage, { kind: "ready" }> | undefined>();
  const [status, setStatus] = createSignal<StatusMsg | undefined>();
  const [events, setEvents] = createSignal<EventMsg[]>([]);
  const [panel, setPanel] = createSignal<PanelTab>("props");
  const [pane, setPane] = createSignal({ width: 0, height: 0 });
  const [inspecting, setInspecting] = createSignal(document.documentElement.hasAttribute("data-intely-inspecting"));
  const [shotBusy, setShotBusy] = createSignal(false);
  const [naming, setNaming] = createSignal<string | undefined>();
  const [attempt, setAttempt] = createSignal(0);
  // The first message waits for the saved props: sending defaults first would flash an error for a component that needs its saved state.
  const [prefsReady, setPrefsReady] = createSignal(false);
  const [propsDraft, setPropsDraft] = createSignal<string | undefined>();
  const [storeDraft, setStoreDraft] = createSignal<string | undefined>();
  let stage: HTMLDivElement | undefined;
  let frame: HTMLIFrameElement | undefined;
  let counter = 0;
  const pendingShots = new Map<string, (m: Extract<FrameMessage, { kind: "shot" }>) => void>();
  let live: HarnessInfo | undefined;

  // --- the component, from the source -------------------------------------------------------------------------------
  const [source] = createResource(
    () => [props.repoId, props.path] as const,
    async ([repoId, path]) => {
      try {
        const text = (await ipc.files.readFile(repoId, path)).text ?? "";
        return findComponents(path, text);
      } catch {
        return [];
      }
    },
  );
  const found = createMemo(() => source() ?? []);
  const component = createMemo(() => found().find((c) => c.exportName === exp()));
  const suggested = createMemo(() => (component() ? suggestProps(component()!) : {}));
  const exportOptions = createMemo((): SelectOption<string>[] => {
    const names = new Set<string>([...found().map((c) => c.exportName), ...(hello()?.exports ?? [])]);
    if (!names.has(exp())) names.add(exp());
    return [...names].map((n) => ({ value: n, label: n === "default" ? `${found().find((c) => c.exportName === n)?.name ?? t("pvc.export.default")} (default)` : n }));
  });
  const title = () => component()?.name ?? hello()?.name ?? props.path.split("/").pop() ?? props.path;

  // --- editor texts and their validation ----------------------------------------------------------------------------
  const propsText = () => propsDraft() ?? prefs().props ?? pretty(suggested());
  const storeText = () => storeDraft() ?? prefs().store ?? "{}";
  const propsCheck = createMemo(() => parseJsonObject(propsText()));
  const storeCheck = createMemo(() => parseJsonObject(storeText()));
  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  const commit = () => {
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      const p = propsDraft();
      const s = storeDraft();
      if (p !== undefined || s !== undefined) patchPrefs(key(), { ...(p !== undefined ? { props: p } : {}), ...(s !== undefined ? { store: s } : {}) });
    }, COMMIT_MS);
  };
  onCleanup(() => clearTimeout(commitTimer));

  // What the bundle really contains: the page's own report wins (the set can change after a save), the harness's ready line is the fallback.
  const bundled = (): Wrappers => {
    const a = hello()?.available;
    if (a) return { theme: a.mui || a.styled, redux: a.redux, router: a.router };
    const u = info()?.uses;
    return u ? { theme: u.mui || u.styled, redux: u.redux, router: u.router } : NO_WRAPPERS;
  };
  const wrappers = () => prefs().wrappers ?? bundled();

  // --- talking to the page -----------------------------------------------------------------------------------------
  const post = (message: Record<string, unknown>) => {
    const w = frame?.contentWindow;
    const origin = frameOrigin();
    if (w && origin) w.postMessage(message, origin);
  };
  const send = () => {
    if (!prefsReady()) return;
    const p = propsCheck();
    const s = storeCheck();
    if (!p.ok || !s.ok || !hello()) return;
    const w = wrappers();
    post({ intely: PROTOCOL.set, props: p.value, store: s.value, wrappers: w, scheme: prefs().scheme, layout: prefs().layout, route: prefs().route });
  };
  createEffect(() => {
    // Every input of the message is read here, so any change re-sends it.
    propsCheck();
    storeCheck();
    wrappers();
    prefs().scheme;
    prefs().layout;
    prefs().route;
    hello();
    prefsReady();
    send();
  });

  onMount(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame || e.source !== frame.contentWindow || e.origin !== frameOrigin()) return;
      const m = parseFrameMessage(e.data);
      if (!m) return;
      if (m.kind === "ready") {
        setStatus(undefined);
        setHello(m);
        send();
      } else if (m.kind === "status") setStatus(m.state === "ok" ? undefined : m);
      else if (m.kind === "event") setEvents((all) => pushEvent(all, { ...m, n: ++counter }));
      else if (m.kind === "shot") pendingShots.get(m.id)?.(m);
    };
    window.addEventListener("message", onMessage);
    onCleanup(() => window.removeEventListener("message", onMessage));
    if (typeof ResizeObserver !== "undefined" && stage) {
      const ro = new ResizeObserver(([entry]) => setPane({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) }));
      ro.observe(stage);
      onCleanup(() => ro.disconnect());
    }
    if (typeof MutationObserver !== "undefined") {
      const mo = new MutationObserver(() => setInspecting(document.documentElement.hasAttribute("data-intely-inspecting")));
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-intely-inspecting"] });
      onCleanup(() => mo.disconnect());
    }
  });

  // --- the harness process ------------------------------------------------------------------------------------------
  const release = () => {
    if (live) void componentApi().release(live.id).catch(() => undefined);
    live = undefined;
  };
  createEffect(
    on([() => props.repoId, () => props.path, exp, attempt], () => {
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
        release();
      });
      setPhase("starting");
      setErr(undefined);
      setInfo(undefined);
      setFrameSrc("");
      setHello(undefined);
      setStatus(undefined);
      setEvents([]);
      setPrefsReady(false);
      setPropsDraft(undefined);
      setStoreDraft(undefined);
      const k = key();
      void loadPrefs(k).then(() => key() === k && setPrefsReady(true));
      void (async () => {
        try {
          const started = await componentApi().start(props.repoId, props.path, exp());
          if (cancelled) return void componentApi().release(started.id).catch(() => undefined);
          live = started;
          let src = started.url;
          try {
            src = viaProxy(started.url, (await ipc.preview.proxyStart(started.url)).url);
          } catch {
            // no proxy here: the page still renders, click-to-source stays idle
          }
          if (cancelled) return;
          setFrameOrigin(new URL(src).origin);
          setInfo(started);
          setFrameSrc(src);
          setPhase("ready");
        } catch (e) {
          if (!cancelled) {
            setErr(e as { code?: string; message?: string });
            setPhase("error");
          }
        }
      })();
    }),
  );

  // --- toolbar actions ----------------------------------------------------------------------------------------------
  const reload = () => {
    if (frame && frameSrc()) frame.src = frameSrc();
  };
  const openError = (e: { file: string; line: number; col: number }) => void execute("editor.openFile", { repoId: props.repoId, path: e.file || props.path, line: e.line || 1, column: e.col || 1 });

  async function shoot(): Promise<void> {
    if (shotBusy() || phase() !== "ready" || !hello()) return;
    setShotBusy(true);
    const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    try {
      const result = await new Promise<Extract<FrameMessage, { kind: "shot" }>>((resolve, reject) => {
        const timer = setTimeout(() => (pendingShots.delete(id), reject(new Error(t("pvc.shot.timeout")))), SHOT_TIMEOUT_MS);
        pendingShots.set(id, (m) => (clearTimeout(timer), pendingShots.delete(id), resolve(m)));
        post({ intely: PROTOCOL.shotReq, id, scale: 2 });
      });
      if (!result.ok) throw new Error(result.error || t("pvc.shot.failed"));
      const bytes = dataUrlToBytes(result.dataUrl);
      if (!bytes) throw new Error(t("pvc.shot.failed"));
      const vp = prefs().viewport;
      const file = new File([bytes as BlobPart], `${title().replace(/[^\w.-]+/g, "_")}-${prefs().scheme}-${vp}.png`, { type: "image/png" });
      const outcome = await attachToAgentPrompt(file);
      if (outcome === "attached") toast.success(t("pvc.shot.attached"), file.name);
      else if (outcome === "noAgent") toast.info(t("pvc.shot.noAgent.title"), t("pvc.shot.noAgent.body"));
      else toast.error(t("pvc.shot.refused.title"), t("pvc.shot.refused.body"));
    } catch (e) {
      toast.error(t("pvc.shot.failed"), (e as Error).message);
    } finally {
      setShotBusy(false);
    }
  }

  // --- presets -----------------------------------------------------------------------------------------------------
  const presetOptions = createMemo((): SelectOption<string>[] => [{ value: "", label: t("pvc.preset.pick") }, ...prefs().presets.map((p) => ({ value: p.name, label: p.name }))]);
  const [presetPicked, setPresetPicked] = createSignal("");
  const applyPreset = (name: string) => {
    setPresetPicked(name);
    const p = prefs().presets.find((x) => x.name === name);
    if (!p) return;
    setPropsDraft(p.props);
    setStoreDraft(p.store || "{}");
    patchPrefs(key(), { props: p.props, store: p.store || "{}" });
  };
  const savePreset = () => {
    const name = (naming() ?? "").trim();
    if (!name || !propsCheck().ok) return;
    patchPrefs(key(), { presets: withPreset(prefs().presets, { name, props: propsText(), store: storeText() }) });
    setNaming(undefined);
    setPresetPicked(name);
    toast.success(t("pvc.preset.saved", { name }));
  };
  const deletePreset = () => {
    const name = presetPicked();
    if (!name) return;
    patchPrefs(key(), { presets: prefs().presets.filter((p) => p.name !== name) });
    setPresetPicked("");
  };
  const resetSuggested = () => {
    const text = pretty(suggested());
    setPropsDraft(text);
    patchPrefs(key(), { props: text });
    setPresetPicked("");
  };
  const addProp = (name: string) => {
    const c = propsCheck();
    if (!c.ok) return;
    const text = pretty({ ...c.value, [name]: null });
    setPropsDraft(text);
    commit();
  };

  // --- layout numbers ----------------------------------------------------------------------------------------------
  const vp = (): Viewport => viewportById(prefs().viewport);
  const size = () => (vp().id === "fit" ? null : { width: vp().width, height: vp().height });
  const scale = () => (size() ? fitScale(size()!.width, size()!.height, pane().width, pane().height) : 1);
  const unset = createMemo(() => (component() ? unsuggested(component()!) : []).filter((n) => { const c = propsCheck(); return c.ok && !(n in c.value); }));
  const errorCount = () => events().filter((e) => e.event === "console" || e.event === "network").length;

  const wrapperButton = (id: keyof Wrappers, label: string, lib: string) => (
    <Button
      size="sm"
      variant={wrappers()[id] ? "secondary" : "ghost"}
      aria-pressed={wrappers()[id]}
      disabled={!bundled()[id]}
      title={bundled()[id] ? t("pvc.wrap.tip", { what: label }) : t("pvc.wrap.none", { lib })}
      onClick={() => patchPrefs(key(), { wrappers: { ...wrappers(), [id]: !wrappers()[id] } })}
    >
      {label}
    </Button>
  );

  return (
    <div class="pv pvc" data-testid="component-preview" data-phase={phase()}>
      <div class="pv__bar pvc__bar">
        <div class="pvc__title">
          <Badge tone="info" icon={Braces} title={props.path}>{title()}</Badge>
          <span class="pvc__path" title={props.path}>{props.path}</span>
          <Show when={exportOptions().length > 1}>
            <Select<string> size="sm" wrapperClass="pvc__export" aria-label={t("pvc.export.label")} value={exp()} options={exportOptions()} onChange={(v) => setExp(v)} />
          </Show>
        </div>
        <div class="pv__actions">
          <IconButton icon={RefreshCw} size="sm" label={t("pvc.reload")} tooltip={t("pvc.reload.tip")} disabled={phase() !== "ready"} onClick={reload} />
          <IconButton icon={MousePointerClick} size="sm" label={t("pvc.inspect")} pressed={inspecting()} tooltip={t("pvc.inspect.tip")} disabled={phase() !== "ready"} onClick={() => void execute("preview.inspect.toggle")} />
          <IconButton icon={ImageIcon} size="sm" label={t("pvc.attach")} tooltip={t("pvc.attach.tip")} disabled={phase() !== "ready" || !hello() || shotBusy()} onClick={() => void shoot()} />
          <IconButton icon={ExternalLink} size="sm" label={t("pvc.openSource")} tooltip={t("pvc.openSource")} onClick={() => void execute("editor.openFile", { repoId: props.repoId, path: props.path, line: component()?.line ?? 1 })} />
        </div>
      </div>

      <div class="pv__bar pv__bar--sub pvc__bar2">
        <div class="pvc__group">
          <SegmentedControl<Viewport["id"]>
            size="sm"
            aria-label={t("pvc.vp.label")}
            value={prefs().viewport}
            onChange={(viewport) => patchPrefs(key(), { viewport })}
            options={VIEWPORTS.map((v) => ({
              value: v.id,
              ...(v.id === "fit" ? { label: t("pvc.vp.fit") } : { icon: v.id === "phone" ? Smartphone : v.id === "tablet" ? Tablet : Monitor }),
              ariaLabel: t(`pvc.vp.${v.id}`),
              tooltip: v.id === "fit" ? t("pvc.vp.fit") : `${t(`pvc.vp.${v.id}`)} (${v.width}×${v.height})`,
            }))}
          />
          <SegmentedControl<"dark" | "light">
            size="sm"
            aria-label={t("pvc.scheme.label")}
            value={prefs().scheme}
            onChange={(scheme) => patchPrefs(key(), { scheme })}
            options={[
              { value: "dark", icon: Moon, ariaLabel: t("pvc.scheme.dark"), tooltip: t("pvc.scheme.dark") },
              { value: "light", icon: Sun, ariaLabel: t("pvc.scheme.light"), tooltip: t("pvc.scheme.light") },
            ]}
          />
          <SegmentedControl<"padded" | "full">
            size="sm"
            aria-label={t("pvc.layout.label")}
            value={prefs().layout}
            onChange={(layout) => patchPrefs(key(), { layout })}
            options={[
              { value: "padded", label: t("pvc.layout.padded"), tooltip: t("pvc.layout.paddedTip") },
              { value: "full", label: t("pvc.layout.full"), tooltip: t("pvc.layout.fullTip") },
            ]}
          />
        </div>
        <div class="pvc__group" role="group" aria-label={t("pvc.wrap.label")}>
          <span class="pvc__label">{t("pvc.wrap.label")}</span>
          {wrapperButton("theme", t("pvc.wrap.theme"), "MUI / styled-components")}
          {wrapperButton("redux", t("pvc.wrap.store"), "react-redux")}
          {wrapperButton("router", t("pvc.wrap.router"), "react-router")}
        </div>
      </div>

      <Show when={status()}>
        {(s) => (
          <div class="pvc__banner" role="alert" data-testid="component-status" data-state={s().state}>
            <TriangleAlert size={14} />
            <span class="pvc__banner-text">
              <Show when={s().state === "buildError"} fallback={t("pvc.render.error", { message: s().message })}>
                {t("pvc.build.error", { text: s().errors[0] ? `${s().errors[0].file}:${s().errors[0].line}:${s().errors[0].col} ${s().errors[0].text}` : s().message })}
              </Show>
            </span>
            <Show when={s().state === "buildError" && s().errors[0]?.file}>
              <Button size="sm" variant="secondary" onClick={() => openError(s().errors[0])}>{t("pvc.build.open")}</Button>
            </Show>
          </div>
        )}
      </Show>

      <div class="pv__body pvc__body">
        <div class="pv__stage pvc__stage" ref={stage} data-scheme={prefs().scheme}>
          <Show when={phase() === "ready"}>
            <div class="pv__scaler" data-kind={vp().id === "phone" ? "phone" : vp().id === "tablet" ? "tablet" : vp().id === "fit" ? "fluid" : "desktop"} style={size() ? { width: `${size()!.width * scale()}px`, height: `${size()!.height * scale()}px` } : undefined}>
              <iframe
                ref={(el) => (frame = el)}
                class="pv__frame"
                title={t("pvc.frame")}
                data-intely-preview=""
                data-component-preview=""
                data-repo-id={props.repoId}
                src={frameSrc()}
                sandbox={FRAME_SANDBOX}
                referrerPolicy="no-referrer"
                allow=""
                onLoad={() => post({ intely: PROTOCOL.hello })}
                style={{ "color-scheme": prefs().scheme, ...(size() ? { width: `${size()!.width}px`, height: `${size()!.height}px`, transform: `scale(${scale()})` } : {}) }}
              />
            </div>
          </Show>
          <Show when={phase() === "starting"}>
            <EmptyState icon={Braces} title={t("pvc.starting.title", { name: title() })} description={t("pvc.starting.body")} action={<Spinner size={20} label={t("pvc.starting.title", { name: title() })} />} />
          </Show>
          <Show when={phase() === "error"}>
            <EmptyState
              icon={TriangleAlert}
              title={t("pvc.err.title")}
              description={errorText(err()?.code, err()?.message)}
              action={<Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>{t("pvc.retry")}</Button>}
            />
          </Show>
        </div>

        <aside class="pvc__panel" aria-label={t("pvc.panel.label")}>
          <div class="pvc__tabs">
            <SegmentedControl<PanelTab>
              size="sm"
              aria-label={t("pvc.panel.label")}
              value={panel()}
              onChange={setPanel}
              options={[
                { value: "props", label: t("pvc.panel.props") },
                { value: "store", label: t("pvc.panel.store") },
                { value: "events", label: events().length ? `${t("pvc.panel.events")} ${events().length}` : t("pvc.panel.events") },
              ]}
            />
          </div>

          <Show when={panel() === "props"}>
            <div class="pvc__section">
              <div class="pvc__presets">
                <Select<string> size="sm" wrapperClass="pvc__presetpick" aria-label={t("pvc.preset.label")} value={presetPicked()} options={presetOptions()} onChange={applyPreset} />
                <Show when={naming() === undefined} fallback={
                  <form class="pvc__nameform" onSubmit={(e) => (e.preventDefault(), savePreset())}>
                    <Input size="sm" aria-label={t("pvc.preset.name")} placeholder={t("pvc.preset.name")} maxLength={60} value={naming() ?? ""} onInput={(e) => setNaming(e.currentTarget.value)} onKeyDown={(e) => e.key === "Escape" && setNaming(undefined)} />
                    <Button type="submit" size="sm" variant="primary" disabled={!(naming() ?? "").trim() || !propsCheck().ok}>{t("pvc.preset.save")}</Button>
                  </form>
                }>
                  <Button size="sm" variant="secondary" disabled={!propsCheck().ok} onClick={() => setNaming(presetPicked())}>{t("pvc.preset.saveAs")}</Button>
                  <Button size="sm" variant="ghost" disabled={!presetPicked()} onClick={deletePreset}>{t("pvc.preset.delete")}</Button>
                </Show>
              </div>
              <TextArea
                class="pvc__json"
                aria-label={t("pvc.props.label")}
                spellcheck={false}
                minRows={10}
                maxRows={26}
                invalid={!propsCheck().ok}
                value={propsText()}
                onInput={(e) => (setPropsDraft(e.currentTarget.value), setPresetPicked(""), commit())}
              />
              <Show when={propsCheck()} keyed>
                {(c) => (c.ok ? <p class="pvc__ok" data-testid="props-valid">{t("pvc.json.valid")}</p> : <p class="pvc__bad" role="alert" data-testid="props-error">{jsonMessage(c)}</p>)}
              </Show>
              <Show when={unset().length > 0}>
                <div class="pvc__chips" aria-label={t("pvc.props.seen")}>
                  <span class="pvc__label">{t("pvc.props.seen")}</span>
                  <For each={unset()}>{(n) => <button type="button" class="pvc__chip" onClick={() => addProp(n)}>{n}</button>}</For>
                </div>
              </Show>
              <p class="pvc__hint">{t("pvc.props.hint")}</p>
              <div class="pvc__row">
                <Button size="sm" variant="ghost" onClick={resetSuggested}>{t("pvc.preset.suggested")}</Button>
              </div>
            </div>
          </Show>

          <Show when={panel() === "store"}>
            <div class="pvc__section">
              <Show when={wrappers().redux} fallback={<p class="pvc__hint">{bundled().redux ? t("pvc.store.off") : t("pvc.store.unused")}</p>}>
                <p class="pvc__hint">{t("pvc.store.hint")}</p>
              </Show>
              <TextArea
                class="pvc__json"
                aria-label={t("pvc.store.label")}
                spellcheck={false}
                minRows={8}
                maxRows={22}
                disabled={!wrappers().redux}
                invalid={!storeCheck().ok}
                value={storeText()}
                onInput={(e) => (setStoreDraft(e.currentTarget.value), commit())}
              />
              <Show when={storeCheck()} keyed>
                {(c) => (c.ok ? null : <p class="pvc__bad" role="alert">{jsonMessage(c)}</p>)}
              </Show>
              <Show when={wrappers().router}>
                <label class="pvc__route">
                  <span class="pvc__label">{t("pvc.route.label")}</span>
                  <Input size="sm" aria-label={t("pvc.route.label")} spellcheck={false} value={prefs().route} onChange={(e) => patchPrefs(key(), { route: e.currentTarget.value.startsWith("/") ? e.currentTarget.value : `/${e.currentTarget.value}` })} />
                </label>
              </Show>
            </div>
          </Show>

          <Show when={panel() === "events"}>
            <div class="pvc__section">
              <div class="pvc__row">
                <span class="pvc__label">{errorCount() > 0 ? t("pvc.events.warn", { count: errorCount() }) : t("pvc.events.title")}</span>
                <Button size="sm" variant="ghost" disabled={events().length === 0} onClick={() => setEvents([])}>{t("pvc.events.clear")}</Button>
              </div>
              <Show when={events().length > 0} fallback={<p class="pvc__hint">{t("pvc.events.empty")}</p>}>
                <ul class="pvc__events" data-testid="events">
                  <For each={[...events()].reverse()}>
                    {(ev) => (
                      <li class="pvc__event" data-kind={ev.event}>
                        <Badge size="sm" tone={ev.event === "network" ? "warn" : ev.event === "console" || ev.event === "error" ? "danger" : "neutral"}>{t(`pvc.events.kind.${ev.event}`)}</Badge>
                        <span class="pvc__event-name">{ev.name}</span>
                        <Show when={ev.detail}><span class="pvc__event-detail">{ev.detail}</span></Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
          </Show>
        </aside>
      </div>

      <div class="pv__status" aria-live="polite">
        <span class="pv__dot" data-reach={phase() === "ready" ? "up" : phase() === "error" ? "down" : "unknown"} aria-hidden="true" />
        <span>{phase() === "ready" ? t("pvc.status.live") : phase() === "error" ? t("pvc.status.stopped") : t("pvc.status.starting")}</span>
        <Show when={size()}>
          <span class="ui-tnum">{size()!.width}{"×"}{size()!.height} @ {Math.round(scale() * 100)}%</span>
        </Show>
        <span class="pv__status-spacer" />
        <Show when={info()}>
          {(i) => <span title={t("pvc.engine.tip")}>{t("pvc.engine", { esbuild: i().esbuild, engine: i().engine === "repo" ? t("pvc.engine.repo") : t("pvc.engine.ide"), react: i().react })}</span>}
        </Show>
      </div>
    </div>
  );
}

export default ComponentView;
