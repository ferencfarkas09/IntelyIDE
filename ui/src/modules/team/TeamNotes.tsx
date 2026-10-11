import { createSignal, For, onMount, Show } from "solid-js";
import { NoteInput } from "../../components/chat/Notes";
import { t, type MessageKey } from "../../i18n";
import type { TeamNoteIn, TeamNoteStatus, TeamRun } from "../../ipc/team";
import { Button, Check, MessageSquareReply, X } from "../../ui-kit";
import { decideNote, loadNotes, loadSent, pending, sendTeamNote, sent } from "./notes";
import { messageOf, view } from "./store";
import "./team.css";

const STATUS: Record<TeamNoteStatus, MessageKey> = {
  sent: "team.note.status.sent",
  received: "team.note.status.received",
  accepted: "team.note.status.accepted",
  rejected: "team.note.status.rejected",
  delivered: "team.note.status.delivered",
  dropped: "team.note.status.dropped",
  refused: "team.note.status.refused",
};
const REASON: Record<string, MessageKey> = {
  rate: "team.note.reason.rate",
  notLive: "team.note.reason.notLive",
  notShared: "team.note.reason.notShared",
  unsupported: "team.note.reason.unsupported",
  unknownRun: "team.note.reason.unknownRun",
  notMember: "team.note.reason.notMember",
};
const TONE = { sent: "neutral", received: "neutral", accepted: "info", delivered: "ok", rejected: "warn", dropped: "warn", refused: "warn" } as const;

const reasonText = (r?: string | null): string | undefined => (r ? (Object.hasOwn(REASON, r) ? t(REASON[r]) : r) : undefined);

/** The owner's side: notes teammates sent, waiting for Accept or Reject. `runId` limits it to one run (its chat panel). */
export function TeamNoteCards(props: { runId?: string }) {
  onMount(() => void loadNotes());
  const mine = () => pending().filter((n) => props.runId === undefined || n.runId === props.runId);
  return (
    <Show when={mine().length > 0}>
      <div class="team-notecards" data-testid="team-notecards">
        <For each={mine()}>{(n) => <NoteCard note={n} />}</For>
      </div>
    </Show>
  );
}

function NoteCard(props: { note: TeamNoteIn }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const decide = async (accept: boolean) => {
    setBusy(true);
    setError(undefined);
    const failed = await decideNote(props.note, accept);
    // the card is gone either way; the failure is told once more where the owner is looking
    if (failed) setError(failed);
    setBusy(false);
  };
  return (
    <div class="team-notecard" role="group" aria-label={t("team.note.from", { name: props.note.memberName })} data-testid="team-notecard">
      <span class="team-notecard__icon" aria-hidden="true"><MessageSquareReply size={14} /></span>
      <div class="team-notecard__main">
        <span class="team-notecard__who">{t("team.note.sentNote", { name: props.note.memberName })}</span>
        <span class="team-notecard__text ui-selectable">{props.note.text}</span>
        <span class="team-note">{t("team.note.hint")}</span>
        <Show when={error()}>{(m) => <span class="team-error" role="alert">{m()}</span>}</Show>
      </div>
      <div class="team-actions">
        <Button size="sm" variant="primary" icon={Check} disabled={busy()} onClick={() => void decide(true)}>{t("team.note.accept")}</Button>
        <Button size="sm" variant="ghost" icon={X} disabled={busy()} onClick={() => void decide(false)}>{t("team.note.reject")}</Button>
      </div>
    </div>
  );
}

/** The receiver's side: a note composer for a live Claude run of an online teammate, and where each note stands. */
export function TeamNoteComposer(props: { run: TeamRun }) {
  const [error, setError] = createSignal<string | undefined>(undefined);
  onMount(() => void loadSent(props.run.memberId, props.run.runId));
  const ownerOnline = () => view().members.some((m) => m.id === props.run.memberId && m.online);
  const open = () => ownerOnline() && props.run.provider === "claude" && (props.run.state === "running" || props.run.state === "waiting");
  const mine = () => sent().filter((n) => n.memberId === props.run.memberId && n.runId === props.run.runId).slice(-5);
  const send = async (text: string) => {
    setError(undefined);
    try {
      await sendTeamNote(props.run.memberId, props.run.runId, text);
    } catch (e) {
      setError(messageOf(e));
      throw e;
    }
  };
  return (
    <div class="team-notecomposer" data-testid="team-notecomposer">
      <Show when={mine().length > 0}>
        <ul class="team-notelist" aria-label={t("team.note.sentList")}>
          <For each={mine()}>
            {(n) => (
              <li class="team-notelist__item" data-status={n.status}>
                <span class="team-notelist__status" role="status" data-tone={TONE[n.status]}>{t(STATUS[n.status])}</span>
                <Show when={reasonText(n.reason)}>{(r) => <span class="team-note">{r()}</span>}</Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={error()}>{(m) => <p class="team-error" role="alert">{m()}</p>}</Show>
      <Show when={open()} fallback={<p class="team-note">{t("team.note.unavailable")}</p>}>
        <NoteInput label={t("team.note.placeholder", { name: props.run.memberName })} onSend={send} />
        <p class="team-note">{t("team.note.composerHint", { name: props.run.memberName })}</p>
      </Show>
    </div>
  );
}
