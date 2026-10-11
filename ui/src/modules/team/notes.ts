import { createSignal } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { TeamNoteIn, TeamSentNote } from "../../ipc/team";
import { agentRows } from "../../store/agents";
import { messageOf } from "./store";

// Notes into a run (T3). Owner side: notes that wait for a decision. Sender side: the notes this install sent and where each stands.
const [pending, setPending] = createSignal<TeamNoteIn[]>([]);
const [sent, setSent] = createSignal<TeamSentNote[]>([]);

export { pending, sent };

const BANNER_CHARS = 140;
let watching: (() => void) | undefined;
let readOnce = false;

const upsertSent = (n: TeamSentNote) => setSent((all) => [...all.filter((x) => !(x.memberId === n.memberId && x.noteId === n.noteId)), n]);

/** A banner through the existing notify gate (kind switches, throttle, focus rule). Never throws. */
function announce(n: TeamNoteIn): void {
  const text = n.text.length > BANNER_CHARS ? `${n.text.slice(0, BANNER_CHARS)}...` : n.text;
  const title = agentRows().find((r) => r.agentId === n.runId)?.title;
  void ipc.notify.show({ kind: "question", title: t("team.note.banner", { name: n.memberName, text }), body: n.auto ? t("team.note.bannerAuto") : t("team.note.bannerAsk"), runId: n.runId, subtitle: title }).catch(() => undefined);
}

function watch(): void {
  if (watching) return;
  const offIn = ipc.team.onNoteIn((n) => {
    if (!n.auto) setPending((all) => (all.some((x) => x.memberId === n.memberId && x.noteId === n.noteId) ? all : [...all, n]));
    announce(n);
  });
  const offStatus = ipc.team.onNoteStatus(upsertSent);
  watching = () => (offIn(), offStatus());
}

/** Reads the notes that wait for a decision and follows new ones. Safe to call again. */
export async function loadNotes(): Promise<void> {
  watch();
  if (readOnce) return;
  readOnce = true;
  try {
    const have = await ipc.team.pendingNotes();
    // a note that arrived while this was loading is already on the list
    setPending((all) => [...have.filter((n) => !all.some((x) => x.memberId === n.memberId && x.noteId === n.noteId)), ...all]);
  } catch {
    readOnce = false; /* no team yet */
  }
}

/** Accept hands the note to the run; reject tells the sender. The card goes either way; a failure is returned as text. */
export async function decideNote(n: TeamNoteIn, accept: boolean): Promise<string | undefined> {
  try {
    await ipc.team.noteDecide(n.memberId, n.noteId, accept);
    return undefined;
  } catch (e) {
    return messageOf(e);
  } finally {
    setPending((all) => all.filter((x) => !(x.memberId === n.memberId && x.noteId === n.noteId)));
  }
}

/** Sends a note into a teammate's run. Rejects with the backend's reason. */
export async function sendTeamNote(memberId: string, runId: string, text: string): Promise<void> {
  watch();
  const noteId = await ipc.team.noteSend(memberId, runId, text);
  upsertSent({ memberId, runId, noteId, status: "sent", at: Date.now() });
}

export async function loadSent(memberId: string, runId: string): Promise<void> {
  watch();
  try {
    for (const n of await ipc.team.sentNotes(memberId, runId)) upsertSent(n);
  } catch {
    /* ignore */
  }
}

/** Tests: forget everything and the watchers. */
export function resetNotes(): void {
  watching?.();
  watching = undefined;
  readOnce = false;
  setPending([]);
  setSent([]);
}
