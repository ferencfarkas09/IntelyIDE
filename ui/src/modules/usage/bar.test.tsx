import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../i18n/locales/en/usage.json";
import hu from "../../i18n/locales/hu/usage.json";

const opened = vi.hoisted(() => ({ n: 0 }));
vi.mock("./open", () => ({ openUsage: () => ++opened.n, USAGE_TAB_ID: "usage" }));

// jsdom has no ResizeObserver; the popover measures its anchor with one
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

import { resetStatusItems, statusItems } from "../../platform/statusbar";
import { createMockUsage, normalizeLimits, setUsageApi } from "./api";
import { barItems, FIRST_READ_MS, itemLabel, itemName, MAX_BAR_SCOPED, planBar, planBarVisible, planRows, READ_EVERY_MS, resetText, RETRY_UNAVAILABLE_MS, rowHint, startPlanBarReader } from "./bar";
import { extraScoped, scopedWindows } from "./logic";
import PlanBar from "./PlanBar";
import { limits, planShown, refreshLimits, resetUsage } from "./store";
import type { PlanLimits } from "./types";

// local times, so the wording does not depend on the machine's zone
const NOW = new Date(2026, 10, 12, 14, 0, 0).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute, 0).toISOString();
const WEEK = at(16, 9); // a Monday
const PLAN: PlanLimits = { available: true, plan: "max", fiveHour: { utilization: 76, resetsAt: at(12, 18, 50) }, sevenDay: { utilization: 42, resetsAt: WEEK }, modelScoped: [{ name: "Fable", utilization: 18, resetsAt: WEEK }] };
const use = (l: PlanLimits) => {
  setUsageApi({ report: async () => { throw new Error("not asked"); }, limits: async () => l });
  return refreshLimits();
};

beforeEach(() => {
  localStorage.clear();
  resetUsage();
  resetStatusItems();
  opened.n = 0;
  planBar.set(true);
});
afterEach(() => {
  cleanup();
  setUsageApi(undefined);
  vi.useRealTimers();
});

describe("the per-model weeks", () => {
  it("come through from the sidecar's answer under the name the plan data gives them", () => {
    const l = normalizeLimits({ ok: true, plan: "max", available: true, sevenDay: { utilization: 42, resetsAt: WEEK }, modelScoped: [{ name: "Fable", utilization: 18, resetsAt: WEEK }, { name: " ", utilization: 1, resetsAt: WEEK }, { name: "Opus", utilization: "x", resetsAt: WEEK }, { name: "Fable", utilization: 99, resetsAt: WEEK }, null] });
    expect(l).toEqual({ available: true, plan: "max", sevenDay: { utilization: 42, resetsAt: WEEK }, modelScoped: [{ name: "Fable", utilization: 18, resetsAt: WEEK }] });
    // an answer without such rows has no such field: nothing is invented
    expect(normalizeLimits({ ok: true, plan: "max", available: true, sevenDay: { utilization: 42, resetsAt: WEEK } })).not.toHaveProperty("modelScoped");
    expect(normalizeLimits({ ok: true, plan: "max", available: true, sevenDay: { utilization: 42, resetsAt: WEEK }, modelScoped: "Fable" })).not.toHaveProperty("modelScoped");
    // only per-model rows is still a plan
    expect(normalizeLimits({ ok: true, plan: null, available: true, modelScoped: [{ name: "Fable", utilization: 18, resetsAt: WEEK }] })).toMatchObject({ available: true });
  });

  it("list the named rows first, then the older Opus and Sonnet fields unless a row of that name is there", () => {
    const l: PlanLimits = { available: true, plan: "max", sevenDayOpus: { utilization: 30, resetsAt: WEEK }, sevenDaySonnet: { utilization: 5, resetsAt: WEEK }, modelScoped: [{ name: "Fable", utilization: 118, resetsAt: WEEK }, { name: "opus", utilization: 31, resetsAt: WEEK }] };
    expect(scopedWindows(l).map((w) => [w.name, w.utilization])).toEqual([["Fable", 100], ["opus", 31], ["Sonnet", 5]]);
    expect(extraScoped(l).map((w) => w.name)).toEqual(["Fable"]);
    expect(scopedWindows({ available: false, reason: "notSignedIn" })).toEqual([]);
    expect(scopedWindows(undefined)).toEqual([]);
  });
});

