import { createEffect, ErrorBoundary, For, on, Show, Suspense } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t } from "../../i18n";
import { EmptyState, Icon, IconButton, Spinner, SquareTerminal, TriangleAlert, X } from "../../ui-kit";
import { agentTabInstance } from "../mode";
import { activateTab, activeTab, canCloseTab, closeTab, getTabType, tabs, type TabInstance } from "../tabs";
import "./platform.css";

/** The tab strip appears once there is more than one tab, so the single permanent Diff tab looks like the plain centre area it replaced. */
export const showTabStrip = (): boolean => tabs().length > 1;

/**
 * Whether the keyboard focus is in the editor area (a tab, its body) or nowhere in particular. The terminal, the Commit
 * panel, the dock and dialogs keep their own keys, so Ctrl+Tab only cycles tabs from here.
 */
export function editorAreaFocused(): boolean {
  const el = typeof document === "undefined" ? null : document.activeElement;
  return !el || el === document.body || !!el.closest(".etabs");
}

function Tab(props: { tab: TabInstance }) {
  const type = () => getTabType(props.tab.type);
  const active = () => activeTab()?.id === props.tab.id;
  let el!: HTMLDivElement;
  createEffect(on(active, (a) => a && el?.scrollIntoView?.({ block: "nearest", inline: "nearest" })));
  return (
    <div
      ref={el}
      class="etabs__tab"
      role="tab"
      id={`etab-${props.tab.id}`}
      aria-selected={active()}
      aria-controls="etabs-panel"
      tabIndex={active() ? 0 : -1}
      data-dirty={props.tab.dirty ? "" : undefined}
      title={props.tab.title}
      onClick={() => activateTab(props.tab.id)}
      onAuxClick={(e) => {
        if (e.button === 1) (e.preventDefault(), closeTab(props.tab.id));
      }}
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") (e.preventDefault(), activateTab(props.tab.id));
      }}
    >
      <Show when={type()}>{(ty) => <Icon icon={ty().icon} size={14} />}</Show>
      <span class="etabs__title ui-truncate">{props.tab.title}</span>
      <Show when={props.tab.dirty}>
        <span class="etabs__dirty" role="img" aria-label={t("tabs.unsaved")} />
      </Show>
      <Show when={canCloseTab(props.tab)}>
        <IconButton icon={X} label={t("tabs.close", { title: props.tab.title })} size="sm" iconSize={12} class="etabs__close" tabIndex={-1} onClick={(e) => (e.stopPropagation(), closeTab(props.tab.id))} />
      </Show>
    </div>
  );
}

/** Centre area: tab strip (dirty dot, close, middle-click, horizontal overflow) and the active tab's lazy body. */
export function EditorTabs() {
  return (
    <div class="etabs">
      <Show when={showTabStrip()}>
        <div class="etabs__strip" role="tablist" aria-label={t("tabs.label")}>
          <For each={tabs()}>{(tab) => <Tab tab={tab} />}</For>
        </div>
      </Show>
      <div class="etabs__panel" id="etabs-panel" role="tabpanel">
        {/* Keyed by id: a patch of the tab (title, dirty dot, params) updates the open body instead of remounting it. */}
        {/* A tab the Agent workspace is showing is not mounted a second time in the (hidden) editor area. */}
        <Show when={activeTab()?.id !== agentTabInstance()?.id ? activeTab()?.id : undefined} keyed fallback={<EmptyState icon={SquareTerminal} title={t("tabs.emptyTitle")} description={t("tabs.emptyText")} />}>
          {(_id) => {
            const first = activeTab()!;
            const tab = () => activeTab() ?? first;
            return (
              <ErrorBoundary fallback={(err) => <EmptyState tone="danger" icon={TriangleAlert} title={t("tabs.loadFailed", { title: tab().title })} description={err instanceof Error ? err.message : String(err)} />}>
                <Suspense fallback={<div class="etabs__loading"><Spinner /></div>}>
                  <Dynamic component={getTabType(first.type)?.component} tab={tab()} />
                </Suspense>
              </ErrorBoundary>
            );
          }}
        </Show>
      </div>
    </div>
  );
}
