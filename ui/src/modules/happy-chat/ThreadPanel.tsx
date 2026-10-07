import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import { Button, EmptyState, IconButton, ScrollArea, Skeleton, TriangleAlert, X } from "../../ui-kit";
import { Composer } from "./Composer";
import { buildRows, channelLabel } from "./logic";
import { MessageRow } from "./Message";
import { channelOf, closeThread, consumeThreadFocus, openThread, sentReplyTick, threadOf } from "./state";

/**
 * The thread in the right panel: the root (read-only), a "N replies" divider, the replies oldest first, and its own composer.
 * Replies go through `sendReply` (optimistic, with Retry / Remove on failure) and never show in the channel.
 */
export function ThreadPanel(props: { channelId: string; rootId: string; onClose?: () => void }) {
  const thread = () => threadOf(props.rootId);
  const channel = () => channelOf(props.channelId);
  const label = () => (channel() ? channelLabel(channel()!) : t("hc.conv.fallback"));
  const replies = () => thread()?.replies ?? [];
  const rows = createMemo(() => buildRows(replies(), { nowMs: Date.now() }));
  const known = createMemo(() => [...new Set([thread()?.root?.senderName, ...replies().map((m) => m.senderName)].filter((n): n is string => !!n))]);
  const [flash, setFlash] = createSignal<string>();
  let scroller: HTMLDivElement | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(flashTimer));

  const toBottom = () =>
    requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  const close = () => (props.onClose ? props.onClose() : closeThread());

  // The newest reply is in view when the thread opens, when one arrives and when the user replies; a focus target wins.
  createEffect(
    on([() => thread()?.loading, () => replies().length, sentReplyTick, () => thread()?.focusId], ([loading, , tick, focusId], prev) => {
      if (loading) return;
      if (focusId) {
        const el = scroller?.querySelector<HTMLElement>(`[data-msg="${CSS.escape(focusId)}"]`);
        if (el) {
          consumeThreadFocus(props.rootId);
          el.scrollIntoView?.({ block: "center" });
          setFlash(focusId);
          clearTimeout(flashTimer);
          flashTimer = setTimeout(() => setFlash(undefined), 2400);
          return;
        }
      }
      const own = prev !== undefined && tick !== prev[2];
      const gap = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : 0;
      if (prev === undefined || prev[0] || own || gap < 120) toBottom();
    }),
  );

  return (
    <section class="hc-thread" aria-label={t("hc.th.panel", { label: label() })} data-testid="chat-thread" data-root={props.rootId}>
      <header class="hc-rp__head">
        <h4 class="hc-rp__title">{t("hc.th.title")}</h4>
        <span class="hc-rp__sub ui-truncate">{label()}</span>
        <IconButton icon={X} label={t("hc.th.close")} size="sm" data-panel-close onClick={close} />
      </header>
      <Show
        when={thread()?.root}
        fallback={
          <Show
            when={thread()?.error}
            fallback={<div class="hc-skeleton" aria-busy="true"><Skeleton height={40} /><Skeleton height={28} width="70%" /><Skeleton height={28} width="85%" /></div>}
          >
            <EmptyState tone="danger" size="sm" icon={TriangleAlert} title={t("hc.th.loadFailed")} description={thread()?.error} action={<Button size="sm" onClick={() => void openThread(props.channelId, props.rootId)}>{t("hc.retry")}</Button>} />
          </Show>
        }
      >
        {(root) => (
          <ScrollArea class="hc-thread__scroll" ref={(el) => (scroller = el)} role="log" aria-live="off" aria-label={t("hc.th.panel", { label: label() })}>
            <MessageRow msg={root()} grouped={false} known={known()} inThread readOnly flash={flash() === root().id} />
            <div class="hc-day" role="separator">
              <span>{replies().length > 0 ? t("hc.msg.replies", { count: replies().length }) : t("hc.th.noReplies")}</span>
            </div>
            <Show when={thread()?.error}>
              <p class="hc-composer__block" role="alert">{thread()?.error}</p>
            </Show>
            <For each={rows()}>
              {(row) =>
                row.kind === "message" ? (
                  <MessageRow msg={row.msg} grouped={row.grouped} known={known()} inThread flash={flash() === row.msg.id} />
                ) : row.kind === "day" ? (
                  <div class="hc-day" role="separator"><span>{row.label}</span></div>
                ) : null
              }
            </For>
          </ScrollArea>
        )}
      </Show>
      <Composer channelId={props.channelId} thread={{ rootId: props.rootId }} placeholder={t("hc.th.placeholder")} label={t("hc.th.replyLabel")} />
    </section>
  );
}

