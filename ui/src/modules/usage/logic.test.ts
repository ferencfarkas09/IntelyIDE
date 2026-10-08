import { describe, expect, it } from "vitest";
import { addDays, busiestDays, dailySeries, dateOf, dayNumber, heatmap, levelOf, limitTone, metricOf, modelShares, percent, periods, sum, thresholds, untilReset, weekdayOf, windows, ZERO } from "./logic";
import type { DayUsage, UsageReport, UsageTotals } from "./types";

const totals = (input: number, cost = 0, turns = 1): UsageTotals => ({ input, output: Math.round(input / 10), cacheRead: input * 5, cacheWrite: 0, costUsd: cost, turns });
const day = (date: string, input: number, cost = 0): DayUsage => ({ date, ...totals(input, cost) });

/** 2026-10-07 is a Wednesday. */
function report(days: DayUsage[], today = "2026-10-07"): UsageReport {
  return {
    generatedMs: 0, tzOffsetMin: 0, today, runs: 1, firstMs: null, lastMs: null, total: sum(days),
    days, hours: Array.from({ length: 24 }, () => ZERO), weekdays: Array.from({ length: 7 }, () => ZERO), models: [],
  };
}

describe("dates", () => {
  it("counts days and weekdays like the calendar, in UTC, whatever the machine's zone", () => {
    expect(dayNumber("1970-01-01")).toBe(0);
    expect(dayNumber("2026-10-07")).toBe(20_733);
    expect(dateOf(20_733)).toBe("2026-10-07");
    expect(addDays("2026-10-07", 1)).toBe("2026-10-08");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    // Monday is 0
    expect([weekdayOf("2026-10-05"), weekdayOf("2026-10-07"), weekdayOf("2026-10-11"), weekdayOf("1970-01-01"), weekdayOf("1969-12-31")]).toEqual([0, 2, 6, 3, 2]);
  });
});

describe("periods", () => {
  it("counts today, the last 7 and the last 30 days with today included, and everything", () => {
    const r = report([day("2026-10-07", 100), day("2026-10-01", 10), day("2026-09-30", 1), day("2026-09-08", 1000), day("2026-09-07", 100_000)]);
    const p = periods(r);
    expect(p.today.input).toBe(100);
    expect(p.week.input).toBe(110); // Oct 1..7 is seven days, Sep 30 is the eighth
    expect(p.month.input).toBe(1111); // Sep 8 is the 30th day back, Sep 7 the 31st
    expect(p.all.input).toBe(101_111);
  });

  it("ignores a day after today (a clock that is behind the logs) in the windows", () => {
    const p = periods(report([day("2026-10-08", 5), day("2026-10-07", 1)]));
    expect([p.today.input, p.week.input]).toEqual([1, 1]);
  });
});

describe("metrics", () => {
  it("counts fresh tokens or cost, never the cache", () => {
    const t = totals(1000, 0.25);
    expect(metricOf(t, "tokens")).toBe(1100);
    expect(metricOf(t, "cost")).toBe(0.25);
  });
});

