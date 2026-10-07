import { describe, expect, it } from "vitest";
import type { OpResult } from "./index";
import { createMockIpc } from "./mock";

describe("mock ipc (normal scenario)", () => {
  it("exposes the four repos with changes", async () => {
    const ipc = createMockIpc("normal", { delayScale: 0 });
    const status = await ipc.engineStatus();
    expect(status.repoIds).toEqual(["backend", "admin", "services", "pos"]);
    const admin = await ipc.snapshotGet("admin");
    expect(admin.ahead).toBe(1);
    const dir = admin.changes.find((c) => c.dir);
    expect(dir).toBeDefined();
    const { files } = await ipc.listUntracked("admin", dir!.path, 100);
    expect(files.length).toBeGreaterThan(0);
  });

  it("commits, emits events and a result, and updates the snapshot", async () => {
    const ipc = createMockIpc("normal", { delayScale: 0 });
    const before = await ipc.snapshotGet("services");
    const done = new Promise<OpResult>((resolve) => ipc.onOpResult(resolve));
    const lines: string[] = [];
    ipc.onOpEvent((e) => e.line && lines.push(e.line.text));
    const runId = "run-1";
    await ipc.commitStart({
      runId,
      noVerify: false,
      repos: [{ repoId: "services", message: "Update booking card", amend: false, files: [{ mode: "whole", path: "locales/hu.json" }] }],
    });
    const result = await done;
    expect(result.runId).toBe(runId);
    expect(result.repos[0].status).toBe("done");
    expect(lines.length).toBeGreaterThan(0);
    const after = await ipc.snapshotGet("services");
    expect(after.changes.length).toBe(before.changes.length - 1);
    expect(after.ahead).toBe(1);
  });
});

describe("mock ipc scenarios", () => {
  const ipc = (scenario: string) => createMockIpc(scenario, { delayScale: 0 });
  const commitOf = (repoId: string, message = "msg") => ({
    runId: crypto.randomUUID(),
    noVerify: false,
    repos: [{ repoId, message, amend: false, files: [{ mode: "whole" as const, path: "x" }] }],
  });
  const result = (client: ReturnType<typeof ipc>) => new Promise<OpResult>((resolve) => client.onOpResult(resolve));

  it("falls back to normal for unknown names", async () => {
    const snap = await ipc("nope").snapshotGet("admin");
    expect(snap.ahead).toBe(1);
  });

  it("normal: admin pushes to a different remote branch and has stash and worktree badges", async () => {
    const client = ipc("normal");
    const ws = await client.workspaceGet();
    expect(ws.repos.find((r) => r.id === "admin")!.pushTargets).toEqual({ "feature-light-design": { remote: "origin", branch: "sandbox" } });
    const [backend, admin] = await Promise.all([client.snapshotGet("backend"), client.snapshotGet("admin")]);
    expect(backend.stashCount).toBe(2);
    expect(admin.worktreeCount).toBe(1);
    expect(admin.changes.filter((c) => c.dir).length).toBe(2);
  });

  it("big: admin has exactly 5,000 changes, deterministic, with listable folders", async () => {
    const a = await ipc("big").snapshotGet("admin");
    const b = await ipc("big").snapshotGet("admin");
    expect(a.changes).toHaveLength(5000);
    expect(a.changes.map((c) => c.path)).toEqual(b.changes.map((c) => c.path));
    expect(new Set(a.changes.map((c) => c.path)).size).toBe(5000);
    const dir = a.changes.find((c) => c.dir)!;
    const { files } = await ipc("big").listUntracked("admin", dir.path, 100);
    expect(files.length).toBe(20);
  });

  it("failures: the backend hook rejects, the admin push is non-fast-forward, services is lock-busy once, shop-pos is unreadable", async () => {
    const client = ipc("failures");
    const hook = result(client);
    await client.commitStart(commitOf("backend"));
    expect((await hook).repos[0].failure?.kind).toBe("hookRejected");

    const lock = result(client);
    await client.commitStart(commitOf("services"));
    expect((await lock).repos[0].failure?.kind).toBe("lockBusy");
    const retry = result(client);
    await client.commitStart(commitOf("services"));
    expect((await retry).repos[0].status).toBe("done");

    const push = result(client);
    await client.pushStart({ runId: "p1", noVerify: false, targets: [{ repoId: "admin", remote: "origin", remoteBranch: "sandbox", tags: "none" }] });
    const pushed = (await push).repos[0];
    expect(pushed.failure?.kind).toBe("nonFastForward");
    expect(pushed.pushResults?.[0].flag).toBe("!");

    const pos = await client.snapshotGet("pos");
    expect(pos.error).toBeTruthy();
    expect(pos.changes).toEqual([]);
  });

  it("empty: no changes, nothing to push, nothing behind", async () => {
    const client = ipc("empty");
    for (const id of (await client.engineStatus()).repoIds) {
      const s = await client.snapshotGet(id);
      expect([s.changes.length, s.ahead, s.behind, s.stashCount]).toEqual([0, 0, 0, 0]);
    }
  });

  it("merging: one repo is mid-merge with conflicted files", async () => {
    const client = ipc("merging");
    const states = await Promise.all((await client.engineStatus()).repoIds.map((id) => client.snapshotGet(id)));
    expect(states.filter((s) => s.state === "merging").map((s) => s.repoId)).toEqual(["services"]);
    expect(states.find((s) => s.repoId === "services")!.changes.some((c) => c.kind === "conflicted")).toBe(true);
  });

  it("failures: a pull clears the rejected push, so Pull then push can succeed", async () => {
    const client = ipc("failures");
    const result = (kind: "pull" | "push") => new Promise<OpResult>((resolve) => client.onOpResult((r) => r.kind === kind && resolve(r)));
    const target = { repoId: "admin", local: "feature-light-design", remote: "origin", remoteBranch: "sandbox", tags: "none" as const };
    const first = result("push");
    await client.pushStart({ runId: "p1", noVerify: false, targets: [target] });
    expect((await first).repos[0].failure?.kind).toBe("nonFastForward");
    const pulled = result("pull");
    await client.pull("admin", "merge");
    expect((await pulled).repos[0].status).toBe("done");
    const second = result("push");
    await client.pushStart({ runId: "p2", noVerify: false, targets: [target] });
    expect((await second).repos[0].status).toBe("done");
  });

  it("lists the files of each outgoing commit separately", async () => {
    const client = ipc("normal");
    const backend = await client.pushCommitFiles("backend", "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    const admin = await client.pushCommitFiles("admin", "b2c3d4e5f60718293a4b5c6d7e8f9012345678a1");
    expect(backend.map((f) => f.path)).toContain("src/api/services/loyaltyService.js");
    expect(admin.map((f) => f.path)).toContain("src/theme/light.css");
  });

  it("reveals the contents of the file that was asked for", async () => {
    const client = ipc("normal");
    const env = await client.fileContents("backend", ".env", undefined, { kind: "worktreeVsHead" }, true);
    expect(env.modified).toContain("API_KEY");
  });

  it("publishes snapshots with growing revisions after a commit", async () => {
    const client = ipc("normal");
    const revisions: number[] = [];
    client.onRepoSnapshot((s) => revisions.push(s.revision));
    await client.snapshotRefresh("services");
    await client.snapshotRefresh("services");
    expect(revisions).toEqual([1, 2]);
  });
});
