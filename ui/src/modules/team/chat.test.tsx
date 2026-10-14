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
import { ChatPanel } from "./ChatPanel";
import { resetChat } from "./chat";
import { resetNotes } from "./notes";
import { resetRuns } from "./runs";
import { resetTeam } from "./store";
import TeamTab from "./TeamTab";
import { TeamChatStrip } from "./TeamChatStrip";
import { resetWorkspace } from "./wsStore";

installDomStubs();
vi.setConfig({ testTimeout: 30000 });

const PROJECT = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
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

const field = () => screen.getByPlaceholderText("Write to the team...") as HTMLTextAreaElement;
const type = (value: string) => fireEvent.input(field(), { target: { value } });
const sendButton = () => screen.getByRole("button", { name: "Send message" });
const enter = (shift = false) => fireEvent.keyDown(field(), { key: "Enter", shiftKey: shift });

const panel = () => render(() => <ChatPanel ownerId="m_jo" ownerName="Jordan" runId="r_jo1" ownerOnline />);

describe("the chat of a teammate's run", () => {
  it("asks the owner for the history once and shows it", async () => {
    mock.sim.chatIn("m_jo", "r_jo1", { text: "earlier message", author: "m_jo", at: Date.now() - 60_000 });
    panel();
    await screen.findByText("earlier message");
    await waitFor(() => expect(mock.sim.chatRequests()).toEqual(["m_jo:r_jo1"]));
    mock.sim.chatHistory("m_jo", "r_jo1", [{ msgId: "h1", author: "m_ri", authorName: "Riley", text: "from the history", at: Date.now() - 120_000, mine: false }]);
    await screen.findByText("from the history");
    const texts = within(screen.getByRole("log")).getAllByText(/message|history/).map((n) => n.textContent);
    expect(texts).toEqual(["from the history", "earlier message"]); // oldest first
    expect(mock.sim.chatRequests()).toHaveLength(1);
  });

  it("sends with Enter, keeps Shift+Enter for a new line, and shows the echo once", async () => {
    panel();
    type("hello team");
    enter(true);
    expect(await ipc.team.chatThread("m_jo", "r_jo1")).toHaveLength(0);
    enter();
    await screen.findByText("hello team");
    await waitFor(() => expect(screen.queryByText("Sending...")).toBeNull());
    expect(screen.getAllByText("hello team")).toHaveLength(1);
    expect(field().value).toBe("");
    expect(screen.getByText("You")).toBeTruthy();
  });

  it("shows a message as sending until its echo arrives", async () => {
    mock.sim.chatEcho(false);
    const send = vi.spyOn(ipc.team, "chatSend");
    panel();
    type("are you there?");
    enter();
    await screen.findByText("Sending...");
    const msgId = await send.mock.results[0].value;
    mock.sim.chatIn("m_jo", "r_jo1", { msgId, author: "m_me", authorName: "Sam", text: "are you there?", mine: true });
    await waitFor(() => expect(screen.queryByText("Sending...")).toBeNull());
    expect(screen.getAllByText("are you there?")).toHaveLength(1);
  });

  it("says why the owner refused a message, and lets the person remove it", async () => {
    mock.sim.chatEcho(false);
    const send = vi.spyOn(ipc.team, "chatSend");
    panel();
    type("too fast");
    enter();
    await screen.findByText("Sending...");
    const msgId = await send.mock.results[0].value;
    mock.sim.chatDenied("m_jo", "r_jo1", msgId, "rate");
    await screen.findByText("Not sent: too many messages, wait a minute");
    fireEvent.click(screen.getByRole("button", { name: "Remove this message" }));
    await waitFor(() => expect(screen.queryByText("too fast")).toBeNull());
  });

  it("calls a message lost when the owner took it but never echoes it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mock.sim.chatEcho(false);
      panel();
      type("anybody there?");
      enter();
      await screen.findByText("Sending...");
      vi.advanceTimersByTime(31_000);
      await screen.findByText(/no answer from the owner/);
      expect(screen.queryByText("Sending...")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks an owner that was offline for the history again once they are back", async () => {
    const request = vi.spyOn(ipc.team, "chatRequest").mockRejectedValueOnce(new Error("offline"));
    panel();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    mock.sim.setOnline("m_ri", true); // somebody else coming online changes nothing
    await new Promise((r) => setTimeout(r, 20));
    expect(request).toHaveBeenCalledTimes(1);
    mock.sim.setOnline("m_jo", true);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    mock.sim.setOnline("m_jo", true);
    await new Promise((r) => setTimeout(r, 20));
    expect(request).toHaveBeenCalledTimes(2); // answered by the second request: no third
  });

  it("tells when the owner is offline and does not allow writing", async () => {
    render(() => <ChatPanel ownerId="m_jo" ownerName="Jordan" runId="r_jo1" ownerOnline={false} />);
    await screen.findByText(/Jordan is offline/);
    expect(field().disabled).toBe(true);
    expect(sendButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("counts the characters and does not send more than 2000", async () => {
    panel();
    type("x".repeat(2001));
    expect(screen.getByText(/2.?001 \/ 2.?000/)).toBeTruthy();
    expect(sendButton().getAttribute("aria-disabled")).toBe("true");
    enter();
    expect(await ipc.team.chatThread("m_jo", "r_jo1")).toHaveLength(0);
    type("x".repeat(2000));
    expect(sendButton().getAttribute("aria-disabled")).not.toBe("true");
  });

  it("renders teammate text as plain text and names a former member", async () => {
    mock.sim.chatIn("m_jo", "r_jo1", { text: "<img src=x onerror=alert(1)> <b>bold</b>", author: "m_jo" });
    mock.sim.chatIn("m_jo", "r_jo1", { text: "I have left", author: "m_gone", authorName: "" });
    panel();
    const hit = await screen.findByText("<img src=x onerror=alert(1)> <b>bold</b>");
    expect(hit.querySelector("img, b")).toBeNull();
    expect(screen.getByText("Former member")).toBeTruthy();
    expect(screen.getByRole("log").getAttribute("aria-live")).toBe("polite");
  });
});

describe("the Chat sub-tab of the Team view", () => {
  const openRun = async () => {
    render(() => <TeamTab />);
    fireEvent.click(await screen.findByText("Fix the cart total"));
    await screen.findByRole("radio", { name: "Chat" });
  };

  it("counts unread messages, raises a banner, and clears both when the chat is open", async () => {
    const show = vi.spyOn(ipc.notify, "show");
    await openRun();
    mock.sim.chatIn("m_jo", "r_jo1", { text: "can you look at this?", author: "m_jo" });
    await waitFor(() => expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: "question", title: "Jordan wrote in the team chat: can you look at this?" })));
    await waitFor(() => expect(screen.getAllByTitle("1 unread").length).toBeGreaterThan(0)); // on the Chat tab and in the run list
    fireEvent.click(screen.getByRole("radio", { name: /Chat/ }));
    await screen.findByText("can you look at this?");
    await waitFor(() => expect(screen.queryAllByTitle("1 unread")).toHaveLength(0));
    // while the chat is open the message is read at once: no counter, no second banner
    mock.sim.chatIn("m_jo", "r_jo1", { text: "and this", author: "m_jo" });
    await screen.findByText("and this");
    expect(screen.queryByTitle("1 unread")).toBeNull();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("raises one banner per thread in a while, but counts every message", async () => {
    const show = vi.spyOn(ipc.notify, "show");
    await openRun();
    for (const text of ["one", "two", "three"]) mock.sim.chatIn("m_jo", "r_jo1", { text, author: "m_jo" });
    await waitFor(() => expect(screen.getAllByTitle("3 unread").length).toBeGreaterThan(0));
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("does not count or announce history or its own messages", async () => {
    const show = vi.spyOn(ipc.notify, "show");
    await openRun();
    mock.sim.chatHistory("m_jo", "r_jo1", [{ msgId: "h", author: "m_jo", authorName: "Jordan", text: "old", at: 1, mine: false }]);
    mock.sim.chatIn("m_jo", "r_jo1", { text: "mine", author: "m_me", authorName: "Sam", mine: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(show).not.toHaveBeenCalled();
    expect(screen.queryByTitle(/unread/)).toBeNull();
  });

  it("has no control that answers a permission card, sends a prompt or starts a run", async () => {
    await openRun();
    fireEvent.click(screen.getByRole("radio", { name: "Chat" }));
    await screen.findByTestId("team-chat");
    const names = Object.keys(ipc.team).filter((k) => /chat/i.test(k));
    expect(names.sort()).toEqual(["chatRequest", "chatSend", "chatThread", "onChat", "onChatDenied"]);
  });
});

describe("the Team chat strip in the owner's own run view", () => {
  it("is not there outside a team", async () => {
    mock = createMockTeam({ preset: "off" });
    (ipc as { team: unknown }).team = mock;
    render(() => <TeamChatStrip runId="r_me" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("team-chatstrip")).toBeNull();
  });

  it("is not there while the run is not shared", async () => {
    render(() => <TeamChatStrip runId="r_me" />); // no project is switched on
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("team-chatstrip")).toBeNull();
  });

  it("is collapsed by default, opens to the thread and shows the unread count while collapsed", async () => {
    await ipc.team.setShare(PROJECT, true);
    render(() => <TeamChatStrip runId="r_me" />);
    const toggle = await screen.findByRole("button", { name: /Team chat/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("team-chat")).toBeNull();
    mock.sim.chatIn(null, "r_me", { text: "ping from Jordan", author: "m_jo" });
    await screen.findByTitle("1 unread");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await screen.findByText("ping from Jordan");
    await waitFor(() => expect(screen.queryByTitle("1 unread")).toBeNull());
    // the owner posts in his own run: no owner id, no history request
    type("on my way");
    enter();
    await waitFor(() => expect(screen.getAllByText("on my way")).toHaveLength(1));
    expect(mock.sim.chatRequests()).toEqual([]);
  });

  it("a run opted out of sharing has no strip", async () => {
    await ipc.team.setShare(PROJECT, true);
    await ipc.team.runShare("r_me", false);
    render(() => <TeamChatStrip runId="r_me" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("team-chatstrip")).toBeNull();
  });
});

describe("the mock chat backend", () => {
  it("refuses an empty message, an offline owner and a stranger", async () => {
    await expect(ipc.team.chatSend("m_jo", "r_jo1", "   ")).rejects.toMatchObject({ code: "chatInvalid" });
    await expect(ipc.team.chatSend("m_jo", "r_jo1", "x".repeat(2001))).rejects.toMatchObject({ code: "chatInvalid" });
    await expect(ipc.team.chatSend("m_ri", "r_jo1", "hi")).rejects.toMatchObject({ code: "offline" });
    await expect(ipc.team.chatSend("m_nobody", "r_jo1", "hi")).rejects.toMatchObject({ code: "unknownMember" });
  });

  it("keeps 200 messages per thread, oldest dropped", async () => {
    for (let i = 0; i < 205; i++) mock.sim.chatIn(null, "r_me", { text: `m${i}`, author: "m_jo", at: i + 1 });
    const thread = await ipc.team.chatThread(null, "r_me");
    expect(thread).toHaveLength(200);
    expect(thread[0].text).toBe("m5");
  });
});
