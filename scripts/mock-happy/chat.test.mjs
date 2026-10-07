// Node tests for the mock Happy team chat (REAL wire shapes): REST and the Socket.IO server, spoken with a raw Engine.IO v4 /
// Socket.IO v5 client built on Node's global WebSocket. `node --test scripts/mock-happy/chat.test.mjs`
// (needs `pnpm install --ignore-workspace` in scripts/mock-happy for the `socket.io` package; without it the socket tests skip).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ANNA, BELA, DM, DORA, GENERAL, GROUP, ME, OPS, PETER, RANDOM, sleep, startMock } from "./helpers.mjs";

let m;
before(async () => void (m = await startMock()));
after(() => m.close());
const api = (...a) => m.api(...a);
const reset = () => m.reset();
const control = (...a) => m.control(...a);
const connect = (...a) => m.connect(...a);
const sockTest = (name, fn) =>
  test(name, async (t) => {
    if (!m.hasSockets) return t.skip("socket.io is not installed (pnpm install --ignore-workspace in scripts/mock-happy)");
    await fn(t);
  });
const msgs = async (path) => (await api("GET", path)).json;

test("bootstrap lists my channels with counters under `me`, DMs have an empty name and directPeers", async () => {
  await reset();
  const { status, json } = await api("GET", "/api/chat/bootstrap?restaurantId=5f9000000000000000000001");
  assert.equal(status, 200);
  assert.deepEqual(json.channels.map((c) => c._id), [GENERAL, OPS, DM, GROUP], "#random is not joined: it is only in browse");
  assert.equal(json.unreadTotal, 3);
  assert.equal(json.mentionTotal, 1);
  assert.deepEqual([json.me._id, json.me.isPortal], [ME, false]);
  assert.equal(json.credits.balance, 12.5);
  assert.equal(json.permissions.createChannel, true);
  const general = json.channels[0];
  assert.equal(general.me.unreadCount, 2);
  assert.equal(general.me.mentionCount, 1);
  assert.equal(general.type, "public");
  const dm = json.channels[2];
  assert.deepEqual([dm.type, dm.name, dm.directPeers.map((p) => p._id)], ["direct", "", [ANNA]]);
  assert.deepEqual(json.channels[3].directPeers.map((p) => p._id), [ANNA, PETER]);
  assert.equal(json.channels[1].me.role, "admin");
  assert.equal((await api("GET", "/api/chat/bootstrap", undefined, "wrong.token.here")).status, 401);
});

test("messages page oldest to newest with before cursors, hasMore, a limit cap and top-level only", async () => {
  await reset();
  const first = await msgs(`/api/chat/channels/${GENERAL}/messages?limit=50`);
  assert.equal(first.items.length, 50);
  assert.deepEqual([first.hasMore, first.hasNewer], [true, false]);
  assert.ok(first.items.every((x, i, a) => i === 0 || a[i - 1]._id < x._id), "oldest first");
  assert.ok(first.items.every((x) => x.threadRoot === null), "replies are not top-level");
  const second = await msgs(`/api/chat/channels/${GENERAL}/messages?limit=50&before=${first.items[0]._id}`);
  assert.equal(second.items.length, 50);
  assert.ok(second.items.every((x) => x._id < first.items[0]._id));
  assert.equal(second.hasNewer, true);
  const third = await msgs(`/api/chat/channels/${GENERAL}/messages?limit=50&before=${second.items[0]._id}`);
  assert.equal(third.items.length, 30);
  assert.equal(third.hasMore, false);
  assert.equal((await msgs(`/api/chat/channels/${GENERAL}/messages?limit=500`)).items.length, 100, "limit is capped at 100");
  assert.equal((await api("GET", `/api/chat/channels/${GENERAL}/messages?before=nope`)).json.code, "INVALID_CURSOR");
  assert.equal((await api("GET", "/api/chat/channels/5f1000000000000000000999/messages")).status, 404);
  assert.equal((await api("GET", `/api/chat/channels/${OPS}/messages`)).status, 200);
});

