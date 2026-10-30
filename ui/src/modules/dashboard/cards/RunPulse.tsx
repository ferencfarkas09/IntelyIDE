import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { fmtTokens } from "../../../components/chat/format";
import { t } from "../../../i18n";
import { setAppMode } from "../../../platform/mode";
import { requestNewRun } from "../../../platform/newRun";
import type { WidgetProps } from "../../../platform/widgets";
import { agentRows, agentsError, agentsLoaded } from "../../../store/agents";
import { Bot, Button, KpiTile, Plus } from "../../../ui-kit";
import { reviewedRuns } from "../../runs/reviewed";
import { formatUsd } from "../../usage/format";
import { pulseOf } from "../logic";
import { CardEmpty, CardError, CardLoading } from "../parts";

/** Run Pulse: what the agents are doing right now and what today cost, with a Start run button. */
export default function RunPulse(props: WidgetProps) {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    onCleanup(() => clearInterval(id));
  });
  const pulse = createMemo(() => pulseOf(agentRows(), reviewedRuns(), now()));
  const start = () => void requestNewRun({ prompt: "" });
  const openAgents = () => setAppMode("agent");
  return (
    <Show when={agentsLoaded()} fallback={<CardLoading />}>
      <Show when={!agentsError()} fallback={<CardError message={agentsError()} />}>
        <Show
          when={agentRows().length > 0}
          fallback={
            <CardEmpty
              icon={Bot}
              title={t("dash.pulse.empty")}
              why={t("dash.pulse.emptyWhy")}
              action={
                <Button size="sm" variant="primary" icon={Plus} onClick={start}>
                  {t("dash.pulse.start")}
                </Button>
              }
            />
          }
        >
          <div class="dash-kpis" data-size={props.size}>
            <KpiTile label={t("dash.pulse.running")} value={String(pulse().running)} />
            <KpiTile label={t("dash.pulse.needsYou")} value={String(pulse().needsYou)} class={pulse().needsYou > 0 ? "dash-kpi--warn" : undefined} />
            <KpiTile label={t("dash.pulse.ready")} value={String(pulse().ready)} />
            <KpiTile label={t("dash.pulse.failed")} value={String(pulse().failed)} class={pulse().failed > 0 ? "dash-kpi--danger" : undefined} />
          </div>
          <p class="dash-line ui-tnum">
            {t("dash.pulse.today", { tokens: fmtTokens(pulse().tokensToday), cost: formatUsd(pulse().costToday) })}
            <Show when={pulse().costPartial}> {t("dash.pulse.costPartial")}</Show>
          </p>
          <div class="dash-actions">
            <Button size="sm" variant="primary" icon={Plus} onClick={start}>
              {t("dash.pulse.start")}
            </Button>
            <Button size="sm" variant="ghost" onClick={openAgents}>
              {t("dash.pulse.openAgents")}
            </Button>
          </div>
        </Show>
      </Show>
    </Show>
  );
}
