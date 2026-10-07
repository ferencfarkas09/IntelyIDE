import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", async () => ({ ipc: (await import("./testing-u2")).failures.ipc }));
vi.mock("./selection", async () => (await import("./testing-u2")).selectionModule);
vi.mock("./snapshots", async () => (await import("./testing-u2")).snapshotsModule);
vi.mock("./workspace", async () => (await import("./testing-u2")).workspaceModule);

import { messageHistory, resetMessageState, setSharedMessage, sharedMessage } from "../components/commit/messageState";
import { buildPushRequest } from "../components/push/logic";
import { describeFailure } from "../components/results/logic";
import { ipc } from "../ipc";
import * as actions from "./actions";
import { failures, seedStores } from "./testing-u2";

beforeEach(async () => {
  localStorage.clear();
  actions.resetActions();
  resetMessageState();
  failures.reset();
});
afterEach(() => vi.restoreAllMocks());

const rowOf = (repoId: string) => actions.sheetRows().find((r) => r.repoId === repoId)!;

describe("commit failures (mock scenario failures)", () => {
  it("shows a rejected hook with its output, offers retry without hooks, and keeps the message", async () => {
    await seedStores(ipc, { backend: ["src/api/routes/index.js"] });
    setSharedMessage("feat: routes");
    await actions.commitAll();

    const row = rowOf("backend");
    const state = actions.rowState(row)!;
    expect(state.status).toBe("failed");
    expect(state.outcome?.failure?.kind).toBe("hookRejected");
    expect(state.lines.map((l) => l.text)).toContain("lint-staged: checking staged files");
    expect(describeFailure(state.outcome!.failure!.kind, "commit").actions).toEqual(["retry", "retryNoHooks"]);
    // Nothing was committed, so the draft survives for the retry.
    expect(sharedMessage()).toBe("feat: routes");
    expect(messageHistory()).toEqual([]);
    expect(actions.committedNotPushed("backend")).toBeUndefined();

    const start = vi.spyOn(ipc, "commitStart");
    await actions.retryRow(row, { noVerify: true });
    expect(start.mock.calls[0][0].noVerify).toBe(true);
    expect(start.mock.calls[0][0].repos[0].message).toBe("feat: routes");
    expect(actions.sheetRows()).toHaveLength(1);
    expect(actions.rowState(rowOf("backend"))?.status).toBe("done");
    expect(messageHistory()).toEqual(["feat: routes"]);
  });

  it("keeps failed rows reachable after the sheet is closed", async () => {
    await seedStores(ipc, { backend: ["src/api/routes/index.js"] });
    setSharedMessage("feat: routes");
    await actions.commitAll();
    expect(actions.sheetAttention()).toBe(1);
    actions.closeSheet();
    expect(actions.sheetOpen()).toBe(false);
    expect(actions.sheetAttention()).toBe(1);
    actions.openSheet();
    expect(actions.sheetOpen()).toBe(true);
    expect(actions.sheetRows()).toHaveLength(1);
    await actions.retryRow(rowOf("backend"), { noVerify: true });
    expect(actions.sheetAttention()).toBe(0);
  });

  it("retries a lockBusy commit and keeps the other repos' rows", async () => {
    await seedStores(ipc, { backend: ["src/api/routes/index.js"], services: ["locales/hu.json"] });
    setSharedMessage("fix: x");
    await actions.commitAll();
    expect(actions.sheetRows().map((r) => [r.repoId, actions.rowState(r)?.status])).toEqual([
      ["backend", "failed"],
      ["services", "failed"],
    ]);
    expect(actions.rowState(rowOf("services"))?.outcome?.failure?.kind).toBe("lockBusy");

    await actions.retryRow(rowOf("services"));
    expect(actions.sheetRows().map((r) => [r.repoId, actions.rowState(r)?.status])).toEqual([
      ["backend", "failed"],
      ["services", "done"],
    ]);
  });

  it("reports a rejected command as failed rows instead of throwing", async () => {
    await seedStores(ipc, { services: ["locales/hu.json"] });
    vi.spyOn(ipc, "commitStart").mockRejectedValue({ code: "lockBusy", message: "index.lock exists" });
    setSharedMessage("fix: y");
    await expect(actions.commitAll()).resolves.toBeUndefined();
    const outcome = actions.rowState(rowOf("services"))?.outcome;
    expect(outcome?.status).toBe("failed");
    expect(outcome?.failure).toMatchObject({ kind: "lockBusy", message: "index.lock exists" });
  });
});

describe("push failures", () => {
  async function pushAdmin() {
    const [plan] = await ipc.pushPlan(["admin"], false);
    const request = buildPushRequest({ runId: "p1", plans: [plan], checks: { admin: true }, tags: "none", runHooks: true });
    return actions.runPush(request, { fresh: true });
  }

  it("surfaces a non-fast-forward rejection with pull then push", async () => {
    const result = await pushAdmin();
    expect(result.repos[0].failure?.kind).toBe("nonFastForward");
    const row = rowOf("admin");
    expect(row.target).toMatchObject({ repoId: "admin", remote: "origin", remoteBranch: "sandbox" });
    expect(describeFailure("nonFastForward", "push").actions).toContain("pullThenPush");
    expect(actions.rowState(row)?.lines.map((l) => l.text).join("\n")).toContain("[rejected]");
  });

  it("pulls with merge and pushes the same target again", async () => {
    await pushAdmin();
    const pull = vi.spyOn(ipc, "pull");
    const push = vi.spyOn(ipc, "pushStart");
    await actions.pullThenPush(rowOf("admin"));
    expect(pull).toHaveBeenCalledWith("admin", "merge");
    expect(push).toHaveBeenCalledOnce();
    expect(push.mock.calls[0][0].targets[0]).toMatchObject({ repoId: "admin", remoteBranch: "sandbox" });
    // The pull took the remote commits, so the second push goes through (a fresh run replaces the failed row).
    expect(actions.rowState(rowOf("admin"))?.status).toBe("done");
    expect(actions.sheetRows()).toHaveLength(1);
  });

  it("does not push after a failed pull", async () => {
    await pushAdmin();
    vi.spyOn(ipc, "pull").mockRejectedValue({ code: "git", message: "merge conflict" });
    const push = vi.spyOn(ipc, "pushStart");
    await actions.pullThenPush(rowOf("admin"));
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps the failed commit row of a repo that is not part of the push after \"Commit and Push…\"", async () => {
    await seedStores(ipc, { backend: ["src/api/routes/index.js"], services: ["locales/hu.json"] });
    setSharedMessage("fix: x");
    await actions.commitAndPush();
    const backendBefore = rowOf("backend");
    expect(actions.rowState(backendBefore)?.status).toBe("failed");

    const [plan] = await ipc.pushPlan(["admin"], false);
    await actions.runPush(buildPushRequest({ runId: "p2", plans: [plan], checks: { admin: true }, tags: "none", runHooks: true }), { fresh: true });

    expect(actions.sheetRows().map((r) => [r.repoId, r.kind])).toEqual([
      ["backend", "commit"],
      ["services", "commit"],
      ["admin", "push"],
    ]);
    expect(actions.rowState(rowOf("backend"))?.outcome?.failure?.kind).toBe("hookRejected");
  });
});
