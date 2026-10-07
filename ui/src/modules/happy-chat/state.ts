// The Team chat state of the webview. Rust owns the cache and the socket ((design notes: integrations-plan) 2.2); this applies its
// deltas to the few conversations that are open, keeps the user's own optimistic sends, and decides about toasts.
// Nothing here runs unless the chat provider is up: `startChat` is called by the watcher only then. Message bodies are
// never logged.
import { batch, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { ChatChannel, ChatEvent, ChatMember, ChatMessage, ChatPerson, ChatPreferences, ChatSearch, ChatSendOptions, MessageChange, ChatSummary, ThreadSummary } from "../../ipc/happy";
import { activeDockTab, dockVisible, openDockTab } from "../../platform/dock";
import { chatPrefs, happyStatus, providerState } from "../../store/happy";
import { announce, readStored, toast, writeStored } from "../../ui-kit";
import { channelLabel, clip, createToastGate, failMessage, firstUnreadId, isCreditsCode, newClientId, trimWindow, upsertMessage, type ChatToastView } from "./logic";

const KEY_CHANNEL = "intely.chat.channel";
/** Messages kept per open conversation; more history is fetched on demand. */
export const MAX_KEPT = 400;
const TOAST_WINDOW_MS = 10_000;
const TYPING_TTL_MS = 6_000;
const TYPING_EVERY_MS = 3_000;

export interface Convo {
  items: ChatMessage[];
  hasMore: boolean;
  cursor?: string;
  loaded: boolean;
  loading: boolean;
  loadingOlder: boolean;
  error?: string;
  /** The first of the messages that were unread when the conversation was opened; the "New messages" divider sits before it. */
  firstUnreadId?: string;
  /** Newer messages exist beyond the window (it is a jump window, or the newest side was trimmed): `loadNewer` pages forward. */
  hasNewer: boolean;
  loadingNewer: boolean;
  /** Mirrors `hasNewer`: the window is not the newest, so live messages are not appended (show "Jump to latest", call `backToLatest`). */
  jumped: boolean;
  /** The message a jump asked for; the list scrolls to and flashes it, then calls `consumeAnchor`. */
  anchorId?: string;
  /** A live message arrived while `jumped` (it was not appended): the "Jump to latest" pill can say so. */
  newBelow: boolean;
}

/** A thread open in the panel (or kept because it has unsent replies): the root and its replies, oldest first. */
export interface ThreadConvo {
  root?: ChatMessage;
  replies: ChatMessage[];
  loading: boolean;
  error?: string;
  /** The reply to scroll to and flash (from a notification); the panel calls `consumeThreadFocus`. */
  focusId?: string;
}

const emptyConvo = (): Convo => ({ items: [], hasMore: false, loaded: false, loading: false, loadingOlder: false, hasNewer: false, loadingNewer: false, jumped: false, newBelow: false });
const emptyThread = (): ThreadConvo => ({ replies: [], loading: false });

const [summary, setSummary] = createSignal<ChatSummary>();
const [activeId, setActiveIdSignal] = createSignal<string | undefined>(readStored(KEY_CHANNEL) ?? undefined);
const [typingNames, setTypingNames] = createSignal<Record<string, string[]>>({});
const [focused, setFocused] = createSignal(globalThis.document?.hasFocus?.() ?? true);
const [viewing, setViewing] = createSignal<string>();
const [convos, setConvos] = createStore<Record<string, Convo>>({});
const [threadStore, setThreadStore] = createStore<Record<string, ThreadConvo>>({});
const [panel, setPanel] = createSignal<{ channelId: string; rootId: string }>();
const [threadsStore, setThreadsStore] = createStore<{ items: ThreadSummary[]; loading: boolean; error?: string }>({ items: [], loading: false });
const [mainView, setMainView] = createSignal<"channel" | "threads">("channel");
/** Bumped by every reply of the user; the thread panel scrolls to the bottom when it changes. */
const [replyTick, setReplyTick] = createSignal(0);
/** Bumped by every send of the user; the conversation scrolls to the bottom when it changes. */
const [sendTick, setSendTick] = createSignal(0);

export const chatSummary = summary;
export const activeChannelId = activeId;
export const windowFocused = focused;
export const viewingChannel = viewing;
export const sentTick = sendTick;
export const sentReplyTick = replyTick;
/** The thread panel: which thread is open (undefined = closed). */
export const threadPanel = panel;
/** The thread (root + replies) of a root id, while it is open or has unsent replies. */
export const threadOf = (rootId: string): ThreadConvo | undefined => threadStore[rootId];
/** The "Threads" list store: `{ items, loading, error? }`; fill it with `refreshThreads`. */
export const threadsList = threadsStore;
/** What the middle area shows: a channel's conversation or the Threads list. */
export const chatMainView = mainView;
export const setChatMainView = setMainView;
export const convoOf = (id: string): Convo | undefined => convos[id];
export const typingIn = (id: string): string[] => typingNames()[id] ?? [];
export const channelOf = (id: string | undefined): ChatChannel | undefined => (id ? summary()?.channels.find((c) => c.id === id) : undefined);

const UP: ReadonlySet<string> = new Set(["ready", "degraded"]);
/** The provider is switched on, has a token that works, and is not signed out or forbidden. */
export const chatLive = (): boolean => !!happyStatus()?.config.master && !!chatPrefs()?.enabled && UP.has(providerState("chat") ?? "");
export const chatItemVisible = (): boolean => chatLive() && !!chatPrefs()?.showInStatusBar;
export const chatTabShown = (): boolean => dockVisible() && activeDockTab()?.id === "chat";

const me = (): { id: string; name: string } => ({ id: happyStatus()?.user?.id ?? "me", name: happyStatus()?.user?.name ?? t("hc.you") });
export const myName = (): string | undefined => happyStatus()?.user?.name;

/** Selects a conversation (and switches the middle area back to channels; a thread panel of another channel closes). */
export function setActiveChannel(id: string | undefined): void {
  setActiveIdSignal(id);
  if (id) {
    writeStored(KEY_CHANNEL, id);
    setMainView("channel");
    if (panel() && panel()!.channelId !== id) closeThread();
  }
}

// ---- toasts ---------------------------------------------------------------------------------------------------------

const gate = createToastGate({
  windowMs: TOAST_WINDOW_MS,
  show: (view: ChatToastView) =>
    toast.show({ title: view.title, description: view.description, tone: view.tone, duration: 6000, action: { label: t("hc.toast.open"), onSelect: () => openChat(view.channelId) } }),
});

/** Opens the dock on Chat and goes to a conversation (toast action, palette, status bar). */
export function openChat(channelId?: string): void {
  openDockTab("chat");
  if (channelId) {
    setActiveChannel(channelId);
    setScreen("conversation");
  }
}

/** What `openChatAt` was asked for (kept in `pendingChatTarget` until it has been applied). */
export interface ChatTarget {
  channelId: string;
  messageId?: string;
  threadRootId?: string;
}
const [pendingTarget, setPendingTarget] = createSignal<ChatTarget>();
/** The last `openChatAt` target not yet applied (cleared once the jump/thread was started). */
export const pendingChatTarget = pendingTarget;
export const clearPendingTarget = (): void => setPendingTarget(undefined);
/** Jumps asked for a channel whose conversation is not mounted yet: `showChannel` consumes them. */
const jumpTargets = new Map<string, string>();

/**
 * Opens the dock on Chat, selects the channel and, when given, jumps to a message (window around it, anchored: see `Convo.anchorId`)
 * and opens the thread panel of `threadRootId` (the message is then the reply to focus). For notification clicks, toasts, search hits.
 */
export function openChatAt(target: ChatTarget): void {
  setPendingTarget(target);
  openChat(target.channelId);
  const { channelId, messageId, threadRootId } = target;
  if (messageId && !threadRootId) {
    if (viewing() === channelId) void jumpToMessage(channelId, messageId);
    else jumpTargets.set(channelId, messageId);
  }
  if (threadRootId) void openThread(channelId, threadRootId, messageId);
  setPendingTarget(undefined);
}

// Narrow docks show either the list or the conversation; the tab owns the layout, the toast action only asks.
/** Bumped by "Chat: Go to conversation…": the list focuses its search field. */
const [searchTick, setSearchTick] = createSignal(0);
export const listSearchTick = searchTick;
export const focusChatSearch = (): void => {
  openDockTab("chat");
  setScreen("list");
  setSearchTick((n) => n + 1);
};

const [screen, setScreen] = createSignal<"list" | "conversation">(activeId() ? "conversation" : "list");
export const chatScreen = screen;
export const setChatScreen = setScreen;

// ---- loading --------------------------------------------------------------------------------------------------------

const messageOf = (e: unknown): string => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));
const codeOf = (e: unknown): string => (typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code) : "error");

