import { createEffect, For } from "solid-js";
import { t } from "../../i18n";
import { dailySeries, heatmap, metricOf } from "./logic";
import { dayLabel, formatMetric, fullDayLabel, hourLabel, monthName, shortDayLabel, weekdayName } from "./format";
import type { Metric, UsageReport, UsageTotals } from "./types";

const metricName = (metric: Metric) => (metric === "cost" ? t("usage.metric.cost") : t("usage.metric.tokens"));

/** Bars of the last `days` days: one rect per day, the newest on the right, the tallest bar as high as the chart. */
export function DailyChart(props: { report: UsageReport; metric: Metric; days?: number }) {
  const points = () => dailySeries(props.report, props.days ?? 30);
  const max = () => Math.max(0, ...points().map((p) => metricOf(p.totals, props.metric)));
  const W = 600;
  const H = 120;
  return (
    <div class="usage-chart" data-testid="daily-chart">
      <div class="usage-chart__max ui-tnum" aria-hidden="true">{formatMetric(max(), props.metric)}</div>
      <svg class="usage-chart__svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={t("usage.daily.aria", { days: points().length, metric: metricName(props.metric) })}>
        <For each={points()}>
          {(p, i) => {
            const value = () => metricOf(p.totals, props.metric);
            const slot = () => W / points().length;
            const h = () => (max() > 0 ? Math.max(value() > 0 ? 2 : 0, (value() / max()) * (H - 4)) : 0);
            return (
              <rect class="usage-chart__bar" data-empty={value() > 0 ? undefined : ""} x={i() * slot() + slot() * 0.14} width={slot() * 0.72} y={H - h()} height={h()} rx="1.5">
                <title>{`${dayLabel(p.date)}: ${formatMetric(value(), props.metric)}`}</title>
              </rect>
            );
          }}
        </For>
      </svg>
      <div class="usage-chart__axis ui-tnum" aria-hidden="true">
        <span>{shortDayLabel(points()[0]?.date ?? props.report.today)}</span>
        <span>{shortDayLabel(points()[Math.floor(points().length / 2)]?.date ?? props.report.today)}</span>
        <span>{shortDayLabel(props.report.today)}</span>
      </div>
    </div>
  );
}

/** The contribution grid of the last year: a column per week (Monday first), darker the more was used that day. */
export function Heatmap(props: { report: UsageReport; metric: Metric }) {
  const grid = () => heatmap(props.report, props.metric);
  const usedDays = () => grid().columns.flat().filter((c) => c.level > 0).length;
  let scroller: HTMLDivElement | undefined;
  // the newest week is the one that matters: start scrolled to it when the grid is wider than the tab
  createEffect(() => {
    grid();
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  });
  return (
    <div class="usage-heat" data-testid="heatmap">
      <div class="usage-heat__scroll" ref={(el) => (scroller = el)}>
        <div class="usage-heat__inner">
          <div class="usage-heat__months" aria-hidden="true">
            <For each={grid().months}>{(m) => <span style={{ left: `calc(${m.column} * (var(--heat-cell) + var(--heat-gap)))` }}>{monthName(m.month)}</span>}</For>
          </div>
          <div class="usage-heat__body">
            <div class="usage-heat__days" aria-hidden="true">
              <For each={[0, 1, 2, 3, 4, 5, 6]}>{(d) => <span>{d % 2 === 0 ? weekdayName(d) : ""}</span>}</For>
            </div>
            <div class="usage-heat__grid" role="img" aria-label={t("usage.heat.aria", { days: usedDays(), metric: metricName(props.metric) })}>
              <For each={grid().columns}>
                {(column) => (
                  <div class="usage-heat__col">
                    <For each={column}>
                      {(cell) => (
                        <span class="usage-heat__cell" data-level={cell.level} data-future={cell.future ? "" : undefined} title={cell.future ? undefined : `${fullDayLabel(cell.date)}: ${formatMetric(cell.value, props.metric)}`} />
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
      <div class="usage-heat__legend" aria-hidden="true">
        <span>{t("usage.heat.less")}</span>
        <For each={[0, 1, 2, 3, 4]}>{(l) => <span class="usage-heat__cell" data-level={l} />}</For>
        <span>{t("usage.heat.more")}</span>
      </div>
    </div>
  );
}

/** Bars over a fixed set of slots (24 hours, 7 weekdays): the tallest fills the height, the rest scale to it. */
export function SlotBars(props: { items: UsageTotals[]; metric: Metric; label: (i: number) => string; every?: number; aria: string; testid: string }) {
  const max = () => Math.max(0, ...props.items.map((x) => metricOf(x, props.metric)));
  return (
    <div class="usage-slots" data-testid={props.testid} role="img" aria-label={props.aria} style={{ "grid-template-columns": `repeat(${props.items.length}, minmax(0, 1fr))` }}>
      <For each={props.items}>
        {(item, i) => {
          const value = () => metricOf(item, props.metric);
          return (
            <div class="usage-slots__col" title={`${props.label(i())}: ${formatMetric(value(), props.metric)}`}>
              <div class="usage-slots__well">
                <div class="usage-slots__bar" data-empty={value() > 0 ? undefined : ""} style={{ height: `${max() > 0 ? Math.max(value() > 0 ? 3 : 0, (value() / max()) * 100) : 0}%` }} />
              </div>
              <span class="usage-slots__label ui-tnum" aria-hidden="true">{i() % (props.every ?? 1) === 0 ? props.label(i()) : ""}</span>
            </div>
          );
        }}
      </For>
    </div>
  );
}

export const HourBars = (props: { report: UsageReport; metric: Metric }) => (
  <SlotBars items={props.report.hours} metric={props.metric} label={hourLabel} every={6} aria={t("usage.hours.aria", { metric: metricName(props.metric) })} testid="hour-bars" />
);

export const WeekdayBars = (props: { report: UsageReport; metric: Metric }) => (
  <SlotBars items={props.report.weekdays} metric={props.metric} label={(d) => weekdayName(d)} aria={t("usage.weekdays.aria", { metric: metricName(props.metric) })} testid="weekday-bars" />
);
