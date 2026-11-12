import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../i18n/locales/en/agentux.json";
import hu from "../../i18n/locales/hu/agentux.json";
import type { AgentEvent } from "../../store/agent-types";
import type { AgentRow } from "../../store/agents";

const store = vi.hoisted(() => ({
  rows: {} as Record<string, { agentId: string; slashCommands?: string[]; repoIds: string[]; role: string; model: string; permission: string }>,
  views: {} as Record<string, { turnActive: boolean }>,
  sent: [] as { runId: string; text: string }[],
  events: [] as unknown[],
  loaded: [] as string[],
}));
vi.mock("../../store/agents", () => ({
  agentRow: (id: string) => store.rows[id],
  agentRows: () => Object.values(store.rows),
  agentView: (id: string) => store.views[id],
  sendMessage: async (runId: string, text: string) => void store.sent.push({ runId, text }),
  sendNote: async () => undefined,
}));
vi.mock("../inspector/runEvents", () => ({
  runLog: () => ({ status: "ready", events: store.events }),
  loadRunLog: async (id: string) => void store.loaded.push(id),
}));
const newRun = vi.hoisted(() => ({ last: undefined as { prompt: string; model?: string; role?: string } | undefined }));
vi.mock("../../platform/newRun", () => ({ requestNewRun: async (p: { prompt: string }) => ((newRun.last = p), true) }));

// jsdom has no ResizeObserver; the popover measures its anchor with one
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

import { ContextRing, summaryText } from "./ContextRing";
import { contextHistory, contextMeter, MAX_TURNS_LEFT, meterTone, ringDash, RING_LENGTH, shortTokens, turnsLeft } from "./meter";
import { resetActions } from "./actions";
import { setRunSummaryApi } from "../runsummary/api";

const usageEvent = (contextUsed: number | undefined, seq: number): AgentEvent => ({ kind: "usage", seq, usage: { model: "claude-sonnet-5-5", costBasis: "subscription", perTurn: {}, cumulative: {}, ...(contextUsed === undefined ? {} : { contextUsed }), contextSize: 200_000 } }) as unknown as AgentEvent;
const agent = (over: Partial<{ usage: unknown; slashCommands: string[]; model: string }> = {}): AgentRow => {
  const row = { agentId: "r1", repoIds: ["app"], role: "developer", model: "claude-sonnet-5-5", permission: "edit", usage: { contextUsed: 62_000, contextSize: 200_000 }, ...over };
  store.rows.r1 = row;
  return row as unknown as AgentRow;
};

beforeEach(() => {
  store.rows = {};
  store.views = {};
  store.sent = [];
  store.events = [];
  store.loaded = [];
  newRun.last = undefined;
  resetActions();
  setRunSummaryApi({ digest: async () => null } as never);
});
afterEach(() => {
  cleanup();
  setRunSummaryApi(undefined);
  vi.unstubAllGlobals();
});

describe("the context meter's numbers", () => {
  it("needs both the reported context and the reported window: nothing is guessed", () => {
    expect(contextMeter({ contextUsed: 62_000, contextSize: 200_000 })).toEqual({ used: 62_000, size: 200_000, fraction: 0.31, percent: 31, tone: "ok" });
    expect(contextMeter({ contextUsed: 310_000, contextSize: 1_000_000 })).toMatchObject({ percent: 31, size: 1_000_000 });
    for (const usage of [undefined, null, {}, { contextUsed: 62_000 }, { contextSize: 200_000 }, { contextUsed: null, contextSize: 200_000 }, { contextUsed: 5, contextSize: 0 }, { contextUsed: -1, contextSize: 10 }, { contextUsed: Number.NaN, contextSize: 10 }]) {
      expect(contextMeter(usage)).toBeUndefined();
    }
  });

  it("rounds to a whole percent and never shows more than 100", () => {
    expect(contextMeter({ contextUsed: 0, contextSize: 200_000 })?.percent).toBe(0);
    expect(contextMeter({ contextUsed: 1_999, contextSize: 200_000 })?.percent).toBe(1);
    expect(contextMeter({ contextUsed: 260_000, contextSize: 200_000 })).toMatchObject({ percent: 100, fraction: 1.3, tone: "danger" });
  });

  it("turns to the warning colour above 70 percent and to danger above 90", () => {
    expect([0.31, 0.7, 0.701, 0.9, 0.901, 1.2].map(meterTone)).toEqual(["ok", "ok", "warn", "warn", "danger", "danger"]);
    expect(contextMeter({ contextUsed: 156_000, contextSize: 200_000 })?.tone).toBe("warn");
    expect(contextMeter({ contextUsed: 186_000, contextSize: 200_000 })?.tone).toBe("danger");
  });

  it("draws the arc as a share of the ring and clamps it", () => {
    expect(ringDash(0.31)).toBe(`${(0.31 * RING_LENGTH).toFixed(1)} ${RING_LENGTH.toFixed(1)}`);
    expect(ringDash(0)).toBe(`0.0 ${RING_LENGTH.toFixed(1)}`);
    expect(ringDash(1.4)).toBe(ringDash(1));
    expect(ringDash(Number.NaN)).toBe(ringDash(0));
  });

  it("writes tokens short", () => {
    expect([950, 1000, 61_500, 62_000, 156_000, 200_000, 999_600, 1_000_000, 1_250_000].map(shortTokens)).toEqual(["950", "1k", "61.5k", "62k", "156k", "200k", "1M", "1M", "1.3M"]);
  });
});

