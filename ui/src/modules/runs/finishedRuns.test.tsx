import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentList } from "../../components/chat/AgentList";
import { createMockIpc } from "../../ipc/mock";
import { capsOfProvider } from "../../ipc/providerCaps";
import type { Ipc } from "../../ipc";
import type { AgentRow } from "../../store/agents";
import { agentRows, resetAgents, startAgentStore } from "../../store/agents";
import type { AgentEvent, AgentSummary } from "../../store/agent-types";
import { installDomStubs } from "../../store/testing-u2";
import { toast } from "../../ui-kit";
import { closedRuns, closeRuns, resetClosed } from "./closed";
import { SessionsSidebar } from "./SessionsSidebar";
import { setSessionFilter } from "./state";
import { NO_FILTER } from "./sessionsLogic";

installDomStubs();

const NOW = Date.now();
const summary = (n: number, over: Partial<AgentSummary> = {}): AgentSummary =>
  ({
    agentId: `done-${n}`,
    provider: "claude",
    role: "developer",
    model: "claude-sonnet-5-5",
    title: `Finished run ${n}`,
    status: "done",
    permission: "edit",
    requested: { permission: "edit" },
    repoIds: ["admin"],
    caps: capsOfProvider("claude"),
    enforcement: "bestEffort",
    startedAt: NOW - n * 60 * 60_000 * 30, // all older than the review window, newest first by n
    ...over,
  }) as AgentSummary;

/** An engine that already holds a history: `finished` done runs, one working run. */
function historyIpc(finished: number): Ipc {
  const base = createMockIpc("normal", { delayScale: 0 });
  const list = [summary(0, { agentId: "live-1", title: "Working run", status: "running", startedAt: NOW - 1000 }), ...Array.from({ length: finished }, (_, i) => summary(i + 1))];
  return { ...base, agentList: async () => structuredClone(list), agentHistory: async () => [] };
}

/** The same engine, with a way to push live events into the store (what a working run does all the time). */
function pushingIpc(finished: number): { ipc: Ipc; push: (events: AgentEvent[]) => void } {
  let sink: ((events: AgentEvent[]) => void) | undefined;
  const base = historyIpc(finished);
  return { ipc: { ...base, onAgentEvents: (cb: (events: AgentEvent[]) => void) => ((sink = cb), () => (sink = undefined)) } as Ipc, push: (events) => sink?.(events) };
}
const delta = (seq: number, agentId = "live-1"): AgentEvent => ({ agentId, seq, ts: NOW + seq, provider: "claude", kind: "text.delta", messageId: "m1", text: "x" }) as AgentEvent;

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

beforeEach(() => {
  resetAgents();
  resetClosed();
});
afterEach(() => {
  cleanup();
  resetAgents();
  resetClosed();
  setSessionFilter(NO_FILTER);
  vi.restoreAllMocks();
});

const rowTitles = () => [...document.querySelectorAll(".run-row__title")].map((e) => e.textContent);

