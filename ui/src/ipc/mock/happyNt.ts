// The in-memory Notifications inbox and My tasks of the mock Happy ((design notes: integrations-plan) E3 and E4). The same fixtures
// as scripts/mock-happy/{notifications,tasks}.mjs, deterministic and offline. `sim` lets tests and screenshots move the
// world (a new notification arrives, the task list changes) the way a poll would.
import type { HappyInboxIpc, HappyTasksIpc, NotificationItem, NotificationsView, TaskItem, TasksView, TaskStatus } from "../happyNt";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export interface NtHost {
  now(): number;
  /** Whether the provider is switched on, connected and allowed (no throwing). */
  on(id: "notifications" | "tasks"): boolean;
  requireOn(id: "notifications" | "tasks"): void;
  requireActions(id: "notifications" | "tasks"): void;
}

export interface MockNtSim {
  /** A new unread notification arrives (a transition: the UI may toast once). */
  notify(title: string, kind?: string, body?: string): string;
  /** A pushed `notification:new` (Socket.IO): the item is in the inbox at once, unread, and `onChange` fires. Returns its id. */
  push(item: Omit<NotificationItem, "id" | "read" | "createdAtMs"> & Partial<Pick<NotificationItem, "id" | "read" | "createdAtMs">>): string;
  /** Replaces the task list (statuses are kept). */
  setTasks(tasks: TaskItem[]): void;
  /** Back to the seeded inbox and task list (tests share one mock between cases). */
  reset(): void;
}

const STATUSES: TaskStatus[] = [
  { id: "s_todo", name: "To do", order: 1, done: false },
  { id: "s_doing", name: "In progress", order: 2, done: false },
  { id: "s_review", name: "In review", order: 3, done: false },
  { id: "s_done", name: "Done", order: 4, done: true },
];

export const SEED_TASKS = (now: number): TaskItem[] => [
  { id: "t_receipts", key: "HP-142", title: "Receipts: print the VAT line", status: "s_doing", project: "Shop POS", projectId: "p_pos", priority: "high", dueMs: now + 2 * DAY, description: "The receipt printout misses the VAT line on mixed-rate baskets.\nCheck the rounding per rate and add a test." },
  { id: "t_refunds", key: "HP-143", title: "Refunds: partial refund flow", status: "s_todo", project: "Shop POS", projectId: "p_pos", priority: "normal", description: "Support refunding a single line of a paid order." },
  { id: "t_l10n", key: "ADM-77", title: "Localization: Hungarian date formats", status: "s_todo", project: "Admin", projectId: "p_admin", priority: "low" },
  { id: "t_review", key: "ADM-80", title: "Review the rounding fix", status: "s_review", project: "Admin", projectId: "p_admin", priority: "normal", dueMs: now + DAY },
  { id: "t_api", key: "BE-31", title: "Orders endpoint: add pagination", status: "s_todo", project: "Happy Backend", projectId: "p_backend", priority: "normal", description: "GET /orders returns everything; add limit/cursor." },
  { id: "t_android", key: "APP-12", title: "Android: Google sign-in crash on cold start", status: "s_doing", project: "Happy Services App", projectId: "p_app", priority: "high" },
  { id: "t_till", key: "HP-130", title: "Fix the till printer going offline", status: "s_done", project: "Shop POS", projectId: "p_pos", priority: "normal" },
];

const seedInbox = (now: number): NotificationItem[] => [
  { id: "n_1", title: "Anna mentioned you in #dev", body: "Can you look at the receipt rounding before the review?", kind: "mention", createdAtMs: now - 10 * MIN, read: false },
  { id: "n_2", title: "Task assigned: Receipts", body: "HP-142 was assigned to you by Péter", kind: "task", createdAtMs: now - 45 * MIN, read: false },
  { id: "n_3", title: "Deploy finished: sandbox", body: "Build 412 is live on sandbox", kind: "deploy", createdAtMs: now - 180 * MIN, read: true },
  // Chat notifications: the ids match the mock chat seed (ipc/mock/happyChat.ts: channel c_*, direct d_*, message m_<channel>_<n>).
  { id: "n_c1", title: "Kovács Anna", body: "Can you send me the receipt export?", kind: "chat", eventKey: "chat.message.direct", channelId: "d_anna", messageId: "m_d_anna_10", createdAtMs: now - 3 * MIN, read: false },
  { id: "n_c2", title: "Nagy Péter in #general", body: "@Teszt Elek the sandbox is ready for your check", kind: "chat", eventKey: "chat.message.mention", channelId: "c_general", messageId: "m_c_general_28", createdAtMs: now - 25 * MIN, read: false },
  { id: "n_c3", title: "Szabó Réka replied in #dev", body: "Fixed in the last commit, please re-run the tests.", kind: "chat", eventKey: "chat.message.thread", channelId: "c_dev", messageId: "m_c_dev_45", threadRoot: "m_c_dev_40", createdAtMs: now - 26 * 60 * MIN, read: true },
];

