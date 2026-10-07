import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({ ipc: {} }));

import { ipc } from "../../ipc";
import { createMockIpc } from "../../ipc/mock";
import { createMockWorkspaces } from "../../ipc/mock/workspaces";
import { registerCommand, resetCommands } from "../../platform/commands";
import { resetKeymap } from "../../platform/keymap";
import { enterEmptyState, workspaceState } from "../../store/workspace";
import { resetWorkspacesForTest, setReloadHook, startWorkspaces } from "../../store/workspaces";
import { resetWorkspaceDialogs, setSwitcherOpen } from "./dialogs";
import { Switcher } from "./Switcher";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let reload: ReturnType<typeof vi.fn<() => void>>;
let prev: () => void;
let stop: (() => void) | undefined;

async function mount(scenario: string, state: "ready" | "empty", pinned = false) {
  Object.assign(ipc, createMockIpc(scenario, { delayScale: 0 }));
  if (pinned) {
    const seed = (await createMockIpc("normal", { delayScale: 0 }).workspaceGet()).repos;
    Object.assign(ipc, createMockIpc(scenario, { delayScale: 0, workspaces: createMockWorkspaces({ seed, pinned: true }) }));
  }
  stop = startWorkspaces(ipc as never);
  await waitFor(() => expect(workspaceState()).toBe(state));
  return render(() => <Switcher />);
}

beforeEach(() => {
  resetWorkspacesForTest();
  resetWorkspaceDialogs();
  enterEmptyState();
  resetCommands();
  resetKeymap();
  reload = vi.fn<() => void>();
  prev = setReloadHook(reload);
});
afterEach(() => {
  cleanup();
  stop?.();
  stop = undefined;
  setReloadHook(prev);
  vi.restoreAllMocks();
});

describe("<Switcher>", () => {
  it("is a menu button named after the open workspace, with its colour", async () => {
    const { container } = await mount("normal", "ready");
    const trigger = container.querySelector<HTMLButtonElement>(".switcher")!;
    expect(trigger.getAttribute("aria-label")).toBe("Workspace: Happy workspace");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.querySelector(".switcher__dot")).not.toBeNull();
  });

  it("lists the recent workspaces as exclusive choices: the open one is checked and disabled", async () => {
    const { container } = await mount("normal", "ready");
    fireEvent.click(container.querySelector(".switcher")!);
    const radios = await screen.findAllByRole("menuitemradio");
    expect(radios.map((r) => [r.textContent?.replace(/\s+/g, " ").trim(), r.getAttribute("aria-checked"), r.getAttribute("aria-disabled")])).toEqual([
      ["Happy workspace4 repos", "true", "true"],
      ["Side projects2 repos", "false", null],
      ["Client X1 repo", "false", null],
    ]);
    const plain = screen.getAllByRole("menuitem").map((i) => i.textContent?.replace(/\s+/g, " ").trim());
    expect(plain).toEqual(["Open folder...", "New workspace...", "Scan a folder for repositories...", "Add repository to this workspace...", "Manage workspaces...", "Close workspace"]);
  });

  it("choosing another workspace runs the switch (guarded) and reloads", async () => {
    const { container } = await mount("normal", "ready");
    fireEvent.click(container.querySelector(".switcher")!);
    fireEvent.click((await screen.findAllByRole("menuitemradio"))[1]);
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });

  it("the chords of the entries are read from the shortcut registry", async () => {
    registerCommand({ id: "workspace.open", title: "o", group: "W", shortcut: "Cmd+O", run: () => undefined });
    const { container } = await mount("normal", "ready");
    fireEvent.click(container.querySelector(".switcher")!);
    const open = (await screen.findAllByRole("menuitem"))[0];
    expect(open.querySelectorAll("kbd")).toHaveLength(2);
    const manage = screen.getByRole("menuitem", { name: /Manage workspaces/ });
    expect(manage.querySelectorAll("kbd")).toHaveLength(0);
  });

  it("menu items run their commands", async () => {
    const run = vi.fn();
    registerCommand({ id: "workspace.manage", title: "m", group: "W", run });
    const { container } = await mount("normal", "ready");
    fireEvent.click(container.querySelector(".switcher")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Manage workspaces/ }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("opens from the Switch workspace command (the dialog state)", async () => {
    const { container } = await mount("normal", "ready");
    setSwitcherOpen(true);
    await waitFor(() => expect(container.querySelector(".switcher")?.getAttribute("aria-expanded")).toBe("true"));
  });

  it("no workspace: says so, offers Open/New/Scan/Manage but not Add repository or Close", async () => {
    const { container } = await mount("welcome-recents", "empty");
    const trigger = container.querySelector<HTMLElement>(".switcher")!;
    expect(trigger.getAttribute("aria-label")).toBe("No workspace");
    fireEvent.click(trigger);
    const plain = (await screen.findAllByRole("menuitem")).map((i) => i.textContent?.replace(/\s+/g, " ").trim());
    expect(plain).toEqual(["Open folder...", "New workspace...", "Scan a folder for repositories...", "Manage workspaces..."]);
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(5);
    expect(within(screen.getAllByRole("menuitemradio")[0]).queryByText("true")).toBeNull();
  });

  it("while switching it shows a spinner and cannot be opened", async () => {
    const { container } = await mount("normal", "ready");
    const { enterSwitching } = await import("../../store/workspace");
    enterSwitching();
    await waitFor(() => expect((container.querySelector(".switcher") as HTMLButtonElement).disabled).toBe(true));
    expect(container.querySelector(".switcher .ui-spinner")).not.toBeNull();
  });

  it("pinned mode (INTELY_WORKSPACE): one disabled entry and the fixed-by tooltip name", async () => {
    const { container } = await mount("normal", "ready", true);
    expect(container.querySelector(".switcher")?.getAttribute("aria-label")).toBe("Workspace: Pinned workspace");
    fireEvent.click(container.querySelector(".switcher")!);
    const radios = await screen.findAllByRole("menuitemradio");
    expect(radios).toHaveLength(1);
    expect(radios[0].getAttribute("aria-disabled")).toBe("true");
    expect(radios[0].textContent).toContain("Pinned: Pinned workspace");
  });
});
