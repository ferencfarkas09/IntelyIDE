import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { ipc } from "../../ipc";
import { agentRows, resetAgents, startAgentStore } from "../../store/agents";
import { installDomStubs } from "../../store/testing-u2";
import { loadWorkspace } from "../../store/workspace";
import { NewRunDialog } from "./NewRunDialog";
import { setNewRunOpen } from "./state";

installDomStubs();
vi.setConfig({ testTimeout: 30000 });

beforeEach(async () => {
  resetAgents();
  startAgentStore();
  // The mock settings outlive a test: forget the mode a previous test used last.
  await ipc.settings.set("runs", { lastMode: null });
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  setNewRunOpen(false);
  resetAgents();
});

/** The dialog opens in Auto; `role` (the default here, for the provider tests of single-role runs) opens "Run as role..." first. */
const open = async (mode: "role" | "auto" = "role") => {
  await loadWorkspace(); // the repos a role proposes exist only once the workspace is loaded
  render(() => <NewRunDialog />);
  setNewRunOpen(true);
  const d = within((await screen.findByRole("dialog")) as HTMLElement);
  if (mode === "role") {
    fireEvent.click(await d.findByRole("button", { name: "Run as role..." }));
    await waitFor(() => expect(d.getByRole("radiogroup", { name: "Role" })).toBeTruthy());
  }
  return d;
};
const repo = (d: ReturnType<typeof within>, name: string) => fireEvent.click(d.getByRole("button", { name }));
const role = (d: ReturnType<typeof within>, name: string) => fireEvent.click(d.getByRole("radio", { name: new RegExp(`^${name}`) }));
const provider = (d: ReturnType<typeof within>, name: string) => d.getByRole("radio", { name: new RegExp(`^${name}`) });
/** What the user does in Settings > Providers before Codex can be picked: global switch, own switch, confirmed command line. */
const readyCodex = async () => {
  await ipc.providers.setExperimental(true);
  await ipc.providers.setEnabled("codex", true);
  await ipc.providers.detect();
  await ipc.providers.confirmLaunch("codex", "/usr/local/bin/codex", ["app-server"]);
};

describe("<NewRunDialog> provider picker", () => {
  it("offers only the role's own provider while the others are off, with its enforcement tier", async () => {
    const d = await open();
    await waitFor(() => expect(d.getByRole("radiogroup", { name: "Provider" })).toBeTruthy());
    const group = within(d.getByRole("radiogroup", { name: "Provider" }));
    expect(group.getAllByRole("radio")).toHaveLength(1);
    expect(provider(d, "Claude").getAttribute("aria-checked")).toBe("true");
    expect(group.getByText("Best effort")).toBeTruthy();
  });

  it("greys out a weak provider for a role that changes files, and allows it for a read-only role", async () => {
    await readyCodex();
    await ipc.providers.setEnabled("gemini", true);
    const d = await open();
    await waitFor(() => expect(d.getAllByRole("radio", { name: /^Codex/ }).length).toBe(1));
    // The first role is developer (edit): Codex is Weak, so only read-only roles may use it.
    expect(provider(d, "Codex").getAttribute("aria-disabled")).toBe("true");
    expect(provider(d, "Codex").getAttribute("title")).toMatch(/only read-only roles run on it/);
    // Gemini is not installed on the dev Mac: listed, but it cannot be picked, and the title says why.
    expect(provider(d, "Gemini").getAttribute("aria-disabled")).toBe("true");
    expect(provider(d, "Gemini").getAttribute("title")).toMatch(/not installed/);
    role(d, "reviewer");
    await waitFor(() => expect(provider(d, "Codex").getAttribute("aria-disabled")).toBe("false"));
    expect(provider(d, "Codex").textContent).toContain("Weak");
  });

  it("starts a read-only role on the picked provider and the run header data carries it", async () => {
    await readyCodex();
    const d = await open();
    await waitFor(() => expect(d.getAllByRole("radio", { name: /^Codex/ }).length).toBe(1));
    role(d, "reviewer");
    fireEvent.click(provider(d, "Codex"));
    fireEvent.input(d.getByLabelText("Prompt"), { target: { value: "Review the order totals" } });
    await waitFor(() => expect((d.getByRole("button", { name: "Start run" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(agentRows().some((r) => r.provider === "codex")).toBe(true));
    const run = agentRows().find((r) => r.provider === "codex")!;
    expect(run).toMatchObject({ role: "reviewer", enforcement: "weak", permission: "readOnly" });
  });

  it("keeps the role's own provider and sends no override when nothing else is picked", async () => {
    const spy = vi.spyOn(ipc, "agentStart");
    const d = await open();
    await waitFor(() => expect(d.getByRole("radiogroup", { name: "Provider" })).toBeTruthy());
    fireEvent.input(d.getByLabelText("Prompt"), { target: { value: "Fix the total" } });
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).not.toHaveProperty("provider");
    spy.mockRestore();
  });

  it("offers 'run without a safety net' only after the engine refused with noSafetyNet, and sends it for that one retry", async () => {
    const spy = vi.spyOn(ipc, "agentStart").mockRejectedValueOnce({ code: "noSafetyNet", message: "Rewind cannot snapshot admin" });
    const d = await open();
    await waitFor(() => expect(d.getByRole("radiogroup", { name: "Provider" })).toBeTruthy());
    expect(d.queryByLabelText(/without a safety net/)).toBeNull();
    fireEvent.input(d.getByLabelText("Prompt"), { target: { value: "Fix the total" } });
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(d.getByLabelText(/without a safety net/)).toBeTruthy());
    expect(spy.mock.calls[0][1]).toBeUndefined();
    fireEvent.click(d.getByLabelText(/without a safety net/));
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1][1]).toEqual({ runWithoutSafetyNet: true });
    spy.mockRestore();
  });
});

