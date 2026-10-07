import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { createMockHappy, type ChatScenario, type MockChatSim } from "../../ipc/mock/happy";
import { startHappyWatch } from "../../store/happy";
import { installDomStubs } from "../../store/testing-u2";
import { toast } from "../../ui-kit";
import {
  applyEvent,
  backToLatest,
  channelMembers,
  chatErrorText,
  chatMainView,
  chatSummary,
  closeThread,
  consumeAnchor,
  convoOf,
  createChannel,
  deleteMessage,
  discardMessage,
  editMessage,
  inviteMembers,
  jumpToMessage,
  leaveChannel,
  loadNewer,
  loadOlder,
  openChatAt,
  openDirect,
  openThread,
  activeChannelId,
  pinMessage,
  refreshThreads,
  resetChat,
  retryMessage,
  searchChat,
  sendMessage,
  sendReply,
  setActiveChannel,
  setChannelPreferences,
  setChatMainView,
  setChatScreen,
  showChannel,
  startChat,
  threadOf,
  threadsList,
  threadPanel,
  toggleReaction,
  updateChannelInfo,
  joinChannel,
  browseChannels,
  removeMember,
  hideChannel,
  MAX_KEPT,
} from "./state";

installDomStubs();

const original = ipc.happy;
const flush = () => new Promise((r) => setTimeout(r, 0));
let stops: (() => void)[] = [];
let sim: MockChatSim;

async function bring(scenario: ChatScenario = "ok") {
  const happy = createMockHappy({ preset: "connected", chat: scenario });
  sim = happy.chatSim;
  (ipc as { happy: unknown }).happy = happy;
  const status = await happy.status();
  vi.spyOn(ipc.settings, "get").mockResolvedValue(status.config);
  stops.push(startHappyWatch());
  await flush();
  stops.push(startChat());
  await flush();
  await flush();
}

beforeEach(() => {
  setChatScreen("list");
  setActiveChannel(undefined);
  localStorage.clear();
});
afterEach(() => {
  stops.forEach((s) => s());
  stops = [];
  resetChat();
  toast.clear();
  (ipc as { happy: unknown }).happy = original;
  vi.restoreAllMocks();
});

const ROOT = "m_c_dev_4";
const ids = (id: string) => convoOf(id)!.items.map((m) => m.id);

