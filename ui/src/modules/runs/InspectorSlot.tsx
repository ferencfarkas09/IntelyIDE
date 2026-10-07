import { createSignal, ErrorBoundary, For, Show, Suspense } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t } from "../../i18n";
import { inspectorPanels } from "../../platform/inspector";
import { EmptyState, Spinner, TriangleAlert } from "../../ui-kit";

/** Right side of the Agent workspace: the tabs modules contributed with `registerInspectorPanel`. */
export function InspectorSlot() {
  const [picked, setPicked] = createSignal<string | undefined>(undefined);
  const active = () => inspectorPanels().find((p) => p.id === picked()) ?? inspectorPanels()[0];
  return (
    <aside class="inspector" aria-label={t("runs.inspector.title")}>
      <div class="inspector__tabs" role="tablist" aria-label={t("runs.inspector.title")}>
        <For each={inspectorPanels()}>
          {(p) => (
            <button type="button" role="tab" class="inspector__tab" aria-selected={active()?.id === p.id} onClick={() => setPicked(p.id)}>
              {p.title}
            </button>
          )}
        </For>
      </div>
      <div class="inspector__body" role="tabpanel">
        <Show when={active()} fallback={<EmptyState size="sm" title={t("runs.inspector.title")} description={t("runs.inspector.empty")} />} keyed>
          {(panel) => (
            <ErrorBoundary fallback={(err) => <EmptyState tone="danger" icon={TriangleAlert} size="sm" title={t("runs.agent.loadFail", { title: panel.title })} description={err instanceof Error ? err.message : String(err)} />}>
              <Suspense fallback={<div class="inspector__loading"><Spinner /></div>}>
                <Dynamic component={panel.component} />
              </Suspense>
            </ErrorBoundary>
          )}
        </Show>
      </div>
    </aside>
  );
}
