import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { availableCommands, resetCommands } from "../../platform/commands";
import { dockTabs } from "../../platform/dock";
import { resetKeymap, shortcutConflicts } from "../../platform/keymap";
import { getRailItem, resetRail } from "../../platform/rail";
import { resetSettings, settingsSections } from "../../platform/settings";
import { getTabType, resetTabs } from "../../platform/tabs";
import { register } from "./index";

afterEach(() => {
  resetCommands();
  resetKeymap();
  resetRail();
  resetSettings();
  resetTabs();
  vi.restoreAllMocks();
});

describe("preview module register()", () => {
  it("adds a tab type, a dock tab, a rail item, a settings section and the palette commands", () => {
    register();
    expect(getTabType("preview")).toMatchObject({ type: "preview", canClose: true });
    expect(dockTabs().some((t) => t.id === "preview")).toBe(true);
    expect(getRailItem("preview")).toMatchObject({ position: "left", order: 70 });
    expect(getRailItem("preview")?.run).toBeTypeOf("function");
    expect(settingsSections().find((s) => s.id === "preview")).toMatchObject({ order: 56 });
    const ids = availableCommands().map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["preview.open", "preview.toggleDock", "preview.openForFile"]));
    expect(shortcutConflicts()).toEqual([]);
  });

  it("offers reload, hard reload and rotate only while a preview is mounted", () => {
    register();
    const ids = () => availableCommands().map((c) => c.id);
    expect(ids()).not.toEqual(expect.arrayContaining(["preview.reload"]));
    expect(ids()).not.toContain("preview.rotate");
  });

  it("costs nothing until a preview is shown: no Ipc call, no timer, no network", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const interval = vi.spyOn(globalThis, "setInterval");
    const calls = [vi.spyOn(ipc.settings, "get"), vi.spyOn(ipc.files, "listDir"), vi.spyOn(ipc.preview, "probe"), vi.spyOn(ipc.preview, "checkUrl")];
    register();
    expect(fetch).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    for (const c of calls) expect(c).not.toHaveBeenCalled();
  });
});