test("around centres a window on a message, after pages forward, and a reply anchors on its thread root", async () => {
  await reset();
  const all = [];
  let page = await msgs(`/api/chat/channels/${GENERAL}/messages?limit=100`);
  all.unshift(...page.items);
  page = await msgs(`/api/chat/channels/${GENERAL}/messages?limit=100&before=${all[0]._id}`);
  all.unshift(...page.items);
  assert.equal(all.length, 130);
  const target = all[60];
  const around = await msgs(`/api/chat/channels/${GENERAL}/messages?limit=20&around=${target._id}`);
  assert.equal(around.anchorId, target._id);
  assert.equal(around.anchorThreadRoot, null);
  assert.equal(around.items.length, 20);
  assert.ok(around.items.some((x) => x._id === target._id));
  assert.deepEqual([around.hasMore, around.hasNewer], [true, true]);
  const after = await msgs(`/api/chat/channels/${GENERAL}/messages?limit=20&after=${all[100]._id}`);
  assert.deepEqual(after.items.map((x) => x._id), all.slice(101, 121).map((x) => x._id));
  assert.equal(after.hasNewer, true);
  const tail = await msgs(`/api/chat/channels/${GENERAL}/messages?limit=20&after=${all[120]._id}`);
  assert.deepEqual([tail.items.length, tail.hasNewer], [9, false]);
  const root = all.find((x) => x.replyCount === 3);
  const thread = await msgs(`/api/chat/messages/${root._id}/thread`);
  const viaReply = await msgs(`/api/chat/channels/${GENERAL}/messages?around=${thread.items[1]._id}`);
  assert.deepEqual([viaReply.anchorId, viaReply.anchorThreadRoot], [thread.items[1]._id, root._id]);
  assert.ok(viaReply.items.some((x) => x._id === root._id));
  assert.equal((await api("GET", `/api/chat/channels/${GENERAL}/messages?around=5f2000000000000000009999`)).json.code, "MESSAGE_NOT_FOUND");
});

test("seed has an edited, a deleted message, reactions, a pin, mentions and a thread root with 3 replies", async () => {
  await reset();
  const items = [];
  for (let i = 0; i < 2; i++) {
    const page = await msgs(`/api/chat/channels/${GENERAL}/messages?limit=100${items.length ? `&before=${items[0]._id}` : ""}`);
    items.unshift(...page.items);
  }
  assert.equal(items.filter((x) => x.editedAt).length, 1);
  const deleted = items.find((x) => x.deletedAt);
  assert.deepEqual([deleted.text, deleted.reactions, deleted.attachments], ["", [], []]);
  assert.ok(items.some((x) => x.reactions.some((r) => r.emoji === "👍" && r.count === 2)));
  assert.equal(items.filter((x) => x.pinned).length, 1);
  assert.ok(items.some((x) => x.mentions.users.includes(ME)));
  assert.ok(items.some((x) => x.mentions.channel));
  const root = items.find((x) => x.replyCount === 3);
  assert.equal(root.replyUsers.length, 3);
  assert.ok(root.lastReplyAt);
});

test("send is idempotent by clientMessageId, validated, costs 0.02 and a zero balance is a 402 with the balance", async () => {
  await reset();
  const a = await api("POST", `/api/chat/channels/${OPS}/messages`, { text: "szia", clientMessageId: "cm-1" });
  const b = await api("POST", `/api/chat/channels/${OPS}/messages`, { text: "szia", clientMessageId: "cm-1" });
  assert.deepEqual([a.status, b.status], [201, 201]);
  assert.equal(a.json._id, b.json._id);
  assert.equal(a.json.clientMessageId, "cm-1");
  assert.equal(a.json.sender._id, ME);
  const page = (await msgs(`/api/chat/channels/${OPS}/messages?limit=5`)).items;
  assert.equal(page.filter((x) => x.clientMessageId === "cm-1").length, 1);
  assert.equal(page.at(-1)._id, a.json._id, "newest is last");
  assert.equal((await api("GET", "/api/chat/bootstrap")).json.credits.balance, 12.48);
  assert.equal((await api("POST", `/api/chat/channels/${OPS}/messages`, { text: "  " })).json.code, "EMPTY_MESSAGE");
  const long = await api("POST", `/api/chat/channels/${OPS}/messages`, { text: "x".repeat(8001) });
  assert.deepEqual([long.status, long.json.code], [400, "MESSAGE_TOO_LONG"]);
  assert.equal((await api("POST", `/api/chat/channels/${RANDOM}/messages`, { text: "not a member" })).json.code, "NOT_A_MEMBER");
  await control("credits", { credits: 0 });
  const poor = await api("POST", `/api/chat/channels/${OPS}/messages`, { text: "nope", clientMessageId: "cm-2" });
  assert.deepEqual([poor.status, poor.json.code, poor.json.balance], [402, "INSUFFICIENT_CREDITS", 0]);
  const again = await api("POST", `/api/chat/channels/${OPS}/messages`, { text: "szia", clientMessageId: "cm-1" });
  assert.equal(again.status, 201, "an already stored message is returned even without credits");
});

