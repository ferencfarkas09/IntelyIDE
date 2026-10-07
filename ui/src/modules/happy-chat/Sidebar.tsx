import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import type { ChatChannel } from "../../ipc/happy";
import { Badge, EmptyState, FileSearch, Hash, IconButton, Input, Lock, MessageSquare, MessagesSquare, Pencil, Plus, Search, Skeleton, Star, StatusDot, Users } from "../../ui-kit";
import { openBrowseChannels, openNewChannel, openNewMessage, openSearch } from "./dialogs";
import { channelLabel, norm, sectionsOf, type ListSection } from "./logic";
import { Avatar } from "./Message";
import { chatMainView, chatSummary, listSearchTick, openDirect, searchPeople } from "./state";

/** The icon of a conversation by kind: # for public, a lock for private, an avatar for a person, people for a group. */
function RowIcon(props: { c: ChatChannel }) {
  return (
    <Show
      when={props.c.kind === "direct"}
      fallback={
        <Show
          when={props.c.kind === "group"}
          fallback={<span class="hc-row__icon" aria-hidden="true" title={props.c.kind === "private" ? t("hc.sb.private") : undefined}>{props.c.kind === "private" ? <Lock size={13} /> : <Hash size={14} />}</span>}
        >
          <span class="hc-row__icon" aria-hidden="true" title={t("hc.sb.group")}><Users size={14} /></span>
        </Show>
      }
    >
      <Avatar name={props.c.name} size={18} />
    </Show>
  );
}

function Row(props: { c: ChatChannel; active: boolean; tabbable: boolean; onSelect: (id: string) => void }) {
  const c = () => props.c;
  const unread = () => c().unreadCount;
  const label = () => t("hc.row.label", { name: channelLabel(c()), unread: unread(), mentions: c().mentionCount, muted: c().muted ? "yes" : "no" });
  return (
    <button
      type="button"
      role="option"
      class="hc-row"
      data-channel={c().id}
      data-kind={c().kind}
      data-active={props.active ? "" : undefined}
      data-unread={unread() ? "" : undefined}
      data-mention={c().mentionCount > 0 ? "" : undefined}
      data-muted={c().muted ? "" : undefined}
      aria-selected={props.active}
      aria-label={label()}
      tabIndex={props.tabbable ? 0 : -1}
      onClick={() => props.onSelect(c().id)}
    >
      <RowIcon c={c()} />
      <span class="hc-row__name ui-truncate">{c().name}</span>
      <Show when={c().starred}>
        <span class="hc-row__star" aria-hidden="true" title={t("hc.sb.starred")}><Star size={11} /></span>
      </Show>
      <Show when={c().mentionCount > 0}>
        <StatusDot tone="accent" size={6} label={t("hc.mentioned")} />
      </Show>
      <Show when={unread() > 0}>
        <Badge size="sm" numeric tone={c().muted ? "neutral" : "accent"} variant={c().muted ? "subtle" : "solid"}>{unread() > 99 ? "99+" : unread()}</Badge>
      </Show>
    </button>
  );
}

/**
 * The left column: search and the compose / message-search buttons, "Threads", then Unread, Channels (with New channel and
 * Browse) and Direct messages. Every conversation is a `role="option"` with `data-channel`; arrows, Home and End move between rows.
 */