export async function refreshSummary(force = false): Promise<void> {
  try {
    setSummary(await ipc.happy.chat.summary(force));
  } catch {
    /* the provider state already says why (offline, signed out); the list keeps its last content */
  }
}

const loadSeq = new Map<string, number>();

/**
 * The conversation is on screen: load its newest page (Rust learns what is in front from `setActive`, see ChatWatcher). With
 * `opts.aroundId` (or a jump that `openChatAt` queued) it loads the window around that message instead and sets `anchorId`.
 */
export async function showChannel(id: string, opts: { aroundId?: string } = {}): Promise<void> {
  setViewing(id);
  gate.clear(id);
  const aroundId = opts.aroundId ?? jumpTargets.get(id);
  jumpTargets.delete(id);
  const seq = (loadSeq.get(id) ?? 0) + 1;
  loadSeq.set(id, seq);
  if (!convos[id]) setConvos(id, emptyConvo());
  setConvos(id, { loading: true, error: undefined });
  const unread = channelOf(id)?.unreadCount ?? 0;
  try {
    const page = aroundId ? await ipc.happy.chat.around(id, aroundId) : await ipc.happy.chat.open(id);
    if (viewing() !== id || loadSeq.get(id) !== seq) return;
    batch(() => {
      // The user's own unsent messages survive the reload (not into a jump window, which is not the newest).
      const keep = page.hasNewer ? [] : (convos[id]?.items ?? []).filter((m) => m.sendState !== "sent");
      const items = keep.reduce((all, m) => upsertMessage(all, m), page.messages.slice());
      setConvos(id, {
        items,
        hasMore: page.hasMore,
        cursor: page.cursor ?? undefined,
        hasNewer: page.hasNewer,
        jumped: page.hasNewer,
        newBelow: false,
        anchorId: aroundId ? (page.anchorId ?? aroundId) : undefined,
        loaded: true,
        loading: false,
        error: undefined,
        firstUnreadId: aroundId ? undefined : firstUnreadId(page.messages, unread),
      });
    });
  } catch (e) {
    if (viewing() === id && loadSeq.get(id) === seq) setConvos(id, { loading: false, error: messageOf(e) });
  }
}

