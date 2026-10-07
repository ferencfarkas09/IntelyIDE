// The members panel (right-hand panel content): who is in the channel, invite people, remove people.
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { t } from "../../i18n";
import type { ChatMember, ChatPerson } from "../../ipc/happy";
import { happyStatus } from "../../store/happy";
import { announce, Badge, Button, Dialog, EmptyState, IconButton, Icon, Input, Search, Skeleton, StatusDot, toast, UserMinus, UserPlus, Users, X } from "../../ui-kit";
import "./chat-dialogs.css";
import { openNewMessage } from "./dialogs";
import { canInvite, canManageMembers, isDirectKind, norm } from "./logic";
import { Avatar } from "./Message";
import { channelMembers, channelOf, chatSummary, ChatActionError, inviteMembers, removeMember } from "./state";
import { PeoplePicker } from "./PeoplePicker";

export interface MembersPanelProps {
  channelId: string;
  onClose: () => void;
}

const friendly = (e: unknown, map: Record<string, string>): string => {
  const code = e instanceof ChatActionError ? e.code : "";
  return map[code] ?? (e instanceof Error ? e.message : t("hc.err.generic"));
};

export function MembersPanel(props: MembersPanelProps) {
  const channel = () => channelOf(props.channelId);
  const me = () => happyStatus()?.user?.id;
  const [members, setMembers] = createSignal<ChatMember[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();
  const [filter, setFilter] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [picked, setPicked] = createSignal<ChatPerson[]>([]);
  const [pending, setPending] = createSignal(false);
  const [addError, setAddError] = createSignal<string>();
  const [removing, setRemoving] = createSignal<ChatMember>();
  const [removePending, setRemovePending] = createSignal(false);
  const [removeError, setRemoveError] = createSignal<string>();
  let run = 0;
  let root!: HTMLElement;

  const load = (silent = false) => {
    const id = ++run;
    if (!silent) {
      setLoading(true);
      setError(undefined);
    }
    channelMembers(props.channelId).then(
      (r) => id === run && (setMembers(r), setLoading(false), setError(undefined)),
      (e: Error) => id === run && !silent && (setError(e.message), setLoading(false)),
    );
  };
  createEffect(on(() => props.channelId, () => (setAdding(false), setPicked([]), setFilter(""), load())));
  // The list follows the channel's member count (invites and removals from elsewhere arrive as a summary).
  createEffect(on(() => channel()?.memberCount, (n, prev) => prev !== undefined && n !== members().length && load(true), { defer: true }));
  createEffect(() => !channel() && props.onClose());
  createEffect(on(() => props.channelId, () => queueMicrotask(() => root?.focus())));

  const sorted = createMemo(() => [...members()].sort((a, b) => Number(b.role === "admin") - Number(a.role === "admin") || a.name.localeCompare(b.name)));
  const shown = createMemo(() => {
    const q = norm(filter().trim());
    return q ? sorted().filter((m) => norm(m.name).includes(q) || norm(m.email ?? "").includes(q)) : sorted();
  });
  const total = () => (loading() && !members().length ? (channel()?.memberCount ?? 0) : members().length);
  const mayInvite = () => !!channel() && canInvite(channel()!, chatSummary());
  const mayRemove = () => !!channel() && canManageMembers(channel()!, chatSummary());

  async function add() {
    if (!picked().length || pending()) return;
    setPending(true);
    setAddError(undefined);
    try {
      const added = await inviteMembers(props.channelId, picked().map((p) => p.id));
      setMembers((all) => [...all, ...added.filter((a) => !all.some((m) => m.id === a.id))]);
      const text = t("hc.mem.added", { count: added.length || picked().length });
      toast.success(text);
      announce(text);
      setPicked([]);
      setAdding(false);
    } catch (e) {
      setAddError(friendly(e, { MANAGE_FORBIDDEN: t("hc.mem.err.MANAGE_FORBIDDEN"), DIRECT_IMMUTABLE: t("hc.mem.err.DIRECT_IMMUTABLE"), USERS_REQUIRED: t("hc.err.USERS_REQUIRED") }));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    const m = removing();
    if (!m || removePending()) return;
    setRemovePending(true);
    setRemoveError(undefined);
    try {
      await removeMember(props.channelId, m.id);
      setMembers((all) => all.filter((x) => x.id !== m.id));
      announce(t("hc.mem.removed", { name: m.name }));
      setRemoving(undefined);
    } catch (e) {
      setRemoveError(friendly(e, { OWNER_PROTECTED: t("hc.mem.err.OWNER_PROTECTED"), MANAGE_FORBIDDEN: t("hc.mem.err.removeForbidden"), DIRECT_IMMUTABLE: t("hc.mem.err.DIRECT_IMMUTABLE") }));
    } finally {
      setRemovePending(false);
    }
  }

  return (
    <aside
      ref={root}
      class="hcm"
      tabIndex={-1}
      aria-label={t("hc.mem.label")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <header class="hcm__head">
        <h2 class="hcm__title">{t("hc.mem.title", { count: total() })}</h2>
        <IconButton icon={X} size="sm" label={t("hc.mem.close")} shortcut={["Esc"]} onClick={props.onClose} />
      </header>

      <Show when={mayInvite()}>
        <div class="hcm__add">
          <Show
            when={adding()}
            fallback={<Button size="sm" variant="secondary" icon={UserPlus} onClick={() => setAdding(true)}>{t("hc.mem.addPeople")}</Button>}
          >
            <div class="hcm__invite">
              <PeoplePicker label={t("hc.mem.addPeople")} selected={picked()} onChange={setPicked} exclude={members().map((m) => m.id)} disabled={pending()} autofocus />
              <Show when={addError()}>
                <p class="hcd-error" role="alert">{addError()}</p>
              </Show>
              <div class="hcm__invite-actions">
                <Button size="sm" variant="ghost" onClick={() => (setAdding(false), setPicked([]), setAddError(undefined))}>{t("hc.dlg.cancel")}</Button>
                <Button size="sm" variant="primary" loading={pending()} disabled={!picked().length} onClick={add}>
                  {t("hc.mem.addButton", { count: picked().length })}
                </Button>
              </div>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={channel() && isDirectKind(channel()!.kind)}>
        <div class="hcm__note">
          <p>{t("hc.mem.directNote")}</p>
          <Button size="sm" variant="secondary" icon={Users} onClick={openNewMessage}>{t("hc.mem.newGroup")}</Button>
        </div>
      </Show>

      <div class="hcm__filter">
        <Input size="sm" type="search" aria-label={t("hc.mem.filter")} placeholder={t("hc.mem.filter")} leading={<Icon icon={Search} size={12} />} autocomplete="off" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
      </div>

      <div class="hcm__body" aria-busy={loading()}>
        <Show when={error()}>
          <div class="hcd-state" role="alert">
            <span>{error()}</span>
            <Button size="sm" onClick={() => load()}>{t("hc.dlg.retry")}</Button>
          </div>
        </Show>
        <Show when={loading() && !members().length && !error()}>
          <div class="hcd-skel" aria-hidden="true">
            <Skeleton height={36} />
            <Skeleton height={36} />
            <Skeleton height={36} />
          </div>
        </Show>
        <Show when={!loading() && !error() && !shown().length}>
          <EmptyState size="sm" icon={Users} title={t("hc.mem.none", { query: filter().trim() })} />
        </Show>
        <ul class="hcm__list" aria-label={t("hc.mem.list")}>
          <For each={shown()}>
            {(m) => (
              <li class="hcm__row" data-member={m.id}>
                <span class="hcm__avatar">
                  <Avatar name={m.name} size={28} />
                  <Show when={m.online}>
                    <span class="hcm__online"><StatusDot tone="ok" size={8} label={t("hc.mem.online")} /></span>
                  </Show>
                </span>
                <span class="hcm__text">
                  <span class="hcm__name ui-truncate">
                    {m.name}
                    <Show when={m.id === me()}> <span class="hcm__you">{t("hc.mem.you")}</span></Show>
                  </span>
                  <Show when={m.email}>
                    <span class="hcm__detail ui-truncate">{m.email}</span>
                  </Show>
                </span>
                <Show when={m.role === "admin"}>
                  <Badge size="sm" tone="accent" variant="subtle">{t("hc.mem.admin")}</Badge>
                </Show>
                <Show when={mayRemove() && m.id !== me()}>
                  <IconButton icon={UserMinus} size="sm" class="hcm__remove" label={t("hc.mem.remove", { name: m.name })} onClick={() => (setRemoveError(undefined), setRemoving(m))} />
                </Show>
              </li>
            )}
          </For>
        </ul>
      </div>

      <Dialog
        open={!!removing()}
        onClose={() => setRemoving(undefined)}
        role="alertdialog"
        size="sm"
        class="hcd-dialog"
        title={t("hc.mem.removeTitle", { name: removing()?.name ?? "" })}
        description={t("hc.mem.removeDesc")}
        initialFocus={() => document.querySelector<HTMLElement>("[data-hcd-cancel]")}
        footer={
          <>
            <Button variant="ghost" data-hcd-cancel onClick={() => setRemoving(undefined)}>{t("hc.dlg.cancel")}</Button>
            <Button variant="danger" loading={removePending()} onClick={remove}>{t("hc.mem.removeConfirm")}</Button>
          </>
        }
      >
        <Show when={removeError()}>
          <p class="hcd-error hcd-error--form" role="alert">{removeError()}</p>
        </Show>
      </Dialog>
    </aside>
  );
}
