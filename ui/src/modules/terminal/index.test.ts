import { afterEach, describe, expect, it } from "vitest";
import { availableCommands, resetCommands } from "../../platform/commands";
import { resetKeymap, shortcutConflicts } from "../../platform/keymap";
import { activeToolWindow, getRailItem, resetRail, setToolWindow } from "../../platform/rail";
import { execute } from "../../platform/commands";
import { register } from "./index";

afterEach(() => {
  resetCommands();
  resetKeymap();
  resetRail();
  localStorage.clear();
});

describe("terminal module", () => {
  it("registers a bottom rail item and the terminal commands without loading anything", () => {
    register();
    const item = getRailItem("terminal");
    expect(item?.position).toBe("bottom");
    expect(item?.panel).toBeTypeOf("function");
    expect(availableCommands().map((c) => c.id)).toEqual(expect.arrayContaining(["terminal.toggle", "terminal.new"]));
    expect(shortcutConflicts()).toEqual([]);
  });

  it("toggles the bottom tool window with terminal.toggle", async () => {
    register();
    await execute("terminal.toggle");
    expect(activeToolWindow("bottom")).toBe("terminal");
    await execute("terminal.toggle");
    expect(activeToolWindow("bottom")).toBeNull();
  });

  it("offers close and cycling only while the terminal is open", () => {
    register();
    const ids = () => availableCommands().map((c) => c.id);
    expect(ids()).not.toContain("terminal.close");
    setToolWindow("bottom", "terminal");
    expect(ids()).toEqual(expect.arrayContaining(["terminal.close", "terminal.next", "terminal.previous"]));
  });
});
