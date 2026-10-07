// Time tracker fixtures for the mock Happy server. The shapes are the REAL backend's (shop-backend: widgets.controller /
// widgets.service WidgetTimerState and trackables, project.controller running-timer / time-entries / time-entries/summary /
// projects list, task.controller autocomplete / list / create). Project and task controllers answer `{ success, data }`,
// the widget controllers answer raw json, errors are `{ message, code? }`.
//
// Pause closes the running entry (a stop that remembers) and resume opens a NEW entry, so a running clock is always
// `now - startedAt`. Test controls (no auth):
//   POST /__mock/timer       {action: "start"|"stop"|"pause"|"resume", kind?, id?, taskId?}   change the timer "elsewhere"
//   POST /__mock/timer/bulk  {count}                                                          add N closed 1-minute rows today

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const USER_ID = "u_1";

const PROJECTS = [
  { _id: "p_pos", code: "HP", title: "Shop POS", customerName: "Acme Kft." },
  { _id: "p_admin", code: "ADM", title: "Admin", customerName: "Demo Gastro" },
  { _id: "p_backend", code: "BE", title: "Happy Backend", customerName: null },
  { _id: "p_app", code: "APP", title: "Happy Services App", customerName: null },
];

const seedTasks = () => [
  { _id: "t_receipts", code: "HP-142", title: "Receipts", projectId: "p_pos" },
  { _id: "t_refunds", code: "HP-143", title: "Refunds", projectId: "p_pos" },
  { _id: "t_l10n", code: "ADM-77", title: "Localization", projectId: "p_admin" },
  { _id: "t_review", code: "ADM-80", title: "Review the rounding fix", projectId: "p_admin" },
  { _id: "t_api", code: "BE-31", title: "Orders endpoint: add pagination", projectId: "p_backend" },
  { _id: "t_android", code: "APP-12", title: "Android: Google sign-in crash on cold start", projectId: "p_app" },
];

const WORK_ORDERS = [{ _id: "w_till", number: "WO-77", customerName: "Kiss Kft.", task: { id: "s_printer", title: "Fix the till printer" } }];

const ok = (data, status = 200, message) => ({ status, body: { success: true, ...(message ? { message } : {}), data } });
const fail = (status, message, code) => ({ status, body: { success: false, message, ...(code ? { code } : {}) } });
const widgetFail = (status, code, message) => ({ status, body: { code, message } });
const iso = (ms) => new Date(ms).toISOString();

