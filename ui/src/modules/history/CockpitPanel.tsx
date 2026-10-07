import { Show } from "solid-js";
import { t } from "../../i18n";
import { agentRow, selectedAgentId } from "../../store/agents";
import { EmptyState, Gauge } from "../../ui-kit";
import CockpitView from "./CockpitView";

/** The Inspector side panel of the Agent workspace: the context cockpit of the run selected in the Agents list. */
export default function CockpitPanel() {
  return (
    <Show when={selectedAgentId()} fallback={<EmptyState size="sm" icon={Gauge} title={t("cockpit.empty.title")} description={t("cockpit.empty.desc")} />} keyed>
      {(id) => <CockpitView runId={id} model={agentRow(id)?.model} />}
    </Show>
  );
}