/** Jump to a message (notification, search hit, pinned message, thread root): loads the window around it and sets `anchorId`; no unread divider. */
export const jumpToMessage = (channelId: string, messageId: string): Promise<void> => showChannel(channelId, { aroundId: messageId });

/** The list scrolled to the jump target: returns it and clears `anchorId` (so the same jump does not repeat). */
export function consumeAnchor(id: string): string | undefined {
  const a = convos[id]?.anchorId;
  if (a) setConvos(id, "anchorId", undefined);
  return a;
}

/** Leaves a jump window: re-opens the channel at its newest page ("Jump to latest"). */
export function backToLatest(id: string): Promise<void> {
  setConvos(id, { anchorId: undefined, hasNewer: false, jumped: false, newBelow: false });
  return showChannel(id);
}

/** The conversation left the screen. */
export function hideChannel(id: string): void {
  if (viewing() !== id) return;
  setViewing(undefined);
  setConvos(id, "firstUnreadId", undefined);
}

const trimmedBelow = (id: string, kept: ChatMessage[]) => setConvos(id, { hasNewer: true, jumped: true, anchorId: undefined, items: kept });

/** Pages back: prepends the older page; when the window then exceeds `MAX_KEPT` the newest side is dropped (`hasNewer`/`jumped` become true). */
export async function loadOlder(id: string): Promise<void> {
  const c = convos[id];
  if (!c || !c.hasMore || !c.cursor || c.loadingOlder) return;
  setConvos(id, "loadingOlder", true);
  try {
    const page = await ipc.happy.chat.older(id, c.cursor);
    batch(() => {
      const merged = page.messages.reduce((all, m) => upsertMessage(all, m), convos[id]!.items);
      const { items, trimmed } = trimWindow(merged, MAX_KEPT, "oldest");
      if (trimmed) trimmedBelow(id, items);
      else setConvos(id, "items", items);
      setConvos(id, { hasMore: page.hasMore, cursor: page.cursor ?? undefined, loadingOlder: false });
    });
  } catch (e) {
    setConvos(id, { loadingOlder: false });
    toast.show({ title: t("hc.toast.loadEarlierFailed"), description: chatErrorText(e), tone: "danger" });
  }
}

/** Pages forward from a jump window: appends the next page; reaching the end clears `hasNewer`/`jumped`. Trims the oldest side past `MAX_KEPT`. */
export async function loadNewer(id: string): Promise<void> {
  const c = convos[id];
  if (!c || !c.hasNewer || c.loadingNewer) return;
  const after = c.items.filter((m) => m.sendState === "sent").at(-1)?.id;
  if (!after) return;
  setConvos(id, "loadingNewer", true);
  try {
    const page = await ipc.happy.chat.newer(id, after);
    batch(() => {
      const merged = page.messages.reduce((all, m) => upsertMessage(all, m), convos[id]!.items);
      const { items, trimmed } = trimWindow(merged, MAX_KEPT, "newest");
      setConvos(id, { items, hasNewer: page.hasNewer, jumped: page.hasNewer, loadingNewer: false });
      if (!page.hasNewer) setConvos(id, "newBelow", false);
      if (trimmed) setConvos(id, { hasMore: true, cursor: items[0]?.id });
    });
  } catch (e) {
    setConvos(id, { loadingNewer: false });
    toast.show({ title: t("hc.toast.loadNewerFailed"), description: chatErrorText(e), tone: "danger" });
  }
}

const lastMarked = new Map<string, string>();

/** Tells the server everything up to now is read. Cheap to call repeatedly: it only talks when something is unread. */
export function markRead(id: string): void {
  const newest = convos[id]?.items.filter((m) => m.sendState === "sent").at(-1)?.id;
  const unread = channelOf(id)?.unreadCount ?? 0;
  if (!unread && (!newest || lastMarked.get(id) === newest)) return;
  if (newest) lastMarked.set(id, newest);
  // Optimistic: the badge goes at once; Rust's summary event confirms it.
  setSummary((s) => (s ? withChannel(s, id, (c) => ({ ...c, unreadCount: 0, mentionCount: 0 })) : s));
  void ipc.happy.chat.markRead(id).catch(() => {
    lastMarked.delete(id);
  });
}

