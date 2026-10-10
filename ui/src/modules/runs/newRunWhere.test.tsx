import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { ipc } from "../../ipc";
import { createMockServers, type MockServersHandle } from "../../ipc/mock/servers";
import { activeSettingsSection, resetSettings, settingsOpen } from "../../platform/settings";
import { agentRows, resetAgents, selectedAgentId, startAgentStore } from "../../store/agents";
import { installDomStubs } from "../../store/testing-u2";
import { loadWorkspace } from "../../store/workspace";
import { toast } from "../../ui-kit";
import { register as registerServers } from "../servers";
import { resetServers } from "../servers/store";
import { NewRunDialog } from "./NewRunDialog";
import { clampCounts, MAC_MAX, numberedPrompt, placementRows, placementSummary, planRuns, THIS_MAC, totalRuns } from "./newRunLogic";
import { setNewRunOpen } from "./state";

installDomStubs();
vi.setConfig({ testTimeout: 30000 });

let mock: MockServersHandle;
const useServers = (m: MockServersHandle) => {
  mock = m;
  (ipc as { servers: unknown }).servers = m;
};
beforeEach(async () => {
  resetAgents();
  resetServers();
  startAgentStore();
  await ipc.settings.set("runs", { lastMode: null });
  useServers(createMockServers({ stepMs: 0 }));
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  setNewRunOpen(false);
  resetAgents();
  resetSettings();
});

/** Build server is ready with 5 free of 6; GPU box needs setup; Old box is unreachable. Make GPU box ready for the tests that place runs on it. */
const readyGpu = () => mock.setup("gpu-box", { installNode: true, installBundle: true, installSdk: true, installClaude: true });

const open = async () => {
  await loadWorkspace();
  render(() => <NewRunDialog />);
  setNewRunOpen(true);
  const d = within((await screen.findByRole("dialog")) as HTMLElement);
  await d.findByRole("group", { name: "Build server" });
  before = new Set(agentRows().map((r) => r.agentId));
  return d;
};
const row = (d: ReturnType<typeof within>, name: string) => within(d.getByRole("group", { name }));
const more = (d: ReturnType<typeof within>, name: string, times = 1) => {
  for (let i = 0; i < times; i++) fireEvent.click(row(d, name).getByRole("button", { name: `One more run on ${name}` }));
};
const fewer = (d: ReturnType<typeof within>, name: string) => fireEvent.click(row(d, name).getByRole("button", { name: `One run fewer on ${name}` }));
const count = (d: ReturnType<typeof within>, name: string) => row(d, name).getByTestId("where-count").textContent;
/** The mock host keeps the runs of earlier tests: count only what this test started. */
let before = new Set<string>();
const mine = () => agentRows().filter((r) => !before.has(r.agentId));
const started = () => mine().length;
const ready = async (d: ReturnType<typeof within>, prompt = "Check the totals") => {
  fireEvent.click(d.getByRole("button", { name: "admin" }));
  fireEvent.input(d.getByLabelText("Prompt"), { target: { value: prompt } });
  await waitFor(() => expect((d.getByRole("button", { name: "Start run" }) as HTMLButtonElement).disabled).toBe(false));
};