describe("<NewRunDialog> Auto", () => {
  it("opens in Auto with no role to pick: Start needs repositories and a prompt only, and sends role auto without a provider", async () => {
    const spy = vi.spyOn(ipc, "agentStart");
    const d = await open("auto");
    expect(d.queryByRole("radiogroup", { name: "Role" })).toBeNull();
    await waitFor(() => expect(d.getByText(/Lead: Sonnet 5.5, effort medium/)).toBeTruthy());
    const start = d.getByRole("button", { name: "Start run" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(d.getByText("Pick at least one repository")).toBeTruthy();
    repo(d, "admin");
    fireEvent.input(d.getByLabelText("Prompt"), { target: { value: "Fix the total" } });
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toEqual({ role: "auto", repoIds: ["admin"], prompt: "Fix the total", mode: "automatic", mcpServers: expect.any(Array) });
    await waitFor(() => expect(agentRows().some((r) => r.role === "auto")).toBe(true));
    spy.mockRestore();
  });

  it("summarises the lead, the roles it hands work to, and the roles it will not use", async () => {
    const d = await open("auto");
    const card = within(await waitFor(() => d.getByRole("region", { name: "Auto" })));
    await waitFor(() => expect(card.getByText("Hands work to")).toBeTruthy());
    for (const name of ["developer", "reviewer", "researcher", "architect"]) expect(card.getByText(name)).toBeTruthy();
    expect(card.getByText("Haiku 4.5")).toBeTruthy();
    expect(card.getByText("1 role is not used")).toBeTruthy();
    expect(card.getByRole("button", { name: "Manage roles" })).toBeTruthy();
    expect(card.getByText("No spend cap, the turn limits still apply")).toBeTruthy();
    expect(card.getByText("Worst case: 540 agent turns")).toBeTruthy();
  });

  it("names a full slot limit instead of an empty run title", async () => {
    const info = await ipc.agentsAutoInfo([]);
    vi.spyOn(ipc, "agentsAutoInfo").mockResolvedValue({ ...info, queuedBehind: { kind: "slots", agentId: "", title: "" } });
    const d = await open("auto");
    expect((await d.findByText(/Waits for a free agent slot/)).textContent).toBeTruthy();
    expect(d.queryByText(/Waits for .. to finish/)).toBeNull();
  });

  it("shows why the run would wait and the spend cap, before Start", async () => {
    const info = await ipc.agentsAutoInfo([]);
    vi.spyOn(ipc, "agentsAutoInfo").mockResolvedValue({ ...info, queuedBehind: { kind: "repoWriter", agentId: "a-1", title: "Fix the booking form" }, maxBudgetUsd: 10 });
    const d = await open("auto");
    expect((await d.findByText(/Waits for .Fix the booking form. to finish writing to this repository/)).textContent).toBeTruthy();
    expect(d.getByText("Spend cap: 10 USD per run")).toBeTruthy();
  });

  it("shows a loading state while the answer is on its way: no role picker flashes in, Start waits", async () => {
    let resolve!: (v: Awaited<ReturnType<typeof ipc.agentsAutoInfo>>) => void;
    const real = await ipc.agentsAutoInfo([]);
    vi.spyOn(ipc, "agentsAutoInfo").mockReturnValue(new Promise((r) => (resolve = r)));
    const d = await open("auto");
    expect(await d.findByRole("status")).toBeTruthy();
    expect(d.getAllByText("Checking what Auto can use...").length).toBeGreaterThan(0);
    expect(d.queryByRole("radiogroup", { name: "Role" })).toBeNull();
    repo(d, "admin");
    fireEvent.input(d.getByLabelText("Prompt"), { target: { value: "x" } });
    expect((d.getByRole("button", { name: "Start run" }) as HTMLButtonElement).disabled).toBe(true);
    resolve(real);
    await waitFor(() => expect(d.getByText("Hands work to")).toBeTruthy());
    await waitFor(() => expect((d.getByRole("button", { name: "Start run" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("falls back to the role picker only after the answer says Auto is unavailable, and says why", async () => {
    const real = await ipc.agentsAutoInfo([]);
    vi.spyOn(ipc, "agentsAutoInfo").mockResolvedValue({ ...real, available: false, reason: "notLoggedIn", delegates: [] });
    const d = await open("auto");
    await waitFor(() => expect(d.getByRole("radiogroup", { name: "Role" })).toBeTruthy());
    expect(d.getByText("Auto needs Claude: Claude is not logged in")).toBeTruthy();
    expect(d.queryByRole("button", { name: "Back to Auto" })).toBeNull();
  });

  it("does not fall back when the roles are merely none: Auto works alone", async () => {
    const real = await ipc.agentsAutoInfo([]);
    vi.spyOn(ipc, "agentsAutoInfo").mockResolvedValue({ ...real, delegates: [], excluded: [], delegationOff: "delegationDisabled" });
    const d = await open("auto");
    expect(await d.findByText("No roles are available, so Auto works alone.")).toBeTruthy();
    expect(d.getByText(/Limited: delegation is switched off/)).toBeTruthy();
    expect(d.queryByRole("radiogroup", { name: "Role" })).toBeNull();
  });

  it("'Run as role...' reveals today's role and provider pickers with their blockers, and Back to Auto returns", async () => {
    const d = await open("auto");
    await waitFor(() => expect(d.getByText("Hands work to")).toBeTruthy());
    fireEvent.click(d.getByRole("button", { name: "Run as role..." }));
    expect(await d.findByRole("radiogroup", { name: "Role" })).toBeTruthy();
    expect(d.getByRole("radiogroup", { name: "Provider" })).toBeTruthy();
    fireEvent.click(await d.findByRole("button", { name: "Back to Auto" }));
    await waitFor(() => expect(d.queryByRole("radiogroup", { name: "Role" })).toBeNull());
    expect(d.getByText("Hands work to")).toBeTruthy();
  });

  it("lists repository roles that wait for trust, scoped to the picked repositories, with a Trust button", async () => {
    const d = await open("auto");
    await waitFor(() => expect(d.getByText("Hands work to")).toBeTruthy());
    expect(d.queryByRole("list", { name: "Roles waiting for your trust" })).toBeNull();
    repo(d, "shop-mobile");
    const list = within(await d.findByRole("list", { name: "Roles waiting for your trust" }));
    expect(list.getByText(/The role deploy-helper \(.*\) comes from a repository/)).toBeTruthy();
    const spy = vi.spyOn(ipc.roles, "setTrust");
    fireEvent.click(list.getByRole("button", { name: "Trust this repo role" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("deploy-helper", expect.any(String), true));
    await waitFor(() => expect(d.queryByRole("list", { name: "Roles waiting for your trust" })).toBeNull());
  });

  it("shows the one-time derivation card with what each role may do, and remembers it was read", async () => {
    const d = await open("auto");
    const card = await d.findByText(/Roles now take their permission from their tools: developer \(edits\)/);
    expect(card.textContent).toMatch(/researcher \(read-only\)/);
    expect(card.textContent).toMatch(/reviewer \(runs commands, asks\)/);
    fireEvent.click(d.getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(d.queryByText(/Roles now take their permission from their tools/)).toBeNull());
    expect((await ipc.settings.get("roles")).derivationNoticeDone).toBe(true);
  });

  it("Auto on another provider is one agent with the neutral read-only role, started through today's gating", async () => {
    await readyCodex();
    const spy = vi.spyOn(ipc, "agentStart");
    const d = await open("auto");
    await waitFor(() => expect(d.getByRole("radiogroup", { name: "Provider of this run" })).toBeTruthy());
    fireEvent.click(await waitFor(() => d.getByRole("radio", { name: /^Codex/ })));
    expect(await d.findByText(/Codex: one agent works on its own with the read-only default role/)).toBeTruthy();
    repo(d, "admin");
    fireEvent.input(d.getByLabelText("Prompt"), { target: { value: "Which routes touch orders?" } });
    await waitFor(() => expect((d.getByRole("button", { name: "Start run" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    // Codex cannot take Automatic, and its write gate refuses the modes above Plan: the nearest mode it may run in is Plan, and it has no MCP.
    expect(spy.mock.calls[0][0]).toEqual({ role: "researcher", repoIds: ["admin"], prompt: "Which routes touch orders?", provider: "codex", mode: "readOnly", mcpServers: [] });
    spy.mockRestore();
  });
});

describe("<NewRunDialog> permission mode", () => {
  const group = (d: ReturnType<typeof within>) => d.getByRole("radiogroup", { name: "Permission mode" });
  const cards = (d: ReturnType<typeof within>) => within(group(d)).getAllByRole("radio");
  const checkedMode = (d: ReturnType<typeof within>) => cards(d).filter((c) => c.getAttribute("aria-checked") === "true").map((c) => c.getAttribute("data-mode"));
  const card = (d: ReturnType<typeof within>, mode: string) => cards(d).find((c) => c.getAttribute("data-mode") === mode)!;
  const ready = async (d: ReturnType<typeof within>, prompt = "Fix the total") => {
    repo(d, "admin");
    fireEvent.input(d.getByLabelText("Prompt"), { target: { value: prompt } });
    await waitFor(() => expect((d.getByRole("button", { name: "Start run" }) as HTMLButtonElement).disabled).toBe(false));
  };

  it("offers the five modes with their one-line explanations, Automatic selected the first time", async () => {
    const d = await open("auto");
    await waitFor(() => expect(cards(d)).toHaveLength(5));
    expect(cards(d).map((c) => c.getAttribute("data-mode"))).toEqual(["readOnly", "ask", "edit", "automatic", "bypass"]);
    expect(checkedMode(d)).toEqual(["automatic"]);
    expect(card(d, "ask").textContent).toContain("Asks before every edit and every command.");
    expect(card(d, "bypass").getAttribute("data-tone")).toBe("danger");
    expect(card(d, "bypass").getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("opens with the mode used last, and a remembered Bypass becomes Automatic", async () => {
    await ipc.settings.set("runs", { lastMode: "ask" });
    const d = await open("auto");
    await waitFor(() => expect(checkedMode(d)).toEqual(["ask"]));
    cleanup();
    setNewRunOpen(false);
    await ipc.settings.set("runs", { lastMode: "bypass" });
    const d2 = await open("auto");
    await waitFor(() => expect(cards(d2)).toHaveLength(5));
    expect(checkedMode(d2)).toEqual(["automatic"]);
  });

  it("remembers the mode of a started run for the next dialog", async () => {
    const set = vi.spyOn(ipc.settings, "set");
    const d = await open("auto");
    await waitFor(() => expect(cards(d)).toHaveLength(5));
    fireEvent.click(card(d, "ask"));
    await ready(d);
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("runs", { lastMode: "ask" }));
    expect((await ipc.settings.get("runs")).lastMode).toBe("ask");
  });

  it("sends the chosen mode and the picked MCP servers, and no confirmation for a mode that needs none", async () => {
    const spy = vi.spyOn(ipc, "agentStart");
    const d = await open("auto");
    await waitFor(() => expect(cards(d)).toHaveLength(5));
    fireEvent.click(card(d, "edit"));
    expect(checkedMode(d)).toEqual(["edit"]);
    await ready(d);
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toMatchObject({ role: "auto", mode: "edit", mcpServers: expect.any(Array) });
    expect(spy.mock.calls[0][1]).toBeUndefined();
    await waitFor(() => expect(agentRows().find((r) => r.role === "auto")?.permission).toBe("edit"));
  });

  it("hides Automatic and Bypass for a provider that cannot run them, and clamps the mode", async () => {
    await readyCodex();
    const d = await open();
    await waitFor(() => expect(cards(d)).toHaveLength(5));
    role(d, "reviewer");
    fireEvent.click(provider(d, "Codex"));
    await waitFor(() => expect(cards(d).map((c) => c.getAttribute("data-mode"))).toEqual(["readOnly", "ask", "edit"]));
    expect(checkedMode(d)).toEqual(["readOnly"]);
  });

  it("greys out the modes that change files on a provider below the write tier, with the reason", async () => {
    await readyCodex();
    const d = await open();
    role(d, "reviewer");
    fireEvent.click(await waitFor(() => provider(d, "Codex")));
    await waitFor(() => expect(cards(d)).toHaveLength(3));
    expect(card(d, "readOnly").getAttribute("aria-disabled")).toBeNull();
    for (const m of ["ask", "edit"]) {
      expect(card(d, m).getAttribute("aria-disabled")).toBe("true");
      expect(card(d, m).title).toMatch(/only read-only roles run on it/);
    }
  });

  it("preselects Plan for a read-only role and says so, until a card is clicked", async () => {
    const d = await open();
    await waitFor(() => expect(cards(d)).toHaveLength(5));
    role(d, "reviewer");
    await waitFor(() => expect(checkedMode(d)).toEqual(["readOnly"]));
    expect(d.getByText("This role only reads, so Plan is preselected.")).toBeTruthy();
    role(d, "developer");
    await waitFor(() => expect(checkedMode(d)).toEqual(["automatic"]));
    expect(d.queryByText("This role only reads, so Plan is preselected.")).toBeNull();
    // A click wins over the role: the next role no longer moves it.
    fireEvent.click(card(d, "edit"));
    role(d, "reviewer");
    await new Promise((r) => setTimeout(r, 30));
    expect(checkedMode(d)).toEqual(["edit"]);
    expect(d.queryByText("This role only reads, so Plan is preselected.")).toBeNull();
  });

  it("opens a confirmation for Bypass: Cancel keeps the previous mode, Use Bypass selects it and sends the confirmation once", async () => {
    const spy = vi.spyOn(ipc, "agentStart");
    const d = await open("auto");
    await waitFor(() => expect(cards(d)).toHaveLength(5));
    fireEvent.click(card(d, "bypass"));
    const alert = await screen.findByRole("alertdialog", { name: "Switch on Bypass?" });
    expect(checkedMode(d)).toEqual(["automatic"]);
    fireEvent.click(within(alert).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(checkedMode(d)).toEqual(["automatic"]);
    fireEvent.click(card(d, "bypass"));
    fireEvent.click(await screen.findByRole("button", { name: "Use Bypass" }));
    await waitFor(() => expect(checkedMode(d)).toEqual(["bypass"]));
    await ready(d);
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toMatchObject({ mode: "bypass" });
    expect(spy.mock.calls[0][1]).toEqual({ confirmBypass: true });
  });

  it("forgets the confirmation when another mode is picked, and when the dialog is opened again", async () => {
    const spy = vi.spyOn(ipc, "agentStart");
    const d = await open("auto");
    await waitFor(() => expect(cards(d)).toHaveLength(5));
    fireEvent.click(card(d, "bypass"));
    fireEvent.click(await screen.findByRole("button", { name: "Use Bypass" }));
    await waitFor(() => expect(checkedMode(d)).toEqual(["bypass"]));
    fireEvent.click(card(d, "ask"));
    await ready(d);
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toMatchObject({ mode: "ask" });
    expect(spy.mock.calls[0][1]).toBeUndefined();
  });

  it("shows the host's refusal in the dialog's error line and stays open", async () => {
    vi.spyOn(ipc, "agentStart").mockRejectedValueOnce({ code: "writeLease", message: "lease busy" });
    const d = await open("auto");
    await waitFor(() => expect(cards(d)).toHaveLength(5));
    await ready(d);
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    expect((await d.findByRole("alert")).textContent).toBe("Another run is writing to this repository. Wait for it, or pick Ask.");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(checkedMode(d)).toEqual(["automatic"]);
  });

  it("shows the error of the selected MCP servers in the same line", async () => {
    vi.spyOn(ipc, "agentStart").mockRejectedValueOnce({ code: "mcpSecretMissing", message: "raw host text" });
    const d = await open("auto");
    await waitFor(() => expect(cards(d)).toHaveLength(5));
    await ready(d);
    fireEvent.click(d.getByRole("button", { name: "Start run" }));
    const line = await d.findByRole("alert");
    expect(line.textContent).not.toBe("raw host text");
    expect(line.textContent).not.toMatch(/^mcp\./);
  });

  it("asks the host about the queue with the chosen mode", async () => {
    const info = vi.spyOn(ipc, "agentsAutoInfo");
    const d = await open("auto");
    await waitFor(() => expect(cards(d)).toHaveLength(5));
    fireEvent.click(card(d, "readOnly"));
    await waitFor(() => expect(info).toHaveBeenLastCalledWith([], "readOnly"));
    fireEvent.click(card(d, "edit"));
    await waitFor(() => expect(info).toHaveBeenLastCalledWith([], "edit"));
  });

  it("is a radio group with one tab stop", async () => {
    const d = await open("auto");
    await waitFor(() => expect(cards(d)).toHaveLength(5));
    expect(cards(d).map((c) => c.tabIndex)).toEqual([-1, -1, -1, 0, -1]);
    expect(within(group(d)).getByRole("radio", { name: /^Plan/ })).toBeTruthy();
  });
});
