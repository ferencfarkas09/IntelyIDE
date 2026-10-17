import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { Show } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { ChatPanel } from "../../components/chat/ChatPanel";
import { StartingRunView } from "../../components/chat/Starting";
import { ipc } from "../../ipc";
import { registerCommand, resetCommands } from "../../platform/commands";
import { agentRows, resetAgents, selectedAgentId, startAgentStore } from "../../store/agents";
import { startingInFront, startingRun, startingRuns } from "../../store/starting";
import { installDomStubs } from "../../store/testing-u2";
import { loadWorkspace } from "../../store/workspace";
import { NewRunDialog } from "./NewRunDialog";
import { SessionsSidebar } from "./SessionsSidebar";
import { setNewRunOpen } from "./state";
import { REVEAL_AFTER_MS } from "./startingLogic";

installDomStubs();
vi.setConfig({ testTimeout: 30000 });

beforeEach(async () => {
  resetAgents();
  startAgentStore();
  // what the runs module registers: Edit and retry opens the dialog through this command
  registerCommand({ id: "runs.new", title: "New run", group: "Agents", run: () => void setNewRunOpen(true) });
  await ipc.settings.set("runs", { lastMode: null });
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  setNewRunOpen(false);
  resetAgents();
  resetCommands();
});

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

/** The sidebar and the middle of the Agent workspace: what a person sees while a run starts. */
function Workspace() {
  return (
    <>
      <SessionsSidebar />
      <Show when={startingRun(startingInFront())}>{(run) => <StartingRunView run={run()} />}</Show>
      <NewRunDialog />
    </>
  );
}