test("mentions are taken from the body and parsed from the text", async () => {
  await reset();
  const a = (await api("POST", `/api/chat/channels/${GENERAL}/messages`, { text: "hi", mentions: { users: [ANNA], channel: false } })).json;
  assert.deepEqual(a.mentions, { users: [ANNA], channel: false });
  const b = (await api("POST", `/api/chat/channels/${GENERAL}/messages`, { text: `hey <@${PETER}> and @[Bela](${BELA}) @channel` })).json;
  assert.deepEqual(b.mentions, { users: [PETER, BELA], channel: true });
});

test("a thread reply sets threadRoot, updates the root and does not touch the channel unread", async () => {
  await reset();
  const root = (await api("POST", `/api/chat/channels/${OPS}/messages`, { text: "root" })).json;
  await control("say", { channelId: "ops", text: "bump", from: "u_3" });
  const before = (await api("GET", "/api/chat/bootstrap")).json.channels.find((c) => c._id === OPS).me.unreadCount;
  const reply = await api("POST", `/api/chat/channels/${OPS}/messages`, { text: "reply", threadRootId: root._id, clientMessageId: "r-1" });
  assert.equal(reply.status, 201);
  assert.equal(reply.json.threadRoot, root._id);
  await control("say", { channelId: OPS, text: "reply from Béla", from: "u_4", threadRootId: root._id });
  assert.equal((await api("GET", "/api/chat/bootstrap")).json.channels.find((c) => c._id === OPS).me.unreadCount, before, "replies do not bump the channel");
  const top = (await msgs(`/api/chat/channels/${OPS}/messages?limit=100`)).items;
  assert.ok(top.every((x) => x.threadRoot === null));
  const updatedRoot = top.find((x) => x._id === root._id);
  assert.equal(updatedRoot.replyCount, 2);
  assert.ok(updatedRoot.lastReplyAt);
  assert.deepEqual(updatedRoot.replyUsers.map((u) => u._id), [ME, BELA]);
  const thread = await msgs(`/api/chat/messages/${root._id}/thread`);
  assert.deepEqual(thread.items.map((x) => x.text), ["reply", "reply from Béla"]);
  assert.equal(thread.root._id, root._id);
  const byParam = await msgs(`/api/chat/channels/${OPS}/messages?threadRoot=${root._id}`);
  assert.equal(byParam.items.length, 2);
  assert.equal((await api("POST", `/api/chat/channels/${OPS}/messages`, { text: "x", threadRootId: "5f2000000000000000009999" })).json.code, "THREAD_ROOT_NOT_FOUND");
});

test("the thread inbox lists my threads with unreadCount and clears it when the thread is opened", async () => {
  await reset();
  const unread = (await api("GET", "/api/chat/threads?restaurantId=r&unread=true")).json.items;
  assert.equal(unread.length, 1, "the #ops thread has an unread reply");
  assert.deepEqual([unread[0].channel.name, unread[0].channel.type, unread[0].unreadCount, unread[0].replyCount], ["ops", "private", 1, 1]);
  assert.equal((await api("GET", "/api/chat/threads")).json.items.length, 2);
  await api("GET", `/api/chat/messages/${unread[0].root._id}/thread`);
  assert.equal((await api("GET", "/api/chat/threads?unread=true")).json.items.length, 0);
  await control("say", { channelId: GENERAL, text: "late reply", from: "u_2", threadRootId: (await api("GET", "/api/chat/threads")).json.items.find((t) => t.channel.name === "general").root._id });
  assert.equal((await api("GET", "/api/chat/threads?unread=true")).json.items.length, 1);
});

test("read marker clears the counters and answers the new counts", async () => {
  await reset();
  const r = await api("POST", `/api/chat/channels/${GENERAL}/read`, {});
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.channelId, r.json.unreadCount, r.json.mentionCount], [GENERAL, 0, 0]);
  assert.ok(r.json.lastReadMessageId);
  const boot = (await api("GET", "/api/chat/bootstrap")).json;
  assert.equal(boot.channels[0].me.unreadCount, 0);
  assert.equal(boot.channels[0].me.lastReadMessageId, r.json.lastReadMessageId);
  const old = (await msgs(`/api/chat/channels/${GENERAL}/messages?limit=10`)).items;
  const partial = await api("POST", `/api/chat/channels/${GENERAL}/read`, { messageId: old[0]._id });
  assert.equal(partial.json.lastReadMessageId, old[0]._id);
  assert.ok(partial.json.unreadCount > 0, "reading back to an old message leaves later ones unread");
});

