import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { capsOfProvider } from "../../ipc/providerCaps";
import type { AgentRow } from "../../store/agents";
import type { AgentSummary, PermissionMode } from "../../store/agent-types";
import { installDomStubs } from "../../store/testing-u2";
import { toast } from "../../ui-kit";
import { RunHeader } from "./RunHeader";

installDomStubs();
afterEach(() => {
  vi.restoreAllMocks();
  toast.clear();
  cleanup();
});

const row = (over: Partial<AgentRow>): AgentRow => ({
  agentId: "a1",
  provider: "claude",
  role: "reviewer",
  model: "claude-sonnet-5-5",
  title: "t",
  status: "running",
  permission: "readOnly",
  requested: { permission: "readOnly" },
  repoIds: ["admin"],
  caps: capsOfProvider("claude"),
  enforcement: "bestEffort",
  startedAt: 0,
  needs: 0,
  ...over,
});

const show = (a: AgentRow) => render(() => <RunHeader agent={a} stopping={false} onInterrupt={() => {}} onRewind={() => {}} />);

describe("<RunHeader> provider", () => {
  it("shows the provider mark and name, and the tier of this run", () => {
    show(row({ provider: "gemini", model: "gemini-pro", enforcement: "weak", caps: capsOfProvider("gemini") }));
    expect(screen.getByTitle("Provider gemini").textContent).toBe("Gemini");
    expect(document.querySelector('.run-header__role .pmark[data-provider="gemini"]')?.textContent).toBe("Ge");
    expect(screen.getByRole("note").getAttribute("aria-label")).toMatch(/Enforcement: Weak/);
  });

  it("shows cost as n/a, never $0, for a provider that reports none", () => {
    show(row({ provider: "gemini", caps: { ...capsOfProvider("gemini"), usage: { cap: "no", note: "tokens only" } } }));
    expect(document.querySelector(".run-header__cost")?.textContent).toBe("cost n/a");
  });

  it("keeps Claude as before: name chip and the best-effort tier", () => {
    show(row({}));
    expect(screen.getByTitle("Provider claude").textContent).toBe("Claude");
    expect(screen.getByRole("note").getAttribute("aria-label")).toMatch(/Enforcement: Best effort/);
  });
});

const ALL: PermissionMode[] = ["readOnly", "ask", "edit", "automatic", "bypass"];
const live = (over: Partial<AgentRow> = {}) => row({ permission: "ask", requested: { permission: "ask" }, switchableModes: ALL, ...over });
const trigger = () => screen.getByRole("button", { name: /^Permission mode: .*\. Change it$/ });
const openMenu = async () => {
  fireEvent.click(trigger());
  return screen.findByRole("menu");
};
const pick = async (name: RegExp) => fireEvent.click(await screen.findByRole("menuitemradio", { name }));
const summaryIn = (mode: PermissionMode): AgentSummary => ({ ...(live() as AgentSummary), permission: mode });
const lastToast = () => toast.toasts().at(-1);

