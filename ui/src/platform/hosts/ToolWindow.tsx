import { ErrorBoundary, Show, Suspense } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t } from "../../i18n";
import { EmptyState, IconButton, Spinner, TriangleAlert, X } from "../../ui-kit";
import { activeToolWindow, getRailItem, setToolWindow, type RailItem } from "../rail";
import "./platform.css";

/** The panel of a rail item, with the shared load/error states. */
export function ToolPanel(props: { item: RailItem }) {
  return (
    <ErrorBoundary fallback={(err) => <EmptyState tone="danger" icon={TriangleAlert} size="sm" title={`${props.item.title} could not load`} description={err instanceof Error ? err.message : String(err)} />}>
      <Suspense fallback={<div class="tool-loading"><Spinner /></div>}>
        <Dynamic component={props.item.panel} />
      </Suspense>
    </ErrorBoundary>
  );
}

/** The selected left tool window, or undefined while its module has not registered it (Shell then falls back to nothing). */
export const leftItem = (): RailItem | undefined => {
  const item = getRailItem(activeToolWindow("left") ?? "");
  return item?.panel && item.position === "left" ? item : undefined;
};

export const bottomItem = (): RailItem | undefined => {
  const item = getRailItem(activeToolWindow("bottom") ?? "");
  return item?.panel && item.position === "bottom" ? item : undefined;
};

/** Bottom area under the centre (terminal and friends); Shell mounts it in a splitter while a bottom tool window is selected. */
export function BottomPanel(props: { item: RailItem }) {
  return (
    <section class="bottom-panel" aria-label={props.item.title}>
      <Show when={!props.item.ownHeader}>
        <header class="bottom-panel__head">
          <span class="bottom-panel__title">{props.item.title}</span>
          <IconButton icon={X} label={t("tabs.hidePanel")} size="sm" onClick={() => setToolWindow("bottom", null)} />
        </header>
      </Show>
      <div class="bottom-panel__body">
        <ToolPanel item={props.item} />
      </div>
    </section>
  );
}
