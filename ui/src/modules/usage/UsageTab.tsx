import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { fmt, t } from "../../i18n";
import { ChartColumn, EmptyState, IconButton, RefreshCw, SegmentedControl, Skeleton } from "../../ui-kit";
import { DailyChart, Heatmap, HourBars, WeekdayBars } from "./Charts";
import { BusiestList, LimitsCard, ModelList, PeriodCards } from "./Parts";
import { periods } from "./logic";
import { error, limits, loading, metric, refreshUsage, report, setMetric } from "./store";
import type { Metric } from "./types";
import "./usage.css";

/** Plan limits move slowly and cost a CLI start to read: the view asks for them every two minutes while it is on screen. */
const POLL_MS = 120_000;

/** The Usage tab: how much of the plan is left, and what the runs of this IDE have used, by day, hour and model. */
export default function UsageTab() {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    void refreshUsage(true);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const poll = setInterval(() => document.visibilityState === "visible" && void refreshUsage(true), POLL_MS);
    onCleanup(() => (clearInterval(tick), clearInterval(poll)));
  });
  const p = createMemo(() => (report() ? periods(report()!) : undefined));
  const options = (): { value: Metric; label: string }[] => [
    { value: "tokens", label: t("usage.metric.tokens") },
    { value: "cost", label: t("usage.metric.cost") },
  ];
  return (
    <div class="usage-tab">
      <div class="usage" data-testid="usage">
        <header class="usage__head">
          <div class="usage__heading">
            <h2 class="usage__title">{t("usage.name")}</h2>
            <p class="usage__sub">{t("usage.sub")}</p>
          </div>
          <div class="usage__tools">
            <SegmentedControl size="sm" aria-label={t("usage.metric.aria")} options={options()} value={metric()} onChange={setMetric} />
            <IconButton icon={RefreshCw} size="sm" label={t("usage.refresh")} loading={loading()} onClick={() => void refreshUsage(true)} />
          </div>
        </header>

        <Show when={error()}>
          <EmptyState tone="danger" size="sm" icon={ChartColumn} title={t("usage.failed")} description={error()} />
        </Show>

        <LimitsCard limits={limits()} now={now()} />

        <Show
          when={report()}
          fallback={
            <Show when={!error()}>
              <div class="usage__loading">
                <Skeleton height={86} />
                <Skeleton height={140} />
              </div>
            </Show>
          }
        >
          {(rep) => (
            <>
              <PeriodCards periods={p()!} metric={metric()} />
              <Show when={rep().total.turns > 0} fallback={<EmptyState size="sm" icon={ChartColumn} title={t("usage.empty")} description={t("usage.emptyDesc")} />}>
                <section class="usage-card" aria-labelledby="usage-daily-h">
                  <h3 id="usage-daily-h" class="usage-card__title">{t("usage.daily.title")}</h3>
                  <DailyChart report={rep()} metric={metric()} days={30} />
                </section>
                <section class="usage-card" aria-labelledby="usage-heat-h">
                  <h3 id="usage-heat-h" class="usage-card__title">{t("usage.heat.title")}</h3>
                  <Heatmap report={rep()} metric={metric()} />
                </section>
                <div class="usage__cols">
                  <section class="usage-card" aria-labelledby="usage-busy-h">
                    <h3 id="usage-busy-h" class="usage-card__title">{t("usage.busiest.title")}</h3>
                    <BusiestList report={rep()} metric={metric()} />
                  </section>
                  <section class="usage-card" aria-labelledby="usage-models-h">
                    <h3 id="usage-models-h" class="usage-card__title">{t("usage.models.title")}</h3>
                    <ModelList report={rep()} metric={metric()} />
                  </section>
                </div>
                <section class="usage-card" aria-labelledby="usage-hours-h">
                  <h3 id="usage-hours-h" class="usage-card__title">{t("usage.hours.title")}</h3>
                  <HourBars report={rep()} metric={metric()} />
                </section>
                <section class="usage-card" aria-labelledby="usage-weekdays-h">
                  <h3 id="usage-weekdays-h" class="usage-card__title">{t("usage.weekdays.title")}</h3>
                  <WeekdayBars report={rep()} metric={metric()} />
                </section>
              </Show>
              <p class="usage__foot">
                {t("usage.foot", { runs: rep().runs, since: rep().firstMs ? fmt.date(rep().firstMs!, "medium") : "–" })}
              </p>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