describe("threads", () => {
  it("a reply goes to the thread and never into the channel list, and does not bump the channel unread", async () => {
    await bring();
    await showChannel("c_dev");
    const before = ids("c_dev");
    await openThread("c_dev", ROOT);
    expect(threadPanel()).toEqual({ channelId: "c_dev", rootId: ROOT });
    expect(threadOf(ROOT)!.replies).toHaveLength(3);
    expect(await sendReply("c_dev", ROOT, "köszi, megvan", ["u_2"])).toBe(true);
    const replies = threadOf(ROOT)!.replies;
    expect(replies).toHaveLength(4);
    expect(replies.at(-1)).toMatchObject({ text: "köszi, megvan", sendState: "sent", threadRoot: ROOT });
    expect(ids("c_dev")).toEqual(before);
    // the root's replyCount arrives as an `updated` event of the root and is kept in sync in the thread and in the channel
    expect(threadOf(ROOT)!.root!.replyCount).toBe(4);
    expect(convoOf("c_dev")!.items.find((m) => m.id === ROOT)!.replyCount).toBe(4);
    sim.receiveReply(ROOT, "még egy");
    expect(threadOf(ROOT)!.replies).toHaveLength(5);
    expect(ids("c_dev")).toEqual(before);
    expect(chatSummary()!.channels.find((c) => c.id === "c_dev")!.unreadCount).toBe(0);
  });

  it("opening a thread with news clears the thread unread; closing it drops the data", async () => {
    await bring();
    expect(chatSummary()!.threadUnread).toBe(1);
    await refreshThreads();
    expect(ipc.happy.chat).toBeDefined();
    await openThread("c_general", "m_c_general_4", "r_m_c_general_4_2");
    expect(threadOf("m_c_general_4")!.focusId).toBe("r_m_c_general_4_2");
    await flush();
    expect(chatSummary()!.threadUnread).toBe(0);
    closeThread();
    expect(threadPanel()).toBeUndefined();
    expect(threadOf("m_c_general_4")).toBeUndefined();
  });

  it("a live reply in the open thread re-reads it (debounced) instead of counting itself unread (C6)", async () => {
    await bring();
    await refreshThreads();
    await openThread("c_dev", ROOT);
    await flush();
    globalThis.dispatchEvent(new Event("focus")); // jsdom reports no focus; the user is looking at the window
    vi.useFakeTimers();
    try {
      const read = vi.spyOn(ipc.happy.chat, "thread");
      sim.receiveReply(ROOT, "egy");
      sim.receiveReply(ROOT, "kettő");
      expect(read).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(600);
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(ROOT);
      expect(threadsList.items.find((i) => i.root.id === ROOT)?.unreadCount ?? 0).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed reply can be retried and discarded in its thread", async () => {
    await bring();
    await openThread("c_dev", ROOT);
    sim.failNext("boom");
    expect(await sendReply("c_dev", ROOT, "nem megy", [])).toBe(false);
    const failed = threadOf(ROOT)!.replies.find((m) => m.sendState === "failed")!;
    expect(failed.errorCode).toBe("boom");
    retryMessage("c_dev", failed.clientMessageId!, ROOT);
    await flush();
    expect(threadOf(ROOT)!.replies.filter((m) => m.text === "nem megy")).toEqual([expect.objectContaining({ sendState: "sent" })]);
    sim.failNext("boom");
    await sendReply("c_dev", ROOT, "másik", []);
    discardMessage("c_dev", threadOf(ROOT)!.replies.find((m) => m.sendState === "failed")!.clientMessageId!, ROOT);
    expect(threadOf(ROOT)!.replies.some((m) => m.text === "másik")).toBe(false);
  });

  it("lists the threads and toggles the main view", async () => {
    await bring();
    await refreshThreads();
    const { threadsList } = await import("./state");
    expect(threadsList.items.map((i) => i.channelName)).toEqual(expect.arrayContaining(["general", "dev", "ops"]));
    setChatMainView("threads");
    expect(chatMainView()).toBe("threads");
    setActiveChannel("c_dev");
    expect(chatMainView()).toBe("channel");
  });
});

describe("events", () => {
  it("ignores `updated` for a message the window does not hold, and inserts `new` ones", async () => {
    await bring();
    await showChannel("c_ops");
    const before = ids("c_ops");
    const stray = { ...convoOf("c_ops")!.items.at(-1)!, id: "m_unknown", clientMessageId: null, text: "elsewhere" };
    applyEvent({ type: "message", channelId: "c_ops", message: stray, change: "updated", notify: false });
    expect(ids("c_ops")).toEqual(before);
    applyEvent({ type: "message", channelId: "c_ops", message: stray, change: "new", notify: false });
    expect(ids("c_ops")).toContain("m_unknown");
  });
});

describe("history", () => {
  it("jumps to a message, anchors it, pages forward and goes back to the latest", async () => {
    await bring("big");
    await showChannel("c_dev");
    expect(convoOf("c_dev")!.jumped).toBe(false);
    await jumpToMessage("c_dev", "m_c_dev_100");
    const c = convoOf("c_dev")!;
    expect(c).toMatchObject({ jumped: true, hasNewer: true, hasMore: true, anchorId: "m_c_dev_100" });
    expect(c.firstUnreadId).toBeUndefined();
    expect(ids("c_dev")).toContain("m_c_dev_100");
    expect(consumeAnchor("c_dev")).toBe("m_c_dev_100");
    expect(consumeAnchor("c_dev")).toBeUndefined();
    // live messages are not appended into a jump window, they flag the pill
    sim.receive("c_dev", "live while jumped");
    expect(convoOf("c_dev")!.items.some((m) => m.text === "live while jumped")).toBe(false);
    expect(convoOf("c_dev")!.newBelow).toBe(true);
    const last = ids("c_dev").at(-1)!;
    await loadNewer("c_dev");
    expect(ids("c_dev").at(-1)).not.toBe(last);
    await backToLatest("c_dev");
    expect(convoOf("c_dev")).toMatchObject({ jumped: false, hasNewer: false, newBelow: false });
    expect(convoOf("c_dev")!.items.at(-1)!.text).toBe("live while jumped");
  });

  it("keeps the window bounded: paging back trims the newest side and allows paging forward again", async () => {
    await bring("big");
    await showChannel("c_dev");
    for (let i = 0; i < 8; i++) await loadOlder("c_dev");
    const c = convoOf("c_dev")!;
    expect(c.items.length).toBeLessThanOrEqual(MAX_KEPT);
    expect(c.hasNewer).toBe(true);
    expect(c.jumped).toBe(true);
    await loadNewer("c_dev");
    expect(convoOf("c_dev")!.items.length).toBeLessThanOrEqual(MAX_KEPT);
    expect(convoOf("c_dev")!.hasMore).toBe(true);
  });

  it("openChatAt selects the channel and jumps (and opens the thread for a reply target)", async () => {
    await bring();
    openChatAt({ channelId: "c_dev", messageId: "m_c_dev_10" });
    expect(activeChannelId()).toBe("c_dev");
    await showChannel("c_dev"); // what the mounted conversation does
    expect(convoOf("c_dev")!.anchorId).toBe("m_c_dev_10");
    hideChannel("c_dev");
    openChatAt({ channelId: "c_dev", threadRootId: ROOT, messageId: `r_${ROOT}_2` });
    await flush();
    expect(threadPanel()).toEqual({ channelId: "c_dev", rootId: ROOT });
    expect(threadOf(ROOT)!.focusId).toBe(`r_${ROOT}_2`);
  });
});

describe("actions", () => {
  it("opens a group conversation once", async () => {
    await bring();
    const g = await openDirect(["u_4", "u_5"]);
    expect(g).toMatchObject({ kind: "group", name: "Szabó Réka, Tóth Gábor" });
    expect(activeChannelId()).toBe(g!.id);
    expect(chatSummary()!.channels.filter((c) => c.id === g!.id)).toHaveLength(1);
    expect((await openDirect(["u_5", "u_4"]))!.id).toBe(g!.id);
    expect(chatSummary()!.channels.filter((c) => c.id === g!.id)).toHaveLength(1);
  });

  it("maps create-channel errors to translated texts", async () => {
    await bring();
    await expect(createChannel({ name: "  " })).rejects.toMatchObject({ code: "NAME_REQUIRED", message: "The channel needs a name" });
    await expect(createChannel({ name: "Dev" })).rejects.toMatchObject({ code: "CHANNEL_NAME_TAKEN", message: "A channel with this name already exists" });
    sim.setPermissions({ canCreateChannel: false });
    await expect(createChannel({ name: "uj" })).rejects.toMatchObject({ code: "CREATE_FORBIDDEN" });
    sim.setPermissions({ canCreateChannel: true });
    const c = await createChannel({ name: "uj-csatorna", private: true, memberIds: ["u_2"] });
    expect(c).toMatchObject({ kind: "private", role: "admin", memberCount: 2 });
    expect(activeChannelId()).toBe(c.id);
    expect(chatSummary()!.channels.some((x) => x.id === c.id)).toBe(true);
    expect(chatErrorText({ code: "INSUFFICIENT_CREDITS" })).toBe("Your store has no chat credits left");
    expect(chatErrorText({ code: "weird", message: "raw" })).toBe("raw");
    expect(chatErrorText({})).toBe("Something went wrong, try again");
  });

  it("refuses invites into direct conversations and private channels without admin rights", async () => {
    await bring();
    await expect(inviteMembers("d_anna", ["u_4"])).rejects.toMatchObject({ code: "DIRECT_IMMUTABLE" });
    await expect(inviteMembers("g_u_2_u_3", ["u_4"])).rejects.toMatchObject({ code: "DIRECT_IMMUTABLE" });
    await expect(inviteMembers("c_hr", ["u_6"])).rejects.toMatchObject({ code: "MANAGE_FORBIDDEN", message: "This private channel needs a channel admin" });
    await expect(inviteMembers("c_management", [])).rejects.toMatchObject({ code: "USERS_REQUIRED" });
    const before = chatSummary()!.channels.find((c) => c.id === "c_management")!.memberCount;
    expect((await inviteMembers("c_management", ["u_6"])).map((m) => m.id)).toEqual(["u_6"]);
    expect(chatSummary()!.channels.find((c) => c.id === "c_management")!.memberCount).toBe(before + 1);
    expect((await channelMembers("c_management")).map((m) => m.id)).toContain("u_6");
    await removeMember("c_management", "u_6");
    expect(chatSummary()!.channels.find((c) => c.id === "c_management")!.memberCount).toBe(before);
  });

  it("joins a browsed channel and leaves another, falling back to a remaining channel", async () => {
    await bring();
    const found = await browseChannels("des");
    expect(found.map((c) => c.id)).toEqual(["c_design"]);
    const joined = await joinChannel("c_design");
    expect(joined.isMember).toBe(true);
    expect(activeChannelId()).toBe("c_design");
    expect(await browseChannels()).toEqual([]);
    await leaveChannel("c_design");
    expect(chatSummary()!.channels.some((c) => c.id === "c_design")).toBe(false);
    expect(activeChannelId()).not.toBe("c_design");
    expect(activeChannelId()).toBeDefined();
    await expect(leaveChannel("d_anna")).rejects.toMatchObject({ code: "DIRECT_IMMUTABLE" });
  });

  it("edits, reacts, pins, deletes and searches, updating the open conversation", async () => {
    await bring();
    await showChannel("c_dev");
    const mine = convoOf("c_dev")!.items.find((m) => m.mine)!;
    await editMessage(mine.id, "javított szöveg");
    expect(convoOf("c_dev")!.items.find((m) => m.id === mine.id)).toMatchObject({ text: "javított szöveg", edited: true });
    await toggleReaction(mine.id, "👍");
    expect(convoOf("c_dev")!.items.find((m) => m.id === mine.id)!.reactions).toEqual([{ emoji: "👍", count: 1, mine: true }]);
    await toggleReaction(mine.id, "👍");
    expect(convoOf("c_dev")!.items.find((m) => m.id === mine.id)!.reactions).toEqual([]);
    await pinMessage(mine.id, true);
    expect(convoOf("c_dev")!.items.find((m) => m.id === mine.id)!.pinned).toBe(true);
    expect((await searchChat("javított")).messages.map((h) => h.message.id)).toEqual([mine.id]);
    await deleteMessage("c_dev", mine.id);
    expect(convoOf("c_dev")!.items.find((m) => m.id === mine.id)).toMatchObject({ deleted: true, text: "" });
    await expect(editMessage("m_c_dev_1", "x")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("updates preferences and channel info in the list", async () => {
    await bring();
    await setChannelPreferences("c_dev", { starred: true, notifyLevel: "all" });
    expect(chatSummary()!.channels.find((c) => c.id === "c_dev")).toMatchObject({ starred: true, notifyLevel: "all" });
    await updateChannelInfo("c_dev", { topic: "új téma" });
    expect(chatSummary()!.channels.find((c) => c.id === "c_dev")!.topic).toBe("új téma");
    await expect(updateChannelInfo("c_hr", { topic: "x" })).rejects.toMatchObject({ code: "MANAGE_FORBIDDEN" });
    await expect(updateChannelInfo("d_anna", { topic: "x" })).rejects.toMatchObject({ code: "DIRECT_IMMUTABLE" });
  });

  it("sending while jumped goes back to the latest first", async () => {
    await bring("big");
    await jumpToMessage("c_dev", "m_c_dev_100");
    await sendMessage("c_dev", "hello újra");
    await flush();
    await flush();
    expect(convoOf("c_dev")!.jumped).toBe(false);
    expect(convoOf("c_dev")!.items.at(-1)).toMatchObject({ text: "hello újra", sendState: "sent" });
  });
});