describe("what the bar and the popover show", () => {
  it("lists the week of all models, each model week and the 5-hour window, with whole percents and tones", () => {
    expect(planRows(PLAN)).toEqual([
      { id: "sevenDay", kind: "weekly", percent: 42, tone: "ok", resetsAt: WEEK },
      { id: "scoped:0", kind: "scoped", name: "Fable", percent: 18, tone: "ok", resetsAt: WEEK },
      { id: "fiveHour", kind: "fiveHour", percent: 76, tone: "warn", resetsAt: at(12, 18, 50) },
    ]);
    expect(barItems(PLAN).map((r) => r.id)).toEqual(["sevenDay", "scoped:0"]);
  });

  it("grades the rounded percent it shows, warning from 70 and danger from 90, and clamps what the CLI reports", () => {
    const tone = (utilization: number) => planRows({ available: true, plan: null, sevenDay: { utilization, resetsAt: WEEK } })[0];
    expect([0, 42, 69.4, 69.5, 70, 78, 89.4, 89.5, 90, 96].map((u) => tone(u).tone)).toEqual(["ok", "ok", "ok", "warn", "warn", "warn", "warn", "danger", "danger", "danger"]);
    // what is shown as "70%" is always the warning colour, in the bar and in the ring alike
    for (const u of [69.5, 70, 70.4]) expect(tone(u)).toMatchObject({ percent: 70, tone: "warn" });
    expect(tone(140)).toMatchObject({ percent: 100, tone: "danger" });
    expect(tone(-5)).toMatchObject({ percent: 0, tone: "ok" });
    expect(tone(Number.NaN)).toMatchObject({ percent: 0 });
  });

  it("has no model item when the plan reports no model week, and no item at all without a plan", () => {
    const plain: PlanLimits = { available: true, plan: "pro", fiveHour: { utilization: 10, resetsAt: at(12, 18) }, sevenDay: { utilization: 42, resetsAt: WEEK } };
    expect(barItems(plain).map((r) => r.id)).toEqual(["sevenDay"]);
    expect(planRows(plain).map((r) => r.kind)).toEqual(["weekly", "fiveHour"]);
    expect(barItems({ available: true, plan: "pro", fiveHour: { utilization: 10, resetsAt: at(12, 18) } })).toEqual([]);
    expect(barItems({ available: false, reason: "notSignedIn" })).toEqual([]);
    expect(barItems({ available: false, reason: "noClaude" })).toEqual([]);
    expect(barItems(undefined)).toEqual([]);
  });

  it("keeps the bar to a few model items and lists every one in the popover", () => {
    const many: PlanLimits = { available: true, plan: "max", sevenDay: { utilization: 1, resetsAt: WEEK }, modelScoped: ["Fable", "Opus", "Sonnet", "Haiku"].map((name) => ({ name, utilization: 5, resetsAt: WEEK })) };
    expect(barItems(many)).toHaveLength(1 + MAX_BAR_SCOPED);
    expect(planRows(many).filter((r) => r.kind === "scoped")).toHaveLength(4);
  });

  it("tells the reset as a clock time today, with the weekday on another day, and says so once it has passed", () => {
    expect(resetText(at(12, 18, 50), NOW)).toMatch(/^Resets at 0?6:50\s?PM$/);
    expect(resetText(WEEK, NOW)).toMatch(/^Resets Monday 0?9:00\s?AM$/);
    expect(resetText(at(12, 13), NOW)).toBe("Resets now");
    expect(resetText("soon", NOW)).toBe("");
  });

  it("warns in words, not only in colour, when a window is getting close", () => {
    const [weekly, , five] = planRows(PLAN);
    expect(rowHint(weekly, NOW)).toMatch(/^Resets Monday/);
    expect(rowHint(five, NOW)).toMatch(/^Getting close\. Resets at /);
    expect(rowHint({ ...five, percent: 96, tone: "danger" }, NOW)).toMatch(/^Almost used up\. Resets at /);
    expect(rowHint({ ...five, tone: "danger", resetsAt: "x" }, NOW)).toBe("Almost used up.");
  });

  it("names an item with the percent and the reset time", () => {
    const [weekly, fable] = barItems(PLAN);
    expect(itemName(weekly, NOW)).toMatch(/^Weekly plan usage: 42 percent\. Resets Monday 0?9:00\s?AM$/);
    expect(itemName(fable, NOW)).toMatch(/^Fable weekly usage: 18 percent\. Resets Monday 0?9:00\s?AM$/);
    expect(itemName({ ...weekly, resetsAt: "x" }, NOW)).toBe("Weekly plan usage: 42 percent");
  });
});

