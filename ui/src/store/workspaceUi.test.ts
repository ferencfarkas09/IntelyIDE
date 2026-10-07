import { FileText } from "lucide-solid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setToolWindow, activeToolWindow } from "../platform/rail";
import { activeTab, openTab, registerTabType, resetTabs, tabs } from "../platform/tabs";
import { createMockIpc } from "../ipc/mock";
import { enterEmptyState, loadWorkspace } from "./workspace";
import { MAX_REMEMBERED, readWorkspaceUi, restoreWorkspaceUi, saveWorkspaceUi, startWorkspaceUiSync, UI_KEY } from "./workspaceUi";
import { resetWorkspacesForTest, startWorkspaces } from "./workspaces";

const register = (type: string) => registerTabType({ type, title: type, icon: FileText, component: () => null, canClose: true });

beforeEach(() => {
  localStorage.clear();
  resetTabs();
  register("file");
  register("diff");
  register("terminal");
  setToolWindow("left", "commit");
});
afterEach(() => {
  resetTabs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("save and restore", () => {
  it("saves the file and diff tabs, the active one and the left tool window; terminal tabs are left out", () => {
    openTab({ type: "file", id: "file:a:x.ts", title: "x.ts", params: { repoId: "a", path: "x.ts", jump: 5 } });
    openTab({ type: "terminal", id: "term:1", title: "zsh" });
    openTab({ type: "file", id: "file:a:y.ts", title: "y.ts", params: { repoId: "a", path: "y.ts" } });
    setToolWindow("left", "graph");
    saveWorkspaceUi("w1", 100);
    const saved = readWorkspaceUi("w1")!;
    expect(saved.tabs.map((t) => t.id)).toEqual(["file:a:x.ts", "file:a:y.ts"]);
    expect(saved.tabs[0].params).toEqual({ repoId: "a", path: "x.ts" });
    expect(saved).toMatchObject({ activeTabId: "file:a:y.ts", leftWindow: "graph", savedAt: 100 });
  });

  it("restores into a fresh page: tabs, active tab and tool window, only registered restorable types", () => {
    saveWorkspaceUi("w1");
    resetTabs();
    localStorage.setItem(
      UI_KEY,
      JSON.stringify({
        w1: {
          tabs: [
            { id: "file:a:x.ts", type: "file", title: "x.ts", params: { repoId: "a", path: "x.ts" } },
            { id: "term:1", type: "terminal", title: "zsh" },
            { id: "ghost:1", type: "ghost", title: "?" },
            { id: "file:a:y.ts", type: "file", title: "y.ts" },
          ],
          activeTabId: "file:a:x.ts",
          leftWindow: "search",
          savedAt: 1,
        },
      }),
    );
    register("file");
    expect(restoreWorkspaceUi("w1")).toBe(2);
    expect(tabs().map((t) => t.id)).toEqual(["file:a:x.ts", "file:a:y.ts"]);
    expect(activeTab()?.id).toBe("file:a:x.ts");
    expect(activeToolWindow("left")).toBe("search");
  });

  it("another workspace's state is not touched; unknown workspace restores nothing", () => {
    openTab({ type: "file", id: "f1", title: "f1" });
    saveWorkspaceUi("w1");
    resetTabs();
    register("file");
    openTab({ type: "file", id: "f2", title: "f2" });
    saveWorkspaceUi("w2");
    expect(readWorkspaceUi("w1")!.tabs.map((t) => t.id)).toEqual(["f1"]);
    expect(readWorkspaceUi("w2")!.tabs.map((t) => t.id)).toEqual(["f2"]);
    expect(restoreWorkspaceUi("nope")).toBe(0);
  });

  it("keeps the twenty most recently saved workspaces", () => {
    for (let i = 0; i < 25; i++) saveWorkspaceUi(`w${i}`, i);
    const all = JSON.parse(localStorage.getItem(UI_KEY)!) as Record<string, unknown>;
    expect(Object.keys(all)).toHaveLength(MAX_REMEMBERED);
    expect(all.w24).toBeDefined();
    expect(all.w0).toBeUndefined();
  });

  it("a throwing localStorage is swallowed on both sides", () => {
    const boom = () => {
      throw new Error("blocked");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    openTab({ type: "file", id: "f1", title: "f1" });
    expect(() => saveWorkspaceUi("w1")).not.toThrow();
    expect(restoreWorkspaceUi("w1")).toBe(0);
    expect(readWorkspaceUi("w1")).toBeNull();
  });

  it("garbage in the store is ignored", () => {
    localStorage.setItem(UI_KEY, "{not json");
    expect(readWorkspaceUi("w1")).toBeNull();
    localStorage.setItem(UI_KEY, JSON.stringify({ w1: { tabs: "x" } }));
    expect(readWorkspaceUi("w1")).toBeNull();
    expect(() => saveWorkspaceUi("w1")).not.toThrow();
  });
});

describe("sync with the workspace store", () => {
  it("restores once the workspace is ready, then saves after changes (debounced) and on pagehide", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    localStorage.setItem(UI_KEY, JSON.stringify({ "w-migrated": { tabs: [{ id: "file:backend:a.ts", type: "file", title: "a.ts", params: { repoId: "backend", path: "a.ts" } }], activeTabId: "file:backend:a.ts", leftWindow: null, savedAt: 1 } }));
    resetWorkspacesForTest();
    enterEmptyState();
    const ipc = createMockIpc("normal", { delayScale: 0 });
    const stopWs = startWorkspaces(ipc);
    const stopUi = startWorkspaceUiSync();
    await vi.waitFor(() => expect(tabs().map((t) => t.id)).toContain("file:backend:a.ts"));
    openTab({ type: "file", id: "file:backend:b.ts", title: "b.ts" });
    expect(readWorkspaceUi("w-migrated")!.tabs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(readWorkspaceUi("w-migrated")!.tabs.map((t) => t.id)).toEqual(["file:backend:a.ts", "file:backend:b.ts"]);
    openTab({ type: "file", id: "file:backend:c.ts", title: "c.ts" });
    window.dispatchEvent(new Event("pagehide"));
    expect(readWorkspaceUi("w-migrated")!.tabs).toHaveLength(3);
    stopUi();
    stopWs();
    void loadWorkspace;
  });

  it("never saves before the restore attempt: a fresh empty page does not wipe the saved state", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    localStorage.setItem(UI_KEY, JSON.stringify({ "w-migrated": { tabs: [{ id: "x", type: "file", title: "x" }], activeTabId: null, leftWindow: null, savedAt: 1 } }));
    resetWorkspacesForTest();
    enterEmptyState();
    const stopUi = startWorkspaceUiSync();
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(readWorkspaceUi("w-migrated")!.tabs).toHaveLength(1);
    stopUi();
  });
});
