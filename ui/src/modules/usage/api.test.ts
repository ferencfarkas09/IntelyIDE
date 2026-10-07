import { describe, expect, it } from "vitest";
import { createMockUsage, normalizeLimits } from "./api";
import { sum } from "./logic";

describe("normalizeLimits", () => {
  it("takes the windows the sidecar names, with a plan, and leaves out the ones it does not", () => {
    const l = normalizeLimits({ ok: true, plan: "max", available: true, fiveHour: { utilization: 28, resetsAt: "2026-10-07T20:30:00Z" }, sevenDay: { utilization: 15, resetsAt: "2026-10-09T08:00:00Z" }, sevenDayOpus: null });
    expect(l).toEqual({ available: true, plan: "max", fiveHour: { utilization: 28, resetsAt: "2026-10-07T20:30:00Z" }, sevenDay: { utilization: 15, resetsAt: "2026-10-09T08:00:00Z" } });
  });

  it("says why there is nothing to show", () => {
    expect(normalizeLimits({ error: "claudeNotFound" })).toEqual({ available: false, reason: "noClaude" });
    expect(normalizeLimits({ error: "failed", detail: "timeout: initializationResult" })).toEqual({ available: false, reason: "failed", detail: "timeout: initializationResult" });
    expect(normalizeLimits({ ok: true, available: false })).toEqual({ available: false, reason: "notSignedIn" });
    expect(normalizeLimits({ ok: true, plan: "pro" })).toEqual({ available: false, reason: "notSignedIn" });
    expect(normalizeLimits(null)).toEqual({ available: false, reason: "notSignedIn" });
    expect(normalizeLimits({ fiveHour: { utilization: "a lot", resetsAt: 5 } })).toEqual({ available: false, reason: "notSignedIn" });
  });
});

describe("the browser fixture", () => {
  const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

  it("is the same history every time and ends today", async () => {
    const a = await createMockUsage(NOW, 0).report(0);
    const b = await createMockUsage(NOW, 0).report(0);
    expect(a).toEqual(b);
    expect(a.today).toBe("2026-10-07");
    expect(a.days.at(-1)?.date).toBe("2026-10-07");
    expect(a.days.length).toBeGreaterThan(80);
  });

  it("adds up the same way from every side: days, hours, weekdays and models all make the total", async () => {
    const r = await createMockUsage(NOW, 0).report(0);
    const round = (t: ReturnType<typeof sum>) => [t.input, t.output, t.cacheRead, t.cacheWrite, t.turns, Math.round(t.costUsd * 1e6)];
    for (const side of [r.days, r.hours, r.weekdays, r.models]) expect(round(sum(side))).toEqual(round(r.total));
    expect(r.hours).toHaveLength(24);
    expect(r.weekdays).toHaveLength(7);
    // working days carry more than the weekend
    expect(r.weekdays[0].turns).toBeGreaterThan(r.weekdays[6].turns);
  });

  it("counts days in the reader's time zone", async () => {
    const west = await createMockUsage(NOW, -420).report(-420);
    const east = await createMockUsage(NOW, 540).report(540);
    expect(west.tzOffsetMin).toBe(-420);
    expect(west.today).toBe("2026-10-07");
    expect(east.today).toBe("2026-10-07");
    expect(east.generatedMs).toBe(NOW);
  });

  it("reports a plan with a session and a week below the limit", async () => {
    const l = await createMockUsage(NOW, 0).limits();
    expect(l).toMatchObject({ available: true, plan: "max", fiveHour: { utilization: 28 }, sevenDay: { utilization: 15 } });
  });
});