describe("the bar items", () => {
  it("render Weekly and the model week with a mini bar and the percent, and carry the three states", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    await use({ available: true, plan: "max", sevenDay: { utilization: 42, resetsAt: WEEK }, modelScoped: [{ name: "Fable", utilization: 78, resetsAt: WEEK }, { name: "Sonnet", utilization: 96, resetsAt: WEEK }] });
    render(() => <PlanBar />);
    const items = screen.getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual(["Weekly42%", "Fable78%", "Sonnet96%"]);
    expect(items.map((b) => b.getAttribute("data-tone"))).toEqual(["ok", "warn", "danger"]);
    expect(items[0].getAttribute("aria-label")).toMatch(/^Weekly plan usage: 42 percent\. Resets Monday/);
    expect(items[1].getAttribute("aria-label")).toMatch(/^Fable weekly usage: 78 percent\. Resets Monday/);
    expect((items[1].querySelector(".pb__fill") as HTMLElement).style.width).toBe("78%");
    expect(screen.getByRole("group", { name: "Plan usage" })).toBeTruthy();
  });

  it("render nothing while there is no plan data", async () => {
    render(() => <PlanBar />);
    expect(screen.queryByRole("button")).toBeNull();
    await use({ available: false, reason: "notSignedIn" });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a click opens the plan-usage popover with every window, and Open usage details opens the Usage view", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    await use(PLAN);
    render(() => <PlanBar />);
    const fable = screen.getByRole("button", { name: /^Fable weekly usage/ });
    fireEvent.click(fable);
    const panel = await screen.findByTestId("plan-usage");
    expect(screen.getByRole("dialog", { name: "Plan usage" })).toBeTruthy();
    expect(fable.getAttribute("aria-expanded")).toBe("true");
    const rows = [...panel.querySelectorAll(".pu__row")];
    expect(rows.map((r) => r.querySelector(".pu__name")?.textContent)).toEqual(["Weekly, all models", "Weekly, Fable", "5-hour window"]);
    expect(rows.map((r) => r.querySelector(".pu__pct")?.textContent)).toEqual(["42%", "18%", "76%"]);
    expect(rows.map((r) => r.getAttribute("data-tone"))).toEqual(["ok", "ok", "warn"]);
    expect(rows[2].querySelector(".pu__hint")?.textContent).toMatch(/^Getting close\. Resets at /);
    expect(screen.getAllByRole("img").map((i) => i.getAttribute("aria-label"))).toEqual(["42 percent used", "18 percent used", "76 percent used"]);
    fireEvent.click(screen.getByRole("button", { name: "Open usage details" }));
    expect(opened.n).toBe(1);
    await vi.waitFor(() => expect(screen.queryByTestId("plan-usage")).toBeNull());
  });

  it("Esc closes the popover and focus returns to the item", async () => {
    await use(PLAN);
    render(() => <PlanBar />);
    const weekly = screen.getByRole("button", { name: /^Weekly plan usage/ });
    weekly.focus();
    fireEvent.click(weekly);
    fireEvent.keyDown(await screen.findByTestId("plan-usage"), { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByTestId("plan-usage")).toBeNull());
    expect(document.activeElement).toBe(weekly);
  });
});

