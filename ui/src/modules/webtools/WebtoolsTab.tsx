import { createEffect, createMemo, createSignal, For, on, Show, type Component } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import type { TabInstance } from "../../platform/tabs";
import { repoConfig, repos } from "../../store/workspace";
import { errorText } from "../../store/snapshots";
import { Download, EmptyState, Gauge, Globe, Icon, IconButton, KeyRound, Layers, ListTree, RefreshCw, Select, SegmentedControl, Server, Skeleton, Zap } from "../../ui-kit";
import type { LucideIcon } from "lucide-solid";
import { webtoolsApi } from "./api";
import BundlePanel from "./BundlePanel";
import DepsPanel from "./DepsPanel";
import EnvPanel from "./EnvPanel";
import ReactPanel from "./ReactPanel";
import RoutesPanel from "./RoutesPanel";
import StylesPanel from "./StylesPanel";
import TokensPanel from "./TokensPanel";
import type { Detect, Section } from "./types";
import "./webtools.css";

const SECTIONS: { id: Section; label: MessageKey; icon: LucideIcon; show: (d: Detect) => boolean }[] = [
  { id: "tokens", label: "webtools.sec.tokens", icon: Layers, show: (d) => d.css },
  { id: "styles", label: "webtools.sec.styles", icon: ListTree, show: (d) => d.css },
  { id: "react", label: "webtools.sec.react", icon: Zap, show: (d) => d.react },
  { id: "bundle", label: "webtools.sec.bundle", icon: Gauge, show: (d) => d.bundle },
  { id: "routes", label: "webtools.sec.routes", icon: Server, show: (d) => d.backends.length > 0 },
  { id: "env", label: "webtools.sec.env", icon: KeyRound, show: (d) => d.env },
  { id: "deps", label: "webtools.sec.deps", icon: Download, show: (d) => d.packages.length > 0 },
];

/** Web and Node tools: one tab, each tool only when the repository holds the files it works on. */
const WebtoolsTab: Component<{ tab: TabInstance }> = (props) => {
  const [repoId, setRepoId] = createSignal<string | undefined>(undefined);
  const [detect, setDetect] = createSignal<Detect>();
  const [error, setError] = createSignal<string>();
  const [loading, setLoading] = createSignal(false);
  const [picked, setPicked] = createSignal<Section>();
  /** Bumped by Refresh so the open panel loads again. */
  const [round, setRound] = createSignal(0);

  const repo = () => repoId() ?? (props.tab.params?.repoId as string | undefined) ?? repos()[0]?.id;
  const available = createMemo(() => (detect() ? SECTIONS.filter((s) => s.show(detect()!)) : []));
  const requested = () => (props.tab.params?.section as Section | null | undefined) ?? undefined;
  const section = (): Section | undefined => {
    const want = picked() ?? requested();
    return available().find((s) => s.id === want)?.id ?? available()[0]?.id;
  };

  async function load() {
    const id = repo();
    if (!id) return;
    setLoading(true);
    try {
      setDetect(await webtoolsApi().detect(id));
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  createEffect(on(() => [repo(), repos().length], () => void load()));
  // a command that asks for a section wins over an earlier pick
  createEffect(on(requested, () => setPicked(undefined), { defer: true }));

  return (
    <div class="wt" data-testid="webtools-tab">
      <header class="wt__bar">
        <Icon icon={Globe} size={16} />
        <h2 class="wt__title">{t("webtools.name")}</h2>
        <Show when={repos().length > 1}>
          <Select size="sm" aria-label={t("webtools.repo")} options={repos().map((r) => ({ value: r.id, label: repoConfig(r.id)?.name ?? r.id }))} value={repo()} onChange={(v) => (setRepoId(v), setPicked(undefined))} />
        </Show>
        <span class="wt__spacer" />
        <IconButton icon={RefreshCw} label={t("webtools.refresh")} size="sm" loading={loading()} onClick={() => (void load(), setRound(round() + 1))} />
      </header>
      <Show when={error()}>
        <p class="wt__error" role="alert">{error()}</p>
      </Show>
      <Show when={repo()} fallback={<EmptyState icon={Globe} size="sm" title={t("webtools.noRepo")} description={t("webtools.noRepoDesc")} />}>
        <Show when={detect()} fallback={<Show when={!error()}><div class="wt__loading"><Skeleton height={22} /><Skeleton height={22} /></div></Show>}>
          <Show when={available().length > 0} fallback={<EmptyState icon={Globe} size="sm" title={t("webtools.nothing")} description={t("webtools.nothingDesc")} />}>
            <SegmentedControl
              size="sm"
              aria-label={t("webtools.sections")}
              value={section()!}
              onChange={setPicked}
              options={available().map((s) => ({ value: s.id, icon: s.icon, label: t(s.label) }))}
            />
            {/* keyed by repository and round: a refresh or another repository starts the panel afresh */}
            <For each={[`${repo()}:${round()}`]}>
              {() => (
                <>
                  <Show when={section() === "tokens"}><TokensPanel repoId={repo()!} /></Show>
                  <Show when={section() === "styles"}><StylesPanel repoId={repo()!} /></Show>
                  <Show when={section() === "react"}><ReactPanel repoId={repo()!} /></Show>
                  <Show when={section() === "bundle"}><BundlePanel repoId={repo()!} /></Show>
                  <Show when={section() === "routes"}><RoutesPanel repoId={repo()!} /></Show>
                  <Show when={section() === "env"}><EnvPanel repoId={repo()!} /></Show>
                  <Show when={section() === "deps"}><DepsPanel repoId={repo()!} packages={detect()!.packages} /></Show>
                </>
              )}
            </For>
          </Show>
        </Show>
      </Show>
    </div>
  );
};

export default WebtoolsTab;
