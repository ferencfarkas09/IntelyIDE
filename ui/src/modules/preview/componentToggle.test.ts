import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { availableCommands, resetCommands } from "../../platform/commands";
import { resetKeymap, shortcutConflicts } from "../../platform/keymap";
import { resetRail } from "../../platform/rail";
import { resetSettings } from "../../platform/settings";
import { getTabType, resetTabs } from "../../platform/tabs";
import { register } from "./index";
import { setComponentPreviewEnabled } from "./toggle";

beforeEach(() => {
  setComponentPreviewEnabled(true);
});

afterEach(() => {
  resetCommands();
  resetKeymap();
  resetRail();
  resetSettings();
  resetTabs();
  setComponentPreviewEnabled(true);
  vi.restoreAllMocks();
});

const ids = () => availableCommands().map((c) => c.id);

describe("component preview toggle (Settings > Preview)", () => {
  it("is on by default: a tab type and the palette command exist", () => {
    register();
    expect(getTabType("preview-component")).toMatchObject({ type: "preview-component", canClose: true });
    expect(ids()).toContain("preview.component");
    expect(shortcutConflicts()).toEqual([]);
  });

  it("registers nothing while off, and switching it off removes what it added", async () => {
    setComponentPreviewEnabled(false);
    register();
    expect(getTabType("preview-component")).toBeUndefined();
    expect(ids()).not.toContain("preview.component");
    expect(ids()).toContain("preview.open"); // the page preview itself is not affected
    setComponentPreviewEnabled(true);
    await Promise.resolve();
    expect(getTabType("preview-component")).toBeDefined();
    expect(ids()).toContain("preview.component");
    setComponentPreviewEnabled(false);
    await Promise.resolve();
    expect(getTabType("preview-component")).toBeUndefined();
    expect(ids()).not.toContain("preview.component");
  });

  it("loads no component code and starts no process at register time", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    register();
    expect(fetch).not.toHaveBeenCalled();
  });
});