describe("the extra", () => {
  it("is on by default, registers one status item that shows only with plan data, and the switch takes it away", async () => {
    localStorage.clear();
    const { register } = await import("./index");
    register();
    const ids = () => statusItems("right").map((i) => i.id);
    expect(planBar.on()).toBe(true);
    expect(planBarVisible()).toBe(false);
    expect(ids()).not.toContain("usage.plan");
    await use(PLAN);
    expect(planBarVisible()).toBe(true);
    expect(ids()).toContain("usage.plan");
    planBar.set(false);
    expect(localStorage.getItem("intely.extra.planBar")).toBe("0");
    expect(ids()).not.toContain("usage.plan");
    planBar.set(true);
    expect(ids()).toContain("usage.plan");
  });

  it("reads the limits a moment after the start and then every five minutes, not while the window is hidden, and stops", async () => {
    vi.useFakeTimers();
    let asked = 0;
    setUsageApi({ report: async () => { throw new Error("not asked"); }, limits: async () => (asked++, PLAN) });
    const stop = startPlanBarReader();
    expect(asked).toBe(0);
    await vi.advanceTimersByTimeAsync(FIRST_READ_MS);
    expect(asked).toBe(1);
    expect(limits()).toEqual(PLAN);
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS);
    expect(asked).toBe(2);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS);
    expect(asked).toBe(2);
    visibility.mockRestore();
    stop();
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS * 3);
    expect(asked).toBe(2);
  });

  it("a failed read after a good one keeps the numbers, shows them as not current, and tries again at the next tick", async () => {
    vi.useFakeTimers({ now: NOW });
    let answer: () => Promise<PlanLimits> = async () => PLAN;
    let asked = 0;
    setUsageApi({ report: async () => { throw new Error("not asked"); }, limits: () => (asked++, answer()) });
    const stop = startPlanBarReader();
    await vi.advanceTimersByTimeAsync(FIRST_READ_MS);
    render(() => <PlanBar />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Weekly42%", "Fable18%"]);
    answer = async () => ({ available: false, reason: "failed", detail: "timeout" });
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS);
    expect(asked).toBe(2);
    // still there, muted, "updating…" in place of the old percent
    const items = screen.getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual(["Weeklyupdating…", "Fableupdating…"]);
    expect(items.map((b) => b.getAttribute("data-current"))).toEqual(["no", "no"]);
    expect(items[0].getAttribute("aria-label")).toBe("Weekly: not current, updating");
    // not the 30-minute wait of a missing plan: the next tick reads again, and a good answer makes it current
    answer = async () => PLAN;
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS);
    expect(asked).toBe(3);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Weekly42%", "Fable18%"]);
    stop();
  });

  it("keeps the model rows when the answer has no model_scoped field, and drops them when it is an empty list", async () => {
    await use(PLAN);
    expect(barItems(planShown()?.limits).map((r) => r.name ?? r.kind)).toEqual(["weekly", "Fable"]);
    await use(normalizeLimits({ ok: true, plan: "max", available: true, sevenDay: { utilization: 43, resetsAt: WEEK } }));
    expect(barItems(planShown()?.limits).map((r) => `${r.name ?? r.kind} ${r.percent}`)).toEqual(["weekly 43", "Fable 18"]);
    await use(normalizeLimits({ ok: true, plan: "max", available: true, sevenDay: { utilization: 44, resetsAt: WEEK }, modelScoped: [] }));
    expect(barItems(planShown()?.limits).map((r) => `${r.name ?? r.kind} ${r.percent}`)).toEqual(["weekly 44"]);
    // signed out: nothing is kept
    await use({ available: false, reason: "notSignedIn" });
    expect(planShown()).toBeUndefined();
  });

  it("shows an item as not current once its reset time has passed without a new reading, and reads once for it", async () => {
    vi.useFakeTimers({ now: NOW });
    let asked = 0;
    const soon = at(12, 14, 3);
    setUsageApi({ report: async () => { throw new Error("not asked"); }, limits: async () => (asked++, { available: true, plan: "max", sevenDay: { utilization: 97, resetsAt: soon } }) });
    const stop = startPlanBarReader();
    await vi.advanceTimersByTimeAsync(FIRST_READ_MS);
    render(() => <PlanBar />);
    expect(screen.getByRole("button").textContent).toBe("Weekly97%");
    // the reset passes; the minute check reads once (the answer still names the old time), the item says it is updating
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(asked).toBe(2);
    expect(screen.getByRole("button").textContent).toBe("Weeklyupdating…");
    // the next minute check, before the regular five-minute read
    await vi.advanceTimersByTimeAsync(55_000);
    expect(asked, "a passed reset time is read for only once").toBe(2);
    stop();
  });

  it("reads once when the window is shown again, at most once a minute", async () => {
    planBar.set(false); // the reader an earlier test registered listens too
    vi.useFakeTimers({ now: NOW });
    let asked = 0;
    setUsageApi({ report: async () => { throw new Error("not asked"); }, limits: async () => (asked++, PLAN) });
    const stop = startPlanBarReader();
    await vi.advanceTimersByTimeAsync(FIRST_READ_MS);
    expect(asked).toBe(1);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(asked, "within a minute of the last read").toBe(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toBe(2);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(asked, "hidden: no read").toBe(2);
    visibility.mockRestore();
    stop();
  });

  it("names the built-in week in full when a model class is itself called Weekly, with distinct keys", () => {
    const l: PlanLimits = { available: true, plan: "max", sevenDay: { utilization: 42, resetsAt: WEEK }, modelScoped: [{ name: "Weekly", utilization: 10, resetsAt: WEEK }, { name: "Fable", utilization: 5, resetsAt: WEEK }] };
    const rows = barItems(l);
    expect(rows.map((r) => itemLabel(r, rows))).toEqual(["Weekly (all models)", "Weekly", "Fable"]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    expect(itemLabel(barItems(PLAN)[0], barItems(PLAN))).toBe("Weekly");
  });

  it("cuts a long label by code point in the IDE too", () => {
    const name = `${"A".repeat(39)}\u{1F600}${"B".repeat(10)}`;
    const l = normalizeLimits({ ok: true, plan: "max", available: true, modelScoped: [{ name, utilization: 1, resetsAt: WEEK }, { name: `${name}x`, utilization: 2, resetsAt: WEEK }] });
    const scoped = l.available ? (l.modelScoped ?? []) : [];
    expect(scoped.map((w) => w.utilization)).toEqual([1, 2]);
    expect(scoped[0].name).toBe(`${"A".repeat(39)}\u{1F600}…`);
  });

  it("asks rarely while there is no plan to read", async () => {
    vi.useFakeTimers();
    let asked = 0;
    setUsageApi({ report: async () => { throw new Error("not asked"); }, limits: async () => (asked++, { available: false, reason: "notSignedIn" }) });
    const stop = startPlanBarReader();
    await vi.advanceTimersByTimeAsync(FIRST_READ_MS);
    expect(asked).toBe(1);
    await vi.advanceTimersByTimeAsync(READ_EVERY_MS * 5);
    expect(asked).toBe(1);
    await vi.advanceTimersByTimeAsync(RETRY_UNAVAILABLE_MS);
    expect(asked).toBe(2);
    stop();
  });

  it("a plan that cannot be read never throws and shows nothing", async () => {
    setUsageApi({ report: async () => { throw new Error("not asked"); }, limits: async () => { throw new Error("boom"); } });
    await expect(refreshLimits()).resolves.toBeUndefined();
    expect(limits()).toEqual({ available: false, reason: "failed" });
    expect(planBarVisible()).toBe(false);
  });

  it("the mock shows the three states of a bar item", async () => {
    const l = await createMockUsage(NOW, 0).limits();
    expect(barItems(l).map((r) => [r.kind, r.name, r.tone])).toEqual([["weekly", undefined, "ok"], ["scoped", "Fable", "warn"], ["scoped", "Sonnet", "danger"]]);
  });
});

