import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/solid-virtual", () => ({
  createVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({ index, start: index * 72 })),
    getTotalSize: () => opts.count * 72,
    measureElement: () => {},
  }),
}));

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { ipc } from "../../ipc";
import { createMockTeam, type MockTeamHandle } from "../../ipc/mock/team";
import { resetTabs } from "../../platform/tabs";
import { installDomStubs } from "../../store/testing-u2";
import { resetNotes } from "./notes";
import { resetRuns } from "./runs";
import { resetTeam } from "./store";
import TeamTab from "./TeamTab";
import { parseUnified } from "./Workspace";
import { resetWorkspace } from "./wsStore";

installDomStubs();
vi.setConfig({ testTimeout: 30000 });

let mock: MockTeamHandle;
beforeEach(() => {
  resetTeam();
  resetRuns();
  resetNotes();
  resetWorkspace();
  mock = createMockTeam({ preset: "on" });
  (ipc as { team: unknown }).team = mock;
});
afterEach(() => {
  cleanup();
  resetTabs();
  vi.restoreAllMocks();
});

const open = async () => {
  render(() => <TeamTab />);
  fireEvent.click(await screen.findByText("Fix the cart total"));
  fireEvent.click(await screen.findByRole("radio", { name: "Workspace" }));
  return screen.findByTestId("team-workspace");
};

describe("parseUnified", () => {
  it("separates header, hunk, additions, deletions and context", () => {
    const lines = parseUnified("--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n");
    expect(lines.map((l) => l.kind)).toEqual(["meta", "meta", "hunk", "ctx", "del", "add"]);
    expect(lines[3].text).toBe("keep");
  });
  it("treats a line that starts with +++ inside a hunk as an addition", () => {
    expect(parseUnified("@@ -0,0 +1 @@\n+++x\n").at(-1)).toEqual({ kind: "add", text: "++x" });
  });
});

describe("the Workspace sub-tab", () => {
  it("asks for a snapshot on the first look and shows branch, files and the diff", async () => {
    const ws = await open();
    await within(ws).findByText("fix/cart-total");
    expect(within(ws).getByText("↑2 ↓0")).toBeTruthy();
    const files = within(ws).getByRole("list", { name: "Changed files" });
    expect(within(files).getByText("src/cart/total.ts")).toBeTruthy();
    expect(within(files).getByText("src/cart/total.test.ts")).toBeTruthy();
    const diff = await within(ws).findByTestId("ws-diff");
    expect(diff.textContent).toMatch(/price \* i\.qty/);
    expect(ws.querySelector("textarea")).toBeNull(); // read-only
    expect(within(ws).getByTestId("ws-time").textContent).toMatch(/Taken/);
  });

  it("opens another file, and says a secret file's content is never shared", async () => {
    const ws = await open();
    await within(ws).findByTestId("ws-diff");
    fireEvent.click(within(ws).getByText("src/cart/total.test.ts"));
    await waitFor(() => expect(within(ws).getByTestId("ws-diff").textContent).toMatch(/multiplies by the quantity/));
    fireEvent.click(within(ws).getByText(".env.local"));
    const skipped = await within(ws).findByTestId("ws-skipped");
    expect(skipped.textContent).toMatch(/never shared/);
    expect(within(ws).queryByTestId("ws-diff")).toBeNull();
  });

  it("Refresh asks again", async () => {
    const ws = await open();
    await within(ws).findByTestId("ws-diff");
    const ask = vi.spyOn(ipc.team, "workspaceRequest");
    fireEvent.click(within(ws).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(ask).toHaveBeenCalledWith("m_jo", "0a1b2c3d4e5f60718293a4b5c6d7e8f9"));
  });

  it("tells the person when the owner has not opened the project", async () => {
    mock.sim.workspaceReply("off");
    const ws = await open();
    const alert = await within(ws).findByRole("alert");
    expect(alert.textContent).toMatch(/not open to the team/);
    expect(within(ws).getByText("No snapshot yet")).toBeTruthy();
  });

  it("explains a rate limit", async () => {
    mock.sim.workspaceReply("rate");
    const ws = await open();
    await within(ws).findByText(/once every 30 seconds/);
  });
});

describe("settings", () => {
  it("the workspace switch is per project and off by default", async () => {
    const before = await ipc.team.projects();
    expect(before.every((p) => p.workspace === false)).toBe(true);
    await ipc.team.setWorkspace("0a1b2c3d4e5f60718293a4b5c6d7e8f9", true);
    expect((await ipc.team.projects()).find((p) => p.key)?.workspace).toBe(true);
    expect(await ipc.team.collabSettings()).toEqual({ autoAcceptNotesFrom: [] });
  });
});
