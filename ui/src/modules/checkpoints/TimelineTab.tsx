import { Show } from "solid-js";
import { t } from "../../i18n";
import type { TabInstance } from "../../platform/tabs";
import { EmptyState, History } from "../../ui-kit";
import { CheckpointTimeline } from "./Timeline";

/** The timeline in a tab of its own (palette: Show checkpoints), for the run in the tab's params. */
export default function TimelineTab(props: { tab: TabInstance }) {
  const runId = () => (typeof props.tab.params?.runId === "string" ? (props.tab.params.runId as string) : undefined);
  return (
    <div class="cp-tab">
      <Show when={runId()} keyed fallback={<EmptyState icon={History} size="sm" title={t("checkpoints.timeline.noRun")} />}>
        {(id) => <CheckpointTimeline runId={id} />}
      </Show>
    </div>
  );
}
