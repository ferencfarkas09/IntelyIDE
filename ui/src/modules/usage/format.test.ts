import { describe, expect, it } from "vitest";
import { dayLabel, formatMetric, formatUsd, fullDayLabel, hourLabel, monthName, shortDayLabel, weekdayName } from "./format";

describe("usage formats (English)", () => {
  it("writes money in cents below 100 dollars and whole dollars above", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(7.964)).toBe("$7.96");
    expect(formatUsd(1234.5)).toBe("$1,235");
  });

  it("writes the metric a chart shows", () => {
    expect(formatMetric(1_234_567, "tokens")).toBe("1.2M");
    expect(formatMetric(950, "tokens")).toBe("950");
    expect(formatMetric(12.5, "cost")).toBe("$12.50");
  });

  it("names days the same in every time zone", () => {
    expect(dayLabel("2026-10-07")).toBe("Wed, Oct 7");
    expect(fullDayLabel("2026-10-07")).toBe("Oct 7, 2026");
    expect(shortDayLabel("2026-10-07")).toBe("Oct 7");
  });

  it("names weekdays Monday first, months and hours", () => {
    expect([0, 2, 6].map((d) => weekdayName(d))).toEqual(["Mon", "Wed", "Sun"]);
    expect(weekdayName(0, "long")).toBe("Monday");
    expect([1, 10, 12].map(monthName)).toEqual(["Jan", "Oct", "Dec"]);
    expect([0, 7, 23].map(hourLabel)).toEqual(["00:00", "07:00", "23:00"]);
  });
});
