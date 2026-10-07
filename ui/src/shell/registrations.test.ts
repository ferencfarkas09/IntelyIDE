import { afterEach, describe, expect, it } from "vitest";
import { registerModules } from "../modules";
import { resetCommands } from "../platform/commands";
import { resetEditorExtensions } from "../platform/editor-ext";
import { resetInspector } from "../platform/inspector";
import { getCommand } from "../platform/commands";
import { resetKeymap, shortcutConflicts, shortcutFor } from "../platform/keymap";
import { resetModes } from "../platform/mode";
import { resetOverlays } from "../platform/overlay";
import { railItems, resetRail } from "../platform/rail";
import { registryClashes } from "../platform/registry";
import { resetSettings, settingsSections } from "../platform/settings";
import { resetStatusItems } from "../platform/statusbar";
import { resetTabs } from "../platform/tabs";
import { registerBuiltins } from "./builtin";

afterEach(() => {
  resetCommands();
  resetKeymap();
  resetRail();
  resetStatusItems();
  resetSettings();
  resetTabs();
  resetEditorExtensions();
  resetInspector();
  resetOverlays();
  resetModes();
});

describe("the full set of registrations", () => {
  it("has no id claimed twice, no shortcut chord bound twice and no module that fails to register", () => {
    registerBuiltins();
    expect(registerModules()).toEqual([]);
    expect(registryClashes()).toEqual([]);
    expect(shortcutConflicts()).toEqual([]);
  });

  it("gives every rail button and settings section its own place", () => {
    registerBuiltins();
    registerModules();
    const slot = (i: { position: string; align?: string; order: number }) => `${i.position}/${i.align ?? "start"}/${i.order}`;
    const slots = railItems().map(slot);
    expect(slots.filter((s, i) => slots.indexOf(s) !== i)).toEqual([]);
    const orders = settingsSections().map((s) => s.order);
    expect(orders.filter((o, i) => orders.indexOf(o) !== i)).toEqual([]);
  });

  it("registers the Workspace commands with chords that clash with nothing (Cmd+Alt+N, not Cmd+Shift+N which runs.new owns)", () => {
    registerBuiltins();
    registerModules();
    for (const id of ["workspace.open", "workspace.new", "workspace.scan", "workspace.addRepo", "workspace.switch", "workspace.manage", "workspace.rename", "workspace.recolor", "workspace.duplicate", "workspace.close", "workspace.remove"]) expect(getCommand(id), id).toBeDefined();
    expect(shortcutFor("workspace.open")).toBe("Cmd+O");
    expect(shortcutFor("workspace.new")).toBe("Cmd+Alt+N");
    expect(shortcutFor("workspace.addRepo")).toBe("Cmd+Shift+O");
    expect(shortcutFor("workspace.switch")).toBe("Cmd+Alt+O");
    expect(shortcutFor("runs.new")).not.toBe("Cmd+Alt+N");
    expect(shortcutConflicts()).toEqual([]);
  });
});
