import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeDockTab, dockVisible, registerDockTab, setDockOpen } from "../../platform/dock";
import { agentPanelOpen, appMode, registerAgentPanel, registerModeView, resetModes, setAppMode } from "../../platform/mode";
import { installDomStubs } from "../../store/testing-u2";
import { MessageSquare } from "../../ui-kit";
import { chatTabShown, focusChatSearch, openChat, showChat, toggleChat } from "./state";
import AgentWorkspace from "../runs/AgentWorkspace";

installDomStubs();

/** The Agent workspace replaces the editor area, so a dock tab opened there opens behind it: in Agent mode the chat is a panel beside the run. */
beforeEach(() => {
  localStorage.clear();
  registerModeView({ id: "agent", title: "Agent", component: () => null });
  registerDockTab({ id: "chat", title: "Chat", icon: MessageSquare, component: () => null });
  registerAgentPanel({ id: "chat", title: "Team chat", component: (p) => <button type="button" onClick={() => p.onClose?.()}>Fake chat, close</button> });
  setDockOpen(false);
});
afterEach(() => {
  cleanup();
  resetModes();
  setDockOpen(false);
});

describe("showing the chat", () => {
  it("opens the dock tab in the editor and leaves the Agent panel closed", () => {
    expect(appMode()).toBe("editor");
    showChat();
    expect(activeDockTab()?.id).toBe("chat");
    expect(dockVisible()).toBe(true);
    expect(chatTabShown()).toBe(true);
    expect(agentPanelOpen("chat")).toBe(false);
  });

  it("opens the panel beside the run in Agent mode and leaves the dock alone", () => {
    setAppMode("agent");
    showChat();
    expect(agentPanelOpen("chat")).toBe(true);
    expect(chatTabShown()).toBe(true);
    expect(dockVisible()).toBe(false);
  });

  it("opens a conversation from a toast or a search hit in the panel too", () => {
    setAppMode("agent");
    openChat("c_general");
    expect(agentPanelOpen("chat")).toBe(true);
  });

  it("opens the panel for \"Go to conversation\" as well", () => {
    setAppMode("agent");
    focusChatSearch();
    expect(agentPanelOpen("chat")).toBe(true);
  });

  it("toggles the panel from the rail button and the dock from the editor", () => {
    setAppMode("agent");
    toggleChat();
    expect(chatTabShown()).toBe(true);
    toggleChat();
    expect(chatTabShown()).toBe(false);
    setAppMode("editor");
    toggleChat();
    expect(chatTabShown()).toBe(true);
    expect(dockVisible()).toBe(true);
    toggleChat();
    expect(chatTabShown()).toBe(false);
  });

  it("does not count a dock tab that is open behind the Agent workspace as showing", () => {
    showChat(); // editor: the dock opens
    setAppMode("agent");
    expect(chatTabShown()).toBe(false);
  });
});

describe("the Agent workspace's side panel", () => {
  it("draws the panel at the right once it is opened, hands it a close button, and keeps what is next to it mounted", () => {
    setAppMode("agent");
    render(() => <AgentWorkspace />);
    expect(screen.queryByTestId("agent-panel")).toBeNull();
    const sessions = screen.getByText("Sessions");
    showChat();
    const panel = screen.getByTestId("agent-panel");
    expect(panel.getAttribute("aria-label")).toBe("Team chat");
    // the sessions list is the same element: opening a side panel does not reset the run in front of it
    expect(screen.getByText("Sessions")).toBe(sessions);
    fireEvent.click(screen.getByRole("button", { name: "Fake chat, close" }));
    expect(screen.queryByTestId("agent-panel")).toBeNull();
    expect(screen.getByText("Sessions")).toBe(sessions);
  });
});
