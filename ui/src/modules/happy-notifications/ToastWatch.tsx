import { createEffect, on, onCleanup } from "solid-js";
import { t } from "../../i18n";
import type { NotificationItem } from "../../ipc/happy";
import { activeDockTab, dockVisible, openDockTab } from "../../platform/dock";
import { inboxView } from "../../store/happyNt";
import { toast } from "../../ui-kit";
import { markRead, openItem } from "./actions";
import { arrivals, TOAST_GAP_MS, chatTarget, toastable, toastText } from "./logic";
import { chatLive } from "../happy-chat/state";

/** Announces notifications that arrived since the last look: transitions only, coalesced, at most one toast per 10 s. */
export default function ToastWatch() {
  let seen: Set<string> | undefined;
  let lastAt = 0;
  let pending: NotificationItem[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** One item opens like a click on it (a chat one lands in the chat); several, or one that points nowhere, open the inbox. */
  const openToasted = (items: NotificationItem[]) => {
    if (items.length === 1 && chatTarget(items[0])) return openItem(items[0]);
    if (items.length === 1) void markRead(items[0].id);
    openDockTab("inbox");
  };

  const flush = () => {
    timer = undefined;
    if (!pending.length) return;
    const items = pending;
    pending = [];
    lastAt = Date.now();
    const text = toastText(items);
    toast.show({ title: text.title, description: text.description, tone: "info", action: { label: t("hn.toast.open"), onSelect: () => openToasted(items) } });
  };

  createEffect(
    on(inboxView, (view) => {
      if (!view.loaded) {
        seen = undefined;
        return;
      }
      const result = arrivals(seen, view);
      seen = result.seen;
      // Looking at the inbox already: the list shows it, a toast would only repeat it.
      // Chat items are toasted by the chat module's own events while chat is live: never twice.
      const arrived = toastable(result.arrived, chatLive());
      if (!arrived.length || (dockVisible() && activeDockTab()?.id === "inbox")) return;
      pending.push(...arrived);
      const wait = Math.max(0, lastAt + TOAST_GAP_MS - Date.now());
      if (wait === 0) flush();
      else timer ??= setTimeout(flush, wait);
    }),
  );
  onCleanup(() => clearTimeout(timer));
  return null;
}
