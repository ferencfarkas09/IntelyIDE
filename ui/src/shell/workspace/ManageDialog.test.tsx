import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({ ipc: {} }));

import { ipc } from "../../ipc";
import { createMockIpc } from "../../ipc/mock";
import type { MockWorkspaces } from "../../ipc/mock/workspaces";
import { enterEmptyState, workspaceState } from "../../store/workspace";
import { activeId, recents, resetWorkspacesForTest, setReloadHook, startWorkspaces, workspaces } from "../../store/workspaces";
import { toast } from "../../ui-kit";
import { closeManage, openManage, resetWorkspaceDialogs } from "./dialogs";
import { ManageDialog } from "./ManageDialog";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let reload: ReturnType<typeof vi.fn<() => void>>;
let prev: () => void;
let stop: (() => void) | undefined;

async function mount(scenario = "normal", state: "ready" | "empty" = "ready") {
  Object.assign(ipc, createMockIpc(scenario, { delayScale: 0 }));
  stop = startWorkspaces(ipc as never);
  await waitFor(() => expect(workspaceState()).toBe(state));
  const view = render(() => <ManageDialog />);
  openManage();
  await screen.findByRole("dialog");
  return view;
}
const names = () => [...document.querySelectorAll(".manage__name")].map((n) => n.childNodes[0]?.textContent);

beforeEach(() => {
  resetWorkspacesForTest();
  resetWorkspaceDialogs();
  enterEmptyState();
  toast.clear();
  reload = vi.fn<() => void>();
  prev = setReloadHook(reload);
});
afterEach(() => {
  closeManage();
  cleanup();
  stop?.();
  stop = undefined;
  setReloadHook(prev);
  vi.restoreAllMocks();
});