describe("<RunHeader> mode chip", () => {
  it("is the plain badge for a provider that cannot switch live", () => {
    show(row({ provider: "gemini", caps: capsOfProvider("gemini"), permission: "readOnly" }));
    expect(screen.getByTitle("Permission mode: Plan / read only").textContent).toBe("Mode: Plan / read only");
    expect(screen.queryByRole("button", { name: /Change it/ })).toBeNull();
    expect(screen.queryByText("BYPASS")).toBeNull();
  });

  it("is a menu of the modes the run can be switched to, in policy order, with the current one checked", async () => {
    show(live({ switchableModes: ["bypass", "ask", "readOnly", "edit", "automatic"] }));
    expect(trigger().textContent).toBe("Ask");
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    const menu = await openMenu();
    expect(within(menu).getByText("Permission mode")).toBeTruthy();
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.querySelector(".ui-menu__title")?.textContent)).toEqual(["Plan / read only", "Ask", "Edit automatically", "Automatic", "Bypass"]);
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["false", "true", "false", "false", "false"]);
    // Each item carries the mode's one-line explanation.
    expect(items[0].querySelector(".ui-menu__desc")?.textContent).toBe("Reads, searches and plans only. Nothing is written, only safe read-only commands run, and a plan ends in an approval you can answer.");
    expect(items[4].hasAttribute("data-danger")).toBe(true);
  });

  it("offers only the modes the provider lists", async () => {
    show(live({ switchableModes: ["readOnly", "ask", "edit"] }));
    const menu = await openMenu();
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(3);
  });

  it("shows the effective mode, which beats the recorded one", () => {
    show(live({ permission: "ask", effective: { permission: "automatic" } }));
    expect(trigger().textContent).toBe("Automatic");
    expect(trigger().getAttribute("aria-label")).toBe("Permission mode: Automatic. Change it");
  });

  it("switches at once to a mode that is not Bypass, then says what happened", async () => {
    const spy = vi.spyOn(ipc, "agentSetPermission").mockResolvedValue(summaryIn("edit"));
    show(live());
    await openMenu();
    await pick(/^Edit automatically/);
    await waitFor(() => expect(lastToast()).toMatchObject({ tone: "ok", title: "Mode: Edit automatically" }));
    expect(spy).toHaveBeenCalledWith("a1", "edit", undefined);
    // Loosening says nothing about running programs.
    expect(lastToast()?.description).toBeUndefined();
  });

  it("does nothing when the current mode is picked again", async () => {
    const spy = vi.spyOn(ipc, "agentSetPermission");
    show(live());
    await openMenu();
    await pick(/^Ask/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a tightening adds that programs already started keep running", async () => {
    vi.spyOn(ipc, "agentSetPermission").mockResolvedValue(summaryIn("readOnly"));
    show(live({ permission: "automatic", requested: { permission: "automatic" } }));
    await openMenu();
    await pick(/^Plan/);
    await waitFor(() => expect(lastToast()).toMatchObject({ title: "Mode: Plan / read only", description: "Programs the agent already started keep running." }));
  });

  it("shows the chip busy while the switch is in flight", async () => {
    let finish!: (s: AgentSummary) => void;
    vi.spyOn(ipc, "agentSetPermission").mockReturnValue(new Promise((r) => (finish = r)));
    show(live());
    await openMenu();
    await pick(/^Plan/);
    await waitFor(() => expect(trigger().getAttribute("aria-busy")).toBe("true"));
    finish(summaryIn("readOnly"));
    await waitFor(() => expect(trigger().getAttribute("aria-busy")).toBeNull());
  });

  it("explains a refused switch in the user's words", async () => {
    vi.spyOn(ipc, "agentSetPermission").mockRejectedValue({ code: "writeLease", message: "lease" });
    show(live());
    await openMenu();
    await pick(/^Edit automatically/);
    await waitFor(() => expect(lastToast()).toMatchObject({ tone: "danger", title: "Could not change the mode", description: "Another run is writing to this repository. Wait for it, or pick Ask." }));
  });

  it("says the IDE already enforces a tighter mode when the agent could not follow it", async () => {
    vi.spyOn(ipc, "agentSetPermission").mockRejectedValue({ code: "modeNotApplied" });
    show(live());
    await openMenu();
    await pick(/^Plan/);
    await waitFor(() => expect(lastToast()).toMatchObject({ tone: "warn", title: "The IDE already enforces Plan / read only; the agent's own mode follows at the next start." }));
  });

  it("reports a loosening the agent did not take as a failure", async () => {
    vi.spyOn(ipc, "agentSetPermission").mockRejectedValue({ code: "modeNotApplied" });
    show(live());
    await openMenu();
    await pick(/^Automatic/);
    await waitFor(() => expect(lastToast()).toMatchObject({ tone: "danger", description: "The agent did not take the new mode." }));
  });

  it("asks before Bypass: Cancel changes nothing, Use Bypass sends the confirmation", async () => {
    const spy = vi.spyOn(ipc, "agentSetPermission").mockResolvedValue(summaryIn("bypass"));
    show(live());
    await openMenu();
    await pick(/^Bypass/);
    const dialog = await screen.findByRole("alertdialog", { name: "Switch on Bypass?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(spy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await openMenu();
    await pick(/^Bypass/);
    fireEvent.click(await screen.findByRole("button", { name: "Use Bypass" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("a1", "bypass", { confirmBypass: true }));
  });

  it("shows a persistent red BYPASS chip and the danger edge for as long as the effective mode is Bypass", () => {
    const { unmount } = show(live({ effective: { permission: "bypass" } }));
    const chip = screen.getByText("BYPASS");
    expect(chip.closest('[role="status"]')?.getAttribute("title")).toMatch(/^Bypass: no prompts, no folder boundary/);
    expect(chip.closest(".ui-badge")?.getAttribute("data-tone")).toBe("danger");
    expect(chip.closest(".ui-badge")?.getAttribute("data-variant")).toBe("solid");
    expect(document.querySelector(".run-header")?.hasAttribute("data-bypass")).toBe(true);
    unmount();
    show(live({ effective: { permission: "automatic" } }));
    expect(screen.queryByText("BYPASS")).toBeNull();
    expect(document.querySelector(".run-header")?.hasAttribute("data-bypass")).toBe(false);
  });

  it("puts what the MCP servers would run unasked on the Automatic and Bypass items", async () => {
    show(live({ mcp: [{ name: "fs", exposed: 2, hasSecretEnv: true }] }));
    const menu = await openMenu();
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items[3].querySelector(".ui-menu__desc")?.textContent).toContain("In this mode, 2 tools of fs that change things run without asking.");
    expect(items[3].querySelector(".ui-menu__desc")?.textContent).toContain("fs keep a secret in their environment");
    expect(items[4].querySelector(".ui-menu__desc")?.textContent).toContain("2 tools of fs");
    expect(items[1].querySelector(".ui-menu__desc")?.textContent).not.toContain("fs");
  });
});
