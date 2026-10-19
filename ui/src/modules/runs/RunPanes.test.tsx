import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ipc } from "../../ipc";
import { createMockIpc } from "../../ipc/mock";
import { capsOfProvider } from "../../ipc/providerCaps";
import { resetModes } from "../../platform/mode";
import { resetTabs } from "../../platform/tabs";
import { agentRow, agentRows, resetAgents, selectAgent, selectedAgentId, startAgentStore } from "../../store/agents";
import type { AgentEvent, AgentSummary } from "../../store/agent-types";
import { installDomStubs } from "../../store/testing-u2";
import AgentWorkspace from "./AgentWorkspace";
import { resetClosed } from "./closed";
import { PANE_MIME, RUN_MIME } from "./paneDnd";
import { PANES_KEY, paneState, reloadPanes, resetPanes, setCentreWidth, setWindowWidth } from "./panes";
import { setCentreView, setSessionFilter } from "./state";
import { NO_FILTER } from "./sessionsLogic";

installDomStubs();

const NOW = Date.now();
const summary = (id: string, over: Partial<AgentSummary> = {}): AgentSummary =>
  ({
    agentId: id,
    provider: "claude",
    role: "developer",
    model: "claude-sonnet-5-5",
    title: `Run ${id}`,
    status: "running",
    permission: "edit",
    requested: { permission: "edit" },
    repoIds: ["admin"],
    caps: capsOfProvider("claude"),
    enforcement: "bestEffort",
    startedAt: NOW,
    ...over,
  }) as AgentSummary;

const RUNS = [summary("r1"), summary("r2"), summary("r3", { status: "done" }), summary("r4", { status: "done" })];

function ipcWith(runs: AgentSummary[] = RUNS): { ipc: Ipc; push: (events: AgentEvent[]) => void } {
  let sink: ((events: AgentEvent[]) => void) | undefined;
  const base = createMockIpc("normal", { delayScale: 0 });
  const ipc = { ...base, agentList: async () => structuredClone(runs), agentHistory: async () => [], onAgentEvents: (cb: (events: AgentEvent[]) => void) => ((sink = cb), () => (sink = undefined)) } as Ipc;
  return { ipc, push: (events) => sink?.(events) };
}

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

const panes = () => screen.queryAllByTestId("run-pane");
const pane = (i: number) => panes()[i]!;
const layoutButton = (name: string) => screen.getByRole("radio", { name });
const listRow = (title: string) => screen.getByTitle(new RegExp(`^${title}`));
const drag = (types: string[], data: Record<string, string>) => ({ dataTransfer: { types, getData: (m: string) => data[m] ?? "", setData: vi.fn(), dropEffect: "", effectAllowed: "" } });

async function start(runs?: AgentSummary[]) {
  const h = ipcWith(runs);
  startAgentStore(h.ipc);
  render(() => <AgentWorkspace />);
  await until(() => agentRows().length > 0, "runs");
  await until(() => selectedAgentId() !== null, "a selected run");
  return h;
}

