import { createSignal, createMemo, For, Show } from "solid-js";
import { t } from "../../i18n";
import type { ChatMessage } from "../../ipc/happy";
import { Button, CircleAlert, FileText, Icon, Paperclip, Pin, TextArea, Video } from "../../ui-kit";
import { openLink } from "./actions";
import { avatarSlot, formatBytes, hhmm, hostOf, initials, isCreditsCode, replySummary, tokenize } from "./logic";
import { actionFailed, MessageActions, react } from "./MessageActions";
import { deleteMessage, discardMessage, editMessage, myName, openThread, retryMessage } from "./state";

function LinkToken(props: { text: string; href?: string }) {
  return (
    <Show when={props.href} fallback={<span class="hc-link hc-link--inert" title={t("hc.link.inert")}>{props.text}</span>}>
      {(href) => (
        <a
          class="hc-link"
          href={href()}
          title={t("hc.link.open", { host: hostOf(href()) })}
          rel="noopener noreferrer"
          draggable={false}
          onClick={(e) => {
            e.preventDefault();
            void openLink(href());
          }}
          onAuxClick={(e) => e.preventDefault()}
        >
          {props.text}
        </a>
      )}
    </Show>
  );
}

/** Plain text with links and mentions. Everything is a text node or a link to a validated https URL: no HTML is ever parsed. */
export function MessageText(props: { text: string; known?: readonly string[] }) {
  const tokens = createMemo(() => tokenize(props.text, { name: myName(), known: props.known }));
  return (
    <For each={tokens()}>
      {(tok) =>
        tok.t === "text" ? (
          tok.v
        ) : tok.t === "mention" ? (
          <span class="hc-mention" data-me={tok.me ? "" : undefined}>{tok.v}</span>
        ) : (
          <LinkToken text={tok.v} href={tok.href} />
        )
      }
    </For>
  );
}

export function Avatar(props: { name: string; size?: number }) {
  return (
    <span class="hc-avatar" data-slot={avatarSlot(props.name)} style={props.size ? { "--hc-avatar": `${props.size}px` } : undefined} aria-hidden="true">
      {initials(props.name)}
    </span>
  );
}

const reasonOf = (code: string | null | undefined): string => {
  if (isCreditsCode(code)) return t("hc.reason.credits");
  if (code === "signedOut") return t("hc.reason.signedOut");
  if (code === "blocked") return t("hc.reason.blocked");
  if (code === "notConnected" || code === "offline") return t("hc.reason.offline");
  if (code === "validation") return t("hc.reason.validation");
  return t("hc.reason.generic");
};

/** Up to three reply avatars, "N replies" and "last reply 14:02": opens the thread panel. */
function ThreadFooter(props: { msg: ChatMessage }) {
  const sum = () => replySummary(props.msg);
  return (
    <Show when={sum()}>
      {(s) => {
        const summary = () => `${t("hc.msg.replies", { count: s().count })}${s().lastAtMs ? ` · ${t("hc.msg.lastReply", { time: hhmm(s().lastAtMs!) })}` : ""}`;
        return (
          <button type="button" class="hc-thread-foot" aria-label={t("hc.msg.openThread", { summary: summary() })} onClick={() => void openThread(props.msg.channelId, props.msg.id)}>
            <span class="hc-thread-foot__avatars" aria-hidden="true">
              <For each={s().users}>{(u) => <Avatar name={u.name} size={18} />}</For>
            </span>
            <span class="hc-thread-foot__count">{t("hc.msg.replies", { count: s().count })}</span>
            <Show when={s().lastAtMs}><span class="hc-thread-foot__last">{t("hc.msg.lastReply", { time: hhmm(s().lastAtMs!) })}</span></Show>
          </button>
        );
      }}
    </Show>
  );
}

function Editor(props: { msg: ChatMessage; onDone: () => void }) {
  const [text, setText] = createSignal(props.msg.text);
  const [busy, setBusy] = createSignal(false);
  const save = async () => {
    const next = text().trim();
    if (!next || next === props.msg.text.trim()) return props.onDone();
    setBusy(true);
    try {
      await editMessage(props.msg.id, next);
      props.onDone();
    } catch (e) {
      actionFailed(e);
      setBusy(false);
    }
  };
  return (
    <div class="hc-edit">
      <TextArea
        minRows={1}
        maxRows={8}
        value={text()}
        aria-label={t("hc.msg.editLabel")}
        data-autofocus
        ref={(el: HTMLTextAreaElement) => queueMicrotask(() => (el.focus(), el.setSelectionRange(el.value.length, el.value.length)))}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            props.onDone();
          }
        }}
      />
      <div class="hc-edit__row">
        <span class="hc-edit__hint">{t("hc.msg.editHint")}</span>
        <Button size="sm" variant="ghost" onClick={props.onDone}>{t("hc.msg.cancel")}</Button>
        <Button size="sm" variant="primary" loading={busy()} onClick={() => void save()}>{t("hc.msg.save")}</Button>
      </div>
    </div>
  );
}

/**
 * One message: header, plain text, reactions, attachments, a thread footer under a root with replies, and the action toolbar.
 * `inThread` hides "Reply in thread" and the footer (replies and the root inside the thread panel); `readOnly` hides the toolbar.
 */
