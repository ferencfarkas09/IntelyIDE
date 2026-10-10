import { describe, expect, it, vi } from "vitest";
import type { SetupEvent } from "../servers";
import { createMockServers } from "./servers";

const all = { installNode: true, installBundle: true, installSdk: true, installClaude: true };
const draft = { name: "New box", destination: "new1", root: "~/work", maxAgents: 4, enabled: true };
const rejects = async (p: Promise<unknown>) => p.then(() => undefined, (e: { code: string; message: string }) => e);

describe("mock servers", () => {
  it("holds a ready, a bare and an unreachable server", async () => {
    const m = createMockServers({ stepMs: 0 });
    const list = await m.list();
    expect(list.map((s) => [s.cfg.name, s.status?.ready, s.status?.reachable])).toEqual([["Build server", true, true], ["GPU box", false, true], ["Old box", false, false]]);
    expect(list[2].status?.error).toMatchObject({ code: "hostKey" });
  });

  it("validates a save with the backend's code and message", async () => {
    const m = createMockServers({ stepMs: 0 });
    expect(await rejects(m.save({ ...draft, name: "" }))).toMatchObject({ code: "invalidName" });
    expect(await rejects(m.save({ ...draft, name: "build SERVER" }))).toMatchObject({ code: "duplicateName" });
    expect(await rejects(m.save({ ...draft, destination: "a b" }))).toMatchObject({ code: "invalidDestination" });
    expect(await rejects(m.save({ ...draft, port: 70000 }))).toMatchObject({ code: "invalidPort" });
    expect(await rejects(m.save({ ...draft, maxAgents: 65 }))).toMatchObject({ code: "invalidMaxAgents" });
    const saved = await m.save(draft);
    expect(saved.id).toBe("new-box");
    expect((await m.save({ ...draft, name: "New  box!" })).id).toBe("new-box-2");
  });

  it("refuses to remove a server with live runs", async () => {
    const m = createMockServers({ stepMs: 0 });
    expect(await rejects(m.remove("build-server"))).toMatchObject({ code: "serverBusy" });
    m.setRunning("build-server", 0);
    await m.remove("build-server");
    expect((await m.list()).map((s) => s.cfg.id)).not.toContain("build-server");
  });

  it("sets up the bare server step by step and pushes the new status", async () => {
    const m = createMockServers({ stepMs: 0 });
    const events: SetupEvent[] = [];
    const statuses: boolean[] = [];
    m.onSetup((e) => events.push(e));
    m.onStatus((_, s) => statuses.push(s.ready));
    await m.setup("gpu-box", all);
    expect(events.filter((e) => e.state === "started").map((e) => e.step)).toEqual(["probe", "prepare", "node", "bundle", "sdk", "claude", "verify"]);
    expect(statuses).toEqual([true]);
    expect((await m.list())[1].status?.ready).toBe(true);
  });

  it("fails at probe on the unreachable server, and where it is told to", async () => {
    const m = createMockServers({ stepMs: 0 });
    const events: SetupEvent[] = [];
    m.onSetup((e) => events.push(e));
    await m.setup("old-box", all);
    expect(events.at(-1)).toMatchObject({ step: "probe", state: "failed", message: "Host key verification failed." });
    events.length = 0;
    m.failSetupAt("sdk");
    await m.setup("gpu-box", all);
    expect(events.at(-1)).toMatchObject({ step: "sdk", state: "failed" });
  });

  it("answers repos deterministically and remembers a clone", async () => {
    const m = createMockServers({ stepMs: 0 });
    const before = await m.repos("gpu-box", ["api", "web"]);
    expect(before.every((r) => !r.exists)).toBe(true);
    await m.clone("gpu-box", "api");
    const after = await m.repos("gpu-box", ["api", "web"]);
    expect(after[0]).toMatchObject({ exists: true, isGit: true, path: "~/work/api" });
    expect(after[1].exists).toBe(false);
    expect(await m.repos("gpu-box", ["api", "web"])).toEqual(after);
  });

  it("builds the ssh command with the port", async () => {
    const m = createMockServers({ stepMs: 0 });
    expect(await m.sshCommand("build-server")).toBe("ssh build1");
    expect(await m.sshCommand("gpu-box")).toBe("ssh -p 2222 dev@gpu.example.com");
  });

  it("takes time only through timers a test can drive", async () => {
    vi.useFakeTimers();
    try {
      const m = createMockServers({ stepMs: 400 });
      let done = false;
      void m.probe("build-server").then(() => (done = true));
      await vi.advanceTimersByTimeAsync(399);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
