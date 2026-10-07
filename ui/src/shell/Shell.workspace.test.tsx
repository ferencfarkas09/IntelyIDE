import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", async (orig) => {
  const mod = await orig<typeof import("../ipc")>();
  const { createMockIpc } = await import("../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { ipc } from "../ipc";
import { createMockIpc } from "../ipc/mock";
import type { MockWorkspaces } from "../ipc/mock/workspaces";
import { resetCommands, registerCommand } from "../platform/commands";
import { resetKeymap } from "../platform/keymap";
import { enterEmptyState, workspaceState } from "../store/workspace";
import { resetWorkspacesForTest, startWorkspaces } from "../store/workspaces";
import { Shell } from "./Shell";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let stop: (() => void) | undefined;

beforeEach(() => {
  resetWorkspacesForTest();
  enterEmptyState();
  resetCommands();
  resetKeymap();
});
afterEach(() => {
  cleanup();
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
});

async function boot(client: ReturnType<typeof createMockIpc>, state: "ready" | "empty") {
  Object.assign(ipc, client);
  stop = startWorkspaces(ipc as never);
  await waitFor(() => expect(workspaceState()).toBe(state), { timeout: 15000 });
}

describe("<Shell> and workspaces", () => {
  it("no workspace: Welcome fills the window, the title bar offers Settings and says no workspace, rail and status bar are gone", async () => {
    await boot(createMockIpc("welcome-recents", { delayScale: 0 }), "empty");
    const { container } = render(() => <Shell />);
    expect(container.querySelector('[data-testid="welcome"]')).not.toBeNull();
    expect(container.querySelector(".rail")).toBeNull();
    expect(container.querySelector(".statusbar, [data-testid='statusbar']")).toBeNull();
    expect(container.querySelector(".switcher")?.getAttribute("aria-label")).toBe("No workspace");
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
    // the Agent/Editor control and the branch pills have nothing to act on
    expect(container.querySelector('[role="radiogroup"], .ui-segmented')).toBeNull();
    expect(container.querySelector(".ui-pill")).toBeNull();
  });

  it("the Settings button of the title bar opens the Settings dialog command", async () => {
    await boot(createMockIpc("welcome", { delayScale: 0 }), "empty");
    render(() => <Shell />);
    const { settingsOpen } = await import("../platform/settings");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(settingsOpen()).toBe(true);
  });

  it("an open workspace shows the rail, the switcher with its name and the branch pills, no Welcome", async () => {
    await boot(createMockIpc("normal", { delayScale: 0 }), "ready");
    const { container } = render(() => <Shell />);
    expect(container.querySelector('[data-testid="welcome"]')).toBeNull();
    expect(container.querySelector(".rail")).not.toBeNull();
    expect(container.querySelector(".switcher")?.getAttribute("aria-label")).toBe("Workspace: Happy workspace");
    await waitFor(() => expect(container.querySelectorAll(".ttl .ui-pill").length).toBe(4));
  });

  it("a workspace without repositories keeps the rail and says what to do next", async () => {
    const client = createMockIpc("normal", { delayScale: 0 });
    const reg = client.workspaces as MockWorkspaces;
    const empty = await reg.create({ name: "Nothing yet", repos: [] });
    await reg.switch(empty.entry.id, { force: true });
    await boot(createMockIpc("normal", { delayScale: 0, workspaces: reg }), "ready");
    const run = vi.fn();
    registerCommand({ id: "workspace.addRepo", title: "a", group: "Workspace", run });
    const { container } = render(() => <Shell />);
    expect(container.querySelector(".rail")).not.toBeNull();
    expect(screen.getByText("This workspace has no repositories")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add repository..." }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("the Splash covers the window during a switch and names the target", async () => {
    await boot(createMockIpc("normal", { delayScale: 0 }), "ready");
    const { container } = render(() => <Shell />);
    const { enterSwitching } = await import("../store/workspace");
    enterSwitching();
    await waitFor(() => expect(container.querySelector(".splash")?.getAttribute("aria-busy")).toBe("true"));
  });

  it("after a switch the new page puts the focus on its heading and announces the result", async () => {
    sessionStorage.setItem("intely.ws.switched", JSON.stringify({ from: "w3f9a1c2b4", to: "w-migrated", toName: "Happy workspace", at: 1 }));
    Object.assign(ipc, createMockIpc("normal", { delayScale: 0 }));
    const { container } = render(() => <Shell />);
    stop = startWorkspaces(ipc as never);
    await waitFor(() => expect(document.activeElement?.hasAttribute("data-workspace-heading")).toBe(true), { timeout: 15000 });
    expect(document.activeElement?.textContent).toBe("Happy workspace");
    expect(container.querySelectorAll("h1[data-workspace-heading]")).toHaveLength(1);
  });
});