describe("dailySeries", () => {
  it("is the last n days with today last and a zero where nothing was used", () => {
    const s = dailySeries(report([day("2026-10-07", 5), day("2026-10-05", 3)]), 4);
    expect(s.map((p) => p.date)).toEqual(["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(s.map((p) => p.totals.input)).toEqual([0, 3, 0, 5]);
  });
});

describe("levels", () => {
  it("cuts the days that have usage into quarters and leaves the empty ones at 0", () => {
    const cuts = thresholds([0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(cuts).toEqual([2, 4, 6]);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((v) => levelOf(v, cuts))).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
    // four days of different sizes take one level each
    expect([55, 220, 440, 880].map((v) => levelOf(v, thresholds([55, 220, 440, 880])))).toEqual([1, 2, 3, 4]);
    expect(thresholds([0, 0])).toEqual([0, 0, 0]);
    expect(levelOf(5, [0, 0, 0])).toBe(4);
    expect(levelOf(Number.NaN, cuts)).toBe(0);
  });
});

describe("heatmap", () => {
  const r = report([day("2026-10-07", 800), day("2026-10-06", 200), day("2026-10-01", 50), day("2025-10-14", 400), day("2025-10-05", 999_999)]);

  it("is 53 columns of 7 days, Monday first, ending in the week of today with the days after it empty", () => {
    const h = heatmap(r, "tokens");
    expect(h.columns).toHaveLength(53);
    expect(h.columns.every((c) => c.length === 7)).toBe(true);
    expect(h.columns.every((c) => weekdayOf(c[0].date) === 0)).toBe(true);
    const last = h.columns.at(-1)!;
    expect(last.map((c) => c.date)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
    expect(last.map((c) => c.future)).toEqual([false, false, false, true, true, true, true]);
    expect(h.columns[0][0].date).toBe("2025-10-06");
  });

  it("puts a day in its cell with its level, and leaves what falls before the first week out", () => {
    const h = heatmap(r, "tokens");
    const cell = (date: string) => h.columns.flat().find((c) => c.date === date)!;
    expect(cell("2026-10-07")).toMatchObject({ value: 880, level: 4 });
    expect(cell("2026-10-06").level).toBeLessThan(cell("2026-10-07").level);
    expect(cell("2026-10-02").level).toBe(0);
    expect(cell("2025-10-14").value).toBe(440);
    expect(h.columns.flat().some((c) => c.date === "2025-10-05")).toBe(false);
    expect(h.max).toBe(880);
  });

  it("gives days that are all the same size the full colour, not the palest", () => {
    const h = heatmap(report([day("2026-10-07", 100), day("2026-10-06", 100)]), "tokens", 2);
    expect(h.columns.flat().filter((c) => c.value > 0).map((c) => c.level)).toEqual([4, 4]);
  });

  it("follows the metric", () => {
    const withCost = report([{ ...day("2026-10-07", 800), costUsd: 3 }, { ...day("2026-10-06", 900), costUsd: 1 }]);
    expect(heatmap(withCost, "tokens").max).toBe(990);
    expect(heatmap(withCost, "cost").max).toBe(3);
  });

  it("labels each month once, over the first week that has its first days in it", () => {
    const h = heatmap(r, "tokens");
    expect(h.months[0]).toEqual({ column: 0, month: 10 });
    expect(h.months.map((m) => m.month)).toEqual([10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const cols = h.months.map((m) => m.column);
    expect(cols).toEqual([...cols].sort((a, b) => a - b));
    expect(new Set(cols).size).toBe(cols.length);
  });

  it("an empty report is a grid of empty days", () => {
    const h = heatmap(report([]), "tokens", 4);
    expect(h.columns).toHaveLength(4);
    expect(h.columns.flat().every((c) => c.level === 0)).toBe(true);
    expect(h.max).toBe(0);
  });
});

describe("busiestDays", () => {
  it("lists the biggest first, the later day first on a tie, and none that is empty", () => {
    const r = report([day("2026-10-01", 100), day("2026-10-02", 300), day("2026-10-03", 300), day("2026-10-04", 0), day("2026-10-05", 50)]);
    expect(busiestDays(r, "tokens", 3).map((d) => d.date)).toEqual(["2026-10-03", "2026-10-02", "2026-10-01"]);
    expect(busiestDays(r, "tokens", 10)).toHaveLength(4);
    expect(busiestDays(r, "cost", 3)).toEqual([]);
  });
});

describe("modelShares", () => {
  it("shares the whole out, the most used first", () => {
    const m = [{ model: "haiku", ...totals(100) }, { model: "opus", ...totals(300) }];
    const s = modelShares(m, "tokens");
    expect(s.map((x) => x.model.model)).toEqual(["opus", "haiku"]);
    expect(s.map((x) => Math.round(x.share * 100))).toEqual([75, 25]);
    expect(modelShares(m, "cost").every((x) => x.share === 0)).toBe(true);
  });
});

describe("plan limits", () => {
  it("is calm below 70 percent, warns below 90 and then alarms", () => {
    expect([0, 69.9, 70, 89.9, 90, 100].map(limitTone)).toEqual(["ok", "ok", "warn", "warn", "danger", "danger"]);
  });

  it("clamps what a bar can draw and counts down to a reset", () => {
    expect([percent(-5), percent(42), percent(140), percent(Number.NaN)]).toEqual([0, 42, 100, 0]);
    expect(untilReset("2026-10-07T20:30:00Z", Date.parse("2026-10-07T18:00:00Z"))).toBe(9_000_000);
    expect(untilReset("2026-10-07T20:30:00Z", Date.parse("2026-10-08T00:00:00Z"))).toBe(0);
    expect(untilReset("soon", 0)).toBeUndefined();
  });

  it("lists the windows that exist, in a fixed order, and none when the plan says nothing", () => {
    expect(windows({ available: false, reason: "noClaude" })).toEqual([]);
    const w = windows({ available: true, plan: "max", sevenDay: { utilization: 15, resetsAt: "b" }, fiveHour: { utilization: 130, resetsAt: "a" } });
    expect(w.map((x) => [x.key, x.utilization])).toEqual([["fiveHour", 100], ["sevenDay", 15]]);
  });
});
