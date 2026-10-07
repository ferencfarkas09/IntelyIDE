import { describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../happy";
import { createMockHappy } from "./happy";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";

describe("mock team chat", () => {
  it("refuses work until chat is switched on, like the real provider", async () => {
    const happy = createMockHappy({ preset: "off" });
    await expect(happy.chat.summary()).rejects.toMatchObject({ code: "notConnected" });
    await happy.setConfig({ master: true, chat: { enabled: true } });
    await happy.saveToken(TOKEN);
    expect((await happy.status()).providers.find((p) => p.id === "chat")?.state).toBe("ready");
    expect((await happy.chat.summary()).channels.length).toBeGreaterThan(3);
  });

  it("opens a channel with its newest page, then pages backwards without repeats", async () => {
    const happy = createMockHappy({ preset: "connected", chat: "big" });
    const page = await happy.chat.open("c_dev");
    expect(page.messages).toHaveLength(50);
    expect(page.hasMore).toBe(true);
    const older = await happy.chat.older("c_dev", page.cursor!);
    const ids = new Set([...page.messages, ...older.messages].map((m) => m.id));
    expect(ids.size).toBe(100);
    expect(older.messages.at(-1)!.createdAtMs).toBeLessThanOrEqual(page.messages[0]!.createdAtMs);
  });

  it("sends idempotently per client id, spends credits and echoes a replaced event", async () => {
    const happy = createMockHappy({ preset: "connected" });
    const events: ChatEvent[] = [];
    happy.chat.onEvent((e) => events.push(e));
    const before = (await happy.chat.summary()).credits!;
    const a = await happy.chat.send("c_dev", "szia", "cid-1");
    const b = await happy.chat.send("c_dev", "szia", "cid-1");
    expect(b.id).toBe(a.id);
    expect((await happy.chat.summary()).credits).toBeCloseTo(before - 0.02, 5);
    expect(events.some((e) => e.type === "message" && e.change === "replaced" && e.message.clientMessageId === "cid-1")).toBe(true);
    await expect(happy.chat.send("c_dev", "   ", "cid-2")).rejects.toMatchObject({ code: "validation" });
    await expect(happy.chat.send("c_dev", "x".repeat(8001), "cid-3")).rejects.toMatchObject({ code: "validation" });
  });

  it("answers 402 when the credits are gone and recovers when they are back", async () => {
    const happy = createMockHappy({ preset: "connected", chat: "nocredits" });
    expect((await happy.chat.summary()).creditsEmpty).toBe(true);
    await expect(happy.chat.send("c_dev", "hi", "c1")).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    happy.chatSim.setCredits(5);
    expect((await happy.chat.summary()).creditsEmpty).toBe(false);
    await expect(happy.chat.send("c_dev", "hi", "c1")).resolves.toMatchObject({ sendState: "sent" });
  });

  it("counts unread for channels that are not open, asks for a toast by the notify level, and markRead clears", async () => {
    const happy = createMockHappy({ preset: "connected" });
    const events: ChatEvent[] = [];
    happy.chat.onEvent((e) => events.push(e));
    const notifies = () => events.filter((e) => e.type === "message").map((e) => (e as Extract<ChatEvent, { type: "message" }>).notify);
    await happy.chat.open("c_dev");
    happy.chatSim.receive("c_dev", "while you look");
    happy.chatSim.receive("c_ops", "plain message in a mentions-only channel");
    happy.chatSim.receive("c_ops", "@Teszt Elek please look");
    happy.chatSim.receive("d_anna", "direct message");
    expect(notifies()).toEqual([false, false, true, true]);
    const s = await happy.chat.summary();
    expect(s.channels.find((c) => c.id === "c_dev")!.unreadCount).toBe(0);
    expect(s.channels.find((c) => c.id === "c_ops")!.unreadCount).toBe(16);
    await happy.chat.markRead("c_ops");
    expect((await happy.chat.summary()).channels.find((c) => c.id === "c_ops")!.unreadCount).toBe(0);
    expect(happy.chatSim.readCalls()).toEqual(["c_ops"]);
  });

  it("finds people, opens a direct channel once, and fails loudly for unknown ones", async () => {
    const happy = createMockHappy({ preset: "connected" });
    expect((await happy.chat.people("rék")).map((p) => p.name)).toEqual(["Szabó Réka"]);
    const dm = await happy.chat.direct("u_4");
    expect((await happy.chat.direct("u_4")).id).toBe(dm.id);
    await expect(happy.chat.direct("nope")).rejects.toMatchObject({ code: "notFound" });
  });

  it("only opens https links", async () => {
    const happy = createMockHappy({ preset: "connected" });
    await expect(happy.openExternal("https://a.test/x")).resolves.toBeUndefined();
    for (const bad of ["http://a.test", "javascript:1", "file:///x", "-a"]) await expect(happy.openExternal(bad)).rejects.toMatchObject({ code: "openFailed" });
    expect((globalThis as { __mockOpened?: string[] }).__mockOpened).toEqual(["https://a.test/x"]);
  });

  it("starts in the scenario's state: forbidden, signed out, offline", async () => {
    const state = async (chat: "forbidden" | "signedout" | "offline" | "notenabled") => (await createMockHappy({ preset: "connected", chat }).status()).providers.find((p) => p.id === "chat")!.state;
    expect(await Promise.all([state("forbidden"), state("signedout"), state("offline"), state("notenabled")])).toEqual(["notPermitted", "signedOut", "degraded", "notPermitted"]);
    const empty = createMockHappy({ preset: "connected", chat: "empty" });
    expect((await empty.chat.summary()).channels).toEqual([]);
    vi.restoreAllMocks();
  });

  it("the notenabled scenario says TEAM_CHAT_NOT_ENABLED in the provider state and in every call", async () => {
    const happy = createMockHappy({ preset: "connected", chat: "notenabled" });
    const chat = (await happy.status()).providers.find((p) => p.id === "chat")!;
    expect(chat).toMatchObject({ state: "notPermitted", lastError: { code: "TEAM_CHAT_NOT_ENABLED" } });
    await expect(happy.chat.summary()).rejects.toMatchObject({ code: "TEAM_CHAT_NOT_ENABLED" });
  });

  it("seeds public, private (admin and not), a browsable channel, a direct and a group conversation, with topics", async () => {
    const happy = createMockHappy({ preset: "connected" });
    const s = await happy.chat.summary();
    const by = (id: string) => s.channels.find((c) => c.id === id)!;
    expect(by("c_dev")).toMatchObject({ kind: "channel", topic: expect.any(String), memberCount: 6, role: "admin", isMember: true });
    expect(by("c_management")).toMatchObject({ kind: "private", role: "admin" });
    expect(by("c_hr")).toMatchObject({ kind: "private", role: "member" });
    expect(by("g_u_2_u_3")).toMatchObject({ kind: "group", peers: [{ id: "u_2" }, { id: "u_3" }] });
    expect(by("d_anna").peers).toEqual([{ id: "u_2", name: "Kovács Anna", detail: "Backend" }]);
    expect(s.channels.some((c) => c.id === "c_design")).toBe(false);
    expect(s).toMatchObject({ canCreateChannel: true, canManageChannels: true, threadUnread: 1 });
  });

  it("pages with real cursors: around, newer, older", async () => {
    const happy = createMockHappy({ preset: "connected", chat: "big" });
    const around = await happy.chat.around("c_dev", "m_c_dev_200");
    expect(around).toMatchObject({ anchorId: "m_c_dev_200", hasMore: true, hasNewer: true });
    expect(around.messages.some((m) => m.id === "m_c_dev_200")).toBe(true);
    const newer = await happy.chat.newer("c_dev", around.messages.at(-1)!.id);
    expect(newer.messages[0]!.createdAtMs).toBeGreaterThan(around.messages.at(-1)!.createdAtMs);
    const older = await happy.chat.older("c_dev", around.cursor!);
    expect(older.messages.at(-1)!.id).not.toBe(around.messages[0]!.id);
    const top = await happy.chat.around("c_dev", "m_c_dev_420");
    expect(top.hasNewer).toBe(false);
    await expect(happy.chat.around("c_dev", "nope")).rejects.toMatchObject({ code: "notFound" });
    expect((await happy.chat.open("c_dev")).hasNewer).toBe(false);
  });

  it("threads: replies update the root, never the channel unread, and reading the thread clears its unread", async () => {
    const happy = createMockHappy({ preset: "connected" });
    const events: ChatEvent[] = [];
    happy.chat.onEvent((e) => events.push(e));
    const root = "m_c_dev_4";
    const view = await happy.chat.thread(root);
    expect(view).toMatchObject({ channelId: "c_dev", root: { replyCount: 3 } });
    expect(view.replies.every((r) => r.threadRoot === root)).toBe(true);
    const sent = await happy.chat.send("c_dev", "válasz", "t-1", { threadRootId: root, mentions: ["u_2"] });
    expect(sent.threadRoot).toBe(root);
    expect(events.some((e) => e.type === "message" && e.message.id === root && e.change === "updated" && e.message.replyCount === 4)).toBe(true);
    expect(events.some((e) => e.type === "message" && e.message.threadRoot === root && e.message.clientMessageId === "t-1")).toBe(true);
    const page = await happy.chat.open("c_dev");
    expect(page.messages.some((m) => m.threadRoot)).toBe(false);
    expect(page.messages.find((m) => m.id === root)).toMatchObject({ replyCount: 4, replyUsers: [{ id: "u_2" }, { id: "u_1" }] });
    await expect(happy.chat.send("c_dev", "x", "t-2", { threadRootId: "nope" })).rejects.toMatchObject({ code: "notFound" });

    // news in a thread: unread count in the summary until the thread is opened again
    expect((await happy.chat.summary()).threadUnread).toBe(1);
    const reply = happy.chatSim.receiveReply("m_c_general_4", "újabb");
    expect(reply.threadRoot).toBe("m_c_general_4");
    const list = await happy.chat.threads();
    expect(list.map((i) => i.root.id)).toEqual(expect.arrayContaining(["m_c_general_4", root]));
    expect((await happy.chat.threads(true)).map((i) => i.root.id)).toEqual(["m_c_general_4"]);
    expect((await happy.chat.threads(true))[0]).toMatchObject({ unreadCount: 2, channelName: "general", channelKind: "channel" });
    expect((await happy.chat.summary()).channels.find((c) => c.id === "c_general")!.unreadCount).toBe(3);
    await happy.chat.thread("m_c_general_4");
    expect((await happy.chat.summary()).threadUnread).toBe(0);
    happy.chatSim.markThreadUnread(root, 2);
    expect((await happy.chat.summary()).threadUnread).toBe(1);
  });

  it("creates, browses, joins, leaves and updates channels with the real refusals", async () => {
    const happy = createMockHappy({ preset: "connected" });
    const chat = happy.chat;
    await expect(chat.createChannel({ name: " " })).rejects.toMatchObject({ code: "NAME_REQUIRED" });
    await expect(chat.createChannel({ name: "DEV" })).rejects.toMatchObject({ code: "CHANNEL_NAME_TAKEN" });
    const made = await chat.createChannel({ name: "marketing", private: true, memberIds: ["u_2", "u_3"] });
    expect(made).toMatchObject({ kind: "private", role: "admin", memberCount: 3 });
    happy.chatSim.setPermissions({ canCreateChannel: false });
    expect((await chat.summary()).canCreateChannel).toBe(false);
    await expect(chat.createChannel({ name: "x" })).rejects.toMatchObject({ code: "CREATE_FORBIDDEN" });
    expect((await chat.browse("DES")).map((c) => c.id)).toEqual(["c_design"]);
    const joined = await chat.join("c_design");
    expect(joined).toMatchObject({ isMember: true, role: "member" });
    expect((await chat.summary()).channels.some((c) => c.id === "c_design")).toBe(true);
    expect(await chat.browse()).toEqual([]);
    await chat.leave("c_design");
    expect((await chat.browse()).map((c) => c.id)).toEqual(["c_design"]);
    await expect(chat.leave("d_anna")).rejects.toMatchObject({ code: "DIRECT_IMMUTABLE" });
    expect(await chat.updateChannel("c_dev", { topic: "új", description: "leírás" })).toMatchObject({ topic: "új", description: "leírás" });
    await expect(chat.updateChannel("c_hr", { topic: "x" })).rejects.toMatchObject({ code: "MANAGE_FORBIDDEN" });
    await expect(chat.updateChannel("c_dev", { name: "ops" })).rejects.toMatchObject({ code: "CHANNEL_NAME_TAKEN" });
    const starred = await chat.setPreferences("c_dev", { starred: true, notifyLevel: "none", mutedUntilMs: Date.now() + 1000 * 60 });
    expect(starred).toMatchObject({ starred: true, notifyLevel: "none", muted: true });
    expect((await chat.setPreferences("c_dev", { mutedUntilMs: 0 })).muted).toBe(false);
  });

  it("members: invite, remove, and the direct/private refusals; direct opens a group for 2 to 7 people", async () => {
    const happy = createMockHappy({ preset: "connected" });
    const chat = happy.chat;
    expect((await chat.members("c_management")).map((m) => m.id)).toEqual(["u_1", "u_5"]);
    expect((await chat.members("c_management")).find((m) => m.id === "u_1")!.role).toBe("admin");
    expect((await chat.addMembers("c_management", ["u_5", "u_6"])).map((m) => m.id)).toEqual(["u_6"]);
    expect((await chat.summary()).channels.find((c) => c.id === "c_management")!.memberCount).toBe(3);
    await chat.removeMember("c_management", "u_6");
    await expect(chat.addMembers("d_anna", ["u_6"])).rejects.toMatchObject({ code: "DIRECT_IMMUTABLE" });
    await expect(chat.addMembers("g_u_2_u_3", ["u_6"])).rejects.toMatchObject({ code: "DIRECT_IMMUTABLE" });
    await expect(chat.removeMember("d_anna", "u_2")).rejects.toMatchObject({ code: "DIRECT_IMMUTABLE" });
    await expect(chat.addMembers("c_hr", ["u_6"])).rejects.toMatchObject({ code: "MANAGE_FORBIDDEN" });
    await expect(chat.addMembers("c_dev", [])).rejects.toMatchObject({ code: "USERS_REQUIRED" });
    const group = await chat.direct(["u_4", "u_5", "u_6"]);
    expect(group).toMatchObject({ kind: "group", memberCount: 4, name: "Szabó Réka, Tóth Gábor, Horváth Dóra" });
    expect((await chat.direct(["u_6", "u_5", "u_4"])).id).toBe(group.id);
    await expect(chat.direct([])).rejects.toMatchObject({ code: "USERS_REQUIRED" });
    expect((await chat.direct("u_2")).id).toBe("d_anna");
  });

  it("edits, deletes, reacts, pins and searches", async () => {
    const happy = createMockHappy({ preset: "connected" });
    const chat = happy.chat;
    const events: ChatEvent[] = [];
    chat.onEvent((e) => events.push(e));
    const mine = (await chat.open("c_dev")).messages.find((m) => m.mine)!;
    expect(await chat.edit(mine.id, "szerkesztve")).toMatchObject({ text: "szerkesztve", edited: true });
    await expect(chat.edit("m_c_dev_1", "x")).rejects.toMatchObject({ code: "forbidden" });
    expect((await chat.react(mine.id, "🎉")).reactions).toEqual([{ emoji: "🎉", count: 1, mine: true }]);
    expect((await chat.react(mine.id, "🎉")).reactions).toEqual([]);
    expect((await chat.pin(mine.id, true)).pinned).toBe(true);
    const hits = await chat.search("szerkesztve");
    expect(hits.messages).toMatchObject([{ channelName: "dev", message: { id: mine.id } }]);
    expect(await chat.search("a")).toEqual({ messages: [], channels: [], people: [] });
    expect((await chat.search("anna")).people.map((p) => p.id)).toContain("u_2");
    expect((await chat.search("ops")).channels.map((c) => c.name)).toContain("ops");
    await chat.remove("c_dev", mine.id);
    expect(events.some((e) => e.type === "message" && e.change === "deleted" && e.message.id === mine.id && e.message.deleted)).toBe(true);
    expect((await chat.search("szerkesztve")).messages).toEqual([]);
    await expect(chat.remove("c_dev", "m_c_dev_1")).rejects.toMatchObject({ code: "forbidden" });
  });
});