beforeEach(() => {
  localStorage.clear();
  resetAgents();
  resetPanes();
  resetClosed();
  setCentreView("run");
});
afterEach(() => {
  cleanup();
  resetAgents();
  resetPanes();
  resetModes();
  resetTabs();
  setSessionFilter(NO_FILTER);
  setCentreView("run");
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("run panes in the Agent workspace", () => {
  it("starts with the single view and offers the six layouts", async () => {
    await start();
    expect(panes()).toHaveLength(0);
    expect(screen.getByTestId("agent-run")).toBeTruthy();
    const group = screen.getByRole("radiogroup", { name: "Pane layout" });
    expect(within(group).getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual([
      "One pane",
      "Two panes side by side",
      "Three panes side by side",
      "Two panes stacked",
      "Three panes stacked",
      "Four panes in a grid",
    ]);
    expect(layoutButton("One pane").getAttribute("aria-checked")).toBe("true");
  });

  it("tiles the layouts and keeps the run that was open in the first pane", async () => {
    await start();
    const open = selectedAgentId()!;
    for (const [name, count, layout] of [["Two panes side by side", 2, "2h"], ["Three panes side by side", 3, "3h"], ["Two panes stacked", 2, "2v"], ["Three panes stacked", 3, "3v"], ["Four panes in a grid", 4, "grid"]] as const) {
      fireEvent.click(layoutButton(name));
      await waitFor(() => expect(panes()).toHaveLength(count));
      expect(screen.getByTestId("panes").getAttribute("data-layout")).toBe(layout);
      expect(within(pane(0)).getByTestId("pane-run").getAttribute("data-run")).toBe(open);
      expect(screen.queryByTestId("agent-run")).toBeNull();
    }
    fireEvent.click(layoutButton("One pane"));
    await waitFor(() => expect(panes()).toHaveLength(0));
    expect(screen.getByTestId("agent-run")).toBeTruthy();
  });

  it("puts a clicked run in the focused pane, and only focuses a pane that already shows it", async () => {
    await start();
    fireEvent.click(layoutButton("Two panes side by side"));
    await waitFor(() => expect(panes()).toHaveLength(2));
    const first = selectedAgentId()!;
    fireEvent.pointerDown(pane(1));
    await waitFor(() => expect(pane(1).hasAttribute("data-focused")).toBe(true));
    expect(selectedAgentId()).toBeNull();
    fireEvent.click(listRow("Run r3"));
    await waitFor(() => expect(within(pane(1)).getByTestId("pane-run").getAttribute("data-run")).toBe("r3"));
    expect(within(pane(0)).getByTestId("pane-run").getAttribute("data-run")).toBe(first);
    fireEvent.click(listRow(`Run ${first}`));
    await waitFor(() => expect(pane(0).hasAttribute("data-focused")).toBe(true));
    expect(within(pane(1)).getByTestId("pane-run").getAttribute("data-run")).toBe("r3");
    expect(selectedAgentId()).toBe(first);
  });

  it("focuses a pane from the keyboard and the selection follows the focused pane", async () => {
    await start();
    fireEvent.click(layoutButton("Two panes side by side"));
    await waitFor(() => expect(panes()).toHaveLength(2));
    fireEvent.pointerDown(pane(1));
    fireEvent.click(listRow("Run r4"));
    await waitFor(() => expect(selectedAgentId()).toBe("r4"));
    fireEvent.focusIn(within(pane(0)).getByTestId("pane-run"));
    await waitFor(() => expect(selectedAgentId()).not.toBe("r4"));
    expect(pane(0).hasAttribute("data-focused")).toBe(true);
    expect(pane(1).hasAttribute("data-focused")).toBe(false);
  });

  it("gives every pane its own composer", async () => {
    await start();
    fireEvent.click(layoutButton("Two panes side by side"));
    await waitFor(() => expect(panes()).toHaveLength(2));
    fireEvent.pointerDown(pane(1));
    fireEvent.click(listRow("Run r3"));
    await waitFor(() => expect(screen.getAllByTestId("composer")).toHaveLength(2));
    const areas = screen.getAllByLabelText("Message to the agent");
    fireEvent.input(areas[0]!, { target: { value: "left" } });
    fireEvent.input(areas[1]!, { target: { value: "right" } });
    expect((areas[0] as HTMLTextAreaElement).value).toBe("left");
    expect((areas[1] as HTMLTextAreaElement).value).toBe("right");
  });

  it("drops a run from the list into a pane and swaps two panes by their headers", async () => {
    await start();
    fireEvent.click(layoutButton("Two panes side by side"));
    await waitFor(() => expect(panes()).toHaveLength(2));
    const first = within(pane(0)).getByTestId("pane-run").getAttribute("data-run")!;
    fireEvent.dragOver(pane(1), drag([RUN_MIME], {}));
    expect(pane(1).hasAttribute("data-over")).toBe(true);
    fireEvent.drop(pane(1), drag([RUN_MIME], { [RUN_MIME]: "r4" }));
    await waitFor(() => expect(within(pane(1)).getByTestId("pane-run").getAttribute("data-run")).toBe("r4"));
    expect(pane(1).hasAttribute("data-over")).toBe(false);
    fireEvent.drop(pane(1), drag([PANE_MIME], { [PANE_MIME]: "0" }));
    await waitFor(() => expect(within(pane(0)).getByTestId("pane-run").getAttribute("data-run")).toBe("r4"));
    expect(within(pane(1)).getByTestId("pane-run").getAttribute("data-run")).toBe(first);
  });

  it("offers the keyboard way to rearrange: the pane menu moves a run and empties a pane", async () => {
    await start();
    fireEvent.click(layoutButton("Two panes side by side"));
    await waitFor(() => expect(panes()).toHaveLength(2));
    const first = within(pane(0)).getByTestId("pane-run").getAttribute("data-run")!;
    fireEvent.click(within(pane(0)).getByRole("button", { name: "Pane 1 menu" }));
    const left = await screen.findByRole("menuitem", { name: /Move left/ });
    expect(left.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: /Move right/ }));
    await waitFor(() => expect(within(pane(1)).getByTestId("pane-run").getAttribute("data-run")).toBe(first));
    expect(within(pane(0)).queryByTestId("pane-run")).toBeNull();
    fireEvent.click(within(pane(1)).getByRole("button", { name: "Empty pane 2" }));
    await waitFor(() => expect(within(pane(1)).queryByTestId("pane-run")).toBeNull());
    expect(within(pane(1)).getByText("Empty pane", { selector: "span" })).toBeTruthy();
  });

  it("resizes with the divider keys and remembers the ratios", async () => {
    await start();
    fireEvent.click(layoutButton("Two panes side by side"));
    await waitFor(() => expect(panes()).toHaveLength(2));
    const divider = screen.getByRole("separator", { name: "Resize panes" });
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
    fireEvent.keyDown(divider, { key: "ArrowRight", shiftKey: true });
    expect(divider.getAttribute("aria-valuenow")).toBe("60");
    expect(JSON.parse(localStorage.getItem(`${PANES_KEY}:w-migrated`)!).ratios.c2[0]).toBeCloseTo(0.6);
    fireEvent.keyDown(divider, { key: "Enter" });
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
  });

  it("falls back to one pane in a narrow window and comes back with the saved layout", async () => {
    await start();
    fireEvent.click(layoutButton("Three panes side by side"));
    await waitFor(() => expect(panes()).toHaveLength(3));
    setWindowWidth(800);
    await waitFor(() => expect(panes()).toHaveLength(0));
    expect(screen.getByTestId("agent-run")).toBeTruthy();
    expect(screen.getByText("Fewer panes shown: not enough room")).toBeTruthy();
    expect(paneState().layout).toBe("3h");
    setWindowWidth(1600);
    await waitFor(() => expect(panes()).toHaveLength(3));
    setCentreWidth(650);
    await waitFor(() => expect(panes()).toHaveLength(2));
    expect(paneState().layout).toBe("3h");
  });

  it("restores the layout and the runs after a restart, and drops a run that no longer exists", async () => {
    await start();
    fireEvent.click(layoutButton("Three panes side by side"));
    await waitFor(() => expect(panes()).toHaveLength(3));
    fireEvent.drop(pane(1), drag([RUN_MIME], { [RUN_MIME]: "r3" }));
    fireEvent.drop(pane(2), drag([RUN_MIME], { [RUN_MIME]: "r4" }));
    await waitFor(() => expect(within(pane(2)).getByTestId("pane-run").getAttribute("data-run")).toBe("r4"));
    cleanup();
    resetAgents();
    resetPanes();
    reloadPanes();
    expect(paneState().layout).toBe("3h");
    await start(RUNS.filter((r) => r.agentId !== "r3"));
    await waitFor(() => expect(panes()).toHaveLength(3));
    const shown = panes().map((p) => within(p).queryByTestId("pane-run")?.getAttribute("data-run") ?? null);
    expect(shown[2]).toBe("r4");
    expect(shown).not.toContain("r3");
    expect(paneState().slots).not.toContain("r3");
  });

  it("keeps the saved panes when the run list fails to load", async () => {
    localStorage.setItem(`${PANES_KEY}:w-migrated`, JSON.stringify({ layout: "2h", slots: ["r1", "r2", null, null], focus: 1, ratios: {} }));
    reloadPanes();
    const base = createMockIpc("normal", { delayScale: 0 });
    startAgentStore({ ...base, agentList: async () => Promise.reject(new Error("offline")) } as Ipc);
    render(() => <AgentWorkspace />);
    await waitFor(() => expect(panes()).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(paneState().slots.slice(0, 2)).toEqual(["r1", "r2"]);
  });

  it("selects the focused pane's run after a restart instead of the first live run", async () => {
    localStorage.setItem(`${PANES_KEY}:w-migrated`, JSON.stringify({ layout: "2h", slots: ["r3", "r4", null, null], focus: 1, ratios: {} }));
    reloadPanes();
    await start();
    expect(selectedAgentId()).toBe("r4");
    expect(pane(1).hasAttribute("data-focused")).toBe(true);
  });

  it("does not redraw the pane of an idle run when another run streams", async () => {
    const h = await start();
    fireEvent.click(layoutButton("Two panes side by side"));
    await waitFor(() => expect(panes()).toHaveLength(2));
    fireEvent.click(listRow("Run r3"));
    await selectAgent("r3");
    fireEvent.pointerDown(pane(1));
    fireEvent.click(listRow("Run r4"));
    await selectAgent("r4");
    await waitFor(() => expect(within(pane(1)).getByTestId("pane-run").getAttribute("data-run")).toBe("r4"));
    const idle = within(pane(1)).getByTestId("pane-run");
    const before = agentRow("r4");
    const mark = idle.firstElementChild;
    for (let seq = 1; seq <= 3; seq++) h.push([{ agentId: "r1", seq, ts: NOW + seq, provider: "claude", kind: "text.delta", messageId: "m1", text: "x" } as AgentEvent]);
    await new Promise((r) => setTimeout(r, 20));
    expect(agentRow("r4")).toBe(before);
    expect(within(pane(1)).getByTestId("pane-run")).toBe(idle);
    expect(idle.firstElementChild).toBe(mark);
  });
});
