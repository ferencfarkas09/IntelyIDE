import { cleanup, fireEvent, screen, waitFor } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { createMockIpc } from "../../ipc/mock";
import { execute, getCommand, resetCommands } from "../../platform/commands";
import { resetModes } from "../../platform/mode";
import { resetSettings } from "../../platform/settings";
import { closeTab, resetTabs, tabs } from "../../platform/tabs";
import { resetWidgets, widgets } from "../../platform/widgets";
import { agentRows, needsYouCount, resetAgents, selectedAgentId, startAgentStore } from "../../store/agents";
import { setTrayPlanPercent } from "../../store/planUsage";
import { installDomStubs } from "../../store/testing-u2";
import { startTrayBridge, stopTrayBridge } from "../hud/trayBridge";
import { register } from "./index";
import { setRadarApi, type RadarApi } from "./radar/api";
import { mountRadar } from "./radar/mount";
import { DASHBOARD_TAB_ID } from "./open";
import { resetDashboardPrefs, setDashboardEnabled } from "./toggle";

installDomStubs();

const fakeRadar = () => {
  const listeners = new Set<(id: string) => void>();
  const api: RadarApi & { emit: (id: string) => void } = {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    openRun: vi.fn(async () => {}),
    onOpenRun: (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    emit: (id) => listeners.forEach((l) => l(id)),
  };
  return api;
};

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  setRadarApi(undefined);
  resetAgents();
  stopTrayBridge();
  setTrayPlanPercent(null);
  vi.restoreAllMocks();
});

describe("Needs-You radar window", () => {
  it("mounts only the radar and answers from the same cards as the inbox", async () => {
    const radar = fakeRadar();
    setRadarApi(radar);
    const root = document.createElement("div");
    document.body.append(root);
    // the radar starts the agent store itself (idempotent): start it first with the scenario that has a waiting permission
    startAgentStore(createMockIpc("agent-permission", { delayScale: 0 }));
    const dispose = mountRadar(root);
    expect(screen.getByTestId("radar")).toBeTruthy();
    expect(document.querySelector('[data-testid="shell"]')).toBeNull();
    await waitFor(() => expect(needsYouCount()).toBe(1));
    expect(await screen.findByRole("heading", { name: "Needs you (1)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open run" }));
    const waiting = agentRows().find((r) => r.status === "needsYou")!;
    expect(radar.openRun).toHaveBeenCalledWith(waiting.agentId);
    fireEvent.click(screen.getByRole("button", { name: "Close the radar" }));
    expect(radar.close).toHaveBeenCalled();
    dispose();
  });

  it("says when nothing waits", async () => {
    setRadarApi(fakeRadar());
    const client = createMockIpc("agent-normal", { delayScale: 0 });
    client.agentList = async () => [];
    startAgentStore(client);
    const root = document.createElement("div");
    document.body.append(root);
    const dispose = mountRadar(root);
    expect(await screen.findByText("Nothing waits on you", { selector: ".ui-empty *" })).toBeTruthy();
    dispose();
  });
});

describe("module registration", () => {
  afterEach(() => {
    resetDashboardPrefs();
    resetWidgets();
    resetTabs();
    resetCommands();
    resetSettings();
    resetModes();
  });

  it("registers the tab, the commands and the cards while the extra is on, and the radar opens a run in the main window", async () => {
    const radar = fakeRadar();
    setRadarApi(radar);
    const dispose = createRoot((d) => (register(), d));
    expect(widgets().map((w) => w.id)).toEqual(["pulse", "burn", "repos", "tips", "servers", "prs", "sentry", "chat", "brief"]);
    expect(await execute("dashboard.open")).toBe(true);
    expect(tabs().map((t) => t.id)).toContain(DASHBOARD_TAB_ID);
    await execute("dashboard.radar");
    expect(radar.open).toHaveBeenCalled();
    startAgentStore(createMockIpc("agent-normal", { delayScale: 0 }));
    await waitFor(() => expect(agentRows().length).toBeGreaterThan(0));
    radar.emit(agentRows()[1].agentId);
    await waitFor(() => expect(selectedAgentId()).toBe(agentRows()[1].agentId));
    setDashboardEnabled(false);
    expect(getCommand("dashboard.open")).toBeUndefined();
    expect(widgets()).toEqual([]);
    expect(tabs().some((t) => t.id === DASHBOARD_TAB_ID)).toBe(false);
    closeTab(DASHBOARD_TAB_ID);
    dispose();
  });
});

describe("menu-bar bridge", () => {
  it("sends the plan percentage only when it is known", async () => {
    const update = vi.spyOn(ipc.tray, "update").mockResolvedValue(undefined);
    const dispose = createRoot((d) => (startTrayBridge(), d));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls.at(-1)![0]).toMatchObject({ running: 0, needsYou: 0, planPercent: null });
    setTrayPlanPercent(41.6);
    await waitFor(() => expect(update.mock.calls.at(-1)![0]).toMatchObject({ planPercent: 42 }));
    dispose();
  });
});
