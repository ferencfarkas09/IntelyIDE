// Node tests of the Time Tracer routes of the mock Happy server: `node --test scripts/mock-happy/timer.test.mjs`.
// The shapes asserted here are the real backend's (see timer.mjs), so the Rust parsers and the UI can rely on them.
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

const api = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const reset = () => api("POST", "/__mock/reset");
const day = () => new Date().setHours(0, 0, 0, 0);

test("the project controllers are enveloped and the widget ones are raw", async () => {
  await reset();
  const rt = await api("GET", "/api/projects/me/running-timer");
  assert.equal(rt.json.success, true);
  assert.deepEqual(rt.json.data, { running: null, paused: null });
  const summary = await api("GET", "/api/widgets/summary");
  assert.equal("success" in summary.json, false);
  assert.ok(Array.isArray(summary.json.trackables) && "timer" in summary.json);
  const row = summary.json.trackables[1];
  assert.deepEqual(Object.keys(row).sort(), ["id", "kind", "subtitle", "taskId", "taskTitle", "title"]);
});

test("a work-order timer shows in the summary but not in the project endpoints", async () => {
  await reset();
  const start = await api("POST", "/api/widgets/timer/start", { kind: "workOrder", id: "w_till" });
  assert.equal(start.json.timer.title, "#WO-77");
  assert.equal(start.json.timer.canBreak, true);
  assert.equal((await api("GET", "/api/widgets/summary")).json.timer.kind, "workOrder");
  assert.deepEqual((await api("GET", "/api/projects/me/running-timer")).json.data, { running: null, paused: null });
});

test("pause closes the entry and resume opens a new one", async () => {
  await reset();
  await api("POST", "/api/widgets/timer/start", { kind: "project", id: "p_pos", taskId: "t_refunds" });
  const firstId = (await api("GET", `/api/projects/time-entries?from=${new Date(day()).toISOString()}`)).json.data.find((r) => r.isRunning)._id;
  const paused = await api("POST", "/api/widgets/timer/pause", {});
  assert.equal(paused.json.timer.startedAt, null);
  assert.equal(typeof paused.json.timer.pausedElapsedSeconds, "number");
  const rows = (await api("GET", `/api/projects/time-entries?from=${new Date(day()).toISOString()}`)).json.data;
  assert.equal(rows.filter((r) => r.isRunning).length, 0);
  assert.equal(rows.find((r) => r._id === firstId).pausedAt !== null, true);
  await api("POST", "/api/widgets/timer/resume", {});
  const after = (await api("GET", `/api/projects/time-entries?from=${new Date(day()).toISOString()}`)).json.data;
  assert.equal(after.filter((r) => r.isRunning).length, 1);
  assert.notEqual(after.find((r) => r.isRunning)._id, firstId);
});

test("verbs answer the real error codes", async () => {
  await reset();
  assert.equal((await api("POST", "/api/widgets/timer/start", { kind: "nope", id: "p_pos" })).json.code, "invalid_kind");
  assert.equal((await api("POST", "/api/widgets/timer/start", { kind: "project", id: "bad id" })).json.code, "invalid_id");
  assert.equal((await api("POST", "/api/widgets/timer/start", { kind: "project", id: "p_nope" })).json.code, "project_not_found");
  assert.equal((await api("POST", "/api/widgets/timer/pause", {})).status, 404);
  assert.equal((await api("POST", "/api/widgets/timer/resume", {})).json.code, "no_paused_timer");
});

test("time entries filter by range, sort newest first and cap at 500 with no offset", async () => {
  await reset();
  await api("POST", "/__mock/timer/bulk", { count: 700 });
  const from = new Date(day()).toISOString();
  const to = new Date(day() + 86_400_000).toISOString();
  const page1 = (await api("GET", `/api/projects/time-entries?from=${from}&to=${to}&limit=500`)).json.data;
  assert.equal(page1.length, 500);
  assert.ok(page1.every((r, i) => i === 0 || Date.parse(page1[i - 1].start) >= Date.parse(r.start)));
  const page2 = (await api("GET", `/api/projects/time-entries?from=${from}&to=${page1.at(-1).start}&limit=500`)).json.data;
  assert.ok(page2.length >= 200 && page2.length < 500, "paging back with to=<oldest start> reaches the rest");
  assert.equal(page2[0]._id, page1.at(-1)._id, "the boundary row repeats, so the client dedupes by id");
  const yesterday = (await api("GET", `/api/projects/time-entries?from=${new Date(day() - 86_400_000).toISOString()}&to=${from}`)).json.data;
  assert.ok(yesterday.every((r) => Date.parse(r.start) < day() + 1));
});

test("the summary adds up settled seconds per range", async () => {
  await reset();
  const q = `dayStart=${new Date(day()).toISOString()}&weekStart=${new Date(day() - 6 * 86_400_000).toISOString()}&monthStart=${new Date(day() - 30 * 86_400_000).toISOString()}`;
  const { data } = (await api("GET", `/api/projects/time-entries/summary?${q}`)).json;
  assert.equal(data.day.totalSeconds, 5400 + 2700, "the abandoned row does not count");
  assert.ok(data.week.totalSeconds > data.day.totalSeconds && data.month.totalSeconds > data.week.totalSeconds);
});

test("search finds projects and tasks, and a task can be created", async () => {
  await reset();
  const projects = (await api("GET", "/api/projects?search=happy&limit=6")).json.data;
  assert.ok(projects.projects.length >= 3 && projects.pagination.total >= 3);
  assert.equal((await api("GET", "/api/projects?search=zzz")).json.data.projects.length, 0);
  const tasks = (await api("GET", "/api/tasks/autocomplete?q=rece&limit=15")).json.data.tasks;
  assert.deepEqual(tasks.map((t) => [t.title, t.projectId]), [["Receipts", "p_pos"]]);
  assert.equal((await api("GET", "/api/tasks?projectId=p_admin&limit=20")).json.data.tasks.length, 2);
  assert.equal((await api("GET", "/api/projects/p_pos")).json.data.title, "Shop POS");
  assert.equal((await api("GET", "/api/projects/p_nope")).status, 404);

  assert.equal((await api("POST", "/api/tasks", { projectId: "p_pos" })).status, 400);
  assert.equal((await api("POST", "/api/tasks", { projectId: "p_nope", title: "x" })).status, 404);
  const created = await api("POST", "/api/tasks", { projectId: "p_pos", title: "  Gift cards  " });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.title, "Gift cards");
  assert.equal((await api("GET", "/api/tasks/autocomplete?q=gift")).json.data.tasks[0]._id, created.json.data._id);
  const start = await api("POST", "/api/widgets/timer/start", { kind: "project", id: "p_pos", taskId: created.json.data._id });
  assert.equal(start.json.timer.taskTitle, "Gift cards");
});

test("the control endpoint changes the timer 'elsewhere'", async () => {
  await reset();
  await api("POST", "/__mock/timer", { action: "start", kind: "project", id: "p_admin", taskId: "t_l10n" });
  assert.equal((await api("GET", "/api/projects/me/running-timer")).json.data.running.projectId, "p_admin");
  await api("POST", "/__mock/timer", { action: "pause" });
  assert.ok((await api("GET", "/api/projects/me/running-timer")).json.data.paused);
  await api("POST", "/__mock/timer", { action: "stop" });
  assert.deepEqual((await api("GET", "/api/projects/me/running-timer")).json.data, { running: null, paused: null });
});
