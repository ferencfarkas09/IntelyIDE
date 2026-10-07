import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockIpc } from "../ipc/mock";
import { createMockWorkspaces, type MockWorkspaces } from "../ipc/mock/workspaces";
import { registerUnsavedSource, resetUnsavedSources } from "../platform/closeGuard";
import { getPageEpoch, setPageEpoch } from "../ipc/rpc";
import { toast } from "../ui-kit";
import { enterEmptyState, repos, workspace, workspaceState } from "./workspace";
import {
  activeId,
  consumeHandoff,
  crashLoop,
  forceOpen,
  guard,
  guardCancel,
  guardForceSwitch,
  guardSaveAndSwitch,
  HANDOFF_KEY,
  onLeaveWorkspace,
  recents,
  registryProblem,
  removeWorkspace,
  requestSwitch,
  resetWorkspacesForTest,
  rowStatus,
  setReloadHook,
  startWorkspaces,
} from "./workspaces";

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const reg = (ipc: ReturnType<typeof createMockIpc>) => ipc.workspaces as MockWorkspaces;
const seedOf = async () => (await createMockIpc("normal", { delayScale: 0 }).workspaceGet()).repos;

let reload: ReturnType<typeof vi.fn<() => void>>;
let prevReload: () => void;
let stop: (() => void) | undefined;

beforeEach(() => {
  resetWorkspacesForTest();
  enterEmptyState();
  reload = vi.fn<() => void>();
  prevReload = setReloadHook(reload);
  toast.clear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  setReloadHook(prevReload);
  resetUnsavedSources();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const boot = async (ipc: ReturnType<typeof createMockIpc>, state: "ready" | "empty") => {
  stop = startWorkspaces(ipc);
  await vi.waitFor(() => expect(workspaceState()).toBe(state));
  await vi.waitFor(() => expect(activeId() !== undefined).toBe(true));
};

describe("boot", () => {
  it("no workspace: Welcome (empty) with an empty list and the page epoch recorded", async () => {
    const ipc = createMockIpc("welcome", { delayScale: 0 });
    await boot(ipc, "empty");
    expect(workspace()).toBeUndefined();
    expect(recents()).toEqual([]);
    expect(getPageEpoch()).toBe(1);
  });

  it("an open workspace loads: ready with its repos, ready() called with the epoch", async () => {
    const ipc = createMockIpc("normal", { delayScale: 0 });
    const ready = vi.spyOn(ipc.workspaces, "ready");
    await boot(ipc, "ready");
    await vi.waitFor(() => expect(repos().map((r) => r.id)).toEqual(["backend", "admin", "services", "pos"]));
    expect(activeId()).toBe("w-migrated");
    expect(ready).toHaveBeenCalledWith(1);
  });

  it("a registry problem or a crash loop shows Welcome and loads no workspace", async () => {
    const bad = createMockIpc("welcome-problem", { delayScale: 0 });
    await boot(bad, "empty");
    expect(registryProblem()?.kind).toBe("corrupt");
    stop?.();
    resetWorkspacesForTest();
    const loop = createMockIpc("welcome-crashloop", { delayScale: 0 });
    await boot(loop, "empty");
    expect(crashLoop()).toEqual({ id: "w-migrated", name: "Happy workspace" });
    expect(loop.workspaces.ready).toBeDefined();
  });

  it("the open workspace is not stated by a stat in the registry: a failing list falls back to the legacy single workspace", async () => {
    const ipc = createMockIpc("normal", { delayScale: 0 });
    vi.spyOn(ipc.workspaces, "list").mockRejectedValue({ code: "io", message: "boom" });
    await boot(ipc, "ready");
    expect(repos()).toHaveLength(4);
  });

  it("every folder missing at launch: switch(null, force, keepActive), reload, and no loop afterwards", async () => {
    const storage = new MemoryStorage();
    const seed = await seedOf();
    const first = createMockIpc("normal", { delayScale: 0, workspaces: createMockWorkspaces({ seed, storage }) });
    for (const r of seed) reg(first).setProbe(r.path, "missing");
    const sw = vi.spyOn(first.workspaces, "switch");
    stop = startWorkspaces(first);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(sw).toHaveBeenCalledWith(null, { force: true, keepActive: true });
    const handoff = sessionStorage.getItem(HANDOFF_KEY) ?? "{}";
    expect(typeof JSON.parse(handoff).foldersMissing).toBe("string");
    stop();
    resetWorkspacesForTest();
    enterEmptyState();
    sessionStorage.setItem(HANDOFF_KEY, handoff); // the next page is a fresh load: the reset above stands in for the reload
    const second = createMockIpc("normal", { delayScale: 0, workspaces: createMockWorkspaces({ seed, storage }) });
    await boot(second, "empty");
    expect(activeId()).toBe("w-migrated");
    expect(second.workspaces.switch).toBeDefined();
    expect(reload).toHaveBeenCalledOnce();
    // nobody closed it: the toast says the folders were not found, never "Workspace closed"
    await vi.waitFor(() => expect(toast.toasts().some((x) => x.title.includes("were not found"))).toBe(true));
    expect(toast.toasts().some((x) => x.title === "Workspace closed")).toBe(false);
  });

  it("a partly missing workspace still opens", async () => {
    const ipc = createMockIpc("normal", { delayScale: 0 });
    reg(ipc).setProbe("/Users/example/Projects/admin", "missing");
    await boot(ipc, "ready");
    expect(reload).not.toHaveBeenCalled();
  });

  it("the hand-off of the previous page becomes one toast, once", async () => {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ from: "a", to: "w-migrated", toName: "Happy workspace", at: 1 }));
    const ipc = createMockIpc("normal", { delayScale: 0 });
    await boot(ipc, "ready");
    await vi.waitFor(() => expect(toast.toasts().map((x) => x.title)).toContain("Switched to Happy workspace"));
    expect(consumeHandoff()).toBeNull();
  });

  it("a failure hand-off is shown as an error toast", async () => {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ from: "a", to: null, toName: null, at: 1, error: { code: "io", message: "x" } }));
    await boot(createMockIpc("welcome", { delayScale: 0 }), "empty");
    await vi.waitFor(() => expect(toast.toasts().some((x) => x.tone === "danger")).toBe(true));
  });
});

