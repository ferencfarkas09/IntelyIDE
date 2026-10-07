import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async () => ({ ipc: (await import("../../store/testing-u2")).normal.ipc }));
vi.mock("../../store/selection", async () => (await import("../../store/testing-u2")).selectionModule);
vi.mock("../../store/snapshots", async () => (await import("../../store/testing-u2")).snapshotsModule);
vi.mock("../../store/workspace", async () => (await import("../../store/testing-u2")).workspaceModule);

import { ipc } from "../../ipc";
import { resetActions } from "../../store/actions";
import { normal, seedStores } from "../../store/testing-u2";
import { createPushModel } from "./model";
import { setPushTags, setRunGitHooks } from "./settings";

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(cond()).toBe(true);
};

function withModel<T>(fn: (m: ReturnType<typeof createPushModel>) => Promise<T>): Promise<T> {
  return createRoot(async (dispose) => {
    try {
      return await fn(createPushModel());
    } finally {
      dispose();
    }
  });
}

beforeEach(async () => {
  localStorage.clear();
  resetActions();
  normal.reset();
  setPushTags("none");
  setRunGitHooks(true);
  await seedStores(ipc, {});
});
afterEach(() => vi.restoreAllMocks());

describe("push dialog model (mock scenario normal)", () => {
  it("lists every repo, ticks only those with outgoing commits and expands them", () =>
    withModel(async (m) => {
      m.open();
      await until(() => m.state.phase === "ready");
      expect(m.state.plans.map((p) => p.repoId)).toEqual(["backend", "admin", "services", "pos"]);
      expect(m.state.checks).toEqual({ backend: true, admin: true, services: false, pos: false });
      expect(m.state.expanded).toEqual({ backend: true, admin: true, services: false, pos: false });
      // The first outgoing commit is selected and its files are loaded.
      await until(() => m.state.selected?.repoId === "backend" && Object.values(m.state.files).some((f) => f.status === "ready"));
    }));

  it("limits the initial ticks to the repos the dialog was opened for", () =>
    withModel(async (m) => {
      m.open(["admin"]);
      await until(() => m.state.phase === "ready");
      expect(m.state.checks).toEqual({ backend: false, admin: true, services: false, pos: false });
    }));

  it("does not let repos without outgoing commits be ticked", () =>
    withModel(async (m) => {
      m.open();
      await until(() => m.state.phase === "ready");
      m.toggleRepo("services", true);
      m.toggleRepo("backend", false);
      expect(m.state.checks.services).toBe(false);
      expect(m.state.checks.backend).toBe(false);
      expect(m.checkedPlans().map((p) => p.repoId)).toEqual(["admin"]);
    }));

  it("saves an edited target through set_push_target and keeps the user's ticks", () =>
    withModel(async (m) => {
      m.open();
      await until(() => m.state.phase === "ready");
      m.toggleRepo("backend", false);
      const save = vi.spyOn(ipc, "setPushTarget");
      await expect(m.saveTargets([{ repoId: "admin", remote: "origin", branch: "release/light" }])).resolves.toBe(true);
      expect(save).toHaveBeenCalledWith("admin", "feature-light-design", "origin", "release/light");
      const admin = m.state.plans.find((p) => p.repoId === "admin")!;
      expect(admin.remoteBranch).toBe("release/light");
      expect(admin.protected).toBe(true);
      expect(m.state.checks.backend).toBe(false);
    }));

  it("shows a planning error and recovers on retry", () =>
    withModel(async (m) => {
      vi.spyOn(ipc, "pushPlan").mockRejectedValueOnce({ code: "git", message: "ls-remote failed" });
      m.open();
      await until(() => m.state.phase === "error");
      expect(m.state.error).toBe("ls-remote failed");
      await m.reload();
      expect(m.state.phase).toBe("ready");
    }));

  it("pushes the ticked repos with the option toggles", () =>
    withModel(async (m) => {
      setPushTags("all");
      setRunGitHooks(false);
      m.open();
      await until(() => m.state.phase === "ready");
      const push = vi.spyOn(ipc, "pushStart");
      const result = await m.start(false);
      expect(result?.repos.map((r) => r.status)).toEqual(["done", "done"]);
      const req = push.mock.calls[0][0];
      expect(req.noVerify).toBe(true);
      expect(req.targets.map((t) => [t.repoId, t.tags, t.forceWithLease])).toEqual([
        ["backend", "all", undefined],
        ["admin", "all", undefined],
      ]);
      expect(m.running()).toBe(false);
    }));

  it("force push sends a lease for every ticked repo and lists them for the confirmation", () =>
    withModel(async (m) => {
      m.open();
      await until(() => m.state.phase === "ready");
      m.toggleRepo("backend", false);
      expect(m.forceRows().map((r) => [r.repoName, r.target, r.protected])).toEqual([["admin", "origin/sandbox", false]]);
      const push = vi.spyOn(ipc, "pushStart");
      await m.start(true);
      expect(push.mock.calls[0][0].targets).toEqual([expect.objectContaining({ repoId: "admin", forceWithLease: { seenOid: "" } })]);
    }));

  it("does nothing without a ticked repo", () =>
    withModel(async (m) => {
      m.open();
      await until(() => m.state.phase === "ready");
      m.toggleRepo("backend", false);
      m.toggleRepo("admin", false);
      const push = vi.spyOn(ipc, "pushStart");
      await expect(m.start(false)).resolves.toBeNull();
      expect(push).not.toHaveBeenCalled();
    }));
});