export function MessageRow(props: { msg: ChatMessage; grouped: boolean; known: readonly string[]; inThread?: boolean; readOnly?: boolean; flash?: boolean }) {
  const m = () => props.msg;
  const cid = () => m().clientMessageId ?? undefined;
  const [editing, setEditing] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const settled = () => m().sendState === "sent" && !m().deleted;
  const rootOf = () => (props.inThread ? (m().threadRoot ?? undefined) : undefined);
  const cardKind = () => (m().kind === "meeting" || m().kind === "record" ? m().kind : undefined);
  return (
    <Show
      when={m().kind !== "system"}
      fallback={<p class="hc-system" data-testid="chat-message">{m().text}</p>}
    >
      <div
        class="hc-msg"
        data-grouped={props.grouped ? "" : undefined}
        data-mine={m().mine ? "" : undefined}
        data-mention={m().mentionsMe ? "" : undefined}
        data-state={m().sendState}
        data-flash={props.flash ? "" : undefined}
        data-menu-open={menuOpen() ? "" : undefined}
        data-pinned={m().pinned ? "" : undefined}
        data-msg={m().id}
        data-testid="chat-message"
      >
        <div class="hc-msg__gutter">
          <Show when={!props.grouped} fallback={<time class="hc-msg__hover-time" datetime={new Date(m().createdAtMs).toISOString()}>{hhmm(m().createdAtMs)}</time>}>
            <Avatar name={m().senderName} />
          </Show>
        </div>
        <div class="hc-msg__main">
          <Show when={!props.grouped}>
            <div class="hc-msg__head">
              <span class="hc-msg__name ui-truncate">{m().mine ? t("hc.you") : m().senderName}</span>
              <time class="hc-msg__time" datetime={new Date(m().createdAtMs).toISOString()}>{hhmm(m().createdAtMs)}</time>
            </div>
          </Show>
          <Show when={m().pinned && !m().deleted}>
            <span class="hc-msg__pinned"><Icon icon={Pin} size={12} />{t("hc.msg.pinned")}</span>
          </Show>
          <Show when={!m().deleted} fallback={<p class="hc-msg__text hc-msg__text--deleted">{t("hc.deleted")}</p>}>
            <Show
              when={!editing()}
              fallback={<Editor msg={m()} onDone={() => setEditing(false)} />}
            >
              <Show
                when={cardKind()}
                fallback={
                  <p class="hc-msg__text ui-selectable">
                    <MessageText text={m().text} known={props.known} />
                    <Show when={m().edited}><span class="hc-msg__edited"> {t("hc.edited")}</span></Show>
                  </p>
                }
              >
                {(kind) => (
                  <div class="hc-card" data-kind={kind()}>
                    <Icon icon={kind() === "meeting" ? Video : FileText} size={14} />
                    <span class="hc-card__kind">{kind() === "meeting" ? t("hc.msg.meeting") : t("hc.msg.record")}</span>
                    <span class="hc-card__text ui-selectable"><MessageText text={m().text} known={props.known} /></span>
                  </div>
                )}
              </Show>
            </Show>
          </Show>
          <Show when={!m().deleted && m().attachments.length > 0}>
            <ul class="hc-files">
              <For each={m().attachments}>
                {(a) => (
                  <li class="hc-file" aria-label={t("hc.msg.attachment", { name: a.name })}>
                    <Icon icon={Paperclip} size={12} />
                    <span class="hc-file__name ui-truncate">{a.name}</span>
                    <span class="hc-file__size ui-tnum">{formatBytes(a.size)}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={!m().deleted && m().reactions.length > 0}>
            <div class="hc-reactions">
              <For each={m().reactions}>
                {(r) => (
                  <button
                    type="button"
                    class="hc-reaction"
                    data-mine={r.mine ? "" : undefined}
                    aria-pressed={r.mine}
                    aria-label={t("hc.msg.reaction", { emoji: r.emoji, count: r.count, mine: r.mine ? "yes" : "no" })}
                    disabled={!settled() || props.readOnly}
                    onClick={() => react(m(), r.emoji)}
                  >
                    <span aria-hidden="true">{r.emoji}</span>
                    <span class="ui-tnum" aria-hidden="true">{r.count}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={!props.inThread && !m().deleted && (m().replyCount ?? 0) > 0}>
            <ThreadFooter msg={m()} />
          </Show>
          <Show when={m().sendState === "pending"}>
            <span class="hc-msg__status" role="status">{t("hc.sending")}</span>
          </Show>
          <Show when={confirming()}>
            <div class="hc-msg__confirm" role="alertdialog" aria-label={t("hc.msg.confirmDelete")}>
              <span>{t("hc.msg.confirmDelete")}</span>
              <Button
                size="sm"
                variant="danger"
                data-autofocus
                ref={(el: HTMLButtonElement) => queueMicrotask(() => el.focus())}
                onClick={() => {
                  setConfirming(false);
                  deleteMessage(m().channelId, m().id, rootOf()).catch(actionFailed);
                }}
              >
                {t("hc.msg.delete")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>{t("hc.msg.cancel")}</Button>
            </div>
          </Show>
          <Show when={m().sendState === "failed"}>
            <div class="hc-msg__failed" role="alert">
              <Icon icon={CircleAlert} size={12} />
              <span>{reasonOf(m().errorCode)}</span>
              <Show when={cid()}>
                {(id) => (
                  <>
                    <button type="button" class="hc-textbtn" onClick={() => retryMessage(m().channelId, id(), m().threadRoot ?? undefined)}>{t("hc.retry")}</button>
                    <button type="button" class="hc-textbtn" onClick={() => discardMessage(m().channelId, id(), m().threadRoot ?? undefined)}>{t("hc.remove")}</button>
                  </>
                )}
              </Show>
            </div>
          </Show>
        </div>
        <Show when={settled() && !props.readOnly && !editing()}>
          <MessageActions msg={m()} inThread={!!props.inThread} onEdit={() => setEditing(true)} onDelete={() => setConfirming(true)} onOpenChange={setMenuOpen} />
        </Show>
      </div>
    </Show>
  );
}
