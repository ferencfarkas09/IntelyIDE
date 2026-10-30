import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import type { DirEntry, FileRead } from "../../ipc/files";
import { setTrayPlanPercent, trayPlanPercent } from "../../store/planUsage";
import { setUsageApi, type UsageApi } from "../usage/api";
import { resetUsage } from "../usage/store";
import { lastDays, limitTone, partOfDay, pulseOf, startOfDay, subjectOf, type PulseRow } from "./logic";
import { fiveHourPercent, resetPlanPoll, startPlanPoll } from "./planPoll";
import { detectStack, pickTips, readRepoStack } from "./stack";
import { dashboardAtStart, dashboardEnabled, resetDashboardPrefs, setDashboardAtStart, setTrayPlanEnabled, syncDashboardPrefs, trayPlanEnabled } from "./toggle";

afterEach(() => {
  vi.restoreAllMocks();
  resetDashboardPrefs();
  setTrayPlanPercent(null);
  setUsageApi(undefined);
  resetUsage();
  resetPlanPoll();
  localStorage.clear();
});

const NOW = new Date(2026, 9, 29, 15, 0, 0).getTime();
const row = (agentId: string, status: PulseRow["status"], startedAt = NOW, tokens = 0, costUsd: number | null = null): PulseRow => ({
  agentId,
  status,
  startedAt,
  usage: { cumulative: { inputTokens: tokens, outputTokens: tokens, costUsd } },
});

describe("run pulse numbers", () => {
  it("counts states, leaves reviewed runs out of Ready, and sums today's usage", () => {
    const rows = [row("a", "running", NOW, 100, 0.5), row("b", "needsYou"), row("c", "done"), row("d", "done"), row("e", "error"), row("f", "done", NOW - 2 * 86_400_000, 999, 9)];
    const p = pulseOf(rows, new Set(["d", "f"]), NOW);
    expect(p).toMatchObject({ running: 1, needsYou: 1, ready: 1, failed: 1, tokensToday: 200, costToday: 0.5, costPartial: false });
  });

  it("marks the cost as partial when a run of today reports tokens but no cost", () => {
    expect(pulseOf([row("a", "done", NOW, 10, null)], new Set(), NOW).costPartial).toBe(true);
  });

  it("starts the day at local midnight", () => {
    expect(new Date(startOfDay(NOW)).getHours()).toBe(0);
    expect(startOfDay(NOW)).toBeLessThanOrEqual(NOW);
  });
});