const openDialog = async (view: () => unknown = () => <NewRunDialog />) => {
  await loadWorkspace();
  render(view as never);
  setNewRunOpen(true);
  const d = within((await screen.findByRole("dialog")) as HTMLElement);
  fireEvent.click(await d.findByRole("button", { name: "Run as role..." }));
  await waitFor(() => expect(d.getByRole("radiogroup", { name: "Role" })).toBeTruthy());
  return d;
};
const typeTask = async (d: ReturnType<typeof within>, text: string) => {
  fireEvent.input(d.getByLabelText("Prompt"), { target: { value: text } });
  await waitFor(() => expect((d.getByRole("button", { name: "Start run" }) as HTMLButtonElement).disabled).toBe(false));
};
const dialogGone = () => waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 10_000 });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a start that takes a while", () => {
  it("closes the dialog on a starting card, and the card becomes the run when the host answers", async () => {
    const real = ipc.agentStart.bind(ipc);
    const gate = deferred<void>();
    vi.spyOn(ipc, "agentStart").mockImplementationOnce(async (...args) => (await gate.promise, real(...args)));
    const d = await openDialog(() => <Workspace />);
    await typeTask(d, "Fix the total\nand the tax");
    fireEvent.click(d.getByRole("button", { name: "Start run" }));

    await dialogGone();
    // the run is in front as a card: what it is, where, and that it is working
    const view = await screen.findByTestId("starting-run");
    expect(within(view).getByRole("heading", { name: "Starting the run" })).toBeTruthy();
    expect(within(view).getByText(/Fix the total/)).toBeTruthy();
    expect(within(view).getByTestId("starting-elapsed").textContent).toMatch(/^\d+ s$/);
    expect(startingRuns()).toHaveLength(1);
    expect(selectedAgentId()).toBeNull();
    // and it is in the sessions list, selected
    const card = document.querySelector<HTMLElement>(".run-card[data-starting]")!;
    expect(card.getAttribute("aria-current")).toBe("true");
    expect(card.textContent).toContain("Fix the total");
    // the form is empty for the next run
    setNewRunOpen(true);
    const again = within(await screen.findByRole("dialog"));
    expect((again.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("");
    setNewRunOpen(false);

    gate.resolve();
    await waitFor(() => expect(screen.queryByTestId("starting-run")).toBeNull(), { timeout: 10_000 });
    expect(startingRuns()).toEqual([]);
    const run = agentRows().find((r) => r.title.startsWith("Fix the total"))!;
    expect(run).toBeTruthy();
    expect(selectedAgentId()).toBe(run.agentId);
    expect(document.querySelector(".run-card[data-starting]")).toBeNull();
  });

  it("does not take the person away from the run they went to while it was starting", async () => {
    const real = ipc.agentStart.bind(ipc);
    const gate = deferred<void>();
    vi.spyOn(ipc, "agentStart").mockImplementationOnce(async (...args) => (await gate.promise, real(...args)));
    const d = await openDialog(() => <Workspace />);
    await waitFor(() => expect(agentRows().length).toBeGreaterThan(0));
    await typeTask(d, "Fix the total");
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await dialogGone();
    await screen.findByTestId("starting-run");
    // another run is picked from the list
    const other = agentRows()[0];
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(other.title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }));
    await waitFor(() => expect(selectedAgentId()).toBe(other.agentId));
    gate.resolve();
    await waitFor(() => expect(startingRuns()).toEqual([]), { timeout: 10_000 });
    expect(selectedAgentId()).toBe(other.agentId);
    expect(agentRows().some((r) => r.title.startsWith("Fix the total"))).toBe(true);
  });

  it("keeps the reason on the card when the host refuses, and Edit and retry opens the dialog again with the task and the reason", async () => {
    const gate = deferred<void>();
    vi.spyOn(ipc, "agentStart").mockImplementationOnce(async () => {
      await gate.promise;
      throw { code: "noSafetyNet", message: "Rewind cannot snapshot admin" };
    });
    const d = await openDialog(() => <Workspace />);
    await typeTask(d, "Fix the total");
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await dialogGone();
    const view = await screen.findByTestId("starting-run");
    gate.resolve();
    await waitFor(() => expect(within(view).getByRole("heading", { name: "The run could not be started" })).toBeTruthy(), { timeout: 10_000 });
    expect(within(view).getByRole("alert").textContent).toContain("Rewind cannot snapshot admin");
    expect(view.hasAttribute("data-failed")).toBe(true);
    expect(within(view).getByText(/Fix the total/)).toBeTruthy();
    expect(document.querySelector(".run-card[data-starting]")?.getAttribute("data-status")).toBe("error");

    fireEvent.click(within(view).getByRole("button", { name: "Edit and retry" }));
    const retry = within(await screen.findByRole("dialog"));
    await waitFor(() => expect((retry.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Fix the total"));
    expect(retry.getByText(/Rewind cannot snapshot admin/)).toBeTruthy();
    expect(retry.getByLabelText(/without a safety net/)).toBeTruthy();
    // the card goes once the dialog is open (a few ticks after the click)
    await waitFor(() => expect(startingRuns()).toEqual([]));
  });

  it("Dismiss removes a refused card and nothing else", async () => {
    const gate = deferred<void>();
    vi.spyOn(ipc, "agentStart").mockImplementationOnce(async () => (await gate.promise, Promise.reject({ code: "noSlot", message: "All slots are taken" })));
    const d = await openDialog(() => <Workspace />);
    await typeTask(d, "Fix the total");
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await dialogGone();
    const view = await screen.findByTestId("starting-run");
    gate.resolve();
    await waitFor(() => expect(within(view).getByRole("alert")).toBeTruthy(), { timeout: 10_000 });
    fireEvent.click(within(view).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByTestId("starting-run")).toBeNull());
    expect(startingRuns()).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a start that answers quickly", () => {
  it("never shows a card: the dialog closes on the run, as ever", async () => {
    const d = await openDialog(() => <Workspace />);
    await typeTask(d, "Fix the total");
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await dialogGone();
    expect(startingRuns()).toEqual([]);
    expect(screen.queryByTestId("starting-run")).toBeNull();
    await waitFor(() => expect(agentRows().some((r) => r.title.startsWith("Fix the total"))).toBe(true));
    expect(selectedAgentId()).toBe(agentRows().find((r) => r.title.startsWith("Fix the total"))!.agentId);
    // the waiting timer is gone with the answer: nothing happens later
    await wait(REVEAL_AFTER_MS + 300);
    expect(startingRuns()).toEqual([]);
    expect(startingInFront()).toBeNull();
  });

  it("keeps a quick refusal in the dialog with its reason and shows no card", async () => {
    vi.spyOn(ipc, "agentStart").mockRejectedValueOnce({ code: "noSafetyNet", message: "Rewind cannot snapshot admin" });
    const d = await openDialog(() => <Workspace />);
    await typeTask(d, "Fix the total");
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(d.getByLabelText(/without a safety net/)).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeTruthy();
    expect(startingRuns()).toEqual([]);
    await wait(REVEAL_AFTER_MS + 300);
    expect(screen.queryByRole("dialog")).toBeTruthy();
    expect(startingRuns()).toEqual([]);
  });
});

describe("the starting card in the dock", () => {
  it("fills the panel, is listed under Starting, and gives way to the run", async () => {
    const real = ipc.agentStart.bind(ipc);
    const gate = deferred<void>();
    vi.spyOn(ipc, "agentStart").mockImplementationOnce(async (...args) => (await gate.promise, real(...args)));
    const d = await openDialog(() => (
      <>
        <ChatPanel />
        <NewRunDialog />
      </>
    ));
    await typeTask(d, "Fix the total");
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await dialogGone();
    const view = await screen.findByTestId("starting-run");
    expect(within(view).getByRole("heading", { name: "Starting the run" })).toBeTruthy();
    // back to the list: the run is there under Starting, and a click brings the card back
    fireEvent.click(screen.getByRole("button", { name: /^Runs/ }));
    const group = await screen.findByRole("region", { name: "Starting" });
    expect(group.textContent).toContain("Fix the total");
    fireEvent.click(within(group).getByRole("treeitem", { name: /Fix the total/ }));
    await screen.findByTestId("starting-run");
    gate.resolve();
    await waitFor(() => expect(screen.queryByTestId("starting-run")).toBeNull(), { timeout: 10_000 });
    expect(selectedAgentId()).toBe(agentRows().find((r) => r.title.startsWith("Fix the total"))!.agentId);
  });
});

describe("<StartingRunView>", () => {
  const run = (over: Partial<Parameters<typeof StartingRunView>[0]["run"]> = {}) => ({ key: "k", prompt: "Fix the total", retryPrompt: "Fix the total", repoIds: ["admin"], role: "auto", startedAt: Date.now(), shown: true, ...over });

  it("says more about the wait once it has gone on for a while, and not before", () => {
    const quick = render(() => <StartingRunView run={run()} />);
    expect(screen.queryByTestId("starting-slow")).toBeNull();
    quick.unmount();
    const long = run({ startedAt: Date.now() - 20_000 });
    render(() => <StartingRunView run={long} />);
    expect(screen.getByTestId("starting-slow").textContent).toMatch(/taking a while/);
    expect(screen.getByTestId("starting-elapsed").textContent).toMatch(/^2\d s$/);
  });

  it("cuts a very long task for the card", () => {
    render(() => <StartingRunView run={run({ prompt: "x".repeat(5000) })} />);
    const text = document.querySelector(".starting__task")!.textContent!;
    expect(text.length).toBeLessThan(1300);
    expect(text.endsWith("…")).toBe(true);
  });
});
