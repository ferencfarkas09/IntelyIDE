import { t } from "../../i18n";
import type { AgentRow } from "../../store/agents";
import { IconButton, ListChecks } from "../../ui-kit";
import { canRunTests } from "./flow";
import { autotestFlow, currentRuns } from "./instance";

/** "Run tests" in the run header: tests the run's repositories now. Unavailable while a run on them may still write. */
export default function AutotestHeaderButton(props: { agent: AgentRow }) {
  const can = () => canRunTests(currentRuns(), props.agent.agentId, props.agent.repoIds);
  return (
    <IconButton
      icon={ListChecks}
      size="sm"
      label={t("autotest.header.run")}
      tooltip={can() ? t("autotest.header.runTip") : t("autotest.header.busyTip")}
      disabled={!can()}
      onClick={() => can() && void autotestFlow().runTests(props.agent.agentId, props.agent.repoIds)}
    />
  );
}
