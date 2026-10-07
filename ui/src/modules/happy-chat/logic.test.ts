import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatChannel, ChatMessage } from "../../ipc/happy";
import {
  buildRows,
  canInvite,
  canManageMembers,
  channelLabel,
  describeChannel,
  insertMention,
  isDirectKind,
  mentionIds,
  mentionQuery,
  replySummary,
  sectionsOf,
  trimWindow,
  createToastGate,
  dayLabel,
  failMessage,
  firstUnreadId,
  formatCredits,
  initials,
  isCreditsCode,
  listSections,
  norm,
  safeHttpsUrl,
  summarizeNotes,
  tokenize,
  trimMessages,
  typingLine,
  upsertMessage,
} from "./logic";

const AT = new Date(2026, 9, 3, 14, 0, 0).getTime();
const MIN = 60_000;

const msg = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  channelId: "c1",
  senderId: "u2",
  senderName: "Kovács Anna",
  text: id,
  createdAtMs: AT,
  edited: false,
  deleted: false,
  system: false,
  mine: false,
  mentionsMe: false,
  sendState: "sent",
  kind: "text",
  replyCount: 0,
  replyUsers: [],
  reactions: [],
  attachments: [],
  pinned: false,
  ...over,
});

const chan = (id: string, over: Partial<ChatChannel> = {}): ChatChannel => ({
  id,
  kind: "channel",
  name: id,
  unreadCount: 0,
  mentionCount: 0,
  muted: false,
  notifyLevel: "all",
  lastMessageAtMs: null,
  topic: "",
  description: "",
  memberCount: 3,
  archived: false,
  starred: false,
  isMember: true,
  role: "member",
  peers: [],
  ...over,
});

describe("tokenize", () => {
  it("finds https links and keeps the sentence punctuation out of them", () => {
    const t = tokenize("See https://github.com/happy/pos/pull/482. Then (https://a.test/x) done");
    expect(t.filter((x) => x.t === "link").map((x) => x.v)).toEqual(["https://github.com/happy/pos/pull/482", "https://a.test/x"]);
    expect(t.map((x) => x.v).join("")).toBe("See https://github.com/happy/pos/pull/482. Then (https://a.test/x) done");
  });

  it("keeps a closing bracket that belongs to the link", () => {
    const [, link] = tokenize("wiki https://a.test/Foo_(bar)");
    expect(link).toMatchObject({ t: "link", v: "https://a.test/Foo_(bar)" });
  });

  it("marks http links as not openable", () => {
    const link = tokenize("old http://old.example.test/status page")[1];
    expect(link).toMatchObject({ t: "link", href: undefined });
  });

  it("refuses user-info tricks, javascript: and file: links", () => {
    expect(safeHttpsUrl("https://good.test@evil.test/")).toBeUndefined();
    expect(safeHttpsUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeHttpsUrl("file:///etc/passwd")).toBeUndefined();
    expect(safeHttpsUrl("https://a.test/a b")).toBeUndefined();
    expect(safeHttpsUrl("https://" + "a".repeat(3000) + ".test")).toBeUndefined();
    // Bidi override / zero-width characters would let the shown text lie about the target.
    expect(safeHttpsUrl("https://ok.example/a\u202Egnp.exe")).toBeUndefined();
    expect(safeHttpsUrl("https://ok.example/a\u2066b")).toBeUndefined();
    expect(safeHttpsUrl("https://ok.example/a\u200Bb")).toBeUndefined();
    expect(tokenize("see https://ok.example/a\u202Egnp.exe now")[1]).toMatchObject({ t: "link", href: undefined });
    expect(safeHttpsUrl("https://meet.example.test/join?x=1#frag")).toBe("https://meet.example.test/join?x=1#frag");
  });

  it("never produces a token from markup: it stays text", () => {
    const t = tokenize('<img src=x onerror=alert(1)> <script>alert(1)</script>');
    expect(t).toEqual([{ t: "text", v: '<img src=x onerror=alert(1)> <script>alert(1)</script>' }]);
  });

  it("highlights mentions, and knows which one is the user", () => {
    const t = tokenize("Hi @Teszt Elek and @Anna, ping @channel", { name: "Teszt Elek", known: ["Teszt Elek", "Kovács Anna"] });
    const mentions = t.filter((x) => x.t === "mention");
    expect(mentions.map((m) => [m.v, m.t === "mention" && m.me])).toEqual([
      ["@Teszt Elek", true],
      ["@Anna", false],
      ["@channel", true],
    ]);
  });

  it("matches known two-word names regardless of accents and case", () => {
    const [, m] = tokenize("hello @kovacs anna!", { known: ["Kovács Anna"] });
    expect(m).toMatchObject({ t: "mention", v: "@kovacs anna" });
  });

  it("does not take an e-mail address for a mention", () => {
    expect(tokenize("write to anna@example.test please")).toEqual([{ t: "text", v: "write to anna@example.test please" }]);
  });

  it("matches the user by a part of the name", () => {
    expect(tokenize("@Elek look", { name: "Teszt Elek" })[0]).toMatchObject({ t: "mention", me: true });
  });
});