describe("<ManageDialog>", () => {
  it("lists every workspace in order with its repositories; the open one is marked", async () => {
    await mount();
    expect(names()).toEqual(["Happy workspace", "Side projects", "Client X"]);
    expect(document.querySelectorAll('.manage__row[data-active]')).toHaveLength(1);
    expect(document.querySelector(".manage__open")?.textContent).toBe("Current");
  });

  it("rename: double-click edits inline, Enter saves, Esc cancels, an empty or taken name is refused inline", async () => {
    await mount();
    fireEvent.dblClick(document.querySelector('[data-name="w3f9a1c2b4"]')!);
    const input = document.querySelector<HTMLInputElement>('[data-edit="w3f9a1c2b4"]')!;
    fireEvent.input(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);
    expect((await screen.findAllByRole("alert"))[0].textContent).toBe("Enter a name.");
    fireEvent.input(input, { target: { value: "client x" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(screen.getAllByRole("alert")[0].textContent).toBe("That name is already used."));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.querySelector('[data-edit="w3f9a1c2b4"]')).toBeNull();
    expect(names()).toContain("Side projects");
    fireEvent.dblClick(document.querySelector('[data-name="w3f9a1c2b4"]')!);
    const again = document.querySelector<HTMLInputElement>('[data-edit="w3f9a1c2b4"]')!;
    fireEvent.input(again, { target: { value: "Renamed" } });
    fireEvent.submit(again.closest("form")!);
    await waitFor(() => expect(names()).toContain("Renamed"));
    expect(workspaces().map((w) => w.name)).toContain("Renamed");
  });

  it("F2 starts editing from the keyboard", async () => {
    await mount();
    const name = document.querySelector<HTMLElement>('[data-name="w7c1d2e3f4"]')!;
    name.focus();
    fireEvent.keyDown(name, { key: "F2" });
    expect(document.querySelector('[data-edit="w7c1d2e3f4"]')).not.toBeNull();
  });

  it("reorder with Alt+Down / the arrow buttons persists the order", async () => {
    await mount();
    const first = document.querySelector<HTMLElement>('[data-name="w-migrated"]')!;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(names()).toEqual(["Side projects", "Happy workspace", "Client X"]));
    fireEvent.click(screen.getByRole("button", { name: "Move Client X up" }));
    await waitFor(() => expect(names()).toEqual(["Side projects", "Client X", "Happy workspace"]));
    expect((await ipc.workspaces.list()).workspaces.map((w) => w.id)).toEqual(["w3f9a1c2b4", "w7c1d2e3f4", "w-migrated"]);
    expect((screen.getByRole("button", { name: "Move Side projects up" }) as HTMLButtonElement).getAttribute("aria-disabled")).toBe("true");
  });

  it("recolour through the swatches", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Colour of Side projects" }));
    const radios = await screen.findAllByRole("radio");
    fireEvent.click(radios[2]);
    await waitFor(() => expect(workspaces().find((w) => w.id === "w3f9a1c2b4")?.color).not.toBe("#3b9ae8"));
  });

  it("duplicate adds a uniquely named copy", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Client X" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    await waitFor(() => expect(names()).toContain("Client X copy"));
  });

  it("remove asks first: Cancel has the focus, the text says nothing on disk is touched, confirming removes the entry", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Client X" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText('Remove workspace "Client X"?')).toBeTruthy();
    expect(confirm.textContent).toContain("Your folders and repositories on disk are not touched.");
    await waitFor(() => expect(document.activeElement?.hasAttribute("data-manage-cancel")).toBe(true));
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(names()).not.toContain("Client X"));
    expect(recents().map((w) => w.id)).not.toContain("w7c1d2e3f4");
  });

  it("removing the open workspace closes it first (guard, switch, reload) and the next page removes the entry", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Happy workspace" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    await waitFor(() => expect(activeId()).toBeNull());
    expect(sessionStorage.getItem("intely.ws.removeAfterClose")).toBe("w-migrated");
    // the next page
    stop?.();
    resetWorkspacesForTest();
    sessionStorage.setItem("intely.ws.removeAfterClose", "w-migrated");
    enterEmptyState();
    stop = startWorkspaces(ipc as never);
    await waitFor(() => expect(sessionStorage.getItem("intely.ws.removeAfterClose")).toBeNull());
    await waitFor(async () => expect((await ipc.workspaces.list()).workspaces.some((w) => w.id === "w-migrated")).toBe(false));
  });

  it("if the close is refused (busy), the entry is not removed and the pending marker is dropped", async () => {
    await mount();
    (ipc.workspaces as MockWorkspaces).setBusy({ blocking: [], confirmable: [{ kind: "agent", count: 1, labels: [] }] });
    fireEvent.click(screen.getByRole("button", { name: "More actions for Happy workspace" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(sessionStorage.getItem("intely.ws.removeAfterClose")).toBeNull());
    expect(reload).not.toHaveBeenCalled();
    expect(workspaces().some((w) => w.id === "w-migrated")).toBe(true);
  });

  it("the command can start on a workspace: rename it or ask to remove it", async () => {
    await mount();
    closeManage();
    openManage({ id: "w7c1d2e3f4", action: "rename" });
    await waitFor(() => expect(document.querySelector('[data-edit="w7c1d2e3f4"]')).not.toBeNull());
    closeManage();
    openManage({ id: "w7c1d2e3f4", action: "remove" });
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
  });

  it("works on Welcome too (no workspace open)", async () => {
    await mount("welcome-recents", "empty");
    expect(names()).toHaveLength(5);
    expect(document.querySelector(".manage__open")).toBeNull();
  });

  it("pinned mode: nothing can be changed", async () => {
    const { createMockWorkspaces } = await import("../../ipc/mock/workspaces");
    const seed = (await createMockIpc("normal", { delayScale: 0 }).workspaceGet()).repos;
    Object.assign(ipc, createMockIpc("normal", { delayScale: 0, workspaces: createMockWorkspaces({ seed, pinned: true }) }));
    stop = startWorkspaces(ipc as never);
    await waitFor(() => expect(workspaceState()).toBe("ready"));
    render(() => <ManageDialog />);
    openManage();
    await screen.findByRole("dialog");
    expect(screen.getByText("The list cannot be changed while the workspace is fixed by INTELY_WORKSPACE.")).toBeTruthy();
    expect((document.querySelector(".manage__swatch") as HTMLButtonElement).disabled).toBe(true);
  });
});
