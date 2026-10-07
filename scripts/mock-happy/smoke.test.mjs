// Node smoke against the mock Happy server: `node --test scripts/mock-happy/smoke.test.mjs`.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createMockHappy, listen, LIVEKIT_CANARY, MOCK_TOKEN } from "./server.mjs";

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
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
};
const reset = () => api("POST", "/__mock/reset");

test("it binds to loopback only", () => {
  assert.equal(server.address().address, "127.0.0.1");
});

test("a missing or wrong token is a 401 with a code", async () => {
  await reset();
  assert.deepEqual((await api("GET", "/api/user/me", undefined, null)).json.code, "DEVICE_LOGGED_OUT");
  assert.equal((await api("GET", "/api/user/me", undefined, "eyJ.x.y")).status, 401);
  const me = await api("GET", "/api/user/me");
  assert.equal(me.status, 200);
  assert.equal(me.json.restaurants[0].id, "r_1");
  assert.ok(me.headers.get("date"), "the Date header is there for the clock offset");
});

test("the timer follows start, pause, resume and stop, and stop on an idle timer is a 404", async () => {
  await reset();
  assert.deepEqual((await api("GET", "/api/projects/me/running-timer")).json, { success: true, data: { running: null, paused: null } });
  assert.equal((await api("POST", "/api/widgets/timer/stop", {})).json.code, "no_active_timer");
  const start = await api("POST", "/api/widgets/timer/start", { kind: "project", id: "p_pos", taskId: "t_receipts" });
  assert.equal(start.json.timer.state, "running");
  assert.equal(start.json.timer.taskTitle, "Receipts");
  assert.equal((await api("GET", "/api/projects/me/running-timer")).json.data.running.projectTitle, "Shop POS");
  assert.equal((await api("POST", "/api/widgets/timer/pause", {})).json.timer.state, "paused");
  assert.equal((await api("GET", "/api/projects/me/running-timer")).json.data.paused.projectTitle, "Shop POS");
  assert.equal((await api("POST", "/api/widgets/timer/resume", {})).json.timer.state, "running");
  assert.deepEqual((await api("POST", "/api/widgets/timer/stop", {})).json, { timer: null });
});

test("the summary lists trackables and the entries include a running one", async () => {
  await reset();
  const summary = await api("GET", "/api/widgets/summary?restaurantId=r_1");
  assert.equal(summary.json.trackables.length, 4);
  assert.equal(summary.json.timer, null);
  await api("POST", "/api/widgets/timer/start", { kind: "project", id: "p_admin" });
  const day = new Date().setHours(0, 0, 0, 0);
  const entries = await api("GET", `/api/projects/time-entries?from=${new Date(day).toISOString()}&to=${new Date(day + 86_400_000).toISOString()}&limit=500`);
  assert.equal(entries.json.data.length, 4);
  const running = entries.json.data.find((e) => e.isRunning);
  assert.equal(running.projectId.title, "Admin");
  assert.equal(running.end, null);
  assert.ok(entries.json.data.some((e) => e.abandonedAt));
});

test("meetings: one live, two scheduled, and join returns an https link with a canary token", async () => {
  await reset();
  assert.equal((await api("GET", "/api/chat/meetings?status=live")).json.meetings.length, 1);
  const scheduled = (await api("GET", "/api/chat/meetings?status=scheduled")).json.meetings;
  assert.equal(scheduled.length, 2);
  assert.ok(Date.parse(scheduled[0].startsAt) - Date.now() < 15 * 60_000, "the first one is imminent");
  const join = await api("POST", "/api/chat/meetings/m_live_1/join", {});
  assert.ok(join.json.joinUrl.startsWith("https://"));
  assert.ok(join.json.joinUrl.includes(LIVEKIT_CANARY));
});

test("failures can be injected per path and are counted in the log", async () => {
  await reset();
  await api("POST", "/__mock/fail", { status: 403, path: "/api/chat", count: 1 });
  assert.equal((await api("GET", "/api/chat/meetings?status=live")).json.code, "forbidden_scope");
  assert.equal((await api("GET", "/api/chat/meetings?status=live")).status, 200);
  await api("POST", "/__mock/fail", { status: 429 });
  assert.equal((await api("GET", "/api/user/me")).status, 429);
  const log = await api("GET", "/__mock/log");
  assert.equal(log.json.count, 3);
  assert.ok(log.json.requests.every((r) => r.auth));
});
