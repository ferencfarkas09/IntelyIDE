import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../ipc";
import { applyHappyStatus, happyStatus, IDLE_TIMER, meetItemVisible, signedOutNotice, startHappyWatch, timerChipVisible, timerView } from "./happy";

const on = { enabled: true, showInStatusBar: true, allowActions: true };
const off = { enabled: false, showInStatusBar: true, allowActions: true };
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startHappyWatch", () => {
  it("costs nothing while the integrations are off: one settings read, no status call, no event subscription", async () => {
    const status = vi.spyOn(ipc.happy, "status");
    const onState = vi.spyOn(ipc.happy, "onState");
    const onTimer = vi.spyOn(ipc.happy.timer, "onChange");
    vi.spyOn(ipc.settings, "get").mockResolvedValue({ master: true, timer: off, meet: off });
    const stop = startHappyWatch();
    await flush();
    expect(status).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
    expect(onTimer).not.toHaveBeenCalled();
    expect(happyStatus()).toBeUndefined();
    stop();
  });

  it("subscribes and loads the status once a provider is on, and lets go when the master switch goes off", async () => {
    vi.spyOn(ipc.settings, "get").mockResolvedValue({ master: true, timer: on, meet: off });
    const unsubscribe = vi.fn();
    const onState = vi.spyOn(ipc.happy, "onState").mockReturnValue(unsubscribe);
    vi.spyOn(ipc.happy.timer, "onChange").mockReturnValue(unsubscribe);
    vi.spyOn(ipc.happy.meet, "onChange").mockReturnValue(unsubscribe);
    const status = await ipc.happy.status();
    vi.spyOn(ipc.happy, "status").mockResolvedValue({ ...status, config: { ...status.config, master: true, timer: on } });
    const stop = startHappyWatch();
    await flush();
    expect(onState).toHaveBeenCalledOnce();
    expect(happyStatus()?.config.master).toBe(true);
    applyHappyStatus({ ...status, config: { ...status.config, master: false } });
    expect(unsubscribe).toHaveBeenCalledTimes(3);
    await flush();
    expect(happyStatus()).toBeUndefined();
    expect(timerView()).toEqual(IDLE_TIMER);
    stop();
  });

  it("shows a timer that was started, paused and stopped somewhere else as the poll reports it", async () => {
    const { connectHappyForTest, disconnectHappyForTest } = await import("./happyTestKit");
    const stop = await connectHappyForTest();
    const sim = (globalThis as { __mockHappyTimer?: { elsewhere(v: typeof IDLE_TIMER): unknown } }).__mockHappyTimer!;
    expect(timerView().phase).toBe("idle");
    const started = Date.now() - 12_000;
    sim.elsewhere({ ...IDLE_TIMER, phase: "running", kind: "project", targetId: "p_pos", taskId: "t_receipts", title: "Receipts", project: "Shop POS", startedAtMs: started });
    expect(timerView()).toMatchObject({ phase: "running", title: "Receipts", startedAtMs: started });
    sim.elsewhere({ ...IDLE_TIMER, phase: "paused", kind: "project", targetId: "p_pos", title: "Receipts", accumulatedSec: 300 });
    expect(timerView()).toMatchObject({ phase: "paused", accumulatedSec: 300 });
    sim.elsewhere(IDLE_TIMER);
    expect(timerView().phase).toBe("idle");
    stop();
    await disconnectHappyForTest();
  });

  it("returns the same watcher when started twice", () => {
    vi.spyOn(ipc.settings, "get").mockResolvedValue({});
    const stop = startHappyWatch();
    expect(startHappyWatch()).toBe(stop);
    stop();
  });
});

describe("what the status bar shows", () => {
  const base = { config: { master: true, env: "sandbox" as const, timer: on, meet: on }, tokenSaved: true };
  const status = (timer: string, meet: string, extra = {}) =>
    ({ ...base, providers: [{ id: "timer", state: timer }, { id: "meet", state: meet }], ...extra }) as Parameters<typeof applyHappyStatus>[0];

  it("shows the timer chip only while the timer is connected", () => {
    const stop = startHappyWatch();
    applyHappyStatus(status("ready", "off"));
    expect(timerChipVisible()).toBe(true);
    applyHappyStatus(status("degraded", "off"));
    expect(timerChipVisible()).toBe(true);
    for (const state of ["off", "waitingForToken", "notPermitted", "signedOut", "probing"]) {
      applyHappyStatus(status(state, "off"));
      expect(timerChipVisible(), state).toBe(false);
    }
    applyHappyStatus(status("ready", "off", { config: { ...base.config, timer: { ...on, showInStatusBar: false } } }));
    expect(timerChipVisible()).toBe(false);
    stop();
  });

  it("shows the persistent notice after a 401 and the meet item only with a relevant meeting", () => {
    const stop = startHappyWatch();
    applyHappyStatus(status("signedOut", "signedOut", { signedOut: { code: "DEVICE_LOGGED_OUT", message: "x", atMs: 1 } }));
    expect(signedOutNotice()?.code).toBe("DEVICE_LOGGED_OUT");
    applyHappyStatus(status("ready", "ready"));
    expect(signedOutNotice()).toBeFalsy();
    expect(meetItemVisible()).toBe(false);
    stop();
  });
});