export function Sidebar(props: { activeId?: string; onSelect: (id: string) => void; onThreads: () => void }) {
  const [query, setQuery] = createSignal("");
  const [settled, setSettled] = createSignal("");
  let search: HTMLInputElement | undefined;
  let nav: HTMLDivElement | undefined;

  createEffect(
    on(query, (v) => {
      const timer = setTimeout(() => setSettled(v.trim()), 250);
      onCleanup(() => clearTimeout(timer));
    }),
  );
  createEffect(on(listSearchTick, (n, prev) => prev !== undefined && n !== prev && search?.focus()));
  // Only asked once something is typed: the directory is not fetched for browsing.
  const [people] = createResource(settled, (q) => (q ? searchPeople(q).catch(() => []) : []));

  const summary = chatSummary;
  const data = () => sectionsOf(summary(), query());
  const searching = () => !!query().trim();
  /** Channels and Direct always show their header (the "+" actions live there), even while empty; a search only shows matches. */
  const shown = (): ListSection[] => {
    const found = data().sections;
    if (searching()) return found;
    const byId = (id: ListSection["id"]) => found.find((s) => s.id === id);
    return [byId("unread"), byId("channels") ?? { id: "channels" as const, title: t("hc.section.channels"), items: [] }, byId("direct") ?? { id: "direct" as const, title: t("hc.section.direct"), items: [] }].filter((s): s is ListSection => !!s);
  };
  const strangers = () => {
    const have = new Set((summary()?.channels ?? []).filter((c) => c.kind === "direct").map((c) => norm(c.name)));
    return (settled() ? (people() ?? []) : []).filter((p) => !have.has(norm(p.name)));
  };
  const flat = () => data().sections.flatMap((s) => s.items);
  const firstId = () => flat()[0]?.id;
  /** The one conversation row in the tab order: the open conversation, else the first. */
  const tabStop = () => (flat().some((c) => c.id === props.activeId) ? props.activeId : firstId());

  const rows = () => [...(nav?.querySelectorAll<HTMLButtonElement>(".hc-row") ?? [])];
  const move = (from: HTMLElement | null, delta: number) => {
    const all = rows();
    if (!all.length) return;
    const at = from ? all.indexOf(from as HTMLButtonElement) : -1;
    const next = delta === Number.POSITIVE_INFINITY ? all.length - 1 : delta === Number.NEGATIVE_INFINITY ? 0 : Math.min(all.length - 1, Math.max(0, at + delta));
    all[next]?.focus();
  };
  const onNavKey = (e: KeyboardEvent) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>(".hc-row");
    if (!target) return;
    const key = { ArrowDown: 1, ArrowUp: -1, Home: Number.NEGATIVE_INFINITY, End: Number.POSITIVE_INFINITY }[e.key];
    if (key === undefined) return;
    e.preventDefault();
    if (e.key === "ArrowUp" && rows()[0] === target) return search?.focus();
    move(target, key);
  };

  const sectionAction = (id: ListSection["id"]) => {
    if (searching()) return undefined;
    if (id === "channels" && summary()?.canCreateChannel) return { label: t("hc.sb.newChannel"), run: openNewChannel };
    if (id === "direct") return { label: t("hc.sb.newMessage"), run: openNewMessage };
    return undefined;
  };

  return (
    <nav class="hc-channels" aria-label={t("hc.sb.label")}>
      <div class="hc-channels__search">
        <Input
          size="sm"
          ref={(el: HTMLInputElement) => (search = el)}
          leading={<Search size={13} />}
          value={query()}
          placeholder={t("hc.search.placeholder")}
          aria-label={t("hc.search.label")}
          autocomplete="off"
          spellcheck={false}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              move(null, 1);
            } else if (e.key === "Enter" && firstId()) props.onSelect(firstId()!);
            else if (e.key === "Escape" && query()) {
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
        <IconButton icon={Pencil} label={t("hc.sb.newMessage")} size="sm" onClick={openNewMessage} />
        <IconButton icon={FileSearch} label={t("hc.sb.searchMessages")} size="sm" onClick={() => openSearch()} />
      </div>
      <div class="hc-channels__scroll" ref={nav} onKeyDown={onNavKey}>
        <Show
          when={summary()?.loaded || (summary()?.channels.length ?? 0) > 0}
          fallback={
            <div class="hc-skeleton" aria-busy="true">
              <Skeleton height={26} /><Skeleton height={26} /><Skeleton height={26} /><Skeleton height={26} />
            </div>
          }
        >
          <Show when={!searching()}>
            <div class="hc-section">
              <button
                type="button"
                class="hc-row hc-row--link"
                data-active={chatMainView() === "threads" ? "" : undefined}
                data-unread={data().threads.unread > 0 ? "" : undefined}
                aria-current={chatMainView() === "threads" ? "page" : undefined}
                aria-label={t("hc.sb.threadsLabel", { unread: data().threads.unread })}
                tabIndex={-1}
                onClick={props.onThreads}
              >
                <span class="hc-row__icon" aria-hidden="true"><MessagesSquare size={14} /></span>
                <span class="hc-row__name ui-truncate">{t("hc.sb.threads")}</span>
                <Show when={data().threads.unread > 0}>
                  <Badge size="sm" numeric tone="accent" variant="solid">{data().threads.unread > 99 ? "99+" : data().threads.unread}</Badge>
                </Show>
              </button>
            </div>
          </Show>
          <For each={shown()}>
            {(section) => (
              <section class="hc-section" aria-label={section.title}>
                <div class="hc-section__head">
                  <h5 class="hc-section__title" aria-hidden="true">{section.title}</h5>
                  <Show when={sectionAction(section.id)}>
                    {(a) => <IconButton class="hc-section__add" icon={Plus} label={a().label} size="sm" onClick={a().run} />}
                  </Show>
                </div>
                <div role="listbox" aria-label={section.title}>
                  <For each={section.items}>{(c) => <Row c={c} active={c.id === props.activeId && chatMainView() === "channel"} tabbable={c.id === tabStop()} onSelect={props.onSelect} />}</For>
                </div>
                <Show when={section.id === "channels" && !searching()}>
                  <button type="button" class="hc-row hc-row--link hc-row--action" tabIndex={-1} onClick={openBrowseChannels}>
                    <span class="hc-row__icon" aria-hidden="true"><Search size={13} /></span>
                    <span class="hc-row__name ui-truncate">{t("hc.sb.browse")}</span>
                  </button>
                  <Show when={summary()?.canCreateChannel}>
                    <button type="button" class="hc-row hc-row--link hc-row--action" tabIndex={-1} onClick={openNewChannel}>
                      <span class="hc-row__icon" aria-hidden="true"><Plus size={14} /></span>
                      <span class="hc-row__name ui-truncate">{t("hc.sb.newChannel")}</span>
                    </button>
                  </Show>
                </Show>
              </section>
            )}
          </For>
          <Show when={strangers().length > 0}>
            <section class="hc-section" aria-label={t("hc.people")}>
              <div class="hc-section__head"><h5 class="hc-section__title" aria-hidden="true">{t("hc.people")}</h5></div>
              <div role="listbox" aria-label={t("hc.people")}>
                <For each={strangers()}>
                  {(p) => (
                    <button type="button" role="option" aria-selected="false" class="hc-row hc-person" tabIndex={-1} onClick={() => void openDirect(p.id)}>
                      <Avatar name={p.name} size={18} />
                      <span class="hc-row__name ui-truncate">{p.name}</span>
                      <Show when={p.detail}><span class="hc-row__detail ui-truncate">{p.detail}</span></Show>
                    </button>
                  )}
                </For>
              </div>
            </section>
          </Show>
          <Show when={flat().length === 0 && strangers().length === 0 && (searching() || (summary()?.channels.length ?? 0) === 0)}>
            <EmptyState
              size="sm"
              icon={MessageSquare}
              title={searching() ? t("hc.empty.noMatch") : t("hc.empty.none")}
              description={searching() ? t("hc.empty.tryName") : t("hc.empty.noneBody")}
            />
          </Show>
        </Show>
      </div>
    </nav>
  );
}
