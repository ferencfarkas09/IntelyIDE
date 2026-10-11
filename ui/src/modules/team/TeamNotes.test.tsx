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
import { TeamNoteCards } from "./TeamNotes";
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

const note = (over: Partial<Parameters<MockTeamHandle["sim"]["noteIn"]>[0]> = {}) => ({ memberId: "m_jo", memberName: "Jordan", runId: "r_me", noteId: "n1", text: "Please also check the retry limit.", ...over });

describe("sending a note into a teammate's run", () => {
  it("offers the composer for a live Claude run of an online member and shows where the note stands", async () => {
    render(() => <TeamTab />);
    fireEvent.click(await screen.findByText("Add a retry to the sync job")); // r_jo2 is working
    const box = await screen.findByTestId("team-notecomposer");
    const field = within(box).getByPlaceholderText("Send a note to Jordan's agent...");
    fireEvent.input(field, { target: { value: "Mind the timeout" } });
    fireEvent.click(within(box).getByRole("button", { name: "Send note" }));
    await within(box).findByText("Sent");
    const sent = await ipc.team.sentNotes("m_jo", "r_jo2");
    expect(sent).toHaveLength(1);
    mock.sim.noteStatus(sent[0].noteId, "received");
    await within(box).findByText("Waiting for the owner");
    mock.sim.noteStatus(sent[0].noteId, "accepted");
    await within(box).findByText("Accepted");
    mock.sim.noteStatus(sent[0].noteId, "delivered");
    await within(box).findByText("Delivered to the agent");
  });

  it("says why a note was refused", async () => {
    render(() => <TeamTab />);
    fireEvent.click(await screen.findByText("Add a retry to the sync job"));
    const box = await screen.findByTestId("team-notecomposer");
    fireEvent.input(within(box).getByPlaceholderText("Send a note to Jordan's agent..."), { target: { value: "x" } });
    fireEvent.click(within(box).getByRole("button", { name: "Send note" }));
    await within(box).findByText("Sent");
    const [n] = await ipc.team.sentNotes("m_jo", "r_jo2");
    mock.sim.noteStatus(n.noteId, "refused", "rate");
    await within(box).findByText("Refused");
    await within(box).findByText("Too many notes, wait a minute");
  });

  it("has no composer for a run that is not working, and for an offline owner", async () => {
    render(() => <TeamTab />);
    fireEvent.click(await screen.findByText("Fix the cart total")); // idle
    const box = await screen.findByTestId("team-notecomposer");
    expect(box.querySelector("textarea")).toBeNull();
    expect(within(box).getByText(/only while the run is working/)).toBeTruthy();
    fireEvent.click(screen.getByText("Add a retry to the sync job"));
    await waitFor(() => expect(screen.getByTestId("team-notecomposer").querySelector("textarea")).not.toBeNull());
    mock.sim.setOnline("m_jo", false);
    await waitFor(() => expect(screen.getByTestId("team-notecomposer").querySelector("textarea")).toBeNull());
  });

  it("the backend refuses a note for a run that is not live", async () => {
    await expect(ipc.team.noteSend("m_jo", "r_jo1", "hello")).rejects.toMatchObject({ code: "notLive" });
    await expect(ipc.team.noteSend("m_jo", "r_jo2", "   ")).rejects.toMatchObject({ code: "noteInvalid" });
  });
});

describe("a note from a teammate (owner side)", () => {
  it("shows a card with Accept and Reject, and removes it on a decision", async () => {
    const show = vi.spyOn(ipc.notify, "show");
    render(() => <TeamNoteCards runId="r_me" />);
    mock.sim.noteIn(note());
    const card = await screen.findByTestId("team-notecard");
    expect(card.textContent).toMatch(/Jordan sent a note/);
    expect(card.textContent).toMatch(/Please also check the retry limit\./);
    await waitFor(() => expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: "question", title: expect.stringContaining("Jordan sent a note: Please also check") })));
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.queryByTestId("team-notecard")).toBeNull());
    expect(await ipc.team.pendingNotes()).toEqual([]);
  });

  it("Reject removes the card too", async () => {
    render(() => <TeamNoteCards runId="r_me" />);
    mock.sim.noteIn(note({ noteId: "n2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() => expect(screen.queryByTestId("team-notecard")).toBeNull());
  });

  it("shows only the cards of its own run", async () => {
    render(() => <TeamNoteCards runId="r_me" />);
    mock.sim.noteIn(note({ runId: "r_other", noteId: "n3" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("team-notecard")).toBeNull();
  });

  it("asks for nothing from a member in autoAcceptNotesFrom", async () => {
    await ipc.team.setAutoAccept("m_jo", true);
    const show = vi.spyOn(ipc.notify, "show");
    render(() => <TeamNoteCards runId="r_me" />);
    mock.sim.noteIn(note({ noteId: "n4" }));
    await waitFor(() => expect(show).toHaveBeenCalled());
    expect(screen.queryByTestId("team-notecard")).toBeNull();
    expect(await ipc.team.pendingNotes()).toEqual([]);
  });
});

describe("the surface a teammate gets", () => {
  it("has notes and snapshots only: no permission, question, prompt or start command", () => {
    const names = Object.keys(ipc.team).filter((k) => /answer|permission|question|prompt|start|stop|interrupt|approve|decidePermission/i.test(k));
    expect(names).toEqual([]);
  });
});