describe("small helpers", () => {
  it("tones plan bars, fills missing days and shortens commit subjects", () => {
    expect([limitTone(10), limitTone(60), limitTone(90)]).toEqual(["ok", "warn", "danger"]);
    expect(lastDays([{ date: "2026-10-28", value: 2 }, { date: "2026-10-26", value: 1 }], "2026-10-28", 4)).toEqual([0, 1, 0, 2]);
    expect(lastDays([], "nonsense", 3)).toEqual([]);
    expect(subjectOf("fix: the thing\n\nbody")).toBe("fix: the thing");
    expect(subjectOf("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
    expect(partOfDay(new Date(2026, 0, 1, 8).getTime())).toBe("morning");
    expect(partOfDay(new Date(2026, 0, 1, 13).getTime())).toBe("afternoon");
    expect(partOfDay(new Date(2026, 0, 1, 21).getTime())).toBe("evening");
  });
});

describe("stack detection", () => {
  it("reads dependency names and the iOS and Android folders", () => {
    expect(detectStack({ dependencies: { expo: "1", "react-native": "1", react: "1" } }, ["ios", "android"])).toEqual(["expo", "react-native", "react", "ios", "android"]);
    expect(detectStack({ dependencies: { next: "1", react: "1" }, devDependencies: { sass: "1" } }, [])).toEqual(["next", "react", "sass"]);
    expect(detectStack({ dependencies: { express: "4" } }, [])).toEqual(["express"]);
    expect(detectStack({ dependencies: { lodash: "4" } }, [])).toEqual(["node"]);
    expect(detectStack(undefined, ["App.xcodeproj", "build.gradle.kts"])).toEqual(["ios", "android"]);
  });

  it("ignores anything that is not a dependency map", () => {
    expect(detectStack("react", [])).toEqual([]);
    expect(detectStack({ dependencies: ["react"], scripts: { react: "rm -rf /" } }, [])).toEqual(["node"]);
    expect(detectStack(null, [])).toEqual([]);
  });

  it("picks three tips, the most specific stack first, and fills with general ones", () => {
    expect(pickTips(["expo", "react-native", "react"]).map((t) => t.id)).toEqual(["expoOffline", "rnSafeArea", "reactStates"]);
    expect(pickTips(["sass"]).map((t) => t.id)).toEqual(["sassTokens", "explain", "bugs"]);
    expect(pickTips([]).map((t) => t.id)).toEqual(["explain", "bugs", "readme"]);
    expect(pickTips(["next"], 5).map((t) => t.id)).toEqual(["nextStates", "nextSeo", "explain", "bugs", "readme"]);
  });

  it("reads package.json through the file IPC and skips guarded, huge or broken files", async () => {
    const entries: DirEntry[] = [
      { name: "package.json", kind: "file", size: 200 },
      { name: "ios", kind: "dir" },
    ];
    const read = (text?: string): FileRead => ({ text, binary: false, tooLarge: false, size: text?.length ?? 0, mtimeMs: 0, eol: "lf", guard: "none" as never });
    vi.spyOn(ipc.files, "listDir").mockResolvedValue(entries);
    const readFile = vi.spyOn(ipc.files, "readFile").mockResolvedValue(read('{"dependencies":{"react":"18"}}'));
    expect((await readRepoStack("r")).tags).toEqual(["react", "ios"]);
    readFile.mockResolvedValue(read("{not json"));
    expect((await readRepoStack("r")).tags).toEqual(["ios"]);
    vi.spyOn(ipc.files, "listDir").mockResolvedValue([{ name: "package.json", kind: "file", size: 10, neverRead: true }]);
    readFile.mockClear();
    expect((await readRepoStack("r")).tags).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
    vi.spyOn(ipc.files, "listDir").mockResolvedValue([{ name: "package.json", kind: "file", size: 10_000_000 }]);
    expect((await readRepoStack("r")).tags).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
    vi.spyOn(ipc.files, "listDir").mockRejectedValue(new Error("gone"));
    expect(await readRepoStack("r")).toEqual({ repoId: "r", tags: [] });
  });
});

describe("dashboard preferences", () => {
  it("start on, at-start on and the menu-bar plan off; the switches persist", async () => {
    expect([dashboardEnabled(), dashboardAtStart(), trayPlanEnabled()]).toEqual([true, true, false]);
    const set = vi.spyOn(ipc.settings, "set");
    setDashboardAtStart(false);
    setTrayPlanEnabled(true);
    expect(set).toHaveBeenCalledWith("widgets", { showAtStart: false });
    expect(set).toHaveBeenCalledWith("widgets", { trayPlan: true });
    expect(localStorage.getItem("intely.dashboard.trayPlan")).toBe("1");
  });

  it("adopts the durable values unless the person already chose", async () => {
    vi.spyOn(ipc.settings, "get").mockImplementation(async (ns) => (ns === "extras" ? { dashboard: false } : { showAtStart: false, trayPlan: true }));
    setTrayPlanEnabled(false);
    await syncDashboardPrefs();
    expect([dashboardEnabled(), dashboardAtStart(), trayPlanEnabled()]).toEqual([false, false, false]);
  });
});

describe("plan usage for the menu bar", () => {
  const api = (utilization: number): UsageApi & { calls: () => number } => {
    let n = 0;
    return {
      calls: () => n,
      report: async () => Promise.reject(new Error("not used")),
      limits: async () => (n++, { available: true, plan: "max", fiveHour: { utilization, resetsAt: new Date(NOW + 3_600_000).toISOString() } }),
    };
  };

  it("reads the 5-hour window only when the plan is available", () => {
    expect(fiveHourPercent(undefined)).toBeNull();
    expect(fiveHourPercent({ available: false, reason: "noClaude" })).toBeNull();
    expect(fiveHourPercent({ available: true, plan: null, sevenDay: { utilization: 3, resetsAt: "" } })).toBeNull();
    expect(fiveHourPercent({ available: true, plan: null, fiveHour: { utilization: 41.4, resetsAt: "" } })).toBe(41.4);
  });

  it("polls only while switched on and clears the value when switched off", async () => {
    const fake = api(41.6);
    setUsageApi(fake);
    const dispose = createRoot(() => startPlanPoll());
    await Promise.resolve();
    expect(fake.calls()).toBe(0);
    expect(trayPlanPercent()).toBeNull();
    setTrayPlanEnabled(true);
    await vi.waitFor(() => expect(trayPlanPercent()).toBe(42));
    expect(fake.calls()).toBe(1);
    setTrayPlanEnabled(false);
    expect(trayPlanPercent()).toBeNull();
    dispose();
  });
});
