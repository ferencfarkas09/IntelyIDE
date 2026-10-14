import { createSignal } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { TeamChatMsg } from "../../ipc/team";
import { agentRows } from "../../store/agents";
import { messageOf } from "./store";

// Chat in a shared run: human to human, never given to the agent. The owner of the run keeps the thread; this store holds what this
// install has seen of it, the messages it sent that the owner has not echoed yet, and the unread counts.
export const CHAT_MAX = 2000;
/** The owner keeps 200 messages per run; the view does the same. */
const KEEP = 200;
const BANNER_CHARS = 140;
/** A thread raises at most one banner per this long: its unread count still grows, but nobody can flood the screen. */
const BANNER_GAP_MS = 20_000;
/** A message the owner's machine took but never echoed is called lost after this long. */
const ECHO_WAIT_MS = 30_000;

/** A message this install sent that has no echo yet (`msgId` is set once the owner's machine took it), or that was refused. */
export interface Outgoing {
  localId: string;
  msgId?: string;
  text: string;
  at: number;
  /** Why it did not go through: a denial reason (`rate`, `offline`, ...) or the failure's text. */
  failed?: string;
}

const [threads, setThreads] = createSignal<Record<string, TeamChatMsg[]>>({});
const [outbox, setOutbox] = createSignal<Record<string, Outgoing[]>>({});
const [unread, setUnread] = createSignal<Record<string, number>>({});

export { threads, outbox, unread };

/** `ownerId` is null for a run of this install. */
export const chatKey = (ownerId: string | null, runId: string) => `${ownerId ?? "-"}:${runId}`;

let watching: (() => void) | undefined;
const openPanels = new Map<string, number>();
const requested = new Set<string>();
/** Threads whose history could not be asked for because the owner was offline: asked again when they come online. */
const retry = new Map<string, { ownerId: string; runId: string }>();
const lastBanner = new Map<string, number>();
const echoTimers = new Set<ReturnType<typeof setTimeout>>();
let localSeq = 0;

const patch = <T>(set: (f: (o: Record<string, T>) => Record<string, T>) => void, key: string, f: (old: T | undefined) => T | undefined) =>
  set((o) => {
    const next = { ...o };
    const v = f(o[key]);
    if (v === undefined) delete next[key];
    else next[key] = v;
    return next;
  });

/** Adds messages (no doubles, oldest first, at most 200) and drops the outgoing ones they echo. */
function merge(key: string, msgs: TeamChatMsg[]): void {
  patch(setThreads, key, (have = []) => [...have, ...msgs.filter((m) => !have.some((x) => x.msgId === m.msgId))].sort((a, b) => a.at - b.at).slice(-KEEP));
  patch(setOutbox, key, (list) => {
    const rest = (list ?? []).filter((o) => !(o.msgId && msgs.some((m) => m.msgId === o.msgId)));
    return rest.length ? rest : undefined;
  });
}

/** A banner through the existing notify gate, like the one for a note. Never throws. */
function announce(ownerId: string | null, runId: string, m: TeamChatMsg): void {
  const text = m.text.length > BANNER_CHARS ? `${m.text.slice(0, BANNER_CHARS)}...` : m.text;
  const name = m.authorName || t("team.chat.former");
  // only a run of this install is a run the banner can lead back to
  const title = ownerId === null ? agentRows().find((r) => r.agentId === runId)?.title : undefined;
  void ipc.notify.show({ kind: "question", title: t("team.chat.banner", { name, text }), body: t("team.chat.bannerBody"), runId: ownerId === null ? runId : undefined, subtitle: title }).catch(() => undefined);
}

