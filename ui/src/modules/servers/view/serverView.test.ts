import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({ list: [] as { location?: string; status: string; repoIds: string[] }[] }));
vi.mock("../../../store/agents", () => ({ agentRows: () => rows.list }));

import { ipc } from "../../../ipc";
import { createMockServers } from "../../../ipc/mock/servers";
import { ACTIVE_MS, MAX_POLL_IN_FLIGHT, dueViews, ERROR_MS, IDLE_MS, keyOf, pinView, refreshView, resetServerView, runViews, shownViews, startPolling, unpinView, viewEntry, type ViewEntry } from "./serverView";

const k = { serverId: "build-server", repoId: "r1" };

beforeEach(() => {
  resetServerView();
  rows.list = [];
  (ipc as { servers: unknown }).servers = createMockServers({ stepMs: 0 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const entry = (over: Partial<ViewEntry> = {}): ViewEntry => ({ loading: false, fetchedAt: 0, ...over });

describe("which repositories are shown", () => {
  it("takes the repositories of runs that live on a server, and marks those a run works on now", () => {
    const { all, active } = runViews([
      { location: "build-server", status: "running", repoIds: ["a", "b"] },
      { location: "build-server", status: "done", repoIds: ["b", "c"] },
      { status: "running", repoIds: ["local-only"] },
    ]);
    expect(all.map(keyOf).sort()).toEqual(["build-server\na", "build-server\nb", "build-server\nc"]);
    expect([...active].sort()).toEqual(["build-server\na", "build-server\nb"]);
  });

  it("adds the repositories the person pinned, once", () => {
    rows.list = [{ location: "build-server", status: "done", repoIds: ["r1"] }];
    pinView(k);
    pinView({ serverId: "gpu-box", repoId: "r2" });
    pinView({ serverId: "gpu-box", repoId: "r2" });
    expect(shownViews().keys).toHaveLength(2);
    unpinView({ serverId: "gpu-box", repoId: "r2" });
    expect(shownViews().keys).toEqual([k]);
  });
});

describe("when a view is read again", () => {
  const active = new Set([keyOf(k)]);
  it("every 4 s while a run works there, slowly when idle, and rarely after a failure", () => {
    expect(ACTIVE_MS).toBe(4000);
    const at = (ms: number, e: ViewEntry, act = active) => dueViews(ms, [k], act, () => e, true).length;
    expect(at(3_999, entry())).toBe(0);
    expect(at(4_000, entry())).toBe(1);
    expect(at(10_000, entry(), new Set())).toBe(0);
    expect(at(IDLE_MS, entry(), new Set())).toBe(1);
    expect(at(ERROR_MS - 1, entry({ error: "x" }))).toBe(0);
    expect(at(ERROR_MS, entry({ error: "x" }))).toBe(1);
  });

  it("never twice at once, always the first time, and not at all while the window is hidden", () => {
    expect(dueViews(1e9, [k], new Set(), () => entry({ loading: true }), true)).toEqual([]);
    expect(dueViews(0, [k], new Set(), () => undefined, true)).toEqual([k]);
    expect(dueViews(1e9, [k], new Set(), () => undefined, false)).toEqual([]);
  });
});

describe("reading", () => {
  it("keeps the last good data when the server stops answering", async () => {
    await refreshView(k);
    expect(viewEntry(k)?.data?.source).toBe("server(Build server)");
    vi.spyOn(ipc.servers, "changes").mockRejectedValueOnce({ code: "ssh", message: "Connection refused" });
    await refreshView(k);
    expect(viewEntry(k)).toMatchObject({ error: "Connection refused", loading: false });
    expect(viewEntry(k)?.data?.changes.length).toBeGreaterThan(0);
  });

  it("polls a run's repository every 4 s, stops when stopped, and sleeps while hidden", async () => {
    vi.useFakeTimers();
    rows.list = [{ location: "build-server", status: "running", repoIds: ["r1"] }];
    const spy = vi.spyOn(ipc.servers, "changes");
    let visible = true;
    const stop = startPolling(() => visible);
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_100);
    expect(spy).toHaveBeenCalledTimes(2);
    visible = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(spy).toHaveBeenCalledTimes(2);
    stop();
    visible = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("never has more than three reads in flight from the poller, however many views are pinned", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 8; i++) pinView({ serverId: "build-server", repoId: `p${i}` });
    let running = 0;
    let peak = 0;
    vi.spyOn(ipc.servers, "changes").mockImplementation(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1_500));
      running--;
      return { source: "server(Build server)", state: "ok", detached: false, ahead: 0, behind: 0, changes: [], total: 0, truncated: false, updatedAtMs: Date.now() } as never;
    });
    const stop = startPolling(() => true);
    await vi.advanceTimersByTimeAsync(12_000);
    stop();
    expect(peak).toBeLessThanOrEqual(MAX_POLL_IN_FLIGHT);
    expect(peak).toBeGreaterThan(0);
  });
});