function recount(s: ChatSummary, channels: ChatChannel[]): ChatSummary {
  return {
    ...s,
    channels,
    unreadTotal: channels.filter((c) => c.isMember).reduce((n, c) => n + (c.muted ? 0 : c.unreadCount), 0),
    mentionTotal: channels.filter((c) => c.isMember).reduce((n, c) => n + c.mentionCount, 0),
  };
}

function withChannel(s: ChatSummary, id: string, f: (c: ChatChannel) => ChatChannel): ChatSummary {
  return recount(s, s.channels.map((c) => (c.id === id ? f(c) : c)));
}

/** Puts a channel the server sent into the summary (replaces the same id, else appends). */
function putChannel(channel: ChatChannel): void {
  setSummary((s) => (s ? recount(s, s.channels.some((c) => c.id === channel.id) ? s.channels.map((c) => (c.id === channel.id ? channel : c)) : [...s.channels, channel]) : s));
}

// ---- events ---------------------------------------------------------------------------------------------------------

const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setTyping(channelId: string, names: string[]): void {
  clearTimeout(typingTimers.get(channelId));
  setTypingNames((t) => ({ ...t, [channelId]: names }));
  if (names.length) typingTimers.set(channelId, setTimeout(() => setTyping(channelId, []), TYPING_TTL_MS));
}

const sameMessage = (a: ChatMessage, b: ChatMessage): boolean => a.id === b.id || (!!b.clientMessageId && a.clientMessageId === b.clientMessageId);

/**
 * Applies one Rust event. A message with `threadRoot` belongs to that thread only (never to a channel list, never bumps
 * anything of the channel). An `updated`/`deleted`/`failed` message the webview does not hold is ignored; a `new` one is inserted,
 * except while the window is a jump window (`hasNewer`): then it is not appended but `newBelow` is set.
 */
export function applyEvent(ev: ChatEvent): void {
  switch (ev.type) {
    case "summary":
      setSummary(ev.summary);
      return;
    case "link":
      setSummary((s) => (s ? { ...s, link: ev.link } : s));
      return;
    case "typing":
      setTyping(ev.channelId, ev.names.filter((n) => n !== myName()));
      return;
    case "message": {
      const { channelId, message, change } = ev;
      const incoming = change === "deleted" ? { ...message, deleted: true } : message;
      if (message.threadRoot) applyReply(message.threadRoot, incoming, change);
      else {
        applyTopLevel(channelId, incoming, change);
        if (change !== "new") syncRoot(message);
      }
      if (change === "new" && ev.notify && !message.mine) note(message);
      // Screen readers hear a message that arrives in the conversation in front (the list itself does not announce).
      if (change === "new" && !message.mine && !message.threadRoot && viewing() === channelId) announce(`${message.senderName}: ${clip(message.text, 120)}`);
      if (change === "new" && !message.mine && message.threadRoot && panel()?.rootId === message.threadRoot) announce(`${message.senderName}: ${clip(message.text, 120)}`);
      return;
    }
  }
}

function applyTopLevel(channelId: string, incoming: ChatMessage, change: MessageChange): void {
  const c = convos[channelId];
  if (!c?.loaded) return;
  const exists = c.items.some((m) => sameMessage(m, incoming));
  const adds = change === "new" || change === "replaced";
  if (!exists && !adds) return;
  if (!exists && c.hasNewer) {
    if (change === "new" && !incoming.mine) setConvos(channelId, "newBelow", true);
    return;
  }
  setConvos(channelId, "items", (items) => {
    const { items: kept, trimmed } = trimWindow(upsertMessage(items, incoming), MAX_KEPT, "newest");
    if (trimmed) queueMicrotask(() => setConvos(channelId, { hasMore: true, cursor: kept[0]?.id }));
    return kept;
  });
}

/** A root message changed (reply count, reactions, edit): keep the thread panel's and the Threads list's copy of it in sync. */
function syncRoot(root: ChatMessage): void {
  if (threadStore[root.id]?.root) setThreadStore(root.id, "root", root);
  if (threadsStore.items.some((i) => i.root.id === root.id)) {
    setThreadsStore("items", (i) => i.root.id === root.id, produce((i) => {
      i.root = root;
      i.replyCount = root.replyCount;
      i.lastReplyAtMs = root.lastReplyAtMs;
    }));
  }
}

function applyReply(rootId: string, incoming: ChatMessage, change: string): void {
  const th = threadStore[rootId];
  if (th) {
    const exists = th.replies.some((m) => sameMessage(m, incoming));
    if (exists || change === "new" || change === "replaced") setThreadStore(rootId, "replies", (list) => upsertMessage(list, incoming));
  }
  if (change === "new" && !incoming.mine && panel()?.rootId !== rootId) {
    if (threadsStore.items.some((i) => i.root.id === rootId)) setThreadsStore("items", (i) => i.root.id === rootId, "unreadCount", (n) => n + 1);
  }
  if (change === "new" && !incoming.mine && panel()?.rootId === rootId) markOpenThreadRead(rootId);
}

