import { createEffect, createRoot } from "solid-js";
import { t } from "../../i18n";
import { execute } from "../../platform/commands";
import { toast } from "../../ui-kit";
import { inbox } from "./inbox";
import { describeEntry, type InboxEntry } from "./inboxLogic";

/** Whether the window is in the background, where a toast alone would be missed. */
const awayFromWindow = (): boolean => typeof document !== "undefined" && (document.hidden || !document.hasFocus());

function systemNotification(title: string, body: string): void {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(title, { body, tag: "intely-needs-you" });
  } catch {
    // Notifications are best effort: the toast, the badges and the inbox still show the request.
  }
}

let stop: (() => void) | undefined;

/** A request the hard stop or a saved rule answers within a moment never needs the user, so announcing it would only flash a toast. */
const SETTLE_MS = 250;

/**
 * Announces each new request once: a toast with a jump to the run, plus a system notification while the window is in the
 * background (only when the user already granted permission; this never asks for it). Several at once make one toast, and
 * only requests still open after a short settle time are announced.
 */
export function startNotifier(): void {
  if (stop) return;
  const seen = new Set<string>();
  let pending: InboxEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const open = new Set(inbox().map((e) => e.key));
    const fresh = pending.filter((e) => open.has(e.key));
    pending = [];
    if (fresh.length === 0) return;
    const { title, body } = describeEntry(fresh[0]);
    toast.show({ title: fresh.length > 1 ? t("runs.notify.more", { title, n: fresh.length - 1 }) : title, description: body, tone: "warn", duration: 10_000, action: { label: t("runs.notify.jump"), onSelect: () => void execute("runs.nextNeedsYou") } });
    if (awayFromWindow()) systemNotification(title, body);
  };
  stop = createRoot((dispose) => {
    createEffect(() => {
      const fresh = inbox().filter((e) => !seen.has(e.key));
      for (const e of inbox()) seen.add(e.key);
      if (fresh.length === 0) return;
      pending.push(...fresh);
      timer ??= setTimeout(flush, SETTLE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = [];
      dispose();
    };
  });
}

export function stopNotifier(): void {
  stop?.();
  stop = undefined;
}
