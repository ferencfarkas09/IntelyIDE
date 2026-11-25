import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { createMockIpc } from "../../ipc/mock";
import { registerCommand, resetCommands } from "../../platform/commands";
import { resetWidgets } from "../../platform/widgets";
import { agentRows, resetAgents, startAgentStore } from "../../store/agents";
import { installDomStubs } from "../../store/testing-u2";
import { resetAutotestStore, setRepoResult } from "../autotest/store";
import { setAutotestEnabled } from "../autotest/toggle";
import { createMockUsage, setUsageApi } from "../usage/api";
import { refreshUsage, resetUsage } from "../usage/store";
import Dashboard from "./Dashboard";

installDomStubs();

afterEach(async () => {
  cleanup();
  resetAgents();
  resetUsage();
  setUsageApi(undefined);
  resetAutotestStore();
  setAutotestEnabled(true);
  resetWidgets();
  resetCommands();
  localStorage.clear();
  await setLocale("en", { persist: false });
});

const tiles = () => screen.queryByTestId("dash-tiles");
const tile = (label: string) => within(tiles()!).getByText(label).closest(".ui-kpi") as HTMLElement;

describe("dashboard heading and tiles", () => {
  it("shows no tile while no source has anything to say, and the heading says so", () => {
    render(() => <Dashboard />);
    expect(tiles()).toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Today in this workspace");
    expect(screen.getByTestId("dash-summary").textContent).toBe("Looking at your runs…");
  });

  it("counts what waits for the person, with the reason in the Needs you tile", async () => {
    startAgentStore(createMockIpc("agent-permission", { delayScale: 0 }));
    render(() => <Dashboard />);
    await vi.waitFor(() => expect(tile("Needs you").dataset.tone).toBe("warn"));
    const needs = tile("Needs you");
    expect(needs.querySelector(".ui-kpi__value")!.textContent).toBe("1");
    const hint = needs.querySelector<HTMLElement>(".ui-kpi__hint")!;
    expect(hint.dataset.tone).toBe("warn");
    expect(hint.textContent!.length).toBeGreaterThan(3);
    expect(tile("Ready for review").dataset.tone).toBeUndefined();
    expect(screen.getByTestId("dash-summary").textContent).toMatch(/^1 run is waiting for you/);
    // the plan and the tests have nothing yet: their tiles are not there
    expect(within(tiles()!).queryByText("Weekly plan used")).toBeNull();
    expect(within(tiles()!).queryByText("Unit tests after runs")).toBeNull();
  });

  it("says when nothing waits", async () => {
    const client = createMockIpc("agent-normal", { delayScale: 0 });
    client.agentList = async () => [];
    startAgentStore(client);
    render(() => <Dashboard />);
    await vi.waitFor(() => expect(screen.getByTestId("dash-summary").textContent).toBe("Nothing is waiting for you."));
    expect(tile("Needs you").dataset.tone).toBeUndefined();
    expect(tile("Needs you").textContent).toContain("Nothing is waiting");
    expect(tile("Ready for review").textContent).toContain("No run is working");
  });

  it("shows the weekly plan window once the usage store has read it", async () => {
    setUsageApi(createMockUsage(Date.now()));
    render(() => <Dashboard />);
    expect(tiles()).toBeNull();
    await refreshUsage(true);
    const week = tile("Weekly plan used");
    expect(week.querySelector(".ui-kpi__value")!.textContent).toBe("15%");
    expect(within(week).getByRole("progressbar", { name: "15 percent of the weekly plan used" }).getAttribute("aria-valuenow")).toBe("15");
  });

  it("leaves the weekly tile out when the plan cannot be read", async () => {
    setUsageApi({ report: createMockUsage(Date.now()).report, limits: async () => ({ available: false, reason: "notSignedIn" }) });
    render(() => <Dashboard />);
    await refreshUsage(true);
    expect(tiles()).toBeNull();
  });

  it("tallies the unit tests after runs and names the failing repository", async () => {
    startAgentStore(createMockIpc("agent-normal", { delayScale: 0 }));
    render(() => <Dashboard />);
    await vi.waitFor(() => expect(agentRows().length).toBeGreaterThan(0));
    const runId = agentRows()[0].agentId;
    const summary = (failed: number) => ({ runner: "vitest" as const, matched: true, passed: 10, failed, skipped: 0, failures: [] });
    setRepoResult(runId, { repoId: "web", status: "passed", summary: summary(0), finishedAt: 1 });
    setRepoResult(runId, { repoId: "orders-api", status: "failed", summary: summary(2), finishedAt: 2 });
    setRepoResult(runId, { repoId: "docs", status: "running" });
    const tests = tile("Unit tests after runs");
    expect(tests.querySelector(".ui-kpi__value")!.textContent).toBe("1 of 2");
    const hint = tests.querySelector<HTMLElement>(".ui-kpi__hint")!;
    expect(hint.textContent).toBe("orders-api has 2 failing");
    expect(hint.dataset.tone).toBe("danger");
    // the extra switched off: the tile goes away with it
    setAutotestEnabled(false);
    expect(within(tiles()!).queryByText("Unit tests after runs")).toBeNull();
  });

  it("New run runs the runs.new command, and leaves the header while the layout is edited", () => {
    const opened = vi.fn();
    registerCommand({ id: "runs.new", title: "New run", group: "Agents", run: opened });
    render(() => <Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    expect(opened).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Edit layout" }));
    expect(screen.queryByRole("button", { name: "New run" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reset layout" })).toBeTruthy();
  });

  it("pluralises the summary in Hungarian too", async () => {
    await setLocale("hu", { persist: false });
    startAgentStore(createMockIpc("agent-permission", { delayScale: 0 }));
    render(() => <Dashboard />);
    await vi.waitFor(() => expect(screen.getByTestId("dash-summary").textContent).toMatch(/^1 futás vár rád/));
  });
});