const READ_DEBOUNCE_MS = 500;
let readTimer: ReturnType<typeof setTimeout> | undefined;

/** A reply landed in the open thread: while the user is looking at it, re-reading it (the GET marks it read) keeps it from counting itself unread. */
function markOpenThreadRead(rootId: string): void {
  if (threadsStore.items.some((i) => i.root.id === rootId && i.unreadCount)) setThreadsStore("items", (i) => i.root.id === rootId, "unreadCount", 0);
  clearTimeout(readTimer);
  readTimer = setTimeout(() => {
    if (panel()?.rootId !== rootId || !focused()) return;
    ipc.happy.chat.thread(rootId).catch(() => {});
  }, READ_DEBOUNCE_MS);
}

function note(m: ChatMessage): void {
  if (m.threadRoot) {
    if (panel()?.rootId === m.threadRoot && focused()) return;
  } else if (viewing() === m.channelId && focused()) return;
  const c = channelOf(m.channelId);
  gate.push({
    channelId: m.channelId,
    label: c ? channelLabel(c) : "a conversation",
    sender: m.senderName,
    preview: clip(m.text, 90),
    mention: m.mentionsMe,
    direct: c?.kind === "direct" || c?.kind === "group",
  });
}

// ---- sending --------------------------------------------------------------------------------------------------------

const extrasOf = new Map<string, ChatSendOptions | undefined>();

/** Where a message of the user lives: a channel's list, or a thread's replies. */
interface Slot {
  channelId: string;
  rootId?: string;
}

function editList(slot: Slot, f: (items: ChatMessage[]) => ChatMessage[]): void {
  if (slot.rootId) {
    if (!threadStore[slot.rootId]) setThreadStore(slot.rootId, emptyThread());
    setThreadStore(slot.rootId, "replies", f);
  } else {
    if (!convos[slot.channelId]) setConvos(slot.channelId, emptyConvo());
    setConvos(slot.channelId, "items", f);
  }
}
const listOf = (slot: Slot): ChatMessage[] => (slot.rootId ? threadStore[slot.rootId]?.replies : convos[slot.channelId]?.items) ?? [];

function localMessage(slot: Slot, cid: string, body: string): ChatMessage {
  const who = me();
  return {
    id: `local:${cid}`,
    channelId: slot.channelId,
    clientMessageId: cid,
    senderId: who.id,
    senderName: who.name,
    text: body,
    createdAtMs: Date.now(),
    edited: false,
    deleted: false,
    system: false,
    mine: true,
    mentionsMe: false,
    sendState: "pending",
    kind: "text",
    threadRoot: slot.rootId ?? null,
    replyCount: 0,
    replyUsers: [],
    reactions: [],
    attachments: [],
    pinned: false,
  };
}

/** Optimistic send: the message shows at once as pending, then becomes sent (or failed with Retry). Resolves true when it was accepted. */
export async function sendMessage(channelId: string, text: string, extras?: ChatSendOptions): Promise<boolean> {
  const body = text.trim();
  if (!body) return false;
  // A message of the user cannot be appended to a window that is not the newest: go back to the latest first.
  if (convos[channelId]?.jumped) void backToLatest(channelId);
  const cid = newClientId();
  const slot: Slot = { channelId };
  extrasOf.set(cid, extras);
  batch(() => {
    editList(slot, (items) => upsertMessage(items, localMessage(slot, cid, body)));
    setSendTick((n) => n + 1);
  });
  return dispatch(slot, cid, body, extras);
}

/** Optimistic thread reply (same flow as `sendMessage`, into `threadOf(rootId).replies`); `mentions` are the user ids from `mentionIds`. */
export async function sendReply(channelId: string, rootId: string, text: string, mentions?: string[]): Promise<boolean> {
  const body = text.trim();
  if (!body) return false;
  const cid = newClientId();
  const slot: Slot = { channelId, rootId };
  const options: ChatSendOptions = { threadRootId: rootId, mentions: mentions?.length ? mentions : undefined };
  extrasOf.set(cid, options);
  batch(() => {
    editList(slot, (items) => upsertMessage(items, localMessage(slot, cid, body)));
    setReplyTick((n) => n + 1);
  });
  return dispatch(slot, cid, body, options);
}

async function dispatch(slot: Slot, cid: string, body: string, options?: ChatSendOptions): Promise<boolean> {
  try {
    const sent = await ipc.happy.chat.send(slot.channelId, body, cid, options);
    editList(slot, (items) => upsertMessage(items, { ...sent, clientMessageId: sent.clientMessageId ?? cid }));
    if (sent.sendState !== "failed") extrasOf.delete(cid);
    setSummary((s) => (s && s.creditsEmpty ? { ...s, creditsEmpty: false } : s));
    return sent.sendState !== "failed";
  } catch (e) {
    const code = codeOf(e);
    editList(slot, (items) => failMessage(items, cid, code));
    if (isCreditsCode(code)) setSummary((s) => (s ? { ...s, creditsEmpty: true } : s));
    return false;
  }
}

