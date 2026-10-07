import { createEffect, createSignal, For, on, Show } from "solid-js";
import { t } from "../../i18n";
import type { ChatChannel } from "../../ipc/happy";
import { Button, Dialog, EmptyState, Hash, Icon, Input, Search, Skeleton, Users } from "../../ui-kit";
import "./chat-dialogs.css";
import { createDebounced } from "./dialogs-logic";
import { describeChannel } from "./logic";
import { browseChannels, joinChannel } from "./state";

export interface BrowseChannelsDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Public channels the user has not joined; Join opens the channel and closes the dialog. */
export function BrowseChannelsDialog(props: BrowseChannelsDialogProps) {
  const [query, setQuery] = createSignal("");
  const q = createDebounced(query, 200);
  const [items, setItems] = createSignal<ChatChannel[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();
  const [joining, setJoining] = createSignal<string>();
  const [joinError, setJoinError] = createSignal<{ id: string; text: string }>();
  let run = 0;
  let listEl: HTMLUListElement | undefined;

  const load = (text: string) => {
    const id = ++run;
    setLoading(true);
    setError(undefined);
    browseChannels(text.trim()).then(
      (r) => id === run && (setItems(r.filter((c) => !c.isMember)), setLoading(false)),
      (e: Error) => id === run && (setError(e.message), setLoading(false)),
    );
  };
  createEffect(on([() => props.open, q], ([open, text]) => open && load(text)));
  createEffect(on(() => props.open, (open) => open && (setQuery(""), setJoining(undefined), setJoinError(undefined), setItems([]))));

  async function join(c: ChatChannel) {
    if (joining()) return;
    setJoining(c.id);
    setJoinError(undefined);
    try {
      await joinChannel(c.id);
      props.onClose();
    } catch (e) {
      setJoinError({ id: c.id, text: (e as Error).message });
    } finally {
      setJoining(undefined);
    }
  }

  const buttons = () => [...(listEl?.querySelectorAll<HTMLButtonElement>("button.hcd-join") ?? [])];
  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const all = buttons();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = all[e.key === "ArrowDown" ? i + 1 : i - 1];
    e.preventDefault();
    next?.focus();
  };

  return (
    <Dialog open={props.open} onClose={props.onClose} title={t("hc.dlg.browse.title")} description={t("hc.dlg.browse.desc")} size="md" class="hcd-dialog">
      <div class="hcd-form">
        <Input
          type="search"
          data-autofocus
          aria-label={t("hc.dlg.browse.search")}
          placeholder={t("hc.dlg.browse.search")}
          leading={<Icon icon={Search} size={14} />}
          autocomplete="off"
          spellcheck={false}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              buttons()[0]?.focus();
            }
          }}
        />
        <div class="hcd-results" aria-busy={loading()}>
          <Show when={error()}>
            <div class="hcd-state" role="alert">
              <span>{error()}</span>
              <Button size="sm" onClick={() => load(q())}>{t("hc.dlg.retry")}</Button>
            </div>
          </Show>
          <Show when={loading() && !items().length && !error()}>
            <div class="hcd-skel" aria-hidden="true">
              <Skeleton height={44} />
              <Skeleton height={44} />
              <Skeleton height={44} />
            </div>
          </Show>
          <Show when={!loading() && !error() && !items().length}>
            <EmptyState icon={Hash} title={q().trim() ? t("hc.dlg.browse.noMatch", { query: q().trim() }) : t("hc.dlg.browse.none")} />
          </Show>
          <Show when={items().length}>
            <ul class="hcd-rows" ref={listEl} aria-label={t("hc.dlg.browse.list")} onKeyDown={onListKey}>
              <For each={items()}>
                {(c) => (
                  <li class="hcd-crow">
                    <span class="hcd-crow__hash" aria-hidden="true"><Icon icon={Hash} size={16} /></span>
                    <span class="hcd-crow__text">
                      <span class="hcd-crow__name ui-truncate">{c.name}</span>
                      <Show when={describeChannel(c)}>
                        <span class="hcd-crow__desc">{describeChannel(c)}</span>
                      </Show>
                      <span class="hcd-crow__meta">
                        <Icon icon={Users} size={12} /> {t("hc.dlg.browse.members", { count: c.memberCount })}
                      </span>
                      <Show when={joinError()?.id === c.id}>
                        <span class="hcd-error" role="alert">{joinError()!.text}</span>
                      </Show>
                    </span>
                    <Button class="hcd-join" size="sm" variant="secondary" loading={joining() === c.id} disabled={!!joining() && joining() !== c.id} aria-label={t("hc.dlg.browse.joinLabel", { name: c.name })} onClick={() => join(c)}>
                      {t("hc.dlg.browse.join")}
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </Dialog>
  );
}
