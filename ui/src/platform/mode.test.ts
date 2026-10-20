import { afterEach, describe, expect, it } from "vitest";
import { agentPanelId, agentPanelOpen, appMode, closeAgentPanel, modeView, openAgentPanel, registerAgentPanel, registerModeView, resetModes, setAppMode, toggleAgentPanel } from "./mode";

afterEach(() => (resetModes(), localStorage.clear()));

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

describe("agent side panels", () => {
  const chat = (when?: () => boolean) => registerAgentPanel({ id: "chat", title: "Chat", component: () => null, when });

  it("shows a registered panel only in Agent mode", () => {
    registerModeView({ id: "agent", title: "Agent", component: () => null });
    chat();
    openAgentPanel("chat");
    expect(agentPanelId()).toBeNull(); // the editor is showing: nothing is docked beside a run
    setAppMode("agent");
    expect(agentPanelId()).toBe("chat");
    expect(agentPanelOpen("chat")).toBe(true);
    setAppMode("editor");
    expect(agentPanelOpen("chat")).toBe(false);
  });

  it("toggles, closes, and ignores an id nobody registered", () => {
    registerModeView({ id: "agent", title: "Agent", component: () => null });
    setAppMode("agent");
    chat();
    toggleAgentPanel("chat");
    expect(agentPanelOpen("chat")).toBe(true);
    toggleAgentPanel("chat");
    expect(agentPanelOpen("chat")).toBe(false);
    openAgentPanel("nope");
    expect(agentPanelId()).toBeNull();
    openAgentPanel("chat");
    closeAgentPanel();
    expect(agentPanelId()).toBeNull();
  });

  it("treats the panel as closed while the thing it shows is off, and remembers the choice across a reload", () => {
    registerModeView({ id: "agent", title: "Agent", component: () => null });
    setAppMode("agent");
    let on = false;
    chat(() => on);
    openAgentPanel("chat");
    expect(agentPanelId()).toBeNull();
    on = true;
    expect(agentPanelId()).toBe("chat"); // not reactive here, but read afresh each time
    expect(localStorage.getItem("intely.layout.agentPanel")).toBe("chat");
    closeAgentPanel();
    expect(localStorage.getItem("intely.layout.agentPanel")).toBe("");
  });
});