export function createMockNt(host: NtHost): { inbox: HappyInboxIpc; tasks: HappyTasksIpc; sim: MockNtSim } {
  let items = seedInbox(host.now());
  let list = SEED_TASKS(host.now());
  let next = 100;
  const inboxListeners = new Set<(v: NotificationsView) => void>();
  const taskListeners = new Set<(v: TasksView) => void>();

  const inboxView = (): NotificationsView => {
    const sorted = [...items].sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)).map((i) => ({ ...i }));
    return { items: sorted, unread: sorted.filter((i) => !i.read).length, loaded: true, stale: false };
  };
  const tasksView = (): TasksView => ({ tasks: list.map((t) => ({ ...t })), statuses: STATUSES.map((s) => ({ ...s })), loaded: true, stale: false });
  const emitInbox = () => inboxListeners.forEach((cb) => cb(inboxView()));
  const emitTasks = () => taskListeners.forEach((cb) => cb(tasksView()));
  const emptyInbox: NotificationsView = { items: [], unread: 0, loaded: false, stale: false };
  const emptyTasks: TasksView = { tasks: [], statuses: [], loaded: false, stale: false };

  return {
    inbox: {
      current: async () => (host.on("notifications") ? inboxView() : emptyInbox),
      async list() {
        host.requireOn("notifications");
        return inboxView();
      },
      async markRead(id) {
        host.requireActions("notifications");
        if (!/^[A-Za-z0-9_-]+$/.test(id)) throw { code: "blocked", message: "That request is not on the allow-list" };
        items = items.map((i) => (i.id === id ? { ...i, read: true } : i));
        emitInbox();
        return inboxView();
      },
      async markUnread(id) {
        host.requireActions("notifications");
        if (!/^[A-Za-z0-9_-]+$/.test(id)) throw { code: "blocked", message: "That request is not on the allow-list" };
        items = items.map((i) => (i.id === id ? { ...i, read: false } : i));
        emitInbox();
        return inboxView();
      },
      async remove(id) {
        host.requireActions("notifications");
        if (!/^[A-Za-z0-9_-]+$/.test(id)) throw { code: "blocked", message: "That request is not on the allow-list" };
        items = items.filter((i) => i.id !== id);
        emitInbox();
        return inboxView();
      },
      async markAllRead() {
        host.requireActions("notifications");
        items = items.map((i) => ({ ...i, read: true }));
        emitInbox();
        return inboxView();
      },
      onChange(cb) {
        inboxListeners.add(cb);
        return () => inboxListeners.delete(cb);
      },
    },
    tasks: {
      current: async () => (host.on("tasks") ? tasksView() : emptyTasks),
      async list() {
        host.requireOn("tasks");
        return tasksView();
      },
      onChange(cb) {
        taskListeners.add(cb);
        return () => taskListeners.delete(cb);
      },
    },
    sim: {
      notify(title, kind = "info", body) {
        const id = `n_${next++}`;
        items = [...items, { id, title, body, kind, createdAtMs: host.now(), read: false }];
        emitInbox();
        return id;
      },
      push(item) {
        const id = item.id ?? `n_${next++}`;
        items = [...items.filter((i) => i.id !== id), { read: false, createdAtMs: host.now(), ...item, id }];
        emitInbox();
        return id;
      },
      setTasks(tasks) {
        list = tasks;
        emitTasks();
      },
      reset() {
        items = seedInbox(host.now());
        list = SEED_TASKS(host.now());
        next = 100;
      },
    },
  };
}
