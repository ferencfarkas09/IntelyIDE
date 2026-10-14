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
import { createMockTeam, mockCommits, mockSnapshot, type MockTeamHandle } from "../../ipc/mock/team";
import type { TeamSnapshotCommit } from "../../ipc/team";
import { resetTabs } from "../../platform/tabs";
import { installDomStubs } from "../../store/testing-u2";
import { resetChat } from "./chat";
import { CommitList } from "./CommitList";
import { resetNotes } from "./notes";
import { resetRuns } from "./runs";
import { resetTeam } from "./store";
import TeamTab from "./TeamTab";
import { resetWorkspace } from "./wsStore";

installDomStubs();
vi.setConfig({ testTimeout: 30000 });

let mock: MockTeamHandle;
beforeEach(() => {
  resetTeam();
  resetRuns();
  resetNotes();
  resetWorkspace();
  resetChat();
  mock = createMockTeam({ preset: "on" });
  (ipc as { team: unknown }).team = mock;
});
afterEach(() => {
  cleanup();
  resetTabs();
  vi.restoreAllMocks();
});

describe("the commits in the Workspace sub-tab", () => {
  const open = async () => {
    render(() => <TeamTab />);
    fireEvent.click(await screen.findByText("Fix the cart total"));
    fireEvent.click(await screen.findByRole("radio", { name: "Workspace" }));
    return screen.findByTestId("ws-commits");
  };

  it("lists the commits with the upstream, the ahead count and a badge on the unpushed ones", async () => {
    const box = await open();
    await within(box).findByText("Multiply the cart total by the quantity");
    expect(within(box).getByText("origin/fix/cart-total")).toBeTruthy();
    expect(within(box).getByText("2 ahead")).toBeTruthy();
    expect(within(box).getAllByText("Not pushed")).toHaveLength(2);
    expect(within(box).getByText("a1b2c3d4e5")).toBeTruthy();
    expect(within(box).getAllByText("Jordan Doe").length).toBeGreaterThan(0);
    expect(within(box).queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("shows text-only subjects and copes with an old sender that has no commits", async () => {
    vi.spyOn(mock, "workspace").mockResolvedValue({ ...mockSnapshot("k", Date.now()), commits: undefined as never });
    const box = await open();
    await within(box).findByText("No commits to show.");
  });

  it("renders a hostile subject as text", async () => {
    const commits = [{ oid: "0123456789", subject: "<img src=x onerror=alert(1)>", author: "A", at: Date.now(), unpushed: false }];
    vi.spyOn(mock, "workspace").mockResolvedValue({ ...mockSnapshot("k", Date.now()), commits });
    const box = await open();
    const row = await within(box).findByText("<img src=x onerror=alert(1)>");
    expect(row.querySelector("img")).toBeNull();
  });
});

describe("CommitList", () => {
  const many = (n: number): TeamSnapshotCommit[] => Array.from({ length: n }, (_, i) => ({ oid: String(i).padStart(10, "0"), subject: `commit ${i}`, author: "A", at: 1000 - i, unpushed: false }));
  it("cuts after ten rows and shows all on request", () => {
    render(() => <CommitList commits={many(12)} now={2000} label="Recent commits" />);
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "Show all 12" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(12);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});

describe("the team-wide commits pane", () => {
  const openPane = async () => {
    render(() => <TeamTab />);
    fireEvent.click(await screen.findByTestId("team-commits-open"));
    return screen.findByTestId("team-commits");
  };
  const riley = { memberId: "m_ri", memberName: "Riley", online: true, runId: "r_ri1", projectKey: "ffffffffffffffffffffffffffffffff", projectName: "api", title: "Index the orders", state: "idle" as const, provider: "claude", model: "m", startedAt: 1, updatedAt: 2 };

  it("asks once per member and project, lists each one with its branch and edited files, and the team timeline", async () => {
    const ask = vi.spyOn(mock, "workspaceRequest");
    mock.sim.setOnline("m_ri", true);
    mock.sim.shareRun(riley);
    const pane = await openPane();
    await waitFor(() => expect(within(pane).getAllByTestId("team-commits-target")).toHaveLength(2)); // Jordan has two runs in one project
    await waitFor(() => expect(within(pane).getAllByText("fix/cart-total")).toHaveLength(2));
    expect(ask).toHaveBeenCalledTimes(2);
    expect(within(pane).getAllByText("4 files edited")).toHaveLength(2);
    const timeline = within(pane).getByRole("region", { name: "Team timeline" });
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(8);
    expect(within(timeline).getAllByText("Jordan").length).toBe(4);
    expect(within(timeline).getAllByText("Riley").length).toBe(4);
    expect(within(timeline).getAllByText("Not pushed").length).toBe(4);
  });

  it("throttles a second request for the same member and project", async () => {
    const ask = vi.spyOn(mock, "workspaceRequest");
    const pane = await openPane();
    await within(pane).findByText("fix/cart-total");
    fireEvent.click(within(pane).getByRole("button", { name: "Refresh all" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("jumps to the member's Workspace sub-tab from the edited files", async () => {
    const pane = await openPane();
    fireEvent.click(await within(pane).findByRole("button", { name: "4 files edited" }));
    await screen.findByTestId("team-workspace");
    expect(screen.getByRole("radio", { name: "Workspace" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("team-commits")).toBeNull();
  });

  it("says when workspace sharing is off for the project", async () => {
    mock.sim.workspaceReply("off");
    const pane = await openPane();
    await within(pane).findByText(/Workspace sharing is off for this project/);
  });

  it("does not ask an offline member and says so", async () => {
    mock.sim.setOnline("m_jo", false);
    const ask = vi.spyOn(mock, "workspaceRequest");
    const pane = await openPane();
    await within(pane).findByText(/Jordan is offline/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("has an empty state when nobody shares a run", async () => {
    mock.sim.withdrawRun("r_jo1");
    mock.sim.withdrawRun("r_jo2");
    const pane = await openPane();
    await within(pane).findByText("Nobody shares a run yet");
  });

  it("the button toggles the pane off again", async () => {
    await openPane();
    fireEvent.click(screen.getByTestId("team-commits-open"));
    await waitFor(() => expect(screen.queryByTestId("team-commits")).toBeNull());
  });
});

describe("the mock snapshot", () => {
  it("carries commits, newest first, two of them not pushed", () => {
    const s = mockSnapshot("k", 1_000_000_000);
    expect(s.commits).toEqual(mockCommits(1_000_000_000));
    expect(s.commits.map((c) => c.at)).toEqual([...s.commits.map((c) => c.at)].sort((a, b) => b - a));
    expect(s.commits.filter((c) => c.unpushed)).toHaveLength(2);
  });
});