describe("placement logic", () => {
  const view = (id: string, name: string, max: number, running: number, status?: Partial<{ reachable: boolean; ready: boolean }>, enabled = true) => ({
    cfg: { id, name, destination: id, root: "~/work", maxAgents: max, enabled },
    running,
    ...(status ? { status: { reachable: true, ready: true, node: { ok: true }, claude: {}, git: {}, bundle: { ok: true }, sdk: { ok: true }, checkedAt: "", ...status } } : {}),
  });
  const rows = placementRows([view("b", "Build server", 6, 2, {}), view("g", "GPU box", 2, 0, { ready: false }), view("o", "Old", 2, 0, { reachable: false, ready: false }), view("n", "Never", 2, 0), view("f", "Full", 2, 2, {}), view("x", "Off", 2, 0, {}, false)], "This Mac");

  it("has This Mac up to 6 and a ready server up to its free slots; the others are listed with the reason", () => {
    expect(rows.map((r) => [r.name, r.max, r.why])).toEqual([["This Mac", MAC_MAX, undefined], ["Build server", 4, undefined], ["GPU box", 0, "needsSetup"], ["Old", 0, "unreachable"], ["Never", 0, "unchecked"], ["Full", 0, "full"]]);
  });
  it("clamps counts to the capacity and counts what is placed", () => {
    expect(clampCounts({ [THIS_MAC]: 9, b: 7, g: 1 }, rows)).toMatchObject({ [THIS_MAC]: 6, b: 4, g: 0 });
    expect(totalRuns({ [THIS_MAC]: 1, b: 2, g: 3 }, rows)).toBe(3);
  });
  it("summarizes as '3 runs: 1 on This Mac, 2 on Build server'", () => {
    expect(placementSummary({ [THIS_MAC]: 1, b: 2 }, rows)).toBe("3 runs: 1 on This Mac, 2 on Build server");
    expect(placementSummary({ [THIS_MAC]: 1 }, rows)).toBe("1 run: 1 on This Mac");
    expect(placementSummary({}, rows)).toBe("No runs selected.");
  });
  it("plans the runs this Mac first, then each server, numbered over all of them", () => {
    expect(planRuns({ [THIS_MAC]: 1, b: 2 }, rows)).toEqual([
      { name: "This Mac", index: 1, of: 3 },
      { location: "b", name: "Build server", index: 2, of: 3 },
      { location: "b", name: "Build server", index: 3, of: 3 },
    ]);
  });
  it("writes the number line and a blank line before the prompt", () => {
    expect(numberedPrompt("Fix it", { index: 2, of: 3, name: "Build server" })).toBe("[Agent 2 of 3, running on Build server]\n\nFix it");
  });
});

