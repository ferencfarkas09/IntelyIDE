import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRailItemPressed, registerRailItem, resetRail, setToolWindow } from "../platform/rail";
import { GitCommitHorizontal } from "../ui-kit";
import { dockVisible, setDockOpen, toggleDockTab } from "./dock/dockState";
import { CENTRE_MIN, DOCK_MIN, PANEL_MIN, panelOpen, panelVisible, setAreaWidth, setPanelOpen } from "./layout";

beforeEach(() => {
  setPanelOpen(true);
  setDockOpen(false);
});
afterEach(() => {
  setAreaWidth(0);
  resetRail();
  localStorage.clear();
});

describe("narrow windows collapse the dock first, then the left panel", () => {
  it("collapses nothing while the width is unknown or wide enough for everything", () => {
    setDockOpen(true);
    setAreaWidth(0);
    expect([panelVisible(), dockVisible()]).toEqual([true, true]);
    setAreaWidth(CENTRE_MIN + PANEL_MIN + DOCK_MIN);
    expect([panelVisible(), dockVisible()]).toEqual([true, true]);
  });

  it("hides the dock before the Commit panel, and keeps what the user asked for", () => {
    setDockOpen(true);
    setAreaWidth(CENTRE_MIN + PANEL_MIN + DOCK_MIN - 1);
    expect([panelVisible(), dockVisible()]).toEqual([true, false]);
    setAreaWidth(CENTRE_MIN + PANEL_MIN - 1);
    expect([panelVisible(), dockVisible()]).toEqual([false, false]);
    // Wanted state is untouched, so widening brings both back.
    expect(panelOpen()).toBe(true);
    setAreaWidth(1400);
    expect([panelVisible(), dockVisible()]).toEqual([true, true]);
  });

  it("lets the dock stay when the Commit panel is closed and the centre still fits", () => {
    setDockOpen(true);
    setPanelOpen(false);
    setAreaWidth(CENTRE_MIN + DOCK_MIN);
    expect(dockVisible()).toBe(true);
  });

  it("shows the real state on the rail: a collapsed panel is not pressed", () => {
    registerRailItem({ id: "commit", icon: GitCommitHorizontal, title: "Commit", order: 20, position: "left", panel: () => null });
    const commit = { id: "commit", icon: GitCommitHorizontal, title: "Commit", order: 20, position: "left" as const, panel: () => null };
    setToolWindow("left", "commit");
    setAreaWidth(1400);
    expect(isRailItemPressed(commit)).toBe(true);
    setAreaWidth(CENTRE_MIN + PANEL_MIN - 1);
    expect(isRailItemPressed(commit)).toBe(false);
  });

  it("asking for the dock in a narrow window closes the Commit panel to make room instead of showing nothing", () => {
    setAreaWidth(CENTRE_MIN + PANEL_MIN + 60);
    toggleDockTab("agents");
    expect(dockVisible()).toBe(true);
    expect(panelOpen()).toBe(false);
    // Clicking the open dock again hides it.
    toggleDockTab("agents");
    expect(dockVisible()).toBe(false);
  });

  it("brings back a dock that is open but collapsed by the width instead of closing it", () => {
    setDockOpen(true);
    setAreaWidth(CENTRE_MIN + PANEL_MIN + 60);
    expect(dockVisible()).toBe(false);
    toggleDockTab("agents");
    expect(dockVisible()).toBe(true);
  });
});