test("directory lists staff, search filters, direct reuses a DM and creates groups", async () => {
  await reset();
  assert.equal((await api("GET", "/api/chat/directory")).json.items.length, 5);
  assert.deepEqual((await api("GET", "/api/chat/directory?search=dóra")).json.items.map((u) => u._id), [DORA]);
  const dm = await api("POST", "/api/chat/direct", { userIds: [ANNA] });
  assert.deepEqual([dm.status, dm.json._id, dm.json.type], [200, DM, "direct"]);
  const peter = (await api("POST", "/api/chat/direct", { userIds: [PETER] })).json;
  assert.equal(peter.type, "direct");
  assert.equal((await api("POST", "/api/chat/direct", { userIds: [PETER] })).json._id, peter._id);
  const group = (await api("POST", "/api/chat/direct", { userIds: [BELA, DORA] })).json;
  assert.deepEqual([group.type, group.name, group.memberCount], ["group", "", 3]);
  assert.equal((await api("POST", "/api/chat/direct", { userIds: [DORA, BELA] })).json._id, group._id);
  assert.equal((await api("POST", "/api/chat/direct", { userIds: [ANNA, PETER] })).json._id, GROUP);
  assert.equal((await api("POST", "/api/chat/direct", { userIds: [] })).json.code, "USERS_REQUIRED");
  assert.equal((await api("POST", "/api/chat/direct", { userIds: ["5f0000000000000000000099"] })).json.code, "USERS_NOT_IN_STORE");
});

test("channel list, browse, create (201 / 403 / 409), join and leave", async () => {
  await reset();
  assert.deepEqual((await api("GET", "/api/chat/channels")).json.items.map((c) => c.name), ["general", "ops", "", ""]);
  assert.deepEqual((await api("GET", "/api/chat/channels?type=private")).json.items.map((c) => c.name), ["ops"]);
  assert.deepEqual((await api("GET", "/api/chat/channels?browse=true")).json.items.map((c) => c.name), ["random"]);
  assert.deepEqual((await api("GET", "/api/chat/channels?browse=true&search=zzz")).json.items, []);
  const created = await api("POST", "/api/chat/channels", { type: "private", name: "launch", description: "d", memberIds: [ANNA] });
  assert.equal(created.status, 201);
  assert.deepEqual([created.json.name, created.json.memberCount, created.json.me.role, created.json.description], ["launch", 2, "owner", "d"]);
  const dup = await api("POST", "/api/chat/channels", { type: "public", name: "General" });
  assert.deepEqual([dup.status, dup.json.code, dup.json.channelId], [409, "CHANNEL_NAME_TAKEN", GENERAL]);
  assert.equal((await api("POST", "/api/chat/channels", { type: "public", name: " " })).json.code, "NAME_REQUIRED");
  await control("create-forbidden", { on: true });
  assert.equal((await api("GET", "/api/chat/bootstrap")).json.permissions.createChannel, false);
  const denied = await api("POST", "/api/chat/channels", { type: "public", name: "nope" });
  assert.deepEqual([denied.status, denied.json.code], [403, "CREATE_FORBIDDEN"]);
  await control("create-forbidden", { on: false });
  const joined = await api("POST", `/api/chat/channels/${RANDOM}/join`, {});
  assert.deepEqual([joined.status, joined.json.me.isMember], [200, true]);
  assert.equal(joined.json.memberCount, 3);
  assert.equal((await api("GET", "/api/chat/channels?browse=true")).json.items.length, 0);
  assert.equal((await api("POST", `/api/chat/channels/${OPS}/join`, {})).json.code, "JOIN_FORBIDDEN");
  assert.deepEqual((await api("POST", `/api/chat/channels/${RANDOM}/leave`, {})).json, { ok: true });
  assert.equal((await api("GET", "/api/chat/channels?browse=true")).json.items.length, 1);
  await api("POST", `/api/chat/channels/${DM}/leave`, {});
  assert.equal((await api("GET", `/api/chat/channels/${DM}`)).json.me.hidden, true, "leaving a 1:1 DM only hides it");
});

