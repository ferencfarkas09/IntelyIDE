// "My tasks" fixtures for the mock Happy server ((design notes: integrations-plan) E4). The paths and field names are the same
// GUESSES the Rust provider makes (nothing was recorded from the live API): GET /api/tasks?assignee=<me> and
// GET /api/tasks/statuses. The project and task ids line up with the Time Tracer's trackables (p_pos, t_receipts, ...), so
// "Start timer" on a task works end to end against the mock.

const DAY = 24 * 60 * 60_000;

const STATUSES = [
  { id: "s_todo", name: "To do", order: 1 },
  { id: "s_doing", name: "In progress", order: 2 },
  { id: "s_review", name: "In review", order: 3 },
  { id: "s_done", name: "Done", order: 4, category: "done" },
];

const PROJECTS = {
  p_pos: { id: "p_pos", name: "Shop POS" },
  p_admin: { id: "p_admin", name: "Admin" },
  p_backend: { id: "p_backend", name: "Happy Backend" },
  p_app: { id: "p_app", name: "Happy Services App" },
};

const seed = (t) => [
  { id: "t_receipts", key: "HP-142", title: "Receipts: print the VAT line", status: "s_doing", project: PROJECTS.p_pos, priority: "high", dueDate: new Date(t + 2 * DAY).toISOString(), description: "The receipt printout misses the VAT line on mixed-rate baskets.\nCheck the rounding per rate and add a test.", assignee: "u_1" },
  { id: "t_refunds", key: "HP-143", title: "Refunds: partial refund flow", status: "s_todo", project: PROJECTS.p_pos, priority: "normal", description: "Support refunding a single line of a paid order.", assignee: "u_1" },
  { id: "t_l10n", key: "ADM-77", title: "Localization: Hungarian date formats", status: "s_todo", project: PROJECTS.p_admin, priority: "low", assignee: "u_1" },
  { id: "t_review", key: "ADM-80", title: "Review the rounding fix", status: "s_review", project: PROJECTS.p_admin, priority: "normal", dueDate: new Date(t + DAY).toISOString(), assignee: "u_1" },
  { id: "t_api", key: "BE-31", title: "Orders endpoint: add pagination", status: "s_todo", project: PROJECTS.p_backend, priority: "normal", description: "GET /orders returns everything; add limit/cursor.", assignee: "u_1" },
  { id: "t_android", key: "APP-12", title: "Android: Google sign-in crash on cold start", status: "s_doing", project: PROJECTS.p_app, priority: "high", assignee: "u_1" },
  { id: "t_till", key: "HP-130", title: "Fix the till printer going offline", status: "s_done", project: PROJECTS.p_pos, priority: "normal", assignee: "u_1" },
  { id: "t_other", key: "HP-150", title: "Somebody else's task", status: "s_todo", project: PROJECTS.p_pos, assignee: "u_9" },
];

export function createTasks({ now = () => Date.now() } = {}) {
  const tasks = seed(now());
  return {
    reset() {},
    controls: [],
    /** The title and project of a task id, for the timer fixtures. */
    lookup(taskId) {
      const t = tasks.find((x) => x.id === taskId);
      return t ? { title: t.title, project: t.project.name } : undefined;
    },
    handle(method, path, url) {
      if (method !== "GET") return undefined;
      if (path === "/api/tasks/statuses") return { status: 200, body: { statuses: STATUSES } };
      if (path === "/api/tasks") {
        const who = url.searchParams.get("assignee");
        const mine = !who || who === "me" || who === "u_1" || who === "5f0000000000000000000001" ? tasks.filter((t) => t.assignee === "u_1") : tasks.filter((t) => t.assignee === who);
        const limit = Number(url.searchParams.get("limit")) || 200;
        return { status: 200, body: { tasks: mine.slice(0, limit).map(({ assignee, ...rest }) => rest) } };
      }
      return undefined;
    },
  };
}