describe("requestSwitch", () => {
  const open = async () => {
    const ipc = createMockIpc("normal", { delayScale: 0 });
    await boot(ipc, "ready");
    return ipc;
  };

  it("nothing busy: busy, leave hooks, switch, hand-off, reload, in that order, without a dialog", async () => {
    const ipc = await open();
    const calls: string[] = [];
    vi.spyOn(ipc.workspaces, "busy").mockImplementation(async () => (calls.push("busy"), { blocking: [], confirmable: [] }));
    const sw = vi.spyOn(ipc.workspaces, "switch").mockImplementation(async (id, o) => (calls.push(`switch ${id} force=${o.force}`), { activeId: id, epoch: 2, warnings: [], survivors: [] }));
    onLeaveWorkspace(() => calls.push("leave"));
    reload.mockImplementation(() => calls.push("reload"));
    expect(await requestSwitch("w3f9a1c2b4", ipc)).toBe("switched");
    expect(calls).toEqual(["busy", "leave", "switch w3f9a1c2b4 force=false", "reload"]);
    expect(sw).toHaveBeenCalledOnce();
    expect(guard()).toBeNull();
    expect(workspaceState()).toBe("switching");
    expect(consumeHandoff()).toMatchObject({ from: "w-migrated", to: "w3f9a1c2b4", toName: "Side projects" });
  });

  it("closing the workspace is a switch to null", async () => {
    const ipc = await open();
    expect(await requestSwitch(null, ipc)).toBe("switched");
    expect(reg(ipc).activeWorkspace()).toBeNull();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("switching to the open workspace does nothing", async () => {
    const ipc = await open();
    expect(await requestSwitch("w-migrated", ipc)).toBe("cancelled");
    expect(reload).not.toHaveBeenCalled();
  });

  it("confirmable items open the dialog; Stop them and switch forces the switch", async () => {
    const ipc = await open();
    reg(ipc).setBusy({ blocking: [], confirmable: [{ kind: "agent", count: 2, labels: [] }, { kind: "devServer", count: 1, labels: ["api"] }] });
    expect(await requestSwitch("w3f9a1c2b4", ipc)).toBe("guard");
    expect(guard()?.model.confirmable.map((i) => i.kind)).toEqual(["agent", "devServer"]);
    expect(guard()?.targetName).toBe("Side projects");
    expect(reload).not.toHaveBeenCalled();
    expect(await guardForceSwitch(ipc)).toBe("switched");
    expect(guard()).toBeNull();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("Cancel closes the dialog and changes nothing", async () => {
    const ipc = await open();
    reg(ipc).setBusy({ blocking: [], confirmable: [{ kind: "terminal", count: 1, labels: [] }] });
    await requestSwitch(null, ipc);
    guardCancel();
    expect(guard()).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(workspaceState()).toBe("ready");
  });

  it("a blocking git run keeps the confirm disabled; the dialog re-polls and enables itself when the run is gone", async () => {
    const ipc = await open();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    reg(ipc).setBusy({ blocking: [{ kind: "gitRun", count: 1, labels: ["push"] }], confirmable: [] });
    await requestSwitch("w3f9a1c2b4", ipc);
    expect(await guardForceSwitch(ipc)).toBe("guard");
    expect(reload).not.toHaveBeenCalled();
    reg(ipc).setBusy({ blocking: [], confirmable: [] });
    await vi.advanceTimersByTimeAsync(1100);
    expect(guard()?.model.blocking).toEqual([]);
    expect(await guardForceSwitch(ipc)).toBe("switched");
  });

  it("unsaved buffers are listed first; Save all saves, then switches; a failed save stays in the dialog", async () => {
    const ipc = await open();
    let saved = false;
    let ok = false;
    registerUnsavedSource({ id: "ed", titles: () => (saved ? [] : ["a.ts", "b.ts"]), saveAll: async () => ((saved = ok), ok) });
    expect(await requestSwitch("w3f9a1c2b4", ipc)).toBe("guard");
    expect(guard()?.model.unsaved).toEqual(["a.ts", "b.ts"]);
    expect(await guardSaveAndSwitch(ipc)).toBe("guard");
    expect(guard()?.saveFailed).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    ok = true;
    expect(await guardSaveAndSwitch(ipc)).toBe("switched");
  });

  it("Don't save and switch skips saving", async () => {
    const ipc = await open();
    const saveAll = vi.fn(async () => true);
    registerUnsavedSource({ id: "ed", titles: () => ["a.ts"], saveAll });
    await requestSwitch(null, ipc);
    expect(await guardForceSwitch(ipc)).toBe("switched");
    expect(saveAll).not.toHaveBeenCalled();
  });

  it("the engine finds a blocker the preflight missed: workspaceBusy reopens the dialog with Rust's report", async () => {
    const ipc = await open();
    vi.spyOn(ipc.workspaces, "busy").mockResolvedValue({ blocking: [], confirmable: [] });
    vi.spyOn(ipc.workspaces, "switch").mockRejectedValue({ code: "workspaceBusy", message: "x", detail: JSON.stringify({ blocking: [{ kind: "gitOp", count: 1, labels: ["rebase"] }], confirmable: [] }) });
    expect(await requestSwitch("w3f9a1c2b4", ipc)).toBe("failed");
    expect(guard()?.model.blocking[0]).toMatchObject({ kind: "gitOp", labels: ["rebase"] });
    expect(workspaceState()).toBe("ready");
    expect(reload).not.toHaveBeenCalled();
  });

  it("a refusal before anything was stopped leaves the page alone and says why", async () => {
    const ipc = await open();
    reg(ipc).setNextSwitchFailure({ code: "invalidWorkspace", message: "damaged" });
    expect(await requestSwitch("w3f9a1c2b4", ipc)).toBe("failed");
    expect(reload).not.toHaveBeenCalled();
    expect(workspaceState()).toBe("ready");
    expect(toast.toasts().some((x) => x.tone === "danger")).toBe(true);
    // and the next attempt is possible
    expect(await requestSwitch("w3f9a1c2b4", ipc)).toBe("switched");
  });

  it("a failure after teardown could have started reloads anyway and carries the error", async () => {
    const ipc = await open();
    reg(ipc).setNextSwitchFailure({ code: "io", message: "disk" });
    expect(await requestSwitch("w3f9a1c2b4", ipc)).toBe("failed");
    expect(reload).toHaveBeenCalledOnce();
    expect(consumeHandoff()?.error).toEqual({ code: "io", message: "disk" });
  });

  it("survivors from the result are kept for the banner", async () => {
    const ipc = await open();
    reg(ipc).setSurvivors([{ pid: 9, port: 3000, cwd: "/p", kind: "devServer" }]);
    await requestSwitch("w3f9a1c2b4", ipc);
    const { survivors } = await import("./workspaces");
    expect(survivors()).toHaveLength(1);
  });

  it("Open anyway (crash loop) switches without a preflight", async () => {
    const ipc = createMockIpc("welcome-crashloop", { delayScale: 0 });
    await boot(ipc, "empty");
    expect(await forceOpen("w-migrated", ipc)).toBe("switched");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("removing the open workspace runs the close flow first and does not remove while a dialog is up", async () => {
    const ipc = await open();
    expect(await removeWorkspace("w-migrated", ipc)).toBe("switched");
    expect(reg(ipc).activeWorkspace()).toBeNull();
    expect((await ipc.workspaces.list()).workspaces.some((w) => w.id === "w-migrated")).toBe(true);
  });

  it("removing another workspace removes the entry only", async () => {
    const ipc = await open();
    expect(await removeWorkspace("w7c1d2e3f4", ipc)).toBe("removed");
    expect(recents().map((w) => w.id)).not.toContain("w7c1d2e3f4");
  });

  it("a second request while one is in flight is ignored", async () => {
    const ipc = await open();
    expect(await requestSwitch("w3f9a1c2b4", ipc)).toBe("switched");
    expect(await requestSwitch("w7c1d2e3f4", ipc)).toBe("cancelled");
  });
});

describe("recents and row status", () => {
  it("sorts by last opened, never-opened last, then by name", async () => {
    const ipc = createMockIpc("welcome-recents", { delayScale: 0 });
    await boot(ipc, "empty");
    expect(recents().map((w) => w.name)).toEqual(["Happy workspace", "Side projects", "Client X", "Docs and wiki", "Experiments"]);
  });

  it("rowStatus: checking, ok, some missing, all missing, volume, empty workspace, damaged file", () => {
    const ws = { id: "w", name: "w", color: "#000000", order: 0, createdAt: 0, lastOpenedAt: null, origin: "created" as const, repos: [1, 2, 3].map((n) => ({ id: `r${n}`, name: `r${n}`, color: "#000000", badge: "R", path: `/p/${n}` })) };
    const probe = (statuses: string[]) => ({ id: "w", repos: statuses.map((s, i) => ({ repoId: `r${i + 1}`, status: s as never, branch: null, detached: false })) });
    expect(rowStatus(ws, undefined, true).kind).toBe("checking");
    expect(rowStatus(ws, undefined, false).kind).toBe("ok");
    expect(rowStatus(ws, probe(["ok", "ok", "ok"]), false).kind).toBe("ok");
    expect(rowStatus(ws, probe(["ok", "missing", "missing"]), false)).toEqual({ kind: "someMissing", missing: 2, total: 3 });
    expect(rowStatus(ws, probe(["missing", "missing", "missing"]), false).kind).toBe("missing");
    expect(rowStatus(ws, probe(["volumeMissing", "volumeMissing", "volumeMissing"]), false).kind).toBe("volumeMissing");
    expect(rowStatus({ ...ws, repos: [] }, probe([]), false).kind).toBe("ok");
    expect(rowStatus(ws, undefined, false, true).kind).toBe("fileDamaged");
  });
});

void setPageEpoch;

describe("migration notice", () => {
  it("the page that follows a migration says so once", async () => {
    const ipc = createMockIpc("normal", { delayScale: 0 });
    reg(ipc).setJustMigrated(true);
    await boot(ipc, "ready");
    await vi.waitFor(() => expect(toast.toasts().map((x) => x.title)).toContain("Your workspace was moved to the new workspace list."));
    expect((await ipc.workspaces.list()).justMigrated).toBeUndefined();
  });
});
