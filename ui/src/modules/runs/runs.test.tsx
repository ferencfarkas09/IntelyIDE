import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockIpc } from "../../ipc/mock";
import { availableCommands, getCommand, resetCommands } from "../../platform/commands";
import { inspectorPanels, resetInspector } from "../../platform/inspector";
import { agentTabInstance, appMode, modeView, registerModeView, resetModes, setAppMode, showTabInAgent } from "../../platform/mode";
import { openTab, registerTabType, resetTabs, tabs } from "../../platform/tabs";
import { overlays, resetOverlays } from "../../platform/overlay";
import { agentRows, answerPermission, needsYouCount, resetAgents, startAgentStore } from "../../store/agents";
import { installDomStubs } from "../../store/testing-u2";
import { FileText, toast } from "../../ui-kit";
import { AgentTabView } from "./AgentTabView";
import { inbox } from "./inbox";
import { register } from "./index";
import { NeedsYouInbox } from "./NeedsYouInbox";
import { startNotifier, stopNotifier } from "./notifications";
import { SessionsSidebar } from "./SessionsSidebar";
import { setSessionFilter } from "./state";
import { NO_FILTER } from "./sessionsLogic";

installDomStubs();

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

beforeEach(resetAgents);
afterEach(() => {
  cleanup();
  stopNotifier();
  resetAgents();
  resetCommands();
  resetModes();
  resetTabs();
  resetOverlays();
  resetInspector();
  setSessionFilter(NO_FILTER);
  vi.restoreAllMocks();
});

describe("runs module", () => {
  it("registers the Agent workspace, its overlay, an Inspector tab and the palette commands", () => {
    register();
    expect(modeView("agent")?.title).toBe("Agent");
    expect(overlays().map((o) => o.id)).toEqual(["runs"]);
    expect(inspectorPanels().map((p) => p.id)).toEqual(["run"]);
    expect(getCommand("runs.new")?.shortcut).toBe("Mod+Shift+N");
    expect(getCommand("runs.nextNeedsYou")?.shortcut).toBe("Mod+Shift+J");
    expect(appMode()).toBe("editor");
  });

  it("offers Stop and Jump only while there is something to stop or answer", () => {
    register();
    expect(availableCommands().map((c) => c.id).sort()).toEqual(["runs.inbox", "runs.new"]);
  });
});

describe("tool view in the Agent workspace", () => {
  it("shows a tab (history, inspector, review) with a way back to the run, without leaving Agent mode", async () => {
    registerTabType({ type: "note", title: "Note", icon: FileText, canClose: true, component: (p) => <p>body of {p.tab.title}</p> });
    registerModeView({ id: "agent", title: "Agent", component: () => null });
    setAppMode("agent");
    showTabInAgent(openTab({ type: "note", id: "note:1", title: "History" }));
    expect(agentTabInstance()?.id).toBe("note:1");
    render(() => <AgentTabView tab={tabs()[0]} />);
    expect(await screen.findByText("body of History")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to the run" }));
    expect(agentTabInstance()).toBeUndefined();
    expect(appMode()).toBe("agent");
  });
});

describe("Needs-you inbox", () => {
  it("lists the open request, answers it from the inbox and shows the next one", async () => {
    startAgentStore(createMockIpc("agent-permission", { delayScale: 0 }));
    await until(() => inbox().length === 1, "first request");
    expect(needsYouCount()).toBe(1);
    render(() => <NeedsYouInbox />);
    expect(screen.getByText("1 request")).toBeTruthy();
    expect(screen.getByText("Permission needed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await until(() => inbox().length === 1 && inbox()[0].key !== "", "second request");
    expect(screen.getAllByText("Permission needed")).toHaveLength(1);
  });

  it("offers the session allow on a request that carries it, with exactly what it allows, and answers it", async () => {
    startAgentStore(createMockIpc("agent-permission", { delayScale: 0 }));
    await until(() => inbox().length === 1, "first request");
    render(() => <NeedsYouInbox />);
    expect(screen.getByText(/Always in this session: allows file edits inside this run's folders/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow always in this session" }));
    await until(() => inbox().length === 1 && inbox()[0].key !== "", "second request");
    // The command of the second request cannot be allowed for the session: the card offers Allow once only.
    expect(screen.queryByRole("button", { name: "Allow always in this session" })).toBeNull();
    expect(screen.getByText(/can only be allowed once/)).toBeTruthy();
  });

  it("shows the plan approval card, not the generic one, for ExitPlanMode and approves with the picked mode", async () => {
    startAgentStore(createMockIpc("agent-plan", { delayScale: 0 }));
    await until(() => inbox().length === 1, "the plan request");
    render(() => <NeedsYouInbox />);
    expect(screen.getByRole("group", { name: "Plan approval" })).toBeTruthy();
    expect(screen.getByText(/Plan: show prices with the currency/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /^Edit automatically/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    await until(() => inbox().length === 0, "the approval to close");
    await until(() => agentRows().some((r) => r.effective?.permission === "edit"), "the run continues in Edit automatically");
  });

  it("says so when nothing waits", () => {
    render(() => <NeedsYouInbox />);
    expect(screen.getByText("Nothing is waiting for you")).toBeTruthy();
  });
});

describe("sessions sidebar", () => {
  it("groups runs by what the user has to do and filters by role", async () => {
    startAgentStore(createMockIpc("agent-permission", { delayScale: 0 }));
    await until(() => agentRows().length === 3 && needsYouCount() === 1, "runs");
    render(() => <SessionsSidebar />);
    const titles = () => [...document.querySelectorAll(".sessions__group-title")].map((e) => e.textContent);
    expect(titles()).toEqual(["Needs you1", "Ready for review2"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by role" }), { target: { value: "reviewer" } });
    await waitFor(() => expect(titles()).toEqual(["Ready for review1"]));
    expect(screen.getByText("Review the OrderRow change")).toBeTruthy();
  });
});

describe("notifications", () => {
  it("announces each new request once with a toast", async () => {
    const show = vi.spyOn(toast, "show");
    startNotifier();
    startAgentStore(createMockIpc("agent-permission", { delayScale: 0 }));
    await until(() => show.mock.calls.length > 0, "toast");
    expect(show.mock.calls[0][0]).toMatchObject({ title: "developer needs you", tone: "warn" });
    expect(show.mock.calls[0][0].action?.label).toBe("Jump");
    await new Promise((r) => setTimeout(r, 50));
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("does not announce a request that is answered within the settle time", async () => {
    const show = vi.spyOn(toast, "show");
    startNotifier();
    startAgentStore(createMockIpc("agent-permission", { delayScale: 0 }));
    await until(() => inbox().length > 0, "an open request");
    const e = inbox()[0];
    await answerPermission(e.agentId, e.item.reqId, "deny");
    await until(() => inbox().length === 0, "the request to close");
    await new Promise((r) => setTimeout(r, 450));
    expect(show).not.toHaveBeenCalled();
  });
});
