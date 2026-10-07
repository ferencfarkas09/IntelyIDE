import { ErrorBoundary, Suspense } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t } from "../../i18n";
import { showTabInAgent } from "../../platform/mode";
import { getTabType, type TabInstance } from "../../platform/tabs";
import { ArrowLeft, Button, EmptyState, Spinner, TriangleAlert } from "../../ui-kit";

/** A tab (Run history, Inspector, Review) opened from Agent mode, in the middle of the Agent workspace with a way back to the run. */
export function AgentTabView(props: { tab: TabInstance }) {
  const type = () => getTabType(props.tab.type);
  return (
    <div class="agent-tabview" data-testid="agent-tab">
      <header class="agent-tabview__bar">
        <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={() => showTabInAgent(null)}>
          {t("runs.agent.back")}
        </Button>
        <span class="agent-tabview__title ui-truncate">{props.tab.title}</span>
      </header>
      <div class="agent-tabview__body">
        <ErrorBoundary fallback={(err) => <EmptyState tone="danger" icon={TriangleAlert} title={t("runs.agent.loadFail", { title: props.tab.title })} description={err instanceof Error ? err.message : String(err)} />}>
          <Suspense fallback={<div class="agent-tabview__loading"><Spinner /></div>}>
            <Dynamic component={type()?.component} tab={props.tab} />
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}
