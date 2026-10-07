// The conversation header: back (narrow), kind icon + name, topic line, members, star, notifications and the "…" menu.
import { createSignal, Show } from "solid-js";
import { t } from "../../i18n";
import type { ChatChannel, NotifyLevel } from "../../ipc/happy";
import { Bell, BellOff, ChevronLeft, Ellipsis, Hash, IconButton, Icon, Lock, Menu, Pencil, Popover, Search, Star, toast, LogOut, Users, type MenuEntry } from "../../ui-kit";
import "./chat-dialogs.css";
import { EditChannelDialog, LeaveChannelDialog } from "./ChannelActions";
import { closeMembers, membersPanelOpen, openMembers, openSearch } from "./dialogs";
import { muteUntil, type MuteChoice } from "./dialogs-logic";
import { canManageMembers, describeChannel, isDirectKind } from "./logic";
import { Avatar } from "./Message";
import { chatSummary, setChannelPreferences } from "./state";

export interface ChannelHeaderProps {
  channel: ChatChannel;
  /** Narrow layout: a back button that returns to the list. */
  onBack?: () => void;
}

export function ChannelHeader(props: ChannelHeaderProps) {
  const c = () => props.channel;
  const direct = () => isDirectKind(c().kind);
  const [editing, setEditing] = createSignal(false);
  const [leaving, setLeaving] = createSignal(false);
  const canEdit = () => canManageMembers(c(), chatSummary());
  const about = () => describeChannel(c());
  const people = () => (direct() ? Math.max(c().memberCount, c().peers.length + 1) : c().memberCount);
  const label = () => (c().kind === "channel" ? `#${c().name}` : c().name);

  const prefs = (patch: Parameters<typeof setChannelPreferences>[1]) =>
    setChannelPreferences(c().id, patch).catch((e: Error) => toast.error(t("hc.hdr.prefsFailed"), e.message));
  const level = (l: NotifyLevel) => ({ label: t(`hc.hdr.notify.${l}`), radio: true, checked: c().notifyLevel === l, onSelect: () => void prefs({ notifyLevel: l }) });
  const mute = (choice: MuteChoice) => ({ label: t(`hc.hdr.mute.${choice}`), onSelect: () => void prefs({ mutedUntilMs: muteUntil(choice, Date.now()) }) });

  const notifyItems = (): MenuEntry[] => [
    { type: "label", label: t("hc.hdr.notifyTitle") },
    level("all"),
    level("mentions"),
    level("none"),
    { type: "separator" },
    ...(c().muted ? [{ label: t("hc.hdr.unmute"), icon: Bell, onSelect: () => void prefs({ mutedUntilMs: 0 }) } satisfies MenuEntry] : [mute("hour"), mute("tomorrow"), mute("forever")]),
  ];

  const moreItems = (): MenuEntry[] => [
    { label: t("hc.hdr.search"), icon: Search, onSelect: () => openSearch(c().id) },
    ...(canEdit() ? [{ label: t("hc.hdr.edit"), icon: Pencil, onSelect: () => setEditing(true) } satisfies MenuEntry] : []),
    ...(direct() ? [] : [{ type: "separator" } satisfies MenuEntry, { label: t("hc.hdr.leave"), icon: LogOut, danger: true, onSelect: () => setLeaving(true) } satisfies MenuEntry]),
  ];

  return (
    <header class="hch" aria-label={t("hc.hdr.label", { name: label() })}>
      <Show when={props.onBack}>
        <IconButton icon={ChevronLeft} label={t("hc.hdr.back")} size="sm" onClick={() => props.onBack?.()} />
      </Show>
      <span class="hch__icon" aria-hidden="true">
        <Show when={c().kind === "direct"} fallback={<Icon icon={c().kind === "group" ? Users : c().kind === "private" ? Lock : Hash} size={16} />}>
          <Avatar name={c().name} size={22} />
        </Show>
      </span>
      <div class="hch__main">
        <h2 class="hch__name ui-truncate">{c().name}</h2>
        <Show
          when={about()}
          fallback={
            <Show when={canEdit()}>
              <button type="button" class="hc-textbtn hch__add" onClick={() => setEditing(true)}>{t("hc.hdr.addTopic")}</button>
            </Show>
          }
        >
          <Popover
            aria-label={t("hc.hdr.aboutLabel")}
            class="hch__pop"
            trigger={(p) => (
              <button type="button" {...p} class="hch__topic" title={about()}>
                {about()}
              </button>
            )}
          >
            <div class="hch__about">
              <Show when={c().topic.trim()}>
                <section>
                  <h3>{t("hc.hdr.topic")}</h3>
                  <p>{c().topic}</p>
                </section>
              </Show>
              <Show when={c().description.trim()}>
                <section>
                  <h3>{t("hc.hdr.description")}</h3>
                  <p>{c().description}</p>
                </section>
              </Show>
            </div>
          </Popover>
        </Show>
      </div>
      <div class="hch__actions">
        <button
          type="button"
          class="hch__members"
          aria-pressed={membersPanelOpen()}
          aria-label={t("hc.hdr.membersLabel", { count: people() })}
          onClick={() => (membersPanelOpen() ? closeMembers() : openMembers())}
        >
          <Icon icon={Users} size={14} />
          <span class="ui-tnum">{people()}</span>
        </button>
        <IconButton icon={Star} size="sm" pressed={c().starred} label={c().starred ? t("hc.hdr.unstar") : t("hc.hdr.star")} class="hch__star" onClick={() => void prefs({ starred: !c().starred })} />
        <Menu
          aria-label={t("hc.hdr.notifyTitle")}
          placement="bottom-end"
          items={notifyItems()}
          trigger={(p) => <IconButton {...p} icon={c().muted ? BellOff : Bell} size="sm" label={c().muted ? t("hc.hdr.notifyMuted") : t("hc.hdr.notifyTitle")} />}
        />
        <Menu aria-label={t("hc.hdr.more")} placement="bottom-end" items={moreItems()} trigger={(p) => <IconButton {...p} icon={Ellipsis} size="sm" label={t("hc.hdr.more")} />} />
      </div>
      <EditChannelDialog open={editing()} channel={c()} onClose={() => setEditing(false)} />
      <LeaveChannelDialog open={leaving()} channel={c()} onClose={() => setLeaving(false)} />
    </header>
  );
}
