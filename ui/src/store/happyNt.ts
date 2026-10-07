// Shared view of the Notifications inbox and My tasks (modules never import each other, so the state lives here, next to
// store/happy.ts, which starts and stops this feed together with its own events). Nothing is subscribed or read while the
// integrations are off: `startNtFeed` is only called when the master switch and at least one provider are on.
import { createSignal } from "solid-js";
import { ipc } from "../ipc";
import type { NotificationsView, TasksView } from "../ipc/happy";
import { happyStatus } from "./happy";

export const EMPTY_INBOX: NotificationsView = { items: [], unread: 0, loaded: false, stale: false };
export const EMPTY_TASKS: TasksView = { tasks: [], statuses: [], loaded: false, stale: false };

const [inbox, setInboxRaw] = createSignal<NotificationsView>(EMPTY_INBOX);
const [tasks, setTasksRaw] = createSignal<TasksView>(EMPTY_TASKS);

/** Items that did not change keep their object, so a poll that finds the same rows leaves the open list (and its focus) alone. */
export function reuse<T extends { id: string }>(previous: readonly T[], next: readonly T[]): T[] {
  const before = new Map(previous.map((p) => [p.id, p]));
  return next.map((n) => {
    const old = before.get(n.id);
    return old && JSON.stringify(old) === JSON.stringify(n) ? old : n;
  });
}

const setInbox = (next: NotificationsView) => setInboxRaw((prev) => ({ ...next, items: reuse(prev.items, next.items) }));
const setTasks = (next: TasksView) => setTasksRaw((prev) => ({ ...next, tasks: reuse(prev.tasks, next.tasks) }));

export const inboxView = inbox;
export const tasksView = tasks;
/** Panels that fetched on their own (open, refresh) hand the result in, so the badge follows at once. */
export const applyInbox = setInbox;
export const applyTasks = setTasks;

type PrefKey = "notifications" | "tasks";

/** Connected and polling (also while offline with stale data): the state the surfaces are shown in. */
export function ntReady(id: PrefKey): boolean {
  const s = happyStatus()?.providers.find((p) => p.id === id)?.state;
  return s === "ready" || s === "degraded";
}

export const ntOn = (id: PrefKey): boolean => !!happyStatus()?.config.master && !!happyStatus()?.config[id].enabled;
export const inboxBadgeVisible = (): boolean => !!happyStatus()?.config.notifications.showInStatusBar && ntReady("notifications");
export const tasksItemVisible = (): boolean => !!happyStatus()?.config.tasks.showInStatusBar && ntReady("tasks") && tasks().loaded;
/** True once the provider is on but cannot show data (waiting for a token, not permitted, signed out ...). */
export const providerNote = (id: PrefKey) => happyStatus()?.providers.find((p) => p.id === id);

let offs: (() => void)[] = [];

/** Subscribes to the backend events and reads what Rust already has (no network). Returns nothing; stop it with `stopNtFeed`. */
export function startNtFeed(): void {
  if (offs.length) return;
  offs = [ipc.happy.notifications.onChange(setInbox), ipc.happy.tasks.onChange(setTasks)];
  void ipc.happy.notifications.current().then(setInbox, () => {});
  void ipc.happy.tasks.current().then(setTasks, () => {});
}

export function stopNtFeed(): void {
  offs.forEach((off) => off());
  offs = [];
  setInbox(EMPTY_INBOX);
  setTasks(EMPTY_TASKS);
}
