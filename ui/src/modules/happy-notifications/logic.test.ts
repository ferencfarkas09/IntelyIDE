import { describe, expect, it } from "vitest";
import type { NotificationItem, NotificationsView } from "../../ipc/happy";
import { ago, arrivals, barTooltip, chatEvent, chatTarget, countLabel, dayGroup, groupByDay, kindTone, toastable, toastText } from "./logic";

const item = (id: string, read = false, over: Partial<NotificationItem> = {}): NotificationItem => ({ id, title: `Title ${id}`, read, ...over });
const view = (items: NotificationItem[], loaded = true): NotificationsView => ({ items, unread: items.filter((i) => !i.read).length, loaded, stale: false });

describe("arrivals", () => {
  it("treats the first loaded list as a baseline and never announces the backlog", () => {
    const first = arrivals(undefined, view([item("a"), item("b")]));
    expect(first.arrived).toEqual([]);
    expect([...first.seen!]).toEqual(["a", "b"]);
  });

  it("waits for a list before it has a baseline", () => {
    expect(arrivals(undefined, view([], false))).toEqual({ arrived: [], seen: undefined });
  });

  it("announces only new unread items, once", () => {
    const base = arrivals(undefined, view([item("a")])).seen;
    const next = arrivals(base, view([item("c"), item("a"), item("r", true)]));
    expect(next.arrived.map((i) => i.id)).toEqual(["c"]);
    expect(arrivals(next.seen, view([item("c"), item("a"), item("r", true)])).arrived).toEqual([]);
  });

  it("does not announce an item that is already read", () => {
    const base = arrivals(undefined, view([])).seen;
    expect(arrivals(base, view([item("x", true)])).arrived).toEqual([]);
  });
});

describe("wording", () => {
  it("uses the item for one arrival and a count for several", () => {
    expect(toastText([item("a", false, { title: "Anna mentioned you", body: "see #dev" })])).toEqual({ title: "Anna mentioned you", description: "see #dev" });
    expect(toastText([item("a"), item("b")])).toEqual({ title: "2 new notifications", description: "Title a · Title b" });
    expect(toastText([item("a"), item("b"), item("c"), item("d")]).description).toBe("Title a · Title b · and 2 more");
  });

  it("formats relative times", () => {
    const now = 10_000_000_000;
    expect(ago(now - 20_000, now)).toBe("just now");
    expect(ago(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(ago(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(ago(now - 50 * 3_600_000, now)).toBe("2 d ago");
    expect(ago(undefined, now)).toBe("");
  });

  it("maps kinds to tones and caps the count", () => {
    expect(kindTone("Mention")).toBe("accent");
    expect(kindTone("something-else")).toBe("neutral");
    expect(kindTone(undefined)).toBe("neutral");
    expect([countLabel(3), countLabel(100)]).toEqual(["3", "99+"]);
    expect(barTooltip(0, false)).toBe("No unread notifications");
    expect(barTooltip(1, false)).toBe("1 unread notification");
    expect(barTooltip(4, true)).toContain("out of date");
  });
});

describe("chat helpers", () => {
  it("reads the event of a chat item and its target", () => {
    expect(chatEvent({ kind: "chat", eventKey: "chat.message.mention" })).toBe("mention");
    expect(chatEvent({ kind: "chat", eventKey: "chat.whatever" })).toBe("channel");
    expect(chatEvent({ kind: "task" })).toBeUndefined();
    expect(chatTarget({ kind: "chat", channelId: "c", messageId: "m", threadRoot: "r" })).toEqual({ channelId: "c", messageId: "m", threadRootId: "r" });
    expect(chatTarget({ kind: "chat" })).toBeUndefined();
    expect(chatTarget({ kind: "task", channelId: "c" })).toBeUndefined();
  });

  it("leaves chat items to the chat toasts while chat is live", () => {
    const items = [item("a", false, { kind: "chat" }), item("b")];
    expect(toastable(items, true).map((i) => i.id)).toEqual(["b"]);
    expect(toastable(items, false).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("groups by local day", () => {
    const now = new Date(2026, 9, 6, 12).getTime();
    const h = 3_600_000;
    expect(dayGroup(now - h, now)).toBe("today");
    expect(dayGroup(now - 15 * h, now)).toBe("yesterday");
    expect(dayGroup(now - 60 * h, now)).toBe("older");
    expect(dayGroup(null, now)).toBe("unknown");
    expect(groupByDay([{ createdAtMs: now - h }, { createdAtMs: now - 2 * h }, { createdAtMs: now - 60 * h }], now).map((g) => [g.group, g.items.length])).toEqual([["today", 2], ["older", 1]]);
  });
});