describe("rows", () => {
  it("adds day separators and groups consecutive messages of one sender", () => {
    const rows = buildRows(
      [
        msg("a", { createdAtMs: AT - 26 * 60 * MIN }),
        msg("b", { createdAtMs: AT - 3 * MIN }),
        msg("c", { createdAtMs: AT - 2 * MIN }),
        msg("d", { createdAtMs: AT - MIN, senderId: "u3", senderName: "Nagy Péter" }),
        msg("e", { createdAtMs: AT - 30 * 1000, senderId: "u3", senderName: "Nagy Péter" }),
      ],
      { nowMs: AT },
    );
    expect(rows.map((r) => (r.kind === "message" ? `${r.msg.id}${r.grouped ? "+" : ""}` : r.kind === "day" ? `day:${r.label}` : r.kind))).toEqual(["day:Yesterday", "a", "day:Today", "b", "c+", "d", "e+"]);
  });

  it("does not group across a long pause, a system line or the new-messages divider", () => {
    const rows = buildRows(
      [msg("a", { createdAtMs: AT - 20 * MIN }), msg("b", { createdAtMs: AT - 10 * MIN }), msg("sys", { createdAtMs: AT - 9 * MIN, system: true, senderId: "" }), msg("c", { createdAtMs: AT - 8 * MIN }), msg("d", { createdAtMs: AT - 7 * MIN })],
      { nowMs: AT, firstUnreadId: "d" },
    );
    const flat = rows.map((r) => (r.kind === "message" ? `${r.msg.id}${r.grouped ? "+" : ""}` : r.kind === "system" ? "sys" : r.kind));
    expect(flat).toEqual(["day", "a", "b", "sys", "c", "unread", "d"]);
  });

  it("puts the divider only before a message of someone else", () => {
    const rows = buildRows([msg("a", { mine: true })], { nowMs: AT, firstUnreadId: "a" });
    expect(rows.some((r) => r.kind === "unread")).toBe(false);
  });

  it("labels days", () => {
    expect(dayLabel(AT, AT)).toBe("Today");
    expect(dayLabel(AT - 24 * 60 * MIN, AT)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 8, 28, 9).getTime(), AT)).toBe("Mon, 28 Sep");
    expect(dayLabel(new Date(2025, 11, 24, 9).getTime(), AT)).toBe("Wed, 24 Dec 2025");
  });

  it("finds the first unread message among the messages of others", () => {
    const list = [msg("1"), msg("2", { mine: true }), msg("3"), msg("4")];
    expect(firstUnreadId(list, 2)).toBe("3");
    expect(firstUnreadId(list, 0)).toBeUndefined();
    expect(firstUnreadId(list, 9)).toBe("1");
  });
});

