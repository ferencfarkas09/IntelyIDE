import type { NotificationItem, NotificationsView, TaskItem, TasksView, TaskStatus } from "../bindings/happy";
import { call, subscribe } from "./rpc";
import type { Unsubscribe } from "./index";

export type { NotificationItem, NotificationsView, TaskItem, TasksView, TaskStatus };

/**
 * The Notifications inbox (plan E3). Rust polls the badge while the window is focused and pushes `onChange`; `list` fetches
 * now (the panel opened). A pushed `notification:new` (Socket.IO) reaches `onChange` at once. Rejections are
 * `EngineError`s (`notConnected`, `blocked`, `signedOut`, ...).
 */
export interface HappyInboxIpc {
  /** The last known inbox. Makes no request. */
  current(): Promise<NotificationsView>;
  list(): Promise<NotificationsView>;
  /** Needs "Allow actions": `PATCH /api/notifications/{id}/read`. */
  markRead(id: string): Promise<NotificationsView>;
  markUnread(id: string): Promise<NotificationsView>;
  markAllRead(): Promise<NotificationsView>;
  /** Removes one notification (`DELETE`). */
  remove(id: string): Promise<NotificationsView>;
  onChange(cb: (v: NotificationsView) => void): Unsubscribe;
}

/** My tasks (plan E4), read-only: the timer and agent shortcuts are webview-side. */
export interface HappyTasksIpc {
  current(): Promise<TasksView>;
  list(): Promise<TasksView>;
  onChange(cb: (v: TasksView) => void): Unsubscribe;
}

export function createTauriInbox(): HappyInboxIpc {
  return {
    current: () => call("happy_notifications_current"),
    list: () => call("happy_notifications_list"),
    markRead: (id) => call("happy_notifications_mark_read", { id }),
    markUnread: (id) => call("happy_notifications_mark_unread", { id }),
    markAllRead: () => call("happy_notifications_mark_all_read"),
    remove: (id) => call("happy_notifications_delete", { id }),
    onChange: (cb) => subscribe("happy:notifications", cb),
  };
}

export function createTauriTasks(): HappyTasksIpc {
  return {
    current: () => call("happy_tasks_current"),
    list: () => call("happy_tasks_list"),
    onChange: (cb) => subscribe("happy:tasks", cb),
  };
}
