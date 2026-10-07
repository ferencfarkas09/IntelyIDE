import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { NotificationItem, NotificationsView } from "../../ipc/happy";
import { applyInbox } from "../../store/happyNt";
import { toast } from "../../ui-kit";
import { openChatAt } from "../happy-chat/state";
import { chatTarget } from "./logic";

const message = (e: unknown): string => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

/** Runs a mark-read call; a failure becomes a toast (it was the user's click, plan 1.7) and the inbox is left as it was. */
async function mark(op: () => Promise<NotificationsView>, title: string): Promise<boolean> {
  try {
    applyInbox(await op());
    return true;
  } catch (e) {
    toast.show({ title, description: message(e), tone: "danger" });
    return false;
  }
}

export const markRead = (id: string) => mark(() => ipc.happy.notifications.markRead(id), t("hn.err.markRead"));
export const markAllRead = () => mark(() => ipc.happy.notifications.markAllRead(), t("hn.err.markAll"));
export const errorText = message;
export const markUnread = (id: string) => mark(() => ipc.happy.notifications.markUnread(id), t("hn.err.markUnread"));
export const removeItem = (id: string) => mark(() => ipc.happy.notifications.remove(id), t("hn.err.remove"));

/** A click (or a toast action) on a notification: it is marked read (when allowed) and a chat one opens the chat at its message/thread. */
export function openItem(item: NotificationItem, canMark = true): void {
  if (!item.read && canMark) void markRead(item.id);
  const target = chatTarget(item);
  if (target) openChatAt(target);
}
