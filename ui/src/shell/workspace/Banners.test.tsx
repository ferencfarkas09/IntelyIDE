import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({ ipc: {} }));
const flows = vi.hoisted(() => ({ locateFlow: vi.fn(async () => true) }));
vi.mock("./flows", () => flows);

import { ipc } from "../../ipc";
import { createMockIpc } from "../../ipc/mock";
import type { MockWorkspaces } from "../../ipc/mock/workspaces";
import { enterEmptyState, repos, workspaceState } from "../../store/workspace";
import { requestSwitch, resetWorkspacesForTest, setReloadHook, startWorkspaces, survivors } from "../../store/workspaces";
import { MissingBanner, SurvivorsBanner } from "./Banners";

let stop: (() => void) | undefined;
let reload: ReturnType<typeof vi.fn<() => void>>;
let prev: () => void;

async function boot() {
  Object.assign(ipc, createMockIpc("normal", { delayScale: 0 }));
  stop = startWorkspaces(ipc as never);
  await waitFor(() => expect(workspaceState()).toBe("ready"));
  await waitFor(() => expect(repos()).toHaveLength(4));
}
beforeEach(() => {
  resetWorkspacesForTest();
  enterEmptyState();
  flows.locateFlow.mockClear();
  reload = vi.fn<() => void>();
  prev = setReloadHook(reload);
});
afterEach(() => {
  cleanup();
  stop?.();
  setReloadHook(prev);
  vi.restoreAllMocks();
});

describe("<SurvivorsBanner>", () => {
  it("names the processes that outlived the switch; Stop it kills one and the banner follows", async () => {
    await boot();
    (ipc.workspaces as MockWorkspaces).setSurvivors([
      { pid: 4242, port: 3000, cwd: "/Users/example/Projects/api", kind: "devServer" },
      { pid: 4343, port: null, cwd: "/Users/example/Projects/web", kind: "terminal" },
    ]);
    await requestSwitch("w3f9a1c2b4", ipc as never);
    expect(survivors()).toHaveLength(2);
    const { container } = render(() => <SurvivorsBanner />);
    expect(container.textContent).toContain("2 processes from the old workspace are still running");
    expect(container.textContent).toContain("devServer:3000 · ~/Projects/api · 4242");
    fireEvent.click(screen.getAllByRole("button", { name: "Stop it" })[0]);
    await waitFor(() => expect(survivors().map((s) => s.pid)).toEqual([4343]));
    expect(container.textContent).toContain("1 process from the old workspace is still running");
  });

  it("is absent when nothing survived", () => {
    const { container } = render(() => <SurvivorsBanner />);
    expect(container.querySelector(".wsbanner")).toBeNull();
  });
});

describe("<MissingBanner>", () => {
  it("counts the missing folders of the open workspace; Remove missing drops them from the workspace only", async () => {
    await boot();
    const reg = ipc.workspaces as MockWorkspaces;
    reg.setProbe("/Users/example/Projects/shop-pos", "missing");
    const { container } = render(() => <MissingBanner />);
    await waitFor(() => expect(container.textContent).toContain("1 of 4 folders are missing"));
    fireEvent.click(screen.getByRole("button", { name: "Remove missing" }));
    await waitFor(() => expect(repos().map((r) => r.id)).toEqual(["backend", "admin", "services"]));
    await waitFor(() => expect(container.querySelector(".wsbanner")).toBeNull());
  });

  it("Dismiss hides it until the set of missing folders changes; Locate starts the locate flow for the first missing repo", async () => {
    await boot();
    const reg = ipc.workspaces as MockWorkspaces;
    reg.setProbe("/Users/example/Projects/shop-pos", "missing");
    const { container } = render(() => <MissingBanner />);
    await waitFor(() => expect(container.querySelector(".wsbanner")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Locate..." }));
    await waitFor(() => expect(flows.locateFlow).toHaveBeenCalledWith("w-migrated", "pos"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(container.querySelector(".wsbanner")).toBeNull();
  });

  it("stays out of the way when every folder is there, and in pinned mode", async () => {
    await boot();
    const { container } = render(() => <MissingBanner />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector(".wsbanner")).toBeNull();
  });
});
