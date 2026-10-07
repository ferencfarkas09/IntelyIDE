import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { createMockIpc } from "../../ipc/mock";
import { delegationEvents } from "./delegationFixture";
import { agentTabInstance, appMode, registerModeView, resetModes, setAppMode, showTabInAgent, visibleTab } from "../../platform/mode";
import { resetTabs, tabs } from "../../platform/tabs";
import { resetAgents, startAgentStore } from "../../store/agents";
import { loadWorkspace } from "../../store/workspace";
import History, { resetHistoryFilters } from "./history/History";
import Inspector, { resetInspectorPanes } from "./Inspector";
import { openHistory, openInspector } from "./openers";
import { resetRunLogs } from "./runEvents";
import { RewindDialog } from "./rewind/RewindDialog";
import ReviewTab from "./review/ReviewTab";
import { resetReviewStates } from "./review/reviewState";
import { register } from "./index";
import { getRailItem } from "../../platform/rail";

const tab = (runId: string, extra: Record<string, unknown> = {}) => ({ id: `inspector:${runId}`, type: "inspector", title: runId, params: { runId, repoIds: ["admin", "backend"], title: "Show prices with the currency", role: "developer", ...extra } });

// The suite runs while the machine is busy: transforming the lazy modules can take seconds.
configure({ asyncUtilTimeout: 15000 });

beforeEach(async () => {
  // jsdom has no ResizeObserver, which the kit's SegmentedControl uses.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  register();
  await loadWorkspace(createMockIpc("normal", { delayScale: 0 }));
});
afterEach(() => {
  cleanup();
  resetTabs();
  resetRunLogs();
  resetReviewStates();
  resetAgents();
  resetHistoryFilters();
  resetInspectorPanes();
});

describe("<Inspector>", () => {
  it("shows the tool timeline with the subagent tree, then the files, session facts and issues", async () => {
    render(() => <Inspector tab={tab("run-dev")} />);
    const timeline = await screen.findByRole("list", { name: "Tool timeline" });
    expect(within(timeline).getByText("Task")).toBeTruthy();
    expect(within(timeline).getByText("2 nested")).toBeTruthy();
    expect(within(timeline).getAllByRole("img", { name: "Failed" })).toHaveLength(1);
    expect(screen.getByText("Tool calls").nextSibling?.textContent).toBe("8 · 1 failed");

    fireEvent.click(screen.getByRole("radio", { name: /Files/ }));
    const files = screen.getByRole("list", { name: "Files touched by the run" });
    expect(within(files).getAllByRole("listitem")).toHaveLength(3);
    expect(within(files).getByText("new")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Session" }));
    expect(screen.getByText("github · connected")).toBeTruthy();
    expect(screen.getByText("PreToolUse: agent-gate")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /Issues/ }));
    expect(screen.getByText("Throttled by the provider")).toBeTruthy();
    expect(screen.getByText("Connection problem")).toBeTruthy();
  });

  it("collapses a subagent", async () => {
    render(() => <Inspector tab={tab("run-dev")} />);
    const timeline = await screen.findByRole("list", { name: "Tool timeline" });
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: /Collapse Task/ }));
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(6);
  });

  it("says the transcript expired for a run whose log is gone", async () => {
    render(() => <Inspector tab={tab("run-old")} />);
    expect(await screen.findByText("Transcript expired")).toBeTruthy();
  });

  it("opens the review tab for a run that changed files", async () => {
    render(() => <Inspector tab={tab("run-dev")} />);
    await screen.findByRole("list", { name: "Tool timeline" });
    fireEvent.click(screen.getByRole("button", { name: "Review run" }));
    expect(tabs().map((t) => t.type)).toContain("review");
  });
});