test("members: list, add (public/private), refused for direct and group, remove, owner protected", async () => {
  await reset();
  const list = (await api("GET", `/api/chat/channels/${OPS}/members`)).json.items;
  assert.deepEqual(list.map((x) => x._id), [ME, PETER, BELA]);
  assert.deepEqual([list[0].role, list[1].role, typeof list[0].online], ["admin", "owner", "boolean"]);
  const added = await api("POST", `/api/chat/channels/${OPS}/members`, { userIds: [DORA, ANNA] });
  assert.equal(added.status, 200);
  assert.equal(added.json.items.length, 5);
  assert.equal((await api("GET", `/api/chat/channels/${OPS}`)).json.memberCount, 5);
  assert.equal((await api("POST", `/api/chat/channels/${OPS}/members`, { userIds: [] })).json.code, "USERS_REQUIRED");
  assert.equal((await api("POST", `/api/chat/channels/${OPS}/members`, { userIds: ["5f0000000000000000000099"] })).json.code, "USERS_NOT_ALLOWED");
  for (const id of [DM, GROUP]) {
    const r = await api("POST", `/api/chat/channels/${id}/members`, { userIds: [DORA] });
    assert.deepEqual([r.status, r.json.code], [400, "DIRECT_IMMUTABLE"]);
  }
  assert.equal((await api("DELETE", `/api/chat/channels/${GROUP}/members/${PETER}`)).json.code, "DIRECT_IMMUTABLE");
  assert.equal((await api("DELETE", `/api/chat/channels/${OPS}/members/${PETER}`)).json.code, "OWNER_PROTECTED");
  assert.deepEqual((await api("DELETE", `/api/chat/channels/${OPS}/members/${DORA}`)).json, { ok: true });
  assert.equal((await api("DELETE", `/api/chat/channels/${OPS}/members/${DORA}`)).json.code, "MEMBER_NOT_FOUND");
  assert.equal((await api("GET", `/api/chat/channels/${OPS}`)).json.memberCount, 4);
  assert.equal((await api("GET", `/api/chat/channels/${GROUP}/members`)).json.items.length, 3);
});

test("channel patch, preferences, edit, delete, reactions, pin and search", async () => {
  await reset();
  const patched = (await api("PATCH", `/api/chat/channels/${OPS}`, { name: "ops2", topic: "t", description: "d" })).json;
  assert.deepEqual([patched.name, patched.topic, patched.description], ["ops2", "t", "d"]);
  assert.equal((await api("PATCH", `/api/chat/channels/${GENERAL}`, { name: "x" })).json.code, "MANAGE_FORBIDDEN");
  assert.equal((await api("PATCH", `/api/chat/channels/${DM}`, { name: "x" })).json.code, "DIRECT_IMMUTABLE");
  assert.equal((await api("PATCH", `/api/chat/channels/${OPS}`, { name: "general" })).json.code, "CHANNEL_NAME_TAKEN");
  const prefs = (await api("PATCH", `/api/chat/channels/${GENERAL}/preferences`, { notifyLevel: "none", mutedUntil: "2030-01-01T00:00:00Z", starred: true, hidden: false })).json;
  assert.deepEqual([prefs.me.notifyLevel, prefs.me.mutedUntil, prefs.me.starred], ["none", "2030-01-01T00:00:00.000Z", true]);
  assert.equal((await api("PATCH", `/api/chat/channels/${GENERAL}/preferences`, { notifyLevel: "loud" })).json.code, "INVALID_NOTIFY_LEVEL");
  const mine = (await api("POST", `/api/chat/channels/${OPS}/messages`, { text: "first" })).json;
  const edited = await api("PATCH", `/api/chat/messages/${mine._id}`, { text: "second" });
  assert.deepEqual([edited.json.text, Boolean(edited.json.editedAt)], ["second", true]);
  const theirs = (await msgs(`/api/chat/channels/${OPS}/messages?limit=100`)).items.find((x) => x.sender._id === PETER || x.sender._id === BELA);
  assert.equal((await api("PATCH", `/api/chat/messages/${theirs._id}`, { text: "hijack" })).json.code, "NOT_SENDER");
  const r1 = (await api("POST", `/api/chat/messages/${mine._id}/reactions`, { emoji: "🔥" })).json;
  assert.deepEqual(r1.reactions, [{ emoji: "🔥", users: [ME], count: 1 }]);
  assert.deepEqual((await api("POST", `/api/chat/messages/${mine._id}/reactions`, { emoji: "🔥" })).json.reactions, [], "toggles off");
  assert.equal((await api("POST", `/api/chat/messages/${mine._id}/reactions`, { emoji: "" })).json.code, "INVALID_EMOJI");
  const pinned = (await api("POST", `/api/chat/messages/${mine._id}/pin`, { pinned: true })).json;
  assert.deepEqual([pinned.pinned, pinned.pinnedBy], [true, ME]);
  assert.equal((await api("GET", `/api/chat/channels/${OPS}`)).json.pinnedCount, 1);
  const found = (await api("GET", "/api/chat/search?q=second&type=messages")).json;
  assert.deepEqual([found.messages.length, found.messages[0].channelName, found.files, found.people], [1, "ops2", [], []]);
  const all = (await api("GET", "/api/chat/search?q=dóra")).json;
  assert.deepEqual(all.people.map((p) => p._id), [DORA]);
  assert.deepEqual((await api("GET", "/api/chat/search?q=rand")).json.channels.map((c) => c.name), ["random"]);
  assert.deepEqual((await api("GET", "/api/chat/search?q=")).json, { messages: [], files: [], people: [], channels: [] });
  assert.deepEqual((await api("DELETE", `/api/chat/messages/${mine._id}`)).json, { ok: true });
  const gone = (await msgs(`/api/chat/channels/${OPS}/messages?limit=100`)).items.find((x) => x._id === mine._id);
  assert.deepEqual([gone.text, gone.reactions, Boolean(gone.deletedAt)], ["", [], true]);
  assert.equal((await api("PATCH", `/api/chat/messages/${mine._id}`, { text: "again" })).json.code, "MESSAGE_DELETED");
  assert.equal((await api("GET", "/api/chat/search?q=second")).json.messages.length, 0);
});

