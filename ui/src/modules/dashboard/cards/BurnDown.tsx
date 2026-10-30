import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { fmt, t } from "../../../i18n";
import type { WidgetProps } from "../../../platform/widgets";
import { Button, Gauge, ProgressBar, Sparkline } from "../../../ui-kit";
import { formatUsd } from "../../usage/format";
import { periods, untilReset, windows } from "../../usage/logic";
import { openUsage } from "../../usage/open";
import { error, limits, loading, refreshUsage, report } from "../../usage/store";
import { lastDays, limitTone } from "../logic";
import { CardEmpty, CardError, CardLoading } from "../parts";

/** Reading the plan limits starts the Claude CLI for a moment: never more often than the Usage tab does (every two minutes). */
const MIN_GAP_MS = 120_000;
let lastRead = 0;

function refresh(force = false): void {
  const now = Date.now();
  if (!force && now - lastRead < MIN_GAP_MS && report()) return;
  lastRead = now;
  void refreshUsage(true);
}

const WINDOW_KEY = { fiveHour: "dash.burn.fiveHour", sevenDay: "dash.burn.sevenDay", sevenDayOpus: "dash.burn.sevenDayOpus", sevenDaySonnet: "dash.burn.sevenDaySonnet" } as const;

/** Burn-down: how much of the plan's 5-hour and weekly windows is used, today's spend and the last 14 days. */
export default function BurnDown(props: WidgetProps) {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    refresh();
    const id = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => clearInterval(id));
  });
  createEffect(on(props.refreshTick, () => refresh(), { defer: true }));
  const today = createMemo(() => (report() ? periods(report()!).today : undefined));
  const spark = createMemo(() => {
    const r = report();
    return r ? lastDays(r.days.map((d) => ({ date: d.date, value: d.costUsd })), r.today, 14) : [];
  });
  const shown = createMemo(() => {
    const l = limits();
    return l && l.available ? windows(l).filter((w) => w.key === "fiveHour" || w.key === "sevenDay" || props.size === "l") : [];
  });
  const resetIn = (iso: string) => {
    const ms = untilReset(iso, now());
    if (ms === undefined) return "";
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60_000);
    return h > 0 ? t("dash.burn.resetsHours", { h, m }) : t("dash.burn.resetsMinutes", { m });
  };
  const noPlan = () => {
    const l = limits();
    return l && !l.available ? l.reason : undefined;
  };
  return (
    <Show when={report() || error()} fallback={<CardLoading />}>
      <Show when={!error() || report()} fallback={<CardError message={error()} onRetry={() => refresh(true)} />}>
        <Show when={shown().length > 0}>
          <ul class="dash-bars">
            <For each={shown()}>
              {(w) => (
                <li class="dash-bar">
                  <div class="dash-bar__head">
                    <span>{t(WINDOW_KEY[w.key])}</span>
                    <span class="ui-tnum">{fmt.number(Math.round(w.utilization))}%</span>
                  </div>
                  <ProgressBar size="sm" value={w.utilization} tone={limitTone(w.utilization)} aria-label={t(WINDOW_KEY[w.key])} />
                  <span class="dash-bar__hint">{resetIn(w.resetsAt)}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={noPlan()}>
          {(reason) => <p class="dash-hint">{t(reason() === "noClaude" ? "dash.burn.noClaude" : reason() === "notSignedIn" ? "dash.burn.notSignedIn" : "dash.burn.limitsFailed")}</p>}
        </Show>
        <Show when={!limits() && loading()}>
          <p class="dash-hint">{t("dash.burn.limitsLoading")}</p>
        </Show>
        <Show
          when={report() && report()!.total.turns > 0}
          fallback={<CardEmpty icon={Gauge} title={t("dash.burn.empty")} why={t("dash.burn.emptyWhy")} />}
        >
          <div class="dash-burn__spend">
            <div>
              <div class="dash-label">{t("dash.burn.today")}</div>
              <div class="dash-big ui-tnum">{formatUsd(today()?.costUsd ?? 0)}</div>
            </div>
            <Sparkline values={spark()} width={160} height={36} tone="accent" title={t("dash.burn.sparkTitle")} class="dash-burn__spark" />
          </div>
          <p class="dash-hint">{t("dash.burn.estimate")}</p>
        </Show>
        <div class="dash-actions">
          <Button size="sm" variant="ghost" onClick={() => void openUsage()}>
            {t("dash.burn.open")}
          </Button>
        </div>
      </Show>
    </Show>
  );
}
