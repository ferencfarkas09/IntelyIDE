import { t } from "../../i18n";
import type { NotificationItem, NotificationsView } from "../../ipc/happy";
import type { Tone } from "../../ui-kit";

/** At most one toast per this long (plan 1.7): arrivals in between are folded into the next one. */
export const TOAST_GAP_MS = 10_000;

/**
 * Unread items whose id was not seen before: the "transition" a toast may announce. The first view that has a list is a
 * baseline (everything in it counts as seen), so opening the app never toasts the backlog. `seen` is updated in place.
 */
export function arrivals(seen: Set<string> | undefined, view: NotificationsView): { arrived: NotificationItem[]; seen: Set<string> | undefined } {
  if (!view.loaded) return { arrived: [], seen };
  const next = new Set(view.items.map((i) => i.id));
  if (!seen) return { arrived: [], seen: next };
  const arrived = view.items.filter((i) => !i.read && !seen.has(i.id));
  return { arrived, seen: next };
}

/** The wording of one coalesced toast: the title for one item, a count and the first titles for several. */
export function toastText(items: readonly NotificationItem[]): { title: string; description?: string } {
  if (items.length === 1) return { title: items[0].title, description: items[0].body ?? undefined };
  const names = items.slice(0, 2).map((i) => i.title).join(" · ");
  return { title: t("hn.toast.many", { count: items.length }), description: items.length > 2 ? t("hn.toast.more", { names, count: items.length - 2 }) : names };
}

/** `just now`, `5 min ago`, `3 h ago`, `2 d ago`; an unknown time is empty. */
export function ago(thenMs: number | null | undefined, nowMs: number): string {
  if (thenMs == null) return "";
  const min = Math.floor((nowMs - thenMs) / 60_000);
  if (min < 1) return t("integrations.ago.now");
  if (min < 60) return t("integrations.ago.min", { n: min });
  const h = Math.floor(min / 60);
  return h < 24 ? t("integrations.ago.h", { n: h }) : t("integrations.ago.d", { n: Math.floor(h / 24) });
}

const KIND_TONE: Record<string, Tone> = { mention: "accent", task: "info", deploy: "ok", error: "danger", warning: "warn" };

export const kindTone = (kind: string | null | undefined): Tone => (kind ? (KIND_TONE[kind.toLowerCase()] ?? "neutral") : "neutral");

/** `9`, `99+`: the count shown next to the bell. */
export const countLabel = (n: number): string => (n > 99 ? "99+" : String(n));

/** What the status-bar item says when you hover it. */
export function barTooltip(unread: number, stale: boolean): string {
  return t(stale ? "hn.barStale" : "hn.bar", { unread });
}

export type DayGroup = "today" | "yesterday" | "older" | "unknown";

/** Which day bucket a notification belongs to (local calendar days). */
export function dayGroup(thenMs: number | null | undefined, nowMs: number): DayGroup {
  if (thenMs == null) return "unknown";
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  if (thenMs >= start.getTime()) return "today";
  return thenMs >= start.getTime() - 24 * 3_600_000 ? "yesterday" : "older";
}

/** Splits a (newest first) list into consecutive day groups, keeping the order. */
export function groupByDay<T extends { createdAtMs?: number | null }>(items: readonly T[], nowMs: number): { group: DayGroup; items: T[] }[] {
  const out: { group: DayGroup; items: T[] }[] = [];
  for (const item of items) {
    const group = dayGroup(item.createdAtMs, nowMs);
    const last = out.at(-1);
    if (last && last.group === group) last.items.push(item);
    else out.push({ group, items: [item] });
  }
  return out;
}

export type ChatEvent = "direct" | "mention" | "thread" | "channel";

/** `chat.message.direct|mention|thread|channel` -> the short event; anything else on a chat item reads as a channel message. */
export function chatEvent(item: Pick<NotificationItem, "kind" | "eventKey">): ChatEvent | undefined {
  if (item.kind !== "chat") return undefined;
  const k = (item.eventKey ?? "").split(".").pop();
  return k === "direct" || k === "mention" || k === "thread" ? k : "channel";
}

/** Where a click on a chat notification goes (undefined for other kinds or when the channel is unknown). */
export function chatTarget(item: Pick<NotificationItem, "kind" | "channelId" | "messageId" | "threadRoot">): { channelId: string; messageId?: string; threadRootId?: string } | undefined {
  if (item.kind !== "chat" || !item.channelId) return undefined;
  return { channelId: item.channelId, messageId: item.messageId ?? undefined, threadRootId: item.threadRoot ?? undefined };
}

/** Chat items are announced by the chat module's own toasts while the chat provider is live; the inbox only covers the rest. */
export function toastable(items: readonly NotificationItem[], chatIsLive: boolean): NotificationItem[] {
  return chatIsLive ? items.filter((i) => i.kind !== "chat") : [...items];
}
