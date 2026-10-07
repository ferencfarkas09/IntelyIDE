import { createEffect, createSignal, For, on, Show } from "solid-js";
import { t } from "../../i18n";
import type { ThreadSummary } from "../../ipc/happy";
import { ArrowLeft, Badge, Button, EmptyState, IconButton, MessagesSquare, Skeleton, Switch, TriangleAlert } from "../../ui-kit";
import { channelLabel, clip, hhmm, initials } from "./logic";
import { Avatar } from "./Message";
import { chatSummary, openChatAt, refreshThreads, threadsList } from "./state";

function Item(props: { item: ThreadSummary }) {
  const i = () => props.item;
  const root = () => i().root;
  const channel = () => channelLabel({ kind: i().channelKind, name: i().channelName });
  const preview = () => (root().deleted ? t("hc.deleted") : clip(root().text.replace(/\s+/g, " "), 140));
  const label = () =>
    t("hc.th.list.row", { channel: channel(), author: root().senderName, text: preview(), replies: t("hc.msg.replies", { count: i().replyCount }), unread: i().unreadCount });
  return (
    <li>
      <button
        type="button"
        class="hc-thr"
        data-unread={i().unreadCount > 0 ? "" : undefined}
        data-root={root().id}
        aria-label={label()}
        onClick={() => openChatAt({ channelId: i().channelId, messageId: root().id, threadRootId: root().id })}
      >
        <span class="hc-thr__channel ui-truncate">{channel()}</span>
        <span class="hc-thr__root">
          <span class="hc-thr__author">{root().senderName}</span>
          <span class="hc-thr__text">{preview()}</span>
        </span>
        <span class="hc-thr__meta">
          <span class="hc-thr__avatars" aria-hidden="true">
            <For each={root().replyUsers.slice(0, 3)}>{(u) => <Avatar name={u.name} size={18} />}</For>
            <Show when={root().replyUsers.length === 0}><span class="hc-thr__initials">{initials(root().senderName)}</span></Show>
          </span>
          <span class="hc-thr__count">{t("hc.msg.replies", { count: i().replyCount })}</span>
          <Show when={i().lastReplyAtMs}><span class="hc-thr__time ui-tnum">{hhmm(i().lastReplyAtMs!)}</span></Show>
          <Show when={i().unreadCount > 0}>
            <Badge size="sm" numeric tone="accent" variant="solid" title={t("hc.th.list.new", { count: i().unreadCount })}>{i().unreadCount}</Badge>
          </Show>
        </span>
      </button>
    </li>
  );
}

/** The "Threads" screen of the middle area: every thread the user takes part in, newest activity first. */
export function ThreadsView(props: { onBack?: () => void }) {
  const [unreadOnly, setUnreadOnly] = createSignal(false);
  let list: HTMLUListElement | undefined;
  // Loaded on show, again when the toggle flips and when the server's count of threads with news changes.
  createEffect(on([unreadOnly, () => chatSummary()?.threadUnread], () => void refreshThreads(unreadOnly())));
  const onKey = (e: KeyboardEvent) => {
    const rows = [...(list?.querySelectorAll<HTMLButtonElement>(".hc-thr") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[e.key];
    if (to === undefined || at < 0) return;
    e.preventDefault();
    rows[Math.min(rows.length - 1, Math.max(0, to))]?.focus();
  };
  return (
    <div class="hc-conv hc-threads" data-testid="chat-threads">
      <header class="hc-conv__head">
        <Show when={props.onBack}>
          <IconButton icon={ArrowLeft} label={t("hc.back")} size="sm" onClick={() => props.onBack?.()} />
        </Show>
        <h4 class="hc-conv__title ui-truncate">{t("hc.th.list.title")}</h4>
        <Switch size="sm" checked={unreadOnly()} onChange={setUnreadOnly} label={t("hc.th.list.unreadOnly")} />
      </header>
      <div class="hc-conv__body hc-threads__body">
        <Show
          when={threadsList.items.length > 0}
          fallback={
            <Show
              when={!threadsList.loading}
              fallback={<div class="hc-skeleton" aria-busy="true"><Skeleton height={52} /><Skeleton height={52} /><Skeleton height={52} /></div>}
            >
              <Show
                when={!threadsList.error}
                fallback={<EmptyState tone="danger" size="sm" icon={TriangleAlert} title={t("hc.th.list.failed")} description={threadsList.error} action={<Button size="sm" onClick={() => void refreshThreads(unreadOnly())}>{t("hc.retry")}</Button>} />}
              >
                <EmptyState
                  size="sm"
                  icon={MessagesSquare}
                  title={unreadOnly() ? t("hc.th.list.caughtUp") : t("hc.th.list.empty")}
                  description={unreadOnly() ? t("hc.th.list.caughtUpBody") : t("hc.th.list.emptyBody")}
                />
              </Show>
            </Show>
          }
        >
          <ul class="hc-threads__list" ref={list} aria-label={t("hc.th.list.title")} aria-busy={threadsList.loading} onKeyDown={onKey}>
            <For each={threadsList.items}>{(item) => <Item item={item} />}</For>
          </ul>
        </Show>
      </div>
    </div>
  );
}
