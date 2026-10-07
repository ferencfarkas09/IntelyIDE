import { t } from "../../i18n";
import { createSignal, ErrorBoundary, onCleanup, onMount, Show, Suspense, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { clampSize, effectiveMax, keyboardSize, loadSplitterSize, saveSplitterSize } from "../../ui-kit/splitter-logic";
import { EmptyState, IconButton, Spinner, TriangleAlert, X } from "../../ui-kit";
import { CENTRE_MIN, DOCK_MIN, PANEL_MIN, panelVisible, setAreaWidth } from "../layout";
import { activeDockTab, dockVisible, setDockOpen } from "./dockState";
import "./dock.css";

const DEFAULT = 380;
const MIN = DOCK_MIN;
const MAX = 760;
const KEY = "shell.dock";

/**
 * Right-hand dock. The children (the rest of the layout) stay mounted whether or not the dock is open,
 * so toggling it never resets their scroll position or state.
 */
export function DockHost(props: { children: JSX.Element }) {
  const [size, setSize] = createSignal(loadSplitterSize(KEY, DEFAULT, MIN, MAX));
  const [container, setContainer] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);
  let root!: HTMLDivElement;

  /** The centre keeps at least CENTRE_MIN px, plus the Commit panel's minimum while that is open. */
  const hi = () => effectiveMax(MAX, container(), CENTRE_MIN + (panelVisible() ? PANEL_MIN : 0), 1);
  const shown = () => clampSize(size(), MIN, hi());
  const commit = (next: number, persist: boolean) => {
    const v = clampSize(next, MIN, hi());
    setSize(v);
    if (persist) saveSplitterSize(KEY, v);
  };

  onMount(() => {
    const ro = new ResizeObserver(() => (setContainer(root.clientWidth), setAreaWidth(root.clientWidth)));
    ro.observe(root);
    onCleanup(() => (ro.disconnect(), setAreaWidth(0)));
  });

  let startX = 0;
  let startSize = 0;
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startX = e.clientX;
    startSize = shown();
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent) => dragging() && commit(startSize - (e.clientX - startX), false);
  const endDrag = (e: PointerEvent) => {
    if (!dragging()) return;
    setDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    saveSplitterSize(KEY, shown());
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") return e.preventDefault(), commit(DEFAULT, true);
    if (e.key.startsWith("Arrow") && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next = keyboardSize(shown(), e.key, e.shiftKey, MIN, hi(), "backward");
    if (next === null) return;
    e.preventDefault();
    commit(next, true);
  };

  return (
    <div ref={root} class="ui-splitter dock-host" data-direction="row" data-dragging={dragging() ? "" : undefined}>
      <div class="ui-splitter__pane" style={{ flex: "1 1 0" }}>
        {props.children}
      </div>
      <Show when={dockVisible() ? activeDockTab() : undefined}>
        {(tab) => (
          <>
            <div
              class="ui-splitter__handle"
              role="separator"
              tabIndex={0}
              aria-label={t("shell.resizeDock")}
              aria-orientation="vertical"
              aria-valuemin={MIN}
              aria-valuemax={Math.round(hi())}
              aria-valuenow={Math.round(shown())}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
              onDblClick={() => commit(DEFAULT, true)}
              onKeyDown={onKeyDown}
            />
            <aside class="ui-splitter__pane dock" style={{ flex: `0 0 ${shown()}px`, width: `${shown()}px` }} aria-label={tab().title}>
              <div class="dock__tabs" role="tablist" aria-label={t("shell.dock")}>
                <span class="dock__tab" role="tab" aria-selected="true">
                  {tab().title}
                </span>
                <span class="dock__grow" />
                <IconButton icon={X} label={t("shell.hideDock")} size="sm" shortcut={tab().shortcut} onClick={() => setDockOpen(false)} />
              </div>
              <div class="dock__body" role="tabpanel">
                <ErrorBoundary
                  fallback={(err) => <EmptyState tone="danger" icon={TriangleAlert} size="sm" title={t("tabs.loadFailed", { title: tab().title })} description={err instanceof Error ? err.message : String(err)} />}
                >
                  <Suspense
                    fallback={
                      <div class="dock__loading">
                        <Spinner />
                      </div>
                    }
                  >
                    <Dynamic component={tab().component} />
                  </Suspense>
                </ErrorBoundary>
              </div>
            </aside>
          </>
        )}
      </Show>
    </div>
  );
}