/** Sends a failed message again with the same client id (the server de-duplicates). A reply needs its `threadRootId`. */
export function retryMessage(channelId: string, cid: string, threadRootId?: string): void {
  const slot: Slot = { channelId, rootId: threadRootId };
  const m = listOf(slot).find((x) => x.clientMessageId === cid);
  if (!m || m.sendState !== "failed") return;
  editList(slot, (items) => items.map((x) => (x.clientMessageId === cid ? { ...x, sendState: "pending" as const, errorCode: undefined } : x)));
  void dispatch(slot, cid, m.text, extrasOf.get(cid) ?? (threadRootId ? { threadRootId } : undefined));
}

/** Drops an unsent (pending/failed) message; a reply needs its `threadRootId`. */
export function discardMessage(channelId: string, cid: string, threadRootId?: string): void {
  extrasOf.delete(cid);
  editList({ channelId, rootId: threadRootId }, (items) => items.filter((x) => !(x.clientMessageId === cid && x.sendState !== "sent")));
}

let typingSentAt = 0;
/** Tells the others the user is typing, at most every 3 seconds. */
export function notifyTyping(channelId: string): void {
  const t = Date.now();
  if (t - typingSentAt < TYPING_EVERY_MS) return;
  typingSentAt = t;
  void ipc.happy.chat.typing(channelId).catch(() => {});
}

// ---- threads --------------------------------------------------------------------------------------------------------

/**
 * Opens the thread panel on a root message: shows what is known at once, loads the replies (the server marks the thread read),
 * and keeps the root in sync with `updated` events. `focusMessageId` is the reply to scroll to (`ThreadConvo.focusId`).
 */
export async function openThread(channelId: string, rootId: string, focusMessageId?: string): Promise<void> {
  const known = convos[channelId]?.items.find((m) => m.id === rootId);
  const prev = panel();
  batch(() => {
    // Switching from another thread: its store entry is dropped like on close (unless it holds unsent replies).
    if (prev && prev.rootId !== rootId) closeThread();
    setPanel({ channelId, rootId });
    if (!threadStore[rootId]) setThreadStore(rootId, emptyThread());
    setThreadStore(rootId, { loading: true, error: undefined, focusId: focusMessageId });
    if (known && !threadStore[rootId]?.root) setThreadStore(rootId, "root", known);
    // The unread badge goes at once; Rust's summary event confirms it.
    const item = threadsStore.items.find((i) => i.root.id === rootId);
    if (item?.unreadCount) {
      setThreadsStore("items", (i) => i.root.id === rootId, "unreadCount", 0);
      setSummary((s) => (s && s.threadUnread > 0 ? { ...s, threadUnread: s.threadUnread - 1 } : s));
    }
  });
  try {
    const view = await ipc.happy.chat.thread(rootId);
    const keep = (threadStore[rootId]?.replies ?? []).filter((m) => m.sendState !== "sent");
    const replies = keep.reduce((all, m) => upsertMessage(all, m), view.replies.slice());
    setThreadStore(rootId, { root: view.root, replies, loading: false, error: undefined });
  } catch (e) {
    setThreadStore(rootId, { loading: false, error: chatErrorText(e) });
  }
}

/** The reply to focus has been scrolled to: returns it and clears `focusId`. */
export function consumeThreadFocus(rootId: string): string | undefined {
  const f = threadStore[rootId]?.focusId;
  if (f) setThreadStore(rootId, "focusId", undefined);
  return f;
}

/** Closes the thread panel (the thread's data is dropped unless it holds unsent replies). */
export function closeThread(): void {
  const open = panel();
  if (!open) return;
  setPanel(undefined);
  const th = threadStore[open.rootId];
  if (th && th.replies.every((m) => m.sendState === "sent")) setThreadStore(produce((all) => void delete all[open.rootId]));
}

/** Fills `threadsList` with the threads the user takes part in (`unreadOnly` keeps those with news). */
export async function refreshThreads(unreadOnly = false): Promise<void> {
  setThreadsStore({ loading: true, error: undefined });
  try {
    const items = await ipc.happy.chat.threads(unreadOnly);
    setThreadsStore({ items, loading: false });
  } catch (e) {
    setThreadsStore({ loading: false, error: chatErrorText(e) });
  }
}

// ---- errors ---------------------------------------------------------------------------------------------------------

/** A rejection already turned into a friendly, translated message (`message`) that keeps the server's `code`. */
export class ChatActionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ChatActionError";
    this.code = code;
  }
}

