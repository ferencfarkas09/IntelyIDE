import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { createMockNotify } from "../../ipc/mock/notify";
import { overlays, resetOverlays } from "../../platform/overlay";
import { resetSettings, settingsSections } from "../../platform/settings";
import { createAnnouncer, type RowLike } from "./announcer";
import { register } from "./index";
import { BURST, CLICK_WINDOW_MS, DEFAULT_NOTIFY, readNotify, runToShow, SETTLE_MS, toPrefs, transitionOf } from "./logic";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  resetOverlays();
  resetSettings();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("notify register()", () => {
  it("adds an overlay and a settings section and starts nothing", () => {
    const calls = [vi.spyOn(ipc.notify, "configure"), vi.spyOn(ipc.notify, "badge"), vi.spyOn(ipc.notify, "show"), vi.spyOn(ipc.settings, "get")];
    register();
    expect(overlays().map((o) => o.id)).toContain("notify");
    expect(settingsSections().find((s) => s.id === "notify")).toMatchObject({ order: 49 });
    for (const c of calls) expect(c).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("settings", () => {
  it("are on by default and read safely", () => {
    expect(readNotify(undefined)).toEqual(DEFAULT_NOTIFY);
    expect(DEFAULT_NOTIFY).toMatchObject({ enabled: true, badge: true, sound: false });
    expect(readNotify({ enabled: false, question: false, throttleSeconds: 30, sound: true })).toMatchObject({ enabled: false, question: false, permission: true, throttleSeconds: 30, sound: true });
    expect(readNotify({ throttleSeconds: -4, enabled: "yes" }).throttleSeconds).toBe(10);
    expect(readNotify({ enabled: "yes" }).enabled).toBe(true);
  });

  it("go to the Rust gate with the burst cap", () => {
    expect(toPrefs({ ...DEFAULT_NOTIFY, finished: false, throttleSeconds: 30, sound: true })).toEqual({ enabled: true, permission: true, question: true, finished: false, error: true, throttleMs: 30_000, burst: BURST, sound: true });
  });
});

describe("what a change of state is worth", () => {
  it("is a banner for needs-you, finished and failed, with a fixed sentence and never the run's text", () => {
    expect(transitionOf(undefined, "needsYou")).toBeUndefined();
    expect(transitionOf("running", "running")).toBeUndefined();
    expect(transitionOf("running", "needsYou", "permission")).toMatchObject({ kind: "permission", title: "An agent needs your permission", body: "The agent is waiting for your approval." });
    expect(transitionOf("running", "needsYou", "question")).toMatchObject({ kind: "question", body: "The agent has a question for you." });
    expect(transitionOf("running", "done")).toMatchObject({ kind: "finished" });
    expect(transitionOf("needsYou", "done")).toBeUndefined();
    expect(transitionOf("running", "error")).toMatchObject({ kind: "error" });
  });
});

describe("the click on a banner", () => {
  it("brings the run forward only when the window is focused soon after, and the run still exists", () => {
    const status = (id: string) => (id === "a" ? "needsYou" : undefined);
    expect(runToShow(undefined, 1000, status)).toBeUndefined();
    expect(runToShow({ runId: "a", at: 1000 }, 1000 + 5_000, status)).toBe("a");
    expect(runToShow({ runId: "a", at: 1000 }, 1000 + CLICK_WINDOW_MS + 1, status)).toBeUndefined();
    expect(runToShow({ runId: "gone", at: 1000 }, 2000, status)).toBeUndefined();
    expect(runToShow({ runId: "a", at: 5000 }, 1000, status)).toBeUndefined();
  });
});

describe("the announcer", () => {
  function setup() {
    const mock = createMockNotify();
    let rows: RowLike[] = [{ agentId: "a", status: "running", title: "Fix the login bug", role: "developer" }];
    const shown: string[] = [];
    const ann = createAnnouncer({ rows: () => rows, needs: () => "permission", show: (r) => mock.show(r), shown: (id) => shown.push(id) });
    return { mock, shown, ann, set: (r: RowLike[]) => (rows = r) };
  }
  const row = (status: string, id = "a"): RowLike => ({ agentId: id, status, title: `run ${id}`, role: "developer" });

  it("announces a state that lasts, once, with the run's title as the subtitle", async () => {
    const { mock, shown, ann, set } = setup();
    ann.update();
    set([row("needsYou")]);
    ann.update();
    expect(mock.shown).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    expect(mock.shown).toEqual([{ kind: "permission", title: "An agent needs your permission", body: "The agent is waiting for your approval.", runId: "a", subtitle: "run a" }]);
    expect(shown).toEqual(["a"]);
    ann.update();
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
    expect(mock.shown).toHaveLength(1);
  });

  it("stays silent when the request is answered within the settle time", async () => {
    const { mock, ann, set } = setup();
    ann.update();
    set([row("needsYou")]);
    ann.update();
    await vi.advanceTimersByTimeAsync(300);
    set([row("running")]);
    ann.update();
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 3);
    expect(mock.shown).toHaveLength(0);
  });

  it("gives every run its own banner and honours the gate (focused window, master switch)", async () => {
    const { mock, ann, set } = setup();
    set([row("running", "a"), row("running", "b")]);
    ann.update();
    set([row("needsYou", "a"), row("done", "b")]);
    ann.update();
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    expect(mock.shown.map((r) => `${r.runId}:${r.kind}`).sort()).toEqual(["a:permission", "b:finished"]);
    mock.setFocused(true);
    set([row("running", "a"), row("done", "b")]);
    ann.update();
    set([row("needsYou", "a"), row("done", "b")]);
    ann.update();
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    expect(mock.shown).toHaveLength(2);
  });

  it("dispose cancels what is waiting", async () => {
    const { mock, ann, set } = setup();
    ann.update();
    set([row("error")]);
    ann.update();
    ann.dispose();
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
    expect(mock.shown).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the mock gate behaves like the Rust one", () => {
  it("throttles per kind and run, caps bursts and obeys the master switch", async () => {
    const m = createMockNotify();
    const req = (runId: string, kind: "permission" | "question" = "permission") => ({ kind, title: "t", body: "b", runId });
    expect(await m.show(req("a"))).toBe("show");
    expect(await m.show(req("a"))).toBe("throttled");
    expect(await m.show(req("b"))).toBe("show");
    await m.configure({ ...m.prefs(), enabled: false });
    expect(await m.show(req("c"))).toBe("disabled");
    await m.configure({ ...m.prefs(), enabled: true, burst: 2 });
    expect(await m.show(req("d"))).toBe("flooded");
  });
});
