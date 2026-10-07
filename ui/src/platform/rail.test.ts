import { Bot } from "lucide-solid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRailItem, activeToolWindow, isRailItemPressed, railItems, registerRailItem, resetRail } from "./rail";
import { setPanelOpen } from "../shell/layout";

const Panel = () => null;
afterEach(resetRail);

describe("rail registry", () => {
  it("orders items and lets a module replace its placeholder", () => {
    registerRailItem({ id: "graph", icon: Bot, title: "Graph", order: 30, position: "left", soon: true });
    registerRailItem({ id: "commit", icon: Bot, title: "Commit", order: 20, position: "left", panel: Panel });
    expect(railItems().map((i) => i.id)).toEqual(["commit", "graph"]);
    registerRailItem({ id: "graph", icon: Bot, title: "Graph", order: 30, position: "left", panel: Panel });
    expect(railItems()).toHaveLength(2);
    expect(railItems()[1].soon).toBeUndefined();
  });

  it("needs a panel or a run function unless it is a placeholder", () => {
    expect(() => registerRailItem({ id: "x", icon: Bot, title: "X", order: 1, position: "left" })).toThrow();
  });

  it("toggles a left tool window through the panel flag", () => {
    const item = { id: "search", icon: Bot, title: "Search", order: 40, position: "left" as const, panel: Panel };
    registerRailItem(item);
    setPanelOpen(false);
    activateRailItem(item);
    expect(activeToolWindow("left")).toBe("search");
    expect(isRailItemPressed(item)).toBe(true);
    activateRailItem(item);
    expect(isRailItemPressed(item)).toBe(false);
    setPanelOpen(true);
  });

  it("opens and closes a bottom tool window", () => {
    const item = { id: "terminal", icon: Bot, title: "Terminal", order: 60, position: "bottom" as const, panel: Panel };
    activateRailItem(item);
    expect(activeToolWindow("bottom")).toBe("terminal");
    activateRailItem(item);
    expect(activeToolWindow("bottom")).toBeNull();
  });

  it("runs action items and ignores placeholders", () => {
    const run = vi.fn();
    activateRailItem({ id: "s", icon: Bot, title: "S", order: 1, position: "left", run });
    activateRailItem({ id: "p", icon: Bot, title: "P", order: 1, position: "left", soon: true, run });
    expect(run).toHaveBeenCalledOnce();
  });
});
