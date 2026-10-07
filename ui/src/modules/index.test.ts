import { describe, expect, it, vi } from "vitest";
import { MODULES, registerModules } from "./index";

describe("registerModules", () => {
  it("lists every feature module of the alpha", () => {
    expect(MODULES.map((m) => m.id)).toEqual(["editor", "terminal", "search", "branches", "graph", "roles", "runs", "run", "inspector", "settings-core", "providers", "mcp", "integrations", "mongo", "happy-timer", "happy-meet", "happy-notifications", "happy-tasks", "happy-chat", "attachments", "preview", "preview-inspect", "l10n", "release", "remote", "viewers", "hud", "checks", "hygiene", "contract", "pr", "history", "brief", "licenses", "updates", "usage"]);
  });

  it("registers all modules and reports none failed", () => {
    expect(registerModules()).toEqual([]);
  });

  it("logs a throwing module and still registers the rest", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    const failed = registerModules([
      { id: "bad", register: () => { throw new Error("boom"); } },
      { id: "good", register: after },
    ]);
    expect(failed.map((f) => f.id)).toEqual(["bad"]);
    expect(after).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
