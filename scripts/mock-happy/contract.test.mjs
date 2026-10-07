// Contract tests: the mock's chat + notification responses and socket payloads must have exactly the key sets / value types of
// the fixtures in ./fixtures/*.json, which are hand copies of the REAL Happy backend serializers (chatSerializer.js,
// notification model). A fixture value of null means "nullable, any type"; an empty array means "elements not checked".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { DM, GENERAL, OPS, RANDOM, ANNA, startMock } from "./helpers.mjs";

const load = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const F = load("chat");
const N = load("notifications");

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
/** Collects every difference between `actual` and the fixture `shape` (recursive; arrays are checked against their first element). */
export function diff(actual, shape, path = "$", out = []) {
  if (shape === null) return out;
  if (typeOf(actual) === "null") return out; // a nullable field that happens to be null here
  if (typeOf(actual) !== typeOf(shape)) return out.push(`${path}: type ${typeOf(actual)} != ${typeOf(shape)}`), out;
  if (Array.isArray(shape)) {
    if (shape.length) actual.forEach((el, i) => diff(el, shape[0], `${path}[${i}]`, out));
    return out;
  }
  if (typeof shape === "object") {
    const a = Object.keys(actual).sort();
    const s = Object.keys(shape).sort();
    for (const k of s) if (!a.includes(k)) out.push(`${path}.${k}: missing`);
    for (const k of a) if (!s.includes(k)) out.push(`${path}.${k}: unexpected`);
    for (const k of s) if (k in actual) diff(actual[k], shape[k], `${path}.${k}`, out);
  }
  return out;
}
const match = (actual, shape, what) => assert.deepEqual(diff(actual, shape), [], what);
/** A fixture with some `null` placeholders filled from another fixture. */
const fill = (shape, parts) => ({ ...shape, ...parts });