test("TEAM_CHAT_NOT_ENABLED answers every chat route, multi-store needs restaurantId", async () => {
  await reset();
  await api("POST", "/__mock/chat-disabled", {});
  for (const [method, path] of [["GET", "/api/chat/bootstrap"], ["GET", `/api/chat/channels/${GENERAL}/messages`], ["POST", "/api/chat/direct"], ["GET", "/api/chat/threads"]]) {
    const r = await api(method, path, method === "POST" ? {} : undefined);
    assert.deepEqual([r.status, r.json.code], [403, "TEAM_CHAT_NOT_ENABLED"], path);
  }
  assert.equal((await api("GET", "/api/user/me")).status, 200, "non-chat routes are unaffected");
  await api("POST", "/__mock/chat-disabled", { on: false });
  assert.equal((await api("GET", "/api/chat/bootstrap")).status, 200);
  await control("multi-store", { on: true });
  const missing = await api("GET", "/api/chat/bootstrap");
  assert.deepEqual([missing.status, missing.json.code], [400, "RESTAURANT_REQUIRED"]);
  assert.equal((await api("GET", "/api/chat/bootstrap?restaurantId=5f9000000000000000000001")).status, 200);
  assert.equal((await api("POST", "/api/chat/direct", { userIds: [ANNA] })).json.code, "RESTAURANT_REQUIRED");
  assert.equal((await api("POST", "/api/chat/direct", { restaurantId: "5f9000000000000000000001", userIds: [ANNA] })).status, 200);
  assert.equal((await api("GET", `/api/chat/channels/${GENERAL}/messages`)).status, 200, "channel routes derive the store from the channel");
  await reset();
  assert.equal((await api("GET", "/api/chat/bootstrap")).status, 200, "reset clears the controls");
});

sockTest("a socket needs the token in the auth frame and join:user; the sender gets the echo with clientMessageId", async () => {
  await reset();
  const bad = await connect({ token: "eyJ.wrong.token", join: false });
  assert.ok(bad.ack.startsWith("44"));
  assert.equal(JSON.parse(bad.ack.slice(2)).message, "unauthorized");
  bad.close();
  const c = await connect();
  assert.equal(c.open.pingInterval, 25000);
  await sleep(50);
  const sent = await api("POST", `/api/chat/channels/${OPS}/messages`, { text: "live", clientMessageId: "cm-live" });
  const [ev] = await c.waitEvent("chat:message", (e) => e.message.clientMessageId === "cm-live");
  assert.deepEqual([ev.channelId, ev.message._id, ev.message.threadRoot], [OPS, sent.json._id, null]);
  await sleep(50);
  assert.equal((await control("sockets")).connected, 1);
  const lonely = await connect({ join: false });
  await api("POST", `/api/chat/channels/${OPS}/messages`, { text: "second", clientMessageId: "cm-live-2" });
  await c.waitFor((f) => f.includes('"second"'));
  await sleep(100);
  assert.equal(lonely.events("chat:message").length, 0, "a socket that did not join the room hears nothing");
  c.close();
  lonely.close();
});

