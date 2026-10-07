// Node smoke for the Notifications and Tasks fixtures: `node --test scripts/mock-happy/nt.test.mjs`.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createMockHappy, listen, MOCK_TOKEN } from "./server.mjs";

let server;
let base;

before(async () => {
  server = createMockHappy();
  base = `http://127.0.0.1:${await listen(server)}`;
});
after(() => server.close());

const api = async (method, path, body, token = MOCK_TOKEN) => {
  const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const reset = () => api("POST", "/__mock/reset");

const ME_N = "5f0000000000000000000001";

test("the badge reports notifications and mail separately and the list is newest first without metadata", async () => {
  await reset();
  assert.deepEqual((await api("GET", "/api/notifications/badge")).json, { notifications: 2, mail: 0, total: 2 });
  await api("POST", "/__mock/notify-mail", { count: 3 });
  assert.deepEqual((await api("GET", "/api/notifications/badge")).json, { notifications: 2, mail: 3, total: 5 });
  const list = (await api("GET", "/api/notifications?limit=30")).json;
  assert.deepEqual([list.docs.length, list.total, list.limit, list.page, list.pages], [4, 4, 30, 1, 1]);
  assert.ok(list.docs.every((n) => n.recipient === ME_N && !("metadata" in n) && /^[0-9a-f]{24}$/.test(n._id)));
  assert.ok(list.docs.every((n, i, a) => i === 0 || Date.parse(a[i - 1].createdAt) >= Date.parse(n.createdAt)));
  assert.equal(list.docs.filter((n) => !n.read).length, 2);
});

test("includeMetadata adds the chat metadata; read, page, limit and skipCount filter the list", async () => {
  await reset();
  const meta = (await api("GET", "/api/notifications?includeMetadata=true")).json.docs;
  const chat = meta.find((n) => n.type === "chat" && !n.read);
  assert.deepEqual([chat.relatedModel, chat.metadata.eventKey, chat.metadata.type], ["ChatMessage", "chat.message.mention", "chat"]);
  assert.ok(chat.metadata.channelId && chat.metadata.messageId && chat.metadata.restaurantId && chat.metadata.actorName && chat.metadata.preview);
  assert.equal((await api("GET", "/api/notifications?read=false")).json.docs.length, 2);
  assert.equal((await api("GET", "/api/notifications?read=true")).json.total, 2);
  const p2 = (await api("GET", "/api/notifications?limit=3&page=2")).json;
  assert.deepEqual([p2.docs.length, p2.pages, p2.total], [1, 2, 4]);
  const skip = (await api("GET", "/api/notifications?limit=3&skipCount=true")).json;
  assert.deepEqual([skip.docs.length, skip.hasMore, "total" in skip, "pages" in skip], [3, true, false, false]);
});

test("PATCH read, unread and read-all move the badge, DELETE removes, an unknown id is a 404", async () => {
  await reset();
  const unread = (await api("GET", "/api/notifications?read=false")).json.docs;
  const one = (await api("PATCH", `/api/notifications/${unread[0]._id}/read`, {}));
  assert.deepEqual([one.status, one.json.read, one.json._id], [200, true, unread[0]._id]);
  assert.equal((await api("GET", "/api/notifications/badge")).json.notifications, 1);
  assert.equal((await api("PATCH", `/api/notifications/${unread[0]._id}/unread`, {})).json.read, false);
  assert.equal((await api("GET", "/api/notifications/badge")).json.notifications, 2);
  assert.equal((await api("PATCH", "/api/notifications/5f3000000000000000009999/read", {})).status, 404);
  const added = await api("POST", "/__mock/notify", { title: "Standup moved", kind: "meeting" });
  assert.equal(added.json.unread, 3);
  assert.deepEqual((await api("PATCH", "/api/notifications/read-all", {})).json, { matchedCount: 3, modifiedCount: 3 });
  assert.deepEqual((await api("PATCH", "/api/notifications/read-all", {})).json, { matchedCount: 0, modifiedCount: 0 });
  assert.equal((await api("GET", "/api/notifications/badge")).json.total, 0);
  assert.deepEqual((await api("DELETE", `/api/notifications/${added.json.id}`)).json, { message: "Notification deleted successfully" });
  assert.equal((await api("GET", "/api/notifications")).json.total, 4);
  assert.equal((await api("DELETE", `/api/notifications/${added.json.id}`)).status, 404);
});

test("my tasks: the assignee filter, the statuses, and an unknown assignee gets an empty list", async () => {
  await reset();
  const mine = (await api("GET", "/api/tasks?assignee=u_1")).json.tasks;
  assert.equal(mine.length, 7);
  assert.ok(mine.every((t) => t.title && t.project?.name && t.status));
  assert.ok(!JSON.stringify(mine).includes("Somebody else"));
  assert.equal((await api("GET", "/api/tasks?assignee=me")).json.tasks.length, 7);
  assert.equal((await api("GET", "/api/tasks?assignee=u_9")).json.tasks.length, 1);
  assert.equal((await api("GET", "/api/tasks?assignee=nobody")).json.tasks.length, 0);
  const statuses = (await api("GET", "/api/tasks/statuses")).json.statuses;
  assert.deepEqual(statuses.map((s) => s.id), ["s_todo", "s_doing", "s_review", "s_done"]);
});

test("a task started on the timer is titled from the task fixtures", async () => {
  await reset();
  const start = await api("POST", "/api/widgets/timer/start", { kind: "project", id: "p_backend", taskId: "t_api" });
  assert.equal(start.json.timer.taskTitle, "Orders endpoint: add pagination");
  await api("POST", "/api/widgets/timer/stop", {});
});

test("without the token the new routes are a 401, like every other route", async () => {
  assert.equal((await api("GET", "/api/notifications/badge", undefined, null)).status, 401);
  assert.equal((await api("GET", "/api/tasks", undefined, null)).status, 401);
});
