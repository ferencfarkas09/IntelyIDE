import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ArrowLeft, Button, EmptyState, IconButton, MessageSquare, Skeleton, TriangleAlert } from "../../ui-kit";
import { ChannelHeader } from "./ChannelHeader";
import { Composer } from "./Composer";
import { buildRows, channelLabel, typingLine } from "./logic";
import { MessageList } from "./MessageList";
import { channelOf, chatSummary, convoOf, hideChannel, loadOlder, markRead, myName, showChannel, typingIn, windowFocused } from "./state";

/** One conversation: header, the virtualised messages, typing line and composer. Remounted per channel by its parent. */
export function Conversation(props: { channelId: string; onBack?: () => void; onEscape?: () => void }) {
  const id = props.channelId;
  const channel = () => channelOf(id);
  const convo = () => convoOf(id);
  const [atBottom, setAtBottom] = createSignal(true);
  const [now, setNow] = createSignal(Date.now());

  onMount(() => {
    void showChannel(id);
    // "Today" must flip at midnight even when nothing else changes.
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    onCleanup(() => clearInterval(tick));
  });
  onCleanup(() => hideChannel(id));

  // Everything up to now is read once the conversation is loaded, in front, and the newest message is in view.
  createEffect(
    on([() => convo()?.loaded, () => convo()?.items.length, () => channel()?.unreadCount, () => convo()?.jumped, windowFocused, atBottom], () => {
      if (convo()?.loaded && windowFocused() && atBottom() && !convo()?.jumped) markRead(id);
    }),
  );

  const rows = createMemo(() => buildRows(convo()?.items ?? [], { nowMs: now(), firstUnreadId: convo()?.firstUnreadId }));
  const known = createMemo(() => [...new Set([...(convo()?.items ?? []).map((m) => m.senderName), ...(myName() ? [myName()!] : [])])]);
  const label = () => (channel() ? channelLabel(channel()!) : t("hc.conv.fallback"));
  const link = () => chatSummary()?.link;
  const offline = () => link() === "reconnecting" || !!chatSummary()?.stale;
  const typing = () => typingLine(typingIn(id));

  return (
    <div
      class="hc-conv"
      data-testid="chat-conversation"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) props.onEscape?.();
      }}
    >
      <Show
        when={channel()}
        fallback={
          <header class="hc-conv__head">
            <Show when={props.onBack}>
              <IconButton icon={ArrowLeft} label={t("hc.back")} size="sm" onClick={() => props.onBack?.()} />
            </Show>
            <h4 class="hc-conv__title ui-truncate">{label()}</h4>
          </header>
        }
      >
        {(c) => <ChannelHeader channel={c()} onBack={props.onBack} />}
      </Show>
      <Show when={offline()}>
        <p class="hc-stale" role="status">{t("hc.offline.conv")}</p>
      </Show>
      <div class="hc-conv__body">
        <Show
          when={convo()?.loaded}
          fallback={
            <Show
              when={convo()?.error}
              fallback={
                <div class="hc-skeleton hc-skeleton--conv" aria-busy="true">
                  <Skeleton height={34} /><Skeleton height={34} width="82%" /><Skeleton height={34} width="68%" /><Skeleton height={34} />
                </div>
              }
            >
              <EmptyState tone="danger" size="sm" icon={TriangleAlert} title={t("hc.loadFailed")} description={convo()?.error} action={<Button size="sm" onClick={() => void showChannel(id)}>{t("hc.retry")}</Button>} />
            </Show>
          }
        >
          <Show
            when={rows().length > 0}
            fallback={<EmptyState size="sm" icon={MessageSquare} title={t("hc.noMessages")} description={t("hc.sayHello", { label: label() })} />}
          >
            <MessageList
              channelId={id}
              rows={rows()}
              known={known()}
              hasMore={!!convo()?.hasMore}
              loadingOlder={!!convo()?.loadingOlder}
              onLoadOlder={() => void loadOlder(id)}
              onAtBottom={setAtBottom}
              label={t("hc.listLabel", { label: label() })}
            />
          </Show>
        </Show>
      </div>
      <div class="hc-typing" aria-live="polite">{typing()}</div>
      <Composer channelId={id} placeholder={t("hc.composerLabel", { label: label() })} />
    </div>
  );
}