let m;
before(async () => void (m = await startMock()));
after(() => m.close());
const get = async (path) => {
  const r = await m.api("GET", path);
  assert.equal(r.status, 200, `${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};
const sockTest = (name, fn) =>
  test(name, async (t) => {
    if (!m.hasSockets) return t.skip("socket.io is not installed");
    await fn(t);
  });

test("the fixtures themselves are real-shaped: 24-hex ids, ISO dates", () => {
  const ids = [F.channel._id, F.channel.restaurant, F.message._id, F.message.sender._id, F.member._id, N.doc._id, N.doc.recipient];
  for (const id of ids) assert.match(id, /^[0-9a-f]{24}$/);
  for (const d of [F.channel.createdAt, F.message.createdAt, N.doc.createdAt]) assert.ok(!Number.isNaN(Date.parse(d)));
});

test("bootstrap, channel and me match the real serializeChannel / serializeMe", async () => {
  await m.reset();
  const boot = await get("/api/chat/bootstrap?restaurantId=5f9000000000000000000001");
  match(boot, { ...F.bootstrap, channels: [F.channel] }, "bootstrap");
  assert.ok(boot.channels.length >= 4);
  for (const c of boot.channels) assert.match(c._id, /^[0-9a-f]{24}$/);
  match((await get("/api/chat/channels")).items[0], F.channel, "channels list item");
  match(await get("/api/chat/channels"), { items: [F.channel] }, "channels list");
  match(await get("/api/chat/channels?browse=true"), { items: [F.channel] }, "browse");
  match(await get(`/api/chat/channels/${RANDOM}`), F.channel, "non-member view of a public channel");
  match(boot.channels[0].me, F.me, "me");
});

test("messages page, around page, message, thread and thread inbox match the real shapes", async () => {
  await m.reset();
  const page = await get(`/api/chat/channels/${GENERAL}/messages`);
  match(page, { ...F.page, items: [F.message] }, "page");
  const root = (await get(`/api/chat/channels/${GENERAL}/messages?limit=100`)).items.find((x) => x.replyCount === 3);
  const around = await get(`/api/chat/channels/${GENERAL}/messages?around=${root._id}`);
  match(around, { ...F.pageAround, items: [F.message] }, "around page");
  const thread = await get(`/api/chat/messages/${root._id}/thread`);
  match(thread, { root: F.message, items: [F.message] }, "thread");
  assert.equal(thread.items.length, 3);
  const inbox = await get("/api/chat/threads");
  match(inbox, { items: [fill(F.threadItem, { root: F.message })] }, "threads");
  assert.ok(inbox.items.length >= 1);
  const sent = await m.api("POST", `/api/chat/channels/${OPS}/messages`, { text: "contract", clientMessageId: "c-1" });
  assert.equal(sent.status, 201);
  match(sent.json, F.message, "POST message");
  assert.equal(sent.json.clientMessageId, "c-1");
  const reply = await m.api("POST", `/api/chat/channels/${OPS}/messages`, { text: "r", threadRootId: sent.json._id });
  match(reply.json, F.message, "POST reply");
  match((await m.api("PATCH", `/api/chat/messages/${sent.json._id}`, { text: "e" })).json, F.message, "PATCH message");
  match((await m.api("POST", `/api/chat/messages/${sent.json._id}/reactions`, { emoji: "👍" })).json, F.message, "reaction");
  match((await m.api("POST", `/api/chat/messages/${sent.json._id}/pin`, { pinned: true })).json, F.message, "pin");
  match((await m.api("DELETE", `/api/chat/messages/${sent.json._id}`)).json, F.ok, "DELETE message");
});

test("read marker, directory, members, direct, create, join, leave, preferences, search match the real shapes", async () => {
  await m.reset();
  match((await m.api("POST", `/api/chat/channels/${GENERAL}/read`, {})).json, F.readResult, "read");
  match(await get("/api/chat/directory"), { items: [F.directoryItem] }, "directory");
  match(await get(`/api/chat/channels/${OPS}/members`), { items: [F.member] }, "members");
  match((await m.api("POST", `/api/chat/channels/${OPS}/members`, { userIds: [ANNA] })).json, { items: [F.member] }, "add members");
  match((await m.api("DELETE", `/api/chat/channels/${OPS}/members/${ANNA}`)).json, F.ok, "remove member");
  match((await m.api("POST", "/api/chat/direct", { userIds: [ANNA] })).json, F.channel, "direct");
  const created = await m.api("POST", "/api/chat/channels", { type: "public", name: "contract" });
  assert.equal(created.status, 201);
  match(created.json, F.channel, "create");
  match((await m.api("POST", `/api/chat/channels/${RANDOM}/join`, {})).json, F.channel, "join");
  match((await m.api("PATCH", `/api/chat/channels/${RANDOM}/preferences`, { starred: true })).json, F.channel, "preferences");
  match((await m.api("PATCH", `/api/chat/channels/${RANDOM}`, { topic: "t" })).json, F.channel, "patch");
  match((await m.api("POST", `/api/chat/channels/${RANDOM}/leave`, {})).json, F.ok, "leave");
  const found = await get("/api/chat/search?q=a");
  match(found, { ...F.search, messages: [fill(F.message, F.searchMessage)], people: [F.directoryItem], channels: [F.channel] }, "search");
  assert.ok(found.messages.length && found.people.length && found.channels.length);
});

test("errors are {code,message}; 402 adds the balance; 409 name taken adds the channelId", async () => {
  await m.reset();
  const nf = await m.api("GET", "/api/chat/channels/5f1000000000000000000999");
  match(nf.json, F.error, "404");
  match((await m.api("POST", "/api/chat/channels", { type: "public", name: "general" })).json, { ...F.error, channelId: "x" }, "409");
  await m.control("credits", { credits: 0 });
  const poor = await m.api("POST", `/api/chat/channels/${OPS}/messages`, { text: "x" });
  assert.equal(poor.status, 402);
  match(poor.json, F.insufficientCredits, "402");
  const forbidden = await m.api("POST", `/api/chat/channels/${DM}/members`, { userIds: [ANNA] });
  match(forbidden.json, F.error, "400 direct");
});

test("notifications: list, metadata list, skipCount list, badge, verbs, read-all, delete match the real shapes", async () => {
  await m.reset();
  match(await get("/api/notifications"), { ...N.list, docs: [N.doc] }, "list");
  const withMeta = await get("/api/notifications?includeMetadata=true");
  match({ ...withMeta, docs: withMeta.docs.filter((d) => d.type === "chat") }, { ...N.list, docs: [N.docWithMetadata] }, "list with metadata");
  match(await get("/api/notifications?skipCount=true"), { ...N.listSkipCount, docs: [N.doc] }, "skipCount");
  match(await get("/api/notifications/badge"), N.badge, "badge");
  const id = withMeta.docs[0]._id;
  match((await m.api("PATCH", `/api/notifications/${id}/read`, {})).json, N.docWithMetadata, "read");
  match((await m.api("PATCH", `/api/notifications/${id}/unread`, {})).json, N.docWithMetadata, "unread");
  match((await m.api("PATCH", "/api/notifications/read-all", {})).json, N.readAll, "read-all");
  match((await m.api("DELETE", `/api/notifications/${id}`)).json, N.deleted, "delete");
});

test("TEAM_CHAT_NOT_ENABLED has the error shape", async () => {
  await m.reset();
  await m.api("POST", "/__mock/chat-disabled", {});
  const r = await m.api("GET", "/api/chat/bootstrap");
  assert.equal(r.status, 403);
  match(r.json, F.error, "403");
  assert.equal(r.json.code, "TEAM_CHAT_NOT_ENABLED");
  await m.reset();
});

sockTest("socket payloads: chat:message, :updated, :deleted, :channel:updated, :channel:removed, chat:read, chat:typing, notification:new", async () => {
  await m.reset();
  const c = await m.connect();
  await new Promise((r) => setTimeout(r, 50));
  const root = (await m.api("POST", `/api/chat/channels/${OPS}/messages`, { text: "root" })).json;
  await m.control("say", { channelId: "ops", text: "reply", from: "u_3", threadRootId: root._id, notify: true, mention: true });
  const [msgEv] = await c.waitEvent("chat:message", (e) => e.message.threadRoot === root._id);
  match(msgEv, { channelId: "x", message: F.message }, "chat:message");
  const [upd] = await c.waitEvent("chat:message:updated");
  match(upd, { channelId: "x", message: F.message }, "chat:message:updated");
  await m.api("DELETE", `/api/chat/messages/${msgEv.message._id}`);
  match((await c.waitEvent("chat:message:deleted"))[0], { channelId: "x", messageId: "x", threadRoot: "x" }, "chat:message:deleted");
  await m.api("POST", "/api/chat/channels", { type: "public", name: "sock" });
  match((await c.waitEvent("chat:channel:updated"))[0], { channel: F.channel }, "chat:channel:updated");
  await m.api("POST", `/api/chat/channels/${RANDOM}/join`, {});
  await m.api("POST", `/api/chat/channels/${RANDOM}/leave`, {});
  match((await c.waitEvent("chat:channel:removed"))[0], { channelId: "x" }, "chat:channel:removed");
  await m.api("POST", `/api/chat/channels/${GENERAL}/read`, {});
  match((await c.waitEvent("chat:read"))[0], { channelId: "x", userId: "x", lastReadMessageId: "x" }, "chat:read");
  await m.control("typing", { channelId: "general", userId: "u_2" });
  match((await c.waitEvent("chat:typing"))[0], { channelId: "x", userId: "x", name: "x" }, "chat:typing");
  match((await c.waitEvent("notification:new"))[0], N.socketEvent, "notification:new");
  c.close();
});
