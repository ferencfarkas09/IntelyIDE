import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appMode, registerModeView, resetModes, setAppMode } from "../platform/mode";
import { registerRailItem, resetRail } from "../platform/rail";
import { Bot, Settings } from "../ui-kit";
import { Rail } from "./Rail";

afterEach(() => {
  cleanup();
  resetRail();
  resetModes();
});

describe("<Rail>", () => {
  it("shows a count on an item and hides it at zero", () => {
    const [count, setCount] = createSignal(0);
    registerRailItem({ id: "agents", icon: Bot, title: "Agents", order: 50, position: "left", run: () => {}, badge: count });
    render(() => <Rail />);
    expect(screen.queryByRole("status")).toBeNull();
    setCount(3);
    expect(screen.getByRole("status").textContent).toBe("3");
    setCount(12);
    expect(screen.getByRole("status").textContent).toBe("9+");
  });

  it("leads back to the editor from a tool window button in Agent mode, but still runs action items", () => {
    registerModeView({ id: "agent", title: "Agent", component: () => null });
    setAppMode("agent");
    const run = vi.fn();
    registerRailItem({ id: "commit", icon: Bot, title: "Commit", order: 20, position: "left", panel: () => null });
    registerRailItem({ id: "settings", icon: Settings, title: "Settings", order: 100, position: "left", run });
    render(() => <Rail />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(run).toHaveBeenCalled();
    expect(appMode()).toBe("agent");
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    expect(appMode()).toBe("editor");
  });
});
