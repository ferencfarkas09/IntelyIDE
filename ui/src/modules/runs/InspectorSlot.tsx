import { createSignal, ErrorBoundary, For, onCleanup, Show, Suspense, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t } from "../../i18n";
import { inspectorPanels } from "../../platform/inspector";
import { EmptyState, ScrollArea, Spinner, TriangleAlert } from "../../ui-kit";

/**
 * Right side of the Agent workspace: the run details as stacked cards, one per panel that a module contributed with
 * `registerInspectorPanel` (This run, Checkpoints, ...). A new panel is a new card; nothing is hidden behind a tab.
 */
/**
 * Mounts its content the first time the card scrolls into view, and keeps it. With tabs only the chosen panel loaded; stacked,
 * a panel far down the column (a timeline that reads the checkpoints of the run) does not start its work until it is looked at.
 */
function WhenSeen(props: { children: JSX.Element }) {
  const [seen, setSeen] = createSignal(typeof IntersectionObserver === "undefined");
  const watch = (el: HTMLElement) => {
    if (seen()) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && (setSeen(true), io.disconnect()), { rootMargin: "200px" });
    io.observe(el);
    onCleanup(() => io.disconnect());
  };
  return (
    <div class="inspector__seen" ref={watch}>
      <Show when={seen()} fallback={<div class="inspector__loading" />}>
        {props.children}
      </Show>
    </div>
  );
}

export function InspectorSlot() {
  return (
    <aside class="inspector" aria-label={t("runs.inspector.title")}>
      <Show when={inspectorPanels().length > 0} fallback={<EmptyState size="sm" title={t("runs.inspector.title")} description={t("runs.inspector.empty")} />}>
        <ScrollArea class="inspector__scroll">
          <div class="inspector__stack">
            <For each={inspectorPanels()}>
              {(panel) => (
                <section class="inspector__card glass-panel" aria-label={panel.title} data-panel={panel.id}>
                  <h2 class="inspector__card-title">{panel.title}</h2>
                  <div class="inspector__card-body">
                    <ErrorBoundary fallback={(err) => <EmptyState tone="danger" icon={TriangleAlert} size="sm" title={t("runs.agent.loadFail", { title: panel.title })} description={err instanceof Error ? err.message : String(err)} />}>
                      <WhenSeen>
                        <Suspense fallback={<div class="inspector__loading"><Spinner /></div>}>
                          <Dynamic component={panel.component} />
                        </Suspense>
                      </WhenSeen>
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
