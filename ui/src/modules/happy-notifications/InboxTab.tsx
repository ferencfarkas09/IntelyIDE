import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { NotificationItem } from "../../ipc/happy";
import { openSettings } from "../../platform/settings";
import { refreshHappyStatus, happyStatus } from "../../store/happy";
import { applyInbox, inboxView, providerNote } from "../../store/happyNt";
import { AtSign, Badge, Button, Check, Circle, EmptyState, Hash, Icon, IconButton, Inbox, MessageSquare, MessagesSquare, RefreshCw, Skeleton, Trash2, TriangleAlert } from "../../ui-kit";
import { errorText, markAllRead, markRead, markUnread, openItem, removeItem } from "./actions";
import { ago, chatEvent, groupByDay, kindTone } from "./logic";
import "./notifications.css";

const openIntegrations = () => {
  void refreshHappyStatus();
  openSettings("integrations");
};

/** The dock tab: a state-aware shell around the list, so an off or blocked provider explains itself instead of showing nothing. */
export default function InboxTab() {
  const note = () => providerNote("notifications");
  return (
    <Switch fallback={<InboxList />}>
      <Match when={!note() || note()?.state === "off"}>
        <EmptyState icon={Inbox} title={t("hn.off.title")} description={t("hn.off.body")} action={<Button onClick={openIntegrations}>{t("hx.openSettings")}</Button>} />
      </Match>
      <Match when={note()?.state === "waitingForToken"}>
        <EmptyState icon={Inbox} title={t("hx.wait.title")} description={t("hn.wait.body")} action={<Button onClick={openIntegrations}>{t("hx.openSettings")}</Button>} />
      </Match>
      <Match when={note()?.state === "signedOut"}>
        <EmptyState icon={TriangleAlert} tone="danger" title={t("hx.out.title")} description={t("hx.out.body")} action={<Button onClick={openIntegrations}>{t("hx.openSettings")}</Button>} />
      </Match>
      <Match when={note()?.state === "notPermitted"}>
        <EmptyState icon={Inbox} title={t("hx.denied.title")} description={note()?.lastError?.message ?? t("hn.denied.body")} action={<Button onClick={openIntegrations}>{t("hx.openSettings")}</Button>} />
      </Match>
    </Switch>
  );
}

function InboxList() {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();
  const [now, setNow] = createSignal(Date.now());
  const view = inboxView;
  const actions = () => happyStatus()?.config.notifications.allowActions !== false;

  const load = async () => {
    setLoading(true);
    try {
      applyInbox(await ipc.happy.notifications.list());
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };
  onMount(() => {
    void load();
    const id = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => clearInterval(id));
  });

  const hasRows = () => view().items.length > 0;
  const groups = createMemo(() => groupByDay(view().items, now()));
  return (
    <div class="ib">
      <header class="ib__head">
        <h4 class="ib__title">{t("hn.title")}</h4>
        <Show when={view().unread > 0}>
          <Badge tone="accent" size="sm" numeric title={t("hn.unread")}>{view().unread}</Badge>
        </Show>
        <Button size="sm" variant="ghost" disabled={view().unread === 0 || !actions()} title={actions() ? undefined : t("hn.markAllTip")} onClick={() => void markAllRead()}>{t("hn.markAll")}</Button>
        <IconButton icon={RefreshCw} label={t("hx.refresh")} size="sm" loading={loading()} onClick={() => void load()} />
      </header>
      <Show when={view().stale || (error() && hasRows())}>
        <div class="ib__stale" role="status">{t("hx.stale")}</div>
      </Show>
      <Show when={!actions()}>
        <p class="ib__note">{t("hn.noteOff")}</p>
      </Show>
      <div class="ib__list">
        <Show when={!loading() || hasRows()} fallback={<><Skeleton height={52} /><Skeleton height={52} /><Skeleton height={52} /></>}>
          <Show when={!error() || hasRows()} fallback={<EmptyState size="sm" tone="danger" icon={TriangleAlert} title={t("hn.loadFailed")} description={error()} action={<Button size="sm" onClick={() => void load()}>{t("hx.retry")}</Button>} />}>
            <Show when={hasRows()} fallback={<EmptyState class="ib__empty" size="sm" icon={Inbox} title={t("hn.empty.title")} description={t("hn.empty.body")} />}>
              <div class="ib__groups" role="list" aria-label={t("hn.title")} onKeyDown={onListKey}>
                {/* Keyed by the day name and the item objects, so a refresh that changes nothing keeps the rows (and focus) alive. */}
                <For each={groups().map((g) => g.group)}>
                  {(group) => (
                    <section class="ib__group" aria-label={t(`hn.day.${group}`)}>
                      <h5 class="ib__day" aria-hidden="true">{t(`hn.day.${group}`)}</h5>
                      <For each={groups().find((g) => g.group === group)?.items ?? []}>{(item) => <Row item={item} now={now()} canMark={actions()} />}</For>
                    </section>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}

const EVENT_ICON = { direct: MessageSquare, mention: AtSign, thread: MessagesSquare, channel: Hash } as const;

/** Rows are grouped by day; arrows, Home and End move between the rows, Enter opens, Delete removes. */
function onListKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  if (!el.classList.contains("ib__open")) return;
  const all = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(".ib__open")];
  const at = all.indexOf(el);
  const to = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : -1;
  if (to < 0) return;
  e.preventDefault();
  all[Math.max(0, Math.min(all.length - 1, to))]?.focus();
}

function Row(props: { item: NotificationItem; now: number; canMark: boolean }) {
  const event = () => chatEvent(props.item);
  const icon = () => EVENT_ICON[event() ?? "channel"];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Delete" && props.canMark) {
      e.preventDefault();
      void removeItem(props.item.id);
    }
  };
  return (
    <div class="ib__row" role="listitem" data-unread={props.item.read ? undefined : ""} data-kind={props.item.kind ?? undefined}>
      <span class="ib__dot" aria-hidden="true" />
      <Show when={event()} fallback={<span class="ib__icon" aria-hidden="true" />}>
        <Icon class="ib__icon" icon={icon()} size={14} label={undefined} />
      </Show>
      <button type="button" class="ib__open" onClick={() => openItem(props.item, props.canMark)} onKeyDown={onKey}>
        <span class="ib__name">
          <span class="ui-sr-only">{props.item.read ? t("hn.sr.read") : t("hn.sr.unread")} </span>
          {props.item.title}
        </span>
        <Show when={props.item.body}><span class="ib__body">{props.item.body}</span></Show>
        <span class="ib__meta">
          <Show when={event()} fallback={<Show when={props.item.kind}><Badge size="sm" tone={kindTone(props.item.kind)}>{props.item.kind}</Badge></Show>}>
            {(ev) => <span>{t(`hn.ev.${ev()}`)}</span>}
          </Show>
          <span>{ago(props.item.createdAtMs, props.now)}</span>
        </span>
      </button>
      <Show when={props.canMark}>
        <div class="ib__actions">
          <Show
            when={!props.item.read}
            fallback={<IconButton class="ib__action" icon={Circle} label={t("hn.markUnreadOne", { title: props.item.title })} size="sm" onClick={() => void markUnread(props.item.id)} />}
          >
            <IconButton class="ib__action" icon={Check} label={t("hn.markOne", { title: props.item.title })} size="sm" onClick={() => void markRead(props.item.id)} />
          </Show>
          <IconButton class="ib__action" icon={Trash2} label={t("hn.deleteOne", { title: props.item.title })} size="sm" onClick={() => void removeItem(props.item.id)} />
        </div>
      </Show>
    </div>
  );
}