describe("the pace", () => {
  it("is worked out from this run's own growth per turn", () => {
    // 10k a turn, 138k free
    expect(turnsLeft([42_000, 52_000, 62_000], 200_000)).toBe(13);
    expect(turnsLeft([96_000, 118_000, 137_000, 156_000], 200_000)).toBe(2);
  });

  it("is hidden with fewer than three turns", () => {
    expect(turnsLeft([], 200_000)).toBeUndefined();
    expect(turnsLeft([62_000], 200_000)).toBeUndefined();
    expect(turnsLeft([52_000, 62_000], 200_000)).toBeUndefined();
  });

  it("is hidden when the estimate would mean nothing: no growth, a full window, a huge number, no window", () => {
    expect(turnsLeft([62_000, 62_000, 62_000], 200_000)).toBeUndefined();
    expect(turnsLeft([190_000, 198_000, 205_000], 200_000)).toBeUndefined();
    expect(turnsLeft([150_000, 180_000, 199_000], 200_000)).toBeUndefined(); // less than one turn left
    expect(turnsLeft([1000, 1001, 1002], 1_000_000)).toBeUndefined();
    expect(turnsLeft([1000, 2000, 3000], 0)).toBeUndefined();
    expect(turnsLeft([10_000, 12_000, 14_000], 1_000_000)).toBe(493);
    expect(493).toBeLessThanOrEqual(MAX_TURNS_LEFT);
  });

  it("starts over after the context shrank (a compaction) and looks at the last turns only", () => {
    // the drop to 40k starts the pace over: two turns since are not enough
    expect(turnsLeft([120_000, 150_000, 180_000, 40_000, 50_000], 200_000)).toBeUndefined();
    expect(turnsLeft([120_000, 150_000, 180_000, 40_000, 50_000, 60_000], 200_000)).toBe(14);
    // a slow start long ago does not flatter a fast recent pace: the last six turns count
    expect(turnsLeft([1000, 2000, 3000, 4000, 20_000, 40_000, 60_000, 80_000, 100_000, 120_000], 200_000)).toBe(4);
  });

  it("reads the context after each turn from the usage events and skips turns that reported none", () => {
    const events = [usageEvent(42_000, 1), { kind: "text.done", seq: 2 } as unknown as AgentEvent, usageEvent(undefined, 3), usageEvent(52_000, 4)];
    expect(contextHistory(events)).toEqual([42_000, 52_000]);
  });
});

