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

  it("has a note composer for a working run and none for an offline owner", async () => {
    render(() => <TeamTab />);
    fireEvent.click(await screen.findByText("Add a retry to the sync job"));
    await waitFor(() => expect(screen.getByTestId("team-notecomposer").querySelector("textarea")).not.toBeNull());
    expect(screen.getByPlaceholderText("Send a note to Jordan's agent...")).toBeTruthy();
    mock.sim.setOnline("m_jo", false);
    await waitFor(() => expect(screen.getByTestId("team-notecomposer").querySelector("textarea")).toBeNull());
    expect(within(screen.getByTestId("team-notecomposer")).getByText(/whose owner is online/)).toBeTruthy();
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

describe("suggesting a follow-up for a run that is not working", () => {
  it("offers a follow-up composer for an idle run and follows the follow-up to the agent", async () => {
    render(() => <TeamTab />);
    fireEvent.click(await screen.findByText("Fix the cart total")); // idle
    const box = await screen.findByTestId("team-notecomposer");
    const field = within(box).getByPlaceholderText("Suggest a follow-up to Jordan...");
    expect(within(box).getByText(/start a new turn/)).toBeTruthy();
    fireEvent.input(field, { target: { value: "Now add a test for zero quantity" } });
    fireEvent.click(within(box).getByRole("button", { name: "Suggest follow-up" }));
    await within(box).findByText("Sent");
    expect(within(box).getByText("Follow-up")).toBeTruthy();
    const [n] = await ipc.team.sentNotes("m_jo", "r_jo1");
    expect(n.kind).toBe("followup");
    mock.sim.noteStatus(n.noteId, "received");
    await within(box).findByText("Waiting for the owner");
    mock.sim.noteStatus(n.noteId, "accepted");
    await within(box).findByText("Accepted, sending to the agent");
    mock.sim.noteStatus(n.noteId, "delivered");
    await within(box).findByText("Sent to the agent");
  });

  it("says when the run started working in the meantime", async () => {
    render(() => <TeamTab />);
    fireEvent.click(await screen.findByText("Fix the cart total"));
    const box = await screen.findByTestId("team-notecomposer");
    fireEvent.input(within(box).getByPlaceholderText("Suggest a follow-up to Jordan..."), { target: { value: "more" } });
    fireEvent.click(within(box).getByRole("button", { name: "Suggest follow-up" }));
    await within(box).findByText("Sent");
    const [n] = await ipc.team.sentNotes("m_jo", "r_jo1");
    mock.sim.noteStatus(n.noteId, "refused", "busy");
    await within(box).findByText("Refused");
    await within(box).findByText("The run is working: send a note instead");
  });

  it("also offers it for a run that ended with an error, and not for another provider", async () => {
    const base = { memberId: "m_jo", memberName: "Jordan", online: true, projectKey: "k", projectName: "widgets", model: "m", startedAt: 1, updatedAt: 2 };
    mock.sim.shareRun({ ...base, runId: "r_err", title: "Broken run", state: "error", provider: "claude" });
    mock.sim.shareRun({ ...base, runId: "r_oth", title: "Other agent", state: "idle", provider: "codex" });
    render(() => <TeamTab />);
    fireEvent.click(await screen.findByText("Broken run"));
    await screen.findByPlaceholderText("Suggest a follow-up to Jordan...");
    fireEvent.click(screen.getByText("Other agent"));
    await waitFor(() => expect(screen.getByTestId("team-notecomposer").querySelector("textarea")).toBeNull());
  });

  it("the backend refuses a follow-up for a working run, an unknown run and an empty text", async () => {
    await expect(ipc.team.followUpSend("m_jo", "r_jo2", "x")).rejects.toMatchObject({ code: "busy" });
    await expect(ipc.team.followUpSend("m_jo", "r_none", "x")).rejects.toMatchObject({ code: "unknownRun" });
    await expect(ipc.team.followUpSend("m_jo", "r_jo1", "  ")).rejects.toMatchObject({ code: "noteInvalid" });
    mock.sim.setOnline("m_jo", false);
    await expect(ipc.team.followUpSend("m_jo", "r_jo1", "x")).rejects.toMatchObject({ code: "offline" });
  });
});

describe("a follow-up from a teammate (owner side)", () => {
  it("shows a follow-up card with its own wording and a banner, and sends it to the agent on a click", async () => {
    const show = vi.spyOn(ipc.notify, "show");
    render(() => <TeamNoteCards runId="r_me" />);
    mock.sim.noteIn(note({ kind: "followup", noteId: "f1", text: "Please also update the changelog." }));
    const card = await screen.findByTestId("team-notecard");
    expect(card.getAttribute("data-kind")).toBe("followup");
    expect(card.textContent).toMatch(/Jordan suggests a follow-up for this agent/);
    expect(card.textContent).toMatch(/Please also update the changelog\./);
    expect(card.textContent).toMatch(/starts a new turn/);
    await waitFor(() => expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: "question", title: expect.stringContaining("Jordan suggests a follow-up: Please also") })));
    fireEvent.click(within(card).getByRole("button", { name: "Send to the agent" }));
    await waitFor(() => expect(screen.queryByTestId("team-notecard")).toBeNull());
  });

  it("Reject removes it, and a trusted member's follow-up is still never passed on by itself", async () => {
    await ipc.team.setAutoAccept("m_jo", true);
    render(() => <TeamNoteCards runId="r_me" />);
    mock.sim.noteIn(note({ kind: "followup", noteId: "f2" }));
    const card = await screen.findByTestId("team-notecard");
    expect(await ipc.team.pendingNotes()).toHaveLength(1);
    fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(screen.queryByTestId("team-notecard")).toBeNull());
  });

  it("shows a note and a follow-up side by side", async () => {
    render(() => <TeamNoteCards runId="r_me" />);
    mock.sim.noteIn(note({ noteId: "n9" }));
    mock.sim.noteIn(note({ kind: "followup", noteId: "f9" }));
    await waitFor(() => expect(screen.getAllByTestId("team-notecard")).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send to the agent" })).toBeTruthy();
  });
});