sockTest("the legacy u_1 room still hears events", async () => {
  await reset();
  const c = await connect({ userId: "u_1" });
  await sleep(50);
  await control("say", { channelId: "c_1", text: "legacy ids work", from: "u_2" });
  await c.waitEvent("chat:message", (e) => e.channelId === GENERAL);
  c.close();
});

sockTest("replies emit chat:message with threadRoot plus chat:message:updated for the root; edits, reactions and deletes are events", async () => {
  await reset();
  const c = await connect();
  await sleep(50);
  const root = (await api("POST", `/api/chat/channels/${OPS}/messages`, { text: "root" })).json;
  const said = await control("say", { channelId: "ops", text: "in thread", from: "u_4", threadRootId: root._id });
  const [reply] = await c.waitEvent("chat:message", (e) => e.message.threadRoot === root._id);
  assert.equal(reply.message._id, said.message._id);
  const [upd] = await c.waitEvent("chat:message:updated", (e) => e.message._id === root._id && e.message.replyCount === 1);
  assert.equal(upd.channelId, OPS);
  await api("PATCH", `/api/chat/messages/${root._id}`, { text: "root edited" });
  await c.waitEvent("chat:message:updated", (e) => e.message.text === "root edited" && e.message.editedAt);
  await api("POST", `/api/chat/messages/${root._id}/reactions`, { emoji: "👍" });
  await c.waitEvent("chat:message:updated", (e) => e.message.reactions.length === 1);
  await api("DELETE", `/api/chat/messages/${said.message._id}`);
  const [del] = await c.waitEvent("chat:message:deleted");
  assert.deepEqual(del, { channelId: OPS, messageId: said.message._id, threadRoot: root._id });
  c.close();
});

sockTest("channel events: created, renamed, invited (updated with my me), left (removed) and chat:read for the members", async () => {
  await reset();
  const c = await connect();
  await sleep(50);
  const created = (await api("POST", "/api/chat/channels", { type: "public", name: "launch" })).json;
  const [up] = await c.waitEvent("chat:channel:updated", (e) => e.channel._id === created._id);
  assert.equal(up.channel.me.role, "owner");
  await api("PATCH", `/api/chat/channels/${created._id}`, { name: "launch2" });
  await c.waitEvent("chat:channel:updated", (e) => e.channel.name === "launch2");
  await api("POST", `/api/chat/channels/${RANDOM}/join`, {});
  await c.waitEvent("chat:channel:updated", (e) => e.channel._id === RANDOM && e.channel.me.isMember);
  await api("POST", `/api/chat/channels/${RANDOM}/leave`, {});
  const [rm] = await c.waitEvent("chat:channel:removed");
  assert.deepEqual(rm, { channelId: RANDOM });
  await api("POST", `/api/chat/channels/${GENERAL}/read`, {});
  const [read] = await c.waitEvent("chat:read");
  assert.deepEqual([read.channelId, read.userId, Boolean(read.lastReadMessageId)], [GENERAL, ME, true]);
  c.close();
});

sockTest("say can replay a message, typing arrives and a typing hint from the client is recorded", async () => {
  await reset();
  const c = await connect();
  await sleep(50);
  const said = await control("say", { channelId: "ops", text: "hotfix", from: "u_3", mention: true, replay: true });
  await c.waitFor(() => c.events("chat:message").length >= 2);
  assert.deepEqual(c.events("chat:message").map((e) => e.message._id), [said.message._id, said.message._id], "the same id twice: the client must dedupe");
  assert.deepEqual((await api("GET", "/api/chat/bootstrap")).json.channels[1].me.mentionCount, 1);
  await control("typing", { channelId: OPS, userId: "u_3" });
  const [t] = await c.waitEvent("chat:typing");
  assert.deepEqual(t, { channelId: OPS, userId: PETER, name: "Nagy Péter" });
  c.ws.send(`42${JSON.stringify(["chat:typing", { channelId: OPS }])}`);
  await sleep(100);
  assert.deepEqual((await control("sockets")).received, [{ event: "chat:typing", channelId: OPS }]);
  c.close();
});

