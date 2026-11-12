import { ErrorBoundary, For, Show, Suspense } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t } from "../../i18n";
import { inspectorPanels } from "../../platform/inspector";
import { EmptyState, ScrollArea, Spinner, TriangleAlert } from "../../ui-kit";

/**
 * Right side of the Agent workspace: the run details as stacked cards, one per panel that a module contributed with
 * `registerInspectorPanel` (This run, Checkpoints, ...). A new panel is a new card; nothing is hidden behind a tab.
 */
export function InspectorSlot() {
  return (
    <aside class="inspector" aria-label={t("runs.inspector.title")}>
      <Show when={inspectorPanels().length > 0} fallback={<EmptyState size="sm" title={t("runs.inspector.title")} description={t("runs.inspector.empty")} />}>
        <ScrollArea class="inspector__scroll">
          <div class="inspector__stack">
            <For each={inspectorPanels()}>
              {(panel) => (
                <section class="inspector__card" aria-label={panel.title} data-panel={panel.id}>
                  <h2 class="inspector__card-title">{panel.title}</h2>
                  <div class="inspector__card-body">
                    <ErrorBoundary fallback={(err) => <EmptyState tone="danger" icon={TriangleAlert} size="sm" title={t("runs.agent.loadFail", { title: panel.title })} description={err instanceof Error ? err.message : String(err)} />}>
                      <Suspense fallback={<div class="inspector__loading"><Spinner /></div>}>
                        <Dynamic component={panel.component} />
                      </Suspense>
                    </ErrorBoundary>
                  </div>
                </section>
              )}
            </For>
          </div>
        </ScrollArea>
      </Show>
    </aside>
  );
}