const errorText = (code: string): string | undefined => {
  switch (code) {
    case "CREATE_FORBIDDEN": return t("hc.err.CREATE_FORBIDDEN");
    case "CHANNEL_NAME_TAKEN": return t("hc.err.CHANNEL_NAME_TAKEN");
    case "NAME_REQUIRED": return t("hc.err.NAME_REQUIRED");
    case "MANAGE_FORBIDDEN": return t("hc.err.MANAGE_FORBIDDEN");
    case "DIRECT_IMMUTABLE": return t("hc.err.DIRECT_IMMUTABLE");
    case "USERS_REQUIRED": return t("hc.err.USERS_REQUIRED");
    case "TEAM_CHAT_NOT_ENABLED": return t("hc.err.TEAM_CHAT_NOT_ENABLED");
    case "RATE_LIMITED": return t("hc.err.RATE_LIMITED");
    case "forbidden": return t("hc.err.forbidden");
    case "notFound": return t("hc.err.notFound");
    case "validation": return t("hc.err.validation");
    default: return undefined;
  }
};

/** Any rejection as a translated sentence: the known server codes map to `hc.err.<code>`, anything else to its own message or a generic line. */
export function chatErrorText(e: unknown): string {
  if (e instanceof ChatActionError) return e.message;
  const code = codeOf(e);
  if (isCreditsCode(code)) return t("hc.err.INSUFFICIENT_CREDITS");
  const known = errorText(code);
  if (known) return known;
  const m = typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : "";
  return m || t("hc.err.generic");
}

const friendly = (e: unknown): ChatActionError => (e instanceof ChatActionError ? e : new ChatActionError(codeOf(e), chatErrorText(e)));
/** Runs an IPC call and rethrows its rejection as a `ChatActionError` with the translated text. */
async function act<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw friendly(e);
  }
}

// ---- actions (every one rejects with a ChatActionError whose `message` is ready to show) ---------------------------------

const selectChannel = (id: string): void => {
  setActiveChannel(id);
  setScreen("conversation");
};

/** Creates a channel (public, or private with `private: true`), adds it to the list and opens it. Rejects `CREATE_FORBIDDEN`, `CHANNEL_NAME_TAKEN`, `NAME_REQUIRED`. */
export const createChannel = (input: { name: string; description?: string; private?: boolean; memberIds?: string[] }): Promise<ChatChannel> =>
  act(async () => {
    const channel = await ipc.happy.chat.createChannel(input);
    putChannel(channel);
    selectChannel(channel.id);
    return channel;
  });

/** Public channels the user has not joined (for the Browse dialog). */
export const browseChannels = (query = ""): Promise<ChatChannel[]> => act(() => ipc.happy.chat.browse(query));

/** Joins a public channel, adds it to the list and opens it. */
export const joinChannel = (id: string): Promise<ChatChannel> =>
  act(async () => {
    const channel = await ipc.happy.chat.join(id);
    putChannel(channel);
    selectChannel(channel.id);
    return channel;
  });

/** Leaves a channel: it leaves the list, its data is dropped and, when it was open, another channel (else the list) takes over. */
export const leaveChannel = (id: string): Promise<void> =>
  act(async () => {
    await ipc.happy.chat.leave(id);
    forgetChannel(id);
  });

function forgetChannel(id: string): void {
  batch(() => {
    if (panel()?.channelId === id) closeThread();
    setSummary((s) => (s ? recount(s, s.channels.filter((c) => c.id !== id)) : s));
    setConvos(produce((all) => void delete all[id]));
    if (activeId() === id) {
      const rest = (summary()?.channels ?? []).filter((c) => c.isMember && !c.archived);
      const next = rest.find((c) => c.kind === "channel") ?? rest[0];
      setActiveIdSignal(next?.id);
      if (next) writeStored(KEY_CHANNEL, next.id);
      else setScreen("list");
    }
  });
}

/** The members of a channel (for the members panel and the invite dialog). */
export const channelMembers = (id: string): Promise<ChatMember[]> => act(() => ipc.happy.chat.members(id));

/** Invites people into a channel; resolves with the ones added. Rejects `DIRECT_IMMUTABLE` (direct/group), `MANAGE_FORBIDDEN` (private channel, not admin), `USERS_REQUIRED`. */
export const inviteMembers = (id: string, userIds: string[]): Promise<ChatMember[]> =>
  act(async () => {
    const added = await ipc.happy.chat.addMembers(id, userIds);
    if (added.length) await syncMemberCount(id);
    return added;
  });

/** Removes a member (the user's own id = leaving the channel). */
export const removeMember = (id: string, userId: string): Promise<void> =>
  act(async () => {
    await ipc.happy.chat.removeMember(id, userId);
    if (userId === me().id) forgetChannel(id);
    else await syncMemberCount(id);
  });

/** The member count of the list follows the real member list (idempotent, so a summary event arriving as well cannot double it). */
async function syncMemberCount(id: string): Promise<void> {
  try {
    const n = (await ipc.happy.chat.members(id)).length;
    setSummary((s) => (s ? withChannel(s, id, (c) => ({ ...c, memberCount: n })) : s));
  } catch {
    /* the next summary event carries the count */
  }
}

/** Edits a message of the user (channel message or thread reply); the lists update at once. */
export const editMessage = (messageId: string, text: string): Promise<ChatMessage> =>
  act(async () => {
    const m = await ipc.happy.chat.edit(messageId, text);
    applyEvent({ type: "message", channelId: m.channelId, message: m, change: "updated", notify: false });
    return m;
  });

