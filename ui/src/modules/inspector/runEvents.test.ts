import { afterEach, describe, expect, it } from "vitest";
import type { Ipc } from "../../ipc";
import type { AgentEvent } from "../../store/agent-types";
import { loadRunLog, mergeEvents, resetRunLogs, runLog } from "./runEvents";

const ev = (seq: number, agentId = "a1"): AgentEvent => ({ agentId, seq, ts: seq, provider: "claude", kind: "status", state: "running" });

function fakeClient(opts: { history?: AgentEvent[]; stored?: AgentEvent[] | { code: string }; live?: { push(cb: (e: AgentEvent[]) => void): void } }): Ipc {
  return {
    agentHistory: async () => opts.history ?? [],
    runs: { events: async () => (Array.isArray(opts.stored) ? opts.stored : Promise.reject(opts.stored ?? { code: "unimplemented", message: "nope" })) },
    onAgentEvents: (cb: (e: AgentEvent[]) => void) => (opts.live?.push(cb), () => {}),
  } as unknown as Ipc;
}

afterEach(resetRunLogs);

describe("mergeEvents", () => {
  it("appends only events newer than the log and ignores duplicates", () => {
    expect(mergeEvents([ev(1), ev(2)], [ev(2), ev(3), ev(3)]).map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe("loadRunLog", () => {
  it("uses the live history of the session when there is one", async () => {
    await loadRunLog("a1", { client: fakeClient({ history: [ev(1), ev(2)] }) });
    expect(runLog("a1")).toMatchObject({ status: "ready" });
    expect(runLog("a1")!.events).toHaveLength(2);
  });

  it("falls back to the stored log of a finished run", async () => {
    await loadRunLog("a1", { client: fakeClient({ stored: [ev(1)] }) });
    expect(runLog("a1")!.events).toHaveLength(1);
  });

  it("maps a deleted transcript to the expired state and anything else to an error", async () => {
    await loadRunLog("a1", { client: fakeClient({ stored: { code: "transcriptExpired" } }) });
    expect(runLog("a1")?.status).toBe("expired");
    await loadRunLog("a2", { client: fakeClient({ stored: { code: "unimplemented" } }) });
    expect(runLog("a2")?.status).toBe("error");
  });

  it("appends live events to a loaded log", async () => {
    const subs: ((e: AgentEvent[]) => void)[] = [];
    await loadRunLog("a1", { client: fakeClient({ history: [ev(1)], live: { push: (cb) => subs.push(cb) } }) });
    subs[0]([ev(2), ev(1, "other")]);
    expect(runLog("a1")!.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(runLog("other")).toBeUndefined();
  });

  it("does not reload a ready log unless forced", async () => {
    const client = fakeClient({ history: [ev(1)] });
    await loadRunLog("a1", { client });
    const first = runLog("a1");
    await loadRunLog("a1", { client });
    expect(runLog("a1")).toBe(first);
  });
});
