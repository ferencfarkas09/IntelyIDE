import { Bot } from "lucide-solid";
import { afterEach, describe, expect, it } from "vitest";
import { activateTab, activeTab, closeTab, cycleTab, openTab, registerTabType, resetTabs, restoreTabs, snapshotTabs, tabs, updateTab } from "./tabs";

const component = () => null;
const register = (type: string, canClose: boolean | (() => boolean) = true) => registerTabType({ type, title: type, icon: Bot, component, canClose });

afterEach(resetTabs);

describe("tabs store", () => {
  it("opens a tab, makes it active and focuses an existing id instead of duplicating", () => {
    register("editor");
    const a = openTab({ type: "editor", id: "e:a", title: "a.ts" });
    openTab({ type: "editor", id: "e:b" });
    expect(activeTab()?.id).toBe("e:b");
    expect(openTab({ type: "editor", id: a })).toBe(a);
    expect(tabs()).toHaveLength(2);
    expect(activeTab()?.id).toBe("e:a");
  });

  it("defaults the title to the type title and rejects unknown types", () => {
    register("editor");
    openTab({ type: "editor", id: "x" });
    expect(activeTab()?.title).toBe("editor");
    expect(() => openTab({ type: "nope" })).toThrow(/Unknown tab type/);
  });

  it("closes a tab and activates its left neighbour, else the right one", () => {
    register("editor");
    openTab({ type: "editor", id: "1" });
    openTab({ type: "editor", id: "2" });
    openTab({ type: "editor", id: "3" });
    activateTab("2");
    expect(closeTab("2")).toBe(true);
    expect(activeTab()?.id).toBe("1");
    closeTab("1");
    expect(activeTab()?.id).toBe("3");
    closeTab("3");
    expect(activeTab()).toBeUndefined();
  });

  it("keeps a tab whose type cannot be closed, or whose predicate refuses", () => {
    register("diff", false);
    let busy = true;
    register("editor", () => !busy);
    openTab({ type: "diff", id: "diff" });
    openTab({ type: "editor", id: "e" });
    expect(closeTab("diff")).toBe(false);
    expect(closeTab("e")).toBe(false);
    busy = false;
    expect(closeTab("e")).toBe(true);
  });

  it("cycles with wrap-around and marks dirty tabs", () => {
    register("editor");
    openTab({ type: "editor", id: "1" });
    openTab({ type: "editor", id: "2" });
    cycleTab(1);
    expect(activeTab()?.id).toBe("1");
    cycleTab(-1);
    expect(activeTab()?.id).toBe("2");
    updateTab("2", { dirty: true });
    expect(activeTab()?.dirty).toBe(true);
  });
});

describe("snapshot and restore", () => {
  it("snapshots plain data and the active tab, dropping params that cannot be serialised", () => {
    register("editor");
    openTab({ type: "editor", id: "e:a", title: "a", params: { path: "a.ts" } });
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    openTab({ type: "editor", id: "e:b", params: cyc });
    expect(snapshotTabs()).toEqual({ tabs: [{ id: "e:a", type: "editor", title: "a", params: { path: "a.ts" } }], activeTabId: "e:b" });
  });

  it("restores only allowed, registered types, keeps the registry, and reactivates the saved tab", () => {
    register("editor");
    const list = [
      { id: "e:a", type: "editor", title: "a" },
      { id: "t:1", type: "terminal", title: "zsh" },
      { id: "g:1", type: "ghost", title: "?" },
      { id: "e:b", type: "editor", title: "b" },
    ];
    expect(restoreTabs(list, "e:a", new Set(["editor", "ghost"]))).toEqual({ restored: 2, skipped: 2, failed: 0 });
    expect(tabs().map((t) => t.id)).toEqual(["e:a", "e:b"]);
    expect(activeTab()?.id).toBe("e:a");
    expect(restoreTabs(list, null, new Set(["editor"])).restored).toBe(0);
    openTab({ type: "editor", id: "e:c" });
    register("editor");
    expect(tabs()).toHaveLength(3);
  });
});
