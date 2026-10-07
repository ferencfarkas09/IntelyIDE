import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { installDomStubs } from "../../store/testing-u2";
import RolesSection from "./RolesSection";

installDomStubs();
vi.setConfig({ testTimeout: 30000 });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const rows = () => [...document.querySelectorAll<HTMLElement>("tbody.roles__role")];
const row = (name: string) => [...document.querySelectorAll<HTMLInputElement>('input[aria-label="Role name"]')].find((i) => i.value === name)!.closest("tbody")!;
const ready = async (count = 5) => {
  render(() => <RolesSection />);
  await waitFor(() => expect(rows()).toHaveLength(count));
};
const panelOf = (name: string) => row(name).querySelector<HTMLElement>("tr.roles__details")!;
const details = async (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: `Show details of ${name}` }));
  return within(await waitFor(() => panelOf(name) ?? Promise.reject(new Error("closed"))));
};

describe("<RolesSection> groups", () => {
  it("shows ONE row per name with its scope chips, copy count and a Copies-differ chip (never one row per file)", async () => {
    await ready();
    expect(rows().filter((r) => r.querySelector<HTMLInputElement>('input[aria-label="Role name"]')?.value === "developer")).toHaveLength(1);
    const dev = within(row("developer"));
    expect(dev.getByText("Global")).toBeTruthy();
    expect(dev.getByText("admin")).toBeTruthy();
    expect(dev.getByText("backend")).toBeTruthy();
    expect(dev.getByText("3 copies")).toBeTruthy();
    expect(dev.getByText("Copies differ")).toBeTruthy();
    // a built-in without a file is a row of its own, marked Built-in
    expect(within(row("researcher")).getByText("Built-in")).toBeTruthy();
  });

  it("says the permission in plain words and why: tools, overlay, and runs-commands-but-cannot-edit", async () => {
    await ready();
    expect(within(row("reviewer")).getByText("Runs commands (each asks first), cannot edit files.")).toBeTruthy();
    expect(within(row("developer")).getByText(/Can edit files in the repository/)).toBeTruthy();
    const dev = await details("developer");
    expect(dev.getByText(/Because its file lists tools that change things/)).toBeTruthy();
    const arch = await details("architect");
    expect(arch.getByText("Because you set it here.")).toBeTruthy();
    expect(arch.getByRole("button", { name: "Reset to automatic" })).toBeTruthy();
    const researcher = await details("researcher");
    expect(researcher.getByText(/Built-in role/)).toBeTruthy();
  });

  it("lists the copies as identical or differing, with the field diff, and pins one copy and releases it again", async () => {
    await ready();
    const panel = await details("developer");
    expect(panel.getAllByText("Identical").length).toBeGreaterThanOrEqual(2);
    expect(panel.getByText("Differs")).toBeTruthy();
    expect(panel.getByRole("table", { name: "Copy in admin" })).toBeTruthy();
    expect(panel.getByText("the global copy is used")).toBeTruthy();
    const pinButtons = panel.getAllByRole("button", { name: "Always use this copy" });
    // the admin copy is the second one (global, admin, backend)
    fireEvent.click(pinButtons[1]);
    await waitFor(() => expect(within(panelOf("developer")).getByText("pinned by you")).toBeTruthy());
    fireEvent.click(within(panelOf("developer")).getByRole("button", { name: "Back to default" }));
    await waitFor(() => expect(within(panelOf("developer")).getByText("the global copy is used")).toBeTruthy());
  });

  it("marks a repository role Untrusted and approves it by its hash with the Trust button", async () => {
    await ready();
    const helper = within(row("deploy-helper"));
    expect(helper.getByText("Untrusted")).toBeTruthy();
    // a repository file is limited to Ask, and the row says so
    expect(helper.getByRole("button", { name: "Trust this repo role" })).toBeTruthy();
    const spy = vi.spyOn(ipc.roles, "setTrust");
    fireEvent.click(helper.getByRole("button", { name: "Trust this repo role" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("deploy-helper", expect.stringMatching(/^h/), true));
    await waitFor(() => expect(within(row("deploy-helper")).queryByText("Untrusted")).toBeNull());
  });

  it("hides a role (files untouched) and brings it back through the Show hidden toggle", async () => {
    await ready();
    const before = JSON.stringify((await ipc.roles.list()).map((r) => r.id));
    fireEvent.click(within(row("architect")).getByRole("button", { name: "Hide" }));
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(JSON.stringify((await ipc.roles.list()).map((r) => r.id))).toBe(before);
    const toggle = screen.getByRole("button", { name: "Show 2 hidden roles" });
    fireEvent.click(toggle);
    await waitFor(() => expect(rows()).toHaveLength(6));
    expect(within(row("architect")).getByText("Hidden")).toBeTruthy();
    fireEvent.click(within(row("architect")).getByRole("button", { name: "Show again" }));
    await waitFor(() => expect(within(row("architect")).queryByText("Hidden")).toBeNull());
  });

  it("gives a built-in no Delete, only a hint to hide it", async () => {
    await ready();
    const panel = await details("researcher");
    expect(panel.queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(panel.getByText("Built-in roles have no file. Hide them instead.")).toBeTruthy();
  });

  it("deletes a file only after the exact name is typed: paths, backup folder and warnings are shown, the confirm is gated", async () => {
    await ready();
    const panel = await details("developer");
    const del = panel.getAllByRole("button", { name: "Delete file..." });
    fireEvent.click(del[del.length - 1]); // the backend copy (identical)
    const dialog = within(await screen.findByRole("alertdialog"));
    await waitFor(() => expect(dialog.getByText(/shop-backend\/\.claude\/agents\/developer\.md/)).toBeTruthy());
    expect(dialog.getByText(/role-backups/)).toBeTruthy();
    expect(dialog.queryByText(/also affects your own Claude Code sessions/)).toBeNull(); // a repository file, not a global one
    expect(dialog.getByText(/shows up in git as a change that you commit yourself/)).toBeTruthy();
    const confirm = dialog.getByRole("button", { name: "Delete file" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    const typed = dialog.getByLabelText("Role name to confirm");
    fireEvent.input(typed, { target: { value: "develope" } });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.input(typed, { target: { value: "developer" } });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    const spy = vi.spyOn(ipc.roles, "delete");
    fireEvent.click(confirm);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(["developer@backend"], "developer", undefined));
    await waitFor(() => expect(within(row("developer")).getByText("2 copies")).toBeTruthy());
  });

  it("shows the engine's refusal translated from its code, never its English text", async () => {
    await ready();
    const panel = await details("developer");
    vi.spyOn(ipc.roles, "delete").mockRejectedValue({ code: "readOnly", message: "role delete refused: the app runs read-only (INTELY_READONLY)" });
    fireEvent.click(panel.getAllByRole("button", { name: "Delete file..." })[0]);
    const dialog = within(await screen.findByRole("alertdialog"));
    await waitFor(() => expect(dialog.getByLabelText("Role name to confirm")).toBeTruthy());
    fireEvent.input(dialog.getByLabelText("Role name to confirm"), { target: { value: "developer" } });
    fireEvent.click(await waitFor(() => { const b = dialog.getByRole("button", { name: "Delete file" }); expect(b.hasAttribute("disabled")).toBe(false); return b; }));
    expect((await dialog.findByRole("alert")).textContent).toBe("This IntelyIDE runs read-only, so nothing can be deleted.");
  });

  it("asks for a second typed confirmation when the global agents folder is a link", async () => {
    await ready();
    vi.spyOn(ipc.roles, "deletePreview").mockResolvedValue({ name: "developer", files: [{ id: "developer", path: "~/.claude/agents/developer.md", scope: "global", symlinkTarget: "/dotfiles/agents/developer.md" }], backupDir: "/b", linkTarget: "/dotfiles/agents" });
    const panel = await details("developer");
    fireEvent.click(panel.getAllByRole("button", { name: "Delete file..." })[0]);
    const dialog = within(await screen.findByRole("alertdialog"));
    fireEvent.input(await dialog.findByLabelText("Role name to confirm"), { target: { value: "developer" } });
    expect(dialog.getByText(/also affects your own Claude Code sessions/)).toBeTruthy();
    const confirm = dialog.getByRole("button", { name: "Delete file" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.input(dialog.getByLabelText("Role name again, for the linked folder"), { target: { value: "developer" } });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
  });
});

describe("<RolesSection> notices", () => {
  it("has no shadow-notice bar any more", async () => {
    await ready();
    expect(screen.queryByRole("status", { name: /Your own/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow edit" })).toBeNull();
  });

  it("lists roles pinned by an older version and switches them to automatic one by one or all at once", async () => {
    vi.spyOn(ipc.roles, "status").mockResolvedValue({
      overlayCorrupt: false,
      globalDir: "~/.claude/agents",
      skippedDirs: [],
      mismatches: [
        { id: "developer", overlay: "readOnly", derived: "edit", reason: "tools:write" },
        { id: "reviewer", overlay: "readOnly", derived: "edit", reason: "tools:write" },
      ],
    });
    const use = vi.spyOn(ipc.roles, "useAutomatic").mockResolvedValue();
    await ready();
    const bar = within(await screen.findByRole("status", { name: "Roles with a pinned permission" }));
    expect(bar.getByText(/2 roles have a permission pinned by an older version/)).toBeTruthy();
    expect(bar.getByText("developer: pinned Read-only, its file says Edit")).toBeTruthy();
    fireEvent.click(bar.getAllByRole("button", { name: "Use automatic" })[0]);
    await waitFor(() => expect(use).toHaveBeenCalledWith(["developer"]));
    fireEvent.click(bar.getByRole("button", { name: "Use automatic for all" }));
    await waitFor(() => expect(use).toHaveBeenLastCalledWith(["developer", "reviewer"]));
  });

  it("shows the repair notice for a damaged settings file and resets it after a confirmation", async () => {
    const st = { overlayCorrupt: true, overlayBackup: "/data/roles-overlay.json.bak", globalDir: "~/.claude/agents", skippedDirs: [], mismatches: [] };
    const status = vi.spyOn(ipc.roles, "status").mockResolvedValue(st);
    const reset = vi.spyOn(ipc.roles, "resetOverlay").mockResolvedValue();
    await ready();
    expect((await screen.findByRole("alert", { name: "The roles settings file is damaged" })).textContent).toMatch(/Every role is read-only until it is repaired/);
    fireEvent.click(screen.getByRole("button", { name: "Reset the settings file" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reset" }));
    await waitFor(() => expect(reset).toHaveBeenCalled());
    status.mockRestore();
  });

  it("says a repository agents folder was skipped because it is a link, and where the global folder points", async () => {
    vi.spyOn(ipc.roles, "status").mockResolvedValue({ overlayCorrupt: false, globalDir: "~/.claude/agents", globalDirTarget: "/dotfiles/agents", mismatches: [], skippedDirs: [{ repoId: "pos", path: "/p/.claude/agents", code: "agentsDirSymlink", target: "/elsewhere" }] });
    await ready();
    expect((await screen.findByRole("status", { name: "A repository agents folder was skipped" })).textContent).toMatch(/agents folder of .*pos.* is a link, so the roles in it are skipped/);
    expect(screen.getByText("~/.claude/agents is a link to /dotfiles/agents.")).toBeTruthy();
  });

  it("shows the one-time derivation notice and remembers the dismissal", async () => {
    await ready();
    await screen.findByRole("status", { name: "Roles take their permission from their file" });
    const notice = within(await screen.findByRole("status", { name: "Roles take their permission from their file" }));
    expect(notice.getByText(/roles? can now edit files: .*developer/)).toBeTruthy();
    fireEvent.click(notice.getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Roles take their permission from their file" })).toBeNull());
    expect((await ipc.settings.get("roles")).derivationNoticeDone).toBe(true);
    cleanup();
    await ready();
    expect(screen.queryByRole("status", { name: "Roles take their permission from their file" })).toBeNull();
  });

  it("saves a permission the user picks as an explicit choice, and Reset to automatic goes through useAutomatic", async () => {
    await ready();
    const save = vi.spyOn(ipc.roles, "save");
    fireEvent.change(within(row("reviewer")).getByLabelText("Permission mode"), { target: { value: "ask" } });
    fireEvent.click(within(row("reviewer")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({ id: "reviewer", permission: "ask", permissionExplicit: true });
    const use = vi.spyOn(ipc.roles, "useAutomatic");
    const panel = await details("reviewer");
    fireEvent.click(await waitFor(() => panel.getByRole("button", { name: "Reset to automatic" })));
    await waitFor(() => expect(use).toHaveBeenCalledWith(["reviewer"]));
  });

  it("refuses to save a reserved name with the translated message", async () => {
    await ready();
    const arch = within(row("architect"));
    fireEvent.input(arch.getByLabelText("Role name"), { target: { value: "explore" } });
    fireEvent.click(await waitFor(() => arch.getByRole("button", { name: "Save" })));
    expect((await screen.findAllByText("explore is reserved and cannot be used as a role name.")).length).toBeGreaterThan(0);
  });
});

describe("<RolesSection> Auto run settings", () => {
  it("has a switch for the user's global CLAUDE.md that is on by default and stored as agents.includeUserMemory", async () => {
    await ready();
    const block = within(screen.getByRole("region", { name: "Auto run" }));
    const sw = block.getByRole("switch", { name: "Include my global CLAUDE.md in agent runs" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(block.getByText(/never leaves this machine except in the model prompt/)).toBeTruthy();
    fireEvent.click(sw);
    await waitFor(async () => expect((await ipc.settings.get("agents")).includeUserMemory).toBe(false));
    fireEvent.click(block.getByRole("switch", { name: "Include my global CLAUDE.md in agent runs" }));
    await waitFor(async () => expect((await ipc.settings.get("agents")).includeUserMemory).toBe(true));
  });

  it("stores the lead model, effort, cap, spend cap and the two kill switches in the agents namespace", async () => {
    await ready();
    const block = within(screen.getByRole("region", { name: "Auto run" }));
    fireEvent.change(block.getByLabelText("Lead model"), { target: { value: "claude-opus-5-5" } });
    await waitFor(async () => expect((await ipc.settings.get("agents")).defaultModel).toBe("claude-opus-5-5"));
    fireEvent.change(block.getByLabelText("Lead effort"), { target: { value: "high" } });
    await waitFor(async () => expect((await ipc.settings.get("agents")).defaultEffort).toBe("high"));
    const cap = block.getByLabelText("Most roles started per run");
    fireEvent.input(cap, { target: { value: "99" } });
    expect(cap.closest(".ui-input")?.getAttribute("data-invalid")).toBe("");
    fireEvent.input(cap, { target: { value: "8" } });
    fireEvent.change(cap, { target: { value: "8" } });
    await waitFor(async () => expect((await ipc.settings.get("agents")).delegationCap).toBe(8));
    fireEvent.change(block.getByLabelText("Spend cap per run (USD)"), { target: { value: "10" } });
    await waitFor(async () => expect((await ipc.settings.get("agents")).maxBudgetUsd).toBe(10));
    fireEvent.click(block.getByRole("switch", { name: "Let the lead hand work to roles" }));
    await waitFor(async () => expect(((await ipc.settings.get("agents")).delegation as { enabled: boolean }).enabled).toBe(false));
    expect(block.getByText("Delegation is off: Auto runs as one agent without roles.")).toBeTruthy();
    fireEvent.click(block.getByRole("switch", { name: "Allow Auto runs" }));
    await waitFor(async () => expect(((await ipc.settings.get("agents")).auto as { enabled: boolean }).enabled).toBe(false));
    expect(block.getByRole("switch", { name: "Let the lead hand work to roles" }).hasAttribute("disabled")).toBe(true);
  });
});
