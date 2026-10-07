import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({ ipc: {} }));

import { ipc } from "../../ipc";
import { createMockIpc } from "../../ipc/mock";
import type { MockWorkspaces } from "../../ipc/mock/workspaces";
import { registerUnsavedSource, resetUnsavedSources } from "../../platform/closeGuard";
import { enterEmptyState, workspaceState } from "../../store/workspace";
import { guard, requestSwitch, resetWorkspacesForTest, setReloadHook, startWorkspaces } from "../../store/workspaces";
import { SwitchGuard, blockerLine } from "./SwitchGuard";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const reg = () => ipc.workspaces as MockWorkspaces;
let reload: ReturnType<typeof vi.fn<() => void>>;
let prev: () => void;
let stop: (() => void) | undefined;

beforeEach(async () => {
  resetWorkspacesForTest();
  enterEmptyState();
  reload = vi.fn<() => void>();
  prev = setReloadHook(reload);
  Object.assign(ipc, createMockIpc("normal", { delayScale: 0 }));
  stop = startWorkspaces(ipc as never);
  await waitFor(() => expect(workspaceState()).toBe("ready"));
});
afterEach(() => {
  cleanup();
  stop?.();
  setReloadHook(prev);
  resetUnsavedSources();
  vi.restoreAllMocks();
});

const dialog = () => screen.getByRole("alertdialog");

describe("<SwitchGuard>", () => {
  it("renders nothing while there is nothing to ask", () => {
    render(() => <SwitchGuard />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("confirmable items: one line each with the consequence; Stop them and switch continues; Cancel is focused first", async () => {
    reg().setBusy({ blocking: [], confirmable: [{ kind: "agent", count: 2, labels: [] }, { kind: "devServer", count: 1, labels: ["api"] }, { kind: "terminal", count: 3, labels: [] }] });
    render(() => <SwitchGuard />);
    await requestSwitch("w3f9a1c2b4", ipc as never);
    const d = await screen.findByRole("alertdialog");
    expect(within(d).getByText("Switch workspace?")).toBeTruthy();
    expect(d.textContent).toContain('Something is still running in "Happy workspace".');
    const lines = [...d.querySelectorAll(".guard__item")].map((li) => li.textContent);
    expect(lines).toEqual([
      "2 agent runs are active. They will be interrupted; their Rewind snapshots stay.",
      "1 dev server is running and will be stopped.",
      "3 terminals are open and will be closed.",
    ]);
    await waitFor(() => expect(document.activeElement?.hasAttribute("data-guard-cancel")).toBe(true));
    fireEvent.click(within(d).getByRole("button", { name: "Stop them and switch" }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(guard()).toBeNull();
  });

  it("closing says so in the title and the button", async () => {
    reg().setBusy({ blocking: [], confirmable: [{ kind: "check", count: 1, labels: [] }] });
    render(() => <SwitchGuard />);
    await requestSwitch(null, ipc as never);
    const d = await screen.findByRole("alertdialog");
    expect(within(d).getByText("Close workspace?")).toBeTruthy();
    expect(within(d).getByRole("button", { name: "Stop them and close" })).toBeTruthy();
  });

  it("a git run blocks: the confirm stays disabled, Cancel the operation is offered, and the dialog says it is waiting", async () => {
    reg().setBusy({ blocking: [{ kind: "gitRun", count: 1, labels: ["push"] }], confirmable: [{ kind: "agent", count: 1, labels: [] }] });
    render(() => <SwitchGuard />);
    await requestSwitch("w3f9a1c2b4", ipc as never);
    const d = await screen.findByRole("alertdialog");
    expect(d.querySelector('.guard__item[data-kind="block"]')?.textContent).toBe("A commit, push or pull is running. Wait for it to finish or cancel it first.");
    expect((within(d).getByRole("button", { name: "Stop them and switch" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(d).getByRole("button", { name: "Cancel the operation" })).toBeTruthy();
    expect(within(d).getByRole("status").textContent).toContain("Waiting for the operation to finish...");
  });

  it("a held Git operation lists its label", async () => {
    reg().setBusy({ blocking: [{ kind: "gitOp", count: 1, labels: ["rebase"] }], confirmable: [] });
    render(() => <SwitchGuard />);
    await requestSwitch("w3f9a1c2b4", ipc as never);
    const d = await screen.findByRole("alertdialog");
    expect(d.querySelector(".guard__item")?.textContent).toBe("A Git operation is running (rebase).");
  });

  it("unsaved files: names are listed, Save all and switch / Don't save and switch / Cancel", async () => {
    let saved = false;
    registerUnsavedSource({ id: "ed", titles: () => (saved ? [] : ["a.ts", "b.ts"]), saveAll: async () => ((saved = true), true) });
    render(() => <SwitchGuard />);
    await requestSwitch("w3f9a1c2b4", ipc as never);
    const d = await screen.findByRole("alertdialog");
    expect(d.querySelector(".guard__item")?.textContent).toBe("2 unsaved files: a.ts and b.ts");
    const names = within(d).getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(expect.arrayContaining(["Cancel", "Don't save and switch", "Save all and switch"]));
    fireEvent.click(within(d).getByRole("button", { name: "Save all and switch" }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(saved).toBe(true);
  });

  it("a save that fails keeps the dialog open and says so", async () => {
    registerUnsavedSource({ id: "ed", titles: () => ["a.ts"], saveAll: async () => false });
    render(() => <SwitchGuard />);
    await requestSwitch(null, ipc as never);
    const d = await screen.findByRole("alertdialog");
    fireEvent.click(within(d).getByRole("button", { name: "Save all and switch" }));
    await waitFor(() => expect(within(d).getByRole("alert").textContent).toBe("Some files could not be saved."));
    expect(reload).not.toHaveBeenCalled();
  });

  it("Cancel closes the dialog without switching", async () => {
    reg().setBusy({ blocking: [], confirmable: [{ kind: "preview", count: 1, labels: [] }] });
    render(() => <SwitchGuard />);
    await requestSwitch("w3f9a1c2b4", ipc as never);
    const d = await screen.findByRole("alertdialog");
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(guard()).toBeNull());
    expect(reload).not.toHaveBeenCalled();
  });

  it("every busy kind has a line", () => {
    const kinds = ["gitRun", "gitOp", "agent", "devServer", "check", "terminal", "preview", "mongo", "unsaved"] as const;
    for (const kind of kinds) expect(blockerLine({ kind, count: 2, labels: ["x"] }).length).toBeGreaterThan(5);
    expect(blockerLine({ kind: "mongo", count: 1, labels: [] })).toBe("1 database connection is open");
  });
});