/** Listens for new messages and refusals. Once per page; nothing is read before somebody looks at the Team view or a shared run. */
export function watchChat(): void {
  if (watching) return;
  const offChat = ipc.team.onChat((e) => {
    const key = chatKey(e.ownerId, e.runId);
    merge(key, e.msgs);
    if (e.history) return;
    const others = e.msgs.filter((m) => !m.mine);
    if (others.length === 0 || openPanels.has(key)) return;
    patch(setUnread, key, (n = 0) => n + others.length);
    const now = Date.now();
    if (now - (lastBanner.get(key) ?? 0) < BANNER_GAP_MS) return;
    lastBanner.set(key, now);
    announce(e.ownerId, e.runId, others[others.length - 1]);
  });
  const offDenied = ipc.team.onChatDenied((e) => {
    patch(setOutbox, chatKey(e.ownerId, e.runId), (list) => list?.map((o) => (o.msgId === e.msgId ? { ...o, failed: e.reason } : o)));
  });
  const offPresence = ipc.team.onPresence((p) => {
    if (!p.online) return;
    for (const [key, w] of [...retry]) {
      if (w.ownerId !== p.id) continue;
      retry.delete(key);
      requested.delete(key);
      void loadThread(w.ownerId, w.runId);
    }
  });
  watching = () => (offChat(), offDenied(), offPresence());
}

/** Reads the thread this install has, and asks the owner for the rest the first time a teammate's run is opened. Never throws. */
export async function loadThread(ownerId: string | null, runId: string): Promise<void> {
  watchChat();
  const key = chatKey(ownerId, runId);
  try {
    merge(key, await ipc.team.chatThread(ownerId, runId));
  } catch {
    /* no team yet */
  }
  if (ownerId === null || requested.has(key)) return;
  requested.add(key);
  // the answer arrives as an event with `history: true`; an offline owner simply does not answer, what was loaded stays readable
  void ipc.team.chatRequest(ownerId, runId).catch(() => {
    requested.delete(key);
    retry.set(key, { ownerId, runId });
  });
}

/** The panel of a thread is on screen: its messages count as read and no banner is raised for it. Returns the "closed" call. */
export function markChatOpen(ownerId: string | null, runId: string): () => void {
  const key = chatKey(ownerId, runId);
  openPanels.set(key, (openPanels.get(key) ?? 0) + 1);
  patch(setUnread, key, () => undefined);
  return () => {
    const n = (openPanels.get(key) ?? 1) - 1;
    if (n <= 0) openPanels.delete(key);
    else openPanels.set(key, n);
  };
}

export const unreadOf = (ownerId: string | null, runId: string): number => unread()[chatKey(ownerId, runId)] ?? 0;

/** Posts to the thread. The message shows as "sending" until its echo arrives. Resolves true when the owner's machine took it. */
export async function sendChat(ownerId: string | null, runId: string, text: string): Promise<boolean> {
  watchChat();
  const key = chatKey(ownerId, runId);
  const item: Outgoing = { localId: `l${++localSeq}`, text, at: Date.now() };
  patch(setOutbox, key, (list = []) => [...list, item]);
  try {
    const msgId = await ipc.team.chatSend(ownerId, runId, text);
    // the echo can beat the answer: then there is nothing left to wait for
    if (threads()[key]?.some((m) => m.msgId === msgId)) patch(setOutbox, key, (list) => list?.filter((o) => o.localId !== item.localId));
    else {
      patch(setOutbox, key, (list) => list?.map((o) => (o.localId === item.localId ? { ...o, msgId } : o)));
      // an owner that drops the message without a word must not leave it "sending" for ever
      const timer = setTimeout(() => {
        echoTimers.delete(timer);
        patch(setOutbox, key, (list) => list?.map((o) => (o.localId === item.localId && !o.failed ? { ...o, failed: "timeout" } : o)));
      }, ECHO_WAIT_MS);
      echoTimers.add(timer);
    }
    return true;
  } catch (e) {
    patch(setOutbox, key, (list) => list?.map((o) => (o.localId === item.localId ? { ...o, failed: (e as { code?: string } | null)?.code === "offline" ? "offline" : messageOf(e) } : o)));
    return false;
  }
}

/** Removes a refused message from the list. */
export function dismissOutgoing(ownerId: string | null, runId: string, localId: string): void {
  patch(setOutbox, chatKey(ownerId, runId), (list) => {
    const rest = list?.filter((o) => o.localId !== localId);
    return rest?.length ? rest : undefined;
  });
}

/** Tests: forget everything and the watchers. */
export function resetChat(): void {
  watching?.();
  watching = undefined;
  openPanels.clear();
  requested.clear();
  retry.clear();
  lastBanner.clear();
  for (const timer of echoTimers) clearTimeout(timer);
  echoTimers.clear();
  setThreads({});
  setOutbox({});
  setUnread({});
}
