import { For, Match, Show, Switch } from "solid-js";
import { fmtCountdown, modelLabel } from "../../components/chat/format";
import { t } from "../../i18n";
import { ProgressBar, Skeleton } from "../../ui-kit";
import { lazyLabels } from "../../components/lazyLabels";
import { busiestDays, limitTone, metricOf, modelShares, untilReset, windows, type Periods } from "./logic";
import { dayLabel, fmtTokens, formatMetric, formatUsd } from "./format";
import type { Metric, PlanLimits, UsageReport, UsageTotals } from "./types";

const WINDOW_LABEL = lazyLabels<"fiveHour" | "sevenDay" | "sevenDayOpus" | "sevenDaySonnet">({
  fiveHour: "usage.limits.fiveHour",
  sevenDay: "usage.limits.sevenDay",
  sevenDayOpus: "usage.limits.sevenDayOpus",
  sevenDaySonnet: "usage.limits.sevenDaySonnet",
});
const NOT_AVAILABLE = lazyLabels<"noClaude" | "notSignedIn" | "failed">({
  noClaude: "usage.limits.noClaude",
  notSignedIn: "usage.limits.notSignedIn",
  failed: "usage.limits.failed",
});

/** How much of the plan's session (5 hours) and week is used, and when each starts over. */
export function LimitsCard(props: { limits: PlanLimits | undefined; now: number }) {
  return (
    <section class="usage-card usage-limits" data-testid="limits" aria-labelledby="usage-limits-h">
      <h3 id="usage-limits-h" class="usage-card__title">
        {t("usage.limits.title")}
        <Show when={props.limits?.available && props.limits.plan}>{(plan) => <span class="usage-limits__plan">{plan()}</span>}</Show>
      </h3>
      <Switch>
        <Match when={!props.limits}>
          <div class="usage-limits__rows">
            <Skeleton height={34} />
            <Skeleton height={34} />
          </div>
        </Match>
        <Match when={props.limits && !props.limits.available ? props.limits : undefined}>
          {(l) => (
            <p class="usage-card__note" data-testid="limits-missing">
              {NOT_AVAILABLE[l().reason]}
              <Show when={l().detail}>
                <span class="usage-card__detail ui-mono"> {l().detail}</span>
              </Show>
            </p>
          )}
        </Match>
        <Match when={props.limits}>
          <div class="usage-limits__rows">
            <For each={windows(props.limits!)}>
              {(w) => {
                const left = () => untilReset(w.resetsAt, props.now);
                return (
                  <div class="usage-limit" data-testid={`limit-${w.key}`}>
                    <div class="usage-limit__head">
                      <span class="usage-limit__name">{WINDOW_LABEL[w.key]}</span>
                      <span class="usage-limit__pct ui-tnum">{t("usage.limits.used", { pct: Math.round(w.utilization) })}</span>
                    </div>
                    <ProgressBar value={w.utilization} tone={limitTone(w.utilization)} aria-label={WINDOW_LABEL[w.key]} />
                    <div class="usage-limit__reset ui-tnum">{left() === undefined ? "" : left() === 0 ? t("usage.limits.resetNow") : t("usage.limits.resetsIn", { time: fmtCountdown(left()!) })}</div>
                  </div>
                );
              }}
            </For>
          </div>
        </Match>
      </Switch>
    </section>
  );
}

/** Today, the last 7 days, the last 30 days and everything: the number for the chosen metric and what stands behind it. */
export function PeriodCards(props: { periods: Periods; metric: Metric }) {
  const cards = () =>
    [
      { id: "today", label: t("usage.period.today"), totals: props.periods.today },
      { id: "week", label: t("usage.period.week"), totals: props.periods.week },
      { id: "month", label: t("usage.period.month"), totals: props.periods.month },
      { id: "all", label: t("usage.period.all"), totals: props.periods.all },
    ] as { id: string; label: string; totals: UsageTotals }[];
  const other = (t_: UsageTotals) => (props.metric === "cost" ? t("usage.tokensIn", { tokens: fmtTokens(t_.input + t_.output) }) : formatUsd(t_.costUsd));
  return (
    <div class="usage-periods" data-testid="periods">
      <For each={cards()}>
        {(c) => (
          <section class="usage-card usage-period" data-testid={`period-${c.id}`} aria-label={c.label}>
            <h3 class="usage-card__title">{c.label}</h3>
            <div class="usage-period__value ui-tnum">{formatMetric(metricOf(c.totals, props.metric), props.metric)}</div>
            <div class="usage-period__sub ui-tnum">
              <span>{props.metric === "tokens" ? t("usage.inOut", { input: fmtTokens(c.totals.input), output: fmtTokens(c.totals.output) }) : other(c.totals)}</span>
              <Show when={props.metric === "tokens"}>
                <span>{other(c.totals)}</span>
              </Show>
            </div>
            <div class="usage-period__cache ui-tnum" title={t("usage.cacheNote")}>
              {t("usage.cache", { read: fmtTokens(c.totals.cacheRead), write: fmtTokens(c.totals.cacheWrite) })} · {t("usage.turns", { n: c.totals.turns })}
            </div>
          </section>
        )}
      </For>
    </div>
  );
}

/** The days the most was used, with a bar to compare them. */
export function BusiestList(props: { report: UsageReport; metric: Metric }) {
  const days = () => busiestDays(props.report, props.metric, 5);
  const top = () => (days().length ? metricOf(days()[0], props.metric) : 0);
  return (
    <Show when={days().length} fallback={<p class="usage-card__note">{t("usage.empty")}</p>}>
      <ol class="usage-rank" data-testid="busiest">
        <For each={days()}>
          {(d, i) => (
            <li class="usage-rank__row">
              <span class="usage-rank__n ui-tnum">{i() + 1}</span>
              <span class="usage-rank__name">{dayLabel(d.date)}</span>
              <span class="usage-rank__track" aria-hidden="true">
                <span class="usage-rank__fill" style={{ width: `${top() > 0 ? (metricOf(d, props.metric) / top()) * 100 : 0}%` }} />
              </span>
              <span class="usage-rank__value ui-tnum">{formatMetric(metricOf(d, props.metric), props.metric)}</span>
            </li>
          )}
        </For>
      </ol>
    </Show>
  );
}

/** Which models carried the work. */
export function ModelList(props: { report: UsageReport; metric: Metric }) {
  const rows = () => modelShares(props.report.models, props.metric).slice(0, 6);
  return (
    <Show when={rows().length} fallback={<p class="usage-card__note">{t("usage.empty")}</p>}>
      <ul class="usage-rank" data-testid="models">
        <For each={rows()}>
          {(r) => (
            <li class="usage-rank__row">
              <span class="usage-rank__name usage-rank__name--wide" title={r.model.model}>{modelLabel(r.model.model)}</span>
              <span class="usage-rank__track" aria-hidden="true">
                <span class="usage-rank__fill" style={{ width: `${r.share * 100}%` }} />
              </span>
              <span class="usage-rank__value ui-tnum">{formatMetric(metricOf(r.model, props.metric), props.metric)}</span>
              <span class="usage-rank__pct ui-tnum">{Math.round(r.share * 100)}%</span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
