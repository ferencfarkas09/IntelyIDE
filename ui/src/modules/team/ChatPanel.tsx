import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { timeAgo } from "../../components/push/logic";
import { t, type MessageKey } from "../../i18n";
import { IconButton, SendHorizontal, TextArea, X } from "../../ui-kit";
import { CHAT_MAX, chatKey, dismissOutgoing, loadThread, markChatOpen, outbox, sendChat, threads } from "./chat";
import "./team.css";

const REASON: Record<string, MessageKey> = {
  rate: "team.chat.reason.rate",
  unknownRun: "team.chat.reason.unknownRun",
  notMember: "team.chat.reason.notMember",
  invalid: "team.chat.reason.invalid",
  offline: "team.chat.reason.offline",
  timeout: "team.chat.reason.timeout",
};
const reasonText = (r: string): string => (Object.hasOwn(REASON, r) ? t(REASON[r]) : r);

/**
 * The chat thread of a shared run: what the people of the team wrote to each other about it. The owner's machine keeps the thread
 * and stamps the messages; writing needs the owner online. It is never given to the agent. All text is shown as plain text.
 */
export function ChatPanel(props: { ownerId: string | null; runId: string; ownerName?: string; ownerOnline: boolean }) {
  const key = () => chatKey(props.ownerId, props.runId);
  const msgs = () => threads()[key()] ?? [];
  const pending = () => outbox()[key()] ?? [];
  const [text, setText] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  let log: HTMLOListElement | undefined;
  // counts as read while it is on screen; opening a teammate's run also asks the owner for the history
  createEffect(
    on(key, () => {
      const close = markChatOpen(props.ownerId, props.runId);
      onCleanup(close);
      void loadThread(props.ownerId, props.runId);
    }),
  );
  createEffect(() => {
    msgs().length;
    pending().length;
    setNow(Date.now());
    if (log) log.scrollTop = log.scrollHeight;
  });
  const over = () => text().length > CHAT_MAX;
  const canSend = () => props.ownerOnline && text().trim() !== "" && !over();
  const send = () => {
    if (!canSend()) return;
    const body = text().trim();
    setText("");
    void sendChat(props.ownerId, props.runId, body);
  };
  return (
    <section class="team-chat" aria-label={t("team.chat.title")} data-testid="team-chat">
      <ol class="team-chat__log" role="log" aria-live="polite" aria-relevant="additions" aria-label={t("team.chat.thread")} tabIndex={0} ref={log}>
        <Show when={msgs().length + pending().length === 0}>
          <li class="team-chat__empty team-note">{props.ownerId === null ? t("team.chat.emptyOwn") : t("team.chat.empty", { name: props.ownerName ?? "" })}</li>
        </Show>
        <For each={msgs()}>
          {(m) => (
            <li class="team-chat__msg" data-mine={m.mine ? "" : undefined}>
              <span class="team-chat__meta">
                <span class="team-chat__author">{m.mine ? t("team.chat.you") : m.authorName || t("team.chat.former")}</span>
                <span class="team-note ui-tnum">{timeAgo(m.at, now())}</span>
              </span>
              <span class="team-chat__text ui-selectable">{m.text}</span>
            </li>
          )}
        </For>
        <For each={pending()}>
          {(o) => (
            <li class="team-chat__msg" data-mine="" data-pending={o.failed ? undefined : ""} data-failed={o.failed ? "" : undefined}>
              <span class="team-chat__meta">
                <span class="team-chat__author">{t("team.chat.you")}</span>
                <Show
                  when={o.failed}
                  fallback={<span class="team-note" role="status">{t("team.chat.sending")}</span>}
                >
                  {(r) => (
                    <>
                      <span class="team-error" role="alert">{t("team.chat.notSent", { reason: reasonText(r()) })}</span>
                      <IconButton icon={X} size="sm" label={t("team.chat.dismiss")} onClick={() => dismissOutgoing(props.ownerId, props.runId, o.localId)} />
                    </>
                  )}
                </Show>
              </span>
              <span class="team-chat__text ui-selectable">{o.text}</span>
            </li>
          )}
        </For>
      </ol>
      <div class="team-chat__composer">
        <Show when={!props.ownerOnline}><p class="team-note" role="status">{t("team.chat.offline", { name: props.ownerName ?? "" })}</p></Show>
        <div class="team-chat__field">
          <TextArea
            wrapperClass="team-chat__input"
            aria-label={t("team.chat.placeholder")}
            placeholder={t("team.chat.placeholder")}
            minRows={1}
            maxRows={5}
            invalid={over()}
            disabled={!props.ownerOnline}
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <IconButton icon={SendHorizontal} size="sm" label={t("team.chat.send")} disabled={!canSend()} onClick={send} />
        </div>
        <span class="team-note ui-tnum team-chat__count" data-over={over() ? "" : undefined}>{t("team.chat.count", { n: text().length, max: CHAT_MAX })}</span>
      </div>
    </section>
  );
}
