import { locale, t } from "../../i18n";
import type { ChatChannel, ChatKind, ChatMessage, ChatPerson, ChatSummary } from "../../ipc/happy";

/** The server accepts at most this many characters; the composer counts from 7000. */
export const MAX_LENGTH = 8000;
export const COUNTER_FROM = 7000;
const GROUP_GAP_MS = 5 * 60_000;

/** Lower case without accents, for search ("Kovacs" finds "Kovács"). */
export const norm = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]!, parts[parts.length - 1]!] : parts;
  return letters.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
};

/** A stable 1..8 slot for the avatar colour. */
export const avatarSlot = (name: string): number => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return (h % 8) + 1;
};

const pad = (n: number) => String(n).padStart(2, "0");
export const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** `Today`, `Yesterday`, `Mon, 28 Sep` (with the year when it is not this one). Local time. */
export function dayLabel(ms: number, nowMs: number): string {
  const day = startOfDay(ms);
  const today = startOfDay(nowMs);
  const diff = Math.round((today - day) / 86_400_000);
  if (diff === 0) return t("hc.day.today");
  if (diff === 1) return t("hc.day.yesterday");
  const d = new Date(ms);
  const tag = locale() === "en-XA" ? "en" : locale();
  const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(tag, o).format(d);
  const params = { weekday: part({ weekday: "short" }), day: String(d.getDate()), month: part({ month: "short" }), year: String(d.getFullYear()) };
  return t(d.getFullYear() === new Date(nowMs).getFullYear() ? "hc.day.format" : "hc.day.formatYear", params);
}

// ---- message text -----------------------------------------------------------------------------------------------

export type Token =
  | { t: "text"; v: string }
  /** `href` is set only for https links, which are the only ones that open. */
  | { t: "link"; v: string; href?: string }
  | { t: "mention"; v: string; me: boolean };