describe("the strings", () => {
  it("every plan bar key exists in English and Hungarian with the same placeholders", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("planbar.") || k.startsWith("usage.section.bar") || k === "usage.limits.sevenDayScoped");
    expect(keys.length).toBeGreaterThanOrEqual(17);
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\s*[,}]/g)].map((m) => m[1]).sort();
    for (const k of keys) {
      const h = (hu as Record<string, string>)[k];
      expect(h, k).toBeTruthy();
      expect(holes(h), k).toEqual(holes((en as Record<string, string>)[k]));
    }
    expect((hu as Record<string, string>)["planbar.weekly"]).toBe("Heti");
  });
});

describe("the switch at startup", () => {
  it("honours settings.json when the webview's mirror is empty: no read and no item before the stored value is known", async () => {
    vi.resetModules();
    let resolveSettings: (v: Record<string, unknown>) => void = () => {};
    vi.doMock("../../ipc", () => ({ ipc: { settings: { get: () => new Promise((r) => (resolveSettings = r)), set: async () => undefined } } }));
    localStorage.clear();
    const api = await import("./api");
    const statusbar = await import("../../platform/statusbar");
    let asked = 0;
    api.setUsageApi({ report: async () => { throw new Error("not asked"); }, limits: async () => (asked++, PLAN) });
    vi.useFakeTimers();
    const { register } = await import("./index");
    register();
    await vi.advanceTimersByTimeAsync(FIRST_READ_MS * 2);
    expect(asked, "nothing is read while the stored switch is not known").toBe(0);
    resolveSettings({ planBar: false });
    await vi.advanceTimersByTimeAsync(FIRST_READ_MS * 2);
    expect(asked).toBe(0);
    expect(statusbar.statusItems("right").map((i) => i.id)).not.toContain("usage.plan");
    const bar = await import("./bar");
    expect(bar.planBar.on()).toBe(false);
    expect(localStorage.getItem("intely.extra.planBar")).toBe("0");
    api.setUsageApi(undefined);
    vi.doUnmock("../../ipc");
    vi.resetModules();
  });
});