/** Deletes a message of the user; it stays in the list as a "message deleted" stub. `threadRootId` for a thread reply. */
export const deleteMessage = (channelId: string, messageId: string, threadRootId?: string): Promise<void> =>
  act(async () => {
    await ipc.happy.chat.remove(channelId, messageId, threadRootId);
    const found = (threadRootId ? threadStore[threadRootId]?.replies : convos[channelId]?.items)?.find((m) => m.id === messageId);
    if (found) applyEvent({ type: "message", channelId, message: { ...found, deleted: true, text: "", reactions: [], pinned: false }, change: "deleted", notify: false });
  });

/** Toggles the user's emoji reaction on a message. */
export const toggleReaction = (messageId: string, emoji: string): Promise<ChatMessage> =>
  act(async () => {
    const m = await ipc.happy.chat.react(messageId, emoji);
    applyEvent({ type: "message", channelId: m.channelId, message: m, change: "updated", notify: false });
    return m;
  });

/** Pins / unpins a message. */
export const pinMessage = (messageId: string, pinned: boolean): Promise<ChatMessage> =>
  act(async () => {
    const m = await ipc.happy.chat.pin(messageId, pinned);
    applyEvent({ type: "message", channelId: m.channelId, message: m, change: "updated", notify: false });
    return m;
  });

/** Server-side search (needs 2+ characters); `channelId` limits it to one channel. */
export const searchChat = (query: string, channelId?: string): Promise<ChatSearch> => act(() => ipc.happy.chat.search(query, channelId));

/** Notification level / mute / star of a channel for the user; the list updates at once. */
export const setChannelPreferences = (id: string, prefs: ChatPreferences): Promise<ChatChannel> =>
  act(async () => {
    const channel = await ipc.happy.chat.setPreferences(id, prefs);
    putChannel(channel);
    return channel;
  });

/** Changes name / description / topic of a channel. Rejects `MANAGE_FORBIDDEN`, `CHANNEL_NAME_TAKEN`, `NAME_REQUIRED`, `DIRECT_IMMUTABLE`. */
export const updateChannelInfo = (id: string, patch: { name?: string; description?: string; topic?: string }): Promise<ChatChannel> =>
  act(async () => {
    const channel = await ipc.happy.chat.updateChannel(id, patch);
    putChannel(channel);
    return channel;
  });

// ---- drafts (memory only) ------------------------------------------------------------------------------------------

const drafts = new Map<string, string>();
export const getDraft = (id: string): string => drafts.get(id) ?? "";
export function setDraft(id: string, text: string): void {
  if (text) drafts.set(id, text);
  else drafts.delete(id);
}

// ---- people ----------------------------------------------------------------------------------------------------------

export const searchPeople = (query: string): Promise<ChatPerson[]> => ipc.happy.chat.people(query);

/**
 * Starts (or finds) the direct conversation with a person, or a group conversation with 2 to 7 people, and opens it. A failure
 * shows a toast and resolves undefined.
 */
export async function openDirect(personIds: string | string[]): Promise<ChatChannel | undefined> {
  try {
    const channel = await ipc.happy.chat.direct(personIds);
    putChannel(channel);
    selectChannel(channel.id);
    return channel;
  } catch (e) {
    toast.show({ title: t("hc.toast.openConvFailed"), description: chatErrorText(e), tone: "danger" });
    return undefined;
  }
}

// ---- lifecycle ---------------------------------------------------------------------------------------------------------

let stop: (() => void) | undefined;

/** Subscribes to the chat events and reads the summary. Idempotent; the disposer also forgets everything (memory is freed when chat goes off). */
export function startChat(): () => void {
  if (stop) return stop;
  const off = ipc.happy.chat.onEvent(applyEvent);
  const onFocus = () => setFocused(true);
  const onBlur = () => setFocused(false);
  globalThis.addEventListener?.("focus", onFocus);
  globalThis.addEventListener?.("blur", onBlur);
  setFocused(globalThis.document?.hasFocus?.() ?? true);
  void refreshSummary();
  stop = () => {
    off();
    globalThis.removeEventListener?.("focus", onFocus);
    globalThis.removeEventListener?.("blur", onBlur);
    resetChat();
    stop = undefined;
  };
  return stop;
}

export function resetChat(): void {
  gate.dispose();
  typingTimers.forEach((t) => clearTimeout(t));
  typingTimers.clear();
  lastMarked.clear();
  extrasOf.clear();
  jumpTargets.clear();
  loadSeq.clear();
  drafts.clear();
  batch(() => {
    setSummary(undefined);
    setTypingNames({});
    setViewing(undefined);
    setPanel(undefined);
    setMainView("channel");
    setPendingTarget(undefined);
    setConvos(produce((all) => Object.keys(all).forEach((k) => delete all[k])));
    setThreadStore(produce((all) => Object.keys(all).forEach((k) => delete all[k])));
    setThreadsStore({ items: [], loading: false, error: undefined });
  });
}
