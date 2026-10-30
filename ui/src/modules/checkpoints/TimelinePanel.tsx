import { Show } from "solid-js";
import { t } from "../../i18n";
import { selectedAgentId } from "../../store/agents";
import { EmptyState, History } from "../../ui-kit";
import { CheckpointTimeline } from "./Timeline";

/** Inspector tab of the Agent workspace: the timeline of the selected run. */
export default function TimelinePanel() {
  return (
    <Show when={selectedAgentId()} keyed fallback={<EmptyState icon={History} size="sm" title={t("checkpoints.timeline.noRun")} />}>
      {(id) => <CheckpointTimeline runId={id} />}
    </Show>
  );
}
