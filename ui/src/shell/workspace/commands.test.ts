import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({ ipc: {} }));

import { ipc } from "../../ipc";
import { createMockIpc } from "../../ipc/mock";
import { allCommands, availableCommands, execute, getCommand, resetCommands } from "../../platform/commands";
import { resetKeymap } from "../../platform/keymap";
import { enterEmptyState, workspaceState } from "../../store/workspace";
import { resetWorkspacesForTest, setReloadHook, startWorkspaces } from "../../store/workspaces";
import { manageOpen, newWorkspaceOpen, resetWorkspaceDialogs, switcherOpen } from "./dialogs";
import { registerDynamicWorkspaceCommands, registerWorkspaceCommands } from "./commands";
import { waitFor } from "@solidjs/testing-library";

let stop: (() => void) | undefined;
let off: Array<() => void> = [];
let reload: ReturnType<typeof vi.fn<() => void>>;
let prev: () => void;

async function boot(scenario: string, state: "ready" | "empty") {
  Object.assign(ipc, createMockIpc(scenario, { delayScale: 0 }));
  stop = startWorkspaces(ipc as never);
  await waitFor(() => expect(workspaceState()).toBe(state));
  off.push(registerWorkspaceCommands(), registerDynamicWorkspaceCommands());
}

beforeEach(() => {
  resetWorkspacesForTest();
  resetWorkspaceDialogs();
  resetCommands();
  resetKeymap();
  enterEmptyState();
  reload = vi.fn<() => void>();
  prev = setReloadHook(reload);
});
afterEach(() => {
  off.forEach((o) => o());
  off = [];
  stop?.();
  stop = undefined;
  setReloadHook(prev);
  vi.restoreAllMocks();
});

describe("workspace commands", () => {
  it("registers the Workspace group with the chords of the spec", async () => {
    await boot("normal", "ready");
    const ids = allCommands().filter((c) => c.group === "Workspace" && !c.id.startsWith("workspace.open.")).map((c) => c.id);
    expect(ids).toEqual(["workspace.open", "workspace.new", "workspace.scan", "workspace.addRepo", "workspace.switch", "workspace.manage", "workspace.rename", "workspace.recolor", "workspace.duplicate", "workspace.close", "workspace.remove"]);
    expect(Object.fromEntries(allCommands().filter((c) => c.shortcut).map((c) => [c.id, c.shortcut]))).toEqual({
      "workspace.open": "Cmd+O",
      "workspace.new": "Cmd+Alt+N",
      "workspace.addRepo": "Cmd+Shift+O",
      "workspace.switch": "Cmd+Alt+O",
    });
  });

  it("one 'Switch to workspace' command per other recent workspace, not for the open one", async () => {
    await boot("normal", "ready");
    await waitFor(() => expect(getCommand("workspace.open.w3f9a1c2b4")).toBeDefined());
    expect(getCommand("workspace.open.w-migrated")).toBeUndefined();
    expect(getCommand("workspace.open.w3f9a1c2b4")?.title).toBe("Switch to workspace: Side projects");
    await execute("workspace.open.w3f9a1c2b4");
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });

  it("the dynamic set follows the list: a removed workspace loses its command, at most eight", async () => {
    await boot("welcome-recents", "empty");
    await waitFor(() => expect(getCommand("workspace.open.w7c1d2e3f4")).toBeDefined());
    for (let i = 0; i < 10; i++) await ipc.workspaces.duplicate("w-migrated", `Extra ${i}`);
    await waitFor(() => expect(allCommands().filter((c) => c.id.startsWith("workspace.open.")).length).toBe(8));
    await ipc.workspaces.remove("w7c1d2e3f4", true);
    await waitFor(() => expect(getCommand("workspace.open.w7c1d2e3f4")).toBeUndefined());
  });

  it("without a workspace only the commands that make sense are available", async () => {
    await boot("welcome", "empty");
    const ids = availableCommands().map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["workspace.open", "workspace.new", "workspace.scan", "workspace.switch", "workspace.manage"]));
    for (const gone of ["workspace.addRepo", "workspace.close", "workspace.rename", "workspace.recolor", "workspace.duplicate", "workspace.remove"]) expect(ids).not.toContain(gone);
  });

  it("commands open their dialogs", async () => {
    await boot("normal", "ready");
    await execute("workspace.switch");
    expect(switcherOpen()).toBe(true);
    await execute("workspace.new", { prefill: [] });
    expect(newWorkspaceOpen()).toEqual({ prefill: [] });
    await execute("workspace.rename");
    expect(manageOpen()).toEqual({ id: "w-migrated", action: "rename" });
    await execute("workspace.remove");
    expect(manageOpen()).toEqual({ id: "w-migrated", action: "remove" });
  });

  it("Close workspace is a guarded switch to nothing", async () => {
    await boot("normal", "ready");
    await execute("workspace.close");
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });

  it("Duplicate copies the open workspace with a unique name", async () => {
    await boot("normal", "ready");
    await execute("workspace.duplicate");
    await waitFor(async () => expect((await ipc.workspaces.list()).workspaces.map((w) => w.name)).toContain("Happy workspace copy"));
  });
});