describe("<Inspector> roles of an Auto run", () => {
  const open = async () => {
    vi.spyOn(ipc, "agentHistory").mockResolvedValue(delegationEvents());
    render(() => <Inspector tab={tab("run-auto", { role: "auto" })} />);
    return await screen.findByRole("list", { name: "Tool timeline" });
  };
  afterEach(() => vi.restoreAllMocks());

  it("shows a role chip with the model on every call a delegate made, and on its Agent call", async () => {
    const timeline = within(await open());
    const chips = timeline.getAllByTitle(/^(researcher|developer|reviewer) · claude-/);
    expect(chips.map((c) => c.textContent)).toEqual(expect.arrayContaining(["researcherHaiku 4.5", "developerSonnet 5.5", "reviewerSonnet 5.5"]));
    // Agent call + its two calls for the researcher
    expect(timeline.getAllByTitle("researcher · claude-haiku-4-5-20251001")).toHaveLength(3);
  });

  it("names who refused a call, by which rule and in which role", async () => {
    const timeline = within(await open());
    expect(timeline.getByText("Refused by the role's limits in role researcher (role.read-only)")).toBeTruthy();
    expect(timeline.getAllByRole("img", { name: "Denied" })).toHaveLength(1);
  });

  it("lists the roles of the run with their models, permissions, calls and refused calls, and the cost per model", async () => {
    await open();
    fireEvent.click(screen.getByRole("radio", { name: "Session" }));
    const roles = within(screen.getByRole("region", { name: "Roles in this run" }));
    const researcher = within(roles.getByRole("row", { name: /researcher/ }));
    expect(researcher.getByText("Haiku 4.5")).toBeTruthy();
    expect(researcher.getByText("Read-only")).toBeTruthy();
    expect(researcher.getAllByRole("cell").map((c) => c.textContent)).toEqual(["Haiku 4.5", "Read-only", "2", "1"]);
    expect(roles.getByText("Roles as of this session start.")).toBeTruthy();
    const cost = within(screen.getByRole("region", { name: "Cost by model" }));
    expect(cost.getAllByRole("row")).toHaveLength(3);
    expect(cost.getByText("Sonnet 5.5")).toBeTruthy();
    expect(cost.getByText("Haiku 4.5")).toBeTruthy();
    expect(cost.getByText("The provider reports cost per model, not per role.")).toBeTruthy();
  });

  it("reports a model mismatch as an issue", async () => {
    await open();
    fireEvent.click(screen.getByRole("radio", { name: /Issues/ }));
    expect(screen.getByText("reviewer ran on Opus 5.5, but its role says Sonnet 5.5.")).toBeTruthy();
  });

  it("says a run without roles had none", async () => {
    render(() => <Inspector tab={tab("run-dev")} />);
    await screen.findByRole("list", { name: "Tool timeline" });
    fireEvent.click(screen.getByRole("radio", { name: "Session" }));
    expect(screen.getByText("This run had no roles.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Cost by model" })).toBeNull();
  });
});

