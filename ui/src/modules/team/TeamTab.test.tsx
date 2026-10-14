import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no layout, so the real virtualizer shows no rows: show them all.
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
import { createMockTeam, mockSharedRunEvents, type MockTeamHandle } from "../../ipc/mock/team";
import { getRailItem, resetRail } from "../../platform/rail";
import { getTabType, resetTabs } from "../../platform/tabs";
import { installDomStubs } from "../../store/testing-u2";
import { register } from "./index";
import { resetRuns } from "./runs";
import { resetTeam } from "./store";
import TeamTab from "./TeamTab";

installDomStubs();
vi.setConfig({ testTimeout: 30000 });

let mock: MockTeamHandle;
const install = (preset: "off" | "on") => {
  mock = createMockTeam({ preset });
  (ipc as { team: unknown }).team = mock;
};
beforeEach(() => (resetTeam(), resetRuns()));
afterEach(() => {
  cleanup();
  resetRail();
  resetTabs();
  vi.restoreAllMocks();
});

describe("register()", () => {
  it("adds the Team rail item and tab type and calls no IPC", () => {
    install("off");
    const calls = [vi.spyOn(ipc.team, "status"), vi.spyOn(ipc.team, "runs")];
    register();
    expect(getRailItem("team")).toMatchObject({ position: "left" });
    expect(getTabType("team")).toBeTruthy();
    for (const c of calls) expect(c).not.toHaveBeenCalled();
  });
});

describe("the Team tab", () => {
  it("says so when this install is not in a team", async () => {
    install("off");
    render(() => <TeamTab />);
    await screen.findByText("You are not in a team");
    expect(screen.getByRole("button", { name: "Open Team settings" })).toBeTruthy();
  });

  it("lists the members with presence and their shared runs", async () => {
    install("on");
    render(() => <TeamTab />);
    const list = await screen.findByRole("complementary", { name: "Team members and their shared runs" });
    await within(list).findByText("Fix the cart total");
    expect(within(list).getByText("Add a retry to the sync job")).toBeTruthy();
    expect(within(list).getByText("Jordan")).toBeTruthy();
    expect(within(list).getByText("No shared runs")).toBeTruthy(); // Riley shares nothing
    expect(within(list).getAllByText("widgets").length).toBe(2);
  });

  it("opens a run as a read-only transcript: the diff is there, nothing can be answered or sent", async () => {
    install("on");
    render(() => <TeamTab />);
    fireEvent.click(await screen.findByText("Fix the cart total"));
    const main = await screen.findByRole("region", { name: "Shared run" });
    await within(main).findByText(/The cart total ignores quantities/);
    expect(within(main).getByText("Jordan", { selector: ".msg__who" })).toBeTruthy();
    expect(within(main).getAllByText("Read-only").length).toBeGreaterThan(0);
    const card = await within(main).findByTestId("shared-permission");
    expect(card.textContent).toMatch(/The owner allowed/);
    // the only field is the follow-up suggestion (the run is idle); no button answers a card or starts a turn
    expect([...main.querySelectorAll("textarea, input[type=text]")].map((e) => e.getAttribute("aria-label"))).toEqual(["Suggest a follow-up to Jordan..."]);
    expect(within(main).queryByRole("button", { name: /allow|deny|retry|continue/i })).toBeNull();
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("shows a permission card that is still open as information only", async () => {
    install("on");
    render(() => <TeamTab />);
    fireEvent.click(await screen.findByText("Add a retry to the sync job"));
    const card = await screen.findByTestId("shared-permission");
    expect(card.textContent).toMatch(/Waiting for the owner to decide/);
    expect(card.querySelector("button")).toBeNull();
  });

  it("follows live events of the open run and drops it when the owner withdraws it", async () => {
    install("on");
    render(() => <TeamTab />);
    fireEvent.click(await screen.findByText("Fix the cart total"));
    await screen.findByTestId("shared-permission");
    const more = [{ agentId: "r_jo1", seq: 12, ts: 9, provider: "claude", kind: "user.message", messageId: "m9", text: "One more thing: I updated the changelog." }] as unknown as ReturnType<typeof mockSharedRunEvents>;
    mock.sim.runEvents("m_jo", "r_jo1", more);
    await screen.findByText(/I updated the changelog/);
    mock.sim.withdrawRun("r_jo1");
    await waitFor(() => expect(screen.queryByText(/I updated the changelog/)).toBeNull());
    await screen.findByText("Pick a shared run");
  });
});