describe("upsertMessage", () => {
  it("replaces an optimistic message by its client id and keeps the order", () => {
    const pending = msg("local:x", { clientMessageId: "x", mine: true, sendState: "pending", createdAtMs: AT });
    const list = upsertMessage([msg("a", { createdAtMs: AT - MIN }), pending], msg("srv1", { clientMessageId: "x", mine: true, createdAtMs: AT + 1000 }));
    expect(list.map((m) => [m.id, m.sendState])).toEqual([["a", "sent"], ["srv1", "sent"]]);
  });

  it("is idempotent: the same echo twice leaves one message", () => {
    const echo = msg("srv1", { clientMessageId: "x", mine: true });
    const once = upsertMessage([], echo);
    expect(upsertMessage(once, echo)).toHaveLength(1);
  });

  it("does not let a late pending answer undo a sent message", () => {
    const sent = [msg("srv1", { clientMessageId: "x", mine: true })];
    const out = upsertMessage(sent, msg("local:x", { clientMessageId: "x", mine: true, sendState: "pending" }));
    expect(out).toHaveLength(1);
    expect(out[0]!.sendState).toBe("sent");
  });

  it("inserts a message that arrives out of order at its place", () => {
    const list = upsertMessage([msg("1", { createdAtMs: AT - 2 * MIN }), msg("3", { createdAtMs: AT })], msg("2", { createdAtMs: AT - MIN }));
    expect(list.map((m) => m.id)).toEqual(["1", "2", "3"]);
  });

  it("marks a send as failed and trims long histories", () => {
    const list = [msg("local:x", { clientMessageId: "x", sendState: "pending", mine: true })];
    expect(failMessage(list, "x", "INSUFFICIENT_CREDITS")[0]).toMatchObject({ sendState: "failed", errorCode: "INSUFFICIENT_CREDITS" });
    const many = Array.from({ length: 10 }, (_, i) => msg(String(i), { createdAtMs: AT + i }));
    expect(trimMessages(many, 4)).toMatchObject({ trimmed: true, items: many.slice(6) });
    expect(trimMessages(many, 20).trimmed).toBe(false);
  });
});

describe("channel list", () => {
  const channels = [
    chan("general", { unreadCount: 3, mentionCount: 1, lastMessageAtMs: 10 }),
    chan("dev", { lastMessageAtMs: 5 }),
    chan("random", { unreadCount: 5, muted: true }),
    chan("Kovács Anna", { kind: "direct", unreadCount: 1, lastMessageAtMs: 20 }),
    chan("Nagy Péter", { kind: "direct", lastMessageAtMs: 1 }),
  ];

  it("sorts into Unread, Channels and Direct with each conversation once", () => {
    const sections = listSections(channels, "");
    expect(sections.map((s) => [s.id, s.items.map((c) => c.name)])).toEqual([
      ["unread", ["Kovács Anna", "general"]],
      ["channels", ["dev", "random"]],
      ["direct", ["Nagy Péter"]],
    ]);
  });

  it("filters by name ignoring case and accents", () => {
    expect(listSections(channels, "kovacs").flatMap((s) => s.items.map((c) => c.name))).toEqual(["Kovács Anna"]);
    expect(listSections(channels, "zzz")).toEqual([]);
    expect(norm("Péter")).toBe("peter");
  });
});

describe("small formatters", () => {
  it("builds initials, typing lines and credit amounts", () => {
    expect(initials("Kovács Anna")).toBe("KA");
    expect(initials("madonna")).toBe("M");
    expect(typingLine([])).toBe("");
    expect(typingLine(["Kovács Anna"])).toBe("Kovács is typing…");
    expect(typingLine(["Kovács Anna", "Nagy Péter"])).toBe("Kovács and Nagy are typing…");
    expect(typingLine(["a", "b", "c"])).toBe("3 people are typing…");
    expect([formatCredits(0.02), formatCredits(12.5), formatCredits(12), formatCredits(12.456)]).toEqual(["0.02", "12.5", "12", "12.46"]);
    expect([isCreditsCode("INSUFFICIENT_CREDITS"), isCreditsCode("insufficientCredits"), isCreditsCode("offline"), isCreditsCode(undefined)]).toEqual([true, true, false, false]);
  });
});

