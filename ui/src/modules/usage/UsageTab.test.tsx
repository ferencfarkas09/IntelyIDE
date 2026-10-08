import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "../../store/testing-u2";
import { createMockUsage, setUsageApi, type UsageApi } from "./api";
import { resetUsage } from "./store";
import type { PlanLimits, UsageReport } from "./types";
import UsageTab from "./UsageTab";

installDomStubs();
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const mock = createMockUsage(NOW, 0);

const LIMITS: PlanLimits = { available: true, plan: "max", fiveHour: { utilization: 74, resetsAt: new Date(Date.now() + 2 * 3_600_000 + 5 * 60_000).toISOString() }, sevenDay: { utilization: 95, resetsAt: new Date(Date.now() + 40 * 3_600_000).toISOString() } };

function api(over: Partial<UsageApi> = {}): UsageApi & { reports: number; limitCalls: number } {
  const calls = { reports: 0, limitCalls: 0 };
  return {
    get reports() { return calls.reports; },
    get limitCalls() { return calls.limitCalls; },
    report: async (tz: number) => ((calls.reports += 1), mock.report(tz)),
    limits: async () => ((calls.limitCalls += 1), LIMITS),
    ...over,
  };
}

beforeEach(() => {
  resetUsage();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  setUsageApi(undefined);
});

describe("<UsageTab>", () => {
  it("shows the plan limits with their colour, the periods, the grid, the hours and the busiest days", async () => {
    setUsageApi(api());
    render(() => <UsageTab />);
    const limits = await screen.findByTestId("limits");
    await waitFor(() => expect(within(limits).getAllByRole("progressbar")).toHaveLength(2));
    const [session, week] = within(limits).getAllByRole("progressbar");
    expect([session.getAttribute("aria-valuenow"), session.getAttribute("data-tone")]).toEqual(["74", "warn"]);
    expect([week.getAttribute("aria-valuenow"), week.getAttribute("data-tone")]).toEqual(["95", "danger"]);
    expect(within(limits).getByText("max")).toBeTruthy();
    expect(within(screen.getByTestId("limit-fiveHour")).getByText("74% used")).toBeTruthy();
    expect(within(screen.getByTestId("limit-fiveHour")).getByText(/Resets in 2 h 5 min/)).toBeTruthy();

    const periods = await screen.findByTestId("periods");
    for (const id of ["today", "week", "month", "all"]) expect(within(periods).getByTestId(`period-${id}`)).toBeTruthy();
    expect(within(screen.getByTestId("period-today")).getByText("Today")).toBeTruthy();

    const heat = await screen.findByTestId("heatmap");
    const columns = heat.querySelectorAll(".usage-heat__col");
    expect(columns).toHaveLength(53);
    expect([...columns].every((c) => c.querySelectorAll(".usage-heat__cell").length === 7)).toBe(true);
    expect(heat.querySelectorAll('.usage-heat__grid [data-level="4"]').length).toBeGreaterThan(0);
    expect(screen.getByTestId("hour-bars").querySelectorAll(".usage-slots__col")).toHaveLength(24);
    expect(screen.getByTestId("weekday-bars").querySelectorAll(".usage-slots__col")).toHaveLength(7);
    expect(screen.getByTestId("busiest").querySelectorAll("li")).toHaveLength(5);
    expect(screen.getByTestId("models").querySelectorAll("li").length).toBeGreaterThan(0);
    expect(screen.getByTestId("daily-chart").querySelectorAll("rect")).toHaveLength(30);
  });

  it("asks for the report in the reader's time zone", async () => {
    const seen: number[] = [];
    setUsageApi(api({ report: async (tz) => (seen.push(tz), mock.report(tz)) }));
    render(() => <UsageTab />);
    await screen.findByTestId("periods");
    expect(seen).toEqual([-new Date().getTimezoneOffset()]);
  });

  it("switches every number from tokens to cost and remembers the choice", async () => {
    setUsageApi(api());
    render(() => <UsageTab />);
    const today = await screen.findByTestId("period-all");
    expect(today.textContent).not.toMatch(/^\s*All time\s*\$/);
    fireEvent.click(screen.getByRole("radio", { name: "Cost" }));
    await waitFor(() => expect(screen.getByTestId("period-all").querySelector(".usage-period__value")?.textContent).toMatch(/^\$/));
    expect(localStorage.getItem("intely.usage.metric")).toBe("cost");
    expect(screen.getByTestId("busiest").textContent).toMatch(/\$/);
  });

  it("reads again on Refresh", async () => {
    const a = api();
    setUsageApi(a);
    render(() => <UsageTab />);
    await screen.findByTestId("periods");
    expect([a.reports, a.limitCalls]).toEqual([1, 1]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(a.reports).toBe(2));
    expect(a.limitCalls).toBe(2);
  });

  it("says why the plan limits are missing without hiding the rest", async () => {
    for (const [reason, text] of [["noClaude", /Claude Code was not found/], ["notSignedIn", /signed-in Claude subscription/], ["failed", /could not be read just now/]] as const) {
      setUsageApi(api({ limits: async () => ({ available: false, reason, detail: reason === "failed" ? "timeout" : undefined }) }));
      resetUsage();
      const { unmount } = render(() => <UsageTab />);
      expect((await screen.findByTestId("limits-missing")).textContent).toMatch(text);
      expect(await screen.findByTestId("periods")).toBeTruthy();
      unmount();
    }
  });

  it("shows an empty state, not empty charts, when nothing was used yet", async () => {
    const empty: UsageReport = { ...(await mock.report(0)), days: [], runs: 0, firstMs: null, lastMs: null, models: [], hours: [], weekdays: [], total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 } };
    setUsageApi(api({ report: async () => empty }));
    render(() => <UsageTab />);
    expect(await screen.findByText("No usage yet")).toBeTruthy();
    expect(screen.queryByTestId("heatmap")).toBeNull();
    expect(screen.queryByTestId("daily-chart")).toBeNull();
    expect(screen.getByTestId("periods")).toBeTruthy();
  });

  it("reports a report that cannot be read, and keeps the limits", async () => {
    setUsageApi(api({ report: async () => { throw { code: "io", message: "no run folder" }; } }));
    render(() => <UsageTab />);
    expect(await screen.findByText("The usage could not be read")).toBeTruthy();
    expect(screen.getByText("no run folder")).toBeTruthy();
    expect(screen.queryByTestId("periods")).toBeNull();
  });

  it("counts the minutes to a reset down from the clock it is given", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T10:00:00Z"));
    try {
      setUsageApi(api({ limits: async () => ({ available: true, plan: null, fiveHour: { utilization: 10, resetsAt: "2026-10-07T10:30:00Z" } }) }));
      render(() => <UsageTab />);
      expect(await screen.findByText(/Resets in 30 min/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