describe("the ring and its popover", () => {
  it("shows the percent with an accessible name, and nothing for a run that reported no context", () => {
    render(() => <ContextRing agent={agent()} />);
    const ring = screen.getByRole("button", { name: "Context meter: 31 percent of the context used" });
    expect(ring.textContent).toBe("31%");
    expect(ring.getAttribute("data-tone")).toBe("ok");
    expect(ring.getAttribute("aria-expanded")).toBe("false");
    cleanup();
    render(() => <ContextRing agent={agent({ usage: { contextSize: 200_000 } })} />);
    expect(screen.queryByTestId("context-ring")).toBeNull();
    cleanup();
    render(() => <ContextRing agent={agent({ usage: undefined })} />);
    expect(screen.queryByTestId("context-ring")).toBeNull();
  });

  it("carries the warning and danger colours", () => {
    render(() => <ContextRing agent={agent({ usage: { contextUsed: 156_000, contextSize: 200_000 } })} />);
    expect(screen.getByTestId("context-ring").getAttribute("data-tone")).toBe("warn");
    cleanup();
    render(() => <ContextRing agent={agent({ usage: { contextUsed: 186_000, contextSize: 200_000 } })} />);
    expect(screen.getByTestId("context-ring").getAttribute("data-tone")).toBe("danger");
  });

  it("opens the popover with the real numbers, the model's window and what the number means", async () => {
    store.events = [usageEvent(42_000, 1), usageEvent(52_000, 2), usageEvent(62_000, 3)];
    render(() => <ContextRing agent={agent()} />);
    fireEvent.click(screen.getByTestId("context-ring"));
    const panel = await screen.findByTestId("context-meter");
    expect(screen.getByRole("dialog", { name: "Context meter" })).toBeTruthy();
    expect(screen.getByTestId("context-meter-used").textContent).toBe("62k");
    expect(panel.textContent).toContain("of 200k tokens");
    expect(panel.textContent).toContain("Sonnet 5.5 · 200k window");
    expect(panel.textContent).toContain("How much of this run the agent can keep in mind.");
    expect(panel.textContent).toContain("Counted from the last turn of this run. Nothing leaves this computer.");
    expect(screen.getByRole("img", { name: "31 percent of the context used" })).toBeTruthy();
    expect(screen.getByTestId("context-meter-pace").textContent).toBe("At this paceabout 13 turns left");
    await vi.waitFor(() => expect(store.loaded).toEqual(["r1"]));
    // nothing of the other product's row
    expect(panel.textContent).not.toMatch(/ChatGPT|Gemini|Grok/);
  });

  it("names a 1M window as such and hides the pace row with fewer than three turns", async () => {
    store.events = [usageEvent(300_000, 1), usageEvent(310_000, 2)];
    render(() => <ContextRing agent={agent({ model: "claude-opus-5-5[1m]", usage: { contextUsed: 310_000, contextSize: 1_000_000 } })} />);
    fireEvent.click(screen.getByTestId("context-ring"));
    const panel = await screen.findByTestId("context-meter");
    expect(panel.textContent).toContain("of 1M tokens");
    expect(panel.textContent).toContain("1M window");
    expect(screen.queryByTestId("context-meter-pace")).toBeNull();
  });

  it("offers Compact now only where the run's CLI lists compact, and sends /compact", async () => {
    render(() => <ContextRing agent={agent()} />);
    fireEvent.click(screen.getByTestId("context-ring"));
    await screen.findByTestId("context-meter");
    expect(screen.queryByRole("button", { name: "Compact now" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy summary" })).toBeTruthy();
    cleanup();
    render(() => <ContextRing agent={agent({ slashCommands: ["compact", "cost"] })} />);
    fireEvent.click(screen.getByTestId("context-ring"));
    fireEvent.click(await screen.findByRole("button", { name: "Compact now" }));
    await vi.waitFor(() => expect(store.sent).toEqual([{ runId: "r1", text: "/compact" }]));
  });

  it("Continue in a fresh run hands off through the New Run dialog and starts nothing", async () => {
    store.events = [{ kind: "user.message", seq: 1, text: "Show prices with the currency" } as unknown as AgentEvent];
    render(() => <ContextRing agent={agent()} />);
    fireEvent.click(screen.getByTestId("context-ring"));
    fireEvent.click(await screen.findByRole("button", { name: /Continue in a fresh run/ }));
    await vi.waitFor(() => expect(newRun.last).toBeTruthy());
    expect(newRun.last).toMatchObject({ role: "developer", model: "claude-sonnet-5-5" });
    expect(newRun.last?.prompt).toContain("Show prices with the currency");
    expect(store.sent).toEqual([]);
    await vi.waitFor(() => expect(screen.queryByTestId("context-meter")).toBeNull());
  });

  it("Copy summary copies the numbers as plain text", async () => {
    const written: string[] = [];
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async (text: string) => void written.push(text) } });
    store.events = [usageEvent(42_000, 1), usageEvent(52_000, 2), usageEvent(62_000, 3)];
    render(() => <ContextRing agent={agent()} />);
    fireEvent.click(screen.getByTestId("context-ring"));
    fireEvent.click(await screen.findByRole("button", { name: "Copy summary" }));
    await vi.waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toBe(["Context meter", "62k of 200k tokens used (31%)", "Model: Sonnet 5.5 · 200k window", "At this pace: about 13 turns left", "Counted from the last turn of this run."].join("\n"));
  });

  it("the summary leaves the pace line out when there is no pace", () => {
    const meter = contextMeter({ contextUsed: 186_000, contextSize: 200_000 })!;
    expect(summaryText(meter, "claude-sonnet-5-5", undefined)).toBe(["Context meter", "186k of 200k tokens used (93%)", "Model: Sonnet 5.5 · 200k window", "Counted from the last turn of this run."].join("\n"));
    expect(summaryText(meter, "claude-sonnet-5-5", 1)).toContain("At this pace: about 1 turn left");
  });

  it("Esc closes the popover and focus returns to the ring", async () => {
    render(() => <ContextRing agent={agent()} />);
    const ring = screen.getByTestId("context-ring");
    ring.focus();
    fireEvent.click(ring);
    const panel = await screen.findByTestId("context-meter");
    expect(ring.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(panel, { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByTestId("context-meter")).toBeNull());
    expect(ring.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(ring);
  });
});

describe("the strings", () => {
  it("every context meter key exists in English and Hungarian with the same placeholders", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("ctxmeter."));
    expect(keys.length).toBeGreaterThanOrEqual(19);
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\s*[,}]/g)].map((m) => m[1]).sort();
    for (const k of keys) {
      const h = (hu as Record<string, string>)[k];
      expect(h, k).toBeTruthy();
      expect(new Set(holes(h)), k).toEqual(new Set(holes((en as Record<string, string>)[k])));
    }
    expect((hu as Record<string, string>)["ctxmeter.title"]).not.toBe(en["ctxmeter.title"]);
  });
});