describe("toast gate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const note = (channelId: string, over: object = {}) => ({ channelId, label: `#${channelId}`, sender: "Anna", preview: "hello", mention: false, direct: false, ...over });

  it("shows the first note at once and collects the rest into one toast when the window ends", () => {
    const show = vi.fn();
    const gate = createToastGate({ windowMs: 10_000, show, now: () => Date.now() });
    gate.push(note("ops"));
    expect(show).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) gate.push(note("ops"));
    expect(show).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(9_999);
    expect(show).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    expect(show).toHaveBeenCalledTimes(2);
    expect(show.mock.calls[1]![0]).toMatchObject({ title: "5 new messages in #ops", channelId: "ops" });
  });

  it("is quiet again after the window and never shows more than one toast per window", () => {
    const show = vi.fn();
    const gate = createToastGate({ windowMs: 10_000, show, now: () => Date.now() });
    gate.push(note("a"));
    vi.advanceTimersByTime(20_000);
    gate.push(note("b"));
    expect(show).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 200; i++) {
      gate.push(note("b"));
      vi.advanceTimersByTime(100);
    }
    // 20 s of storm: the opening toast plus two window flushes at most.
    expect(show.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("drops what is waiting for a conversation that was opened", () => {
    const show = vi.fn();
    const gate = createToastGate({ windowMs: 10_000, show, now: () => Date.now() });
    gate.push(note("a"));
    gate.push(note("b"));
    gate.clear("b");
    vi.advanceTimersByTime(11_000);
    expect(show).toHaveBeenCalledTimes(1);
    gate.dispose();
  });

  it("words a single message, a mention, a direct message and a pile across conversations", () => {
    expect(summarizeNotes([note("ops", { sender: "Anna", preview: "restart done" })])).toMatchObject({ title: "Anna in #ops", description: "restart done", tone: "info" });
    expect(summarizeNotes([note("ops", { mention: true })])).toMatchObject({ title: "Anna mentioned you in #ops", tone: "warn" });
    expect(summarizeNotes([note("anna", { direct: true, label: "Anna" })])).toMatchObject({ title: "Anna sent you a message" });
    expect(summarizeNotes([note("a"), note("b", { mention: true }), note("b")])).toMatchObject({ title: "3 new messages in 2 conversations", channelId: "b", tone: "warn" });
    expect(summarizeNotes([])).toBeUndefined();
  });
});

describe("sidebar sections", () => {
  const list = [
    chan("dev", { starred: false, lastMessageAtMs: 5 }),
    chan("ops", { starred: true }),
    chan("vezetők", { kind: "private", role: "admin" }),
    chan("ügyfél", { kind: "customer" }),
    chan("d1", { kind: "direct", name: "Anna", lastMessageAtMs: 1 }),
    chan("g1", { kind: "group", name: "Anna, Péter", lastMessageAtMs: 9 }),
    chan("hid", { archived: true }),
    chan("brw", { isMember: false }),
    chan("noisy", { unreadCount: 4, muted: true, name: "noisy" }),
    chan("hot", { unreadCount: 2, kind: "private", name: "hot" }),
  ];

  it("gives the Threads entry, Unread, Channels (starred first, all channel kinds) and Direct messages (direct + group)", () => {
    const data = sectionsOf({ channels: list, threadUnread: 2 });
    expect(data.threads).toEqual({ unread: 2 });
    expect(data.sections.map((s) => [s.id, s.items.map((c) => c.id)])).toEqual([
      ["unread", ["hot"]],
      ["channels", ["ops", "dev", "noisy", "ügyfél", "vezetők"]],
      ["direct", ["g1", "d1"]],
    ]);
    expect(sectionsOf(undefined)).toEqual({ threads: { unread: 0 }, sections: [] });
  });

  it("knows direct kinds and labels", () => {
    expect([isDirectKind("direct"), isDirectKind("group"), isDirectKind("private"), isDirectKind("channel")]).toEqual([true, true, false, false]);
    expect(channelLabel({ kind: "channel", name: "dev" })).toBe("#dev");
    expect(channelLabel({ kind: "private", name: "vezetők" })).toBe("vezetők");
    expect(describeChannel({ topic: " téma ", description: "leírás" })).toBe("téma");
    expect(describeChannel({ topic: "", description: "leírás" })).toBe("leírás");
  });

  it("offers invite/manage only where the server would allow it", () => {
    expect(canInvite({ kind: "direct", role: "admin" }, { canManageChannels: true })).toBe(false);
    expect(canInvite({ kind: "group", role: "admin" })).toBe(false);
    expect(canInvite({ kind: "channel", role: "member" })).toBe(true);
    expect(canInvite({ kind: "private", role: "member" })).toBe(false);
    expect(canInvite({ kind: "record", role: "member" })).toBe(true);
    expect(canInvite({ kind: "customer", role: "member" })).toBe(false);
    expect(canInvite({ kind: "private", role: "admin" })).toBe(true);
    expect(canInvite({ kind: "private", role: "member" }, { canManageChannels: true })).toBe(true);
    expect(canManageMembers({ kind: "channel", role: "member" })).toBe(false);
    expect(canManageMembers({ kind: "channel", role: "admin" })).toBe(true);
    expect(canManageMembers({ kind: "direct", role: "admin" }, { canManageChannels: true })).toBe(false);
  });
});