describe("<NewRunDialog> where to run", () => {
  it("lists This Mac and each enabled server; one that is not ready is disabled with the reason", async () => {
    const d = await open();
    expect(count(d, "This Mac")).toBe("1");
    expect(row(d, "Build server").getByText("5 of 6 free")).toBeTruthy();
    expect(row(d, "GPU box").getByText("Needs setup.")).toBeTruthy();
    expect(row(d, "Old box").getByText("Unreachable.")).toBeTruthy();
    const plus = row(d, "GPU box").getByRole("button", { name: "One more run on GPU box" });
    expect(plus.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(plus);
    expect(count(d, "GPU box")).toBe("0");
    expect(d.getByText("1 run: 1 on This Mac")).toBeTruthy();
  });

  it("keeps each stepper inside its capacity", async () => {
    const d = await open();
    more(d, "This Mac", 9);
    expect(count(d, "This Mac")).toBe("6");
    more(d, "Build server", 9);
    expect(count(d, "Build server")).toBe("5");
    expect(row(d, "Build server").getByRole("button", { name: "One more run on Build server" }).getAttribute("aria-disabled")).toBe("true");
    fewer(d, "Build server");
    expect(count(d, "Build server")).toBe("4");
    for (let i = 0; i < 9; i++) fewer(d, "This Mac");
    expect(count(d, "This Mac")).toBe("0");
  });

  it("shows the summary and asks for a place when nothing is picked", async () => {
    const d = await open();
    await ready(d);
    more(d, "Build server", 2);
    expect(d.getByText("3 runs: 1 on This Mac, 2 on Build server")).toBeTruthy();
    fewer(d, "This Mac");
    fewer(d, "Build server");
    fewer(d, "Build server");
    expect(d.getByText("No runs selected.")).toBeTruthy();
    expect(d.getAllByText("Choose where to run").length).toBeGreaterThan(0);
    expect((d.getByRole("button", { name: "Start run" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("numbers the agents by default above one run, and the box can be cleared", async () => {
    const d = await open();
    const box = () => d.getByRole("checkbox", { name: "Tell each agent its number in the prompt" }) as HTMLInputElement;
    expect(box().checked).toBe(false);
    more(d, "Build server");
    expect(box().checked).toBe(true);
    fireEvent.click(box());
    expect(box().checked).toBe(false);
    more(d, "Build server");
    expect(box().checked).toBe(false);
  });

  it("starts N runs one after the other, each with its location, and numbers the prompts", async () => {
    const d = await open();
    await ready(d);
    more(d, "Build server", 2);
    let inFlight = 0;
    let overlap = false;
    const calls: { location?: string; prompt: string }[] = [];
    const real = ipc.agentStart.bind(ipc);
    vi.spyOn(ipc, "agentStart").mockImplementation(async (req, opts) => {
      inFlight++;
      overlap ||= inFlight > 1;
      calls.push(req);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return real(req, opts);
    });
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(calls).toHaveLength(3));
    await waitFor(() => expect(started()).toBe(3));
    expect(overlap).toBe(false);
    expect(calls.map((c) => c.location)).toEqual([undefined, "build-server", "build-server"]);
    expect(calls[0]).not.toHaveProperty("location");
    expect(calls.map((c) => c.prompt)).toEqual([
      "[Agent 1 of 3, running on This Mac]\n\nCheck the totals",
      "[Agent 2 of 3, running on Build server]\n\nCheck the totals",
      "[Agent 3 of 3, running on Build server]\n\nCheck the totals",
    ]);
    expect(mine().filter((r) => r.location === "build-server")).toHaveLength(2);
  });

  it("selects the first started run and closes the dialog", async () => {
    const d = await open();
    await ready(d);
    more(d, "Build server");
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(started()).toBe(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const first = mine().find((r) => !r.location)!;
    await waitFor(() => expect(selectedAgentId()).toBe(first.agentId));
  });

  it("leaves the prompt as typed when the box is cleared, or when only one run starts", async () => {
    const d = await open();
    await ready(d);
    const spy = vi.spyOn(ipc, "agentStart");
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0].prompt).toBe("Check the totals");
    expect(spy.mock.calls[0][0]).not.toHaveProperty("location");
  });

  it("starts a run only on a server when This Mac is set to 0", async () => {
    await readyGpu();
    const d = await open();
    await ready(d);
    fewer(d, "This Mac");
    more(d, "GPU box", 2);
    const spy = vi.spyOn(ipc, "agentStart");
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls.map((c) => c[0].location)).toEqual(["gpu-box", "gpu-box"]);
  });

  it("starts the others when one fails and lists the failures in one toast", async () => {
    const d = await open();
    await ready(d);
    more(d, "Build server", 2);
    const real = ipc.agentStart.bind(ipc);
    vi.spyOn(ipc, "agentStart").mockImplementation(async (req, opts) => {
      if (req.prompt.includes("Agent 2 of 3")) throw { code: "unreachable", message: "ssh: connect to host build1 timed out" };
      return real(req, opts);
    });
    const error = vi.spyOn(toast, "error");
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(started()).toBe(2));
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe("1 run did not start");
    expect(error.mock.calls[0][1]).toBe("Build server: ssh: connect to host build1 timed out");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("stays open with the reasons when nothing started", async () => {
    const d = await open();
    await ready(d);
    more(d, "Build server");
    vi.spyOn(ipc, "agentStart").mockRejectedValue({ code: "io", message: "no slot" });
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    const alert = await d.findByRole("alert");
    expect(alert.textContent).toBe("This Mac: no slot Build server: no slot");
    expect(started()).toBe(0);
  });

  it("opens Settings > Servers from a server that is not ready", async () => {
    registerServers();
    const d = await open();
    fireEvent.click(row(d, "GPU box").getByRole("button", { name: "Open Servers settings" }));
    expect(settingsOpen()).toBe(true);
    expect(activeSettingsSection()?.id).toBe("servers");
    await waitFor(() => expect(screen.queryByRole("group", { name: "GPU box" })).toBeNull());
  });
});

describe("<NewRunDialog> with no server", () => {
  it("shows no placement and starts one run here with no location", async () => {
    useServers(createMockServers({ stepMs: 0, seed: false }));
    await loadWorkspace();
    render(() => <NewRunDialog />);
    setNewRunOpen(true);
    const d = within((await screen.findByRole("dialog")) as HTMLElement);
    await ready(d);
    expect(d.queryByText("Where to run")).toBeNull();
    const spy = vi.spyOn(ipc, "agentStart");
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toEqual({ role: "auto", repoIds: ["admin"], prompt: "Check the totals", mode: "automatic", mcpServers: expect.any(Array) });
  });

  it("shows no placement when every server is disabled", async () => {
    const m = createMockServers({ stepMs: 0 });
    useServers({ ...m, list: async () => (await m.list()).map((v) => ({ ...v, cfg: { ...v.cfg, enabled: false } })) } as MockServersHandle);
    await loadWorkspace();
    render(() => <NewRunDialog />);
    setNewRunOpen(true);
    const d = within((await screen.findByRole("dialog")) as HTMLElement);
    await waitFor(() => expect(d.getByRole("button", { name: "Start run" })).toBeTruthy());
    await new Promise((r) => setTimeout(r, 20));
    expect(d.queryByText("Where to run")).toBeNull();
  });
});
