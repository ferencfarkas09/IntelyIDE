import { createEffect, Show } from "solid-js";
import { t } from "../../i18n";
import type { AgentRow } from "../../store/agents";
import { Badge } from "../../ui-kit";
import { chipText, isFinished } from "./logic";
import { ensureDigest, entryOf } from "./store";

/** "5 files · 2 risks" on a finished run's card. Text only: the card itself is a button. */
export default function RunSummaryChip(props: { agent: AgentRow }) {
  const finished = () => isFinished(props.agent.status);
  createEffect(() => {
    if (finished()) void ensureDigest(props.agent.agentId, props.agent.status);
  });
  const digest = () => (finished() ? (entryOf(props.agent.agentId)?.digest ?? undefined) : undefined);
  return (
    <Show when={digest()}>
      {(d) => (
        <Badge size="sm" numeric tone={d().risks.length ? "warn" : "neutral"} title={t("runsummary.chip.tip")}>
          {chipText(d())}
        </Badge>
      )}
    </Show>
  );
}