describe("threads and mentions", () => {
  const people = [
    { id: "u2", name: "Kovács Anna" },
    { id: "u3", name: "Nagy Péter" },
    { id: "u4", name: "Szabó Anna" },
  ];

  it("summarises replies: count, up to three initials, last time", () => {
    expect(replySummary({ replyCount: 0, replyUsers: [], lastReplyAtMs: null })).toBeUndefined();
    const r = replySummary({ replyCount: 5, replyUsers: [...people, { id: "u9", name: "Tóth Gábor" }], lastReplyAtMs: 42 })!;
    expect(r.count).toBe(5);
    expect(r.users.map((u) => u.initials)).toEqual(["KA", "NP", "SA"]);
    expect(r.lastAtMs).toBe(42);
  });

  it("extracts the ids of @Name tokens that match known people", () => {
    expect(mentionIds("hi @Kovács Anna and @nagy péter, ping @channel and @Nobody", people)).toEqual(["u2", "u3"]);
    expect(mentionIds("@Péter és @Péter", people)).toEqual(["u3"]);
    // "@Anna" is ambiguous (two Annas): no id is guessed
    expect(mentionIds("@Anna", people)).toEqual([]);
    expect(mentionIds("anna@example.test", people)).toEqual([]);
  });

  it("detects an in-progress mention at the caret and inserts the chosen name", () => {
    expect(mentionQuery("szia @par", 9)).toEqual({ query: "par", start: 5, end: 9 });
    expect(mentionQuery("@", 1)).toEqual({ query: "", start: 0, end: 1 });
    expect(mentionQuery("szia @Kovács An", 15)).toMatchObject({ query: "Kovács An" });
    expect(mentionQuery("mail anna@example.test", 22)).toBeUndefined();
    expect(mentionQuery("no mention here", 5)).toBeUndefined();
    expect(mentionQuery("@ 5pm", 5)).toBeUndefined();
    expect(mentionQuery("@Anna\nnext", 11)).toBeUndefined();
    const q = mentionQuery("szia @par vége", 9)!;
    expect(insertMention("szia @par vége", q, "Nagy Péter")).toEqual({ text: "szia @Nagy Péter  vége", caret: 17 });
  });

  it("trims a window from the chosen side", () => {
    const l = [msg("a"), msg("b"), msg("c")];
    expect(trimWindow(l, 2, "newest")).toMatchObject({ trimmed: true, items: [{ id: "b" }, { id: "c" }] });
    expect(trimWindow(l, 2, "oldest")).toMatchObject({ trimmed: true, items: [{ id: "a" }, { id: "b" }] });
    expect(trimWindow(l, 5, "oldest").trimmed).toBe(false);
  });
});

describe("formatBytes", () => {
  it("scales to B, KB, MB and GB with one decimal", async () => {
    const { formatBytes } = await import("./logic");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3.2 * 1024 * 1024)).toBe("3.2 MB");
    expect(formatBytes(-1)).toBe("");
  });
});