describe("<History>", () => {
  it("lists finished runs, narrows them by search and filters, and blocks resume for an expired transcript", async () => {
    render(() => <History />);
    expect(await screen.findAllByRole("listitem")).toHaveLength(5);
    const expired = screen.getByText("Where is the invoice number generated?").closest("li")!;
    expect(within(expired).getByText("Transcript expired")).toBeTruthy();
    expect(within(expired).getByRole("button", { name: "Resume" }).getAttribute("disabled")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "reviewer" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    fireEvent.input(screen.getByRole("textbox", { name: "Search runs" }), { target: { value: "no blocking" } });
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(screen.getByText("Review the OrderRow change")).toBeTruthy();

    fireEvent.input(screen.getByRole("textbox", { name: "Search runs" }), { target: { value: "zzz-nothing" } });
    expect(await screen.findByText("No run matches")).toBeTruthy();
  });

  it("opens the inspector for a row", async () => {
    render(() => <History />);
    fireEvent.click(await screen.findByText("Review the OrderRow change"));
    expect(tabs().find((t) => t.type === "inspector")?.params).toMatchObject({ runId: "run-rev", role: "reviewer" });
  });

  it("resumes a run", async () => {
    render(() => <History client={createMockIpc("normal", { delayScale: 0 })} />);
    const row = (await screen.findByText("Review the OrderRow change")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(within(row).getByRole("button", { name: "Resume" }).getAttribute("aria-busy")).toBeNull());
  });
});

describe("<RewindDialog>", () => {
  it("lists the dry run and restores only after the repo name was typed exactly", async () => {
    const client = createMockIpc("normal", { delayScale: 0 });
    let restored = 0;
    render(() => <RewindDialog open onClose={() => {}} runId="run-dev" runActive={false} client={client} onRestored={() => restored++} />);
    const snaps = within(await screen.findByRole("radiogroup", { name: "Snapshots" })).getAllByRole("radio");
    expect(snaps).toHaveLength(2);
    fireEvent.click(snaps[0]);
    expect(await screen.findByText(/Dry run: these 2 files would change/)).toBeTruthy();
    const restore = screen.getByRole("button", { name: /Restore 2 files/ });
    expect(restore.getAttribute("disabled")).not.toBeNull();

    const typed = screen.getByRole("textbox", { name: "Confirm the rewind" });
    fireEvent.input(typed, { target: { value: "Admin" } });
    expect(restore.getAttribute("disabled")).not.toBeNull();
    fireEvent.input(typed, { target: { value: "admin" } });
    expect(restore.getAttribute("disabled")).toBeNull();
    fireEvent.click(restore);
    expect(await screen.findByText("Restored 2 files.")).toBeTruthy();
    expect(restored).toBe(1);
  });

  it("refuses while the run is still working", async () => {
    render(() => <RewindDialog open onClose={() => {}} runId="run-dev" runActive client={createMockIpc("normal", { delayScale: 0 })} />);
    expect(await screen.findByText(/still working/)).toBeTruthy();
    fireEvent.click(within(await screen.findByRole("radiogroup", { name: "Snapshots" })).getAllByRole("radio")[0]);
    await screen.findByText(/Dry run/);
    expect(screen.getByRole("button", { name: /Restore/ }).getAttribute("disabled")).not.toBeNull();
  });

  it("shows an empty state for a run without snapshots", async () => {
    render(() => <RewindDialog open onClose={() => {}} runId="run-rev" runActive={false} client={createMockIpc("normal", { delayScale: 0 })} />);
    expect(await screen.findByText("No snapshots for this run")).toBeTruthy();
  });
});

describe("<ReviewTab>", () => {
  it("shows the run's hunks and counts the ones marked for revert; a created file cannot be reverted", async () => {
    render(() => <ReviewTab tab={{ ...tab("run-dev"), type: "review" }} />);
    expect(await screen.findByText(/3 files · 4 hunks · 0 to revert/)).toBeTruthy();
    const table = document.getElementById("rev-admin-src/components/modules/orders/OrdersTable.tsx")!;
    const hunks = table.querySelectorAll(".rev-hunk");
    expect(hunks).toHaveLength(2);
    fireEvent.click(within(hunks[0] as HTMLElement).getByRole("radio", { name: "Revert" }));
    expect(screen.getByText(/1 to revert/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply 1 revert" })).toBeTruthy();

    const created = document.getElementById("rev-backend-src/api/services/loyaltyService.js")!;
    expect(within(created as HTMLElement).getByRole("radio", { name: "Revert" }).getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Keep all" }));
    expect(screen.getByText(/0 to revert/)).toBeTruthy();
  });

  it("reports a file that cannot be written instead of failing silently", async () => {
    render(() => <ReviewTab tab={{ ...tab("run-dev"), type: "review" }} />);
    await screen.findByText(/3 files/);
    fireEvent.click(screen.getByRole("button", { name: "Revert all" }));
    fireEvent.click(screen.getByRole("button", { name: /Apply 3 reverts/ }));
    const result = await screen.findByRole("list", { name: "Apply result" });
    expect(within(result).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(result.querySelector('[data-status="failed"]')).toBeTruthy();
  });

  it("starts the reviewer agent and lists its findings, annotating the hunk line", async () => {
    startAgentStore(createMockIpc("normal", { delayScale: 0 }));
    render(() => <ReviewTab tab={{ ...tab("run-dev"), type: "review" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Run reviewer agent" }));
    const panel = await screen.findByRole("region", { name: "Reviewer findings" }, { timeout: 8000 });
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(3), { timeout: 8000 });
    expect(within(panel).getByText(/does not exist on/)).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll(".rev-note--inline").length).toBeGreaterThan(0));
  });
});

describe("module registration", () => {
  it("registers the inspector, history and review tab types and opens them", () => {
    openInspector({ runId: "r1", title: "A run" });
    openHistory();
    expect(tabs().map((t) => t.type)).toEqual(["inspector", "history"]);
    expect(tabs()[0].id).toBe("inspector:r1");
    openInspector({ runId: "r1", title: "A run" });
    expect(tabs()).toHaveLength(2);
  });

  it("opens in the middle of the Agent workspace without flipping the mode, and the Run history button follows what is on screen", () => {
    registerModeView({ id: "agent", title: "Agent", component: () => null });
    setAppMode("agent");
    const historyButton = getRailItem("history")!;

    openHistory();
    expect(appMode()).toBe("agent");
    expect(agentTabInstance()?.id).toBe("history");
    expect(visibleTab()?.type).toBe("history");
    expect(historyButton.pressed?.()).toBe(true);

    openInspector({ runId: "r1", title: "A run" });
    expect(appMode()).toBe("agent");
    expect(agentTabInstance()?.id).toBe("inspector:r1");
    expect(historyButton.pressed?.()).toBe(false);

    // Back to the run: the tab stays in the tab store, but nothing on screen shows it.
    showTabInAgent(null);
    expect(agentTabInstance()).toBeUndefined();
    expect(tabs().map((t) => t.id)).toEqual(["history", "inspector:r1"]);

    // After leaving Agent mode, the editor area's active tab decides (the last one opened), not a stale highlight.
    setAppMode("editor");
    expect(visibleTab()?.id).toBe("inspector:r1");
    expect(historyButton.pressed?.()).toBe(false);
    resetModes();
  });
});