export function createTimer({ now = () => Date.now() } = {}) {
  let tasks, rows, live, paused, nextId;

  const midnight = () => new Date(now()).setHours(0, 0, 0, 0);
  const project = (id) => PROJECTS.find((p) => p._id === id);
  const taskOf = (id) => tasks.find((t) => t._id === id);

  const row = (id, projectId, taskId, start, end, extra = {}) => {
    const p = project(projectId);
    return { _id: id, projectId: { _id: p._id, code: p.code, title: p.title, customerName: p.customerName }, taskId: taskId ?? null, userId: { _id: USER_ID, name: "Teszt Elek", email: "elek@example.test" }, restaurantId: "r_1", start: iso(start), end: end == null ? null : iso(end), durationSec: end == null ? 0 : Math.round((end - start) / 1000), billable: true, hourlyRate: 0, note: "", source: "timer", isRunning: end == null, abandonedAt: null, pausedAt: null, ...extra };
  };

  const seed = () => {
    tasks = seedTasks();
    live = undefined;
    paused = undefined;
    nextId = 1;
    const day = midnight();
    rows = [
      row("e_1", "p_pos", "t_receipts", day + 8 * 60 * MIN, day + 9.5 * 60 * MIN),
      row("e_2", "p_admin", "t_l10n", day + 10 * 60 * MIN, day + 10.75 * 60 * MIN),
      row("e_3", "p_admin", null, day + 11 * 60 * MIN, day + 12 * 60 * MIN, { abandonedAt: iso(day + 12 * 60 * MIN) }),
    ];
    // Two entries on every weekday of the last 45 days: enough for week and month ranges.
    for (let d = 1; d <= 45; d++) {
      const at = new Date(day - d * DAY);
      if (at.getDay() === 0 || at.getDay() === 6) continue;
      rows.push(row(`h_${d}_1`, "p_pos", "t_receipts", at.getTime() + 8 * 60 * MIN, at.getTime() + 10 * 60 * MIN));
      rows.push(row(`h_${d}_2`, "p_admin", "t_l10n", at.getTime() + 10.5 * 60 * MIN, at.getTime() + 11.25 * 60 * MIN));
    }
  };
  seed();

  // ---- the timer ----

  const targetOf = (t) => {
    if (t.kind === "workOrder") {
      const w = WORK_ORDERS.find((x) => x._id === t.id);
      return { title: `#${w.number}`, projectTitle: `#${w.number}`, customerName: w.customerName, taskTitle: w.task.title, taskId: t.taskId ?? w.task.id };
    }
    const p = project(t.id);
    return { title: p.title, projectTitle: p.title, customerName: p.customerName, taskTitle: t.taskId ? (taskOf(t.taskId)?.title ?? null) : null, taskId: t.taskId ?? null };
  };

  const widgetState = (t, state) => {
    const wo = t.kind === "workOrder";
    const x = targetOf(t);
    return { kind: t.kind, id: t.id, title: x.title, projectTitle: x.projectTitle, taskId: x.taskId, taskTitle: x.taskTitle, customerName: x.customerName, startedAt: state === "paused" ? null : iso(t.startedAt), state, segmentType: wo ? "WORK" : null, workSeconds: wo ? 7200 : null, breakSeconds: wo ? 0 : null, pausedElapsedSeconds: state === "paused" ? t.durationSec : null, canBreak: wo, canPause: true };
  };

  const current = () => (live ? widgetState(live, "running") : paused ? widgetState(paused, "paused") : null);

  const closeLive = (pausedAt) => {
    if (!live) return;
    const end = now();
    if (live.kind === "project") {
      const r = rows.find((x) => x._id === live.entryId);
      if (r) Object.assign(r, { end: iso(end), durationSec: Math.round((end - live.startedAt) / 1000), isRunning: false, pausedAt: pausedAt ? iso(end) : null });
      if (pausedAt) paused = { ...live, durationSec: Math.round((end - live.startedAt) / 1000) };
    } else if (pausedAt) paused = { ...live, durationSec: Math.round((end - live.startedAt) / 1000) };
    live = undefined;
  };

  const open = (t) => {
    live = { kind: t.kind, id: t.id, taskId: t.taskId ?? null, startedAt: now(), entryId: `e_n${nextId++}` };
    if (live.kind === "project") rows.push(row(live.entryId, live.id, live.taskId, live.startedAt, null));
  };

  const runningRow = () => rows.find((r) => live && r._id === live.entryId);
  const slim = (r) => ({ _id: r._id, projectId: r.projectId._id, projectTitle: r.projectId.title, taskId: r.taskId, start: r.start, durationSec: r.durationSec, billable: true, note: "", ...(r.pausedAt ? { end: r.end, pausedAt: r.pausedAt } : {}) });

  const verbs = {
    start(body) {
      if (!["project", "workOrder"].includes(body.kind)) return widgetFail(400, "invalid_kind", "kind must be project or workOrder");
      if (typeof body.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.id)) return widgetFail(400, "invalid_id", "id is required");
      if (body.kind === "project" && !project(body.id)) return widgetFail(404, "project_not_found", "Project not found");
      if (body.kind === "workOrder" && !WORK_ORDERS.some((w) => w._id === body.id)) return widgetFail(404, "work_order_not_found", "Work order not found");
      closeLive(false);
      paused = undefined;
      open(body);
      return { status: 200, body: { timer: current() } };
    },
    stop() {
      if (!live && !paused) return widgetFail(404, "no_active_timer", "No active timer");
      closeLive(false);
      paused = undefined;
      return { status: 200, body: { timer: null } };
    },
    pause() {
      if (!live) return widgetFail(404, "no_active_timer", "No active timer");
      closeLive(true);
      return { status: 200, body: { timer: current() } };
    },
    resume() {
      if (!paused) return widgetFail(404, "no_paused_timer", "No paused timer");
      const t = paused;
      paused = undefined;
      open(t);
      return { status: 200, body: { timer: current() } };
    },
  };

  // ---- reads ----

  const trackables = () => [
    { kind: "workOrder", id: "w_till", title: "#WO-77", subtitle: "Kiss Kft.", taskId: "s_printer", taskTitle: "Fix the till printer" },
    { kind: "project", id: "p_pos", title: "Shop POS", subtitle: "Acme Kft.", taskId: "t_receipts", taskTitle: "Receipts" },
    { kind: "project", id: "p_admin", title: "Admin", subtitle: "Demo Gastro", taskId: "t_l10n", taskTitle: "Localization" },
    { kind: "project", id: "p_backend", title: "Happy Backend", subtitle: null, taskId: null, taskTitle: null },
  ];

  const entries = (q) => {
    const from = Date.parse(q.get("from") ?? "");
    const to = Date.parse(q.get("to") ?? "");
    const limit = Math.min(500, Number(q.get("limit")) || 200);
    return rows
      .filter((r) => (!Number.isFinite(from) || Date.parse(r.start) >= from) && (!Number.isFinite(to) || Date.parse(r.start) <= to))
      .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
      .slice(0, limit);
  };

  const bucket = (since) => {
    const mine = rows.filter((r) => !r.isRunning && !r.abandonedAt && Date.parse(r.start) >= since);
    return { start: iso(since), totalSeconds: mine.reduce((n, r) => n + r.durationSec, 0), billableSeconds: 0, entries: mine.length, activeUsers: 1, perUser: [], perProject: [], perTask: [] };
  };

  const has = (hay, q) => hay.some((h) => h && String(h).toLowerCase().includes(q));
  const pagination = (n, limit) => ({ page: 1, limit, total: n, pages: 1 });
  const taskOut = (t) => ({ _id: t._id, title: t.title, code: t.code, columnKey: "todo", priority: "normal", dueDate: null, projectId: t.projectId });

  return {
    controls: ["/__mock/timer", "/__mock/timer/bulk"],
    reset: seed,
    control(path, body) {
      if (path === "/__mock/timer/bulk") {
        const day = midnight();
        for (let i = 0; i < (Number(body.count) || 0); i++) rows.push(row(`b_${nextId++}`, "p_pos", "t_receipts", day + i * 10_000, day + i * 10_000 + MIN));
        return { ok: true, rows: rows.length };
      }
      const out = verbs[body.action]?.(body);
      return { ok: Boolean(out) && out.status === 200, timer: current() };
    },
    handle(method, path, url, body = {}) {
      const q = url.searchParams;
      if (method === "GET" && path === "/api/projects/me/running-timer") {
        return ok({ running: live?.kind === "project" ? slim(runningRow()) : null, paused: paused?.kind === "project" ? slim(rows.find((r) => r._id === paused.entryId)) : null });
      }
      if (method === "GET" && path === "/api/widgets/summary") {
        return { status: 200, body: { generatedAt: iso(now()), calendar: [], tasks: [], mail: null, stats: {}, timer: current(), orders: [], trackables: trackables(), calls: [] } };
      }
      if (method === "GET" && path === "/api/projects/time-entries") return ok(entries(q));
      if (method === "GET" && path === "/api/projects/time-entries/summary") {
        const at = (k) => Date.parse(q.get(k) ?? "") || midnight();
        return ok({ ranges: {}, day: bucket(at("dayStart")), week: bucket(at("weekStart")), month: bucket(at("monthStart")) });
      }
      if (method === "GET" && path === "/api/projects") {
        const s = (q.get("search") ?? "").trim().toLowerCase();
        const limit = Math.min(200, Number(q.get("limit")) || 25);
        const found = PROJECTS.filter((p) => !s || has([p.title, p.code, p.customerName], s));
        return ok({ projects: found.slice(0, limit).map((p) => ({ ...p, status: "active" })), pagination: pagination(found.length, limit) });
      }
      const one = /^\/api\/projects\/([A-Za-z0-9_-]+)$/.exec(path);
      if (method === "GET" && one) {
        const p = project(one[1]);
        return p ? ok({ ...p, status: "active" }) : fail(404, "Project not found");
      }
      if (method === "GET" && path === "/api/tasks/autocomplete") {
        const s = (q.get("q") ?? "").trim().toLowerCase();
        const limit = Math.min(20, Number(q.get("limit")) || 10);
        return ok({ tasks: tasks.filter((t) => !s || has([t.title, t.code], s)).slice(0, limit).map(taskOut) });
      }
      // The assignee list of "My tasks" lives in tasks.mjs; only the per-project list is the timer's.
      if (method === "GET" && path === "/api/tasks" && q.get("projectId")) {
        const limit = Math.min(200, Number(q.get("limit")) || 50);
        const mine = tasks.filter((t) => t.projectId === q.get("projectId"));
        return ok({ tasks: mine.slice(0, limit).map(taskOut), pagination: pagination(mine.length, limit) });
      }
      if (method === "POST" && path === "/api/tasks") {
        if (typeof body.title !== "string" || !body.title.trim()) return fail(400, "Missing required field: title");
        if (typeof body.projectId !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.projectId)) return fail(400, "Missing or invalid projectId");
        if (!project(body.projectId)) return fail(404, "Project not found");
        const n = tasks.filter((t) => t.projectId === body.projectId).length + 200;
        const task = { _id: `t_new${nextId++}`, code: `${project(body.projectId).code}-${n}`, title: body.title.trim(), projectId: body.projectId };
        tasks.push(task);
        return ok({ ...taskOut(task), description: "", status: "todo", assignees: [] }, 201, "Task created");
      }
      const verb = /^\/api\/widgets\/timer\/(start|stop|pause|resume)$/.exec(path);
      if (method === "POST" && verb) return verbs[verb[1]](body);
      return undefined;
    },
  };
}
