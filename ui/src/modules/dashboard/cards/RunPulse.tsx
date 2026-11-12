import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ago } from "../../../components/chat/AgentList";
import { fmtTokens } from "../../../components/chat/format";
import { t } from "../../../i18n";
import { setAppMode } from "../../../platform/mode";
import { requestNewRun } from "../../../platform/newRun";
import type { WidgetProps } from "../../../platform/widgets";
import { agentRows, agentsError, agentsLoaded, selectAgent } from "../../../store/agents";
import { repoConfig } from "../../../store/workspace";
import { Bot, Button, Plus, StatusDot } from "../../../ui-kit";
import { reviewedRuns } from "../../runs/reviewed";
import { setCentreView } from "../../runs/state";
import { formatUsd } from "../../usage/format";
import { pulseList, pulseOf, type PulseKind } from "../logic";
import { CardEmpty, CardError, CardLoading } from "../parts";

const TONE = { needsYou: "warn", ready: "ok", running: "accent", failed: "danger" } as const;
const STATE_KEY = { needsYou: "dash.pulse.needsYou", ready: "dash.pulse.ready", running: "dash.pulse.running", failed: "dash.pulse.failed" } as const;
const ACTION_KEY = { needsYou: "dash.pulse.answer", ready: "dash.pulse.review", running: "dash.pulse.open", failed: "dash.pulse.open" } as const;
const ACTION_ARIA = { needsYou: "dash.pulse.answerAria", ready: "dash.pulse.reviewAria", running: "dash.pulse.openAria", failed: "dash.pulse.openAria" } as const;

/** Opens a run in Agent mode, the way the Needs-You radar does. */
function openRun(agentId: string): void {
  setAppMode("agent");
  setCentreView("run");
  void selectAgent(agentId);
}

/** Run Pulse: the runs that want something (an answer, a review), the ones working and failed, and what today cost. */
export default function RunPulse(props: WidgetProps) {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    onCleanup(() => clearInterval(id));
  });
  const pulse = createMemo(() => pulseOf(agentRows(), reviewedRuns(), now()));
  const limit = () => (props.size === "s" ? 3 : props.size === "m" ? 5 : 8);
  const list = createMemo(() => pulseList(agentRows(), reviewedRuns(), limit()));
  const start = () => void requestNewRun({ prompt: "" });
  const openAgents = () => setAppMode("agent");
  const where = (repoIds: readonly string[]) => (repoIds.length ? repoIds.map((id) => repoConfig(id)?.name ?? id).join(", ") : "");
  const sub = (kind: PulseKind, role: string, repoIds: readonly string[], startedAt: number) => {
    now();
    return [t(STATE_KEY[kind]), role, where(repoIds), ago(startedAt)].filter(Boolean).join(" · ");
  };
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
          <Show when={list().items.length > 0} fallback={<p class="dash-line">{t("dash.pulse.quiet")}</p>}>
            <ul class="dash-list" data-testid="dash-pulse-list">
              <For each={list().items}>
                {(item) => (
                  <li class="dash-row dash-row--static" data-kind={item.kind}>
                    <StatusDot tone={TONE[item.kind]} pulse={item.kind === "running"} />
                    <span class="dash-row__main">
                      <span class="dash-row__title">
                        <span class="ui-truncate" title={item.row.title}>
                          {item.row.title}
                        </span>
                      </span>
                      <span class="dash-row__sub ui-truncate">{sub(item.kind, item.row.role, item.row.repoIds, item.row.startedAt)}</span>
                    </span>
                    <Button
                      class="dash-act"
                      variant={item.kind === "needsYou" ? "primary" : "secondary"}
                      aria-label={t(ACTION_ARIA[item.kind], { title: item.row.title })}
                      onClick={() => openRun(item.row.agentId)}
                    >
                      {t(ACTION_KEY[item.kind])}
                    </Button>
                  </li>
                )}
              </For>
            </ul>
            <Show when={list().more > 0}>
              <p class="dash-hint">{t("dash.pulse.more", { n: list().more })}</p>
            </Show>
          </Show>
          <p class="dash-line ui-tnum">
            {t("dash.pulse.today", { tokens: fmtTokens(pulse().tokensToday), cost: formatUsd(pulse().costToday) })}
            <Show when={pulse().costPartial}> {t("dash.pulse.costPartial")}</Show>
          </p>
          <div class="dash-actions">
            <Button size="sm" variant="ghost" onClick={openAgents}>
              {t("dash.pulse.openAgents")}
            </Button>
          </div>
        </Show>
      </Show>
    </Show>
  );
}