describe("the finished runs of the sessions sidebar", () => {
  it("lists the newest few as one-line rows and offers the rest behind a button", async () => {
    startAgentStore(historyIpc(12));
    await until(() => agentRows().length === 13, "runs");
    render(() => <SessionsSidebar />);
    expect(rowTitles()).toEqual(["Finished run 1", "Finished run 2", "Finished run 3", "Finished run 4", "Finished run 5"]);
    // the working run keeps its full card and is not part of the folded list
    expect(screen.getByText("Working run").closest(".run-card")).toBeTruthy();
    expect(document.querySelectorAll(".run-row .run-row__activity")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Show 7 more" }));
    expect(rowTitles()).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(rowTitles()).toHaveLength(5);
  });

  it("closes one run, which leaves the list but not the history, and Closed brings it back", async () => {
    startAgentStore(historyIpc(3));
    await until(() => agentRows().length === 4, "runs");
    render(() => <SessionsSidebar />);
    const first = screen.getByText("Finished run 1").closest(".run-row") as HTMLElement;
    fireEvent.click(within(first).getByRole("button", { name: "Close Finished run 1" }));
    expect(rowTitles()).toEqual(["Finished run 2", "Finished run 3"]);
    expect(closedRuns().has("done-1")).toBe(true);
    expect(agentRows().some((r) => r.agentId === "done-1")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Closed (1)" }));
    expect(rowTitles()).toEqual(["Finished run 1", "Finished run 2", "Finished run 3"]);
    const again = screen.getByText("Finished run 1").closest(".run-row") as HTMLElement;
    expect(again.hasAttribute("data-closed")).toBe(true);
    fireEvent.click(within(again).getByRole("button", { name: "Reopen Finished run 1" }));
    expect(closedRuns().size).toBe(0);
    expect(screen.queryByRole("button", { name: /^Closed \(/ })).toBeNull();
  });

  it("closes a whole group at once, says so with an Undo, and never touches a run that is working", async () => {
    const show = vi.spyOn(toast, "show");
    startAgentStore(historyIpc(8));
    await until(() => agentRows().length === 9, "runs");
    render(() => <SessionsSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Close all in Done" }));
    expect(rowTitles()).toEqual([]);
    expect(closedRuns().size).toBe(8);
    expect(closedRuns().has("live-1")).toBe(false);
    expect(screen.getByText("Working run")).toBeTruthy();
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0].title).toBe("Closed 8 finished runs");
    show.mock.calls[0][0].action!.onSelect();
    await waitFor(() => expect(closedRuns().size).toBe(0));
    expect(rowTitles()).toHaveLength(5);
  });

  it("folds a finished group away and opens it again", async () => {
    startAgentStore(historyIpc(3));
    await until(() => agentRows().length === 4, "runs");
    render(() => <SessionsSidebar />);
    const toggle = screen.getByRole("button", { name: /^Done\s?\d+$/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(rowTitles()).toEqual([]);
    expect(screen.getByRole("button", { name: /^Done\s?\d+$/ }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /^Done\s?\d+$/ }));
    expect(rowTitles()).toHaveLength(3);
  });

  it("says that the runs are closed, not that there are none", async () => {
    startAgentStore(historyIpc(2));
    await until(() => agentRows().length === 3, "runs");
    const { unmount } = render(() => <SessionsSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Close all in Done" }));
    unmount();
    // only finished runs left: close them all and look at the empty state
    resetAgents();
    startAgentStore({ ...historyIpc(2), agentList: async () => [summary(1), summary(2)] });
    await until(() => agentRows().length === 2, "runs");
    render(() => <SessionsSidebar />);
    expect(screen.getByText("All runs are closed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Closed (2)" }));
    expect(rowTitles()).toHaveLength(2);
  });

  it("keeps the keyboard focus on a row while a working run streams into the list", async () => {
    const { ipc: engine, push } = pushingIpc(3);
    startAgentStore(engine);
    await until(() => agentRows().length === 4, "runs");
    render(() => <SessionsSidebar />);
    const main = screen.getByText("Finished run 2").closest("button")!;
    main.focus();
    expect(document.activeElement).toBe(main);
    for (let i = 1; i <= 3; i++) push([delta(i)]);
    await new Promise((r) => setTimeout(r, 30));
    expect(main.isConnected).toBe(true);
    expect(document.activeElement).toBe(main);
    expect(screen.getByText("Finished run 2").closest("button")).toBe(main);
  });

  it("moves the focus to the next row when the focused run is closed, and says so", async () => {
    startAgentStore(historyIpc(3));
    await until(() => agentRows().length === 4, "runs");
    render(() => <SessionsSidebar />);
    screen.getByText("Finished run 1").closest("button")!.focus();
    fireEvent.keyDown(document.activeElement!, { key: "Delete" });
    await new Promise((r) => setTimeout(r, 10));
    expect(rowTitles()).toEqual(["Finished run 2", "Finished run 3"]);
    expect(document.activeElement).toBe(screen.getByText("Finished run 2").closest("button"));
  });

  it("gives each Close button the name of its run", async () => {
    startAgentStore(historyIpc(2));
    await until(() => agentRows().length === 3, "runs");
    render(() => <SessionsSidebar />);
    expect(screen.getAllByRole("button", { name: /^Close Finished run \d$/ })).toHaveLength(2);
  });

  it("reopens a closed run that is working again, and leaves a finished one closed", async () => {
    startAgentStore(historyIpc(2));
    await until(() => agentRows().length === 3, "runs");
    closeRuns(["live-1", "done-1"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(closedRuns().has("live-1")).toBe(false);
    expect(closedRuns().has("done-1")).toBe(true);
  });

  it("offers the closed runs when a filter is on and the only runs that match are closed", async () => {
    startAgentStore(historyIpc(2));
    await until(() => agentRows().length === 3, "runs");
    closeRuns(["done-1", "done-2"]);
    setSessionFilter({ role: "developer", repoId: "" });
    render(() => <SessionsSidebar />);
    expect(screen.queryByText("Finished run 1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Closed (2)" }));
    await waitFor(() => expect(rowTitles()).toHaveLength(2));
  });

  it("closes a run with the Delete key", async () => {
    startAgentStore(historyIpc(2));
    await until(() => agentRows().length === 3, "runs");
    render(() => <SessionsSidebar />);
    fireEvent.keyDown(screen.getByText("Finished run 2").closest("button")!, { key: "Delete" });
    expect(rowTitles()).toEqual(["Finished run 1"]);
  });
});

describe("the closed runs that are remembered", () => {
  it("keep the newest when a bulk close is bigger than what is remembered", async () => {
    const ids = Array.from({ length: 600 }, (_, i) => `done-${i + 1}`); // newest first, as the list shows them
    closeRuns(ids);
    expect(closedRuns().size).toBe(600);
    vi.resetModules();
    const again = await import("./closed");
    expect(again.closedRuns().size).toBe(500);
    expect(again.closedRuns().has("done-1")).toBe(true);
    expect(again.closedRuns().has("done-600")).toBe(false);
    again.resetClosed();
  });
});

describe("the finished runs of the dock list", () => {
  const row = (n: number, over: Partial<AgentRow> = {}): AgentRow => ({ ...(summary(n) as AgentRow), needs: 0, ...over });

  it("shows the newest few, folds, and closes one or all", () => {
    const rows = [row(0, { agentId: "live-1", title: "Working run", status: "running", startedAt: NOW }), ...Array.from({ length: 9 }, (_, i) => row(i + 1))];
    render(() => <AgentList rows={rows} onSelect={() => {}} />);
    const done = () => within(screen.getByRole("region", { name: "Done" }));
    expect(done().getAllByRole("treeitem")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show 4 more" }));
    expect(done().getAllByRole("treeitem")).toHaveLength(9);

    fireEvent.click(within(done().getAllByRole("treeitem")[0]).getByRole("button", { name: /^Close Finished run/ }));
    expect(done().getAllByRole("treeitem")).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Close all in Done" }));
    expect(screen.queryByRole("region", { name: "Done" })).toBeNull();
    expect(screen.getByText("Working run")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Closed (9)" }));
    expect(done().getAllByRole("treeitem").length).toBeGreaterThan(0);
  });

  it("closes a run when Enter is pressed on its Close button, instead of opening the run", () => {
    const opened: string[] = [];
    const rows = Array.from({ length: 3 }, (_, i) => row(i + 1));
    render(() => <AgentList rows={rows} onSelect={(id) => opened.push(id)} />);
    const button = screen.getByRole("button", { name: "Close Finished run 1" });
    button.focus();
    // the key reaches the row as well (it bubbles): only a key pressed on the row itself selects it
    const key = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    button.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    expect(opened).toEqual([]);
    const rowKey = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    screen.getAllByRole("treeitem")[0].dispatchEvent(rowKey);
    expect(opened).toEqual(["done-1"]);
  });

  it("shows no 'Show fewer' once nothing is left to fold", () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(i + 1));
    render(() => <AgentList rows={rows} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Show 4 more" }));
    expect(screen.getByRole("button", { name: "Show fewer" })).toBeTruthy();
    for (const n of [1, 2, 3, 4]) fireEvent.click(screen.getByRole("button", { name: `Close Finished run ${n}` }));
    expect(screen.queryByRole("button", { name: "Show fewer" })).toBeNull();
  });

  it("says that the runs are closed, with a way back, when every run is", () => {
    render(() => <AgentList rows={[row(1), row(2)]} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Close all in Done" }));
    expect(screen.getByText("All runs are closed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Closed (2)" }));
    expect(screen.getAllByRole("treeitem")).toHaveLength(2);
  });
});
