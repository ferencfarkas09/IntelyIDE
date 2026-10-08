import { createSignal, Show } from "solid-js";
import { t } from "../../i18n";
import { lazyLabels } from "../lazyLabels";
import type { NoteState } from "../../store/agent-types";
import type { NoteItem } from "../../store/agent-reducer";
import { Button, Icon, IconButton, MessageSquareReply, SendHorizontal, TextArea, toast } from "../../ui-kit";

const STATE = lazyLabels<NoteState>({ queued: "notes.state.queued", delivered: "notes.state.delivered", dropped: "notes.state.dropped" });
const REASON = lazyLabels<"finished" | "turnEnded" | "cancelled" | "error">({ finished: "notes.reason.finished", turnEnded: "notes.reason.turnEnded", cancelled: "notes.reason.cancelled", error: "notes.reason.error" });
const FAILURE = lazyLabels<"noteNoTurn" | "noteUnknownTarget" | "noteUnsupported" | "noteTooLong" | "noteEmpty" | "notRunning">({
  noteNoTurn: "notes.fail.noteNoTurn",
  noteUnknownTarget: "notes.fail.noteUnknownTarget",
  noteUnsupported: "notes.fail.noteUnsupported",
  noteTooLong: "notes.fail.noteTooLong",
  noteEmpty: "notes.fail.noteEmpty",
  notRunning: "notes.fail.notRunning",
});

/** Tells the user why a note was refused, in their language where the host's code is known. */
export function noteFailure(e: unknown): void {
  const code = (e as { code?: string }).code ?? "";
  const known = Object.hasOwn(FAILURE, code) ? FAILURE[code as keyof typeof FAILURE] : undefined;
  toast.error(t("notes.fail"), known ?? (e as { message?: string }).message ?? String(e));
}

/** A note the user added: its text and where it stands (waiting, handed over, or not handed over and why). */
export function NoteRow(props: {
  item: NoteItem;
  nested?: boolean;
  /** Offered for a note whose subagent had already finished: say it to the lead instead. */
  onSendToLead?: (text: string) => void;
  /** Offered for the latest note the turn outlived: send it as a message of its own so it is not lost. */
  onSendAsMessage?: (text: string) => void;
}) {
  const reason = () => (props.item.reason && Object.hasOwn(REASON, props.item.reason) ? REASON[props.item.reason as keyof typeof REASON] : undefined);
  return (
    <div class="note" data-state={props.item.state} data-nested={props.nested ? "" : undefined} data-testid="note">
      <span class="note__icon" aria-hidden="true">
        <Icon icon={MessageSquareReply} size={12} />
      </span>
      <div class="note__main">
        <span class="note__who">{props.item.parentToolId ? t("notes.forSub") : t("notes.forLead")}</span>
        <span class="note__text ui-selectable">{props.item.text}</span>
        <Show when={props.item.state === "dropped" ? reason() : undefined}>{(r) => <span class="note__why">{r()}</span>}</Show>
      </div>
      <span class="note__state" role="status">
        {STATE[props.item.state]}
      </span>
      <Show when={props.item.state === "dropped" && props.item.reason === "finished" && props.onSendToLead}>
        <Button size="sm" variant="ghost" onClick={() => props.onSendToLead!(props.item.text)}>
          {t("notes.toLead")}
        </Button>
      </Show>
      <Show when={props.item.state === "dropped" && props.item.reason === "turnEnded" && props.onSendAsMessage}>
        <Button size="sm" variant="ghost" onClick={() => props.onSendAsMessage!(props.item.text)}>
          {t("notes.asMessage")}
        </Button>
      </Show>
    </div>
  );
}

/**
 * The field that adds a note to a running subagent: Enter sends, Shift+Enter breaks the line, Esc clears. `onSend` rejects when the host
 * refused the note (the caller says why); the text then stays so it can be sent again.
 */
export function NoteInput(props: { label: string; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const send = async () => {
    const body = text().trim();
    if (!body || busy()) return;
    setBusy(true);
    try {
      await props.onSend(body);
      setText("");
    } catch {
      /* refused: the caller told the user, the text stays */
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="note-input">
      <TextArea
        wrapperClass="note-input__field"
        aria-label={props.label}
        placeholder={props.label}
        minRows={1}
        maxRows={4}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            void send();
          } else if (e.key === "Escape" && text() !== "") {
            e.preventDefault();
            e.stopPropagation();
            setText("");
          }
        }}
      />
      <IconButton icon={SendHorizontal} size="sm" label={t("notes.send")} disabled={busy() || text().trim() === ""} onClick={() => void send()} />
    </div>
  );
}
