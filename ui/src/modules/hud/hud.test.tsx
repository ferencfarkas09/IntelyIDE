import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { availableCommands, resetCommands } from "../../platform/commands";
import { ecoActive, ecoInterval, resetEco, setEcoActive } from "../../platform/eco";
import { overlays, resetOverlays } from "../../platform/overlay";
import { resetSettings, settingsSections } from "../../platform/settings";
import { resetStatusItems, statusItems } from "../../platform/statusbar";
import HudChip from "./HudChip";
import { byKind, formatMb, pressure, readHud, readTray } from "./logic";
import { applyHudSettings } from "./state";
import { register } from "./index";
import { transitionOf } from "./trayBridge";
import { startHud } from "./watcher";

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopObserver;
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  resetCommands();
  resetOverlays();
  resetSettings();
  resetStatusItems();
  resetEco();
  applyHudSettings({ enabled: false, eco: false, ecoMinutes: 5 });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("hud register()", () => {
  it("adds an overlay, a hidden status chip, a settings section and two commands, and starts nothing", () => {
    const calls = [vi.spyOn(ipc.hud, "snapshot"), vi.spyOn(ipc.hud, "configure"), vi.spyOn(ipc.tray, "configure"), vi.spyOn(ipc.settings, "get")];
    const interval = vi.spyOn(globalThis, "setInterval");
    const fetch = vi.spyOn(globalThis, "fetch");
    register();
    expect(overlays().map((o) => o.id)).toContain("hud");
    expect(statusItems("right").map((i) => i.id)).not.toContain("hud");
    expect(settingsSections().find((s) => s.id === "hud")).toMatchObject({ order: 59 });
    expect(availableCommands().map((c) => c.id)).toEqual(expect.arrayContaining(["hud.toggle", "hud.eco"]));
    for (const c of calls) expect(c).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows the chip once the switch is on", () => {
    register();
    applyHudSettings({ enabled: true, eco: false, ecoMinutes: 5 });
    expect(statusItems("right").map((i) => i.id)).toContain("hud");
  });
});

describe("pure helpers", () => {
  it("formats, groups and tints", () => {
    expect(formatMb(168 * 1024 * 1024)).toBe("168 MB");
    expect(formatMb(1.5 * 1024 ** 3)).toBe("1.5 GB");
    expect(pressure(0.5 * 1024 ** 3)).toBe("ok");
    expect(pressure(1.5 * 1024 ** 3)).toBe("warn");
    expect(pressure(3 * 1024 ** 3)).toBe("danger");
    expect(byKind([{ pid: 1, name: "a", kind: "agent", rssBytes: 5, canKill: true }, { pid: 2, name: "b", kind: "agent", rssBytes: 7, canKill: true }, { pid: 3, name: "c", kind: "app", rssBytes: 20, canKill: false }])).toEqual([
      { kind: "app", bytes: 20, count: 1 },
      { kind: "agent", bytes: 12, count: 2 },
    ]);
  });

  it("reads settings with safe defaults", () => {
    expect(readHud(undefined)).toEqual({ enabled: false, eco: false, ecoMinutes: 5 });
    expect(readHud({ enabled: true, eco: true, ecoMinutes: 0 })).toEqual({ enabled: true, eco: true, ecoMinutes: 5 });
    expect(readTray({ enabled: true, finished: false, throttleSeconds: 30 })).toMatchObject({ enabled: true, permission: true, finished: false, throttleSeconds: 30 });
    expect(readTray({ throttleSeconds: -4 }).throttleSeconds).toBe(10);
  });

  it("turns run state changes into notification kinds", () => {
    expect(transitionOf(undefined, "needsYou", "t")).toBeUndefined();
    expect(transitionOf("running", "running", "t")).toBeUndefined();
    expect(transitionOf("running", "needsYou", "Fix it", "permission")).toMatchObject({ kind: "permission", body: "Fix it" });
    expect(transitionOf("running", "needsYou", "Fix it", "question")).toMatchObject({ kind: "question" });
    expect(transitionOf("running", "done", "t")).toMatchObject({ kind: "finished" });
    expect(transitionOf("needsYou", "done", "t")).toBeUndefined();
    expect(transitionOf("running", "error", "t")).toMatchObject({ kind: "error" });
  });
});

describe("Eco mode really reduces timers and requests", () => {
  it("ecoInterval stops ticking in Eco, and catches up once on return", () => {
    const fn = vi.fn();
    const stop = ecoInterval(fn, 1000);
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(5);
    setEcoActive(true);
    vi.advanceTimersByTime(600_000);
    expect(fn).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
    setEcoActive(false);
    expect(fn).toHaveBeenCalledTimes(6);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(9);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an interval created while Eco is on stays idle until Eco ends", () => {
    setEcoActive(true);
    const fn = vi.fn();
    const stop = ecoInterval(fn, 1000);
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
    setEcoActive(false);
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  it("the chip stops asking for snapshots while Eco is on and asks again when it ends", async () => {
    const snap = vi.spyOn(ipc.hud, "snapshot");
    render(() => <HudChip />);
    await vi.advanceTimersByTimeAsync(60_000);
    const awake = snap.mock.calls.length;
    expect(awake).toBeGreaterThanOrEqual(5);
    snap.mockClear();
    setEcoActive(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(snap).not.toHaveBeenCalled();
    setEcoActive(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(snap).toHaveBeenCalledTimes(1);
  });

  it("the watcher drives Eco from window focus: blur long enough turns it on, focus turns it off", async () => {
    vi.spyOn(ipc.settings, "get").mockImplementation(async (ns: string) => (ns === "hud" ? { enabled: true, eco: true, ecoMinutes: 2 } : {}));
    await startHud();
    expect(ecoActive()).toBe(false);
    window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ecoActive()).toBe(false);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(ecoActive()).toBe(true);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(ecoActive()).toBe(false);
  });
});

describe("HudChip", () => {
  it("shows the total and opens the process list with kill and restart", async () => {
    render(() => <HudChip />);
    await vi.advanceTimersByTimeAsync(10);
    const chip = screen.getByRole("button", { name: /Memory used by the app: 622 MB/ });
    fireEvent.click(chip);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.getByText("claude")).toBeTruthy();
    const kill = vi.spyOn(ipc.hud, "kill");
    fireEvent.click(screen.getByRole("button", { name: "Stop claude" }));
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith(4140);
    expect((screen.getByRole("button", { name: /The app itself cannot be stopped/ }) as HTMLElement).getAttribute("aria-disabled")).toBe("true");
    const restart = vi.spyOn(ipc.hud, "restartSidecar");
    fireEvent.click(screen.getByRole("button", { name: "Restart sidecar" }));
    await vi.advanceTimersByTimeAsync(10);
    expect(restart).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("node sidecar/dist/index.js")).toBeNull());
  });
});