sockTest("say with notify makes the notification doc and notification:new, honouring the notify level", async () => {
  await reset();
  const c = await connect();
  await sleep(50);
  const before = (await api("GET", "/api/notifications/badge")).json.notifications;
  const said = await control("say", { channelId: "general", text: "ping", from: "u_2", mention: true, notify: true });
  const [n] = await c.waitEvent("notification:new");
  assert.deepEqual([n._id, n.type, n.read, n.relatedId, n.relatedModel], [said.notification._id, "chat", false, said.message._id, "ChatMessage"]);
  assert.deepEqual(n.metadata, { type: "chat", channelId: GENERAL, messageId: said.message._id, threadRoot: "", restaurantId: "5f9000000000000000000001", actorName: "Kovács Anna", preview: "ping", eventKey: "chat.message.mention" });
  assert.equal((await api("GET", "/api/notifications/badge")).json.notifications, before + 1);
  const direct = await control("say", { channelId: "d_1", text: "dm", from: "u_2", notify: true });
  assert.equal(direct.notification.metadata.eventKey, "chat.message.direct");
  const chan = await control("say", { channelId: "general", text: "plain", from: "u_2", notify: true });
  assert.equal(chan.notification.metadata.eventKey, "chat.message.channel");
  const reply = await control("say", { channelId: "general", text: "r", from: "u_2", notify: true, threadRootId: (await api("GET", "/api/chat/threads")).json.items.find((x) => x.channel.name === "general").root._id });
  assert.equal(reply.notification.metadata.eventKey, "chat.message.thread");
  assert.ok(reply.notification.metadata.threadRoot);
  const quiet = await control("say", { channelId: "ops", text: "just chatting", from: "u_3", notify: true });
  assert.equal(quiet.notification, null, "ops is notifyLevel mentions");
  c.close();
});

sockTest("drop closes sockets, reject refuses new ones, revoke kills the token everywhere", async () => {
  await reset();
  const c = await connect();
  await control("drop");
  await sleep(150);
  assert.equal(c.isClosed(), true);
  await control("reject", { mode: "unauthorized" });
  assert.ok((await connect({ join: false })).ack.startsWith("44"));
  await control("reject", { mode: "forbidden" });
  assert.equal(JSON.parse((await connect({ join: false })).ack.slice(2)).message, "forbidden");
  await control("reject", { mode: null });
  const d = await connect();
  await sleep(50);
  await api("POST", "/__mock/revoke");
  await sleep(150);
  assert.equal(d.isClosed(), true);
  assert.equal((await api("GET", "/api/user/me")).status, 401);
  assert.ok((await connect({ join: false })).ack.startsWith("44"), "the old token no longer connects");
  await reset();
  assert.equal((await api("GET", "/api/user/me")).status, 200, "reset restores the token");
});

sockTest("join:forbidden can be scripted", async () => {
  await reset();
  await control("forbid-join", { on: true });
  const c = await connect();
  await c.waitFor((f) => f.includes("join:forbidden"));
  c.close();
});

sockTest("meeting events change the REST list too and the lobby count is an event", async () => {
  await reset();
  const c = await connect();
  await sleep(50);
  assert.equal((await api("GET", "/api/chat/meetings?status=live")).json.meetings.length, 1);
  await control("script", { name: "meeting-lobby" });
  await c.waitFor((f) => f.includes("chat:meeting:lobby"));
  const started = c.events("chat:meeting")[0];
  assert.deepEqual([started.action, started.meeting.id], ["started", "m_live_2"]);
  assert.equal(c.events("chat:meeting:lobby")[0].waiting, 2);
  assert.equal((await api("GET", "/api/chat/meetings?status=live")).json.meetings.length, 2);
  await control("meeting", { action: "ended", id: "m_live_2" });
  await c.waitFor(() => c.events("chat:meeting").length >= 2);
  assert.equal((await api("GET", "/api/chat/meetings?status=live")).json.meetings.length, 1);
  c.close();
});

sockTest("the burst script emits a message, its replay and a typing hint", async () => {
  await reset();
  const c = await connect();
  await sleep(50);
  await control("script", { name: "burst" });
  await c.waitFor(() => c.events("chat:typing").length >= 1 && c.events("chat:message").length >= 2);
  assert.equal(c.events("chat:message")[0].message._id, c.events("chat:message")[1].message._id);
  c.close();
});