const URL_RE = /https?:\/\/[^\s<>"'`]+/giu;
const SPECIAL_MENTIONS = new Set(["channel", "here", "everyone", "all"]);

/** Trailing punctuation belongs to the sentence, not the link; a closing bracket stays only when the link has its opener. */
function trimLink(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.at(-1);
    if (!last) return url;
    if (/[.,;:!?'"]/u.test(last)) url = url.slice(0, -1);
    else if (last === ")" && !url.includes("(")) url = url.slice(0, -1);
    else if (last === "]" && !url.includes("[")) url = url.slice(0, -1);
    else return url;
  }
}

/** https only, a real host, no user info (`https://good.test@evil.test`), no control characters, a sane length. */
export function safeHttpsUrl(url: string): string | undefined {
  // \p{Cf} covers the bidi overrides (U+202E would show "...gnp.exe" as "...exe.png") and zero-width characters.
  if (url.length > 2048 || /[\s\p{Cc}\p{Cf}]/u.test(url)) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

export interface Who {
  /** The signed-in user's full name; its parts count as "me" in a mention. */
  name?: string;
  /** Names to try after an `@`, so "@Kovács Anna" is one mention rather than "@Kovács". */
  known?: readonly string[];
}

const wordChar = /[\p{L}\p{N}_.\-]/u;

function mentionAt(text: string, at: number, who: Who): string | undefined {
  const rest = text.slice(at + 1);
  const known = [...(who.known ?? [])].sort((a, b) => b.length - a.length);
  for (const name of known) {
    if (name && norm(rest.slice(0, name.length)) === norm(name) && !wordChar.test(rest[name.length] ?? " ")) return rest.slice(0, name.length);
  }
  let end = 0;
  while (end < rest.length && wordChar.test(rest[end]!)) end++;
  // A trailing dot or dash is punctuation ("@Anna.").
  while (end > 0 && /[.\-]/.test(rest[end - 1]!)) end--;
  return end > 0 ? rest.slice(0, end) : undefined;
}

const isMe = (mention: string, who: Who): boolean => {
  const m = norm(mention);
  if (SPECIAL_MENTIONS.has(m)) return true;
  if (!who.name) return false;
  return m === norm(who.name) || norm(who.name).split(/\s+/).includes(m);
};

/** Splits a message into text, links and mentions. Everything is rendered as text nodes: no HTML ever. */
export function tokenize(text: string, who: Who = {}): Token[] {
  const out: Token[] = [];
  const push = (t: Token) => {
    const last = out.at(-1);
    if (t.t === "text" && last?.t === "text") last.v += t.v;
    else out.push(t);
  };
  const re = new RegExp(`${URL_RE.source}|@`, "giu");
  let cursor = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === "@") {
      const prev = text[m.index - 1];
      // `anna@example.test` is an address, not a mention.
      if (prev && !/[\s([{>,;:!?"'-]/u.test(prev)) continue;
      const name = mentionAt(text, m.index, who);
      if (!name) continue;
      if (m.index > cursor) push({ t: "text", v: text.slice(cursor, m.index) });
      push({ t: "mention", v: `@${name}`, me: isMe(name, who) });
      cursor = m.index + 1 + name.length;
      re.lastIndex = cursor;
      continue;
    }
    const raw = trimLink(m[0]);
    if (raw.length < 8) continue;
    if (m.index > cursor) push({ t: "text", v: text.slice(cursor, m.index) });
    push({ t: "link", v: raw, href: safeHttpsUrl(raw) });
    cursor = m.index + raw.length;
    re.lastIndex = cursor;
  }
  if (cursor < text.length) push({ t: "text", v: text.slice(cursor) });
  return out;
}

export const hostOf = (href: string): string => {
  try {
    return new URL(href).host;
  } catch {
    return "";
  }
};

// ---- the conversation as rows -----------------------------------------------------------------------------------

export type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "unread"; key: string }
  | { kind: "message"; key: string; msg: ChatMessage; grouped: boolean }
  | { kind: "system"; key: string; msg: ChatMessage };

/** The stable identity of a message: a pending one keeps its client id when the server's copy replaces it. */
export const messageKey = (m: ChatMessage): string => (m.clientMessageId ? `c:${m.clientMessageId}` : `i:${m.id}`);

/**
 * Day separators, the "New messages" divider before `firstUnreadId`, and grouping: consecutive messages of one sender
 * within five minutes (same day) share a header. A system line, a day change or the divider ends a group.
 */
export function buildRows(messages: readonly ChatMessage[], opts: { nowMs: number; firstUnreadId?: string }): Row[] {
  const rows: Row[] = [];
  let prev: ChatMessage | undefined;
  let prevDay = Number.NaN;
  for (const msg of messages) {
    const day = startOfDay(msg.createdAtMs);
    let broke = false;
    if (day !== prevDay) {
      rows.push({ kind: "day", key: `day:${day}`, label: dayLabel(msg.createdAtMs, opts.nowMs) });
      prevDay = day;
      broke = true;
    }
    if (opts.firstUnreadId && msg.id === opts.firstUnreadId && !msg.mine) {
      rows.push({ kind: "unread", key: "unread" });
      broke = true;
    }
    if (msg.system) {
      rows.push({ kind: "system", key: messageKey(msg), msg });
      prev = undefined;
      continue;
    }
    const grouped = !broke && !!prev && prev.senderId === msg.senderId && msg.createdAtMs - prev.createdAtMs < GROUP_GAP_MS;
    rows.push({ kind: "message", key: messageKey(msg), msg, grouped });
    prev = msg;
  }
  return rows;
}

/**
 * Applies one message to a list (oldest first): the same `clientMessageId` or `id` replaces what is there, so the
 * socket echo, the `send` answer and a retry can arrive in any order and in duplicate. A deleted message stays as a stub.
 */
export function upsertMessage(list: readonly ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const at = list.findIndex((m) => m.id === incoming.id || (!!incoming.clientMessageId && m.clientMessageId === incoming.clientMessageId));
  if (at >= 0) {
    const current = list[at]!;
    // A late "pending" answer must not undo a message that is already sent.
    if (current.sendState === "sent" && incoming.sendState === "pending") return list.slice();
    const next = { ...incoming, clientMessageId: incoming.clientMessageId ?? current.clientMessageId };
    // The slot is kept unless the server's time moved it past its neighbours.
    const rest = list.filter((_, i) => i !== at);
    return placeSorted(rest, next);
  }
  return placeSorted(list, incoming);
}

function placeSorted(list: readonly ChatMessage[], m: ChatMessage): ChatMessage[] {
  const out = list.slice();
  let i = out.length;
  while (i > 0 && out[i - 1]!.createdAtMs > m.createdAtMs) i--;
  out.splice(i, 0, m);
  return out;
}

/** Keeps the newest `max` messages; `trimmed` tells the caller that older history is back on the server. */
export function trimMessages(list: readonly ChatMessage[], max: number): { items: ChatMessage[]; trimmed: boolean } {
  if (list.length <= max) return { items: list.slice(), trimmed: false };
  return { items: list.slice(list.length - max), trimmed: true };
}

/** Keeps `max` messages from the chosen end: `newest` drops the oldest ones (live append), `oldest` drops the newest ones (paging back in a jumped window). */
export function trimWindow(list: readonly ChatMessage[], max: number, keep: "newest" | "oldest"): { items: ChatMessage[]; trimmed: boolean } {
  if (list.length <= max) return { items: list.slice(), trimmed: false };
  return { items: keep === "newest" ? list.slice(list.length - max) : list.slice(0, max), trimmed: true };
}

/** Marks a message as failed in place (the answer to a rejected `send`). */
export const failMessage = (list: readonly ChatMessage[], clientMessageId: string, errorCode: string): ChatMessage[] =>
  list.map((m) => (m.clientMessageId === clientMessageId && m.sendState !== "sent" ? { ...m, sendState: "failed" as const, errorCode } : m));

export const isCreditsCode = (code: string | null | undefined): boolean => !!code && /^(INSUFFICIENT_CREDITS|insufficientCredits|402)$/.test(code);

/** The first message of "new messages": the `unread` newest messages of others. */
export function firstUnreadId(messages: readonly ChatMessage[], unread: number): string | undefined {
  if (unread <= 0) return undefined;
  const others = messages.filter((m) => !m.mine && !m.system && m.sendState === "sent");
  return others.length >= unread ? others[others.length - unread]?.id : others[0]?.id;
}

export const newClientId = (): string => (globalThis.crypto?.randomUUID?.() ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

// ---- channel list --------------------------------------------------------------------------------------------------

/** `#general` for a public channel, the plain name for everything else (the UI shows the kind with an icon). */
export const channelLabel = (c: Pick<ChatChannel, "kind" | "name">): string => (c.kind === "channel" ? `#${c.name}` : c.name);

/** Direct and group conversations live under "Direct messages"; nobody can be invited into them. */
export const isDirectKind = (kind: ChatKind): boolean => kind === "direct" || kind === "group";

/** The one-line description of a channel for a header: its topic, else its description (empty when it has neither). */
export const describeChannel = (c: Pick<ChatChannel, "topic" | "description">): string => c.topic.trim() || c.description.trim();

/**
 * Whether the "invite people" action is offered: never in direct/group conversations; in a public channel (or record/customer) for
 * every member; in a private channel for a channel admin (or when the user may manage channels). The server has the last word.
 */
export function canInvite(c: Pick<ChatChannel, "kind" | "role">, s?: Pick<ChatSummary, "canManageChannels">): boolean {
  if (isDirectKind(c.kind)) return false;
  // The server lets any staff member add people to a public or record channel; private/customer ones need a channel admin.
  if (c.kind === "channel" || c.kind === "record") return true;
  return c.role === "admin" || !!s?.canManageChannels;
}

/** Whether members can be removed / the channel edited: not in direct/group, and only for a channel admin (or a user who may manage channels). */
export function canManageMembers(c: Pick<ChatChannel, "kind" | "role">, s?: Pick<ChatSummary, "canManageChannels">): boolean {
  if (isDirectKind(c.kind)) return false;
  return c.role === "admin" || !!s?.canManageChannels;
}

export interface ListSection {
  id: "unread" | "direct" | "channels";
  title: string;
  items: ChatChannel[];
}

const listed = (c: ChatChannel) => c.isMember && !c.archived;

/**
 * Unread (not muted, with unread messages), Channels (channel/private/record/customer, starred first, then by name), Direct
 * messages (direct/group, recent first). A conversation sits in one section only. `query` filters by name, ignoring case and
 * accents. Not-joined and archived channels are never listed.
 */
export function listSections(channels: readonly ChatChannel[], query: string): ListSection[] {
  const q = norm(query.trim());
  const shown = channels.filter((c) => listed(c) && (!q || norm(c.name).includes(q)));
  const byRecent = (a: ChatChannel, b: ChatChannel) => (b.lastMessageAtMs ?? 0) - (a.lastMessageAtMs ?? 0) || a.name.localeCompare(b.name);
  const byStarName = (a: ChatChannel, b: ChatChannel) => Number(b.starred) - Number(a.starred) || a.name.localeCompare(b.name);
  const unread = shown.filter((c) => c.unreadCount > 0 && !c.muted).sort(byRecent);
  const rest = shown.filter((c) => !unread.includes(c));
  const sections: ListSection[] = [
    { id: "unread", title: t("hc.section.unread"), items: unread },
    { id: "channels", title: t("hc.section.channels"), items: rest.filter((c) => !isDirectKind(c.kind)).sort(byStarName) },
    { id: "direct", title: t("hc.section.direct"), items: rest.filter((c) => isDirectKind(c.kind)).sort(byRecent) },
  ];
  return sections.filter((s) => s.items.length > 0);
}

export interface SidebarData {
  /** The "Threads" entry: always there; `unread` is the number of threads with news (the badge). */
  threads: { unread: number };
  /** Unread, Channels, Direct messages (only the non-empty ones). */
  sections: ListSection[];
}

/** Everything the sidebar shows, from the summary: the Threads entry plus the sections. */
export function sectionsOf(summary: Pick<ChatSummary, "channels" | "threadUnread"> | undefined, query = ""): SidebarData {
  return { threads: { unread: summary?.threadUnread ?? 0 }, sections: listSections(summary?.channels ?? [], query) };
}

// ---- threads and mentions ------------------------------------------------------------------------------------------

export interface ReplySummary {
  count: number;
  /** Up to three distinct repliers, newest replier last, as `{ id, name, initials }`. */
  users: { id: string; name: string; initials: string }[];
  lastAtMs?: number;
}

/** The "3 replies · last reply 14:02" line under a thread root: undefined when the message has no replies. */
export function replySummary(m: Pick<ChatMessage, "replyCount" | "replyUsers" | "lastReplyAtMs">): ReplySummary | undefined {
  if (!m.replyCount || m.replyCount <= 0) return undefined;
  return { count: m.replyCount, users: m.replyUsers.slice(0, 3).map((u) => ({ id: u.id, name: u.name, initials: initials(u.name) })), lastAtMs: m.lastReplyAtMs ?? undefined };
}

/**
 * The user ids of the people `@Name`-mentioned in a text, in order, without repeats. A token matches a person by full name
 * (accents and case ignored) or, when unambiguous, by one of the name's words (`@Anna`).
 */
export function mentionIds(text: string, people: readonly ChatPerson[]): string[] {
  const out: string[] = [];
  for (const tok of tokenize(text, { known: people.map((p) => p.name) })) {
    if (tok.t !== "mention") continue;
    const key = norm(tok.v.slice(1));
    const full = people.filter((p) => norm(p.name) === key);
    const hits = full.length ? full : people.filter((p) => norm(p.name).split(/\s+/).includes(key));
    if (hits.length === 1 && !out.includes(hits[0]!.id)) out.push(hits[0]!.id);
  }
  return out;
}

export interface MentionQuery {
  /** What was typed after the `@` (may be empty). */
  query: string;
  /** Index of the `@` in the text. */
  start: number;
  /** The caret (end of the token). */
  end: number;
}

/** Detects an in-progress `@par` token ending at the caret, for the mention picker; undefined when the caret is not in one. */
export function mentionQuery(text: string, caret: number): MentionQuery | undefined {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return undefined;
  const prev = upto[at - 1];
  if (prev && !/[\s([{>,;:!?"'-]/u.test(prev)) return undefined;
  const query = upto.slice(at + 1);
  if (query.length > 40 || !/^(?:[\p{L}\p{N}_.\-]+(?: [\p{L}\p{N}_.\-]*)?)?$/u.test(query)) return undefined;
  return { query, start: at, end: caret };
}

/** Replaces the in-progress token with `@Full Name ` and says where the caret goes. */
export function insertMention(text: string, q: MentionQuery, name: string): { text: string; caret: number } {
  const insert = `@${name} `;
  return { text: text.slice(0, q.start) + insert + text.slice(q.end), caret: q.start + insert.length };
}

/** `Anna is typing…`, `Anna and Péter are typing…`, `3 people are typing…`. */
export function typingLine(names: readonly string[]): string {
  const first = (n: string) => n.split(/\s+/)[0] ?? n;
  if (names.length === 0) return "";
  if (names.length === 1) return t("hc.typing.one", { name: first(names[0]!) });
  if (names.length === 2) return t("hc.typing.two", { a: first(names[0]!), b: first(names[1]!) });
  return t("hc.typing.many", { count: names.length });
}

/** Up to two decimals, trailing zeros dropped: `0.02`, `12.5`, `12`. */
export const formatCredits = (n: number): string => String(Math.round(n * 100) / 100);

export const clip = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

// ---- toasts ------------------------------------------------------------------------------------------------------------

export interface ChatNote {
  channelId: string;
  /** `#ops` or `Kovács Anna`. */
  label: string;
  sender: string;
  preview: string;
  mention: boolean;
  direct: boolean;
}

export interface ChatToastView {
  title: string;
  description?: string;
  channelId: string;
  tone: "info" | "warn";
}

/** One toast for what piled up: a single message shows who and what, several say how many and where. */
export function summarizeNotes(notes: readonly ChatNote[]): ChatToastView | undefined {
  if (notes.length === 0) return undefined;
  const first = notes[0]!;
  const channels = new Set(notes.map((n) => n.channelId));
  const mention = notes.some((n) => n.mention);
  if (notes.length === 1) {
    const title = first.direct
      ? t("hc.toast.direct", { sender: first.sender })
      : first.mention
        ? t("hc.toast.mention", { sender: first.sender, label: first.label })
        : t("hc.toast.in", { sender: first.sender, label: first.label });
    return { title, description: first.preview, channelId: first.channelId, tone: first.mention ? "warn" : "info" };
  }
  if (channels.size === 1) {
    return { title: t("hc.toast.many", { count: notes.length, label: first.label }), description: mention ? t("hc.toast.mentioned") : undefined, channelId: first.channelId, tone: mention ? "warn" : "info" };
  }
  const target = notes.find((n) => n.mention) ?? first;
  return { title: t("hc.toast.manyConv", { count: notes.length, channels: channels.size }), description: mention ? t("hc.toast.mentioned") : undefined, channelId: target.channelId, tone: mention ? "warn" : "info" };
}

export interface ToastGate {
  push(note: ChatNote): void;
  /** Drops what is waiting (the user opened the channel, or the provider went off). */
  clear(channelId?: string): void;
  dispose(): void;
}

/**
 * At most one toast per `windowMs`: the first note shows at once, the ones that follow are collected and shown together when
 * the window ends. No toast storm however busy the channels are.
 */
export function createToastGate(opts: { windowMs: number; show: (t: ChatToastView) => void; now?: () => number }): ToastGate {
  const now = opts.now ?? Date.now;
  let lastShown = Number.NEGATIVE_INFINITY;
  let waiting: ChatNote[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const view = summarizeNotes(waiting);
    waiting = [];
    if (view) {
      lastShown = now();
      opts.show(view);
    }
  };
  return {
    push(note) {
      waiting.push(note);
      if (timer) return;
      const wait = lastShown + opts.windowMs - now();
      if (wait <= 0) return flush();
      timer = setTimeout(flush, wait);
    },
    clear(channelId) {
      waiting = channelId ? waiting.filter((n) => n.channelId !== channelId) : [];
      if (waiting.length === 0 && timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    dispose() {
      waiting = [];
      lastShown = Number.NEGATIVE_INFINITY;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

// ---- message actions (UI additions) ---------------------------------------------------------------------------------

/** The emoji the reaction popover offers. */
export const QUICK_REACTIONS: readonly string[] = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🙏", "👀"];

/** An attachment size for its chip: `512 B`, `1.5 KB`, `3.2 MB`. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${Math.round(v * 10) / 10} ${units[i]}`;
}

/** The number on the status-bar bubble and the rail badge: unread messages plus threads with unseen replies. */
export const chatBadgeCount = (s: { unreadTotal: number; threadUnread?: number } | null | undefined): number => (s ? s.unreadTotal + (s.threadUnread ?? 0) : 0);
