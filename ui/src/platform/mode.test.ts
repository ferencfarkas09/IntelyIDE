import { afterEach, describe, expect, it } from "vitest";
import { appMode, modeView, registerModeView, resetModes, setAppMode } from "./mode";

afterEach(() => resetModes());

describe("app mode", () => {
  it("stays on the editor until a module registers the agent workspace", () => {
    setAppMode("agent");
    expect(appMode()).toBe("editor");
    registerModeView({ id: "agent", title: "Agent", component: () => null });
    expect(modeView("agent")?.title).toBe("Agent");
    expect(appMode()).toBe("agent");
  });

  it("switches back to the editor", () => {
    registerModeView({ id: "agent", title: "Agent", component: () => null });
    setAppMode("agent");
    setAppMode("editor");
    expect(appMode()).toBe("editor");
  });
});
