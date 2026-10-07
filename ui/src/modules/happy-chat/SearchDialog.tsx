import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from "solid-js";
import { t } from "../../i18n";
import type { ChatChannel, ChatPerson, ChatSearch, SearchHit } from "../../ipc/happy";
import { Button, Dialog, Hash, Icon, Input, Lock, MessageSquare, SegmentedControl, Search, Skeleton } from "../../ui-kit";
import "./chat-dialogs.css";
import { createDebounced, SEARCH_MIN } from "./dialogs-logic";
import { channelLabel, clip, dayLabel, hhmm } from "./logic";
import { Avatar } from "./Message";
import { joinChannel, openChatAt, openDirect, searchChat } from "./state";

export interface SearchDialogProps {
  open: boolean;
  onClose: () => void;
  /** Starts limited to this channel (the "This channel" toggle appears). */
  channelId?: string;
}

type Item =
  | { kind: "message"; key: string; hit: SearchHit }
  | { kind: "channel"; key: string; channel: ChatChannel }
  | { kind: "person"; key: string; person: ChatPerson };

export function SearchDialog(props: SearchDialogProps) {
  const [query, setQuery] = createSignal("");
  const q = createDebounced(query, 250);
  const [scope, setScope] = createSignal<"here" | "all">("all");
  const [result, setResult] = createSignal<ChatSearch>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [active, setActive] = createSignal(0);
  let run = 0;
  let listEl: HTMLDivElement | undefined;

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setQuery("");
        setResult(undefined);
        setError(undefined);
        setScope(props.channelId ? "here" : "all");
      },
    ),
  );

  const ready = () => q().trim().length >= SEARCH_MIN;
  const channelFilter = () => (scope() === "here" ? props.channelId : undefined);
  const load = () => {
    const id = ++run;
    if (!props.open || !ready()) {
      setResult(undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    searchChat(q().trim(), channelFilter()).then(
      (r) => id === run && (setResult(r), setLoading(false)),
      (e: Error) => id === run && (setError(e.message), setLoading(false)),
    );
  };
  createEffect(on([() => props.open, q, scope], load));

  const items = createMemo<Item[]>(() => {
    const r = result();
    if (!r) return [];
    return [
      ...r.messages.map((hit): Item => ({ kind: "message", key: `m:${hit.message.id}`, hit })),
      ...r.channels.map((channel): Item => ({ kind: "channel", key: `c:${channel.id}`, channel })),
      ...r.people.map((person): Item => ({ kind: "person", key: `p:${person.id}`, person })),
    ];
  });
  createEffect(on(items, () => setActive(0)));
  createEffect(() => {
    const el = listEl?.querySelector<HTMLElement>(`[data-index="${active()}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  });

  async function activate(item: Item) {
    if (item.kind === "message") {
      const m = item.hit.message;
      props.onClose();
      openChatAt({ channelId: m.channelId, messageId: m.id, threadRootId: m.threadRoot ?? undefined });
    } else if (item.kind === "channel") {
      const c = item.channel;
      if (c.isMember) {
        props.onClose();
        openChatAt({ channelId: c.id });
      } else {
        try {
          await joinChannel(c.id);
          props.onClose();
        } catch (e) {
          setError((e as Error).message);
        }
      }
    } else if (await openDirect(item.person.id)) {
      props.onClose();
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const n = items().length;
    if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      setActive((i) => (i + 1) % n);
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      setActive((i) => (i - 1 + n) % n);
    } else if (e.key === "Enter" && items()[active()]) {
      e.preventDefault();
      void activate(items()[active()]!);
    }
  };

  const offset = (kind: Item["kind"]) => items().findIndex((i) => i.kind === kind);
  const group = (kind: Item["kind"], title: string, render: (i: Item) => JSX.Element) => (
    <Show when={items().some((i) => i.kind === kind)}>
      <div role="group" aria-label={title} class="hcd-group">
        <h3 class="hcd-group__title" aria-hidden="true">{title}</h3>
        <For each={items().filter((i) => i.kind === kind)}>
          {(item, i) => {
            const index = () => offset(kind) + i();
            return (
              <div
                id={`hcd-search-${index()}`}
                class="hcd-hit"
                role="option"
                aria-selected={active() === index()}
                data-active={active() === index() ? "" : undefined}
                data-index={index()}
                onPointerMove={() => setActive(index())}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void activate(item)}
              >
                {render(item)}
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );

  const when = (ms: number) => `${dayLabel(ms, Date.now())} ${hhmm(ms)}`;
  const empty = () => ready() && !loading() && !error() && result() && !items().length;

  return (
    <Dialog open={props.open} onClose={props.onClose} title={t("hc.search.dlg.title")} size="lg" class="hcd-dialog hcd-dialog--search">
      <div class="hcd-form">
        <Input
          type="search"
          data-autofocus
          role="combobox"
          aria-expanded={items().length > 0}
          aria-controls="hcd-search-list"
          aria-activedescendant={items().length ? `hcd-search-${active()}` : undefined}
          aria-label={t("hc.search.dlg.label")}
          placeholder={t("hc.search.dlg.placeholder")}
          leading={<Icon icon={Search} size={14} />}
          autocomplete="off"
          spellcheck={false}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <Show when={props.channelId}>
          <SegmentedControl
            size="sm"
            aria-label={t("hc.search.dlg.scope")}
            value={scope()}
            onChange={(v) => setScope(v as "here" | "all")}
            options={[
              { value: "here", label: t("hc.search.dlg.here") },
              { value: "all", label: t("hc.search.dlg.everywhere") },
            ]}
          />
        </Show>
        <div class="hcd-results" aria-busy={loading()}>
          <p class="hcd-state" role="status" hidden={ready() || !!result()}>{t("hc.search.dlg.hint", { min: SEARCH_MIN })}</p>
          <Show when={loading() && !items().length}>
            <div class="hcd-skel" aria-hidden="true">
              <Skeleton height={44} />
              <Skeleton height={44} />
            </div>
          </Show>
          <Show when={error()}>
            <div class="hcd-state" role="alert">
              <span>{error()}</span>
              <Button size="sm" onClick={load}>{t("hc.dlg.retry")}</Button>
            </div>
          </Show>
          <Show when={empty()}>
            <p class="hcd-state" role="status">{t("hc.search.dlg.none", { query: q().trim() })}</p>
          </Show>
          <div id="hcd-search-list" ref={listEl} role="listbox" aria-label={t("hc.search.dlg.results")} class="hcd-hits">
            {group("message", t("hc.search.dlg.messages"), (item) => {
              const hit = (item as Extract<Item, { kind: "message" }>).hit;
              return (
                <>
                  <Avatar name={hit.message.senderName} size={24} />
                  <span class="hcd-hit__text">
                    <span class="hcd-hit__head">
                      <span class="hcd-hit__name ui-truncate">{hit.message.senderName}</span>
                      <span class="hcd-hit__where ui-truncate">{hit.channelName}{hit.message.threadRoot ? ` · ${t("hc.search.dlg.inThread")}` : ""}</span>
                      <span class="hcd-hit__time">{when(hit.message.createdAtMs)}</span>
                    </span>
                    <span class="hcd-hit__snippet">{clip(hit.message.text, 160)}</span>
                  </span>
                </>
              );
            })}
            {group("channel", t("hc.search.dlg.channels"), (item) => {
              const c = (item as Extract<Item, { kind: "channel" }>).channel;
              return (
                <>
                  <span class="hcd-hit__icon"><Icon icon={c.kind === "private" ? Lock : Hash} size={16} /></span>
                  <span class="hcd-hit__text">
                    <span class="hcd-hit__name ui-truncate">{channelLabel(c)}</span>
                    <Show when={!c.isMember}><span class="hcd-hit__snippet">{t("hc.search.dlg.joinHint")}</span></Show>
                  </span>
                </>
              );
            })}
            {group("person", t("hc.search.dlg.people"), (item) => {
              const p = (item as Extract<Item, { kind: "person" }>).person;
              return (
                <>
                  <Avatar name={p.name} size={24} />
                  <span class="hcd-hit__text">
                    <span class="hcd-hit__name ui-truncate">{p.name}</span>
                    <Show when={p.detail}><span class="hcd-hit__snippet">{p.detail}</span></Show>
                  </span>
                  <Icon icon={MessageSquare} size={14} class="hcd-hit__go" />
                </>
              );
            })}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
