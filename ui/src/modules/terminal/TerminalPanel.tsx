import { t } from "../../i18n";
import { createEffect, For, on, onCleanup, onMount, Show } from "solid-js";
import { setToolWindow } from "../../platform/rail";
import { workspace } from "../../store/workspace";
import { ChevronDown, Icon, IconButton, Menu, Plus, RepoBadge, SquareTerminal, X, type MenuEntry } from "../../ui-kit";
import { activateTerminal, activeTerminalId, closeTerminal, defaultRepoId, openTerminal, terminals, viewOf, type TerminalInfo } from "./store";
import "./terminal.css";

function Tab(props: { tab: TerminalInfo }) {
  const repo = () => workspace()?.repos.find((r) => r.id === props.tab.repoId);
  const active = () => activeTerminalId() === props.tab.id;
  return (
    <div
      class="term__tab"
      role="tab"
      aria-selected={active()}
      tabIndex={active() ? 0 : -1}
      data-exited={props.tab.exit ? "" : undefined}
      title={props.tab.cwd}
      onClick={() => activateTerminal(props.tab.id)}
      onAuxClick={(e) => e.button === 1 && (e.preventDefault(), closeTerminal(props.tab.id))}
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), activateTerminal(props.tab.id))}
    >
      <Show when={repo()} fallback={<Icon icon={SquareTerminal} size={14} />}>
        {(r) => <RepoBadge color={r().color} badge={r().badge} size={16} />}
      </Show>
      <span class="term__title ui-truncate">{props.tab.title}</span>
      <Show when={props.tab.exit}>
        <span class="term__exit">{t("term.exited")}</span>
      </Show>
      <IconButton icon={X} label={t("term.close", { title: props.tab.title })} size="sm" iconSize={12} class="term__close" tabIndex={-1} onClick={(e) => (e.stopPropagation(), closeTerminal(props.tab.id))} />
    </div>
  );
}

/** The bottom tool window: one tab per shell. The xterm instances live in the store, so hiding the panel keeps them. */
export default function TerminalPanel() {
  let body!: HTMLDivElement;
  let fitFrame = 0;
  const activeView = () => (activeTerminalId() ? viewOf(activeTerminalId()!) : undefined);
  const fitActive = () => {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => activeView()?.fit());
  };
  const resizeWatch = typeof ResizeObserver === "function" ? new ResizeObserver(fitActive) : undefined;

  onMount(() => {
    resizeWatch?.observe(body);
    // The first visit starts a shell; later visits find the tabs as they were left.
    if (!terminals().length) void openTerminal({ repoId: defaultRepoId() });
  });
  onCleanup(() => {
    resizeWatch?.disconnect();
    cancelAnimationFrame(fitFrame);
    terminals().forEach((t) => viewOf(t.id)?.detach());
  });

  createEffect(() => {
    const active = activeTerminalId();
    for (const t of terminals()) {
      const view = viewOf(t.id);
      if (!view) continue;
      view.attach(body);
      view.host.hidden = t.id !== active;
      void view.setWebgl(t.id === active);
    }
  });
  createEffect(
    on(activeTerminalId, () => {
      fitActive();
      requestAnimationFrame(() => activeView()?.focus());
    }),
  );

  const repoMenu = (): MenuEntry[] =>
    [...(workspace()?.repos ?? [])]
      .sort((a, b) => a.order - b.order)
      .map((r) => ({ label: r.name, description: r.path, onSelect: () => void openTerminal({ repoId: r.id }) }));

  return (
    <div class="term">
      <div class="term__bar">
        <div class="term__tabs" role="tablist" aria-label={t("term.tabs")}>
          <For each={terminals()}>{(tab) => <Tab tab={tab} />}</For>
        </div>
        <IconButton icon={Plus} label={t("term.new")} size="sm" onClick={() => void openTerminal({ repoId: defaultRepoId() })} />
        <Show when={repoMenu().length > 1}>
          <Menu
            items={repoMenu()}
            placement="top-end"
            aria-label={t("term.newIn")}
            trigger={(p) => <IconButton {...p} icon={ChevronDown} label={t("term.newInRepo")} size="sm" />}
          />
        </Show>
        <IconButton icon={X} label={t("tabs.hidePanel")} size="sm" class="term__hide" onClick={() => setToolWindow("bottom", null)} />
      </div>
      <div class="term__body" ref={body} />
    </div>
  );
}
