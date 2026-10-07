import { afterEach, describe, expect, it } from "vitest";
import { getCommand, resetCommands } from "../../platform/commands";
import { resetKeymap } from "../../platform/keymap";
import { overlays } from "../../platform/overlay";
import { railItems, resetRail } from "../../platform/rail";
import { register } from "./index";

afterEach(() => {
  resetCommands();
  resetKeymap();
  resetRail();
});

describe("preview-inspect register()", () => {
  it("adds one overlay and one command, and nothing that costs anything while idle", () => {
    const before = overlays().length;
    register();
    expect(overlays().length).toBe(before + 1);
    expect(overlays().some((o) => o.id === "preview-inspect")).toBe(true);
    expect(getCommand("preview.inspect.toggle")).toBeDefined();
    expect(railItems().some((r) => r.id.includes("inspect"))).toBe(false);
  });
});
